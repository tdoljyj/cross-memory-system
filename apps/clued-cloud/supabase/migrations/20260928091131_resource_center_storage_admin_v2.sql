-- Storage-only deployment designation. No seed, account grant or provider effect.
-- Reviewed contract: development/contracts/storage/StorageAdministration.v0.1.md.
create table clued_private.storage_admin_v2 (
  singleton boolean primary key default true check(singleton),
  id uuid not null unique default gen_random_uuid(),
  subject_id uuid not null references auth.users(id),
  version bigint not null check(version>0),
  state text not null check(state in ('active','revoked')),
  approval_receipt_id uuid not null references public.clued_audit_receipts(id),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  updated_at timestamptz not null default clock_timestamp()
);
alter table clued_private.storage_admin_v2 enable row level security;
revoke all on clued_private.storage_admin_v2 from public,anon,authenticated,service_role;

create function clued_private.storage_admin_history_guard_v2() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'storage_admin_history_immutable' using errcode='42501'; end if;
  if new.id is distinct from old.id or new.subject_id is distinct from old.subject_id
    or new.singleton is distinct from old.singleton or new.version<>old.version+1
    or new.state=old.state then
    raise exception 'storage_admin_history_immutable' using errcode='42501'; end if;
  return new;
end $$;
create trigger storage_admin_history_guard_v2 before update or delete on clued_private.storage_admin_v2
  for each row execute function clued_private.storage_admin_history_guard_v2();
revoke all on function clued_private.storage_admin_history_guard_v2() from public,anon,authenticated,service_role;

