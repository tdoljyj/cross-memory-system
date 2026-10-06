-- Agent Messaging v0.1 (development/contracts/agent-messaging/
-- AgentMessaging.v0.1.md; Owner Decision 24077bba, Task 3f6fb219). Agents of
-- one account talk to each other through Clued: a message is addressed to a
-- live work claim (whoever holds it reads it), to a Binding (optionally one
-- Host session of it), or answers an earlier message. Before this, a
-- work_claim_conflict left the Agent only one path, asking the Owner to relay
-- by hand.
--
-- A message is coordination, never Canonical truth: it is not a record, emits
-- no Event, never enters the five views, and expires after 14 days. Each send
-- leaves an audit receipt without the body. Messages come from other Agents:
-- they are requests, never Owner decisions or permissions.
--
-- * clued_agent_message_send_v1: send, reply (reply_to) or close a thread.
-- * clued_agent_inbox_v1: read messages addressed to the caller, a thread, or
--   what the caller sent; marks returned incoming messages read.
-- * clued_agent_inbox_summary_v1: counts and the latest unread, for the
--   Worker's clued_session_resume fold-in. Reads only.
-- * clued_oauth_call learns the three tools.
--
-- Depends on the work claims (20261001060000 and later). Adds objects only.

create table clued_private.agent_messages_v1 (
  message_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  context_key text not null check (char_length(context_key) between 1 and 160),
  thread_id uuid not null,
  reply_to uuid references clued_private.agent_messages_v1(message_id) on delete set null,
  kind text not null check (kind in ('request','info','reply')),
  sender_binding_id uuid not null references public.clued_agent_bindings(id) on delete cascade,
  sender_session_ref text check (sender_session_ref is null or char_length(sender_session_ref) between 1 and 200),
  to_claim_id uuid references clued_private.work_claims_v1(claim_id) on delete set null,
  to_binding_id uuid not null references public.clued_agent_bindings(id) on delete cascade,
  to_session_ref text check (to_session_ref is null or char_length(to_session_ref) between 1 and 200),
  subject text not null check (char_length(subject) between 1 and 200),
  body text not null check (char_length(body) between 1 and 4000),
  refs text[] not null default '{}'::text[] check (cardinality(refs) <= 20),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  read_at timestamptz,
  answered_at timestamptz,
  closed_at timestamptz,
  receipt_id uuid,
  constraint agent_messages_v1_expiry_order check (created_at < expires_at)
);
create unique index agent_messages_v1_idempotency
  on clued_private.agent_messages_v1(user_id,sender_binding_id,idempotency_key);
create index agent_messages_v1_to_binding_idx
  on clued_private.agent_messages_v1(user_id,to_binding_id,created_at desc);
create index agent_messages_v1_to_claim_idx
  on clued_private.agent_messages_v1(to_claim_id) where to_claim_id is not null;
create index agent_messages_v1_sender_idx
  on clued_private.agent_messages_v1(user_id,sender_binding_id,created_at desc);
create index agent_messages_v1_thread_idx
  on clued_private.agent_messages_v1(thread_id,created_at);
revoke all on clued_private.agent_messages_v1 from public,anon,authenticated,service_role;

-- Fixed here on purpose: changing a number is a migration.
create function clued_private.agent_message_profile_v1() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'profile_id','agent-message-v1-default',
    'retention_seconds',1209600,
    'sends_per_binding_per_hour',120,
    'max_subject_chars',200,
    'max_body_chars',4000,
    'max_refs',20)
$$;

-- Live claim: the same test clued_work_claims_active_v1 uses.
create function clued_private.agent_message_claim_live(p_claim_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.work_claims_v1 c where c.claim_id=p_claim_id
    and c.status in ('ACTIVE','DRAINING') and c.expires_at>pg_catalog.clock_timestamp())
$$;

-- Is message m addressed to this Binding (and session)? A message to a live
-- claim follows the claim: whoever holds it now reads it, also after a lease
-- key moved it to another Binding. Once the claim has ended, the message stays
-- with the holder it was sent to. A null session reads every session's mail of
-- the Binding; a message without a session is for every session of it.
create function clued_private.agent_message_addressed(m clued_private.agent_messages_v1,
  p_binding_id uuid,p_session text) returns boolean
