-- Same private control domain; storage/serialization candidate, not an issuer.
-- Existing Root tables/functions/data/grants remain unchanged. No rows installed.
do $$ begin
 if current_setting('clued_control.target_project',true) is distinct from 'uscrdifznmlvczcekqpw'
 or to_regclass('clued_control.accepted_binding') is null then raise exception 'wrong_or_missing_existing_control_domain'; end if;
end $$;

create table clued_control.execution_binding (
 root_id text primary key references clued_control.accepted_binding(root_id),
 profile_sha256 text not null check(profile_sha256 ~ '^[0-9a-f]{64}$'),
 controller_sha256 text not null check(controller_sha256 ~ '^[0-9a-f]{64}$'),
 qualification_sha256 text not null check(qualification_sha256 ~ '^[0-9a-f]{64}$'),
 scope_sha256 text not null check(scope_sha256 ~ '^[0-9a-f]{64}$'),
 gate_id text not null check(gate_id in ('G0a','G0b','G1','G2','G3','G4f','G4a-B','G4a-D','G4b','G5a','G5b','G5c','G6a','G6b','G7A','G7P','G7S','G7C','G7R','PLUGIN-SUBMIT','ET1','ET2','ET3','G-PREENTRY-SKILL-QUALIFICATION')),
 gate_version text not null check(length(gate_version) between 1 and 128),
 gate_sha256 text not null check(gate_sha256 ~ '^[0-9a-f]{64}$'),
 runtime_acceptance_sha256 text not null check(runtime_acceptance_sha256 ~ '^[0-9a-f]{64}$'),
 prior_seconds integer not null check(prior_seconds between 1410 and 7200),
 prior_evidence_bytes bigint not null check(prior_evidence_bytes between 19264968 and 1073741824)
);
-- Presence/shape of this row is not independent acceptance. Exact eligible Gate,
-- accepted controller/Profile and current issuer chain must precede provisioning.
create trigger execution_binding_immutable before update or delete or truncate on clued_control.execution_binding
 for each statement execute function clued_control.deny_mutation();
