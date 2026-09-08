-- CANDIDATE_NOT_DEPLOYED. Explicit selected project must be clued-auth-test.
-- No accepted binding or root instance is installed by this file.
do $$ begin
 if current_setting('clued_control.target_project',true) is distinct from 'uscrdifznmlvczcekqpw' then
  raise exception 'wrong_or_missing_nonproduction_project_selector';
 end if;
end $$;
create schema clued_control;
revoke all on schema clued_control from public, anon, authenticated, service_role;

create table clued_control.accepted_binding (
 root_id text primary key check(root_id='ctr_414bd3c724264a83894b0c55cf2ab878'),
 project_ref text not null check(project_ref='uscrdifznmlvczcekqpw'),
 purpose text not null check(purpose='SKILL_COEXISTENCE_QUALIFICATION'),
 environment text not null check(environment='ISOLATED_TEST'),
 subject_sha256 text not null check(subject_sha256='e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f'),
 owner_approval_commit text not null check(owner_approval_commit='4d7f93c17cf7d126e771cf8aca6299c868cba0a9'),
 not_before timestamptz not null,
 expires_at timestamptz not null check(expires_at<='2026-09-09T09:28:59Z'::timestamptz and expires_at>not_before),
 issuer text not null check(length(issuer) between 1 and 256),
 audience text not null check(length(audience) between 1 and 256),
 algorithm_config text not null check(length(algorithm_config) between 1 and 256),
 schema_sha256 text not null check(schema_sha256 ~ '^[0-9a-f]{64}$'),
 registration_acceptance_sha256 text not null check(registration_acceptance_sha256 ~ '^[0-9a-f]{64}$'),
 store_acceptance_sha256 text not null check(store_acceptance_sha256 ~ '^[0-9a-f]{64}$'),
 protocol_mapping_sha256 text not null check(protocol_mapping_sha256 ~ '^[0-9a-f]{64}$'),
 signature_evidence_sha256 text not null check(signature_evidence_sha256 ~ '^[0-9a-f]{64}$')
);
create table clued_control.events (
 root_id text not null references clued_control.accepted_binding(root_id),
 sequence bigint not null check(sequence>0),
 idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
 request jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(root_id,sequence), unique(root_id,idempotency_key)
);
create unique index clued_control_unique_generation on clued_control.events(root_id,(request->>'generation_id'))
 where request->>'kind'='GENERATION_REGISTERED';
create table clued_control.current_head (
 root_id text primary key references clued_control.accepted_binding(root_id),
 sequence bigint not null default 0 check(sequence>=0),
 generation_id text,
 revoked boolean not null default false
);
alter table clued_control.accepted_binding enable row level security;
alter table clued_control.events enable row level security;
alter table clued_control.current_head enable row level security;

create function clued_control.deny_mutation() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'immutable_control_evidence'; end $$;
create trigger accepted_binding_immutable before update or delete or truncate on clued_control.accepted_binding
 for each statement execute function clued_control.deny_mutation();
create trigger events_immutable before update or delete or truncate on clued_control.events
 for each statement execute function clued_control.deny_mutation();

