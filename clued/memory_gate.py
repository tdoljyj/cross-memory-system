# -*- coding: utf-8 -*-
"""Memory Access 门禁（协议 §4.1 / §7.1 / §7.6，v0.3.0）。

- 读/写/召回全部属 Memory Access：第一次访问前必须经会话授权引擎
  （在线尝试 → AUTHORIZED / DEGRADED / DENIED，由 Controller 编排）；
- 引擎复用：经 adapters.CLIAdapter → memory_engine（不复制引擎逻辑，
  §2.2 冻结区）；
- 写路径统一原子顺序（CLD-FIX-003，执行计划 §5.2）：
    1. 生成稳定 operation_id；
    2. 将操作 payload（语义包络：重放所需的全部参数 + 用户内容）原子写入
       受保护本地 staging（<runtime>/pending-refs/<operation_id>.json，
       位于 .clued/ 或等价运行时位置，gitignored，不入 Canonical Store）；
    3. 计算并校验 payload_sha256；
    4. 原子创建 PENDING Journal 条目（<runtime>/pending/<operation_id>.json）；
    5. 将操作暴露给本地 pending view（降级读取/写入目标解析的 overlay）；
    6. 向用户确认「已保存在本地、尚未同步」。
  排队期间（降级 / 在线同步失败）**不修改 Git 跟踪工作树**：恢复前
  sync doctor 因此可以真实 PASS；恢复在成功 pull 之后按原 operation_id
  把 payload replay 到 Memory Engine（同一 engine API、同一对象 id，
  幂等效果，§9.4）。
- NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION（§3.6）。
"""

import json
import os

from adapters.cli_adapter import CLIAdapter
from memory_engine import store
from memory_engine import schema as S
from memory_engine import write_engine

from . import manifests
from .errors import CluedError
from .identifiers import new_uuid
from .pending_journal import (
    PAYLOAD_SCHEMA, PendingJournal, validate_payload_envelope,
)

INDEX_REL = "memory/object-index.json"
AUDIT_REL = "memory/audit/audit.log"
OBJECTS_REL = "memory/objects"


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


