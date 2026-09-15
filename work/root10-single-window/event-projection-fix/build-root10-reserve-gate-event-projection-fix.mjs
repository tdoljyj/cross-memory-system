import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT='ctr_414bd3c724264a83894b0c55cf2ab878';
const ROOT10='ctrgen_48100437d24e448ba01c542ebe1290da';
const STATUS29='72f6c8a2c4c5b5621814c8d4515e2821eb39c11247e318684d36d2e2be8afe83';
const OLD_CATALOG_SHA='5dd90bdfb79a3a03289490130daf5be431b056f7432cb68c7dc0ce60d8459bb8';
const OLD_SOURCE_SHA='db0967d6b95c1a9a5b2d47bdbca6809728e272ea2b059ceba9c6e6bf20d269bc';
const NEGATIVE_MANIFEST_SCHEMA='root10-negative-probes-build/1';
const NEGATIVE_PLAN_SHA='c414f8c9a2d858e20e6aa2ff118fc77beb925fb4e3a5e06ae687ac99ebb49256';
const EXPECTED_PROBES=[
  'N01_CHANGED_BYTES_SAME_IDEMPOTENCY',
  'N02_SECOND_ROOT10_GA',
  'N03_NONEMPTY_REPAIR_REFS',
  'N04_FIXED_SCHEMA_ISSUER_RISK_PROFILE_VECTOR_SOURCE_DRIFT',
  'N05_STATUS_NOT_GENERATION29',
  'N06_BUDGET_NOT117_OR_RAW_NO_LF',
  'N07_NOT_EXACT_600_SECONDS',
  'N08_HISTORICAL_ATTEMPT_OR_RECEIPT_DRIFT',
  'N09_CONTAINER_OR_ACTIVE_PHASE_PREEXISTS',
  'N10_EXACT_RESPONSE_LOSS_REPLAY',
  'N11_ROOT_OR_EXECUTION_IMMUTABLE_PREFIX_DRIFT',
  'N12_HISTORICAL_BUDGET_GENERATION_OR_EXPIRY_DRIFT',
  'N13_GA6_CLOSURE_111_112_BYTES_DRIFT',
  'N14_EXACT_51_FIELD_SCHEMA_SHAPE_MISSING_OR_EXTRA',
  'N15_CONTAINER_PHASE_MACHINE_DRIFT'
];

const die=m=>{throw new Error(m)};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const q=s=>String(s).replaceAll("'","''");
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const read=p=>fs.readFileSync(path.resolve(p),'utf8');
const one=(s,needle,label)=>{
  const n=s.split(needle).length-1;
  if(n!==1) die(`${label}: expected one exact occurrence, got ${n}`);
};

const [sourceArg,negativeDirArg,outArg='--stdout']=process.argv.slice(2);
if(!sourceArg||!negativeDirArg) die('usage: node build-root10-reserve-gate-event-projection-fix.mjs LIVE_RESERVE_GATE_SOURCE NEGATIVE_OUTPUT_DIR [--stdout|OUTDIR]');
const sourcePath=path.resolve(sourceArg),negativeDir=path.resolve(negativeDirArg);
const source=read(sourcePath);
if(sha(source)!==OLD_SOURCE_SHA) die('exact committed Root10 reserve_gate source bytes required');
if((source.match(/CREATE OR REPLACE FUNCTION clued_control\.reserve_gate\(p_raw text, p_sha text\)/g)||[]).length!==1) die('single reserve_gate definition required');
if((source.match(/\$function\$/g)||[]).length!==2) die('closed reserve_gate dollar body required');

