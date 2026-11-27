// After the Owner's acceptance, to every node on the accepted Source: ONE bounded command (PLAN-accept-auto-seal-20261125.md 2.3,
// phase one). The Owner's acceptance is one fleet.accept Grant approved on the Clued confirm page; nothing here takes the Owner's
// words, a hand-written Decision or its three values (there is no option for them: --decision-record is USAGE like any other).
//
//   node rollout/fleet/accept.mjs run --request <fleet-node-<v>.acceptance-request.json> [--drill-receipt <receipt.json>] --work <dir> [--wait <minutes>]
//   node rollout/fleet/accept.mjs open --request <...acceptance-request.json> [--drill-receipt <receipt.json>]
//        open: one seal (wait 0), nothing else (PLAN-accept-align-open-20261125 2.2): with no request open at the door seal dispatches
//        the release workflow's fleet-accept mode once and reads for its link up to publish.mjs OPEN_WAIT_MS. drill/drill-vm.ps1
//        -Finalize runs it for a candidate that ends PASS. Exit 0 on seal's answers with an Owner's side (WAITING_OWNER, which always
//        carries confirmUrl, SEALED, REJECTED); the workflow did not open it (seal's FLEET_ACCEPTANCE_NOT_OPENED): NOT_OPENED with that
//        code, exit 2. seal throwing: ROLLOUT_REFUSED; never asked again here (a second seal may dispatch a second run).
//
// run, three steps, each safe to run again as it is (DESK starts it in the background, like wait-pr.sh: bounded, its exit wakes DESK):
//   1. ONE seal that waits (publish.mjs, piece B; PLAN-accept-align-open-20261125 2.2): seal({ wait: --wait minutes, default and at most
//      publish.mjs WAIT_MAX_MINUTES, never past the command's life }) opens the request at the door when none is open (one workflow run)
//      and reads the door itself until the Owner answers, the wait runs out or the request expires; this command never polls seal.
//      WAITING_OWNER (always with the link) -> ROLLOUT_WAITING_OWNER. REJECTED -> ROLLOUT_STOPPED at the acceptance: answer rejected is
//      the Owner's final no (the door never asks again: publish a new version); answer expired, the same command again opens a new
//      request. NOT_OPENED (the workflow did not open the request seal dispatched) -> ROLLOUT_STOPPED with that code: read why in the
//      release workflow's latest fleet-accept run; this command never dispatches again. An unreadable final answer stops without a
//      link. SEALED: on. Transient errors before dispatch or a confirmed request are retried after 30 s, 60, then every 120 s, using
//      the same staging directory. Permanent refusals and errors that last SEAL_ERROR_MINUTES stop with the last code.
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
// Life: no longer than one request's validity (plan 2.3): 24 hours from the start (seal itself never waits past the request's
// expiresAt); every wait above ends at it.
//
// The fleet read is piece B's: rollout/fleet/accept-door.mjs readFleet({ resource }), the resource of this request file (the anonymous
// read of public.clued_fleet_accept_status_v1; when accepted it carries each registered node's name, Source and pause) -> [{ node,
// ciSourceManifestSha256, paused }] (or { nodes: [...] }). A read that is not that shape, is empty, names a node twice or lacks this
// node is unreadable: a node on duty is then never requested, and step 3 answers ROLLOUT_WAITING_OTHER_NODES with code
// ROLLOUT_FLEET_UNREADABLE, never ROLLOUT_DONE. This node's name is upgrade.mjs's (node.profile.nodeName), else the installed record's
// (record\acceptance.json node.nodeName, the profile install.mjs readNode reads).
//
// Writes only under --work (upgrade.mjs's own directory and the note). Reads upgrade\status.json, upgrade\current.json, the request file
// it put and upgrade\inbox-archive under the resident root, and record\acceptance.json (read-only, as upgrade.mjs does). A pending
// link is printed promptly to stderr; stdout carries the final JSON line.
// exit 0 ROLLOUT_DONE, 2 waiting (Owner, other nodes, this node), 1 stopped or refused. `deps` is for tests only (a fixture root, a fake
// seal, upgrade, fleet read and clock); the command line cannot reach it.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_ROOT } from './install.mjs';
import { acceptResourceOf, readFleet } from './accept-door.mjs';
import { OPEN_COMMAND_MS, READ_ACCEPTANCE_AGAIN, SEAL_INPUT_ERRORS, SEAL_UNREADABLE, WAIT_MAX_MINUTES, readRequest, seal } from './publish.mjs';
import { Refused } from './ports.mjs';
import { tagOf } from './universal.mjs';
import { OP_MOVING, main as upgradeMain } from './upgrade.mjs';

