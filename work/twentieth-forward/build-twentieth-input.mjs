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
//   node build-twentieth-input.mjs <live-preimage.json> --out <input.json> [--rehearsal]
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
  } : null,
};
assert.ok(input.control_plane, 'A REAL input needs control_plane supplied; only --rehearsal fills it');

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
