// Assembles the twentieth forward's input.json from a live preimage capture.
//
// Why this exists as a committed script rather than an ad-hoc paste: the twentieth forward has to
// be GENERATED (never executed) as part of every verification sweep, because --replay cannot see a
// whole class of defect. Round 18 added a replacement rule byte-identical to an existing one; under
// replay both are identity replacements at existing=18/N=19 so the duplicate was invisible, while a
// real run aborted the generator outright. "Replay reproduces" is therefore not acceptance evidence
// on its own, and re-deriving this input by hand each round is how that check gets skipped.
//
// It writes an input file and nothing else. No SQL is executed from here: the preimage must be
// captured separately, in a read-only repeatable-read transaction, and handed in as a file.
//
// Usage:
//   node build-twentieth-input.mjs <live-preimage.json> --out <input.json>
//        (--rehearsal | --control-plane <digests.json> --guard-exception <name>)
//
// --control-plane consumes the single row emitted by steps13to20/step14-control-plane-digests.sql
// (saved as JSON), i.e. the three post-CP-01 prosrc digests measured LIVE, plus the re-read
// accepted_binding window and the moved-flags. The builder re-does the moved comparison itself
// rather than trusting the flags in the file, and requires both to agree; a capture taken before
// CP-01, or an edited file, fails here instead of inside the one-shot forward.
// --guard-exception is the implementer-chosen exception label; it must differ from the
// nineteenth's, or the guard replacement would be an identity rule -- the round-18 defect.
//
// --rehearsal fills control_plane with the CURRENT live prosrc digests and a placeholder window
// and guard-exception name, and stamps rehearsal:true into the file. Those three digests are only
// correct AFTER CP-01 is applied; a real run must pass the post-CP-01 values instead. The
// generator does not know the difference, so the marker is here to stop a rehearsal input being
// mistaken for the real one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const blobUri = raw => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'
  + crypto.createHash('sha1').update('blob ' + Buffer.byteLength(raw) + '\0').update(raw).digest('hex');

const argv = process.argv.slice(2);
const preimagePath = argv[0];
assert.ok(preimagePath && !preimagePath.startsWith('--'), 'USAGE: see header');
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
assert.ok(outPath, '--out is required');
const rehearsal = argv.includes('--rehearsal');
const cpPath = argv.includes('--control-plane') ? argv[argv.indexOf('--control-plane') + 1] : null;
const guardException = argv.includes('--guard-exception') ? argv[argv.indexOf('--guard-exception') + 1] : null;
assert.ok(!(rehearsal && (cpPath || guardException)), 'REHEARSAL_AND_REAL_ARE_EXCLUSIVE');
assert.ok(rehearsal || (cpPath && guardException), 'A_REAL_RUN_NEEDS --control-plane AND --guard-exception');

// The prosrc digests as they stand BEFORE CP-01. The rehearsal path uses them as marked
// placeholders; the real path REFUSES them, because matching any one means CP-01 has not taken
// effect and the forward would pin the old function bodies.
const PRE_CP01 = Object.freeze({
  reserve_execution_budget_prosrc_sha256: 'df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41',
  reserve_gate_prosrc_sha256: 'a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e',
  append_status_manifest_prosrc_sha256: '94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615',
});
const NINETEENTH_GUARD_EXCEPTION = 'accepted_root5_window9_capacity_repair_required';

