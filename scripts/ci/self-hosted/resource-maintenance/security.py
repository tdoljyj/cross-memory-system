"""Private directories for new managed caches; never relax an existing ACL."""
import ctypes
import os
from pathlib import Path


def _windows_api():
    from ctypes import wintypes as w
    adv, kernel = ctypes.WinDLL("advapi32", use_last_error=True), ctypes.WinDLL("kernel32", use_last_error=True)
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    adv.GetNamedSecurityInfoW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                                        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
    adv.GetAce.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    return adv, kernel, w


def create_directory(path: Path, principal: str):
    if os.name != "nt":
        path.mkdir(mode=0o700)
        return
    adv, kernel, w = _windows_api()
    class Attributes(ctypes.Structure):
        _fields_ = [("length", w.DWORD), ("descriptor", ctypes.c_void_p), ("inherit", w.BOOL)]
    descriptor = ctypes.c_void_p()
    sddl = f"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{principal})"
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise OSError("PRIVATE_DESCRIPTOR_FAILED")
    attributes = Attributes(ctypes.sizeof(Attributes), descriptor, False)
    kernel.CreateDirectoryW.argtypes = [w.LPCWSTR, ctypes.POINTER(Attributes)]
    try:
        if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
            raise OSError("PRIVATE_DIRECTORY_FAILED")
    finally:
        kernel.LocalFree(descriptor)


def windows_private(path: Path, principal: str, *, ancestor=False):
    adv, kernel, w = _windows_api()
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    if adv.GetNamedSecurityInfoW(str(path), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor)):
        return False
    def sid_text(pointer):
        text = w.LPWSTR()
        if not adv.ConvertSidToStringSidW(pointer, ctypes.byref(text)):
            raise OSError("SID_READ_FAILED")
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))
    try:
        trusted = {principal, "S-1-5-18", "S-1-5-32-544"}
        if ancestor:
            # Windows volume-root owner: NT SERVICE\TrustedInstaller.
            trusted.add("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
        if not dacl.value or sid_text(owner) not in (trusted if ancestor else {principal}):
            return False
        trusted.add("S-1-3-4")  # OWNER RIGHTS: owner was checked above.
        # ACL header: BYTE revision, BYTE reserved, WORD size, WORD ace count.
        count = ctypes.c_ushort.from_address(dacl.value + 4).value
        for index in range(count):
            ace = ctypes.c_void_p()
            if not adv.GetAce(dacl, index, ctypes.byref(ace)):
                return False
            if ctypes.c_ubyte.from_address(ace.value + 1).value & 8:
                continue  # INHERIT_ONLY has no rights on this directory itself.
            ace_type = ctypes.c_ubyte.from_address(ace.value).value
            if ace_type == 1:  # denied access never widens write access
                continue
            if ace_type != 0:
                return False
            mask = ctypes.c_ulong.from_address(ace.value + 4).value
            trustee = sid_text(ctypes.c_void_p(ace.value + 8))
            # Ancestors must not be replaceable or permit deleting children or
            # rewriting security even when the private leaf itself is protected.
            forbidden = 0x500D0040 if ancestor else 0x500D0156
            if trustee not in trusted and mask & forbidden:
                return False
        return True
    finally:
        kernel.LocalFree(descriptor)
