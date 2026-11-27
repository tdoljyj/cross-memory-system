import { createHash } from 'node:crypto';
import { packageGenerationOf } from '../../src/selfcheck.mjs';

const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxAge = 15 * 60_000;
const eligible = new Set(['pending', 'active', 'draining']);
const inactive = new Set(['retired', 'revoked']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (at, now) => typeof at === 'string' && Date.parse(at) <= now && now - Date.parse(at) <= maxAge;
const positive = n => Number.isSafeInteger(n) && n >= 1;

export function deliverySubject(request, requestSha256) {
  return Object.freeze({ repository: request.repository, scope: 'global', version: request.version, commit: request.commit,
    archiveSha256: request.archive_sha256, sourceSha256: request.ciSourceManifestSha256,
    requestSha256, kitSha256: request.firstInstallKitSha256 });
}

export const deliveryBound = (observed, expected) => observed && Object.entries(expected).every(([key, value]) => observed[key] === value);
const common = ['currentPointer', 'installReceipt', 'linuxFacts', 'ciConnection', 'host', 'roleAndPause', 'operations'];
const upgradeChecks = ['sourceAgreement', 'frozenChannel', 'acceptanceRefs', 'supervisor'];
const reinstallChecks = ['launcher', 'acl', 'connectionCarry', 'processClearance', 'continuation'];

function verdict(checks, keys, evidence) {
  const reasons = keys.filter(key => checks?.[key] !== true);
  return { status: reasons.length ? (reasons.some(key => checks?.[key] === false) ? 'FAIL' : 'UNKNOWN') : 'PASS',
    reasons, observedAt: evidence.observedAt, evidenceSha256: evidence.evidenceSha256 };
}

function reinstallVerdict(evidence, subject) {
  const result = verdict(evidence.checks, [...common, ...reinstallChecks], evidence);
  const { drill } = evidence;
  if (deliveryBound(drill?.candidate, subject) && ['PASS', 'FAIL'].includes(drill.status) && hex.test(drill.receiptSha256 ?? '')) {
    result.drill = { status: drill.status, receiptSha256: drill.receiptSha256 };
  }
  return result;
}

export function reinstallDeliveryProved(evidence, subject, { node, generation, receiptSha256 }, now) {
  return deliveryBound(evidence?.candidate, subject) && evidence.node === node && evidence.generation === generation
    && evidence.receiptSha256 === receiptSha256 && fresh(evidence.observedAt, now) && hex.test(evidence.evidenceSha256 ?? '')
    && reinstallVerdict(evidence, subject).status === 'PASS';
}

function registryRows(doc, candidate, now) {
  if (doc?.complete !== true || !deliveryBound(doc, { repository: candidate.repository, scope: candidate.scope }) ||
      !fresh(doc.observedAt, now) || !Array.isArray(doc.nodes)) return null;
  const rows = new Map(), names = new Set();
  for (const row of doc.nodes) {
    if (!uuid.test(row?.id ?? '') || typeof row.name !== 'string' || !row.name || !(eligible.has(row.state) || inactive.has(row.state))) return null;
    if (rows.has(row.id)) {
      if (digest(rows.get(row.id)) !== digest(row)) return null;
      continue;
    }
    if (!inactive.has(row.state)) {
      if (names.has(row.name.toUpperCase())) return null;
      names.add(row.name.toUpperCase());
    }
    rows.set(row.id, row);
  }
  return { rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), snapshotToken: doc.snapshotToken ?? null };
}

// Heartbeat timestamps and counters advance independently of the installed and registered identity.
function registryIdentity(rows) {
  return digest(rows.map(({ id, name, state, version, generation, registrationVersion, bindingGeneration, identityFingerprint,
    bindingLive, rebindPending, reportedSourceSha256, reportedState, serviceRunning, onDuty, mode, evidence }) =>
    [id, name, state, version, generation, registrationVersion, bindingGeneration, identityFingerprint, bindingLive,
      rebindPending, reportedSourceSha256, reportedState, serviceRunning, onDuty, mode, evidence?.packageGeneration,
      evidence?.installGeneration, evidence?.installReceiptSha256, evidence?.windowsSourceSha256, evidence?.linuxSourceSha256]));
}

function liveProblem(row, now) {
  if (!eligible.has(row.state)) return 'NODE_REGISTRATION_UNCONFIRMED';
  if (!positive(row.registrationVersion) || !positive(row.bindingGeneration) || !hex.test(row.identityFingerprint ?? '') || row.bindingLive !== true) {
    return 'NODE_BINDING_UNCONFIRMED';
  }
  if (row.rebindPending === true) return 'NODE_REBIND_IN_FLIGHT';
  if (!fresh(row.heartbeatAt, now) || !positive(row.heartbeatSequence) || row.serviceRunning !== true ||
      row.reportedState !== 'NORMAL' || !hex.test(row.reportedSourceSha256 ?? '')) return 'NODE_HEARTBEAT_NOT_READY';
  if (typeof row.onDuty !== 'boolean' || row.mode !== (row.onDuty ? 'ACTIVE' : 'STANDBY')) return 'NODE_ROLE_CONFLICT';
  return null;
}