export const ROLLOUT_CONTRACT = 'clued.independent-ci.fleet-rollout/1';
// seal()'s four answers (plan section 5, the interface pieces B and C share); NOT_OPENED: seal's one workflow run did not open the request
// within publish.mjs OPEN_WAIT_MS (PLAN-accept-align-open-20261125 2.2)
export const SEAL_WAITING = 'FLEET_ACCEPTANCE_WAITING_OWNER';
export const SEAL_SEALED = 'FLEET_ACCEPTANCE_SEALED';
export const SEAL_REJECTED = 'FLEET_ACCEPTANCE_REJECTED';
export const SEAL_NOT_OPENED = 'FLEET_ACCEPTANCE_NOT_OPENED';
const SEAL_ANSWERS = Object.freeze([SEAL_WAITING, SEAL_SEALED, SEAL_REJECTED]);
// seal's codes that asking again cannot change: piece B's one list (publish.mjs SEAL_INPUT_ERRORS), stop at once. Any other code is asked
// again, bounded by SEAL_ERROR_MINUTES.
export { SEAL_INPUT_ERRORS };
export const POLL_MS = Object.freeze({ first: 30_000, max: 120_000 });
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
// piece B's seal() with the wait this command gives it (open: 0; run: --wait, default WAIT_MAX_MINUTES): seal reads the door itself. A
// look that finds no open request dispatches the release workflow once and reads for its link up to publish.mjs OPEN_WAIT_MS.
const sealOf = (extra = {}) => options => seal({ ...extra, ...options });
// piece B's readFleet reads the door by this request's one resource (accept-door.mjs acceptResourceOf: the request file's own sha256)
const readFleetOf = (readStatus, now) => async ({ request, deadline }) => {
  const bytes = await fs.readFile(request);
  const r = readRequest(jsonOf(bytes));
  const resource = acceptResourceOf({ repository: r.repository, version: r.version, archiveSha256: r.archive_sha256,
    requestSha256: createHash('sha256').update(bytes).digest('hex') });
  const timeoutMs = deadline - now();
  if (timeoutMs <= 0) return null;
  return readFleet({ resource, timeoutMs, ...(readStatus ? { readStatus } : {}) });
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
async function fleetOf(ctx, self, deadline) {
  if (typeof self !== 'string' || !self || ctx.now() >= deadline) return null;
  try {
    const got = await ctx.readFleet({ repo: ctx.request.repository, version: ctx.request.version, request: ctx.requestFile, deadline });
    if (ctx.now() >= deadline) return null;
    const f = Array.isArray(got) ? got : Array.isArray(got?.nodes) ? got.nodes : null;
    const ok = f !== null && f.length > 0 && f.every(n => n && typeof n.node === 'string' && n.node
      && (n.ciSourceManifestSha256 === null || HEX64.test(n.ciSourceManifestSha256 ?? '')) && typeof n.paused === 'boolean');
    if (!ok) return null;
    const names = f.map(n => n.node);
    if (new Set(names).size !== names.length || !names.includes(self)) return null;
    return f.map(n => ({ node: n.node, ciSourceManifestSha256: n.ciSourceManifestSha256, paused: n.paused,
      ...(typeof n.atSealedTarget === 'boolean' ? { atSealedTarget: n.atSealedTarget } : {}) }));
  } catch { return null; }
}
const notThere = (fleet, accepted) => fleet.filter(n => n.ciSourceManifestSha256 !== accepted || n.paused);

function answer(ctx, status, fields = {}) {
  return { contract: ROLLOUT_CONTRACT, status, version: ctx.request.version, ciSourceManifestSha256: ctx.request.ciSourceManifestSha256, ...fields };
}
const upgradeCommand = ctx => `node <upgrade.mjs> fetch --version ${ctx.request.version} --work <a new directory>`;
const rerun = ctx => `run the same accept.mjs run command again (--request ${ctx.requestFile} --work ${ctx.work})`;
function waitingOthers(ctx, pending, extra = {}) {
  const names = pending?.map(n => n.node).join(', ');
  return answer(ctx, 'ROLLOUT_WAITING_OTHER_NODES', { pending, ...extra,
    next: pending === null ? `the fleet could not be read; ${rerun(ctx)} to read it again`
      : `on ${names}: ${upgradeCommand(ctx)} (the node on duty last, with --allow-active-upgrade); then ${rerun(ctx)}` });
}
const sealFailure = e => ({ code: e?.code ?? 'ROLLOUT_SEAL_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) });
const notOpenedNext = 'the release workflow (mode fleet-accept) did not open the request: read why in its latest run, fix that';
const nodeDeadline = ctx => ({ stop: answer(ctx, 'ROLLOUT_IN_PROGRESS', { stage: 'node', code: 'FLEET_ACCEPTANCE_DEADLINE', next: rerun(ctx) }) });

// 1. the acceptance: one seal that waits for the Owner itself; asked again only when it throws, bounded
async function accept(ctx, packageDir) {
  let interval = POLL_MS.first, failingSince = null;
  const wait = Math.min(WAIT_MAX_MINUTES, ctx.waitMinutes ?? WAIT_MAX_MINUTES);
  const waitEnd = Math.min(ctx.started + wait * 60_000, ctx.lifeEnd);
  for (;;) {
    let s = null, failed = null, noRetry = false;
    try {
      s = await ctx.seal({ request: ctx.requestFile, drillReceipt: ctx.drillReceipt, repo: ctx.request.repository, wait,
        deadline: ctx.lifeEnd, waitDeadline: waitEnd, packageDir, onPending: ctx.onPending });
    } catch (e) { failed = sealFailure(e); noRetry = e?.noSealRetry === true; }
    if (!failed) {
      if (s?.status === SEAL_SEALED) return { sealed: s };
      if (s?.status === SEAL_WAITING) {
        return { stop: answer(ctx, 'ROLLOUT_WAITING_OWNER', { confirmUrl: s.confirmUrl ?? null, expiresAt: s.expiresAt ?? null,
          next: `the Owner approves once at confirmUrl; ${rerun(ctx)}` }) };
      }
      if (s?.status === SEAL_REJECTED) {
        return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: SEAL_REJECTED, answer: s.answer ?? null, seal: s,
          next: s.answer === 'expired' ? `the request ran out before the Owner answered: the candidate stays unaccepted; ${rerun(ctx)} opens a new request`
            : 'the Owner rejected this candidate, which is final (the door never asks again): it stays unaccepted; to accept, publish a new version' }) };
      }
      if (s?.status === SEAL_NOT_OPENED) {
        return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: SEAL_NOT_OPENED, dispatchedAt: s.dispatchedAt ?? null, seal: s,
          next: `${notOpenedNext}, then ${rerun(ctx)}` }) };
      }
      if (s?.status === SEAL_UNREADABLE) {
        return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: SEAL_UNREADABLE, next: s.next }) };
      }
      return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: 'ROLLOUT_SEAL_ANSWER_UNKNOWN', seal: s ?? null, next: rerun(ctx) }) };
    }
    failingSince ??= ctx.now();
    const stop = () => ({ stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', ...failed, failingSince: new Date(failingSince).toISOString(),
      next: `fix what code names, then ${rerun(ctx)}` }) });
    if (noRetry || SEAL_INPUT_ERRORS.includes(failed.code)) return stop();
    if (ctx.now() + interval > Math.min(waitEnd, failingSince + SEAL_ERROR_MINUTES * 60_000)) return stop();
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
    if (ctx.now() >= ctx.lifeEnd) return nodeDeadline(ctx);
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
async function upgradeHere(ctx, from) {
  if (ctx.now() >= ctx.lifeEnd) return nodeDeadline(ctx);
  const note = path.join(ctx.work, `requested-${tagOf(ctx.request.version)}.json`);
  const noted = await readJsonOrNull(note);
  if (noted) {
    const f = await follow(ctx, note, noted);   // asked once: only read
    if (!f.again) return f;
    await fs.rm(note, { force: true });
  }
  const call = async allowActive => {
    if (ctx.now() >= ctx.lifeEnd) return { a: null };
    const requestedAt = new Date(ctx.now()).toISOString();
    await writeNote(ctx, note, { intent: true, requestedAt });   // a lost process leaves this, not a second request
    if (ctx.now() >= ctx.lifeEnd) {
      await fs.rm(note, { force: true });
      return { a: null };
    }
    const a = await ctx.upgrade(['fetch', '--version', ctx.request.version, '--work', path.join(ctx.work, 'node'), '--repo', ctx.request.repository,
      ...(from ? ['--from', from] : []), ...(allowActive ? ['--allow-active-upgrade'] : [])],
    { deadline: ctx.lifeEnd, expectedArchiveSha256: ctx.request.archive_sha256 });
    // A child that hit the deadline may have put the request before its answer was lost. Keep the intent for readback.
    if (a?.status !== 'FLEET_NODE_UPGRADE_REQUESTED' && a?.code !== 'FLEET_ACCEPTANCE_DEADLINE') await fs.rm(note, { force: true });
    return { a, requestedAt };
  };
  let { a, requestedAt } = await call(false);
  if (a?.status === 'FLEET_NODE_UPGRADE_HAND_OVER_FIRST') {
    const self = await selfOf(ctx, a.node);
    const fleet = await fleetOf(ctx, self, ctx.lifeEnd);
    if (ctx.now() >= ctx.lifeEnd) return nodeDeadline(ctx);
    if (fleet === null) return { stop: waitingOthers(ctx, null, { node: self, code: 'ROLLOUT_FLEET_UNREADABLE' }) };
    const pending = notThere(fleet.filter(n => n.node !== self), ctx.request.ciSourceManifestSha256);
    if (pending.length > 0) return { stop: waitingOthers(ctx, pending, { node: self }) };
    ({ a, requestedAt } = await call(true));   // every other node is on the accepted Source and running: the node on duty goes
  }
  if (a === null || a?.code === 'FLEET_ACCEPTANCE_DEADLINE') return nodeDeadline(ctx);
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
    return upgradeHere(ctx, from);   // the other package's operation is over: this node is asked once (no note: not adopted again)
  }
  if (a?.status === 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') return { done: true, node: a.node ?? null };
  return { stop: answer(ctx, 'ROLLOUT_STOPPED', { stage: 'node', node: a?.node ?? null, nodeAnswer: a?.status ?? null, code: a?.code ?? a?.status ?? 'ROLLOUT_NODE_NO_ANSWER',
    detail: a?.detail ?? null, next: a?.reinstall ?? `fix what code names (README 0.3), then ${rerun(ctx)}` }) };
}

