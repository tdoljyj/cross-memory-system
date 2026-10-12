import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export function verifyWindowsProtection(report) {
  assert.ok(report && report.schema==='clued.windows-hook-protection/1', 'Windows protection is unavailable');
  assert.equal(report.runner_is_administrator,false,'An administrator runner can replace its pre-job protection');
  assert.ok(Array.isArray(report.targets)&&report.targets.length===2,'Windows protection targets are unavailable');
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
  assert.ok(Array.isArray(report.targets)&&report.targets.length===2,'Installed protection targets are unavailable');
  for(const target of report.targets){
    assert.equal(target.uid,0,'Installed hook must be administrator-owned');
    assert.ok(Number.isInteger(target.mode),'Installed hook permissions are unavailable');
    assert.equal(target.mode&0o022,0,'Installed hook must not be writable by other users');
  }
  return {verified:true,method:'current_posix_owner_mode_and_runner_uid'};
}

function readWindowsProtection(){
  const script=String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$runnerOwnerSids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })
$trusted = @('S-1-5-18','S-1-5-32-544')
# Include actual local Administrator members, never caller-supplied owners.
$trusted += @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value })
$writeMask = 0xD0156
$targets = @()
foreach ($target in @('C:\ProgramData\CluedRunnerHook','C:\ProgramData\CluedRunnerHook\clued-runner-job-started.mjs')) {
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected hook protection target.' }
  $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $untrustedWrites = 0
  $runnerWrites = 0
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if (([int]$ace.FileSystemRights -band $writeMask) -eq 0) { continue }
    $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
    if ($trusted -notcontains $sid.Value) { $untrustedWrites++ }
    if ($identity.User.Value -eq $sid.Value -or $principal.IsInRole($sid)) { $runnerWrites++ }
  }
  # An owner has implicit WRITE_DAC even without a writable Allow ACE.
  # Include disabled token groups here conservatively, so a filtered admin
  # token cannot certify its own administrator-owned protection.
  $targets += [ordered]@{ owner_is_administrator=($trusted -contains $ownerSid);runner_owns_target=($runnerOwnerSids -contains $ownerSid);untrusted_write_aces=$untrustedWrites;runner_write_aces=$runnerWrites }
}
[ordered]@{schema='clued.windows-hook-protection/1';runner_is_administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);targets=$targets} | ConvertTo-Json -Depth 4 -Compress
`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined,'Windows protection inspection is unavailable');
  assert.equal(result.status,0,'Windows protection inspection failed');
  let report;try{report=JSON.parse(result.stdout);}catch{throw new Error('Windows protection report is unavailable');}
  return verifyWindowsProtection(report);
}

// Isolated observations exercise the exact protected installed code. They
// complement, and cannot replace, actual PR/dispatch job and revocation proof.
const accepted = new Map([
  ['6627684cf0bd92f11085aaa858875381051249456a35f747660f07eaf304abe0', '443a589d0696761104b5bd3c962bf57b34b1ab3f'],
  ['7c35368f8e50f5cd3e73e9edfc8bfe137dc91a3ef66fbdd3e5839bea6226992d', '4f2951a66f995a4a61088f1196399a45521315d3'],
]);
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
  assert.equal(fs.lstatSync(parent).isSymbolicLink(), false, 'Redirected hook directory is refused');
  if(process.platform==='win32'){
    readWindowsProtection();
  }else{
    const targets=[parent,hookPath].map(target=>{
      const stat=fs.statSync(target);
      return {uid:stat.uid,mode:stat.mode};
    });
    verifyPosixProtection({runner_uid:process.getuid?.(),targets});
  }
}
const digest = () => createHash('sha256').update(fs.readFileSync(hookPath)).digest('hex');
const before = digest();
assert.ok(accepted.has(before), 'The hook is not an accepted exact source');
const hook = await import(pathToFileURL(hookPath).href);
assert.equal(hook.HOOK_VERSION, 'work-handover-current-epoch-proxy-v1');
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
  node:process.version,uid:process.getuid?.()??null,source_commit:accepted.get(before),source_sha256:before,
  hook_version:hook.HOOK_VERSION,protection_verified:!candidate,cases,live_pr_qualified:false,live_dispatch_qualified:false,
  external_revocation_qualified:false,activation_authorized:false,observed_at:new Date().toISOString()}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
