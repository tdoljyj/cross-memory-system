-- Reviewed exact-target transition only. No seeds, Google calls, new writer,
-- OAuth consent, public platform admin, or legacy/account-policy OR fallback.
create table clued_private.storage_policy_transition_manifests_v2 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  root_folder_id text not null,
  source_decision_id uuid not null references public.clued_memories(id),
  decision_version bigint not null check(decision_version>0),
  disclosure_version text not null check(disclosure_version='clued.storage-account-consent/2'),
  manifest_sha256 text not null check(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null,
  inventory jsonb not null,
  inventory_digest text not null check(inventory_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  evidence_id uuid not null references public.clued_evidence(id),
  registration_receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp()
);
create table clued_private.storage_policy_transition_results_v2 (
  manifest_id uuid primary key references clued_private.storage_policy_transition_manifests_v2(id),
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  policy_id uuid not null unique references clued_private.storage_account_policies_v2(id),
  transition_receipt_id uuid not null references public.clued_audit_receipts(id),
  policy_receipt_id uuid not null references public.clued_audit_receipts(id)
);
create table clued_private.storage_policy_transition_cancellations_v2 (
  manifest_id uuid not null references clued_private.storage_policy_transition_manifests_v2(id),
  owner_id uuid not null,
  job_id uuid not null,
  issuer_hash text not null references clued_private.storage_oauth_apps_v1(issuer_hash),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key(manifest_id,job_id),
  foreign key(owner_id,job_id) references clued_private.storage_jobs_v1(owner_id,job_id)
);
alter table clued_private.storage_policy_transition_manifests_v2 enable row level security;
alter table clued_private.storage_policy_transition_results_v2 enable row level security;
alter table clued_private.storage_policy_transition_cancellations_v2 enable row level security;
revoke all on clued_private.storage_policy_transition_manifests_v2,
  clued_private.storage_policy_transition_results_v2,clued_private.storage_policy_transition_cancellations_v2
  from public,anon,authenticated,service_role;

create function clued_private.storage_transition_immutable_v2() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'storage_transition_history_immutable' using errcode='42501'; end $$;
create trigger storage_transition_manifest_immutable_v2 before update or delete
  on clued_private.storage_policy_transition_manifests_v2 for each row execute function clued_private.storage_transition_immutable_v2();
create trigger storage_transition_result_immutable_v2 before update or delete
  on clued_private.storage_policy_transition_results_v2 for each row execute function clued_private.storage_transition_immutable_v2();
create trigger storage_transition_cancel_immutable_v2 before update or delete
  on clued_private.storage_policy_transition_cancellations_v2 for each row execute function clued_private.storage_transition_immutable_v2();

-- Pure snapshot, never an authorization. Exact historical preimages are
-- necessary because legacy regrant overwrites its row and the Event omits the
-- Binding/actions. Both original receipt hashes and complete coverage are
-- checked; absent preimages, deleted identities and unknown history fail closed.
create function clued_private.storage_policy_transition_inventory_v2(p_owner uuid,p_connection uuid,p_history jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  connections uuid[]; bindings uuid[]; h jsonb; q jsonb; r public.clued_audit_receipts;
  history_ids uuid[]:='{}'; rows jsonb; clients jsonb; result jsonb; source_bindings uuid[]:='{}';
begin
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner;
  if c.id is null or p.id is null or jsonb_typeof(p_history) is distinct from 'array' or jsonb_array_length(p_history)>256 then
    raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
  select array_agg(sc.id order by sc.id) into connections from clued_private.storage_connections_v1 sc
    join clued_private.resource_center_profiles_v1 sp on sp.id=sc.profile_id and sp.user_id=p_owner
    where sc.owner_id=p_owner and sp.root_folder_id=p.root_folder_id;
  for h in select value from jsonb_array_elements(p_history) loop
    if jsonb_typeof(h) is distinct from 'object' or h-array['receipt_id','payload']<>'{}'::jsonb
      or not(h ?& array['receipt_id','payload']) or jsonb_typeof(h->'payload') is distinct from 'object' then
      raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
    q:=h->'payload';
    select * into r from public.clued_audit_receipts where id=(h->>'receipt_id')::uuid and user_id=p_owner
      and status='committed' and operation_family in ('storage_account_grant_client','storage_account_revoke_client');
    if not found or r.id=any(history_ids) or q-array['action','idempotency_key','request_hash','connection_id','base_version','binding_id','authorization_version','actions','expires_at']<>'{}'::jsonb
      or not(q ?& array['action','idempotency_key','connection_id','base_version','binding_id'])
      or r.operation_family is distinct from 'storage_account_'||(q->>'action')
      or r.idempotency_key is distinct from btrim(q->>'idempotency_key')
      or not((q->>'connection_id')::uuid=any(connections))
      or not(r.target_refs @> jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',(q->>'connection_id')::uuid)))
      or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation',r.operation_family,'payload',q-'idempotency_key'-'request_hash'))
      or r.received_payload_hash is distinct from clued_private.m1_sha256(q) then
      raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
    history_ids:=array_append(history_ids,r.id);
    source_bindings:=array_append(source_bindings,(q->>'binding_id')::uuid);
  end loop;
  if exists(select 1 from public.clued_audit_receipts ar where ar.user_id=p_owner and ar.status='committed'
    and ar.operation_family in ('storage_account_grant_client','storage_account_revoke_client')
    and exists(select 1 from unnest(connections) ci where ar.target_refs @>
      jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',ci))) and not(ar.id=any(history_ids))) then
    raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
  if exists(select 1 from clued_private.storage_client_grants_v1 g where g.connection_id=any(connections)
    and not(g.receipt_id=any(history_ids))) then
    raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
  select coalesce(array_agg(distinct id order by id),'{}') into bindings from (
    select unnest(source_bindings) id union select binding_id from clued_private.storage_client_grants_v1 where connection_id=any(connections)) x;
  if cardinality(bindings)>128 then raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
  if exists(select 1 from unnest(bindings) bi where not exists(
    select 1 from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id and a.owner_id=p_owner
      join clued_private.authorization_requests_v12 req on req.id=a.request_id and req.owner_id=p_owner and req.binding_id=b.id
      join clued_private.storage_client_request_links_v2 l on l.request_id=req.id
      join clued_private.storage_client_registrations_v2 reg on reg.lineage_id=l.lineage_id and reg.generation=l.registration_generation
      where b.id=bi and b.user_id=p_owner and req.status='approved' and reg.issuer_hash=req.issuer_hash
        and reg.resource=req.resource and reg.client_id=req.client_id and a.client_id=req.client_id and a.resource=req.resource
        and reg.metadata_digest=l.metadata_digest and reg.metadata_digest=clued_private.storage_client_request_digest_v2(req.id)
        and exists(select 1 from public.clued_audit_receipts where id=l.review_receipt_id and status='committed')
        and exists(select 1 from public.clued_audit_receipts where id=reg.review_receipt_id and status='committed'))) then
    raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('binding_id',b.id,'binding_revoked_at',b.revoked_at,
    'binding_expires_at',to_jsonb(b)->>'expires_at','request_id',a.request_id,'authorization_version',a.version,
    'authorization_expires_at',a.expires_at,'authorization_revoked_at',a.revoked_at,
    'metadata_digest',l.metadata_digest,'lineage_id',l.lineage_id,'registration_generation',l.registration_generation,
    'link_receipt_id',l.review_receipt_id,'capability_id',cap.id,'capability_version',cap.version,
    'capability_registration_generation',cap.registration_generation,'capability_receipt_id',cap.receipt_id,
    'audit',coalesce((select jsonb_agg(to_jsonb(au) order by au.id) from clued_private.authorization_audit_v12 au
      where au.owner_id=p_owner and au.binding_id=b.id),'[]'::jsonb)) order by b.id),'[]'::jsonb) into clients
    from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id
    join clued_private.storage_client_request_links_v2 l on l.request_id=a.request_id
    left join clued_private.storage_client_capabilities_v2 cap on cap.lineage_id=l.lineage_id and cap.state='active'
    where b.id=any(bindings) and b.user_id=p_owner;
  result:=jsonb_build_object('contract','clued.storage-transition-inventory/2','owner_id',p_owner,'connection_id',c.id,
    'root_folder_id',p.root_folder_id,'scope_digest',clued_private.storage_policy_scope_digest_v2(c.id),
    'connection',jsonb_build_object('id',c.id,'version',c.version,'credential_version',c.credential_version,
      'auth_mode',c.auth_mode,'auth_generation',c.auth_generation,'account_policy_id',c.account_policy_id,
      'provider',c.provider,'provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,
      'profile_id',c.profile_id,'profile_version',c.profile_version,'source_decision_id',c.source_decision_id,'decision_version',c.decision_version,
      'state',c.state,'revoked_at',c.revoked_at),
    'profile',jsonb_build_object('id',p.id,'version',p.version,'state',p.state,'root_folder_id',p.root_folder_id,
      'source_decision_id',p.source_decision_id,'runtime_digest',clued_private.m1_sha256(p.cloud_runtime)),
    'clients',clients);
  select coalesce(jsonb_agg(jsonb_build_object('id',sc.id,'profile_id',sc.profile_id,'profile_state',sp.state,'profile_version',sp.version,
    'connection_version',sc.version,'state',sc.state,'revoked_at',sc.revoked_at,
    'provider_subject',sc.provider_subject,'auth_mode',sc.auth_mode,'auth_generation',sc.auth_generation) order by sc.id),'[]') into rows
    from clued_private.storage_connections_v1 sc join clued_private.resource_center_profiles_v1 sp on sp.id=sc.profile_id
    where sc.id=any(connections);
  result:=result||jsonb_build_object('root_connections',rows);
  select coalesce(jsonb_agg(to_jsonb(g) order by g.connection_id,g.binding_id),'[]') into rows
    from clued_private.storage_client_grants_v1 g where g.connection_id=any(connections);
  result:=result||jsonb_build_object('grants',rows);
  select coalesce(jsonb_agg(jsonb_build_object('receipt_id',ar.id,'request_sha256',ar.request_sha256,
    'received_payload_hash',ar.received_payload_hash,'operation',ar.operation_family) order by ar.id),'[]') into rows
    from public.clued_audit_receipts ar where ar.id=any(history_ids);
  result:=result||jsonb_build_object('history_receipts',rows);
  select coalesce(jsonb_agg(to_jsonb(d) order by d.lineage_id),'[]') into rows from clued_private.storage_client_denies_v2 d
    where d.owner_id=p_owner and d.lineage_id in (select (x->>'lineage_id')::uuid from jsonb_array_elements(clients) x);
  result:=result||jsonb_build_object('global_denies',rows);
  select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') into rows from clued_private.storage_root_denies_v2 d
    where d.owner_id=p_owner and d.root_folder_id=p.root_folder_id;
  result:=result||jsonb_build_object('root_denies',rows);
  select coalesce(jsonb_agg(to_jsonb(ap) order by ap.id),'[]') into rows from clued_private.storage_account_policies_v2 ap
    where ap.owner_id=p_owner and ap.root_folder_id=p.root_folder_id;
  result:=result||jsonb_build_object('policies',rows);
  select coalesce(jsonb_agg(jsonb_build_object('job_id',j.job_id,'connection_id',j.connection_id,'binding_id',j.binding_id,
    'request_digest',j.request_digest,'receipt_id',j.receipt_id,'intent_id',j.intent_id,'intent_state',m.state,'intent_version',m.version,
    'dispatch_outcome',j.dispatch_outcome,'dispatch_outcome_receipt_id',j.dispatch_outcome_receipt_id,
    'cloud_writer_binding_id',j.cloud_writer_binding_id) order by j.job_id),'[]') into rows
    from clued_private.storage_jobs_v1 j left join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id
    where j.owner_id=p_owner and j.connection_id=any(connections);
  result:=result||jsonb_build_object('jobs',rows);
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'profile_id',m.profile_id,'state',m.state,'version',m.version) order by m.id),'[]') into rows
    from clued_private.resource_center_mutations_v1 m join clued_private.resource_center_profiles_v1 mp on mp.id=m.profile_id
    where m.user_id=p_owner and mp.root_folder_id=p.root_folder_id and m.state in ('prepared','started','uncertain');
  return result||jsonb_build_object('unresolved_intents',rows);
