import assert from 'node:assert/strict';
export const COMPONENT_VERSION = "1.0.0";
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export function verifyWindowsProtection(report) {
  assert.ok(report && report.schema==='clued.windows-hook-protection/1', 'Windows protection is unavailable');
  assert.equal(report.runner_is_administrator,false,'An administrator runner can replace its pre-job protection');
  assert.ok(Array.isArray(report.targets)&&report.targets.length===4,'Windows protection targets or their ancestors are unavailable');
  for(const target of report.targets){
    assert.equal(target.owner_is_administrator,true,'Windows hook owner can change its protection');
    assert.equal(target.runner_owns_target,false,'Windows runner owns its hook and can change its permissions');
    assert.equal(target.untrusted_write_aces,0,'Windows hook grants write or permission changes to an untrusted principal');
    assert.equal(target.runner_write_aces,0,'Windows runner can change its own hook protection');
  }
  return {verified:true,method:'current_windows_owner_dacl_and_runner_token'};
}

export function verifyPosixProtection(report) {
  assert.ok(Number.isInteger(report?.runner_uid)&&report.runner_uid>0,'A privileged or unknown runner can replace its pre-job protection');
  assert.ok(Number.isInteger(report.runner_euid)&&report.runner_euid>0,'An effectively privileged or unknown runner can replace its pre-job protection');
  assert.ok(Array.isArray(report.targets)&&report.targets.length===4,'Installed protection targets or their ancestors are unavailable');
  for(const target of report.targets){
    assert.equal(target.uid,0,'Installed hook must be administrator-owned');
    assert.ok(Number.isInteger(target.mode),'Installed hook permissions are unavailable');
    assert.equal(target.mode&0o022,0,'Installed hook must not be writable by other users');
  }
  return {verified:true,method:'current_posix_owner_mode_and_runner_uid'};
}

const WINDOWS_TARGETS=Object.freeze(['C:\\','C:\\ProgramData','C:\\ProgramData\\CluedRunnerHook',
  'C:\\ProgramData\\CluedRunnerHook\\clued-runner-job-started.mjs']);
const TRUSTED_INSTALLER_SID='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const sid=value=>typeof value==='string'&&/^S-[0-9]+(?:-[0-9]+)+$/.test(value);
export function classifyWindowsProtection(native){
  assert.equal(native?.schema,'clued.windows-hook-native-protection/1','Windows native protection is unavailable');
  assert.equal(typeof native.runner_is_administrator,'boolean');
  assert.ok(sid(native.runner_sid));
  for(const values of [native.runner_group_sids,native.administrator_member_sids])
    assert.ok(Array.isArray(values)&&values.every(sid),'Windows token/member identities unavailable');
  assert.ok(Array.isArray(native.targets)&&native.targets.length===4);
  const runnerSids=new Set([native.runner_sid,...native.runner_group_sids]);
  const administrators=new Set(['S-1-5-18','S-1-5-32-544',...native.administrator_member_sids]);
  const targets=native.targets.map((target,index)=>{
    assert.equal(target?.path,WINDOWS_TARGETS[index],'Windows target path/order differs');
    assert.equal(target.reparse,false,'Redirected hook protection target');
    assert.equal(target.dacl_present,true,'Windows DACL presence is unavailable');
    assert.equal(target.dacl_non_null,true,'A null DACL does not protect the hook');
    assert.ok(sid(target.owner_sid)&&Array.isArray(target.aces));
    // The exact OS service is trusted only on the fixed system ancestors.
    // The hook directory/file still require administrator owners.
    const trusted=new Set(administrators);
    if(index<2)trusted.add(TRUSTED_INSTALLER_SID);
    const mask=index<2?0xD0040:0xD0156;
    let untrustedWrites=0,runnerWrites=0;
    for(const ace of target.aces){
      assert.ok(sid(ace?.sid)&&typeof ace.allow==='boolean'&&typeof ace.inherit_only==='boolean'&&
        Number.isInteger(ace.rights)&&ace.rights>=-2147483648&&ace.rights<=2147483647,'Windows ACE data unavailable');
      assert.ok((ace.ace_type===0||ace.ace_type===1)&&ace.allow===(ace.ace_type===0),'Unsupported Windows ACE type');
      const dangerous=(ace.rights&mask)!==0||(ace.rights&0x50000000)!==0;
      if(!ace.allow||ace.inherit_only||!dangerous)continue;
      if(!trusted.has(ace.sid))untrustedWrites++;
      // Every token group is included conservatively, even if disabled.
      if(runnerSids.has(ace.sid))runnerWrites++;
    }
    return {owner_is_administrator:trusted.has(target.owner_sid),runner_owns_target:runnerSids.has(target.owner_sid),
      untrusted_write_aces:untrustedWrites,runner_write_aces:runnerWrites};
  });
  return verifyWindowsProtection({schema:'clued.windows-hook-protection/1',
    runner_is_administrator:native.runner_is_administrator,targets});
}

