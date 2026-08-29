// Early warning for the queue. Answers one question: would the next scheduled
// upload actually work?
//
//   node preflight.js             ← check credentials and every pending item
//   node preflight.js --days 7    ← only fail on items due within N days
//
// Run this well before the 18:00Z publish so a dead credential or an expired
// CDN link surfaces while there is still a day to fix it, instead of at publish
// time as a red run and a missed Short. Two things go stale on their own here:
//
//   - the refresh token, if the OAuth consent screen slips back to "Testing",
//     which kills it after 7 days (see README);
//   - the Higgsfield CDN links in queue.json, which expire. YouTube has no
//     upload-from-URL, so the bytes must still be fetchable at publish time.
//
// Nothing is uploaded and nothing is written. This only looks.

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadEnv, getAccessToken, buildSnippet, fail, Abort} from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(HERE, 'queue.json');

const flag = process.argv.indexOf('--days');
const DAYS = flag === -1 ? 7 : Number(process.argv[flag + 1]);

// A ranged GET rather than HEAD: an expired object can still answer HEAD from
// cache, and reading the first bytes proves the body is a file rather than an
// error page. Content-Range gives the full size without pulling the video down.
export async function probe(url) {
  if (!/^https?:/i.test(url)) {
    const local = join(HERE, url);
    return existsSync(local)
      ? {ok: true, note: 'local file'}
      : {ok: false, note: 'local file missing (and CI has no copy)'};
  }
  let res;
  try {
    res = await fetch(url, {headers: {Range: 'bytes=0-2047'}});
  } catch (e) {
    return {ok: false, note: `unreachable: ${e.message}`};
  }
  if (!res.ok) return {ok: false, note: `HTTP ${res.status}`};

  const bytes = (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
  if (!bytes) return {ok: false, note: 'empty body'};

  // Size of the whole object: Content-Range when the Range was honoured, and
  // Content-Length when the server ignored it and sent the lot. Without either,
  // what was read is all there is to go on.
  const total =
    res.status === 206
      ? Number((res.headers.get('content-range') || '').split('/')[1])
      : Number(res.headers.get('content-length')) || bytes;

  // fetchVideo() treats anything under 10 kB as a wrong URL, so flag it here
  // rather than letting the upload step discover it at publish time.
  if (total && total < 10_000) return {ok: false, note: `only ${total} bytes — wrong URL?`};
  return {ok: true, note: total ? `${(total / 1e6).toFixed(1)} MB` : 'reachable'};
}

async function main() {
  if (!existsSync(QUEUE)) fail(`No queue.json at ${QUEUE}.`);
  const items = JSON.parse(readFileSync(QUEUE, 'utf8'));
  const pending = items
    .filter((it) => !it.posted)
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  // Credentials first: if the refresh token is dead, nothing else matters and
  // getAccessToken already explains the "Testing" consent screen case.
  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN']);
  await getAccessToken(env);
  console.log('\ncredentials  OK — refresh token still exchanges for an access token');

  if (!pending.length) {
    console.log('\nQueue is empty. Nothing scheduled.\n');
    return;
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + DAYS * 86_400_000);
  console.log(`\n${pending.length} pending; checking every source URL:\n`);

  const broken = [];
  for (const it of pending) {
    const r = await probe(it.url);
    const soon = new Date(it.at) <= horizon;
    const mark = r.ok ? 'ok  ' : soon ? 'FAIL' : 'warn';
    const title = buildSnippet({caption: it.caption, title: it.title, categoryId: env.YT_CATEGORY_ID}).title;
    console.log(`  ${mark}  ${it.at.slice(0, 10)}  ${r.note.padEnd(28)}  ${title.slice(0, 52)}`);
    if (!r.ok && soon) broken.push({at: it.at, note: r.note});
  }

  if (broken.length) {
    console.error(`\n${broken.length} item(s) due in the next ${DAYS} days cannot be fetched:`);
    for (const b of broken) console.error(`  ${b.at}  ${b.note}`);
    console.error('\nRe-render or re-upload the source and update queue.json before the');
    console.error('publish window, or that day will fail at upload time.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll items due in the next ${DAYS} days are fetchable.\n`);
}

// probe() is exported for tests, so only run the check when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    if (!(e instanceof Abort)) console.error(`\n${e.message}\n`);
    process.exitCode = 1;
  });
}
