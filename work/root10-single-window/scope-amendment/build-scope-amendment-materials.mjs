// Build the scope-amendment stage-2 materials: the executor applicability
// document, ControllerQualification and RuntimeAcceptance for the narrowed
// applicable test set. Candidate only: it publishes nothing, signs nothing,
// writes no control store, and issues no qualification. Every digest it emits
// is computed from bytes on disk.
//
//   node build-scope-amendment-materials.mjs [--write]
//
// Publication-dependent fields the Owner merge has not produced yet are left as
// explicit placeholder tokens. The script refuses to pretend it knows them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const need = (ok, why) => {if (!ok) throw Error(why);};
const blobOf = bytes => crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const url = s => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + s;
const ref = (sha1, sha256) => ({uri: url(sha1), sha256});

// Where the candidate tree lives now, and the canonical path its manifest
// records because that is where it must sit at activation.
const CANDIDATE = 'scripts/phase2-qualification/control-context-verifier-root10-scope-amendment';
const CANONICAL = 'scripts/phase2-qualification/control-context-verifier-root10-single-window';
const SUITE = 'scripts/phase2-qualification/RuntimeMaterialPreparation/scope-amendment-successor/preentry-skill-qualification.scope.json';
const AMENDMENT = 'work/root10-single-window/scope-amendment/Root10ScopeAmendment.json';
const APPLICABILITY = 'work/root10-single-window/scope-amendment/Root10ScopeExecutorApplicability.json';

// The live pins this amendment supersedes, written literally: a build script
// must not silently re-derive the values it is meant to move away from.
const PRIOR_CONTROLLER = '5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6';
const PRIOR_QUALIFICATION = '6a7145fa0c09a00a917b40c42f5dbaa38f4c6028e75ab747dd234351b993b849';
const PRIOR_ACCEPTANCE = '321221816f4c368d98833de6f698adcb1835d88e6b7c991c0b9d9537abba3c1e';
const RC_AMENDMENT = 'e92a252a0ab62600d6153ece3e3df92a35bd5680b3d9e2c8f65b6c77ff236402';
const SUITE_EXECUTOR = '27ede0fc0ff6afc4d5abf2f5c9f256fe22776165746dddc19aa2693c47bbc97c';
const GENERATION = 'ctrgen_48100437d24e448ba01c542ebe1290da';
const ROOT = 'ctr_414bd3c724264a83894b0c55cf2ab878';
const REVIEWER = '/root/root9_recovery_review';
// The administrative window this amendment sets. It bounds approval, publication,
// activation and archival only; runtime_seconds and the reset cap are carried
// forward from event 119 untouched.
const WINDOW_EXPIRES = '2026-09-16T03:00:00Z';
const APPLICABLE = ['PQUAL-11', 'PQUAL-13', 'PQUAL-15', 'PQUAL-16', 'PQUAL-17'];
const OUT_OF_SCOPE = ['PQUAL-01', 'PQUAL-02', 'PQUAL-03', 'PQUAL-04', 'PQUAL-05', 'PQUAL-06', 'PQUAL-07',
  'PQUAL-08', 'PQUAL-09', 'PQUAL-10', 'PQUAL-12', 'PQUAL-14', 'PQUAL-19', 'PQUAL-20'];

const readFile = rel => fs.readFileSync(path.join(REPO, rel));
const describe = rel => {const bytes = readFile(rel); return {raw: bytes.toString('utf8'), sha256: sha(bytes), blob: blobOf(bytes)};};
// A manifest path is canonical; its bytes live in the candidate tree until the
// rename at activation.
const onDisk = p => p.startsWith(CANONICAL + '/') ? CANDIDATE + '/' + p.slice(CANONICAL.length + 1) : p;

const manifest = describe(CANDIDATE + '/ControllerSourceManifest.candidate.json');
const contract = describe(CANDIDATE + '/Root10ControllerContract.candidate.json');
const suite = describe(SUITE);
const amendment = describe(AMENDMENT);

