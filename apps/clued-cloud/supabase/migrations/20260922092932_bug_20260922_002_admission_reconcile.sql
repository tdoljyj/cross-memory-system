-- BUG-20260922-002: session-bound currentness and all-path checkpoint admission.
-- The checkpoint trigger is deliberately below every MCP/HTTP/legacy RPC alias.

alter table public.clued_continuity_sessions
  add column if not exists restored_currentness_vector jsonb,
  add column if not exists restored_currentness_digest text,
  add column if not exists reconciliation_required boolean not null default false,
  add column if not exists reconciliation_reason_digest text;

alter table public.clued_context_checkpoints
  add column if not exists committed_currentness_vector jsonb,
  add column if not exists currentness_admission_status text;

create or replace function clued_private.currentness_hash(p_value jsonb)
returns text language sql immutable set search_path='' as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;

-- A single user-scoped lock is used by source mutations, resume/reconcile and
-- checkpoint admission. It serializes absent-row first writes as well as updates.
create or replace function clued_private.currentness_user_lock(p_user_id uuid)
returns void language plpgsql volatile set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued-currentness-user:'||p_user_id::text,0));
end $$;

create or replace function clued_private.currentness_source_lock()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.currentness_user_lock(coalesce(new.user_id,old.user_id));
  return coalesce(new,old);
end $$;

create trigger currentness_scope_source_lock before insert or update or delete
  on clued_private.scope_currentness_heads for each row
  execute function clued_private.currentness_source_lock();
create trigger currentness_projection_source_lock before insert or update or delete
  on clued_private.projection_invalidation_heads for each row
  execute function clued_private.currentness_source_lock();
create trigger currentness_carrier_source_lock before insert or update or delete
  on clued_private.event_truth_carriers for each row
  execute function clued_private.currentness_source_lock();

-- The private aggregate heads also count audit-only sources. A caller-facing
-- vector must use separate visible revisions so a hidden source is equivalent
-- to its absence across digest and revision metadata.
create table clued_private.visible_scope_currentness_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_scope text not null,
  snapshot_revision bigint not null default 0,
  next_action_revision bigint not null default 0,
  authority_revision bigint not null default 0,
  lifecycle_revision bigint not null default 0,
  primary key(user_id,canonical_scope)
);
create table clued_private.visible_projection_invalidation_heads (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_scope text not null,
  projection_key text not null,
  invalidation_revision bigint not null default 0,
  resolved_through_revision bigint not null default 0,
  primary key(user_id,target_scope,projection_key)
);
alter table clued_private.visible_scope_currentness_heads enable row level security;
alter table clued_private.visible_projection_invalidation_heads enable row level security;
revoke all on clued_private.visible_scope_currentness_heads,
  clued_private.visible_projection_invalidation_heads from public,anon,authenticated,service_role;

create or replace function clued_private.currentness_source_is_visible(p_ref jsonb)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_carrier clued_private.event_truth_carriers%rowtype;
begin
  if p_ref->>'kind' not in ('direct_event','event_carrier_transition') then return true; end if;
  if coalesce(p_ref->>'id','') !~ '^[1-9][0-9]*$' then return false; end if;
  select * into v_carrier from clued_private.event_truth_carriers
   where event_id=(p_ref->>'id')::bigint;
  return found and v_carrier.visibility='work_log';
end $$;

