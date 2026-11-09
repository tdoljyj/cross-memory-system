// Read-only fixtures. Compile as a library with the registrar and harness, then
// invoke Run() in the test PowerShell process. Never invoke any harness Main,
// account helper, COM service, task, WSL process or privileged filesystem path.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Security.AccessControl;

public static class M5bPhysicalImportAcceptanceRegisteredPureTests {
  static int count;
  static readonly Type Harness=typeof(M5bPhysicalImportAcceptance);
  static object Call(string method,params object[] values) { return Harness.GetMethod(method,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,values); }
  static void Check(bool value,string label) { count++; if(!value) throw new InvalidOperationException(label); }
  static string Guard(string sddl,string caller,bool elevated,string parent=null) {
    return (string)Call("TaskSecurityRefusal",sddl,"S-1-5-21-1173730660-3877291096-655431861-1016",caller,elevated,parent);
  }
  static bool StageRefuses(byte[] value) { try { Call("RegisteredStageAnchor",value); return false; } catch(TargetInvocationException) { return true; } }
  public static string Run() {
    count=0;
    const string owner="S-1-5-21-1173730660-3877291096-655431861-1001", batch="S-1-5-21-1173730660-3877291096-655431861-1016";
    const string full="(A;;FA;;;SY)(A;;FA;;;BA)";
    Check(Guard("O:BAG:BAD:P"+full,owner,true)==null,"trusted-admin-owner");
    Check(Guard("O:"+owner+"G:BAD:P"+full,owner,true)==null,"fixed-elevated-operator-owner");
    Check(Guard("O:"+owner+"G:BAD:P"+full,owner,false)=="TASK_OWNER_OR_DACL_REFUSED","operator-owner-needs-elevation");
    Check(Guard("O:"+owner+"G:BAD:P"+full,batch,true)=="TASK_OWNER_OR_DACL_REFUSED","operator-owner-needs-fixed-caller");
    Check(Guard("O:"+batch+"G:BAD:P"+full,owner,true)=="TASK_OWNER_OR_DACL_REFUSED","batch-is-never-trusted-owner");
    Check(Guard("O:BAG:BAD:"+full,owner,true)=="TASK_OWNER_OR_DACL_REFUSED","unprotected-dacl-remains-refused");
    Check(Guard("O:BAG:BAD:P"+full+"(A;;GW;;;"+batch+")",owner,true)=="TASK_UNTRUSTED_MUTATION_OR_EXECUTE_RIGHTS","untrusted-generic-write-refused");
    Check(Guard("O:BAG:BAD:P"+full+"(A;;GX;;;"+batch+")",owner,true)=="TASK_UNTRUSTED_MUTATION_OR_EXECUTE_RIGHTS","untrusted-execute-refused");
    Check(Guard("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;SY)",owner,true)=="TASK_TRUSTED_FULL_ACCESS_MISSING","duplicate-system-does-not-substitute-admin");
    string folder="O:BAG:BAD:PAI"+full;
    string scheduler="O:BAG:BAD:"+full+"(A;;FR;;;"+batch+")";
    Check(Guard(scheduler,owner,true,folder)==null,"exact-observed-scheduler-shape-with-protected-parent");
    Check(Guard(scheduler,owner,true,folder.Replace("D:PAI","D:AI"))!=null,"unprotected-parent-refused");
    Check(Guard(scheduler,owner,true,folder+"(A;;FA;;;AU)")!=null,"parent-extra-write-refused");
    Check(Guard(scheduler.Replace("(A;;FR;;;","(A;;FX;;;"),owner,true,folder)!=null,"scheduler-principal-execute-refused");
    Check(Guard(scheduler.Replace("(A;;FR;;;","(A;;GW;;;"),owner,true,folder)!=null,"scheduler-principal-write-refused");
    Check(Guard(scheduler.Replace("(A;;FR;;;","(A;;WD;;;"),owner,true,folder)!=null,"scheduler-principal-wdac-refused");
    Check(Guard(scheduler+"(A;;FR;;;AU)",owner,true,folder)!=null,"scheduler-extra-ace-refused");
    Check(Guard(scheduler.Replace("(A;;FR;;;","(A;ID;FR;;;"),owner,true,folder)!=null,"scheduler-inherited-ace-refused");
    Check(Guard(scheduler.Replace("(A;;FA;;;BA)","(A;;FA;;;SY)"),owner,true,folder)!=null,"scheduler-duplicate-trusted-sid-refused");
    Check(Guard(scheduler.Replace("O:BA","O:"+batch),owner,true,folder)!=null,"scheduler-batch-owner-refused");
    RawSecurityDescriptor callback=new RawSecurityDescriptor(scheduler);
    callback.DiscretionaryAcl.RemoveAce(2); callback.DiscretionaryAcl.InsertAce(2,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,0x120089,new System.Security.Principal.SecurityIdentifier(batch),true,new byte[0]));
    Check(Call("ExactSchedulerAclRefusal",callback,batch,owner,true,folder)!=null,"scheduler-callback-ace-refused");
    string mf="905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb", exe="7bc20b77f0e640309a1a6057eb159cb7894d04fd1c09b20797ab9120475ae403", action="00a7776cf2e053f2d771b1f63a966ea7aa3c009f03dcd815816fcee3433d5661";
    string fp=@"\CluedM5bPhysical1109", tp=fp+@"\CluedCIResidentCompanionWslImport";
    Check(Call("RegisteredTaskIdentityRefusal","TURING",fp,tp,batch,mf,action,exe)==null,"registered-task-exact-path-identity");
    Check(Call("RegisteredTaskIdentityRefusal","OTHER",fp,tp,batch,mf,action,exe)!=null,"registered-wrong-machine-refused");
    Check(Call("RegisteredTaskIdentityRefusal","TURING",@"\Other",tp,batch,mf,action,exe)!=null,"registered-wrong-parent-path-refused");
    Check(Call("RegisteredTaskIdentityRefusal","TURING",fp,fp+@"\Other",batch,mf,action,exe)!=null,"registered-wrong-task-path-refused");
    Check(Call("RegisteredTaskIdentityRefusal","TURING",fp,tp,owner,mf,action,exe)!=null,"registered-wrong-sid-refused");
    Check(Call("RegisteredTaskIdentityRefusal","TURING",fp,tp,batch,mf,new string('0',64),exe)!=null,"registered-changed-action-refused");
    Check(Call("RegisteredTaskIdentityRefusal","TURING",fp,tp,batch,mf,action,new string('0',64))!=null,"registered-changed-pe-refused");
    DateTime sentinel=new DateTime(1999,11,30,0,0,0);
    Check((bool)Call("RegisteredNeverRun",0x41303,sentinel,0,3),"actual-scheduler-never-run-sentinel");
    Check(!(bool)Call("RegisteredNeverRun",0x41303,sentinel.AddSeconds(1),0,3),"changed-never-run-time-refused");
    Check(!(bool)Call("RegisteredNeverRun",0,sentinel,0,3),"completed-task-not-never-run");
    Check(!(bool)Call("RegisteredNeverRun",0x41303,sentinel,1,3),"live-instance-refused");
    Check(!(bool)Call("RegisteredNeverRun",0x41303,sentinel,0,4),"running-state-refused");
    Check(!(bool)Call("RegisteredNeverRun",0x41303,DateTime.MinValue,0,3),"unknown-old-date-refused");
    string receipt=@"C:\ProgramData\CluedM5bPhysicalReceipt1109\";
    byte[] stages=File.ReadAllBytes(receipt+"retry-preflight.harness.stages.jsonl");
    Check((string)Call("RegisteredStageAnchor",stages)=="b31aa29993c78fbf3177a1a215f52ce42065dcf0df6ddc403127b236e179f5fc","actual-original-stage-anchor");
    byte[] suffix=Encoding.UTF8.GetBytes("{\"phase\":\"resume-registered:task-security-before-validation\",\"facts\":null}\n");
    byte[] extended=new byte[stages.Length+suffix.Length]; Array.Copy(stages,extended,stages.Length); Array.Copy(suffix,0,extended,stages.Length,suffix.Length);
    Check((string)Call("RegisteredStageAnchor",extended)=="b31aa29993c78fbf3177a1a215f52ce42065dcf0df6ddc403127b236e179f5fc","explicit-readonly-diagnostic-suffix");
    byte[] changed=(byte[])stages.Clone(); changed[11]^=1; Check(StageRefuses(changed),"altered-original-stages-refused");
    byte[] unrelated=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(stages)+"{\"phase\":\"import-run-requested\"}\n");
    Check(StageRefuses(unrelated),"unrelated-suffix-refused");
    Dictionary<string,object> manifest=new JavaScriptSerializer().DeserializeObject(File.ReadAllText(receipt+"retry-preflight.harness.manifest.json")) as Dictionary<string,object>;
    const string manifestHash="905477f26cecabdd51ce3fe3d1077881d06bf359dd2636c8a69a5284f7874ffb";
    Check(Call("RegisteredManifestRefusal",manifest,manifestHash)==null,"actual-exact-manifest-binding");
    manifest["runId"]="00000000-0000-0000-0000-000000000000";
    Check(Call("RegisteredManifestRefusal",manifest,manifestHash)!=null,"different-run-refused");
    return "{\"status\":\"REGISTERED_RESUME_PURE_PASS\",\"assertions\":"+count+",\"accountTaskWslEffects\":0,\"harnessMainInvoked\":false}";
  }
}
