// Builds a TWENTY-FIRST-forward input in the real input shape, so build-twentyfirst.mjs can be run
// for real once rather than only replayed. --replay makes every substitution an identity
// replacement, which is exactly the condition under which round 18's duplicate rule and R21-F4's
// missing rule were both invisible; a real generation is the only run that exercises the from-side.
//
// WHAT THIS IS NOT. It is not the twenty-first forward's execution input:
//   * the preimage is measured through the MCP SQL tool, which runs read-committed and NOT under
//     `transaction_read_only=on` + repeatable read, so the real capture query's own guard clause
//     (`current_setting('transaction_read_only')='on' and ...`) was dropped to get the values out;
//   * the materials are whatever the F12 tree holds at this commit, not a reviewed, published set;
//   * no ownership, acceptance or publication decision is encoded anywhere in it.
// The SQL generated from it is to be inspected and thrown away. Executing it is not authorised by
// anything in this directory.
//
//   node smoke-input-21.mjs --live <live.json> --out <input21.json>
//
// live.json is the measured row: observed_at, rows_sha256, catalog_sha256, execution_current,
// previous_binding, getter digests, the three control-plane prosrc digests, expires_at.
// previous_getter_definition_raw is NOT fetched (108KB through the tool for nothing): it is rebuilt
// offline from the nineteenth's recorded definition and the twentieth's own generator inputs, and
// then asserted equal to the live definition digest that live.json carries. If the rebuild is not
// byte-exact, that assertion fails and nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const arg = n => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null;
const live = JSON.parse(fs.readFileSync(arg('--live'), 'utf8'));
const outPath = arg('--out');
assert.ok(outPath, 'USAGE: --live <live.json> --out <input21.json>');

const INPUT20 = path.join(REPO, 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/step14-execution/input20.real.json');
const prior = JSON.parse(fs.readFileSync(INPUT20, 'utf8'));

// ---- rebuild the live getter's definition text offline ------------------------------------------
const norm = s => { let n = s.replaceAll('$function$', () => '$$').trimEnd(); if (!n.endsWith(';')) n += ';'; return n; };
const unnorm = s => s.replace(/;$/, '').replaceAll('$$', () => '$function$') + '\n';
assert.equal(unnorm(norm(prior.previous_getter_definition_raw)), prior.previous_getter_definition_raw,
  'NORMALISATION_DOES_NOT_ROUND_TRIP_ON_THE_NINETEENTHS_DEFINITION');
const {buildExactGetter} = await import(pathToFileURL(path.join(REPO, 'work/twentieth-forward/exact-getter-root6-window11.candidate.mjs')).href);
const pp = prior.actual_preimage.row, pm = prior.source_materials;
const priorRefs = Object.fromEntries(Object.keys(pm).sort().map(k => [k, {ref: pm[k].ref, publication: pm[k].publication}]));
const priorGate = JSON.parse(prior.gate_definition_raw);
const twentiethNewBinding = {
  ...pp.previous_binding,
  controller_sha256: pm.controller_manifest.ref.sha256, scope_sha256: pm.scope.ref.sha256,
  qualification_sha256: pm.qualification.ref.sha256, runtime_acceptance_sha256: pm.runtime_acceptance.ref.sha256,
  gate_sha256: sha(prior.gate_definition_raw), gate_version: priorGate.definition_version,
};
const n19 = norm(prior.previous_getter_definition_raw);
const twentieth = buildExactGetter({
  previous_sql: n19, previous_sha256: sha(n19), existing_forwards: Number(pp.existing_forwards),
  next_sequence: Number(pp.execution_current.sequence) + 1, key: prior.idempotency_key,
  previous_binding: pp.previous_binding, new_binding: twentiethNewBinding, source_acceptance_refs: priorRefs,
});
const getterRaw = unnorm(twentieth.sql);
assert.equal(sha(getterRaw), live.previous_getter_definition_sha256,
  'REBUILT_GETTER_IS_NOT_THE_LIVE_ONE — offline rebuild ' + sha(getterRaw).slice(0, 12) +
  ', live pg_get_functiondef ' + String(live.previous_getter_definition_sha256).slice(0, 12));
assert.equal(sha(norm(getterRaw).split('$$')[1]), live.previous_getter_prosrc_sha256, 'REBUILT_GETTER_BODY_DIGEST');

// ---- materials, read from the tree at this commit -------------------------------------------------
const PATHS = {
  controller_manifest: 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor/ControllerSourceManifest.candidate.json',
  gate_suite: 'scripts/phase2-qualification/RuntimeMaterialPreparation/env-order-repair-successor/preentry-skill-qualification.json',
  independent_acceptance: 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16/Status23Acceptance.json',
  qualification: 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19/ScopedRoot5FinalControllerQualification.json',
  runtime_acceptance: 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json',
  scope: 'scripts/phase2-qualification/RuntimeMaterialPreparation/env-order-repair-successor/ExecutionScopeDefinition.json',
};
const git = a => execFileSync('git', a, {cwd: REPO, encoding: 'utf8'}).trim();
const source_materials = {};
for (const [k, rel] of Object.entries(PATHS)) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  assert.equal(git(['status', '--porcelain', '--', rel]), '', 'WORKING_TREE_DIRTY:' + rel);
  const blob = crypto.createHash('sha1').update('blob ' + Buffer.byteLength(raw) + '\0').update(raw).digest('hex');
  assert.equal(blob, git(['hash-object', '--', rel]), 'BLOB_SHA1_DISAGREES_WITH_GIT:' + rel);
  source_materials[k] = {
    raw,
    ref: {sha256: sha(raw), uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + blob},
    publication: {artifactPath: rel, commitSha: git(['log', '-1', '--format=%H', '--', rel])},
  };
}
// The gate definition must still be the one the suite carries; otherwise the generator's
// GATE_NOT_IN_SUITE would be the only thing this smoke run proved.
const suite = JSON.parse(source_materials.gate_suite.raw);
let gate_definition_raw = prior.gate_definition_raw;
if (!same(JSON.parse(gate_definition_raw), suite.gates['G-PREENTRY-SKILL-QUALIFICATION'])) {
  gate_definition_raw = JSON.stringify(suite.gates['G-PREENTRY-SKILL-QUALIFICATION']);
  console.error('NOTE: the on-disk suite no longer carries the twentieth forward\'s gate object; ' +
    'the smoke input uses the suite\'s current gate.');
}