// Real path: read the live capture and cross-check it, so a stale or edited capture is refused
// with an attributable reason before the input exists at all.
let realControlPlane = null;
if (!rehearsal) {
  const cap2 = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  const row2 = Array.isArray(cap2) ? cap2[0] : cap2; // psql --json emits a one-element array
  assert.deepEqual(Object.keys(row2).sort(), ['accepted_binding_expires_at', 'append_status_manifest_prosrc',
    'append_status_moved', 'observed_at', 'reserve_budget_moved', 'reserve_execution_budget_prosrc',
    'reserve_gate_moved', 'reserve_gate_prosrc'], 'CONTROL_PLANE_CAPTURE_SHAPE');
  const map = {
    reserve_execution_budget_prosrc_sha256: ['reserve_execution_budget_prosrc', 'reserve_budget_moved'],
    reserve_gate_prosrc_sha256: ['reserve_gate_prosrc', 'reserve_gate_moved'],
    append_status_manifest_prosrc_sha256: ['append_status_manifest_prosrc', 'append_status_moved'],
  };
  realControlPlane = {};
  for (const [k, [col, movedCol]] of Object.entries(map)) {
    const v = row2[col];
    assert.match(v ?? '', /^[a-f0-9]{64}$/, 'CONTROL_PLANE_DIGEST:' + col);
    // My own comparison, not the file's flag -- and the flag must agree with it.
    const moved = v !== PRE_CP01[k];
    assert.ok(moved, 'CP01_NOT_APPLIED:' + col + ' still has its pre-CP-01 value');
    assert.strictEqual(row2[movedCol], true,
      'CAPTURE_FLAG_DISAGREES:' + movedCol + ' — the digest moved but the capture says otherwise; the file was edited or the pre-CP-01 literals here are stale');
    realControlPlane[k] = v;
  }
  assert.match(row2.accepted_binding_expires_at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'CONTROL_PLANE_WINDOW_FORMAT');
  realControlPlane.accepted_binding_expires_at = row2.accepted_binding_expires_at;
  assert.match(guardException, /^[a-z0-9_]{1,80}$/, 'GUARD_EXCEPTION_NAME');
  assert.notEqual(guardException, NINETEENTH_GUARD_EXCEPTION,
    'GUARD_EXCEPTION_EQUALS_THE_NINETEENTHS — the replacement would be an identity rule');
  realControlPlane.guard_exception_name = guardException;
}


const NINETEENTH = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window9-corrected-binding/ActualNineteenthForwardInput.json';
const CONTROLLER = 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor';
const MANIFEST = CONTROLLER + '/ControllerSourceManifest.candidate.json';

const prev = JSON.parse(fs.readFileSync(path.join(REPO, NINETEENTH), 'utf8'));
const cap = JSON.parse(fs.readFileSync(preimagePath, 'utf8'));

// The capture carries the getter definition alongside the row; the generator wants them apart.
const {previous_getter_definition_raw, ...row} = cap;
assert.ok(previous_getter_definition_raw, 'CAPTURE_MUST_INCLUDE previous_getter_definition_raw');
assert.equal(sha(previous_getter_definition_raw), row.previous_getter_definition_sha256,
  'CAPTURED_GETTER_DOES_NOT_MATCH_ITS_OWN_DIGEST');
assert.equal(Number(row.existing_forwards), 19, 'PREIMAGE_IS_NOT_AT_NINETEEN_FORWARDS');
assert.equal(Number(row.execution_current.sequence), 88, 'PREIMAGE_IS_NOT_AT_SEQUENCE_88');
assert.equal(Number(row.execution_current.charged_seconds), 9906, 'THE_SINGLE_ALLOCATION_HAS_MOVED');

// The one material that changes: the controller manifest. Its bytes are read from the repository
// and re-measured here rather than copied from anywhere, so the input cannot carry a stale digest.
const manifestRaw = fs.readFileSync(path.join(REPO, MANIFEST), 'utf8');
const commit = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const materials = structuredClone(prev.source_materials);
materials.controller_manifest = {
  raw: manifestRaw,
  ref: {sha256: sha(manifestRaw), uri: blobUri(manifestRaw)},
  publication: {artifactPath: MANIFEST, commitSha: commit},
};
assert.notEqual(materials.controller_manifest.ref.sha256, row.previous_binding.controller_sha256,
  'THE_NEW_MANIFEST_EQUALS_THE_BOUND_ONE — this forward would move nothing');

