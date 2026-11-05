// Task169: pure, input-scoped scan-execution analysis. Not a production reader,
// attestation, scheduler or authorization. A check/publication is not a scan.
// A protected adapter must authenticate the original launch/terminal receipts
// and prove inventory coverage separately before using this as an alert input.
import { createHash } from 'node:crypto';

export const EXECUTION_CONTRACT = 'clued.scan-execution-observation/1';
export const NON_EXECUTION_CONTRACT = 'clued.scan-non-execution-observation/1';
export const REPORT_CONTRACT = 'clued.scan-duplicate-observation/1';
const ROLES = ['gitleaks', 'trivy', 'contract-placement'];
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const COMMON = ['contract', 'kind', 'repository', 'headSha', 'role', 'evidenceSha256'];
const EXECUTION = [...COMMON, 'sourceManifestSha256', 'provider', 'producerId', 'executionId', 'attempt', 'eventAt'];
const MAX_OBSERVATIONS = 10_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Reflection on caller-owned objects (including Proxies) can throw anything.
// Only errors created here receive a reportable, fixed module-owned code. A
// WeakMap lookup neither reads properties nor invokes traps on the thrown value.
const internalErrors = new WeakMap();
const fail = code => {
  const error = new Error(code);
  internalErrors.set(error, code);
  throw error;
};
const internalCode = (error, fallback) => internalErrors.get(error) ?? fallback;

function snapshot(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('OBSERVATION_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value), copy = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') fail('OBSERVATION_SYMBOL');
    const d = descriptors[key];
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('OBSERVATION_ACCESSOR');
    if (!['string', 'number'].includes(typeof d.value)) fail('OBSERVATION_PRIMITIVE');
    Object.defineProperty(copy, key, { value: d.value, enumerable: true });
  }
  return Object.freeze(copy);
}

function exact(value, keys) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('OBSERVATION_FIELDS');
}

function parse(value) {
  const row = snapshot(value);
  const execution = row.contract === EXECUTION_CONTRACT;
  if (!execution && row.contract !== NON_EXECUTION_CONTRACT) fail('OBSERVATION_CONTRACT');
  exact(row, execution ? EXECUTION : COMMON);
  if (COMMON.some(k => typeof row[k] !== 'string')
    || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(row.repository) || !HEX40.test(row.headSha)
    || !ROLES.includes(row.role) || !HEX64.test(row.evidenceSha256)) fail('OBSERVATION_SUBJECT');
  const repository = row.repository.toLowerCase();
  if (!execution) {
    if (!['admission', 'gate-publication', 'relay-publication', 'check-status'].includes(row.kind)) fail('NON_EXECUTION_KIND');
    return Object.freeze({ ...row, repository });
  }
  if (['sourceManifestSha256', 'provider', 'producerId', 'executionId', 'eventAt'].some(k => typeof row[k] !== 'string')
    || !['scanner-started', 'scanner-terminal'].includes(row.kind)
    || !['linux-worker', 'windows-worker', 'github-actions'].includes(row.provider)
    || !HEX64.test(row.sourceManifestSha256) || !ID.test(row.producerId) || !ID.test(row.executionId)
    || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || row.attempt > 1_000_000
    || typeof row.eventAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(row.eventAt)
    || !Number.isFinite(Date.parse(row.eventAt))) fail('EXECUTION_FIELDS');
  const normalizedTime = row.eventAt.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z');
  if (new Date(Date.parse(row.eventAt)).toISOString() !== normalizedTime) fail('EXECUTION_FIELDS');
  return Object.freeze({ ...row, repository });
}

function arrayValues(input) {
  if (!Array.isArray(input) || input.length > MAX_OBSERVATIONS) fail('OBSERVATIONS_BOUND');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(k => typeof k !== 'string'
    || (k !== 'length' && !/^(0|[1-9][0-9]*)$/.test(k)))) fail('OBSERVATIONS_FIELDS');
  const rows = [];
  for (let i = 0; i < input.length; i++) {
    const d = descriptors[String(i)];
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail('OBSERVATIONS_ACCESSOR_OR_HOLE');
    rows.push(d.value);
  }
  return rows;
}

