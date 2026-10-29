// The upgrade mailbox (in-place upgrade channel, Task 018da927, spec A7; frozen at /1).
//
// A mailbox of its own, apart from the resident's (mailbox.mjs needs a batchId in every request): upgrade\mailbox\requests\
// is written by the upgrader (SYSTEM), read by the companion in the Owner's session; upgrade\mailbox\responses\ is written
// by the companion and read by the upgrader and the resident. The companion only carries a request to the one frozen root
// tool (/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux) with the fixed argv built here and hands its one
// line of JSON back as is: no path, command or script travels in a request, and every argument is checked by kind.
//
// Every later companion must answer /1 exactly as here (compatibility duty, spec A7): the upgrader that reads it is frozen
// and only changes with a full reinstall.
//
// Also here, because the resident (status /7, the version-skew hold) and the upgrader both read them and the resident package
// cannot import the upgrader's files: the Linux version facts the companion keeps in responses\version-facts.json, the
// consistency function over them, the shape of upgrade\current.json, the Owner-directory upgrade-resume request (spec A11)
// and a lenient reader of upgrade\status.json (spec A5).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CODE, HEX40, HEX64, UUID, canonicalJson, check, exactKeys, isoNow, parseBoundedJson } from './canonical.mjs';
import { TEMP_PREFIX, ensureDir, exists, nonce, readBounded, sweepTemp, writeNewAtomic } from './store.mjs';

export const UPGRADE_MAILBOX_REQUEST_CONTRACT = 'clued.independent-ci.upgrade-mailbox-request/1';
export const UPGRADE_MAILBOX_RESPONSE_CONTRACT = 'clued.independent-ci.upgrade-mailbox-response/1';
export const LINUX_VERSION_FACTS_CONTRACT = 'clued.independent-ci.linux-version-facts/1';
export const GENERATION_CURRENT_CONTRACT = 'clued.independent-ci.resident-generation/1';
export const UPGRADE_STATUS_CONTRACT = 'clued.independent-ci.resident-upgrade-status/1';
export const UPGRADE_RESUME_CONTRACT = 'clued.independent-ci.resident-upgrade-resume/1';

const MIN = 60_000;
// linux-upgrade-retain (added with the review of PR-1): the RETENTION step's Linux half, the tool's `retain` (it keeps 3).
export const UPGRADE_KINDS = Object.freeze(['linux-version-facts', 'linux-upgrade-stage', 'linux-upgrade-switch', 'linux-upgrade-rollback', 'linux-upgrade-verify',
  'linux-upgrade-retain']);
export const UPGRADE_RETAIN_KEEP = 3;
// The longest a request may wait for its answer (deadline - createdAt); a request asks for no more than this.
export const UPGRADE_TIMEOUT_MS = Object.freeze({
  'linux-version-facts': 60_000,
  'linux-upgrade-stage': 20 * MIN,
  'linux-upgrade-switch': 5 * MIN,
  'linux-upgrade-rollback': 5 * MIN,
  'linux-upgrade-verify': 5 * MIN,
  'linux-upgrade-retain': 5 * MIN,
});
// The root tool's sub-command per kind.
export const UPGRADE_TOOL_SUBCOMMANDS = Object.freeze({
  'linux-version-facts': 'version-facts', 'linux-upgrade-stage': 'stage', 'linux-upgrade-switch': 'switch',
  'linux-upgrade-rollback': 'rollback', 'linux-upgrade-verify': 'verify', 'linux-upgrade-retain': 'retain',
});
export const UPGRADE_TOOL_PATH = '/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux';
export const UPGRADE_STAGED_PREFIX = '/mnt/c/ProgramData/CluedIndependentCI/resident/upgrade/staged/';

