// Generates the TWENTY-FIRST compact binding-forward transaction, in the exact shape the twentieth
// forward was actually executed in. IT ONLY GENERATES. Nothing here touches the database.
//
// LINEAGE. There is no general "next forward" generator in this repo, and this script is not one
// either. work/twentieth-forward/twentieth-forward-compact.mjs is the nineteenth-to-twentieth
// special case: its substitution table's from-side reads a `const N19` block of literals lifted
// from the NINETEENTH forward's SQL. This script is the twentieth-to-twenty-first case. The two
// differences that matter:
//
//   1. The from-side is NOT a typed constant block. It comes from n20.derived.json, which
//      derive-n20.mjs extracted from the archived twentieth forward under per-field uniqueness
//      assertions. This script RE-RUNS that derivation at startup and refuses to continue unless
//      the json matches it field for field, so editing the json by hand changes nothing.
//   2. Everything the json does not carry -- the three big jsonb literals, the rebuilt-getter
//      fragment, and the post-state prosrc digest -- is extracted from the template here, anchored
//      on the SYNTAX THAT GIVES EACH LITERAL ITS MEANING (the exception each guard raises), not on
//      a line number and not on "a 64-hex string nearby". Line numbers moved between the
//      nineteenth's compact and the twentieth's; roles did not.
//
// TWO HAZARDS THIS ROUND, BOTH WITH HISTORY (see TwentyFirstForwardPrep.md):
//
//   * The `guard replace` rule in the twentieth's generator wrote its from-side as
//     `guardOf(18),guardOf(19)` -- the NINETEENTH's whitelist pair, hardcoded. At the twenty-first
//     that matches nothing. Here the pair comes from the derived guard_pre/guard_post, which are
//     asserted to be 1..existing and 1..existing+1 of the TEMPLATE's own forward.
//   * Round 18 added a second `guard replace` rule whose from-side was byte-identical to the
//     first. Under --replay every rule is an identity replacement, so a duplicate is invisible;
//     on a real run the first consumed the single occurrence and the second aborted the generator.
//     --replay is therefore NOT acceptance on its own. A real generation must be run, and the
//     residual checks below must show zero twentieth-specific literals left in the output.
//
// SELF-TEST (--replay): fed the twentieth forward's own recorded input (input20.real.json), the
// output must equal the archived forward20.real.sql byte for byte. Every replacement becomes an
// identity replacement, so drift in how a literal is derived shows up as a mismatch.
//
// RISK. The SQL this script writes, if executed, replaces a SECURITY DEFINER function, appends a
// row to an append-only table and CASes execution_current.sequence. A wrong event cannot be
// deleted. This script neither connects nor executes; running the output is a separate, reviewed,
// explicitly authorised act, and prerequisites for it (NW-02, root7 registration, CP-02's
// series_f > 17) are outside this file.
//
// Usage:
//   node build-twentyfirst.mjs <input.json> [--replay] [--dry-run] [--out-sql f] [--out-prep f]
//
// input.json has buildForward's shape (actual_preimage, gate_definition_raw, idempotency_key,
// previous_getter_definition_raw, source_materials) plus, outside --replay, control_plane:
//   { reserve_execution_budget_prosrc_sha256, reserve_gate_prosrc_sha256,
//     append_status_manifest_prosrc_sha256, accepted_binding_expires_at, guard_exception_name }
// Those are the POST-CP-02 digests and the POST-NW-02 window, measured live, not copied from here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {deriveGetterModule, OUTPUT_REL as GETTER_MODULE_REL} from './derive-getter-module.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const json = x => JSON.stringify(stable(x));
const sqlEscape = s => s.replaceAll("'", "''");
const guardOf = n => 'if n not in (' + Array.from({length: n}, (_, i) => i + 1).join(',') + ')';

const ROOT_ID = 'ctr_414bd3c724264a83894b0c55cf2ab878';
// 20 is confirmed against the archive below (the twentieth's own event exception name). 21 is the
// one entry nothing can confirm yet -- it is a name this run chooses and then writes into an
// executed transaction. Recorded as an open item in TwentyFirstBuildNotes.md.
const ORDINAL = {20: 'twentieth', 21: 'twenty_first'};

