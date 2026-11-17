-- Keep the Owner's standing renewal choice separate from runtime failure.
-- Fatal failures still require fresh OAuth; three temporary failures still
-- stop claims. Explicit disable/revoke and unknown-exchange fences are intact.
-- No historical false value is inferred to be consent or automatically revived.
do $upgrade$
declare target record; patch record; source_text text; normalized text;
  definition text; expected_source text; hits integer;
begin
  for target in select * from (values
    ('clued_private.ii_pub_clued_storage_refresh_worker_v1(text,jsonb)',
      'f66353184f32cebe41a7aae1981e6909fa75b4bf095ea60bfae3f86049fc7ad0','worker'),
    ('clued_private.clued_storage_refresh_manage_v1(jsonb)',
      'feab4a64196e3fa63bb3593bf7cacbd5a21d9006ba31f5320c7589944a8cc8cf','manage')
  ) t(signature,source_hash,kind) loop
    if not exists(select 1 from pg_proc p where p.oid=target.signature::regprocedure
      and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef
      and p.proconfig=array['search_path=""'] and p.proacl::text='{postgres=X/postgres}') then
      raise exception 'storage_refresh_intent_catalog_mismatch' using errcode='42501';
    end if;
    select prosrc into source_text from pg_proc where oid=target.signature::regprocedure;
    normalized:=source_text;
    definition:=pg_get_functiondef(target.signature::regprocedure);
    expected_source:=source_text;
    for patch in select * from (values
      ('worker',
        $a$      enabled=enabled and p_input->>'reason'='provider_unavailable' and failures<2,
$a$,
        $r$      -- Renewal intent survives a failure; state/backoff/failure limit pause execution.
$r$),
      ('worker',
        $a$elsif p_input<>(jsonb_build_object('action','fail','connection_id',c.id,'attempt_id',x.id,'reason',p_input->>'reason')||case when recovery_job is null then '{}'::jsonb else jsonb_build_object('recovery_job_id',recovery_job) end)
    or coalesce(p_input->>'reason','') not in ('provider_rejected','provider_unavailable','credential_invalid') then$a$,
        $r$elsif p_input<>(jsonb_build_object('action','fail','connection_id',c.id,'attempt_id',x.id,'reason',p_input->>'reason')
      ||case when recovery_job is null then '{}'::jsonb else jsonb_build_object('recovery_job_id',recovery_job) end
      ||case when p_input ? 'failure_code' then jsonb_build_object('failure_code',p_input->'failure_code') else '{}'::jsonb end)
    or coalesce(p_input->>'reason','') not in ('provider_rejected','provider_unavailable','credential_invalid')
    or (p_input ? 'failure_code' and (jsonb_typeof(p_input->'failure_code') is distinct from 'string'
      or not coalesce(p_input->>'failure_code'=any(case p_input->>'reason'
        when 'credential_invalid' then array['credential_validation','claim_deadline']
        when 'provider_unavailable' then array['token_temporarily_unavailable','token_server_error']
        when 'provider_rejected' then array['token_invalid_grant','token_invalid_client','token_response_invalid',
          'scope_changed','drive_identity_fetch','drive_identity_mismatch','root_metadata_fetch',
          'root_identity_changed','root_access_changed','root_parent_changed','refresh_deadline','credential_seal_failure']
        else '{}'::text[] end),false))) then$r$),
      ('worker',
        $a$null,jsonb_build_object('connection_id',c.id,'attempt_id',x.id),
    req->>'idempotency_key'$a$,
        $r$null,jsonb_build_object('connection_id',c.id,'attempt_id',x.id)
      ||case when op='fail' then jsonb_build_object('reason',p_input->>'reason',
        'failure_code',coalesce(p_input->>'failure_code','unspecified')) else '{}'::jsonb end,
    req->>'idempotency_key'$r$),
      ('manage',
        $a$return jsonb_build_object('enabled',coalesce(d.enabled,false) and c.state='active','version',coalesce(d.version,0),$a$,
        $r$return jsonb_build_object('enabled',coalesce(d.enabled,false) and c.state='active',
      'authorized_enabled',coalesce(d.enabled,false) and c.revoked_at is null,
      'pause_reason',case when not coalesce(d.enabled,false) or c.revoked_at is not null then 'none'
        when c.state='reauthorization_required' then 'reauthorization_required'
        when c.state<>'active' then 'connection_inactive'
        when d.failures>=3 then 'failure_limit'
        when d.failures>0 and d.next_refresh_at>clock_timestamp() then 'backoff'
        else 'none' end,'version',coalesce(d.version,0),$r$)
    ) v(kind,anchor,replacement) where v.kind=target.kind loop
      if encode(sha256(convert_to(source_text,'UTF8')),'hex')=target.source_hash then
        hits:=(length(expected_source)-length(replace(expected_source,patch.anchor,'')))/length(patch.anchor);
        if hits<>1 then raise exception 'storage_refresh_intent_anchor_mismatch' using errcode='42501'; end if;
        expected_source:=replace(expected_source,patch.anchor,patch.replacement);
        definition:=replace(definition,patch.anchor,patch.replacement);
      else
        -- Replay must invert to the exact qualified predecessor, not merely
        -- contain a marker or one new clause. No unrelated drift is accepted.
        hits:=(length(normalized)-length(replace(normalized,patch.replacement,'')))/length(patch.replacement);
        if hits<>1 then raise exception 'storage_refresh_intent_source_mismatch' using errcode='42501'; end if;
        normalized:=replace(normalized,patch.replacement,patch.anchor);
      end if;
    end loop;
    if encode(sha256(convert_to(source_text,'UTF8')),'hex')<>target.source_hash then
      if encode(sha256(convert_to(normalized,'UTF8')),'hex')<>target.source_hash then
        raise exception 'storage_refresh_intent_source_mismatch' using errcode='42501';
      end if;
      continue;
    end if;
    execute definition;
    if not exists(select 1 from pg_proc p where p.oid=target.signature::regprocedure
      and p.prosrc=expected_source and pg_get_userbyid(p.proowner)='postgres'
      and p.prosecdef and p.proconfig=array['search_path=""'] and p.proacl::text='{postgres=X/postgres}') then
      raise exception 'storage_refresh_intent_result_mismatch' using errcode='42501';
    end if;
  end loop;
end $upgrade$;
notify pgrst,'reload schema';
