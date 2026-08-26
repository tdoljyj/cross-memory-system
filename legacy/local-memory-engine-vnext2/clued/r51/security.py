# -*- coding: utf-8 -*-
"""R5.1 device, Binding, IPC and protected-local-state security."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import ipaddress
import json
import os
import socket
import stat
import tempfile
from dataclasses import dataclass, field
from typing import Dict, Iterable, Optional, Set
from urllib.parse import urlsplit

from .idempotency import CallerIdentity


class SecurityError(RuntimeError):
    code = "DENIED_SECURITY"

    def __init__(self, code=None):
        self.code = code or self.code
        super().__init__(self.code)


class AccessDenied(SecurityError):
    code = "DENIED"


class DeviceRevoked(SecurityError):
    code = "DEVICE_REVOKED"


class BindingRevoked(SecurityError):
    code = "BINDING_REVOKED"


class IPCIdentityError(SecurityError):
    code = "IPC_IDENTITY_MISMATCH"


class ProtectedStoreError(SecurityError):
    code = "PROTECTED_STORE_ERROR"


@dataclass
class Grant:
    caller: CallerIdentity
    scopes: Set[str] = field(default_factory=set)
    device_active: bool = True
    binding_active: bool = True


class AccessController:
    """Fail-closed account/Device/Binding/scope authorization."""

    def __init__(self):
        self._grants: Dict[tuple, Grant] = {}

    def register(self, caller: CallerIdentity, scopes: Iterable[str]):
        grant = Grant(caller=caller, scopes=set(scopes))
        self._grants[caller.key()] = grant
        return grant

    def grant_for(self, caller: CallerIdentity) -> Grant:
        grant = self._grants.get(caller.key())
        if grant is None:
            raise AccessDenied()
        if not grant.device_active:
            raise DeviceRevoked()
        if not grant.binding_active:
            raise BindingRevoked()
        return grant

    def require(self, caller: CallerIdentity, scope: str) -> Grant:
        grant = self.grant_for(caller)
        if scope not in grant.scopes:
            raise AccessDenied()
        return grant

    def can_read_object(self, caller: CallerIdentity, item: dict) -> bool:
        try:
            grant = self.require(caller, "memory:read")
        except SecurityError:
            raise
        account_id = str(item.get("account_id") or "")
        if account_id != caller.account_id:
            return False
        required = item.get("required_scope")
        if required and required not in grant.scopes:
            return False
        return True

    def revoke_device(self, account_id: str, device_id: str):
        matched = False
        for grant in self._grants.values():
            if (grant.caller.account_id == account_id
                    and grant.caller.device_id == device_id):
                grant.device_active = False
                matched = True
        return matched

    def revoke_binding(self, account_id: str, binding_id: str):
        matched = False
        for grant in self._grants.values():
            if (grant.caller.account_id == account_id
                    and grant.caller.binding_id == binding_id):
                grant.binding_active = False
                matched = True
        return matched


class IPCVerifier:
    """Authenticate local IPC envelopes with a device-protected HMAC key."""

    def __init__(self, caller: CallerIdentity, secret: bytes):
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("IPC secret must contain at least 32 bytes")
        self.caller = caller
        self._secret = secret

    @staticmethod
    def _encoded(envelope: dict) -> bytes:
        clean = dict(envelope)
        clean.pop("signature", None)
        return json.dumps(
            clean, ensure_ascii=False, sort_keys=True,
            separators=(",", ":")).encode("utf-8")

    def sign(self, envelope: dict) -> str:
        return hmac.new(
            self._secret, self._encoded(envelope), hashlib.sha256).hexdigest()

    def verify(self, envelope: dict) -> None:
        if (str(envelope.get("account_id")) != self.caller.account_id
                or str(envelope.get("binding_id")) != self.caller.binding_id
                or str(envelope.get("device_id")) != self.caller.device_id):
            raise IPCIdentityError()
        supplied = str(envelope.get("signature") or "")
        expected = self.sign(envelope)
        if not hmac.compare_digest(supplied, expected):
            raise IPCIdentityError()


class Protector:
    """Interface for OS-bound byte protection."""

    def protect(self, plaintext: bytes) -> bytes:
        raise NotImplementedError

    def unprotect(self, ciphertext: bytes) -> bytes:
        raise NotImplementedError


class WindowsDPAPIProtector(Protector):
    """Current-user DPAPI protection.  Non-Windows hosts fail closed."""

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_ulong),
                    ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    @classmethod
    def _blob(cls, value: bytes):
        buffer = ctypes.create_string_buffer(value)
        blob = cls._BLOB(
            len(value),
            ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        return blob, buffer

    def _crypt(self, value: bytes, decrypt: bool) -> bytes:
        if os.name != "nt":
            raise ProtectedStoreError("OS_PROTECTION_UNAVAILABLE")
        source, keepalive = self._blob(value)
        target = self._BLOB()
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        if decrypt:
            ok = crypt32.CryptUnprotectData(
                ctypes.byref(source), None, None, None, None, 0,
                ctypes.byref(target))
        else:
            ok = crypt32.CryptProtectData(
                ctypes.byref(source), "Clued local state", None, None, None,
                0, ctypes.byref(target))
        if not ok:
            raise ProtectedStoreError("OS_PROTECTION_FAILED")
        try:
            return ctypes.string_at(target.pbData, target.cbData)
        finally:
            kernel32.LocalFree(target.pbData)
            del keepalive

    def protect(self, plaintext: bytes) -> bytes:
        return self._crypt(plaintext, False)

    def unprotect(self, ciphertext: bytes) -> bytes:
        return self._crypt(ciphertext, True)


def _reject_link(path: str) -> None:
    if not os.path.lexists(path):
        return
    info = os.lstat(path)
    attributes = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if os.path.islink(path) or attributes & reparse:
        raise ProtectedStoreError("LINK_TARGET_REJECTED")
    if not stat.S_ISREG(info.st_mode):
        raise ProtectedStoreError("NON_REGULAR_TARGET_REJECTED")
    if getattr(info, "st_nlink", 1) != 1:
        raise ProtectedStoreError("UNEXPECTED_LINK_COUNT")


class ProtectedJsonStore:
    """Atomic JSON storage encrypted by a caller-supplied OS protector."""

    def __init__(self, path: str, protector: Protector):
        self.path = os.path.abspath(path)
        self.protector = protector

    def save(self, value: dict) -> None:
        _reject_link(self.path)
        parent = os.path.dirname(self.path)
        os.makedirs(parent, mode=0o700, exist_ok=True)
        encoded = json.dumps(
            value, ensure_ascii=False, sort_keys=True,
            separators=(",", ":")).encode("utf-8")
        payload = base64.b64encode(self.protector.protect(encoded))
        fd, temporary = tempfile.mkstemp(prefix=".clued-", dir=parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            _reject_link(self.path)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)

    def load(self) -> dict:
        _reject_link(self.path)
        with open(self.path, "rb") as handle:
            payload = handle.read()
        try:
            raw = self.protector.unprotect(base64.b64decode(payload))
            value = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            if isinstance(exc, ProtectedStoreError):
                raise
            raise ProtectedStoreError("PROTECTED_STORE_CORRUPT")
        if not isinstance(value, dict):
            raise ProtectedStoreError("PROTECTED_STORE_INVALID")
        return value


def validate_public_https_url(url: str):
    """Resolve and reject credentialed or non-public HTTP destinations."""
    parsed = urlsplit(str(url or ""))
    if parsed.scheme != "https" or not parsed.hostname:
        raise SecurityError("SSRF_URL_REJECTED")
    if parsed.username is not None or parsed.password is not None:
        raise SecurityError("SSRF_CREDENTIAL_REJECTED")
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        }
    except OSError:
        raise SecurityError("SSRF_DNS_FAILED")
    if not addresses:
        raise SecurityError("SSRF_DNS_FAILED")
    for raw in addresses:
        address = ipaddress.ip_address(raw)
        if not address.is_global:
            raise SecurityError("SSRF_PRIVATE_ADDRESS_REJECTED")
    return {"host": parsed.hostname, "port": parsed.port or 443,
            "addresses": sorted(addresses)}