// ---- N20: derived from the archive at startup, never typed, never trusted from disk alone -------
const N20_JSON = path.join(HERE, 'n20.derived.json');
const DERIVER = path.join(HERE, 'derive-n20.mjs');
const stored = JSON.parse(fs.readFileSync(N20_JSON, 'utf8'));
const rederived = JSON.parse(execFileSync(process.execPath, [DERIVER], {encoding: 'utf8', maxBuffer: 1 << 24}));
assert.equal(rederived.source, stored.source, 'N20_SOURCE_DISAGREES');
assert.equal(rederived.source_sha256, stored.source_sha256, 'N20_SOURCE_DIGEST_DISAGREES');
assert.ok(same(rederived.fields, stored.fields),
  'N20_JSON_DISAGREES_WITH_RERUN_DERIVATION — n20.derived.json is not what derive-n20.mjs produces ' +
  'from the archived twentieth forward. Do not reconcile by editing the json; re-run ' +
  '`node derive-n20.mjs --write` and review the diff.');
const T20 = stored.fields;

// The derived block must be internally consistent before anything is built on it.
assert.equal(T20.this_forward, T20.existing_forwards + 1, 'N20_FORWARD_NUMBERING');
assert.equal(T20.next_forward, T20.this_forward + 1, 'N20_NEXT_FORWARD');
assert.equal(T20.next_seq, T20.prev_seq + 1, 'N20_SEQUENCES_NOT_CONSECUTIVE');
assert.equal(T20.guard_pre, guardOf(T20.existing_forwards), 'N20_GUARD_PRE_IS_NOT_1..' + T20.existing_forwards);
assert.equal(T20.guard_post, guardOf(T20.this_forward), 'N20_GUARD_POST_IS_NOT_1..' + T20.this_forward);
assert.equal(T20.tag, `$nf${T20.this_forward}$`, 'N20_TAG_DISAGREES_WITH_WHITELIST');
// The only available confirmation of the ORDINAL naming convention: the archive's own spelling.
assert.equal(T20.event_exception, `exact_real_${ORDINAL[T20.this_forward]}_forward_event_required`,
  'ORDINAL_CONVENTION_DISAGREES_WITH_THE_ARCHIVE');

const TEMPLATE_PATH = path.join(REPO, stored.source);
const TEMPLATE_SHA256 = stored.source_sha256;

// ---- the getter builder for THIS forward count --------------------------------------------------
// Each forward raises the builder's own upper bound by one (<18, <19, <20, now <21). The module is
// re-derived in memory from the twentieth's and the file on disk must equal it byte for byte, so a
// hand-edited builder cannot slip in. work/twentieth-forward/ is read-only in this window.
const derivedModule = deriveGetterModule().after;
const GETTER_MODULE = path.join(REPO, GETTER_MODULE_REL);
assert.ok(fs.existsSync(GETTER_MODULE), 'MISSING_GETTER_MODULE:' + GETTER_MODULE_REL +
  ' — run `node work/twentyfirst-forward/derive-getter-module.mjs --write`');
assert.equal(fs.readFileSync(GETTER_MODULE, 'utf8'), derivedModule,
  'GETTER_MODULE_IS_NOT_THE_DERIVATION:' + GETTER_MODULE_REL + ' — do not hand-edit it; re-derive it.');
const {buildExactGetter} = await import(pathToFileURL(GETTER_MODULE).href);

// ---- template, and the literals the json cannot carry -------------------------------------------
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
assert.equal(sha(template), TEMPLATE_SHA256, 'TEMPLATE_IS_NOT_THE_ARCHIVED_TWENTIETH_FORWARD');

const occurrences = (hay, needle) => hay.split(needle).length - 1;
const uniqueAt = (needle, what) => {
  const n = occurrences(template, needle);
  assert.equal(n, 1, `TEMPLATE_ANCHOR_NOT_UNIQUE:${what} — found ${n} occurrence(s), need exactly 1`);
  return template.indexOf(needle);
};
const between = (pre, post, what) => {
  const s = uniqueAt(pre, what) + pre.length;
  const e = template.indexOf(post, s);
  assert.ok(e > s, `TEMPLATE_ANCHOR_UNTERMINATED:${what}`);
  return template.slice(s, e);
};
// The execution_current preimage guard, and the request body of the appended event.
const T_EXEC_ANCHOR = `execution_current x where root_id='${ROOT_ID}') is distinct from '`;
const litExecCurrent = between(T_EXEC_ANCHOR, "'::jsonb", 'execution_current preimage literal');
const litRequestBody = between("request_body:='", "'::jsonb", 'event request_body literal');
// Two jsonb literals share the syntax `effective_execution_binding() x) is distinct from '...'`:
// the binding the preimage guard requires to STILL be in force, and the binding the forward must
// leave behind. The twentieth's generator told them apart by line number and by "not the other
// one"; R21-F4 was exactly a missing rule for one of them. Here each is identified by the
// exception its own guard raises, which is the thing that gives it its meaning.
const EFF = "effective_execution_binding() x) is distinct from '";
assert.equal(occurrences(template, EFF), 2, 'TEMPLATE_BINDING_GUARD_COUNT');
const tailFor = exc => `'::jsonb then raise exception '${exc}'`;
const bindingLiteralFor = exc => {
  const end = uniqueAt(tailFor(exc), 'binding guard:' + exc);
  const start = template.lastIndexOf(EFF, end);
  assert.ok(start >= 0, 'BINDING_GUARD_HAS_NO_LITERAL:' + exc);
  return template.slice(start + EFF.length, end);
};
const PREV_TAIL = tailFor('exact_current_and_previous_binding_required');
const NEW_TAIL = tailFor('exact_successor_getter_or_binding_required');
const litPrevBinding = bindingLiteralFor('exact_current_and_previous_binding_required');
const litNewBinding = bindingLiteralFor('exact_successor_getter_or_binding_required');
assert.notEqual(litPrevBinding, litNewBinding,
  'PREVIOUS_AND_SUCCESSOR_BINDING_LITERALS_ARE_IDENTICAL — one of the two anchors is wrong');
