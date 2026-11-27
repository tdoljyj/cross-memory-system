import { createHash } from 'node:crypto';

const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxAge = 15 * 60_000;
const eligible = new Set(['active', 'draining']);
const inactive = new Set(['retired', 'revoked']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (at, now) => typeof at === 'string' && Date.parse(at) <= now && now - Date.parse(at) <= maxAge;

export function deliverySubject(request, requestSha256) {
  return Object.freeze({ repository: request.repository, scope: 'global', version: request.version, commit: request.commit,
    archiveSha256: request.archive_sha256, sourceSha256: request.ciSourceManifestSha256,
    requestSha256, kitSha256: request.firstInstallKitSha256 });
}

const bound = (observed, expected) => observed && Object.entries(expected).every(([key, value]) => observed[key] === value);
const positiveGeneration = n => Number.isSafeInteger(n) && n >= 1;
const evidenceCodes = ['currentPointer', 'installReceipt', 'linuxFacts', 'ciConnection', 'host', 'roleAndPause', 'operations'];
const upgradeCodes = ['sourceAgreement', 'frozenChannel', 'acceptanceRefs', 'supervisor'];
const reinstallCodes = ['launcher', 'acl', 'connectionCarry', 'processClearance', 'continuation'];

function verdict(checks, keys, evidence) {
  const reasons = keys.filter(key => checks?.[key] !== true);
  return { status: reasons.length ? (reasons.some(key => checks?.[key] === false) ? 'FAIL' : 'UNKNOWN') : 'PASS',
    reasons, observedAt: evidence.observedAt, evidenceSha256: evidence.evidenceSha256 };
}
function reinstallVerdict(evidence, subject) {
  const drill = evidence.drill;
  return verdict({ ...evidence.checks, drill: drill?.status === 'PASS' && bound(drill.candidate, subject) && hex.test(drill.receiptSha256 ?? '') ? true : undefined },
    [...evidenceCodes, ...reinstallCodes, 'drill'], evidence);
}

export function reinstallDeliveryProved(evidence, subject, { node, generation, receiptSha256 }, now) {
  return bound(evidence?.candidate, subject) && evidence.node === node && evidence.generation === generation
    && evidence.receiptSha256 === receiptSha256 && fresh(evidence.observedAt, now) && hex.test(evidence.evidenceSha256 ?? '')
    && reinstallVerdict(evidence, subject).status === 'PASS';
}

function registryRows(doc, candidate, now) {
  if (doc?.complete !== true || !bound(doc, { repository: candidate.repository, scope: candidate.scope }) ||
      !fresh(doc.observedAt, now) || !Array.isArray(doc.nodes)) return null;
  const rows = new Map();
  for (const row of doc.nodes) {
    if (!uuid.test(row?.id ?? '') || typeof row.name !== 'string' || !row.name || typeof row.state !== 'string') return null;
    const value = { id: row.id, name: row.name, state: row.state, generation: row.generation ?? null, version: row.version ?? null };
    if (rows.has(row.id) && digest(rows.get(row.id)) !== digest(value)) return null;
    rows.set(row.id, value);
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const unknown = reason => ({ status: 'UNKNOWN', reasons: [reason], observedAt: null, evidenceSha256: null });

export async function fleetDeliveryPreflight({ candidate, readFleetRegistry, readNodeEvidence, clock, signal }) {
  if (typeof readFleetRegistry !== 'function') return { status: 'UNKNOWN', reason: 'FLEET_REGISTRY_READ_UNAVAILABLE', nodes: [] };
  const readRegistry = async () => {
    try { return registryRows(await readFleetRegistry(candidate, { signal }), candidate, clock()); }
    catch { return null; }
  };
  const first = await readRegistry();
  if (first === null) return { status: 'UNKNOWN', reason: 'FLEET_REGISTRY_INCOMPLETE', nodes: [] };
  const rows = first.filter(row => !inactive.has(row.state));
  const nodes = await Promise.all(rows.map(async row => {
    const unproved = reason => ({ id: row.id, node: row.name, upgrade: unknown(reason), reinstall: unknown(reason) });
    if (!eligible.has(row.state) || !positiveGeneration(row.generation) || !positiveGeneration(row.version)) return unproved('NODE_REGISTRATION_UNCONFIRMED');
    if (typeof readNodeEvidence !== 'function') return unproved('NODE_EVIDENCE_READ_UNAVAILABLE');
    let e;
    try { e = await readNodeEvidence(candidate, row, { signal }); } catch { return unproved('NODE_EVIDENCE_UNAVAILABLE'); }
    if (!bound(e?.candidate, candidate) || e.nodeId !== row.id || e.node !== row.name || e.generation !== row.generation ||
        e.registrationVersion !== row.version || !fresh(e.observedAt, clock()) ||
        !hex.test(e.evidenceSha256 ?? '') || !hex.test(e.receiptSha256 ?? '')) return unproved('NODE_EVIDENCE_UNCONFIRMED');
    const upgrade = verdict(e.checks, [...evidenceCodes, ...upgradeCodes], e);
    const reinstall = reinstallVerdict(e, candidate);
    return { id: row.id, node: row.name, generation: row.generation, upgrade, reinstall };
  }));
  const last = await readRegistry();
  if (last === null || digest(first) !== digest(last)) return { status: 'UNKNOWN', reason: 'FLEET_REGISTRY_CHANGED', nodes };
  if (nodes.some(n => [n.upgrade, n.reinstall].every(v => v.status !== 'PASS' || !fresh(v.observedAt, clock())))) {
    return { status: 'FAIL', reason: 'FLEET_NODE_HAS_NO_COMPLETE_PATH', nodes };
  }
  return { status: 'PASS', observedAt: new Date(clock()).toISOString(), registrySha256: digest(last), nodes };
}
