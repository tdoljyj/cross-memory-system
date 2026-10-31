-- Task 98dbf336-6831-416e-8a94-b36236f72726, approved detailed design v4.
-- Additive, prepared only. No node gateway, CI caller, role, runner or production activation.
-- Node signatures are verified by a future reviewed WebCrypto transport, never pgcrypto.

create table clued_private.ci_quota_counters_v1 (
  counter_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id), project_id uuid not null references public.clued_projects(id),
  row_kind text not null check(row_kind in ('pool_policy','repo_registration','usage_event')),
  repository_id bigint, repository_name text, registration_ref uuid,
  metric text not null, subject_key text not null, unit_key text not null,
  event_at timestamptz not null default clock_timestamp(), amount integer not null default 1 check(amount in (0,1)),
  policy jsonb, accepted_ref text, policy_version bigint not null default 1 check(policy_version>0),
  job_id uuid, lease_generation bigint, combination_sha256 text,
  authoritative boolean not null default false, receipt_id uuid,
  created_at timestamptz not null default clock_timestamp(), version bigint not null default 1,
  unique(user_id,project_id,counter_id),
  check(repository_id is null or repository_id>0),
  check(combination_sha256 is null or combination_sha256 ~ '^[0-9a-f]{64}$'),
  check((row_kind='pool_policy' and metric='policy' and policy is not null and repository_id is null and amount=0)
    or (row_kind='repo_registration' and metric='repository' and repository_id is not null
      and repository_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' and accepted_ref is not null and amount=0 and policy is null)
    or (row_kind='usage_event' and metric in ('execution_start','evaluation','PR_batch','head_release','stage8_retry','head_distinct_combination_24h')
      and policy is null and amount=1 and job_id is not null and lease_generation>0))
);
create unique index ci_pool_policy_unique_v1 on clued_private.ci_quota_counters_v1(user_id,project_id) where row_kind='pool_policy';
create unique index ci_repo_registration_unique_v1 on clued_private.ci_quota_counters_v1(user_id,repository_id) where row_kind='repo_registration';
create unique index ci_quota_event_unique_v1 on clued_private.ci_quota_counters_v1(user_id,project_id,metric,subject_key,unit_key) where row_kind='usage_event';
create index ci_quota_window_v1 on clued_private.ci_quota_counters_v1(user_id,project_id,metric,subject_key,event_at) where row_kind='usage_event';

create table clued_private.ci_nodes_v1 (
  node_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id), project_id uuid not null references public.clued_projects(id),
  binding_id uuid not null references public.clued_agent_bindings(id), binding_generation bigint not null default 1,
  name text not null check(length(name) between 1 and 100),
  profile jsonb not null check(jsonb_typeof(profile)='object' and octet_length(profile::text)<=32768),
  profile_sha256 text not null check(profile_sha256 ~ '^[0-9a-f]{64}$'), profile_version bigint not null default 1,
  identity_public_jwk jsonb not null, encryption_public_jwk jsonb not null,
  identity_fingerprint text not null check(identity_fingerprint ~ '^[0-9a-f]{64}$'),
  encryption_fingerprint text not null check(encryption_fingerprint ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check(state in ('pending','active','draining','retired','revoked')),
  qualification_digest text check(qualification_digest ~ '^[0-9a-f]{64}$'),
  qualification_source text check(qualification_source ~ '^[0-9a-f]{40}$'),
  qualification_status text not null default 'unverified' check(qualification_status in ('unverified','verified','expired')),
  qualification_verified_at timestamptz, qualification_expires_at timestamptz,
  qualification_receipt_ref text, owner_approval_ref text, approved_manifest_sha256 text, approved_manifest_version bigint,
  publisher_requested boolean not null default false, scan_signing_requested boolean not null default false,
  publisher_approved boolean not null default false, scan_signing_approved boolean not null default false,
  hardening_observed boolean not null default false, preference text not null default 'primary' check(preference in ('primary','relay','overflow')),
  exclusions jsonb not null default '[]', last_heartbeat_at timestamptz, heartbeat_sequence bigint not null default 0,
  clock_skew_ms bigint, eligible_until timestamptz, connection_expires_at timestamptz,
  registration_digest text not null, idempotency_key text not null,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  version bigint not null default 1 check(version>0), receipt_id uuid,
  unique(user_id,project_id,node_id), unique(user_id,project_id,identity_fingerprint),
  unique(user_id,project_id,idempotency_key),
  check((qualification_status='verified')=(qualification_verified_at is not null)),
  check(not (identity_public_jwk ? 'd') and not (encryption_public_jwk ? 'd'))
);
create unique index ci_node_binding_live_v1 on clued_private.ci_nodes_v1(user_id,project_id,binding_id) where state not in ('retired','revoked');

create table clued_private.ci_jobs_v1 (
  job_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  registration_ref uuid not null, repository_id bigint not null, repository_name text not null,
  job_key_sha256 text not null check(job_key_sha256 ~ '^[0-9a-f]{64}$'),
  kind text not null check(kind in ('combination_execution','delegated_scan','control','maintenance','publication','github_f_pr')),
  task_id uuid not null, claim_id uuid not null, claim_fence bigint not null check(claim_fence>0), execution_epoch bigint not null check(execution_epoch>0), copy_index integer,
  target_branch text not null check(length(target_branch) between 1 and 200 and target_branch !~ '[[:space:]]'), workflow text,
  head_authorization_id uuid not null references clued_private.work_claim_head_authorizations_v1(authorization_id),
  admission_id uuid not null references clued_private.work_claim_execution_admissions_v1(admission_id),
  pr_ref text not null, head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
  base_sha text not null check(base_sha ~ '^[0-9a-f]{40}$'), test_sha text not null check(test_sha ~ '^[0-9a-f]{40}$'),
  source_sha text not null check(source_sha ~ '^[0-9a-f]{40}$'), combination_sha256 text not null check(combination_sha256 ~ '^[0-9a-f]{64}$'),
  combination_mode text not null default 'depth1' check(combination_mode in ('depth1','depth2','depth3','preview')),
  role text not null, attempt integer not null default 1 check(attempt in (1,2)), contract_version text not null default 'clued.ci-job.v1',
  parent_job_id uuid, parent_lease_generation bigint, state text not null default 'queued'
    check(state in ('queued','leased','started','observed','result_ready','publication_pending','completed','failed','canceled','invalidated','uncertain')),
  origin text not null default 'queued' check(origin in ('queued','backoff-retry','restored','waiting-retry','new-trigger','handover')),
  priority integer not null default 1 check(priority between 0 and 4), policy_version bigint not null default 1,
  required_environment text not null default 'E1-Linux', required_memory_mb integer not null default 0 check(required_memory_mb>=0),
  stage8_try integer not null default 0, stage8_limit integer not null default 1 check(stage8_limit>0),
  current_generation bigint not null default 0, admission_publication jsonb, requested_node_id uuid,
  eligible_after timestamptz not null default clock_timestamp(), created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), version bigint not null default 1, receipt_id uuid,
  unique(user_id,project_id,job_id), unique(user_id,project_id,job_key_sha256),
  foreign key(user_id,project_id,registration_ref) references clued_private.ci_quota_counters_v1(user_id,project_id,counter_id)
);
create index ci_jobs_queue_v1 on clued_private.ci_jobs_v1(user_id,project_id,state,priority,eligible_after,created_at);

create table clued_private.ci_job_leases_v1 (
  user_id uuid not null, project_id uuid not null, job_id uuid not null, generation bigint not null check(generation>0),
  holder_node_id uuid not null, holder_binding_id uuid not null, lease_version bigint not null default 1 check(lease_version>0),
  state text not null default 'current' check(state in ('current','released','expired','revoked')),
  issued_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
  reservation_at timestamptz not null default clock_timestamp(), origin text not null, started_at timestamptz,
  terminal_at timestamptz, terminal_reason text, terminal_class text, terminal_breaker_state text,
  classification_verified boolean not null default false, progress_digest text, receipt_id uuid, started_receipt_id uuid, terminal_receipt_id uuid,
  primary key(user_id,project_id,job_id,generation),
  foreign key(user_id,project_id,job_id) references clued_private.ci_jobs_v1(user_id,project_id,job_id),
  foreign key(user_id,project_id,holder_node_id) references clued_private.ci_nodes_v1(user_id,project_id,node_id),
  check(expires_at>issued_at)
);
create unique index ci_job_lease_current_v1 on clued_private.ci_job_leases_v1(job_id) where state='current';

create table clued_private.ci_publish_keys_v1 (
  key_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  registration_ref uuid not null, repository_id bigint not null, head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
  check_name text not null check(check_name in ('gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot')),
  app_id bigint not null check(app_id=5368905), job_id uuid not null, publisher_node_id uuid not null,
  execution_generation bigint not null, train_generation bigint, request_digest text not null,
  external_id text not null unique, state text not null default 'reserved' check(state in ('reserved','posted','unknown')),
  reserved_at timestamptz not null default clock_timestamp(), landing_deadline_at timestamptz not null,
  check_run_id bigint, posted_at timestamptz, observation_1_at timestamptz, observation_2_at timestamptz,
  observation_digest text, receipt_id uuid,
  unique(user_id,repository_id,head_sha,check_name,app_id), unique(user_id,project_id,key_id),
  foreign key(user_id,project_id,job_id) references clued_private.ci_jobs_v1(user_id,project_id,job_id),
  foreign key(user_id,project_id,publisher_node_id) references clued_private.ci_nodes_v1(user_id,project_id,node_id)
);
create table clued_private.ci_exec_keys_v1 (
  key_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  repository_id bigint not null, key_kind text not null check(key_kind in ('head','combination')),
  head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'), combination_sha256 text,
  source_sha text, attempt integer, semantic_scope text not null, node_id uuid, job_id uuid not null,
  lease_generation bigint not null, burned_at timestamptz not null default clock_timestamp(), receipt_id uuid,
  foreign key(user_id,project_id,job_id) references clued_private.ci_jobs_v1(user_id,project_id,job_id),
  check((key_kind='head' and semantic_scope ~ '^(pool_enforced|resident_mirror:[0-9a-f-]{36})$')
    or (key_kind='combination' and combination_sha256 ~ '^[0-9a-f]{64}$' and source_sha ~ '^[0-9a-f]{40}$' and attempt in (1,2)))
);
create unique index ci_exec_head_unique_v1 on clued_private.ci_exec_keys_v1(user_id,repository_id,head_sha,semantic_scope) where key_kind='head';
create unique index ci_exec_combination_unique_v1 on clued_private.ci_exec_keys_v1(user_id,repository_id,head_sha,combination_sha256,source_sha,attempt) where key_kind='combination';

create table clued_private.ci_train_lease_v1 (
  user_id uuid not null, project_id uuid not null, generation bigint not null default 0, lease_version bigint not null default 1,
  request_job_id uuid references clued_private.ci_jobs_v1(job_id),
  holder_node_id uuid, holder_binding_id uuid, state text not null default 'unheld'
    check(state in ('unheld','pending_activation','sweep_required','active','silence')),
  issued_at timestamptz, expires_at timestamptz, ended_at timestamptz, silence_until timestamptz,
  last_holder_node_id uuid, last_lost_at timestamptz, sweep_state text not null default 'incomplete',
  sweep_generation bigint, sweep_evidence_digest text, receipt_id uuid, primary key(user_id,project_id)
);
create table clued_private.ci_train_front_v1 (
  user_id uuid not null, repository_id bigint not null, project_id uuid not null, registration_ref uuid not null,
  front_version bigint not null default 1, train_generation bigint, state text not null default 'prepared'
    check(state in ('prepared','empty','front','parked','halted')),
  head_job_id uuid, head_sha text, base_sha text, test_sha text, combination_sha256 text,
  ordered_parent_commits jsonb, tree_oid text, claim_id uuid, claim_fence bigint, execution_epoch bigint,
  front_observed_at timestamptz, sweep_watermark jsonb, receipt_id uuid,
  primary key(user_id,repository_id),
  foreign key(user_id,project_id,registration_ref) references clued_private.ci_quota_counters_v1(user_id,project_id,counter_id)
);
create table clued_private.ci_green_ledger_v1 (
  entry_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  repository_id bigint not null, head_sha text not null, publish_key_id uuid not null unique,
  job_id uuid not null, check_run_id bigint, publisher_node_id uuid not null, train_generation bigint,
  state text not null check(state in ('proposed','posted','unknown','abandoned','revoke_requested','revoke_confirmed','merged')),
  state_version bigint not null default 1, external_id text not null, landing_deadline_at timestamptz not null,
  evidence_digest text, observed_main_sha text, ancestor_evidence_digest text,
  observation_1_at timestamptz, observation_2_at timestamptz, revoke_requested_at timestamptz,
  chain_version text, chain_sequence bigint, prev_hash text, row_signature text,
  created_at timestamptz not null default clock_timestamp(), receipt_id uuid,
  foreign key(user_id,project_id,publish_key_id) references clued_private.ci_publish_keys_v1(user_id,project_id,key_id)
);
create index ci_green_blockers_v1 on clued_private.ci_green_ledger_v1(user_id,repository_id,state);
create table clued_private.ci_nonce_ledger_v1 (
  nonce_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  nonce_hash text not null unique check(nonce_hash ~ '^[0-9a-f]{64}$'), purpose text not null,
  subject_digest text not null, node_id uuid not null, key_fingerprint text not null,
  job_id uuid, execution_generation bigint, train_generation bigint,
  issued_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
  consumed_at timestamptz, request_digest text, consume_receipt_id uuid,
  check(expires_at>issued_at and expires_at<=issued_at+interval '1 hour'),
  check((consumed_at is null)=(request_digest is null))
);
create table clued_private.ci_result_index_v1 (
  result_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  job_id uuid not null, execution_generation bigint not null, producer_node_id uuid not null,
  result_kind text not null, result_digest text not null check(result_digest ~ '^[0-9a-f]{64}$'),
  certificate_digest text not null, signature_envelope jsonb not null check(octet_length(signature_envelope::text)<=16384),
  source_sha text not null, combination_sha256 text not null, qualification_ref text not null,
  scanner_digest text, rules_digest text, vulnerability_db_digest text, db_updated_at timestamptz, db_next_update timestamptz,
  produced_at timestamptz not null, expires_at timestamptz not null,
  state text not null default 'available' check(state in ('available','invalidated','expired','producer_unavailable')), receipt_id uuid,
  unique(job_id,execution_generation,producer_node_id,result_kind,result_digest),
  foreign key(user_id,project_id,job_id) references clued_private.ci_jobs_v1(user_id,project_id,job_id),
  check(expires_at>produced_at and expires_at<=produced_at+interval '6 hours')
);
create table clued_private.ci_sealed_drop_v1 (
  drop_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, project_id uuid not null,
  request_group_id uuid not null, request_digest text not null, purpose text not null,
  sender_node_id uuid not null, recipient_node_id uuid not null, recipient_fingerprint text not null,
  job_id uuid not null, execution_generation bigint not null, train_generation bigint,
  ciphertext bytea, ciphertext_sha256 text not null, crypto_envelope_version text not null,
  state text not null default 'pending' check(state in ('pending','consumed','expired')),
  claimed_by uuid, claim_receipt_id uuid, receipt_id uuid, created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
  unique(user_id,request_group_id,recipient_node_id),
  foreign key(user_id,project_id,job_id) references clued_private.ci_jobs_v1(user_id,project_id,job_id),
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour'),
  check((state='pending')=(ciphertext is not null)), check(octet_length(ciphertext)<=65536)
);

-- No direct table access. Core functions remain ungranted; their owner is the
-- trusted database boundary, not a node or an authenticated API caller.
do $acl$ declare n text; begin
  foreach n in array array['ci_quota_counters_v1','ci_nodes_v1','ci_jobs_v1','ci_job_leases_v1',
    'ci_publish_keys_v1','ci_exec_keys_v1','ci_train_lease_v1','ci_train_front_v1','ci_green_ledger_v1',
    'ci_nonce_ledger_v1','ci_result_index_v1','ci_sealed_drop_v1'] loop
    execute format('alter table clued_private.%I enable row level security',n);
    execute format('revoke all on clued_private.%I from public,anon,authenticated,service_role,clued_worker_gateway',n);
  end loop;
