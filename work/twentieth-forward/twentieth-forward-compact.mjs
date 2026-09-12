// Generates the compact binding-forward transaction, in the exact shape the nineteenth forward
// was actually executed in.
//
// Two forms of the nineteenth forward exist. ActualNineteenthForward.sql (126KB) inlines the whole
// rebuilt getter; its receipt says "Not the text sent to the database". The 23KB
// ActualNineteenthForward.executed-compact.sql is what ran: it reads the current getter's prosrc
// from the live database, performs in-database the same two edits buildExactGetter performs,
// asserts the rebuilt string's sha256 equals a value computed offline, and only then executes it.
// 107,827 characters never leave the database, and the result must still match byte for byte.
//
// That compact was hand-written. There is no generator to reproduce. So this script uses the
// executed compact itself as the template, and replaces only the literals that are specific to
// the nineteenth forward -- each with a pinned occurrence count. Everything not listed stays
// byte-identical to what ran.
//
// SELF-TEST (--replay): fed the nineteenth forward's own recorded inputs, the output must equal
// ActualNineteenthForward.executed-compact.sql byte for byte. Every replacement becomes an
// identity replacement, so any drift in how a literal is derived shows up as a mismatch. Three
// prerequisites for this were verified before writing it: the compact's v_norm digest is
// derivable from the recorded pg_get_functiondef capture; normalisation round-trips (the
// eighteenth's offline getter digest equals the live-normalised one); and the compact's
// hand-written fragment is byte-identical to sqlEscape(buildExactGetter's fragment).
//
// RISK. This transaction writes: it replaces a SECURITY DEFINER function, appends a row to an
// append-only table, and CASes execution_current.sequence. A wrong event cannot be deleted. It is
// to be run only after independent review, and after a guards-only dry run with no writes.
//
// Usage:
//   node twentieth-forward-compact.mjs <input.json> [--replay] [--out-sql f] [--out-prep f]
//
// input.json has buildForward's shape (actual_preimage, gate_definition_raw, idempotency_key,
// previous_getter_definition_raw, source_materials) plus, outside --replay, control_plane:
//   { reserve_execution_budget_prosrc_sha256, reserve_gate_prosrc_sha256,
//     append_status_manifest_prosrc_sha256, accepted_binding_expires_at, guard_exception_name }
// The first three are the POST-CP-01 digests; the window is the POST-NW-01 value.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const quote = x => "'" + x.replaceAll("'", "''") + "'";
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const json = x => JSON.stringify(stable(x));
const sqlEscape = s => s.replaceAll("'", "''");

const NINETEENTH_DIR = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window9-corrected-binding';
const TEMPLATE_PATH = path.join(REPO, NINETEENTH_DIR, 'ActualNineteenthForward.executed-compact.sql');
const TEMPLATE_SHA256 = '23cab1118cc5c707718a92924d5e29f7a7c2c0abcd3afee2f95c89174cc115b6'; // receipt: artifacts.executed_sql.sha256
const ROOT_ID = 'ctr_414bd3c724264a83894b0c55cf2ab878';

// Values specific to the nineteenth forward, as they appear in the template. Each is replaced with
// a pinned count. Named here so the replay can assert the template is what the receipt says it is.
const N19 = {
  tag: '$nf19$',
  reserve_execution_budget: 'df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41',
  reserve_gate: 'a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e',
  append_status_manifest: '94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615',
  guard_exception: 'accepted_root5_window9_capacity_repair_required',
  window: '2026-09-12T13:14:51Z',
  rows_sha256: '4ec5dc246a4cb96bc687914b3328131599ba71caf3ca1f9a3c080485d7e7ba6f',
  catalog_sha256: '73c6f301fbf0e239f9750519e51970a576d98ec54698f9caa49022861cd23f1e',
  getter_definition_sha256: '3d3c9624204fb10e5d0147bb06c7f265043014f612a2e30abbfb0311a0ca092d',
  v_norm_sha256: '7f7caeddd5e48734f2e802cce9edd66ec452e9aba1dd34c828ab00c5c593b2a2',
  v_new_sha256: 'f97d85852a722697cd66b3e73ae79e40144c907a51b85fe5d7a3631aa9eda354',
  prosrc_after: 'c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16',
  key: 'root5-window9-corrected-binding-20260911',
  event_exception: 'exact_real_nineteenth_forward_event_required',
  prev_seq: 87, next_seq: 88, existing_forwards: 18,
};
const ORDINAL = {19: 'nineteenth', 20: 'twentieth'};

