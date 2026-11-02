using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Globalization;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Generic, installed-once stage helper boundary (DESIGN S12, with S3, S5, S6). It is the reviewed v1
// FormalPublicBoundary.cs with these changes only:
//   - no compiled ExpectedConfigSha256: the plan digest arrives as the helper's second start argument
//     (from CluedCISwapBroker) and is checked against resident\stage\<nonce>\formal-service-entry.json;
//     so ONE helper binary serves every stage and every batch (no per-batch csc, no rNN archives);
//   - the install facts come from the claim-free record (resident\record\*, admin-only), the Source from
//     resident\source\<sourceManifestSha256>\ only (S12: code only from source\<sha>);
//   - jobs are contract /3 (no claim; id over content + tested commit + attempt; attempt 1..2) (S6, quota phase 2 step 3b);
//   - the runtime window is the stage cap bounded by the install's validUntil, never by a claim and never
//     by 24 h (S5);
//   - the exact ACL model admits the resident SID as owner/writer of its own stage directory and as a
//     writer of the formal spool (archive renames), nothing else (S3).
// Fixed public bytes only. It never opens an App key, CI token or a stdout stream.
public sealed class FormalPublicBoundaryV2 : IDisposable {
 public const string Root="C:\\ProgramData\\CluedIndependentCI",Resident=Root+"\\resident",Record=Resident+"\\record",StageRoot=Resident+"\\stage",SourceBase=Resident+"\\source";
 public const string StateV2=Root+"\\state\\v2",Receipts=StateV2+"\\receipts",Temp=StateV2+"\\temp";
 public const string Spool=Root+"\\formal-spool",Outgoing=Spool+"\\outgoing",Incoming=Spool+"\\incoming";
 // The package's own pinned node (install-resident.ps1 runtime\node.exe = record controllerNodeSha256), never the
 // machine's shared C:\Program Files\nodejs: every node runs exactly the node its package pins.
 public const string Node=Resident+"\\runtime\\node.exe";
 public static string Controller {get{return NodeProfileV2.Current.ControllerSid;}}
 public static string OwnerUser {get{return NodeProfileV2.Current.OwnerSid;}}
 public const string ResidentSid="S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629";
 static readonly string[] Management={"S-1-5-18","S-1-5-32-544","S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"};
 const string P="work/actions-hosted-migration/independent-ci-v1/";
 // Stage 9 is stage R, the hosted relay (free-minutes design S19/S22): entry relay-publisher, a non-empty
 // ordered subset of its job roles (the relay candidates; contract-placement is never relayed).
 public const int RelayStage=9;
 // Stage 10 (quota phase 2 step 3c-1, DESIGN §22.1): train maintenance, outside every batch. Its one job is a train run
 // (train-run.mjs: contract clued.independent-ci.train-run/2, mode shadow, on or revoke-only), never a job of contract /3.
 public const int TrainStage=10;
 public const int RoleProbeStage=11;
 public const int RevocationStage=12;
 public static readonly string[] StageRole={"work-admission","scanner-issuer","check-publisher","scanner-issuer","check-publisher","scanner-issuer","check-publisher","control-checks","relay-publisher","train-maintenance","role-probe","revocation-maintenance"};
 public static readonly uint[] StageMilliseconds={900000,2700000,900000,1800000,900000,600000,900000,2700000,900000,300000,60000,300000};
 public static readonly string[][] StageJobRoles={new[]{"work-admission"},new[]{"gitleaks"},new[]{"gitleaks"},new[]{"trivy"},new[]{"trivy"},new[]{"contract-placement"},new[]{"contract-placement"},new[]{"control-admission","control-merge-slot"},new[]{"gitleaks","trivy"},new[]{"train-run"},new[]{"role-probe-run"},new[]{"revocation-maintenance-run"}};
 // The job roles a stage package may carry: exactly the row's, or (stage R) a non-empty ordered subset.
 public static string[] SelectedJobRoles(int stage,object[] jobs){
  if(stage<1||stage>StageRole.Length||jobs==null)Deny("EXACT_STAGE_JOBS_REQUIRED");string[] row=StageJobRoles[stage-1];
  if(stage!=RelayStage){if(jobs.Length!=row.Length)Deny("EXACT_STAGE_JOBS_REQUIRED");return row;}
  if(jobs.Length<1||jobs.Length>row.Length)Deny("EXACT_STAGE_JOBS_REQUIRED");var roles=new string[jobs.Length];int last=-1;
  for(int i=0;i<jobs.Length;i++){var j=jobs[i] as Dictionary<string,object>;string r=j==null?null:j.ContainsKey("role")?j["role"] as string:null;int at=r==null?-1:Array.IndexOf(row,r);if(at<=last)Deny("EXACT_STAGE_JOBS_REQUIRED");last=at;roles[i]=r;}
  return roles;
 }
 public static string RelativeEntryForRole(string role){
  if(role=="work-admission")return P+"src/formal-work-admission-check-v2/startup.mjs";
  if(role=="scanner-issuer")return P+"worker/protected-job-bridge-v4/windows-issuer.mjs";
  if(role=="check-publisher")return P+"runtime/one-shot-v2.mjs";
  if(role=="control-checks")return P+"src/independent-control-checks-v2/startup.mjs";
  if(role=="relay-publisher")return P+"src/hosted-relay-v1/relay-entry-v2.mjs";
  if(role=="train-maintenance")return P+"src/independent-control-checks-v2/train-maintenance.mjs";
  if(role=="role-probe")return P+"src/resident-v2/role-probe-entry.mjs";
  if(role=="revocation-maintenance")return P+"src/resident-v2/revocation-entry.mjs";
  Deny("FIXED_FORMAL_ENTRY_ROLE_REQUIRED");return null;
 }
 // Every v2 entry imports these; a record that does not pin them is not a Source v2 record.
 static readonly string[] CoreSource={"scripts/ci/clued-work-admission.mjs","config/merge-admission-policy.json",P+"src/proof.mjs",P+"src/job-v2.mjs",P+"src/proof-v2.mjs",
  P+"src/full-admission-v2.mjs",P+"src/batch-claim-v2.mjs",P+"src/effect-journal.mjs",P+"src/github.mjs",P+"src/resident-v2/layout.mjs",P+"src/resident-v2/prepare-record.mjs",
  P+"src/resident-v2/record.mjs",P+"src/resident-v2/stage-package.mjs",P+"src/resident-v2/stage-inputs.mjs",P+"src/resident-v2/windows/NodeProfileV2.cs",P+"src/independent-control-checks-v2/queue-facts.mjs"};
 public string Nonce,ConfigHash,SelectedRole,EntryHash,AcceptanceHash,SourceManifestHash,SourceRoot;public int Stage;public DateTimeOffset RuntimeDeadlineUtc;DateTimeOffset acceptedExpiry;
 public string Command {get{return CommandFor(SelectedRole,SourceRoot,Nonce,ConfigHash);}}
 public static string CommandFor(string role,string sourceRoot,string nonce,string config){
  if(!ValidNonce(nonce)||!Hash(config))Deny("FIXED_ENTRY_ARGUMENTS_REQUIRED");
  return "\""+Node+"\" \""+sourceRoot+"\\"+RelativeEntryForRole(role).Replace('/','\\')+"\" --run --stage "+nonce+" --config-sha256 "+config;
 }
 readonly List<IDisposable> held=new List<IDisposable>();
 readonly HashSet<string> directories=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
 readonly Action checkpoint;long total;readonly DateTime started=DateTime.UtcNow;
 public FormalPublicBoundaryV2(Action check){checkpoint=check;}
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint f);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint flags,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static void Deny(string c){throw new InvalidOperationException(c);}
 public static bool Hash(string s){if(s==null||s.Length!=64)return false;foreach(char c in s)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 public static bool LowerHex(string s){if(String.IsNullOrEmpty(s))return false;foreach(char c in s)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 public static bool ValidNonce(string n){return n!=null&&n.Length==32&&LowerHex(n);}
 public static bool Uuid(string s){Guid g;return s!=null&&s.Length==36&&Guid.TryParseExact(s,"D",out g)&&g!=Guid.Empty;}
 static bool Commit(string v){if(v==null||v.Length!=40)return false;foreach(char c in v)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;return true;}
 public static string SafeRelative(string value){
  if(String.IsNullOrEmpty(value)||value.Length>512||value[0]=='/'||value.IndexOf('\\')>=0||value.IndexOf(':')>=0)Deny("SOURCE_RELATIVE_PATH_REFUSED");
  foreach(char c in value)if(Char.IsControl(c))Deny("SOURCE_RELATIVE_PATH_REFUSED");
  foreach(string part in value.Split('/'))if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" "))Deny("SOURCE_RELATIVE_PATH_REFUSED");
  return value;
 }
 public static Dictionary<string,object> Parse(byte[] bytes){
  var text=new UTF8Encoding(false,true).GetString(bytes);var json=new JavaScriptSerializer{MaxJsonLength=8*1024*1024,RecursionLimit=32};
  var map=json.DeserializeObject(text) as Dictionary<string,object>;if(map==null)Deny("PUBLIC_OBJECT_REQUIRED");return map;
 }
 static object At(Dictionary<string,object> m,string k){object v;if(!m.TryGetValue(k,out v))Deny("PUBLIC_FIELD_MISSING");return v;}
 public static string Text(Dictionary<string,object> m,string k){var s=At(m,k) as string;if(s==null)Deny("PUBLIC_STRING_REQUIRED");return s;}
 static void Exact(Dictionary<string,object> m,string k,string want){if(Text(m,k)!=want)Deny("FIXED_PUBLIC_IDENTITY_REFUSED");}
 static void True(Dictionary<string,object> m,string k){if(!(At(m,k) is bool)||!(bool)At(m,k))Deny("REAL_ACCEPTANCE_REQUIRED");}
 static string Sha(Dictionary<string,object> m,string k){string s=Text(m,k);if(!Hash(s))Deny("REAL_PUBLIC_HASH_REQUIRED");return s;}
 static string Ref(Dictionary<string,object> m,string k){string s=Text(m,k);if(!Uuid(s))Deny("REAL_ACCEPTANCE_REFERENCE_REQUIRED");return s;}
 static long Int(Dictionary<string,object> m,string k){object v=At(m,k);if(!(v is int||v is long))Deny("PUBLIC_INTEGER_REQUIRED");return Convert.ToInt64(v);}
 static bool Below(string p,string root){return p.Equals(root,StringComparison.OrdinalIgnoreCase)||p.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase);}
 public static void Fields(Dictionary<string,object> m,string[] fields){if(m==null||m.Count!=fields.Length)Deny("EXACT_PUBLIC_FIELDS_REQUIRED");foreach(string f in fields)At(m,f);}
 void Check(){checkpoint();if((DateTime.UtcNow-started).TotalSeconds>120)Deny("PUBLIC_PREFLIGHT_TIMEOUT");}
 static Info Metadata(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))Deny("PUBLIC_METADATA_REFUSED");return i;}
 static void Final(SafeFileHandle h,string path){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,32768,0);if(n==0||n>=32768||!String.Equals(b.ToString().TrimEnd('\\'),("\\\\?\\"+path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))Deny("PUBLIC_HANDLE_PATH_REFUSED");}
 static FileSecurity Security(SafeFileHandle h){IntPtr o,g,d,s,p;if(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p)!=0)Deny("PUBLIC_HANDLE_DACL_REFUSED");try{uint n=GetSecurityDescriptorLength(p);if(n<20||n>65536)Deny("PUBLIC_DESCRIPTOR_SIZE_REFUSED");var b=new byte[n];Marshal.Copy(p,b,0,(int)n);var a=new FileSecurity();a.SetSecurityDescriptorBinaryForm(b);return a;}finally{LocalFree(p);}}
 // S3: the exact ownership/writer model. Pure, unit-tested offline.
 public static bool OwnerAllowed(string path,string owner){return Array.IndexOf(Management,owner)>=0||(Below(path,StageRoot)&&owner==ResidentSid);}
 public static bool WriterAllowed(string path,string sid){
  if(Array.IndexOf(Management,sid)>=0)return true;
  if((Below(path,StateV2)||Below(path,Outgoing))&&sid==Controller)return true;
  if(Below(path,Incoming)&&sid==OwnerUser)return true;
  if((Below(path,StageRoot)||Below(path,Spool))&&sid==ResidentSid)return true;
  return false;
 }
 public static FileSystemRights DangerFor(string path){var danger=FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;if(Below(path,Root)||Below(path,"C:\\Program Files\\nodejs"))danger|=FileSystemRights.Write;return danger;}
 static void Acl(SafeFileHandle h,string path){
  var a=Security(h);string owner=a.GetOwner(typeof(SecurityIdentifier)).Value;if(!OwnerAllowed(path,owner))Deny("PUBLIC_MANAGEMENT_OWNER_REQUIRED");
  var raw=new RawSecurityDescriptor(a.GetSecurityDescriptorBinaryForm(),0);if(raw.DiscretionaryAcl==null)Deny("PUBLIC_NULL_DACL_REFUSED");
  var danger=DangerFor(path);
  foreach(FileSystemAccessRule r in a.GetAccessRules(true,true,typeof(SecurityIdentifier))){if(r.AccessControlType!=AccessControlType.Allow||(r.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;if((r.FileSystemRights&danger)!=0&&!WriterAllowed(path,r.IdentityReference.Value))Deny("UNTRUSTED_PUBLIC_MUTATION_RIGHT_REFUSED");}
 }
 SafeFileHandle Open(string path,bool file){
  Check();var h=CreateFileW(path,file?0x80020080u:0x20080u,file?1u:3u,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(h.IsInvalid){h.Dispose();Deny("PUBLIC_HANDLE_OPEN_REFUSED");}
  try{var i=Metadata(h);uint maximum=path==Node?256u*1024*1024:16u*1024*1024;if((i.Attributes&0x400)!=0||file&&((i.Attributes&0x10)!=0||i.Links!=1||i.SizeHigh!=0||i.SizeLow==0||i.SizeLow>maximum)||!file&&(i.Attributes&0x10)==0)Deny("PUBLIC_TYPE_LINK_SIZE_REFUSED");Final(h,path);Acl(h,path);held.Add(h);return h;}catch{h.Dispose();throw;}
 }
 void Parents(string path){var chain=new List<string>();for(string p=Path.GetDirectoryName(path);p!=null;p=Path.GetDirectoryName(p))chain.Insert(0,p);foreach(string p in chain)if(directories.Add(p))Open(p,false);}
 byte[] Read(string path,string expected,bool content){
  if(expected!=null&&!Hash(expected))Deny("REAL_PUBLIC_HASH_REQUIRED");Parents(path);var h=Open(path,true);var f=new FileStream(h,FileAccess.Read);held.Add(f);var sha=SHA256.Create();var buffer=new byte[65536];MemoryStream copy=content?new MemoryStream():null;
  try{int n;while((n=f.Read(buffer,0,buffer.Length))>0){Check();total+=n;if(total>512L*1024*1024)Deny("SOURCE_BYTE_BOUND_EXCEEDED");sha.TransformBlock(buffer,0,n,null,0);if(copy!=null)copy.Write(buffer,0,n);}sha.TransformFinalBlock(new byte[0],0,0);string actual=BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();if(expected!=null&&actual!=expected)Deny("EXACT_PUBLIC_BYTES_REFUSED");return copy==null?null:copy.ToArray();}finally{sha.Dispose();if(copy!=null)copy.Dispose();}
 }
 public static void NoLegacy(object v){var m=v as Dictionary<string,object>;if(m!=null)foreach(var p in m){if(p.Key=="ciTokenSha256"||p.Key=="currentClaim")Deny("REPLAYABLE_OR_CLAIM_BOUND_INPUT_REFUSED");NoLegacy(p.Value);}var a=v as object[];if(a!=null)foreach(var x in a)NoLegacy(x);}
 static readonly string[] PlanFields={"contract","enabled","stage","entryRole","batchKey","batchId","ownerPackageAcceptanceRef","nodeSha256","nodeProfileSha256","entrySha256","acceptanceSha256","sourceManifestSha256","installationSha256","runtimeConfigPinSha256","jobSha256"};
 public static int PlanStage(Dictionary<string,object> plan){
  Fields(plan,PlanFields);Exact(plan,"contract","clued.independent-ci.fixed-formal-windows-entry/3");True(plan,"enabled");long stage=Int(plan,"stage");if(stage<1||stage>StageRole.Length)Deny("FIXED_FORMAL_STAGE_REQUIRED");
  if(Text(plan,"entryRole")!=StageRole[stage-1])Deny("FIXED_FORMAL_ENTRY_ROLE_REQUIRED");Ref(plan,"ownerPackageAcceptanceRef");Sha(plan,"batchKey");
  string id=Text(plan,"batchId");if(id.Length!=29||id[16]!='-'||!LowerHex(id.Substring(0,16))||!LowerHex(id.Substring(17)))Deny("FIXED_BATCH_ID_REQUIRED");
  foreach(string f in new[]{"nodeSha256","nodeProfileSha256","entrySha256","acceptanceSha256","sourceManifestSha256","installationSha256","runtimeConfigPinSha256","jobSha256"})Sha(plan,f);return (int)stage;
 }
 // Job contract /3 (quota phase 2 step 3b): id = sha256(JSON(["clued.independent-ci.job/3",repo,pr,headSha,baseSha,testSha,sourceManifestSha256,role,attempt])).
 // testSha is the tested commit S (S = H outside the train). The method keeps its V2 (Source v2) name.
 public static string JobIdV2(Dictionary<string,object> job){
  var identity=new List<object>{"clued.independent-ci.job/3",At(job,"repo"),At(job,"pr"),At(job,"headSha"),At(job,"baseSha"),At(job,"testSha"),At(job,"sourceManifestSha256"),At(job,"role"),At(job,"attempt")};
  byte[] raw=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(identity));using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(raw)).Replace("-","").ToLowerInvariant();
 }
 // Train run /2 (step 3c-2b, DESIGN §41.7; train-run.mjs is the same table, test/fixtures/train-run-cases.json runs on both):
 // id = sha256(JSON(["clued.independent-ci.train-run/2",repo,runId,mode,sourceManifestSha256,slotHardCapMinutes,frontBatchBudgetMs,
 // sweepFreshMs,fullSweepMaxMs,onSince,frontPr,frontHeadSha,frontTestSha,frontAttempt,frontCode,revokeHeadRequestId])).
 static readonly string[] TrainRunFields={"contract","id","repo","runId","mode","sourceManifestSha256","createdAt","slotHardCapMinutes","frontBatchBudgetMs","sweepFreshMs","fullSweepMaxMs","onSince","frontPr","frontHeadSha","frontTestSha","frontAttempt","frontCode","revokeHeadRequestId"};
 static readonly string[] TrainRunFront={"frontPr","frontHeadSha","frontTestSha","frontAttempt","frontCode"};
 public static string TrainRunId(Dictionary<string,object> job){
  var identity=new List<object>{"clued.independent-ci.train-run/2"};foreach(string f in TrainRunFields)if(f!="contract"&&f!="id"&&f!="createdAt")identity.Add(At(job,f));
  byte[] raw=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(identity));using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(raw)).Replace("-","").ToLowerInvariant();
 }
 static void Within(Dictionary<string,object> m,string k,long lo,long hi){long v=Int(m,k);if(v<lo||v>hi)Deny("TRAIN_RUN_PARAMS_REQUIRED");}
 // Exactly what toISOString writes; lower-case UUID; an upper-case code: the JS patterns of train-run.mjs.
 public static bool IsoMs(object v){var s=v as string;DateTime t;return s!=null&&s.Length==24&&DateTime.TryParseExact(s,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal,out t);}
 public static bool LowerUuid(object v){var s=v as string;if(s==null||s.Length!=36)return false;for(int i=0;i<36;i++){char c=s[i];if(i==8||i==13||i==18||i==23){if(c!='-')return false;}else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;}return true;}
 public static bool UpperCode(object v){var s=v as string;if(s==null||s.Length<2||s.Length>80||s[0]<'A'||s[0]>'Z')return false;foreach(char c in s)if(!((c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'))return false;return true;}
 public static Dictionary<string,object> ValidateTrainRun(Dictionary<string,object> job,string sourceManifest,string batchId){
  Fields(job,TrainRunFields);Exact(job,"contract","clued.independent-ci.train-run/2");Exact(job,"repo","tdoljyj/cross-memory-system");
  string mode=Text(job,"mode");if(mode!="shadow"&&mode!="on"&&mode!="revoke-only")Deny("FIXED_PUBLIC_IDENTITY_REFUSED");Sha(job,"id");string run=Text(job,"runId");
  if(run!=batchId||run.Length!=29||run[16]!='-'||!LowerHex(run.Substring(0,16))||!LowerHex(run.Substring(17))||Sha(job,"sourceManifestSha256")!=sourceManifest)Deny("FIXED_TRAIN_RUN_REQUIRED");
  DateTimeOffset created;if(!DateTimeOffset.TryParse(Text(job,"createdAt"),CultureInfo.InvariantCulture,DateTimeStyles.None,out created)||created>DateTimeOffset.UtcNow.AddMinutes(5))Deny("FIXED_FORMAL_JOB_TIME_REQUIRED");
  Within(job,"slotHardCapMinutes",60,180);Within(job,"frontBatchBudgetMs",60000,10800000);Within(job,"sweepFreshMs",60000,3600000);Within(job,"fullSweepMaxMs",600000,86400000);
  // onSince: null in shadow, set in on, either in revoke-only. frontOutcome: all null, or all set in on only. revokeHeadRequestId: null in shadow.
  object since=At(job,"onSince");if(!(since==null||IsoMs(since))||(mode=="shadow"&&since!=null)||(mode=="on"&&since==null))Deny("TRAIN_RUN_PARAMS_REQUIRED");
  bool none=true;foreach(string f in TrainRunFront)if(At(job,f)!=null)none=false;
  if(!none){if(mode!="on"||!Commit(At(job,"frontHeadSha") as string)||!Commit(At(job,"frontTestSha") as string)||!UpperCode(At(job,"frontCode")))Deny("TRAIN_RUN_PARAMS_REQUIRED");Within(job,"frontPr",1,9007199254740991);Within(job,"frontAttempt",1,2);}
  object request=At(job,"revokeHeadRequestId");if(!(request==null||(mode!="shadow"&&LowerUuid(request))))Deny("TRAIN_RUN_PARAMS_REQUIRED");
  if(TrainRunId(job)!=Text(job,"id"))Deny("DETERMINISTIC_JOB_ID_REQUIRED");return job;
 }
 // C2 probe /1: no PR/head/claim/attempt fields. The complete current node profile is independently pinned by plan /3.
 public static string RoleProbeRunId(Dictionary<string,object> job){
  var identity=new List<object>{"clued.independent-ci.role-probe-run/1",At(job,"repo"),At(job,"runId"),At(job,"sourceManifestSha256"),At(job,"nodeProfileSha256")};
  byte[] raw=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(identity));using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(raw)).Replace("-","").ToLowerInvariant();
 }
 public static Dictionary<string,object> ValidateRoleProbeRun(Dictionary<string,object> job,string sourceManifest,string batchId,string profileSha){
  Fields(job,new[]{"contract","id","repo","runId","sourceManifestSha256","nodeProfileSha256","createdAt"});Exact(job,"contract","clued.independent-ci.role-probe-run/1");Exact(job,"repo","tdoljyj/cross-memory-system");Sha(job,"id");
  string run=Text(job,"runId");if(run!=batchId||run.Length!=29||run[16]!='-'||!LowerHex(run.Substring(0,16))||!LowerHex(run.Substring(17))||Sha(job,"sourceManifestSha256")!=sourceManifest||Sha(job,"nodeProfileSha256")!=profileSha)Deny("FIXED_ROLE_PROBE_RUN_REQUIRED");
  DateTimeOffset created;if(!DateTimeOffset.TryParse(Text(job,"createdAt"),CultureInfo.InvariantCulture,DateTimeStyles.None,out created)||created>DateTimeOffset.UtcNow.AddMinutes(5))Deny("FIXED_FORMAL_JOB_TIME_REQUIRED");
  if(RoleProbeRunId(job)!=Text(job,"id"))Deny("DETERMINISTIC_JOB_ID_REQUIRED");return job;
 }
 public static string RevocationRunId(Dictionary<string,object> job){
  var identity=new List<object>{"clued.independent-ci.revocation-maintenance-run/1",At(job,"repo"),At(job,"runId"),At(job,"sourceManifestSha256"),At(job,"nodeProfileSha256")};
  byte[] raw=new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(identity));using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(raw)).Replace("-","").ToLowerInvariant();
 }
 public static Dictionary<string,object> ValidateRevocationRun(Dictionary<string,object> job,string sourceManifest,string batchId,string profileSha){
  Fields(job,new[]{"contract","id","repo","runId","sourceManifestSha256","nodeProfileSha256","createdAt"});Exact(job,"contract","clued.independent-ci.revocation-maintenance-run/1");Exact(job,"repo","tdoljyj/cross-memory-system");Sha(job,"id");
  string run=Text(job,"runId");if(run!=batchId||run.Length!=29||run[16]!='-'||!LowerHex(run.Substring(0,16))||!LowerHex(run.Substring(17))||Sha(job,"sourceManifestSha256")!=sourceManifest||Sha(job,"nodeProfileSha256")!=profileSha)Deny("FIXED_REVOCATION_RUN_REQUIRED");
  DateTimeOffset created;if(!DateTimeOffset.TryParse(Text(job,"createdAt"),CultureInfo.InvariantCulture,DateTimeStyles.None,out created)||created>DateTimeOffset.UtcNow.AddMinutes(5))Deny("FIXED_FORMAL_JOB_TIME_REQUIRED");
  if(RevocationRunId(job)!=Text(job,"id"))Deny("DETERMINISTIC_JOB_ID_REQUIRED");return job;
 }
 public static Dictionary<string,object> ValidateJobV2(Dictionary<string,object> job,string expectedRole,string sourceManifest){
  Fields(job,new[]{"contract","id","repo","pr","headSha","baseSha","testSha","role","sourceManifestSha256","createdAt","attempt"});Exact(job,"contract","clued.independent-ci.job/3");Exact(job,"repo","tdoljyj/cross-memory-system");
  if(Text(job,"role")!=expectedRole)Deny("FIXED_FORMAL_JOB_ROLE_REQUIRED");Sha(job,"id");
  long pr=Int(job,"pr"),attempt=Int(job,"attempt");
  if(!Commit(Text(job,"headSha"))||!Commit(Text(job,"baseSha"))||!Commit(Text(job,"testSha"))||Sha(job,"sourceManifestSha256")!=sourceManifest||pr<1||attempt<1||attempt>2)Deny("FIXED_FORMAL_JOB_SUBJECT_REQUIRED");
  DateTimeOffset created;if(!DateTimeOffset.TryParse(Text(job,"createdAt"),CultureInfo.InvariantCulture,DateTimeStyles.None,out created)||created>DateTimeOffset.UtcNow.AddMinutes(5))Deny("FIXED_FORMAL_JOB_TIME_REQUIRED");
  if(JobIdV2(job)!=Text(job,"id"))Deny("DETERMINISTIC_JOB_ID_REQUIRED");return job;
 }
 public static Dictionary<string,string> SourcePins(Dictionary<string,object> accepted,string entryHash,string role){
  var rows=At(accepted,"sourceFiles") as object[];if(rows==null||rows.Length<CoreSource.Length||rows.Length>10000)Deny("COMPLETE_ACCEPTED_SOURCE_REQUIRED");var pins=new Dictionary<string,string>(StringComparer.Ordinal);
  foreach(var row in rows){var r=row as Dictionary<string,object>;if(r==null)Deny("SOURCE_PIN_OBJECT_REQUIRED");Fields(r,new[]{"path","sha256"});string p=SafeRelative(Text(r,"path")),h=Sha(r,"sha256");if(pins.ContainsKey(p))Deny("DUPLICATE_SOURCE_PIN_REFUSED");pins.Add(p,h);}
  foreach(string p in CoreSource)if(!pins.ContainsKey(p))Deny("ACCEPTED_SOURCE_CLOSURE_MISSING");
  string relative=RelativeEntryForRole(role);if(!pins.ContainsKey(relative)||pins[relative]!=entryHash)Deny("FIXED_RUNTIME_ENTRY_HASH_MISMATCH");return pins;
 }
 // S5: the stage cap, bounded only by the install's validUntil (null = until Source change/uninstall).
 public static DateTimeOffset BoundedDeadline(int stage,DateTimeOffset now,DateTimeOffset? validUntil){
  if(stage<1||stage>StageMilliseconds.Length)Deny("FIXED_RUNTIME_STAGE_REQUIRED");uint duration=StageMilliseconds[stage-1];
  if(validUntil.HasValue&&validUntil.Value<now.AddMilliseconds((long)duration+180000))Deny("FULL_FORMAL_ROLE_AND_RESTORE_WINDOW_REQUIRED");return now.AddMilliseconds(duration);
 }
 public uint RemainingRunMilliseconds(){double ms=(RuntimeDeadlineUtc-DateTimeOffset.UtcNow).TotalMilliseconds;if(ms<1||ms>StageMilliseconds[Stage-1])Deny("ACTUAL_FORMAL_RUNTIME_WINDOW_EXPIRED");return (uint)Math.Floor(ms);}
 static void SixChecks(Dictionary<string,object> config){
  var checks=At(config,"checks") as Dictionary<string,object>;string[] roles={"gitleaks","trivy","work-admission","contract-placement","control-admission","control-merge-slot"};string[] names={"gitleaks","trivy","kooyumi-work-admission","contract-placement","kooyumi-admission-verified","kooyumi-merge-slot"};Fields(checks,roles);
  for(int n=0;n<roles.Length;n++){var d=At(checks,roles[n]) as Dictionary<string,object>;Fields(d,new[]{"name","appId"});Exact(d,"name",names[n]);if(Int(d,"appId")!=5368905)Deny("SIX_FIXED_APP_MAPPINGS_REQUIRED");}
 }
 public void Validate(string nonce,string configSha256){
  if(!ValidNonce(nonce)||!Hash(configSha256))Deny("FIXED_HELPER_ARGUMENTS_REQUIRED");Nonce=nonce;ConfigHash=configSha256;
  string stageDir=StageRoot+"\\"+nonce;
  var plan=Parse(Read(stageDir+"\\formal-service-entry.json",ConfigHash,true));Stage=PlanStage(plan);SelectedRole=Text(plan,"entryRole");
  EntryHash=Sha(plan,"entrySha256");AcceptanceHash=Sha(plan,"acceptanceSha256");SourceManifestHash=Sha(plan,"sourceManifestSha256");string nodeHash=Sha(plan,"nodeSha256");
  if(AcceptanceHash!=NodeProfileV2.AcceptanceSha256||Sha(plan,"nodeProfileSha256")!=NodeProfileV2.Current.Sha256)Deny("NODE_PROFILE_STAGE_BINDING_CHANGED");
  SourceRoot=SourceBase+"\\"+SourceManifestHash;
  var config=Parse(Read(Record+"\\installation.json",Sha(plan,"installationSha256"),true));NoLegacy(config);
  Exact(config,"contract","clued.independent-ci.one-shot/2");True(config,"enabled");Exact(config,"repository","tdoljyj/cross-memory-system");
  if(Int(config,"appId")!=5368905||Int(config,"installationId")!=172706661||Int(config,"repositoryId")!=1334673495)Deny("FIXED_APP_REPOSITORY_REQUIRED");
  if(Sha(config,"acceptanceSha256")!=AcceptanceHash||Sha(config,"sourceManifestSha256")!=SourceManifestHash||Sha(config,"controllerNodeSha256")!=nodeHash)Deny("INSTALLED_PUBLIC_BINDING_CHANGED");SixChecks(config);
  var accepted=Parse(Read(Record+"\\acceptance.json",AcceptanceHash,true));NoLegacy(accepted);Exact(accepted,"contract","clued.independent-ci.accepted-installation/2");Exact(accepted,"domain","production");
  True(accepted,"accepted");True(accepted,"workerCannotReadController");Exact(accepted,"hostname",NodeProfileV2.Current.Hostname);Exact(accepted,"platform","win32");Exact(accepted,"arch","x64");Exact(accepted,"controllerAccount","clued-control");
  if(NodeProfileV2.FromDictionary(At(accepted,"node")as Dictionary<string,object>).CanonicalJson!=NodeProfileV2.Current.CanonicalJson)Deny("NODE_PROFILE_ACCEPTANCE_CHANGED");
  if(!(At(accepted,"claimBound") is bool)||(bool)At(accepted,"claimBound"))Deny("CLAIM_FREE_ACCEPTANCE_REQUIRED");
  foreach(string key in new[]{"sourceAcceptanceRef","hostQualificationRef","ownerAuthorizationRef","publisherQualificationRef","ciPrincipalQualificationRef","ownerPackageAcceptanceRef","installationReceiptRef","ownerDecisionRef","ownerReceiptRef"})Ref(accepted,key);
  if(Text(accepted,"ownerPackageAcceptanceRef")!=Text(plan,"ownerPackageAcceptanceRef")||Text(accepted,"ciPrincipalBindingId")!=Text(config,"ciPrincipalBindingId")||Sha(accepted,"ciTokenPinSha256")!=Sha(config,"ciTokenPinSha256")||Sha(accepted,"configSha256")!=Sha(plan,"runtimeConfigPinSha256"))Deny("ACTUAL_ACCEPTED_PACKAGE_BINDING_REQUIRED");
  DateTimeOffset start;if(!DateTimeOffset.TryParse(Text(accepted,"acceptedAt"),CultureInfo.InvariantCulture,DateTimeStyles.None,out start)||start>DateTimeOffset.UtcNow)Deny("ACTUAL_ACCEPTANCE_TIME_REQUIRED");
  object until=At(accepted,"validUntil");DateTimeOffset? validUntil=null;
  if(until!=null){DateTimeOffset end=DateTimeOffset.MinValue;if(!(until is string)||!DateTimeOffset.TryParse((string)until,CultureInfo.InvariantCulture,DateTimeStyles.None,out end)||end<=DateTimeOffset.UtcNow)Deny("ACTUAL_ACCEPTANCE_TIME_REQUIRED");validUntil=end;}
  acceptedExpiry=validUntil??DateTimeOffset.MaxValue;
  var pins=SourcePins(accepted,EntryHash,SelectedRole);
  var manifest=Parse(Read(Record+"\\source-manifest.json",SourceManifestHash,true));Exact(manifest,"schema","independent-ci.sources.v2");Exact(manifest,"repo","tdoljyj/cross-memory-system");
  var jobsBytes=Read(stageDir+"\\jobs.json",Sha(plan,"jobSha256"),true);var jobs=new JavaScriptSerializer().DeserializeObject(new UTF8Encoding(false,true).GetString(jobsBytes)) as object[];
  string[] roles=SelectedJobRoles(Stage,jobs);
  for(int i=0;i<roles.Length;i++){var j=jobs[i] as Dictionary<string,object>;if(j==null)Deny("EXACT_STAGE_JOBS_REQUIRED");
   if(Stage==TrainStage){ValidateTrainRun(j,SourceManifestHash,Text(plan,"batchId"));continue;}
   if(Stage==RoleProbeStage){ValidateRoleProbeRun(j,SourceManifestHash,Text(plan,"batchId"),Sha(plan,"nodeProfileSha256"));continue;}
   if(Stage==RevocationStage){ValidateRevocationRun(j,SourceManifestHash,Text(plan,"batchId"),Sha(plan,"nodeProfileSha256"));continue;}
   ValidateJobV2(j,roles[i],SourceManifestHash);
   if(i>0)foreach(string k in new[]{"repo","pr","headSha","baseSha","testSha","sourceManifestSha256","createdAt","attempt"})if(!Object.Equals(At(j,k),At((Dictionary<string,object>)jobs[0],k)))Deny("EXACT_CONTROL_PAIR_SUBJECT_REQUIRED");}
  if(SelectedRole=="check-publisher")Read(stageDir+"\\result.json",null,false); // signed untrusted input; the entry verifies it
  RuntimeDeadlineUtc=BoundedDeadline(Stage,DateTimeOffset.UtcNow,validUntil);
  Read(Node,nodeHash,false);
  foreach(var p in pins)Read(SourceRoot+"\\"+p.Key.Replace('/','\\'),p.Value,false);
  foreach(string p in new[]{StateV2,Receipts,Temp,Spool,Outgoing,Incoming}){Parents(p+"\\placeholder");if(directories.Add(p))Open(p,false);}
 }
 public void Dispose(){for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();}
}
