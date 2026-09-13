#!/usr/bin/env node
// Generates the two CP-01 SQL files from one substitution table, so that the read-only
// derivation and the real transaction can never carry different replacement text.
//
//   node work/cp01/build-cp01-sql.mjs
//
// Writes:
//   work/cp01/cp01-derive.sql            read-only; safe to run any number of times
//   work/cp01/cp01-apply.candidate.sql   the single transaction; refuses to run until the
//                                        post-image digests from the derive run are pinned
//
// Why two files rather than one script that transcribes the function bodies: the three bodies
// are 31,740 characters and live only in the database. Copying them through this repository by
// hand is exactly where the `end $$;` -> `end $;` class of error comes from (one byte, invisible
// to every count pin, caught only by byte-equality replay). So neither file contains a function
// body. Both derive the post-image in-database from the same pinned substitution table, and the
// transaction asserts that its derivation equals the digest the read-only run recorded offline.
// The reviewer can re-run cp01-derive.sql read-only and reproduce that digest independently.
//
// Both files carry the substitution table as a single VALUES list, so every literal appears
// exactly once in each file and the two lists are generated from the same source bytes.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(fs.readFileSync(path.join(HERE, 'cp01-substitutions.json'), 'utf8'));

const PERMITTED = [
  'LIVE_ROOT_GENERATION_ROOT5_TO_ROOT6',
  'BOUND_OPEN_ENDED_SEQUENCE_GE_64_SEGMENT_TO_GE_64_AND_LT_89_AND_ADD_GE_89_ROOT6_SEGMENT',
  'SUPERSEDED_WINDOW_LITERALS_TO_THIS_WINDOW_MATERIALIZED_TIMESTAMPS',
  'STATUS_MANIFEST_SCHEMA_DIGEST_TO_DIGEST_CARRIED_BY_THIS_RUN_CONTROLLER_INCLUDING_ALLOW_LIST',
  'BINDING_FORWARD_CAP_SERIES_F_15_TO_16',
  // Added by the Round 10 adjudication (SuccessorReviewerRound10.md section 8, option (e)).
  // This one is NOT yet in the Owner approval candidate's cp01.permitted_edit_classes: the
  // reviewer's R10-C9 supplies the wording and the Owner has to grant it, including an explicit
  // carve-out from cp01.prohibited -> REMOVING_ORIGINAL_BYTES_CHECKS. Until that lands, this
  // generator emits a DRAFT.
  'FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_THIS_WINDOW_WITH_REGISTRATION_EVENT_RECORDED_AT_EXCLUDED',
];
// Granted by the Owner merge of PR #158, commit cbe898d3f5b66f279d78a6b8d583d2c1885d9c89, which
// carried ExplicitOwnerApproval.candidate.json with all six classes and the explicit carve-out from
// REMOVING_ORIGINAL_BYTES_CHECKS. Verified by capture-owner-merge.mjs against every condition in
// trusted-github.mjs verifyOwnerMergeArtifact; evidence in next-window-20260912/
// OwnerApprovalVerification.json. Nothing is awaiting authorization now.
const NOT_YET_AUTHORISED = [];

const TABLES = ['accepted_binding','control_objects','current_head','events',
                'execution_binding','execution_current','execution_events','gate_attempts'];

const TAG = 'cp01lit';
const DOTAG = 'cp01tx';   // outer dollar-quote tag for the DO block. Must not be formable by
                          // concatenating $cp01lit$ with the start of any literal.
const fail = m => { console.error('REFUSED: ' + m); process.exit(1); };

// ---- validation -------------------------------------------------------------------------