end $acl$;

create function clued_private.ci_input_v1(p jsonb, allowed text[], required text[] default '{}', cap integer default 65536)
returns void language plpgsql immutable set search_path='' as $$ declare field text; begin
  if p is null or jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>cap
    or p-allowed<>'{}'::jsonb or not (p ?& required)
    or exists(select 1 from unnest(required) k where p->k='null'::jsonb) then raise exception 'CI_INPUT_INVALID' using errcode='22023'; end if;
  foreach field in array array['project_id','node_id','binding_id','name','profile_sha256','qualification_digest','qualification_source','idempotency_key',
    'action','accepted_ref','confirmation_token','view_digest','target_branch','pr_ref','kind','claim_id','task_id','head_authorization_id','admission_id',
    'head_sha','base_sha','test_sha','source_sha','combination_sha256','role','origin','required_environment'] loop
    if p ? field and jsonb_typeof(p->field) is distinct from 'string' then raise exception 'CI_INPUT_INVALID' using errcode='22023'; end if;
  end loop;
end $$;
create function clued_private.ci_public_metadata_v1(p jsonb) returns void language plpgsql immutable set search_path='' as $$ begin
  if p::text ~* '(-----BEGIN[^-]*PRIVATE KEY-----|Bearer[[:space:]]|ghp_|gho_|github_pat_|postgres(ql)?://[^/@:]+:[^/@]+@)' then
    raise exception 'CI_PUBLIC_METADATA_INVALID' using errcode='22023'; end if;
end $$;
create function clued_private.ci_native_owner_v1(p_write boolean,p_project uuid,p_binding uuid default null)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=clued_private.authorization_writer_storage_native_hint_v2(); sid uuid;
begin
  if p_write then
    perform clued_private.authorization_writer_guard_v2(u);
    if p_binding is not null then perform clued_private.authorization_writer_lock_binding_v2(u,p_binding); end if;
  end if;
  u:=clued_private.authorization_owner_v12(); sid:=clued_private.native_session_id_v1()::uuid;
  perform 1 from auth.sessions s where s.id=sid and s.user_id=u
    and (to_jsonb(s)->>'not_after' is null or (to_jsonb(s)->>'not_after')::timestamptz>clock_timestamp()) for share;
  if not found then raise exception 'CI_NATIVE_SESSION_REQUIRED' using errcode='42501'; end if;
  if not clued_private.native_session_fresh_v1() then raise exception 'reauthentication_required' using errcode='42501'; end if;
  perform 1 from public.clued_projects x where x.id=p_project and x.user_id=u
    and x.merged_into_project_id is null and x.dismissed_at is null for share;
  if not found then raise exception 'CI_PROJECT_UNAVAILABLE' using errcode='42501'; end if;
  perform clued_private.project_effective_active_v2(u,p_project);
  return u;
end $$;
create function clued_private.ci_native_recheck_v1(u uuid,sid text) returns void
language plpgsql volatile security definer set search_path='' as $$ begin
  if auth.uid() is distinct from u or clued_private.native_session_id_v1() is distinct from sid
    or nullif(auth.jwt()->>'client_id','') is not null or not clued_private.native_session_fresh_v1()
    or not exists(select 1 from auth.sessions s where s.id=sid::uuid and s.user_id=u
      and (to_jsonb(s)->>'not_after' is null or (to_jsonb(s)->>'not_after')::timestamptz>clock_timestamp())) then
    raise exception 'CI_NATIVE_SESSION_REQUIRED' using errcode='42501'; end if;
end $$;
create function clued_private.ci_receipt_v1(u uuid,p uuid,op text,obj text,meta jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$ declare r uuid; begin
  insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata)
    values(u,'project:'||p,op,'ci_scheduling',obj,1,meta) returning id into r;
  return r;
end $$;
create function clued_private.ci_policy_v1(u uuid,p uuid) returns clued_private.ci_quota_counters_v1
language plpgsql volatile security definer set search_path='' as $$ declare x clued_private.ci_quota_counters_v1; begin
  perform pg_advisory_xact_lock(hashtextextended('ci-pool:'||u||':'||p,0));
  select * into x from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='pool_policy' for update;
  if not found then
    insert into clued_private.ci_quota_counters_v1(user_id,project_id,row_kind,metric,subject_key,unit_key,amount,policy)
      values(u,p,'pool_policy','policy','pool','policy',0,
        '{"mode":"prepared","status":"UNCONFIGURED","phase":1,"limits":null,"signature_gateway_active":false}'::jsonb) returning * into x;
  end if; return x;
end $$;
create function clued_private.ci_repo_v1(u uuid,p uuid,repo bigint) returns clued_private.ci_quota_counters_v1
language plpgsql volatile security definer set search_path='' as $$ declare x clued_private.ci_quota_counters_v1; begin
  perform pg_advisory_xact_lock(hashtextextended('ci-repo:'||u||':'||repo,0));
  select * into x from clued_private.ci_quota_counters_v1 where user_id=u and repository_id=repo and row_kind='repo_registration' for update;
  if not found or x.project_id<>p then raise exception 'CI_REPOSITORY_POOL_MISMATCH' using errcode='42501'; end if;
  if not exists(select 1 from public.clued_projects pr where pr.id=p and pr.user_id=u and pr.merged_into_project_id is null
    and pr.dismissed_at is null and coalesce(pr.lifecycle_status,'active')='active' and clued_private.project_is_recognized_v2(u,p)) then
    raise exception 'CI_PROJECT_UNAVAILABLE' using errcode='42501'; end if;
  return x;
end $$;

create function clued_private.ci_permanent_guard_v1() returns trigger language plpgsql set search_path='' as $$ begin
  if tg_op='DELETE' then raise exception 'CI_PERMANENT_HISTORY' using errcode='55000'; end if;
  if tg_table_name='ci_quota_counters_v1' then
    if old.row_kind in ('repo_registration','usage_event') and to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'CI_IMMUTABLE_FACT' using errcode='55000'; end if;
  elsif tg_table_name='ci_exec_keys_v1' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'CI_IMMUTABLE_FACT' using errcode='55000';
  elsif tg_table_name='ci_publish_keys_v1' then
    if (to_jsonb(new)-array['state','check_run_id','posted_at','observation_1_at','observation_2_at','observation_digest','receipt_id'])
      is distinct from (to_jsonb(old)-array['state','check_run_id','posted_at','observation_1_at','observation_2_at','observation_digest','receipt_id'])
      or old.state='posted' and new.state<>'posted' then raise exception 'CI_PERMANENT_PUBLICATION_KEY' using errcode='55000'; end if;
  end if; return new;
end $$;
create trigger ci_quota_history_guard_v1 before update or delete on clued_private.ci_quota_counters_v1 for each row execute function clued_private.ci_permanent_guard_v1();
create trigger ci_exec_history_guard_v1 before update or delete on clued_private.ci_exec_keys_v1 for each row execute function clued_private.ci_permanent_guard_v1();
create trigger ci_publish_history_guard_v1 before update or delete on clued_private.ci_publish_keys_v1 for each row execute function clued_private.ci_permanent_guard_v1();

create function clued_private.ci_jwk_v1(k jsonb) returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(k)='object' and k-array['kty','crv','x','y']='{}'::jsonb
    and k->>'kty'='EC' and k->>'crv'='P-256' and jsonb_typeof(k->'x')='string' and jsonb_typeof(k->'y')='string' and k->>'x' ~ '^[A-Za-z0-9_-]{43}$'
    and k->>'y' ~ '^[A-Za-z0-9_-]{43}$' and not (k ? 'd'),false)
$$;
create function clued_private.ci_jwk_fingerprint_v1(k jsonb) returns text language plpgsql immutable set search_path='' as $$ begin
  if not clued_private.ci_jwk_v1(k) then raise exception 'CI_PUBLIC_KEY_INVALID' using errcode='22023'; end if;
  return encode(extensions.digest(convert_to(format('{"crv":"P-256","kty":"EC","x":"%s","y":"%s"}',k->>'x',k->>'y'),'UTF8'),'sha256'),'hex');
