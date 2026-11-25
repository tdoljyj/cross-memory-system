// After the Owner's acceptance, to every node on the accepted Source: ONE bounded command (PLAN-accept-auto-seal-20261125.md 2.3,
// phase one). The Owner's acceptance is one fleet.accept Grant approved on the Clued confirm page; nothing here takes the Owner's
// words, a hand-written Decision or its three values (there is no option for them: --decision-record is USAGE like any other).
//
//   node rollout/fleet/accept.mjs run --request <fleet-node-<v>.acceptance-request.json> [--drill-receipt <receipt.json>] --work <dir> [--wait <minutes>]
//   node rollout/fleet/accept.mjs open --request <...acceptance-request.json> [--drill-receipt <receipt.json>]
//        open: seal, asked again until the door's pending request has its confirm link, bounded by OPEN_WAIT_MINUTES (seal dispatches
//        the release workflow's fleet-accept mode, and the link exists once that run reaches the door: PLAN-accept-binding-20261125.md
//        section 3 piece C); nothing else. drill/drill-vm.ps1 -Finalize runs it for a candidate that ends PASS. Exit 0 on seal's three
//        answers with the link (WAITING_OWNER with confirmUrl, SEALED, REJECTED); no link in time: NOT_OPENED, code
//        FLEET_ACCEPTANCE_OPEN_QUEUED, exit 2 (accept.mjs run asks the same seal again and waits for it).
//
// run, three steps, each safe to run again as it is (DESK starts it in the background, like wait-pr.sh: bounded, its exit wakes DESK):
//   1. seal (publish.mjs, piece B: it opens the request at the door, or reads its answer). WAITING_OWNER (with or without the link yet;
//      FLEET_ACCEPTANCE_OPEN_QUEUED alike): asked again every 30 s, then 60, then every 120 s, until --wait minutes (default: the
//      request's expiresAt, else 24 hours) -> ROLLOUT_WAITING_OWNER with the link. REJECTED (refused or expired) -> ROLLOUT_STOPPED at
//      the acceptance: the candidate stays unaccepted, the same command again opens a new request. SEALED: on. seal throwing (the door
//      or gh unreachable: the network flaps) is a look that got no answer and is asked again on the same intervals; an input error
//      (SEAL_INPUT_ERRORS) stops at once, and errors that last SEAL_ERROR_MINUTES stop with the last code.
//   2. this node: upgrade.mjs fetch --version <v> --work <work>\node --repo <the request's>, never --allow-active-upgrade at first.
//      The note <work>\requested-<tag>.json says what this command asked of this node; a run that finds it asks upgrade.mjs nothing
//      again and only reads (status.json, current.json, the inbox archive), so a rollback is never requested again by this command (a
//      second request of the same package is the Owner's, server rule). Before each call that may request, the note is an intent
//      (the process may be lost between the request and the note): a run that finds an intent waits INTENT_GRACE_MINUTES for the
//      upgrader to show the operation, follows it if it does, and asks again only if nothing shows.
//      - FLEET_NODE_UPGRADE_REQUESTED: noted (the request's id is the upgrader's opId), then followed: upgrade\status.json read until
//        the operation is over (no op moving and either current.json has both sides on the accepted Source or status.json recent holds
//        the operation's ending); both sides on the accepted Source -> on; else ROLLOUT_STOPPED (node, outcome and code from recent).
//        A request the upgrader archived as rejected or ignored (upgrade\inbox-archive; upgrader-main.mjs intake: empty, unreadable,
//        MAX_NEW_OPS_PER_DAY) -> ROLLOUT_STOPPED ROLLOUT_REQUEST_NOT_TAKEN with the disposition, and the note goes (nothing became an
//        operation: the same command again asks again). The request still in upgrade\inbox and status.json not rewritten for
//        UPGRADER_STALE_MINUTES (the upgrader rewrites it every pass, at most IDLE_MS apart) -> ROLLOUT_STOPPED
//        ROLLOUT_UPGRADER_NOT_RUNNING; the note stays (the request is taken once CluedCIUpgrader runs; the same command follows it).
//      - FLEET_NODE_UPGRADE_IN_PROGRESS: noted as adopted (its opId) and followed the same way; a rollback of it is never requested
//        again either. An adopted operation that ends SUCCEEDED with this node not on the accepted Source was another package's: the
//        note goes and this node is asked once.
//      - FLEET_NODE_ALREADY_AT_THIS_PACKAGE: on.
//      - FLEET_NODE_UPGRADE_HAND_OVER_FIRST (this node holds ci-admission): the fleet is read; only when every other node reports the
//        accepted Source and stands unpaused is the same command given --allow-active-upgrade (never both drained: a standby that
//        failed leaves the node on duty untouched). Else ROLLOUT_WAITING_OTHER_NODES naming them; run again once they are there.
//      - any other answer (NEEDS_REINSTALL, PRECHECK_REFUSED, REFUSED): ROLLOUT_STOPPED with the node and its code.
//      Bounded: NODE_WAIT_MINUTES of reading, and never past the command's life -> ROLLOUT_IN_PROGRESS (run again).
//   3. the fleet: every registered node's last reported Source is the accepted one and none stands paused -> ROLLOUT_DONE; else
//      ROLLOUT_WAITING_OTHER_NODES with the nodes still to go (phase one: DESK runs the same upgrade.mjs fetch on TURING through Desktop
//      Commander, then this command again; plan 2.4). When only this node is still to go (the door's copy of its Source lags its
//      current.json) the fleet is read again, bounded by FLEET_SETTLE_MINUTES.
//
// Life: no longer than one request's validity (plan 2.3): the request's expiresAt from seal's first WAITING answer, else 24 hours from
// the start; every wait above ends at it.
//
// The fleet read is piece B's: rollout/fleet/accept-door.mjs readFleet({ resource }), the resource of this request file (the anonymous
// read of public.clued_fleet_accept_status_v1; when accepted it carries each registered node's name, Source and pause) -> [{ node,
// ciSourceManifestSha256, paused }] (or { nodes: [...] }). A read that is not that shape, is empty, names a node twice or lacks this
// node is unreadable: a node on duty is then never requested, and step 3 answers ROLLOUT_WAITING_OTHER_NODES with code
// ROLLOUT_FLEET_UNREADABLE, never ROLLOUT_DONE. This node's name is upgrade.mjs's (node.profile.nodeName), else the installed record's
// (record\acceptance.json node.nodeName, the profile install.mjs readNode reads).
//
// Writes only under --work (upgrade.mjs's own directory and the note). Reads upgrade\status.json, upgrade\current.json, the request file
// it put and upgrade\inbox-archive under the resident root, and record\acceptance.json (read-only, as upgrade.mjs does). One JSON line;
// exit 0 ROLLOUT_DONE, 2 waiting (Owner, other nodes, this node), 1 stopped or refused. `deps` is for tests only (a fixture root, a fake
// seal, upgrade, fleet read and clock); the command line cannot reach it.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_ROOT } from './install.mjs';
import { acceptResourceOf, readFleet } from './accept-door.mjs';
import { SEAL_INPUT_ERRORS, readRequest } from './publish.mjs';
import { Refused } from './ports.mjs';
import { tagOf } from './universal.mjs';
import { OP_MOVING, main as upgradeMain } from './upgrade.mjs';

