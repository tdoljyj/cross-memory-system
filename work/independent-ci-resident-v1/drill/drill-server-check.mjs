// The host's requests to the drill's server (the test project; FABLE-drill-test-project-sync-20261124.md sections 2.2 and 3), for
// drill-vm.ps1. Nothing here runs in the guest and nothing here is in the drill kit. The server is the one drill-server.json names
// (make-drill-kit.mjs readDrillServer) or the one a made kit names; no address is taken from anywhere else.
//   --store-key <key> [--key-file <file>]   drill-vm.ps1 -ServerKey: the project's public key, stored on the host once the project answers it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HOST_KEY_FILE, SERVER_KEY, readDrillServer, serverKeyRecord } from './make-drill-kit.mjs';

const check = (ok, code) => { if (!ok) throw new Error(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const RECEIPT_RPC = 'clued_drill_sync_receipt_v1';
const TRIES = 3;
const pauseFor = ms => new Promise(resolve => setTimeout(resolve, ms));

// One POST to a function of the server's REST interface, with the public key: { status, body } (body: the parsed JSON, or null).
// No answer, or a 5xx, is tried again (three tries in all); then DRILL_SERVER_UNREACHABLE.
async function post({ supabaseUrl, publishableKey, rpc, body, fetch: fetchImpl = fetch, pause = pauseFor }) {
  for (let n = 1; ; n++) {
    let status = null, parsed = null;
    try {
      const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${rpc}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      status = response.status;
      try { const text = await response.text(); parsed = text.length <= 65536 ? JSON.parse(text) : null; } catch { parsed = null; }
    } catch { status = null; }
    if (status !== null && status < 500) return { status, body: parsed };
    check(n < TRIES, 'DRILL_SERVER_UNREACHABLE');
    await pause(1000 * n);
  }
}

// The test project's sync receipt (public.clued_drill_sync_receipt_v1(), written by the sync job: which production state the project
// was brought to). 401/403: the key is not this project's (rotated); 404: the project was never synced; 200: the receipt as it is.
export async function syncReceipt({ supabaseUrl, publishableKey, fetch, pause }) {
  const r = await post({ supabaseUrl, publishableKey, rpc: RECEIPT_RPC, body: {}, fetch, pause });
  check(r.status !== 401 && r.status !== 403, 'DRILL_SERVER_KEY_REFUSED');
  check(r.status === 200 && plain(r.body) && typeof r.body.state === 'string' && /^[a-z][a-z-]{0,31}$/.test(r.body.state), 'DRILL_SERVER_NOT_IN_SYNC:no-receipt');
  return r.body;
}

// drill-vm.ps1 -ServerKey: the test project's public key, as DESK read it from the project. Its shape, then one request with it to the
// project drill-server.json names: stored on the host (the one copy make-drill-kit.mjs reads) only when the project answers it.
export async function storeServerKey({ key, file, keyFile = HOST_KEY_FILE, fetch, pause }) {
  check(typeof key === 'string' && SERVER_KEY.test(key), 'DRILL_SERVER_KEY_REFUSED');
  const server = readDrillServer({ file, keyFile: null, allowUnset: true });
  await syncReceipt({ supabaseUrl: server.supabaseUrl, publishableKey: key, fetch, pause });
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify(serverKeyRecord(server, key), null, 2) + '\n');
  return { status: 'DRILL_SERVER_KEY_STORED', project: server.project, supabaseUrl: server.supabaseUrl, file: keyFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['store-key', 'key-file'].map(n => [n, { type: 'string' }])) });
    if (values['store-key'] !== undefined) console.log(JSON.stringify(await storeServerKey({ key: values['store-key'], ...(values['key-file'] ? { keyFile: values['key-file'] } : {}) })));
    else check(false, 'USAGE: --store-key <key> [--key-file <file>]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
