-- Work Claim per-Task cap exemption (Owner Decision d16b5bfc, Task 3da81cf1).
--
-- A Task gets at most max_claims_per_task_24h new claims or takeovers in any
-- 24 hours (20261002100000). The Owner can now lift that for one Task: an
-- exemption admits up to 5 more new claims or takeovers issued after it is
-- granted, for 24 hours. Only the Owner can grant one, through two Native
-- account-session RPCs called from the signed-in web page, the same shape as
-- the S4 Context Policy acceptance:
--   1. clued_work_claim_exemption_confirmation_issue_v1 {task_id, scope?, reason}
--      returns a single-use confirmation token (5 minutes) over the view;
--   2. clued_work_claim_exemption_grant_v1 {confirmation_token, view_digest}
--      consumes it and records the exemption with a Receipt.
-- Both are granted to authenticated only and resolve the caller through
-- authorization_owner_v12, which refuses a delegated OAuth token; a Binding
-- never reaches them, so an Agent cannot exempt its own Task. The caller must
-- have signed in within 15 minutes, and the token is bound to the JWT
-- session_id. There is no MCP tool, OAuth case or Binding route.

create table clued_private.work_claim_exemptions_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.clued_memories(id) on delete cascade,
  extra_claims integer not null check (extra_claims between 1 and 10),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  granted_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  token_id uuid not null unique references clued_private.native_confirmation_tokens(id),
  receipt_id uuid not null unique references public.clued_audit_receipts(id),
  granted_session_id text not null,
  check (expires_at>granted_at)
);
create index work_claim_exemptions_v1_task_idx
  on clued_private.work_claim_exemptions_v1(user_id,task_id,expires_at);
alter table clued_private.work_claim_exemptions_v1 enable row level security;
revoke all on table clued_private.work_claim_exemptions_v1 from public,anon,authenticated,service_role;

create function clued_private.work_claim_exemption_immutable_v1()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'work_claim_exemption_immutable' using errcode='55000';
end $$;
create trigger work_claim_exemptions_v1_immutable before update
  on clued_private.work_claim_exemptions_v1 for each row
  execute function clued_private.work_claim_exemption_immutable_v1();

-- What the Owner confirms: fixed allowance and lifetime, the Task as it is
-- now, and the reason. Recomputed at grant; any drift makes the view stale.
create function clued_private.work_claim_exemption_view_v1(p_task public.clued_memories,p_reason text)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('action','work_claim_exemption','task_id',p_task.id,'task_title',p_task.title,
    'task_scope',p_task.canonical_scope,'extra_claims',5,'valid_hours',24,'reason',p_reason)
$$;

create function clued_private.work_claim_exemption_status_v1(p_user_id uuid,p_task_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'max_claims_per_task_24h',(clued_private.work_claim_profile_v1()->>'max_claims_per_task_24h')::integer,
    'claims_last_24h',(select count(*) from clued_private.work_claims_v1 w
      where w.user_id=p_user_id and w.task_id=p_task_id and w.issued_at>clock_timestamp()-interval '24 hours'),
    'active_exemptions',coalesce((select jsonb_agg(jsonb_build_object('exemption_id',e.id,
        'granted_at',e.granted_at,'expires_at',e.expires_at,'extra_claims',e.extra_claims,
        'used',(select count(*) from clued_private.work_claims_v1 w
          where w.user_id=e.user_id and w.task_id=e.task_id and w.issued_at>=e.granted_at))
      order by e.granted_at)
      from clued_private.work_claim_exemptions_v1 e
      where e.user_id=p_user_id and e.task_id=p_task_id and e.expires_at>clock_timestamp()),'[]'::jsonb))
$$;

create function clued_private.work_claim_exemption_issue_core_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_task public.clued_memories%rowtype; v_scope text; v_reason text; v_choices jsonb; v_view jsonb;
  v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz; v_now timestamptz; v_error text;
  v_auth_time timestamptz:=clued_private.native_auth_time_v1();
