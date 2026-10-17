-- Accepted StorageFineGrainedConcurrency §4.3: current cloud attempts carry
-- complete semantic before/after evidence and the actual private OAuth client.
-- Old attempts are immutable and never retrofitted into absence evidence.
-- This file is a new migration; original attempt and verified receipts survive.

create function clued_private.storage_semantic_state_valid_v1(s jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(
 jsonb_typeof(s)='object' and
 (s-array['provider_file_id','parent_ids','name','trashed','explicitly_trashed','mime_type','head_revision_id','sha256','marker','access_digest'])='{}'::jsonb
 and s ?& array['provider_file_id','parent_ids','name','trashed','explicitly_trashed','mime_type','head_revision_id','sha256','marker','access_digest']
 and jsonb_typeof(s->'provider_file_id')='string' and s->>'provider_file_id'~'^[A-Za-z0-9_-]{1,160}$'
 and jsonb_typeof(s->'parent_ids')='array' and jsonb_array_length(s->'parent_ids')=1
 and jsonb_typeof(s->'parent_ids'->0)='string' and s->'parent_ids'->>0~'^[A-Za-z0-9_-]{1,160}$'
 and jsonb_typeof(s->'name')='string' and length(s->>'name') between 1 and 1000
 and s->>'name'!~'[[:cntrl:]/\\]'
 and jsonb_typeof(s->'trashed')='boolean' and jsonb_typeof(s->'explicitly_trashed')='boolean'
 and (s->'explicitly_trashed'='false'::jsonb or s->'trashed'='true'::jsonb)
 and jsonb_typeof(s->'mime_type')='string' and length(s->>'mime_type') between 1 and 255
 and (s->'marker'='null'::jsonb or (jsonb_typeof(s->'marker')='string' and length(s->>'marker') between 1 and 255 and s->>'marker'!~'[[:cntrl:]]'))
 and (s->'sha256'='null'::jsonb or (jsonb_typeof(s->'sha256')='string' and s->>'sha256'~'^[0-9a-f]{64}$'))
 and case when s->>'mime_type'='application/vnd.google-apps.folder'
 then s->'head_revision_id'='null'::jsonb and s->'sha256'='null'::jsonb
  and jsonb_typeof(s->'access_digest')='string' and s->>'access_digest'~'^[0-9a-f]{64}$'
 else s->'access_digest'='null'::jsonb and jsonb_typeof(s->'head_revision_id')='string' and s->>'head_revision_id'~'^[A-Za-z0-9_-]{1,200}$' end,false)
$$;

create function clued_private.storage_semantic_text_mime_v1(p_name text) returns text
language sql immutable set search_path='' as $$
 select case when p_name~'^.+\.[^.]+$' then case lower(regexp_replace(p_name,'^.*\.',''))
 when 'md' then 'text/markdown' when 'csv' then 'text/csv' when 'json' then 'application/json'
 else 'text/plain' end else 'text/plain' end
$$;

create function clued_private.storage_semantic_request_timeout_v1(m jsonb) returns interval
language sql immutable set search_path='' as $$
 select case when m->>'operation'='create' and m ? 'content_ref'
 and (m->'content_ref'->>'size')::numeric>5242880 then interval '120 seconds'
 when m->>'operation' in ('create','replace') and m->>'target_kind'='file' then interval '60 seconds'
 else interval '10 seconds' end
$$;

-- Only the shape and immutable request derive the after predicate. A supplied
-- predicate, timestamp or OAuth-client display value is never authority.
create function clued_private.storage_semantic_expected_after_v1(m jsonb,a jsonb,b jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare op text:=m->>'operation'; target_name text; mime text; checksum jsonb; revision_rule text;
begin
 if coalesce(op,'') not in ('create','rename','move','replace','delete','restore')
 or (op='move' and m->>'target_kind'='directory')
 or coalesce(a->>'intent_id','')!~'^[0-9a-f-]{36}$'
 or coalesce(a->>'provider_file_id','')!~'^[A-Za-z0-9_-]{1,160}$'
 or coalesce(a->>'parent_id','')!~'^[A-Za-z0-9_-]{1,160}$' then
  raise exception 'storage_semantic_attempt_invalid' using errcode='22023';
 end if;
 if op='create' then
  if b is distinct from jsonb_build_object('exists',false,'provider_file_id',a->>'provider_file_id')
  or coalesce(m->>'target_kind','') not in ('file','directory') then
   raise exception 'storage_semantic_attempt_invalid' using errcode='22023'; end if;
  target_name:=regexp_replace(m->>'destination_path','^.*/','');
  mime:=case when m->>'target_kind'='directory' then 'application/vnd.google-apps.folder'
   when m ? 'content_ref' then m->'content_ref'->>'mime_type'
   else clued_private.storage_semantic_text_mime_v1(target_name) end;
  checksum:=case when m->>'target_kind'='directory' then 'null'::jsonb else to_jsonb(a->>'sha256') end;
  revision_rule:=case when m->>'target_kind'='directory' then 'none' else 'any' end;
 else
  if not clued_private.storage_semantic_state_valid_v1(b)
  or b->>'provider_file_id' is distinct from a->>'provider_file_id'
  or b->>'marker'=a->>'intent_id' then
   raise exception 'storage_semantic_attempt_invalid' using errcode='22023'; end if;
  target_name:=case when op in ('rename','move','restore') and m->>'destination_path' is not null
   then regexp_replace(m->>'destination_path','^.*/','') else b->>'name' end;
  mime:=case when op='replace' then null else b->>'mime_type' end;
  checksum:=case when op='replace' then a->'content_after'->'sha256' else b->'sha256' end;
  revision_rule:=case when op='replace' then 'different'
   when b->>'mime_type'='application/vnd.google-apps.folder' then 'none' else 'same' end;
 end if;
 if target_name is null or length(target_name) not between 1 and 1000 or target_name~'[[:cntrl:]/\\]'
 or (checksum is distinct from 'null'::jsonb and (jsonb_typeof(checksum) is distinct from 'string' or checksum#>>'{}'!~'^[0-9a-f]{64}$'))
 or checksum is null or ((op='replace' or (op='create' and m->>'target_kind'='file')) and
  (jsonb_typeof(checksum) is distinct from 'string' or coalesce(checksum#>>'{}','')!~'^[0-9a-f]{64}$')) then
  raise exception 'storage_semantic_attempt_invalid' using errcode='22023'; end if;
 return jsonb_build_object('provider_file_id',a->>'provider_file_id','parent_id',a->>'parent_id',
  'name',target_name,'mime_type',mime,'trashed',op='delete','explicitly_trashed',op='delete',
  'sha256',checksum,'head_revision',revision_rule,'marker',a->>'intent_id');
end $$;

create table clued_private.storage_semantic_attempts_v1 (
 intent_id uuid primary key references clued_private.resource_center_mutations_v1(id),
 owner_id uuid not null references auth.users(id),job_id uuid not null,connection_id uuid not null,
 oauth_client_id text not null,original_attempt_receipt_id uuid not null references public.clued_audit_receipts(id),
 original_attempt_digest text not null check(original_attempt_digest~'^[0-9a-f]{64}$'),
 evidence jsonb not null check(jsonb_typeof(evidence)='object'),observed_file_version text,
 receipt_id uuid not null references public.clued_audit_receipts(id),
 created_at timestamptz not null default clock_timestamp(),
 unique(owner_id,job_id),foreign key(owner_id,job_id) references clued_private.storage_jobs_v1(owner_id,job_id)
);
alter table clued_private.storage_semantic_attempts_v1 enable row level security;
revoke all on clued_private.storage_semantic_attempts_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_semantic_immutable_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin raise exception 'storage_semantic_evidence_immutable' using errcode='42501'; end $$;
create trigger storage_semantic_attempt_immutable_v1 before update or delete
 on clued_private.storage_semantic_attempts_v1 for each row execute function clued_private.storage_semantic_immutable_v1();

create function clued_private.storage_semantic_record_attempt_v1(p_owner uuid,p_job uuid,p_input jsonb,p_original jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;c clued_private.storage_connections_v1;m clued_private.resource_center_mutations_v1;
 s clued_private.storage_semantic_attempts_v1;proof jsonb:=p_input->'evidence';b jsonb;expected jsonb;v text:=p_input->>'observed_file_version';
 op text;before_identity jsonb;content_identity jsonb;original public.clued_audit_receipts;r public.clued_audit_receipts;
 req jsonb;refs jsonb;ev text;p clued_private.resource_center_profiles_v1;expected_version text;
begin
 if p_original->>'status' is distinct from 'committed' or p_original->'attempt_recorded' is distinct from 'true'::jsonb then
  raise exception 'storage_semantic_first_attempt_required' using errcode='42501';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or
 (p_input-array['evidence','observed_file_version'])<>'{}'::jsonb or not(p_input ?& array['evidence','observed_file_version'])
 or octet_length(p_input::text)>32768 or jsonb_typeof(proof) is distinct from 'object'
 or (proof-array['contract','intent_id','oauth_client_id','operation','before','expected_after'])<>'{}'::jsonb
 or not(proof ?& array['contract','intent_id','oauth_client_id','operation','before','expected_after']) then
  raise exception 'storage_semantic_attempt_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
 select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner for share;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':'||p.root_folder_id,0));
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner for update;
 if j.job_id is null or c.id is null or p.id is null or m.id is null or m.state<>'started'
 or j.cloud_writer_binding_id is null or m.writer_binding_id is distinct from j.cloud_writer_binding_id
 or j.authority_snapshot_v2 is null or m.provider_attempt is null or m.provider_attempt_receipt_id is null
 or p_original->>'receipt_id' is distinct from m.provider_attempt_receipt_id::text
 or p_original->'attempt' is distinct from m.provider_attempt
 or proof->>'contract' is distinct from 'clued.storage-semantic-attempt/1'
 or proof->>'intent_id' is distinct from m.id::text
 or proof->>'oauth_client_id' is distinct from c.oauth_client_id
 or proof->>'operation' is distinct from m.exact_request->'mutation'->>'operation' then
  raise exception 'storage_semantic_attempt_mismatch' using errcode='42501';end if;
 select * into original from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=p_owner;
 if original.status is distinct from 'committed' or original.operation is distinct from 'storage_provider_attempt'
 or original.response_hash is distinct from clued_private.m1_sha256(original.canonical_result) then
  raise exception 'storage_semantic_attempt_mismatch' using errcode='42501';end if;
 select * into s from clued_private.storage_semantic_attempts_v1 where intent_id=m.id;
 if s.intent_id is not null then raise exception 'storage_semantic_attempt_already_recorded' using errcode='40001';end if;
 op:=m.exact_request->'mutation'->>'operation';b:=proof->'before';before_identity:=m.authority_request->'provider_identity';
 expected:=clued_private.storage_semantic_expected_after_v1(m.exact_request->'mutation',m.provider_attempt,b);
 if proof->'expected_after' is distinct from expected then raise exception 'storage_semantic_predicate_mismatch' using errcode='42501';end if;
 if op='create' then
  if p_input->'observed_file_version' is distinct from 'null'::jsonb then raise exception 'storage_semantic_before_mismatch' using errcode='42501';end if;
 else
  expected_version:=case when op='replace' then m.provider_attempt->>'destination_file_version' else m.provider_attempt->>'source_file_version' end;
  content_identity:=case when op='replace' then m.provider_attempt->'content_before' else m.provider_attempt->'content' end;
  if jsonb_typeof(p_input->'observed_file_version') is distinct from 'string' or v is distinct from expected_version
  or b->'parent_ids' is distinct from jsonb_build_array(case when op='replace' then before_identity->>'destination_parent_id'
   when op in ('rename','move') then m.provider_attempt->>'source_parent_id' else before_identity->>'source_parent_id' end)
  or b->>'name' is distinct from regexp_replace(case when op='replace' then m.exact_request->'mutation'->>'destination_path' else m.exact_request->'mutation'->>'source_path' end,'^.*/','')
  or b->'trashed' is distinct from to_jsonb(op='restore') or b->'explicitly_trashed' is distinct from to_jsonb(op='restore')
  or (m.exact_request->'mutation'->>'target_kind'='directory') is distinct from (b->>'mime_type'='application/vnd.google-apps.folder')
  or (m.exact_request->'mutation'->>'target_kind'<>'directory' and
   (b->'sha256' is distinct from content_identity->'sha256' or b->'head_revision_id' is distinct from content_identity->'head_revision_id')) then
   raise exception 'storage_semantic_before_mismatch' using errcode='42501';end if;
 end if;
 if before_identity->>'root_folder_id' is distinct from p.root_folder_id
 or jsonb_typeof(before_identity->'ancestors') is distinct from 'array'
 or jsonb_array_length(before_identity->'ancestors') not between 1 and 41 then
  raise exception 'storage_semantic_scope_incomplete' using errcode='42501';end if;
 req:=jsonb_build_object('idempotency_key','storage-semantic-attempt:'||m.id::text,'intent_id',m.id,
  'original_attempt_receipt_id',m.provider_attempt_receipt_id,'original_attempt_digest',clued_private.m1_sha256(m.provider_attempt),
  'evidence',proof,'observed_file_version',p_input->'observed_file_version');
 r:=clued_private.m1_begin_receipt(p_owner,null,'storage_semantic_attempt',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_semantic_receipt_conflict' using errcode='40001';end if;
 insert into clued_private.storage_semantic_attempts_v1(intent_id,owner_id,job_id,connection_id,oauth_client_id,
 original_attempt_receipt_id,original_attempt_digest,evidence,observed_file_version,receipt_id)
 values(m.id,p_owner,j.job_id,j.connection_id,c.oauth_client_id,m.provider_attempt_receipt_id,
 clued_private.m1_sha256(m.provider_attempt),proof,v,r.id);
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:semantic_attempt_recorded',
 refs,'project:'||p.project_id::text,null,req-'idempotency_key',req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
 return jsonb_build_object('semantic_attempt_receipt_id',r.id,'semantic_attempt_digest',clued_private.m1_sha256(proof),
  'semantic_recovery',jsonb_build_object('receipt_id',r.id,'evidence',proof,
   'no_effect_after_ms',ceil(extract(epoch from (m.expires_at+
    clued_private.storage_semantic_request_timeout_v1(m.exact_request->'mutation')+interval '10 minutes'))*1000)::bigint));
end $$;

-- All helpers remain behind the existing issuer route; no API role gains a
-- function, table or secret-reading capability.
revoke all on function clued_private.storage_semantic_state_valid_v1(jsonb),
 clued_private.storage_semantic_text_mime_v1(text),clued_private.storage_semantic_request_timeout_v1(jsonb),
 clued_private.storage_semantic_expected_after_v1(jsonb,jsonb,jsonb),
 clued_private.storage_semantic_immutable_v1(),
 clued_private.storage_semantic_record_attempt_v1(uuid,uuid,jsonb,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- The existing private issuer route remains the only entry. The original
-- attempt and its semantic Receipt commit in the SAME database transaction.
do $clone$
declare body text;
begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_cloud_worker_router_v2(text,jsonb)'::regprocedure);
 if position('clued_private.ii_priv_storage_verified_result_v2' in body)=0
 or position('clued_private.ii_priv_storage_cloud_execution_router_v2' in body)=0
 or position('storage_semantic_' in body)>0 then raise exception 'storage_semantic_router_source_mismatch';end if;
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_cloud_worker_router_v2(',
  'FUNCTION clued_private.storage_semantic_cloud_router_previous_v1(');
end $clone$;

create or replace function clued_private.ii_pub_clued_storage_cloud_worker_router_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;c clued_private.storage_connections_v1;extra jsonb;
begin
 if p_input->>'action'='semantic_settle' then return clued_private.storage_semantic_settle_v1(p_issuer_identity,p_input);end if;
 if p_input ? 'semantic_attempt' and
 (p_input->>'action' is distinct from 'provider_attempt' or octet_length(p_input::text)>65536) then
  raise exception 'storage_semantic_input_invalid' using errcode='22023';end if;
 result:=clued_private.storage_semantic_cloud_router_previous_v1(p_issuer_identity,p_input-'semantic_attempt');
 if p_input ? 'semantic_attempt' and result->>'status'='committed' and result->'attempt_recorded'='true'::jsonb then
  -- The previous route has authenticated the actual issuer/client/connection,
  -- account policy, original one-shot admission, job, writer and attempt.
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid;
  extra:=clued_private.storage_semantic_record_attempt_v1(c.owner_id,(p_input->>'job_id')::uuid,p_input->'semantic_attempt',result);
  result:=result||extra;
 end if;
 return clued_private.storage_semantic_attach_descriptor_v1(result);
end $$;
revoke all on function clued_private.storage_semantic_cloud_router_previous_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_semantic_attach_descriptor_v1(d jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s clued_private.storage_semantic_attempts_v1;m clued_private.resource_center_mutations_v1;
begin
 if d->>'status' is distinct from 'recovery_only' then return d;end if;
 select * into s from clued_private.storage_semantic_attempts_v1
 where owner_id=(d->>'owner_id')::uuid and job_id=(d->>'job_id')::uuid and intent_id=(d->>'intent_id')::uuid;
 if s.intent_id is null then return d;end if;
 select * into m from clued_private.resource_center_mutations_v1 where id=s.intent_id and user_id=s.owner_id;
 if s.connection_id::text is distinct from d->>'connection_id' or s.oauth_client_id is distinct from d->>'oauth_client_id'
 or m.provider_attempt is distinct from d->'attempt' or m.provider_attempt_receipt_id is distinct from s.original_attempt_receipt_id
 or s.original_attempt_digest is distinct from clued_private.m1_sha256(m.provider_attempt) then
  raise exception 'storage_semantic_recovery_mismatch' using errcode='42501';end if;
 return d||jsonb_build_object('semantic_recovery',jsonb_build_object('receipt_id',s.receipt_id,'evidence',s.evidence,
  'no_effect_after_ms',ceil(extract(epoch from (m.expires_at+
   clued_private.storage_semantic_request_timeout_v1(m.exact_request->'mutation')+interval '10 minutes'))*1000)::bigint));
end $$;

do $clone$
declare body text;
begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_scheduled_recovery_v2(text,jsonb)'::regprocedure);
 if position('storage_semantic_' in body)>0 then raise exception 'storage_semantic_scheduled_source_mismatch';end if;
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_scheduled_recovery_v2(',
  'FUNCTION clued_private.storage_semantic_scheduled_previous_v1(');
end $clone$;
create or replace function clued_private.ii_pub_clued_storage_scheduled_recovery_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 return clued_private.storage_semantic_attach_descriptor_v1(
  clued_private.storage_semantic_scheduled_previous_v1(p_issuer_identity,p_input));
end $$;
revoke all on function clued_private.storage_semantic_attach_descriptor_v1(jsonb),
 clued_private.storage_semantic_scheduled_previous_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- A complete, fresh, same-client observation is checked again in PostgreSQL.
-- Worker classification is never a substitute for this predicate or I2.
create function clued_private.storage_semantic_observation_v1(p_owner uuid,p_job uuid,o jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare s clued_private.storage_semantic_attempts_v1;j clued_private.storage_jobs_v1;
 c clued_private.storage_connections_v1;m clued_private.resource_center_mutations_v1;
 p clued_private.resource_center_profiles_v1;b jsonb;e jsonb;f jsonb;z jsonb;link jsonb;seen jsonb;
 target_path text;parent_path text;walk_path text;expected_parent text;expected_id text;
 paths text[];required_paths text[]:='{}';seen_paths text[]:='{}';observed timestamptz;after_matches boolean;slots_match boolean:=true;slot_paths text[];expected_ids jsonb;actual_ids jsonb;
begin
 select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner for share;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':'||p.root_folder_id,0));
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner for update;
 select * into s from clued_private.storage_semantic_attempts_v1 where intent_id=m.id and owner_id=p_owner and job_id=p_job;
 if s.intent_id is null or c.id is null or p.id is null or s.connection_id<>c.id or s.oauth_client_id is distinct from c.oauth_client_id
 or m.provider_attempt_receipt_id is distinct from s.original_attempt_receipt_id
 or clued_private.m1_sha256(m.provider_attempt) is distinct from s.original_attempt_digest
 or not exists(select 1 from public.clued_audit_receipts r where r.id=s.receipt_id and r.user_id=p_owner
  and r.status='committed' and r.operation='storage_semantic_attempt' and r.response_hash=clued_private.m1_sha256(r.canonical_result))
 or jsonb_typeof(o) is distinct from 'object' or octet_length(o::text)>65536
 or (o-array['contract','intent_id','semantic_attempt_receipt_id','oauth_client_id','observed_at_ms','first','second','ancestors_before','ancestors_after','slots_before','slots_after'])<>'{}'
 or not(o ?& array['contract','intent_id','semantic_attempt_receipt_id','oauth_client_id','observed_at_ms','first','second','ancestors_before','ancestors_after','slots_before','slots_after'])
 or o->>'contract' is distinct from 'clued.storage-semantic-observation/1' or o->>'intent_id' is distinct from m.id::text
 or o->>'semantic_attempt_receipt_id' is distinct from s.receipt_id::text or o->>'oauth_client_id' is distinct from s.oauth_client_id
 or jsonb_typeof(o->'observed_at_ms') is distinct from 'number' then
  raise exception 'storage_semantic_observation_invalid' using errcode='42501';end if;
 observed:=to_timestamp((o->>'observed_at_ms')::numeric/1000);
 if observed<clock_timestamp()-interval '30 seconds' or observed>clock_timestamp()+interval '5 seconds' then
  raise exception 'storage_semantic_observation_stale' using errcode='40001';end if;
 f:=o->'first';z:=o->'second';b:=s.evidence->'before';e:=s.evidence->'expected_after';
 if jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(z) is distinct from 'object'
 or (f-array['state','provider_file_version'])<>'{}' or (z-array['state','provider_file_version'])<>'{}'
 or not(f ?& array['state','provider_file_version']) or not(z ?& array['state','provider_file_version'])
 or f->'state' is distinct from z->'state' then raise exception 'storage_semantic_observation_unstable' using errcode='40001';end if;
 if z->'state'='null'::jsonb then
  if f->'provider_file_version' is distinct from 'null'::jsonb or z->'provider_file_version' is distinct from 'null'::jsonb then
   raise exception 'storage_semantic_observation_invalid' using errcode='42501';end if;
 else
  if not clued_private.storage_semantic_state_valid_v1(z->'state')
  or z->'state'->>'provider_file_id' is distinct from m.provider_attempt->>'provider_file_id'
  or jsonb_typeof(f->'provider_file_version') is distinct from 'string' or coalesce(f->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$'
  or jsonb_typeof(z->'provider_file_version') is distinct from 'string' or coalesce(z->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$' then
   raise exception 'storage_semantic_observation_invalid' using errcode='42501';end if;
 end if;
 -- Rebuild the complete source/destination ancestry from the immutable before
 -- identity. Compare sets by path (not locale-dependent array ordering).
 paths:=array_remove(array[m.exact_request->'mutation'->>'source_path',m.exact_request->'mutation'->>'destination_path'],null);
 foreach target_path in array paths loop
  if left(target_path,length(p.managed_root)+1)<>p.managed_root||'/' then raise exception 'storage_semantic_scope_incomplete' using errcode='42501';end if;
  parent_path:=regexp_replace(target_path,'/[^/]+$','');walk_path:=parent_path;
  loop
   required_paths:=array_append(required_paths,walk_path);
   exit when walk_path=p.managed_root;
   walk_path:=regexp_replace(walk_path,'/[^/]+$','');
   if walk_path='' or left(walk_path,length(p.managed_root))<>p.managed_root or cardinality(required_paths)>42 then
    raise exception 'storage_semantic_scope_incomplete' using errcode='42501';end if;
  end loop;
 end loop;
 select array_agg(distinct value order by value) into required_paths from unnest(required_paths) value;
 if cardinality(required_paths) not between 1 and 41 then raise exception 'storage_semantic_scope_incomplete' using errcode='42501';end if;
 foreach seen in array array[o->'ancestors_before',o->'ancestors_after'] loop
  if jsonb_typeof(seen) is distinct from 'array' or jsonb_array_length(seen)<>cardinality(required_paths) then
   raise exception 'storage_semantic_scope_incomplete' using errcode='42501';end if;
  seen_paths:='{}';
  for link in select value from jsonb_array_elements(seen) loop
   walk_path:=link->>'path';
   if jsonb_typeof(link) is distinct from 'object' or (link-array['path','provider_file_id','provider_file_version','name','parent_id','trashed','mime_type'])<>'{}'
   or not(link ?& array['path','provider_file_id','provider_file_version','name','parent_id','trashed','mime_type'])
   or not(walk_path=any(required_paths)) or walk_path=any(seen_paths)
   or link->'trashed' is distinct from 'false'::jsonb or link->>'mime_type' is distinct from 'application/vnd.google-apps.folder'
   or jsonb_typeof(link->'provider_file_version') is distinct from 'string' or coalesce(link->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$'
   or link->>'name' is distinct from regexp_replace(walk_path,'^.*/','') then
    raise exception 'storage_semantic_ancestor_changed' using errcode='40001';end if;
   seen_paths:=array_append(seen_paths,walk_path);
   select value->>'id',value->>'parent_id' into expected_id,expected_parent
    from jsonb_array_elements(m.authority_request->'provider_identity'->'ancestors') where value->>'path'=walk_path;
   if expected_id is null or expected_parent is null or link->>'provider_file_id' is distinct from expected_id
   or link->>'parent_id' is distinct from expected_parent
   or (walk_path=p.managed_root and (expected_id<>p.root_folder_id or expected_parent<>p.root_parent_id)) then
    raise exception 'storage_semantic_ancestor_changed' using errcode='40001';end if;
  end loop;
 end loop;
 -- Incidental folder versions may change; their identities/name/parents cannot.
 if exists(select 1 from jsonb_array_elements(o->'ancestors_before') ancestor_first
  join jsonb_array_elements(o->'ancestors_after') ancestor_second on ancestor_first->>'path'=ancestor_second->>'path'
  where ancestor_first-'provider_file_version' is distinct from ancestor_second-'provider_file_version') then
  raise exception 'storage_semantic_ancestor_changed' using errcode='40001';end if;
 z:=z->'state';
 if jsonb_typeof(o->'slots_before') is distinct from 'array' or o->'slots_before' is distinct from o->'slots_after'
 or jsonb_array_length(o->'slots_before')<>(select count(distinct value) from unnest(paths) value) then
  raise exception 'storage_semantic_slot_unstable' using errcode='40001';end if;
 slot_paths:='{}';
 for link in select value from jsonb_array_elements(o->'slots_after') loop
  walk_path:=link->>'path';parent_path:=regexp_replace(walk_path,'/[^/]+$','');
  select a->>'provider_file_id' into expected_parent from jsonb_array_elements(o->'ancestors_after') a where a->>'path'=parent_path;
  if jsonb_typeof(link) is distinct from 'object' or (link-array['path','parent_id','name','object_ids'])<>'{}'
  or not(link ?& array['path','parent_id','name','object_ids']) or not(walk_path=any(paths)) or walk_path=any(slot_paths)
  or expected_parent is null or link->>'parent_id' is distinct from expected_parent
  or link->>'name' is distinct from regexp_replace(walk_path,'^.*/','')
  or jsonb_typeof(link->'object_ids') is distinct from 'array' or jsonb_array_length(link->'object_ids')>1000
  or exists(select 1 from jsonb_array_elements(link->'object_ids') value where jsonb_typeof(value)<>'string' or value#>>'{}'!~'^[A-Za-z0-9_-]{1,160}$') then
   raise exception 'storage_semantic_slot_invalid' using errcode='42501';end if;
  slot_paths:=array_append(slot_paths,walk_path);
  select coalesce(jsonb_agg(distinct value order by value),'[]') into actual_ids from jsonb_array_elements(link->'object_ids') value;
  if actual_ids is distinct from link->'object_ids' then raise exception 'storage_semantic_slot_invalid' using errcode='42501';end if;
  expected_ids:=case when z is distinct from 'null'::jsonb and z->'trashed'='false'::jsonb
   and z->>'name'=link->>'name' and z->'parent_ids'=jsonb_build_array(expected_parent)
   then jsonb_build_array(m.provider_attempt->>'provider_file_id') else '[]'::jsonb end;
  slots_match:=slots_match and actual_ids=expected_ids;
 end loop;
 after_matches:=z is distinct from 'null'::jsonb and z->>'provider_file_id'=e->>'provider_file_id'
  and z->'parent_ids'=jsonb_build_array(e->>'parent_id') and z->>'name'=e->>'name'
  and z->'trashed'=e->'trashed' and z->'explicitly_trashed'=e->'explicitly_trashed'
  and (e->'mime_type'='null'::jsonb or z->'mime_type'=e->'mime_type') and z->'sha256'=e->'sha256'
  and z->>'marker'=m.id::text and case e->>'head_revision'
   when 'any' then z->'head_revision_id'<>'null'::jsonb when 'none' then z->'head_revision_id'='null'::jsonb
   when 'same' then z->'head_revision_id'=b->'head_revision_id'
   when 'different' then z->'head_revision_id'<>'null'::jsonb and z->'head_revision_id'<>b->'head_revision_id' else false end;
 if coalesce(after_matches,false) and slots_match then
  if f->'provider_file_version' is distinct from o->'second'->'provider_file_version' then
   raise exception 'storage_semantic_observation_unstable' using errcode='40001';end if;
  return 'after';end if;
 if least(observed,clock_timestamp())<m.expires_at+clued_private.storage_semantic_request_timeout_v1(m.exact_request->'mutation')+interval '10 minutes' then
  raise exception 'storage_semantic_not_due' using errcode='40001';end if;
 if s.evidence->>'operation'='create' and z='null'::jsonb and slots_match then return 'absence_probe_required';end if;
 if s.evidence->>'operation'<>'create' and z=b and slots_match then return 'before';end if;
 return 'conflict';
end $$;

create table clued_private.storage_semantic_verifications_v1 (
 intent_id uuid primary key references clued_private.storage_semantic_attempts_v1(intent_id),
 owner_id uuid not null,job_id uuid not null,semantic_attempt_receipt_id uuid not null references public.clued_audit_receipts(id),
 verified_receipt_id uuid not null references public.clued_audit_receipts(id),verified_digest text not null,
 observation jsonb not null,receipt_id uuid not null references public.clued_audit_receipts(id),
 created_at timestamptz not null default clock_timestamp(),foreign key(owner_id,job_id) references clued_private.storage_jobs_v1(owner_id,job_id)
);
alter table clued_private.storage_semantic_verifications_v1 enable row level security;
revoke all on clued_private.storage_semantic_verifications_v1 from public,anon,authenticated,service_role,clued_worker_gateway;
create trigger storage_semantic_verification_immutable_v1 before update or delete on clued_private.storage_semantic_verifications_v1
 for each row execute function clued_private.storage_semantic_immutable_v1();

create function clued_private.storage_semantic_record_verification_v1(p_owner uuid,p_job uuid,o jsonb,result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m clued_private.resource_center_mutations_v1;s clued_private.storage_semantic_attempts_v1;
 v clued_private.storage_semantic_verifications_v1;r public.clued_audit_receipts;req jsonb;refs jsonb;ev text;scope text;
begin
 select * into s from clued_private.storage_semantic_attempts_v1 where owner_id=p_owner and job_id=p_job;
 select * into m from clued_private.resource_center_mutations_v1 where id=s.intent_id and user_id=p_owner;
 select * into v from clued_private.storage_semantic_verifications_v1 where intent_id=s.intent_id;
 if v.intent_id is not null then
  if v.observation is distinct from o or v.verified_receipt_id is distinct from m.verified_receipt_id_v2
  or v.verified_digest is distinct from m.verified_digest_v2 then raise exception 'storage_semantic_verification_conflict' using errcode='40001';end if;
  return result||jsonb_build_object('semantic_verified_receipt_id',v.receipt_id);
 end if;
 if result->>'status' is distinct from 'verified' or result->>'verified_receipt_id' is distinct from m.verified_receipt_id_v2::text
 or result->>'verified_digest' is distinct from m.verified_digest_v2
 or clued_private.storage_semantic_observation_v1(p_owner,p_job,o)<>'after'
 or m.verified_result_v2->'proof'->>'provider_file_version' is distinct from o->'second'->>'provider_file_version' then
  raise exception 'storage_semantic_after_unproven' using errcode='42501';end if;
 req:=jsonb_build_object('idempotency_key','storage-semantic-verified:'||m.id::text,'intent_id',m.id,
  'semantic_attempt_receipt_id',s.receipt_id,'verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2,'observation',o);
 r:=clued_private.m1_begin_receipt(p_owner,null,'storage_semantic_verified',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_semantic_verification_conflict' using errcode='40001';end if;
 insert into clued_private.storage_semantic_verifications_v1(intent_id,owner_id,job_id,semantic_attempt_receipt_id,verified_receipt_id,verified_digest,observation,receipt_id)
 values(m.id,p_owner,p_job,s.receipt_id,m.verified_receipt_id_v2,m.verified_digest_v2,o,r.id);
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 select 'project:'||p.project_id::text into scope from clued_private.resource_center_profiles_v1 p where p.id=m.profile_id and p.user_id=p_owner;
 ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:semantic_verified',refs,scope,null,
  req-'idempotency_key',req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}','{}',array[ev],'{}'::uuid[],null);
 return result||jsonb_build_object('semantic_verified_receipt_id',r.id);
end $$;

-- Wrap the private typed verifier itself: I9 and every existing issuer entry
-- must require the same semantic link; no alternate settle route can bypass it.
do $clone$ declare body text;begin
 body:=pg_get_functiondef('clued_private.ii_priv_storage_verified_result_v2(text,jsonb)'::regprocedure);
 if position('storage_semantic_' in body)>0 then raise exception 'storage_semantic_verified_source_mismatch';end if;
 execute replace(body,'FUNCTION clued_private.ii_priv_storage_verified_result_v2(',
  'FUNCTION clued_private.storage_semantic_verified_previous_v1(');
end $clone$;
create or replace function clued_private.ii_priv_storage_verified_result_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s clued_private.storage_semantic_attempts_v1;j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;result jsonb;
begin
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
 select * into s from clued_private.storage_semantic_attempts_v1 where owner_id=j.owner_id and job_id=j.job_id and intent_id=j.intent_id;
 if p_input ? 'semantic_observation' and (p_input->>'action'<>'verified_record' or s.intent_id is null) then
  raise exception 'storage_semantic_observation_unexpected' using errcode='42501';end if;
 if s.intent_id is not null and p_input->>'action'='verified_record' and not(p_input ? 'semantic_observation') then
  raise exception 'storage_semantic_observation_required' using errcode='42501';end if;
 if s.intent_id is not null and p_input->>'action'='settle_verified' then
  select * into m from clued_private.resource_center_mutations_v1 where id=s.intent_id and user_id=s.owner_id;
  if not exists(select 1 from clued_private.storage_semantic_verifications_v1 v join public.clued_audit_receipts r on r.id=v.receipt_id
   where v.intent_id=s.intent_id and v.owner_id=s.owner_id and v.job_id=s.job_id and v.semantic_attempt_receipt_id=s.receipt_id
    and v.verified_receipt_id=m.verified_receipt_id_v2 and v.verified_digest=m.verified_digest_v2
    and r.user_id=s.owner_id and r.status='committed' and r.operation='storage_semantic_verified'
    and r.response_hash=clued_private.m1_sha256(r.canonical_result)) then
   raise exception 'storage_semantic_verified_link_required' using errcode='42501';end if;
 end if;
 result:=clued_private.storage_semantic_verified_previous_v1(p_issuer_identity,p_input-'semantic_observation');
 if s.intent_id is not null and p_input->>'action'='verified_record' then
  result:=clued_private.storage_semantic_record_verification_v1(s.owner_id,s.job_id,p_input->'semantic_observation',result);
 end if;
 return result;
end $$;
revoke all on function clued_private.storage_semantic_observation_v1(uuid,uuid,jsonb),
 clued_private.storage_semantic_record_verification_v1(uuid,uuid,jsonb,jsonb),
 clued_private.storage_semantic_verified_previous_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Repair the scope from the already validated original modify attempt, without
-- changing that immutable attempt or its before identity. An omitted optional
-- identity field must not expand a single-file conflict to the whole root.
do $patch$
declare body text;anchor text;replacement text;
begin
 body:=pg_get_functiondef('clued_private.storage_conflict_close_candidate_v1(uuid)'::regprocedure);
 anchor:=$a$  before:=m.authority_request->'provider_identity';$a$;
 replacement:=$r$  before:=m.authority_request->'provider_identity';
  if op in ('rename','move') and before->>'source_parent_id' is null
   and m.provider_attempt->>'source_parent_id' is not null
   and exists(select 1 from public.clued_audit_receipts a where a.id=m.provider_attempt_receipt_id and a.user_id=m.user_id
    and a.status='committed' and a.operation='storage_provider_attempt' and a.response_hash=clued_private.m1_sha256(a.canonical_result)) then
   before:=before||jsonb_build_object('source_parent_id',m.provider_attempt->>'source_parent_id');
  end if;$r$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_semantic_scope_source_mismatch';end if;
 body:=replace(body,anchor,replacement);
 anchor:=$a$case when m.exact_request->'mutation' ? 'content_ref' then interval '120 seconds'
    when op='create' then interval '60 seconds' else interval '10 seconds' end$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_semantic_timeout_source_mismatch';end if;
 body:=replace(body,anchor,$r$clued_private.storage_semantic_request_timeout_v1(m.exact_request->'mutation')$r$);
 execute body;
 -- A fresh, authenticated semantic conflict may settle at I2 rather than
 -- waiting for the independent I9 fallback. The observation becomes audit data.
 body:=replace(body,'FUNCTION clued_private.storage_conflict_close_candidate_v1(p_intent uuid)',
  'FUNCTION clued_private.storage_semantic_conflict_close_v1(p_intent uuid,p_observation jsonb)');
 anchor:=$a$ if threshold>clock_timestamp() then return 'not_due'; end if;$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_semantic_conflict_source_mismatch';end if;
 body:=replace(body,anchor,$r$ if not cloud or no_attempt or
  clued_private.storage_semantic_observation_v1(m.user_id,j.job_id,p_observation)<>'conflict' then
   raise exception 'storage_semantic_conflict_unproven' using errcode='42501';end if;$r$);
 anchor:=$a$'base_version',m.version,'reason_code',reason);$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_semantic_conflict_receipt_mismatch';end if;
 execute replace(body,anchor,$r$'base_version',m.version,'reason_code',reason,'semantic_observation',p_observation);$r$);
 body:=pg_get_functiondef('clued_private.storage_conflict_sweep_v1()'::regprocedure);
 anchor:=$a$case when m.exact_request->'mutation'?'content_ref' then interval '120 seconds'
      when m.exact_request->'mutation'->>'operation'='create' then interval '60 seconds' else interval '10 seconds' end$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_semantic_sweep_source_mismatch';end if;
 execute replace(body,anchor,$r$clued_private.storage_semantic_request_timeout_v1(m.exact_request->'mutation')$r$);
end $patch$;

-- A before/absence result is program-owned. Preserve an old I9 conflict as
-- history and use a separate automatic reconciliation Receipt for its exit.
create function clued_private.storage_semantic_settle_v1(p_issuer_identity text,i jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;
 s clued_private.storage_semantic_attempts_v1;q clued_private.storage_conflict_isolations_v1;
 p clued_private.resource_center_profiles_v1;c clued_private.storage_connections_v1;
 r public.clued_audit_receipts;req jsonb;refs jsonb;ev text;d jsonb;outcome text;revision jsonb;pin clued_private.storage_revision_pins_v1;
 operation text;base bigint;source_receipt uuid;old_result jsonb;artifact_id uuid;result jsonb;
 artifact clued_private.resource_center_artifacts_v1;artifact_changed boolean:=false;artifact_path text;
begin
 if jsonb_typeof(i) is distinct from 'object' or i->>'action'<>'semantic_settle'
 or (i-array['action','connection_id','job_id','intent_id','base_version','request_sha256','credential_version','observation','absence_proof','revision_observation'])<>'{}'
 or not(i ?& array['action','connection_id','job_id','intent_id','base_version','request_sha256','credential_version','observation']) then
  raise exception 'storage_semantic_settle_invalid' using errcode='22023';end if;
 select * into j from clued_private.storage_jobs_v1 where connection_id=(i->>'connection_id')::uuid and job_id=(i->>'job_id')::uuid;
 if j.intent_id is null then raise exception 'storage_semantic_settle_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||j.owner_id::text||':'||j.job_id::text,0));
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=j.owner_id;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=j.owner_id;
 perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||':'||p.root_folder_id,0));
 perform clued_private.authorization_account_v12(j.owner_id);
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for update;
 select * into s from clued_private.storage_semantic_attempts_v1 where intent_id=m.id and owner_id=j.owner_id and job_id=j.job_id;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=m.id and user_id=j.owner_id for update;
 if s.intent_id is null or not exists(select 1 from clued_private.storage_oauth_apps_v1 app where app.issuer_hash=p_issuer_identity
  and app.oauth_client_id=s.oauth_client_id and app.revoked_at is null) then raise exception 'storage_semantic_settle_denied' using errcode='42501';end if;
 -- Idempotent response recovery authenticates the same original issuer and
 -- exact immutable request; it cannot renew execution or re-open a root.
 if m.final_result->>'semantic_settlement'='before' and i->>'intent_id'=m.id::text
  and i->>'base_version'=m.final_result->>'semantic_base_version' and i->>'request_sha256'=m.request_sha256
  and exists(select 1 from public.clued_audit_receipts a where a.id=(m.final_result->>'semantic_receipt_id')::uuid
   and a.user_id=j.owner_id and a.status='committed' and a.operation in ('storage_semantic_absent','storage_automatic_reconcile')) then
  return jsonb_build_object('status',case when q.state='resolved' then 'resolved' else 'committed' end,'state',m.state,
   'resolution','automatically_reconciled_before','automatic_recovery','resolved','connection_id',j.connection_id,'job_id',j.job_id,
   'intent_id',m.id,'receipt_id',m.final_result->>'semantic_receipt_id','base_version',(m.final_result->>'semantic_base_version')::bigint,
   'source_receipt_id',q.close_receipt_id,'execution_permitted',false);
 end if;
 -- Existing scheduled load supplies all original read-only identity, client,
 -- credential and denial checks. A recovery observation never starts an effect.
 d:=clued_private.ii_pub_clued_storage_scheduled_recovery_v2(p_issuer_identity,
  jsonb_build_object('action','load','connection_id',j.connection_id,'job_id',j.job_id));
 if d->>'status' is distinct from 'recovery_only' or d->>'intent_id' is distinct from m.id::text
 or d->>'oauth_client_id' is distinct from s.oauth_client_id or d->>'credential_version' is distinct from i->>'credential_version'
 or m.id::text is distinct from i->>'intent_id' or m.version::text is distinct from i->>'base_version'
 or m.request_sha256 is distinct from i->>'request_sha256' or m.state not in ('started','uncertain','conflict')
 or m.verified_result_v2 is not null or (m.state='conflict' and (q.state<>'active' or not q.scope_complete or q.closed_version<>m.version)) then
  raise exception 'storage_semantic_settle_conflict' using errcode='40001';end if;
 outcome:=clued_private.storage_semantic_observation_v1(j.owner_id,j.job_id,i->'observation');
 if outcome='after' then raise exception 'storage_semantic_after_requires_verifier' using errcode='42501';end if;
 if outcome='conflict' then
  if m.state='conflict' then return jsonb_build_object('status','attention_required','state','conflict','connection_id',j.connection_id,
   'job_id',j.job_id,'intent_id',m.id,'receipt_id',q.close_receipt_id,'execution_permitted',false);end if;
  perform clued_private.storage_semantic_conflict_close_v1(m.id,i->'observation');
  select * into m from clued_private.resource_center_mutations_v1 where id=m.id;
  return jsonb_build_object('status','attention_required','state',m.state,'connection_id',j.connection_id,'job_id',j.job_id,
   'intent_id',m.id,'receipt_id',m.receipt_id,'execution_permitted',false);
 end if;
 if outcome='absence_probe_required' then
  if i->'absence_proof' is distinct from jsonb_build_object('contract','clued.storage-create-absent/1','intent_id',m.id,
   'provider_file_id',m.provider_attempt->>'provider_file_id','parent_id',m.provider_attempt->>'parent_id') then
   raise exception 'storage_semantic_absence_unproven' using errcode='42501';end if;
 elsif outcome<>'before' or i ? 'absence_proof' then raise exception 'storage_semantic_before_unproven' using errcode='42501';end if;
 if outcome='before' then
  artifact_path:=case when m.exact_request->'mutation'->>'operation'='replace' then m.exact_request->'mutation'->>'destination_path'
   else m.exact_request->'mutation'->>'source_path' end;
  select * into artifact from clued_private.resource_center_artifacts_v1 a where a.user_id=j.owner_id and a.profile_id=m.profile_id
   and a.id=(m.authority_result->'authority'->>'artifact_id')::uuid for update;
  if artifact.id is null or artifact.path is distinct from artifact_path
   or artifact.provider_file_id is distinct from m.provider_attempt->>'provider_file_id'
   or artifact.provider_file_version is distinct from s.observed_file_version
   or artifact.target_kind is distinct from m.exact_request->'mutation'->>'target_kind'
   or artifact.state is distinct from (case when m.exact_request->'mutation'->>'operation'='restore' then 'trashed' else 'active' end) then
    raise exception 'storage_semantic_registry_changed' using errcode='40001';end if;
  artifact_changed:=artifact.provider_file_version is distinct from i->'observation'->'second'->>'provider_file_version';
 end if;
 if m.exact_request->'mutation'->>'operation'='replace' then
  revision:=i->'revision_observation';artifact_id:=(m.authority_result->'authority'->>'artifact_id')::uuid;
  if jsonb_typeof(revision) is distinct from 'object' or (revision-array['id','keepForever','size','md5Checksum'])<>'{}'
  or not(revision ?& array['id','keepForever','size','md5Checksum'])
  or revision->>'id' is distinct from m.provider_attempt->>'pinned_revision_id' or jsonb_typeof(revision->'keepForever') is distinct from 'boolean'
  or revision->'size' is distinct from m.provider_attempt->'content_before'->'size'
  or revision->'md5Checksum' is distinct from m.provider_attempt->'content_before'->'md5' then
   raise exception 'storage_semantic_revision_unproven' using errcode='42501';end if;
 elsif i ? 'revision_observation' then raise exception 'storage_semantic_revision_unexpected' using errcode='42501';end if;
 base:=m.version;source_receipt:=m.receipt_id;old_result:=m.final_result;
 operation:=case when m.state='conflict' then 'storage_automatic_reconcile' else 'storage_semantic_absent' end;
 req:=jsonb_build_object('idempotency_key','storage-semantic-settle:'||m.id::text,'intent_id',m.id,'job_id',j.job_id,
  'base_version',base,'source_receipt_id',source_receipt,'semantic_attempt_receipt_id',s.receipt_id,
  'observation',i->'observation','absence_proof',i->'absence_proof','revision_observation',revision,
  'artifact_cas',case when artifact.id is not null then jsonb_build_object('artifact_id',artifact.id,'base_version',artifact.version,
   'before_provider_version',artifact.provider_file_version,'observed_provider_version',i->'observation'->'second'->>'provider_file_version') else 'null'::jsonb end);
 r:=clued_private.m1_begin_receipt(j.owner_id,null,operation,req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_semantic_settle_conflict' using errcode='40001';end if;
 if revision->'keepForever'='true'::jsonb then
  select * into pin from clued_private.storage_revision_pins_v1 where provider_file_id=m.provider_attempt->>'provider_file_id'
   and revision_id=revision->>'id' and state in ('pinned','owner_kept') for share;
  if pin.id is not null and (pin.owner_id<>j.owner_id or pin.profile_id<>m.profile_id or pin.artifact_id<>artifact_id) then
   raise exception 'storage_semantic_revision_registry_conflict' using errcode='40001';end if;
  if pin.id is null then
   insert into clued_private.storage_revision_pins_v1(owner_id,profile_id,artifact_id,provider_file_id,revision_id,size,md5,sha256,
    job_id,intent_id,pin_receipt_id,state) values(j.owner_id,m.profile_id,artifact_id,m.provider_attempt->>'provider_file_id',revision->>'id',
    m.provider_attempt->'content_before'->>'size',m.provider_attempt->'content_before'->>'md5',m.provider_attempt->'content_before'->>'sha256',
    j.job_id,m.id,r.id,case when (m.provider_attempt->>'previously_kept')::boolean then 'owner_kept' else 'pinned' end);
  end if;
 end if;
 if m.state='conflict' then
  insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
  update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 end if;
 if artifact_changed then
  -- Equality of semantic state deliberately ignores incidental Drive versions.
  -- Refresh only this CAS-pinned registration, with the SAME exit Receipt, so
  -- the next ordinary operation does not get stuck on its old provider version.
  update clued_private.resource_center_artifacts_v1 set provider_file_version=i->'observation'->'second'->>'provider_file_version',
   version=version+1,updated_at=clock_timestamp(),receipt_id=r.id where id=artifact.id and version=artifact.version;
  if not found then raise exception 'storage_semantic_registry_changed' using errcode='40001';end if;
 end if;
 update clued_private.resource_center_mutations_v1 set state=case when m.state='conflict' then 'conflict' else 'cancelled' end,
  version=version+1,updated_at=clock_timestamp(),receipt_id=case when m.state='conflict' then receipt_id else r.id end,
  final_result=coalesce(old_result,'{}')||jsonb_build_object('semantic_settlement','before','semantic_base_version',base,'semantic_receipt_id',r.id,
   'reason_code',case when m.state='conflict' then 'PROVIDER_RESULT_RECONCILED' else 'PROVIDER_EFFECT_ABSENT' end)||
   case when m.state='conflict' then jsonb_build_object('automatic_resolution','automatically_reconciled_before','automatic_base_version',base) else '{}'::jsonb end
  where id=m.id;
 delete from clued_private.storage_recovery_backoff_v1 where owner_id=j.owner_id and job_id=j.job_id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 if artifact_changed then refs:=refs||jsonb_build_array(jsonb_build_object('kind','system','role','target','id',artifact.id));end if;
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:semantic_settled',refs,
  'project:'||p.project_id::text,null,req-'idempotency_key',req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,
  jsonb_build_object(m.id::text,base)||case when artifact_changed then jsonb_build_object(artifact.id::text,artifact.version) else '{}'::jsonb end,
  jsonb_build_object(m.id::text,base+1)||case when artifact_changed then jsonb_build_object(artifact.id::text,artifact.version+1) else '{}'::jsonb end,
  array[ev],'{}'::uuid[],null);
 return jsonb_build_object('status',case when m.state='conflict' then 'resolved' else 'committed' end,
  'state',case when m.state='conflict' then 'conflict' else 'cancelled' end,'resolution','automatically_reconciled_before',
  'automatic_recovery','resolved','connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,
  'base_version',base,'source_receipt_id',source_receipt,'execution_permitted',false);
end $$;
revoke all on function clued_private.storage_semantic_conflict_close_v1(uuid,jsonb),clued_private.storage_semantic_settle_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;
