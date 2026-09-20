"""Fixed, non-production build namespace. Importing this file performs no I/O.

Provisioning this directory is NOT a build-helper authority. It must already
exist. All helper outputs, compiler caches, logs and temp files are descendants
of a new direct child. Windows directory handles remain live during the build.
"""
from __future__ import annotations
import json
import ctypes
from ctypes import wintypes
import ntpath
import os
import re
from pathlib import Path

QUALIFICATION_ROOT = r"C:\Users\Public\Clued\Qualification\M1-08-Owner"
PROTECTED_ROOTS = (r"C:\Users\Public\Clued\ModelProgram\M1",)
_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)


def canonical_windows_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("INVALID_QUALIFICATION_PATH")
    value = value.replace("/", "\\")
    if value.startswith("\\") or not re.match(r"^[A-Za-z]:\\", value):
        raise ValueError("ABSOLUTE_LOCAL_DRIVE_PATH_REQUIRED")
    for part in value[3:].split("\\"):
        if not part or part in (".", "..") or part.endswith((" ", ".")) or ":" in part or _RESERVED.match(part):
            raise ValueError("AMBIGUOUS_OR_ALIASED_WINDOWS_PATH")
    return ntpath.normcase(ntpath.normpath(value))


def overlaps(a: str, b: str) -> bool:
    a, b = canonical_windows_path(a), canonical_windows_path(b)
    return a == b or a.startswith(b + "\\") or b.startswith(a + "\\")


def validate_output_path(output: str, repository: str) -> str:
    out = canonical_windows_path(output)
    root = canonical_windows_path(QUALIFICATION_ROOT)
    if ntpath.dirname(out) != root:
        raise ValueError("OUTPUT_MUST_BE_NEW_DIRECT_CHILD_OF_FIXED_QUALIFICATION_ROOT")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", ntpath.basename(out)):
        raise ValueError("INVALID_QUALIFICATION_RUN_LABEL")
    for protected in (*PROTECTED_ROOTS, repository):
        if overlaps(root, protected) or overlaps(out, protected):
            raise ValueError("QUALIFICATION_PROTECTED_NAMESPACE_OVERLAP")
    return out


class QualificationScope:
    """Pin the *existing* directory chain; never provision a protected parent.

    No reparse following or path resolution is used to hide an alias before
    checking it. Native handle paths and IDs become evidence. No fallback to an
    unrestricted temporary directory is allowed on a failure.
    """
    def __init__(self, output: Path, repository: Path):
        self.output = Path(validate_output_path(str(output), str(repository)))
        self.handles: list[int] = []
        self.observations: list[dict] = []
        self.k = None

    def _pin(self, path: Path) -> None:
        assert self.k is not None
        # Retain directory name identity during the build. FILE_LIST_DIRECTORY
        # makes this a sharing-participating handle, not just a metadata query.
        # The fixed qualification root must be Owner-controlled.
        h = self.k.CreateFileW(str(path), 0x81, 1 | 2, None, 3, 0x02000000 | 0x00200000, None)
        if h == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        self.handles.append(h)
        class Info(ctypes.Structure):
            _fields_ = [("attributes", wintypes.DWORD), ("creation", wintypes.FILETIME),
                        ("access", wintypes.FILETIME), ("write", wintypes.FILETIME),
                        ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                        ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                        ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]
        info = Info()
        if not self.k.GetFileInformationByHandle(h, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if info.attributes & 0x400 or not info.attributes & 0x10:
            raise RuntimeError("QUALIFICATION_DIRECTORY_REPARSE_OR_TYPE_DRIFT")
        buf = ctypes.create_unicode_buffer(32768)
        n = self.k.GetFinalPathNameByHandleW(h, buf, len(buf), 0)
        if not n or n >= len(buf):
            raise RuntimeError("QUALIFICATION_FINAL_PATH_UNAVAILABLE")
        actual = buf.value
        if actual.startswith("\\\\?\\"):
            actual = actual[4:]
        if ntpath.normcase(ntpath.normpath(actual)) != ntpath.normcase(ntpath.normpath(str(path))):
            raise RuntimeError("QUALIFICATION_DIRECTORY_ALIAS_REJECTED")
        self.observations.append({"path": str(path), "handle_resolved_path": actual,
                                  "volume_serial": f"{info.volume:08x}",
                                  "file_id": f"{info.index_high:08x}{info.index_low:08x}",
                                  "non_reparse": True})

    def __enter__(self):
        if os.name != "nt":
            raise RuntimeError("WINDOWS_NATIVE_QUALIFICATION_SCOPE_REQUIRED")
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.k.CreateFileW.restype = wintypes.HANDLE
        self.k.CloseHandle.argtypes = [wintypes.HANDLE]
        self.k.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        self.k.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
        try:
            root = Path(QUALIFICATION_ROOT)
            for path in reversed([root, *root.parents]):
                self._pin(path)  # must exist: no parents=True anywhere here
            self.output.mkdir(exist_ok=False)
            self._pin(self.output)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.k is not None:
            for h in reversed(self.handles):
                self.k.CloseHandle(h)
        self.handles.clear()

    def evidence(self) -> dict:
        # These are measured path facts, not assertions that the helper watched
        # all system activity or observed zero model/Guard writes on the machine.
        return {"fixed_root": QUALIFICATION_ROOT, "resolved_output": str(self.output),
                "native_directory_observations": self.observations,
                "protected_namespace_overlap": any(overlaps(str(self.output), p) for p in PROTECTED_ROOTS),
                "temporary_files_caches_logs": "CONFINED_UNDER_RESOLVED_OUTPUT",
                "provisioned_qualification_root": False,
                "host_wide_no_effect_observation": "NOT_PERFORMED"}


def require_go_test_report(raw: str, required: tuple[str, ...]) -> dict:
    """A package-level 'ok' does not establish that required cases ran."""
    outcomes: dict[str, str] = {}
    package_pass = False
    for line in raw.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        action, name = event.get("Action"), event.get("Test")
        if action in ("skip", "fail"):
            raise RuntimeError(f"QUALIFICATION_TEST_{action.upper()}: {name or 'package'}")
        if name and action == "pass":
            outcomes[name] = action
        if not name and action == "pass":
            package_pass = True
    missing = sorted(set(required) - set(outcomes))
    if not package_pass or missing:
        raise RuntimeError("QUALIFICATION_REQUIRED_TEST_NOT_EXECUTED: " + ", ".join(missing))
    return {"top_level_pass": sum('/' not in n for n in outcomes),
            "subtest_pass": sum('/' in n for n in outcomes),
            "fail": 0, "skip": 0, "required_tests": list(required), "outcomes": outcomes}
