-- DRAFT ONLY. Run against a disposable, fully migrated test database.
-- No real user credentials or business rows are required or returned.
-- Example prerequisite: database name clued_scope_fixture_<unique-run>.
\set ON_ERROR_STOP on
begin;
do $$
begin
  if current_database() not like 'clued_scope_fixture_%' then
    raise exception 'refusing non-fixture database';
  end if;
  if inet_server_addr() is not null
     and host(inet_server_addr()) not in ('127.0.0.1','::1') then
    raise exception 'refusing non-loopback database';
  end if;
end $$;

insert into auth.users(id,aud,role,email,created_at,updated_at)
values ('d6000000-0000-4000-8000-000000000001','authenticated','authenticated',
        'step6-scope-fixture@example.invalid',now(),now());

insert into public.clued_agent_bindings
  (id,user_id,vendor,agent_name,token_hash,scopes,context_keys,revoked_at)
values
  ('d6100000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000001','fixture','read-audit',repeat('1',64),array['context:read','audit:read'],array['global'],null),
  ('d6100000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000001','fixture','read-only',repeat('2',64),array['context:read'],array['global'],null),
  ('d6100000-0000-4000-8000-000000000003','d6000000-0000-4000-8000-000000000001','fixture','audit-only',repeat('3',64),array['audit:read'],array['global'],null),
  ('d6100000-0000-4000-8000-000000000004','d6000000-0000-4000-8000-000000000001','fixture','revoked',repeat('4',64),array['context:read','audit:read'],array['global'],now()),
  ('d6100000-0000-4000-8000-000000000005','d6000000-0000-4000-8000-000000000001','fixture','wrong-context',repeat('5',64),array['context:read','audit:read'],array['project:other-fixture'],null);

create temporary table step6_scope_observations (
  case_name text primary key,
  expected text not null,
  actual text not null,
  sqlstate text,
  receipt_committed boolean not null
);
grant select,insert on step6_scope_observations to anon;
set local role anon;

do $$
declare
  fixture record;
  response jsonb;
  expected_result text;
begin
  for fixture in select * from (values
    ('read-audit','1','committed'),
    ('read-only','2','denied'),
    ('audit-only','3','denied'),
    ('revoked','4','denied'),
    ('wrong-context','5','denied')
  ) as cases(case_name,hash_digit,expected_result)
  loop
    begin
      response := public.clued_canonical_export(repeat(fixture.hash_digit,64),
        jsonb_build_object('idempotency_key','step6-export-scope-'||fixture.case_name));
      insert into step6_scope_observations
        values(fixture.case_name,fixture.expected_result,
               case when response->'receipt'->>'status'='committed' then 'committed' else 'unexpected_response' end,
               null,coalesce(response->'receipt'->>'status'='committed',false));
    exception when insufficient_privilege then
      insert into step6_scope_observations
        values(fixture.case_name,fixture.expected_result,'denied',sqlstate,false);
    end;
  end loop;
end $$;

reset role;
-- Emit only structural assertions, never response snapshot bodies.
select case_name,expected,actual,sqlstate,receipt_committed,
       expected=actual as passed
from step6_scope_observations order by case_name;

do $$
begin
  if exists(select 1 from step6_scope_observations where expected<>actual) then
    raise exception 'STEP6_EXPORT_SCOPE_CONTRACT_MISMATCH';
  end if;
end $$;
rollback;
