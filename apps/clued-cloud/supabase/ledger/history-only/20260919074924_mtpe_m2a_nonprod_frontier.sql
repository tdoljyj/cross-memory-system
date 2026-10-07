
create table if not exists mtpe_m0.m2a_evaluation_run(
 id uuid primary key default gen_random_uuid(),
 run_key text not null unique,
 authority_event bigint not null,
 watermark_at timestamptz not null,
 state text not null default 'DRAFT' check(state in('DRAFT','SNAPSHOTTED','EVALUATED','FRONTIER_LOCKED','REPLAY_VERIFIED','APPROVAL_PACKAGE_READY','FAILED')),
 input_digest text check(input_digest is null or length(input_digest)=64),
 policy_digest text check(policy_digest is null or length(policy_digest)=64),
 owner_route_required boolean not null default false,
 production_authority boolean not null default false check(not production_authority),
 budget_authority boolean not null default false check(not budget_authority),
 purchase_authority boolean not null default false check(not purchase_authority),
 deployment_authority boolean not null default false check(not deployment_authority),
 release_authority boolean not null default false check(not release_authority),
 created_at timestamptz not null default now()
);

create table if not exists mtpe_m0.m2a_candidate(
 id uuid primary key default gen_random_uuid(),
 run_id uuid not null references mtpe_m0.m2a_evaluation_run(id) on delete cascade,
 program_initiative_id uuid not null references mtpe_m0.program_initiative(id) on delete restrict,
 frontier_item_id uuid not null references mtpe_m0.priority_item(id) on delete restrict,
 track_id uuid not null references mtpe_m0.track(id) on delete restrict,
 source_state text not null check(source_state in('NOT_STARTED','ACTIVE','IN_PROGRESS','WAITING','BLOCKED','PAUSED','DEFERRED','COMPLETED','CANCELLED','SUPERSEDED','HISTORICAL','ABSORBED')),
 source_verdict mtpe_m0.verdict_value not null,
 currentness mtpe_m0.currentness_value not null,
 eligible boolean not null,
 exclusion_reason text,
 legacy_origin boolean not null default false,
 auto_start boolean not null default false check(not auto_start),
 grants_execution_authority boolean not null default false check(not grants_execution_authority),
 evidence_ref text not null check(length(btrim(evidence_ref))>0),
 source_digest text not null check(length(source_digest)=64),
 attributes jsonb not null default '{}'::jsonb,
 unique(run_id,program_initiative_id),
 unique(run_id,frontier_item_id),
 unique(run_id,id),
 check(
   (eligible and currentness='VERIFIED_AT_WATERMARK' and source_verdict='CURRENT'
      and source_state not in('COMPLETED','CANCELLED','SUPERSEDED','HISTORICAL','ABSORBED')
      and exclusion_reason is null)
   or
   (not eligible and exclusion_reason is not null)
 )
);

create table if not exists mtpe_m0.m2a_candidate_dimension(
 run_id uuid not null,
 candidate_id uuid not null,
 ordinal smallint not null check(ordinal>0),
 dimension_key text not null,
 grade text not null check(grade in('BLOCKING','VERY_HIGH','HIGH','NORMAL','LOW','NONE','UNKNOWN')),
 evidence_ref text not null check(length(btrim(evidence_ref))>0),
 primary key(run_id,candidate_id,ordinal),
 unique(run_id,candidate_id,dimension_key),
 foreign key(run_id,candidate_id) references mtpe_m0.m2a_candidate(run_id,id) on delete cascade
);

create table if not exists mtpe_m0.m2a_frontier(
 run_id uuid primary key references mtpe_m0.m2a_evaluation_run(id),
 winner_candidate_id uuid not null,
 selection_method text not null check(selection_method in('SOLE_ELIGIBLE','STRICT_UNLOCK_SET_DOMINANCE','OWNER_THIRD_ORDER')),
 owner_authority_event bigint,
 winner_digest text not null check(length(winner_digest)=64),
 frontier_digest text not null check(length(frontier_digest)=64),
 approval_package_state text not null default 'NOT_READY' check(approval_package_state in('NOT_READY','READY_FOR_OWNER_APPROVAL')),
 execution_started boolean not null default false check(not execution_started),
 auto_start boolean not null default false check(not auto_start),
 production_authority boolean not null default false check(not production_authority),
 budget_authority boolean not null default false check(not budget_authority),
 purchase_authority boolean not null default false check(not purchase_authority),
 deployment_authority boolean not null default false check(not deployment_authority),
 release_authority boolean not null default false check(not release_authority),
 evidence_ref text not null check(length(btrim(evidence_ref))>0),
 foreign key(run_id,winner_candidate_id) references mtpe_m0.m2a_candidate(run_id,id),
 check((selection_method='OWNER_THIRD_ORDER' and owner_authority_event is not null)
    or (selection_method<>'OWNER_THIRD_ORDER' and owner_authority_event is null))
);

