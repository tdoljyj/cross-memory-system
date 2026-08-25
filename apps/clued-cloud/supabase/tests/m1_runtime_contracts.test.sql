begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

select has_table('public','clued_evidence','Evidence has an independent canonical table');
select has_view('public','clued_records_m1','M1 record projection exists');
select has_view('public','clued_projects_m1','M1 project projection exists');
select has_view('public','clued_events_m1','M1 event projection exists');
select has_function('clued_private','record_mutation_core',array['uuid','uuid','jsonb','text'],'Record Mutation core exists');
select has_function('clued_private','decision_supersede_core',array['uuid','uuid','jsonb','text'],'Decision Supersede core exists');
select has_function('clued_private','project_mutation_core',array['uuid','uuid','jsonb','text'],'Project Mutation core exists');
select has_function('clued_private','evidence_ingest_core',array['uuid','uuid','jsonb','text'],'Evidence Ingest core exists');
select has_function('clued_private','append_event_core',array['uuid','uuid','jsonb','text'],'Event Append core exists');
select has_function('clued_private','canonical_export_core',array['uuid','uuid','jsonb','text'],'Canonical Export core exists');

insert into auth.users(id,aud,role,email,created_at,updated_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','authenticated','authenticated','m1-a@example.test',now(),now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','authenticated','authenticated','m1-b@example.test',now(),now());
insert into public.clued_memories(user_id,title,content) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Private B','Hidden');
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}',true);

create temporary table m1_results(name text primary key,payload jsonb);
insert into m1_results values ('project',public.clued_user_project_mutate(
  '{"operation":"create","canonical_project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","project_schema_version":1,"base_version":null,"idempotency_key":"m1-project-create","mutation":{"name":"M1 Project","certainty_status":"confirmed","progress_status":"active","aliases":[]}}',repeat('1',64)));
select is((select payload->>'status' from m1_results where name='project'),'committed','Project create commits');
select is((select count(*) from public.clued_context_events where canonical_event_type='project_created'),1::bigint,'Project create emits one Event');
insert into m1_results values ('project_replay',public.clued_user_project_mutate(
  '{"operation":"create","canonical_project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","project_schema_version":1,"base_version":null,"idempotency_key":"m1-project-create","mutation":{"name":"M1 Project","certainty_status":"confirmed","progress_status":"active","aliases":[]}}',repeat('1',64)));
select is((select payload->>'replayed' from m1_results where name='project_replay'),'true','Project exact replay returns original result');
insert into m1_results values ('project_stale',public.clued_user_project_mutate(
  '{"operation":"update","canonical_project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","project_schema_version":1,"base_version":99,"idempotency_key":"m1-project-stale","mutation":{"name":"Must not win"}}',repeat('c',64)));
select is((select payload->>'status' from m1_results where name='project_stale'),'rejected','Project stale CAS is rejected');
select is((select version from public.clued_projects where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),1::bigint,'Project stale CAS preserves version');

insert into m1_results values ('evidence',public.clued_user_evidence_ingest(
  '{"evidence_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","evidence_schema_version":1,"evidence_type":"test_output","storage_ref":"protected://m1/test","content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mime_type":"text/plain","size_bytes":4,"captured_at":null,"idempotency_key":"m1-evidence-ingest"}',repeat('2',64)));
select is((select payload->>'status' from m1_results where name='evidence'),'committed','Evidence ingest commits');
select is((select count(*) from public.clued_evidence),1::bigint,'Evidence is created once');
select is((select count(*) from public.clued_context_events where receipt_id=((select payload->>'receipt_id' from m1_results where name='evidence')::uuid)),0::bigint,'Standalone Evidence emits no Event');
insert into m1_results values ('evidence_replay',public.clued_user_evidence_ingest(
  '{"evidence_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","evidence_schema_version":1,"evidence_type":"test_output","storage_ref":"protected://m1/test","content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mime_type":"text/plain","size_bytes":4,"captured_at":null,"idempotency_key":"m1-evidence-ingest"}',repeat('2',64)));
select is((select payload->>'replayed' from m1_results where name='evidence_replay'),'true','Evidence exact replay returns original result');
select is((select count(*) from public.clued_evidence),1::bigint,'Evidence replay does not duplicate Evidence');

insert into m1_results values ('record',public.clued_user_record_mutate(
  '{"operation":"create","id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","record_type":"task","record_schema_version":1,"lifecycle_status":"active","scope":"project:cccccccc-cccc-4ccc-8ccc-cccccccccccc","base_version":null,"idempotency_key":"m1-record-create","source_refs":["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],"source_unavailable_reason":null,"mutation":{"title":"Execute M1","content":"Close the runtime contract","type_fields":{"execution_bucket":"now","priority":90,"completion_criteria":"All gates pass"},"relations":{"depends_on":[],"supersedes":[],"related_records":[]},"closure_summary":null,"closed_reason":null},"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit test input"}',repeat('3',64)));