create function clued_private.storage_admin_designate_v2(p_input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a clued_private.storage_admin_v2; d public.clued_memories; proof public.clued_audit_receipts;
  r public.clued_audit_receipts; prior public.clued_audit_receipts; u uuid; op text; wanted text;
  base bigint; refs jsonb; ev text; result jsonb; failure text; code text;
begin
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.storage_admin_designate_v2(jsonb)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['action','subject_id','base_version','idempotency_key','decision_id','decision_version','approval_receipt_id','approval_sha256']<>'{}'
    or not(p_input ?& array['action','subject_id','base_version','idempotency_key','decision_id','decision_version','approval_receipt_id','approval_sha256'])
    or p_input->>'action' not in ('designate','revoke') or jsonb_typeof(p_input->'action') is distinct from 'string'
    or jsonb_typeof(p_input->'base_version') is distinct from 'number' or p_input->>'base_version' !~ '^(0|[1-9][0-9]{0,17})$'
    or jsonb_typeof(p_input->'decision_version') is distinct from 'number' or p_input->>'decision_version' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160
    or btrim(p_input->>'idempotency_key')<>p_input->>'idempotency_key'
    or jsonb_typeof(p_input->'approval_sha256') is distinct from 'string' or p_input->>'approval_sha256' !~ '^[0-9a-f]{64}$'
    or exists(select 1 from unnest(array['subject_id','decision_id','approval_receipt_id']) k
      where jsonb_typeof(p_input->k) is distinct from 'string'
        or p_input->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'storage_admin_input_invalid' using errcode='22023'; end if;
  u:=(p_input->>'subject_id')::uuid; op:=p_input->>'action'; base:=(p_input->>'base_version')::bigint;
  wanted:=case when op='designate' then 'active' else 'revoked' end;
  perform pg_advisory_xact_lock(hashtextextended('storage-admin-designation-v2',0));
  select * into a from clued_private.storage_admin_v2 where singleton for update;
  if a.id is not null and a.subject_id is distinct from u then
    raise exception 'storage_admin_scope_denied' using errcode='42501'; end if;
  -- Only the latest resulting state may replay its Receipt. An old activation
  -- must not return a success after a later revoke/reactivation.
  select * into prior from public.clued_audit_receipts where user_id=u
    and operation_family='storage_admin_'||op and idempotency_key=p_input->>'idempotency_key' and owns_idempotency_key;
  if prior.id is not null then
    if prior.status<>'committed' or a.receipt_id is distinct from prior.id or a.state is distinct from wanted
      or a.version is distinct from base+1 then
      raise exception 'storage_admin_version_conflict' using errcode='40001'; end if;
  elsif (a.id is null and (base<>0 or op<>'designate'))
    or (a.id is not null and (a.version<>base or a.state=wanted)) then
    raise exception 'storage_admin_version_conflict' using errcode='40001'; end if;
  if op='designate' then
    perform clued_private.authorization_account_v12(u);
    if not exists(select 1 from auth.users x where x.id=u and x.email_confirmed_at is not null
      and not coalesce((to_jsonb(x)->>'is_anonymous')::boolean,false)) then
      raise exception 'storage_admin_verified_account_required' using errcode='42501'; end if;
  end if;
  r:=clued_private.m1_begin_receipt(u,null,'storage_admin_'||op,p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then return r.canonical_result; end if;
  select * into d from public.clued_memories where id=(p_input->>'decision_id')::uuid and user_id=u for share;
  select * into proof from public.clued_audit_receipts where id=(p_input->>'approval_receipt_id')::uuid and user_id=u;
  if d.id is null or d.version is distinct from (p_input->>'decision_version')::bigint
    or not clued_private.resource_center_decision_current_v1(u,d.project_id,d.id)
    or d.type_fields->>'storage_admin_subject_id' is distinct from u::text
    or d.type_fields->>'storage_admin_action' is distinct from op
    or d.receipt_id is distinct from proof.id
    or proof.status is distinct from 'committed' or proof.request_sha256 is distinct from p_input->>'approval_sha256'
    or proof.error_code is not null
    or proof.operation is distinct from 'record_mutation' or proof.operation_family is distinct from 'record_mutation'
    or proof.object_type is distinct from 'request' or proof.context_key is distinct from 'm1:record_mutation'
    or proof.binding_id is null or not exists(select 1 from public.clued_agent_bindings b
      where b.id=proof.binding_id and b.user_id=u)
    or proof.committed_versions->>d.id::text is distinct from d.version::text
    or not(proof.target_refs @> jsonb_build_array(jsonb_build_object('kind','record','role','primary','id',d.id)))
    or exists(select 1 from public.clued_context_events e where e.user_id=u
      and e.canonical_event_type in ('extension:storage:admin_designate','extension:storage:admin_revoke')
      and e.change_summary->>'approval_receipt_id'=proof.id::text) then
    raise exception 'storage_admin_approval_required' using errcode='42501'; end if;
  if a.id is null then
    insert into clued_private.storage_admin_v2(subject_id,version,state,approval_receipt_id,receipt_id)
      values(u,1,wanted,proof.id,r.id) returning * into a;
  else
    update clued_private.storage_admin_v2 set version=version+1,state=wanted,approval_receipt_id=proof.id,
      receipt_id=r.id,updated_at=clock_timestamp() where singleton returning * into a;
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',a.id),
    jsonb_build_object('kind','record','role','source','id',d.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:admin_'||op,refs,'global',null,
    jsonb_build_object('subject_id',u,'state',a.state,'storage_admin_version',a.version,'decision_id',d.id,
      'decision_version',d.version,'approval_receipt_id',proof.id,'approval_sha256',proof.request_sha256,
      'operator_role',current_user,'session_role',session_user,'file_authority_granted',false),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}','[]',null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(a.id::text,base),
    jsonb_build_object(a.id::text,a.version),array[ev],'{}',null);
  if op='designate' then perform clued_private.authorization_account_v12(u); end if;
  return result;
exception when others then
  get stacked diagnostics failure=message_text,code=returned_sqlstate;
  if failure in ('offline_database_operator_required','storage_admin_input_invalid','storage_admin_scope_denied',
    'storage_admin_version_conflict','storage_admin_verified_account_required','storage_admin_approval_required','account_not_available')
    and code in ('22023','42501','40001') then raise exception '%',failure using errcode=code; end if;
  raise exception 'storage_admin_failed' using errcode='42501';
end $$;
revoke all on function clued_private.storage_admin_designate_v2(jsonb) from public,anon,authenticated,service_role;

create or replace function clued_private.storage_client_capability_admin_v2(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
<<client_admin>>
declare actor clued_private.storage_admin_v2; op text; allowed text[];
  request_row clued_private.authorization_requests_v12; registration clued_private.storage_client_registrations_v2;
  cap clued_private.storage_client_capabilities_v2; evrow public.clued_evidence;
  source_ev public.clued_evidence; receipt public.clued_audit_receipts;
  source jsonb; source_text text; source_hash text; source_digest text; metadata_digest text;
  lineage uuid; requested_lineage uuid; request_id uuid; capability_id uuid; generation bigint; cap_version bigint;
  expected_generation bigint; expected_cap_version bigint; refs jsonb; bases jsonb:='{}'; versions jsonb;
  summary jsonb; event_id text; result jsonb; issuer_key text; resource_key text; client_key text; eowner uuid; field text; audit_evidence uuid[];
  identity_lineages uuid[];
  failure text; failure_state text;
begin
  -- Must remain INVOKER: a SECURITY DEFINER current_user check would bless the
  -- owner for every caller. JWT/native/admin claims never substitute this role.
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.storage_client_capability_admin_v2(jsonb)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object' or pg_column_size(p_input)>100000
    or jsonb_typeof(p_input->'action') is distinct from 'string' then
    raise exception 'storage_client_admin_input_invalid' using errcode='22023'; end if;
  op:=p_input->>'action';
  allowed:=array['action','idempotency_key','storage_admin_version','evidence_id','evidence_sha256'];
  case op
    when 'register_snapshot' then allowed:=allowed||array['request_id','expected_request_digest','source_snapshot_json','expected_lineage_id','expected_registration_generation'];
    when 'qualify' then allowed:=allowed||array['lineage_id','registration_generation','expected_metadata_digest','expected_source_digest','expected_capability_version'];
    when 'revoke' then allowed:=allowed||array['capability_id','base_version'];
    when 'link_request' then allowed:=allowed||array['request_id','expected_request_digest','lineage_id','registration_generation','capability_id','capability_version','source_snapshot_json'];
    else raise exception 'storage_client_admin_input_invalid' using errcode='22023';
  end case;
  if (p_input-allowed)<>'{}'::jsonb or not(p_input ?& allowed)
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160
    or btrim(p_input->>'idempotency_key') is distinct from p_input->>'idempotency_key'
    or jsonb_typeof(p_input->'storage_admin_version') is distinct from 'number'
    or p_input->>'storage_admin_version' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'evidence_sha256') is distinct from 'string'
    or p_input->>'evidence_sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_input->'evidence_id') is distinct from 'string'
    or p_input->>'evidence_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'storage_client_admin_input_invalid' using errcode='22023'; end if;
  foreach field in array array['request_id','expected_lineage_id','lineage_id','capability_id'] loop
    if p_input ? field and not(field='expected_lineage_id' and p_input->field='null'::jsonb) then
      if jsonb_typeof(p_input->field) is distinct from 'string' or
        p_input->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'storage_client_admin_input_invalid' using errcode='22023'; end if;
    end if;
  end loop;
  foreach field in array array['expected_registration_generation','registration_generation','expected_capability_version','base_version','capability_version'] loop
    if p_input ? field then
      if jsonb_typeof(p_input->field) is distinct from 'number' or p_input->>field !~ '^(0|[1-9][0-9]{0,17})$'
        or (field not in ('expected_registration_generation','expected_capability_version') and (p_input->>field)::bigint<1) then
        raise exception 'storage_client_admin_input_invalid' using errcode='22023'; end if;
    end if;
  end loop;
  foreach field in array array['expected_request_digest','expected_metadata_digest','expected_source_digest'] loop
    if p_input ? field and (jsonb_typeof(p_input->field) is distinct from 'string' or p_input->>field !~ '^[0-9a-f]{64}$') then
      raise exception 'storage_client_admin_input_invalid' using errcode='22023'; end if;
  end loop;
  select * into actor from clued_private.storage_admin_v2 where singleton for share;
  if not found or actor.state<>'active' or actor.version is distinct from (p_input->>'storage_admin_version')::bigint then
    raise exception 'storage_admin_required' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(actor.subject_id);
  -- This maintenance designation can only originate/link its own requests.
  -- Global technical qualification still does not grant any account policy.
  if (op in ('register_snapshot','link_request') and not exists(
      select 1 from clued_private.authorization_requests_v12 q
      where q.id=(p_input->>'request_id')::uuid and q.owner_id=actor.subject_id))
    or (op in ('qualify','link_request') and not exists(
      select 1 from clued_private.storage_client_registrations_v2 g
      join clued_private.authorization_requests_v12 q on q.id=g.source_request_id
      where g.lineage_id=(p_input->>'lineage_id')::uuid and g.generation=(p_input->>'registration_generation')::bigint
        and q.owner_id=actor.subject_id))
    or (op='revoke' and not exists(
      select 1 from clued_private.storage_client_capabilities_v2 c
      join clued_private.storage_client_registrations_v2 g on g.lineage_id=c.lineage_id and g.generation=c.registration_generation
      join clued_private.authorization_requests_v12 q on q.id=g.source_request_id
      where c.id=(p_input->>'capability_id')::uuid and q.owner_id=actor.subject_id)) then
    raise exception 'storage_admin_scope_denied' using errcode='42501'; end if;
  -- Serialize identical requests before inspecting state. Receipt replays are
  -- historical metadata, not renewed qualification or a fresh source claim.
  perform pg_advisory_xact_lock(hashtextextended('storage-client-admin-receipt:'||actor.subject_id::text||':'||op||':'||(p_input->>'idempotency_key'),0));
  receipt:=clued_private.m1_begin_receipt(actor.subject_id,null,'storage_client_'||op,p_input,clued_private.m1_sha256(p_input));
  if receipt.status<>'pending' then return receipt.canonical_result; end if;

  if op in ('register_snapshot','link_request') then
    if jsonb_typeof(p_input->'source_snapshot_json') is distinct from 'string' then
      raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
    source_text:=p_input->>'source_snapshot_json';
    source_hash:=encode(extensions.digest(convert_to(source_text,'UTF8'),'sha256'),'hex');
    source:=clued_private.storage_client_source_parse_v2(source_text);
    request_id:=(p_input->>'request_id')::uuid;
    if source->>'request_id' is distinct from request_id::text
      or source->>'request_digest' is distinct from p_input->>'expected_request_digest'
      or source_hash is distinct from p_input->>'evidence_sha256' then
      raise exception 'storage_client_source_mismatch' using errcode='42501'; end if;
    source_digest:=clued_private.m1_sha256(source->'client');
    select issuer_hash,resource,client_id into issuer_key,resource_key,client_key from clued_private.authorization_requests_v12 where id=client_admin.request_id;
    if op='link_request' then
      select * into registration from clued_private.storage_client_registrations_v2 r
        where r.lineage_id=(p_input->>'lineage_id')::uuid and r.generation=(p_input->>'registration_generation')::bigint;
    end if;
  elsif op='qualify' then
    requested_lineage:=(p_input->>'lineage_id')::uuid;
    expected_generation:=(p_input->>'registration_generation')::bigint;
    select * into registration from clued_private.storage_client_registrations_v2 r
      where r.lineage_id=requested_lineage and r.generation=expected_generation;
    issuer_key:=registration.issuer_hash; resource_key:=registration.resource;
  end if;
  if op<>'revoke' then
    perform 1 from clued_private.authorization_issuers_v12 where token_hash=issuer_key and resource=resource_key and revoked_at is null for share;
    if not found then raise exception 'storage_client_source_mismatch' using errcode='42501'; end if;
  end if;

  -- Evidence may be withdrawn. Take the SAME shared guard as knowledge reads,
  -- including an older source review's owner after storage-administrator lifecycle.
  select * into evrow from public.clued_evidence where id=(p_input->>'evidence_id')::uuid;
  if op in ('qualify','link_request') then select * into source_ev from public.clued_evidence where id=registration.source_evidence_id; end if;
  for eowner in select distinct u from unnest(array[actor.subject_id,source_ev.user_id]) u where u is not null order by u loop
    perform pg_advisory_xact_lock_shared(hashtextextended('clued-evidence-withdrawal:'||eowner::text,0));
  end loop;
  if evrow.id is null or evrow.user_id<>actor.subject_id or evrow.content_hash<>p_input->>'evidence_sha256'
    or evrow.evidence_type not in ('file','test_output') or evrow.mime_type is distinct from 'application/json'
    or not exists(select 1 from public.clued_audit_receipts where id=evrow.receipt_id and user_id=evrow.user_id and status='committed')
    or exists(select 1 from clued_private.evidence_withdrawals where user_id=evrow.user_id and evidence_id=evrow.id) then
    raise exception 'storage_client_review_required' using errcode='42501'; end if;
  if op in ('register_snapshot','link_request') and evrow.size_bytes is distinct from octet_length(convert_to(source_text,'UTF8'))::bigint then
    raise exception 'storage_client_source_mismatch' using errcode='42501'; end if;

  -- Initial registrations do not have a lineage yet. Serialize by the exact
  -- server request BEFORE allocating/locking a lineage, closing the absent-row
  -- race between different idempotency keys. The unique index is the backstop.
  if op in ('register_snapshot','link_request') then
    perform pg_advisory_xact_lock(hashtextextended('storage-client-source-request:'||client_admin.request_id::text,0));
  end if;

  if op='register_snapshot' then
    requested_lineage:=(p_input->>'expected_lineage_id')::uuid;
    expected_generation:=(p_input->>'expected_registration_generation')::bigint;
    if expected_generation is null or expected_generation<0 or (requested_lineage is null)<>(expected_generation=0) then
      raise exception 'storage_client_admin_input_invalid' using errcode='22023'; end if;
    -- A fresh reviewed request is not a fresh platform identity. Serialize the
    -- server-derived triple before lineage allocation so a new request cannot
    -- create a parallel lineage and bypass an existing owner+lineage deny.
    -- Order: exact request -> platform identity -> platform lineage.
    perform pg_advisory_xact_lock(hashtextextended('storage-client-registration-identity:'||
      clued_private.m1_sha256(jsonb_build_array(issuer_key,resource_key,client_key)),0));
    select array_agg(distinct r.lineage_id) into identity_lineages
      from clued_private.storage_client_registrations_v2 r
      where r.issuer_hash=issuer_key and r.resource=resource_key and r.client_id=client_key;
    if coalesce(cardinality(identity_lineages),0)>1
      or (coalesce(cardinality(identity_lineages),0)=0 and requested_lineage is not null)
      or (cardinality(identity_lineages)=1 and requested_lineage is distinct from identity_lineages[1]) then
      raise exception 'storage_client_qualification_conflict' using errcode='40001'; end if;
    lineage:=coalesce(requested_lineage,gen_random_uuid());
  elsif op in ('qualify','link_request') then lineage:=(p_input->>'lineage_id')::uuid;
  else
    capability_id:=(p_input->>'capability_id')::uuid;
    select lineage_id into lineage from clued_private.storage_client_capabilities_v2 where id=capability_id;
  end if;
  if lineage is null then raise exception 'storage_client_qualification_conflict' using errcode='40001'; end if;
  -- Platform-only management key; NEVER an account storage-client/root/job key.
  perform pg_advisory_xact_lock(hashtextextended('storage-client-registration-admin:'||lineage::text,0));
  select coalesce(max(r.generation),0) into generation from clued_private.storage_client_registrations_v2 r where r.lineage_id=lineage;
  select coalesce(max(version),0) into cap_version from clued_private.storage_client_capabilities_v2 where lineage_id=lineage;

  if op in ('register_snapshot','link_request') then
    select * into request_row from clued_private.authorization_requests_v12 where id=client_admin.request_id for share;
    if not found or request_row.status<>'approved' or request_row.binding_id is null
      or request_row.request_digest is distinct from p_input->>'expected_request_digest'
      or request_row.issuer_hash is distinct from issuer_key or request_row.resource is distinct from resource_key
      or request_row.client_id is distinct from client_key
      or source->>'resource' is distinct from request_row.resource or source->'client'->>'clientId' is distinct from request_row.client_id
      or coalesce(source->'client'->>'clientName',source->'client'->>'clientId') is distinct from request_row.client_name
      or not(source->'client'->'redirectUris' ? request_row.redirect_uri) then
      raise exception 'storage_client_source_mismatch' using errcode='42501'; end if;
    metadata_digest:=clued_private.storage_client_request_digest_v2(request_id);
  end if;

  if op='register_snapshot' then
    if generation<>expected_generation or exists(select 1 from clued_private.storage_client_capabilities_v2 where lineage_id=lineage and state='active')
      or exists(select 1 from clued_private.storage_client_registrations_v2 where source_request_id=client_admin.request_id) then
      raise exception 'storage_client_qualification_conflict' using errcode='40001'; end if;
    if generation>0 then
      select * into registration from clued_private.storage_client_registrations_v2 r
        where r.lineage_id=lineage and r.generation=client_admin.generation for share;
      if not found or registration.issuer_hash is distinct from request_row.issuer_hash
        or registration.resource is distinct from request_row.resource
        or registration.client_id is distinct from request_row.client_id
        or not exists(select 1 from clued_private.authorization_requests_v12 q
          where q.id=registration.source_request_id and q.owner_id=actor.subject_id) then
        raise exception 'storage_client_source_mismatch' using errcode='42501'; end if;
    end if;
    generation:=generation+1;
    insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,
      review_receipt_id,source_metadata_digest,source_snapshot_sha256,source_evidence_id,source_request_id,source_snapshot)
      values(lineage,generation,request_row.issuer_hash,request_row.resource,request_row.client_id,metadata_digest,receipt.id,
        source_digest,source_hash,evrow.id,request_id,source);
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',lineage));
    bases:=jsonb_build_object(lineage::text,expected_generation); versions:=jsonb_build_object(lineage::text,generation);
  elsif op='qualify' then
    select * into registration from clued_private.storage_client_registrations_v2 r where r.lineage_id=lineage and r.generation=expected_generation;
    expected_cap_version:=(p_input->>'expected_capability_version')::bigint;
    if not found or generation<>expected_generation or cap_version is distinct from expected_cap_version
      or registration.metadata_digest is distinct from p_input->>'expected_metadata_digest'
      or registration.source_metadata_digest is null or registration.source_metadata_digest is distinct from p_input->>'expected_source_digest'
      or source_ev.id is null or source_ev.content_hash is distinct from registration.source_snapshot_sha256
      or not exists(select 1 from public.clued_audit_receipts where id=source_ev.receipt_id and user_id=source_ev.user_id and status='committed')
      or not exists(select 1 from public.clued_audit_receipts where id=registration.review_receipt_id and status='committed')
      or exists(select 1 from clued_private.evidence_withdrawals where user_id=source_ev.user_id and evidence_id=source_ev.id)
      or exists(select 1 from clued_private.storage_client_capabilities_v2 where lineage_id=lineage and state='active') then
      raise exception 'storage_client_qualification_conflict' using errcode='40001'; end if;
    insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,version,receipt_id)
      values(lineage,generation,cap_version+1,receipt.id) returning * into cap;
    capability_id:=cap.id; cap_version:=cap.version;
    metadata_digest:=registration.metadata_digest; source_digest:=registration.source_metadata_digest;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',cap.id),jsonb_build_object('kind','system','role','source','id',lineage));
    bases:=jsonb_build_object(lineage::text,expected_cap_version); versions:=jsonb_build_object(cap.id::text,cap.version);
  elsif op='revoke' then
    select * into cap from clued_private.storage_client_capabilities_v2 where id=capability_id and lineage_id=lineage for update;
    if not found or cap.state<>'active' or cap.version is distinct from (p_input->>'base_version')::bigint then
      raise exception 'storage_client_qualification_conflict' using errcode='40001'; end if;
    update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=receipt.id
      where id=cap.id returning * into cap;
    cap_version:=cap.version; generation:=cap.registration_generation;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',cap.id),jsonb_build_object('kind','system','role','source','id',lineage));
    bases:=jsonb_build_object(cap.id::text,(p_input->>'base_version')::bigint); versions:=jsonb_build_object(cap.id::text,cap.version);
  else
    select * into cap from clued_private.storage_client_capabilities_v2 where id=(p_input->>'capability_id')::uuid and lineage_id=lineage for share;
    if not found or cap.state<>'active' or cap.version is distinct from (p_input->>'capability_version')::bigint
      or cap.registration_generation is distinct from (p_input->>'registration_generation')::bigint
      or cap.registration_generation<>generation then raise exception 'storage_client_qualification_conflict' using errcode='40001'; end if;
    select * into registration from clued_private.storage_client_registrations_v2 r where r.lineage_id=lineage and r.generation=cap.registration_generation;
    if registration.issuer_hash is distinct from request_row.issuer_hash or registration.resource is distinct from request_row.resource
      or registration.client_id is distinct from request_row.client_id or registration.metadata_digest is distinct from metadata_digest
      or registration.source_metadata_digest is distinct from source_digest or registration.source_snapshot_sha256 is null
      or source_ev.id is null or source_ev.content_hash is distinct from registration.source_snapshot_sha256
      or exists(select 1 from clued_private.evidence_withdrawals where user_id=source_ev.user_id and evidence_id=source_ev.id)
      or not exists(select 1 from public.clued_audit_receipts where id=registration.review_receipt_id and status='committed')
      or exists(select 1 from clued_private.storage_client_request_links_v2 l where l.request_id=client_admin.request_id) then
      raise exception 'storage_client_source_mismatch' using errcode='42501'; end if;
    insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id,
      source_metadata_digest,source_snapshot_sha256,source_evidence_id,source_snapshot)
      values(request_id,lineage,cap.registration_generation,metadata_digest,receipt.id,source_digest,source_hash,evrow.id,source);
    capability_id:=cap.id; cap_version:=cap.version;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',request_id),jsonb_build_object('kind','system','role','source','id',lineage),
      jsonb_build_object('kind','system','role','source','id',cap.id));
    versions:=jsonb_build_object(request_id::text,generation);
  end if;
  if source is not null and ((source->>'observed_at')::timestamptz<clock_timestamp()-interval '30 minutes'
    or (source->>'observed_at')::timestamptz>clock_timestamp()+interval '60 seconds') then
    raise exception 'storage_client_source_expired' using errcode='42501'; end if;
  summary:=jsonb_build_object('contract','clued.storage-client-qualification/2','action',op,
    'operator_role',current_user,'session_role',session_user,'storage_admin_version',actor.version,
    'global_technical_effect',op in ('register_snapshot','qualify','revoke'),
    'lineage_id',lineage,'registration_generation',generation,'capability_id',capability_id,
    'capability_version',case when capability_id is null then null else cap_version end,
    'request_metadata_digest',metadata_digest,'source_metadata_digest',source_digest,'source_snapshot_sha256',source_hash);
  select array_agg(distinct id order by id) into audit_evidence from unnest(array[evrow.id,source_ev.id]) id where id is not null;
  event_id:=clued_private.m1_append_event_row(actor.subject_id,null,receipt.id,receipt.canonical_version,
    'extension:storage:client_'||op,refs,'global',null,summary,p_input->>'idempotency_key',receipt.request_sha256,'success','audit_only',audit_evidence,'[]',null);
  result:=clued_private.m1_finish_receipt(receipt.id,'committed',refs,bases,versions,array[event_id],audit_evidence,null);
  perform clued_private.authorization_account_v12(actor.subject_id);
  if source is not null and ((source->>'observed_at')::timestamptz<clock_timestamp()-interval '30 minutes'
    or (source->>'observed_at')::timestamptz>clock_timestamp()+interval '60 seconds') then
    raise exception 'storage_client_source_expired' using errcode='42501'; end if;
  return result;
