-- A head whose merge-slot turn is too short for its front batch ends the
-- turn itself: merge_queue_yield takes an optional reason, turn_short
-- (Fable 2026-11-19, design FABLE-front-slot-lapse-20261119).
--
-- Production, 2026-11-19 (Beijing): claim 28ab365c became head at 07:32:36
-- (hard cap 120 minutes), used 64 minutes of the turn for #1169 and was
-- rebound to #1173 at 08:38:46. A front batch needs 64.5 minutes of the
-- turn; from 08:40:24 every train round ended TRAIN_FRONT_BUDGET_SHORT and
-- nothing ended the turn: the cannot_land yield (20261115150000 item 3)
-- writes nothing when no claim waits (nobody_waiting), and the hard-cap
-- rejoin (item 2) only takes an entry that lapsed exactly at the cap, never
-- one that lapsed idle before it. A person gave the claim up, claimed again,
-- authorized the head again and edited the PR body.
--
-- Now the train (stage 10 of the duty node) sends reason turn_short when
-- the hard cap left of the head's turn is less than its front batch needs
-- and a new turn would fit one. The head then joins again exactly as the
-- other rejoins do (work_claim_merge_rejoin_v1, why turn_short): behind the
-- claims that wait, or, alone, head again at once with a whole turn (no
-- hard cap until the next touch). The claim, its lease, its authorized heads
-- and trigger_refs stay as they were. reason cannot_land (the default when
-- reason is absent) is unchanged: nothing is written when no claim waits.
-- Any other reason is refused (22023). Only this function is redefined; the
-- CI door's merge_queue_yield entry (20261115150000) still calls it.
create or replace function clued_private.work_claim_merge_queue_yield_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=p_input->>'pr_ref'; v_head text:=lower(p_input->>'head_sha');
  v_why text:=coalesce(p_input->>'reason','cannot_land'); v_prefix text; v_ref text; q jsonb; c clued_private.work_claims_v1%rowtype;
begin
  if jsonb_typeof(p_input)<>'object'
    or not clued_private.work_claim_ci_assist_input_v1(p_input-'reason',array['action','scope','pr_ref','head_sha'])
    or (p_input ? 'reason' and (jsonb_typeof(p_input->'reason')<>'string' or p_input->>'reason' not in ('cannot_land','turn_short'))) then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if not clued_private.merge_slot_admits_v1(b) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  v_prefix:='merge:'||lower(split_part(v_pr,'#',1))||':';
  v_ref:=v_prefix||'main';
  perform clued_private.work_claim_expire_due(b.user_id);
  perform clued_private.work_claim_merge_front_sync_all_v1(b.user_id,v_prefix);
  q:=clued_private.work_claim_merge_queue_current_v1(b.user_id,v_ref);
  select * into c from clued_private.work_claims_v1 w
    where w.claim_id=(q->'head'->>'claim_id')::uuid and w.user_id=b.user_id and w.context_key=v_scope
      and clued_private.work_claim_pr_matches_v1(w,v_pr);
  if not found then
    return jsonb_build_object('status','ok','yielded',false,'reason','not_head','pr_ref',v_pr,'head_sha',v_head); end if;
  if v_why='cannot_land' and not exists(select 1 from jsonb_array_elements(q->'entries') e where e->>'state'='waiting') then
    return jsonb_build_object('status','ok','yielded',false,'reason','nobody_waiting','claim_id',c.claim_id,'pr_ref',v_pr,'head_sha',v_head); end if;
  perform clued_private.work_claim_merge_rejoin_v1(c.claim_id,b.id,v_why,jsonb_build_object('pr',v_pr,'head_sha',v_head));
  select * into c from clued_private.work_claims_v1 where claim_id=c.claim_id;
  return jsonb_build_object('status','ok','yielded',true,'claim_id',c.claim_id,'pr_ref',v_pr,'head_sha',v_head,
    'merge_queue',clued_private.work_claim_merge_queue_view_v1(c));
end $$;
revoke all on function clued_private.work_claim_merge_queue_yield_v1(public.clued_agent_bindings,jsonb) from public,anon,authenticated;

-- Self-check: the CI door still routes merge_queue_yield here, and this
-- body knows turn_short (a later redefinition from older text fails here).
do $turn_short_selfcheck$
begin
  if position('clued_private.work_claim_merge_queue_yield_v1(b,p_input)' in (select p.prosrc from pg_catalog.pg_proc p
      where p.oid='clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure))=0
    or position('''turn_short''' in (select p.prosrc from pg_catalog.pg_proc p
      where p.oid='clued_private.work_claim_merge_queue_yield_v1(public.clued_agent_bindings,jsonb)'::regprocedure))=0 then
    raise exception 'merge_queue_yield_turn_short_selfcheck_failed';
  end if;
end $turn_short_selfcheck$;
