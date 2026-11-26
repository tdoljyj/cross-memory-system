-- A completed Native reconnect replaces access, never the archived Job/proof.
-- Task feb50041: preserve historical provenance and recheck current authority.
create function clued_private.task_goal_delivery_connection_v1(
  p_owner uuid,p_original uuid,p_lock boolean default false
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare original clued_private.storage_connections_v1; current_c clued_private.storage_connections_v1;
  next_c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  l clued_private.storage_owner_lifecycle_v1; r public.clued_audit_receipts;
  visited uuid[]:='{}'; current_id uuid:=p_original; n bigint; req jsonb;
begin
  select * into original from clued_private.storage_connections_v1 where id=p_original and owner_id=p_owner;
  if not found then return null; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=original.profile_id and user_id=p_owner;
  if not found then return null; end if;
  if p_lock and not pg_try_advisory_xact_lock(hashtextextended(p_owner::text||':'||p.root_folder_id,0)) then return null; end if;
  for hop in 0..15 loop
    if current_id=any(visited) then return null; end if;
    visited:=array_append(visited,current_id);
    if p_lock then
      perform 1 from clued_private.storage_connections_v1 where id=current_id and owner_id=p_owner for share nowait;
    end if;
    select * into current_c from clued_private.storage_connections_v1 where id=current_id and owner_id=p_owner;
    if not found or current_c.profile_id is distinct from original.profile_id
      or current_c.profile_version is distinct from original.profile_version
      or current_c.provider is distinct from original.provider
      or current_c.provider_subject is distinct from original.provider_subject then return null; end if;
    -- Count before selecting: neither a branch nor a fabricated latest row wins.
    select count(*) into n from clued_private.storage_owner_lifecycle_v1 x
      where x.connection_id=current_id and x.operation='reconnect'
        and x.state='completed' and x.result->>'status'='completed';
    if current_c.state='active' and current_c.revoked_at is null then
      if n<>0 or exists(select 1 from clued_private.storage_owner_connection_hidden_v1 h where h.connection_id=current_id) then return null; end if;
      if current_id<>p_original and (current_c.auth_mode<>'account_policy' or not exists(
        select 1 from clued_private.storage_account_policies_v2 ap where ap.id=current_c.account_policy_id
          and ap.connection_id=current_id and ap.owner_id=p_owner and ap.state='active' and ap.revoked_at is null
          and (ap.expires_at is null or ap.expires_at>clock_timestamp()) and ap.profile_id=p.id
          and ap.root_folder_id=p.root_folder_id and ap.provider=original.provider
          and ap.provider_subject=original.provider_subject
          and clued_private.resource_center_decision_current_v1(p_owner,p.project_id,ap.source_decision_id))
        or exists(select 1 from clued_private.storage_root_denies_v2 ds where ds.owner_id=p_owner
          and ds.provider=original.provider and ds.provider_subject=original.provider_subject
          and ds.root_folder_id=p.root_folder_id and ds.lineage_id is null and ds.denied)) then return null; end if;
      return current_id;
    end if;
    if current_c.state<>'revoked' or current_c.revoked_at is null or n<>1 then return null; end if;
    if p_lock then
      perform 1 from clued_private.storage_owner_lifecycle_v1 x where x.connection_id=current_id
        and x.operation='reconnect' and x.state='completed' and x.result->>'status'='completed' for share nowait;
    end if;
    select * into l from clued_private.storage_owner_lifecycle_v1 x where x.connection_id=current_id
      and x.operation='reconnect' and x.state='completed' and x.result->>'status'='completed';
    if l.owner_id is distinct from p_owner or l.profile_id is distinct from p.id
      or l.profile_version is distinct from original.profile_version or l.root_folder_id is distinct from p.root_folder_id
      or l.new_connection_id is null or l.new_connection_id=any(visited)
      or l.result->>'old_connection_id' is distinct from current_id::text
      or l.result->>'connection_id' is distinct from l.new_connection_id::text
      or l.result->>'profile_id' is distinct from p.id::text
      or l.result->>'project_id' is distinct from p.project_id::text
      or coalesce(l.result->>'receipt_id','') !~ '^[0-9a-f-]{36}$' then return null; end if;
    select * into next_c from clued_private.storage_connections_v1 where id=l.new_connection_id and owner_id=p_owner;
    if not found or next_c.profile_id is distinct from p.id
      or next_c.profile_version is distinct from original.profile_version
      or next_c.provider is distinct from original.provider
      or next_c.provider_subject is distinct from original.provider_subject then return null; end if;
    req:=jsonb_build_object('idempotency_key','storage-owner:'||l.request_key,'request_digest',l.request_digest,'connection_id',current_id);
    select * into r from public.clued_audit_receipts where id=l.receipt_id and user_id=p_owner
      and binding_id is null and operation='storage_owner_reconnect' and status='committed';
    if not found or r.received_payload_hash is distinct from clued_private.m1_sha256(req)
      or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_owner_reconnect','payload',req-'idempotency_key'))
      or r.canonical_result is null or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result)
      or not coalesce(r.canonical_result->'target_refs' @> jsonb_build_array(jsonb_build_object('id',next_c.id,'kind','system','role','primary')),false) then return null; end if;
    select * into r from public.clued_audit_receipts where id=(l.result->>'receipt_id')::uuid and user_id=p_owner
      and binding_id is null and operation='storage_owner_reconnect_activate' and status='committed';
    if not found or r.canonical_result is null or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result)
      or not coalesce(r.canonical_result->'target_refs' @> jsonb_build_array(jsonb_build_object('id',next_c.id,'kind','system','role','primary')),false)
      or not exists(select 1 from clued_private.storage_owner_connection_hidden_v1 h
        where h.connection_id=current_id and h.owner_id=p_owner and h.receipt_id=r.id)
      or not exists(select 1 from clued_private.storage_account_policies_v2 ap where ap.owner_id=p_owner
        and ap.connection_id=next_c.id and ap.profile_id=p.id and ap.root_folder_id=p.root_folder_id
        and ap.provider=original.provider and ap.provider_subject=original.provider_subject and ap.activation_receipt_id=r.id)
      or not exists(select 1 from clued_private.storage_oauth_attempts_v1 o
        join public.clued_audit_receipts oauth_r on oauth_r.id=o.receipt_id and oauth_r.user_id=p_owner
          and oauth_r.status='committed' and oauth_r.operation='storage_oauth_activate'
          and oauth_r.canonical_result is not null and oauth_r.response_hash=clued_private.m1_sha256(oauth_r.canonical_result)
        where o.owner_id=p_owner and o.connection_id=next_c.id and o.session_id=l.session_id
          and o.issuer_hash=l.issuer_hash and o.purpose='connection' and o.status='completed'
          and r.received_payload_hash=clued_private.m1_sha256(jsonb_build_object('idempotency_key','storage-reconnect-activate:'||l.id,'attempt_id',l.id,'oauth_receipt_id',o.receipt_id))
          and r.request_sha256=clued_private.m1_sha256(jsonb_build_object('operation','storage_owner_reconnect_activate',
            'payload',jsonb_build_object('attempt_id',l.id,'oauth_receipt_id',o.receipt_id)))) then return null; end if;
    current_id:=next_c.id;
  end loop;
  return null;