create table clued_control.execution_current (
 root_id text primary key references clued_control.execution_binding(root_id),
 runner_generation text not null check(length(runner_generation) between 1 and 128 and runner_generation<>'not_applicable'),
 credential_generation text not null check(length(credential_generation) between 1 and 128 and credential_generation<>'not_applicable'),
 session_generation text not null check(length(session_generation) between 1 and 128 and session_generation<>'not_applicable'),
 sequence bigint not null default 0 check(sequence>=0),
 active_ga_id text,
 pending_budget_sequence bigint check(pending_budget_sequence is null or pending_budget_sequence>0),
 charged_seconds integer not null check(charged_seconds between 1410 and 7200),
 charged_evidence_bytes bigint not null check(charged_evidence_bytes between 19264968 and 1073741824)
);
create table clued_control.gate_attempts (
 root_id text not null references clued_control.execution_binding(root_id),
 ga_id text not null, idempotency_key text not null,
 ga_raw text not null, ga_sha256 text not null, ga jsonb not null,
 phase text not null check(phase in ('PENDING','CREATE_SENT','CREATED','START_SENT','RUNNING','STOP_SENT','STOPPED','UNKNOWN','DECISION_RESERVED','SIGNING','PASS','FAIL','BLOCKED','STALE')),
 sequence bigint not null default 0,
 revoked boolean not null default false,
 container_id text check(container_id is null or container_id ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz not null,
 decision jsonb, receipt_id text unique, receipt_raw text, receipt_sha256 text,
 budget_sequence bigint not null unique,
 primary key(root_id,ga_id), unique(root_id,idempotency_key)
);
create table clued_control.execution_events (
 root_id text not null references clued_control.execution_binding(root_id),
 sequence bigint not null, idempotency_key text not null, request jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 recording_transaction_id xid8 not null default pg_current_xact_id(),
 primary key(root_id,sequence),unique(root_id,idempotency_key)
);
create function clued_control.guard_gate_bytes() returns trigger language plpgsql set search_path='' as $$
begin
 if new.root_id is distinct from old.root_id or new.ga_id is distinct from old.ga_id or new.idempotency_key is distinct from old.idempotency_key
 or new.ga_raw is distinct from old.ga_raw or new.ga_sha256 is distinct from old.ga_sha256 or new.ga is distinct from old.ga
 or new.expires_at is distinct from old.expires_at or new.budget_sequence is distinct from old.budget_sequence or (old.revoked and not new.revoked)
 or (old.receipt_raw is not null and to_jsonb(new) is distinct from to_jsonb(old))
 or (old.decision is not null and new.decision is distinct from old.decision)
 then raise exception 'immutable_gate_bytes_or_decision'; end if;return new;
end $$;
create trigger gate_bytes_immutable before update on clued_control.gate_attempts for each row execute function clued_control.guard_gate_bytes();
create trigger gate_attempt_no_delete before delete or truncate on clued_control.gate_attempts for each statement execute function clued_control.deny_mutation();
create trigger execution_events_immutable before update or delete or truncate on clued_control.execution_events
 for each statement execute function clued_control.deny_mutation();
alter table clued_control.execution_binding enable row level security;
alter table clued_control.execution_current enable row level security;
alter table clued_control.gate_attempts enable row level security;
alter table clued_control.execution_events enable row level security;

-- Complete immutable original StatusManifest bytes; storage grants no authority.
create table clued_control.control_objects (
 root_id text not null references clued_control.execution_binding(root_id),
 object_type text not null check(object_type='StatusManifest'),
 uri text primary key, raw text not null, sha256 text not null,
 generation bigint not null check(generation between 1 and 9007199254740991),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(root_id,object_type,generation),
 check(uri ~ '^control://status-manifests/sm_[A-Za-z0-9_-]{1,128}$'),
 check(octet_length(raw)<=65536 and raw is json object with unique keys),
 check(sha256=encode(sha256(convert_to(raw,'UTF8')),'hex'))
);
create trigger control_objects_immutable before update or delete or truncate on clued_control.control_objects
 for each statement execute function clued_control.deny_mutation();
alter table clued_control.control_objects enable row level security;
create function clued_control.append_status_manifest(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; obj jsonb; object_uri text; previous clued_control.control_objects; r jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_status_bytes_required'; end if;
 obj:=p_raw::jsonb;
 if obj->>'object_type' is distinct from 'StatusManifest' or obj->>'schema_version' is distinct from '1.0'
 or obj->>'schema_digest' is distinct from '6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2'
 or coalesce(obj->>'status_manifest_id','') !~ '^sm_[A-Za-z0-9_-]{1,128}$'
 or obj->>'issuer_purpose' is distinct from 'STATUS'
 or obj->>'audience' is distinct from 'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw'
 or jsonb_typeof(obj->'generation') is distinct from 'number'
 or coalesce(obj->>'generation','') !~ '^[1-9][0-9]{0,15}$'
 or (obj->>'generation')::numeric>9007199254740991
 or jsonb_typeof(obj->'signature_binding') is distinct from 'object' then raise exception 'status_scope_or_encoding_mismatch'; end if;
 object_uri:='control://status-manifests/'||(obj->>'status_manifest_id');
 perform 1 from clued_control.current_head where root_id=root for share;
 perform 1 from clued_control.execution_current where root_id=root for update;
 if not found then raise exception 'accepted_execution_binding_missing'; end if;
 select * into previous from clued_control.control_objects where uri=object_uri;
 if found then
  if previous.root_id is distinct from root or previous.raw is distinct from p_raw or previous.sha256 is distinct from p_sha
  then raise exception 'immutable_status_identity_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','object',to_jsonb(previous),'authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or obj->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or (obj->>'as_of') is null or (obj->>'expires_at') is null or (obj->>'as_of')::timestamptz>clock_timestamp()
 or (obj->>'expires_at')::timestamptz<=clock_timestamp()
 or (obj->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'status_current_scope_mismatch'; end if;
 -- Trusted host verifies the full accepted Schema and actual STATUS Owner merge.
 insert into clued_control.control_objects(root_id,object_type,uri,raw,sha256,generation)
 values(root,'StatusManifest',object_uri,p_raw,p_sha,(obj->>'generation')::bigint);
 return jsonb_build_object('status','STORED_NO_AUTHORITY','uri',object_uri,'sha256',p_sha,'authority_effect','NONE');
end $$;

create function clued_control.read_execution() returns jsonb language sql stable security definer set search_path='' set timezone='UTC' as $$
 select jsonb_build_object('root',clued_control.read_root(b.root_id),'binding',to_jsonb(b),'current',to_jsonb(c),
 'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by a.ga_id) from clued_control.gate_attempts a where a.root_id=b.root_id),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.execution_events e where e.root_id=b.root_id),'[]'::jsonb),
 'control_objects',coalesce((select jsonb_agg(jsonb_build_object('object_type',co.object_type,'uri',co.uri,'raw',co.raw,'sha256',co.sha256))
 from clued_control.control_objects co join clued_control.gate_attempts active on active.root_id=co.root_id
 where co.root_id=b.root_id and active.ga_id=c.active_ga_id and co.uri=active.ga->'status_manifest_ref'->>'uri'
 and co.sha256=active.ga->'status_manifest_ref'->>'sha256'),'[]'::jsonb),
 'authority_effect','NONE') from clued_control.execution_binding b join clued_control.execution_current c using(root_id)
 where b.root_id='ctr_414bd3c724264a83894b0c55cf2ab878'
$$;

create function clued_control.read_execution_event(p_sequence bigint) returns jsonb language sql stable security definer set search_path='' set timezone='UTC' as $$
 select jsonb_build_object('event',to_jsonb(e),'authority_effect','NONE') from clued_control.execution_events e
 where e.root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and e.sequence=p_sequence
$$;

create function clued_control.reserve_execution_budget(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding;
 c clued_control.execution_current; previous clued_control.execution_events; r jsonb; v jsonb; next_sequence bigint; ref jsonb;
begin
 if p_raw is null or octet_length(p_raw)>16384 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_budget_bytes_required'; end if;
 v:=p_raw::jsonb;
 if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
 array['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']::text[]
 or jsonb_typeof(v->'idempotency_key') is distinct from 'string'
 or coalesce(v->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or v->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or v->>'environment' is distinct from 'ISOLATED_TEST'
 or v->'seconds' is distinct from '180'::jsonb or v->'evidence_bytes' is distinct from '134217728'::jsonb
 then raise exception 'fixed_budget_scope_required'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into b from clued_control.execution_binding where root_id=root;
 select * into c from clued_control.execution_current where root_id=root for update;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=v->>'idempotency_key';
 if found then
  if previous.request->>'operation' is distinct from 'BUDGET_RESERVED' or previous.request->'body'->>'raw' is distinct from p_raw
  or previous.request->'body'->>'sha256' is distinct from p_sha then raise exception 'budget_idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or v->>'root_generation' is distinct from r->>'generation_id'
 or v->>'profile_digest' is distinct from b.profile_sha256 or v->>'controller_digest' is distinct from b.controller_sha256
 or v->>'scope_digest' is distinct from b.scope_sha256 or v->>'runner_generation' is distinct from c.runner_generation
 or v->>'credential_generation' is distinct from c.credential_generation or v->>'session_generation' is distinct from c.session_generation
 then raise exception 'budget_current_binding_mismatch'; end if;
 if (v->>'not_before') is null or (v->>'expires_at') is null or (v->>'not_before')::timestamptz>clock_timestamp()
 or (v->>'not_before')::timestamptz<(select not_before from clued_control.accepted_binding where root_id=root)
 or (v->>'expires_at')::timestamptz<=clock_timestamp()
 or (v->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'budget_window_invalid'; end if;
 if c.active_ga_id is not null or c.pending_budget_sequence is not null or c.charged_seconds<b.prior_seconds
 or c.charged_evidence_bytes<b.prior_evidence_bytes or c.charged_seconds+180>7200
 or c.charged_evidence_bytes+134217728>1073741824 then raise exception 'budget_or_pending_capacity_unavailable'; end if;
 next_sequence:=c.sequence+1;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values(root,next_sequence,v->>'idempotency_key',jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)));
 update clued_control.execution_current set sequence=next_sequence,pending_budget_sequence=next_sequence,
 charged_seconds=charged_seconds+180,charged_evidence_bytes=charged_evidence_bytes+134217728 where root_id=root;
 ref:=jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||next_sequence,'sha256',p_sha);
 return jsonb_build_object('status','BUDGET_RESERVED','budget_reservation_ref',ref,'sequence',next_sequence,
 'authority_effect','NONE','automatic_refund',false);
end $$;

create function clued_control.reserve_gate(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding;
 c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_ga_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_ga_object'; end if;
 g:=p_raw::jsonb;
 if jsonb_typeof(g)<>'object' or coalesce(g->>'gate_authorization_id','') !~ '^ga_[A-Za-z0-9_.-]{1,128}$'
 or coalesce(g->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'invalid_ga_identity'; end if;
 -- Serialize root revocation/generation and runtime capacity in consistent order.
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into b from clued_control.execution_binding where root_id=root;
 select * into c from clued_control.execution_current where root_id=root for update;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into old from clued_control.gate_attempts where root_id=root and idempotency_key=g->>'idempotency_key';
 if found then
  if old.ga_raw is distinct from p_raw or old.ga_sha256 is distinct from p_sha then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','attempt',to_jsonb(old),'authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or g->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or g->>'runner_generation' is distinct from c.runner_generation or g->>'credential_generation' is distinct from c.credential_generation
 or g->>'session_generation' is distinct from c.session_generation then raise exception 'current_authority_or_generation_changed'; end if;
 if g->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or g->>'environment' is distinct from 'ISOLATED_TEST'
 or g->>'authorization_status' is distinct from 'AUTHORIZED' or g->>'profile_digest' is distinct from b.profile_sha256
 or g->>'controller_digest' is distinct from b.controller_sha256 or g->>'scope_digest' is distinct from b.scope_sha256
 or g->>'gate_id' is distinct from b.gate_id
 or g->'controller_qualification_ref'->>'sha256' is distinct from b.qualification_sha256 then raise exception 'exact_accepted_scope_mismatch'; end if;
 if not exists(select 1 from clued_control.control_objects co where co.root_id=root
 and co.uri=g->'status_manifest_ref'->>'uri' and co.sha256=g->'status_manifest_ref'->>'sha256')
 then raise exception 'exact_stored_status_required'; end if;
 -- Full original Schema, exact static Gate version/digest, signature/issuer,
 -- Profile/NA evidence and target bindings are checked by the trusted host verifier.
 start_time:=(g->>'issued_at')::timestamptz;end_time:=(g->>'deadline')::timestamptz;
 if start_time is null or end_time is null or (g->>'expires_at') is null or start_time>clock_timestamp()
 or start_time<(select not_before from clued_control.accepted_binding where root_id=root)
 or end_time<=clock_timestamp() or end_time>(g->>'expires_at')::timestamptz
 or (g->>'expires_at')::timestamptz-start_time>interval '180 seconds'
 or (g->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'ga_window_invalid'; end if;
 seconds:=ceil(extract(epoch from ((g->>'expires_at')::timestamptz-start_time)))::integer;
 if c.charged_seconds<b.prior_seconds or c.charged_evidence_bytes<b.prior_evidence_bytes then raise exception 'prior_budget_binding_mismatch'; end if;
 if seconds<1 or c.active_ga_id is not null or c.pending_budget_sequence is null
 then raise exception 'actual_pending_budget_required'; end if;
 select * into budget from clued_control.execution_events where root_id=root and sequence=c.pending_budget_sequence;
 if not found or budget.recording_transaction_id=pg_current_xact_id() or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
 or g->'budget_reservation_ref'->>'uri' is distinct from 'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||budget.sequence
 or g->'budget_reservation_ref'->>'sha256' is distinct from budget.request->'body'->>'sha256'
 then raise exception 'exact_prior_committed_budget_required'; end if;
 allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
 insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)
 values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,budget.sequence);
 update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null where root_id=root;
 return jsonb_build_object('status','RESERVED','ga_id',g->>'gate_authorization_id','authority_effect','NONE');
end $$;

create function clued_control.execution_transition(p jsonb) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; previous clued_control.execution_events; intent_event clued_control.execution_events;
 r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>131072
 or coalesce(p->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or jsonb_typeof(p->'expected_sequence') is distinct from 'number'
 or coalesce(p->>'expected_sequence','') !~ '^(0|[1-9][0-9]{0,14})$'
 or jsonb_typeof(p->'body') is distinct from 'object' then raise exception 'invalid_transition'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 if not found then raise exception 'execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=p->>'idempotency_key';
 if found then
  if previous.request is distinct from p then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 if (p->>'expected_sequence')::bigint<>c.sequence then raise exception 'sequence_conflict'; end if;
 op:=p->>'operation';
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=p->>'ga_id' for update;
 if not found or c.active_ga_id is distinct from a.ga_id then raise exception 'exact_active_attempt_missing'; end if;
 if op='INTENT_RECORDED' then
  if not ((a.phase='PENDING' and p->'body'->>'operation'='CREATE') or (a.phase='CREATED' and p->'body'->>'operation'='START'))
  then raise exception 'intent_phase_conflict'; end if;
  evidence_raw:=p->'body'->>'raw';
  if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
  or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_intent_bytes_required'; end if;
  evidence_json:=evidence_raw::jsonb;
  if evidence_json->>'ga_sha256' is distinct from a.ga_sha256 or evidence_json->>'ga_id' is distinct from a.ga_id
  or evidence_json->>'operation' is distinct from p->'body'->>'operation' then raise exception 'intent_binding_mismatch'; end if;
  if exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'ga_id'=a.ga_id
   and e.request->>'operation'='INTENT_RECORDED' and e.request->'body'->>'operation'=p->'body'->>'operation')
  then raise exception 'one_immutable_intent_per_effect'; end if;
  next_phase:=a.phase;
 elsif op in ('CREATE_SENT','START_SENT') then
  r:=clued_control.read_root(root);
  if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or a.revoked or clock_timestamp()>=a.expires_at
  or a.ga->>'control_trust_root_generation' is distinct from r->>'generation_id'
  or a.ga->>'runner_generation' is distinct from c.runner_generation
  or a.ga->>'credential_generation' is distinct from c.credential_generation
  or a.ga->>'session_generation' is distinct from c.session_generation then raise exception 'current_authority_or_generation_changed'; end if;
  if not ((op='CREATE_SENT' and a.phase='PENDING') or (op='START_SENT' and a.phase='CREATED')) then raise exception 'phase_conflict'; end if;
  if coalesce(p->'body'->>'intent_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'durable_intent_binding_missing'; end if;
  if jsonb_typeof(p->'body'->'intent_sequence') is distinct from 'number'
  or coalesce(p->'body'->>'intent_sequence','') !~ '^[1-9][0-9]{0,14}$' then raise exception 'committed_intent_sequence_required'; end if;
  select * into intent_event from clued_control.execution_events where root_id=root and sequence=(p->'body'->>'intent_sequence')::bigint;
  if not found or intent_event.recording_transaction_id=pg_current_xact_id()
  or intent_event.request->>'operation' is distinct from 'INTENT_RECORDED'
  or intent_event.request->>'ga_id' is distinct from a.ga_id
  or intent_event.request->'body'->>'operation' is distinct from replace(op,'_SENT','')
  or intent_event.request->'body'->>'sha256' is distinct from p->'body'->>'intent_sha256'
  then raise exception 'exact_prior_committed_intent_required'; end if;
  next_phase:=op;
 elsif op='CREATED' then
  if a.phase<>'CREATE_SENT' or coalesce(p->'body'->>'container_id','') !~ '^[0-9a-f]{64}$' then raise exception 'exact_container_missing'; end if;
  update clued_control.gate_attempts set container_id=p->'body'->>'container_id' where root_id=root and ga_id=a.ga_id;
  next_phase:='CREATED';
 elsif op='RECONCILED_CONTAINER' then
  if a.phase<>'UNKNOWN' or a.container_id is not null
  or coalesce(p->'body'->>'container_id','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'observation_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'exact_unknown_reconciliation_required'; end if;
  update clued_control.gate_attempts set container_id=p->'body'->>'container_id' where root_id=root and ga_id=a.ga_id;
  next_phase:='UNKNOWN'; -- Discovery permits cleanup, never a replacement START.
 elsif op='RUNNING' then
  if a.phase<>'START_SENT' or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'phase_or_container_conflict'; end if;next_phase:='RUNNING';
 elsif op='STOP_SENT' then
  if a.container_id is null or p->'body'->>'container_id' is distinct from a.container_id then raise exception 'exact_container_missing'; end if;
  next_phase:='STOP_SENT';
 elsif op='STOPPED' then
  if a.phase<>'STOP_SENT' or p->'body'->>'container_id' is distinct from a.container_id
  or coalesce(p->'body'->>'observation_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'stopped_observation_missing'; end if;
  next_phase:='STOPPED';
 elsif op in ('UNKNOWN','REVOKE') then
  next_phase:='UNKNOWN';
  if op='REVOKE' then update clued_control.gate_attempts set revoked=true where root_id=root and ga_id=a.ga_id;end if;
 elsif op='DECISION_RESERVED' then
  if a.phase<>'STOPPED' or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;
  foreach field_name in array array['decision','evidence_index'] loop
   evidence_raw:=p->'body'->>(field_name||'_raw');
   if jsonb_typeof(p->'body'->(field_name||'_raw')) is distinct from 'string'
   or not(evidence_raw is json object with unique keys)
   or p->'body'->>(field_name||'_sha256') is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex')
   then raise exception 'complete_reserved_evidence_bytes_required'; end if;
   evidence_json:=evidence_raw::jsonb;
   if evidence_json->>'ga_id' is distinct from a.ga_id or evidence_json->>'ga_sha256' is distinct from a.ga_sha256
   then raise exception 'reserved_evidence_ga_mismatch'; end if;
   if field_name='decision' and (evidence_json->>'result' is distinct from p->'body'->>'result'
    or coalesce(evidence_json->>'result','') not in ('PASS','FAIL','BLOCKED','STALE'))
   then raise exception 'reserved_decision_result_mismatch'; end if;
  end loop;
  update clued_control.gate_attempts set decision=p->'body' where root_id=root and ga_id=a.ga_id;next_phase:=op;
 elsif op='SIGNING' then
  if a.phase<>'DECISION_RESERVED' or p->'body'->>'decision_sha256' is distinct from a.decision->>'decision_sha256' then raise exception 'signing_reservation_conflict'; end if;next_phase:=op;
 else raise exception 'unsupported_transition'; end if;
 if op in ('CREATED','RUNNING','STOPPED','RECONCILED_CONTAINER') then
  evidence_raw:=p->'body'->>'raw';
  if jsonb_typeof(p->'body'->'raw') is distinct from 'string' or not (evidence_raw is json object with unique keys)
  or p->'body'->>'sha256' is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex') then raise exception 'exact_result_bytes_required'; end if;
  evidence_json:=evidence_raw::jsonb;
  if evidence_json->>'ga_sha256' is distinct from a.ga_sha256 or evidence_json->>'ga_id' is distinct from a.ga_id
  or evidence_json->>'operation' is distinct from op or evidence_json->>'container_id' is distinct from p->'body'->>'container_id'
  or jsonb_typeof(evidence_json->'observation') is distinct from 'object' then raise exception 'result_binding_mismatch'; end if;
 end if;
 -- UNKNOWN never releases the active slot, even after expiry or root revocation.
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values(root,c.sequence+1,p->>'idempotency_key',p);
 update clued_control.execution_current set sequence=c.sequence+1 where root_id=root;
 update clued_control.gate_attempts set phase=next_phase,sequence=sequence+1 where root_id=root and ga_id=a.ga_id;
 return jsonb_build_object('status','RECORDED','phase',next_phase,'sequence',c.sequence+1,
  'prior_committed_intent_readback',case when intent_event.sequence is null then null else to_jsonb(intent_event) end,
  'current_context',clued_control.read_execution()||jsonb_build_object('observed_at',clock_timestamp()),'authority_effect','NONE');
end $$;

create function clued_control.record_effect_intent(p_ga text,p_key text,p_body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare n bigint; prior_n bigint;
begin
 perform 1 from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for share;
 select sequence into n from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
 select (request->>'expected_sequence')::bigint into prior_n from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and idempotency_key=p_key;
 if found then n:=prior_n; end if;
 return clued_control.execution_transition(jsonb_build_object('ga_id',p_ga,'idempotency_key',p_key,
  'expected_sequence',n,'operation','INTENT_RECORDED','body',p_body));
end $$;

create function clued_control.dispatch_recorded_intent(p_ga text,p_operation text,p_key text,p_intent_sequence bigint,p_sha text) returns jsonb language plpgsql security definer set search_path='' as $$
declare n bigint; prior_n bigint;
begin
 if p_operation is null or p_operation not in ('CREATE_SENT','START_SENT') then raise exception 'fixed_dispatch_operation_required'; end if;
 perform 1 from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for share;
 select sequence into n from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
 select (request->>'expected_sequence')::bigint into prior_n from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and idempotency_key=p_key;
 if found then n:=prior_n; end if;
 return clued_control.execution_transition(jsonb_build_object('ga_id',p_ga,'idempotency_key',p_key,
  'expected_sequence',n,'operation',p_operation,'body',jsonb_build_object('intent_sequence',p_intent_sequence,'intent_sha256',p_sha)));
end $$;

create function clued_control.rotate_execution_generation(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current; prior clued_control.execution_events;
 field text; expected text; actual text; replacement text; r jsonb;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>65536
 or coalesce(p->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or coalesce(p->>'expected_sequence','') !~ '^(0|[1-9][0-9]{0,14})$' or jsonb_typeof(p->'expected_sequence') is distinct from 'number'
 then raise exception 'invalid_rotation'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 if not found then raise exception 'execution_binding_missing'; end if;
 select * into prior from clued_control.execution_events where root_id=root and idempotency_key=p->>'idempotency_key';
 if found then
  if prior.request is distinct from p then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' then raise exception 'root_inactive'; end if;
 if (p->>'expected_sequence')::bigint<>c.sequence then raise exception 'sequence_conflict'; end if;
 field:=p->>'generation_kind';replacement:=p->>'replacement';expected:=p->>'previous';
 if field not in ('runner_generation','credential_generation','session_generation') or field is null
 or jsonb_typeof(p->'replacement') is distinct from 'string' or coalesce(length(replacement),0) not between 1 and 128
 or replacement='not_applicable' or replacement=expected or coalesce(p->>'signed_source_sha256','') !~ '^[0-9a-f]{64}$'
 then raise exception 'invalid_independent_generation'; end if;
 actual:=to_jsonb(c)->>field;
 if expected is distinct from actual or exists(select 1 from clued_control.execution_events e where e.root_id=root
  and e.request->>'generation_kind'=field and replacement in (e.request->>'previous',e.request->>'replacement'))
 then raise exception 'generation_rollback_or_conflict'; end if;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values(root,c.sequence+1,p->>'idempotency_key',p);
 update clued_control.execution_current set sequence=c.sequence+1,
 runner_generation=case when field='runner_generation' then replacement else runner_generation end,
 credential_generation=case when field='credential_generation' then replacement else credential_generation end,
 session_generation=case when field='session_generation' then replacement else session_generation end where root_id=root;
 return jsonb_build_object('status','ROTATED','sequence',c.sequence+1,'authority_effect','NONE');
end $$;

create function clued_control.commit_gate_result(p_raw text,p_sha text,p_decision_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; c clued_control.execution_current;
 a clued_control.gate_attempts; receipt jsonb; r jsonb; final_result text;
begin
 if p_raw is null or octet_length(p_raw)>131072 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_receipt_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_receipt_object'; end if;
 receipt:=p_raw::jsonb;final_result:=receipt->>'result';
 if jsonb_typeof(receipt)<>'object' or coalesce(receipt->>'gate_result_receipt_id','') !~ '^grr_[A-Za-z0-9_.-]{1,128}$'
 or final_result is null or final_result not in ('PASS','FAIL','BLOCKED','STALE') then raise exception 'invalid_original_grr_result'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into a from clued_control.gate_attempts where root_id=root and ga_id=receipt->>'gate_authorization_id' for update;
 if a.ga_id is null then raise exception 'original_ga_missing'; end if;
 if a.receipt_raw is not null then
  if a.receipt_raw is distinct from p_raw or a.receipt_sha256 is distinct from p_sha or a.decision->>'decision_sha256' is distinct from p_decision_sha
  then raise exception 'one_ga_one_immutable_grr'; end if;
  return jsonb_build_object('status','DUPLICATE','receipt_sha256',a.receipt_sha256,'authority_effect','NONE');
 end if;
 if c.active_ga_id is distinct from a.ga_id or a.phase<>'SIGNING' or a.decision->>'decision_sha256' is distinct from p_decision_sha
 or a.decision->>'result' is distinct from final_result then raise exception 'exact_decision_reservation_required'; end if;
 if coalesce(receipt->>'schema_digest','') !~ '^[0-9a-f]{64}$' or receipt->>'issuer_purpose' is distinct from 'GATE_RESULT'
 or coalesce(receipt->>'audience','')='' or jsonb_typeof(receipt->'signature') is distinct from 'string'
 or coalesce(receipt->>'signature','')=''
 then raise exception 'signed_receipt_envelope_required'; end if;
 -- The existing trusted host must verify this exact signed payload, issuer and
 -- stopped evidence BEFORE calling. JSON shape/storage is not cryptography.
 r:=clued_control.read_root(root);
 if final_result='PASS' and (a.revoked or clock_timestamp()>=a.expires_at or r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY'
 or a.ga->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or a.ga->>'runner_generation' is distinct from c.runner_generation or a.ga->>'credential_generation' is distinct from c.credential_generation
 or a.ga->>'session_generation' is distinct from c.session_generation) then raise exception 'stale_or_revoked_pass_forbidden'; end if;
 update clued_control.gate_attempts set receipt_id=receipt->>'gate_result_receipt_id',receipt_raw=p_raw,receipt_sha256=p_sha,phase=final_result where root_id=root and ga_id=a.ga_id;
 update clued_control.execution_current set active_ga_id=null where root_id=root;
 return jsonb_build_object('status','COMMITTED','receipt_sha256',p_sha,'result',final_result,'authority_effect','NONE');
end $$;

revoke all on clued_control.execution_binding,clued_control.execution_current,clued_control.gate_attempts,clued_control.execution_events from public,anon,authenticated,service_role;
revoke all on function clued_control.guard_gate_bytes(),clued_control.read_execution(),clued_control.read_execution_event(bigint),clued_control.reserve_gate(text,text),clued_control.execution_transition(jsonb),clued_control.rotate_execution_generation(jsonb),clued_control.commit_gate_result(text,text,text) from public,anon,authenticated,service_role;
grant execute on function clued_control.read_execution(),clued_control.read_execution_event(bigint),clued_control.reserve_gate(text,text),clued_control.execution_transition(jsonb),clued_control.rotate_execution_generation(jsonb),clued_control.commit_gate_result(text,text,text) to service_role;
revoke all on function clued_control.record_effect_intent(text,text,jsonb),clued_control.dispatch_recorded_intent(text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function clued_control.record_effect_intent(text,text,jsonb),clued_control.dispatch_recorded_intent(text,text,text,bigint,text) to service_role;

revoke all on clued_control.control_objects from public,anon,authenticated,service_role;
revoke all on function clued_control.append_status_manifest(text,text) from public,anon,authenticated,service_role;
grant execute on function clued_control.append_status_manifest(text,text) to service_role;

revoke all on function clued_control.reserve_execution_budget(text,text) from public,anon,authenticated,service_role;
grant execute on function clued_control.reserve_execution_budget(text,text) to service_role;
