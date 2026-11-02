import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {COMPONENT_VERSION as QUALIFIER_COMPONENT_VERSION,ACCEPTED_HOOK_SOURCES,acceptedHookSource,verifyAcceptedHookSource,verifyWindowsProtection,verifyPosixProtection,classifyWindowsProtection,decodeWindowsInspectionFailure,windowsInspectionFailureMessage} from './qualify-work-handover.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(directory,'../..');
const probe=path.join(directory,'qualify-work-handover.mjs');
const configuration=path.join(repository,'apps/clued-cloud/app/supabase-public-config.ts');
const execute=args=>spawnSync(process.execPath,[probe,...args,'--public-config',configuration],
  {encoding:'utf8',timeout:20000});

test('exact-source simulation preserves six verdicts and never certifies live qualification',()=>{
  const result=execute(['--candidate','--hook',path.join(directory,'clued-runner-job-started.work-handover-current-epoch-proxy-dispatch-v1.mjs')]);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.boundary,'source_candidate');
  assert.equal(report.protection_verified,false);
  assert.equal(report.cases.length,6);
  assert.ok(report.cases.every(x=>x.outcome==='pass'));
  for(const key of ['live_pr_qualified','live_dispatch_qualified','external_revocation_qualified','activation_authorized'])
    assert.equal(report[key],false);
});
test('Native successor candidate cannot inherit accepted Source authority from the distribution path',()=>{
  const result=execute(['--candidate','--hook',path.join(directory,'clued-runner-job-started.mjs')]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/not an accepted exact source/);
});
test('Windows current protection refuses writable principals, writable runner, non-admin owner or unavailable data',()=>{
  const safe={schema:'clued.windows-hook-protection/1',runner_is_administrator:false,
    targets:Array.from({length:4},()=>({owner_is_administrator:true,runner_owns_target:false,untrusted_write_aces:0,runner_write_aces:0}))};
  assert.equal(verifyWindowsProtection(safe).verified,true);
  for(const targetIndex of [0,1,2,3]){
    for(const [field,value] of [['owner_is_administrator',false],['runner_owns_target',true],['untrusted_write_aces',1],['runner_write_aces',1]]){
      const changed=structuredClone(safe);changed.targets[targetIndex][field]=value;
      assert.throws(()=>verifyWindowsProtection(changed));
    }
  }
  assert.throws(()=>verifyWindowsProtection({...safe,runner_is_administrator:true}));
  for(const unavailable of [null,{}, {...safe,targets:[]}, {...safe,targets:[{} ,{}]}])
    assert.throws(()=>verifyWindowsProtection(unavailable));
});
const TI='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const OTHER_SERVICE='S-1-5-80-1-2-3-4-5',RUNNER='S-1-5-21-1-2-3-1001',ADMIN='S-1-5-21-1-2-3-1000';
const nativeWindows=()=>({
  schema:'clued.windows-hook-native-protection/1',runner_is_administrator:false,runner_sid:RUNNER,
  runner_group_sids:['S-1-5-32-545','S-1-5-11'],administrator_member_sids:[ADMIN],
  targets:['C:\\','C:\\ProgramData','C:\\ProgramData\\CluedRunnerHook',
    'C:\\ProgramData\\CluedRunnerHook\\clued-runner-job-started.mjs'].map((path,index)=>({
      path,reparse:false,dacl_present:true,dacl_non_null:true,owner_sid:index<2?TI:ADMIN,aces:[
        {sid:index<2?TI:'S-1-5-32-544',ace_type:0,allow:true,inherit_only:false,rights:0x1f01ff},
        {sid:RUNNER,ace_type:0,allow:true,inherit_only:false,rights:0x1200a9},
      ]})),
});
test('raw Windows SID classification trusts exact OS service only on fixed system ancestors',()=>{
  const original=nativeWindows();assert.equal(classifyWindowsProtection(original).verified,true);
  for(const index of [0,1]){
    const safe=structuredClone(original);safe.targets[index].owner_sid='S-1-5-18';
    assert.equal(classifyWindowsProtection(safe).verified,true);
  }
  for(const index of [0,1,2,3]){
    const bad=structuredClone(original);bad.targets[index].owner_sid=OTHER_SERVICE;
    assert.throws(()=>classifyWindowsProtection(bad));
  }
  for(const index of [2,3]){
    for(const field of ['owner','ace']){
      const bad=structuredClone(original);
      if(field==='owner')bad.targets[index].owner_sid=TI;
      else bad.targets[index].aces.push({sid:TI,ace_type:0,allow:true,inherit_only:false,rights:0x1f01ff});
      assert.throws(()=>classifyWindowsProtection(bad));
    }
  }
});
test('raw Windows classification preserves token ownership and dangerous ACE refusal',()=>{
  const original=nativeWindows();
  for(const group of [TI,ADMIN,'S-1-5-32-544']){
    const bad=structuredClone(original);bad.runner_group_sids.push(group);
    assert.throws(()=>classifyWindowsProtection(bad),'even disabled owner/ACE groups remain denied');
  }
  assert.throws(()=>classifyWindowsProtection({...original,runner_is_administrator:true}));
  for(const index of [0,1,2,3]){
    for(const principal of [RUNNER,OTHER_SERVICE,'S-1-1-0']){
      for(const right of [0x1f01ff,0x10000000,0x40000000]){
        const bad=structuredClone(original);
        bad.targets[index].aces.push({sid:principal,ace_type:0,allow:true,inherit_only:false,rights:right});
        assert.throws(()=>classifyWindowsProtection(bad));
      }
    }
    const own=structuredClone(original);own.targets[index].owner_sid=RUNNER;
    assert.throws(()=>classifyWindowsProtection(own));
  }
  // Creating unrelated siblings cannot replace an already protected child.
  for(const index of [0,1]){
    const safe=structuredClone(original);
    safe.targets[index].aces.push({sid:RUNNER,ace_type:0,allow:true,inherit_only:false,rights:0x116});
    safe.targets[index].aces.push({sid:RUNNER,ace_type:0,allow:true,inherit_only:true,rights:0x1f01ff});
    safe.targets[index].aces.push({sid:RUNNER,ace_type:1,allow:false,inherit_only:false,rights:0x1f01ff});
    assert.equal(classifyWindowsProtection(safe).verified,true);
    for(const right of [0x40,0x10000,0x40000,0x80000]){
      const bad=structuredClone(safe);
      bad.targets[index].aces.push({sid:RUNNER,ace_type:0,allow:true,inherit_only:false,rights:right});
      assert.throws(()=>classifyWindowsProtection(bad));
    }
  }
});
test('raw Windows report refuses redirected, missing, duplicate or malformed observations',()=>{
  const original=nativeWindows();
  for(const index of [0,1,2,3]){
    for(const [key,value] of [['reparse',true],['reparse',undefined],['dacl_present',false],['dacl_present',undefined],
      ['dacl_non_null',false],['dacl_non_null',undefined],['owner_sid',undefined],['owner_sid','bad'],
      ['aces',undefined],['path','C:\\Other']]){
      const bad=structuredClone(original);bad.targets[index][key]=value;
      assert.throws(()=>classifyWindowsProtection(bad));
    }
    for(const [key,value] of [['ace_type',undefined],['ace_type',9],['sid',undefined],['rights',NaN],['rights',undefined],['rights',2**32],
      ['allow',undefined],['inherit_only',undefined]]){
      const bad=structuredClone(original);bad.targets[index].aces[0][key]=value;
      assert.throws(()=>classifyWindowsProtection(bad));
    }
  }
  const duplicate=structuredClone(original);duplicate.targets[1]=duplicate.targets[0];
  assert.throws(()=>classifyWindowsProtection(duplicate));
  for(const key of ['runner_sid','runner_group_sids','administrator_member_sids','runner_is_administrator']){
    const bad=structuredClone(original);delete bad[key];assert.throws(()=>classifyWindowsProtection(bad));
  }
  assert.throws(()=>classifyWindowsProtection({...original,targets:original.targets.slice(1)}));
});