create or replace function clued_private.currentness_visible_scope_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_snapshot bigint; v_action bigint; v_authority bigint; v_lifecycle bigint;
begin
  if not clued_private.currentness_source_is_visible(new.latest_source_ref) then return new; end if;
  if tg_op='INSERT' then
    v_snapshot:=new.snapshot_revision; v_action:=new.next_action_revision;
    v_authority:=new.authority_revision; v_lifecycle:=new.lifecycle_revision;
  else
    v_snapshot:=new.snapshot_revision-old.snapshot_revision;
    v_action:=new.next_action_revision-old.next_action_revision;
    v_authority:=new.authority_revision-old.authority_revision;
    v_lifecycle:=new.lifecycle_revision-old.lifecycle_revision;
  end if;
  insert into clued_private.visible_scope_currentness_heads(user_id,canonical_scope,
    snapshot_revision,next_action_revision,authority_revision,lifecycle_revision)
  values(new.user_id,new.canonical_scope,v_snapshot,v_action,v_authority,v_lifecycle)
  on conflict(user_id,canonical_scope) do update set
    snapshot_revision=clued_private.visible_scope_currentness_heads.snapshot_revision+v_snapshot,
    next_action_revision=clued_private.visible_scope_currentness_heads.next_action_revision+v_action,
    authority_revision=clued_private.visible_scope_currentness_heads.authority_revision+v_authority,
    lifecycle_revision=clued_private.visible_scope_currentness_heads.lifecycle_revision+v_lifecycle;
  return new;
end $$;
create trigger currentness_visible_scope_change after insert or update
  on clued_private.scope_currentness_heads for each row
  execute function clued_private.currentness_visible_scope_change();

-- Core was installed first; its current heads are visible-source-only at this
-- migration boundary, including any in-transaction backfill performed there.
insert into clued_private.visible_scope_currentness_heads(user_id,canonical_scope,
  snapshot_revision,next_action_revision,authority_revision,lifecycle_revision)
select user_id,canonical_scope,snapshot_revision,next_action_revision,
  authority_revision,lifecycle_revision from clued_private.scope_currentness_heads;

create or replace function clued_private.currentness_visible_projection_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_delta bigint;
begin
  if not clued_private.currentness_source_is_visible(new.latest_source_ref) then return new; end if;
  v_delta:=case when tg_op='INSERT' then new.invalidation_revision
    else new.invalidation_revision-old.invalidation_revision end;
  insert into clued_private.visible_projection_invalidation_heads(user_id,target_scope,
    projection_key,invalidation_revision,resolved_through_revision)
  values(new.user_id,new.target_scope,new.projection_key,v_delta,
    least(new.resolved_through_revision,v_delta))
  on conflict(user_id,target_scope,projection_key) do update set
    invalidation_revision=clued_private.visible_projection_invalidation_heads.invalidation_revision+v_delta,
    resolved_through_revision=least(
      clued_private.visible_projection_invalidation_heads.invalidation_revision+v_delta,
      new.resolved_through_revision);
  return new;
end $$;
create trigger currentness_visible_projection_change after insert or update
  on clued_private.projection_invalidation_heads for each row
  execute function clued_private.currentness_visible_projection_change();

insert into clued_private.visible_projection_invalidation_heads(user_id,target_scope,
  projection_key,invalidation_revision,resolved_through_revision)
select user_id,target_scope,projection_key,invalidation_revision,resolved_through_revision
  from clued_private.projection_invalidation_heads;

