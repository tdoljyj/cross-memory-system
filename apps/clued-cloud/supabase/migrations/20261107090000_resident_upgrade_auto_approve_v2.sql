-- Resident CI in-place upgrade under the Owner's automatic approval, second
-- rule (Owner Decision 56371a46, which replaces the one-per-24-hours rule of
-- 20261106100000_resident_upgrade_auto_approve_v1; Task ceeaa7c3).
--
-- The resident-upgrader door (owner_grant_resident_upgrade_door_v1) calls the
-- Owner's automatic approval for a pending ci.resident_upgrade request only
-- when all three hold, each counted by the node the grant or request names
-- (whichever of the node's Bindings asked; a re-marked Binding of the same
-- node shares them), never by Binding:
--
-- 1. Fewer than six automatic grants of this action to the node in the 24
--    hours before the request was opened, or since. The window starts at the
--    request's opening, as before: a request opened within 24 hours of a sixth
--    automatic grant stays the Owner's until it is decided or expires.
-- 2. The node's latest grant of this action given before the request was
--    opened is not an automatic one that did not succeed. The database holds
--    no fact of whether an upgrade succeeded: the upgrader reports nothing to
--    the database after the door's OWNER_GRANT_USED (its local journal stays
--    on the node), and no other table or receipt carries an upgrade outcome.
--    So, as the Decision's fallback, an automatic grant that is still unused
--    (uses < max_uses), or one that was used and named the same package as
--    this request (the node asking for that package again), counts as an
--    upgrade that did not succeed. A grant the Owner gave on the page is the
--    Owner's own check after whatever came before, so it does not hold the
--    node.
-- 3. The node's previous request of this action (opened before this one, in
--    any state) did not name the same package: a repeated request for one
--    package is the Owner's.
--
-- Facts 1 and 3 are fixed when the request is opened or only grow, so a
-- request held by them stays the Owner's however long the upgrader keeps
-- asking; under fact 2 a request held by an unused automatic grant goes
-- through once that grant has been used for another package.
--
-- Unchanged: the switch's high-risk rule for this action (approved once, one
-- use, 24 hours, for the requesting Binding only, for exactly the requested
-- resource), the receipts, the replay of an op, connection.permission never
-- automatic (owner_grant_actions_auto_approvable_check), the four
-- model.dataset_split.* actions not automatic.
--
-- Anchored patch: it replaces the rule 20261106100000 put in the door and
-- fails unless that text occurs exactly once.

create function clued_private.resident_upgrade_auto_patch_v2(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare body text:=pg_get_functiondef(p_signature::regprocedure);
begin
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'resident_upgrade_auto_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

select clued_private.resident_upgrade_auto_patch_v2('clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)',
$a$  -- At most one automatic approval per node in 24 hours, counted by the node
  -- the grant names (whichever of the node's Bindings asked) and from the time
  -- this request was opened: a request opened within 24 hours of an automatic
  -- grant to this node, or after one, stays the Owner's for its whole life,
  -- however long the upgrader keeps asking.
  if v_req.status='pending' and not exists(select 1 from clued_private.owner_grants_v1 x
      where x.user_id=v_binding.user_id and x.action='ci.resident_upgrade' and x.auto_approve_id is not null
        and split_part(substr(x.resources[1],char_length('ci-resident:')+1),'/',1)=v_binding.agent_name
        and x.granted_at>v_req.created_at-interval '24 hours') then
    v_req:=clued_private.owner_auto_approve_request_v1(v_req);
  end if;$a$,
$r$  -- Owner Decision 56371a46, counted by the node the grant or request names
  -- (whichever of the node's Bindings asked): automatic only with (1) fewer
  -- than six automatic grants to the node in the 24 hours before this request
  -- was opened, or since; (2) the node's latest grant before this request not
  -- an automatic one left unused or for this same package (no upgrade outcome
  -- reaches the database, so these stand for an upgrade that did not succeed;
  -- a grant the Owner gave does not hold the node); (3) the node's previous
  -- request not for this same package. Otherwise the request is the Owner's.
  if v_req.status='pending' then
    declare
      v_node_last clued_private.owner_grants_v1%rowtype;
      v_node_prev clued_private.owner_requests_v1%rowtype;
      v_node_auto integer;
    begin
      select count(*) into v_node_auto from clued_private.owner_grants_v1 x
        where x.user_id=v_binding.user_id and x.action='ci.resident_upgrade' and x.auto_approve_id is not null
          and split_part(substr(x.resources[1],char_length('ci-resident:')+1),'/',1)=v_binding.agent_name
          and x.granted_at>v_req.created_at-interval '24 hours';
      select * into v_node_last from clued_private.owner_grants_v1 x
        where x.user_id=v_binding.user_id and x.action='ci.resident_upgrade'
          and split_part(substr(x.resources[1],char_length('ci-resident:')+1),'/',1)=v_binding.agent_name
          and x.granted_at<v_req.created_at
        order by x.granted_at desc,x.id desc limit 1;
      select * into v_node_prev from clued_private.owner_requests_v1 r
        where r.user_id=v_binding.user_id and r.action='ci.resident_upgrade' and r.id<>v_req.id
          and split_part(substr(r.resources[1],char_length('ci-resident:')+1),'/',1)=v_binding.agent_name
          and (r.created_at,r.id)<(v_req.created_at,v_req.id)
        order by r.created_at desc,r.id desc limit 1;
      if v_node_auto<6
          and not (v_node_last.id is not null and v_node_last.auto_approve_id is not null
            and (v_node_last.uses<coalesce(v_node_last.max_uses,1) or v_node_last.resources=v_req.resources))
          and not (v_node_prev.id is not null and v_node_prev.resources=v_req.resources) then
        v_req:=clued_private.owner_auto_approve_request_v1(v_req);
      end if;
    end;
  end if;$r$);

drop function clued_private.resident_upgrade_auto_patch_v2(text,text,text);

notify pgrst,'reload schema';
