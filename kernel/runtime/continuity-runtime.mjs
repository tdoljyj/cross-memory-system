function invariant(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function highestCommon(left, right) {
  return [...new Set(left)].filter((value) => right.includes(value)).sort((a, b) => String(b).localeCompare(String(a), 'en', { numeric: true }))[0] ?? null;
}

export function negotiateProtocol({ client, server }) {
  invariant(client && server && Array.isArray(client.majors) && Array.isArray(server.majors), 'NEGOTIATION_INPUT_INVALID');
  const major = highestCommon(client.majors, server.majors);
  invariant(major !== null, 'PROTOCOL_MAJOR_UNSUPPORTED');
  if (client.preferred_major !== undefined && major !== client.preferred_major) invariant(client.allow_downgrade === true, 'PROTOCOL_DOWNGRADE_NOT_AUTHORIZED');
  const profile = highestCommon(client.profiles ?? [], server.profiles ?? []);
  invariant(profile !== null, 'PROFILE_NO_COMMON_VERSION');
  const schema = highestCommon(client.schemas ?? [], server.schemas ?? []);
  invariant(schema !== null, 'SCHEMA_NO_COMMON_VERSION');
  return { major, profile, schema, decision: 'NEGOTIATED_EXACT_INTERSECTION' };
}

export class LkgRegistry {
  #records = new Map();

  accept({ key, generation, digest, issued_at: issuedAt, expires_at: expiresAt }, now) {
    invariant(typeof key === 'string' && Number.isSafeInteger(generation) && generation >= 1, 'LKG_INPUT_INVALID');
    invariant(typeof digest === 'string' && digest.length > 0, 'LKG_DIGEST_INVALID');
    invariant(Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && issuedAt <= now && now < expiresAt, 'LKG_NOT_CURRENT');
    const current = this.#records.get(key);
    if (current) {
      invariant(generation >= current.generation, 'LKG_ROLLBACK_REJECTED');
      if (generation === current.generation) invariant(digest === current.digest, 'LKG_SAME_GENERATION_DRIFT');
    }
    const record = { key, generation, digest, issued_at: issuedAt, expires_at: expiresAt };
    this.#records.set(key, record);
    return clone(record);
  }

  resolve(key, now) {
    const record = this.#records.get(key);
    invariant(record, 'LKG_MISSING');
    invariant(record.issued_at <= now && now < record.expires_at, 'LKG_TTL_EXPIRED');
    return clone(record);
  }
}

export class CheckpointPointerStore {
  #checkpoints = new Map();
  #pointer = { version: 0, digest: null };

  writeCheckpoint({ run_id: runId, expected_version: expectedVersion, state_digest: stateDigest, next_step: nextStep }) {
    invariant(typeof runId === 'string' && typeof stateDigest === 'string' && typeof nextStep === 'string', 'CHECKPOINT_INPUT_INVALID');
    const current = this.#checkpoints.get(runId) ?? { version: 0 };
    invariant(current.version === expectedVersion, 'CHECKPOINT_CAS_CONFLICT');
    const checkpoint = { run_id: runId, version: expectedVersion + 1, state_digest: stateDigest, next_step: nextStep };
    this.#checkpoints.set(runId, checkpoint);
    return clone(checkpoint);
  }

  casPointer({ expected_version: expectedVersion, next_version: nextVersion, digest, readback_digest: readbackDigest }) {
    invariant(this.#pointer.version === expectedVersion, 'POINTER_CAS_CONFLICT');
    invariant(nextVersion === expectedVersion + 1, 'POINTER_VERSION_NOT_SEQUENTIAL');
    invariant(typeof digest === 'string' && digest === readbackDigest, 'POINTER_READBACK_MISMATCH');
    this.#pointer = { version: nextVersion, digest };
    return clone(this.#pointer);
  }

  get pointer() { return clone(this.#pointer); }
}
