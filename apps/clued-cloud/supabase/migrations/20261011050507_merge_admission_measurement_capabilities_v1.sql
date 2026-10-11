-- Authenticated audit capability metadata. No new public RPC or permission.
-- Observation hashes are catalog metadata, not trusted source or clock qualification.
do $r9_capabilities$ begin
set local lock_timeout='3s';
set local statement_timeout='30s';

create function clued_private.merge_measurement_capabilities_v1(p_user uuid)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  s clued_private.merge_measurement_stream_v1%rowtype;
  v_observed_at timestamptz;
  v_current_digest text;
  v_stream_digest text;
  v_triggers jsonb;
  v_configuration_matches boolean;
begin
  if p_user is null then
    raise exception 'merge_measurement_capability_invalid_user' using errcode='22023';
  end if;
  begin
    v_observed_at:=pg_catalog.clock_timestamp();
    select * into s from clued_private.merge_measurement_stream_v1 where user_id=p_user;
    if pg_catalog.to_regprocedure('clued_private.merge_measurement_source_digest_v1()') is not null then
      v_current_digest:=clued_private.merge_measurement_source_digest_v1();
    end if;
    -- Even a private catalog producer or stored pin can have been replaced.
    -- Do not return arbitrary text, or hash it into an apparently valid pin.
    v_current_digest:=case when pg_catalog.length(v_current_digest)=64
      and v_current_digest ~ '^[0-9a-f]{64}$' then v_current_digest else null end;
    v_stream_digest:=case when pg_catalog.length(s.source_digest)=64
      and s.source_digest ~ '^[0-9a-f]{64}$' then s.source_digest else null end;
    -- Only fixed expected names and one-way hashes leave this helper. An unexpected
    -- function's arbitrary name, definition, arguments and payload never leave it.
    with expected(table_schema,table_name,trigger_name,function_signature,trigger_type) as (
      values
      ('clued_private','work_claims_v1','merge_measurement_claims_v1_capture',
       'clued_private.merge_measurement_claim_capture_v1()',29),
      ('clued_private','work_claim_merge_queue_v1','merge_measurement_markers_v1_capture',
       'clued_private.merge_measurement_marker_capture_v1()',29),
      ('public','clued_audit_receipts','merge_measurement_receipts_v1_capture',
       'clued_private.merge_measurement_receipt_capture_v1()',5)
    ), observed as (
      select e.*,t.oid trigger_oid,t.tgenabled,t.tgfoid,t.tgtype,
        pg_catalog.to_regprocedure(e.function_signature)::oid expected_function_oid
      from expected e
      left join pg_catalog.pg_namespace n on n.nspname=e.table_schema
      left join pg_catalog.pg_class c on c.relnamespace=n.oid and c.relname=e.table_name
      left join pg_catalog.pg_trigger t on t.tgrelid=c.oid and t.tgname=e.trigger_name and not t.tgisinternal
    )
    select jsonb_agg(jsonb_build_object(
        'table_schema',table_schema,'table_name',table_name,'trigger_name',trigger_name,
        'present',trigger_oid is not null,
        'enabled_mode',case when tgenabled in ('O','A','D','R') then tgenabled::text else null end,
        'captures_normal_writes',coalesce(tgenabled in ('O','A'),false),
        'trigger_type_matches',coalesce(tgtype=trigger_type,false),
        'expected_function',function_signature,
        'function_identity_matches',coalesce(tgfoid=expected_function_oid,false),
        'function_definition_sha256',case when trigger_oid is not null then
          pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(tgfoid),'UTF8'),'sha256'),'hex') else null end,
        'expected_identity_definition_sha256',case when expected_function_oid is not null then
          pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(expected_function_oid),'UTF8'),'sha256'),'hex') else null end
      ) order by trigger_name),
      coalesce(bool_and(coalesce(trigger_oid is not null and tgenabled in ('O','A')
        and tgtype=trigger_type and tgfoid=expected_function_oid,false)),false)
      into v_triggers,v_configuration_matches from observed;
    return jsonb_build_object(
      'schema','clued.measurement-capabilities/1',
      'status','CAPABILITY_METADATA_ONLY',
      'observed_at',v_observed_at,
      'clock',jsonb_build_object(
        'track_commit_timestamp_setting',pg_catalog.current_setting('track_commit_timestamp',true),
        'pg_xact_commit_timestamp_function_present',
          pg_catalog.to_regprocedure('pg_catalog.pg_xact_commit_timestamp(xid)') is not null,
        'observation_semantics','server observation; not a transaction commit timestamp',
        'commit_clock_qualified',false),
      'stream_status',case when s.user_id is null then 'NOT_MEASURED'
        when v_current_digest is null or v_stream_digest is null then 'SOURCE_UNKNOWN'
        when s.source_changed or v_stream_digest is distinct from v_current_digest then 'SOURCE_CHANGED'
        else 'PINS_OBSERVED' end,
      'stream',case when s.user_id is null then null else jsonb_build_object(
        'stream_id',s.stream_id,'started_at',s.started_at,
        'end_sequence',s.last_sequence::text,'last_observation_at',s.last_at,
        'source_digest',v_stream_digest,'source_changed',s.source_changed) end,
      'current_source_digest',v_current_digest,
      'capture_configuration_matches',v_configuration_matches,
      'capture_triggers',v_triggers,
      'function_hash_semantics','current catalog definitions; not independent trusted pins or historical continuity',
      'source_auth',false,'official_metric',false,'commit_clock_qualified',false,
      'qualified_reader',false,'authenticated_wrapper_implemented',false,
      'qualification','private catalog metadata; caller, commit retention and complete natural sources unestablished');
  exception when others then
    -- Keep unexpected local schema/runtime failures free of source SQL or data.
    raise exception 'merge_measurement_capability_unavailable' using errcode='55000';
  end;
