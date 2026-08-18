# -*- coding: utf-8 -*-
"""网络恢复与同步协议（协议 §10，v0.2.0；CLD-FIX-002）。

固定恢复顺序（§10.2 / 执行计划 §4.2）：
    ACQUIRE_SINGLE_FLIGHT_LOCK → AUTHENTICATE → DOCTOR_PASS →
    VALIDATE_PENDING_JOURNAL → PULL_VIA_EXISTING_SYNC_LAYER →
    VALIDATE_REMOTE_HEAD → LOAD_PENDING_IN_ORDER →
    REPLAY_WITH_SAME_OPERATION_ID → CHECK_OPTIMISTIC_LOCKS →
    RUN_EXISTING_MEMORY_VALIDATION → PUSH_VIA_EXISTING_SYNC_LAYER →
    VERIFY_REMOTE_RESULT → MARK_PENDING_SYNCED →
    INVALIDATE_ONLY_IF_CHANGED → CLOSE_BREAKERS_AND_RETURN_ONLINE

- 恢复前必须：全局单飞锁、重新在线认证（必须 AUTHORIZED，§10.1.2-3）；
- doctor 严格门（CLD-FIX-002）：
  * doctor PASS → 继续；doctor FAIL 一律阻断 canonical read 与 push；
  * 唯一精确补救（非绕过）：FAIL 行仅为「local == remote」且本地落后远端
    （frozen sync 层自身指令「读前必须 re-pull」）→ 先经既有同步层 pull →
    复查 doctor 必须 PASS；其余任何 FAIL（工作树脏=非 Clued replay 残留、
    真分叉、篡改、不健康文件……）→ CLD-SYNC-001 阻断；
  * 崩溃残留自愈：FAIL 行仅为「working tree clean」且脏文件 ⊆ 上次崩溃
    时 APPLYING 操作的 replay 残留 → 精确恢复/删除残留 → 复查 doctor 必须
    PASS；残留不属于 Clued 自身 → 阻断；
- 排队期间（降级/在线失败）不修改工作树：payload 全部在 .clued/ staging，
  因此恢复入口 doctor 可真实 PASS（CLD-FIX-003）；
- 恢复在成功 pull 之后按原 operation_id 把 payload replay 到 Memory Engine
  （同一 engine API、同一对象 id，幂等效果），replay 后运行既有 Memory
  Validation，最后经既有同步层 push 并确认远端；
- 冲突：停止批次、不推送、生成 snapshot（base=staging 时刻 HEAD 内容、
  ours=本地意图、theirs=拉取后远端内容）、标记 CONFLICTED、进入
  CONFLICT_REVIEW，绝不自动本地覆盖远端（§10.4）；
- push/远端确认失败：回滚 Clued 自己的未推送 replay 提交与工作树残留，
  Pending 全部回到 PENDING（不丢、不标记 SYNCED），恢复入口状态保持
  doctor 可 PASS（§4.1 不变量）；
- 完成条件全满足才 ONLINE_SYNCED（§10.5）。
"""

import hashlib
import json
import os

from . import manifests
from . import state_machine as SM
from .errors import CluedError
from .identifiers import new_uuid, now_rfc3339
from .redact import redact

STEPS = (
    "ACQUIRE_SINGLE_FLIGHT_LOCK", "AUTHENTICATE", "DOCTOR_PASS",
    "VALIDATE_PENDING_JOURNAL", "PULL_VIA_EXISTING_SYNC_LAYER",
    "VALIDATE_REMOTE_HEAD", "LOAD_PENDING_IN_ORDER",
    "REPLAY_WITH_SAME_OPERATION_ID", "CHECK_OPTIMISTIC_LOCKS",
    "RUN_EXISTING_MEMORY_VALIDATION", "PUSH_VIA_EXISTING_SYNC_LAYER",
    "VERIFY_REMOTE_RESULT", "MARK_PENDING_SYNCED",
    "INVALIDATE_ONLY_IF_CHANGED", "CLOSE_BREAKERS_AND_RETURN_ONLINE",
)

INDEX_REL = "memory/object-index.json"
AUDIT_REL = "memory/audit/audit.log"