// The post-state prosrc digest. n20.derived.json does not carry it (derive-n20.mjs resolves 13
// fields and this is not one of them), so it is extracted here, anchored on prosrc -- NOT on
// pg_get_functiondef, which is the other digest of the same function and sits in a different guard.
const PROSRC_SITE = "convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=" +
  "'clued_control.effective_execution_binding()'::regprocedure) is distinct from '";
const litProsrcAfter = between(PROSRC_SITE, "'", 'successor prosrc digest');
assert.match(litProsrcAfter, /^[a-f0-9]{64}$/, 'SUCCESSOR_PROSRC_DIGEST_SHAPE');
// The in-database rebuild fragment.
const FS_MARK = "v_new:=replace(v_new,' return next result;\nend $$;','", FE_MARK = "');\nif encode(sha256(convert_to(v_new";
const fa = uniqueAt(FS_MARK, 'fragment start') + FS_MARK.length;
const fb = template.indexOf(FE_MARK, fa);
assert.ok(fb > fa, 'TEMPLATE_FRAGMENT_NOT_FOUND');
const templateFragment = template.slice(fa, fb);
// Shape, not a pinned length: the whole template is already digest-pinned, and the shape is what
// says this fragment belongs to the template's own forward count.
assert.ok(templateFragment.startsWith(` if n=${T20.existing_forwards} then return next result;return;end if;`),
  'TEMPLATE_FRAGMENT_SHAPE');
assert.ok(templateFragment.endsWith('end $$;'), 'TEMPLATE_FRAGMENT_END');

// ---- arguments ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const inputPath = argv[0];
assert.ok(inputPath && !inputPath.startsWith('--'), 'USAGE: see header');
const replay = argv.includes('--replay');
const dryRun = argv.includes('--dry-run');
const arg = n => argv.includes(n) ? argv[argv.indexOf(n) + 1] : null;
const outSql = arg('--out-sql'), outPrep = arg('--out-prep');

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
assert.deepEqual(Object.keys(input).filter(k => k !== 'control_plane').sort(),
  ['actual_preimage', 'gate_definition_raw', 'idempotency_key', 'previous_getter_definition_raw', 'source_materials'],
  'INPUT_SHAPE');
const cp = replay ? {
  reserve_execution_budget_prosrc_sha256: T20.reserve_execution_budget,
  reserve_gate_prosrc_sha256: T20.reserve_gate,
  append_status_manifest_prosrc_sha256: T20.append_status_manifest,
  accepted_binding_expires_at: T20.window,
  guard_exception_name: T20.guard_exception,
} : input.control_plane;
assert.ok(cp, 'CONTROL_PLANE_REQUIRED — post-CP-02 prosrc digests and post-NW-02 window');
for (const k of ['reserve_execution_budget_prosrc_sha256', 'reserve_gate_prosrc_sha256', 'append_status_manifest_prosrc_sha256'])
  assert.match(cp[k] ?? '', /^[a-f0-9]{64}$/, 'control_plane.' + k);
assert.match(cp.accepted_binding_expires_at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'control_plane.accepted_binding_expires_at');
assert.match(cp.guard_exception_name ?? '', /^[a-z0-9_]{1,80}$/, 'control_plane.guard_exception_name');

