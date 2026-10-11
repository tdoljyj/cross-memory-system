-- R9 measurement evidence. Private, append-only and transaction-bound.
-- No policy/claim/queue mutation, public RPC, permission or production install.
-- A later authenticated reader must bind user/scope before calling the core.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table clued_private.work_claims_v1,
  clued_private.work_claim_merge_queue_v1, public.clued_audit_receipts
  in share row exclusive mode;

create table clued_private.merge_measurement_stream_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stream_id uuid not null default extensions.gen_random_uuid(),
  started_at timestamptz not null,
  last_at timestamptz not null,
  last_sequence bigint not null default 0 check(last_sequence>=0),
  source_digest text not null check(source_digest ~ '^[0-9a-f]{64}$'),
  source_changed boolean not null default false
);
create table clued_private.merge_measurement_events_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  sequence bigint not null check(sequence>0),
  transaction_id text not null,
  recorded_at timestamptz not null,
  context_key text not null,
  kind text not null check(kind in ('policy','claim','queue_marker','admission_receipt')),
  object_key text not null,
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  source_digest text not null check(source_digest ~ '^[0-9a-f]{64}$'),
  primary key(user_id,sequence)
);
create index merge_measurement_events_v1_object_idx
  on clued_private.merge_measurement_events_v1(user_id,kind,object_key,sequence desc);
create index merge_measurement_events_v1_time_idx
  on clued_private.merge_measurement_events_v1(user_id,recorded_at,sequence);
create index merge_measurement_events_v1_transaction_idx
  on clued_private.merge_measurement_events_v1(user_id,transaction_id,sequence);
alter table clued_private.merge_measurement_stream_v1 enable row level security;
alter table clued_private.merge_measurement_events_v1 enable row level security;
revoke all on table clued_private.merge_measurement_stream_v1,
  clued_private.merge_measurement_events_v1 from public,anon,authenticated,service_role;

create function clued_private.merge_measurement_source_digest_v1() returns text
language sql stable set search_path='' as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    (select string_agg(coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(n)),
      'MISSING:'||n),'\n' order by n) from unnest(array[
        'clued_private.work_claim_merge_queue_v1(uuid,text)',
        'clued_private.work_claim_merge_slot_until_from_v1(clued_private.work_claims_v1,timestamp with time zone)',
        'clued_private.work_claim_merge_slot_stamp_v1()',
        'clued_private.work_claim_merge_refs_v1(text[])',
        'clued_private.work_claim_profile_v1()',
        'clued_private.merge_measurement_claim_v1(clued_private.work_claims_v1)',
        'clued_private.merge_measurement_append_v1(uuid,text,text,text,jsonb)',
        'clued_private.merge_measurement_claim_capture_v1()',
        'clued_private.merge_measurement_marker_capture_v1()',
        'clued_private.merge_measurement_receipt_capture_v1()'
      ]) names(n)), 'UTF8'), 'sha256'),'hex')
$$;

-- Never copy lease keys, tokens, labels, budget, arbitrary payloads or credentials.
create function clued_private.merge_measurement_claim_v1(c clued_private.work_claims_v1) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,
    'context_key',c.context_key,'fence',c.fence,'status',c.status,
    'expires_at',c.expires_at,'merge_queued_at',c.merge_queued_at,
    'merge_slot_at',c.merge_slot_at,'merge_slot_ci_at',c.merge_slot_ci_at,
    'merge_slot_ci_state',c.merge_slot_ci_state,
    'merge_slot_hard_cap_seconds',c.merge_slot_hard_cap_seconds,
    'merge_refs',to_jsonb(clued_private.work_claim_merge_refs_v1(c.trigger_refs)),
    'bound_pr',c.bound_pr,'admitted_heads',to_jsonb(c.admitted_heads))
$$;

create function clued_private.merge_measurement_append_v1(
  p_user uuid,p_context text,p_kind text,p_key text,p_payload jsonb
) returns bigint language plpgsql volatile security definer set search_path='' as $$
declare s clued_private.merge_measurement_stream_v1%rowtype;
  v_digest text:=clued_private.merge_measurement_source_digest_v1();
  v_now timestamptz;
