// Mailbox between the CluedCIResident service (writes requests, reads responses) and the companion
// in the Owner's non-elevated logon session (reads requests, writes responses). Both directions are
// create-only files with exact shapes. Neither side treats the other's records as authority:
// the companion only transports and starts fixed, installed units; every Linux unit re-checks its own
// preconditions as root, and every Windows stage re-checks its own facts as clued-control.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODE, HEX40, HEX64, UUID, canonicalJson, check, exactKeys, isoNow, parseBoundedJson } from './canonical.mjs';
import { RELAY_TIMING_CONTRACT, parseRelayTiming } from './stage-timing.mjs';
import { TEMP_PREFIX, ensureDir, exists, nonce, readBounded, sweepTemp, writeNew, writeNewAtomic } from './store.mjs';

export const REQUEST_CONTRACT = 'clued.independent-ci.resident-companion-request/1';
// /2 (DESIGN §24, Task 8e1f07d3): every answer also says what the companion's job host found about the children of this
// request: jobTree null (each child ended on its own and its job was drained, or no child started at all), 'zero' (a child's
// job had to be ended - it outlived the limit, or the host reported a failure after it started - and no process of it was
// left) or 'unconfirmed' (the host could not show that, including a leftover not drained or no host report). A fact for the
// record only; no proof of either host rests on the companion's own tree.
// /3 (DESIGN §32, Task 25851665): also `memory`, the facts of a memory-ready answer ({ order, blocks }: the hv_sock ring order and the
// free blocks of at least that order over all zones), null in every other answer. Same practice as /2: the companion and the
// service come from one package and are installed together.
// /4 (DESIGN §35, Task 4aedda54): also `prune`, the facts of an archive-prune answer (the Linux spool's retention pass: what
// was deleted, what each class keeps, what the Owner's keep list protects, and why a pass stopped or was refused), null in
// every other answer. Same practice: one package, installed together.
export const RESPONSE_CONTRACT = 'clued.independent-ci.resident-companion-response/4';
export const JOB_TREES = Object.freeze(['zero', 'unconfirmed']);
export const HEARTBEAT_CONTRACT = 'clued.independent-ci.resident-companion-heartbeat/1';
// Owner abort (DESIGN §6.5): the service asks the companion to stop working on ONE pending request (today only the
// bridge pump of a stage being stopped). Create-only <requestId>.cancel.json next to the request; pending() never
// lists it as a request. The companion only stops what it does for that request; it never stops or kills a unit.
// DESIGN §26 adds two reasons, both written and read: stage-ended (the Windows stage ended without success while its pump
// had not answered yet) and heartbeat-lost (the companion's heartbeat stopped while the stage ran). The companion treats
// every reason the same way (COMPANION_PUMP_CANCELLED); only the ledger's 80-owner-abort makes an Owner abort.
export const CANCEL_CONTRACT = 'clued.independent-ci.resident-companion-cancel/1';
// 'service-stopping' (defect 8f8240ff): the service stops and gives up a retention request (archive-usage, archive-prune) it still waits for.
export const CANCEL_REASONS = Object.freeze(['owner-abort', 'stage-ended', 'heartbeat-lost', 'service-stopping']);
// One pump per relay-stage request (DESIGN §26.5; r3 implementation review MINOR 1): the companion's first pump of a request
// creates <requestId>.pump.json in responses/ (create-only). A companion restarted while that pump ran finds it and starts no
// second one: no second issue transfer, no second worker start. pending() never lists it.
export const PUMP_MARK_CONTRACT = 'clued.independent-ci.resident-companion-pump-mark/1';
export const BATCH_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const REASON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ARCHIVE_DIR = /^(failed|archive)-[0-9a-z-]{1,120}$/;
// The retention pass's archive names (retention.mjs#ARCHIVE_NAME).
const PRUNE_NAME = /^(archive|completed|failed)-[0-9A-Za-z-]{1,90}$/;
// Request deadlines of the two companion actions that are asked again after a timeout (DESIGN §44, §46). One place for the service
// (service-ports.mjs, engine-windows.mjs) and the companion's own budget: the deadline must hold every attempt the companion may make.
// archive-linux: two `start --wait` of 5 min, the archive-status reads (3 x 30 s) and slack. check-refs: a first ls-remote that ended
// within 3 min, a second of at most 5 min, and slack.
export const ARCHIVE_LINUX_REQUEST_MS = 14 * 60_000;
export const CHECK_REFS_REQUEST_MS = 9 * 60_000;
// rebuild-bundle (DESIGN §37): the companion's own 30 min bound on build-bundle.ps1 -Rebundle, and slack. The executor also reserves it
// in the authority check before a rebuild after a network wait (generation 13, DESIGN §57.3).
export const REBUILD_BUNDLE_REQUEST_MS = 35 * 60_000;
// prepare-workspaces: the companion's own 20 min bound on the unit, the quiescence reads after it, and slack. A rebuild after a network
// wait reserves it too: the workspaces follow the rebuilt bundle (review round 2, MINOR 2).
export const PREPARE_WORKSPACES_REQUEST_MS = 25 * 60_000;
export const KINDS = Object.freeze(['build-bundle', 'prepare-workspaces', 'relay-stage', 'archive-linux', 'linux-quiescence', 'check-refs', 'archive-usage', 'pr-head', 'memory-ready',
  'archive-prune', 'rebuild-bundle']);