-- This private storage primitive trusts the existing server-side service_role writer.
-- It does NOT perform cryptographic acceptance; the accepted binding has no configuration RPC.
create function clued_control.append_event(p jsonb) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare b clued_control.accepted_binding; h clued_control.current_head; old clued_control.events;
 binding_digest text; keys text[]; request_sequence bigint; kind text; gen text;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>65536 then raise exception 'invalid_request'; end if;
 select array_agg(k order by k) into keys from jsonb_object_keys(p) k;
 if keys is distinct from array['body','expected_sequence','generation_id','idempotency_key','kind','metadata_binding_sha256','predecessor_generation_id','root_set_id']::text[]
 or p->>'root_set_id' is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
 or jsonb_typeof(p->'idempotency_key') is distinct from 'string'
 or coalesce(p->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or jsonb_typeof(p->'expected_sequence') is distinct from 'number'
 or coalesce(p->>'expected_sequence','') !~ '^(0|[1-9][0-9]{0,14})$'
 or jsonb_typeof(p->'body') is distinct from 'object' then raise exception 'invalid_scope_or_fields'; end if;
 select * into b from clued_control.accepted_binding where root_id=p->>'root_set_id';
 if not found then raise exception 'accepted_binding_missing'; end if;
 if clock_timestamp()<b.not_before or clock_timestamp()>=b.expires_at then raise exception 'owner_window_inactive'; end if;
 binding_digest:=encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex');
 if p->>'metadata_binding_sha256' is distinct from binding_digest then raise exception 'binding_mismatch'; end if;
 insert into clued_control.current_head(root_id) values(b.root_id) on conflict do nothing;
 select * into h from clued_control.current_head where root_id=b.root_id for update;
 -- Recheck the actual time after waiting for the serialization lock.
 if clock_timestamp()>=b.expires_at then raise exception 'owner_window_inactive'; end if;
 select * into old from clued_control.events where root_id=b.root_id and idempotency_key=p->>'idempotency_key';
 if found then
  if old.request is distinct from p then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','sequence',old.sequence,'request',old.request,'authority_effect','NONE');
 end if;
 request_sequence:=(p->>'expected_sequence')::bigint;
 if request_sequence<>h.sequence then raise exception 'sequence_conflict'; end if;
 kind:=p->>'kind';gen:=p->>'generation_id';
 if kind='GENERATION_REGISTERED' then
  if h.revoked then raise exception 'root_revoked'; end if;
  if gen is null or gen !~ '^ctrgen_[0-9a-f]{32}$'
   or p->>'predecessor_generation_id' is distinct from h.generation_id then raise exception 'generation_predecessor_conflict'; end if;
  if h.generation_id is null and gen<>'ctrgen_352785779b64458a889d571360e2d2d5' then raise exception 'wrong_initial_generation'; end if;
  if exists(select 1 from clued_control.events where root_id=b.root_id and request->>'generation_id'=gen and request->>'kind'='GENERATION_REGISTERED') then raise exception 'generation_reuse_or_rollback'; end if;
 elsif kind in ('ROOT_REVOKED','GENERATION_REVOKED') then
  if h.generation_id is null or gen is distinct from h.generation_id
   or p->>'predecessor_generation_id' is not null then raise exception 'revocation_target_mismatch'; end if;
 else raise exception 'unsupported_control_event'; end if;
 insert into clued_control.events(root_id,sequence,idempotency_key,request) values(b.root_id,h.sequence+1,p->>'idempotency_key',p);
 update clued_control.current_head set sequence=h.sequence+1,
  generation_id=case when kind='GENERATION_REGISTERED' then gen else h.generation_id end,
  revoked=h.revoked or kind in ('ROOT_REVOKED','GENERATION_REVOKED') where root_id=b.root_id;
 return jsonb_build_object('status','APPENDED','sequence',h.sequence+1,'request',p,'authority_effect','NONE');
end $$;

create function clued_control.read_root(p_root_id text) returns jsonb language sql stable security definer set search_path='' set timezone='UTC' as $$
 select jsonb_build_object('root_set_id',b.root_id,'metadata_binding_sha256',encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex'),
  'state',case when statement_timestamp()<b.not_before or statement_timestamp()>=b.expires_at then 'EXPIRED_OR_NOT_YET_VALID'
    when coalesce(h.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end,
  'sequence',coalesce(h.sequence,0),'generation_id',h.generation_id,
  'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.events e where e.root_id=b.root_id),'[]'::jsonb),
  'authority_effect','NONE') from clued_control.accepted_binding b
  left join clued_control.current_head h using(root_id) where b.root_id=p_root_id
$$;
revoke all on all tables in schema clued_control from public,anon,authenticated,service_role;
revoke all on all functions in schema clued_control from public,anon,authenticated,service_role;
grant usage on schema clued_control to service_role;
grant execute on function clued_control.append_event(jsonb),clued_control.read_root(text) to service_role;
-- Intentionally no INSERT into accepted_binding, no new identity/Receipt, no old-table changes.
