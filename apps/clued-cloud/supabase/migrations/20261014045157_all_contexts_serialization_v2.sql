-- AllContextsAuthorization r2 §4.2. The source migration deliberately leaves
-- activation closed. Install early writer entrances without changing RPC OIDs,
-- ACLs, credential verification, Native confirmation, or mutation semantics.
-- Owner mutex -> existing Binding(s) -> Authorization -> nonce -> Context ->
-- parent Project -> grant CAS. Ordinary Record readers/writers do not take it.

create function clued_private.authorization_writer_binding_hint_v2(p_proof text) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare owner_hint uuid;
begin
  -- A coordination hint is not authentication or an admission. The caller
  -- must re-resolve the credential in a new statement after waiting.
  if p_proof is null or p_proof !~ '^[0-9a-f]{64}$' then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  select b.user_id into owner_hint from public.clued_agent_bindings b
    where b.token_hash=clued_private.credential_verifier_v1(p_proof);
  if owner_hint is null then raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_writer_guard_v2(owner_hint);
  return owner_hint;
end $$;

create function clued_private.authorization_writer_gateway_hint_v2(p_proof text) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare claims jsonb;
begin
  begin claims:=coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
  exception when invalid_text_representation then raise exception 'worker_gateway_required' using errcode='42501'; end;
  if current_setting('role',true) is distinct from 'clued_worker_gateway'
    or jsonb_typeof(claims) is distinct from 'object' or claims->>'role' is distinct from 'clued_worker_gateway' then
    raise exception 'worker_gateway_required' using errcode='42501'; end if;
  return clued_private.authorization_writer_binding_hint_v2(p_proof);
end $$;