end $$;

-- Compare immutable source inventory, allowing ONLY this manifest's exact
-- queued-job cancellations. Actual quietness is checked separately; this
-- normalization cannot turn an intent or unknown outcome into queued work.
create function clued_private.storage_transition_normalize_v2(p_manifest uuid,p_inventory jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare jobs jsonb:='[]'; j jsonb; original jsonb; canceled clued_private.storage_policy_transition_cancellations_v2;
  m clued_private.storage_policy_transition_manifests_v2;
begin
  select * into m from clued_private.storage_policy_transition_manifests_v2 where id=p_manifest;
  for j in select value from jsonb_array_elements(p_inventory->'jobs') loop
    select * into canceled from clued_private.storage_policy_transition_cancellations_v2
      where manifest_id=m.id and owner_id=m.owner_id and job_id=(j->>'job_id')::uuid;
    if found then
      select value into original from jsonb_array_elements(m.inventory->'jobs') where value->>'job_id'=j->>'job_id';
      if original is null or original->'intent_id'<>'null'::jsonb or original->'dispatch_outcome'<>'null'::jsonb
        or j->'intent_id'<>'null'::jsonb or j->'dispatch_outcome' is distinct from '{"status":"denied"}'::jsonb
        or j->>'dispatch_outcome_receipt_id' is distinct from canceled.receipt_id::text
        or not exists(select 1 from public.clued_audit_receipts where id=canceled.receipt_id and user_id=m.owner_id and status='committed') then
        raise exception 'storage_transition_conflict' using errcode='40001'; end if;
      j:=j||jsonb_build_object('dispatch_outcome',null,'dispatch_outcome_receipt_id',null);
    end if;
    jobs:=jobs||jsonb_build_array(j);
  end loop;
  return p_inventory||jsonb_build_object('jobs',jobs);
end $$;

-- Historical metadata recovery is independent of NEW activation eligibility.
-- Never return another issuer's result or reinterpret a different payload/key.
-- This function is private and read-only; its caller verifies the native Owner
-- again immediately before returning. Revoked issuer rows remain audit facts.
create function clued_private.storage_transition_replay_v2(p_owner uuid,p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m clued_private.storage_policy_transition_manifests_v2; r public.clued_audit_receipts;
  receipt_id uuid; original_issuer text; op text:=p_input->>'action';
begin
  if op not in ('transition','cancel_queued') then return null; end if;
  select * into m from clued_private.storage_policy_transition_manifests_v2 where id=(p_input->>'manifest_id')::uuid and owner_id=p_owner;
  if not found or not exists(select 1 from clued_private.storage_connections_v1 where id=m.connection_id and owner_id=p_owner) then return null; end if;
  if op='transition' then
    select transition_receipt_id,issuer_hash into receipt_id,original_issuer from clued_private.storage_policy_transition_results_v2 where manifest_id=m.id;
  else
    select x.receipt_id,x.issuer_hash into receipt_id,original_issuer from clued_private.storage_policy_transition_cancellations_v2 x
      where x.manifest_id=m.id and x.owner_id=p_owner and x.job_id=(p_input->>'job_id')::uuid;
  end if;
  if receipt_id is null then return null; end if;
  select * into r from public.clued_audit_receipts where id=receipt_id and user_id=p_owner and status='committed'
    and operation_family='storage_policy_'||op and operation='storage_policy_'||op
    and idempotency_key=p_input->>'idempotency_key' and owns_idempotency_key;
  if not found then return null; end if;
  if original_issuer is distinct from p_issuer_hash
    or p_input->>'manifest_sha256' is distinct from m.manifest_sha256
    or p_input->>'expected_inventory_digest' is distinct from m.inventory_digest
    or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_policy_'||op,'payload',p_input-'idempotency_key'-'request_hash'))
    or r.received_payload_hash is distinct from clued_private.m1_sha256(p_input)
    or r.canonical_result is null or r.canonical_result->>'status' is distinct from 'committed'
    or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result)
    or not(r.target_refs @> jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',
      case when op='transition' then m.connection_id else (p_input->>'job_id')::uuid end))) then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  return r.canonical_result;
