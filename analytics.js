// YouTube analytics collector. READ-ONLY — uploads nothing, edits nothing.
//
//   node analytics.js                 # collect and write stats.json
//   node analytics.js --print         # also print a table
//   node analytics.js --limit 30      # how many recent uploads to pull
//   node analytics.js --max-age 50    # skip entirely if stats.json is newer
//                                     # than 50 minutes (used by CI so the
//                                     # 15-min publish workflow doesn't commit
//                                     # a new stats.json every single run)
//
// Why this file exists: Cowork (and anything else off this machine) cannot
// reach www.googleapis.com. It CAN read raw.githubusercontent.com. So the
// Actions runner — which already holds the refresh token and does have network
// — is what fetches the numbers, and stats.json in this public repo is the
// delivery mechanism. No credential ever leaves the runner.
//
// Quota cost per run: channels.list 1 + playlistItems.list 1 + videos.list 1
// = ~3 units against a 10,000/day allowance. Negligible next to an upload.

import {readFileSync, writeFileSync, appendFileSync, existsSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEnv, getAccessToken, Abort} from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'stats.json');
const HIST = join(HERE, 'stats_history.jsonl');
const HIST_MAX = 5000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : Number(argv[i + 1]) || d;
};

// ---------- freshness gate ----------
// Age is read from generated_at INSIDE stats.json, not from the file mtime:
// actions/checkout stamps every file with the checkout time, so mtime in CI is
// always "just now" and an mtime gate would skip forever.
const maxAge = num('--max-age', 0);
if (maxAge > 0 && existsSync(OUT)) {
  let stampedMs = null;
  try {
    stampedMs = Date.parse(JSON.parse(readFileSync(OUT, 'utf8')).generated_at);
  } catch { /* unreadable or hand-edited — fall through to mtime */ }
  if (!Number.isFinite(stampedMs)) stampedMs = statSync(OUT).mtimeMs;
  const ageMin = (Date.now() - stampedMs) / 60000;
  if (ageMin < maxAge) {
    console.log(`stats.json is ${ageMin.toFixed(0)} min old (< ${maxAge}) — skipping.`);
    process.exit(0);
  }
}

const limit = Math.min(num('--limit', 30), 50); // playlistItems caps at 50/page
const now = new Date();

