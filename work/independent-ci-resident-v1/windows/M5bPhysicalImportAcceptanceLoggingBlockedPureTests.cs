// Pure continuation guards; no Main, task, WSL, ACL or native file operation.
using System;
using System.Reflection;

public static class M5bPhysicalImportAcceptanceLoggingBlockedPureTests {
  static int count;
  static string Call(string name,params object[] args) { return (string)typeof(M5bPhysicalImportAcceptance).GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args); }
  static void Check(bool condition,string name) { count++;if(!condition) throw new Exception(name); }
  static string Task(int result,DateTime last,int state,int instances) { return Call("LoggingBlockedTaskRefusal",result,last,state,instances); }
  public static string Run() {
    count=0;DateTime known=new DateTime(2026,11,9,21,49,9);
    Check(Task(7,known,3,0)==null,"exact-logging-blocked-task-eligible");
    Check(Task(3,known,3,0)!=null,"earlier-import-failure-not-this-phase");
    Check(Task(0,known,3,0)!=null,"already-successful-task-refused");
    Check(Task(0x41303,known,3,0)!=null,"neverrun-not-logging-blocked");
    Check(Task(7,known.AddSeconds(1),3,0)!=null,"different-run-refused");
    Check(Task(7,new DateTime(2026,11,9,21,23,33),3,0)!=null,"old-attempt-time-refused");
    Check(Task(7,known,4,0)!=null,"running-refused");
    Check(Task(7,known,2,0)!=null,"queued-refused");
    Check(Task(7,known,3,1)!=null,"live-instance-refused");
    const string batch="S-1-5-21-1173730660-3877291096-655431861-1016",owner="S-1-5-21-1173730660-3877291096-655431861-1001";
    string acl="O:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1701bf;;;"+batch+")";
    Check(Call("LoggingDiskAclRefusal",acl)==null,"actual-corrected-ba-owned-disk-accepted-readonly");
    Check(Call("LoggingDiskAclRefusal",acl.Replace("O:BA","O:"+owner))!=null,"owner-must-remain-exact-ba");
    Check(Call("LoggingDiskAclRefusal",acl.Replace("0x1701bf","0x1301bf"))!=null,"uncorrected-disk-refused-no-second-setter");
    Check(Call("LoggingDiskAclRefusal",acl.Replace("0x1701bf","FA"))!=null,"full-control-not-accepted");
    Check(Call("LoggingDiskAclRefusal",acl.Replace("D:PAI","D:AI"))!=null,"unprotected-leaf-refused");
    Check(Call("LoggingDiskAclRefusal",acl+"(A;;FA;;;S-1-5-83-0)")!=null,"unexpected-all-vms-ace-refused");
    Check(Call("LoggingDiskAclRefusal",acl.Replace(batch,owner))!=null,"wrong-fixed-principal-refused");
    return "PASS logging-blocked pure assertions="+count+"; no Main/Task/WSL/ACL/native effects";
  }
}
