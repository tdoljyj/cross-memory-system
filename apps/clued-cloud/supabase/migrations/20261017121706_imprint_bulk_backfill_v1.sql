-- Skip only empty normalized sentence segments. All shared classification
-- rules, quote/context guards and output semantics remain unchanged.
create or replace function clued_private.imprint_auto_domains_v1(p_content text)
returns text[] language plpgsql immutable parallel safe set search_path='' as $$
declare rules jsonb:=clued_private.imprint_auto_rules_v1(); line text; segment text; piece text;
  pattern text; purpose text; captures text[]; rule jsonb; domains text[]:='{}';
  external_block boolean:=false; code_fence text; fence text; excluded boolean;
begin
  -- Abstain rather than truncate long sources or add latency to their write.
  if p_content is null or char_length(p_content)>65536 then return domains; end if;
  foreach line in array string_to_array(p_content,E'\n') loop
    fence:=substring(line from '^\s*(`{3,}|~{3,})');
    if fence is not null then
      if code_fence is null then code_fence:=fence;
      elsif left(fence,1)=left(code_fence,1) and length(fence)>=length(code_fence)
        and btrim(substr(btrim(line),length(fence)+1))='' then code_fence:=null;
      end if;
      continue;
    end if;
    if code_fence is not null or line ~ '`' then continue; end if;
    if btrim(line)='' then external_block:=false; continue; end if;
    if line ~* '^\s*(以下(是|为))?(客户(请求|要求|说|原话|邮件|消息)|对方(说|要求)|文章(说|内容)|原文|引用|转述|摘录|示例|例子|quoted text|client request|article says|example)\s*[:：]'
      then external_block:=true; end if;
    excluded:=external_block or line ~ '^\s*>';
    for pattern in select jsonb_array_elements_text(rules->'reported') loop
      if line ~* pattern then
        excluded:=true;
        if line ~ '[:：]\s*$' then external_block:=true; end if;
      end if;
    end loop;
    for pattern in select jsonb_array_elements_text(rules->'uncertain') loop
      excluded:=excluded or line ~* pattern;
    end loop;
    -- Automatic adoption is deliberately stricter than the optional suggestions:
    -- a quote anywhere in a line abstains, including unfinished multiline quotes.
    if line ~ '[“”‘’「」『』"'']' then return '{}'::text[]; end if;
    if excluded then continue; end if;
    foreach segment in array regexp_split_to_array(line,'[。！？.!?；;]') loop
      segment:=btrim(regexp_replace(segment,'^\s*([-*]\s+|[0-9]+[.)]\s+)?',''));
      if segment='' then continue; end if;
      for rule in select value from jsonb_array_elements(rules->'activities') loop
        if line ~* (rules->>'activity_context_block') then exit; end if;
        if rule->>'domain'<>'learning' and line ~* (rules->>'activity_material_block') then continue; end if;
        for pattern in select jsonb_array_elements_text(rule->'patterns') loop
          if segment ~* pattern then domains:=array_append(domains,rule->>'domain'); exit; end if;
        end loop;
      end loop;
      purpose:=null;
      for pattern in select jsonb_array_elements_text(rules->'purposes') loop
        captures:=regexp_match(segment,pattern,'i');
        if captures is not null then purpose:=captures[1]; exit; end if;
      end loop;
      if purpose is null or purpose ~* '(不用|不用于|不为了|not for|not to)' then continue; end if;
      foreach piece in array regexp_split_to_array(purpose,'([、，,；;]|以及|并用于|也用于|同时用于|\s+and\s+|\s+also\s+)','i') loop
        piece:=regexp_replace(btrim(piece),'^(用于|为了|for)\s*','','i');
        for rule in select value from jsonb_array_elements(rules->'domains') loop
          for pattern in select jsonb_array_elements_text(rule->'patterns') loop
            if piece ~* pattern then domains:=array_append(domains,rule->>'domain'); exit; end if;
          end loop;
        end loop;
      end loop;
    end loop;
  end loop;
  return array(select distinct domain from unnest(domains) domain order by domain);
