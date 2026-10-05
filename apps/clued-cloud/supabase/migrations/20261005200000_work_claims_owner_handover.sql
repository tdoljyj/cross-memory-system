-- Work Claims: who holds what, and the Owner's "hand over to a new session"
-- (Task f165eb56, PR 2; Owner Decisions 22b9bd9e and 4bcc424d; design Note 3ad61f76).
--
-- 1. What the Agent says about itself (Decision 4bcc424d v2), all self-reported
--    and never checked: holder_client (Claude Code, Codex, ChatGPT…),
--    holder_session_title, and holder_label, one line for people (what it is
--    doing, which machine). clued_work_claim, clued_work_takeover and
--    clued_work_renew accept them; they are part of work_claim_view, so every
--    Binding of the account sees them. holder_session_ref stays the client's
--    own session id.
-- 2. clued_work_claims_owner_list_v1: the signed-in Owner's live claims, and
--    on request those that ended in the last hours, with the Task title and
--    scope, the holder's connection name and self-report, session (a link for
--    a Claude Code session_… ref), claim time, expiry, hard deadline,
--    renewals of the profile maximum, last progress, bound pull request,
--    trigger refs, write set and state. Native only (authorization_owner_v12),
--    volatile like the other Owner reads; it never writes.
-- 3. Handover, two Native steps like the race page:
--    clued_work_claim_handover_confirmation_issue_v1 renders the claim, then
--    clued_work_claim_handover_v1 consumes the single-use confirmation and
--      * moves the fence past every fence of the Task, so a renew or release
--        with the stuck session's fence is refused;
--      * rotates the lease key and returns it once (only its hash is stored);
--      * marks the claim lease_key_required: from then on every renew and
--        release must present the current key, even from the holder Binding,
--        because the Owner's Claude Code sessions share one Binding;
--      * restarts the lease (within the hard deadline) so the new session has
--        time to take over, without counting a renewal.
--    The new session renews with claim_id, fence, lease_version and the key;
--    from another Binding that renewal moves the claim to it (20261005190000).
--    The Receipt WORK_CLAIM_HANDOVER records the old and new fence, never the key.
--    Limits: the claim id does not change, so pull request admission
--    (clued_work_verify) still admits the stuck session's pull request, and a
--    storage write that presents the claim with its new fence is not asked for
--    the key. A replay of the original claim or takeover by the holder Binding
--    is refused with work_claim_lease_key_required instead of minting a key.
--    The new session's holder_session_ref is recorded when it renews with the
--    key, on the same Binding too. A claim with no renewal left, or within 10
--    minutes of its hard deadline, cannot be handed over.
--    A replayed step 2 cannot show the key again: the Owner hands over anew.
-- A claim without lease_key_required behaves as before.

alter table clued_private.work_claims_v1
  add column holder_label text check (holder_label is null or char_length(holder_label) between 1 and 200),
  add column holder_client text check (holder_client is null or char_length(holder_client) between 1 and 80),
  add column holder_session_title text check (holder_session_title is null or char_length(holder_session_title) between 1 and 200),
  add column lease_key_required boolean not null default false;

-- One self-reported text field from an input, or null when absent; an invalid
-- value is refused with work_claim_<field>_invalid.
create function clued_private.work_claim_self_report_v1(p_input jsonb,p_field text,p_max integer) returns text
language plpgsql immutable set search_path='' as $$
declare v text;
begin
  if not (p_input ? p_field) or p_input->p_field='null'::jsonb then return null; end if;
  if jsonb_typeof(p_input->p_field)<>'string' then
    raise exception '%', 'work_claim_'||p_field||'_invalid' using errcode='22023'; end if;
  v:=nullif(btrim(p_input->>p_field),'');
  -- Control and invisible format characters (bidi overrides, zero-width) are refused.
  if v is null or char_length(v)>p_max or v ~ '[[:cntrl:]\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]' then
    raise exception '%', 'work_claim_'||p_field||'_invalid' using errcode='22023'; end if;
  return v;
end $$;