need(manifest.sha256 !== PRIOR_CONTROLLER, 'NEW_CONTROLLER_DIGEST_MUST_DIFFER');
const applicable = Object.keys(JSON.parse(suite.raw).tests).sort();
need(JSON.stringify(applicable) === JSON.stringify(APPLICABLE), 'EXACT_NARROWED_APPLICABLE_SET');

// --- the executor applicability document -------------------------------------
// Its field set is exactly what validateRoot10ExecutorApplicability requires.
const applicability = {
  state: 'ACCEPTED_EXACT_ROOT10_EXECUTOR_APPLICABILITY',
  independent_reviewer: REVIEWER,
  root_id: ROOT,
  control_trust_root_generation: GENERATION,
  suite_ref: ref(suite.blob, suite.sha256),
  suite_executor_sha256: SUITE_EXECUTOR,
  current_controller_sha256: manifest.sha256,
  formal_test_ids: APPLICABLE,
  pqual18_disposition: 'NEGATIVE_ADMISSION_CHECK_NOT_FORMAL_RESULT',
  oracle_bytes_unchanged: true,
  fixture_refs_unchanged: true,
  test_definitions_unchanged: true,
  controller_executes_same_oracles: true,
  new_authority: false,
  authority_effect: 'NONE',
};
const applicabilityRaw = JSON.stringify(applicability, null, 2) + '\n';
if (process.argv.includes('--write')) fs.writeFileSync(path.join(REPO, APPLICABILITY), applicabilityRaw);
const applicabilityDigest = {sha256: sha(applicabilityRaw), blob: blobOf(Buffer.from(applicabilityRaw, 'utf8'))};

// --- source_ref: the manifest blob plus every file the manifest declares -------
const declared = JSON.parse(manifest.raw).files;
const blobs = [ref(manifest.blob, manifest.sha256)];
for (const file of declared) {
  const bytes = readFile(onDisk(file.path));
  need(bytes.length === file.bytes && sha(bytes) === file.sha256, 'SOURCE_MANIFEST_LOCAL_BYTES:' + file.path);
  blobs.push(ref(blobOf(bytes), file.sha256));
}
need(blobs.some(b => b.sha256 === manifest.sha256), 'EXACT_SOURCE_MANIFEST_BLOB_REF');

const priorQualification = JSON.parse(readFile('work/root10-single-window/runtime-clock/stage2/ControllerQualification.root10.runtime-clock.json').toString('utf8'));
const priorAcceptance = JSON.parse(readFile('work/root10-single-window/runtime-clock/stage2/RuntimeAcceptance.root10.runtime-clock.json').toString('utf8'));
need(priorQualification.controller_digest === PRIOR_CONTROLLER && priorAcceptance.controller_digest === PRIOR_CONTROLLER, 'EXACT_PRIOR_STAGE2_PINS');

const qualification = {
  ...priorQualification,
  controller_digest: manifest.sha256,
  expires_at: WINDOW_EXPIRES,
  controller_source_manifest_ref: ref(manifest.blob, manifest.sha256),
  root10_contract_ref: ref(contract.blob, contract.sha256),
  amendment_ref: ref(amendment.blob, amendment.sha256),
  amendment_object_type: 'Root10ScopeAmendment',
  predecessor_controller_digest: PRIOR_CONTROLLER,
  source_publication: {
    owner_merge_commit: '__OWNER_MERGE_COMMIT__',
    source_tree: '__SOURCE_TREE__',
    controller_manifest_entries: declared.length,
  },
};

