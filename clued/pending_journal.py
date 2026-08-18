# -*- coding: utf-8 -*-
"""Pending Operation Journal（协议 §9，v0.3.0 / CLD-FIX-003）。

- 每次逻辑写入生成稳定 operation_id；重试不得生成新 ID（§9.3.1）；
- 先原子持久化 payload（受保护 staging）→ 原子持久化 journal → 再向用户
  确认「已保存在本地」（§9.3.2；执行计划 §5.2 统一顺序）；
- 状态转移只允许 PENDING → APPLYING → SYNCED 或
  PENDING/APPLYING → CONFLICTED/REJECTED；损坏 → PENDING_CORRUPT（§9.3.3/8）；
- SYNCED 记录在确认远端结果后才可归档（§9.3.4）；
- 进程崩溃后 APPLYING 必须可恢复为幂等重试状态（§9.3.5）；
- Journal 与 payload 均不得进入 Git 同步范围（位于 .clued/ 或等价运行时
  位置，gitignored，不入 Canonical Store）；
- payload = 语义包络（重放所需全部参数 + 用户内容），sha256 校验；
- orphan payload 可以检测、隔离并生成审计事件（CLD-FIX-003 §5.2）；
- 同一 Binding 按创建顺序处理；同一 memory_id 严格保序（§9.4）。
"""

import glob
import json
import os

from . import manifests
from .errors import CluedError
from .identifiers import new_uuid, now_rfc3339, parse_rfc3339

TERMINAL_STATES = ("SYNCED", "CONFLICTED", "REJECTED", "PENDING_CORRUPT")

PAYLOAD_SCHEMA = "clued.pending-payload.v0.1"


def validate_payload_envelope(env, op=None):
    """payload 包络结构校验（CLD-FIX-003：payload 与 journal 必须可关联）。"""
    if not isinstance(env, dict):
        return False, "payload 不是对象"
    if env.get("schema_version") != PAYLOAD_SCHEMA:
        return False, "payload schema_version 不兼容: %r" % env.get(
            "schema_version")
    engine_op = env.get("engine_op")
    if engine_op not in ("CREATE", "UPDATE", "SUPERSEDE", "DELETE"):
        return False, "非法 engine_op: %r" % engine_op
    for field in ("operation_id", "session_id"):
        if not env.get(field):
            return False, "payload 缺少字段 %s" % field
    if op is not None and env.get("operation_id") != op.get("operation_id"):
        return False, "payload operation_id 与 journal 不符"
    if engine_op in ("UPDATE", "SUPERSEDE", "DELETE"):
        if not env.get("target_id"):
            return False, "payload 缺少 target_id"
    if engine_op in ("CREATE", "SUPERSEDE"):
        if not env.get("content"):
            return False, "payload 缺少 content"
    if engine_op == "CREATE" and not isinstance(env.get("candidate"), dict):
        return False, "CREATE payload 缺少 candidate"
    if engine_op == "SUPERSEDE" and not isinstance(
            env.get("successor_candidate"), dict):
        return False, "SUPERSEDE payload 缺少 successor_candidate"
    if manifests.contains_secret(json.dumps(env, ensure_ascii=False)):
        return False, "payload 含凭据样值（违规）"
    return True, ""


