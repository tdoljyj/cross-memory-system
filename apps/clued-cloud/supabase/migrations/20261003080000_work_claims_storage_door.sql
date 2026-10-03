-- Generic Work Claim, rollout step 2: the Clued storage write tools are the
-- first default door (development/contracts/execution-admission/
-- GenericWorkClaim.v0.1.md §3.1, §4.1-§4.2; Task b244a345, Decision 6214c17f).
--
-- clued_storage_submit (through storage_jobs_policy_core_v2) and
-- clued_storage_trash_batch now ask one gate, work_claim_gate_v1, before they
-- create anything. The door runs collision_only (Decision 2a7391ff item 1):
--   * no claim presented: admitted unless another live claim (ACTIVE or
--     DRAINING, not expired) overlaps the write's storage resources, which is
--     refused with work_claim_conflict naming the holders;
--   * a claim presented as work_claim {claim_id, fence}: it must be this
--     Binding's, ACTIVE, unexpired, at that fence and cover every resource,
--     and no other live claim may overlap.
-- "Another" is per claim, not per Binding: every session of one Binding is a
-- separate holder (Decision 533a5286).
--
-- Resources are storage:<connection_id>/<path under the registered root>:
-- create and replace name the destination; rename and file move the source
-- and the destination; trash and untrash the item (an untrash into another
-- name also that name); a directory item adds "/**" (directory move, trash,
-- untrash). adopt changes no Drive item and is not gated. Paths are taken
-- after canonicalization, so a relative and a full path give the same
-- resource. A claim's write_set cannot hold whitespace, but a glob such as
-- storage:<connection>/20_P/** covers names with spaces.
--
-- The gate runs after the policy evaluator and the replay checks, so only an
-- authorized Binding learns about claims and a replay of an existing job is
-- never refused; and before registry hints, trash batch use, staging, the
-- submit Receipt and the job, so a refused write leaves nothing behind but a
-- WORK_CLAIM_REJECTED Receipt (rate limited as in 20261003070000). The refusal
-- is returned as {status:"rejected", error_code, ...}, not raised.
--
-- The gate reads committed claims and takes no claim lock: a claim committing
-- at the same moment as a write may not see it (collision_only is a
-- coordination aid, not an authority). Legacy-mode connections
-- (clued_storage_jobs_v1) are not gated; none exist in production.
--
-- The two storage functions are their effective definitions (base files plus
-- every anchored patch through 20261002200000) with only the gate lines and
-- the work_claim envelope key added.

-- work_claim {claim_id, fence}: exactly these two keys.
create function clued_private.work_claim_ref_valid_v1(p_ref jsonb) returns boolean
language sql immutable set search_path='' as $$
  select jsonb_typeof(p_ref)='object' and p_ref-array['claim_id','fence']='{}'::jsonb
    and coalesce(p_ref->>'claim_id','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(p_ref->'fence')='number' and coalesce(p_ref->>'fence','') ~ '^[1-9][0-9]{0,17}$'
$$;

-- A resource is covered by a write set when some entry of the same kind
-- covers its value with the v1 path rules.
create function clued_private.work_claim_resource_covered_v1(p_resource text,p_set text[]) returns boolean
language sql immutable set search_path='' as $$
  select exists(select 1 from unnest(p_set) e,
      lateral (select clued_private.work_claim_resource_split(e) es,
        clued_private.work_claim_resource_split(p_resource) rs) s
    where s.es[1] is not distinct from s.rs[1]
      and clued_private.work_claim_path_covered(s.rs[2],array[s.es[2]]))
$$;

-- The storage resources one canonicalized mutation writes (header).
create function clued_private.work_claim_storage_resources_v1(p_connection uuid,p_profile uuid,m jsonb)
returns text[] language plpgsql stable security definer set search_path='' as $$
declare root text; op text:=m->>'operation'; dir text:=case when m->>'target_kind'='directory' then '/**' else '' end;
  v_paths text[]:='{}'::text[]; v_path text; v_out text[]:='{}'::text[];
begin
  select p.managed_root into root from clued_private.resource_center_profiles_v1 p where p.id=p_profile;
  if root is null then raise exception 'storage_path_invalid' using errcode='22023'; end if;
  if op in ('create','replace') then v_paths:=array[m->>'destination_path'];
  elsif op in ('rename','move') then v_paths:=array[(m->>'source_path')||dir,(m->>'destination_path')||dir];
  elsif op in ('delete','restore') then
    v_paths:=array[(m->>'source_path')||dir]||case when m ? 'destination_path' then array[(m->>'destination_path')||dir] else '{}'::text[] end;
  else return v_out; end if;
  foreach v_path in array v_paths loop
    if v_path is null or left(v_path,char_length(root)+1)<>root||'/' then
      raise exception 'storage_path_invalid' using errcode='22023'; end if;
    v_out:=v_out||('storage:'||p_connection::text||'/'||substr(v_path,char_length(root)+2));
  end loop;
  return v_out;
end $$;

-- The one Work Claim gate (GenericWorkClaim §3.1) for a write through a Clued
-- door. Returns null when the write is admitted, else the refusal (with its
-- rate-limited WORK_CLAIM_REJECTED Receipt). mode collision_only or
-- require_claim; p_claim is the presented {claim_id, fence} or null.
create function clued_private.work_claim_gate_v1(p_user uuid,p_binding uuid,p_door text,p_operation text,
  p_mode text,p_resources text[],p_claim jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; b public.clued_agent_bindings%rowtype;
  v_code text; v_detail jsonb:='{}'::jsonb; v_conflicts jsonb:='[]'::jsonb; v_uncovered text[];
  v_first clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if p_mode not in ('collision_only','require_claim') or p_door is null or p_operation is null then
    raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  if p_claim is not null and not clued_private.work_claim_ref_valid_v1(p_claim) then
    raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  if coalesce(cardinality(p_resources),0)=0 then return null; end if;
  if p_claim is not null then
    select * into c from clued_private.work_claims_v1 w
      where w.user_id=p_user and w.claim_id=(p_claim->>'claim_id')::uuid;
    if not found then v_code:='work_claim_not_found';
    elsif c.holder_binding_id<>p_binding then v_code:='work_claim_not_holder';
    elsif c.fence<>(p_claim->>'fence')::bigint then
      v_code:='work_claim_fence_mismatch'; v_detail:=jsonb_build_object('expected_fence',c.fence);
    elsif c.status<>'ACTIVE' or c.expires_at<=v_now then
      v_code:='work_claim_not_active'; v_detail:=jsonb_build_object('claim_status',
        case when c.status='ACTIVE' then 'EXPIRED' else c.status end);
    else
      select coalesce(array_agg(r order by r),'{}'::text[]) into v_uncovered from unnest(p_resources) r
        where not clued_private.work_claim_resource_covered_v1(r,c.write_set);
      if cardinality(v_uncovered)>0 then
        v_code:='work_claim_not_covered'; v_detail:=jsonb_build_object('uncovered',to_jsonb(v_uncovered));
      end if;
    end if;
  elsif p_mode='require_claim' then v_code:='work_claim_required';
  end if;
  if v_code is null then
    -- Every live claim but the presented one; no Task is shared with a write.
    v_conflicts:=clued_private.work_claim_conflicts(p_user,null,p_resources,'{}'::text[],c.claim_id);
    if jsonb_array_length(v_conflicts)>0 then
      v_code:='work_claim_conflict'; v_detail:=jsonb_build_object('conflicts',v_conflicts);
    end if;
  end if;
  if v_code is null then return null; end if;
  -- The Receipt is keyed by the presented claim's Task, else the first
  -- conflicting claim's, else the presented claim id.
  if c.claim_id is null and jsonb_array_length(v_conflicts)>0 then
    select * into v_first from clued_private.work_claims_v1 w
      where w.user_id=p_user and w.claim_id=(v_conflicts->0->>'claim_id')::uuid;
  end if;
  select * into b from public.clued_agent_bindings x where x.id=p_binding and x.user_id=p_user;
  if b.id is null then raise exception 'work_claim_gate_invalid' using errcode='22023'; end if;
  return clued_private.work_claim_reject_log_v1(b,coalesce(c.context_key,v_first.context_key,'global'),
    coalesce(c.task_id,v_first.task_id),coalesce(c.claim_id,v_first.claim_id,(p_claim->>'claim_id')::uuid),
    p_door||':'||p_operation,v_code,
    v_detail||jsonb_build_object('door',p_door,'resources',to_jsonb(p_resources)));
end $$;

revoke all on function
  clued_private.work_claim_ref_valid_v1(jsonb),
  clued_private.work_claim_resource_covered_v1(text,text[]),
  clued_private.work_claim_storage_resources_v1(uuid,uuid,jsonb),
  clued_private.work_claim_gate_v1(uuid,uuid,text,text,text,text[],jsonb)
  from public,anon,authenticated,service_role;

-- The storage kind is now checked by this door as well as at claim time.
update clued_private.work_claim_resource_kinds
  set doors=array['claim-conflict','clued-storage'],
    note='storage:<connection_id>/<path under the registered root>; checked by clued_storage_submit and clued_storage_trash_batch (collision_only)'
  where kind='storage';

-- clued_storage_submit core: the effective definition plus the gate.
create or replace function clued_private.storage_jobs_policy_core_v2(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $function$
declare op text:=p_input->>'action'; m jsonb:=p_input->'mutation';
  v_job_id uuid; connection_id uuid; wanted text:='inspect'; digest text;
  snapshot jsonb; consent_receipt uuid; existing clued_private.storage_jobs_v1; historical jsonb;
  receipt public.clued_audit_receipts; refs jsonb; ev text; profile_project uuid; gate jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'action') is distinct from 'string'
    or op not in ('submit','inspect')
    or p_input-array['action','connection_id','job_id','mutation','work_claim']<>'{}'::jsonb
    or (p_input ? 'work_claim' and (op<>'submit' or not clued_private.work_claim_ref_valid_v1(p_input->'work_claim')))
    or jsonb_typeof(p_input->'connection_id') is distinct from 'string'
    or jsonb_typeof(p_input->'job_id') is distinct from 'string'
    or (op='inspect' and (p_input ? 'mutation' or not(p_input ?& array['action','connection_id','job_id'])))
    or (op='submit' and not(p_input ?& array['action','connection_id','job_id','mutation'])) then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  connection_id:=(p_input->>'connection_id')::uuid;
  v_job_id:=(p_input->>'job_id')::uuid;
  if op='submit' then
    if jsonb_typeof(m) is distinct from 'object'
      or m-array['operation','destination_path','target_kind','directory_semantics','content','source_path','source_file_version',
        'destination_file_version','restore_job_id','staging_id','mime_type','content_sha256','source_file_id','restore_mode']<>'{}'::jsonb
      or coalesce(m->>'operation','') not in ('create','rename','move','replace','delete','restore','adopt')
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or ((m->>'operation' not in ('delete','restore','adopt') or m ? 'destination_path')
        and (jsonb_typeof(m->'destination_path') is distinct from 'string'
          or length(m->>'destination_path') not between 1 and 1000)) then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    m:=clued_private.storage_mutation_paths_v1(p_token_hash,connection_id,m);
    if m->>'operation'='move' and m->>'target_kind'='directory' then
      wanted:='modify_subtree';
      if not clued_private.storage_subtree_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m->>'operation' in ('delete','restore') then
      wanted:='destructive';
      if not clued_private.storage_destructive_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m->>'operation'='adopt' then
      wanted:='modify';
      if not clued_private.storage_adopt_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m ?| array['source_file_id','restore_mode'] then
      raise exception 'storage_job_input_invalid' using errcode='22023';
    elsif m->>'operation' in ('rename','move') then
      wanted:='modify';
      if not clued_private.storage_modify_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m->>'operation'='replace' then
      wanted:='overwrite';
      if not clued_private.storage_replace_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m ?| array['source_path','source_file_version','destination_file_version','restore_job_id'] then
      raise exception 'storage_job_input_invalid' using errcode='22023';
    elsif m->>'target_kind'='file' and m ? 'staging_id' then
      wanted:='create_file';
      m:=clued_private.storage_binary_submit_mutation_v1(connection_id,m);
    elsif m->>'target_kind'='file' then
      wanted:='create_file';
      if jsonb_typeof(m->'content') is distinct from 'string' or m ? 'directory_semantics'
        or m ?| array['staging_id','mime_type','content_sha256']
        or not(m ?& array['operation','target_kind','destination_path','content'])
        or octet_length(m->>'content')>1048576 then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    else
      wanted:='create_topic';
      if m ? 'content' or coalesce(m->>'directory_semantics','') not in ('topic','asset_collection')
        or m ?| array['staging_id','mime_type','content_sha256']
        or not(m ?& array['operation','target_kind','destination_path','directory_semantics']) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    end if;
  end if;
  if op='submit' then digest:=clued_private.m1_sha256(jsonb_build_object('connection_id',connection_id,'mutation',m)); end if;
  historical:=clued_private.storage_job_history_v2(p_token_hash,connection_id,v_job_id,digest);
  if historical is not null then
    return historical||case when op='submit' then jsonb_build_object('replayed',true) else '{}'::jsonb end;
  end if;
  if op='inspect' then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
  snapshot:=clued_private.storage_policy_evaluate_v2(p_token_hash,connection_id,wanted,v_job_id);
  select consent_receipt_id into consent_receipt from clued_private.storage_account_policies_v2
    where id=(snapshot->>'policy_id')::uuid and owner_id=(snapshot->>'owner_id')::uuid for share;
  if consent_receipt is null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  snapshot:=snapshot||jsonb_build_object('consent_receipt_id',consent_receipt);
  select * into existing from clued_private.storage_jobs_v1
    where owner_id=(snapshot->>'owner_id')::uuid and job_id=v_job_id for update;
  if existing.job_id is not null then
    -- Another submit may have committed while this one awaited the original
    -- job guard. It is historical identity, not a current-snapshot equality.
    historical:=clued_private.storage_job_history_v2(p_token_hash,connection_id,v_job_id,digest);
    if historical is null then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
    return historical||jsonb_build_object('replayed',true);
  end if;
  -- Work Claim door (GenericWorkClaim §4.1-§4.2), collision_only: after the
  -- evaluator and the replay checks, before any registry hint, trash batch
  -- use, staging, receipt or job. A refusal returns here; nothing else is
  -- written but its rejection Receipt.
  gate:=clued_private.work_claim_gate_v1((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,
    'clued-storage','storage_submit','collision_only',
    clued_private.work_claim_storage_resources_v1(connection_id,(snapshot->>'profile_id')::uuid,m),p_input->'work_claim');
  if gate is not null then return gate; end if;
  -- Registry hints only after the evaluator authenticated this Binding and
  -- the destructive level (never a pre-authorization registry oracle).
  if m->>'operation' in ('delete','restore') then perform clued_private.storage_destructive_target_v1(connection_id,m); end if;
  if wanted='modify_subtree' then perform clued_private.storage_subtree_target_v1(connection_id,m); end if;
  if m->>'operation'='adopt' then perform clued_private.storage_adopt_target_v1(connection_id,m); end if;
  perform clued_private.storage_trash_admit_v1(m,snapshot,connection_id,v_job_id);
  perform clued_private.storage_staging_consume_v1(m,(snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,connection_id,v_job_id);
  receipt:=clued_private.m1_begin_receipt((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,
    'storage_job_submit',jsonb_build_object('idempotency_key','storage-job:'||v_job_id::text,
      'job_id',v_job_id,'request_digest',digest),digest);
  if receipt.status<>'pending' then raise exception 'storage_job_receipt_conflict' using errcode='40001'; end if;
  insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,
    authorization_version,request_digest,mutation,receipt_id,authority_snapshot_v2)
    values((snapshot->>'owner_id')::uuid,v_job_id,connection_id,(snapshot->>'binding_id')::uuid,
      (snapshot->>'policy_receipt_id')::uuid,(snapshot->>'authorization_version')::bigint,digest,m,receipt.id,snapshot)
    returning * into existing;
  select project_id into profile_project from clued_private.resource_center_profiles_v1
    where id=(snapshot->>'profile_id')::uuid;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',v_job_id));
  ev:=clued_private.m1_append_event_row((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,
    receipt.id,receipt.canonical_version,'extension:storage:job_submitted',refs,
    'project:'||profile_project::text,null,
    jsonb_build_object('job_id',v_job_id,'connection_id',connection_id,'request_digest',digest,
      'policy_id',snapshot->'policy_id','policy_generation',snapshot->'policy_generation',
      'capability_id',snapshot->'capability_id','scope_digest',snapshot->'scope_digest')
      ||case when m ? 'content_ref' then jsonb_build_object('upload_bytes',m->'content_ref'->'size') else '{}'::jsonb end,
    'storage-job:'||v_job_id::text,receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(receipt.id,'committed',refs,'{}'::jsonb,
    jsonb_build_object(v_job_id::text,1),array[ev],'{}'::uuid[],null);
  if clued_private.storage_policy_evaluate_v2(p_token_hash,connection_id,wanted,v_job_id) is distinct from
      snapshot-'consent_receipt_id' then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  return clued_private.storage_job_status_v1(existing)||jsonb_build_object('replayed',false,'submit_receipt_id',existing.receipt_id);
end $function$;

-- clued_storage_trash_batch: the effective definition plus the gate.
create or replace function public.clued_storage_trash_batch_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $function$
declare v_connection uuid; v_batch uuid; items jsonb:='[]'::jsonb; e jsonb; m jsonb; snapshot jsonb; digest text;
  b clued_private.storage_trash_batches_v1; p clued_private.resource_center_profiles_v1; a clued_private.resource_center_artifacts_v1;
  r public.clued_audit_receipts; refs jsonb; ev text; pos int:=0; owner_key uuid; listed jsonb:='[]'::jsonb;
  gate jsonb; resources text[]:='{}'::text[];
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or (p_input-array['connection_id','batch_id','items','work_claim'])<>'{}'::jsonb
    or (p_input ? 'work_claim' and not clued_private.work_claim_ref_valid_v1(p_input->'work_claim'))
    or coalesce(p_input->>'connection_id','') !~ uuid_re or coalesce(p_input->>'batch_id','') !~ uuid_re
    or jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_array_length(p_input->'items') not between 1 and 50 then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  v_connection:=(p_input->>'connection_id')::uuid; v_batch:=(p_input->>'batch_id')::uuid;
  for e in select x from jsonb_array_elements(p_input->'items') x loop
    if jsonb_typeof(e) is distinct from 'object' then raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    m:=clued_private.storage_mutation_paths_v1(p_token_hash,v_connection,e);
    if not clued_private.storage_destructive_shape_v1(m) or m ? 'destination_path' then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    items:=items||jsonb_build_array(m);
  end loop;
  if (select count(distinct x->>'source_file_id') from jsonb_array_elements(items) x)<>jsonb_array_length(items) then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  digest:=clued_private.m1_sha256(jsonb_build_object('connection_id',v_connection,'items',items));
  snapshot:=clued_private.storage_policy_evaluate_v2(p_token_hash,v_connection,'destructive',v_batch);
  owner_key:=(snapshot->>'owner_id')::uuid;
  select * into b from clued_private.storage_trash_batches_v1 where owner_id=owner_key and id=v_batch for update;
  if found then
    if b.request_digest<>digest or b.connection_id<>v_connection then
      raise exception 'storage_trash_batch_conflict' using errcode='40001'; end if;
    return clued_private.storage_trash_batch_view_v1(b,false)||jsonb_build_object('replayed',true);
  end if;
  -- At most 5 pending (unconfirmed, unexpired, not voided) batches per client
  -- registration and connection; refused before any receipt is written.
  if (select count(*) from clued_private.storage_trash_batches_v1 b0
      where b0.owner_id=owner_key and b0.connection_id=v_connection
        and b0.registration_lineage=(snapshot->>'registration_lineage')::uuid
        and b0.account_policy_id=(snapshot->>'policy_id')::uuid
        and b0.confirmed_at is null and b0.expires_at>clock_timestamp())>=5 then
    raise exception 'storage_trash_batch_pending_limit' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=(snapshot->>'profile_id')::uuid and user_id=owner_key;
  -- Work Claim door (GenericWorkClaim §4.2): every item's resources at once,
  -- before the receipt, the batch or any registry match.
  for e in select x from jsonb_array_elements(items) x loop
    resources:=resources||clued_private.work_claim_storage_resources_v1(v_connection,p.id,e);
  end loop;
  gate:=clued_private.work_claim_gate_v1(owner_key,(snapshot->>'binding_id')::uuid,'clued-storage','storage_trash_batch',
    'collision_only',resources,p_input->'work_claim');
  if gate is not null then return gate; end if;
  r:=clued_private.m1_begin_receipt(owner_key,(snapshot->>'binding_id')::uuid,'storage_trash_batch_request',
    jsonb_build_object('idempotency_key','storage-trash-batch:'||v_batch::text,'batch_id',v_batch,'request_digest',digest),digest);
  if r.status<>'pending' then raise exception 'storage_trash_batch_conflict' using errcode='40001'; end if;
  insert into clued_private.storage_trash_batches_v1(owner_id,id,connection_id,account_policy_id,policy_generation,
    registration_lineage,binding_id,request_digest,receipt_id,expires_at)
  values(owner_key,v_batch,v_connection,(snapshot->>'policy_id')::uuid,(snapshot->>'policy_generation')::bigint,
    (snapshot->>'registration_lineage')::uuid,(snapshot->>'binding_id')::uuid,digest,r.id,clock_timestamp()+interval '24 hours')
  returning * into b;
  for e in select x from jsonb_array_elements(items) x loop
    pos:=pos+1;
    select * into a from clued_private.resource_center_artifacts_v1
      where profile_id=p.id and user_id=owner_key and path=e->>'source_path' and provider_file_id=e->>'source_file_id'
        and provider_file_version=e->>'source_file_version' and target_kind=e->>'target_kind'
        and state=case e->>'operation' when 'delete' then 'active' else 'trashed' end;
    if not found or a.path=p.managed_root
      or (e->>'operation'='delete' and not (a.governance_class='ordinary' or a.delete_authority))
      or (a.target_kind='directory' and (regexp_replace(a.path,'/[^/]*$','')=p.managed_root
        or exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id
          and x.state in ('active','trashed') and left(x.path,char_length(a.path)+1)=a.path||'/'))) then
      raise exception 'storage_trash_batch_item_unavailable' using errcode='22023'; end if;
    insert into clued_private.storage_trash_batch_items_v1(owner_id,batch_id,connection_id,position,operation,target_kind,
      artifact_id,artifact_version,provider_file_id,path,provider_file_version)
    values(owner_key,v_batch,v_connection,pos,e->>'operation',e->>'target_kind',a.id,a.version,a.provider_file_id,a.path,a.provider_file_version);
    listed:=listed||jsonb_build_array(jsonb_build_object('operation',e->>'operation','artifact_id',a.id,
      'provider_file_id',a.provider_file_id,'provider_file_version',a.provider_file_version));
  end loop;
  -- Events are exported to context readers: Drive IDs and versions, never paths.
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',v_batch));
  ev:=clued_private.m1_append_event_row(owner_key,(snapshot->>'binding_id')::uuid,r.id,r.canonical_version,
    'extension:storage:trash_batch_requested',refs,'project:'||p.project_id::text,null,
    jsonb_build_object('batch_id',v_batch,'connection_id',v_connection,'request_digest',digest,'items',listed),
    'storage-trash-batch:'||v_batch::text,r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,jsonb_build_object(v_batch::text,1),array[ev],'{}'::uuid[],null);
  -- Expiry or a policy change while waiting for locks rolls everything back.
  if clued_private.storage_policy_evaluate_v2(p_token_hash,v_connection,'destructive',v_batch) is distinct from snapshot then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  return clued_private.storage_trash_batch_view_v1(b,false)||jsonb_build_object('replayed',false);
end $function$;

notify pgrst,'reload schema';
