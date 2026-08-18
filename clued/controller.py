# -*- coding: utf-8 -*-
"""Lifecycle Controller（协议 §4.1 / §11.2）。

状态转换必须经过单一控制器并写入审计事件；不得以多个互不一致的布尔值
代替状态机。本模块是 install / auth / memory / sync / uninstall / status /
doctor 的唯一编排入口（CLI 只做参数解析）。
"""

import json
import os

from . import manifests
from . import state_machine as SM
from .audit import AuditLog
from .auth.authcache import AuthCache
from .auth.engine import AuthEngine, SessionRecord
from .auth.github_provider import GitHubAuthProvider
from .auth.provider import AUTHORIZED, DENIED, DENIED_SECURITY, UNAVAILABLE
from .circuit_breaker import CircuitBreaker
from .errors import CluedError
from .identifiers import new_uuid
from .installer import Installer
from .locking import CrossProcessLock
from .memory_gate import MemoryGate
from .paths import RuntimePaths, resolve_repo, resolve_runtime_root
from .pending_journal import PendingJournal
from .recovery import Recovery
from .registry import AgentRegistry
from .sync_provider import GitRepo, SyncProvider
from .uninstaller import Uninstaller

STATE_FILE_SCHEMA = "clued.runtime-state.v0.1"

DEGRADED_OPS = ("recall", "create", "update", "supersede", "delete",
                "status", "sync", "uninstall")