class PendingJournal(object):
    def __init__(self, paths, audit=None):
        self.paths = paths
        self.audit = audit

    # ---- 创建（payload 已先落盘 → 原子 journal → 确认）----
    def create(self, binding_id, agent_id, node_id, session_id, operation_type,
               memory_id, base_revision, payload_ref, payload_sha256,
               operation_id=None, request_id=None):
        op_id = operation_id or new_uuid()
        op = manifests.build_pending_op(
            op_id, binding_id, agent_id, node_id, session_id, operation_type,
            memory_id, base_revision, payload_ref, payload_sha256,
            created_at=self._next_created_at(binding_id))
        manifests.atomic_write_json(self.paths.pending_file(op_id), op)
        if self.audit is not None:
            self.audit.append(
                "pending_create", binding_id=binding_id, request_id=request_id,
                result_code="PENDING",
                metadata={"operation_id": op_id, "memory_id": memory_id,
                          "operation_type": operation_type})
        return op

    def _next_created_at(self, binding_id):
        """同一 Binding 严格递增 created_at（§9.4 创建顺序）：同微秒竞态时
        取「上一条 + 1μs」，保证按创建顺序处理不依赖文件名。"""
        from datetime import timedelta
        now = now_rfc3339()
        last = None
        d = self.paths.pending_dir()
        if os.path.isdir(d):
            for p in glob.glob(os.path.join(d, "*.json")):
                try:
                    raw = manifests.read_json(p)
                except Exception:
                    continue
                if binding_id and raw.get("binding_id") != binding_id:
                    continue
                created = raw.get("created_at") or ""
                if created and (last is None or created > last):
                    last = created
        if not last or last < now:
            return now
        dt = parse_rfc3339(last)
        if dt is None:
            return now
        return (dt + timedelta(microseconds=1)).isoformat(
            timespec="microseconds")

    # ---- 读取 ----
    def load(self, operation_id):
        p = self.paths.pending_file(operation_id)
        if not os.path.isfile(p):
            return None
        try:
            op = manifests.read_json(p)
        except Exception:
            return None
        ok, err = manifests.validate_pending_op(op)
        if not ok:
            raise CluedError("CLD-PEND-001",
                             "journal 条目 %s 损坏: %s" % (operation_id, err))
        if op.get("operation_id") != operation_id:
            raise CluedError("CLD-PEND-001",
                             "journal 条目 id 与文件名不符: %s" % operation_id)
        return op

    def list_all(self, binding_id=None, statuses=None):
        out = []
        statuses = statuses or []
        d = self.paths.pending_dir()
        if not os.path.isdir(d):
            return out
        for p in glob.glob(os.path.join(d, "*.json")):
            try:
                op = manifests.read_json(p)
            except Exception:
                continue
            if binding_id and op.get("binding_id") != binding_id:
                continue
            if statuses and op.get("status") not in statuses:
                continue
            out.append(op)
        # 同一 Binding 按创建顺序处理（§9.4）；时间戳相同回退文件名序（稳定）
        out.sort(key=lambda o: (o.get("created_at") or "",
                                os.path.basename(
                                    self.paths.pending_file(
                                        o.get("operation_id") or ""))))
        return out

    def pending(self, binding_id=None):
        return self.list_all(binding_id, statuses=("PENDING",))

    def applying(self, binding_id=None):
        return self.list_all(binding_id, statuses=("APPLYING",))

    def pending_count(self, binding_id=None):
        return len(self.pending(binding_id))

    # ---- 状态转移（§9.3.3 只允许规定转移）----
    _TRANSITIONS = {
        "PENDING": ("APPLYING", "CONFLICTED", "REJECTED", "PENDING_CORRUPT"),
        "APPLYING": ("SYNCED", "CONFLICTED", "REJECTED", "PENDING_CORRUPT",
                     "PENDING"),
    }

    def transition(self, op, new_status, error_code=None, request_id=None):
        old = op.get("status")
        allowed = self._TRANSITIONS.get(old, ())
        if new_status not in allowed:
            raise CluedError(
                "CLD-PEND-002",
                "journal 非法状态转移 %s → %s" % (old, new_status))
        op["status"] = new_status
        op["last_attempt_at"] = now_rfc3339()
        op["attempt_count"] = int(op.get("attempt_count") or 0) + \
            (1 if new_status in ("APPLYING",) else 0)
        if error_code:
            op["last_error_code"] = error_code
        manifests.atomic_write_json(
            self.paths.pending_file(op["operation_id"]), op)
        event = {
            "SYNCED": "pending_synced",
            "CONFLICTED": "pending_conflict",
            "APPLYING": "pending_replay",
            "PENDING_CORRUPT": "pending_conflict",
        }.get(new_status, "pending_replay")
        if self.audit is not None:
            self.audit.append(
                event, binding_id=op.get("binding_id"),
                request_id=request_id, result_code=new_status,
                metadata={"operation_id": op.get("operation_id"),
                          "memory_id": op.get("memory_id"),
                          "attempt_count": op.get("attempt_count")})
        return op

    def mark_applying(self, op, request_id=None):
        return self.transition(op, "APPLYING", request_id=request_id)

    def mark_synced(self, op, request_id=None):
        return self.transition(op, "SYNCED", request_id=request_id)

    def mark_conflicted(self, op, error_code="CLD-CONFLICT-001",
                        request_id=None):
        return self.transition(op, "CONFLICTED", error_code=error_code,
                               request_id=request_id)

    def mark_rejected(self, op, error_code="CLD-PEND-002", request_id=None):
        return self.transition(op, "REJECTED", error_code=error_code,
                               request_id=request_id)

    def mark_corrupt(self, op, error_code="CLD-PEND-001", request_id=None):
        try:
            return self.transition(op, "PENDING_CORRUPT",
                                   error_code=error_code, request_id=request_id)
        except CluedError:
            # 已是 PENDING_CORRUPT 或不可转移 → 保留原始证据，不静默丢弃
            return op

    # ---- 崩溃恢复（§9.3.5）----
    def recover_applying(self, binding_id=None):
        """APPLYING → PENDING（幂等重试）；同一 Binding 按创建顺序。"""
        out = []
        for op in self.applying(binding_id):
            op["status"] = "PENDING"
            manifests.atomic_write_json(
                self.paths.pending_file(op["operation_id"]), op)
            out.append(op)
        return out

    # ---- 完整性检查（§7.5 条件 6 / §10.1.5）----
    def integrity_check(self, repo_root, binding_id=None):
        """校验条目结构、payload 包络完整性（sha256 + 结构）、重放目标
        路径位于仓库内。无法解析的 journal 文件同样计入错误（§9.3.8
        不静默丢弃）。payload 包络位于 .clued/ 或等价运行时位置（可在
        仓库外），只有重放目标（memory/objects/** 等）必须在仓库内。
        """
        errors = []
        repo_real = os.path.realpath(repo_root)
        d = self.paths.pending_dir()
        files = sorted(glob.glob(os.path.join(d, "*.json"))) \
            if os.path.isdir(d) else []
        for p in files:
            try:
                raw = manifests.read_json(p)
            except Exception:
                errors.append("%s: journal 文件不可解析（保留证据）"
                              % os.path.basename(p))
                continue
            if binding_id and raw.get("binding_id") != binding_id:
                continue
            op_id = raw.get("operation_id") if isinstance(raw, dict) else None
            if not op_id:
                errors.append("%s: 缺少 operation_id" % os.path.basename(p))
                continue
            ok_op, err_op = manifests.validate_pending_op(raw)
            if not ok_op:
                errors.append("%s: %s" % (op_id, err_op))
                continue
            # 载荷完整性只对活跃批次（PENDING/APPLYING）校验：SYNCED/
            # CONFLICTED 等终态条目是历史记录（§9.3.4）
            if raw.get("status") not in ("PENDING", "APPLYING"):
                continue
            ref = raw.get("payload_ref") or ""
            bundle = os.path.join(repo_root, ref.replace("/", os.sep))
            if not os.path.isfile(bundle):
                errors.append("%s: payload 包络缺失 %s" % (op_id, ref))
                continue
            if manifests.sha256_file(bundle) != raw.get("payload_sha256"):
                errors.append("%s: payload 包络 sha256 不符 %s" % (op_id, ref))
                continue
            try:
                env = manifests.read_json(bundle)
            except Exception:
                errors.append("%s: payload 包络不可解析 %s" % (op_id, ref))
                continue
            ok_env, err_env = validate_payload_envelope(env, raw)
            if not ok_env:
                errors.append("%s: %s" % (op_id, err_env))
                continue
            # 重放目标路径必须位于仓库内（防 payload 越界写入）
            for oid in (env.get("memory_id"), env.get("target_id"),
                        env.get("successor_oid")):
                if not oid:
                    continue
                rel = os.path.join("memory", "objects",
                                   "%s.json" % oid).replace("\\", "/")
                full = os.path.join(repo_root, *rel.split("/"))
                real = os.path.realpath(full)
                if not (real == repo_real or
                        real.startswith(repo_real + os.sep)):
                    errors.append("%s: 重放目标越界 %s" % (op_id, rel))
        return (len(errors) == 0), errors

    # ---- orphan payload（CLD-FIX-003 §5.2：检测、隔离、审计）----
    def orphan_payloads(self):
        """payload 包络与 journal 无法关联的孤儿：检测并返回清单。"""
        out = []
        d = self.paths.payload_refs_dir()
        if not os.path.isdir(d):
            return out
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json"):
                continue
            op_id = name[:-5]
            p = self.paths.payload_ref_file(op_id)
            try:
                env = manifests.read_json(p)
            except Exception:
                out.append({"operation_id": op_id, "reason":
                            "payload 不可解析"})
                continue
            if env.get("operation_id") != op_id:
                out.append({"operation_id": op_id, "reason":
                            "payload operation_id 与文件名不符"})
                continue
            journal_p = self.paths.pending_file(op_id)
            if not os.path.isfile(journal_p):
                out.append({"operation_id": op_id, "reason":
                            "无对应 journal 条目"})
        return out

    def isolate_orphan(self, operation_id):
        """隔离孤儿 payload：移动到 orphans/ 目录，保留证据并审计。"""
        src = self.paths.payload_ref_file(operation_id)
        if not os.path.isfile(src):
            return None
        d = self.paths.orphan_payload_dir()
        if not os.path.isdir(d):
            os.makedirs(d)
        dst = os.path.join(d, "%s.json" % operation_id)
        if os.path.isfile(dst):
            os.remove(dst)
        os.rename(src, dst)
        if self.audit is not None:
            self.audit.append(
                "pending_conflict", result_code="PENDING_ORPHAN",
                metadata={"operation_id": operation_id,
                          "isolated_to": dst, "event": "orphan_payload"})
        return dst
