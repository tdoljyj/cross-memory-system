// The host's requests to the drill's server (the test project; FABLE-drill-test-project-sync-20261124.md sections 2.2 and 3), for
// drill-vm.ps1. Nothing here runs in the guest and nothing here is in the drill kit. The server is the one drill-server.json names
// (make-drill-kit.mjs readDrillServer) or the one a made kit names; no address is taken from anywhere else.
//   --store-key <key> [--key-file <file>]   drill-vm.ps1 -ServerKey: the project's public key, stored on the host once the project answers it
//   --ready <kit> --from <release-dir> --version <v>   Assert-DrillServerReady, before any boot; the drill binding's token on standard input
//                                           (never an argument or an environment variable)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HOST_KEY_FILE, SERVER_KEY, readDrillServer, serverKeyRecord, verifyKitServer } from './make-drill-kit.mjs';
// the request the guest's launcher sends and the one reading of its answer (the node's own role probe)
import { HOLDERS_RPC, parseRoleProbe } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/merge-slot-native.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';

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

// Before any boot (drill-vm.ps1 Assert-DrillServerReady): the kit against its Release (verifyKitServer, no network), then the drill's
// server itself, with the kit's own address, key, scope and repository:
//   the sync receipt  in-sync, or DRILL_SERVER_NOT_IN_SYNC:<syncing|diverged|no-receipt> (DRILL_SERVER_KEY_REFUSED: the key was rotated)
//   the role probe    the request the guest will send (the token's hash). The drill passes on "holds no role" only:
//                     404 DRILL_SERVER_PROBE_FUNCTION_MISSING (the project lacks the migration), 401/403 DRILL_BINDING_REFUSED_BY_SERVER
//                     (expired, or no read access to the kit's scope), let through DRILL_BINDING_ON_DUTY (the account has no parking
//                     role, so the server admits every binding, or the binding carries the role: the guest would turn ACTIVE)
// No answer after three tries: DRILL_SERVER_UNREACHABLE. Returns what verifyKitServer returns, and the receipt.
export async function serverReady({ kit, from, version, token, fetch, pause }) {
  check(typeof token === 'string' && /^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(token), 'DRILL_BINDING_CREDENTIAL_REFUSED');
  const verified = verifyKitServer({ kit, from, version });
  let record = null;
  try { record = JSON.parse(fs.readFileSync(path.join(kit, `fleet-node-${version}.first-install-kit.json`), 'utf8')).record; } catch { record = null; }
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 400;
  check(plain(record) && record.supabaseUrl === verified.supabaseUrl && SERVER_KEY.test(record.publishableKey ?? '') && text(record.scope) && text(record.repository),
    'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  const to = { supabaseUrl: record.supabaseUrl, publishableKey: record.publishableKey, fetch, pause };
  const receipt = await syncReceipt(to);
  check(receipt.state === 'in-sync', `DRILL_SERVER_NOT_IN_SYNC:${['syncing', 'diverged'].includes(receipt.state) ? receipt.state : 'no-receipt'}`);
  const r = await post({ ...to, rpc: HOLDERS_RPC, body: { p_token_hash: digest(token), p_input: { scope: record.scope, repository: record.repository } } });
  check(r.status !== 404, 'DRILL_SERVER_PROBE_FUNCTION_MISSING');
  check(r.status !== 401 && r.status !== 403, 'DRILL_BINDING_REFUSED_BY_SERVER');
  const probe = parseRoleProbe(r.status, r.body, record.repository).result;
  check(probe !== 'held', 'DRILL_BINDING_ON_DUTY');
  check(probe === 'not-held', 'DRILL_SERVER_UNREACHABLE:probe-unreadable');
  return { ...verified, receipt };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['store-key', 'key-file', 'ready', 'from', 'version'].map(n => [n, { type: 'string' }])) });
    if (values.ready !== undefined) {
      const token = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      console.log(JSON.stringify(await serverReady({ kit: values.ready, from: values.from, version: values.version, token })));
    } else if (values['store-key'] !== undefined) console.log(JSON.stringify(await storeServerKey({ key: values['store-key'], ...(values['key-file'] ? { keyFile: values['key-file'] } : {}) })));
    else check(false, 'USAGE: --store-key <key> [--key-file <file>] | --ready <kit> --from <release-dir> --version <v> (the token on standard input)');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