const WINDOWS_INSPECTION_STAGES=Object.freeze(["identity","administrator-members","target-item","target-acl","descriptor-construction","owner-sid","raw-ace","serialize"]);
const WINDOWS_INSPECTION_TYPES=Object.freeze(["UNKNOWN","System.Management.Automation.RuntimeException","System.Management.Automation.MethodInvocationException","System.Management.Automation.CmdletInvocationException","System.Management.Automation.ActionPreferenceStopException","System.Management.Automation.ItemNotFoundException","System.Management.Automation.PSInvalidOperationException","System.Management.Automation.ParseException","System.UnauthorizedAccessException","System.Security.SecurityException","System.ArgumentException","System.ArgumentOutOfRangeException","System.InvalidOperationException","System.NotSupportedException","System.PlatformNotSupportedException","System.IO.IOException","System.IO.FileNotFoundException","System.IO.DirectoryNotFoundException"]);
const WINDOWS_INSPECTION_CATEGORIES=Object.freeze(["UNKNOWN","NotSpecified","PermissionDenied","SecurityError","ObjectNotFound","InvalidArgument","InvalidOperation","InvalidData","InvalidType","ParserError","ReadError","OpenError","MetadataError","ResourceUnavailable","OperationStopped","NotImplemented","LimitsExceeded"]);
const WINDOWS_INSPECTION_LANGUAGES=Object.freeze(["UNKNOWN","FullLanguage","ConstrainedLanguage","RestrictedLanguage","NoLanguage"]);
const WINDOWS_INSPECTION_FIELDS=Object.freeze(["schema","status","stage","target_index","ace_index","ace_type","exception_type","error_category","language_mode","ps_major"]);
export function decodeWindowsInspectionFailure(result){
  // Never reflect native stderr, messages, environment, ACL or identities.
  if(!Number.isInteger(result?.status)||result.status<1||result.status>255||
    typeof result.stdout!=='string'||Buffer.byteLength(result.stdout,'utf8')>4096)return null;
  let value;try{value=JSON.parse(result.stdout);}catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value)||
    JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...WINDOWS_INSPECTION_FIELDS].sort())||
    value.schema!=='clued.windows-hook-inspection-failure/1'||value.status!=='inspection_failed'||
    !WINDOWS_INSPECTION_STAGES.includes(value.stage)||
    !Number.isInteger(value.target_index)||value.target_index< -1||value.target_index>3||
    !Number.isInteger(value.ace_index)||value.ace_index< -1||value.ace_index>4095||
    !Number.isInteger(value.ace_type)||value.ace_type< -1||value.ace_type>255||
    !WINDOWS_INSPECTION_TYPES.includes(value.exception_type)||
    !WINDOWS_INSPECTION_CATEGORIES.includes(value.error_category)||
    !WINDOWS_INSPECTION_LANGUAGES.includes(value.language_mode)||
    !Number.isInteger(value.ps_major)||value.ps_major<0||value.ps_major>99)return null;
  return Object.fromEntries(WINDOWS_INSPECTION_FIELDS.map(key=>[key,value[key]]));
}
export function windowsInspectionFailureMessage(result){
  const diagnostic=decodeWindowsInspectionFailure(result);
  return 'Windows protection inspection failed'+(diagnostic?' '+JSON.stringify(diagnostic):'');
}

