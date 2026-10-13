"""Read-only Windows namespace checks for the bounded development caller.

The Host captures two existing private directories and one exact output name.
No directory/ACL is created or repaired here. This is not model permission or
general Host qualification; other processes with the same OS principal remain
outside a hard isolation claim. Every failure prevents the caller's next effect.
"""
import ctypes
from ctypes import wintypes as W
import hashlib
import os
from pathlib import Path
import re
import struct
import threading


MUTATION_RIGHTS = 0x10000000 | 0x40000000 | 0x000D0000 | 0x00000156
ADMIN_SID = "S-1-5-32-544"
SYSTEM_SID = "S-1-5-18"


def require(ok, code):
    if not ok:
        raise ValueError("DEVELOPMENT_NAMESPACE_" + code)


class WindowsMetadata:
    """Native metadata only; no subprocess, token export, model or mutation."""
    def __init__(self):
        require(os.name == "nt", "WINDOWS_REQUIRED")
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.a = ctypes.WinDLL("advapi32", use_last_error=True)
        for dll, name, args, restype in (
            (self.k, "CreateFileW", [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p,
                                    W.DWORD, W.DWORD, W.HANDLE], W.HANDLE),
            (self.k, "CloseHandle", [W.HANDLE], W.BOOL),
            (self.k, "GetCurrentProcess", [], W.HANDLE),
            (self.k, "GetFinalPathNameByHandleW", [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD], W.DWORD),
            (self.k, "GetFileInformationByHandle", [W.HANDLE, ctypes.c_void_p], W.BOOL),
            (self.k, "GetFileInformationByHandleEx", [W.HANDLE, ctypes.c_int,
                                                     ctypes.c_void_p, W.DWORD], W.BOOL),
            (self.k, "LocalFree", [ctypes.c_void_p], ctypes.c_void_p),
            (self.a, "OpenProcessToken", [W.HANDLE, W.DWORD, ctypes.POINTER(W.HANDLE)], W.BOOL),
            (self.a, "GetTokenInformation", [W.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                            W.DWORD, ctypes.POINTER(W.DWORD)], W.BOOL),
            (self.a, "ConvertSidToStringSidW", [ctypes.c_void_p, ctypes.POINTER(W.LPWSTR)], W.BOOL),
            (self.a, "IsValidSid", [ctypes.c_void_p], W.BOOL),
            (self.a, "GetLengthSid", [ctypes.c_void_p], W.DWORD),
            (self.a, "IsValidAcl", [ctypes.c_void_p], W.BOOL),
            (self.a, "GetAce", [ctypes.c_void_p, W.DWORD, ctypes.POINTER(ctypes.c_void_p)], W.BOOL),
            (self.a, "GetSecurityInfo", [W.HANDLE, ctypes.c_int, W.DWORD,
                 ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                 ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                 ctypes.POINTER(ctypes.c_void_p)], W.DWORD),
            (self.a, "GetSecurityDescriptorControl", [ctypes.c_void_p, ctypes.POINTER(W.WORD),
                                                     ctypes.POINTER(W.DWORD)], W.BOOL),
        ):
            function = getattr(dll, name)
            function.argtypes, function.restype = args, restype

    def sid(self, pointer):
        require(bool(pointer) and self.a.IsValidSid(pointer), "SID_INVALID")
        result = W.LPWSTR()
        require(self.a.ConvertSidToStringSidW(pointer, ctypes.byref(result)), "SID_READ_FAILED")
        try:
            return result.value
        finally:
            self.k.LocalFree(ctypes.cast(result, ctypes.c_void_p))

    def operator_sid(self):
        token = W.HANDLE()
        require(self.a.OpenProcessToken(self.k.GetCurrentProcess(), 0x0008, ctypes.byref(token)),
                "OPERATOR_READ_FAILED")
        try:
            size = W.DWORD()
            self.a.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            require(0 < size.value <= 65536, "OPERATOR_SIZE")
            buffer = ctypes.create_string_buffer(size.value)
            require(self.a.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)),
                    "OPERATOR_READ_FAILED")
            return self.sid(ctypes.c_void_p.from_buffer(buffer).value)
        finally:
            require(self.k.CloseHandle(token), "OPERATOR_CLOSE_FAILED")

    def open_metadata(self, path):
        # Hold the observed object, without claiming that metadata sharing flags
        # prevent every Windows rename/replacement. Reopen the path when checking.
        handle = self.k.CreateFileW(str(path), 0x00020080, 0x00000003, None,
                                    3, 0x02200000, None)
        require(handle not in (None, ctypes.c_void_p(-1).value), "OPEN_FAILED")
        return handle

    def metadata(self, handle):
        class FileId(ctypes.Structure):
            _fields_ = [("volume", ctypes.c_uint64), ("identifier", ctypes.c_ubyte * 16)]
        class FileInfo(ctypes.Structure):
            _fields_ = [("attributes", W.DWORD), ("created", W.FILETIME),
                        ("accessed", W.FILETIME), ("written", W.FILETIME),
                        ("volume", W.DWORD), ("size_high", W.DWORD), ("size_low", W.DWORD),
                        ("links", W.DWORD), ("index_high", W.DWORD), ("index_low", W.DWORD)]
        info, ident = FileInfo(), FileId()
        require(self.k.GetFileInformationByHandle(handle, ctypes.byref(info)), "IDENTITY_READ_FAILED")
        require(self.k.GetFileInformationByHandleEx(handle, 18, ctypes.byref(ident), ctypes.sizeof(ident)),
                "FILE_ID_UNAVAILABLE")
        name = ctypes.create_unicode_buffer(32768)
        count = self.k.GetFinalPathNameByHandleW(handle, name, len(name), 0)
        require(0 < count < len(name), "FINAL_PATH_READ_FAILED")
        path = name.value
        require(path.startswith("\\\\?\\") and not path.startswith("\\\\?\\UNC\\"), "LOCAL_PATH_REQUIRED")
        return {"identity": (ident.volume, bytes(ident.identifier).hex()),
                "inode": int.from_bytes(bytes(ident.identifier), "little"),
                "path": path[4:], "attributes": info.attributes, "links": info.links,
                "size": (info.size_high << 32) | info.size_low}

    def security(self, handle, allowed_sids, *, protected=True):
        owner, group, dacl, sacl, descriptor = [ctypes.c_void_p() for _ in range(5)]
        error = self.a.GetSecurityInfo(handle, 1, 0x00000005, ctypes.byref(owner),
            ctypes.byref(group), ctypes.byref(dacl), ctypes.byref(sacl), ctypes.byref(descriptor))
        require(error == 0 and descriptor.value, "ACL_READ_FAILED")
        try:
            require(self.sid(owner) in allowed_sids, "UNEXPECTED_OWNER")
            control, revision = W.WORD(), W.DWORD()
            require(self.a.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)),
                    "ACL_CONTROL_READ_FAILED")
            require(not protected or control.value & 0x1000, "INHERITED_DACL_NOT_PRIVATE")
            require(dacl.value and self.a.IsValidAcl(dacl), "NULL_OR_INVALID_DACL")
            header = ctypes.string_at(dacl, 8)
            size, count = struct.unpack_from("<HH", header, 2)
            require(8 <= size <= 65535 and count <= 1024, "ACL_SIZE")
            for index in range(count):
                ace = ctypes.c_void_p()
                require(self.a.GetAce(dacl, index, ctypes.byref(ace)), "ACE_READ_FAILED")
                kind, flags, ace_size = struct.unpack("<BBH", ctypes.string_at(ace, 4))
                require(kind in (0, 1) and ace_size >= 16, "UNSUPPORTED_ACE")
                mask = struct.unpack("<I", ctypes.string_at(ace.value + 4, 4))[0]
                sid = ace.value + 8
                require(self.a.IsValidSid(sid) and 8 + self.a.GetLengthSid(sid) <= ace_size, "ACE_SID")
                # Include inherit-only writer ACEs: they affect newly created files.
                if kind == 0 and mask & MUTATION_RIGHTS:
                    require(self.sid(sid) in allowed_sids, "UNEXPECTED_WRITER")
            fingerprint = hashlib.sha256(self.sid(owner).encode() + b"\0"
                + str(control.value).encode() + b"\0" + ctypes.string_at(dacl, size)).hexdigest()
            return fingerprint
        finally:
            self.k.LocalFree(descriptor)


