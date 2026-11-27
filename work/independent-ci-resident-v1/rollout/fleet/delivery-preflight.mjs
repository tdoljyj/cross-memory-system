import { createHash } from 'node:crypto';

const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const eligible = new Set(['pending', 'active', 'draining']);
const inactive = new Set(['retired', 'revoked']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inactiveReason = 'FLEET_RECIPIENT_INACTIVE';
const recipientReasons = new Set([inactiveReason, 'FLEET_RECIPIENT_REBIND_PENDING',
  'FLEET_RECIPIENT_BINDING_NOT_LIVE', 'FLEET_RECIPIENT_BINDING_UNCONFIRMED']);
const positive = n => Number.isSafeInteger(n) && n >= 1;

// Compatibility with registry snapshots written before the SQL classification was added.
function legacyExclusion(row) {
  if (!eligible.has(row.state)) return inactiveReason;
  if (row.rebindPending === true) return 'FLEET_RECIPIENT_REBIND_PENDING';
  if (row.bindingLive === false) return 'FLEET_RECIPIENT_BINDING_NOT_LIVE';
  if (!positive(row.registrationVersion) || !positive(row.bindingGeneration) ||
      !hex.test(row.identityFingerprint ?? '') || row.bindingLive !== true || row.rebindPending !== false) {
    return 'FLEET_RECIPIENT_BINDING_UNCONFIRMED';
  }
  return null;
}

export function deliverySubject(request, requestSha256) {
  return Object.freeze({ repository: request.repository, scope: 'global', version: request.version, commit: request.commit,
    archiveSha256: request.archive_sha256, sourceSha256: request.ciSourceManifestSha256,
    requestSha256, kitSha256: request.firstInstallKitSha256 });
}

export const deliveryBound = (observed, expected) => observed && Object.entries(expected).every(([key, value]) => observed[key] === value);

function readRegistration(doc, candidate, now) {
  const observedAt = Date.parse(doc?.observedAt);
  if (doc?.complete !== true || typeof doc.observedAt !== 'string' || !deliveryBound(doc, { repository: candidate.repository, scope: candidate.scope }) ||
      !Number.isFinite(observedAt) || observedAt > now || now - observedAt > 15 * 60_000 || !Array.isArray(doc.nodes)) return null;
  const rows = new Map(), names = new Set();
  for (const row of doc.nodes) {
    if (!uuid.test(row?.id ?? '') || typeof row.name !== 'string' || !row.name || !(eligible.has(row.state) || inactive.has(row.state))) return null;
    const { id, name, state, registrationVersion, bindingGeneration, identityFingerprint, bindingLive, rebindPending } = row;
    const registration = { id, name, state, registrationVersion, bindingGeneration, identityFingerprint, bindingLive, rebindPending };
    if (Object.hasOwn(row, 'recipientExclusion')) {
      const reason = row.recipientExclusion;
      if (reason !== null && !recipientReasons.has(reason)) return null;
      registration.recipientExclusion = reason;
    }
    if (rows.has(id)) return null;
    if (eligible.has(state)) {
      if (names.has(name.toUpperCase())) return null;
      names.add(name.toUpperCase());
    }
    rows.set(id, registration);
  }
  return { rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), snapshotToken: doc.snapshotToken ?? null };
}

export async function fleetDeliveryPreflight({ candidate, readFleetRegistry, clock = Date.now, signal }) {
  const refused = reason => ({ status: 'UNKNOWN', reason });
  if (typeof readFleetRegistry !== 'function') return refused('FLEET_REGISTRY_READ_UNAVAILABLE');
  const read = async () => {
    try {
      signal?.throwIfAborted();
      const doc = await readFleetRegistry(candidate, { signal });
      signal?.throwIfAborted();
      return readRegistration(doc, candidate, clock());
    } catch { return null; }
  };
  const first = await read();
  if (!first) return refused('FLEET_REGISTRY_INCOMPLETE');
  const last = await read();
  const registrySha256 = digest(first.rows);
  if (!last || first.snapshotToken !== last.snapshotToken || digest(last.rows) !== registrySha256) return refused('FLEET_REGISTRY_CHANGED');
  const nodes = [], excludedNodes = [];
  for (const row of last.rows) {
    const { id, name: node, state } = row;
    const reason = Object.hasOwn(row, 'recipientExclusion') ? row.recipientExclusion : legacyExclusion(row);
    if (reason === inactiveReason) continue;
    if (reason) excludedNodes.push({ id, node, state, reason });
    else nodes.push({ id, node, state });
  }
  return { status: 'PASS', observedAt: new Date(clock()).toISOString(), registrySha256, nodes, excludedNodes };
}
