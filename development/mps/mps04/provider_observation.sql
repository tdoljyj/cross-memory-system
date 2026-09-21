-- MPS-04 non-production canonical GitHub Observation/Drift registration.
-- GitHub remains READ_ONLY. Adoption reuses the MPS-02B MutationIntent/Receipt boundary.

create table if not exists clued_private.mps_provider_observations (
  observation_id text primary key,
  object_id text not null,
  observed_revision_id text not null,
  observed_adoption_id text not null,
  repository text not null,
  provider_ref text not null,
  adopted_exact_commit text not null,
  provider_exact_commit text not null,
  ancestry text not null,
  source_observation_digest text not null,
  registration_digest text not null,
  observation_payload jsonb not null,
  candidate_revision_id text,
  candidate_revision_digest text,
  adoption_intent_id text,
  adoption_intent_digest text,
  status text not null,
  decided_by_principal text,
  decision_request_id text,
  adoption_receipt_id text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (object_id, registration_digest),
  foreign key (object_id, observed_revision_id)
    references clued_private.mps_revisions(object_id, revision_id) on delete restrict,
  foreign key (object_id, observed_adoption_id, observed_revision_id)
    references clued_private.mps_adoptions(object_id, adoption_id, revision_id) on delete restrict,
  foreign key (object_id, candidate_revision_id)
    references clued_private.mps_revisions(object_id, revision_id) on delete restrict,
  check (observation_id ~ '^pob_[0-9a-f]{32}$'),
  check (repository = 'tdoljyj/cross-memory-system'),
  check (provider_ref = btrim(provider_ref) and char_length(provider_ref) between 1 and 200),
  check (adopted_exact_commit ~ '^[0-9a-f]{40}$'),
  check (provider_exact_commit ~ '^[0-9a-f]{40}$'),
  check (ancestry in ('identical','ahead','behind','diverged')),
  check (source_observation_digest ~ '^[0-9a-f]{64}$'),
  check (registration_digest ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(observation_payload) = 'object'),
  check (status in ('MATCHED','OPEN','IGNORED','ADOPTED')),
  check ((candidate_revision_id is null) = (candidate_revision_digest is null)),
  check (candidate_revision_digest is null or candidate_revision_digest ~ '^[0-9a-f]{64}$'),
  check ((adoption_intent_id is null) = (adoption_intent_digest is null)),
  check (adoption_intent_digest is null or adoption_intent_digest ~ '^[0-9a-f]{64}$'),
  check ((ancestry = 'identical' and status = 'MATCHED' and candidate_revision_id is null)
      or (ancestry <> 'identical' and status <> 'MATCHED')),
  check (ancestry <> 'ahead' or candidate_revision_id is not null)
);

create index if not exists mps_provider_observations_observed_revision_idx
  on clued_private.mps_provider_observations(object_id,observed_revision_id);
create index if not exists mps_provider_observations_observed_adoption_idx
  on clued_private.mps_provider_observations(object_id,observed_adoption_id,observed_revision_id);
create index if not exists mps_provider_observations_candidate_revision_idx
  on clued_private.mps_provider_observations(object_id,candidate_revision_id)
  where candidate_revision_id is not null;

revoke all on table clued_private.mps_provider_observations from public, anon, authenticated;

