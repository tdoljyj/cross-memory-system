-- Step4: exact source-bound extraction into the existing Information Flow S3.
-- Only selected Task/Decision quotes become candidates; original records never change.
create table clued_private.imprint_extractions_v1 (
  user_id uuid not null references auth.users(id),
  identity_hash text not null check(identity_hash ~ '^[0-9a-f]{64}$'),
  source jsonb not null check(jsonb_typeof(source)='object'),
  candidate_id uuid not null unique references clued_private.information_candidates(id),
  intake_receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key(user_id,identity_hash)
);
alter table clued_private.imprint_extractions_v1 enable row level security;
revoke all on clued_private.imprint_extractions_v1 from public,anon,authenticated,service_role;

create function clued_private.imprint_extraction_immutable_v1() returns trigger
language plpgsql set search_path='' as $$ begin
  raise exception 'imprint_extraction_immutable' using errcode='42501';
end $$;
create trigger imprint_extractions_immutable before update or delete on clued_private.imprint_extractions_v1
  for each row execute function clued_private.imprint_extraction_immutable_v1();

-- Caller holds owner guard -> currentness. Read/lock the same source slot on
-- prepare, S3 issue and S3 consume. Offsets are Unicode code points, zero based.
create function clued_private.imprint_extraction_source_v1(p_owner uuid,p_source jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s public.clued_memories%rowtype; raw clued_private.development_records_v14%rowtype;
  space clued_private.development_spaces_v14%rowtype; cid uuid; sid uuid; body text; scope_key text;
  slot text:=p_source->>'slot'; start_at integer; end_at integer;
begin
  if jsonb_typeof(p_source) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_source) k where k not in
      ('source_kind','context_id','environment','record_id','record_version','slot','start','end','quote','text_hash','kind'))
    or coalesce(p_source->>'source_kind','') not in ('canonical','development')
    or coalesce(p_source->>'record_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_source->'record_version') is distinct from 'number'
    or coalesce(p_source->>'record_version','') !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_source->'start') is distinct from 'number' or coalesce(p_source->>'start','') !~ '^[0-9]{1,5}$'
    or jsonb_typeof(p_source->'end') is distinct from 'number' or coalesce(p_source->>'end','') !~ '^[0-9]{1,5}$'
    or not clued_private.intake_is_str_v1(p_source->'quote',1,300)
    or coalesce(p_source->>'text_hash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_source->>'kind','') not in ('task','decision')
    or (p_source ? 'context_id' and (jsonb_typeof(p_source->'context_id') is distinct from 'string'
      or (p_source->>'context_id') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'))
    or (p_source ? 'environment' and (not(p_source ? 'context_id') or jsonb_typeof(p_source->'environment') is distinct from 'string')) then
    raise exception 'extraction_source_invalid' using errcode='22023';
  end if;
  sid:=(p_source->>'record_id')::uuid; cid:=(p_source->>'context_id')::uuid;
  if cid is not null then space:=clued_private.imprint_development_space_v1(p_owner,cid,p_source->>'environment'); end if;
  if p_source->>'source_kind'='development' then
    if cid is null or slot is null or slot not in ('content','text') then
      raise exception 'extraction_source_invalid' using errcode='22023'; end if;
    select * into raw from clued_private.development_records_v14 r where r.id=sid and r.context_id=cid for update;
    if not found or raw.lifecycle_status is distinct from 'ACTIVE' or raw.valid_until<clock_timestamp() then
      raise exception 'extraction_source_unavailable' using errcode='42501'; end if;
    if raw.version<>(p_source->>'record_version')::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
    -- Explicit text slots only: no serialized JSON metadata is interpreted.
    if jsonb_typeof(raw.body->slot) is distinct from 'string' then raise exception 'extraction_text_unavailable' using errcode='42501'; end if;
    body:=raw.body->>slot; scope_key:='project:'||space.project_id::text;
  else
    if slot is distinct from 'content' then raise exception 'extraction_source_invalid' using errcode='22023'; end if;
    select * into s from public.clued_memories m where m.id=sid and m.user_id=p_owner
      and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(p_owner)) for update;
    if not found or (cid is not null and s.project_id is distinct from space.project_id)
      or s.record_schema_version is distinct from 1 or s.lifecycle_status is distinct from 'active'
      or clued_private.imprint_record_currentness_v1(p_owner,s,clued_private.imprint_owner_scopes_v1(p_owner)) is distinct from 'CURRENT' then
      raise exception 'extraction_source_unavailable' using errcode='42501'; end if;
    if s.version<>(p_source->>'record_version')::bigint then raise exception 'record_version_conflict' using errcode='40001'; end if;
    body:=s.content; scope_key:=clued_private.imprint_record_scope_v1(s);
  end if;
  start_at:=(p_source->>'start')::integer; end_at:=(p_source->>'end')::integer;
  if body is null or char_length(body) not between 1 and 20000 or start_at>=end_at or end_at>char_length(body)
    or substring(body from start_at+1 for end_at-start_at) is distinct from p_source->>'quote'
    or encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex')<>p_source->>'text_hash' then
    raise exception 'extraction_quote_mismatch' using errcode='40001'; end if;
  return jsonb_build_object('text',body,'scope',scope_key);
end $$;

create function clued_private.imprint_extraction_candidate_guard_v1(p_owner uuid,p_tier text,p_candidate uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare s jsonb; checked jsonb; scope_key text; begin
  if p_tier='information' then
    select x.source,c.scope into s,scope_key from clued_private.imprint_extractions_v1 x
      join clued_private.information_candidates c on c.id=x.candidate_id and c.user_id=x.user_id
      where x.user_id=p_owner and x.candidate_id=p_candidate;
    if found then
      checked:=clued_private.imprint_extraction_source_v1(p_owner,s);
      if checked->>'scope' is distinct from scope_key then raise exception 'extraction_scope_changed' using errcode='40001'; end if;
    end if;
  end if;
end $$;

create function clued_private.imprint_extraction_result_v1(p_owner uuid,p_candidate uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('candidate_id',c.id,'candidate_version',c.version,'candidate_status',c.status,
    'scope',c.scope,'kind',c.payload->>'item_type','intake_receipt_id',x.intake_receipt_id,
    'record_id',p.record_id,'record_version',p.record_version,'promotion_receipt_id',p.promotion_receipt_id,
    'authoritative',false)
  from clued_private.imprint_extractions_v1 x join clued_private.information_candidates c on c.id=x.candidate_id and c.user_id=x.user_id
  left join clued_private.candidate_promotions p on p.user_id=x.user_id and p.candidate_tier='information' and p.candidate_id=c.id
  where x.user_id=p_owner and c.id=p_candidate
$$;

create function public.clued_imprint_extraction_prepare_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); source jsonb:=p_input->'source'; checked jsonb;
  receipt public.clued_audit_receipts%rowtype; identity_key text; cid uuid; intake jsonb; result jsonb; stamp text;
  info jsonb; message text; state text; refs jsonb;
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('source','owner_text_confirmed','idempotency_key','request_hash'))
    or p_input->'owner_text_confirmed' is distinct from 'true'::jsonb then
    raise exception 'extraction_owner_confirmation_required' using errcode='22023'; end if;
  perform clued_private.authorization_writer_guard_v2(owner_id);
  perform clued_private.currentness_user_lock(owner_id);
  checked:=clued_private.imprint_extraction_source_v1(owner_id,source);
  -- Canonical views share one source identity across both directories. Raw
  -- records remain isolated by their exact Context. Every prepare still checks
  -- its supplied Context; S3 retains the first immutable source constraints.
  identity_key:=clued_private.m1_sha256(jsonb_build_object('source_kind',source->>'source_kind',
    'context_id',case when source->>'source_kind'='development' then (source->>'context_id')::uuid end,
    'record_id',(source->>'record_id')::uuid,
    'scope',checked->>'scope','record_version',(source->>'record_version')::bigint,
    'slot',source->>'slot','start',(source->>'start')::integer,'end',(source->>'end')::integer,
    'text_hash',source->>'text_hash','quote',source->>'quote','kind',source->>'kind'));
  receipt:=clued_private.m1_begin_receipt(owner_id,null,'imprint_extraction_prepare',p_input,p_received_payload_hash);
  if receipt.status<>'pending' then
    result:=coalesce(receipt.canonical_result,clued_private.m1_result_envelope(receipt));
    cid:=(receipt.metadata->>'extraction_candidate')::uuid;
    return result||jsonb_build_object('replayed',receipt.related_receipt_id is null)
      ||case when cid is not null then jsonb_build_object('supplemental',clued_private.imprint_extraction_result_v1(owner_id,cid)) else '{}'::jsonb end;
  end if;
  begin
    select x.candidate_id into cid from clued_private.imprint_extractions_v1 x where x.user_id=owner_id and x.identity_hash=identity_key;
    if cid is null then
      stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      intake:=jsonb_build_object('idempotency_key','imprint-extraction:'||receipt.id::text,'scope',checked->>'scope',
        'client_label','Imprint mixed-content extraction',
        'segment',jsonb_build_object('schema_version','segment_input.v1','segment_id',identity_key,'reference_time',stamp,'timezone','Asia/Shanghai',
          'messages',jsonb_build_array(jsonb_build_object('message_id','msg_source','evidence_id','ev_source','author_role','user',
            'created_at',stamp,'context_only',false,'content',checked->>'text'))),
        'candidates',jsonb_build_object('schema_version','candidate_information.v1','segment_id',identity_key,
          'items',jsonb_build_array(jsonb_build_object('candidate_local_id','item_extract','item_type',source->>'kind',
            'claim',source->>'quote','summary',left(source->>'quote',120),
            'action_level',case when source->>'kind'='task' then 'needs_action' else 'reference' end,
            'priority',null,'entity_mentions','[]'::jsonb,'topics','[]'::jsonb,'temporal_mentions','[]'::jsonb,
            'source_anchors',jsonb_build_array(jsonb_build_object('message_id','msg_source','exact_quote',source->>'quote')),
            'confidence',1,'uncertainties','[]'::jsonb,'sensitivity_hint','none'))));
      result:=clued_private.intake_submit_core_v1(owner_id,null,intake,clued_private.m1_sha256(intake));
      if result->>'status' is distinct from 'committed' then raise exception 'extraction_intake_failed:%',coalesce(result->>'error_code','unknown') using errcode='22023'; end if;
      cid:=(result->'supplemental'->'candidates'->0->>'id')::uuid;
      if cid is null then raise exception 'extraction_candidate_missing'; end if;
      insert into clued_private.imprint_extractions_v1 values(owner_id,identity_key,source,cid,(result->>'receipt_id')::uuid);
    end if;
    update public.clued_audit_receipts set metadata=metadata||jsonb_build_object('extraction_candidate',cid) where id=receipt.id and status='pending';
    refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id','information_candidate:'||cid::text));
    result:=clued_private.m1_finish_receipt(receipt.id,'committed',refs,'{}','{}','{}','{}',null);
    return result||jsonb_build_object('replayed',false,'supplemental',clued_private.imprint_extraction_result_v1(owner_id,cid));
  exception when others then
    get stacked diagnostics message=message_text,state=returned_sqlstate;
    return clued_private.m1_finish_receipt(receipt.id,case when state in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      '[]','{}','{}','{}','{}',message);
  end;
end $$;

-- Minimal terminal recovery is independent of the original source version.
-- The Native owner already owns this candidate/Receipt; do not return source
-- text, titles, confirmation tokens or somebody else's mapping. This reader
-- cannot issue a token, relax the source guard or initiate any write.
create function public.clued_imprint_extraction_status_v1(p_input jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); result jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or not clued_private.intake_keys_exact_v1(p_input,'["candidate_id"]')
    or coalesce(p_input->>'candidate_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    raise exception 'extraction_status_invalid' using errcode='22023'; end if;
  result:=clued_private.imprint_extraction_result_v1(owner_id,(p_input->>'candidate_id')::uuid);
  if result is null then raise exception 'extraction_candidate_unavailable' using errcode='42501'; end if;
  return jsonb_build_object('status','ok','extraction',result);
end $$;

-- Preserve S3's generic routes, fresh session, single-use token, receipt and
-- marker logic. Patch exactly once inside their existing exception handlers:
-- malformed promotion still reaches the prelookup/burn logic added by F01.
do $migration$
declare f text; body text; anchor text:=$a$    v_candidate:=clued_private.candidate_lock_v1(p_user_id,v_tier,v_id);$a$;
begin
  foreach f in array array['clued_private.candidate_confirmation_issue_core_v1(uuid,jsonb)',
    'clued_private.candidate_promote_core_v1(uuid,jsonb,text)'] loop
    body:=pg_get_functiondef(f::regprocedure);
    if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 or strpos(body,'imprint_extraction_candidate_guard_v1')>0 then
      raise exception 'extraction_s3_definition_mismatch:%',f; end if;
    execute replace(body,anchor,
      '    perform clued_private.imprint_extraction_candidate_guard_v1(p_user_id,v_tier,v_id);'||chr(10)||anchor);
  end loop;
  -- Acquire owner before existing currentness, receipt, source and candidate
  -- locks. No early result/validation is added outside the S3 token handler.
  foreach f in array array['public.clued_candidate_confirmation_issue_v1(jsonb)',
    'public.clued_candidate_promote_v1(jsonb,text)'] loop
    body:=pg_get_functiondef(f::regprocedure);
    anchor:='  perform clued_private.currentness_user_lock(v_owner);';
    if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'extraction_native_definition_mismatch:%',f; end if;
    execute replace(body,anchor,'  perform clued_private.authorization_writer_guard_v2(v_owner);'||chr(10)||anchor);
  end loop;
end $migration$;

revoke all on function clued_private.imprint_extraction_immutable_v1(),
  clued_private.imprint_extraction_source_v1(uuid,jsonb),clued_private.imprint_extraction_candidate_guard_v1(uuid,text,uuid),
  clued_private.imprint_extraction_result_v1(uuid,uuid),public.clued_imprint_extraction_prepare_v1(jsonb,text),
  public.clued_imprint_extraction_status_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_imprint_extraction_prepare_v1(jsonb,text),public.clued_imprint_extraction_status_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