begin
  if v_auth_time is null or v_auth_time<clock_timestamp()-interval '15 minutes' then
    return jsonb_build_object('status','rejected','error_code','reauthentication_required','authoritative',false);
  end if;
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required',
      'authoritative',false);
  end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('task_id','scope','reason')) then
      raise exception 'work_claim_exemption_unknown_field' using errcode='22023';
    end if;
    v_scope:=coalesce(p_input->>'scope','global');
    if v_scope !~ '^(global|project:[0-9a-fA-F-]{36})$' then
      raise exception 'work_claim_exemption_scope_invalid' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'reason') is distinct from 'string'
      or char_length(btrim(p_input->>'reason')) not between 1 and 500 then
      raise exception 'work_claim_exemption_reason_required' using errcode='22023';
    end if;
    v_reason:=btrim(p_input->>'reason');
    v_task:=clued_private.work_claim_task(p_user_id,v_scope,p_input->>'task_id');
    v_choices:=jsonb_build_object('task_id',v_task.id,'scope',v_scope,'reason',v_reason);
    v_view:=clued_private.work_claim_exemption_view_v1(v_task,v_reason);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=p_user_id and action='work_claim_exemption' and subject_key=v_task.id::text
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_wce_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(p_user_id,'work_claim_exemption',v_task.id::text,0,v_choices,v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
      clued_private.native_session_id_v1(),v_auth_time,v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,
      'expires_at',v_expires,'confirmation_view',v_view,'view_digest',v_digest,
      'task_status',clued_private.work_claim_exemption_status_v1(p_user_id,v_task.id),'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

create function clued_private.work_claim_exemption_grant_core_v1(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_token clued_private.native_confirmation_tokens%rowtype; v_token_id uuid; v_task public.clued_memories%rowtype;
  v_view jsonb; v_exemption clued_private.work_claim_exemptions_v1%rowtype; v_receipt uuid; v_now timestamptz;
  v_error text; v_state text; v_hash text;
begin
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'work_claim_exemption_unknown_field' using errcode='22023';
    end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501';
    end if;
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=p_user_id and t.action='work_claim_exemption' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    -- A retry of a grant that already committed (an uncertain network result)
    -- returns the same exemption instead of granting again.
    if v_token.consume_outcome='committed' then
      select * into v_exemption from clued_private.work_claim_exemptions_v1 where token_id=v_token.id;
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_exemption.receipt_id,
        'exemption',jsonb_build_object('exemption_id',v_exemption.id,'task_id',v_exemption.task_id,
          'extra_claims',v_exemption.extra_claims,'granted_at',v_exemption.granted_at,
          'expires_at',v_exemption.expires_at));
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then
      raise exception 'confirmation_token_same_request' using errcode='42501';
    end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501';
    end if;
    if not clued_private.native_session_fresh_v1() then
      raise exception 'reauthentication_required' using errcode='42501';
    end if;
    v_task:=clued_private.work_claim_task(p_user_id,v_token.native_choices->>'scope',v_token.native_choices->>'task_id');
    v_view:=clued_private.work_claim_exemption_view_v1(v_task,v_token.native_choices->>'reason');
    if clued_private.m1_sha256(v_view)<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001';
    end if;
    v_now:=clock_timestamp();
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(p_user_id,null,v_task.canonical_scope,'work_claim_exemption_grant','work_claim_exemption',v_task.id::text,1,
      jsonb_build_object('receipt_kind','WORK_CLAIM_EXEMPTION_GRANTED','task_id',v_task.id,'extra_claims',5,
        'granted_at',v_now,'expires_at',v_now+interval '24 hours','reason',v_token.native_choices->>'reason',
        'token_id',v_token.id,'view_digest',v_token.view_digest,'session_id',v_token.session_id,
        'principal','native_account_session'))
    returning id into v_receipt;
    insert into clued_private.work_claim_exemptions_v1(user_id,task_id,extra_claims,reason,granted_at,expires_at,
      token_id,receipt_id,granted_session_id)
    values(p_user_id,v_task.id,5,v_token.native_choices->>'reason',v_now,v_now+interval '24 hours',
      v_token.id,v_receipt,v_token.session_id)
    returning * into v_exemption;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'exemption',jsonb_build_object('exemption_id',v_exemption.id,'task_id',v_exemption.task_id,
        'extra_claims',v_exemption.extra_claims,'granted_at',v_exemption.granted_at,
        'expires_at',v_exemption.expires_at),
      'task_status',clued_private.work_claim_exemption_status_v1(p_user_id,v_task.id));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt. The
    -- block's subtransaction rolled back, so these writes persist.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(p_user_id,null,'global','work_claim_exemption_grant','work_claim_exemption',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','WORK_CLAIM_EXEMPTION_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),
        consumed_receipt_id=v_receipt,consume_outcome='rejected'
        where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

revoke all on function clued_private.work_claim_exemption_immutable_v1(),
  clued_private.work_claim_exemption_view_v1(public.clued_memories,text),
  clued_private.work_claim_exemption_status_v1(uuid,uuid),
  clued_private.work_claim_exemption_issue_core_v1(uuid,jsonb),
  clued_private.work_claim_exemption_grant_core_v1(uuid,jsonb)
  from public,anon,authenticated,service_role;