const ids = new Set();
let total = 0;
for (const fn of table.functions) {
  if (!fn.edits.length) fail(`${fn.function} has no edits`);
  for (const e of fn.edits) {
    total++;
    if (ids.has(e.id)) fail(`duplicate edit id ${e.id}`);
    ids.add(e.id);
    if (!PERMITTED.includes(e.edit_class))
      fail(`${e.id} carries edit_class ${e.edit_class}, which is not one of cp01.permitted_edit_classes`);
    if (e.from === e.to) fail(`${e.id} is a no-op`);
    if (!Number.isInteger(e.expected_count) || e.expected_count < 1) fail(`${e.id} has no expected_count`);
    for (const [k, v] of [['from', e.from], ['to', e.to]])
      if (v.includes('$' + TAG + '$')) fail(`${e.id}.${k} contains the dollar-quote tag`);
  }
}
if (total !== table.totals.edits_in_this_table)
  fail(`table declares ${table.totals.edits_in_this_table} edits, found ${total}`);
if (total !== 21)
  fail(`expected 21 edits (19 from ControlPlaneChangeScope.md section 7, plus G8/B9 from the ` +
       `Round 10 adjudication); found ${total}. Change this number deliberately, not incidentally.`);

// Anything still carrying a __PLACEHOLDER__ makes the transaction a draft, not a runnable file.
const placeholders = [];
const unauthorised = [];
for (const fn of table.functions) for (const e of fn.edits) {
  for (const m of e.to.match(/__[A-Z0-9_]+__/g) || []) placeholders.push(`${e.id}: ${m}`);
  if (NOT_YET_AUTHORISED.includes(e.edit_class)) unauthorised.push(`${e.id}: ${e.edit_class}`);
}

// Dollar-quote a literal. Every substitution in this file uses a function replacer, because a
// string replacement reads `$$` and `$&` in the replacement as backreferences.
const lit = s => '$' + TAG + '$' + s + '$' + TAG + '$';
const q = s => "'" + s.replaceAll("'", () => "''") + "'";
const short = f => f.function.split('.')[1].split('(')[0];
const args = f => f.function.slice(f.function.indexOf('(') + 1, -1);

// The substitution table, as SQL. Identical bytes in both generated files.
const subsValues = fn => fn.edits.map((e, i) =>
  `    (${i + 1}, ${q(e.id)}, ${e.expected_count}, ${lit(e.from)},\n        ${lit(e.to)})`
).join(',\n');

const banner = title => `-- ${'='.repeat(88)}
-- ${title}
-- generated by work/cp01/build-cp01-sql.mjs from work/cp01/cp01-substitutions.json
-- DO NOT EDIT THIS FILE. Edit the substitution table and regenerate.
-- ${'='.repeat(88)}
`;

// ---- cp01-derive.sql --------------------------------------------------------------------

let derive = banner('CP-01 read-only derivation. Performs no write of any kind.') +
`--
-- Runs only SELECT. It reads pg_proc.prosrc and pg_get_functiondef(), folds the pinned
-- substitutions over both in order, and reports per function:
--   pre_matches         the pre-image digest still equals the pinned one (drift check)
--   steps               per edit: occurrences found just before it was applied, and whether
--                       the same count holds over the full CREATE statement
--   all_counts_ok       every edit matched its expected occurrence count exactly
--   post_prosrc_sha     the value to pin into cp01-apply.candidate.sql
--   pre/post_prosrc_len length delta is a second, independent witness
--
-- The already-broken root digest guard (reserve_gate:35, reserve_execution_budget:40) IS in this
-- table, as edits G8/B9, in the shape Round 10 adjudicated (option (e)).
`;

if (placeholders.length) derive += `--
-- CAUTION: the substitution table still carries unresolved placeholders
${placeholders.map(x => `--   ${x}`).join('\n')}
-- so the post_prosrc_sha this query returns describes text that still contains them.
-- It is NOT the value to pin. Resolve the placeholders first
-- (work/cp01/measure-root6-root-digest.sql, after root6 is REGISTERED), then re-run this.
`;

