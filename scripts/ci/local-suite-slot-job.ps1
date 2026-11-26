param([switch]$Probe, [switch]$ResidentFiles, [string]$Directory, [string]$Node, [string]$Worker)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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

    private static IntPtr StartInJob(IntPtr job, string node, string arguments, IntPtr output, IntPtr error) {
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
            var argv = new StringBuilder("\"" + node + "\" " + arguments);
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

    private static IntPtr StartWorker(IntPtr job, string node, string worker) {
        return StartInJob(job, node, "\"" + worker + "\" worker", GetStdHandle(-11), GetStdHandle(-12));
    }

    private sealed class ResidentRequest {
        public volatile bool Stop;
        public Task Work;
    }

    private static void RunResidentFile(ResidentRequest request, int index, string directory, string node, string worker) {
        IntPtr job = IntPtr.Zero, child = IntPtr.Zero;
        int status = 1;
        string failed = null, cleanup = null;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            Limits limits = new Limits();
            limits.Basic.Flags = KillOnClose;
            if (!SetInformationJobObject(job, ExtendedLimits, ref limits, Marshal.SizeOf(typeof(Limits))))
                throw new Win32Exception();
            if (!request.Stop) {
                var security = new SecurityAttributes { Size = (uint)Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
                string basename = Path.Combine(directory, index.ToString());
                IntPtr log = CreateFile(basename + ".log", 0x40000000, 3, ref security, 1, 0, IntPtr.Zero);
                if (log == new IntPtr(-1)) throw new Win32Exception();
                try {
                    child = StartInJob(job, node, "\"" + worker + "\" --resident-file-test \"" + basename + ".args.json\"", log, log);
                } finally {
                    CloseHandle(log);
                }
                Console.WriteLine("{0} started", index);
                while (!request.Stop) {
                    uint wait = WaitForSingleObject(child, 20);
                    if (wait == WaitTimeout) continue;
                    if (wait != 0 || !GetExitCodeProcess(child, out status)) throw new Win32Exception();
                    break;
                }
            }
        } catch (Exception error) {
            failed = error.Message;
        } finally {
            if (child != IntPtr.Zero) CloseHandle(child);
            if (job != IntPtr.Zero) {
                try {
                    if (Active(job) != 0 && !TerminateJobObject(job, 1)) throw new Win32Exception();
                    Stopwatch drain = Stopwatch.StartNew();
                    while (Active(job) != 0) {
                        if (drain.ElapsedMilliseconds >= 10000) throw new IOException("file job did not drain");
                        Thread.Sleep(20);
                    }
                } catch (Exception error) {
                    cleanup = error.Message;
                } finally {
                    // KILL_ON_JOB_CLOSE still covers the entire job if explicit cleanup or confirmation failed.
                    CloseHandle(job);
                }
            }
        }
        if (cleanup != null || failed != null) {
            Console.WriteLine("{0} {1} {2}", index, cleanup == null ? "failed" : "cleanup",
                Convert.ToBase64String(Encoding.UTF8.GetBytes(cleanup ?? failed)));
        } else {
            Console.WriteLine("{0} drained {1}", index, status);
        }
    }

    // One host per file pool. EOF cancels every outstanding job even if the pool dies.
    public static void RunResidentFiles(string directory, string node, string worker) {
        var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
        var active = new Dictionary<int, ResidentRequest>();
        var finished = new List<int>();
        Console.WriteLine("ready");
        try {
            string line;
            while ((line = input.ReadLine()) != null) {
                int index = int.Parse(line.Substring(1));
                if (line[0] == '-') {
                    ResidentRequest existing;
                    if (active.TryGetValue(index, out existing)) existing.Stop = true;
                    continue;
                }
                finished.Clear();
                foreach (var item in active) {
                    if (!item.Value.Work.IsCompleted) continue;
                    item.Value.Work.GetAwaiter().GetResult();
                    finished.Add(item.Key);
                }
                foreach (int done in finished) active.Remove(done);
                var request = new ResidentRequest();
                active.Add(index, request);
                request.Work = Task.Factory.StartNew(() => RunResidentFile(request, index, directory, node, worker),
                    CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            }
        } finally {
            foreach (ResidentRequest request in active.Values) request.Stop = true;
            foreach (ResidentRequest request in active.Values) request.Work.GetAwaiter().GetResult();
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

if ($ResidentFiles) {
    [LocalSuiteJob]::RunResidentFiles($Directory, $Node, $Worker)
    exit 0
}

$guard = ConvertFrom-Json $env:CLUED_LOCAL_SUITE_GUARD
exit [LocalSuiteJob]::Run($guard.requestPath, $guard.node, $guard.worker, $guard.suite, $guard.owner, $guard.holdMs, $guard.timeoutExit, $guard.deadlineAt)
