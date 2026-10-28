// Node identity (resident active/standby design v0.4 sections 7.1, 7.2, 7.4 and 9 C7; DESIGN.md section 30).
// WHO this node is to the services it talks to, as the install pins it in the install receipt:
//   the node name, this node's GitHub App key (appKeyId + the public-key fingerprint appPublicKeySha256Base64),
//   its ci-admission connection (ciPrincipalBindingId + the token fingerprint ciTokenPinSha256), the formal
//   qualification refs of the install record and the Owner decision that accepted it.
// Public ids and fingerprints only: no private key, no token. ciPrincipalRoleRef is the Owner decision that this
// connection MAY hold the ci-admission role (design 7.2); whether it holds it now is only ever the role probe's answer.
// It is derived from the two install-record files (record\installation.json and record\acceptance.json) that the
// install reads from the package; the two must agree. Pure: no I/O. Fails closed with a stable code.
// install-resident.ps1 / verify-resident.ps1 (Get-NodeIdentity) are the PowerShell twins;
// test/fixtures/node-identity-cases.json holds the three to the same answers and refusal codes.
import { check, digest, HEX64, UUID } from './canonical.mjs';

export const NODE_IDENTITY_CONTRACT = 'clued.independent-ci.node-identity/1';
// The seven formal qualification refs of the install record (resident-v2/prepare-record.mjs REFS).
export const NODE_IDENTITY_REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef',
  'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef']);
export const NODE_IDENTITY_KEYS = Object.freeze(['contract', 'nodeName', 'appKeyId', 'appPublicKeySha256Base64', 'ciTokenPinSha256', 'ciPrincipalBindingId',
  'ciPrincipalRoleRef', ...NODE_IDENTITY_REFS, 'ownerDecisionRef', 'ownerReceiptRef']);
const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const KEY_FINGERPRINT = /^[A-Za-z0-9+/]{43}=$/;
const ZERO_REF = /^0{8}-/;
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const text = (re, v) => typeof v === 'string' && re.test(v);
const genuine = v => text(UUID, v) && !ZERO_REF.test(v);

// A well-formed identity (exact keys, every value in its shape).
export function validateNodeIdentity(id) {
  check(plain(id) && Object.keys(id).sort().join('|') === [...NODE_IDENTITY_KEYS].sort().join('|') && id.contract === NODE_IDENTITY_CONTRACT
    && text(NODE_NAME, id.nodeName) && Number.isSafeInteger(id.appKeyId) && id.appKeyId > 0 && text(KEY_FINGERPRINT, id.appPublicKeySha256Base64)
    && text(HEX64, id.ciTokenPinSha256) && text(UUID, id.ciPrincipalBindingId) && text(UUID, id.ciPrincipalRoleRef)
    && NODE_IDENTITY_REFS.every(k => genuine(id[k])) && text(UUID, id.ownerDecisionRef) && text(UUID, id.ownerReceiptRef), 'NODE_IDENTITY_FIELDS_REQUIRED');
  return id;
}
export const nodeIdentitySha256 = id => digest(validateNodeIdentity(id));

// installation: the parsed record\installation.json; accepted: the parsed record\acceptance.json;
// acceptanceSha256: the SHA-256 of the acceptance.json BYTES the caller read (installation.json pins it).
export function nodeIdentityOf(installation, accepted, acceptanceSha256) {
  check(plain(installation) && plain(accepted) && text(HEX64, acceptanceSha256) && plain(accepted.node) && text(NODE_NAME, accepted.node.nodeName)
    && Number.isSafeInteger(installation.appKeyId) && installation.appKeyId > 0, 'NODE_IDENTITY_FIELDS_REQUIRED');
  const id = {
    contract: NODE_IDENTITY_CONTRACT, nodeName: accepted.node.nodeName, appKeyId: installation.appKeyId,
    appPublicKeySha256Base64: installation.appPublicKeySha256Base64, ciTokenPinSha256: installation.ciTokenPinSha256,
    ciPrincipalBindingId: installation.ciPrincipalBindingId, ciPrincipalRoleRef: installation.ciPrincipalRoleRef,
    ...Object.fromEntries(NODE_IDENTITY_REFS.map(k => [k, accepted[k]])), ownerDecisionRef: accepted.ownerDecisionRef, ownerReceiptRef: accepted.ownerReceiptRef,
  };
  check(text(HEX64, installation.acceptanceSha256), 'NODE_IDENTITY_FIELDS_REQUIRED');
  validateNodeIdentity(id);
  check(installation.acceptanceSha256 === acceptanceSha256, 'NODE_IDENTITY_ACCEPTANCE_PIN_MISMATCH');
  // The two record files state the connection, the token pin, the key fingerprint and the principal qualification twice.
  check(accepted.ciPrincipalBindingId === installation.ciPrincipalBindingId && accepted.ciTokenPinSha256 === installation.ciTokenPinSha256
    && accepted.appPublicKeySha256Base64 === installation.appPublicKeySha256Base64
    && accepted.ciPrincipalQualificationRef === installation.ciPrincipalQualificationRef, 'NODE_IDENTITY_RECORDS_DISAGREE');
  return id;
}
