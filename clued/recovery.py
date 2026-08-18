# -*- coding: utf-8 -*-
"""网络恢复与同步协议（协议 §10，CLD-004）。

固定恢复顺序（§10.2）：
    AUTHENTICATE → DOCTOR → PULL_REMOTE → VALIDATE_REMOTE_HEAD →
    LOAD_PENDING_IN_ORDER → REPLAY_WITH_OPERATION_ID → CHECK_OPTIMISTIC_LOCKS
    → RUN_EXISTING_MEMORY_VALIDATION → PUSH_VIA_EXISTING_SYNC_LAYER →
    VERIFY_REMOTE_RESULT → MARK_PENDING_SYNCED → INVALIDATE_ONLY_IF_CHANGED
    → CLOSE_BREAKER_AND_RETURN_ONLINE

- 恢复前必须：全局锁、重新在线认证（AUTHORIZED）、doctor PASS、
  Journal 完整性（§10.1）；
- 认证 DENIED → 立即 LOCKED；UNAVAILABLE → 保持降级，不增加高频重试；
- 禁止先把本地降级状态直接 push 再 pull；禁止绕过同步脚本改写远端（§10.2）；
- 无变化规则：Journal 空且远端无变化 → NO_CHANGE → NO_WRITE → NO_SYNC
  → NO_INVALIDATION（§10.3）；
- 冲突：停止批次、不推送含冲突批次、生成 snapshot、标记 CONFLICTED、
  进入 CONFLICT_REVIEW、绝不自动本地覆盖远端（§10.4）；
- 完成条件全满足才 ONLINE_SYNCED（§10.5）。
"""

import hashlib
import json
import os

from . import manifests
from . import state_machine as SM
from .errors import CluedError
from .identifiers import new_uuid, now_rfc3339


class ConflictSnapshot(object):
    """§10.4.3：现有格式兼容的 conflict snapshot（base/ours/theirs + 摘要）。"""

    def __init__(self, paths, git, repo_root):
        self.paths = paths
        self.git = git
        self.repo = repo_root

    def write(self, op, ours_path, theirs_content, base_sha, relpath=None,
              request_id=None):
        conflict_id = new_uuid()
        d = self.paths.conflict_dir(conflict_id)
        os.makedirs(d, exist_ok=True)
        files = {}
        rel = relpath or op.get("payload_ref")
        # base：远端（HEAD）旧版本内容
        try:
            base_blob = self.git.blob_at_head(rel)
            if base_blob is not None:
                base_path = os.path.join(d, "base")
                with open(base_path, "w", encoding="utf-8") as fh:
                    fh.write(base_blob)
                files["base"] = {"ref": "HEAD:%s" % rel,
                                 "sha256": hashlib.sha256(
                                     base_blob.encode("utf-8")).hexdigest()}
        except CluedError:
            pass
        # ours：本地（工作树）版本
        ours_out = os.path.join(d, "ours")
        with open(ours_out, "w", encoding="utf-8") as fh:
            with open(ours_path, "r", encoding="utf-8") as src:
                fh.write(src.read())
        files["ours"] = {"ref": ours_path,
                         "sha256": manifests.sha256_file(ours_path)}
        # theirs：远端（pull 后 HEAD）版本
        theirs_out = os.path.join(d, "theirs")
        with open(theirs_out, "w", encoding="utf-8") as fh:
            fh.write(theirs_content or "")
        files["theirs"] = {"ref": "remote main",
                           "sha256": hashlib.sha256(
                               (theirs_content or "").encode("utf-8")
                           ).hexdigest()}
        meta = {
            "schema_version": "clued.conflict.v0.1",
            "conflict_id": conflict_id,
            "operation_id": op.get("operation_id"),
            "memory_id": op.get("memory_id"),
            "base_revision": base_sha,
            "created_at": now_rfc3339(),
            "request_id": request_id or "",
            "files": files,
        }
        manifests.atomic_write_json(os.path.join(d, "conflict.json"), meta)
        return conflict_id, meta


