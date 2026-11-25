-- Release provenance is part of the claim's readable state. Historical rows
-- stay nullable. No lease, admission, continuation or PR-ending gate changes.
alter table clued_private.work_claims_v1
  add column released_by text check (released_by in ('holder','pr_end','expiry','hard_deadline','takeover','copy_adoption')),
  add column released_evidence_ref text,
  add column released_at timestamptz;

-- All existing terminal transitions, including supersession of an expired
-- claim and race losers. DRAINING and Owner handover remain live, not releases.
create function clued_private.work_claim_release_stamp_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status='RELEASED' then
    new.released_by:=coalesce(new.released_by,'holder');
    new.released_at:=new.updated_at;
  elsif new.status='EXPIRED' then
    new.released_by:=case when new.expires_at>=new.hard_deadline_at then 'hard_deadline' else 'expiry' end;
    new.released_evidence_ref:=null;
    new.released_at:=new.expires_at;
  elsif new.status='SUPERSEDED' then
    new.released_by:=case when new.outcome='not_adopted' then 'copy_adoption' else 'takeover' end;
    new.released_evidence_ref:='claim:'||new.superseded_by::text;
    new.released_at:=new.updated_at;
  end if;
  return new;
end $$;
create trigger work_claim_release_stamp_v1 before update on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_release_stamp_v1();

-- Read-only expiry projections must be as clear as persisted expiry. Do not
-- pretend that an old terminal row with no recorded source has one.
create function clued_private.work_claim_release_view_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'released_by',case when c.released_by is null and c.status in ('ACTIVE','DRAINING')
        and c.expires_at<=pg_catalog.clock_timestamp()
      then case when c.expires_at>=c.hard_deadline_at then 'hard_deadline' else 'expiry' end else c.released_by end,
    'released_evidence_ref',c.released_evidence_ref,
    'released_at',case when c.released_at is null and c.status in ('ACTIVE','DRAINING')
        and c.expires_at<=pg_catalog.clock_timestamp() then c.expires_at else c.released_at end)
$$;