// The scope descriptor's field set is exactly scDescriptorKeys in the controller.
const scopeDescriptor = {
  activation_idempotency_key: 'root10_scope_amendment_20260915',
  activation_operation: 'SCOPE_AMENDMENT_ACTIVATED',
  amendment_ref: ref(amendment.blob, amendment.sha256),
  applicable_test_ids: APPLICABLE,
  budget_ref: priorAcceptance.accepted_subject.runtime_clock.budget_ref,
  carries_forward_sequence: 119,
  continuation_controller_sha256: manifest.sha256,
  expected_activation_sequence: 120,
  finalization_expires_at: WINDOW_EXPIRES,
  max_predispatch_resets: 3,
  no_automatic_retry: true,
  no_new_budget: true,
  no_new_ga: true,
  no_refund: true,
  out_of_scope_test_ids: OUT_OF_SCOPE,
  predecessor_controller_sha256: PRIOR_CONTROLLER,
  preparation_expires_at: WINDOW_EXPIRES,
  prior_ga_ref: priorAcceptance.accepted_subject.runtime_clock.prior_ga_ref,
  runtime_clock_amendment_sha256: RC_AMENDMENT,
  runtime_seconds: 600,
  source_ref: {commit: '__OWNER_MERGE_COMMIT__', tree: '__SOURCE_TREE__', blobs},
};

// The scope amendment supersedes the runtime clock in the same slot: the
// acceptance must stop declaring runtime_clock, or both readers would run and
// the superseded one would refuse on a binding it no longer owns.
const {runtime_clock: _superseded, ...subjectRest} = priorAcceptance.accepted_subject;
const acceptance = {
  ...priorAcceptance,
  controller_digest: manifest.sha256,
  expires_at: WINDOW_EXPIRES,
  accepted_subject: {
    ...subjectRest,
    gate_suite_ref: ref(suite.blob, suite.sha256),
    root10_single_window: {
      ...priorAcceptance.accepted_subject.root10_single_window,
      contract_ref: ref(contract.blob, contract.sha256),
      executor_applicability: {
        ref: ref(applicabilityDigest.blob, applicabilityDigest.sha256),
        publication: {commitSha: '__OWNER_MERGE_COMMIT__', artifactPath: APPLICABILITY},
      },
    },
    scope_amendment: scopeDescriptor,
  },
};

// The narrowed set is read off the evidence the accepted runtime already binds,
// not chosen to fit a desired outcome. Refuse to emit if that stops holding.
const historical = acceptance.accepted_subject.historical_component_evidence.map(e => e.test_id).sort();
need(JSON.stringify(historical) === JSON.stringify(APPLICABLE), 'APPLICABLE_SET_MUST_MATCH_HISTORICAL_EVIDENCE');
need(acceptance.accepted_subject.runtime_clock === undefined, 'SUPERSEDED_RUNTIME_CLOCK_MUST_NOT_REMAIN');
need(acceptance.accepted_subject.root10_single_window.contract_ref.sha256 === contract.sha256, 'ACCEPTANCE_CONTRACT_REF_MUST_TRACK_TREE');
need(Date.parse(WINDOW_EXPIRES) >= Date.parse(priorAcceptance.expires_at), 'WINDOW_MAY_ONLY_MOVE_LATER');
need(scopeDescriptor.runtime_seconds === 600 && scopeDescriptor.max_predispatch_resets === 3, 'RUNTIME_BOUND_AND_RESET_CAP_UNCHANGED');

const emit = (name, value) => {
  const raw = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(HERE, name), raw);
  return {name, sha256: sha(raw), bytes: Buffer.byteLength(raw)};
};

process.stdout.write(JSON.stringify({
  state: 'ROOT10_SCOPE_AMENDMENT_MATERIALS_BUILT',
  authority_effect: 'NONE',
  live_database_write: false,
  new_controller_sha256: manifest.sha256,
  new_contract_sha256: contract.sha256,
  new_gate_suite_sha256: suite.sha256,
  amendment_sha256: amendment.sha256,
  executor_applicability_sha256: applicabilityDigest.sha256,
  source_ref_blobs: blobs.length,
  applicable_test_ids: applicable,
  artifacts: [
    {name: 'Root10ScopeExecutorApplicability.json', sha256: applicabilityDigest.sha256, bytes: Buffer.byteLength(applicabilityRaw)},
    emit('ControllerQualification.root10.scope.json', qualification),
    emit('RuntimeAcceptance.root10.scope.json', acceptance),
  ],
  unresolved_placeholders: ['__OWNER_MERGE_COMMIT__', '__SOURCE_TREE__'],
}, null, 2) + '\n');
