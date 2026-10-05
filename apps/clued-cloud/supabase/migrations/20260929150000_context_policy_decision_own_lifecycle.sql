-- Context Policy approval is judged on the approving Decision's own lifecycle
-- (Owner Decision 0b183c2e, 2026-09-29; M0DCloseout 6.1 revised).
--
-- context_policy_usable_v1 required record_currentness_fence(...)='CURRENT' for
-- the approving Decision. That fence returns SHADOWED_BY_ACTIVE_EVENT for every
-- global Decision while any work_log Event carrying the decision dimension is
-- active in global, and acceptance always writes the Decision in global. In
-- production such Events are routine, so every accepted policy was refused with
-- policy_decision_not_current.
--
-- The approving Decision now stays usable while that exact version is not
-- archived, merged, closed or superseded. Every other check is unchanged: the
-- exact version, the committed Native Receipt, the Native marker and the policy
-- digest; an update, supersede or close still disables the policy until a new
-- Native acceptance. Pack items keep the full currentness fence.
--
-- Patched in place from the live definition, following the anchor-count
-- convention of 20260922143312.

do $migration$
declare body text;
  anchor text:=$anchor$  if clued_private.record_currentness_fence(p_user_id,v_record.id,null) is distinct from 'CURRENT' then
    return 'policy_decision_not_current';
  end if;$anchor$;
begin
  body:=pg_get_functiondef('clued_private.context_policy_usable_v1(uuid,uuid)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    then raise exception 'context_policy_decision_own_lifecycle_definition_mismatch'; end if;
  execute replace(body,anchor,$own$  -- The approving Decision is judged on its own lifecycle; unrelated active
  -- Events in its scope do not disable the policy (Owner Decision 0b183c2e).
  if v_record.archived_at is not null or v_record.merged_into_record_id is not null
    or coalesce(v_record.lifecycle_status,'active')<>'active'
    or v_record.status in ('archived','superseded','revoked','cancelled','done')
    or exists(select 1 from public.clued_memories s where s.user_id=p_user_id and s.supersedes_id=v_record.id) then
    return 'policy_decision_not_current';
  end if;$own$);
end $migration$;
