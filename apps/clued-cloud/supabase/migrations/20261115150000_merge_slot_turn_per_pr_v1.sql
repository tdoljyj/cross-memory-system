-- A merge-slot turn that ends by a merge or by the hard cap sends its claim
-- to the back of the queue instead of out of it (Task 60a1150b, throughput
-- defect A; Owner 2026-11-15).
--
-- Production, 2026-11-15 (UTC), claim 96373a88 bound to #1117-#1126: the CI
-- joined it at 10:46:03 (for #1123), #1119 merged at 11:46:55 with 59 minutes
-- of the 2-hour turn left, too little for the next front batch, so the train
-- refused it (TRAIN_FRONT_BUDGET_SHORT, "请让位子过期后重新入队") until the
-- turn lapsed at the hard cap at 12:46:03. A lapsed entry was out for good:
-- only a holder renewal or a stage-8 try of a parked batch joins again, and
-- none came until the holder renewed by hand at 13:21:03. Ninety-five minutes
-- with every remaining pull request green. The same lapse happened at 10:32
-- (rejoined by chance at 10:46).
--
-- 1. A merged pull request ends the turn. When a pull request of a Task
--    merges (adopt) while the Task still has another active pull request,
--    work_claim_merge_slot_return_core_v1 used to keep the claim's slot as it
--    was, so all of a claim's pull requests shared one turn. Now every live
--    claim that served the merged pull request joins again at the back.
-- 2. A turn that lapsed at the hard cap joins again at the back. The CI's
--    queue keepalive (every train round of the duty node, with the open pull
--    requests it sees) now first puts back each live claim of its scope whose
--    entry lapsed exactly at its hard cap and that is bound to one of those
--    open pull requests. Lapsing at the cap means the CI was still reporting
--    on the claim (renewal and CI clocks ran past the cap); an idle claim
--    lapses on those clocks instead and stays out, as before.
-- Either way: claims that were waiting go first, and a claim alone in its
-- queue is head again at once with a whole turn (the hard cap only orders
-- claims that wait for each other). Joining again drops the claim's merge refs
-- and puts them back in one transaction, exactly as the CI's merge_queue_join
-- does for a lapsed claim: the stamp triggers record the leaving and start a
-- new join (merge_queued_at, merge_slot_taken_at and merge_slot_at now, no CI
-- state, no hard cap until the next touch). trigger_refs end exactly as they
-- were, so no execution admission changes. The slot is still not returned;
-- a closed pull request, a Task's last pull request and an idle lapse are
-- unchanged. One WORK_CLAIM_MERGE_QUEUE_REJOINED receipt per join. Item 3
-- below: a head that cannot land gives way to waiting claims.

create function clued_private.work_claim_merge_rejoin_v1(p_claim uuid,p_binding_id uuid,p_why text,p_detail jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_refs text[]; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  select * into c from clued_private.work_claims_v1 where claim_id=p_claim for update;
  v_refs:=c.trigger_refs;
  update clued_private.work_claims_v1 set trigger_refs=array(select t from unnest(v_refs) t where lower(t) not like 'merge:%' order by t)
    where claim_id=c.claim_id;
  update clued_private.work_claims_v1 set trigger_refs=v_refs,updated_at=v_now
    where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,p_binding_id,c.context_key,'work_claim_merge_queue_rejoin','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_QUEUE_REJOINED','claim_id',c.claim_id,'task_id',c.task_id,
      'fence',c.fence,'why',p_why,'queued_at',c.merge_queued_at)||coalesce(p_detail,'{}'::jsonb));
end $$;
revoke all on function clued_private.work_claim_merge_rejoin_v1(uuid,uuid,text,jsonb) from public,anon,authenticated;