export const UPGRADE_REQUEST_MAX_BYTES = 2048;
export const UPGRADE_RESULT_MAX_BYTES = 64 * 1024;
export const UPGRADE_RESPONSE_MAX_BYTES = UPGRADE_RESULT_MAX_BYTES + 4096;
export const VERSION_FACTS_FILE = 'version-facts.json';
export const VERSION_FACTS_MAX_BYTES = 16 * 1024;
// The companion rewrites the facts this often, and at once after every switch or rollback; older than the age limit they
// are unknown (consistent() answers null).
export const VERSION_FACTS_REFRESH_MS = 5 * MIN;
export const VERSION_FACTS_MAX_AGE_MS = 15 * MIN;
// Facts dated further ahead than this are unknown too (the writer's clock is wrong).
export const VERSION_FACTS_FUTURE_MS = 5 * MIN;
export const GENERATION_CURRENT_MAX_BYTES = 8 * 1024;
export const UPGRADE_STATUS_MAX_BYTES = 64 * 1024;

export const UPGRADE_OUTCOMES = Object.freeze(['SUCCEEDED', 'SUCCEEDED_STILL_PAUSED', 'ROLLED_BACK_PAUSED', 'REFUSED', 'GRANT_REJECTED', 'GRANT_EXPIRED',
  'CANCELLED', 'STALE', 'ROLLBACK_FAILED']);
export const UPGRADE_OP_STATES = Object.freeze(['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK', ...UPGRADE_OUTCOMES]);

const GENERATION_MAX = 999_999_999; // the root tool's GEN: [1-9][0-9]{0,8}
export const isGeneration = n => Number.isSafeInteger(n) && n >= 1 && n <= GENERATION_MAX;
const ROLE = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_STATUS = /^[A-Za-z0-9_.:-]{1,64}$/;
const NONCE = /^[0-9a-f]{12,32}$/;
const isIso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- requests ----

// Exact arguments per kind; nothing else can be carried.
export function validateUpgradeArgs(kind, args) {
  check(UPGRADE_KINDS.includes(kind), 'UPGRADE_MAILBOX_KIND_REFUSED');
  const code = 'UPGRADE_MAILBOX_ARGS_REFUSED';
  switch (kind) {
    case 'linux-version-facts':
      exactKeys(args, [], code);
      break;
    case 'linux-upgrade-stage':
      exactKeys(args, ['packageManifestSha256', 'generation', 'linuxManifestSha256'], code);
      check(HEX64.test(args.packageManifestSha256) && isGeneration(args.generation) && args.generation >= 2 && HEX64.test(args.linuxManifestSha256), code);
      break;
    case 'linux-upgrade-switch':
      exactKeys(args, ['fromGeneration', 'toGeneration', 'linuxManifestSha256'], code);
      check(isGeneration(args.fromGeneration) && isGeneration(args.toGeneration) && args.toGeneration === args.fromGeneration + 1 && HEX64.test(args.linuxManifestSha256), code);
      break;
    case 'linux-upgrade-rollback':
      exactKeys(args, ['fromGeneration', 'toGeneration'], code);
      check(isGeneration(args.fromGeneration) && isGeneration(args.toGeneration) && args.toGeneration === args.fromGeneration - 1, code);
      break;
    case 'linux-upgrade-verify':
      exactKeys(args, ['generation'], code);
      check(isGeneration(args.generation), code);
      break;
    case 'linux-upgrade-retain':
      // keep goes to the tool as --keep (it takes 2..10); this channel always asks for 3.
      exactKeys(args, ['generation', 'keep'], code);
      check(isGeneration(args.generation) && args.keep === UPGRADE_RETAIN_KEEP, code);
      break;
    default:
      check(false, 'UPGRADE_MAILBOX_KIND_REFUSED');
  }
  return args;
}

