-- Owner Credential v0.1, the Owner's answer reaches the Agent
-- (OwnerCredential.v0.1.md §13; Owner Decision 973e1b5b, Task d5bd604e).
--
-- Until now an Agent learned that the Owner had approved or rejected its
-- request only by reading the request's status again, or from the Owner
-- saying so in the chat. Now the answer comes to it: once the Owner decides on
-- /confirm (approved once, a time-limited grant, or rejected), the request is
-- an unread answer for the Binding that opened it, and for that Host session
-- only when the request named one (session_ref). The answer is shown:
-- - in clued_agent_inbox_summary_v1, which the Worker folds into
--   clued_session_resume and clued_work_renew (owner_answer_count and the
--   latest five, never marked read there);
-- - in clued_agent_inbox_v1 (views open, unread and all), which marks the
--   answers it returns read unless mark_read is false.
-- Reading the request's status from the Binding that opened it also marks it
-- read. An answer the auto-approval switch gave (§12) is never an unread
-- answer: the call that opened the request already returned it. Answers older
-- than 7 days are no longer shown. A bundle is one answer, shown as its first
-- member with the bundle list.
--
-- An answer is the Owner's decision as the request records it, not a message
-- from another Agent: the Agent may rely on it, but the grant it names is
-- still checked by each door when used.
--
-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.

alter table clued_private.owner_requests_v1
  add column session_ref text
    check (session_ref is null or (char_length(session_ref) between 1 and 200 and session_ref !~ '[[:cntrl:]]')),
  add column answer_seen_at timestamptz;

-- Everything the Owner decided before this migration counts as read.
update clued_private.owner_requests_v1 set answer_seen_at=decided_at
  where decided_at is not null and answer_seen_at is null;

create index owner_requests_v1_unread_answer_idx on clued_private.owner_requests_v1(user_id,binding_id,decided_at)
  where answer_seen_at is null and decided_at is not null;

-- Is r an unread answer for this Binding (and session)? A null session reads
-- every session's answers of the Binding; a request without a session is for
-- every session of it.
create function clued_private.owner_answer_unread_v1(r clued_private.owner_requests_v1,
  p_user uuid,p_binding uuid,p_session text) returns boolean
language sql stable security definer set search_path='' as $$
  select r.user_id=p_user and r.binding_id=p_binding
    and (p_session is null or r.session_ref is null or r.session_ref=p_session)
    and r.status in ('approved_once','granted','rejected')
    and r.decided_at is not null and r.answer_seen_at is null
    and r.decided_at>pg_catalog.clock_timestamp()-interval '7 days'
    and not exists(select 1 from clued_private.owner_grants_v1 g
      where g.id=r.grant_id and g.auto_approve_id is not null)
$$;

create function clued_private.owner_answer_count_v1(p_user uuid,p_binding uuid,p_session text)
returns integer language sql stable security definer set search_path='' as $$
  select count(distinct coalesce(r.bundle_id,r.id))::integer from clued_private.owner_requests_v1 r
    where r.user_id=p_user and r.binding_id=p_binding and r.answer_seen_at is null and r.decided_at is not null
      and clued_private.owner_answer_unread_v1(r,p_user,p_binding,p_session)
$$;

-- The newest p_limit unread answers, one per request or bundle, as the status
-- read shows them. p_mark marks every member of the returned ones read.
create function clued_private.owner_answers_take_v1(p_user uuid,p_binding uuid,p_session text,
  p_limit integer,p_mark boolean) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_keys uuid[]; v_out jsonb;
begin
  with lead as (
    select distinct on (coalesce(r.bundle_id,r.id)) coalesce(r.bundle_id,r.id) k,r.id,r.decided_at
      from clued_private.owner_requests_v1 r
      where r.user_id=p_user and r.binding_id=p_binding and r.answer_seen_at is null and r.decided_at is not null
        and clued_private.owner_answer_unread_v1(r,p_user,p_binding,p_session)
      order by coalesce(r.bundle_id,r.id),r.created_at,r.id),
  pick as (select * from lead order by decided_at desc,id limit p_limit)
  select coalesce(array_agg(p.k),'{}'::uuid[]),
      coalesce(jsonb_agg(clued_private.owner_request_public_v1(r)||jsonb_build_object('source','owner_answer')
        order by p.decided_at desc,p.id),'[]'::jsonb)
    into v_keys,v_out
    from pick p join clued_private.owner_requests_v1 r on r.id=p.id;
  if p_mark and cardinality(v_keys)>0 then
    update clued_private.owner_requests_v1 r set answer_seen_at=pg_catalog.clock_timestamp()
      where r.user_id=p_user and r.binding_id=p_binding and r.answer_seen_at is null
        and r.decided_at is not null and coalesce(r.bundle_id,r.id)=any(v_keys);
  end if;
  return v_out;
