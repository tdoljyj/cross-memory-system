#!/usr/bin/env node
// Generates this window's NW-01 candidate transaction from one parameter file.
//
//   node work/nw01/build-nw01.mjs work/nw01/nw01-parameters.json
//
// NW-01 is the reviewed accepted_binding maintenance mechanism: disable the immutability trigger,
// drop the three value-pinning CHECK constraints, update seven fields, add the CHECKs back with
// the new values, re-enable the trigger, and read back — all in one fail-closed transaction.
//
// WHY THIS IS GENERATED RATHER THAN EDITED. The predecessor,
// bootstrap/next-window-20260911/NW01ApplyCandidate.sql, is 230 lines in which roughly forty
// literals appear twice each: once in a pre-condition guard naming the state being replaced, and
// once in a post-condition guard naming the state that must result. Hand-editing it for a new
// window means changing about eighty literals without changing the four that must stay. The
// approval also forbids reusing the previous window's candidate at all
// (execution_boundary.reuse_expired_window_candidate = false), so this is not a one-off.
//
// The parameter file separates the two halves explicitly: `preimage` is what the database must
// look like before the transaction, every value measured from it rather than assumed, and
// `postimage` is what it must look like after. The generator emits a guard for each, so a wrong
// parameter fails closed at the first DO block instead of writing anything.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const P = JSON.parse(fs.readFileSync(process.argv[2] ?? path.join(HERE, 'nw01-parameters.json'), 'utf8'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = m => { console.error('REFUSED: ' + m); process.exit(1); };

const HEX = /^[0-9a-f]{64}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const q = s => "'" + String(s).replaceAll("'", () => "''") + "'";

// ---- validation ---------------------------------------------------------------------------
// The seven fields NW-01 is permitted to change, and nothing else.
const MUTABLE = ['not_before', 'expires_at', 'owner_approval_commit', 'subject_sha256',
                 'registration_acceptance_sha256', 'store_acceptance_sha256',
                 'signature_evidence_sha256'];
// Fields that must be byte-identical before and after. Together with MUTABLE these are every
// column of clued_control.accepted_binding, so nothing can be changed by omission.
const FROZEN = ['root_id', 'project_ref', 'purpose', 'environment', 'issuer', 'audience',
                'algorithm_config', 'schema_sha256', 'protocol_mapping_sha256'];

const pre = P.preimage, post = P.postimage;
for (const f of [...MUTABLE, ...FROZEN]) {
  assert.ok(pre.binding[f] !== undefined, 'preimage.binding.' + f + ' missing');
  assert.ok(post.binding[f] !== undefined, 'postimage.binding.' + f + ' missing');
}
for (const f of FROZEN)
  if (pre.binding[f] !== post.binding[f]) fail(`${f} differs across the transaction; NW-01 may change only the seven`);
const changed = MUTABLE.filter(f => pre.binding[f] !== post.binding[f]);
if (changed.length !== 7) fail(`expected all seven mutable fields to change, ${changed.length} do: ${changed.join(', ')}`);
for (const k of ['not_before', 'expires_at'])
  assert.match(post.binding[k], ISO, 'postimage.binding.' + k);
if (Date.parse(post.binding.expires_at) - Date.parse(post.binding.not_before) !== 86400000)
  fail('the new window is not exactly 86400 seconds');
if (Date.parse(post.binding.not_before) > Date.now() || Date.now() >= Date.parse(post.binding.expires_at))
  fail('now is outside the window this candidate would install; NW-01 must run inside it');
assert.match(post.binding.owner_approval_commit, /^[0-9a-f]{40}$/, 'postimage owner_approval_commit');
if (post.binding.owner_approval_commit === pre.binding.owner_approval_commit)
  fail('still the previous approval commit');
for (const f of ['subject_sha256', 'registration_acceptance_sha256', 'store_acceptance_sha256',
                 'signature_evidence_sha256']) assert.match(post.binding[f], HEX, 'postimage ' + f);