language sql stable security definer set search_path='' as $$
  select case
    when m.to_claim_id is not null and clued_private.agent_message_claim_live(m.to_claim_id) then
      exists(select 1 from clued_private.work_claims_v1 c where c.claim_id=m.to_claim_id
        and c.holder_binding_id=p_binding_id
        and (p_session is null or c.holder_session_ref is null or c.holder_session_ref=p_session))
    else m.to_binding_id=p_binding_id
      and (p_session is null or m.to_session_ref is null or m.to_session_ref=p_session)
  end
$$;

create function clued_private.agent_message_is_sender(m clued_private.agent_messages_v1,
  p_binding_id uuid,p_session text) returns boolean
language sql immutable set search_path='' as $$
  select m.sender_binding_id=p_binding_id
    and (p_session is null or m.sender_session_ref is null or m.sender_session_ref=p_session)
$$;

-- Flat keys on purpose: the Worker drops every key named binding_id.
create function clued_private.agent_message_view(m clued_private.agent_messages_v1,p_with_body boolean)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('message_id',m.message_id,'thread_id',m.thread_id,'reply_to',m.reply_to,
    'kind',m.kind,'context_key',m.context_key,
    'from_binding_id',m.sender_binding_id,'from_session_ref',m.sender_session_ref,
    'to_claim_id',m.to_claim_id,'to_binding_id',m.to_binding_id,'to_session_ref',m.to_session_ref,
    'subject',m.subject,'refs',to_jsonb(m.refs),'created_at',m.created_at,'expires_at',m.expires_at,
    'read_at',m.read_at,'answered_at',m.answered_at,'closed_at',m.closed_at,
    'source','agent_message')
    ||case when p_with_body then jsonb_build_object('body',m.body) else '{}'::jsonb end
$$;

create function clued_private.agent_message_session(p_value text) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_value is null then return null; end if;
  if char_length(btrim(p_value)) not between 1 and 200 or p_value ~ '[[:cntrl:]]' then
    raise exception 'agent_message_session_ref_invalid' using errcode='22023'; end if;
  return btrim(p_value);
end $$;