async function api(token, path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, {headers: {Authorization: `Bearer ${token}`}});
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status}: ${b.error?.message || 'unknown'}`);
  return b;
}

async function main() {
  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN']);
  const token = await getAccessToken(env);

  // ---------- channel ----------
  const ch = await api(token, 'channels', {
    part: 'snippet,statistics,contentDetails',
    mine: 'true',
  });
  const c = ch.items?.[0];
  if (!c) throw new Error('Authenticated, but this account has no channel.');

  const channel = {
    id: c.id,
    title: c.snippet?.title || null,
    subscribers: numOrNull(c.statistics?.subscriberCount),
    total_views: numOrNull(c.statistics?.viewCount),
    video_count: numOrNull(c.statistics?.videoCount),
  };

  // ---------- recent uploads ----------
  const uploadsId = c.contentDetails?.relatedPlaylists?.uploads;
  let ids = [];
  if (uploadsId) {
    const pl = await api(token, 'playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsId,
      maxResults: String(limit),
    });
    ids = (pl.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
  }

  let videos = [];
  if (ids.length) {
    const v = await api(token, 'videos', {
      part: 'snippet,statistics,contentDetails,status',
      id: ids.join(','),
    });
    videos = (v.items || []).map((x) => ({
      id: x.id,
      posted_at: x.snippet?.publishedAt || null,
      age_h: x.snippet?.publishedAt
        ? Number(((now - Date.parse(x.snippet.publishedAt)) / 3.6e6).toFixed(2))
        : null,
      title: (x.snippet?.title || '').slice(0, 110),
      url: `https://youtu.be/${x.id}`,
      duration: x.contentDetails?.duration || null,
      privacy: x.status?.privacyStatus || null,
      views: numOrNull(x.statistics?.viewCount) ?? 0,
      likes: numOrNull(x.statistics?.likeCount) ?? 0,
      comments: numOrNull(x.statistics?.commentCount) ?? 0,
    }));
    // playlistItems is already newest-first, but videos.list does not preserve
    // that ordering, so restore it explicitly.
    videos.sort((a, b) => Date.parse(b.posted_at || 0) - Date.parse(a.posted_at || 0));
  }

  const sum = (k) => videos.reduce((a, x) => a + (x[k] || 0), 0);
  const totals = {
    videos: videos.length,
    views: sum('views'),
    likes: sum('likes'),
    comments: sum('comments'),
  };
  totals.like_rate = totals.views
    ? Number(((totals.likes / totals.views) * 100).toFixed(2))
    : null;

  // ---------- optional: YouTube Analytics API ----------
  // Retention, impressions and traffic sources need the yt-analytics.readonly
  // scope, which the current refresh token does NOT carry. Attempted anyway so
  // that if auth.js is ever re-run with that scope added, this lights up on its
  // own with no further change here. A 401/403 is expected and ignored.
  let analytics_28d = null;
  try {
    const end = now.toISOString().slice(0, 10);
    const start = new Date(now.getTime() - 28 * 86400000).toISOString().slice(0, 10);
    const u = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    u.searchParams.set('ids', `channel==${channel.id}`);
    u.searchParams.set('startDate', start);
    u.searchParams.set('endDate', end);
    u.searchParams.set(
      'metrics',
      'views,estimatedMinutesWatched,averageViewPercentage,subscribersGained'
    );
    const r = await fetch(u, {headers: {Authorization: `Bearer ${token}`}});
    if (r.ok) {
      const b = await r.json();
      const cols = (b.columnHeaders || []).map((h) => h.name);
      const vals = b.rows?.[0] || [];
      analytics_28d = Object.fromEntries(cols.map((k, i) => [k, vals[i] ?? null]));
    }
  } catch { /* scope not granted — expected */ }

  const out = {
    platform: 'youtube',
    generated_at: now.toISOString(),
    channel,
    analytics_28d,
    totals,
    videos,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  // ---------- rolling history ----------
  // stats.json is a snapshot; this is the trend line. One compact row per run.
  const row = {
    t: now.toISOString(),
    subs: channel.subscribers,
    total_views: channel.total_views,
    video_count: channel.video_count,
    recent: {n: totals.videos, views: totals.views, likes: totals.likes, comments: totals.comments},
  };
  appendFileSync(HIST, JSON.stringify(row) + '\n');
  const lines = readFileSync(HIST, 'utf8').trim().split('\n');
  if (lines.length > HIST_MAX) writeFileSync(HIST, lines.slice(-HIST_MAX).join('\n') + '\n');

  console.log(
    `stats.json written — ${videos.length} videos, ${totals.views} recent views, ` +
    `subs ${channel.subscribers ?? '?'}`
  );

  if (has('--print')) {
    const pad = (s, n) => String(s).padEnd(n);
    const lp = (s, n) => String(s).padStart(n);
    console.log('');
    console.log(pad('POSTED', 17) + pad('TITLE', 50) + lp('VIEWS', 8) + lp('LIKES', 7) + lp('CMTS', 6));
    console.log('-'.repeat(88));
    for (const v of videos) {
      console.log(
        pad((v.posted_at || '').slice(0, 16).replace('T', ' '), 17) +
        pad(v.title.slice(0, 48), 50) + lp(v.views, 8) + lp(v.likes, 7) + lp(v.comments, 6)
      );
    }
    console.log('-'.repeat(88));
    console.log(pad(`TOTAL (${totals.videos})`, 67) + lp(totals.views, 8) + lp(totals.likes, 7) + lp(totals.comments, 6));
    console.log('');
  }
}

function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

main().catch((e) => {
  if (!(e instanceof Abort)) console.error(`\n${e.message}\n`);
  process.exitCode = 1;
});
