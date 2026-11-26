// The host's requests about the drill's server (the test project; FABLE-drill-test-project-sync-20261124.md sections 2.2 and 3, and
// the ruling on the PR-A report at its end), for drill-vm.ps1. Nothing here runs in the guest and nothing here is in the drill kit. The
// server is the one drill-server.json names (make-drill-kit.mjs readDrillServer) or the one a made kit names; no address is taken from
// anywhere else.
//   --store-key <key> [--key-file <file>]   drill-vm.ps1 -ServerKey: the project's public key, stored on the host once the project answers it
//   --production-list --cache <dir>         Sync-DrillServer: production's applied list, as the latest successful release run on main exported it
//   --ready <kit> --from <release-dir> --version <v>   Assert-DrillServerReady, before any boot, after the sync; the drill binding's
//                                           token on standard input (never an argument or an environment variable)
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HOST_KEY_FILE, SERVER_KEY, readDrillServer, serverKeyRecord, verifyKitServer } from './make-drill-kit.mjs';
// the request the guest's launcher sends and the one reading of its answer (the node's own role probe)
import { HOLDERS_RPC, parseRoleProbe } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/merge-slot-native.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';

const check = (ok, code) => { if (!ok) throw new Error(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
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

// The role probe (public.clued_work_merge_slot_holders_v1), the request the guest's launcher sends. A 401/403 is the project's own
// refusal of the binding only when the database says so (42501 with the binding's message, as parseRoleProbe reads it); any other is
// the API gateway refusing the key (rotated, or not this project's): DRILL_SERVER_KEY_REFUSED. 404: the project lacks the function.
// Returns { status, body, bindingRefused }.
async function probe({ supabaseUrl, publishableKey, tokenHash, input, fetch, pause }) {
  const r = await post({ supabaseUrl, publishableKey, rpc: HOLDERS_RPC, body: { p_token_hash: tokenHash, p_input: input }, fetch, pause });
  check(r.status !== 404, 'DRILL_SERVER_PROBE_FUNCTION_MISSING');
  const refused = r.status === 401 || r.status === 403;
  const bindingRefused = refused && parseRoleProbe(r.status, r.body, '').code === 'ROLE_PROBE_CONNECTION_UNAUTHORIZED';
  check(!refused || bindingRefused, 'DRILL_SERVER_KEY_REFUSED');
  return { ...r, bindingRefused };
}

// drill-vm.ps1 -ServerKey: the test project's public key, as DESK read it from the project. Its shape, then one role probe with it and
// a random token hash to the project drill-server.json names: the project's own refusal of that hash (binding_not_authorized) is the
// key accepted, and only then is it stored on the host (the one copy make-drill-kit.mjs reads). Any other answer stores nothing.
export async function storeServerKey({ key, file, keyFile = HOST_KEY_FILE, fetch, pause }) {
  check(typeof key === 'string' && SERVER_KEY.test(key), 'DRILL_SERVER_KEY_REFUSED');
  const server = readDrillServer({ file, keyFile: null, allowUnset: true });
  const r = await probe({ supabaseUrl: server.supabaseUrl, publishableKey: key, tokenHash: digest(randomBytes(32).toString('hex')), input: {}, fetch, pause });
  check(r.bindingRefused, 'DRILL_SERVER_KEY_REFUSED');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify(serverKeyRecord(server, key), null, 2) + '\n');
  return { status: 'DRILL_SERVER_KEY_STORED', project: server.project, supabaseUrl: server.supabaseUrl, file: keyFile };
}

// Production's applied migration list (the ruling, section 1): the host cannot read production, so the list is the file the release
// workflow exports read-only at its end (clued-production-applied-<run>/production-applied.json). Which one: the newest successful run
// of that workflow on main. Kept on the host under <cache>/<run>/; the same run again is the copy, not another download; a newer run
// replaces it. Every gh call is tried three times.
//   DRILL_SERVER_PRODUCTION_LIST_MISSING:<why>  no successful run, it exported no list (or it expired), or the file is not that run's list
//                                               (what to do: one release preflight run, read-only, exports one)
//   DRILL_SERVER_UNREACHABLE:github             gh did not answer after three tries
//   DRILL_SERVER_SYNC_TOOL_MISSING:gh           no gh on this host
export const RELEASE_REPOSITORY = 'tdoljyj/cross-memory-system';
export const RELEASE_WORKFLOW = 'clued-cloud-production-release.yml';
export const APPLIED_CONTRACT = 'clued.production-applied.v1';
const ARTIFACT = run => `clued-production-applied-${run}`;
const LIST_FILE = 'production-applied.json';
function isListOf(file, run) {
  let v = null;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return false; }
  return plain(v) && v.contract === APPLIED_CONTRACT && String(v.run_id) === String(run) && Array.isArray(v.applied) && v.applied.length > 0;
}
const runGh = args => new Promise(resolve => {
  execFile('gh', args, { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error?.code === 'ENOENT') resolve({ missing: true });
    else resolve({ exit: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});
export async function productionList({ cacheDir, gh = runGh, pause = pauseFor }) {
  const call = async (args, before = () => {}) => {
    for (let n = 1; ; n++) {
      before();
      let r;
      try { r = await gh(args); } catch (e) { r = e?.code === 'ENOENT' ? { missing: true } : { exit: 1 }; }
      check(!r.missing, 'DRILL_SERVER_SYNC_TOOL_MISSING:gh');
      if (r.exit === 0) return r.stdout;
      check(n < TRIES, 'DRILL_SERVER_UNREACHABLE:github');
      await pause(2000 * n);
    }
  };
  const json = text => { try { return JSON.parse(text); } catch { return undefined; } };
  const runs = json(await call(['run', 'list', '--repo', RELEASE_REPOSITORY, '--workflow', RELEASE_WORKFLOW, '--branch', 'main', '--status', 'success',
    '--limit', '1', '--json', 'databaseId,headSha']));
  check(Array.isArray(runs), 'DRILL_SERVER_UNREACHABLE:github');
  check(runs.length > 0, 'DRILL_SERVER_PRODUCTION_LIST_MISSING:no-successful-release');
  const run = runs[0]?.databaseId;
  check(Number.isSafeInteger(run) && run > 0, 'DRILL_SERVER_UNREACHABLE:github');
  const dir = path.join(cacheDir, String(run)), file = path.join(dir, LIST_FILE);
  if (isListOf(file, run)) return { run, file, cached: true };
  const found = json(await call(['api', `repos/${RELEASE_REPOSITORY}/actions/runs/${run}/artifacts?name=${ARTIFACT(run)}`]));
  check(plain(found) && Array.isArray(found.artifacts), 'DRILL_SERVER_UNREACHABLE:github');
  check(found.artifacts.some(a => plain(a) && a.name === ARTIFACT(run) && a.expired === false), 'DRILL_SERVER_PRODUCTION_LIST_MISSING:no-artifact');
  const partial = path.join(cacheDir, `${run}.partial`);
  await call(['run', 'download', String(run), '--repo', RELEASE_REPOSITORY, '--name', ARTIFACT(run), '--dir', partial],
    () => fs.rmSync(partial, { recursive: true, force: true }));
  if (!isListOf(path.join(partial, LIST_FILE), run)) {
    fs.rmSync(partial, { recursive: true, force: true });
    check(false, 'DRILL_SERVER_PRODUCTION_LIST_MISSING:not-a-list');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  for (const other of fs.readdirSync(cacheDir)) if (other !== String(run)) fs.rmSync(path.join(cacheDir, other), { recursive: true, force: true });
  return { run, file, cached: false };
}

// Before any boot (drill-vm.ps1 Assert-DrillServerReady, after Sync-DrillServer brought the project to production's list): the kit
// against its Release (verifyKitServer, no network), then the role probe the guest will send, sent from here with the binding's token
// and the kit's own address, key, scope and repository. The drill passes on "holds no role" only:
//   404 DRILL_SERVER_PROBE_FUNCTION_MISSING (the project lacks the migration), 401/403 from the project DRILL_BINDING_REFUSED_BY_SERVER
//   (expired, or no read access to the kit's scope), 401/403 from the gateway DRILL_SERVER_KEY_REFUSED (the kit's key was rotated), let
//   through DRILL_BINDING_ON_DUTY (the account has no parking role, so the server admits every binding, or the binding carries the role:
//   the guest would turn ACTIVE)
// No answer after three tries: DRILL_SERVER_UNREACHABLE. Returns what verifyKitServer returns.
export async function serverReady({ kit, from, version, token, fetch, pause }) {
  check(typeof token === 'string' && /^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(token), 'DRILL_BINDING_CREDENTIAL_REFUSED');
  const verified = verifyKitServer({ kit, from, version });
  let record = null;
  try { record = JSON.parse(fs.readFileSync(path.join(kit, `fleet-node-${version}.first-install-kit.json`), 'utf8')).record; } catch { record = null; }
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 400;
  check(plain(record) && record.supabaseUrl === verified.supabaseUrl && SERVER_KEY.test(record.publishableKey ?? '') && text(record.scope) && text(record.repository),
    'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  const r = await probe({ supabaseUrl: record.supabaseUrl, publishableKey: record.publishableKey, tokenHash: digest(token),
    input: { scope: record.scope, repository: record.repository }, fetch, pause });
  check(!r.bindingRefused, 'DRILL_BINDING_REFUSED_BY_SERVER');
  const answer = parseRoleProbe(r.status, r.body, record.repository).result;
  check(answer !== 'held', 'DRILL_BINDING_ON_DUTY');
  check(answer === 'not-held', 'DRILL_SERVER_UNREACHABLE:probe-unreadable');
  return verified;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { ...Object.fromEntries(['store-key', 'key-file', 'ready', 'from', 'version', 'cache'].map(n => [n, { type: 'string' }])),
      'production-list': { type: 'boolean' } } });
    if (values.ready !== undefined) {
      const token = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      console.log(JSON.stringify(await serverReady({ kit: values.ready, from: values.from, version: values.version, token })));
    } else if (values['store-key'] !== undefined) console.log(JSON.stringify(await storeServerKey({ key: values['store-key'], ...(values['key-file'] ? { keyFile: values['key-file'] } : {}) })));
    else if (values['production-list'] && values.cache) console.log(JSON.stringify(await productionList({ cacheDir: values.cache })));
    else check(false, 'USAGE: --store-key <key> [--key-file <file>] | --production-list --cache <dir> | --ready <kit> --from <release-dir> --version <v> (the token on standard input)');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
