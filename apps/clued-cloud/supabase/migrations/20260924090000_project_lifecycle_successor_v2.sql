-- Project Lifecycle Successor v2.
--
-- Additive production candidate only. The v1 columns and RPCs remain in place
-- for a bounded rollout/rollback window, but the v2 public contract never
-- accepts, exposes, or filters on certainty_status. Every legacy row receives
-- one deterministic, immutable disposition before it can enter the v2 view.

create table clued_private.project_lifecycle_v2_dispositions (
  project_id uuid primary key references public.clued_projects(id) on delete restrict,
  user_id uuid not null,
  disposition text not null check (disposition in ('recognized_project','evidence_only')),
  disposition_reason text not null check (length(btrim(disposition_reason)) between 1 and 500),
  recognition_confidence numeric(4,3) not null check (recognition_confidence between 0 and 1),
  recognition_source text not null check (recognition_source in (
    'v1_confirmed','confirmed_timestamp','explicit_project_event','durable_project_work',
    'confirmed_mention','legacy_mention_only','v2_explicit_create','v2_agent_recognition'
  )),
  source_refs uuid[] not null default '{}'::uuid[],
  basis jsonb not null check (jsonb_typeof(basis)='object'),
  migration_version integer not null default 2 check (migration_version=2),
  disposition_hash text not null check (disposition_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  unique(user_id,project_id)
);
alter table clued_private.project_lifecycle_v2_dispositions enable row level security;
revoke all on table clued_private.project_lifecycle_v2_dispositions
  from public,anon,authenticated,service_role;

-- This private physical flag exists only to make the successor uniqueness
-- invariant enforceable by PostgreSQL. Evidence-only legacy rows must not
-- reserve a Product Project name, while two recognized Projects for one owner
-- must still be unable to share the same normalized name.
alter table public.clued_projects
  add column project_recognized_v2 boolean not null default false;

create function clued_private.project_lifecycle_v2_disposition_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'project_lifecycle_v2_disposition_immutable' using errcode='55000';
end $$;
create trigger project_lifecycle_v2_disposition_immutable
  before update or delete on clued_private.project_lifecycle_v2_dispositions
  for each row execute function clued_private.project_lifecycle_v2_disposition_immutable();

-- A cutover changes the authority-visible active Project set. Invalidate the
-- corresponding Project scope in the same transaction so no pre-v2 admission
-- or projection can be reused as current.
create function clued_private.project_lifecycle_v2_disposition_currentness()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform clued_private.touch_currentness(new.user_id,'project:'||new.project_id::text,
    'project_lifecycle_v2_disposition',new.project_id::text,array['state','lifecycle']::text[]);
  return new;
end $$;
create trigger project_lifecycle_v2_disposition_currentness
  after insert on clued_private.project_lifecycle_v2_dispositions
  for each row execute function clued_private.project_lifecycle_v2_disposition_currentness();

-- Deterministic legacy disposition precedence:
--   confirmed field/timestamp -> recognized;
--   explicit canonical Project event -> recognized;
--   durable Record work -> recognized;
--   confirmed mention -> recognized;
--   otherwise -> evidence/history only.
-- This is deliberately not `unconfirmed => confirmed`.
insert into clued_private.project_lifecycle_v2_dispositions(
  project_id,user_id,disposition,disposition_reason,recognition_confidence,
  recognition_source,source_refs,basis,disposition_hash
)
select p.id,p.user_id,
  case when facts.recognized then 'recognized_project' else 'evidence_only' end,
  facts.reason,
  case when facts.recognized then greatest(p.confidence,facts.minimum_confidence)
       else p.confidence end,
  facts.source,
  facts.source_refs,
  facts.basis,
  clued_private.m1_sha256(jsonb_build_object(
    'project_id',p.id,'user_id',p.user_id,
    'disposition',case when facts.recognized then 'recognized_project' else 'evidence_only' end,
    'reason',facts.reason,'source',facts.source,
    'recognition_confidence',case when facts.recognized then greatest(p.confidence,facts.minimum_confidence) else p.confidence end,
    'basis',facts.basis,
    'source_refs',to_jsonb(facts.source_refs),'migration_version',2))
from public.clued_projects p
cross join lateral (
  select
    (p.certainty_status='confirmed' or p.confirmed_at is not null or
      exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type in ('project_created','project_updated','project_completed','project_archived','project_restored')
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)) or
      exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null) or
      exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed')) as recognized,
    case
      when p.certainty_status='confirmed' then 'Legacy v1 explicitly classified this row as a Project.'
      when p.confirmed_at is not null then 'Legacy confirmation timestamp proves an explicit Project decision.'
      when exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type in ('project_created','project_updated','project_completed','project_archived','project_restored')
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text))
        then 'A canonical Project mutation Event proves explicit Project creation or work.'
      when exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null)
        then 'Canonical Project-scoped work proves that the row is a Project.'
      when exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed')
        then 'A legacy confirmed mention proves an explicit Project decision.'
      else 'No Project-recognition decision or durable Project work exists; retain provenance as evidence/history only.'
    end as reason,
    case
      when p.certainty_status='confirmed' then 'v1_confirmed'
      when p.confirmed_at is not null then 'confirmed_timestamp'
      when exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type in ('project_created','project_updated','project_completed','project_archived','project_restored')
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)) then 'explicit_project_event'
      when exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null) then 'durable_project_work'
      when exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed') then 'confirmed_mention'
      else 'legacy_mention_only'
    end as source,
    case
      when p.certainty_status='confirmed' or p.confirmed_at is not null then 1.000
      when exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type='project_created'
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)) then 1.000
      when exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null) then 0.900
      when exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed') then 0.900
      else 0.000
    end as minimum_confidence,
    coalesce((select array_agg(distinct evidence_id order by evidence_id)
      from (
        select unnest(coalesce(m.source_refs,'{}'::uuid[])) evidence_id
          from public.clued_memories m where m.user_id=p.user_id and m.project_id=p.id
        union all
        select unnest(coalesce(e.evidence_refs,'{}'::uuid[])) evidence_id
          from public.clued_context_events e
         where e.user_id=p.user_id and e.event_schema_version is not null
           and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
             where ref->>'kind'='project' and ref->>'id'=p.id::text)
      ) refs),
      '{}'::uuid[]) as source_refs,
    jsonb_build_object(
      'legacy_certainty_status',p.certainty_status,
      'legacy_confirmed_at',p.confirmed_at,
      'canonical_project_event_count',(select count(*) from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)),
      'canonical_record_count',(select count(*) from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null),
      'confirmed_mention_count',(select count(*) from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed'),
      'mention_count',(select count(*) from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id)) as basis
) facts;