// rebuild-bundle (Task 4012c1b9, DESIGN §37): the batch's second and last bundle (build-bundle.ps1 -Rebundle), asked only for a
// batch resumed from parking point A, right before its workspace. Its answer can only let the batch go on or end it cleanly.
// archive-prune (DESIGN §35): one retention pass of the Linux spool by the root tool, asked only between batches with no open
// batch and a fresh heartbeat. Its answer is a record for the receipt; it never admits or publishes anything.
// memory-ready (DESIGN §32): one read of the VM's hv_sock memory facts before a scanner stage. Its answer can only delay or
// refuse that stage cleanly; it never admits or publishes anything.
// pr-head (resident quota redesign phase 2, step 1: design v0.5 §4.2): one live read of a PR (state and head) over the
// Owner's own gh login, for the run queue's supersession and falsification checks. Its answer can only stop a batch or
// re-queue a commit; it never admits anything (stage 1 does).
export const PULL_STATES = Object.freeze(['open', 'closed', 'merged']);
// A pr-head answer's claim trailers (companion.mjs#claimTrailers): data the run queue compares, never authority.
export const PULL_CLAIMS_MAX = 8;
export const pullClaimsOk = c => Array.isArray(c) && c.length <= PULL_CLAIMS_MAX && c.every((x, i) => typeof x === 'string' && UUID.test(x) && (i === 0 || c[i - 1] < x));

// Exact request shapes per kind; nothing else (no path, argv, env or script) can be carried.
const REQUEST_FIELDS = {
  'build-bundle': ['batchId'],
  'prepare-workspaces': ['batchId'],
  'relay-stage': ['batchId', 'stage', 'jobId'],
  'archive-linux': ['batchId', 'reason'],
  'linux-quiescence': ['batchId'],
  // Source v2: the "no push since the bundle" gate before stage 2, and the Linux archive size (retention).
  'check-refs': ['batchId'],
  'archive-usage': ['batchId'],
  'pr-head': ['batchId', 'pr'],
  'memory-ready': ['batchId'],
  'archive-prune': ['batchId'],
  'rebuild-bundle': ['batchId'],
};

