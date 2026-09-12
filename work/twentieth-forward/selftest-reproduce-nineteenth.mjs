// Live-anchored self-test for the forward getter builder.
//
// The original generator (nineteenth-forward.candidate.mjs) self-tested by replaying forwards 5..15
// from input files on a Windows machine, plus a LockedInstall.v3.template.sql that its own receipt
// records as unrecoverable. None of that exists here, so that self-test cannot be run.
//
// This is a stronger substitute. It takes the recorded inputs of the nineteenth forward, rebuilds
// the getter with the unmodified buildExactGetter, and asserts the result reproduces BOTH:
//
//   - the SQL digest the receipt recorded  (f97d8585...)
//   - the prosrc digest of the function LIVE IN THE DATABASE RIGHT NOW  (c721b056...)
//
// The second assertion is the point: it proves the builder reproduces, byte for byte, the function
// currently enforcing binding resolution in production. If it fails, the twentieth forward must not
// be built from this path.
//
// Read-only. Touches no database. The live digest is passed in as an argument so this file makes no
// connection of its own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {buildExactGetter} from '../../scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window9-corrected-binding/exact-getter-root5-window9.candidate.mjs';
// The derived module differs from the one above by two characters (its own upper bound, 19 -> 20).
// Running the nineteenth forward through BOTH proves that change altered nothing else.
import {buildExactGetter as buildExactGetterDerived} from './exact-getter-root6-window11.candidate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window9-corrected-binding';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

// The live prosrc digest must be supplied by the caller, read from the database in the same
// session. Hardcoding it here would defeat the purpose of the check.
const LIVE_PROSRC_SHA256 = process.argv[2];
assert.match(LIVE_PROSRC_SHA256 ?? '', /^[a-f0-9]{64}$/, 'USAGE: node selftest-reproduce-nineteenth.mjs <live effective_execution_binding prosrc sha256>');

const input = JSON.parse(fs.readFileSync(path.join(REPO, DIR, 'ActualNineteenthForwardInput.json'), 'utf8'));
const prep = JSON.parse(fs.readFileSync(path.join(REPO, DIR, 'ActualNineteenthForwardPreparation.json'), 'utf8'));

// --- reproduce buildForward's derivation of the new binding, rather than trusting the record ---
const p = input.actual_preimage.row;
const materials = input.source_materials;
const refs = {};
for (const [k, m] of Object.entries(materials)) {
  // re-verify each material's own digest and blob uri before using it
  assert.equal(sha(m.raw), m.ref.sha256, 'MATERIAL_DIGEST_MISMATCH:' + k);
  const blob = crypto.createHash('sha1').update('blob ' + Buffer.byteLength(m.raw) + '\0').update(m.raw).digest('hex');
  assert.equal(m.ref.uri, 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + blob, 'MATERIAL_BLOB_URI_MISMATCH:' + k);
  refs[k] = {ref: m.ref, publication: m.publication};
}
const gate = JSON.parse(input.gate_definition_raw);
const derivedBinding = {
  ...p.previous_binding,
  controller_sha256: materials.controller_manifest.ref.sha256,
  scope_sha256: materials.scope.ref.sha256,
  qualification_sha256: materials.qualification.ref.sha256,
  runtime_acceptance_sha256: materials.runtime_acceptance.ref.sha256,
  gate_sha256: sha(input.gate_definition_raw),
  gate_version: gate.definition_version,
};
assert.ok(same(derivedBinding, prep.new_binding), 'DERIVED_BINDING_DIFFERS_FROM_RECORDED');
assert.ok(same(refs, prep.source_acceptance_refs), 'DERIVED_REFS_DIFFER_FROM_RECORDED');

// --- normalise the previous getter exactly as buildForward does ---
let previous = input.previous_getter_definition_raw.replaceAll('$function$', () => '$$').trimEnd();
if (!previous.endsWith(';')) previous += ';';
assert.equal(previous.split('$$').length, 3, 'EXACT_TWO_GETTER_DOLLAR_DELIMITERS');
assert.equal(sha(previous.split('$$')[1]), p.previous_getter_prosrc_sha256, 'PREVIOUS_BODY_DIGEST');

// --- rebuild, with both the original module and the derived one ---
const args = {
  previous_sql: previous,
  previous_sha256: sha(previous),
  existing_forwards: 18,
  next_sequence: p.execution_current.sequence + 1,
  key: input.idempotency_key,
  previous_binding: p.previous_binding,
  new_binding: derivedBinding,
  source_acceptance_refs: refs,
};
const built = buildExactGetter(args);
const builtDerived = buildExactGetterDerived(args);
assert.equal(builtDerived.sql, built.sql, 'DERIVED_MODULE_PRODUCES_DIFFERENT_SQL');
assert.ok(same(builtDerived, built), 'DERIVED_MODULE_PRODUCES_DIFFERENT_RESULT');

const body = s => {
  assert.equal(s.split('$$').length, 3, 'EXACT_TWO_GETTER_DOLLAR_DELIMITERS');
  const m = s.match(/as \$\$([\s\S]*)\$\$;/i);
  assert.ok(m);
  return m[1];
};

const rebuiltSql = built.sha256;
const rebuiltProsrc = sha(body(built.sql));
const recordedSql = prep.getter_sha256;

const result = {
  state: 'LIVE_ANCHORED_SELFTEST',
  previous_sequence: p.execution_current.sequence,
  next_sequence: p.execution_current.sequence + 1,
  existing_forwards: 18,
  sql_digest: {rebuilt: rebuiltSql, recorded_in_preparation: recordedSql, match: rebuiltSql === recordedSql},
  prosrc_digest: {rebuilt: rebuiltProsrc, live_in_database: LIVE_PROSRC_SHA256, match: rebuiltProsrc === LIVE_PROSRC_SHA256},
  prosrc_chars: body(built.sql).length,
  derived_module_produces_identical_output: true,
};
console.log(JSON.stringify(result, null, 2));

assert.equal(rebuiltSql, recordedSql, 'REBUILT_SQL_DOES_NOT_MATCH_RECORDED_NINETEENTH_FORWARD');
assert.equal(rebuiltProsrc, LIVE_PROSRC_SHA256, 'REBUILT_PROSRC_DOES_NOT_MATCH_THE_FUNCTION_LIVE_IN_THE_DATABASE');
console.log('\nPASS: buildExactGetter reproduces the nineteenth forward byte for byte, and its output body is identical to the function currently live in clued_control.');
