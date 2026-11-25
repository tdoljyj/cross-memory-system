-- #1357 and #1359 required manual claim release after merging because an open
-- binding left by another claim blocked release for the whole Task. Keep the
-- current claim only for another open PR it authorized by PR ref or served in CI,
-- or when a newer authorization elsewhere already prevents release.
-- A head authorized without a PR ref before this PR's last admission, with no
-- CI admission of its own yet, can still need a new claim and authorization.

do $pr_end_release_predecessor$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid='clued_private.work_claim_pr_end_release_v1(public.clued_agent_bindings,text,text,text)'::regprocedure
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='d1ecc346945f69f484a643af7cdb8e54c1d3f1515d56a97307364bba107b8efc'
      and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']
      and pg_catalog.pg_get_userbyid(p.proowner)='postgres' and p.proacl::text='{postgres=X/postgres}'
  ) then
    raise exception 'work_claim_pr_end_release_served_only_source_changed' using errcode='22023';
  end if;
end $pr_end_release_predecessor$;

create function clued_private.work_claim_pr_served_at_v1(c clued_private.work_claims_v1,p_pr text)
returns timestamptz language sql stable set search_path='' as $$
  select max(x.at) from (
    select a.issued_at at from clued_private.work_claim_head_authorizations_v1 a
      where a.user_id=(c).user_id and a.claim_id=(c).claim_id and lower(a.pr_ref)=lower(p_pr)
    union all select e.created_at from clued_private.work_claim_execution_admissions_v1 e
      where e.user_id=(c).user_id and e.claim_id=(c).claim_id and lower(e.pr_ref)=lower(p_pr)
  ) x
$$;
revoke all on function clued_private.work_claim_pr_served_at_v1(clued_private.work_claims_v1,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.work_claim_pr_end_release_v1(
  b public.clued_agent_bindings,p_scope text,p_pr text,p_merge_sha text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare pr text:=lower(p_pr); target clued_private.work_claim_pr_task_bindings_v1;
  c clued_private.work_claims_v1; since timestamptz; merge_sha text:=lower(p_merge_sha);
begin
  select * into target from clued_private.work_claim_pr_task_bindings_v1
    where user_id=b.user_id and repo_id=split_part(pr,'#',1) and pr_number=split_part(pr,'#',2)::bigint;
  if not found or target.status not in ('merged','closed') then return; end if;
  if target.status<>'merged' or coalesce(merge_sha,'') !~ '^[0-9a-f]{7,64}$' then merge_sha:=null; end if;
  for c in select * from clued_private.work_claims_v1 w where w.user_id=target.user_id and w.task_id=target.task_id
      and w.context_key=p_scope and w.status='ACTIVE' for update loop
    since := clued_private.work_claim_pr_served_at_v1(c,pr);
    continue when since is null or exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
      where a.user_id=c.user_id and a.claim_id=c.claim_id and a.revoked_at is null and a.issued_at>since
        and lower(a.pr_ref) is distinct from pr)
      or exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 o
        where o.user_id=c.user_id and o.task_id=c.task_id
          and (o.repo_id,o.pr_number)<>(target.repo_id,target.pr_number)
          and clued_private.work_claim_pr_binding_open_v1(o.status)
          and clued_private.work_claim_pr_served_at_v1(c,o.repo_id||'#'||o.pr_number) is not null);
    update clued_private.work_claims_v1 set status='RELEASED',released_outcome='completed',lease_key_hash=null,
      released_by='pr_end',released_evidence_ref=pr||coalesce('@'||merge_sha,''),
      updated_at=pg_catalog.clock_timestamp() where user_id=c.user_id and claim_id=c.claim_id returning * into c;
    -- Keep evidence_ref=PR unchanged for the existing free-continuation rule.
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(c.user_id,c.holder_binding_id,c.context_key,'work_claim_release','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('receipt_kind','WORK_CLAIM_RELEASED','claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,
        'outcome','completed','evidence_ref',pr,'status','RELEASED','released_by_binding_id',b.id,
        'released_by',c.released_by,'released_evidence_ref',c.released_evidence_ref,'released_at',c.released_at));
    begin
      perform clued_private.work_claim_pr_end_notify_v1(b,c,pr,target.status,merge_sha);
    exception when others then
      raise warning 'work_claim_pr_end_notification_skipped: % %',sqlstate,sqlerrm;
    end;
  end loop;
end $$;
