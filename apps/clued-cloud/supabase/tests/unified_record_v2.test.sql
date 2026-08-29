begin;

create extension if not exists pgtap with schema extensions;
select plan(28);

select has_column('public','clued_memories','record_type','Unified Record has a type');
select has_column('public','clued_memories','version','Unified Record has optimistic versioning');
select has_view('public','clued_records_v2','Canonical record view exists');
select has_function('clued_private','record_write_core',array['uuid','uuid','jsonb'],'Private write core exists');

insert into auth.users(id,aud,role,email,created_at,updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','authenticated','authenticated','a@example.test',now(),now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','authenticated','authenticated','b@example.test',now(),now());

insert into public.clued_projects(
  id,user_id,name,normalized_name,certainty_status,progress_status,confidence,context_key,confirmed_at
) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Confirmed','confirmed','confirmed','active',1,'project:cccccccc-cccc-4ccc-8ccc-cccccccccccc',now()),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Candidate','candidate','unconfirmed','not_started',0.5,'project:dddddddd-dddd-4ddd-8ddd-dddddddddddd',null);

insert into public.clued_memories(user_id,title,content)
values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Private B','Must stay isolated');

set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}',true);

select is(
  (select count(*) from public.clued_memories where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0::bigint,
  'RLS hides another user records'
);

select lives_ok($test$
  select public.clued_user_record_write('{
    "action":"create","idempotency_key":"task-global-0001","scope":"global",
    "record_type":"task","status":"backlog","title":"Ship G4","content":"Run isolated proof"
  }'::jsonb)
$test$,'Account wrapper creates a global task');

select lives_ok($test$
  select public.clued_user_record_write('{
    "action":"create","idempotency_key":"task-global-0001","scope":"global",
    "record_type":"task","status":"backlog","title":"Ship G4","content":"Run isolated proof"
  }'::jsonb)
$test$,'Same key and payload is idempotent');

select is(
  (select count(*) from public.clued_memories where title='Ship G4'),
  1::bigint,
  'Idempotent replay does not duplicate the record'
);

select throws_ok($test$
  select public.clued_user_record_write('{
    "action":"create","idempotency_key":"task-global-0001","scope":"global",
    "record_type":"task","status":"backlog","title":"Different","content":"Different payload"
  }'::jsonb)
$test$,'23505','idempotency_key_conflict','Same key with different payload conflicts');

select throws_ok($test$
  select public.clued_user_record_write(jsonb_build_object(
    'action','update','idempotency_key','task-stale-00001','scope','global',
    'record_type','task','record_id',(select id from public.clued_memories where title='Ship G4'),
    'expected_version',99,'title','Stale update','content','Must not win'
  ))
$test$,'23505','record_version_conflict','Stale expected version is rejected as an API conflict');

select throws_ok($test$
  select public.clued_user_record_write('{
    "action":"create","idempotency_key":"candidate-task-01","scope":"project",
    "project_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","record_type":"task",
    "status":"backlog","title":"Forbidden","content":"Candidate cannot own records"
  }'::jsonb)
$test$,'42501','project_not_confirmed','Unconfirmed project cannot create records');

select lives_ok($test$
  select public.clued_user_record_write('{
    "action":"create","idempotency_key":"project-task-0001","scope":"project",
    "project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","record_type":"task",
    "status":"backlog","title":"Project task","content":"One canonical body"
  }'::jsonb)
$test$,'Confirmed project creates a canonical task');

select is(
  (select r.id from public.clued_records_v2 r where r.title='Project task'),
  (select g.id from public.clued_global_work_v2 g where g.title='Project task'),
  'Global and Project queries preserve one canonical ID'
);

select lives_ok($test$
  select public.clued_user_record_write('{
    "action":"create","idempotency_key":"archive-snapshot-1","scope":"global",
    "record_type":"archive_snapshot","status":"archived","title":"Snapshot","content":"Immutable"
  }'::jsonb)
$test$,'Archive snapshot can be created');

select throws_ok($test$
  select public.clued_user_record_write(jsonb_build_object(
    'action','update','idempotency_key','archive-update-01','scope','global',
    'record_type','archive_snapshot','record_id',(select id from public.clued_memories where title='Snapshot'),
    'expected_version',1,'title','Changed','content','Forbidden'
  ))
$test$,'55000','archive_snapshot_immutable','Archive snapshot cannot be updated');

select ok(
  exists(
    select 1 from public.clued_audit_receipts r
    join public.clued_context_events e
      on e.user_id=r.user_id and e.record_id::text=r.object_id
     where r.idempotency_key='task-global-0001'
       and r.request_sha256 ~ '^[0-9a-f]{64}$'
       and e.record_version=1
  ),
  'Record, Event and Receipt are linked by the same transaction'
);

reset role;

insert into public.clued_projects(
  id,user_id,name,normalized_name,certainty_status,progress_status,confidence,context_key,
  confirmed_at,dismissed_at,merged_into_project_id
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Merged source','merged source','confirmed','archived',1,
  'project:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',now(),now(),
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
);

insert into public.clued_context_events(
  id,user_id,context_key,event_type,payload,event_schema_version,
  committed_canonical_version,canonical_event_type,target_refs,event_scope,
  change_summary,result,audit_visibility,evidence_refs,artifact_refs,content_hash
) values
  (
    880580,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','global','action',
    '{"canonical_event_type":"production_deployment_completed"}'::jsonb,1,580,
    'production_deployment_completed','[]'::jsonb,'global',
    '[{"summary":"97/97 PASS"},{"summary":"build PASS"},{"summary":"healthz 200"}]'::jsonb,
    'success','work_log','{}'::uuid[],
    '[{"kind":"worker_version","id":"version-580"}]'::jsonb,
    repeat('a',64)
  ),
  (
    880581,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','global','action',
    '{"canonical_event_type":"must_remain_private"}'::jsonb,null,null,null,null,null,
    null,null,null,null,null,null
  ),
  (
    880582,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','global','action',
    '{"canonical_event_type":"audit_only_global"}'::jsonb,1,582,
    'audit_only_global','[]'::jsonb,'global',
    '[{"summary":"internal audit detail"}]'::jsonb,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,repeat('b',64)
  ),
  (
    880583,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','profile','action',
    '{"canonical_event_type":"profile_work_log"}'::jsonb,1,583,
    'profile_work_log','[]'::jsonb,'profile',
    '[{"summary":"profile-only detail"}]'::jsonb,
    'success','work_log','{}'::uuid[],'[]'::jsonb,repeat('c',64)
  ),
  (
    880584,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','project:dddddddd-dddd-4ddd-8ddd-dddddddddddd','action',
    '{"canonical_event_type":"other_project_work_log"}'::jsonb,1,584,
    'other_project_work_log','[]'::jsonb,'project:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '[{"summary":"other project detail"}]'::jsonb,
    'success','work_log','{}'::uuid[],'[]'::jsonb,repeat('d',64)
  ),
  (
    880585,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','project:cccccccc-cccc-4ccc-8ccc-cccccccccccc','action',
    '{"canonical_event_type":"canonical_project_work_log"}'::jsonb,1,585,
    'canonical_project_work_log','[]'::jsonb,'project:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '[{"summary":"canonical project detail"}]'::jsonb,
    'success','work_log','{}'::uuid[],'[]'::jsonb,repeat('e',64)
  ),
  (
    880586,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','project:not-a-uuid','action',
    '{"canonical_event_type":"malformed_project_scope"}'::jsonb,1,586,
    'malformed_project_scope','[]'::jsonb,'project:not-a-uuid',
    '[{"summary":"must fail closed"}]'::jsonb,
    'success','work_log','{}'::uuid[],'[]'::jsonb,repeat('f',64)
  ),
  (
    880587,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','project:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','action',
    '{"canonical_event_type":"merged_project_work_log"}'::jsonb,1,587,
    'merged_project_work_log','[]'::jsonb,'project:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '[{"summary":"resolved through merge closure"}]'::jsonb,
    'success','work_log','{}'::uuid[],'[]'::jsonb,repeat('1',64)
  ),
  (
    880588,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','project:cccccccc-cccc-4ccc-8ccc-cccccccccccc','action',
    '{"canonical_event_type":"project_audit_only"}'::jsonb,1,588,
    'project_audit_only','[]'::jsonb,'project:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '[{"summary":"project-internal audit detail"}]'::jsonb,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,repeat('2',64)
  );

set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}',true);

