// Original observation-only projection. Does not assemble assessments or issue a result.
import path from 'node:path';import {fileURLToPath} from 'node:url';import {sha,controller,moduleAt,successor} from './dependencies.mjs';
import {resolveSharedLocal,unpackLocalSources,applicabilityHash} from '../qualification-live-preparation/ordinary-local-sources.mjs';
const {checkGAShape}=await moduleAt(successor+'context.mjs');const {validatePackedDenialSource,beginOriginalInputVerification}=await moduleAt(successor+'original-inputs-blob.mjs');
const here=path.dirname(fileURLToPath(import.meta.url)),raw=x=>JSON.stringify(x)+'\n',need=(v,m)=>{if(!v)throw Error(m);},same=(a,b)=>raw(a)===raw(b),root='ctr_414bd3c724264a83894b0c55cf2ab878',prefix='urn:clued:execution-evidence:'+root+':';
export function createWrap(material){
need(typeof material?.runtime_acceptance?.raw==='string'&&typeof material?.gate_suite?.raw==='string','ACTUAL_RUNTIME_AND_SUITE_RAW_REQUIRED');
const runtime=JSON.parse(material.runtime_acceptance.raw),accepted=runtime.accepted_subject,suite=JSON.parse(material.gate_suite.raw),suiteSha=sha(material.gate_suite.raw),ids=Object.keys(suite.tests).sort();
need(runtime.state==='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'&&accepted.expected_ga.controller_digest===controller&&suiteSha===accepted.gate_suite_ref.sha256&&ids.length===19&&!ids.includes('PQUAL-18'),'EXACT_CURRENT_ACCEPTED_NINETEEN_SUITE');
function safe(v){if(typeof v==='number')need(Number.isSafeInteger(v),'UNSAFE_NUMBER');else if(v&&typeof v==='object')for(const x of Object.values(v))safe(x);}
function exact(s,limit=131072){need(typeof s==='string'&&Buffer.byteLength(s)<=limit,'MISSING_OR_OVERSIZED_ORIGINAL_RAW');const x=JSON.parse(s);safe(x);need(raw(x)===s,'EXACT_COMPACT_LF_ORIGINAL_BYTES_REQUIRED');return x;}
function gaFrom(s){const ga=checkGAShape(s);need(ga.controller_digest===controller&&sha(material.gate_suite.raw)===accepted.gate_suite_ref.sha256&&ga.plan_digest===suiteSha,'EXACT_CURRENT_GA_SUITE');return ga;}
function artifact(s){need(Buffer.byteLength(s)<=131072,'ARTIFACT_EXCEEDS_131072');return {uri:prefix+sha(s),sha256:sha(s),raw:s};}
const ref=x=>({uri:x.uri,sha256:x.sha256});
function timestamp(s){need(typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,19)===s.slice(0,19),'ACTUAL_VALID_SOURCE_TIME_REQUIRED');return s;}
function refsEqual(a,b){return same(a.map(x=>x.uri+'\0'+x.sha256).sort(),b.map(x=>x.uri+'\0'+x.sha256).sort());}
function reference(x){need(x&&Object.keys(x).sort().join(',')==='sha256,uri'&&typeof x.uri==='string'&&x.uri.length>0&&/^[0-9a-f]{64}$/.test(x.sha256),'EXACT_NONEMPTY_REFERENCE');return x;}
function componentReference(x){reference(x?.ref);need(/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[0-9a-f]{40}$/.test(x.ref.uri)&&x.sha256===x.ref.sha256&&Number.isSafeInteger(x.bytes)&&x.bytes>0&&/^[0-9a-f]{40}$/.test(x.owner_merge)&&typeof x.artifact_path==='string'&&x.artifact_path.length>0,'COMPLETE_IMMUTABLE_COMPONENT_SOURCE_DESCRIPTOR');}
function localSupport(x,report,readbackAt){
 const expected='1e97291caa7ca1cec1987396c776cc206d867c0bf5f8915a65bc99e8220096bf';
 need(x?.read_origin==='LOCAL_FILESYSTEM_EXACT_REPORT_BOUND_SUPPORT'&&x.local_path===path.resolve(here,'../runtime-store-independent-targeted.mjs').replaceAll('\\','/')&&x.executed===false&&x.owner_merge===undefined&&x.ref===undefined,'EXACT_LOCAL_SUPPORT_ORIGIN_NOT_REMOTE');
 need(typeof x.raw==='string'&&sha(x.raw)===expected&&x.sha256===expected&&x.bytes===Buffer.byteLength(x.raw)&&x.bytes>0&&x.bytes<=65536,'FULL_EXACT_LOCAL_SUPPORT_BYTES_REQUIRED');
 reference(x.report_ref);need(same(x.report_ref,report.ref)&&x.report_field==='/validation/independent_script_sha256','SIGNED_PRIMARY_REPORT_SCRIPT_FIELD_BINDING');
 timestamp(x.read_at);timestamp(readbackAt);need(Date.parse(x.read_at)<=Date.parse(readbackAt),'LOCAL_READ_PRECEDES_READBACK');
}
function missing(input,names){return names.filter(n=>input?.[n]===undefined||input[n]===null);}
function blocked(fields){return {state:'BLOCKED_MISSING_REAL_INPUT',missing:fields,authority_effect:'NONE',signed:false,receipt_issued:false};}

