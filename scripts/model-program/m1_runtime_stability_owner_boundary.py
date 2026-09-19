"""Read-only startup checks for the one-shot M1-07 owner interpreter.

This is NOT a Python sandbox, secret, token, registry, or issuance mechanism.
The effectful runtime must never be installed into an importing agent process.
A fresh CPython process invokes the exact script directly with -I -S; only JSON
profile data and an output path cross that boundary. Authorization remains in
the orchestrator and must still complete before context registration.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


class OwnerBoundaryError(RuntimeError):
    pass


def native_windows_process_command() -> tuple[str, list[str]]:
    """Read actual process image/argv from Windows, not mutable sys.argv/env."""
    if os.name != "nt":
        raise OwnerBoundaryError("OWNER_WINDOWS_PROCESS_REQUIRED")
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    kernel32.GetModuleFileNameW.restype = wintypes.DWORD
    kernel32.GetCommandLineW.argtypes = []
    kernel32.GetCommandLineW.restype = wintypes.LPWSTR
    shell32.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    image = ctypes.create_unicode_buffer(32768)
    size = kernel32.GetModuleFileNameW(None, image, len(image))
    if size == 0 or size >= len(image):
        raise OwnerBoundaryError("OWNER_NATIVE_IMAGE_UNAVAILABLE")
    argc = ctypes.c_int()
    argv_ptr = shell32.CommandLineToArgvW(kernel32.GetCommandLineW(), ctypes.byref(argc))
    if not argv_ptr:
        raise OwnerBoundaryError("OWNER_NATIVE_ARGV_UNAVAILABLE")
    try:
        argv = [argv_ptr[i] for i in range(argc.value)]
    finally:
        kernel32.LocalFree(ctypes.cast(argv_ptr, wintypes.HLOCAL))
    return image.value, argv


def validate_native_owner_command(image: str, argv: list[str], script_path: Path) -> None:
    """Validate the fixed launch form. Returning None does not confer authority."""
    # Deliberately do not accept -c/-m, runpy, -i, callbacks, test modes, or a
    # caller-provided PID/process/registry. A mutable Python flag is not proof.
    if len(argv) != 9 or argv[1:3] != ["-I", "-S"]:
        raise OwnerBoundaryError("OWNER_DIRECT_ISOLATED_LAUNCH_REQUIRED")
    if argv[4:6] != ["--execute", "--profile"] or argv[7] != "--output-dir":
        raise OwnerBoundaryError("OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED")
    try:
        if not Path(image).samefile(Path(argv[0])):
            raise OwnerBoundaryError("OWNER_NATIVE_EXECUTABLE_MISMATCH")
        if not script_path.samefile(Path(argv[3])):
            raise OwnerBoundaryError("OWNER_NATIVE_SCRIPT_MISMATCH")
    except (OSError, ValueError) as exc:
        raise OwnerBoundaryError("OWNER_NATIVE_PATH_UNVERIFIED") from exc
    if not Path(argv[6]).is_absolute() or not Path(argv[8]).is_absolute():
        raise OwnerBoundaryError("OWNER_ABSOLUTE_PATHS_REQUIRED")
    if not Path(argv[6]).is_file():
        raise OwnerBoundaryError("OWNER_PROFILE_FILE_REQUIRED")


def require_owner_process(script_path: Path) -> None:
    """Check immutable startup facts; never create or return execution state.

    The trusted owner admits no untrusted Python code. Replacing Python code,
    monkeypatching its dependencies, attaching a debugger, or changing owned
    files is compromise of that trusted process, not an isolation guarantee.
    The -I/-S switches only harden interpreter startup, not OS access control.
    """
    if sys.implementation.name != "cpython":
        raise OwnerBoundaryError("OWNER_CPYTHON_REQUIRED")
    if not sys.flags.isolated or not sys.flags.no_site:
        raise OwnerBoundaryError("OWNER_ISOLATED_NO_SITE_REQUIRED")
    if sys.gettrace() is not None or sys.getprofile() is not None:
        raise OwnerBoundaryError("OWNER_INSTRUMENTED_PROCESS_REJECTED")
    image, argv = native_windows_process_command()
    validate_native_owner_command(image, argv, script_path)
    # This comparison is supplementary; the native argv above is authoritative.
    if sys.argv != argv[3:]:
        raise OwnerBoundaryError("OWNER_PYTHON_ARGV_DRIFT")
