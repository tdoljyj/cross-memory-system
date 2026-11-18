param([switch]$Probe)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

public static class LocalSuiteJob {
    private const int BasicAccounting = 1;
    private const int ExtendedLimits = 9;
    private const uint KillOnClose = 0x2000;
    private const uint JobQuery = 0x0004;
    private const int FileNotFound = 2;
    private const int AlreadyExists = 183;

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
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static string JobName(string request) { return @"Global\" + request; }

    public static bool IsGone(string request) {
        IntPtr job = OpenJobObject(JobQuery, false, JobName(request));
        if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == FileNotFound;
        CloseHandle(job);
        return false;
    }

    private static uint Active(IntPtr job) {
        Accounting info;
        if (!QueryInformationJobObject(job, BasicAccounting, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
            throw new Win32Exception();
        return info.ActiveProcesses;
    }

    public static int Run(string requestPath, string node, string worker, string suite, int owner, int holdMs, int timeoutExit) {
        Stopwatch age = Stopwatch.StartNew();
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
            var start = new ProcessStartInfo(node, "\"" + worker + "\" worker") {
                UseShellExecute = false, RedirectStandardInput = true, CreateNoWindow = true
            };
            int status = 1;
            using (Process child = Process.Start(start)) {
                try {
                    // The worker cannot run commands before it is inside the non-breakaway job.
                    if (!AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception();
                    child.StandardInput.BaseStream.WriteByte(1);
                    child.StandardInput.Close();
                    while (!disconnect.IsCompleted && age.ElapsedMilliseconds < holdMs) {
                        if (!child.WaitForExit(200)) continue;
                        status = child.ExitCode;
                        break;
                    }
                    if (age.ElapsedMilliseconds >= holdMs && !child.HasExited) {
                        Console.Error.WriteLine("LOCAL_SUITE_HOLD_TIMEOUT: {0} (PID {1}) held a slot for {2:F2} minutes; stopping its process tree",
                            suite, owner, holdMs / 60000.0);
                        status = timeoutExit;
                    }
                } finally {
                    if (Active(job) != 0 && !TerminateJobObject(job, (uint)status)) throw new Win32Exception();
                    while (Active(job) != 0) Thread.Sleep(20);
                    File.WriteAllText(Path.Combine(requestPath, "drained"), "");
                }
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
        if ([LocalSuiteJob]::IsGone($request)) { $request }
    }
    exit 0
}

$guard = ConvertFrom-Json $env:CLUED_LOCAL_SUITE_GUARD
exit [LocalSuiteJob]::Run($guard.requestPath, $guard.node, $guard.worker, $guard.suite, $guard.owner, $guard.holdMs, $guard.timeoutExit)