export const ROLLOUT_CONTRACT = 'clued.independent-ci.fleet-rollout/1';
// seal()'s answers (plan section 5, the interface pieces B and C share); OPEN_QUEUED: dispatched, the door has no request yet
export const SEAL_WAITING = 'FLEET_ACCEPTANCE_WAITING_OWNER';
export const SEAL_SEALED = 'FLEET_ACCEPTANCE_SEALED';
export const SEAL_REJECTED = 'FLEET_ACCEPTANCE_REJECTED';
export const SEAL_QUEUED = 'FLEET_ACCEPTANCE_OPEN_QUEUED';
const SEAL_ANSWERS = Object.freeze([SEAL_WAITING, SEAL_SEALED, SEAL_REJECTED]);
// seal's codes that asking again cannot change: piece B's one list (publish.mjs SEAL_INPUT_ERRORS), stop at once. Any other code is asked
// again, bounded by SEAL_ERROR_MINUTES.
export { SEAL_INPUT_ERRORS };
export const POLL_MS = Object.freeze({ first: 30_000, max: 120_000 });
export const OPEN_WAIT_MINUTES = 5;          // open: the dispatched run reaches the door (PLAN-accept-binding section 3, piece C)
export const OPEN_POLL_MS = 15_000;
export const SEAL_ERROR_MINUTES = 30;        // seal failing without a break this long: stop
export const NODE_WAIT_MINUTES = 180;        // the upgrader's grant, drain and switch of one node, with room
export const UPGRADER_STALE_MINUTES = 15;    // status.json is rewritten every pass (upgrader-main.mjs IDLE_MS, 60 s)
export const INTENT_GRACE_MINUTES = 5;       // a request put by a lost process shows in status.json within a pass or two
export const FLEET_SETTLE_MINUTES = 10;      // the door's copy of this node's Source catches up with its current.json
const DAY_MS = 24 * 3600_000;
const HEX64 = /^[0-9a-f]{64}$/;
const NOT_TAKEN = Object.freeze(['rejected', 'ignored']);   // src/inbox.mjs DISPOSITIONS other than processed
const WAITING = Object.freeze(['ROLLOUT_WAITING_OWNER', 'ROLLOUT_WAITING_OTHER_NODES', 'ROLLOUT_IN_PROGRESS', 'NOT_OPENED']);