update public.clued_projects p
set project_recognized_v2=(d.disposition='recognized_project')
from clued_private.project_lifecycle_v2_dispositions d
where d.project_id=p.id and d.user_id=p.user_id;

drop index public.clued_projects_user_name_active_uidx;
create unique index clued_projects_user_recognized_name_v2_uidx
  on public.clued_projects(user_id,normalized_name)
  where project_recognized_v2 and merged_into_project_id is null;

-- During the bounded compatibility window, a legacy v1 M1 client may still
-- create through the retained RPC. A non-null Receipt proves an explicit
-- canonical Project mutation; raw/observe-style inserts remain evidence-only.
create function clued_private.project_lifecycle_v2_compat_insert()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_recognized boolean; v_source text; v_reason text; v_basis jsonb; v_hash text;
begin
  if new.project_schema_version=2 then return new; end if;
  v_recognized:=new.certainty_status='confirmed' or new.confirmed_at is not null or new.receipt_id is not null;
  v_source:=case when new.certainty_status='confirmed' then 'v1_confirmed'
    when new.confirmed_at is not null then 'confirmed_timestamp'
    when new.receipt_id is not null then 'explicit_project_event'
    else 'legacy_mention_only' end;
  v_reason:=case when v_recognized
    then 'A bounded-compatibility v1 canonical mutation explicitly created this Project.'
    else 'A post-cutover legacy mention did not cross the Project-recognition decision.' end;
  v_basis:=jsonb_build_object('operation','v1_compat_insert','receipt_id',new.receipt_id,
    'legacy_certainty_status',new.certainty_status,'legacy_confirmed_at',new.confirmed_at);
  v_hash:=clued_private.m1_sha256(jsonb_build_object('project_id',new.id,'user_id',new.user_id,
    'disposition',case when v_recognized then 'recognized_project' else 'evidence_only' end,
    'reason',v_reason,'source',v_source,
    'recognition_confidence',case when v_recognized then greatest(new.confidence,0.900) else new.confidence end,
    'basis',v_basis,'source_refs','[]'::jsonb,'migration_version',2));
  insert into clued_private.project_lifecycle_v2_dispositions(
    project_id,user_id,disposition,disposition_reason,recognition_confidence,
    recognition_source,source_refs,basis,disposition_hash)
  values(new.id,new.user_id,case when v_recognized then 'recognized_project' else 'evidence_only' end,
    v_reason,case when v_recognized then greatest(new.confidence,0.900) else new.confidence end,
    v_source,'{}'::uuid[],v_basis,v_hash);
  update public.clued_projects set project_recognized_v2=v_recognized where id=new.id;
  return new;
