param([switch]$Probe)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class LocalSuiteJob {
    private const int BasicAccounting = 1;
    private const int ExtendedLimits = 9;
    private const uint KillOnClose = 0x2000;
    private const uint JobQuery = 0x0004;
    private const int FileNotFound = 2;
    private const int AlreadyExists = 183;
    private const int HandleList = 0x20002;
    private const int JobList = 0x2000D;
    private const uint ExtendedStartup = 0x80000;
    private const uint NoWindow = 0x08000000;
    private const uint UseStandardHandles = 0x100;
    private const uint WaitTimeout = 258;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint Pid, Tid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes {
        public uint Size;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Limits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(string path, uint access, uint share, ref SecurityAttributes security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string directory, ref StartupInfoEx startup,
        out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out int code);

    private static string JobName(string request) { return @"Global\" + request; }

    public static string Probe(string request) {
        IntPtr job = OpenJobObject(JobQuery, false, JobName(request));
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            return error == FileNotFound ? "gone" : "unknown-" + error;
        }
        CloseHandle(job);
        return "live";
    }

    private static uint Active(IntPtr job) {
        Accounting info;
        if (!QueryInformationJobObject(job, BasicAccounting, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
            throw new Win32Exception();
        return info.ActiveProcesses;
    }

    private static IntPtr StartWorker(IntPtr job, string node, string worker) {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception();
        IntPtr attributes = Marshal.AllocHGlobal(size);
        IntPtr input = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
        bool initialized = false;
        try {
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new Win32Exception();
            initialized = true;
            var security = new SecurityAttributes { Size = (uint)Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            if (input == new IntPtr(-1)) throw new Win32Exception();
            IntPtr output = GetStdHandle(-11), error = GetStdHandle(-12);
            if (!SetHandleInformation(output, 1, 1) || !SetHandleInformation(error, 1, 1)) throw new Win32Exception();
            IntPtr[] inherit = output == error ? new[] { input, output } : new[] { input, output, error };
            handles = Marshal.AllocHGlobal(inherit.Length * IntPtr.Size);
            for (int i = 0; i < inherit.Length; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, inherit[i]);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(HandleList), handles,
                new IntPtr(inherit.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            // The kernel puts the worker in the job as part of CreateProcess.
            // Even a preload or a guard killed during startup cannot escape it.
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(JobList), jobs,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            var start = new StartupInfoEx {
                Startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx)),
                    Flags = UseStandardHandles, Input = input, Output = output, Error = error },
                Attributes = attributes
            };
            var argv = new StringBuilder("\"" + node + "\" \"" + worker + "\" worker");
            ProcessInfo child;
            if (!CreateProcess(node, argv, IntPtr.Zero, IntPtr.Zero, true, ExtendedStartup | NoWindow,
                IntPtr.Zero, null, ref start, out child)) throw new Win32Exception();
            CloseHandle(child.Thread);
            return child.Process;
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        }
    }

    public static int Run(string requestPath, string node, string worker, string suite, int owner, int holdMs, int timeoutExit, long deadlineAt) {
        Stopwatch age = Stopwatch.StartNew();
        long budget = Math.Max(0, Math.Min(holdMs, deadlineAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        IntPtr job = CreateJobObject(IntPtr.Zero, JobName(Path.GetFileName(requestPath)));
        int createError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new Win32Exception(createError);
        try {
            if (createError == AlreadyExists) throw new Win32Exception(createError);
            Limits limits = new Limits();
            limits.Basic.Flags = KillOnClose;
            if (!SetInformationJobObject(job, ExtendedLimits, ref limits, Marshal.SizeOf(typeof(Limits))))
                throw new Win32Exception();

            Stream input = Console.OpenStandardInput();
            File.WriteAllText(Path.Combine(requestPath, "ready"), "");
            // No suite can start without permission from the entry after it sees the job is ready.
            if (input.ReadByte() != 1) return 1;
            Task<int> disconnect = Task.Run(() => input.ReadByte());
            int status = 1;
            IntPtr child = IntPtr.Zero;
            try {
                while (!disconnect.IsCompleted) {
                    long remaining = budget - age.ElapsedMilliseconds;
                    if (child == IntPtr.Zero && remaining > 0) child = StartWorker(job, node, worker);
                    uint wait = child == IntPtr.Zero ? WaitTimeout :
                        WaitForSingleObject(child, (uint)Math.Max(0, Math.Min(200, remaining)));
                    if (wait == 0) {
                        if (!GetExitCodeProcess(child, out status)) throw new Win32Exception();
                        break;
                    }
                    if (wait != WaitTimeout) throw new Win32Exception();
                    if (remaining > 0) continue;
                    Console.Error.WriteLine("LOCAL_SUITE_HOLD_TIMEOUT: {0} (PID {1}) held a slot for {2:F2} minutes; stopping its process tree",
                        suite, owner, holdMs / 60000.0);
                    status = timeoutExit;
                    break;
                }
            } finally {
                if (child != IntPtr.Zero) CloseHandle(child);
                if (Active(job) != 0 && !TerminateJobObject(job, unchecked((uint)status))) throw new Win32Exception();
                while (Active(job) != 0) Thread.Sleep(20);
                File.WriteAllText(Path.Combine(requestPath, "drained"), "");
            }
            return status;
        } finally {
            CloseHandle(job);
        }
    }
}
'@

if ($Probe) {
    foreach ($request in (ConvertFrom-Json $env:CLUED_LOCAL_SUITE_JOB_PROBE)) {
        "$request $([LocalSuiteJob]::Probe($request))"
    }
    exit 0
}

$guard = ConvertFrom-Json $env:CLUED_LOCAL_SUITE_GUARD
exit [LocalSuiteJob]::Run($guard.requestPath, $guard.node, $guard.worker, $guard.suite, $guard.owner, $guard.holdMs, $guard.timeoutExit, $guard.deadlineAt)
