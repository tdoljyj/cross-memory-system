
create table mtpe_m0_test.projection_instance (
  id uuid primary key default gen_random_uuid(),
  projection_key text not null unique,
  state text not null check (state in ('INVALIDATED','GENERATED','REGENERATED','REVOKED')),
  source_digest text not null check (length(btrim(source_digest)) > 0),
  projection_digest text,
  payload jsonb not null default '{}'::jsonb,
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  updated_at timestamptz not null default now(),
  check (not (payload ?| array['global_rank','cross_track_score','unified_score']))
);
create table mtpe_m0_test.projection_transition (
  id uuid primary key default gen_random_uuid(),
  projection_id uuid not null references mtpe_m0_test.projection_instance(id) on delete cascade,
  from_state text,
  to_state text not null,
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now()
);
create index projection_transition_projection_idx on mtpe_m0_test.projection_transition(projection_id);

create table mtpe_m0_test.thin_skill_lifecycle (
  id uuid primary key default gen_random_uuid(),
  skill_key text not null unique,
  state text not null check (state in ('DRAFT','INSTALLED','UPDATED','REPAIRED','REAUTHORIZED','VERIFIED','REVOKED')),
  lifecycle_digest text not null check (length(btrim(lifecycle_digest)) > 0),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  updated_at timestamptz not null default now()
);
create table mtpe_m0_test.thin_skill_transition (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references mtpe_m0_test.thin_skill_lifecycle(id) on delete cascade,
  operation text not null check (operation in ('INSTALL','UPDATE','REPAIR','REAUTHORIZE','VERIFY','REVOKE','STATUS')),
  from_state text,
  to_state text not null,
  success boolean not null,
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now()
);
create index thin_skill_transition_skill_idx on mtpe_m0_test.thin_skill_transition(skill_id);

create or replace function mtpe_m0.transition_projection(
 p_projection_id uuid,p_to_state text,p_source_digest text,p_projection_digest text,p_evidence_ref text
) returns text language plpgsql security invoker set search_path=pg_catalog,mtpe_m0 as $$
declare v_from text;
begin
 select state into v_from from mtpe_m0.projection_instance where id=p_projection_id for update;
 if v_from is null then raise exception 'projection not found'; end if;
 if not ((v_from='INVALIDATED' and p_to_state in ('GENERATED','REGENERATED','REVOKED'))
      or (v_from in ('GENERATED','REGENERATED') and p_to_state in ('INVALIDATED','REVOKED')))
 then raise exception 'invalid projection transition % -> %',v_from,p_to_state; end if;
 if p_to_state in ('GENERATED','REGENERATED') and length(btrim(coalesce(p_projection_digest,'')))=0
 then raise exception 'generated projection requires digest'; end if;
 update mtpe_m0.projection_instance set state=p_to_state,source_digest=p_source_digest,
   projection_digest=p_projection_digest,evidence_ref=p_evidence_ref,updated_at=now() where id=p_projection_id;
 insert into mtpe_m0.projection_transition(projection_id,from_state,to_state,evidence_ref)
 values(p_projection_id,v_from,p_to_state,p_evidence_ref);
 return p_to_state;
end $$;

create or replace function mtpe_m0_test.transition_projection(
 p_projection_id uuid,p_to_state text,p_source_digest text,p_projection_digest text,p_evidence_ref text
) returns text language plpgsql security invoker set search_path=pg_catalog,mtpe_m0_test as $$
declare v_from text;
begin
 select state into v_from from mtpe_m0_test.projection_instance where id=p_projection_id for update;
 if v_from is null then raise exception 'projection not found'; end if;
 if not ((v_from='INVALIDATED' and p_to_state in ('GENERATED','REGENERATED','REVOKED'))
      or (v_from in ('GENERATED','REGENERATED') and p_to_state in ('INVALIDATED','REVOKED')))
 then raise exception 'invalid projection transition % -> %',v_from,p_to_state; end if;
 if p_to_state in ('GENERATED','REGENERATED') and length(btrim(coalesce(p_projection_digest,'')))=0
 then raise exception 'generated projection requires digest'; end if;
 update mtpe_m0_test.projection_instance set state=p_to_state,source_digest=p_source_digest,
   projection_digest=p_projection_digest,evidence_ref=p_evidence_ref,updated_at=now() where id=p_projection_id;
 insert into mtpe_m0_test.projection_transition(projection_id,from_state,to_state,evidence_ref)
 values(p_projection_id,v_from,p_to_state,p_evidence_ref);
 return p_to_state;
end $$;