// ---- arguments ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const inputPath = argv[0];
assert.ok(inputPath && !inputPath.startsWith('--'), 'USAGE: see header');
const replay = argv.includes('--replay');
const arg = n => argv.includes(n) ? argv[argv.indexOf(n) + 1] : null;
const outSql = arg('--out-sql'), outPrep = arg('--out-prep');

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
assert.deepEqual(Object.keys(input).filter(k => k !== 'control_plane').sort(),
  ['actual_preimage', 'gate_definition_raw', 'idempotency_key', 'previous_getter_definition_raw', 'source_materials'],
  'INPUT_SHAPE');
const cp = replay ? {
  reserve_execution_budget_prosrc_sha256: N19.reserve_execution_budget,
  reserve_gate_prosrc_sha256: N19.reserve_gate,
  append_status_manifest_prosrc_sha256: N19.append_status_manifest,
  accepted_binding_expires_at: N19.window,
  guard_exception_name: N19.guard_exception,
} : input.control_plane;
assert.ok(cp, 'CONTROL_PLANE_REQUIRED — post-CP-01 prosrc digests and post-NW-01 window');
for (const k of ['reserve_execution_budget_prosrc_sha256', 'reserve_gate_prosrc_sha256', 'append_status_manifest_prosrc_sha256'])
  assert.match(cp[k] ?? '', /^[a-f0-9]{64}$/, 'control_plane.' + k);
assert.match(cp.accepted_binding_expires_at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'control_plane.accepted_binding_expires_at');
assert.match(cp.guard_exception_name ?? '', /^[a-z0-9_]{1,80}$/, 'control_plane.guard_exception_name');

// ---- the getter builder for THIS forward count ---------------------------------------------------
// The nineteenth used a builder asserting existing_forwards<19; the derived module asserts <20.
// Both produce identical output for the nineteenth's inputs (proven by selftest-reproduce-nineteenth).
const {buildExactGetter} = await import(path.join(HERE, 'exact-getter-root6-window11.candidate.mjs'));

// ---- preimage, mirroring buildForward's checks ---------------------------------------------------
const p = input.actual_preimage.row, c = p.execution_current;
for (const h of [p.rows_sha256, p.catalog_sha256, p.previous_getter_definition_sha256, p.previous_getter_prosrc_sha256])
  assert.match(h, /^[a-f0-9]{64}$/);