select is(
  public.clued_user_record_list('{"level":"global","record_type":"log","limit":200}'::jsonb)
    #>> '{records,0,canonical_event_type}',
  'production_deployment_completed',
  'Log list exposes the canonical event type'
);

select is(
  public.clued_user_record_list('{"level":"global","record_type":"log","limit":200}'::jsonb)
    #>> '{records,0,change_summary,2,summary}',
  'healthz 200',
  'Log list exposes readable change summary evidence'
);

select is(
  public.clued_user_record_list('{"level":"global","record_type":"log","limit":200}'::jsonb)
    #>> '{records,0,committed_canonical_version}',
  '580',
  'Log list exposes the committed canonical version'
);

select is(
  jsonb_array_length(public.clued_user_record_list(
    '{"level":"global","record_type":"log","limit":200}'::jsonb
  )->'records'),
  1,
  'Global log keeps other users and non-global scopes isolated'
);

select ok(
  not (public.clued_user_record_list(
    '{"level":"global","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880582"}]'::jsonb),
  'Global log hides same-user audit_only events'
);

select ok(
  not (public.clued_user_record_list(
    '{"level":"global","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880583"}]'::jsonb),
  'Global log hides same-user profile events'
);

select ok(
  public.clued_user_record_list(
    '{"level":"project","project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880585","project_id":null,"canonical_event_type":"canonical_project_work_log"}]'::jsonb,
  'Project log resolves canonical event_scope when legacy project_id is null'
);

select ok(
  public.clued_user_record_list(
    '{"level":"project","project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880587","canonical_event_type":"merged_project_work_log"}]'::jsonb,
  'Project log maps a merged source scope through the effective project closure'
);

select ok(
  not (public.clued_user_record_list(
    '{"level":"project","project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880588"}]'::jsonb),
  'Project log hides same-user audit_only events'
);

select ok(
  not (public.clued_user_record_list(
    '{"level":"project","project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880584"}]'::jsonb),
  'Project log hides a different project event'
);

select ok(
  not (public.clued_user_record_list(
    '{"level":"project","project_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880585"}]'::jsonb),
  'Canonical project event is visible only in its resolved project'
);

select ok(
  not (public.clued_user_record_list(
    '{"level":"project","project_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","record_type":"log","limit":200}'::jsonb
  )->'records' @> '[{"id":"880586"}]'::jsonb),
  'Malformed project event_scope fails closed'
);

select * from finish();
rollback;