export function validateUpgradeRequest(v) {
  check(isObject(v) && UPGRADE_KINDS.includes(v.kind), 'UPGRADE_MAILBOX_REQUEST_KIND_REFUSED');
  exactKeys(v, ['contract', 'requestId', 'kind', 'opId', 'createdAt', 'deadline', 'args'], 'UPGRADE_MAILBOX_REQUEST_KEYS_REFUSED');
  check(v.contract === UPGRADE_MAILBOX_REQUEST_CONTRACT && UUID.test(v.requestId ?? ''), 'UPGRADE_MAILBOX_REQUEST_IDENTITY_REFUSED');
  // Only the version facts may be asked outside an operation.
  check(v.opId === null ? v.kind === 'linux-version-facts' : (typeof v.opId === 'string' && UUID.test(v.opId)), 'UPGRADE_MAILBOX_REQUEST_OP_REFUSED');
  check(isIso(v.createdAt) && isIso(v.deadline), 'UPGRADE_MAILBOX_REQUEST_TIME_REFUSED');
  const span = Date.parse(v.deadline) - Date.parse(v.createdAt);
  check(span > 0 && span <= UPGRADE_TIMEOUT_MS[v.kind], 'UPGRADE_MAILBOX_REQUEST_TIME_REFUSED');
  validateUpgradeArgs(v.kind, v.args);
  return v;
}

// A request as the upgrader writes it. requestId may be given (a deterministic id lets a resumed step find its own request).
export function upgradeMailboxRequest({ kind, opId = null, args = {}, requestId = randomUUID(), timeoutMs = UPGRADE_TIMEOUT_MS[kind] }, clock = Date.now) {
  const now = clock();
  return validateUpgradeRequest({ contract: UPGRADE_MAILBOX_REQUEST_CONTRACT, requestId, kind, opId, createdAt: new Date(now).toISOString(),
    deadline: new Date(now + timeoutMs).toISOString(), args });
}

// The root tool's argv for one request (the companion prepends its own fixed wsl/root prefix and the tool path).
export function upgradeToolArgs(request) {
  validateUpgradeRequest(request);
  const a = request.args;
  const sub = UPGRADE_TOOL_SUBCOMMANDS[request.kind];
  switch (request.kind) {
    case 'linux-version-facts': return [sub];
    case 'linux-upgrade-stage': return [sub, '--op', request.opId, '--package', a.packageManifestSha256, '--generation', String(a.generation), '--linux-manifest', a.linuxManifestSha256];
    case 'linux-upgrade-switch': return [sub, '--op', request.opId, '--from', String(a.fromGeneration), '--to', String(a.toGeneration), '--linux-manifest', a.linuxManifestSha256];
    case 'linux-upgrade-rollback': return [sub, '--op', request.opId, '--from', String(a.fromGeneration), '--to', String(a.toGeneration)];
    case 'linux-upgrade-verify': return [sub, '--op', request.opId, '--generation', String(a.generation)];
    case 'linux-upgrade-retain': return [sub, '--op', request.opId, '--keep', String(a.keep), '--generation', String(a.generation)];
    default: return check(false, 'UPGRADE_MAILBOX_KIND_REFUSED');
  }
}

// ---- responses ----

function resultBytesOk(result) {
  if (result === null) return true;
  if (!isObject(result)) return false;
  try { return Buffer.byteLength(canonicalJson(result), 'utf8') <= UPGRADE_RESULT_MAX_BYTES; } catch { return false; }
}

export function validateUpgradeResponse(v, request) {
  exactKeys(v, ['contract', 'requestId', 'kind', 'ok', 'code', 'tool', 'result', 'observedAt'], 'UPGRADE_MAILBOX_RESPONSE_KEYS_REFUSED');
  check(v.contract === UPGRADE_MAILBOX_RESPONSE_CONTRACT && v.requestId === request.requestId && v.kind === request.kind, 'UPGRADE_MAILBOX_RESPONSE_IDENTITY_REFUSED');
  check(typeof v.ok === 'boolean' && (v.ok ? v.code === null : (typeof v.code === 'string' && CODE.test(v.code))), 'UPGRADE_MAILBOX_RESPONSE_STATUS_REFUSED');
  exactKeys(v.tool, ['exit', 'status'], 'UPGRADE_MAILBOX_RESPONSE_TOOL_REFUSED');
  check((v.tool.exit === null || (Number.isSafeInteger(v.tool.exit) && v.tool.exit >= -1 && v.tool.exit <= 255))
    && (v.tool.status === null || (typeof v.tool.status === 'string' && TOOL_STATUS.test(v.tool.status))), 'UPGRADE_MAILBOX_RESPONSE_TOOL_REFUSED');
  // Exit 0 only on success, and success only with exit 0 and the tool's own JSON.
  check(v.ok ? (v.tool.exit === 0 && v.result !== null) : v.tool.exit !== 0, 'UPGRADE_MAILBOX_RESPONSE_TOOL_REFUSED');
  check(resultBytesOk(v.result), 'UPGRADE_MAILBOX_RESPONSE_RESULT_REFUSED');
  if (v.ok && request.kind === 'linux-version-facts') validateVersionFacts(v.result);
  check(isIso(v.observedAt), 'UPGRADE_MAILBOX_RESPONSE_TIME_REFUSED');
  return v;
}

