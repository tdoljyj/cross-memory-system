'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {execFileSync} = require('node:child_process');
const host = require('../scripts/model-program/development_request_host.cjs');
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' :
  v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+stable(v[k])).join(',')+'}' : JSON.stringify(v);
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const objectSha = v => sha(Buffer.from(stable(v)));
const clone = v => JSON.parse(JSON.stringify(v));
const pin = file => ({path:file,bytes:1,sha256:'1'.repeat(64)});
function fixture(root = path.resolve(os.tmpdir(),'source-fixture-not-an-experiment')) {
  const budget = {attempts:1,model_calls:1,concurrency:1,training_steps:0,paid_cost:0,downloads:0,
    model_external_network_bytes:0,input_tokens:4096,output_tokens:512,total_tokens:4608,context_tokens:8192,
    stdout_bytes:131072,stderr_bytes:131072,observation_bytes:65536,wall_seconds:120,
    max_output_storage_bytes:1048576,other_result_profile_ledger_and_receipts_max_bytes:262144,control_total_seconds:240};
  const input = {root_count:1,gold:false,holdout:false,prompt:pin(path.join(root,'not-read-prompt')),
    schema:pin(path.join(root,'not-read-schema'))};
  const model = {absolute_path:path.join(root,'not-read-model'),bytes:1,sha256:'1'.repeat(64)};
  const plan = {budget:Object.fromEntries(['input_tokens','output_tokens','total_tokens','stdout_bytes',
    'stderr_bytes','observation_bytes','wall_seconds'].map(k=>[k,budget[k]])),
    model:pin(model.absolute_path),prompt:input.prompt,output_schema:input.schema,
    observation_path:path.join(root,'outputs','runtime-observation.jsonl')};
  const startup = {schema:'SOURCE-ONLY-FIXTURE',neverExecuted:true,
    environment:{TEMP:path.join(root,'tmp'),TMP:path.join(root,'tmp')}};
  const draft = {task_id:TASK,proposed_profile_id:'DEV-SOURCE-ONLY',purpose:'development',budget,input,model,
    device:{cpu_threads:2,gpu_layers:0,substitution_allowed:false},
    source:{head:'a'.repeat(40),files:[pin('scripts/model-program/SOURCE-ONLY.cjs')]},
    planned_namespace:{root,ledger_child:'ledger',output_child:'outputs',observation_name:'runtime-observation.jsonl',
      reuse_old_m1_ledger:false,physical_same_principal_isolation_claimed:false},
    fixed_startup_preparation:{execution_plan_without_runtime_monotonic_deadline:plan,
      execution_plan_sha256:objectSha(plan),startup,startup_sha256:objectSha(startup),
      ledger_directory:path.join(root,'ledger'),output_directory:path.join(root,'outputs'),output_name:'runtime-observation.jsonl'}};
  const window = {not_before:new Date(Date.now()-1000).toISOString(),stop_at:new Date(Date.now()+60000).toISOString()};
  const request = host.makeDevelopmentRequestPayload(draft,window), p = request.payload;
  const approval = {kind:'EXACT_BOUNDED_DEVELOPMENT_EXPERIMENT',task_id:TASK,purpose_id:'development',
    profile_id:p.profile_id,request_sha256:request.requestSha256,max_attempts:1,
    training_allowed:false,production_allowed:false,qualification_allowed:false,budget:clone(p.budget),
    permissions:clone(p.permissions),window:clone(p.window),source_sha256:Object.fromEntries(p.source.files.map(r=>[r.path,r.sha256])),
    execution_plan_sha256:p.fixed_startup.execution_plan_sha256,startup_sha256:p.fixed_startup.startup_sha256};
  const record = {id:'SOURCE-ONLY-OWNER',version:1,record_type:'decision',authority:'user_explicit',
    lifecycle_status:'active',canonical_scope:SCOPE,receipt_id:'SOURCE-ONLY-RECEIPT',content_hash:'b'.repeat(64),
    type_fields:{rationale:{model_development_experiment_approval:approval}}};
  const ownerCapture = {structuredContent:{status:'committed',receipt_id:record.receipt_id,event_ids:['SOURCE-ONLY'],supplemental:{record}}};
  const bindingArgs = {requestBytes:request.requestBytes,expectedRequestSha256:request.requestSha256,ownerCapture,
    sessionRef:'SOURCE-ONLY-SESSION',livePins:{claim_id:'SOURCE-ONLY-CLAIM',claim_fence:1,task_version:2,
      task_query:'SOURCE ONLY TASK',holder_session_ref:'SOURCE-ONLY-SESSION'}};
  return {draft,window,request,p,record,approval,bindingArgs};
}
test('explicit hash domain excludes later capture/profile/results and emits preparation only',()=>{
  const f=fixture(), original=Buffer.from(f.request.requestBytes);
  f.draft.owner_experiment_approval={selfReported:true}; f.draft.issued_profile={status:'ISSUED'};
  f.draft.request_sha256='9'.repeat(64); f.draft.result={anything:true};
  assert.deepEqual(host.makeDevelopmentRequestPayload(f.draft,f.window).requestBytes,original);
  const result=host.prepareFixedDevelopmentOwnerBinding(f.bindingArgs);
  assert.equal(result.readiness,'PREPARED_NOT_ISSUED'); assert.equal(result.permission_issued,false);
  assert.equal(result.authority_effect,'NONE'); assert.ok(Object.isFrozen(result.candidate_manifest));
  assert.equal(Object.keys(result.candidate_identity).length,8);
  assert.ok(!Object.hasOwn(result,'issued')); assert.ok(!Object.hasOwn(host,'runFixedDevelopmentChild'));
});
test('separate control budget is frozen in plan and Owner request, never a model extension',()=>{
  const f=fixture();
  f.draft.budget.control_wall_seconds=225;
  const plan=f.draft.fixed_startup_preparation.execution_plan_without_runtime_monotonic_deadline;
  plan.budget.control_wall_seconds=225;
  f.draft.fixed_startup_preparation.execution_plan_sha256=objectSha(plan);
  const next=host.makeDevelopmentRequestPayload(f.draft,f.window);
  assert.equal(next.payload.budget.wall_seconds,120);
  assert.equal(next.payload.budget.control_total_seconds,240);
  assert.notEqual(next.requestSha256,f.request.requestSha256);
  assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding({...f.bindingArgs,
    requestBytes:next.requestBytes,expectedRequestSha256:next.requestSha256}),/EXACT_OWNER_EXPERIMENT/);
  for(const value of [true,0,226]) {
    f.draft.budget.control_wall_seconds=value;
    assert.throws(()=>host.makeDevelopmentRequestPayload(f.draft,f.window),/CONTROL_CHILD_BUDGET/);
  }
  f.draft.budget.control_wall_seconds=210;
  assert.throws(()=>host.makeDevelopmentRequestPayload(f.draft,f.window),/PLAN_CONTROL_BUDGET/);
});
test('fixed ledger/output children and approved temporary environment cannot escape',()=>{
  for(const alter of [f=>f.draft.planned_namespace.ledger_child='..',
    f=>f.draft.planned_namespace.output_child='..',
    f=>{f.draft.fixed_startup_preparation.startup.environment.TEMP=path.resolve(os.tmpdir());
      f.draft.fixed_startup_preparation.startup_sha256=objectSha(f.draft.fixed_startup_preparation.startup);}]) {
    const f=fixture();alter(f);
    assert.throws(()=>host.makeDevelopmentRequestPayload(f.draft,f.window),/FIXED_NAMESPACE/);
  }
});
test('prepared bootstrap passes the actual Python protocol exact three-key live-pins constructor',()=>{
  const f=fixture(), result=host.prepareFixedDevelopmentOwnerBinding(f.bindingArgs);
  assert.deepEqual(Object.keys(result.candidate_bootstrap.live_pins).sort(),['claim_fence','claim_id','task_version']);
  assert.equal(result.candidate_manifest.live_pins.task_query,'SOURCE ONLY TASK');
  assert.equal(result.candidate_manifest.live_pins.holder_session_ref,'SOURCE-ONLY-SESSION');
  const code=`import importlib.util,io,json,sys
spec=importlib.util.spec_from_file_location('source_protocol_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
pins=json.loads(sys.argv[2])
module.PrivateCurrentnessChannel(io.BytesIO(),io.BytesIO(),live_pins=pins)
try:module.PrivateCurrentnessChannel(io.BytesIO(),io.BytesIO(),live_pins={**pins,'task_query':'SOURCE ONLY'})
except module.CurrentnessChannelError:pass
else:raise AssertionError('EXTRA_KEY_ACCEPTED')
print('SOURCE_PROTOCOL_PASS')`;
  const printed=execFileSync('python',['-I','-S','-B','-c',code,
    path.resolve(__dirname,'../scripts/model-program/development_currentness_channel.py'),
    JSON.stringify(result.candidate_bootstrap.live_pins)],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(printed.trim(),'SOURCE_PROTOCOL_PASS');
});
test('forged flag, authoring record, changed source and mismatched budget cannot bind',()=>{
  for(const alter of [f=>f.bindingArgs.ownerCapture={status:'ISSUED'},f=>f.record.authority='observed',
    f=>f.record.record_type='note',f=>f.record.lifecycle_status='revoked',f=>f.record.receipt_id='OTHER',
    f=>f.record.type_fields.rationale={},f=>f.approval.request_sha256='0'.repeat(64),
    f=>f.approval.budget.stdout_bytes++,f=>f.approval.source_sha256={OTHER:'1'.repeat(64)},
    f=>f.approval.training_allowed=true,f=>f.bindingArgs.livePins.holder_session_ref='FOREIGN']) {
    const f=fixture(); alter(f); assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding(f.bindingArgs));
  }
});
test('only the actual M1 type_fields.rationale object can carry experiment approval',()=>{
  for (const alter of [f=>{f.record.rationale=f.record.type_fields.rationale;delete f.record.type_fields;},
    f=>{f.record.rationale=f.record.type_fields.rationale;f.record.type_fields.rationale=null;},
    f=>{f.record.rationale=f.record.type_fields.rationale;f.record.type_fields.rationale=[];},
    f=>{f.record.rationale=f.record.type_fields.rationale;f.record.type_fields.rationale=JSON.stringify(f.record.rationale);},
    f=>{f.record.rationale=f.record.type_fields.rationale;f.record.type_fields.rationale={preparationOnly:true};}]) {
    const f=fixture();alter(f);
    assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding(f.bindingArgs));
  }
});
test('Host live pins cannot carry private claim keys, tokens or arbitrary metadata',()=>{
  for(const key of ['lease_key','session_token','token','budget','execution_epoch']) {
    const f=fixture();f.bindingArgs.livePins[key]='SOURCE-ONLY-NOT-A-SECRET';
    assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding(f.bindingArgs),/ROOT_LIVE_PINS/);
  }
});
test('request bytes cannot drift, hide duplicate keys or self-referential hash fields',()=>{
  const f=fixture(); f.bindingArgs.requestBytes=Buffer.concat([f.request.requestBytes,Buffer.from(' ')]);
  assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding(f.bindingArgs),/REQUEST_DIGEST/);
  const duplicate=Buffer.from(f.request.requestBytes.toString().replace('"schema":','"schema":"DUPLICATE","schema":'));
  assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding({...f.bindingArgs,requestBytes:duplicate,
    expectedRequestSha256:sha(duplicate)}),/REQUEST_CANONICAL/);
  const p=clone(f.p);p.request_sha256='0'.repeat(64);const bytes=Buffer.from(stable(p));
  assert.throws(()=>host.prepareFixedDevelopmentOwnerBinding({...f.bindingArgs,requestBytes:bytes,
    expectedRequestSha256:sha(bytes)}),/PAYLOAD_FIELDS/);
});
test('expired, early, unzoned, impossible or overlong window cannot prepare a live binding',()=>{
  for(const window of [{not_before:'2000-01-01T00:00:00Z',stop_at:'2000-01-01T01:00:00Z'},
    {not_before:'2099-01-01T00:00:00Z',stop_at:'2099-01-01T01:00:00Z'},
    {not_before:'2026-10-13T00:00:00',stop_at:'2026-10-13T01:00:00Z'},
    {not_before:'2026-02-30T00:00:00Z',stop_at:'2026-03-01T01:00:00Z'},
    {not_before:'2026-10-13T00:00:00Z',stop_at:'2026-10-15T00:00:00Z'}]) {
    const f=fixture();assert.throws(()=>{const request=host.makeDevelopmentRequestPayload(f.draft,window);
      f.approval.window=window; f.approval.request_sha256=request.requestSha256;
      host.prepareFixedDevelopmentOwnerBinding({...f.bindingArgs,requestBytes:request.requestBytes,
        expectedRequestSha256:request.requestSha256});});
  }
});
test('budget encoded overhead and exact model/plan drift reject before effects',()=>{
  for(const alter of [f=>f.draft.budget.max_output_storage_bytes=1000,
    f=>f.draft.budget.model_calls=2,f=>f.draft.device.gpu_layers=1,
    f=>f.draft.model.sha256='4'.repeat(64),f=>f.draft.source.files.push(f.draft.source.files[0])]){
    const f=fixture();alter(f);assert.throws(()=>host.makeDevelopmentRequestPayload(f.draft,f.window));
  }
});
async function saveFixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'clued-dev-source-save-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'ledger'));await fs.mkdir(path.join(root,'outputs'));await fs.mkdir(path.join(root,'tmp'));
  const f=fixture(root), profile=Buffer.from('SOURCE FIXTURE NOT AN ISSUED PROFILE');
  await fs.writeFile(path.join(root,'profile-manifest.json'),profile,{flag:'wx'});
  const spent={schema:'clued.model-attempt-reservation/1',status:'SPENT_BEFORE_MODEL_LOAD',max_attempts:1,
    retries_allowed:false,task_id:TASK,profile_id:f.p.profile_id,request_sha256:f.request.requestSha256,
    profile_sha256:sha(profile),plan_sha256:f.p.fixed_startup.execution_plan_sha256};
  const spentBytes=Buffer.from(stable(spent)), spentPath=path.join(root,'ledger',sha(Buffer.from(f.p.profile_id))+'.spent.json');
  await fs.writeFile(spentPath,spentBytes,{flag:'wx'});
  const obs=Buffer.from('SOURCE ONLY OBSERVATION'), observationPath=path.join(root,'outputs','runtime-observation.jsonl');
  await fs.writeFile(observationPath,obs,{flag:'wx'});
  const encoded=b=>({encoding:'base64',data:b.toString('base64')});
  const terminalResult={authority_effect:'NONE',model_output_validated:false,usage:null,owned_cleanup_verified:true,
    stdout_raw:encoded(Buffer.from('data only')),stderr_raw:encoded(Buffer.alloc(0)),
    observation_capture:{raw:encoded(obs),retained_bytes:obs.length,sha256:sha(obs)},
    capture:{stdout:{retained_bytes:9},stderr:{retained_bytes:0}},
    budget_reservation:{path:spentPath,bytes:spentBytes.length,sha256:sha(spentBytes),status:'SPENT_BEFORE_MODEL_LOAD'}};
  return {...f,root,spentPath,spentBytes,observationPath,obs,args:{requestBytes:f.request.requestBytes,
    expectedRequestSha256:f.request.requestSha256,terminalResult,deadlineMonotonic:performance.now()+60000}};
}
test('save keeps one encoded terminal, original observation, Profile and spent record',async t=>{
  const f=await saveFixture(t), result=await host.saveFixedDevelopmentResult(f.args);
  assert.equal(result.authority_effect,'NONE');assert.equal(result.attempt_remains_spent,true);
  assert.ok(result.total_saved_bytes<=1048576);
  assert.deepEqual(await fs.readdir(path.join(f.root,'outputs')),['result-metadata.json','runtime-observation.jsonl','terminal-result.json']);
  assert.deepEqual(await fs.readFile(f.spentPath),f.spentBytes);
  assert.deepEqual(await fs.readFile(f.observationPath),f.obs);
  await assert.rejects(host.saveFixedDevelopmentResult(f.args),/REPLAY/);
});
test('capture limit, altered observation, fake cleanup or mismatched spent refuse saving',async t=>{
  for(const alter of [f=>f.args.terminalResult.stdout_raw.data=Buffer.alloc(131073).toString('base64'),
    f=>f.args.terminalResult.owned_cleanup_verified=false,f=>f.args.terminalResult.budget_reservation.sha256='0'.repeat(64),
    f=>f.args.terminalResult.observation_capture.raw.data=Buffer.from('OTHER').toString('base64')]){
    const f=await saveFixture(t);alter(f);await assert.rejects(host.saveFixedDevelopmentResult(f.args));
    assert.equal((await fs.readdir(path.join(f.root,'outputs'))).length,1);
    assert.deepEqual(await fs.readFile(f.spentPath),f.spentBytes);
  }
});
test('cumulative saved budget refuses before create; undeclared raw logs also refuse',async t=>{
  const f=await saveFixture(t);
  await fs.writeFile(path.join(f.root,'approval-receipt.json'),Buffer.alloc(262144),{flag:'wx'});
  await assert.rejects(host.saveFixedDevelopmentResult(f.args),/SAVE_BUDGET/);
  assert.equal((await fs.readdir(path.join(f.root,'outputs'))).length,1);
  await fs.writeFile(path.join(f.root,'outputs','raw-stdout.txt'),'NO COPY',{flag:'wx'});
  await assert.rejects(host.saveFixedDevelopmentResult(f.args),/SAVE_UNDECLARED_FILE/);
});
test('an existing partial terminal refuses overwrite and never deletes spent evidence',async t=>{
  const f=await saveFixture(t), target=path.join(f.root,'outputs','terminal-result.json');
  await fs.writeFile(target,'PARTIAL',{flag:'wx'});
  await assert.rejects(host.saveFixedDevelopmentResult(f.args),/REPLAY/);
  assert.equal(await fs.readFile(target,'utf8'),'PARTIAL');
  assert.deepEqual(await fs.readFile(f.spentPath),f.spentBytes);
});
test('missing, expired and non-finite shared cutoff cannot start a save',async t=>{
  const f=await saveFixture(t);
  for(const deadlineMonotonic of [undefined,NaN,Infinity,performance.now()-1])
    await assert.rejects(host.saveFixedDevelopmentResult({...f.args,deadlineMonotonic}),/SAVE_SHARED_DEADLINE/);
  assert.deepEqual(await fs.readdir(path.join(f.root,'outputs')),['runtime-observation.jsonl']);
  assert.deepEqual(await fs.readFile(f.spentPath),f.spentBytes);
});
test('a late async read cannot restart the shared cutoff or begin subsequent writes',async t=>{
  const f=await saveFixture(t), originalRead=fs.readFile, originalOpen=fs.open;
  let writes=0, delayed;
  fs.readFile=(file,...args)=>{
    if(file===path.join(f.root,'profile-manifest.json')) {
      delayed=new Promise((resolve,reject)=>setTimeout(()=>originalRead(file,...args).then(resolve,reject),200));
      return delayed;
    }
    return originalRead(file,...args);
  };
  fs.open=(file,...args)=>{if(args[0]==='wx')writes++;return originalOpen(file,...args);};
  try {
    await assert.rejects(host.saveFixedDevelopmentResult({...f.args,deadlineMonotonic:performance.now()+100}),/SAVE_DEADLINE/);
    await delayed;
    assert.equal(writes,0);
    assert.deepEqual(await fs.readdir(path.join(f.root,'outputs')),['runtime-observation.jsonl']);
    assert.deepEqual(await originalRead(f.spentPath),f.spentBytes);
  } finally {fs.readFile=originalRead;fs.open=originalOpen;}
});
test('a late create-only open is closed without later writes or spent reset',async t=>{
  const f=await saveFixture(t), originalOpen=fs.open;
  const target=path.join(f.root,'outputs','terminal-result.json');
  let writes=0, resolveClosed;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  fs.open=async(file,...args)=>{
    const handle=await originalOpen(file,...args);
    if(file!==target)return handle;
    const originalClose=handle.close.bind(handle), originalWrite=handle.writeFile.bind(handle);
    handle.close=async()=>{await originalClose();resolveClosed();};
    handle.writeFile=(...args)=>{writes++;return originalWrite(...args);};
    await new Promise(resolve=>setTimeout(resolve,200));return handle;
  };
  try {
    await assert.rejects(host.saveFixedDevelopmentResult({...f.args,deadlineMonotonic:performance.now()+100}),/SAVE_DEADLINE/);
    await closed;
    assert.equal(writes,0);assert.equal((await fs.stat(target)).size,0);
    assert.deepEqual(await fs.readFile(f.spentPath),f.spentBytes);
    await assert.rejects(host.saveFixedDevelopmentResult(f.args),/REPLAY/);
  } finally {fs.open=originalOpen;}
});