export const exitCodeOf = r => (r?.status === 'ROLLOUT_DONE' || (r?.command === 'open' && SEAL_ANSWERS.includes(r.status)) ? 0 : WAITING.includes(r?.status) ? 2 : 1);
const usage = () => { throw new Refused('USAGE'); };
const jsonOf = b => JSON.parse(Buffer.from(b).toString('utf8').replace(/^\uFEFF/, ''));
async function readJsonOrNull(file) {
  try { return jsonOf(await fs.readFile(file)); } catch { return null; }
}
async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}
const msOf = iso => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };
const nextInterval = i => Math.min(i * 2, POLL_MS.max);

// --- the defaults the command line uses (tests give their own, or reach these with the door's stand-ins: deps.sealOptions, deps.readStatus) ---
// piece B's seal() (wait 0): one look at the door; the polling is this command's. A look that finds no open request dispatches the release
// workflow once and reads for its link up to publish.mjs OPEN_WAIT_MS itself.
const sealOf = (extra = {}) => async ({ request, drillReceipt, repo }) => {
  const { seal } = await import('./publish.mjs');
  return seal({ ...extra, request, drillReceipt, repo, wait: 0 });
};
// piece B's readFleet reads the door by this request's one resource (accept-door.mjs acceptResourceOf: the request file's own sha256)
const readFleetOf = readStatus => async ({ request }) => {
  const bytes = await fs.readFile(request);
  const r = readRequest(jsonOf(bytes));
  const resource = acceptResourceOf({ repository: r.repository, version: r.version, archiveSha256: r.archive_sha256,
    requestSha256: createHash('sha256').update(bytes).digest('hex') });
  return readFleet({ resource, ...(readStatus ? { readStatus } : {}) });
};
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// This node's name: the one upgrade.mjs answered, else the installed record's node profile.
async function selfOf(ctx, named) {
  if (typeof named === 'string' && named) return named;
  const n = (await readJsonOrNull(path.join(ctx.root, 'record', 'acceptance.json')))?.node?.nodeName;
  return typeof n === 'string' && n ? n : null;
}