-- work_claim_view: 20261003120000 plus holder_label and lease_key_required.
create or replace function clued_private.work_claim_view(c clued_private.work_claims_v1) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
    'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
    'holder_label',c.holder_label,'holder_client',c.holder_client,'holder_session_title',c.holder_session_title,
    'base_commit',c.base_commit,'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs),
    'fence',c.fence,'lease_version',c.lease_version,'issued_at',c.issued_at,
    'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'renewals',c.renewals,
    'progress_ref',c.progress_ref,'budget',c.budget,'status',c.status,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'receipt_id',c.receipt_id,
    'bound_pr',c.bound_pr,'copy_index',c.copy_index,'outcome',c.outcome,
    'lease_key_required',c.lease_key_required)
$$;

-- work_claim_lease_access_v1: 20261005190000 plus lease_key_required. On a
-- live claim that requires the key, the holder Binding without a key is
-- refused with work_claim_lease_key_required.
create or replace function clued_private.work_claim_lease_access_v1(c clued_private.work_claims_v1,
  p_binding_id uuid,p_input jsonb) returns text
language sql stable set search_path='' as $$
  with k as (select case when p_input ? 'lease_key' and p_input->>'lease_key' is not null
    then clued_private.work_claim_lease_key_hash_v1(p_input->>'lease_key') end h)
  select case
    when c.holder_binding_id=p_binding_id then
      case when c.status not in ('ACTIVE','DRAINING') or c.lease_key_hash is null then 'holder'
        when k.h is null then case when c.lease_key_required then 'work_claim_lease_key_required' else 'holder' end
        when k.h<>c.lease_key_hash then 'work_claim_lease_key_invalid'
        else 'holder' end
    when k.h is not null and k.h=c.lease_key_hash then 'key'
    else 'work_claim_not_holder' end
  from k
$$;

-- What the Owner sees of one claim. state is the effective one: a live claim
-- past its expiry reads EXPIRED even before a write persists it.
create function clued_private.work_claim_owner_row_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,
    'task_title',(select m.title from public.clued_memories m where m.id=c.task_id and m.user_id=c.user_id),
    'context_key',c.context_key,'status',c.status,'state',x.state,'ended_at',x.ended_at,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'outcome',c.outcome,
    'fence',c.fence,'lease_version',c.lease_version,
    'issued_at',c.issued_at,'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,
    'renewals',c.renewals,'max_renewals',(clued_private.work_claim_profile_v1()->>'max_renewals')::integer,
    'progress_ref',c.progress_ref,'bound_pr',c.bound_pr,'copy_index',c.copy_index,
    'trigger_refs',to_jsonb(c.trigger_refs),'write_set',to_jsonb(c.write_set),
    'holder_label',c.holder_label,'holder_client',c.holder_client,'holder_session_title',c.holder_session_title,
    'holder_session_ref',c.holder_session_ref,
    'holder_session_url',case when c.holder_session_ref ~ '^session_[A-Za-z0-9]{8,64}$'
      then 'https://claude.ai/code/'||c.holder_session_ref end,
    'holder_binding_id',c.holder_binding_id,
    'holder_name',b.agent_name,'holder_vendor',b.vendor,
    'holder_connection_live',coalesce(clued_private.binding_live_v1(b),false),
    'lease_key_required',c.lease_key_required,
    'handover_available',x.state='ACTIVE' and c.lease_key_hash is not null)
  from (select case when c.status in ('ACTIVE','DRAINING') and c.expires_at<=pg_catalog.clock_timestamp() then 'EXPIRED'
      else c.status end state,
    case when c.status in ('ACTIVE','DRAINING') and c.expires_at>pg_catalog.clock_timestamp() then null
      when c.status in ('ACTIVE','DRAINING','EXPIRED') then c.expires_at else c.updated_at end ended_at) x
  left join public.clued_agent_bindings b on b.id=c.holder_binding_id
$$;

