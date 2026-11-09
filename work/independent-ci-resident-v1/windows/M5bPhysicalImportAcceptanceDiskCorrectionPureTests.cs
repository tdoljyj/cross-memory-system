// Pure guards only. No harness Main, file ACL setter, native handle or task runs.
using System;
using System.Reflection;

public static class M5bPhysicalImportAcceptanceDiskCorrectionPureTests {
  static int count;
  static object Call(string method,params object[] args) { return typeof(M5bPhysicalImportAcceptance).GetMethod(method,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args); }
  static string Acl(string sddl,bool corrected) { return (string)Call("CorrectionDiskAclRefusal",sddl,corrected); }
  static void Check(bool condition,string label) { count++;if(!condition) throw new Exception(label); }
  static string Task(int result,DateTime last,int state,int instances) { return (string)Call("CorrectionFailedTaskRefusal",result,last,state,instances); }
  public static string Run() {
    count=0;
    const string batch="S-1-5-21-1173730660-3877291096-655431861-1016",owner="S-1-5-21-1173730660-3877291096-655431861-1001";
    const string admins="(A;;FA;;;SY)(A;;FA;;;BA)";
    string original="O:BAG:BAD:"+admins+"(A;;0x1301bf;;;"+batch+")";
    string corrected="O:BAG:BAD:P"+admins+"(A;;0x1701bf;;;"+batch+")";
    Check(Acl(original,false)==null,"exact-modify-only-ba-owner-is-eligible");
    Check(Acl(original.Replace("O:BA","O:"+owner),false)==null,"exact-original-elevated-operator-owner-eligible");
    Check(Acl(original.Replace("(A;;","(A;ID;"),false)==null,"inherited-file-aces-match-creation");
    Check(Acl(corrected,true)==null,"only-leaf-user-write-dac-added");
    Check(Acl(corrected,false)!=null,"already-has-write-dac-is-not-missing-permission-case");
    Check(Acl(original,true)!=null,"uncorrected-rights-not-accepted-after-setter");
    Check(Acl(corrected.Replace("D:P","D:"),true)!=null,"new-leaf-dacl-must-be-protected");
    Check(Acl(corrected.Replace("(A;;","(A;ID;"),true)!=null,"new-leaf-aces-must-be-explicit");
    Check(Acl(original.Replace("O:BA","O:"+batch),false)!=null,"batch-owner-already-has-write-dac-refused");
    Check(Acl(original.Replace("O:BA","O:BU"),false)!=null,"unexpected-owner-refused");
    Check(Acl(original.Replace(batch,owner),false)!=null,"wrong-user-sid-refused");
    Check(Acl(original.Replace("0x1301bf","FA"),false)!=null,"full-control-not-missing-write-dac");
    Check(Acl(corrected.Replace("0x1701bf","FA"),true)!=null,"full-control-is-not-minimal-correction");
    Check(Acl(original+"(A;;FR;;;BU)",false)!=null,"extra-principal-refused");
    Check(Acl(original+"(A;;FA;;;S-1-5-83-0)",false)!=null,"all-vms-group-not-authorized");
    Check(Acl(original.Replace("(A;;FA;;;BA)","(A;;FA;;;SY)"),false)!=null,"duplicate-admin-ace-refused");
    Check(Acl(original.Replace("(A;;FA;;;BA)","(A;;FR;;;BA)"),false)!=null,"admin-recovery-rights-preserved");
    Check(Acl(original.Replace("(A;;0x1301bf", "(D;;0x1301bf"),false)!=null,"deny-ace-not-treated-as-allow");
    Check(Acl(original.Replace("(A;;0x1301bf", "(A;IO;0x1301bf"),false)!=null,"inherit-only-ace-not-file-access");
    Check(Acl("invalid",false)!=null,"malformed-descriptor-refused");
    DateTime known=new DateTime(2026,11,9,21,23,33);
    Check(Task(3,known,3,0)==null,"exact-known-failed-import-eligible-once");
    Check(Task(0,known,3,0)!=null,"already-succeeded-import-is-not-failed-case");
    Check(Task(unchecked((int)0x80070005),known,3,0)!=null,"other-error-not-same-known-failure");
    Check(Task(3,known.AddSeconds(1),3,0)!=null,"another-run-time-refused");
    Check(Task(3,known,4,0)!=null,"running-task-refused");
    Check(Task(3,known,2,0)!=null,"queued-task-refused");
    Check(Task(3,known,3,1)!=null,"active-instance-refused");
    return "PASS disk-access-correction pure assertions="+count+"; no Main/ACL/native/Task/WSL effects";
  }
}