end $$;
create function clued_private.ci_profile_v1(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$ declare k text; a jsonb; begin
  if jsonb_typeof(p) is distinct from 'object' or p-array['schema','site_id','environment_kinds','slot_count','memory_limit_mb','identity_key_origin','capabilities','exclusions']<>'{}'::jsonb
    or jsonb_typeof(p->'slot_count') is distinct from 'number' or coalesce(p->>'slot_count','') !~ '^[1-9][0-9]*$' or (p->>'slot_count')::numeric>64 then return false; end if;
  if p ? 'schema' and (jsonb_typeof(p->'schema') is distinct from 'string' or p->>'schema'<>'clued.ci-node-profile/1') then return false; end if;
  if p ? 'site_id' and (jsonb_typeof(p->'site_id') is distinct from 'string' or p->>'site_id' !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') then return false; end if;
  if p ? 'memory_limit_mb' and (jsonb_typeof(p->'memory_limit_mb') is distinct from 'number' or coalesce(p->>'memory_limit_mb','') !~ '^[0-9]{1,7}$' or (p->>'memory_limit_mb')::numeric>1048576) then return false; end if;
  if p ? 'identity_key_origin' and (jsonb_typeof(p->'identity_key_origin') is distinct from 'string' or p->>'identity_key_origin' not in ('tpm','software')) then return false; end if;
  foreach k in array array['environment_kinds','capabilities','exclusions'] loop
    if p ? k then
      a:=p->k; if jsonb_typeof(a) is distinct from 'array' then return false; end if;
      if jsonb_array_length(a)>(case when k='environment_kinds' then 4 else 16 end) or k='environment_kinds' and jsonb_array_length(a)=0
        or (select count(*)<>count(distinct x) from jsonb_array_elements(a)x) then return false; end if;
      if exists(select 1 from jsonb_array_elements(a)x where jsonb_typeof(x)<>'string' or
        (k='environment_kinds' and x#>>'{}' not in ('E1-Linux','E1-Windows','E4-Windows-Sandbox','hardened-Windows')) or
        (k<>'environment_kinds' and x#>>'{}' not in ('linux','windows','docker','hyper-v','windows-sandbox','scan','publish','control','relay','f-pr'))) then return false; end if;
    end if;
  end loop; return true;
end $$;
create function clued_private.ci_node_view_v1(n clued_private.ci_nodes_v1) returns jsonb
language sql stable set search_path='' as $$ select to_jsonb(n)-array['registration_digest','idempotency_key'] $$;
create function clued_private.ci_pool_view_v1(u uuid,p uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select policy||jsonb_build_object('version',version,
    'repositories',coalesce((select jsonb_agg(jsonb_build_object('id',q.repository_id,'name',q.repository_name,'registration_ref',q.counter_id))
      from clued_private.ci_quota_counters_v1 q where q.user_id=u and q.project_id=p and q.row_kind='repo_registration'),'[]'::jsonb))
    from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='pool_policy'),
    '{"mode":"prepared","status":"UNCONFIGURED","phase":1,"limits":null,"version":0,"repositories":[]}'::jsonb)
$$;
create function public.clued_ci_nodes_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare u uuid; p uuid; begin
  perform clued_private.ci_input_v1(p_input,array['project_id'],array['project_id']); p:=(p_input->>'project_id')::uuid;
  u:=clued_private.ci_native_owner_v1(false,p);
  return jsonb_build_object('status','ok','mode','prepared','observed_at',clock_timestamp(),
    'nodes',coalesce((select jsonb_agg(clued_private.ci_node_view_v1(n) order by n.created_at,n.node_id)
      from clued_private.ci_nodes_v1 n where n.user_id=u and n.project_id=p),'[]'::jsonb),
    'pool',clued_private.ci_pool_view_v1(u,p),'bindings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'agent_name',b.agent_name))
      from public.clued_agent_bindings b where b.user_id=u and clued_private.binding_live_v1(b)
        and 'context:read'=any(b.scopes)),'[]'::jsonb));
end $$;
create function public.clued_ci_node_registration_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; p uuid; b public.clued_agent_bindings; n clued_private.ci_nodes_v1; d text; r uuid; sid text;
begin
  perform clued_private.ci_input_v1(p_input,array['project_id','node_id','binding_id','name','profile','profile_sha256',
    'identity_public_jwk','encryption_public_jwk','qualification_digest','qualification_source',
    'publisher_requested','scan_signing_requested','idempotency_key'],
    array['project_id','binding_id','name','profile','profile_sha256','identity_public_jwk','encryption_public_jwk','idempotency_key']);
  p:=(p_input->>'project_id')::uuid; u:=clued_private.ci_native_owner_v1(true,p,(p_input->>'binding_id')::uuid);
  sid:=clued_private.native_session_id_v1();
  select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=u;
  if not found or not clued_private.binding_live_v1(b) or not ('context:read'=any(b.scopes)) then
    raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  if p_input::text ~* '(-----BEGIN[^-]*PRIVATE KEY-----|Bearer[[:space:]]|ghp_|gho_|github_pat_|postgres(ql)?://[^/@:]+:[^/@]+@)'
    or not clued_private.ci_profile_v1(p_input->'profile')
    or jsonb_typeof(p_input->'profile_sha256') is distinct from 'string'
    or not clued_private.ci_jwk_v1(p_input->'identity_public_jwk') or not clued_private.ci_jwk_v1(p_input->'encryption_public_jwk')
    or p_input->'identity_public_jwk'=p_input->'encryption_public_jwk'
    or jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 100
    or jsonb_typeof(p_input->'idempotency_key')<>'string' or length(p_input->>'idempotency_key') not between 1 and 120
    or p_input ? 'publisher_requested' and jsonb_typeof(p_input->'publisher_requested')<>'boolean'
    or p_input ? 'scan_signing_requested' and jsonb_typeof(p_input->'scan_signing_requested')<>'boolean' then
    raise exception 'CI_REGISTRATION_INVALID' using errcode='22023'; end if;
  d:=clued_private.m1_sha256(p_input);
  perform pg_advisory_xact_lock(hashtextextended('ci-registration:'||u||':'||p||':'||(p_input->>'idempotency_key'),0));
  select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and idempotency_key=p_input->>'idempotency_key';
  if found then
    if n.registration_digest<>d then raise exception 'CI_IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
    return jsonb_build_object('status','committed','replayed',true,'node_id',n.node_id,'version',n.version,'state',n.state,'receipt_id',n.receipt_id);
  end if;
  perform clued_private.ci_native_recheck_v1(u,sid);
  insert into clued_private.ci_nodes_v1(node_id,user_id,project_id,binding_id,name,profile,profile_sha256,
    identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,
    qualification_digest,qualification_source,publisher_requested,scan_signing_requested,
    connection_expires_at,registration_digest,idempotency_key)
  values(coalesce((p_input->>'node_id')::uuid,extensions.gen_random_uuid()),u,p,b.id,btrim(p_input->>'name'),p_input->'profile',p_input->>'profile_sha256',
    p_input->'identity_public_jwk',p_input->'encryption_public_jwk',clued_private.ci_jwk_fingerprint_v1(p_input->'identity_public_jwk'),clued_private.ci_jwk_fingerprint_v1(p_input->'encryption_public_jwk'),
    p_input->>'qualification_digest',p_input->>'qualification_source',coalesce((p_input->>'publisher_requested')::boolean,false),
    coalesce((p_input->>'scan_signing_requested')::boolean,false),b.expires_at,d,p_input->>'idempotency_key') returning * into n;
  r:=clued_private.ci_receipt_v1(u,p,'ci_node_register',n.node_id::text,jsonb_build_object('state','pending','registration_digest',d));
  update clued_private.ci_nodes_v1 set receipt_id=r where node_id=n.node_id;
  return jsonb_build_object('status','committed','replayed',false,'node_id',n.node_id,'version',n.version,'state',n.state,'receipt_id',r);
end $$;

create function clued_private.ci_confirmation_view_v1(u uuid,p uuid,kind text,choices jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare n clued_private.ci_nodes_v1; b public.clued_agent_bindings; v jsonb;
begin
  if kind='ci_node' then
    select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=(choices->>'node_id')::uuid;
    if not found then raise exception 'CI_NODE_NOT_FOUND' using errcode='42501'; end if;
    select * into b from public.clued_agent_bindings where id=n.binding_id and user_id=u;
    v:=jsonb_build_object('node',clued_private.ci_node_view_v1(n),'binding_live',coalesce(clued_private.binding_live_v1(b),false));
  else v:=jsonb_build_object('pool',clued_private.ci_pool_view_v1(u,p)); end if;
  return v||jsonb_build_object('project_id',p,'choices',choices,
    'project_version',(select version from public.clued_projects where id=p and user_id=u));
end $$;
create function clued_private.ci_issue_v1(u uuid,p uuid,kind text,choices jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare view jsonb; d text; raw text; tid uuid; tnow timestamptz:=clock_timestamp(); subject text;
begin
  subject:=case when kind='ci_node' then choices->>'node_id' else p::text end;
  perform pg_advisory_xact_lock(hashtextextended('ci-confirm:'||u||':'||kind||':'||subject,0));
  view:=clued_private.ci_confirmation_view_v1(u,p,kind,choices); d:=clued_private.m1_sha256(view);
  update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp() where user_id=u and action=kind
    and subject_key=subject and consumed_at is null and revoked_at is null;
  raw:='clued_ci_'||encode(extensions.gen_random_bytes(32),'hex');
  insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,confirmation_view,
    view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
  values(u,kind,subject,(choices->>'base_version')::bigint,choices||jsonb_build_object('project_id',p),view,d,
    encode(extensions.digest(convert_to(raw,'UTF8'),'sha256'),'hex'),clued_private.native_session_id_v1(),clued_private.native_auth_time_v1(),tnow,tnow+interval '5 minutes') returning id into tid;
  return jsonb_build_object('status','issued','confirmation_token',raw,'view_digest',d,'confirmation_view',view,'expires_at',tnow+interval '5 minutes','token_id',tid);
end $$;
create function public.clued_ci_node_confirmation_issue_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare u uuid; p uuid; n clued_private.ci_nodes_v1; begin
  perform clued_private.ci_input_v1(p_input,array['project_id','node_id','base_version','action','accepted_ref'],array['project_id','node_id','base_version','action']);
  perform clued_private.ci_public_metadata_v1(p_input);
  p:=(p_input->>'project_id')::uuid;
  if jsonb_typeof(p_input->'base_version') is distinct from 'number' or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]*$' then raise exception 'CI_STALE_VERSION' using errcode='22023'; end if;
  select * into n from clued_private.ci_nodes_v1 where node_id=(p_input->>'node_id')::uuid and project_id=p and user_id=auth.uid();
  if not found then raise exception 'CI_NODE_NOT_FOUND' using errcode='42501'; end if;
  u:=clued_private.ci_native_owner_v1(true,p,n.binding_id);
  select * into n from clued_private.ci_nodes_v1 where node_id=n.node_id for update;
  if n.version<>(p_input->>'base_version')::bigint then raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  if p_input->>'action' not in ('approve','drain','retire','revoke','qualify') then raise exception 'CI_NODE_ACTION_INVALID' using errcode='22023'; end if;
  if p_input->>'action'='qualify' then raise exception 'SIGNATURE_GATEWAY_NOT_ACTIVATED' using errcode='42501'; end if;
  if n.state='revoked' or p_input->>'action'='approve' and n.state<>'pending'
    or p_input->>'action'='drain' and n.state<>'active'
    or p_input->>'action'='retire' and n.state<>'draining' then raise exception 'CI_NODE_TRANSITION_INVALID' using errcode='22023'; end if;
  if p_input->>'action'='approve' and nullif(btrim(p_input->>'accepted_ref'),'') is null then raise exception 'CI_ACCEPTANCE_REF_REQUIRED' using errcode='22023'; end if;
  return clued_private.ci_issue_v1(u,p,'ci_node',p_input-'project_id');
end $$;
create function public.clued_ci_pool_confirmation_issue_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare u uuid; p uuid; q clued_private.ci_quota_counters_v1; k text; begin
  perform clued_private.ci_input_v1(p_input,array['project_id','base_version','repository','limits','accepted_ref'],array['project_id','base_version']);
  perform clued_private.ci_public_metadata_v1(p_input);
  p:=(p_input->>'project_id')::uuid; u:=clued_private.ci_native_owner_v1(true,p);
  if jsonb_typeof(p_input->'base_version') is distinct from 'number' or coalesce(p_input->>'base_version','') !~ '^[0-9]+$' then raise exception 'CI_STALE_VERSION' using errcode='22023'; end if;
  if p_input ? 'repository' then
    perform clued_private.ci_input_v1(p_input->'repository',array['id','name'],array['id','name']);
    if (p_input->'repository'->>'id')::bigint<=0 or p_input->'repository'->>'name' !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then
      raise exception 'CI_REPOSITORY_INVALID' using errcode='22023'; end if;
  end if;
  if p_input ? 'limits' and p_input->'limits'<>'null'::jsonb then
    perform clued_private.ci_input_v1(p_input->'limits',array['execution_start','evaluation','PR_batch','head_release','stage8_retry','head_distinct_combination_24h'],
      array['execution_start','evaluation','PR_batch','head_release','stage8_retry','head_distinct_combination_24h']);
    for k in select jsonb_object_keys(p_input->'limits') loop
      if jsonb_typeof(p_input->'limits'->k)<>'number' or p_input->'limits'->>k !~ '^[0-9]{1,7}$'
        or (p_input->'limits'->>k)::integer>1000000 then raise exception 'CI_QUOTA_LIMIT_INVALID' using errcode='22023'; end if;
    end loop;
  end if;
  if (p_input ? 'repository' or p_input ? 'limits' and p_input->'limits'<>'null'::jsonb)
    and nullif(btrim(p_input->>'accepted_ref'),'') is null then raise exception 'CI_ACCEPTANCE_REF_REQUIRED' using errcode='22023'; end if;
  -- Confirmation preparation is read-only with respect to pool policy/version.
  if coalesce((clued_private.ci_pool_view_v1(u,p)->>'version')::bigint,0)<>(p_input->>'base_version')::bigint then
    raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  return clued_private.ci_issue_v1(u,p,'ci_pool',p_input-'project_id');
end $$;

create function clued_private.ci_apply_v1(p_input jsonb,kind text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid(); p uuid; tok clued_private.native_confirmation_tokens; c jsonb; n clued_private.ci_nodes_v1;
  q clued_private.ci_quota_counters_v1; b public.clued_agent_bindings; r uuid; v jsonb; repo bigint; sid text;
begin
  -- Discover the existing target before acquiring token/business locks.
  select * into tok from clued_private.native_confirmation_tokens where user_id=u and action=kind
    and token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
  if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
  c:=tok.native_choices; p:=(c->>'project_id')::uuid;
  if kind='ci_node' then select * into n from clued_private.ci_nodes_v1 where node_id=(c->>'node_id')::uuid and user_id=u and project_id=p; end if;
  u:=clued_private.ci_native_owner_v1(true,p,case when kind='ci_node' then n.binding_id end); sid:=clued_private.native_session_id_v1();
  select * into tok from clued_private.native_confirmation_tokens where id=tok.id for update;
  perform clued_private.ci_input_v1(p_input,array['confirmation_token','view_digest'],array['confirmation_token','view_digest']);
  perform clued_private.ci_native_recheck_v1(u,sid);
  if tok.session_id is distinct from sid or tok.view_digest is distinct from p_input->>'view_digest' then
    raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
  if tok.consume_outcome='committed' then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',tok.consumed_receipt_id)
      ||coalesce((select metadata->'result' from public.clued_audit_receipts where id=tok.consumed_receipt_id),'{}'::jsonb);
  end if;
  begin
    perform clued_private.ci_input_v1(p_input,array['confirmation_token','view_digest'],array['confirmation_token','view_digest']);
    if tok.consumed_at is not null or tok.revoked_at is not null or tok.expires_at<=clock_timestamp()
      or tok.issued_xact=pg_current_xact_id() or tok.session_id is distinct from sid
      or tok.view_digest is distinct from p_input->>'view_digest' then raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    if kind='ci_pool' and c ? 'repository' then
      repo:=(c->'repository'->>'id')::bigint;
      perform pg_advisory_xact_lock(hashtextextended('ci-repo:'||u||':'||repo,0));
      if exists(select 1 from clued_private.ci_quota_counters_v1 where user_id=u and repository_id=repo and row_kind='repo_registration' and project_id<>p) then
        raise exception 'CI_REPOSITORY_POOL_MISMATCH' using errcode='42501'; end if;
    end if;
    if kind='ci_pool' then q:=clued_private.ci_policy_v1(u,p); end if;
    if kind='ci_node' and c->>'action'='revoke' then
      q:=clued_private.ci_policy_v1(u,p);
      perform 1 from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
    end if;
    if kind='ci_node' then select * into n from clued_private.ci_nodes_v1 where node_id=n.node_id for update; end if;
    perform clued_private.ci_native_recheck_v1(u,sid);
    if tok.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    -- Recompute against the *pre-creation* empty policy view for a first apply.
    v:=clued_private.ci_confirmation_view_v1(u,p,kind,c-'project_id');
    if kind='ci_pool' and (c->>'base_version')::bigint=0 and q.version=1 then
      v:=jsonb_set(v,'{pool}', '{"mode":"prepared","status":"UNCONFIGURED","phase":1,"limits":null,"version":0,"repositories":[]}'::jsonb);
    end if;
    if clued_private.m1_sha256(v)<>tok.view_digest then raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    if kind='ci_node' then
      select * into b from public.clued_agent_bindings where id=n.binding_id and user_id=u;
      if c->>'action'='approve' and not clued_private.binding_live_v1(b) then raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
      if c->>'action'='retire' and exists(select 1 from clued_private.ci_job_leases_v1 where holder_node_id=n.node_id and state='current' and expires_at>clock_timestamp()) then
        raise exception 'CI_NODE_NOT_DRAINED' using errcode='55000'; end if;
      update clued_private.ci_nodes_v1 set state=case c->>'action' when 'approve' then 'active' when 'drain' then 'draining' when 'retire' then 'retired' when 'revoke' then 'revoked' end,
        owner_approval_ref=coalesce(c->>'accepted_ref',owner_approval_ref),
        publisher_approved=case when c->>'action'='approve' then publisher_requested else publisher_approved end,
        scan_signing_approved=case when c->>'action'='approve' then scan_signing_requested else scan_signing_approved end,
        eligible_until=case when c->>'action'='revoke' then null else eligible_until end,
        updated_at=clock_timestamp(),version=version+1 where node_id=n.node_id returning * into n;
      if n.state='revoked' then
        update clued_private.ci_job_leases_v1 set state='revoked',terminal_at=clock_timestamp(),terminal_reason='NODE_REVOKED'
          where holder_node_id=n.node_id and state='current';
        update clued_private.ci_train_lease_v1 set state='silence',ended_at=clock_timestamp(),silence_until=clock_timestamp()+interval '5 minutes',
          last_holder_node_id=holder_node_id,last_lost_at=clock_timestamp(),holder_node_id=null,holder_binding_id=null
          where user_id=u and project_id=p and holder_node_id=n.node_id;
      end if;
      v:=jsonb_build_object('node_id',n.node_id,'version',n.version,'state',n.state,'qualification_status',n.qualification_status);
    else
      if repo is not null then
        r:=clued_private.ci_receipt_v1(u,p,'ci_repository_register',repo::text,jsonb_build_object('view_digest',tok.view_digest,'accepted_ref',c->>'accepted_ref'));
        insert into clued_private.ci_quota_counters_v1(user_id,project_id,row_kind,metric,subject_key,unit_key,amount,repository_id,repository_name,accepted_ref,receipt_id)
          values(u,p,'repo_registration','repository','repo:'||repo,'registration',0,repo,c->'repository'->>'name',c->>'accepted_ref',r) on conflict do nothing;
        select * into q from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='repo_registration' and repository_id=repo;
        insert into clued_private.ci_train_front_v1(user_id,project_id,repository_id,registration_ref) values(u,p,repo,q.counter_id) on conflict do nothing;
      end if;
      update clued_private.ci_quota_counters_v1 set policy=jsonb_build_object('mode','prepared','phase',1,'signature_gateway_active',false,
          'limits',case when c ? 'limits' then c->'limits' else policy->'limits' end,
          'status',case when coalesce(case when c ? 'limits' then c->'limits' else policy->'limits' end,'null'::jsonb)='null'::jsonb then 'UNCONFIGURED' else 'CONFIGURED_PREPARED' end),
        accepted_ref=coalesce(c->>'accepted_ref',accepted_ref),version=version+1,policy_version=policy_version+1
        where user_id=u and project_id=p and row_kind='pool_policy';
      v:=jsonb_build_object('project_id',p,'pool',clued_private.ci_pool_view_v1(u,p));
    end if;
    r:=clued_private.ci_receipt_v1(u,p,kind||'_apply',tok.subject_key,jsonb_build_object('result',v,'view_digest',tok.view_digest));
    if kind='ci_node' then update clued_private.ci_nodes_v1 set receipt_id=r where node_id=n.node_id;
    else update clued_private.ci_quota_counters_v1 set receipt_id=r where user_id=u and project_id=p and row_kind='pool_policy'; end if;
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=r,consume_outcome='committed' where id=tok.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',r)||v;
  exception when others then
    r:=clued_private.ci_receipt_v1(u,p,kind||'_rejected',tok.subject_key,jsonb_build_object('error_code',sqlerrm));
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=r,consume_outcome='rejected'
      where id=tok.id and consumed_at is null and revoked_at is null;
    return jsonb_build_object('status','rejected','error_code',sqlerrm,'receipt_id',r,'authoritative',false);
  end;
end $$;
create function public.clued_ci_node_apply_v1(p_input jsonb) returns jsonb language sql volatile security definer set search_path='' as $$ select clued_private.ci_apply_v1(p_input,'ci_node') $$;
create function public.clued_ci_pool_apply_v1(p_input jsonb) returns jsonb language sql volatile security definer set search_path='' as $$ select clued_private.ci_apply_v1(p_input,'ci_pool') $$;

-- Trusted internal kernels: no EXECUTE grant and no transport caller. Tests
-- exercise them as database owner, separately from cryptographic qualification.
create function clued_private.ci_node_current_v1(u uuid,p uuid,node uuid,publisher boolean default false,operation text default 'admit')
returns clued_private.ci_nodes_v1 language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; b public.clued_agent_bindings; begin
  select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=node for share;
  if not found or (n.state<>'active' and not(n.state='draining' and operation in ('renew','result','observe','green','settle'))) or n.qualification_status<>'verified'
    or n.qualification_expires_at is null or n.qualification_expires_at<=clock_timestamp()
    or n.eligible_until is null or n.eligible_until<=clock_timestamp()
    or publisher and not n.publisher_approved then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where id=n.binding_id and user_id=u;
  if not found or not clued_private.binding_live_v1(b) then raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  return n;
end $$;
create function clued_private.ci_node_recheck_v1(n clued_private.ci_nodes_v1) returns void
language plpgsql volatile security definer set search_path='' as $$ begin
  if n.node_id is null or n.qualification_status<>'verified' or n.qualification_expires_at is null
    or n.qualification_expires_at<=clock_timestamp() or n.eligible_until is null or n.eligible_until<=clock_timestamp()
    or not exists(select 1 from public.clued_agent_bindings b where b.id=n.binding_id and b.user_id=n.user_id and clued_private.binding_live_v1(b)) then
    raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
end $$;
create function clued_private.ci_claim_current_v1(u uuid,j clued_private.ci_jobs_v1,operation text default 'admit',g bigint default null,node uuid default null) returns void
language plpgsql volatile security definer set search_path='' as $$ declare c clued_private.work_claims_v1; a clued_private.work_claim_head_authorizations_v1; e clued_private.work_claim_execution_admissions_v1; ci public.clued_agent_bindings; begin
  if operation is null or operation not in ('admit','renew','result') then raise exception 'CI_CLAIM_OPERATION_INVALID' using errcode='22023'; end if;
  select * into c from clued_private.work_claims_v1 where user_id=u and claim_id=j.claim_id;
  if not found or (c.status<>'ACTIVE' and not(c.status='DRAINING' and operation in ('renew','result')
      and g is not null and node is not null and exists(select 1 from clued_private.ci_jobs_v1 actual
        join clued_private.ci_job_leases_v1 l on l.user_id=actual.user_id and l.project_id=actual.project_id and l.job_id=actual.job_id and l.generation=actual.current_generation
        where actual.user_id=u and actual.project_id=j.project_id and actual.job_id=j.job_id and actual.current_generation=g
          and actual.claim_id=c.claim_id and actual.claim_fence=c.fence and actual.execution_epoch=c.execution_epoch
          and l.holder_node_id=node and l.state='current' and l.started_at is not null and l.expires_at>clock_timestamp()))) or c.expires_at<=clock_timestamp()
    or c.execution_handover_pending or c.fence is distinct from j.claim_fence or c.execution_epoch is distinct from j.execution_epoch
    or c.task_id is distinct from j.task_id or c.context_key is distinct from 'project:'||j.project_id
    or c.copy_index is distinct from j.copy_index or c.bound_pr is distinct from j.pr_ref or c.outcome='not_adopted'
    or c.copy_index is null and exists(select 1 from clued_private.work_claims_v1 newer where newer.user_id=u and newer.task_id=c.task_id and newer.fence>c.fence)
    or not exists(select 1 from public.clued_agent_bindings b where b.id=c.holder_binding_id and clued_private.binding_live_v1(b)) then
    raise exception 'CI_CLAIM_NOT_CURRENT' using errcode='42501'; end if;
  perform clued_private.work_claim_task(u,c.context_key,c.task_id::text);
  select * into a from clued_private.work_claim_head_authorizations_v1 where authorization_id=j.head_authorization_id and user_id=u;
  if not found or a.revoked_at is not null or a.claim_id is distinct from c.claim_id or a.execution_epoch is distinct from c.execution_epoch
    or a.binding_id is distinct from c.holder_binding_id or a.copy_index is distinct from c.copy_index
    or a.repository is distinct from lower(j.repository_name) or a.head_sha is distinct from j.head_sha
    or a.target_branch is distinct from j.target_branch or a.pr_ref is distinct from j.pr_ref or a.workflow is distinct from j.workflow then
    raise exception 'CI_HEAD_AUTHORIZATION_NOT_CURRENT' using errcode='42501'; end if;
  select * into e from clued_private.work_claim_execution_admissions_v1 where admission_id=j.admission_id and user_id=u;
  if not found or e.claim_id is distinct from c.claim_id or e.execution_epoch is distinct from c.execution_epoch
    or e.repository is distinct from lower(j.repository_name) or e.head_sha is distinct from j.head_sha
    or e.target_branch is distinct from j.target_branch or e.pr_ref is distinct from j.pr_ref or e.workflow is distinct from j.workflow
    or e.resources_digest is distinct from clued_private.m1_sha256(jsonb_build_object('write_set',c.write_set,'trigger_refs',c.trigger_refs)) then
    raise exception 'CI_EXECUTION_ADMISSION_NOT_CURRENT' using errcode='42501'; end if;
  select * into ci from public.clued_agent_bindings where id=e.ci_binding_id and user_id=u;
  if not found or not clued_private.binding_live_v1(ci) or not exists(select 1 from clued_private.binding_roles_v1 r
    where r.user_id=u and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp()) then
    raise exception 'CI_ADMISSION_BINDING_NOT_CURRENT' using errcode='42501'; end if;
  if not exists(select 1 from clued_private.work_claim_door_usage_v1 where user_id=u and door='github-ci' and task_id=c.task_id and unit_key=j.head_sha) then
    raise exception 'CI_TASK_METER_REQUIRED' using errcode='42501'; end if;
end $$;
create function clued_private.ci_usage_count_v1(u uuid,p uuid,m text,s text,at_time timestamptz default null) returns bigint
language sql volatile security definer set search_path='' as $$
  with boundary as materialized(select coalesce(at_time,clock_timestamp()) at_now)
  select case when m='head_distinct_combination_24h' then count(distinct e.combination_sha256) else coalesce(sum(e.amount),0) end
  from clued_private.ci_quota_counters_v1 e cross join boundary b
  left join clued_private.ci_job_leases_v1 l on l.user_id=e.user_id and l.project_id=e.project_id and l.job_id=e.job_id and l.generation=e.lease_generation
  where e.user_id=u and e.project_id=p and e.row_kind='usage_event' and e.metric=m and e.subject_key=s
    and e.event_at>b.at_now-interval '24 hours' and e.event_at<=b.at_now
    and (m<>'evaluation' or (l.started_at is null and l.origin<>'waiting-retry' and
      (l.terminal_at is null or not l.classification_verified or
        (coalesce(l.terminal_reason,'') not in ('BUNDLE_UNAVAILABLE','BROKER_NOT_LAUNCHED','SUPERSEDED')
          and coalesce(l.terminal_class,'') not in ('environment','transient')))))
$$;
create function clued_private.ci_quota_check_v1(u uuid,p uuid,m text,s text,combo text default null) returns void
language plpgsql volatile security definer set search_path='' as $$ declare q clued_private.ci_quota_counters_v1; used bigint; cap bigint; at_now timestamptz; begin
  q:=clued_private.ci_policy_v1(u,p);
  if q.policy->'limits' is null or q.policy->'limits'='null'::jsonb or not (q.policy->'limits' ? m)
    or jsonb_typeof(q.policy->'limits'->m) is distinct from 'number' or coalesce(q.policy->'limits'->>m,'') !~ '^[0-9]{1,7}$' then
    raise exception 'QUOTA_UNCONFIGURED' using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ci-quota:'||u||':'||p||':'||m||':'||s,0));
  at_now:=clock_timestamp(); used:=clued_private.ci_usage_count_v1(u,p,m,s,at_now); cap:=(q.policy->'limits'->>m)::bigint;
  if m='head_distinct_combination_24h' and exists(select 1 from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p
    and row_kind='usage_event' and metric=m and subject_key=s and combination_sha256=combo
    and event_at>at_now-interval '24 hours' and event_at<=at_now) then return; end if;
  if used>=cap then raise exception 'CI_QUOTA_EXCEEDED:%',m using errcode='55000'; end if;
end $$;
create function clued_private.ci_event_v1(j clued_private.ci_jobs_v1,g bigint,m text,s text,unit text,at_time timestamptz,combo text default null)
returns void language plpgsql volatile security definer set search_path='' as $$ declare r uuid; begin
  perform pg_advisory_xact_lock(hashtextextended('ci-event:'||j.user_id||':'||j.project_id||':'||m||':'||s||':'||unit,0));
  if exists(select 1 from clued_private.ci_quota_counters_v1 where user_id=j.user_id and project_id=j.project_id and row_kind='usage_event' and metric=m and subject_key=s and unit_key=unit) then return; end if;
  r:=clued_private.ci_receipt_v1(j.user_id,j.project_id,'ci_usage_event',j.job_id::text,jsonb_build_object('metric',m,'subject',s,'unit',unit,'event_at',at_time));
  insert into clued_private.ci_quota_counters_v1(user_id,project_id,row_kind,repository_id,metric,subject_key,unit_key,event_at,job_id,lease_generation,combination_sha256,receipt_id)
    values(j.user_id,j.project_id,'usage_event',j.repository_id,m,s,unit,at_time,j.job_id,g,combo,r) on conflict do nothing;
end
$$;
create function clued_private.ci_job_enqueue_v1(u uuid,p uuid,p_input jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$ declare reg clued_private.ci_quota_counters_v1; q clued_private.ci_quota_counters_v1; j clued_private.ci_jobs_v1; d text; r uuid; begin
  perform clued_private.ci_input_v1(p_input,array['repository_id','kind','task_id','claim_id','claim_fence','execution_epoch','copy_index','target_branch','workflow','head_authorization_id','admission_id','pr_ref','head_sha','base_sha','test_sha','source_sha',
    'combination_sha256','combination_mode','role','attempt','origin','parent_job_id','parent_lease_generation','required_environment'],
    array['repository_id','kind','task_id','claim_id','claim_fence','execution_epoch','target_branch','head_authorization_id','admission_id','pr_ref','head_sha','base_sha','test_sha','source_sha','combination_sha256','role']);
  if jsonb_typeof(p_input->'claim_fence') is distinct from 'number' or coalesce(p_input->>'claim_fence','') !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_input->'execution_epoch') is distinct from 'number' or coalesce(p_input->>'execution_epoch','') !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_input->'repository_id') is distinct from 'number' or coalesce(p_input->>'repository_id','') !~ '^[1-9][0-9]*$' then
    raise exception 'CI_JOB_SCALAR_INVALID' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(u);
  reg:=clued_private.ci_repo_v1(u,p,(p_input->>'repository_id')::bigint); q:=clued_private.ci_policy_v1(u,p);
  if q.policy->>'mode'='prepared' then raise exception 'CI_SCHEDULING_NOT_ACTIVATED' using errcode='42501'; end if;
  d:=clued_private.m1_sha256(p_input);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_key_sha256=d;
  if found then return j.job_id; end if;
  insert into clued_private.ci_jobs_v1(user_id,project_id,registration_ref,repository_id,repository_name,job_key_sha256,kind,task_id,claim_id,claim_fence,execution_epoch,copy_index,target_branch,workflow,head_authorization_id,admission_id,pr_ref,
    head_sha,base_sha,test_sha,source_sha,combination_sha256,combination_mode,role,attempt,origin,parent_job_id,parent_lease_generation,required_environment)
  values(u,p,reg.counter_id,reg.repository_id,reg.repository_name,d,p_input->>'kind',(p_input->>'task_id')::uuid,(p_input->>'claim_id')::uuid,
    (p_input->>'claim_fence')::bigint,(p_input->>'execution_epoch')::bigint,(p_input->>'copy_index')::integer,p_input->>'target_branch',p_input->>'workflow',(p_input->>'head_authorization_id')::uuid,(p_input->>'admission_id')::uuid,p_input->>'pr_ref',p_input->>'head_sha',p_input->>'base_sha',p_input->>'test_sha',
    p_input->>'source_sha',p_input->>'combination_sha256',coalesce(p_input->>'combination_mode','depth1'),p_input->>'role',coalesce((p_input->>'attempt')::integer,1),
    coalesce(p_input->>'origin','queued'),(p_input->>'parent_job_id')::uuid,(p_input->>'parent_lease_generation')::bigint,coalesce(p_input->>'required_environment','E1-Linux')) returning * into j;
  perform clued_private.ci_claim_current_v1(u,j);
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_enqueue',j.job_id::text,jsonb_build_object('job_key',d));
  update clued_private.ci_jobs_v1 set receipt_id=r where job_id=j.job_id; return j.job_id;
end $$;
create function clued_private.ci_job_lease_v1(u uuid,p uuid,node uuid,id uuid,expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.ci_jobs_v1; n clued_private.ci_nodes_v1; q clued_private.ci_quota_counters_v1; l clued_private.ci_job_leases_v1; t timestamptz; r uuid;
begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  if not found then raise exception 'CI_JOB_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p);
  if q.policy->>'mode'='prepared' then raise exception 'CI_SCHEDULING_NOT_ACTIVATED' using errcode='42501'; end if;
  n:=clued_private.ci_node_current_v1(u,p,node);
  select * into j from clued_private.ci_jobs_v1 where job_id=id for update;
  perform clued_private.ci_claim_current_v1(u,j);
  perform clued_private.ci_node_recheck_v1(n);
  if expected_version is null or j.state<>'queued' or j.version is distinct from expected_version then raise exception 'CI_JOB_ALREADY_LEASED' using errcode='40001'; end if;
  if n.qualification_source<>j.source_sha then raise exception 'CI_SOURCE_NOT_ACCEPTED' using errcode='42501'; end if;
  if coalesce((n.profile->>'slot_count')::integer,0)<=(select count(*) from clued_private.ci_job_leases_v1 where holder_node_id=node and state='current' and expires_at>clock_timestamp())
    or not coalesce(n.profile->'environment_kinds' ? j.required_environment,false)
    or coalesce((n.profile->>'memory_limit_mb')::integer,0)<j.required_memory_mb then raise exception 'CI_NODE_CAPACITY_UNAVAILABLE' using errcode='55000'; end if;
  if j.kind='delegated_scan' and (not n.hardening_observed or not n.scan_signing_approved) then raise exception 'CI_SCAN_NODE_NOT_APPROVED' using errcode='42501'; end if;
  if j.origin in ('queued','backoff-retry','restored') then perform clued_private.ci_quota_check_v1(u,p,'head_release',j.repository_id||':'||j.head_sha); end if;
  if j.kind='combination_execution' and j.origin<>'waiting-retry' then perform clued_private.ci_quota_check_v1(u,p,'evaluation','pool'); end if;
  t:=clock_timestamp();
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_lease',id::text,jsonb_build_object('generation',j.current_generation+1,'holder_node_id',node));
  insert into clued_private.ci_job_leases_v1(user_id,project_id,job_id,generation,holder_node_id,holder_binding_id,origin,issued_at,reservation_at,expires_at,receipt_id)
    values(u,p,id,j.current_generation+1,node,n.binding_id,j.origin,t,t,least(t+interval '10 minutes',n.qualification_expires_at,n.eligible_until),r) returning * into l;
  update clued_private.ci_jobs_v1 set state='leased',current_generation=l.generation,version=version+1,updated_at=t,receipt_id=r where job_id=id;
  if j.kind='combination_execution' then perform clued_private.ci_event_v1(j,l.generation,'evaluation','pool',id||':'||l.generation,t); end if;
  return jsonb_build_object('job_id',id,'generation',l.generation,'lease_version',l.lease_version,'expires_at',l.expires_at,'state','leased','receipt_id',r);
end $$;
create function clued_private.ci_lease_current_v1(u uuid,p uuid,id uuid,g bigint,node uuid) returns clued_private.ci_job_leases_v1
language plpgsql volatile security definer set search_path='' as $$ declare l clued_private.ci_job_leases_v1; begin
  select * into l from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=id and generation=g for update;
  if not found or l.state<>'current' or l.holder_node_id<>node or l.expires_at<=clock_timestamp() then raise exception 'CI_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  return l;
end $$;
create function clued_private.ci_job_renew_v1(u uuid,p uuid,node uuid,id uuid,g bigint,v bigint,progress text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare j clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1; n clued_private.ci_nodes_v1; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); perform clued_private.ci_policy_v1(u,p); n:=clued_private.ci_node_current_v1(u,p,node,false,'renew');
  perform 1 from clued_private.ci_jobs_v1 where job_id=id for update; l:=clued_private.ci_lease_current_v1(u,p,id,g,node);
  perform clued_private.ci_claim_current_v1(u,j,'renew',g,node);
  perform clued_private.ci_node_recheck_v1(n);
  if l.lease_version=v+1 and progress=l.progress_digest then return jsonb_build_object('generation',g,'lease_version',l.lease_version,'expires_at',l.expires_at,'receipt_id',l.receipt_id,'replayed',true); end if;
  if v is null or l.lease_version is distinct from v or coalesce(progress,'') !~ '^[0-9a-f]{64}$' or progress=l.progress_digest then raise exception 'CI_RENEW_STALE' using errcode='40001'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_renew',id::text,jsonb_build_object('generation',g,'lease_version',v+1,'progress_digest',progress));
  update clued_private.ci_job_leases_v1 set lease_version=lease_version+1,progress_digest=progress,receipt_id=r,
    expires_at=least(clock_timestamp()+interval '10 minutes',n.qualification_expires_at,n.eligible_until,
      (select expires_at from clued_private.work_claims_v1 where claim_id=j.claim_id)) where job_id=id and generation=g returning * into l;
  return jsonb_build_object('generation',g,'lease_version',l.lease_version,'expires_at',l.expires_at,'receipt_id',r,'replayed',false);
end $$;
create function clued_private.ci_job_started_v1(u uuid,p uuid,node uuid,id uuid,g bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1; q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1; t timestamptz; scope text; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p); n:=clued_private.ci_node_current_v1(u,p,node);
  select * into j from clued_private.ci_jobs_v1 where job_id=id for update; l:=clued_private.ci_lease_current_v1(u,p,id,g,node);
  perform clued_private.ci_claim_current_v1(u,j);
  perform clued_private.ci_node_recheck_v1(n);
  if l.started_at is not null then return jsonb_build_object('status','started','replayed',true,'started_at',l.started_at,'receipt_id',l.started_receipt_id); end if;
  if j.state<>'leased' then raise exception 'CI_JOB_STATE_INVALID' using errcode='55000'; end if;
  t:=clock_timestamp();
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_started',id::text,jsonb_build_object('generation',g,'started_at',t));
  -- Retract the evaluation hold in this transaction; a failed execution debit rolls everything back.
  update clued_private.ci_job_leases_v1 set started_at=t,started_receipt_id=r,receipt_id=r where job_id=id and generation=g;
  if j.kind='combination_execution' then
    perform clued_private.ci_quota_check_v1(u,p,'execution_start','pool');
    perform clued_private.ci_quota_check_v1(u,p,'PR_batch',j.pr_ref);
    if j.combination_mode in ('depth2','depth3') then
      if (q.policy->>'phase')::integer<4 then raise exception 'CI_PHASE_NOT_ACTIVATED' using errcode='42501'; end if;
      perform clued_private.ci_quota_check_v1(u,p,'head_distinct_combination_24h',j.repository_id||':'||j.head_sha,j.combination_sha256);
      insert into clued_private.ci_exec_keys_v1(user_id,project_id,repository_id,key_kind,head_sha,combination_sha256,source_sha,attempt,semantic_scope,job_id,lease_generation,receipt_id)
        values(u,p,j.repository_id,'combination',j.head_sha,j.combination_sha256,j.source_sha,j.attempt,'combination',id,g,r);
      perform clued_private.ci_event_v1(j,g,'head_distinct_combination_24h',j.repository_id||':'||j.head_sha,id||':'||g,t,j.combination_sha256);
    else
      scope:=case when (q.policy->>'phase')::integer>=4 then 'pool_enforced' else 'resident_mirror:'||node end;
      insert into clued_private.ci_exec_keys_v1(user_id,project_id,repository_id,key_kind,head_sha,semantic_scope,node_id,job_id,lease_generation,receipt_id)
        values(u,p,j.repository_id,'head',j.head_sha,scope,node,id,g,r);
    end if;
    perform clued_private.ci_event_v1(j,g,'execution_start','pool',id||':'||g,t);
    perform clued_private.ci_event_v1(j,g,'PR_batch',j.pr_ref,id||':'||g,t);
  end if;
  update clued_private.ci_jobs_v1 set state='started',version=version+1,updated_at=t,receipt_id=r where job_id=id;
  return jsonb_build_object('status','started','replayed',false,'started_at',t,'receipt_id',r);
end $$;
create function clued_private.ci_job_release_v1(u uuid,p uuid,node uuid,id uuid,g bigint,reason text,classification text,breaker text,classification_verified boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1; t timestamptz; count_release boolean; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); perform clued_private.ci_policy_v1(u,p);
  perform 1 from clued_private.ci_jobs_v1 where job_id=id for update;
  select * into l from clued_private.ci_job_leases_v1 where job_id=id and generation=g and user_id=u and project_id=p for update;
  if not found or l.holder_node_id<>node then raise exception 'CI_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  if l.terminal_at is not null then return jsonb_build_object('status','released','replayed',true,'receipt_id',l.terminal_receipt_id); end if;
  if classification_verified is not true or reason is null or classification is null or classification not in ('waiting','environment','transient','rejected','success','unknown') then
    raise exception 'CI_TERMINAL_CLASSIFICATION_UNVERIFIED' using errcode='42501'; end if;
  t:=clock_timestamp();
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_release',id::text,jsonb_build_object('generation',g,'reason',reason,'class',classification,'breaker',breaker));
  update clued_private.ci_job_leases_v1 set state=case when expires_at<=t then 'expired' else 'released' end,
    terminal_at=t,terminal_reason=reason,terminal_class=classification,terminal_breaker_state=breaker,classification_verified=true,terminal_receipt_id=r,receipt_id=r where job_id=id and generation=g;
  count_release:=l.started_at is null and reason<>'SUPERSEDED' and classification<>'waiting'
    and not (classification in ('environment','transient') and breaker is not null and breaker<>'closed');
  if count_release then perform clued_private.ci_event_v1(j,g,'head_release',j.repository_id||':'||j.head_sha,id||':'||g||':release',l.reservation_at); end if;
  -- Fact settlement never calls a quota admission check, even at/above the cap.
  update clued_private.ci_jobs_v1 set state=case when exists(select 1 from clued_private.ci_publish_keys_v1 where job_id=id and state='unknown') then 'uncertain'
      when l.started_at is not null then case when classification='success' then 'completed' else 'failed' end else 'canceled' end,
    version=version+1,updated_at=t,receipt_id=r where job_id=id and current_generation=g;
  return jsonb_build_object('status','released','replayed',false,'head_release_counted',count_release,'receipt_id',r);
end $$;
create function clued_private.ci_stage8_try_begin_v1(u uuid,p uuid,node uuid,id uuid,g bigint,expected_try integer) returns integer
language plpgsql volatile security definer set search_path='' as $$ declare j clued_private.ci_jobs_v1; q clued_private.ci_quota_counters_v1; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p);
  if (q.policy->>'phase')::integer<4 then raise exception 'CI_PHASE_NOT_ACTIVATED' using errcode='42501'; end if;
  perform clued_private.ci_node_current_v1(u,p,node); select * into j from clued_private.ci_jobs_v1 where job_id=id for update;
  perform clued_private.ci_lease_current_v1(u,p,id,g,node);
  if expected_try is null or expected_try<1 then raise exception 'CI_STAGE8_TRY_INVALID' using errcode='22023'; end if;
  perform clued_private.ci_claim_current_v1(u,j);
  if expected_try=j.stage8_try and expected_try>0 then return expected_try; end if;
  if expected_try<>j.stage8_try+1 or expected_try>j.stage8_limit then raise exception 'CI_STAGE8_TRY_INVALID' using errcode='55000'; end if;
  if expected_try>=2 then
    perform clued_private.ci_quota_check_v1(u,p,'stage8_retry','pool');
    perform clued_private.ci_event_v1(j,g,'stage8_retry','pool',id||':try:'||expected_try,clock_timestamp());
  end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_stage8_try',id::text,jsonb_build_object('generation',g,'try',expected_try));
  update clued_private.ci_jobs_v1 set stage8_try=expected_try,version=version+1,receipt_id=r where job_id=id; return expected_try;
end $$;

create function clued_private.ci_nonce_issue_v1(u uuid,p uuid,node uuid,purpose text,subject text,id uuid,g bigint,ttl integer default 600) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; nonceid uuid; raw text; t timestamptz; r uuid;
begin
  if u is null or p is null or node is null or ttl is null or ttl not between 1 and 3600
    or subject is null or subject !~ '^[0-9a-f]{64}$' or purpose is null
    or purpose not in ('result-register','publish-reserve','publish-observe','green-transition','drop-send','drop-take','node-heartbeat')
    or (purpose<>'node-heartbeat' and (id is null or g is null or g<=0)) then
    raise exception 'CI_NONCE_INPUT_INVALID' using errcode='22023'; end if;
  n:=clued_private.ci_node_current_v1(u,p,node,false,case when purpose='result-register' then 'result'
    when purpose in ('publish-observe','drop-take') then 'observe' when purpose='green-transition' then 'green' else 'admit' end);
  if purpose<>'node-heartbeat' and not exists(select 1 from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id) then
    raise exception 'CI_JOB_NOT_FOUND' using errcode='42501'; end if;
  raw:=rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'='); t:=clock_timestamp();
  insert into clued_private.ci_nonce_ledger_v1(user_id,project_id,nonce_hash,purpose,subject_digest,node_id,key_fingerprint,job_id,execution_generation,issued_at,expires_at)
    values(u,p,encode(extensions.digest(convert_to(raw,'UTF8'),'sha256'),'hex'),purpose,subject,node,n.identity_fingerprint,id,g,t,t+make_interval(secs=>ttl))
    returning nonce_id into nonceid;
  r:=clued_private.ci_receipt_v1(u,p,'ci_nonce_issue',nonceid::text,jsonb_build_object('purpose',purpose,'subject_digest',subject,'node_id',node,'job_id',id,'generation',g));
  return jsonb_build_object('nonce_id',nonceid,'nonce',raw,'expires_at',t+make_interval(secs=>ttl),'receipt_id',r);
end $$;
create function clued_private.ci_nonce_consume_v1(u uuid,p uuid,node uuid,id uuid,purpose text,digest text,job uuid,g bigint,nonce_value text default null) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nonce_ledger_v1; fp text; r uuid;
begin
  if u is null or p is null or node is null or id is null or purpose is null or digest is null
    or digest !~ '^[0-9a-f]{64}$' or nonce_value is null or nonce_value !~ '^[A-Za-z0-9_-]{43}$'
    or rtrim(translate(encode(decode(translate(nonce_value,'-_','+/')||'=','base64'),'base64'),'+/','-_'),'=')<>nonce_value then
    raise exception 'CI_NONCE_BINDING_MISMATCH' using errcode='42501'; end if;
  select identity_fingerprint into fp from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=node;
  if not found then raise exception 'CI_NONCE_BINDING_MISMATCH' using errcode='42501'; end if;
  select * into n from clued_private.ci_nonce_ledger_v1 where nonce_id=id and user_id=u and project_id=p for update;
  if not found or n.node_id is distinct from node or n.key_fingerprint is distinct from fp or n.purpose is distinct from purpose
    or n.subject_digest is distinct from digest or n.job_id is distinct from job or n.execution_generation is distinct from g
    or n.nonce_hash is distinct from encode(extensions.digest(convert_to(nonce_value,'UTF8'),'sha256'),'hex') then
    raise exception 'CI_NONCE_BINDING_MISMATCH' using errcode='42501'; end if;
  if n.consumed_at is not null then
    if n.request_digest=digest then return false; end if;
    raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if;
  if n.expires_at<=clock_timestamp() then raise exception 'CI_NONCE_EXPIRED' using errcode='42501'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_nonce_consume',id::text,jsonb_build_object('purpose',purpose,'subject_digest',digest,'node_id',node,'job_id',job,'generation',g));
  update clued_private.ci_nonce_ledger_v1 set consumed_at=clock_timestamp(),request_digest=digest,consume_receipt_id=r where nonce_id=id;
  return true;
end $$;
create function clued_private.ci_result_register_v1(u uuid,p uuid,node uuid,id uuid,g bigint,data jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.ci_jobs_v1; parent clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1; pl clued_private.ci_job_leases_v1;
  n clued_private.ci_nodes_v1; rid uuid; r uuid; t timestamptz; d text; fresh boolean; lockid uuid; field text;
begin
  perform clued_private.ci_input_v1(data,array['result_kind','result_digest','certificate_digest','signature_envelope','qualification_ref','scanner_digest','rules_digest','vulnerability_db_digest','db_updated_at','db_next_update','nonce_id','nonce'],
    array['result_kind','result_digest','certificate_digest','signature_envelope','qualification_ref','nonce_id','nonce']);
  if u is null or p is null or node is null or id is null or g is null or g<=0
    or coalesce(data->>'result_kind','') not in ('gitleaks','trivy','contract-placement')
    or coalesce(data->>'result_digest','') !~ '^[0-9a-f]{64}$' or coalesce(data->>'certificate_digest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(data->'signature_envelope') is distinct from 'object' or octet_length((data->'signature_envelope')::text)>16384
    or nullif(btrim(data->>'qualification_ref'),'') is null or length(data->>'qualification_ref')>256 then
    raise exception 'CI_RESULT_INPUT_INVALID' using errcode='22023'; end if;
  foreach field in array array['scanner_digest','rules_digest','vulnerability_db_digest'] loop
    if data ? field and (jsonb_typeof(data->field) is distinct from 'string' or coalesce(data->>field,'') !~ '^[0-9a-f]{64}$') then raise exception 'CI_RESULT_INPUT_INVALID' using errcode='22023'; end if;
  end loop;
  foreach field in array array['result_kind','result_digest','certificate_digest','qualification_ref','nonce_id','nonce'] loop
    if jsonb_typeof(data->field) is distinct from 'string' then raise exception 'CI_RESULT_INPUT_INVALID' using errcode='22023'; end if;
  end loop;
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  if not found then raise exception 'CI_JOB_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); perform clued_private.ci_policy_v1(u,p);
  if j.parent_job_id is not null then
    select * into parent from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=j.parent_job_id and repository_id=j.repository_id;
    select * into pl from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=parent.job_id and generation=j.parent_lease_generation;
    if parent.job_id is null or pl.holder_node_id is null then raise exception 'CI_PARENT_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  end if;
  for lockid in select distinct x from unnest(array[node,pl.holder_node_id]) x where x is not null order by x loop
    perform clued_private.ci_node_current_v1(u,p,lockid,false,'result');
  end loop;
  for lockid in select distinct x from unnest(array[id,parent.job_id]) x where x is not null order by x loop
    perform 1 from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=lockid for update;
    perform 1 from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=lockid
      and generation=case when lockid=id then g else j.parent_lease_generation end for update;
  end loop;
  -- The nonce row may wait too. Acquire it in the nonce/result lock rank before
  -- the final time/authority snapshot; consume below only reuses this held lock.
  perform 1 from clued_private.ci_nonce_ledger_v1 where user_id=u and project_id=p and nonce_id=(data->>'nonce_id')::uuid for update;
  select * into j from clued_private.ci_jobs_v1 where job_id=id;
  l:=clued_private.ci_lease_current_v1(u,p,id,g,node);
  perform clued_private.ci_claim_current_v1(u,j,'result',g,node);
  select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=node;
  perform clued_private.ci_node_recheck_v1(n); t:=clock_timestamp();
  if j.current_generation is distinct from g or l.started_at is null or j.state not in ('started','observed','result_ready','publication_pending')
    or n.hardening_observed is not true or n.scan_signing_approved is not true or n.qualification_source is distinct from j.source_sha
    or n.qualification_receipt_ref is null or n.qualification_receipt_ref is distinct from data->>'qualification_ref' then
    raise exception 'CI_RESULT_SIGNER_NOT_APPROVED' using errcode='42501'; end if;
  if j.parent_job_id is not null then
    select * into parent from clued_private.ci_jobs_v1 where job_id=j.parent_job_id;
    select * into pl from clued_private.ci_job_leases_v1 where job_id=parent.job_id and generation=j.parent_lease_generation;
    perform clued_private.ci_claim_current_v1(u,parent,'result',j.parent_lease_generation,pl.holder_node_id);
    perform clued_private.ci_node_recheck_v1((select x from clued_private.ci_nodes_v1 x where x.user_id=u and x.project_id=p and x.node_id=pl.holder_node_id));
    if j.kind<>'delegated_scan' or parent.current_generation is distinct from j.parent_lease_generation
      or pl.state is distinct from 'current' or pl.expires_at<=t or pl.started_at is null
      or (j.head_sha,j.base_sha,j.test_sha,j.source_sha,j.combination_sha256,j.task_id,j.claim_id,j.execution_epoch)
        is distinct from (parent.head_sha,parent.base_sha,parent.test_sha,parent.source_sha,parent.combination_sha256,parent.task_id,parent.claim_id,parent.execution_epoch) then
      raise exception 'CI_PARENT_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  elsif j.kind<>'combination_execution' then raise exception 'CI_RESULT_JOB_INVALID' using errcode='42501'; end if;
  d:=clued_private.m1_sha256(jsonb_build_object('operation','result-register','user_id',u,'project_id',p,'node_id',node,'job_id',id,'generation',g,'payload',data-array['nonce_id','nonce']));
  fresh:=clued_private.ci_nonce_consume_v1(u,p,node,(data->>'nonce_id')::uuid,'result-register',d,id,g,data->>'nonce');
  if not fresh then
    select result_id into rid from clued_private.ci_result_index_v1 where user_id=u and project_id=p and job_id=id and execution_generation=g
      and producer_node_id=node and result_kind=data->>'result_kind' and result_digest=data->>'result_digest';
    if rid is null then raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if; return rid;
  end if;
  insert into clued_private.ci_result_index_v1(user_id,project_id,job_id,execution_generation,producer_node_id,result_kind,result_digest,certificate_digest,
    signature_envelope,source_sha,combination_sha256,qualification_ref,scanner_digest,rules_digest,vulnerability_db_digest,db_updated_at,db_next_update,produced_at,expires_at)
  values(u,p,id,g,node,data->>'result_kind',data->>'result_digest',data->>'certificate_digest',data->'signature_envelope',j.source_sha,j.combination_sha256,
    data->>'qualification_ref',data->>'scanner_digest',data->>'rules_digest',data->>'vulnerability_db_digest',(data->>'db_updated_at')::timestamptz,(data->>'db_next_update')::timestamptz,t,t+interval '10 minutes')
    returning result_id into rid;
  r:=clued_private.ci_receipt_v1(u,p,'ci_result_register',rid::text,jsonb_build_object('request_digest',d,'result_id',rid,'job_id',id,'generation',g));
  update clued_private.ci_result_index_v1 set receipt_id=r where result_id=rid;
  update clued_private.ci_nonce_ledger_v1 set consume_receipt_id=r where nonce_id=(data->>'nonce_id')::uuid;
  return rid;
end $$;
create function clued_private.ci_publisher_current_v1(u uuid,p uuid,node uuid,phase integer,operation text default 'admit') returns clued_private.ci_nodes_v1
language plpgsql volatile security definer set search_path='' as $$ declare n clued_private.ci_nodes_v1; begin
  n:=clued_private.ci_node_current_v1(u,p,node,true,operation);
  if phase<4 and not exists(select 1 from clued_private.binding_roles_v1 where user_id=u and binding_id=n.binding_id
    and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp() and purpose<>'parking') then
    raise exception 'CI_ACTIVE_PUBLISHER_REQUIRED' using errcode='42501'; end if; return n;
end $$;
create function clued_private.ci_publish_prepare_v1(u uuid,p uuid,node uuid,id uuid,g bigint,data jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.ci_jobs_v1; child clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1; childlease clued_private.ci_job_leases_v1;
  q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1; producer clued_private.ci_nodes_v1;
  k clued_private.ci_publish_keys_v1; result clued_private.ci_result_index_v1; train clued_private.ci_train_lease_v1;
  t timestamptz; w integer; keyid uuid; r uuid; d text; lockid uuid; producerid uuid; holderid uuid; fresh boolean; field text;
begin
  perform clued_private.ci_input_v1(data,array['check_name','request_digest','nonce_id','nonce','landing_window_seconds','train_generation','result_id','local_journal_clear','external_facts_digest'],
    array['check_name','request_digest','nonce_id','nonce','landing_window_seconds','external_facts_digest']);
  if u is null or p is null or node is null or id is null or g is null or g<=0
    or coalesce(data->>'check_name','') not in ('gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot')
    or coalesce(data->>'request_digest','') !~ '^[0-9a-f]{64}$' or coalesce(data->>'external_facts_digest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(data->'landing_window_seconds') is distinct from 'number' or coalesce(data->>'landing_window_seconds','') !~ '^[0-9]{3}$' then
    raise exception 'CI_PUBLICATION_INPUT_INVALID' using errcode='22023'; end if;
  w:=(data->>'landing_window_seconds')::integer;
  foreach field in array array['check_name','request_digest','external_facts_digest','nonce_id','nonce'] loop
    if jsonb_typeof(data->field) is distinct from 'string' then raise exception 'CI_PUBLICATION_INPUT_INVALID' using errcode='22023'; end if;
  end loop;
  if (data ? 'local_journal_clear' and jsonb_typeof(data->'local_journal_clear') is distinct from 'boolean')
    or (data ? 'train_generation' and (jsonb_typeof(data->'train_generation') is distinct from 'number' or coalesce(data->>'train_generation','') !~ '^[1-9][0-9]{0,17}$')) then
    raise exception 'CI_PUBLICATION_INPUT_INVALID' using errcode='22023'; end if;
  if w not between 151 and 600 then raise exception 'CI_LANDING_WINDOW_INVALID' using errcode='42501'; end if;
  d:=clued_private.m1_sha256(jsonb_build_object('operation','publish-reserve','user_id',u,'project_id',p,'node_id',node,'job_id',id,'generation',g,
    'payload',data-array['nonce_id','nonce','request_digest']));
  if d is distinct from data->>'request_digest' then raise exception 'CI_REQUEST_DIGEST_MISMATCH' using errcode='42501'; end if;
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  if not found then raise exception 'CI_JOB_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p);
  if coalesce(q.policy->>'mode','prepared')='prepared' then raise exception 'CI_SCHEDULING_NOT_ACTIVATED' using errcode='42501'; end if;
  select * into train from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for share;
  perform 1 from clued_private.ci_train_front_v1 where user_id=u and repository_id=j.repository_id for update;
  select * into l from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=id and generation=g;
  holderid:=l.holder_node_id;
  if holderid is null then raise exception 'CI_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  if data->>'check_name' in ('gitleaks','trivy','contract-placement') then
    select * into result from clued_private.ci_result_index_v1 where result_id=(data->>'result_id')::uuid and user_id=u and project_id=p;
    if not found then raise exception 'CI_RESULT_NOT_CURRENT' using errcode='42501'; end if;
    producerid:=result.producer_node_id;
    select * into child from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=result.job_id and repository_id=j.repository_id;
    if not found then raise exception 'CI_RESULT_NOT_CURRENT' using errcode='42501'; end if;
  end if;
  -- Discover the complete node set before taking any job/lease/result lock.
  for lockid in select distinct x from unnest(array[node,holderid,producerid]) x where x is not null order by x loop
    perform clued_private.ci_node_current_v1(u,p,lockid,false,'result');
  end loop;
  n:=clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer);
  for lockid in select distinct x from unnest(array[id,child.job_id]) x where x is not null order by x loop
    perform 1 from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=lockid for update;
    perform 1 from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=lockid
      and generation=case when lockid=id then g else result.execution_generation end for update;
  end loop;
  select * into j from clued_private.ci_jobs_v1 where job_id=id;
  select * into l from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=id and generation=g;
  perform clued_private.ci_claim_current_v1(u,j);
  perform 1 from clued_private.ci_nonce_ledger_v1 where nonce_id=(data->>'nonce_id')::uuid for update;
  select * into k from clued_private.ci_publish_keys_v1 where user_id=u and repository_id=j.repository_id and head_sha=j.head_sha
    and check_name=data->>'check_name' and app_id=5368905 for update;
  perform clued_private.ci_node_recheck_v1(n);
  perform clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer);
  if k.key_id is not null then
    if k.request_digest is distinct from d or k.job_id is distinct from id or k.execution_generation is distinct from g or k.publisher_node_id is distinct from node then
      raise exception 'CI_PUBLICATION_ALREADY_RESERVED' using errcode='23505'; end if;
    if clued_private.ci_nonce_consume_v1(u,p,node,(data->>'nonce_id')::uuid,'publish-reserve',d,id,g,data->>'nonce') then
      raise exception 'CI_PUBLICATION_ALREADY_RESERVED' using errcode='23505'; end if;
    return jsonb_build_object('key_id',k.key_id,'state',k.state,'external_id',k.external_id,'receipt_id',k.receipt_id,'replayed',true);
  end if;
  if producerid is not null then
    select * into result from clued_private.ci_result_index_v1 where result_id=(data->>'result_id')::uuid for share;
    select * into producer from clued_private.ci_nodes_v1 where node_id=producerid;
    select * into child from clued_private.ci_jobs_v1 where job_id=result.job_id;
    select * into childlease from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=child.job_id and generation=result.execution_generation;
    perform clued_private.ci_claim_current_v1(u,child); perform clued_private.ci_node_recheck_v1(producer);
    if result.producer_node_id is distinct from producerid or result.state<>'available' or result.result_kind is distinct from data->>'check_name'
      or result.source_sha is distinct from j.source_sha or result.combination_sha256 is distinct from j.combination_sha256
      or producer.hardening_observed is not true or producer.scan_signing_approved is not true
      or producer.qualification_source is distinct from j.source_sha or producer.qualification_receipt_ref is null
      or result.qualification_ref is distinct from producer.qualification_receipt_ref
      or child.current_generation is distinct from result.execution_generation or childlease.holder_node_id is distinct from producerid
      or childlease.state is distinct from 'current' or childlease.started_at is null
      or (child.head_sha,child.base_sha,child.test_sha,child.source_sha,child.combination_sha256,child.task_id,child.claim_id,child.execution_epoch)
        is distinct from (j.head_sha,j.base_sha,j.test_sha,j.source_sha,j.combination_sha256,j.task_id,j.claim_id,j.execution_epoch)
      or not ((child.job_id=id and result.execution_generation=g) or
        (child.kind='delegated_scan' and child.parent_job_id=id and child.parent_lease_generation=g)) then
      raise exception 'CI_RESULT_NOT_CURRENT' using errcode='42501'; end if;
  end if;
  t:=clock_timestamp();
  perform clued_private.ci_node_recheck_v1(n);
  perform clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer);
  perform clued_private.ci_node_recheck_v1((select x from clued_private.ci_nodes_v1 x where node_id=holderid));
  if n.state<>'active' or l.state is distinct from 'current' or l.holder_node_id is distinct from holderid
    or j.current_generation is distinct from g or l.expires_at<t+make_interval(secs=>w) or l.started_at is null then
    raise exception 'CI_LANDING_WINDOW_INVALID' using errcode='42501'; end if;
  if producerid is not null and (result.expires_at<=t or childlease.expires_at<=t or result.produced_at>t) then
    raise exception 'CI_RESULT_NOT_CURRENT' using errcode='42501'; end if;
  if producerid is not null and result.result_kind='trivy' and
    (result.db_updated_at is null or result.db_next_update is null or result.db_updated_at>t or result.db_next_update<=t) then
    raise exception 'CI_VULNERABILITY_DB_STALE' using errcode='42501'; end if;
  if data->>'check_name' in ('kooyumi-admission-verified','kooyumi-merge-slot') and (q.policy->>'phase')::integer>=4 then
    if train.state is distinct from 'active' or train.generation is distinct from (data->>'train_generation')::bigint
      or train.expires_at<t+make_interval(secs=>w) or train.sweep_state is distinct from 'complete' then
      raise exception 'CI_TRAIN_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  end if;
  if data->>'check_name'='kooyumi-merge-slot' and
    (coalesce((data->>'local_journal_clear')::boolean,false) is not true or exists(select 1 from clued_private.ci_green_ledger_v1
      where user_id=u and repository_id=j.repository_id and head_sha<>j.head_sha and state in ('proposed','posted','unknown','revoke_requested'))) then
    raise exception 'CI_OTHER_GREEN_EXISTS' using errcode='55000'; end if;
  fresh:=clued_private.ci_nonce_consume_v1(u,p,node,(data->>'nonce_id')::uuid,'publish-reserve',d,id,g,data->>'nonce');
  if not fresh then raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if;
  keyid:=extensions.gen_random_uuid();
  r:=clued_private.ci_receipt_v1(u,p,'ci_publish_reserve',keyid::text,jsonb_build_object('request_digest',d,'job_id',id,'generation',g,'check_name',data->>'check_name'));
  update clued_private.ci_nonce_ledger_v1 set consume_receipt_id=r where nonce_id=(data->>'nonce_id')::uuid;
  insert into clued_private.ci_publish_keys_v1(key_id,user_id,project_id,registration_ref,repository_id,head_sha,check_name,app_id,job_id,publisher_node_id,
    execution_generation,train_generation,request_digest,external_id,landing_deadline_at,receipt_id)
  values(keyid,u,p,j.registration_ref,j.repository_id,j.head_sha,data->>'check_name',5368905,id,node,g,(data->>'train_generation')::bigint,d,'clued-ci:'||keyid,t+make_interval(secs=>w),r) returning * into k;
  if k.check_name='kooyumi-merge-slot' then
    insert into clued_private.ci_green_ledger_v1(user_id,project_id,repository_id,head_sha,publish_key_id,job_id,publisher_node_id,train_generation,state,external_id,landing_deadline_at,receipt_id)
      values(u,p,j.repository_id,j.head_sha,k.key_id,id,node,k.train_generation,'proposed',k.external_id,k.landing_deadline_at,r);
  end if;
  return jsonb_build_object('key_id',k.key_id,'state',k.state,'external_id',k.external_id,'receipt_id',r,'replayed',false);
end $$;
create function clued_private.ci_publish_observe_v1(u uuid,p uuid,node uuid,keyid uuid,observation text,checkid bigint,digest text,nonce_id uuid default null,nonce_value text default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare k clued_private.ci_publish_keys_v1; q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1;
  t timestamptz; d text; r uuid; v jsonb; fresh boolean;
begin
  if u is null or p is null or node is null or keyid is null or observation is null or observation not in ('present','absent','error')
    or digest is null or digest !~ '^[0-9a-f]{64}$' or nonce_id is null then raise exception 'CI_OBSERVATION_INVALID' using errcode='22023'; end if;
  select * into k from clued_private.ci_publish_keys_v1 where key_id=keyid and user_id=u and project_id=p;
  if not found then raise exception 'CI_PUBLICATION_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,k.repository_id); q:=clued_private.ci_policy_v1(u,p);
  perform 1 from clued_private.ci_train_front_v1 where user_id=u and repository_id=k.repository_id for update;
  n:=clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer,'observe');
  perform 1 from clued_private.ci_jobs_v1 where job_id=k.job_id for update;
  perform 1 from clued_private.ci_nonce_ledger_v1 x where x.nonce_id=ci_publish_observe_v1.nonce_id for update;
  select * into k from clued_private.ci_publish_keys_v1 where key_id=keyid for update;
  perform 1 from clued_private.ci_green_ledger_v1 where publish_key_id=keyid for update;
  perform clued_private.ci_node_recheck_v1(n);
  perform clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer,'observe'); t:=clock_timestamp();
  d:=clued_private.m1_sha256(jsonb_build_object('operation','publish-observe','user_id',u,'project_id',p,'node_id',node,'job_id',k.job_id,'generation',k.execution_generation,
    'payload',jsonb_build_object('key_id',keyid,'external_id',k.external_id,'observation',observation,'check_run_id',checkid,'evidence_digest',digest)));
  fresh:=clued_private.ci_nonce_consume_v1(u,p,node,nonce_id,'publish-observe',d,k.job_id,k.execution_generation,nonce_value);
  if not fresh then
    select consume_receipt_id into r from clued_private.ci_nonce_ledger_v1 x where x.nonce_id=ci_publish_observe_v1.nonce_id;
    select metadata->'result' into v from public.clued_audit_receipts where id=r;
    if v is null then raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if;
    return v||jsonb_build_object('receipt_id',r,'replayed',true);
  end if;
  if observation='present' then
    if checkid is null or checkid<=0 or (k.check_run_id is not null and k.check_run_id<>checkid) then raise exception 'CI_CHECK_ID_CONFLICT' using errcode='22023'; end if;
    update clued_private.ci_publish_keys_v1 set state='posted',check_run_id=checkid,posted_at=coalesce(posted_at,t),observation_digest=digest where key_id=keyid;
    -- A later existence read cannot resurrect a merged or already revoked green.
    update clued_private.ci_green_ledger_v1 set state='posted',check_run_id=checkid,state_version=state_version+1,evidence_digest=digest
      where publish_key_id=keyid and state in ('proposed','unknown','abandoned');
  elsif k.state<>'posted' then
    update clued_private.ci_publish_keys_v1 set state='unknown',observation_digest=digest where key_id=keyid;
    update clued_private.ci_jobs_v1 set state='uncertain' where job_id=k.job_id;
    update clued_private.ci_green_ledger_v1 set state='unknown',state_version=state_version+1 where publish_key_id=keyid and state='proposed';
    if observation='absent' and t>=k.landing_deadline_at then
      if k.observation_1_at is null then
        update clued_private.ci_publish_keys_v1 set observation_1_at=t where key_id=keyid;
      elsif t>=k.observation_1_at+interval '30 seconds' then
        update clued_private.ci_publish_keys_v1 set observation_2_at=t where key_id=keyid;
        update clued_private.ci_green_ledger_v1 set state='abandoned',state_version=state_version+1 where publish_key_id=keyid and state='unknown';
      end if;
    end if;
  end if;
  v:=jsonb_build_object('state',(select state from clued_private.ci_publish_keys_v1 where key_id=keyid),
    'green_state',(select state from clued_private.ci_green_ledger_v1 where publish_key_id=keyid),'retry_post_allowed',false);
  r:=clued_private.ci_receipt_v1(u,p,'ci_publish_observe',keyid::text,jsonb_build_object('request_digest',d,'result',v));
  update clued_private.ci_publish_keys_v1 set receipt_id=r where key_id=keyid;
  update clued_private.ci_green_ledger_v1 set receipt_id=r where publish_key_id=keyid;
  update clued_private.ci_nonce_ledger_v1 x set consume_receipt_id=r where x.nonce_id=ci_publish_observe_v1.nonce_id;
  return v||jsonb_build_object('receipt_id',r,'replayed',false);
end $$;
create function clued_private.ci_green_transition_v1(u uuid,p uuid,node uuid,id uuid,v bigint,action text,evidence text,ancestor boolean default false,nonce_id uuid default null,nonce_value text default null) returns text
language plpgsql volatile security definer set search_path='' as $$
declare e clued_private.ci_green_ledger_v1; q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1;
  k clued_private.ci_publish_keys_v1; t timestamptz; nextstate text; d text; r uuid; fresh boolean;
begin
  if u is null or p is null or node is null or id is null or v is null or v<=0 or action is null
    or action not in ('revoke','confirm_failure','merged') or evidence is null or evidence !~ '^[0-9a-f]{64}$' or nonce_id is null then
    raise exception 'CI_GREEN_TRANSITION_INVALID' using errcode='22023'; end if;
  select * into e from clued_private.ci_green_ledger_v1 where user_id=u and project_id=p and entry_id=id;
  if not found then raise exception 'CI_GREEN_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,e.repository_id); q:=clued_private.ci_policy_v1(u,p);
  perform 1 from clued_private.ci_train_front_v1 where user_id=u and repository_id=e.repository_id for update;
  n:=clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer,'green');
  perform 1 from clued_private.ci_jobs_v1 where job_id=e.job_id for update;
  perform 1 from clued_private.ci_nonce_ledger_v1 x where x.nonce_id=ci_green_transition_v1.nonce_id for update;
  select * into k from clued_private.ci_publish_keys_v1 where key_id=e.publish_key_id for update;
  select * into e from clued_private.ci_green_ledger_v1 where entry_id=id for update;
  perform clued_private.ci_node_recheck_v1(n);
  perform clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer,'green'); t:=clock_timestamp();
  d:=clued_private.m1_sha256(jsonb_build_object('operation','green-transition','user_id',u,'project_id',p,'node_id',node,'job_id',e.job_id,'generation',k.execution_generation,
    'payload',jsonb_build_object('entry_id',id,'state_version',v,'action',action,'evidence_digest',evidence,'ancestor',ancestor)));
  fresh:=clued_private.ci_nonce_consume_v1(u,p,node,nonce_id,'green-transition',d,e.job_id,k.execution_generation,nonce_value);
  if not fresh then
    select a.metadata->>'state' into nextstate from clued_private.ci_nonce_ledger_v1 x join public.clued_audit_receipts a on a.id=x.consume_receipt_id
      where x.nonce_id=ci_green_transition_v1.nonce_id;
    if nextstate is null then raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if; return nextstate;
  end if;
  if e.state_version is distinct from v then raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  nextstate:=case when action='revoke' and e.state in ('proposed','posted','unknown') then 'revoke_requested'
    when action='confirm_failure' and e.state='revoke_requested' and e.revoke_requested_at<=t-interval '30 seconds' then 'revoke_confirmed'
    when action='merged' and e.state='posted' and ancestor is true then 'merged' end;
  if nextstate is null then raise exception 'CI_GREEN_TRANSITION_INVALID' using errcode='22023'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_green_transition',id::text,jsonb_build_object('request_digest',d,'state',nextstate,'evidence_digest',evidence));
  update clued_private.ci_green_ledger_v1 set state=nextstate,state_version=state_version+1,evidence_digest=evidence,receipt_id=r,
    revoke_requested_at=case when nextstate='revoke_requested' then t else revoke_requested_at end where entry_id=id;
  update clued_private.ci_nonce_ledger_v1 x set consume_receipt_id=r where x.nonce_id=ci_green_transition_v1.nonce_id;
  return nextstate;