create function public.clued_work_claims_owner_list_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_input jsonb:=coalesce(p_input,'{}'::jsonb); v_hours integer;
begin
  if jsonb_typeof(v_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(v_input) k where k<>'ended_within_hours')
      or (v_input ? 'ended_within_hours' and (jsonb_typeof(v_input->'ended_within_hours') is distinct from 'number'
        or (v_input->>'ended_within_hours') !~ '^[0-9]{1,3}$'
        or (v_input->>'ended_within_hours')::integer not between 1 and 168)) then
    return jsonb_build_object('status','rejected','error_code','work_claim_owner_list_input_invalid'); end if;
  v_hours:=(v_input->>'ended_within_hours')::integer;
  return jsonb_build_object('status','ok','observed_at',v_now,
    'claims',coalesce((select jsonb_agg(clued_private.work_claim_owner_row_v1(w) order by w.expires_at,w.claim_id)
      from clued_private.work_claims_v1 w
      where w.user_id=v_owner and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now),'[]'::jsonb),
    'ended',case when v_hours is null then '[]'::jsonb else coalesce((select jsonb_agg(r order by r->>'ended_at' desc)
      from (select clued_private.work_claim_owner_row_v1(w) r from clued_private.work_claims_v1 w
        where w.user_id=v_owner and not (w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now)
          and (case when w.status in ('ACTIVE','DRAINING','EXPIRED') then w.expires_at else w.updated_at end)
            >v_now-make_interval(hours=>v_hours)
        order by case when w.status in ('ACTIVE','DRAINING','EXPIRED') then w.expires_at else w.updated_at end desc
        limit 100) e),'[]'::jsonb) end);
end $$;

-- The confirmation view of a handover: what the Owner checks, without the
-- lease clock, so the stuck session's own renewals do not stale it.
create function clued_private.work_claim_handover_view_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('claim_id',r->'claim_id','task_id',r->'task_id','task_title',r->'task_title',
    'context_key',r->'context_key','fence',r->'fence','write_set',r->'write_set','bound_pr',r->'bound_pr',
    'holder_name',r->'holder_name','holder_vendor',r->'holder_vendor','holder_label',r->'holder_label',
    'holder_session_ref',r->'holder_session_ref','holder_binding_id',r->'holder_binding_id')
  from (select clued_private.work_claim_owner_row_v1(c) r) x
$$;

-- The new session takes over by renewing, so a claim with no renewal left, or
-- within 10 minutes of its hard deadline, cannot be handed over: release it
-- and claim again instead.
create function clued_private.work_claim_handover_renewable_v1(c clued_private.work_claims_v1) returns void
language plpgsql stable set search_path='' as $$
begin
  if c.renewals>=(clued_private.work_claim_profile_v1()->>'max_renewals')::integer
      or c.hard_deadline_at<=pg_catalog.clock_timestamp()+interval '10 minutes' then
    raise exception 'work_claim_handover_no_renewal_left' using errcode='55000'; end if;
end $$;

-- Step 1. Input {claim_id}.
create function public.clued_work_claim_handover_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); c clued_private.work_claims_v1%rowtype;
  v_view jsonb; v_digest text; v_raw text; v_token_id uuid; v_expires timestamptz; v_now timestamptz; v_error text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k<>'claim_id') then
      raise exception 'work_claim_handover_input_invalid' using errcode='22023'; end if;
    if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
    perform clued_private.work_claim_lock(v_owner);
    perform clued_private.work_claim_expire_due(v_owner);
    select * into c from clued_private.work_claims_v1 w
      where w.user_id=v_owner and w.claim_id=(p_input->>'claim_id')::uuid;
    if not found then raise exception 'work_claim_not_found' using errcode='22023'; end if;
    if c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then
      raise exception 'work_claim_not_active' using errcode='55000'; end if;
    if c.lease_key_hash is null then raise exception 'work_claim_handover_unavailable' using errcode='55000'; end if;
    perform clued_private.work_claim_handover_renewable_v1(c);
    v_view:=clued_private.work_claim_handover_view_v1(c);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='work_claim_handover' and subject_key=c.claim_id::text
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_wch_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'work_claim_handover',c.claim_id::text,c.fence,jsonb_build_object('claim_id',c.claim_id),
      v_view,v_digest,encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),
      clued_private.native_session_id_v1(),coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '23514' or sqlstate '42501' or sqlstate '55000' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2. Input {confirmation_token, view_digest}.
