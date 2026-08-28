// One-time OAuth setup. Run once per channel:  npm run auth
//
// Spins a throwaway loopback server, opens Google's consent screen, catches the
// redirect, exchanges the code for a refresh token and writes it into .env.
// Nothing is printed to the terminal except success — the token goes straight
// to disk so it never ends up in shell history or a transcript.

import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {loadEnv, setEnvValue, fail, Abort} from './lib.js';

// force-ssl is needed to EDIT an existing video (title/description/thumbnail).
// upload+readonly alone can create videos but not modify them afterwards.
const SCOPE = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');

async function main() {
  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET']);

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}`;

  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: env.YT_CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent', // force a refresh token even on re-auth
    });

  console.log('\nOpening Google consent screen in your browser.');
  console.log('If it does not open, paste this into a browser:\n');
  console.log(url + '\n');
  // A Desktop-app OAuth client accepts ANY loopback port without registering it
  // (Google's native-app guide says to start a listener on a random available
  // port), so there is nothing to paste into the Cloud console. A Web-application
  // client does NOT work this way -- a redirect_uri_mismatch here means the OAuth
  // client was created as the wrong type.
  console.log(`Loopback redirect for this run: ${redirect}`);
  console.log('Nothing to register - Desktop clients accept any loopback port.\n');
  spawn('cmd', ['/c', 'start', '', url], {detached: true, stdio: 'ignore'}).unref();

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out after 5 minutes.')), 300_000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirect);
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(
        `<body style="font:16px system-ui;padding:3rem">${
          c ? 'Authorised. You can close this tab.' : `Failed: ${err || 'no code returned'}`
        }</body>`
      );
      clearTimeout(timer);
      if (c) resolve(c);
      else reject(new Error(err || 'no code returned'));
    });
  }).finally(() => server.close());

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      code,
      client_id: env.YT_CLIENT_ID,
      client_secret: env.YT_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    fail(
      `Token exchange failed (${res.status}): ${JSON.stringify(body)}\n\n` +
        'If there is no refresh_token, revoke this app at\n' +
        'myaccount.google.com/permissions and run auth again.'
    );
  }

  setEnvValue('YT_REFRESH_TOKEN', body.refresh_token);
  console.log('Refresh token written to .env. Now run:  npm run check');
}

main().catch((e) => {
  // Abort has already printed its message. Still exit non-zero so Task
  // Scheduler and queue.log record a failure instead of a silent success.
  if (!(e instanceof Abort)) console.error(`\n${e.message}\n`);
  process.exitCode = 1;
});