def _object_rel(oid):
    return "memory/objects/%s.json" % oid


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

    # ================= payload 包络（受保护本地 staging）=================
    def _payload_path(self, operation_id):
        d = self.paths.payload_refs_dir()
        if not os.path.isdir(d):
            os.makedirs(d)
        return self.paths.payload_ref_file(operation_id)

    def payload_dir(self):
        return os.path.join(self.paths.root, "pending-refs")

    def _payload_rel(self, operation_id):
        return os.path.relpath(self._payload_path(operation_id), self.repo)

    def stage_payload(self, operation_id, envelope):
        """受保护本地 staging：原子写 payload 包络，返回 (rel, sha256)。"""
        path = self._payload_path(operation_id)
        manifests.atomic_write_json(path, envelope)
        rel = self._payload_rel(operation_id)
        return rel, manifests.sha256_file(path)

    def load_payload(self, op):
        """解引用 payload 包络。返回 (envelope|None, err|None)。"""
        ref = op.get("payload_ref") or ""
        path = os.path.join(self.repo, ref.replace("/", os.sep))
        if not os.path.isfile(path):
            return None, "payload 包络缺失: %s" % ref
        try:
            raw = manifests.read_json(path)
        except Exception:
            return None, "payload 包络不可解析: %s" % ref
        if manifests.sha256_file(path) != op.get("payload_sha256"):
            return None, "payload 包络 sha256 不符: %s" % ref
        ok, err = validate_payload_envelope(raw, op)
        if not ok:
            return None, "payload 包络无效: %s" % err
        return raw, None

    def op_primary_relpath(self, op):
        """本操作的主对象文件（乐观锁主键）：memory/objects/<id>.json。"""
        envelope, err = self.load_payload(op)
        if err:
            return None
        oid = None
        if envelope.get("engine_op") == "SUPERSEDE":
            oid = envelope.get("target_id")
        elif envelope.get("engine_op") == "DELETE":
            oid = envelope.get("target_id")
        else:
            oid = envelope.get("memory_id") or envelope.get("target_id")
        if not oid:
            return None
        return _object_rel(oid)

    def residue_paths(self, op):
        """本操作 replay 可能触碰的工作树文件集合（崩溃残留判定用）。"""
        envelope, err = self.load_payload(op)
        if err:
            return set()
        out = set()
        for oid in (envelope.get("memory_id"), envelope.get("target_id"),
                    envelope.get("successor_oid")):
            if oid:
                out.add(_object_rel(oid))
        out.add(INDEX_REL)
        out.add(AUDIT_REL)
        return out

    # ================= pending view（降级期间的本地 overlay）=================
    def _pending_ops_all(self):
        return self.journal.list_all(statuses=("PENDING",))

    def _overlay_for(self, memory_id):
        """memory_id 的 pending 链效果（最后一条生效）。"""
        result = None
        for op in self._pending_ops_all():
            if op.get("memory_id") != "obj:" + memory_id:
                continue
            env, err = self.load_payload(op)
            if err:
                continue
            if env.get("engine_op") == "DELETE":
                result = {"status": "archived", "id": memory_id,
                          "_deleted": True}
                result.update(self._target_dict_of(env, memory_id) or {})
            else:
                result = self._result_dict_of(env)
        return result

    def _target_dict_of(self, env, memory_id):
        obj = store.load_object(memory_id)
        return dict(obj) if obj else {"id": memory_id}

    def _result_dict_of(self, env):
        """envelope 语义效果的对象 dict（CREATE/UPDATE/SUPERSEDE）。"""
        if env.get("engine_op") == "CREATE":
            return dict(env.get("candidate") or {})
        if env.get("engine_op") == "SUPERSEDE":
            return dict(env.get("successor_candidate") or {})
        # UPDATE：目标当前 dict + content 替换（overlay 用）
        target = store.load_object(env.get("target_id"))
        if not target:
            return {"id": env.get("target_id"), "content": env.get("content"),
                    "status": "active"}
        obj = dict(target)
        obj["content"] = env.get("content")
        return obj

    def effective_object(self, memory_id):
        """工作树 + pending overlay 的当前有效对象。"""
        over = self._overlay_for(memory_id)
        if over is not None:
            if over.get("_deleted"):
                return {"id": memory_id, "status": "archived"}
            return over
        return store.load_object(memory_id)

    def effective_objects(self):
        """decide() 用的有效对象列表（工作树 + pending overlay）。"""
        ids = set(store.list_object_ids())
        for op in self._pending_ops_all():
            mid = (op.get("memory_id") or "").split(":", 1)
            if len(mid) == 2:
                ids.add(mid[1])
        out = []
        for oid in sorted(ids):
            obj = self.effective_object(oid)
            if obj and obj.get("id"):
                out.append(obj)
        return out

    def pending_view_note(self, binding_id=None):
        """降级状态说明：本地未同步操作数量（不复制内容）。"""
        n = self.journal.pending_count(binding_id)
        return {"pending_ops": n,
                "note": ("%d 个本地操作尚未同步；同步完成后进入召回索引"
                         % n) if n else ""}

    # ================= 写（staging → Journal → 确认）=================
    def write(self, binding, session_id, operation, content, memory_id=None,
              category=None, request_id=None, remember=False):
        """operation ∈ CREATE/UPDATE/SUPERSEDE/DELETE。

        返回 WriteOutcome；NO_CHANGE 时无 Journal、无副作用。排队期间
        不修改工作树（恢复前 doctor 可真实 PASS）。
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

    def _journalize(self, binding, session_id, operation, memory_id,
                    base_revision, envelope, request_id):
        op_id = new_uuid()
        envelope["operation_id"] = op_id
        ref_rel, ref_sha = self.stage_payload(op_id, envelope)
        # Journal 的 operation_type 遵循 §9.2 枚举（SUPERSEDE 归入 UPDATE）
        journal_type = "UPDATE" if operation == "SUPERSEDE" else operation
        op = self.journal.create(
            binding.get("binding_id"), binding.get("agent_id"),
            binding.get("node_id"), session_id, journal_type, memory_id,
            base_revision, ref_rel, ref_sha, operation_id=op_id,
            request_id=request_id)
        return op

    def _create(self, binding, session_id, content, category, request_id,
                remember):
        oid = store.new_id()
        candidate = S.new_object(
            oid=oid, type_="semantic", content=content, scope="global",
            status="active" if remember else None, category=category,
            evidence="explicit" if remember else "observed",
            adapter="clued", session_id=session_id,
            source_kind="user_explicit")
        # 只决策、不落盘：对有效对象做去重（工作树 + pending overlay）
        decision, _matched, reason = write_engine.decide(
            candidate, self.effective_objects())
        if decision == "NO_CHANGE":
            return WriteOutcome("NO_CHANGE", memory_id=(
                _matched or {}).get("id"), reason=reason)
        envelope = {
            "schema_version": PAYLOAD_SCHEMA,
            "engine_op": "CREATE",
            "memory_id": oid,
            "target_id": None,
            "base_revision": None,
            "base_pending": False,
            "content": content,
            "category": category,
            "remember": bool(remember),
            "session_id": session_id,
            "successor_oid": None,
            "candidate": candidate,
            "successor_candidate": None,
        }
        op = self._journalize(binding, session_id, "CREATE",
                              "obj:" + oid, None, envelope, request_id)
        return WriteOutcome("NEW_MEMORY", memory_id=oid, op=op,
                            reason=reason)

    def _mutate(self, binding, session_id, operation, content, memory_id,
                request_id):
        target = self.effective_object(memory_id)
        if not target or not target.get("id"):
            raise CluedError("CLD-BIND-001", "对象不存在: %s" % memory_id)
        worktree = store.load_object(memory_id)
        base = self._base_sha(memory_id)
        base_pending = worktree is None  # 目标对象只存在于 pending（链式操作）

        if operation == "UPDATE":
            candidate = dict(target)
            candidate["content"] = content
            decision, _m, reason = write_engine.decide(
                candidate, self.effective_objects())
            if decision == "NO_CHANGE":
                return WriteOutcome("NO_CHANGE", target_id=memory_id,
                                    reason=reason)
            envelope = {
                "schema_version": PAYLOAD_SCHEMA,
                "engine_op": "UPDATE",
                "memory_id": memory_id,
                "target_id": memory_id,
                "base_revision": base,
                "base_pending": base_pending,
                "content": content,
                "category": None,
                "remember": False,
                "session_id": session_id,
                "successor_oid": None,
                "candidate": None,
                "successor_candidate": None,
            }
            op = self._journalize(binding, session_id, "UPDATE",
                                  "obj:" + memory_id, base, envelope,
                                  request_id)
            return WriteOutcome("UPDATE_MEMORY", memory_id=memory_id,
                                target_id=memory_id, op=op, reason=reason)

        if operation == "SUPERSEDE":
            successor_oid = store.new_id()
            successor = S.new_object(
                oid=successor_oid, type_=target.get("type"),
                content=content, scope=target.get("scope"), status="active",
                category=(target.get("classification") or {}).get("category"),
                evidence="explicit",
                priority=(target.get("classification") or {}).get("priority"),
                recall_layer=(target.get("classification") or {}).get(
                    "recall_layer"),
                adapter="clued", session_id=session_id,
                tags=target.get("tags"), entities=target.get("entities"),
                source_kind="user_explicit")
            envelope = {
                "schema_version": PAYLOAD_SCHEMA,
                "engine_op": "SUPERSEDE",
                "memory_id": successor_oid,
                "target_id": memory_id,
                "base_revision": base,
                "base_pending": base_pending,
                "content": content,
                "category": None,
                "remember": True,
                "session_id": session_id,
                "successor_oid": successor_oid,
                "candidate": None,
                "successor_candidate": successor,
            }
            op = self._journalize(binding, session_id, "SUPERSEDE",
                                  "obj:" + memory_id, base, envelope,
                                  request_id)
            return WriteOutcome("SUPERSEDE_MEMORY", memory_id=successor_oid,
                                target_id=memory_id, op=op,
                                reason="用户明确要求推翻旧记忆")

        # DELETE（归档，不物理删除）
        envelope = {
            "schema_version": PAYLOAD_SCHEMA,
            "engine_op": "DELETE",
            "memory_id": memory_id,
            "target_id": memory_id,
            "base_revision": base,
            "base_pending": base_pending,
            "content": "",
            "category": None,
            "remember": False,
            "session_id": session_id,
            "successor_oid": None,
            "candidate": None,
            "successor_candidate": None,
        }
        op = self._journalize(binding, session_id, "DELETE",
                              "obj:" + memory_id, base, envelope, request_id)
        return WriteOutcome("DELETE_MEMORY", memory_id=memory_id,
                            target_id=memory_id, op=op,
                            reason="归档（不物理删除）")

    # ================= replay（恢复：pull 之后按原 operation_id 应用）=================
    def replay(self, op):
        """把 payload 应用到真实工作树（同一 engine API、同一对象 id）。

        返回 (decision, touched_ids)。decision ∈ applied|already|failed。
        调用方必须先通过乐观锁判定（read-only）并 mark_applying。
        """
        envelope, err = self.load_payload(op)
        if err:
            raise CluedError("CLD-PEND-001", "replay 前 payload 校验失败: %s"
                             % err)
        session_id = envelope.get("session_id")
        engine_op = envelope.get("engine_op")
        if engine_op == "CREATE":
            candidate = dict(envelope.get("candidate") or {})
            result = self.adapter.write(
                candidate, session_id=session_id,
                explicit_remember=bool(envelope.get("remember")))
            if result.decision == "NO_CHANGE":
                return "already", []
            return "applied", [result.memory_id or
                               candidate.get("id")]
        if engine_op == "UPDATE":
            target = store.load_object(envelope.get("target_id"))
            if not target:
                raise CluedError("CLD-PEND-002",
                                 "replay UPDATE 目标不存在: %s"
                                 % envelope.get("target_id"))
            if (target.get("content") == envelope.get("content")
                    and target.get("status") != "archived"):
                return "already", []
            result = self.adapter.update(
                envelope.get("target_id"), envelope.get("content"),
                session_id=session_id)
            if result.decision == "NO_CHANGE":
                return "already", []
            touched = [result.target_id] if result.target_id else []
            if result.memory_id:
                touched.append(result.memory_id)
            return "applied", touched
        if engine_op == "SUPERSEDE":
            target = store.load_object(envelope.get("target_id"))
            if not target:
                raise CluedError("CLD-PEND-002",
                                 "replay SUPERSEDE 目标不存在: %s"
                                 % envelope.get("target_id"))
            successor = store.load_object(envelope.get("successor_oid"))
            if (successor and successor.get("content") ==
                    envelope.get("content")
                    and target.get("status") == "superseded"):
                return "already", []
            candidate = dict(envelope.get("successor_candidate") or {})
            result = write_engine.perform_write(
                candidate, adapter="clued", session_id=session_id,
                supersede_target=envelope.get("target_id"))
            if result.decision == "NO_CHANGE":
                return "already", []
            touched = [envelope.get("target_id"),
                       envelope.get("successor_oid")]
            return "applied", touched
        if engine_op == "DELETE":
            target = store.load_object(envelope.get("target_id"))
            if not target:
                raise CluedError("CLD-PEND-002",
                                 "replay DELETE 目标不存在: %s"
                                 % envelope.get("target_id"))
            if target.get("status") == "archived":
                return "already", []
            write_engine.archive_object(
                envelope.get("target_id"), adapter="clued",
                session_id=session_id, reason="clued delete")
            return "applied", [envelope.get("target_id")]
        raise CluedError("CLD-PEND-002", "未知 engine_op: %s" % engine_op)

    # ---- 兼容入口（recovery 冲突快照 / 测试）----
    def payload_files_of(self, op):
        """兼容旧接口：返回 {primary relpath: 当前工作树 sha|None}。"""
        rel = self.op_primary_relpath(op)
        if not rel:
            return None
        p = os.path.join(self.repo, rel.replace("/", os.sep))
        if os.path.isfile(p):
            return {rel: manifests.sha256_file(p)}
        return {rel: None}

    # ---- 乐观锁/语义判定辅助（recovery 用）----
    def object_state(self, oid):
        """返回 (content_sha256|None, obj_dict|None)。"""
        if not oid:
            return None, None
        p = store.object_path(oid)
        if not os.path.isfile(p):
            return None, None
        return manifests.sha256_file(p), store.load_object(oid)

    def op_effect_already(self, op):
        """语义幂等判定：payload 的效果是否已存在于当前工作树。"""
        envelope, err = self.load_payload(op)
        if err:
            return False
        engine_op = envelope.get("engine_op")
        if engine_op == "CREATE":
            obj = store.load_object(envelope.get("memory_id"))
            return obj is not None and obj == envelope.get("candidate")
        if engine_op == "UPDATE":
            obj = store.load_object(envelope.get("target_id"))
            return (obj is not None
                    and obj.get("content") == envelope.get("content")
                    and obj.get("status") != "archived")
        if engine_op == "SUPERSEDE":
            old = store.load_object(envelope.get("target_id"))
            succ = store.load_object(envelope.get("successor_oid"))
            return (old is not None and old.get("status") == "superseded"
                    and succ is not None
                    and succ.get("content") == envelope.get("content"))
        if engine_op == "DELETE":
            obj = store.load_object(envelope.get("target_id"))
            return obj is not None and obj.get("status") == "archived"
        return False
