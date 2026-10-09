-- C1 phase 1, P0-4 Task 9a4d6d2c; Owner Decision 818a9b05 (2026-10-09).
-- Add the Worker's transport identity without withdrawing any existing caller grant.
-- Binding/issuer checks inside each RPC are unchanged. Phase 2 (anon withdrawal,
-- G6's request-role assertion) requires a separate PR after 24 hours of observation.
-- Native human and P5 functions are deliberately not granted to this role.

do $gateway$
declare diagnostic jsonb;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway') then
    create role clued_worker_gateway nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  elsif exists (select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway'
    and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
    or exists (select 1 from pg_catalog.pg_auth_members m
      where m.member='clued_worker_gateway'::regrole) then
    with violations as (
        select jsonb_build_object('kind','role_attributes','role',r.rolname,
          'login',r.rolcanlogin,'inherit',r.rolinherit,'superuser',r.rolsuper,
          'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,
          'replication',r.rolreplication,'bypassrls',r.rolbypassrls) v
        from pg_catalog.pg_roles r where r.rolname='clued_worker_gateway'
          and (r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls)
        union all
        select jsonb_build_object('kind','inherited_role','role',m.roleid::regrole::text,
          'member',m.member::regrole::text,'grantor',m.grantor::regrole::text,
          'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
        from pg_catalog.pg_auth_members m where m.member='clued_worker_gateway'::regrole
      ), bounded as (select v,count(*) over() total from violations order by v::text limit 100)
    select jsonb_build_object('schema','clued.worker-gateway-diagnostic.v1','violations',jsonb_agg(v order by v::text),
      'violation_count',max(total),'truncated',max(total)>100) into diagnostic from bounded;
    raise exception 'worker_gateway_role_unexpected_privileges' using errcode='42501', detail=diagnostic::text;
  end if;
end $gateway$;

alter role clued_worker_gateway set statement_timeout='3s';
grant clued_worker_gateway to authenticator;
grant usage on schema public to clued_worker_gateway;

-- Exact overloads, derived from the serving Worker's Binding/issuer call sites.
-- No blanket grant or default privilege: future RPCs need their own reviewed grant.
do $grants$
declare signature text; expected_oids oid[]; diagnostic jsonb;
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
begin
  foreach signature in array expected_signatures loop
    if pg_catalog.to_regprocedure(signature) is null then
      raise exception 'worker_gateway_rpc_missing: %', signature;
    end if;
    execute pg_catalog.format('grant execute on function %s to clued_worker_gateway', signature);
  end loop;
  select array_agg(pg_catalog.to_regprocedure(s)::oid) into expected_oids
    from unnest(expected_signatures) s;

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
end $grants$;

notify pgrst,'reload schema';
