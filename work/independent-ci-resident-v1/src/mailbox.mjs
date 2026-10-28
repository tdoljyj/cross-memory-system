// Mailbox between the CluedCIResident service (writes requests, reads responses) and the companion
// in the Owner's non-elevated logon session (reads requests, writes responses). Both directions are
// create-only files with exact shapes. Neither side treats the other's records as authority:
// the companion only transports and starts fixed, installed units; every Linux unit re-checks its own
// preconditions as root, and every Windows stage re-checks its own facts as clued-control.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODE, HEX40, HEX64, UUID, canonicalJson, check, exactKeys, isoNow, parseBoundedJson } from './canonical.mjs';
import { ensureDir, exists, readBounded, writeNew } from './store.mjs';

export const REQUEST_CONTRACT = 'clued.independent-ci.resident-companion-request/1';
// /2 (DESIGN §24, Task 8e1f07d3): every answer also says what the companion's job host found about the children of this
// request: jobTree null (each child ended on its own and its job was drained, or no child started at all), 'zero' (a child's
// job had to be ended - it outlived the limit, or the host reported a failure after it started - and no process of it was
// left) or 'unconfirmed' (the host could not show that, including a leftover not drained or no host report). A fact for the
// record only; no proof of either host rests on the companion's own tree.
// /3 (DESIGN §32, Task 25851665): also `memory`, the facts of a memory-ready answer ({ order, blocks }: the hv_sock ring order and the
// free blocks of at least that order over all zones), null in every other answer. Same practice as /2: the companion and the
// service come from one package and are installed together.
export const RESPONSE_CONTRACT = 'clued.independent-ci.resident-companion-response/3';
export const JOB_TREES = Object.freeze(['zero', 'unconfirmed']);
export const HEARTBEAT_CONTRACT = 'clued.independent-ci.resident-companion-heartbeat/1';
// Owner abort (DESIGN §6.5): the service asks the companion to stop working on ONE pending request (today only the
// bridge pump of a stage being stopped). Create-only <requestId>.cancel.json next to the request; pending() never
// lists it as a request. The companion only stops what it does for that request; it never stops or kills a unit.
// DESIGN §26 adds two reasons, both written and read: stage-ended (the Windows stage ended without success while its pump
// had not answered yet) and heartbeat-lost (the companion's heartbeat stopped while the stage ran). The companion treats
// every reason the same way (COMPANION_PUMP_CANCELLED); only the ledger's 80-owner-abort makes an Owner abort.
export const CANCEL_CONTRACT = 'clued.independent-ci.resident-companion-cancel/1';
export const CANCEL_REASONS = Object.freeze(['owner-abort', 'stage-ended', 'heartbeat-lost']);
// One pump per relay-stage request (DESIGN §26.5; r3 implementation review MINOR 1): the companion's first pump of a request
// creates <requestId>.pump.json in responses/ (create-only). A companion restarted while that pump ran finds it and starts no
// second one: no second issue transfer, no second worker start. pending() and the hint reads never list it.
export const PUMP_MARK_CONTRACT = 'clued.independent-ci.resident-companion-pump-mark/1';
export const BATCH_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const REASON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ARCHIVE_DIR = /^(failed|archive)-[0-9a-z-]{1,120}$/;
export const KINDS = Object.freeze(['build-bundle', 'prepare-workspaces', 'relay-stage', 'archive-linux', 'linux-quiescence', 'check-refs', 'archive-usage', 'pr-head', 'memory-ready']);
// memory-ready (DESIGN §32): one read of the VM's hv_sock memory facts before a scanner stage. Its answer can only delay or
// refuse that stage cleanly; it never admits or publishes anything.
// pr-head (resident quota redesign phase 2, step 1: design v0.5 §4.2): one live read of a PR (state and head) over the
// Owner's own gh login, for the run queue's supersession and falsification checks. Its answer can only stop a batch or
// re-queue a commit; it never admits anything (stage 1 does).
export const PULL_STATES = Object.freeze(['open', 'closed', 'merged']);
// Hosted hints (free-minutes design S20, §7.1): the companion's read-only observation of the GitHub-hosted
// runs of one PR head, as untrusted scheduling data (clued.independent-ci.hosted-hint/1, <= 2 KB). They are
// not request kinds: the companion writes them on its own poll, create-only, next to its answers, and the
// executor reads only the newest one of the head it is waiting for (hosted-wait.mjs#parseHint).
export const HINT_FILE = /^hosted-hint-([1-9][0-9]{0,8})-([0-9a-f]{12})-([0-9]{6})\.json$/;
export const HINT_FILE_MAX_BYTES = 2048;
const hintPrefix = (pr, headSha) => `hosted-hint-${pr}-${headSha.slice(0, 12)}-`;

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
};