function readWindowsProtection(){
  const script=String.raw`
$ErrorActionPreference = 'Stop'
$inspectionStage='identity';$inspectionTargetIndex=-1;$inspectionAceIndex=-1;$inspectionAceType=-1
try {
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$inspectionStage='administrator-members'
$adminMembers = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value })
$targets = @()
foreach ($target in @('C:\','C:\ProgramData','C:\ProgramData\CluedRunnerHook','C:\ProgramData\CluedRunnerHook\clued-runner-job-started.mjs')) {
  # Ancestors must not let the runner rename/delete the protected subtree,
  # delete its child, or grant those rights. Creating unrelated siblings alone
  # does not permit replacement of an existing protected child.
  $inspectionTargetIndex++;$inspectionAceIndex=-1;$inspectionAceType=-1
  $inspectionStage='target-item'
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected hook protection target.' }
  $inspectionStage='target-acl'
  $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
  $inspectionStage='descriptor-construction'
  $rawDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  $inspectionStage='owner-sid'
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $aces = @()
  $inspectionStage='raw-ace'
  foreach ($ace in $rawDescriptor.DiscretionaryAcl) {
    $inspectionAceIndex++;$inspectionAceType=[int]$ace.AceType
    if (($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -and
      $ace.AceType -ne [Security.AccessControl.AceType]::AccessDenied) -or
      $ace -isnot [Security.AccessControl.CommonAce]) { throw 'Unsupported Windows ACE type.' }
    $aces += [ordered]@{sid=$ace.SecurityIdentifier.Value;ace_type=[int]$ace.AceType;
      allow=($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed);
      inherit_only=(([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0);rights=[int]$ace.AccessMask}
  }
  # An owner has implicit WRITE_DAC even without a writable Allow ACE.
  # Include disabled token groups here conservatively, so a filtered admin
  # token cannot certify its own administrator-owned protection.
  $targets += [ordered]@{path=$target;owner_sid=$ownerSid;reparse=$false;aces=$aces;
    dacl_present=[bool]($rawDescriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent);
    dacl_non_null=($null -ne $rawDescriptor.DiscretionaryAcl)}
}
$inspectionStage='serialize'
[ordered]@{schema='clued.windows-hook-native-protection/1';runner_is_administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
  runner_sid=$identity.User.Value;runner_group_sids=@($identity.Groups | ForEach-Object { $_.Value });administrator_member_sids=$adminMembers;targets=$targets} | ConvertTo-Json -Depth 6 -Compress
} catch {
  $inspectionType=$_.Exception.GetType().FullName
  if(@('UNKNOWN','System.Management.Automation.RuntimeException','System.Management.Automation.MethodInvocationException','System.Management.Automation.CmdletInvocationException','System.Management.Automation.ActionPreferenceStopException','System.Management.Automation.ItemNotFoundException','System.Management.Automation.PSInvalidOperationException','System.Management.Automation.ParseException','System.UnauthorizedAccessException','System.Security.SecurityException','System.ArgumentException','System.ArgumentOutOfRangeException','System.InvalidOperationException','System.NotSupportedException','System.PlatformNotSupportedException','System.IO.IOException','System.IO.FileNotFoundException','System.IO.DirectoryNotFoundException') -notcontains $inspectionType){$inspectionType='UNKNOWN'}
  $inspectionCategory=[string]$_.CategoryInfo.Category
  if(@('UNKNOWN','NotSpecified','PermissionDenied','SecurityError','ObjectNotFound','InvalidArgument','InvalidOperation','InvalidData','InvalidType','ParserError','ReadError','OpenError','MetadataError','ResourceUnavailable','OperationStopped','NotImplemented','LimitsExceeded') -notcontains $inspectionCategory){$inspectionCategory='UNKNOWN'}
  $inspectionLanguage=[string]$ExecutionContext.SessionState.LanguageMode
  if(@('UNKNOWN','FullLanguage','ConstrainedLanguage','RestrictedLanguage','NoLanguage') -notcontains $inspectionLanguage){$inspectionLanguage='UNKNOWN'}
  $inspectionMajor=$PSVersionTable.PSVersion.Major
  if($inspectionMajor -isnot [int] -or $inspectionMajor -lt 1 -or $inspectionMajor -gt 99){$inspectionMajor=0}
  [ordered]@{schema='clued.windows-hook-inspection-failure/1';status='inspection_failed';stage=$inspectionStage;
    target_index=$inspectionTargetIndex;ace_index=$inspectionAceIndex;ace_type=$inspectionAceType;
    exception_type=$inspectionType;error_category=$inspectionCategory;language_mode=$inspectionLanguage;ps_major=$inspectionMajor} |
    ConvertTo-Json -Depth 3 -Compress
  exit 1
}
`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined,'Windows protection inspection is unavailable');
  if(result.status!==0)throw new Error(windowsInspectionFailureMessage(result));
  let report;try{report=JSON.parse(result.stdout);}catch{throw new Error('Windows protection report is unavailable');}
  return classifyWindowsProtection(report);
}