end $$;

-- A single, bounded first organization batch. No second source-content store.
create table clued_private.imprint_bulk_batches_v1 (
  user_id uuid primary key references auth.users(id),
  id uuid not null unique default extensions.gen_random_uuid(),
  selection jsonb not null,
  preview_digest text not null,
  rules_version text not null,
  version bigint not null default 1 check(version>0),
  state text not null default 'running' check(state in ('running','completed','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table clued_private.imprint_bulk_items_v1 (
  batch_id uuid not null references clued_private.imprint_bulk_batches_v1(id),
  ordinal integer not null check(ordinal between 1 and 100),
  record_id uuid not null references public.clued_memories(id),
  record_version bigint not null check(record_version>0),
  domains text[] not null,
  state text not null default 'pending' check(state in ('pending','applied','conflict','undone','undo_conflict')),
  organization_version bigint, receipt_id uuid references public.clued_audit_receipts(id),
  undo_receipt_id uuid references public.clued_audit_receipts(id), error_code text,
  primary key(batch_id,record_id), unique(batch_id,ordinal)
);
alter table clued_private.imprint_bulk_batches_v1 enable row level security;
alter table clued_private.imprint_bulk_items_v1 enable row level security;
revoke all on clued_private.imprint_bulk_batches_v1,clued_private.imprint_bulk_items_v1 from public,anon,authenticated,service_role;

-- Stateless read-chain authentication, never a credential exposed to clients.
-- A proof grants no access: every endpoint still requires the actual Native owner.
create table clued_private.imprint_bulk_proof_key_v1 (
  singleton boolean primary key default true check(singleton), secret bytea not null check(octet_length(secret)=32)
);
insert into clued_private.imprint_bulk_proof_key_v1(secret) values(extensions.gen_random_bytes(32));
alter table clued_private.imprint_bulk_proof_key_v1 enable row level security;
revoke all on clued_private.imprint_bulk_proof_key_v1 from public,anon,authenticated,service_role;
create function clued_private.imprint_bulk_seal_v1(p_payload jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('payload',p_payload,'mac',encode(extensions.hmac(convert_to(p_payload::text,'UTF8'),secret,'sha256'),'hex'))
    from clued_private.imprint_bulk_proof_key_v1 where singleton
$$;
create function clued_private.imprint_bulk_unseal_v1(p_owner uuid,p_proof jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare payload jsonb:=p_proof->'payload'; expected jsonb;
begin
  if jsonb_typeof(p_proof) is distinct from 'object' or jsonb_typeof(payload) is distinct from 'object'
    or pg_column_size(p_proof)>65536 or jsonb_typeof(p_proof->'mac') is distinct from 'string'
    or coalesce(p_proof->>'mac','') !~ '^[0-9a-f]{64}$' then raise exception 'bulk_proof_invalid' using errcode='22023'; end if;
  expected:=clued_private.imprint_bulk_seal_v1(payload);
  if expected is null or expected->>'mac' is distinct from p_proof->>'mac' or payload->>'owner_id' is distinct from p_owner::text then
    raise exception 'bulk_proof_invalid' using errcode='42501'; end if;
  if (payload->>'expires_at')::timestamptz<=statement_timestamp() then raise exception 'bulk_proof_expired' using errcode='40001'; end if;
  return payload;
end $$;

-- Empty sentence segments cannot match any existing purpose/activity rule.
-- Avoid thousands of pointless rule loops for separator-only legacy bodies;
-- all other content goes unchanged through the original shared classifier.
create function clued_private.imprint_bulk_domains_v1(p_content text)
returns text[] language sql immutable parallel safe set search_path='' as $$
  select case when p_content ~ '^[[:space:]。！？.!?；;]*$' then '{}'::text[]
    else clued_private.imprint_auto_domains_v1(p_content) end
$$;

-- An organizational suggestion is never a grant or a formal Task/Decision.
create function clued_private.imprint_bulk_qualified_v1(p_owner uuid,m public.clued_memories)
returns boolean language sql stable security definer set search_path='' as $$
  select m.user_id=p_owner and m.record_schema_version=1 and m.lifecycle_status='active'
    and m.record_type in ('note','state','task','decision') and m.authority is distinct from 'imported'
    and coalesce(m.type_fields->>'source_kind','')<>'external_material'
    and clued_private.imprint_record_scope_v1(m)<>'profile'
    and (clued_private.imprint_record_scope_v1(m)='global' and m.project_id is null or
      clued_private.imprint_record_scope_v1(m)='project:'||m.project_id::text and exists(
        select 1 from public.clued_projects p where p.id=m.project_id and p.user_id=p_owner
          and p.progress_status in ('not_started','active','paused') and p.dismissed_at is null
          and p.merged_into_project_id is null and clued_private.project_is_recognized_v2(p_owner,p.id)))
    and clued_private.imprint_record_currentness_v1(p_owner,m,clued_private.imprint_owner_scopes_v1(p_owner))='CURRENT'
$$;

create function clued_private.imprint_bulk_selection_v1(p_owner uuid,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s text:=coalesce(p_input->>'scope','all'); space clued_private.development_spaces_v14%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','context_id'))
    or (p_input ? 'scope' and jsonb_typeof(p_input->'scope') is distinct from 'string')
    or (s<>'all' and not s=any(clued_private.imprint_owner_scopes_v1(p_owner)))
    or (p_input ? 'context_id' and (jsonb_typeof(p_input->'context_id') is distinct from 'string'
      or coalesce(p_input->>'context_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')) then
    raise exception 'bulk_selection_invalid' using errcode='22023'; end if;
  if p_input ? 'context_id' then
    space:=clued_private.imprint_development_space_v1(p_owner,(p_input->>'context_id')::uuid);
    if s not in ('all','project:'||space.project_id::text) then
      raise exception 'bulk_selection_invalid' using errcode='22023'; end if;
    return jsonb_build_object('scope','project:'||space.project_id::text,'context_id',space.id,'environment',space.environment,'context_version',space.version);
  end if;
  return jsonb_build_object('scope',s);
end $$;

-- Inventory metadata is complete. Expensive original-content classification is
-- bounded to ONE source per read. Every page carries the same inventory fence;
-- the client must finish all pages before claiming complete classification.
create function clued_private.imprint_bulk_preview_v1(p_owner uuid,p_selection jsonb,p_cursor integer default 0,p_classify boolean default true)
returns jsonb language sql stable security definer set search_path='' as $$
  with assessed as materialized (
    select m.id,m.version,m.title,char_length(m.content) characters,
      clued_private.imprint_record_scope_v1(m) scope,
      clued_private.imprint_record_currentness_v1(p_owner,m,clued_private.imprint_owner_scopes_v1(p_owner)) currentness,
      coalesce(o.version,0) organization_version,o.auto_rules_version,
      encode(extensions.digest(convert_to(m.content,'UTF8'),'sha256'),'hex') body_sha256,
      (select p.version from public.clued_projects p where p.id=m.project_id and p.user_id=p_owner) project_version,m.content,
      coalesce(clued_private.imprint_bulk_qualified_v1(p_owner,m),false) qualified,o.record_id is not null protected
    from public.clued_memories m left join clued_private.imprint_organization_v1 o on o.user_id=p_owner and o.record_id=m.id
    where m.user_id=p_owner and clued_private.imprint_record_scope_v1(m)=any(clued_private.imprint_owner_scopes_v1(p_owner))
      and (p_selection->>'scope'='all' or clued_private.imprint_record_scope_v1(m)=p_selection->>'scope')
  ), classified as materialized (
    select id,version,title,characters,clued_private.imprint_bulk_domains_v1(content) domains
      from (select * from assessed where qualified and not protected order by id offset p_cursor
        limit case when p_classify then 1 else 0 end) target
  ), summary as (
    select jsonb_build_object('total',count(*),'characters',coalesce(sum(characters),0),
      'ineligible',count(*) filter(where not qualified),'protected',count(*) filter(where qualified and protected),
      'classifiable',count(*) filter(where qualified and not protected),
      'personal',count(*) filter(where scope='global'),'profile',count(*) filter(where scope='profile'),
      'project',count(*) filter(where scope like 'project:%'),
      'current',count(*) filter(where currentness='CURRENT'),'history',count(*) filter(where currentness='HISTORY'),
      'other_currentness',count(*) filter(where currentness is null or currentness not in ('CURRENT','HISTORY')),
      'automatic_marked',count(*) filter(where protected and auto_rules_version is not null),
      'manual_or_unspecified_marked',count(*) filter(where protected and auto_rules_version is null),
      'unmarked',count(*) filter(where not protected)) counts,
      clued_private.m1_sha256(jsonb_build_object('selection',p_selection,'rules',clued_private.imprint_auto_rules_v1(),
        'inventory',coalesce(jsonb_agg(jsonb_build_array(id,version,body_sha256,scope,currentness,qualified,
          project_version,organization_version,auto_rules_version) order by id),'[]'::jsonb))) digest
      from assessed
  ), page_result as (
    select coalesce(jsonb_agg(jsonb_build_object('record_id',id,'record_version',version,'title',left(title,120),
      'domains',to_jsonb(domains)) order by id) filter(where cardinality(domains)>0),'[]'::jsonb) items,
      coalesce(jsonb_agg(jsonb_build_object('record_id',id,'title',left(title,120))) filter(where cardinality(domains)=0),'[]'::jsonb) review_sample,
      count(*) scanned,coalesce(sum(characters) filter(where cardinality(domains)>0),0) ready_characters,
      coalesce(sum(characters) filter(where cardinality(domains)=0),0) review_characters from classified
  ) select jsonb_build_object('status','ok','selection',p_selection,'rules_version',clued_private.imprint_auto_rules_v1()->>'version',
    'inventory_counts',counts,'items',items,'review_sample',review_sample,'max_batch_size',100,'authoritative',false,'digest',digest,
    'ready_characters',ready_characters,'review_characters',review_characters,
    'page',jsonb_build_object('cursor',p_cursor,'scanned',scanned,
      'next_cursor',case when p_cursor+scanned<(counts->>'classifiable')::bigint then p_cursor+scanned end,
      'complete',p_cursor+scanned>=(counts->>'classifiable')::bigint)) from summary cross join page_result
$$;

create function public.clued_imprint_bulk_preview_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); selection jsonb; result jsonb; cursor_at integer:=0;
  chain jsonb; picked jsonb; v jsonb;
begin
  if pg_column_size(p_input)>131072 then raise exception 'bulk_selection_invalid' using errcode='22023'; end if;
  selection:=clued_private.imprint_bulk_selection_v1(owner_id,p_input-'proof');
  if p_input ? 'proof' then
    chain:=clued_private.imprint_bulk_unseal_v1(owner_id,p_input->'proof');
    if chain->'selection' is distinct from selection then raise exception 'bulk_preview_changed' using errcode='40001'; end if;
    cursor_at:=(chain->>'cursor')::integer;
    if cursor_at>=(chain->>'classifiable')::integer then raise exception 'bulk_preview_already_complete' using errcode='22023'; end if;
  end if;
  result:=clued_private.imprint_bulk_preview_v1(owner_id,selection,cursor_at);
  if chain is not null and (result->>'digest' is distinct from chain->>'digest'
    or result->>'rules_version' is distinct from chain->>'rules_version'
    or result->'inventory_counts'->'classifiable' is distinct from chain->'classifiable') then
    raise exception 'bulk_preview_changed' using errcode='40001'; end if;
  chain:=coalesce(chain,jsonb_build_object('owner_id',owner_id,'selection',selection,'digest',result->>'digest',
    'rules_version',result->>'rules_version','classifiable',result->'inventory_counts'->'classifiable',
    'expires_at',statement_timestamp()+interval '2 hours','cursor',0,'ready',0,'needs_review',0,
    'ready_characters',0,'review_characters',0,'items','[]'::jsonb));
  picked:=chain->'items';
  for v in select value from jsonb_array_elements(result->'items') loop
    if jsonb_array_length(picked)<100 then picked:=picked||jsonb_build_array(v-'title'); end if;
  end loop;
  chain:=chain||jsonb_build_object('cursor',cursor_at+(result->'page'->>'scanned')::integer,
    'ready',(chain->>'ready')::bigint+jsonb_array_length(result->'items'),
    'needs_review',(chain->>'needs_review')::bigint+jsonb_array_length(result->'review_sample'),
    'ready_characters',(chain->>'ready_characters')::bigint+(result->>'ready_characters')::bigint,
    'review_characters',(chain->>'review_characters')::bigint+(result->>'review_characters')::bigint,'items',picked);
  return result||jsonb_build_object('proof',clued_private.imprint_bulk_seal_v1(chain));
end $$;

create function clued_private.imprint_bulk_status_v1(p_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('available',true,'batch_id',b.id,'version',b.version,
    'state',b.state,'selection',b.selection,'rules_version',b.rules_version,'preview_digest',b.preview_digest,
    'items',coalesce((select jsonb_agg(to_jsonb(i)-'batch_id' order by i.ordinal)
      from clued_private.imprint_bulk_items_v1 i where i.batch_id=b.id),'[]'::jsonb))
    from clued_private.imprint_bulk_batches_v1 b where b.user_id=p_owner),jsonb_build_object('available',false))
$$;
create function public.clued_imprint_bulk_status_v1()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12();
begin return clued_private.imprint_bulk_status_v1(owner_id)||jsonb_build_object('status','ok'); end $$;

create function public.clued_imprint_bulk_mutate_v1(p_input jsonb,p_received_payload_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=clued_private.authorization_owner_v12(); action text:=p_input->>'action';
  b clued_private.imprint_bulk_batches_v1%rowtype; item clued_private.imprint_bulk_items_v1%rowtype;
  m public.clued_memories%rowtype; org clued_private.imprint_organization_v1%rowtype;
  receipt public.clued_audit_receipts%rowtype; preview jsonb; selection jsonb; data jsonb; outcome jsonb;
  result jsonb; event_id text; refs jsonb; err text; code text; undoing boolean:=action='undo'; chain jsonb; picked jsonb;
  space clued_private.development_spaces_v14%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in
      ('action','selection','digest','proof','items','batch_id','base_version','idempotency_key'))
    or coalesce(action,'') not in ('begin','advance','cancel','undo')
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or char_length(p_input->>'idempotency_key') not between 8 and 160
    or coalesce(p_received_payload_hash,'') !~ '^[0-9a-f]{64}$'
    or pg_column_size(p_input)>131072
    or (action='begin' and (coalesce(p_input->>'digest','') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(p_input->'items') is distinct from 'array' or jsonb_typeof(p_input->'proof') is distinct from 'object'
      or p_input ? 'batch_id' or p_input ? 'base_version'))
    or (action<>'begin' and (p_input ? 'selection' or p_input ? 'digest' or p_input ? 'items' or p_input ? 'proof'
      or jsonb_typeof(p_input->'batch_id') is distinct from 'string'
      or coalesce(p_input->>'batch_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or jsonb_typeof(p_input->'base_version') is distinct from 'number'
      or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]{0,15}$')) then
    raise exception 'bulk_input_invalid' using errcode='22023'; end if;
  perform clued_private.authorization_writer_guard_v2(owner_id);
  perform clued_private.currentness_user_lock(owner_id);
  select * into b from clued_private.imprint_bulk_batches_v1 where user_id=owner_id for update;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text||':imprint_bulk:'||btrim(p_input->>'idempotency_key'),0));
  receipt:=clued_private.m1_begin_receipt(owner_id,null,'imprint_bulk',p_input,p_received_payload_hash);
  if receipt.status<>'pending' then
    return coalesce(receipt.canonical_result,clued_private.m1_result_envelope(receipt))
      ||jsonb_build_object('supplemental',jsonb_build_object('batch',clued_private.imprint_bulk_status_v1(owner_id)),'replayed',true);
  end if;
  begin
    if action='begin' then
      if b.id is not null then raise exception 'bulk_first_batch_already_exists' using errcode='40001'; end if;
      selection:=clued_private.imprint_bulk_selection_v1(owner_id,p_input->'selection');
      chain:=clued_private.imprint_bulk_unseal_v1(owner_id,p_input->'proof');
      if chain->'selection' is distinct from selection or chain->>'digest' is distinct from p_input->>'digest'
        or (chain->>'cursor')::bigint<>(chain->>'classifiable')::bigint
        or (chain->>'ready')::bigint+(chain->>'needs_review')::bigint<>(chain->>'classifiable')::bigint then
        raise exception 'bulk_preview_incomplete' using errcode='40001'; end if;
      -- The bounded proposal is untrusted input. Begin fences identities and
      -- versions only; every execution recomputes the original server classifier.
      preview:=clued_private.imprint_bulk_preview_v1(owner_id,selection,0,false);
      if preview->>'digest' is distinct from p_input->>'digest' then raise exception 'bulk_preview_changed' using errcode='40001'; end if;
      if jsonb_array_length(p_input->'items') not between 1 and 100 then raise exception 'bulk_items_invalid' using errcode='22023'; end if;
      if exists(select 1 from jsonb_array_elements(p_input->'items') x(v) where jsonb_typeof(v) is distinct from 'object'
        or exists(select 1 from jsonb_object_keys(v) k where k not in ('record_id','record_version','domains','title'))
        or jsonb_typeof(v->'record_id') is distinct from 'string'
        or coalesce(v->>'record_id','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        or jsonb_typeof(v->'record_version') is distinct from 'number' or coalesce(v->>'record_version','') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(v->'domains') is distinct from 'array'
        or (v ? 'title' and (jsonb_typeof(v->'title') is distinct from 'string' or char_length(v->>'title')>120)))
        or (select count(distinct v->>'record_id') from jsonb_array_elements(p_input->'items') x(v))<>jsonb_array_length(p_input->'items') then
        raise exception 'bulk_items_invalid' using errcode='22023'; end if;
      for data in select value from jsonb_array_elements(p_input->'items') loop
        if cardinality(clued_private.imprint_domains_v1(data->'domains'))=0 then raise exception 'bulk_items_invalid' using errcode='22023'; end if;
        select * into m from public.clued_memories where id=(data->>'record_id')::uuid and user_id=owner_id;
        if not found or m.version<>(data->>'record_version')::bigint or not coalesce(clued_private.imprint_bulk_qualified_v1(owner_id,m),false)
          or (selection->>'scope'<>'all' and clued_private.imprint_record_scope_v1(m)<>selection->>'scope')
          or exists(select 1 from clued_private.imprint_organization_v1 where user_id=owner_id and record_id=m.id) then
          raise exception 'bulk_preview_changed' using errcode='40001'; end if;
      end loop;
      select jsonb_agg(v-'title' order by n) into picked from jsonb_array_elements(p_input->'items') with ordinality x(v,n);
      if picked is distinct from chain->'items' then raise exception 'bulk_proposal_mismatch' using errcode='40001'; end if;
      insert into clued_private.imprint_bulk_batches_v1(user_id,selection,preview_digest,rules_version)
        values(owner_id,selection,preview->>'digest',preview->>'rules_version') returning * into b;
      insert into clued_private.imprint_bulk_items_v1(batch_id,ordinal,record_id,record_version,domains)
        select b.id,n::integer,(v->>'record_id')::uuid,(v->>'record_version')::bigint,
          clued_private.imprint_domains_v1(v->'domains') from jsonb_array_elements(p_input->'items') with ordinality x(v,n);
    else
      if b.id is null or b.id is distinct from (p_input->>'batch_id')::uuid then raise exception 'bulk_batch_unavailable' using errcode='42501'; end if;
      if b.version<>(p_input->>'base_version')::bigint then raise exception 'bulk_version_conflict' using errcode='40001'; end if;
      if action='cancel' then
        update clued_private.imprint_bulk_batches_v1 set state='cancelled',version=version+1,updated_at=now() where user_id=owner_id returning * into b;
      else
        if action='advance' and b.state<>'running' then raise exception 'bulk_not_running' using errcode='40001'; end if;
        if undoing and b.state='running' then raise exception 'bulk_stop_before_undo' using errcode='40001'; end if;
        -- Recheck the exact Context and its stored environment on every step.
        if b.selection ? 'context_id' then
          space:=clued_private.imprint_development_space_v1(owner_id,(b.selection->>'context_id')::uuid,b.selection->>'environment');
          if 'project:'||space.project_id::text is distinct from b.selection->>'scope' then
            raise exception 'bulk_source_ineligible' using errcode='42501'; end if;
        end if;
        select * into item from clued_private.imprint_bulk_items_v1 where batch_id=b.id
          and state=case when undoing then 'applied' else 'pending' end order by ordinal limit 1 for update;
        if item.record_id is null then raise exception 'bulk_no_pending_items' using errcode='40001'; end if;
        -- Preserve the reused writer's child-key -> source -> organization
        -- order even if an ordinary Native request uses this exact child key.
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text||':imprint_organization:'||
          'bulk:'||b.id::text||':'||item.record_id::text||':'||action,0));
        begin
          select * into m from public.clued_memories where id=item.record_id and user_id=owner_id for update;
          if not found then raise exception 'bulk_source_unavailable' using errcode='42501'; end if;
          if m.project_id is not null then perform 1 from public.clued_projects where id=m.project_id and user_id=owner_id for share; end if;
          if not coalesce(clued_private.imprint_bulk_qualified_v1(owner_id,m),false)
            or (b.selection->>'scope'<>'all' and clued_private.imprint_record_scope_v1(m)<>b.selection->>'scope') then
            raise exception 'bulk_source_ineligible' using errcode='42501'; end if;
          if m.version<>item.record_version then raise exception 'record_version_conflict' using errcode='40001'; end if;
          select * into org from clued_private.imprint_organization_v1 where user_id=owner_id and record_id=item.record_id for update;
          if (not undoing and org.record_id is not null) or (undoing and (org.version is distinct from item.organization_version
            or org.receipt_id is distinct from item.receipt_id)) then raise exception 'organization_version_conflict' using errcode='40001'; end if;
          if not undoing and (cardinality(item.domains)=0 or b.rules_version is distinct from clued_private.imprint_auto_rules_v1()->>'version'
            or item.domains is distinct from clued_private.imprint_auto_domains_v1(m.content)) then
            raise exception 'bulk_rules_changed' using errcode='40001'; end if;
          data:=jsonb_build_object('record_id',item.record_id,'record_version',item.record_version,
            'base_version',coalesce(org.version,0),'domains',case when undoing then '[]'::jsonb else to_jsonb(item.domains) end,
            'idempotency_key','bulk:'||b.id::text||':'||item.record_id::text||':'||action);
          outcome:=public.clued_imprint_organization_set_v1(data,clued_private.m1_sha256(data));
          if outcome->>'status'='committed' then
            update clued_private.imprint_bulk_items_v1 set state=case when undoing then 'undone' else 'applied' end,
              organization_version=(outcome->'supplemental'->'organization'->>'version')::bigint,
              receipt_id=case when undoing then receipt_id else (outcome->>'receipt_id')::uuid end,
              undo_receipt_id=case when undoing then (outcome->>'receipt_id')::uuid else null end,error_code=null
              where batch_id=b.id and record_id=item.record_id;
          else
            update clued_private.imprint_bulk_items_v1 set state=case when undoing then 'undo_conflict' else 'conflict' end,
              error_code=coalesce(outcome->>'error_code','organization_save_failed') where batch_id=b.id and record_id=item.record_id;
          end if;
        exception when others then
          get stacked diagnostics err=message_text,code=returned_sqlstate;
          if code not in ('22023','40001','42501','P0002') then raise; end if;
          update clued_private.imprint_bulk_items_v1 set state=case when undoing then 'undo_conflict' else 'conflict' end,
            error_code=err where batch_id=b.id and record_id=item.record_id;
        end;
        update clued_private.imprint_bulk_batches_v1 set version=version+1,updated_at=now(),
          state=case when not undoing and not exists(select 1 from clued_private.imprint_bulk_items_v1 where batch_id=b.id and state='pending')
            then 'completed' else state end where user_id=owner_id returning * into b;
      end if;
    end if;
    refs:=jsonb_build_array(jsonb_build_object('role','primary','kind','system','id','imprint_bulk:'||b.id::text));
    event_id:=clued_private.m1_append_event_row(owner_id,null,receipt.id,receipt.canonical_version,
      'extension:imprint:bulk_progress',refs,'global',null,jsonb_build_object('batch_id',b.id,'version',b.version,'action',action),
      'imprint-bulk:'||receipt.id::text,receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    result:=clued_private.m1_finish_receipt(receipt.id,'committed',refs,'{}'::jsonb,
      jsonb_build_object('imprint_bulk:'||b.id::text,b.version),array[event_id],'{}'::uuid[],null);
    return result||jsonb_build_object('supplemental',jsonb_build_object('batch',clued_private.imprint_bulk_status_v1(owner_id)),'replayed',false);
  exception when others then
    get stacked diagnostics err=message_text,code=returned_sqlstate;
    return clued_private.m1_finish_receipt(receipt.id,case when code in ('22023','40001','42501','P0002') then 'rejected' else 'failed' end,
      '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::text[],'{}'::uuid[],err);
  end;
end $$;

revoke all on function clued_private.imprint_bulk_qualified_v1(uuid,public.clued_memories),
  clued_private.imprint_bulk_seal_v1(jsonb),clued_private.imprint_bulk_unseal_v1(uuid,jsonb),
  clued_private.imprint_bulk_domains_v1(text),
  clued_private.imprint_bulk_selection_v1(uuid,jsonb),clued_private.imprint_bulk_preview_v1(uuid,jsonb,integer,boolean),
  clued_private.imprint_bulk_status_v1(uuid),public.clued_imprint_bulk_preview_v1(jsonb),
  public.clued_imprint_bulk_status_v1(),public.clued_imprint_bulk_mutate_v1(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.clued_imprint_bulk_preview_v1(jsonb),public.clued_imprint_bulk_status_v1(),
  public.clued_imprint_bulk_mutate_v1(jsonb,text) to authenticated;
do $gateway_acl$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='clued_worker_gateway') then
    revoke all on clued_private.imprint_bulk_batches_v1,clued_private.imprint_bulk_items_v1 from clued_worker_gateway;
    revoke all on clued_private.imprint_bulk_proof_key_v1 from clued_worker_gateway;
    revoke all on function clued_private.imprint_bulk_qualified_v1(uuid,public.clued_memories),
      clued_private.imprint_bulk_seal_v1(jsonb),clued_private.imprint_bulk_unseal_v1(uuid,jsonb),
      clued_private.imprint_bulk_domains_v1(text),
      clued_private.imprint_bulk_selection_v1(uuid,jsonb),clued_private.imprint_bulk_preview_v1(uuid,jsonb,integer,boolean),
      clued_private.imprint_bulk_status_v1(uuid),public.clued_imprint_bulk_preview_v1(jsonb),
      public.clued_imprint_bulk_status_v1(),public.clued_imprint_bulk_mutate_v1(jsonb,text) from clued_worker_gateway;
  end if;
end $gateway_acl$;
notify pgrst,'reload schema';