export async function run(ctx) {
  ctx.started ??= ctx.now();
  ctx.lifeEnd ??= ctx.started + DAY_MS;
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-accept-'));
  let result;
  try {
    result = await runRollout(ctx, packageDir);
  } finally {
    await fs.rm(packageDir, { recursive: true, force: true });
  }
  if (result.status === 'ROLLOUT_WAITING_OWNER' && Date.parse(result.expiresAt) <= ctx.now()) {
    return answer(ctx, 'ROLLOUT_STOPPED', { stage: 'accept', code: SEAL_UNREADABLE, next: READ_ACCEPTANCE_AGAIN });
  }
  return result;
}

async function runRollout(ctx, packageDir) {
  const acc = await accept(ctx, packageDir);
  if (acc.stop) return acc.stop;
  if (HEX64.test(acc.sealed.acceptanceSha256 ?? '')) {
    const fleet = await fleetOf(ctx, await selfOf(ctx), ctx.lifeEnd);
    if (!fleet || fleet.some(n => typeof n.atSealedTarget !== 'boolean'))
      return answer(ctx, 'ROLLOUT_WAITING_OTHER_NODES', { code: 'ROLLOUT_FLEET_UNREADABLE', next: rerun(ctx) });
    const pending = fleet.filter(n => !n.atSealedTarget || n.paused);
    if (pending.length) return answer(ctx, 'ROLLOUT_WAITING_OTHER_NODES', {
      pending, next: '等待服务端完成交班和摘牌。可原地升级的节点由 Broker 自取，其余节点等 Owner 确认重装。' });
    return answer(ctx, 'ROLLOUT_DONE', { acceptance: acc.sealed.acceptance, nodes: fleet.map(n => n.node), next: null });
  }
  const here = await upgradeHere(ctx, acc.sealed.packageDir);
  if (here.stop) return here.stop;
  // 3. the fleet
  const self = await selfOf(ctx, here.node);
  const accepted = ctx.request.ciSourceManifestSha256;
  const settleEnd = Math.min(ctx.now() + FLEET_SETTLE_MINUTES * 60_000, ctx.lifeEnd);
  let interval = POLL_MS.first, fleet, pending;
  for (;;) {
    fleet = await fleetOf(ctx, self, settleEnd);
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

// open: one seal (wait 0); its answer as it is, the workflow not opening the request as NOT_OPENED (drill-vm.ps1 reads this shape)
async function open(ctx) {
  const out = (status, fields) => ({ contract: ROLLOUT_CONTRACT, command: 'open', status, confirmUrl: null, expiresAt: null, code: null, ...fields });
  let s;
  try { s = await ctx.seal({ request: ctx.requestFile, drillReceipt: ctx.drillReceipt, repo: ctx.request.repository, wait: 0,
    deadline: ctx.lifeEnd, openOnly: true }); } catch (e) {
    return out('ROLLOUT_REFUSED', sealFailure(e));
  }
  if (s?.status === SEAL_NOT_OPENED) {
    return out('NOT_OPENED', { code: SEAL_NOT_OPENED, dispatchedAt: s.dispatchedAt ?? null,
      next: `${notOpenedNext}, then accept.mjs run --request ${ctx.requestFile} --work <a new directory> (it opens the request once more)` });
  }
  if (s?.status === SEAL_WAITING && Date.parse(s.expiresAt) <= ctx.now()) {
    return out(SEAL_UNREADABLE, { code: SEAL_UNREADABLE, next: READ_ACCEPTANCE_AGAIN });
  }
  return out(s?.status ?? null, { confirmUrl: s?.confirmUrl ?? null, expiresAt: s?.expiresAt ?? null, code: s?.code ?? null,
    ...(s?.answer ? { answer: s.answer } : {}), ...(s?.next ? { next: s.next } : {}) });
}

async function contextOf(values, deps, started, lifeEnd) {
  if (!values.request) usage();
  const requestFile = path.resolve(values.request);
  const now = deps.now ?? Date.now;
  const left = lifeEnd - now();
  if (left <= 0) throw new Refused('FLEET_ACCEPTANCE_DEADLINE');
  const signal = AbortSignal.timeout(left);
  let request;
  try { request = readRequest(jsonOf(await fs.readFile(requestFile, { signal }))); } catch (e) {
    if (signal.aborted) throw new Refused('FLEET_ACCEPTANCE_DEADLINE');
    throw new Refused(e?.code ?? 'REQUEST_REFUSED', e?.detail ?? 'not a JSON file');
  }
  return { requestFile, request, started, lifeEnd, drillReceipt: values['drill-receipt'] ? path.resolve(values['drill-receipt']) : null,
    seal: deps.seal ?? sealOf(deps.sealOptions), upgrade: deps.upgrade ?? upgradeMain, readFleet: deps.readFleet ?? readFleetOf(deps.readStatus, now),
    onPending: deps.onPending, sleep: deps.sleep ?? defaultSleep, now, root: deps.root ?? DEFAULT_ROOT, nodeWaitMinutes: deps.nodeWaitMinutes ?? NODE_WAIT_MINUTES };
}

export async function main(argv, deps = {}) {
  const started = (deps.now ?? Date.now)();
  const [sub, ...rest] = argv;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { request: { type: 'string' }, 'drill-receipt': { type: 'string' }, work: { type: 'string' }, wait: { type: 'string' } } });
    } catch { usage(); }   // any other option (a hand-written --decision-record among them) has no way in
    const { values } = parsed;
    if (sub === 'open') {
      if (values.work !== undefined || values.wait !== undefined) usage();
      return await open(await contextOf(values, deps, started, started + OPEN_COMMAND_MS));
    }
    if (sub !== 'run' || !values.work) usage();
    if (values.wait !== undefined && !/^\d{1,5}$/.test(values.wait)) usage();
    const ctx = { ...(await contextOf(values, deps, started, started + DAY_MS)), work: path.resolve(values.work), waitMinutes: values.wait === undefined ? null : Number(values.wait) };
    return await run(ctx);
  } catch (e) {
    return { contract: ROLLOUT_CONTRACT, ...(sub === 'open' ? { command: 'open' } : {}), status: 'ROLLOUT_REFUSED', code: e?.code ?? 'ROLLOUT_FAILED',
      detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) };
  }
}

if (import.meta.main) {
  // the Windows PowerShell 5.1 children upgrade.mjs starts get their own module path (as upgrade.mjs's own entry does)
  process.env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  const onPending = pending => console.error(JSON.stringify({ status: SEAL_WAITING, ...pending }));
  main(process.argv.slice(2), { onPending }).then(r => { console.log(JSON.stringify(r)); process.exitCode = exitCodeOf(r); });
}
