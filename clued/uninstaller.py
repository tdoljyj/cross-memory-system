# -*- coding: utf-8 -*-
"""Agent Uninstall Contract（协议 §12，CLD-005）。

- 默认卸载行为 = detach-current-agent：只移除当前 Agent Binding 和适配器；
- remove-node：二次确认后移除本节点所有 Binding 与共享运行时（可选本地缓存）；
- delete-cloud-account：独立高风险操作，v0.1 只定义接口，不自动实现；
- 卸载流程 12 步（§12.2）；离线撤销 → REMOTE_REVOCATION_PENDING + 撤销队列
  （§12.3/§12.4）；删除基于 manifest 与解析后精确路径，禁止宽泛删除（§12.5）；
- 幂等：已卸载 Agent 再次卸载 → ALREADY_UNINSTALLED（§12.6）。
"""

import json
import os
import shutil

from . import manifests
from . import state_machine as SM
from .errors import CluedError
from .identifiers import new_uuid, now_rfc3339
from .locking import CrossProcessLock


class Uninstaller(object):
    def __init__(self, registry, provider, sync, git, journal, auth_cache,
                 paths, audit=None):
        self.registry = registry
        self.provider = provider
        self.sync = sync
        self.git = git
        self.journal = journal
        self.auth_cache = auth_cache
        self.paths = paths
        self.audit = audit

    # ---- 主入口 ----
    def uninstall(self, binding_id, mode="detach-current-agent",
                  session_id=None, request_id=None,
                  discard_pending=False, confirm_shared_cleanup=False,
                  online_auth=None):
        """online_auth：Controller 已完成的会话授权结果
        （AUTHORIZED / DEGRADED / DENIED 语义）。"""
        if mode == "remove-node":
            return self.remove_node(
                request_id=request_id, discard_pending=discard_pending,
                confirm_shared_cleanup=confirm_shared_cleanup)
        if mode == "delete-cloud-account":
            raise CluedError(
                "CLD-UNINSTALL-001",
                "delete-cloud-account 为独立高风险操作：v0.1 只定义接口，"
                "不自动实现；云端数据不会被默认删除（§12.1/§12.5）")
        if mode != "detach-current-agent":
            raise CluedError("CLD-UNINSTALL-001", "未知卸载模式: %s" % mode)

        binding = self.registry.load_binding_loose(binding_id)
        if binding is None:
            return {"code": "ALREADY_UNINSTALLED", "state": SM.UNINSTALLED,
                    "summary": "当前 Agent 已卸载（ALREADY_UNINSTALLED）"}
        if binding.get("status") == "REVOKED":
            return {"code": "ALREADY_UNINSTALLED", "state": SM.UNINSTALLED,
                    "summary": "Binding 已撤销（ALREADY_UNINSTALLED）"}

        lock = CrossProcessLock(
            os.path.join(self.paths.locks_dir(), "lifecycle.lock"),
            audit=self.audit, purpose="uninstall")
        if not lock.acquire():
            raise CluedError("CLD-UNINSTALL-001", "节点生命周期锁被占用")
        self.audit.append("uninstall_begin", binding_id=binding_id,
                          request_id=request_id, result_code="UNINSTALLING",
                          metadata={"mode": mode})
        try:
            return self._detach_locked(
                binding, session_id, request_id, discard_pending, online_auth)
        finally:
            lock.release()

    def _detach_locked(self, binding, session_id, request_id,
                       discard_pending, online_auth):
        binding_id = binding.get("binding_id")

        # 1) 确认目标 binding_id 是当前智能体（调用方传入，已解析）
        # 2) 锁已取得
        # 3) 检查 Pending Journal 与冲突
        pending = self.journal.pending(binding_id)
        conflicts = self.journal.list_all(binding_id, statuses=("CONFLICTED",))
        pending_count = len(pending)
        revoke_needed = False
        remote_revocation_pending = False

        auth_kind = (online_auth or {}).get("kind")

        # 4) 若在线且 AUTHORIZED：执行最后一次受控恢复/同步
        if auth_kind == "AUTHORIZED" and (pending or conflicts):
            if conflicts:
                raise CluedError(
                    "CLD-UNINSTALL-001",
                    "存在未解决冲突，卸载前需人工处理（CONFLICT_REVIEW）",
                    state=SM.CONFLICT_REVIEW,
                    data={"conflicted": len(conflicts),
                          "pending": pending_count})
            if discard_pending:
                self._export_pending(binding_id, pending, request_id)
                for op in pending:
                    self.journal.mark_rejected(
                        op, error_code="CLD-UNINSTALL-001",
                        request_id=request_id)
                pending_count = 0
            # 有 pending 且不丢弃 → 由 Controller 恢复后重试；这里阻止卸载
            if pending_count:
                raise CluedError(
                    "CLD-UNINSTALL-001",
                    "存在 %d 个未同步操作；请先同步（clued sync）或"
                    "明确要求丢弃（--discard-pending）" % pending_count,
                    state=SM.ONLINE_DIRTY,
                    data={"pending": pending_count})
        elif auth_kind == "DEGRADED" and pending and not discard_pending:
            # 网络不可用：默认保留 Pending Journal 和共享运行时，完成本地解绑
            remote_revocation_pending = True
        elif auth_kind == "DENIED" and pending and not discard_pending:
            # 明确拒绝：不得再读取/同步记忆，但仍必须允许移除本地适配器与凭据
            remote_revocation_pending = True
        elif pending and discard_pending:
            self._export_pending(binding_id, pending, request_id)
            for op in pending:
                self.journal.mark_rejected(
                    op, error_code="CLD-UNINSTALL-001", request_id=request_id)
            pending_count = 0

        # 6) 撤销远端授权（在线）或登记撤销任务（离线）
        revoke_task = None
        if auth_kind == "AUTHORIZED":
            rev = self.provider.revoke(binding)
            if not rev.ok:
                remote_revocation_pending = True
                revoke_task = self._queue_revoke(binding, request_id,
                                                 reason=rev.reason or
                                                 "revoke failed")
            elif not rev.remote_confirmed:
                # GitHub 账户级凭据：远端无可撤销的逐 Binding 令牌
                revoke_task = self._queue_revoke(
                    binding, request_id,
                    reason=rev.reason or "account_level_credential")
        else:
            remote_revocation_pending = True
            revoke_task = self._queue_revoke(
                binding, request_id, reason="offline_uninstall")

        # 7) 立即删除当前 Binding 的本地可用凭据（LKG 缓存）
        self.auth_cache.remove(binding_id)

        # 8) 按 installed_artifacts 清单精确移除当前适配器
        if binding.get("corrupt"):
            # 清单损坏：只允许移除 binding 目录内已知文件类型，且必须精确
            self._remove_binding_dir_safe(binding_id)
        else:
            matched, mismatched = self.registry.artifact_checks(binding)
            if mismatched:
                raise CluedError(
                    "CLD-UNINSTALL-003",
                    "Artifact 校验不符，停止删除: %s"
                    % json.dumps(mismatched, ensure_ascii=False)[:400],
                    data={"mismatched": mismatched})
            for art in matched:
                os.remove(art["path"])
            bdir = self.paths.binding_dir(binding_id)
            manifest_path = self.paths.binding_manifest(binding_id)
            if os.path.isfile(manifest_path):
                os.remove(manifest_path)
            if os.path.isdir(bdir):
                os.rmdir(bdir)

        # 9) Binding 状态写为 REVOKED 后归档
        if not binding.get("corrupt"):
            revoked = dict(binding)
            revoked["status"] = "REVOKED"
            archived = os.path.join(
                self.paths.revoked_dir(),
                "%s-revoked-%s.json" % (binding_id,
                                        now_rfc3339().replace(":", "")))
            os.makedirs(self.paths.revoked_dir(), exist_ok=True)
            manifests.atomic_write_json(archived, revoked)
        self.registry.update_node_binding_count()

        # 10) 验证当前 Agent 已无法访问 Clued
        if os.path.isfile(self.paths.binding_manifest(binding_id)):
            raise CluedError("CLD-UNINSTALL-003", "卸载后 binding 清单仍存在")
        if os.path.isfile(self.paths.auth_cache(binding_id)):
            raise CluedError("CLD-UNINSTALL-003", "卸载后 LKG 缓存仍存在")

        # 11) 验证其他 Agent Binding 仍然有效
        others = [b for b in self.registry.list_bindings()
                  if b.get("binding_id") != binding_id]

        # 12) 释放锁并返回卸载摘要
        self.audit.append(
            "bind_revoke", binding_id=binding_id, request_id=request_id,
            result_code="REVOKED",
            metadata={"remote_revocation_pending": remote_revocation_pending})
        if remote_revocation_pending:
            self.audit.append(
                "uninstall_pending_revoke", binding_id=binding_id,
                request_id=request_id, result_code="REMOTE_REVOCATION_PENDING",
                metadata={"revoke_task_id":
                          (revoke_task or {}).get("task_id")})
            return {
                "binding_id": binding_id, "state": SM.UNINSTALLED,
                "code": "CLD-UNINSTALL-002",
                "remote_revocation_pending": True,
                "other_bindings": len(others),
                "pending_kept": pending_count,
                "revoke_task_id": (revoke_task or {}).get("task_id"),
                "summary": ("Clued 已从当前智能体解绑；远端撤销尚未确认"
                            "（REMOTE_REVOCATION_PENDING，已进入撤销队列）。"
                            "其他智能体的 Binding 和共享记忆没有被删除。"),
            }
        self.audit.append("uninstall_success", binding_id=binding_id,
                          request_id=request_id, result_code="UNINSTALLED",
                          metadata={"other_bindings": len(others)})
        return {
            "binding_id": binding_id, "state": SM.UNINSTALLED,
            "code": "UNINSTALLED",
            "remote_revocation_pending": False,
            "other_bindings": len(others),
            "pending_kept": pending_count,
            "summary": ("Clued 已从当前智能体解绑。"
                        "其他智能体的 Binding 和共享记忆没有被删除。"),
        }

    # ---- 撤销队列（§12.4）----
    def _queue_revoke(self, binding, request_id=None, reason=""):
        task = manifests.build_revoke_task(
            new_uuid(), binding.get("binding_id"), binding.get("agent_id"),
            binding.get("node_id"), last_error=reason)
        d = self.paths.revoke_queue_dir()
        if not os.path.isdir(d):
            os.makedirs(d)
        manifests.atomic_write_json(self.paths.revoke_task(task["task_id"]),
                                    task)
        return task

    def run_revoke_queue(self, provider=None, request_id=None):
        """恢复联网后优先执行撤销（§12.4）。"""
        provider = provider or self.provider
        d = self.paths.revoke_queue_dir()
        if not os.path.isdir(d):
            return []
        results = []
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(d, name)
            try:
                task = manifests.read_json(path)
            except Exception:
                continue
            if task.get("status") == "DONE":
                continue
            probe = {"binding_id": task.get("binding_id"),
                     "agent_id": task.get("agent_id"),
                     "node_id": task.get("node_id"),
                     "account_id": "", "scopes": [], "status": "REVOKING"}
            try:
                rev = provider.revoke(probe)
                if rev.ok:
                    task["status"] = "DONE"
                    results.append((task["task_id"], True))
                else:
                    task["attempts"] = int(task.get("attempts") or 0) + 1
                    task["last_attempt_at"] = now_rfc3339()
                    task["last_error"] = rev.reason
                    results.append((task["task_id"], False))
            except Exception as exc:
                task["attempts"] = int(task.get("attempts") or 0) + 1
                task["last_attempt_at"] = now_rfc3339()
                task["last_error"] = str(exc)
                results.append((task["task_id"], False))
            manifests.atomic_write_json(path, task)
        return results

    # ---- 丢弃未同步数据（§12.3 独立、明确、不可混淆的确认）----
    def _export_pending(self, binding_id, pending_ops, request_id=None):
        ts = now_rfc3339().replace(":", "")
        d = os.path.join(self.paths.exports_dir(), ts)
        os.makedirs(d, exist_ok=True)
        for op in pending_ops:
            src = self.paths.pending_file(op["operation_id"])
            if os.path.isfile(src):
                shutil.copy(src, os.path.join(d, os.path.basename(src)))
            # payload 包络一并导出（否则导出的 journal 只有引用无内容）
            ref = op.get("payload_ref") or ""
            payload = os.path.join(self.sync.repo,
                                   ref.replace("/", os.sep))
            if os.path.isfile(payload):
                shutil.copy(payload, os.path.join(
                    d, "payload-%s.json" % op["operation_id"]))
        with open(os.path.join(d, "README.txt"), "w", encoding="utf-8") as fh:
            fh.write("丢弃未同步操作的可恢复导出（%s 个操作）。\n"
                     "包含原始 Journal 条目与 payload 包络（operation_id "
                     "可关联）；恢复需人工评审后重新 replay。\n"
                     % len(pending_ops))
        return d

    # ---- 节点级清理（§12.5）----
    def remove_node(self, request_id=None, discard_pending=False,
                    confirm_shared_cleanup=False):
        bindings = self.registry.list_bindings(include_revoked=True)
        if not bindings:
            return {"code": "ALREADY_UNINSTALLED", "state": SM.UNINSTALLED,
                    "summary": "节点无 Binding（ALREADY_UNINSTALLED）"}
        if not confirm_shared_cleanup:
            raise CluedError(
                "CLD-UNINSTALL-001",
                "remove-node 会移除本节点全部 %d 个 Binding 与共享运行时；"
                "必须二次确认（--confirm-shared-cleanup）" % len(bindings),
                data={"binding_ids": [b.get("binding_id")
                                      for b in bindings]})
        lock = CrossProcessLock(
            os.path.join(self.paths.locks_dir(), "lifecycle.lock"),
            audit=self.audit, purpose="remove-node")
        if not lock.acquire():
            raise CluedError("CLD-UNINSTALL-001", "节点生命周期锁被占用")
        try:
            for b in list(bindings):
                self._detach_locked(
                    b, None, request_id, discard_pending,
                    {"kind": "DEGRADED"})
            return {
                "state": SM.UNINSTALLED, "code": "UNINSTALLED",
                "removed_bindings": len(bindings),
                "summary": "本节点全部 Binding 已移除；"
                           "共享记忆与云端数据未被删除。",
            }
        finally:
            lock.release()

    # ---- 安全删除辅助 ----
    def _remove_binding_dir_safe(self, binding_id):
        """清单损坏时的保守清理：仅删除 binding 目录内的常规文件，绝不递归宽删。"""
        bdir = os.path.abspath(self.paths.binding_dir(binding_id))
        real = os.path.realpath(bdir)
        if not os.path.isdir(real):
            return
        for name in os.listdir(real):
            p = os.path.join(real, name)
            if os.path.islink(p):
                raise CluedError("CLD-UNINSTALL-003",
                                 "发现符号链接，停止删除: %s" % p)
            if os.path.isfile(p):
                os.remove(p)
            # 目录一律不动（保守：损坏清单下不允许递归删除）
        try:
            os.rmdir(real)
        except OSError:
            pass
