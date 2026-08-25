begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

select has_function(
  'clued_private',
  'm1_migrate_current_legacy_records',
  array['bigint','text'],
  'Legacy-to-M1 migration function exists'
);
select ok(
  not has_function_privilege('anon','clued_private.m1_migrate_current_legacy_records(bigint,text)','EXECUTE'),
  'anon cannot execute the migration function'
);
select ok(
  not has_function_privilege('authenticated','clued_private.m1_migrate_current_legacy_records(bigint,text)','EXECUTE'),
  'authenticated cannot execute the migration function'
);

insert into auth.users(id,aud,role,email,created_at,updated_at) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','authenticated','authenticated','map@example.test',now(),now());

insert into public.clued_memories(
  id,user_id,title,content,scope,record_type,record_key,status,priority,version,source_ref
) values
  ('10000000-0000-4000-8000-000000000001','dddddddd-dddd-4ddd-8ddd-dddddddddddd','Legacy Decision','Keep the decision body','global','decision','map:decision','active',80,1,'legacy:test:decision'),
  ('10000000-0000-4000-8000-000000000002','dddddddd-dddd-4ddd-8ddd-dddddddddddd','Legacy Note','Keep the note body','global','note','map:note','active',40,1,'legacy:test:note'),
  ('10000000-0000-4000-8000-000000000003','dddddddd-dddd-4ddd-8ddd-dddddddddddd','Legacy State','Keep the state body','global','state','map:state','current',80,1,'legacy:test:state'),
  ('10000000-0000-4000-8000-000000000004','dddddddd-dddd-4ddd-8ddd-dddddddddddd','Legacy Task','Keep the task body','global','task','map:task','backlog',40,1,'legacy:test:task'),
  ('10000000-0000-4000-8000-000000000005','dddddddd-dddd-4ddd-8ddd-dddddddddddd','Legacy Archive','Keep the archive body','global','archive_snapshot','map:archive','archived',0,1,'legacy:test:archive');

create temporary table mapping_result(mapped bigint);
insert into mapping_result
select clued_private.m1_migrate_current_legacy_records(4,'m1-test-legacy-map-v1');

select is((select mapped from mapping_result),4::bigint,'Four non-terminal legacy rows are mapped');
select is((select count(*) from public.clued_records_m1 where user_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),4::bigint,'Four M1 canonical Records exist');
select is((select type_fields->>'rationale' from public.clued_memories where record_key='map:decision'),'legacy_import_preserved_content','Decision uses the deterministic import rationale marker');
select is((select type_fields->>'note_kind' from public.clued_memories where record_key='map:note'),'legacy_import','Note uses the deterministic import kind');
select is((select type_fields->>'state_kind' from public.clued_memories where record_key='map:state'),'legacy_import','State uses the deterministic import kind');
select is((select type_fields->>'execution_bucket' from public.clued_memories where record_key='map:task'),'later','Backlog Task maps deterministically to later');
select is((select count(*) from public.clued_memories where record_key like 'map:%' and record_key<>'map:archive' and lifecycle_status='active'),4::bigint,'Mapped Records are active');
select is((select count(*) from public.clued_memories where record_key like 'map:%' and record_key<>'map:archive' and authority='imported'),4::bigint,'Mapped Records retain imported authority');
select is((select count(*) from public.clued_memories where record_key like 'map:%' and record_key<>'map:archive' and version=2),4::bigint,'Mapping advances optimistic versions');
select is((select count(*) from public.clued_memories where id in (
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004'
)),4::bigint,'Canonical UUIDs are preserved');
select is((select count(*) from public.clued_audit_receipts where operation_family='legacy_record_mapping' and status='committed'),4::bigint,'Every mapping has one committed Receipt');
select is((select count(*) from public.clued_events_m1 where event_type='extension:clued:migrate_legacy_record'),4::bigint,'Every mapping has one canonical Event');
select is((select count(*) from public.clued_audit_receipts where operation_family='legacy_record_mapping' and cardinality(event_ids)=1),4::bigint,'Every mapping Receipt references exactly one Event');
select is((select count(*) from public.clued_memories where record_key like 'map:%' and record_key<>'map:archive' and content_hash ~ '^[0-9a-f]{64}$'),4::bigint,'Mapped Records have canonical content hashes');
select is((select count(*) from public.clued_memories where record_key like 'map:%' and record_key<>'map:archive' and cardinality(source_refs)=0 and source_unavailable_reason like 'legacy_source_ref:%'),4::bigint,'Legacy source references remain explicit without invented Evidence');
select is((select count(*) from public.clued_memories where record_key='map:archive' and record_schema_version is null and status='archived'),1::bigint,'Archived legacy data remains untouched');
select is(clued_private.m1_migrate_current_legacy_records(0,'m1-test-legacy-map-v1'),0::bigint,'A completed mapping rerun is a zero-side-effect no-op');
select ok(not exists(
  select 1 from public.clued_memories
  where user_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    and record_schema_version is null
    and record_type<>'archive_snapshot'
    and status not in ('done','cancelled','superseded','archived')
),'Current-view completeness predicate closes after mapping');
select is((select count(*) from public.clued_memories where
  (record_key='map:decision' and status='active') or
  (record_key='map:note' and status='active') or
  (record_key='map:state' and status='current') or
  (record_key='map:task' and status='backlog')
),4::bigint,'Legacy compatibility statuses are preserved');
select is((select count(*) from public.clued_audit_receipts where operation_family='legacy_record_mapping' and metadata->>'migration_batch'='m1-test-legacy-map-v1'),4::bigint,'Receipt metadata carries the rollback batch');
select is((select count(*) from public.clued_events_m1 where event_type='extension:clued:migrate_legacy_record' and committed_canonical_version is not null),4::bigint,'Mapping Events carry committed canonical versions');

select * from finish();
rollback;
