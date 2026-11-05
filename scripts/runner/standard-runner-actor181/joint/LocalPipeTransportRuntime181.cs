using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Security.AccessControl;
using System.Collections.Generic;
using Microsoft.Win32.SafeHandles;
using CluedQualification181;
namespace CluedLocalTransport181 {
// Mechanism only: neither this class nor a successful connection grants authority.
// Production callers must already own exact accepted code/packet/currentness.
public sealed class LocalPipe : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct SA {public int length;public IntPtr sd;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string n,uint access,uint mode,uint instances,uint outSize,uint inSize,uint timeout,ref SA sa);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateFile(string n,uint access,uint share,IntPtr sa,uint create,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle h,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle h,out uint pid);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,int rev,out IntPtr sd,out int size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafePipeHandle h,int type,uint what,out IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl,out IntPtr sd);
 SafePipeHandle handle; System.IO.Pipes.PipeStream stream; HeldProcess peer; Snapshot before;
 readonly bool server,fixture; readonly string peerSid,ownerSid,image; readonly int elevation; readonly int expectedPid; readonly long expectedStart;
 bool disposed,accepted;
 LocalPipe(bool isServer,bool ownFixture,string attempt,int pid,long start,string sid) {
  if(attempt==null || !Regex.IsMatch(attempt,"\\A[0-9a-f]{32}\\z"))throw new InvalidOperationException("ATTEMPT_FORMAT");
  using(var thread=WindowsIdentity.GetCurrent(true)){if(thread!=null)throw new InvalidOperationException("THREAD_IMPERSONATION_REFUSED");}
  server=isServer;fixture=ownFixture;
  string own;using(var id=WindowsIdentity.GetCurrent()){own=id.User.Value;}
  string target=TargetSid();
  using(var held=new HeldProcess(System.Diagnostics.Process.GetCurrentProcess().Id)){
   var fact=held.Observe();
   if(!fixture && (server && !(new WindowsPrincipal(WindowsIdentity.GetCurrent())).IsInRole(WindowsBuiltInRole.Administrator) || fact.Sid=="S-1-5-18" || fact.Elevated!=(server?1:0) || (!server && fact.Sid!=target)))throw new InvalidOperationException("OWN_ROLE_IDENTITY_REFUSED");
  }
  ownerSid=fixture?own:"S-1-5-32-544";peerSid=fixture?own:(server?target:new SecurityIdentifier(sid).Value);
  elevation=fixture?0:(server?0:1);expectedPid=pid;expectedStart=start;
  image=fixture?System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName:Path.Combine(Environment.SystemDirectory,"WindowsPowerShell\\v1.0\\powershell.exe");
  string name="\\\\.\\pipe\\CluedSelfRegistration181-"+Environment.MachineName+"-"+attempt;
  if(server){
   IntPtr sd;int size;string acl="O:"+ownerSid+"D:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)(A;;0x00120003;;;"+(fixture?own:target)+")";
   if(fixture)acl="O:"+own+"D:P(A;;0x001f01ff;;;"+own+")";
   if(!ConvertStringSecurityDescriptorToSecurityDescriptor(acl,1,out sd,out size))throw new Win32Exception(Marshal.GetLastWin32Error());
   try{var sa=new SA{length=Marshal.SizeOf(typeof(SA)),sd=sd,inherit=false};handle=CreateNamedPipe(name,0x40080003,8,1,8192,8192,0,ref sa);if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());}finally{LocalFree(sd);}
  }else{
   // Anonymous SQOS prevents a server impersonating this client. Local path only.
   handle=CreateFile(name,0x00120003,0,IntPtr.Zero,3,0x40100000,IntPtr.Zero);
   if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
   try{Owner();Authenticate();stream=new System.IO.Pipes.NamedPipeClientStream(System.IO.Pipes.PipeDirection.InOut,true,true,handle);accepted=true;}catch{Dispose();throw;}
  }
 }
 static string TargetSid(){switch(Environment.MachineName){case "DESK-W-591":return "S-1-5-21-858977881-4031698862-3006450925-1005";case "TURING":return "S-1-5-21-1173730660-3877291096-655431861-1013";default:throw new InvalidOperationException("HOST_NOT_BOUND");}}
 public static LocalPipe ListenForAcceptedAttempt(string attempt){return new LocalPipe(true,false,attempt,0,0,null);}
 public static LocalPipe ConnectForAcceptedAttempt(string attempt,int expectedServerPid,long expectedCreationFileTime,string expectedServerSid){if(expectedServerPid<=0 || expectedCreationFileTime<=0)throw new InvalidOperationException("OWNED_SERVER_REFERENCE_REQUIRED");return new LocalPipe(false,false,attempt,expectedServerPid,expectedCreationFileTime,expectedServerSid);}
 // Separate fixture route never claims production BA/Self identity or authority.
 public static LocalPipe OwnFixtureListen(string attempt){return new LocalPipe(true,true,attempt,0,0,null);}
 public static LocalPipe OwnFixtureConnect(string attempt,int pid,long created){return new LocalPipe(false,true,attempt,pid,created,null);}
 void Owner(){IntPtr owner,sd;uint e=GetSecurityInfo(handle,6,5,out owner,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out sd);if(e!=0)throw new Win32Exception((int)e);try{if(owner==IntPtr.Zero || new SecurityIdentifier(owner).Value!=ownerSid)throw new InvalidOperationException("PIPE_OWNER_REFUSED");uint length=GetSecurityDescriptorLength(sd);if(length<20 || length>16384)throw new InvalidOperationException("PIPE_ACL_BOUND");var raw=new byte[length];Marshal.Copy(sd,raw,0,raw.Length);var descriptor=new RawSecurityDescriptor(raw,0);var expected=new Dictionary<string,int>();if(fixture)expected.Add(ownerSid,0x001f01ff);else{expected.Add("S-1-5-18",0x001f01ff);expected.Add("S-1-5-32-544",0x001f01ff);expected.Add(TargetSid(),0x00120003);}if((descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0 || descriptor.DiscretionaryAcl==null || descriptor.DiscretionaryAcl.Count!=expected.Count)throw new InvalidOperationException("PIPE_EXACT_ACL_REFUSED");foreach(GenericAce a in descriptor.DiscretionaryAcl){var ace=a as CommonAce;int mask;if(ace==null || ace.AceQualifier!=AceQualifier.AccessAllowed || ace.AceFlags!=AceFlags.None || !expected.TryGetValue(ace.SecurityIdentifier.Value,out mask) || ace.AccessMask!=mask)throw new InvalidOperationException("PIPE_EXACT_ACL_REFUSED");expected.Remove(ace.SecurityIdentifier.Value);}}finally{LocalFree(sd);}}
 void Authenticate(){uint processId;bool ok=server?GetNamedPipeClientProcessId(handle,out processId):GetNamedPipeServerProcessId(handle,out processId);if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());peer=new HeldProcess(checked((int)processId));try{before=peer.Observe();if(before.Sid!=peerSid || before.Elevated!=elevation || !String.Equals(before.Image,image,StringComparison.OrdinalIgnoreCase) || (expectedPid>0 && before.Pid!=expectedPid) || (expectedStart>0 && before.CreationFileTime!=expectedStart))throw new InvalidOperationException("PIPE_PEER_IDENTITY_REFUSED");}catch{peer.Dispose();peer=null;throw;}}
 void Check(){if(disposed || !accepted)throw new InvalidOperationException("PIPE_NOT_CONNECTED");Owner();uint linked;bool queried=server?GetNamedPipeClientProcessId(handle,out linked):GetNamedPipeServerProcessId(handle,out linked);if(!queried)throw new Win32Exception(Marshal.GetLastWin32Error());if(linked!=(uint)before.Pid)throw new InvalidOperationException("PIPE_KERNEL_PEER_CHANGED");var now=peer.Observe();if(now.Pid!=before.Pid || now.CreationFileTime!=before.CreationFileTime || now.Sid!=before.Sid || now.Elevated!=before.Elevated || now.Image!=before.Image)throw new InvalidOperationException("PIPE_PEER_CONTINUITY_REFUSED");}
 public void Accept(int milliseconds){if(!server || accepted || disposed || milliseconds<1 || milliseconds>120000)throw new InvalidOperationException("PIPE_ACCEPT_STATE_OR_BOUND");
  try{var pipe=new System.IO.Pipes.NamedPipeServerStream(System.IO.Pipes.PipeDirection.InOut,true,false,handle);stream=pipe;
   var pending=pipe.BeginWaitForConnection(null,null);using(var wait=pending.AsyncWaitHandle){if(!wait.WaitOne(milliseconds)){Dispose();throw new TimeoutException("PIPE_ACCEPT_TIMEOUT");}pipe.EndWaitForConnection(pending);}
   Owner();Authenticate();accepted=true;
  }catch{Dispose();throw;}
 } void Transfer(byte[] bytes,bool write,int timeout){int offset=0;var timer=System.Diagnostics.Stopwatch.StartNew();while(offset<bytes.Length){int remaining=timeout-(int)timer.ElapsedMilliseconds;if(remaining<=0){Dispose();throw new TimeoutException("PIPE_FRAME_TIMEOUT");}IAsyncResult operation=write?stream.BeginWrite(bytes,offset,bytes.Length-offset,null,null):stream.BeginRead(bytes,offset,bytes.Length-offset,null,null);using(var wait=operation.AsyncWaitHandle){if(!wait.WaitOne(remaining)){Dispose();throw new TimeoutException("PIPE_FRAME_TIMEOUT");}if(write){stream.EndWrite(operation);offset=bytes.Length;}else{int n=stream.EndRead(operation);if(n==0){Dispose();throw new EndOfStreamException("PIPE_EOF");}offset+=n;}}}}
 public void Send(byte[] bytes,int timeout){if(bytes==null || bytes.Length<1 || bytes.Length>4096 || timeout<1 || timeout>20000)throw new InvalidOperationException("PIPE_FRAME_BOUND");Check();try{byte[] header=BitConverter.GetBytes(bytes.Length);Transfer(header,true,timeout);Transfer(bytes,true,timeout);Check();}catch{Dispose();throw;}}
 public byte[] Receive(int timeout){if(timeout<1 || timeout>20000)throw new InvalidOperationException("PIPE_FRAME_BOUND");Check();try{byte[] header=new byte[4];Transfer(header,false,timeout);int size=BitConverter.ToInt32(header,0);if(size<1 || size>4096)throw new InvalidOperationException("PIPE_FRAME_BOUND");byte[] bytes=new byte[size];Transfer(bytes,false,timeout);Check();return bytes;}catch{Dispose();throw;}}
 // Idle awaiting the next request is separate from the bounded RPC response.
 // Header wait tolerates the original native/ACK lifecycle, body remains20s.
 // EOF/timeout disposes the connection; no retry or reconnect is performed.
 public byte[] ReceiveIdle(int timeout){if(timeout<1 || timeout>180000)throw new InvalidOperationException("PIPE_IDLE_BOUND");Check();try{byte[] header=new byte[4];Transfer(header,false,timeout);int size=BitConverter.ToInt32(header,0);if(size<1 || size>4096)throw new InvalidOperationException("PIPE_FRAME_BOUND");byte[] bytes=new byte[size];Transfer(bytes,false,20000);Check();return bytes;}catch{Dispose();throw;}}
 internal bool IsFixture {get{return fixture;}}
 public int PeerPid {get{Check();return before.Pid;}}
 public long PeerCreationFileTime {get{Check();return before.CreationFileTime;}}
 public void Dispose(){if(disposed)return;disposed=true;if(stream!=null)stream.Dispose();else if(handle!=null)handle.Dispose();if(peer!=null)peer.Dispose();}
}
}
