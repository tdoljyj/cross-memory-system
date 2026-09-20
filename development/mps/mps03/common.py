from __future__ import annotations
import hashlib, json, time, uuid
from typing import Any

PROTOCOL_VERSION = "clued.mps03.entry.v1"

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