const oldPrepared="and idempotency_key='root10_single_window_activation_20260915_prepared' and request=fixed_prepared_event)";
const newPrepared="and idempotency_key='root10_single_window_activation_20260915_prepared' and request=jsonb_build_object('operation',fixed_prepared_event->'operation','body',jsonb_build_object('binding_id',fixed_prepared_event->'binding_id','evidence',fixed_prepared_event->'evidence')))";
const oldQualified="and idempotency_key='root10_single_window_activation_20260915_qualified' and request=fixed_qualified_event)";
const newQualified="and idempotency_key='root10_single_window_activation_20260915_qualified' and request=jsonb_build_object('operation',fixed_qualified_event->'operation','body',jsonb_build_object('binding_id',fixed_qualified_event->'binding_id','evidence',fixed_qualified_event->'evidence')))";
const oldGateDefinition="or g->'gate_definition_ref'->>'definition_version' is distinct from b.gate_version\n or g->'gate_definition_ref'->>'content_digest' is distinct from b.gate_sha256";
const newGateDefinition="or b.gate_version is distinct from 'fixed-synthetic-20260910.v10-env-order-repair' or b.gate_sha256 is distinct from '3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a'\n or jsonb_typeof(g->'artifact_refs') is distinct from 'array' or (select count(*) from jsonb_array_elements(g->'artifact_refs') ar where ar=jsonb_build_object('uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/2afc439d56475fe58ca4168680e3cb2801d817b6','sha256',b.gate_sha256))<>1";
one(source,oldPrepared,'prepared stored-event predicate');
one(source,oldQualified,'qualified stored-event predicate');
one(source,oldGateDefinition,'Gate definition projection');
const corrected=source.replace(oldPrepared,()=>newPrepared).replace(oldQualified,()=>newQualified).replace(oldGateDefinition,()=>newGateDefinition);
if(corrected===source) die('correction did not change source');
if(corrected.includes(oldPrepared)||corrected.includes(oldQualified)) die('old invocation-envelope equality remains');
one(corrected,newPrepared,'corrected prepared stored-event predicate');
one(corrected,newQualified,'corrected qualified stored-event predicate');
one(corrected,newGateDefinition,'corrected Gate definition projection');

const toCatalogDefinition=s=>{
  const from="RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' SET \"TimeZone\" TO 'UTC'";
  const to=" RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''\n SET \"TimeZone\" TO 'UTC'";
  one(s,from,'catalog header source');
  let d=s.replace(from,()=>to);
  if(!/end \$function\$;\n?$/.test(d)) die('unexpected function terminator');
  d=d.replace(/end \$function\$;\n?$/,()=> 'end $function$\n');
  return d;
};
const oldCatalog=toCatalogDefinition(source);
if(sha(oldCatalog)!==OLD_CATALOG_SHA) die(`catalog normalization mismatch: ${sha(oldCatalog)}`);
const correctedCatalog=toCatalogDefinition(corrected);
const NEW_CATALOG_SHA=sha(correctedCatalog);

const extractFixed=name=>{
  const re=new RegExp(`${name} jsonb:=convert_from\\(decode\\('([^']+)'`);
  const m=source.match(re); if(!m) die(`missing ${name}`);
  return JSON.parse(Buffer.from(m[1],'base64').toString('utf8'));
};
const storedEvent=invocation=>({operation:invocation.operation,body:{binding_id:invocation.binding_id,evidence:invocation.evidence}});
const preparedStored=JSON.stringify(storedEvent(extractFixed('fixed_prepared_event')));
const qualifiedStored=JSON.stringify(storedEvent(extractFixed('fixed_qualified_event')));

const negativeManifestPath=path.join(negativeDir,'root10-negative-probes.build.json');
const negativeManifestRaw=read(negativeManifestPath),negativeManifest=JSON.parse(negativeManifestRaw);
if(negativeManifest.schema_version!==NEGATIVE_MANIFEST_SCHEMA||negativeManifest.accepted_plan_sha256!==NEGATIVE_PLAN_SHA||negativeManifest.probe_count!==15||negativeManifest.subcase_count!==42||negativeManifest.live_executed!==false||negativeManifest.ga_issued!==false) die('exact accepted 15-probe manifest required');
if(negativeManifest.root_id!==ROOT||negativeManifest.generation_id!==ROOT10||negativeManifest.status29_full_sha256!==STATUS29) die('negative manifest Root10 pins mismatch');
const probeFiles=EXPECTED_PROBES.map(id=>`root10-negative.${id}.rollback.sql`);
for(const file of probeFiles){
  if(!negativeManifest.files||negativeManifest.files[file]!==sha(read(path.join(negativeDir,file)))) die(`negative probe hash mismatch: ${file}`);
}
const combinedName='root10-negative.all.rollback.sql';
if(negativeManifest.files[combinedName]!==sha(read(path.join(negativeDir,combinedName)))) die('combined negative probe hash mismatch');

