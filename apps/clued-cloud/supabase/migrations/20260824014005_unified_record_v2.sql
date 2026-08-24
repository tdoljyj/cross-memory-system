-- Clued Unified Record v2: one canonical record table, two query levels,
-- five logical views, one transactional write core. Additive and dormant
-- until the Worker PROJECT_VIEWS_V2 flag is explicitly enabled.

alter table public.clued_memories
  add column if not exists scope text not null default 'global',
  add column if not exists project_id uuid,
  add column if not exists record_type text not null default 'note',
  add column if not exists record_key text,
  add column if not exists status text not null default 'active',
  add column if not exists priority smallint not null default 0,
  add column if not exists version bigint not null default 1,
  add column if not exists source_ref text,
  add column if not exists supersedes_id uuid,
  add column if not exists restored_from_id uuid,
  add column if not exists next_task_id uuid,
  add column if not exists archived_at timestamptz;

alter table public.clued_context_events
  add column if not exists project_id uuid,
  add column if not exists record_id uuid,
  add column if not exists record_version bigint;

alter table public.clued_audit_receipts
  add column if not exists idempotency_key text,
  add column if not exists request_sha256 text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='clued_memories_project_fkey') then
    alter table public.clued_memories add constraint clued_memories_project_fkey
      foreign key (project_id) references public.clued_projects(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='clued_memories_supersedes_fkey') then
    alter table public.clued_memories add constraint clued_memories_supersedes_fkey
      foreign key (supersedes_id) references public.clued_memories(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='clued_memories_restored_from_fkey') then
    alter table public.clued_memories add constraint clued_memories_restored_from_fkey
      foreign key (restored_from_id) references public.clued_memories(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='clued_memories_next_task_fkey') then
    alter table public.clued_memories add constraint clued_memories_next_task_fkey
      foreign key (next_task_id) references public.clued_memories(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='clued_events_project_fkey') then
    alter table public.clued_context_events add constraint clued_events_project_fkey
      foreign key (project_id) references public.clued_projects(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='clued_events_record_fkey') then
    alter table public.clued_context_events add constraint clued_events_record_fkey
      foreign key (record_id) references public.clued_memories(id) on delete set null;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='clued_memories_v2_shape_check') then
    alter table public.clued_memories add constraint clued_memories_v2_shape_check check (
      scope in ('global','project')
      and ((scope='global' and project_id is null) or (scope='project' and project_id is not null))
      and record_type in ('note','state','task','decision','archive_snapshot')
      and (record_type not in ('state','decision') or char_length(btrim(record_key)) between 1 and 160)
      and priority between 0 and 100
      and version > 0
      and (source_ref is null or char_length(source_ref) <= 500)
      and supersedes_id is distinct from id
      and restored_from_id is distinct from id
      and next_task_id is distinct from id
      and ((status='archived' and archived_at is not null) or (status<>'archived' and archived_at is null))
      and (
        (record_type='note' and status in ('active','archived'))
        or (record_type='state' and status in ('current','superseded','archived'))
        or (record_type='task' and status in ('backlog','ready','in_progress','blocked','done','cancelled','archived'))
        or (record_type='decision' and status in ('active','superseded','archived'))
        or (record_type='archive_snapshot' and status='archived')
      )
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname='clued_receipts_v2_idempotency_check') then
    alter table public.clued_audit_receipts add constraint clued_receipts_v2_idempotency_check check (
      (idempotency_key is null or char_length(idempotency_key) between 8 and 160)
      and (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$')
    ) not valid;
  end if;
end $$;

alter table public.clued_memories validate constraint clued_memories_v2_shape_check;
alter table public.clued_audit_receipts validate constraint clued_receipts_v2_idempotency_check;

create index if not exists clued_memories_project_idx on public.clued_memories(project_id);
create index if not exists clued_memories_supersedes_idx on public.clued_memories(supersedes_id);
create index if not exists clued_memories_restored_from_idx on public.clued_memories(restored_from_id);
create index if not exists clued_memories_next_task_idx on public.clued_memories(next_task_id);
create index if not exists clued_memories_user_type_status_priority
  on public.clued_memories(user_id,record_type,status,priority desc,updated_at desc,id);
create index if not exists clued_memories_user_project_type_status_priority
  on public.clued_memories(user_id,project_id,record_type,status,priority desc,updated_at desc,id);
create index if not exists clued_events_record_idx
  on public.clued_context_events(record_id,record_version) where record_id is not null;

create unique index if not exists clued_state_global_current_uidx
  on public.clued_memories(user_id,record_key)
  where scope='global' and record_type='state' and status='current' and archived_at is null;
create unique index if not exists clued_state_project_current_uidx
  on public.clued_memories(user_id,project_id,record_key)
  where scope='project' and record_type='state' and status='current' and archived_at is null;
create unique index if not exists clued_decision_global_active_uidx
  on public.clued_memories(user_id,record_key)
  where scope='global' and record_type='decision' and status='active' and archived_at is null;
create unique index if not exists clued_decision_project_active_uidx
  on public.clued_memories(user_id,project_id,record_key)
  where scope='project' and record_type='decision' and status='active' and archived_at is null;
create unique index if not exists clued_receipts_v2_idempotency_uidx
  on public.clued_audit_receipts(user_id,context_key,idempotency_key)
  where idempotency_key is not null;

create or replace view public.clued_project_resolution_v2
with (security_invoker=true) as
with recursive project_chain as (
  select p.user_id,p.id as source_project_id,p.id as current_project_id,
         p.merged_into_project_id,array[p.id] as path
    from public.clued_projects p
  union all
  select c.user_id,c.source_project_id,p.id,p.merged_into_project_id,c.path||p.id
    from project_chain c
    join public.clued_projects p on p.id=c.merged_into_project_id and p.user_id=c.user_id
   where not p.id=any(c.path)
), resolved as (
  select distinct on (user_id,source_project_id)
         user_id,source_project_id,current_project_id as effective_project_id,path
    from project_chain
   order by user_id,source_project_id,cardinality(path) desc
)
select user_id,source_project_id,effective_project_id,path from resolved;

create or replace view public.clued_records_v2
with (security_invoker=true) as
select m.id,m.user_id,m.title,m.content as body,m.scope,m.project_id,
       coalesce(r.effective_project_id,m.project_id) as effective_project_id,
       m.record_type,m.record_key,m.status,m.priority,m.version,m.source_ref,
       m.supersedes_id,m.restored_from_id,m.next_task_id,m.archived_at,
       m.created_at,m.updated_at
  from public.clued_memories m
  left join public.clued_project_resolution_v2 r
    on r.user_id=m.user_id and r.source_project_id=m.project_id;

create or replace view public.clued_global_work_v2
with (security_invoker=true) as
select * from public.clued_records_v2
 where archived_at is null and status not in ('done','cancelled','superseded','archived')
 order by priority desc,updated_at desc,id;

drop policy if exists clued_memories_select_own on public.clued_memories;
drop policy if exists clued_memories_insert_own on public.clued_memories;
drop policy if exists clued_memories_update_own on public.clued_memories;
drop policy if exists clued_memories_delete_own on public.clued_memories;
drop policy if exists clued_memories_v2_select_own on public.clued_memories;
drop policy if exists clued_memories_v2_insert_legacy_note on public.clued_memories;
drop policy if exists clued_memories_v2_update_legacy_note on public.clued_memories;
drop policy if exists clued_memories_v2_delete_legacy_note on public.clued_memories;

create policy clued_memories_v2_select_own on public.clued_memories
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy clued_memories_v2_insert_legacy_note on public.clued_memories
  for insert to authenticated
  with check ((select auth.uid()) = user_id and record_type='note' and scope='global' and project_id is null);
create policy clued_memories_v2_update_legacy_note on public.clued_memories
  for update to authenticated
  using ((select auth.uid()) = user_id and record_type='note' and scope='global' and project_id is null)
  with check ((select auth.uid()) = user_id and record_type='note' and scope='global' and project_id is null);
create policy clued_memories_v2_delete_legacy_note on public.clued_memories
  for delete to authenticated
  using ((select auth.uid()) = user_id and record_type='note' and scope='global' and project_id is null);

revoke all on table public.clued_memories from public,anon,authenticated;
grant select on table public.clued_memories to authenticated;
grant insert (user_id,title,content) on public.clued_memories to authenticated;
grant update (title,content,updated_at) on public.clued_memories to authenticated;
grant delete on table public.clued_memories to authenticated;
revoke all on table public.clued_project_resolution_v2,public.clued_records_v2,public.clued_global_work_v2
  from public,anon,authenticated;
grant select on table public.clued_project_resolution_v2,public.clued_records_v2,public.clued_global_work_v2
  to authenticated;

create or replace function clued_private.record_list_core(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_level text:=coalesce(p_input->>'level','global');
  v_type text:=coalesce(p_input->>'record_type','state');
  v_project_id uuid;
  v_effective_project_id uuid;
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
  v_rows jsonb;
begin
  if p_user_id is null then raise exception 'account_required' using errcode='28000'; end if;
  if v_level not in ('global','project') then raise exception 'invalid_record_level' using errcode='22023'; end if;
  if v_type not in ('note','state','task','decision','archive','log') then raise exception 'invalid_record_type' using errcode='22023'; end if;
  if v_level='project' then
    v_project_id:=(p_input->>'project_id')::uuid;
    select r.effective_project_id into v_effective_project_id
      from public.clued_project_resolution_v2 r
     where r.user_id=p_user_id and r.source_project_id=v_project_id;
    if v_effective_project_id is null then raise exception 'project_not_found' using errcode='P0002'; end if;
  end if;
  if v_type='log' then
    select coalesce(jsonb_agg(row_data order by event_id desc),'[]'::jsonb) into v_rows from (
      select e.id as event_id,jsonb_build_object(
        'id',e.id::text,'record_type','log','project_id',e.project_id,'record_id',e.record_id,
        'record_version',e.record_version,'event_type',e.event_type,'payload',e.payload,
        'created_at',e.occurred_at,'updated_at',e.occurred_at
      ) as row_data
      from public.clued_context_events e
      left join public.clued_project_resolution_v2 r
        on r.user_id=e.user_id and r.source_project_id=e.project_id
      where e.user_id=p_user_id
        and (v_level='global' or coalesce(r.effective_project_id,e.project_id)=v_effective_project_id)
      order by e.id desc limit v_limit
    ) events;
  else
    select coalesce(jsonb_agg(to_jsonb(record_row) order by record_row.priority desc,record_row.updated_at desc,record_row.id),'[]'::jsonb)
      into v_rows from (
        select r.* from public.clued_records_v2 r
         where r.user_id=p_user_id
           and (v_level='global' or r.effective_project_id=v_effective_project_id)
           and (case when v_type='archive' then r.status='archived' else r.record_type=v_type and r.status<>'archived' end)
         order by r.priority desc,r.updated_at desc,r.id limit v_limit
      ) record_row;
  end if;
  return jsonb_build_object('status','ok','level',v_level,'record_type',v_type,'project_id',v_effective_project_id,'records',v_rows);
end $$;

create or replace function clued_private.record_write_core(p_user_id uuid,p_binding_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_action text:=coalesce(p_input->>'action','create');
  v_idempotency_key text:=btrim(coalesce(p_input->>'idempotency_key',''));
  v_request_sha256 text:=encode(extensions.digest(convert_to(p_input::text,'UTF8'),'sha256'),'hex');
  v_scope text:=coalesce(p_input->>'scope','global');
  v_record_type text:=coalesce(p_input->>'record_type','note');
  v_status text;
  v_project_id uuid;
  v_requested_project_id uuid;
  v_record_id uuid;
  v_state_id uuid;
  v_next_task_id uuid;
  v_expected_version bigint;
  v_context_key text;
  v_receipt_id uuid;
  v_event_id bigint;
  v_existing_receipt public.clued_audit_receipts%rowtype;
  v_project public.clued_projects%rowtype;
  v_record public.clued_memories%rowtype;
  v_state public.clued_memories%rowtype;
  v_next_task public.clued_memories%rowtype;
  v_result jsonb;
begin
  if p_user_id is null then raise exception 'account_required' using errcode='28000'; end if;
  if v_action not in ('create','update','archive','restore','supersede_decision','complete_task_and_advance_state') then
    raise exception 'invalid_record_action' using errcode='22023';
  end if;
  if char_length(v_idempotency_key) not between 8 and 160 then raise exception 'invalid_idempotency_key' using errcode='22023'; end if;
  if v_scope not in ('global','project') then raise exception 'invalid_record_scope' using errcode='22023'; end if;
  if v_record_type not in ('note','state','task','decision','archive_snapshot') then raise exception 'invalid_record_type' using errcode='22023'; end if;
  if v_action<>'create' and not (p_input ? 'scope') then raise exception 'record_scope_required' using errcode='22023'; end if;

  if v_scope='project' then
    v_requested_project_id:=(p_input->>'project_id')::uuid;
    select p.* into v_project
      from public.clued_project_resolution_v2 r
      join public.clued_projects p on p.id=r.effective_project_id and p.user_id=p_user_id
     where r.user_id=p_user_id and r.source_project_id=v_requested_project_id
       and p.certainty_status='confirmed' and p.dismissed_at is null and p.merged_into_project_id is null;
    if v_project.id is null then raise exception 'project_not_confirmed' using errcode='42501'; end if;
    v_project_id:=v_project.id;
  elsif p_input ? 'project_id' and p_input->>'project_id' is not null then
    raise exception 'project_scope_mismatch' using errcode='22023';
  end if;
  v_context_key:=case when v_project_id is null then 'global' else 'project:'||v_project_id::text end;

  select * into v_existing_receipt from public.clued_audit_receipts
   where user_id=p_user_id and context_key=v_context_key and idempotency_key=v_idempotency_key;
  if found then
    if v_existing_receipt.request_sha256<>v_request_sha256 then raise exception 'idempotency_key_conflict' using errcode='23505'; end if;
    return coalesce(v_existing_receipt.metadata->'result',jsonb_build_object('status','idempotent','receipt_id',v_existing_receipt.id));
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,idempotency_key,request_sha256,metadata)
  values(p_user_id,p_binding_id,v_context_key,v_action,'record',v_idempotency_key,v_request_sha256,jsonb_build_object('status','pending'))
  on conflict (user_id,context_key,idempotency_key) where idempotency_key is not null do nothing returning id into v_receipt_id;
  if v_receipt_id is null then
    select * into v_existing_receipt from public.clued_audit_receipts
     where user_id=p_user_id and context_key=v_context_key and idempotency_key=v_idempotency_key for update;
    if v_existing_receipt.request_sha256<>v_request_sha256 then raise exception 'idempotency_key_conflict' using errcode='23505'; end if;
    return coalesce(v_existing_receipt.metadata->'result',jsonb_build_object('status','idempotent','receipt_id',v_existing_receipt.id));
  end if;

  if v_action='create' then
    v_status:=coalesce(p_input->>'status',case v_record_type when 'state' then 'current' when 'task' then 'backlog' when 'archive_snapshot' then 'archived' else 'active' end);
    insert into public.clued_memories(user_id,title,content,scope,project_id,record_type,record_key,status,priority,version,source_ref,archived_at)
    values(p_user_id,btrim(p_input->>'title'),btrim(p_input->>'content'),v_scope,v_project_id,v_record_type,nullif(btrim(p_input->>'record_key'),''),v_status,
      coalesce((p_input->>'priority')::smallint,0),1,nullif(btrim(p_input->>'source_ref'),''),case when v_status='archived' then now() end)
    returning * into v_record;
  else
    v_record_id:=(p_input->>'record_id')::uuid;
    v_expected_version:=(p_input->>'expected_version')::bigint;
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_record_id::text,0));
    select * into v_record from public.clued_memories
     where id=v_record_id and user_id=p_user_id for update;
    if v_record.id is null then raise exception 'record_not_found' using errcode='P0002'; end if;
    if v_record.version<>v_expected_version then raise exception 'record_version_conflict' using errcode='40001'; end if;
    if v_scope='project' and not exists (
      select 1 from public.clued_records_v2 r
       where r.id=v_record.id and r.user_id=p_user_id and r.effective_project_id=v_project_id
    ) then raise exception 'project_scope_mismatch' using errcode='42501'; end if;
    if v_scope='global' and v_record.scope<>'global' then raise exception 'project_scope_mismatch' using errcode='42501'; end if;
    if v_record.record_type='archive_snapshot' and v_action<>'restore' then raise exception 'archive_snapshot_immutable' using errcode='55000'; end if;

    if v_action='update' then
      update public.clued_memories set title=coalesce(nullif(btrim(p_input->>'title'),''),title),
        content=coalesce(nullif(btrim(p_input->>'content'),''),content),status=coalesce(p_input->>'status',status),
        priority=coalesce((p_input->>'priority')::smallint,priority),source_ref=coalesce(nullif(btrim(p_input->>'source_ref'),''),source_ref),
        updated_at=now(),version=version+1 where id=v_record.id returning * into v_record;
    elsif v_action='archive' then
      update public.clued_memories set status='archived',archived_at=now(),updated_at=now(),version=version+1
       where id=v_record.id returning * into v_record;
    elsif v_action='restore' then
      insert into public.clued_memories(user_id,title,content,scope,project_id,record_type,record_key,status,priority,source_ref,restored_from_id)
      values(p_user_id,coalesce(nullif(btrim(p_input->>'title'),''),v_record.title),coalesce(nullif(btrim(p_input->>'content'),''),v_record.content),
        v_record.scope,v_record.project_id,coalesce(nullif(p_input->>'restored_record_type',''),nullif(v_record.record_type,'archive_snapshot'),'note'),
        v_record.record_key,coalesce(nullif(p_input->>'status',''),'active'),v_record.priority,v_record.source_ref,v_record.id)
      returning * into v_record;
    elsif v_action='supersede_decision' then
      if v_record.record_type<>'decision' then raise exception 'decision_required' using errcode='22023'; end if;
      update public.clued_memories set status='superseded',updated_at=now(),version=version+1 where id=v_record.id;
      insert into public.clued_memories(user_id,title,content,scope,project_id,record_type,record_key,status,priority,source_ref,supersedes_id)
      values(p_user_id,btrim(p_input->>'title'),btrim(p_input->>'content'),v_record.scope,v_record.project_id,'decision',v_record.record_key,'active',
        coalesce((p_input->>'priority')::smallint,v_record.priority),nullif(btrim(p_input->>'source_ref'),''),v_record.id)
      returning * into v_record;
    elsif v_action='complete_task_and_advance_state' then
      if v_record.record_type<>'task' then raise exception 'task_required' using errcode='22023'; end if;
      v_state_id:=(p_input->>'state_id')::uuid;
      v_next_task_id:=nullif(p_input->>'next_task_id','')::uuid;
      perform 1 from public.clued_memories m
       where m.user_id=p_user_id and m.id=any(array_remove(array[v_record.id,v_state_id,v_next_task_id],null))
       order by m.id for update;
      select * into v_state from public.clued_memories where id=v_state_id and user_id=p_user_id;
      if v_state.id is null or v_state.record_type<>'state' or v_state.status<>'current' then raise exception 'current_state_required' using errcode='22023'; end if;
      if v_state.scope<>v_record.scope or v_state.project_id is distinct from v_record.project_id then raise exception 'cross_project_state' using errcode='42501'; end if;
      if v_next_task_id is not null then
        select * into v_next_task from public.clued_memories where id=v_next_task_id and user_id=p_user_id;
        if v_next_task.id is null or v_next_task.record_type<>'task' or v_next_task.scope<>v_record.scope or v_next_task.project_id is distinct from v_record.project_id then
          raise exception 'cross_project_next_task' using errcode='42501';
        end if;
      end if;
      update public.clued_memories set status='done',updated_at=now(),version=version+1 where id=v_record.id returning * into v_record;
      update public.clued_memories set next_task_id=v_next_task_id,
        content=coalesce(nullif(btrim(p_input->>'state_content'),''),content),updated_at=now(),version=version+1
       where id=v_state.id returning * into v_state;
    end if;
  end if;

  insert into public.clued_context_events(user_id,binding_id,context_key,event_type,payload,base_version,project_id,record_id,record_version,idempotency_key)
  values(p_user_id,p_binding_id,v_context_key,'action',jsonb_build_object('action',v_action,'record_type',v_record.record_type),
    v_expected_version,v_record.project_id,v_record.id,v_record.version,'record-event:'||v_idempotency_key)
  returning id into v_event_id;
  v_result:=jsonb_build_object('status','written','action',v_action,'record',to_jsonb(v_record),'state',to_jsonb(v_state),'event_id',v_event_id,'receipt_id',v_receipt_id);
  update public.clued_audit_receipts set object_id=v_record.id::text,version=v_record.version,
    metadata=jsonb_build_object('status','committed','result',v_result) where id=v_receipt_id;
  return v_result;
