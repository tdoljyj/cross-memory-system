// Measurement-only integration. Every network operation uses the existing
// report request function; no token, retry, parallel worker or new CI trigger.
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {captureNativeAttempt,emptyNativePopulationStore,inspectNativePopulationStore,nativeJobIsNonExecution} from './merge-admission-native-population.mjs';
import {readMergeAdmissionFourSources,parseFourSourceRawData} from './merge-admission-four-sources.mjs';
import {integrateClockSourceCandidate} from './merge-admission-clock-source.mjs';
import {registeredWorkflowSource,rolesForSource,workflowBlob,parseWorkflowProfiles} from './clued-workflow-profile.mjs';
import {timestampMicros} from './merge-admission-measurement-history.mjs';
import {collectNaturalSourceArtifacts} from './merge-admission-natural-intake.mjs';
import {assembleNaturalFourSourceFrame,excludeQuarantinedMainMoves} from './merge-admission-natural-frame.mjs';
import {collectNativeActivity} from './merge-admission-native-activity.mjs';
import {R9_RUNTIME_CONFIG} from './merge-admission-r9-runtime-inputs.mjs';

export const R9_ARTIFACT_NAME='merge-admission-r9-sealed-packets';
export const R9_PACKET_FILE='r9-sealed-packet.json';
export const R9_CACHE_FILE='r9-artifact-cache.json';
export const R9_PACKET_SCHEMA='clued.merge-admission-r9-sealed-packet/2';
export const R9_CACHE_SCHEMA='clued.merge-admission-r9-artifact-cache/1';
// Keep the existing duplicate-key/depth guard as well as the disk/3 codec.
const profileCatalogue=raw=>{parseFourSourceRawData(raw);return parseWorkflowProfiles(raw);};
export const R9_PUBLISHER_PATH='.github/workflows/clued-ci-usage-report.yml';
export const R9_SOURCE_PATHS=Object.freeze([
  R9_PUBLISHER_PATH,'scripts/ci/ci-usage-report.mjs','scripts/ci/merge-admission-r9-collector.mjs',
  'scripts/ci/merge-admission-native-population.mjs','scripts/ci/merge-admission-four-sources.mjs',
  'scripts/ci/merge-admission-clock-source.mjs','scripts/ci/merge-admission-measurement-history.mjs',
  'scripts/ci/clued-gated-proof.mjs','scripts/ci/clued-workflow-profile.mjs',
  'scripts/ci/merge-admission-r9-runtime-inputs.mjs','scripts/ci/merge-admission-source-producer.mjs',
  'scripts/ci/merge-admission-natural-intake.mjs',
  'scripts/ci/merge-admission-natural-frame.mjs',
  'scripts/ci/merge-admission-native-activity.mjs',R9_RUNTIME_CONFIG,
]);
const MAX_BYTES=32*1024*1024, MAX_RUNS=100000;
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const id=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0?String(x):typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)?x:null;
const fail=code=>{throw Error(code);};
const reason=e=>typeof e?.message==='string'&&/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'R9_COLLECTION_FAILED';
const time=x=>{try{return typeof x==='string'&&timestampMicros(x)>=0n;}catch{return false;}};
const sorted=x=>[...x].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);
async function bodyOf(request,route,options){const r=await request(route,options);if(r?.ok!==true)fail('R9_'+String(r?.stopped??'REQUEST_REFUSED').toUpperCase());return r.body;}
function repositoryOf(repository){if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository??''))fail('REPOSITORY_INVALID');return repository;}

// A slice is a scheduling share of the SAME run budget, not another budget.
// Exhausting this slice does not stop collectUsage from using the remainder.
export function r9RequestSlice(request,budget){
  const allowance=budget.source==='app'&&Number.isSafeInteger(budget.cap)&&Number.isSafeInteger(budget.used??0)
    ?Math.max(0,Math.min(1500,Math.floor(budget.cap*3/4),budget.cap-(budget.used??0)-500)):0;let used=0;
  return {get used(){return used;},allowance,async request(route,options){
    if(used>=allowance)return {ok:false,stopped:'r9_slice_exhausted'};
    used++;return request(route,options);
  }};
}
export function emptyR9ArtifactCache(repository){return JSON.stringify({schema:R9_CACHE_SCHEMA,repository,artifact_id:null,zip_base64:null});}

// No extraction to disk. Only a bounded, ordinary non-encrypted ZIP containing
// the one exact JSON member is supported; paths/symlinks/ZIP64 are refused.
export function readSealedPacketZip(bytes,expectedMember=R9_PACKET_FILE){
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES||bytes.length<22)fail('ARTIFACT_ZIP_INVALID');
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0||bytes.readUInt16LE(end+8)!==1||
    bytes.readUInt16LE(end+10)!==1||end+22+bytes.readUInt16LE(end+20)!==bytes.length)fail('ARTIFACT_ZIP_INVALID');
  const at=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
  if(at+size!==end||at+46>end||bytes.readUInt32LE(at)!==0x02014b50)fail('ARTIFACT_ZIP_INVALID');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),compressed=bytes.readUInt32LE(at+20),length=bytes.readUInt32LE(at+24);
  const names=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
  if((flags&~0x808)!==0||![0,8].includes(method)||length>MAX_BYTES||bytes.readUInt16LE(at+34)!==0||
    (bytes.readUInt32LE(at+38)>>>16&0xf000)===0xa000||at+46+names+extra+comment!==end||
    bytes.subarray(at+46,at+46+names).toString('utf8')!==expectedMember||offset+30>at||bytes.readUInt32LE(offset)!==0x04034b50||
    bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method||
    ((flags&8)===0&&(bytes.readUInt32LE(offset+18)!==compressed||bytes.readUInt32LE(offset+22)!==length))||
    bytes.readUInt16LE(offset+26)!==names)fail('ARTIFACT_ZIP_INVALID');
  const start=offset+30+names+bytes.readUInt16LE(offset+28);
  const dataEnd=start+compressed;
  if(bytes.subarray(offset+30,offset+30+names).toString('utf8')!==expectedMember||dataEnd>at)fail('ARTIFACT_ZIP_INVALID');
  if(flags&8){const n=at-dataEnd;let d=dataEnd;
    if(n===16&&bytes.readUInt32LE(d)===0x08074b50)d+=4;else if(n!==12)fail('ARTIFACT_ZIP_INVALID');
    if(bytes.readUInt32LE(d)!==bytes.readUInt32LE(at+16)||bytes.readUInt32LE(d+4)!==compressed||bytes.readUInt32LE(d+8)!==length)fail('ARTIFACT_ZIP_INVALID');
  }else if(dataEnd!==at)fail('ARTIFACT_ZIP_INVALID');
  const raw=method===0?bytes.subarray(start,dataEnd):inflateRawSync(bytes.subarray(start,dataEnd),{maxOutputLength:MAX_BYTES});
  if(raw.length!==length||Buffer.from(raw.toString('utf8')).compare(raw)!==0)fail('ARTIFACT_ZIP_INVALID');
  return raw.toString('utf8');
}
async function sourceText(request,repository,file,ref){
  const p=await bodyOf(request,`/repos/${repository}/contents/${file}?ref=${encodeURIComponent(ref)}`);
  if(p?.type!=='file'||p.path!==file||p.encoding!=='base64'||typeof p.content!=='string'||!sha(p.sha))fail('NATIVE_SOURCE_INVALID');
  const bytes=Buffer.from(p.content.replace(/\s/g,''),'base64'),text=bytes.toString('utf8');
  if(bytes.length>MAX_BYTES||Buffer.from(text).compare(bytes)!==0||workflowBlob(text)!==p.sha)fail('NATIVE_SOURCE_INVALID');
  return {text,blob:p.sha};
}
export async function loadR9DefaultBranchContract({request,repository}){
  repositoryOf(repository);
  const repo=await bodyOf(request,`/repos/${repository}`);
  if(repo?.full_name!==repository||!id(repo.id)||typeof repo.default_branch!=='string'||!repo.default_branch||repo.default_branch.length>200)fail('NATIVE_REPOSITORY_INVALID');
  const branch=await bodyOf(request,`/repos/${repository}/branches/${encodeURIComponent(repo.default_branch)}`),head=branch?.commit?.sha;
  if(branch?.name!==repo.default_branch||!sha(head))fail('NATIVE_DEFAULT_BRANCH_INVALID');
  const profiles=await sourceText(request,repository,'scripts/ci/clued-gated-proof-profiles.json',head);
  const roles=await sourceText(request,repository,'scripts/ci/clued-gated-proof-role-specs.json',head);
  const tree=await bodyOf(request,`/repos/${repository}/git/trees/${head}?recursive=1`);
  if(tree.truncated!==false||!Array.isArray(tree.tree)||new Set(tree.tree.map(x=>x.path)).size!==tree.tree.length)fail('NATIVE_SOURCE_TREE_INVALID');
  let r9Registry=null;try{r9Registry=parseFourSourceRawData((await sourceText(request,repository,R9_RUNTIME_CONFIG,head)).text);}catch{}
  return {repository,repository_id:String(repo.id),default_branch:repo.default_branch,head_sha:head,
    profiles:profileCatalogue(profiles.text),roles:parseFourSourceRawData(roles.text),
    profiles_sha256:hash(profiles.text),role_specs_sha256:hash(roles.text),
    source_tree:Object.fromEntries(tree.tree.map(x=>[x.path,{sha:x.sha,type:x.type,mode:x.mode}])),
    r9_registry:r9Registry,native_source_refs:[profiles.blob,roles.blob]};
}
// Observation-publisher roles live in the protected R9 registry. Registering a
// non-PR measurement job must never add it to the gated PR workflow catalogue.
function publisherRole(contract,wfBlob,wfText){
  const cfg=contract.r9_registry,r=cfg?.publisher_role;
  if(cfg?.schema==='clued.r9-runtime-source-selection/1'&&cfg.repository===contract.repository&&cfg.registration_status==='registered'&&
    r?.registration_status==='registered'&&r.workflow_path===R9_PUBLISHER_PATH&&r.workflow_blob===wfBlob&&r.workflow_source_sha256===hash(wfText)&&
    r.job_id==='report'&&r.self_hosted===false&&r.job_name==='clued-ci-usage-report'&&object(r.required_steps)&&
    r.required_steps['Measure CI usage']===1&&Object.values(r.required_steps).every(n=>Number.isSafeInteger(n)&&n>0))
    return {job_id:r.job_id,name:r.job_name,self_hosted:false,required_steps:r.required_steps};
  // Retain the already supported actual registered-source contract; no default
  // or proposed role becomes registered by hashing/compiling itself.
  const p=registeredWorkflowSource(contract.profiles,R9_PUBLISHER_PATH,wfBlob),roles=rolesForSource(contract.roles,R9_PUBLISHER_PATH,wfBlob);
  return p.passed&&roles?.some(r=>r.job_id==='report')?p.profile.routes.find(r=>r.job_id==='report'):null;
}
function packetShape(raw,repository){
  const p=parseFourSourceRawData(raw);
  if(!exact(p,['schema','repository','publisher','source_blobs','window','sealed_at','native_store_raw','four_source','clock','natural_inputs'])||
    p.schema!==R9_PACKET_SCHEMA||p.repository!==repository||!exact(p.publisher,['run_id','run_attempt','head_sha','workflow_path','job_id'])||
    !id(p.publisher.run_id)||!Number.isSafeInteger(p.publisher.run_attempt)||p.publisher.run_attempt<1||!sha(p.publisher.head_sha)||
    p.publisher.workflow_path!==R9_PUBLISHER_PATH||p.publisher.job_id!=='report'||
    p.window!==null&&(!exact(p.window,['start','end'])||!time(p.window.start)||!time(p.window.end)||timestampMicros(p.window.start)>=timestampMicros(p.window.end))||!time(p.sealed_at)||
    !exact(p.source_blobs,R9_SOURCE_PATHS)||Object.values(p.source_blobs).some(v=>!sha(v))||
    inspectNativePopulationStore(p.native_store_raw,repository).status!=='VALID_DATA_STORE'||
    p.four_source!==null&&(!exact(p.four_source,['packet_raw','expected_sources_raw'])||Object.values(p.four_source).some(x=>typeof x!=='string'))||
    p.clock!==null&&(![ ['pages_raw','options_raw'],['pages_raw','options_raw','transport_raw'] ].some(keys=>exact(p.clock,keys))||Object.values(p.clock).some(x=>typeof x!=='string'))||
    p.natural_inputs!==null&&(!object(p.natural_inputs)||p.natural_inputs.schema!=='clued.r9-natural-origin-cache/1'||!Array.isArray(p.natural_inputs.entries)||!Array.isArray(p.natural_inputs.gaps)))fail('SEALED_PACKET_SCHEMA_INVALID');
  if(p.window===null&&(p.four_source!==null||p.clock!==null||p.natural_inputs!==null||Object.keys(inspectNativePopulationStore(p.native_store_raw,repository).packets??{}).length))fail('BOOTSTRAP_PACKET_CANNOT_CONTAIN_OBSERVATIONS');
  return p;
}