// Every digest the new binding will carry must be the measured digest of a file in this
// repository, not a value copied from a report. Checked here, before any SQL exists.
for (const [field, rel] of Object.entries(P.postimage.digest_sources)) {
  const measured = sha(fs.readFileSync(path.join(REPO, rel)));
  if (measured !== post.binding[field])
    fail(`postimage.binding.${field} is ${post.binding[field]} but ${rel} measures ${measured}`);
}

assert.equal(pre.constraint_count, 16, 'preimage.constraint_count');
assert.match(pre.conname_digest, HEX, 'preimage.conname_digest');
for (const k of ['rows_sha256', 'catalog_sha256', 'getter_definition_sha256', 'getter_prosrc_sha256'])
  assert.match(pre[k], HEX, 'preimage.' + k);

// ---- rendering ----------------------------------------------------------------------------
// Postgres renders a timestamptz inside a CHECK as 'YYYY-MM-DD HH:MM:SS+00', not as the ISO input.
// The post-guard compares the rendered form, so it has to be produced the same way.
const rendered = iso => iso.replace('T', ' ').replace('Z', '+00');
const windowCheck = at => `CHECK (expires_at <= '${rendered(at)}'::timestamp with time zone AND expires_at > not_before)`;
const commitCheck = c => `CHECK (owner_approval_commit = '${c}'::text)`;
const subjectCheck = s => `CHECK (subject_sha256 = '${s}'::text)`;

const bindingRowGuard = (b, label) => [...MUTABLE, ...FROZEN].sort().map(f =>
  `     and b.${f}=${['not_before', 'expires_at'].includes(f) ? q(b[f]) + '::timestamptz' : q(b[f])}`
).join('\n');

const ROWS_SHA_EXPR = `encode(sha256(convert_to((select jsonb_build_object(${
  P.preimage.tables.map(t => `'${t}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.${t} x)`).join(',')
}))::text,'UTF8')),'hex')`;

const CATALOG_SHA_EXPR = `encode(sha256(convert_to((select jsonb_build_object(
    'effective_execution_binding', jsonb_build_object(
      'full_definition_sha256', encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')
    )
  ))::text,'UTF8')),'hex')`;

const stateGuards = (tag) => `
  perform 1 from clued_control.execution_current
   where root_id=${q(pre.execution.root_id)}
     and sequence=${pre.execution.sequence}
     and active_ga_id is null
     and pending_budget_sequence is null
     and charged_seconds=${pre.execution.charged_seconds}
     and charged_evidence_bytes=${pre.execution.charged_evidence_bytes};
  if not found then raise exception 'NW01_${tag}EXECUTION_STATE_DRIFT'; end if;

  perform 1 from clued_control.current_head
   where root_id=${q(pre.execution.root_id)}
     and sequence=${pre.head.sequence}
     and generation_id=${q(pre.head.generation_id)}
     and revoked=false;
  if not found then raise exception 'NW01_${tag}ROOT_HEAD_DRIFT'; end if;

  select tgenabled, pg_get_triggerdef(oid,true) into v_enabled, v_trigger_def
    from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
    and tgname='accepted_binding_immutable' and not tgisinternal;
  if v_enabled is distinct from 'O'::"char" or v_trigger_def is distinct from ${q(pre.trigger.definition)} then
    raise exception 'NW01_${tag}IMMUTABLE_TRIGGER_DRIFT';
  end if;

  select pg_get_userbyid(c.relowner), coalesce(c.relacl::text,'NULL') into v_owner,v_acl
    from pg_class c where c.oid='clued_control.accepted_binding'::regclass;
  if v_owner is distinct from ${q(pre.ownership.owner)} or v_acl is distinct from ${q(pre.ownership.acl)} then
    raise exception 'NW01_${tag}OWNER_OR_ACL_DRIFT';
  end if;

  -- Added after round 9 finding F6: the count and the sorted constraint-name digest, so that a
  -- constraint added or removed alongside the three this transaction touches cannot pass unseen.
  select count(*) into v_n from pg_constraint where conrelid='clued_control.accepted_binding'::regclass;
  if v_n <> ${pre.constraint_count} then raise exception 'NW01_${tag}CONSTRAINT_COUNT_DRIFT: %', v_n; end if;
  select encode(sha256(convert_to(string_agg(conname,',' order by conname),'UTF8')),'hex') into v_def
    from pg_constraint where conrelid='clued_control.accepted_binding'::regclass;
  if v_def is distinct from ${q(pre.conname_digest)} then
    raise exception 'NW01_${tag}CONSTRAINT_NAME_SET_DRIFT: %', v_def;
  end if;`;

let sql = `-- ${'='.repeat(94)}
-- NW-01 candidate for the Owner window ${post.binding.not_before} .. ${post.binding.expires_at}
-- generated by work/nw01/build-nw01.mjs from work/nw01/nw01-parameters.json
-- DO NOT EDIT THIS FILE. Edit the parameters and regenerate.
--
-- state: CANDIDATE. NOT EXECUTED. Requires the independent review the approval's execution
-- sequencing places at step 8, before step 9 applies it.
--
-- Shape is the reviewed NW-01 mechanism, unchanged: one transaction, ACCESS EXCLUSIVE on
-- accepted_binding and SHARE on the other seven tables, a pre-condition block that fails closed on
-- any drift, disable trigger -> drop 3 CHECKs -> update 7 fields -> add 3 CHECKs -> enable
-- trigger, then a post-condition block. Seven fields change; the other nine columns are asserted
-- identical on both sides, so nothing changes by omission.
-- ${'='.repeat(94)}

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table clued_control.accepted_binding in access exclusive mode;
lock table ${P.preimage.tables.filter(t => t !== 'accepted_binding').map(t => 'clued_control.' + t).join(',\n           ')} in share mode;

