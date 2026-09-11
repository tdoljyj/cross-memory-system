begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table clued_control.accepted_binding in access exclusive mode;
lock table clued_control.control_objects,
           clued_control.current_head,
           clued_control.events,
           clued_control.execution_binding,
           clued_control.execution_current,
           clued_control.execution_events,
           clued_control.gate_attempts in share mode;

do $nw01_pre$
declare
  v_rows_sha text;
  v_catalog_sha text;
  v_def text;
  v_enabled "char";
  v_trigger_def text;
  v_owner text;
  v_acl text;
  v_n bigint;
begin
  select encode(sha256(convert_to((select jsonb_build_object('accepted_binding',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.accepted_binding x),'control_objects',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.control_objects x),'current_head',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.current_head x),'events',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.events x),'execution_binding',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.execution_binding x),'execution_current',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.execution_current x),'execution_events',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.execution_events x),'gate_attempts',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.gate_attempts x)))::text,'UTF8')),'hex')
    into v_rows_sha;
  if v_rows_sha is distinct from 'c3faab99e3947fd6135ac2a0cbdb06b4602cd39311acfc054f8690a4d9cf4b9d' then
    raise exception 'NW01_PREIMAGE_ROWS_DRIFT';
  end if;

  select encode(sha256(convert_to((select jsonb_build_object(
    'effective_execution_binding', jsonb_build_object(
      'full_definition_sha256', encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex')
    )
  ))::text,'UTF8')),'hex') into v_catalog_sha;
  if v_catalog_sha is distinct from '640983338ecd8e26758fc409e1f003bd100d3b1cb06494214b80b6d869ccce21' then
    raise exception 'NW01_PREIMAGE_CATALOG_DRIFT';
  end if;

  if (select encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex'))
       is distinct from '3d3c9624204fb10e5d0147bb06c7f265043014f612a2e30abbfb0311a0ca092d' then
    raise exception 'NW01_GETTER_DEFINITION_DRIFT';
  end if;

  if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
      where oid='clued_control.effective_execution_binding()'::regprocedure)
       is distinct from '2cddb4593c0facd4308dcefbbb8dbf05819df7e7abff70e30e3114e543e67646' then
    raise exception 'NW01_GETTER_PROSRC_DRIFT';
  end if;

  select count(*) into v_n from clued_control.accepted_binding;
  if v_n <> 1 then raise exception 'NW01_BINDING_ROW_COUNT_DRIFT'; end if;

  perform 1 from clued_control.accepted_binding b
   where b.root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
     and b.project_ref='uscrdifznmlvczcekqpw'
     and b.purpose='SKILL_COEXISTENCE_QUALIFICATION'
     and b.environment='ISOLATED_TEST'
     and b.subject_sha256='164e61bca21ebe80caa6c0db874e521a1af90cad495d820f5456827144719c0e'
     and b.owner_approval_commit='e0791841a95dfc415a8acac89d07be0f1caa8a89'
     and b.not_before='2026-09-10T10:21:05Z'::timestamptz
     and b.expires_at='2026-09-11T10:21:05Z'::timestamptz
     and b.issuer='tdoljyj'
     and b.audience='urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw'
     and b.algorithm_config='SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE;SHA-256;GITHUB_API_VERIFIED_OWNER_MERGE'
     and b.schema_sha256='87f094fa079034aa886d6c568730370a3264e106529b4bfd79bc3369f30b79e5'
     and b.registration_acceptance_sha256='de36aa0cd58d79fa6d15dfe8d76f5536797d4061812176d5dbce9e915b3ce51a'
     and b.store_acceptance_sha256='33f5dcdcf1197e643c43d943b738fbaf53b33ec6ea2f3f036be5cf714f5d60ff'
     and b.protocol_mapping_sha256='abbc8e7eae03f2a183fd739fa49b16a97db6e1c0fb62a9353a30db81553db416'
     and b.signature_evidence_sha256='1565c2bd74d9c81612d569c3cef38d13d62f98dc4b6beaf804777bcc8748b083';
  if not found then raise exception 'NW01_OLD_BINDING_PREIMAGE_MISMATCH'; end if;

  perform 1 from clued_control.execution_current
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
     and sequence=87
     and active_ga_id is null
     and pending_budget_sequence is null
     and charged_seconds=9906
     and charged_evidence_bytes=2201594803;
  if not found then raise exception 'NW01_EXECUTION_STATE_DRIFT'; end if;

  perform 1 from clued_control.current_head
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
     and sequence=5
     and generation_id='ctrgen_e5df432221344996afc04b5638121d96'
     and revoked=false;
  if not found then raise exception 'NW01_ROOT_HEAD_DRIFT'; end if;

  select pg_get_constraintdef(oid,true) into v_def
    from pg_constraint where conrelid='clued_control.accepted_binding'::regclass
    and conname='accepted_binding_check';
  if v_def is distinct from 'CHECK (expires_at <= ''2026-09-11 10:21:05+00''::timestamp with time zone AND expires_at > not_before)' then
    raise exception 'NW01_OLD_WINDOW_CHECK_DRIFT';
  end if;

  select pg_get_constraintdef(oid,true) into v_def
    from pg_constraint where conrelid='clued_control.accepted_binding'::regclass
    and conname='accepted_binding_owner_approval_commit_check';
  if v_def is distinct from 'CHECK (owner_approval_commit = ''e0791841a95dfc415a8acac89d07be0f1caa8a89''::text)' then
    raise exception 'NW01_OLD_APPROVAL_CHECK_DRIFT';
  end if;

  select pg_get_constraintdef(oid,true) into v_def
    from pg_constraint where conrelid='clued_control.accepted_binding'::regclass
    and conname='accepted_binding_subject_sha256_check';
  if v_def is distinct from 'CHECK (subject_sha256 = ''164e61bca21ebe80caa6c0db874e521a1af90cad495d820f5456827144719c0e''::text)' then
    raise exception 'NW01_OLD_SUBJECT_CHECK_DRIFT';
  end if;

  select tgenabled, pg_get_triggerdef(oid,true) into v_enabled, v_trigger_def
    from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
    and tgname='accepted_binding_immutable' and not tgisinternal;
  if v_enabled is distinct from 'O'::"char"
     or v_trigger_def is distinct from 'CREATE TRIGGER accepted_binding_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON clued_control.accepted_binding FOR EACH STATEMENT EXECUTE FUNCTION clued_control.deny_mutation()' then
    raise exception 'NW01_IMMUTABLE_TRIGGER_DRIFT';
  end if;

  select pg_get_userbyid(c.relowner), coalesce(c.relacl::text,'NULL') into v_owner,v_acl
    from pg_class c where c.oid='clued_control.accepted_binding'::regclass;
  if v_owner is distinct from 'postgres' or v_acl is distinct from '{postgres=arwdDxtm/postgres}' then
    raise exception 'NW01_OWNER_OR_ACL_DRIFT';
  end if;
