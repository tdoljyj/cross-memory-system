import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value) {
  return 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
}

export function createInMemoryTestHostIdentity(input) {
  invariant(input && input.host_id && input.binding_id && input.credential_id && input.tenant_id, 'TEST_HOST_IDENTITY_FIELDS_REQUIRED');
  const pair = generateKeyPairSync('ed25519');
  return Object.freeze({
    host_id: input.host_id,
    process_identity: input.process_identity,
    binding_id: input.binding_id,
    credential_id: input.credential_id,
    tenant_id: input.tenant_id,
    audience: input.audience,
    public_key: pair.publicKey,
    private_key: pair.privateKey,
    public_key_digest: 'sha256:' + createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    key_generation: 1,
    key_material_storage: 'IN_MEMORY_TEST_GENERATION_ONLY',
    shared_secret: null
  });
}

export class SignedCrossHostChannel {
  constructor(identities) {
    this.identities = new Map(identities.map((identity) => [identity.host_id, identity]));
    this.seenNonces = new Set();
    this.lastSequences = new Map();
  }

  createChallenge(sourceHostId, destinationHostId, audience) {
    const source = this.identities.get(sourceHostId);
    const destination = this.identities.get(destinationHostId);
    invariant(source && destination, 'CHANNEL_HOST_UNKNOWN');
    invariant(source.host_id !== destination.host_id, 'CHANNEL_IDENTITIES_MUST_DIFFER');
    return Object.freeze({
      challenge_id: randomBytes(16).toString('hex'),
      source_host_id: sourceHostId,
      destination_host_id: destinationHostId,
      audience,
      expires_at_ms: 120000
    });
  }

  signEnvelope(sourceHostId, input) {
    const source = this.identities.get(sourceHostId);
    invariant(source, 'CHANNEL_HOST_UNKNOWN');
    const unsigned = Object.freeze({
      schema_version: 'clued.cross-host-envelope/1',
      source_host_id: sourceHostId,
      destination_host_id: input.destination_host_id,
      audience: input.audience,
      tenant_id: source.tenant_id,
      binding_id: source.binding_id,
      credential_id: source.credential_id,
      sequence: input.sequence,
      nonce: input.nonce,
      payload_digest: digest(input.payload),
      payload: structuredClone(input.payload)
    });
    return Object.freeze({
      unsigned,
      signature: sign(null, Buffer.from(canonical(unsigned)), source.private_key).toString('base64'),
      key_generation: source.key_generation
    });
  }

  verifyEnvelope(signed, expectation) {
    const unsigned = signed.unsigned;
    const source = this.identities.get(unsigned.source_host_id);
    invariant(source, 'CHANNEL_HOST_UNKNOWN');
    invariant(unsigned.destination_host_id === expectation.destination_host_id, 'CHANNEL_DESTINATION_MISMATCH');
    invariant(unsigned.audience === expectation.audience, 'CHANNEL_AUDIENCE_MISMATCH');
    invariant(unsigned.tenant_id === expectation.tenant_id, 'CHANNEL_TENANT_MISMATCH');
    invariant(unsigned.payload_digest === digest(unsigned.payload), 'CHANNEL_PAYLOAD_DIGEST_MISMATCH');
    invariant(!this.seenNonces.has(unsigned.nonce), 'CHANNEL_REPLAY_NONCE');
    const sequenceKey = unsigned.source_host_id + '->' + unsigned.destination_host_id;
    invariant(unsigned.sequence > (this.lastSequences.get(sequenceKey) || 0), 'CHANNEL_REPLAY_SEQUENCE');
    invariant(verify(null, Buffer.from(canonical(unsigned)), source.public_key, Buffer.from(signed.signature, 'base64')), 'CHANNEL_SIGNATURE_INVALID');
    this.seenNonces.add(unsigned.nonce);
    this.lastSequences.set(sequenceKey, unsigned.sequence);
    return Object.freeze({
      status: 'VERIFIED',
      source_host_id: unsigned.source_host_id,
      binding_id: unsigned.binding_id,
      credential_id: unsigned.credential_id,
      payload: structuredClone(unsigned.payload)
    });
  }

  separationEvidence() {
    const identities = [...this.identities.values()];
    return Object.freeze({
      distinct_process_identities: new Set(identities.map((item) => item.process_identity)).size === identities.length,
      distinct_bindings: new Set(identities.map((item) => item.binding_id)).size === identities.length,
      distinct_credentials: new Set(identities.map((item) => item.credential_id)).size === identities.length,
      distinct_public_keys: new Set(identities.map((item) => item.public_key_digest)).size === identities.length,
      shared_secret_count: identities.filter((item) => item.shared_secret !== null).length
    });
  }
}
