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
  const i = items.findIndex((it) => !it.posted && new Date(it.at) <= now);

  if (i === -1) {
    const next = items.filter((it) => !it.posted).sort((a, b) => new Date(a.at) - new Date(b.at))[0];
    console.log(
      next
        ? `Nothing due. Next: ${next.at} — ${(next.caption || '').split('\n')[0].slice(0, 60)}`
        : 'Nothing due and nothing pending.'
    );
    return;
  }

  // One upload per day. The runner fires every 15 minutes (GitHub drops
  // scheduled ticks, so one hourly tick is not reliable). Without this, a
  // missed day would drain the backlog four times an hour.
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = items.find((it) => it.posted && it.posted.slice(0, 10) === today);
  if (doneToday) {
    console.log(`Already uploaded today (${doneToday.at}). One per day - stopping.`);
    return;
  }

  const item = items[i];
  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN']);
  const snippet = buildSnippet({caption: item.caption, title: item.title, categoryId: env.YT_CATEGORY_ID});

  console.log(`Due: ${item.at}`);
  console.log(`  ${snippet.title}`);

  if (!process.argv.includes('--confirm')) {
    console.log('\nDry run. Nothing uploaded. Re-run with --confirm.\n');
    return;
  }

  const token = await getAccessToken(env);
  const src = /^https?:/i.test(item.url) ? item.url : join(HERE, item.url);
  const bytes = await fetchVideo(src);
  const video = await uploadVideo({
    token,
    bytes,
    snippet,
    status: {privacyStatus: env.YT_PRIVACY, selfDeclaredMadeForKids: false},
  });

  if (item.cover) {
    // A relative cover path is resolved against this directory, not the cwd,
    // so the scheduled task works regardless of where it is invoked from.
    const cover = /^https?:\/\//i.test(item.cover) ? item.cover : join(HERE, item.cover);
    const t = await setThumbnail({token, videoId: video.id, url: cover});
    if (!t.ok) console.log(`thumbnail skipped: ${t.skipped}`);
  }

  // Record the outcome before doing anything else, so a crash after upload can
  // never cause the same video to be posted twice on the next run.
  items[i].posted = new Date().toISOString();
  items[i].videoId = video.id;
  items[i].privacy = video.status?.privacyStatus;
  writeFileSync(QUEUE, JSON.stringify(items, null, 1));

  console.log(`uploaded https://youtube.com/watch?v=${video.id}  (${video.status?.privacyStatus})`);
}

main().catch((e) => {
  // Abort has already printed its message. Still exit non-zero so Task
  // Scheduler and queue.log record a failure instead of a silent success.
  if (!(e instanceof Abort)) console.error(`\n${e.message}\n`);
  process.exitCode = 1;
});
