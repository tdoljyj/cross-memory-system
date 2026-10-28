// Source v2 SCM PID handshake (DESIGN S1, S2). Same protocol as v1 ScmPidHandshake.cs, but the
// event is created by CluedCISwapBroker (LocalSystem) instead of the Owner's elevated token:
//   owner SYSTEM; SYSTEM and Administrators FullControl; clued-control Synchronize only.
// The resident account has no access to it at all (it never needs one). No scheduling, argv,
// secret or receipt-derived PID.
public static class FormalScmPidHandshakeV2 {
 public const uint MaximumObservationWaitMilliseconds=135000;
 public const uint MaximumNativeAckWaitMilliseconds=30000;
 public static string Controller {get{return NodeProfileV2.Current.ControllerSid;}}
 public const string SystemSid="S-1-5-18";
 static readonly string[] Managers={"S-1-5-18","S-1-5-32-544"};
 static void Deny(string code){throw new System.InvalidOperationException(code);}
 public static bool ValidNonce(string nonce){if(nonce==null||nonce.Length!=32)return false;foreach(char c in nonce)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 public static string NameForNonce(string nonce){
  if(!ValidNonce(nonce))Deny("FIXED_SCM_ACK_NONCE_REQUIRED");
  return "Global\\CluedFormalScmPidAckV2-tdoljyj-cross-memory-system-"+nonce;
 }
 public static uint ObservedRunningPid(uint state,uint pid){if(state!=4||pid==0)Deny("INDEPENDENT_SCM_RUNNING_PID_REQUIRED");return pid;}
 public static void ValidateSecurity(byte[] bytes){
  var sd=new System.Security.AccessControl.RawSecurityDescriptor(bytes,0);
  if(sd.Owner==null||sd.Owner.Value!=SystemSid||sd.DiscretionaryAcl==null||sd.DiscretionaryAcl.Count!=3||(sd.ControlFlags&System.Security.AccessControl.ControlFlags.DiscretionaryAclProtected)==0)Deny("EXACT_SCM_ACK_OWNER_DACL_REQUIRED");
  var seen=new System.Collections.Generic.HashSet<string>(System.StringComparer.Ordinal);
  foreach(System.Security.AccessControl.GenericAce item in sd.DiscretionaryAcl){
   var ace=item as System.Security.AccessControl.CommonAce;
   if(ace==null||ace.IsCallback||ace.AceQualifier!=System.Security.AccessControl.AceQualifier.AccessAllowed||ace.AceFlags!=System.Security.AccessControl.AceFlags.None||!seen.Add(ace.SecurityIdentifier.Value))Deny("EXACT_SCM_ACK_ACE_REQUIRED");
   string sid=ace.SecurityIdentifier.Value;
   int rights=sid==Controller?(int)System.Security.AccessControl.EventWaitHandleRights.Synchronize:System.Array.IndexOf(Managers,sid)>=0?(int)System.Security.AccessControl.EventWaitHandleRights.FullControl:0;
   if(rights==0||ace.AccessMask!=rights)Deny("EXACT_SCM_ACK_RIGHTS_REQUIRED");
  }
 }
 public static System.Security.AccessControl.EventWaitHandleSecurity ManagementSecurity(){
  var acl=new System.Security.AccessControl.EventWaitHandleSecurity();acl.SetOwner(new System.Security.Principal.SecurityIdentifier(SystemSid));acl.SetAccessRuleProtection(true,false);
  foreach(string sid in Managers)acl.AddAccessRule(new System.Security.AccessControl.EventWaitHandleAccessRule(new System.Security.Principal.SecurityIdentifier(sid),System.Security.AccessControl.EventWaitHandleRights.FullControl,System.Security.AccessControl.AccessControlType.Allow));
  acl.AddAccessRule(new System.Security.AccessControl.EventWaitHandleAccessRule(new System.Security.Principal.SecurityIdentifier(Controller),System.Security.AccessControl.EventWaitHandleRights.Synchronize,System.Security.AccessControl.AccessControlType.Allow));
  return acl;
 }
 // Broker side (LocalSystem). The event must be new and unsignaled.
 public static System.Threading.EventWaitHandle CreateManagementEvent(string nonce){
  bool created;var handle=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.ManualReset,NameForNonce(nonce),out created,ManagementSecurity());
  try{if(!created)Deny("EXISTING_SCM_ACK_OBJECT_REFUSED");ValidateSecurity(handle.GetAccessControl().GetSecurityDescriptorBinaryForm());if(handle.WaitOne(0))Deny("SCM_ACK_MUST_BEGIN_UNSIGNALED");return handle;}catch{handle.Dispose();throw;}
 }
 // Helper side (clued-control): wait until the broker observed this exact service PID running.
 public static void WaitForIndependentObservation(string nonce,System.DateTimeOffset runtimeDeadline,System.Action check){
  System.Threading.EventWaitHandle handle;
  try{handle=System.Threading.EventWaitHandle.OpenExisting(NameForNonce(nonce),System.Security.AccessControl.EventWaitHandleRights.Synchronize);}catch{Deny("FIXED_BROKER_CREATED_SCM_ACK_UNAVAILABLE");return;}
  using(handle){var end=System.DateTimeOffset.UtcNow.AddMilliseconds(MaximumNativeAckWaitMilliseconds);if(runtimeDeadline<end)end=runtimeDeadline;
   while(true){check();double remaining=(end-System.DateTimeOffset.UtcNow).TotalMilliseconds;if(remaining<1)Deny("SCM_PID_OBSERVATION_ACK_DEADLINE");
    if(handle.WaitOne((int)System.Math.Min(50,System.Math.Ceiling(remaining)))){check();if(System.DateTimeOffset.UtcNow>=end)Deny("SCM_PID_OBSERVATION_ACK_DEADLINE");return;}
   }
  }
 }
}
