# -*- coding: utf-8 -*-
"""清单与完整性（协议 §5.2–§5.5、§15.3）。

- node.json / binding.json / auth-cache.json / pending-op.json schema；
- 原子写（同文件系统临时文件 + rename + fsync）；
- installed_artifacts 校验（sha256 + 路径必须位于允许根内）；
- 秘密禁令：auth-cache 与 manifest 内禁止令牌/私钥样值。
"""

import hashlib
import json
import os

from . import RUNTIME_VERSION
from .errors import CluedError
from .identifiers import now_rfc3339
from .redact import contains_secret, secret_patterns

NODE_SCHEMA = "clued.node.v0.1"
BINDING_SCHEMA = "clued.binding.v0.1"
AUTH_CACHE_SCHEMA = "clued.auth-cache.v0.1"
PENDING_SCHEMA = "clued.pending-op.v0.1"
REVOKE_TASK_SCHEMA = "clued.revoke-task.v0.1"
POLICY_VERSION = "0.1"

SCOPES = ("memory:read", "memory:write", "sync:request")


def sha256_hex(text):
    if isinstance(text, str):
        text = text.encode("utf-8")
    return hashlib.sha256(text).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write_json(path, obj):
    """原子写 JSON：同文件系统临时文件 + os.replace。"""
    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d)
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        fd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _fs_safe_path(base, candidate):
    """路径净化：canonicalize 并验证位于允许根内（§15.3）。"""
    base_real = os.path.realpath(base)
    cand_real = os.path.realpath(candidate)
    if cand_real != base_real and not cand_real.startswith(base_real + os.sep):
        raise CluedError("CLD-SEC-001",
                         "路径越界：%s 不在允许根 %s 内" % (candidate, base))
    return cand_real


def build_node_manifest(node_id, created_at=None, binding_count=0):
    return {
        "schema_version": NODE_SCHEMA,
        "node_id": node_id,
        "created_at": created_at or now_rfc3339(),
        "runtime_version": RUNTIME_VERSION,
        "canonical_provider": "github",
        "binding_count": binding_count,
    }


def validate_node_manifest(manifest):
    if not isinstance(manifest, dict):
        return False, "manifest 不是对象"
    if manifest.get("schema_version") != NODE_SCHEMA:
        return False, "node schema_version 不兼容: %r" % manifest.get(
            "schema_version")
    if not manifest.get("node_id"):
        return False, "缺少 node_id"
    return True, ""


def build_binding_manifest(binding_id, agent_id, node_id, account_id,
                           agent_type, agent_instance_label,
                           adapter_version, scopes, status="ACTIVE",
                           installed_at=None, artifacts=None):
    return {
        "schema_version": BINDING_SCHEMA,
        "binding_id": binding_id,
        "agent_id": agent_id,
        "node_id": node_id,
        "account_id": account_id,
        "agent_type": agent_type,
        "agent_instance_label": agent_instance_label,
        "adapter_version": adapter_version,
        "scopes": list(scopes),
        "status": status,
        "installed_at": installed_at or now_rfc3339(),
        "last_verified_at": None,
        "installed_artifacts": list(artifacts or []),
    }


def validate_binding_manifest(manifest):
    if not isinstance(manifest, dict):
        return False, "manifest 不是对象"
    if manifest.get("schema_version") != BINDING_SCHEMA:
        return False, "binding schema_version 不兼容: %r" % manifest.get(
            "schema_version")
    for field in ("binding_id", "agent_id", "node_id", "account_id",
                  "agent_type", "agent_instance_label"):
        if not manifest.get(field):
            return False, "缺少字段 %s" % field
    if manifest.get("status") not in ("ACTIVE", "REVOKED", "REVOKING"):
        return False, "非法 status: %r" % manifest.get("status")
    scopes = manifest.get("scopes")
    if not isinstance(scopes, list) or not scopes:
        return False, "scopes 缺失或为空"
    for s in scopes:
        if s not in SCOPES:
            return False, "未知 scope: %r" % s
    for art in manifest.get("installed_artifacts") or []:
        if not isinstance(art, dict) or "path" not in art or "sha256" not in art:
            return False, "artifact 条目缺 path/sha256"
    if contains_secret(json.dumps(manifest, ensure_ascii=False)):
        return False, "manifest 含凭据样值（禁止）"
    return True, ""


