-- Information Flow M0-D slice S1: isolated Candidate store.
-- Contract: development/contracts/information-flow/M0DCloseout.v0.1.md (frozen,
-- Decision 825aa822-7cb2-4239-a3a1-0989200ef068), sections 4.2, 5.1 and 5.2.
--
-- Candidates live only in clued_private tables with RLS and no table grants.
-- They are never Canonical Records, so they cannot reach Currentness, MTPE,
-- Frontier, the five views, search or export. Submission reuses the M1
-- receipt core, evidence_ingest_core and m1_append_event_row; nothing here
-- forks M1 mutation logic. Promotion, knowledge proposals and transport
-- routes belong to later slices.

create table clued_private.information_intake_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope='profile' or scope='global' or scope ~ '^project:[0-9a-f-]{36}$'),
  source_kind text not null check (source_kind in ('native_ui','agent_binding')),
  -- Provenance is kept even if the Binding row is later deleted.
  binding_id uuid,
  client_label text check (client_label is null or char_length(client_label) between 1 and 120),
  segment jsonb not null,
  segment_sha256 text not null check (segment_sha256 ~ '^[0-9a-f]{64}$'),
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  evidence_id uuid not null,
  receipt_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  received_at timestamptz not null default now(),
  check ((source_kind='agent_binding')=(binding_id is not null)),
  unique (user_id, idempotency_key)
);

create table clued_private.information_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  submission_id uuid not null references clued_private.information_intake_submissions(id) on delete cascade,
  scope text not null check (scope='profile' or scope='global' or scope ~ '^project:[0-9a-f-]{36}$'),
  tier text not null default 'information' check (tier='information'),
  candidate_local_id text not null,
  payload jsonb not null,
  payload_schema text not null default 'candidate_information.v1' check (payload_schema='candidate_information.v1'),
  source_kind text not null check (source_kind in ('native_ui','agent_binding')),
  binding_id uuid,
  evidence_ids uuid[] not null check (cardinality(evidence_ids)>=1),
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending','promoted','rejected','conflict','withdrawn','expired')),
  version integer not null default 1 check (version>=1),
  promoted_record_id uuid,
  promoted_version integer,
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz not null default (now()+interval '30 days'),
  created_receipt_id uuid not null,
  last_receipt_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source_kind='agent_binding')=(binding_id is not null)),
  check ((status='promoted')=(promoted_record_id is not null and promoted_version is not null)),
  unique (submission_id, candidate_local_id)
);
create index information_candidates_owner_status
  on clued_private.information_candidates(user_id, status, created_at desc);

create table clued_private.knowledge_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope='profile' or scope='global' or scope ~ '^project:[0-9a-f-]{36}$'),
  tier text not null default 'knowledge' check (tier='knowledge'),
  rule_id text not null check (rule_id in
    ('knowledge.consolidate.v1','knowledge.dedup.v1','knowledge.cross_record_fact.v1')),
  assertion text not null check (char_length(assertion) between 1 and 2000),
  -- [{id, version}] exact source Record versions (contract 4.3.3).
  sources jsonb not null check (jsonb_typeof(sources)='array' and jsonb_array_length(sources)>=1),
  source_kind text not null check (source_kind in ('native_ui','agent_binding')),
  binding_id uuid,
  evidence_ids uuid[] not null default '{}',
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  status text not null default 'pending'
    check (status in ('pending','promoted','rejected','conflict','withdrawn','expired')),
  version integer not null default 1 check (version>=1),
  promoted_record_id uuid,
  promoted_version integer,
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz not null default (now()+interval '30 days'),
  created_receipt_id uuid not null,
  last_receipt_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source_kind='agent_binding')=(binding_id is not null)),
  check ((status='promoted')=(promoted_record_id is not null and promoted_version is not null)),
  unique (user_id, idempotency_key)
);

-- One row per status transition, each bound to the M1 Receipt that made it.
create table clued_private.candidate_transitions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_tier text not null check (candidate_tier in ('information','knowledge')),
  candidate_id uuid not null,
  from_status text,
  to_status text not null,
  from_version integer,
  to_version integer not null,
  actor text not null check (actor in ('native_ui','agent_binding')),
  binding_id uuid,
  receipt_id uuid not null,
  at timestamptz not null default now()
);
create index candidate_transitions_candidate
  on clued_private.candidate_transitions(candidate_tier, candidate_id, id);