const metadataColumns="p.proowner,p.proacl::text acl,p.proconfig::text config,p.prosecdef,p.provolatile,p.prokind,p.proparallel,p.proleakproof";
const preimageBlock=`do $event_projection_pre$
declare h clued_control.current_head;c clued_control.execution_current;
begin
 select * into h from clued_control.current_head where root_id='${ROOT}' for update;
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update;
 if h.sequence<>10 or h.generation_id<>'${ROOT10}' or h.revoked
 or c.sequence<>117 or c.pending_budget_sequence<>117 or c.active_ga_id is not null
 or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987
 or c.runner_generation<>'runnergen_a256855fec9441839105c69b746c5244'
 or c.credential_generation<>'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
 or c.session_generation<>'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
 or (select count(*) from clued_control.events where root_id=h.root_id)<>10
 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>117
 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>17
 or exists(select 1 from clued_control.gate_attempts where root_id=h.root_id and ga->>'control_trust_root_generation'='${ROOT10}')
 or not exists(select 1 from clued_control.control_objects where root_id=h.root_id and object_type='StatusManifest' and sha256='${STATUS29}' and generation=29)
 or not exists(select 1 from clued_control.execution_events where root_id=h.root_id and sequence=114 and idempotency_key='root10_single_window_activation_20260915_prepared' and request=convert_from(decode('${b64(preparedStored)}','base64'),'UTF8')::jsonb)
 or not exists(select 1 from clued_control.execution_events where root_id=h.root_id and sequence=115 and idempotency_key='root10_single_window_activation_20260915_qualified' and request=convert_from(decode('${b64(qualifiedStored)}','base64'),'UTF8')::jsonb)
 then raise exception 'ROOT10_EVENT_PROJECTION_FIX_EXPECTED_CURRENT117_REQUIRED';end if;
 if encode(sha256(convert_to(pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure),'UTF8')),'hex')<>'${OLD_CATALOG_SHA}' then raise exception 'ROOT10_EVENT_PROJECTION_FIX_FUNCTION_PREIMAGE_DRIFT';end if;
 create temp table _root10_event_projection_fn on commit drop as select ${metadataColumns} from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure;
 if (select count(*) from _root10_event_projection_fn)<>1 then raise exception 'ROOT10_EVENT_PROJECTION_FIX_FUNCTION_METADATA_REQUIRED';end if;
end $event_projection_pre$;`;

const postimageBlock=`do $event_projection_post$
declare h clued_control.current_head;c clued_control.execution_current;
begin
 select * into h from clued_control.current_head where root_id='${ROOT}';
 select * into c from clued_control.execution_current where root_id='${ROOT}';
 if h.sequence<>10 or h.generation_id<>'${ROOT10}' or h.revoked
 or c.sequence<>117 or c.pending_budget_sequence<>117 or c.active_ga_id is not null
 or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987
 or (select count(*) from clued_control.events where root_id=h.root_id)<>10
 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>117
 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>17
 or exists(select 1 from clued_control.gate_attempts where root_id=h.root_id and ga->>'control_trust_root_generation'='${ROOT10}')
 then raise exception 'ROOT10_EVENT_PROJECTION_FIX_STATE_CHANGED';end if;
 if encode(sha256(convert_to(pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure),'UTF8')),'hex')<>'${NEW_CATALOG_SHA}' then raise exception 'ROOT10_EVENT_PROJECTION_FIX_FUNCTION_POSTIMAGE_DRIFT';end if;
 if exists(select 1 from _root10_event_projection_fn o join pg_proc p on p.oid='clued_control.reserve_gate(text,text)'::regprocedure where p.proowner<>o.proowner or p.proacl::text is distinct from o.acl or p.proconfig::text is distinct from o.config or p.prosecdef<>o.prosecdef or p.provolatile<>o.provolatile or p.prokind<>o.prokind or p.proparallel<>o.proparallel or p.proleakproof<>o.proleakproof) then raise exception 'ROOT10_EVENT_PROJECTION_FIX_SECURITY_METADATA_CHANGED';end if;
end $event_projection_post$;`;

