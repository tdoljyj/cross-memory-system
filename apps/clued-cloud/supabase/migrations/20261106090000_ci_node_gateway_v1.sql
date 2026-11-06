-- Unified scheduling 2B: the node signature gateway, node qualification reports
-- against the approved node list, the job state machine (G7), the renewal
-- progress counter (G10) and the green ledger sidecar mirror.
-- Task 54969190-7db3-459d-a671-663f9e6bd24d; design PR #969 DESIGN.md r4 3.3
-- (G3, G7, G10), 5.3, 6.1 2B; Owner Decision e6e4c3e8 (Q-B1..Q-B3);
-- Stage 1 README "Signature candidate protocol" (separately reviewed transport,
-- atomic database context and nonce).
--
-- Trust model. PostgreSQL cannot verify P-256 (Stage 1 header): the serving
-- Worker verifies the node signature with WebCrypto, then makes exactly one
-- mutation RPC. That RPC, and the read-only trust RPC before it, are executable
-- only by clued_worker_gateway (the scan-start precedent). In one transaction the
-- mutation RPC resolves the node's own Binding from its token, re-checks every
-- signed identity field against the node row, refuses a reused command nonce,
-- runs exactly one private core function and keeps the signed command (not the
-- payload) so the signature can be verified again offline. The private core
-- functions keep their own locks, rechecks and effect nonces unchanged. No new
-- grant on any Stage 1 private function; no session or transaction setting is
-- trusted.
--
-- Known trust points: the database does not recompute the canonical payload
-- digest (no SQL canonical JSON); it binds the Worker-verified payload_sha256 to
-- the signed command. Qualification reports are node-signed self-attestations
-- (DESIGN 3B: hardening_observed comes from the node's own report); the Source
-- commit must be the one the Owner approved at registration, and scan signing
-- stays an Owner approval. As in Stage 1, any current approved publisher may
-- observe or settle another publisher's publication (recovery after a handover).
--
-- Owner decisions (e6e4c3e8): the approved node list gets a new version in the
-- same transaction as each node approval, drain, retirement or revocation (Q-B1);
-- the gateway is closed until the Owner opens it per project with a two-step
-- pool confirmation (Q-B2); an approved publisher node appends only its own
-- mirror rows (Q-B3).
--
-- Not in this migration (Task c176aea6, T2A-2): lease-next (G1), lease sweep
-- (G2), phase moves 1->2->3 (G4), liveness freshness (G5), preference and
-- exclusions (G6), the sixth check's publication key (G8), admission across
-- handover (G9), availability windows. Result expiry by time therefore stays a
-- read-time check (expires_at); no sweep sets 'expired' yet.

-- ---------------------------------------------------------------------------
-- Schema.

alter table clued_private.ci_nodes_v1 add column key_version bigint not null default 1 check(key_version>0);
alter table clued_private.ci_job_leases_v1 add column progress_seq bigint check(progress_seq is null or progress_seq>0);

-- The approved node list (stage2-readiness "Owner-accepted node list hash/
-- version"): one gapless version chain per project, never edited.
create table clued_private.ci_node_lists_v1 (
  user_id uuid not null, project_id uuid not null, list_version bigint not null check(list_version>0),
  list_sha256 text not null check(list_sha256 ~ '^[0-9a-f]{64}$'),
  nodes jsonb not null check(jsonb_typeof(nodes)='array'),
  cause text not null check(cause in ('seed','approve','drain','retire','revoke')), cause_node_id uuid,
  receipt_id uuid, created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,project_id,list_version)
);

-- Every accepted signed command, keyed by its nonce. The payload is bound by the
-- signed payload_sha256 and not stored (sealed drops carry ciphertext).
create table clued_private.ci_node_commands_v1 (
  nonce_sha256 text primary key check(nonce_sha256 ~ '^[0-9a-f]{64}$'),
  user_id uuid not null, project_id uuid not null, node_id uuid not null, binding_id uuid not null,
  operation text not null, command jsonb not null check(jsonb_typeof(command)='object' and octet_length(command::text)<=4096),
  payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb not null, created_at timestamptz not null default clock_timestamp(),
  foreign key(user_id,project_id,node_id) references clued_private.ci_nodes_v1(user_id,project_id,node_id)
);
create index ci_node_commands_node_v1 on clued_private.ci_node_commands_v1(user_id,project_id,node_id,created_at);
create index clued_audit_receipts_ci_node_rejected_idx on public.clued_audit_receipts(user_id,object_id,created_at desc)
  where operation='ci_node_command_rejected';

-- DESIGN 5.3: each publisher's local green ledger records, as written, in one
-- server-side hash chain per publisher node. No publication key, no Stage 1
-- green ledger row; no publication decision reads it. Its only reader is the
-- phase moves' open-green check.
create table clued_private.ci_green_mirror_v1 (
  mirror_id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null, project_id uuid not null, publisher_node_id uuid not null,
  seq bigint not null check(seq>0),
  prev_sha256 text not null check(prev_sha256 ~ '^[0-9a-f]{64}$'),
  row_sha256 text not null check(row_sha256 ~ '^[0-9a-f]{64}$'),
  record jsonb not null check(jsonb_typeof(record)='object' and octet_length(record::text)<=4096),
  record_sha256 text not null check(record_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),
  command_nonce_sha256 text not null references clued_private.ci_node_commands_v1(nonce_sha256) deferrable initially deferred,
  effect_key text not null check(effect_key ~ '^[0-9a-f]{64}$'),
  phase text not null check(phase in ('intent','posted','settled','merged','revoked')),
  repository_name text not null, pr bigint not null check(pr>0), head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
  check_run_id bigint, record_at timestamptz not null, receipt_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,project_id,publisher_node_id,seq),
  unique(user_id,project_id,publisher_node_id,record_sha256),
  foreign key(user_id,project_id,publisher_node_id) references clued_private.ci_nodes_v1(user_id,project_id,node_id)
);
create index ci_green_mirror_effect_v1 on clued_private.ci_green_mirror_v1(user_id,project_id,publisher_node_id,effect_key,seq desc);

create function clued_private.ci_append_only_guard_v1() returns trigger language plpgsql set search_path='' as $$ begin
  raise exception 'CI_PERMANENT_HISTORY' using errcode='55000';
end $$;
create trigger ci_node_lists_append_only_v1 before update or delete on clued_private.ci_node_lists_v1
  for each row execute function clued_private.ci_append_only_guard_v1();
create trigger ci_node_commands_append_only_v1 before update or delete on clued_private.ci_node_commands_v1
  for each row execute function clued_private.ci_append_only_guard_v1();
create trigger ci_green_mirror_append_only_v1 before update or delete on clued_private.ci_green_mirror_v1
  for each row execute function clued_private.ci_append_only_guard_v1();

do $acl$ declare t text; begin
  foreach t in array array['ci_node_lists_v1','ci_node_commands_v1','ci_green_mirror_v1'] loop
    execute format('alter table clued_private.%I enable row level security',t);
    execute format('revoke all on clued_private.%I from public,anon,authenticated,service_role,clued_worker_gateway',t);
  end loop;
end $acl$;

-- ---------------------------------------------------------------------------
-- Approved node list (Q-B1).