alter table clued_private.information_intake_submissions enable row level security;
alter table clued_private.information_candidates enable row level security;
alter table clued_private.knowledge_candidates enable row level security;
alter table clued_private.candidate_transitions enable row level security;
revoke all on table clued_private.information_intake_submissions,
  clued_private.information_candidates, clued_private.knowledge_candidates,
  clued_private.candidate_transitions
  from public, anon, authenticated, service_role;
revoke all on sequence clued_private.candidate_transitions_id_seq
  from public, anon, authenticated, service_role;

-- Enum sets bound to the vendored M0-A schemas (checked by the DB test against
-- development/contracts/information-flow/vendored/m0a/*.schema.json).
create function clued_private.intake_schema_enums_v1()
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'item_type',jsonb_build_array('fact','preference','decision','task','status','event','artifact','issue','unclassified'),
    'action_level',jsonb_build_array('needs_action','needs_attention','reference'),
    'priority',jsonb_build_array('high','medium','low',null),
    'entity_type',jsonb_build_array('person','project','organization','place','artifact','account','product','other'),
    'entity_role',jsonb_build_array('subject','actor','owner','target','requester','recipient','participant','creator','context','other'),
    'temporal_kind',jsonb_build_array('observed_at','event_at','due_at','valid_from','valid_to'),
    'sensitivity_hint',jsonb_build_array('none','personal','sensitive','high'),
    'author_role',jsonb_build_array('user','assistant','tool','system'),
    'item_keys',jsonb_build_array('candidate_local_id','item_type','claim','summary','action_level','priority',
      'entity_mentions','topics','temporal_mentions','source_anchors','confidence','uncertainties','sensitivity_hint'),
    'message_keys',jsonb_build_array('message_id','evidence_id','author_role','created_at','context_only','content'),
    'segment_keys',jsonb_build_array('schema_version','segment_id','reference_time','timezone','messages'),
    'document_keys',jsonb_build_array('schema_version','segment_id','items'))
$$;

create function clued_private.intake_is_str_v1(p_value jsonb,p_min integer,p_max integer)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='string'
    and char_length(p_value#>>'{}') between p_min and p_max,false)
$$;

create function clued_private.intake_keys_exact_v1(p_value jsonb,p_keys jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='object'
    and (select count(*) from jsonb_object_keys(p_value))=jsonb_array_length(p_keys)
    and not exists(select 1 from jsonb_object_keys(p_value) k where not (p_keys ? k)),false)
$$;

create function clued_private.intake_is_datetime_v1(p_value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if not clued_private.intake_is_str_v1(p_value,1,64) or (p_value#>>'{}') !~*
    '^\d{4}-[01]\d-[0-3]\d[t ]([0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(\.\d+)?(z|[+-]\d\d(:?\d\d)?)$' then
    return false;
  end if;
  perform (p_value#>>'{}')::timestamptz;
  return true;
exception when others then return false;
end $$;

-- Mirrors the frozen M0-A contract validator: schema errors short-circuit
-- (INSTANCE_SCHEMA_INVALID), otherwise the M0-A semantic codes are returned.
create function clued_private.intake_validate_v1(p_segment jsonb,p_document jsonb)
returns text[] language plpgsql immutable set search_path='' as $$
declare e jsonb:=clued_private.intake_schema_enums_v1(); m jsonb; it jsonb; x jsonb;
  codes text[]:='{}'; ids text[]:='{}'; evs text[]:='{}'; locals text[]:='{}'; has_active boolean;
  msg jsonb;
begin
  -- Segment schema.
  if not clued_private.intake_keys_exact_v1(p_segment,e->'segment_keys')
    or p_segment->>'schema_version' is distinct from 'segment_input.v1'
    or jsonb_typeof(p_segment->'schema_version')<>'string'
    or not clued_private.intake_is_str_v1(p_segment->'segment_id',1,128)
    or not clued_private.intake_is_datetime_v1(p_segment->'reference_time')
    or not clued_private.intake_is_str_v1(p_segment->'timezone',1,128)
    or jsonb_typeof(p_segment->'messages')<>'array'
    or jsonb_array_length(p_segment->'messages') not between 1 and 64 then
    return array['INSTANCE_SCHEMA_INVALID'];
  end if;
  for m in select value from jsonb_array_elements(p_segment->'messages') loop
    if not clued_private.intake_keys_exact_v1(m,e->'message_keys')
      or not clued_private.intake_is_str_v1(m->'message_id',1,128)
      or not clued_private.intake_is_str_v1(m->'evidence_id',1,128)
      or jsonb_typeof(m->'author_role')<>'string' or not ((e->'author_role') ? (m->>'author_role'))
      or not clued_private.intake_is_datetime_v1(m->'created_at')
      or jsonb_typeof(m->'context_only')<>'boolean'
      or not clued_private.intake_is_str_v1(m->'content',1,20000) then
      return array['INSTANCE_SCHEMA_INVALID'];
    end if;
  end loop;
  -- Candidate document schema.
  if not clued_private.intake_keys_exact_v1(p_document,e->'document_keys')
    or jsonb_typeof(p_document->'schema_version')<>'string'
    or p_document->>'schema_version'<>'candidate_information.v1'
    or not clued_private.intake_is_str_v1(p_document->'segment_id',1,128)
    or jsonb_typeof(p_document->'items')<>'array'
    or jsonb_array_length(p_document->'items')>32 then
    return array['INSTANCE_SCHEMA_INVALID'];
  end if;
  for it in select value from jsonb_array_elements(p_document->'items') loop
    if not clued_private.intake_keys_exact_v1(it,e->'item_keys')
      or not clued_private.intake_is_str_v1(it->'candidate_local_id',1,128)
      or (it->>'candidate_local_id') !~ '^item_[A-Za-z0-9_-]+$'
      or jsonb_typeof(it->'item_type')<>'string' or not ((e->'item_type') ? (it->>'item_type'))
      or not clued_private.intake_is_str_v1(it->'claim',1,300)
      or not clued_private.intake_is_str_v1(it->'summary',1,120)
      or jsonb_typeof(it->'action_level')<>'string' or not ((e->'action_level') ? (it->>'action_level'))
      or not (jsonb_typeof(it->'priority')='null'
        or (jsonb_typeof(it->'priority')='string' and (e->'priority') ? (it->>'priority')))
      or (it->>'item_type'<>'task' and jsonb_typeof(it->'priority')<>'null')
      or jsonb_typeof(it->'entity_mentions')<>'array' or jsonb_array_length(it->'entity_mentions')>32
      or jsonb_typeof(it->'topics')<>'array' or jsonb_array_length(it->'topics')>16
      or jsonb_typeof(it->'temporal_mentions')<>'array' or jsonb_array_length(it->'temporal_mentions')>16
      or jsonb_typeof(it->'source_anchors')<>'array'
      or jsonb_array_length(it->'source_anchors') not between 1 and 16
      or (case when jsonb_typeof(it->'confidence')='number'
        then (it->>'confidence')::numeric not between 0 and 1 else true end)
      or jsonb_typeof(it->'uncertainties')<>'array' or jsonb_array_length(it->'uncertainties')>16
      or jsonb_typeof(it->'sensitivity_hint')<>'string'
      or not ((e->'sensitivity_hint') ? (it->>'sensitivity_hint')) then
      return array['INSTANCE_SCHEMA_INVALID'];
    end if;
    for x in select value from jsonb_array_elements(it->'entity_mentions') loop
      if not clued_private.intake_keys_exact_v1(x,'["type","mention","role"]')
        or jsonb_typeof(x->'type')<>'string' or not ((e->'entity_type') ? (x->>'type'))
        or not clued_private.intake_is_str_v1(x->'mention',1,160)
        or jsonb_typeof(x->'role')<>'string' or not ((e->'entity_role') ? (x->>'role')) then
        return array['INSTANCE_SCHEMA_INVALID'];
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(it->'topics') t(v)
        where not clued_private.intake_is_str_v1(v,1,80))
      or (select count(distinct v) from jsonb_array_elements(it->'topics') t(v))
        <>jsonb_array_length(it->'topics') then
      return array['INSTANCE_SCHEMA_INVALID'];
    end if;
    for x in select value from jsonb_array_elements(it->'temporal_mentions') loop
      if not clued_private.intake_keys_exact_v1(x,'["kind","source_text","source_message_id"]')
        or jsonb_typeof(x->'kind')<>'string' or not ((e->'temporal_kind') ? (x->>'kind'))
        or not clued_private.intake_is_str_v1(x->'source_text',1,160)
        or not clued_private.intake_is_str_v1(x->'source_message_id',1,128) then
        return array['INSTANCE_SCHEMA_INVALID'];
      end if;
    end loop;
    for x in select value from jsonb_array_elements(it->'source_anchors') loop
      if not clued_private.intake_keys_exact_v1(x,'["message_id","exact_quote"]')
        or not clued_private.intake_is_str_v1(x->'message_id',1,128)
        or not clued_private.intake_is_str_v1(x->'exact_quote',1,1000) then
        return array['INSTANCE_SCHEMA_INVALID'];
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(it->'uncertainties') u(v)
        where not clued_private.intake_is_str_v1(v,1,240)) then
      return array['INSTANCE_SCHEMA_INVALID'];
    end if;
  end loop;

  -- Semantics (M0-A validateSegmentSemantics / validateCandidateSemantics).
  for m in select value from jsonb_array_elements(p_segment->'messages') loop
    if (m->>'message_id')=any(ids) then codes:=array_append(codes,'DUPLICATE_MESSAGE_ID'); end if;
    if (m->>'evidence_id')=any(evs) then codes:=array_append(codes,'DUPLICATE_EVIDENCE_ID'); end if;
    ids:=ids||(m->>'message_id'); evs:=evs||(m->>'evidence_id');
  end loop;
  if p_document->>'segment_id'<>p_segment->>'segment_id' then
    codes:=array_append(codes,'CANDIDATE_SEGMENT_MISMATCH');
  end if;
  for it in select value from jsonb_array_elements(p_document->'items') loop
    if (it->>'candidate_local_id')=any(locals) then codes:=array_append(codes,'DUPLICATE_CANDIDATE_LOCAL_ID'); end if;
    locals:=locals||(it->>'candidate_local_id');
    has_active:=false;
    for x in select value from jsonb_array_elements(it->'source_anchors') loop
      select value into msg from jsonb_array_elements(p_segment->'messages')
        where value->>'message_id'=x->>'message_id' limit 1;
      if msg is null then codes:=array_append(codes,'SOURCE_MESSAGE_NOT_FOUND'); continue; end if;
      if strpos(msg->>'content',x->>'exact_quote')=0 then codes:=array_append(codes,'SOURCE_QUOTE_MISMATCH'); end if;
      if (msg->>'context_only')::boolean=false then has_active:=true; end if;
      msg:=null;
    end loop;
    if not has_active then codes:=array_append(codes,'NO_EXTRACTABLE_ANCHOR'); end if;
    for x in select value from jsonb_array_elements(it->'temporal_mentions') loop
      if not exists(select 1 from jsonb_array_elements(p_segment->'messages') mm
          where mm.value->>'message_id'=x->>'source_message_id') then
        codes:=array_append(codes,'TEMPORAL_SOURCE_NOT_FOUND');
      end if;
    end loop;
  end loop;
  return coalesce((select array_agg(distinct c order by c) from unnest(codes) c),'{}');
end $$;

-- Deterministic capture (OD-1b): the caller supplies the M0-A segment and an
-- explicit candidate document; no model runs here. The route, not the payload,
-- fixes tier, source_kind and binding (contract 4.3.5).
create function clued_private.intake_submit_core_v1(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_scope text:=p_input->>'scope';
  v_segment jsonb:=p_input->'segment'; v_document jsonb:=p_input->'candidates';
  v_codes text[]; v_segment_sha text; v_input_digest text; v_submission_id uuid:=gen_random_uuid();
  v_evidence jsonb; v_evidence_id uuid; v_kind text:=case when p_binding_id is null then 'native_ui' else 'agent_binding' end;
  v_item jsonb; v_candidate_id uuid; v_candidates jsonb:='[]'; v_event_id text; v_refs jsonb;
  v_result jsonb; v_error text; v_state text;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'intake_submit',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('idempotency_key','request_hash','scope','segment','candidates','client_label')) then
      raise exception 'intake_unknown_field' using errcode='22023';
    end if;
    if v_scope is null or not (v_scope in ('profile','global') or v_scope ~ '^project:[0-9a-f-]{36}$') then
      raise exception 'invalid_scope' using errcode='22023';
    end if;
    if v_scope like 'project:%' then
      -- Store the effective (merge-resolved) project, like M1 Record writes.
      v_scope:='project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope));
    end if;
    if p_input ? 'client_label' and not clued_private.intake_is_str_v1(p_input->'client_label',1,120) then
      raise exception 'invalid_client_label' using errcode='22023';
    end if;
    v_codes:=clued_private.intake_validate_v1(v_segment,v_document);
    if cardinality(v_codes)>0 then
      raise exception 'intake_invalid:%',array_to_string(v_codes,',') using errcode='22023';
    end if;
    if jsonb_array_length(v_document->'items')=0 then
      raise exception 'intake_no_candidates' using errcode='22023';
    end if;
    -- Server-computed digests (contract 4.3.1 / 5.1); caller hashes are ignored.
    v_segment_sha:=clued_private.m1_sha256(v_segment);
    v_input_digest:=clued_private.m1_sha256(jsonb_build_object('segment_sha256',v_segment_sha,'candidates',v_document));
    v_evidence:=clued_private.evidence_ingest_core(p_user_id,p_binding_id,jsonb_build_object(
      'idempotency_key','intake-evidence:'||v_receipt.id,'evidence_schema_version',1,'evidence_type','file',
      'storage_ref','intake:'||v_submission_id,'content_hash',v_segment_sha,
      'mime_type','application/vnd.clued.segment-input.v1+json',
      'size_bytes',octet_length(convert_to(v_segment::text,'UTF8'))),
      clued_private.m1_sha256(jsonb_build_object('operation','evidence_ingest','intake_receipt',v_receipt.id)));
    if v_evidence->>'status'<>'committed' then
      raise exception 'intake_evidence_%:%',v_evidence->>'status',coalesce(v_evidence->>'error_code','unknown')
        using errcode=case when v_evidence->>'status'='rejected' then '22023' else 'XX000' end;
    end if;
    v_evidence_id:=(v_evidence->'evidence_ids'->>0)::uuid;
    insert into clued_private.information_intake_submissions(
      id,user_id,scope,source_kind,binding_id,client_label,segment,segment_sha256,input_digest,
      evidence_id,receipt_id,idempotency_key)
    values(v_submission_id,p_user_id,v_scope,v_kind,p_binding_id,p_input->>'client_label',v_segment,v_segment_sha,
      v_input_digest,v_evidence_id,v_receipt.id,p_input->>'idempotency_key');
    for v_item in select value from jsonb_array_elements(v_document->'items') loop
      insert into clued_private.information_candidates(
        user_id,submission_id,scope,candidate_local_id,payload,source_kind,binding_id,evidence_ids,
        input_digest,created_receipt_id,last_receipt_id)
      values(p_user_id,v_submission_id,v_scope,v_item->>'candidate_local_id',v_item,v_kind,p_binding_id,
        array[v_evidence_id],clued_private.m1_sha256(jsonb_build_object('segment_sha256',v_segment_sha,'item',v_item)),
        v_receipt.id,v_receipt.id)
      returning id into v_candidate_id;
      insert into clued_private.candidate_transitions(
        user_id,candidate_tier,candidate_id,from_status,to_status,from_version,to_version,actor,binding_id,receipt_id)
      values(p_user_id,'information',v_candidate_id,null,'pending',null,1,v_kind,p_binding_id,v_receipt.id);
      v_candidates:=v_candidates||jsonb_build_object('id',v_candidate_id,
        'candidate_local_id',v_item->>'candidate_local_id','status','pending','version',1);
    end loop;
    v_refs:=jsonb_build_array(
      jsonb_build_object('role','primary','kind','system','id','information_intake:'||v_submission_id),
      jsonb_build_object('role','evidence','kind','evidence','id',v_evidence_id::text));
    -- Audit-only: stored as event_type='action' with the extension name in
    -- canonical_event_type, so no truth carrier and no State/Task shadow.
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:candidate_submitted',v_refs,v_scope,null,
      jsonb_build_object('submission_id',v_submission_id,'candidate_count',jsonb_array_length(v_candidates),
        'source_kind',v_kind,'input_digest',v_input_digest),
      'intake_submit:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only',array[v_evidence_id],'[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,'{}','{}',array[v_event_id],
      array[v_evidence_id],null);
    -- Supplemental data rides on the response only; the sealed Receipt result
    -- and its response_hash stay untouched (same pattern as evidence_ingest_core).
    return v_result||jsonb_build_object('replayed',false,'supplemental',jsonb_build_object(
      'submission_id',v_submission_id,'input_digest',v_input_digest,
      'segment_sha256',v_segment_sha,'candidates',v_candidates));
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','42501','P0002') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

-- A Binding sees only its own Binding's candidates; the Native owner sees all.
create function clued_private.intake_list_core_v1(p_user_id uuid,p_binding_id uuid,p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_status text:=p_input->>'status'; v_limit integer; v_scope text:=coalesce(p_input->>'scope','global');
  v_submission uuid;
begin
  if coalesce(p_input->>'limit','50') !~ '^[0-9]{1,3}$' then raise exception 'invalid_limit' using errcode='22023'; end if;
  v_limit:=coalesce(p_input->>'limit','50')::integer;
  if p_input ? 'submission_id' then
    if coalesce(p_input->>'submission_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_submission_id' using errcode='22023';
    end if;
    v_submission:=(p_input->>'submission_id')::uuid;
  end if;
  if v_scope like 'project:%' then
    v_scope:='project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(v_scope));
  end if;
  if v_status is not null and v_status not in ('pending','promoted','rejected','conflict','withdrawn','expired') then
    raise exception 'invalid_status' using errcode='22023';
  end if;
  if v_limit not between 1 and 200 then raise exception 'invalid_limit' using errcode='22023'; end if;
  return jsonb_build_object('status','ok','candidates',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',c.id,'submission_id',c.submission_id,'scope',c.scope,'tier',c.tier,'candidate_local_id',c.candidate_local_id,'payload',c.payload,
      'source_kind',c.source_kind,'status',c.status,'version',c.version,'evidence_ids',to_jsonb(c.evidence_ids),
      'input_digest',c.input_digest,'expires_at',c.expires_at,'created_at',c.created_at,
      -- Always explicit: a candidate is never current truth.
      'authority','none','authoritative',false) order by c.created_at desc,c.id)
    from (select * from clued_private.information_candidates c
      where c.user_id=p_user_id
        and (p_binding_id is null or c.binding_id=p_binding_id)
        and c.scope=v_scope
        and (v_submission is null or c.submission_id=v_submission)
        and (v_status is null or c.status=v_status)
      order by c.created_at desc,c.id limit v_limit) c),'[]'::jsonb));
end $$;

-- pending -> withdrawn by the submitter (own Binding) or the Native owner,
-- with row-version CAS and an M1 Receipt.
create function clued_private.intake_withdraw_core_v1(
  p_user_id uuid,p_binding_id uuid,p_input jsonb,p_received_payload_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts%rowtype; v_candidate clued_private.information_candidates%rowtype;
  v_id uuid; v_refs jsonb; v_event_id text; v_result jsonb; v_error text; v_state text;
  v_kind text:=case when p_binding_id is null then 'native_ui' else 'agent_binding' end;
begin
  v_receipt:=clued_private.m1_begin_receipt(p_user_id,p_binding_id,'intake_withdraw',p_input,p_received_payload_hash);
  if v_receipt.status<>'pending' then return coalesce(v_receipt.canonical_result,clued_private.m1_result_envelope(v_receipt))
    ||jsonb_build_object('replayed',v_receipt.related_receipt_id is null); end if;
  begin
    if coalesce(p_input->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'invalid_withdraw_input' using errcode='22023';
    end if;
    v_id:=(p_input->>'candidate_id')::uuid;
    select * into v_candidate from clued_private.information_candidates
      where id=v_id and user_id=p_user_id for update;
    if not found or (p_binding_id is not null and v_candidate.binding_id is distinct from p_binding_id)
      or v_candidate.scope is distinct from (case when coalesce(p_input->>'scope','global') like 'project:%'
        then 'project:'||clued_private.m1_effective_project(p_user_id,clued_private.m1_scope_project_id(p_input->>'scope'))
        else coalesce(p_input->>'scope','global') end) then
      raise exception 'candidate_not_found' using errcode='P0002';
    end if;
    if v_candidate.version<>(p_input->>'base_version')::integer then
      raise exception 'candidate_version_conflict' using errcode='40001';
    end if;
    if v_candidate.status<>'pending' then raise exception 'candidate_not_pending' using errcode='55000'; end if;
    update clued_private.information_candidates set status='withdrawn',version=version+1,
      decided_by=v_kind,decided_at=now(),last_receipt_id=v_receipt.id,updated_at=now()
      where id=v_id returning * into v_candidate;
    insert into clued_private.candidate_transitions(
      user_id,candidate_tier,candidate_id,from_status,to_status,from_version,to_version,actor,binding_id,receipt_id)
    values(p_user_id,'information',v_id,'pending','withdrawn',v_candidate.version-1,v_candidate.version,
      v_kind,p_binding_id,v_receipt.id);
    v_refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id','information_candidate:'||v_id));
    v_event_id:=clued_private.m1_append_event_row(p_user_id,p_binding_id,v_receipt.id,v_receipt.canonical_version,
      'extension:information_flow:candidate_withdrawn',v_refs,v_candidate.scope,null,
      jsonb_build_object('candidate_id',v_id,'version',v_candidate.version),
      'intake_withdraw:'||(p_input->>'idempotency_key'),v_receipt.request_sha256,'success','audit_only','{}','[]',null);
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,'committed',v_refs,
      jsonb_build_object(v_id::text,v_candidate.version-1),jsonb_build_object(v_id::text,v_candidate.version),
      array[v_event_id],'{}',null);
    return v_result||jsonb_build_object('replayed',false);
  exception when others then
    get stacked diagnostics v_error=message_text,v_state=returned_sqlstate;
    v_result:=clued_private.m1_finish_receipt(v_receipt.id,
      case when v_state in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',v_error);
    return v_result||jsonb_build_object('replayed',false);
  end;
end $$;

revoke all on function clued_private.intake_schema_enums_v1(),
  clued_private.intake_is_str_v1(jsonb,integer,integer),
  clued_private.intake_keys_exact_v1(jsonb,jsonb),
  clued_private.intake_is_datetime_v1(jsonb),
  clued_private.intake_validate_v1(jsonb,jsonb),
  clued_private.intake_submit_core_v1(uuid,uuid,jsonb,text),
  clued_private.intake_list_core_v1(uuid,uuid,jsonb),
  clued_private.intake_withdraw_core_v1(uuid,uuid,jsonb,text)
  from public,anon,authenticated,service_role;

-- Entry points. Binding entries follow clued_record_mutate (anon + token hash,
-- scope checked by resolve_binding); account entries follow
-- clued_user_record_mutate (authenticated, owner from authorization_owner_v12).
create function public.clued_intake_submit(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  return clued_private.intake_submit_core_v1(b.user_id,b.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','intake_submit','payload',p_input)));
end $$;
create function public.clued_intake_list(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));
  return clued_private.intake_list_core_v1(b.user_id,b.id,coalesce(p_input,'{}'::jsonb));
end $$;
create function public.clued_intake_withdraw(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:write',coalesce(p_input->>'scope','global'));
  return clued_private.intake_withdraw_core_v1(b.user_id,b.id,p_input,
    clued_private.m1_sha256(jsonb_build_object('operation','intake_withdraw','payload',p_input)));
end $$;
revoke all on function public.clued_intake_submit(text,jsonb),public.clued_intake_list(text,jsonb),
  public.clued_intake_withdraw(text,jsonb) from public,authenticated,service_role;
grant execute on function public.clued_intake_submit(text,jsonb),public.clued_intake_list(text,jsonb),
  public.clued_intake_withdraw(text,jsonb) to anon;

create function public.clued_user_intake_submit(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.intake_submit_core_v1(clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash)
$$;
create function public.clued_user_intake_list(p_input jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.intake_list_core_v1(clued_private.authorization_owner_v12(),null,coalesce(p_input,'{}'::jsonb))
$$;
create function public.clued_user_intake_withdraw(p_input jsonb,p_received_payload_hash text)
returns jsonb language sql security definer set search_path='' as $$
  select clued_private.intake_withdraw_core_v1(clued_private.authorization_owner_v12(),null,p_input,p_received_payload_hash)
$$;
revoke all on function public.clued_user_intake_submit(jsonb,text),public.clued_user_intake_list(jsonb),
  public.clued_user_intake_withdraw(jsonb,text) from public,anon,service_role;
grant execute on function public.clued_user_intake_submit(jsonb,text),public.clued_user_intake_list(jsonb),
  public.clued_user_intake_withdraw(jsonb,text) to authenticated;

notify pgrst,'reload schema';