test('POSIX protection refuses real or effective root and writable code or ancestors',()=>{
  const safe={runner_uid:1001,runner_euid:1001,targets:[{uid:0,mode:0o644},{uid:0,mode:0o755},{uid:0,mode:0o755},{uid:0,mode:0o755}]};
  assert.equal(verifyPosixProtection(safe).verified,true);
  for(const field of ['runner_uid','runner_euid'])
    for(const value of [0,undefined,null,-1,NaN])
      assert.throws(()=>verifyPosixProtection({...safe,[field]:value}));
  for(const targetIndex of [0,1,2,3]){
    for(const [field,value] of [['uid',1001],['mode',0o775],['mode',0o777],['mode',undefined]]){
      const changed=structuredClone(safe);changed.targets[targetIndex][field]=value;
      assert.throws(()=>verifyPosixProtection(changed));
    }
  }
});
test('an accepted repository copy cannot pretend to be the protected installed path',()=>{
  const result=execute(['--hook',path.join(directory,'clued-runner-job-started.mjs')]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/protected installed path/);
});
test('unaccepted code is rejected before import and cannot run a supplied program',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'clued-handover-qualification-'));
  try{
    const supplied=path.join(temporary,'unaccepted.mjs');
    fs.writeFileSync(supplied,'process.stdout.write("UNSAFE_PROGRAM_EXECUTED");');
    const result=execute(['--candidate','--hook',supplied]);
    assert.notEqual(result.status,0);
    assert.equal(result.stdout.includes('UNSAFE_PROGRAM_EXECUTED'),false);
    assert.match(result.stderr,/accepted exact source/);
  }finally{
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(temporary,{recursive:true});
  }
});