begin
  -- Every row writer serializes through the same transactional stream row.
  -- Rollback rolls the sequence and event back together: no sequence allocation gap.
  insert into clued_private.merge_measurement_stream_v1(user_id,started_at,last_at,source_digest)
    values(p_user,pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),v_digest)
    on conflict(user_id) do nothing;
  select * into s from clued_private.merge_measurement_stream_v1 where user_id=p_user for update;
  v_now:=greatest(s.last_at,pg_catalog.clock_timestamp());
  if s.last_sequence=0 and p_kind<>'policy' then
    -- A newly active account has no migration-time seed rows. Establish its
    -- empty initial policy boundary before its first measured change.
    update clued_private.merge_measurement_stream_v1 set last_sequence=1,last_at=v_now where user_id=p_user;
    insert into clued_private.merge_measurement_events_v1
      (user_id,sequence,transaction_id,recorded_at,context_key,kind,object_key,payload,source_digest)
      values(p_user,1,pg_catalog.pg_current_xact_id()::text,v_now,'global','policy','fifo-v1',
        jsonb_build_object('profile',clued_private.work_claim_profile_v1(),'empty_before_first_change',true),v_digest);
  end if;
  update clued_private.merge_measurement_stream_v1
    set last_sequence=last_sequence+1,last_at=v_now,
      source_changed=source_changed or source_digest<>v_digest
    where user_id=p_user returning * into s;
  insert into clued_private.merge_measurement_events_v1
    (user_id,sequence,transaction_id,recorded_at,context_key,kind,object_key,payload,source_digest)
    values(p_user,s.last_sequence,pg_catalog.pg_current_xact_id()::text,v_now,p_context,p_kind,p_key,p_payload,v_digest);
  return s.last_sequence;
end $$;

create function clued_private.merge_measurement_claim_capture_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_old jsonb; v_new jsonb;
begin
  if tg_op<>'INSERT' then v_old:=clued_private.merge_measurement_claim_v1(old); end if;
  if tg_op<>'DELETE' then v_new:=clued_private.merge_measurement_claim_v1(new); end if;
  if tg_op='UPDATE' and v_old=v_new then return new; end if;
  if tg_op='DELETE' then
    -- The only deletion surface is the existing FK erasure path. No account survives it.
    if exists(select 1 from auth.users where id=old.user_id) then
      perform clued_private.merge_measurement_append_v1(old.user_id,old.context_key,'claim',old.claim_id::text,
        v_old||jsonb_build_object('status','DELETED'));
    end if;
    return old;
  end if;
  perform clued_private.merge_measurement_append_v1(new.user_id,new.context_key,'claim',new.claim_id::text,v_new);
  return new;
end $$;

create function clued_private.merge_measurement_marker_capture_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb;
begin
  if tg_op='DELETE' then
    if exists(select 1 from auth.users where id=old.user_id) then
      raise exception 'merge_measurement_marker_delete_unsupported' using errcode='55000';
    end if;
    return old;
  end if;
  v_payload:=jsonb_build_object('merge_ref',new.merge_ref,'head_left_at',new.head_left_at,
    'left_queued_at',new.left_queued_at,'left_claim_id',new.left_claim_id);
  perform clued_private.merge_measurement_append_v1(new.user_id,'global','queue_marker',new.merge_ref,v_payload);
  return new;
end $$;

create function clued_private.merge_measurement_receipt_capture_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_kind text:=new.metadata->>'receipt_kind'; v_payload jsonb;
begin
  -- This is server claim-admission evidence, not complete App/gate failure evidence.
  -- The complete five-metric collector must qualify the missing GitHub source separately.
  if v_kind is distinct from 'WORK_CLAIM_HEAD_ADMITTED' then return new; end if;
  v_payload:=jsonb_build_object('receipt_id',new.id,'receipt_kind',v_kind,
    'claim_id',new.object_id,'fence',new.version,
    'pr_ref',new.metadata->'pr_ref','head_sha',new.metadata->'head_sha',
    'admission_mode',new.metadata->'admission_mode','reasons',new.metadata->'reasons');
  perform clued_private.merge_measurement_append_v1(new.user_id,new.context_key,
    'admission_receipt',new.id::text,v_payload);
  return new;