// Proves an entire immutable artifact once, including all enclosed packets.
// Legacy runs.json and caller-provided authority/source flags are never read.
export async function verifyR9SealedArtifact({request,repository,contract,artifactId,zipBytes}){
  try{
    if(contract?.repository!==repository||!id(artifactId))fail('ARTIFACT_ID_INVALID');
    const metadata=await bodyOf(request,`/repos/${repository}/actions/artifacts/${artifactId}`);
    if(String(metadata?.id)!==String(artifactId)||metadata.name!==R9_ARTIFACT_NAME||metadata.expired!==false||
      typeof metadata.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(metadata.digest)||!id(metadata.workflow_run?.id)||
      !sha(metadata.workflow_run?.head_sha)||metadata.workflow_run?.head_branch!==contract.default_branch)fail('ARTIFACT_NATIVE_METADATA_INVALID');
    const bytes=zipBytes??await bodyOf(request,`/repos/${repository}/actions/artifacts/${artifactId}/zip`,{responseType:'bytes'});
    if(!Buffer.isBuffer(bytes)||hash(bytes)!==metadata.digest.slice(7))fail('ARTIFACT_DIGEST_MISMATCH');
    const packet=packetShape(readSealedPacketZip(bytes),repository),p=packet.publisher;
    if(String(metadata.workflow_run.id)!==String(p.run_id)||metadata.workflow_run.head_sha!==p.head_sha)fail('ARTIFACT_RUN_BINDING_INVALID');
    const native=await captureNativeAttempt({request,repository,runId:p.run_id,attempt:p.run_attempt});
    if(native.status!=='COMPLETE'||native.packet.run.status!=='completed'||native.packet.run.conclusion!=='success'||
      native.packet.run.head_sha!==p.head_sha||native.packet.run.path.split('@')[0]!==R9_PUBLISHER_PATH||
      !['schedule','workflow_dispatch'].includes(native.packet.run.event))fail('ARTIFACT_PUBLISHER_RUN_UNQUALIFIED');
    const run=await bodyOf(request,`/repos/${repository}/actions/runs/${p.run_id}/attempts/${p.run_attempt}`);
    if(run?.head_repository?.full_name!==repository||run?.head_branch!==contract.default_branch||!Array.isArray(run.pull_requests)||run.pull_requests.length)fail('ARTIFACT_PUBLISHER_ORIGIN_INVALID');
    const compare=await bodyOf(request,`/repos/${repository}/compare/${p.head_sha}...${contract.head_sha}`);
    if(!['ahead','identical'].includes(compare?.status)||compare.merge_base_commit?.sha!==p.head_sha)fail('PUBLISHER_NOT_DEFAULT_BRANCH_HISTORY');
    const wf=await sourceText(request,repository,R9_PUBLISHER_PATH,p.head_sha),route=publisherRole(contract,packet.source_blobs[R9_PUBLISHER_PATH],wf.text);
    if(!route)fail('USAGE_PUBLISHER_SOURCE_NOT_REGISTERED');
    if(!route||route.self_hosted!==false)fail('USAGE_PUBLISHER_ROLE_INVALID');
    const jobs=native.packet.jobs.filter(j=>j.name===route.name);
    if(jobs.length!==1||jobs[0].conclusion!=='success'||jobs[0].labels.some(l=>l.toLowerCase()==='self-hosted')||
      Object.entries(route.required_steps).some(([name,count])=>jobs[0].steps.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length!==count))fail('USAGE_PUBLISHER_EXECUTION_INCOMPLETE');
    for(const file of R9_SOURCE_PATHS){const source=file===R9_PUBLISHER_PATH?wf:await sourceText(request,repository,file,p.head_sha);if(source.blob!==packet.source_blobs[file])fail('PUBLISHER_SOURCE_BYTES_MISMATCH');}
    return {status:'AUTHENTICATED_SEALED_ARTIFACT',packet,zip_bytes:bytes,artifact_id:String(artifactId),
      proof:{kind:'NATIVE_ARTIFACT_DIGEST_DEFAULTBRANCH_REGISTERED_SOURCE_ROLE',repository_id:contract.repository_id,
        run_id:String(p.run_id),run_attempt:p.run_attempt,head_sha:p.head_sha,artifact_digest:metadata.digest,contract_head:contract.head_sha}};
  }catch(e){return {status:'PARTIAL',reason_code:reason(e),packet:null};}
}
async function restoreArtifact(request,repository,contract,cacheRaw){
  try{
    let lastRefusal=null;
    const cache=parseFourSourceRawData(cacheRaw);
    if(!exact(cache,['schema','repository','artifact_id','zip_base64'])||cache.schema!==R9_CACHE_SCHEMA||cache.repository!==repository)fail('CACHE_SCHEMA_INVALID');
    if(cache.artifact_id!==null&&(!id(cache.artifact_id)||typeof cache.zip_base64!=='string'||cache.zip_base64.length>MAX_BYTES*1.4))fail('CACHE_SCHEMA_INVALID');
    // Cache bytes accelerate one immutable artifact; they never choose the
    // current artifact or erase authenticated incremental history.
    const list=async()=>{const rows=[],seen=new Set();let total=null;
      for(let page=1;page<=20;page++){
        const b=await bodyOf(request,`/repos/${repository}/actions/artifacts?name=${R9_ARTIFACT_NAME}&per_page=100&page=${page}`);
        if(!Number.isSafeInteger(b?.total_count)||b.total_count<0||total!==null&&total!==b.total_count||!Array.isArray(b.artifacts)||
          b.artifacts.length!==Math.min(100,b.total_count-rows.length))fail('ARTIFACT_LIST_INVALID');
        total=b.total_count;for(const a of b.artifacts){if(!id(a.id)||seen.has(String(a.id)))fail('ARTIFACT_LIST_INVALID');seen.add(String(a.id));rows.push(a);}
        if(rows.length===total)return rows;
      }fail('ARTIFACT_LIST_PAGE_CAP');};
    const before=await list(),qualified=[];
    for(const a of [...before].sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1)){
      if(a.name!==R9_ARTIFACT_NAME||a.expired!==false)continue;
      const proof=await verifyR9SealedArtifact({request,repository,contract,artifactId:a.id,
        zipBytes:String(a.id)===String(cache.artifact_id)&&cache.zip_base64!==null?Buffer.from(cache.zip_base64,'base64'):undefined});
      if(proof.packet)qualified.push(proof);else lastRefusal=proof.reason_code;
    }
    const after=await list();if(!same(before,after))fail('ARTIFACT_LIST_CHANGED_AT_CLOSE');
    if(!qualified.length)return {status:'PARTIAL',reason_code:lastRefusal??'AUTHENTICATED_SEALED_ARTIFACT_MISSING',packet:null};
    const merged=JSON.parse(emptyNativePopulationStore(repository)),variants=new Map();
    for(const q of qualified)for(const [key,p] of Object.entries(JSON.parse(q.packet.native_store_raw).packets)){
      if(!variants.has(key))variants.set(key,[]);variants.get(key).push({artifact_id:q.artifact_id,packet:p});
    }
    const revalidated=[];
    for(const [key,rows] of variants){
      if(rows.every(x=>same(x.packet,rows[0].packet)))merged.packets[key]=rows[0].packet;
      else{
        const [runId,attempt]=key.split(':'),fresh=await captureNativeAttempt({request,repository,runId,attempt:Number(attempt)});
        if(fresh.status!=='COMPLETE'||rows.some(x=>['run_id','head_sha','created_at','workflow_id','path','event'].some(k=>x.packet.run[k]!==fresh.packet.run[k])))fail('AUTHENTICATED_NATIVE_STORE_CONFLICT');
        merged.packets[key]=fresh.packet;revalidated.push({key,artifact_ids:rows.map(x=>x.artifact_id),native_capture:fresh.native_capture});
      }
    }
    const raw=JSON.stringify(merged);if(inspectNativePopulationStore(raw,repository).status!=='VALID_DATA_STORE')fail('AUTHENTICATED_NATIVE_STORE_UNION_INVALID');
    const latest=qualified[0];return {...latest,authenticated_native_store_raw:raw,
      proof:{...latest.proof,native_history_union:{artifact_ids:qualified.map(x=>x.artifact_id),packet_count:Object.keys(merged.packets).length,revalidated_conflicts:revalidated}}};
  }catch(e){return {status:'PARTIAL',reason_code:reason(e),packet:null};}
}