export function validateRequest(v) {
  check(v && KINDS.includes(v.kind), 'MAILBOX_REQUEST_KIND_REFUSED');
  exactKeys(v, ['contract', 'requestId', 'kind', 'createdAt', 'deadline', ...REQUEST_FIELDS[v.kind]], 'MAILBOX_REQUEST_KEYS_REFUSED');
  check(v.contract === REQUEST_CONTRACT && UUID.test(v.requestId), 'MAILBOX_REQUEST_IDENTITY_REFUSED');
  check(BATCH_ID.test(v.batchId), 'MAILBOX_BATCH_ID_REFUSED');
  check(!Number.isNaN(Date.parse(v.createdAt)) && !Number.isNaN(Date.parse(v.deadline)) && Date.parse(v.deadline) > Date.parse(v.createdAt), 'MAILBOX_REQUEST_TIME_REFUSED');
  if (v.kind === 'relay-stage') check([2, 4, 6].includes(v.stage) && HEX64.test(v.jobId), 'MAILBOX_RELAY_FIELDS_REFUSED');
  if (v.kind === 'archive-linux') check(REASON.test(v.reason), 'MAILBOX_ARCHIVE_REASON_REFUSED');
  if (v.kind === 'pr-head') check(Number.isSafeInteger(v.pr) && v.pr > 0 && v.pr < 1e9, 'MAILBOX_PR_REFUSED');
  return v;
}

const PROOF_KEYS = ['linuxUnitsInactive', 'containersZero'];
export function validateResponse(v, request) {
  exactKeys(v, ['contract', 'requestId', 'kind', 'ok', 'code', 'proof', 'directory', 'verified', 'usage', 'pull', 'jobTree', 'memory', 'observedAt'], 'MAILBOX_RESPONSE_KEYS_REFUSED');
  check(v.contract === RESPONSE_CONTRACT && v.requestId === request.requestId && v.kind === request.kind, 'MAILBOX_RESPONSE_IDENTITY_REFUSED');
  check(typeof v.ok === 'boolean' && (v.code === null || (typeof v.code === 'string' && CODE.test(v.code))), 'MAILBOX_RESPONSE_STATUS_REFUSED');
  check(v.proof === null || (exactKeys(v.proof, PROOF_KEYS, 'MAILBOX_RESPONSE_PROOF_REFUSED'), PROOF_KEYS.every(k => typeof v.proof[k] === 'boolean')), 'MAILBOX_RESPONSE_PROOF_REFUSED');
  check(v.directory === null || (typeof v.directory === 'string' && ARCHIVE_DIR.test(v.directory)), 'MAILBOX_RESPONSE_DIRECTORY_REFUSED');
  check(v.verified === null || typeof v.verified === 'boolean', 'MAILBOX_RESPONSE_VERIFIED_REFUSED');
  check(v.usage === null || (exactKeys(v.usage, ['bytes', 'directories'], 'MAILBOX_RESPONSE_USAGE_REFUSED'), Number.isSafeInteger(v.usage.bytes) && v.usage.bytes >= 0 && Number.isSafeInteger(v.usage.directories) && v.usage.directories >= 0), 'MAILBOX_RESPONSE_USAGE_REFUSED');
  check(v.pull === null || (request.kind === 'pr-head' && (exactKeys(v.pull, ['number', 'state', 'headSha'], 'MAILBOX_RESPONSE_PULL_REFUSED'),
    v.pull.number === request.pr && PULL_STATES.includes(v.pull.state) && HEX40.test(v.pull.headSha ?? ''))), 'MAILBOX_RESPONSE_PULL_REFUSED');
  check(v.jobTree === null || JOB_TREES.includes(v.jobTree), 'MAILBOX_RESPONSE_JOB_TREE_REFUSED');
  check(v.memory === null || (request.kind === 'memory-ready' && (exactKeys(v.memory, ['order', 'blocks'], 'MAILBOX_RESPONSE_MEMORY_REFUSED'),
    Number.isSafeInteger(v.memory.order) && v.memory.order >= 0 && v.memory.order <= 10 && Number.isSafeInteger(v.memory.blocks) && v.memory.blocks >= 0)), 'MAILBOX_RESPONSE_MEMORY_REFUSED');
  return v;
}