end $$;

create or replace function public.clued_record_list(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',case when p_input->>'level'='project' then 'project:'||(p_input->>'project_id') else 'global' end);
  return clued_private.record_list_core(v_binding.user_id,p_input);
end $$;
create or replace function public.clued_record_write(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',case when p_input->>'scope'='project' then 'project:'||(p_input->>'project_id') else 'global' end);
  return clued_private.record_write_core(v_binding.user_id,v_binding.id,p_input);
end $$;
create or replace function public.clued_user_record_list(p_input jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.record_list_core((select auth.uid()),p_input)
$$;
create or replace function public.clued_user_record_write(p_input jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.record_write_core((select auth.uid()),null,p_input)
$$;

revoke all on function clued_private.record_list_core(uuid,jsonb) from public,anon,authenticated;
revoke all on function clued_private.record_write_core(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.clued_record_list(text,jsonb) from public,authenticated;
revoke all on function public.clued_record_write(text,jsonb) from public,authenticated;
grant execute on function public.clued_record_list(text,jsonb) to anon;
grant execute on function public.clued_record_write(text,jsonb) to anon;
revoke all on function public.clued_user_record_list(jsonb) from public,anon;
revoke all on function public.clued_user_record_write(jsonb) from public,anon;
grant execute on function public.clued_user_record_list(jsonb) to authenticated;
grant execute on function public.clued_user_record_write(jsonb) to authenticated;

notify pgrst,'reload schema';
