-- Owner Credential v0.1, auto-approval switch (OwnerCredential.v0.1.md §12;
-- Owner Decision 5ce219c6, Task 8eb340c7).
--
-- The Owner turns the switch on from the signed-in /grants page (Native
-- two-step confirmation, like any grant) for a chosen time: default 24 hours,
-- at most 7 days. While it is on, every Owner Request opened for one of the
-- actions the Owner chose (below) is approved at once, in the same
-- transaction that opens it, and the caller gets the decided request back with
-- its grant as the receipt. Turning the switch on is the Owner's own approval
-- given ahead of time; an Agent still cannot turn it on, approve or widen
-- anything (§3.2 unchanged).
--
-- Where a request is opened:
-- - clued_owner_request_v1 (an Agent asks; bundles call it per member);
-- - the release door, for release.production and migration.production;
-- - the admission door, for repo.protected_change;
-- - work_claim_issue, for work_claim.extra_claims.
-- Each door then consumes the new grant in the same call, so the run or the
-- claim goes ahead without a second attempt.
--
-- What an automatic grant gives is what the confirmation page would open on
-- (default by risk, 20261004130000): a high-risk action is approved once (one
-- use, 24 hours); a routine one gets the Agent's suggested duration and uses
-- (else 4 hours). It goes to the Binding that opened the request, covers only
-- the requested resources and never outlives the switch's planned end.
-- Only the actions the Owner chose are approved automatically
-- (owner_grant_actions.auto_approvable): release.production,
-- migration.production, repo.protected_change and work_claim.extra_claims.
-- connection.permission never is: it widens the connection itself and outlives
-- the switch (Decision 5ce219c6). The model.dataset_split.* actions are not
-- either: their door accepts only a grant the Owner confirmed on the page. An
-- action registered later is not automatic until the Owner adds it.
--
-- Turning the switch off is one step (it only takes permission away, like
-- revoking a grant). It stops new automatic approvals; grants already given
-- stay on /grants until they expire or the Owner revokes them.
--
-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.

create table clued_private.owner_auto_approve_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  turned_on_at timestamptz not null,
  expires_at timestamptz not null,
  turned_off_at timestamptz,
  token_id uuid not null unique references clued_private.native_confirmation_tokens(id),
  receipt_id uuid not null unique references public.clued_audit_receipts(id),
  off_receipt_id uuid references public.clued_audit_receipts(id),
  session_id text not null,
  check (expires_at>turned_on_at and expires_at<=turned_on_at+interval '7 days'),
  check ((turned_off_at is null)=(off_receipt_id is null))
);
create index owner_auto_approve_v1_live_idx on clued_private.owner_auto_approve_v1(user_id,expires_at)
  where turned_off_at is null;
alter table clued_private.owner_auto_approve_v1 enable row level security;
revoke all on clued_private.owner_auto_approve_v1 from public,anon,authenticated,service_role;

alter table clued_private.owner_grant_actions
  add column auto_approvable boolean not null default false,
  add constraint owner_grant_actions_auto_approvable_check
    check (not auto_approvable or action<>'connection.permission');
update clued_private.owner_grant_actions set auto_approvable=true
  where action in ('release.production','migration.production','repo.protected_change','work_claim.extra_claims');

-- A grant comes from the Owner's confirmation token, or from the switch.
alter table clued_private.owner_grants_v1 alter column token_id drop not null;
alter table clued_private.owner_grants_v1
  add column auto_approve_id uuid references clued_private.owner_auto_approve_v1(id);
alter table clued_private.owner_grants_v1
  add constraint owner_grants_v1_source_check check ((token_id is null)<>(auto_approve_id is null));

-- The live switch period, or none.
create function clued_private.owner_auto_approve_live_v1(p_user_id uuid)
returns clued_private.owner_auto_approve_v1 language sql stable security definer set search_path='' as $$
  select * from clued_private.owner_auto_approve_v1 s
    where s.user_id=p_user_id and s.turned_off_at is null and s.expires_at>clock_timestamp()
    order by s.turned_on_at desc limit 1
$$;

