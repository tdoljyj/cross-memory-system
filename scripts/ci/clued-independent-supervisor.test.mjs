import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import {createWindowsIndependentSupervisor,createFixtureWindowsIndependentSupervisor} from './clued-independent-supervisor.mjs';
const NOW=Date.parse('2026-11-01T00:00:00Z');
mock.timers.enable({apis:['Date'],now:NOW}); // the code under test reads Date.now(): hold it at NOW
import {makeJobV2,batchRefV2} from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import {canonical,digest} from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import {observeIndependentControllerStop} from './clued-independent-revoker.mjs';

const sid='S-1-5-21-1-2-3-1015',nonce='a'.repeat(32),sha='b'.repeat(64),requestId='11111111-2222-4333-8444-555555555555';
const names=['planBytes','jobsBytes','requestBytes','responseBytes','receiptBytes','outcomeBytes'];
const witness=()=>({contract:'clued.independent-ci.controller-supervision/1',controllerSid:sid,nonce,configSha256:sha,plan:{stage:3}});
const reply=()=>({contract:'clued.independent-ci.protected-stop-bundle/1',nonce,controllerSid:sid,requestId,
 files:Object.fromEntries(names.map((name,i)=>[name,Buffer.from(JSON.stringify({name,sequence:i})).toString('base64')]))});
