'use strict';
// A loaded host's thread pool for a test process (node --require; continuity-slow-host.test.mjs sets it up). With
// SLOW_DIGEST_MS the n-th crypto.subtle.digest of the process answers n*SLOW_DIGEST_MS late, so two requests started
// together reach their next step apart (a loaded host does this by itself).
const digestMs = Number(process.env.SLOW_DIGEST_MS || 0);
if (digestMs > 0) {
  const subtle = globalThis.crypto.subtle; // same object as require('node:crypto').webcrypto.subtle; lint forbids require()
  const digest = subtle.digest.bind(subtle);
  let n = 0;
  subtle.digest = async (...a) => { const late = n++ * digestMs; const out = await digest(...a); if (late) await new Promise((r) => setTimeout(r, late)); return out; };
}