// Isolated observations exercise the exact protected installed code. They
// complement, and cannot replace, actual PR/dispatch job and revocation proof.

// The accepted identities are internal immutable authority, selected only by
// the exact raw hook digest. CLI/env/caller data cannot add or replace them.
export const ACCEPTED_HOOK_SOURCES = Object.freeze([
  {
    "sha256": "6627684cf0bd92f11085aaa858875381051249456a35f747660f07eaf304abe0",
    "source_commit": "443a589d0696761104b5bd3c962bf57b34b1ab3f",
    "source_path": "scripts/runner/clued-runner-job-started.mjs",
    "hook_version": "work-handover-current-epoch-proxy-v1",
    "component_version": null
  },
  {
    "sha256": "7c35368f8e50f5cd3e73e9edfc8bfe137dc91a3ef66fbdd3e5839bea6226992d",
    "source_commit": "4f2951a66f995a4a61088f1196399a45521315d3",
    "source_path": "scripts/runner/clued-runner-job-started.mjs",
    "hook_version": "work-handover-current-epoch-proxy-v1",
    "component_version": null
  },
  {
    "sha256": "e0cec3d48810a6ee934814ebc58060f40486098d7eef005237fb6e1f75a6bf0e",
    "source_commit": "31fb47dd369a2e0296ecc548ea15a4c6a0f0af2e",
    "source_path": "scripts/runner/clued-runner-job-started.work-handover-current-epoch-proxy-dispatch-v1.mjs",
    "hook_version": "work-handover-current-epoch-proxy-dispatch-v1",
    "component_version": "1.0.0"
  }
].map(record=>Object.freeze(record)));
const accepted = new Map(ACCEPTED_HOOK_SOURCES.map(record=>[record.sha256,record]));
export function acceptedHookSource(digest) {
  const record=accepted.get(digest);
  assert.ok(record,'The hook is not an accepted exact source');
  return record;
}
function readGitSourceObject(record) {
  assert.ok(ACCEPTED_HOOK_SOURCES.includes(record),'Caller-declared Source is not authority');
  const environment={...process.env,GIT_NO_LAZY_FETCH:'1'};
  const result=spawnSync('git',['show',`${record.source_commit}:${record.source_path}`],
    {cwd:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),env:environment,
      encoding:null,timeout:10000,maxBuffer:524288,windowsHide:true});
  if(result.error||result.status!==0||!Buffer.isBuffer(result.stdout))
    throw new Error('SOURCE_OBJECT_UNAVAILABLE: accepted commit/path cannot be read without fetching');
  return result.stdout;
}
// Local acceptance and independent provenance checks call the default reader
// on actual immutable Git objects. Shallow runner CLI jobs do not call it or
// silently fetch history. An injected negative fixture is never Git proof.
export function verifyAcceptedHookSource(digest,{readSource=readGitSourceObject,expectedIdentity=null,primaryBytes=null}={}) {
  const record=acceptedHookSource(digest);
  if(expectedIdentity!==null) {
    for(const [key,value] of Object.entries(expectedIdentity)) {
      assert.ok(['source_commit','source_path','hook_version','component_version'].includes(key),'Unknown Source selector');
      assert.equal(value,record[key],`Accepted Source ${key} differs`);
    }
  }
  const raw=readSource(record);
  assert.ok(Buffer.isBuffer(raw),'SOURCE_OBJECT_UNAVAILABLE: source reader did not return raw bytes');
  assert.equal(createHash('sha256').update(raw).digest('hex'),record.sha256,'Accepted Source raw digest differs');
  const text=raw.toString('utf8');
  assert.equal(/^export const HOOK_VERSION = "([^"\r\n]+)";$/m.exec(text)?.[1],record.hook_version,'Accepted Source hook version differs');
  const numeric=/^export const COMPONENT_VERSION = "([0-9.]+)";$/m.exec(text)?.[1]??null;
  assert.equal(numeric,record.component_version,'Accepted Source numeric component version differs');
  if(primaryBytes!==null) {
    assert.ok(Buffer.isBuffer(primaryBytes),'Primary distribution must be raw bytes');
    assert.deepEqual(primaryBytes,raw,'Primary distribution differs from accepted immutable Source bytes');
  }
  return Object.freeze({...record,source_git_object_verified:readSource===readGitSourceObject});
}