end $$;

-- Rechecks only already locked business facts; never resolves authorization or
-- takes an earlier lock after a train/front/node/job wait.
create function clued_private.ci_train_request_current_v1(u uuid,p uuid,n clued_private.ci_nodes_v1,j clued_private.ci_jobs_v1) returns void
language plpgsql volatile security definer set search_path='' as $$ begin
  if j.job_id is null or j.user_id is distinct from u or j.project_id is distinct from p or j.kind<>'maintenance' or j.state<>'queued'
    or j.requested_node_id is distinct from n.node_id or n.user_id is distinct from u or n.project_id is distinct from p or n.state<>'active'
    or n.qualification_source is distinct from j.source_sha then raise exception 'CI_TRAIN_REQUEST_INVALID' using errcode='42501'; end if;
  perform clued_private.ci_claim_current_v1(u,j);
  perform clued_private.ci_node_recheck_v1(n);
end $$;
create function clued_private.ci_train_request_v1(u uuid,p uuid,node uuid,id uuid) returns uuid
language plpgsql volatile security definer set search_path='' as $$ declare q clued_private.ci_quota_counters_v1; j clued_private.ci_jobs_v1; n clued_private.ci_nodes_v1; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  if not found then raise exception 'CI_TRAIN_REQUEST_INVALID' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p);
  if (q.policy->>'phase')::integer<4 then raise exception 'CI_PHASE_NOT_ACTIVATED' using errcode='42501'; end if;
  n:=clued_private.ci_node_current_v1(u,p,node);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id and kind='maintenance' and state='queued' for update;
  if not found or j.requested_node_id is not null and j.requested_node_id<>node or n.qualification_source is distinct from j.source_sha then
    raise exception 'CI_TRAIN_REQUEST_INVALID' using errcode='22023'; end if;
  perform clued_private.ci_claim_current_v1(u,j); perform clued_private.ci_node_recheck_v1(n);
  if j.requested_node_id=node then return id; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_train_request',id::text,jsonb_build_object('node_id',node));
  update clued_private.ci_jobs_v1 set requested_node_id=node,receipt_id=r,version=version+1 where job_id=id;
  return id;