do $nw01_pre$
declare
  v_rows_sha text; v_catalog_sha text; v_def text;
  v_enabled "char"; v_trigger_def text; v_owner text; v_acl text; v_n bigint;
begin
  select ${ROWS_SHA_EXPR} into v_rows_sha;
  if v_rows_sha is distinct from ${q(pre.rows_sha256)} then
    raise exception 'NW01_PREIMAGE_ROWS_DRIFT: %', v_rows_sha;
  end if;

  select ${CATALOG_SHA_EXPR} into v_catalog_sha;
  if v_catalog_sha is distinct from ${q(pre.catalog_sha256)} then
    raise exception 'NW01_PREIMAGE_CATALOG_DRIFT: %', v_catalog_sha;
  end if;

  if (select encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex'))
       is distinct from ${q(pre.getter_definition_sha256)} then
    raise exception 'NW01_GETTER_DEFINITION_DRIFT';
  end if;

  if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
      where oid='clued_control.effective_execution_binding()'::regprocedure)
       is distinct from ${q(pre.getter_prosrc_sha256)} then
    raise exception 'NW01_GETTER_PROSRC_DRIFT';
  end if;

  select count(*) into v_n from clued_control.accepted_binding;
  if v_n <> 1 then raise exception 'NW01_BINDING_ROW_COUNT_DRIFT: %', v_n; end if;

  perform 1 from clued_control.accepted_binding b
   where true
${bindingRowGuard(pre.binding)};
  if not found then raise exception 'NW01_OLD_BINDING_PREIMAGE_MISMATCH'; end if;
${stateGuards('')}

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_check';
  if v_def is distinct from ${q(windowCheck(pre.binding.expires_at))} then
    raise exception 'NW01_OLD_WINDOW_CHECK_DRIFT: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_owner_approval_commit_check';
  if v_def is distinct from ${q(commitCheck(pre.binding.owner_approval_commit))} then
    raise exception 'NW01_OLD_APPROVAL_CHECK_DRIFT: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_subject_sha256_check';
  if v_def is distinct from ${q(subjectCheck(pre.binding.subject_sha256))} then
    raise exception 'NW01_OLD_SUBJECT_CHECK_DRIFT: %', v_def;
  end if;
