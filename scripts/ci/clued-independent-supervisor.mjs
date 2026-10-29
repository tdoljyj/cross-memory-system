// Read-only Windows supervisor port. This collects the existing broker/helper
// observations; only the separate observer decides whether they prove stop.
// The production reader accepts no caller path, secret, process ID or ACL bypass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { WIN_ROOT, WIN_RESIDENT, WIN_STAGE, STATE_V2, RESIDENT_SID, NODE_EXE, GENERIC_HELPER, ENTRY_V2, REPO, stageByNumber, stageJobRolesValid } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/layout.mjs';
import { validatePlanV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-package.mjs';
import { validateJobV2, batchRefV2, sameBatchV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { validateBatchClaimRecord } from '../../work/actions-hosted-migration/independent-ci-v1/src/batch-claim-v2.mjs';
import { makeIndependentPublicationIdentity } from './clued-independent-publication-identity.mjs';
import { independentControllerId } from './clued-independent-publication-port.mjs';

export const COMPONENT_VERSION = '1.0.0';
const SID = /^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FIELDS = ['planBytes','jobsBytes','requestBytes','responseBytes','receiptBytes','outcomeBytes'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const matches = (value,pattern) => typeof value==='string' && pattern.exec(value)?.[0]===value;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const NODE_ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const limits = {planBytes:1048576,jobsBytes:1048576,requestBytes:8192,responseBytes:8192,receiptBytes:65536,outcomeBytes:1048576};
function queryOf(witness, controllerSid) {
  if (!matches(controllerSid,SID) || witness?.controllerSid!==controllerSid
    || witness?.contract!=='clued.independent-ci.controller-supervision/1'
    || !matches(witness?.nonce,/^[0-9a-f]{32}$/) || !matches(witness?.configSha256,/^[0-9a-f]{64}$/)
    || !Number.isSafeInteger(witness?.plan?.stage) || witness.plan.stage<1 || witness.plan.stage>11) fail('independent_supervisor_witness_invalid');
  return {nonce:witness.nonce,configSha256:witness.configSha256,stage:witness.plan.stage,controllerSid};
}
function decodeReply(reply, query) {
  if (!reply || Object.keys(reply).sort().join('|')!=='contract|controllerSid|files|nonce|requestId'
    || reply.contract!=='clued.independent-ci.protected-stop-bundle/1' || reply.nonce!==query.nonce
    || reply.controllerSid!==query.controllerSid || !matches(reply.requestId,UUID)
    || !reply.files || Object.keys(reply.files).sort().join('|')!==[...FIELDS].sort().join('|')) fail('independent_supervisor_bundle_unconfirmed');
  const result={requestId:reply.requestId};
  for(const field of FIELDS){
    const encoded=reply.files[field];
    if(typeof encoded!=='string'||!encoded.length||encoded.length>Math.ceil(limits[field]/3)*4) fail('independent_supervisor_bundle_unconfirmed');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length<2||bytes.length>limits[field]||bytes.toString('base64')!==encoded)fail('independent_supervisor_bundle_unconfirmed');
    result[field]=bytes;
  }
  return Object.freeze(result);
}
function maintenanceQueryOf(input,controllerSid){
  const fields=['nonce','configSha256','stage','controllerSid','nodeId','runnerService','nodePid'];
  if(!input||Object.keys(input).sort().join('|')!==fields.sort().join('|')||input.controllerSid!==controllerSid
    ||!matches(input.nonce,/^[a-f0-9]{32}$/)||!matches(input.configSha256,/^[a-f0-9]{64}$/)||input.stage!==12
    ||!matches(input.nodeId,NODE_ID)
    ||!matches(input.runnerService,/^actions\.runner\.tdoljyj-cross-memory-system\.[A-Za-z0-9_.-]{1,150}$/)
    ||!Number.isSafeInteger(input.nodePid)||input.nodePid<1||input.nodePid>4294967295)fail('independent_maintenance_window_input_invalid');
  return Object.freeze({...input,mode:'maintenance'});
}
function legacyQueryOf(input,controllerSid,nodeId){
  const fields=['repository','heads','claimId','beforeExecutionEpoch'];
  if(!matches(nodeId,NODE_ID)||!input||Object.keys(input).sort().join('|')!==fields.sort().join('|')
    ||input.repository!==REPO||!Array.isArray(input.heads)||!input.heads.length||input.heads.length>1000
    ||new Set(input.heads).size!==input.heads.length||input.heads.some(h=>!matches(h,/^[a-f0-9]{40}$/))
    ||!matches(input.claimId,UUID)||!Number.isSafeInteger(input.beforeExecutionEpoch)||input.beforeExecutionEpoch<1)fail('independent_legacy_inventory_input_invalid');
  return Object.freeze({...input,heads:[...input.heads],controllerSid,nodeId,mode:'legacy',nonce:'0'.repeat(32),configSha256:'0'.repeat(64),stage:0});
}
function legacyReplyOf(reply,query){
  const fields=['contract','controllerSid','nodeId','repository','heads','claimId','beforeExecutionEpoch','entries','pending'];
  if(!reply||Object.keys(reply).sort().join('|')!==fields.sort().join('|')||reply.contract!=='clued.independent-ci.local-legacy-stop-inventory/1'
    ||reply.controllerSid!==query.controllerSid||typeof reply.nodeId!=='string'||reply.nodeId.toLowerCase()!==query.nodeId.toLowerCase()
    ||reply.repository!==query.repository||reply.claimId!==query.claimId||reply.beforeExecutionEpoch!==query.beforeExecutionEpoch
    ||JSON.stringify(reply.heads)!==JSON.stringify(query.heads)||!Array.isArray(reply.entries)||reply.entries.length>10000
    ||!Array.isArray(reply.pending)||reply.pending.length>20000)fail('independent_legacy_inventory_unconfirmed');
  const pending=reply.pending.map(p=>{
    if(!p||Object.keys(p).sort().join('|')!=='reason|requestId'||!(p.requestId===null||matches(p.requestId,UUID))
      ||!matches(p.reason,/^[a-z][a-z0-9_]{0,79}$/))fail('independent_legacy_inventory_unconfirmed');return {...p};
  });
  const executions=[],seen=new Set();
  for(const entry of reply.entries){
    let requestId=matches(entry?.requestId,UUID)?entry.requestId:null;
    try{
      if(!entry||Object.keys(entry).sort().join('|')!=='batchClaims|configSha256|files|nonce|requestId|stage'
        ||!matches(entry.nonce,/^[a-f0-9]{32}$/)||!matches(entry.configSha256,/^[a-f0-9]{64}$/)
        ||![1,3,5,7,8,9].includes(entry.stage)||!requestId||seen.has(entry.nonce))throw Error('unidentified');
      seen.add(entry.nonce);
      const bundle=decodeReply({contract:'clued.independent-ci.protected-stop-bundle/1',controllerSid:query.controllerSid,
        nonce:entry.nonce,requestId,files:entry.files},{controllerSid:query.controllerSid,nonce:entry.nonce});
      const request=parse(bundle.requestBytes),plan=parse(bundle.planBytes),jobs=parse(bundle.jobsBytes);validatePlanV2(plan);
      if(!request||Object.keys(request).sort().join('|')!=='configSha256|contract|deadline|nonce|stage'
        ||request.contract!=='clued.independent-ci.swap-broker-request/2'||request.nonce!==entry.nonce
        ||request.configSha256!==entry.configSha256||request.stage!==entry.stage
        ||!matches(request.deadline,/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?Z$/)
        ||!Number.isFinite(Date.parse(request.deadline))
        ||new Date(Date.parse(request.deadline)).toISOString().slice(0,19)!==request.deadline.slice(0,19)
        ||plan.stage!==entry.stage||hash(bundle.planBytes)!==entry.configSha256||hash(bundle.jobsBytes)!==plan.jobSha256
        ||!Array.isArray(jobs)||!stageJobRolesValid(stageByNumber(plan.stage),jobs.map(j=>j?.role)))throw Error('unidentified');
      jobs.forEach(validateJobV2);
      if(!jobs.every(j=>sameBatchV2(j,jobs[0])&&j.sourceManifestSha256===plan.sourceManifestSha256))throw Error('unidentified');
      for(const job of jobs){
        if(job.repo!==query.repository||!query.heads.includes(job.headSha))continue;
        const encoded=entry.batchClaims?.[batchRefV2(job)];
        if(typeof encoded!=='string'||encoded.length>Math.ceil(65536/3)*4)throw Error('unidentified');
        const claimBytes=Buffer.from(encoded,'base64');if(claimBytes.length<2||claimBytes.length>65536||claimBytes.toString('base64')!==encoded)throw Error('unidentified');
        const claim=validateBatchClaimRecord(parse(claimBytes),job).claim;
        if(claim.claimId!==query.claimId||claim.epoch>=query.beforeExecutionEpoch)continue;
        const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:claim.claimId,fence:claim.fence,execution_epoch:claim.epoch},
          controller_id:independentControllerId({invocationNonce:entry.nonce,jobId:job.id,nodeId:query.nodeId})});
        const witness={contract:'clued.independent-ci.controller-supervision/1',identity,nonce:entry.nonce,
          configSha256:entry.configSha256,plan,controllerSid:query.controllerSid};
        executions.push({identity,witness,bundle});
      }
    }catch{pending.push({requestId,reason:'independent_legacy_invocation_unidentified'});}
  }
  if(!executions.length&&!pending.length)pending.push({requestId:null,reason:'independent_legacy_inventory_empty_unproven'});
  return Object.freeze({complete:pending.length===0,nodeId:query.nodeId,repository:query.repository,heads:[...query.heads],executions,pending});
}
function maintenanceReplyOf(reply,query){
  const fields=['contract','nonce','configSha256','stage','controllerSid','nodeId','runnerService','nodePid','helperPid','sourceManifestSha256','observedAt'];
  if(!reply||Object.keys(reply).sort().join('|')!==fields.sort().join('|')||reply.contract!=='clued.independent-ci.scm-maintenance-window/1'
    ||!['nonce','configSha256','stage','controllerSid','runnerService','nodePid'].every(k=>reply[k]===query[k])
    ||typeof reply.nodeId!=='string'||reply.nodeId.toLowerCase()!==query.nodeId.toLowerCase()
    ||!Number.isSafeInteger(reply.helperPid)||reply.helperPid<1||reply.helperPid===reply.nodePid
    ||!matches(reply.sourceManifestSha256,/^[a-f0-9]{64}$/)||typeof reply.observedAt!=='string'
    ||!(Date.parse(reply.observedAt)<=Date.now())||Date.now()-Date.parse(reply.observedAt)>5000)fail('independent_maintenance_window_unconfirmed');
  return Object.freeze({...reply});
}