select is((select payload->>'status' from m1_results where name='record'),'committed','Record create commits');
select is((select count(*) from public.clued_memories where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),1::bigint,'One canonical Record exists');
select is((select count(*) from public.clued_context_events where record_id is null and canonical_event_type='record_created'),1::bigint,'Record create emits one M1 Event');
select is((select count(*) from public.clued_audit_receipts where operation_family='record_mutation' and status='committed'),1::bigint,'Record create emits one committed Receipt');

insert into m1_results values ('replay',public.clued_user_record_mutate(
  '{"operation":"create","id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","record_type":"task","record_schema_version":1,"lifecycle_status":"active","scope":"project:cccccccc-cccc-4ccc-8ccc-cccccccccccc","base_version":null,"idempotency_key":"m1-record-create","source_refs":["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],"source_unavailable_reason":null,"mutation":{"title":"Execute M1","content":"Close the runtime contract","type_fields":{"execution_bucket":"now","priority":90,"completion_criteria":"All gates pass"},"relations":{"depends_on":[],"supersedes":[],"related_records":[]},"closure_summary":null,"closed_reason":null},"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit test input"}',repeat('3',64)));
select is((select payload->>'replayed' from m1_results where name='replay'),'true','Exact replay returns original result');
select is((select count(*) from public.clued_memories where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),1::bigint,'Replay does not duplicate Record');

insert into m1_results values ('conflict',public.clued_user_record_mutate(
  '{"operation":"create","record_type":"note","record_schema_version":1,"lifecycle_status":"active","scope":"global","base_version":null,"idempotency_key":"m1-record-create","source_refs":[],"source_unavailable_reason":null,"mutation":{"title":"Different","content":"Different","type_fields":{"note_kind":"test"},"relations":{"depends_on":[],"supersedes":[],"related_records":[]}},"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit"}',repeat('4',64)));
select is((select payload->>'status' from m1_results where name='conflict'),'rejected','Same key with different hash is rejected');
select ok((select related_receipt_id is not null from public.clued_audit_receipts where error_code='IDEMPOTENCY_KEY_CONFLICT'),'Conflict Receipt links original Receipt');

insert into m1_results values ('stale',public.clued_user_record_mutate(
  '{"operation":"update","id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","record_type":"task","record_schema_version":1,"lifecycle_status":"active","scope":"project:cccccccc-cccc-4ccc-8ccc-cccccccccccc","base_version":99,"idempotency_key":"m1-record-stale","authority":"user_explicit","confidence_reason":"Explicit","mutation":{"content":"Must not win"}}',repeat('5',64)));
select is((select payload->>'status' from m1_results where name='stale'),'rejected','Stale CAS is rejected');
select is((select version from public.clued_memories where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),1::bigint,'Stale CAS does not increment Record version');
select is((select count(*) from public.clued_events_m1 where event_type='operation_failed' and result='failure' and audit_visibility='audit_only'),1::bigint,'Safe stale CAS creates one audit-only failure Event');

insert into m1_results values ('legacy_reject',public.clued_user_record_mutate(
  '{"operation":"create","record_type":"archive_snapshot","record_schema_version":1,"lifecycle_status":"active","scope":"global","base_version":null,"idempotency_key":"m1-archive-reject","source_refs":[],"source_unavailable_reason":null,"mutation":{"title":"Legacy","content":"No new archive snapshot","type_fields":{},"relations":{}},"authority":"user_explicit","confidence_reason":"Explicit"}',repeat('6',64)));
select is((select payload->>'status' from m1_results where name='legacy_reject'),'rejected','archive_snapshot new write is rejected');

insert into m1_results values ('decision_a',public.clued_user_record_mutate(
  '{"operation":"create","id":"11111111-1111-4111-8111-111111111111","record_type":"decision","record_schema_version":1,"lifecycle_status":"active","scope":"global","base_version":null,"idempotency_key":"m1-decision-a","source_refs":[],"source_unavailable_reason":null,"mutation":{"title":"Decision A","content":"Old A","type_fields":{"rationale":"Initial"},"relations":{"depends_on":[],"supersedes":[],"related_records":[]}},"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit"}',repeat('8',64)));
insert into m1_results values ('decision_b',public.clued_user_record_mutate(
  '{"operation":"create","id":"22222222-2222-4222-8222-222222222222","record_type":"decision","record_schema_version":1,"lifecycle_status":"active","scope":"global","base_version":null,"idempotency_key":"m1-decision-b","source_refs":[],"source_unavailable_reason":null,"mutation":{"title":"Decision B","content":"Old B","type_fields":{"rationale":"Initial"},"relations":{"depends_on":[],"supersedes":[],"related_records":[]}},"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit"}',repeat('9',64)));