end $$;

revoke all on function clued_private.merge_measurement_capabilities_v1(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.clued_mcp_audit_receipts(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_binding public.clued_agent_bindings%rowtype; v_checked public.clued_agent_bindings%rowtype;
  v_context_key text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,20),1),100);
  v_receipts jsonb; v_sessions jsonb; v_reminder boolean:=false; v_context text; v_page jsonb;
  v_measurement jsonb;
  v_first jsonb; v_header jsonb; v_final_header jsonb;
  v_contexts text[]; v_final_contexts text[];
  v_cap jsonb; v_clean_cap jsonb; v_first_cap jsonb; v_clean_triggers jsonb;
  v_entry jsonb; v_expected record; v_index integer; v_match_count integer;
  v_catalog_digest text; v_pin_digest text; v_fingerprint text;
begin
  v_binding:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context_key);
  if p_input ? 'measurement' then
    if jsonb_typeof(p_input->'measurement') is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('context_key','limit','measurement')) then
      raise exception 'merge_measurement_input_invalid' using errcode='22023'; end if;
    -- Existing core validates the caller's bounds and rejects a partial transaction.
    -- No caller-provided user is accepted: only resolve_binding supplies it.
    v_first:=clued_private.merge_measurement_page_v1(v_binding.user_id,p_input->'measurement');
    if v_first->>'status'='NOT_MEASURED' then
      -- Retain only the core's fixed legacy gap codes, never arbitrary text.
      return jsonb_build_object('status','NOT_MEASURED','reason',
        case when v_first->>'reason' in ('stream_not_started','sequence_gap')
          then v_first->>'reason' else 'measurement_not_available' end,'events','[]'::jsonb);
    end if;
    if v_first->>'status' is distinct from 'ok'
      or jsonb_typeof(v_first->'stream_id') is distinct from 'string'
      or coalesce(v_first->>'stream_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(v_first->'started_at') is distinct from 'string'
      or length(coalesce(v_first->>'started_at','')) not between 20 and 40
      or coalesce(v_first->>'started_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+$'
      or jsonb_typeof(v_first->'source_digest') is distinct from 'string'
      or length(coalesce(v_first->>'source_digest',''))<>64
      or coalesce(v_first->>'source_digest','') !~ '^[0-9a-f]{64}$'
      or coalesce(v_first->>'end_sequence','') !~ '^[0-9]{1,18}$' then
      return jsonb_build_object('status','NOT_MEASURED','reason','measurement_header_unknown','events','[]'::jsonb);
    end if;
    v_header:=jsonb_build_object('stream_id',v_first->'stream_id',
      'started_at',v_first->'started_at','source_digest',v_first->'source_digest',
      'end_sequence',v_first->'end_sequence');
    v_pin_digest:=v_first->>'source_digest';
    v_measurement:=(p_input->'measurement')||jsonb_build_object(
      'stream_id',v_first->>'stream_id','end_sequence',v_first->'end_sequence');
    select coalesce(array_agg(distinct e.context_key order by e.context_key),'{}'::text[])
      into v_contexts from clued_private.merge_measurement_events_v1 e
      where e.user_id=v_binding.user_id and e.sequence<=(v_first->>'end_sequence')::bigint;
    foreach v_context in array v_contexts loop
      begin
        v_checked:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context);
        if v_checked.user_id<>v_binding.user_id or v_checked.id<>v_binding.id then
          raise exception 'measurement_user_mismatch'; end if;
      exception when others then
        return jsonb_build_object('status','NOT_MEASURED','reason','measurement_scope_incomplete','events','[]'::jsonb);
      end;
    end loop;
    begin
      for v_index in 1..2 loop
        v_cap:=clued_private.merge_measurement_capabilities_v1(v_binding.user_id);
        -- Treat even helper output as typed input: return no arbitrary strings,
        -- stream/latest-tail identity, description or raw source from that object.
        v_catalog_digest:=v_cap->>'current_source_digest';
        if jsonb_typeof(v_cap) is distinct from 'object'
          or v_cap->>'schema' is distinct from 'clued.measurement-capabilities/1'
          or v_cap->>'status' is distinct from 'CAPABILITY_METADATA_ONLY'
          or jsonb_typeof(v_cap->'current_source_digest') is distinct from 'string'
          or length(coalesce(v_catalog_digest,''))<>64
          or coalesce(v_catalog_digest,'') !~ '^[0-9a-f]{64}$'
          or v_catalog_digest<>v_pin_digest
          or v_cap->'capture_configuration_matches' is distinct from 'true'::jsonb
          or jsonb_typeof(v_cap->'capture_triggers') is distinct from 'array'
          or jsonb_array_length(v_cap->'capture_triggers')<>3
          or jsonb_typeof(v_cap->'clock') is distinct from 'object'
          or coalesce(v_cap->'clock'->>'track_commit_timestamp_setting','') not in ('on','off')
          or jsonb_typeof(v_cap->'clock'->'pg_xact_commit_timestamp_function_present') is distinct from 'boolean'
          or v_cap->'clock'->'commit_clock_qualified' is distinct from 'false'::jsonb
          or v_cap->'source_auth' is distinct from 'false'::jsonb
          or v_cap->'official_metric' is distinct from 'false'::jsonb
          or v_cap->'commit_clock_qualified' is distinct from 'false'::jsonb
          or v_cap->'qualified_reader' is distinct from 'false'::jsonb
          or v_cap->'authenticated_wrapper_implemented' is distinct from 'false'::jsonb then
          return jsonb_build_object('status','NOT_MEASURED','reason','measurement_capability_unknown','events','[]'::jsonb);
        end if;
        v_clean_triggers:='[]'::jsonb;
        for v_expected in select * from (values
          ('clued_private','work_claims_v1','merge_measurement_claims_v1_capture','clued_private.merge_measurement_claim_capture_v1()'),
          ('clued_private','work_claim_merge_queue_v1','merge_measurement_markers_v1_capture','clued_private.merge_measurement_marker_capture_v1()'),
          ('public','clued_audit_receipts','merge_measurement_receipts_v1_capture','clued_private.merge_measurement_receipt_capture_v1()')
          ) expected(table_schema,table_name,trigger_name,function_signature) order by trigger_name loop
          select count(*)::integer into v_match_count from jsonb_array_elements(v_cap->'capture_triggers') x
            where x->>'trigger_name'=v_expected.trigger_name;
          if v_match_count<>1 then
            return jsonb_build_object('status','NOT_MEASURED','reason','measurement_capability_unknown','events','[]'::jsonb);
          end if;
          select x into v_entry from jsonb_array_elements(v_cap->'capture_triggers') x
            where x->>'trigger_name'=v_expected.trigger_name;
          if jsonb_typeof(v_entry) is distinct from 'object'
            or v_entry->>'table_schema' is distinct from v_expected.table_schema
            or v_entry->>'table_name' is distinct from v_expected.table_name
            or v_entry->>'expected_function' is distinct from v_expected.function_signature
            or v_entry->'present' is distinct from 'true'::jsonb
            or v_entry->'captures_normal_writes' is distinct from 'true'::jsonb
            or v_entry->'trigger_type_matches' is distinct from 'true'::jsonb
            or v_entry->'function_identity_matches' is distinct from 'true'::jsonb
            or coalesce(v_entry->>'enabled_mode','') not in ('O','A')
            or jsonb_typeof(v_entry->'function_definition_sha256') is distinct from 'string'
            or length(coalesce(v_entry->>'function_definition_sha256',''))<>64
            or coalesce(v_entry->>'function_definition_sha256','') !~ '^[0-9a-f]{64}$'
            or jsonb_typeof(v_entry->'expected_identity_definition_sha256') is distinct from 'string'
            or length(coalesce(v_entry->>'expected_identity_definition_sha256',''))<>64
            or coalesce(v_entry->>'expected_identity_definition_sha256','') !~ '^[0-9a-f]{64}$'
            or v_entry->>'function_definition_sha256' is distinct from v_entry->>'expected_identity_definition_sha256' then
            return jsonb_build_object('status','NOT_MEASURED','reason','measurement_capability_unknown','events','[]'::jsonb);
          end if;
          v_clean_triggers:=v_clean_triggers||jsonb_build_array(jsonb_build_object(
            'table_schema',v_expected.table_schema,'table_name',v_expected.table_name,
            'trigger_name',v_expected.trigger_name,'expected_function',v_expected.function_signature,
            'enabled_mode',v_entry->>'enabled_mode','present',true,'captures_normal_writes',true,
            'trigger_type_matches',true,'function_identity_matches',true,
            'function_definition_sha256',v_entry->>'function_definition_sha256',
            'expected_identity_definition_sha256',v_entry->>'expected_identity_definition_sha256'));
        end loop;
        v_clean_cap:=jsonb_build_object('schema','clued.authenticated-measurement-capabilities/1',
          'current_source_digest',v_catalog_digest,'capture_configuration_matches',true,
          'capture_triggers',v_clean_triggers,'clock',jsonb_build_object(
            'track_commit_timestamp_setting',v_cap->'clock'->>'track_commit_timestamp_setting',
            'pg_xact_commit_timestamp_function_present',v_cap->'clock'->'pg_xact_commit_timestamp_function_present',
            'commit_clock_qualified',false),
          'hash_semantics','current catalog metadata; no independent trusted source pin or continuous-DDL proof',
          'source_auth',false,'source_continuity',false,'commit_clock_qualified',false,'official_metric',false);
        if v_index=1 then
          v_first_cap:=v_clean_cap;
          -- Always re-read the SAME fixed header, never helper.stream or new tail.
          v_page:=clued_private.merge_measurement_page_v1(v_binding.user_id,v_measurement);
          v_final_header:=jsonb_build_object('stream_id',v_page->'stream_id',
            'started_at',v_page->'started_at','source_digest',v_page->'source_digest',
            'end_sequence',v_page->'end_sequence');
          if v_page->>'status' is distinct from 'ok' or v_final_header is distinct from v_header then
            return jsonb_build_object('status','NOT_MEASURED','reason','measurement_pins_changed','events','[]'::jsonb);
          end if;
        elsif v_clean_cap is distinct from v_first_cap then
          return jsonb_build_object('status','NOT_MEASURED','reason','measurement_capability_changed','events','[]'::jsonb);
        end if;
      end loop;
    exception when others then
      return jsonb_build_object('status','NOT_MEASURED','reason','measurement_capability_unavailable','events','[]'::jsonb);
    end;
    select coalesce(array_agg(distinct e.context_key order by e.context_key),'{}'::text[])
      into v_final_contexts from clued_private.merge_measurement_events_v1 e
      where e.user_id=v_binding.user_id and e.sequence<=(v_first->>'end_sequence')::bigint;
    if v_final_contexts is distinct from v_contexts then
      return jsonb_build_object('status','NOT_MEASURED','reason','measurement_contexts_changed','events','[]'::jsonb);
    end if;
    begin
      -- Recheck revocation, requested context and every original contributor
      -- AFTER the final page/capability reads, before returning any data.
      v_checked:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context_key);
      if v_checked.user_id<>v_binding.user_id or v_checked.id<>v_binding.id then
        raise exception 'measurement_user_mismatch'; end if;
      foreach v_context in array v_contexts loop
        v_checked:=clued_private.resolve_binding(p_token_hash,'audit:read',v_context);
        if v_checked.user_id<>v_binding.user_id or v_checked.id<>v_binding.id then
          raise exception 'measurement_user_mismatch'; end if;
      end loop;
    exception when others then
      return jsonb_build_object('status','NOT_MEASURED','reason','measurement_scope_incomplete','events','[]'::jsonb);
    end;
    v_fingerprint:=encode(extensions.digest(convert_to(v_first_cap::text,'UTF8'),'sha256'),'hex');
    return v_page||jsonb_build_object('capabilities',v_first_cap,
      'capability_fingerprint',v_fingerprint,'served_observed_at',clock_timestamp(),
      'qualification','authenticated fixed-watermark metadata; source continuity and clocks unqualified',
      'source_auth',false,'source_continuity',false,'commit_clock_qualified',false,
      'official_metric',false,'t0',null);
  end if;
  select coalesce(jsonb_agg(row_data order by created_at desc),'[]'::jsonb) into v_receipts from (
    select jsonb_build_object('id',r.id,'operation',r.operation,'object_type',r.object_type,'object_id',r.object_id,
      'version',r.version,'binding_id',r.binding_id,'metadata',r.metadata,'created_at',r.created_at) row_data,r.created_at
    from public.clued_audit_receipts r where r.user_id=v_binding.user_id and r.context_key=v_context_key
    order by r.created_at desc limit v_limit
  ) matches;
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id',s.id,'client_session_id',s.client_session_id,'started_at',s.started_at,'last_seen_at',s.last_seen_at,
    'expires_at',s.expires_at,'ended_at',s.ended_at,'append_count',x.append_count,'checkpoint_count',x.checkpoint_count,
    'state',case when x.checkpoint_count>0 then 'checkpointed' when x.append_count>0 and s.expires_at<=now() then 'expired_without_checkpoint'
      when x.append_count>0 then 'checkpoint_required_before_handoff' else 'capture_unknown' end,
    'required_action',case when x.append_count>0 and x.checkpoint_count=0 then 'checkpoint_before_handoff' else null end,
    'authority_capture',case when x.append_count>0 and x.checkpoint_count=0 then 'incomplete' else 'unknown' end
  ) order by s.started_at desc),'[]'::jsonb),
  coalesce(bool_or(x.append_count>0 and x.checkpoint_count=0),false) into v_sessions,v_reminder
  from public.clued_continuity_sessions s
  cross join lateral (select
    count(*) filter(where r.operation='append') append_count,
    count(*) filter(where r.operation='checkpoint') checkpoint_count
    from public.clued_audit_receipts r where r.operation in ('append','checkpoint')
      and r.user_id=s.user_id and r.binding_id=s.binding_id and r.context_key=s.context_key
      and r.metadata->>'session_id'=s.id::text) x
  where s.user_id=v_binding.user_id and s.binding_id=v_binding.id and s.context_key=v_context_key
    and s.started_at>now()-interval '30 days';
  return jsonb_build_object('status','ok','context_key',v_context_key,'receipts',v_receipts,
    'session_compliance',v_sessions,'checkpoint_reminder',v_reminder,
    'authority_capture_completeness',jsonb_build_object(
      'state',case when v_reminder then 'incomplete' else 'unknown' end,
      'basis','server_observes_only_writes_that_reached_clued','independent_of','currentness'));
end $$;
end $r9_capabilities$;
