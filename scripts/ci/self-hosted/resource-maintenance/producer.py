"""A foreground, standard-account producer supervisor. No shell or global kill.

Linux adopts orphan descendants as a subreaper. Windows creates the process
suspended, assigns its Job Object before resuming, and waits for the whole job.
A hard-killed supervisor leaves the durable cache-writer row UNSETTLED.
External-service delegation (for example detached Docker or WMI work) is outside
this adapter: it needs its own qualified terminal/drain provider.
"""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

from maintenance import Refused, require


def run_tree(argv, env, timeout=None):
    require(bool(argv) and threading.active_count() == 1, "FOREGROUND_SINGLE_SUPERVISOR_REQUIRED")
    if os.name == "nt":
        return _windows(argv, env, timeout)
    require(sys.platform.startswith("linux"), "UNSUPPORTED_PROCESS_CONTAINMENT")
    return _linux(argv, env, timeout)


def _linux(argv, env, timeout):
    children = Path(f"/proc/self/task/{os.getpid()}/children").read_text().strip()
    require(not children, "SUPERVISOR_HAS_FOREIGN_CHILDREN")
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(36, 1, 0, 0, 0) == 0, "SUBREAPER_UNAVAILABLE")
    cancelled = False
    def cancel(*_):
        nonlocal cancelled
        cancelled = True
    previous = {s: signal.signal(s, cancel) for s in (signal.SIGINT, signal.SIGTERM)}
    process = None
    try:
        process = subprocess.Popen(argv, env=env, start_new_session=True)
        deadline = time.monotonic() + timeout if timeout is not None else float("inf")
        stopping_since, main_code = None, None
        while True:
            if cancelled or time.monotonic() >= deadline:
                stopping_since = stopping_since or time.monotonic()
                kill_signal = signal.SIGKILL if time.monotonic() - stopping_since > 5 else signal.SIGTERM
                # Children cannot have their PIDs reused before this single supervisor
                # reaps them. Newly orphaned descendants are adopted before the next wait.
                for text in Path(f"/proc/self/task/{os.getpid()}/children").read_text().split():
                    try:
                        os.kill(int(text), kill_signal)
                    except ProcessLookupError:
                        pass
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == process.pid:
                main_code = os.waitstatus_to_exitcode(status)
                process.returncode = main_code
            if pid == 0:
                time.sleep(0.02)
        require(main_code is not None, "MAIN_TERMINAL_UNKNOWN")
        return 124 if stopping_since is not None else main_code
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        # A raised exception does NOT claim tree quiescence: the Manager leaves its
        # durable writer row unsettled even when the OS lease is later released.


