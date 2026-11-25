// After the Owner's acceptance, to every node on the accepted Source: ONE bounded command (PLAN-accept-auto-seal-20261125.md 2.3,
// phase one). The Owner's acceptance is one fleet.accept Grant approved on the Clued confirm page; nothing here takes the Owner's
// words, a hand-written Decision or its three values (there is no option for them: --decision-record is USAGE like any other).
//
//   node rollout/fleet/accept.mjs run --request <fleet-node-<v>.acceptance-request.json> [--drill-receipt <receipt.json>] --work <dir> [--wait <minutes>]
//   node rollout/fleet/accept.mjs open --request <...acceptance-request.json> [--drill-receipt <receipt.json>]
//        open: one seal call, no wait, nothing else (drill/drill-vm.ps1 -Finalize runs it for a candidate that ends PASS, to put the
//        confirm link into its answer). Exit 0 on any of seal's three answers.
//
// run, three steps, each safe to run again as it is (DESK starts it in the background, like wait-pr.sh: bounded, its exit wakes DESK):
//   1. seal (publish.mjs, piece B: it opens the request at the door, or reads its answer). WAITING_OWNER: asked again every 30 s, then
//      60, then every 120 s, until --wait minutes (default: the request's expiresAt, else 24 hours) -> ROLLOUT_WAITING_OWNER with the
//      link. REJECTED (refused or expired) -> ROLLOUT_STOPPED at the acceptance: the candidate stays unaccepted, the same command again
//      opens a new request. SEALED: on.
//   2. this node: upgrade.mjs fetch --version <v> --work <work>\node --repo <the request's>, never --allow-active-upgrade at first.
//      - FLEET_NODE_UPGRADE_REQUESTED: noted in <work>\requested-<tag>.json, then upgrade\status.json is read until the operation is
//        over (no op moving and either this node's current.json has both sides on the accepted Source or the upgrader recorded an
//        ending since the request); both sides on the accepted Source -> on; else ROLLOUT_STOPPED (node, outcome and code from
//        status.json recent). A run that finds the note asks upgrade.mjs nothing again: it only reads status.json and current.json, so
//        a rollback is never requested again by this command (a second request of the same package is the Owner's, server rule).
//      - FLEET_NODE_UPGRADE_IN_PROGRESS: read the same way. FLEET_NODE_ALREADY_AT_THIS_PACKAGE: on.
//      - FLEET_NODE_UPGRADE_HAND_OVER_FIRST (this node holds ci-admission): the fleet is read; only when every other node reports the
//        accepted Source and stands unpaused is the same command given --allow-active-upgrade (never both drained: a standby that
//        failed leaves the node on duty untouched). Else ROLLOUT_WAITING_OTHER_NODES naming them; run again once they are there.
//      - any other answer (NEEDS_REINSTALL, PRECHECK_REFUSED, REFUSED): ROLLOUT_STOPPED with the node and its code.
//      Bounded: NODE_WAIT_MINUTES of reading -> ROLLOUT_IN_PROGRESS (run again).
//   3. the fleet: every registered node's last reported Source is the accepted one and none stands paused -> ROLLOUT_DONE; else
//      ROLLOUT_WAITING_OTHER_NODES with the nodes still to go (phase one: DESK runs the same upgrade.mjs fetch on TURING through Desktop
//      Commander, then this command again; plan 2.4).
//
// The fleet read (readFleet) is the door's (plan section 3 item 4: piece A's door answers each registered node's last reported Source;
// piece B's accept-door.mjs exports it as readFleet({ repo }) -> [{ node, ciSourceManifestSha256, paused }]). Until it does, the fleet
// is unreadable: a node on duty is then never requested, and step 3 answers ROLLOUT_WAITING_OTHER_NODES with code
// ROLLOUT_FLEET_UNREADABLE, never ROLLOUT_DONE.
//
// Writes only under --work (upgrade.mjs's own directory and the note). Reads upgrade\status.json and upgrade\current.json under the
// resident root (read-only, as upgrade.mjs does). One JSON line; exit 0 ROLLOUT_DONE, 2 waiting (Owner, other nodes, this node), 1
// stopped or refused. `deps` is for tests only (a fixture root, a fake seal, upgrade, fleet read and clock); the command line cannot
// reach it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_ROOT } from './install.mjs';
import { readRequest } from './publish.mjs';
import { Refused } from './ports.mjs';
import { tagOf } from './universal.mjs';
import { OP_MOVING, main as upgradeMain } from './upgrade.mjs';