const readback=`select jsonb_build_object(
 'state','ROOT10_RESERVE_GATE_EVENT_PROJECTION_FIXED_CURRENT117_NO_GA',
 'root_sequence',(select sequence from clued_control.current_head where root_id='${ROOT}'),
 'root_generation',(select generation_id from clued_control.current_head where root_id='${ROOT}'),
 'execution_sequence',(select sequence from clued_control.execution_current where root_id='${ROOT}'),
 'pending_budget_sequence',(select pending_budget_sequence from clued_control.execution_current where root_id='${ROOT}'),
 'active_ga_id',(select active_ga_id from clued_control.execution_current where root_id='${ROOT}'),
 'charged_seconds',(select charged_seconds from clued_control.execution_current where root_id='${ROOT}'),
 'charged_evidence_bytes',(select charged_evidence_bytes from clued_control.execution_current where root_id='${ROOT}'),
 'attempt_count',(select count(*) from clued_control.gate_attempts where root_id='${ROOT}'),
 'root10_attempt_count',(select count(*) from clued_control.gate_attempts where root_id='${ROOT}' and ga->>'control_trust_root_generation'='${ROOT10}'),
 'reserve_gate_sha256',encode(sha256(convert_to(pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure),'UTF8')),'hex'),
 'authority_effect','NONE','ga_issued',false,'budget_changed',false,'history_changed',false) as root10_event_projection_fix;`;

const apply=`begin;\nset local lock_timeout='5s';set local statement_timeout='120s';\n${preimageBlock}\n${corrected}\n${postimageBlock}\n${readback}\ncommit;\n`;
const install=`${preimageBlock}\n${corrected}\n${postimageBlock}`;
const patchedProbes=[];
for(const file of probeFiles){
  const probe=read(path.join(negativeDir,file));
  const marker="set local lock_timeout='5s';set local statement_timeout='120s';";
  one(probe,marker,`${file} transaction header`);
  if(!/^-- [A-Z0-9_]+;/.test(probe)||!probe.trimEnd().endsWith('rollback;')) die(`${file}: exact rollback probe shape required`);
  patchedProbes.push(probe.replace(marker,()=>`${marker}\n${install}`));
}
const fullRollback=`-- Installs the two-predicate correction inside each of the exact 15 accepted probe transactions.\n-- Every transaction, including every synthetic valid control reservation, ends in ROLLBACK.\n${patchedProbes.join('\n')}\n`;

const files={
  'reserve_gate.root10-event-projection-fixed.sql':corrected,
  'root10-reserve-gate-event-projection-fix.apply-once.sql':apply,
  'root10-reserve-gate-event-projection-fix.full-rollback.sql':fullRollback
};
const manifest={
 schema_version:'root10-reserve-gate-event-projection-fix-build/1',
 state:'LOCAL_CORRECTIVE_SQL_BUILT_NOT_EXECUTED',authority_effect:'NONE',
 root_id:ROOT,generation_id:ROOT10,expected_current_sequence:117,expected_pending_budget_sequence:117,
 expected_active_ga_id:null,charged_seconds:11706,charged_evidence_bytes:2604247987,
 old_reserve_gate_catalog_sha256:OLD_CATALOG_SHA,new_reserve_gate_catalog_sha256:NEW_CATALOG_SHA,
 old_reserve_gate_source_sha256:OLD_SOURCE_SHA,new_reserve_gate_source_sha256:sha(corrected),
 corrected_predicates:['event114 normalized operation/body exact','event115 normalized operation/body exact','51-field GA gate_id plus unique accepted Gate artifact ref and existing binding Gate version/digest'],
 preserved:['event sequence','event idempotency key','binding_id','evidence bytes','all other reserve_gate predicates','function owner/ACL/config/security/volatility/kind/parallel/leakproof','Root10 state','budget117','zero Root10 GA'],
 negative_manifest_sha256:sha(negativeManifestRaw),accepted_plan_sha256:NEGATIVE_PLAN_SHA,probe_count:15,subcase_count:42,
 database_write:false,ga_issued:false,budget_changed:false,history_changed:false,
 files:Object.fromEntries(Object.entries(files).map(([n,v])=>[n,sha(v)]))
};
files['root10-reserve-gate-event-projection-fix.build.json']=JSON.stringify(manifest,null,2)+'\n';

const envelope=JSON.stringify({schema_version:'root10-reserve-gate-event-projection-fix-files/1',files:Object.entries(files).map(([name,content])=>({name,sha256:sha(content),content_base64:Buffer.from(content).toString('base64')}))});
if(outArg==='--stdout') process.stdout.write(envelope+'\n');
else{
 const out=path.resolve(outArg);fs.mkdirSync(out,{recursive:true});
 for(const [name,content] of Object.entries(files)) fs.writeFileSync(path.join(out,name),content,{encoding:'utf8',flag:'wx'});
 process.stdout.write(JSON.stringify({state:'BUILT_NOT_EXECUTED',outdir:out,files:manifest.files,new_reserve_gate_catalog_sha256:NEW_CATALOG_SHA})+'\n');
}