function inventoryIdentity(r){
  if(!id(r?.id)||!Number.isSafeInteger(r.run_attempt)||r.run_attempt<1||r.run_attempt>100||!id(r.workflow_id)||!sha(r.head_sha)||
    typeof r.path!=='string'||!time(r.created_at)||!time(r.updated_at)||r.created_at>r.updated_at||
    r.run_started_at!==null&&(!time(r.run_started_at)||r.run_started_at<r.created_at||r.run_started_at>r.updated_at)||
    !Array.isArray(r.pull_requests)||!['completed','queued','in_progress','requested','waiting','pending'].includes(r.status))fail('NATIVE_INVENTORY_INVALID');
  return {id:String(r.id),run_attempt:r.run_attempt,workflow_id:String(r.workflow_id),path:r.path,event:r.event,head_sha:r.head_sha,status:r.status,
    conclusion:r.conclusion??null,created_at:new Date(r.created_at).toISOString(),updated_at:new Date(r.updated_at).toISOString(),
    run_started_at:r.run_started_at===null?null:new Date(r.run_started_at).toISOString(),pull_requests:r.pull_requests.map(p=>p.number).sort((a,b)=>a-b)};
}
class NativeInventoryConflict extends Error{
  constructor(prior,current,stage){
    super('NATIVE_INVENTORY_BOUNDARY_CHANGED');
    const conclusions=['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure'];
    const progress=r=>({run_attempt:r.run_attempt,status:r.status,conclusion:conclusions.includes(r.conclusion)?r.conclusion:null,
      created_at:r.created_at,updated_at:r.updated_at,run_started_at:r.run_started_at});
    // Only normalized public Native fields, not response bodies, URLs,
    // credentials, logs or clock/claim payloads. This is diagnostic data;
    // it cannot qualify a source or relax the existing refusal.
    this.detail={run_id:prior.id,stage,changed_fields:Object.keys(prior).filter(k=>!same(prior[k],current[k])),
      before:progress(prior),after:progress(current)};
  }
}
// Creation fixes membership; it does not freeze later lifecycle observations.
// A run's updated_at can be older than this post-seal Native observation.
// Normal progress ending after the fixed close preserves membership even
// when the run began before close. Keep identity, ordinal and known start
// fixed, and refuse pre-close changes, terminal rewrites and old reruns.
// Neither timestamp here is promoted to an execution/completion time.
function inventoryDuplicate(prior,current,cutoff,stage){
  if(same(prior,current))return current;
  const identity=r=>({id:r.id,run_attempt:r.run_attempt,workflow_id:r.workflow_id,path:r.path,event:r.event,
    head_sha:r.head_sha,created_at:r.created_at,pull_requests:r.pull_requests});
  const phase=s=>s==='completed'?2:s==='in_progress'?1:0;
  if(timestampMicros(current.updated_at)>=cutoff&&same(identity(prior),identity(current))&&
    prior.status!=='completed'&&phase(current.status)>=phase(prior.status)&&
    current.updated_at>=prior.updated_at&&
    (prior.run_started_at===null||current.run_started_at===prior.run_started_at))return current;
  throw new NativeInventoryConflict(prior,current,stage);
}
// Fixed created upper watermark includes all historical runs, so an old run's
// new attempt is never lost by a created>=opening filter. GitHub caps filtered
// searches at 1000; split complete inclusive overlapping ranges rather than paging a
// truncated filtered search. New runs created after close cannot change it.
async function rangeInventory(request,repository,window,onObservedRows=()=>{}){
  // Unix epoch is a fixed inclusive lower bound of this API's nonnegative
  // creation-time grammar. No created>=opening filter can omit old reruns.
  const low=0,high=Number((timestampMicros(window.end)+999n)/1000n);
  if(low>high)fail('NATIVE_INVENTORY_WATERMARK_INVALID');
  const items=[],ids=new Map(),ranges=[{lo:low,hi:high}];let rangesRead=0;
  while(ranges.length){
    if(++rangesRead>4096)fail('NATIVE_INVENTORY_RANGE_CAP');
    const range=ranges.pop(),date=x=>new Date(x).toISOString();
    const route=`/repos/${repository}/actions/runs?created=${encodeURIComponent(date(range.lo)+'..'+date(range.hi))}&per_page=100`;
    const first=await bodyOf(request,route+'&page=1');
    if(!Number.isSafeInteger(first?.total_count)||first.total_count<0||!Array.isArray(first.workflow_runs))fail('NATIVE_INVENTORY_PAGINATION_INVALID');
    if(first.total_count>=1000){
      if(range.hi-range.lo<=1)return fullInventory(request,repository,window,rangesRead,onObservedRows);
      const mid=Math.floor((range.lo+range.hi)/2);ranges.push({lo:mid,hi:range.hi},{lo:range.lo,hi:mid});continue;
    }
    const total=first.total_count,leafIds=new Set();let count=0;
    const pageCount=Math.max(1,Math.ceil(total/100)),bodies=[first];
    // Same existing App/slice/floor/deadline, at most four HTTP reads inside
    // this process. No extra worker, request pool, retry or clipped directory.
    for(let page=2;page<=pageCount;page+=4){
      const batch=await Promise.allSettled(Array.from({length:Math.min(4,pageCount-page+1)},(_,i)=>bodyOf(request,route+'&page='+(page+i))));
      const failed=batch.find(r=>r.status==='rejected');if(failed)throw failed.reason;
      bodies.push(...batch.map(r=>r.value));
    }
    for(let page=1;page<=pageCount;page++){
      const body=bodies[page-1];
      if(body.total_count!==total||!Array.isArray(body.workflow_runs)||body.workflow_runs.length!==Math.min(100,total-count))fail('NATIVE_INVENTORY_PAGINATION_INVALID');
      for(const row of body.workflow_runs){const run=inventoryIdentity(row),created=timestampMicros(row.created_at);
        onObservedRows([run]);
        if(created<BigInt(range.lo)*1000n||created>BigInt(range.hi)*1000n)fail('NATIVE_INVENTORY_RANGE_INVALID');
        if(leafIds.has(run.id))fail('NATIVE_INVENTORY_DUPLICATE_ID');leafIds.add(run.id);
        const prior=ids.get(run.id);if(prior){
          if(created!==BigInt(range.lo)*1000n&&created!==BigInt(range.hi)*1000n)fail('NATIVE_INVENTORY_DUPLICATE_ID');
          const latest=inventoryDuplicate(prior,run,timestampMicros(window.end),'SPLIT_RANGE_OVERLAP');
          ids.set(run.id,latest);items[items.findIndex(r=>r.id===run.id)]=latest;
        }else{ids.set(run.id,run);items.push(run);}count++;if(items.length>MAX_RUNS)fail('NATIVE_INVENTORY_ITEM_CAP');}
      if(count===total)break;
    }
  }
  // Ceil-to-millisecond search is inclusive; exact microsecond watermark below
  // excludes any extra same-second outside member, without inventing a gap.
  const fixed=items.filter(r=>timestampMicros(r.created_at)<timestampMicros(window.end));
  return {items:sorted(fixed),total:fixed.length,created_cutoff:window.end,ranges_read:rangesRead};
}
// Read the uncapped endpoint once per directory barrier. New runs after the
// fixed close may grow only the leading prefix. Deduplicate shifted pages,
// then independently close that prefix and prove the fixed denominator.
// The old split-range path remains for a prefix wider than one full page;
// neither path drops old-created reruns or spends outside the shared budget.
async function inventory(request,repository,window,onObservedRows=()=>{}){
  const root=`/repos/${repository}/actions/runs?per_page=100`,cutoff=timestampMicros(window.end);
  const read=async page=>{const b=await bodyOf(request,root+'&page='+page);
    if(!Number.isSafeInteger(b?.total_count)||b.total_count<0||b.total_count>MAX_RUNS||!Array.isArray(b.workflow_runs)||
      b.workflow_runs.length!==Math.max(0,Math.min(100,b.total_count-(page-1)*100)))fail('NATIVE_INVENTORY_PAGINATION_INVALID');
    const rows=b.workflow_runs.map(inventoryIdentity);
    onObservedRows(rows);
    if(rows.some((r,i)=>i>0&&BigInt(rows[i-1].id)<=BigInt(r.id)))fail('NATIVE_INVENTORY_ORDER_UNPROVED');
    return {total:b.total_count,rows};};
  const first=await read(1),prefix=first.rows.filter(r=>timestampMicros(r.created_at)>=cutoff);
  if(prefix.length===100)return rangeInventory(request,repository,window,onObservedRows);
  const expected=first.total-prefix.length,ids=new Map(),all=new Map(),initialMax=first.rows.length?BigInt(first.rows[0].id):0n;let total=first.total,lastId=null;
  const append=rows=>{for(const r of rows){
    const old=all.get(r.id);if(old){const latest=inventoryDuplicate(old,r,cutoff,'SHIFTED_PAGE_DUPLICATE');
      all.set(r.id,latest);if(ids.has(r.id))ids.set(r.id,latest);continue;}
    if(lastId!==null&&BigInt(r.id)>lastId)fail('NATIVE_INVENTORY_ORDER_UNPROVED');lastId=BigInt(r.id);all.set(r.id,r);
    if(timestampMicros(r.created_at)>=cutoff){if(!prefix.some(p=>p.id===r.id))fail('NATIVE_INVENTORY_PREFIX_NOT_CLOSED');continue;}
    const prior=ids.get(r.id);if(prior){if(!same(prior,r))throw new NativeInventoryConflict(prior,r,'FIXED_MEMBER_DUPLICATE');continue;}
    ids.set(r.id,r);}};
  append(first.rows);
  for(let page=2;page<=Math.ceil(total/100);){
    const width=Math.min(4,Math.ceil(total/100)-page+1);
    const batch=await Promise.allSettled(Array.from({length:width},(_,i)=>read(page+i)));
    const bad=batch.find(r=>r.status==='rejected');if(bad)throw bad.reason;
    for(const {value:b} of batch){if(b.total<first.total)fail('NATIVE_INVENTORY_RETENTION_CHANGED');total=Math.max(total,b.total);append(b.rows);}page+=width;
  }
  if(first.total>100){const closing=await read(1),afterPrefix=closing.rows.filter(r=>timestampMicros(r.created_at)>=cutoff);
    if(afterPrefix.length===100||closing.total-afterPrefix.length!==expected)fail('NATIVE_INVENTORY_FIXED_DENOMINATOR_CHANGED');
    const added=closing.rows.filter(r=>!all.has(r.id));
    if(added.some(r=>BigInt(r.id)<=initialMax||timestampMicros(r.created_at)<cutoff)||closing.total-first.total!==added.length)fail('NATIVE_INVENTORY_HEAD_ADDITIONS_UNPROVED');
    for(const r of closing.rows){const latest=all.has(r.id)?inventoryDuplicate(all.get(r.id),r,cutoff,'CLOSING_DIRECTORY_HEAD'):r;
      all.set(r.id,latest);if(ids.has(r.id))ids.set(r.id,latest);}
    if(all.size!==closing.total)fail('NATIVE_INVENTORY_WHOLE_DENOMINATOR_UNPROVED');}
  if(ids.size!==expected)fail('NATIVE_INVENTORY_FIXED_DENOMINATOR_UNPROVED');
  return {items:sorted([...ids.values()]),total:ids.size,created_cutoff:window.end,ranges_read:0,directory_mode:'UNCAPPED_FIXED_PREFIX_BARRIER'};
}
async function fullInventory(request,repository,window,rangesRead,onObservedRows=()=>{}){
  // A dense timestamp cannot be split below the API's precision. Fall back to
  // the unfiltered complete endpoint within the SAME scheduling share. This
  // also supports providers that ignore the optional search filter; no clipped
  // 1000-row result can be accepted as complete.
  const items=[],seen=new Set();let total=null;
  for(let page=1;page<=1000;page++){
    const b=await bodyOf(request,`/repos/${repository}/actions/runs?per_page=100&page=${page}`);
    if(!Number.isSafeInteger(b?.total_count)||b.total_count<0||b.total_count>MAX_RUNS||total!==null&&b.total_count!==total||
      !Array.isArray(b.workflow_runs))fail('NATIVE_INVENTORY_PAGINATION_INVALID');
    total=b.total_count;if(b.workflow_runs.length!==Math.min(100,total-items.length))fail('NATIVE_INVENTORY_PAGINATION_INVALID');
    for(const row of b.workflow_runs){const r=inventoryIdentity(row);onObservedRows([r]);if(seen.has(r.id))fail('NATIVE_INVENTORY_DUPLICATE_ID');seen.add(r.id);items.push(r);}
    if(items.length===total){const fixed=items.filter(r=>timestampMicros(r.created_at)<timestampMicros(window.end));
      return {items:sorted(fixed),total:fixed.length,created_cutoff:window.end,ranges_read:rangesRead,search_fallback:'COMPLETE_UNFILTERED_DENSE_RANGE'};}
  }fail('NATIVE_INVENTORY_PAGE_CAP');
}
const selected=(items,w)=>items.filter(r=>timestampMicros(r.created_at)<timestampMicros(w.end)&&timestampMicros(r.updated_at)>=timestampMicros(w.start));
const nativeAdmissionKind=(r,jobs,e)=>e.admission_sources.some(s=>[s.workflow_path,s.reverify_workflow_path].includes(r.path.split('@')[0]))&&
  (jobs.length===0||jobs.some(j=>j.name!=='clued-work-adopt'&&!nativeJobIsNonExecution(j)));
