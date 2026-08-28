// Upload one video to YouTube.
//
//   node post.js --url <video-url> --caption-file <path> [--cover <jpg-url>]
//   node post.js --url <video-url> --caption "..."       [--cover <jpg-url>]
//
// Add --confirm to actually publish. Without it this is a dry run that shows
// exactly what would be sent and uploads nothing — same safety rule as the
// Instagram publisher.

import {readFileSync} from 'node:fs';
import {loadEnv, getAccessToken, fetchVideo, uploadVideo, setThumbnail, buildSnippet, fail, Abort} from './lib.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN']);
  const url = arg('url');
  const cover = arg('cover');
  const captionFile = arg('caption-file');
  const caption = captionFile ? readFileSync(captionFile, 'utf8') : arg('caption');
  const confirm = process.argv.includes('--confirm');

  if (!url) fail('Missing --url');
  if (!caption) fail('Missing --caption or --caption-file');

  const snippet = buildSnippet({
    caption,
    title: arg('title'),
    categoryId: env.YT_CATEGORY_ID,
    longform: process.argv.includes('--long'),
  });
  const status = {
    privacyStatus: env.YT_PRIVACY,
    selfDeclaredMadeForKids: false,
  };

  console.log(`\ntitle    ${snippet.title}`);
  console.log(`category ${snippet.categoryId}   privacy ${status.privacyStatus}`);
  console.log(`video    ${url}`);
  console.log(`cover    ${cover || '(none)'}`);
  console.log(`desc     ${snippet.description.length} chars`);

  if (!confirm) {
    console.log('\nDry run. Nothing uploaded. Re-run with --confirm to publish.\n');
    return;
  }

  const token = await getAccessToken(env);
  const bytes = await fetchVideo(url);
  console.log(`\nfetched ${(bytes.length / 1048576).toFixed(2)} MB, uploading...`);

  const video = await uploadVideo({token, bytes, snippet, status});
  const id = video.id;
  const actual = video.status?.privacyStatus;
  console.log(`uploaded https://youtube.com/watch?v=${id}`);

  if (cover) {
    const t = await setThumbnail({token, videoId: id, url: cover});
    console.log(t.ok ? 'thumbnail set' : `thumbnail skipped: ${t.skipped}`);
  }

  if (actual && actual !== env.YT_PRIVACY) {
    console.log(
      `\nNOTE: requested "${env.YT_PRIVACY}" but YouTube returned "${actual}".\n` +
        'That is the unverified-project lock. The video is uploaded and\n' +
        'correct — flip it to public in YouTube Studio, or complete the API\n' +
        'compliance audit to remove the restriction permanently.'
    );
  }
  console.log('');
  return id;
}

main().catch((e) => {
  // Abort has already printed its message. Still exit non-zero so Task
  // Scheduler and queue.log record a failure instead of a silent success.
  if (!(e instanceof Abort)) console.error(`\n${e.message}\n`);
  process.exitCode = 1;
});