class Recovery(object):
    def __init__(self, registry, provider, auth_engine, sync, git, journal,
                 gate, breaker_sync, paths, audit=None, memory_doctor=None):
        self.registry = registry
        self.provider = provider
        self.auth = auth_engine
        self.sync = sync
        self.git = git
        self.journal = journal
        self.gate = gate
        self.breaker_sync = breaker_sync
        self.paths = paths
        self.audit = audit
        self.memory_doctor = memory_doctor  # 引擎 doctor（可注入/子进程）

    def recover(self, binding, session_id, request_id=None,
                committer_name=None, committer_email=None, manual=False,
                auth_granted=None):
        """auth_granted：本会话已在线授权（§7.1 会话内复用）时传入 scopes，
        跳过恢复前的强制重新认证；手动恢复触发器必须传 None（强制在线
        认证，§10.1.2）。"""
        binding_id = binding.get("binding_id")
        if self.audit is not None:
            self.audit.append("recovery_begin", binding_id=binding_id,
                              request_id=request_id,
                              result_code=SM.RECOVERING,
                              metadata={"manual": manual,
                                        "session_authorized":
                                            auth_granted is not None})

        # 0) 单飞锁（§10.1.1）
        from .locking import CrossProcessLock
        lock = CrossProcessLock(
            os.path.join(self.paths.locks_dir(),
                         "recover-%s.lock" % binding_id),
            audit=self.audit, purpose="recovery")
        if not lock.acquire():
            raise CluedError("CLD-SYNC-002", "恢复单飞锁被占用",
                             state=SM.RECOVERING)
        try:
            return self._recover_locked(
                binding, session_id, request_id, committer_name,
                committer_email, manual, auth_granted)
        finally:
            lock.release()

    def _recover_locked(self, binding, session_id, request_id, committer_name,
                        committer_email, manual, auth_granted):
        binding_id = binding.get("binding_id")

        # 1) AUTHENTICATE（§10.2.1；§10.1.2-3：认证结果必须为 AUTHORIZED）
        if auth_granted is None:
            auth = self.auth.ensure_authorized(
                binding, session_id, request_id=request_id, force_online=True)
            if auth.is_denial:
                raise CluedError("CLD-AUTH-001",
                                 "恢复前重新认证被明确拒绝 → LOCKED",
                                 state=SM.LOCKED, exit_code=30)
            if not auth.is_authorized:
                # 含 DEGRADED：降级不是 AUTHORIZED，恢复不得继续（§10.1.3）
                raise CluedError(
                    "CLD-AUTH-002", "恢复前重新认证未获 AUTHORIZED，保持降级",
                    state=SM.DEGRADED_LOCAL, exit_code=31,
                    data={"pending":
                          self.journal.pending_count(binding_id)})

        # 5 前置) Journal 完整性（§10.1.5）+ 崩溃恢复 APPLYING → PENDING
        #（只读加载先于 pull，供 doctor 脏树特例与 pull 失败取证；
        #   重放仍在 pull 之后，不影响 §10.2 的效果顺序）
        ok_int, errors = self.journal.integrity_check(self.sync.repo,
                                                      binding_id)
        if not ok_int:
            raise CluedError(
                "CLD-PEND-001", "Journal 完整性失败: %s" % "; ".join(errors[:5]),
                state=SM.RECOVERING)
        self.journal.recover_applying(binding_id)
        ops = self.journal.pending(binding_id)

        # 2) DOCTOR（§10.2.2；§10.1.4）
        doc = self.sync.doctor()
        if not doc.ok:
            # 恢复前的两种预期 FAIL（均有独立硬校验兜底，不放松 §3.8）：
            # - 「工作树干净」：本批 Journal payload 是合法未提交变更；
            # - 「local == remote」：本地落后远端（即将 pull）；真分叉仍由
            #   随后的 FETCH+VALIDATE_REMOTE_HEAD 祖先判定阻断。
            # 其余任何失败 → 阻断（doctor FAIL 禁止 canonical read 和 push）。
            if not self._doctor_failures_tolerable(doc, ops):
                raise CluedError("CLD-SYNC-001",
                                 "恢复前 sync doctor FAIL: %s"
                                 % doc.combined()[:400], state=SM.RECOVERING)
            if self.audit is not None:
                self.audit.append(
                    "recovery_begin", binding_id=binding_id,
                    request_id=request_id, result_code="DOCTOR_RECOVERY_OK",
                    metadata={"detail": "doctor 失败项均为恢复前预期状态"
                                        "（工作树脏=本批 payload /"
                                        " 本地落后远端=即将 pull）"})

        # 3) FETCH + VALIDATE_REMOTE_HEAD（§10.2.3-4；只读 fetch，不改工作树）。
        # 说明（文档化偏差）：既有同步层 pull 硬性拒绝脏工作树（防覆盖），而
        # 本批 payload 正是合法未提交变更；因此先只读 fetch 校验远端，冲突排除
        # 后再提交 payload → 经同步层 pull → push。不推送含冲突批次、先 pull 后
        # push、远端确认后才 SYNCED 等安全不变量全部保留（§10.2/§10.4/§22 保守）。
        try:
            remote_sha = self.git.fetch_head()
        except CluedError:
            raise CluedError("CLD-SYNC-002", "远端不可达，保持降级",
                             state=SM.DEGRADED_LOCAL, exit_code=31)
        local = self.git.head_sha()
        if not remote_sha or not local or \
                not self.git.is_ancestor(local, remote_sha):
            raise CluedError("CLD-SYNC-004",
                             "远端 HEAD 校验失败（分叉或不可达）",
                             state=SM.RECOVERING)

        # 10.3 无变化规则：Journal 空 → 不写不推不失效（pull 对齐后返回）
        if not ops:
            pull0 = self.sync.pull()
            if not pull0.ok:
                raise CluedError("CLD-SYNC-002",
                                 "对齐 pull 失败: %s" % pull0.combined()[:400],
                                 state=SM.DEGRADED_LOCAL)
            if self.breaker_sync is not None:
                self.breaker_sync.record_success()
            if self.audit is not None:
                self.audit.append("recovery_success", binding_id=binding_id,
                                  request_id=request_id,
                                  result_code=SM.ONLINE_SYNCED,
                                  metadata={"replayed": 0, "no_change": True})
            return {"state": SM.ONLINE_SYNCED, "replayed": 0,
                    "no_change": True,
                    "summary": "无待同步操作且远端无变化"
                               "（NO_CHANGE → NO_WRITE → NO_SYNC）"}

        # 6-7) REPLAY + OPTIMISTIC LOCKS（§10.2.6-7；§9.4 幂等效果；
        # 以 FETCH_HEAD（远端真值）为准，工作树尚未提交）
        staged, conflicted = [], []
        for op in ops:
            verdict = self._check_optimistic_lock(op, ref="FETCH_HEAD")
            if verdict in ("apply", "already"):
                staged.append(op)
            else:
                conflicted.append(op)

        # 10.4.1-2：任何冲突 → 停止批次，不推送包含未解决冲突的批次
        if conflicted:
            self._enter_conflict_review(conflicted, request_id)

        # 本地完整性（payload 与工作树不符）也按冲突暴露，不丢数据
        # 8) RUN_EXISTING_MEMORY_VALIDATION（§10.2.8）
        if self.memory_doctor is not None:
            try:
                ok_m, out_m = self.memory_doctor()
                if not ok_m:
                    raise CluedError(
                        "CLD-SYNC-001", "Memory Engine doctor FAIL: %s"
                        % (out_m or "")[:400], state=SM.RECOVERING)
            except CluedError:
                raise

        # 标记 APPLYING（§9.3.3；推送前）
        for op in staged:
            self.journal.mark_applying(op, request_id=request_id)

        # 提交本批 payload（本地 commit，不 push；随后经同步层 pull 对齐）
        relpaths = []
        for op in staged:
            files = self.gate.payload_files_of(op) or {}
            for rel, expect_sha in files.items():
                p = os.path.join(self.sync.repo, rel.replace("/", os.sep))
                if not os.path.isfile(p):
                    raise CluedError(
                        "CLD-PEND-001", "payload 文件缺失: %s" % rel,
                        state=SM.RECOVERING)
                if manifests.sha256_file(p) != expect_sha:
                    raise CluedError(
                        "CLD-PEND-001", "payload 完整性失败: %s" % rel,
                        state=SM.RECOVERING)
                relpaths.append(rel.replace("\\", "/"))
        relpaths = sorted(set(relpaths))
        committer = committer_name or "Clued@%s" % _hostname()
        email = committer_email or "clued@localhost"
        self.git.commit_paths(
            relpaths, "[Clued] replay %d pending ops (%s)"
            % (len(staged), binding_id), committer, email)

        # 7') PULL_VIA_SYNC_LAYER（树已提交干净，合并远端）
        pull = self.sync.pull()
        if not pull.ok:
            for op in staged:
                self.journal.transition(op, "PENDING")  # APPLYING → PENDING
            raise CluedError("CLD-SYNC-002",
                             "恢复 pull 失败: %s" % pull.combined()[:400],
                             state=SM.DEGRADED_LOCAL)

        # 9) PUSH_VIA_EXISTING_SYNC_LAYER（§10.2.9）
        push = self.sync.push()
        if not push.ok:
            for op in staged:
                self.journal.transition(op, "PENDING")  # APPLYING → PENDING
            self.breaker_sync.record_failure(temporary=True)
            raise CluedError("CLD-SYNC-003",
                             "恢复 push 失败: %s" % push.combined()[:400],
                             state=SM.ONLINE_DIRTY)

        # 10) VERIFY_REMOTE_RESULT（§10.2.10）
        remote2 = self.git.remote_head()
        local2 = self.git.head_sha()
        if not remote2 or not local2 or not self.git.is_ancestor(local2, remote2):
            for op in staged:
                self.journal.transition(op, "PENDING")
            raise CluedError("CLD-SYNC-004",
                             "推送后远端确认失败（本地未成为远端祖先）",
                             state=SM.ONLINE_DIRTY)

        # 11) MARK_PENDING_SYNCED（§10.2.11：远端确认后）
        for op in staged:
            self.journal.mark_synced(op, request_id=request_id)

        # 12) INVALIDATE_ONLY_IF_CHANGED（§10.2.12：无读缓存；会话记录由
        #     AuthEngine 管理——本次重新认证已刷新会话授权结果）

        # 13) CLOSE_BREAKER_AND_RETURN_ONLINE（§10.2.13）
        if self.breaker_sync is not None:
            self.breaker_sync.record_success()
        self.auth.breaker.record_success()
        if self.audit is not None:
            self.audit.append("recovery_success", binding_id=binding_id,
                              request_id=request_id,
                              result_code=SM.ONLINE_SYNCED,
                              metadata={"replayed": len(staged)})
        return {
            "state": SM.ONLINE_SYNCED, "replayed": len(staged),
            "conflicted": 0,
            "summary": "恢复完成：%d 个操作已重放并获远端确认"
                       "（ONLINE_SYNCED）" % len(staged),
        }

    # ---- 乐观锁（§3.3 / §10.2.7 / §9.4）----
    def _check_optimistic_lock(self, op, ref="HEAD"):
        """返回 apply / already / conflict。

        - CREATE(base=None)：远端无 → apply；远端与 payload 一致 → already；
          远端存在且不同 → conflict；
        - UPDATE/DELETE(base=sha)：远端 == base → apply；远端 == payload →
          already；否则 conflict。
        """
        base = op.get("base_revision")
        files = self.gate.payload_files_of(op) or {}
        if not files:
            return "conflict"
        primary = next(iter(files), None)
        payload_sha = files[primary]
        remote_sha = _ref_blob_sha(self.git, ref, primary)
        if op.get("operation_type") == "CREATE":
            if remote_sha is None:
                return "apply"
            return "already" if remote_sha == payload_sha else "conflict"
        if base is None:
            return "conflict"
        if remote_sha == base:
            return "apply"
        if remote_sha == payload_sha:
            return "already"  # 幂等：效果已达成（§9.4）
        return "conflict"

    # ---- doctor 恢复前预期失败特例（均有硬校验兜底）----
    def _doctor_failures_tolerable(self, doc, ops):
        combined = doc.combined()
        fail_lines = [ln for ln in combined.splitlines()
                      if "[FAIL]" in ln]
        if not fail_lines:
            return False
        # 恢复前三种预期 FAIL（§10 流程本身即将处理；真分叉由随后的
        # FETCH + VALIDATE_REMOTE_HEAD 祖先判定硬阻断）：
        # - working tree clean：本批 Journal payload 合法未提交变更；
        # - local == remote / tracking ref valid：本地落后远端（即将 pull；
        #   远端对象尚未 fetch 本地，tracking ref 无法自愈属预期）。
        behind_ok = None
        for ln in fail_lines:
            if "working tree clean" in ln:
                if not self._dirty_covered_by_payloads(ops):
                    return False
            elif "local == remote" in ln or "tracking ref valid" in ln:
                if behind_ok is None:
                    try:
                        remote = self.git.remote_head()
                        local = self.git.head_sha()
                        behind_ok = bool(remote and local and
                                         self.git.is_ancestor(local, remote))
                    except CluedError:
                        behind_ok = False
                if not behind_ok:
                    return False
            else:
                return False
        return True

    def _dirty_covered_by_payloads(self, ops):
        payloads = set()
        for op in ops:
            files = self.gate.payload_files_of(op) or {}
            payloads.update(f.replace("\\", "/") for f in files)
        if not payloads:
            return False
        try:
            status = self.git.status_porcelain()
        except CluedError:
            return False
        for line in status.splitlines():
            if len(line) < 3:
                continue
            # porcelain v1：'XY path'（XY 两字符 + 单空格）；
            # 单字符状态压缩时 'X path'（兼容解析）
            path = line[3:] if line[2] == " " else line[2:]
            path = path.strip().strip('"')
            if path.endswith("/"):
                path = path[:-1]
            if not any(p == path or p.startswith(path + "/")
                       for p in payloads):
                return False
        return True

    def _enter_conflict_review(self, conflicted, request_id=None):
        """停止批次、不推送、生成 snapshot、标记 CONFLICTED、进入
        CONFLICT_REVIEW（§10.4.1-7）。"""
        binding_id = (conflicted[0].get("binding_id")
                      if conflicted else "")
        snapshots = []
        for op in conflicted:
            files = self.gate.payload_files_of(op) or {}
            primary = next(iter(files), None)
            ours_path = (os.path.join(self.sync.repo, primary)
                         if primary else None)
            try:
                # theirs = 远端（FETCH_HEAD）版本
                theirs = self.git.blob_at_ref("FETCH_HEAD", primary) or ""
            except CluedError:
                theirs = ""
            if ours_path and os.path.isfile(ours_path):
                cid, meta = ConflictSnapshot(
                    self.paths, self.git, self.sync.repo).write(
                        op, ours_path, theirs, op.get("base_revision"),
                        relpath=primary, request_id=request_id)
                snapshots.append(cid)
                if self.audit is not None:
                    self.audit.append(
                        "conflict_snapshot", binding_id=binding_id,
                        request_id=request_id, result_code="CLD-CONFLICT-001",
                        metadata={"conflict_id": cid,
                                  "operation_id": op.get("operation_id")})
            self.journal.mark_conflicted(op, request_id=request_id)
        self.breaker_sync.record_failure(temporary=False)
        raise CluedError(
            "CLD-CONFLICT-001",
            "%d 个操作存在乐观锁或内容冲突；批次未推送，进入"
            "CONFLICT_REVIEW（冲突快照已生成）" % len(conflicted),
            state=SM.CONFLICT_REVIEW, exit_code=41,
            data={"conflicted": len(conflicted),
                  "conflict_ids": snapshots})


def _ref_blob_sha(git, ref, relpath):
    import hashlib
    blob = git.blob_at_ref(ref, relpath)
    if blob is None:
        return None
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _head_blob_sha(git, relpath):
    return _ref_blob_sha(git, "HEAD", relpath)


def _hostname():
    import socket
    try:
        return socket.gethostname()
    except Exception:
        return "node"
