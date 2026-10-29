-- Native617: represent an actual independent job without inventing an Actions run.
-- Registration only: no execution-policy activation, consumer qualification,
-- role grant, existing claim mutation or automatic publication occurs here.
-- The independent consumer remains disabled until its complete publisher,
-- revoker and stop/recovery path has been qualified and separately activated.

create function clued_private.work_claim_independent_identity_valid_v1(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare j jsonb; c jsonb; k text; check_name text; job_text text; effect_text text;
  effect_hash text; key_hash text; expected_key text;
begin
  if jsonb_typeof(v) is distinct from 'object'
    or not(v ?& array['schema','provider','job','claim','app_id','check_name','controller_id','effect_key','publication_key'])
    or v-array['schema','provider','job','claim','app_id','check_name','controller_id','effect_key','publication_key']<>'{}'::jsonb
    or v->>'schema' is distinct from 'clued.independent-ci.publication-identity/1'
    or v->>'provider' is distinct from 'independent-ci' or v->'app_id' is distinct from '5368905'::jsonb then return false; end if;
  foreach k in array array['schema','provider','check_name','controller_id','effect_key','publication_key'] loop
    if jsonb_typeof(v->k) is distinct from 'string' then return false; end if;
  end loop;
  if v->>'controller_id' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then return false; end if;
  j:=v->'job'; c:=v->'claim';
  if jsonb_typeof(j) is distinct from 'object'
    or not(j ?& array['contract','id','repo','pr','headSha','baseSha','testSha','role','sourceManifestSha256','createdAt','attempt'])
    or j-array['contract','id','repo','pr','headSha','baseSha','testSha','role','sourceManifestSha256','createdAt','attempt']<>'{}'::jsonb
    or jsonb_typeof(c) is distinct from 'object' or not(c ?& array['claim_id','fence','execution_epoch'])
    or c-array['claim_id','fence','execution_epoch']<>'{}'::jsonb then return false; end if;
  foreach k in array array['contract','id','repo','headSha','baseSha','testSha','role','sourceManifestSha256','createdAt'] loop
    if jsonb_typeof(j->k) is distinct from 'string' then return false; end if;
  end loop;
  if j->>'contract' is distinct from 'clued.independent-ci.job/3'
    or j->>'repo' is distinct from 'tdoljyj/cross-memory-system'
    or j->>'id' !~ '^[0-9a-f]{64}$' or j->>'sourceManifestSha256' !~ '^[0-9a-f]{64}$'
    or j->>'headSha' !~ '^[0-9a-f]{40}$' or j->>'baseSha' !~ '^[0-9a-f]{40}$' or j->>'testSha' !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(j->'pr') is distinct from 'number' or j->>'pr' !~ '^[1-9][0-9]{0,9}$'
    or jsonb_typeof(j->'attempt') is distinct from 'number' or j->>'attempt' !~ '^[12]$'
    or j->>'createdAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$'
    or length(j->>'createdAt')>40 then return false; end if;
  perform (j->>'createdAt')::timestamptz;
  if jsonb_typeof(c->'claim_id') is distinct from 'string'
    or c->>'claim_id' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then return false; end if;
  foreach k in array array['fence','execution_epoch'] loop
    if jsonb_typeof(c->k) is distinct from 'number' or c->>k !~ '^[1-9][0-9]{0,15}$'
      or (c->>k)::numeric>9007199254740991 then return false; end if;
  end loop;
  check_name:=case j->>'role' when 'work-admission' then 'kooyumi-work-admission'
    when 'gitleaks' then 'gitleaks' when 'trivy' then 'trivy' when 'contract-placement' then 'contract-placement'
    when 'control-admission' then 'kooyumi-admission-verified' when 'control-merge-slot' then 'kooyumi-merge-slot' end;
  if check_name is null or v->>'check_name' is distinct from check_name then return false; end if;
  -- Match job-v2.mjs's job/3 JSON array exactly; every string has already
  -- been restricted to a finite role, fixed repository, or lower-case hex.
  job_text:='["clued.independent-ci.job/3",'||concat_ws(',',to_jsonb(j->>'repo')::text,j->>'pr',
    to_jsonb(j->>'headSha')::text,to_jsonb(j->>'baseSha')::text,to_jsonb(j->>'testSha')::text,
    to_jsonb(j->>'sourceManifestSha256')::text,to_jsonb(j->>'role')::text,j->>'attempt')||']';
  if encode(extensions.digest(convert_to(job_text,'UTF8'),'sha256'),'hex')<>j->>'id' then return false; end if;
  effect_text:='{"action":"native-independent-publication/1","app_id":5368905,"check_name":'||to_jsonb(check_name)::text;
  if j->>'role' not in ('gitleaks','trivy','contract-placement') then
    effect_text:=effect_text||',"claim":{"claim_id":'||to_jsonb(c->>'claim_id')::text
      ||',"execution_epoch":'||(c->>'execution_epoch')||',"fence":'||(c->>'fence')||'}';
  end if;
  effect_text:=effect_text||',"job_id":'||to_jsonb(j->>'id')::text||'}';
  effect_hash:=encode(extensions.digest(convert_to(effect_text,'UTF8'),'sha256'),'hex');
  key_hash:=left(encode(extensions.digest(convert_to('{"action":"native-independent-publication-key/1","effect_key":'
    ||to_jsonb(effect_hash)::text||'}','UTF8'),'sha256'),'hex'),32);
  expected_key:=substr(key_hash,1,8)||'-'||substr(key_hash,9,4)||'-'||substr(key_hash,13,4)||'-'||substr(key_hash,17,4)||'-'||substr(key_hash,21,12);
  return v->>'effect_key'=effect_hash and v->>'publication_key'=expected_key;
exception when data_exception then return false;
end $$;
revoke all on function clued_private.work_claim_independent_identity_valid_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

create table clued_private.work_claim_independent_consumer_v1 (
  singleton boolean primary key default true check(singleton),
  activated_at timestamptz,
  qualification_commit text check(qualification_commit is null or qualification_commit ~ '^[0-9a-f]{40}$'),
  source_manifest_sha256 text check(source_manifest_sha256 is null or source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  ci_principal_binding_id uuid references public.clued_agent_bindings(id),
  check(activated_at is null or (qualification_commit is not null and source_manifest_sha256 is not null and ci_principal_binding_id is not null))
);
insert into clued_private.work_claim_independent_consumer_v1(singleton) values(true);
alter table clued_private.work_claim_independent_consumer_v1 enable row level security;
revoke all on clued_private.work_claim_independent_consumer_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

alter table clued_private.work_claim_publications_v1 add column independent_identity jsonb;
alter table clued_private.work_claim_publications_v1 alter column run_id drop not null;
-- The old numeric-run constraint remains. SQL NULL does not turn a local job
-- into an Actions run; the disjoint shape constraint supplies the other half.
alter table clued_private.work_claim_publications_v1 add constraint work_claim_publication_provider_shape_v1 check(
  (independent_identity is null and run_id is not null)
  or (independent_identity is not null and run_id is null
    and clued_private.work_claim_independent_identity_valid_v1(independent_identity))
);
create unique index work_claim_independent_effect_once_v1 on clued_private.work_claim_publications_v1
  (user_id,(independent_identity->>'effect_key')) where independent_identity is not null;

create function clued_private.work_claim_independent_begin_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1; p clued_private.work_claim_publications_v1;
  policy clued_private.work_claim_independent_consumer_v1; identity jsonb:=p_input->'independent_identity';
  j jsonb; generation jsonb; result jsonb; receipt uuid; id uuid; replayed boolean:=false;
  scope text:=coalesce(p_input->>'scope','global');
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp()) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  perform clued_private.work_claim_lock(b.user_id);
  if p_input->>'action' is distinct from 'publication_begin_independent'
    or not(p_input ?& array['claim_id','pr_ref','head_sha','base_sha','target_branch','changed_paths','independent_identity'])
    or p_input-array['action','scope','claim_id','pr_ref','head_sha','base_sha','target_branch','changed_paths','independent_identity']<>'{}'::jsonb
    or not coalesce(clued_private.work_claim_independent_identity_valid_v1(identity),false) then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if not clued_private.work_claim_execution_enabled_v1() then
    return jsonb_build_object('status','rejected','error_code','work_claim_execution_not_active'); end if;
  select * into policy from clued_private.work_claim_independent_consumer_v1 where singleton;
  if policy.activated_at is null or policy.activated_at>clock_timestamp()
    or policy.ci_principal_binding_id is distinct from b.id
    or policy.source_manifest_sha256 is distinct from identity->'job'->>'sourceManifestSha256' then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_consumer_not_qualified'); end if;
  j:=identity->'job'; generation:=identity->'claim';
  if p_input->>'claim_id' is distinct from generation->>'claim_id' or p_input->>'head_sha' is distinct from j->>'headSha'
    or p_input->>'base_sha' is distinct from j->>'baseSha' or p_input->>'target_branch' is distinct from 'main'
    or p_input->>'pr_ref' is distinct from (j->>'repo')||'#'||(j->>'pr') then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_subject_changed'); end if;
  -- Consume the existing CI admission door, including its current designated
  -- role, exact private head authorization, paths, quota and live-holder gates.
  result:=public.clued_work_verify_v1(p_token_hash,p_input-array['action','independent_identity']);
  if result->>'verdict' is distinct from 'ADMITTED' or result->'execution_authorized' is distinct from 'true'::jsonb then return result; end if;
  if result->>'execution_policy' is distinct from 'active' then
    return jsonb_build_object('status','rejected','error_code','work_claim_execution_not_active'); end if;
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id and context_key=scope
    and claim_id=(generation->>'claim_id')::uuid for update;
  if c.claim_id is null or c.fence is distinct from (generation->>'fence')::bigint
    or c.execution_epoch is distinct from (generation->>'execution_epoch')::bigint
    or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() or c.execution_handover_pending then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_generation_changed'); end if;
  -- Track unguarded active publications too: a first handover must drain them.
  -- The global effect index preserves the original no-repost scanner budget.
  insert into clued_private.work_claim_publications_v1(user_id,claim_id,execution_epoch,repository,head_sha,pr_ref,run_id,
    publication_key,independent_identity) values(b.user_id,c.claim_id,c.execution_epoch,j->>'repo',j->>'headSha',p_input->>'pr_ref',null,
    (identity->>'publication_key')::uuid,identity) on conflict do nothing returning publication_id into id;
  if id is null then
    replayed:=true;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and independent_identity->>'effect_key'=identity->>'effect_key';
    if p.publication_id is null or p.independent_identity is distinct from identity or p.state<>'open'
      or p.claim_id<>c.claim_id or p.execution_epoch<>c.execution_epoch or p.pr_ref is distinct from p_input->>'pr_ref'
      or p.head_sha is distinct from j->>'headSha' then
      return jsonb_build_object('status','rejected','error_code','work_claim_publication_idempotency_conflict'); end if;
    id:=p.publication_id; receipt:=p.started_receipt_id;
  else
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_publication_begin_independent',c.claim_id,c.execution_epoch,
      jsonb_build_object('publication_id',id,'repository',j->>'repo','head_sha',j->>'headSha','pr_ref',p_input->>'pr_ref',
        'independent_identity',identity));
    update clued_private.work_claim_publications_v1 set started_receipt_id=receipt where publication_id=id;
  end if;
  return result||jsonb_build_object('publication_required',true,'publication_id',id,'scope',scope,'receipt_id',receipt,
    'independent_identity',identity,'replayed',replayed);
