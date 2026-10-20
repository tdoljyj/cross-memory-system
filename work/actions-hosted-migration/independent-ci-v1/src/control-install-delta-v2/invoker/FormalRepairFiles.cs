// Compiled in the same C# unit immediately after the unchanged HostFiles.cs;
// its pinned imports and VerifyInstallFiles definition are deliberately reused.
// Single fixed public-leaf ReplaceFile protocol. This is not an OS atomic
// compare-and-swap or a multi-file transaction. Management ACL + held parents
// + the shared SCM cooperative mutex are required by the caller throughout.
public static class FormalRepairFiles {
 const string Root="C:\\ProgramData\\CluedIndependentCI";
 public static bool Same(VerifyInstallFiles.Info a,VerifyInstallFiles.Info b){return a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow;}
 public static string Fixed(string relative){
  if(relative!="source-manifest.json"&&relative!="source/scripts/ci/clued-work-admission.mjs"&&relative!="source/work/actions-hosted-migration/independent-ci-v1/src/full-admission.mjs")throw new IOException("FIXED_THREE_CONTROL_REPAIR_LEAVES_REQUIRED");
  return Root+"\\"+relative.Replace('/','\\');
 }
 public static void ReplaceFixed(string relative,string staged,FileStream oldStream,FileStream newStream){
  SafeFileHandle oldHandle=oldStream.SafeFileHandle,newHandle=newStream.SafeFileHandle;
  string target=Fixed(relative);
  if(Path.GetDirectoryName(staged)!=Path.GetDirectoryName(target)||!Path.GetFileName(staged).StartsWith(Path.GetFileName(target)+".clued-formal-fixed-v1-new-",StringComparison.Ordinal)||!staged.EndsWith(".tmp",StringComparison.Ordinal))throw new IOException("FIXED_SAME_DIRECTORY_STAGE_REQUIRED");
  VerifyInstallFiles.ExactPath(oldHandle,target);VerifyInstallFiles.ExactPath(newHandle,staged);
  var oldInfo=VerifyInstallFiles.Metadata(oldHandle);var newInfo=VerifyInstallFiles.Metadata(newHandle);
  if(oldInfo.Links!=1||newInfo.Links!=1||oldInfo.Volume!=newInfo.Volume||Same(oldInfo,newInfo))throw new IOException("SINGLE_LINK_SAME_VOLUME_DISTINCT_FILES_REQUIRED");
  // Closest path/FileID recheck. Old/staged handles must ShareRead|ShareDelete,
  // never ShareWrite. No unchanged leaf or ancestor gets ShareDelete here.
  using(var current=VerifyInstallFiles.HoldMetadata(target,false))if(!Same(oldInfo,VerifyInstallFiles.Metadata(current)))throw new IOException("OLD_PATH_FILEID_CHANGED");
  using(var current=VerifyInstallFiles.HoldMetadata(staged,false))if(!Same(newInfo,VerifyInstallFiles.Metadata(current)))throw new IOException("STAGED_PATH_FILEID_CHANGED");
  // ReplaceFile internally needs write access to the replacement file. Keeping
  // a no-ShareWrite staging reader would block our own swap. Close only that
  // old and staging leaf handles at the closest point; some Windows ReplaceFile
  // paths also refuse removal while the old reader remains. No ShareWrite is
  // introduced. ACL/parent locks/cooperative admin window guard the explicit
  // two-leaf gap. The caller saved newInfo before this call.
  oldStream.Dispose();newStream.Dispose();File.Replace(staged,target,null,false);
  // The caller immediately opens target ShareRead only, proving saved newInfo,
  // exact new hash and protected ACL. Never claim atomic SHA compare/exchange.
 }
}