class Controller(object):
    def __init__(self, repo, runtime_root, provider, sync, git, audit=None,
                 adapter_doc_path=None, memory_doctor=None):
        self.repo = os.path.abspath(repo)
        # 引擎路径对齐（Memory Engine 只在本端克隆内读写）
        from memory_engine import paths as engine_paths
        engine_paths.set_repo(self.repo)
        self.paths = RuntimePaths(runtime_root)
        self.paths.ensure_dirs()
        self.audit = audit or AuditLog(self.paths.audit_log())
        self.registry = AgentRegistry(self.paths, audit=self.audit)
        self.sync_provider = sync
        self.git = git
        self.provider = provider
        self.memory_doctor = memory_doctor

        node = self.registry.load_node()
        self.node_id = node.get("node_id") if node else None

        # 双熔断器（auth / sync，Controller 级缺省；实际按 Binding 加载）
        self.breaker_auth = CircuitBreaker(
            "auth", audit=self.audit, paths=self.paths)
        self.breaker_sync = CircuitBreaker(
            "sync", audit=self.audit, paths=self.paths)

        self.auth_cache = AuthCache(
            self.paths,
            lambda: (self.registry.load_node() or {}).get("node_id") or "")
        self.journal = PendingJournal(self.paths, audit=self.audit)
        self.gate = MemoryGate(self.repo, self.paths, audit=self.audit)
        self.installer = Installer(
            self.registry, provider, sync, git, self.paths, audit=self.audit,
            adapter_doc_path=adapter_doc_path)
        self.uninstaller = Uninstaller(
            self.registry, provider, sync, git, self.journal, self.auth_cache,
            self.paths, audit=self.audit)
        self._restore_breaker_state()

    # ---- 工厂 ----
    @classmethod
    def create(cls, repo=None, runtime_root=None, provider=None,
               sync_timeout_s=None, adapter_doc_path=None, memory_doctor=None):
        repo = repo or resolve_repo()
        root = runtime_root or resolve_runtime_root(repo)
        sync_provider = SyncProvider(repo, timeout_s=sync_timeout_s)
        git = GitRepo(repo)
        provider = provider if provider is not None else _provider_from_env()
        if memory_doctor is None:
            memory_doctor = _make_memory_doctor(repo)
        return cls(repo, root, provider, sync_provider, git,
                   adapter_doc_path=adapter_doc_path,
                   memory_doctor=memory_doctor)

    # ---- 状态持久化（§11.2 单一控制器）----
    def _state_file(self):
        return self.paths.runtime_state()

    def _load_state(self):
        p = self._state_file()
        if not os.path.isfile(p):
            return {"schema_version": STATE_FILE_SCHEMA, "bindings": {}}
        try:
            data = manifests.read_json(p)
        except Exception:
            return {"schema_version": STATE_FILE_SCHEMA, "bindings": {}}
        if not isinstance(data.get("bindings"), dict):
            data = {"schema_version": STATE_FILE_SCHEMA, "bindings": {}}
        return data

    def _save_state(self, data):
        manifests.atomic_write_json(self._state_file(), data)

    def get_state(self, binding_id):
        data = self._load_state()
        entry = data.get("bindings", {}).get(binding_id) or {}
        return entry.get("state") or SM.UNINSTALLED

    def transition(self, binding_id, to_state, request_id=None):
        """状态转换必须经此入口（审计 + 持久化）。"""
        from_state = self.get_state(binding_id)
        if from_state == to_state:
            return to_state
        try:
            SM.check_transition(from_state, to_state)
        except SM.InvalidTransition as exc:
            raise CluedError("CLD-INSTALL-001",
                             "非法状态转换: %s" % exc, state=from_state)
        data = self._load_state()
        entry = data.setdefault("bindings", {}).setdefault(binding_id, {})
        entry["state"] = to_state
        entry["updated_at"] = self._now_iso()
        data["bindings"][binding_id] = entry
        self._save_state(data)
        # 审计 event_type 使用状态机 TRANSITION_EVENTS（如 LOCKED →
        # AUTH_REQUIRED 记 auth_recovered，CLD-FIX-004 审计要求）
        event_type = SM.TRANSITION_EVENTS.get((from_state, to_state),
                                              "state_transition")
        self.audit.append(event_type, binding_id=binding_id,
                          request_id=request_id, result_code=to_state,
                          metadata={"from": from_state, "to": to_state})
        return to_state

    def _now_iso(self):
        from .identifiers import now_rfc3339
        return now_rfc3339()

    def _restore_breaker_state(self):
        data = self._load_state()
        for binding_id, entry in (data.get("bindings") or {}).items():
            self._binding_breakers(binding_id, entry)

    def _binding_breakers(self, binding_id, entry=None):
        data = self._load_state()
        entry = entry or data.get("bindings", {}).get(binding_id) or {}
        auth_b = CircuitBreaker.from_dict(
            entry.get("breaker_auth"), "auth", audit=self.audit,
            binding_id=binding_id, paths=self.paths)
        sync_b = CircuitBreaker.from_dict(
            entry.get("breaker_sync"), "sync", audit=self.audit,
            binding_id=binding_id, paths=self.paths)
        return auth_b, sync_b

    def _recovery_for(self, binding_id):
        """每 Binding 独立熔断器贯通：ensure_access 与 recovery 共享同一对
        breaker 实例（§8.3.5 每 Binding/Provider 单飞）。"""
        auth_b, sync_b = self._binding_breakers(binding_id)
        engine = AuthEngine(self.provider, self.auth_cache, auth_b, self.paths,
                            audit=self.audit)
        recovery = Recovery(
            self.registry, self.provider, engine, self.sync_provider,
            self.git,
            self.journal, self.gate, sync_b, self.paths, audit=self.audit,
            memory_doctor=self.memory_doctor)
        return auth_b, sync_b, engine, recovery

    def _persist_breakers(self, binding_id, auth_b, sync_b):
        data = self._load_state()
        entry = data.setdefault("bindings", {}).setdefault(binding_id, {})
        entry["breaker_auth"] = auth_b.to_dict()
        entry["breaker_sync"] = sync_b.to_dict()
        entry["state"] = self.get_state(binding_id)
        data["bindings"][binding_id] = entry
        self._save_state(data)

    # ---- 解析 binding ----
    def require_binding(self, binding_id, allow_revoked=False):
        binding = self.registry.load_binding(binding_id)
        if binding is None:
            raise CluedError("CLD-BIND-001", "Agent Binding 不存在: %s"
                             % binding_id)
        if not allow_revoked and binding.get("status") != "ACTIVE":
            raise CluedError("CLD-AUTH-001", "Binding 已撤销或禁用",
                             state=SM.LOCKED)
        return binding

    # ---- install ----
    def install(self, agent_type, agent_instance_label, session_id=None,
                request_id=None, committer_name=None, committer_email=None):
        session_id = session_id or new_uuid()
        result = self.installer.install(
            agent_type, agent_instance_label, session_id, request_id=request_id,
            committer_name=committer_name, committer_email=committer_email)
        binding = result.get("binding")
        if binding is not None:
            bid = binding["binding_id"]
            # 状态机：UNINSTALLED/INSTALL_ERROR → INSTALLING → ONLINE_SYNCED
            state = self.get_state(bid)
            if state in (SM.UNINSTALLED, SM.INSTALL_ERROR):
                self.transition(bid, SM.INSTALLING, request_id)
            self.transition(bid, SM.ONLINE_SYNCED, request_id)
            # 每 Binding 独立熔断器（§8.3.5）
            auth_b, sync_b, engine, _rec = self._recovery_for(bid)
            # 安装会话已在线认证成功 → 本会话复用（§7.1）
            engine.save_session(SessionRecord(
                session_id, bid, AUTHORIZED,
                scopes=binding.get("scopes") or [],
                provider=self.provider.name))
            # 登记 LKG（安装在线认证结果）
            engine._store_lkg(binding, _AuthLike(binding))
            self._persist_breakers(bid, auth_b, sync_b)
        return result

    # ---- auth check ----
    def auth_check(self, binding_id, session_id=None, request_id=None):
        session_id = session_id or new_uuid()
        binding = self.require_binding(binding_id, allow_revoked=True)
        auth_b, sync_b, engine, _rec = self._recovery_for(binding_id)
        result = engine.ensure_authorized(
            binding, session_id, request_id=request_id, force_online=True)
        self._persist_breakers(binding_id, auth_b, sync_b)
        if result.is_denial:
            state = self.get_state(binding_id)
            if state in SM.INSTALLED_STATES:
                self.transition(binding_id, SM.LOCKED, request_id)
            raise CluedError("CLD-AUTH-001",
                             "在线授权已被明确拒绝：%s" % result.detail,
                             state=SM.LOCKED, exit_code=30,
                             data={"reason": result.kind})
        if result.is_authorized:
            state = self.get_state(binding_id)
            if state in (SM.AUTH_REQUIRED, SM.DEGRADED_LOCAL, SM.RECOVERING):
                pending = self.journal.pending_count(binding_id)
                self.transition(binding_id, SM.ONLINE_DIRTY if pending
                                else SM.ONLINE_SYNCED, request_id)
            elif state == SM.LOCKED:
                # D4：LOCKED 出口（待产品确认项，保留为文档化偏差）——
                # 新的在线认证成功 + 账户一致 + Binding ACTIVE + scope 合规
                # + 完整性检查通过 → LOCKED → AUTH_REQUIRED → ONLINE_*。
                # 审计事件 auth_recovered + auth_authorized。
                if not self._account_consistent(binding, result):
                    raise CluedError(
                        "CLD-AUTH-001",
                        "LOCKED 解除被拒绝：账户不一致（%s）"
                        % (result.account_id or ""),
                        state=SM.LOCKED, exit_code=30)
                self.transition(binding_id, SM.AUTH_REQUIRED, request_id)
                pending = self.journal.pending_count(binding_id)
                self.transition(binding_id, SM.ONLINE_DIRTY if pending
                                else SM.ONLINE_SYNCED, request_id)
            return {"code": AUTHORIZED, "state": self.get_state(binding_id),
                    "scopes": result.scopes,
                    "summary": "在线认证成功（AUTHORIZED）"}
        if result.is_degraded:
            state = self.get_state(binding_id)
            if state == SM.LOCKED:
                # CLD-FIX-004：LOCKED 期间禁止降级、禁止使用旧 LKG
                raise CluedError(
                    "CLD-AUTH-002",
                    "LOCKED 状态下在线认证不可用：禁止使用旧 LKG 降级，"
                    "保持 LOCKED",
                    exit_code=31, state=SM.LOCKED)
            self.transition(binding_id, SM.DEGRADED_LOCAL, request_id)
            return {
                "code": "DEGRADED", "state": SM.DEGRADED_LOCAL,
                "scopes": result.scopes,
                "degraded_until": result.degraded_until,
                "pending": self.journal.pending_count(binding_id),
                "summary": ("当前无法连接授权服务，已根据最近一次有效授权"
                            "临时切换到本地优先模式，最长 30 分钟。新修改会"
                            "安全排队，尚未同步到远端；连接恢复后会先重新"
                            "认证再同步。"),
            }
        # UNAVAILABLE 且不能降级
        raise CluedError("CLD-AUTH-002",
                         "在线认证暂时不可用且无法降级：%s" % result.detail,
                         exit_code=31, state=self.get_state(binding_id))

    # ---- memory access ----
    def ensure_access(self, binding, session_id, request_id, operation,
                      manual=False):
        """Memory Access 门禁（§7.1）。返回 (kind, scopes, state)。

        manual=True：用户显式操作（卸载等）→ 经单飞锁执行一次受控 HALF_OPEN
        探测，不受认证熔断冷却期阻塞（§8.3.6 / §8.4）。
        """
        binding_id = binding.get("binding_id")
        auth_b, sync_b, engine, _rec = self._recovery_for(binding_id)
        was_locked = self.get_state(binding_id) == SM.LOCKED
        # CLD-FIX-004：LOCKED 状态必须强制新的在线认证（不得复用旧会话结果）
        result = engine.ensure_authorized(
            binding, session_id, request_id=request_id,
            force_online=(manual or was_locked))
        self._persist_breakers(binding_id, auth_b, sync_b)
        if result.is_denial:
            state = self.get_state(binding_id)
            if state in SM.INSTALLED_STATES:
                self.transition(binding_id, SM.LOCKED, request_id)
            raise CluedError(
                "CLD-AUTH-001",
                "在线授权已被明确拒绝，因此没有启用本地降级，"
                "也没有读取或写入记忆：%s" % result.detail,
                state=SM.LOCKED, exit_code=30)
        if result.is_authorized:
            state = self.get_state(binding_id)
            if state == SM.LOCKED:
                # D4 出口：新在线认证成功 + 账户一致 + Binding ACTIVE +
                # scope 合规 + 完整性检查（LKG 校验已由引擎完成）→ 离开 LOCKED
                if not self._account_consistent(binding, result):
                    raise CluedError(
                        "CLD-AUTH-001",
                        "LOCKED 解除被拒绝：账户不一致（%s）"
                        % (result.account_id or ""),
                        state=SM.LOCKED, exit_code=30)
                self.transition(binding_id, SM.AUTH_REQUIRED, request_id)
                state = self.get_state(binding_id)
            if state == SM.AUTH_REQUIRED:
                self.transition(binding_id, SM.ONLINE_SYNCED, request_id)
            return AUTHORIZED, result.scopes, self.get_state(binding_id)
        if result.is_degraded:
            if was_locked:
                # LOCKED 期间：不降级、不读不写、不使用旧 LKG（CLD-FIX-004）
                raise CluedError(
                    "CLD-AUTH-002",
                    "LOCKED 状态下在线认证不可用：禁止降级与 Memory Access",
                    state=SM.LOCKED, exit_code=31)
            if (operation or "").lower() not in DEGRADED_OPS:
                raise CluedError(
                    "CLD-AUTH-005", "降级模式禁止该操作: %s" % operation,
                    state=SM.DEGRADED_LOCAL, exit_code=30)
            state = self.get_state(binding_id)
            if state in (SM.AUTH_REQUIRED, SM.ONLINE_SYNCED, SM.ONLINE_DIRTY):
                self.transition(binding_id, SM.DEGRADED_LOCAL, request_id)
            return "DEGRADED", result.scopes, self.get_state(binding_id)
        # UNAVAILABLE
        raise CluedError(
            "CLD-AUTH-002", "在线认证暂时不可用且无法降级：%s" % result.detail,
            exit_code=31, state=self.get_state(binding_id))

    def memory_recall(self, binding_id, session_id, query, tier="T2",
                      request_id=None):
        binding = self.require_binding(binding_id)
        kind, scopes, state = self.ensure_access(
            binding, session_id, request_id, "recall")
        if "memory:read" not in scopes:
            raise CluedError("CLD-AUTH-005", "scope 不足：缺少 memory:read",
                             exit_code=30)
        result = self.gate.recall(query, tier=tier)
        return {"kind": kind, "state": state, "recall": result,
                "summary": "召回完成（%s）" % state}

    def _account_consistent(self, binding, auth_result):
        return _account_consistent(binding, auth_result)

    def memory_write(self, binding_id, session_id, operation, content,
                     memory_id=None, category=None, request_id=None,
                     remember=False, committer_name=None,
                     committer_email=None):
        binding = self.require_binding(binding_id)
        kind, scopes, state = self.ensure_access(
            binding, session_id, request_id, operation)
        if "memory:write" not in scopes:
            raise CluedError("CLD-AUTH-005", "scope 不足：缺少 memory:write",
                             exit_code=30)
        outcome = self.gate.write(
            binding, session_id, operation, content, memory_id=memory_id,
            category=category, request_id=request_id, remember=remember)
        if outcome.decision == "NO_CHANGE":
            return {"decision": "NO_CHANGE", "state": state, "op": None,
                    "memory_id": outcome.memory_id,
                    "synced": True, "pending": self.journal.pending_count(
                        binding_id),
                    "summary": "无变化（NO_CHANGE → NO_WRITE → NO_SYNC）"}
        if kind == "DEGRADED":
            self.transition(binding_id, SM.DEGRADED_LOCAL, request_id)
            return {
                "decision": outcome.decision,
                "state": SM.DEGRADED_LOCAL,
                "operation_id": outcome.op["operation_id"],
                "memory_id": outcome.memory_id,
                "synced": False,
                "pending": self.journal.pending_count(binding_id),
                "summary": ("已保存在本地（Pending Journal），尚未同步到远端；"
                            "连接恢复后会先重新认证再同步。"),
            }
        # AUTHORIZED：立即尝试同步。恢复层自己重新在线认证
        #（CLD-FIX-002：每次恢复必须先重新在线认证且必须 AUTHORIZED）。
        _auth_b, _sync_b, _engine, recovery = self._recovery_for(binding_id)
        try:
            sync_result = recovery.recover(
                binding, session_id, request_id=request_id,
                committer_name=committer_name, committer_email=committer_email)
        except CluedError as exc:
            self._persist_breakers(binding_id, _auth_b, _sync_b)
            # 在线写入的同步失败 → ONLINE_DIRTY（本地操作保留在 Journal）。
            # 弱网降级由下一次 Memory Access 的在线认证尝试判定（§11.2），
            # 不在同步平面伪造网络结论（§4.3 两平面解耦）。
            state = self._mark_dirty(binding_id)
            raise CluedError(
                exc.code, exc.message,
                state=state, exit_code=exc.exit_code,
                data={"pending": self.journal.pending_count(binding_id),
                      "synced": False,
                      "operation_id": outcome.op["operation_id"]})
        self._persist_breakers(binding_id, _auth_b, _sync_b)
        if self.get_state(binding_id) == SM.ONLINE_DIRTY:
            try:
                self.transition(binding_id, SM.ONLINE_SYNCED, request_id)
            except CluedError:
                pass
        return {
            "decision": outcome.decision,
            "state": SM.ONLINE_SYNCED,
            "operation_id": outcome.op["operation_id"],
            "memory_id": outcome.memory_id,
            "synced": True,
            "pending": 0,
            "summary": "写入已完成并获远端确认（ONLINE_SYNCED）",
            "replay": sync_result,
        }

    def _mark_dirty(self, binding_id):
        """在线但存在尚未提交的本地操作 → ONLINE_DIRTY（§11.1）。"""
        try:
            self.transition(binding_id, SM.ONLINE_DIRTY)
            return SM.ONLINE_DIRTY
        except CluedError:
            return self.get_state(binding_id)

    # ---- sync（手动恢复触发器，§8.4.3）----
    def sync(self, binding_id, session_id=None, request_id=None,
             committer_name=None, committer_email=None):
        session_id = session_id or new_uuid()
        binding = self.require_binding(binding_id)
        # §12.4：恢复联网后优先执行撤销队列
        self.uninstaller.run_revoke_queue(request_id=request_id)
        auth_b, sync_b, engine, recovery = self._recovery_for(binding_id)
        if not sync_b.allow_request(manual=True):
            raise CluedError(
                "CLD-NET-001", "同步探测受单飞锁/速率限制",
                exit_code=31, state=self.get_state(binding_id),
                retry_after=sync_b.retry_after() or 30)
        self._persist_breakers(binding_id, auth_b, sync_b)
        state = self.get_state(binding_id)
        if state in (SM.DEGRADED_LOCAL, SM.ONLINE_DIRTY):
            self.transition(binding_id, SM.RECOVERING, request_id)
        try:
            result = recovery.recover(
                binding, session_id, request_id=request_id,
                committer_name=committer_name, committer_email=committer_email,
                manual=True)
            self.transition(binding_id, SM.ONLINE_SYNCED, request_id)
            self._persist_breakers(binding_id, auth_b, sync_b)
            return {"state": SM.ONLINE_SYNCED, **result}
        except CluedError as exc:
            self._persist_breakers(binding_id, auth_b, sync_b)
            if exc.state == SM.CONFLICT_REVIEW:
                try:
                    self.transition(binding_id, SM.CONFLICT_REVIEW,
                                    request_id)
                except CluedError:
                    pass
            elif exc.state == SM.LOCKED:
                try:
                    self.transition(binding_id, SM.LOCKED, request_id)
                except CluedError:
                    pass
            elif exc.state == SM.DEGRADED_LOCAL and \
                    self.get_state(binding_id) == SM.RECOVERING:
                self.transition(binding_id, SM.DEGRADED_LOCAL, request_id)
            elif exc.state in (SM.RECOVERING, None) and \
                    self.get_state(binding_id) == SM.RECOVERING:
                # 严格 doctor 阻断/其它恢复失败：回到降级（pending 保留），
                # 不伪报 ONLINE
                try:
                    self.transition(binding_id, SM.DEGRADED_LOCAL,
                                    request_id)
                except CluedError:
                    pass
            if exc.state == SM.DEGRADED_LOCAL or \
                    self.get_state(binding_id) == SM.DEGRADED_LOCAL:
                if exc.state == SM.DEGRADED_LOCAL and exc.code == "CLD-AUTH-002":
                    raise CluedError(
                        "CLD-AUTH-002",
                        "重新认证不可用，保持本地优先降级；"
                        "不会增加高频重试：%s" % exc.message,
                        exit_code=31, state=SM.DEGRADED_LOCAL,
                        data={"pending":
                              self.journal.pending_count(binding_id)})
            raise

    # ---- status（§7.1 MAY：不含私有记忆内容，无需在线认证）----
    def status(self, binding_id=None):
        node = self.registry.load_node()
        bindings = self.registry.list_bindings(include_revoked=True)
        out_bindings = []
        for b in bindings:
            bid = b.get("binding_id")
            data = self._load_state()
            entry = data.get("bindings", {}).get(bid) or {}
            out_bindings.append({
                "binding_id": bid,
                "agent_type": b.get("agent_type"),
                "agent_instance_label": b.get("agent_instance_label"),
                "binding_status": b.get("status"),
                "state": entry.get("state") or SM.UNINSTALLED,
                "pending": self.journal.pending_count(bid),
                "conflicted": len(self.journal.list_all(
                    bid, statuses=("CONFLICTED",))),
                "breaker_auth": (entry.get("breaker_auth") or {}).get("state"),
                "breaker_sync": (entry.get("breaker_sync") or {}).get("state"),
                "account_verified": bool(b.get("account_id")),
                "installed_at": b.get("installed_at"),
                "corrupt": bool(b.get("corrupt")),
            })
        if binding_id:
            out_bindings = [b for b in out_bindings
                            if b.get("binding_id") == binding_id]
        return {
            "protocol_version": "0.2.0",
            "node_id": (node or {}).get("node_id"),
            "runtime_root": self.paths.root,
            "bindings": out_bindings,
            "pending_total": sum(b["pending"] for b in out_bindings),
            "sync_local_head": _safe(self.git.head_sha),
            "summary": "本地健康摘要（不含私有记忆内容）",
        }

    # ---- uninstall ----
    def uninstall(self, binding_id, mode="detach-current-agent",
                  session_id=None, request_id=None, discard_pending=False,
                  confirm_shared_cleanup=False):
        session_id = session_id or new_uuid()
        binding = self.registry.load_binding_loose(binding_id)
        online_auth = None
        if binding is not None and not binding.get("corrupt") and \
                binding.get("status") == "ACTIVE":
            # 卸载前评估会话授权（§12.3 三分支）；卸载属用户显式操作 →
            # 受控探测（§8.4.3 用户显式请求可触发一次恢复探测）
            try:
                kind, scopes, state = self.ensure_access(
                    binding, session_id, request_id, "uninstall", manual=True)
                online_auth = {"kind": kind, "scopes": scopes}
            except CluedError as exc:
                if exc.exit_code == 30:
                    online_auth = {"kind": "DENIED"}
                else:
                    online_auth = {"kind": "DEGRADED"}
        result = self.uninstaller.uninstall(
            binding_id, mode=mode, session_id=session_id, request_id=request_id,
            discard_pending=discard_pending,
            confirm_shared_cleanup=confirm_shared_cleanup,
            online_auth=online_auth)
        if result.get("state") == SM.UNINSTALLED:
            state = self.get_state(binding_id)
            if state in SM.INSTALLED_STATES:
                self.transition(binding_id, SM.UNINSTALLING, request_id)
                self.transition(binding_id, SM.UNINSTALLED, request_id)
        return result

    # ---- doctor ----
    def doctor(self, request_id=None, include_sync=True, include_engine=True):
        findings = []
        failed = []

        def check(name, ok, detail=""):
            findings.append({"check": name, "ok": bool(ok),
                             "detail": str(detail)})
            if not ok:
                failed.append(name)

        # 运行时根可写
        try:
            probe = os.path.join(self.paths.root, ".doctor-probe")
            with open(probe, "w", encoding="utf-8") as fh:
                fh.write("ok")
            os.remove(probe)
            check("runtime_root_writable", True)
        except OSError as exc:
            check("runtime_root_writable", False, exc)

        # node manifest（未安装 = 无 manifest，属正常；存在则必须合法）
        try:
            node = self.registry.load_node()
            check("node_manifest", True,
                  (node or {}).get("node_id") or "未安装（UNINSTALLED）")
        except CluedError as exc:
            check("node_manifest", False, exc.message)

        # binding manifests
        for b in self.registry.list_bindings(include_revoked=True):
            check("binding_%s" % b.get("binding_id"), not b.get("corrupt"),
                  "manifest 校验" if not b.get("corrupt")
                  else str(b.get("corrupt")))

        # auth cache 完整性
        for b in self.registry.list_bindings(include_revoked=True):
            bid = b.get("binding_id")
            entry, err = self.auth_cache.load(bid)
            if err:
                check("auth_cache_%s" % bid, False, err)
            elif entry is not None:
                check("auth_cache_%s" % bid, True, "LKG 存在且完整")

        # journal 完整性
        ok_int, errors = self.journal.integrity_check(self.repo)
        check("pending_journal_integrity", ok_int,
              "; ".join(errors[:5]) if errors else "OK")

        # orphan payload（CLD-FIX-003：检测、隔离并审计，不静默丢弃）
        orphans = self.journal.orphan_payloads()
        for o in orphans:
            self.journal.isolate_orphan(o.get("operation_id"))
        check("pending_orphan_payloads", not orphans,
              "; ".join("%s(%s)" % (o.get("operation_id"), o.get("reason"))
                        for o in orphans[:5]) if orphans else "无孤儿")

        # journal 条目结构
        for op in self.journal.list_all():
            ok_op, err_op = manifests.validate_pending_op(op)
            check("journal_%s" % op["operation_id"], ok_op,
                  err_op if not ok_op else op["status"])

        # .clued 不入 git（§5.5）
        try:
            rel = os.path.relpath(self.paths.root, self.repo)
            if rel == "." or rel.startswith(".."):
                check("runtime_root_gitignored", True,
                      "运行时根位于仓库外: %s" % self.paths.root)
            else:
                p = self.git._run_git(["check-ignore", "--quiet", rel])
                check("runtime_root_gitignored", p.returncode == 0,
                      rel if p.returncode == 0 else "%s 未被 gitignore" % rel)
        except CluedError as exc:
            check("runtime_root_gitignored", False, exc.message)

        # sync doctor（子进程）
        if include_sync:
            doc = self.sync_provider.doctor()
            check("sync_doctor", doc.ok,
                  "PASS" if doc.ok else "FAIL: %s" % doc.combined()[:300])

        # 引擎 doctor（子进程 memory.py doctor）
        if include_engine:
            eng_ok, eng_out = self._run_engine_doctor()
            check("memory_engine_doctor", eng_ok,
                  eng_out or "PASS")

        if failed:
            raise CluedError(
                "CLD-SYNC-001", "doctor FAIL：%s" % ", ".join(failed),
                exit_code=40, data={"findings": findings})
        return {"findings": findings, "summary": "doctor ALL PASS"}

    def _run_engine_doctor(self):
        if self.memory_doctor is not None:
            return self.memory_doctor()
        import subprocess
        import sys
        try:
            p = subprocess.run(
                [sys.executable, os.path.join(self.repo, "memory.py"),
                 "doctor"], cwd=self.repo, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=60)
            return p.returncode == 0, (p.stdout or p.stderr or "").strip()[:300]
        except Exception as exc:
            return False, str(exc)


