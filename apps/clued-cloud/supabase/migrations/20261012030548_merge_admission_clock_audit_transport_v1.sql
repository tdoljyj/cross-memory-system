-- PRIVATE candidate only. No formal migration, public overload, GRANT or
-- installed/accepted-source claim. The normal C1 boundary invokes one fixed RPC
-- per transaction; neither this branch, resolve_binding nor the Worker audit
-- postprocessor appends ordinary receipts/source events after open/seal/page.
-- Privileged callers constructing arbitrary mixed SQL transactions remain
-- outside that transport boundary; no all-admin tamperproof gate is claimed.
do $clock_audit_transport$ declare
  original_definition text;patched_definition text;original_oid oid;original_acl aclitem[];original_owner oid;original_config text[];original_body_digest text;
  dispatch_anchor text:=E'begin\n  v_binding:=clued_private.resolve_binding(p_token_hash,''audit:read'',v_context_key);';
begin
create function clued_private.clock_audit_transport_candidate_v1(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='30s' as $transport$
declare
 b public.clued_agent_bindings%rowtype;checked public.clued_agent_bindings%rowtype;
 s clued_private.merge_measurement_stream_v1%rowtype;e clued_private.clock_source_epoch_candidate_v1%rowtype;
 z clued_private.clock_source_seals_candidate_v1%rowtype;
 m jsonb:=p_input->'measurement';op text:=m->>'operation';ctx text:=coalesce(nullif(btrim(p_input->>'context_key'),''),'global');
 q text:=m->>'queue_ref';contexts text[];last_contexts text[];context text;result jsonb;before_epoch jsonb;before_seal jsonb;actual_seal_pin jsonb;
 before_catalog text;pin jsonb;actual_pin jsonb;end_seq bigint;after_seq bigint;page_limit integer;auth_digest text;denial_message text;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(m) is distinct from 'object'
   or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('context_key','limit','measurement'))
   or op not in ('clock_open','clock_seal','clock_page') or op is null
   or q is null or q !~ '^merge:[a-z0-9_.-]+/[a-z0-9_.-]+:[a-z0-9_.-]+$' then
   raise exception 'clock_transport_input_invalid' using errcode='22023';end if;
 if current_setting('transaction_isolation')<>'read committed' then
   raise exception 'clock_transport_snapshot_isolation_unsupported' using errcode='55000';end if;
 if exists(select 1 from jsonb_object_keys(m) k where k not in
   ('operation','queue_ref','epoch_id','seal_id','pins','seal_pins','after_sequence','limit')) then
   raise exception 'clock_transport_input_invalid' using errcode='22023';end if;
 if op='clock_open' and exists(select 1 from jsonb_object_keys(m) k where k not in ('operation','queue_ref')) then
   raise exception 'clock_transport_input_invalid' using errcode='22023';end if;
 if op='clock_seal' and (exists(select 1 from jsonb_object_keys(m) k where k not in ('operation','queue_ref','epoch_id','pins'))
   or coalesce(m->>'epoch_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
   raise exception 'clock_transport_input_invalid' using errcode='22023';end if;
 if op='clock_page' and (coalesce(m->>'seal_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or m ? 'epoch_id' or coalesce(m->>'after_sequence','0') !~ '^[0-9]{1,6}$'
   or coalesce(m->>'limit','100') !~ '^[0-9]{1,3}$') then
   raise exception 'clock_transport_input_invalid' using errcode='22023';end if;
 b:=clued_private.resolve_binding(p_token_hash,'audit:read',ctx);
 if exists(select 1 from clued_private.merge_measurement_events_v1 where user_id=b.user_id
   and transaction_id=pg_current_xact_id()::text) then
   raise exception 'clock_source_source_write_in_transaction' using errcode='55000';end if;
 -- Binding SHARE precedes stream SHARE; core then serializes epoch/seal itself.
 select * into s from clued_private.merge_measurement_stream_v1 where user_id=b.user_id for share;
 if not found then raise exception 'clock_transport_stream_unavailable' using errcode='55000';end if;
 before_catalog:=clued_private.clock_source_catalog_candidate_v1();
 if s.source_changed or s.source_digest<>clued_private.merge_measurement_source_digest_v1()
   or clued_private.merge_measurement_capabilities_v1(b.user_id)->'capture_configuration_matches' is distinct from 'true'::jsonb then
   raise exception 'clock_transport_source_unqualified' using errcode='55000';end if;
 if op='clock_open' then
   select array_agg(distinct context_key order by context_key) into contexts from (
     select 'global'::text context_key union all select c.context_key from clued_private.work_claims_v1 c
     where c.user_id=b.user_id and exists(select 1 from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) r where lower(r)=q)) x;
 else
   pin:=m->'pins';
   if jsonb_typeof(pin) is distinct from 'object' or (select count(*) from jsonb_object_keys(pin))<>5
     or exists(select 1 from jsonb_object_keys(pin) k where k not in ('epoch_id','stream_id','clock_generation_id','foundation_digest','catalog_digest'))
     or exists(select 1 from jsonb_each_text(pin) p where p.key in ('epoch_id','stream_id','clock_generation_id')
       and p.value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or exists(select 1 from jsonb_each_text(pin) p where p.key in ('foundation_digest','catalog_digest') and p.value !~ '^[0-9a-f]{64}$') then
     raise exception 'clock_transport_pins_invalid' using errcode='22023';end if;
   if op='clock_page' then
     select * into z from clued_private.clock_source_seals_candidate_v1 where user_id=b.user_id and seal_id=(m->>'seal_id')::uuid;
     if not found then raise exception 'clock_transport_seal_unavailable' using errcode='55000';end if;
     select * into e from clued_private.clock_source_epoch_candidate_v1 where user_id=b.user_id and epoch_id=z.epoch_id;
     before_seal:=to_jsonb(z);end_seq:=z.upstream_end_sequence;
     actual_seal_pin:=jsonb_build_object('end_sequence',z.end_sequence,'closing_us',z.closing_us,'catalog_digest',z.catalog_digest);
     if m->'seal_pins' is distinct from actual_seal_pin then
       raise exception 'clock_transport_seal_pins_changed' using errcode='55000';end if;
   else
     select * into e from clued_private.clock_source_epoch_candidate_v1 where user_id=b.user_id and epoch_id=(m->>'epoch_id')::uuid;
     end_seq:=s.last_sequence;
   end if;
   if e.epoch_id is null or e.queue_ref<>q or e.upstream_stream_id<>s.stream_id then
     raise exception 'clock_transport_epoch_unavailable' using errcode='55000';end if;
   before_epoch:=to_jsonb(e);
   actual_pin:=jsonb_build_object('epoch_id',e.epoch_id,'stream_id',e.stream_id,'clock_generation_id',e.clock_generation_id,
     'foundation_digest',e.foundation_digest,'catalog_digest',e.catalog_digest);
   if pin is distinct from actual_pin or (op='clock_seal' and m->>'epoch_id'<>e.epoch_id::text) then
     raise exception 'clock_transport_pins_changed' using errcode='55000';end if;
   select array_agg(distinct context_key order by context_key) into contexts from (
     select x->>'context_key' context_key from jsonb_array_elements(e.initial_events) x
     union all select context_key from clued_private.clock_source_projection_candidate_v1(b.user_id,e.epoch_id,end_seq)) x;
 end if;
 if contexts is null or cardinality(contexts)>128 or array_position(contexts,null) is not null then
   raise exception 'clock_transport_target_scope_unqualified' using errcode='55000';end if;
 foreach context in array contexts loop
   begin checked:=clued_private.resolve_binding(p_token_hash,'audit:read',context);
   exception when insufficient_privilege then
     get stacked diagnostics denial_message=message_text;
     if denial_message not in ('binding_not_authorized','resource_action_not_authorized') then raise;end if;
     -- Preserve real inactive/expired and requested-context denials. Only an
     -- otherwise live, requested-scope-authorized reader gets this target code.
     perform clued_private.resolve_binding(p_token_hash,'audit:read',ctx);
     raise exception 'clock_transport_contributor_not_authorized' using errcode='42501';
   end;
   if checked.id<>b.id or checked.user_id<>b.user_id then raise exception 'binding_not_authorized' using errcode='42501';end if;
 end loop;
 if op='clock_open' then
   result:=clued_private.clock_source_epoch_candidate_v1(b.user_id,q);
   select * into e from clued_private.clock_source_epoch_candidate_v1 where user_id=b.user_id and epoch_id=(result->>'epoch_id')::uuid;
   before_epoch:=to_jsonb(e);end_seq:=e.upstream_start_sequence;
 elsif op='clock_seal' then
   result:=clued_private.clock_source_seal_candidate_v1(b.user_id,e.epoch_id);
   select * into z from clued_private.clock_source_seals_candidate_v1 where user_id=b.user_id and seal_id=(result->>'seal_id')::uuid;
   before_seal:=to_jsonb(z);end_seq:=z.upstream_end_sequence;
   if result->'candidate_ready' is distinct from 'true'::jsonb then
     raise exception 'clock_transport_source_unqualified' using errcode='55000';end if;
 else
   after_seq:=coalesce(m->>'after_sequence','0')::bigint;page_limit:=coalesce(m->>'limit','100')::integer;
   result:=clued_private.clock_source_page_candidate_v1(p_token_hash,jsonb_build_object('context_key',ctx,'seal_id',z.seal_id,'after_sequence',after_seq,'limit',page_limit));
   if result->>'status' is distinct from 'ok' then raise exception 'clock_transport_source_unqualified' using errcode='55000';end if;
 end if;
 -- Authorize the actual opening snapshot / fixed sealed ever-target members.
 -- Never inspect unrelated ledger contexts merely to enlarge authorization.
 select array_agg(distinct context_key order by context_key) into last_contexts from (
   select x->>'context_key' context_key from jsonb_array_elements(e.initial_events) x
   union all select context_key from clued_private.clock_source_projection_candidate_v1(b.user_id,e.epoch_id,end_seq)) x;
 if last_contexts is null or cardinality(last_contexts)>128 or array_position(last_contexts,null) is not null then
   raise exception 'clock_transport_target_scope_unqualified' using errcode='55000';end if;
 checked:=clued_private.resolve_binding(p_token_hash,'audit:read',ctx);
 if checked.id<>b.id or checked.user_id<>b.user_id then raise exception 'binding_not_authorized' using errcode='42501';end if;
 foreach context in array last_contexts loop
   begin checked:=clued_private.resolve_binding(p_token_hash,'audit:read',context);
   exception when insufficient_privilege then
     get stacked diagnostics denial_message=message_text;
     if denial_message not in ('binding_not_authorized','resource_action_not_authorized') then raise;end if;
     perform clued_private.resolve_binding(p_token_hash,'audit:read',ctx);
     raise exception 'clock_transport_contributor_not_authorized' using errcode='42501';
   end;
   if checked.id<>b.id or checked.user_id<>b.user_id then raise exception 'binding_not_authorized' using errcode='42501';end if;
 end loop;
 if (op<>'clock_open' and last_contexts is distinct from contexts) or before_catalog<>clued_private.clock_source_catalog_candidate_v1()
   or e.foundation_digest<>s.source_digest or e.catalog_digest<>before_catalog or e.ddl_tainted
   or before_epoch is distinct from (select to_jsonb(x) from clued_private.clock_source_epoch_candidate_v1 x where x.epoch_id=e.epoch_id and x.user_id=b.user_id)
   or (op<>'clock_open' and before_seal is distinct from (select to_jsonb(x) from clued_private.clock_source_seals_candidate_v1 x where x.seal_id=z.seal_id and x.user_id=b.user_id))
   or exists(select 1 from clued_private.merge_measurement_events_v1 where user_id=b.user_id and transaction_id=pg_current_xact_id()::text) then
   raise exception 'clock_transport_pins_changed' using errcode='55000';end if;
 actual_pin:=jsonb_build_object('epoch_id',e.epoch_id,'stream_id',e.stream_id,'clock_generation_id',e.clock_generation_id,
   'foundation_digest',e.foundation_digest,'catalog_digest',e.catalog_digest);
 auth_digest:=encode(extensions.digest(convert_to(jsonb_build_object('binding',b.id,'context',ctx,'queue',q,'contributors',last_contexts)::text,'UTF8'),'sha256'),'hex');
 if op<>'clock_open' then actual_seal_pin:=jsonb_build_object('end_sequence',z.end_sequence,'closing_us',z.closing_us,'catalog_digest',z.catalog_digest);end if;
 return jsonb_build_object('status','ok','operation',op,'measurement',result,'pins',actual_pin,'seal_pins',actual_seal_pin,
   'server_auth',jsonb_build_object('schema','clued.clock-audit-transport-auth/1','status','AUTHENTICATED_TARGET_READ',
     'required_scope','audit:read','context_key',ctx,'queue_ref',q,'contributor_count',cardinality(last_contexts),
     'binding_scope_fingerprint',auth_digest,'observed_at',clock_timestamp(),
     'transport_definition_digest',encode(extensions.digest(convert_to(pg_get_functiondef('clued_private.clock_audit_transport_candidate_v1(text,jsonb)'::regprocedure),'UTF8'),'sha256'),'hex')),
   'source_auth',false,'official_metric',false,'t0',null);
end $transport$;
revoke all on function clued_private.clock_audit_transport_candidate_v1(text,jsonb) from public,anon,authenticated,service_role;

-- Exact old signature/owner/ACL/OID and all legacy source bytes are preserved
-- around this one fixed branch. No arbitrary SQL or dynamic RPC reaches callers.
select p.oid,p.proacl,p.proowner,p.proconfig,pg_get_functiondef(p.oid),encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')
  into original_oid,original_acl,original_owner,original_config,original_definition,original_body_digest
  from pg_proc p where p.oid='public.clued_mcp_audit_receipts(text,jsonb)'::regprocedure;
if original_body_digest<>'651532805e2d6d83dcd1db00e2d1eb6b9e2bcc212a2a4b0b62b75c6aab04ffbe'
  or position(dispatch_anchor in original_definition)=0 or array_length(string_to_array(original_definition,dispatch_anchor),1)<>2 then
 raise exception 'clock_transport_legacy_source_mismatch' using errcode='55000';end if;
patched_definition:=replace(original_definition,dispatch_anchor,E'begin\n  if p_input->''measurement'' ? ''operation'' then\n    return clued_private.clock_audit_transport_candidate_v1(p_token_hash,p_input);\n  end if;\n  v_binding:=clued_private.resolve_binding(p_token_hash,''audit:read'',v_context_key);');
execute patched_definition;
if exists(select 1 from pg_proc p where p.oid=original_oid and (p.proacl is distinct from original_acl or p.proowner<>original_owner or p.proconfig is distinct from original_config)) then
 raise exception 'clock_transport_legacy_acl_changed' using errcode='55000';end if;
end $clock_audit_transport$;
