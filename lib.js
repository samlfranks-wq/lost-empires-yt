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
  const KEYS = ['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN',
                'YT_CHANNEL_ID', 'YT_CATEGORY_ID', 'YT_PRIVACY'];

  // Both sources are always merged, never one or the other. CI (GitHub
  // Actions) ships no .env of its own — values arrive as repo secrets in the
  // environment — but check.js writes YT_CHANNEL_ID back to .env, and that
  // one-key file must not go on to hide the secrets standing behind it.
  // Locally the file still wins for every key it actually sets.
  const env = {};
  for (const k of KEYS) {
    if (process.env[k]) env[k] = process.env[k].trim();  // a pasted secret can carry a trailing newline
  }
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      const value = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (value) env[key] = value;  // an empty line in .env leaves the environment's value alone
    }
  }

  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    fail(
      [
        'Missing credentials: ' + missing.join(', '),
        'Locally: copy .env.example to .env and fill it in.',
        'In GitHub Actions: add them as repository secrets.',
      ].join('\n')
    );
  }
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
// Width/height straight out of the file header (PNG or JPEG) -- enough to tell
// portrait from landscape without an image library.
export function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return {w: b.readUInt32BE(16), h: b.readUInt32BE(20)};
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return {h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7)};
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Load a cover (URL or path relative to this repo) and say whether YouTube will
// show it properly. A 9:16 cover still gets HTTP 200 from thumbnails/set, then
// YouTube pillarboxes it -- Sam was fixing those by hand after every post.
export async function coverShape(url) {
  let bytes;
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) return {ok: false, note: `cover fetch ${res.status}`};
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    const p = existsSync(url) ? url : join(HERE, url);
    if (!existsSync(p)) return {ok: false, note: `cover file not found: ${url}`};
    bytes = readFileSync(p);
  }
  const dim = imageSize(bytes);
  if (dim && dim.w / dim.h < 1.2) return {ok: false, bytes, note: `cover ${dim.w}x${dim.h} is portrait - needs 16:9 (1280x720)`};
  return {ok: true, bytes, note: dim ? `cover ${dim.w}x${dim.h}` : 'cover ok'};
}

export async function setThumbnail({token, videoId, url}) {
  const shape = await coverShape(url);
  if (!shape.ok) return {skipped: `${shape.note}. Make one with map-pipeline/make_thumb2.py and put it in thumbs/.`};
  const bytes = shape.bytes;
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