create function public.clued_work_claim_exemption_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_work_claim_exemption_input' using errcode='22023';
  end if;
  perform clued_private.work_claim_lock(v_owner);
  return clued_private.work_claim_exemption_issue_core_v1(v_owner,p_input);
end $$;

create function public.clued_work_claim_exemption_grant_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_work_claim_exemption_input' using errcode='22023';
  end if;
  -- Same lock as a claim, so a grant and a claim of the Task serialize.
  perform clued_private.work_claim_lock(v_owner);
  return clued_private.work_claim_exemption_grant_core_v1(v_owner,p_input);
end $$;

revoke all on function public.clued_work_claim_exemption_confirmation_issue_v1(jsonb),
  public.clued_work_claim_exemption_grant_v1(jsonb)
  from public,anon,service_role;
grant execute on function public.clued_work_claim_exemption_confirmation_issue_v1(jsonb),
  public.clued_work_claim_exemption_grant_v1(jsonb)
  to authenticated;

-- work_claim_issue: unchanged from 20261002150000 except that, over the
-- per-Task cap, a valid exemption with allowance left admits the claim, the
-- claim's Receipt names that exemption, and a refusal names the page where the
-- Owner can grant one (owner_exemption_path).
create or replace function clued_private.work_claim_issue(
  p_binding public.clued_agent_bindings,p_input jsonb,p_task public.clued_memories,
  p_supersedes clued_private.work_claims_v1,p_operation text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_profile jsonb:=clued_private.work_claim_profile_v1();
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_active integer;
  v_fence bigint; v_lease interval; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_claim clued_private.work_claims_v1%rowtype; v_receipt uuid; v_budget jsonb;
  v_session text:=nullif(btrim(coalesce(p_input->>'holder_session_ref','')),'');
  v_base text:=nullif(btrim(coalesce(p_input->>'base_commit','')),'');
  v_lease_seconds integer; v_active_session integer; v_recent integer; v_retry_after timestamptz;
  v_exemption_id uuid;
begin
  if p_input ? 'write_set' then
    v_write_set:=clued_private.work_claim_normalize_paths(p_input->'write_set');
  elsif p_supersedes.claim_id is not null then
    v_write_set:=p_supersedes.write_set;
  else
    raise exception 'work_claim_write_set_invalid' using errcode='22023';
  end if;
  if p_input ? 'trigger_refs' then
    v_triggers:=clued_private.work_claim_normalize_triggers(p_input->'trigger_refs');
  elsif p_supersedes.claim_id is not null then
    v_triggers:=p_supersedes.trigger_refs;
  else
    v_triggers:='{}'::text[];
  end if;
  if v_base is not null and v_base !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_base_commit_invalid' using errcode='22023'; end if;
  v_lease_seconds:=coalesce((p_input->>'lease_seconds')::integer,(v_profile->>'lease_seconds')::integer);
  if v_lease_seconds<60 or v_lease_seconds>(v_profile->>'lease_seconds')::integer then
    raise exception 'work_claim_lease_seconds_invalid' using errcode='22023'; end if;
  v_lease:=make_interval(secs=>v_lease_seconds);
  v_budget:=coalesce(p_input->'budget','{}'::jsonb);
  if jsonb_typeof(v_budget)<>'object' then
    raise exception 'work_claim_budget_invalid' using errcode='22023'; end if;

  v_conflicts:=clued_private.work_claim_conflicts(p_binding.user_id,p_task.id,v_write_set,
    v_triggers,p_supersedes.claim_id);
  if jsonb_array_length(v_conflicts)>0 then
    return clued_private.work_claim_rejected('work_claim_conflict',
      jsonb_build_object('conflicts',v_conflicts,'task_id',p_task.id,
        'write_set',to_jsonb(v_write_set),'trigger_refs',to_jsonb(v_triggers)));
  end if;
  -- One session (holder_session_ref, as the Agent declares it; claims without
  -- one share a group) holds at most max_active_per_session live claims, and
  -- all sessions of one Binding together at most max_active_per_binding.
  select count(*)::integer,
         count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,''))::integer
    into v_active,v_active_session from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.holder_binding_id=p_binding.id
      and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now;
  if v_active_session>=(v_profile->>'max_active_per_session')::integer then
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_session',
        'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,
        'active',v_active_session,'active_binding',v_active,'holder_session_ref',v_session));
  end if;
  if v_active>=(v_profile->>'max_active_per_binding')::integer then
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_binding',
        'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,
        'active',v_active,'active_session',v_active_session));
  end if;

  -- attempts_cap (Owner Decision a264ea02): one Task gets at most
  -- max_claims_per_task_24h new claims or takeovers in any 24 hours, so a
  -- runaway claim/release loop stops instead of spending without end.
  select count(*)::integer into v_recent
    from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id
      and w.issued_at>v_now-interval '24 hours';
  if v_recent>=(v_profile->>'max_claims_per_task_24h')::integer then
    -- An Owner exemption (20261002190000) admits up to extra_claims new
    -- claims or takeovers issued after it was granted, while it is valid.
    select e.id into v_exemption_id from clued_private.work_claim_exemptions_v1 e
      where e.user_id=p_binding.user_id and e.task_id=p_task.id and e.expires_at>v_now
        and (select count(*) from clued_private.work_claims_v1 w
              where w.user_id=e.user_id and w.task_id=e.task_id and w.issued_at>=e.granted_at)<e.extra_claims
      order by e.granted_at limit 1;
  end if;
  if v_recent>=(v_profile->>'max_claims_per_task_24h')::integer and v_exemption_id is null then
    -- A new claim is admitted once fewer than the cap remain in the window:
    -- the (claims_last_24h - cap + 1)-th oldest claim has to age out, not
    -- only the oldest one.
    select w.issued_at+interval '24 hours' into v_retry_after
      from clued_private.work_claims_v1 w
      where w.user_id=p_binding.user_id and w.task_id=p_task.id
        and w.issued_at>v_now-interval '24 hours'
      order by w.issued_at
      offset v_recent-(v_profile->>'max_claims_per_task_24h')::integer limit 1;
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_claims_per_task_24h',
        'max_claims_per_task_24h',(v_profile->>'max_claims_per_task_24h')::integer,
        'claims_last_24h',v_recent,'task_id',p_task.id,
        'retry_after',v_retry_after,
        -- Where the Owner can grant an exemption; an Agent cannot.
        'owner_exemption_path','/work-claims/exemption?task='||p_task.id::text
          ||'&scope='||p_task.canonical_scope));
  end if;

  select coalesce(max(w.fence),0)+1 into v_fence from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id;
  insert into clued_private.work_claims_v1(user_id,task_id,context_key,holder_binding_id,
    holder_session_ref,base_commit,write_set,trigger_refs,fence,lease_version,issued_at,
    expires_at,hard_deadline_at,budget,status,idempotency_key)
  values(p_binding.user_id,p_task.id,p_task.canonical_scope,p_binding.id,v_session,v_base,
    v_write_set,v_triggers,v_fence,1,v_now,v_now+v_lease,
    v_now+make_interval(secs=>(v_profile->>'hard_deadline_seconds')::integer),
    v_budget||jsonb_build_object('profile_id',v_profile->>'profile_id'),'ACTIVE',
    p_input->>'idempotency_key')
  returning * into v_claim;
  if p_supersedes.claim_id is not null then
    update clued_private.work_claims_v1 set status='SUPERSEDED',superseded_by=v_claim.claim_id,
      updated_at=v_now where claim_id=p_supersedes.claim_id;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,p_task.canonical_scope,p_operation,'work_claim',
    v_claim.claim_id::text,v_claim.fence,jsonb_build_object(
      'receipt_kind',case p_operation when 'work_claim' then 'WORK_CLAIM_ISSUED'
        else 'WORK_CLAIM_TAKEOVER' end,
      'claim_id',v_claim.claim_id,'task_id',v_claim.task_id,'fence',v_claim.fence,
      'lease_version',v_claim.lease_version,'write_set',to_jsonb(v_claim.write_set),
      'trigger_refs',to_jsonb(v_claim.trigger_refs),'base_commit',v_claim.base_commit,
      'expires_at',v_claim.expires_at,'hard_deadline_at',v_claim.hard_deadline_at,
      'supersedes',p_supersedes.claim_id,'superseded_fence',p_supersedes.fence,
      'idempotency_key',p_input->>'idempotency_key','profile',v_profile)
      ||case when v_exemption_id is null then '{}'::jsonb
        else jsonb_build_object('exemption_id',v_exemption_id) end)
  returning id into v_receipt;
  update clued_private.work_claims_v1 set receipt_id=v_receipt where claim_id=v_claim.claim_id
    returning * into v_claim;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(v_claim));
end $$;

notify pgrst,'reload schema';
