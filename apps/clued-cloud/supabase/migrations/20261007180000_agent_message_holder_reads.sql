-- Agent messages: only the recipient marks a message read (BUG-20261007-004,
-- Task d35e10cc; Agent Messaging v0.1 §4.8).
--
-- A message to a claim has one read_at. agent_message_addressed lets every
-- session of the holder's Binding see it when the claim names no holder
-- session (holder_session_ref null), and lets a read without session_ref see
-- every session's mail. clued_agent_inbox_v1 marked every returned incoming
-- message read, so whichever of those sessions read its inbox first cleared
-- the message, and the claim's holder never found it in latest_unread on its
-- next renewal or resume. Observed 2026-10-07: a message to claim 75881ebc
-- (thread e95d6455) was read by the session holding claim d419f31e.
--
-- A read now marks a message read only for its definite recipient:
--   * a message to a claim: the read names that claim (the new claim_id
--     input), or comes from the claim holder's own session (session_ref equal
--     to the live claim's holder_session_ref; after the claim ended, to the
--     session the message was sent to);
--   * a message to a session: that session;
--   * a message to a whole connection (no claim, no session): any session.
-- Other sessions still see what reaches them, as before, but it stays unread
-- for its recipient. Each returned incoming message says marked_read, and
-- left_unread counts the unread ones this read did not mark.
--
-- clued_agent_inbox_v1 takes claim_id: only messages sent to that claim (a
-- claim you hold, or held), read as its holder. Not with thread_id.
--
-- Replies are unchanged: replying reads and answers the message it answers.
-- The summary is unchanged: latest_unread keeps a message until its
-- recipient reads it. Replaces clued_agent_inbox_v1 in place (same signature,
-- grants and OAuth route); adds one helper.

