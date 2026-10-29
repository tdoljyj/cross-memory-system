// Pure Task617 public binding checks. No Host, credential or qualification producer.
// This delivery is disabled. Changing an incoming payload cannot enable it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

export const COMPONENT_VERSION = "1.0.3";
const TASK='6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8',REPO='tdoljyj/cross-memory-system';
const SHA=/^[0-9a-f]{64}$/,COMMIT=/^[0-9a-f]{40}$/;
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,ID=/^[1-9][0-9]{0,19}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
const exact=(value,keys,code)=>assert.ok(value&&typeof value==='object'&&!Array.isArray(value)&&
  same(Object.keys(value).sort(),[...keys].sort()),code);
const match=(value,pattern,code)=>{assert.equal(typeof value,'string',code);
  const result=pattern.exec(value);assert.ok(result&&result[0]===value,code);};
const identifier=(value,code)=>match(value,ID,code);
const positiveInt=(value,code)=>assert.ok(Number.isSafeInteger(value)&&value>0,code);
const instant=value=>{assert.ok(typeof value==='string'&&ISO.test(value),'NATIVE617_TIME_SHAPE');
  const ms=Date.parse(value);assert.ok(Number.isFinite(ms)&&new Date(ms).toISOString()===value,'NATIVE617_TIME_INVALID');return ms;};

export const NATIVE617_POLICY=freeze({"schema":"clued.native617-entry-policy/1","task_id":"6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8","repository":"tdoljyj/cross-memory-system","repository_id":"1334673495","actor_id":"52366662","required_app_id":5164952,"execution_enabled":false,"status":"PENDING_INDEPENDENT_E1_HOST_QUALIFICATION","source_ttl_ceiling":"2026-10-26T03:52:25.032Z","host_id":null,"image_sha256":null,"runner_group_id":null,"host_qualification_ref":null,"routes":{"control":["self-hosted","Linux","X64","clued","trust-internal","handover-native-control-once"],"native":["self-hosted","Linux","X64","clued","trust-internal","handover-native-task617-once"]}});
export function validateNative617Policy(policy){
  // Expected Source policy is independent of the incoming packet.
  exact(policy,Object.keys(NATIVE617_POLICY),'NATIVE617_POLICY_FIELDS');
  exact(policy.routes,['control','native'],'NATIVE617_ROUTE_FIELDS');
  assert.ok(same(policy,NATIVE617_POLICY),'NATIVE617_POLICY_DIFFERS');
  return NATIVE617_POLICY;
}
const CONTEXT_KEYS=['schema','task_id','repository','repository_id','actor_id','triggering_actor_id',
  'event_name','workflow_path','workflow_sha','head_sha','ref','job_key','run_id','run_attempt','phase','input_class'];
const QUALIFIER='.github/workflows/clued-handover-external-qualification.yml';
const IDLE='.github/workflows/clued-handover-disposable-idle.yml';
const CONTROL='.github/workflows/clued-native617-admission-dispatch.yml';
const INPUTS=freeze({
  'source-only':['job-token'],'idle':['job-token'],'control':['job-token','clued-admission-token'],
  'register':['pg-url'],'publish':['job-token','app516','pg-url','fixture-proof'],
  'revoke':['job-token','app516','pg-url','fixture-proof']
});
export function validateNative617Context(context,policy=NATIVE617_POLICY){
  validateNative617Policy(policy);exact(context,CONTEXT_KEYS,'NATIVE617_CONTEXT_FIELDS');
  assert.equal(context.schema,'clued.native617-job-context/1');
  assert.equal(context.task_id,TASK);assert.equal(context.repository,REPO);
  assert.equal(context.repository_id,'1334673495');
  assert.equal(context.actor_id,'52366662');assert.equal(context.triggering_actor_id,'52366662');
  match(context.workflow_sha,COMMIT,'NATIVE617_WORKFLOW_SHA');match(context.head_sha,COMMIT,'NATIVE617_HEAD_SHA');
  identifier(context.run_id,'NATIVE617_RUN_ID');assert.equal(context.run_attempt,1);
  assert.equal(typeof context.input_class,'string');
  if(context.event_name==='pull_request'){
    assert.equal(context.phase,'source-only');assert.equal(context.input_class,'source-only');
    match(context.ref,/^refs\/pull\/[1-9][0-9]{0,19}\/merge$/,'NATIVE617_PR_REF');
    assert.ok((context.workflow_path===QUALIFIER&&context.job_key==='qualify')||
      (context.workflow_path===IDLE&&context.job_key==='disposable-idle'),'NATIVE617_PR_JOB');
  }else{
    assert.equal(context.event_name,'workflow_dispatch');assert.equal(context.workflow_sha,context.head_sha);
    if(context.workflow_path===CONTROL){
      assert.equal(context.job_key,'admit');assert.equal(context.ref,'refs/heads/main');
      assert.equal(context.phase,'control');assert.equal(context.input_class,'control');
    }else if(context.workflow_path===QUALIFIER){
      assert.equal(context.job_key,'qualify');assert.equal(context.ref,'refs/heads/main');
      assert.ok(['register','publish','revoke'].includes(context.phase),'NATIVE617_PHASE');
      assert.equal(context.input_class,context.phase);
    }else{
      assert.equal(context.workflow_path,IDLE);assert.equal(context.job_key,'disposable-idle');
      assert.equal(context.phase,'idle');assert.equal(context.input_class,'idle');
      match(context.ref,/^refs\/heads\/clued-handover-disposable-[a-zA-Z0-9.-]{1,70}$/,'NATIVE617_IDLE_REF');
    }
  }
  return freeze(structuredClone(context));
}
const PACKET_KEYS=['schema','context','github_job_id','runner_id','runner_name','runner_group_id','runner_labels',
  'host_id','guest_instance_id','image_sha256','host_qualification_ref','source_acceptance_ref',
  'prior_cleanup_proof_sha256','issued_at','expires_at','private_input_classes'];