// Not the ONE material after all: the qualification and the runtime acceptance move with the
// controller. Cloning the nineteenth's materials and replacing only controller_manifest produced
// a binding of "root6 Linux controller + root5 v16 qualification", which context.mjs:76 refuses
// (qualification.controller_digest must equal the binding's controller_sha256) and reserve_gate
// refuses behind it -- found by the steps-13-to-20 preparation session, reproduced here. Same
// discipline as the manifest: bytes read from the repository and re-measured, never copied.
const V19 = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19';
for (const [key, file] of [['qualification', 'ScopedRoot5FinalControllerQualification.json'],
                           ['runtime_acceptance', 'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json']]) {
  const artifactPath = V19 + '/' + file;
  const raw = fs.readFileSync(path.join(REPO, artifactPath), 'utf8');
  materials[key] = {raw, ref: {sha256: sha(raw), uri: blobUri(raw)}, publication: {artifactPath, commitSha: commit}};
  const doc = JSON.parse(raw);
  assert.equal(doc.controller_digest, materials.controller_manifest.ref.sha256,
    'V19_' + key.toUpperCase() + '_PINS_A_DIFFERENT_CONTROLLER: ' + String(doc.controller_digest).slice(0, 12));
  assert.equal(doc.independent_reviewer, '/root', 'V19_' + key.toUpperCase() + '_REVIEWER');
}
// The exact state strings context.mjs:71 and :76 will demand. The rehearsal path tolerates the
// acceptance still being PREPARED -- that is what exists before the capacity chain closes -- but a
// real input built on a PREPARED acceptance would spend the one allocation on a guaranteed
// EXACT_RUNTIME_ACCEPTANCE_METADATA_REQUIRED refusal, so it is refused here instead.
assert.equal(JSON.parse(materials.qualification.raw).state, 'ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION',
  'V19_QUALIFICATION_NOT_ACCEPTED');
const acceptanceState = JSON.parse(materials.runtime_acceptance.raw).state;
if (!rehearsal) {
  assert.equal(acceptanceState, 'ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME', 'V19_ACCEPTANCE_NOT_ACCEPTED: ' + acceptanceState);
  const subj = JSON.parse(materials.runtime_acceptance.raw).accepted_subject;
  assert.ok(subj && subj.capacity_materials && Object.keys(subj.capacity_materials).length > 0,
    'V19_ACCEPTANCE_CAPACITY_MATERIALS_EMPTY — the capacity chain has not closed');
}

const input = {
  actual_preimage: {query: prev.actual_preimage.query, observation_ref: prev.actual_preimage.observation_ref, row},
  gate_definition_raw: prev.gate_definition_raw,
  idempotency_key: 'root6-linux-controller-forward-' + sha(manifestRaw).slice(0, 16),
  previous_getter_definition_raw,
  source_materials: materials,
  control_plane: rehearsal ? {
    // Placeholders. reserve_* and append_status_manifest are the digests as they stand BEFORE
    // CP-01; the real run must supply the post-CP-01 values. The window and guard-exception name
    // are made up, and deliberately different from the nineteenth's so the replacements are not
    // silently identity ones.
    reserve_execution_budget_prosrc_sha256: 'df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41',
    reserve_gate_prosrc_sha256: 'a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e',
    append_status_manifest_prosrc_sha256: '94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615',
    accepted_binding_expires_at: '2026-09-30T00:00:00Z',
    guard_exception_name: 'accepted_root6_window11_capacity_repair_required',
    // Carried inside control_plane rather than at the top level: the generator asserts the exact
    // set of top-level keys, so a marker there is rejected as INPUT_SHAPE. It travels with the
    // file either way, which is the point -- a rehearsal input must not be mistaken for the real
    // one just because it was renamed.
    rehearsal_placeholders: true,
    rehearsal_acceptance_state: acceptanceState,
  } : realControlPlane,
};
assert.ok(input.control_plane, 'CONTROL_PLANE_MISSING');

fs.writeFileSync(outPath, JSON.stringify(input, null, 2) + '\n');
console.log(JSON.stringify({
  state: rehearsal ? 'REHEARSAL_INPUT_NOT_FOR_EXECUTION' : 'TWENTIETH_FORWARD_INPUT',
  out: outPath,
  controller_manifest_sha256: materials.controller_manifest.ref.sha256,
  replaces_controller_sha256: row.previous_binding.controller_sha256,
  idempotency_key: input.idempotency_key,
  preimage_observed_at: row.observed_at,
  authority_effect: 'NONE',
}, null, 2));
