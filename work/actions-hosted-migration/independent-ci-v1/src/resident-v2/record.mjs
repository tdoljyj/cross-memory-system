// Validation of the claim-free install record (resident\record\*) for every Source v2 reader:
// derive-batch (resident), the stage inputs reader of the four v2 node entries (clued-control) and the
// generic helper's C# twin (FormalPublicBoundaryV2.cs). Pure: bytes in, frozen facts out.
import { canonical } from '../proof.mjs';
import { ACCEPTANCE_CONTRACT_V2, CHECKS_V2, INSTALLATION_CONTRACT_V2, REFS, SOURCES_SCHEMA_V2, hash, validateNodeProfile } from './prepare-record.mjs';
import { REPO } from './layout.mjs';

export const FIXED_APP = Object.freeze({ appId: 5368905, installationId: 172706661, repositoryId: 1334673495 });
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const text = b => (Buffer.isBuffer(b) ? new TextDecoder('utf-8', { fatal: true }).decode(b) : b);
const parse = (t, code) => { try { return JSON.parse(t); } catch { return fail(code); } };
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };

export function validateSourcePinsV2(files, required = []) {
  check(Array.isArray(files) && files.length > 0 && files.length <= 10000, 'ACCEPTED_SOURCE_MISSING');
  const pins = new Map();
  for (const p of files) {
    check(plain(p) && Object.keys(p).sort().join('|') === 'path|sha256' && typeof p.path === 'string' && !p.path.startsWith('/')
      && !/[\\:\x00-\x1f]/.test(p.path) && p.path.split('/').every(v => v && v !== '.' && v !== '..') && HASH.test(p.sha256 ?? '') && !pins.has(p.path), 'SOURCE_PIN_INVALID');
    pins.set(p.path, p.sha256);
  }
  check(required.every(p => pins.has(p)), 'ACCEPTED_SOURCE_INCOMPLETE');
  return pins;
}

