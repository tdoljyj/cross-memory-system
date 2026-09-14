#!/usr/bin/env node
// Rebuilds Status27 from the exact P2-published unsigned payload and P2 Owner merge.
// It has no network, database, budget, reservation, dispatch, refund, or capacity path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPOSITORY = 'tdoljyj/cross-memory-system';
const GH_BLOB = `https://api.github.com/repos/${REPOSITORY}/git/blobs/`;
const P2_MERGE = '20d6ec1e62eebed26e56bc2e4f52eed87704e8ab';
const P2_TREE = '54c448837711086bcf0e334de4c6acc97c1f338f';
const P2_PARENT = '251b3b7eed1d9d3149c73f4b17dedda8aea7bfa5';
const P2_SOURCE = '64e8dec1549af469cf4647df8a3aa3945b76a3e6';
const P2_EVIDENCE_SHA = 'dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887';
const P2_EVIDENCE_BLOB = 'bfc65714f9b596c6140c745948185e92665a48dd';
const STATUS_PATH = 'work/recovery-root9/postbudget-stage2/Status27SigningPayload.json';
const STATUS_SCHEMA_PATH = 'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/status-manifest.root5.schema.json';
const APP_PACKAGE_PATH = 'apps/clued-cloud/package.json';
const STATUS_RAW_SHA = '9701fd4512797f4a90b96a59e06f438422e84f8eb03038fd3ae947ec46fd5c95';
const STATUS_BLOB = '1816ca696f55bd8d4b182d1edd4d5e2d912f5705';
const S = 'c3fd1848edbd0b186cb0ba259cb3e8d739bcb3f0dac25754985133de68813a06';