-- Preserve every field added by later migrations and the original ACLs.
do $release_views$
declare signature text; body text; anchor text:='select jsonb_build_object(';
begin
  foreach signature in array array[
    'clued_private.work_claim_view(clued_private.work_claims_v1)',
    'clued_private.work_claim_owner_row_v1(clued_private.work_claims_v1)'] loop
    body:=pg_catalog.pg_get_functiondef(signature::regprocedure);
    if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
      raise exception 'work_claim_release_view_source_unexpected: %',signature; end if;
    execute replace(body,anchor,'select clued_private.work_claim_release_view_v1(c)||jsonb_build_object(');
  end loop;
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_conflicts(uuid,uuid,text[],text[],uuid)'::regprocedure);
  anchor:=$a$jsonb_build_array(jsonb_build_object('claim_id',c.claim_id$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_release_conflicts_source_unexpected'; end if;
  execute replace(body,anchor,
    $a$jsonb_build_array(clued_private.work_claim_release_view_v1(c)||jsonb_build_object('claim_id',c.claim_id$a$);
  -- The holder's evidence is already validated and recorded in its release
  -- Receipt. Store it in the UPDATE too, so RETURNING and conflicts see it.
  body:=pg_catalog.pg_get_functiondef('public.clued_work_release_v1(text,jsonb)'::regprocedure);
  anchor:=$a$set status='RELEASED',released_outcome=v_outcome,$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_release_source_unexpected'; end if;
  execute replace(body,anchor,anchor||$a$
      released_by='holder',released_evidence_ref=p_input->>'evidence_ref',$a$);
end $release_views$;

-- A system notification uses the existing claim-addressed inbox and retention,
-- with the original holder/session pinned after the claim ends. The caller is
-- the qualified CI Binding, never a fabricated holder or Owner. Its failure
-- is caught by the release function below, outside the release/Receipt writes.
create function clued_private.work_claim_pr_end_notify_v1(
  b public.clued_agent_bindings,c clued_private.work_claims_v1,p_pr text,p_status text,p_merge text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare message uuid:=extensions.gen_random_uuid(); receipt uuid; body text;
  idem text:='pr-end-release:'||c.claim_id::text; at timestamptz:=pg_catalog.clock_timestamp();
  refs text[]:=array['claim:'||c.claim_id::text,'task:'||c.task_id::text,'pr:'||p_pr];
begin
  perform clued_private.agent_message_lock(c.user_id);
  if not clued_private.agent_messages_enabled_v1(c.user_id) then return; end if;
  if exists(select 1 from clued_private.agent_messages_v1 m where m.user_id=c.user_id
      and m.sender_binding_id=b.id and m.idempotency_key=idem) then return; end if;
  body:=format('认领 %s 已因 %s %s（%s）于 %s 自动释放，Task %s',c.claim_id,p_pr,
    case when p_status='merged' then '合入' else '关闭' end,
    coalesce(left(p_merge,8),'合并 SHA 不可得'),
    to_char(c.released_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),c.task_id);
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,b.id,c.context_key,'agent_message_send','agent_message',message::text,1,
    jsonb_build_object('receipt_kind','AGENT_MESSAGE_SENT','message_id',message,'thread_id',message,'kind','info',
      'to_claim_id',c.claim_id,'to_binding_id',c.holder_binding_id,'to_session_ref',c.holder_session_ref,
      'refs',to_jsonb(refs),'source','work_claim_pr_end','subject_chars',char_length('认领已自动释放'),'body_chars',char_length(body)))
  returning id into receipt;
  insert into clued_private.agent_messages_v1(message_id,user_id,context_key,thread_id,kind,sender_binding_id,
    to_claim_id,to_binding_id,to_session_ref,subject,body,refs,idempotency_key,request_hash,created_at,expires_at,receipt_id)
  values(message,c.user_id,c.context_key,message,'info',b.id,c.claim_id,c.holder_binding_id,c.holder_session_ref,
    '认领已自动释放',body,refs,idem,encode(extensions.digest(body,'sha256'),'hex'),at,
    at+make_interval(secs=>(clued_private.agent_message_profile_v1()->>'retention_seconds')::integer),receipt);
end $$;

-- Same two release conditions as 20261113151000; the merge SHA is supplied
-- directly by adopt, never inferred from an authorized head or a text search.
create function clued_private.work_claim_pr_end_release_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_merge_sha text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare pr text:=lower(p_pr); target clued_private.work_claim_pr_task_bindings_v1;
  c clued_private.work_claims_v1; since timestamptz; merge_sha text:=lower(p_merge_sha);
begin
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=split_part(pr,'#',1) and pr_number=split_part(pr,'#',2)::bigint;
  if not found or target.status not in ('merged','closed') then return; end if;
  if target.status<>'merged' or coalesce(merge_sha,'') !~ '^[0-9a-f]{7,64}$' then merge_sha:=null; end if;
  if exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 o where o.user_id=target.user_id
      and o.task_id=target.task_id and o.status in ('active','unknown')) then return; end if;
  for c in select * from clued_private.work_claims_v1 w where w.user_id=target.user_id and w.task_id=target.task_id
      and w.context_key=p_scope and w.status='ACTIVE' for update loop
    select max(x.at) into since from (
      select a.issued_at at from clued_private.work_claim_head_authorizations_v1 a
        where a.user_id=c.user_id and a.claim_id=c.claim_id and lower(a.pr_ref)=pr
      union all select e.created_at from clued_private.work_claim_execution_admissions_v1 e
        where e.user_id=c.user_id and e.claim_id=c.claim_id and lower(e.pr_ref)=pr) x;
    continue when since is null or exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
      where a.user_id=c.user_id and a.claim_id=c.claim_id and a.revoked_at is null and a.issued_at>since
        and lower(a.pr_ref) is distinct from pr);
    update clued_private.work_claims_v1 set status='RELEASED',released_outcome='completed',lease_key_hash=null,
      released_by='pr_end',released_evidence_ref=pr||coalesce('@'||merge_sha,''),
      updated_at=pg_catalog.clock_timestamp() where user_id=c.user_id and claim_id=c.claim_id returning * into c;
    -- Keep evidence_ref=PR unchanged for the existing free-continuation rule.
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(c.user_id,c.holder_binding_id,c.context_key,'work_claim_release','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('receipt_kind','WORK_CLAIM_RELEASED','claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,
        'outcome','completed','evidence_ref',pr,'status','RELEASED','released_by_binding_id',b.id,
        'released_by',c.released_by,'released_evidence_ref',c.released_evidence_ref,'released_at',c.released_at));
    begin
      perform clued_private.work_claim_pr_end_notify_v1(b,c,pr,target.status,merge_sha);
    exception when others then
      raise warning 'work_claim_pr_end_notification_skipped: % %',sqlstate,sqlerrm;
    end;
  end loop;
end $$;

-- Retain the old private signature for internal compatibility, with the same
-- visibility guarantees when a historical caller has no merge SHA.
create or replace function clued_private.work_claim_pr_end_release_v1(b public.clued_agent_bindings,p_scope text,p_pr text)
returns void language sql volatile security definer set search_path='' as $$
  select clued_private.work_claim_pr_end_release_v1(b,p_scope,p_pr,null)
$$;

do $release_doors$
declare signature text; body text;
  anchor text:=$a$work_claim_pr_end_release_v1(b,coalesce(p_input->>'scope','global'),p_input->>'pr_ref')$a$;
begin
  foreach signature in array array['public.clued_work_claim_adopt_v1(text,jsonb)',
      'public.clued_work_merge_slot_return_v1(text,jsonb)'] loop
    body:=pg_catalog.pg_get_functiondef(signature::regprocedure);
    if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
      raise exception 'work_claim_pr_end_source_unexpected: %',signature; end if;
    execute replace(body,anchor,
      $a$work_claim_pr_end_release_v1(b,coalesce(p_input->>'scope','global'),p_input->>'pr_ref',p_input->>'merge_sha')$a$);
  end loop;
end $release_doors$;

revoke all on function clued_private.work_claim_release_stamp_v1(),
  clued_private.work_claim_release_view_v1(clued_private.work_claims_v1),
  clued_private.work_claim_pr_end_notify_v1(public.clued_agent_bindings,clued_private.work_claims_v1,text,text,text),
  clued_private.work_claim_pr_end_release_v1(public.clued_agent_bindings,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

notify pgrst,'reload schema';
