-- Offline reviewed qualification only. No public/native/issuer RPC, role grant,
-- registry seed, account policy activation, OAuth grant or provider request.
-- The deployment operator submits a reviewed, secret-free source document.
-- This is NOT an automatic DCR identity/generation or live metadata attestation.
-- Evidence is a point-in-time qualification audit, not live storage authority.
-- Withdrawal prevents subsequent register/qualify/link use of that evidence;
-- it does not revoke an already active capability. Explicit platform revoke
-- ends that qualification; account deny/disconnect remain independent guards.
alter table clued_private.storage_client_registrations_v2
  add column source_metadata_digest text check(source_metadata_digest ~ '^[0-9a-f]{64}$'),
  add column source_snapshot_sha256 text check(source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  add column source_evidence_id uuid references public.clued_evidence(id),
  add column source_request_id uuid references clued_private.authorization_requests_v12(id),
  add column source_snapshot jsonb;
-- One exact authorization request can establish only one registration fact.
-- A successor generation requires a NEW reviewed request, never reuse of a
-- previous request under another idempotency key or another lineage.
create unique index storage_client_registration_source_request_v2
  on clued_private.storage_client_registrations_v2(source_request_id) where source_request_id is not null;
alter table clued_private.storage_client_request_links_v2
  add column source_metadata_digest text check(source_metadata_digest ~ '^[0-9a-f]{64}$'),
  add column source_snapshot_sha256 text check(source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  add column source_evidence_id uuid references public.clued_evidence(id),
  add column source_snapshot jsonb;

-- Parse only after hashing the ORIGINAL UTF-8 text, including any final LF.
-- ClientInfo.clientSecret (even when already hashed) is never accepted.
create function clued_private.storage_client_source_parse_v2(p_text text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare s jsonb; c jsonb; j json; k text; v jsonb;
begin
  if p_text is null or octet_length(convert_to(p_text,'UTF8')) not between 2 and 65536 then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  begin s:=p_text::jsonb; j:=p_text::json;
  exception when others then raise exception 'storage_client_source_invalid' using errcode='22023'; end;
  if jsonb_typeof(s) is distinct from 'object' or
    (s-array['contract','source','request_id','request_digest','resource','observed_at','release_sha','client'])<>'{}'::jsonb
    or not(s ?& array['contract','source','request_id','request_digest','resource','observed_at','release_sha','client'])
    or s->>'contract' is distinct from 'clued.storage-client-source-snapshot/1'
    or s->>'source' is distinct from 'cloudflare-oauth-provider'
    or jsonb_typeof(s->'client') is distinct from 'object' then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  if (select count(*)<>count(distinct key) from json_each(j))
    or (select count(*)<>count(distinct key) from json_each(j->'client')) then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  foreach k in array array['contract','source','request_id','request_digest','resource','observed_at','release_sha'] loop
    if jsonb_typeof(s->k) is distinct from 'string' then raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  end loop;
  if s->>'request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or s->>'request_digest' !~ '^[0-9a-f]{64}$' or s->>'release_sha' !~ '^[0-9a-f]{40}$'
    or length(s->>'resource') not between 9 and 4096 or s->>'resource' !~ '^https://'
    or s->>'observed_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  begin perform (s->>'observed_at')::timestamptz;
  exception when others then raise exception 'storage_client_source_invalid' using errcode='22023'; end;
  c:=s->'client';
  if (c-array['clientId','clientName','redirectUris','grantTypes','responseTypes','tokenEndpointAuthMethod','registrationDate',
      'logoUri','clientUri','policyUri','tosUri','jwksUri','i18n','contacts','authMethodExplicit'])<>'{}'::jsonb
    or not(c ?& array['clientId','redirectUris','grantTypes','responseTypes','tokenEndpointAuthMethod','registrationDate']) then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  foreach k in array array['clientId','clientName','tokenEndpointAuthMethod','logoUri','clientUri','policyUri','tosUri','jwksUri'] loop
    if c ? k and (jsonb_typeof(c->k) is distinct from 'string' or length(c->>k) not between 1 and 4096) then
      raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  end loop;
  if c->>'tokenEndpointAuthMethod' not in ('none','client_secret_basic','client_secret_post')
    or jsonb_typeof(c->'registrationDate') is distinct from 'number'
    or (c->>'registrationDate')::numeric not between 0 and 9007199254740991
    or trunc((c->>'registrationDate')::numeric)<>(c->>'registrationDate')::numeric
    or (c ? 'authMethodExplicit' and jsonb_typeof(c->'authMethodExplicit') is distinct from 'boolean') then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  foreach k in array array['redirectUris','grantTypes','responseTypes','contacts'] loop
    if c ? k then
      if jsonb_typeof(c->k) is distinct from 'array' then raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
      if jsonb_array_length(c->k)>64 or (k<>'contacts' and jsonb_array_length(c->k)=0)
        or exists(select 1 from jsonb_array_elements(c->k) e where jsonb_typeof(e)<>'string' or length(e#>>'{}') not between 1 and 4096)
        or (select count(*)<>count(distinct e) from jsonb_array_elements(c->k) e) then
        raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
    end if;
  end loop;
  if not(c->'grantTypes' ? 'authorization_code') or not(c->'responseTypes' ? 'code') then
    raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
  if c ? 'i18n' then
    if jsonb_typeof(c->'i18n') is distinct from 'object' then raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
    if (select count(*)>64 or count(*)<>count(distinct key) from json_each(j->'client'->'i18n')) then
      raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
    for k,v in select * from jsonb_each(c->'i18n') loop
      if k !~ '^(client_name|client_uri|logo_uri|tos_uri|policy_uri)#[A-Za-z0-9-]{1,64}$'
        or jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 4096 then
        raise exception 'storage_client_source_invalid' using errcode='22023'; end if;
    end loop;
  end if;
  return s;
end $$;

create function clued_private.storage_client_capability_admin_v2(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
<<client_admin>>
declare actor clued_private.platform_admin_v13; op text; allowed text[];
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
  allowed:=array['action','idempotency_key','platform_admin_version','evidence_id','evidence_sha256'];
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
    or jsonb_typeof(p_input->'platform_admin_version') is distinct from 'number'
    or p_input->>'platform_admin_version' !~ '^[1-9][0-9]{0,17}$'
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
  select * into actor from clued_private.platform_admin_v13 where singleton for share;
  if not found or actor.version is distinct from (p_input->>'platform_admin_version')::bigint then
    raise exception 'storage_platform_admin_required' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(actor.subject_id);
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
  -- including an older source review's owner after platform-admin succession.
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
        or registration.client_id is distinct from request_row.client_id then
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
    'operator_role',current_user,'session_role',session_user,'platform_admin_version',actor.version,
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
  if failure in ('offline_database_operator_required','storage_platform_admin_required','account_not_available',
    'storage_client_admin_input_invalid','storage_client_source_invalid','storage_client_source_mismatch',
    'storage_client_review_required','storage_client_qualification_conflict','storage_client_source_expired')
    and failure_state in ('22023','42501','40001') then
    raise exception '%',failure using errcode=failure_state;
  end if;
  raise exception 'storage_client_admin_failed' using errcode='42501';
end $$;
revoke all on function clued_private.storage_client_source_parse_v2(text),clued_private.storage_client_capability_admin_v2(jsonb)
  from public,anon,authenticated,service_role;