-- 1. The predecessor (20261108161615), with the merged case joining again.
create or replace function clued_private.work_claim_merge_slot_return_core_v1(
  p_user_id uuid,p_binding_id uuid,p_scope text,p_pr text,p_why text,p_ref jsonb
) returns uuid[] language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype;
begin
  if p_why in ('merged','closed') and exists(
    select 1 from clued_private.work_claim_pr_task_bindings_v1 t
    join public.clued_memories m on m.id=t.task_id and m.user_id=t.user_id
    where t.user_id=p_user_id and t.repo_id=lower(split_part(p_pr,'#',1))
      and t.pr_number=split_part(p_pr,'#',2)::bigint
      and coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)=p_scope
      and exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 other
        where other.user_id=t.user_id and other.task_id=t.task_id and other.repo_id=t.repo_id
          and other.pr_number<>t.pr_number and other.status='active')) then
    if p_why='merged' then
      for c in select * from clued_private.work_claims_v1 w
        where w.user_id=p_user_id and w.context_key=p_scope and clued_private.work_claim_pr_matches_v1(w,p_pr,false)
          and w.status in ('ACTIVE','DRAINING') and w.expires_at>pg_catalog.clock_timestamp() and w.merge_queued_at is not null
          and exists(select 1 from unnest(w.trigger_refs) t where lower(t) like 'merge:%')
        order by w.issued_at loop
        perform clued_private.work_claim_merge_rejoin_v1(c.claim_id,p_binding_id,'merged',
          jsonb_build_object('merged_pr',p_pr,'ref',coalesce(p_ref,'{}'::jsonb)));
      end loop;
    end if;
    return '{}'::uuid[];
  end if;
  return clued_private.work_claim_merge_slot_return_before_pr_task_v1(p_user_id,p_binding_id,p_scope,p_pr,p_why,p_ref);
end $$;

-- 2. Claims of p_scope whose entry in a queue of p_prefix lapsed exactly at
-- the hard cap and that are bound to one of p_prs join again, in queue order.
create function clued_private.work_claim_merge_cap_rejoin_v1(b public.clued_agent_bindings,p_scope text,p_prefix text,p_prs text[])
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_ref text; v_ids uuid[]:='{}'::uuid[]; v_done uuid[]:='{}'::uuid[]; v_id uuid; c clued_private.work_claims_v1%rowtype;
begin
  foreach v_ref in array clued_private.work_claim_merge_queue_refs_v1(b.user_id,p_prefix) loop
    perform clued_private.work_claim_merge_front_sync_v1(b.user_id,v_ref);
    v_ids:=v_ids||array(select (e->>'claim_id')::uuid
      from jsonb_array_elements(clued_private.work_claim_merge_queue_current_v1(b.user_id,v_ref)->'entries') with ordinality x(e,n)
      join clued_private.work_claims_v1 w on w.claim_id=(e->>'claim_id')::uuid
      where e->>'state'='lapsed' and w.merge_slot_hard_cap_seconds is not null
        and (e->>'until')::timestamptz>=(e->>'since')::timestamptz+make_interval(secs=>w.merge_slot_hard_cap_seconds)
      order by n);
  end loop;
  foreach v_id in array v_ids loop
    -- A claim in several queues joins once (that puts it into all of them again).
    continue when v_id=any(v_done);
    v_done:=v_done||v_id;
    select * into c from clued_private.work_claims_v1 w
      where w.claim_id=v_id and w.user_id=b.user_id and w.context_key=p_scope and w.status in ('ACTIVE','DRAINING')
        and w.expires_at>pg_catalog.clock_timestamp() and w.merge_queued_at is not null
        and exists(select 1 from unnest(p_prs) q(pr_ref) where clued_private.work_claim_pr_matches_v1(w,q.pr_ref));
    continue when not found;
    perform clued_private.work_claim_merge_rejoin_v1(c.claim_id,b.id,'hard_cap',null);
  end loop;
end $$;
revoke all on function clued_private.work_claim_merge_cap_rejoin_v1(public.clued_agent_bindings,text,text,text[]) from public,anon,authenticated;

