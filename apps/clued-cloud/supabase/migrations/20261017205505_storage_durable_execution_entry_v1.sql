-- New effects require an actual durable cloud job. Historical outcomes and
-- settlement retain their original identity; no row or proof is backfilled.
-- Generated with Supabase CLI migration new, then scoped before editing.
create table clued_private.storage_execution_entry_permits_v1(
 transaction_id bigint not null,owner_id uuid not null,connection_id uuid not null,job_id uuid not null,
 profile_id uuid not null,root_folder_id text not null,writer_binding_id uuid not null,request_digest text not null,
 prepare_hash text not null,phase text not null check(phase in ('coordinator','prepare','preparing','prepared','start','starting','started')),
 journal_request jsonb,intent_id uuid,intent_version bigint,prepare_receipt_id uuid,row_hash text,
 primary key(transaction_id,owner_id,job_id),unique(transaction_id,owner_id,writer_binding_id));
alter table clued_private.storage_execution_entry_permits_v1 enable row level security;
revoke all on clued_private.storage_execution_entry_permits_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

-- This advances an existing authenticated coordinator row; it never issues one.
create function clued_private.storage_execution_entry_arm_v1(p_owner uuid,p_job uuid,p_writer text,p_prepare jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare e clued_private.storage_execution_entry_permits_v1;j clued_private.storage_jobs_v1;
 c clued_private.storage_connections_v1;p clued_private.resource_center_profiles_v1;
 w clued_private.resource_center_writer_bindings_v1;a clued_private.resource_center_bindings_v1;
begin
 select * into e from clued_private.storage_execution_entry_permits_v1
  where transaction_id=txid_current() and owner_id=p_owner and job_id=p_job for update;
 select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner;
 select * into w from clued_private.resource_center_writer_bindings_v1 where token_hash=clued_private.credential_verifier_v1(p_writer);
 select * into a from clued_private.resource_center_bindings_v1 where id=w.authority_binding_id;
 if e.phase is distinct from 'coordinator' or j.job_id is null or j.intent_id is not null
 or e.connection_id is distinct from c.id or e.profile_id is distinct from p.id
 or e.root_folder_id is distinct from p.root_folder_id or e.writer_binding_id is distinct from w.id
 or j.cloud_writer_binding_id is distinct from w.id or a.profile_id is distinct from p.id or a.user_id is distinct from p_owner
 or e.request_digest is distinct from j.request_digest or e.prepare_hash is distinct from clued_private.m1_sha256(p_prepare)
 or p_prepare->>'action' is distinct from 'prepare' or p_prepare->>'request_key' is distinct from 'account-job:'||p_job::text then
  raise exception 'storage_durable_job_required' using errcode='42501';end if;
 update clued_private.storage_execution_entry_permits_v1 set phase='prepare',journal_request=p_prepare||jsonb_build_object(
  'profile_id',p.id,'source_decision_id',w.source_decision_id,'authority_token_hash',a.token_hash,'writer_binding_id',w.id)
  where transaction_id=e.transaction_id and owner_id=p_owner and job_id=p_job;
end $$;

-- The ordinary journal entry checks the whole internally composed request
-- before creating a Receipt. A correct UUID, request key or GUC grants nothing.
create function clued_private.storage_execution_entry_check_v1(p_owner uuid,p_input jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare e clued_private.storage_execution_entry_permits_v1;action text:=p_input->>'action';
begin
 if action not in ('prepare','start') then return;end if;
 select * into e from clued_private.storage_execution_entry_permits_v1
  where transaction_id=txid_current() and owner_id=p_owner
   and writer_binding_id=(p_input->>'writer_binding_id')::uuid for update;
 if e.phase is distinct from (case action when 'prepare' then 'prepare' else 'start' end)
 or e.journal_request is distinct from p_input then
  raise exception 'storage_durable_job_required' using errcode='42501';end if;
 update clued_private.storage_execution_entry_permits_v1 set phase=case action when 'prepare' then 'preparing' else 'starting' end
  where transaction_id=e.transaction_id and owner_id=e.owner_id and job_id=e.job_id;
end $$;

-- Independently protect the real relation. This is additive to the existing
-- conflict guard; inspect, provider-attempt recording and settlement are intact.
create function clued_private.storage_execution_entry_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare e clued_private.storage_execution_entry_permits_v1;r public.clued_audit_receipts;
begin
 if tg_op='UPDATE' and (new.state is not distinct from old.state or new.state not in ('prepared','started')) then return new;end if;
 select * into e from clued_private.storage_execution_entry_permits_v1
  where transaction_id=txid_current() and owner_id=new.user_id and writer_binding_id=new.writer_binding_id for update;
 select * into r from public.clued_audit_receipts where id=new.receipt_id;
 if e.owner_id is null or e.profile_id is distinct from new.profile_id
 or not exists(select 1 from clued_private.resource_center_profiles_v1 p where p.id=new.profile_id
  and p.user_id=new.user_id and p.root_folder_id=e.root_folder_id)
 or r.user_id is distinct from new.user_id or r.status is distinct from 'pending'
 or r.operation is distinct from 'resource_center_journal'
 or r.received_payload_hash is distinct from clued_private.m1_sha256(e.journal_request)
 or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object(
  'operation','resource_center_journal','payload',e.journal_request-'idempotency_key'-'request_hash')) then
  raise exception 'storage_durable_job_required' using errcode='42501';end if;
 if tg_op='INSERT' then
  if new.state is distinct from 'prepared' or e.phase is distinct from 'preparing' or e.intent_id is not null
  or new.version<>1 or new.request_key is distinct from e.journal_request->>'request_key'
  or new.request_sha256 is distinct from e.journal_request->>'request_sha256'
  or new.exact_request is distinct from e.journal_request->'exact_request'
  or new.authority_request is distinct from e.journal_request->'authority_request'
  or new.authority_token_hash is distinct from e.journal_request->>'authority_token_hash'
  or new.source_decision_id::text is distinct from e.journal_request->>'source_decision_id' then
   raise exception 'storage_durable_job_required' using errcode='42501';end if;
  update clued_private.storage_execution_entry_permits_v1 set phase='prepared',intent_id=new.id,
   intent_version=new.version,prepare_receipt_id=new.receipt_id,row_hash=clued_private.m1_sha256(to_jsonb(new))
   where transaction_id=e.transaction_id and owner_id=e.owner_id and job_id=e.job_id;
 else
  if e.phase is distinct from 'starting' or old.state is distinct from 'prepared' or new.state is distinct from 'started'
  or e.intent_id is distinct from old.id or e.intent_version is distinct from old.version
  or e.row_hash is distinct from clued_private.m1_sha256(to_jsonb(old)) or new.version<>old.version+1
  or (to_jsonb(new)-array['state','version','updated_at','receipt_id']) is distinct from
     (to_jsonb(old)-array['state','version','updated_at','receipt_id']) then
   raise exception 'storage_durable_job_required' using errcode='42501';end if;
  update clued_private.storage_execution_entry_permits_v1 set phase='started',intent_version=new.version,
   row_hash=clued_private.m1_sha256(to_jsonb(new))
   where transaction_id=e.transaction_id and owner_id=e.owner_id and job_id=e.job_id;
 end if;
 return new;
end $$;
create trigger storage_execution_entry_guard_v1 before insert or update on clued_private.resource_center_mutations_v1
 for each row execute function clued_private.storage_execution_entry_guard_v1();

create function clued_private.storage_execution_entry_start_v1(p_owner uuid,p_job uuid,p_prepared jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare e clued_private.storage_execution_entry_permits_v1;m clued_private.resource_center_mutations_v1;
 r public.clued_audit_receipts;req jsonb;
begin
 select * into e from clued_private.storage_execution_entry_permits_v1
  where transaction_id=txid_current() and owner_id=p_owner and job_id=p_job for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=e.intent_id and user_id=p_owner;
 select * into r from public.clued_audit_receipts where id=e.prepare_receipt_id;
 if e.phase is distinct from 'prepared' or m.id is null or m.state is distinct from 'prepared'
 or e.row_hash is distinct from clued_private.m1_sha256(to_jsonb(m))
 or r.status is distinct from 'committed' or r.user_id is distinct from p_owner
 or p_prepared->>'status' is distinct from 'committed' or p_prepared->>'state' is distinct from 'prepared'
 or p_prepared->>'intent_id' is distinct from m.id::text or p_prepared->>'version' is distinct from m.version::text
 or p_prepared->>'request_sha256' is distinct from m.request_sha256
 or p_prepared->>'receipt_id' is distinct from m.receipt_id::text then
  raise exception 'storage_durable_job_required' using errcode='42501';end if;
 req:=jsonb_build_object('action','start','intent_id',p_prepared->'intent_id','base_version',p_prepared->'version',
  'request_sha256',p_prepared->'request_sha256','idempotency_key','account-job:'||p_job::text||':start',
  'profile_id',m.profile_id,'source_decision_id',m.source_decision_id,
  'authority_token_hash',m.authority_token_hash,'writer_binding_id',m.writer_binding_id);
 update clued_private.storage_execution_entry_permits_v1 set phase='start',journal_request=req
  where transaction_id=e.transaction_id and owner_id=p_owner and job_id=p_job;
end $$;

create function clued_private.storage_execution_entry_complete_v1(p_owner uuid,p_job uuid)
returns void language plpgsql security definer set search_path='' as $$
declare e clued_private.storage_execution_entry_permits_v1;m clued_private.resource_center_mutations_v1;
begin
 select * into e from clued_private.storage_execution_entry_permits_v1
  where transaction_id=txid_current() and owner_id=p_owner and job_id=p_job for update;
 select m0.* into m from clued_private.resource_center_mutations_v1 m0 join clued_private.storage_jobs_v1 j
  on j.owner_id=m0.user_id and j.intent_id=m0.id where j.owner_id=p_owner and j.job_id=p_job;
 if e.phase is distinct from 'started' or e.intent_id is distinct from m.id or m.id is null
 or m.state is distinct from 'started' or e.intent_version is distinct from m.version
 or e.row_hash is distinct from clued_private.m1_sha256(to_jsonb(m)) then
  raise exception 'storage_durable_job_required' using errcode='42501';end if;
 delete from clued_private.storage_execution_entry_permits_v1 where transaction_id=e.transaction_id and owner_id=p_owner and job_id=p_job;
end $$;

revoke all on function clued_private.storage_execution_entry_arm_v1(uuid,uuid,text,jsonb),
 clued_private.storage_execution_entry_check_v1(uuid,jsonb),clued_private.storage_execution_entry_guard_v1(),
 clued_private.storage_execution_entry_start_v1(uuid,uuid,jsonb),clued_private.storage_execution_entry_complete_v1(uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Modify the exact current cores in place. No public RPC or grant is added,
-- and no old function body is restored over issuer/gateway/recovery successors.
do $source$
declare item record;definition text;anchor text;replacement text;variant text;
begin
 for item in select * from (values
  ('clued_private.ii_pub_clued_storage_cloud_worker_v1(text,jsonb)','702177e6f4e529ecfb132424ba295e11','1'),
  ('clued_private.storage_cloud_before_registration_v1(text,jsonb)','0bfa8c386436f8454bb92d3c86278883','2'),
  ('clued_private.storage_job_begin_v1(uuid,uuid,text,jsonb)','f12a3aba7b0a6408b887f41950314777','1'),
  ('clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb)','89fbe7b74beac495dce6df67c3825d60','2'),
  ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)','0355365dfe8cb1439a28b39e53288195','journal')
 ) v(signature,expected_md5,variant) loop
  if (select md5(prosrc) from pg_proc where oid=item.signature::regprocedure) is distinct from item.expected_md5 then
   raise exception 'storage_durable_entry_source_changed: %',item.signature;end if;
  definition:=pg_get_functiondef(item.signature::regprocedure);variant:=item.variant;
  if item.signature like '%storage_cloud_%' then
   anchor:='  elsif op=''begin'' then return clued_private.storage_job_begin_v'||variant||'(c.owner_id,j.job_id,clued_private.credential_internal_proof_v1(w.token_hash),p_input->''prepare'');';
   replacement:='  elsif op=''begin'' then'||E'\n'||$inline$
    if j.intent_id is null then
     insert into clued_private.storage_execution_entry_permits_v1(transaction_id,owner_id,connection_id,job_id,
      profile_id,root_folder_id,writer_binding_id,request_digest,prepare_hash,phase)
     values(txid_current(),c.owner_id,c.id,j.job_id,p.id,p.root_folder_id,w.id,j.request_digest,
      clued_private.m1_sha256(p_input->'prepare'),'coordinator');
    end if;
$inline$||'    result:=clued_private.storage_job_begin_v'||variant||'(c.owner_id,j.job_id,clued_private.credential_internal_proof_v1(w.token_hash),p_input->''prepare'');'||E'\n'||$inline$
    delete from clued_private.storage_execution_entry_permits_v1
     where transaction_id=txid_current() and owner_id=c.owner_id and job_id=j.job_id;
    return result;
$inline$;
   if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'storage_durable_entry_coordinator_anchor_changed';end if;
   definition:=replace(definition,anchor,replacement);
  elsif variant='journal' then
   anchor:=E'\nbegin\n';replacement:=anchor||'  perform clued_private.storage_execution_entry_check_v1(p_user_id,p_input);'||E'\n';
   if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'storage_durable_entry_journal_anchor_changed';end if;
   definition:=replace(definition,anchor,replacement);
  else
   anchor:='  prepared:=public.clued_resource_center_write_v1(p_writer_hash,p_prepare);';
   replacement:='  perform clued_private.storage_execution_entry_arm_v1(p_owner,p_job,p_writer_hash,p_prepare);'||E'\n'||anchor;
   if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'storage_durable_entry_prepare_anchor_changed';end if;
   definition:=replace(definition,anchor,replacement);
   anchor:='  started:=public.clued_resource_center_write_v1(p_writer_hash,jsonb_build_object(''action'',''start'',';
   replacement:='  perform clued_private.storage_execution_entry_start_v1(p_owner,p_job,prepared);'||E'\n'||anchor;
   if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'storage_durable_entry_start_anchor_changed';end if;
   definition:=replace(definition,anchor,replacement);
   anchor:='  return started||jsonb_build_object(''job_id'',p_job,''job_request_digest'',j.request_digest)';
   replacement:='  perform clued_private.storage_execution_entry_complete_v1(p_owner,p_job);'||E'\n'||anchor;
   if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'storage_durable_entry_complete_anchor_changed';end if;
   definition:=replace(definition,anchor,replacement);
  end if;
  execute definition;
 end loop;
end $source$;
