-- Work Claim Admission v0.1, step 7 review fixes (Owner Decision 64d9b418;
-- Tasks 047e663e and 21a77b34; development/contracts/execution-admission/
-- WorkClaimAdmission.v0.1.md §4.3, §6).
--
-- 1. Glob against glob. work_claim_paths_overlap compared a glob of one side
--    only against the literal text of the other side, so `apps/clued-cloud/**`
--    and `**/package-lock.json` never conflicted although both cover
--    apps/clued-cloud/package-lock.json (the #443/#444 lockfile case). Two
--    entries now overlap when some path could match both. The test is
--    per segment and errs toward overlap: a segment holding "**" matches any
--    number of segments, and two single-segment wildcards overlap whenever
--    their literal prefixes and suffixes are compatible. It can report a
--    conflict for two globs that share no path; it never misses one.
--
-- 2. A claim admits one pull request. clued_work_verify_v1 accepts an optional
--    pr_ref ("owner/repo#123"). The first verify that would admit with a
--    pr_ref binds the claim to that pull request (one audit receipt); any
--    other pr_ref is REJECTED with claim_bound_to_other_pr. A verify without
--    pr_ref is unchanged (the MCP tool does not pass one). This is the only
--    write verify makes, and it is made under the read-only Binding the CI
--    gate holds: it records which pull request used the claim, nothing else.
--    A new claim or a takeover starts unbound.

alter table clued_private.work_claims_v1
  add column bound_pr text check (bound_pr is null or bound_pr ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$');

-- Two path segments without "**" can name the same directory entry.
create function clued_private.work_claim_segments_compatible(p_a text,p_b text) returns boolean
language plpgsql immutable set search_path='' as $$
declare v_a_wild boolean:=position('*' in p_a)>0; v_b_wild boolean:=position('*' in p_b)>0;
  v_pa text; v_pb text; v_sa text; v_sb text; v_n integer;
begin
  if p_a=p_b then return true; end if;
  if not v_a_wild and not v_b_wild then return false; end if;
  if v_a_wild and not v_b_wild then return p_b ~ clued_private.work_claim_glob_regex(p_a); end if;
  if v_b_wild and not v_a_wild then return p_a ~ clued_private.work_claim_glob_regex(p_b); end if;
  -- Both wildcards: a shared name starts with both literal prefixes and ends
  -- with both literal suffixes, so one prefix (suffix) extends the other.
  v_pa:=split_part(p_a,'*',1); v_pb:=split_part(p_b,'*',1);
  v_n:=least(char_length(v_pa),char_length(v_pb));
  if left(v_pa,v_n)<>left(v_pb,v_n) then return false; end if;
  v_sa:=regexp_replace(p_a,'^.*\*',''); v_sb:=regexp_replace(p_b,'^.*\*','');
  v_n:=least(char_length(v_sa),char_length(v_sb));
  return right(v_sa,v_n)=right(v_sb,v_n);
end $$;

-- Could one repository path match both globs? Dynamic programming over the
-- segments of each side; a segment containing "**" matches zero or more
-- segments (a trailing "/**" therefore also covers the directory itself).
create function clued_private.work_claim_globs_intersect(p_a text,p_b text) returns boolean
language plpgsql immutable set search_path='' as $$
declare a text[]:=string_to_array(p_a,'/'); b text[]:=string_to_array(p_b,'/');
  n integer; m integer; w integer; dp boolean[]; i integer; j integer;
  v_a_any boolean; v_b_any boolean; v boolean;
begin
  if p_a=p_b then return true; end if;
  n:=cardinality(a); m:=cardinality(b); w:=m+1;
  -- dp[i*w+j+1]: the suffixes a[i+1..n] and b[j+1..m] can match one path.
  dp:=array_fill(false,array[(n+1)*w]);
  dp[n*w+m+1]:=true;
  for i in reverse n..0 loop
    for j in reverse m..0 loop
      continue when i=n and j=m;
      v_a_any:=i<n and position('**' in a[i+1])>0;
      v_b_any:=j<m and position('**' in b[j+1])>0;
      if v_a_any then
        v:=dp[(i+1)*w+j+1] or (j<m and dp[i*w+j+2]);
      elsif v_b_any then
        v:=dp[i*w+j+2] or (i<n and dp[(i+1)*w+j+1]);
      elsif i<n and j<m then
        v:=clued_private.work_claim_segments_compatible(a[i+1],b[j+1]) and dp[(i+1)*w+j+2];
      else
        v:=false;
      end if;
      dp[i*w+j+1]:=coalesce(v,false);
    end loop;
  end loop;
  return dp[1];
end $$;

-- Same signature and shape as before: the entries that overlap. When the old
-- one-sided coverage rule (a glob of one side over a literal of the other)
-- finds overlap, its report is returned unchanged; otherwise the entries of
-- either side that intersect some entry of the other side. Either way the new
-- test can only add conflicts, never remove one.
create or replace function clued_private.work_claim_paths_overlap(p_a text[],p_b text[]) returns text[]
language sql immutable set search_path='' as $$
  with covered as (
    select coalesce(array_agg(distinct x order by x),'{}'::text[]) v from (
      select a x from unnest(p_a) a where clued_private.work_claim_path_covered(a,p_b)
      union
      select b x from unnest(p_b) b where clued_private.work_claim_path_covered(b,p_a)
    ) o
  ), intersecting as (
    select coalesce(array_agg(distinct x order by x),'{}'::text[]) v from (
      select a x from unnest(p_a) a
        where exists(select 1 from unnest(p_b) b where clued_private.work_claim_globs_intersect(a,b))
      union
      select b x from unnest(p_b) b
        where exists(select 1 from unnest(p_a) a where clued_private.work_claim_globs_intersect(a,b))
    ) o
  )
  select case when cardinality(covered.v)>0 then covered.v else intersecting.v end
  from covered,intersecting
$$;

create or replace function clued_private.work_claim_view(c clued_private.work_claims_v1) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
    'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
    'base_commit',c.base_commit,'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs),
    'fence',c.fence,'lease_version',c.lease_version,'issued_at',c.issued_at,
    'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'renewals',c.renewals,
    'progress_ref',c.progress_ref,'budget',c.budget,'status',c.status,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'receipt_id',c.receipt_id,
    'bound_pr',c.bound_pr)
$$;

create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_reasons jsonb:='[]'::jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_max_fence bigint; v_paths text[];
  v_outside text[]:='{}'::text[]; v_p text; v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  if p_input ? 'pr_ref' and (v_pr is null
      or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$') then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  -- With a pr_ref the row is locked: two pull requests verified at once
  -- cannot both bind the same claim.
  if v_pr is null then
    select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
      and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope;
  else
    select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
      and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  end if;
  if not found then
    return jsonb_build_object('status','ok','verdict','REJECTED','verified_at',v_now,
      'reasons',jsonb_build_array('claim_not_found'));
  end if;
  if c.status not in ('ACTIVE','DRAINING') or c.expires_at<=v_now then
    v_reasons:=v_reasons||to_jsonb('claim_not_current'::text); end if;
  select max(w.fence) into v_max_fence from clued_private.work_claims_v1 w
    where w.user_id=c.user_id and w.task_id=c.task_id;
  if v_max_fence<>c.fence then v_reasons:=v_reasons||to_jsonb('fence_superseded'::text); end if;
  if p_input ? 'changed_paths' then
    v_paths:=clued_private.work_claim_normalize_paths(p_input->'changed_paths');
    foreach v_p in array v_paths loop
      if not clued_private.work_claim_path_covered(v_p,c.write_set) then v_outside:=v_outside||v_p; end if;
    end loop;
    if cardinality(v_outside)>0 then v_reasons:=v_reasons||to_jsonb('paths_outside_write_set'::text); end if;
  end if;
  if v_pr is not null and c.bound_pr is not null and c.bound_pr<>v_pr then
    v_reasons:=v_reasons||to_jsonb('claim_bound_to_other_pr'::text);
  end if;
  if v_pr is not null and c.bound_pr is null and jsonb_array_length(v_reasons)=0 then
    update clued_private.work_claims_v1 set bound_pr=v_pr,updated_at=v_now
      where claim_id=c.claim_id returning * into c;
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
      object_type,object_id,version,metadata)
    values(c.user_id,v_binding.id,c.context_key,'work_claim_bind_pr','work_claim',
      c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_BOUND_TO_PR',
        'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'bound_pr',v_pr,
        'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha'));
  end if;
  return jsonb_build_object('status','ok',
    'verdict',case when jsonb_array_length(v_reasons)=0 then 'ADMITTED' else 'REJECTED' end,
    'verified_at',v_now,'reasons',v_reasons,'paths_outside_write_set',to_jsonb(v_outside),
    'current_fence',v_max_fence,'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
    'pr_ref',v_pr,'bound_pr',c.bound_pr,'claim',clued_private.work_claim_view(c));
end $$;

revoke all on function
  clued_private.work_claim_segments_compatible(text,text),
  clued_private.work_claim_globs_intersect(text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_work_verify_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_work_verify_v1(text,jsonb) to anon;

notify pgrst,'reload schema';