exception when others then
  -- A PostgreSQL constraint DETAIL can contain a whole private row (including
  -- issuer_hash). Roll back the whole function and expose ONLY closed errors.
  get stacked diagnostics failure=message_text,failure_state=returned_sqlstate;
  if failure in ('offline_database_operator_required','storage_admin_required','storage_admin_scope_denied','account_not_available',
    'storage_client_admin_input_invalid','storage_client_source_invalid','storage_client_source_mismatch',
    'storage_client_review_required','storage_client_qualification_conflict','storage_client_source_expired')
    and failure_state in ('22023','42501','40001') then
    raise exception '%',failure using errcode=failure_state;
  end if;
  raise exception 'storage_client_admin_failed' using errcode='42501';
end $$;
revoke all on function clued_private.storage_client_source_parse_v2(text),clued_private.storage_client_capability_admin_v2(jsonb)
  from public,anon,authenticated,service_role;

create or replace function clued_private.storage_policy_transition_admin_v2(p_input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor clued_private.storage_admin_v2; evidence public.clued_evidence; r public.clued_audit_receipts;
  m clued_private.storage_policy_transition_manifests_v2; doc jsonb; raw text; digest text; inventory jsonb;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1; ev text; refs jsonb; result jsonb;
  failure text; code text;
begin
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.storage_policy_transition_admin_v2(jsonb)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input-array['action','storage_admin_version','idempotency_key','evidence_id','evidence_sha256','manifest_json']<>'{}'
    or not(p_input ?& array['action','storage_admin_version','idempotency_key','evidence_id','evidence_sha256','manifest_json'])
    or p_input->>'action' is distinct from 'register' or jsonb_typeof(p_input->'manifest_json') is distinct from 'string'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or btrim(p_input->>'idempotency_key')<>p_input->>'idempotency_key'
    or jsonb_typeof(p_input->'storage_admin_version') is distinct from 'number'
    or p_input->>'storage_admin_version' !~ '^[1-9][0-9]{0,17}$' then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  raw:=p_input->>'manifest_json';
  if octet_length(convert_to(raw,'UTF8')) not between 2 and 1048576 then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  doc:=raw::jsonb;
  if jsonb_typeof(doc) is distinct from 'object' or
    doc-array['contract','owner_id','connection_id','source_decision_id','decision_version','disclosure_version','expires_at','expected_inventory_digest','history_preimages']<>'{}'
    or not(doc ?& array['contract','owner_id','connection_id','source_decision_id','decision_version','disclosure_version','expires_at','expected_inventory_digest','history_preimages'])
    or exists(select 1 from json_each(raw::json) group by key having count(*)>1)
    or doc->>'contract' is distinct from 'clued.storage-policy-transition/2'
    or doc->>'disclosure_version' is distinct from 'clued.storage-account-consent/2'
    or jsonb_typeof(doc->'decision_version') is distinct from 'number' or doc->>'decision_version' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(doc->'expires_at') is distinct from 'string'
    or jsonb_typeof(doc->'expected_inventory_digest') is distinct from 'string' or doc->>'expected_inventory_digest' !~ '^[0-9a-f]{64}$'
    or (doc->>'expires_at')::timestamptz<=clock_timestamp() or (doc->>'expires_at')::timestamptz>clock_timestamp()+interval '24 hours' then
    raise exception 'storage_transition_input_invalid' using errcode='22023'; end if;
  digest:=encode(extensions.digest(convert_to(raw,'UTF8'),'sha256'),'hex');
  if digest is distinct from p_input->>'evidence_sha256' then raise exception 'storage_transition_review_required' using errcode='42501'; end if;
  select * into actor from clued_private.storage_admin_v2 where singleton for share;
  if not found or actor.state<>'active' or actor.version is distinct from (p_input->>'storage_admin_version')::bigint then
    raise exception 'storage_admin_required' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(actor.subject_id);
  if doc->>'owner_id' is distinct from actor.subject_id::text then
    raise exception 'storage_admin_scope_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('storage-transition-admin:'||actor.subject_id::text||':'||(p_input->>'idempotency_key'),0));
  r:=clued_private.m1_begin_receipt(actor.subject_id,null,'storage_transition_manifest',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then return r.canonical_result; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('clued-evidence-withdrawal:'||actor.subject_id::text,0));
  select * into evidence from public.clued_evidence where id=(p_input->>'evidence_id')::uuid and user_id=actor.subject_id;
  if not found or evidence.content_hash is distinct from digest or evidence.mime_type is distinct from 'application/json'
    or evidence.evidence_type not in ('file','test_output') or evidence.size_bytes is distinct from octet_length(convert_to(raw,'UTF8'))::bigint
    or not exists(select 1 from public.clued_audit_receipts where id=evidence.receipt_id and user_id=actor.subject_id and status='committed')
    or exists(select 1 from clued_private.evidence_withdrawals where user_id=actor.subject_id and evidence_id=evidence.id) then
    raise exception 'storage_transition_review_required' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(doc->>'connection_id')::uuid and owner_id=(doc->>'owner_id')::uuid;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if p.id is null then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||p.root_folder_id,0));
  inventory:=clued_private.storage_policy_transition_inventory_v2(c.owner_id,c.id,doc->'history_preimages');
  if clued_private.m1_sha256(inventory) is distinct from doc->>'expected_inventory_digest'
    or inventory->'connection'->>'auth_mode' is distinct from 'legacy'
    or inventory->'connection'->>'state' is distinct from 'active' or inventory->>'scope_digest' is null then
    raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  perform 1 from public.clued_memories where id=(doc->>'source_decision_id')::uuid for share;
  if not exists(select 1 from public.clued_memories where id=(doc->>'source_decision_id')::uuid and version=(doc->>'decision_version')::bigint)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(doc->>'source_decision_id')::uuid) then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  insert into clued_private.storage_policy_transition_manifests_v2(owner_id,connection_id,root_folder_id,source_decision_id,decision_version,
    disclosure_version,manifest_sha256,manifest,inventory,inventory_digest,expires_at,evidence_id,registration_receipt_id)
    values(c.owner_id,c.id,p.root_folder_id,(doc->>'source_decision_id')::uuid,(doc->>'decision_version')::bigint,
      doc->>'disclosure_version',digest,doc,inventory,doc->>'expected_inventory_digest',(doc->>'expires_at')::timestamptz,evidence.id,r.id) returning * into m;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(actor.subject_id,null,r.id,r.canonical_version,'extension:storage:transition_manifest',refs,'global',null,
    jsonb_build_object('manifest_id',m.id,'manifest_sha256',digest,'inventory_digest',m.inventory_digest,'connection_id',m.connection_id,
      'storage_admin_version',actor.version,'operator_role',current_user,'activation',false),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only',array[evidence.id],'[]',null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}',jsonb_build_object(m.id::text,1),array[ev],array[evidence.id],null);
  perform clued_private.authorization_account_v12(actor.subject_id);
  if m.expires_at<=clock_timestamp() then raise exception 'storage_transition_conflict' using errcode='40001'; end if;
  return result;
exception when others then
  get stacked diagnostics failure=message_text,code=returned_sqlstate;
  if failure in ('offline_database_operator_required','storage_admin_required','storage_admin_scope_denied','account_not_available','storage_transition_input_invalid',
    'storage_transition_history_unproven','storage_transition_review_required','storage_transition_denied','storage_transition_conflict')
    and code in ('22023','42501','40001') then raise exception '%',failure using errcode=code; end if;
  raise exception 'storage_transition_denied' using errcode='42501';
end $$;
revoke all on function clued_private.storage_policy_transition_admin_v2(jsonb) from public,anon,authenticated,service_role;