end
$nw01_pre$;

alter table clued_control.accepted_binding disable trigger accepted_binding_immutable;

alter table clued_control.accepted_binding
  drop constraint accepted_binding_check,
  drop constraint accepted_binding_owner_approval_commit_check,
  drop constraint accepted_binding_subject_sha256_check;

update clued_control.accepted_binding
set ${MUTABLE.map(f => `${f}=${['not_before', 'expires_at'].includes(f) ? q(post.binding[f]) + '::timestamptz' : q(post.binding[f])}`).join(',\n    ')}
where root_id=${q(post.binding.root_id)};

alter table clued_control.accepted_binding
  add constraint accepted_binding_check
    check (expires_at <= ${q(post.binding.expires_at)}::timestamptz and expires_at > not_before),
  add constraint accepted_binding_owner_approval_commit_check
    check (owner_approval_commit=${q(post.binding.owner_approval_commit)}::text),
  add constraint accepted_binding_subject_sha256_check
    check (subject_sha256=${q(post.binding.subject_sha256)}::text);

alter table clued_control.accepted_binding enable trigger accepted_binding_immutable;

do $nw01_post$
declare
  v_def text; v_enabled "char"; v_trigger_def text; v_owner text; v_acl text; v_n bigint;
begin
  select count(*) into v_n from clued_control.accepted_binding;
  if v_n <> 1 then raise exception 'NW01_POST_BINDING_ROW_COUNT_MISMATCH: %', v_n; end if;

  perform 1 from clued_control.accepted_binding b
   where true
${bindingRowGuard(post.binding)};
  if not found then raise exception 'NW01_POST_BINDING_MISMATCH'; end if;
${stateGuards('POST_')}

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_check';
  if v_def is distinct from ${q(windowCheck(post.binding.expires_at))} then
    raise exception 'NW01_POST_WINDOW_CHECK_MISMATCH: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_owner_approval_commit_check';
  if v_def is distinct from ${q(commitCheck(post.binding.owner_approval_commit))} then
    raise exception 'NW01_POST_APPROVAL_CHECK_MISMATCH: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_subject_sha256_check';
  if v_def is distinct from ${q(subjectCheck(post.binding.subject_sha256))} then
    raise exception 'NW01_POST_SUBJECT_CHECK_MISMATCH: %', v_def;
  end if;
end
$nw01_post$;

-- In-transaction readback. Archive alongside the exact input and the raw response.
select to_jsonb(b) as accepted_binding,
       (select jsonb_agg(jsonb_build_array(conname, pg_get_constraintdef(oid,true)) order by conname)
          from pg_constraint where conrelid='clued_control.accepted_binding'::regclass) as constraints
from clued_control.accepted_binding b;

commit;