create function clued_private.owner_auto_approve_public_v1(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s clued_private.owner_auto_approve_v1%rowtype;
begin
  s:=clued_private.owner_auto_approve_live_v1(p_user_id);
  return jsonb_build_object('on',s.id is not null,'switch_id',s.id,'turned_on_at',s.turned_on_at,
    'expires_at',s.expires_at,
    'covers',coalesce((select jsonb_agg(a.action order by a.action)
      from clued_private.owner_grant_actions a where a.auto_approvable),'[]'::jsonb),
    'excluded',coalesce((select jsonb_agg(jsonb_build_object('action',a.action,'title',a.title) order by a.action)
      from clued_private.owner_grant_actions a where not a.auto_approvable),'[]'::jsonb));
end $$;

-- What the Owner confirms when turning the switch on, rendered by Clued.
create function clued_private.owner_auto_approve_view_v1(p_expires_seconds integer) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('kind','owner_auto_approve','expires_seconds',p_expires_seconds,
    'covers',coalesce((select jsonb_agg(jsonb_build_object('action',a.action,'title',a.title,'risk',a.risk,
        'approval',case when a.risk='routine' then 'grant' else 'once' end) order by a.action)
      from clued_private.owner_grant_actions a where a.auto_approvable),'[]'::jsonb),
    'excluded',coalesce((select jsonb_agg(jsonb_build_object('action',a.action,'title',a.title) order by a.action)
      from clued_private.owner_grant_actions a where not a.auto_approvable),'[]'::jsonb))
$$;

-- Approves a pending request when the switch is on and the action is
-- eligible; returns the request as it now stands. Callers hold or take the
-- Owner's grant lock, so the switch cannot change under it.
create function clued_private.owner_auto_approve_request_v1(p_req clued_private.owner_requests_v1)
returns clued_private.owner_requests_v1 language plpgsql volatile security definer set search_path='' as $$
declare s clued_private.owner_auto_approve_v1%rowtype; a clued_private.owner_grant_actions%rowtype;
  v_req clued_private.owner_requests_v1%rowtype; v_grant clued_private.owner_grants_v1%rowtype;
  v_now timestamptz:=clock_timestamp(); v_choice text; v_seconds integer; v_max integer; v_receipt uuid;
begin
  if p_req.id is null or p_req.status<>'pending' or p_req.expires_at<=v_now
      or not exists(select 1 from clued_private.owner_grant_actions x
        where x.action=p_req.action and x.auto_approvable) then
    return p_req;
  end if;
  perform clued_private.owner_grant_lock_v1(p_req.user_id);
  s:=clued_private.owner_auto_approve_live_v1(p_req.user_id);
  if s.id is null then return p_req; end if;
  select * into v_req from clued_private.owner_requests_v1 where id=p_req.id for update;
  if v_req.status<>'pending' then return v_req; end if;
  select * into a from clued_private.owner_grant_actions where action=v_req.action;
  if a.risk='routine' then
    v_choice:='grant'; v_seconds:=coalesce(v_req.suggested_expires_seconds,14400); v_max:=v_req.suggested_max_uses;
  else
    v_choice:='once'; v_seconds:=86400; v_max:=1;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_req.user_id,null,'global','owner_grant','owner_grant',v_req.id::text,1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_GIVEN','principal','owner_auto_approve',
      'auto_approve_id',s.id,'switch_receipt_id',s.receipt_id,
      'choices',jsonb_build_object('request_id',v_req.id,'action',v_req.action,'resources',to_jsonb(v_req.resources),
        'task_id',v_req.task_id,'choice',v_choice,'expires_seconds',v_seconds,'max_uses',v_max,
        'grantee_binding_id',v_req.binding_id)))
  returning id into v_receipt;
  insert into clued_private.owner_grants_v1(user_id,grantee_binding_id,action,resources,task_id,max_uses,
    granted_at,expires_at,request_id,token_id,auto_approve_id,receipt_id,granted_session_id)
  values(v_req.user_id,v_req.binding_id,v_req.action,v_req.resources,v_req.task_id,v_max,
    v_now,least(v_now+make_interval(secs=>v_seconds),s.expires_at),v_req.id,null,s.id,v_receipt,s.session_id)
  returning * into v_grant;
  update clued_private.owner_requests_v1
    set status=case when v_choice='once' then 'approved_once' else 'granted' end,grant_id=v_grant.id,decided_at=v_now
    where id=v_req.id
    returning * into v_req;
  return v_req;