const diagnosticFixture=()=>({schema:'clued.windows-hook-inspection-failure/1',status:'inspection_failed',
  stage:'raw-ace',target_index:0,ace_index:2,ace_type:9,
  exception_type:'System.Management.Automation.RuntimeException',error_category:'OperationStopped',
  language_mode:'FullLanguage',ps_major:5});
const diagnosticResult=value=>({status:1,stdout:JSON.stringify(value),stderr:'PRIVATE_RAW_STDERR_CANARY'});
test('native inspection failure preserves only exact typed public diagnostic fields',()=>{
  const fixture=diagnosticFixture(),result=diagnosticResult(fixture);
  assert.deepEqual(decodeWindowsInspectionFailure(result),fixture);
  assert.match(windowsInspectionFailureMessage(result),/Windows protection inspection failed/);
  assert.ok(!windowsInspectionFailureMessage(result).includes(result.stderr));
  for(const stage of ["identity","administrator-members","target-item","target-acl","descriptor-construction","owner-sid","raw-ace","serialize"])
    assert.equal(decodeWindowsInspectionFailure(diagnosticResult({...fixture,stage})).stage,stage);
  for(const index of [-1,0,1,2,3])
    assert.equal(decodeWindowsInspectionFailure(diagnosticResult({...fixture,target_index:index})).target_index,index);
  for(const exception_type of ["UNKNOWN","System.Management.Automation.RuntimeException","System.Management.Automation.MethodInvocationException","System.Management.Automation.CmdletInvocationException","System.Management.Automation.ActionPreferenceStopException","System.Management.Automation.ItemNotFoundException","System.Management.Automation.PSInvalidOperationException","System.Management.Automation.ParseException","System.UnauthorizedAccessException","System.Security.SecurityException","System.ArgumentException","System.ArgumentOutOfRangeException","System.InvalidOperationException","System.NotSupportedException","System.PlatformNotSupportedException","System.IO.IOException","System.IO.FileNotFoundException","System.IO.DirectoryNotFoundException"])
    assert.equal(decodeWindowsInspectionFailure(diagnosticResult({...fixture,exception_type})).exception_type,exception_type);
});
test('native diagnostic rejects missing, extra, wrong-type, forged status and out-of-range observations',()=>{
  const fixture=diagnosticFixture();
  for(const key of Object.keys(fixture)){
    const missing={...fixture};delete missing[key];assert.equal(decodeWindowsInspectionFailure(diagnosticResult(missing)),null);
  }
  for(const [key,value] of [['schema','other'],['status','pass'],['stage','PRIVATE_STAGE_CANARY'],
    ['target_index',4],['target_index',-2],['target_index','0'],['ace_index',4096],['ace_index',-2],
    ['ace_type',256],['ace_type',-2],['exception_type','PrivateCredentialException'],
    ['error_category','PRIVATE_CATEGORY_CANARY'],['language_mode','OTHER'],['ps_major',100],['ps_major','5']]){
    assert.equal(decodeWindowsInspectionFailure(diagnosticResult({...fixture,[key]:value})),null);
  }
  for(const extra of ['message','stack','stderr','owner_sid','environment','file_content','__proto__']){
    const bad=JSON.parse(JSON.stringify(fixture));Object.defineProperty(bad,extra,{value:'PRIVATE_FIELD_CANARY',enumerable:true});
    const result=diagnosticResult(bad);assert.equal(decodeWindowsInspectionFailure(result),null);
    assert.equal(windowsInspectionFailureMessage(result),'Windows protection inspection failed');
  }
  for(const status of [0,null,-1,256,'1'])
    assert.equal(decodeWindowsInspectionFailure({...diagnosticResult(fixture),status}),null);
  for(const stdout of ['PRIVATE_OUTPUT_CANARY',JSON.stringify(fixture)+' junk',JSON.stringify([fixture]),'null','x'.repeat(4097)]){
    const result={status:1,stdout,stderr:'PRIVATE_RAW_STDERR_CANARY'};
    assert.equal(decodeWindowsInspectionFailure(result),null);
    assert.equal(windowsInspectionFailureMessage(result),'Windows protection inspection failed');
  }
  assert.throws(()=>classifyWindowsProtection(fixture),'even a status-zero forged failure cannot certify protection');
});

