// Trusted root tool coordination only; never authenticates JSON as new authority.
// No SQL/network/signing entry. The only executable effect is the exact frozen STOP bridge.
import {isDeepStrictEqual} from 'node:util';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../kernel-phase2-repo'),gaId=process.argv[3],folder=path.join(here,gaId+'.STOP.env-order-repair-pipe600','stop-evidence');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
const rootID='ctr_414bd3c724264a83894b0c55cf2ab878',controller='27ede0fc0ff6afc4d5abf2f5c9f256fe22776165746dddc19aa2693c47bbc97c';
const python='C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe';
const bridge=path.join(repo,'scripts/phase2-qualification/control-context-verifier-actual-env-order-repair-successor/bridge.py');
const env={SystemRoot:'C:/Windows',WINDIR:'C:/Windows',TEMP:'C:/Users/Windows/AppData/Local/Temp',TMP:'C:/Users/Windows/AppData/Local/Temp',HOMEDRIVE:'',HOMEPATH:'',LOGONSERVER:'',PATH:'',SYSTEMDRIVE:'',USERDOMAIN:'',USERNAME:'',USERPROFILE:''};
const mode=process.argv[2];need(process.argv.length===4&&/^ga_[a-f0-9]{32}$/.test(gaId)&&['prepare-stop','stop','prepare-stopped'].includes(mode),'Fixed mode only');
for(let p=folder;p!==here;p=path.dirname(p))if(fs.existsSync(p))need(!fs.lstatSync(p).isSymbolicLink(),'No linked actual GA archive path');
fs.mkdirSync(folder,{recursive:true});need(!fs.lstatSync(folder).isSymbolicLink(),'No linked evidence directory');
function read(name){const p=path.join(folder,name);need(fs.lstatSync(p).isFile()&&!fs.lstatSync(p).isSymbolicLink(),'Exact regular input file');const b=fs.readFileSync(p);need(b.length<=16777216,'Bounded original tool input');return JSON.parse(b);}
function persist(name,value){const raw=typeof value==='string'?value:JSON.stringify(value)+'\n',fd=fs.openSync(path.join(folder,name),'wx');try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return raw;}
function context(raw,observation,phase){
 need(typeof raw==='string'&&Buffer.byteLength(raw)<=65536,'Exact bounded original GA raw required');
 const ga=JSON.parse(raw),state=observation?.execution,at=Date.parse(observation?.observed_at),now=Date.now();need(ga.gate_authorization_id===gaId,'Exact selected actual GA directory');
 need(Number.isFinite(at)&&at<=now+1000&&now-at<=30000,'Fresh actual root SQL observation required');
 need(ga.controller_digest===controller&&ga.control_trust_root_generation==='ctrgen_2e778ca66244459f974b081edca8c04e'&&/^ga_[A-Za-z0-9_-]{1,128}$/.test(ga.gate_authorization_id??''),'Exact accepted GA subject required');
 need(state?.binding?.root_id===rootID&&state.binding.controller_sha256===controller&&state.current?.root_id===rootID&&state.current.active_ga_id===ga.gate_authorization_id,'Exact original active binding required');
 const attempts=state.attempts.filter(a=>a.ga_id===ga.gate_authorization_id);
 need(attempts.length===1&&attempts[0].root_id===rootID&&attempts[0].ga_raw===raw&&attempts[0].ga_sha256===sha(raw)&&attempts[0].phase===phase,'Exact original attempt/phase required');
 need(/^[a-f0-9]{64}$/.test(attempts[0].container_id??'')&&Number.isSafeInteger(state.current.sequence)&&state.current.sequence>=0,'Exact container and sequence required');
 return {ga,state,attempt:attempts[0],nonce:sha('clued-fixed-host-v1\0'+ga.gate_authorization_id).slice(0,32),ga_sha:sha(raw)};
}
function key(raw,operation){return 'clued_stop_'+sha('clued-root-fixed-stop-v1\0'+operation+'\0'+raw);}
function request(c,raw,operation,body){return {ga_id:c.ga.gate_authorization_id,idempotency_key:key(raw,operation),operation,expected_sequence:c.state.current.sequence,body};}
function verifySources(){
 const p=path.join(repo,'scripts/phase2-qualification/control-context-verifier-actual-env-order-repair-successor/ControllerSourceManifest.candidate.json'),raw=fs.readFileSync(p);
 need(sha(raw)===controller,'Exact ordinary 327-entry controller manifest required');const manifest=JSON.parse(raw);need(manifest.files.length===327,'Complete accepted source set required');
 for(const entry of manifest.files){const p=path.isAbsolute(entry.path)?entry.path:path.join(repo,entry.path),b=fs.readFileSync(p);need(b.length===entry.bytes&&sha(b)===entry.sha256,'Exact source/dependency drift: '+entry.path);}
 need(sha(fs.readFileSync(python))==='4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a'&&sha(fs.readFileSync(bridge))==='5601f4399289971188ccfcc6e0bc1439967eddbd53dfeaa7819274831dc7f58f','Exact fixed Python/STOP bridge required');
}
if(mode==='prepare-stop'){
 const input=read('prepare-stop-input.json'),c=context(input.ga_raw,input.observation,'RUNNING');
 persist('original-ga.raw',input.ga_raw);persist('original-running-observation.json',input.observation);
 const r=request(c,input.ga_raw,'STOP_SENT',{container_id:c.attempt.container_id});persist('stop-sent-request.json',r);
 console.log(JSON.stringify({state:'PREPARED_ORIGINAL_STOP_SENT_REQUEST',request:r,sql_executed:false,authority_effect:'NONE'}));
}else if(mode==='stop'){
 const input=read('stop-input.json'),raw=fs.readFileSync(path.join(folder,'original-ga.raw'),'utf8'),prepared=read('stop-sent-request.json'),t=input.transition;
 need(input.ga_raw===raw&&t?.status==='RECORDED'&&t.phase==='STOP_SENT'&&t.sequence===prepared.expected_sequence+1,'Actual newly committed STOP_SENT response required');
 const c=context(raw,{observed_at:t.current_context?.observed_at,execution:t.current_context},'STOP_SENT');
 need(t.sequence===c.state.current.sequence,'Exact current committed STOP sequence required');
 const events=c.state.events.filter(e=>e.sequence===t.sequence&&e.root_id===rootID);need(events.length===1&&isDeepStrictEqual(events[0].request,prepared),'Exact persisted original STOP_SENT event required');
 persist('original-stop-sent-readback.json',input);verifySources();
 const deadline=Date.parse(c.ga.deadline);need(Number.isFinite(deadline)&&deadline>Date.now(),'Existing frozen STOP deadline required');
 const bridgeInput={operation:'STOP',nonce:c.nonce,ga_raw:raw,ga_sha256:c.ga_sha,container_id:c.attempt.container_id};
 persist('stop-dispatch-once.json',{bridge_request:bridgeInput,started_at:new Date().toISOString(),authority_effect:'NONE'});
 let started=false;
 try{
  const remaining=deadline-Date.now();need(remaining>0,'Deadline elapsed after durable STOP intent');started=true;
  const output=execFileSync(python,['-I','-S','-B','-X','utf8',bridge],{input:JSON.stringify(bridgeInput)+'\n',encoding:'utf8',env,timeout:remaining,maxBuffer:262144,windowsHide:true});
  persist('stop-bridge-stdout.raw',output);const result=JSON.parse(output),s=result.observation?.State;
  need(result.state==='ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT'&&result.operation==='STOP'&&result.ga_sha256===c.ga_sha&&result.container_id===c.attempt.container_id&&result.observation.Id===c.attempt.container_id&&result.observation.Name==='/clued-synthetic-'+c.nonce,'Exact actual original STOP result required');
  need(s?.Running===false&&typeof s.Pid==='number'&&s.Pid===0&&s.Status==='exited'&&result.qualified===false&&result.capacity_released===false&&result.remote_result_persisted===false,'Actual stopped state required; no release implied');
  const resultRaw=persist('stop-result.json',result);console.log(JSON.stringify({state:'ACTUAL_STOP_OBSERVED_NOT_YET_REMOTE_RESULT',container_id:result.container_id,result_path:path.join(folder,'stop-result.json'),result_sha256:sha(resultRaw),original_bridge_stdout_sha256:sha(output),capacity_released:false,authority_effect:'NONE'}));
 }catch(error){
  persist('stop-unknown.json',{state:'UNKNOWN',started,reason:error.message,stdout:typeof error.stdout==='string'?error.stdout:null,stderr:typeof error.stderr==='string'?error.stderr:null,capacity_released:false,automatic_retry:false,authority_effect:'NONE'});
  console.log(JSON.stringify({state:'UNKNOWN',automatic_retry:false,capacity_released:false,authority_effect:'NONE'}));process.exitCode=2;
 }
}else{
 const input=read('prepare-stopped-input.json'),raw=fs.readFileSync(path.join(folder,'original-ga.raw'),'utf8');need(input.ga_raw===raw,'Original GA bytes required');
 const c=context(raw,input.observation,'STOP_SENT'),result=read('stop-result.json'),dispatch=read('original-stop-sent-readback.json');
 need(c.state.current.sequence===dispatch.transition.sequence&&result.container_id===c.attempt.container_id&&result.ga_sha256===c.ga_sha,'Exact unchanged original STOP attempt required');
 const evidence={ga_id:c.ga.gate_authorization_id,ga_sha256:c.ga_sha,operation:'STOPPED',container_id:c.attempt.container_id,observation:result.observation,
  started_utc:result.started_utc,ended_utc:result.ended_utc,original_bridge_stdout_sha256:sha(fs.readFileSync(path.join(folder,'stop-bridge-stdout.raw'))),authority_effect:'NONE'};
 const evidenceRaw=JSON.stringify(evidence)+'\n';persist('stopped-evidence.raw',evidenceRaw);
 const r=request(c,raw,'STOPPED',{container_id:c.attempt.container_id,observation_sha256:sha(JSON.stringify(result.observation)+'\n'),raw:evidenceRaw,sha256:sha(evidenceRaw)});
 need(Buffer.byteLength(JSON.stringify(r))<120000,'Complete STOPPED request bounded below original SQL 131072-byte limit');
 persist('stopped-request.json',r);console.log(JSON.stringify({state:'PREPARED_ORIGINAL_STOPPED_REQUEST',request:r,sql_executed:false,capacity_released:false,authority_effect:'NONE'}));
}