end $$;

-- ---------------------------------------------------------------------------
-- Owner RPCs (Native account session).

-- Step 1. Input {expires_seconds?} (default 24 hours, 60 seconds to 7 days).
create function public.clued_owner_auto_approve_confirmation_issue_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_seconds integer; v_view jsonb; v_digest text;
  v_raw text; v_token_id uuid; v_expires timestamptz; v_now timestamptz; v_error text;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if clued_private.native_session_id_v1() is null then
    return jsonb_build_object('status','rejected','error_code','confirmation_token_session_id_required','authoritative',false);
  end if;
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k<>'expires_seconds') then
      raise exception 'owner_auto_approve_unknown_field' using errcode='22023'; end if;
    begin
      v_seconds:=coalesce((p_input->>'expires_seconds')::integer,86400);
    exception when others then raise exception 'owner_auto_approve_duration_invalid' using errcode='22023'; end;
    if v_seconds not between 60 and 604800 then
      raise exception 'owner_auto_approve_duration_invalid' using errcode='22023'; end if;
    perform clued_private.owner_grant_lock_v1(v_owner);
    v_view:=clued_private.owner_auto_approve_view_v1(v_seconds);
    v_digest:=clued_private.m1_sha256(v_view);
    update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp()
      where user_id=v_owner and action='owner_auto_approve' and subject_key='owner-auto-approve'
        and consumed_at is null and revoked_at is null;
    v_raw:='clued_oaa_'||encode(extensions.gen_random_bytes(32),'hex');
    v_now:=clock_timestamp();
    insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
      confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
    values(v_owner,'owner_auto_approve','owner-auto-approve',0,jsonb_build_object('expires_seconds',v_seconds),v_view,v_digest,
      encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),
      coalesce(clued_private.native_auth_time_v1(),v_now),v_now,v_now+interval '5 minutes')
    returning id,expires_at into v_token_id,v_expires;
    return jsonb_build_object('status','issued','confirmation_token',v_raw,'token_id',v_token_id,'expires_at',v_expires,
      'confirmation_view',v_view,'view_digest',v_digest,'authoritative',false);
  exception when sqlstate '22023' or sqlstate '42501' then
    get stacked diagnostics v_error=message_text;
    return jsonb_build_object('status','rejected','error_code',v_error,'authoritative',false);
  end;
end $$;