export const ROLLOUT_CONTRACT = 'clued.independent-ci.fleet-rollout/1';
// seal()'s answers (plan section 5, the interface pieces B and C share)
export const SEAL_WAITING = 'FLEET_ACCEPTANCE_WAITING_OWNER';
export const SEAL_SEALED = 'FLEET_ACCEPTANCE_SEALED';
export const SEAL_REJECTED = 'FLEET_ACCEPTANCE_REJECTED';
const SEAL_ANSWERS = Object.freeze([SEAL_WAITING, SEAL_SEALED, SEAL_REJECTED]);
export const POLL_MS = Object.freeze({ first: 30_000, max: 120_000 });
export const NODE_WAIT_MINUTES = 180;   // the upgrader's grant, drain and switch of one node, with room
const DAY_MS = 24 * 3600_000;
const HEX64 = /^[0-9a-f]{64}$/;
const WAITING = Object.freeze(['ROLLOUT_WAITING_OWNER', 'ROLLOUT_WAITING_OTHER_NODES', 'ROLLOUT_IN_PROGRESS']);

export const exitCodeOf = r => (r?.status === 'ROLLOUT_DONE' || (r?.command === 'open' && SEAL_ANSWERS.includes(r.status)) ? 0 : WAITING.includes(r?.status) ? 2 : 1);
const usage = () => { throw new Refused('USAGE'); };
const jsonOf = b => JSON.parse(Buffer.from(b).toString('utf8').replace(/^\uFEFF/, ''));
async function readJsonOrNull(file) {
  try { return jsonOf(await fs.readFile(file)); } catch { return null; }
}

// --- the defaults the command line uses (tests give their own) ---
// piece B's seal(): one look at the door (wait 0), never a wait of its own; the polling is this command's.
async function defaultSeal({ request, drillReceipt, repo }) {
  const { seal } = await import('./publish.mjs');
  return seal({ request, drillReceipt, repo, wait: 0 });
}
async function defaultReadFleet({ repo }) {
  let door = null;
  try { door = await import('./accept-door.mjs'); } catch { door = null; }
  if (typeof door?.readFleet !== 'function') throw new Refused('ROLLOUT_FLEET_UNREADABLE', 'accept-door.mjs has no readFleet (plan section 3 item 4)');
  return door.readFleet({ repo });
}
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The fleet as [{ node, ciSourceManifestSha256, paused }], or null when it cannot be read (never guessed).
async function fleetOf(ctx) {
  try {
    const f = await ctx.readFleet({ repo: ctx.request.repository });
    const ok = Array.isArray(f) && f.every(n => n && typeof n.node === 'string' && n.node && (n.ciSourceManifestSha256 === null || HEX64.test(n.ciSourceManifestSha256 ?? ''))
      && typeof n.paused === 'boolean');
    return ok ? f.map(n => ({ node: n.node, ciSourceManifestSha256: n.ciSourceManifestSha256, paused: n.paused })) : null;
  } catch { return null; }
}
const notThere = (fleet, accepted) => fleet.filter(n => n.ciSourceManifestSha256 !== accepted || n.paused);

function answer(ctx, status, fields = {}) {
  return { contract: ROLLOUT_CONTRACT, status, version: ctx.request.version, ciSourceManifestSha256: ctx.request.ciSourceManifestSha256, ...fields };
}
const upgradeCommand = ctx => `node <upgrade.mjs> fetch --version ${ctx.request.version} --work <a new directory>`;
const rerun = ctx => `run the same accept.mjs run command again (--request ${ctx.requestFile} --work ${ctx.work})`;
function waitingOthers(ctx, pending, extra = {}) {
  const names = pending === null ? 'every node (the fleet could not be read)' : pending.map(n => n.node).join(', ');
  return answer(ctx, 'ROLLOUT_WAITING_OTHER_NODES', { pending, ...extra,
    next: `on ${names}: ${upgradeCommand(ctx)} (the node on duty last, with --allow-active-upgrade); then ${rerun(ctx)}` });
}

