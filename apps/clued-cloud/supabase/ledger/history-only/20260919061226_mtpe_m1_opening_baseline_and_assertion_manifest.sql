
create table mtpe_m0_test.m1_assertion_manifest (
  assertion_key text primary key,
  origin text not null check (origin in ('P2_TEST','M0_ASSERTION','B18.5','B3.4','M1_ADDITIVE')),
  description text not null check (length(btrim(description))>0),
  source_ref text not null check (length(btrim(source_ref))>0),
  opening_frozen boolean not null default true check (opening_frozen),
  created_at timestamptz not null default now()
);
create table mtpe_m0_test.m1_assertion_result (
  run_no smallint not null check (run_no between 1 and 3),
  assertion_key text not null references mtpe_m0_test.m1_assertion_manifest(assertion_key) on delete restrict,
  passed boolean not null,
  observed jsonb not null default '{}'::jsonb,
  evidence_ref text not null check (length(btrim(evidence_ref))>0),
  created_at timestamptz not null default now(),
  primary key(run_no,assertion_key)
);
create table mtpe_m0_test.m1_opening_baseline (
  id boolean primary key default true check(id),
  dimensions jsonb not null,
  dimensions_digest text not null check(length(dimensions_digest)=64),
  assertion_manifest_digest text not null check(length(assertion_manifest_digest)=64),
  source_ref text not null check(length(btrim(source_ref))>0),
  frozen_at timestamptz not null default now()
);
revoke all on mtpe_m0_test.m1_assertion_manifest,mtpe_m0_test.m1_assertion_result,
 mtpe_m0_test.m1_opening_baseline from public,anon,authenticated;
grant select,insert,update,delete on mtpe_m0_test.m1_assertion_manifest,
 mtpe_m0_test.m1_assertion_result,mtpe_m0_test.m1_opening_baseline to mtpe_m0_test_role;