// The fee observation has an explicit, fixed workflow scope. It uses the same
// complete retained directory and Native barriers, never a created>=opening
// search or a caller-selected workflow list. This is workload evidence only;
// daily allocation and any billable-price interpretation belong to its caller.
export const FEE_NATIVE_WORKFLOW_PATHS=Object.freeze([
  '.github/workflows/clued-merge-slot-ci.yml',
  '.github/workflows/clued-merge-executor.yml',
  '.github/workflows/clued-work-admission-reverify.yml',
  '.github/workflows/clued-work-admission.yml',
  '.github/workflows/clued-ci-health.yml',
  '.github/workflows/clued-work-admission-dispatch.yml',
]);
const feeWorkflowPaths=new Set(FEE_NATIVE_WORKFLOW_PATHS);
export async function collectFeeNativePopulation({request,repository,window,authenticatedStoreRaw=null,onStore=()=>{}}){
  return collectScopedNative({request,repository,window,authenticatedStoreRaw,onStore},true);
}
// Skip sealed terminal packets as a batch after the initial/closing Native
// inventory barriers. Only newly missing/changed attempt packets need jobs.
export async function collectIncrementalNative({request,repository,window,authenticatedStoreRaw=null,onStore=()=>{},observer=null}){
  return collectScopedNative({request,repository,window,authenticatedStoreRaw,onStore,observer});
}
const reuseHeaderFields=['run_id','run_attempt','workflow_id','path','event','head_sha','status','conclusion','created_at','run_started_at','updated_at','pull_requests'];
const reuseReasons=['EXACT_SEALED_HEADER_REUSE','CURRENT_ATTEMPT_ENDPOINT_HEADER_REUSE','ATTEMPT_PACKET_ABSENT','LATEST_SEALED_HEADER_ABSENT',
  'LATEST_SEALED_HEADER_VALUES_DIFFER','LATEST_SEALED_HEADER_SERIALIZATION_DIFFERS',
  'CURRENT_OBSERVER_EXCLUDED','LATEST_ATTEMPT_START_AT_OR_AFTER_CLOSE'];
function publicReuseValue(field,value){
  if(field==='conclusion'&&value!==null&&!['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure'].includes(value))
    return {not_published:'UNVALIDATED_NATIVE_HEADER_VALUE'};
  if(value===undefined)return {not_published:'ABSENT_HEADER_FIELD'};
  if(value===null||typeof value==='number')return value;
  if(field==='pull_requests'&&Array.isArray(value))return {values:value.slice(0,16).map(x=>Number.isSafeInteger(x)&&x>0?x:'UNVALIDATED_PUBLIC_ITEM'),
    count:value.length,truncated:value.length>16};
  if(typeof value==='string')return {value:value.slice(0,256),count:value.length,truncated:value.length>256};
  return {not_published:'UNVALIDATED_NATIVE_HEADER_VALUE'};
}
function reuseHeaderDifference(sealed,current){
  // Compare complete values before bounding output. Serialization differences
  // with equal field values stay visible; they are not a successful cache hit.
  const changed=reuseHeaderFields.filter(field=>Object.hasOwn(sealed,field)!==Object.hasOwn(current,field)||!same(sealed[field],current[field]));
  return {reason_code:changed.length?'LATEST_SEALED_HEADER_VALUES_DIFFER':'LATEST_SEALED_HEADER_SERIALIZATION_DIFFERS',
    changed_fields:changed,public_values:Object.fromEntries(changed.map(field=>[field,
      {sealed:publicReuseValue(field,sealed[field]),inventory:publicReuseValue(field,current[field])}])),
    ...(changed.length?{}:{serialization_difference:true,
      sealed_field_order:Object.keys(sealed).filter(field=>reuseHeaderFields.includes(field)),
      inventory_field_order:Object.keys(current).filter(field=>reuseHeaderFields.includes(field))})};
}
const inventoryNativeHeader=r=>({run_id:r.id,run_attempt:r.run_attempt,workflow_id:r.workflow_id,path:r.path,event:r.event,head_sha:r.head_sha,
  status:r.status,conclusion:r.conclusion,created_at:r.created_at,run_started_at:r.run_started_at,updated_at:r.updated_at,pull_requests:r.pull_requests});
