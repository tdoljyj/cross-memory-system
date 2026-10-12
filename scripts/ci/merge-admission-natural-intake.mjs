// Existing Actions artifact intake only. One shared measurement request budget;
// no token, retry, trigger, Clued append or inferred operation/cancellation cause.
import {createHash} from 'node:crypto';
import {readNaturalArtifact,admissionEnvelopeInput,operationEnvelopeInput} from './merge-admission-source-producer.mjs';
import {nativeJobIsNonExecution} from './merge-admission-native-population.mjs';
export const NATURAL_CACHE_SCHEMA='clued.r9-natural-origin-cache/1';
const digest=x=>createHash('sha256').update(x).digest('hex');
const blob=x=>createHash('sha1').update('blob '+Buffer.byteLength(x)+'\0').update(x).digest('hex');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)||Number.isSafeInteger(x)&&x>0;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const code=e=>/^[A-Z0-9_]{1,100}$/.test(e?.message??'')?e.message:'NATURAL_INTAKE_FAILED';
const refuse=x=>{throw Error(x);};
async function body(request,route,options){const r=await request(route,options);if(r?.ok!==true)refuse('NATURAL_SHARED_REQUEST_STOPPED');return r.body;}
async function artifacts(request,repository,run){
  const rows=[];let total=null;
  for(let page=1;page<=20;page++){
    const b=await body(request,`/repos/${repository}/actions/runs/${run}/artifacts?per_page=100&page=${page}`);
    if(!Number.isSafeInteger(b?.total_count)||b.total_count<0||!Array.isArray(b.artifacts)||
      total!==null&&b.total_count!==total)refuse('NATURAL_ARTIFACT_PAGINATION_INVALID');
    total=b.total_count;if(b.artifacts.length!==Math.min(100,total-rows.length))refuse('NATURAL_ARTIFACT_PAGINATION_INVALID');
    for(const a of b.artifacts){if(!id(a.id)||rows.some(r=>String(r.id)===String(a.id)))refuse('NATURAL_ARTIFACT_DUPLICATE_ID');rows.push(a);}
    if(rows.length===total)return rows;
  }refuse('NATURAL_ARTIFACT_PAGE_CAP');
}
async function source(request,repository,file,ref){
  const x=await body(request,`/repos/${repository}/contents/${file}?ref=${encodeURIComponent(ref)}`);
  if(x?.type!=='file'||x.path!==file||x.encoding!=='base64'||!sha(x.sha)||typeof x.content!=='string')refuse('NATURAL_NATIVE_SOURCE_INVALID');
  const b=Buffer.from(x.content.replace(/\s/g,''),'base64'),text=b.toString('utf8');
  if(b.length>1024*1024||Buffer.from(text).compare(b)||blob(b)!==x.sha)refuse('NATURAL_NATIVE_SOURCE_INVALID');
  return {text,blob:x.sha,sha256:digest(b)};
}
// A positive scheduler duration is not execution evidence. For this exact
// hosted slot producer only, independently prove that no runner was assigned.
// Never broaden the Native chronology predicate or infer cancellation cause.
async function unassignedSlotProducer(request,repository,n,d,selection,sourceMemo){
  const r=n.run,j=n.jobs.find(x=>x.name===d.job_name);
  if(r.path.split('@')[0]!=='.github/workflows/clued-merge-slot-ci.yml'||r.event!=='workflow_run'||
    d.job_id!=='report'||d.job_name!=='clued-merge-slot-ci'||r.conclusion!=='cancelled'||n.jobs.length!==1||
    j?.status!=='completed'||j.conclusion!=='cancelled'||!Array.isArray(j.steps)||j.steps.length||j.created_at!==j.started_at)return null;
  const origin=await body(request,`/repos/${repository}/actions/runs/${r.run_id}/attempts/${r.run_attempt}`);
  if(String(origin?.id)!==r.run_id||origin.run_attempt!==r.run_attempt||origin.head_sha!==r.head_sha||
    origin.status!=='completed'||origin.conclusion!=='cancelled'||origin.event!=='workflow_run'||typeof origin.path!=='string'||
    origin.path.split('@')[0]!==d.workflow_path||origin.head_branch!==selection.default_branch||origin.head_repository?.full_name!==repository)return null;
  const sourceKey=r.head_sha+':'+d.workflow_path;
  if(!sourceMemo.has(sourceKey))sourceMemo.set(sourceKey,await source(request,repository,d.workflow_path,r.head_sha));
  if(sourceMemo.get(sourceKey).blob!==d.workflow_blob)return null;
  const history=await body(request,`/repos/${repository}/compare/${r.head_sha}...${selection.head_sha}`);
  if(!['ahead','identical'].includes(history?.status)||history.merge_base_commit?.sha!==r.head_sha)return null;
  const read=async()=>{
    const b=await body(request,`/repos/${repository}/actions/runs/${r.run_id}/attempts/${r.run_attempt}/jobs?per_page=100&page=1`);
    if(b?.total_count!==1||!Array.isArray(b.jobs)||b.jobs.length!==1)return null;
    const w=b.jobs[0];
    if(String(w?.id)!==j.id||String(w.run_id)!==r.run_id||w.run_attempt!==r.run_attempt||w.name!==j.name||
      w.status!==j.status||w.conclusion!==j.conclusion||!Array.isArray(w.steps)||w.steps.length||
      w.runner_id!==0||w.runner_name!==''||w.runner_group_id!==0||w.runner_group_name!==''||
      !Array.isArray(w.labels)||w.labels.length!==1||w.labels[0]!=='ubuntu-slim')return null;
    for(const field of ['created_at','started_at','completed_at'])if(w[field]===null?j[field]!==null:
      typeof w[field]!=='string'||new Date(w[field]).toISOString()!==j[field])return null;
    return canonical(w);
  };
  const first=await read(),last=await read();
  if(!first||!last||JSON.stringify(first)!==JSON.stringify(last))return null;
  return {run_key:r.run_id+':'+r.run_attempt,job_id:j.id,workflow_blob:d.workflow_blob,
    native_jobs_digest:digest(JSON.stringify(n.jobs)),before_digest:digest(JSON.stringify(first)),after_digest:digest(JSON.stringify(last)),
    basis:'COMPLETE_STABLE_NATIVE_UNASSIGNED_HOSTED_SLOT_PRODUCER',runner_id:0,runner_name:'',runner_group_id:0,runner_group_name:'',labels:['ubuntu-slim']};
}
// The accepted report writer can later seal these data + Native-origin proofs
// together. A restored batch is reused only after that writer is independently
// authenticated; an actions/cache hit or a JSON authority flag is insufficient.
export async function collectNaturalSourceArtifacts({request,repository,native,selection,readZip,authenticatedEntries=[],authenticatedSourceBytes={},authenticatedAppChecks={}}){
  const entries=[],gaps=[],before=[],after=[],nonExecutionProofs=[],sourceBytes={...authenticatedSourceBytes},checks={...authenticatedAppChecks},sourceMemo=new Map();
  try{
    if(native?.status!=='COMPLETE'||selection?.repository!==repository||!sha(selection.head_sha)||typeof readZip!=='function')refuse('NATURAL_INDEPENDENT_INPUTS_MISSING');
    const descriptors=selection.natural_producers;
    if(!Array.isArray(descriptors)||!descriptors.length)refuse('NATURAL_PRODUCER_SOURCE_SELECTION_MISSING');
    const index=new Map();for(const d of descriptors){
      if(!object(d)||d.registration_status!=='registered'||typeof d.workflow_path!=='string'||!d.workflow_path.startsWith('.github/workflows/')||!sha(d.workflow_blob)||
        !/^[A-Za-z0-9_-]{1,100}$/.test(d.job_id)||typeof d.job_name!=='string'||!Array.isArray(d.source_paths)||!d.source_paths.length||
        !Array.isArray(d.required_steps)||!d.required_steps.length||index.has(d.workflow_path))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
      index.set(d.workflow_path,d);
    }
    const cache=new Map(authenticatedEntries.map(e=>[e.run_key+':'+e.job_id,e]));
    for(const n of native.population_packets??[]){
      const r=n.run,d=index.get(r.path.split('@')[0]);if(!d)continue;
      if(r.status!=='completed'){gaps.push({run_key:r.run_id+':'+r.run_attempt,code:'NATURAL_PRODUCER_RUN_NOT_TERMINAL'});continue;}
      const runKey=r.run_id+':'+r.run_attempt,jobs=n.jobs.filter(j=>j.name===d.job_name);
      if(jobs.length!==1){gaps.push({run_key:runKey,code:'NATURAL_PRODUCER_NATIVE_JOB_MISSING_OR_DUPLICATE'});continue;}
      const j=jobs[0];
      // The independently complete Native population retains these terminal
      // attempts. A producer which never executed has no local stream to export;
      // this is not a successful producer or permission to omit executed gaps.
      if(['skipped','cancelled'].includes(j.conclusion)&&nativeJobIsNonExecution(j))continue;
      const unassigned=await unassignedSlotProducer(request,repository,n,d,selection,sourceMemo);
      if(unassigned){nonExecutionProofs.push(unassigned);continue;}
      const artifactName=`clued-r9-natural-source-${r.run_id}-${r.run_attempt}-${d.job_id}`,key=runKey+':'+d.job_id;
      const restored=cache.get(key);
      if(restored&&restored.native_run_digest===digest(JSON.stringify(r))&&restored.native_jobs_digest===digest(JSON.stringify(n.jobs))&&
        restored.descriptor_digest===digest(JSON.stringify(d))&&sourceBytes[restored.checkout_sha]){entries.push(restored);continue;}
      const members=await artifacts(request,repository,r.run_id),total=members.length;
      before.push({run_key:runKey,total,ids:members.map(a=>String(a.id))});
      const matches=members.filter(a=>a.name===artifactName&&a.expired===false);
      if(matches.length!==1){gaps.push({run_key:runKey,code:'NATURAL_EXPECTED_ARTIFACT_MISSING_OR_DUPLICATE'});continue;}
      const a=matches[0],m=await body(request,`/repos/${repository}/actions/artifacts/${a.id}`);
      if(String(m?.id)!==String(a.id)||m.name!==artifactName||m.expired!==false||!/^sha256:[a-f0-9]{64}$/.test(m.digest??'')||
        String(m.workflow_run?.id)!==r.run_id||m.workflow_run.head_sha!==r.head_sha)refuse('NATURAL_NATIVE_ARTIFACT_IDENTITY_INVALID');
      const bytes=await body(request,`/repos/${repository}/actions/artifacts/${a.id}/zip`,{responseType:'bytes'});
      if(!Buffer.isBuffer(bytes)||digest(bytes)!==m.digest.slice(7))refuse('NATURAL_ARTIFACT_DIGEST_MISMATCH');
      const raw=readZip(bytes),parsed=readNaturalArtifact(raw,{repository,run_id:r.run_id,attempt:r.run_attempt,logical_job_key:d.job_id});
      if(parsed.status!=='NATURAL_ARTIFACT_DATA_CANDIDATE'||parsed.local_stream.status!=='CLOSED_LOCAL_STREAM'||
        !Array.isArray(parsed.local_stream.known_gaps)||parsed.local_stream.known_gaps.length){gaps.push({run_key:runKey,code:'NATURAL_LOCAL_STREAM_INCOMPLETE'});continue;}
      const packet=JSON.parse(raw),checkout=new Set(packet.sessions.map(s=>s.executed_checkout_sha));
      if(checkout.size!==1||!sha([...checkout][0]))refuse('NATURAL_ACTUAL_CHECKOUT_UNKNOWN');const commit=[...checkout][0];
      const origin=await body(request,`/repos/${repository}/actions/runs/${r.run_id}/attempts/${r.run_attempt}`);
      if(String(origin?.id)!==r.run_id||origin.run_attempt!==r.run_attempt||origin.head_sha!==r.head_sha||
        origin.event!=='pull_request_target'&&(origin.head_repository?.full_name!==repository||origin.head_branch!==selection.default_branch)||
        !(['pull_request_target','schedule','workflow_dispatch','push'].includes(origin.event)||origin.event==='workflow_run'&&
          d.workflow_path==='.github/workflows/clued-merge-slot-ci.yml'&&d.job_id==='report'&&d.job_name==='clued-merge-slot-ci'))refuse('NATURAL_PRODUCER_ORIGIN_INVALID');
      const compare=await body(request,`/repos/${repository}/compare/${commit}...${selection.head_sha}`);
      if(!['ahead','identical'].includes(compare?.status)||compare.merge_base_commit?.sha!==commit)refuse('NATURAL_CHECKOUT_NOT_MAIN_HISTORY');
      const workflow=await source(request,repository,d.workflow_path,commit);
      if(workflow.blob!==d.workflow_blob)refuse('NATURAL_PRODUCER_WORKFLOW_SOURCE_MISMATCH');
      if(d.required_steps.some(name=>j.steps.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length!==1))refuse('NATURAL_PRODUCER_EXECUTION_INCOMPLETE');
      const admissionPaths=selection.admission_source;
      const texts={},actualBlobs={};
      for(const path of d.source_paths){const cacheKey=commit+':'+path;
        if(!sourceMemo.has(cacheKey))sourceMemo.set(cacheKey,await source(request,repository,path,commit));const s=sourceMemo.get(cacheKey);
        if(d.source_blobs&&s.blob!==d.source_blobs[path])refuse('NATURAL_SOURCE_SELECTION_BYTES_MISMATCH');
        const events=packet.events.filter(e=>e.source.path===path);
        if(events.some(e=>e.source.sha256!==s.sha256||e.source.executed_checkout_sha!==commit))refuse('NATURAL_PRODUCER_SOURCE_BYTES_MISMATCH');
        for(const k of ['script','workflow','reverify_workflow','policy'])if(admissionPaths?.[k+'_path']===path){texts[k]=s.text;actualBlobs[k+'_blob']=s.blob;}}
      if(Object.keys(texts).length===4)sourceBytes[commit]={texts,...actualBlobs};
      if(packet.events.some(e=>!d.source_paths.includes(e.source.path)))refuse('NATURAL_UNREVIEWED_EVENT_SOURCE');
      const closing=await artifacts(request,repository,r.run_id);
      if(closing.length!==total||closing.map(x=>String(x.id)).join('|')!==members.map(x=>String(x.id)).join('|'))refuse('NATURAL_ARTIFACT_CLOSING_POPULATION_UNPROVED');
      after.push({run_key:runKey,total,ids:members.map(a=>String(a.id))});
      entries.push({run_key:runKey,job_id:d.job_id,artifact_id:String(a.id),artifact_digest:m.digest,selection_head:selection.head_sha,native_origin:{head_branch:origin.head_branch,event:origin.event},
        descriptor_digest:digest(JSON.stringify(d)),native_run_digest:digest(JSON.stringify(r)),native_jobs_digest:digest(JSON.stringify(n.jobs)),
        checkout_sha:commit,packet_raw:raw,origin_basis:'NATIVE_ARTIFACT_DIGEST_JOB_MAIN_HISTORY_EXACT_REVIEWED_SOURCE'});
    }
    for(const entry of entries)for(const event of JSON.parse(entry.packet_raw).events){const check=event.kind==='app_check'?event.payload.check_run_id:null;
      if(check&&!checks[check]){const q=await body(request,`/repos/${repository}/check-runs/${check}`);
        checks[check]={id:q.id,app:{id:q.app?.id},name:q.name,head_sha:q.head_sha,status:q.status,conclusion:q.conclusion,external_id:q.external_id};}}
  }catch(e){gaps.push({code:code(e)});}
  return {schema:NATURAL_CACHE_SCHEMA,status:gaps.length?'PARTIAL':'NATIVE_ORIGIN_BOUND',entries,gaps,
    source_bytes:sourceBytes,app_checks:checks,artifact_population:{before,after},non_execution_proofs:nonExecutionProofs,source_authenticated:false,official_metric:false,t0:null,
    whole_population:'MANUAL_OWNER_HOLDER_OPERATION_AND_FINAL_ROUND_JOURNALS_NOT_ESTABLISHED'};
}
// Export concrete bridges instead of asking the collector to infer business
// facts from later heads. Missing post/claim/check/selection remain explicit.
export function mapNaturalSourceEvents(entry,inputs){
  const p=JSON.parse(entry.packet_raw),finals=p.events.filter(e=>e.kind==='admission_final'),operations=[];
  for(const requestEvent of p.events.filter(e=>e.kind==='operation_request'&&e.payload.action==='update_branch')){
    const operation_id=requestEvent.payload.operation_id;
    operations.push(operationEnvelopeInput({preEvent:p.events.find(e=>e.record_id===requestEvent.payload.pre_observation_id),requestEvent,
      responseEvent:p.events.find(e=>e.kind==='operation_response'&&e.payload.operation_id===operation_id),
      nativePost:inputs.native_posts?.[operation_id]??(()=>{const e=p.events.find(e=>e.kind==='operation_post'&&e.payload.operation_id===operation_id);
        return e?{number:e.payload.pr_number,head_sha:e.payload.head_sha,main_sha:e.payload.main_sha,parents:e.payload.parents,
          event_at:e.event_at,collected_at:inputs.collected_at,observation_id:e.record_id}:null;})(),collectedAt:inputs.collected_at,scope:inputs.scope,sourceRef:entry.artifact_digest.slice(7)}));
  }
  const admissions=finals.map(finalEvent=>{const evaluation_id=finalEvent.payload.evaluation_id;
    return admissionEnvelopeInput({finalEvent,inputEvent:p.events.find(e=>e.kind==='admission_input'&&e.payload.evaluation_id===evaluation_id),
      claimEvent:p.events.find(e=>e.kind==='claim_verification'&&e.payload.evaluation_id===evaluation_id),
      appEvent:p.events.find(e=>e.kind==='app_check'&&e.payload.evaluation_id===evaluation_id),
      selectionEvent:p.events.find(e=>e.kind==='batch_selection'&&e.payload.evaluation_id===evaluation_id),
      nativeIdentity:inputs.native_identities?.[evaluation_id],appNativeObservation:inputs.app_observations?.[evaluation_id],
      sourceCheckoutSha:entry.checkout_sha,claimReceiptId:inputs.claim_receipts?.[evaluation_id]});});
  return {admissions,operations,batches:p.events.filter(e=>/^batch_/.test(e.kind)),
    round_observations:p.events.filter(e=>/^round_|^slot_/.test(e.kind)),
    actual_round_termination:null,cancel_causes:'UNKNOWN_UNLESS_ACTUAL_PROVIDER_CAUSAL_RECEIPT',source_authenticated:false,official_metric:false,t0:null};
}