class ConflictSnapshot(object):
    """§10.4.3：现有格式兼容的 conflict snapshot（base/ours/theirs + 摘要）。

    base = staging 时刻 HEAD 内容（远端未变化前的共同基础）；
    ours = 本地意图（payload 包络渲染，保留用户内容）；
    theirs = pull 之后远端 HEAD 内容。
    """

    def __init__(self, paths, git, repo_root):
        self.paths = paths
        self.git = git
        self.repo = repo_root

    def write(self, op, ours_text, theirs_content, base_content, relpath,
              request_id=None):
        conflict_id = new_uuid()
        d = self.paths.conflict_dir(conflict_id)
        os.makedirs(d, exist_ok=True)
        files = {}

        def _write(name, text):
            p = os.path.join(d, name)
            content = (text if text else "ABSENT\n")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(content)
            files[name] = {
                "ref": relpath if name != "ours" else "payload envelope",
                "sha256": hashlib.sha256(
                    content.encode("utf-8")).hexdigest()}

        _write("base", base_content)
        _write("ours", ours_text)
        _write("theirs", theirs_content)
        meta = {
            "schema_version": "clued.conflict.v0.1",
            "conflict_id": conflict_id,
            "operation_id": op.get("operation_id"),
            "memory_id": op.get("memory_id"),
            "base_revision": op.get("base_revision"),
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

    # ---- 审计事件轨迹（§4.2 顺序证据）----
    def _step(self, name, binding_id, request_id, detail=""):
        if self.audit is not None:
            self.audit.append("recovery_step", binding_id=binding_id,
                              request_id=request_id, result_code=name,
                              metadata={"detail": detail})

    def recover(self, binding, session_id, request_id=None,
                committer_name=None, committer_email=None, manual=False):
        """恢复入口：单飞锁 + 严格顺序（§10.1.1 / §10.2）。"""
        binding_id = binding.get("binding_id")
        if self.audit is not None:
            self.audit.append("recovery_begin", binding_id=binding_id,
                              request_id=request_id,
                              result_code=SM.RECOVERING,
                              metadata={"manual": manual})
        self._step(STEPS[0], binding_id, request_id)

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
                committer_email, manual)
        finally:
            lock.release()

    def _recover_locked(self, binding, session_id, request_id, committer_name,
                        committer_email, manual):
        binding_id = binding.get("binding_id")

        # 1) AUTHENTICATE（§10.2.1；§10.1.2-3：必须 AUTHORIZED）
        self._step(STEPS[1], binding_id, request_id)
        auth = self.auth.ensure_authorized(
            binding, session_id, request_id=request_id, force_online=True)
        if auth.is_denial:
            raise CluedError("CLD-AUTH-001",
                             "恢复前重新认证被明确拒绝 → LOCKED",
                             state=SM.LOCKED, exit_code=30)
        if not auth.is_authorized:
            raise CluedError(
                "CLD-AUTH-002", "恢复前重新认证未获 AUTHORIZED，保持降级",
                state=SM.DEGRADED_LOCAL, exit_code=31,
                data={"pending": self.journal.pending_count(binding_id)})
        self._step(STEPS[1], binding_id, request_id, detail="AUTHORIZED")

        # 崩溃残留判定用：上次 APPLYING 的操作（read-only）
        residue_ops = self.journal.applying(binding_id)
        # base 快照取证锚点：任何 pull 之前的本地 HEAD（staging 时刻真值）
        pre_pull_head = self.git.head_sha()

        # 2) DOCTOR 严格门（§10.2.2；§10.1.4；CLD-FIX-002）
        self._step(STEPS[2], binding_id, request_id)
        doc = self.sync.doctor()
        pulled_for_gate = False
        if not doc.ok:
            fails = [ln for ln in doc.combined().splitlines()
                     if "[FAIL]" in ln]
            if not fails:
                raise CluedError("CLD-SYNC-001",
                                 "恢复前 sync doctor FAIL: %s"
                                 % doc.combined()[:400], state=SM.RECOVERING)
            need_pull, need_restore = False, False
            for ln in fails:
                if "working tree clean" in ln:
                    if not self._dirty_covered_by_replay_residue(residue_ops):
                        raise CluedError(
                            "CLD-SYNC-001",
                            "恢复前 doctor FAIL：工作树脏且不属于 Clued "
                            "replay 残留（阻断，禁止 canonical read/push）",
                            state=SM.RECOVERING)
                    need_restore = True
                elif "local == remote" in ln or "tracking ref valid" in ln:
                    # frozen sync 层自身的 FAIL 指令「读前必须 re-pull」：
                    # 本地落后远端（祖先关系）→ tracking ref 无法指向尚未
                    # fetch 的新远端 HEAD → 先经既有同步层 pull 对齐并补写
                    # tracking ref，再复查 doctor。真分叉/其它漂移仍阻断。
                    relation = self._local_remote_relation()
                    if relation == "behind":
                        need_pull = True
                    else:
                        raise CluedError(
                            "CLD-SYNC-001",
                            "恢复前 doctor FAIL：%s（关系=%s，非本地落后），"
                            "阻断" % (ln.strip()[:60], relation),
                            state=SM.RECOVERING)
                else:
                    raise CluedError(
                        "CLD-SYNC-001",
                        "恢复前 doctor FAIL：%s（阻断，禁止 canonical "
                        "read/push）" % ln.strip()[:200], state=SM.RECOVERING)
            if need_restore:
                self._restore_replay_residue(residue_ops)
            if need_pull:
                pull = self.sync.pull()
                if not pull.ok:
                    raise CluedError(
                        "CLD-SYNC-002", "doctor 落后补救 pull 失败: %s"
                        % pull.combined()[:400], state=SM.DEGRADED_LOCAL,
                        exit_code=31)
                pulled_for_gate = True
            doc = self.sync.doctor()
            if not doc.ok:
                raise CluedError(
                    "CLD-SYNC-001", "doctor 复查仍 FAIL（pull/残留修复后）: %s"
                    % doc.combined()[:400], state=SM.RECOVERING)
        self._step(STEPS[2], binding_id, request_id, detail="PASS")

        # 3) VALIDATE_PENDING_JOURNAL（§10.1.5；APPLYING → PENDING 崩溃恢复）
        self._step(STEPS[3], binding_id, request_id)
        self.journal.recover_applying(binding_id)
        ok_int, errors = self.journal.integrity_check(self.sync.repo,
                                                      binding_id)
        if not ok_int:
            raise CluedError(
                "CLD-PEND-001", "Journal 完整性失败: %s" % "; ".join(errors[:5]),
                state=SM.RECOVERING)
        for orphan in self.journal.orphan_payloads():
            self.journal.isolate_orphan(orphan.get("operation_id"))
        self._step(STEPS[3], binding_id, request_id, detail="OK")

        # 4) PULL_VIA_EXISTING_SYNC_LAYER（§10.2.3；先 pull 后 replay）
        self._step(STEPS[4], binding_id, request_id)
        if not pulled_for_gate:
            pull = self.sync.pull()
            if not pull.ok:
                raise CluedError(
                    "CLD-SYNC-002", "恢复 pull 失败: %s"
                    % pull.combined()[:400], state=SM.DEGRADED_LOCAL,
                    exit_code=31)
        self._step(STEPS[4], binding_id, request_id, detail="OK")

        # 5) VALIDATE_REMOTE_HEAD（§10.2.4：远端必须是本地祖先）
        self._step(STEPS[5], binding_id, request_id)
        remote = self.git.remote_head()
        local = self.git.head_sha()
        if not remote or not local or not self.git.is_ancestor(remote, local):
            raise CluedError("CLD-SYNC-004",
                             "远端 HEAD 校验失败（pull 后远端未纳入本地基线）",
                             state=SM.RECOVERING)

        # 6) LOAD_PENDING_IN_ORDER（§10.2.5；§9.4 同 Binding 按创建顺序）
        self._step(STEPS[6], binding_id, request_id)
        ops = self.journal.pending(binding_id)

        # §10.3 无变化规则：Journal 空 → 不写不推不失效
        if not ops:
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
                               "（NO_CHANGE → NO_WRITE → NO_SYNC → "
                               "NO_INVALIDATION）"}

        # 7-8) REPLAY 前的乐观锁判定（read-only；对 pull 后干净状态整体判定，
        #      任何冲突 → 整批停止、不 replay、不 commit、不 push）
        self._step(STEPS[7], binding_id, request_id)
        staged, conflicted = [], []
        for op in ops:
            verdict, detail = self._check_optimistic_lock(op)
            if verdict in ("apply", "already"):
                staged.append(op)
            else:
                conflicted.append((op, detail))
        self._step(STEPS[8], binding_id, request_id,
                   detail="apply=%d already=%d conflict=%d"
                   % (len(staged), 0, len(conflicted)))
        if conflicted:
            self._enter_conflict_review(conflicted, pre_pull_head,
                                        request_id)

        # 9) REPLAY_WITH_SAME_OPERATION_ID（§10.2.6；同一 engine API、
        #    同一对象 id，幂等效果）
        touched_rel = set()
        for op in staged:
            self.journal.mark_applying(op, request_id=request_id)
        for op in staged:
            try:
                decision, touched = self.gate.replay(op)
            except Exception as exc:
                self._rollback_worktree(self._replay_touched(staged))
                for o in staged:
                    self.journal.transition(o, "PENDING",
                                            request_id=request_id)
                raise CluedError(
                    "CLD-PEND-002", "replay 失败（批次已回滚，Pending 保留）: %s"
                    % redact(str(exc))[:300], state=SM.RECOVERING)
            if decision == "already":
                continue
            for oid in touched:
                touched_rel.add("memory/objects/%s.json" % oid)
        if touched_rel:
            touched_rel.add(INDEX_REL)
            touched_rel.add(AUDIT_REL)
        self._step(STEPS[7], binding_id, request_id,
                   detail="replayed=%d touched_files=%d"
                   % (len(staged), len(touched_rel)))

        # 10) RUN_EXISTING_MEMORY_VALIDATION（§10.2.7）
        self._step(STEPS[9], binding_id, request_id)
        if self.memory_doctor is not None:
            try:
                ok_m, out_m = self.memory_doctor()
                if not ok_m:
                    raise CluedError(
                        "CLD-SYNC-001", "Memory Engine doctor FAIL: %s"
                        % (out_m or "")[:400], state=SM.RECOVERING)
            except CluedError:
                self._rollback_worktree(touched_rel)
                for o in staged:
                    self.journal.transition(o, "PENDING",
                                            request_id=request_id)
                raise
        self._step(STEPS[9], binding_id, request_id, detail="OK")

        # 提交本批 payload（本地 commit，不 push；随后经同步层 push）
        relpaths = sorted(
            r for r in touched_rel
            if os.path.isfile(os.path.join(self.sync.repo,
                                           r.replace("/", os.sep))))
        commit_sha = None
        if relpaths:
            committer = committer_name or "Clued@%s" % _hostname()
            email = committer_email or "clued@localhost"
            commit_sha = self.git.commit_paths(
                relpaths, "[Clued] replay %d pending ops (%s)"
                % (len(staged), binding_id), committer, email)
            # 提交后 memory/ 下不得存在本批之外的残留（外部无关文件不判定）
            rels = set(relpaths)
            for line in self.git.status_porcelain().splitlines():
                path = _dirty_path(line)
                if path.startswith("memory/") and \
                        not any(path == r or path.startswith(r + "/")
                                for r in rels):
                    self._undo_commit_and_restore(commit_sha, relpaths)
                    raise CluedError(
                        "CLD-SYNC-001",
                        "replay 提交后 memory/ 仍存在未预期变更，"
                        "批次已回滚: %s" % redact(path),
                        state=SM.RECOVERING)

        # 11) PUSH_VIA_EXISTING_SYNC_LAYER（§10.2.8）
        self._step(STEPS[10], binding_id, request_id)
        push = self.sync.push()
        if not push.ok:
            if commit_sha:
                self._undo_commit_and_restore(commit_sha, relpaths)
            for op in staged:
                self.journal.transition(op, "PENDING", request_id=request_id)
            self.breaker_sync.record_failure(temporary=True)
            raise CluedError("CLD-SYNC-003",
                             "恢复 push 失败: %s" % push.combined()[:400],
                             state=SM.ONLINE_DIRTY)
        self._step(STEPS[10], binding_id, request_id, detail="OK")

        # 12) VERIFY_REMOTE_RESULT（§10.2.9）
        self._step(STEPS[11], binding_id, request_id)
        remote2 = self.git.remote_head()
        local2 = self.git.head_sha()
        if not remote2 or not local2 or \
                not self.git.is_ancestor(local2, remote2):
            if commit_sha:
                self._undo_commit_and_restore(commit_sha, relpaths)
            for op in staged:
                self.journal.transition(op, "PENDING", request_id=request_id)
            raise CluedError("CLD-SYNC-004",
                             "推送后远端确认失败（本地未成为远端祖先）",
                             state=SM.ONLINE_DIRTY)
        self._step(STEPS[11], binding_id, request_id, detail="OK")

        # 13) MARK_PENDING_SYNCED（§10.2.10：远端确认后）
        self._step(STEPS[12], binding_id, request_id)
        for op in staged:
            self.journal.mark_synced(op, request_id=request_id)

        # 14) INVALIDATE_ONLY_IF_CHANGED（§10.2.11：无读缓存；会话记录由
        #     AuthEngine 管理——本次重新认证已刷新会话授权结果）

        # 15) CLOSE_BREAKERS_AND_RETURN_ONLINE（§10.2.12）
        self._step(STEPS[14], binding_id, request_id)
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

    # ---- 乐观锁（§3.3 / §10.2 / §9.4；read-only）----
    def _check_optimistic_lock(self, op):
        """返回 (apply|already|conflict, detail)。

        以 pull 之后的干净工作树状态判定（未 replay 任何 op）：
        - CREATE：远端无该对象 → apply；内容与 payload 一致 → already；
          否则 conflict；
        - UPDATE/SUPERSEDE/DELETE：远端内容 sha == base → apply；
          语义效果已达成（幂等重试）→ already；否则 conflict；
        - base_pending（链式操作，目标对象仅存在于 pending）：
          远端无该对象 → apply；语义效果已达成 → already；否则 conflict。
        """
        env, err = self.gate.load_payload(op)
        if err:
            return "conflict", err
        primary = self.gate.op_primary_relpath(op)
        oid = self._primary_oid(op, env)
        sha, obj = self.gate.object_state(oid) if oid else (None, None)
        base = op.get("base_revision")
        engine_op = env.get("engine_op")
        already = self.gate.op_effect_already(op)

        if env.get("base_pending") or \
                (engine_op == "CREATE" and base is None):
            if sha is None:
                return "apply", "远端无该对象（pending 链）"
            return ("already" if already else "conflict"), \
                "远端已存在对象且与 payload 效果不一致"
        if sha == base:
            return "apply", "base 未变"
        if already:
            return "already", "语义效果已达成（幂等重试）"
        return "conflict", "远端 revision 已改变（乐观锁）"

    def _primary_oid(self, op, env):
        if env.get("engine_op") in ("UPDATE", "SUPERSEDE", "DELETE"):
            return env.get("target_id")
        return env.get("memory_id")

    # ---- 残留与提交回滚（仅作用于 Clued 自身产物）----
    def _replay_touched(self, ops):
        out = set()
        for op in ops:
            out |= self.gate.residue_paths(op)
        return out

    def _rollback_worktree(self, relpaths):
        """把指定路径恢复为 HEAD 内容（或删除 HEAD 不存在的新建文件）。

        仅用于回滚 Clued 自己的 replay 产物：恢复入口 doctor 已确认工作树
        干净，这些路径的变更必属本批次 replay。
        """
        for rel in sorted(set(relpaths)):
            full = os.path.join(self.sync.repo, rel.replace("/", os.sep))
            if not os.path.isfile(full):
                continue
            if self.git.blob_sha(rel) is not None:
                self.git.restore_paths([rel])
            else:
                os.remove(full)

    def _undo_commit_and_restore(self, commit_sha, relpaths):
        """回滚 Clued 自己的未推送 replay 提交（push/确认失败时）。

        前置校验：HEAD == commit_sha（绝不回滚他人提交）。使用
        `git reset --soft`（非 --hard、非 checkout，不触碰工作树内容）
        后精确 restore/删除本批文件，使恢复入口重新回到 doctor 可 PASS
        状态。回滚校验只针对本批 replay 路径（其余无关文件不受判定）。
        """
        if not commit_sha:
            return
        self.git.reset_soft_undo_commit(commit_sha)
        self._rollback_worktree(relpaths)
        rels = set(r.replace("\\", "/") for r in relpaths)
        for line in self.git.status_porcelain().splitlines():
            if len(line) < 3:
                continue
            path = line[3:] if line[2] == " " else line[2:]
            path = path.strip().strip('"').replace("\\", "/")
            if path.endswith("/"):
                path = path[:-1]
            if any(path == r or path.startswith(r + "/")
                   for r in rels):
                raise CluedError(
                    "CLD-SYNC-003",
                    "replay 提交回滚后本批路径仍存在变更（阻断，需人工检查）: %s"
                    % redact(path))

    def _dirty_covered_by_replay_residue(self, residue_ops):
        if not residue_ops:
            return False
        allowed = self._replay_touched(residue_ops)
        if not allowed:
            return False
        try:
            status = self.git.status_porcelain()
        except CluedError:
            return False
        mem_dirty = [p for line in status.splitlines()
                     if len(line) >= 3
                     for p in [_dirty_path(line)]
                     if p.startswith("memory/")]
        if not mem_dirty:
            return False
        for path in mem_dirty:
            if not any(p == path or p.startswith(path + "/")
                       for p in allowed):
                return False
        return True

    def _restore_replay_residue(self, residue_ops):
        """崩溃残留自愈：精确恢复/删除 Clued 上次 APPLYING 的 replay 残留。"""
        relpaths = self._replay_touched(residue_ops)
        if not relpaths:
            raise CluedError("CLD-SYNC-001",
                             "工作树脏但无可归因的 replay 残留（阻断）",
                             state=SM.RECOVERING)
        self._rollback_worktree(relpaths)
        rels = set(r.replace("\\", "/") for r in relpaths)
        for line in self.git.status_porcelain().splitlines():
            if len(line) < 3:
                continue
            path = _dirty_path(line)
            if any(path == r or path.startswith(r + "/") for r in rels):
                raise CluedError(
                    "CLD-SYNC-001",
                    "残留自愈后本批路径仍脏（阻断，禁止 canonical read/push）: %s"
                    % redact(path), state=SM.RECOVERING)
        if self.audit is not None:
            self.audit.append(
                "recovery_begin", result_code="REPLAY_RESIDUE_REPAIRED",
                metadata={"detail": "上次崩溃的 replay 残留已精确自愈，"
                                    "doctor 复查 PASS"})

    def _local_remote_relation(self):
        local = self.git.head_sha()
        remote = self.git.remote_head()
        if not local or not remote:
            return "unknown"
        if local == remote:
            return "equal"
        if self.git.is_ancestor(local, remote):
            return "behind"
        if self.git.is_ancestor(remote, local):
            return "ahead"
        return "diverged"

    # ---- 冲突（§10.4）----
    def _enter_conflict_review(self, conflicted, pre_pull_head,
                               request_id=None):
        binding_id = (conflicted[0][0].get("binding_id")
                      if conflicted else "")
        snapshots = []
        for op, detail in conflicted:
            env, err = self.gate.load_payload(op)
            primary = self.gate.op_primary_relpath(op)
            oid = self._primary_oid(op, env) if not err else None
            base_content = (self.git.blob_at_ref(pre_pull_head, primary)
                            if primary and pre_pull_head else None)
            theirs = (self.git.blob_at_head(primary)
                      if primary else None)
            ours = _render_ours(env)
            if primary and oid:
                cid, meta = ConflictSnapshot(
                    self.paths, self.git, self.sync.repo).write(
                        op, ours, theirs, base_content, primary,
                        request_id=request_id)
                snapshots.append(cid)
                if self.audit is not None:
                    self.audit.append(
                        "conflict_snapshot", binding_id=binding_id,
                        request_id=request_id, result_code="CLD-CONFLICT-001",
                        metadata={"conflict_id": cid,
                                  "operation_id": op.get("operation_id"),
                                  "detail": detail})
            self.journal.mark_conflicted(op, request_id=request_id)
        self.breaker_sync.record_failure(temporary=False)
        raise CluedError(
            "CLD-CONFLICT-001",
            "%d 个操作存在乐观锁或内容冲突；批次未推送，进入"
            "CONFLICT_REVIEW（冲突快照已生成）" % len(conflicted),
            state=SM.CONFLICT_REVIEW, exit_code=41,
            data={"conflicted": len(conflicted),
                  "conflict_ids": snapshots})