class WindowsPrivateNamespace:
    """Host captures exact paths; this object only checks, never grants access."""
    def __init__(self, ledger_directory, output_directory, output_name):
        require(type(output_name) is str and 0 < len(output_name) <= 128
                and output_name not in (".", "..") and "\0" not in output_name
                and not output_name.endswith((".", " "))
                and Path(output_name).name == output_name and ":" not in output_name,
                "OUTPUT_NAME")
        self.native = WindowsMetadata()
        self.allowed = frozenset((self.native.operator_sid(), SYSTEM_SID, ADMIN_SID))
        self.paths = [Path(ledger_directory), Path(output_directory)]
        require(str(self.paths[0]) != str(self.paths[1]), "SEPARATE_DIRECTORIES_REQUIRED")
        self.output = self.paths[1] / output_name
        self.handles, self.baselines = [], []
        self.observation_baseline = None
        self.lock = threading.Lock()
        self.closed = False
        try:
            for path in self.paths:
                require(path.is_absolute() and str(path.resolve()) == str(path)
                        and not str(path).startswith(("\\\\", "//")), "CANONICAL_LOCAL_DIRECTORY")
                handle = self.native.open_metadata(path)
                self.handles.append(handle)
                meta = self.native.metadata(handle)
                require(meta["attributes"] & 0x10 and not meta["attributes"] & 0x400,
                        "DIRECTORY_OR_REPARSE")
                require(meta["path"] == str(path), "DIRECTORY_PATH_DRIFT")
                self.baselines.append((meta["identity"], self.native.security(handle, self.allowed)))
            require(self.baselines[0][0] != self.baselines[1][0], "DIRECTORY_OBJECT_ALIAS")
        except BaseException:
            self.close()
            raise

    def check(self, phase, ledger_directory, observation_path, opened):
        with self.lock:
            require(not self.closed, "NAMESPACE_CLOSED")
            require(str(Path(ledger_directory)) == str(self.paths[0])
                    and str(Path(observation_path)) == str(self.output),
                    "CAPTURED_PATH_DRIFT")
            for path, handle, baseline in zip(self.paths, self.handles, self.baselines):
                meta = self.native.metadata(handle)
                require(meta["identity"] == baseline[0] and meta["path"] == str(path)
                        and not meta["attributes"] & 0x400, "DIRECTORY_IDENTITY_DRIFT")
                require(self.native.security(handle, self.allowed) == baseline[1], "DIRECTORY_ACL_DRIFT")
                current = self.native.open_metadata(path)
                try:
                    current_meta = self.native.metadata(current)
                    require(current_meta["identity"] == baseline[0]
                            and current_meta["path"] == str(path)
                            and not current_meta["attributes"] & 0x400,
                            "DIRECTORY_CURRENT_PATH_DRIFT")
                finally:
                    require(self.native.k.CloseHandle(current), "CURRENT_PATH_CLOSE_FAILED")
            if opened is None:
                require(phase in ("preflight", "before_observation_open")
                        and not self.output.exists(), "NEW_OUTPUT_REQUIRED")
                return
            require(type(opened) is dict and type(opened.get("handle")) is int
                    and opened["handle"] > 0, "OPENED_HANDLE_REQUIRED")
            actual = self.native.metadata(opened["handle"])
            require(actual["path"] == str(self.output) and actual["links"] == 1
                    and actual["inode"] == opened.get("inode")
                    and not actual["attributes"] & (0x10 | 0x400), "OUTPUT_OBJECT_DRIFT")
            if phase in ("observation_opened", "consume"):
                require(actual["size"] == 0, "OUTPUT_NOT_EMPTY")
            # Child files can inherit from the already pinned protected parent.
            # Still inspect every writer ACE and pin the actual object's ACL.
            security = self.native.security(opened["handle"], self.allowed, protected=False)
            binding = (actual["identity"], security)
            if self.observation_baseline is None:
                require(phase == "observation_opened", "OUTPUT_NOT_BOUND")
                self.observation_baseline = binding
            else:
                require(binding == self.observation_baseline, "OUTPUT_IDENTITY_OR_ACL_DRIFT")

    def check_reservation(self, descriptor, expected_path):
        """Check the actual newly created spent file before its body is written."""
        import msvcrt
        with self.lock:
            require(not self.closed, "NAMESPACE_CLOSED")
            path = Path(expected_path)
            require(str(path.parent) == str(self.paths[0])
                    and re.fullmatch(r"[0-9a-f]{64}\.spent\.json", path.name), "RESERVATION_PATH")
            handle = msvcrt.get_osfhandle(descriptor)
            meta = self.native.metadata(handle)
            info = os.fstat(descriptor)
            require(meta["path"] == str(path) and meta["links"] == 1
                    and meta["inode"] == info.st_ino and meta["size"] == 0
                    and not meta["attributes"] & (0x10 | 0x400), "RESERVATION_OBJECT")
            self.native.security(handle, self.allowed, protected=False)

    def close(self):
        with self.lock:
            handles, self.handles = self.handles, []
            self.closed = True
            failed = False
            for handle in handles:
                failed |= not bool(self.native.k.CloseHandle(handle))
            require(not failed, "NAMESPACE_CLOSE_FAILED")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