// ---- preimage, mirroring buildForward's checks ---------------------------------------------------
const p = input.actual_preimage.row, c = p.execution_current;
for (const h of [p.rows_sha256, p.catalog_sha256, p.previous_getter_definition_sha256, p.previous_getter_prosrc_sha256])
  assert.match(h, /^[a-f0-9]{64}$/);
assert.equal(p.server_timezone, 'UTC');
assert.equal(p.accepted_project_ref, 'uscrdifznmlvczcekqpw');
assert.equal(c.root_id, ROOT_ID);
// What must not have moved since the twentieth forward comes from the twentieth forward's own
// preimage literal, not from numbers typed here (the twentieth's generator pinned 9906 and
// 2201594803 in source).
const templateExecCurrent = JSON.parse(litExecCurrent);
assert.equal(templateExecCurrent.root_id, ROOT_ID, 'TEMPLATE_PREIMAGE_IS_ANOTHER_ROOT');
assert.equal(Number(templateExecCurrent.sequence), T20.prev_seq, 'TEMPLATE_PREIMAGE_SEQUENCE_DISAGREES_WITH_ITS_CAS');
for (const f of ['active_ga_id', 'pending_budget_sequence', 'charged_seconds', 'charged_evidence_bytes'])
  assert.equal(String(c[f]), String(templateExecCurrent[f]),
    `EXECUTION_CURRENT_MOVED:${f} — live ${c[f]}, the twentieth forward saw ${templateExecCurrent[f]}. ` +
    'The single allocation must still be unspent and no generation attempt may be in flight.');
// The three generation ids may legitimately rotate between forwards. Observed and reported rather
// than enforced: the generated SQL guards on the LIVE preimage either way.
const generations = ['credential_generation', 'runner_generation', 'session_generation'].map(f =>
  ({field: f, live: c[f], at_twentieth: templateExecCurrent[f], rotated: c[f] !== templateExecCurrent[f]}));

const existing = Number(p.existing_forwards), N = existing + 1, seq = Number(c.sequence), next = seq + 1;
assert.ok(ORDINAL[N], `THIS_SCRIPT_ONLY_KNOWS_FORWARDS_${T20.this_forward}_AND_${T20.next_forward}, got ` + N);
if (replay) {
  assert.equal(N, T20.this_forward, 'REPLAY_IS_THE_TWENTIETH');
  assert.equal(seq, T20.prev_seq, 'REPLAY_SEQUENCE');
} else {
  assert.equal(N, T20.next_forward, 'REAL_RUN_MUST_BE_THE_TWENTY_FIRST');
  assert.equal(existing, T20.this_forward,
    `FORWARD_COUNT_MUST_BE_${T20.this_forward} — the twenty-first forward follows the twentieth; live count is ${existing}`);
  assert.equal(seq, T20.next_seq,
    `EXECUTION_SEQUENCE_MUST_BE_${T20.next_seq} — the twentieth forward landed there (archived CAS ` +
    `${T20.prev_seq} -> ${T20.next_seq}); live says ${seq}. Neither number is typed here, and nothing ` +
    'else may have consumed a sequence in between.');
  assert.notEqual(input.idempotency_key, T20.key, 'IDEMPOTENCY_KEY_IS_THE_TWENTIETH_FORWARDS');
  const age = Date.now() - Date.parse(p.observed_at);
  assert.ok(age >= 0 && age < 60000, 'FRESH_ACTUAL_PREIMAGE_REQUIRED — capture is ' + Math.round(age / 1000) + 's old');
}

// previous getter: normalise exactly as buildForward does, then bind to the recorded digests
assert.equal(sha(input.previous_getter_definition_raw), p.previous_getter_definition_sha256, 'PREVIOUS_GETTER_DEFINITION_DIGEST');
assert.equal(input.previous_getter_definition_raw.split('$function$').length, 3);
let vNorm = input.previous_getter_definition_raw.replaceAll('$function$', () => '$$').trimEnd();
if (!vNorm.endsWith(';')) vNorm += ';';
assert.equal(vNorm.split('$$').length, 3);
assert.equal(sha(vNorm.split('$$')[1]), p.previous_getter_prosrc_sha256, 'PREVIOUS_GETTER_BODY_DIGEST');
const vNormSha = sha(vNorm);
if (replay) assert.equal(vNormSha, T20.v_norm_sha256, 'REPLAY_PREVIOUS_GETTER_IS_NOT_THE_NINETEENTHS_OUTPUT');
else assert.equal(vNormSha, T20.v_new_sha256,
  'NORMALISED_LIVE_GETTER_IS_NOT_THE_TWENTIETH_FORWARD_OUTPUT — expected ' + T20.v_new_sha256.slice(0, 8) +
  ' (the twentieth forward\'s v_new target, which normalisation round-trips to), got ' + vNormSha.slice(0, 8));