-- Only server-owned scalar source revisions participate. Client payload,
-- checkpoint text and coverage are never accepted as revision authorities.
create or replace function clued_private.currentness_vector(
  p_user_id uuid,p_context_key text,p_binding_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_local jsonb; v_global bigint:=0; v_global_control jsonb:='{}'::jsonb;
  v_projections jsonb; v_dependency_sources jsonb:='[]'::jsonb;
  v_legacy boolean:=false; v_authority_unknown boolean:=false;
  v_dependency_unknown boolean:=false; v_dep record;
  v_target public.clued_memories%rowtype; v_dep_scope text;
  v_dep_head clued_private.visible_scope_currentness_heads%rowtype;
  v_can_read_dependency boolean;
  v_can_read_global boolean:=false; v_binding public.clued_agent_bindings%rowtype;
begin
  select * into v_binding from public.clued_agent_bindings
   where id=p_binding_id and user_id=p_user_id;
  if not found or p_context_key is null then
    raise exception 'currentness_subject_required' using errcode='42501';
  end if;
  select jsonb_build_object('snapshot_revision',h.snapshot_revision,
    'next_action_revision',h.next_action_revision,'authority_revision',h.authority_revision,
    'lifecycle_revision',h.lifecycle_revision) into v_local
    from clued_private.visible_scope_currentness_heads h
   where h.user_id=p_user_id and h.canonical_scope=p_context_key;
  v_local:=coalesce(v_local,jsonb_build_object('snapshot_revision',0,
    'next_action_revision',0,'authority_revision',0,'lifecycle_revision',0));
  v_can_read_global:=('*'=any(v_binding.context_keys) or 'global'=any(v_binding.context_keys))
    and (not exists(select 1 from clued_private.authorizations_v12 a
      where a.binding_id=p_binding_id)
      or 'read'=any(clued_private.authorization_effective_actions_v13(
        p_binding_id,'scope','global','canonical')));
  if p_context_key<>'global' and v_can_read_global then
    select h.authority_revision,
      jsonb_build_object('snapshot_revision',h.snapshot_revision,
        'next_action_revision',h.next_action_revision,
        'lifecycle_revision',h.lifecycle_revision)
      into v_global,v_global_control
      from clued_private.visible_scope_currentness_heads h
     where h.user_id=p_user_id and h.canonical_scope='global';
  elsif p_context_key<>'global' then
    v_authority_unknown:=true;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('key',h.projection_key,
    'invalidation_revision',h.invalidation_revision,
    'resolved_through_revision',h.resolved_through_revision)
    order by h.projection_key),'[]'::jsonb) into v_projections
    from clued_private.visible_projection_invalidation_heads h
   where h.user_id=p_user_id and h.target_scope=p_context_key;
  select exists(select 1 from clued_private.event_truth_carriers c
    where c.user_id=p_user_id and c.canonical_scope=p_context_key
      and c.carrier_state='LEGACY_UNBOUND' and c.visibility='work_log') into v_legacy;
  if p_context_key like 'project:%' then
    if exists(select 1 from public.clued_memories m
      where m.user_id=p_user_id and m.canonical_scope=p_context_key
        and m.record_type='task' and m.lifecycle_status='active'
        and m.relations ? 'depends_on'
        and jsonb_typeof(m.relations->'depends_on')<>'array') then
      v_dependency_unknown:=true;
    end if;
    for v_dep in
      select m.id as source_task_id,d.target_id
        from public.clued_memories m
        cross join lateral jsonb_array_elements_text(case when
          jsonb_typeof(m.relations->'depends_on')='array'
          then m.relations->'depends_on' else '[]'::jsonb end) d(target_id)
       where m.user_id=p_user_id and m.canonical_scope=p_context_key
         and m.record_type='task' and m.lifecycle_status='active'
       order by m.id,d.target_id
    loop
      select * into v_target from public.clued_memories m
        where m.user_id=p_user_id and m.id::text=lower(v_dep.target_id)
          and m.record_type='task';
      if not found then v_dependency_unknown:=true; continue; end if;
      v_dep_scope:=v_target.canonical_scope;
      if v_dep_scope=p_context_key then continue; end if;
      v_can_read_dependency:=('*'=any(v_binding.context_keys) or
        v_dep_scope=any(v_binding.context_keys))
        and (not exists(select 1 from clued_private.authorizations_v12 a
          where a.binding_id=p_binding_id)
          or 'read'=any(clued_private.authorization_effective_actions_v13(
            p_binding_id,'scope',v_dep_scope,'canonical')));
      if not v_can_read_dependency then
        v_dependency_unknown:=true; continue;
      end if;
      select * into v_dep_head from clued_private.visible_scope_currentness_heads h
        where h.user_id=p_user_id and h.canonical_scope=v_dep_scope;
      if not found then v_dependency_unknown:=true; continue; end if;
      v_dependency_sources:=v_dependency_sources||jsonb_build_array(jsonb_build_object(
        'relation_id',v_dep.source_task_id::text||':'||v_target.id::text,
        'scope',v_dep_scope,'task_id',v_target.id,'task_version',v_target.version,
        'snapshot_revision',v_dep_head.snapshot_revision,
        'next_action_revision',v_dep_head.next_action_revision,
        'lifecycle_revision',v_dep_head.lifecycle_revision));
    end loop;
  end if;
  return jsonb_build_object('schema','clued.currentness-vector.v1',
    'hash_schema_version',1,'context_key',p_context_key,'scope',v_local,
    'global_authority_revision',case when v_can_read_global then coalesce(v_global,0) else null end,
    'global_control_revision',case when v_can_read_global then v_global_control else null end,
    'authority_unknown',v_authority_unknown,
    'dependency_sources',v_dependency_sources,
    'dependency_unknown',v_dependency_unknown,
    'projection',v_projections,'legacy_unbound',v_legacy);