create table if not exists mtpe_m0.m2a_replay(
 run_id uuid not null references mtpe_m0.m2a_evaluation_run(id),
 replay_no smallint not null check(replay_no between 1 and 3),
 input_digest text not null check(length(input_digest)=64),
 policy_digest text not null check(length(policy_digest)=64),
 winner_candidate_id uuid not null,
 frontier_digest text not null check(length(frontier_digest)=64),
 passed boolean not null,
 failure jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 primary key(run_id,replay_no),
 foreign key(run_id,winner_candidate_id) references mtpe_m0.m2a_candidate(run_id,id)
);

create table if not exists mtpe_m0.m2a_start_approval_package(
 approval_key text primary key,
 run_id uuid not null unique references mtpe_m0.m2a_evaluation_run(id),
 winner_candidate_id uuid not null,
 package_state text not null check(package_state in('READY_FOR_OWNER_APPROVAL','APPROVED_EXACT_SCOPE','REJECTED','RETURNED_FOR_REVISION')),
 requested_authority jsonb not null,
 explicit_denials jsonb not null,
 execution_started boolean not null default false check(not execution_started),
 legacy_auto_start boolean not null default false check(not legacy_auto_start),
 production_authority boolean not null default false check(not production_authority),
 budget_authority boolean not null default false check(not budget_authority),
 purchase_authority boolean not null default false check(not purchase_authority),
 deployment_authority boolean not null default false check(not deployment_authority),
 release_authority boolean not null default false check(not release_authority),
 artifact_sha256 text check(artifact_sha256 is null or length(artifact_sha256)=64),
 artifact_ref text,
 created_at timestamptz not null default now(),
 foreign key(run_id,winner_candidate_id) references mtpe_m0.m2a_candidate(run_id,id)
);

create or replace function mtpe_m0.m2a_candidate_integrity()
returns trigger language plpgsql security invoker
set search_path=pg_catalog,mtpe_m0 as $$
declare p record; i record;
begin
 select id,track_id,kind into p from mtpe_m0.program_initiative where id=new.program_initiative_id;
 select id,program_initiative_id,item_type into i from mtpe_m0.priority_item where id=new.frontier_item_id;
 if p.id is null or p.kind::text <> 'PROGRAM' or p.track_id <> new.track_id then
   raise exception 'M2A_PROGRAM_TRACK_MISMATCH';
 end if;
 if i.id is null or i.program_initiative_id <> new.program_initiative_id or i.item_type <> 'PROGRAM_FRONTIER' then
   raise exception 'M2A_FRONTIER_ITEM_MISMATCH';
 end if;
 return new;
end $$;

drop trigger if exists trg_m2a_candidate_integrity on mtpe_m0.m2a_candidate;
create trigger trg_m2a_candidate_integrity before insert or update on mtpe_m0.m2a_candidate
for each row execute function mtpe_m0.m2a_candidate_integrity();

create or replace function mtpe_m0.m2a_dimension_integrity()
returns trigger language plpgsql security invoker
set search_path=pg_catalog,mtpe_m0 as $$
declare expected text;
begin
 select t.priority_policy->'dimensions'->>(new.ordinal-1)
 into expected
 from mtpe_m0.m2a_candidate c join mtpe_m0.track t on t.id=c.track_id
 where c.run_id=new.run_id and c.id=new.candidate_id;
 if expected is null or expected <> new.dimension_key then
   raise exception 'M2A_DIMENSION_ORDER_MISMATCH';
 end if;
 return new;
end $$;

drop trigger if exists trg_m2a_dimension_integrity on mtpe_m0.m2a_candidate_dimension;
create trigger trg_m2a_dimension_integrity before insert or update on mtpe_m0.m2a_candidate_dimension
for each row execute function mtpe_m0.m2a_dimension_integrity();

