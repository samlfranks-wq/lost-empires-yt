// Scheduled uploading. Reads queue.json, finds the first entry whose `at` time
// has passed and which hasn't uploaded yet, uploads it, and records the result
// back into queue.json.
//
//   node queue.js            ← dry run: shows what is due, uploads nothing
//   node queue.js --confirm  ← uploads the one due item
//
// It uploads at most ONE item per run, so a misconfigured queue can never dump
// the whole backlog onto the channel at once. Same shape as ig-publisher's
// queue.js on purpose — one mental model for both platforms.
//
// queue.json format. `at` is UTC — in British Summer Time that is one hour
// BEHIND the clock, so 18:00Z fires at 19:00 local.
// [
//   {
//     "at": "2026-08-29T18:00:00Z",
//     "url": "https://.../video.mp4",
//     "cover": "https://.../thumb.jpg",   // optional
//     "caption": "First line becomes the title. Rest becomes the description."
//   }
// ]

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadEnv, getAccessToken, fetchVideo, uploadVideo, setThumbnail, buildSnippet, fail, Abort,
} from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(HERE, 'queue.json');

async function main() {
  if (!existsSync(QUEUE)) fail(`No queue.json at ${QUEUE}. See the format in this file's header.`);

  const items = JSON.parse(readFileSync(QUEUE, 'utf8'));
  const now = new Date();
  const confirm = process.argv.includes('--confirm');

  // Every due item, oldest first - not just the first one. A source URL that has
  // gone 404/403 used to abort the whole run, and because the dead item stayed
  // due it blocked every later day behind it too. Two days of Shorts were lost
  // that way in Sept 2026. Now a broken item is stepped over and the next one
  // goes up; it stays unposted so it publishes as soon as its URL is fixed.
  const due = items
    .map((it, idx) => ({it, idx}))
    .filter(({it}) => !it.posted && new Date(it.at) <= now)
    .sort((a, b) => new Date(a.it.at) - new Date(b.it.at));

  if (!due.length) {
    const next = items.filter((it) => !it.posted).sort((a, b) => new Date(a.at) - new Date(b.at))[0];
    console.log(
      next
        ? `Nothing due. Next: ${next.at} — ${(next.caption || '').split('\n')[0].slice(0, 60)}`
        : 'Nothing due and nothing pending.'
    );
    return;
  }

  // One upload per day. The runner fires more than once per window (GitHub drops
  // scheduled ticks), so without this a missed day would drain the backlog.
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = items.find((it) => it.posted && it.posted.slice(0, 10) === today);
  if (doneToday) {
    console.log(`Already uploaded today (${doneToday.at}). One per day - stopping.`);
    // A no-op must not look like a healthy run. On 2026-09-14 this branch was
    // reached because an item had been published by hand earlier that day; the
    // run exited 0, GitHub showed a green tick, and nothing went out. Two items
    // stayed overdue and the queue could never catch up, because it drains at
    // exactly the rate it fills. Four days passed before anyone noticed.
    //
    // Being due but blocked is a real backlog, so say so loudly enough that the
    // run list shows it.
    const stale = due.length;
    if (stale) {
      console.log(`::warning::${stale} item(s) are due but BLOCKED by the one-per-day guard.`);
      console.log(`::warning::Oldest: ${due[0].it.at}. The queue drains at the rate it fills, so this backlog is permanent until the dates are rebased.`);
    }
    return;
  }

  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN']);
  const skipped = [];
  let uploaded = null;

  for (const {it, idx} of due) {
    const snippet = buildSnippet({caption: it.caption, title: it.title, categoryId: env.YT_CATEGORY_ID});
    console.log(`Due: ${it.at}`);
    console.log(`  ${snippet.title}`);

    if (!confirm) {
      console.log('\nDry run. Nothing uploaded. Re-run with --confirm.\n');
      return;
    }

    const token = await getAccessToken(env);
    const src = /^https?:/i.test(it.url) ? it.url : join(HERE, it.url);

    let bytes;
    try {
      bytes = await fetchVideo(src);
    } catch (e) {
      // Only a bad SOURCE is skipped. A failure after the bytes were fetched is
      // left to throw, because an upload may have half-landed and retrying it
      // blind is how you get a duplicate on the channel.
      it.skips = (it.skips || 0) + 1;
      it.lastError = `${new Date().toISOString().slice(0, 16)}Z ${e.message}`.slice(0, 300);
      skipped.push(it);
      console.log(`::warning::SKIPPED ${it.at} - source unfetchable: ${e.message}`);
      console.log('  moving on to the next due item; this one stays queued.');
      continue;
    }

    const video = await uploadVideo({
      token,
      bytes,
      snippet,
      status: {privacyStatus: env.YT_PRIVACY, selfDeclaredMadeForKids: false},
    });

    if (it.cover) {
      const cover = /^https?:\/\//i.test(it.cover) ? it.cover : join(HERE, it.cover);
      const t = await setThumbnail({token, videoId: video.id, url: cover});
      if (!t.ok) console.log(`thumbnail skipped: ${t.skipped}`);
    }

    // Record before anything else so a crash after upload cannot double-post.
    items[idx].posted = new Date().toISOString();
    items[idx].videoId = video.id;
    items[idx].privacy = video.status?.privacyStatus;
    uploaded = video;
    console.log(`uploaded https://youtube.com/watch?v=${video.id}  (${video.status?.privacyStatus})`);
    break;
  }

  // Persist skip counters even when nothing uploaded, so the workflow commits
  // them and a repeatedly-skipped item is visible in the repo rather than only
  // in a run log nobody reads.
  if (uploaded || skipped.length) writeFileSync(QUEUE, JSON.stringify(items, null, 1));

  if (skipped.length) {
    console.log(`\n${skipped.length} item(s) skipped for a broken source URL:`);
    for (const it of skipped) console.log(`  ${it.at}  (skipped ${it.skips}x)  ${it.lastError}`);
    console.log('Re-upload the asset and repoint queue.json; they publish on the next run.');
  }
  if (!uploaded && skipped.length) {
    console.log('::error::Everything due has a broken source URL. Nothing was uploaded.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  // Abort has already printed its message. Still exit non-zero so Task
  // Scheduler and queue.log record a failure instead of a silent success.
  if (!(e instanceof Abort)) console.error(`\n${e.message}\n`);
  process.exitCode = 1;
});
