-- Audit receipt lookups behind three 57014 timeouts: session compliance and
-- the work-claim rejection receipt, each through a partial index (Task
-- 25af334d).
--
-- Both run under the anon role's 3 s statement timeout and, like the Owner
-- Grant lookup fixed in 20261009070000, read public.clued_audit_receipts
-- through its only user index, (user_id, context_key, created_at), then
-- filter on binding, operation and metadata. Nearly every receipt is the one
-- Owner's, so that index narrows each lookup to a whole context (about 8,000
-- receipts in the Clued project, 13,000 in Global) and every row's metadata
-- is read. On 2026-10-09 this returned 500 code 57014 four times:
--
-- 1. clued_mcp_audit_receipts, 04:59 and 05:13 UTC. Session compliance counts
--    each session's append and checkpoint receipts by metadata session_id,
--    once per session of the last 30 days. For the Claude Code Binding in
--    the Clued project that is 573 sessions times 7,863 receipts: 3.0 s with
--    every page in memory (EXPLAIN ANALYZE, read-only, in production). It
--    fails on every call for that Binding and context, and grows with both.
--    The lateral now names the two operations it counts, which is what lets
--    it use a partial index over append and checkpoint receipts keyed by
--    binding, context and session_id; its counts and states are unchanged.
-- 2. clued_work_renew_v1 at 04:03 and clued_work_claim_v1 at 06:43 UTC, both
--    in work_claim_reject_log_v1 while logging a refusal. Its once-a-minute
--    dedup check filters created_at by clock_timestamp(), which is volatile
--    and cannot bound an index scan, so the check read the whole context:
--    0.9 s warm in production, more on a fresh PostgREST backend, on top of
--    the claim checks that ran before it. A partial index over the
--    work_claim_reject receipts (a few hundred rows) keyed by binding and
--    object finds the recent ones directly. The query already names the
--    operation, so the function is unchanged.
--
-- The third, clued_mcp_search_context at 07:24 UTC, is not an index lookup:
-- it scores every record, checkpoint and event of the account in PL/pgSQL
-- and is left for its own change (Task 775a2292).

create index clued_audit_receipts_session_capture_idx
  on public.clued_audit_receipts (user_id, binding_id, context_key, (metadata->>'session_id'))
  where operation in ('append','checkpoint');

create index clued_audit_receipts_work_claim_reject_idx
  on public.clued_audit_receipts (user_id, context_key, binding_id, object_id, created_at desc)
  where operation='work_claim_reject';

create or replace function public.clued_mcp_audit_receipts(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,20),1),100);
  v_receipts jsonb; v_sessions jsonb; v_reminder boolean:=false;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context_key);
  select coalesce(jsonb_agg(row_data order by created_at desc),'[]'::jsonb) into v_receipts from (
    select jsonb_build_object('id',r.id,'operation',r.operation,'object_type',r.object_type,'object_id',r.object_id,
      'version',r.version,'binding_id',r.binding_id,'metadata',r.metadata,'created_at',r.created_at) row_data,r.created_at
    from public.clued_audit_receipts r where r.user_id=v_binding.user_id and r.context_key=v_context_key
    order by r.created_at desc limit v_limit
  ) matches;
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id',s.id,'client_session_id',s.client_session_id,'started_at',s.started_at,'last_seen_at',s.last_seen_at,
    'expires_at',s.expires_at,'ended_at',s.ended_at,'append_count',x.append_count,'checkpoint_count',x.checkpoint_count,
    'state',case when x.checkpoint_count>0 then 'checkpointed' when x.append_count>0 and s.expires_at<=now() then 'expired_without_checkpoint'
      when x.append_count>0 then 'checkpoint_required_before_handoff' else 'capture_unknown' end,
    'required_action',case when x.append_count>0 and x.checkpoint_count=0 then 'checkpoint_before_handoff' else null end,
    'authority_capture',case when x.append_count>0 and x.checkpoint_count=0 then 'incomplete' else 'unknown' end
  ) order by s.started_at desc),'[]'::jsonb),
  coalesce(bool_or(x.append_count>0 and x.checkpoint_count=0),false) into v_sessions,v_reminder
  from public.clued_continuity_sessions s
  cross join lateral (select
    count(*) filter(where r.operation='append') append_count,
    count(*) filter(where r.operation='checkpoint') checkpoint_count
    -- Only the counted operations, so clued_audit_receipts_session_capture_idx serves it.
    from public.clued_audit_receipts r where r.operation in ('append','checkpoint')
      and r.user_id=s.user_id and r.binding_id=s.binding_id
      and r.context_key=s.context_key and r.metadata->>'session_id'=s.id::text) x
  where s.user_id=v_binding.user_id and s.binding_id=v_binding.id and s.context_key=v_context_key
    and s.started_at>now()-interval '30 days';
  return jsonb_build_object('status','ok','context_key',v_context_key,'receipts',v_receipts,
    'session_compliance',v_sessions,'checkpoint_reminder',v_reminder,
    'authority_capture_completeness',jsonb_build_object(
      'state',case when v_reminder then 'incomplete' else 'unknown' end,
      'basis','server_observes_only_writes_that_reached_clued',
      'independent_of','currentness'));
end $$;
