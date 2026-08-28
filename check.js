// Verify credentials and show which channel we are pointed at.
//   node check.js
import {loadEnv, getAccessToken, setEnvValue, Abort} from './lib.js';

async function main() {
  const env = loadEnv(['YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN']);
  const token = await getAccessToken(env);
  const r = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,status&mine=true',
    {headers: {Authorization: `Bearer ${token}`}}
  );
  const b = await r.json();
  if (!r.ok) { console.error(JSON.stringify(b, null, 2)); process.exitCode = 1; return; }
  const c = b.items?.[0];
  if (!c) { console.error('Authenticated, but this account has no channel yet.'); process.exitCode = 1; return; }
  console.log(`\nchannel    ${c.snippet.title}`);
  console.log(`id         ${c.id}`);
  if (env.YT_CHANNEL_ID !== c.id) {
    setEnvValue('YT_CHANNEL_ID', c.id);
    console.log('           (written to .env)');
  }
  console.log(`subs       ${c.statistics?.subscriberCount ?? '?'}`);
  console.log(`videos     ${c.statistics?.videoCount ?? '?'}`);
  console.log(`privacy    uploads will be requested as: ${env.YT_PRIVACY}`);
  console.log('\nCredentials work.\n');
}
main().catch((e) => { if (!(e instanceof Abort)) console.error(e.message); process.exitCode = 1; });