end $$;

create or replace function clued_private.currentness_vector_eligible(p_vector jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce((p_vector->>'legacy_unbound')::boolean,false)=false
    and coalesce((p_vector->>'authority_unknown')::boolean,false)=false
    and coalesce((p_vector->>'dependency_unknown')::boolean,false)=false
    and not exists(select 1 from jsonb_array_elements(coalesce(p_vector->'projection','[]'::jsonb)) p
      where (p->>'invalidation_revision')::bigint >
            (p->>'resolved_through_revision')::bigint)
$$;

create or replace function clued_private.bind_currentness_session()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_vector jsonb;
begin
  perform clued_private.currentness_user_lock(new.user_id);
  v_vector:=clued_private.currentness_vector(new.user_id,new.context_key,new.binding_id);
  new.restored_currentness_vector:=v_vector;
  new.restored_currentness_digest:=clued_private.currentness_hash(v_vector);
  new.reconciliation_required:=not clued_private.currentness_vector_eligible(v_vector);
  if new.reconciliation_required then
    new.reconciliation_reason_digest:=new.restored_currentness_digest;
  end if;
  return new;
end $$;
create trigger bind_currentness_session before insert on public.clued_continuity_sessions
  for each row execute function clued_private.bind_currentness_session();

-- Reconcile reads the authorized current vector under the same lock and
-- creates a typed immutable receipt. An observation never unlocks admission.
create or replace function public.clued_mcp_session_reconcile(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'),''),'global');
  v_vector jsonb; v_digest text; v_eligible boolean; v_receipt_id uuid;
  v_view jsonb; v_view_digest text; v_evaluation_digest text; v_projection_keys jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,
    p_input->>'session_token');
  perform clued_private.currentness_user_lock(v_binding.user_id);
  select * into v_session from public.clued_continuity_sessions
    where id=v_session.id for update;
  v_vector:=clued_private.currentness_vector(v_binding.user_id,v_context_key,v_binding.id);
  v_digest:=clued_private.currentness_hash(v_vector);
  v_eligible:=clued_private.currentness_vector_eligible(v_vector);
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'version',m.version,
    'record_type',m.record_type,'lifecycle_status',m.lifecycle_status,
    'content_hash',m.content_hash) order by m.id),'[]'::jsonb) into v_view
    from public.clued_memories m
    where m.user_id=v_binding.user_id and m.canonical_scope=v_context_key
      and m.record_type in ('state','task','decision')
      and clued_private.record_currentness_fence(v_binding.user_id,m.id,
        array[v_context_key]::text[])='CURRENT';
  v_view_digest:=clued_private.currentness_hash(v_view);
  v_evaluation_digest:=clued_private.currentness_hash(jsonb_build_object(
    'vector_digest',v_digest,'current_view_digest',v_view_digest,
    'admission_eligible',v_eligible));
  select coalesce(jsonb_agg(p->>'key' order by p->>'key'),'[]'::jsonb)
    into v_projection_keys from jsonb_array_elements(v_vector->'projection') p;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_context_key,'currentness_reconcile',
    'currentness',v_session.id::text,v_session.restored_version,
    jsonb_build_object('receipt_kind',case when v_eligible then 'CURRENTNESS_ADMISSION'
      else 'CURRENTNESS_OBSERVATION' end,'admission_eligible',v_eligible,
      'session_id',v_session.id,'binding_id',v_binding.id,'context_key',v_context_key,
      'currentness_vector',v_vector,'currentness_vector_digest',v_digest,
      'current_view_digest',v_view_digest,'evaluation_digest',v_evaluation_digest,
      'required_reads_satisfied',v_eligible,'projection_keys',v_projection_keys,
      'admission_dimensions',jsonb_build_array('snapshot','next_action','authority','projection'),
      'issued_at',now())) returning id into v_receipt_id;
  if v_eligible then
    update public.clued_continuity_sessions set
      restored_currentness_vector=v_vector,restored_currentness_digest=v_digest,
      reconciliation_required=false,reconciliation_reason_digest=null
      where id=v_session.id;
  else
    update public.clued_continuity_sessions set
      reconciliation_required=true,reconciliation_reason_digest=v_digest
      where id=v_session.id;
  end if;
  return jsonb_build_object('status',case when v_eligible then 'current' else 'reconciliation_required' end,
    'receipt_kind',case when v_eligible then 'CURRENTNESS_ADMISSION' else 'CURRENTNESS_OBSERVATION' end,
    'admission_eligible',v_eligible,'currentness_receipt_id',v_receipt_id,
    'currentness_vector_digest',v_digest,'evaluation_digest',v_evaluation_digest);