const EXPECTED_P2 = {
  'work/ga-readiness/build-ga.mjs': ['2a1726db8eb8ab2d405339f693085fd4d2af9402', '998e92f41cbe8a04d7205606a0ca883e06a8fdf663457e35b4dc370b9e0ed322'],
  'work/recovery-root9/postbudget-stage2/ControllerQualification.root9.postbudget.candidate.json': ['7ed2fcfa163b98a041403531e718ce37119495b7', 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'],
  'work/recovery-root9/postbudget-stage2/P1PublicationEvidence.verified.json': ['c41614456c0a5bee4e18d552d90827ac1cf8cf6a', '76e82befc3c6fe415066cc56bb352488ab559b5be209251fc4f9cb4b7f19bb1c'],
  'work/recovery-root9/postbudget-stage2/README.md': ['bfa020b14f02ba6a1227687bc6dd17e2b9cae86e', '87af0358a4ea3a592975bbaae6ba98fbc235941fce1e728219a401d0db74b68e'],
  'work/recovery-root9/postbudget-stage2/RESULT.json': ['1895543ee83b3faff68b9be5f00edab59833d057', 'ced83747e8789a3a6b5f564cb92433e6e30452cde927c1f79e3e870a54df7007'],
  'work/recovery-root9/postbudget-stage2/Root9Generation.unchanged.json': ['9f36e78ce6d3b95d48bc082317548c4abeda143e', '956975e5131aaf858dc06bc7923e0186416740d82db64363af6103e7f69f94e1'],
  'work/recovery-root9/postbudget-stage2/RuntimeAcceptance.root9.postbudget.json': ['66fd881e994c418b63f012f721831a4202247b67', 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'],
  'work/recovery-root9/postbudget-stage2/SHA256SUMS.txt': ['ddd2ccec7df5509c6dcc5282487cbc43a95a486a', '9e23066f84ffb9f0edef14173cc09e675176caeec77f0f68522c58f5f604f7fa'],
  'work/recovery-root9/postbudget-stage2/Status27SignedPayloadDigest.txt': ['41ed9245fb3cfeb299b9754b64ab07b6bf288eda', '30d60aca5d337661e401eaa08c350fb8d3e673863dae41795c962d98ad25960a'],
  [STATUS_PATH]: [STATUS_BLOB, STATUS_RAW_SHA]
};

const need = (value, message) => { if (!value) throw new Error(message); };
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blob = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const ref = (blobSha, digest) => ({ uri: `${GH_BLOB}${blobSha}`, sha256: digest });
function canonical(value) {
  if (typeof value === 'number') need(Number.isSafeInteger(value), 'UNSAFE_NUMBER');
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const canonicalDigest = value => sha256(Buffer.from(`${canonical(value)}\n`, 'utf8'));
function containsForbiddenBackEdge(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenBackEdge);
  if (value && typeof value === 'object') {
    const forbidden = new Set(['status27_generation_ref', 'full_status27_ref', 'full_status27_sha256', 'full_status_raw_sha256']);
    return Object.entries(value).some(([key, child]) => forbidden.has(key.toLowerCase()) || containsForbiddenBackEdge(child));
  }
  if (typeof value !== 'string') return false;
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('/status27generation.json') || normalized === 'status27generation.json';
}
function writeExact(file, bytes) {
  if (fs.existsSync(file)) need(fs.readFileSync(file).equals(bytes), `REFUSE_OVERWRITE_DIFFERENT_BYTES:${file}`);
  else fs.writeFileSync(file, bytes);
}

const repoRootArg = arg('--repo-root');
const evidenceArg = arg('--p2-publication-evidence');
need(repoRootArg, 'REPO_ROOT_REQUIRED');
need(evidenceArg, 'P2_PUBLICATION_EVIDENCE_REQUIRED');
const repoRoot = path.resolve(repoRootArg);
const evidencePath = path.resolve(evidenceArg);
need(fs.existsSync(path.join(repoRoot, APP_PACKAGE_PATH)), 'REPO_APP_PACKAGE_REQUIRED');
need(fs.existsSync(path.join(repoRoot, STATUS_SCHEMA_PATH)), 'REPO_STATUS_SCHEMA_REQUIRED');

for (const artifactPath of Object.keys(EXPECTED_P2).sort()) {
  const raw = fs.readFileSync(path.join(repoRoot, artifactPath));
  const [expectedBlob, expectedSha] = EXPECTED_P2[artifactPath];
  need(blob(raw) === expectedBlob, `P2_BLOB:${artifactPath}`);
  need(sha256(raw) === expectedSha, `P2_SHA256:${artifactPath}`);
}

const evidenceRaw = fs.readFileSync(evidencePath);
need(sha256(evidenceRaw) === P2_EVIDENCE_SHA && blob(evidenceRaw) === P2_EVIDENCE_BLOB, 'P2_PUBLICATION_EVIDENCE_RAW_IDENTITY');
const evidence = JSON.parse(evidenceRaw);
need(evidence.state === 'VERIFIED_POSTBUDGET_STAGE2_OWNER_MERGE' && evidence.repository === REPOSITORY && evidence.pull_request === 177, 'P2_PUBLICATION_EVIDENCE_HEADER');
need(JSON.stringify(evidence.merge) === JSON.stringify({
  sha: P2_MERGE, tree: P2_TREE, parents: [P2_PARENT, P2_SOURCE], first_parent: P2_PARENT, source_parent: P2_SOURCE, source_tree: P2_TREE,
  author_login: 'tdoljyj', merged_by: 'tdoljyj', committer_login: 'web-flow', base_ref: 'main', pull_request_count: 1,
  verification: { verified: true, reason: 'valid', ui_detail: 'This commit was created on GitHub.com and signed with GitHub’s verified signature.' }, merged_at: '2026-09-14T09:42:42Z'
}), 'P2_EXACT_OWNER_MERGE');
need(evidence.artifacts.status27_signing_payload.path === STATUS_PATH && evidence.artifacts.status27_signing_payload.ref.uri.endsWith(`/${STATUS_BLOB}`) && evidence.artifacts.status27_signing_payload.ref.sha256 === STATUS_RAW_SHA && evidence.artifacts.status27_signing_payload.signed_payload_sha256 === S, 'P2_STATUS27_PUBLICATION_REF');
need(evidence.artifacts.controller_qualification.ref.sha256 === 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013' && evidence.artifacts.runtime_acceptance.ref.sha256 === 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552', 'P2_DEPENDENCY_REFS');
need(evidence.controller.manifest_ref.sha256 === 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a', 'P2_CONTROLLER_REF');
need(evidence.budget_inheritance.sequence === 102 && evidence.budget_inheritance.sha256 === '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a' && evidence.budget_inheritance.inherited === true && evidence.budget_inheritance.new_allocation === false && evidence.budget_inheritance.second_budget_allocation === false && evidence.budget_inheritance.automatic_refund === false, 'P2_SEQ102_INHERITANCE');
need(evidence.authority_effect === 'NONE' && evidence.database_writes === 0 && evidence.history_rewritten === false && evidence.refund === false && evidence.capacity_change === false && evidence.budget_allocations === 0, 'P2_NO_LIVE_EFFECT');

const statusRaw = fs.readFileSync(path.join(repoRoot, STATUS_PATH));
const unsignedStatus = JSON.parse(statusRaw);
need(!Object.hasOwn(unsignedStatus, 'signature_binding'), 'P2_STATUS27_MUST_BE_UNSIGNED');
need(sha256(statusRaw) === STATUS_RAW_SHA && blob(statusRaw) === STATUS_BLOB && canonicalDigest(unsignedStatus) === S, 'P2_STATUS27_EXACT_BYTES_AND_S');
need(unsignedStatus.generation === 27 && unsignedStatus.status_manifest_id === 'sm_root9_status27_postbudget_signing_repair_v1', 'STATUS27_IDENTITY');

const require = createRequire(path.join(repoRoot, APP_PACKAGE_PATH));
const Ajv = require('ajv');
const validateStatus = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(JSON.parse(fs.readFileSync(path.join(repoRoot, STATUS_SCHEMA_PATH))));

const signatureEvidence = {
  state: 'P2_OWNER_MERGE_BOUND_VERIFIED',
  repository: REPOSITORY,
  issuer_purpose: 'STATUS',
  audience: 'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',
  control_trust_root_generation: 'ctrgen_308a1dfc185cff633892638581e0a34c',
  merge: structuredClone(evidence.merge),
  payload: { path: STATUS_PATH, blob_sha1: STATUS_BLOB, raw_sha256: STATUS_RAW_SHA, signed_object_sha256: S },
  bound_refs: {
    p2_publication_evidence: { sha256: P2_EVIDENCE_SHA },
    controller_manifest: { sha256: 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a' },
    controller_qualification: { sha256: 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013' },
    runtime_acceptance: { sha256: 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552' }
  },
  no_full_status_reverse_hash: true,
  authority_effect: 'NONE',
  database_writes: 0
};
need(!containsForbiddenBackEdge(signatureEvidence), 'SIGNATURE_EVIDENCE_FULL_STATUS_BACK_EDGE');
const signatureRaw = jsonBytes(signatureEvidence);
const signatureRef = ref(blob(signatureRaw), sha256(signatureRaw));
need(!signatureRaw.includes(Buffer.from(signatureRef.sha256)) && !signatureRaw.includes(Buffer.from(signatureRef.uri.split('/').at(-1))), 'SIGNATURE_EVIDENCE_SELF_HASH');

const fullStatus = structuredClone(unsignedStatus);
fullStatus.signature_binding = { owner_merge_commit: P2_MERGE, signed_object_sha256: S, signature_evidence_ref: signatureRef };
const unsignedAgain = structuredClone(fullStatus); delete unsignedAgain.signature_binding;
need(jsonBytes(unsignedAgain).equals(statusRaw) && canonicalDigest(unsignedAgain) === S, 'FULL_STATUS27_UNSIGNED_DIVERGENCE');
need(validateStatus(fullStatus), `FULL_STATUS27_SCHEMA:${JSON.stringify(validateStatus.errors)}`);
const fullRaw = jsonBytes(fullStatus);
const fullRef = ref(blob(fullRaw), sha256(fullRaw));
need(!signatureRaw.includes(Buffer.from(fullRef.sha256)) && !signatureRaw.includes(Buffer.from(fullRef.uri.split('/').at(-1))), 'SIGNATURE_EVIDENCE_FULL_STATUS_HASH_BACK_EDGE');
need(!fullRaw.includes(Buffer.from(fullRef.sha256)) && !fullRaw.includes(Buffer.from(fullRef.uri.split('/').at(-1))), 'FULL_STATUS27_SELF_HASH');

const result = {
  state: 'P2_SIGNED_STATUS27_COMPLETION_PASS_FOR_P3_PUBLICATION',
  p2_owner_merge_commit: P2_MERGE,
  p2_publication_evidence_ref: ref(P2_EVIDENCE_BLOB, P2_EVIDENCE_SHA),
  status27_signature_evidence_ref: signatureRef,
  status27_generation_ref: fullRef,
  status27_signed_object_sha256: S,
  unsigned_payload_exact_raw_reencoding: true,
  status_schema_valid: true,
  one_way_binding_no_mutual_hash_cycle: true,
  ready_for_p3_publication: true,
  database_writes: 0,
  budget_allocations: 0,
  gate_reservations: 0,
  dispatches: 0,
  capacity_change: false,
  refund: false,
  history_rewritten: false
};

if (process.argv.includes('--verify-only')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
const outArg = arg('--out');
need(outArg, 'OUT_REQUIRED');
const out = path.resolve(outArg);
const p2Work = path.join(repoRoot, 'work', 'recovery-root9', 'postbudget-stage2');
need(out !== p2Work && !out.startsWith(`${p2Work}${path.sep}`), 'REFUSE_P2_OUTPUT');
fs.mkdirSync(out, { recursive: true });
writeExact(path.join(out, 'Status27SignatureEvidence.json'), signatureRaw);
writeExact(path.join(out, 'Status27Generation.json'), fullRaw);
writeExact(path.join(out, 'STATUS27_RESULT.json'), jsonBytes(result));
console.log(JSON.stringify(result, null, 2));
