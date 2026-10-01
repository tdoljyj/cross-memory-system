-- Work Claim Admission v0.1, step 1 (development/contracts/execution-admission/
-- WorkClaimAdmission.v0.1.md §4, §8.1). A work claim is a time-limited, fenced
-- occupation of one existing Canonical Task by one Binding, for one declared
-- write set and set of trigger refs. Two claims conflict when they name the
-- same task, when their write sets intersect, or when their trigger refs
-- intersect (2026-10-01: #443/#444/#445 all upgraded next for the same GHSA
-- from the same base; none of the three shared a title).
--
-- This migration adds the table and the five RPCs only. No Worker tool, CI
-- gate, hook or contract text changes here; those are later steps.
--
-- Patterns reused on purpose:
-- * clued_private.currentness_user_lock + a per-user advisory lock, as the
--   projection refresh claim does, so claims never interleave with checkpoint
--   admission on the same user.
-- * lease/fence semantics from 20260923213100 (projection refresh): renewal
--   bumps lease_version only; a new claim or a takeover bumps fence.
-- * audit receipts in public.clued_audit_receipts, one per state change.
-- * budget as a hard per-Binding cap, as the N4 storage read budget does.

create table clued_private.work_claims_v1 (
  claim_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.clued_memories(id) on delete cascade,
  context_key text not null check (char_length(context_key) between 1 and 160),
  holder_binding_id uuid not null references public.clued_agent_bindings(id) on delete cascade,
  holder_session_ref text check (holder_session_ref is null or char_length(holder_session_ref) between 1 and 200),
  base_commit text check (base_commit is null or base_commit ~ '^[0-9a-f]{7,64}$'),
  write_set text[] not null check (cardinality(write_set) between 1 and 200),
  trigger_refs text[] not null default '{}'::text[] check (cardinality(trigger_refs) <= 50),
  fence bigint not null check (fence > 0),
  lease_version bigint not null default 1 check (lease_version > 0),
  issued_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  hard_deadline_at timestamptz not null,
  renewals integer not null default 0 check (renewals >= 0),
  progress_ref text check (progress_ref is null or char_length(progress_ref) between 1 and 200),
  budget jsonb not null default '{}'::jsonb,
  status text not null check (status in ('ACTIVE','DRAINING','RELEASED','EXPIRED','SUPERSEDED')),
  released_outcome text check (released_outcome is null or released_outcome in ('completed','abandoned')),
  superseded_by uuid,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  receipt_id uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint work_claims_v1_deadline_order check (issued_at <= expires_at and expires_at <= hard_deadline_at)
);
create unique index work_claims_v1_one_live_per_task
  on clued_private.work_claims_v1(user_id,task_id) where status in ('ACTIVE','DRAINING');
create unique index work_claims_v1_idempotency
  on clued_private.work_claims_v1(user_id,holder_binding_id,idempotency_key);
create index work_claims_v1_live_idx
  on clued_private.work_claims_v1(user_id,status,expires_at) where status in ('ACTIVE','DRAINING');
revoke all on clued_private.work_claims_v1 from public,anon,authenticated,service_role;

-- Profile. Fixed here on purpose: a missing value fails closed instead of
-- becoming an unlimited lease (design §4.4). Changing a number is a migration.
create function clued_private.work_claim_profile_v1() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'profile_id','work-claim-v1-default',
    'lease_seconds',7200,
    'hard_deadline_seconds',86400,
    'max_renewals',12,
    'max_active_per_binding',3)
$$;