-- The list a new version would hold: every active or draining node of the
-- project with its identity key and approvals, in node order.
create function clued_private.ci_node_list_entries_v1(u uuid,p uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('node_id',n.node_id,'identity_fingerprint',n.identity_fingerprint,'state',n.state,
    'publisher',n.publisher_approved,'scan_signing',n.scan_signing_approved) order by n.node_id),'[]'::jsonb)
  from clued_private.ci_nodes_v1 n where n.user_id=u and n.project_id=p and n.state in ('active','draining')
$$;
create function clued_private.ci_node_list_current_v1(u uuid,p uuid) returns clued_private.ci_node_lists_v1
language sql stable security definer set search_path='' as $$
  select * from clued_private.ci_node_lists_v1 where user_id=u and project_id=p order by list_version desc limit 1
$$;
create function clued_private.ci_node_list_view_v1(u uuid,p uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('version',l.list_version,'sha256',l.list_sha256,'nodes',l.nodes,
      'cause',l.cause,'created_at',l.created_at)
    from clued_private.ci_node_lists_v1 l where l.user_id=u and l.project_id=p order by l.list_version desc limit 1),
    '{"version":0,"sha256":null,"nodes":[]}'::jsonb)
$$;

-- A node leaving the list loses its qualification at once: its current leases
-- are revoked, its unpublished jobs and its unused results are invalidated (G7).
-- Jobs with a publication key keep the Stage 1 UNKNOWN rules.
create function clued_private.ci_node_withdraw_v1(u uuid,p uuid,node uuid,reason text) returns void
language plpgsql volatile security definer set search_path='' as $$ declare t timestamptz:=clock_timestamp(); r uuid; begin
  r:=clued_private.ci_receipt_v1(u,p,'ci_node_withdraw',node::text,jsonb_build_object('reason',reason));
  -- Stage 1 lock order: job rows before their lease rows.
  perform 1 from clued_private.ci_jobs_v1 j where j.user_id=u and j.project_id=p
    and exists(select 1 from clued_private.ci_job_leases_v1 l where l.user_id=u and l.project_id=p and l.job_id=j.job_id and l.holder_node_id=node
      and (l.state='current' or l.generation=j.current_generation and j.state in ('leased','started','result_ready')))
    order by j.job_id for update;
  update clued_private.ci_nodes_v1 set qualification_status=case when qualification_status='unverified' then 'unverified' else 'expired' end,
    qualification_verified_at=null,qualification_expires_at=null,eligible_until=null,updated_at=t
    where user_id=u and project_id=p and node_id=node;
  update clued_private.ci_job_leases_v1 set state='revoked',terminal_at=t,terminal_reason='NODE_WITHDRAWN',terminal_receipt_id=r,receipt_id=r
    where user_id=u and project_id=p and holder_node_id=node and state='current';
  update clued_private.ci_jobs_v1 j set state='invalidated',version=j.version+1,updated_at=t,receipt_id=r
    where j.user_id=u and j.project_id=p and j.state in ('leased','started','result_ready')
      and exists(select 1 from clued_private.ci_job_leases_v1 l where l.user_id=u and l.project_id=p and l.job_id=j.job_id
        and l.generation=j.current_generation and l.holder_node_id=node)
      and not exists(select 1 from clued_private.ci_publish_keys_v1 k where k.job_id=j.job_id);
  update clued_private.ci_result_index_v1 set state='invalidated',receipt_id=r
    where user_id=u and project_id=p and producer_node_id=node and state='available';
end $$;

-- Called after a node state change, in the same transaction and after the node
-- row lock. A changed list gets the next version; a node missing from the new
-- version is withdrawn. A revoked node is never listed again (revocation is
-- final in Stage 1), and reports must name the newest version, so no older
-- version can restore it.
create function clued_private.ci_node_list_refresh_v1(u uuid,p uuid,node uuid,cause text) returns clued_private.ci_node_lists_v1
language plpgsql volatile security definer set search_path='' as $$
declare cur clued_private.ci_node_lists_v1; nxt clued_private.ci_node_lists_v1; entries jsonb; v bigint; r uuid; gone uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ci-node-list:'||u||':'||p,0));
  cur:=clued_private.ci_node_list_current_v1(u,p);
  entries:=clued_private.ci_node_list_entries_v1(u,p);
  if cur.list_version is not null and cur.nodes=entries then return cur; end if;
  if cur.list_version is null and entries='[]'::jsonb then return cur; end if;
  v:=coalesce(cur.list_version,0)+1;
  r:=clued_private.ci_receipt_v1(u,p,'ci_node_list',v::text,jsonb_build_object('cause',cause,'node_id',node,'nodes',entries));
  insert into clued_private.ci_node_lists_v1(user_id,project_id,list_version,list_sha256,nodes,cause,cause_node_id,receipt_id)
    values(u,p,v,clued_private.m1_sha256(jsonb_build_object('schema','clued.ci-node-list/1','project_id',p,'version',v,'nodes',entries)),
      entries,cause,node,r) returning * into nxt;
  for gone in select (x->>'node_id')::uuid from jsonb_array_elements(coalesce(cur.nodes,'[]'::jsonb)) x
    where not exists(select 1 from jsonb_array_elements(entries) y where y->>'node_id'=x->>'node_id') loop
    perform clued_private.ci_node_withdraw_v1(u,p,gone,'removed_from_list_v'||v);
  end loop;
  if cause='approve' and node is not null then
    update clued_private.ci_nodes_v1 set approved_manifest_version=nxt.list_version,approved_manifest_sha256=nxt.list_sha256
      where user_id=u and project_id=p and node_id=node and state='active';
  end if;
  return nxt;
end $$;

-- ---------------------------------------------------------------------------
-- Node qualification report (G3). The payload is node-signed (the gateway
-- verified the signature and its canonical payload_sha256): the registration
-- tool's report, the newest list version and sha256 that name this node, and
-- whether the node observes its hardening. scan_signing_approved stays an Owner
-- approval. Valid 7 days, capped by the node Binding's expiry.