end $$;
revoke all on function clued_private.work_claim_independent_begin_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Recover only this provider's exact never-sent abort, including a lost commit
-- response. A generic reconciled row or another operation is not an abort proof.
create function clued_private.work_claim_independent_abort_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; p clued_private.work_claim_publications_v1; receipt uuid;
  scope text:=coalesce(p_input->>'scope','global');
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp()) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  perform clued_private.work_claim_lock(b.user_id);
  if p_input->>'action' is distinct from 'publication_abort_independent'
    or not(p_input ?& array['publication_id','independent_identity','not_sent','publisher_stopped'])
    or p_input-array['action','scope','publication_id','independent_identity','not_sent','publisher_stopped']<>'{}'::jsonb
    or p_input->'not_sent' is distinct from 'true'::jsonb or p_input->'publisher_stopped' is distinct from 'true'::jsonb
    or coalesce(p_input->>'publication_id','') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or not coalesce(clued_private.work_claim_independent_identity_valid_v1(p_input->'independent_identity'),false) then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  select pubs.* into p from clued_private.work_claim_publications_v1 pubs
    join clued_private.work_claims_v1 c on c.claim_id=pubs.claim_id
    where pubs.user_id=b.user_id and c.context_key=scope and pubs.publication_id=(p_input->>'publication_id')::uuid for update of pubs;
  if p.publication_id is null or p.independent_identity is distinct from p_input->'independent_identity' or p.check_run_id is not null then
    return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
  if p.state='reconciled' and exists(select 1 from public.clued_audit_receipts r where r.id=p.finished_receipt_id
    and r.user_id=b.user_id and r.context_key=scope and r.operation='work_claim_publication_abort_independent'
    and r.object_id=p.claim_id and r.metadata->>'publication_id'=p.publication_id::text
    and r.metadata->'independent_identity'=p.independent_identity and r.metadata->'not_sent'='true'::jsonb
    and r.metadata->'publisher_stopped'='true'::jsonb) then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',p.finished_receipt_id,'publication_id',p.publication_id);
  end if;
  if p.state<>'open' then return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
  receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_publication_abort_independent',p.claim_id,p.execution_epoch,
    jsonb_build_object('publication_id',p.publication_id,'independent_identity',p.independent_identity,'not_sent',true,'publisher_stopped',true));
  update clued_private.work_claim_publications_v1 set state='reconciled',finished_at=clock_timestamp(),finished_receipt_id=receipt where publication_id=p.publication_id;
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',receipt,'publication_id',p.publication_id);
end $$;
revoke all on function clued_private.work_claim_independent_abort_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Published independent effects must become unresolved before the old claim's
-- handover can complete. Do not rely on the GitHub-only legacy revoker finding
-- an App536 effect by accident; this keeps its ACK blocked until reconciliation.
create function clued_private.work_claim_independent_reopen_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if clued_private.work_claim_execution_enabled_v1() and
    (new.execution_epoch<>old.execution_epoch or new.execution_handover_pending or new.status<>'ACTIVE'
      or new.expires_at<=clock_timestamp()) then
    update clued_private.work_claim_publications_v1 set state='open' where claim_id=new.claim_id
      and independent_identity is not null and state='published'
      and (execution_epoch<new.execution_epoch or new.execution_handover_pending or new.status<>'ACTIVE'
        or new.expires_at<=clock_timestamp());
  end if;
  return null;