-- May this read mark message m read? p_claim_id is the claim the read names.
create function clued_private.agent_message_read_by(m clued_private.agent_messages_v1,
  p_binding_id uuid,p_session text,p_claim_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(clued_private.agent_message_addressed(m,p_binding_id,p_session) and case
    when m.to_claim_id is not null and m.to_claim_id=p_claim_id then true
    when m.to_claim_id is not null and clued_private.agent_message_claim_live(m.to_claim_id) then
      p_session is not null and exists(select 1 from clued_private.work_claims_v1 c
        where c.claim_id=m.to_claim_id and c.holder_session_ref=p_session)
    when m.to_session_ref is not null then p_session is not null and m.to_session_ref=p_session
    else m.to_claim_id is null
  end,false)
$$;

-- clued_agent_inbox_v1: {scope?, session_ref?, view?: open|unread|all|sent,
--   thread_id?, claim_id?, limit?, mark_read?}
-- open (default): incoming messages of threads not closed; unread: incoming
-- messages not yet read; all: every incoming message; sent: what the caller
-- sent. thread_id returns that whole thread when the caller takes part in it.
-- claim_id keeps only messages sent to that claim. Returned incoming messages
-- are marked read, unless mark_read is false, when this read is their
-- recipient's (agent_message_read_by).
create or replace function public.clued_agent_inbox_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_session text; v_view text:=coalesce(p_input->>'view','open'); v_thread uuid; v_claim uuid; v_limit integer;
  v_mark boolean; v_ids uuid[]; v_marks uuid[]:='{}'::uuid[]; v_left integer:=0; v_out jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_session:=clued_private.agent_message_session(p_input->>'session_ref');
  if v_view not in ('open','unread','all','sent') then
    raise exception 'agent_message_view_invalid' using errcode='22023'; end if;
  v_thread:=clued_private.agent_message_uuid(p_input->>'thread_id','agent_message_thread_id_invalid');
  v_claim:=clued_private.agent_message_uuid(p_input->>'claim_id','agent_message_claim_id_invalid');
  if v_claim is not null and v_thread is not null then
    raise exception 'agent_message_claim_id_invalid' using errcode='22023'; end if;
  if p_input ? 'limit' and coalesce(p_input->>'limit','') !~ '^[0-9]{1,3}$' then
    raise exception 'agent_message_limit_invalid' using errcode='22023'; end if;
  v_limit:=coalesce((p_input->>'limit')::integer,20);
  if v_limit not between 1 and 50 then
    raise exception 'agent_message_limit_invalid' using errcode='22023'; end if;
  if p_input ? 'mark_read' and jsonb_typeof(p_input->'mark_read') not in ('boolean','null') then
    raise exception 'agent_message_mark_read_invalid' using errcode='22023'; end if;
  v_mark:=coalesce((p_input->>'mark_read')::boolean,true);

  if v_thread is not null then
    if not exists(select 1 from clued_private.agent_messages_v1 m
        where m.user_id=v_binding.user_id and m.thread_id=v_thread and m.expires_at>v_now
          and (clued_private.agent_message_is_sender(m,v_binding.id,v_session)
            or clued_private.agent_message_addressed(m,v_binding.id,v_session))) then
      return clued_private.agent_message_reject('agent_message_not_found',null); end if;
    select coalesce(array_agg(x.message_id order by x.created_at,x.message_id),'{}'::uuid[]) into v_ids from (
      select m.message_id,m.created_at from clued_private.agent_messages_v1 m
        where m.user_id=v_binding.user_id and m.thread_id=v_thread and m.expires_at>v_now
          and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))
        order by m.created_at,m.message_id limit v_limit) x;
  elsif v_view='sent' then
    select coalesce(array_agg(x.message_id order by x.created_at desc,x.message_id),'{}'::uuid[]) into v_ids from (
      select m.message_id,m.created_at from clued_private.agent_messages_v1 m
        where m.user_id=v_binding.user_id and m.expires_at>v_now
          and (v_claim is null or m.to_claim_id=v_claim)
          and clued_private.agent_message_is_sender(m,v_binding.id,v_session)
        order by m.created_at desc,m.message_id limit v_limit) x;
  else
    select coalesce(array_agg(x.message_id order by x.created_at desc,x.message_id),'{}'::uuid[]) into v_ids from (
      select m.message_id,m.created_at from clued_private.agent_messages_v1 m
        where m.user_id=v_binding.user_id and m.expires_at>v_now
          and (v_claim is null or m.to_claim_id=v_claim)
          and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))
          and clued_private.agent_message_addressed(m,v_binding.id,v_session)
          and (v_view='all' or (v_view='open' and m.closed_at is null)
            or (v_view='unread' and m.read_at is null))
        order by m.created_at desc,m.message_id limit v_limit) x;
  end if;

  -- What this read marks: unread incoming messages whose recipient it is.
  if v_mark and v_view<>'sent' then
    select coalesce(array_agg(x.message_id) filter (where x.mine),'{}'::uuid[]),
        (count(*) filter (where not x.mine))::integer
      into v_marks,v_left
      from (select m.message_id,clued_private.agent_message_read_by(m,v_binding.id,v_session,v_claim) mine
        from clued_private.agent_messages_v1 m
        where m.message_id=any(v_ids) and m.read_at is null
          and clued_private.agent_message_addressed(m,v_binding.id,v_session)) x;
  end if;

  -- The answer shows each message as it was before this read marked it.
  select coalesce(jsonb_agg(clued_private.agent_message_view(m,true)
      ||case when clued_private.agent_message_addressed(m,v_binding.id,v_session)
        then jsonb_build_object('direction','incoming','marked_read',m.message_id=any(v_marks))
        else jsonb_build_object('direction','outgoing') end
      order by u.o),'[]'::jsonb)
    into v_out
    from unnest(v_ids) with ordinality u(id,o)
    join clued_private.agent_messages_v1 m on m.message_id=u.id;

  if cardinality(v_marks)>0 then
    update clued_private.agent_messages_v1 m set read_at=v_now
      where m.message_id=any(v_marks) and m.read_at is null;
  end if;

  return jsonb_build_object('status','ok','observed_at',v_now,'view',
      case when v_thread is null then v_view else 'thread' end,
    'thread_id',v_thread,'claim_id',v_claim,'session_ref',v_session,'messages',v_out,
    'returned',jsonb_array_length(v_out),'left_unread',v_left,'profile',clued_private.agent_message_profile_v1())
    ||case when v_left>0 then jsonb_build_object('left_unread_reason',
      'You see these because they reach more sessions of your connection than their recipient: a claim whose holder gave no session, or another session. They stay unread for their recipient. Read messages to a claim you hold with claim_id, or claim with holder_session_ref and read with that session_ref.')
      else '{}'::jsonb end;
end $$;

revoke all on function clued_private.agent_message_read_by(clued_private.agent_messages_v1,uuid,text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_agent_inbox_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_agent_inbox_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
