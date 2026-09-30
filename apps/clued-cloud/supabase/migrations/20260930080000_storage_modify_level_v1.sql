-- StorageFullCapability.v0.1 P3 part A (§3.3 part 3): the modify write level
-- and the policy switch that carries it. No job, executor or provider path
-- changes here: submit still accepts only create, so enabling modify grants
-- nothing executable until the rename/move execution migration lands.
--
-- * Policies gain an immutable scope_contract. Existing rows keep
--   clued.storage-account-scope/2 and are always evaluated with the v2 digest;
--   a new algorithm never recomputes an old row.
-- * clued.storage-account-scope/3 puts the policy's own action set into the
--   digest. Its action set is the create set, optionally plus modify.
-- * The evaluator accepts p_action='modify' and, as for every action, requires
--   it to be in the active policy's action set.
-- * public.clued_storage_write_access_v1 is the native Owner switch. Changing
--   the write level replaces the policy (new policy_id, auth_generation+1) only
--   while no prepared/started/uncertain intent exists. Jobs of this connection
--   that are still queued (no intent, no dispatch outcome) have no provider
--   effect; the switch cancels them with the same dispatch-outcome receipt the
--   Worker would write, so a job that can never be dispatched cannot block the
--   Owner. In the same transaction the active read access moves to the new
--   policy with unchanged classes and disclosure, so reads do not stop.

alter table clued_private.storage_account_policies_v2
  add column scope_contract text not null default 'clued.storage-account-scope/2'
    check(scope_contract in ('clued.storage-account-scope/2','clued.storage-account-scope/3'));
alter table clued_private.storage_account_policies_v2
  drop constraint storage_account_policies_v2_actions_check,
  add constraint storage_account_policies_v2_actions_check check(
    actions=array['inspect','create_file','create_topic']::text[]
    or (scope_contract='clued.storage-account-scope/3'
      and actions=array['inspect','create_file','create_topic','modify']::text[])),
  drop constraint storage_account_policies_v2_consent_source_check,
  add constraint storage_account_policies_v2_consent_source_check check(
    consent_source in ('native_connection','reviewed_transition','explicit_restore','native_level_change'));

-- Same inputs as storage_policy_scope_digest_v2, plus the policy's actions.
-- A /2 contract returns the v2 digest and only for the create action set.
create function clued_private.storage_policy_scope_digest_v3(p_connection uuid,p_contract text,p_actions text[])
returns text language plpgsql stable security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  tracks jsonb; registered jsonb;
begin
  if p_contract='clued.storage-account-scope/2' then
    if p_actions is distinct from array['inspect','create_file','create_topic']::text[] then return null; end if;
    return clued_private.storage_policy_scope_digest_v2(p_connection);
  end if;
  if p_contract is distinct from 'clued.storage-account-scope/3'
    or (p_actions is distinct from array['inspect','create_file','create_topic']::text[]
      and p_actions is distinct from array['inspect','create_file','create_topic','modify']::text[]) then
    return null; end if;
  select * into c from clued_private.storage_connections_v1 where id=p_connection;
  if not found or c.provider_subject is null then return null; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if not found or p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
    or jsonb_typeof(p.cloud_runtime->'allowed_root_children') is distinct from 'array' then return null; end if;
  tracks:=p.cloud_runtime->'allowed_root_children';
  if jsonb_array_length(tracks) not between 1 and 32 or exists(
    select 1 from jsonb_array_elements(tracks) x where jsonb_typeof(x)<>'string')
    or (select count(distinct x) from jsonb_array_elements(tracks) x)<>jsonb_array_length(tracks) then return null; end if;
  select jsonb_agg(jsonb_build_object('path',a.path,'provider_file_id',a.provider_file_id) order by a.path collate "C") into registered
    from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
      and a.state='active' and a.target_kind='directory'
      and a.path in (select p.managed_root||'/'||x from jsonb_array_elements_text(tracks) x);
  if coalesce(jsonb_array_length(registered),0)<>jsonb_array_length(tracks) then return null; end if;
  return clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-account-scope/3',
    'owner_id',c.owner_id,'provider',c.provider,'provider_subject',c.provider_subject,
    'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'managed_root',p.managed_root,
    'profile_id',p.id,'policy_version',p.policy_version,'tracks',registered,
    'directory_semantics',jsonb_build_array('topic','asset_collection'),
    'actions',to_jsonb(p_actions)));