end $$;

-- Every checkpoint entry point inserts into this table. The trigger runs
-- after the predecessor's continuity CAS and before absorption/receipt writes.
create or replace function clued_private.enforce_checkpoint_currentness()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_session public.clued_continuity_sessions%rowtype;
  v_vector jsonb; v_digest text; v_receipt public.clued_audit_receipts%rowtype;
begin
  perform clued_private.currentness_user_lock(new.user_id);
  if new.session_id is null then
    raise exception 'currentness_session_required' using errcode='40001';
  end if;
  select * into v_session from public.clued_continuity_sessions
   where id=new.session_id and user_id=new.user_id and binding_id=new.binding_id
     and context_key=new.context_key and ended_at is null and expires_at>now()
   for update;
  if not found or v_session.restored_currentness_vector is null then
    raise exception 'currentness_session_required' using errcode='40001';
  end if;
  v_vector:=clued_private.currentness_vector(new.user_id,new.context_key,new.binding_id);
  v_digest:=clued_private.currentness_hash(v_vector);
  if v_session.restored_currentness_digest is distinct from v_digest then
    raise exception 'current_truth_changed_since_resume' using errcode='40001';
  end if;
  -- A fresh session can checkpoint without a receipt. After a reconcile the
  -- session vector itself was advanced only by a server-side admission receipt.
  new.committed_currentness_vector:=v_vector;
  new.currentness_admission_status:=case
    when v_session.reconciliation_required or
      not clued_private.currentness_vector_eligible(v_vector)
    then 'CONTINUITY_COMMITTED_NOT_CURRENT' else 'CURRENT' end;
  return new;
end $$;
create trigger enforce_checkpoint_currentness before insert on public.clued_context_checkpoints
  for each row execute function clued_private.enforce_checkpoint_currentness();

-- The public wrapper persists a sticky stale marker on the ordinary conflict
-- path. The table trigger remains the final guard for any retired alias and
-- for a source mutation racing after this preflight.
alter function public.clued_mcp_commit_checkpoint(text,jsonb)
  rename to clued_mcp_commit_checkpoint_pre_currentness;