const ref=value=>match(value,/^receipt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,'NATIVE617_REFERENCE_SHAPE');
export function validateNative617PublicBinding(packet,context,{policy=NATIVE617_POLICY,now=Date.now()}={}){
  const expected=validateNative617Context(context,policy);exact(packet,PACKET_KEYS,'NATIVE617_PACKET_FIELDS');
  assert.equal(packet.schema,'clued.native617-public-job-binding/1');
  assert.deepEqual(validateNative617Context(packet.context,policy),expected,'NATIVE617_JOB_CONTEXT_DIFFERS');
  identifier(packet.github_job_id,'NATIVE617_JOB_ID');
  positiveInt(packet.runner_id,'NATIVE617_RUNNER_ID');positiveInt(packet.runner_group_id,'NATIVE617_GROUP_ID');
  match(packet.runner_name,/^clued-native617-[a-z0-9-]{12,70}$/,'NATIVE617_RUNNER_NAME');
  match(packet.host_id,/^[a-z0-9][a-z0-9-]{1,63}$/,'NATIVE617_HOST_ID');
  match(packet.guest_instance_id,UUID,'NATIVE617_GUEST_ID');match(packet.image_sha256,SHA,'NATIVE617_IMAGE_SHA');
  match(packet.prior_cleanup_proof_sha256,SHA,'NATIVE617_CLEANUP_SHA');
  ref(packet.host_qualification_ref);ref(packet.source_acceptance_ref);
  assert.deepEqual(packet.runner_labels,policy.routes[context.phase==='control'?'control':'native']);
  assert.deepEqual(packet.private_input_classes,INPUTS[context.input_class],'NATIVE617_INPUT_CLASS_DIFFERS');
  assert.ok(Number.isFinite(now),'NATIVE617_CLOCK_REQUIRED');
  const start=instant(packet.issued_at),end=instant(packet.expires_at),ceiling=instant(policy.source_ttl_ceiling);
  const maxMs=(context.phase==='control'?5:context.phase==='idle'?45:25)*60000;
  assert.ok(start<=now&&now<end&&end-start<=maxMs&&end<=ceiling,'NATIVE617_BINDING_TIME');
  // Syntax checks do not authenticate receipts, qualify a Host or release inputs.
  return freeze({schema:'clued.native617-public-binding-validation/1',syntax_valid:true,
    authority:'none',execution_permitted:false,host_qualified:false,source_accepted:false,
    context_sha256:crypto.createHash('sha256').update(JSON.stringify(canonical(expected))).digest('hex')});
}
export function assertNative617ExecutionEnabled(policy){
  validateNative617Policy(policy);
  throw new Error('NATIVE617_HOST_NOT_QUALIFIED');
}
function readSourcePolicy(){
  const name=fileURLToPath(new URL('../../config/clued-handover-native-entry-policy.json',import.meta.url));
  const a=fs.lstatSync(name,{bigint:true});assert.ok(a.isFile()&&!a.isSymbolicLink()&&a.nlink===1n&&a.size>0n&&a.size<=16384n);
  const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const before=fs.fstatSync(fd,{bigint:true});
    assert.ok(before.isFile()&&before.nlink===1n&&before.size===a.size&&before.size<=16384n);
    const buffer=Buffer.alloc(16385);let used=0;
    while(used<buffer.length){const count=fs.readSync(fd,buffer,used,buffer.length-used,null);if(count===0)break;used+=count;}
    assert.ok(used<=16384&&BigInt(used)===before.size,'NATIVE617_SOURCE_POLICY_BOUNDS');
    const raw=buffer.subarray(0,used),after=fs.fstatSync(fd,{bigint:true});
    const last=fs.lstatSync(name,{bigint:true});
    assert.ok(before.isFile()&&before.nlink===1n&&before.size===BigInt(raw.length));
    for(const key of ['dev','ino','size','mtimeNs','ctimeNs']){
      assert.equal(before[key],after[key],'NATIVE617_SOURCE_POLICY_CHANGED');
      assert.equal(a[key],last[key],'NATIVE617_SOURCE_POLICY_REPLACED');
    }
    for(const key of ['dev','ino','size'])assert.equal(a[key],before[key],'NATIVE617_SOURCE_POLICY_IDENTITY');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  }finally{fs.closeSync(fd);}
}
export function native617Main(args){
  if(args.length===0)return {status:'DISABLED_NO_HOST_READ',execution_permitted:false,authority:'none'};
  assert.deepEqual(args,['--check'],'NATIVE617_ARGUMENTS_REFUSED');
  assertNative617ExecutionEnabled(readSourcePolicy());
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{console.log(JSON.stringify(native617Main(process.argv.slice(2))));}
  catch{console.error(JSON.stringify({status:'NATIVE617_REFUSED_NOT_QUALIFIED',execution_permitted:false,
    authority:'none',host_qualified:false}));process.exitCode=1;}
}
