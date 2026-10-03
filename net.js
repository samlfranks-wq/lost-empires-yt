// Network-retry shim, imported first by every entry script (2026-10-03).
//
// Run 37153961121 failed with a bare "fetch failed" in check.js: a transient network error
// on the GitHub runner reaching Google, with credentials that worked locally the same hour.
// One dropped connection should not fail a whole publish run.
//
// Retries ONLY when no HTTP response came back at all (fetch throws). Any response - even a
// 4xx/5xx - is returned untouched, so an upload can never be sent twice because of this
// shim. 3 attempts, 2 s then 6 s backoff.
const realFetch = globalThis.fetch;
const WAIT = [2000, 6000];
globalThis.fetch = async (input, init) => {
  for (let i = 0; ; i++) {
    try {
      return await realFetch(input, init);
    } catch (err) {
      if (i >= WAIT.length) throw err;
      const host = (() => { try { return new URL(String(input.url || input)).host; } catch { return '?'; } })();
      console.warn(`network error reaching ${host} (${err.cause?.code || err.message}) - retry ${i + 1}/${WAIT.length} in ${WAIT[i] / 1000}s`);
      await new Promise((r) => setTimeout(r, WAIT[i]));
    }
  }
};
export {};