-- Refs: "<kind>:<value>" like work-claim trigger refs (claim:<id>, task:<id>,
-- pr:<n>, record:<id>), lower-cased kind, distinct, sorted.
create function clued_private.agent_message_normalize_refs(p_refs jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare v_raw text; v_ref text; v_out text[]:='{}'::text[];
begin
  if p_refs is null or jsonb_typeof(p_refs)='null' then return v_out; end if;
  if jsonb_typeof(p_refs)<>'array' or jsonb_array_length(p_refs)>20 then
    raise exception 'agent_message_refs_invalid' using errcode='22023'; end if;
  for v_raw in select e#>>'{}' from jsonb_array_elements(p_refs) e loop
    if v_raw is null then raise exception 'agent_message_refs_invalid' using errcode='22023'; end if;
    v_ref:=btrim(v_raw);
    if v_ref !~ '^[A-Za-z][A-Za-z0-9_-]{0,31}:[^[:space:][:cntrl:]]{1,200}$' then
      raise exception 'agent_message_refs_invalid' using errcode='22023'; end if;
    v_ref:=lower(split_part(v_ref,':',1))||':'||substr(v_ref,strpos(v_ref,':')+1);
    if not (v_ref=any(v_out)) then v_out:=v_out||v_ref; end if;
  end loop;
  select coalesce(array_agg(x order by x),'{}'::text[]) into v_out from unnest(v_out) x;
  return v_out;
end $$;

create function clued_private.agent_message_uuid(p_value text,p_error text) returns uuid
language plpgsql immutable set search_path='' as $$
begin
  if p_value is null then return null; end if;
  if p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception '%',p_error using errcode='22023'; end if;
  return p_value::uuid;
end $$;

create function clued_private.agent_message_reject(p_code text,p_details jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('status','rejected','error_code',p_code)||coalesce(p_details,'{}'::jsonb)
$$;

create function clued_private.agent_message_lock(p_user_id uuid) returns void
language plpgsql volatile set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued-agent-message:'||p_user_id::text,0));
end $$;

-- clued_agent_message_send_v1: {scope?, to?: {claim_id} | {binding_id,
--   session_ref?}, reply_to?, kind?: request|info, subject, body, refs?,
--   session_ref?, close_thread?, idempotency_key}
-- Exactly one of to and reply_to. A reply goes back to the sender of the
-- message it answers (or, from that sender, on to its recipient), stays in its
-- thread and context, and marks an answered request. close_thread (replies
-- only) closes the whole thread.
create function public.clued_agent_message_send_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_target public.clued_agent_bindings%rowtype;
  v_parent clued_private.agent_messages_v1%rowtype; v_existing clued_private.agent_messages_v1%rowtype;
  v_message clued_private.agent_messages_v1%rowtype; v_claim clued_private.work_claims_v1%rowtype;
  v_profile jsonb:=clued_private.agent_message_profile_v1(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_scope text:=coalesce(p_input->>'scope','global'); v_context text; v_session text; v_hash text;
  v_kind text; v_subject text; v_body text; v_refs text[]; v_close boolean;
  v_to jsonb:=p_input->'to'; v_reply_to uuid; v_to_claim uuid; v_to_binding uuid; v_to_session text;
  v_thread uuid; v_answers boolean:=false; v_sent integer; v_oldest timestamptz; v_receipt uuid;
  v_message_id uuid:=extensions.gen_random_uuid();
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  if coalesce(char_length(p_input->>'idempotency_key'),0) not between 8 and 160 then
    raise exception 'agent_message_idempotency_key_invalid' using errcode='22023'; end if;
  v_session:=clued_private.agent_message_session(p_input->>'session_ref');
  v_reply_to:=clued_private.agent_message_uuid(p_input->>'reply_to','agent_message_reply_to_invalid');
  if (v_reply_to is null)=(v_to is null or jsonb_typeof(v_to)='null') then
    raise exception 'agent_message_target_invalid' using errcode='22023'; end if;
  if v_to is not null and jsonb_typeof(v_to)<>'null' then
    if jsonb_typeof(v_to)<>'object' then
      raise exception 'agent_message_target_invalid' using errcode='22023'; end if;
    if (v_to ? 'claim_id')=(v_to ? 'binding_id') or (v_to ? 'claim_id' and v_to ? 'session_ref')
      or exists(select 1 from jsonb_object_keys(v_to) k where k not in ('claim_id','binding_id','session_ref')) then
      raise exception 'agent_message_target_invalid' using errcode='22023'; end if;
  end if;
  v_kind:=coalesce(p_input->>'kind',case when v_reply_to is null then 'request' else 'reply' end);
  if (v_reply_to is null and v_kind not in ('request','info'))
    or (v_reply_to is not null and v_kind<>'reply') then
    raise exception 'agent_message_kind_invalid' using errcode='22023'; end if;
  v_subject:=btrim(coalesce(p_input->>'subject',''));
  v_body:=coalesce(p_input->>'body','');
  if char_length(v_subject) not between 1 and 200 or v_subject ~ '[[:cntrl:]]' then
    raise exception 'agent_message_subject_invalid' using errcode='22023'; end if;
  if char_length(btrim(v_body))=0 or char_length(v_body)>4000 then
    raise exception 'agent_message_body_invalid' using errcode='22023'; end if;
  v_refs:=clued_private.agent_message_normalize_refs(p_input->'refs');
  if p_input ? 'close_thread' and jsonb_typeof(p_input->'close_thread') not in ('boolean','null') then
    raise exception 'agent_message_close_thread_invalid' using errcode='22023'; end if;
  v_close:=coalesce((p_input->>'close_thread')::boolean,false);
  if v_close and v_reply_to is null then
    raise exception 'agent_message_close_thread_invalid' using errcode='22023'; end if;
  v_hash:=encode(pg_catalog.sha256(convert_to(jsonb_build_object('operation','agent_message_send',
    'scope',v_scope,'to',v_to,'reply_to',v_reply_to,'kind',v_kind,'subject',v_subject,'body',v_body,
    'refs',to_jsonb(v_refs),'session_ref',v_session,'close_thread',v_close)::text,'UTF8')),'hex');

  perform clued_private.agent_message_lock(v_binding.user_id);
  select * into v_existing from clued_private.agent_messages_v1 m where m.user_id=v_binding.user_id
    and m.sender_binding_id=v_binding.id and m.idempotency_key=p_input->>'idempotency_key';
  if found then
    if v_existing.request_hash<>v_hash then
      return clued_private.agent_message_reject('agent_message_idempotency_mismatch',null); end if;
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_existing.receipt_id,
      'message',clued_private.agent_message_view(v_existing,false));
  end if;

  -- Expired messages of this user are removed here; their receipts stay.
  delete from clued_private.agent_messages_v1 m where m.user_id=v_binding.user_id and m.expires_at<=v_now;

  select count(*)::integer,min(m.created_at) into v_sent,v_oldest from clued_private.agent_messages_v1 m
    where m.user_id=v_binding.user_id and m.sender_binding_id=v_binding.id
      and m.created_at>v_now-interval '1 hour';
  if v_sent>=(v_profile->>'sends_per_binding_per_hour')::integer then
    return clued_private.agent_message_reject('agent_message_rate_limited',
      jsonb_build_object('limit','sends_per_binding_per_hour',
        'retry_after',greatest(1,ceil(extract(epoch from (v_oldest+interval '1 hour'-v_now)))::integer)));
  end if;

  if v_reply_to is not null then
    select * into v_parent from clued_private.agent_messages_v1 m
      where m.user_id=v_binding.user_id and m.message_id=v_reply_to and m.expires_at>v_now for update;
    if not found then return clued_private.agent_message_reject('agent_message_not_found',null); end if;
    if v_parent.closed_at is not null then
      return clued_private.agent_message_reject('agent_message_thread_closed',
        jsonb_build_object('thread_id',v_parent.thread_id)); end if;
    v_context:=v_parent.context_key;
    v_thread:=v_parent.thread_id;
    if v_parent.sender_binding_id=v_binding.id
      and coalesce(v_parent.sender_session_ref,'')=coalesce(v_session,'') then
      -- A follow-up from the original sender goes on to the original recipient.
      v_to_claim:=v_parent.to_claim_id; v_to_binding:=v_parent.to_binding_id; v_to_session:=v_parent.to_session_ref;
    elsif clued_private.agent_message_addressed(v_parent,v_binding.id,v_session) then
      v_to_claim:=null; v_to_binding:=v_parent.sender_binding_id; v_to_session:=v_parent.sender_session_ref;
      v_answers:=v_parent.kind='request';
    else
      return clued_private.agent_message_reject('agent_message_not_participant',null);
    end if;
    if v_to_claim is not null and not clued_private.agent_message_claim_live(v_to_claim) then
      v_to_claim:=null; end if;
  elsif v_to ? 'claim_id' then
    v_to_claim:=clued_private.agent_message_uuid(v_to->>'claim_id','agent_message_target_invalid');
    select * into v_claim from clued_private.work_claims_v1 c
      where c.user_id=v_binding.user_id and c.claim_id=v_to_claim;
    if not found then return clued_private.agent_message_reject('agent_message_claim_not_found',null); end if;
    if not clued_private.agent_message_claim_live(v_to_claim) then
      return clued_private.agent_message_reject('agent_message_claim_not_live',
        jsonb_build_object('claim_id',v_claim.claim_id,'claim_status',v_claim.status)); end if;
    if v_claim.holder_binding_id=v_binding.id
      and coalesce(v_claim.holder_session_ref,'')=coalesce(v_session,'') then
      return clued_private.agent_message_reject('agent_message_to_self',null); end if;
    v_context:=v_claim.context_key; v_thread:=v_message_id;
    v_to_binding:=v_claim.holder_binding_id; v_to_session:=v_claim.holder_session_ref;
  else
    v_to_binding:=clued_private.agent_message_uuid(v_to->>'binding_id','agent_message_target_invalid');
    v_to_session:=clued_private.agent_message_session(v_to->>'session_ref');
    if v_to_binding=v_binding.id and coalesce(v_to_session,'')=coalesce(v_session,'') then
      return clued_private.agent_message_reject('agent_message_to_self',null); end if;
    v_context:=v_scope; v_thread:=v_message_id;
  end if;

  -- The caller must be able to write the message's context, and the recipient
  -- Binding must be live and able to read it, or the message would never arrive.
  if v_context<>v_scope then
    v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_context); end if;
  select * into v_target from public.clued_agent_bindings b
    where b.id=v_to_binding and b.user_id=v_binding.user_id;
  if not found then return clued_private.agent_message_reject('agent_message_recipient_not_found',null); end if;
  if v_target.revoked_at is not null or (to_jsonb(v_target)->>'expires_at')::timestamptz<=v_now
    or not('context:read'=any(v_target.scopes))
    or not('*'=any(v_target.context_keys) or v_context=any(v_target.context_keys)) then
    return clued_private.agent_message_reject('agent_message_recipient_cannot_read',
      jsonb_build_object('context_key',v_context)); end if;

  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,v_context,'agent_message_send','agent_message',
    v_message_id::text,1,jsonb_build_object('receipt_kind','AGENT_MESSAGE_SENT',
      'message_id',v_message_id,'thread_id',v_thread,'reply_to',v_reply_to,'kind',v_kind,
      'sender_session_ref',v_session,'to_claim_id',v_to_claim,'to_binding_id',v_to_binding,
      'to_session_ref',v_to_session,'refs',to_jsonb(v_refs),'answers',v_answers,'close_thread',v_close,
      'subject_chars',char_length(v_subject),'body_chars',char_length(v_body)))
  returning id into v_receipt;

  insert into clued_private.agent_messages_v1(message_id,user_id,context_key,thread_id,reply_to,kind,
    sender_binding_id,sender_session_ref,to_claim_id,to_binding_id,to_session_ref,subject,body,refs,
    idempotency_key,request_hash,created_at,expires_at,receipt_id)
  values(v_message_id,v_binding.user_id,v_context,v_thread,v_reply_to,v_kind,
    v_binding.id,v_session,v_to_claim,v_to_binding,v_to_session,v_subject,v_body,v_refs,
    p_input->>'idempotency_key',v_hash,v_now,
    v_now+make_interval(secs=>(v_profile->>'retention_seconds')::integer),v_receipt)
  returning * into v_message;

  if v_answers then
    update clued_private.agent_messages_v1 set answered_at=v_now
      where message_id=v_parent.message_id and answered_at is null;
  end if;
  if v_reply_to is not null then
    -- Replying reads what you answer.
    update clued_private.agent_messages_v1 set read_at=v_now
      where message_id=v_parent.message_id and read_at is null
        and clued_private.agent_message_addressed(v_parent,v_binding.id,v_session);
  end if;
  if v_close then
    update clued_private.agent_messages_v1 set closed_at=v_now
      where user_id=v_binding.user_id and thread_id=v_thread and closed_at is null;
    select * into v_message from clued_private.agent_messages_v1 where message_id=v_message_id;
  end if;

  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'message',clued_private.agent_message_view(v_message,false));