exception when lock_not_available then return null;
  when others then return null;
end $$;
revoke all on function clued_private.task_goal_delivery_connection_v1(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;

-- Patch only the exact deployed issuer-compatible/optional-expiry definitions.
-- Historical c/saved/proof validation remains byte-identical.
do $repair$
declare body text; old text; replacement text; f regprocedure;
begin
  f:='clued_private.task_goal_delivery_storage_read_v1(uuid,uuid,uuid,uuid)'::regprocedure;
  select pg_get_functiondef(oid) into body from pg_proc where oid=f
    and proowner=(select oid from pg_roles where rolname='postgres') and prosecdef and proconfig=array['search_path=""']
    and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee<>proowner and a.privilege_type='EXECUTE')
    and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='6e09dd3d29f4fb576d528ca62227eb8989b6e3999df778d7354748194a9ebef2';
  if body is null then raise exception 'task_goal_reconnect_read_source_mismatch'; end if;
  old:=$a$  if p_binding is null then return false; end if;$a$;
  replacement:=$a$  if p_binding is null then return false; end if;
  p_connection:=clued_private.task_goal_delivery_connection_v1(p_owner,p_connection,false);
  if p_connection is null then return false; end if;$a$;
  if (length(body)-length(replace(body,old,'')))/length(old)<>1 then raise exception 'task_goal_reconnect_read_anchor_mismatch'; end if;
  execute replace(body,old,replacement);

  f:='clued_private.task_goal_delivery_file_v1(uuid,text,uuid,jsonb,jsonb,text,boolean)'::regprocedure;
  select pg_get_functiondef(oid) into body from pg_proc where oid=f
    and proowner=(select oid from pg_roles where rolname='postgres') and prosecdef and proconfig=array['search_path=""']
    and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee<>proowner and a.privilege_type='EXECUTE')
    and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='2445cf1234c068c7191a8b30539f176c3979548e132f8dbbd93e406d7499c840';
  if body is null then raise exception 'task_goal_reconnect_file_source_mismatch'; end if;
  old:=$a$  a clued_private.resource_center_artifacts_v1; saved jsonb; proof jsonb; after_content jsonb;$a$;
  replacement:=old||E'\n  live_connection uuid; current_c clued_private.storage_connections_v1;';
  if (length(body)-length(replace(body,old,'')))/length(old)<>1 then raise exception 'task_goal_reconnect_declaration_mismatch'; end if;
  body:=replace(body,old,replacement);
  old:=$a$  v_scope:='project:'||p.project_id::text;
  if p.id is null or (p_scope<>'global' and p_scope<>v_scope)$a$;
  replacement:=$a$  live_connection:=clued_private.task_goal_delivery_connection_v1(p_owner,j.connection_id,false);
  v_scope:='project:'||p.project_id::text;
  if p.id is null or live_connection is null or (p_scope<>'global' and p_scope<>v_scope)$a$;
  if (length(body)-length(replace(body,old,'')))/length(old)<>1 then raise exception 'task_goal_reconnect_scope_mismatch'; end if;
  body:=replace(body,old,replacement);
  old:=$a$    perform 1 from clued_private.resource_center_profiles_v1 where id=p.id for share nowait;$a$;
  replacement:=$a$    -- The existing evaluator takes client/job/root locks first. Recheck the
    -- same lineage under that root fence before locking source rows.
    if clued_private.task_goal_delivery_connection_v1(p_owner,j.connection_id,true) is distinct from live_connection then
      return out||jsonb_build_object('status','unknown','reason','delivery_source_busy'); end if;
