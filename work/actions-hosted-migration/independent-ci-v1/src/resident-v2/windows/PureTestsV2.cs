// Pure, host-free assertions over the Source v2 C# (generic helper boundary, PID handshake, broker SCM
// primitive). Run only by test-pure-v2.ps1 from a scratch build; it never opens a service, file
// outside the fixture, mutex or event object.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

public static class PureTestsV2 {
 static int n;
 static void Yes(bool v,string what){if(!v)throw new Exception("PURE_V2_ASSERTION_FAILED:"+what);n++;}
 static void Refuse(Action f,string what){bool no=false;try{f();}catch(InvalidOperationException){no=true;}Yes(no,what);}
 public static int Main(string[] args){
  try{
   var fixture=new JavaScriptSerializer{MaxJsonLength=8*1024*1024}.DeserializeObject(File.ReadAllText(args[0])) as Dictionary<string,object>;
   // 1. job ids: the C# formula equals the Node formula for all six roles (DETERMINISTIC_JOB_ID_REQUIRED)
   foreach(object o in (object[])fixture["jobs"]){var job=(Dictionary<string,object>)o;Yes(FormalPublicBoundaryV2.JobIdV2(job)==(string)job["id"],"job-id "+job["role"]);
    FormalPublicBoundaryV2.ValidateJobV2(job,(string)job["role"],(string)job["sourceManifestSha256"]);
    var wrongRole=new Dictionary<string,object>(job);Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(wrongRole,"other-role",(string)job["sourceManifestSha256"]),"role");
    var third=new Dictionary<string,object>(job);third["attempt"]=3;Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(third,(string)job["role"],(string)job["sourceManifestSha256"]),"attempt-3");
    var claim=new Dictionary<string,object>(job);claim["claimId"]="x";Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(claim,(string)job["role"],(string)job["sourceManifestSha256"]),"claim-field");
    var moved=new Dictionary<string,object>(job);moved["headSha"]=new string('9',40);Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(moved,(string)job["role"],(string)job["sourceManifestSha256"]),"id-changed");
    // job contract /3: the tested commit is part of the id; a /2 job (no testSha) is refused
    Yes((string)job["testSha"]==(string)job["headSha"]&&(string)job["contract"]=="clued.independent-ci.job/3","job-v3-test-commit-is-head");
    var tested=new Dictionary<string,object>(job);tested["testSha"]=new string('8',40);Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(tested,(string)job["role"],(string)job["sourceManifestSha256"]),"test-commit-changed");
    var renamed=new Dictionary<string,object>(job);renamed["contract"]="clued.independent-ci.job/2";Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(renamed,(string)job["role"],(string)job["sourceManifestSha256"]),"job-contract-string");
    var old=new Dictionary<string,object>(job);old.Remove("testSha");old["contract"]="clued.independent-ci.job/2";Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(old,(string)job["role"],(string)job["sourceManifestSha256"]),"job-v2-refused");}
   // 2. plans: every derived plan passes; a tampered stage/role fails
   foreach(object o in (object[])fixture["plans"]){var plan=(Dictionary<string,object>)o;int s=FormalPublicBoundaryV2.PlanStage(plan);Yes(FormalPublicBoundaryV2.StageRole[s-1]==(string)plan["entryRole"],"plan-role");
    var bad=new Dictionary<string,object>(plan);bad["entryRole"]=s==1?"control-checks":"work-admission";Refuse(()=>FormalPublicBoundaryV2.PlanStage(bad),"plan-wrong-role");
    var extra=new Dictionary<string,object>(plan);extra["currentClaim"]="x";Refuse(()=>FormalPublicBoundaryV2.PlanStage(extra),"plan-extra-field");}
   // 3. command line: fixed node, installed Source root, exact two arguments
   string nonce=new string('a',32),sha=new string('b',64),root=FormalPublicBoundaryV2.SourceBase+"\\"+new string('c',64);
   Yes(FormalPublicBoundaryV2.CommandFor("control-checks",root,nonce,sha)=="\"C:\\Program Files\\nodejs\\node.exe\" \""+root+"\\work\\actions-hosted-migration\\independent-ci-v1\\src\\independent-control-checks-v2\\startup.mjs\" --run --stage "+nonce+" --config-sha256 "+sha,"command");
   Refuse(()=>FormalPublicBoundaryV2.CommandFor("control-checks",root,"x",sha),"command-nonce");Refuse(()=>FormalPublicBoundaryV2.RelativeEntryForRole("../x"),"entry-role");
   // 4. S3 ownership / writer model
   string stage=FormalPublicBoundaryV2.StageRoot+"\\"+nonce+"\\jobs.json",record=FormalPublicBoundaryV2.Record+"\\acceptance.json",state=FormalPublicBoundaryV2.Receipts+"\\x.json",incoming=FormalPublicBoundaryV2.Incoming+"\\result.json",outgoing=FormalPublicBoundaryV2.Outgoing+"\\issue.json";
   Yes(FormalPublicBoundaryV2.OwnerAllowed(record,"S-1-5-32-544")&&FormalPublicBoundaryV2.OwnerAllowed(stage,FormalPublicBoundaryV2.ResidentSid),"owner-ok");
   Yes(!FormalPublicBoundaryV2.OwnerAllowed(record,FormalPublicBoundaryV2.ResidentSid)&&!FormalPublicBoundaryV2.OwnerAllowed(stage,FormalPublicBoundaryV2.Controller),"owner-refused");
   Yes(FormalPublicBoundaryV2.WriterAllowed(stage,FormalPublicBoundaryV2.ResidentSid)&&FormalPublicBoundaryV2.WriterAllowed(incoming,FormalPublicBoundaryV2.ResidentSid)&&FormalPublicBoundaryV2.WriterAllowed(outgoing,FormalPublicBoundaryV2.Controller),"writer-ok");
   Yes(!FormalPublicBoundaryV2.WriterAllowed(record,FormalPublicBoundaryV2.ResidentSid)&&!FormalPublicBoundaryV2.WriterAllowed(stage,FormalPublicBoundaryV2.Controller)&&!FormalPublicBoundaryV2.WriterAllowed(state,FormalPublicBoundaryV2.ResidentSid)&&!FormalPublicBoundaryV2.WriterAllowed(record,FormalPublicBoundaryV2.OwnerUser),"writer-refused");
   Yes((FormalPublicBoundaryV2.DangerFor(record)&FileSystemRights.Write)!=0&&(FormalPublicBoundaryV2.DangerFor("C:\\Windows\\x")&FileSystemRights.Write)==0,"danger");
   // 5. S5 window: null validUntil = install lifetime; a near deadline refuses; stage 8 waits longest
   var now=DateTimeOffset.UtcNow;Yes(FormalPublicBoundaryV2.BoundedDeadline(8,now,null)==now.AddMilliseconds(2700000),"window-null");
   Refuse(()=>FormalPublicBoundaryV2.BoundedDeadline(2,now,now.AddMinutes(30)),"window-near");Yes(FormalPublicBoundaryV2.BoundedDeadline(1,now,now.AddDays(30))==now.AddMinutes(15),"window-far");
   Refuse(()=>FormalPublicBoundaryV2.BoundedDeadline(10,now,null),"window-stage");Yes(FormalPublicBoundaryV2.BoundedDeadline(9,now,null)==now.AddMilliseconds(900000),"window-stage-r");
   // 5b. stage R: entry relay-publisher, a non-empty ordered subset of gitleaks/trivy, nothing else
   Yes(FormalPublicBoundaryV2.RelativeEntryForRole("relay-publisher").EndsWith("src/hosted-relay-v1/relay-entry-v2.mjs"),"relay-entry");
   Func<string[],object[]> js=rs=>{var o=new object[rs.Length];for(int i=0;i<rs.Length;i++)o[i]=new Dictionary<string,object>{{"role",rs[i]}};return o;};
   Yes(FormalPublicBoundaryV2.SelectedJobRoles(9,js(new[]{"trivy"}))[0]=="trivy"&&FormalPublicBoundaryV2.SelectedJobRoles(9,js(new[]{"gitleaks","trivy"})).Length==2,"relay-subset");
   Refuse(()=>FormalPublicBoundaryV2.SelectedJobRoles(9,js(new[]{"trivy","gitleaks"})),"relay-order");Refuse(()=>FormalPublicBoundaryV2.SelectedJobRoles(9,js(new[]{"contract-placement"})),"relay-placement");
   Refuse(()=>FormalPublicBoundaryV2.SelectedJobRoles(9,js(new string[0])),"relay-empty");Refuse(()=>FormalPublicBoundaryV2.SelectedJobRoles(2,js(new[]{"gitleaks","trivy"})),"fixed-stage-count");
   // 6. S2 PID handshake event: owner SYSTEM, SY+BA full, controller Synchronize; nothing else
   Yes(FormalScmPidHandshakeV2.NameForNonce(nonce).EndsWith(nonce),"ack-name");Refuse(()=>FormalScmPidHandshakeV2.NameForNonce("A"),"ack-nonce");
   FormalScmPidHandshakeV2.ValidateSecurity(FormalScmPidHandshakeV2.ManagementSecurity().GetSecurityDescriptorBinaryForm());n++;
   var v1Like=new EventWaitHandleSecurity();v1Like.SetOwner(new SecurityIdentifier("S-1-5-32-544"));v1Like.SetAccessRuleProtection(true,false);foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544"})v1Like.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(sid),EventWaitHandleRights.FullControl,AccessControlType.Allow));
   v1Like.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(FormalScmPidHandshakeV2.Controller),EventWaitHandleRights.Synchronize,AccessControlType.Allow));
   Refuse(()=>FormalScmPidHandshakeV2.ValidateSecurity(v1Like.GetSecurityDescriptorBinaryForm()),"ack-owner");
   var wide=FormalScmPidHandshakeV2.ManagementSecurity();wide.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(FormalPublicBoundaryV2.ResidentSid),EventWaitHandleRights.Synchronize,AccessControlType.Allow));
   Refuse(()=>FormalScmPidHandshakeV2.ValidateSecurity(wide.GetSecurityDescriptorBinaryForm()),"ack-extra-ace");
   // 7. broker SCM primitive: v1-compatible mutex DACL, empty failure policy, service DACL with a resident right refused
   var m=new MutexSecurity();m.SetOwner(new SecurityIdentifier("S-1-5-18"));m.SetAccessRuleProtection(true,false);foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544"})m.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(sid),MutexRights.FullControl,AccessControlType.Allow));
   ResidentScmV2.ValidateMutexSecurity(m.GetSecurityDescriptorBinaryForm());n++;
   // MINOR-3: the Owner user SID is not a mutex manager (neither as an ACE nor as the owner)
   var mo=new MutexSecurity();mo.SetOwner(new SecurityIdentifier("S-1-5-18"));mo.SetAccessRuleProtection(true,false);foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544",FormalPublicBoundaryV2.OwnerUser})mo.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(sid),MutexRights.FullControl,AccessControlType.Allow));
   Refuse(()=>ResidentScmV2.ValidateMutexSecurity(mo.GetSecurityDescriptorBinaryForm()),"mutex-owner-user-ace");
   var mu=new MutexSecurity();mu.SetOwner(new SecurityIdentifier(FormalPublicBoundaryV2.OwnerUser));mu.SetAccessRuleProtection(true,false);foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544"})mu.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(sid),MutexRights.FullControl,AccessControlType.Allow));
   Refuse(()=>ResidentScmV2.ValidateMutexSecurity(mu.GetSecurityDescriptorBinaryForm()),"mutex-owner-user-owner");
   m.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(FormalPublicBoundaryV2.ResidentSid),MutexRights.Synchronize,AccessControlType.Allow));Refuse(()=>ResidentScmV2.ValidateMutexSecurity(m.GetSecurityDescriptorBinaryForm()),"mutex-extra");
   Yes(ResidentScmV2.EmptyFailurePolicy(0,false,false,false)&&!ResidentScmV2.EmptyFailurePolicy(1,false,false,false),"failure-policy");
   var svc=new RawSecurityDescriptor("O:SYG:SYD:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)");var sb=new byte[svc.BinaryLength];svc.GetBinaryForm(sb,0);ResidentScmV2.ValidateServiceSecurity(sb);n++;
   // MINOR-3: the live runner DACL (read-only, 2026-10-21) is accepted; any change-config/start for the Owner user, IU or SU is refused
   Func<string,byte[]> sdb=t=>{var r=new RawSecurityDescriptor(t);var b=new byte[r.BinaryLength];r.GetBinaryForm(b,0);return b;};
   ResidentScmV2.ValidateServiceSecurity(sdb("O:SYG:SYD:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"));n++;
   foreach(var who in new[]{FormalPublicBoundaryV2.OwnerUser,"IU","SU"})foreach(var right in new[]{"DC","RP","WP","SD","WD","WO","GA","GW"})Refuse(()=>ResidentScmV2.ValidateServiceSecurity(sdb("O:SYG:SYD:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CC"+right+";;;"+who+")")),"service-"+who+"-"+right);
   Refuse(()=>ResidentScmV2.ValidateServiceSecurity(sdb("O:"+FormalPublicBoundaryV2.OwnerUser+"G:SYD:(A;;CCLCSWRPWPDTLOCRRC;;;SY)")),"service-owner-user-owner");
   var bad2=new RawSecurityDescriptor("O:SYG:SYD:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;RPWP;;;"+FormalPublicBoundaryV2.ResidentSid+")");var bb=new byte[bad2.BinaryLength];bad2.GetBinaryForm(bb,0);Refuse(()=>ResidentScmV2.ValidateServiceSecurity(bb),"service-resident-right");
   // 8. child environment: fixed 8 variables, v2 provider, no proxy/NODE_OPTIONS
   string env=CluedWindowsFormalEntryV2.ChildEnvironment();Yes(env.Split(new[]{'\0'},StringSplitOptions.RemoveEmptyEntries).Length==8&&env.Contains("CLUED_EXECUTION_PROVIDER=independent-ci-resident-v2")&&!env.Contains("NODE_OPTIONS")&&env.EndsWith("\0\0"),"env");
   Yes(CluedWindowsFormalEntryV2.SafeFailure("ok code")=="ONE_SHOT_OPERATION_UNCONFIRMED"&&CluedWindowsFormalEntryV2.SafeFailure("FIXED_CHILD_TIMEOUT")=="FIXED_CHILD_TIMEOUT","safe-failure");
   Console.WriteLine("{\"status\":\"PURE_V2_PASS\",\"assertions\":"+n+"}");return 0;
  }catch(Exception e){Console.WriteLine("{\"status\":\"PURE_V2_FAIL\",\"message\":\""+e.Message.Replace("\"","'")+"\"}");return 1;}
 }
}
