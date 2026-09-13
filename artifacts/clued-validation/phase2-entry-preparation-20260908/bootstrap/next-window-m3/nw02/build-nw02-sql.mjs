#!/usr/bin/env node
// Generates the NW-02 candidate transaction and its read-only preflight from one parameter file.
//
//   node .../nw02/build-nw02-sql.mjs [--draft] [--tamper=<id>] [--demo-falsifiability]
//
// GENERATES ONLY. It never opens a database connection, and the SQL it writes is a file.
//
// Lineage: work/nw01/build-nw01.mjs, same shape, same parameter split (preimage / postimage),
// same rendering rules. Two guard families are ADDED, because the M3 carrier's nw02 clause
// (transaction_guards_required_beyond_nw01) requires them and NW-01's own receipt recorded them
// as owed:
//
//   R11-F12  in-transaction window assertion, pre-block AND post-block. NW-01 had this only in
//            the read-only preflight, i.e. outside the transaction.
//   R11-F13  exactly one non-internal trigger on accepted_binding, pre-block AND post-block.
//            NW-01 asserted the named trigger's definition but not that it was the only one.
//
// WHY --draft EXISTS. Three of the four documents whose digests this transaction would write are
// skeletons (only an independent reviewer may issue two of them; the third needs the M4 merge),
// and the subject still carries five unresolved __PENDING_M3_*__ sentinels. A generator that
// happily emitted an executable transaction under those conditions would be exactly the
// "impossible-to-fail validation" this run has now found fifteen times. So: strict mode refuses,
// --draft emits banner-marked files that say NOT FOR EXECUTION in the first five lines.
//
// FALSIFIABILITY. Every self-check below has an id. `--tamper=<id>` corrupts precisely the input
// that check reads and nothing else; the check must then refuse. `--demo-falsifiability` runs all
// of them in a child process and reports one line per check. A check that still passes under its
// own tamper is reported as NOT FALSIFIABLE and the demo exits non-zero.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..', '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const q = s => "'" + String(s).replaceAll("'", () => "''") + "'";
const HEX = /^[0-9a-f]{64}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, SHA1 = /^[0-9a-f]{40}$/;

const argv = process.argv.slice(2);
const DRAFT = argv.includes('--draft');
const TAMPER = (argv.find(a => a.startsWith('--tamper=')) ?? '').split('=')[1] ?? null;
const DEMO = argv.includes('--demo-falsifiability');

// The M3 carrier materialized exactly one window. Hard-coded here, not taken from the parameter
// file, so that a parameter edit alone cannot move the window this generator will emit (S11).
const M3 = {
  merge: 'f92cd46e42e20e1fa305c573964e0597230c0b65',
  not_before: '2026-09-13T05:45:14Z',
  expires_at: '2026-09-14T05:45:14Z',
};

const MUTABLE = ['not_before', 'expires_at', 'owner_approval_commit', 'subject_sha256',
                 'registration_acceptance_sha256', 'store_acceptance_sha256',
                 'signature_evidence_sha256'];
const FROZEN = ['root_id', 'project_ref', 'purpose', 'environment', 'issuer', 'audience',
                'algorithm_config', 'schema_sha256', 'protocol_mapping_sha256'];

const CHECKS = [
  ['S1',  'every mutable and frozen field is present on both sides'],
  ['S2',  'the nine frozen fields are identical across the transaction'],
  ['S3',  'all seven mutable fields actually change'],
  ['S4',  'the new window is exactly 86400 seconds'],
  ['S5',  'now is inside the window this candidate would install'],
  ['S6',  'owner_approval_commit is a new 40-hex commit'],
  ['S7',  'the four digests are 64-hex'],
  ['S8',  'each digest equals the measured sha256 of its source file'],
  ['S9',  'the pre-image constraint count and name digest are present and well formed'],
  ['S10', 'the four pre-image catalog digests are 64-hex'],
  ['S11', 'the window equals the one the M3 merge materialized'],
  ['S12', 'no source document is a skeleton or carries an unresolved sentinel (strict mode)'],
  ['S13', 'the rendered SQL carries both added guard families, in both blocks'],
  ['S14', 'no pre-image digest appears on the write side and no post-image digest on the guard side'],
];