// `sourceManifestSha256`, PR/base/claim are deliberately absent from the
// subject key. An upgrade, new base, new claim or new attempt cannot hide a
// second actual scan of the same repository/head/role.
const subjectKey = r => JSON.stringify([r.repository, r.headSha, r.role]);
// The original protected producer must provide its physical execution id;
// stage id, check name or check publication id are not this contract.
const executionKey = r => JSON.stringify([r.provider, r.producerId, r.executionId, r.attempt]);
const eventKey = r => JSON.stringify([subjectKey(r), executionKey(r), r.kind]);

export function analyzeDuplicateExecutions(observations) {
  const errors = [], groups = new Map(), proofs = new Map(), events = new Map();
  let rows;
  try { rows = arrayValues(observations); }
  catch (error) { rows = []; errors.push(internalCode(error, 'OBSERVATIONS_REFUSED')); }
  let ignoredNonExecution = 0, acceptedObservations = 0, repeatedObservations = 0;
  for (const candidate of rows) {
    let row;
    try { row = parse(candidate); }
    catch (error) { errors.push(internalCode(error, 'OBSERVATION_REFUSED')); continue; }
    const representation = JSON.stringify(Object.keys(row).sort().map(k => [k, row[k]]));
    const priorProof = proofs.get(row.evidenceSha256);
    if (priorProof && priorProof !== representation) { errors.push('PROOF_ID_CONFLICT'); continue; }
    if (priorProof) { repeatedObservations += 1; continue; }
    proofs.set(row.evidenceSha256, representation);
    if (row.contract === NON_EXECUTION_CONTRACT) { ignoredNonExecution += 1; continue; }
    const ek = eventKey(row), priorEvent = events.get(ek);
    // Two incompatible receipts for the same physical event are uncertainty,
    // not a new scan, and never silently overwrite the first observation.
    if (priorEvent && priorEvent !== representation) { errors.push('EXECUTION_EVENT_CONFLICT'); continue; }
    events.set(ek, representation);
    const key = subjectKey(row);
    if (!groups.has(key)) groups.set(key, new Map());
    const executions = groups.get(key), physical = executionKey(row);
    if (!executions.has(physical)) executions.set(physical, { source: row.sourceManifestSha256, started: null, terminal: null, proofs: [] });
    const execution = executions.get(physical);
    if (execution.source !== row.sourceManifestSha256) { errors.push('EXECUTION_SOURCE_CONFLICT'); continue; }
    const field = row.kind === 'scanner-started' ? 'started' : 'terminal';
    execution[field] = row.eventAt;
    execution.proofs.push(row.evidenceSha256);
    acceptedObservations += 1;
  }
  const subjects = [];
  for (const [key, executions] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [repository, headSha, role] = JSON.parse(key);
    for (const execution of executions.values()) {
      if (!execution.started) errors.push('START_RECEIPT_MISSING');
      if (execution.started && execution.terminal && Date.parse(execution.terminal) < Date.parse(execution.started)) errors.push('TERMINAL_PRECEDES_START');
    }
    // A trusted terminal receipt also demonstrates execution occurred, even
    // when its matching start is missing: retain it for duplicate alarms while
    // simultaneously declaring the incomplete evidence.
    subjects.push(Object.freeze({ repository, headSha, role, executionCount: executions.size,
      evidenceSha256: Object.freeze([...new Set([...executions.values()].flatMap(x => x.proofs))].sort()) }));
  }
  const duplicates = subjects.filter(x => x.executionCount > 1);
  const classification = duplicates.length ? 'DUPLICATE_EXECUTION'
    : errors.length || subjects.length === 0 ? 'INSUFFICIENT_EVIDENCE' : 'NO_DUPLICATE_OBSERVED';
  const report = { contract: REPORT_CONTRACT, classification, scope: 'SUPPLIED_OBSERVATIONS_ONLY',
    liveQualified: false, globalCoverageConfirmed: false, evidenceAuthenticationPerformed: false,
    acceptedObservations, repeatedObservations, ignoredNonExecution,
    evidenceIncomplete: errors.length > 0 || subjects.length === 0,
    reasons: Object.freeze([...new Set(errors)].sort()), subjects: Object.freeze(subjects), duplicates: Object.freeze(duplicates) };
  return Object.freeze({ ...report, reportSha256: digest(report) });
}