end $$;
create function clued_private.ci_train_acquire_v1(u uuid,p uuid,node uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1; l clued_private.ci_train_lease_v1; j clued_private.ci_jobs_v1; own clued_private.ci_jobs_v1; t timestamptz; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into own from clued_private.ci_jobs_v1 where user_id=u and project_id=p and kind='maintenance' and state='queued' and requested_node_id=node order by created_at,job_id limit 1;
  if own.job_id is not null then perform clued_private.ci_repo_v1(u,p,own.repository_id); end if;
  q:=clued_private.ci_policy_v1(u,p);
  if (q.policy->>'phase')::integer<4 then raise exception 'CI_PHASE_NOT_ACTIVATED' using errcode='42501'; end if;
  if own.job_id is null then raise exception 'CI_TRAIN_REQUEST_REQUIRED' using errcode='42501'; end if;
  insert into clued_private.ci_train_lease_v1(user_id,project_id) values(u,p) on conflict do nothing;
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  n:=clued_private.ci_node_current_v1(u,p,node);
  select * into own from clued_private.ci_jobs_v1 where job_id=own.job_id for update;
  perform clued_private.ci_train_request_current_v1(u,p,n,own); t:=clock_timestamp();
  if l.holder_node_id is not null and l.expires_at>t then raise exception 'CI_TRAIN_HELD' using errcode='55000'; end if;
  if l.holder_node_id is not null then
    update clued_private.ci_train_lease_v1 set state='silence',ended_at=expires_at,silence_until=expires_at+interval '5 minutes',
      last_holder_node_id=holder_node_id,last_lost_at=expires_at,holder_node_id=null,holder_binding_id=null where user_id=u and project_id=p returning * into l;
  end if;
  if l.silence_until>t then raise exception 'CI_TRAIN_SILENCE' using errcode='55000'; end if;
  if l.last_holder_node_id=node and l.last_lost_at>t-interval '30 minutes' then
    for j in select candidate.* from clued_private.ci_jobs_v1 candidate
      join clued_private.ci_nodes_v1 other on other.user_id=candidate.user_id and other.project_id=candidate.project_id
        and other.node_id=candidate.requested_node_id and other.node_id<>node
      join public.clued_agent_bindings b on b.id=other.binding_id and b.user_id=other.user_id
      where candidate.user_id=u and candidate.project_id=p and candidate.kind='maintenance' and candidate.state='queued'
        and other.state='active' and other.qualification_status='verified' and other.qualification_expires_at>t
        and other.eligible_until>t and other.qualification_source=candidate.source_sha and clued_private.binding_live_v1(b)
    loop
      begin
        perform clued_private.ci_claim_current_v1(u,j);
      exception when sqlstate '42501' or sqlstate '22023' then continue;
      end;
      raise exception 'CI_TRAIN_DEBOUNCE' using errcode='55000';
    end loop;
  end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_train_acquire',p::text,jsonb_build_object('generation',l.generation+1,'node_id',node,'request_job_id',own.job_id));
  update clued_private.ci_train_lease_v1 set generation=generation+1,lease_version=1,holder_node_id=node,holder_binding_id=n.binding_id,request_job_id=own.job_id,receipt_id=r,
    state='sweep_required',issued_at=t,expires_at=least(t+interval '10 minutes',n.eligible_until,n.qualification_expires_at,
      (select expires_at from clued_private.work_claims_v1 where claim_id=own.claim_id)),
    sweep_state='incomplete',sweep_generation=null,sweep_evidence_digest=null where user_id=u and project_id=p returning * into l;
  return jsonb_build_object('generation',l.generation,'lease_version',l.lease_version,'state',l.state,'expires_at',l.expires_at,'receipt_id',r);
end $$;
create function clued_private.ci_train_renew_v1(u uuid,p uuid,node uuid,g bigint,v bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare l clued_private.ci_train_lease_v1; n clued_private.ci_nodes_v1; j clued_private.ci_jobs_v1; r uuid; t timestamptz; begin
  perform clued_private.work_claim_lock(u);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p;
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=l.request_job_id;
  if j.job_id is null then raise exception 'CI_TRAIN_REQUEST_REQUIRED' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); perform clued_private.ci_policy_v1(u,p);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  if g is null or v is null or l.holder_node_id is distinct from node or l.generation is distinct from g or l.lease_version is distinct from v then
    raise exception 'CI_TRAIN_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  if l.request_job_id is distinct from j.job_id then raise exception 'CI_TRAIN_REQUEST_INVALID' using errcode='42501'; end if;
  n:=clued_private.ci_node_current_v1(u,p,node);
  select * into j from clued_private.ci_jobs_v1 where job_id=j.job_id for update;
  perform clued_private.ci_train_request_current_v1(u,p,n,j); t:=clock_timestamp();
  if g is null or v is null or l.holder_node_id is distinct from node or l.holder_binding_id is distinct from n.binding_id
    or l.generation is distinct from g or l.lease_version is distinct from v or l.expires_at is null or l.expires_at<=t then
    raise exception 'CI_TRAIN_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_train_renew',p::text,jsonb_build_object('generation',g,'lease_version',v+1));
  update clued_private.ci_train_lease_v1 set lease_version=lease_version+1,receipt_id=r,
    expires_at=least(t+interval '10 minutes',n.eligible_until,n.qualification_expires_at,
      (select expires_at from clued_private.work_claims_v1 where claim_id=j.claim_id)) where user_id=u and project_id=p returning * into l;
  return jsonb_build_object('generation',g,'lease_version',l.lease_version,'expires_at',l.expires_at,'receipt_id',r);