// docs: { 'installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json' } as bytes or text.
export function validateRecordV2(docs, { now = Date.now(), required = [], identity = null } = {}) {
  const t = Object.fromEntries(['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json'].map(n => [n, text(docs?.[n])]));
  check(Object.values(t).every(v => typeof v === 'string' && v.length > 0 && v.length <= 4 * 1024 * 1024), 'RECORD_DOCUMENTS_REQUIRED');
  const config = parse(t['installation.json'], 'RECORD_INSTALLATION_INVALID');
  const accepted = parse(t['acceptance.json'], 'RECORD_ACCEPTANCE_INVALID');
  const manifest = parse(t['source-manifest.json'], 'RECORD_MANIFEST_INVALID');
  const signersFile = parse(t['signers.json'], 'RECORD_SIGNERS_INVALID');
  for (const v of [config, accepted, manifest]) check(canonical(v) === t[v === config ? 'installation.json' : v === accepted ? 'acceptance.json' : 'source-manifest.json'], 'RECORD_CANONICAL_BYTES_REQUIRED');
  check(plain(config) && config.contract === INSTALLATION_CONTRACT_V2 && config.enabled === true && config.repository === REPO
    && config.appId === FIXED_APP.appId && config.installationId === FIXED_APP.installationId && config.repositoryId === FIXED_APP.repositoryId
    && !Object.hasOwn(config, 'currentClaim') && !Object.hasOwn(config, 'ciTokenSha256') && !Object.hasOwn(config, 'finiteFirstRun') && !Object.hasOwn(config, 'observationOnly')
    && ['acceptanceSha256', 'sourceManifestSha256', 'ciTokenPinSha256', 'evaluatorSha256', 'policySha256', 'controllerNodeSha256'].every(k => HASH.test(config[k] ?? ''))
    && UUID.test(config.ciPrincipalBindingId ?? '') && typeof config.ciPrincipalQualificationRef === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(config.appPublicKeySha256Base64 ?? '')
    && (config.scope === 'global' || /^project:[a-f0-9-]{36}$/.test(config.scope)) && canonical(config.checks) === canonical(CHECKS_V2), 'RECORD_CONTROLLER_CONFIG_REQUIRED');
  check(hash(t['acceptance.json']) === config.acceptanceSha256 && hash(t['source-manifest.json']) === config.sourceManifestSha256, 'RECORD_BINDING_CHANGED');
  check(plain(accepted) && accepted.contract === ACCEPTANCE_CONTRACT_V2 && accepted.domain === 'production' && accepted.accepted === true && accepted.repository === REPO
    && accepted.claimBound === false && accepted.configSha256 === hash({ ...config, acceptanceSha256: null }) && accepted.platform === 'win32'
    && accepted.workerCannotReadController === true && REFS.every(r => UUID.test(accepted[r] ?? '')) && UUID.test(accepted.ownerDecisionRef ?? '') && UUID.test(accepted.ownerReceiptRef ?? '')
    && accepted.ciPrincipalBindingId === config.ciPrincipalBindingId && accepted.ciPrincipalQualificationRef === config.ciPrincipalQualificationRef
    && accepted.ciTokenPinSha256 === config.ciTokenPinSha256 && accepted.appPublicKeySha256Base64 === config.appPublicKeySha256Base64
    && Date.parse(accepted.acceptedAt) <= now && (accepted.validUntil === null || Date.parse(accepted.validUntil) > now), 'RECORD_ACCEPTANCE_REQUIRED');
  // The pinned node profile (inputs /2, design §9 C1): `hostname` is its hostname, the controller account the fixed one.
  try { validateNodeProfile(accepted.node); } catch { fail('RECORD_NODE_PROFILE_REQUIRED'); }
  check(accepted.hostname === accepted.node.hostname && accepted.controllerAccount === 'clued-control', 'RECORD_NODE_PROFILE_REQUIRED');
  if (identity) check(accepted.arch === identity.arch && accepted.controllerAccount === identity.account && /^[A-Za-z0-9-]+$/.test(accepted.hostname ?? '')
    && accepted.hostname.toLowerCase() === String(identity.hostname).toLowerCase(), 'RECORD_HOST_IDENTITY_REQUIRED');
  const pins = validateSourcePinsV2(accepted.sourceFiles, required);
  check(pins.get('scripts/ci/clued-work-admission.mjs') === config.evaluatorSha256 && pins.get('config/merge-admission-policy.json') === config.policySha256, 'RECORD_EVALUATOR_CHANGED');
  check(plain(manifest) && manifest.schema === SOURCES_SCHEMA_V2 && manifest.repo === REPO && /^[a-f0-9]{40}$/.test(manifest.sourceSha ?? '')
    && plain(manifest.roles) && Object.keys(CHECKS_V2).every(r => plain(manifest.roles[r]) && canonical(manifest.roles[r].sourceFiles) === canonical(accepted.sourceFiles)
      && manifest.roles[r].controllerRelay?.sourceAcceptanceRef === accepted.sourceAcceptanceRef && manifest.roles[r].controllerRelay?.hostQualificationRef === accepted.hostQualificationRef), 'RECORD_SOURCE_MANIFEST_REQUIRED');
  check(plain(signersFile) && Array.isArray(signersFile.signers) && signersFile.signers.length > 0 && hash(signersFile) === accepted.signerRegistrySha256, 'RECORD_SIGNERS_REQUIRED');
  const signers = new Map();
  for (const s of signersFile.signers) {
    check(plain(s) && s.domain === 'production' && typeof s.keyId === 'string' && !signers.has(s.keyId) && s.sourceAcceptanceRef === accepted.sourceAcceptanceRef
      && s.qualificationRef === accepted.hostQualificationRef && typeof s.publicKeyPem === 'string' && typeof s.runtimeId === 'string', 'RECORD_SIGNERS_CHANGED');
    signers.set(s.keyId, freeze(structuredClone(s)));
  }
  return Object.freeze({ config: freeze(config), accepted: freeze(accepted), manifest: freeze(manifest), pins,
    get signers() { return new Map(signers); },
    hashes: Object.freeze({ installationSha256: hash(t['installation.json']), acceptanceSha256: config.acceptanceSha256,
      sourceManifestSha256: config.sourceManifestSha256, runtimeConfigPinSha256: accepted.configSha256, signersSha256: hash(t['signers.json']) }) });
}