test('PowerShell native flag expression handles every legal ACE flag without reading resources',
  {skip:process.platform!=='win32'},()=>{
  const source=fs.readFileSync(probe,'utf8');
  const inherit=/inherit_only=(.+);rights=\[int\]\$ace.AccessMask/.exec(source)?.[1];
  const dacl=/dacl_present=(.+);/.exec(source)?.[1];
  assert.ok(inherit&&dacl,'Native flag expressions are unavailable');
  const script=String.raw`
$ErrorActionPreference='Stop'
$rows=@()
for($value=0;$value -le 223;$value++) {
  # Bit 0x20 is not a defined AceFlags flag.
  if(($value -band 32) -ne 0){continue}
  $ace=[pscustomobject]@{AceFlags=[Security.AccessControl.AceFlags]$value}
  $old=$null;$oldException=$null
  try {$old=[bool]($ace.AceFlags -band [Security.AccessControl.AceFlags]::InheritOnly)}
  catch {$oldException=$_.Exception.GetType().FullName}
  $observed=INHERIT_EXPRESSION
  $rows+=[ordered]@{kind='AceFlags';value=$value;old=$old;old_exception=$oldException;
    observed=$observed;observed_is_boolean=($observed -is [bool]);expected=(($value -band 8) -ne 0)}
}
foreach($value in @(0,4,32768,32772,1,5,16,20)) {
  $rawDescriptor=[pscustomobject]@{ControlFlags=[Security.AccessControl.ControlFlags]$value}
  $observed=DACL_EXPRESSION
  $rows+=[ordered]@{kind='ControlFlags';value=$value;observed=$observed;
    observed_is_boolean=($observed -is [bool]);expected=(($value -band 4) -ne 0)}
}
[ordered]@{ps_major=$PSVersionTable.PSVersion.Major;resource_reads=0;rows=$rows} |
  ConvertTo-Json -Depth 4 -Compress
`.replace('INHERIT_EXPRESSION',inherit).replace('DACL_EXPRESSION',dacl);
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.ps_major,5,'The native collector uses Windows PowerShell 5');
  assert.equal(report.resource_reads,0);
  assert.equal(report.rows.filter(row=>row.kind==='AceFlags').length,128);
  assert.equal(report.rows.filter(row=>row.kind==='ControlFlags').length,8);
  for(const row of report.rows){
    assert.equal(row.observed_is_boolean,true);
    assert.equal(row.observed,row.expected,row.kind+':'+row.value);
    if(row.kind==='AceFlags'){
      assert.equal(row.old,null);
      assert.equal(row.old_exception,'System.InvalidCastException',String(row.value));
    }
  }
});