end $$;
create function clued_private.ci_train_release_v1(u uuid,p uuid,node uuid,g bigint) returns timestamptz
language plpgsql volatile security definer set search_path='' as $$ declare l clued_private.ci_train_lease_v1; t timestamptz; r uuid; begin
  perform clued_private.ci_policy_v1(u,p);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  t:=clock_timestamp();
  if g is null or l.holder_node_id is distinct from node or l.generation is distinct from g then raise exception 'CI_TRAIN_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_train_release',p::text,jsonb_build_object('generation',g,'node_id',node,'silence_until',least(t,l.expires_at)+interval '5 minutes'));
  update clued_private.ci_train_lease_v1 set state='silence',receipt_id=r,ended_at=least(t,expires_at),silence_until=least(t,expires_at)+interval '5 minutes',
    last_holder_node_id=node,last_lost_at=t,holder_node_id=null,holder_binding_id=null,sweep_state='incomplete' where user_id=u and project_id=p;
  return least(t,l.expires_at)+interval '5 minutes';
end $$;
create function clued_private.ci_train_sweep_confirm_v1(u uuid,p uuid,node uuid,g bigint,digest text) returns void
language plpgsql volatile security definer set search_path='' as $$ declare r uuid; l clued_private.ci_train_lease_v1; j clued_private.ci_jobs_v1; n clued_private.ci_nodes_v1; t timestamptz; begin
  perform clued_private.work_claim_lock(u);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p;
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=l.request_job_id;
  if j.job_id is null then raise exception 'CI_TRAIN_REQUEST_REQUIRED' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); perform clued_private.ci_policy_v1(u,p);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  if l.request_job_id is distinct from j.job_id then raise exception 'CI_TRAIN_REQUEST_INVALID' using errcode='42501'; end if;
  n:=clued_private.ci_node_current_v1(u,p,node);
  select * into j from clued_private.ci_jobs_v1 where job_id=j.job_id for update;
  perform clued_private.ci_train_request_current_v1(u,p,n,j); t:=clock_timestamp();
  if g is null or l.holder_node_id is distinct from node or l.holder_binding_id is distinct from n.binding_id or l.generation is distinct from g
    or l.expires_at is null or l.expires_at<=t or l.state<>'sweep_required' then raise exception 'CI_TRAIN_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  if coalesce(digest,'') !~ '^[0-9a-f]{64}$' then raise exception 'CI_SWEEP_EVIDENCE_INVALID' using errcode='22023'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_train_sweep',p::text,jsonb_build_object('generation',g,'evidence_digest',digest));
  update clued_private.ci_train_lease_v1 set state='active',sweep_state='complete',sweep_generation=g,sweep_evidence_digest=digest,receipt_id=r
    where user_id=u and project_id=p and holder_node_id=node and generation=g and expires_at>clock_timestamp() and state='sweep_required';
  if not found then raise exception 'CI_TRAIN_LEASE_NOT_CURRENT' using errcode='42501'; end if;