// The fleet as [{ node, ciSourceManifestSha256, paused }], or null when it cannot be read or says nothing about the whole fleet (never
// guessed): not that shape, empty, a node twice, or without this node.
async function fleetOf(ctx, self) {
  if (typeof self !== 'string' || !self) return null;
  try {
    const got = await ctx.readFleet({ repo: ctx.request.repository, version: ctx.request.version, request: ctx.requestFile });
    const f = Array.isArray(got) ? got : Array.isArray(got?.nodes) ? got.nodes : null;
    const ok = f !== null && f.length > 0 && f.every(n => n && typeof n.node === 'string' && n.node
      && (n.ciSourceManifestSha256 === null || HEX64.test(n.ciSourceManifestSha256 ?? '')) && typeof n.paused === 'boolean');
    if (!ok) return null;
    const names = f.map(n => n.node);
    if (new Set(names).size !== names.length || !names.includes(self)) return null;
    return f.map(n => ({ node: n.node, ciSourceManifestSha256: n.ciSourceManifestSha256, paused: n.paused }));
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
const sealFailure = e => ({ code: e?.code ?? 'ROLLOUT_SEAL_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) });
const linked = s => s?.status !== SEAL_WAITING || (typeof s.confirmUrl === 'string' && s.confirmUrl !== '');
const queued = s => s?.status === SEAL_QUEUED || (s?.status === SEAL_WAITING && !linked(s));

// 1. the acceptance: seal until the door answers, bounded
async function accept(ctx) {
  let interval = POLL_MS.first, failingSince = null, lifeSet = false, lastWaiting = null;
  const waitEnd = ctx.waitMinutes !== null ? ctx.now() + ctx.waitMinutes * 60_000 : null;
  for (;;) {
    let s = null, failed = null;
    try { s = await ctx.seal({ request: ctx.requestFile, drillReceipt: ctx.drillReceipt, repo: ctx.request.repository }); } catch (e) { failed = sealFailure(e); }
    let until;
    if (failed) {
      failingSince ??= ctx.now();
      const stop = () => ({ stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', ...failed, failingSince: new Date(failingSince).toISOString(),
        next: `fix what code names, then ${rerun(ctx)}` }) });
      if (SEAL_INPUT_ERRORS.includes(failed.code)) return stop();
      until = Math.min(waitEnd ?? Infinity, ctx.lifeEnd, failingSince + SEAL_ERROR_MINUTES * 60_000);
      if (ctx.now() + interval > until) return stop();
    } else {
      failingSince = null;
      if (s?.status === SEAL_SEALED) return { sealed: s };
      if (s?.status === SEAL_REJECTED) {
        return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: s.code ?? SEAL_REJECTED, seal: s,
          next: `the Owner did not accept (or the request expired): the candidate stays unaccepted; ${rerun(ctx)} opens a new request` }) };
      }
      if (s?.status !== SEAL_WAITING && s?.status !== SEAL_QUEUED) {
        return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: 'ROLLOUT_SEAL_ANSWER_UNKNOWN', seal: s ?? null, next: rerun(ctx) }) };
      }
      const expires = msOf(s.expiresAt);
      if (!lifeSet && expires !== null) { ctx.lifeEnd = expires; lifeSet = true; }   // the command lives no longer than the request
      lastWaiting = s;
      until = Math.min(waitEnd ?? Infinity, ctx.lifeEnd);
      if (ctx.now() + interval > until) {
        return { stop: answer(ctx, 'ROLLOUT_WAITING_OWNER', { confirmUrl: lastWaiting.confirmUrl ?? null, expiresAt: lastWaiting.expiresAt ?? null,
          ...(queued(lastWaiting) ? { code: SEAL_QUEUED } : {}), next: `the Owner approves once at confirmUrl; ${rerun(ctx)}` }) };
      }
    }
    await ctx.sleep(interval);
    interval = nextInterval(interval);
  }
}