create function clued_private.authorization_writer_lock_binding_v2(p_owner uuid,p_binding uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
  perform clued_private.authorization_writer_require_v2(p_owner);
  perform 1 from public.clued_agent_bindings b where b.id=p_binding and b.user_id=p_owner for update;
  if not found then raise exception 'owned_binding_required' using errcode='42501'; end if;
  perform 1 from clued_private.authorizations_v12 a where a.binding_id=p_binding and a.owner_id=p_owner for update;
end $$;

-- Fan-out must not start after a high-UUID creator Binding has been locked.
-- Prelock the union (old project policy, new contexts policy, actual caller)
-- once, in global Binding UUID order, before the real resolver or Project/C.
create function clued_private.authorization_writer_lock_fanout_v2(p_owner uuid,p_extra uuid[] default '{}') returns void
language plpgsql volatile security definer set search_path='' as $$
declare target uuid;
begin
  perform clued_private.authorization_writer_require_v2(p_owner);
  for target in select b.id from public.clued_agent_bindings b
    where b.user_id=p_owner and (b.id=any(p_extra) or (b.revoked_at is null and exists(
      select 1 from clued_private.authorizations_v12 a where a.binding_id=b.id and a.revoked_at is null
      and a.expires_at>clock_timestamp() and (exists(select 1 from clued_private.authorization_entries_v12 e
        where e.binding_id=b.id and e.resource_kind='scope' and e.resource_id in ('project:*','contexts:*'))
        or exists(select 1 from clued_private.authorization_sources_v2 s where s.binding_id=b.id
          and s.kind in ('legacy_project_policy','contexts_policy') and s.revoked_at is null and s.expires_at>clock_timestamp())))))
    order by b.id loop
    perform clued_private.authorization_writer_lock_binding_v2(p_owner,target);
  end loop;
end $$;
create function clued_private.authorization_writer_project_hint_v2(p_proof text,p_gateway boolean) returns void
language plpgsql volatile security definer set search_path='' as $$
declare owner_hint uuid; binding_hint uuid;
begin
  owner_hint:=case when p_gateway then clued_private.authorization_writer_gateway_hint_v2(p_proof)
    else clued_private.authorization_writer_binding_hint_v2(p_proof) end;
  select b.id into binding_hint from public.clued_agent_bindings b
    where b.token_hash=clued_private.credential_verifier_v1(p_proof) and b.user_id=owner_hint;
  perform clued_private.authorization_writer_lock_fanout_v2(owner_hint,array[binding_hint]);
end $$;

-- Storage activation creates a Project. Its old declaration initializer
-- called storage_owner_v1 and locked auth.users/auth.sessions before the Owner
-- mutex. This unlocked Native hint only identifies the coordination target;
-- the original storage_owner_v1 must authenticate again after every wait.
create function clued_private.authorization_writer_storage_native_hint_v2() returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare owner_hint uuid:=auth.uid(); session_hint uuid;
begin
  if owner_hint is null or nullif(auth.jwt()->>'client_id','') is not null then
    raise exception 'direct_human_session_required' using errcode='42501'; end if;
  begin session_hint:=(auth.jwt()->>'session_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'storage_native_session_required' using errcode='42501'; end;
  if session_hint is null or not exists(select 1 from auth.sessions s
    where s.id=session_hint and s.user_id=owner_hint
      and (to_jsonb(s)->>'not_after' is null or (to_jsonb(s)->>'not_after')::timestamptz>clock_timestamp())) then
    raise exception 'storage_native_session_required' using errcode='42501'; end if;
  return owner_hint;
end $$;

-- A Context Owner may revoke a saved shared grant whose Binding belongs to
-- its invited subject. Discover that second Owner without row locks, take the
-- Owner union in UUID order, then the actual core revalidates the saved grant.
create function clued_private.authorization_writer_native_context_v2(p_owner uuid,p_input jsonb) returns void
language plpgsql volatile security definer set search_path='' as $$
declare other_owner uuid; owner_id uuid;
begin
  if p_input->>'op'='grant_revoke' then
    select b.user_id into other_owner from clued_private.development_grants_v14 g
      join clued_private.development_spaces_v14 c on c.id=g.context_id and c.owner_id=p_owner
      join public.clued_agent_bindings b on b.id=g.binding_id
      where g.id=(p_input->>'grant_id')::uuid and c.id=(p_input->>'context_id')::uuid;
  end if;
  for owner_id in select distinct x from unnest(array[p_owner,other_owner]) x where x is not null order by x loop
    perform clued_private.authorization_writer_guard_v2(owner_id);
  end loop;
end $$;

-- Both confirmation operations locate the real target from server rows before
-- owner_grant_lock/token locks. The supplied input never supplies its Binding.
create function clued_private.authorization_writer_permission_request_v2(p_owner uuid,p_request uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare req clued_private.owner_requests_v1;
begin
  select * into req from clued_private.owner_requests_v1 where id=p_request and user_id=p_owner;
  if req.action is distinct from 'connection.permission' then return; end if;
  perform clued_private.authorization_writer_guard_v2(p_owner);
  perform clued_private.authorization_writer_lock_binding_v2(p_owner,req.binding_id);
end $$;
create function clued_private.authorization_writer_permission_token_v2(p_owner uuid,p_token text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare choices jsonb; target uuid;
begin
  select t.native_choices into choices from clued_private.native_confirmation_tokens t
    where t.user_id=p_owner and t.action='owner_grant'
      and t.token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  if choices->>'action' is distinct from 'connection.permission' then return; end if;
  perform clued_private.authorization_writer_guard_v2(p_owner);
  -- Re-read after the mutex; only the original consumer validates and consumes.
  select t.native_choices into choices from clued_private.native_confirmation_tokens t
    where t.user_id=p_owner and t.action='owner_grant'
      and t.token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  select r.binding_id into target from clued_private.owner_requests_v1 r
    where r.id=(choices->>'request_id')::uuid and r.user_id=p_owner and r.action='connection.permission';
  if target is null or target is distinct from (choices->>'grantee_binding_id')::uuid then
    raise exception 'owner_grant_choice_invalid' using errcode='42501'; end if;
  perform clued_private.authorization_writer_lock_binding_v2(p_owner,target);
end $$;
create function clued_private.authorization_writer_headless_token_v2(p_owner uuid,p_token text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare choices jsonb;
begin
  perform clued_private.authorization_writer_guard_v2(p_owner);
  select t.native_choices into choices from clued_private.native_confirmation_tokens t
    where t.user_id=p_owner and t.action='headless_binding'
      and t.token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  if choices->>'replaces_binding_id' is not null then
    perform clued_private.authorization_writer_lock_binding_v2(p_owner,(choices->>'replaces_binding_id')::uuid);
  end if;
end $$;

-- Migration-only, exact anchored patches preserve pg_proc identity and ACL.
create function clued_private.authorization_serialization_patch_v2(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare definition text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(definition)-length(replace(definition,p_anchor,'')))<>length(p_anchor) then
    raise exception 'authorization_serialization_anchor_changed: %',p_signature
      using detail=jsonb_build_object('matches',(length(definition)-length(replace(definition,p_anchor,'')))/length(p_anchor),
        'source_hash',md5(definition),'source_start',substr((select prosrc from pg_proc where oid=p_signature::regprocedure),1,1200))::text;
  end if;
  execute replace(definition,p_anchor,p_replacement);
end $$;

-- Native management begins before its idempotency lock or any Context lock.
select clued_private.authorization_serialization_patch_v2('public.clued_development_owner_v14(jsonb)',
  $a$ return clued_private.development_execute_v14(actor,null,true,p_input);$a$,
  $a$ if p_input->>'op'<>'owner_list' then perform clued_private.authorization_writer_native_context_v2(actor,p_input); end if;
 return clued_private.development_execute_v14(actor,null,true,p_input);$a$);
select clued_private.authorization_serialization_patch_v2('clued_private.development_execute_before_authorization_v14(uuid,uuid,boolean,jsonb)',
  $a$ perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':owner:'||op||':'||ikey,0));$a$,
  $a$ -- ACTUAL_EARLY_WRITER_V2: before nonce, Context, Project or grant locks.
 perform clued_private.authorization_writer_require_v2(p_owner);
 if op='context_create' then
   perform clued_private.authorization_writer_lock_fanout_v2(p_owner);
 elsif op='grant_upsert' then
   perform clued_private.authorization_writer_lock_binding_v2(p_owner,(p_input->>'binding_id')::uuid);
 elsif op='grant_revoke' then
   declare actual_binding uuid; binding_owner uuid;
   begin
     select x.binding_id,bx.user_id into actual_binding,binding_owner from clued_private.development_grants_v14 x
       join clued_private.development_spaces_v14 s on s.id=x.context_id and s.owner_id=p_owner
       join public.clued_agent_bindings bx on bx.id=x.binding_id
       where x.id=(p_input->>'grant_id')::uuid and x.context_id=cid;
     if actual_binding is null then raise exception 'grant_version_conflict' using errcode='40001'; end if;
     perform clued_private.authorization_writer_lock_binding_v2(binding_owner,actual_binding);
   end;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':owner:'||op||':'||ikey,0));$a$);
select clued_private.authorization_serialization_patch_v2('clued_private.development_execute_before_authorization_v14(uuid,uuid,boolean,jsonb)',
  $a$   select * into g from clued_private.development_grants_v14 where context_id=cid and binding_id=b.id;$a$,
  $a$   select * into g from clued_private.development_grants_v14 where context_id=cid and binding_id=b.id for update;
   if found and (g.revoked_at is not null or g.expires_at<=clock_timestamp()) then
     raise exception 'explicit_grant_confirmation_required' using errcode='42501'; end if;
   if found and ((p_input->>'expires_at')::timestamptz>g.expires_at or not(v_actions <@ g.actions)) then
     raise exception 'explicit_grant_confirmation_required' using errcode='42501'; end if;$a$);
select clued_private.authorization_serialization_patch_v2('clued_private.development_execute_before_authorization_v14(uuid,uuid,boolean,jsonb)',
  $a$ update clued_private.development_operations_v14 set result=v_result where id=operation_row.id;
 return v_result;$a$,
  $a$ update clued_private.development_operations_v14 set result=v_result where id=operation_row.id;
 if g.id is not null and op in ('grant_upsert','grant_revoke') then
   perform clued_private.authorization_grant_changed_v2(g.binding_id,cid,operation_row.receipt_id,op);
 end if;
 return v_result;$a$);

-- OAuth approval can replay an existing B: lock it before the Request too.
select clued_private.authorization_serialization_patch_v2('clued_private.ii_pub_clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)',
  $a$ select * into r from clued_private.authorization_requests_v12 where id=p_request_id and owner_id=u for update;$a$,
  $a$ perform clued_private.authorization_writer_guard_v2(u);
 select * into r from clued_private.authorization_requests_v12 where id=p_request_id and owner_id=u;
 if r.binding_id is not null then perform clued_private.authorization_writer_lock_binding_v2(u,r.binding_id); end if;
 select * into r from clued_private.authorization_requests_v12 where id=p_request_id and owner_id=u for update;$a$);

-- The source successor's list is diagnostic only; changes require early mutex.
select clued_private.authorization_serialization_patch_v2('public.clued_authorization_manage_v12(jsonb)',
  $a$
begin
$a$,
  $a$
begin
 if p_input->>'op'<>'list' then
   perform clued_private.authorization_writer_guard_v2(u);
 end if;
$a$);

select clued_private.authorization_serialization_patch_v2('public.clued_owner_grant_confirmation_issue_v1(jsonb)',
  $a$    perform clued_private.owner_grant_lock_v1(v_owner);$a$,
  $a$    if p_input->>'request_id' is not null then
      perform clued_private.authorization_writer_permission_request_v2(v_owner,(p_input->>'request_id')::uuid);
    end if;
    perform clued_private.owner_grant_lock_v1(v_owner);$a$);
select clued_private.authorization_serialization_patch_v2('public.clued_owner_grant_v1(jsonb)',
  $a$    perform clued_private.owner_grant_lock_v1(v_owner);$a$,
  $a$    perform clued_private.authorization_writer_permission_token_v2(v_owner,p_input->>'confirmation_token');
    perform clued_private.owner_grant_lock_v1(v_owner);$a$);

-- Request producers (including production requests) must not wait for the mutex
-- while holding B SHARE: take the hint before either real resolver branch.
select clued_private.authorization_serialization_patch_v2('public.clued_owner_request_v1(text,jsonb)',
  $a$  v_binding:=case when p_input->>'action'='connection.permission'$a$,
  $a$  perform clued_private.authorization_writer_gateway_hint_v2(p_token_hash);
  v_binding:=case when p_input->>'action'='connection.permission'$a$);

select clued_private.authorization_serialization_patch_v2('public.clued_headless_binding_issue_v1(jsonb)',
  $a$    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');$a$,
  $a$    perform clued_private.authorization_writer_headless_token_v2(v_owner,p_input->>'confirmation_token');
    v_hash:=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');$a$);
select clued_private.authorization_serialization_patch_v2('public.clued_headless_binding_revoke_v1(jsonb)',
  $a$  v_id:=(p_input->>'binding_id')::uuid;$a$,
  $a$  perform clued_private.authorization_writer_guard_v2(v_owner);
  v_id:=(p_input->>'binding_id')::uuid;$a$);

-- Existing private project cores cannot acquire the guard late: they require
-- the early caller protocol. The retired mutate alias retains its sealed body.
do $project_entrances$
declare sig text; definition text; source text; anchor text; added text;
begin
  foreach sig in array array['public.clued_project_observe(text,jsonb)',
      'public.clued_project_update(text,jsonb)',
      'public.clued_project_mutate_v2(text,jsonb)'] loop
    source:=(select prosrc from pg_proc where oid=sig::regprocedure);
    anchor:=substring(source from E'(?i)\\nbegin\\n');
    if anchor is null then raise exception 'authorization_project_entrance_changed: %',sig; end if;
    added:=anchor||'  perform clued_private.authorization_writer_project_hint_v2(p_token_hash,'||
      case when sig='public.clued_project_mutate_v2(text,jsonb)' then 'true' else 'false' end||');'||E'\n';
    perform clued_private.authorization_serialization_patch_v2(sig,anchor,added);
  end loop;
  foreach sig in array array['clued_private.project_observe_core(uuid,uuid,jsonb)',
      'clued_private.project_update_core(uuid,uuid,jsonb)',
      'clued_private.project_mutation_core(uuid,uuid,jsonb,text)',
      'clued_private.project_mutation_core_v2(uuid,uuid,jsonb,text)'] loop
    source:=(select prosrc from pg_proc where oid=sig::regprocedure);
    anchor:=substring(source from E'(?i)\\nbegin\\n');
    if anchor is null then raise exception 'authorization_project_core_changed: %',sig; end if;
    perform clued_private.authorization_serialization_patch_v2(sig,anchor,
      anchor||'  perform clued_private.authorization_writer_require_v2(p_user_id);'||E'\n');
  end loop;
end $project_entrances$;

-- Outermost Native activation, before account/session SHARE, issuer SHARE,
-- attempt expiry writes, attempt UPDATE or storage-owner advisory locks.
-- The original body, issuer verifier, disclosure/gate/master seals and final
-- session/attempt rechecks remain intact. Other actions keep their old verifier.
select clued_private.authorization_serialization_patch_v2('public.clued_storage_onboard_v1(text,jsonb)',
  $a$declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action'; issuer text;$a$,
  $a$declare u uuid; op text:=p_input->>'action'; issuer text;$a$);
select clued_private.authorization_serialization_patch_v2('public.clued_storage_onboard_v1(text,jsonb)',
  $a$
begin
$a$,
  $a$
begin
  if op='activate' then
    u:=clued_private.authorization_writer_storage_native_hint_v2();
    perform clued_private.authorization_writer_guard_v2(u);
    perform clued_private.authorization_writer_lock_fanout_v2(u);
  end if;
  u:=clued_private.storage_owner_v1();
$a$);

-- Integration self-revocation also ends Bound credentials. Its first real
-- locks remain L1 sorted Bindings; coordinate before L1, never inside the core.
select clued_private.authorization_serialization_patch_v2('public.clued_integration_revoke_self_v1(text,jsonb)',
  $a$  -- unlocked discovery:$a$,
  $a$  perform clued_private.authorization_writer_gateway_hint_v2(p_token_hash);
  -- unlocked discovery:$a$);
select clued_private.authorization_serialization_patch_v2('public.clued_user_integration_v1(jsonb)',
  $a$  elsif v_op = 'revoke' then$a$,
  $a$  elsif v_op = 'revoke' then
    perform clued_private.authorization_writer_guard_v2(u);$a$);
select clued_private.authorization_serialization_patch_v2('public.clued_admin_integration_v1(jsonb)',
  $a$  elsif v_op = 'revoke' then$a$,
  $a$  elsif v_op = 'revoke' then
    perform clued_private.authorization_writer_guard_v2(v_owner);$a$);

create or replace function public.clued_user_project_observe(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.authorization_writer_guard_v2(actor);
  perform clued_private.authorization_writer_lock_fanout_v2(actor);
  return clued_private.project_observe_core(actor,null,p_input);
end $$;
create or replace function public.clued_user_project_update(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.authorization_writer_guard_v2(actor);
  perform clued_private.authorization_writer_lock_fanout_v2(actor);
  return clued_private.project_update_core(actor,null,p_input);
end $$;
create or replace function public.clued_user_project_mutate(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.authorization_writer_guard_v2(actor);
  perform clued_private.authorization_writer_lock_fanout_v2(actor);
  return clued_private.project_mutation_core(actor,null,p_input,p_received_payload_hash);
end $$;
create or replace function public.clued_user_project_mutate_v2(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=clued_private.authorization_owner_v12();
begin
  perform clued_private.authorization_writer_guard_v2(actor);
  perform clued_private.authorization_writer_lock_fanout_v2(actor);
  return clued_private.project_mutation_core_v2(actor,null,p_input,p_received_payload_hash);
end $$;

-- A bounded sweep acquires all Owner mutexes in UUID order before any B. A
-- concurrent writer can delay cleanup, but business expiry checks deny now.
create or replace function clued_private.binding_expiry_sweep_v1()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare now_at timestamptz:=clock_timestamp(); owners uuid[]; owner_id uuid; target record; result integer:=0;
begin
  select array_agg(distinct b.user_id order by b.user_id) into owners
    from public.clued_agent_bindings b where b.revoked_at is null and (
      exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=b.id and a.issuance='headless' and a.expires_at<=now_at)
      or exists(select 1 from clued_private.binding_retirements_v1 r where r.binding_id=b.id and r.retire_at<=now_at));
  foreach owner_id in array coalesce(owners,'{}') loop
    perform clued_private.authorization_writer_guard_v2(owner_id);
  end loop;
  for target in select b.id,b.user_id from public.clued_agent_bindings b
    where b.user_id=any(coalesce(owners,'{}')) and b.revoked_at is null and (
      exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=b.id and a.issuance='headless' and a.expires_at<=now_at)
      or exists(select 1 from clued_private.binding_retirements_v1 r where r.binding_id=b.id and r.retire_at<=now_at))
    order by b.user_id,b.id for update of b loop
    update public.clued_agent_bindings set revoked_at=now_at where id=target.id;
    update clued_private.authorizations_v12 set revoked_at=now_at,version=version+1 where binding_id=target.id and revoked_at is null;
    insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation) values(target.user_id,target.id,'expired');
    result:=result+1;
  end loop;
  return result;
end $$;

-- Revocation proof/issuer checks remain in the actual body after this hint.
select clued_private.authorization_serialization_patch_v2('public.clued_authorization_revoke_self_v12(text)',
  $a$ select * into b from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1(p_token_hash) for update;$a$,
  $a$ perform clued_private.authorization_writer_binding_hint_v2(p_token_hash);
 select * into b from public.clued_agent_bindings where token_hash=clued_private.credential_verifier_v1(p_token_hash) for update;$a$);
select clued_private.authorization_serialization_patch_v2('clued_private.ii_pub_clued_authorization_revoke_issuer_v12(text,uuid)',
  $a$ select * into b from public.clued_agent_bindings where id=p_binding_id for update;$a$,
  $a$ select * into b from public.clued_agent_bindings where id=p_binding_id;
 if not found then raise exception 'issuer_binding_not_authorized' using errcode='42501'; end if;
 perform clued_private.authorization_writer_guard_v2(b.user_id);
 select * into b from public.clued_agent_bindings where id=p_binding_id for update;$a$);

-- One union prevents own/member branches from locking C in opposite orders.
create or replace function clued_private.development_execute_v14(p_owner uuid,p_binding uuid,p_management boolean,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; entry_row clued_private.authorization_entries_v12;
 c clued_private.development_spaces_v14; rows jsonb:='[]';
begin
 if p_management then return clued_private.development_execute_before_membership_v14(p_owner,p_binding,true,p_input); end if;
 if p_input->>'op'<>'context_list' then
   select * into entry_row from clued_private.authorization_entries_v12 where binding_id=p_binding
     and resource_kind='context' and resource_id=p_input->>'context_id';
   if entry_row.qualification_id is not null then
     return clued_private.development_execute_authorized_v14(p_owner,p_binding,p_input);
   end if;
   return clued_private.development_execute_before_membership_v14(p_owner,p_binding,false,p_input);
 end if;
 perform clued_private.authorization_account_v12(p_owner);
 select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner for share;
 if not found or not clued_private.binding_live_v1(b) or not('context:read'=any(b.scopes)) then
   raise exception 'binding_not_authorized' using errcode='42501'; end if;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for share;
 if found and (a.revoked_at is not null or a.expires_at<=clock_timestamp()) then
   raise exception 'authorization_revoked_or_expired' using errcode='42501'; end if;
 if coalesce(p_input->>'mode','ordinary') not in ('ordinary','development_history') then
   raise exception 'invalid_context_mode' using errcode='22023'; end if;
 if p_input->>'mode'='development_history' then
   for c in select s.* from clued_private.development_spaces_v14 s
     where (s.owner_id=p_owner or exists(select 1 from clued_private.authorization_entries_v12 e
       where e.binding_id=p_binding and e.resource_kind='context' and e.resource_id=s.id::text
         and e.environment=s.environment and e.qualification_id is not null))
       and (not(p_input ? 'environment') or s.environment=p_input->>'environment') order by s.id loop
     if 'read'=any(clued_private.authorization_effective_actions_v13(p_binding,'context',c.id::text,c.environment)) then
       rows:=rows||jsonb_build_array(jsonb_build_object('id',c.id,'project_id',c.project_id,'name',c.name,
         'environment',c.environment,'version',c.version,'access_source',case when c.owner_id=p_owner then 'owner' else 'project_membership' end));
     end if;
   end loop;
 end if;
 return jsonb_build_object('status','ok','contexts',rows);
end $$;

-- Catalog qualification is kept as executable evidence; no new public RPCs.
do $qualification$
declare sig text;
begin
 foreach sig in array array[
   'public.clued_development_owner_v14(jsonb)',
   'public.clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)',
   'public.clued_authorization_manage_v12(jsonb)',
   'public.clued_owner_request_v1(text,jsonb)',
   'public.clued_owner_grant_v1(jsonb)',
   'public.clued_headless_binding_issue_v1(jsonb)',
   'public.clued_project_mutate_v2(text,jsonb)',
   'public.clued_storage_onboard_v1(text,jsonb)'] loop
   if not exists(select 1 from pg_proc where oid=sig::regprocedure and prosecdef and proconfig=array['search_path=""']::text[]) then
     raise exception 'authorization_serialization_catalog_invalid: %',sig; end if;
 end loop;
 if has_function_privilege('anon','public.clued_project_mutate_v2(text,jsonb)','EXECUTE')
   or not has_function_privilege('clued_worker_gateway','public.clued_project_mutate_v2(text,jsonb)','EXECUTE') then
   raise exception 'authorization_serialization_gateway_boundary_changed'; end if;
end $qualification$;

drop function clued_private.authorization_serialization_patch_v2(text,text,text);
revoke all on function clued_private.authorization_writer_binding_hint_v2(text),
 clued_private.authorization_writer_gateway_hint_v2(text),
 clued_private.authorization_writer_lock_binding_v2(uuid,uuid),
 clued_private.authorization_writer_lock_fanout_v2(uuid,uuid[]),
 clued_private.authorization_writer_project_hint_v2(text,boolean),
 clued_private.authorization_writer_storage_native_hint_v2(),
 clued_private.authorization_writer_native_context_v2(uuid,jsonb),
 clued_private.authorization_writer_permission_request_v2(uuid,uuid),
 clued_private.authorization_writer_permission_token_v2(uuid,text),
 clued_private.authorization_writer_headless_token_v2(uuid,text) from public,anon,authenticated,service_role;

update clued_private.authorization_protocol_capabilities_v2 set serialization_ready=true where singleton;
notify pgrst,'reload schema';