create function public.clued_work_claim_handover_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; c clued_private.work_claims_v1%rowtype; v_old_fence bigint; v_fence bigint;
  v_profile jsonb:=clued_private.work_claim_profile_v1(); v_receipt uuid; v_now timestamptz; v_key text;
  v_error text; v_state text; r record;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'work_claim_handover_input_invalid' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    perform clued_private.work_claim_lock(v_owner);
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='work_claim_handover' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      -- The key was shown once; it is not stored and cannot be shown again.
      select * into r from public.clued_audit_receipts a where a.id=v_token.consumed_receipt_id;
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_token.consumed_receipt_id,
        'lease_key',null,'handover',r.metadata-'token_id');
    end if;
    if v_token.consumed_at is not null then raise exception 'confirmation_token_reused' using errcode='42501'; end if;
    if v_token.revoked_at is not null then raise exception 'confirmation_token_revoked' using errcode='42501'; end if;
    v_token_id:=v_token.id;
    if v_token.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    if v_token.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_same_request' using errcode='42501'; end if;
    if coalesce(p_input->>'view_digest','')<>v_token.view_digest
      or v_token.session_id is null or clued_private.native_session_id_v1() is null
      or v_token.session_id<>clued_private.native_session_id_v1() then
      raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    perform clued_private.work_claim_expire_due(v_owner);
    select * into c from clued_private.work_claims_v1 w
      where w.user_id=v_owner and w.claim_id=(v_token.native_choices->>'claim_id')::uuid for update;
    if not found then raise exception 'work_claim_not_found' using errcode='22023'; end if;
    if c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then
      raise exception 'work_claim_not_active' using errcode='55000'; end if;
    if c.lease_key_hash is null then raise exception 'work_claim_handover_unavailable' using errcode='55000'; end if;
    perform clued_private.work_claim_handover_renewable_v1(c);
    if clued_private.m1_sha256(clued_private.work_claim_handover_view_v1(c))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    v_old_fence:=c.fence;
    select max(w.fence)+1 into v_fence from clued_private.work_claims_v1 w
      where w.user_id=v_owner and w.task_id=c.task_id;
    update clued_private.work_claims_v1 set fence=v_fence,lease_version=lease_version+1,lease_key_required=true,
      expires_at=least(v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer),hard_deadline_at),
      updated_at=v_now
      where claim_id=c.claim_id returning * into c;
    v_key:=clued_private.work_claim_lease_key_issue_v1(c.claim_id);
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,c.context_key,'work_claim_handover','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('receipt_kind','WORK_CLAIM_HANDOVER','claim_id',c.claim_id,'task_id',c.task_id,
        'previous_fence',v_old_fence,'fence',c.fence,'lease_version',c.lease_version,'expires_at',c.expires_at,
        'holder_binding_id',c.holder_binding_id,'lease_key_required',true,'token_id',v_token.id,
        'view_digest',v_token.view_digest,'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,'lease_key',v_key,
      'claim',clued_private.work_claim_owner_row_v1(c));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','work_claim_handover','work_claim',v_token.subject_key,1,
        jsonb_build_object('receipt_kind','WORK_CLAIM_HANDOVER_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','23514','40001','42501','55000')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- clued_work_claim_v1, clued_work_takeover_v1 and clued_work_renew_v1:
-- 20261005190000 with holder_label stored (and, on renew, replaced when sent).
create or replace function public.clued_work_claim_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_task public.clued_memories%rowtype;
  v_existing clued_private.work_claims_v1%rowtype; v_none clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_hash text; v_result jsonb;
  v_label text:=clued_private.work_claim_self_report_v1(p_input,'holder_label',200);
  v_client text:=clued_private.work_claim_self_report_v1(p_input,'holder_client',80);
  v_title text:=clued_private.work_claim_self_report_v1(p_input,'holder_session_title',200);
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  v_hash:=clued_private.work_claim_request_hash('work_claim',p_input);
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into v_existing from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.idempotency_key=p_input->>'idempotency_key'
      and (w.holder_binding_id=v_binding.id or w.issued_binding_id=v_binding.id)
    order by (w.holder_binding_id=v_binding.id) desc,w.issued_at desc limit 1;
  if found and v_existing.holder_binding_id<>v_binding.id then
    -- Issued here, since moved to another Binding with its key.
    return clued_private.work_claim_reject_log_v1(v_binding,v_existing.context_key,v_existing.task_id,
      v_existing.claim_id,'work_claim','work_claim_idempotency_spent',
      jsonb_build_object('claim',clued_private.work_claim_view(v_existing),'transferred',true)); end if;
  if found and v_existing.lease_key_required and v_existing.status in ('ACTIVE','DRAINING') then
    -- Handed over by the Owner: a replay must not mint a key that displaces the new session's.
    return clued_private.work_claim_reject_log_v1(v_binding,v_existing.context_key,v_existing.task_id,
      v_existing.claim_id,'work_claim','work_claim_lease_key_required',
      jsonb_build_object('claim',clued_private.work_claim_view(v_existing))); end if;
  if found then
    return clued_private.work_claim_with_lease_key_v1(
      clued_private.work_claim_replay_logged_v1(v_binding,v_existing,v_hash,'work_claim')); end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,p_input->>'task_id');
  v_result:=clued_private.work_claim_issue(v_binding,p_input,v_task,v_none,'work_claim');
  if v_result->>'status'='committed' then
    update clued_private.work_claims_v1 set request_hash=v_hash,issued_binding_id=v_binding.id,holder_label=v_label,
        holder_client=v_client,holder_session_title=v_title
      where claim_id=(v_result#>>'{claim,claim_id}')::uuid returning * into v_existing;
    v_result:=v_result||jsonb_build_object('claim',clued_private.work_claim_view(v_existing));
  end if;
  return clued_private.work_claim_with_lease_key_v1(v_result);
end $$;

create or replace function public.clued_work_takeover_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_old clued_private.work_claims_v1%rowtype;
  v_existing clued_private.work_claims_v1%rowtype; v_task public.clued_memories%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_hash text; v_result jsonb;
  v_label text:=clued_private.work_claim_self_report_v1(p_input,'holder_label',200);
  v_client text:=clued_private.work_claim_self_report_v1(p_input,'holder_client',80);
  v_title text:=clued_private.work_claim_self_report_v1(p_input,'holder_session_title',200);
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  v_hash:=clued_private.work_claim_request_hash('work_claim_takeover',p_input);
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into v_existing from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.idempotency_key=p_input->>'idempotency_key'
      and (w.holder_binding_id=v_binding.id or w.issued_binding_id=v_binding.id)
    order by (w.holder_binding_id=v_binding.id) desc,w.issued_at desc limit 1;
  if found and v_existing.holder_binding_id<>v_binding.id then
    -- Issued here, since moved to another Binding with its key.
    return clued_private.work_claim_reject_log_v1(v_binding,v_existing.context_key,v_existing.task_id,
      v_existing.claim_id,'work_claim_takeover','work_claim_idempotency_spent',
      jsonb_build_object('claim',clued_private.work_claim_view(v_existing),'transferred',true)); end if;
  if found and v_existing.lease_key_required and v_existing.status in ('ACTIVE','DRAINING') then
    -- Handed over by the Owner: a replay must not mint a key that displaces the new session's.
    return clued_private.work_claim_reject_log_v1(v_binding,v_existing.context_key,v_existing.task_id,
      v_existing.claim_id,'work_claim_takeover','work_claim_lease_key_required',
      jsonb_build_object('claim',clued_private.work_claim_view(v_existing))); end if;
  if found then
    return clued_private.work_claim_with_lease_key_v1(
      clued_private.work_claim_replay_logged_v1(v_binding,v_existing,v_hash,'work_claim_takeover')); end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into v_old from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,null,(p_input->>'claim_id')::uuid,
      'work_claim_takeover','work_claim_not_found',null); end if;
  if v_old.status in ('RELEASED','SUPERSEDED') then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,v_old.task_id,v_old.claim_id,
      'work_claim_takeover','work_claim_not_takeover_eligible',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  if v_old.status in ('ACTIVE','DRAINING') and v_old.expires_at>pg_catalog.clock_timestamp() then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,v_old.task_id,v_old.claim_id,
      'work_claim_takeover','work_claim_still_active',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,v_old.task_id::text);
  v_result:=clued_private.work_claim_issue(v_binding,p_input,v_task,v_old,'work_claim_takeover');
  if v_result->>'status'='committed' then
    update clued_private.work_claims_v1 set request_hash=v_hash,issued_binding_id=v_binding.id,holder_label=v_label,
        holder_client=v_client,holder_session_title=v_title
      where claim_id=(v_result#>>'{claim,claim_id}')::uuid returning * into v_existing;
    v_result:=v_result||jsonb_build_object('claim',clued_private.work_claim_view(v_existing));
    -- The replaced claim's key is spent.
    update clued_private.work_claims_v1 set lease_key_hash=null where claim_id=v_old.claim_id;
  end if;
  return clued_private.work_claim_with_lease_key_v1(v_result);
end $$;

create or replace function public.clued_work_renew_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_profile jsonb:=clued_private.work_claim_profile_v1(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_scope text:=coalesce(p_input->>'scope','global'); v_progress text; v_claim_id uuid;
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_receipt uuid; v_expires timestamptz;
  v_access text; v_from uuid; v_session text; v_active integer; v_active_session integer;
  v_label text:=clued_private.work_claim_self_report_v1(p_input,'holder_label',200);
  v_client text:=clued_private.work_claim_self_report_v1(p_input,'holder_client',80);
  v_title text:=clued_private.work_claim_self_report_v1(p_input,'holder_session_title',200);
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  v_claim_id:=(p_input->>'claim_id')::uuid;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=v_claim_id and w.context_key=v_scope for update;
  if not found then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,null,v_claim_id,
      'work_claim_renew','work_claim_not_found',null); end if;
  v_access:=clued_private.work_claim_lease_access_v1(c,v_binding.id,p_input);
  if v_access not in ('holder','key') then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew',v_access,
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status='EXPIRED' then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_expired',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status<>'ACTIVE' then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_not_active',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if (p_input->>'fence')::bigint is distinct from c.fence then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_fence_mismatch',
      jsonb_build_object('expected_fence',c.fence)); end if;
  if (p_input->>'lease_version')::bigint is distinct from c.lease_version then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_version_conflict',
      jsonb_build_object('expected_lease_version',c.lease_version)); end if;
  v_progress:=nullif(btrim(coalesce(p_input->>'progress_ref','')),'');
  if v_progress is null or v_progress is not distinct from c.progress_ref
      or v_progress=any(c.progress_refs) then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_no_progress',
      jsonb_build_object('last_progress_ref',c.progress_ref,'used_progress_refs',to_jsonb(c.progress_refs))); end if;
  if c.renewals>=(v_profile->>'max_renewals')::integer then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_renewal_budget_exhausted',
      jsonb_build_object('max_renewals',(v_profile->>'max_renewals')::integer,'renewals',c.renewals)); end if;
  if c.expires_at>=c.hard_deadline_at then
    return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
      'work_claim_renew','work_claim_hard_deadline',
      jsonb_build_object('hard_deadline_at',c.hard_deadline_at)); end if;

  v_write_set:=case when p_input ? 'write_set'
    then clued_private.work_claim_normalize_paths(p_input->'write_set') else c.write_set end;
  v_triggers:=case when p_input ? 'trigger_refs'
    then clued_private.work_claim_normalize_triggers(p_input->'trigger_refs') else c.trigger_refs end;
  if v_write_set<>c.write_set or v_triggers<>c.trigger_refs then
    v_conflicts:=clued_private.work_claim_conflicts(v_binding.user_id,c.task_id,v_write_set,v_triggers,c.claim_id);
    if jsonb_array_length(v_conflicts)>0 then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_conflict',
        jsonb_build_object('conflicts',v_conflicts,'write_set',to_jsonb(v_write_set),
          'trigger_refs',to_jsonb(v_triggers)));
    end if;
  end if;

  v_session:=nullif(btrim(coalesce(p_input->>'holder_session_ref','')),'');
  if v_access='key' then
    -- The receiving Binding's caps apply as at a new claim.
    select count(*)::integer,
           count(*) filter (where coalesce(w.holder_session_ref,'')=coalesce(v_session,''))::integer
      into v_active,v_active_session from clued_private.work_claims_v1 w
      where w.user_id=v_binding.user_id and w.holder_binding_id=v_binding.id
        and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now;
    if v_active_session>=(v_profile->>'max_active_per_session')::integer then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_budget_exhausted',
        jsonb_build_object('limit','max_active_per_session',
          'max_active_per_session',(v_profile->>'max_active_per_session')::integer,
          'active',v_active_session,'holder_session_ref',v_session)); end if;
    if v_active>=(v_profile->>'max_active_per_binding')::integer then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_budget_exhausted',
        jsonb_build_object('limit','max_active_per_binding',
          'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,'active',v_active)); end if;
    -- Idempotency keys are unique per holder Binding.
    if exists(select 1 from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
        and w.holder_binding_id=v_binding.id and w.idempotency_key=c.idempotency_key) then
      return clued_private.work_claim_reject_log_v1(v_binding,v_scope,c.task_id,c.claim_id,
        'work_claim_renew','work_claim_idempotency_conflict',
        jsonb_build_object('claim_id',c.claim_id)); end if;
    v_from:=c.holder_binding_id;
  end if;

  v_expires:=least(v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer),c.hard_deadline_at);
  update clued_private.work_claims_v1 set lease_version=lease_version+1,renewals=renewals+1,
    expires_at=v_expires,progress_ref=v_progress,
    progress_refs=progress_refs||case when c.progress_ref is null or c.progress_ref=any(progress_refs)
      then array[v_progress] else array[c.progress_ref,v_progress] end,
    write_set=v_write_set,trigger_refs=v_triggers,
    holder_binding_id=v_binding.id,
    -- A new session that holds a handed-over claim's key names itself, on the same Binding too.
    holder_session_ref=case when v_from is not null then v_session
      when c.lease_key_required and p_input ? 'holder_session_ref' then v_session else holder_session_ref end,
    holder_label=case when p_input ? 'holder_label' then v_label else holder_label end,
    holder_client=case when p_input ? 'holder_client' then v_client else holder_client end,
    holder_session_title=case when p_input ? 'holder_session_title' then v_title else holder_session_title end,
    updated_at=v_now where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_renew','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_RENEWED',
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,
      'renewals',c.renewals,'progress_ref',c.progress_ref,'expires_at',c.expires_at,
      'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs))
      ||case when v_from is null then '{}'::jsonb
        else jsonb_build_object('via_lease_key',true,'transferred_from_binding',v_from) end)
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c))
    ||case when v_from is null then '{}'::jsonb else jsonb_build_object('transferred',true,
      'lease_key',clued_private.work_claim_lease_key_issue_v1(c.claim_id)) end;
end $$;

revoke all on function
  clued_private.work_claim_self_report_v1(jsonb,text,integer),
  clued_private.work_claim_owner_row_v1(clued_private.work_claims_v1),
  clued_private.work_claim_handover_view_v1(clued_private.work_claims_v1),
  clued_private.work_claim_handover_renewable_v1(clued_private.work_claims_v1)
  from public,anon,authenticated,service_role;
revoke all on function
  public.clued_work_claims_owner_list_v1(jsonb),
  public.clued_work_claim_handover_confirmation_issue_v1(jsonb),
  public.clued_work_claim_handover_v1(jsonb),
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function
  public.clued_work_claims_owner_list_v1(jsonb),
  public.clued_work_claim_handover_confirmation_issue_v1(jsonb),
  public.clued_work_claim_handover_v1(jsonb)
  to authenticated;
grant execute on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb)
  to anon;

notify pgrst,'reload schema';