create or replace function clued_private.mps_register_provider_observation(
  p_object_id text,
  p_authority_domain_id text,
  p_read_principal_id text,
  p_native_principal_id text,
  p_observation jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $mps04$
declare
  v_read_basis jsonb;
  v_update_basis jsonb;
  v_current_revision_id text;
  v_current_adoption_id text;
  v_current_content jsonb;
  v_repository text := p_observation->>'repository';
  v_ref text := p_observation->>'ref';
  v_a text := p_observation->>'clued_adopted_exact_commit';
  v_b text := p_observation->>'provider_exact_commit';
  v_ancestry text := p_observation->>'ancestry';
  v_source_digest text := p_observation->>'observation_digest';
  v_source_identity jsonb;
  v_registration_identity jsonb;
  v_registration_digest text;
  v_observation_id text;
  v_candidate_content jsonb;
  v_candidate_revision_id text;
  v_candidate_revision_digest text;
  v_pack jsonb;
  v_change jsonb;
  v_intent jsonb;
  v_status text;
  v_existing clued_private.mps_provider_observations%rowtype;
  v_existing_stamp jsonb;
begin
  if jsonb_typeof(p_observation) <> 'object'
     or p_observation->>'kind' <> 'GITHUB_READ_ONLY_OBSERVATION'
     or v_repository <> 'tdoljyj/cross-memory-system'
     or v_ref is null or v_ref <> btrim(v_ref) or char_length(v_ref) not between 1 and 200
     or v_a is null or v_a !~ '^[0-9a-f]{40}$'
     or v_b is null or v_b !~ '^[0-9a-f]{40}$'
     or v_ancestry is null or v_ancestry not in ('identical','ahead','behind','diverged')
     or v_source_digest is null or v_source_digest !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_observation->'changed_file_sample') <> 'array'
     or jsonb_array_length(p_observation->'changed_file_sample') > 10
     or coalesce((p_observation->>'clued_current_changed')::boolean,true)
     or p_observation->>'persistence' <> 'NOT_REGISTERED_CANDIDATE_ONLY'
     or coalesce((p_observation->>'drift')::boolean,false) <> (v_a <> v_b)
     or ((v_a = v_b) <> (v_ancestry = 'identical')) then
    raise exception 'MPS04_PROVIDER_OBSERVATION_INVALID' using errcode='22023';
  end if;
  if p_observation->>'source_commit_url' <> 'https://github.com/'||v_repository||'/commit/'||v_b
     or p_observation->>'source_compare_url' <> 'https://github.com/'||v_repository||'/compare/'||v_a||'...'||v_b then
    raise exception 'MPS04_PROVIDER_SOURCE_IDENTITY_INVALID' using errcode='22023';
  end if;

  v_source_identity := jsonb_build_object(
    'repository',v_repository,'ref',v_ref,
    'clued_adopted_exact_commit',v_a,'provider_exact_commit',v_b,
    'ancestry',v_ancestry);
  if clued_private.mps_json_v1_sha256(v_source_identity) is distinct from v_source_digest then
    raise exception 'MPS04_PROVIDER_OBSERVATION_DIGEST_MISMATCH' using errcode='22023';
  end if;

  v_read_basis := clued_private.mps_read_context_basis(
    p_object_id,p_authority_domain_id,p_read_principal_id,'read');
  v_update_basis := clued_private.mps_read_context_basis(
    p_object_id,p_authority_domain_id,p_native_principal_id,'update');
  if coalesce((v_read_basis#>>'{permission,allowed}')::boolean,false) is not true
     or coalesce((v_update_basis#>>'{permission,allowed}')::boolean,false) is not true then
    raise exception 'MPS_AUTHORIZATION_DENIED' using errcode='42501';
  end if;
  if ((v_read_basis->'stamp') - 'authorization_generation')
       is distinct from ((v_update_basis->'stamp') - 'authorization_generation') then
    raise exception 'STALE_CONTEXT_REQUIRES_REFRESH' using errcode='40001';
  end if;
  v_current_revision_id := v_read_basis#>>'{stamp,current_revision_id}';
  v_current_adoption_id := v_read_basis#>>'{stamp,current_adoption_id}';
  select r.content into v_current_content
    from clued_private.mps_revisions r
   where r.object_id=p_object_id and r.revision_id=v_current_revision_id
     and r.revision_digest=v_read_basis->>'revision_digest';
  if not found or v_current_content->>'repository' is distinct from v_repository
     or v_current_content->>'adopted_exact_commit' is distinct from v_a then
    raise exception 'STALE_CONTEXT_REQUIRES_REFRESH' using errcode='40001';
  end if;

  v_registration_identity := v_source_identity || jsonb_build_object(
    'object_id',p_object_id,'observed_revision_id',v_current_revision_id,
    'observed_adoption_id',v_current_adoption_id);
  v_registration_digest := clued_private.mps_json_v1_sha256(v_registration_identity);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clued-mps04-observation:'||p_object_id||':'||v_registration_digest,0));
  select * into v_existing from clued_private.mps_provider_observations o
   where o.object_id=p_object_id and o.registration_digest=v_registration_digest;
  if found then
    if v_existing.adoption_intent_id is not null then
      select p.state_stamp into v_existing_stamp
        from clued_private.mps_mutation_intents i
        join clued_private.mps_context_packs p
          on p.object_id=i.object_id and p.pack_digest=i.context_pack_digest
       where i.intent_id=v_existing.adoption_intent_id
         and i.intent_digest=v_existing.adoption_intent_digest;
      if not found then
        raise exception 'MPS_INTENT_NOT_FOUND' using errcode='P0002';
      end if;
    end if;
    return v_existing.observation_payload || jsonb_build_object(
      'observation_id',v_existing.observation_id,
      'registration_digest',v_existing.registration_digest,
      'status',v_existing.status,
      'candidate_revision_id',v_existing.candidate_revision_id,
      'candidate_revision_digest',v_existing.candidate_revision_digest,
      'adoption_intent_id',v_existing.adoption_intent_id,
      'adoption_intent_digest',v_existing.adoption_intent_digest,
      'confirmation_state_stamp',v_existing_stamp,
      'persistence','REGISTERED_CANONICAL_OBSERVATION',
      'adoptable',v_existing.status='OPEN' and v_existing.adoption_intent_id is not null);
  end if;

  v_observation_id := clued_private.mps_new_id('pob');
  v_status := case when v_ancestry='identical' then 'MATCHED' else 'OPEN' end;
  if v_ancestry='ahead' then
    v_candidate_content := jsonb_set(v_current_content,'{adopted_exact_commit}',to_jsonb(v_b),false);
    v_candidate_revision_digest := clued_private.mps_json_v1_sha256(v_candidate_content);
    select r.revision_id into v_candidate_revision_id
      from clued_private.mps_revisions r
     where r.object_id=p_object_id and r.revision_digest=v_candidate_revision_digest;
    if not found then
      v_candidate_revision_id := clued_private.mps_new_id('rv');
      insert into clued_private.mps_revisions(object_id,revision_id,revision_digest,content)
      values(p_object_id,v_candidate_revision_id,v_candidate_revision_digest,v_candidate_content);
    end if;
  end if;

  insert into clued_private.mps_provider_observations(
    observation_id,object_id,observed_revision_id,observed_adoption_id,
    repository,provider_ref,adopted_exact_commit,provider_exact_commit,ancestry,
    source_observation_digest,registration_digest,observation_payload,
    candidate_revision_id,candidate_revision_digest,status)
  values(v_observation_id,p_object_id,v_current_revision_id,v_current_adoption_id,
    v_repository,v_ref,v_a,v_b,v_ancestry,v_source_digest,v_registration_digest,
    p_observation,v_candidate_revision_id,v_candidate_revision_digest,v_status);

  if v_candidate_revision_id is not null then
    v_pack := clued_private.mps_issue_context_pack(
      p_object_id,p_authority_domain_id,p_native_principal_id,'update',
      jsonb_build_array(jsonb_build_object(
        'evidence_type','github_provider_observation','observation_id',v_observation_id,
        'observation_digest',v_source_digest,'repository',v_repository,
        'ref',v_ref,'exact_commit',v_b,'ancestry',v_ancestry)),v_b);
    v_change := clued_private.mps_register_change_set(
      p_object_id,'chg_'||v_candidate_revision_digest,
      jsonb_build_object('mode','ADOPT_PREMATERIALIZED_V1',
        'revision_id',v_candidate_revision_id,'revision_digest',v_candidate_revision_digest));
    v_intent := clued_private.mps_issue_mutation_intent(jsonb_build_object(
      'context_pack_digest',v_pack->>'pack_digest','object_id',p_object_id,'operation','update',
      'proposal_or_change_id',v_change->>'change_id',
      'proposal_or_change_digest',v_change->>'change_digest',
      'target_revision',jsonb_build_object('mode','PREMATERIALIZED',
        'revision_id',v_candidate_revision_id,'revision_digest',v_candidate_revision_digest),
      'adoption_scope','object','adoption_purpose','mps04_adopt_github_provider'));
    update clued_private.mps_provider_observations set
      adoption_intent_id=v_intent->>'intent_id',adoption_intent_digest=v_intent->>'intent_digest'
     where observation_id=v_observation_id;
  end if;

  return p_observation || jsonb_build_object(
    'observation_id',v_observation_id,'registration_digest',v_registration_digest,
    'status',v_status,'candidate_revision_id',v_candidate_revision_id,
    'candidate_revision_digest',v_candidate_revision_digest,
    'adoption_intent_id',v_intent->>'intent_id','adoption_intent_digest',v_intent->>'intent_digest',
    'confirmation_state_stamp',v_pack#>'{context_pack,composite_state_stamp}',
    'persistence','REGISTERED_CANONICAL_OBSERVATION',
    'adoptable',v_intent is not null);
end;
$mps04$;

create or replace function clued_private.mps_ignore_provider_observation(
  p_observation_id text,
  p_authority_domain_id text,
  p_native_principal_id text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $mps04$
declare
  v_observation clued_private.mps_provider_observations%rowtype;
  v_basis jsonb;
begin
  if p_request_id is null or p_request_id <> btrim(p_request_id)
     or char_length(p_request_id) not between 8 and 160 then
    raise exception 'MPS_INVALID_REQUEST_KEY' using errcode='22023';
  end if;
  select * into v_observation from clued_private.mps_provider_observations
   where observation_id=p_observation_id for update;
  if not found then raise exception 'MPS04_OBSERVATION_NOT_FOUND' using errcode='P0002'; end if;
  v_basis := clued_private.mps_read_context_basis(
    v_observation.object_id,p_authority_domain_id,p_native_principal_id,'update');
  if v_basis#>>'{stamp,current_revision_id}' is distinct from v_observation.observed_revision_id
     or v_basis#>>'{stamp,current_adoption_id}' is distinct from v_observation.observed_adoption_id then
    raise exception 'STALE_CONTEXT_REQUIRES_REFRESH' using errcode='40001';
  end if;
  if v_observation.status='ADOPTED' then
    return jsonb_build_object('ok',false,'status','conflict','error','MPS04_OBSERVATION_ALREADY_ADOPTED',
      'object_id',v_observation.object_id,'observation_id',p_observation_id);
  end if;
  if v_observation.status='MATCHED' then
    return jsonb_build_object('ok',false,'status','conflict','error','MPS04_OBSERVATION_HAS_NO_DRIFT',
      'object_id',v_observation.object_id,'observation_id',p_observation_id);
  end if;
  if v_observation.status='IGNORED' then
    return jsonb_build_object('ok',true,'status','IGNORED','observation_id',p_observation_id,
      'object_id',v_observation.object_id,'request_id',v_observation.decision_request_id,
      'clued_current_changed',false);
  end if;
  update clued_private.mps_provider_observations set status='IGNORED',
    decided_by_principal=p_native_principal_id,decision_request_id=p_request_id,decided_at=now()
   where observation_id=p_observation_id;
  return jsonb_build_object('ok',true,'status','IGNORED','observation_id',p_observation_id,
    'object_id',v_observation.object_id,'request_id',p_request_id,'clued_current_changed',false);
end;
$mps04$;

create or replace function clued_private.mps_adopt_provider_observation(
  p_observation_id text,
  p_authority_domain_id text,
  p_native_principal_id text,
  p_request_id text,
  p_submitted_stamp jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $mps04$
declare
  v_observation clued_private.mps_provider_observations%rowtype;
  v_intent jsonb;
  v_fingerprint text;
  v_outcome jsonb;
begin
  if p_request_id is null or p_request_id <> btrim(p_request_id)
     or char_length(p_request_id) not between 8 and 160
     or jsonb_typeof(p_submitted_stamp) <> 'object' then
    raise exception 'MPS_MUTATION_REQUEST_FIELD_INVALID' using errcode='22023';
  end if;
  select * into v_observation from clued_private.mps_provider_observations
   where observation_id=p_observation_id for update;
  if not found then raise exception 'MPS04_OBSERVATION_NOT_FOUND' using errcode='P0002'; end if;
  if v_observation.adoption_intent_id is null then
    return jsonb_build_object('ok',false,'status','conflict','error','MPS04_OBSERVATION_NOT_ADOPTABLE',
      'object_id',v_observation.object_id,'observation_id',p_observation_id);
  end if;
  select i.intent_body into v_intent from clued_private.mps_mutation_intents i
   join clued_private.mps_context_packs p
     on p.object_id=i.object_id and p.pack_digest=i.context_pack_digest
   where i.intent_id=v_observation.adoption_intent_id
     and i.intent_digest=v_observation.adoption_intent_digest
     and i.object_id=v_observation.object_id
     and i.operation='update' and i.adoption_scope='object'
     and i.adoption_purpose='mps04_adopt_github_provider'
     and p.authority_domain_id=p_authority_domain_id
     and p.stable_request_principal_id=p_native_principal_id and p.action='update';
  if not found then raise exception 'MPS_INTENT_NOT_FOUND' using errcode='P0002'; end if;
  v_fingerprint := clued_private.mps_compute_request_fingerprint(v_intent,p_submitted_stamp);
  v_outcome := clued_private.mps_commit_mutation(
    p_authority_domain_id,p_native_principal_id,p_request_id,
    jsonb_build_object('confirmation_intent',v_intent,
      'composite_state_stamp',p_submitted_stamp,'request_fingerprint',v_fingerprint));
  if v_outcome->>'status'='committed' then
    update clued_private.mps_provider_observations set status='ADOPTED',
      decided_by_principal=p_native_principal_id,decision_request_id=p_request_id,
      adoption_receipt_id=v_outcome->>'receipt_id',decided_at=now()
     where observation_id=p_observation_id;
    return jsonb_build_object('ok',true,'object_id',v_observation.object_id,
      'observation_id',p_observation_id) || v_outcome;
  end if;
  return jsonb_build_object('ok',false,'object_id',v_observation.object_id,
    'observation_id',p_observation_id) || v_outcome;
end;
$mps04$;

revoke all on function clued_private.mps_register_provider_observation(text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function clued_private.mps_ignore_provider_observation(text,text,text,text) from public, anon, authenticated;
revoke all on function clued_private.mps_adopt_provider_observation(text,text,text,text,jsonb) from public, anon, authenticated;