end $$;
create trigger project_lifecycle_v2_compat_insert
  after insert on public.clued_projects
  for each row execute function clued_private.project_lifecycle_v2_compat_insert();

create view public.clued_projects_v2 with (security_invoker=true) as
select p.id as canonical_project_id,p.user_id,2 as project_schema_version,
  p.name,p.aliases,p.summary,p.progress_status,
  coalesce(p.lifecycle_status,case when p.merged_into_project_id is null then 'active' else 'merged' end) as lifecycle_status,
  p.merged_into_project_id,p.closure_summary,p.closed_reason,p.closed_at,
  coalesce(p.merge_generation,0) as merge_generation,p.version,
  p.created_at as recorded_at,p.updated_at,p.receipt_id
from public.clued_projects p
join clued_private.project_lifecycle_v2_dispositions d
  on d.project_id=p.id and d.user_id=p.user_id and d.disposition='recognized_project';
revoke all on table public.clued_projects_v2 from public,anon,authenticated;
revoke all on table public.clued_projects_v2 from service_role;

create function clued_private.project_public_v2(p_project public.clued_projects)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id',p_project.id,'canonical_project_id',p_project.id,'project_schema_version',2,
    'name',p_project.name,'aliases',p_project.aliases,'summary',p_project.summary,
    'progress_status',p_project.progress_status,
    'lifecycle_status',coalesce(p_project.lifecycle_status,
      case when p_project.merged_into_project_id is null then 'active' else 'merged' end),
    'merged_into_project_id',p_project.merged_into_project_id,
    'closure_summary',p_project.closure_summary,'closed_reason',p_project.closed_reason,
    'closed_at',p_project.closed_at,'merge_generation',coalesce(p_project.merge_generation,0),
    'version',p_project.version,'recorded_at',p_project.created_at,
    'updated_at',p_project.updated_at,'receipt_id',p_project.receipt_id))
$$;

