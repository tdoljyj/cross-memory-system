#!/usr/bin/env python3
from __future__ import annotations
import json, os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from .common import ProtocolError, strict_json_loads, strict_utf8_decode

STORE_ERROR_STATUS = {
    "IDEMPOTENCY_CONFLICT": 409, "STALE_CONTEXT_REQUIRES_REFRESH": 409,
    "CONFIRMATION_TARGET_CHANGED": 409, "INTENT_IDENTITY_CONFLICT": 409,
    "MPS_AUTHORIZATION_DENIED": 403, "MPS_RESULT_READ_DENIED": 403,
    "OBJECT_NOT_FOUND": 404, "MPS_CONTEXT_BASIS_NOT_FOUND_OR_INCONSISTENT": 404,
    "MPS_INTENT_NOT_FOUND": 404,
}

class Handler(BaseHTTPRequestHandler):
    """Transport-only gateway handler. Durable semantics live in the injected store."""
    store = None
    server_version = "CluedMPS03Gateway/1"

    def log_message(self, fmt, *args):
        if os.environ.get("MPS03_HTTP_LOG") == "1":
            super().log_message(fmt, *args)

    def _json(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        value = strict_json_loads(strict_utf8_decode(raw))
        if not isinstance(value, dict):
            raise ProtocolError("JSON_OBJECT_REQUIRED", "request body must be a JSON object", 400)
        return value

    def _token(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            raise ProtocolError("SESSION_REQUIRED", "Bearer session token required", 401)
        return h[7:]

    def _send(self, status, obj):
        data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _dispatch(self):
        p = urlparse(self.path).path
        method = self.command
        if method == "GET" and p == "/health":
            return 200, {"ok": True, "service": "mps03-gateway", "backend": getattr(self.store, "backend_name", "unknown")}
        if method == "POST" and p == "/v1/sessions":
            b = self._json()
            return 200, self.store.create_session(b.get("entry_kind", ""), b.get("entry_secret", ""))
        if method == "GET" and p == "/v1/objects":
            return 200, self.store.list_objects(self._token())
        if method == "POST" and p == "/v1/objects":
            b = self._json()
            return 200, self.store.create_object(self._token(), b.get("title", "Untitled"), b.get("body", {}), b.get("request_id", ""))
        parts = [x for x in p.split("/") if x]
        if len(parts) >= 3 and parts[:2] == ["v1", "objects"]:
            oid = parts[2]
            if len(parts) == 3 and method == "GET":
                return 200, self.store.read_object(self._token(), oid)
            if len(parts) == 4 and parts[3] == "proposals" and method == "GET":
                return 200, self.store.list_proposals(self._token(), oid)
            if len(parts) == 4 and parts[3] == "proposals" and method == "POST":
                b = self._json()
                return 200, self.store.create_proposal(self._token(), oid, b.get("proposed_body", {}), b.get("observed_state_stamp", {}))
            if len(parts) == 4 and parts[3] == "confirm" and method == "POST":
                b = self._json()
                return 200, self.store.confirm_proposal(self._token(), oid, b.get("proposal_id", ""), b.get("state_stamp", {}), b.get("request_id", ""), b.get("adoption_scope", "object"), b.get("adoption_purpose", "mps03_accept_agent_proposal"))
            if len(parts) == 4 and parts[3] == "history" and method == "GET":
                return 200, self.store.history(self._token(), oid)
        raise ProtocolError("NOT_FOUND", "endpoint not found", 404)

    def do_GET(self): self._handle()
    def do_POST(self): self._handle()

    def _handle(self):
        try:
            status, obj = self._dispatch()
            if status == 200 and isinstance(obj, dict) and obj.get("ok") is False:
                status = STORE_ERROR_STATUS.get(obj.get("error"), 409 if obj.get("status") == "conflict" else 500)
        except ProtocolError as e:
            status, obj = e.status, e.as_dict()
        except Exception:
            status, obj = 500, {"ok": False, "error": "INTERNAL_ERROR", "message": "gateway operation failed"}
        self._send(status, obj)