export function upgradeMailboxResponse(request, { ok, code = null, tool, result = null }, clock = Date.now) {
  return validateUpgradeResponse({ contract: UPGRADE_MAILBOX_RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok, code,
    tool: { exit: tool?.exit ?? null, status: tool?.status ?? null }, result, observedAt: isoNow(clock) }, request);
}

// The companion's mapping of the root tool's run to an answer: exit 0 and one JSON object is success; anything else is a
// refusal. The answer's code is the tool's `upgradeCode` (its A8 class code, the one the upgrader acts on) and only a code of
// this channel (UPGRADE_*); the tool's detailed `code` stays in the result as it gave it. A tool that could not be run: exit null.
export const CHANNEL_CODE = /^UPGRADE_[A-Z0-9_]{1,72}$/;
export const TOOL_NOT_RUN = 'UPGRADE_LINUX_TOOL_NOT_RUN';
export const TOOL_OUTPUT_REFUSED = 'UPGRADE_LINUX_TOOL_OUTPUT_REFUSED';
export const TOOL_FAILED = 'UPGRADE_LINUX_TOOL_FAILED';
export function responseFromTool(request, { exit, stdout }, clock = Date.now) {
  let parsed = null;
  try {
    const text = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > 0 && bytes.length <= UPGRADE_RESULT_MAX_BYTES) parsed = parseBoundedJson(bytes, UPGRADE_RESULT_MAX_BYTES);
  } catch { parsed = null; }
  const status = parsed && typeof parsed.status === 'string' && TOOL_STATUS.test(parsed.status) ? parsed.status : null;
  const exitOk = Number.isSafeInteger(exit) && exit >= -1 && exit <= 255;
  const toolExit = exitOk ? exit : null;
  if (toolExit === 0 && parsed) {
    try { return upgradeMailboxResponse(request, { ok: true, tool: { exit: 0, status }, result: parsed }, clock); } catch { /* falls through: refused */ }
    return upgradeMailboxResponse(request, { ok: false, code: TOOL_OUTPUT_REFUSED, tool: { exit: -1, status }, result: null }, clock);
  }
  const own = parsed && typeof parsed.upgradeCode === 'string' && CHANNEL_CODE.test(parsed.upgradeCode) ? parsed.upgradeCode : null;
  const code = toolExit === null ? TOOL_NOT_RUN : (own ?? (toolExit === 0 ? TOOL_OUTPUT_REFUSED : TOOL_FAILED));
  const result = parsed && resultBytesOk(parsed) ? parsed : null;
  return upgradeMailboxResponse(request, { ok: false, code, tool: { exit: toolExit === 0 ? -1 : toolExit, status }, result }, clock);
}

// ---- Linux version facts ----