-- After COMMIT, run the same select again in a separate read-only session and archive that too.
-- The one above is inside the writing transaction and does not satisfy the immediate read-only
-- read-back the approval requires on its own.
--
-- If this transaction is interrupted, do NOT re-run it blindly. Read the binding row first: all
-- seven fields at their preimage values means nothing committed; anything else needs its own
-- decision.
`;

// ---- read-only preflight ---------------------------------------------------------------------
// The same pre-conditions as one pure SELECT returning a boolean per guard. It writes nothing and
// can be re-run any number of times, including immediately before the transaction, so that "the
// guards would pass" is a measurement rather than an expectation. The reviewer can run this too.
const preflight = `-- ${'='.repeat(94)}
-- NW-01 read-only preflight. Pure SELECT. Writes nothing, locks nothing, raises nothing.
-- generated by work/nw01/build-nw01.mjs -- DO NOT EDIT.
--
-- Every column must read true. A false one names the guard that would abort nw01-apply.candidate.sql
-- at its first DO block, before any trigger is disabled.
-- ${'='.repeat(94)}
select
  (${ROWS_SHA_EXPR}) = ${q(pre.rows_sha256)} as rows_sha_ok,
  (${CATALOG_SHA_EXPR}) = ${q(pre.catalog_sha256)} as catalog_sha_ok,
  (select encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex'))
    = ${q(pre.getter_definition_sha256)} as getter_definition_ok,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)
    = ${q(pre.getter_prosrc_sha256)} as getter_prosrc_ok,
  (select count(*) from clued_control.accepted_binding) = 1 as binding_row_count_ok,
  exists(select 1 from clued_control.accepted_binding b where true
${bindingRowGuard(pre.binding)}) as old_binding_preimage_ok,
  exists(select 1 from clued_control.execution_current
    where root_id=${q(pre.execution.root_id)} and sequence=${pre.execution.sequence}
      and active_ga_id is null and pending_budget_sequence is null
      and charged_seconds=${pre.execution.charged_seconds}
      and charged_evidence_bytes=${pre.execution.charged_evidence_bytes}) as execution_state_ok,
  exists(select 1 from clued_control.current_head
    where root_id=${q(pre.execution.root_id)} and sequence=${pre.head.sequence}
      and generation_id=${q(pre.head.generation_id)} and revoked=false) as root_head_ok,
  (select tgenabled='O'::"char" and pg_get_triggerdef(oid,true)=${q(pre.trigger.definition)}
     from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
       and tgname='accepted_binding_immutable' and not tgisinternal) as trigger_ok,
  (select pg_get_userbyid(relowner)=${q(pre.ownership.owner)}
      and coalesce(relacl::text,'NULL')=${q(pre.ownership.acl)}
     from pg_class where oid='clued_control.accepted_binding'::regclass) as ownership_ok,
  (select count(*) from pg_constraint where conrelid='clued_control.accepted_binding'::regclass)
    = ${pre.constraint_count} as constraint_count_ok,
  (select encode(sha256(convert_to(string_agg(conname,',' order by conname),'UTF8')),'hex')
     from pg_constraint where conrelid='clued_control.accepted_binding'::regclass)
    = ${q(pre.conname_digest)} as constraint_name_set_ok,
  (select pg_get_constraintdef(oid,true) from pg_constraint
     where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_check')
    = ${q(windowCheck(pre.binding.expires_at))} as old_window_check_ok,
  (select pg_get_constraintdef(oid,true) from pg_constraint
     where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_owner_approval_commit_check')
    = ${q(commitCheck(pre.binding.owner_approval_commit))} as old_approval_check_ok,
  (select pg_get_constraintdef(oid,true) from pg_constraint
     where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_subject_sha256_check')
    = ${q(subjectCheck(pre.binding.subject_sha256))} as old_subject_check_ok,
  clock_timestamp() >= ${q(post.binding.not_before)}::timestamptz
    and clock_timestamp() < ${q(post.binding.expires_at)}::timestamptz as inside_the_new_window,
  clock_timestamp() as observed_at;
`;
fs.writeFileSync(path.join(HERE, 'nw01-preflight.sql'), preflight);

const outPath = path.join(HERE, 'nw01-apply.candidate.sql');
fs.writeFileSync(outPath, sql);
console.log(`window        ${post.binding.not_before} .. ${post.binding.expires_at}`);
console.log(`fields changed ${changed.length}: ${changed.join(', ')}`);
console.log(`fields frozen  ${FROZEN.length}: asserted identical on both sides`);
console.log(`wrote ${path.relative(REPO, outPath)}  ${fs.statSync(outPath).size} bytes`);
console.log(`sha256 ${sha(fs.readFileSync(outPath))}`);
const pf = path.join(HERE, 'nw01-preflight.sql');
console.log(`wrote ${path.relative(REPO, pf)}  ${fs.statSync(pf).size} bytes  (read-only, 16 guards)`);
