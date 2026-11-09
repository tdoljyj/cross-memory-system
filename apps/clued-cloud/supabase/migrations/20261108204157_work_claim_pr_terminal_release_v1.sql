-- Conditional terminal release uses only the existing claim, PR relation,
-- admission and immutable Receipt stores. No generic CI release RPC is added.
create function clued_private.work_claim_terminal_resources_v1(c clued_private.work_claims_v1)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(coalesce(
    (select array_agg(t order by t) from unnest(c.trigger_refs) t where t not like 'merge:%'),'{}'::text[])))
$$;

create function clued_private.work_claim_terminal_ready_receipt_v1(c clued_private.work_claims_v1)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare ready uuid; holder public.clued_agent_bindings;
begin
  select case when r.metadata->'ready'='true'::jsonb and c.status='ACTIVE' and c.expires_at>clock_timestamp()
    and not c.execution_handover_pending and r.binding_id=c.holder_binding_id
    and r.metadata->>'fence'=c.fence::text and r.metadata->>'execution_epoch'=c.execution_epoch::text
    and r.metadata->>'lease_version'=c.lease_version::text
    and r.metadata->'resources'=clued_private.work_claim_terminal_resources_v1(c)
    and exists(select 1 from clued_private.work_claim_head_authorizations_v1 a
      where a.authorization_id=(r.metadata->>'head_authorization_id')::uuid and a.user_id=c.user_id
        and a.claim_id=c.claim_id and a.execution_epoch=c.execution_epoch and a.binding_id=c.holder_binding_id
        and a.revoked_at is null) then r.id else null end
  into ready from (select x.* from public.clued_audit_receipts x where x.user_id=c.user_id and x.object_id=c.claim_id::text
    and x.operation='work_claim_terminal_readiness' order by x.created_at desc,x.id desc limit 1) r
  ;
  if ready is null then return null; end if;
  -- Reuse the execution-current holder gate. Revocation, expiry, permission
  -- removal or a closed Task cannot be revived by historical readiness.
  select * into holder from public.clued_agent_bindings where user_id=c.user_id and id=c.holder_binding_id;
  perform clued_private.resolve_binding(clued_private.credential_internal_proof_v1(holder.token_hash),'context:write',c.context_key);
  perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
  return ready;
exception when others then return null;
end
$$;

do $copy_terminal_authorizer$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef('clued_private.work_claim_authorize_head_v1(text,jsonb)'::regprocedure);
  execute replace(definition,'FUNCTION clued_private.work_claim_authorize_head_v1(',
    'FUNCTION clued_private.work_claim_authorize_head_before_terminal_v1(');
end $copy_terminal_authorizer$;
create or replace function clued_private.work_claim_authorize_head_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; c clued_private.work_claims_v1; receipt uuid;
begin
  if p_input ? 'terminal_release_ready' and jsonb_typeof(p_input->'terminal_release_ready') is distinct from 'boolean' then
    raise exception 'work_claim_terminal_readiness_invalid' using errcode='22023'; end if;
  result:=clued_private.work_claim_authorize_head_before_terminal_v1(p_token_hash,p_input-'terminal_release_ready');
  if result->>'status' is distinct from 'committed' then return result; end if;
  -- The predecessor already checked current holder, private key, fence,
  -- version, Task, account and scope. CI cannot manufacture this intent.
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=(p_input->>'claim_id')::uuid;
  if not(p_input ? 'terminal_release_ready') and not exists(select 1 from public.clued_audit_receipts r
    where r.user_id=c.user_id and r.object_id=c.claim_id::text and r.operation='work_claim_terminal_readiness') then return result; end if;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,c.context_key,'work_claim_terminal_readiness','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_TERMINAL_RELEASE_READY','ready',coalesce(p_input->'terminal_release_ready','false'::jsonb),
      'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'execution_epoch',c.execution_epoch,
      'lease_version',c.lease_version,'resources',clued_private.work_claim_terminal_resources_v1(c),
      'head_authorization_id',result->>'authorization_id','repository',lower(p_input->>'repository'),
      'head_sha',lower(p_input->>'head_sha'),'target_branch',p_input->>'target_branch',
      'intent','No unfinished editing in these resources; allow conditional release after all PRs reliably terminate and execution is proved idle'))
  returning id into receipt;
  return result||jsonb_build_object('terminal_readiness_receipt_id',receipt);