end $$;

create function clued_private.merge_measurement_immutable_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- Preserve the established account erasure semantics, without offering a pruning API.
  if tg_op='DELETE' and not exists(select 1 from auth.users where id=old.user_id) then return old; end if;
  raise exception 'merge_measurement_immutable' using errcode='55000';
end $$;

create trigger merge_measurement_events_v1_immutable
  before update or delete on clued_private.merge_measurement_events_v1
  for each row execute function clued_private.merge_measurement_immutable_v1();
create trigger merge_measurement_events_v1_no_truncate
  before truncate on clued_private.merge_measurement_events_v1
  for each statement execute function clued_private.merge_measurement_immutable_v1();

-- Atomic initial state, while the source tables are locked. No old history is invented.
do $$
declare u uuid; c clued_private.work_claims_v1%rowtype;
  q clued_private.work_claim_merge_queue_v1%rowtype;
begin
  for u in select distinct user_id from clued_private.work_claims_v1 loop
    perform clued_private.merge_measurement_append_v1(u,'global','policy','fifo-v1',
      jsonb_build_object('profile',clued_private.work_claim_profile_v1(),'initial_snapshot',true));
  end loop;
  for c in select * from clued_private.work_claims_v1 order by user_id,claim_id loop
    perform clued_private.merge_measurement_append_v1(c.user_id,c.context_key,'claim',c.claim_id::text,
      clued_private.merge_measurement_claim_v1(c));
  end loop;
  for q in select * from clued_private.work_claim_merge_queue_v1 order by user_id,merge_ref loop
    perform clued_private.merge_measurement_append_v1(q.user_id,'global','queue_marker',q.merge_ref,
      jsonb_build_object('merge_ref',q.merge_ref,'head_left_at',q.head_left_at,
        'left_queued_at',q.left_queued_at,'left_claim_id',q.left_claim_id));
  end loop;
end $$;

create trigger merge_measurement_claims_v1_capture
  after insert or update or delete on clued_private.work_claims_v1
  for each row execute function clued_private.merge_measurement_claim_capture_v1();
create trigger merge_measurement_markers_v1_capture
  after insert or update or delete on clued_private.work_claim_merge_queue_v1
  for each row execute function clued_private.merge_measurement_marker_capture_v1();
create trigger merge_measurement_receipts_v1_capture
  after insert on public.clued_audit_receipts
  for each row execute function clued_private.merge_measurement_receipt_capture_v1();