export function validateRequest(v) {
  check(v && KINDS.includes(v.kind), 'MAILBOX_REQUEST_KIND_REFUSED');
  // DESIGN 54/59: a relay-stage of a run again (stages 2, 4 and 6: every relay-stage) carries `again` (1 or 2); a first run never carries it.
  const again = v.kind === 'relay-stage' && Object.hasOwn(v, 'again');
  exactKeys(v, ['contract', 'requestId', 'kind', 'createdAt', 'deadline', ...REQUEST_FIELDS[v.kind], ...(again ? ['again'] : [])], 'MAILBOX_REQUEST_KEYS_REFUSED');
  check(v.contract === REQUEST_CONTRACT && UUID.test(v.requestId), 'MAILBOX_REQUEST_IDENTITY_REFUSED');
  check(BATCH_ID.test(v.batchId), 'MAILBOX_BATCH_ID_REFUSED');
  check(!Number.isNaN(Date.parse(v.createdAt)) && !Number.isNaN(Date.parse(v.deadline)) && Date.parse(v.deadline) > Date.parse(v.createdAt), 'MAILBOX_REQUEST_TIME_REFUSED');
  if (v.kind === 'relay-stage') check([2, 4, 6].includes(v.stage) && HEX64.test(v.jobId) && (!again || [1, 2].includes(v.again)), 'MAILBOX_RELAY_FIELDS_REFUSED');
  if (v.kind === 'archive-linux') check(REASON.test(v.reason), 'MAILBOX_ARCHIVE_REASON_REFUSED');
  if (v.kind === 'pr-head') check(Number.isSafeInteger(v.pr) && v.pr > 0 && v.pr < 1e9, 'MAILBOX_PR_REFUSED');
  return v;
}

const PROOF_KEYS = ['linuxUnitsInactive', 'containersZero'];
const count = n => Number.isSafeInteger(n) && n >= 0;
const codeOrNull = c => c === null || (typeof c === 'string' && CODE.test(c));
// The exact shape of an archive-prune answer's facts (clued-ci-resident-linux archive-prune), at most 16 deletions per pass.
export function validatePrune(p) {
  const code = 'MAILBOX_RESPONSE_PRUNE_REFUSED';
  exactKeys(p, ['rule', 'refused', 'classes', 'protected', 'deferred', 'deleted', 'deletedBytes', 'stopped', ...(p.warnings === undefined ? [] : ['warnings'])], code);
  // maxAgeDays: node governance v1 (success 14, failure 30 days); an older Linux tool sends none.
  exactKeys(p.rule, ['classBudgetBytes', 'minKeepPerClass', 'maxDeletesPerPass', ...(p.rule.maxAgeDays === undefined ? [] : ['maxAgeDays'])], code);
  check(['classBudgetBytes', 'minKeepPerClass', 'maxDeletesPerPass'].every(k => count(p.rule[k])) && p.rule.maxDeletesPerPass <= 16
    && codeOrNull(p.refused) && count(p.deferred) && count(p.deletedBytes), code);
  if (p.rule.maxAgeDays !== undefined) {
    exactKeys(p.rule.maxAgeDays, ['success', 'failure'], code);
    check(Object.values(p.rule.maxAgeDays).every(d => count(d) && d >= 1), code);
  }
  if (p.warnings !== undefined) check(Array.isArray(p.warnings) && p.warnings.length <= 4 && p.warnings.every(c => typeof c === 'string' && CODE.test(c)), code);
  check(Array.isArray(p.deleted) && p.deleted.length <= 16, code);
  for (const d of p.deleted) { exactKeys(d, ['name', 'class', 'bytes'], code); check(PRUNE_NAME.test(d.name) && ['success', 'failure'].includes(d.class) && count(d.bytes), code); }
  check(p.deletedBytes === p.deleted.reduce((a, d) => a + d.bytes, 0), code);
  if (p.classes !== null) {
    exactKeys(p.classes, ['success', 'failure'], code);
    for (const c of Object.values(p.classes)) {
      exactKeys(c, ['directories', 'bytes', 'deleteDirectories', 'deleteBytes', 'refused'], code);
      check(count(c.directories) && count(c.bytes) && count(c.deleteDirectories) && count(c.deleteBytes) && codeOrNull(c.refused), code);
    }
  }
  check(p.protected === null || (exactKeys(p.protected, ['directories', 'bytes', 'complete'], code), count(p.protected.directories) && count(p.protected.bytes) && typeof p.protected.complete === 'boolean'), code);
  check(p.stopped === null || (exactKeys(p.stopped, ['name', 'code', 'partial'], code), PRUNE_NAME.test(p.stopped.name) && CODE.test(p.stopped.code) && typeof p.stopped.partial === 'boolean'), code);
  check(p.refused === null || (p.classes === null && p.deleted.length === 0), code);
  return p;
}