const input = {
  actual_preimage: {
    query: 'SMOKE_CAPTURE_NOT_THE_READ_ONLY_REPEATABLE_READ_PREIMAGE_QUERY',
    observation_ref: {path: 'work/twentyfirst-forward/smoke-input-21.mjs', sha256: sha(fs.readFileSync(path.join(HERE, 'smoke-input-21.mjs')))},
    row: {
      observed_at: live.observed_at,
      server_timezone: 'UTC',
      database_name: 'postgres',
      accepted_project_ref: 'uscrdifznmlvczcekqpw',
      rows_sha256: live.rows_sha256,
      catalog_sha256: live.catalog_sha256,
      execution_current: live.execution_current,
      previous_binding: live.previous_binding,
      previous_getter_definition_sha256: live.previous_getter_definition_sha256,
      previous_getter_prosrc_sha256: live.previous_getter_prosrc_sha256,
      existing_forwards: live.existing_forwards,
    },
  },
  gate_definition_raw,
  idempotency_key: 'smoke-not-for-execution-forward-' + sha(source_materials.controller_manifest.raw).slice(0, 16),
  previous_getter_definition_raw: getterRaw,
  source_materials,
  control_plane: {
    reserve_execution_budget_prosrc_sha256: live.reserve_execution_budget_prosrc_sha256,
    reserve_gate_prosrc_sha256: live.reserve_gate_prosrc_sha256,
    append_status_manifest_prosrc_sha256: live.append_status_manifest_prosrc_sha256,
    accepted_binding_expires_at: live.accepted_binding_expires_at,
    guard_exception_name: live.guard_exception_name,
  },
};
fs.writeFileSync(outPath, JSON.stringify(input, null, 1));
console.log(JSON.stringify({
  state: 'SMOKE_INPUT_FOR_GENERATION_ONLY_NOT_AN_EXECUTION_PREIMAGE',
  out: outPath, bytes: fs.statSync(outPath).size,
  getter_rebuilt_offline: {definition_sha256: sha(getterRaw), matches_live: true},
  controller_manifest_sha256: source_materials.controller_manifest.ref.sha256,
  idempotency_key: input.idempotency_key,
  existing_forwards: live.existing_forwards, sequence: live.execution_current.sequence,
}, null, 2));