export function validateVersionFacts(v) {
  const code = 'LINUX_VERSION_FACTS_REFUSED';
  exactKeys(v, ['contract', 'generation', 'ciSourceManifestSha256', 'sourceCommit', 'manifestSha256', 'roles', 'pinsOk', 'staged', 'upgradeToolSha256', 'observedAt'], code);
  check(v.contract === LINUX_VERSION_FACTS_CONTRACT, code, 'contract');
  check(v.generation === null || isGeneration(v.generation), code, 'generation');
  check(HEX64.test(v.ciSourceManifestSha256 ?? '') && (v.sourceCommit === null || HEX40.test(v.sourceCommit)) && HEX64.test(v.manifestSha256 ?? ''), code, 'digests');
  check(isObject(v.roles) && Object.keys(v.roles).length <= 8, code, 'roles');
  for (const [role, r] of Object.entries(v.roles)) {
    check(ROLE.test(role), code, 'roles');
    exactKeys(r, ['policySha256', 'qualificationSha256'], code);
    check(HEX64.test(r.policySha256 ?? '') && HEX64.test(r.qualificationSha256 ?? ''), code, 'roles');
  }
  check(typeof v.pinsOk === 'boolean', code, 'pinsOk');
  if (v.staged !== null) {
    exactKeys(v.staged, ['opId', 'generation'], code);
    check(UUID.test(v.staged.opId ?? '') && isGeneration(v.staged.generation), code, 'staged');
  }
  check(HEX64.test(v.upgradeToolSha256 ?? '') && isIso(v.observedAt), code, 'tool');
  return v;
}

export const parseVersionFacts = bytes => validateVersionFacts(parseBoundedJson(bytes, VERSION_FACTS_MAX_BYTES, 'LINUX_VERSION_FACTS_REFUSED'));

// ---- upgrade\current.json (spec A6) ----

export function validateGenerationCurrent(v) {
  const code = 'GENERATION_CURRENT_REFUSED';
  exactKeys(v, ['contract', 'generation', 'packageManifestSha256', 'residentManifestSha256', 'ciSourceManifestSha256', 'policySha256', 'installReceiptSha256',
    'stateCompat', 'linux', 'opId', 'at'], code);
  check(v.contract === GENERATION_CURRENT_CONTRACT && isGeneration(v.generation), code, 'generation');
  check((v.packageManifestSha256 === null || HEX64.test(v.packageManifestSha256)) && HEX64.test(v.residentManifestSha256 ?? '') && HEX64.test(v.ciSourceManifestSha256 ?? '')
    && HEX64.test(v.policySha256 ?? '') && HEX64.test(v.installReceiptSha256 ?? ''), code, 'digests');
  validateStateCompat(v.stateCompat, code);
  if (v.linux !== null) {
    exactKeys(v.linux, ['generation', 'manifestSha256', 'ciSourceManifestSha256'], code);
    check(isGeneration(v.linux.generation) && HEX64.test(v.linux.manifestSha256 ?? '') && HEX64.test(v.linux.ciSourceManifestSha256 ?? ''), code, 'linux');
  }
  check((v.opId === null || UUID.test(v.opId)) && isIso(v.at), code, 'op');
  return v;
}

export function validateStateCompat(s, code = 'STATE_COMPAT_REFUSED') {
  exactKeys(s, ['schema', 'readableBySchemas'], code);
  check(Number.isSafeInteger(s.schema) && s.schema >= 1 && s.schema <= 1_000_000 && Array.isArray(s.readableBySchemas) && s.readableBySchemas.length >= 1 && s.readableBySchemas.length <= 32
    && s.readableBySchemas.every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000) && new Set(s.readableBySchemas).size === s.readableBySchemas.length, code, 'stateCompat');
  return s;
}

export const parseGenerationCurrent = bytes => validateGenerationCurrent(parseBoundedJson(bytes, GENERATION_CURRENT_MAX_BYTES, 'GENERATION_CURRENT_REFUSED'));

// ---- the consistency of both halves ----

// true: both halves run the same generation and the same CI Source, the Linux manifest is the one current.json names and the
// pins hold. false: the facts are fresh and say otherwise. null: unknown (no facts, facts older than VERSION_FACTS_MAX_AGE_MS or
// dated ahead, no or unreadable current, no Linux half recorded). Never throws.
export function consistent(current, facts, now = Date.now()) {
  try {
    if (!current || !facts) return null;
    validateGenerationCurrent(current);
    validateVersionFacts(facts);
    const observed = Date.parse(facts.observedAt);
    if (!Number.isFinite(now) || now - observed > VERSION_FACTS_MAX_AGE_MS || observed - now > VERSION_FACTS_FUTURE_MS) return null;
    if (current.linux === null) return null;
    return facts.generation === current.generation && facts.ciSourceManifestSha256 === current.ciSourceManifestSha256
      && facts.manifestSha256 === current.linux.manifestSha256 && facts.pinsOk === true;
  } catch {
    return null;
  }
}