end $$;
create function clued_private.ci_train_front_set_v1(u uuid,p uuid,node uuid,g bigint,repo bigint,v bigint,id uuid) returns bigint
language plpgsql volatile security definer set search_path='' as $$ declare j clued_private.ci_jobs_v1; own clued_private.ci_jobs_v1; f clued_private.ci_train_front_v1;
  l clued_private.ci_train_lease_v1; n clued_private.ci_nodes_v1; r uuid; lockid uuid; repoid bigint; t timestamptz; begin
  perform clued_private.work_claim_lock(u);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p;
  select * into own from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=l.request_job_id;
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id and repository_id=repo;
  if own.job_id is null or j.job_id is null then raise exception 'CI_TRAIN_REQUEST_REQUIRED' using errcode='42501'; end if;
  for repoid in select distinct x from unnest(array[repo,own.repository_id])x order by x loop perform clued_private.ci_repo_v1(u,p,repoid); end loop;
  perform clued_private.ci_policy_v1(u,p);
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  if l.request_job_id is distinct from own.job_id then raise exception 'CI_TRAIN_REQUEST_INVALID' using errcode='42501'; end if;
  select * into f from clued_private.ci_train_front_v1 where user_id=u and repository_id=repo for update;
  n:=clued_private.ci_node_current_v1(u,p,node);
  for lockid in select distinct x from unnest(array[id,own.job_id])x order by x loop
    perform 1 from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=lockid for update;
  end loop;
  select * into own from clued_private.ci_jobs_v1 where job_id=own.job_id;
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id and repository_id=repo;
  perform clued_private.ci_train_request_current_v1(u,p,n,own);
  if j.job_id is null or n.qualification_source is distinct from j.source_sha then raise exception 'CI_SOURCE_NOT_ACCEPTED' using errcode='42501'; end if;
  perform clued_private.ci_claim_current_v1(u,j); perform clued_private.ci_node_recheck_v1(n); t:=clock_timestamp();
  if g is null or l.holder_node_id is distinct from node or l.holder_binding_id is distinct from n.binding_id or l.generation is distinct from g
    or l.state<>'active' or l.sweep_state<>'complete' or l.sweep_generation is distinct from g or l.expires_at is null or l.expires_at<=t then
    raise exception 'TRAIN_SWEEP_INCOMPLETE' using errcode='42501'; end if;
  if v is null or f.front_version is distinct from v then raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_train_front',repo::text,jsonb_build_object('generation',g,'front_version',v+1,'job_id',id));
  update clued_private.ci_train_front_v1 set front_version=front_version+1,train_generation=g,state='front',head_job_id=id,receipt_id=r,
    head_sha=j.head_sha,base_sha=j.base_sha,test_sha=j.test_sha,combination_sha256=j.combination_sha256,claim_id=j.claim_id,
    claim_fence=j.claim_fence,execution_epoch=j.execution_epoch,front_observed_at=clock_timestamp() where user_id=u and repository_id=repo;
  return v+1;