// One statement, three functions. A single WITH RECURSIVE clause may hold several CTEs, so the
// three folds sit side by side and the result is one row per function. Emitting one statement
// rather than three means whoever runs this transcribes it into a client exactly once.
const foldBlock = (fn, k) => {
  const p = 'f' + k;
  return `${p}_subs(i, id, want, f, t) as (values
${subsValues(fn)}
),
${p}_base as (
  select p.prosrc as s, pg_get_functiondef(p.oid) as d
  from pg_proc p
  where p.oid = ${q(fn.function)}::regprocedure
),
${p}_fold(i, id, want, cnt, dcnt, s, d) as (
  select 0, null::text, null::int, null::bigint, null::bigint, s, d from ${p}_base
  union all
  select ${p}_subs.i, ${p}_subs.id, ${p}_subs.want,
         (length(${p}_fold.s) - length(replace(${p}_fold.s, ${p}_subs.f, ''))) / length(${p}_subs.f),
         (length(${p}_fold.d) - length(replace(${p}_fold.d, ${p}_subs.f, ''))) / length(${p}_subs.f),
         replace(${p}_fold.s, ${p}_subs.f, ${p}_subs.t),
         replace(${p}_fold.d, ${p}_subs.f, ${p}_subs.t)
  from ${p}_fold join ${p}_subs on ${p}_subs.i = ${p}_fold.i + 1
)`;
};

const reportBlock = (fn, k) => {
  const p = 'f' + k;
  return `select
  ${k + 1} as ord,
  ${q(fn.function)} as function,
  (select encode(sha256(convert_to(s, 'UTF8')), 'hex') from ${p}_base) = ${q(table.preimage_prosrc_sha256[fn.function])} as pre_matches,
  (select bool_and(cnt = want and cnt = dcnt) from ${p}_fold where i > 0) as all_counts_ok,
  (select count(*) from ${p}_fold where i > 0) = ${fn.edits.length} as all_steps_ran,
  (select jsonb_agg(jsonb_build_object('id', id, 'found', cnt, 'expected', want,
                                       'def_agrees', cnt = dcnt) order by i)
     from ${p}_fold where i > 0) as steps,
  (select length(s) from ${p}_base) as pre_len,
  length(s) as post_len,
  encode(sha256(convert_to(s, 'UTF8')), 'hex') as post_prosrc_sha
from ${p}_fold where i = ${fn.edits.length}`;
};

derive += `
with recursive ${table.functions.map(foldBlock).join(',\n')}
${table.functions.map(reportBlock).join('\nunion all\n')}
order by ord;
`;

// ---- cp01-apply.candidate.sql -----------------------------------------------------------

const pinned = table.postimage_prosrc_sha256 || {};
const missing = table.functions.filter(f => !/^[0-9a-f]{64}$/.test(pinned[f.function] || ''));
const draft = placeholders.length > 0 || unauthorised.length > 0 || missing.length > 0;

// ---- guards added after round 11 ------------------------------------------------------------
// R11-F12: the only condition that flips with time must be inside the transaction, not only in a
// preflight run beforehand. R11-F13: a prohibition stated in the approval is not a guard; the
// eleven other control-plane functions are pinned here so the transaction enforces what
// cp01.prohibited only asserts.
const G = table.transaction_guards_added_after_round_11;
const UNTOUCHED_DIGEST_EXPR = `(select encode(sha256(convert_to(string_agg(sig||'='||sha, E'\\n' order by sig),'UTF8')),'hex')
     from (select p.oid::regprocedure::text as sig,
                  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as sha
             from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
            where n2.nspname = 'clued_control'
              and p.oid::regprocedure::text not in (${table.functions.map(f => q(f.function)).join(', ')})) u)`;