function currentAttemptWitnessEligible(latest,normalized,window){
  if(!latest||latest.run.status!=='completed'||normalized.status!=='completed'||latest.run.updated_at===normalized.updated_at||
    JSON.stringify({...latest.run,updated_at:normalized.updated_at})!==JSON.stringify(normalized)||
    normalized.run_started_at!==null&&timestampMicros(normalized.run_started_at)>=timestampMicros(window.end))return false;
  const region=value=>{const us=timestampMicros(value);return us<timestampMicros(window.start)?-1:us>=timestampMicros(window.end)?1:0;};
  return region(latest.run.updated_at)===region(normalized.updated_at);
}
function nativeEndpointTime(value){
  // Match the Native reader's UTC wire-date grammar before projecting it.
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))fail('CURRENT_ATTEMPT_ENDPOINT_INVALID');
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z'))fail('CURRENT_ATTEMPT_ENDPOINT_INVALID');
  return new Date(ms).toISOString();
}
async function currentAttemptEndpointWitness(request,repository,run,latest){
  let raw;
  try{raw=await bodyOf(request,`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`);}
  catch(error){return {status:'REFUSED',reason_code:reason(error)};}
  try{
    if(!object(raw))fail('CURRENT_ATTEMPT_ENDPOINT_INVALID');
    const reportedCreation=nativeEndpointTime(raw.created_at),endpoint=inventoryIdentity({...raw,created_at:run.created_at,
      run_started_at:raw.run_started_at===null?null:nativeEndpointTime(raw.run_started_at),updated_at:nativeEndpointTime(raw.updated_at)}),header=inventoryNativeHeader(endpoint);
    if(JSON.stringify(header)!==JSON.stringify(latest.run)||reportedCreation!==(latest.timing_basis.reported_attempt_created_at??latest.run.created_at))
      return {status:'NOT_MATCHED'};
    // The full Native normalizer/store validator remains the final grammar
    // authority; the witness never substitutes DTO bytes into the old packet.
    const checked=inspectNativePopulationStore(JSON.stringify({schema:'clued.merge-admission-native-population/1',repository,
      packets:{[run.id+':'+run.run_attempt]:{...latest,run:header,run_digest:hash(header)}}}),repository);
    return {status:checked.status==='VALID_DATA_STORE'?'MATCHED':'NOT_MATCHED'};
  }catch{return {status:'NOT_MATCHED'};}
}
async function collectScopedNative({request,repository,window,authenticatedStoreRaw=null,onStore=()=>{},observer=null},feeOnly=false){
  let storeRaw=authenticatedStoreRaw??emptyNativePopulationStore(repository),initial=null,first=null,closing=null,closingScope=null;
  let directoryProgress=null;const observed=new Map();
  const gaps=[],excludedAttempts=[];let fresh=0,fromSealed=0,observerExcluded=false;
  const reuseDiagnostics={schema:'clued.r9-native-cache-reuse-diagnostics/1',basis:'CURRENT_NATIVE_HEADER_AND_AUTHENTICATED_STORE',
    reason_counts:Object.fromEntries(reuseReasons.map(reason=>[reason,0])),sealed_current_attempt_recapture_count:0,
    sample_limit:4,sealed_current_attempt_recapture_samples:[]};
  const select=items=>selected(items,window).filter(r=>!feeOnly||feeWorkflowPaths.has(r.path.split('@')[0]));
  // Observations are request-local packet discovery only, never a directory
  // cursor, a current cohort, or a persisted denominator.
  const observe=rows=>{for(const run of select(rows))if(!observed.has(run.id)&&observed.size<MAX_RUNS)observed.set(run.id,run);};
  const retained=()=>Object.values(inspectNativePopulationStore(storeRaw,repository).packets??{}).filter(p=>first?.some(r=>r.id===p.run.run_id));
  const feeCoverage=()=>feeOnly?{scope:'fee_native_terminal_packets_run_envelope_intersection',
    workflow_paths:[...FEE_NATIVE_WORKFLOW_PATHS],window:{...window},
    initial_scope_runs:first?.length??null,closing_scope_runs:closingScope?.length??null,
    cohort:(first??[]).map(r=>({run_id:r.id,latest_attempt:r.run_attempt,workflow_path:r.path.split('@')[0]})),
    excluded_attempts:excludedAttempts}:{};
  const captureBatch=async(batch,progressOnly=false)=>{
      const basis=storeRaw;
      const outcomes=await Promise.allSettled(batch.map(async run=>{
        let local=basis,localFresh=0,localSealed=0,inventoryRun=run;const localGaps=[];
        if(observer?.run_id===run.id&&run.run_attempt!==observer.run_attempt)
          localGaps.push({key:run.id+':'+run.run_attempt,reason_code:'CURRENT_OBSERVER_INVENTORY_CHANGED'});
      const packets=inspectNativePopulationStore(storeRaw,repository).packets;
      const latest=packets[run.id+':'+run.run_attempt];
      // Normalize the inventory projection to the exact d0fc store grammar.
      const normalized=inventoryNativeHeader(run);
      let latestMatches=latest&&JSON.stringify(latest.run)===JSON.stringify(normalized),endpointWitness=null;
      const witnessEligible=!progressOnly&&currentAttemptWitnessEligible(latest,normalized,window);
      const headerDifference=latest&&!latestMatches?reuseHeaderDifference(latest.run,normalized):null;
      for(let attempt=1;attempt<=run.run_attempt;attempt++){
        // Only the independently verified currently executing observer is
        // outside its own execution denominator. Older ordinal packets remain.
        if(observer?.run_id===run.id&&run.run_attempt===observer.run_attempt&&observer.run_attempt===attempt&&run.path.split('@')[0]===R9_PUBLISHER_PATH&&
          run.head_sha===observer.head_sha&&run.status==='in_progress'){
          if(progressOnly)directoryProgress.observer_attempts_excluded++;
          reuseDiagnostics.reason_counts.CURRENT_OBSERVER_EXCLUDED++;observerExcluded=true;continue;
        }
        if(attempt===run.run_attempt&&run.run_started_at!==null&&timestampMicros(run.run_started_at)>=timestampMicros(window.end)){
          if(progressOnly)directoryProgress.postclose_attempts_excluded++;
          reuseDiagnostics.reason_counts.LATEST_ATTEMPT_START_AT_OR_AFTER_CLOSE++;
          if(feeOnly)excludedAttempts.push({key:run.id+':'+attempt,reason_code:'ATTEMPT_START_AT_OR_AFTER_WINDOW_CLOSE'});
          continue;
        }
        const existing=packets[run.id+':'+attempt];
        // Existing packets survive a refused directory without being promoted
        // to a Current reuse proof or counted as from_sealed.
        if(progressOnly&&existing){directoryProgress.existing_packet_attempts_preserved++;continue;}
        // One current endpoint proof qualifies only its exact latest packet.
        // The reuse reason counts packets, not HTTP requests or newly added data.
        if(attempt===run.run_attempt&&existing&&!latestMatches&&witnessEligible&&endpointWitness===null){
          endpointWitness=await currentAttemptEndpointWitness(request,repository,run,latest);
          if(endpointWitness.status==='REFUSED'){localGaps.push({key:run.id+':'+attempt,reason_code:endpointWitness.reason_code});break;}
          if(endpointWitness.status==='MATCHED')latestMatches=true;
        }
        if(latestMatches&&existing){
          reuseDiagnostics.reason_counts[endpointWitness?.status==='MATCHED'?'CURRENT_ATTEMPT_ENDPOINT_HEADER_REUSE':'EXACT_SEALED_HEADER_REUSE']++;
          localSealed++;continue;
        }
        const reuseReason=!existing?'ATTEMPT_PACKET_ABSENT':!latest?'LATEST_SEALED_HEADER_ABSENT':headerDifference.reason_code;
        reuseDiagnostics.reason_counts[reuseReason]++;
        if(attempt===run.run_attempt&&existing){
          reuseDiagnostics.sealed_current_attempt_recapture_count++;
          if(reuseDiagnostics.sealed_current_attempt_recapture_samples.length<reuseDiagnostics.sample_limit)
            reuseDiagnostics.sealed_current_attempt_recapture_samples.push({key:run.id+':'+attempt,...headerDifference});
        }
        if(progressOnly)directoryProgress.missing_attempt_capture_requests++;
        const captured=await captureNativeAttempt({request,repository,runId:run.id,attempt,storeRaw:local});
        if(captured.status!=='COMPLETE'){localGaps.push({key:run.id+':'+attempt,reason_code:captured.reason_code});
          if(/request|cap|floor|budget|slice|limit|stop/i.test(captured.reason_code??''))break;continue;}
        if(progressOnly){
          // The failed inventory cannot bind a latest cohort. Independently
          // complete Native barriers must still prove this observed fixed
          // identity before its missing historical packet can be retained.
          const p=captured.packet.run,identity=r=>({run_id:r.run_id??r.id,workflow_id:r.workflow_id,path:r.path,event:r.event,
            head_sha:r.head_sha,created_at:r.created_at,pull_requests:r.pull_requests});
          if(!same(identity(p),identity(run))){localGaps.push({key:run.id+':'+attempt,reason_code:'NATIVE_PROGRESS_OBSERVATION_IDENTITY_CHANGED'});continue;}
        }
        local=captured.store_raw;localFresh++;
        if(!progressOnly&&captured.barriers?.latest_digest!==hash(normalized)){
          // A terminal current attempt double-captured from Native may have
          // finished after the fixed close since its earlier Native observation. Its
          // independently captured latest digest must prove the same exact
          // projection; historical ordinals and unproved changes still fail.
          const p=captured.packet.run,latest={id:p.run_id,run_attempt:p.run_attempt,workflow_id:p.workflow_id,path:p.path,event:p.event,
            head_sha:p.head_sha,status:p.status,conclusion:p.conclusion,created_at:p.created_at,updated_at:p.updated_at,
            run_started_at:p.run_started_at,pull_requests:p.pull_requests};
          if(attempt!==run.run_attempt||captured.barriers.latest_digest!==hash(p))
            return {local,localFresh,localSealed,localGaps,fatal:'NATIVE_CAPTURE_INVENTORY_BARRIER_MISMATCH'};
          try{inventoryRun=inventoryDuplicate(run,latest,timestampMicros(window.end),'NATIVE_CAPTURE_PROGRESS');}
          catch{return {local,localFresh,localSealed,localGaps,fatal:'NATIVE_CAPTURE_INVENTORY_BARRIER_MISMATCH'};}
        }
      }
      return {local,localFresh,localSealed,localGaps,inventoryRun};
      }));
      // Serialize publication after joining the batch. Never overwrite another
      // capture's packet; the ordinary store validator checks the full union.
      const results=outcomes.filter(r=>r.status==='fulfilled').map(r=>r.value),joined=JSON.parse(storeRaw);
      for(const result of results){
        if(!progressOnly&&result.inventoryRun)first[first.findIndex(r=>r.id===result.inventoryRun.id)]=result.inventoryRun;
        for(const [k,p] of Object.entries(JSON.parse(result.local).packets)){
          if(joined.packets[k]&&!same(joined.packets[k],p))fail('NATIVE_BATCH_PACKET_CONFLICT');joined.packets[k]=p;
        }
        fresh+=result.localFresh;fromSealed+=result.localSealed;gaps.push(...result.localGaps);
      }
      const nextRaw=JSON.stringify(joined);
      if(progressOnly&&inspectNativePopulationStore(nextRaw,repository).status!=='VALID_DATA_STORE')fail('NATIVE_STORE_INVALID');
      storeRaw=nextRaw;if(!progressOnly&&inspectNativePopulationStore(storeRaw,repository).status!=='VALID_DATA_STORE')fail('NATIVE_STORE_INVALID');
      await onStore(storeRaw);
      if(results.some(r=>r.fatal))fail(results.find(r=>r.fatal).fatal);
      if(outcomes.some(r=>r.status==='rejected'))fail(reason(outcomes.find(r=>r.status==='rejected').reason));
      if(results.some(r=>r.localGaps.some(g=>/request|cap|floor|budget|slice|limit|stop/i.test(g.reason_code??''))))fail('NATIVE_CAPTURE_BUDGET_PARTIAL');
  };
  const captureRuns=async(runs,progressOnly=false)=>{for(let offset=0;offset<runs.length;offset+=4)await captureBatch(runs.slice(offset,offset+4),progressOnly);};
  try{
    if(inspectNativePopulationStore(storeRaw,repository).status!=='VALID_DATA_STORE')fail('NATIVE_STORE_INVALID');
    try{initial=await inventory(request,repository,window,observe);}
    catch(error){
      // Only a typed initial directory conflict opens this bounded salvage.
      // A network, malformed page or budget refusal starts no new capture.
      if(!(error instanceof NativeInventoryConflict))throw error;
      const beforeKeys=new Set(Object.keys(inspectNativePopulationStore(storeRaw,repository).packets));
      directoryProgress={schema:'clued.r9-directory-packet-progress/1',basis:'OBSERVED_FIXED_IDENTITIES_AND_INDEPENDENT_NATIVE_BARRIERS',
        inventory_closed:false,trigger_reason_code:error.message,observed_candidates:observed.size,
        before_packet_count:beforeKeys.size,after_packet_count:beforeKeys.size,new_packet_keys_count:0,new_packet_key_samples:[],
        missing_attempt_capture_requests:0,existing_packet_attempts_preserved:0,observer_attempts_excluded:0,postclose_attempts_excluded:0,
        stop_reason_code:null};
      try{await captureRuns(sorted([...observed.values()]),true);}catch(progressError){directoryProgress.stop_reason_code=reason(progressError);}
      const afterKeys=Object.keys(inspectNativePopulationStore(storeRaw,repository).packets),added=afterKeys.filter(k=>!beforeKeys.has(k));
      directoryProgress.after_packet_count=afterKeys.length;directoryProgress.new_packet_keys_count=added.length;
      directoryProgress.new_packet_key_samples=added.slice(0,4);
      // Retain the original refusal and public conflict detail regardless of
      // progress or its stop. Neither observed rows nor new packets close it.
      throw error;
    }
    first=select(initial.items);await captureRuns(first);
    closing=await inventory(request,repository,window);closingScope=select(closing.items);
    if(hash(first)!==hash(closingScope))fail('NATIVE_COHORT_CHANGED_AT_CLOSE');
    const all=inspectNativePopulationStore(storeRaw,repository).packets;
    const retainedPackets=Object.values(all).filter(p=>first.some(r=>r.id===p.run.run_id));
    // Historical ordinal captures are retained durably, but a terminal upper
    // bound before opening proves that row is outside this forward population.
    // Explicit natural references are added below; no old-history recovery is
    // made a prerequisite merely because an old run was rerun in this epoch.
    const populationPackets=retainedPackets.filter(p=>p.run.status!=='completed'||timestampMicros(p.run.updated_at)>=timestampMicros(window.start));
    const attempts=populationPackets.filter(p=>p.run.run_started_at!==null&&timestampMicros(p.run.run_started_at)>=timestampMicros(window.start)&&timestampMicros(p.run.run_started_at)<timestampMicros(window.end));
    const unknownStarts=populationPackets.filter(p=>p.run.run_started_at===null).map(p=>key(p.run));
    return {status:gaps.length?'PARTIAL':'COMPLETE',store_raw:storeRaw,attempts,population_packets:populationPackets,all_population_packets:retainedPackets,gaps,fresh,from_sealed:fromSealed,
      population:{initial_total:initial.total,closing_total:closing.total,cohort_digest:hash(first),complete:gaps.length===0,
        scope:'native_terminal_packets_run_envelope_intersection',created_cutoff:window.end,initial_ranges:initial.ranges_read,closing_ranges:closing.ranges_read,attempt_start_unknown:unknownStarts,
        ...feeCoverage(),
        cache_reuse_diagnostics:reuseDiagnostics,
        ...(observerExcluded?{current_observer_exclusion:{...observer,reason_code:'CURRENT_IN_PROGRESS_OBSERVER_IS_NOT_ITS_OWN_TERMINAL_EXECUTION'}}:{})}};
  }catch(e){return {status:'PARTIAL',reason_code:reason(e),store_raw:storeRaw,attempts:[],gaps,fresh,from_sealed:fromSealed,
    ...(feeOnly?{all_population_packets:retained(),population_packets:retained().filter(p=>p.run.status!=='completed'||timestampMicros(p.run.updated_at)>=timestampMicros(window.start))}:{}),
    ...(e instanceof NativeInventoryConflict?{inventory_conflict:e.detail}:{}),
    population:{initial_total:initial?.total??null,closing_total:feeOnly?closing?.total??null:null,complete:false,...feeCoverage(),cache_reuse_diagnostics:reuseDiagnostics,
      ...(directoryProgress?{directory_progress:directoryProgress}:{})}};}
}
const unavailable=reason_code=>({status:'partial',value:null,reason_code,official_metric:false,source_authenticated:false});