end $$;

-- clued_agent_inbox_v1: {scope?, session_ref?, view?: open|unread|all|sent,
--   thread_id?, limit?, mark_read?}
-- open (default): incoming messages of threads not closed; unread: incoming
-- messages not yet read; all: every incoming message; sent: what the caller
-- sent. thread_id returns that whole thread when the caller takes part in it.
-- Returned incoming messages are marked read unless mark_read is false.
create function public.clued_agent_inbox_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_session text; v_view text:=coalesce(p_input->>'view','open'); v_thread uuid; v_limit integer;
  v_mark boolean; v_ids uuid[]; v_out jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_session:=clued_private.agent_message_session(p_input->>'session_ref');
  if v_view not in ('open','unread','all','sent') then
    raise exception 'agent_message_view_invalid' using errcode='22023'; end if;
  v_thread:=clued_private.agent_message_uuid(p_input->>'thread_id','agent_message_thread_id_invalid');
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
          and clued_private.agent_message_is_sender(m,v_binding.id,v_session)
        order by m.created_at desc,m.message_id limit v_limit) x;
  else
    select coalesce(array_agg(x.message_id order by x.created_at desc,x.message_id),'{}'::uuid[]) into v_ids from (
      select m.message_id,m.created_at from clued_private.agent_messages_v1 m
        where m.user_id=v_binding.user_id and m.expires_at>v_now
          and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))
          and clued_private.agent_message_addressed(m,v_binding.id,v_session)
          and (v_view='all' or (v_view='open' and m.closed_at is null)
            or (v_view='unread' and m.read_at is null))
        order by m.created_at desc,m.message_id limit v_limit) x;
  end if;

  -- The answer shows each message as it was before this read marked it.
  select coalesce(jsonb_agg(clued_private.agent_message_view(m,true)
      ||jsonb_build_object('direction',case
        when clued_private.agent_message_addressed(m,v_binding.id,v_session) then 'incoming'
        else 'outgoing' end)
      order by u.o),'[]'::jsonb)
    into v_out
    from unnest(v_ids) with ordinality u(id,o)
    join clued_private.agent_messages_v1 m on m.message_id=u.id;

  if v_mark and v_view<>'sent' then
    update clued_private.agent_messages_v1 m set read_at=v_now
      where m.message_id=any(v_ids) and m.read_at is null
        and clued_private.agent_message_addressed(m,v_binding.id,v_session);
  end if;

  return jsonb_build_object('status','ok','observed_at',v_now,'view',
      case when v_thread is null then v_view else 'thread' end,
    'thread_id',v_thread,'session_ref',v_session,'messages',v_out,
    'returned',jsonb_array_length(v_out),'profile',clued_private.agent_message_profile_v1());