// A single process keeps every checked ancestor and read handle until all six
// observations have been collected. Read handles deny concurrent writes and
// deletes. No service control, ACL edit, credential read or disk write occurs.
function windowsScript(query) {
  const entry=ENTRY_V2['revocation-maintenance'];
  if(query.mode==='maintenance'&&typeof entry!=='string')fail('independent_maintenance_entry_unavailable');
  return `$controllerSid='${query.controllerSid}';$nonce='${query.nonce}';$configSha256='${query.configSha256}';$stage=${query.stage};$residentSid='${RESIDENT_SID}';$root='${WIN_ROOT}';$resident='${WIN_RESIDENT}';$stageRoot='${WIN_STAGE}';$receipts='${STATE_V2.receipts}';$maintenance=${query.mode==='maintenance'?'$true':'$false'};$legacy=${query.mode==='legacy'?'$true':'$false'};$nodeId='${query.nodeId??''}';$runnerService='${query.runnerService??''}';$nodePid=${query.nodePid??0};$nodeExe='${NODE_EXE}';$helperLeaf='${GENERIC_HELPER}';$maintenanceEntry='${entry?.split('/').join(String.fromCharCode(92))??''}';$repository='${query.repository??''}';$heads=@(${query.heads?.map(h=>`'${h}'`).join(',')??''});$claimId='${query.claimId??''}';$beforeExecutionEpoch=${query.beforeExecutionEpoch??0};`+String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CluedIndependentSupervisorRead {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint i,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 public static SafeFileHandle Open(string path,bool read){
  var h=CreateFileW(path,read?0x80020000u:0x20000u,read?1u:3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
  if(h.IsInvalid)throw new IOException("SUPERVISOR_HANDLE_UNCONFIRMED");
  try{Info i;if(!GetFileInformationByHandle(h,out i)||(i.Attributes&0x400)!=0||(!read&&(i.Attributes&0x10)==0))throw new IOException("SUPERVISOR_TYPE_UNCONFIRMED");
   var p=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,p,32768,0);
   if(n==0||n>=32768||!String.Equals(p.ToString().TrimEnd((char)92),(new string((char)92,2)+"?"+(char)92+path).TrimEnd((char)92),StringComparison.OrdinalIgnoreCase))throw new IOException("SUPERVISOR_PATH_CHANGED");return h;
  }catch{h.Dispose();throw;}
 }
 public static byte[] Security(SafeFileHandle h){IntPtr o,g,d,s,sd;if(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out sd)!=0)throw new IOException("SUPERVISOR_DACL_UNCONFIRMED");
  try{uint n=GetSecurityDescriptorLength(sd);if(n==0||n>1048576)throw new IOException("SUPERVISOR_DACL_SIZE");var b=new byte[n];Marshal.Copy(sd,b,0,(int)n);return b;}finally{LocalFree(sd);}}
 public static byte[] Read(SafeFileHandle h,int max){Info before;if(!GetFileInformationByHandle(h,out before)||(before.Attributes&0x410)!=0||before.Links!=1||before.SizeHigh!=0||before.SizeLow<2||before.SizeLow>max)throw new IOException("SUPERVISOR_FILE_BOUNDARY");
  using(var borrowed=new SafeFileHandle(h.DangerousGetHandle(),false))using(var s=new FileStream(borrowed,FileAccess.Read)){var b=new byte[before.SizeLow];int pos=0;while(pos<b.Length){int n=s.Read(b,pos,b.Length-pos);if(n==0)throw new IOException("SUPERVISOR_READ_INCOMPLETE");pos+=n;}
   if(s.ReadByte()!=-1)throw new IOException("SUPERVISOR_FILE_CHANGED");Info after;if(!GetFileInformationByHandle(h,out after)||after.Links!=1||after.SizeHigh!=before.SizeHigh||after.SizeLow!=before.SizeLow||after.WriteHigh!=before.WriteHigh||after.WriteLow!=before.WriteLow)throw new IOException("SUPERVISOR_FILE_CHANGED");return b;}}
}
'@ | Out-Null
$held=New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
$seen=@{}
$broker=$resident+'\broker';$requests=$broker+'\requests';$responses=$broker+'\responses';$state=$root+'\state';$v2=$state+'\v2'
$admins=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$writes=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
$replace=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
function Under([string]$p,[string]$parent){return $p -ieq $parent -or $p.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase)}
function Check-Acl($handle,[string]$item,[bool]$leaf){
 $security=[CluedIndependentSupervisorRead]::Security($handle);$raw=New-Object Security.AccessControl.RawSecurityDescriptor($security,0)
 if($null -eq $raw.DiscretionaryAcl){throw 'SUPERVISOR_NULL_DACL'}
 $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetSecurityDescriptorBinaryForm($security)
 $owners=@($admins);$allowed=@($admins);$rights=$replace
 if(Under $item $root){$rights=$writes}
 if(Under $item $stageRoot){$owners+=$residentSid;$allowed+=$residentSid}
 if(Under $item $state){$owners+=$controllerSid;$allowed+=$controllerSid}
 if($item -ieq $requests){$allowed+=$residentSid}
 $requestLeaf=$leaf -and ([IO.Path]::GetDirectoryName($item) -ieq $requests)
 if($requestLeaf){$owners+=$residentSid}
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($owners -notcontains $owner){throw 'SUPERVISOR_OWNER_REFUSED'}
 $ownerRights=$false
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
  $sid=$rule.IdentityReference.Value
  if($sid -ceq 'S-1-3-4'){$ownerRights=$true}
  if(($rule.FileSystemRights -band $rights) -ne 0 -and $allowed -notcontains $sid){throw 'SUPERVISOR_WRITABLE_BOUNDARY'}
  if($item -ieq $requests -and $sid -ceq $residentSid -and (([long]$rule.FileSystemRights -band (-bnot 0x1200a3)) -ne 0)){throw 'SUPERVISOR_REQUEST_REWRITE_RIGHTS'}
 }
 if($requestLeaf -and $owner -ceq $residentSid -and -not $ownerRights){throw 'SUPERVISOR_REQUEST_OWNER_RIGHTS'}
}
function Hold-Parents([string]$file){
 $chain=New-Object 'System.Collections.Generic.List[string]'
 for($cursor=[IO.Path]::GetDirectoryName($file);;$cursor=[IO.Path]::GetDirectoryName($cursor)){$chain.Insert(0,$cursor);if($cursor -eq [IO.Path]::GetPathRoot($cursor)){break}}
 foreach($item in $chain){if(-not $seen.ContainsKey($item)){$h=[CluedIndependentSupervisorRead]::Open($item,$false);$held.Add($h);Check-Acl $h $item $false;$seen[$item]=$true}}
}
function Read-Fixed([string]$file,[int]$max){
 if(-not (Under $file $root)){throw 'SUPERVISOR_FIXED_ROOT_REQUIRED'}
 Hold-Parents $file;$h=[CluedIndependentSupervisorRead]::Open($file,$true);$held.Add($h);Check-Acl $h $file $true
 return ,([CluedIndependentSupervisorRead]::Read($h,$max))
}
function Listing(){
 $all=@([IO.Directory]::GetFileSystemEntries($requests));if($all.Count -gt 20000){throw 'SUPERVISOR_REQUEST_INVENTORY_BOUND'}
 return @($all|Where-Object{[IO.Path]::GetFileName($_) -cmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$'}|Sort-Object)
}
function Read-StopFiles([string]$oldNonce,[string]$requestId,[byte[]]$requestBytes){
 $f=[ordered]@{}
 $f.planBytes=[Convert]::ToBase64String((Read-Fixed ($stageRoot+'\'+$oldNonce+'\formal-service-entry.json') 1048576))
 $f.jobsBytes=[Convert]::ToBase64String((Read-Fixed ($stageRoot+'\'+$oldNonce+'\jobs.json') 1048576))
 $f.requestBytes=[Convert]::ToBase64String($requestBytes)
 $f.responseBytes=[Convert]::ToBase64String((Read-Fixed ($responses+'\'+$requestId+'.json') 8192))
 $f.receiptBytes=[Convert]::ToBase64String((Read-Fixed ($receipts+'\windows-formal-entry-'+$oldNonce+'.json') 65536))
 $f.outcomeBytes=[Convert]::ToBase64String((Read-Fixed ($receipts+'\outcome-'+$oldNonce+'.json') 1048576))
 return $f
}
function Batch-Ref($job){
 $v=@('clued.independent-ci.job/3',$job.repo,[long]$job.pr,$job.headSha,$job.baseSha,$job.testSha,$job.sourceManifestSha256,'work-admission',[long]$job.attempt)
 $text=ConvertTo-Json -InputObject $v -Compress -Depth 3
 return (([Security.Cryptography.SHA256]::Create()).ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($text))|ForEach-Object{$_.ToString('x2')}) -join ''
}
try{
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
 # Controller read access is a separately reviewed candidate ACL migration.
 # An old installation still fails at its actual broker DACL; recognizing the
 # pinned account never grants access or changes a security descriptor.
 if($id.User.Value -cne $controllerSid -and $id.User.Value -cne $residentSid -and $id.User.Value -cne 'S-1-5-18' -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'SUPERVISOR_READER_PRINCIPAL_REQUIRED'}
 if($maintenance){
  if($id.User.Value -cne $controllerSid -or [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0 -or [Environment]::MachineName -ine $nodeId){throw 'MAINTENANCE_EXACT_CONTROLLER_SESSION_REQUIRED'}
  $planBytes=Read-Fixed ($stageRoot+'\'+$nonce+'\formal-service-entry.json') 1048576
  $hash=(([Security.Cryptography.SHA256]::Create()).ComputeHash($planBytes)|ForEach-Object{$_.ToString('x2')}) -join ''
  if($hash -cne $configSha256){throw 'MAINTENANCE_PLAN_PIN_CHANGED'}
  $plan=(New-Object Text.UTF8Encoding($false,$true)).GetString($planBytes)|ConvertFrom-Json
  if($plan.stage -ne 12 -or $plan.entryRole -cne 'revocation-maintenance' -or -not $plan.enabled -or
    $plan.sourceManifestSha256 -cnotmatch '^[a-f0-9]{64}\z' -or $plan.acceptanceSha256 -cnotmatch '^[a-f0-9]{64}\z' -or
    $plan.nodeProfileSha256 -cnotmatch '^[a-f0-9]{64}\z'){throw 'MAINTENANCE_PLAN_REFUSED'}
  $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
  $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+$nodePid)
  $service=Get-CimInstance Win32_Service -Filter ("Name='"+$runnerService+"'")
  if($null -eq $self -or $null -eq $node -or $null -eq $service -or $self.ParentProcessId -ne $nodePid -or
    $node.SessionId -ne 0 -or $node.ExecutablePath -ine $nodeExe -or $service.State -cne 'Running' -or
    $service.ProcessId -le 0 -or $node.ParentProcessId -ne $service.ProcessId){throw 'MAINTENANCE_ACTUAL_PARENT_CHAIN_REQUIRED'}
  $helper=Get-CimInstance Win32_Process -Filter ('ProcessId='+$service.ProcessId)
  $nodeOwner=Invoke-CimMethod -InputObject $node -MethodName GetOwnerSid
  $helperOwner=Invoke-CimMethod -InputObject $helper -MethodName GetOwnerSid
  $helperExe=$resident+'\helpers\'+$helperLeaf
  $binary='"'+$helperExe+'" --acceptance-sha256 '+$plan.acceptanceSha256+' --node-profile-sha256 '+$plan.nodeProfileSha256
  $command='"'+$nodeExe+'" "'+$resident+'\source\'+$plan.sourceManifestSha256+'\'+$maintenanceEntry+'" --run --stage '+$nonce+' --config-sha256 '+$configSha256
  if($null -eq $helper -or $helper.SessionId -ne 0 -or $helper.ExecutablePath -ine $helperExe -or $service.PathName -ine $binary -or
    $node.CommandLine -ine $command -or $nodeOwner.ReturnValue -ne 0 -or $nodeOwner.Sid -cne $controllerSid -or
    $helperOwner.ReturnValue -ne 0 -or $helperOwner.Sid -cne $controllerSid){throw 'MAINTENANCE_FIXED_HELPER_SOURCE_REQUIRED'}
  $after=Get-CimInstance Win32_Service -Filter ("Name='"+$runnerService+"'")
  $nodeAfter=Get-CimInstance Win32_Process -Filter ('ProcessId='+$nodePid)
  if($after.State -cne 'Running' -or $after.ProcessId -ne $service.ProcessId -or $after.PathName -cne $service.PathName -or
    $nodeAfter.ParentProcessId -ne $service.ProcessId -or $nodeAfter.CreationDate -ne $node.CreationDate -or
    $nodeAfter.CommandLine -cne $node.CommandLine){throw 'MAINTENANCE_WINDOW_CHANGED'}
  [Console]::Out.Write((@{contract='clued.independent-ci.scm-maintenance-window/1';nonce=$nonce;configSha256=$configSha256;stage=12;
    controllerSid=$controllerSid;nodeId=[Environment]::MachineName;runnerService=$runnerService;nodePid=[long]$nodePid;
    helperPid=[long]$service.ProcessId;sourceManifestSha256=$plan.sourceManifestSha256;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress))
  exit 0
 }
 if($legacy){
  if([Environment]::MachineName -ine $nodeId){throw 'LEGACY_FIXED_NODE_REQUIRED'}
  Hold-Parents ($requests+'\inventory');$before=@(Listing);$found=@();$pending=@();$utf8=New-Object Text.UTF8Encoding($false,$true);$nonces=@{}
  foreach($file in $before){
   $requestId=[IO.Path]::GetFileNameWithoutExtension($file)
   try{
    $raw=Read-Fixed $file 8192;$value=$utf8.GetString($raw)|ConvertFrom-Json
    if($value.contract -cne 'clued.independent-ci.swap-broker-request/2' -or $value.nonce -cnotmatch '^[a-f0-9]{32}\z' -or $value.configSha256 -cnotmatch '^[a-f0-9]{64}\z'){throw 'LEGACY_REQUEST_UNIDENTIFIED'}
    if($nonces.ContainsKey($value.nonce)){throw 'LEGACY_DUPLICATE_NONCE'};$nonces[$value.nonce]=$true
    if(@(1,3,5,7,8,9) -notcontains $value.stage){continue}
    $planBytes=Read-Fixed ($stageRoot+'\'+$value.nonce+'\formal-service-entry.json') 1048576
    $jobsBytes=Read-Fixed ($stageRoot+'\'+$value.nonce+'\jobs.json') 1048576
    $jobs=@($utf8.GetString($jobsBytes)|ConvertFrom-Json)
    if(-not $jobs.Count){throw 'LEGACY_JOBS_UNIDENTIFIED'}
    # Return every publisher candidate. Resident-writable jobs must never
    # decide which request disappears before the Node reader checks the full
    # immutable request -> plan hash -> jobs hash/contracts chain.
    $batchClaims=@{}
    foreach($job in $jobs){
     if($job.contract -cne 'clued.independent-ci.job/3'){throw 'LEGACY_JOBS_UNIDENTIFIED'}
     $ref=Batch-Ref $job;$batchClaims[$ref]=[Convert]::ToBase64String((Read-Fixed ($v2+'\batch-claims\'+$ref+'.json') 65536))
    }
    $f=Read-StopFiles $value.nonce $requestId $raw
    $found+=@{requestId=$requestId;nonce=$value.nonce;configSha256=$value.configSha256;stage=[int]$value.stage;files=$f;batchClaims=$batchClaims}
   }catch{$pending+=@{requestId=$requestId;reason='independent_legacy_protected_read_unconfirmed'}}
  }
  $after=@(Listing);if(($before -join '|') -cne ($after -join '|')){throw 'SUPERVISOR_REQUEST_INVENTORY_CHANGED'}
  [Console]::Out.Write((@{contract='clued.independent-ci.local-legacy-stop-inventory/1';controllerSid=$controllerSid;nodeId=[Environment]::MachineName;
    repository=$repository;heads=@($heads);claimId=$claimId;beforeExecutionEpoch=$beforeExecutionEpoch;entries=@($found);pending=@($pending)}|ConvertTo-Json -Depth 6 -Compress))
  exit 0
 }
 Hold-Parents ($requests+'\inventory')
 $before=@(Listing);$matches=@();$utf8=New-Object Text.UTF8Encoding($false,$true)
 foreach($file in $before){
  $raw=Read-Fixed $file 8192;$value=$utf8.GetString($raw)|ConvertFrom-Json
  if($value.nonce -ceq $nonce){
   if($value.contract -cne 'clued.independent-ci.swap-broker-request/2' -or $value.stage -ne $stage -or $value.configSha256 -cne $configSha256){throw 'SUPERVISOR_REQUEST_SUBJECT_CHANGED'}
   $matches+=@{id=[IO.Path]::GetFileNameWithoutExtension($file);bytes=$raw}
  }
 }
 if($matches.Count -ne 1){throw 'SUPERVISOR_UNIQUE_REQUEST_REQUIRED'}
 $match=$matches[0];$files=[ordered]@{}
 $files.planBytes=[Convert]::ToBase64String((Read-Fixed ($stageRoot+'\'+$nonce+'\formal-service-entry.json') 1048576))
 $files.jobsBytes=[Convert]::ToBase64String((Read-Fixed ($stageRoot+'\'+$nonce+'\jobs.json') 1048576))
 $files.requestBytes=[Convert]::ToBase64String($match.bytes)
 $files.responseBytes=[Convert]::ToBase64String((Read-Fixed ($responses+'\'+$match.id+'.json') 8192))
 $files.receiptBytes=[Convert]::ToBase64String((Read-Fixed ($receipts+'\windows-formal-entry-'+$nonce+'.json') 65536))
 $files.outcomeBytes=[Convert]::ToBase64String((Read-Fixed ($receipts+'\outcome-'+$nonce+'.json') 1048576))
 $after=@(Listing);if(($before -join '|') -cne ($after -join '|')){throw 'SUPERVISOR_REQUEST_INVENTORY_CHANGED'}
 [Console]::Out.Write((@{contract='clued.independent-ci.protected-stop-bundle/1';nonce=$nonce;controllerSid=$controllerSid;requestId=$match.id;files=$files}|ConvertTo-Json -Depth 4 -Compress))
 exit 0
}catch{exit 2}finally{foreach($handle in $held){$handle.Dispose()}}
`;
}

async function nativeRead(query) {
  if(process.platform!=='win32')fail('independent_supervisor_windows_required');
  try{
    // Feed Source through stdin instead of a long command line; no script or
    // evidence is written to a temporary file and no witness data is shell code.
    const operation=promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile','-NonInteractive','-Command','& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'],
      {windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
    operation.child.stdin.end(windowsScript(query));
    const {stdout}=await operation;
    return JSON.parse(stdout);
  }catch{fail('independent_supervisor_protected_read_unconfirmed');}
}
function port(controllerSid, read, fixture, nodeId) {
  if(!matches(controllerSid,SID))fail('independent_supervisor_controller_required');
  if(nodeId!==undefined&&!matches(nodeId,NODE_ID))fail('independent_supervisor_node_required');
  return Object.freeze({fixture,
    async readProtectedStopBundle(witness){const query=queryOf(witness,controllerSid);return decodeReply(await read(Object.freeze(query)),query);},
    async assertMaintenanceWindow(input){const query=maintenanceQueryOf(input,controllerSid);return maintenanceReplyOf(await read(query),query);},
    async readLegacyControllerStopBundles(input){const query=legacyQueryOf(input,controllerSid,nodeId);return legacyReplyOf(await read(query),query);},
  });
}
export function createWindowsIndependentSupervisor({controllerSid,nodeId,...extra}={}) {
  if(Object.keys(extra).length)fail('independent_supervisor_fixed_reader_required');
  return port(controllerSid,nativeRead,false,nodeId);
}
// Explicitly a fixture: callers cannot relabel this port as a live ACL check.
export function createFixtureWindowsIndependentSupervisor({controllerSid,nodeId,readBundle}) {
  if(typeof readBundle!=='function')fail('independent_supervisor_fixture_reader_required');
  return port(controllerSid,readBundle,true,nodeId);
}