create function clued_private.work_claim_lock(p_user_id uuid) returns void
language plpgsql volatile set search_path='' as $$
begin
  perform clued_private.currentness_user_lock(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued-work-claim:'||p_user_id::text,0));
end $$;

-- Paths: trimmed, no leading "./" or "/", no empty or ".." segments, sorted,
-- distinct. Globs keep "*" and "**". Anything else raises.
create function clued_private.work_claim_normalize_paths(p_paths jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare v_raw text; v_path text; v_out text[]:='{}'::text[];
begin
  if p_paths is null or jsonb_typeof(p_paths)<>'array' then
    raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
  for v_raw in select e#>>'{}' from jsonb_array_elements(p_paths) e loop
    if v_raw is null then raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
    v_path:=btrim(v_raw);
    v_path:=regexp_replace(v_path,'^(\./)+','');
    v_path:=regexp_replace(v_path,'^/+','');
    v_path:=regexp_replace(v_path,'/{2,}','/','g');
    v_path:=regexp_replace(v_path,'/+$','');
    if v_path='' or char_length(v_path)>400 or v_path ~ '(^|/)\.\.(/|$)'
      or v_path ~ '[[:space:][:cntrl:]]' then
      raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
    if not (v_path=any(v_out)) then v_out:=v_out||v_path; end if;
  end loop;
  if cardinality(v_out)=0 then raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
  select array_agg(x order by x) into v_out from unnest(v_out) x;
  return v_out;
end $$;

-- Trigger refs: "<kind>:<value>", lower-cased kind, trimmed, distinct, sorted.
create function clued_private.work_claim_normalize_triggers(p_refs jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare v_raw text; v_ref text; v_out text[]:='{}'::text[];
begin
  if p_refs is null then return v_out; end if;
  if jsonb_typeof(p_refs)<>'array' then
    raise exception 'work_claim_trigger_refs_invalid' using errcode='22023'; end if;
  for v_raw in select e#>>'{}' from jsonb_array_elements(p_refs) e loop
    if v_raw is null then raise exception 'work_claim_trigger_refs_invalid' using errcode='22023'; end if;
    v_ref:=btrim(v_raw);
    if v_ref !~ '^[A-Za-z][A-Za-z0-9_-]{0,31}:[^[:space:][:cntrl:]]{1,200}$' then
      raise exception 'work_claim_trigger_refs_invalid' using errcode='22023'; end if;
    v_ref:=lower(split_part(v_ref,':',1))||':'||substr(v_ref,strpos(v_ref,':')+1);
    if not (v_ref=any(v_out)) then v_out:=v_out||v_ref; end if;
  end loop;
  select coalesce(array_agg(x order by x),'{}'::text[]) into v_out from unnest(v_out) x;
  return v_out;
end $$;

-- One normalized path or glob to an anchored regex. "**" crosses "/", "*"
-- does not. A trailing "/**" also matches the directory itself.
create function clued_private.work_claim_glob_regex(p_glob text) returns text
language plpgsql immutable set search_path='' as $$
declare v text; v_dir boolean:=right(p_glob,3)='/**';
begin
  v:=case when v_dir then left(p_glob,length(p_glob)-3) else p_glob end;
  v:=regexp_replace(v,'([.+?^${}()|\[\]\\])','\\\1','g');
  v:=replace(v,'**',chr(1));
  v:=replace(v,'*','[^/]*');
  v:=replace(v,chr(1),'.*');
  if v_dir then return '^'||v||'(/.*)?$'; end if;
  return '^'||v||'$';
end $$;

-- A concrete path is covered by a write set when it equals an entry or
-- matches an entry's glob.
create function clued_private.work_claim_path_covered(p_path text,p_set text[]) returns boolean
language sql immutable set search_path='' as $$
  select exists(select 1 from unnest(p_set) g
    where g=p_path or p_path ~ clued_private.work_claim_glob_regex(g))
$$;

-- Two write sets overlap when any entry of one is covered by the other, in
-- either direction (a glob in A over a path in B, or the reverse).
create function clued_private.work_claim_paths_overlap(p_a text[],p_b text[]) returns text[]
language sql immutable set search_path='' as $$
  select coalesce(array_agg(distinct x order by x),'{}'::text[]) from (
    select a x from unnest(p_a) a where clued_private.work_claim_path_covered(a,p_b)
    union
    select b x from unnest(p_b) b where clued_private.work_claim_path_covered(b,p_a)
  ) o
$$;

-- Time has passed: live claims past expires_at become EXPIRED, with one
-- receipt per claim. Called under the user lock by every write RPC.
create function clued_private.work_claim_expire_due(p_user_id uuid) returns integer
language plpgsql volatile security definer set search_path='' as $$
declare v_count integer:=0; r record;
begin
  for r in update clued_private.work_claims_v1 c set status='EXPIRED',
      updated_at=pg_catalog.clock_timestamp()
    where c.user_id=p_user_id and c.status in ('ACTIVE','DRAINING')
      and c.expires_at<=pg_catalog.clock_timestamp()
    returning c.claim_id,c.task_id,c.context_key,c.holder_binding_id,c.fence,c.expires_at loop
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
      object_type,object_id,version,metadata)
    values(p_user_id,r.holder_binding_id,r.context_key,'work_claim_expire','work_claim',
      r.claim_id::text,r.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_EXPIRED',
        'claim_id',r.claim_id,'task_id',r.task_id,'fence',r.fence,'expired_at',r.expires_at));
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

create function clued_private.work_claim_view(c clued_private.work_claims_v1) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
    'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
    'base_commit',c.base_commit,'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs),
    'fence',c.fence,'lease_version',c.lease_version,'issued_at',c.issued_at,
    'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'renewals',c.renewals,
    'progress_ref',c.progress_ref,'budget',c.budget,'status',c.status,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'receipt_id',c.receipt_id)