$a$||old;
  if (length(body)-length(replace(body,old,'')))/length(old)<>1 then raise exception 'task_goal_reconnect_locked_recheck_mismatch'; end if;
  body:=replace(body,old,replacement);
  old:=$a$  out:=out||jsonb_build_object('connection_id',j.connection_id);$a$;
  replacement:=$a$  out:=out||jsonb_build_object('connection_id',live_connection)
    ||case when live_connection<>j.connection_id then jsonb_build_object('source_connection_id',j.connection_id) else '{}'::jsonb end;$a$;
  if (length(body)-length(replace(body,old,'')))/length(old)<>1 then raise exception 'task_goal_reconnect_locator_mismatch'; end if;
  body:=replace(body,old,replacement);
  old:=$a$  if p.state<>'active' or c.state<>'active' or c.revoked_at is not null or c.profile_version<>p.version
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,c.source_decision_id) then$a$;
  replacement:=$a$  select * into current_c from clued_private.storage_connections_v1 where id=live_connection and owner_id=p_owner;
  if p.state<>'active' or current_c.id is null or current_c.state<>'active' or current_c.revoked_at is not null or current_c.profile_version<>p.version
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,current_c.source_decision_id) then$a$;
  if (length(body)-length(replace(body,old,'')))/length(old)<>1 then raise exception 'task_goal_reconnect_authority_mismatch'; end if;
  execute replace(body,old,replacement);
end $repair$;
notify pgrst,'reload schema';