const roundElevenGuards = tag => `
  -- R11-F12: inside the Owner window. The one condition that changes on its own, so it belongs
  -- here and not only in a preflight taken minutes earlier.
  if not (clock_timestamp() >= ${q(G.window_assertion.not_before)}::timestamptz
          and clock_timestamp() < ${q(G.window_assertion.expires_at)}::timestamptz) then
    raise exception 'CP01_${tag}OUTSIDE_THE_OWNER_WINDOW: % is not within [% , %)',
      clock_timestamp(), ${q(G.window_assertion.not_before)}, ${q(G.window_assertion.expires_at)};
  end if;

  -- R11-F13: every clued_control function this transaction does not replace, pinned as one digest.
  select count(*) into c from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'clued_control';
  if c <> ${G.untouched_functions_assertion.total_functions_in_schema} then
    raise exception 'CP01_${tag}FUNCTION_COUNT_DRIFT: %', c;
  end if;
  got := ${UNTOUCHED_DIGEST_EXPR};
  if got is distinct from ${q(G.untouched_functions_assertion.digest)} then
    raise exception 'CP01_${tag}UNTOUCHED_FUNCTIONS_DRIFT: %', got;
  end if;

  -- R11-F13, the half the NW-01 receipt recorded as still owed: accepted_binding must carry
  -- exactly one non-internal trigger, it must be the immutability trigger, and it must be
  -- enabled. NW-01 turned it off and back on; nothing has asserted since that it stayed on,
  -- and this transaction's window guard trusts a row that trigger is what protects.
  select count(*) into c from pg_trigger t
   where t.tgrelid = 'clued_control.accepted_binding'::regclass and not t.tgisinternal;
  if c <> ${G.accepted_binding_trigger_assertion.expected_non_internal_triggers} then
    raise exception 'CP01_${tag}ACCEPTED_BINDING_TRIGGER_COUNT: %', c;
  end if;
  -- tgenabled is "char", and text || "char" is ambiguous (42725). The cast is not cosmetic:
  -- without it this statement fails to parse and the guard aborts the transaction it is
  -- supposed to be protecting.
  select t.tgname || ':' || t.tgenabled::text into got from pg_trigger t
   where t.tgrelid = 'clued_control.accepted_binding'::regclass and not t.tgisinternal;
  if got is distinct from ${q(G.accepted_binding_trigger_assertion.expected_trigger_name + ':' +
                              G.accepted_binding_trigger_assertion.expected_tgenabled)} then
    raise exception 'CP01_${tag}ACCEPTED_BINDING_TRIGGER_DRIFT: %', got;
  end if;`;

let apply = banner(draft
  ? 'CP-01 DRAFT transaction. MUST NOT BE RUN. See the blocking list immediately below.'
  : 'CP-01 candidate transaction. NOT YET AUTHORISED TO RUN.') +
(draft ? `--
-- ${'!'.repeat(84)}
-- THIS FILE IS A DRAFT AND MUST NOT BE EXECUTED. Blocking:
${placeholders.map(x => `--   unresolved placeholder   ${x}`).join('\n') || '--   (no unresolved placeholders)'}
${unauthorised.map(x => `--   edit class not yet granted by the Owner   ${x}`).join('\n') || '--   (all edit classes granted)'}
${missing.map(f => `--   post-image digest unpinned   ${f.function}`).join('\n') || '--   (all post-image digests pinned)'}
-- ${'!'.repeat(84)}
--
` : '') +
`--
-- Preconditions, none of which this file can check for you:
--   1. Owner has merged ExplicitOwnerApproval, including the cp01 clause, on main.
--   2. Round 10 has adjudicated the already-broken root digest guard
--      (reserve_gate:35 / reserve_execution_budget:40). This file does NOT touch it.
--      If the adjudication puts it inside CP-01, it becomes a twentieth entry in the
--      substitution table and every digest below changes.
--   3. NW-01 has already run (runbook step 8), so accepted_binding.expires_at is T+24h,
--      that is C1.committed_at + 86400 seconds. G2/B2 pin that value; this transaction does
--      not set it. It is NOT 2026-09-19T00:00:00Z -- a 86400-second non-rolling window cannot
--      reach a date seven days out; see ControlPlaneChangeScopeAddendumA.
--   4. This file has been read by the independent reviewer.
--
-- Shape follows the established precedent (runtime-successor/binding-evidence-successor/
-- alter.candidate.sql and ActualNineteenthForward.sql): one transaction, ACCESS EXCLUSIVE on
-- all eight clued_control tables, opening prosrc digest assertions for all four functions
-- including the one that must NOT change, abort on any drift, read-only readback after.
--
-- No function body appears in this file. Each body is read from pg_proc inside the transaction,
-- folded through the pinned substitutions, checked against a digest computed by the read-only
-- run of cp01-derive.sql, and only then executed. Any drift between that run and this one
-- aborts before a single CREATE OR REPLACE is issued.
--
-- Rollback: every statement here is a CREATE OR REPLACE inside one transaction. Until COMMIT
-- nothing is visible; after COMMIT the previous bodies are recoverable only from the archived
-- pre-image, so archive the output of cp01-derive.sql BEFORE running this.
--
-- Interruption: if this transaction is cut off, do NOT re-run it blindly. Read the four prosrc
-- digests first. All four at their pre-image values means nothing committed and it may be run
-- again; anything else is a partial state that needs its own decision.

begin;

set local statement_timeout = '120s';
set local lock_timeout = '30s';

lock table ${TABLES.map(t => 'clued_control.' + t).join(',\n     ')}
  in access exclusive mode;

do $${DOTAG}$
declare
  src text; def text; c bigint; want text; got text; rec record; n int;
begin
`;

