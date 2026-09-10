-- Root5 final continuation: bind only new StatusManifest writes to the published
-- Root5 Status schema. Immutable historical duplicates remain accepted.
begin;

create temporary table root5_status_append_guard on commit drop as
select
 to_jsonb(ec) current_row,
 (select count(*) from clued_control.execution_events where root_id=ec.root_id) event_count,
 (select count(*) from clued_control.gate_attempts where root_id=ec.root_id) attempt_count,
 (select count(*) from clued_control.control_objects where root_id=ec.root_id) object_count
from clued_control.execution_current ec
where ec.root_id='ctr_414bd3c724264a83894b0c55cf2ab878';

do $guard$
declare observed text;
begin
 perform 1 from clued_control.current_head
 where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for share;
 perform 1 from clued_control.execution_current
 where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
 if clued_control.read_root('ctr_414bd3c724264a83894b0c55cf2ab878')->>'generation_id'
    is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
 then raise exception 'ROOT5_NOT_CURRENT'; end if;
 select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') into observed
 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
 where ns.nspname='clued_control' and p.proname='append_status_manifest';
 if observed is distinct from 'c0bd3ec817716faf6475aa5ae78262a0b6063bf0e3ae7b5bd54054341a8dd430'
 then raise exception 'ROOT5_STATUS_APPEND_OLD_MISMATCH:%',observed; end if;
end $guard$;

CREATE OR REPLACE FUNCTION clued_control.append_status_manifest(p_raw text, p_sha text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; obj jsonb; object_uri text; previous clued_control.control_objects; r jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_status_bytes_required'; end if;
 obj:=p_raw::jsonb;
 if obj->>'object_type' is distinct from 'StatusManifest' or obj->>'schema_version' is distinct from '1.0'
 or coalesce(obj->>'schema_digest','') not in ('6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2','e6bf45a014926fe5ee1dfbda1851d07a57030733ca411a08cd6364a6e40b3dca','76bb79f7278905122474f86fe195cb803e3cb5185a4a50899403fa5567726ae0')
 or coalesce(obj->>'status_manifest_id','') !~ '^sm_[A-Za-z0-9_-]{1,128}$'
 or obj->>'issuer_purpose' is distinct from 'STATUS'
 or obj->>'audience' is distinct from 'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw'
 or jsonb_typeof(obj->'generation') is distinct from 'number'
 or coalesce(obj->>'generation','') !~ '^[1-9][0-9]{0,15}$'
 or (obj->>'generation')::numeric>9007199254740991
 or jsonb_typeof(obj->'signature_binding') is distinct from 'object' then raise exception 'status_scope_or_encoding_mismatch'; end if;
 object_uri:='control://status-manifests/'||(obj->>'status_manifest_id');
 perform 1 from clued_control.current_head where root_id=root for share;
 perform 1 from clued_control.execution_current where root_id=root for update;
 if not found then raise exception 'accepted_execution_binding_missing'; end if;
 select * into previous from clued_control.control_objects where uri=object_uri;
 if found then
  if previous.root_id is distinct from root or previous.raw is distinct from p_raw or previous.sha256 is distinct from p_sha
  then raise exception 'immutable_status_identity_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','object',to_jsonb(previous),'authority_effect','NONE');
 end if;
 -- Preserve exact immutable duplicates; only new objects use the ordinary Root5 schema.
 if obj->>'schema_digest' is distinct from '76bb79f7278905122474f86fe195cb803e3cb5185a4a50899403fa5567726ae0'
 or obj->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
 or (obj->>'expires_at')::timestamptz is distinct from '2026-09-11T10:21:05Z'::timestamptz
 then raise exception 'ordinary_root5_status_schema_required'; end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or obj->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or (obj->>'as_of') is null or (obj->>'expires_at') is null or (obj->>'as_of')::timestamptz>clock_timestamp()
 or (obj->>'expires_at')::timestamptz<=clock_timestamp()
 or (obj->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'status_current_scope_mismatch'; end if;
 -- Trusted host verifies the full accepted Schema and actual STATUS Owner merge.
 insert into clued_control.control_objects(root_id,object_type,uri,raw,sha256,generation)
 values(root,'StatusManifest',object_uri,p_raw,p_sha,(obj->>'generation')::bigint);
 return jsonb_build_object('status','STORED_NO_AUTHORITY','uri',object_uri,'sha256',p_sha,'authority_effect','NONE');
end $function$
;

do $guard$
declare observed text; before_row root5_status_append_guard; now_row jsonb;
begin
 select * into before_row from root5_status_append_guard;
 select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') into observed
 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
 where ns.nspname='clued_control' and p.proname='append_status_manifest';
 if observed is distinct from '05c5023f69d5c8f932df51230910cf45a9f68dce85768beb85515f8671c8a441'
 then raise exception 'ROOT5_STATUS_APPEND_NEW_MISMATCH:%',observed; end if;
 select to_jsonb(ec) into now_row from clued_control.execution_current ec
 where ec.root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
 if now_row is distinct from before_row.current_row
 or (select count(*) from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') is distinct from before_row.event_count
 or (select count(*) from clued_control.gate_attempts where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') is distinct from before_row.attempt_count
 or (select count(*) from clued_control.control_objects where root_id='ctr_414bd3c724264a83894b0c55cf2ab878') is distinct from before_row.object_count
 then raise exception 'ROOT5_STATUS_APPEND_UNRELATED_STATE_CHANGED'; end if;
end $guard$;

commit;