create or replace function mtpe_m0.transition_thin_skill(
 p_skill_id uuid,p_operation text,p_lifecycle_digest text,p_evidence_ref text
) returns text language plpgsql security invoker set search_path=pg_catalog,mtpe_m0 as $$
declare v_from text; v_to text;
begin
 select state into v_from from mtpe_m0.thin_skill_lifecycle where id=p_skill_id for update;
 if v_from is null then raise exception 'skill not found'; end if;
 v_to := case
   when p_operation='STATUS' then v_from
   when p_operation='INSTALL' and v_from='DRAFT' then 'INSTALLED'
   when p_operation='UPDATE' and v_from in ('INSTALLED','VERIFIED') then 'UPDATED'
   when p_operation='REPAIR' and v_from in ('INSTALLED','UPDATED','REAUTHORIZED','VERIFIED') then 'REPAIRED'
   when p_operation='REAUTHORIZE' and v_from in ('INSTALLED','UPDATED','REPAIRED') then 'REAUTHORIZED'
   when p_operation='VERIFY' and v_from in ('INSTALLED','UPDATED','REPAIRED','REAUTHORIZED') then 'VERIFIED'
   when p_operation='REVOKE' and v_from <> 'REVOKED' then 'REVOKED'
 end;
 if v_to is null then raise exception 'invalid thin-skill transition % via %',v_from,p_operation; end if;
 update mtpe_m0.thin_skill_lifecycle set state=v_to,lifecycle_digest=p_lifecycle_digest,
  evidence_ref=p_evidence_ref,updated_at=now() where id=p_skill_id;
 insert into mtpe_m0.thin_skill_transition(skill_id,operation,from_state,to_state,success,evidence_ref)
 values(p_skill_id,p_operation,v_from,v_to,true,p_evidence_ref);
 return v_to;
end $$;

create or replace function mtpe_m0_test.transition_thin_skill(
 p_skill_id uuid,p_operation text,p_lifecycle_digest text,p_evidence_ref text
) returns text language plpgsql security invoker set search_path=pg_catalog,mtpe_m0_test as $$
declare v_from text; v_to text;
begin
 select state into v_from from mtpe_m0_test.thin_skill_lifecycle where id=p_skill_id for update;
 if v_from is null then raise exception 'skill not found'; end if;
 v_to := case
   when p_operation='STATUS' then v_from
   when p_operation='INSTALL' and v_from='DRAFT' then 'INSTALLED'
   when p_operation='UPDATE' and v_from in ('INSTALLED','VERIFIED') then 'UPDATED'
   when p_operation='REPAIR' and v_from in ('INSTALLED','UPDATED','REAUTHORIZED','VERIFIED') then 'REPAIRED'
   when p_operation='REAUTHORIZE' and v_from in ('INSTALLED','UPDATED','REPAIRED') then 'REAUTHORIZED'
   when p_operation='VERIFY' and v_from in ('INSTALLED','UPDATED','REPAIRED','REAUTHORIZED') then 'VERIFIED'
   when p_operation='REVOKE' and v_from <> 'REVOKED' then 'REVOKED'
 end;
 if v_to is null then raise exception 'invalid thin-skill transition % via %',v_from,p_operation; end if;
 update mtpe_m0_test.thin_skill_lifecycle set state=v_to,lifecycle_digest=p_lifecycle_digest,
  evidence_ref=p_evidence_ref,updated_at=now() where id=p_skill_id;
 insert into mtpe_m0_test.thin_skill_transition(skill_id,operation,from_state,to_state,success,evidence_ref)
 values(p_skill_id,p_operation,v_from,v_to,true,p_evidence_ref);
 return v_to;
end $$;

revoke all on mtpe_m0_test.projection_instance,mtpe_m0_test.projection_transition,
 mtpe_m0_test.thin_skill_lifecycle,mtpe_m0_test.thin_skill_transition from public,anon,authenticated;
revoke all on function mtpe_m0.transition_projection(uuid,text,text,text,text),
 mtpe_m0.transition_thin_skill(uuid,text,text,text),
 mtpe_m0_test.transition_projection(uuid,text,text,text,text),
 mtpe_m0_test.transition_thin_skill(uuid,text,text,text)
 from public,anon,authenticated;
grant select,insert,update,delete on mtpe_m0_test.projection_instance,mtpe_m0_test.projection_transition,
 mtpe_m0_test.thin_skill_lifecycle,mtpe_m0_test.thin_skill_transition to mtpe_m0_test_role;
grant execute on function mtpe_m0_test.transition_projection(uuid,text,text,text,text),
 mtpe_m0_test.transition_thin_skill(uuid,text,text,text) to mtpe_m0_test_role;
