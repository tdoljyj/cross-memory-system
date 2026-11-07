// DSSE v1 envelope (https://github.com/secure-systems-lab/dsse/blob/master/envelope.md) over Ed25519, node:crypto only.
// Provenance attestations (L4 of the optimisation plan bf57ff10): the signing key is the EXISTING Linux result key
// (the one signActualBridgeResult uses); nothing here creates, stores or exports a key. Verification needs only a public key.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// DSSE pre-authentication encoding: "DSSEv1" SP len(type) SP type SP len(body) SP body (lengths in bytes, decimal).
export function pae(payloadType, body) {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `), type, Buffer.from(` ${body.length} `), body]);
}

// body: the exact payload bytes (a Buffer). Returns { payloadType, payload (base64), signatures: [{ keyid, sig (base64) }] }.
export function signDsse({ body, privateKey, keyId, payloadType = PAYLOAD_TYPE }) {
  if (!Buffer.isBuffer(body) || body.length === 0 || typeof keyId !== 'string' || keyId.length === 0) fail('dsse_input_invalid');
  const sig = sign(null, pae(payloadType, body), privateKey);
  return { payloadType, payload: body.toString('base64'), signatures: [{ keyid: keyId, sig: sig.toString('base64') }] };
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Verifies the envelope against a public key (PEM string or KeyObject). With `keyId` set, only signatures of that keyid count.
// Returns the payload bytes. Throws dsse_* codes; never returns on a bad signature.
export function verifyDsse({ envelope, publicKey, keyId = null }) {
  if (!plain(envelope) || typeof envelope.payloadType !== 'string' || typeof envelope.payload !== 'string' || !B64.test(envelope.payload)
    || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0 || envelope.signatures.length > 8) fail('dsse_envelope_invalid');
  const body = Buffer.from(envelope.payload, 'base64');
  if (body.length === 0 || body.toString('base64') !== envelope.payload) fail('dsse_envelope_invalid');
  let key;
  try { key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey; } catch { fail('dsse_public_key_invalid'); }
  if (key?.asymmetricKeyType !== 'ed25519') fail('dsse_public_key_invalid');
  const message = pae(envelope.payloadType, body);
  for (const s of envelope.signatures) {
    if (!plain(s) || typeof s.sig !== 'string' || !B64.test(s.sig) || (s.keyid !== undefined && typeof s.keyid !== 'string')) fail('dsse_envelope_invalid');
    if (keyId !== null && s.keyid !== keyId) continue;
    const sig = Buffer.from(s.sig, 'base64');
    if (sig.length === 64 && verify(null, message, key, sig)) return body;
  }
  return fail('dsse_signature_invalid');
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