def _dirty_path(line):
    """porcelain v1 行 → 规范化正斜杠路径（'XY path' / 'X path' 兼容）。"""
    if len(line) < 3:
        return ""
    path = line[3:] if line[2] == " " else line[2:]
    path = path.strip().strip('"').replace("\\", "/")
    if path.endswith("/"):
        path = path[:-1]
    return path


def _render_ours(env):
    """本地意图渲染（冲突快照 ours：保留用户内容，不复制明文到日志）。"""
    if not isinstance(env, dict):
        return json.dumps({"error": "payload 不可解析"}, ensure_ascii=False)
    engine_op = env.get("engine_op")
    if engine_op == "CREATE" and env.get("candidate"):
        return json.dumps(env["candidate"], ensure_ascii=False, indent=2)
    if engine_op == "SUPERSEDE" and env.get("successor_candidate"):
        return json.dumps(env["successor_candidate"], ensure_ascii=False,
                          indent=2)
    return json.dumps({
        "engine_op": engine_op,
        "target_id": env.get("target_id"),
        "memory_id": env.get("memory_id"),
        "content": env.get("content"),
        "base_revision": env.get("base_revision"),
    }, ensure_ascii=False, indent=2)


def _hostname():
    import socket
    try:
        return socket.gethostname()
    except Exception:
        return "node"