// writeNew creates a mailbox file before it writes it, so the other side can find the file empty, growing, or holding
// only a prefix of its JSON (2026-10-23 10:45:42Z: a verified archive-linux answer read so was refused and HALTed batch
// 523849a6). Such a file is not there yet: null, and the next poll reads it again; one still unfinished at the request's
// deadline is no answer. A finished file is refused, as before, for its type, links, identity, size and exact shape.
const UNFINISHED = new Set(['empty', 'size-changed', 'utf8', 'json']);
async function readFinished(file, maximum, code) {
  try {
    return parseBoundedJson(await readBounded(file, maximum, code), maximum, code);
  } catch (error) {
    if (error.code === code && UNFINISHED.has(error.detail)) return null;
    throw error;
  }
}

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
    return m;
  }

  // Service side.
  async send(kind, fields, timeoutMs) {
    const now = this.clock();
    const request = validateRequest({ contract: REQUEST_CONTRACT, requestId: randomUUID(), kind, createdAt: new Date(now).toISOString(), deadline: new Date(now + timeoutMs).toISOString(), ...fields });
    await writeNew(path.join(this.requests, `${request.requestId}.json`), request);
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
      await writeNew(path.join(this.requests, `${request.requestId}.cancel.json`), { contract: CANCEL_CONTRACT, requestId: request.requestId, kind: request.kind, reason, at: isoNow(this.clock) });
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
  // cannot be written throws: no pump starts without one.
  async claimPump(request) {
    try {
      await writeNew(path.join(this.responses, `${request.requestId}.pump.json`), { contract: PUMP_MARK_CONTRACT, requestId: request.requestId, at: isoNow(this.clock) });
      return true;
    } catch (error) {
      if (error.code === 'CREATE_ONLY_TARGET_EXISTS') return false;
      throw error;
    }
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
    const response = validateResponse({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok: false, code: null, proof: null, directory: null, verified: null, usage: null, pull: null, jobTree: null, memory: null, observedAt: isoNow(this.clock), ...fields }, request);
    await writeNew(path.join(this.responses, `${request.requestId}.json`), response);
    return response;
  }

  // Companion side: one new hint file per changed observation (sequence = newest + 1, create-only).
  async writeHint(record) {
    check(record && Number.isSafeInteger(record.pr) && record.pr > 0 && record.pr < 1e9 && HEX40.test(record.headSha ?? ''), 'HOSTED_HINT_SUBJECT_INVALID');
    const bytes = Buffer.from(canonicalJson(record) + '\n', 'utf8');
    check(bytes.length <= HINT_FILE_MAX_BYTES, 'HOSTED_HINT_TOO_LARGE');
    const prefix = hintPrefix(record.pr, record.headSha);
    const seqs = (await fs.readdir(this.responses)).filter(n => n.startsWith(prefix) && HINT_FILE.test(n)).map(n => Number(HINT_FILE.exec(n)[3]));
    const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
    check(next <= 999_999, 'HOSTED_HINT_SEQUENCE_EXHAUSTED');
    const file = path.join(this.responses, `${prefix}${String(next).padStart(6, '0')}.json`);
    await writeNew(file, record);
    return file;
  }

  // Service side: the newest hint bytes for this PR head, or null. Bounded read; the caller parses.
  async latestHint(pr, headSha) {
    check(Number.isSafeInteger(pr) && pr > 0 && HEX40.test(headSha ?? ''), 'HOSTED_HINT_SUBJECT_INVALID');
    const prefix = hintPrefix(pr, headSha);
    const names = (await fs.readdir(this.responses)).filter(n => n.startsWith(prefix) && HINT_FILE.test(n)).sort();
    if (names.length === 0) return null;
    return readBounded(path.join(this.responses, names[names.length - 1]), HINT_FILE_MAX_BYTES, 'HOSTED_HINT_REFUSED');
  }

  // One beat at a time (DESIGN §26: the companion's own timer and its step() both beat): a beat asked for while one is
  // being written is that beat, so two never share the temporary file.
  async beat() {
    if (this.beating) return this.beating;
    this.beating = (async () => {
      const tmp = `${this.heartbeatFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ contract: HEARTBEAT_CONTRACT, at: this.clock() }));
      await fs.rename(tmp, this.heartbeatFile); // The heartbeat is a liveness hint, not evidence.
    })();
    try { await this.beating; } finally { this.beating = null; }
  }
}