-- Private reader core: NO caller-supplied user may reach this without a qualified
-- authenticated wrapper. Fixed end_sequence is the pagination watermark.
create function clued_private.merge_measurement_page_v1(p_user uuid,p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s clued_private.merge_measurement_stream_v1%rowtype;
  v_after bigint; v_end bigint; v_limit integer; v_rows jsonb; v_last bigint;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k
      where k not in ('after_sequence','end_sequence','limit','stream_id'))
    or coalesce(p_input->>'after_sequence','0') !~ '^[0-9]{1,18}$'
    or (p_input ? 'end_sequence' and coalesce(p_input->>'end_sequence','') !~ '^[0-9]{1,18}$')
    or coalesce(p_input->>'limit','100') !~ '^[0-9]{1,3}$' then
    raise exception 'merge_measurement_page_invalid' using errcode='22023';
  end if;
  if (p_input ? 'limit' and jsonb_typeof(p_input->'limit') is distinct from 'number')
    or (p_input ? 'after_sequence' and jsonb_typeof(p_input->'after_sequence') not in ('number','string'))
    or (p_input ? 'end_sequence' and jsonb_typeof(p_input->'end_sequence') not in ('number','string'))
    or (p_input ? 'stream_id' and jsonb_typeof(p_input->'stream_id') is distinct from 'string') then
    raise exception 'merge_measurement_page_invalid' using errcode='22023';
  end if;
  v_after:=coalesce(p_input->>'after_sequence','0')::bigint;
  v_limit:=coalesce(p_input->>'limit','100')::integer;
  if v_limit not between 1 and 500 then raise exception 'merge_measurement_page_limit_invalid' using errcode='22023'; end if;
  select * into s from clued_private.merge_measurement_stream_v1 where user_id=p_user;
  if s.user_id is null then return jsonb_build_object('status','NOT_MEASURED','reason','stream_not_started','events','[]'::jsonb); end if;
  if p_input ? 'stream_id' and p_input->>'stream_id'<>s.stream_id::text then
    raise exception 'merge_measurement_stream_mismatch' using errcode='22023'; end if;
  v_end:=coalesce(p_input->>'end_sequence',s.last_sequence::text)::bigint;
  if v_after>0 and (not(p_input ? 'stream_id') or not(p_input ? 'end_sequence')) then
    raise exception 'merge_measurement_page_pins_required' using errcode='22023'; end if;
  if v_after>v_end or v_end>s.last_sequence then raise exception 'merge_measurement_watermark_invalid' using errcode='22023'; end if;
  -- A watermark is not permitted to stop inside one source transaction.
  -- Reader results are journal pages, not independently valid state snapshots.
  if v_end>0 and exists(select 1 from clued_private.merge_measurement_events_v1 a
    join clued_private.merge_measurement_events_v1 b
      on b.user_id=a.user_id and b.transaction_id=a.transaction_id
    where a.user_id=p_user and a.sequence=v_end and b.sequence>v_end) then
    raise exception 'merge_measurement_watermark_in_transaction' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sequence',e.sequence,'recorded_at',e.recorded_at,
    'transaction_id',e.transaction_id,
    'context_key',e.context_key,'kind',e.kind,'object_key',e.object_key,'payload',e.payload,
    'source_digest',e.source_digest) order by e.sequence),'[]'::jsonb),max(e.sequence)
    into v_rows,v_last from (select * from clued_private.merge_measurement_events_v1
      where user_id=p_user and sequence>v_after and sequence<=v_end order by sequence limit v_limit) e;
  if jsonb_array_length(v_rows)<>least(v_limit,v_end-v_after) then
    return jsonb_build_object('status','NOT_MEASURED','reason','sequence_gap','events','[]'::jsonb);
  end if;
  return jsonb_build_object('status',case when s.source_changed
      or s.source_digest<>clued_private.merge_measurement_source_digest_v1() then 'SOURCE_CHANGED' else 'ok' end,
    'stream_id',s.stream_id,'started_at',s.started_at,'source_digest',s.source_digest,
    'after_sequence',v_after,'end_sequence',v_end,'next_sequence',coalesce(v_last,v_after),
    'has_more',coalesce(v_last,v_after)<v_end,'events',v_rows,
    'timestamp_semantics','server observations inside transactions; not commit timestamps',
    'page_semantics','raw journal fragments; fold complete transaction groups only',
    'qualification','private_evidence_core; authenticated_scope_and_metric_coverage_not_yet_established');
end $$;

revoke all on function
  clued_private.merge_measurement_source_digest_v1(),
  clued_private.merge_measurement_claim_v1(clued_private.work_claims_v1),
  clued_private.merge_measurement_append_v1(uuid,text,text,text,jsonb),
  clued_private.merge_measurement_claim_capture_v1(),
  clued_private.merge_measurement_marker_capture_v1(),
  clued_private.merge_measurement_receipt_capture_v1(),
  clued_private.merge_measurement_immutable_v1(),
  clued_private.merge_measurement_page_v1(uuid,jsonb)
  from public,anon,authenticated,service_role;

