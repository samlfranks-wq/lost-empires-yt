#!/usr/bin/env node
// Second-by-second drop-off for recent Shorts, from YouTube Analytics (audienceWatchRatio). READ-ONLY.
//   node retention_curves.mjs [limit=20]         needs the yt-analytics.readonly scope: re-run auth.js once
// Instagram's API has no equivalent: its insights list stops at reels_skip_rate + ig_reels_avg_watch_time (checked 2 Nov 2026).
// Prints the retained share at each 10% of the runtime and the steepest drop, which is the beat to fix in the script.
import {loadEnv, getAccessToken} from './lib.js';

const limit = +process.argv[2] || 20;
const env = loadEnv();
const token = await getAccessToken(env);
const get = async (url) => {
  const r = await fetch(url, {headers: {Authorization: `Bearer ${token}`}});
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
};
const v3 = 'https://www.googleapis.com/youtube/v3';
const ch = await get(`${v3}/channels?part=contentDetails&mine=true`);
const pl = await get(`${v3}/playlistItems?part=contentDetails&maxResults=${limit}&playlistId=${ch.items[0].contentDetails.relatedPlaylists.uploads}`);
const ids = pl.items.map((i) => i.contentDetails.videoId);
const vids = await get(`${v3}/videos?part=snippet,contentDetails&id=${ids.join(',')}`);
const secs = (d) => { const m = d.match(/PT(?:(\d+)M)?(?:(\d+)S)?/); return (+m[1] || 0) * 60 + (+m[2] || 0); };
const today = new Date().toISOString().slice(0, 10);
for (const x of vids.items) {
  const q = new URLSearchParams({ids: 'channel==MINE', startDate: '2026-01-01', endDate: today, metrics: 'audienceWatchRatio', dimensions: 'elapsedVideoTimeRatio', filters: `video==${x.id};audienceType==ORGANIC`});
  const rows = (await get(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`)).rows || [];
  if (rows.length < 10) { console.log(`${x.snippet.title.slice(0, 50)}: not enough data`); continue; }
  const dur = secs(x.contentDetails.duration);
  let worst = {drop: 0, at: 0};
  for (let i = 3; i < rows.length; i++) {   // the first 3% is the hook, already read as skip rate
    const drop = rows[i - 3][1] - rows[i][1];
    if (drop > worst.drop) worst = {drop, at: rows[i][0]};
  }
  const deciles = rows.filter((_, i) => i % 10 === 9).map((r) => Math.round(r[1] * 100));
  console.log(`${x.snippet.title.slice(0, 50).padEnd(50)} ${dur}s  ${deciles.join(' ')}  steepest at ${Math.round(worst.at * dur)}s (-${Math.round(worst.drop * 100)} pts)`);
}