end $$;

-- A reissued private key revokes earlier conditional intent even when the
-- claim's public generation is unchanged. No key or key hash enters Receipt.
do $copy_terminal_key$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef('clued_private.work_claim_lease_key_issue_v1(uuid)'::regprocedure);
  execute replace(definition,'FUNCTION clued_private.work_claim_lease_key_issue_v1(',
    'FUNCTION clued_private.work_claim_key_issue_before_terminal_v1(');
end $copy_terminal_key$;
create or replace function clued_private.work_claim_lease_key_issue_v1(p_claim_id uuid)
returns text language plpgsql volatile security definer set search_path='' as $$
declare key text; c clued_private.work_claims_v1;
begin
  key:=clued_private.work_claim_key_issue_before_terminal_v1(p_claim_id);
  select * into c from clued_private.work_claims_v1 where claim_id=p_claim_id;
  if exists(select 1 from public.clued_audit_receipts r where r.user_id=c.user_id
      and r.object_id=c.claim_id::text and r.operation='work_claim_terminal_readiness') then
    insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
    values(c.user_id,c.holder_binding_id,c.context_key,'work_claim_terminal_readiness','work_claim',c.claim_id::text,c.fence,
      jsonb_build_object('receipt_kind','WORK_CLAIM_TERMINAL_RELEASE_READY','ready',false,'reason','key_reissued'));
  end if;
  return key;
end $$;

do $copy_terminal_verifier$
declare definition text;
begin
  definition:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  execute replace(definition,'FUNCTION public.clued_work_verify_v1(',
    'FUNCTION clued_private.work_claim_verify_before_terminal_v1(');
end $copy_terminal_verifier$;
create or replace function public.clued_work_verify_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; b public.clued_agent_bindings; c clued_private.work_claims_v1;
  admitted clued_private.work_claim_execution_admissions_v1; ready_id uuid; receipt uuid; head_id uuid; metadata jsonb; target uuid;
  editing boolean:=p_input->>'action'='verify_edit'; code text; verify_input jsonb:=p_input;
