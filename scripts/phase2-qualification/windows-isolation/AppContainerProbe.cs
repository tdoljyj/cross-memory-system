// Synthetic Windows capability probe, not a qualification issuer or Skill runner.
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
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public class AppContainerProbe {
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
    static void Child(string allowed,string outside,int port) {
        var report=new Dictionary<string,object>();
        report["token"]=Token(Process.GetCurrentProcess().Handle);
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
        if(!Directory.Exists(folder) || File.Exists(Path.Combine(folder,"probe-result.json"))) throw new ArgumentException("fresh dedicated probe directory required");
        string name="CluedSyntheticProbe."+Guid.NewGuid().ToString("N");
        string canary=Path.Combine(folder,"outside-synthetic-canary.txt");
        Save(canary,new {synthetic=true});
        FileSecurity original=File.GetAccessControl(canary,AccessControlSections.Access);
        string originalSddl=original.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        var privateAcl=new FileSecurity(); privateAcl.SetAccessRuleProtection(true,false);
        privateAcl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,AccessControlType.Allow));
        File.SetAccessControl(canary,privateAcl);
        var report=new Dictionary<string,object>{{"kind","LOCAL_APPCONTAINER_CAPABILITY_PROBE"},{"qualified",false},{"authorization_effect","NONE"},{"profile_name",name},{"os_version",Environment.OSVersion.VersionString},{"runtime",Environment.Version.ToString()},{"network_capabilities_requested",0},{"global_security_settings_changed",false}};
        IntPtr sid=IntPtr.Zero,attributes=IntPtr.Zero,capsPtr=IntPtr.Zero,env=IntPtr.Zero;
        ProcessInfo process=new ProcessInfo(); bool created=false; string profileFolder=null;
        TcpListener server=null;
        try {
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
            Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x80000|0x400|0x8000000,env,profileFolder,ref startup,out process));
            report["pid"]=process.pid; report["parent_observed_token"]=Token(process.process);
            string childPath=Path.Combine(profileFolder,"child-observation.json");
            var timer=Stopwatch.StartNew();
            while(timer.ElapsedMilliseconds < 10000 && !File.Exists(childPath) && WaitForSingleObject(process.process,0)==258) Thread.Sleep(25);
            if(File.Exists(childPath)) {
                // Wait for the fixed child writer to close its evidence file before reading.
                Thread.Sleep(50); var child=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(childPath));
                report["child_observation"]=child; Save(Path.Combine(folder,"child-observation.json"),child);
            } else report["child_observation"]="MISSING_OR_PROCESS_EXITED";
            bool alive=WaitForSingleObject(process.process,0)==258; report["alive_before_stop"]=alive;
            if(alive) Check(TerminateProcess(process.process,77));
            report["termination_observed"]=WaitForSingleObject(process.process,5000)==0;
            uint exit; Check(GetExitCodeProcess(process.process,out exit)); report["exit_code"]=exit;
            report["status"]="OBSERVED_NOT_QUALIFIED";
        } catch(Exception ex) { report["status"]="CAPABILITY_PROBE_BLOCKED"; report["error_type"]=ex.GetType().Name; report["error_code"]=ex.HResult; report["error_message"]=ex.Message; }
        finally {
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
            var restoredAcl=new FileSecurity();
            restoredAcl.SetSecurityDescriptorSddlForm(originalSddl,AccessControlSections.Access);
            File.SetAccessControl(canary,restoredAcl);
            report["synthetic_canary_acl_restored"]=File.GetAccessControl(canary,AccessControlSections.Access).GetSecurityDescriptorSddlForm(AccessControlSections.Access)==originalSddl;
            Save(Path.Combine(folder,"probe-result.json"),report);
        }
        Console.WriteLine(Json.Serialize(report)); return (string)report["status"]=="OBSERVED_NOT_QUALIFIED"?0:2;
    }
    public static int Main(string[] args) {
        if(args.Length==4 && args[0]=="child") { Child(args[1],args[2],int.Parse(args[3])); return 0; }
        if(args.Length==1) return Parent(args[0]);
        Console.Error.WriteLine("Usage: SyntheticProbe.exe FRESH_DEDICATED_DIRECTORY"); return 2;
    }
}