for (const [sig, sha] of Object.entries(table.preimage_prosrc_sha256)) {
  apply += `
  select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') into got
  from pg_proc p where p.oid = ${q(sig)}::regprocedure;
  if got is distinct from ${q(sha)} then
    raise exception 'CP01_PREIMAGE_DRIFT % expected % got %', ${q(sig)}, ${q(sha)}, coalesce(got, '<absent>');
  end if;`;
}

apply += roundElevenGuards('');

apply += `

  -- clued_control.effective_execution_binding() is asserted above and MUST NOT be replaced here.
  -- It may change only via APPEND_ONLY_BINDING_FORWARD_TRANSACTION_RECORDING_EXECUTION_BINDING_
  -- FORWARD_ACCEPTED (runbook step 14), never by CREATE OR REPLACE.
`;

for (const fn of table.functions) {
  const post = pinned[fn.function];
  apply += `
  -- ${'-'.repeat(84)}
  -- ${fn.function} — ${fn.edits.length} edits
  -- ${'-'.repeat(84)}
  select p.prosrc, pg_get_functiondef(p.oid) into src, def
  from pg_proc p where p.oid = ${q(fn.function)}::regprocedure;

  n := 0;
  for rec in select * from (values
${subsValues(fn)}
  ) as v(i, id, want, f, t) order by i loop
    n := n + 1;
    if n <> rec.i then raise exception 'CP01_STEP_OUT_OF_ORDER % %', n, rec.i; end if;
    c := (length(src) - length(replace(src, rec.f, ''))) / length(rec.f);
    if c <> rec.want then
      raise exception 'CP01_COUNT_% expected % occurrences, found %', rec.id, rec.want, c;
    end if;
    if c <> (length(def) - length(replace(def, rec.f, ''))) / length(rec.f) then
      raise exception 'CP01_COUNT_DISAGREES_BODY_VS_DEFINITION_%', rec.id;
    end if;
    src := replace(src, rec.f, rec.t);
    def := replace(def, rec.f, rec.t);
  end loop;
  if n <> ${fn.edits.length} then
    raise exception 'CP01_EXPECTED_%_EDITS_APPLIED_%', ${fn.edits.length}, n;
  end if;

  want := ${post ? q(post) : `'__PIN_FROM_cp01-derive.sql__'`};
  got  := encode(sha256(convert_to(src, 'UTF8')), 'hex');
  if got is distinct from want then
    raise exception 'CP01_POSTIMAGE_DRIFT % expected % got %', ${q(fn.function)}, want, got;
  end if;

  execute def;

  select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') into got
  from pg_proc p where p.oid = ${q(fn.function)}::regprocedure;
  if got is distinct from want then
    raise exception 'CP01_READBACK_MISMATCH % expected % got %', ${q(fn.function)}, want, got;
  end if;
`;
}

apply += roundElevenGuards('POST_');

