-- CANDIDATE: Clued P0-4 C1 stage 2; Task 9a4d6d2c.
-- Source baseline: 11aaf43268577bfce9a4e18fb2cc3b26b5c7c26c.
-- Executable SQL is identical to frozen candidate SHA256
-- 26f258ac5b6d70cca0a552f0bfd2ac665fc0924410b44200e4b16796617fa074.
-- Owner Decision 23d196f2-a6d5-4116-9d18-8c4091ddf925 replaces only
-- the observation minimum with 6h. All business evidence and exact
-- stage-2 production authority gates still apply before promotion/application.
-- CI8 and Worker80 are exact; Native/P5 and platform auth helpers remain.
-- No credentials or roles are created; the caller executes atomically.

do $worker_gateway_closeout$
declare
  signature text;
  expected_signatures text[]:=array[
    'public.clued_agent_inbox_summary_v1(text,jsonb)',
    'public.clued_agent_inbox_v1(text,jsonb)',
    'public.clued_agent_message_send_v1(text,jsonb)',
    'public.clued_authorization_revoke_issuer_v12(text,uuid)',
    'public.clued_authorization_status_v12(text)',
    'public.clued_canonical_export_v2(text,jsonb)',
    'public.clued_context_pack(text,jsonb)',
    'public.clued_decision_supersede(text,jsonb)',
    'public.clued_development_call_v14(text,jsonb)',
    'public.clued_event_append(text,jsonb)',
    'public.clued_evidence_ingest(text,jsonb)',
    'public.clued_intake_list(text,jsonb)',
    'public.clued_intake_submit(text,jsonb)',
    'public.clued_intake_withdraw(text,jsonb)',
    'public.clued_integration_create_or_bind_v1(text,jsonb)',
    'public.clued_integration_declare_v1(text,jsonb)',
    'public.clued_integration_identity_update_v1(text,jsonb)',
    'public.clued_integration_reconcile_request_v1(text,jsonb)',
    'public.clued_integration_report_v1(text,jsonb)',
    'public.clued_integration_request_open_v1(text,jsonb)',
    'public.clued_integration_revoke_self_v1(text,jsonb)',
    'public.clued_integration_status_v1(text,jsonb)',
    'public.clued_integration_verify_v1(text,jsonb)',
    'public.clued_knowledge_propose(text,jsonb)',
    'public.clued_mcp_append_event(text,jsonb)',
    'public.clued_mcp_audit_receipts(text,jsonb)',
    'public.clued_mcp_commit_checkpoint(text,jsonb)',
    'public.clued_mcp_currentness_g6_gate(text,jsonb)',
    'public.clued_mcp_event_carrier_transition(text,jsonb)',
    'public.clued_mcp_full_global_reconcile(text,jsonb)',
    'public.clued_mcp_import_log(text,jsonb)',
    'public.clued_mcp_mtpe_owner_pin(text,jsonb)',
    'public.clued_mcp_mtpe_snapshot(text,jsonb)',
    'public.clued_mcp_mtpe_validate(text,jsonb)',
    'public.clued_mcp_projection_rebuild(text,jsonb)',
    'public.clued_mcp_projection_refresh_apply(text,jsonb)',
    'public.clued_mcp_projection_refresh_claim(text,jsonb)',
    'public.clued_mcp_projection_refresh_heartbeat(text,jsonb)',
    'public.clued_mcp_read_log(text,jsonb)',
    'public.clued_mcp_restore(text,jsonb)',
    'public.clued_mcp_search_context(text,jsonb)',
    'public.clued_mcp_session_reconcile(text,jsonb)',
    'public.clued_model_dataset_split_bootstrap_commit_candidate(text,jsonb)',
    'public.clued_model_dataset_split_bootstrap_readiness_candidate(text,jsonb)',
    'public.clued_model_dataset_split_owner_anchor_refs_candidate(text,jsonb)',
    'public.clued_model_dataset_split_resolve_refs_candidate(text,jsonb)',
    'public.clued_model_dataset_split_verify_candidate(text,jsonb)',
    'public.clued_model_dataset_split_verify_successor_candidate(text,jsonb)',
    'public.clued_model_reference_owner_approval_refs_candidate(text,jsonb)',
    'public.clued_owner_request_bundle_v1(text,jsonb)',
    'public.clued_owner_request_status_v1(text,jsonb)',
    'public.clued_owner_request_v1(text,jsonb)',
    'public.clued_project_list_v2(text,jsonb)',
    'public.clued_project_mutate_v2(text,jsonb)',
    'public.clued_record_list(text,jsonb)',
    'public.clued_record_mutate(text,jsonb)',
    'public.clued_resource_center_authority_v1(text,jsonb)',
    'public.clued_resource_center_renew_v1(text,jsonb)',
    'public.clued_resource_center_write_v1(text,jsonb)',
    'public.clued_storage_access_digest_backfill_v1(text,jsonb)',
    'public.clued_storage_cloud_worker_router_v2(text,jsonb)',
    'public.clued_storage_cloud_worker_v1(text,jsonb)',
    'public.clued_storage_connections_v1(text)',
    'public.clued_storage_jobs_router_v2(text,jsonb)',
    'public.clued_storage_jobs_v1(text,jsonb)',
    'public.clued_storage_onboard_sweep_v1(text)',
    'public.clued_storage_queued_sweep_v1(text,jsonb)',
    'public.clued_storage_read_v1(text,text,jsonb)',
    'public.clued_storage_recovery_absent_v1(text,jsonb)',
    'public.clued_storage_refresh_worker_v1(text,jsonb)',
    'public.clued_storage_release_unattempted_v1(text,jsonb)',
    'public.clued_storage_scheduled_recovery_v2(text,jsonb)',
    'public.clued_storage_staging_v1(text,text,jsonb)',
    'public.clued_storage_trash_batch_v1(text,jsonb)',
    'public.clued_work_claim_v1(text,jsonb)',
    'public.clued_work_claims_active_v1(text,jsonb)',
    'public.clued_work_release_v1(text,jsonb)',
    'public.clued_work_renew_v1(text,jsonb)',
    'public.clued_work_takeover_v1(text,jsonb)',
    'public.clued_work_verify_v1(text,jsonb)'
  ];
  ci_signatures text[]:=array[
    'public.clued_owner_grant_admission_door_v1(text,jsonb)',
    'public.clued_owner_grant_door_consume_v1(text,jsonb)',
    'public.clued_work_verify_v1(text,jsonb)',
    'public.clued_work_claim_adopt_v1(text,jsonb)',
    'public.clued_work_merge_slot_return_v1(text,jsonb)',
    'public.clued_work_claims_active_v1(text,jsonb)',
    'public.clued_work_merge_slot_touch_v1(text,jsonb)',
    'public.clued_work_merge_slot_holders_v1(text,jsonb)'
  ];
  -- These exact legacy SQL aliases are not current Worker/CI direct entry points.
  -- The storage alias remains an internal callee of its SECURITY DEFINER router;
  -- withdraw only anonymous direct access, without changing either business body.
  legacy_signatures text[]:=array[
    'public.clued_project_mutate(text,jsonb)',
    'public.clued_storage_jobs_v2(text,jsonb)'
  ];
  -- Final catalog sources after the complete migration chain (including 2a),
  -- independently measured by the local harness; do not pin the old pre-2a text.
  -- project: 20260825171129:695; current projects.ts:54 routes to its v2 successor.
  -- storage: 20260928072813:330; :354 retains the SD router's internal call.
  legacy_source_sha256 text[]:=array[
    '64503257b828c3dcf1405fc378a9d297faf559cec29a373e77e5013e2eb76262',
    '148f8b9926a831881ee2eb7ad3ae5b6e5a8ddafefe9553b60adcaf64d6657403'
  ];
  expected_oids oid[]; ci_oids oid[]; accepted_oids oid[]; withdrawn_oids oid[]; legacy_oids oid[];
  gateway_oid oid:=pg_catalog.to_regrole('clued_worker_gateway');
  anon_oid oid:=pg_catalog.to_regrole('anon');
  g6_oid oid:=pg_catalog.to_regprocedure('public.clued_mcp_currentness_g6_gate(text,jsonb)');
  diagnostic jsonb; g6_source text; g6_definition text; rewritten_definition text;
  native_catalog_before jsonb; native_catalog_after jsonb;
  legacy_catalog_before jsonb; legacy_catalog_after jsonb;
  baseline_md5 constant text:='17c1699074b9b2128197ff961b65f232';
  guarded_md5 constant text:='b446b925b915e7654dc8db4085e66bea';
  legacy_resolver_md5 constant text:='83d91a318bfab293713ad8771c831953';
  anchor constant text:=$g6_anchor$begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');$g6_anchor$;
  guarded_anchor constant text:=$g6_anchor_guarded$begin
  -- C1_PHASE2_G6_CALLER_GUARD_V1: transport role, not definer ownership or payload.
  declare
    g6_transport_claims jsonb;
  begin
    begin
      g6_transport_claims:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claims',true),''),'{}')::jsonb;
    exception when invalid_text_representation then
      raise exception 'worker_gateway_required' using errcode='42501';
    end;
    if pg_catalog.current_setting('role',true) is distinct from 'clued_worker_gateway'
      or pg_catalog.jsonb_typeof(g6_transport_claims) is distinct from 'object'
      or g6_transport_claims->>'role' is distinct from 'clued_worker_gateway' then
      raise exception 'worker_gateway_required' using errcode='42501';
    end if;
  end;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');$g6_anchor_guarded$;