// both sides of this node on the accepted Source (upgrade\current.json)
async function localAtTarget(ctx) {
  const cur = await readJsonOrNull(path.join(ctx.root, 'upgrade', 'current.json'));
  return cur?.ciSourceManifestSha256 === ctx.request.ciSourceManifestSha256 && cur?.linux?.ciSourceManifestSha256 === ctx.request.ciSourceManifestSha256;
}

// where the upgrader archived a request file it did not take (src/inbox.mjs dispose: <archive>\<disposition>\<ms>-<nonce>-<name>), or null
async function notTakenAs(ctx, requestFile) {
  const name = path.basename(requestFile).replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 80);
  for (const d of NOT_TAKEN) {
    let names = [];
    try { names = await fs.readdir(path.join(ctx.root, 'upgrade', 'inbox-archive', d)); } catch { names = []; }
    if (names.some(n => n.endsWith(`-${name}`))) return d;
  }
  return null;
}

const writeNote = async (ctx, note, rec) => {
  await fs.mkdir(ctx.work, { recursive: true });
  await fs.writeFile(note, JSON.stringify({ version: ctx.request.version, ciSourceManifestSha256: ctx.request.ciSourceManifestSha256, ...rec }, null, 2) + '\n');
};

// 2b. this node's operation, read until it is over (status.json), then judged on current.json. rec is the note: { requestedAt, node,
// opId, requestFile, adopted, intent }. Answers { done } | { stop } | { again } (the note goes and this node is asked once more).
async function follow(ctx, note, rec) {
  const statusFile = path.join(ctx.root, 'upgrade', 'status.json');
  const deadline = Math.min(ctx.now() + ctx.nodeWaitMinutes * 60_000, ctx.lifeEnd);
  const since = msOf(rec.requestedAt);
  const node = rec.node ?? null;
  const stopped = fields => ({ stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'node', node, statusFile, ...fields }) });
  let interval = POLL_MS.first;
  for (;;) {
    const st = await readJsonOrNull(statusFile);
    const op = st?.op ?? null;
    const moving = op !== null && OP_MOVING.includes(op.state);
    if (moving && rec.intent) {   // the request a lost process put: its operation shows; noted now
      rec = { ...rec, intent: false, adopted: true, opId: op.opId ?? null };
      await writeNote(ctx, note, rec);
    }
    const opId = rec.opId ?? rec.requestId ?? null;
    const ends = (Array.isArray(st?.recent) ? st.recent : [])
      .filter(e => (opId !== null && e?.opId === opId) || ((opId === null || !rec.adopted) && since !== null && (msOf(e?.at) ?? -Infinity) > since))   // an ending after the request (never one at the same moment: an earlier operation's)
      .sort((a, b) => (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0));
    if (!moving && await localAtTarget(ctx)) return { done: true, node };
    if (!moving && (ends.length > 0 || (rec.adopted && !rec.intent))) {
      const last = ends.at(-1) ?? null;
      if (rec.adopted && last?.outcome === 'SUCCEEDED') return { again: true };   // another package's operation ended well: not ours
      return stopped({ outcome: last?.outcome ?? null, code: last?.code ?? last?.outcome ?? 'UPGRADE_ENDED_NOT_AT_TARGET',
        next: 'this node did not reach the accepted Source (the upgrader rolled back or refused; status.json recent). Stop here: find the cause first (README 0.5); no other node is touched' });
    }
    if (!moving && rec.requestFile) {
      const disposition = await notTakenAs(ctx, rec.requestFile);
      if (disposition) {
        await fs.rm(note, { force: true });   // nothing became an operation: the same command again asks again
        return stopped({ code: 'ROLLOUT_REQUEST_NOT_TAKEN', disposition, requestFile: rec.requestFile,
          next: `the upgrader set the request aside (upgrade\\inbox-archive\\${disposition}: unreadable, or MAX_NEW_OPS_PER_DAY reached; README 0.5); then ${rerun(ctx)} asks once more` });
      }
      const written = msOf(st?.writtenAt);
      const stale = UPGRADER_STALE_MINUTES * 60_000;
      if (since !== null && ctx.now() - since >= stale && (written === null || ctx.now() - written >= stale) && await exists(rec.requestFile)) {
        return stopped({ code: 'ROLLOUT_UPGRADER_NOT_RUNNING', requestFile: rec.requestFile, writtenAt: st?.writtenAt ?? null,
          next: `CluedCIUpgrader takes nothing (the request still in upgrade\\inbox, status.json not rewritten since writtenAt): start it (README 0.5); then ${rerun(ctx)} follows the same request` });
      }
    }
    if (rec.intent && !moving && ends.length === 0 && (since === null || ctx.now() - since >= INTENT_GRACE_MINUTES * 60_000)) return { again: true };
    if (ctx.now() + interval > deadline) {
      return { stop: answer(ctx, 'ROLLOUT_IN_PROGRESS', { node, op: op && { opId: op.opId ?? null, state: op.state, phase: op.phase ?? null, confirmUrl: op.grant?.confirmUrl ?? null },
        statusFile, next: rerun(ctx) }) };
    }
    await ctx.sleep(interval);
    interval = nextInterval(interval);
  }
}