async function main(){
const args = process.argv.slice(2);
const candidate = args.includes('--candidate');
const value = name => { const at=args.indexOf(name); return at<0?null:args[at+1]; };
const installedPath = process.platform==='win32'
  ? 'C:\\ProgramData\\CluedRunnerHook\\clued-runner-job-started.mjs'
  : '/opt/clued-runner-hook/clued-runner-job-started.mjs';
const hookPath = path.resolve(value('--hook') ?? installedPath);
if (!candidate) assert.equal(hookPath, path.resolve(installedPath), 'Qualification requires the protected installed path');
assert.equal(fs.lstatSync(hookPath).isSymbolicLink(), false, 'Redirected hook is refused');
if (!candidate) {
  const parent=path.dirname(hookPath);
  const protectionPaths=[hookPath,parent,path.dirname(parent),path.parse(hookPath).root];
  for(const target of protectionPaths)
    assert.equal(fs.lstatSync(target).isSymbolicLink(),false,'Redirected hook directory or ancestor is refused');
  if(process.platform==='win32'){
    readWindowsProtection();
  }else{
    const targets=protectionPaths.map(target=>{
      const stat=fs.statSync(target);
      return {uid:stat.uid,mode:stat.mode};
    });
    verifyPosixProtection({runner_uid:process.getuid?.(),runner_euid:process.geteuid?.(),targets});
  }
}
const digest = () => createHash('sha256').update(fs.readFileSync(hookPath)).digest('hex');
const before = digest();
const source=acceptedHookSource(before);
const hook = await import(pathToFileURL(hookPath).href);
assert.equal(hook.HOOK_VERSION, source.hook_version);
if(source.component_version!==null)assert.equal(hook.COMPONENT_VERSION,source.component_version);
const publicConfiguration = fs.readFileSync(value('--public-config'), 'utf8');
const match=/return \{ url: "(https:\/\/[a-z0-9-]+\.supabase\.co)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(publicConfiguration);
assert.ok(match, 'Public configuration is invalid');
const rpc = match[1]+'/rest/v1/rpc/clued_work_verify_v1';
const head='b'.repeat(40), eventCreated='2026-10-04T05:00:00Z';
const environment={CLUED_RUNNER_HOOK_REPOSITORY:'o/r',CLUED_RUNNER_HOOK_TOKEN_FILE:'/qualification-token',
  CLUED_RUNNER_HOOK_ENFORCE:'true',CLUED_RUNNER_HOOK_WAIT_SECONDS:'20',GITHUB_REPOSITORY:'o/r',
  GITHUB_WORKFLOW_REF:'o/r/.github/workflows/clued-g4-database.yml@refs/pull/9/merge',
  GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/9/merge',GITHUB_SHA:'a'.repeat(40),
  GITHUB_EVENT_PATH:'/qualification-event',GITHUB_RUN_ID:'555',GITHUB_RUN_ATTEMPT:'1'};
const readFile=p=>{
  if(p==='/qualification-token')return 'isolated-readonly-fixture';
  assert.equal(p,'/qualification-event','Unexpected private file read');
  return JSON.stringify({pull_request:{number:9,base:{ref:'main'},head:{sha:head}}});
};
const cases=[];
for (const [name,status,observation,expected] of [
  ['current',200,{status:'ok',guard_required:true,epoch_current:true},'allow'],
  ['stale',200,{status:'ok',guard_required:true,epoch_current:false},'deny'],
  ['unknown',200,{status:'ok',guard_required:true,epoch_current:null},'error'],
  ['unavailable',503,null,'error'],
]) {
  let observations=0;
  const fetchImpl=async (url,init={})=>{
    url=String(url);
    let body;
    if(url===rpc){
      observations++;
      assert.deepEqual(JSON.parse(init.body),{p_token_hash:null,p_input:{action:'execution_current',repository:'o/r',
        head_sha:head,pr_ref:'o/r#9',target_branch:'main'}});
      assert.equal(init.headers.authorization,'Bearer '+match[2]);
      return {status,json:async()=>observation};
    }
    if(url.endsWith('/actions/runs/555'))body={id:555,run_attempt:1,created_at:eventCreated};
    else if(url.includes('/compare/main...'))body={files:[]};
    else if(url.includes('/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main'))
      body={type:'file',encoding:'base64',content:Buffer.from(publicConfiguration).toString('base64')};
    else throw new Error('Unqualified request path');
    return {status:200,json:async()=>body};
  };
  if(expected==='error')await assert.rejects(hook.decideWithCurrentEpoch({env:environment,fetchImpl,readFile}),
    expected==='error'&&name==='unknown'?/observation is invalid/:/epoch unavailable/);
  else assert.equal((await hook.decideWithCurrentEpoch({env:environment,fetchImpl,readFile})).allow,expected==='allow');
  assert.equal(observations,1);
  cases.push({name,outcome:'pass',observation:'isolated',expected});
}
assert.equal(digest(),before,'Hook changed during qualification');
// Exercise the real CLI entry and its proxy child with no credentials. Main's
// own event performs no requests; repository mismatch refuses before token IO.
const cliEnv={...environment,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',
  GITHUB_WORKFLOW_REF:'o/r/.github/workflows/check.yml@refs/heads/main',
  HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9'};
for(const [name,overrides,expectedStatus,pattern] of [
  ['proxy_cli_allow',{},0,/ALLOW push on main/],
  ['proxy_cli_refuse',{GITHUB_REPOSITORY:'other/repo'},1,/REFUSE repository other\/repo is not o\/r/],
]){
  const result=spawnSync(process.execPath,[hookPath],{env:{...cliEnv,...overrides},encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined,'Proxy child did not complete');
  assert.equal(result.status,expectedStatus,'Proxy child verdict changed');
  assert.match(result.stdout,pattern);
  cases.push({name,outcome:'pass',observation:'isolated_cli',expected:expectedStatus===0?'allow':'deny'});
}
assert.equal(digest(),before,'Hook changed during CLI qualification');
console.log(JSON.stringify({schema:'clued.installed-handover-hook-qualification/1',status:'pass',
  boundary:candidate?'source_candidate':'protected_installed_code',machine:os.hostname(),platform:process.platform,
  node:process.version,uid:process.getuid?.()??null,source_commit:source.source_commit,source_path:source.source_path,source_sha256:before,
  hook_version:hook.HOOK_VERSION,protection_verified:!candidate,cases,live_pr_qualified:false,live_dispatch_qualified:false,
  external_revocation_qualified:false,activation_authorized:false,observed_at:new Date().toISOString()}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