end $$;

create function public.clued_storage_policy_transition_v2(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); app clued_private.storage_oauth_apps_v1;
  m clued_private.storage_policy_transition_manifests_v2; done clued_private.storage_policy_transition_results_v2;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1; evrow public.clued_evidence;
  r public.clued_audit_receipts; policy_receipt public.clued_audit_receipts; policy clued_private.storage_account_policies_v2;
  job clued_private.storage_jobs_v1; op text; keys text[]; client jsonb; item jsonb; previous jsonb; inventory jsonb;
  refs jsonb; ev text; policy_ev text; policy_req jsonb; result jsonb; lid uuid; rid uuid; bid uuid;
  deny_lineages uuid[]:='{}'; original_jobs jsonb; gen bigint; rt_decision uuid; rt_version bigint; failure text; code text; app_client text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'action') is distinct from 'string'
    or jsonb_typeof(p_input->'manifest_id') is distinct from 'string' or pg_column_size(p_input)>8192 then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  op:=p_input->>'action'; keys:=array['action','manifest_id'];
  if op in ('transition','cancel_queued') then keys:=keys||array['manifest_sha256','expected_inventory_digest','idempotency_key'];
  elsif op not in ('describe','inspect') then raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  if op='cancel_queued' then keys:=keys||array['job_id','request_digest','submit_receipt_id']; end if;
  if p_input-keys<>'{}' or not(p_input ?& keys) then raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  result:=clued_private.storage_transition_replay_v2(u,p_issuer_hash,p_input);
  if result is not null then perform clued_private.storage_owner_v1(); return result; end if;
  if op='transition' then
    -- Registry provisioning has no public runtime writer. Serialize INSERT /
    -- enable/revoke provisioning as well as existing rows: row locks alone do
    -- not guard an absent second issuer. Deployment operations sharing a root
    -- must use this table-before-app-before-root order, never root then table.
    lock table clued_private.storage_oauth_apps_v1 in share mode;
    -- The table wait may have crossed the first transaction's commit and an
    -- issuer lifecycle change. Re-read exact historical metadata, not a new
    -- admission, before imposing current activation eligibility.
    result:=clued_private.storage_transition_replay_v2(u,p_issuer_hash,p_input);
    if result is not null then perform clued_private.storage_owner_v1(); return result; end if;
    -- Resolve a lock key, then lock ALL live issuers for this OAuth client in
    -- fixed order. A disabled selected issuer is insufficient if another live
    -- issuer still controls the same connector.
    select oauth_client_id into app_client from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null;
    if app_client is null then raise exception 'storage_transition_denied' using errcode='42501'; end if;
    perform 1 from clued_private.storage_oauth_apps_v1 where oauth_client_id=app_client and revoked_at is null order by issuer_hash for share;
    if (select count(*) from clued_private.storage_oauth_apps_v1 where oauth_client_id=app_client and revoked_at is null)<>1 then
      raise exception 'storage_transition_denied' using errcode='42501'; end if;
  end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  -- cancel_queued has no table gate; its app-row wait can also cross an
  -- original commit followed by revocation. Recover ONLY that exact result.
  result:=clued_private.storage_transition_replay_v2(u,p_issuer_hash,p_input);
  if result is not null then perform clued_private.storage_owner_v1(); return result; end if;
  if app.issuer_hash is null then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  -- Reviewed cutover is performed with the fixed executor disabled. The app
  -- SHARE lock prevents enablement racing this transaction. Worker submission
  -- flags still need the separate deployment check; no flag is changed here.
  if op='transition' and (app.execution_enabled or app.oauth_client_id is distinct from app_client) then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  select * into m from clued_private.storage_policy_transition_manifests_v2 where id=(p_input->>'manifest_id')::uuid and owner_id=u;
  if not found then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=m.connection_id and owner_id=u;
  if c.id is null or c.oauth_client_id is distinct from app.oauth_client_id then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  select * into done from clued_private.storage_policy_transition_results_v2 where manifest_id=m.id;
  if op in ('describe','inspect') then
    result:=jsonb_build_object('contract','clued.storage-policy-transition-status/2','manifest_id',m.id,'connection_id',m.connection_id,
      'manifest_sha256',m.manifest_sha256,'expected_inventory_digest',m.inventory_digest,'expires_at',m.expires_at,
      'status',case when done.manifest_id is not null then 'committed' when m.expires_at<=clock_timestamp() then 'expired' else 'reviewed' end,
      'policy_id',done.policy_id,'transition_receipt_id',done.transition_receipt_id,'policy_receipt_id',done.policy_receipt_id,
      'execution_permitted',false);
    if op='describe' then
      result:=result||jsonb_build_object('queued_jobs',coalesce((select jsonb_agg(jsonb_build_object('job_id',x->'job_id',
        'request_digest',x->'request_digest','submit_receipt_id',x->'receipt_id') order by x->>'job_id')
        from jsonb_array_elements(m.inventory->'jobs') x where x->'intent_id'='null'::jsonb and x->'dispatch_outcome'='null'::jsonb),'[]'::jsonb));
    end if;
    perform clued_private.storage_owner_v1();
    return result;
  end if;
  if jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or btrim(p_input->>'idempotency_key')<>p_input->>'idempotency_key'
    or jsonb_typeof(p_input->'manifest_sha256') is distinct from 'string'
    or jsonb_typeof(p_input->'expected_inventory_digest') is distinct from 'string'
    or (op='cancel_queued' and (jsonb_typeof(p_input->'job_id') is distinct from 'string'
      or jsonb_typeof(p_input->'request_digest') is distinct from 'string' or jsonb_typeof(p_input->'submit_receipt_id') is distinct from 'string'))
    or p_input->>'manifest_sha256' is distinct from m.manifest_sha256
    or p_input->>'expected_inventory_digest' is distinct from m.inventory_digest then
    raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('storage-transition-native:'||u::text||':'||op||':'||(p_input->>'idempotency_key'),0));
  r:=clued_private.m1_begin_receipt(u,null,'storage_policy_'||op,p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    perform clued_private.storage_owner_v1(); return r.canonical_result;
  end if;
  if done.manifest_id is not null or m.expires_at<=clock_timestamp() then raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  select * into evrow from public.clued_evidence where id=m.evidence_id;
  if evrow.id is null then raise exception 'storage_transition_review_required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('clued-evidence-withdrawal:'||evrow.user_id::text,0));
  if exists(select 1 from clued_private.evidence_withdrawals where user_id=evrow.user_id and evidence_id=evrow.id)
    or not exists(select 1 from public.clued_audit_receipts where id=m.registration_receipt_id and status='committed') then
    raise exception 'storage_transition_review_required' using errcode='42501'; end if;
  if op='cancel_queued' then
    perform pg_advisory_xact_lock(hashtextextended('storage-job:'||u::text||':'||((p_input->>'job_id')::uuid)::text,0));
  else
    for lid in select distinct (x->>'lineage_id')::uuid from jsonb_array_elements(m.inventory->'clients') x order by 1 loop
      perform clued_private.storage_client_guard_v2(u,lid,false);
    end loop;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text||':'||m.root_folder_id,0));
  perform clued_private.storage_owner_v1();
  -- Cutover never takes a job lock under root. Its quiet read includes jobs on
  -- ALL historical connections/profiles sharing this owner/provider root.
  if op='transition' then
    -- The current schema's active provider-root/profile uniqueness already
    -- rules out this shape; keep the execution-eligibility defense explicit.
    -- A revoked historical profile with a still-active connection is NOT an
    -- executable sibling and remains in the exact inventory for audit/CAS.
    if exists(select 1 from clued_private.storage_connections_v1 sc
      join clued_private.resource_center_profiles_v1 sp on sp.id=sc.profile_id and sp.user_id=u
      where sc.owner_id=u and sc.id<>m.connection_id and sp.root_folder_id=m.root_folder_id
        and sp.state='active' and sc.state='active' and sc.revoked_at is null) then
      raise exception 'storage_transition_denied' using errcode='42501'; end if;
    perform clued_private.storage_root_quiet_v1(u,m.root_folder_id);
    if exists(select 1 from clued_private.storage_jobs_v1 j join clued_private.storage_connections_v1 sc on sc.id=j.connection_id
      join clued_private.resource_center_profiles_v1 sp on sp.id=sc.profile_id where j.owner_id=u and sp.root_folder_id=m.root_folder_id
      and j.intent_id is null and (j.dispatch_outcome is distinct from '{"status":"denied"}'::jsonb
        and j.dispatch_outcome is distinct from '{"status":"attention_required"}'::jsonb)) then
      raise exception 'storage_transition_not_quiet' using errcode='42501'; end if;
    for bid in select (x->>'binding_id')::uuid from jsonb_array_elements(m.inventory->'clients') x order by 1 loop
      perform 1 from public.clued_agent_bindings where id=bid and user_id=u for share;
    end loop;
    for bid in select (x->>'binding_id')::uuid from jsonb_array_elements(m.inventory->'clients') x order by 1 loop
      perform 1 from clued_private.authorizations_v12 where binding_id=bid and owner_id=u for share;
    end loop;
  end if;
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1 where id=m.connection_id and owner_id=u for update;
  if not found or c.auth_mode<>'legacy' or c.state<>'active' or c.revoked_at is not null or c.account_policy_id is not null
    or c.oauth_client_id is distinct from app.oauth_client_id then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  if op='transition' then
    perform 1 from clued_private.storage_client_grants_v1 g where g.connection_id in
      (select (x->>'id')::uuid from jsonb_array_elements(m.inventory->'root_connections') x)
      order by g.binding_id,g.connection_id for update;
    for rid in select distinct (x->>'capability_id')::uuid from jsonb_array_elements(m.inventory->'clients') x
      where x->>'capability_id' is not null order by 1 loop
      perform 1 from clued_private.storage_client_capabilities_v2 where id=rid for share;
    end loop;
  end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  rt_decision:=(p.cloud_runtime->>'source_decision_id')::uuid; rt_version:=(p.cloud_runtime->>'decision_version')::bigint;
  if p.id is null or p.root_folder_id<>m.root_folder_id or p.version<>c.profile_version or p.state<>'active'
    or p.cloud_runtime->>'profile_version' is distinct from p.version::text or rt_decision is null or rt_version is null then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id in (c.source_decision_id,p.source_decision_id,m.source_decision_id,rt_decision) order by id for share;
  if not clued_private.resource_center_decision_current_v1(u,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,m.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,rt_decision)
    or not exists(select 1 from public.clued_memories where id=c.source_decision_id and version=c.decision_version)
    or not exists(select 1 from public.clued_memories where id=m.source_decision_id and version=m.decision_version)
    or not exists(select 1 from public.clued_memories where id=rt_decision and version=rt_version) then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  perform 1 from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=u
    and a.path in (select p.managed_root||'/'||x from jsonb_array_elements_text(p.cloud_runtime->'allowed_root_children') x) order by a.id for share;
  inventory:=clued_private.storage_policy_transition_inventory_v2(u,c.id,m.manifest->'history_preimages');
  if clued_private.m1_sha256(clued_private.storage_transition_normalize_v2(m.id,inventory))<>m.inventory_digest then
    raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  if op='cancel_queued' then
    select value into previous from jsonb_array_elements(m.inventory->'jobs') where value->>'job_id'=p_input->>'job_id';
    select * into job from clued_private.storage_jobs_v1 where owner_id=u and job_id=(p_input->>'job_id')::uuid for update;
    if previous is null or job.job_id is null or previous->'intent_id'<>'null'::jsonb or previous->'dispatch_outcome'<>'null'::jsonb
      or job.intent_id is not null or job.dispatch_outcome is not null or previous->>'request_digest' is distinct from p_input->>'request_digest'
      or previous->>'receipt_id' is distinct from p_input->>'submit_receipt_id'
      or job.request_digest is distinct from p_input->>'request_digest' or job.receipt_id::text is distinct from p_input->>'submit_receipt_id' then
      raise exception 'storage_transition_conflict' using errcode='40001'; end if;
    update clued_private.storage_jobs_v1 set dispatch_outcome='{"status":"denied"}',dispatch_outcome_receipt_id=r.id
      where owner_id=u and job_id=job.job_id;
    insert into clued_private.storage_policy_transition_cancellations_v2 values(m.id,u,job.job_id,p_issuer_hash,r.id);
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',job.job_id));
    ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:transition_cancel_queued',refs,
      'project:'||p.project_id::text,null,jsonb_build_object('manifest_id',m.id,'job_id',job.job_id,'request_digest',job.request_digest,
      'submit_receipt_id',job.receipt_id,'outcome','denied','provider_requests',0),p_input->>'idempotency_key',r.request_sha256,
      'success','audit_only',array[m.evidence_id],'[]',null);
    result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}','{}',array[ev],array[m.evidence_id],null);
  else
    if inventory->>'scope_digest' is null or exists(select 1 from jsonb_array_elements(inventory->'root_connections') x
      where x->>'state'='revoked' or x->>'auth_mode'<>'legacy')
      or exists(select 1 from jsonb_array_elements(inventory->'root_denies') x where x->'lineage_id'='null'::jsonb and (x->>'denied')::boolean)
      or exists(select 1 from jsonb_array_elements(inventory->'clients') x where x->>'capability_id' is null
        or x->'registration_generation' is distinct from x->'capability_registration_generation') then
      raise exception 'storage_transition_denied' using errcode='42501'; end if;
    -- v12 reduce is NOT a storage revocation. Only original storage partial /
    -- revoke choices become a persistent root-specific lineage restriction.
    for item in select value->'payload' from jsonb_array_elements(m.manifest->'history_preimages') loop
      if item->>'action'='revoke_client' or (item->>'action'='grant_client'
        and not(item->'actions' @> '["inspect","create_file","create_topic"]'::jsonb)) then
        select (x->>'lineage_id')::uuid into lid from jsonb_array_elements(inventory->'clients') x
          where (x->>'binding_id')::uuid=(item->>'binding_id')::uuid;
        if lid is null then raise exception 'storage_transition_history_unproven' using errcode='42501'; end if;
        deny_lineages:=array_append(deny_lineages,lid);
      end if;
    end loop;
    for lid in select distinct x from unnest(deny_lineages) x order by x loop
      if not exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=u and provider=c.provider
        and provider_subject=c.provider_subject and root_folder_id=m.root_folder_id and lineage_id=lid) then
        insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id)
          values(u,c.provider,c.provider_subject,m.root_folder_id,lid,r.id);
      elsif exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=u and provider=c.provider
        and provider_subject=c.provider_subject and root_folder_id=m.root_folder_id and lineage_id=lid and not denied) then
        update clued_private.storage_root_denies_v2 set denied=true,generation=generation+1,receipt_id=r.id where owner_id=u
          and provider=c.provider and provider_subject=c.provider_subject and root_folder_id=m.root_folder_id and lineage_id=lid;
      end if;
    end loop;
    select coalesce(max(policy_generation),0)+1 into gen from clued_private.storage_account_policies_v2 where connection_id=c.id;
    policy_req:=jsonb_build_object('idempotency_key',m.id::text||':policy','manifest_id',m.id,'manifest_sha256',m.manifest_sha256,
      'connection_id',c.id,'policy_generation',gen,'source_decision_id',m.source_decision_id,'decision_version',m.decision_version,
      'scope_digest',inventory->>'scope_digest','disclosure_version',m.disclosure_version);
    policy_receipt:=clued_private.m1_begin_receipt(u,null,'storage_account_policy_activate',policy_req,clued_private.m1_sha256(policy_req));
    if policy_receipt.status<>'pending' then raise exception 'storage_transition_conflict' using errcode='40001'; end if;
    insert into clued_private.storage_account_policies_v2(owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,
      policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,activation_receipt_id,state)
      values(u,c.id,c.provider,c.provider_subject,m.root_folder_id,p.id,inventory->>'scope_digest',gen,m.source_decision_id,m.decision_version,
        'reviewed_transition',m.disclosure_version,r.id,policy_receipt.id,'active') returning * into policy;
    update clued_private.storage_connections_v1 set auth_mode='account_policy',auth_generation=auth_generation+1,
      account_policy_id=policy.id,version=version+1,receipt_id=r.id where id=c.id returning * into c;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',policy.id));
    policy_ev:=clued_private.m1_append_event_row(u,null,policy_receipt.id,policy_receipt.canonical_version,'extension:storage:account_policy_activate',
      refs,'project:'||p.project_id::text,null,policy_req-'idempotency_key',policy_req->>'idempotency_key',policy_receipt.request_sha256,
      'success','audit_only',array[m.evidence_id],'[]',null);
    perform clued_private.m1_finish_receipt(policy_receipt.id,'committed',refs,'{}',jsonb_build_object(policy.id::text,gen),array[policy_ev],array[m.evidence_id],null);
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id),jsonb_build_object('kind','system','role','source','id',policy.id));
    ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:policy_transition',refs,'project:'||p.project_id::text,null,
      jsonb_build_object('manifest_id',m.id,'manifest_sha256',m.manifest_sha256,'inventory_digest',m.inventory_digest,
        'terminal_jobs_digest',clued_private.m1_sha256(inventory->'jobs'),'old_auth_mode','legacy','auth_mode','account_policy',
        'auth_generation',c.auth_generation,'policy_id',policy.id,'policy_generation',gen,'policy_receipt_id',policy_receipt.id),
      p_input->>'idempotency_key',r.request_sha256,'success','audit_only',array[m.evidence_id],'[]',null);
    result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(c.id::text,c.version-1),
      jsonb_build_object(c.id::text,c.version,policy.id::text,gen),array[ev],array[m.evidence_id],null);
    insert into clued_private.storage_policy_transition_results_v2 values(m.id,p_issuer_hash,policy.id,r.id,policy_receipt.id);
  end if;
  perform clued_private.storage_owner_v1();
  if m.expires_at<=clock_timestamp() then raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  return result;
