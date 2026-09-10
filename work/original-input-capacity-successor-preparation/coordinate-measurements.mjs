// Root data coordination only. No SQL, signature, host effect, oracle or GA issuance.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import crypto from 'node:crypto';import readline from 'node:readline';import {spawnSync} from 'node:child_process';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
import {repo,controller,successor,moduleAt} from './dependencies.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),workspace=path.resolve(here,'../..'),r='scripts/phase2-qualification/control-context-verifier-runtime600/';
const need=(v,m)=>{if(!v)throw Error(m);};
const {readAdditionalComponents}=await import('./component-readback.mjs');
const {observeRequestDenials}=await moduleAt(successor+'request-denials.mjs');
const {envelopeFromPublication,validatePackedDenialSource,beginOriginalInputVerification}=await moduleAt(successor+'original-inputs-blob.mjs');
const {observePositiveFixtureAndStop,observeNoBroaderAuthorityAfterCleanup}=await moduleAt(r+'positive-terminal-observations.mjs');
const {observeActualPublicationDenial}=await import('./publication-observations.mjs');
const {revalidateHistoricalComponents}=await moduleAt(successor+'historical-component-observations.mjs');
const {collectActualWriteTargets}=await moduleAt(r+'write-targets.mjs');
const {checkGAShape,project,sql}=await moduleAt(successor+'context.mjs');
function safePath(p,base,mustExist){const f=path.resolve(p),rel=path.relative(base,f);need(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'FIXED_COORDINATION_DIRECTORY');for(let x=mustExist?f:path.dirname(f);;x=path.dirname(x)){need(!fs.lstatSync(x).isSymbolicLink(),'UNLINKED_COORDINATION_PATH');if(x===base)break;}return f;}
function read(p){const f=safePath(p,workspace,true),st=fs.statSync(f);need(st.isFile()&&st.size>0&&st.size<=16*1024*1024,'BOUNDED_REAL_INPUT_FILE');return JSON.parse(fs.readFileSync(f,'utf8'));}
function save(dir,name,value){const file=safePath(path.join(dir,name),here,false),raw=JSON.stringify(value,null,2)+'\n',fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}process.stdout.write(JSON.stringify({saved:name,bytes:Buffer.byteLength(raw),sha256:sha(raw),authority_effect:'NONE'})+'\n');}
function exactObservation(o,ga,phase){need(o?.project===project&&o.query_sha256===sha(sql)&&o.row?.execution,'ACTUAL_FIXED_TOOL_READBACK_REQUIRED');const a=o.row.execution.attempts?.filter(a=>a.ga_id===ga.gate_authorization_id);need(a?.length===1&&a[0].phase===phase,'EXACT_ORIGINAL_ATTEMPT_PHASE');return o.row.execution;}
function item(result){const value=JSON.parse(result.raw);need(typeof value.test_id==='string'&&sha(result.raw)===result.sha256,'ORIGINAL_OBSERVATION_BYTES');return {test_id:value.test_id,raw:result.raw,sha256:result.sha256};}
const [mode,inputPath,outputDirectory]=process.argv.slice(2);
need(['pending','publish','collect'].includes(mode)&&inputPath&&outputDirectory&&process.argv.length===5,'USAGE: coordinate-measurements.mjs pending|publish|collect INPUT.json_OR_STDIN_NOTICE EXISTING_NEW_RUN_DIRECTORY');
const dir=safePath(outputDirectory,here,true);need(fs.statSync(dir).isDirectory(),'EXISTING_COORDINATOR_RUN_DIRECTORY');
let actualInputPath=inputPath;
if(inputPath==='-'){
 process.stdout.write(JSON.stringify({state:'BLOB_MEASUREMENT_READY_FOR_ACTUAL_INPUT',mode})+'\n');
 const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
 const line=await new Promise((resolve,reject)=>{lines.once('line',resolve);lines.once('close',()=>reject(Error('NO_ACTUAL_INPUT')));});lines.close();
 need(line.length<=4096,'BOUNDED_FIXED_INPUT_PATH_NOTICE');const notice=JSON.parse(line);need(Object.keys(notice).join(',')==='input_file'&&typeof notice.input_file==='string','EXACT_INPUT_FILE_NOTICE');actualInputPath=notice.input_file;
}
const input=read(actualInputPath),material=read(input.material_file),gaRaw=material.ga_raw,ga=checkGAShape(gaRaw);
need(ga.controller_digest==='07e0be02895363bac5ced923924f27b8de1f7951d8eea2c829831afef9bb27aa','EXACT600_CONTROLLER');
if(mode==='pending'){
 need(!fs.existsSync(path.join(dir,'pending.json')),'PENDING_MEASUREMENT_ALREADY_PRESERVED_NO_AUTORETRY');
 const observation=read(input.observation_file),state=exactObservation(observation,ga,'PENDING');
 const measured=observeRequestDenials({gaRaw,observation,runtimeAcceptance:JSON.parse(material.runtime_acceptance.raw),qualification:JSON.parse(material.controller_qualification.raw)});
 need(Buffer.byteLength(measured.original_inputs_artifact.raw)<=3000000,'EXPLICIT_ORIGINAL_INPUT_V3_3000000_CANDIDATE_LIMIT');
 save(dir,'pending.json',{kind:'ACTUAL_PENDING_MEASUREMENT_COLLECTION',ga_sha256:sha(gaRaw),before_state:state,measured,authority_effect:'NONE'});
}else if(mode==='publish'){
 const pending=read(path.join(dir,'pending.json'));need(pending.ga_sha256===sha(gaRaw),'EXACT_PENDING_GA');exactObservation(read(input.observation_file),ga,'STOPPED');
 need(typeof input.expected_parent==='string'&&/^[a-f0-9]{40}$/.test(input.expected_parent),'ACTUAL_FIXED_AUX_HEAD_REQUIRED');
 for(const name of ['original-input-publication-request.json','original-input-publication-tool.json','original-input-publication.json','original-input-envelope.json'])need(!fs.existsSync(path.join(dir,name)),'ONCE_PUBLICATION_COORDINATION:'+name);
 const request={ga_raw:gaRaw,original_artifact:pending.measured.original_inputs_artifact,expected_parent:input.expected_parent};
 const requestRaw=JSON.stringify(request)+'\n';need(Buffer.byteLength(requestRaw)<=4194304,'EXPLICIT_PUBLISHER_FULL_JSON_FOUR_MIB_LIMIT');
 save(dir,'original-input-publication-request.json',request);
 const python='C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe',publisher=path.join(here,'publish-original-inputs.candidate.py');
 need(sha(fs.readFileSync(publisher))==='068bd22bff43bc35aea526480b578a5dd6b2884eae2f752af89544aeeeb582a7','EXACT_REVIEWED_EXTERNAL_PUBLICATION_COORDINATOR');
 const started_at=new Date().toISOString(),response=spawnSync(python,['-I','-S','-B','-X','utf8',publisher],{input:requestRaw,encoding:'utf8',windowsHide:true,maxBuffer:262144,timeout:240000});
 save(dir,'original-input-publication-tool.json',{started_at,ended_at:new Date().toISOString(),status:response.status,signal:response.signal,stdout:response.stdout,stderr:response.stderr,error:response.error?{name:response.error.name,message:response.error.message}:null,automatic_retry:false});
 need(response.status===0&&response.signal===null&&!response.error,'UNKNOWN_PUBLICATION_PROCESS_RETAIN_NO_RETRY');
 const result=JSON.parse(response.stdout);save(dir,'original-input-publication.json',result);
 need(result.status==='IMMUTABLE_REMOTE_BYTES_READ_BACK'&&result.remote_bytes_verified===true,'ACTUAL_IMMUTABLE_PUBLICATION_REQUIRED_NO_RETRY');
 const ref=result.reference,gaSuffix=ga.gate_authorization_id.slice(3),expectedPath='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/original-inputs-'+gaSuffix+'/result.json';
 need(ref.path===expectedPath&&ref.sha256===request.original_artifact.sha256&&ref.repository==='tdoljyj/cross-memory-system','EXACT_PUBLISHED_INPUT_IDENTITY');
 const envelope=envelopeFromPublication(request.original_artifact,{branch:'codex/phase2-qualification-evidence-20260908',commit_sha:ref.commit,ga_id:ga.gate_authorization_id,artifact_path:ref.path},{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+ref.git_blob_sha,sha256:ref.sha256});
 const session=beginOriginalInputVerification();for(const item of pending.measured.results)validatePackedDenialSource({packedRaw:envelope.raw,sourceRaw:item.raw,verificationSession:session});
 save(dir,'original-input-envelope.json',envelope);
}else{
 const {createWrap}=await import('./wrap-observations.mjs');const {wrap}=createWrap(material);
 const names=['stopped.json','publication.json','historical-five.json','additional-three.json','observation-input.json','wrapped.json'];for(const n of names)need(!fs.existsSync(path.join(dir,n)),'COLLECTION_ALREADY_STARTED_PRESERVE_PARTIAL_OUTPUT_NO_AUTORETRY:'+n);
 const pending=read(path.join(dir,'pending.json'));need(pending.ga_sha256===sha(gaRaw),'SAME_ORIGINAL_PENDING_MEASUREMENT');
 const observation=read(input.observation_file),state=exactObservation(observation,ga,'STOPPED');
 need(typeof input.receipt_id==='string'&&/^grr_[A-Za-z0-9_-]{1,128}$/.test(input.receipt_id),'ACTUALLY_SELECTED_ORIGINAL_RECEIPT_ID_REQUIRED');
 const positive=observePositiveFixtureAndStop({gaRaw,state}),cleanup=observeNoBroaderAuthorityAfterCleanup({gaRaw,beforeState:pending.before_state,afterState:state}),writes=collectActualWriteTargets({ga,state,receiptId:input.receipt_id});
 save(dir,'stopped.json',{ga_sha256:sha(gaRaw),positive,cleanup,actual_write_targets:writes,receipt_id:input.receipt_id,authority_effect:'NONE'});
 const publication=observeActualPublicationDenial({sourceRef:ga.source_ref,ownerMerge:ga.target_revision,controllerDigest:ga.controller_digest});save(dir,'publication.json',publication);
 const historical=revalidateHistoricalComponents({gaRaw,state,runtimeAcceptance:material.runtime_acceptance});save(dir,'historical-five.json',historical);
 const batch=read(path.join(here,'../qualification-live-preparation/ComponentBatchSources.json')),additional=readAdditionalComponents({...batch,ga_raw:gaRaw});need(Array.isArray(additional.results),'ACTUAL_ADDITIONAL_COMPONENT_COLLECTION');save(dir,'additional-three.json',additional);
 const source_observations=[...pending.measured.results.map(item),item(positive),item(cleanup),item(publication),...historical.results.map(item),...additional.results.map(item)];
 const envelope=read(path.join(dir,'original-input-envelope.json'));need(JSON.parse(envelope.raw).kind==='EXACT_ORIGINAL_VERIFIER_INPUTS_BLOB_V3_3000000','EXACT_NEW_BLOB_INPUT_ENVELOPE');
 const shared_artifacts=[envelope,...additional.shared_artifacts];
 const original={ga_raw:gaRaw,source_observations,shared_artifacts};save(dir,'observation-input.json',original);
 const wrapped=await wrap(original);save(dir,'wrapped.json',wrapped);
 process.stdout.write(JSON.stringify({state:wrapped.state,observation_count:source_observations.length,missing_cases:wrapped.missing_cases,actual_write_targets_file:'stopped.json',receipt_not_created:true,authority_effect:'NONE'})+'\n');
}