-- Step 2: consume the token, re-render the view, turn the switch on. A live
-- period is replaced by the new one.
create function public.clued_owner_auto_approve_on_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_token clued_private.native_confirmation_tokens%rowtype;
  v_token_id uuid; v_hash text; v_receipt uuid; v_now timestamptz; v_error text; v_state text;
  s clued_private.owner_auto_approve_v1%rowtype; v_seconds integer;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  begin
    if jsonb_typeof(p_input) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('confirmation_token','view_digest')) then
      raise exception 'owner_auto_approve_unknown_field' using errcode='22023'; end if;
    if jsonb_typeof(p_input->'confirmation_token') is distinct from 'string' then
      raise exception 'confirmation_token_required' using errcode='42501'; end if;
    perform clued_private.owner_grant_lock_v1(v_owner);
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
    select * into v_token from clued_private.native_confirmation_tokens t
      where t.user_id=v_owner and t.action='owner_auto_approve' and t.token_hash=v_hash for update;
    if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
    if v_token.consume_outcome='committed' then
      select * into s from clued_private.owner_auto_approve_v1 where token_id=v_token.id;
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',s.receipt_id,
        'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
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
    v_seconds:=(v_token.native_choices->>'expires_seconds')::integer;
    if clued_private.m1_sha256(clued_private.owner_auto_approve_view_v1(v_seconds))<>v_token.view_digest then
      raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    v_now:=clock_timestamp();
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(v_owner,null,'global','owner_auto_approve_on','owner_auto_approve',v_token.id::text,1,
      jsonb_build_object('receipt_kind','OWNER_AUTO_APPROVE_ON','expires_seconds',v_seconds,'token_id',v_token.id,
        'view_digest',v_token.view_digest,'session_id',v_token.session_id,'principal','native_account_session'))
    returning id into v_receipt;
    update clued_private.owner_auto_approve_v1 set turned_off_at=v_now,off_receipt_id=v_receipt
      where user_id=v_owner and turned_off_at is null;
    insert into clued_private.owner_auto_approve_v1(user_id,turned_on_at,expires_at,token_id,receipt_id,session_id)
    values(v_owner,v_now,v_now+make_interval(secs=>v_seconds),v_token.id,v_receipt,v_token.session_id);
    update clued_private.native_confirmation_tokens set consumed_at=v_now,consumed_receipt_id=v_receipt,
      consume_outcome='committed' where id=v_token.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
      'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    -- Single use: a presented live token is burned by any failed attempt.
    if v_token_id is not null then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_owner,null,'global','owner_auto_approve_on','owner_auto_approve',v_token_id::text,1,
        jsonb_build_object('receipt_kind','OWNER_AUTO_APPROVE_REJECTED','token_id',v_token_id,'error_code',v_error))
      returning id into v_receipt;
      update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=v_receipt,
        consume_outcome='rejected' where id=v_token_id and consumed_at is null and revoked_at is null;
    end if;
    return jsonb_build_object('status',case when v_state in ('22023','40001','42501')
      then 'rejected' else 'failed' end,'error_code',v_error,'authoritative',false);
  end;
end $$;

-- One step: stops new automatic approvals at once.
create function public.clued_owner_auto_approve_off_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); s clued_private.owner_auto_approve_v1%rowtype;
  v_receipt uuid;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'owner_auto_approve_unknown_field' using errcode='22023'; end if;
  perform clued_private.owner_grant_lock_v1(v_owner);
  s:=clued_private.owner_auto_approve_live_v1(v_owner);
  if s.id is null then
    return jsonb_build_object('status','committed','replayed',true,
      'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','owner_auto_approve_off','owner_auto_approve',s.id::text,2,
    jsonb_build_object('receipt_kind','OWNER_AUTO_APPROVE_OFF','auto_approve_id',s.id,'principal','native_account_session'))
  returning id into v_receipt;
  update clued_private.owner_auto_approve_v1 set turned_off_at=clock_timestamp(),off_receipt_id=v_receipt
    where user_id=v_owner and turned_off_at is null;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'auto_approve',clued_private.owner_auto_approve_public_v1(v_owner));
end $$;

-- ---------------------------------------------------------------------------
-- Patches.

create function clued_private.owner_auto_approve_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'owner_auto_approve_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- An Agent's request (and each bundle member).
select clued_private.owner_auto_approve_patch_v1('public.clued_owner_request_v1(text,jsonb)',
$a$    v_expires_s,v_max,v_note,clock_timestamp()+interval '24 hours',v_receipt)
  returning * into v_req;$a$,
$r$    v_expires_s,v_max,v_note,clock_timestamp()+interval '24 hours',v_receipt)
  returning * into v_req;
  v_req:=clued_private.owner_auto_approve_request_v1(v_req);$r$);

-- The release door: approve its own request, then use the grant at once.
select clued_private.owner_auto_approve_patch_v1('public.clued_owner_grant_door_consume_v1(text,jsonb)',
$a$  v_req:=clued_private.owner_grant_door_request_v1(v_binding,v_action.action,v_resources);$a$,
$r$  v_req:=clued_private.owner_grant_door_request_v1(v_binding,v_action.action,v_resources);
  v_req:=clued_private.owner_auto_approve_request_v1(v_req);
  if v_req.status<>'pending' then
    v_grant:=clued_private.owner_grant_consume_door_v1(v_binding.user_id,v_binding.id,v_action.action,v_resources);
    if v_grant is not null then
      return jsonb_build_object('status','ok','consumed',true,'action',v_action.action,
        'resources',to_jsonb(v_resources),'grant',v_grant,'auto_approved',true);
    end if;
  end if;$r$);