// The runtime obtains this selection independently of a cached packet, from
// its accepted target/source configuration. It is a selection, not authority.
function sourceContract(raw,repository,window){
  const c=parseFourSourceRawData(raw);
  if(!exact(c,['schema','repository','scope','window','four_expected_sources_raw','clock'])||
    c.schema!=='clued.merge-admission-r9-source-contract/1'||c.repository!==repository||
    !exact(c.scope,['project_id','queue_ref'])||!uuid(c.scope.project_id)||
    !c.scope.queue_ref.startsWith('merge:'+repository.toLowerCase()+':')||
    !exact(c.window,['start','end'])||timestampMicros(c.window.start)!==timestampMicros(window.start)||
    timestampMicros(c.window.end)!==timestampMicros(window.end)||
    c.four_expected_sources_raw!==null&&typeof c.four_expected_sources_raw!=='string'||
    c.clock!==null&&(!exact(c.clock,['foundation_digest','catalog_digest','transport_definition_digest'])||Object.values(c.clock).some(x=>!digest(x))))fail('INDEPENDENT_SOURCE_CONTRACT_INVALID');
  if(c.four_expected_sources_raw!==null){const f=parseFourSourceRawData(c.four_expected_sources_raw);
    if(f.repository!==c.repository||!same(f.scope,c.scope))fail('FOUR_SOURCE_INDEPENDENT_TARGET_MISMATCH');}
  return c;
}
const key=a=>String(a.run_id)+':'+(a.attempt??a.run_attempt);
const atEqual=(a,b)=>a===null&&b===null||a!==null&&b!==null&&timestampMicros(a)===timestampMicros(b);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
// Only byte-pinned source equivalence. History/current main/actual artifact
// and credential qualification remain independent checks at the caller.
export function sameNaturalSourceSnapshot(cfg,naturalSelection,runtimeInputs,contract){
  try{const pins=[...cfg.natural_producers.flatMap(d=>[...Object.entries(d.source_blobs??{}),[d.workflow_path,d.workflow_blob]]),
      ...['script','workflow','reverify_workflow','policy'].map(k=>[cfg.admission_source[k+'_path'],cfg.admission_source[k+'_blob']])];
    return object(cfg.admission_source)&&object(naturalSelection.admission_source)&&
    same(cfg.admission_source,naturalSelection.admission_source)&&
    same(profileCatalogue(runtimeInputs.proof_profiles_raw),contract.profiles)&&
    same(parseFourSourceRawData(runtimeInputs.role_specs_raw),contract.roles)&&
    hash(runtimeInputs.proof_profiles_raw)===cfg.execution_source?.profiles_sha256&&
    hash(runtimeInputs.role_specs_raw)===cfg.execution_source?.role_specs_sha256&&
    contract.profiles_sha256===cfg.execution_source?.profiles_sha256&&
    contract.role_specs_sha256===cfg.execution_source?.role_specs_sha256&&
    pins.every(([file,pin])=>typeof file==='string'&&sha(pin)&&contract.source_tree?.[file]?.sha===pin&&contract.source_tree[file].type==='blob'&&contract.source_tree[file].mode==='100644')&&
    Array.isArray(cfg.natural_producers)&&cfg.natural_producers.every(d=>naturalSelection.workflow_blobs[d.workflow_path]===d.workflow_blob);
  }catch{return false;}
}
// updated_at is used only as an upper bound on the already observed completed
// state, never as completion time. A common cohort across the entire possible
// interval is a proof; a crossing interval remains UNKNOWN.
export function nativeCompletionMembership(packet,window){
  try{
    const r=packet.run;if(r.status!=='completed')fail('NATIVE_COMPLETION_NOT_TERMINAL');
    let lower=timestampMicros(r.created_at),upper=timestampMicros(r.updated_at);
    for(const j of packet.jobs)for(const at of nativeJobIsNonExecution(j)?[]:[j.created_at,j.started_at,j.completed_at])if(at!==null){const t=timestampMicros(at);if(t>lower)lower=t;}
    const from=timestampMicros(window.start),to=timestampMicros(window.end);
    if(lower>upper||from>=to)fail('NATIVE_COMPLETION_BOUNDS_INVALID');
    const membership=lower>=from&&upper<to?'IN_WINDOW':upper<from||lower>=to?'OUTSIDE_WINDOW':'UNKNOWN';
    return {membership,lower_us:String(lower),upper_us:String(upper),timing_basis:'native_job_completion_lower_and_terminal_update_upper_bounds',exact_completed_at:null};
  }catch{return {membership:'UNKNOWN',reason_code:'NATIVE_COMPLETION_BOUNDS_UNAVAILABLE',exact_completed_at:null};}
}
const isoMicros=us=>{const x=BigInt(us);return new Date(Number(x/1000000n)*1000).toISOString().slice(0,19)+'.'+(x%1000000n).toString().padStart(6,'0')+'Z';};
// A root workflow completion POINT is absent from the actual GitHub DTO. Keep
// the proven interval instead. Normalized attempt rows remain a data stage;
// Native artifact/target authentication is independently enforced above.
export function mapNativeAttemptsForFourSource(native,expectedRaw,window,{profilesRaw=null,workflowBlobs={}}={}){
  const e=parseFourSourceRawData(expectedRaw),admissionPaths=new Set(e.admission_sources.flatMap(s=>[s.workflow_path,s.reverify_workflow_path]));
  const profiles=profilesRaw===null?null:profileCatalogue(profilesRaw);
  if(profiles&&hash(profilesRaw)!==e.execution_source.profiles_sha256)fail('INDEPENDENT_NATIVE_KIND_SELECTION_MISMATCH');
  return (native.population_packets??[]).map(n=>{
    const r=n.run,m=r.status==='completed'?nativeCompletionMembership(n,window):null;
    const interval=m?.lower_us===undefined?null:{lower_at:isoMicros(m.lower_us),upper_at:isoMicros(m.upper_us),basis:'native_job_completion_lower_and_terminal_update_upper_bounds'};
    return {run_id:r.run_id,attempt:r.run_attempt,pr_number:r.pull_requests.length===1?r.pull_requests[0]:null,head_sha:r.head_sha,
      kind:nativeAdmissionKind(r,n.jobs,e)?'admission':!admissionPaths.has(r.path.split('@')[0])&&profiles&&registeredWorkflowSource(profiles,r.path.split('@')[0],workflowBlobs[r.path.split('@')[0]])?.passed?'ci':'other',status:r.status,conclusion:r.conclusion,
      started_at:r.run_started_at,completed_at:null,terminal_interval:interval};
  });
}
function jobProjection(j){
  return {id:String(j.id),run_id:String(j.run_id),run_attempt:j.run_attempt,name:j.name,status:j.status,conclusion:j.conclusion,
    created_at:j.created_at===undefined?undefined:new Date(j.created_at).toISOString(),started_at:j.started_at===null?null:new Date(j.started_at).toISOString(),
    completed_at:j.completed_at===null?null:new Date(j.completed_at).toISOString(),labels:[...j.labels].sort(),
    steps:j.steps.map(s=>({number:s.number,name:s.name,status:s.status,conclusion:s.conclusion,
      started_at:s.started_at===null?null:new Date(s.started_at).toISOString(),completed_at:s.completed_at===null?null:new Date(s.completed_at).toISOString()})).sort((a,b)=>a.number-b.number)};
}
// Only compares supplied evidence to actual, immutable Native captures. This
// helper does not grant provenance; collectR9Measurement owns that promotion.
export function bindFourSourceNativePopulation(packetRaw,native,expectedRaw){
  try{
    const p=parseFourSourceRawData(packetRaw),e=parseFourSourceRawData(expectedRaw);
    const inspected=inspectNativePopulationStore(native.store_raw,p.repository);
    if(inspected.status!=='VALID_DATA_STORE'||native.population?.complete!==true||p.repository!==e.repository||!same(p.scope,e.scope))fail('FOUR_SOURCE_NATIVE_POPULATION_MISMATCH');
    const actual=inspected.packets,supplied=new Map(p.attempts.map(a=>[key(a),a]));
    const registry=profileCatalogue(p.proof_profiles_raw);
    if(supplied.size!==p.attempts.length)fail('FOUR_SOURCE_NATIVE_POPULATION_MISMATCH');
    for(const n of native.population_packets??native.attempts??[])if(!supplied.has(key(n.run)))fail('FOUR_SOURCE_NATIVE_POPULATION_MISMATCH');
    for(const a of supplied.values()){
      const n=actual[key(a)],r=n?.run;
      if(!r||a.status!==r.status||a.conclusion!==r.conclusion||!atEqual(a.started_at,r.run_started_at))fail('FOUR_SOURCE_NATIVE_POPULATION_MISMATCH');
      // Admission's target PR head differs legitimately from its trusted main
      // run head. Bind that separate identity through its actual envelope below.
      if(a.kind!=='admission'&&a.head_sha!==r.head_sha)fail('FOUR_SOURCE_NATIVE_POPULATION_MISMATCH');
      if(a.completed_at!==null){
        // d0fc has no exact root-workflow completion fact. Being inside bounds
        // is insufficient to promote a selected representative into one.
        if(r.completed_at===undefined||!atEqual(a.completed_at,r.completed_at))fail('UNSOURCED_NATIVE_TERMINAL_POINT');
        const t=timestampMicros(a.completed_at);
        if(t>timestampMicros(r.updated_at)||n.jobs.some(j=>j.completed_at!==null&&timestampMicros(j.completed_at)>t))fail('FOUR_SOURCE_NATIVE_TERMINAL_TIME_CONTRADICTORY');
        const m=nativeCompletionMembership(n,p.window),inside=t>=timestampMicros(p.window.start)&&t<timestampMicros(p.window.end);
        if(m.lower_us!==undefined&&t<BigInt(m.lower_us))fail('FOUR_SOURCE_NATIVE_TERMINAL_TIME_CONTRADICTORY');
        if(m.membership==='UNKNOWN')fail('FOUR_SOURCE_NATIVE_TERMINAL_MEMBERSHIP_UNKNOWN');
        if(inside!==(m.membership==='IN_WINDOW'))fail('FOUR_SOURCE_NATIVE_TERMINAL_MEMBERSHIP_MISMATCH');
      }
      if(a.terminal_interval!==undefined&&a.terminal_interval!==null){
        const b=a.terminal_interval,m=nativeCompletionMembership(n,p.window);
        if(!exact(b,['lower_at','upper_at','basis'])||b.basis!==m.timing_basis||m.lower_us===undefined||
          timestampMicros(b.lower_at)!==BigInt(m.lower_us)||timestampMicros(b.upper_at)!==BigInt(m.upper_us))fail('FOUR_SOURCE_NATIVE_TERMINAL_INTERVAL_MISMATCH');
      }else if(a.status==='completed'&&a.completed_at===null)fail('FOUR_SOURCE_NATIVE_TERMINAL_BOUNDS_MISSING');
      const isAdmission=nativeAdmissionKind(r,n.jobs,e);
      if(isAdmission!==(a.kind==='admission'))fail('FOUR_SOURCE_NATIVE_KIND_MISMATCH');
      const file=r.path.split('@')[0],source=p.execution_sources.entries.find(x=>x.workflow_file===file);
      const registered=source&&registeredWorkflowSource(registry,file,source.workflow_blob);
      if(!isAdmission&&r.pull_requests.length&&registered?.passed&&registered.profile.primary_ids.length&&a.kind!=='ci')fail('FOUR_SOURCE_NATIVE_KIND_MISMATCH');
      if(a.kind==='ci'&&a.pr_number!==null&&!r.pull_requests.includes(a.pr_number))fail('FOUR_SOURCE_NATIVE_PR_ASSOCIATION_MISMATCH');
    }
    for(const row of p.admissions){
      const q=parseFourSourceRawData(row.packet_raw),i=q.identity,r=actual[String(i.run_id)+':'+i.run_attempt]?.run;
      const historicalUnknownStart=q.final_decision_observed===false&&q.outcome===null&&i.native_run.status==='in_progress'&&i.native_run.run_started_at===null;
      if(!r||String(i.native_run.id)!==r.run_id||i.native_run.run_attempt!==r.run_attempt||i.native_run.head_sha!==r.head_sha||
        i.native_run.path.split('@')[0]!==r.path.split('@')[0]||
        !(atEqual(i.native_run.run_started_at,r.run_started_at)||historicalUnknownStart&&r.run_started_at!==null))fail('FOUR_SOURCE_NATIVE_ADMISSION_IDENTITY_MISMATCH');
      if(i.native_job){const j=actual[key(r)].jobs.find(j=>j.id===String(i.native_job.id));
        if(!j||i.native_job.name!==j.name||i.native_job.run_attempt!==j.run_attempt||String(i.native_job.run_id)!==j.run_id||
          i.native_job.status==='completed'&&(i.native_job.status!==j.status||i.native_job.conclusion!==j.conclusion))fail('FOUR_SOURCE_NATIVE_ADMISSION_JOB_MISMATCH');}
    }
    for(const round of p.rounds)for(const x of round.execution_packets){
      const n=actual[x.run_key];
      if(!n||x.workflow_file!==n.run.path.split('@')[0]||!same(x.jobs.map(jobProjection).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1),n.jobs.map(jobProjection)))fail('FOUR_SOURCE_NATIVE_EXECUTION_JOBS_MISMATCH');
      for(const barrier of [x.before_attempt,x.after_attempt])if(String(barrier.run_id)!==n.run.run_id||barrier.attempt!==n.run.run_attempt||
        barrier.head_sha!==n.run.head_sha||barrier.status!==n.run.status||barrier.conclusion!==n.run.conclusion)fail('FOUR_SOURCE_NATIVE_EXECUTION_BARRIER_MISMATCH');
      // An observed round close must be after the whole possible terminal
      // interval. A guessed earlier representative cannot justify wasting it.
      if(round.completed_at!==undefined&&round.completed_at!==null&&timestampMicros(round.completed_at)<timestampMicros(n.run.updated_at))fail('FOUR_SOURCE_NATIVE_ROUND_CLOSE_UNPROVED');
    }
    return {status:'NATIVE_BOUND',complete:true,source_authenticated:false,official_metric:false};
  }catch(e){return {status:'PARTIAL',reason_code:reason(e),complete:false,source_authenticated:false,official_metric:false};}
}
export function bindClockSource(packetClock,selectionRaw,repository,window){
  try{
    const c=sourceContract(selectionRaw,repository,window),pins=c.clock;
    if(!pins||!packetClock?.transport_raw)fail('AUTHENTICATED_SEALED_CLOCK_TRANSPORT_MISSING');
    const pages=parseFourSourceRawData(packetClock.pages_raw),responses=parseFourSourceRawData(packetClock.transport_raw),options=parseFourSourceRawData(packetClock.options_raw);
    if(!Array.isArray(pages)||!Array.isArray(responses)||pages.length!==responses.length||pages.length===0||
      options.queueRef!==c.scope.queue_ref||options.expectedFoundationDigest!==pins.foundation_digest||options.expectedCatalogDigest!==pins.catalog_digest)fail('CLOCK_INDEPENDENT_SUBJECT_MISMATCH');
    for(let i=0;i<pages.length;i++){
      const p=pages[i],r=responses[i],a=r?.server_auth;
      if(r?.status!=='ok'||r.operation!=='clock_page'||!same(r.measurement,p)||!a||
        a.schema!=='clued.clock-audit-transport-auth/1'||a.status!=='AUTHENTICATED_TARGET_READ'||a.required_scope!=='audit:read'||
        a.context_key!=='project:'+c.scope.project_id||a.queue_ref!==c.scope.queue_ref||a.transport_definition_digest!==pins.transport_definition_digest||
        !digest(a.binding_scope_fingerprint)||!Number.isSafeInteger(a.contributor_count)||a.contributor_count<1||
        i>0&&(a.binding_scope_fingerprint!==responses[0].server_auth.binding_scope_fingerprint||a.contributor_count!==responses[0].server_auth.contributor_count)||
        timestampMicros(a.observed_at)<BigInt(p.seal.closing_us)||
        !same(r.pins,{epoch_id:p.epoch.epoch_id,stream_id:p.epoch.stream_id,clock_generation_id:p.epoch.clock_generation_id,
          foundation_digest:pins.foundation_digest,catalog_digest:pins.catalog_digest})||
        !same(r.seal_pins,{end_sequence:p.seal.end_sequence,closing_us:p.seal.closing_us,catalog_digest:pins.catalog_digest})||
        BigInt(p.epoch.opening_us)!==timestampMicros(window.start)||BigInt(p.seal.closing_us)!==timestampMicros(window.end))fail('CLOCK_INDEPENDENT_SUBJECT_MISMATCH');
    }
    const result=integrateClockSourceCandidate(packetClock.pages_raw,packetClock.options_raw);
    // Source integrity and a uniquely proved percentile are separate results.
    // The pure reader sets candidate_ready only after complete journal/clock replay.
    if(result.candidate_ready!==true)fail('SEALED_CLOCK_SOURCE_INCOMPLETE');
    return {status:'TYPED_SOURCE_BOUND',result,source_authenticated:false,official_metric:false};
  }catch(e){return {status:'PARTIAL',reason_code:reason(e),source_authenticated:false,official_metric:false};}
}

