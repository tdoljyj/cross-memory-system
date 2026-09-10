// Ordinary supplementary Evidence readback. No execution replay, control object or admission.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha,repo,manifest,moduleAt,successor} from './dependencies.mjs';
import {applicabilityHash,readLocalApplicability,packLocalSources,sharedDescriptor} from '../qualification-live-preparation/ordinary-local-sources.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),runtime=path.join(repo,successor);
const ghPath='scripts/phase2-qualification/control-context-verifier-runtime600/trusted-github.mjs';
if(!manifest.files.some(f=>f.path===ghPath&&f.sha256===sha(fs.readFileSync(path.join(repo,ghPath)))))throw Error('EXACT_FROZEN_READ_ONLY_GITHUB_SOURCE');
const {readBlobRef,verifyOwnerMergeArtifact}=await import(pathToFileURL(path.join(repo,ghPath)));
const {checkGAShape}=await import(pathToFileURL(path.join(runtime,'context.mjs')));
const need=(v,m)=>{if(!v)throw Error(m);},raw=x=>JSON.stringify(x)+'\n',same=(a,b)=>raw(a)===raw(b);
export const sources={
 'PQUAL-11':{primary:'faa4de43485be886804fa8a0b9d1619c7efcd7988b125a7f4446bccc28937892',time_field:'decided_at_utc',report_time:'2026-09-08T14:59:14.855Z',time_meaning:'INDEPENDENT_REVIEW_DECISION_TIME_NOT_ORIGINAL_TEST_START',original_test_utc:'NOT_RECORDED',supplementary:['93f43cca4b5cde7c5c1a75b9eef5c5b612306c3367f7c000e209259a4703d717','b980f0574e33ff4052d38c15d7a7f9e6868ccfde1aafb83cc56d3146c5fc9a8b'],boundary:'Original mocked real-function guard tests,4PASS0.025s. No actual dead watchdog or Docker process was injected; original test UTC was not recorded.'},
 'PQUAL-16':{primary:'62e09c32a24da5d855408e59ac4b9e6362d7dbbf68e70c70745cd465480019cd',time_field:'observed_at',report_time:'2026-09-08T14:31:08.052Z',time_meaning:'INDEPENDENT_REPORT_OBSERVATION_TIME_NOT_ORIGINAL_PG_START',original_test_utc:'NOT_RECORDED_AS_START',supplementary:['1e97291caa7ca1cec1987396c776cc206d867c0bf5f8915a65bc99e8220096bf'],boundary:'Original independent real PG targeted duplicate-GRR check,2PASS3170.2975ms. Current GA reads that evidence; it does not run another PG test or issue duplicate receipts.'},
 'PQUAL-17':{primary:'f178b211420f48d5704c9e0d70996a35abdc89d0585df6ddc446c30f84a051ca',time_field:'observed_at',report_time:'2026-09-08T17:51:11.655Z',time_meaning:'INDEPENDENT_CONTROLLED_VM_FAULT_OBSERVATION_TIME',original_test_utc:'AS_RECORDED_IN_PRIMARY_REPORT',supplementary:[],boundary:'Unchanged actual fixed tool source executed in a VM with explicit synthetic external SQL/process/session ports. No real Supabase outage, Node session or Docker execution occurred.'}
};
function verifiedSource(entry,expected){
 need(entry?.ref?.sha256===expected,'EXACT_ACTUAL_COMPONENT_SOURCE_REF');
 const bytes=readBlobRef(entry.ref),publication=verifyOwnerMergeArtifact({...entry.publication,raw:bytes});
 need(same(publication.blob_ref,entry.ref),'ACTUAL_OWNER_MERGE_COMPONENT_BLOB_BINDING');
 return {bytes,record:{ref:entry.ref,bytes:Buffer.byteLength(bytes),sha256:sha(bytes),owner_merge:entry.publication.commitSha,artifact_path:entry.publication.artifactPath}};
}
// Ordinary support bytes, not a new publication or authority. The calling reader has
// already verified the exact primary report's real Owner-merge publication.
export function readLocalReportBoundSupport(primaryRaw,primaryRecord){
 const binding=sources['PQUAL-16'],report=JSON.parse(primaryRaw),expected=binding.supplementary[0];
 need(sha(primaryRaw)===binding.primary&&primaryRecord?.sha256===binding.primary&&primaryRecord.ref?.sha256===binding.primary,'EXACT_PRIMARY_REPORT_BYTES_FOR_LOCAL_SUPPORT');
 need(report.validation?.independent_script_sha256===expected,'SIGNED_REPORT_EXACT_SCRIPT_HASH_FIELD');
 const file=path.resolve(here,'../runtime-store-independent-targeted.mjs');
 for(let p=file;;p=path.dirname(p)){need(!fs.lstatSync(p).isSymbolicLink(),'UNLINKED_FIXED_LOCAL_SUPPORT');if(p===path.dirname(p))break;}
 const stat=fs.statSync(file);need(stat.isFile()&&stat.size>0&&stat.size<=65536,'BOUNDED_FIXED_LOCAL_SUPPORT');
 const bytes=fs.readFileSync(file),text=bytes.toString('utf8');
 need(sha(bytes)===expected&&Buffer.from(text,'utf8').equals(bytes),'EXACT_LOSSLESS_REPORT_BOUND_LOCAL_BYTES');
 return {read_origin:'LOCAL_FILESYSTEM_EXACT_REPORT_BOUND_SUPPORT',local_path:file.replaceAll('\\','/'),raw:text,bytes:bytes.length,sha256:expected,read_at:new Date().toISOString(),report_ref:primaryRecord.ref,report_field:'/validation/independent_script_sha256',executed:false};
}
export function readAdditionalComponents(input){
 const absent=['ga_raw','entries','applicability'].filter(k=>!input?.[k]);if(absent.length)return {state:'BLOCKED_MISSING_REAL_SOURCE_PUBLICATION',missing:absent,authority_effect:'NONE'};
 const ga=checkGAShape(input.ga_raw),gaSha=sha(input.ga_raw);
 need(ga.controller_digest==='07e0be02895363bac5ced923924f27b8de1f7951d8eea2c829831afef9bb27aa','EXACT_CURRENT_CONTROLLER');
 need(Array.isArray(input.entries)&&input.entries.length>0&&input.entries.length<=3&&new Set(input.entries.map(e=>e.test_id)).size===input.entries.length,'ONE_READBACK_PER_FIXED_SUPPLEMENTARY_CASE');
 // This exact ordinary report was actually received from the named independent agent.
 // Its local bytes are evidence, not a self-authenticating authority or new publication.
 need(same(input.applicability,{read_origin:'LOCAL_FILESYSTEM_NAMED_INDEPENDENT_EVIDENCE',sha256:applicabilityHash}),'FIXED_ALREADY_RECEIVED_APPLICABILITY_SELECTOR');
 const applicable=readLocalApplicability(),values=[];
 for(const entry of input.entries){
  const binding=sources[entry.test_id];need(binding,'FIXED_SUPPLEMENTARY_CASE_ONLY');
  const primary=verifiedSource(entry.primary,binding.primary),original=JSON.parse(primary.bytes);
  need(original.independent_reviewer==='/root/project_list_auth_fix'&&original[binding.time_field]===binding.report_time,'EXACT_ORIGINAL_REPORT_IDENTITY_AND_TIME');
  need(Array.isArray(entry.supplementary),'COMPLETE_REQUIRED_ORIGINAL_SUPPORT_SOURCES');
  let supplemental;
  if(entry.test_id==='PQUAL-16'){
   need(entry.supplementary.length===0,'FIXED_LOCAL_REPORT_BOUND_SUPPORT_NO_CALLER_PATH_OR_PUBLICATION');
   supplemental=[readLocalReportBoundSupport(primary.bytes,primary.record)];
  }else{
   need(same(entry.supplementary.map(x=>x.ref.sha256).sort(),[...binding.supplementary].sort()),'COMPLETE_REQUIRED_ORIGINAL_SUPPORT_SOURCES');
   supplemental=entry.supplementary.map(e=>verifiedSource(e,e.ref.sha256).record);
  }
  const at=new Date().toISOString();need(Date.parse(at)>=Date.parse(ga.issued_at),'READBACK_CANNOT_PREDATE_CURRENT_GA');
  const value={kind:'ACTUAL_ADDITIONAL_COMPONENT_EVIDENCE_READBACK',test_id:entry.test_id,current_ga_id:ga.gate_authorization_id,current_ga_sha256:gaSha,readback_at:at,
   original_report:primary.record,original_report_time:binding.report_time,original_report_time_meaning:binding.time_meaning,original_test_utc:binding.original_test_utc,
   supplementary_sources:supplemental,independent_applicability:applicable,
   method:'Primary reports and P11 support actually fetched as immutable Git blobs with real Owner-merge verification. Already received independent applicability, and P16 report-bound support when applicable, actually read from fixed local paths; complete lossless raw/hash/bytes/read times retained once in the shared ordinary artifact. Local files are not claimed to have remote publication. This observation records current readback, not original execution or an oracle result.',
   original_execution_boundary:binding.boundary,controller_manifest_sha256:ga.controller_digest,original_tests_rerun:false,current_ga_component_fault_injected:false,complete_case_pass:false,authority_effect:'NONE'};
  values.push(value);
 }
 const localSupport=values.flatMap(v=>v.supplementary_sources).filter(s=>s.read_origin==='LOCAL_FILESYSTEM_EXACT_REPORT_BOUND_SUPPORT');
 const shared=packLocalSources([applicable,...localSupport]),results=values.map(value=>{
  value.independent_applicability=sharedDescriptor(applicable,shared);
  value.supplementary_sources=value.supplementary_sources.map(s=>s.read_origin==='LOCAL_FILESYSTEM_EXACT_REPORT_BOUND_SUPPORT'?sharedDescriptor(s,shared):s);
  const bytes=raw(value);return {test_id:value.test_id,raw:bytes,sha256:sha(bytes)};
 });
 return {state:'ACTUAL_SUPPLEMENTARY_COMPONENT_BYTES_READ_BACK_NOT_ORACLE',results,shared_artifacts:[shared],authority_effect:'NONE',control_object_created:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [a,b]=process.argv.slice(2);need(a&&b&&process.argv.length===4,'USAGE: component-readback.mjs INPUT.json OUTPUT.json');
  const local=p=>{const f=path.resolve(p),r=path.relative(here,f);need(r&&!r.startsWith('..')&&!path.isAbsolute(r),'PREPARATION_DIRECTORY_ONLY');for(let x=path.dirname(f);x!==here;x=path.dirname(x))need(!fs.lstatSync(x).isSymbolicLink(),'UNLINKED_PREPARATION_PATH');return f;};
  const inputFile=local(a),outputFile=local(b);need(!fs.lstatSync(inputFile).isSymbolicLink()&&fs.statSync(inputFile).size<=1048576,'BOUNDED_REAL_INPUT_FILE');
  const result=readAdditionalComponents(JSON.parse(fs.readFileSync(inputFile,'utf8')));fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({state:result.state,path:outputFile,sha256:sha(fs.readFileSync(outputFile)),authority_effect:'NONE'})+'\n');if(result.state.startsWith('BLOCKED'))process.exitCode=2;
 }catch(e){process.stdout.write(JSON.stringify({state:'BLOCKED_SOURCE_NOT_VERIFIED',reason:e.message,authority_effect:'NONE'})+'\n');process.exitCode=2;}
}
