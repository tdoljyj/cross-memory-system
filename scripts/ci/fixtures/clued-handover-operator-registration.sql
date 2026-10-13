-- Candidate DDL-only fixture definition. Run solely through the accepted operator register driver after FULL pre-registration catalog verification.
create schema qualification_guard;
revoke all on schema qualification_guard from public;
create table qualification_guard.registration_v1(
  singleton boolean primary key default true check(singleton),
  realm text not null check(realm='clued-handover-disposable'),
  synthetic_only boolean not null check(synthetic_only),
  registration text not null,
  database_name text not null,
  registered_host text not null,
  profile_sha256 text not null check(profile_sha256 ~ '^[0-9a-f]{64}$'),
  operator_authority_receipt text not null,
  source_baseline text not null check(source_baseline ~ '^[0-9a-f]{40}$'),
  source_pins_sha256 text not null check(source_pins_sha256 ~ '^[0-9a-f]{64}$'),
  engineering_task_id uuid not null
    check(engineering_task_id='6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8')
);
revoke all on qualification_guard.registration_v1 from public;