def build_auth_cache(binding_id, account_id, scopes, authorized_at, provider,
                     provider_subject_hash, node_id, proof_hash,
                     policy_version=POLICY_VERSION):
    return {
        "schema_version": AUTH_CACHE_SCHEMA,
        "binding_id": binding_id,
        "account_id": account_id,
        "scopes": list(scopes),
        "authorized_at": authorized_at,
        "provider": provider,
        "provider_subject_hash": provider_subject_hash,
        "policy_version": policy_version,
        "proof_hash": proof_hash,
    }


def compute_proof_hash(binding_id, account_id, scopes, authorized_at, provider,
                       provider_subject_hash, node_id, policy_version):
    canonical = "|".join([
        binding_id, account_id, ",".join(sorted(scopes)), authorized_at,
        provider, provider_subject_hash, node_id, policy_version,
    ])
    return sha256_hex(canonical)


def validate_auth_cache(entry, binding_id, node_id):
    """校验 LKG 缓存完整性（协议 §7.4 篡改 → 禁止降级）。返回 (ok, 错误)。"""
    if not isinstance(entry, dict):
        return False, "LKG 缓存不是对象"
    if entry.get("schema_version") != AUTH_CACHE_SCHEMA:
        return False, "auth-cache schema_version 不兼容"
    if entry.get("binding_id") != binding_id:
        return False, "LKG 缓存 binding_id 不匹配"
    expect = compute_proof_hash(
        binding_id, entry.get("account_id") or "", entry.get("scopes") or [],
        entry.get("authorized_at") or "", entry.get("provider") or "",
        entry.get("provider_subject_hash") or "", node_id,
        entry.get("policy_version") or "")
    if expect != entry.get("proof_hash"):
        return False, "LKG 证明完整性失败（proof_hash 不匹配）"
    scopes = entry.get("scopes")
    if not isinstance(scopes, list) or not scopes:
        return False, "LKG scopes 缺失"
    for s in scopes:
        if s not in SCOPES:
            return False, "LKG 未知 scope: %r" % s
    if contains_secret(json.dumps(entry, ensure_ascii=False)):
        return False, "LKG 缓存含凭据样值（违规）"
    return True, ""


def build_pending_op(operation_id, binding_id, agent_id, node_id, session_id,
                     operation_type, memory_id, base_revision, payload_ref,
                     payload_sha256, created_at=None, status="PENDING"):
    return {
        "schema_version": PENDING_SCHEMA,
        "operation_id": operation_id,
        "binding_id": binding_id,
        "agent_id": agent_id,
        "node_id": node_id,
        "session_id": session_id,
        "operation_type": operation_type,
        "memory_id": memory_id,
        "base_revision": base_revision,
        "payload_ref": payload_ref,
        "payload_sha256": payload_sha256,
        "created_at": created_at or now_rfc3339(),
        "status": status,
        "attempt_count": 0,
        "last_attempt_at": None,
        "last_error_code": None,
    }


def validate_pending_op(op):
    if not isinstance(op, dict):
        return False, "journal 条目不是对象"
    if op.get("schema_version") != PENDING_SCHEMA:
        return False, "pending-op schema_version 不兼容"
    for field in ("operation_id", "binding_id", "agent_id", "node_id",
                  "session_id", "memory_id", "payload_ref", "payload_sha256",
                  "created_at"):
        if not op.get(field):
            return False, "缺少字段 %s" % field
    if op.get("operation_type") not in ("CREATE", "UPDATE", "DELETE"):
        return False, "非法 operation_type: %r" % op.get("operation_type")
    if op.get("status") not in ("PENDING", "APPLYING", "SYNCED",
                                "CONFLICTED", "REJECTED", "PENDING_CORRUPT"):
        return False, "非法 status: %r" % op.get("status")
    if contains_secret(json.dumps(op, ensure_ascii=False)):
        return False, "journal 条目含凭据样值（违规）"
    return True, ""


def build_revoke_task(task_id, binding_id, agent_id, node_id, created_at=None,
                      attempts=0, last_error=None):
    return {
        "schema_version": REVOKE_TASK_SCHEMA,
        "task_id": task_id,
        "binding_id": binding_id,
        "agent_id": agent_id,
        "node_id": node_id,
        "created_at": created_at or now_rfc3339(),
        "status": "PENDING",
        "attempts": attempts,
        "last_attempt_at": None,
        "last_error": last_error,
    }