// materials
const keys = ['controller_manifest', 'gate_suite', 'independent_acceptance', 'qualification', 'runtime_acceptance', 'scope'];
const materials = input.source_materials;
assert.deepEqual(Object.keys(materials).sort(), keys);
const refs = {};
for (const k of keys) {
  const m = materials[k];
  assert.equal(typeof m.raw, 'string');
  assert.equal(sha(m.raw), m.ref?.sha256, 'MATERIAL_DIGEST:' + k);
  const blob = crypto.createHash('sha1').update('blob ' + Buffer.byteLength(m.raw) + '\0').update(m.raw).digest('hex');
  assert.equal(m.ref.uri, 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + blob, 'MATERIAL_BLOB_URI:' + k);
  refs[k] = {ref: m.ref, publication: m.publication};
}
const templateNewBinding = JSON.parse(litNewBinding);
if (!replay) assert.notEqual(materials.controller_manifest.ref.sha256, templateNewBinding.controller_sha256,
  'CONTROLLER_MANIFEST_IS_STILL_THE_TWENTIETH_ONE — the twenty-first forward must move the binding ' +
  'onto the F12 controller (the digest compared against is the twentieth forward\'s own, read from its SQL)');
const gate = JSON.parse(input.gate_definition_raw), suite = JSON.parse(materials.gate_suite.raw);
assert.equal(gate.gate_id, 'G-PREENTRY-SKILL-QUALIFICATION');
assert.ok(same(gate, suite.gates[gate.gate_id]), 'GATE_NOT_IN_SUITE');
assert.match(gate.definition_version, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const newBinding = {
  ...p.previous_binding,
  controller_sha256: materials.controller_manifest.ref.sha256,
  scope_sha256: materials.scope.ref.sha256,
  qualification_sha256: materials.qualification.ref.sha256,
  runtime_acceptance_sha256: materials.runtime_acceptance.ref.sha256,
  gate_sha256: sha(input.gate_definition_raw),
  gate_version: gate.definition_version,
};
if (!replay) assert.notEqual(newBinding.controller_sha256, p.previous_binding.controller_sha256, 'FORWARD_DOES_NOT_MOVE_THE_CONTROLLER');
const key = input.idempotency_key;
assert.match(key, /^[A-Za-z0-9_-]{1,128}$/);

// ---- offline target: what the database must rebuild -------------------------------------------
const built = buildExactGetter({
  previous_sql: vNorm, previous_sha256: vNormSha, existing_forwards: existing, next_sequence: next, key,
  previous_binding: p.previous_binding, new_binding: newBinding, source_acceptance_refs: refs,
});
const END = ' return next result;\nend $$;';
const prefix = vNorm.replace(guardOf(existing), guardOf(N));
assert.equal(built.sql.slice(0, prefix.length - END.length), prefix.slice(0, prefix.length - END.length), 'BUILDER_PREFIX_DRIFT');
const fragment = built.sql.slice(prefix.length - END.length);
assert.ok(fragment.startsWith(` if n=${existing} then return next result;return;end if;`), 'FRAGMENT_SHAPE');
const body = s => { assert.equal(s.split('$$').length, 3); const m = s.match(/as \$\$([\s\S]*)\$\$;/i); assert.ok(m); return m[1]; };
const vNewSha = sha(built.sql), prosrcAfter = sha(body(built.sql));

// ---- substitutions ------------------------------------------------------------------------------
let out = template.slice(0, fa) + '<<FRAGMENT>>' + template.slice(fb);
// Order matters in one place: the v_new target is rewritten BEFORE the v_norm site, because for the
// twenty-first forward the new v_norm digest IS the twentieth's v_new digest, and the later rule
// would otherwise find two occurrences and abort.
const R = [
  ['do tag',                   T20.tag,                                `$nf${N}$`,                             2],
  // The three big jsonb literals are anchored in their surrounding context: the new_binding JSON is
  // also a substring of the request_body, so a bare match would count twice in replay (where old ==
  // new). The context makes each site unique in both modes.
  ['exec_current preimage',    `${T_EXEC_ANCHOR}${litExecCurrent}'::jsonb`,
                               `${T_EXEC_ANCHOR}${json(c)}'::jsonb`,                                           1],
  ['event request_body',       `request_body:='${litRequestBody}'::jsonb`,
                               `request_body:='${json({new_binding: newBinding, previous_binding: p.previous_binding, source_acceptance_refs: refs})}'::jsonb`, 1],
  // Each binding guard carries the exception it raises into its own from/to string. Without that
  // tail the two rules are order-dependent in a way --replay cannot show: this forward's
  // previous_binding IS the twentieth's new_binding, so rewriting the previous-binding site first
  // produces a second copy of the successor site's literal and the successor rule then finds two
  // occurrences. (It did, on the first real generation. In replay both rules are identity
  // replacements and the order is invisible.) The twentieth's generator survived the same hazard
  // only by listing its two rules in the lucky order. Anchored on the exception, neither rule can
  // match the other's site whatever the order.
  ['previous binding guard',   `${EFF}${litPrevBinding}${PREV_TAIL}`,  `${EFF}${json(p.previous_binding)}${PREV_TAIL}`, 1],
  ['successor binding guard',  `${EFF}${litNewBinding}${NEW_TAIL}`,    `${EFF}${json(newBinding)}${NEW_TAIL}`, 1],
  ['fragment',                 '<<FRAGMENT>>',                         sqlEscape(fragment),                    1],
  ['v_new target',             T20.v_new_sha256,                       vNewSha,                                1],
  ['v_norm digest',            T20.v_norm_sha256,                      vNormSha,                               1],
  ['getter def digest',        T20.getter_definition_sha256,           p.previous_getter_definition_sha256,     1],
  ['prosrc after',             litProsrcAfter,                         prosrcAfter,                            1],
  ['rows sha',                 T20.rows_sha256,                        p.rows_sha256,                          1],
  ['catalog sha',              T20.catalog_sha256,                     p.catalog_sha256,                       1],
  ['reserve_execution_budget', T20.reserve_execution_budget,           cp.reserve_execution_budget_prosrc_sha256, 1],
  ['reserve_gate',             T20.reserve_gate,                       cp.reserve_gate_prosrc_sha256,          1],
  ['append_status_manifest',   T20.append_status_manifest,             cp.append_status_manifest_prosrc_sha256, 1],
  ['guard exception',          T20.guard_exception,                    cp.guard_exception_name,                1],
  ['window',                   `'${T20.window}'`,                      `'${cp.accepted_binding_expires_at}'`,  2],
  // Derived, not hardcoded: the twentieth's generator wrote guardOf(18),guardOf(19) here, which
  // matches nothing in this template. guard_pre/guard_post come from the archive and were asserted
  // above to be 1..existing and 1..existing+1 of the TEMPLATE's forward.
  ['whitelist replace',        `'${T20.guard_pre}','${T20.guard_post}'`, `'${guardOf(existing)}','${guardOf(N)}'`, 1],
  ['insert seq+key',           `',${T20.next_seq},'${T20.key}'`,       `',${next},'${key}'`,                    1],
  ['cas update',               `set sequence=${T20.next_seq} where root_id='${ROOT_ID}' and sequence=${T20.prev_seq}`,
                               `set sequence=${next} where root_id='${ROOT_ID}' and sequence=${seq}`,           1],
  ['readback ev',              `e.sequence=${T20.next_seq};`,          `e.sequence=${next};`,                   1],
  ['readback compare',         `'sequence',${T20.next_seq},'idempotency_key','${T20.key}'`,
                               `'sequence',${next},'idempotency_key','${key}'`,                                 1],
  ['event exception',          T20.event_exception,                    `exact_real_${ORDINAL[N]}_forward_event_required`, 1],
  ['expected_rows seq',        `to_jsonb(${T20.next_seq}::bigint)`,    `to_jsonb(${next}::bigint)`,             1],
];
const applied = [];
for (const [what, from, to, count] of R) {
  const n = occurrences(out, from);
  assert.equal(n, count, `OCCURRENCE_COUNT:${what}: expected ${count}, found ${n}`);
  // Function replacer, never a string: a string `to` has String.replaceAll interpret "$$" as a
  // literal "$", which turned "end $$;" into "end $;" -- one byte, found only by the replay.
  out = out.replaceAll(from, () => to);
  applied.push({what, count, changed: from !== to});
}
assert.equal(occurrences(out, '<<FRAGMENT>>'), 0, 'FRAGMENT_PLACEHOLDER_SURVIVED');

// ---- nothing twentieth-specific may survive a real run -----------------------------------------
// The list is expressed as (template value, this run's value, number of sites) so that a literal
// this run LEGITIMATELY reuses -- an unchanged control-plane function, a window CP-02 did not move
// -- is not reported as a survivor, and a literal that must move is not excused either way.
const identityReplacements = [];
if (!replay) {
  const RESIDUAL = [
    ['do tag', T20.tag, `$nf${N}$`, 2],
    ['v_norm digest site', T20.v_norm_sha256, vNormSha, 1],
    ['v_new digest', T20.v_new_sha256, vNormSha, 1], // becomes this forward's v_norm digest: 1 site
    ['getter def digest', T20.getter_definition_sha256, p.previous_getter_definition_sha256, 1],
    ['rows sha', T20.rows_sha256, p.rows_sha256, 1],
    ['catalog sha', T20.catalog_sha256, p.catalog_sha256, 1],
    ['prosrc after', litProsrcAfter, prosrcAfter, 1],
    ['idempotency key', T20.key, key, 3],
    ['event exception', T20.event_exception, `exact_real_${ORDINAL[N]}_forward_event_required`, 1],
    ['bounded forward exception', `exact_bounded_forward_${T20.this_forward}_required`, `exact_bounded_forward_${N}_required`, 1],
    ['fragment offset', `offset ${T20.existing_forwards} limit 1`, `offset ${existing} limit 1`, 1],
    // Both whitelists are compared against THIS forward's pre-image, which is the only slot where
    // a template whitelist can legitimately still appear: the twentieth's post-image (1..20) is
    // the twenty-first's pre-image, while the twentieth's pre-image (1..19) must be gone entirely.
    ['whitelist pre-image of the twentieth', T20.guard_pre, guardOf(existing), 1],
    ['whitelist post-image of the twentieth', T20.guard_post, guardOf(existing), 1],
    ['guard exception', T20.guard_exception, cp.guard_exception_name, 1],
    ['window', T20.window, cp.accepted_binding_expires_at, 2],
    ['reserve_execution_budget', T20.reserve_execution_budget, cp.reserve_execution_budget_prosrc_sha256, 1],
    ['reserve_gate', T20.reserve_gate, cp.reserve_gate_prosrc_sha256, 1],
    ['append_status_manifest', T20.append_status_manifest, cp.append_status_manifest_prosrc_sha256, 1],
  ];
  for (const [label, was, now, sites] of RESIDUAL) {
    const n = occurrences(out, was);
    const expect = was === now ? sites : 0;
    assert.equal(n, expect, `TWENTIETH_LITERAL_SURVIVED:${label}: expected ${expect} occurrence(s), found ${n}` +
      (expect ? ' (this run reuses the same value, so the site is legitimately still there)' : ''));
    if (was === now) identityReplacements.push({label, value_unchanged_from_the_twentieth: true, sites: n});
  }
  // And the positive side: this forward's own literals must actually be present.
  assert.equal(occurrences(out, `exact_bounded_forward_${N}_required`), 1, 'OWN_BOUNDED_FORWARD_EXCEPTION_MISSING');
  assert.equal(occurrences(out, `exact_real_${ORDINAL[N]}_forward_event_required`), 1, 'OWN_EVENT_EXCEPTION_MISSING');
  assert.equal(occurrences(out, `offset ${existing} limit 1`), 1, 'OWN_FRAGMENT_OFFSET_MISSING');
  assert.equal(occurrences(out, guardOf(N)), 1, 'OWN_WHITELIST_POST_IMAGE_MISSING');
  assert.equal(occurrences(out, guardOf(existing)), 1, 'OWN_WHITELIST_PRE_IMAGE_MISSING');
  assert.equal(occurrences(out, `$nf${N}$`), 2, 'OWN_TAG_MISSING');
  assert.equal(occurrences(out, `set sequence=${next} where root_id='${ROOT_ID}' and sequence=${seq}`), 1, 'OWN_CAS_MISSING');
  assert.equal(occurrences(out, vNewSha), 1, 'OWN_V_NEW_TARGET_MISSING');
  assert.equal(occurrences(out, prosrcAfter), 1, 'OWN_PROSRC_AFTER_MISSING');

  // Structural closing check, and the reason the list above is not enough on its own: the list is
  // hand-written, and R21-F4 was a literal nobody had listed. The denominator comes from the
  // ARTIFACT instead -- every 64-hex digest in the generated SQL must be traceable to this run's
  // inputs. Anything else is a value inherited from the template, i.e. a missing rule.
  const known = new Set();
  const collect = v => {
    if (typeof v === 'string') { for (const m of v.matchAll(/[a-f0-9]{64}/g)) known.add(m[0]); }
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(p);                    // the live preimage, including previous_binding
  collect(newBinding);
  collect(refs);
  collect(cp);                   // post-CP-02 control-plane digests
  collect(input.gate_definition_raw);
  known.add(vNewSha); known.add(vNormSha); known.add(prosrcAfter);
  known.add(sha(input.previous_getter_definition_raw));
  for (const m of Object.values(materials)) { known.add(m.ref.sha256); collect(m.publication); }
  const strays = [...new Set([...out.matchAll(/[a-f0-9]{64}/g)].map(m => m[0]))].filter(d => !known.has(d));
  assert.equal(strays.length, 0,
    'UNTRACEABLE_DIGEST_IN_OUTPUT: ' + strays.map(d => d.slice(0, 12)).join(',') +
    ' — every digest in the generated SQL must come from this run\'s inputs. A digest that does not ' +
    'is a value carried over from the twentieth forward\'s SQL, i.e. a replacement rule that is missing.');
} else if (out !== template) {
  // Locate the first differing byte rather than printing two 23KB strings.
  let i = 0; while (i < out.length && i < template.length && out[i] === template[i]) i++;
  const line = template.slice(0, i).split('\n').length;
  const show = s => JSON.stringify(s.slice(Math.max(0, i - 80), i + 120));
  throw new assert.AssertionError({message:
    `REPLAY_DOES_NOT_REPRODUCE_THE_ARCHIVED_TWENTIETH_FORWARD_BYTE_FOR_BYTE\n` +
    `  first difference at offset ${i} (template line ${line}); lengths out=${out.length} template=${template.length}\n` +
    `  template: ${show(template)}\n  output:   ${show(out)}`});
}

// --dry-run: the entire transaction is a single `do` block between begin; and commit;, so replacing
// the trailing commit with rollback yields a FULL rehearsal -- every guard, the in-database getter
// rebuild, the digest admission, the execute, the event insert, the sequence CAS and the readback
// all run, and then none of it persists. CREATE OR REPLACE FUNCTION is transactional in Postgres,
// the inserted row and the CAS are undone, and the transaction consumes no sequences.
if (dryRun) {
  assert.ok(!replay, 'DRY_RUN_AND_REPLAY_ARE_EXCLUSIVE');
  assert.ok(out.endsWith('commit;\n'), 'TEMPLATE_MUST_END_WITH_COMMIT');
  assert.equal(occurrences(out, 'commit;'), 1, 'EXACTLY_ONE_COMMIT');
  out = out.slice(0, -'commit;\n'.length) + 'rollback;\n';
}

const prep = {
  state: replay ? 'REPLAY_REPRODUCED_ARCHIVED_TWENTIETH_FORWARD'
       : dryRun ? 'TWENTY_FIRST_FORWARD_COMPACT_DRY_RUN_ROLLBACK_NO_PERSISTENT_EFFECT'
       : 'TWENTY_FIRST_FORWARD_COMPACT_CANDIDATE_NOT_REVIEWED_NOT_EXECUTED',
  persists: !replay && !dryRun,
  executed_form: 'COMPACT_IN_DATABASE_REBUILD_WITH_OFFLINE_DIGEST_ADMISSION',
  template: {path: stored.source, sha256: TEMPLATE_SHA256, forward_number: T20.this_forward},
  n20: {source: stored.source, rederived_at_startup: true, fields_agree_with_json: true},
  getter_module: {path: GETTER_MODULE_REL, sha256: sha(derivedModule), derived_from: 'work/twentieth-forward/exact-getter-root6-window11.candidate.mjs'},
  sha256: sha(out), bytes: Buffer.byteLength(out),
  forward_number: N, previous_sequence: seq, next_sequence: next, idempotency_key: key,
  whitelist: {from: guardOf(existing), to: guardOf(N)},
  getter: {v_norm_sha256_expected: vNormSha, v_new_sha256_target: vNewSha, prosrc_sha256_after: prosrcAfter,
           previous_definition_sha256: p.previous_getter_definition_sha256},
  control_plane_guards: cp,
  execution_current_generations: generations,
  identity_replacements: identityReplacements,
  new_binding: newBinding, previous_binding: p.previous_binding, source_acceptance_refs: refs,
  actual_preimage_ref: input.actual_preimage.observation_ref,
  replacements: applied,
  authority_effect: 'NONE',
};
if (outSql) fs.writeFileSync(outSql, out);
if (outPrep) fs.writeFileSync(outPrep, JSON.stringify(prep, null, 2) + '\n');
console.log(JSON.stringify({...prep, new_binding: undefined, previous_binding: undefined, source_acceptance_refs: undefined,
  replacements: applied.filter(a => a.changed).map(a => a.what)}, null, 2));