$$;

-- Live claims of the same user that conflict with (task, write_set, triggers),
-- excluding p_exclude. Returns a json array of conflict descriptions.
create function clued_private.work_claim_conflicts(
  p_user_id uuid,p_task_id uuid,p_write_set text[],p_triggers text[],p_exclude uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare v_out jsonb:='[]'::jsonb; c clued_private.work_claims_v1%rowtype;
  v_paths text[]; v_trig text[];
begin
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING')
      and w.expires_at>pg_catalog.clock_timestamp()
      and (p_exclude is null or w.claim_id<>p_exclude)
    order by w.issued_at loop
    v_paths:=clued_private.work_claim_paths_overlap(c.write_set,p_write_set);
    select coalesce(array_agg(t order by t),'{}'::text[]) into v_trig
      from unnest(c.trigger_refs) t where t=any(p_triggers);
    if c.task_id=p_task_id or cardinality(v_paths)>0 or cardinality(v_trig)>0 then
      v_out:=v_out||jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,
        'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
        'status',c.status,'fence',c.fence,'expires_at',c.expires_at,
        'overlap',jsonb_build_object('same_task',c.task_id=p_task_id,
          'paths',to_jsonb(v_paths),'trigger_refs',to_jsonb(v_trig)));
    end if;
  end loop;
  return v_out;
end $$;