end $$;

-- clued_agent_inbox_summary_v1: {scope?, session_ref?, claim_id?}. Reads
-- only; the Worker folds it into clued_session_resume (and, with claim_id, into
-- a clued_work_renew answer: only messages sent to that claim) as agent_inbox.
create function public.clued_agent_inbox_summary_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_session text; v_claim uuid; v_unread integer; v_open_requests integer; v_awaiting integer; v_latest jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  v_session:=clued_private.agent_message_session(p_input->>'session_ref');
  v_claim:=clued_private.agent_message_uuid(p_input->>'claim_id','agent_message_claim_id_invalid');
  with incoming as (
    select m.* from clued_private.agent_messages_v1 m
      where m.user_id=v_binding.user_id and m.expires_at>v_now
        and (v_claim is null or m.to_claim_id=v_claim)
        and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))
        and clued_private.agent_message_addressed(m,v_binding.id,v_session))
  select count(*) filter (where i.read_at is null and i.closed_at is null)::integer,
      count(*) filter (where i.kind='request' and i.answered_at is null and i.closed_at is null)::integer
    into v_unread,v_open_requests from incoming i;
  select count(*)::integer into v_awaiting from clued_private.agent_messages_v1 m
    where v_claim is null and m.user_id=v_binding.user_id and m.expires_at>v_now and m.kind='request'
      and m.answered_at is null and m.closed_at is null
      and clued_private.agent_message_is_sender(m,v_binding.id,v_session);
  select coalesce(jsonb_agg(x.v order by x.created_at desc),'[]'::jsonb) into v_latest from (
    select clued_private.agent_message_view(m,false) v,m.created_at
      from clued_private.agent_messages_v1 m
      where m.user_id=v_binding.user_id and m.expires_at>v_now and m.read_at is null and m.closed_at is null
        and (v_claim is null or m.to_claim_id=v_claim)
        and ('*'=any(v_binding.context_keys) or m.context_key=any(v_binding.context_keys))
        and clued_private.agent_message_addressed(m,v_binding.id,v_session)
      order by m.created_at desc,m.message_id limit 5) x;
  return jsonb_build_object('status','ok','observed_at',v_now,'session_ref',v_session,'claim_id',v_claim,
    'unread_count',v_unread,'open_request_count',v_open_requests,'awaiting_reply_count',v_awaiting,
    'latest_unread',v_latest);