// ---- the Owner-directory upgrade-resume request (spec A11) ----

export function validateUpgradeResume(v) {
  exactKeys(v, ['contract', 'pausedSha256', 'opId', 'generation', 'requestedAt', 'nonce'], 'OWNER_REQUEST_REFUSED');
  check(v.contract === UPGRADE_RESUME_CONTRACT && HEX64.test(v.pausedSha256 ?? '') && UUID.test(v.opId ?? '') && isGeneration(v.generation)
    && isIso(v.requestedAt) && NONCE.test(v.nonce ?? ''), 'OWNER_REQUEST_REFUSED');
  return v;
}

export function upgradeResumeRequest({ pausedSha256, opId, generation, nonce: n = nonce(8) }, clock = Date.now) {
  return validateUpgradeResume({ contract: UPGRADE_RESUME_CONTRACT, pausedSha256, opId, generation, requestedAt: isoNow(clock), nonce: n });
}

// ---- a lenient reader of upgrade\status.json (spec A5) for the resident's status /7 ----

const CONFIRM_URL = /^https:\/\/[A-Za-z0-9.-]{1,200}(?::[0-9]{1,5})?\/confirm\/[0-9a-f-]{36}$/;
export function parseUpgradeStatus(bytes) {
  const v = parseBoundedJson(bytes, UPGRADE_STATUS_MAX_BYTES, 'UPGRADE_STATUS_REFUSED');
  check(v.contract === UPGRADE_STATUS_CONTRACT && isIso(v.writtenAt), 'UPGRADE_STATUS_REFUSED');
  const op = isObject(v.op) && UUID.test(v.op.opId ?? '') && UPGRADE_OP_STATES.includes(v.op.state) ? v.op : null;
  return {
    writtenAt: Date.parse(v.writtenAt),
    current: isObject(v.current) && isGeneration(v.current.generation)
      ? { generation: v.current.generation, packageManifestSha256: HEX64.test(v.current.packageManifestSha256 ?? '') ? v.current.packageManifestSha256 : null } : null,
    op: op ? {
      opId: op.opId, state: op.state,
      phase: typeof op.phase === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(op.phase) ? op.phase : null,
      since: isIso(op.phaseSince) ? Date.parse(op.phaseSince) : null,
      code: typeof op.code === 'string' && CODE.test(op.code) ? op.code : null,
      confirmUrl: typeof op.grant?.confirmUrl === 'string' && CONFIRM_URL.test(op.grant.confirmUrl) ? op.grant.confirmUrl : null,
      pausedBy: ['upgrade', 'other'].includes(op.pausedBy) ? op.pausedBy : null,
    } : null,
  };
}

// ---- a request id that a resumed step finds again: the same op, step and try give the same id ----