// 1. the acceptance: seal until the door answers, bounded
async function accept(ctx) {
  let interval = POLL_MS.first, deadline = null;
  for (;;) {
    let s;
    try { s = await ctx.seal({ request: ctx.requestFile, drillReceipt: ctx.drillReceipt, repo: ctx.request.repository }); } catch (e) {
      return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: e?.code ?? 'ROLLOUT_SEAL_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300),
        next: `fix what code names, then ${rerun(ctx)}` }) };
    }
    if (s?.status === SEAL_SEALED) return { sealed: s };
    if (s?.status === SEAL_REJECTED) {
      return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: s.code ?? SEAL_REJECTED, seal: s,
        next: `the Owner did not accept (or the request expired): the candidate stays unaccepted; ${rerun(ctx)} opens a new request` }) };
    }
    if (s?.status !== SEAL_WAITING) {
      return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: 'ROLLOUT_SEAL_ANSWER_UNKNOWN', seal: s ?? null, next: rerun(ctx) }) };
    }
    if (deadline === null) {
      const expires = Date.parse(s.expiresAt ?? '');
      deadline = ctx.waitMinutes !== null ? ctx.now() + ctx.waitMinutes * 60_000 : Number.isFinite(expires) ? expires : ctx.now() + DAY_MS;
    }
    if (ctx.now() + interval > deadline) {
      return { stop: answer(ctx, 'ROLLOUT_WAITING_OWNER', { confirmUrl: s.confirmUrl ?? null, expiresAt: s.expiresAt ?? null,
        next: `the Owner approves once at confirmUrl; ${rerun(ctx)}` }) };
    }
    await ctx.sleep(interval);
    interval = Math.min(interval * 2, POLL_MS.max);
  }
}

// both sides of this node on the accepted Source (upgrade\current.json)
async function localAtTarget(ctx) {
  const cur = await readJsonOrNull(path.join(ctx.root, 'upgrade', 'current.json'));
  return cur?.ciSourceManifestSha256 === ctx.request.ciSourceManifestSha256 && cur?.linux?.ciSourceManifestSha256 === ctx.request.ciSourceManifestSha256;
}

// 2b. this node's operation, read until it is over (status.json), then judged on current.json
async function follow(ctx, { node, requestedAt }) {
  const statusFile = path.join(ctx.root, 'upgrade', 'status.json');
  const deadline = ctx.now() + ctx.nodeWaitMinutes * 60_000;
  let interval = POLL_MS.first;
  for (;;) {
    const st = await readJsonOrNull(statusFile);
    const op = st?.op ?? null;
    const moving = op !== null && OP_MOVING.includes(op.state);
    const ends = (Array.isArray(st?.recent) ? st.recent : []).filter(e => requestedAt === null || Date.parse(e?.at ?? '') >= Date.parse(requestedAt))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!moving && await localAtTarget(ctx)) return { done: true };
    if (!moving && (requestedAt === null || ends.length > 0)) {
      const last = ends.at(-1) ?? null;
      return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'node', node, outcome: last?.outcome ?? null, code: last?.code ?? last?.outcome ?? 'UPGRADE_ENDED_NOT_AT_TARGET',
        statusFile, next: `this node did not reach the accepted Source (the upgrader rolled back or refused; status.json recent). Stop here: find the cause first (README 0.5); no other node is touched` }) };
    }
    if (ctx.now() + interval > deadline) {
      return { stop: answer(ctx, 'ROLLOUT_IN_PROGRESS', { node, op: op && { opId: op.opId ?? null, state: op.state, phase: op.phase ?? null, confirmUrl: op.grant?.confirmUrl ?? null },
        statusFile, next: rerun(ctx) }) };
    }
    await ctx.sleep(interval);
    interval = Math.min(interval * 2, POLL_MS.max);
  }
}

// 2. this node
async function upgradeHere(ctx) {
  const note = path.join(ctx.work, `requested-${tagOf(ctx.request.version)}.json`);
  const noted = await readJsonOrNull(note);
  if (noted) return follow(ctx, { node: noted.node ?? null, requestedAt: noted.requestedAt ?? null });   // asked once: never again
  const call = allowActive => ctx.upgrade(['fetch', '--version', ctx.request.version, '--work', path.join(ctx.work, 'node'), '--repo', ctx.request.repository,
    ...(allowActive ? ['--allow-active-upgrade'] : [])]);
  const requestedAt = new Date(ctx.now()).toISOString();
  let a = await call(false);
  if (a?.status === 'FLEET_NODE_UPGRADE_HAND_OVER_FIRST') {
    const fleet = await fleetOf(ctx);
    if (fleet === null) return { stop: waitingOthers(ctx, null, { node: a.node ?? null, code: 'ROLLOUT_FLEET_UNREADABLE' }) };
    const pending = notThere(fleet.filter(n => n.node !== a.node), ctx.request.ciSourceManifestSha256);
    if (pending.length > 0) return { stop: waitingOthers(ctx, pending, { node: a.node ?? null }) };
    a = await call(true);   // every other node is on the accepted Source and running: the node on duty goes, its CI pause the Owner accepted
  }
  if (a?.status === 'FLEET_NODE_UPGRADE_REQUESTED') {
    await fs.mkdir(ctx.work, { recursive: true });
    await fs.writeFile(note, JSON.stringify({ version: ctx.request.version, ciSourceManifestSha256: ctx.request.ciSourceManifestSha256, node: a.node ?? null,
      requestId: a.request?.requestId ?? null, requestFile: a.request?.requestFile ?? null, packageManifestSha256: a.packageManifestSha256 ?? null, requestedAt }, null, 2) + '\n');
    return follow(ctx, { node: a.node ?? null, requestedAt });
  }
  if (a?.status === 'FLEET_NODE_UPGRADE_IN_PROGRESS') return follow(ctx, { node: a.node ?? null, requestedAt: null });
  if (a?.status === 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') return { done: true };
  return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'node', node: a?.node ?? null, nodeAnswer: a?.status ?? null, code: a?.code ?? a?.status ?? 'ROLLOUT_NODE_NO_ANSWER',
    detail: a?.detail ?? null, next: a?.reinstall ?? `fix what code names (README 0.3), then ${rerun(ctx)}` }) };
}