-- The admission door: the same for repo.protected_change.
select clued_private.owner_auto_approve_patch_v1('public.clued_owner_grant_admission_door_v1(text,jsonb)',
$a$  v_req:=clued_private.owner_grant_admission_request_v1(v_binding,v_action.action,v_resources,v_note);$a$,
$r$  v_req:=clued_private.owner_grant_admission_request_v1(v_binding,v_action.action,v_resources,v_note);
  v_req:=clued_private.owner_auto_approve_request_v1(v_req);
  if v_req.status<>'pending' then
    v_grant:=clued_private.owner_grant_admission_use_v1(v_binding.user_id,v_binding.id,v_action.action,v_resources);
    if v_grant is not null then
      return jsonb_build_object('status','ok','admitted',true,'action',v_action.action,
        'resources',to_jsonb(v_resources),'grant',v_grant,'auto_approved',true);
    end if;
  end if;$r$);

-- Work claims over the per-Task cap: approve the Task's request, use one of
-- its grant's uses and go on to issue the claim; refuse only if none admits.
select clued_private.owner_auto_approve_patch_v1(
  'clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text)',
$a$          returning * into v_request;
        end if;
        return clued_private.work_claim_reject_logged_v1($a$,
$r$          returning * into v_request;
        end if;
        v_request:=clued_private.owner_auto_approve_request_v1(v_request);
        if v_request.status<>'pending' then
          v_grant:=clued_private.owner_grant_consume_v1(p_binding.user_id,p_binding.id,'work_claim.extra_claims',
            v_request.resources,p_task.id);
        end if;
      end if;
      if v_exemption_id is null and v_grant is null then
        return clued_private.work_claim_reject_logged_v1($r$);

-- Every view of a grant says whether the switch gave it.
select clued_private.owner_auto_approve_patch_v1('clued_private.owner_request_public_v1(clued_private.owner_requests_v1)',
$a$'uses',g.uses,'revoked',g.revoked_at is not null,'any_agent',g.grantee_binding_id is null)$a$,
$r$'uses',g.uses,'revoked',g.revoked_at is not null,'any_agent',g.grantee_binding_id is null,
        'auto_approved',g.auto_approve_id is not null)$r$);

select clued_private.owner_auto_approve_patch_v1('public.clued_owner_grants_list_v1(jsonb)',
$a$'expires_at',g.expires_at,'max_uses',g.max_uses,'uses',g.uses) order by g.expires_at)$a$,
$r$'expires_at',g.expires_at,'max_uses',g.max_uses,'uses',g.uses,
        'auto_approved',g.auto_approve_id is not null) order by g.expires_at)$r$);
select clued_private.owner_auto_approve_patch_v1('public.clued_owner_grants_list_v1(jsonb)',
$a$  return jsonb_build_object('status','ok',$a$,
$r$  return jsonb_build_object('status','ok','auto_approve',clued_private.owner_auto_approve_public_v1(v_owner),$r$);

drop function clued_private.owner_auto_approve_patch_v1(text,text,text);

revoke all on function
  clued_private.owner_auto_approve_live_v1(uuid),
  clued_private.owner_auto_approve_public_v1(uuid),
  clued_private.owner_auto_approve_view_v1(integer),
  clued_private.owner_auto_approve_request_v1(clued_private.owner_requests_v1),
  public.clued_owner_auto_approve_confirmation_issue_v1(jsonb),
  public.clued_owner_auto_approve_on_v1(jsonb),
  public.clued_owner_auto_approve_off_v1(jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.clued_owner_auto_approve_confirmation_issue_v1(jsonb),
  public.clued_owner_auto_approve_on_v1(jsonb),public.clued_owner_auto_approve_off_v1(jsonb)
  to authenticated;

notify pgrst,'reload schema';
