from __future__ import annotations
import base64, binascii, hashlib, json, secrets, time, uuid
from typing import Any

PROTOCOL_VERSION = "clued.mps03.entry.v1"
NATIVE_GATEWAY_PREFIX = "mps03-native-gw-"
AGENT_GATEWAY_PREFIX = "mps03-agent-gw-"
NATIVE_ACCESS_PREFIX = "mps03-native-access-"
AGENT_ACCESS_PREFIX = "mps03-agent-access-"

def require_secret_namespace(value: str, prefix: str, name: str) -> None:
    """Keep the four entry credentials disjoint even across separate processes."""
    if not isinstance(value, str) or not value.startswith(prefix) or len(value[len(prefix):]) < 32:
        raise RuntimeError(f"{name} requires its dedicated prefix and at least 32 secret characters")

def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()

def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"

def now_ns() -> int:
    return time.time_ns()

class ProtocolError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 400, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}

    def as_dict(self) -> dict:
        return {"ok": False, "error": self.code, "message": self.message, "details": self.details}

def strict_utf8_decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ProtocolError("INVALID_UTF8", "request body must be UTF-8", 400) from None


def strict_json_loads(raw: str):
    def pairs_hook(pairs):
        out = {}
        for k, v in pairs:
            if k in out:
                raise ProtocolError("DUPLICATE_JSON_KEY", f"duplicate JSON key: {k}", 400)
            out[k] = v
        return out
    def no_float(value):
        raise ProtocolError("MPS_JSON_V1_INTEGER_REQUIRED", f"floating-point JSON number rejected: {value}", 400)
    def no_constant(value):
        raise ProtocolError("INVALID_JSON_NUMBER", f"non-finite JSON number rejected: {value}", 400)
    try:
        return json.loads(raw, object_pairs_hook=pairs_hook, parse_float=no_float, parse_constant=no_constant)
    except ProtocolError:
        raise
    except Exception as e:
        raise ProtocolError("INVALID_JSON", "request body must be valid JSON", 400, {"reason": str(e)})


def require_entry_access(header: str, kind: str, access_secret: str) -> None:
    """Authenticate the caller at the entry, independently of its gateway session."""
    try:
        scheme, value = header.split(" ", 1)
        if kind == "NATIVE":
            if scheme.lower() != "basic":
                raise ValueError("Basic required")
            decoded = base64.b64decode(value, validate=True).decode("utf-8")
            user, supplied_secret = decoded.split(":", 1)
            valid = secrets.compare_digest(user, "native") and secrets.compare_digest(supplied_secret, access_secret)
        else:
            valid = scheme.lower() == "bearer" and secrets.compare_digest(value, access_secret)
    except (ValueError, UnicodeError, binascii.Error):
        valid = False
    if not valid:
        raise ProtocolError("ENTRY_ACCESS_DENIED", "entry caller credential required", 401)


def validate_create_content(title: str, body: Any) -> dict:
    """Keep the full create payload represented in the formal content digest."""
    if not isinstance(title, str) or not title.strip():
        raise ProtocolError("INVALID_TITLE", "title must be a nonempty string", 400)
    if not isinstance(body, dict):
        raise ProtocolError("JSON_OBJECT_REQUIRED", "object body must be a JSON object", 400)
    if "title" in body:
        raise ProtocolError("TITLE_IN_BODY_NOT_ALLOWED", "title must be supplied only in the title field", 400)
    return {**body, "title": title}


def normalize_request_id(value: Any) -> str:
    """Use the same request key as the formal MPS-02B commit primitive."""
    if not isinstance(value, str):
        raise ProtocolError("REQUEST_ID_REQUIRED", "request_id must be 8 to 160 characters", 400)
    request_id = value.strip(" ")  # pg_catalog.btrim(text) removes ordinary spaces.
    if not 8 <= len(request_id) <= 160:
        raise ProtocolError("REQUEST_ID_REQUIRED", "request_id must be 8 to 160 characters", 400)
    return request_id