export function validateResponse(v, request) {
  exactKeys(v, ['contract', 'requestId', 'kind', 'ok', 'code', 'proof', 'directory', 'verified', 'usage', 'pull', 'jobTree', 'memory', 'prune', 'observedAt'], 'MAILBOX_RESPONSE_KEYS_REFUSED');
  check(v.contract === RESPONSE_CONTRACT && v.requestId === request.requestId && v.kind === request.kind, 'MAILBOX_RESPONSE_IDENTITY_REFUSED');
  check(typeof v.ok === 'boolean' && (v.code === null || (typeof v.code === 'string' && CODE.test(v.code))), 'MAILBOX_RESPONSE_STATUS_REFUSED');
  check(v.proof === null || (exactKeys(v.proof, PROOF_KEYS, 'MAILBOX_RESPONSE_PROOF_REFUSED'), PROOF_KEYS.every(k => typeof v.proof[k] === 'boolean')), 'MAILBOX_RESPONSE_PROOF_REFUSED');
  check(v.directory === null || (typeof v.directory === 'string' && ARCHIVE_DIR.test(v.directory)), 'MAILBOX_RESPONSE_DIRECTORY_REFUSED');
  check(v.verified === null || typeof v.verified === 'boolean', 'MAILBOX_RESPONSE_VERIFIED_REFUSED');
  check(v.usage === null || (exactKeys(v.usage, ['bytes', 'directories'], 'MAILBOX_RESPONSE_USAGE_REFUSED'), Number.isSafeInteger(v.usage.bytes) && v.usage.bytes >= 0 && Number.isSafeInteger(v.usage.directories) && v.usage.directories >= 0), 'MAILBOX_RESPONSE_USAGE_REFUSED');
  // parsePull's merge-ref observation is advisory but must survive this boundary.
  // Keep legacy three-field replies; the optional fields are a typed exact SHA and
  // the body's claim trailers (sorted, unique UUIDs, at most PULL_CLAIMS_MAX: field
  // defect 2026-11-08, PR #1039), never an open-ended payload or authority to execute anything.
  check(v.pull === null || (request.kind === 'pr-head' && (exactKeys(v.pull,
    ['number', 'state', 'headSha', ...['mergeSha', 'claims'].filter(k => v.pull && Object.hasOwn(v.pull, k))], 'MAILBOX_RESPONSE_PULL_REFUSED'),
    v.pull.number === request.pr && PULL_STATES.includes(v.pull.state) && HEX40.test(v.pull.headSha ?? '') &&
    (!Object.hasOwn(v.pull, 'mergeSha') || (typeof v.pull.mergeSha === 'string' && v.pull.mergeSha.length === 40 && HEX40.test(v.pull.mergeSha))) &&
    (!Object.hasOwn(v.pull, 'claims') || pullClaimsOk(v.pull.claims)))), 'MAILBOX_RESPONSE_PULL_REFUSED');
  check(v.jobTree === null || JOB_TREES.includes(v.jobTree), 'MAILBOX_RESPONSE_JOB_TREE_REFUSED');
  check(v.memory === null || (request.kind === 'memory-ready' && (exactKeys(v.memory, ['order', 'blocks'], 'MAILBOX_RESPONSE_MEMORY_REFUSED'),
    Number.isSafeInteger(v.memory.order) && v.memory.order >= 0 && v.memory.order <= 10 && Number.isSafeInteger(v.memory.blocks) && v.memory.blocks >= 0)), 'MAILBOX_RESPONSE_MEMORY_REFUSED');
  check(v.prune === null || (request.kind === 'archive-prune' && validatePrune(v.prune)), 'MAILBOX_RESPONSE_PRUNE_REFUSED');
  return v;
}

