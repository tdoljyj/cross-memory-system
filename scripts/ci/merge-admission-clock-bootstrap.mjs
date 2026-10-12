// Main-only CI qualification of the existing audit-only reader. This never
// accepts a Source or starts the official observation window.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const URL='https://clued.pixelgrav.com/v1/continuity/audit';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const credentialFingerprint=token=>crypto.createHash('sha256').update('clued.r9-minimum-credential-pin/1\0'+token).digest('hex');
async function boundedJson(response){
 const reader=response.body?.getReader();if(!reader)throw Error('RESPONSE_BODY_UNAVAILABLE');
 const chunks=[];let size=0;try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>512*1024){await reader.cancel();throw Error('RESPONSE_TOO_LARGE');}chunks.push(r.value);}}finally{reader.releaseLock();}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
export async function qualifyClockReader({env,config,fetchImpl=fetch}={}){
 const partial=reason=>({schema:'clued.r9-clock-bootstrap-observation/1',status:'NOT_QUALIFIED',reason_code:reason,source_authenticated:false,official_metric:false,t0:null});
 let stage='TRUSTED_CI_SOURCE_REQUIRED';
 try{
  if(env?.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==config?.repository||env.GITHUB_REF!=='refs/heads/main'||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')||!uuid(config.scope?.project_id)||config.scope.queue_ref!==`merge:${config.repository}:main`)return partial(stage);
  stage='EXISTING_AUDIT_READER_UNAVAILABLE';const token=(env.CLUED_CONTEXT_READ_TOKEN??'').trim();
  if(!/^clued_bnd_[A-Za-z0-9_-]+$/.test(token))return partial(stage);
  stage='ACCEPTED_MINIMAL_READER_PIN_MISMATCH';
  if(!uuid(config.bootstrap_clock_reader?.binding_id)||!digest(config.bootstrap_clock_reader?.credential_fingerprint)||
   credentialFingerprint(token)!==config.bootstrap_clock_reader.credential_fingerprint)return partial(stage);
  const context_key='project:'+config.scope.project_id,queue_ref=config.scope.queue_ref;
  const rpc=async measurement=>{
   const response=await fetchImpl(URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({context_key,measurement})});
   if(!response.ok)throw Error('CLOCK_TARGET_READ_REFUSED');const r=await boundedJson(response),a=r.server_auth;
   if(r.status!=='ok'||a?.schema!=='clued.clock-audit-transport-auth/1'||a.status!=='AUTHENTICATED_TARGET_READ'||
    a.required_scope!=='audit:read'||a.context_key!==context_key||a.queue_ref!==queue_ref||!digest(a.binding_scope_fingerprint)||
    !digest(a.transport_definition_digest)||!Number.isSafeInteger(a.contributor_count)||a.contributor_count<1)throw Error('CLOCK_SERVER_AUTH_INVALID');
   return r;
  };
  stage='CLOCK_OPEN_NOT_QUALIFIED';const opened=await rpc({operation:'clock_open',queue_ref});
  const pins=opened.pins;if(opened.operation!=='clock_open'||!uuid(pins?.epoch_id)||!uuid(pins.stream_id)||!uuid(pins.clock_generation_id)||
   !digest(pins.foundation_digest)||!digest(pins.catalog_digest)||!/^-[0-9]{1,19}$|^[0-9]{1,19}$/.test(opened.measurement?.opening_us??''))throw Error('CLOCK_OPEN_PINS_INVALID');
  stage='CLOCK_SEAL_NOT_QUALIFIED';const sealed=await rpc({operation:'clock_seal',queue_ref,epoch_id:pins.epoch_id,pins});
  if(sealed.operation!=='clock_seal'||!uuid(sealed.measurement?.seal_id)||JSON.stringify(sealed.pins)!==JSON.stringify(pins))throw Error('CLOCK_SEAL_PINS_INVALID');
  if(sealed.server_auth.binding_scope_fingerprint!==opened.server_auth.binding_scope_fingerprint||
   sealed.server_auth.contributor_count!==opened.server_auth.contributor_count||sealed.server_auth.transport_definition_digest!==opened.server_auth.transport_definition_digest)throw Error('CLOCK_AUTH_CHANGED');
  stage='CLOCK_PAGE_NOT_QUALIFIED';const page=await rpc({operation:'clock_page',queue_ref,seal_id:sealed.measurement.seal_id,pins,seal_pins:sealed.seal_pins,after_sequence:0,limit:1});
  if(page.operation!=='clock_page'||page.measurement?.status!=='ok'||JSON.stringify(page.pins)!==JSON.stringify(pins))throw Error('CLOCK_PAGE_PINS_INVALID');
  for(const r of [sealed,page])if(r.server_auth.binding_scope_fingerprint!==opened.server_auth.binding_scope_fingerprint||
   r.server_auth.contributor_count!==opened.server_auth.contributor_count||r.server_auth.transport_definition_digest!==opened.server_auth.transport_definition_digest)throw Error('CLOCK_AUTH_CHANGED');
  return {schema:'clued.r9-clock-bootstrap-observation/1',status:'AUTHENTICATED_READER_OBSERVATION',
   source:{repository:env.GITHUB_REPOSITORY,head_sha:env.GITHUB_SHA,run_id:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT},
   credential_fingerprint:credentialFingerprint(token),server_auth:opened.server_auth,
   candidate_epoch:{pins,opening_us:opened.measurement.opening_us},seal_pins:sealed.seal_pins,
   sample_page:{status:page.measurement.status,has_more:page.measurement.has_more,rows:page.measurement.events?.length??null},
   source_authenticated:false,official_metric:false,t0:null};
 }catch{return partial(stage);}
}
export async function main(env=process.env){
 const workspace=env.GITHUB_WORKSPACE??process.cwd(),config=JSON.parse(await fs.readFile(path.join(workspace,'scripts/ci/merge-admission-r9-source.json'),'utf8'));
 const result=await qualifyClockReader({env,config});await fs.writeFile(path.join(workspace,'ci-usage-report.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({status:result.status,reason_code:result.reason_code,source_authenticated:false,official_metric:false,t0:null}));
 return result.status==='AUTHENTICATED_READER_OBSERVATION'?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(c=>{process.exitCode=c;},()=>{console.error('CLOCK_BOOTSTRAP_FAILED');process.exitCode=1;});
