// Concrete data-stage assembly from independently collected Native packets and
// verified original-job natural artifacts. No JSON authentication flag and no
// inference of cancellation causes or completed updates from an accepted 202.
import {createHash} from 'node:crypto';
import {MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL as P,MERGE_ADMISSION_FOUR_SOURCE_PROTOCOL_V2 as P2,readMergeAdmissionFourSources,updateOperationObservation,admissionDisplayNames} from './merge-admission-four-sources.mjs';
import {admissionEnvelopeInput,naturalRoundId} from './merge-admission-source-producer.mjs';
import {mapNaturalSourceEvents} from './merge-admission-natural-intake.mjs';
import {timestampMicros} from './merge-admission-measurement-history.mjs';
import {registeredWorkflowSource,parseWorkflowProfiles} from './clued-workflow-profile.mjs';
import {createCatalogueSourceReader} from './clued-source-only-workflow.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const key=r=>r.run_id+':'+(r.attempt??r.run_attempt);
const target=r=>key(r)+':'+r.pr_number+':'+r.head_sha;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
export {naturalRoundId};
const names=['attempts','targets','admission_batches','admissions','operations','head_moves','rounds','cancellations'];
const sourceIds={attempts:'native_attempts',targets:'admission_targets',admission_batches:'admission_selection_journal',admissions:'final_admission_journal',
  operations:'operation_journal_all_origins',head_moves:'native_head_move_journal',rounds:'final_round_journal',cancellations:'native_cancel_evidence'};
const fields=n=>r=>['attempts','admission_batches','cancellations'].includes(n)?key(r):n==='targets'?target(r):n==='admissions'?r.target_key:
  n==='operations'?r.operation_id:n==='head_moves'?r.move_id:r.round_id;