// The mailbox writers publish a file whole (store.mjs#writeNewAtomic: a temporary name, then one rename; DESIGN §31), so a reader
// finds a file complete or not at all. Before that, writeNew created a mailbox file before it wrote it, so the other side could
// find the file empty, growing, or holding only a prefix of its JSON (2026-10-23 10:45:42Z: a verified archive-linux answer
// read so was refused and HALTed batch 523849a6). The readers keep treating such a file as not there yet - a writer of an
// earlier version may still be running during a reinstall: null, and the next poll reads it again; one still unfinished at the
// request's deadline is no answer. A finished file is refused, as before, for its type, links, identity, size and exact shape.
const UNFINISHED = new Set(['empty', 'size-changed', 'utf8', 'json']);
async function readFinishedBoth(file, maximum, code) {
  try {
    const bytes = await readBounded(file, maximum, code);
    return { bytes, value: parseBoundedJson(bytes, maximum, code) };
  } catch (error) {
    if (error.code === code && UNFINISHED.has(error.detail)) return null;
    throw error;
  }
}
async function readFinished(file, maximum, code) {
  return (await readFinishedBoth(file, maximum, code))?.value ?? null;
}
const TIMING_FILE_MAX_BYTES = 32 * 1024;

export class Mailbox {
  constructor(root, clock) {
    this.requests = path.join(root, 'requests');
    this.responses = path.join(root, 'responses');
    // The heartbeat lives in responses/ because that is the one mailbox directory the companion can write.
    this.heartbeatFile = path.join(this.responses, 'heartbeat.json');
    this.clock = clock;
  }

  static async open(root, clock = Date.now) {
    const m = new Mailbox(root, clock);
    await ensureDir(m.requests);
    await ensureDir(m.responses);
    // Temporary files of a write that a crash cut short (DESIGN §31): each side can delete only in the directory it writes.
    await sweepTemp(m.requests);
    await sweepTemp(m.responses);
    return m;
  }

  // Service side.
  async send(kind, fields, timeoutMs) {
    const now = this.clock();
    const request = validateRequest({ contract: REQUEST_CONTRACT, requestId: randomUUID(), kind, createdAt: new Date(now).toISOString(), deadline: new Date(now + timeoutMs).toISOString(), ...fields });
    await writeNewAtomic(path.join(this.requests, `${request.requestId}.json`), request);
    return request;
  }

  async poll(request) {
    const file = path.join(this.responses, `${request.requestId}.json`);
    if (!(await exists(file))) return null;
    const value = await readFinished(file, 4096, 'MAILBOX_RESPONSE_REFUSED');
    return value === null ? null : validateResponse(value, request);
  }

  async await(request, sleep, pollMs = 500) {
    while (this.clock() < Date.parse(request.deadline)) {
      const r = await this.poll(request);
      if (r) return r;
      await sleep(pollMs);
    }
    return null; // No answer is never success.
  }

  // Service side: idempotent (a cancel that already exists is the same cancel).
  async cancel(request, reason) {
    check(UUID.test(request?.requestId ?? '') && KINDS.includes(request.kind) && CANCEL_REASONS.includes(reason), 'MAILBOX_CANCEL_REFUSED');
    try {
      await writeNewAtomic(path.join(this.requests, `${request.requestId}.cancel.json`), { contract: CANCEL_CONTRACT, requestId: request.requestId, kind: request.kind, reason, at: isoNow(this.clock) });
    } catch (error) {
      if (error.code !== 'CREATE_ONLY_TARGET_EXISTS') throw error;
    }
    return true;
  }

  // Companion side: true only for a well-formed cancel of exactly this request.
  async cancelled(request) {
    const file = path.join(this.requests, `${request.requestId}.cancel.json`);
    if (!(await exists(file))) return false;
    try {
      const v = parseBoundedJson(await readBounded(file, 1024, 'MAILBOX_CANCEL_REFUSED'), 1024, 'MAILBOX_CANCEL_REFUSED');
      exactKeys(v, ['contract', 'requestId', 'kind', 'reason', 'at'], 'MAILBOX_CANCEL_REFUSED');
      return v.contract === CANCEL_CONTRACT && v.requestId === request.requestId && v.kind === request.kind && CANCEL_REASONS.includes(v.reason);
    } catch { return false; }
  }