exception when others then
  get stacked diagnostics failure=message_text,code=returned_sqlstate;
  if failure in ('storage_transition_input_invalid','storage_transition_denied','storage_transition_conflict','storage_transition_review_required',
    'storage_transition_history_unproven','storage_transition_not_quiet','storage_root_has_unresolved_mutation',
    'storage_native_session_required','account_not_available','native_session_required') and code in ('22023','42501','40001','28000') then
    raise exception '%',failure using errcode=code; end if;
  raise exception 'storage_transition_denied' using errcode='42501';
end $$;

revoke all on function clued_private.storage_transition_immutable_v2(),
  clued_private.storage_policy_transition_inventory_v2(uuid,uuid,jsonb),
  clued_private.storage_transition_normalize_v2(uuid,jsonb),
  clued_private.storage_transition_replay_v2(uuid,text,jsonb),
  public.clued_storage_policy_transition_v2(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_policy_transition_v2(text,jsonb) to authenticated;

create function clued_private.storage_policy_transition_admin_v2(p_input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor clued_private.platform_admin_v13; evidence public.clued_evidence; r public.clued_audit_receipts;
  m clued_private.storage_policy_transition_manifests_v2; doc jsonb; raw text; digest text; inventory jsonb;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1; ev text; refs jsonb; result jsonb;
  failure text; code text;
begin
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.storage_policy_transition_admin_v2(jsonb)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['action','platform_admin_version','idempotency_key','evidence_id','evidence_sha256','manifest_json']<>'{}'
    or not(p_input ?& array['action','platform_admin_version','idempotency_key','evidence_id','evidence_sha256','manifest_json'])
    or p_input->>'action' is distinct from 'register' or jsonb_typeof(p_input->'manifest_json') is distinct from 'string'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or btrim(p_input->>'idempotency_key')<>p_input->>'idempotency_key'
    or jsonb_typeof(p_input->'platform_admin_version') is distinct from 'number'
    or p_input->>'platform_admin_version' !~ '^[1-9][0-9]{0,17}$' then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  raw:=p_input->>'manifest_json';
  if octet_length(convert_to(raw,'UTF8')) not between 2 and 1048576 then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  doc:=raw::jsonb;
  if jsonb_typeof(doc) is distinct from 'object' or
    doc-array['contract','owner_id','connection_id','source_decision_id','decision_version','disclosure_version','expires_at','expected_inventory_digest','history_preimages']<>'{}'
    or not(doc ?& array['contract','owner_id','connection_id','source_decision_id','decision_version','disclosure_version','expires_at','expected_inventory_digest','history_preimages'])
    or exists(select 1 from json_each(raw::json) group by key having count(*)>1)
    or doc->>'contract' is distinct from 'clued.storage-policy-transition/2'
    or doc->>'disclosure_version' is distinct from 'clued.storage-account-consent/2'
    or jsonb_typeof(doc->'decision_version') is distinct from 'number' or doc->>'decision_version' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(doc->'expires_at') is distinct from 'string'
    or jsonb_typeof(doc->'expected_inventory_digest') is distinct from 'string' or doc->>'expected_inventory_digest' !~ '^[0-9a-f]{64}$'
    or (doc->>'expires_at')::timestamptz<=clock_timestamp() or (doc->>'expires_at')::timestamptz>clock_timestamp()+interval '24 hours' then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  digest:=encode(extensions.digest(convert_to(raw,'UTF8'),'sha256'),'hex');
  if digest is distinct from p_input->>'evidence_sha256' then raise exception 'storage_transition_review_required' using errcode='42501'; end if;
  select * into actor from clued_private.platform_admin_v13 where singleton for share;
  if not found or actor.version is distinct from (p_input->>'platform_admin_version')::bigint then
    raise exception 'storage_platform_admin_required' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(actor.subject_id);
  perform pg_advisory_xact_lock(hashtextextended('storage-transition-admin:'||actor.subject_id::text||':'||(p_input->>'idempotency_key'),0));
  r:=clued_private.m1_begin_receipt(actor.subject_id,null,'storage_transition_manifest',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then return r.canonical_result; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('clued-evidence-withdrawal:'||actor.subject_id::text,0));
  select * into evidence from public.clued_evidence where id=(p_input->>'evidence_id')::uuid and user_id=actor.subject_id;
  if not found or evidence.content_hash is distinct from digest or evidence.mime_type is distinct from 'application/json'
    or evidence.evidence_type not in ('file','test_output') or evidence.size_bytes is distinct from octet_length(convert_to(raw,'UTF8'))::bigint
    or not exists(select 1 from public.clued_audit_receipts where id=evidence.receipt_id and user_id=actor.subject_id and status='committed')
    or exists(select 1 from clued_private.evidence_withdrawals where user_id=actor.subject_id and evidence_id=evidence.id) then
    raise exception 'storage_transition_review_required' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(doc->>'connection_id')::uuid and owner_id=(doc->>'owner_id')::uuid;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if p.id is null then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||p.root_folder_id,0));
  inventory:=clued_private.storage_policy_transition_inventory_v2(c.owner_id,c.id,doc->'history_preimages');
  if clued_private.m1_sha256(inventory) is distinct from doc->>'expected_inventory_digest'
    or inventory->'connection'->>'auth_mode' is distinct from 'legacy'
    or inventory->'connection'->>'state' is distinct from 'active' or inventory->>'scope_digest' is null then
    raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  perform 1 from public.clued_memories where id=(doc->>'source_decision_id')::uuid for share;
  if not exists(select 1 from public.clued_memories where id=(doc->>'source_decision_id')::uuid and version=(doc->>'decision_version')::bigint)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(doc->>'source_decision_id')::uuid) then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  insert into clued_private.storage_policy_transition_manifests_v2(owner_id,connection_id,root_folder_id,source_decision_id,decision_version,
    disclosure_version,manifest_sha256,manifest,inventory,inventory_digest,expires_at,evidence_id,registration_receipt_id)
    values(c.owner_id,c.id,p.root_folder_id,(doc->>'source_decision_id')::uuid,(doc->>'decision_version')::bigint,
      doc->>'disclosure_version',digest,doc,inventory,doc->>'expected_inventory_digest',(doc->>'expires_at')::timestamptz,evidence.id,r.id) returning * into m;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(actor.subject_id,null,r.id,r.canonical_version,'extension:storage:transition_manifest',refs,'global',null,
    jsonb_build_object('manifest_id',m.id,'manifest_sha256',digest,'inventory_digest',m.inventory_digest,'connection_id',m.connection_id,
      'platform_admin_version',actor.version,'operator_role',current_user,'activation',false),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only',array[evidence.id],'[]',null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}',jsonb_build_object(m.id::text,1),array[ev],array[evidence.id],null);
  perform clued_private.authorization_account_v12(actor.subject_id);
  if m.expires_at<=clock_timestamp() then raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  return result;
exception when others then
  get stacked diagnostics failure=message_text,code=returned_sqlstate;
  if failure in ('offline_database_operator_required','storage_platform_admin_required','account_not_available','storage_transition_input_invalid',
    'storage_transition_history_unproven','storage_transition_review_required','storage_transition_denied','storage_transition_conflict')
    and code in ('22023','42501','40001') then raise exception '%',failure using errcode=code; end if;
  raise exception 'storage_transition_denied' using errcode='42501';
end $$;
revoke all on function clued_private.storage_policy_transition_admin_v2(jsonb) from public,anon,authenticated,service_role;