select is((select count(*) from public.clued_records_m1 where record_type='decision' and lifecycle_status='active'),2::bigint,'Two active source Decisions exist');
insert into m1_results values ('supersede',public.clued_user_decision_supersede(
  '{"source_decisions":[{"id":"11111111-1111-4111-8111-111111111111","base_version":1},{"id":"22222222-2222-4222-8222-222222222222","base_version":1}],"replacement":{"id":"33333333-3333-4333-8333-333333333333","record_schema_version":1,"scope":"global","title":"Replacement","content":"Current decision","type_fields":{"rationale":"Unifies A and B"},"relations":{"depends_on":[],"supersedes":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],"related_records":[]},"source_refs":[],"source_unavailable_reason":null,"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit"},"supersede_reason":"Replaced together","idempotency_key":"m1-decision-supersede"}',repeat('a',64)));
select is((select payload->>'status' from m1_results where name='supersede'),'committed','Decision Supersede commits atomically');
select is((select count(*) from public.clued_records_m1 where id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222') and lifecycle_status='superseded'),2::bigint,'All source Decisions close together');
select is((select count(*) from public.clued_records_m1 where id='33333333-3333-4333-8333-333333333333' and lifecycle_status='active'),1::bigint,'One active replacement Decision exists');
select is((select count(*) from public.clued_events_m1 where event_type='decision_superseded'),1::bigint,'Decision Supersede emits one multi-target Event');
insert into m1_results values ('supersede_replay',public.clued_user_decision_supersede(
  '{"source_decisions":[{"id":"11111111-1111-4111-8111-111111111111","base_version":1},{"id":"22222222-2222-4222-8222-222222222222","base_version":1}],"replacement":{"id":"33333333-3333-4333-8333-333333333333","record_schema_version":1,"scope":"global","title":"Replacement","content":"Current decision","type_fields":{"rationale":"Unifies A and B"},"relations":{"depends_on":[],"supersedes":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],"related_records":[]},"source_refs":[],"source_unavailable_reason":null,"authority":"user_explicit","observed_at":null,"confidence":1,"confidence_reason":"Explicit"},"supersede_reason":"Replaced together","idempotency_key":"m1-decision-supersede"}',repeat('a',64)));
select is((select payload->>'replayed' from m1_results where name='supersede_replay'),'true','Decision Supersede exact replay returns original result');
select is((select count(*) from public.clued_events_m1 where event_type='decision_superseded'),1::bigint,'Decision replay emits no duplicate Event');

insert into m1_results values ('append_event',public.clued_user_event_append(
  '{"event_schema_version":1,"event_type":"extension:clued:test","event_scope":"global","target_refs":[],"change_summary":[],"audit_visibility":"audit_only","evidence_refs":[],"artifact_refs":[],"idempotency_key":"m1-event-append"}',repeat('b',64)));
select is((select payload->>'status' from m1_results where name='append_event'),'committed','Extension Event Append commits');
select is((select count(*) from public.clued_events_m1 where event_type='extension:clued:test'),1::bigint,'Extension Event exists once');
insert into m1_results values ('append_event_replay',public.clued_user_event_append(
  '{"event_schema_version":1,"event_type":"extension:clued:test","event_scope":"global","target_refs":[],"change_summary":[],"audit_visibility":"audit_only","evidence_refs":[],"artifact_refs":[],"idempotency_key":"m1-event-append"}',repeat('b',64)));
select is((select payload->>'replayed' from m1_results where name='append_event_replay'),'true','Extension Event exact replay returns original result');
select is((select count(*) from public.clued_events_m1 where event_type='extension:clued:test'),1::bigint,'Event replay emits no duplicate Event');

insert into m1_results values ('export',public.clued_user_canonical_export('{"idempotency_key":"m1-export-live"}',repeat('7',64)));
select is((select payload->'snapshot'->>'source_verification' from m1_results where name='export'),'live_rechecked','Export is live rechecked');
select is((select payload->'snapshot'->>'views_complete' from m1_results where name='export'),'true','Fresh canonical fixture has complete current views');
select ok((select payload->'snapshot' ? 'export_receipt_id' from m1_results where name='export'),'Export carries its Receipt ID');
insert into m1_results values ('export_replay',public.clued_user_canonical_export('{"idempotency_key":"m1-export-live"}',repeat('7',64)));
select is((select payload->>'replayed' from m1_results where name='export_replay'),'true','Export exact replay returns original Receipt result');

select is((select count(*) from public.clued_memories where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),0::bigint,'RLS hides another owner records');

select * from finish();
rollback;