  async heartbeat() {
    if (!(await exists(this.heartbeatFile))) return null;
    try {
      const v = parseBoundedJson(await readBounded(this.heartbeatFile, 512, 'HEARTBEAT_REFUSED'), 512, 'HEARTBEAT_REFUSED');
      exactKeys(v, ['contract', 'at'], 'HEARTBEAT_REFUSED');
      return v.contract === HEARTBEAT_CONTRACT && Number.isSafeInteger(v.at) ? { at: v.at } : null;
    } catch { return null; }
  }

  // Companion side: true for the first pump of this request, false when one already began (its mark exists). A mark that
  // cannot be written throws: no pump starts without one. The one mailbox file that stays with writeNew (DESIGN §31): the
  // exclusive create IS the claim two companions would contend for, and nobody reads its bytes (only whether it exists).
  async claimPump(request) {
    try {
      await writeNew(path.join(this.responses, `${request.requestId}.pump.json`), { contract: PUMP_MARK_CONTRACT, requestId: request.requestId, at: isoNow(this.clock) });
      return true;
    } catch (error) {
      if (error.code === 'CREATE_ONLY_TARGET_EXISTS') return false;
      throw error;
    }
  }

  // Companion side (stage timings, status /8): the relay times of one pump, written once when the pump ends, create-only and best effort
  // (a view: nothing reads it for a decision, and a pump whose record cannot be written still answers as before).
  async writeTiming(request, timing) {
    const value = { contract: RELAY_TIMING_CONTRACT, requestId: request.requestId, handoffs: timing.handoffs.slice(0, 400), rounds: timing.rounds.slice(0, 32) };
    const bytes = Buffer.byteLength(canonicalJson(value));
    check(bytes <= TIMING_FILE_MAX_BYTES, 'RELAY_TIMING_TOO_LARGE');
    await writeNewAtomic(path.join(this.responses, `${request.requestId}.timing.json`), value);
  }

  // Service side: the pump's relay times as parseRelayTiming returns them, or null (no file, torn, oversize, another request: never an error).
  async timing(request) {
    try {
      const file = path.join(this.responses, `${request.requestId}.timing.json`);
      if (!(await exists(file))) return null;
      const v = await readFinished(file, TIMING_FILE_MAX_BYTES, 'RELAY_TIMING_REFUSED');
      return v && v.requestId === request.requestId ? parseRelayTiming(v) : null;
    } catch { return null; }
  }

  // Companion side. A request the service is still writing is left out (the next pass reads it again), never refused.
  async pending() {
    const out = [];
    for (const name of (await fs.readdir(this.requests)).sort()) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const id = name.slice(0, 36);
      if (await exists(path.join(this.responses, name))) continue;
      try {
        const value = await readFinished(path.join(this.requests, name), 2048, 'MAILBOX_REQUEST_REFUSED');
        if (value !== null) out.push(validateRequest(value));
      } catch { out.push({ requestId: id, refused: true }); }
    }
    // Oldest first by the service's own createdAt, not by the random request id.
    return out.sort((a, b) => (a.refused || b.refused) ? 0 : Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async respond(request, fields) {
    const response = validateResponse({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok: false, code: null, proof: null, directory: null, verified: null, usage: null, pull: null, jobTree: null, memory: null, prune: null, observedAt: isoNow(this.clock), ...fields }, request);
    await writeNewAtomic(path.join(this.responses, `${request.requestId}.json`), response);
    return response;
  }

  // One beat at a time (DESIGN §26: the companion's own timer and its step() both beat): a beat asked for while one is
  // being written is that beat, so two never share the temporary file.
  async beat() {
    if (this.beating) return this.beating;
    this.beating = (async () => {
      const tmp = path.join(this.responses, `${TEMP_PREFIX}${nonce()}-heartbeat.json`); // swept like every other temporary name
      try {
        await fs.writeFile(tmp, JSON.stringify({ contract: HEARTBEAT_CONTRACT, at: this.clock() }));
        await fs.rename(tmp, this.heartbeatFile); // The heartbeat is a liveness hint, not evidence.
      } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
      }
    })();
    try { await this.beating; } finally { this.beating = null; }
  }
}
