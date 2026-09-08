// Forward empty-install candidate. Does not connect to a database or change old sources.
import fs from 'node:fs';
import crypto from 'node:crypto';
const old=fs.readFileSync(new URL('../install.candidate.sql',import.meta.url),'utf8');
if(crypto.createHash('sha256').update(old).digest('hex')!=='b8063e0776f691a1b9a2fe990c377bfb82d13270206ecfc900d0f73c723f64d2')throw Error('Exact accepted predecessor changed');
let sql=old;
function replace(a,b){if(!sql.includes(a))throw Error('Missing exact anchor');sql=sql.replace(a,()=>b);}
replace("'ET1','ET2','ET3'))", "'ET1','ET2','ET3','G-PREENTRY-SKILL-QUALIFICATION'))");
replace('create function clued_control.read_execution() returns jsonb',`-- Complete immutable original StatusManifest bytes; storage grants no authority.
create table clued_control.control_objects (
 root_id text not null references clued_control.execution_binding(root_id),
 object_type text not null check(object_type='StatusManifest'),
 uri text primary key, raw text not null, sha256 text not null,
 generation bigint not null check(generation between 1 and 9007199254740991),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(root_id,object_type,generation),
 check(uri ~ '^control://status-manifests/sm_[A-Za-z0-9_-]{1,128}$'),
 check(octet_length(raw)<=65536 and raw is json object with unique keys),
 check(sha256=encode(sha256(convert_to(raw,'UTF8')),'hex'))
);
create trigger control_objects_immutable before update or delete or truncate on clued_control.control_objects
 for each statement execute function clued_control.deny_mutation();
alter table clued_control.control_objects enable row level security;
create function clued_control.append_status_manifest(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; obj jsonb; object_uri text; previous clued_control.control_objects; r jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_status_bytes_required'; end if;
 obj:=p_raw::jsonb;
 if obj->>'object_type' is distinct from 'StatusManifest' or obj->>'schema_version' is distinct from '1.0'
 or obj->>'schema_digest' is distinct from '6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2'
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
end $$;

create function clued_control.read_execution() returns jsonb`);
const objects=`'control_objects',coalesce((select jsonb_agg(jsonb_build_object('object_type',co.object_type,'uri',co.uri,'raw',co.raw,'sha256',co.sha256))
 from clued_control.control_objects co join clued_control.gate_attempts active on active.root_id=co.root_id
 where co.root_id=b.root_id and active.ga_id=c.active_ga_id and co.uri=active.ga->'status_manifest_ref'->>'uri'
 and co.sha256=active.ga->'status_manifest_ref'->>'sha256'),'[]'::jsonb),
 `;
replace("'authority_effect','NONE') from clued_control.execution_binding b",objects+"'authority_effect','NONE') from clued_control.execution_binding b");
replace(' -- Full original Schema, exact static Gate version/digest, signature/issuer,',` if not exists(select 1 from clued_control.control_objects co where co.root_id=root
 and co.uri=g->'status_manifest_ref'->>'uri' and co.sha256=g->'status_manifest_ref'->>'sha256')
 then raise exception 'exact_stored_status_required'; end if;
 -- Full original Schema, exact static Gate version/digest, signature/issuer,`);
replace(' r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb;',
 ' r jsonb; op text; next_phase text; evidence_raw text; evidence_json jsonb; field_name text;');
replace("  update clued_control.gate_attempts set decision=p->'body'",`  foreach field_name in array array['decision','evidence_index'] loop
   evidence_raw:=p->'body'->>(field_name||'_raw');
   if jsonb_typeof(p->'body'->(field_name||'_raw')) is distinct from 'string'
   or not(evidence_raw is json object with unique keys)
   or p->'body'->>(field_name||'_sha256') is distinct from encode(sha256(convert_to(evidence_raw,'UTF8')),'hex')
   then raise exception 'complete_reserved_evidence_bytes_required'; end if;
   evidence_json:=evidence_raw::jsonb;
   if evidence_json->>'ga_id' is distinct from a.ga_id or evidence_json->>'ga_sha256' is distinct from a.ga_sha256
   then raise exception 'reserved_evidence_ga_mismatch'; end if;
   if field_name='decision' and (evidence_json->>'result' is distinct from p->'body'->>'result'
    or coalesce(evidence_json->>'result','') not in ('PASS','FAIL','BLOCKED','STALE'))
   then raise exception 'reserved_decision_result_mismatch'; end if;
  end loop;
  update clued_control.gate_attempts set decision=p->'body'`);
// Reuse one complete fixed read projection, including the exact active Status object.
const start="  'current_context',jsonb_build_object('root',clued_control.read_root(root),";
const end="    'observed_at',clock_timestamp(),'authority_effect','NONE'),'authority_effect','NONE');";
const at=sql.indexOf(start),last=sql.indexOf(end,at);
if(at<0||last<0)throw Error('Fixed context projection missing');
sql=sql.slice(0,at)+"  'current_context',clued_control.read_execution()||jsonb_build_object('observed_at',clock_timestamp()),'authority_effect','NONE');"+sql.slice(last+end.length);
sql+=`\nrevoke all on clued_control.control_objects from public,anon,authenticated,service_role;
revoke all on function clued_control.append_status_manifest(text,text) from public,anon,authenticated,service_role;
grant execute on function clued_control.append_status_manifest(text,text) to service_role;
`;
fs.writeFileSync(new URL('install.candidate.sql',import.meta.url),sql);