create or replace function mtpe_m0.m2a_record_replay(p_run_id uuid, p_replay_no smallint)
returns table(passed boolean,input_digest text,policy_digest text,frontier_digest text)
language plpgsql security invoker
set search_path=pg_catalog,mtpe_m0,extensions as $$
declare v_input text; v_policy text; v_frontier text; v_stored record; v_pass boolean;
begin
 select encode(extensions.digest(coalesce(string_agg(
   c.program_initiative_id::text||'|'||c.frontier_item_id::text||'|'||c.source_state||'|'||
   c.source_verdict::text||'|'||c.currentness::text||'|'||c.eligible::text||'|'||
   c.legacy_origin::text||'|'||c.source_digest||'|'||c.attributes::text||'|'||
   coalesce(d.dims,''), E'\n' order by c.program_initiative_id::text),''),'sha256'),'hex')
 into v_input
 from mtpe_m0.m2a_candidate c
 left join lateral (
   select string_agg(cd.ordinal::text||':'||cd.dimension_key||':'||cd.grade||':'||cd.evidence_ref,';' order by cd.ordinal) dims
   from mtpe_m0.m2a_candidate_dimension cd where cd.run_id=c.run_id and cd.candidate_id=c.id
 ) d on true
 where c.run_id=p_run_id;

 select encode(extensions.digest(coalesce(string_agg(t.key||'|'||t.priority_policy::text,E'\n' order by t.key),''),'sha256'),'hex')
 into v_policy
 from mtpe_m0.track t
 where exists(select 1 from mtpe_m0.m2a_candidate c where c.run_id=p_run_id and c.track_id=t.id);

 select r.input_digest,r.policy_digest,f.winner_candidate_id,f.selection_method,f.owner_authority_event,f.frontier_digest
 into v_stored
 from mtpe_m0.m2a_evaluation_run r join mtpe_m0.m2a_frontier f on f.run_id=r.id
 where r.id=p_run_id;

 v_frontier:=encode(extensions.digest(v_input||'|'||v_policy||'|'||v_stored.winner_candidate_id::text||'|'||
                    v_stored.selection_method||'|'||coalesce(v_stored.owner_authority_event::text,''),'sha256'),'hex');
 v_pass:=(v_input=v_stored.input_digest and v_policy=v_stored.policy_digest and v_frontier=v_stored.frontier_digest);

 insert into mtpe_m0.m2a_replay(run_id,replay_no,input_digest,policy_digest,winner_candidate_id,frontier_digest,passed,failure)
 values(p_run_id,p_replay_no,v_input,v_policy,v_stored.winner_candidate_id,v_frontier,v_pass,
        case when v_pass then '{}'::jsonb else jsonb_build_object('code','DIGEST_MISMATCH') end)
 on conflict(run_id,replay_no) do update
 set input_digest=excluded.input_digest,policy_digest=excluded.policy_digest,winner_candidate_id=excluded.winner_candidate_id,
     frontier_digest=excluded.frontier_digest,passed=excluded.passed,failure=excluded.failure,created_at=now();
 return query select v_pass,v_input,v_policy,v_frontier;
end $$;

create or replace function mtpe_m0.m2a_finalize(p_run_id uuid)
returns boolean language plpgsql security invoker
set search_path=pg_catalog,mtpe_m0 as $$
declare ok boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_run_id::text,0));
 select count(*)=3 and count(*) filter(where passed)=3
    and count(distinct input_digest)=1 and count(distinct policy_digest)=1
    and count(distinct winner_candidate_id)=1 and count(distinct frontier_digest)=1
 into ok from mtpe_m0.m2a_replay where run_id=p_run_id;
 if not ok then raise exception 'M2A_REPLAY_NOT_VERIFIED'; end if;
 update mtpe_m0.m2a_evaluation_run set state='APPROVAL_PACKAGE_READY' where id=p_run_id;
 update mtpe_m0.m2a_frontier set approval_package_state='READY_FOR_OWNER_APPROVAL' where run_id=p_run_id;
 return true;
end $$;

alter table mtpe_m0.m2a_evaluation_run enable row level security;
alter table mtpe_m0.m2a_candidate enable row level security;
alter table mtpe_m0.m2a_candidate_dimension enable row level security;
alter table mtpe_m0.m2a_frontier enable row level security;
alter table mtpe_m0.m2a_replay enable row level security;
alter table mtpe_m0.m2a_start_approval_package enable row level security;

revoke all on mtpe_m0.m2a_evaluation_run,mtpe_m0.m2a_candidate,mtpe_m0.m2a_candidate_dimension,
 mtpe_m0.m2a_frontier,mtpe_m0.m2a_replay,mtpe_m0.m2a_start_approval_package from anon,authenticated;
revoke execute on function mtpe_m0.m2a_candidate_integrity() from public,anon,authenticated;
revoke execute on function mtpe_m0.m2a_dimension_integrity() from public,anon,authenticated;
revoke execute on function mtpe_m0.m2a_record_replay(uuid,smallint) from public,anon,authenticated;
revoke execute on function mtpe_m0.m2a_finalize(uuid) from public,anon,authenticated;
