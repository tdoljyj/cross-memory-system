-- ========================================================================================
-- STEP 14 PREIMAGE CAPTURE. Read-only, and the generated input is only valid for 60 SECONDS.
-- ========================================================================================
-- twentieth-forward-compact.mjs:127 asserts the capture is under 60000 ms old:
--     assert.ok(age >= 0 && age < 60000, 'FRESH_ACTUAL_PREIMAGE_REQUIRED')
-- So capture -> build-twentieth-input -> twentieth-forward-compact must run back to back.
-- Use a throwaway capture for the --dry-run rehearsal and a fresh one for the real run; never
-- generate the real SQL from the rehearsal's capture.
--
-- MUST be run in a READ ONLY REPEATABLE READ transaction -- the query's own WHERE clause
-- enforces it and returns zero rows otherwise, which is the intended failure:
--
--     begin transaction read only isolation level repeatable read;
--     \set QUIET on
--     -- (1) this query, saved as the row
--     -- (2) the getter definition, saved as previous_getter_definition_raw
--     commit;
--
-- The row below is byte-for-byte the query carried in the nineteenth forward's reviewed input
-- (ActualNineteenthForwardInput.json .actual_preimage.query), because build-twentieth-input.mjs
-- copies that same query text into the twentieth's input verbatim. Do not reformat it: the
-- values have to be the ones this exact statement produces.
--
-- (2) is NOT part of the query -- the builder wants the definition text alongside the row and
-- asserts sha256(raw) == row.previous_getter_definition_sha256. Capture it in the SAME
-- transaction:
--
--     select pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure);
--
-- Expected, at the moment step 14 is due (that is, after step 13 and after CP-01):
--   server_timezone                   UTC
--   database_name                     postgres
--   accepted_project_ref              uscrdifznmlvczcekqpw
--   execution_current.sequence        88
--   execution_current.charged_seconds 9906
--   execution_current.active_ga_id    null
--   existing_forwards                 19          <- all forwards, unfiltered; series_f is the >44 subset
--   previous_binding.controller_sha256 ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa
--   previous_getter_prosrc_sha256     c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16
--   rows_sha256 / catalog_sha256      WILL DIFFER from the nineteenth's -- root6 is registered and
--                                     CP-01 has replaced three function bodies. That is expected;
--                                     the generator rewrites both literals from this capture.
-- Zero rows returned means the transaction was not read-only-repeatable-read. Fix that; do not
-- edit the query.

with r as materialized (select jsonb_build_object('accepted_binding',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.accepted_binding x),'control_objects',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.control_objects x),'current_head',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.current_head x),'events',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.events x),'execution_binding',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.execution_binding x),'execution_current',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.execution_current x),'execution_events',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.execution_events x),'gate_attempts',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from clued_control.gate_attempts x)) as rows_now), k as materialized (select jsonb_build_object(
 'functions',(select jsonb_agg(case when p.oid=any(array['clued_control.effective_execution_binding()'::regprocedure]) then to_jsonb(p)-'prosrc' else to_jsonb(p) end order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_control'),
 'constraints',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='clued_control'),
 'tables_indexes',(select jsonb_agg(to_jsonb(c) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_control'),
 'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_control'),
 'triggers',(select jsonb_agg(to_jsonb(tg) order by tg.oid) from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_control')
 ) as catalog_now)
select statement_timestamp() as observed_at,current_setting('TimeZone') as server_timezone,current_database() as database_name,(select project_ref from clued_control.accepted_binding where root_id=c.root_id) as accepted_project_ref,
 encode(sha256(convert_to(r.rows_now::text,'UTF8')),'hex') as rows_sha256,encode(sha256(convert_to(k.catalog_now::text,'UTF8')),'hex') as catalog_sha256,
 to_jsonb(c) as execution_current,(select to_jsonb(b) from clued_control.effective_execution_binding() b) as previous_binding,
 encode(sha256(convert_to(pg_get_functiondef('clued_control.effective_execution_binding()'::regprocedure),'UTF8')),'hex') as previous_getter_definition_sha256,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as previous_getter_prosrc_sha256,
 (select count(*) from clued_control.execution_events e where e.root_id=c.root_id and e.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') as existing_forwards
from r cross join k cross join clued_control.execution_current c cross join pg_proc p
where c.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and p.oid='clued_control.effective_execution_binding()'::regprocedure
and current_setting('transaction_read_only')='on' and current_setting('transaction_isolation') in ('repeatable read','serializable');