end
$nw01_pre$;

alter table clued_control.accepted_binding disable trigger accepted_binding_immutable;

alter table clued_control.accepted_binding
  drop constraint accepted_binding_check,
  drop constraint accepted_binding_owner_approval_commit_check,
  drop constraint accepted_binding_subject_sha256_check;

update clued_control.accepted_binding
set not_before='2026-09-11T13:14:51Z'::timestamptz,
    expires_at='2026-09-12T13:14:51Z'::timestamptz,
    owner_approval_commit='4498102661f626c8e0c489c7d27551acbc8436ea',
    subject_sha256='46867dca9fcdda12580fafe429e07f2e1c71d5ae9d8338a03c1f57221debe1b8',
    registration_acceptance_sha256='40508697dd071ea39528aabef36a440d73a7ee3a78c32efaafab3cf51a87e3b7',
    store_acceptance_sha256='66f6d8082e0a0a15a02e473ba870689a9912291c03f6eebcf7f666aaf5294d52',
    signature_evidence_sha256='ae269c08d02d941f91450594c31ce134b999cdfd61b5acd762b5f616a5965376'
where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';

alter table clued_control.accepted_binding
  add constraint accepted_binding_check
    check (expires_at <= '2026-09-12T13:14:51Z'::timestamptz and expires_at > not_before),
  add constraint accepted_binding_owner_approval_commit_check
    check (owner_approval_commit='4498102661f626c8e0c489c7d27551acbc8436ea'::text),
  add constraint accepted_binding_subject_sha256_check
    check (subject_sha256='46867dca9fcdda12580fafe429e07f2e1c71d5ae9d8338a03c1f57221debe1b8'::text);

alter table clued_control.accepted_binding enable trigger accepted_binding_immutable;

do $nw01_post$
declare
  v_def text;
  v_enabled "char";
  v_trigger_def text;
  v_owner text;
  v_acl text;
  v_n bigint;