create function clued_private.project_effective_active_v2(p_user_id uuid,p_project_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_effective uuid;
begin
  v_effective:=clued_private.m1_effective_project(p_user_id,p_project_id);
  if not exists(select 1 from public.clued_projects p
    join clued_private.project_lifecycle_v2_dispositions d
      on d.project_id=p.id and d.user_id=p.user_id and d.disposition='recognized_project'
    where p.id=v_effective and p.user_id=p_user_id and p.dismissed_at is null
      and p.merged_into_project_id is null
      and coalesce(p.lifecycle_status,'active')='active') then
    raise exception 'project_not_active' using errcode='42501';
  end if;
  return v_effective;
end $$;

create function clued_private.project_mutation_core_v2(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_project public.clued_projects%rowtype;
  v_operation text:=p_input->>'operation'; v_mutation jsonb:=coalesce(p_input->'mutation','{}');
  v_recognition jsonb:=coalesce(p_input->'recognition','{}');
  v_id uuid; v_base bigint; v_event_type text; v_event_id text; v_refs jsonb; v_result jsonb;
  v_error text; v_state text; v_aliases text[]; v_progress text;
  v_recognition_confidence numeric; v_recognition_reason text; v_recognition_source text;
  v_source_refs uuid[]; v_disposition_hash text;
begin
  perform clued_private.currentness_user_lock(p_user_id);
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'project_mutation_v2',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if v_operation not in ('create','update','complete','archive','restore') then raise exception 'invalid_project_operation' using errcode='22023'; end if;
    if coalesce((p_input->>'project_schema_version')::integer,0)<>2 then raise exception 'invalid_project_schema' using errcode='22023'; end if;
    if v_mutation ?| array['certainty_status','confirmed_at','confidence'] or p_input ? 'certainty_status' then
      raise exception 'legacy_project_certainty_forbidden' using errcode='22023';
    end if;
    if v_operation<>'create' and p_input ? 'recognition' then
      raise exception 'recognition_metadata_create_only' using errcode='22023';
    end if;
    if v_mutation ? 'summary' and char_length(coalesce(v_mutation->>'summary',''))>2000 then
      raise exception 'invalid_project_summary' using errcode='22023';
    end if;
    if v_operation='update' and v_mutation ? 'name'
      and char_length(btrim(coalesce(v_mutation->>'name',''))) not between 1 and 120 then
      raise exception 'invalid_project_name' using errcode='22023';
    end if;
    v_id:=coalesce(nullif(p_input->>'canonical_project_id','')::uuid,gen_random_uuid());
    if v_operation='create' then
      if p_input ? 'base_version' and p_input->'base_version'<>'null'::jsonb then raise exception 'create_base_version_must_be_null' using errcode='22023'; end if;
      if not (p_input ? 'mutation') then raise exception 'incomplete_create' using errcode='22023'; end if;
      v_progress:=coalesce(v_mutation->>'progress_status','not_started');
      if v_progress not in ('not_started','active','paused') then raise exception 'invalid_project_create_status' using errcode='22023'; end if;
      if char_length(btrim(coalesce(v_mutation->>'name',''))) not between 1 and 120 then raise exception 'invalid_project_name' using errcode='22023'; end if;
      if exists(select 1 from public.clued_projects where id=v_id) then raise exception 'project_id_exists' using errcode='23505'; end if;
      v_aliases:=clued_private.project_input_aliases(v_mutation);
      v_recognition_confidence:=coalesce((v_recognition->>'confidence')::numeric,1.000);
      v_recognition_reason:=coalesce(nullif(btrim(v_recognition->>'reason'),''),'Explicit Project creation crossed the recognition decision.');
      v_recognition_source:=coalesce(nullif(v_recognition->>'source',''),case when p_binding_id is null then 'v2_explicit_create' else 'v2_agent_recognition' end);
      if v_recognition_confidence<0 or v_recognition_confidence>1
        or length(v_recognition_reason) not between 1 and 500
        or v_recognition_source not in ('v2_explicit_create','v2_agent_recognition') then
        raise exception 'invalid_project_recognition_metadata' using errcode='22023';
      end if;
      v_source_refs:=clued_private.m1_sorted_uuid_array(v_recognition->'source_refs');
      if exists(select 1 from unnest(v_source_refs) source_id where not exists(
        select 1 from public.clued_evidence e where e.id=source_id and e.user_id=p_user_id)) then
        raise exception 'recognition_evidence_not_authorized' using errcode='42501';
      end if;
      insert into public.clued_projects(
        id,user_id,name,normalized_name,aliases,certainty_status,progress_status,summary,confidence,context_key,
        confirmed_at,version,project_schema_version,lifecycle_status,closure_summary,closed_reason,closed_at,merge_generation,receipt_id,
        project_recognized_v2
      ) values (
        v_id,p_user_id,btrim(v_mutation->>'name'),clued_private.normalize_project_name(v_mutation->>'name'),v_aliases,'confirmed',v_progress,
        nullif(v_mutation->>'summary',''),v_recognition_confidence,'project:'||v_id,
        now(),1,2,'active',null,null,null,0,v_receipt.id,true
      ) returning * into v_project;
      v_disposition_hash:=clued_private.m1_sha256(jsonb_build_object(
        'project_id',v_id,'user_id',p_user_id,'disposition','recognized_project',
        'reason',v_recognition_reason,'source',v_recognition_source,
        'recognition_confidence',v_recognition_confidence,
        'basis',jsonb_build_object('operation','v2_create','receipt_id',v_receipt.id),
        'source_refs',to_jsonb(v_source_refs),'migration_version',2));
      insert into clued_private.project_lifecycle_v2_dispositions(
        project_id,user_id,disposition,disposition_reason,recognition_confidence,
        recognition_source,source_refs,basis,disposition_hash)
      values(v_id,p_user_id,'recognized_project',v_recognition_reason,v_recognition_confidence,
        v_recognition_source,v_source_refs,jsonb_build_object('operation','v2_create','receipt_id',v_receipt.id),v_disposition_hash);
      v_event_type:='project_created'; v_base:=null;
    else
      if not (p_input ? 'base_version') or coalesce((p_input->>'base_version')::bigint,0)<=0 then raise exception 'positive_base_version_required' using errcode='22023'; end if;
      v_base:=(p_input->>'base_version')::bigint;
      select * into v_project from public.clued_projects where id=v_id and user_id=p_user_id for update;
      if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
      if not exists(select 1 from clued_private.project_lifecycle_v2_dispositions d
        where d.project_id=v_id and d.user_id=p_user_id and d.disposition='recognized_project') then
        raise exception 'project_not_active' using errcode='42501';
      end if;
      if v_project.version<>v_base then raise exception 'project_version_conflict' using errcode='40001'; end if;
      if coalesce(v_project.lifecycle_status,'active')='merged' or v_project.merged_into_project_id is not null then raise exception 'merged_project_read_only' using errcode='55000'; end if;
      if v_operation='update' and v_project.progress_status not in ('not_started','active','paused') then raise exception 'terminal_project_read_only' using errcode='55000'; end if;
      if v_operation='restore' and v_project.progress_status not in ('completed','archived') then raise exception 'project_not_restorable' using errcode='22023'; end if;
      v_progress:=case v_operation when 'complete' then 'completed' when 'archive' then 'archived' when 'restore' then 'active'
        else coalesce(v_mutation->>'progress_status',v_project.progress_status) end;
      if v_operation='update' and v_progress not in ('not_started','active','paused') then raise exception 'project_terminal_command_required' using errcode='22023'; end if;
      v_aliases:=case when v_mutation ? 'aliases' then clued_private.project_input_aliases(v_mutation) else v_project.aliases end;
      update public.clued_projects set
        name=case when v_mutation ? 'name' then btrim(v_mutation->>'name') else name end,
        normalized_name=case when v_mutation ? 'name' then clued_private.normalize_project_name(v_mutation->>'name') else normalized_name end,
        aliases=v_aliases,summary=case when v_mutation ? 'summary' then nullif(v_mutation->>'summary','') else summary end,
        progress_status=v_progress,closure_summary=case when v_mutation ? 'closure_summary' then v_mutation->>'closure_summary' else closure_summary end,
        closed_reason=case when v_mutation ? 'closed_reason' then v_mutation->>'closed_reason' else closed_reason end,
        closed_at=case when v_operation in ('complete','archive') then now() when v_operation='restore' then null else closed_at end,
        updated_at=now(),version=version+1,receipt_id=v_receipt.id,project_schema_version=2,
        lifecycle_status='active',merge_generation=coalesce(merge_generation,0)
      where id=v_project.id returning * into v_project;
      v_event_type:=case v_operation when 'complete' then 'project_completed' when 'archive' then 'project_archived'
        when 'restore' then 'project_restored' else 'project_updated' end;
    end if;
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','project','id',v_project.id));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,v_event_type,
      v_refs,'project:'||v_project.id,null,'[]',p_input->>'idempotency_key',v_receipt.request_sha256,'success','work_log',v_source_refs,'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,jsonb_build_object(v_project.id::text,v_base),
      jsonb_build_object(v_project.id::text,v_project.version),array[v_event_id],coalesce(v_source_refs,'{}'::uuid[]),null);
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object('project',clued_private.project_public_v2(v_project)));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,case when v_state in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

