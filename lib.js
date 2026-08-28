// Shared helpers for the YouTube publisher.
// Zero dependencies — Node 18+ native fetch, and a tiny .env reader so no
// npm install is needed. Mirrors ig-publisher/lib.js deliberately: same env
// handling, same failure style, so the two publishers behave alike.

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = join(HERE, '.env');

export class Abort extends Error {}

// fail() has already printed the message, so an Abort reaching the top level
// should end the process quietly rather than dumping a stack trace.
export function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exitCode = 1;
  throw new Abort(msg);
}

export function loadEnv(required = ['YT_CLIENT_ID', 'YT_CLIENT_SECRET']) {
  // CI (GitHub Actions) has no .env — values arrive as repo secrets in the
  // environment instead. Locally the file still wins, so nothing changes here.
  if (!existsSync(ENV_PATH)) {
    const fromProcess = {};
    for (const k of ['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN',
                     'YT_CHANNEL_ID', 'YT_CATEGORY_ID', 'YT_PRIVACY']) {
      if (process.env[k]) fromProcess[k] = process.env[k];
    }
    const missingEnv = required.filter((k) => !fromProcess[k]);
    if (missingEnv.length) {
      fail(
        [
          'No .env file, and missing from the environment: ' + missingEnv.join(', '),
          'Locally: copy .env.example to .env and fill it in.',
          'In GitHub Actions: add them as repository secrets.',
        ].join(String.fromCharCode(10))
      );
    }
    fromProcess.YT_CATEGORY_ID = fromProcess.YT_CATEGORY_ID || '27';
    fromProcess.YT_PRIVACY = (fromProcess.YT_PRIVACY || 'public').toLowerCase();
    return fromProcess;
  }
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  const missing = required.filter((k) => !env[k]);
  if (missing.length) fail(`Missing in .env: ${missing.join(', ')}`);
  env.YT_CATEGORY_ID = env.YT_CATEGORY_ID || '27';
  env.YT_PRIVACY = (env.YT_PRIVACY || 'public').toLowerCase();
  return env;
}

// Write a single key back into .env, preserving comments and ordering.
export function setEnvValue(key, value) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  let found = false;
  const out = lines.map((line) => {
    const t = line.trim();
    if (t.startsWith('#') || !t.includes('=')) return line;
    if (t.slice(0, t.indexOf('=')).trim() !== key) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) out.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, out.join('\n'));
}

// Exchange the long-lived refresh token for a short-lived access token.
// Google access tokens last ~1 hour; the refresh token does not expire unless
// revoked or the project stays in "Testing" publishing status (see README).
export async function getAccessToken(env) {
  if (!env.YT_REFRESH_TOKEN) {
    fail('No YT_REFRESH_TOKEN in .env. Run:  npm run auth');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      client_id: env.YT_CLIENT_ID,
      client_secret: env.YT_CLIENT_SECRET,
      refresh_token: env.YT_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      body.error === 'invalid_grant'
        ? '\n\nThe refresh token is dead. Most common cause: the OAuth consent\n' +
          'screen is still in "Testing", which expires tokens after 7 days.\n' +
          'Set it to "In production", then re-run:  npm run auth'
        : '';
    fail(`Token refresh failed (${res.status}): ${JSON.stringify(body)}${hint}`);
  }
  return body.access_token;
}

// Pull the video bytes down from the CDN. YouTube has no upload-from-URL,
// unlike Instagram — the bytes have to pass through this machine.
// `url` may be an http(s) URL or a local file path. Most renders live on this
// machine and never reach a CDN, so local paths are the common case.
export async function fetchVideo(url) {
  let buf;
  if (/^https?:/i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) fail(`Could not fetch video (${res.status}): ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    if (!existsSync(url)) fail(`Video file not found: ${url}`);
    buf = readFileSync(url);
  }
  if (buf.length < 10_000) fail(`Video at ${url} is only ${buf.length} bytes — wrong URL?`);
  return buf;
}

// Resumable upload: open a session, then PUT the bytes to the returned URL.
// One PUT is fine at our file sizes (~4 MB); chunking only matters over ~100 MB.
export async function uploadVideo({token, bytes, snippet, status}) {
  const init = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(bytes.length),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({snippet, status}),
    }
  );
  if (!init.ok) {
    const t = await init.text();
    fail(`Could not open upload session (${init.status}): ${t.slice(0, 500)}`);
  }
  const location = init.headers.get('location');
  if (!location) fail('Upload session opened but returned no Location header.');

  const put = await fetch(location, {
    method: 'PUT',
    headers: {'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length)},
    body: bytes,
  });
  const out = await put.json().catch(() => ({}));
  if (!put.ok) fail(`Upload failed (${put.status}): ${JSON.stringify(out).slice(0, 500)}`);
  return out;
}

// Set a custom thumbnail. Shorts show a frame from the video in the Shorts
// feed, but the custom thumbnail is what appears on the channel grid and in
// search — so it is still worth setting.
// `url` may be an http(s) URL or a local file path. YouTube thumbnails are
// 16:9 -- feeding it a 9:16 Instagram cover gets letterboxed, so prefer a
// purpose-built 1280x720 image (see thumbs/).
export async function setThumbnail({token, videoId, url}) {
  let bytes;
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) return {skipped: `cover fetch ${res.status}`};
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    if (!existsSync(url)) return {skipped: `cover file not found: ${url}`};
    bytes = readFileSync(url);
  }
  const up = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
    {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg'},
      body: bytes,
    }
  );
  if (!up.ok) {
    const t = await up.text();
    // Custom thumbnails need a verified phone number on the channel. Not fatal.
    return {skipped: `${up.status} ${t.slice(0, 160)}`};
  }
  return {ok: true};
}

// YouTube titles cap at 100 chars, descriptions at 5000.
export function buildSnippet({caption, categoryId, tags, title: explicitTitle, longform = false}) {
  // Prefer an explicit YouTube title. Instagram captions open with long
  // multi-sentence hooks, so falling back to the first line chops them
  // mid-sentence at 100 chars -- and that also pushes the title past the
  // 91-char budget for the #Shorts suffix, silently losing that too.
  const firstLine = (explicitTitle || caption.split('\n')[0]).trim();
  if (!explicitTitle && firstLine.length > 100) {
    console.warn(`  warning: title truncated from the caption (${firstLine.length} chars).`);
    console.warn('  Set a "title" on the queue item to write a proper headline.');
  }
  let title = firstLine.length > 100 ? `${firstLine.slice(0, 97).trimEnd()}...` : firstLine;
  // Shorts are identified by aspect ratio and length, but #Shorts in the title
  // is still the reliable signal while the video is being classified.
  if (!longform && !/#shorts/i.test(title) && title.length <= 91) title = `${title} #Shorts`;
  return {
    title,
    description: caption.slice(0, 5000),
    categoryId: String(categoryId),
    tags: tags && tags.length ? tags : undefined,
  };
}