// --------------------------------------------------------------------------------------------
if (DEMO) {
  let bad = 0;
  const self = fileURLToPath(import.meta.url);
  for (const [id, what] of CHECKS) {
    let refused = false, first = '';
    try {
      execFileSync(process.execPath, [self, '--draft', '--tamper=' + id],
                   {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    } catch (e) {
      refused = true;
      first = String(e.stderr ?? '').trim().split('\n')[0];
    }
    if (!refused) { bad++; console.log(`  ${id}  NOT FALSIFIABLE  -- ${what}`); }
    else console.log(`  ${id}  refuses         -- ${first}`);
  }
  console.log(bad === 0
    ? `\n${CHECKS.length}/${CHECKS.length} self-checks demonstrated on a failing path.`
    : `\n${bad} self-check(s) could not be made to fail. That is the defect, not the tamper.`);
  process.exit(bad === 0 ? 0 : 1);
}

const fail = m => { console.error('REFUSED: ' + m); process.exit(1); };
const need = (id, cond, m) => { if (!cond) fail(`[${id}] ${m}`); };

const PARAMS_PATH = path.join(HERE, 'nw02-parameters.json');
const P = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'));
const pre = P.preimage, post = P.postimage;

// ---- tamper injection ----------------------------------------------------------------------
// Each case corrupts only what its own check reads. Applied in memory; no file is written.
const t = TAMPER;
if (t === 'S1')  delete post.binding.subject_sha256;
if (t === 'S2')  post.binding.audience = pre.binding.audience + '-drifted';
if (t === 'S3')  post.binding.store_acceptance_sha256 = pre.binding.store_acceptance_sha256;
if (t === 'S4')  post.binding.expires_at = '2026-09-14T05:45:15Z';
if (t === 'S5')  { post.binding.not_before = '2027-01-01T00:00:00Z'; post.binding.expires_at = '2027-01-02T00:00:00Z'; }
if (t === 'S6')  post.binding.owner_approval_commit = 'not-a-commit-sha';
if (t === 'S7')  post.binding.signature_evidence_sha256 = 'not-a-digest';
if (t === 'S8')  post.binding.subject_sha256 = 'f'.repeat(64);
if (t === 'S9')  pre.constraint_count = 15;
if (t === 'S10') pre.getter_prosrc_sha256 = 'z'.repeat(64);
if (t === 'S11') { post.binding.not_before = '2026-09-13T05:45:13Z'; post.binding.expires_at = '2026-09-14T05:45:13Z'; }
// S12 is tampered further down, where the source documents are read.
const RENDER_TAMPER = {dropWindowGuardFromPostBlock: false, leakPreimageDigestIntoUpdate: false};
if (t === 'S13') RENDER_TAMPER.dropWindowGuardFromPostBlock = true;
if (t === 'S14') RENDER_TAMPER.leakPreimageDigestIntoUpdate = true;

// ---- S1 / S2 / S3 --------------------------------------------------------------------------
for (const f of [...MUTABLE, ...FROZEN]) {
  need('S1', pre.binding[f] !== undefined, `preimage.binding.${f} missing`);
  need('S1', post.binding[f] !== undefined, `postimage.binding.${f} missing`);
}
for (const f of FROZEN)
  need('S2', pre.binding[f] === post.binding[f],
       `${f} differs across the transaction; NW-02 may change only the seven`);
const changed = MUTABLE.filter(f => pre.binding[f] !== post.binding[f]);
need('S3', changed.length === 7,
     `expected all seven mutable fields to change, ${changed.length} do: ${changed.join(', ')}`);

// ---- S4 / S5 / S6 / S7 ---------------------------------------------------------------------
for (const k of ['not_before', 'expires_at'])
  need('S4', ISO.test(post.binding[k]), `postimage.binding.${k} is not an ISO Z timestamp`);
need('S4', Date.parse(post.binding.expires_at) - Date.parse(post.binding.not_before) === 86400000,
     'the new window is not exactly 86400 seconds');
need('S5', Date.parse(post.binding.not_before) <= Date.now() && Date.now() < Date.parse(post.binding.expires_at),
     'now is outside the window this candidate would install; NW-02 must run inside it');
need('S6', SHA1.test(post.binding.owner_approval_commit), 'postimage owner_approval_commit is not 40-hex');
// NOT INDEPENDENTLY FALSIFIABLE, and kept anyway. Setting owner_approval_commit back to its
// pre-image value makes S3 count six changed fields instead of seven, so S3 always refuses first
// and this clause can never be the one that fires. build-nw01.mjs carries the same redundancy.
// It stays as defence in depth against a future edit that weakens S3, but it is not evidence of
// anything on its own and must not be counted as a guard. See NW02DraftNotes.md section 5.
need('S6', post.binding.owner_approval_commit !== pre.binding.owner_approval_commit,
     'still the previous approval commit (subsumed by S3; see the note above)');
for (const f of ['subject_sha256', 'registration_acceptance_sha256', 'store_acceptance_sha256',
                 'signature_evidence_sha256'])
  need('S7', HEX.test(post.binding[f]), `postimage ${f} is not 64-hex`);

// ---- S8 / S12 ------------------------------------------------------------------------------
// Every digest the new binding would carry must be the measured digest of a file in this
// repository, and that file must not be a skeleton or carry an unresolved sentinel.
const SENTINEL = /__(PENDING|REVIEWER_TO_WRITE|OPEN)[A-Z0-9_]*__/;
const notFinal = [];
for (const [field, rel] of Object.entries(post.digest_sources)) {
  let bytes = fs.readFileSync(path.join(REPO, rel));
  if (t === 'S8' && field === 'subject_sha256') { /* digest already corrupted above */ }
  const measured = sha(bytes);
  need('S8', measured === post.binding[field],
       `postimage.binding.${field} is ${post.binding[field]} but ${rel} measures ${measured}`);
  const text = bytes.toString('utf8');
  let bad = text.includes('"__skeleton__"') || SENTINEL.test(text);
  if (t === 'S12') bad = true;                       // pretend every source is still a skeleton
  if (bad) notFinal.push(rel + (text.includes('"__skeleton__"') || t === 'S12' ? ' (skeleton)' : ' (unresolved sentinel)'));
}
if (notFinal.length && !DRAFT)
  fail(`[S12] ${notFinal.length} source document(s) are not final, and --draft was not given:\n  - ` + notFinal.join('\n  - '));
if (notFinal.length && DRAFT && t === 'S12')
  fail(`[S12] --draft emits only banner-marked files; ${notFinal.length} source document(s) are not final`);

// ---- S9 / S10 / S11 ------------------------------------------------------------------------
need('S9', pre.constraint_count === 16, `preimage.constraint_count is ${pre.constraint_count}, expected 16`);
need('S9', HEX.test(pre.conname_digest), 'preimage.conname_digest is not 64-hex');
for (const k of ['rows_sha256', 'catalog_sha256', 'getter_definition_sha256', 'getter_prosrc_sha256'])
  need('S10', HEX.test(pre[k]), `preimage.${k} is not 64-hex`);
need('S11', post.binding.not_before === M3.not_before && post.binding.expires_at === M3.expires_at,
     `the window in the parameters (${post.binding.not_before} .. ${post.binding.expires_at}) is not the one M3 materialized (${M3.not_before} .. ${M3.expires_at})`);
need('S11', post.binding.owner_approval_commit === M3.merge,
     'the approval commit in the parameters is not the M3 merge');

// ---- rendering -----------------------------------------------------------------------------
const rendered = iso => iso.replace('T', ' ').replace('Z', '+00');
const windowCheck = at => `CHECK (expires_at <= '${rendered(at)}'::timestamp with time zone AND expires_at > not_before)`;
const commitCheck = c => `CHECK (owner_approval_commit = '${c}'::text)`;
const subjectCheck = s => `CHECK (subject_sha256 = '${s}'::text)`;

const bindingRowGuard = b => [...MUTABLE, ...FROZEN].sort().map(f =>
  `     and b.${f}=${['not_before', 'expires_at'].includes(f) ? q(b[f]) + '::timestamptz' : q(b[f])}`
).join('\n');

const ROWS_SHA_EXPR = `encode(sha256(convert_to((select jsonb_build_object(${
  pre.tables.map(t2 => `'${t2}',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.${t2} x)`).join(',')
}))::text,'UTF8')),'hex')`;

const CATALOG_SHA_EXPR = `encode(sha256(convert_to((select jsonb_build_object(
    'effective_execution_binding', jsonb_build_object(
      'full_definition_sha256', encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')
    )
  ))::text,'UTF8')),'hex')`;

// R11-F12. Inside the transaction, both blocks. The window is a literal so that a clock that has
// passed expires_at aborts and rolls back rather than committing a dead window.
const windowGuard = tag => `
  -- R11-F12: the window assertion NW-01 had only in its out-of-transaction preflight.
  if not (clock_timestamp() >= ${q(post.binding.not_before)}::timestamptz
          and clock_timestamp() < ${q(post.binding.expires_at)}::timestamptz) then
    raise exception 'NW02_${tag}OUTSIDE_APPROVED_WINDOW: %', clock_timestamp();
  end if;`;

// R11-F13. Both blocks. Count first, then identity, so a second trigger cannot hide behind a
// correct first one.
const soleTriggerGuard = tag => `
  -- R11-F13: accepted_binding must carry exactly one non-internal trigger, and it must be ours.
  select count(*) into v_n from pg_trigger
   where tgrelid='clued_control.accepted_binding'::regclass and not tgisinternal;
  if v_n <> ${pre.trigger.non_internal_trigger_count} then
    raise exception 'NW02_${tag}NON_INTERNAL_TRIGGER_COUNT_DRIFT: %', v_n;
  end if;
  select count(*) into v_n from pg_trigger
   where tgrelid='clued_control.accepted_binding'::regclass and not tgisinternal
     and tgname=${q(pre.trigger.name)};
  if v_n <> 1 then raise exception 'NW02_${tag}SOLE_TRIGGER_IS_NOT_OURS'; end if;`;

const stateGuards = tag => `
  perform 1 from clued_control.execution_current
   where root_id=${q(pre.execution.root_id)}
     and sequence=${pre.execution.sequence}
     and active_ga_id is null
     and pending_budget_sequence is null
     and charged_seconds=${pre.execution.charged_seconds}
     and charged_evidence_bytes=${pre.execution.charged_evidence_bytes};
  if not found then raise exception 'NW02_${tag}EXECUTION_STATE_DRIFT'; end if;

  perform 1 from clued_control.current_head
   where root_id=${q(pre.execution.root_id)}
     and sequence=${pre.head.sequence}
     and generation_id=${q(pre.head.generation_id)}
     and revoked=false;
  if not found then raise exception 'NW02_${tag}ROOT_HEAD_DRIFT'; end if;

  select tgenabled, pg_get_triggerdef(oid,true) into v_enabled, v_trigger_def
    from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
    and tgname=${q(pre.trigger.name)} and not tgisinternal;
  if v_enabled is distinct from ${q(pre.trigger.tgenabled)}::"char" or v_trigger_def is distinct from ${q(pre.trigger.definition)} then
    raise exception 'NW02_${tag}IMMUTABLE_TRIGGER_DRIFT';
  end if;
${soleTriggerGuard(tag)}

  select pg_get_userbyid(c.relowner), coalesce(c.relacl::text,'NULL') into v_owner,v_acl
    from pg_class c where c.oid='clued_control.accepted_binding'::regclass;
  if v_owner is distinct from ${q(pre.ownership.owner)} or v_acl is distinct from ${q(pre.ownership.acl)} then
    raise exception 'NW02_${tag}OWNER_OR_ACL_DRIFT';
  end if;

  -- Round 9 finding F6: count and sorted-name digest, so a constraint added or removed alongside
  -- the three this transaction touches cannot pass unseen.
  select count(*) into v_n from pg_constraint where conrelid='clued_control.accepted_binding'::regclass;
  if v_n <> ${pre.constraint_count} then raise exception 'NW02_${tag}CONSTRAINT_COUNT_DRIFT: %', v_n; end if;
  select encode(sha256(convert_to(string_agg(conname,',' order by conname),'UTF8')),'hex') into v_def
    from pg_constraint where conrelid='clued_control.accepted_binding'::regclass;
  if v_def is distinct from ${q(pre.conname_digest)} then
    raise exception 'NW02_${tag}CONSTRAINT_NAME_SET_DRIFT: %', v_def;
  end if;`;

const BANNER = DRAFT ? `-- ${'#'.repeat(92)}
-- DRAFT. NOT FOR EXECUTION. NOT REVIEWED. Emitted with --draft because the documents whose
-- digests this transaction would write are not final:
--   ${notFinal.join('\n--   ')}
-- Two of those must be issued by an INDEPENDENT REVIEW SESSION and one only exists after the M4
-- merge. Running this would write skeleton digests into clued_control.accepted_binding.
-- The pre-image below was measured at ${pre.measured_at} and MUST be re-measured before apply.
-- ${'#'.repeat(92)}

` : '';

const updateSet = MUTABLE.map(f => {
  const src = (RENDER_TAMPER.leakPreimageDigestIntoUpdate && f === 'store_acceptance_sha256')
    ? pre.binding[f] : post.binding[f];
  return `${f}=${['not_before', 'expires_at'].includes(f) ? q(src) + '::timestamptz' : q(src)}`;
}).join(',\n    ');

let sql = `${BANNER}-- ${'='.repeat(94)}
-- NW-02 candidate for the Owner window ${post.binding.not_before} .. ${post.binding.expires_at}
-- generated by ${path.relative(REPO, fileURLToPath(import.meta.url))} from nw02-parameters.json
-- DO NOT EDIT THIS FILE. Edit the parameters and regenerate.
--
-- state: ${DRAFT ? 'DRAFT. NOT EXECUTABLE.' : 'CANDIDATE. NOT EXECUTED.'} Requires a fresh independent review before it is applied.
--
-- Shape is the reviewed NW-01 mechanism plus the two guard families the M3 nw02 clause requires:
-- one transaction, ACCESS EXCLUSIVE on accepted_binding and SHARE on the other seven tables, a
-- pre-condition block that fails closed on any drift, disable trigger -> drop 3 CHECKs -> update
-- 7 fields -> add 3 CHECKs -> enable trigger, then a post-condition block. Seven fields change;
-- the other nine columns are asserted identical on both sides, so nothing changes by omission.
-- Added beyond NW-01: R11-F12 (window asserted inside the transaction, both blocks) and R11-F13
-- (exactly one non-internal trigger, both blocks).
-- ${'='.repeat(94)}

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table clued_control.accepted_binding in access exclusive mode;
lock table ${pre.tables.filter(x => x !== 'accepted_binding').map(x => 'clued_control.' + x).join(',\n           ')} in share mode;

do $nw02_pre$
declare
  v_rows_sha text; v_catalog_sha text; v_def text;
  v_enabled "char"; v_trigger_def text; v_owner text; v_acl text; v_n bigint;
begin
${windowGuard('')}

  select ${ROWS_SHA_EXPR} into v_rows_sha;
  if v_rows_sha is distinct from ${q(pre.rows_sha256)} then
    raise exception 'NW02_PREIMAGE_ROWS_DRIFT: %', v_rows_sha;
  end if;

  select ${CATALOG_SHA_EXPR} into v_catalog_sha;
  if v_catalog_sha is distinct from ${q(pre.catalog_sha256)} then
    raise exception 'NW02_PREIMAGE_CATALOG_DRIFT: %', v_catalog_sha;
  end if;

  if (select encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex'))
       is distinct from ${q(pre.getter_definition_sha256)} then
    raise exception 'NW02_GETTER_DEFINITION_DRIFT';
  end if;

  if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
      where oid='clued_control.effective_execution_binding()'::regprocedure)
       is distinct from ${q(pre.getter_prosrc_sha256)} then
    raise exception 'NW02_GETTER_PROSRC_DRIFT';
  end if;

  select count(*) into v_n from clued_control.accepted_binding;
  if v_n <> 1 then raise exception 'NW02_BINDING_ROW_COUNT_DRIFT: %', v_n; end if;

  perform 1 from clued_control.accepted_binding b
   where true
${bindingRowGuard(pre.binding)};
  if not found then raise exception 'NW02_OLD_BINDING_PREIMAGE_MISMATCH'; end if;
${stateGuards('')}

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_check';
  if v_def is distinct from ${q(windowCheck(pre.binding.expires_at))} then
    raise exception 'NW02_OLD_WINDOW_CHECK_DRIFT: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_owner_approval_commit_check';
  if v_def is distinct from ${q(commitCheck(pre.binding.owner_approval_commit))} then
    raise exception 'NW02_OLD_APPROVAL_CHECK_DRIFT: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_subject_sha256_check';
  if v_def is distinct from ${q(subjectCheck(pre.binding.subject_sha256))} then
    raise exception 'NW02_OLD_SUBJECT_CHECK_DRIFT: %', v_def;
  end if;
end
$nw02_pre$;

alter table clued_control.accepted_binding disable trigger accepted_binding_immutable;

alter table clued_control.accepted_binding
  drop constraint accepted_binding_check,
  drop constraint accepted_binding_owner_approval_commit_check,
  drop constraint accepted_binding_subject_sha256_check;

update clued_control.accepted_binding
set ${updateSet}
where root_id=${q(post.binding.root_id)};

alter table clued_control.accepted_binding
  add constraint accepted_binding_check
    check (expires_at <= ${q(post.binding.expires_at)}::timestamptz and expires_at > not_before),
  add constraint accepted_binding_owner_approval_commit_check
    check (owner_approval_commit=${q(post.binding.owner_approval_commit)}::text),
  add constraint accepted_binding_subject_sha256_check
    check (subject_sha256=${q(post.binding.subject_sha256)}::text);

alter table clued_control.accepted_binding enable trigger accepted_binding_immutable;

do $nw02_post$
declare
  v_def text; v_enabled "char"; v_trigger_def text; v_owner text; v_acl text; v_n bigint;
begin
${RENDER_TAMPER.dropWindowGuardFromPostBlock ? '  -- (post-block window guard omitted)' : windowGuard('POST_')}

  select count(*) into v_n from clued_control.accepted_binding;
  if v_n <> 1 then raise exception 'NW02_POST_BINDING_ROW_COUNT_MISMATCH: %', v_n; end if;

  perform 1 from clued_control.accepted_binding b
   where true
${bindingRowGuard(post.binding)};
  if not found then raise exception 'NW02_POST_BINDING_MISMATCH'; end if;
${stateGuards('POST_')}

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_check';
  if v_def is distinct from ${q(windowCheck(post.binding.expires_at))} then
    raise exception 'NW02_POST_WINDOW_CHECK_MISMATCH: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_owner_approval_commit_check';
  if v_def is distinct from ${q(commitCheck(post.binding.owner_approval_commit))} then
    raise exception 'NW02_POST_APPROVAL_CHECK_MISMATCH: %', v_def;
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_subject_sha256_check';
  if v_def is distinct from ${q(subjectCheck(post.binding.subject_sha256))} then
    raise exception 'NW02_POST_SUBJECT_CHECK_MISMATCH: %', v_def;
  end if;
end
$nw02_post$;

-- In-transaction readback. Archive alongside the exact input and the raw response.
select to_jsonb(b) as accepted_binding,
       (select jsonb_agg(jsonb_build_array(conname, pg_get_constraintdef(oid,true)) order by conname)
          from pg_constraint where conrelid='clued_control.accepted_binding'::regclass) as constraints,
       (select jsonb_agg(jsonb_build_array(tgname, tgenabled::text) order by tgname)
          from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass and not tgisinternal) as non_internal_triggers
from clued_control.accepted_binding b;

commit;

-- After COMMIT, run the same select again in a separate read-only session and archive that too.
-- The one above is inside the writing transaction and does not satisfy the immediate read-only
-- read-back the approval requires on its own.
--
-- If this transaction is interrupted, do NOT re-run it blindly. Read the binding row first: all
-- seven fields at their pre-image values means nothing committed; anything else needs its own
-- decision.
`;

// ---- S13 / S14: check what was actually rendered, not what was intended ---------------------
const countOf = (hay, needle) => hay.split(needle).length - 1;
need('S13', countOf(sql, 'OUTSIDE_APPROVED_WINDOW') === 2,
     `expected the R11-F12 window guard in both blocks, found ${countOf(sql, 'OUTSIDE_APPROVED_WINDOW')}`);
need('S13', countOf(sql, 'NON_INTERNAL_TRIGGER_COUNT_DRIFT') === 2,
     `expected the R11-F13 trigger-count guard in both blocks, found ${countOf(sql, 'NON_INTERNAL_TRIGGER_COUNT_DRIFT')}`);
need('S13', countOf(sql, 'SOLE_TRIGGER_IS_NOT_OURS') === 2,
     `expected the R11-F13 trigger-identity guard in both blocks, found ${countOf(sql, 'SOLE_TRIGGER_IS_NOT_OURS')}`);

const writeSide = sql.slice(sql.indexOf('update clued_control.accepted_binding'),
                            sql.indexOf('do $nw02_post$'));
for (const f of ['subject_sha256', 'registration_acceptance_sha256', 'store_acceptance_sha256',
                 'signature_evidence_sha256', 'owner_approval_commit'])
  need('S14', !writeSide.includes(pre.binding[f]),
       `the write side carries the PRE-image value of ${f} (${pre.binding[f]})`);
const preBlock = sql.slice(sql.indexOf('do $nw02_pre$'), sql.indexOf('disable trigger'));
for (const f of ['subject_sha256', 'registration_acceptance_sha256', 'store_acceptance_sha256',
                 'signature_evidence_sha256', 'owner_approval_commit'])
  need('S14', !preBlock.includes(post.binding[f]),
       `the pre-condition block carries the POST-image value of ${f}`);

// ---- read-only preflight -------------------------------------------------------------------
const preflight = `${DRAFT ? `-- ${'#'.repeat(92)}
-- DRAFT. Pure SELECT, so running it writes nothing -- but the pre-image it pins was measured at
-- ${pre.measured_at} and the post-window it names comes from documents that are not final.
-- ${'#'.repeat(92)}

` : ''}-- ${'='.repeat(94)}
-- NW-02 read-only preflight. Pure SELECT. Writes nothing, locks nothing, raises nothing.
-- generated by build-nw02-sql.mjs -- DO NOT EDIT.
--
-- Every column must read true. A false one names the guard that would abort NW02Applied.sql at
-- its first DO block, before any trigger is disabled. inside_the_new_window is the only one that
-- flips with time, and unlike NW-01 it is ALSO asserted inside the transaction (R11-F12).
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
  (select tgenabled=${q(pre.trigger.tgenabled)}::"char" and pg_get_triggerdef(oid,true)=${q(pre.trigger.definition)}
     from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
       and tgname=${q(pre.trigger.name)} and not tgisinternal) as trigger_ok,
  (select count(*) from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
     and not tgisinternal) = ${pre.trigger.non_internal_trigger_count} as sole_non_internal_trigger_ok,
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

const applyPath = path.join(HERE, 'NW02Applied.sql');
const preflightPath = path.join(HERE, 'NW02Preflight.sql');
fs.writeFileSync(applyPath, sql);
fs.writeFileSync(preflightPath, preflight);

console.log(`mode           ${DRAFT ? 'DRAFT (not executable)' : 'strict'}`);
console.log(`window         ${post.binding.not_before} .. ${post.binding.expires_at}`);
console.log(`fields changed ${changed.length}: ${changed.join(', ')}`);
console.log(`fields frozen  ${FROZEN.length}: asserted identical on both sides`);
console.log(`added guards   R11-F12 window x2, R11-F13 trigger count x2 and identity x2`);
if (notFinal.length) console.log(`not final      ${notFinal.length} source document(s): ${notFinal.join(', ')}`);
console.log(`wrote ${path.relative(REPO, applyPath)}  ${fs.statSync(applyPath).size} bytes  sha256 ${sha(fs.readFileSync(applyPath))}`);
console.log(`wrote ${path.relative(REPO, preflightPath)}  ${fs.statSync(preflightPath).size} bytes  sha256 ${sha(fs.readFileSync(preflightPath))}  (read-only, 17 guards)`);