begin
  if p_input ? 'lease_key' and p_input->>'action' is distinct from 'verify_edit' then
    raise exception 'work_claim_private_key_action_invalid' using errcode='22023'; end if;
  if editing then
    perform clued_private.intake_payload_cap_v1(p_input);
    if jsonb_typeof(p_input) is distinct from 'object'
      or p_input-array['action','scope','claim_id','fence','execution_epoch','lease_version','changed_paths','lease_key']<>'{}'::jsonb
      or jsonb_typeof(p_input->'scope') is distinct from 'string' or length(p_input->>'scope') not between 1 and 200
      or jsonb_typeof(p_input->'claim_id') is distinct from 'string'
      or coalesce(p_input->>'claim_id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or jsonb_typeof(p_input->'changed_paths') is distinct from 'array'
      or exists(select 1 from unnest(array['fence','execution_epoch','lease_version']) k
        where jsonb_typeof(p_input->k) is distinct from 'number' or coalesce(p_input->>k,'') !~ '^[1-9][0-9]{0,17}$') then
      raise exception 'work_claim_edit_verification_input_invalid' using errcode='22023'; end if;
    -- A session label or context:read observation is never editing authority.
    -- Use the original holder key checker and current claim CAS, without an
    -- execution target, head admission, renewal or business Receipt write.
    b:=clued_private.resolve_binding(p_token_hash,'context:write',p_input->>'scope');
    perform clued_private.work_claim_lock(b.user_id);
    select * into c from clued_private.work_claims_v1 w where w.user_id=b.user_id
      and w.context_key=p_input->>'scope' and w.claim_id=(p_input->>'claim_id')::uuid for update;
    code:=clued_private.work_claim_execution_key_error_v1(c,b.id,p_input->>'lease_key');
    if code is null and c.fence<>(p_input->>'fence')::bigint then code:='work_claim_fence_mismatch'; end if;
    if code is null and c.execution_epoch<>(p_input->>'execution_epoch')::bigint then code:='work_claim_execution_epoch_mismatch'; end if;
    if code is null and c.lease_version<>(p_input->>'lease_version')::bigint then code:='work_claim_version_conflict'; end if;
    if code is not null then return jsonb_build_object('status','ok','verdict','REJECTED',
      'holder_edit_authorized',false,'execution_authorized',false,'reasons',jsonb_build_array(code)); end if;
    perform clued_private.work_claim_task(c.user_id,c.context_key,c.task_id::text);
    verify_input:=jsonb_build_object('scope',c.context_key,'claim_id',c.claim_id,'changed_paths',p_input->'changed_paths');
  end if;
  result:=clued_private.work_claim_verify_before_terminal_v1(p_token_hash,verify_input);
  target:=case when result#>>'{claim,claim_id}' ~ '^[0-9a-f-]{36}$' then (result#>>'{claim,claim_id}')::uuid else null end;
  if target is null then return result; end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(result#>>'{claim,context_key}',p_input->>'scope','global'));
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=target;
  ready_id:=clued_private.work_claim_terminal_ready_receipt_v1(c);
  result:=jsonb_set(result,'{claim}',result->'claim'||jsonb_build_object('terminal_release_ready',ready_id is not null));
  result:=result||jsonb_build_object('terminal_release_ready',ready_id is not null);
  if editing then return result||jsonb_build_object('holder_edit_authorized',result->>'verdict'='ADMITTED'); end if;
  if result->>'verdict' is distinct from 'ADMITTED' or result->'execution_authorized' is distinct from 'true'::jsonb
    or p_input ? 'action' or p_input->>'pr_ref' is null or not clued_private.merge_slot_admits_v1(b)
    or coalesce(p_input->>'head_sha','') !~ '^[0-9a-f]{40}$' or coalesce(p_input->>'base_sha','') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(p_input->'changed_paths') is distinct from 'array' then return result; end if;
  select * into admitted from clued_private.work_claim_execution_admissions_v1 e where e.user_id=b.user_id
    and e.claim_id=c.claim_id and e.execution_epoch=c.execution_epoch and e.ci_binding_id=b.id
    and e.pr_ref=p_input->>'pr_ref' and e.head_sha=p_input->>'head_sha' and e.repository=lower(split_part(p_input->>'pr_ref','#',1))
    and e.target_branch=p_input->>'target_branch' and e.workflow is null
    order by e.created_at desc,e.admission_id desc limit 1;
  if admitted.admission_id is null then return result; end if;
  head_id:=coalesce(nullif(result->>'head_authorization_id',''),result#>>'{claim_binding,head_authorization_id}')::uuid;
  metadata:=jsonb_build_object('receipt_kind','WORK_CLAIM_TERMINAL_ADMISSION','admission_id',admitted.admission_id,
    'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'execution_epoch',c.execution_epoch,
    'lease_version',c.lease_version,'resources',clued_private.work_claim_terminal_resources_v1(c),
    'resources_digest',admitted.resources_digest,'changed_paths',to_jsonb(clued_private.work_claim_normalize_paths(p_input->'changed_paths')),
    'repository',admitted.repository,'pr_ref',admitted.pr_ref,'head_sha',admitted.head_sha,'base_sha',p_input->>'base_sha',
    'target_branch',admitted.target_branch,'head_authorization_id',head_id,'readiness_receipt_id',ready_id);
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,c.context_key,'work_claim_terminal_admission','work_claim',c.claim_id::text,c.fence,metadata) returning id into receipt;
  return result||jsonb_build_object('terminal_admission_receipt_id',receipt,'terminal_admission',jsonb_build_object(
    'receipt_id',receipt,'claim_id',c.claim_id,'fence',c.fence,'execution_epoch',c.execution_epoch,
    'lease_version',c.lease_version,'head_authorization_id',head_id));
end $$;

-- Existing release semantics, extracted without changing its public holder/
-- key gate. The qualified terminal door may call this only after all guards.
create function clued_private.work_claim_terminal_release_core_v1(b public.clued_agent_bindings,c clued_private.work_claims_v1,
  p_admission_receipt uuid,p_merged boolean,p_result jsonb,p_proof jsonb)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid;
begin
  update clued_private.work_claims_v1 set status='RELEASED',released_outcome=case when p_merged then 'completed' else 'abandoned' end,
    lease_key_hash=null,updated_at=clock_timestamp() where user_id=c.user_id and claim_id=c.claim_id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(c.user_id,b.id,c.context_key,'work_claim_release','work_claim',c.claim_id::text,c.fence,
    jsonb_build_object('receipt_kind','WORK_CLAIM_RELEASED','claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,
      'execution_epoch',c.execution_epoch,'status','RELEASED','outcome',case when p_merged then 'completed' else 'abandoned' end,
      'terminal_admission_receipt_id',p_admission_receipt,'via_trusted_pr_terminal',true,'terminal_result',p_result,
      'terminal_observation',p_proof->'observation',
      'runtime_inventory_sha256',clued_private.m1_sha256(p_proof->'runtime_inventory'),
      'runtime_inventory_source',p_proof#>>'{runtime_inventory,source}',
      'runtime_inventory_observed_at',p_proof#>>'{runtime_inventory,observed_at}',
      'runtime_stop_receipt_ids',coalesce(p_proof#>'{runtime_inventory,stop_receipt_ids}','[]'::jsonb))) returning id into receipt;
  return receipt;
end $$;

create function clued_private.work_claim_terminal_outcome_v1(b public.clued_agent_bindings,p_scope text,p_task uuid,p_claim uuid,
  p_reason text,p_status text default 'retained')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare receipt uuid;
begin
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(b.user_id,b.id,p_scope,'work_claim_pr_terminal_retained','task',coalesce(p_task::text,'unconfirmed'),1,
    jsonb_build_object('receipt_kind','WORK_CLAIM_PR_TERMINAL_RETAINED','claim_id',p_claim,'task_id',p_task,'reason',p_reason))
    returning id into receipt;
  return jsonb_build_object('status',p_status,'released',false,'reason',p_reason,'receipt_id',receipt,'retryable',p_status='pending');
end $$;

-- A qualified CI caller must supply actual complete observations. Absence of
-- Native rows is never substituted for complete external runtime coverage.
-- Current Source cannot obtain all-events inventories and omits this input.
create function clued_private.work_claim_terminal_runtime_error_v1(c clued_private.work_claims_v1,p_meta jsonb,p_inventory jsonb)
returns text language plpgsql stable security definer set search_path='' as $$
declare entry jsonb; snapshot jsonb; run jsonb; observed timestamptz; targets integer; has_runs boolean:=false;
begin
  if jsonb_typeof(p_inventory) is distinct from 'object'
    or p_inventory-array['source','observed_at','entries','stop_receipt_ids']<>'{}'::jsonb
    or p_inventory->>'source' is distinct from 'github-actions-runs/all-events'
    or jsonb_typeof(p_inventory->'entries') is distinct from 'array'
    or (p_inventory ? 'stop_receipt_ids' and (jsonb_typeof(p_inventory->'stop_receipt_ids') is distinct from 'array'
      or exists(select 1 from jsonb_array_elements(p_inventory->'stop_receipt_ids') v where jsonb_typeof(v) is distinct from 'string'
        or v#>>'{}' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')))
    or jsonb_array_length(p_inventory->'entries')>5000 then return 'runtime_inventory_unconfirmed'; end if;
  begin observed:=(p_inventory->>'observed_at')::timestamptz;
  exception when others then return 'runtime_inventory_unconfirmed'; end;
  if observed is null or not isfinite(observed) or observed>clock_timestamp()+interval '5 seconds'
    or observed<clock_timestamp()-interval '60 seconds' then return 'runtime_inventory_unconfirmed'; end if;
  select count(*) into targets from (
    select a.repository,a.head_sha from clued_private.work_claim_head_authorizations_v1 a where a.user_id=c.user_id and a.claim_id=c.claim_id
    union select a.repository,a.head_sha from clued_private.work_claim_execution_admissions_v1 a where a.user_id=c.user_id and a.claim_id=c.claim_id) all_heads;
  if targets<>jsonb_array_length(p_inventory->'entries') or targets<>(select count(distinct (value->>'repository',value->>'head_sha'))
      from jsonb_array_elements(p_inventory->'entries')) then return 'runtime_inventory_unconfirmed'; end if;
  for entry in select value from jsonb_array_elements(p_inventory->'entries') loop
    if jsonb_typeof(entry) is distinct from 'object' or entry-array['repository','head_sha','first','second']<>'{}'::jsonb
      or not exists(select 1 from (
        select a.repository,a.head_sha from clued_private.work_claim_head_authorizations_v1 a where a.user_id=c.user_id and a.claim_id=c.claim_id
        union select a.repository,a.head_sha from clued_private.work_claim_execution_admissions_v1 a where a.user_id=c.user_id and a.claim_id=c.claim_id) h
        where h.repository=entry->>'repository' and h.head_sha=entry->>'head_sha')
      or entry->'first' is distinct from entry->'second' then return 'runtime_inventory_unconfirmed'; end if;
    snapshot:=entry->'first';
    if jsonb_typeof(snapshot) is distinct from 'object' or snapshot-array['total_count','workflow_runs']<>'{}'::jsonb
      or jsonb_typeof(snapshot->'total_count') is distinct from 'number' or coalesce(snapshot->>'total_count','') !~ '^[0-9]{1,5}$'
      or jsonb_typeof(snapshot->'workflow_runs') is distinct from 'array'
      or (snapshot->>'total_count')::integer<>jsonb_array_length(snapshot->'workflow_runs')
      or jsonb_array_length(snapshot->'workflow_runs')>2000
      or (select count(distinct value->>'id') from jsonb_array_elements(snapshot->'workflow_runs'))<>jsonb_array_length(snapshot->'workflow_runs')
      then return 'runtime_inventory_unconfirmed'; end if;
    for run in select value from jsonb_array_elements(snapshot->'workflow_runs') loop
      has_runs:=true;
      if jsonb_typeof(run) is distinct from 'object' or run-array['id','run_attempt','head_sha','event','status','conclusion']<>'{}'::jsonb
        or jsonb_typeof(run->'id') is distinct from 'number' or coalesce(run->>'id','') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(run->'run_attempt') is distinct from 'number' or coalesce(run->>'run_attempt','') !~ '^[1-9][0-9]{0,5}$'
        or run->>'head_sha' is distinct from entry->>'head_sha'
        or jsonb_typeof(run->'event') is distinct from 'string' or length(run->>'event') not between 1 and 100
        or run->>'status' is distinct from 'completed' or jsonb_typeof(run->'conclusion') is distinct from 'string'
        then return 'runtime_inventory_unconfirmed'; end if;
    end loop;
  end loop;
  -- Existing legacy drain Receipts bind heads, not individual run IDs and
  -- attempts. An old same-head stop fact cannot prove a later attempt stopped.
  -- Until a supported per-attempt physical proof exists, all nonempty
  -- inventories remain unsupported, including completed/success snapshots.
  if has_runs then return 'physical_execution_unconfirmed'; end if;
  return null;
end $$;

do $copy_terminal_doors$
declare name text; definition text;
begin
  foreach name in array array['clued_work_claim_adopt_v1','clued_work_merge_slot_return_v1'] loop
    definition:=pg_catalog.pg_get_functiondef(('public.'||name||'(text,jsonb)')::regprocedure);
    execute replace(definition,'FUNCTION public.'||name||'(','FUNCTION clued_private.'||name||'_before_terminal(');
  end loop;
end $copy_terminal_doors$;

create function clued_private.work_claim_pr_terminal_apply_v1(p_token_hash text,p_input jsonb,p_merged boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1; after_claim clued_private.work_claims_v1;
  relation clued_private.work_claim_pr_task_bindings_v1; witness public.clued_audit_receipts; replay public.clued_audit_receipts;
  proof jsonb:=p_input->'terminal_proof'; expected jsonb; observation jsonb; meta jsonb; result jsonb; reason text; outcome jsonb;
  scope text:=coalesce(p_input->>'scope','global'); pr text:=lower(p_input->>'pr_ref'); receipt uuid; ready_id uuid;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  if not clued_private.merge_slot_admits_v1(b) then
    if p_merged then return clued_private.clued_work_claim_adopt_v1_before_terminal(p_token_hash,p_input-'terminal_proof');
    else return clued_private.clued_work_merge_slot_return_v1_before_terminal(p_token_hash,p_input-'terminal_proof'); end if;
  end if;
  perform clued_private.work_claim_lock(b.user_id);
  select t.* into relation from clued_private.work_claim_pr_task_bindings_v1 t
    join public.clued_memories m on m.user_id=t.user_id and m.id=t.task_id
    where t.user_id=b.user_id
    and coalesce(nullif(m.canonical_scope,''),case when m.project_id is null then 'global' else 'project:'||m.project_id::text end)=coalesce(p_input->>'scope','global')
    and t.repo_id=split_part(pr,'#',1) and t.pr_number=case when split_part(pr,'#',2) ~ '^[1-9][0-9]{0,9}$' then split_part(pr,'#',2)::bigint end;
  if proof is null then reason:='terminal_proof_missing';
  elsif jsonb_typeof(proof) is distinct from 'object' or proof-array['last_admission','observation','runtime_inventory']<>'{}'::jsonb then reason:='admission_unconfirmed';
  else
    expected:=proof->'last_admission'; observation:=proof->'observation';
    if jsonb_typeof(expected) is distinct from 'object' or expected-array['receipt_id','claim_id','fence','execution_epoch','lease_version','head_authorization_id']<>'{}'::jsonb
      or coalesce(expected->>'receipt_id','') !~ '^[0-9a-f-]{36}$' then reason:='admission_unconfirmed';
    else
      select * into witness from public.clued_audit_receipts r where r.user_id=b.user_id and r.context_key=scope
        and r.id=(expected->>'receipt_id')::uuid and r.operation='work_claim_terminal_admission'
        and r.metadata->>'receipt_kind'='WORK_CLAIM_TERMINAL_ADMISSION';
      meta:=witness.metadata;
      if witness.id is null or relation.task_id is distinct from (meta->>'task_id')::uuid
        or exists(select 1 from unnest(array['claim_id','fence','execution_epoch','lease_version','head_authorization_id']) key
          where expected->key is distinct from meta->key) then reason:='admission_unconfirmed';
      elsif jsonb_typeof(observation) is distinct from 'object' or observation-array['repository','pr_ref','head_sha','base_sha','target_branch','state','merged','merge_sha']<>'{}'::jsonb
        or observation->>'state' is distinct from 'closed' or observation->'merged' is distinct from to_jsonb(p_merged)
        or observation->>'pr_ref' is distinct from pr or meta->>'pr_ref' is distinct from pr
        or exists(select 1 from unnest(array['repository','head_sha','target_branch']) key where observation->key is distinct from meta->key)
        or jsonb_typeof(observation->'base_sha') is distinct from 'string' or coalesce(observation->>'base_sha','') !~ '^[0-9a-f]{40}$'
        or (p_merged and (observation->>'merge_sha' is distinct from p_input->>'merge_sha' or coalesce(observation->>'merge_sha','') !~ '^[0-9a-f]{40}$')) then reason:='terminal_observation_unconfirmed';
      else
        select * into replay from public.clued_audit_receipts r where r.user_id=b.user_id and r.object_id=meta->>'claim_id'
          and r.operation='work_claim_release' and r.metadata->>'terminal_admission_receipt_id'=witness.id::text limit 1;
        if replay.id is not null then return replay.metadata->'terminal_result'||jsonb_build_object('terminal_replayed',true,'auto_release',jsonb_build_object(
          'status','released','released',true,'reason','released','receipt_id',replay.id,'retryable',false)); end if;
        select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=(meta->>'claim_id')::uuid for update;
        if c.status is distinct from 'ACTIVE' or c.expires_at<=clock_timestamp() or c.outcome='not_adopted'
          or c.fence::text is distinct from meta->>'fence' or c.execution_epoch::text is distinct from meta->>'execution_epoch'
          or c.lease_version::text is distinct from meta->>'lease_version'
          or clued_private.work_claim_terminal_resources_v1(c) is distinct from meta->'resources'
          or (c.copy_index is null and exists(select 1 from clued_private.work_claims_v1 n where n.user_id=c.user_id and n.task_id=c.task_id and n.fence>c.fence))
          then reason:='claim_cas_changed'; end if;
      end if;
    end if;
  end if;
  -- Reject stale/forged terminal proof before it could close a reopened PR or
  -- change a successor's queue. Legacy no-proof calls keep original adoption.
  if reason is not null and reason<>'terminal_proof_missing' then
    result:=jsonb_build_object('status','ok','pr_ref',pr,'merge_slot_returned','[]'::jsonb)
      ||case when p_merged then jsonb_build_object('adopted',false) else jsonb_build_object('returned',false) end;
    return result||jsonb_build_object('auto_release',clued_private.work_claim_terminal_outcome_v1(b,scope,relation.task_id,c.claim_id,reason));
  end if;
  if p_merged then result:=clued_private.clued_work_claim_adopt_v1_before_terminal(p_token_hash,p_input-'terminal_proof');
  else result:=clued_private.clued_work_merge_slot_return_v1_before_terminal(p_token_hash,p_input-'terminal_proof'); end if;
  if result->>'status' is distinct from 'ok' then return result; end if;
  if reason is null then
    select * into after_claim from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=c.claim_id;
    ready_id:=clued_private.work_claim_terminal_ready_receipt_v1(c);
    if after_claim.execution_handover_pending then reason:='handover_pending';
    elsif after_claim.fence<>c.fence or after_claim.execution_epoch<>c.execution_epoch or after_claim.lease_version<>c.lease_version
      or after_claim.status<>'ACTIVE' then reason:='claim_cas_changed';
    elsif exists(select 1 from clued_private.work_claim_pr_task_bindings_v1 t where t.user_id=c.user_id and t.task_id=c.task_id
      and t.status in ('active','unknown')) then reason:='other_pr_not_terminal';
    elsif exists(select 1 from clued_private.work_claim_publications_v1 p where p.user_id=c.user_id and p.claim_id=c.claim_id and p.state='open') then reason:='publication_pending';
    elsif exists(select 1 from clued_private.work_claim_revocation_outbox_v1 o where o.user_id=c.user_id and o.claim_id=c.claim_id and o.state<>'acknowledged') then reason:='execution_pending';
    elsif exists(select 1 from clued_private.work_claim_execution_admissions_v1 e where e.user_id=c.user_id and e.claim_id=c.claim_id and e.workflow is not null) then reason:='dispatch_state_unconfirmed';
    elsif exists(select 1 from clued_private.ci_jobs_v1 j where j.user_id=c.user_id and j.claim_id=c.claim_id and
      (j.state not in ('completed','failed','canceled','invalidated') or exists(select 1 from clued_private.ci_job_leases_v1 l
        where l.user_id=j.user_id and l.job_id=j.job_id and (l.terminal_at is null or not l.classification_verified
          or l.terminal_receipt_id is null or l.terminal_class='unknown')))) then reason:='execution_pending';
    elsif exists(select 1 from clued_private.ci_scan_start_keys_v1 s where s.user_id=c.user_id and s.claim_id=c.claim_id) then reason:='physical_execution_unconfirmed';
    elsif exists(select 1 from clued_private.work_claim_head_authorizations_v1 a where a.user_id=c.user_id and a.claim_id=c.claim_id
      and a.revoked_at is null and (a.pr_ref is null or a.workflow is not null)) then reason:='unmapped_authorization';
    elsif ready_id is null or ready_id::text is distinct from meta->>'readiness_receipt_id'
      or exists(select 1 from unnest(c.write_set) path where path ~ '[*?\[\]:]' or not(meta->'changed_paths' ? path))
      then reason:='editing_occupancy_unconfirmed';
    elsif c.copy_index is not null and not exists(select 1 from clued_private.work_claim_task_modes_v1 m
      where m.user_id=c.user_id and m.task_id=c.task_id and m.adopted_claim_id=c.claim_id) then reason:='race_winner_unconfirmed';
    end if;
    if reason is null then reason:=clued_private.work_claim_terminal_runtime_error_v1(c,meta,proof->'runtime_inventory'); end if;
  end if;
  if reason is not null then
    outcome:=clued_private.work_claim_terminal_outcome_v1(b,scope,relation.task_id,c.claim_id,reason,
      case when reason in ('other_pr_not_terminal','publication_pending','execution_pending','dispatch_state_unconfirmed','physical_execution_unconfirmed','handover_pending','runtime_inventory_unconfirmed') then 'pending' else 'retained' end);
    return result||jsonb_build_object('auto_release',outcome);
  end if;
  receipt:=clued_private.work_claim_terminal_release_core_v1(b,after_claim,witness.id,p_merged,result,proof);
  return result||jsonb_build_object('auto_release',jsonb_build_object('status','released','released',true,'reason','released','receipt_id',receipt,'retryable',false));
end $$;
create or replace function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb)
returns jsonb language sql volatile security definer set search_path='' as $$ select clued_private.work_claim_pr_terminal_apply_v1(p_token_hash,p_input,true) $$;
create or replace function public.clued_work_merge_slot_return_v1(p_token_hash text,p_input jsonb)
returns jsonb language sql volatile security definer set search_path='' as $$ select clued_private.work_claim_pr_terminal_apply_v1(p_token_hash,p_input,false) $$;

revoke all on function
 clued_private.work_claim_terminal_resources_v1(clued_private.work_claims_v1),
 clued_private.work_claim_terminal_ready_receipt_v1(clued_private.work_claims_v1),
 clued_private.work_claim_authorize_head_before_terminal_v1(text,jsonb),
 clued_private.work_claim_key_issue_before_terminal_v1(uuid),
 clued_private.work_claim_verify_before_terminal_v1(text,jsonb),
 clued_private.work_claim_terminal_release_core_v1(public.clued_agent_bindings,clued_private.work_claims_v1,uuid,boolean,jsonb,jsonb),
 clued_private.work_claim_terminal_outcome_v1(public.clued_agent_bindings,text,uuid,uuid,text,text),
 clued_private.work_claim_terminal_runtime_error_v1(clued_private.work_claims_v1,jsonb,jsonb),
 clued_private.clued_work_claim_adopt_v1_before_terminal(text,jsonb),
 clued_private.clued_work_merge_slot_return_v1_before_terminal(text,jsonb),
 clued_private.work_claim_pr_terminal_apply_v1(text,jsonb,boolean)
from public,anon,authenticated,service_role,clued_worker_gateway;