create function clued_private.work_claim_rejected(p_code text,p_detail jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('status','rejected','error_code',p_code)||coalesce(p_detail,'{}'::jsonb)
$$;

-- Shared body for claim and takeover: validates the task, normalizes the
-- declared sets, checks conflicts and the per-Binding cap, inserts the claim
-- with fence = max(fence of this task)+1, writes the receipt.
create function clued_private.work_claim_issue(
  p_binding public.clued_agent_bindings,p_input jsonb,p_task public.clued_memories,
  p_supersedes clued_private.work_claims_v1,p_operation text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_profile jsonb:=clued_private.work_claim_profile_v1();
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_active integer;
  v_fence bigint; v_lease interval; v_now timestamptz:=pg_catalog.clock_timestamp();
  v_claim clued_private.work_claims_v1%rowtype; v_receipt uuid; v_budget jsonb;
  v_session text:=nullif(btrim(coalesce(p_input->>'holder_session_ref','')),'');
  v_base text:=nullif(btrim(coalesce(p_input->>'base_commit','')),'');
  v_lease_seconds integer;
begin
  if p_input ? 'write_set' then
    v_write_set:=clued_private.work_claim_normalize_paths(p_input->'write_set');
  elsif p_supersedes.claim_id is not null then
    v_write_set:=p_supersedes.write_set;
  else
    raise exception 'work_claim_write_set_invalid' using errcode='22023';
  end if;
  if p_input ? 'trigger_refs' then
    v_triggers:=clued_private.work_claim_normalize_triggers(p_input->'trigger_refs');
  elsif p_supersedes.claim_id is not null then
    v_triggers:=p_supersedes.trigger_refs;
  else
    v_triggers:='{}'::text[];
  end if;
  if v_base is not null and v_base !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_base_commit_invalid' using errcode='22023'; end if;
  v_lease_seconds:=coalesce((p_input->>'lease_seconds')::integer,(v_profile->>'lease_seconds')::integer);
  if v_lease_seconds<60 or v_lease_seconds>(v_profile->>'lease_seconds')::integer then
    raise exception 'work_claim_lease_seconds_invalid' using errcode='22023'; end if;
  v_lease:=make_interval(secs=>v_lease_seconds);
  v_budget:=coalesce(p_input->'budget','{}'::jsonb);
  if jsonb_typeof(v_budget)<>'object' then
    raise exception 'work_claim_budget_invalid' using errcode='22023'; end if;

  v_conflicts:=clued_private.work_claim_conflicts(p_binding.user_id,p_task.id,v_write_set,
    v_triggers,p_supersedes.claim_id);
  if jsonb_array_length(v_conflicts)>0 then
    return clued_private.work_claim_rejected('work_claim_conflict',
      jsonb_build_object('conflicts',v_conflicts,'task_id',p_task.id,
        'write_set',to_jsonb(v_write_set),'trigger_refs',to_jsonb(v_triggers)));
  end if;
  select count(*)::integer into v_active from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.holder_binding_id=p_binding.id
      and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now;
  if v_active>=(v_profile->>'max_active_per_binding')::integer then
    return clued_private.work_claim_rejected('work_claim_budget_exhausted',
      jsonb_build_object('limit','max_active_per_binding',
        'max_active_per_binding',(v_profile->>'max_active_per_binding')::integer,'active',v_active));
  end if;

  select coalesce(max(w.fence),0)+1 into v_fence from clued_private.work_claims_v1 w
    where w.user_id=p_binding.user_id and w.task_id=p_task.id;
  insert into clued_private.work_claims_v1(user_id,task_id,context_key,holder_binding_id,
    holder_session_ref,base_commit,write_set,trigger_refs,fence,lease_version,issued_at,
    expires_at,hard_deadline_at,budget,status,idempotency_key)
  values(p_binding.user_id,p_task.id,p_task.canonical_scope,p_binding.id,v_session,v_base,
    v_write_set,v_triggers,v_fence,1,v_now,v_now+v_lease,
    v_now+make_interval(secs=>(v_profile->>'hard_deadline_seconds')::integer),
    v_budget||jsonb_build_object('profile_id',v_profile->>'profile_id'),'ACTIVE',
    p_input->>'idempotency_key')
  returning * into v_claim;
  if p_supersedes.claim_id is not null then
    update clued_private.work_claims_v1 set status='SUPERSEDED',superseded_by=v_claim.claim_id,
      updated_at=v_now where claim_id=p_supersedes.claim_id;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(p_binding.user_id,p_binding.id,p_task.canonical_scope,p_operation,'work_claim',
    v_claim.claim_id::text,v_claim.fence,jsonb_build_object(
      'receipt_kind',case p_operation when 'work_claim' then 'WORK_CLAIM_ISSUED'
        else 'WORK_CLAIM_TAKEOVER' end,
      'claim_id',v_claim.claim_id,'task_id',v_claim.task_id,'fence',v_claim.fence,
      'lease_version',v_claim.lease_version,'write_set',to_jsonb(v_claim.write_set),
      'trigger_refs',to_jsonb(v_claim.trigger_refs),'base_commit',v_claim.base_commit,
      'expires_at',v_claim.expires_at,'hard_deadline_at',v_claim.hard_deadline_at,
      'supersedes',p_supersedes.claim_id,'superseded_fence',p_supersedes.fence,
      'idempotency_key',p_input->>'idempotency_key','profile',v_profile))
  returning id into v_receipt;
  update clued_private.work_claims_v1 set receipt_id=v_receipt where claim_id=v_claim.claim_id
    returning * into v_claim;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(v_claim));
end $$;

-- Resolve the Binding for a write RPC. The input names the scope (as
-- clued_record_mutate does); the task must live in that scope.
create function clued_private.work_claim_task(p_user_id uuid,p_scope text,p_task_id text)
returns public.clued_memories language plpgsql stable set search_path='' as $$
declare t public.clued_memories%rowtype;
begin
  if coalesce(p_task_id,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'work_claim_task_invalid' using errcode='22023'; end if;
  select * into t from public.clued_memories m where m.user_id=p_user_id
    and m.id::text=lower(p_task_id) and m.record_type='task'
    and m.record_schema_version is not null;
  if not found or t.lifecycle_status<>'active' or t.canonical_scope is distinct from p_scope then
    raise exception 'work_claim_task_unavailable' using errcode='22023'; end if;
  return t;
end $$;

create function clued_private.work_claim_idempotency(p_key text) returns void
language plpgsql immutable set search_path='' as $$
begin
  if coalesce(char_length(p_key),0) not between 8 and 160 then
    raise exception 'work_claim_idempotency_key_invalid' using errcode='22023'; end if;
end $$;

-- clued_work_claim_v1: {scope, task_id, write_set, trigger_refs?, base_commit?,
--   holder_session_ref?, budget?, lease_seconds?, idempotency_key}
create function public.clued_work_claim_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_task public.clued_memories%rowtype;
  v_existing clued_private.work_claims_v1%rowtype; v_none clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global');
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into v_existing from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.holder_binding_id=v_binding.id
      and w.idempotency_key=p_input->>'idempotency_key';
  if found then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_existing.receipt_id,
      'claim',clued_private.work_claim_view(v_existing));
  end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,p_input->>'task_id');
  return clued_private.work_claim_issue(v_binding,p_input,v_task,v_none,'work_claim');