export function derivedRequestId(...parts) {
  const h = createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');
  // RFC 4122 layout, version 8 (custom), variant 10.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- the mailbox itself ----

// readBounded's "not finished yet" details: a writer of a whole file (writeNewAtomic) never leaves one, but a reader treats
// one as not there yet rather than refusing it (same practice as mailbox.mjs).
const UNFINISHED = new Set(['empty', 'size-changed', 'utf8', 'json']);
async function readFinished(file, maximum, code) {
  try {
    return parseBoundedJson(await readBounded(file, maximum, code), maximum, code);
  } catch (error) {
    if (error?.code === code && UNFINISHED.has(error.detail)) return null;
    throw error;
  }
}
const REQUEST_FILE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;

export class UpgradeMailbox {
  // dir: upgrade\mailbox (requests\ and responses\ under it).
  constructor(dir, clock = Date.now) {
    this.requests = path.join(dir, 'requests');
    this.responses = path.join(dir, 'responses');
    this.factsFile = path.join(this.responses, VERSION_FACTS_FILE);
    this.clock = clock;
  }

  static async open(dir, clock = Date.now) {
    const m = new UpgradeMailbox(dir, clock);
    await ensureDir(m.requests);
    await ensureDir(m.responses);
    return m;
  }

  // Each side sweeps only the directory it writes.
  sweep(side) { return sweepTemp(side === 'requests' ? this.requests : this.responses, { clock: this.clock }); }

  // Upgrader side: one new request file, written whole.
  async send({ kind, opId = null, args = {}, requestId, timeoutMs }) {
    const request = upgradeMailboxRequest({ kind, opId, args, ...(requestId ? { requestId } : {}), ...(timeoutMs ? { timeoutMs } : {}) }, this.clock);
    await writeNewAtomic(path.join(this.requests, `${request.requestId}.json`), request);
    return request;
  }

  // Upgrader side: an earlier request of this id (a resumed step), or null.
  async request(requestId) {
    check(UUID.test(requestId ?? ''), 'UPGRADE_MAILBOX_REQUEST_IDENTITY_REFUSED');
    const file = path.join(this.requests, `${requestId}.json`);
    if (!(await exists(file))) return null;
    const value = await readFinished(file, UPGRADE_REQUEST_MAX_BYTES, 'UPGRADE_MAILBOX_REQUEST_REFUSED');
    return value === null ? null : validateUpgradeRequest(value);
  }

  // Upgrader side: the answer to a request, or null while there is none.
  async poll(request) {
    const file = path.join(this.responses, `${request.requestId}.json`);
    if (!(await exists(file))) return null;
    const value = await readFinished(file, UPGRADE_RESPONSE_MAX_BYTES, 'UPGRADE_MAILBOX_RESPONSE_REFUSED');
    return value === null ? null : validateUpgradeResponse(value, request);
  }

  async await(request, sleep, pollMs = 1000) {
    while (this.clock() < Date.parse(request.deadline)) {
      const r = await this.poll(request);
      if (r) return r;
      await sleep(pollMs);
    }
    return this.poll(request); // one last look; no answer is never success
  }

  // Companion side: the unanswered requests, oldest first; an unreadable or invalid one is listed as refused (answered
  // with a refusal by the companion when its id can be read from the name).
  async pending() {
    const out = [];
    for (const name of (await fs.readdir(this.requests)).sort()) {
      if (!REQUEST_FILE.test(name)) continue;
      if (await exists(path.join(this.responses, name))) continue;
      try {
        const value = await readFinished(path.join(this.requests, name), UPGRADE_REQUEST_MAX_BYTES, 'UPGRADE_MAILBOX_REQUEST_REFUSED');
        if (value !== null) out.push(validateUpgradeRequest(value));
      } catch { out.push({ requestId: name.slice(0, 36), refused: true }); }
    }
    return out.sort((a, b) => (a.refused || b.refused) ? 0 : Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  // Companion side: one answer per request, written whole, create-only.
  async respond(request, fields) {
    const response = upgradeMailboxResponse(request, fields, this.clock);
    await writeNewAtomic(path.join(this.responses, `${request.requestId}.json`), response);
    return response;
  }

  // Companion side: the facts are replaced whole (temporary file + rename): a reader finds the old or the new file.
  async writeVersionFacts(facts) {
    validateVersionFacts(facts);
    const tmp = path.join(this.responses, `${TEMP_PREFIX}${nonce()}-${VERSION_FACTS_FILE}`);
    try {
      const handle = await fs.open(tmp, 'wx');
      try { await handle.writeFile(canonicalJson(facts) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(tmp, this.factsFile);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  // Either side: the facts, or null (none, unfinished or invalid). Staleness is consistent()'s business.
  async readVersionFacts() {
    try {
      if (!(await exists(this.factsFile))) return null;
      return parseVersionFacts(await readBounded(this.factsFile, VERSION_FACTS_MAX_BYTES, 'LINUX_VERSION_FACTS_REFUSED'));
    } catch { return null; }
  }
}