function transitionProblem(row, now) {
  const live = liveProblem(row, now);
  if (live) return live;
  const e = row.evidence;
  if (e && (e.linuxReady === false || e.processClearance === false || e.currentHeartbeat === false || !fresh(e.observedAt, now) || e.nodeId !== row.id || e.bindingGeneration !== row.bindingGeneration || e.registrationVersion !== row.registrationVersion ||
      e.windowsSourceSha256 !== row.reportedSourceSha256 || e.linuxSourceSha256 !== row.reportedSourceSha256 ||
      e.operations === false || e.connectionCarry === false || e.acl === false)) return 'NODE_VISIBLE_EVIDENCE_CONFLICT';
  return null;
}

const unknown = reason => ({ status: 'UNKNOWN', reasons: [reason], observedAt: null, evidenceSha256: null });
const refused = (reason, nodes = [], status = 'UNKNOWN') => ({ status, reason, nodes });

export async function fleetDeliveryPreflight({ candidate, requirements, readFleetRegistry, readNodeEvidence, clock, signal }) {
  if (typeof readFleetRegistry !== 'function') return refused('FLEET_REGISTRY_READ_UNAVAILABLE');
  const readRegistry = async () => {
    try {
      signal?.throwIfAborted();
      const doc = await readFleetRegistry(candidate, { signal });
      signal?.throwIfAborted();
      return registryRows(doc, candidate, clock());
    } catch { return null; }
  };
  const firstRead = await readRegistry();
  if (firstRead === null) return refused('FLEET_REGISTRY_INCOMPLETE');
  const first = firstRead.rows;
  const rows = first.filter(row => !inactive.has(row.state));
  if (rows.length === 0) return refused('FLEET_REGISTRY_EMPTY');
  const transition = packageGenerationOf(candidate.version) === 25;
  if (transition && (rows.length !== 2 || requirements?.standardReinstall !== true)) return refused('FLEET_TRANSITION_SUBJECT_INCOMPLETE');
  const nodes = await Promise.all(rows.map(async row => {
    const unproved = reason => ({ id: row.id, node: row.name, upgrade: unknown(reason), reinstall: unknown(reason) });
    if (transition) {
      const problem = transitionProblem(row, clock());
      if (problem) return { ...unproved(problem), transition: { status: 'FAIL', reasons: [problem] } };
      return { ...unproved('GEN25_TRANSITION_ONLY'), transition: { status: 'PASS', recheckAtInstall: [
        'ciConnection', 'connectionCarry', 'acl', 'processClearance', 'continuation', 'currentPointer', 'installReceipt', 'linuxFacts', 'host',
      ] } };
    }
    const registrationVersion = row.registrationVersion ?? row.version;
    if (!eligible.has(row.state) || !positive(registrationVersion)) return unproved('NODE_REGISTRATION_UNCONFIRMED');
    const problem = row.registrationVersion === undefined ? null : liveProblem(row, clock());
    if (problem) return unproved(problem);
    if (typeof readNodeEvidence !== 'function') return unproved('NODE_EVIDENCE_READ_UNAVAILABLE');
    let e;
    try { e = await readNodeEvidence(candidate, row, { signal }); } catch { return unproved('NODE_EVIDENCE_UNAVAILABLE'); }
    if (!deliveryBound(e?.candidate, candidate) || e.nodeId !== row.id || e.node !== row.name ||
        !positive(e.generation) || (row.generation != null && e.generation !== row.generation) ||
        e.registrationVersion !== registrationVersion || (packageGenerationOf(candidate.version) ?? Infinity) < e.generation || (row.bindingGeneration !== undefined && e.bindingGeneration !== row.bindingGeneration) ||
        !fresh(e.observedAt, clock()) || !hex.test(e.evidenceSha256 ?? '') || !hex.test(e.receiptSha256 ?? '')) {
      return unproved('NODE_EVIDENCE_UNCONFIRMED');
    }
    const upgrade = verdict(e.checks, [...common, ...upgradeChecks], e);
    return { id: row.id, node: row.name, generation: e.generation, upgrade, reinstall: reinstallVerdict(e, candidate) };
  }));
  const lastRead = await readRegistry();
  if (lastRead === null || firstRead.snapshotToken !== lastRead.snapshotToken || registryIdentity(first) !== registryIdentity(lastRead.rows)) return refused('FLEET_REGISTRY_CHANGED', nodes);
  const last = lastRead.rows;
  const lastLive = last.filter(row => !inactive.has(row.state));
  if (transition) {
    if (nodes.some(n => n.transition.status !== 'PASS') || lastLive.some(row => transitionProblem(row, clock())) ||
        lastLive.filter(row => row.onDuty).length !== 1) return refused('FLEET_TRANSITION_NODE_NOT_READY', nodes, 'FAIL');
  } else if (nodes.some(n => [n.upgrade, n.reinstall].every(v => v.status !== 'PASS' || !fresh(v.observedAt, clock()))) ||
      lastLive.some(row => row.registrationVersion !== undefined && liveProblem(row, clock()))) {
    return refused('FLEET_NODE_HAS_NO_COMPLETE_PATH', nodes, 'FAIL');
  }
  return { status: transition ? 'TRANSITION_PASS' : 'PASS', observedAt: new Date(clock()).toISOString(), registrySha256: registryIdentity(last), nodes };
}
