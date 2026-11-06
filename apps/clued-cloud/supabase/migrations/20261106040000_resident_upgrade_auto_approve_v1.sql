-- Resident CI in-place upgrade under the Owner's automatic approval (Task
-- ceeaa7c3; Owner Decision f8aff2f9, which supersedes item 2 of Decision
-- 3ce5200c, "never automatic"; its items 1, 3, 4 and 5 stay as they were).
--
-- ci.resident_upgrade joins the actions the Owner's automatic approval switch
-- approves (20261008170000, 20261013023000), with the switch's high-risk rule,
-- as release.production and migration.production: approved once (one use,
-- 24 hours), for the requesting Binding only, for exactly the requested
-- resource (one node, one package). The resident-upgrader door
-- (20261030010000) now calls clued_private.owner_auto_approve_request_v1 for
-- the request it opened or found, like the other doors, and uses the grant in
-- the same call. The switch, its receipts (OWNER_GRANT_GIVEN with principal
-- owner_auto_approve) and the "来源 自动审批" line on /grants are the existing
-- ones; the door's use receipt says auto_approved.
--
-- One rule of its own: a node gets at most one automatic approval of this
-- action in 24 hours. A second request of the same node within 24 hours of
-- an automatic grant to it stays the Owner's, so a node that keeps asking (a
-- failed upgrade being retried, or a wrong package) reaches the Owner.
--
-- connection.permission stays never automatic (the CHECK below), and the four
-- model.dataset_split.* actions stay as they are (not automatic: their doors
-- accept only a grant the Owner confirmed on the page).
--
-- Anchored patches: each replaces one statement and fails unless the anchor
-- occurs exactly once.

alter table clued_private.owner_grant_actions drop constraint owner_grant_actions_auto_approvable_check;
alter table clued_private.owner_grant_actions add constraint owner_grant_actions_auto_approvable_check
  check (not auto_approvable or action<>'connection.permission');
update clued_private.owner_grant_actions set auto_approvable=true where action='ci.resident_upgrade';

create function clued_private.resident_upgrade_auto_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'resident_upgrade_auto_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

select clued_private.resident_upgrade_auto_patch_v1('clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)',
$a$  -- No grant: this op's request as it stands, or a new one. Never automatic.$a$,
$r$  -- No grant: this op's request as it stands, or a new one; then the Owner's
  -- automatic approval (Task ceeaa7c3), as at the other doors.$r$);

select clued_private.resident_upgrade_auto_patch_v1('clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)',
$a$  return jsonb_build_object('status','ok','consumed',false,'action','ci.resident_upgrade',
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));$a$,
$r$  -- At most one automatic approval per node in 24 hours: a later request of
  -- this Binding waits for the Owner.
  if v_req.status='pending' and not exists(select 1 from clued_private.owner_grants_v1 x
      where x.user_id=v_binding.user_id and x.action='ci.resident_upgrade' and x.grantee_binding_id=v_binding.id
        and x.auto_approve_id is not null and x.granted_at>clock_timestamp()-interval '24 hours') then
    v_req:=clued_private.owner_auto_approve_request_v1(v_req);
  end if;
  if v_req.status='approved_once' and v_req.grant_id is not null then
    select * into g from clued_private.owner_grants_v1 x
      where x.id=v_req.grant_id and x.user_id=v_binding.user_id and x.action='ci.resident_upgrade'
        and x.auto_approve_id is not null and x.revoked_at is null and x.grantee_binding_id=v_binding.id
        and x.resources=v_resources and x.expires_at>clock_timestamp() and x.uses<coalesce(x.max_uses,1)
      for update;
    if found then
      update clued_private.owner_grants_v1 set uses=uses+1 where id=g.id;
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(v_binding.user_id,v_binding.id,'global','owner_grant_use','owner_grant',g.id::text,g.uses+1,
        jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',g.id,'action','ci.resident_upgrade',
          'resources',to_jsonb(v_resources),'door','resident-upgrader','op_id',v_op,'use',g.uses+1,'max_uses',g.max_uses,
          'auto_approved',true))
      returning id into v_receipt;
      return jsonb_build_object('status','ok','consumed',true,'auto_approved',true,'action','ci.resident_upgrade',
        'resources',to_jsonb(v_resources),'grant',jsonb_build_object('grant_id',g.id,'receipt_id',v_receipt,
          'use',g.uses+1,'max_uses',g.max_uses,'expires_at',g.expires_at,'replayed',false));
    end if;
  end if;
  return jsonb_build_object('status','ok','consumed',false,'action','ci.resident_upgrade',
    'resources',to_jsonb(v_resources),'owner_request',clued_private.owner_request_public_v1(v_req));$r$);

drop function clued_private.resident_upgrade_auto_patch_v1(text,text,text);

notify pgrst,'reload schema';