create function clued_private.ci_node_qualify_v1(u uuid,p uuid,node uuid,payload jsonb,payload_sha256 text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; b public.clued_agent_bindings; l clued_private.ci_node_lists_v1; rep jsonb;
  t timestamptz:=clock_timestamp(); g timestamptz; e timestamptz; be timestamptz; r uuid;
begin
  perform clued_private.ci_input_v1(payload,array['schema','report','node_list_version','node_list_sha256','hardening_observed'],
    array['schema','report','node_list_version','node_list_sha256','hardening_observed'],32768);
  rep:=payload->'report';
  if payload->>'schema' is distinct from 'clued.ci-node-qualification/1' or jsonb_typeof(payload->'schema')<>'string'
    or jsonb_typeof(payload->'node_list_version')<>'number' or payload->>'node_list_version' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(payload->'node_list_sha256')<>'string' or payload->>'node_list_sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(payload->'hardening_observed')<>'boolean'
    or coalesce(payload_sha256,'') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(rep)<>'object' or rep->>'schema' is distinct from 'clued.ci-node-qualification-report/1'
    or jsonb_typeof(rep->'keys')<>'object' or jsonb_typeof(rep->'source')<>'object'
    or jsonb_typeof(rep->'source'->'commit')<>'string' or rep->'source'->>'commit' !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(rep->'profile_sha256')<>'string' or jsonb_typeof(rep->'generated_at')<>'string' then
    raise exception 'CI_QUALIFICATION_INVALID' using errcode='22023'; end if;
  begin g:=(rep->>'generated_at')::timestamptz;
  exception when others then raise exception 'CI_QUALIFICATION_INVALID' using errcode='22023'; end;
  if g>t+interval '2 minutes' or g<t-interval '15 minutes' then raise exception 'CI_QUALIFICATION_STALE' using errcode='22023'; end if;
  -- Node row, then the list lock: the same order as a node apply.
  select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=node for update;
  if not found or n.state<>'active' then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where id=n.binding_id and user_id=u;
  if not found or not clued_private.binding_live_v1(b) then raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  if rep->'keys'->>'identity_fingerprint' is distinct from n.identity_fingerprint
    or rep->'keys'->>'encryption_fingerprint' is distinct from n.encryption_fingerprint
    or rep->>'profile_sha256' is distinct from n.profile_sha256 then
    raise exception 'CI_QUALIFICATION_MISMATCH' using errcode='42501'; end if;
  -- The Source a node may run is the one the Owner approved with its
  -- registration; a different Source needs a new, approved registration.
  if n.qualification_source is null or rep->'source'->>'commit' is distinct from n.qualification_source then
    raise exception 'CI_QUALIFICATION_SOURCE_NOT_APPROVED' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ci-node-list:'||u||':'||p,0));
  l:=clued_private.ci_node_list_current_v1(u,p);
  if l.list_version is null or l.list_version<>(payload->>'node_list_version')::bigint or l.list_sha256<>payload->>'node_list_sha256'
    or not exists(select 1 from jsonb_array_elements(l.nodes) x where x->>'node_id'=node::text and x->>'identity_fingerprint'=n.identity_fingerprint) then
    raise exception 'CI_NODE_LIST_NOT_CURRENT' using errcode='42501'; end if;
  be:=(to_jsonb(b)->>'expires_at')::timestamptz;
  e:=least(t+interval '7 days',coalesce(be,'infinity'::timestamptz));
  if e<=t then raise exception 'CI_BINDING_UNAVAILABLE' using errcode='42501'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_node_qualify',node::text,jsonb_build_object('payload_sha256',payload_sha256,
    'node_list_version',l.list_version,'source',rep->'source'->>'commit','report_generated_at',g,'hardening_observed',(payload->>'hardening_observed')::boolean,'expires_at',e));
  -- Not the node version: an Owner confirmation prepared on this node stays
  -- valid while the node (re)qualifies, and signed commands keep their version.
  update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=t,qualification_expires_at=e,eligible_until=e,
    qualification_receipt_ref=r::text,hardening_observed=(payload->>'hardening_observed')::boolean,
    approved_manifest_version=l.list_version,approved_manifest_sha256=l.list_sha256,
    connection_expires_at=be,updated_at=t,receipt_id=r where node_id=node returning * into n;
  return jsonb_build_object('status','qualified','node_id',n.node_id,'version',n.version,'qualification_receipt_ref',n.qualification_receipt_ref,
    'qualification_source',n.qualification_source,'qualification_expires_at',n.qualification_expires_at,'eligible_until',n.eligible_until,
    'hardening_observed',n.hardening_observed,'node_list_version',l.list_version,'receipt_id',r);
end $$;

-- ---------------------------------------------------------------------------
-- G10: renewal with a monotonic progress counter. Same checks and lease cap as
-- ci_job_renew_v1; the digest is optional and need not change.