begin
  select count(*) into v_n from clued_control.accepted_binding;
  if v_n <> 1 then raise exception 'NW01_POST_BINDING_ROW_COUNT_MISMATCH'; end if;

  perform 1 from clued_control.accepted_binding b
   where b.root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
     and b.project_ref='uscrdifznmlvczcekqpw'
     and b.purpose='SKILL_COEXISTENCE_QUALIFICATION'
     and b.environment='ISOLATED_TEST'
     and b.subject_sha256='46867dca9fcdda12580fafe429e07f2e1c71d5ae9d8338a03c1f57221debe1b8'
     and b.owner_approval_commit='4498102661f626c8e0c489c7d27551acbc8436ea'
     and b.not_before='2026-09-11T13:14:51Z'::timestamptz
     and b.expires_at='2026-09-12T13:14:51Z'::timestamptz
     and b.issuer='tdoljyj'
     and b.audience='urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw'
     and b.algorithm_config='SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE;SHA-256;GITHUB_API_VERIFIED_OWNER_MERGE'
     and b.schema_sha256='87f094fa079034aa886d6c568730370a3264e106529b4bfd79bc3369f30b79e5'
     and b.registration_acceptance_sha256='40508697dd071ea39528aabef36a440d73a7ee3a78c32efaafab3cf51a87e3b7'
     and b.store_acceptance_sha256='66f6d8082e0a0a15a02e473ba870689a9912291c03f6eebcf7f666aaf5294d52'
     and b.protocol_mapping_sha256='abbc8e7eae03f2a183fd739fa49b16a97db6e1c0fb62a9353a30db81553db416'
     and b.signature_evidence_sha256='ae269c08d02d941f91450594c31ce134b999cdfd61b5acd762b5f616a5965376';
  if not found then raise exception 'NW01_POST_BINDING_MISMATCH'; end if;

  perform 1 from clued_control.execution_current
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
     and sequence=87 and active_ga_id is null and pending_budget_sequence is null
     and charged_seconds=9906 and charged_evidence_bytes=2201594803;
  if not found then raise exception 'NW01_POST_EXECUTION_STATE_CHANGED'; end if;

  perform 1 from clued_control.current_head
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
     and sequence=5 and generation_id='ctrgen_e5df432221344996afc04b5638121d96'
     and revoked=false;
  if not found then raise exception 'NW01_POST_ROOT_HEAD_CHANGED'; end if;

  select tgenabled, pg_get_triggerdef(oid,true) into v_enabled, v_trigger_def
    from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
    and tgname='accepted_binding_immutable' and not tgisinternal;
  if v_enabled is distinct from 'O'::"char"
     or v_trigger_def is distinct from 'CREATE TRIGGER accepted_binding_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON clued_control.accepted_binding FOR EACH STATEMENT EXECUTE FUNCTION clued_control.deny_mutation()' then
    raise exception 'NW01_POST_TRIGGER_NOT_RESTORED';
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_check';
  if v_def is distinct from 'CHECK (expires_at <= ''2026-09-12 13:14:51+00''::timestamp with time zone AND expires_at > not_before)' then
    raise exception 'NW01_POST_WINDOW_CHECK_MISMATCH';
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_owner_approval_commit_check';
  if v_def is distinct from 'CHECK (owner_approval_commit = ''4498102661f626c8e0c489c7d27551acbc8436ea''::text)' then
    raise exception 'NW01_POST_APPROVAL_CHECK_MISMATCH';
  end if;

  select pg_get_constraintdef(oid,true) into v_def from pg_constraint
   where conrelid='clued_control.accepted_binding'::regclass and conname='accepted_binding_subject_sha256_check';
  if v_def is distinct from 'CHECK (subject_sha256 = ''46867dca9fcdda12580fafe429e07f2e1c71d5ae9d8338a03c1f57221debe1b8''::text)' then
    raise exception 'NW01_POST_SUBJECT_CHECK_MISMATCH';
  end if;

  select pg_get_userbyid(c.relowner), coalesce(c.relacl::text,'NULL') into v_owner,v_acl
    from pg_class c where c.oid='clued_control.accepted_binding'::regclass;
  if v_owner is distinct from 'postgres' or v_acl is distinct from '{postgres=arwdDxtm/postgres}' then
    raise exception 'NW01_POST_OWNER_OR_ACL_CHANGED';
  end if;
end
$nw01_post$;

commit;