create function public.clued_project_mutate_v2(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:write','system:projects');
  return clued_private.project_mutation_core_v2(b.user_id,b.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','project_mutation_v2','payload',p_input)));
end $$;
create function public.clued_user_project_mutate_v2(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.project_mutation_core_v2(
    clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash)
$$;

create function clued_private.project_list_v2_for_owner(p_user_id uuid,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare projects jsonb; row_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
begin
  if p_input ? 'certainty_status' then raise exception 'legacy_project_certainty_forbidden' using errcode='22023'; end if;
  select coalesce(jsonb_agg(clued_private.project_public_v2(project_row.p)||jsonb_build_object(
    'mention_count',(select count(*) from public.clued_project_mentions m where m.project_id=(project_row.p).id))
    order by (project_row.p).updated_at desc,(project_row.p).id),'[]'::jsonb)
  into projects from (
    select p from public.clued_projects p
    join clued_private.project_lifecycle_v2_dispositions d
      on d.project_id=p.id and d.user_id=p.user_id and d.disposition='recognized_project'
    where p.user_id=p_user_id and p.merged_into_project_id is null
      and (coalesce((p_input->>'include_dismissed')::boolean,false) or p.dismissed_at is null)
      and (not (p_input ? 'progress_status') or p.progress_status=p_input->>'progress_status')
      and (not (p_input ? 'query') or p.name ilike '%'||replace(p_input->>'query','%','\%')||'%' escape '\')
    order by p.updated_at desc,p.id limit row_limit
  ) project_row;
  return jsonb_build_object('status','ok','projects',projects);
end $$;

create function public.clued_user_project_list_v2(p_input jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  select clued_private.project_list_v2_for_owner(clued_private.authorization_owner_v12(),p_input)
$$;

create function public.clued_project_list_v2(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
  migrated boolean; broad boolean; projects jsonb;
  row_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
begin
  if p_input ? 'certainty_status' then raise exception 'legacy_project_certainty_forbidden' using errcode='22023'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_binding_or_context' using errcode='28000'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash for share;
  if not found or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()
    or not('context:read'=any(b.scopes)) then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  select * into a from clued_private.authorizations_v12 where binding_id=b.id for share;
  migrated:=found;
  if migrated and (a.owner_id is distinct from b.user_id or a.revoked_at is not null or a.expires_at<=clock_timestamp()) then
    raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
  broad:=not migrated and ('*'=any(b.context_keys) or 'system:projects'=any(b.context_keys));
  select coalesce(jsonb_agg(clued_private.project_public_v2(project_row.p)||jsonb_build_object(
    'mention_count',(select count(*) from public.clued_project_mentions m where m.project_id=(project_row.p).id))
    order by (project_row.p).updated_at desc,(project_row.p).id),'[]'::jsonb)
  into projects from (
    select p from public.clued_projects p
    join clued_private.project_lifecycle_v2_dispositions d
      on d.project_id=p.id and d.user_id=p.user_id and d.disposition='recognized_project'
    where p.user_id=b.user_id and p.merged_into_project_id is null
      and (case when migrated then
        'read'=any(clued_private.authorization_effective_actions_v13(b.id,'scope','project:'||p.id,'canonical'))
        else broad or ('project:'||p.id)=any(b.context_keys) end)
      and (coalesce((p_input->>'include_dismissed')::boolean,false) or p.dismissed_at is null)
      and (not (p_input ? 'progress_status') or p.progress_status=p_input->>'progress_status')
      and (not (p_input ? 'query') or p.name ilike '%'||replace(p_input->>'query','%','\%')||'%' escape '\')
    order by p.updated_at desc,p.id limit row_limit
  ) project_row;
  return jsonb_build_object('status','ok','projects',projects);
end $$;

-- Replace only the legacy Project-certainty gate inside the current Record
-- mutation core. Authorization, Receipt, Currentness and terminal guards remain
-- byte-for-byte inherited from the current qualified function.
do $migration$
declare body text;
  anchor text := $anchor$      if not exists(select 1 from public.clued_projects where id=v_effective_project and user_id=p_user_id
        and certainty_status='confirmed' and dismissed_at is null and merged_into_project_id is null) then
        raise exception 'project_not_confirmed' using errcode='42501';
      end if;$anchor$;
  replacement text := $replacement$      perform clued_private.project_effective_active_v2(p_user_id,v_effective_project);$replacement$;
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'project_lifecycle_v2_record_gate_definition_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $migration$;

-- Project extension Events receive the same effective/lifecycle gate.
do $migration$
declare body text;
  anchor text := $anchor$    if v_scope like 'project:%' then perform clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope)); end if;$anchor$;
  replacement text := $replacement$    if v_scope like 'project:%' then perform clued_private.project_effective_active_v2(p_user_id,clued_private.m1_scope_project_id(v_scope)); end if;$replacement$;
begin
  body:=pg_get_functiondef('clued_private.append_event_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'project_lifecycle_v2_event_gate_definition_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $migration$;

-- certainty_status remains compatibility storage during rollout, but it no
-- longer changes Currentness. Disposition insertion has its own invalidator.
create or replace function clued_private.currentness_project_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_dimensions text[]:=array['state','lifecycle']::text[];
begin
  if tg_op='DELETE' then
    perform clued_private.touch_currentness(old.user_id,'project:'||old.id::text,
      'project_delete',old.id::text,v_dimensions);
    return old;
  end if;
  if tg_op='UPDATE' then
    if row(new.name,new.normalized_name,new.aliases,new.progress_status,new.summary,
        new.dismissed_at,new.merged_into_project_id,new.lifecycle_status,new.project_schema_version,new.version)
      is not distinct from row(old.name,old.normalized_name,old.aliases,old.progress_status,old.summary,
        old.dismissed_at,old.merged_into_project_id,old.lifecycle_status,old.project_schema_version,old.version) then
      return new;
    end if;
  end if;
  perform clued_private.touch_currentness(new.user_id,'project:'||new.id::text,
    'project_mutation',new.id::text,v_dimensions);
  return new;
end $$;

-- v2 canonical export keeps evidence-only legacy rows explicit instead of
-- reintroducing them into the active Project array.
create function clued_private.canonical_export_core_v2(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_result jsonb; v_snapshot jsonb;
  v_projects jsonb; v_records jsonb; v_events jsonb; v_evidence jsonb;
  v_legacy_projects jsonb; v_legacy_records jsonb; v_legacy_events jsonb;
  v_receipt_refs jsonb; v_views_complete boolean;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'export_v2',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return jsonb_build_object('replayed',true,'receipt',coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))); end if;
  select coalesce(jsonb_agg(to_jsonb(p)-'user_id' order by p.canonical_project_id),'[]') into v_projects
    from public.clued_projects_v2 p where p.user_id=p_user_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind','legacy_project','legacy_id',p.id,'legacy_schema_version',coalesce(p.project_schema_version,1),
    'inline_payload',jsonb_build_object('id',p.id,'name',p.name,'aliases',p.aliases,
      'progress_status',p.progress_status,'context_key',p.context_key,'version',p.version,
      'recorded_at',p.created_at,'updated_at',p.updated_at),
    'content_hash',d.disposition_hash,'migration_status','evidence_only',
    'disposition_reason',d.disposition_reason,'recognition_source',d.recognition_source,
    'source_refs',to_jsonb(d.source_refs),'protected_payload_ref',null,'omitted_reason',null)
    order by p.id),'[]') into v_legacy_projects
    from public.clued_projects p join clued_private.project_lifecycle_v2_dispositions d
      on d.project_id=p.id and d.user_id=p.user_id and d.disposition='evidence_only'
    where p.user_id=p_user_id;
  select coalesce(jsonb_agg(to_jsonb(r)-'user_id' order by r.id),'[]') into v_records
    from public.clued_records_m1 r where r.user_id=p_user_id;
  select coalesce(jsonb_agg((to_jsonb(e)-'user_id'-'actor_user_id')||jsonb_build_object(
    'actor_kind',case when e.actor_binding_id='user_session' then 'user' else 'agent_binding' end) order by e.event_id),'[]') into v_events
    from public.clued_events_m1 e where e.user_id=p_user_id;
  select coalesce(jsonb_agg((to_jsonb(e)-'user_id'-'binding_id')||jsonb_build_object(
    'evidence_id',e.id,'referenced_by',coalesce((select jsonb_agg(r.id order by r.id) from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs)),'[]'),
    'derived_scopes',coalesce((select jsonb_agg(distinct r.scope order by r.scope) from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs)),'[]'),
    'export_disposition','omitted','omitted_reason','protected evidence payload') order by e.id),'[]') into v_evidence
    from public.clued_evidence e where e.user_id=p_user_id and exists(
      select 1 from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs));
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind','legacy_record','legacy_id',m.id,'legacy_schema_version',null,'legacy_record_type',m.record_type,
    'inline_payload',jsonb_build_object('id',m.id,'title',m.title,'content',m.content,'scope',m.scope,'project_id',m.project_id,
      'record_type',m.record_type,'record_key',m.record_key,'status',m.status,'priority',m.priority,'version',m.version,
      'source_ref',m.source_ref,'created_at',m.created_at,'updated_at',m.updated_at,'archived_at',m.archived_at),
    'protected_payload_ref',null,'content_hash',clued_private.m1_sha256(to_jsonb(m)-'user_id'),
    'missing_required_fields',jsonb_build_array('record_schema_version','lifecycle_status','receipt_id'),
    'migration_status','pending_review','omitted_reason',null) order by m.id),'[]') into v_legacy_records
    from public.clued_memories m where m.user_id=p_user_id and m.record_schema_version is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind','legacy_event','legacy_id',e.id::text,'legacy_schema_version',null,'legacy_record_type',null,
    'inline_payload',jsonb_build_object('event_type',e.event_type,'context_key',e.context_key,'payload',e.payload,
      'base_version',e.base_version,'occurred_at',e.occurred_at,'project_id',e.project_id,'record_id',e.record_id,'record_version',e.record_version),
    'protected_payload_ref',null,'content_hash',clued_private.m1_sha256(to_jsonb(e)-'user_id'-'binding_id'),
    'missing_required_fields',jsonb_build_array('event_schema_version','committed_canonical_version','audit_visibility','receipt_id'),
    'migration_status','preserved_audit_only','omitted_reason',null) order by e.id),'[]') into v_legacy_events
    from public.clued_context_events e where e.user_id=p_user_id and e.event_schema_version is null;
  select not exists(select 1 from public.clued_memories m where m.user_id=p_user_id and m.record_schema_version is null
    and m.record_type<>'archive_snapshot' and m.status not in ('done','cancelled','superseded','archived')) into v_views_complete;
  select coalesce(jsonb_agg(distinct id::text order by id::text),'[]') into v_receipt_refs from (
    select receipt_id as id from public.clued_records_m1 where user_id=p_user_id and receipt_id is not null
    union all select receipt_id from public.clued_projects_v2 where user_id=p_user_id and receipt_id is not null
    union all select receipt_id from public.clued_events_m1 where user_id=p_user_id and receipt_id is not null
    union all select receipt_id from public.clued_evidence where user_id=p_user_id
    union all select v_receipt.id) refs;
  v_snapshot:=jsonb_build_object(
    'schema_version',2,'project_contract_version',2,'canonical_version','cv_'||v_receipt.canonical_version,
    'source_verification','live_rechecked','views_complete',v_views_complete,
    'owner_ref','owner_'||left(encode(extensions.digest(convert_to(p_user_id::text,'UTF8'),'sha256'),'hex'),24),
    'export_receipt_id',v_receipt.id,'projects',v_projects,'records',v_records,'events',v_events,'evidence',v_evidence,
    'referenced_receipts',v_receipt_refs,'legacy_projects',v_legacy_projects,'legacy_records',v_legacy_records,
    'legacy_events',v_legacy_events,'legacy_evidence','[]'::jsonb,'excluded_evidence_counts',jsonb_build_object(
      'unlinked',(select count(*) from public.clued_evidence e where e.user_id=p_user_id and not exists(
        select 1 from public.clued_records_m1 r where r.user_id=p_user_id and e.id=any(r.source_refs)))));
  v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed','[]','{}','{}','{}','{}',null);
  update public.clued_audit_receipts set artifact_refs=jsonb_build_array(jsonb_build_object(
    'kind','export','id','cv_'||v_receipt.canonical_version,'content_hash',clued_private.m1_sha256(v_snapshot))) where id=v_receipt.id;
  return jsonb_build_object('replayed',false,'receipt',v_result,'snapshot',v_snapshot);