-- Extend the existing authenticated audit entry, retaining its exact signature
-- and ACL. No new public RPC, role or permission is granted. Existing calls
-- retain the current compliance view; measurement pages use the same audit:read
-- authority and qualify EVERY contributing context before returning any rows.
create or replace function public.clued_mcp_audit_receipts(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype; v_checked public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,20),1),100);
  v_receipts jsonb; v_sessions jsonb; v_reminder boolean:=false; v_context text; v_page jsonb;
  v_measurement jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context_key);
  if p_input ? 'measurement' then
    if jsonb_typeof(p_input->'measurement') is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('context_key','limit','measurement')) then
      raise exception 'merge_measurement_input_invalid' using errcode='22023'; end if;
    -- Fix the same stream/end BEFORE enumerating authorization scopes. This
    -- local result is not returned until every contributor is authorized.
    v_page:=clued_private.merge_measurement_page_v1(v_binding.user_id,p_input->'measurement');
    if v_page->>'status' not in ('ok','SOURCE_CHANGED') then return v_page; end if;
    v_measurement:=(p_input->'measurement')||jsonb_build_object(
      'stream_id',v_page->>'stream_id','end_sequence',v_page->'end_sequence');
    -- Queue refs can be shared by claims from Global and multiple projects.
    -- Omitting an unreadable contributor would falsify the denominator.
    for v_context in select distinct e.context_key from clued_private.merge_measurement_events_v1 e
      where e.user_id=v_binding.user_id and e.sequence<=(v_page->>'end_sequence')::bigint loop
      begin
        v_checked:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context);
        if v_checked.user_id<>v_binding.user_id then raise exception 'measurement_user_mismatch'; end if;
      exception when others then
        return jsonb_build_object('status','NOT_MEASURED','reason','measurement_scope_incomplete','events','[]'::jsonb);
      end;
    end loop;
    v_page:=clued_private.merge_measurement_page_v1(v_binding.user_id,v_measurement);
    return v_page||jsonb_build_object('qualification',
      'authenticated_audit_metadata; complete_source_journal_required; no_official_metric_claim',
      'official_metric',false);
  end if;
  select coalesce(jsonb_agg(row_data order by created_at desc),'[]'::jsonb) into v_receipts from (
    select jsonb_build_object('id',r.id,'operation',r.operation,'object_type',r.object_type,'object_id',r.object_id,
      'version',r.version,'binding_id',r.binding_id,'metadata',r.metadata,'created_at',r.created_at) row_data,r.created_at
    from public.clued_audit_receipts r where r.user_id=v_binding.user_id and r.context_key=v_context_key
    order by r.created_at desc limit v_limit
  ) matches;
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id',s.id,'client_session_id',s.client_session_id,'started_at',s.started_at,'last_seen_at',s.last_seen_at,
    'expires_at',s.expires_at,'ended_at',s.ended_at,'append_count',x.append_count,'checkpoint_count',x.checkpoint_count,
    'state',case when x.checkpoint_count>0 then 'checkpointed' when x.append_count>0 and s.expires_at<=now() then 'expired_without_checkpoint'
      when x.append_count>0 then 'checkpoint_required_before_handoff' else 'capture_unknown' end,
    'required_action',case when x.append_count>0 and x.checkpoint_count=0 then 'checkpoint_before_handoff' else null end,
    'authority_capture',case when x.append_count>0 and x.checkpoint_count=0 then 'incomplete' else 'unknown' end
  ) order by s.started_at desc),'[]'::jsonb),
  coalesce(bool_or(x.append_count>0 and x.checkpoint_count=0),false) into v_sessions,v_reminder
  from public.clued_continuity_sessions s
  cross join lateral (select
    count(*) filter(where r.operation='append') append_count,
    count(*) filter(where r.operation='checkpoint') checkpoint_count
    from public.clued_audit_receipts r where r.operation in ('append','checkpoint')
      and r.user_id=s.user_id and r.binding_id=s.binding_id and r.context_key=s.context_key
      and r.metadata->>'session_id'=s.id::text) x
  where s.user_id=v_binding.user_id and s.binding_id=v_binding.id and s.context_key=v_context_key
    and s.started_at>now()-interval '30 days';
  return jsonb_build_object('status','ok','context_key',v_context_key,'receipts',v_receipts,
    'session_compliance',v_sessions,'checkpoint_reminder',v_reminder,
    'authority_capture_completeness',jsonb_build_object(
      'state',case when v_reminder then 'incomplete' else 'unknown' end,
      'basis','server_observes_only_writes_that_reached_clued','independent_of','currentness'));
end $$;
commit;