test('accepted Source identities and returned records are immutable and cannot come from a caller map',()=>{
  assert.equal(QUALIFIER_COMPONENT_VERSION,'1.0.0');
  assert.equal(ACCEPTED_HOOK_SOURCES.length,3);
  assert.ok(Object.isFrozen(ACCEPTED_HOOK_SOURCES));
  for(const source of ACCEPTED_HOOK_SOURCES){
    assert.ok(Object.isFrozen(source));
    assert.equal(acceptedHookSource(source.sha256),source);
  }
  assert.throws(()=>ACCEPTED_HOOK_SOURCES.push({}));
  assert.throws(()=>acceptedHookSource('0'.repeat(64)),/accepted exact source/);
});
test('actual accepted Git commit:path objects prove all old and new Source bytes and declared versions',()=>{
  for(const source of ACCEPTED_HOOK_SOURCES){
    const primaryBytes=source.component_version===null?null:fs.readFileSync(path.join(repository,source.source_path));
    const proof=verifyAcceptedHookSource(source.sha256,{primaryBytes});
    assert.equal(proof.source_git_object_verified,true);
    assert.equal(proof.source_commit,source.source_commit);
    assert.equal(proof.source_path,source.source_path);
    assert.ok(Object.isFrozen(proof));
  }
});
test('Source selector mismatches refuse without accepting a caller-declared map or reading substituted paths',()=>{
  const current=ACCEPTED_HOOK_SOURCES.find(source=>source.component_version==='1.0.0');
  for(const expectedIdentity of [{source_commit:ACCEPTED_HOOK_SOURCES[0].source_commit},
    {source_path:'scripts/runner/clued-runner-job-started.mjs'},
    {hook_version:'work-handover-current-epoch-proxy-v1'},{component_version:'9.0.0'}]){
    let reads=0;
    assert.throws(()=>verifyAcceptedHookSource(current.sha256,{expectedIdentity,readSource:()=>{reads++;throw new Error('SHOULD_NOT_READ');}}),/Accepted Source .* differs/);
    assert.equal(reads,0);
  }
  assert.throws(()=>verifyAcceptedHookSource(current.sha256,{expectedIdentity:{source_map:{}}}),/Unknown Source selector/);
});
test('missing Source objects stay unavailable; changed source bytes, descriptor and CRLF primary copies refuse',()=>{
  const current=ACCEPTED_HOOK_SOURCES.find(source=>source.component_version==='1.0.0');
  assert.throws(()=>verifyAcceptedHookSource(current.sha256,{readSource:()=>{throw new Error('SOURCE_OBJECT_UNAVAILABLE');}}),/SOURCE_OBJECT_UNAVAILABLE/);
  const raw=fs.readFileSync(path.join(repository,current.source_path));
  assert.throws(()=>verifyAcceptedHookSource(current.sha256,{readSource:()=>Buffer.concat([raw,Buffer.from('\n')])}),/raw digest differs/);
  assert.throws(()=>verifyAcceptedHookSource(current.sha256,{readSource:()=>raw,primaryBytes:Buffer.from(raw.toString().replaceAll('\n','\r\n'))}),/Primary distribution differs/);
  const fixture=verifyAcceptedHookSource(current.sha256,{readSource:()=>raw});
  assert.equal(fixture.source_git_object_verified,false,'Injected bytes cannot establish actual Git provenance');
});
test('both historical accepted hooks still execute the unchanged six candidate verdicts',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'clued-handover-legacy-source-'));
  try{
    for(const source of ACCEPTED_HOOK_SOURCES.filter(source=>source.component_version===null)){
      const proof=verifyAcceptedHookSource(source.sha256);
      assert.equal(proof.source_git_object_verified,true);
      const raw=spawnSync('git',['show',`${source.source_commit}:${source.source_path}`],{cwd:repository,env:{...process.env,GIT_NO_LAZY_FETCH:'1'},encoding:null,timeout:10000,maxBuffer:524288});
      assert.equal(raw.status,0,'SOURCE_OBJECT_UNAVAILABLE');
      const filename=path.join(temporary,source.sha256+'.mjs');fs.writeFileSync(filename,raw.stdout);
      const result=execute(['--candidate','--hook',filename]);
      assert.equal(result.status,0,result.stderr);
      const report=JSON.parse(result.stdout);
      assert.equal(report.source_commit,source.source_commit);assert.equal(report.source_path,source.source_path);
      assert.equal(report.hook_version,source.hook_version);assert.equal(report.cases.length,6);
      assert.equal(report.protection_verified,false);assert.equal(report.live_pr_qualified,false);assert.equal(report.live_dispatch_qualified,false);
    }
  }finally{
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temporary,{recursive:true});
  }
});