begin
  if gateway_oid is null or anon_oid is null or g6_oid is null
    or pg_catalog.to_regrole('postgres') is null or pg_catalog.to_regrole('authenticator') is null then
    raise exception 'worker_gateway_closeout_prerequisite_missing' using errcode='42501',
      detail=jsonb_build_object('schema','clued.worker-gateway-closeout-diagnostic.v1',
        'gateway_present',gateway_oid is not null,'anon_present',anon_oid is not null,'g6_present',g6_oid is not null)::text;
  end if;
  select coalesce(array_remove(array_agg(pg_catalog.to_regprocedure(s)::oid),null),'{}') into expected_oids from unnest(expected_signatures) s;
  select coalesce(array_remove(array_agg(pg_catalog.to_regprocedure(s)::oid),null),'{}') into ci_oids from unnest(ci_signatures) s;
  select coalesce(array_remove(array_agg(pg_catalog.to_regprocedure(s)::oid),null),'{}') into legacy_oids from unnest(legacy_signatures) s;
  select array_agg(distinct x order by x) into accepted_oids from unnest(expected_oids||ci_oids||legacy_oids) x;
  select coalesce(array_agg(x order by x),'{}') into withdrawn_oids from unnest(expected_oids) x where not(x=any(ci_oids));

  -- Preflight before every mutation. Unknown objects/ACLs are an admission error,
  -- not permission to silently revoke unreviewed subjects or to repair grants.
  with violations as (
    select jsonb_build_object('kind','role_attributes','role',r.rolname,'login',r.rolcanlogin,
      'inherit',r.rolinherit,'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,
      'replication',r.rolreplication,'bypassrls',r.rolbypassrls,
      'config_keys',array(select split_part(setting,'=',1) from unnest(r.rolconfig) setting)) v
    from pg_catalog.pg_roles r where r.oid=gateway_oid and
      (r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls
        or r.rolconfig is distinct from array['statement_timeout=3s']::text[])
    union all
    select jsonb_build_object('kind','role_membership','role',m.roleid::regrole::text,'member',m.member::regrole::text,
      'grantor',m.grantor::regrole::text,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
    from pg_catalog.pg_auth_members m where m.member in (gateway_oid,anon_oid)
    union all
    select jsonb_build_object('kind','authenticator_membership_missing','role','clued_worker_gateway')
    where not exists(select 1 from pg_catalog.pg_auth_members m where m.roleid=gateway_oid
      and m.member='authenticator'::regrole and not m.admin_option and not m.inherit_option and m.set_option)
    union all
    select jsonb_build_object('kind','manifest_function_missing','object',s)
    from unnest(expected_signatures||ci_signatures||legacy_signatures) s where pg_catalog.to_regprocedure(s) is null
    union all
    select jsonb_build_object('kind','manifest_function_metadata','schema',n.nspname,'object',p.oid::regprocedure::text,
      'owner',p.proowner::regrole::text,'kind_code',p.prokind,'security_definer',p.prosecdef)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where p.oid=any(accepted_oids) and (n.nspname<>'public' or p.prokind<>'f' or not p.prosecdef or p.proowner<>'postgres'::regrole)
    union all
    select jsonb_build_object('kind','legacy_alias_source_drift','schema','public','object',s.signature,
      'owner',p.proowner::regrole::text,'security_definer',p.prosecdef,
      'source_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex'),
      'config_keys',array(select split_part(setting,'=',1) from unnest(p.proconfig) setting))
    from unnest(legacy_signatures,legacy_source_sha256) s(signature,source_sha256)
      join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(s.signature)
    where pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')<>s.source_sha256
      or p.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
      or p.proconfig is distinct from array['search_path=""']::text[]
    union all
    select jsonb_build_object('kind','gateway_manifest_execute_missing','object',p.oid::regprocedure::text)
    from pg_catalog.pg_proc p where p.oid=any(expected_oids) and
      (not pg_catalog.has_function_privilege(gateway_oid,p.oid,'EXECUTE') or not exists(
        select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee=gateway_oid
          and a.privilege_type='EXECUTE' and not a.is_grantable))
    union all
    select jsonb_build_object('kind','ci_anon_execute_missing','object',p.oid::regprocedure::text)
    from pg_catalog.pg_proc p where p.oid=any(ci_oids) and
      (not pg_catalog.has_function_privilege(anon_oid,p.oid,'EXECUTE') or not exists(
        select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee=anon_oid
          and a.privilege_type='EXECUTE' and not a.is_grantable))
    union all
    select jsonb_build_object('kind','unknown_anon_definer','schema',n.nspname,'object',p.oid::regprocedure::text,
      'owner',p.proowner::regrole::text,'acl',p.proacl::text)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and pg_catalog.has_function_privilege(anon_oid,p.oid,'EXECUTE')
      and not(p.oid=any(accepted_oids))
    union all
    select jsonb_build_object('kind','unknown_anon_function_acl','schema',n.nspname,'object',p.oid::regprocedure::text,
      'grantor',a.grantor::regrole::text,'grantee','anon','privilege',a.privilege_type,'grantable',a.is_grantable)
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      join lateral pg_catalog.aclexplode(p.proacl) a on a.grantee=anon_oid
    -- The anon8 contract governs Clued application RPCs, not platform helpers
    -- such as auth.uid()/auth.jwt(). Private Clued direct grants remain denied.
    -- The separate public SECURITY DEFINER scan above still rejects unknown
    -- exposed privileged entry points, even when they use an unfamiliar name.
    where ((n.nspname='public' and p.proname like 'clued\_%' escape '\') or n.nspname='clued_private')
      and (not(p.oid=any(accepted_oids)) or a.is_grantable or a.privilege_type<>'EXECUTE')
    union all
    select jsonb_build_object('kind','unexpected_manifest_acl','object',p.oid::regprocedure::text,
      'grantee',case when a.grantee=0 then 'PUBLIC' else a.grantee::regrole::text end,
      'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)
    from pg_catalog.pg_proc p join lateral pg_catalog.aclexplode(p.proacl) a on true
    where p.oid=any(accepted_oids) and (a.privilege_type<>'EXECUTE'
      or a.grantor<>p.proowner or (a.grantee<>p.proowner and a.is_grantable)
      or a.grantee not in (p.proowner,anon_oid,gateway_oid,'authenticated'::regrole,'service_role'::regrole,0))
    union all
    select jsonb_build_object('kind','legacy_oauth_resolver_drift','object','clued_private.resolve_oauth_binding()',
      'body_md5',p.prosrc_md5)
    from (select pg_catalog.md5(prosrc) prosrc_md5 from pg_catalog.pg_proc
      where oid=pg_catalog.to_regprocedure('clued_private.resolve_oauth_binding()')) p
    where p.prosrc_md5<>legacy_resolver_md5
    union all
    select jsonb_build_object('kind','legacy_oauth_resolver_missing','object','clued_private.resolve_oauth_binding()')
    where pg_catalog.to_regprocedure('clued_private.resolve_oauth_binding()') is null
    union all
    select jsonb_build_object('kind','g6_source_drift','object','public.clued_mcp_currentness_g6_gate(text,jsonb)',
      'body_md5',pg_catalog.md5(p.prosrc),'config_keys',array(select split_part(setting,'=',1) from unnest(p.proconfig) setting))
    from pg_catalog.pg_proc p where p.oid=g6_oid and (pg_catalog.md5(p.prosrc) not in (baseline_md5,guarded_md5)
      or p.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
      or p.proconfig is distinct from array['search_path=""']::text[])
  ), bounded as (select v,count(*) over() total from violations order by v::text limit 100)
  select jsonb_build_object('schema','clued.worker-gateway-closeout-diagnostic.v1','violations',coalesce(jsonb_agg(v order by v::text),'[]'),
    'violation_count',coalesce(max(total),0),'truncated',coalesce(max(total)>100,false)) into diagnostic from bounded;
  if diagnostic->>'violation_count'<>'0' then
    raise exception 'worker_gateway_closeout_boundary_unqualified' using errcode='42501',detail=diagnostic::text;
  end if;

  -- An existing role is accepted only if the entire boundary is still qualified.
  -- Unexpected privileges are refused, never silently removed on replay.
  -- PostgreSQL grants a non-superuser CREATEROLE creator an administrative-only
  -- membership, issued by the bootstrap superuser (fixed catalog OID 10).
  -- Accept only that exact postgres management edge; it cannot inherit or SET ROLE.
  if exists(select 1 from pg_catalog.pg_auth_members m
      where m.roleid='clued_worker_gateway'::regrole
        and not ((m.member='authenticator'::regrole and not m.admin_option
          and not m.inherit_option and m.set_option)
          or (m.member='postgres'::regrole and m.grantor=10 and m.admin_option
            and not m.inherit_option and not m.set_option)))
    or pg_catalog.has_schema_privilege('clued_worker_gateway','public','CREATE')
    or exists(select 1 from pg_catalog.pg_namespace n
      where n.nspname not in ('public','information_schema') and n.nspname !~ '^pg_'
        and pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE,CREATE'))
    or exists(select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where case when c.relkind in ('r','p','v','m','f') then
          ((n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'
            and pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE')
            and (pg_catalog.has_table_privilege('clued_worker_gateway',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
              or pg_catalog.has_any_column_privilege('clued_worker_gateway',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
           or exists(select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee='clued_worker_gateway'::regrole)
           or exists(select 1 from pg_catalog.pg_attribute col
             join lateral pg_catalog.aclexplode(col.attacl) a on a.grantee='clued_worker_gateway'::regrole
             where col.attrelid=c.oid and col.attnum>0 and not col.attisdropped)) else false end)
    -- Sequence operations accept numeric regclass OIDs: schema USAGE is not
    -- required for that path, so every effective sequence privilege is refused.
    or exists(select 1 from pg_catalog.pg_class c
      where case when c.relkind='S' then
        pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,SELECT,UPDATE') else false end)
    or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and pg_catalog.has_function_privilege('clued_worker_gateway',p.oid,'EXECUTE')
        and not (p.oid=any(expected_oids)))
    or exists(select 1 from pg_catalog.pg_proc p
      join lateral pg_catalog.aclexplode(p.proacl) a on a.grantee='clued_worker_gateway'::regrole
      where not (p.oid=any(expected_oids)) or a.is_grantable)
    or exists(select 1 from pg_catalog.pg_shdepend d
      where d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid='clued_worker_gateway'::regrole
        and d.deptype='o') then
    -- Diagnostics read catalog identity and ACL metadata only, never business
    -- rows, function bodies, role settings or comments. Match the access/direct
    -- grant predicates above; bounded DETAIL identifies each rejected kind.
    with violations as (
      select jsonb_build_object('kind','gateway_membership','role',m.roleid::regrole::text,
        'member',m.member::regrole::text,'grantor',m.grantor::regrole::text,
        'grantor_oid',m.grantor,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) v
      from pg_catalog.pg_auth_members m where m.roleid='clued_worker_gateway'::regrole
        and not ((m.member='authenticator'::regrole and not m.admin_option and not m.inherit_option and m.set_option)
          or (m.member='postgres'::regrole and m.grantor=10 and m.admin_option and not m.inherit_option and not m.set_option))
      union all
      select jsonb_build_object('kind','schema_permission','object',n.nspname,
        'usage',pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE'),
        'create',pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'CREATE'),
        'acl',n.nspacl::text)
      from pg_catalog.pg_namespace n where
        (n.nspname='public' and pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'CREATE'))
        or (n.nspname not in ('public','information_schema') and n.nspname !~ '^pg_'
          and pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE,CREATE'))
      union all
      select jsonb_build_object('kind','table_permission','schema',n.nspname,
        'object',pg_catalog.format('%I.%I',n.nspname,c.relname),
        'schema_usage',pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE'),
        'direct_acl',exists(select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee='clued_worker_gateway'::regrole),
        'privileges',array(select privilege from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege
          where pg_catalog.has_table_privilege('clued_worker_gateway',c.oid,privilege)), 'acl',c.relacl::text)
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where case when c.relkind in ('r','p','v','m','f') then
          ((n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'
            and pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE')
            and pg_catalog.has_table_privilege('clued_worker_gateway',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
           or exists(select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee='clued_worker_gateway'::regrole)) else false end
      union all
      select jsonb_build_object('kind','column_permission','schema',n.nspname,
        'object',pg_catalog.format('%I.%I',n.nspname,c.relname),
        'schema_usage',pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE'),
        'direct_acl',exists(select 1 from pg_catalog.aclexplode(a.attacl) acl where acl.grantee='clued_worker_gateway'::regrole),
        'column',a.attname,'privileges',array(select privilege from unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) privilege
          where pg_catalog.has_column_privilege('clued_worker_gateway',c.oid,a.attnum,privilege)), 'acl',a.attacl::text)
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      where case when c.relkind in ('r','p','v','m','f') then
          ((n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'
            and pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE')
            and not pg_catalog.has_table_privilege('clued_worker_gateway',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
            and pg_catalog.has_column_privilege('clued_worker_gateway',c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES'))
           or exists(select 1 from pg_catalog.aclexplode(a.attacl) acl where acl.grantee='clued_worker_gateway'::regrole)) else false end
      union all
      select jsonb_build_object('kind','sequence_permission','schema',n.nspname,
        'object',pg_catalog.format('%I.%I',n.nspname,c.relname),
        'schema_usage',pg_catalog.has_schema_privilege('clued_worker_gateway',n.oid,'USAGE'),
        'direct_acl',exists(select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee='clued_worker_gateway'::regrole),
        'privileges',array(select privilege from unnest(array['USAGE','SELECT','UPDATE']) privilege
          where pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,privilege)), 'acl',c.relacl::text)
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where case when c.relkind='S' then
        pg_catalog.has_sequence_privilege('clued_worker_gateway',c.oid,'USAGE,SELECT,UPDATE') else false end
      union all
      select jsonb_build_object('kind','function_permission','object',p.oid::regprocedure::text,
        'privileges',array['EXECUTE'],'acl',coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))::text)
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and pg_catalog.has_function_privilege('clued_worker_gateway',p.oid,'EXECUTE')
        and not (p.oid=any(expected_oids))
      union all
      select jsonb_build_object('kind','function_acl','object',p.oid::regprocedure::text,
        'grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
      from pg_catalog.pg_proc p join lateral pg_catalog.aclexplode(p.proacl) a on a.grantee='clued_worker_gateway'::regrole
      where not (p.oid=any(expected_oids)) or a.is_grantable
      union all
      select jsonb_build_object('kind','ownership','database',(select datname from pg_catalog.pg_database where oid=d.dbid),
        'class',d.classid::regclass::text,'object_oid',d.objid,'subobject',d.objsubid,
        'object',case when d.dbid=0 or d.dbid=(select oid from pg_catalog.pg_database where datname=current_database())
          then pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid) else null end)
      from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass
        and d.refobjid='clued_worker_gateway'::regrole and d.deptype='o'
    ), bounded as (select v,count(*) over() total from violations order by v::text limit 100)
    select jsonb_build_object('schema','clued.worker-gateway-diagnostic.v1','violations',jsonb_agg(v order by v::text),
      'violation_count',max(total),'truncated',max(total)>100) into diagnostic from bounded;
    raise exception 'worker_gateway_role_unexpected_privileges' using errcode='42501', detail=diagnostic::text;
  end if;

  -- Preserve every unrelated Native/P5/private entry exactly, including the two
  -- dual CI/Worker entries and the six CI-only entries. No GRANT repairs on replay.
  select coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,
    'source_md5',pg_catalog.md5(p.prosrc),'config',p.proconfig) order by p.oid),'[]') into native_catalog_before
    from pg_catalog.pg_proc p where not(p.oid=any(withdrawn_oids||legacy_oids));
  select coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'language',p.prolang,
    'security_definer',p.prosecdef,'source_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex'),
    'config',p.proconfig,'other_acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',a.grantor,'grantee',a.grantee,
      'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantor,a.grantee,a.privilege_type),'[]')
      from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee not in (0,anon_oid)))
    order by p.oid),'[]') into legacy_catalog_before from pg_catalog.pg_proc p where p.oid=any(legacy_oids);
  select prosrc,pg_catalog.pg_get_functiondef(oid) into g6_source,g6_definition from pg_catalog.pg_proc where oid=g6_oid;
  if pg_catalog.md5(g6_source)=baseline_md5 then
    if (length(g6_source)-length(replace(g6_source,anchor,'')))/length(anchor)<>1 then
      raise exception 'worker_gateway_g6_anchor_changed' using errcode='42501';
    end if;
    if (length(g6_definition)-length(replace(g6_definition,g6_source,'')))/length(g6_source)<>1 then
      raise exception 'worker_gateway_g6_definition_changed' using errcode='42501';
    end if;
    rewritten_definition:=replace(g6_definition,g6_source,replace(g6_source,anchor,guarded_anchor));
    execute rewritten_definition;
  end if;
  -- Exactly 78 Worker-only overloads lose their old API-role paths. Native-only
  -- RPCs, P5 and all CI8 ACLs are outside this set and remain untouched.
  foreach signature in array expected_signatures loop
    if not(pg_catalog.to_regprocedure(signature)::oid=any(ci_oids)) then
      execute pg_catalog.format('revoke execute on function %s from public,anon,authenticated,service_role',signature);
    end if;
  end loop;
  -- Explicitly reviewed legacy aliases only. They receive no gateway grant;
  -- Native and other non-anonymous ACL entries are preserved byte for byte.
  foreach signature in array legacy_signatures loop
    execute pg_catalog.format('revoke execute on function %s from public,anon',signature);
  end loop;

  if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and pg_catalog.has_function_privilege(anon_oid,p.oid,'EXECUTE')
        and not(p.oid=any(ci_oids)))
    or exists(select 1 from unnest(ci_oids) x where not pg_catalog.has_function_privilege(anon_oid,x,'EXECUTE'))
    or exists(select 1 from unnest(expected_oids) x where not pg_catalog.has_function_privilege(gateway_oid,x,'EXECUTE'))
    or exists(select 1 from unnest(legacy_oids) x where pg_catalog.has_function_privilege(anon_oid,x,'EXECUTE')
      or pg_catalog.has_function_privilege(gateway_oid,x,'EXECUTE'))
    or exists(select 1 from unnest(withdrawn_oids) x where pg_catalog.has_function_privilege('authenticated',x,'EXECUTE')
      or pg_catalog.has_function_privilege('service_role',x,'EXECUTE'))
    or (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid=g6_oid)<>guarded_md5 then
    raise exception 'worker_gateway_closeout_postcondition_failed' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl::text,
    'source_md5',pg_catalog.md5(p.prosrc),'config',p.proconfig) order by p.oid),'[]') into native_catalog_after
    from pg_catalog.pg_proc p where not(p.oid=any(withdrawn_oids||legacy_oids));
  select coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'language',p.prolang,
    'security_definer',p.prosecdef,'source_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex'),
    'config',p.proconfig,'other_acl',(select coalesce(jsonb_agg(jsonb_build_object('grantor',a.grantor,'grantee',a.grantee,
      'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantor,a.grantee,a.privilege_type),'[]')
      from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee not in (0,anon_oid)))
    order by p.oid),'[]') into legacy_catalog_after from pg_catalog.pg_proc p where p.oid=any(legacy_oids);
  if legacy_catalog_after is distinct from legacy_catalog_before then
    raise exception 'worker_gateway_closeout_legacy_outside_scope_changed' using errcode='42501';
  end if;
  if native_catalog_after is distinct from native_catalog_before then
    raise exception 'worker_gateway_closeout_outside_scope_changed' using errcode='42501';
  end if;
end $worker_gateway_closeout$;

notify pgrst,'reload schema';
-- ALTER ROLE was stage 1. Reload role configuration as well, without changing
-- any role setting here; role cache reload is separate from schema exposure.
notify pgrst,'reload config';
