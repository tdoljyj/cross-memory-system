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
 static void ProfileCases(Dictionary<string,object> fixture){
  var vectors=fixture["nodeProfileVectors"]as object[];Yes(vectors!=null&&vectors.Length>=20,"shared-profile-vectors-present");
  foreach(object item in vectors){var row=(Dictionary<string,object>)item;var node=row["node"]as Dictionary<string,object>;
   if((bool)row["accepted"]){var p=NodeProfileV2.FromDictionary(node);Yes(p.CanonicalJson==(string)row["canonicalJson"],"profile-JS-canonical");Yes(p.Sha256==(string)row["sha256"],"profile-JS-hash");Yes(!p.CanonicalJson.EndsWith("\n"),"profile-no-LF");}
   else{string code=null;try{NodeProfileV2.FromDictionary(node);}catch(InvalidOperationException e){code=e.Message;}Yes(code==(string)row["code"],"profile-shared-refusal");}
  }
  var actual=NodeProfileV2.FromDictionary((Dictionary<string,object>)fixture["node"]);Yes(actual.Sha256==(string)fixture["nodeProfileSha256"],"fixture-profile-JS-hash");
  var plans=(object[])fixture["plans"];string acceptance=(string)((Dictionary<string,object>)plans[0])["acceptanceSha256"];
  NodeProfileV2.BindForProcess(actual,acceptance);
  Yes(FormalPublicBoundaryV2.Controller==actual.ControllerSid&&FormalPublicBoundaryV2.OwnerUser==actual.OwnerSid&&FormalScmPidHandshakeV2.Controller==actual.ControllerSid,"all-controller-owner-consumers");
  Yes(ResidentScmV2.Name==actual.RunnerService&&CluedWindowsFormalEntryV2.ServiceName==actual.RunnerService&&ResidentScmV2.MutationMutexName==actual.MutationMutex,"service-mutex-profile");
  var changed=new Dictionary<string,object>((Dictionary<string,object>)fixture["node"]);changed["nodeName"]="changed-profile";var other=NodeProfileV2.FromDictionary(changed);
  Refuse(()=>NodeProfileV2.BindForProcess(other,acceptance),"no-process-profile-rebind");Refuse(()=>NodeProfileV2.BindForProcess(actual,new string('e',64)),"no-process-acceptance-rebind");
  string[] keys=NodeProfileV2.Keys;keys[0]="modified";Yes(NodeProfileV2.Keys[0]=="contract","no-mutable-key-array");
  var argv=new[]{"--acceptance-sha256",acceptance,"--node-profile-sha256",actual.Sha256};Yes(NodeProfileV2.HelperBootstrapPins(argv)[1]==actual.Sha256,"helper-bootstrap-pins");
  Refuse(()=>NodeProfileV2.HelperBootstrapPins(new string[0]),"no-profileless-helper");
  Refuse(()=>NodeProfileV2.HelperBootstrapPins(new[]{argv[2],argv[3],argv[0],argv[1]}),"bootstrap-flags-order");
  Refuse(()=>NodeProfileV2.HelperBootstrapPins(new[]{argv[0],argv[1]+"\n",argv[2],argv[3]}),"bootstrap-no-trailing-LF");
  Refuse(()=>NodeProfileV2.LoadProtectedProfile("C:\\untrusted-profile",actual.Sha256),"profile-fixed-root-before-open");
  Func<string,byte[]> sd=t=>{var a=new RawSecurityDescriptor(t);var b=new byte[a.BinaryLength];a.GetBinaryForm(b,0);return b;};
  NodeProfilePublicFileV2.ValidateBootstrapAcl(sd("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;"+actual.ControllerSid+")"),NodeProfileV2.FixedResidentRoot+"\\record\\acceptance.json");n++;
  Refuse(()=>NodeProfilePublicFileV2.ValidateBootstrapAcl(sd("O:BAG:BAD:P(A;;FA;;;BA)(A;;FW;;;"+actual.ControllerSid+")"),NodeProfileV2.FixedResidentRoot+"\\record\\acceptance.json"),"bootstrap-controller-cannot-write");
  foreach(var right in new[]{"GA","GW"})Refuse(()=>NodeProfilePublicFileV2.ValidateBootstrapAcl(sd("O:BAG:BAD:P(A;;FA;;;BA)(A;;"+right+";;;"+actual.ControllerSid+")"),NodeProfileV2.FixedResidentRoot+"\\record\\acceptance.json"),"bootstrap-controller-no-generic-write-"+right);
  Refuse(()=>NodeProfilePublicFileV2.ValidateBootstrapAcl(sd("O:BAG:BAD:P(A;;FA;;;BA)(A;;GA;;;"+actual.OwnerSid+")"),"C:\\ProgramData"),"bootstrap-parent-no-generic-all");
  var callback=new RawSecurityDescriptor("O:BAG:BAD:P(A;;FA;;;BA)");callback.DiscretionaryAcl.InsertAce(1,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,1,new SecurityIdentifier(actual.ControllerSid),true,new byte[0]));var callbackBytes=new byte[callback.BinaryLength];callback.GetBinaryForm(callbackBytes,0);
  Refuse(()=>NodeProfilePublicFileV2.ValidateBootstrapAcl(callbackBytes,NodeProfileV2.FixedResidentRoot+"\\record\\acceptance.json"),"bootstrap-callback-ace-refused");
  Refuse(()=>NodeProfilePublicFileV2.ValidateBootstrapAcl(sd("O:"+actual.OwnerSid+"G:BAD:P(A;;FA;;;BA)"),NodeProfileV2.FixedResidentRoot+"\\record\\acceptance.json"),"bootstrap-owner-user-not-admin-owner");
 }
 public static int Main(string[] args){
  try{
   var fixture=new JavaScriptSerializer{MaxJsonLength=8*1024*1024}.DeserializeObject(File.ReadAllText(args[0])) as Dictionary<string,object>;
   ProfileCases(fixture);
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
    Yes((string)plan["nodeProfileSha256"]==NodeProfileV2.Current.Sha256,"plan-profile-pin");var missingProfile=new Dictionary<string,object>(plan);missingProfile.Remove("nodeProfileSha256");Refuse(()=>FormalPublicBoundaryV2.PlanStage(missingProfile),"plan-profile-required");
    var bad=new Dictionary<string,object>(plan);bad["entryRole"]=s==1?"control-checks":"work-admission";Refuse(()=>FormalPublicBoundaryV2.PlanStage(bad),"plan-wrong-role");
    var extra=new Dictionary<string,object>(plan);extra["currentClaim"]="x";Refuse(()=>FormalPublicBoundaryV2.PlanStage(extra),"plan-extra-field");}
   // 3. command line: fixed node, installed Source root, exact two arguments
   string nonce=new string('a',32),sha=new string('b',64),root=FormalPublicBoundaryV2.SourceBase+"\\"+new string('c',64);
   Yes(FormalPublicBoundaryV2.CommandFor("control-checks",root,nonce,sha)=="\"C:\\ProgramData\\CluedIndependentCI\\resident\\runtime\\node.exe\" \""+root+"\\work\\actions-hosted-migration\\independent-ci-v1\\src\\independent-control-checks-v2\\startup.mjs\" --run --stage "+nonce+" --config-sha256 "+sha,"command");
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
   Refuse(()=>FormalPublicBoundaryV2.BoundedDeadline(13,now,null),"window-stage");Yes(FormalPublicBoundaryV2.BoundedDeadline(12,now,null)==now.AddMilliseconds(300000),"window-revocation");Yes(FormalPublicBoundaryV2.BoundedDeadline(11,now,null)==now.AddMilliseconds(60000),"window-probe");Yes(FormalPublicBoundaryV2.BoundedDeadline(10,now,null)==now.AddMilliseconds(300000),"window-stage-10");Yes(FormalPublicBoundaryV2.BoundedDeadline(9,now,null)==now.AddMilliseconds(900000),"window-stage-r");
   // 5a. stage 10 (quota phase 2 step 3c-1, 3c-2b): entry train-maintenance, exactly one train run (contract /2 of the plan's run id;
   // the shared table test/fixtures/train-run-cases.json: the same accepted ids and refusals as train-run.mjs)
   Yes(FormalPublicBoundaryV2.RelativeEntryForRole("train-maintenance").EndsWith("src/independent-control-checks-v2/train-maintenance.mjs"),"train-entry");
   Yes(FormalPublicBoundaryV2.StageRole.Length==12&&FormalPublicBoundaryV2.StageMilliseconds[9]==300000&&FormalPublicBoundaryV2.SelectedJobRoles(10,new object[]{new Dictionary<string,object>{{"role","train-run"}}})[0]=="train-run","train-row");
   Yes(FormalPublicBoundaryV2.RelativeEntryForRole("role-probe").EndsWith("src/resident-v2/role-probe-entry.mjs")&&FormalPublicBoundaryV2.SelectedJobRoles(11,new object[]{new Dictionary<string,object>()})[0]=="role-probe-run","probe-entry-row");
   var probe=new Dictionary<string,object>{{"contract","clued.independent-ci.role-probe-run/1"},{"id",new string('a',64)},{"repo","tdoljyj/cross-memory-system"},{"runId",new string('a',16)+"-"+new string('b',12)},{"sourceManifestSha256",new string('c',64)},{"nodeProfileSha256",new string('d',64)},{"createdAt","2026-10-25T00:00:00.000Z"}};
   probe["id"]=FormalPublicBoundaryV2.RoleProbeRunId(probe);FormalPublicBoundaryV2.ValidateRoleProbeRun(probe,new string('c',64),(string)probe["runId"],new string('d',64));n++;
   var probePr=new Dictionary<string,object>(probe);probePr["pr"]=1;Refuse(()=>FormalPublicBoundaryV2.ValidateRoleProbeRun(probePr,new string('c',64),(string)probe["runId"],new string('d',64)),"probe-no-pr");
   Refuse(()=>FormalPublicBoundaryV2.ValidateRoleProbeRun(probe,new string('c',64),(string)probe["runId"],new string('e',64)),"probe-profile-pin");
   Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(probe,"role-probe-run",new string('c',64)),"probe-no-formal-job");
   foreach(object o in (object[])fixture["trainRuns"]){var run=(Dictionary<string,object>)o;string trId=(string)run["runId"],tm=(string)run["sourceManifestSha256"];
    Yes(FormalPublicBoundaryV2.TrainRunId(run)==(string)run["id"],"train-run-id");FormalPublicBoundaryV2.ValidateTrainRun(run,tm,trId);
    var on=new Dictionary<string,object>(run);on["mode"]="on";Refuse(()=>FormalPublicBoundaryV2.ValidateTrainRun(on,tm,trId),"train-run-on-without-since");
    var other=new Dictionary<string,object>(run);Refuse(()=>FormalPublicBoundaryV2.ValidateTrainRun(other,tm,new string('0',16)+"-"+new string('1',12)),"train-run-other-plan");
    var moved=new Dictionary<string,object>(run);moved["repo"]="other/repo";Refuse(()=>FormalPublicBoundaryV2.ValidateTrainRun(moved,tm,trId),"train-run-repo");
    var asJob=new Dictionary<string,object>(run);Refuse(()=>FormalPublicBoundaryV2.ValidateJobV2(asJob,"train-run",tm),"train-run-is-no-job");}
   var trainCases=fixture["trainRunCases"] as object[];Yes(trainCases!=null&&trainCases.Length>=30,"shared-train-run-cases-present");
   foreach(object o in trainCases){var row=(Dictionary<string,object>)o;var tj=(Dictionary<string,object>)row["job"];string tn=(string)row["name"];
    string trId=tj.ContainsKey("runId")?tj["runId"] as string:null,tm=tj.ContainsKey("sourceManifestSha256")?tj["sourceManifestSha256"] as string:null;
    if((bool)row["accepted"]){FormalPublicBoundaryV2.ValidateTrainRun(tj,tm,trId);Yes(FormalPublicBoundaryV2.TrainRunId(tj)==(string)tj["id"],"train-run-shared-id:"+tn);}
    else Refuse(()=>FormalPublicBoundaryV2.ValidateTrainRun(tj,tm,trId),"train-run-shared-refusal:"+tn);}
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
   string own="S-1-5-21-1-2-3-1001";
   Yes(ResidentScmV2.InstallTimeIdentityAllowed("TURING","TURING",own,true,own),"install-digest-elevated-owner");
   Yes(ResidentScmV2.InstallTimeIdentityAllowed("TURING","TURING","S-1-5-18",true,own),"install-digest-local-system");
   Yes(!ResidentScmV2.InstallTimeIdentityAllowed("TURING","TURING",own,false,own),"install-digest-owner-not-elevated");
   Yes(!ResidentScmV2.InstallTimeIdentityAllowed("TURING","TURING","S-1-5-21-1-2-3-1007",true,own),"install-digest-other-admin");
   Yes(!ResidentScmV2.InstallTimeIdentityAllowed("OTHER","TURING","S-1-5-18",true,own),"install-digest-other-machine-system");
   Yes(!ResidentScmV2.InstallTimeIdentityAllowed("OTHER","TURING",own,true,own),"install-digest-other-machine-owner");
   Yes(!ResidentScmV2.InstallTimeIdentityAllowed("TURING","TURING","S-1-5-19",true,own),"install-digest-local-service");
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