function wrapSource(gaRaw,item,sharedArtifacts=[]){
 const ga=JSON.parse(gaRaw),gaSha=sha(gaRaw);
 need(ids.includes(item?.test_id)&&typeof item.raw==='string'&&sha(item.raw)===item.sha256,'EXACT_REAL_CASE_SOURCE_REQUIRED');
 const source=exact(item.raw);let observed;
 switch(source.kind){
  case 'ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION':need(source.baseline_ga_sha256===gaSha,'THIS_GA_DENIAL_SOURCE');observed=source.started_at;break;
  case 'HISTORICAL_ACTUAL_COMPONENT_EVIDENCE_REVALIDATED':need(source.current_ga_id===ga.gate_authorization_id&&source.current_ga_sha256===gaSha&&source.pg_started===false&&source.original_raw===undefined,'EXACT_READBACK_WRAPPER_NO_INLINE_HISTORICAL_RAW');observed=source.revalidated_at;break;
  case 'ACTUAL_ADDITIONAL_COMPONENT_EVIDENCE_READBACK':
   need(['PQUAL-11','PQUAL-16','PQUAL-17'].includes(item.test_id)&&source.current_ga_id===ga.gate_authorization_id&&source.current_ga_sha256===gaSha&&source.original_tests_rerun===false&&source.current_ga_component_fault_injected===false,'THIS_GA_READBACK_NOT_ORIGINAL_EXECUTION');
   reference(source.original_report?.ref);need(source.original_report.sha256===source.original_report.ref.sha256&&Number.isSafeInteger(source.original_report.bytes)&&source.original_report.bytes>0,'ORIGINAL_IMMUTABLE_COMPONENT_BYTES');
   componentReference(source.original_report);
   if(source.independent_applicability?.shared_artifact_ref){const a=resolveSharedLocal(source.independent_applicability,sharedArtifacts);need(a.sha256===applicabilityHash,'EXACT_LOCAL_APPLICABILITY');timestamp(source.readback_at);need(Date.parse(a.read_at)<=Date.parse(source.readback_at),'APPLICABILITY_READ_PRECEDES_READBACK');}
   else componentReference(source.independent_applicability);
   {const originals={'PQUAL-11':'faa4de43485be886804fa8a0b9d1619c7efcd7988b125a7f4446bccc28937892','PQUAL-16':'62e09c32a24da5d855408e59ac4b9e6362d7dbbf68e70c70745cd465480019cd','PQUAL-17':'f178b211420f48d5704c9e0d70996a35abdc89d0585df6ddc446c30f84a051ca'};
    const supporting={'PQUAL-11':['93f43cca4b5cde7c5c1a75b9eef5c5b612306c3367f7c000e209259a4703d717','b980f0574e33ff4052d38c15d7a7f9e6868ccfde1aafb83cc56d3146c5fc9a8b'],'PQUAL-16':['1e97291caa7ca1cec1987396c776cc206d867c0bf5f8915a65bc99e8220096bf'],'PQUAL-17':[]};
    need(source.original_report.sha256===originals[item.test_id]&&Array.isArray(source.supplementary_sources)&&same(source.supplementary_sources.map(x=>x.sha256).sort(),supporting[item.test_id].sort()),'ALL_EXACT_ORIGINAL_SUPPORT_REFERENCES_REQUIRED');source.supplementary_sources.forEach(x=>item.test_id==='PQUAL-16'?localSupport(x.shared_artifact_ref?resolveSharedLocal(x,sharedArtifacts):x,source.original_report,source.readback_at):componentReference(x));}
   need(source.independent_applicability?.sha256==='433913315714fb00deb3ebdefda5c9b52588d7bc2fb4318780ed6e01cfb795a1'&&source.original_report_time_meaning&&source.original_execution_boundary,'EXACT_ACCEPTED_COMPONENT_APPLICABILITY');
   timestamp(source.original_report_time);observed=source.readback_at;break;
  case 'ACTUAL_PUBLICATION_REVISION_GUARD_OBSERVATION':need(source.controller_digest===ga.controller_digest&&source.original_owner_merge===ga.target_revision&&same(source.original_source_ref,ga.source_ref),'EXACT_THIS_GA_PUBLICATION_SOURCE');observed=source.observed_at;break;
  case 'ACTUAL_FIXED_SYNTHETIC_FIXTURE_AND_STOP_OBSERVATION':
  case 'ACTUAL_CLEANUP_NO_BROADER_AUTHORITY_OBSERVATION':need(source.ga_id===ga.gate_authorization_id&&source.ga_sha256===gaSha,'THIS_GA_ACTUAL_HOST_SOURCE');observed=source.observed_at;break;
  default:throw Error('UNACCEPTED_OR_NONEXECUTED_SOURCE_KIND');
 }
 need(source.test_id===item.test_id,'SAME_SOURCE_TEST');timestamp(observed);
 need(Date.parse(observed)>=Date.parse(ga.issued_at),'SOURCE_PREDATES_THIS_GA_MEASUREMENT');
 const result=artifact(raw({kind:'ACTUAL_TEST_OBSERVATION',ga_id:ga.gate_authorization_id,ga_sha256:gaSha,test_id:item.test_id,observed_at:observed,source:{raw:item.raw,sha256:item.sha256}}));
 return {...result,test_id:item.test_id,source_kind:source.kind};
}
function wrap(input){
 const absent=missing(input,['ga_raw','source_observations','shared_artifacts']);if(absent.length)return blocked(absent);
 const ga=gaFrom(input.ga_raw);need(Array.isArray(input.source_observations)&&input.source_observations.length>0&&input.source_observations.length<=200,'NONEMPTY_REAL_SOURCE_OBSERVATIONS');
 need(Array.isArray(input.shared_artifacts),'SHARED_ARTIFACT_ARRAY');
 const shared=input.shared_artifacts.map(x=>{const p=exact(x.raw);need(x.sha256===sha(x.raw)&&x.uri===prefix+x.sha256,'EXACT_SHARED_INPUT');if(p.kind==='EXACT_ORDINARY_LOCAL_COMPONENT_SOURCES_DEFLATE_V1')unpackLocalSources(x);else need(p.kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V3_3000000','FIXED_SHARED_ARTIFACT_KIND');return artifact(x.raw);});
 need(new Set(shared.map(x=>JSON.parse(x.raw).kind)).size===shared.length&&shared.length<=2,'ONE_SHARED_ARTIFACT_PER_FIXED_DOMAIN');
 const observations=input.source_observations.map(x=>wrapSource(input.ga_raw,x,shared));
 need(new Set(observations.map(x=>x.uri)).size===observations.length,'DUPLICATE_SUBCASE_SOURCE_NOT_NEW_COVERAGE');
 const verificationSession=beginOriginalInputVerification();
 const packed=shared.filter(x=>JSON.parse(x.raw).kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V3_3000000');
 for(const source of input.source_observations.filter(x=>JSON.parse(x.raw).kind==='ACTUAL_VERIFIER_REQUEST_DENIAL_OBSERVATION')){need(packed.length===1,'MISSING_SHARED_PACKED_INPUT');validatePackedDenialSource({packedRaw:packed[0].raw,sourceRaw:source.raw,verificationSession});}
 const tests=ids.filter(id=>observations.some(o=>o.test_id===id)).map(id=>({test_id:id,test_definition_digest:sha(JSON.stringify(suite.tests[id],null,2)+'\n'),expected_outcome_digest:suite.tests[id].oracle.source_oracle_sha256,observation_refs:observations.filter(o=>o.test_id===id).map(ref)}));
 const artifacts=[...shared,...observations.map(({uri,sha256,raw})=>({uri,sha256,raw}))];
 return {state:'OBSERVATIONS_ASSEMBLED_AWAITING_ACTUAL_INDEPENDENT_ASSESSMENTS',ga_id:ga.gate_authorization_id,ga_sha256:sha(input.ga_raw),suite_sha256:suiteSha,artifacts,tests,missing_cases:ids.filter(id=>!tests.some(t=>t.test_id===id)),source_observation_count:observations.length,independent_assessments_created:false,oracle_pass_claimed:false,authority_effect:'NONE'};
}

return {wrap,wrapSource};
}