end $$;

create function clued_private.owner_answer_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'owner_answer_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- An Agent's request may name its Host session (bundles pass it to each
-- member).
select clued_private.owner_answer_patch_v1('public.clued_owner_request_v1(text,jsonb)',
$a$('scope','action','resources','task_id','suggested_grant','agent_note','idempotency_key')) then$a$,
$r$('scope','action','resources','task_id','suggested_grant','agent_note','idempotency_key','session_ref')) then$r$);
select clued_private.owner_answer_patch_v1('public.clued_owner_request_v1(text,jsonb)',
$a$  v_req:=clued_private.owner_auto_approve_request_v1(v_req);$a$,
$r$  if p_input ? 'session_ref' then
    if jsonb_typeof(p_input->'session_ref') is distinct from 'string'
      or char_length(btrim(p_input->>'session_ref')) not between 1 and 200
      or p_input->>'session_ref' ~ '[[:cntrl:]]' then
      raise exception 'owner_request_session_ref_invalid' using errcode='22023'; end if;
    update clued_private.owner_requests_v1 set session_ref=btrim(p_input->>'session_ref')
      where id=v_req.id returning * into v_req;
  end if;
  v_req:=clued_private.owner_auto_approve_request_v1(v_req);$r$);
select clued_private.owner_answer_patch_v1('public.clued_owner_request_bundle_v1(text,jsonb)',
$a$('scope','actions','task_id','suggested_grant','agent_note','idempotency_key')) then$a$,
$r$('scope','actions','task_id','suggested_grant','agent_note','idempotency_key','session_ref')) then$r$);

-- Reading the status from the Binding that opened the request reads its
-- answer.
select clued_private.owner_answer_patch_v1('public.clued_owner_request_status_v1(text,jsonb)',
$a$  return jsonb_build_object('status','ok','request',clued_private.owner_request_public_v1(v_req));$a$,
$r$  if v_req.binding_id=v_binding.id and v_req.decided_at is not null and v_req.answer_seen_at is null then
    update clued_private.owner_requests_v1 set answer_seen_at=pg_catalog.clock_timestamp()
      where user_id=v_req.user_id and binding_id=v_req.binding_id and answer_seen_at is null
        and decided_at is not null and coalesce(bundle_id,id)=coalesce(v_req.bundle_id,v_req.id);
  end if;
  return jsonb_build_object('status','ok','request',clued_private.owner_request_public_v1(v_req));$r$);

-- The summary folded into resume and renewal. A renewal sends claim_id
-- without a session: the claim's own session is used.
select clued_private.owner_answer_patch_v1('public.clued_agent_inbox_summary_v1(text,jsonb)',
$a$    'agent_messages_enabled',clued_private.agent_messages_enabled_v1(v_binding.user_id));$a$,
$r$    'agent_messages_enabled',clued_private.agent_messages_enabled_v1(v_binding.user_id),
    'owner_answer_count',clued_private.owner_answer_count_v1(v_binding.user_id,v_binding.id,
      coalesce(v_session,(select c.holder_session_ref from clued_private.work_claims_v1 c
        where c.claim_id=v_claim and c.holder_binding_id=v_binding.id))),
    'owner_answers',clued_private.owner_answers_take_v1(v_binding.user_id,v_binding.id,
      coalesce(v_session,(select c.holder_session_ref from clued_private.work_claims_v1 c
        where c.claim_id=v_claim and c.holder_binding_id=v_binding.id)),5,false));$r$);

-- The inbox: answers next to the messages, read like them.
select clued_private.owner_answer_patch_v1('public.clued_agent_inbox_v1(text,jsonb)',
$a$    'returned',jsonb_array_length(v_out),'profile',clued_private.agent_message_profile_v1());$a$,
$r$    'returned',jsonb_array_length(v_out),'profile',clued_private.agent_message_profile_v1(),
    'owner_answers',case when v_thread is null and v_view<>'sent'
      then clued_private.owner_answers_take_v1(v_binding.user_id,v_binding.id,v_session,20,v_mark)
      else '[]'::jsonb end);$r$);

drop function clued_private.owner_answer_patch_v1(text,text,text);

revoke all on function
  clued_private.owner_answer_unread_v1(clued_private.owner_requests_v1,uuid,uuid,text),
  clued_private.owner_answer_count_v1(uuid,uuid,text),
  clued_private.owner_answers_take_v1(uuid,uuid,text,integer,boolean)
from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