assert.equal(p.server_timezone, 'UTC');
assert.equal(p.accepted_project_ref, 'uscrdifznmlvczcekqpw');
assert.equal(c.root_id, ROOT_ID);
assert.equal(c.active_ga_id, null);
assert.equal(c.pending_budget_sequence, null);
assert.equal(Number(c.charged_seconds), 9906, 'CHARGED_SECONDS_MUST_STILL_BE_9906 — the single allocation must be unspent');
assert.equal(Number(c.charged_evidence_bytes), 2201594803);
const existing = Number(p.existing_forwards), N = existing + 1, seq = Number(c.sequence), next = seq + 1;
// The successor-count whitelist inside effective_execution_binding, as a literal list.
const listOf = n => Array.from({length: n}, (_, i) => i + 1).join(',');
assert.ok(ORDINAL[N], 'THIS_SCRIPT_ONLY_KNOWS_FORWARDS_19_AND_20, got ' + N);
if (replay) { assert.equal(N, 19, 'REPLAY_IS_THE_NINETEENTH'); assert.equal(seq, N19.prev_seq); }
else {
  assert.equal(N, 20, 'REAL_RUN_MUST_BE_THE_TWENTIETH');
  assert.equal(seq, 88, 'EXECUTION_SEQUENCE_MUST_BE_88 — the nineteenth forward landed at 88');
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
if (!replay) assert.equal(vNormSha, N19.v_new_sha256,
  'NORMALISED_LIVE_GETTER_IS_NOT_THE_NINETEENTH_FORWARD_OUTPUT — expected f97d8585 (normalisation round-trips), got ' + vNormSha);

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
if (!replay) assert.notEqual(materials.controller_manifest.ref.sha256, 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa',
  'CONTROLLER_MANIFEST_IS_STILL_THE_ROOT5_ONE — the twentieth forward must move to the rebuilt controller');
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
const guardOf = n => 'if n not in (' + Array.from({length: n}, (_, i) => i + 1).join(',') + ')';
const END = ' return next result;\nend $$;';
const prefix = vNorm.replace(guardOf(existing), guardOf(N));
assert.equal(built.sql.slice(0, prefix.length - END.length), prefix.slice(0, prefix.length - END.length), 'BUILDER_PREFIX_DRIFT');
const fragment = built.sql.slice(prefix.length - END.length);
assert.ok(fragment.startsWith(` if n=${existing} then return next result;return;end if;`), 'FRAGMENT_SHAPE');
const body = s => { assert.equal(s.split('$$').length, 3); const m = s.match(/as \$\$([\s\S]*)\$\$;/i); assert.ok(m); return m[1]; };
const vNewSha = sha(built.sql), prosrcAfter = sha(body(built.sql));

// ---- template ------------------------------------------------------------------------------------
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
assert.equal(sha(template), TEMPLATE_SHA256, 'TEMPLATE_IS_NOT_THE_EXECUTED_NINETEENTH_COMPACT');
const FS = "v_new:=replace(v_new,' return next result;\nend $$;','", FE = "');\nif encode(sha256(convert_to(v_new";
const fa = template.indexOf(FS) + FS.length, fb = template.indexOf(FE, fa);
assert.ok(fa > FS.length && fb > fa, 'TEMPLATE_FRAGMENT_NOT_FOUND');
const templateFragment = template.slice(fa, fb);
assert.equal(templateFragment.length, 5630, 'TEMPLATE_FRAGMENT_LENGTH');
let out = template.slice(0, fa) + '<<FRAGMENT>>' + template.slice(fb);
const lines = template.split('\n');
const literalOn = (lineIdx, pre, post) => { const l = lines[lineIdx]; const s = l.indexOf(pre) + pre.length; return l.slice(s, l.indexOf(post, s)); };
const lit22 = literalOn(21, "is distinct from '", "'::jsonb");
const lit51 = literalOn(50, "request_body:='", "'::jsonb");
const lit69 = literalOn(68, "effective_execution_binding() x) is distinct from '", "'::jsonb");
assert.equal(lit22.length, 373); assert.equal(lit51.length, 4134); assert.equal(lit69.length, 729);

// Order matters in one place: the v_new target (f97d8585) is rewritten BEFORE the v_norm site, because
// for the twentieth forward the new v_norm digest IS f97d8585, and a later replaceAll would clobber it.
const R = [
  ['do tag',                 N19.tag,                          `$nf${N}$`,                                            2],
  // The three big literals are anchored in their surrounding context. The new_binding JSON on line
  // 69 is also a substring of line 51's request_body, so a bare match would count twice in replay
  // (where old == new); the context makes each site unique in both modes.
  ['line22 exec_current',    `execution_current x where root_id='${ROOT_ID}') is distinct from '${lit22}'::jsonb`,
                             `execution_current x where root_id='${ROOT_ID}') is distinct from '${json(c)}'::jsonb`, 1],
  ['line51 request_body',    `request_body:='${lit51}'::jsonb`,
                             `request_body:='${json({new_binding: newBinding, previous_binding: p.previous_binding, source_acceptance_refs: refs})}'::jsonb`, 1],
  ['line69 final binding',   `effective_execution_binding() x) is distinct from '${lit69}'::jsonb`,
                             `effective_execution_binding() x) is distinct from '${json(newBinding)}'::jsonb`, 1],
  ['fragment',               '<<FRAGMENT>>',                   sqlEscape(fragment),                                   1],
  ['v_new target',           N19.v_new_sha256,                 vNewSha,                                               1],
  ['v_norm digest',          N19.v_norm_sha256,                vNormSha,                                              1],
  ['getter def digest',      N19.getter_definition_sha256,     p.previous_getter_definition_sha256,                   1],
  ['prosrc after',           N19.prosrc_after,                 prosrcAfter,                                           1],
  ['rows sha',               N19.rows_sha256,                  p.rows_sha256,                                         1],
  ['catalog sha',            N19.catalog_sha256,               p.catalog_sha256,                                      1],
  ['reserve_execution_budget', N19.reserve_execution_budget,   cp.reserve_execution_budget_prosrc_sha256,             1],
  ['reserve_gate',           N19.reserve_gate,                 cp.reserve_gate_prosrc_sha256,                         1],
  ['append_status_manifest', N19.append_status_manifest,       cp.append_status_manifest_prosrc_sha256,               1],
  ['guard exception',        N19.guard_exception,              cp.guard_exception_name,                               1],
  ['window',                 `'${N19.window}'`,                `'${cp.accepted_binding_expires_at}'`,                 2],
  ['guard replace',          `'${guardOf(18)}','${guardOf(19)}'`, `'${guardOf(existing)}','${guardOf(N)}'`,          1],
  // R18-F3. effective_execution_binding() carries a whitelist of permitted successor counts, and
  // raises at_most_four_exact_binding_successors_required for anything outside it -- the name still
  // says four; the list has been extended by one at every forward since. The nineteenth's compact
  // does that with an in-database replace(), and this generator inherited the line verbatim without
  // ever substituting it. Left alone, the twentieth forward appends its event and then makes
  // effective_execution_binding() raise for n=20, which takes read_execution() down with it -- and
  // read_execution() is the trusted entry's first call. Nobody had listed this step in seventeen
  // rounds of scheduling. The pinned count of 1 is what makes the omission impossible to repeat.
  ['successor whitelist',    `'if n not in (${listOf(18)})','if n not in (${listOf(19)})'`,
                             `'if n not in (${listOf(existing)})','if n not in (${listOf(N)})'`,    1],
  ['insert seq+key',         `',${N19.next_seq},'${N19.key}'`, `',${next},'${key}'`,                                  1],
  ['cas update',             `set sequence=${N19.next_seq} where root_id='${ROOT_ID}' and sequence=${N19.prev_seq}`, `set sequence=${next} where root_id='${ROOT_ID}' and sequence=${seq}`, 1],
  ['readback ev',            `e.sequence=${N19.next_seq};`,    `e.sequence=${next};`,                                 1],
  ['readback compare',       `'sequence',${N19.next_seq},'idempotency_key','${N19.key}'`, `'sequence',${next},'idempotency_key','${key}'`, 1],
  ['event exception',        N19.event_exception,              `exact_real_${ORDINAL[N]}_forward_event_required`,     1],
  ['expected_rows seq',      `to_jsonb(${N19.next_seq}::bigint)`, `to_jsonb(${next}::bigint)`,                        1],
];
const applied = [];
for (const [what, from, to, count] of R) {
  const n = out.split(from).length - 1;
  assert.equal(n, count, `OCCURRENCE_COUNT:${what}: expected ${count}, found ${n}`);
  // Function replacer, never a string: a string `to` has String.replaceAll interpret "$$" as a
  // literal "$", which turned "end $$;" into "end $;" -- one byte, found only by the replay.
  // buildExactGetter and the original buildForward both use () => value for the same reason.
  out = out.replaceAll(from, () => to);
  applied.push({what, count, changed: from !== to});
}

// Nothing nineteenth-specific may survive a real run. (In replay everything above was an identity
// replacement and the byte-equality check below is the whole point.)
if (!replay) {
  for (const [name, v] of [['$nf19$', N19.tag], ['7f7caedd', N19.v_norm_sha256], ['3d3c9624', N19.getter_definition_sha256],
      ['4ec5dc24', N19.rows_sha256], ['73c6f301', N19.catalog_sha256], ['c721b056', N19.prosrc_after],
      ['19th key', N19.key], ['exact_bounded_forward_19', 'exact_bounded_forward_19_required'],
      ['accepted_root5_window9', N19.guard_exception], ['nineteenth event', N19.event_exception]])
    assert.equal(out.split(v).length, 1, 'NINETEENTH_LITERAL_SURVIVED:' + name);
  assert.equal(out.split(N19.v_new_sha256).length - 1, 1, 'f97d8585 must appear exactly once, as the twentieth v_norm digest');
  assert.equal(out.split('exact_bounded_forward_20_required').length - 1, 1);
  assert.equal(out.split(`offset ${existing} limit 1`).length - 1, 1);
} else if (out !== template) {
  // Locate the first differing byte rather than printing two 23KB strings.
  let i = 0; while (i < out.length && i < template.length && out[i] === template[i]) i++;
  const line = template.slice(0, i).split('\n').length;
  const show = s => JSON.stringify(s.slice(Math.max(0, i - 80), i + 120));
  throw new assert.AssertionError({message:
    `REPLAY_DOES_NOT_REPRODUCE_THE_EXECUTED_NINETEENTH_COMPACT_BYTE_FOR_BYTE\n` +
    `  first difference at offset ${i} (template line ${line}); lengths out=${out.length} template=${template.length}\n` +
    `  template: ${show(template)}\n  output:   ${show(out)}`});
}

// --dry-run: the entire transaction is a single `do` block between begin; and commit;, so replacing
// the trailing commit with rollback yields a FULL rehearsal -- every guard, the in-database getter
// rebuild, the digest admission, the execute, the event insert, the sequence CAS and the readback
// all run, and then none of it persists. CREATE OR REPLACE FUNCTION is transactional in Postgres,
// the inserted row and the CAS are undone, and this transaction consumes no sequences. Addendum C
// required a guards-only dry run before the real one; this is stronger than that.
const dryRun = argv.includes('--dry-run');
if (dryRun) {
  assert.ok(!replay, 'DRY_RUN_AND_REPLAY_ARE_EXCLUSIVE');
  assert.ok(out.endsWith('commit;\n'), 'TEMPLATE_MUST_END_WITH_COMMIT');
  assert.equal(out.split('commit;').length - 1, 1, 'EXACTLY_ONE_COMMIT');
  out = out.slice(0, -'commit;\n'.length) + 'rollback;\n';
}

const prep = {
  state: replay ? 'REPLAY_REPRODUCED_EXECUTED_NINETEENTH_COMPACT'
       : dryRun ? 'TWENTIETH_FORWARD_COMPACT_DRY_RUN_ROLLBACK_NO_PERSISTENT_EFFECT'
       : 'TWENTIETH_FORWARD_COMPACT_CANDIDATE_NOT_REVIEWED_NOT_EXECUTED',
  persists: !replay && !dryRun,
  executed_form: 'COMPACT_IN_DATABASE_REBUILD_WITH_OFFLINE_DIGEST_ADMISSION',
  template: {path: NINETEENTH_DIR + '/ActualNineteenthForward.executed-compact.sql', sha256: TEMPLATE_SHA256},
  sha256: sha(out), bytes: Buffer.byteLength(out),
  forward_number: N, previous_sequence: seq, next_sequence: next, idempotency_key: key,
  getter: {v_norm_sha256_expected: vNormSha, v_new_sha256_target: vNewSha, prosrc_sha256_after: prosrcAfter,
           previous_definition_sha256: p.previous_getter_definition_sha256},
  control_plane_guards: cp,
  new_binding: newBinding, previous_binding: p.previous_binding, source_acceptance_refs: refs,
  actual_preimage_ref: input.actual_preimage.observation_ref,
  replacements: applied,
  authority_effect: 'NONE',
};
if (outSql) fs.writeFileSync(outSql, out);
if (outPrep) fs.writeFileSync(outPrep, JSON.stringify(prep, null, 2) + '\n');
console.log(JSON.stringify({...prep, new_binding: undefined, previous_binding: undefined, source_acceptance_refs: undefined, replacements: applied.filter(a => a.changed).map(a => a.what)}, null, 2));