create function clued_private.ci_job_renew_v2(u uuid,p uuid,node uuid,id uuid,g bigint,v bigint,seq bigint,progress text default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare j clued_private.ci_jobs_v1; l clued_private.ci_job_leases_v1; n clued_private.ci_nodes_v1; r uuid; begin
  perform clued_private.work_claim_lock(u);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id;
  if not found then raise exception 'CI_JOB_NOT_FOUND' using errcode='42501'; end if;
  perform clued_private.ci_repo_v1(u,p,j.repository_id); perform clued_private.ci_policy_v1(u,p); n:=clued_private.ci_node_current_v1(u,p,node,false,'renew');
  perform 1 from clued_private.ci_jobs_v1 where job_id=id for update; l:=clued_private.ci_lease_current_v1(u,p,id,g,node);
  perform clued_private.ci_claim_current_v1(u,j,'renew',g,node);
  perform clued_private.ci_node_recheck_v1(n);
  if v is not null and seq is not null and l.lease_version=v+1 and l.progress_seq=seq
    and (progress is null or progress is not distinct from l.progress_digest) then
    return jsonb_build_object('generation',g,'lease_version',l.lease_version,'progress_seq',l.progress_seq,'expires_at',l.expires_at,'receipt_id',l.receipt_id,'replayed',true); end if;
  if v is null or l.lease_version is distinct from v or seq is null or seq<=coalesce(l.progress_seq,0)
    or progress is not null and progress !~ '^[0-9a-f]{64}$' then raise exception 'CI_RENEW_STALE' using errcode='40001'; end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_renew',id::text,jsonb_build_object('generation',g,'lease_version',v+1,'progress_seq',seq,'progress_digest',progress));
  update clued_private.ci_job_leases_v1 set lease_version=lease_version+1,progress_seq=seq,progress_digest=coalesce(progress,progress_digest),receipt_id=r,
    expires_at=least(clock_timestamp()+interval '10 minutes',n.qualification_expires_at,n.eligible_until,
      (select expires_at from clued_private.work_claims_v1 where claim_id=j.claim_id)) where job_id=id and generation=g returning * into l;
  return jsonb_build_object('generation',g,'lease_version',l.lease_version,'progress_seq',l.progress_seq,'expires_at',l.expires_at,'receipt_id',r,'replayed',false);
end $$;

-- ---------------------------------------------------------------------------
-- Green ledger sidecar mirror (DESIGN 5.3, Q-B3).

-- The resident's record contract clued.independent-ci.green-ledger/1
-- (independent-control-checks-v2/green-ledger.mjs validateGreenEntry), checked
-- field by field; anything else is refused, never coerced.
create function clued_private.ci_green_record_valid_v1(r jsonb) returns boolean
language plpgsql stable set search_path='' as $$ begin
  if jsonb_typeof(r) is distinct from 'object'
    or r-array['contract','phase','repo','pr','headSha','baseSha','testTree','testMergeSha','effectKey','externalId','checkRunId','at','detail']<>'{}'::jsonb
    or not (r ?& array['contract','phase','repo','pr','headSha','baseSha','testTree','testMergeSha','effectKey','externalId','checkRunId','at','detail'])
    or r->'contract'<>'"clued.independent-ci.green-ledger/1"'::jsonb
    or jsonb_typeof(r->'phase')<>'string' or r->>'phase' not in ('intent','posted','settled','merged','revoked')
    or jsonb_typeof(r->'repo')<>'string' or r->>'repo' !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' or length(r->>'repo')>201
    or jsonb_typeof(r->'pr')<>'number' or r->>'pr' !~ '^[1-9][0-9]{0,15}$' or (r->>'pr')::numeric>9007199254740991
    or jsonb_typeof(r->'headSha')<>'string' or r->>'headSha' !~ '^[a-f0-9]{40}$'
    or jsonb_typeof(r->'baseSha')<>'string' or r->>'baseSha' !~ '^[a-f0-9]{40}$'
    or jsonb_typeof(r->'testTree')<>'string' or r->>'testTree' !~ '^[a-f0-9]{40}$'
    or not (r->'testMergeSha'='null'::jsonb or jsonb_typeof(r->'testMergeSha')='string' and r->>'testMergeSha' ~ '^[a-f0-9]{40}$')
    or jsonb_typeof(r->'effectKey')<>'string' or r->>'effectKey' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(r->'externalId')<>'string' or left(r->>'externalId',23)<>'independent-ci:control:' or length(r->>'externalId')>300
    or not (r->'checkRunId'='null'::jsonb or jsonb_typeof(r->'checkRunId')='number' and r->>'checkRunId' ~ '^[1-9][0-9]{0,15}$'
      and (r->>'checkRunId')::numeric<=9007199254740991)
    or r->>'phase'<>'intent' and r->'checkRunId'='null'::jsonb
    -- An ISO-8601 instant with an explicit zone (Date#toISOString), never a
    -- PostgreSQL special value or a zone-dependent local time.
    or jsonb_typeof(r->'at')<>'string'
    or r->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or not (r->'detail'='null'::jsonb or jsonb_typeof(r->'detail')='string' and length(r->>'detail')<=200) then return false; end if;
  perform (r->>'at')::timestamptz;
  return true;
exception when others then return false;
end $$;

create function clued_private.ci_green_mirror_append_v1(u uuid,p uuid,node uuid,payload jsonb,payload_sha256 text,command_nonce text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; rec jsonb; d text; m clued_private.ci_green_mirror_v1; prev clued_private.ci_green_mirror_v1;
  s bigint; ph text; rh text; r uuid;
begin
  perform clued_private.ci_input_v1(payload,array['record'],array['record'],8192);
  rec:=payload->'record';
  if not clued_private.ci_green_record_valid_v1(rec) or coalesce(payload_sha256,'') !~ '^[0-9a-f]{64}$'
    or coalesce(command_nonce,'') !~ '^[0-9a-f]{64}$' then raise exception 'CI_GREEN_RECORD_INVALID' using errcode='22023'; end if;
  -- An approved publisher, active or draining, on its live Binding; only its own
  -- rows. No current qualification is needed: a draining publisher whose
  -- qualification lapsed must still be able to record how its greens ended.
  select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=node for share;
  if not found or n.state not in ('active','draining') or not n.publisher_approved
    or not exists(select 1 from public.clued_agent_bindings b where b.id=n.binding_id and b.user_id=u and clued_private.binding_live_v1(b)) then
    raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ci-green-mirror:'||u||':'||p||':'||node,0));
  d:=clued_private.m1_sha256(rec);
  select * into m from clued_private.ci_green_mirror_v1 where user_id=u and project_id=p and publisher_node_id=node and record_sha256=d;
  if found then return jsonb_build_object('status','mirrored','replayed',true,'mirror_id',m.mirror_id,'seq',m.seq,'row_sha256',m.row_sha256,'receipt_id',m.receipt_id); end if;
  select * into prev from clued_private.ci_green_mirror_v1 where user_id=u and project_id=p and publisher_node_id=node order by seq desc limit 1;
  s:=coalesce(prev.seq,0)+1; ph:=coalesce(prev.row_sha256,repeat('0',64));
  rh:=clued_private.m1_sha256(jsonb_build_object('node_id',node,'seq',s,'prev_sha256',ph,'record_sha256',d));
  r:=clued_private.ci_receipt_v1(u,p,'ci_green_mirror_append',node::text,jsonb_build_object('seq',s,'row_sha256',rh,'record_sha256',d,
    'effect_key',rec->>'effectKey','phase',rec->>'phase'));
  insert into clued_private.ci_green_mirror_v1(user_id,project_id,publisher_node_id,seq,prev_sha256,row_sha256,record,record_sha256,payload_sha256,
    command_nonce_sha256,effect_key,phase,repository_name,pr,head_sha,check_run_id,record_at,receipt_id)
  values(u,p,node,s,ph,rh,rec,d,payload_sha256,command_nonce,rec->>'effectKey',rec->>'phase',rec->>'repo',(rec->>'pr')::bigint,rec->>'headSha',
    (rec->>'checkRunId')::bigint,(rec->>'at')::timestamptz,r) returning * into m;
  return jsonb_build_object('status','mirrored','replayed',false,'mirror_id',m.mirror_id,'seq',m.seq,'row_sha256',m.row_sha256,'receipt_id',r);
end $$;

-- T2A's open-green count now also counts the mirror: per publisher node and
-- effect key, a green is open while no merged/revoked record exists for it (a
-- late retry of an older record cannot reopen it).
create or replace function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select (select count(*) from clued_private.ci_green_ledger_v1 g
      where g.user_id=u and g.project_id=p and g.state not in ('abandoned','revoke_confirmed','merged'))
    +(select count(*) from (select m.publisher_node_id,m.effect_key from clued_private.ci_green_mirror_v1 m
        where m.user_id=u and m.project_id=p group by m.publisher_node_id,m.effect_key
        having bool_and(m.phase in ('intent','posted','settled'))) x)
$$;

-- The mirror ships here; its writers (the resident publishers, T3 3D) do not.
-- An empty mirror proves nothing, so the forward move keeps an outstanding item
-- until every publisher writes it.
create or replace function clued_private.ci_phase_external_prerequisites_v1(u uuid,p uuid) returns text[]
language sql stable security definer set search_path='' as $$
  select array['green_mirror_writers_3d','admission_issue_fact_g9','resident_phase_routing_4e','reconciliation_days_q2',
    'maintenance_never_leased_g1','dedicated_maintenance_claim_t4','admission_meter_dedup_phase4',
    'sweep_watermark_single_source','hosted_admission_publication_route']::text[]
$$;

-- ---------------------------------------------------------------------------
-- Gateway switch (Q-B2): pool policy flag signature_gateway_active, false
-- unless the Owner opens it with a two-step pool confirmation.

create function clued_private.ci_gateway_flag_v1(policy jsonb,c jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('signature_gateway_active',case when c ? 'signature_gateway_active'
    then c->'signature_gateway_active'='true'::jsonb else coalesce(policy->'signature_gateway_active','false'::jsonb)='true'::jsonb end)
$$;
create function clued_private.ci_gateway_open_v1(u uuid,p uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select policy->'signature_gateway_active'='true'::jsonb from clued_private.ci_quota_counters_v1
    where user_id=u and project_id=p and row_kind='pool_policy'),false)
$$;

-- ---------------------------------------------------------------------------
-- Anchored rewrites of current definitions (the T2A method): one exact, unique
-- piece of current text each; a missing function or anchor aborts everything.

create function clued_private.ci_gateway_patch_v1(p_signature text,p_anchor text,p_replacement text) returns void
language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then raise exception 'ci_gateway_patch_function_missing: %',p_signature; end if;
  body:=pg_get_functiondef(target);
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'ci_gateway_patch_anchor_mismatch: %',p_signature; end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- Q-B1: every node apply refreshes the approved node list in its transaction.
select clued_private.ci_gateway_patch_v1('clued_private.ci_apply_v1(jsonb,text)',
$a$      v:=jsonb_build_object('node_id',n.node_id,'version',n.version,'state',n.state,'qualification_status',n.qualification_status);$a$,
$r$      perform clued_private.ci_node_list_refresh_v1(u,p,n.node_id,c->>'action');
      select * into n from clued_private.ci_nodes_v1 where node_id=n.node_id;
      v:=jsonb_build_object('node_id',n.node_id,'version',n.version,'state',n.state,'qualification_status',n.qualification_status,
        'node_list_version',(clued_private.ci_node_list_current_v1(u,p)).list_version);$r$);

-- Q-B2: a pool apply keeps the gateway flag unless the confirmed choices set it.
select clued_private.ci_gateway_patch_v1('clued_private.ci_apply_v1(jsonb,text)',
$a$          ||clued_private.ci_duty_policy_keep_v1(policy),$a$,
$r$          ||clued_private.ci_duty_policy_keep_v1(policy)||clued_private.ci_gateway_flag_v1(policy,c),$r$);
select clued_private.ci_gateway_patch_v1('public.clued_ci_pool_confirmation_issue_v1(jsonb)',
$a$  perform clued_private.ci_input_v1(p_input,array['project_id','base_version','repository','limits','accepted_ref'],array['project_id','base_version']);$a$,
$r$  perform clued_private.ci_input_v1(p_input,array['project_id','base_version','repository','limits','accepted_ref','signature_gateway_active'],array['project_id','base_version']);
  if p_input ? 'signature_gateway_active' and jsonb_typeof(p_input->'signature_gateway_active') is distinct from 'boolean' then
    raise exception 'CI_INPUT_INVALID' using errcode='22023'; end if;
  if p_input->'signature_gateway_active'='true'::jsonb and nullif(btrim(p_input->>'accepted_ref'),'') is null then
    raise exception 'CI_ACCEPTANCE_REF_REQUIRED' using errcode='22023'; end if;$r$);

-- A node's (re)qualification must not make an Owner confirmation prepared on
-- that node stale. The confirmation view leaves out the fields qualification
-- writes; every Owner-decided field stays in it.
select clued_private.ci_gateway_patch_v1('clued_private.ci_confirmation_view_v1(uuid,uuid,text,jsonb)',
$a$v:=jsonb_build_object('node',clued_private.ci_node_view_v1(n),$a$,
$r$v:=jsonb_build_object('node',clued_private.ci_node_view_v1(n)-array['qualification_status','qualification_verified_at',
      'qualification_expires_at','qualification_receipt_ref','hardening_observed','approved_manifest_version','approved_manifest_sha256',
      'eligible_until','connection_expires_at','updated_at','receipt_id'],$r$);

-- One pool lock order everywhere: the gateway and every core function take the
-- pool lock before a repository lock, so a pool apply naming a repository takes
-- the pool lock first too. A retirement withdraws the node (its jobs and
-- leases), so it takes the pool lock as a revocation does; neither creates a
-- pool row (a new row in another project would make T2A's duty checks see two
-- CI projects and fail closed). Same lock key as ci_policy_v1.
select clued_private.ci_gateway_patch_v1('clued_private.ci_apply_v1(jsonb,text)',
$a$    if kind='ci_pool' and c ? 'repository' then$a$,
$r$    if kind='ci_pool' then q:=clued_private.ci_policy_v1(u,p); end if;
    if kind='ci_pool' and c ? 'repository' then$r$);
select clued_private.ci_gateway_patch_v1('clued_private.ci_apply_v1(jsonb,text)',
$a$    if kind='ci_node' and c->>'action'='revoke' then
      q:=clued_private.ci_policy_v1(u,p);$a$,
$r$    if kind='ci_node' and c->>'action' in ('revoke','retire') then
      perform pg_advisory_xact_lock(hashtextextended('ci-pool:'||u||':'||p,0));
      perform 1 from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='pool_policy' for update;$r$);

-- T2A's phase moves lock the pool row before anything takes the pool advisory
-- lock: take that lock first, in ci_policy_v1's order (advisory, then row).
select clued_private.ci_gateway_patch_v1('clued_private.ci_phase_3_to_4_v1(uuid,uuid,integer,jsonb)',
$a$  perform clued_private.work_claim_lock(u);$a$,
$r$  perform clued_private.work_claim_lock(u);
  perform pg_advisory_xact_lock(hashtextextended('ci-pool:'||u||':'||p,0));$r$);
select clued_private.ci_gateway_patch_v1('clued_private.ci_phase_4_to_3_v1(uuid,uuid,integer,boolean)',
$a$  perform clued_private.work_claim_lock(u);$a$,
$r$  perform clued_private.work_claim_lock(u);
  perform pg_advisory_xact_lock(hashtextextended('ci-pool:'||u||':'||p,0));$r$);

-- The Owner page shows the current approved node list.
select clued_private.ci_gateway_patch_v1('public.clued_ci_nodes_v1(jsonb)',
$a$'pool',clued_private.ci_pool_view_v1(u,p),$a$,
$r$'pool',clued_private.ci_pool_view_v1(u,p),'node_list',clued_private.ci_node_list_view_v1(u,p),$r$);

-- G7: result registration makes a started job result_ready; a publication
-- reservation makes it publication_pending; once every key of the job is
-- observed posted it is observed. Release still ends it (completed, failed,
-- canceled, uncertain) exactly as in Stage 1.
select clued_private.ci_gateway_patch_v1('clued_private.ci_result_register_v1(uuid,uuid,uuid,uuid,bigint,jsonb)',
$a$  update clued_private.ci_result_index_v1 set receipt_id=r where result_id=rid;$a$,
$r$  update clued_private.ci_result_index_v1 set receipt_id=r where result_id=rid;
  update clued_private.ci_jobs_v1 set state='result_ready',version=version+1,updated_at=t,receipt_id=r where job_id=id and state='started';$r$);
select clued_private.ci_gateway_patch_v1('clued_private.ci_publish_prepare_v1(uuid,uuid,uuid,uuid,bigint,jsonb)',
$a$  if k.check_name='kooyumi-merge-slot' then$a$,
$r$  update clued_private.ci_jobs_v1 set state='publication_pending',version=version+1,updated_at=t,receipt_id=r
    where job_id=id and state in ('started','result_ready','observed');
  if k.check_name='kooyumi-merge-slot' then$r$);
select clued_private.ci_gateway_patch_v1('clued_private.ci_publish_observe_v1(uuid,uuid,uuid,uuid,text,bigint,text,uuid,text)',
$a$      where publish_key_id=keyid and state in ('proposed','unknown','abandoned');$a$,
$r$      where publish_key_id=keyid and state in ('proposed','unknown','abandoned');
    update clued_private.ci_jobs_v1 set state='observed',version=version+1,updated_at=t where job_id=k.job_id and state='publication_pending'
      and not exists(select 1 from clued_private.ci_publish_keys_v1 x where x.job_id=k.job_id and x.state<>'posted');$r$);

drop function clued_private.ci_gateway_patch_v1(text,text,text);

-- Seed: a project that already has active or draining nodes gets version 1.
do $seed$ declare x record; begin
  for x in select distinct user_id,project_id from clued_private.ci_nodes_v1 where state in ('active','draining') loop
    perform clued_private.ci_node_list_refresh_v1(x.user_id,x.project_id,null,'seed');
  end loop;
end $seed$;

-- ---------------------------------------------------------------------------
-- Gateway RPCs. Both are executable only by clued_worker_gateway.

-- The node's own Binding token resolves the principal; the node must be bound
-- to that Binding. Refusals are uniform so the RPC is no node oracle.
create function clued_private.ci_gateway_node_v1(p_token_hash text,p_node uuid) returns clued_private.ci_nodes_v1
language plpgsql volatile security definer set search_path='' as $$ declare n clued_private.ci_nodes_v1; b public.clued_agent_bindings; begin
  if p_node is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'CI_NODE_TRUST_UNAVAILABLE' using errcode='42501'; end if;
  select * into n from clued_private.ci_nodes_v1 where node_id=p_node;
  if not found then raise exception 'CI_NODE_TRUST_UNAVAILABLE' using errcode='42501'; end if;
  begin b:=clued_private.resolve_binding(p_token_hash,'context:read','project:'||n.project_id);
  exception when others then raise exception 'CI_NODE_TRUST_UNAVAILABLE' using errcode='42501'; end;
  if b.id is distinct from n.binding_id or b.user_id is distinct from n.user_id then raise exception 'CI_NODE_TRUST_UNAVAILABLE' using errcode='42501'; end if;
  return n;
end $$;
create function clued_private.ci_epoch_ms_v1(t timestamptz) returns bigint language sql immutable set search_path='' as $$
  select case when t is null then 0 when t='infinity'::timestamptz then 253402300799000 else floor(extract(epoch from t)*1000)::bigint end
$$;
create function clued_private.ci_gateway_snapshot_v1(n clued_private.ci_nodes_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('status','ok',
    'principal',jsonb_build_object('user_id',n.user_id,'project_id',n.project_id,'binding_id',n.binding_id,'binding_generation',n.binding_generation),
    'node',jsonb_build_object('node_id',n.node_id,'user_id',n.user_id,'project_id',n.project_id,'binding_id',n.binding_id,
      'binding_generation',n.binding_generation,'version',n.version,'key_version',n.key_version,
      'identity_fingerprint',n.identity_fingerprint,'identity_public_jwk',n.identity_public_jwk,'state',n.state,
      'qualification_verified',n.qualification_status='verified' and coalesce(n.qualification_expires_at>clock_timestamp(),false)
        and coalesce(n.eligible_until>clock_timestamp(),false),
      'publisher_approved',n.publisher_approved,
      'binding_expires_at_ms',clued_private.ci_epoch_ms_v1(coalesce((select (to_jsonb(b)->>'expires_at')::timestamptz
        from public.clued_agent_bindings b where b.id=n.binding_id),'infinity'::timestamptz)),
      'qualification_expires_at_ms',case when n.qualification_expires_at is null or n.eligible_until is null then 0
        else clued_private.ci_epoch_ms_v1(least(n.qualification_expires_at,n.eligible_until)) end),
    'qualification',jsonb_build_object('status',n.qualification_status,'receipt_ref',n.qualification_receipt_ref,
      'source',n.qualification_source,'hardening_observed',n.hardening_observed,'scan_signing_approved',n.scan_signing_approved),
    'node_list',clued_private.ci_node_list_view_v1(n.user_id,n.project_id)-'nodes',
    'gateway_open',clued_private.ci_gateway_open_v1(n.user_id,n.project_id))
$$;
create function public.clued_ci_node_trust_v1(p_token_hash text,p_node_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ begin
  return clued_private.ci_gateway_snapshot_v1(clued_private.ci_gateway_node_v1(p_token_hash,p_node_id));
exception when others then
  return jsonb_build_object('status','rejected','error_code','CI_NODE_TRUST_UNAVAILABLE');
end $$;

-- One signed node command, one transaction. p_verified is what the Worker
-- established: the operation, node, payload_sha256 (of the canonical payload)
-- and nonce_sha256 it verified, and when.
create function public.clued_ci_node_command_v1(p_token_hash text,p_command jsonb,p_payload jsonb,p_verified jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare n clued_private.ci_nodes_v1; op text; job uuid; g bigint; tg bigint; now_ms bigint; ns text; ps text;
  prior clued_private.ci_node_commands_v1; res jsonb; x jsonb; k clued_private.ci_publish_keys_v1;
  e clued_private.ci_green_ledger_v1; d clued_private.ci_sealed_drop_v1; after_version bigint; code text;
  keys constant text[]:=array['protocol','operation','user_id','project_id','node_id','binding_id','binding_generation','node_version',
    'key_version','key_fingerprint','payload_sha256','nonce','job_id','execution_generation','train_generation','issued_at_ms','expires_at_ms','signature'];
begin
  begin
    if jsonb_typeof(p_command) is distinct from 'object' or p_command-keys<>'{}'::jsonb or not (p_command ?& keys)
      or jsonb_typeof(p_payload) is null or octet_length(p_payload::text)>196608
      or jsonb_typeof(p_verified) is distinct from 'object'
      or p_verified-array['operation','node_id','payload_sha256','nonce_sha256','verified_at_ms']<>'{}'::jsonb
      or not (p_verified ?& array['operation','node_id','payload_sha256','nonce_sha256','verified_at_ms'])
      or p_command->>'protocol' is distinct from 'clued.ci-node-command/1'
      or jsonb_typeof(p_command->'operation')<>'string' or jsonb_typeof(p_command->'nonce')<>'string' or p_command->>'nonce' !~ '^[A-Za-z0-9_-]{43}$'
      or jsonb_typeof(p_command->'signature')<>'string' or p_command->>'signature' !~ '^[A-Za-z0-9_-]{86}$'
      or jsonb_typeof(p_command->'payload_sha256')<>'string' or p_command->>'payload_sha256' !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(p_command->'key_fingerprint')<>'string' or p_command->>'key_fingerprint' !~ '^[0-9a-f]{64}$'
      or exists(select 1 from unnest(array['binding_generation','node_version','key_version','execution_generation','train_generation','issued_at_ms','expires_at_ms']) f
        where jsonb_typeof(p_command->f) is distinct from 'number' or p_command->>f !~ '^[0-9]{1,16}$')
      or exists(select 1 from unnest(array['user_id','project_id','node_id','binding_id']) f
        where jsonb_typeof(p_command->f) is distinct from 'string' or p_command->>f !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or not (p_command->'job_id'='null'::jsonb or jsonb_typeof(p_command->'job_id')='string'
        and p_command->>'job_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or p_verified->'operation' is distinct from p_command->'operation' or p_verified->'node_id' is distinct from p_command->'node_id'
      or p_verified->'payload_sha256' is distinct from p_command->'payload_sha256'
      or jsonb_typeof(p_verified->'nonce_sha256')<>'string'
      or p_verified->>'nonce_sha256' is distinct from encode(extensions.digest(convert_to(p_command->>'nonce','UTF8'),'sha256'),'hex')
      or jsonb_typeof(p_verified->'verified_at_ms')<>'number' or p_verified->>'verified_at_ms' !~ '^[0-9]{1,16}$' then
      raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    op:=p_command->>'operation'; job:=(p_command->>'job_id')::uuid; g:=(p_command->>'execution_generation')::bigint;
    tg:=(p_command->>'train_generation')::bigint; ns:=p_verified->>'nonce_sha256'; ps:=p_command->>'payload_sha256';
    now_ms:=clued_private.ci_epoch_ms_v1(clock_timestamp());
    if abs(now_ms-(p_verified->>'verified_at_ms')::bigint)>30000 or (p_command->>'issued_at_ms')::bigint>now_ms+5000
      or (p_command->>'expires_at_ms')::bigint<=now_ms
      or (p_command->>'expires_at_ms')::bigint-(p_command->>'issued_at_ms')::bigint not between 1 and 120000 then
      raise exception 'CI_COMMAND_EXPIRED' using errcode='42501'; end if;
    n:=clued_private.ci_gateway_node_v1(p_token_hash,(p_command->>'node_id')::uuid);
    if (p_command->>'user_id')::uuid<>n.user_id or (p_command->>'project_id')::uuid<>n.project_id or (p_command->>'binding_id')::uuid<>n.binding_id
      or (p_command->>'binding_generation')::bigint<>n.binding_generation then raise exception 'CI_COMMAND_PRINCIPAL_INVALID' using errcode='42501'; end if;
    -- A retried command returns its original (redacted) result; a reused nonce
    -- never runs again. Concurrent copies of one command wait for each other here,
    -- so the second sees the first one's ledger row.
    perform pg_advisory_xact_lock(hashtextextended('ci-node-command:'||ns,0));
    select * into prior from clued_private.ci_node_commands_v1 where nonce_sha256=ns;
    if found then
      if prior.command=p_command and prior.node_id=n.node_id then return prior.result||jsonb_build_object('replayed',true); end if;
      raise exception 'CI_COMMAND_REPLAY' using errcode='42501'; end if;
    if not clued_private.ci_gateway_open_v1(n.user_id,n.project_id) then raise exception 'SIGNATURE_GATEWAY_NOT_ACTIVATED' using errcode='42501'; end if;
    -- Every core function's lock order: the account's work-claim lock, the pool
    -- lock, then the node row. Holding them from here, the signed identity is
    -- checked against the node row as it stays until commit.
    perform clued_private.work_claim_lock(n.user_id);
    perform clued_private.ci_policy_v1(n.user_id,n.project_id);
    select * into n from clued_private.ci_nodes_v1 where node_id=n.node_id for share;
    if n.state not in ('active','draining') then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;
    if (p_command->>'node_version')::bigint<>n.version or (p_command->>'key_version')::bigint<>n.key_version
      or p_command->>'key_fingerprint'<>n.identity_fingerprint then raise exception 'CI_COMMAND_STALE_VERSION' using errcode='42501'; end if;
    if op in ('qualification_report','train_sweep_confirm','green_mirror_append') then
      if job is not null or g<>0 then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    elsif op in ('nonce_issue','job_lease','job_renew','job_started','job_release','stage8_try_begin','result_register','publish_prepare',
      'publish_observe','green_transition','sealed_drop_send','sealed_drop_take','train_front_set') then
      if job is null or g<1 then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    else raise exception 'CI_OPERATION_NOT_SERVED' using errcode='42501'; end if;
    if op not in ('train_front_set','train_sweep_confirm') and tg<>0 then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
    x:=p_payload;

    if op='qualification_report' then
      res:=clued_private.ci_node_qualify_v1(n.user_id,n.project_id,n.node_id,p_payload,ps);
    elsif op='green_mirror_append' then
      res:=clued_private.ci_green_mirror_append_v1(n.user_id,n.project_id,n.node_id,p_payload,ps,ns);
    elsif op='nonce_issue' then
      perform clued_private.ci_input_v1(p_payload,array['purpose','subject_digest'],array['purpose','subject_digest']);
      if jsonb_typeof(p_payload->'purpose')<>'string' or jsonb_typeof(p_payload->'subject_digest')<>'string'
        or p_payload->>'purpose' not in ('result-register','publish-reserve','publish-observe','green-transition','drop-send','drop-take') then
        raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      res:=clued_private.ci_nonce_issue_v1(n.user_id,n.project_id,n.node_id,p_payload->>'purpose',p_payload->>'subject_digest',job,g,600);
    elsif op='job_lease' then
      perform clued_private.ci_input_v1(x,array['expected_version'],array['expected_version']);
      if jsonb_typeof(x->'expected_version')<>'number' or x->>'expected_version' !~ '^[1-9][0-9]{0,15}$' then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      res:=clued_private.ci_job_lease_v1(n.user_id,n.project_id,n.node_id,job,(x->>'expected_version')::bigint);
      if (res->>'generation')::bigint<>g then raise exception 'CI_COMMAND_GENERATION_MISMATCH' using errcode='40001'; end if;
    elsif op='job_renew' then
      perform clued_private.ci_input_v1(x,array['lease_version','progress_seq','progress_digest'],array['lease_version','progress_seq']);
      if jsonb_typeof(x->'lease_version')<>'number' or x->>'lease_version' !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(x->'progress_seq')<>'number' or x->>'progress_seq' !~ '^[1-9][0-9]{0,15}$'
        or x ? 'progress_digest' and (jsonb_typeof(x->'progress_digest')<>'string' or x->>'progress_digest' !~ '^[0-9a-f]{64}$') then
        raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      res:=clued_private.ci_job_renew_v2(n.user_id,n.project_id,n.node_id,job,g,(x->>'lease_version')::bigint,(x->>'progress_seq')::bigint,x->>'progress_digest');
    elsif op='job_started' then
      perform clued_private.ci_input_v1(x,array[]::text[]);
      res:=clued_private.ci_job_started_v1(n.user_id,n.project_id,n.node_id,job,g);
    elsif op='job_release' then
      perform clued_private.ci_input_v1(x,array['reason','classification','breaker','classification_verified'],array['reason','classification','classification_verified']);
      if jsonb_typeof(x->'reason')<>'string' or length(x->>'reason') not between 1 and 64 or jsonb_typeof(x->'classification')<>'string'
        or x ? 'breaker' and not (x->'breaker'='null'::jsonb or jsonb_typeof(x->'breaker')='string' and length(x->>'breaker')<=32)
        or jsonb_typeof(x->'classification_verified')<>'boolean' then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      res:=clued_private.ci_job_release_v1(n.user_id,n.project_id,n.node_id,job,g,x->>'reason',x->>'classification',x->>'breaker',(x->>'classification_verified')::boolean);
    elsif op='stage8_try_begin' then
      perform clued_private.ci_input_v1(x,array['expected_try'],array['expected_try']);
      if jsonb_typeof(x->'expected_try')<>'number' or x->>'expected_try' !~ '^[1-9][0-9]{0,3}$' then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      res:=jsonb_build_object('stage8_try',clued_private.ci_stage8_try_begin_v1(n.user_id,n.project_id,n.node_id,job,g,(x->>'expected_try')::integer));
    elsif op='result_register' then
      res:=jsonb_build_object('result_id',clued_private.ci_result_register_v1(n.user_id,n.project_id,n.node_id,job,g,p_payload));
    elsif op='publish_prepare' then
      res:=clued_private.ci_publish_prepare_v1(n.user_id,n.project_id,n.node_id,job,g,p_payload);
    elsif op='publish_observe' then
      perform clued_private.ci_input_v1(p_payload,array['key_id','observation','check_run_id','evidence_digest','nonce_id','nonce'],
        array['key_id','observation','check_run_id','evidence_digest','nonce_id','nonce']);
      if jsonb_typeof(p_payload->'key_id')<>'string' or jsonb_typeof(p_payload->'observation')<>'string'
        or not (p_payload->'check_run_id'='null'::jsonb or jsonb_typeof(p_payload->'check_run_id')='number' and p_payload->>'check_run_id' ~ '^[1-9][0-9]{0,15}$')
        or jsonb_typeof(p_payload->'evidence_digest')<>'string' or jsonb_typeof(p_payload->'nonce_id')<>'string' or jsonb_typeof(p_payload->'nonce')<>'string' then
        raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      select * into k from clued_private.ci_publish_keys_v1 where key_id=(p_payload->>'key_id')::uuid and user_id=n.user_id and project_id=n.project_id;
      if not found or k.job_id<>job or k.execution_generation<>g then raise exception 'CI_COMMAND_SUBJECT_MISMATCH' using errcode='42501'; end if;
      res:=clued_private.ci_publish_observe_v1(n.user_id,n.project_id,n.node_id,k.key_id,p_payload->>'observation',(p_payload->>'check_run_id')::bigint,
        p_payload->>'evidence_digest',(p_payload->>'nonce_id')::uuid,p_payload->>'nonce');
    elsif op='green_transition' then
      perform clued_private.ci_input_v1(p_payload,array['entry_id','state_version','action','evidence_digest','ancestor','nonce_id','nonce'],
        array['entry_id','state_version','action','evidence_digest','ancestor','nonce_id','nonce']);
      if jsonb_typeof(p_payload->'entry_id')<>'string' or jsonb_typeof(p_payload->'state_version')<>'number' or p_payload->>'state_version' !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(p_payload->'action')<>'string' or jsonb_typeof(p_payload->'evidence_digest')<>'string' or jsonb_typeof(p_payload->'ancestor')<>'boolean'
        or jsonb_typeof(p_payload->'nonce_id')<>'string' or jsonb_typeof(p_payload->'nonce')<>'string' then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      select * into e from clued_private.ci_green_ledger_v1 where entry_id=(p_payload->>'entry_id')::uuid and user_id=n.user_id and project_id=n.project_id;
      select * into k from clued_private.ci_publish_keys_v1 where key_id=e.publish_key_id;
      if e.entry_id is null or e.job_id<>job or k.execution_generation is distinct from g then raise exception 'CI_COMMAND_SUBJECT_MISMATCH' using errcode='42501'; end if;
      res:=jsonb_build_object('state',clued_private.ci_green_transition_v1(n.user_id,n.project_id,n.node_id,e.entry_id,(p_payload->>'state_version')::bigint,
        p_payload->>'action',p_payload->>'evidence_digest',(p_payload->>'ancestor')::boolean,(p_payload->>'nonce_id')::uuid,p_payload->>'nonce'));
    elsif op='sealed_drop_send' then
      res:=jsonb_build_object('drop_id',clued_private.ci_sealed_drop_send_v1(n.user_id,n.project_id,n.node_id,job,g,p_payload));
    elsif op='sealed_drop_take' then
      perform clued_private.ci_input_v1(p_payload,array['request_group_id','nonce_id','nonce'],array['request_group_id','nonce_id','nonce']);
      if jsonb_typeof(p_payload->'request_group_id')<>'string' or jsonb_typeof(p_payload->'nonce_id')<>'string' or jsonb_typeof(p_payload->'nonce')<>'string' then
        raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      select * into d from clued_private.ci_sealed_drop_v1 where user_id=n.user_id and request_group_id=(p_payload->>'request_group_id')::uuid
        and recipient_node_id=n.node_id;
      if not found or d.job_id<>job or d.execution_generation<>g then raise exception 'CI_COMMAND_SUBJECT_MISMATCH' using errcode='42501'; end if;
      res:=clued_private.ci_sealed_drop_take_v1(n.user_id,n.project_id,n.node_id,d.request_group_id,(p_payload->>'nonce_id')::uuid,p_payload->>'nonce');
    elsif op='train_front_set' then
      perform clued_private.ci_input_v1(p_payload,array['repository_id','front_version'],array['repository_id','front_version']);
      if jsonb_typeof(p_payload->'repository_id')<>'number' or p_payload->>'repository_id' !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(p_payload->'front_version')<>'number' or p_payload->>'front_version' !~ '^[1-9][0-9]{0,15}$' or tg<1 then
        raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      res:=jsonb_build_object('front_version',clued_private.ci_train_front_set_v1(n.user_id,n.project_id,n.node_id,tg,
        (p_payload->>'repository_id')::bigint,(p_payload->>'front_version')::bigint,job));
    elsif op='train_sweep_confirm' then
      perform clued_private.ci_input_v1(p_payload,array['evidence_digest'],array['evidence_digest']);
      if jsonb_typeof(p_payload->'evidence_digest')<>'string' or tg<1 then raise exception 'CI_COMMAND_INVALID' using errcode='22023'; end if;
      perform clued_private.ci_train_sweep_confirm_v1(n.user_id,n.project_id,n.node_id,tg,p_payload->>'evidence_digest');
      res:=jsonb_build_object('sweep','confirmed');
    end if;

    -- The node row under this transaction's locks: still the signed identity.
    select version into after_version from clued_private.ci_nodes_v1 where node_id=n.node_id;
    if after_version is distinct from n.version or not clued_private.ci_gateway_open_v1(n.user_id,n.project_id) then
      raise exception 'CI_COMMAND_STALE_VERSION' using errcode='40001'; end if;
    res:=jsonb_build_object('status','committed','operation',op,'result',res,'replayed',false);
    -- The ledger never keeps a secret: not an effect nonce (Stage 1 keeps only its
    -- hash) and not sealed-drop ciphertext (Stage 1 erases it on take). A replay
    -- therefore returns the redacted result, never the secret again.
    insert into clued_private.ci_node_commands_v1(nonce_sha256,user_id,project_id,node_id,binding_id,operation,command,payload_sha256,result)
      values(ns,n.user_id,n.project_id,n.node_id,n.binding_id,op,p_command,ps,
        (res-'replayed') #- '{result,nonce}' #- '{result,ciphertext_base64}'
          ||case when res->'result' ?| array['nonce','ciphertext_base64'] then '{"redacted":true}'::jsonb else '{}'::jsonb end);
    return res;
  exception when others then
    code:=case when sqlerrm ~ '^[A-Z][A-Z0-9_]{2,80}(:[A-Za-z0-9_]{1,80})?$' then sqlerrm else 'CI_COMMAND_FAILED' end;
    -- A refusal for a resolved node leaves an audit receipt (outside the rolled
    -- back attempt); an unresolved caller leaves nothing.
    -- At most 60 per node in 10 minutes, so freshly signed bad commands cannot
    -- grow the audit table without bound.
    if n.node_id is not null and (select count(*) from public.clued_audit_receipts x where x.user_id=n.user_id
        and x.operation='ci_node_command_rejected' and x.object_id=n.node_id::text and x.created_at>now()-interval '10 minutes')<60 then
      perform clued_private.ci_receipt_v1(n.user_id,n.project_id,'ci_node_command_rejected',n.node_id::text,
        jsonb_build_object('operation',op,'error_code',code,'nonce_sha256',ns,'payload_sha256',ps));
    end if;
    return jsonb_build_object('status','rejected','authoritative',false,'error_code',code);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- ACL: new private functions are never directly callable; the two gateway RPCs
-- only by the serving Worker's database role.
do $function_acl$ declare s regprocedure; begin
  for s in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='clued_private' and p.proname=any(array['ci_append_only_guard_v1','ci_node_list_entries_v1','ci_node_list_current_v1',
      'ci_node_list_view_v1','ci_node_withdraw_v1','ci_node_list_refresh_v1','ci_node_qualify_v1','ci_job_renew_v2','ci_green_record_valid_v1',
      'ci_green_mirror_append_v1','ci_gateway_flag_v1','ci_gateway_open_v1','ci_gateway_node_v1','ci_epoch_ms_v1','ci_gateway_snapshot_v1']))
    or (n.nspname='public' and p.proname=any(array['clued_ci_node_trust_v1','clued_ci_node_command_v1'])) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,clued_worker_gateway',s);
  end loop;
end $function_acl$;
grant execute on function public.clued_ci_node_trust_v1(text,uuid),public.clued_ci_node_command_v1(text,jsonb,jsonb,jsonb) to clued_worker_gateway;
notify pgrst,'reload schema';