do $keepalive_cap_rejoin$
declare body text; anchor text:='  perform clued_private.work_claim_expire_due(b.user_id);
';
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_merge_queue_keepalive_v1(public.clued_agent_bindings,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'merge_cap_rejoin_anchor_missing: work_claim_merge_queue_keepalive_v1';
  end if;
  execute replace(body,anchor,anchor||'  perform clued_private.work_claim_merge_cap_rejoin_v1(b,v_scope,v_prefix,v_prs);
');
end $keepalive_cap_rejoin$;

-- 3. A head that cannot land gives way (merge_queue_yield, an action of the
-- CI command door, behind its role check and claim lock like
-- merge_queue_join). Input {action, scope, pr_ref, head_sha}: the train
-- (stage 10 of the duty node) found the head claim's front pull request
-- pr_ref at head_sha unable to merge as it stands (draft, auto-merge off, a
-- GitHub Actions check failed: field 2026-11-15, #1121, whose required
-- checks never ran). When that claim is the head of merge:<repo>:main, is
-- bound to pr_ref, and another claim is waiting, it joins again at the back
-- (work_claim_merge_rejoin_v1, why cannot_land); otherwise nothing is
-- written (not_head, nobody_waiting). The server trusts the duty node's
-- judgment as it does for the join; yielding grants nothing and the claim
-- keeps its place behind the others.
create function clued_private.work_claim_merge_queue_yield_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=p_input->>'pr_ref'; v_head text:=lower(p_input->>'head_sha');
  v_prefix text; v_ref text; q jsonb; c clued_private.work_claims_v1%rowtype;
begin
  if not clued_private.work_claim_ci_assist_input_v1(p_input,array['action','scope','pr_ref','head_sha']) then
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
  if not exists(select 1 from jsonb_array_elements(q->'entries') e where e->>'state'='waiting') then
    return jsonb_build_object('status','ok','yielded',false,'reason','nobody_waiting','claim_id',c.claim_id,'pr_ref',v_pr,'head_sha',v_head); end if;
  perform clued_private.work_claim_merge_rejoin_v1(c.claim_id,b.id,'cannot_land',jsonb_build_object('pr',v_pr,'head_sha',v_head));
  select * into c from clued_private.work_claims_v1 where claim_id=c.claim_id;
  return jsonb_build_object('status','ok','yielded',true,'claim_id',c.claim_id,'pr_ref',v_pr,'head_sha',v_head,
    'merge_queue',clued_private.work_claim_merge_queue_view_v1(c));
end $$;
revoke all on function clued_private.work_claim_merge_queue_yield_v1(public.clued_agent_bindings,jsonb) from public,anon,authenticated;

do $ci_queue_yield$
declare body text; anchor text:=$a$  if op='merge_queue_join' then
    return clued_private.work_claim_ci_queue_join_v1(b,p_input);
  end if;
$a$;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 or position('merge_queue_yield' in body)>0 then
    raise exception 'merge_queue_yield_command_source_unexpected'; end if;
  execute replace(body,anchor,anchor||$a$  if op='merge_queue_yield' then
    return clued_private.work_claim_merge_queue_yield_v1(b,p_input);
  end if;
$a$);
end $ci_queue_yield$;

-- Self-check: both entries are in the live bodies. The database tests replay
-- every migration and check the same, so a later redefinition from older text
-- that drops either fails there instead of silently.
do $merge_turn_selfcheck$
begin
  if position('clued_private.work_claim_merge_cap_rejoin_v1(b,v_scope,v_prefix,v_prs)' in (select p.prosrc from pg_catalog.pg_proc p
      where p.oid='clued_private.work_claim_merge_queue_keepalive_v1(public.clued_agent_bindings,jsonb)'::regprocedure))=0
    or position('clued_private.work_claim_merge_queue_yield_v1(b,p_input)' in (select p.prosrc from pg_catalog.pg_proc p
      where p.oid='clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure))=0 then
    raise exception 'merge_turn_selfcheck_failed';
  end if;
end $merge_turn_selfcheck$;