end $$;

create function clued_private.ci_sealed_drop_send_v1(u uuid,p uuid,node uuid,id uuid,g bigint,data jsonb) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.ci_jobs_v1; q clued_private.ci_quota_counters_v1; sender clued_private.ci_nodes_v1; target clued_private.ci_nodes_v1;
  l clued_private.ci_job_leases_v1; prior clued_private.ci_sealed_drop_v1; copy clued_private.ci_sealed_drop_v1;
  groupid uuid; bytes bytea; t timestamptz; exp timestamptz; created timestamptz; ttl integer; d text; r uuid; lockid uuid; fresh boolean; field text;
begin
  perform clued_private.ci_input_v1(data,array['request_group_id','request_digest','purpose','recipient_node_id','recipient_fingerprint','ciphertext_base64','ciphertext_sha256','crypto_envelope_version','ttl_seconds','train_generation','nonce_id','nonce'],
    array['request_group_id','request_digest','purpose','recipient_node_id','recipient_fingerprint','ciphertext_base64','ciphertext_sha256','crypto_envelope_version','ttl_seconds','nonce_id','nonce'],98304);
  if u is null or p is null or node is null or id is null or g is null or g<=0
    or coalesce(data->>'request_digest','') !~ '^[0-9a-f]{64}$' or coalesce(data->>'ciphertext_sha256','') !~ '^[0-9a-f]{64}$'
    or coalesce(data->>'recipient_fingerprint','') !~ '^[0-9a-f]{64}$' or data->>'purpose' is distinct from 'publish-request'
    or jsonb_typeof(data->'ciphertext_base64') is distinct from 'string' or length(data->>'ciphertext_base64')>87384
    or coalesce(data->>'crypto_envelope_version','') !~ '^[A-Za-z0-9._/-]{1,80}$'
    or jsonb_typeof(data->'ttl_seconds') is distinct from 'number' or coalesce(data->>'ttl_seconds','') !~ '^[0-9]{1,4}$' then
    raise exception 'CI_DROP_INPUT_INVALID' using errcode='22023'; end if;
  ttl:=(data->>'ttl_seconds')::integer;
  foreach field in array array['request_group_id','request_digest','purpose','recipient_node_id','recipient_fingerprint','ciphertext_base64','ciphertext_sha256','crypto_envelope_version','nonce_id','nonce'] loop
    if jsonb_typeof(data->field) is distinct from 'string' then raise exception 'CI_DROP_INPUT_INVALID' using errcode='22023'; end if;
  end loop;
  if data ? 'train_generation' and (jsonb_typeof(data->'train_generation') is distinct from 'number' or coalesce(data->>'train_generation','') !~ '^[1-9][0-9]{0,17}$') then
    raise exception 'CI_DROP_INPUT_INVALID' using errcode='22023'; end if;
  if ttl not between 1 and 3600 then raise exception 'CI_DROP_RECIPIENT_INVALID' using errcode='22023'; end if;
  groupid:=(data->>'request_group_id')::uuid;
  bytes:=decode(data->>'ciphertext_base64','base64');
  if octet_length(bytes) not between 1 and 65536 or encode(extensions.digest(bytes,'sha256'),'hex') is distinct from data->>'ciphertext_sha256' then
    raise exception 'CI_DROP_SIZE_OR_DIGEST_INVALID' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  if not found then raise exception 'CI_JOB_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p);
  if coalesce(q.policy->>'mode','prepared')='prepared' then raise exception 'CI_SCHEDULING_NOT_ACTIVATED' using errcode='42501'; end if;
  for lockid in select distinct x from unnest(array[node,(data->>'recipient_node_id')::uuid]) x where x is not null order by x loop
    perform clued_private.ci_node_current_v1(u,p,lockid);
  end loop;
  select * into sender from clued_private.ci_nodes_v1 where node_id=node;
  target:=clued_private.ci_publisher_current_v1(u,p,(data->>'recipient_node_id')::uuid,(q.policy->>'phase')::integer);
  perform 1 from clued_private.ci_jobs_v1 where job_id=id for update;
  l:=clued_private.ci_lease_current_v1(u,p,id,g,node);
  perform clued_private.ci_claim_current_v1(u,j);
  if j.current_generation is distinct from g or sender.qualification_source is distinct from j.source_sha
    or target.encryption_fingerprint is distinct from data->>'recipient_fingerprint' then
    raise exception 'CI_DROP_RECIPIENT_INVALID' using errcode='42501'; end if;
  d:=clued_private.m1_sha256(jsonb_build_object('operation','drop-send','user_id',u,'project_id',p,'node_id',node,'job_id',id,'generation',g,
    'payload',data-array['nonce_id','nonce']));
  perform 1 from clued_private.ci_nonce_ledger_v1 where nonce_id=(data->>'nonce_id')::uuid for update;
  perform pg_advisory_xact_lock(hashtextextended('ci-drop:'||u||':'||groupid,0));
  perform clued_private.ci_node_recheck_v1(sender); perform clued_private.ci_node_recheck_v1(target);
  perform clued_private.ci_publisher_current_v1(u,p,target.node_id,(q.policy->>'phase')::integer);
  t:=clock_timestamp();
  if l.expires_at<=t then raise exception 'CI_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  fresh:=clued_private.ci_nonce_consume_v1(u,p,node,(data->>'nonce_id')::uuid,'drop-send',d,id,g,data->>'nonce');
  select * into copy from clued_private.ci_sealed_drop_v1 where user_id=u and request_group_id=groupid and recipient_node_id=target.node_id for update;
  if not fresh then
    if copy.drop_id is null or copy.project_id is distinct from p or copy.job_id is distinct from id or copy.execution_generation is distinct from g then
      raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if; return groupid;
  end if;
  select * into prior from clued_private.ci_sealed_drop_v1 where user_id=u and request_group_id=groupid order by recipient_node_id limit 1;
  if prior.drop_id is null and exists(select 1 from clued_private.ci_sealed_drop_v1 x where x.user_id=u and x.project_id=p and x.job_id=id
    and x.execution_generation=g and x.request_digest=data->>'request_digest' and x.request_group_id<>groupid) then
    raise exception 'CI_DROP_REQUEST_ALREADY_BOUND' using errcode='42501'; end if;
  if prior.drop_id is not null then
    if (prior.project_id,prior.job_id,prior.execution_generation,prior.sender_node_id,prior.request_digest,prior.purpose,prior.crypto_envelope_version,prior.train_generation)
      is distinct from (p,id,g,node,data->>'request_digest',data->>'purpose',data->>'crypto_envelope_version',(data->>'train_generation')::bigint)
      or prior.expires_at<>prior.created_at+make_interval(secs=>ttl) or prior.state<>'pending' or prior.expires_at<=t then
      raise exception 'CI_DROP_GROUP_CLOSED_OR_CONFLICT' using errcode='42501'; end if;
    created:=prior.created_at; exp:=prior.expires_at;
  else created:=t; exp:=t+make_interval(secs=>ttl); end if;
  if copy.drop_id is not null then
    if copy.recipient_fingerprint is distinct from target.encryption_fingerprint or copy.ciphertext_sha256 is distinct from data->>'ciphertext_sha256'
      or copy.crypto_envelope_version is distinct from data->>'crypto_envelope_version' then
      raise exception 'CI_DROP_GROUP_CLOSED_OR_CONFLICT' using errcode='42501'; end if;
    return groupid;
  end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_drop_send',groupid::text,jsonb_build_object('request_digest',d,'recipient_node_id',target.node_id,'ciphertext_sha256',data->>'ciphertext_sha256'));
  insert into clued_private.ci_sealed_drop_v1(user_id,project_id,request_group_id,request_digest,purpose,sender_node_id,recipient_node_id,recipient_fingerprint,
    job_id,execution_generation,train_generation,ciphertext,ciphertext_sha256,crypto_envelope_version,created_at,expires_at,receipt_id)
  values(u,p,groupid,data->>'request_digest',data->>'purpose',node,target.node_id,target.encryption_fingerprint,id,g,(data->>'train_generation')::bigint,
    bytes,data->>'ciphertext_sha256',data->>'crypto_envelope_version',created,exp,r);
  update clued_private.ci_nonce_ledger_v1 set consume_receipt_id=r where nonce_id=(data->>'nonce_id')::uuid;
  return groupid;
end $$;
create function clued_private.ci_sealed_drop_take_v1(u uuid,p uuid,node uuid,groupid uuid,nonceid uuid default null,nonce_value text default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare d clued_private.ci_sealed_drop_v1; j clued_private.ci_jobs_v1; q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1;
  sender clued_private.ci_nodes_v1; l clued_private.ci_job_leases_v1; r uuid; intent text; fresh boolean; lockid uuid;
begin
  if u is null or p is null or node is null or groupid is null or nonceid is null then raise exception 'CI_DROP_NOT_AVAILABLE' using errcode='42501'; end if;
  perform clued_private.work_claim_lock(u);
  select * into d from clued_private.ci_sealed_drop_v1 where user_id=u and project_id=p and request_group_id=groupid and recipient_node_id=node;
  if not found then raise exception 'CI_DROP_NOT_AVAILABLE' using errcode='42501'; end if;
  select * into j from clued_private.ci_jobs_v1 where job_id=d.job_id and user_id=u and project_id=p;
  if not found then raise exception 'CI_DROP_NOT_AVAILABLE' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); q:=clued_private.ci_policy_v1(u,p);
  for lockid in select distinct x from unnest(array[node,d.sender_node_id]) x where x is not null order by x loop
    perform clued_private.ci_node_current_v1(u,p,lockid,false,case when lockid=node then 'admit' else 'result' end);
  end loop;
  n:=clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer);
  select * into sender from clued_private.ci_nodes_v1 where node_id=d.sender_node_id;
  select * into j from clued_private.ci_jobs_v1 where job_id=d.job_id for update;
  l:=clued_private.ci_lease_current_v1(u,p,d.job_id,d.execution_generation,d.sender_node_id);
  perform clued_private.ci_claim_current_v1(u,j);
  perform 1 from clued_private.ci_nonce_ledger_v1 where nonce_id=nonceid for update;
  perform pg_advisory_xact_lock(hashtextextended('ci-drop:'||u||':'||groupid,0));
  select * into d from clued_private.ci_sealed_drop_v1 where user_id=u and project_id=p and request_group_id=groupid and recipient_node_id=node for update;
  perform clued_private.ci_node_recheck_v1(n); perform clued_private.ci_node_recheck_v1(sender);
  perform clued_private.ci_publisher_current_v1(u,p,node,(q.policy->>'phase')::integer);
  if j.current_generation is distinct from d.execution_generation or l.expires_at<=clock_timestamp() then raise exception 'CI_LEASE_NOT_CURRENT' using errcode='42501'; end if;
  intent:=clued_private.m1_sha256(jsonb_build_object('operation','drop-take','user_id',u,'project_id',p,'node_id',node,'job_id',d.job_id,'generation',d.execution_generation,
    'payload',jsonb_build_object('request_group_id',groupid,'request_digest',d.request_digest,'recipient_fingerprint',d.recipient_fingerprint)));
  fresh:=clued_private.ci_nonce_consume_v1(u,p,node,nonceid,'drop-take',intent,d.job_id,d.execution_generation,nonce_value);
  if not fresh then
    if d.claim_receipt_id is null then raise exception 'CI_NONCE_REPLAY' using errcode='42501'; end if;
    return jsonb_build_object('status','consumed','receipt_id',d.claim_receipt_id,'replayed',true);
  end if;
  if d.state<>'pending' or d.expires_at<=clock_timestamp() or d.recipient_fingerprint is distinct from n.encryption_fingerprint then
    raise exception 'CI_DROP_NOT_AVAILABLE' using errcode='42501'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_drop_claim',groupid::text,jsonb_build_object('claimed_by',node,'ciphertext_digest',d.ciphertext_sha256,'request_digest',intent));
  update clued_private.ci_sealed_drop_v1 set state='consumed',ciphertext=null,claimed_by=node,claim_receipt_id=r where user_id=u and request_group_id=groupid;
  update clued_private.ci_nonce_ledger_v1 set consume_receipt_id=r where nonce_id=nonceid;
  return jsonb_build_object('status','consumed','ciphertext_base64',encode(d.ciphertext,'base64'),'ciphertext_sha256',d.ciphertext_sha256,'receipt_id',r,'replayed',false);
end $$;
create function clued_private.ci_node_dispatch_v1(p_input jsonb) returns jsonb
language sql immutable set search_path='' as $$ select '{"status":"rejected","error_code":"SIGNATURE_GATEWAY_NOT_ACTIVATED","authoritative":false}'::jsonb $$;

-- Explicit list only: do not alter any existing private CI/authorization ACL.
do $function_acl$ declare s regprocedure; begin
  for s in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='clued_private' and p.proname=any(array['ci_input_v1','ci_native_owner_v1','ci_native_recheck_v1','ci_receipt_v1','ci_policy_v1','ci_repo_v1',
      'ci_permanent_guard_v1','ci_jwk_v1','ci_jwk_fingerprint_v1','ci_profile_v1','ci_public_metadata_v1','ci_node_view_v1','ci_pool_view_v1','ci_confirmation_view_v1','ci_issue_v1','ci_apply_v1',
      'ci_node_current_v1','ci_node_recheck_v1','ci_claim_current_v1','ci_usage_count_v1','ci_quota_check_v1','ci_event_v1','ci_job_enqueue_v1','ci_job_lease_v1','ci_lease_current_v1',
      'ci_job_renew_v1','ci_job_started_v1','ci_job_release_v1','ci_stage8_try_begin_v1','ci_nonce_issue_v1','ci_nonce_consume_v1','ci_result_register_v1',
      'ci_publisher_current_v1','ci_publish_prepare_v1','ci_publish_observe_v1','ci_green_transition_v1','ci_train_request_current_v1','ci_train_request_v1','ci_train_acquire_v1',
      'ci_train_renew_v1','ci_train_release_v1','ci_train_sweep_confirm_v1','ci_train_front_set_v1','ci_sealed_drop_send_v1','ci_sealed_drop_take_v1','ci_node_dispatch_v1']))
    or (n.nspname='public' and p.proname=any(array['clued_ci_nodes_v1','clued_ci_node_registration_v1','clued_ci_node_confirmation_issue_v1','clued_ci_node_apply_v1','clued_ci_pool_confirmation_issue_v1','clued_ci_pool_apply_v1'])) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,clued_worker_gateway',s);
  end loop;
end $function_acl$;
grant execute on function public.clued_ci_nodes_v1(jsonb),public.clued_ci_node_registration_v1(jsonb),
  public.clued_ci_node_confirmation_issue_v1(jsonb),public.clued_ci_node_apply_v1(jsonb),
  public.clued_ci_pool_confirmation_issue_v1(jsonb),public.clued_ci_pool_apply_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
