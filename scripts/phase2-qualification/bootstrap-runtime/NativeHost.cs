// Fixed bootstrap engineering host. No qualification or GateAuthorization is issued here.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public class BootstrapNativeHost {
    [StructLayout(LayoutKind.Sequential)] struct Capabilities { public IntPtr Sid, Caps; public uint Count, Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
        public ushort show, reserved2; public IntPtr bytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int needed);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,int length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    static JavaScriptSerializer Json = new JavaScriptSerializer();

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void HResult(int code) { if(code < 0) Marshal.ThrowExceptionForHR(code); }
    static string Quote(string value) { if(value.Contains("\"")) throw new ArgumentException("quote denied"); return "\""+value+"\""; }
    static void Save(string path,object value) {
        byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(value));
        using(FileStream f=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { f.Write(bytes,0,bytes.Length); f.Flush(true); }
    }
    static Dictionary<string,object> Token(IntPtr process) {
        IntPtr token; Check(OpenProcessToken(process,8,out token));
        IntPtr buffer=Marshal.AllocHGlobal(16384);
        try {
            int needed; Check(GetTokenInformation(token,29,buffer,16384,out needed));
            bool isContainer=Marshal.ReadInt32(buffer)!=0;
            Check(GetTokenInformation(token,30,buffer,16384,out needed));
            int capabilityCount=Marshal.ReadInt32(buffer);
            string sid=null;
            if(isContainer) { Check(GetTokenInformation(token,31,buffer,16384,out needed)); sid=new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; }
            return new Dictionary<string,object>{{"is_appcontainer",isContainer},{"capability_count",capabilityCount},{"appcontainer_sid",sid}};
        } finally { Marshal.FreeHGlobal(buffer); CloseHandle(token); }
    }
    static void Descendant(string allowed) {
        var token=Token(Process.GetCurrentProcess().Handle);
        if(!(bool)token["is_appcontainer"]) throw new InvalidOperationException("AppContainer required");
        bool inside; Check(IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out inside));
        if(!inside) throw new InvalidOperationException("Job containment required");
        Save(Path.Combine(allowed,"descendant-observation.json"),new {pid=Process.GetCurrentProcess().Id,token=token,in_job=inside});
        Thread.Sleep(Timeout.Infinite);
    }
    static void Child(string allowed,string outside,int port) {
        var report=new Dictionary<string,object>();
        report["token"]=Token(Process.GetCurrentProcess().Handle);
        if(!(bool)((Dictionary<string,object>)report["token"])["is_appcontainer"]) throw new InvalidOperationException("AppContainer required");
        bool inJob; Check(IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out inJob));
        if(!inJob) throw new InvalidOperationException("Job containment required");
        report["in_job"]=inJob;
        var descendantStart=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"descendant "+Quote(allowed));
        descendantStart.UseShellExecute=false; descendantStart.CreateNoWindow=true;
        descendantStart.EnvironmentVariables.Clear();
        descendantStart.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        descendantStart.EnvironmentVariables["TEMP"]=allowed; descendantStart.EnvironmentVariables["TMP"]=allowed;
        using(var descendant=Process.Start(descendantStart)) { report["descendant_pid"]=descendant.Id; }
        var descendantWait=Stopwatch.StartNew();
        while(descendantWait.ElapsedMilliseconds<3000 && !File.Exists(Path.Combine(allowed,"descendant-observation.json"))) Thread.Sleep(10);
        if(!File.Exists(Path.Combine(allowed,"descendant-observation.json"))) throw new InvalidOperationException("Descendant observation missing");
        try { File.WriteAllText(Path.Combine(allowed,"allowed-synthetic.txt"),"synthetic only"); report["allowed_write"]=true; }
        catch(Exception ex) { report["allowed_write"]=false; report["allowed_error"]=ex.GetType().Name; }
        try { File.ReadAllText(outside); report["outside_read_denied"]=false; }
        catch(UnauthorizedAccessException ex) { report["outside_read_denied"]=true; report["outside_error_code"]=ex.HResult & 65535; }
        catch(Exception ex) { report["outside_read_denied"]=false; report["outside_error"]=ex.GetType().Name; }
        report["loopback_denied"]=false;
        try {
            using(var client=new TcpClient()) {
                var pending=client.BeginConnect(IPAddress.Loopback,port,null,null);
                if(!pending.AsyncWaitHandle.WaitOne(1500)) report["network_observation"]="TIMEOUT_NOT_DENIAL_PROOF";
                else { client.EndConnect(pending); report["network_observation"]="CONNECTED"; }
                pending.AsyncWaitHandle.Close();
            }
        } catch(SocketException ex) { report["network_error_code"]=ex.ErrorCode; report["loopback_denied"]=ex.ErrorCode==10013; }
        catch(Exception ex) { report["network_observation"]=ex.GetType().Name; }
        report["credential_canary_inherited"]=Environment.GetEnvironmentVariable("CLUED_SYNTHETIC_CREDENTIAL_CANARY")!=null;
        Save(Path.Combine(allowed,"child-observation.json"),report);
        Thread.Sleep(Timeout.Infinite); // The parent must observe and terminate this exact process.
    }
    static int Parent(string folder) {
        folder=Path.GetFullPath(folder);
        if(!Directory.Exists(folder) || Directory.GetFileSystemEntries(folder).Length!=0 || (File.GetAttributes(folder)&FileAttributes.ReparsePoint)!=0) throw new ArgumentException("empty dedicated directory required");
        string name="CluedBootstrap."+Guid.NewGuid().ToString("N");
        string canary=Path.Combine(folder,"outside-synthetic-canary.txt");
        string originalSddl=null;
        string exeDigest;
        using(var sha=SHA256.Create()) using(var f=File.OpenRead(Process.GetCurrentProcess().MainModule.FileName)) exeDigest=BitConverter.ToString(sha.ComputeHash(f)).Replace("-","").ToLowerInvariant();
        // Engineering Intent is durable BEFORE a profile, ACL or process changes.
        // This local journal is not a remotely persisted formal authorization.
        Save(Path.Combine(folder,"native-intent.json"),new {kind="LOCAL_ENGINEERING_INTENT",profile_name=name,run_folder=folder,exe_sha256=exeDigest,utc=DateTime.UtcNow.ToString("o"),qualified=false,authorization_effect="NONE"});
        var report=new Dictionary<string,object>{{"kind","BOOTSTRAP_JOB_ENGINEERING_OBSERVATION"},{"qualified",false},{"authorization_effect","NONE"},{"profile_name",name},{"os_version",Environment.OSVersion.VersionString},{"runtime",Environment.Version.ToString()},{"network_capabilities_requested",0},{"global_security_settings_changed",false},{"exe_sha256",exeDigest},{"parent_credential_canary_present",Environment.GetEnvironmentVariable("CLUED_SYNTHETIC_CREDENTIAL_CANARY")!=null}};
        IntPtr sid=IntPtr.Zero,attributes=IntPtr.Zero,capsPtr=IntPtr.Zero,env=IntPtr.Zero;
        ProcessInfo process=new ProcessInfo(); bool created=false; string profileFolder=null; IntPtr job=IntPtr.Zero,descendantHandle=IntPtr.Zero;
        TcpListener server=null;
        try {
            Save(canary,new {synthetic=true});
            FileSecurity original=File.GetAccessControl(canary,AccessControlSections.Access);
            originalSddl=original.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            Save(Path.Combine(folder,"canary-original-acl.json"),new {sddl=originalSddl});
            var privateAcl=new FileSecurity(); privateAcl.SetAccessRuleProtection(true,false);
            privateAcl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,AccessControlType.Allow));
            File.SetAccessControl(canary,privateAcl);
            HResult(CreateAppContainerProfile(name,name,"Disposable Clued synthetic isolation probe",IntPtr.Zero,0,out sid)); created=true;
            string sidText=new SecurityIdentifier(sid).Value; report["profile_sid"]=sidText;
            IntPtr nativePath; HResult(GetAppContainerFolderPath(sidText,out nativePath));
            try { profileFolder=Marshal.PtrToStringUni(nativePath); } finally { Marshal.FreeCoTaskMem(nativePath); }
            report["profile_folder"]=profileFolder;
            string exe=Path.Combine(profileFolder,"SyntheticProbe.exe");
            File.Copy(Process.GetCurrentProcess().MainModule.FileName,exe,false);
            server=new TcpListener(IPAddress.Loopback,0); server.Start(); int port=((IPEndPoint)server.LocalEndpoint).Port;
            using(var hostClient=new TcpClient()) { hostClient.Connect(IPAddress.Loopback,port); using(var accepted=server.AcceptTcpClient()) { report["host_loopback_control_connected"]=true; } }
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
            Capabilities caps=new Capabilities{Sid=sid,Caps=IntPtr.Zero,Count=0,Reserved=0};
            capsPtr=Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps,capsPtr,false);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),capsPtr,new IntPtr(Marshal.SizeOf(caps)),IntPtr.Zero,IntPtr.Zero));
            StartupEx startup=new StartupEx(); startup.startup.cb=Marshal.SizeOf(startup); startup.attributes=attributes;
            string block="LOCALAPPDATA="+profileFolder+"\0SystemRoot="+Environment.GetFolderPath(Environment.SpecialFolder.Windows)+"\0TEMP="+profileFolder+"\0TMP="+profileFolder+"\0\0";
            env=Marshal.StringToHGlobalUni(block);
            var command=new StringBuilder(Quote(exe)+" child "+Quote(profileFolder)+" "+Quote(canary)+" "+port);
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            ExtendedLimit limits=new ExtendedLimit(); limits.basic.flags=0x2000|0x8; limits.basic.activeProcesses=2;
            Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)));
            // Start suspended: no child instruction executes before assignment.
            Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x80000|0x400|0x8000000|0x4,env,profileFolder,ref startup,out process));
            Check(AssignProcessToJobObject(job,process.process));
            bool inside; Check(IsProcessInJob(process.process,job,out inside)); if(!inside) throw new InvalidOperationException("Job assignment not observed");
            report["assigned_before_resume"]=true; report["job_active_process_limit"]=2; report["job_kill_on_close"]=true; report["job_breakaway_allowed"]=false;
            Check(ResumeThread(process.thread)!=uint.MaxValue);
            report["pid"]=process.pid; report["parent_observed_token"]=Token(process.process);
            string childPath=Path.Combine(profileFolder,"child-observation.json");
            var timer=Stopwatch.StartNew();
            while(timer.ElapsedMilliseconds < 10000 && !File.Exists(childPath) && WaitForSingleObject(process.process,0)==258) Thread.Sleep(25);
            if(File.Exists(childPath)) {
                // Wait for the fixed child writer to close its evidence file before reading.
                Thread.Sleep(50); var child=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(childPath));
                report["child_observation"]=child; Save(Path.Combine(folder,"child-observation.json"),child);
                var descendant=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(profileFolder,"descendant-observation.json")));
                report["descendant_observation"]=descendant;
                descendantHandle=OpenProcess(0x100000|0x1000,false,Convert.ToUInt32(descendant["pid"])); Check(descendantHandle!=IntPtr.Zero);
                bool member; Check(IsProcessInJob(descendantHandle,job,out member)); report["descendant_in_exact_job"]=member;
                if(!member) throw new InvalidOperationException("Descendant outside exact job");
                Save(Path.Combine(folder,"active-tree.json"),new {profile_name=name,profile_folder=profileFolder,parent_pid=Process.GetCurrentProcess().Id,child_pid=process.pid,descendant_pid=descendant["pid"],job_kill_on_close=true});
                // Fixed supervised wait gives the coordinator a real STOP/withdrawal window.
                var stopWait=Stopwatch.StartNew();
                while(stopWait.ElapsedMilliseconds<2000 && !File.Exists(Path.Combine(folder,"STOP"))) Thread.Sleep(10);
                report["stop_reason"]=File.Exists(Path.Combine(folder,"STOP"))?"STOP_REQUESTED":"ENGINEERING_DEADLINE";
            } else report["child_observation"]="MISSING_OR_PROCESS_EXITED";
            bool alive=WaitForSingleObject(process.process,0)==258; report["alive_before_stop"]=alive;
            Check(TerminateJobObject(job,77));
            report["termination_observed"]=WaitForSingleObject(process.process,5000)==0;
            uint exit; Check(GetExitCodeProcess(process.process,out exit)); report["exit_code"]=exit;
            report["descendant_termination_observed"]=descendantHandle!=IntPtr.Zero && WaitForSingleObject(descendantHandle,5000)==0;
            report["status"]="OBSERVED_NOT_QUALIFIED";
        } catch(Exception ex) { report["status"]="CAPABILITY_PROBE_BLOCKED"; report["error_type"]=ex.GetType().Name; report["error_code"]=ex.HResult; report["error_message"]=ex.Message; }
        finally {
            if(job!=IntPtr.Zero) { TerminateJobObject(job,78); CloseHandle(job); }
            if(descendantHandle!=IntPtr.Zero) { WaitForSingleObject(descendantHandle,5000); CloseHandle(descendantHandle); }
            if(process.process!=IntPtr.Zero) { if(WaitForSingleObject(process.process,0)==258) { TerminateProcess(process.process,78); WaitForSingleObject(process.process,5000); } CloseHandle(process.process); }
            if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
            if(server!=null) server.Stop();
            if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if(capsPtr!=IntPtr.Zero) Marshal.FreeHGlobal(capsPtr);
            if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
            if(sid!=IntPtr.Zero) FreeSid(sid);
            if(created) { int cleanup=DeleteAppContainerProfile(name); report["profile_delete_hresult"]=cleanup; report["profile_folder_removed"]=profileFolder==null || !Directory.Exists(profileFolder); }
            // A freshly read FileSecurity has no modified flags, so writing that
            // same object can be a no-op. Reapply the captured descriptor explicitly.
            if(originalSddl!=null) {
                var restoredAcl=new FileSecurity();
                restoredAcl.SetSecurityDescriptorSddlForm(originalSddl,AccessControlSections.Access);
                File.SetAccessControl(canary,restoredAcl);
                report["synthetic_canary_acl_restored"]=File.GetAccessControl(canary,AccessControlSections.Access).GetSecurityDescriptorSddlForm(AccessControlSections.Access)==originalSddl;
            }
            Save(Path.Combine(folder,"probe-result.json"),report);
        }
        Console.WriteLine(Json.Serialize(report)); return (string)report["status"]=="OBSERVED_NOT_QUALIFIED"?0:2;
    }
    public static int Main(string[] args) {
        if(args.Length==2 && args[0]=="descendant") { Descendant(args[1]); return 0; }
        if(args.Length==4 && args[0]=="child") { Child(args[1],args[2],int.Parse(args[3])); return 0; }
        if(args.Length==1) return Parent(args[0]);
        Console.Error.WriteLine("Usage: SyntheticProbe.exe FRESH_DEDICATED_DIRECTORY"); return 2;
    }
}
