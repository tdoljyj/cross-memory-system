# -*- coding: utf-8 -*-
"""Agent Installation Contract（协议 §6，CLD-001）。

- 安装由明确意图触发；仅提问不安装（§6.1）；
- 能力预检 10 项，机器可读 JSON，失败给稳定错误码，不留下半安装状态（§6.2）；
- 安装事务 14 步（§6.3）：锁 → 发现 → 暂存 → 验源 → 在线认证 → 账户 →
  节点 → Binding → 适配器 → bootstrap/pull → doctor → 提交清单 → 验证 → 释放锁；
- 原子性：要么 ACTIVE，要么回滚到安装前（§6.4）；文件替换 = 临时文件 + 原子 rename；
- 幂等：健康 → ALREADY_INSTALLED + 轻量验证；可修复 → repair；
  同 Agent 多 Binding → BINDING_CONFLICT（§6.5）。
"""

import json
import os
import shutil

from . import manifests
from . import state_machine as SM
from .errors import CluedError
from .identifiers import new_uuid, now_rfc3339
from .locking import CrossProcessLock, LockBusy

ADAPTER_VERSION = "0.1.x"
ADAPTER_DOC = "codex_adapter.md"

PREFLIGHT_CHECKS = (
    ("capability", "智能体工具/命令能力（CLI 可执行）"),
    ("runtime_root", "可写运行时根目录"),
    ("lock", "跨进程锁可取得"),
    ("sync_script", "既有 sync 脚本存在且可运行"),
    ("doctor", "sync 层 doctor 状态"),
    ("git_remote", "git 与 Canonical remote 状态"),
    ("already_bound", "当前 Agent 是否已绑定"),
    ("pending_txn", "是否存在未完成安装/卸载事务"),
    ("protocol_version", "协议版本兼容性"),
    ("credentials", "凭据存储能力可用"),
)


class PreflightResult(object):
    def __init__(self, checks, ok, error_code=None, detail=""):
        self.checks = checks      # [(name, ok, detail)]
        self.ok = ok
        self.error_code = error_code
        self.detail = detail

    def to_dict(self):
        return {
            "ok": self.ok,
            "error_code": self.error_code,
            "detail": self.detail,
            "checks": [{"check": name, "ok": ok, "detail": detail}
                       for name, ok, detail in self.checks],
        }