apply += `
  -- The one function that must be byte-identical to how it started.
  select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') into got
  from pg_proc p where p.oid = 'clued_control.effective_execution_binding()'::regprocedure;
  if got is distinct from ${q(table.preimage_prosrc_sha256['clued_control.effective_execution_binding()'])} then
    raise exception 'CP01_UNTOUCHED_FUNCTION_CHANGED %', got;
  end if;
end
$${DOTAG}$;

-- In-transaction readback. Archive this alongside the exact input above.
select p.proname,
       encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as prosrc_sha256,
       length(p.prosrc) as prosrc_len
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'clued_control'
  and p.proname in ('append_status_manifest','effective_execution_binding',
                    'reserve_execution_budget','reserve_gate')
order by p.proname;

commit;

-- After COMMIT, run the SAME select again in a separate read-only session and archive that too.
-- That second read is the "immediate read-only read-back" the standing constraints require;
-- the one above is inside the writing transaction and does not satisfy it on its own.
`;

// The DO block is dollar-quoted with $cp01tx$ and its body contains $cp01lit$ literals. If the
// outer tag could be formed inside the body the transaction would terminate early and silently
// change meaning, so count it: exactly one opener and one closer, nothing in between.
const opens = apply.split('$' + DOTAG + '$').length - 1;
if (opens !== 2) fail(`the DO block tag $${DOTAG}$ appears ${opens} times in the generated ` +
                      `transaction; expected exactly 2 (open and close)`);
if (derive.includes('$' + DOTAG + '$')) fail(`the read-only derivation must not contain a DO block`);

// A missing key interpolates as the string "undefined" and lands in the SQL. That happened here
// with total_functions vs total_functions_in_schema, and earlier in this run with a Python
// dict.get() returning None into a document. It fails loudly in Postgres rather than passing
// silently, but a generator should not be able to emit it at all.
//
// The needle is escaped before it becomes a pattern. The first version of this check did not, and
// "[object Object]" was read as a character class -- the guard was matching something other than
// what it named, which is the same family of mistake it exists to catch.
// `null` is deliberately not on the list: it is valid SQL and seeds the recursive CTE rows.
const reEscape = t => t.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
for (const [name, text] of [['cp01-derive.sql', derive], ['cp01-apply.candidate.sql', apply]])
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    const at = text.search(new RegExp('(^|[^A-Za-z_.])' + reEscape(bad) + '($|[^A-Za-z_])'));
    if (at >= 0)
      fail(`${name} contains the literal ${JSON.stringify(bad)} at offset ${at} -- a template read ` +
           `a key that does not exist. Fix the reference, not the output.\n  context: ...` +
           text.slice(Math.max(0, at - 100), at + 90).replace(/\n/g, ' ') + '...');
  }

fs.writeFileSync(path.join(HERE, 'cp01-derive.sql'), derive);
fs.writeFileSync(path.join(HERE, 'cp01-apply.candidate.sql'), apply);

console.log(`${total} edits validated across ${table.functions.length} functions:`);
for (const fn of table.functions) console.log(`  ${fn.function.padEnd(52)} ${fn.edits.length}`);
console.log(`\nwrote cp01-derive.sql            ${fs.statSync(path.join(HERE, 'cp01-derive.sql')).size} bytes`);
console.log(`wrote cp01-apply.candidate.sql   ${fs.statSync(path.join(HERE, 'cp01-apply.candidate.sql')).size} bytes`);
if (draft) {
  console.log(`\nEMITTED AS A DRAFT. Blocking:`);
  for (const x of placeholders) console.log(`  unresolved placeholder                    ${x}`);
  for (const x of unauthorised) console.log(`  edit class not yet granted by the Owner   ${x}`);
  for (const f of missing)     console.log(`  post-image digest unpinned                ${f.function}`);
  console.log(`\nOrder, as amended by the Owner (OwnerOrderingAmendment.json): CP-01 is applied`);
  console.log(`AFTER root6 is registered, not before, so its guards pin a MEASURED root digest`);
  console.log(`rather than a projected one.`);
  console.log(`  Owner merge 1 fixed T -> __T_PLUS_24H__ is C1.committed_at + 86400s ->`);
  console.log(`  NW-01 applied -> root6 REGISTERED (step 13) ->`);
  console.log(`  measure-root6-root-digest.sql resolves __MEASURED_ROOT6_ROOT_DIGEST_PENDING__ ->`);
  console.log(`  cp01-derive.sql pins the post-image digests -> regenerate -> independent review.`);
}