end $$;

create function public.clued_canonical_export_v2(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  return clued_private.canonical_export_core_v2(b.user_id,b.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','export_v2','payload',p_input)));
end $$;
create function public.clued_user_canonical_export_v2(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.canonical_export_core_v2(
    clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash)
$$;

revoke all on function
  clued_private.project_lifecycle_v2_disposition_immutable(),
  clued_private.project_lifecycle_v2_disposition_currentness(),
  clued_private.project_lifecycle_v2_compat_insert(),
  clued_private.project_public_v2(public.clued_projects),
  clued_private.project_effective_active_v2(uuid,uuid),
  clued_private.project_mutation_core_v2(uuid,uuid,jsonb,text),
  clued_private.project_list_v2_for_owner(uuid,jsonb),
  clued_private.canonical_export_core_v2(uuid,uuid,jsonb,text)
from public,anon,authenticated,service_role;
revoke all on function
  public.clued_project_mutate_v2(text,jsonb),public.clued_project_list_v2(text,jsonb),
  public.clued_canonical_export_v2(text,jsonb)
from public,authenticated,service_role;
grant execute on function
  public.clued_project_mutate_v2(text,jsonb),public.clued_project_list_v2(text,jsonb),
  public.clued_canonical_export_v2(text,jsonb)
to anon;
revoke all on function
  public.clued_user_project_mutate_v2(jsonb,text),public.clued_user_project_list_v2(jsonb),
  public.clued_user_canonical_export_v2(jsonb,text)
from public,anon,service_role;
grant execute on function
  public.clued_user_project_mutate_v2(jsonb,text),public.clued_user_project_list_v2(jsonb),
  public.clued_user_canonical_export_v2(jsonb,text)
to authenticated;

notify pgrst,'reload schema';
