using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Globalization;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// C1: public node identity only. No runtime/key/Source/qualification identity is derived here.
// The canonical hash is the existing C1a SHA256(canonical(node) UTF8), without a trailing LF.
// Shared by the controller helper and the broker's read-only diagnostic. Check under the caller's own token.
internal static class RenewalKeyAccessV2 {
    internal const string Name="Clued-CI-Node-Identity-v1";
    internal static readonly string[] Providers={"Microsoft Platform Crypto Provider","Microsoft Software Key Storage Provider"};
    internal const CngKeyOpenOptions Flags=CngKeyOpenOptions.MachineKey|CngKeyOpenOptions.Silent;
    internal static bool Absent(int error) {
        return error==unchecked((int)0x80090016) || error==unchecked((int)0x80090011) || error==unchecked((int)0x80090013) || error==unchecked((int)0x8028400f);
    }
    internal static string Check(string provider) {
        try { using(CngKey.Open(Name,new CngProvider(provider),Flags)) return "OPEN"; }
        catch(CryptographicException e) {
            if(e.HResult==unchecked((int)0x80090010) || e.HResult==unchecked((int)0x80070005))return "DENIED";
            return Absent(e.HResult)?"ABSENT":"UNKNOWN";
        }
        catch {return "UNKNOWN";}
    }
    internal static Dictionary<string,object> Observation() {
        using(var id=WindowsIdentity.GetCurrent()) return new Dictionary<string,object> {
            {"at",DateTime.UtcNow.ToString("o")},{"sid",id.User.Value},{"tpm",Check(Providers[0])},{"software",Check(Providers[1])}
        };
    }
}
public sealed class NodeProfileV2 {
 public const string Contract="clued.independent-ci.node-profile/1";
 public const string FixedResidentRoot="C:\\ProgramData\\CluedIndependentCI\\resident";
 static readonly string[] ProfileKeys={"contract","nodeName","hostname","ownerSid","ownerProfileDirectory","controllerSid","runnerService","mutationMutex","wslDistribution"};
 public static string[] Keys {get{return(string[])ProfileKeys.Clone();}}
 public readonly string NodeName,Hostname,OwnerSid,OwnerProfileDirectory,ControllerSid,RunnerService,MutationMutex,WslDistribution,CanonicalJson,Sha256;
 static readonly Regex Sid=new Regex(@"\AS-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-([0-9]{1,10})\z",RegexOptions.CultureInvariant);
 static NodeProfileV2 current;static string currentAcceptance;static readonly object Gate=new object();
 NodeProfileV2(Dictionary<string,object> v){
  NodeName=(string)v["nodeName"];Hostname=(string)v["hostname"];OwnerSid=(string)v["ownerSid"];OwnerProfileDirectory=(string)v["ownerProfileDirectory"];
  ControllerSid=(string)v["controllerSid"];RunnerService=(string)v["runnerService"];MutationMutex=(string)v["mutationMutex"];WslDistribution=(string)v["wslDistribution"];
  // Every value has already been restricted to ASCII. JSON key order is ordinal canonical order.
  var names=(string[])Keys.Clone();Array.Sort(names,StringComparer.Ordinal);var b=new StringBuilder("{");
  foreach(string k in names){if(b.Length>1)b.Append(',');b.Append('"').Append(k).Append("\":\"").Append(Escape((string)v[k])).Append('"');}
  CanonicalJson=b.Append('}').ToString();Sha256=HashBytes(new UTF8Encoding(false,true).GetBytes(CanonicalJson));
 }
 static string Escape(string s){return s.Replace("\\","\\\\").Replace("\"","\\\"");}
 static void Deny(string c){throw new InvalidOperationException(c);}
 static bool Match(string s,string pattern){return Regex.IsMatch(s,pattern,RegexOptions.CultureInvariant);}
 public static bool Hash(string v){return v!=null&&v.Length==64&&Match(v,@"\A[0-9a-f]{64}\z");}
 public static string[] HelperBootstrapPins(string[] args){
  if(args==null||args.Length!=4||args[0]!="--acceptance-sha256"||args[2]!="--node-profile-sha256"||!Hash(args[1])||!Hash(args[3]))Deny("EXACT_PROFILE_BOOTSTRAP_ARGUMENTS_REQUIRED");return new[]{args[1],args[3]};
 }
 public static string HashBytes(byte[] b){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 public static NodeProfileV2 FromDictionary(Dictionary<string,object> v){
  if(v==null||v.Count!=Keys.Length)Deny("NODE_PROFILE_FIELDS_REQUIRED");
  foreach(string k in Keys)if(!v.ContainsKey(k)||!(v[k] is string))Deny("NODE_PROFILE_FIELDS_REQUIRED");
  if((string)v["contract"]!=Contract)Deny("NODE_PROFILE_FIELDS_REQUIRED");
  string name=(string)v["nodeName"],host=(string)v["hostname"],owner=(string)v["ownerSid"],controller=(string)v["controllerSid"];
  var a=Sid.Match(owner);var c=Sid.Match(controller);ulong rid;
  if(!Match(name,@"\A[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z")||!Match(host,@"\A[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?\z")||!a.Success||!c.Success||owner==controller||!UInt64.TryParse(c.Groups[1].Value,NumberStyles.None,CultureInfo.InvariantCulture,out rid)||rid<1000
   ||!Match((string)v["ownerProfileDirectory"],@"\AC:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z")
   ||!Match((string)v["runnerService"],@"\Aactions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\z")
   ||(string)v["mutationMutex"]!="Global\\CluedControlControllerMutationV1-"+host+"-"+c.Groups[1].Value
   ||!Match((string)v["wslDistribution"],@"\A[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z"))Deny("NODE_PROFILE_INVALID");
  // Do not run SID through SecurityIdentifier here: it may normalize the original string.
  // Actual Windows identity/account checks later compare the OS's SID string exactly.
  return new NodeProfileV2(v);
 }
 public static NodeProfileV2 Current {get{lock(Gate){if(current==null)Deny("NODE_PROFILE_NOT_BOOTSTRAPPED");return current;}}}
 public static string AcceptanceSha256 {get{lock(Gate){if(current==null)Deny("NODE_PROFILE_NOT_BOOTSTRAPPED");return currentAcceptance;}}}
 // Internal assembly boundary; production callers bind only a stable protected LoadAccepted result.
 // The separately compiled pure harness may bind a fully validated fixture without any Host call.
 internal static void BindForProcess(NodeProfileV2 value,string acceptanceSha256){
  if(value==null||!Hash(acceptanceSha256))Deny("NODE_PROFILE_BOOTSTRAP_PIN_REQUIRED");
  lock(Gate){if(current!=null&&(current.CanonicalJson!=value.CanonicalJson||currentAcceptance!=acceptanceSha256))Deny("NODE_PROFILE_REBIND_REFUSED");current=value;currentAcceptance=acceptanceSha256;}
 }
 public static void RequireRoot(string root){
  if(root==null||!String.Equals(Path.GetFullPath(root).TrimEnd('\\'),FixedResidentRoot,StringComparison.OrdinalIgnoreCase))Deny("FIXED_PROFILE_RECORD_ROOT_REQUIRED");
 }
 public static Dictionary<string,object> Parse(byte[] bytes){
  if(bytes==null||bytes.Length==0||bytes.Length>4*1024*1024)Deny("PROFILE_PUBLIC_BYTES_BOUND");
  var s=new UTF8Encoding(false,true).GetString(bytes);var v=new JavaScriptSerializer{MaxJsonLength=4*1024*1024,RecursionLimit=32}.DeserializeObject(s) as Dictionary<string,object>;
  if(v==null)Deny("PROFILE_PUBLIC_OBJECT_REQUIRED");return v;
 }
 static NodeProfileLeaseV2 Load(string root,string acceptanceSha256,string profileSha256){
  RequireRoot(root);if(!Hash(profileSha256)||acceptanceSha256!=null&&!Hash(acceptanceSha256))Deny("NODE_PROFILE_BOOTSTRAP_PIN_REQUIRED");
  var file=NodeProfilePublicFileV2.OpenFixed(root,false,acceptanceSha256);
  try{
   var a=Parse(file.Raw);object raw=null,contract=null,host=null,accepted=null;
   if(!a.TryGetValue("contract",out contract)||(contract as string)!="clued.independent-ci.accepted-installation/2"||!a.TryGetValue("accepted",out accepted)||!(accepted is bool)||!(bool)accepted||!a.TryGetValue("node",out raw))Deny("PROTECTED_NODE_PROFILE_REQUIRED");
   var node=FromDictionary(raw as Dictionary<string,object>);
   if(node.Sha256!=profileSha256||!a.TryGetValue("hostname",out host)||(host as string)!=node.Hostname)Deny("PROTECTED_NODE_PROFILE_CHANGED");
   file.Revalidate();return new NodeProfileLeaseV2(file,node);
  }catch{file.Dispose();throw;}
 }
 // PS archive/relay: only the independently pinned public node, not acceptance/Source authority.
 public static NodeProfileLeaseV2 LoadProtectedProfile(string root,string expectedProfileSha256){return Load(root,null,expectedProfileSha256);}
 // Broker/helper bootstrap: the complete acceptance RAW SHA is independently pinned too.
 public static NodeProfileLeaseV2 LoadAccepted(string root,string acceptanceSha256,string profileSha256){
  if(!Hash(acceptanceSha256))Deny("NODE_PROFILE_BOOTSTRAP_PIN_REQUIRED");var lease=Load(root,acceptanceSha256,profileSha256);
  try{BindForProcess(lease.Profile,acceptanceSha256);return lease;}catch{lease.Dispose();throw;}
 }
 public static NodeProfilePublicFileV2 ReadBrokerConfig(string root,string expectedSha256){RequireRoot(root);if(!Hash(expectedSha256))Deny("BROKER_CONFIG_PIN_REQUIRED");return NodeProfilePublicFileV2.OpenFixed(root,true,expectedSha256);}
}

public sealed class NodeProfileLeaseV2:IDisposable {
 readonly NodeProfilePublicFileV2 file;public readonly NodeProfileV2 Profile;
 internal NodeProfileLeaseV2(NodeProfilePublicFileV2 f,NodeProfileV2 p){file=f;Profile=p;}
 public string AcceptanceRawSha256 {get{return file.RawSha256;}}
 public void Revalidate(){file.Revalidate();}
 public void Dispose(){file.Dispose();}
}

// Two fixed public leaves only; no key/token path, directory enumeration, writes or ACL mutation.
// Parent directories and same file handle stay held without FILE_SHARE_DELETE for the lease lifetime.
public sealed class NodeProfilePublicFileV2:IDisposable {
 static readonly string[] Managers={"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"};
 readonly List<IDisposable> held=new List<IDisposable>();readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();readonly List<string> paths=new List<string>();readonly List<Info> initial=new List<Info>();readonly List<byte[]> descriptors=new List<byte[]>();
 byte[] raw;bool disposed;public byte[] Raw {get{if(disposed)Deny("PROFILE_LEASE_CLOSED");return(byte[])raw.Clone();}}public string RawSha256 {get;private set;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint f);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint flags,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static void Deny(string c){throw new InvalidOperationException(c);}
 static bool Below(string p,string root){return p.Equals(root,StringComparison.OrdinalIgnoreCase)||p.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase);}
 static Info Metadata(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))Deny("PROFILE_HANDLE_METADATA_REFUSED");return i;}
 static byte[] Security(SafeFileHandle h){IntPtr o,g,d,s,p;if(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p)!=0)Deny("PROFILE_HANDLE_DACL_REFUSED");try{uint n=GetSecurityDescriptorLength(p);if(n<20||n>65536)Deny("PROFILE_DESCRIPTOR_BOUND");var b=new byte[n];Marshal.Copy(p,b,0,(int)n);return b;}finally{LocalFree(p);}}
 public static void ValidateBootstrapAcl(byte[] bytes,string path){
  var sd=new RawSecurityDescriptor(bytes,0);if(sd.Owner==null||Array.IndexOf(Managers,sd.Owner.Value)<0)Deny("PROFILE_MANAGEMENT_OWNER_REQUIRED");if(sd.DiscretionaryAcl==null||sd.DiscretionaryAcl.Count>128)Deny("PROFILE_NULL_DACL_REFUSED");
  var danger=FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
  bool protectedTree=Below(path,"C:\\ProgramData\\CluedIndependentCI");if(protectedTree)danger|=FileSystemRights.Write;
  foreach(GenericAce item in sd.DiscretionaryAcl){var ace=item as CommonAce;if(ace==null||ace.IsCallback)Deny("PROFILE_ACE_FORM_REFUSED");if(ace.AceQualifier==AceQualifier.AccessDenied)continue;if(ace.AceQualifier!=AceQualifier.AccessAllowed)Deny("PROFILE_ACE_FORM_REFUSED");if((ace.AceFlags&AceFlags.InheritOnly)!=0)continue;
   // Raw generic rights are not expanded by RawSecurityDescriptor. GA always includes delete/DACL
   // mutation; GW includes protected-file writes. Treat them exactly as their mapped rights.
   uint mask=(uint)ace.AccessMask;if(Array.IndexOf(Managers,ace.SecurityIdentifier.Value)<0&&(mask&((uint)danger|0x10000000u|(protectedTree?0x40000000u:0u)))!=0)Deny("PROFILE_UNTRUSTED_MUTATION_RIGHT_REFUSED");
  }
 }
 static bool Same(Info a,Info b){return a.Attributes==b.Attributes&&a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow&&a.Created.dwHighDateTime==b.Created.dwHighDateTime&&a.Created.dwLowDateTime==b.Created.dwLowDateTime&&((a.Attributes&0x10)!=0||a.SizeHigh==b.SizeHigh&&a.SizeLow==b.SizeLow&&a.Links==b.Links&&a.Written.dwHighDateTime==b.Written.dwHighDateTime&&a.Written.dwLowDateTime==b.Written.dwLowDateTime);}
 static bool Equal(byte[] a,byte[] b){if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
 void Final(SafeFileHandle h,string path){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,32768,0);if(n==0||n>=32768||!String.Equals(b.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))Deny("PROFILE_HANDLE_PATH_REFUSED");}
 SafeFileHandle Open(string path,bool file,uint maximum){
  var h=CreateFileW(path,file?0x80020080u:0x20080u,file?1u:3u,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  if(h.IsInvalid){h.Dispose();Deny("PROFILE_HANDLE_OPEN_REFUSED");}
  try{var i=Metadata(h);if((i.Attributes&0x400)!=0||file&&((i.Attributes&0x10)!=0||i.Links!=1||i.SizeHigh!=0||i.SizeLow==0||i.SizeLow>maximum)||!file&&(i.Attributes&0x10)==0)Deny("PROFILE_TYPE_LINK_SIZE_REFUSED");Final(h,path);var acl=Security(h);ValidateBootstrapAcl(acl,path);held.Add(h);handles.Add(h);paths.Add(path);initial.Add(i);descriptors.Add(acl);return h;}catch{h.Dispose();throw;}
 }
 internal static NodeProfilePublicFileV2 OpenFixed(string root,bool broker,string expected){
  NodeProfileV2.RequireRoot(root);var item=new NodeProfilePublicFileV2();
  try{
   string target=NodeProfileV2.FixedResidentRoot+(broker?"\\config\\broker.json":"\\record\\acceptance.json");var chain=new List<string>();for(string p=Path.GetDirectoryName(target);p!=null;p=Path.GetDirectoryName(p))chain.Insert(0,p);
   foreach(string p in chain)item.Open(p,false,0);uint maximum=broker?16384u:4u*1024*1024;var handle=item.Open(target,true,maximum);var stream=new FileStream(handle,FileAccess.Read);item.held.Add(stream);
   var bytes=new byte[maximum+1];int total=0,n;while((n=stream.Read(bytes,total,bytes.Length-total))>0){total+=n;if(total>maximum)Deny("PROFILE_PUBLIC_BYTES_BOUND");}if(total==0)Deny("PROFILE_PUBLIC_BYTES_BOUND");item.raw=new byte[total];Array.Copy(bytes,item.raw,total);item.RawSha256=NodeProfileV2.HashBytes(item.raw);
   if(expected!=null&&item.RawSha256!=expected)Deny("PROFILE_ACCEPTANCE_RAW_CHANGED");item.Revalidate();return item;
  }catch{item.Dispose();throw;}
 }
 public void Revalidate(){if(disposed)Deny("PROFILE_LEASE_CLOSED");for(int i=0;i<handles.Count;i++){Final(handles[i],paths[i]);if(!Same(initial[i],Metadata(handles[i])))Deny("PROFILE_PUBLIC_FILE_CHANGED");var now=Security(handles[i]);ValidateBootstrapAcl(now,paths[i]);if(!Equal(now,descriptors[i]))Deny("PROFILE_PUBLIC_ACL_CHANGED");}}
 public void Dispose(){if(disposed)return;disposed=true;for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();handles.Clear();}
}