export async function run(ctx) {
  const acc = await accept(ctx);
  if (acc.stop) return acc.stop;
  const here = await upgradeHere(ctx);
  if (here.stop) return here.stop;
  // 3. the fleet
  const fleet = await fleetOf(ctx);
  if (fleet === null) return waitingOthers(ctx, null, { code: 'ROLLOUT_FLEET_UNREADABLE', acceptance: acc.sealed.acceptance ?? null });
  const pending = notThere(fleet, ctx.request.ciSourceManifestSha256);
  if (pending.length > 0) return waitingOthers(ctx, pending, { acceptance: acc.sealed.acceptance ?? null });
  return answer(ctx, 'ROLLOUT_DONE', { acceptance: acc.sealed.acceptance ?? null, nodes: fleet.map(n => n.node), next: null });
}

async function contextOf(values, deps) {
  if (!values.request) usage();
  const requestFile = path.resolve(values.request);
  let request;
  try { request = readRequest(jsonOf(await fs.readFile(requestFile))); } catch (e) { throw new Refused(e?.code ?? 'REQUEST_REFUSED', e?.detail ?? 'not a JSON file'); }
  return { requestFile, request, drillReceipt: values['drill-receipt'] ? path.resolve(values['drill-receipt']) : null,
    seal: deps.seal ?? defaultSeal, upgrade: deps.upgrade ?? upgradeMain, readFleet: deps.readFleet ?? defaultReadFleet,
    sleep: deps.sleep ?? defaultSleep, now: deps.now ?? Date.now, root: deps.root ?? DEFAULT_ROOT, nodeWaitMinutes: deps.nodeWaitMinutes ?? NODE_WAIT_MINUTES };
}

export async function main(argv, deps = {}) {
  const [sub, ...rest] = argv;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { request: { type: 'string' }, 'drill-receipt': { type: 'string' }, work: { type: 'string' }, wait: { type: 'string' } } });
    } catch { usage(); }   // any other option (a hand-written --decision-record among them) has no way in
    const { values } = parsed;
    if (sub === 'open') {
      if (values.work !== undefined || values.wait !== undefined) usage();
      const ctx = await contextOf(values, deps);
      const s = await ctx.seal({ request: ctx.requestFile, drillReceipt: ctx.drillReceipt, repo: ctx.request.repository });
      return { contract: ROLLOUT_CONTRACT, command: 'open', status: s?.status ?? null, confirmUrl: s?.confirmUrl ?? null, expiresAt: s?.expiresAt ?? null, code: s?.code ?? null };
    }
    if (sub !== 'run' || !values.work) usage();
    if (values.wait !== undefined && !/^\d{1,5}$/.test(values.wait)) usage();
    const ctx = { ...(await contextOf(values, deps)), work: path.resolve(values.work), waitMinutes: values.wait === undefined ? null : Number(values.wait) };
    return await run(ctx);
  } catch (e) {
    return { contract: ROLLOUT_CONTRACT, ...(sub === 'open' ? { command: 'open' } : {}), status: 'ROLLOUT_REFUSED', code: e?.code ?? 'ROLLOUT_FAILED',
      detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) };
  }
}

if (import.meta.main) {
  // the Windows PowerShell 5.1 children upgrade.mjs starts get their own module path (as upgrade.mjs's own entry does)
  process.env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  main(process.argv.slice(2)).then(r => { console.log(JSON.stringify(r)); process.exitCode = exitCodeOf(r); });
}