// 2. this node
async function upgradeHere(ctx) {
  const note = path.join(ctx.work, `requested-${tagOf(ctx.request.version)}.json`);
  const noted = await readJsonOrNull(note);
  if (noted) {
    const f = await follow(ctx, note, noted);   // asked once: only read
    if (!f.again) return f;
    await fs.rm(note, { force: true });
  }
  const call = async allowActive => {
    const requestedAt = new Date(ctx.now()).toISOString();
    await writeNote(ctx, note, { intent: true, requestedAt });   // a lost process leaves this, not a second request
    const a = await ctx.upgrade(['fetch', '--version', ctx.request.version, '--work', path.join(ctx.work, 'node'), '--repo', ctx.request.repository,
      ...(allowActive ? ['--allow-active-upgrade'] : [])]);
    if (a?.status !== 'FLEET_NODE_UPGRADE_REQUESTED') await fs.rm(note, { force: true });
    return { a, requestedAt };
  };
  let { a, requestedAt } = await call(false);
  if (a?.status === 'FLEET_NODE_UPGRADE_HAND_OVER_FIRST') {
    const self = await selfOf(ctx, a.node);
    const fleet = await fleetOf(ctx, self);
    if (fleet === null) return { stop: waitingOthers(ctx, null, { node: self, code: 'ROLLOUT_FLEET_UNREADABLE' }) };
    const pending = notThere(fleet.filter(n => n.node !== self), ctx.request.ciSourceManifestSha256);
    if (pending.length > 0) return { stop: waitingOthers(ctx, pending, { node: self }) };
    ({ a, requestedAt } = await call(true));   // every other node is on the accepted Source and running: the node on duty goes
  }
  if (a?.status === 'FLEET_NODE_UPGRADE_REQUESTED') {
    const rec = { node: a.node ?? null, opId: a.request?.requestId ?? null, requestId: a.request?.requestId ?? null, requestFile: a.request?.requestFile ?? null,
      packageManifestSha256: a.packageManifestSha256 ?? null, requestedAt };
    await writeNote(ctx, note, rec);
    return follow(ctx, note, rec);
  }
  if (a?.status === 'FLEET_NODE_UPGRADE_IN_PROGRESS') {
    const rec = { node: await selfOf(ctx, a.node), opId: a.op?.opId ?? null, requestedAt: new Date(ctx.now()).toISOString(), adopted: true };
    await writeNote(ctx, note, rec);   // a rollback of it is not requested again either
    const f = await follow(ctx, note, rec);
    if (!f.again) return f;
    await fs.rm(note, { force: true });
    return upgradeHere(ctx);   // the other package's operation is over: this node is asked once (no note: not adopted again)
  }
  if (a?.status === 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') return { done: true, node: a.node ?? null };
  return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'node', node: a?.node ?? null, nodeAnswer: a?.status ?? null, code: a?.code ?? a?.status ?? 'ROLLOUT_NODE_NO_ANSWER',
    detail: a?.detail ?? null, next: a?.reinstall ?? `fix what code names (README 0.3), then ${rerun(ctx)}` }) };
}