revoke all on function public.clued_mcp_commit_checkpoint_pre_currentness(text,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.clued_mcp_commit_checkpoint(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_session public.clued_continuity_sessions%rowtype;
  v_context_key text:=coalesce(nullif(pg_catalog.btrim(p_input->>'context_key'),''),'global');
  v_vector jsonb; v_digest text; v_idempotency_key text; v_result jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_context_key);
  v_session:=clued_private.resolve_session(v_binding.user_id,v_binding.id,v_context_key,
    p_input->>'session_token');
  -- Preserve predecessor validation precedence for malformed requests.
  if not (p_input?'base_version') or
     pg_catalog.jsonb_typeof(p_input->'snapshot') is distinct from 'object' or
     pg_catalog.jsonb_typeof(p_input->'coverage') is distinct from 'object' or
     p_input->'coverage'->>'mode' is distinct from 'explicit' or
     pg_catalog.jsonb_typeof(p_input->'coverage'->'contexts') is distinct from 'array' or
     pg_catalog.jsonb_typeof(p_input->'coverage'->'tracks') is distinct from 'array' or
     pg_catalog.jsonb_typeof(p_input->'coverage'->'event_ids') is distinct from 'array' then
    return public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  end if;
  if p_input->'coverage'->'contexts'<>jsonb_build_array(v_context_key)
    or jsonb_array_length(p_input->'coverage'->'tracks')<1
    or exists(select 1 from jsonb_array_elements(p_input->'coverage'->'tracks') t(value)
      where jsonb_typeof(t.value)<>'string' or
        char_length(pg_catalog.btrim(t.value #>> '{}')) not between 1 and 80)
    or (select count(*) from jsonb_array_elements_text(p_input->'coverage'->'tracks'))<>
       (select count(distinct t.value) from jsonb_array_elements_text(p_input->'coverage'->'tracks') t(value))
    or exists(select 1 from jsonb_array_elements(p_input->'coverage'->'event_ids') t(value)
      where jsonb_typeof(t.value)<>'number' or t.value::text!~'^[1-9][0-9]*$')
    or char_length(pg_catalog.btrim(coalesce(p_input->>'summary',''))) not between 1 and 4000
    or char_length(pg_catalog.btrim(coalesce(p_input->>'next_action',''))) not between 1 and 1000 then
    return public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  end if;
  v_idempotency_key:=nullif(pg_catalog.btrim(p_input->>'idempotency_key'),'');
  if v_idempotency_key is not null and exists(
    select 1 from public.clued_context_checkpoints c
      where c.user_id=v_binding.user_id and c.binding_id=v_binding.id
        and c.idempotency_key=v_idempotency_key) then
    return public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  end if;
  perform 1 from public.clued_context_streams s
   where s.user_id=v_binding.user_id and s.context_key=v_context_key for update;
  perform clued_private.currentness_user_lock(v_binding.user_id);
  select * into v_session from public.clued_continuity_sessions
   where id=v_session.id for update;
  v_vector:=clued_private.currentness_vector(v_binding.user_id,v_context_key,v_binding.id);
  v_digest:=clued_private.currentness_hash(v_vector);
  if v_session.restored_currentness_digest is distinct from v_digest then
    update public.clued_continuity_sessions set reconciliation_required=true,
      reconciliation_reason_digest=v_digest where id=v_session.id;
    return jsonb_build_object('status','conflict','error','current_truth_changed_since_resume',
      'context_key',v_context_key);
  end if;
  v_result:=public.clued_mcp_commit_checkpoint_pre_currentness(p_token_hash,p_input);
  if v_result->>'status'='committed' then
    return v_result||jsonb_build_object('currentness_admission_status',
      case when v_session.reconciliation_required or
        not clued_private.currentness_vector_eligible(v_vector)
      then 'CONTINUITY_COMMITTED_NOT_CURRENT' else 'CURRENT' end);
  end if;
  return v_result;
end $$;
revoke all on function public.clued_mcp_commit_checkpoint(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_commit_checkpoint(text,jsonb) to anon;

revoke all on function clued_private.currentness_hash(jsonb),
  clued_private.currentness_user_lock(uuid),clued_private.currentness_source_lock(),
  clued_private.currentness_source_is_visible(jsonb),
  clued_private.currentness_visible_scope_change(),
  clued_private.currentness_visible_projection_change(),
  clued_private.currentness_vector(uuid,text,uuid),
  clued_private.currentness_vector_eligible(jsonb),
  clued_private.bind_currentness_session(),
  clued_private.enforce_checkpoint_currentness() from public,anon,authenticated,service_role;
revoke all on function public.clued_mcp_session_reconcile(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_mcp_session_reconcile(text,jsonb) to anon;

notify pgrst,'reload schema';
