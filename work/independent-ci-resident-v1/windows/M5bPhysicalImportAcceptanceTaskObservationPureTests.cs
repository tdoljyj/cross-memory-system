// Managed fake Scheduler objects exercise the real reflection/polling method.
// No harness Main, COM service, Task, account, WSL or filesystem effects run.
using System;
using System.Reflection;
using System.Runtime.InteropServices;

public static class M5bPhysicalImportAcceptanceTaskObservationPureTests {
  public sealed class Instances { public int Count { get; set; } }
  public sealed class Running {
    readonly FakeTask task;
    public Running(FakeTask task) { this.task=task; }
    public string InstanceGuid {
      get { if(task.FailGuid) throw new COMException("ended",unchecked((int)0x8004130B)); return "{test-instance}"; }
    }
    public void Refresh() {
      task.Refreshes++;
      if(task.RefreshError!=0) throw new COMException("fake scheduler",task.RefreshError);
    }
  }
  public sealed class FakeTask {
    public int Runs, Refreshes, Observations;
    public int RefreshError=unchecked((int)0x8004130B), Result, InstanceCount, CurrentState=3;
    public bool Stale, FailGuid;
    DateTime last;
    public string Path { get { return "\\CluedM5bPhysical1109\\FakePureOnly"; } }
    public DateTime LastRunTime { get { return last; } }
    public int State { get { Observations++; return CurrentState; } }
    public int LastTaskResult { get { return Result; } }
    public Instances GetInstances(int flags) { if(flags!=0) throw new Exception("flags"); return new Instances {Count=InstanceCount}; }
    public Running Run(object parameters) {
      if(++Runs!=1) throw new Exception("DUPLICATE_TASK_RUN");
      last=Stale?new DateTime(1999,11,30):DateTime.UtcNow;
      return new Running(this);
    }
  }
  static int count;
  static int Observe(FakeTask task) {
    // Freshly loaded fixture assembly has rootOwned=false. Assert this so the
    // real method's Stage calls cannot write the privileged evidence root.
    Type harness=typeof(M5bPhysicalImportAcceptance);
    if((bool)harness.GetField("rootOwned",BindingFlags.NonPublic|BindingFlags.Static).GetValue(null)) throw new Exception("FIXTURE_ROOT_OWNED");
    try { return (int)harness.GetMethod("RunTaskOnce",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{task,"pure-fast-exit",1}); }
    catch(TargetInvocationException e) { Exception inner=e;while(inner is TargetInvocationException && inner.InnerException!=null) inner=inner.InnerException;throw inner; }
  }
  static void Check(bool condition,string name) { count++;if(!condition) throw new Exception(name); }
  static void Unknown(FakeTask task,string name) {
    bool timeout=false;try { Observe(task); } catch(TimeoutException) { timeout=true; }
    Check(timeout && task.Runs==1,name);
  }
  public static string Run() {
    count=0;
    FakeTask fast=new FakeTask();Check(Observe(fast)==0 && fast.Runs==1 && fast.Refreshes==1 && fast.Observations>0,"completed-before-first-refresh-proven-by-registered-task");
    FakeTask early=new FakeTask {FailGuid=true};Check(Observe(early)==0 && early.Runs==1,"completed-before-guid-still-needs-registered-outcome");
    FakeTask failed=new FakeTask {Result=23};Check(Observe(failed)==23 && failed.Runs==1,"ended-instance-does-not-turn-failure-into-success");
    FakeTask normal=new FakeTask {RefreshError=0};Check(Observe(normal)==0 && normal.Runs==1,"normal-refresh-terminal-task");
    FakeTask denied=new FakeTask {RefreshError=unchecked((int)0x80070005)};
    bool refused=false;try { Observe(denied); } catch(COMException e) { refused=e.HResult==unchecked((int)0x80070005); }
    Check(refused && denied.Runs==1 && denied.Observations==0,"unrelated-com-error-not-swallowed");
    Unknown(new FakeTask {Stale=true},"gone-instance-stale-last-run-not-proof");
    Unknown(new FakeTask {InstanceCount=1},"gone-instance-other-active-instance-not-proof");
    Unknown(new FakeTask {CurrentState=4},"gone-instance-running-state-not-proof");
    Unknown(new FakeTask {CurrentState=2},"gone-instance-queued-state-not-proof");
    Unknown(new FakeTask {Result=0x41303},"never-run-result-not-terminal-proof");
    Unknown(new FakeTask {Result=0x41301},"running-result-not-terminal-proof");
    return "PASS real RunTaskOnce fakeCOM assertions="+count+"; no COM/Task/WSL/Main effects";
  }
}