// d0fc deliberately keeps Native decimal IDs as strings. This adapter's Full
// grammar uses safe integers; a nonrepresentable ID is a real gap, never a
// lossy truncation, a dropped job, or relaxed global identity validation.
export function projectNativeJobForFull(job){
  const s=String(job.id);if(!/^[1-9][0-9]{0,19}$/.test(s))throw Error('NATIVE_FULL_JOB_ID_INVALID');
  const id=Number(s);if(!Number.isSafeInteger(id)||id<1||String(id)!==s)throw Error('NATIVE_FULL_JOB_ID_NOT_LOSSLESS');
  return {...job,id};
}
function manifest(p,source_id,members){
  const snapshot=hash(JSON.stringify(members)),b={snapshot_id:snapshot,total:members.length,member_digest:snapshot,first_member:members[0]??null,last_member:members.at(-1)??null};
  const pages=[];for(let i=0;i<Math.max(1,members.length);i+=1000)pages.push({page:pages.length+1,cursor:i===0?null:'page.'+i,
    next_cursor:i+1000<members.length?'page.'+(i+1000):null,members:members.slice(i,i+1000)});
  return {reader_source:p.schema===P2.schema?P2.reader_source:P.reader_source,source_id,scope:p.scope,cohort:P.population_cohort,window:p.window,retention_start:p.collection.retention_start,
    watermark:p.collection.watermark,collected_at:p.collection.closed_at,before:{...b,read_id:'opening.'+source_id.slice(0,70)},
    after:{...b,read_id:'closing.'+source_id.slice(0,70)},pages};
}
// A reviewed, protected-main finite-epoch policy is an independent source
// selection. Its Owner receipt is a publication pointer, not an authentication
// boolean. Actual acceptance/installation of that policy remains an Owner gate.
const quarantinedProviderIds=activity=>new Set([...(activity?.quarantined_ids??[]),...(activity?.quarantine??[]).map(q=>q.id)].map(String));
// A retained sealed frame is an older observation. A subsequent contradiction
// also revokes that older main-move claim, without discarding independent rows.
export function excludeQuarantinedMainMoves(frame,activity){
  if(!frame)return frame;
  const ids=quarantinedProviderIds(activity);if(!ids.size)return frame;
  const packet=JSON.parse(frame.packet_raw);let changed=false;
  for(const round of packet.rounds??[])if(round.main_move&&ids.has(String(round.main_move.observation_id))){
    round.main_move=null;
    if(round.termination?.kind==='MAIN_ADVANCED_REPLACED')round.termination={...round.termination,kind:'UNKNOWN',reason_code:'UNKNOWN_TERMINATION'};
    changed=true;
  }
  return changed?{...frame,packet_raw:JSON.stringify(packet)}:frame;
}
export function assembleNaturalFourSourceFrame({native,attemptRows,natural,runtime,closedAt,appChecks={},providerEvents=[],providerActivity=null,sourceBytes={}}){
  const gaps=[],activityDependentUnknown=[];let packet=null,expected=null;
  const quarantinedIds=quarantinedProviderIds(providerActivity);
  const activityCoverage={status:providerActivity?.status??'NOT_COLLECTED',reason_code:providerActivity?.reason_code??'NATIVE_ACTIVITY_CLOSING_DELIVERY_NOT_ESTABLISHED',
    delivery_through_window_end:providerActivity?.delivery_through_window_end??'UNKNOWN',closing_delivery_watermark:null,
    observed_pagination_status:providerActivity?.observed_pagination_status??'NOT_COLLECTED',provider_retention:providerActivity?.provider_retention??null,
    quarantined_ids:[...quarantinedIds].sort(),quarantine:providerActivity?.quarantine??[]};
  try{
    const c=JSON.parse(runtime.source_contract_raw);expected=JSON.parse(c.four_expected_sources_raw);
    const policy=runtime.operation_coverage;
    const v2=expected.schema===P2.expectations_schema;
    if(native.status!=='COMPLETE'||!natural||(!v2&&natural.status!=='NATIVE_ORIGIN_BOUND'))throw Error('ORIGINAL_NATIVE_OR_NATURAL_POPULATION_INCOMPLETE');
    if(v2&&natural.status!=='NATIVE_ORIGIN_BOUND')gaps.push('ORIGINAL_NATURAL_POPULATION_INCOMPLETE');
    for(const gap of v2?natural.gaps??[]:[])gaps.push(gap.code??'NATURAL_SOURCE_GAP');
    if(!policy||policy.schema!=='clued.r9-finite-recorded-operation-coverage/1'||!uuid(policy.owner_receipt_id)||
      policy.epoch_id!==runtime.forward_epoch?.epoch_id||policy.repository!==c.repository||
      policy.scope?.project_id!==c.scope.project_id||policy.scope?.queue_ref!==c.scope.queue_ref||
      policy.mode!=='explicit_recorded_origins_during_this_epoch'||!Array.isArray(policy.original_source_paths))throw Error('FINITE_OWNER_OPERATION_COVERAGE_NOT_ESTABLISHED');
    const originRows=natural.entries.flatMap(entry=>JSON.parse(entry.packet_raw).events.map(event=>({entry,event}))),nativeMap=new Map(native.population_packets.map(n=>[key(n.run),n]));
    if(originRows.some(x=>x.event.kind==='operation_request'&&!policy.original_source_paths.includes(x.event.source.path)))throw Error('RECORDED_OPERATION_ORIGIN_OUTSIDE_FINITE_POLICY');
    const min=[c.window.start,...native.population_packets.map(n=>n.run.created_at)].sort((a,b)=>timestampMicros(a)<timestampMicros(b)?-1:1)[0];
    packet={schema:v2?P2.schema:P.schema,repository:c.repository,scope:c.scope,window:c.window,
      collection:{watermark:hash(JSON.stringify({native:native.population.cohort_digest,origins:natural.entries.map(x=>x.artifact_digest)})),closed_at:closedAt,window_status:'closed',retention_start:min},
      populations:{},sources_raw:null,proof_profiles_raw:runtime.proof_profiles_raw,role_specs_raw:runtime.role_specs_raw,
      execution_sources:{source_checkout_sha:expected.execution_source.source_checkout_sha,entries:[],manifest:null},
      ...(v2?{previous_execution_snapshots:[],execution_configurations:{}}:{} )};
    for(const n of names)packet[n]=[];packet.attempts=attemptRows.map(r=>({...r}));
    const registry=parseWorkflowProfiles(runtime.proof_profiles_raw),roles=JSON.parse(runtime.role_specs_raw);
    const readCatalogueSource=createCatalogueSourceReader({registry,roleSpecs:roles});
    for(const path of Object.keys(registry.workflows)){
      const wf=runtime.execution_workflow_blobs[path];if(!readCatalogueSource({file:path,blob:wf}).source_identified)throw Error('CURRENT_EXECUTION_SOURCE_NOT_REGISTERED');
      packet.execution_sources.entries.push({workflow_file:path,workflow_blob:wf});
    }
    const executionVersions=new Map([[expected.execution_source.source_checkout_sha,{descriptor:expected.execution_source,registry,roles,blobs:runtime.execution_workflow_blobs}]]);
    const historicalSource=tip=>{
      if(executionVersions.has(tip))return executionVersions.get(tip);
      let snapshot=natural.execution_snapshots?.[tip];
      if(snapshot&&Object.hasOwn(snapshot,'configuration_key')){
        if(Object.keys(snapshot).sort().join('|')!==['source_checkout_sha','configuration_key','workflow_directory','main_history'].sort().join('|'))return null;
        const cfg=natural.execution_configurations?.[snapshot.configuration_key];
        if(!cfg||Object.keys(cfg).sort().join('|')!==['proof_profiles_raw','role_specs_raw'].sort().join('|')||typeof cfg.proof_profiles_raw!=='string'||typeof cfg.role_specs_raw!=='string'||
          snapshot.configuration_key!==hash(cfg.proof_profiles_raw)+':'+hash(cfg.role_specs_raw))return null;
        const {configuration_key,...rest}=snapshot;snapshot={...rest,...cfg};
      }
      if(!snapshot||Object.keys(snapshot).sort().join('|')!==['source_checkout_sha','proof_profiles_raw','role_specs_raw','workflow_directory','main_history'].sort().join('|')||
        snapshot.source_checkout_sha!==tip||Object.keys(snapshot.main_history??{}).sort().join('|')!==['base_commit','head_commit','merge_base_commit','status'].sort().join('|')||
        snapshot.main_history?.base_commit!==tip||snapshot.main_history?.merge_base_commit!==tip||
        snapshot.main_history?.head_commit!==expected.execution_source.source_checkout_sha||snapshot.main_history?.status!==(tip===expected.execution_source.source_checkout_sha?'identical':'ahead')||
        typeof snapshot.proof_profiles_raw!=='string'||typeof snapshot.role_specs_raw!=='string'||!Array.isArray(snapshot.workflow_directory)||snapshot.workflow_directory.length>1000||
        snapshot.workflow_directory.some(row=>!row||
          Object.keys(row).sort().join('|')!==['path','sha','type','mode'].sort().join('|')||typeof row.path!=='string'||!row.path.startsWith('.github/workflows/')||
          row.type!=='blob'||row.mode!=='100644'||!sha(row.sha))||new Set(snapshot.workflow_directory.map(row=>row.path)).size!==snapshot.workflow_directory.length)return null;
      const template=[expected.execution_source,...expected.previous_execution_sources].find(s=>s.profiles_sha256===hash(snapshot.proof_profiles_raw)&&s.role_specs_sha256===hash(snapshot.role_specs_raw));
      if(!template)return null;
      const declared=expected.previous_execution_sources.find(s=>s.source_checkout_sha===tip);
      if(declared&&(declared.profiles_sha256!==template.profiles_sha256||declared.role_specs_sha256!==template.role_specs_sha256))return null;
      if(packet.previous_execution_snapshots.length>=1000)return null;
      const descriptor={...template,source_checkout_sha:tip},historicalRegistry=parseWorkflowProfiles(snapshot.proof_profiles_raw),historicalRoles=JSON.parse(snapshot.role_specs_raw),
        blobs=Object.fromEntries((snapshot.workflow_directory??[]).map(r=>[r.path,r.sha])),entries=[],
        readHistoricalCatalogueSource=createCatalogueSourceReader({registry:historicalRegistry,roleSpecs:historicalRoles});
      for(const path of Object.keys(historicalRegistry.workflows)){
        const wf=blobs[path];if(!readHistoricalCatalogueSource({file:path,blob:wf}).source_identified)return null;entries.push({workflow_file:path,workflow_blob:wf});
      }
      const configuration_key=template.profiles_sha256+':'+template.role_specs_sha256,currentKey=expected.execution_source.profiles_sha256+':'+expected.execution_source.role_specs_sha256;
      if(configuration_key!==currentKey&&!Object.hasOwn(packet.execution_configurations,configuration_key))packet.execution_configurations[configuration_key]={proof_profiles_raw:snapshot.proof_profiles_raw,role_specs_raw:snapshot.role_specs_raw};
      packet.previous_execution_snapshots.push({source_checkout_sha:tip,configuration_key,main_history:snapshot.main_history,
        execution_sources:{source_checkout_sha:tip,entries,manifest:manifest(packet,'native_execution_workflow_sources:'+tip,entries.map(x=>x.workflow_file+':'+x.workflow_blob))}});
      const version={descriptor,registry:historicalRegistry,roles:historicalRoles,blobs};executionVersions.set(tip,version);return version;
    };
    const sourceDescriptors=new Map(expected.admission_sources.map(s=>[s.source_checkout_sha,s])),sourcePackets=Object.entries(sourceBytes).filter(([sha])=>sourceDescriptors.has(sha)).map(([sha,s])=>({source_checkout_sha:sha,sources_raw:JSON.stringify(s.texts)}));
    for(const entry of natural.entries){
      const n=nativeMap.get(entry.run_key),a=packet.attempts.find(a=>key(a)===entry.run_key);if(!n||!a)throw Error('ORIGIN_NATIVE_ATTEMPT_MISSING');
      if(a.kind!=='admission')continue;
      const events=JSON.parse(entry.packet_raw).events.filter(e=>e.source.path==='scripts/ci/clued-work-admission.mjs'),
        selected=events.filter(e=>e.kind==='admission_selected'||e.kind==='batch_selection'),initial=events.find(e=>e.kind==='batch_initial'||e.kind==='admission_input');
      if(!initial)throw Error('ADMISSION_INITIAL_SELECTION_WITNESS_MISSING');
      const finals=events.filter(e=>e.kind==='admission_final'),entryName=initial.payload.entry;
      if(!['required','reverify','rejudge'].includes(entryName))throw Error('ADMISSION_ENTRY_NOT_PER_PR');
      const candidates=new Map();for(const s of selected){if(!s.payload.pr_number||!s.payload.head_sha)throw Error('SELECTION_IDENTITY_UNKNOWN');
        const k=entry.run_key+':'+s.payload.pr_number+':'+s.payload.head_sha;if(!candidates.has(k))candidates.set(k,s);}
      // A cancelled/failed evaluator may have no final. The input is an actual
      // observed subject, not permission to invent a successful evaluation.
      if(!candidates.size&&entryName==='required'&&initial.payload.pr_number&&initial.payload.head_sha)candidates.set(entry.run_key+':'+initial.payload.pr_number+':'+initial.payload.head_sha,initial);
      if(entryName==='required'&&candidates.size!==1)throw Error('REQUIRED_EVER_TARGET_AMBIGUOUS');
      const keys=[...candidates.keys()],selection_events=keys.map((k,i)=>({seq:i+1,receipt_id:candidates.get(k).record_id,event_at:candidates.get(k).event_at,
        collected_at:closedAt,kind:'selected',target_key:k}));
      packet.admission_batches.push({run_id:a.run_id,attempt:a.attempt,entry:entryName,scope:c.scope,
        initial:{receipt_id:initial.record_id,event_at:initial.event_at,collected_at:closedAt,target_keys:[]},selection_events,
        closing:{receipt_id:'native.closed.'+entry.run_key,event_at:closedAt,collected_at:closedAt,status:n.run.conclusion==='cancelled'?'cancelled':n.run.conclusion==='success'?'completed':'failed',target_keys:keys},ever_target_keys:keys});
      const sources=sourceBytes[entry.checkout_sha];if(!sources)throw Error('ACTUAL_ADMISSION_SOURCE_BYTES_MISSING');
      if(!sourceDescriptors.has(entry.checkout_sha)){const template=expected.admission_sources.find(s=>s.script_blob===sources.script_blob&&s.workflow_blob===sources.workflow_blob&&s.reverify_workflow_blob===sources.reverify_workflow_blob&&s.policy_blob===sources.policy_blob);
        if(!template)throw Error('ADMISSION_ACTUAL_CHECKOUT_NOT_REVIEWED');const s={...template,source_checkout_sha:entry.checkout_sha};expected.admission_sources.push(s);sourceDescriptors.set(entry.checkout_sha,s);}
      if(!sourcePackets.some(s=>s.source_checkout_sha===entry.checkout_sha))sourcePackets.push({source_checkout_sha:entry.checkout_sha,sources_raw:JSON.stringify(sources.texts)});
      for(const [k,s] of candidates){
        const f=finals.find(f=>f.payload.evaluation_id===s.payload.evaluation_id),pr=s.payload;
        packet.targets.push({run_id:a.run_id,attempt:a.attempt,pr_number:pr.pr_number,head_sha:pr.head_sha,entry:entryName,scope:c.scope,selected_at:s.event_at});
        const displayNames=admissionDisplayNames(sources.texts),
          job=n.jobs.find(j=>j.name===(entryName==='required'?displayNames.job_name:'clued-work-admission-reverify')),
          appEvent=events.find(e=>e.kind==='app_check'&&e.payload.pr_number===pr.pr_number&&e.payload.head_sha===pr.head_sha&&e.payload.app_check_name===displayNames.app_check_name),
          step=job?.steps.find(x=>x.name==='Verify the work claim with Clued and summarize applicable workflows');
        const nativeIdentity={repository:c.repository,pr_number:pr.pr_number,head_sha:pr.head_sha,run_id:a.run_id,run_attempt:a.attempt,
          native_pr:{number:pr.pr_number,head_sha:pr.head_sha,base_repository:pr.base_repository,base_ref:pr.base_ref,default_branch:sourceDescriptors.get(entry.checkout_sha).default_branch,state:pr.state,draft:pr.draft},
          native_run:{id:a.run_id,run_attempt:a.attempt,event:n.run.event,path:n.run.path.split('@')[0],head_sha:n.run.head_sha,head_branch:entry.native_origin.head_branch,
            pull_requests:n.run.pull_requests,status:n.run.status,conclusion:n.run.conclusion,run_started_at:n.run.run_started_at},native_job:job};
        const gapFinal=f??{...s,kind:'admission_final',payload:{entry:entryName,evaluation_id:s.payload.evaluation_id,head_sha:pr.head_sha,pr_ref:null,final_decision_observed:false}};
        // App event posting is a different original process. Correlate its
        // actual Native id/head/PR/run, never an invented evaluation UUID.
        const adjusted=appEvent?{...appEvent,payload:{...appEvent.payload,admit_step_outcome:step?.conclusion??null}}:null;
        const result=admissionEnvelopeInput({finalEvent:gapFinal,inputEvent:{...s,kind:'admission_input'},
          claimEvent:events.find(e=>e.kind==='claim_verification'&&e.payload.evaluation_id===gapFinal.payload.evaluation_id),appEvent:adjusted,
          selectionEvent:events.find(e=>e.kind==='batch_selection'&&e.payload.evaluation_id===gapFinal.payload.evaluation_id),nativeIdentity,
          appNativeObservation:appEvent?appChecks[appEvent.payload.check_run_id]:null,sourceCheckoutSha:entry.checkout_sha,observedAt:closedAt});
        if(result.status!=='ENVELOPE_INPUT_CANDIDATE')throw Error('ADMISSION_NATIVE_FINAL_OR_GAP_UNBOUND');packet.admissions.push({target_key:k,packet_raw:result.packet_raw,collected_at:closedAt});
      }
    }
    packet.sources_raw=JSON.stringify(sourcePackets);
    for(const a of packet.attempts)if(a.kind==='admission'&&!packet.admission_batches.some(b=>key(b)===key(a)))gaps.push('ADMISSION_NATIVE_ORIGIN_MISSING:'+key(a));
    const mapped=natural.entries.flatMap(entry=>mapNaturalSourceEvents(entry,{scope:c.scope,collected_at:closedAt}).operations);
    for(const m of mapped){if(m.status!=='OPERATION_INPUT_CANDIDATE')throw Error('RECORDED_OPERATION_INPUT_UNBOUND');
      const o=updateOperationObservation(m.before_raw,m.response_raw,m.after_raw,JSON.stringify(expected));if(o.status!=='UPDATE_OPERATION_PACKET_CANDIDATE')throw Error('RECORDED_OPERATION_NATIVE_POST_INVALID');
      if(packet.operations.some(x=>x.operation_id===o.operation.operation_id))throw Error('OPERATION_UUID_DUPLICATE');packet.operations.push(o.operation);
      if(o.operation.confirmation!==null){const q=o.operation;
        if(!packet.head_moves.some(x=>x.pr_number===q.pr_number&&x.old_head_sha===q.old_head_sha&&x.new_head_sha===q.confirmation.new_head_sha))packet.head_moves.push({move_id:q.operation_id,pr_number:q.pr_number,old_head_sha:q.old_head_sha,new_head_sha:q.confirmation.new_head_sha,
          event_at:q.confirmation.event_at,collected_at:closedAt,operation_id:q.operation_id,observation_id:q.confirmation.post_observation_id});}
    }
    const observedRounds=originRows.filter(x=>x.event.kind==='round_ci_observation'&&x.event.payload.applicability&&x.event.payload.native_runs.length),roundSets=new Set();
    for(const {event}of observedRounds){const q=event.payload,runKeys=q.native_runs.map(r=>r.run_id+':'+r.attempt).sort(),rid=naturalRoundId(runKeys);if(roundSets.has(rid))continue;roundSets.add(rid);
      // Source comes from the actual protected tip's immutable snapshot, never
      // from a workflow list chosen to make applicability pass. /1 is unchanged.
      const executionVersion=v2?historicalSource(q.tip):executionVersions.get(expected.execution_source.source_checkout_sha);
      if(!executionVersion)gaps.push('ROUND_EXECUTION_SOURCE_SNAPSHOT_MISSING:'+rid);
      const packets=runKeys.map(k=>nativeMap.get(k));if(packets.some(n=>!n))throw Error('ROUND_REFERENCE_NATIVE_ATTEMPT_MISSING');
      const starts=packets.map(n=>n.run.run_started_at).filter(Boolean),bounds=runKeys.map(k=>packet.attempts.find(a=>key(a)===k)?.terminal_interval);
      const timesComplete=starts.length&&bounds.every(Boolean);
      if(!timesComplete){gaps.push('ROUND_NATIVE_TIME_OR_INTERVAL_MISSING:'+rid);if(!v2)continue;}
      const round={round_id:rid,scope:c.scope,pr_number:q.pr_number,head_sha:q.head_sha,main_sha:q.tip,started_at:starts.length?starts.sort((a,b)=>timestampMicros(a)<timestampMicros(b)?-1:1)[0]:null,completed_at:null,
        terminal_interval:timesComplete?{lower_at:bounds.map(b=>b.lower_at).sort().at(-1),upper_at:bounds.map(b=>b.upper_at).sort().at(-1),basis:'native_job_completion_lower_and_terminal_update_upper_bounds'}:null,run_keys:runKeys,execution_packets:[],
        applicability:{changed_files:q.applicability.changed_files,diff_complete:true,commit_count:q.applicability.commits,workflow_files:q.applicability.workflow_files,
          profile_sha256:executionVersion?.descriptor.profiles_sha256??null,source_checkout_sha:v2?q.tip:expected.execution_source.source_checkout_sha},termination:null,main_move:null,merge_proof:null};
      for(const n of packets){const file=n.run.path.split('@')[0],wf=executionVersion?.blobs[file],selected=executionVersion?registeredWorkflowSource(executionVersion.registry,file,wf):{passed:false};
        if(!selected.passed){if(!v2)throw Error('ROUND_SOURCE_NOT_REGISTERED');gaps.push('ROUND_SOURCE_OR_FUTURE_INSTALLATION_NOT_PROVEN:'+rid+':'+file);}
        const barrier={run_id:n.run.run_id,attempt:n.run.run_attempt,head_sha:n.run.head_sha,status:n.run.status,conclusion:n.run.conclusion};
        const jobs=n.jobs.map(projectNativeJobForFull);
        round.execution_packets.push({run_key:key(n.run),workflow_file:file,jobs,jobs_manifest:manifest(packet,'native_jobs:'+key(n.run),jobs.map(j=>String(j.id))),before_attempt:barrier,after_attempt:{...barrier},
          source_descriptor:{workflow_blob:wf??null,workflow_source_sha256:selected.profile?.source_sha256??null,
            source_checkout_sha:v2?q.tip:expected.execution_source.source_checkout_sha,role:'primary_execution',role_source_sha256:executionVersion?.descriptor.role_specs_sha256??null}});
      }packet.rounds.push(round);
    }
    const represented=new Set(packet.rounds.flatMap(r=>r.run_keys));for(const a of packet.attempts)if(a.kind==='ci'&&a.pr_number!==null&&!represented.has(key(a)))gaps.push('UNOBSERVED_CI_ROUND_POPULATION:'+key(a));
    // The actual cancel population is Native. No Source request is converted
    // into a known cause; even explicit holder cancel stays UNKNOWN here.
    for(const a of packet.attempts.filter(a=>a.status==='completed'&&a.conclusion==='cancelled'))packet.cancellations.push({run_id:a.run_id,attempt:a.attempt,basis:'unknown',reason_code:null,event_at:null,collected_at:closedAt,request_id:null,provider_receipt_id:null});
    // Each executed update carries its real post. Any missing response/post is
    // retained as an intent. No later head or mere commit relationship is used.
    for(const r of packet.rounds){const merged=originRows.find(x=>x.event.kind==='operation_response'&&x.event.payload.action==='merge_pull_request'&&x.event.payload.merged===true&&
      originRows.some(y=>y.event.kind==='operation_request'&&y.event.payload.operation_id===x.event.payload.operation_id&&y.event.payload.expected_head_sha===r.head_sha&&y.event.payload.original_round_id===r.round_id));
      if(merged){const request=originRows.find(x=>x.event.kind==='operation_request'&&x.event.payload.operation_id===merged.event.payload.operation_id).event;
        const post=originRows.find(x=>x.event.kind==='merge_native_post'&&x.event.payload.operation_id===request.payload.operation_id)?.event;
        if(post)r.merge_proof={receipt_id:post.record_id,event_at:post.payload.native_pr.merged_at,collected_at:closedAt,round_id:r.round_id,used_run_keys:request.payload.run_keys,operation_id:request.payload.operation_id,
          expected_head_sha:r.head_sha,response_merged_commit_sha:merged.event.payload.response_sha,native_pr:post.payload.native_pr};}
      const t=originRows.find(x=>x.event.kind==='round_termination'&&(x.event.payload.round_id===r.round_id||x.event.payload.round_id===null&&x.event.payload.head_sha===r.head_sha&&
        x.event.payload.pr_number===r.pr_number&&timestampMicros(x.event.event_at)>=timestampMicros(r.terminal_interval.upper_at)&&
        !packet.rounds.some(other=>other.round_id!==r.round_id&&other.pr_number===r.pr_number&&other.head_sha===r.head_sha&&
          timestampMicros(other.started_at)>timestampMicros(r.started_at)&&timestampMicros(other.started_at)<=timestampMicros(x.event.event_at))))?.event;if(!t)continue;
      const o=packet.operations.find(o=>o.operation_id===t.payload.operation_id),replacement=o&&packet.rounds.find(next=>next.pr_number===r.pr_number&&next.head_sha===o.confirmation?.new_head_sha),
        main=providerEvents.find(e=>!quarantinedIds.has(String(e.id))&&e.type==='PushEvent'&&e.payload?.ref==='refs/heads/'+qDefault(runtime)&&e.payload.before===r.main_sha&&e.payload.head===o?.main_sha);
      r.termination={receipt_id:t.record_id,event_at:t.event_at,collected_at:closedAt,kind:o&&replacement&&main?'MAIN_ADVANCED_REPLACED':'UNKNOWN',reason_code:o&&replacement&&main?'MAIN_ADVANCED_INVALIDATED_FINAL_ROUND':'UNKNOWN_TERMINATION',original_round_id:r.round_id,operation_id:o?.operation_id??null,replacement_round_id:replacement?.round_id??null};
      if(main)r.main_move={old_main_sha:main.payload.before,new_main_sha:main.payload.head,event_at:main.created_at,collected_at:closedAt,observation_id:String(main.id)};
      else if(o&&replacement&&activityCoverage.delivery_through_window_end==='UNKNOWN')activityDependentUnknown.push(r.round_id);
    }
    for(const n of names)packet.populations[n]=manifest(packet,sourceIds[n],packet[n].map(fields(n)));
    packet.execution_sources.manifest=manifest(packet,'native_execution_workflow_sources:'+expected.execution_source.source_checkout_sha,packet.execution_sources.entries.map(x=>x.workflow_file+':'+x.workflow_blob));
    const packetRaw=JSON.stringify(packet),expectedRaw=JSON.stringify(expected),math=readMergeAdmissionFourSources(packetRaw,expectedRaw);
    // An individually observed PushEvent is a fact even without a delivery
    // watermark. Missing activity evidence remains UNKNOWN only where it is
    // needed for this round's cause; independent facts are not discarded.
    if(math.metrics?.wasted_final_rounds){math.metrics.wasted_final_rounds.activity_coverage=activityCoverage;
      math.metrics.wasted_final_rounds.activity_dependent_unknown_rounds=activityDependentUnknown;}
    if(!math.candidate_ready)gaps.push(...(math.population_gaps??['GENERATED_FOUR_SOURCE_FRAME_INVALID']));
    return {status:gaps.length?'PARTIAL':'FOUR_SOURCE_FRAME_DATA_CANDIDATE',frame:gaps.length?null:{packet_raw:packetRaw,expected_sources_raw:expectedRaw},partial_packet_raw:packetRaw,gaps,math,activity_coverage:activityCoverage,
      source_authenticated:false,official_metric:false,t0:null};
  }catch(e){gaps.push(/^[A-Z0-9_:.-]+$/.test(e.message)?e.message:'NATURAL_FRAME_BUILD_FAILED');return {status:'PARTIAL',frame:null,gaps,partial_packet_raw:packet?JSON.stringify(packet):null,activity_coverage:activityCoverage,source_authenticated:false,official_metric:false,t0:null};}
}
const qDefault=runtime=>runtime.natural_selection.default_branch;