end $$;

revoke all on function
  clued_private.agent_message_profile_v1(),
  clued_private.agent_message_claim_live(uuid),
  clued_private.agent_message_addressed(clued_private.agent_messages_v1,uuid,text),
  clued_private.agent_message_is_sender(clued_private.agent_messages_v1,uuid,text),
  clued_private.agent_message_view(clued_private.agent_messages_v1,boolean),
  clued_private.agent_message_session(text),
  clued_private.agent_message_normalize_refs(jsonb),
  clued_private.agent_message_uuid(text,text),
  clued_private.agent_message_reject(text,jsonb),
  clued_private.agent_message_lock(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_agent_message_send_v1(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.clued_agent_inbox_v1(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.clued_agent_inbox_summary_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_agent_message_send_v1(text,jsonb) to anon;
grant execute on function public.clued_agent_inbox_v1(text,jsonb) to anon;
grant execute on function public.clued_agent_inbox_summary_v1(text,jsonb) to anon;

-- Delegated OAuth reaches the same Binding entries as a clued_bnd_ token
-- (same anchor patch as 20261001080000).
do $migration$
declare body text; anchor text:=$anchor$    else raise exception 'unknown_oauth_tool' using errcode='22023';$anchor$;
begin
  body:=pg_get_functiondef('public.clued_oauth_call(text,jsonb)'::regprocedure);
  if strpos(body,anchor)=0 or strpos(body,'clued_agent_message')>0 then
    raise exception 'oauth_call_definition_mismatch';
  end if;
  execute replace(body,anchor,$cases$    when 'clued_agent_message_send' then return public.clued_agent_message_send_v1(v_binding.token_hash,v_input);
    when 'clued_agent_inbox' then return public.clued_agent_inbox_v1(v_binding.token_hash,v_input);
    when 'clued_agent_inbox_summary' then return public.clued_agent_inbox_summary_v1(v_binding.token_hash,v_input);
$cases$||anchor);
end $migration$;

notify pgrst,'reload schema';
