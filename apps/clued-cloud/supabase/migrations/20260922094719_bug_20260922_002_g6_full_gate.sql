-- A protected deployment attestation binds non-database paths (Worker, OAuth,
-- Binding and legacy aliases) to the same checkpoint table trigger. It is
-- installed by the authorized deploy verifier, never by a caller parameter.
create table clued_private.currentness_transport_attestations (
  environment text primary key check(environment='production'),
  source_commit text not null check(source_commit~'^[0-9a-f]{40}$'),
  test_digest text not null check(test_digest~'^[0-9a-f]{64}$'),
  all_paths_enforced boolean not null,
  evidence jsonb not null check(jsonb_typeof(evidence)='object'
    and jsonb_typeof(evidence->'test_files')='array'),
  verified_at timestamptz not null,
  verified_by text not null
);
alter table clued_private.currentness_transport_attestations enable row level security;
revoke all on clued_private.currentness_transport_attestations
  from public,anon,authenticated,service_role;

create or replace function public.clued_mcp_currentness_g6_gate(
  p_token_hash text,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_project_id uuid; v_project_scope text;
  v_project_receipt public.clued_audit_receipts%rowtype;
  v_global_receipt public.clued_audit_receipts%rowtype;
  v_project_session public.clued_continuity_sessions%rowtype;
  v_global_session public.clued_continuity_sessions%rowtype;
  v_project_vector jsonb; v_global_vector jsonb;
  v_project_digest text; v_global_digest text;
  v_project_view jsonb; v_global_view jsonb;
  v_project_list jsonb; v_global_list jsonb;
  v_project_view_digest text; v_global_view_digest text;
  v_source_snapshot jsonb; v_source_digest text;
  v_project_eval jsonb; v_global_eval jsonb;
  v_global_action jsonb; v_project_action jsonb;
  v_project public.clued_projects%rowtype;
  v_terminal_receipt public.clued_audit_receipts%rowtype;
  v_state_receipt public.clued_audit_receipts%rowtype;
  v_state public.clued_memories%rowtype;
  v_missing jsonb:='[]'::jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  v_project_id:=nullif(p_input->>'project_id','')::uuid;
  if v_project_id is null then raise exception 'project_id_required' using errcode='22023'; end if;
  v_project_scope:='project:'||v_project_id::text;
  perform clued_private.resolve_binding(p_token_hash,'context:read',v_project_scope);
  perform clued_private.currentness_user_lock(v_binding.user_id);

  select * into v_project from public.clued_projects p
    where p.id=v_project_id and p.user_id=v_binding.user_id;
  if not found then
    raise exception 'project_not_found' using errcode='P0002';
  end if;
  if nullif(p_input->>'terminal_receipt_id','') is not null then
    select * into v_terminal_receipt from public.clued_audit_receipts r
      where r.id=(p_input->>'terminal_receipt_id')::uuid
        and r.user_id=v_binding.user_id and r.operation_family='project_mutation'
        and r.status='committed';
  end if;
  if nullif(p_input->>'project_state_receipt_id','') is not null then
    select * into v_state_receipt from public.clued_audit_receipts r
      where r.id=(p_input->>'project_state_receipt_id')::uuid
        and r.user_id=v_binding.user_id and r.operation_family='record_mutation'
        and r.status='committed';
    select * into v_state from public.clued_memories m
      where m.receipt_id=v_state_receipt.id and m.user_id=v_binding.user_id
        and m.canonical_scope=v_project_scope and m.record_type in ('state','task')
        and m.lifecycle_status='active' order by m.updated_at desc limit 1;
  end if;
  if v_project.progress_status not in ('completed','archived') or
     v_project.closed_at is null or v_project.receipt_id is distinct from
       v_terminal_receipt.id or v_state.id is null or
     v_state_receipt.committed_versions->>v_state.id::text is distinct from
       v_state.version::text or
     not exists(select 1 from clued_private.scope_currentness_heads h
       where h.user_id=v_binding.user_id and h.canonical_scope=v_project_scope
         and h.snapshot_revision>=2 and h.updated_at>=v_terminal_receipt.created_at
         and h.updated_at>=v_state_receipt.created_at) or
     not exists(select 1 from clued_private.projection_invalidation_heads h
       where h.user_id=v_binding.user_id and h.target_scope='global'
         and h.projection_key='global.__aggregate__'
         and h.invalidation_revision>0 and h.updated_at>=v_terminal_receipt.created_at
         and h.updated_at>=v_state_receipt.created_at) then
    v_missing:=v_missing||'"project_terminal_source_receipts"'::jsonb;
  end if;
  if exists(select 1 from clued_private.projection_invalidation_heads h
    where h.user_id=v_binding.user_id
      and h.invalidation_revision>h.resolved_through_revision) then
    v_missing:=v_missing||'"projection_currentness"'::jsonb;
  end if;
  if exists(select 1 from clued_private.event_truth_carriers c
    where c.user_id=v_binding.user_id and c.visibility='work_log'
      and c.carrier_state='LEGACY_UNBOUND') or
     not clued_private.legacy_inventory_complete(v_binding.user_id) then
    v_missing:=v_missing||'"legacy_inventory_or_unbound"'::jsonb;
  end if;
  if exists(select 1 from clued_private.event_truth_carriers c
    where c.user_id=v_binding.user_id and c.visibility='work_log'
      and c.canonical_scope in ('global',v_project_scope)
      and c.carrier_state='ACTIVE_UNSTRUCTURED'
      and c.dimensions && array['state','task','decision']::text[]) then
    v_missing:=v_missing||'"unstructured_material_current_source"'::jsonb;
  end if;

  v_source_snapshot:=clued_private.projection_source_snapshot(v_binding.user_id);
  v_source_digest:=clued_private.currentness_hash(v_source_snapshot);
  if exists(select 1 from clued_private.projection_invalidation_heads h
    left join clued_private.projection_heads p on p.user_id=h.user_id
      and p.target_scope=h.target_scope and p.projection_key=h.projection_key
    where h.user_id=v_binding.user_id and h.projection_key<>'global.__aggregate__'
      and h.invalidation_revision>0 and
        (p.projection_generation is null or
         p.resolved_through_invalidation_revision is distinct from h.invalidation_revision or
         p.source_vector_digest is distinct from v_source_digest)) then
    v_missing:=v_missing||'"projection_source_binding"'::jsonb;
  end if;

  if nullif(p_input->>'project_receipt_id','') is null or
     nullif(p_input->>'global_receipt_id','') is null then
    v_missing:=v_missing||'"fresh_project_global_receipts"'::jsonb;
  else
    select * into v_project_receipt from public.clued_audit_receipts r
      where r.id=(p_input->>'project_receipt_id')::uuid
        and r.user_id=v_binding.user_id and r.binding_id=v_binding.id
        and r.context_key=v_project_scope
        and r.operation='currentness_reconcile';
    select * into v_global_receipt from public.clued_audit_receipts r
      where r.id=(p_input->>'global_receipt_id')::uuid
        and r.user_id=v_binding.user_id and r.binding_id=v_binding.id
        and r.context_key='global'
        and r.operation='currentness_reconcile';
    if v_project_receipt.id is null or v_global_receipt.id is null or
       v_project_receipt.metadata->>'receipt_kind'<>'CURRENTNESS_ADMISSION' or
       v_global_receipt.metadata->>'receipt_kind'<>'CURRENTNESS_ADMISSION' or
       v_project_receipt.metadata->>'admission_eligible'<>'true' or
       v_global_receipt.metadata->>'admission_eligible'<>'true' then
      v_missing:=v_missing||'"fresh_project_global_receipts"'::jsonb;
    end if;
  end if;

  if v_project_receipt.id is not null and v_global_receipt.id is not null then
    v_project_vector:=clued_private.currentness_vector(
      v_binding.user_id,v_project_scope,v_binding.id);
    v_global_vector:=clued_private.currentness_vector(
      v_binding.user_id,'global',v_binding.id);
    v_project_digest:=clued_private.currentness_hash(v_project_vector);
    v_global_digest:=clued_private.currentness_hash(v_global_vector);
    select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'version',m.version,
      'record_type',m.record_type,'lifecycle_status',m.lifecycle_status,
      'content_hash',m.content_hash) order by m.id),'[]'::jsonb)
      into v_project_view from public.clued_memories m
      where m.user_id=v_binding.user_id and m.canonical_scope=v_project_scope
        and m.record_type in ('state','task','decision')
        and clued_private.record_currentness_fence(v_binding.user_id,m.id,
          array[v_project_scope]::text[])='CURRENT';
    select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'version',m.version,
      'record_type',m.record_type,'lifecycle_status',m.lifecycle_status,
      'content_hash',m.content_hash) order by m.id),'[]'::jsonb)
      into v_global_view from public.clued_memories m
      where m.user_id=v_binding.user_id and m.canonical_scope='global'
        and m.record_type in ('state','task','decision')
        and clued_private.record_currentness_fence(v_binding.user_id,m.id,
          array['global']::text[])='CURRENT';
    v_project_view_digest:=clued_private.currentness_hash(v_project_view);
    v_global_view_digest:=clued_private.currentness_hash(v_global_view);
    if not clued_private.currentness_vector_eligible(v_project_vector) or
       not clued_private.currentness_vector_eligible(v_global_vector) or
       v_project_receipt.metadata->>'currentness_vector_digest' is distinct from
         v_project_digest or
       v_global_receipt.metadata->>'currentness_vector_digest' is distinct from
         v_global_digest or
       v_project_receipt.metadata->>'current_view_digest' is distinct from
         v_project_view_digest or
       v_global_receipt.metadata->>'current_view_digest' is distinct from
         v_global_view_digest or
       v_project_receipt.metadata->>'evaluation_digest' is distinct from
         clued_private.currentness_hash(jsonb_build_object(
           'vector_digest',v_project_digest,'current_view_digest',v_project_view_digest,
           'admission_eligible',true)) or
       v_global_receipt.metadata->>'evaluation_digest' is distinct from
         clued_private.currentness_hash(jsonb_build_object(
           'vector_digest',v_global_digest,'current_view_digest',v_global_view_digest,
           'admission_eligible',true)) or
       v_project_vector->>'global_authority_revision' is distinct from
         v_global_vector->'scope'->>'authority_revision' then
      v_missing:=v_missing||'"cross_scope_receipt_vector_parity"'::jsonb;
    end if;
    if nullif(p_input->>'project_session_token','') is null or
       nullif(p_input->>'global_session_token','') is null then
      v_missing:=v_missing||'"fresh_resume_parity"'::jsonb;
    else
      v_project_session:=clued_private.resolve_session(v_binding.user_id,
        v_binding.id,v_project_scope,p_input->>'project_session_token');
      v_global_session:=clued_private.resolve_session(v_binding.user_id,
        v_binding.id,'global',p_input->>'global_session_token');
      v_project_eval:=clued_private.checkpoint_currentness_for_session(v_project_session.id);
      v_global_eval:=clued_private.checkpoint_currentness_for_session(v_global_session.id);
      if v_project_receipt.metadata->>'session_id' is distinct from
           v_project_session.id::text or
         v_global_receipt.metadata->>'session_id' is distinct from
           v_global_session.id::text or
         v_project_session.restored_currentness_digest is distinct from
           v_project_digest or
         v_global_session.restored_currentness_digest is distinct from
           v_global_digest or
         v_project_session.reconciliation_required or
         v_global_session.reconciliation_required or
         v_project_eval->>'overall'<>'CURRENT' or
         v_global_eval->>'overall'<>'CURRENT' or
         v_project_eval->>'currentness_vector_digest' is distinct from
           v_project_digest or
         v_global_eval->>'currentness_vector_digest' is distinct from
           v_global_digest then
        v_missing:=v_missing||'"fresh_resume_parity"'::jsonb;
      end if;
    end if;
  end if;

  v_project_action:=clued_private.authoritative_current_action_v1(
    v_binding.user_id,v_project_scope);
  v_global_action:=clued_private.authoritative_current_action_v1(
    v_binding.user_id,'global');
  if v_project_action->>'status' in ('BLOCKED','AMBIGUOUS','PROJECTION_REQUIRED') or
     v_global_action->>'status' in ('BLOCKED','AMBIGUOUS','PROJECTION_REQUIRED') then
    v_missing:=v_missing||'"authoritative_current_action"'::jsonb;
  end if;

  -- DB-level write enforcement cannot be bypassed by a retired RPC alias.
  if not exists(select 1 from pg_catalog.pg_trigger t
    where t.tgrelid='public.clued_context_checkpoints'::regclass
      and t.tgname='enforce_checkpoint_currentness' and t.tgenabled='O') or
     pg_catalog.has_function_privilege('anon',
       'public.clued_mcp_commit_checkpoint_pre_currentness(text,jsonb)','EXECUTE') or
     pg_catalog.has_function_privilege('authenticated',
       'public.clued_mcp_commit_checkpoint_pre_currentness(text,jsonb)','EXECUTE') or
     not exists(select 1 from clued_private.currentness_transport_attestations a
       where a.environment='production' and a.all_paths_enforced
         and a.verified_at>=now()-interval '24 hours'
         and a.evidence->>'source_commit'=a.source_commit
         and a.evidence->>'deployed_commit'=a.source_commit
         and a.evidence->>'test_digest'=a.test_digest
         and a.evidence->>'verification_status'='passed'
         and a.evidence->>'verification_context'='production_post_deploy'
         and a.evidence->>'source_worktree_dirty'='false'
         and a.evidence->>'live_health_url'='https://clued.pixelgrav.com/healthz'
         and coalesce(jsonb_array_length(a.evidence->'test_files'),0)>=8) then
    v_missing:=v_missing||'"all_path_checkpoint_enforcement"'::jsonb;
  end if;

  if exists(select 1 from clued_private.projection_record_bindings b
    where b.user_id=v_binding.user_id and
      clued_private.record_currentness_fence(v_binding.user_id,b.record_id,
        array[b.target_scope]::text[])<>'CURRENT') then
    v_missing:=v_missing||'"default_current_read_surface"'::jsonb;
  end if;
  v_project_list:=clued_private.record_list_core(v_binding.user_id,
    jsonb_build_object('level','project','project_id',v_project_id,
      'record_type',v_state.record_type,'include_history',false),
    array[v_project_scope]::text[]);
  v_global_list:=clued_private.record_list_core(v_binding.user_id,
    '{"level":"global","record_type":"state","include_history":false}'::jsonb,
    array['global']::text[]);
  if v_project_list->>'status'<>'ok' or
     not exists(select 1 from jsonb_array_elements(v_project_list->'records') r
       where r->>'id'=v_state.id::text and r->>'projection_currentness'='CURRENT') or
     v_global_list->>'status'<>'ok' or
     coalesce((v_global_list->>'current_projection_unavailable')::boolean,false) or
     coalesce((v_global_list->>'projection_rebuild_required')::boolean,false) then
    v_missing:=v_missing||'"default_current_read_surface"'::jsonb;
  end if;
  if v_missing<>'[]'::jsonb then
    return jsonb_build_object('status','not_ready','gate','G6_CURRENTNESS',
      'missing_requirements',v_missing);
  end if;
  return jsonb_build_object('status','closed','gate','G6_CURRENTNESS',
    'project_id',v_project_id,'project_receipt_id',v_project_receipt.id,
    'global_receipt_id',v_global_receipt.id,
    'source_vector_digest',v_source_digest,'missing_requirements','[]'::jsonb);
end $$;
revoke all on function public.clued_mcp_currentness_g6_gate(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_currentness_g6_gate(text,jsonb) to anon;
notify pgrst,'reload schema';
