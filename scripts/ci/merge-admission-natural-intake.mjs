// Existing Actions artifact intake only. One shared measurement request budget;
// no token, retry, trigger, Clued append or inferred operation/cancellation cause.
import {createHash} from 'node:crypto';
import {readNaturalArtifact,admissionEnvelopeInput,operationEnvelopeInput} from './merge-admission-source-producer.mjs';
import {nativeJobIsNonExecution} from './merge-admission-native-population.mjs';
import {registeredWorkflowSource,rolesForSource} from './clued-workflow-profile.mjs';
export const NATURAL_CACHE_SCHEMA='clued.r9-natural-origin-cache/1';
const digest=x=>createHash('sha256').update(x).digest('hex');
const blob=x=>createHash('sha1').update('blob '+Buffer.byteLength(x)+'\0').update(x).digest('hex');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>typeof x==='string'&&/^[1-9][0-9]{0,19}$/.test(x)||Number.isSafeInteger(x)&&x>0;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const code=e=>/^[A-Z0-9_]{1,100}$/.test(e?.message??'')?e.message:'NATURAL_INTAKE_FAILED';
const refuse=x=>{throw Error(x);};
function descriptorVariants(d){
  const hasHistory=Object.hasOwn(d,'previous_source_blobs');
  const renamed=Object.hasOwn(d,'previous_job_name');
  const versioned=Object.hasOwn(d,'previous_source_versions');
  if(versioned&&(hasHistory||renamed))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
  if(renamed&&(d.workflow_path!=='.github/workflows/clued-work-admission.yml'||
    d.job_id!=='clued-work-admission'||d.job_name!=='kooyumi-work-admission'||
    d.previous_job_name!=='clued-work-admission'||!hasHistory))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
  if(d.source_blobs===undefined){
    if(hasHistory||versioned)refuse('NATURAL_PRODUCER_SELECTION_INVALID');
    return [d];
  }
  const versions=versioned?d.previous_source_versions:[];
  // Only the slot report retains one additional exact predecessor when its
  // completion watcher gains the registered Host/Guest qualification names.
  // Other explicit roles stay at six, legacy maps at four, and PR execution
  // template capacity is unchanged.
  const historyLimit=d.workflow_path==='.github/workflows/clued-merge-slot-ci.yml'&&
    d.job_id==='report'&&d.job_name==='clued-merge-slot-ci'?7:6;
  if(versioned&&(!Array.isArray(versions)||versions.length>historyLimit||!d.source_paths.includes(d.workflow_path)||
    versions.some(v=>!object(v)||Object.keys(v).sort().join('|')!=='job_name|source_blobs'||
      typeof v.job_name!=='string'||!v.job_name||v.job_name!==v.job_name.trim()||
      v.job_name!==d.job_name&&!(d.workflow_path==='.github/workflows/clued-work-admission.yml'&&
        d.job_id==='clued-work-admission'&&d.job_name==='kooyumi-work-admission'&&v.job_name==='clued-work-admission'))))
    refuse('NATURAL_PRODUCER_SELECTION_INVALID');
  const history=versioned?versions.map(v=>v.source_blobs):hasHistory?d.previous_source_blobs:[];
  if(renamed&&(!history.length||history.some(map=>map?.[d.workflow_path]===d.workflow_blob)))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
  if(!Array.isArray(history)||history.length>(versioned?historyLimit:4)||new Set(d.source_paths).size!==d.source_paths.length||
    d.source_paths.some(path=>typeof path!=='string'))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
  const paths=[...d.source_paths].sort(),maps=[d.source_blobs,...history],seen=new Set();
  if(object(d.source_blobs)&&Object.hasOwn(d.source_blobs,d.workflow_path)&&d.source_blobs[d.workflow_path]!==d.workflow_blob)refuse('NATURAL_PRODUCER_SELECTION_INVALID');
  for(const map of maps){
    if(!object(map)||Object.keys(map).sort().join('|')!==paths.join('|')||Object.values(map).some(pin=>!sha(pin)))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
    const identity=JSON.stringify(canonical(map));if(seen.has(identity))refuse('NATURAL_PRODUCER_SELECTION_INVALID');seen.add(identity);
  }
  // History authorizes exact historical bytes only. Exclude that declaration
  // from each version's digest so a previously authenticated descriptor keeps
  // its original identity, field order and complete source-map identity.
  const {previous_source_blobs,previous_job_name,previous_source_versions,...base}=d;
  return maps.map((source_blobs,index)=>({...base,job_name:index&&versioned?versions[index-1].job_name:index&&renamed?previous_job_name:d.job_name,
    workflow_blob:source_blobs[d.workflow_path]??d.workflow_blob,source_blobs}));
}
function executionSnapshotValid(snapshot,templates){
  try{
    if(!object(snapshot)||Object.keys(snapshot).sort().join('|')!==['source_checkout_sha','proof_profiles_raw','role_specs_raw','workflow_directory','main_history'].sort().join('|')||
      !sha(snapshot.source_checkout_sha)||typeof snapshot.proof_profiles_raw!=='string'||typeof snapshot.role_specs_raw!=='string'||
      !templates.some(t=>digest(snapshot.proof_profiles_raw)===t.profiles_sha256&&digest(snapshot.role_specs_raw)===t.role_specs_sha256)||
      !Array.isArray(snapshot.workflow_directory)||snapshot.workflow_directory.length>1000)return false;
    const anchored=templates.find(t=>t.source_checkout_sha===snapshot.source_checkout_sha);
    if(anchored&&(digest(snapshot.proof_profiles_raw)!==anchored.profiles_sha256||digest(snapshot.role_specs_raw)!==anchored.role_specs_sha256))return false;
    const history=snapshot.main_history;
    if(!object(history)||Object.keys(history).sort().join('|')!==['base_commit','head_commit','merge_base_commit','status'].sort().join('|')||
      history.base_commit!==snapshot.source_checkout_sha||history.merge_base_commit!==snapshot.source_checkout_sha||!sha(history.head_commit)||
      history.status!==(history.head_commit===snapshot.source_checkout_sha?'identical':'ahead'))return false;
    const profiles=JSON.parse(snapshot.proof_profiles_raw),roles=JSON.parse(snapshot.role_specs_raw),directory=new Map();
    for(const row of snapshot.workflow_directory){if(!object(row)||Object.keys(row).sort().join('|')!==['path','sha','type','mode'].sort().join('|')||typeof row.path!=='string'||!row.path.startsWith('.github/workflows/')||
      row.type!=='blob'||row.mode!=='100644'||!sha(row.sha)||directory.has(row.path))return false;directory.set(row.path,row.sha);}
    if(!object(profiles.workflows)||!Object.keys(profiles.workflows).length)return false;
    for(const path of Object.keys(profiles.workflows)){
      const pin=directory.get(path),source=registeredWorkflowSource(profiles,path,pin),accepted=rolesForSource(roles,path,pin);
      if(!source.passed||!accepted||JSON.stringify(accepted.map(r=>r.job_id).sort())!==JSON.stringify([...source.profile.primary_ids].sort()))return false;
    }
    return true;
  }catch{return false;}
}
function materializeExecutionSnapshot(snapshot,configurations){
  if(!object(snapshot)||!Object.hasOwn(snapshot,'configuration_key'))return snapshot;
  if(Object.keys(snapshot).sort().join('|')!==['source_checkout_sha','configuration_key','workflow_directory','main_history'].sort().join('|'))return null;
  const cfg=object(configurations)?configurations[snapshot.configuration_key]:null;
  if(!object(cfg)||Object.keys(cfg).sort().join('|')!==['proof_profiles_raw','role_specs_raw'].sort().join('|')||
    typeof cfg.proof_profiles_raw!=='string'||typeof cfg.role_specs_raw!=='string'||snapshot.configuration_key!==digest(cfg.proof_profiles_raw)+':'+digest(cfg.role_specs_raw))return null;
  const {configuration_key,...rest}=snapshot;return {...rest,...cfg};
}
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
async function unassignedSlotProducer(request,repository,n,d,selection,sourceMemo,variants){
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
  const workflowBlob=sourceMemo.get(sourceKey).blob;
  if(!variants.some(variant=>variant.workflow_blob===workflowBlob))return null;
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
  return {run_key:r.run_id+':'+r.run_attempt,job_id:j.id,workflow_blob:workflowBlob,
    native_jobs_digest:digest(JSON.stringify(n.jobs)),before_digest:digest(JSON.stringify(first)),after_digest:digest(JSON.stringify(last)),
    basis:'COMPLETE_STABLE_NATIVE_UNASSIGNED_HOSTED_SLOT_PRODUCER',runner_id:0,runner_name:'',runner_group_id:0,runner_group_name:'',labels:['ubuntu-slim']};
}
// The accepted report writer can later seal these data + Native-origin proofs
// together. A restored batch is reused only after that writer is independently
// authenticated; an actions/cache hit or a JSON authority flag is insufficient.
export async function collectNaturalSourceArtifacts({request,repository,native,selection,readZip,authenticatedEntries=[],authenticatedSourceBytes={},authenticatedAppChecks={},authenticatedExecutionSnapshots={},authenticatedExecutionConfigurations={}}){
  const entries=[],gaps=[],before=[],after=[],nonExecutionProofs=[],sourceBytes={...authenticatedSourceBytes},checks={...authenticatedAppChecks},sourceMemo=new Map(),executionSnapshots={},executionConfigurations={},legacySnapshots=new Map();
  try{
    if(native?.status!=='COMPLETE'||selection?.repository!==repository||!sha(selection.head_sha)||typeof readZip!=='function')refuse('NATURAL_INDEPENDENT_INPUTS_MISSING');
    const descriptors=selection.natural_producers;
    if(!Array.isArray(descriptors)||!descriptors.length)refuse('NATURAL_PRODUCER_SOURCE_SELECTION_MISSING');
    const index=new Map();for(const d of descriptors){
      if(!object(d)||d.registration_status!=='registered'||typeof d.workflow_path!=='string'||!d.workflow_path.startsWith('.github/workflows/')||!sha(d.workflow_blob)||
        !/^[A-Za-z0-9_-]{1,100}$/.test(d.job_id)||typeof d.job_name!=='string'||!Array.isArray(d.source_paths)||!d.source_paths.length||
        !Array.isArray(d.required_steps)||!d.required_steps.length||index.has(d.workflow_path))refuse('NATURAL_PRODUCER_SELECTION_INVALID');
      index.set(d.workflow_path,{descriptor:d,variants:descriptorVariants(d)});
    }
    const cache=new Map(authenticatedEntries.map(e=>[e.run_key+':'+e.job_id,e]));
    for(const n of native.population_packets??[]){
      const r=n.run,selected=index.get(r.path.split('@')[0]);if(!selected)continue;
      const {descriptor:d,variants}=selected;
      if(r.status!=='completed'){gaps.push({run_key:r.run_id+':'+r.run_attempt,code:'NATURAL_PRODUCER_RUN_NOT_TERMINAL'});continue;}
      const runKey=r.run_id+':'+r.run_attempt,jobs=n.jobs.filter(j=>variants.some(variant=>j.name===variant.job_name));
      if(jobs.length!==1){gaps.push({run_key:runKey,code:'NATURAL_PRODUCER_NATIVE_JOB_MISSING_OR_DUPLICATE'});continue;}
      const j=jobs[0];
      // The independently complete Native population retains these terminal
      // attempts. A producer which never executed has no local stream to export;
      // this is not a successful producer or permission to omit executed gaps.
      if(['skipped','cancelled'].includes(j.conclusion)&&nativeJobIsNonExecution(j))continue;
      const unassigned=await unassignedSlotProducer(request,repository,n,d,selection,sourceMemo,variants);
      if(unassigned){nonExecutionProofs.push(unassigned);continue;}
      const artifactName=`clued-r9-natural-source-${r.run_id}-${r.run_attempt}-${d.job_id}`,key=runKey+':'+d.job_id;
      const restored=cache.get(key);
      if(restored&&restored.native_run_digest===digest(JSON.stringify(r))&&restored.native_jobs_digest===digest(JSON.stringify(n.jobs))&&
        variants.some(variant=>restored.descriptor_digest===digest(JSON.stringify(variant)))&&sourceBytes[restored.checkout_sha]){
        if(selection.execution_source_templates!==undefined&&Object.hasOwn(restored,'execution_snapshots')){
          for(const [tip,snapshot]of Object.entries(object(restored.execution_snapshots)?restored.execution_snapshots:{})){
            const rows=legacySnapshots.get(tip)??[];rows.push(snapshot);legacySnapshots.set(tip,rows);
          }
          const {execution_snapshots,...entry}=restored;entries.push(entry);
        }else entries.push(restored);
        continue;
      }
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
      let matchingVariants=variants.filter(variant=>workflow.blob===variant.workflow_blob&&j.name===variant.job_name);
      if(!matchingVariants.length)refuse('NATURAL_PRODUCER_WORKFLOW_SOURCE_MISMATCH');
      if(d.required_steps.some(name=>j.steps.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length!==1))refuse('NATURAL_PRODUCER_EXECUTION_INCOMPLETE');
      const admissionPaths=selection.admission_source;
      const texts={},actualBlobs={};
      for(const path of d.source_paths){const cacheKey=commit+':'+path;
        if(!sourceMemo.has(cacheKey))sourceMemo.set(cacheKey,await source(request,repository,path,commit));const s=sourceMemo.get(cacheKey);
        // Intersect complete-map candidates as bytes arrive. A path cannot
        // independently choose a different historical version, and an unknown
        // prefix stops at the same source read rather than spending more HTTP.
        matchingVariants=matchingVariants.filter(variant=>!variant.source_blobs||s.blob===variant.source_blobs[path]);
        if(!matchingVariants.length)refuse('NATURAL_SOURCE_SELECTION_BYTES_MISMATCH');
        const events=packet.events.filter(e=>e.source.path===path);
        if(events.some(e=>e.source.sha256!==s.sha256||e.source.executed_checkout_sha!==commit))refuse('NATURAL_PRODUCER_SOURCE_BYTES_MISMATCH');
        for(const k of ['script','workflow','reverify_workflow','policy'])if(admissionPaths?.[k+'_path']===path){texts[k]=s.text;actualBlobs[k+'_blob']=s.blob;}}
      const matched=matchingVariants[0];
      if(Object.keys(texts).length===4)sourceBytes[commit]={texts,...actualBlobs};
      if(packet.events.some(e=>!d.source_paths.includes(e.source.path)))refuse('NATURAL_UNREVIEWED_EVENT_SOURCE');
      const closing=await artifacts(request,repository,r.run_id);
      if(closing.length!==total||closing.map(x=>String(x.id)).join('|')!==members.map(x=>String(x.id)).join('|'))refuse('NATURAL_ARTIFACT_CLOSING_POPULATION_UNPROVED');
      after.push({run_key:runKey,total,ids:members.map(a=>String(a.id))});
      entries.push({run_key:runKey,job_id:d.job_id,artifact_id:String(a.id),artifact_digest:m.digest,selection_head:selection.head_sha,native_origin:{head_branch:origin.head_branch,event:origin.event},
        descriptor_digest:digest(JSON.stringify(matched)),native_run_digest:digest(JSON.stringify(r)),native_jobs_digest:digest(JSON.stringify(n.jobs)),
        checkout_sha:commit,packet_raw:raw,origin_basis:'NATIVE_ARTIFACT_DIGEST_JOB_MAIN_HISTORY_EXACT_REVIEWED_SOURCE'});
    }
    if(selection.execution_source_templates!==undefined){
      const templates=selection.execution_source_templates;
      if(!Array.isArray(templates)||!templates.length||templates.length>5||templates.some(t=>!object(t)||
        Object.keys(t).sort().join('|')!==['source_checkout_sha','profiles_sha256','role_specs_sha256'].sort().join('|')||
        !sha(t.source_checkout_sha)||!/^([a-f0-9]{64})$/.test(t.profiles_sha256??'')||!/^([a-f0-9]{64})$/.test(t.role_specs_sha256??'')))refuse('NATURAL_EXECUTION_SOURCE_SELECTION_INVALID');
      if(new Set(templates.map(t=>t.profiles_sha256+':'+t.role_specs_sha256)).size!==templates.length)refuse('NATURAL_EXECUTION_SOURCE_SELECTION_INVALID');
      const needed=new Set();
      for(let i=0;i<entries.length;i++){
        const tips=[...new Set(JSON.parse(entries[i].packet_raw).events.filter(q=>q.kind==='round_ci_observation'&&q.payload.applicability&&q.payload.native_runs?.length).map(q=>q.payload.tip))];
        for(const tip of tips)needed.add(tip);
        if(tips.length)entries[i]={...entries[i],execution_snapshot_tips:tips};
      }
      for(const tip of needed){
        try{
          if(!sha(tip))refuse('NATURAL_EXECUTION_SOURCE_TIP_UNKNOWN');
          if(Object.keys(executionSnapshots).length>=1000)refuse('NATURAL_EXECUTION_SOURCE_SNAPSHOT_BOUND');
          let snapshot=tip===selection.head_sha?selection.current_execution_snapshot:null;
          if(!snapshot){const saved=materializeExecutionSnapshot(object(authenticatedExecutionSnapshots)?authenticatedExecutionSnapshots[tip]:null,authenticatedExecutionConfigurations);
            if(saved?.source_checkout_sha===tip&&executionSnapshotValid(saved,templates))snapshot=saved;}
          if(!snapshot)for(const saved of legacySnapshots.get(tip)??[]){if(saved?.source_checkout_sha===tip&&executionSnapshotValid(saved,templates)){snapshot=saved;break;}}
          if(snapshot){
            if(snapshot.source_checkout_sha!==tip||!executionSnapshotValid(snapshot,templates))refuse('NATURAL_EXECUTION_SOURCE_SNAPSHOT_INVALID');
            if(snapshot.main_history.head_commit!==selection.head_sha){
              const history=await body(request,`/repos/${repository}/compare/${snapshot.main_history.head_commit}...${selection.head_sha}`);
              if(!['ahead','identical'].includes(history?.status)||history.merge_base_commit?.sha!==snapshot.main_history.head_commit)refuse('NATURAL_EXECUTION_SOURCE_MAIN_HISTORY_UNPROVEN');
              snapshot={...snapshot,main_history:{base_commit:tip,head_commit:selection.head_sha,merge_base_commit:tip,status:tip===selection.head_sha?'identical':'ahead'}};
            }
          }else{
            const profiles=await source(request,repository,'scripts/ci/clued-gated-proof-profiles.json',tip),roles=await source(request,repository,'scripts/ci/clued-gated-proof-role-specs.json',tip);
            if(!templates.some(t=>profiles.sha256===t.profiles_sha256&&roles.sha256===t.role_specs_sha256))refuse('NATURAL_EXECUTION_SOURCE_BYTES_NOT_REVIEWED');
            const history=await body(request,`/repos/${repository}/compare/${tip}...${selection.head_sha}`);
            if(!['ahead','identical'].includes(history?.status)||history.merge_base_commit?.sha!==tip)refuse('NATURAL_EXECUTION_SOURCE_MAIN_HISTORY_UNPROVEN');
            const tree=await body(request,`/repos/${repository}/git/trees/${tip}?recursive=1`);
            if(tree.truncated!==false||!Array.isArray(tree.tree)||new Set(tree.tree.map(x=>x.path)).size!==tree.tree.length)refuse('NATURAL_EXECUTION_SOURCE_DIRECTORY_INCOMPLETE');
            for(const [path,value]of [['scripts/ci/clued-gated-proof-profiles.json',profiles],['scripts/ci/clued-gated-proof-role-specs.json',roles]]){
              const row=tree.tree.find(x=>x.path===path);
              if(row?.type!=='blob'||row.mode!=='100644'||row.sha!==value.blob)refuse('NATURAL_EXECUTION_SOURCE_TREE_BYTES_MISMATCH');
            }
            snapshot={source_checkout_sha:tip,proof_profiles_raw:profiles.text,role_specs_raw:roles.text,
              workflow_directory:tree.tree.filter(x=>x.path.startsWith('.github/workflows/')&&x.type==='blob').map(({path,sha,type,mode})=>({path,sha,type,mode})),
              main_history:{base_commit:tip,head_commit:selection.head_sha,merge_base_commit:history.merge_base_commit.sha,status:history.status}};
            if(!executionSnapshotValid(snapshot,templates))refuse('NATURAL_EXECUTION_SOURCE_SNAPSHOT_INVALID');
          }
          const configuration_key=digest(snapshot.proof_profiles_raw)+':'+digest(snapshot.role_specs_raw);
          if(!Object.hasOwn(executionConfigurations,configuration_key))executionConfigurations[configuration_key]={proof_profiles_raw:snapshot.proof_profiles_raw,role_specs_raw:snapshot.role_specs_raw};
          executionSnapshots[tip]={source_checkout_sha:tip,configuration_key,workflow_directory:snapshot.workflow_directory,main_history:snapshot.main_history};
        }catch(error){const reason=code(error);gaps.push({code:reason,source_checkout_sha:tip});if(reason==='NATURAL_SHARED_REQUEST_STOPPED')break;}
      }
    }
    for(const entry of entries)for(const event of JSON.parse(entry.packet_raw).events){const check=event.kind==='app_check'?event.payload.check_run_id:null;
      if(check&&!checks[check]){const q=await body(request,`/repos/${repository}/check-runs/${check}`);
        checks[check]={id:q.id,app:{id:q.app?.id},name:q.name,head_sha:q.head_sha,status:q.status,conclusion:q.conclusion,external_id:q.external_id};}}
  }catch(e){gaps.push({code:code(e)});}
  return {schema:NATURAL_CACHE_SCHEMA,status:gaps.length?'PARTIAL':'NATIVE_ORIGIN_BOUND',entries,gaps,
    source_bytes:sourceBytes,app_checks:checks,artifact_population:{before,after},non_execution_proofs:nonExecutionProofs,
    ...(selection?.execution_source_templates!==undefined?{execution_snapshots:executionSnapshots,execution_configurations:executionConfigurations}:{}),source_authenticated:false,official_metric:false,t0:null,
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
