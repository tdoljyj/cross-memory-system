"""Fixed, synthetic Windows engineering checks; never a Skill/PQUAL executor.

The only child executable is the locally compiled exact NativeHost.cs. Unknown
results retain their run directory; this script never re-dispatches a run key.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

BASE = Path(__file__).resolve().parent
WORK = BASE / "work"
CSC = Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe")
BOUNDARY = {"qualified": False, "authorization_effect": "NONE", "formal_execution": False}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def persist(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def environment():
    # No GitHub, model, database, shell startup or user-profile credentials.
    return {"SystemRoot": r"C:\Windows", "WINDIR": r"C:\Windows",
            "TEMP": str(WORK), "TMP": str(WORK),
            "CLUED_SYNTHETIC_CREDENTIAL_CANARY": "SYNTHETIC_ONLY_NO_REAL_CREDENTIAL"}


def kernel():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    return api


def crash_cleanup(folder, expected_profile, observed_stopped):
    """Only after held handles proved both exact processes exited; no PID kills."""
    if not observed_stopped:
        raise RuntimeError("Cleanup denied without observed process-tree termination")
    journal = read(folder / "native-intent.json")
    if (journal["profile_name"] != expected_profile
            or not re.fullmatch(r"CluedBootstrap\.[a-f0-9]{32}", expected_profile)
            or Path(journal["run_folder"]).resolve() != folder.resolve()):
        raise RuntimeError("Exact disposable resource binding mismatch")
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    userenv.DeleteAppContainerProfile.argtypes = [wintypes.LPCWSTR]
    userenv.DeleteAppContainerProfile.restype = ctypes.c_long
    result = userenv.DeleteAppContainerProfile(expected_profile)
    # This file was created by this run; no real data or original user ACL is used.
    canary = folder / "outside-synthetic-canary.txt"
    if canary.is_symlink() or read(canary) != {"synthetic": True}:
        raise RuntimeError("Synthetic canary binding mismatch")
    original_sddl = read(folder / "canary-original-acl.json")["sddl"]
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD)]
    advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    advapi.GetSecurityDescriptorControl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
    advapi.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    advapi.SetNamedSecurityInfoW.restype = wintypes.DWORD
    descriptor = ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(original_sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        # DACL_SECURITY_INFORMATION; restore only the run's exact fresh canary.
        control, revision = wintypes.WORD(), wintypes.DWORD()
        if not advapi.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
            raise ctypes.WinError(ctypes.get_last_error())
        flags = 4 | (0x80000000 if control.value & 0x1000 else 0x20000000)
        present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
        if not advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present:
            raise ctypes.WinError(ctypes.get_last_error())
        error = advapi.SetNamedSecurityInfoW(str(canary), 1, flags, None, None, dacl, None)
        if error:
            raise ctypes.WinError(error)
    finally:
        local_free = ctypes.WinDLL("kernel32").LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free(descriptor)
    advapi.GetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    needed = wintypes.DWORD()
    advapi.GetFileSecurityW(str(canary), 4, None, 0, ctypes.byref(needed))
    buffer = ctypes.create_string_buffer(needed.value)
    if not advapi.GetFileSecurityW(str(canary), 4, buffer, len(buffer), ctypes.byref(needed)):
        raise ctypes.WinError(ctypes.get_last_error())
    current = ctypes.c_void_p()
    if not advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer, 1, 4, ctypes.byref(current), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        restored = ctypes.wstring_at(current) == original_sddl
    finally:
        local_free(current)
    if not restored:
        raise RuntimeError("Canary ACL read-back differs from captured original")
    profile_folder = Path(read(folder / "active-tree.json")["profile_folder"])
    return {"profile_delete_hresult": result, "profile_folder_removed": not profile_folder.exists(),
            "synthetic_canary_acl_restore_api_success": True,
            "synthetic_canary_acl_restored_readback": restored,
            "tree_termination_observed_before_cleanup": observed_stopped}


def build():
    folder = WORK / ("build-" + uuid.uuid4().hex)
    folder.mkdir()
    exe = folder / "BootstrapNativeHost.exe"
    args = [str(CSC), "/nologo", "/target:exe", "/platform:x64", "/r:System.Web.Extensions.dll",
            "/out:" + str(exe), str(BASE / "NativeHost.cs")]
    subprocess.run(args, check=True, env=environment(), capture_output=True, timeout=30)
    return exe, {"source_sha256": digest(BASE / "NativeHost.cs"), "exe_sha256": digest(exe),
                 "compiler_path": str(CSC), "compiler_sha256": digest(CSC), "arguments": args[1:]}


def exercise(exe, binding, fault):
    assert fault in {"stop", "host_crash"}
    folder = WORK / (fault + "-" + uuid.uuid4().hex)
    folder.mkdir()
    # The outer intent and reservation precede native process creation. The native
    # process gets a new empty child directory and persists its resource intent.
    persist(folder / "intent.json", {"kind": "LOCAL_ENGINEERING_INTENT", "fault": fault,
            "native_binding": binding, "max_wall_seconds": 30, "reserved_slot": 1,
            "model_budget": 0, "paid_budget": 0, **BOUNDARY})
    native_dir = folder / "native"
    native_dir.mkdir()
    if digest(exe) != binding["exe_sha256"] or digest(BASE / "NativeHost.cs") != binding["source_sha256"]:
        raise RuntimeError("Build binding drift")
    api = kernel()
    handles = []
    process = subprocess.Popen([str(exe), str(native_dir)], env=environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    started = time.monotonic()
    report = {"fault": fault, "run_folder": str(folder), "binding": binding, **BOUNDARY}
    try:
        active_path = native_dir / "active-tree.json"
        while not active_path.exists() and process.poll() is None and time.monotonic() - started < 15:
            time.sleep(0.01)
        if not active_path.exists():
            raise RuntimeError("No exact active-tree evidence; capacity retained")
        # CreateNew/Flush(true) writer may still be finishing a tiny file.
        for attempt in range(50):
            try:
                active = read(active_path)
                break
            except json.JSONDecodeError:
                time.sleep(0.01)
        else:
            raise RuntimeError("Incomplete active-tree evidence")
        if active["parent_pid"] != process.pid:
            raise RuntimeError("Active parent binding mismatch")
        report["active_tree"] = active
        for key in ("child_pid", "descendant_pid"):
            handle = api.OpenProcess(0x100000 | 0x1000, False, active[key])
            if not handle or api.WaitForSingleObject(handle, 0) != 258:
                raise RuntimeError("Exact active process handle not observed")
            handles.append(handle)
        persist(folder / "held-tree.json", {"observed_live": True, "active_tree": active,
                "observation": "Real handles retained before fault injection", **BOUNDARY})
        if fault == "stop":
            persist(native_dir / "STOP", {"reason": "FIXED_SYNTHETIC_STOP"})
        else:
            # Kill only the retained native supervisor process object. Job handle
            # is non-inheritable and only this host owns it; no broad PID sweep.
            process.kill()
        stdout, stderr = process.communicate(timeout=10)
        stopped = all(api.WaitForSingleObject(handle, 5000) == 0 for handle in handles)
        report["exact_tree_termination_observed"] = stopped
        report["stdout_sha256"] = hashlib.sha256(stdout).hexdigest()
        report["stderr_sha256"] = hashlib.sha256(stderr).hexdigest()
        report["host_exit_code"] = process.returncode
        if not stopped:
            raise RuntimeError("Job tree termination unproven")
        if fault == "stop":
            observed = read(native_dir / "probe-result.json")
            if (observed["stop_reason"] != "STOP_REQUESTED" or not observed["termination_observed"]
                    or not observed["descendant_termination_observed"] or not observed["synthetic_canary_acl_restored"]
                    or not observed["profile_folder_removed"]):
                raise RuntimeError("STOP/cleanup observation did not meet the fixed expectation")
            report["native_observation"] = observed
            report["status"] = "ENGINEERING_OBSERVED"
        else:
            if (native_dir / "probe-result.json").exists():
                raise RuntimeError("Expected interrupted result path was not interrupted")
            # UNKNOWN is not converted into success or dispatched again. Cleanup
            # has its own record and needs the actual retained-handle observations.
            report["status"] = "UNKNOWN"
            report["reexecuted"] = False
            cleanup = crash_cleanup(native_dir, active["profile_name"], stopped)
            persist(folder / "cleanup.json", {**cleanup, **BOUNDARY})
            report["cleanup"] = cleanup
        report["engineering_assertions_satisfied"] = True
    except Exception as exc:
        report.update(status="UNKNOWN", engineering_assertions_satisfied=False,
                      error_type=type(exc).__name__, error=str(exc), capacity_retained=True)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
    finally:
        for handle in handles:
            api.CloseHandle(handle)
        report["elapsed_seconds"] = round(time.monotonic() - started, 6)
        persist(folder / "observation.json", report)
    return report


def main():
    modes = {"--fixed-engineering-checks": ("stop", "host_crash"), "--host-crash-check": ("host_crash",)}
    if os.name != "nt" or len(sys.argv) != 2 or sys.argv[1] not in modes:
        print(json.dumps({"status": "BLOCKED", "reason": "Only fixed Windows engineering checks are implemented; formal Skill execution is not accepted", **BOUNDARY}))
        return 2
    WORK.mkdir(exist_ok=True)
    # One real exclusive reservation for this candidate's engineering processes.
    lock = WORK / "active-reservation.json"
    persist(lock, {"pid": os.getpid(), "slots": 1, "max_total_seconds": 90,
                   "model_budget": 0, "paid_budget": 0, **BOUNDARY})
    reports = []
    try:
        exe, binding = build()
        faults = modes[sys.argv[1]]
        for fault in faults:
            report = exercise(exe, binding, fault)
            reports.append(report)
            if not report["engineering_assertions_satisfied"]:
                break
        complete = len(reports) == len(faults) and all(item["engineering_assertions_satisfied"] for item in reports)
        result = {"kind": "FIXED_BOOTSTRAP_ENGINEERING_CHECKS", "checks": reports,
                  "all_engineering_assertions_satisfied": complete, **BOUNDARY}
        persist(WORK / ("EngineeringChecks-" + uuid.uuid4().hex + ".json"), result)
        print(json.dumps(result, ensure_ascii=False))
        if complete:
            lock.unlink()  # Only after actual tree termination and cleanup.
        return 0 if complete else 2
    except Exception:
        # Keep reservation and all Intent bytes on any uncertain execution path.
        raise


if __name__ == "__main__":
    raise SystemExit(main())
