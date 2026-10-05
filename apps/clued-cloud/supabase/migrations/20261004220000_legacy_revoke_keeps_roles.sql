-- Re-review 4, M1 (Task 869d2db7): revoking a legacy Binding on
-- /oauth/connections ended its Binding roles. With no live role row left,
-- clued_private.binding_role_admits_v1 falls back to the "never marked" state
-- and admits every Binding, which reopened re-review 2 finding A (any Binding
-- binds or meters claims, adopts merges, uses the release door).
--
-- The revoke now leaves the role rows alone, as clued_authorization_manage_v12
-- revoke does: the role stays locked on the revoked Binding until the Owner
-- marks a live Binding on /bindings or ends the role there. The result and the
-- receipt name the roles kept. Body otherwise unchanged.

create or replace function public.clued_headless_binding_revoke_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); b public.clued_agent_bindings;
  v_id uuid; v_now timestamptz; v_receipt uuid; v_roles text[];
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k<>'binding_id')
      or jsonb_typeof(p_input->'binding_id') is distinct from 'string'
      or p_input->>'binding_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'headless_binding_input_invalid' using errcode='22023'; end if;
  v_id:=(p_input->>'binding_id')::uuid;
  -- Lock order as manage_v12: Binding first.
  select * into b from public.clued_agent_bindings where id=v_id and user_id=v_owner for update;
  if not found or not clued_private.binding_live_v1(b)
      or exists(select 1 from clued_private.authorizations_v12 a where a.binding_id=v_id) then
    raise exception 'headless_binding_revoke_target_invalid' using errcode='22023'; end if;
  select coalesce(array_agg(r.role order by r.role),array[]::text[]) into v_roles
    from clued_private.binding_roles_v1 r where r.binding_id=v_id and r.revoked_at is null;
  v_now:=clock_timestamp();
  update public.clued_agent_bindings set revoked_at=v_now where id=v_id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','legacy_binding_revoke','agent_binding',v_id::text,1,
    jsonb_build_object('receipt_kind','LEGACY_BINDING_REVOKED','binding_id',v_id,'agent_name',b.agent_name,
      'vendor',b.vendor,'scopes',to_jsonb(b.scopes),'context_keys',to_jsonb(b.context_keys),
      'roles_kept',to_jsonb(v_roles),'session_id',clued_private.native_session_id_v1(),
      'principal','native_account_session'))
  returning id into v_receipt;
  insert into clued_private.authorization_audit_v12(owner_id,binding_id,request_id,operation,version,selected)
    values(v_owner,v_id,null,'legacy_revoke',null,jsonb_build_object('roles_kept',to_jsonb(v_roles)));
  return jsonb_build_object('status','committed','binding_id',v_id,'revoked_at',v_now,
    'receipt_id',v_receipt,'roles_kept',to_jsonb(v_roles));
end $$;

revoke all on function public.clued_headless_binding_revoke_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_headless_binding_revoke_v1(jsonb) to authenticated;
notify pgrst, 'reload schema';
