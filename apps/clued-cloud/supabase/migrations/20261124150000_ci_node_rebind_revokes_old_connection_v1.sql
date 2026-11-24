-- A node rebound away from a connection that is still valid left that connection
-- usable: no role, no node, but its token still read the project until its own
-- expiry. The Native rebind now revokes it in the committing transaction, as node
-- self-renewal (20261119033000) already does for the connection it replaces.
-- The confirmation view names the effect. Install only: no row is changed by this migration.
--
-- Anchored and additive, so the function keeps its OID, privileges and every
-- other line that was reviewed. The statements sit inside the apply's own
-- subtransaction: a refused apply revokes nothing.
do $patch$
declare body text; anchor text;
begin
  body:=pg_get_functiondef('public.clued_ci_node_binding_rebind_apply_v1(jsonb)'::regprocedure);
  anchor:=$a$r:=(v->>'receipt_id')::uuid;$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_REVOKE_OLD_ANCHOR'; end if;
  if position('revoked_by_node_binding_rebind' in body)>0 then raise exception 'CI_REBIND_REVOKE_OLD_PRESENT'; end if;
  -- ci_node_rebind_lock_v1 already holds this connection and its authorization
  -- for update. The view refused a connection another node or a heartbeat link
  -- uses, and its roles and failover rank have just moved to the new one. A
  -- connection the expiry sweep revoked keeps the sweep's own record. The audit
  -- operation matches the rule that never accepts a revoked connection again.
  execute replace(body,anchor,anchor||$r$
    update public.clued_agent_bindings set revoked_at=t
      where id=(c->>'old_binding_id')::uuid and user_id=u and revoked_at is null;
    if found then
      update clued_private.authorizations_v12 set revoked_at=t,version=version+1
        where binding_id=(c->>'old_binding_id')::uuid and owner_id=u and revoked_at is null;
      insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation)
        values(u,(c->>'old_binding_id')::uuid,'revoked_by_node_binding_rebind');
    end if;$r$);
  -- The Owner confirms the digested view (the self-renewal view is the same
  -- function and revokes too): it now names this effect.
  body:=pg_get_functiondef('clued_private.ci_node_rebind_view_v1(uuid,uuid,jsonb,boolean)'::regprocedure);
  anchor:=$a$'local_activation','Owner must activate matching credential generation on the node'$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'CI_REBIND_VIEW_EFFECTS_ANCHOR'; end if;
  if position($a$'old_connection','revoke$a$ in body)>0 then raise exception 'CI_REBIND_VIEW_EFFECTS_PRESENT'; end if;
  execute replace(body,anchor,anchor||$r$,
      'old_connection','revoke at commit; its token stops working wherever it is used'$r$);
end $patch$;