def _windows(argv, env, timeout):
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    class Startup(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                    *[(n, w.DWORD) for n in ("dwX", "dwY", "dwXSize", "dwYSize", "dwXCountChars", "dwYCountChars", "dwFillAttribute", "dwFlags")],
                    ("wShowWindow", w.WORD), ("cbReserved2", w.WORD), ("lpReserved2", ctypes.c_void_p),
                    ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]
    class Process(ctypes.Structure):
        _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
    class StartupEx(ctypes.Structure):
        _fields_ = [("startup", Startup), ("attributes", ctypes.c_void_p)]
    class BasicLimit(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong), ("flags", w.DWORD),
                    ("min_working", ctypes.c_size_t), ("max_working", ctypes.c_size_t), ("active_limit", w.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", BasicLimit), ("io", IO), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]
    class Accounting(ctypes.Structure):
        _fields_ = [(n, ctypes.c_longlong) for n in ("user", "kernel", "period_user", "period_kernel")] + [
                    (n, w.DWORD) for n in ("faults", "total", "active", "terminated")]
    k.CreateJobObjectW.argtypes, k.CreateJobObjectW.restype = [ctypes.c_void_p, w.LPCWSTR], w.HANDLE
    k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    k.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
    k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL,
                                w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(Process)]
    k.ResumeThread.argtypes, k.ResumeThread.restype = [w.HANDLE], w.DWORD
    k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
    k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
    k.CloseHandle.argtypes = [w.HANDLE]
    k.GetStdHandle.argtypes, k.GetStdHandle.restype = [w.DWORD], w.HANDLE
    k.GetHandleInformation.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    k.GetCurrentProcess.restype = w.HANDLE
    k.DuplicateHandle.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE, ctypes.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD]
    k.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
    k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p,
                                          ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    k.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    executable = shutil.which(argv[0])
    require(executable is not None and Path(executable).suffix.casefold() not in (".cmd", ".bat"), "EXECUTABLE_REQUIRED_NO_SHELL")
    command = ctypes.create_unicode_buffer(subprocess.list2cmdline([executable, *argv[1:]]))
    environment = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items(), key=lambda p: p[0].casefold())) + "\0\0")
    startup, process = Startup(), Process()
    startup.cb = ctypes.sizeof(startup)
    job = k.CreateJobObjectW(None, None)
    require(job, "JOB_CREATE_FAILED")
    assigned, cancelled = False, False
    limits = Extended()
    limits.basic.flags = 0x2000  # kill-on-close; no breakaway permission
    previous = {}
    copies, attributes_initialized = [], False
    try:
        require(k.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)), "JOB_LIMITS_FAILED")
        original_stdio = []
        for field, number in (("hStdInput", -10), ("hStdOutput", -11), ("hStdError", -12)):
            handle, flags = k.GetStdHandle(number & 0xFFFFFFFF), w.DWORD()
            if handle and handle != ctypes.c_void_p(-1).value and k.GetHandleInformation(handle, ctypes.byref(flags)):
                original_stdio.append((field, handle))
        flags = 0x404
        startup_pointer = ctypes.byref(startup)
        if len(original_stdio) == 3:
            startup.dwFlags = 0x100
            for field, original in original_stdio:
                duplicate = w.HANDLE()
                require(k.DuplicateHandle(k.GetCurrentProcess(), original, k.GetCurrentProcess(),
                                           ctypes.byref(duplicate), 0, True, 2), "STD_HANDLE_COPY_FAILED")
                copies.append(duplicate.value)
                setattr(startup, field, duplicate.value)
            attribute_size = ctypes.c_size_t()
            k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(attribute_size))
            require(attribute_size.value > 0, "ATTRIBUTE_SIZE_FAILED")
            attribute_buffer = ctypes.create_string_buffer(attribute_size.value)
            require(k.InitializeProcThreadAttributeList(attribute_buffer, 1, 0, ctypes.byref(attribute_size)), "ATTRIBUTE_INIT_FAILED")
            attributes_initialized = True
            handle_array = (w.HANDLE * len(copies))(*copies)
            require(k.UpdateProcThreadAttribute(attribute_buffer, 0, 0x20002, handle_array,
                                                 ctypes.sizeof(handle_array), None, None), "HANDLE_ALLOWLIST_FAILED")
            extended = StartupEx(startup, ctypes.cast(attribute_buffer, ctypes.c_void_p))
            extended.startup.cb = ctypes.sizeof(extended)
            startup_pointer = ctypes.byref(extended)
            flags |= 0x80000  # EXTENDED_STARTUPINFO_PRESENT
        require(k.CreateProcessW(executable, command, None, None, bool(copies), flags,
                                 environment, None, startup_pointer, ctypes.byref(process)), "PROCESS_CREATE_FAILED")
        require(k.AssignProcessToJobObject(job, process.process), "JOB_ASSIGN_FAILED")
        assigned = True
        require(k.ResumeThread(process.thread) != 0xFFFFFFFF, "PROCESS_RESUME_FAILED")
        def cancel(*_):
            nonlocal cancelled
            cancelled = True
        previous = {s: signal.signal(s, cancel) for s in (signal.SIGINT, signal.SIGTERM)}
        deadline = time.monotonic() + timeout if timeout is not None else float("inf")
        terminated = False
        while True:
            if (cancelled or time.monotonic() >= deadline) and not terminated:
                require(k.TerminateJobObject(job, 124), "OWN_JOB_TERMINATION_FAILED")
                terminated = True
            accounting = Accounting()
            require(k.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None), "JOB_QUERY_FAILED")
            if accounting.active == 0:
                break
            time.sleep(0.02)
        require(k.WaitForSingleObject(process.process, 0) == 0, "MAIN_TERMINAL_UNKNOWN")
        code = w.DWORD()
        require(k.GetExitCodeProcess(process.process, ctypes.byref(code)), "EXIT_CODE_UNKNOWN")
        return 124 if terminated else code.value
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if process.process and not assigned:
            # The child has never been resumed and cannot have spawned descendants.
            k.TerminateProcess(process.process, 125)
            k.WaitForSingleObject(process.process, 5000)
        if attributes_initialized:
            k.DeleteProcThreadAttributeList(attribute_buffer)
        for handle in copies:
            k.CloseHandle(handle)
        k.CloseHandle(job)  # on exceptional exit, terminate only this assigned tree
        if process.thread:
            k.CloseHandle(process.thread)
        if process.process:
            k.CloseHandle(process.process)