const maintenance=()=>({nonce,configSha256:sha,stage:12,controllerSid:sid,nodeId:'FIXTURE-NODE',runnerService:'actions.runner.tdoljyj-cross-memory-system.fixture',nodePid:1234});
const maintenanceReply=()=>({contract:'clued.independent-ci.scm-maintenance-window/1',...maintenance(),helperPid:1233,sourceManifestSha256:'c'.repeat(64),observedAt:new Date(NOW).toISOString()});
function legacyFixture(){
 const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:937,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),testSha:'a'.repeat(40),sourceManifestSha256:'c'.repeat(64),role:'gitleaks',createdAt:'2026-10-29T05:00:00.000Z',attempt:1});
 const input={repository:job.repo,heads:[job.headSha],claimId:'11111111-2222-4333-8444-555555555555',beforeExecutionEpoch:3};
 const claim={claimId:input.claimId,fence:4,epoch:2},plan={contract:'clued.independent-ci.fixed-formal-windows-entry/3',enabled:true,stage:3,entryRole:'check-publisher',
  batchKey:'d'.repeat(64),batchId:'d'.repeat(16)+'-'+'e'.repeat(12),ownerPackageAcceptanceRef:requestId,nodeSha256:'f'.repeat(64),nodeProfileSha256:'1'.repeat(64),
  entrySha256:'2'.repeat(64),acceptanceSha256:'3'.repeat(64),sourceManifestSha256:job.sourceManifestSha256,installationSha256:'4'.repeat(64),runtimeConfigPinSha256:'5'.repeat(64),jobSha256:digest([job])};
 const oldConfig=digest(plan),request={contract:'clued.independent-ci.swap-broker-request/2',stage:3,nonce,configSha256:oldConfig,deadline:'2026-10-29T06:00:00.000Z'};
 const outcome={contract:'clued.independent-ci.entry-outcome/2',nonce,stage:3,entryRole:'check-publisher',status:'SETTLED',reason:null,sideEffects:1,mayHavePublished:true,jobIds:[job.id]};
 const response={contract:'clued.independent-ci.swap-broker-response/2',requestId,ok:true,code:null,started:true,startCallIssued:true,helperPid:1233,stoppedInTime:true,restored:true,accountUnchanged:true,stableBefore:true,stableAfter:true,configurationConflict:false};
 const receipt={contract:'clued.independent-ci.windows-formal-entry-receipt/2',nonce,state:'FIXED_CHILD_COMPLETED',failure_code:null,actual_sid:sid,service_pid:1233,session_id:0,
  node_pid:1234,node_exit_code:0,timed_out:false,stop_requested:false,tree_cleanup_confirmed:true,tree_cleanup_failure_code:null,tree_active_processes:0,root_exit_confirmed:true,
  entry_role:plan.entryRole,stage:3,entry_sha256:plan.entrySha256,config_sha256:oldConfig,acceptance_sha256:plan.acceptanceSha256,source_manifest_sha256:plan.sourceManifestSha256,
  outcome_sha256:digest(outcome),stdout_captured:false,private_bytes_read_by_helper:false,host_qualification:false,ci_principal_qualification:false};
 const claimBody={contract:'clued.independent-ci.batch-claim/1',batchRef:batchRefV2(job),...Object.fromEntries(['repo','pr','headSha','baseSha','sourceManifestSha256','attempt','createdAt'].map(k=>[k,job[k]])),claim,observedAt:'2026-10-29T05:00:00.000Z'};
 const encode=v=>Buffer.from(canonical(v)).toString('base64'),entry={requestId,nonce,configSha256:oldConfig,stage:3,
  files:Object.fromEntries(Object.entries({planBytes:plan,jobsBytes:[job],requestBytes:request,responseBytes:response,receiptBytes:receipt,outcomeBytes:outcome}).map(([k,v])=>[k,encode(v)])),
  batchClaims:{[batchRefV2(job)]:encode({...claimBody,integrity:digest(claimBody)})}};
 return {job,input,claim,entry,packet:{contract:'clued.independent-ci.local-legacy-stop-inventory/1',controllerSid:sid,nodeId:'FIXTURE-NODE',...input,entries:[entry],pending:[]}};
}
test('explicit fixture reader returns the exact six raw observations, never a stopped assertion',async()=>{
 let called=0;
 const expected=reply(),port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async query=>{
  called++;assert.deepEqual(query,{nonce,configSha256:sha,stage:3,controllerSid:sid});assert.equal(Object.isFrozen(query),true);return expected;
 }});
 const result=await port.readProtectedStopBundle(witness());assert.equal(port.fixture,true);assert.equal(result.requestId,requestId);
 for(const name of names)assert.equal(result[name].toString(),Buffer.from(expected.files[name],'base64').toString());
 assert.equal(Object.hasOwn(result,'stopped'),false);assert.equal(called,1);assert.equal(Object.isFrozen(result),true);
});
test('production factory rejects path overrides, caller supplied readers and malformed controller identities',()=>{
 assert.equal(createWindowsIndependentSupervisor({controllerSid:sid}).fixture,false);
 for(const extra of [{root:'C:\\tmp'},{transport:()=>reply()},{readBundle:()=>reply()},{fixture:true}])
  assert.throws(()=>createWindowsIndependentSupervisor({controllerSid:sid,...extra}),/fixed_reader_required/);
 for(const controllerSid of ['',sid+'\n',sid+';exit 0','S-1-5-18'])assert.throws(()=>createWindowsIndependentSupervisor({controllerSid}));
});
test('a mismatched controller, nonce, source digest or stage is refused before any protected read',async()=>{
 let reads=0;const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async()=>{reads++;return reply();}});
 for(const change of [w=>w.controllerSid='S-1-5-21-9-8-7-6',w=>w.nonce='../somewhere',w=>w.nonce+='\n',w=>w.configSha256+='\n',
  w=>w.configSha256='f'.repeat(40),w=>w.plan.stage=12,w=>w.plan.stage=3.5,w=>w.contract='other']){
  const input=witness();change(input);await assert.rejects(()=>port.readProtectedStopBundle(input),/witness_invalid/);
 }
 assert.equal(reads,0);
});
test('unknown, partial, oversized or noncanonical transport output cannot become protected observations',async()=>{
 const changes=[r=>delete r.files.receiptBytes,r=>r.files.extra='e30=',r=>r.files.planBytes='',r=>r.files.planBytes='e30=\n',
  r=>r.files.planBytes='e31=',r=>r.files.requestBytes=Buffer.alloc(8193).toString('base64'),r=>r.requestId+='\n',
  r=>r.controllerSid='S-1-5-21-9-8-7-6',r=>r.nonce='c'.repeat(32),r=>r.aclVerified=true];
 for(const change of changes){const packet=reply();change(packet);
  const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async()=>packet});
  await assert.rejects(()=>port.readProtectedStopBundle(witness()),/bundle_unconfirmed/);
 }
});
test('denied or unavailable protected access remains a failure without a retry or a substitute reader',async()=>{
 let called=0;const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async()=>{called++;throw Object.assign(Error('denied'),{code:'EACCES'});}});
 await assert.rejects(()=>port.readProtectedStopBundle(witness()),{code:'EACCES'});assert.equal(called,1);
});
test('maintenance observation binds the actual invocation and exposes its observed Source pin',async()=>{
 let calls=0;const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async query=>{
  calls++;assert.deepEqual(query,{...maintenance(),mode:'maintenance'});return maintenanceReply();
 }});
 const result=await port.assertMaintenanceWindow(maintenance());assert.equal(result.helperPid,1233);
 assert.equal(result.sourceManifestSha256,'c'.repeat(64));assert.equal(Object.isFrozen(result),true);assert.equal(calls,1);
});
test('maintenance accepts no idle/stopped assertion, arbitrary service, stale observation or substituted invocation',async()=>{
 let reads=0;const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async()=>{reads++;return maintenanceReply();}});
 for(const change of [q=>q.stage=3,q=>q.controllerSid+='\n',q=>q.nodeId="node';exit 0",q=>q.nodePid=-1,q=>q.runnerService='Spooler',q=>q.stopped=true]){
  const input=maintenance();change(input);await assert.rejects(()=>port.assertMaintenanceWindow(input),/window_input_invalid/);
 }assert.equal(reads,0);
 for(const change of [r=>r.helperPid=r.nodePid,r=>r.nonce='d'.repeat(32),r=>r.sourceManifestSha256+='\n',r=>r.nodeId='OTHER',
  r=>r.observedAt=new Date(NOW-10000).toISOString(),r=>r.observedAt=new Date(NOW+10000).toISOString(),r=>r.running=true]){
  const packet=maintenanceReply();change(packet);const wrong=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle:async()=>packet});
  await assert.rejects(()=>wrong.assertMaintenanceWindow(maintenance()),/window_unconfirmed/);
 }
});
test('local legacy inventory reconstructs the original claim and physical invocation without asserting a Native ticket',async()=>{
 const f=legacyFixture(),port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,nodeId:'FIXTURE-NODE',readBundle:async query=>{
  assert.equal(query.mode,'legacy');assert.equal(query.claimId,f.input.claimId);return f.packet;
 }});
 const result=await port.readLegacyControllerStopBundles(f.input);assert.equal(result.complete,true);assert.equal(result.executions.length,1);
 const execution=result.executions[0];assert.equal(execution.identity.claim.execution_epoch,2);assert.equal(execution.identity.claim.fence,4);
 assert.equal(execution.identity.job.id,f.job.id);assert.equal(Object.hasOwn(execution,'publication_id'),false);
 assert.equal(observeIndependentControllerStop(execution.identity,execution.witness,execution.bundle).stopped,true);
});
test('empty, duplicate, old-format or missing-batch legacy inventories remain pending',async()=>{
 const edits=[f=>f.packet.entries=[],f=>f.packet.entries.push(structuredClone(f.entry)),f=>f.entry.batchClaims={},
  f=>f.entry.files.jobsBytes=Buffer.from(canonical([{...f.job,contract:'clued.independent-ci.job/2'}])).toString('base64'),
  f=>f.packet.pending.push({requestId:null,reason:'independent_legacy_protected_read_unconfirmed'})];
 for(const edit of edits){const f=legacyFixture();edit(f);const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,nodeId:'FIXTURE-NODE',readBundle:async()=>f.packet});
  const result=await port.readLegacyControllerStopBundles(f.input);assert.equal(result.complete,false);assert.ok(result.pending.length>0);
 }
});
test('legacy inventory requires the pinned local node and exact repository/head/claim scope',async()=>{
 const f=legacyFixture();let reads=0;const readBundle=async()=>{reads++;return f.packet;};
 const missingNode=createFixtureWindowsIndependentSupervisor({controllerSid:sid,readBundle});await assert.rejects(()=>missingNode.readLegacyControllerStopBundles(f.input),/input_invalid/);
 const port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,nodeId:'FIXTURE-NODE',readBundle});
 for(const change of [q=>q.repository='other/repo',q=>q.heads=[],q=>q.heads=['../x'],q=>q.heads.push(q.heads[0]),q=>q.claimId+='\n',q=>q.beforeExecutionEpoch=0]){
  const input=structuredClone(f.input);change(input);await assert.rejects(()=>port.readLegacyControllerStopBundles(input),/input_invalid/);
 }assert.equal(reads,0);
});
test('the exact embedded Windows reader parses and its handle/DACL primitive compiles',{skip:process.platform!=='win32'},async()=>{
 const source=fs.readFileSync(new URL('./clued-independent-supervisor.mjs',import.meta.url),'utf8');
 const sharp=source.match(/Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@ \| Out-Null/)[1];
 const script=source.match(/String\.raw`([\s\S]*?)`;\n}/)[1];
 const operation=promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';$inputCode=[Console]::In.ReadToEnd()|ConvertFrom-Json;[void][ScriptBlock]::Create($inputCode.script);Add-Type -TypeDefinition $inputCode.sharp|Out-Null;[Console]::Out.Write('WINDOWS_READER_COMPILED')"],
  {windowsHide:true,maxBuffer:4096});
 operation.child.stdin.end(JSON.stringify({sharp,script}));assert.equal((await operation).stdout,'WINDOWS_READER_COMPILED');
});
test('the actual PowerShell legacy batch reference equals the job/3 canonical reference',{skip:process.platform!=='win32'},async()=>{
 const source=fs.readFileSync(new URL('./clued-independent-supervisor.mjs',import.meta.url),'utf8'),functionSource=source.match(/function Batch-Ref\(\$job\){[\s\S]*?\n}/)[0],f=legacyFixture();
 const operation=promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';$fixtureInput=[Console]::In.ReadToEnd()|ConvertFrom-Json;. ([ScriptBlock]::Create($fixtureInput.functionSource));[Console]::Out.Write((Batch-Ref $fixtureInput.job))"],
  {windowsHide:true,maxBuffer:4096});operation.child.stdin.end(JSON.stringify({functionSource,job:f.job}));assert.equal((await operation).stdout,batchRefV2(f.job));
});
test('the actual PowerShell inventory cannot hide a second publisher by tampering its public head or repository',{skip:process.platform!=='win32'},async()=>{
 const source=fs.readFileSync(new URL('./clued-independent-supervisor.mjs',import.meta.url),'utf8');
 const functions=[source.match(/function Read-StopFiles\([^]*?\n}/)[0],source.match(/function Batch-Ref\(\$job\){[^]*?\n}/)[0]].join('\n');
 const legacyBranch=source.match(/( if\(\$legacy\){[^]*?\n })(?=\n Hold-Parents)/)[1];
 for(const field of ['headSha','repo']){
  const f=legacyFixture(),second=structuredClone(f.entry),secondNonce='b'.repeat(32),secondId='22222222-3333-4444-8555-666666666666';
  second.nonce=secondNonce;second.requestId=secondId;
  const request=JSON.parse(Buffer.from(second.files.requestBytes,'base64'));request.nonce=secondNonce;
  second.files.requestBytes=Buffer.from(canonical(request)).toString('base64');
  const tamperedJobs=JSON.parse(Buffer.from(second.files.jobsBytes,'base64'));
  tamperedJobs[0][field]=field==='headSha'?'d'.repeat(40):'other/repository';
  // The attacker can change resident-owned jobs bytes, but cannot change the
  // original create-only request's config pin or its pinned plan.jobs hash.
  second.files.jobsBytes=Buffer.from(canonical(tamperedJobs)).toString('base64');
  const prefix='C:\\fixture',requests=prefix+'\\resident\\broker\\requests',responses=prefix+'\\resident\\broker\\responses';
  const stageRoot=prefix+'\\resident\\stage',receipts=prefix+'\\state\\v2\\receipts',v2=prefix+'\\state\\v2',files={},requestPaths=[];
  for(const entry of [f.entry,second]){
   const requestPath=requests+'\\'+entry.requestId+'.json';requestPaths.push(requestPath);files[requestPath]=entry.files.requestBytes;
   for(const [name,file] of [['planBytes',stageRoot+'\\'+entry.nonce+'\\formal-service-entry.json'],['jobsBytes',stageRoot+'\\'+entry.nonce+'\\jobs.json'],
    ['responseBytes',responses+'\\'+entry.requestId+'.json'],['receiptBytes',receipts+'\\windows-formal-entry-'+entry.nonce+'.json'],['outcomeBytes',receipts+'\\outcome-'+entry.nonce+'.json']])files[file]=entry.files[name];
  }
  const bootstrap=String.raw`$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$fixtureInput=[Console]::In.ReadToEnd()|ConvertFrom-Json
$requests=$fixtureInput.requests;$responses=$fixtureInput.responses;$stageRoot=$fixtureInput.stageRoot;$receipts=$fixtureInput.receipts;$v2=$fixtureInput.v2
$nodeId=[Environment]::MachineName;$controllerSid=$fixtureInput.controllerSid;$repository=$fixtureInput.repository;$heads=@($fixtureInput.heads);$claimId=$fixtureInput.claimId;$beforeExecutionEpoch=$fixtureInput.beforeExecutionEpoch;$legacy=$true
function Hold-Parents([string]$file){}
function Listing(){return @($fixtureInput.requestPaths)}
function Read-Fixed([string]$file,[int]$max){
 $property=$fixtureInput.files.PSObject.Properties[$file]
 $encoded=if($null -ne $property){$property.Value}elseif($file.StartsWith($v2+'\batch-claims\',[StringComparison]::OrdinalIgnoreCase)){$fixtureInput.batchRecord}else{throw 'FIXTURE_FILE_MISSING'}
 $bytes=[Convert]::FromBase64String($encoded);if($bytes.Length -gt $max){throw 'FIXTURE_FILE_TOO_LARGE'};return ,$bytes
}
. ([ScriptBlock]::Create($fixtureInput.functions))
& ([ScriptBlock]::Create($fixtureInput.legacyBranch))`;
  const operation=promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-Command',bootstrap],
   {windowsHide:true,maxBuffer:1024*1024});
  operation.child.stdin.end(JSON.stringify({requests,responses,stageRoot,receipts,v2,files,requestPaths,functions,legacyBranch,
   controllerSid:sid,...f.input,batchRecord:Object.values(f.entry.batchClaims)[0]}));
  const packet=JSON.parse((await operation).stdout),port=createFixtureWindowsIndependentSupervisor({controllerSid:sid,nodeId:os.hostname(),readBundle:async()=>packet});
  const result=await port.readLegacyControllerStopBundles(f.input);
  assert.equal(result.complete,false,field);assert.equal(result.executions.length,1,field);assert.ok(result.pending.length>0,field);
 }
});
