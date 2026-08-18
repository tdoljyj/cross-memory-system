# -*- coding: utf-8 -*-
"""Memory Access 门禁（协议 §4.1 / §7.1 / §7.6）。

- 读/写/召回全部属 Memory Access：第一次访问前必须经会话授权引擎
  （在线尝试 → AUTHORIZED / DEGRADED / DENIED，由 Controller 编排）；
- 引擎复用：经 adapters.CLIAdapter → memory_engine（不复制引擎逻辑，
  §2.2 冻结区）；
- 写路径：引擎落盘 → payload 引用包（路径+sha256，无明文复制）→
  先原子持久化 Journal → 再确认（§9.3.2）；
- NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION（§3.6）。
"""

import json
import os

from adapters.cli_adapter import CLIAdapter
from memory_engine import store
from memory_engine import schema as S

from . import manifests
from .errors import CluedError
from .identifiers import new_uuid
from .pending_journal import PendingJournal

INDEX_REL = os.path.join("memory", "object-index.json")
AUDIT_REL = os.path.join("memory", "audit", "audit.log")
OBJECTS_REL = os.path.join("memory", "objects")


class WriteOutcome(object):
    def __init__(self, decision, memory_id=None, target_id=None, op=None,
                 synced=False, reason=""):
        self.decision = decision
        self.memory_id = memory_id
        self.target_id = target_id
        self.op = op
        self.synced = synced
        self.reason = reason

    def to_dict(self):
        return {
            "decision": self.decision,
            "memory_id": self.memory_id,
            "target_id": self.target_id,
            "operation_id": (self.op or {}).get("operation_id"),
            "synced": self.synced,
            "reason": self.reason,
        }


class MemoryGate(object):
    """引擎复用 + Journal 编排。不直接 git commit/push（交恢复层）。"""

    def __init__(self, repo, runtime_paths, adapter=None, audit=None):
        self.repo = os.path.abspath(repo)
        self.paths = runtime_paths
        self.adapter = adapter or CLIAdapter()
        self.journal = PendingJournal(runtime_paths, audit=audit)
        self.audit = audit

    # ---- 读 ----
    def recall(self, query, tier="T2", **kwargs):
        result = self.adapter.recall(query=query, tier=tier, **kwargs)
        return {"tier": tier, "result": result.to_dict()
                if hasattr(result, "to_dict") else str(result)}

    # ---- 写（引擎 → 引用包 → Journal → 确认）----
    def write(self, binding, session_id, operation, content, memory_id=None,
              category=None, request_id=None, remember=False):
        """operation ∈ CREATE/UPDATE/SUPERSEDE/DELETE。

        返回 WriteOutcome；NO_CHANGE 时无 Journal、无副作用。
        """
        agent_id = binding.get("agent_id")
        node_id = binding.get("node_id")
        binding_id = binding.get("binding_id")

        if operation == "CREATE":
            return self._create(binding, session_id, content, category,
                                request_id, remember)
        if operation in ("UPDATE", "SUPERSEDE", "DELETE"):
            if not memory_id:
                raise CluedError("CLD-BIND-001",
                                 "%s 需要 --id 指定目标对象" % operation)
            return self._mutate(binding, session_id, operation, content,
                                memory_id, request_id)
        raise CluedError("CLD-PEND-002", "未知操作类型: %s" % operation)

    def _base_sha(self, memory_id):
        p = store.object_path(memory_id)
        if not os.path.isfile(p):
            return None
        return manifests.sha256_file(p)

    def _ref_bundle(self, operation_id, payload_files):
        """受保护引用包：只存路径 + sha256，不复制明文（§9.3.7）。

        位于运行时根内（gitignored，不入 Canonical Store）。
        """
        d = os.path.join(self.paths.root, "pending-refs")
        if not os.path.isdir(d):
            os.makedirs(d)
        path = os.path.join(d, "%s.json" % operation_id)
        manifests.atomic_write_json(path, {"payload_files": payload_files})
        rel = os.path.relpath(path, self.repo)
        return rel, manifests.sha256_file(path)

    def _journalize(self, binding, session_id, operation, memory_id,
                    base_revision, payload_files, request_id):
        op_id = new_uuid()
        ref_rel, ref_sha = self._ref_bundle(op_id, payload_files)
        op = self.journal.create(
            binding.get("binding_id"), binding.get("agent_id"),
            binding.get("node_id"), session_id, operation, memory_id,
            base_revision, ref_rel, ref_sha, operation_id=op_id,
            request_id=request_id)
        return op

    def _payload_files(self, object_ids):
        files = {os.path.relpath(store.object_path(oid), self.repo):
                 manifests.sha256_file(store.object_path(oid))
                 for oid in object_ids}
        for rel in (INDEX_REL, AUDIT_REL):
            p = os.path.join(self.repo, rel)
            if os.path.isfile(p):
                files[rel] = manifests.sha256_file(p)
        return files

    def _create(self, binding, session_id, content, category, request_id,
                remember):
        oid = store.new_id()
        candidate = S.new_object(
            oid=oid, type_="semantic", content=content, scope="global",
            status="active" if remember else None, category=category,
            evidence="explicit" if remember else "observed",
            adapter="clued", session_id=session_id, source_kind="user_explicit")
        result = self.adapter.write(
            candidate, session_id=session_id, explicit_remember=remember)
        if result.decision == "NO_CHANGE":
            return WriteOutcome("NO_CHANGE", memory_id=result.target_id,
                                reason=result.reason)
        files = self._payload_files([result.memory_id or oid])
        op = self._journalize(binding, session_id, "CREATE",
                              "obj:" + (result.memory_id or oid), None,
                              files, request_id)
        return WriteOutcome(result.decision, memory_id=result.memory_id,
                            target_id=result.target_id, op=op,
                            reason=result.reason)

    def _mutate(self, binding, session_id, operation, content, memory_id,
                request_id):
        target = store.load_object(memory_id)
        if not target:
            raise CluedError("CLD-BIND-001", "对象不存在: %s" % memory_id)
        base = self._base_sha(memory_id)
        touched = [memory_id]
        if operation == "UPDATE":
            result = self.adapter.update(memory_id, content,
                                         session_id=session_id)
        elif operation == "SUPERSEDE":
            result = self.adapter.supersede(memory_id, content,
                                            session_id=session_id)
            if result.memory_id:
                touched.append(result.memory_id)
        else:  # DELETE
            from memory_engine import write_engine
            write_engine.archive_object(
                memory_id, adapter="clued", session_id=session_id,
                reason="clued delete")
            result = type("R", (), {
                "decision": "DELETE_MEMORY", "memory_id": None,
                "target_id": memory_id, "reason": "归档（不物理删除）"})()

        if result.decision == "NO_CHANGE":
            return WriteOutcome("NO_CHANGE", target_id=memory_id,
                                reason=result.reason)
        files = self._payload_files(touched)
        op = self._journalize(binding, session_id, operation,
                              "obj:" + memory_id, base, files, request_id)
        return WriteOutcome(result.decision, memory_id=result.memory_id,
                            target_id=result.target_id, op=op,
                            reason=result.reason)

    def payload_files_of(self, op):
        """解引用包 → {relpath: sha256}。损坏返回 None。"""
        ref = op.get("payload_ref") or ""
        path = os.path.join(self.repo, ref.replace("/", os.sep))
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as fh:
                bundle = json.load(fh)
        except (ValueError, OSError):
            return None
        files = bundle.get("payload_files")
        if not isinstance(files, dict) or not files:
            return None
        if manifests.sha256_file(path) != op.get("payload_sha256"):
            return None
        return dict(files)