def result_scopes(scopes):
    return list(scopes or [])


def _account_consistent(binding, auth_result):
    """D4 出口条件之一：账户一致（§7.4 账户不匹配 → LOCKED）。"""
    expect = binding.get("account_id") or ""
    got = getattr(auth_result, "account_id", None) or ""
    if not expect or not got:
        return False
    return expect == got


def _make_memory_doctor(repo):
    """默认引擎 doctor：子进程 `python memory.py doctor`（不改写引擎）。"""
    def _run():
        import subprocess
        import sys as _sys
        try:
            p = subprocess.run(
                [_sys.executable, os.path.join(repo, "memory.py"), "doctor"],
                cwd=repo, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=60)
            return p.returncode == 0, \
                (p.stdout or p.stderr or "").strip()[:300]
        except Exception as exc:
            return False, str(exc)
    return _run


def _provider_from_env():
    """CLUED_AUTH_PROVIDER = github（默认）| fake:<spec.json>。"""
    spec = os.environ.get("CLUED_AUTH_PROVIDER") or "github"
    if spec == "github":
        return GitHubAuthProvider()
    if spec.startswith("fake:"):
        from .auth.fake import FakeAuthProvider
        path = spec.split(":", 1)[1]
        if not os.path.isfile(path):
            raise CluedError("CLD-CAP-001", "fake provider spec 不存在: %s"
                             % path)
        return FakeAuthProvider.from_spec_file(path)
    raise CluedError("CLD-CAP-001", "未知 CLUED_AUTH_PROVIDER: %s" % spec)


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


class _AuthLike(object):
    def __init__(self, binding):
        self.account_id = binding.get("account_id")
        self.scopes = binding.get("scopes") or []
        self.provider = "github"
        self.subject = (binding.get("account_id") or "").split(":", 1)[-1]
        self.authorized_at = binding.get("installed_at")