export async function collectR9Measurement({request,budget,repository,window,sourceContractRaw=null,naturalSelection=null,liveClock=null,runtimeInputs=null,cacheRaw=emptyR9ArtifactCache(repository),onStore=()=>{},observer=null}){
  const slice=r9RequestSlice(request,budget),gaps=[];let contract=null,restored=null,native=null,verifiedObserver=null,observerProved=observer===null;
  if(!slice.allowance)return {status:'partial',reason_code:'MEASUREMENT_APP_REQUIRED',metrics:null,t0:null,cache_raw:cacheRaw,sealed_packet:null};
  try{contract=await loadR9DefaultBranchContract({request:slice.request,repository});restored=await restoreArtifact(slice.request,repository,contract,cacheRaw);
    if(!restored.packet)gaps.push(restored.reason_code);
    if(observer!==null)try{
      if(!exact(observer,['run_id','run_attempt','head_sha'])||!id(observer.run_id)||!Number.isSafeInteger(observer.run_attempt)||observer.run_attempt<1||!sha(observer.head_sha))fail('CURRENT_OBSERVER_IDENTITY_INVALID');
      const r=await bodyOf(slice.request,`/repos/${repository}/actions/runs/${observer.run_id}`),wf=await sourceText(slice.request,repository,R9_PUBLISHER_PATH,observer.head_sha);
      if(String(r.id)!==String(observer.run_id)||r.run_attempt!==observer.run_attempt||r.head_sha!==observer.head_sha||r.status!=='in_progress'||
        r.path.split('@')[0]!==R9_PUBLISHER_PATH||!['schedule','workflow_dispatch'].includes(r.event)||r.head_branch!==contract.default_branch||
        r.head_repository?.full_name!==repository||!Array.isArray(r.pull_requests)||r.pull_requests.length||!publisherRole(contract,wf.blob,wf.text))fail('CURRENT_OBSERVER_NATIVE_ROLE_NOT_PROVED');
      verifiedObserver={run_id:String(r.id),run_attempt:r.run_attempt,head_sha:r.head_sha};observerProved=true;
    }catch(e){gaps.push(reason(e));}
    native=await collectIncrementalNative({request:slice.request,repository,window,authenticatedStoreRaw:restored.authenticated_native_store_raw??restored.packet?.native_store_raw??null,onStore,observer:verifiedObserver});
    if(native.status!=='COMPLETE')gaps.push(native.reason_code??'NATIVE_POPULATION_INCOMPLETE');
  }catch(e){gaps.push(reason(e));}
  const packet=restored?.packet,metrics={};let four=null,clock=null,binding=null,selection=null,clockSourceBound=false;
  try{selection=sourceContract(sourceContractRaw,repository,window);}catch{gaps.push('INDEPENDENT_SOURCE_CONTRACT_MISSING_OR_INVALID');}
  let naturalSelectionBound=false;
  // The contract already independently captured this immutable config from
  // its exact default-branch head before Native collection. Reuse those bytes;
  // a redundant late read must not turn slice exhaustion into a registry gap.
  if(naturalSelection&&contract)try{const cfg=contract.r9_registry;
    let sameSourceLineage=naturalSelection.head_sha===contract.head_sha;
    if(!sameSourceLineage){const history=await bodyOf(slice.request,`/repos/${repository}/compare/${naturalSelection.head_sha}...${contract.head_sha}`);
      sameSourceLineage=['ahead','identical'].includes(history.status)&&history.merge_base_commit?.sha===naturalSelection.head_sha;}
    naturalSelectionBound=sameSourceLineage&&cfg.registration_status==='registered'&&
      same(cfg.natural_producers,naturalSelection.natural_producers)&&same(cfg.operation_coverage,runtimeInputs?.operation_coverage)&&
      same(cfg.scope,selection?.scope)&&cfg.forward_epoch?.epoch_id===runtimeInputs?.forward_epoch?.epoch_id&&
      (naturalSelection.head_sha===contract.head_sha||
        sameNaturalSourceSnapshot(cfg,naturalSelection,runtimeInputs,contract));
    if(!naturalSelectionBound)gaps.push('INDEPENDENT_NATURAL_SOURCE_REGISTRY_NOT_ESTABLISHED');
  }catch{gaps.push('INDEPENDENT_NATURAL_SOURCE_REGISTRY_NOT_ESTABLISHED');}
  const naturalInputs=naturalSelection&&native?.status==='COMPLETE'?await collectNaturalSourceArtifacts({request:slice.request,repository,native,
    selection:naturalSelection,readZip:b=>readSealedPacketZip(b,'natural-packet.json'),authenticatedEntries:packet?.natural_inputs?.entries??[],
    authenticatedSourceBytes:packet?.natural_inputs?.source_bytes??{},authenticatedAppChecks:packet?.natural_inputs?.app_checks??{},
    authenticatedExecutionSnapshots:packet?.natural_inputs?.execution_snapshots??{},
    authenticatedExecutionConfigurations:packet?.natural_inputs?.execution_configurations??{}}):null;
  if(naturalInputs){const refs=new Set(naturalInputs.entries.flatMap(x=>JSON.parse(x.packet_raw).events.flatMap(e=>
    e.kind==='round_ci_observation'?(e.payload.native_runs??[]).map(r=>r.run_id+':'+r.attempt):e.kind==='operation_request'?(e.payload.run_keys??[]):[])));
    for(const n of native.all_population_packets??[])if(refs.has(key(n.run))&&!native.population_packets.some(p=>key(p.run)===key(n.run)))native.population_packets.push(n);}
  const mappedAttempts=native?.status==='COMPLETE'&&selection?.four_expected_sources_raw?mapNativeAttemptsForFourSource(native,selection.four_expected_sources_raw,window,
    {profilesRaw:naturalSelection?.profiles_raw??null,workflowBlobs:naturalSelection?.workflow_blobs??{}}):[];
  const activity=naturalInputs?await collectNativeActivity({request:slice.request,repository,window,authenticatedActivity:packet?.natural_inputs?.activity??null}):null;
  if(naturalInputs)naturalInputs.activity=activity;
  const built=runtimeInputs&&naturalInputs?assembleNaturalFourSourceFrame({native,attemptRows:mappedAttempts,natural:naturalInputs,runtime:runtimeInputs,
    closedAt:new Date().toISOString(),appChecks:naturalInputs.app_checks,sourceBytes:{...runtimeInputs.admission_source_bytes,...naturalInputs.source_bytes},providerEvents:activity?.events??[],providerActivity:activity}):null;
  let frame=built?.frame??packet?.four_source;
  const expectedForFrame=built?.frame?.expected_sources_raw??selection?.four_expected_sources_raw;
  try{if(frame&&expectedForFrame){
    frame=excludeQuarantinedMainMoves(frame,activity);
    if(!built?.frame&&!same(parseFourSourceRawData(frame.expected_sources_raw),parseFourSourceRawData(expectedForFrame)))fail('FOUR_SOURCE_INDEPENDENT_SELECTION_MISMATCH');
    four=readMergeAdmissionFourSources(frame.packet_raw,expectedForFrame);
    if(built?.math?.metrics?.wasted_final_rounds&&four.metrics?.wasted_final_rounds){
      four.metrics.wasted_final_rounds.activity_coverage=built.math.metrics.wasted_final_rounds.activity_coverage;
      four.metrics.wasted_final_rounds.activity_dependent_unknown_rounds=built.math.metrics.wasted_final_rounds.activity_dependent_unknown_rounds;}
    const f=parseFourSourceRawData(frame.packet_raw);
    // Exact attempt identities/head/status must be present in the independently
    // collected population. Additional reference-closure rows remain permitted.
    binding=bindFourSourceNativePopulation(frame.packet_raw,native,expectedForFrame);
    if(!atEqual(f.window.start,window.start)||!atEqual(f.window.end,window.end)||!binding.complete)gaps.push(binding.reason_code??'FOUR_SOURCE_NATIVE_POPULATION_MISMATCH');
    if(!four.candidate_ready)gaps.push('FOUR_SOURCE_SUPPLIED_POPULATION_INCOMPLETE');
  }else gaps.push('NATURAL_ADMISSION_OPERATION_ROUND_PRODUCER_PACKETS_MISSING');}catch{gaps.push('NATURAL_FOUR_SOURCE_PACKET_MALFORMED');}
  const actualClock=liveClock??packet?.clock;
  if(actualClock){const bound=bindClockSource(actualClock,sourceContractRaw,repository,window);clock=bound.result;clockSourceBound=bound.status==='TYPED_SOURCE_BOUND';if(!clockSourceBound)gaps.push(bound.reason_code);}
  else gaps.push('AUTHENTICATED_SEALED_CLOCK_TRANSPORT_MISSING');
  // Fresh Source provenance is proved by real immutable original-job
  // artifacts plus the independent protected-main Source registry.
  const authenticated=restored?.status==='AUTHENTICATED_SEALED_ARTIFACT'||naturalSelectionBound&&naturalInputs?.status==='NATIVE_ORIGIN_BOUND';
  const fourQualified=authenticated&&observerProved&&native?.status==='COMPLETE'&&binding?.complete===true&&four?.candidate_ready===true&&
    !gaps.some(g=>/FOUR_SOURCE|NATURAL_|NATIVE_/.test(g));
  const clockSourceQualified=authenticated&&clockSourceBound&&clock?.candidate_ready===true;
  const clockQualified=clockSourceQualified&&clock.status==='UNIQUE_VALUE_CANDIDATE';
  const qualified=fourQualified&&clockQualified;
  for(const name of ['admission_failures_by_reason','unclaimed_admitted','update_main_rounds','wasted_final_rounds','cancellation_causes']){
    const m=four?.metrics?.[name];metrics[name]=fourQualified&&m?{...m,status:m.value===null?'partial':'measured',official_metric:true,source_authenticated:true}:unavailable(gaps[0]??'FOUR_SOURCE_NOT_QUALIFIED');
    if(m&&!fourQualified)metrics[name].supplied_calculation_candidate=m;
  }
  metrics.queue_depth_p95=clockQualified?{status:'measured',value:clock.value,official_metric:true,source_authenticated:true}:
    clockSourceQualified?{status:'partial',value:null,reason:clock.reason??'CLOCK_VALUE_NOT_PROVED',official_metric:false,source_authenticated:true,
      duration_us:clock.duration_us,uncertainty_union_us:clock.uncertainty_union_us}:unavailable(gaps[0]??'CLOCK_VALUE_NOT_PROVED');
  return {schema:'clued.merge-admission-r9-collection/1',repository,status:qualified?'measured':'partial',metrics,gaps:[...new Set(gaps)],
    window,native,source_proof:restored?.proof??null,source_authenticated:authenticated,official_metric:fourQualified||clockQualified,
    source_readiness:{four_source:fourQualified,clock_source:clockSourceQualified,complete:fourQualified&&clockSourceQualified},
    requests:{used:slice.used,scheduling_share:slice.allowance,shared_run_cap:budget.cap},t0:null,
    natural_continuity:'NOT_ESTABLISHED',cache_raw:packet?JSON.stringify({schema:R9_CACHE_SCHEMA,repository,artifact_id:restored.artifact_id,zip_base64:restored.zip_bytes.toString('base64')}):emptyR9ArtifactCache(repository),
    // The caller seals only independently authenticated prior packets + fresh
    // Native captures; a future accepted writer publishes this increment once.
    next_native_store_raw:native?.store_raw??null,natural_inputs:naturalInputs,native_attempt_rows:mappedAttempts,natural_frame_build:built?{status:built.status,gaps:built.gaps}:null,
    activity_coverage:activity?{status:activity.status,reason_code:activity.reason_code,delivery_through_window_end:activity.delivery_through_window_end,
      closing_delivery_watermark:activity.closing_delivery_watermark,observed_pagination_status:activity.observed_pagination_status,provider_retention:activity.provider_retention,observed_push_events:activity.events.length,
      quarantined_ids:activity.quarantined_ids,quarantine:activity.quarantine}:null,
    authenticated_source_inputs:frame||actualClock?{four_source:frame??null,clock:actualClock??null}:null,sealed_packet:null};
}

export function sealR9Packet({repository,publisher,sourceBlobs,window,sealedAt,nativeStoreRaw,fourSource=null,clock=null,naturalInputs=null}){
  const packet={schema:R9_PACKET_SCHEMA,repository,publisher,source_blobs:sourceBlobs,window,sealed_at:sealedAt,
    native_store_raw:nativeStoreRaw,four_source:fourSource,clock,natural_inputs:naturalInputs};
  packetShape(JSON.stringify(packet),repository);return JSON.stringify(packet);
}