end $$;

-- clued_work_renew_v1: {scope, claim_id, fence, lease_version, progress_ref,
--   write_set?, trigger_refs?}. Renewal extends expires_at (never past the hard
--   deadline), bumps lease_version, keeps fence. progress_ref must change.
--   A changed write_set/trigger_refs re-runs conflict detection.
create function public.clued_work_renew_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_profile jsonb:=clued_private.work_claim_profile_v1(); v_now timestamptz:=pg_catalog.clock_timestamp();
  v_scope text:=coalesce(p_input->>'scope','global'); v_progress text;
  v_write_set text[]; v_triggers text[]; v_conflicts jsonb; v_receipt uuid; v_expires timestamptz;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then return clued_private.work_claim_rejected('work_claim_not_found',null); end if;
  if c.holder_binding_id<>v_binding.id then
    return clued_private.work_claim_rejected('work_claim_not_holder',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status='EXPIRED' then
    return clued_private.work_claim_rejected('work_claim_expired',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status<>'ACTIVE' then
    return clued_private.work_claim_rejected('work_claim_not_active',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if (p_input->>'fence')::bigint is distinct from c.fence then
    return clued_private.work_claim_rejected('work_claim_fence_mismatch',
      jsonb_build_object('expected_fence',c.fence)); end if;
  if (p_input->>'lease_version')::bigint is distinct from c.lease_version then
    return clued_private.work_claim_rejected('work_claim_version_conflict',
      jsonb_build_object('expected_lease_version',c.lease_version)); end if;
  v_progress:=nullif(btrim(coalesce(p_input->>'progress_ref','')),'');
  if v_progress is null or v_progress is not distinct from c.progress_ref then
    return clued_private.work_claim_rejected('work_claim_no_progress',
      jsonb_build_object('last_progress_ref',c.progress_ref)); end if;
  if c.renewals>=(v_profile->>'max_renewals')::integer then
    return clued_private.work_claim_rejected('work_claim_renewal_budget_exhausted',
      jsonb_build_object('max_renewals',(v_profile->>'max_renewals')::integer,'renewals',c.renewals)); end if;
  if c.expires_at>=c.hard_deadline_at then
    return clued_private.work_claim_rejected('work_claim_hard_deadline',
      jsonb_build_object('hard_deadline_at',c.hard_deadline_at)); end if;

  v_write_set:=case when p_input ? 'write_set'
    then clued_private.work_claim_normalize_paths(p_input->'write_set') else c.write_set end;
  v_triggers:=case when p_input ? 'trigger_refs'
    then clued_private.work_claim_normalize_triggers(p_input->'trigger_refs') else c.trigger_refs end;
  if v_write_set<>c.write_set or v_triggers<>c.trigger_refs then
    v_conflicts:=clued_private.work_claim_conflicts(v_binding.user_id,c.task_id,v_write_set,v_triggers,c.claim_id);
    if jsonb_array_length(v_conflicts)>0 then
      return clued_private.work_claim_rejected('work_claim_conflict',
        jsonb_build_object('conflicts',v_conflicts,'write_set',to_jsonb(v_write_set),
          'trigger_refs',to_jsonb(v_triggers)));
    end if;
  end if;
  v_expires:=least(v_now+make_interval(secs=>(v_profile->>'lease_seconds')::integer),c.hard_deadline_at);
  update clued_private.work_claims_v1 set lease_version=lease_version+1,renewals=renewals+1,
    expires_at=v_expires,progress_ref=v_progress,write_set=v_write_set,trigger_refs=v_triggers,
    updated_at=v_now where claim_id=c.claim_id returning * into c;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_renew','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_RENEWED',
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'lease_version',c.lease_version,
      'renewals',c.renewals,'progress_ref',c.progress_ref,'expires_at',c.expires_at,
      'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs)))
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c));
end $$;

-- clued_work_release_v1: {scope, claim_id, fence, outcome: completed|abandoned|draining,
--   evidence_ref?}. completed/abandoned -> RELEASED. draining -> DRAINING: the
--   claim keeps blocking conflicts but accepts no new work; it can be taken
--   over once expired, or released later.
create function public.clued_work_release_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_outcome text:=p_input->>'outcome';
  v_receipt uuid; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(v_outcome,'') not in ('completed','abandoned','draining') then
    raise exception 'work_claim_outcome_invalid' using errcode='22023'; end if;
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then return clued_private.work_claim_rejected('work_claim_not_found',null); end if;
  if c.holder_binding_id<>v_binding.id then
    return clued_private.work_claim_rejected('work_claim_not_holder',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if c.status not in ('ACTIVE','DRAINING') then
    return clued_private.work_claim_rejected('work_claim_not_active',
      jsonb_build_object('claim',clued_private.work_claim_view(c))); end if;
  if (p_input->>'fence')::bigint is distinct from c.fence then
    return clued_private.work_claim_rejected('work_claim_fence_mismatch',
      jsonb_build_object('expected_fence',c.fence)); end if;
  if v_outcome='draining' then
    update clued_private.work_claims_v1 set status='DRAINING',updated_at=v_now
      where claim_id=c.claim_id returning * into c;
  else
    update clued_private.work_claims_v1 set status='RELEASED',released_outcome=v_outcome,
      updated_at=v_now where claim_id=c.claim_id returning * into c;
  end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
    object_type,object_id,version,metadata)
  values(v_binding.user_id,v_binding.id,c.context_key,'work_claim_release','work_claim',
    c.claim_id::text,c.fence,jsonb_build_object('receipt_kind',
      case v_outcome when 'draining' then 'WORK_CLAIM_DRAINING' else 'WORK_CLAIM_RELEASED' end,
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'outcome',v_outcome,
      'evidence_ref',p_input->>'evidence_ref','status',c.status))
  returning id into v_receipt;
  return jsonb_build_object('status','committed','receipt_id',v_receipt,
    'claim',clued_private.work_claim_view(c));
end $$;

-- clued_work_verify_v1: {scope, claim_id, changed_paths?, head_sha?, base_sha?}.
--   Read-only (context:read). ADMITTED only when the claim is live, holds the
--   current fence for its task, and every changed path is covered by the write
--   set. Reasons are listed so a CI check can print them. No receipt: this is
--   a read, and CI may call it often.
create function public.clued_work_verify_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_reasons jsonb:='[]'::jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_max_fence bigint; v_paths text[];
  v_outside text[]:='{}'::text[]; v_p text; v_claim_view jsonb;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into c from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope;
  if not found then
    return jsonb_build_object('status','ok','verdict','REJECTED','verified_at',v_now,
      'reasons',jsonb_build_array('claim_not_found'));
  end if;
  v_claim_view:=clued_private.work_claim_view(c);
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
  return jsonb_build_object('status','ok',
    'verdict',case when jsonb_array_length(v_reasons)=0 then 'ADMITTED' else 'REJECTED' end,
    'verified_at',v_now,'reasons',v_reasons,'paths_outside_write_set',to_jsonb(v_outside),
    'current_fence',v_max_fence,'head_sha',p_input->>'head_sha','base_sha',p_input->>'base_sha',
    'claim',v_claim_view);
end $$;

-- clued_work_takeover_v1: {scope, claim_id (the claim to supersede), idempotency_key,
--   write_set?, trigger_refs?, base_commit?, holder_session_ref?, budget?}.
--   Only an EXPIRED claim, or a live one whose expires_at has passed, can be
--   taken over. A live, unexpired claim is never taken over here (design §4.4:
--   priority does not preempt; forced takeover needs its own Owner path).
create function public.clued_work_takeover_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; v_old clued_private.work_claims_v1%rowtype;
  v_existing clued_private.work_claims_v1%rowtype; v_task public.clued_memories%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global');
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:write',v_scope);
  perform clued_private.work_claim_idempotency(p_input->>'idempotency_key');
  perform clued_private.work_claim_lock(v_binding.user_id);
  select * into v_existing from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.holder_binding_id=v_binding.id
      and w.idempotency_key=p_input->>'idempotency_key';
  if found then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',v_existing.receipt_id,
      'claim',clued_private.work_claim_view(v_existing));
  end if;
  perform clued_private.work_claim_expire_due(v_binding.user_id);
  if coalesce(p_input->>'claim_id','') !~* '^[0-9a-f-]{36}$' then
    raise exception 'work_claim_id_invalid' using errcode='22023'; end if;
  select * into v_old from clued_private.work_claims_v1 w where w.user_id=v_binding.user_id
    and w.claim_id=(p_input->>'claim_id')::uuid and w.context_key=v_scope for update;
  if not found then return clued_private.work_claim_rejected('work_claim_not_found',null); end if;
  if v_old.status in ('RELEASED','SUPERSEDED') then
    return clued_private.work_claim_rejected('work_claim_not_takeover_eligible',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  if v_old.status in ('ACTIVE','DRAINING') and v_old.expires_at>pg_catalog.clock_timestamp() then
    return clued_private.work_claim_rejected('work_claim_still_active',
      jsonb_build_object('claim',clued_private.work_claim_view(v_old))); end if;
  v_task:=clued_private.work_claim_task(v_binding.user_id,v_scope,v_old.task_id::text);
  return clued_private.work_claim_issue(v_binding,p_input,v_task,v_old,'work_claim_takeover');
end $$;

revoke all on function
  clued_private.work_claim_profile_v1(),
  clued_private.work_claim_lock(uuid),
  clued_private.work_claim_normalize_paths(jsonb),
  clued_private.work_claim_normalize_triggers(jsonb),
  clued_private.work_claim_glob_regex(text),
  clued_private.work_claim_path_covered(text,text[]),
  clued_private.work_claim_paths_overlap(text[],text[]),
  clued_private.work_claim_expire_due(uuid),
  clued_private.work_claim_view(clued_private.work_claims_v1),
  clued_private.work_claim_conflicts(uuid,uuid,text[],text[],uuid),
  clued_private.work_claim_rejected(text,jsonb),
  clued_private.work_claim_issue(public.clued_agent_bindings,jsonb,public.clued_memories,clued_private.work_claims_v1,text),
  clued_private.work_claim_task(uuid,text,text),
  clued_private.work_claim_idempotency(text)
  from public,anon,authenticated,service_role;
revoke all on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_release_v1(text,jsonb),
  public.clued_work_verify_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function
  public.clued_work_claim_v1(text,jsonb),
  public.clued_work_renew_v1(text,jsonb),
  public.clued_work_release_v1(text,jsonb),
  public.clued_work_verify_v1(text,jsonb),
  public.clued_work_takeover_v1(text,jsonb)
  to anon;

notify pgrst,'reload schema';