end $$;

-- Both evaluators select the digest algorithm by the policy's own contract.
do $migration$
declare patch record; body text; hits int;
begin
  for patch in select * from (values
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic') then$a$,
     $r$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify') then$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$    or policy.provider_subject is distinct from c.provider_subject or policy.root_folder_id<>root_key then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;$a$,
     $r$    or policy.provider_subject is distinct from c.provider_subject or policy.root_folder_id<>root_key
    or not p_action=any(policy.actions) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$  digest:=clued_private.storage_policy_scope_digest_v2(c.id);$a$,
     $r$  digest:=clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions);$r$,1),
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)',
     $a$  digest:=clued_private.storage_policy_scope_digest_v2(c.id);$a$,
     $r$  digest:=clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions);$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    body:=pg_get_functiondef(patch.sig::regprocedure);
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_modify_level_definition_mismatch: % (% of %)',patch.sig,hits,patch.expected;
    end if;
    execute replace(body,patch.anchor,patch.replacement);
  end loop;
end $migration$;

-- Native Owner control of the write level. status returns the CAS base
-- (the active policy_generation) and the disclosure to show. set_classes
-- takes classes [] or ["modify"].
create function public.clued_storage_write_access_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; fresh clued_private.storage_account_policies_v2;
  ra clued_private.storage_read_access_v1; moved clued_private.storage_read_access_v1;
  queued clued_private.storage_jobs_v1; qr public.clued_audit_receipts; qreq jsonb; qrefs jsonb; qev text; cancelled jsonb:='[]'::jsonb;
  root text; expected bigint; wanted text[]; actions text[]; digest text;
  r public.clued_audit_receipts; refs jsonb; ev text; result jsonb;
  base_actions constant text[]:=array['inspect','create_file','create_topic'];
  disclosure constant text:='clued.storage-modify-disclosure/1';
  disabled constant text:='clued.storage-modify-disabled/1';
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','set_classes') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='status' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb or coalesce(p_input->>'connection_id','') !~ uuid_re then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select * into policy from clued_private.storage_account_policies_v2
      where id=c.account_policy_id and connection_id=c.id and owner_id=u and state='active';
    return jsonb_build_object('connection_id',c.id,'disclosure_version',disclosure,
      'active',policy.id is not null and c.auth_mode='account_policy' and c.state='active',
      -- policy_generation is the set_classes CAS base (0 = no active policy).
      'policy_generation',coalesce(policy.policy_generation,0),
      'classes',case when 'modify'=any(policy.actions) then '["modify"]'::jsonb else '[]'::jsonb end);
  end if;
  if (p_input-array['action','connection_id','classes','base_generation','disclosure_version','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','classes','base_generation','disclosure_version','idempotency_key'])
    or coalesce(p_input->>'connection_id','') !~ uuid_re
    or jsonb_typeof(p_input->'classes') is distinct from 'array'
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  select coalesce(array_agg(x order by x),'{}') into wanted from (select distinct jsonb_array_elements_text(p_input->'classes') x) s;
  if jsonb_array_length(p_input->'classes')<>cardinality(wanted) or not (wanted <@ array['modify']) then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if cardinality(wanted)>0 and p_input->>'disclosure_version' is distinct from disclosure then
    raise exception 'storage_write_disclosure_changed' using errcode='40001'; end if;
  expected:=(p_input->>'base_generation')::bigint;
  -- Unlocked resolution yields only the advisory lock key. The root advisory
  -- is taken before any row lock, as by the evaluators, submit and begin, so a
  -- switch serializes with every admission on this root.
  select pr.root_folder_id into root from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
    where co.id=(p_input->>'connection_id')::uuid and co.owner_id=u;
  if root is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  perform clued_private.storage_owner_v1();
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
  select * into policy from clued_private.storage_account_policies_v2
    where id=c.account_policy_id and connection_id=c.id and owner_id=u for update;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=u and state='active' for update;
  r:=clued_private.m1_begin_receipt(u,null,'storage_owner_write_access_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  if c.id is null or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null
    or policy.id is null or policy.state<>'active' or p.root_folder_id is distinct from root
    or p.state<>'active' or p.version<>c.profile_version
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=u and provider=c.provider
      and provider_subject=c.provider_subject and root_folder_id=root and lineage_id is null and denied)
    or policy.policy_generation<>expected
    or ('modify'=any(policy.actions))=(cardinality(wanted)>0) then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  -- The switch re-consents only the level. If the scope itself has drifted
  -- (tracks, profile), the current policy no longer evaluates and is not renewed.
  if policy.scope_digest is distinct from clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions)
    or coalesce(policy.expires_at<=clock_timestamp(),false) then
    raise exception 'storage_owner_scope_changed' using errcode='42501'; end if;
  -- An unresolved intent may have a provider effect: it keeps its policy and
  -- blocks the switch. Work admitted under the old policy is never re-authorized.
  perform clued_private.storage_root_quiet_v1(u,root);
  -- Queued jobs have no intent and no effect. Cancel them as the Worker's
  -- report would (same idempotency key; a late report returns the job status
  -- unchanged). A Worker that already loaded the job waits on this root lock,
  -- then fails its snapshot check, and the cloud worker refuses any job with a
  -- dispatch outcome before begin.
  for queued in select * from clued_private.storage_jobs_v1 j where j.owner_id=u and j.connection_id=c.id
    and j.intent_id is null and j.dispatch_outcome is null order by j.job_id for update loop
    qreq:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||queued.job_id::text,'job_id',queued.job_id,
      'outcome',jsonb_build_object('status','denied'));
    qr:=clued_private.m1_begin_receipt(u,null,'storage_dispatch_outcome',qreq,clued_private.m1_sha256(qreq));
    if qr.status<>'pending' then raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
    update clued_private.storage_jobs_v1 set dispatch_outcome=qreq->'outcome',dispatch_outcome_receipt_id=qr.id
      where owner_id=u and job_id=queued.job_id;
    qrefs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',queued.job_id));
    qev:=clued_private.m1_append_event_row(u,null,qr.id,qr.canonical_version,'extension:storage:dispatch_outcome',
      qrefs,'project:'||p.project_id::text,null,qreq,qreq->>'idempotency_key',qr.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(qr.id,'committed',qrefs,'{}'::jsonb,'{}'::jsonb,array[qev],'{}'::uuid[],null);
    cancelled:=cancelled||to_jsonb(queued.job_id);
  end loop;
  actions:=case when cardinality(wanted)>0 then base_actions||'modify'::text else base_actions end;
  digest:=clued_private.storage_policy_scope_digest_v3(c.id,'clued.storage-account-scope/3',actions);
  if digest is null then raise exception 'storage_owner_scope_changed' using errcode='42501'; end if;
  update clued_private.storage_account_policies_v2
    set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=policy.id;
  insert into clued_private.storage_account_policies_v2(owner_id,connection_id,provider,provider_subject,root_folder_id,
    profile_id,actions,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,
    consent_receipt_id,activation_receipt_id,state,expires_at,scope_contract)
  values(u,c.id,policy.provider,policy.provider_subject,policy.root_folder_id,policy.profile_id,actions,digest,
    (select max(policy_generation) from clued_private.storage_account_policies_v2 where connection_id=c.id)+1,
    policy.source_decision_id,policy.decision_version,'native_level_change',
    case when cardinality(wanted)>0 then disclosure else disabled end,r.id,r.id,'active',policy.expires_at,
    'clued.storage-account-scope/3')
  returning * into fresh;
  update clued_private.storage_connections_v1 set account_policy_id=fresh.id,auth_generation=auth_generation+1
    where id=c.id returning * into c;
  -- §3.3 part 1: the read access follows the new policy with the same classes
  -- and disclosure; the Owner's original read consent receipt is kept. A row
  -- bound to any other policy was already inert and is only revoked.
  if ra.id is not null then
    update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=ra.id;
  end if;
  if ra.id is not null and ra.account_policy_id=policy.id then
    insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id)
    values(u,c.id,fresh.id,ra.classes,(select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id)+1,
      ra.disclosure_version,ra.consent_receipt_id)
    returning * into moved;
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_write_access_v1',
    refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'classes',to_jsonb(wanted),
      'policy_id',fresh.id,'policy_generation',fresh.policy_generation,'previous_policy_id',policy.id,
      'auth_generation',c.auth_generation,'read_generation',moved.read_generation,'cancelled_jobs',cancelled),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(policy.id::text,expected),
    jsonb_build_object(fresh.id::text,fresh.policy_generation),array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;

revoke all on function clued_private.storage_policy_scope_digest_v3(uuid,text,text[])
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_write_access_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_write_access_v1(jsonb) to authenticated;