end $$;
create trigger work_claim_independent_reopen_v1 after update on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_independent_reopen_v1();
revoke all on function clued_private.work_claim_independent_reopen_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The Actions/App516 revoker cannot attest an App536 physical drain. Keep its
-- existing auto-merge/dispatch gate, and additionally require the independently
-- qualified consumer's Receipt before it can acknowledge this repository.
create table clued_private.work_claim_independent_drains_v1 (
  outbox_id uuid not null references clued_private.work_claim_revocation_outbox_v1(outbox_id),
  user_id uuid not null references auth.users(id),
  execution_epoch bigint not null,
  source_manifest_sha256 text not null check(source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null,
  receipt_id uuid not null,
  completed_at timestamptz not null default clock_timestamp(),
  primary key(outbox_id,source_manifest_sha256)
);
alter table clued_private.work_claim_independent_drains_v1 enable row level security;
revoke all on clued_private.work_claim_independent_drains_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_independent_drain_command_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1;
  o clued_private.work_claim_revocation_outbox_v1; policy clued_private.work_claim_independent_consumer_v1;
  d clued_private.work_claim_independent_drains_v1; scope text:=coalesce(p_input->>'scope','global');
  op text:=p_input->>'action'; evidence jsonb:=p_input->'evidence'; receipt uuid; heads text[]; supplied text[]; item jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp()) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  perform clued_private.work_claim_lock(b.user_id);
  if op not in ('independent_revocation_heads','independent_legacy_drain_finish')
    or not(p_input ?& array['outbox_id','execution_epoch']) then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  select * into o from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id and context_key=scope
    and outbox_id=(p_input->>'outbox_id')::uuid for update;
  select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=o.claim_id and context_key=scope;
  if o.outbox_id is null or c.claim_id is null or o.repository is distinct from 'tdoljyj/cross-memory-system'
    or o.execution_epoch is distinct from (p_input->>'execution_epoch')::bigint or c.execution_epoch<>o.execution_epoch then
    return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
  select array_agg(distinct h order by h) into heads from unnest(coalesce(c.admitted_heads,'{}'::text[])||array[o.head_sha]) h
    where h ~ '^[0-9a-f]{40}$';
  if op='independent_revocation_heads' then
    if p_input-array['action','scope','outbox_id','execution_epoch']<>'{}'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into policy from clued_private.work_claim_independent_consumer_v1 where singleton;
    return jsonb_build_object('status','ok','complete',true,'repository',o.repository,'claimId',c.claim_id,
      'executionEpoch',o.execution_epoch,'heads',to_jsonb(coalesce(heads,'{}'::text[])),
      'ciPrincipalBindingId',b.id,'consumerSourceManifestSha256',policy.source_manifest_sha256,
      'consumerCiPrincipalBindingId',policy.ci_principal_binding_id);
  end if;
  select * into policy from clued_private.work_claim_independent_consumer_v1 where singleton;
  if p_input-array['action','scope','outbox_id','execution_epoch','source_manifest_sha256','evidence']<>'{}'::jsonb
    or policy.qualification_commit is null or policy.source_manifest_sha256 is null
    or policy.ci_principal_binding_id is distinct from b.id
    or p_input->>'source_manifest_sha256' is distinct from policy.source_manifest_sha256 then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_consumer_not_qualified'); end if;
  if jsonb_typeof(evidence) is distinct from 'object' or evidence-array['heads','revoked_check_ids','stop_proof_refs']<>'{}'::jsonb
    or not(evidence ?& array['heads','revoked_check_ids','stop_proof_refs'])
    or jsonb_typeof(evidence->'heads') is distinct from 'array' or jsonb_array_length(evidence->'heads')>5000
    or jsonb_typeof(evidence->'revoked_check_ids') is distinct from 'array' or jsonb_array_length(evidence->'revoked_check_ids')>30000
    or jsonb_typeof(evidence->'stop_proof_refs') is distinct from 'array' or jsonb_array_length(evidence->'stop_proof_refs')>5000 then
    raise exception 'work_claim_independent_drain_evidence_invalid' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(evidence->'heads') loop
    if jsonb_typeof(item)<>'string' or item#>>'{}' !~ '^[0-9a-f]{40}$' then raise exception 'work_claim_independent_drain_evidence_invalid' using errcode='22023'; end if;
  end loop;
  for item in select value from jsonb_array_elements(evidence->'revoked_check_ids') loop
    if jsonb_typeof(item)<>'number' or item::text !~ '^[1-9][0-9]{0,15}$' then raise exception 'work_claim_independent_drain_evidence_invalid' using errcode='22023'; end if;
  end loop;
  for item in select value from jsonb_array_elements(evidence->'stop_proof_refs') loop
    if jsonb_typeof(item)<>'string' or item#>>'{}' !~ '^sha256:[0-9a-f]{64}$' then raise exception 'work_claim_independent_drain_evidence_invalid' using errcode='22023'; end if;
  end loop;
  select array_agg(value#>>'{}') into supplied from jsonb_array_elements(evidence->'heads');
  if not(coalesce(heads,'{}'::text[]) <@ coalesce(supplied,'{}'::text[]))
    or exists(select 1 from clued_private.work_claim_publications_v1 where user_id=b.user_id and claim_id=c.claim_id
      and independent_identity is not null and state='open') then
    return jsonb_build_object('status','rejected','error_code','work_claim_publications_unresolved'); end if;
  select * into d from clued_private.work_claim_independent_drains_v1 where outbox_id=o.outbox_id
    and source_manifest_sha256=policy.source_manifest_sha256;
  if d.outbox_id is not null then
    -- A later sweep may PATCH nothing because the first sweep already made
    -- every check negative. Replay the original immutable completion Receipt;
    -- never rewrite its evidence to the latest delta. A newly admitted durable
    -- head, unlike a delta, invalidates that old coverage and stays blocked.
    if d.execution_epoch<>o.execution_epoch or not(coalesce(heads,'{}'::text[]) <@
      coalesce((select array_agg(value#>>'{}') from jsonb_array_elements(d.evidence->'heads')),'{}'::text[])) then
      return jsonb_build_object('status','rejected','error_code','work_claim_independent_drain_conflict'); end if;
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',d.receipt_id); end if;
  -- Zero PATCHes is not a physical stop observation. Even an already-negative
  -- or not-yet-visible check needs the qualified original stop evidence.
  if jsonb_array_length(evidence->'stop_proof_refs')=0 then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_stop_proof_required'); end if;
  receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_independent_legacy_drain',c.claim_id,c.execution_epoch,
    jsonb_build_object('outbox_id',o.outbox_id,'source_manifest_sha256',policy.source_manifest_sha256,'evidence',evidence));
  insert into clued_private.work_claim_independent_drains_v1(outbox_id,user_id,execution_epoch,source_manifest_sha256,evidence,receipt_id)
    values(o.outbox_id,b.user_id,o.execution_epoch,policy.source_manifest_sha256,evidence,receipt);
  return jsonb_build_object('status','committed','replayed',false,'receipt_id',receipt);
end $$;
revoke all on function clued_private.work_claim_independent_drain_command_v1(text,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- Add one typed action to the existing CI8 command door, preserving every
-- existing role/effective_at check and every GitHub publication path verbatim.
do $independent_command$
declare body text; anchor text:=$a$  if op='revocations_contexts' then$a$;
  columns text:='pubs.pr_ref,pubs.run_id,pubs.check_run_id';
  ack_anchor text:=$a$    if p_input->'evidence'->'checks_revoked' is distinct from 'true'::jsonb$a$;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    or (length(body)-length(replace(body,columns,'')))/length(columns)<>1
    or (length(body)-length(replace(body,ack_anchor,'')))/length(ack_anchor)<>1 then
    raise exception 'work_claim_independent_command_source_unexpected'; end if;
  body:=replace(body,anchor,$a$  if op='publication_begin_independent' then
    return clued_private.work_claim_independent_begin_v1(p_token_hash,p_input);
  end if;
  if op='publication_abort_independent' then
    return clued_private.work_claim_independent_abort_v1(p_token_hash,p_input);
  end if;
  if op in ('independent_revocation_heads','independent_legacy_drain_finish') then
    return clued_private.work_claim_independent_drain_command_v1(p_token_hash,p_input);
  end if;
  if op='revocations_contexts' then$a$);
  body:=replace(body,columns,columns||',pubs.independent_identity,pubs.started_receipt_id');
  body:=replace(body,ack_anchor,$a$    if o.repository='tdoljyj/cross-memory-system' and exists(
      select 1 from clued_private.work_claim_independent_consumer_v1 policy where policy.singleton
        and policy.source_manifest_sha256 is not null and not exists(
          select 1 from clued_private.work_claim_independent_drains_v1 d where d.outbox_id=o.outbox_id
            and d.user_id=b.user_id and d.execution_epoch=o.execution_epoch
            and d.source_manifest_sha256=policy.source_manifest_sha256
            and jsonb_array_length(d.evidence->'stop_proof_refs')>0
            and not exists(select 1 from unnest(coalesce(c.admitted_heads,'{}'::text[])||array[o.head_sha]) h
              where h ~ '^[0-9a-f]{40}$' and not exists(
                select 1 from jsonb_array_elements_text(d.evidence->'heads') covered(head) where covered.head=h)))) then
      return jsonb_build_object('status','rejected','error_code','work_claim_independent_drain_required'); end if;
    if p_input->'evidence'->'checks_revoked' is distinct from 'true'::jsonb$a$);
  execute body;
end $independent_command$;