export async function run(ctx) {
  ctx.lifeEnd = ctx.now() + DAY_MS;   // until seal answers the request's own expiresAt
  const acc = await accept(ctx);
  if (acc.stop) return acc.stop;
  const here = await upgradeHere(ctx);
  if (here.stop) return here.stop;
  // 3. the fleet
  const self = await selfOf(ctx, here.node);
  const accepted = ctx.request.ciSourceManifestSha256;
  const settleEnd = Math.min(ctx.now() + FLEET_SETTLE_MINUTES * 60_000, ctx.lifeEnd);
  let interval = POLL_MS.first, fleet, pending;
  for (;;) {
    fleet = await fleetOf(ctx, self);
    if (fleet === null) return waitingOthers(ctx, null, { code: 'ROLLOUT_FLEET_UNREADABLE', acceptance: acc.sealed.acceptance ?? null });
    pending = notThere(fleet, accepted);
    // only this node, which is on the accepted Source here (step 2): the door's copy lags; read again, bounded
    if (!(pending.length === 1 && pending[0].node === self) || ctx.now() + interval > settleEnd) break;
    await ctx.sleep(interval);
    interval = nextInterval(interval);
  }
  if (pending.length > 0) return waitingOthers(ctx, pending, { acceptance: acc.sealed.acceptance ?? null });
  return answer(ctx, 'ROLLOUT_DONE', { acceptance: acc.sealed.acceptance ?? null, nodes: fleet.map(n => n.node), next: null });
}

// open: seal, asked again until the door's request has its link, bounded (the dispatched run reaches the door)
async function open(ctx) {
  const end = ctx.now() + OPEN_WAIT_MINUTES * 60_000;
  const out = (status, fields) => ({ contract: ROLLOUT_CONTRACT, command: 'open', status, confirmUrl: null, expiresAt: null, code: null, ...fields });
  let failed = null;
  for (;;) {
    let s = null;
    try { s = await ctx.seal({ request: ctx.requestFile, drillReceipt: ctx.drillReceipt, repo: ctx.request.repository }); failed = null; } catch (e) {
      failed = sealFailure(e);
      if (SEAL_INPUT_ERRORS.includes(failed.code)) return out('ROLLOUT_REFUSED', failed);
    }
    if (s && !queued(s)) return out(s.status ?? null, { confirmUrl: s.confirmUrl ?? null, expiresAt: s.expiresAt ?? null, code: s.code ?? null });
    if (ctx.now() + OPEN_POLL_MS > end) {
      return failed ? out('ROLLOUT_REFUSED', failed)
        : out('NOT_OPENED', { code: SEAL_QUEUED, expiresAt: s?.expiresAt ?? null, next: `the request is queued at the door; accept.mjs run --request ${ctx.requestFile} --work <a new directory> waits for it` });
    }
    await ctx.sleep(OPEN_POLL_MS);
  }
}

async function contextOf(values, deps) {
  if (!values.request) usage();
  const requestFile = path.resolve(values.request);
  let request;
  try { request = readRequest(jsonOf(await fs.readFile(requestFile))); } catch (e) { throw new Refused(e?.code ?? 'REQUEST_REFUSED', e?.detail ?? 'not a JSON file'); }
  return { requestFile, request, drillReceipt: values['drill-receipt'] ? path.resolve(values['drill-receipt']) : null,
    seal: deps.seal ?? sealOf(deps.sealOptions), upgrade: deps.upgrade ?? upgradeMain, readFleet: deps.readFleet ?? readFleetOf(deps.readStatus),
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
      return await open(await contextOf(values, deps));
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