class Installer(object):
    def __init__(self, registry, provider, sync, git, paths, audit=None,
                 find_gh=None, adapter_doc_path=None):
        self.registry = registry
        self.provider = provider
        self.sync = sync            # SyncProvider
        self.git = git              # GitRepo
        self.paths = paths
        self.audit = audit
        self.find_gh = find_gh
        self.adapter_doc_path = adapter_doc_path

    # ---- 预检（§6.2，不修改远端，不留下半安装状态）----
    def preflight(self, agent_type, agent_instance_label):
        checks = []
        errors = []

        # 1) 能力：本 CLI 即能力载体；gh 存在性供认证用
        gh = (self.find_gh or _find_gh)() if (self.find_gh or _find_gh) else None
        checks.append(("capability", bool(gh), "gh CLI 可用" if gh
                       else "gh CLI 不可用"))

        # 2) 运行时根可写
        try:
            self.paths.ensure_dirs()
            probe = os.path.join(self.paths.root, ".write-probe")
            with open(probe, "w", encoding="utf-8") as fh:
                fh.write("ok")
            os.remove(probe)
            checks.append(("runtime_root", True, self.paths.root))
        except OSError as exc:
            checks.append(("runtime_root", False, str(exc)))
            errors.append("CLD-INSTALL-001")

        # 3) 跨进程锁（取得后立即释放，预检不得改远端）
        lock = CrossProcessLock(
            os.path.join(self.paths.locks_dir(), "lifecycle.lock"))
        got = lock.acquire()
        lock.release()
        checks.append(("lock", got, "可取得" if got else "被其他进程占用"))

        # 4) sync 脚本存在且可运行（语法检查，不执行）
        try:
            script = self.sync.require_sync_script()
            import ast
            with open(script, "r", encoding="utf-8") as fh:
                ast.parse(fh.read())
            checks.append(("sync_script", True, script))
        except (CluedError, SyntaxError, OSError) as exc:
            checks.append(("sync_script", False, str(exc)))
            errors.append("CLD-INSTALL-001")

        # 5) doctor 状态（执行 sync 层 doctor；FAIL 阻断安装，§19.1）
        doc = self.sync.doctor()
        checks.append(("doctor", doc.ok,
                       "PASS" if doc.ok else "FAIL: %s" % doc.combined()[:300]))
        if not doc.ok:
            errors.append("CLD-SYNC-001")

        # 6) git 与 remote 状态
        try:
            head = self.git.head_sha()
            checks.append(("git_remote", bool(head), "HEAD=%s" % (head or "?")))
        except CluedError as exc:
            checks.append(("git_remote", False, exc.message))
            errors.append("CLD-SYNC-001")

        # 7) 当前 Agent 是否已绑定（≤1 个 ACTIVE 即无冲突；多 Binding 由
        #    install() 在预检前以 BINDING_CONFLICT 拦截）
        existing = self.registry.find_by_agent(agent_type,
                                               agent_instance_label)
        active = [b for b in existing if b.get("status") == "ACTIVE"]
        if not active:
            checks.append(("already_bound", True, "未绑定（可安装）"))
        elif len(active) == 1:
            checks.append(("already_bound", True, "已有 1 个 ACTIVE Binding"
                           "（幂等路径处理）"))
        else:
            checks.append(("already_bound", False, "%d 个冲突 Binding"
                           % len(active)))
            errors.append("CLD-BIND-002")

        # 8) 未完成事务（staging 残留）
        staging = self.paths.staging_dir()
        leftover = []
        if os.path.isdir(staging):
            leftover = [d for d in os.listdir(staging)
                        if not d.startswith(".")]
        checks.append(("pending_txn", not leftover,
                       "无残留" if not leftover else "残留事务: %s"
                       % ", ".join(leftover[:5])))
        if leftover:
            errors.append("CLD-INSTALL-003")

        # 9) 协议版本兼容（node manifest 若存在必须同 schema）
        node = self.registry.load_node()
        compat = True
        detail = "新节点"
        if node is not None:
            compat = node.get("schema_version") == manifests.NODE_SCHEMA
            detail = "node=%s" % node.get("node_id")
        checks.append(("protocol_version", compat, detail))
        if not compat:
            errors.append("CLD-INSTALL-001")

        # 10) 凭据存储能力（gh 已登录）
        gh_ok = bool(gh)
        checks.append(("credentials", gh_ok,
                       "gh CLI 可用" if gh_ok else "gh CLI 不可用"))
        if not gh_ok:
            errors.append("CLD-CAP-001")

        ok = all(c[1] for c in checks) and not errors
        failed = [n for n, is_ok, _d in checks if not is_ok]
        return PreflightResult(checks, ok,
                               error_code=(errors[0] if errors else None),
                               detail=("失败项: " + ", ".join(failed)
                                       if failed else "全部通过"))

    # ---- 安装事务（§6.3）----
    def install(self, agent_type, agent_instance_label, session_id,
                request_id=None, committer_name=None, committer_email=None):
        if agent_type not in ("codex",):
            raise CluedError("CLD-INSTALL-001",
                             "不支持的 agent-type: %s（v0.1 仅 codex）"
                             % agent_type)
        if not agent_instance_label:
            raise CluedError("CLD-INSTALL-001", "缺少 agent-instance label")

        # 0) 幂等检查（§6.5）
        existing = self.registry.find_by_agent(agent_type,
                                               agent_instance_label)
        active = [b for b in existing if b.get("status") == "ACTIVE"]
        if len(active) == 1:
            return self._already_installed(active[0], request_id)
        if len(active) > 1:
            raise CluedError(
                "CLD-BIND-002",
                "同 Agent 存在 %d 个冲突 Binding，进入 BINDING_CONFLICT"
                % len(active), state=SM.INSTALL_ERROR,
                data={"conflicting_binding_ids":
                      [b.get("binding_id") for b in active]})

        # 1) 预检（§6.2）
        pre = self.preflight(agent_type, agent_instance_label)
        if not pre.ok:
            raise CluedError(
                "CLD-INSTALL-001", "安装预检失败: %s" % pre.detail,
                data={"preflight": pre.to_dict()})

        # 2) Acquire Lock
        lock = CrossProcessLock(
            os.path.join(self.paths.locks_dir(), "lifecycle.lock"),
            audit=self.audit, purpose="install")
        if not lock.acquire():
            raise CluedError("CLD-INSTALL-001", "节点生命周期锁被占用")
        txn_id = new_uuid()
        self.audit.append("install_begin", request_id=request_id,
                          result_code="INSTALLING",
                          metadata={"agent_type": agent_type,
                                    "agent_instance_label":
                                        agent_instance_label,
                                    "txn_id": txn_id})
        try:
            return self._install_locked(
                agent_type, agent_instance_label, session_id, request_id,
                txn_id, committer_name, committer_email)
        finally:
            lock.release()

    def _install_locked(self, agent_type, agent_instance_label, session_id,
                        request_id, txn_id, committer_name, committer_email):
        staging = self.paths.staging_txn(txn_id)
        binding_id = None
        try:
            # 3) Discover
            node = self.registry.load_node()
            node_id = node.get("node_id") if node else new_uuid()

            # 4) Stage：适配器文档 + 绑定清单暂存
            os.makedirs(staging, exist_ok=True)
            adapter_src = self.adapter_doc_path
            staged_adapter = os.path.join(staging, "adapter.md")
            if adapter_src and os.path.isfile(adapter_src):
                shutil.copy(adapter_src, staged_adapter)

            # 5) Authenticate Online（首次安装不允许弱网降级，§6.3.5）
            binding_id = new_uuid()
            agent_id = new_uuid()
            probe_binding = {
                "binding_id": binding_id, "agent_id": agent_id,
                "node_id": node_id, "account_id": "",
                "agent_type": agent_type,
                "agent_instance_label": agent_instance_label,
                "scopes": list(manifests.SCOPES), "status": "ACTIVE",
            }
            result = self.provider.authenticate(probe_binding)
            if not result.is_authorized:
                # 在线认证失败 → 禁止创建可用 Binding（§6.4）
                raise CluedError(
                    "CLD-AUTH-001" if result.is_denial else "CLD-AUTH-002",
                    "首次安装在线认证失败：%s（%s）"
                    % (result.kind, result.detail), state=SM.INSTALL_ERROR,
                    exit_code=(30 if result.is_denial else 31))

            # 6) Resolve Account
            account_id = result.account_id
            if not account_id:
                raise CluedError("CLD-AUTH-001", "认证结果缺少稳定账户标识",
                                 state=SM.INSTALL_ERROR)

            # 7) Create/Repair Node
            if node is None:
                node = manifests.build_node_manifest(node_id)
                self.registry.save_node(node)
            elif node.get("node_id") != node_id:
                raise CluedError("CLD-SEC-001", "node_id 漂移",
                                 state=SM.INSTALL_ERROR)

            # 8) Create Agent Binding
            binding = manifests.build_binding_manifest(
                binding_id, agent_id, node_id, account_id, agent_type,
                agent_instance_label, ADAPTER_VERSION, result.scopes or
                list(manifests.SCOPES), status="ACTIVE",
                installed_at=now_rfc3339(), artifacts=[])

            # 9) Attach Adapter：把适配器文档写入 binding 目录并登记 artifact
            binding_dir = self.paths.binding_dir(binding_id)
            os.makedirs(binding_dir, exist_ok=True)
            adapter_target = os.path.join(binding_dir, "adapter.md")
            if os.path.isfile(staged_adapter):
                shutil.copy(staged_adapter, adapter_target)
                binding["installed_artifacts"].append({
                    "kind": "adapter-doc",
                    "path": adapter_target,
                    "sha256": manifests.sha256_file(adapter_target),
                })

            # 10) Bootstrap/Pull：经既有同步层初始化或拉取
            self.sync.bootstrap()
            pull = self.sync.pull()
            if not pull.ok:
                raise CluedError("CLD-SYNC-002",
                                 "安装阶段 pull 失败: %s" % pull.combined()[:400],
                                 state=SM.INSTALL_ERROR)

            # 11) Doctor：完整诊断（sync doctor + 引擎 doctor）
            doc = self.sync.doctor()
            if not doc.ok:
                raise CluedError("CLD-SYNC-001",
                                 "安装阶段 doctor FAIL: %s"
                                 % doc.combined()[:400], state=SM.INSTALL_ERROR)

            # 12) Commit Manifest（P0-1 原子双写）：binding.json（Clued manifest）
            #     + state.json（lifecycle 三轴）一次事务创建，杜绝半创建/同路径
            #     不同 schema 冲突。
            from memory_engine.lifecycle_ctl import states as LCStates
            from memory_engine.lifecycle_ctl.controller import STATE_SCHEMA
            init_state = LCStates.new_state(binding="ACTIVE", session="ONLINE",
                                            truth="ADVISORY")
            init_state["binding_id"] = binding_id
            init_state["schema_version"] = STATE_SCHEMA
            self.registry.save_binding_with_state(binding, init_state)
            self.registry.update_node_binding_count()
            self.audit.append("bind_create", binding_id=binding_id,
                              request_id=request_id, result_code="ACTIVE",
                              metadata={"agent_type": agent_type,
                                        "agent_instance_label":
                                            agent_instance_label,
                                        "account_id": account_id})

            # 13) Verify Conversation Path：只读状态检查
            loaded = self.registry.load_binding(binding_id)
            if loaded.get("status") != "ACTIVE":
                raise CluedError("CLD-INSTALL-003",
                                 "绑定提交后校验失败", state=SM.INSTALL_ERROR)

            # 14) 清理 staging → 成功
            shutil.rmtree(staging, ignore_errors=True)
            self.audit.append("install_success", binding_id=binding_id,
                              request_id=request_id,
                              result_code="ONLINE_SYNCED",
                              metadata={"agent_type": agent_type})
            return {
                "binding": binding,
                "state": SM.ONLINE_SYNCED,
                "summary": ("Clued 已为当前智能体安装并完成在线验证。"
                            "这个 Binding 只属于当前智能体；"
                            "本设备上的其他智能体需要分别安装。"),
            }
        except Exception as exc:
            self._rollback_install(binding_id, request_id=request_id,
                                   txn_id=txn_id)
            raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def _rollback_install(self, binding_id, request_id=None, txn_id=None):
        """按 artifact manifest 回滚（§6.4）。失败进入 INSTALL_ERROR，
        保留审计事件和精确残留清单，禁止伪报安装成功。"""
        residues = []
        rolled_back = True
        if binding_id:
            binding = self.registry.load_binding_loose(binding_id)
            if binding and not binding.get("corrupt"):
                for art in binding.get("installed_artifacts") or []:
                    p = art.get("path")
                    if not p:
                        continue
                    real_bdir = os.path.realpath(
                        self.paths.binding_dir(binding_id))
                    real_p = os.path.realpath(p)
                    if real_p == real_bdir or \
                            real_p.startswith(real_bdir + os.sep):
                        try:
                            if os.path.isfile(p):
                                os.remove(p)
                        except OSError:
                            rolled_back = False
                            residues.append(p)
                bdir = self.paths.binding_dir(binding_id)
                try:
                    if os.path.isdir(bdir):
                        os.rmdir(bdir)
                except OSError:
                    rolled_back = False
                    residues.append(bdir)
            # 认证缓存（LKG）也移除
            self.paths._p("auth", "%s.json" % binding_id)
            try:
                os.remove(self.paths.auth_cache(binding_id))
            except OSError:
                pass
        if rolled_back:
            self.audit.append("install_rollback_complete",
                              binding_id=binding_id, request_id=request_id,
                              result_code="CLD-INSTALL-002",
                              metadata={"txn_id": txn_id})
        else:
            self.audit.append("install_failure", binding_id=binding_id,
                              request_id=request_id,
                              result_code="CLD-INSTALL-003",
                              metadata={"residues": residues,
                                        "txn_id": txn_id})

    # ---- 幂等（§6.5）----
    def _already_installed(self, binding, request_id=None):
        """Binding 健康 → ALREADY_INSTALLED + 轻量验证；
        可修复 → 事务性 repair（不创建第二个 Binding）。"""
        try:
            loaded = self.registry.load_binding(binding["binding_id"])
            matched, mismatched = self.registry.artifact_checks(loaded)
        except CluedError as exc:
            raise CluedError("CLD-AUTH-004", "已有 Binding 校验失败: %s"
                             % exc.message, state=SM.INSTALL_ERROR)
        if mismatched:
            repaired = self._repair_artifacts(loaded, mismatched, request_id)
            if not repaired:
                raise CluedError(
                    "CLD-INSTALL-003",
                    "已有 Binding artifact 校验不符且无法修复（可修复项：%s）"
                    % json.dumps(mismatched, ensure_ascii=False)[:400],
                    state=SM.INSTALL_ERROR, data={"mismatched": mismatched})
            self.audit.append("install_success",
                              binding_id=loaded["binding_id"],
                              request_id=request_id,
                              result_code="REPAIRED",
                              metadata={"repaired": len(repaired)})
            return {
                "binding": self.registry.load_binding(loaded["binding_id"]),
                "state": SM.AUTH_REQUIRED, "code": "REPAIRED",
                "summary": ("已对既有 Binding 执行事务性修复（%d 个 artifact）"
                            % len(repaired)),
            }
        return {
            "binding": loaded,
            "state": SM.AUTH_REQUIRED,
            "code": "ALREADY_INSTALLED",
            "summary": ("Clued 已安装；本次为幂等检查（ALREADY_INSTALLED）。"),
        }

    def _repair_artifacts(self, binding, mismatched, request_id=None):
        """按 manifest 修复 artifact：adapter-doc 从参考模板重新落盘并更新
        sha256；无法修复的条目返回 None。"""
        repaired = []
        src = self.adapter_doc_path
        if not src or not os.path.isfile(src):
            return None
        bdir = self.paths.binding_dir(binding["binding_id"])
        for art in mismatched:
            if art.get("kind") != "adapter-doc":
                return None
            target = art.get("path")
            real_bdir = os.path.realpath(bdir)
            real_target = os.path.realpath(target)
            if not (real_target == real_bdir or
                    real_target.startswith(real_bdir + os.sep)):
                return None
            try:
                shutil.copy(src, target)
                art["sha256"] = manifests.sha256_file(target)
                repaired.append(art["path"])
            except OSError:
                return None
        # 更新 manifest 中的 sha256（原子保存）
        for art in binding["installed_artifacts"]:
            for bad in mismatched:
                if art["path"] == bad["path"] and "sha256" in bad:
                    art["sha256"] = bad["sha256"]
        self.registry.save_binding(binding)
        matched, still_bad = self.registry.artifact_checks(binding)
        if still_bad:
            return None
        return repaired


def _find_gh():
    from .auth.github_provider import find_gh as _gh
    return _gh()
