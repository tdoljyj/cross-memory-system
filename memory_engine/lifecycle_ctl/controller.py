# -*- coding: utf-8 -*-
"""R3-L01~L05 Lifecycle Controller（Gate 2 裁决六动作 + 三轴 + 幂等 + 中断恢复）。

六动作：install / repair / update / disable / enable / uninstall。

设计约束：
- 每 Binding 一个状态文件（三轴状态 + journal），位于 state_root（隔离环境）；
- 操作前写 journal（op_id/action/stage），完成后清除；启动时恢复遗留 journal；
- 幂等：重复 install→ALREADY_ACTIVE、重复 disable→ALREADY_DISABLED、
  重复 uninstall→ALREADY_UNINSTALLED 等（不报错）；
- disable 后：session=OFFLINE/DENIED，读/写/同步操作被 gate 拒绝（INV-3）；
- repair：BROKEN→ACTIVE；DISABLED 保持 DISABLED（INV-2，绝不意外 ACTIVE）；
- update：复用 dist.AtomicArtifactStore（staging→校验→原子切换→回滚）；
- enable：重新授权（auth_check）+ 构件（artifact_check）+ Truth 能力检查
  （conformance）通过后才 ACTIVE；
- uninstall：只解绑当前 Binding（其余 Binding 状态文件不动），
  不触碰共享 Core / canonical memory；
- 本控制器不修改冻结区、不写 refs/remotes、不触碰真实 memory。
"""

import json
import os
import shutil
import time
import uuid

from . import states as S

ACTIONS = ("install", "repair", "update", "disable", "enable", "uninstall")

# P0-1 裁决（2026-08-20）：Binding 目录布局拆分，消除"同路径不同 schema"冲突
# - bindings/<id>/binding.json ：Clued manifest（schema、Agent、Adapter、scope）
# - bindings/<id>/state.json   ：生命周期/连接/Truth 三轴状态
# 两者以 binding_id + 各自 schema 版本字段关联，由安装事务原子创建。
# legacy 兼容：仅存在 binding.json 且为旧三轴格式 → 兼容读（directory-legacy），
# 写入被拒绝（CLD-LAYOUT-003，须先迁移）；仅 manifest 无 state → CLD-LAYOUT-004
# （半创建 fail-closed）。
STATE_SCHEMA = "lifecycle.state.v0.1"
MANIFEST_SCHEMA = "clued.binding.v0.1"  # 与 clued.manifests.BINDING_SCHEMA 对齐（避免循环导入硬编码对齐）


class LifecycleError(Exception):
    def __init__(self, code, detail=""):
        super(LifecycleError, self).__init__("%s: %s" % (code, detail))
        self.code = code
        self.detail = detail


class LifecycleController(object):

    def __init__(self, state_root, artifact_store=None,
                 auth_check=None, artifact_check=None, conformance=None):
        self.state_root = state_root
        self.artifact_store = artifact_store  # dist.AtomicArtifactStore（update 用）
        self.auth_check = auth_check or (lambda binding_id: True)
        self.artifact_check = artifact_check or (lambda binding_id: True)
        self.conformance = conformance or (lambda binding_id: False)
        os.makedirs(state_root, exist_ok=True)

    # ---- 持久化（P0-1：state.json 承载三轴；binding.json 为 Clued manifest） ----
    def _safe_id(self, binding_id):
        import re
        return re.sub(r"[^A-Za-z0-9._-]", "_", binding_id)

    def _dir_path(self, binding_id):
        """正式生命周期布局：<state_root>/<safe_id>/（内含 binding.json + state.json）"""
        return os.path.join(self.state_root, self._safe_id(binding_id))

    def _state_path(self, binding_id):
        """三轴状态文件（P0-1 规范路径）：<state_root>/<safe_id>/state.json"""
        return os.path.join(self._dir_path(binding_id), "state.json")

    def _manifest_path(self, binding_id):
        """Clued manifest 文件：<state_root>/<safe_id>/binding.json"""
        return os.path.join(self._dir_path(binding_id), "binding.json")

    def _flat_path(self, binding_id):
        """旧扁平布局（仅受控迁移兼容读，不写入）：<state_root>/<safe_id>.json"""
        return os.path.join(self.state_root, "%s.json" % self._safe_id(binding_id))

    def _path(self, binding_id):
        """返回 (path, layout)：state.json 优先；binding.json 兼容读；扁平兼容读。

        layout：directory（新布局 state.json）/ directory-legacy（旧三轴 binding.json
        兼容读，禁止写）/ flat-migration（旧扁平，禁止写）。
        """
        d = self._dir_path(binding_id)
        spath = self._state_path(binding_id)
        mpath = self._manifest_path(binding_id)
        flat = self._flat_path(binding_id)
        has_state = os.path.isfile(spath)
        has_manifest = os.path.isfile(mpath)
        has_flat = os.path.isfile(flat)
        if has_flat and (has_state or has_manifest):
            raise LifecycleError(
                "CLD-LAYOUT-001",
                "双格式冲突：%s 与目录布局同时存在（fail-closed，禁止猜测/自动合并）"
                % flat)
        if has_state:
            return spath, "directory"
        if has_manifest:
            try:
                with open(mpath, "r", encoding="utf-8") as f:
                    man = json.load(f)
            except (ValueError, OSError):
                raise LifecycleError(
                    "CLD-LAYOUT-004",
                    "binding.json 损坏（binding_id=%s）；state.json 缺失，无法判定布局"
                    % binding_id)
            if man.get("schema_version") == MANIFEST_SCHEMA:
                # 仅 manifest、无 state.json → 半创建（fail-closed）
                raise LifecycleError(
                    "CLD-LAYOUT-004",
                    "半创建：binding.json（manifest）存在但 state.json 缺失"
                    "（binding_id=%s）；安装事务必须原子创建两者" % binding_id)
            # 旧三轴格式（无 schema_version / 非 manifest）→ 兼容读
            return mpath, "directory-legacy"
        if has_flat:
            return flat, "flat-migration"  # 受控迁移兼容读（不写回）
        return spath, "directory"  # 写入一律走新布局 state.json

    def load(self, binding_id):
        try:
            p, layout = self._path(binding_id)
        except LifecycleError:
            raise
        if not os.path.isfile(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            st = json.load(f)
        st["_layout"] = layout  # 记录读取布局（directory / directory-legacy / flat-migration）
        return st

    def save(self, binding_id, st):
        st = dict(st)
        st["binding_id"] = binding_id
        st["updated_at"] = time.time()
        st["schema_version"] = STATE_SCHEMA
        d = self._dir_path(binding_id)
        spath = self._state_path(binding_id)
        mpath = self._manifest_path(binding_id)
        flat = self._flat_path(binding_id)
        # 布局判定（双格式冲突 / legacy 保护 / 扁平保护，fail-closed）
        if os.path.isfile(flat) and (os.path.isfile(spath)
                                     or os.path.isfile(mpath)):
            raise LifecycleError(
                "CLD-LAYOUT-001",
                "双格式冲突：%s 与目录布局同时存在（fail-closed）" % flat)
        if os.path.isfile(mpath):
            with open(mpath, "r", encoding="utf-8") as f:
                try:
                    man = json.load(f)
                except ValueError:
                    raise LifecycleError(
                        "CLD-LAYOUT-004", "binding.json 损坏（binding_id=%s）"
                        % binding_id)
            if man.get("schema_version") != MANIFEST_SCHEMA:
                # 旧三轴 binding.json 独占（legacy）：P0-1 后三轴一律写 state.json，
                # legacy 须先迁移（迁移裁决后执行）；保护现状不被半迁移写坏。
                raise LifecycleError(
                    "CLD-LAYOUT-003",
                    "legacy 布局需先迁移（binding_id=%s）：三轴状态必须写入 state.json"
                    "（binding.json 保留为 Clued manifest）" % binding_id)
        elif os.path.isfile(flat):
            # 扁平仅受控迁移兼容读；写入一律走正式布局（保留原 CLD-LAYOUT-002 语义）
            raise LifecycleError(
                "CLD-LAYOUT-002",
                "扁平布局需先迁移（binding_id=%s）；禁止写扁平文件" % binding_id)
        os.makedirs(d, exist_ok=True)
        tmp = spath + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
            f.flush()
        os.replace(tmp, spath)
        return st

    # ---- 枚举（对齐 clued list_bindings：仅目录布局） ----
    def list_bindings(self):
        """枚举目录布局 Binding：state.json（新布局）优先，legacy binding.json 兼容列出。"""
        out = []
        if not os.path.isdir(self.state_root):
            return out
        for entry in sorted(os.listdir(self.state_root)):
            if entry.startswith(".") or entry.endswith(".json"):
                continue  # 跳过点文件（lock/journal）与扁平文件
            bpath = os.path.join(self.state_root, entry)
            if not os.path.isdir(bpath):
                continue
            spath = os.path.join(bpath, "state.json")
            mpath = os.path.join(bpath, "binding.json")
            if os.path.isfile(spath):
                try:
                    with open(spath, "r", encoding="utf-8") as f:
                        st = json.load(f)
                    st["_layout"] = "directory"
                    out.append(st)
                except (ValueError, OSError):
                    continue
            elif os.path.isfile(mpath):
                # legacy 三轴（directory-legacy）兼容列出；manifest-only 半创建跳过
                try:
                    with open(mpath, "r", encoding="utf-8") as f:
                        man = json.load(f)
                    if man.get("schema_version") == MANIFEST_SCHEMA:
                        continue  # 半创建：manifest 无 state，非 lifecycle 视图
                    man["_layout"] = "directory-legacy"
                    out.append(man)
                except (ValueError, OSError):
                    continue
        return out

    def find_by_agent(self, binding_id):
        """按 binding_id 唯一定位（目录布局优先；扁平仅受控迁移读）。"""
        for b in self.list_bindings():
            if b.get("binding_id") == binding_id:
                return b
        st = self.load(binding_id)
        if st and st.get("_layout") == "flat-migration":
            return st
        return None

    # ---- journal（中断恢复） ----
    def _journal_path(self, binding_id, op_id):
        import re
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", binding_id)
        return os.path.join(self.state_root, ".journal-%s-%s.json"
                            % (safe, op_id))

    def _begin(self, binding_id, action):
        op_id = uuid.uuid4().hex[:12]
        jp = self._journal_path(binding_id, op_id)
        with open(jp, "w", encoding="utf-8") as f:
            json.dump({"op_id": op_id, "binding_id": binding_id,
                       "action": action, "stage": "begin",
                       "ts": time.time()}, f, ensure_ascii=False)
        return op_id, jp

    def _stage(self, jp, stage):
        with open(jp, "r", encoding="utf-8") as f:
            j = json.load(f)
        j["stage"] = stage
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(j, f, ensure_ascii=False)
        return j

    def _end(self, jp):
        if os.path.isfile(jp):
            os.remove(jp)

    def recover_pending(self):
        """恢复遗留 journal：操作中断 → 标记 BROKEN（不静默继续）。"""
        recovered = []
        for f in sorted(os.listdir(self.state_root)):
            if not f.startswith(".journal-"):
                continue
            jp = os.path.join(self.state_root, f)
            with open(jp, "r", encoding="utf-8") as jf:
                j = json.load(jf)
            st = self.load(j["binding_id"])
            if st and st.get("binding") == "INSTALLING":
                st["binding"] = "BROKEN"
                st["session"] = "OFFLINE"
                self.save(j["binding_id"], st)
                recovered.append((j["binding_id"], j["action"], "INSTALLING->BROKEN"))
            self._end(jp)
        return recovered

    # ---- 六动作 ----
    # journal 生命周期契约（R3-P0-2 裁决，2026-08-20）：
    # _begin() 之后的所有退出路径（正常返回 / LifecycleError / 其他异常）
    # 必须清理 journal —— 统一以 finally 收口，杜绝 repair/disable/uninstall
    # 幂等提前返回等分支的 journal 泄漏（试装审计暴露）。
    # 进程级崩溃（finally 不执行）→ journal 保留 → recover_pending 恢复为 BROKEN。
    # ---- 安装事务（P0-1：原子创建 binding.json manifest + state.json 三轴） ----
    def _default_manifest(self, binding_id):
        """默认 Clued manifest（试装/迁移路径无外部 manifest 时构造）。

        manifest 字段对齐 clued.manifests.build_binding_manifest，确保
        clued registry 校验与 doctor 通过（schema_version=clued.binding.v0.1、
        agent 字段、scopes 非空、auth_policy 已知）。
        """
        import uuid as _uuid
        label = binding_id
        if binding_id.startswith("codex-"):
            label = binding_id[len("codex-"):]
        from clued.manifests import DEFAULT_POLICY
        return {
            "schema_version": MANIFEST_SCHEMA,
            "binding_id": binding_id,
            "agent_id": "agent-%s" % _uuid.uuid4().hex[:12],
            "node_id": "node-%s" % _uuid.uuid4().hex[:12],
            "account_id": "local",
            "agent_type": "codex",
            "agent_instance_label": label,
            "adapter_version": "0.3.0",
            "scopes": ["memory:read", "memory:write", "sync:request"],
            "auth_policy": DEFAULT_POLICY,
            "status": "ACTIVE",
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "last_verified_at": None,
            "installed_artifacts": [],
        }

    def _atomic_create(self, binding_id, manifest):
        """原子创建 binding.json（manifest）+ state.json（初始三轴）。

        tmp 双写 → 依次 replace；第二个 replace 失败 → 回滚第一个（删除），
        保证不出现半创建（CLD-LAYOUT-004 场景）。
        """
        d = self._dir_path(binding_id)
        os.makedirs(d, exist_ok=True)
        mpath = self._manifest_path(binding_id)
        spath = self._state_path(binding_id)
        if os.path.isfile(mpath) or os.path.isfile(spath):
            raise LifecycleError(
                "CLD-LAYOUT-004", "目标文件已存在（binding_id=%s），禁止覆盖创建"
                % binding_id)
        m_tmp = mpath + ".tmp"
        s_tmp = spath + ".tmp"
        st_init = S.new_state(binding="INSTALLING", session="ONLINE",
                              truth="UNAVAILABLE")
        st_init["binding_id"] = binding_id
        st_init["schema_version"] = STATE_SCHEMA
        st_init["updated_at"] = time.time()
        try:
            with open(m_tmp, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
                f.flush()
            with open(s_tmp, "w", encoding="utf-8") as f:
                json.dump(st_init, f, ensure_ascii=False, indent=1)
                f.flush()
            os.replace(m_tmp, mpath)
            try:
                os.replace(s_tmp, spath)
            except BaseException:
                # 回滚已提交的 manifest，保持 ABSENT（不留下半创建）
                if os.path.isfile(mpath):
                    os.remove(mpath)
                raise
        finally:
            for p in (m_tmp, s_tmp):
                if os.path.isfile(p):
                    os.remove(p)

    def install(self, binding_id, manifest=None):
        op_id, jp = self._begin(binding_id, "install")
        try:
            st = self.load(binding_id)
            if st:
                if st["binding"] in ("ACTIVE", "DISABLED"):
                    # R1 修复（裁决 2026-08-20）：幂等成功返回也必须清理 journal
                    return self.status(binding_id, note="ALREADY_INSTALLED")
                if st["binding"] == "BROKEN":
                    raise LifecycleError("CLD-INSTALL-001", "binding 处于 BROKEN，请先 repair/uninstall")
            S.check_transition("ABSENT", "INSTALLING")
            man = manifest or self._default_manifest(binding_id)
            # 原子创建两文件（binding.json manifest + state.json 初始三轴）
            self._atomic_create(binding_id, man)
            self._stage(jp, "installing")
            # 安装后默认 ADVISORY（未做 conformance，不得 ENFORCED）
            new_st = S.new_state(binding="ACTIVE", session="ONLINE", truth="ADVISORY")
            self.save(binding_id, new_st)
            return self.status(binding_id)
        except LifecycleError:
            raise
        finally:
            self._end(jp)

    def repair(self, binding_id):
        """修复：BROKEN→ACTIVE；DISABLED 保持 DISABLED（INV-2）；ACTIVE 幂等。"""
        op_id, jp = self._begin(binding_id, "repair")
        try:
            st = self.load(binding_id)
            if not st:
                raise LifecycleError("CLD-REPAIR-001", "binding 不存在")
            cur = st["binding"]
            if cur == "ACTIVE":
                return self.status(binding_id, note="ALREADY_ACTIVE")
            if cur == "DISABLED":
                # INV-2：repair 不得把 DISABLED 改成 ACTIVE
                return self.status(binding_id, note="REMAIN_DISABLED")
            if cur == "BROKEN":
                S.check_transition("BROKEN", "ACTIVE")
                st["binding"] = "ACTIVE"
                st["session"] = "ONLINE"
                if st.get("truth") == "UNAVAILABLE":
                    st["truth"] = "ADVISORY"
                self.save(binding_id, st)
                return self.status(binding_id)
            raise LifecycleError("CLD-REPAIR-001", "当前状态 %s 不可 repair" % cur)
        except LifecycleError:
            raise
        finally:
            self._end(jp)

    def update(self, binding_id, manifest=None, allowlist=None, url_for=None,
               fetcher=None):
        """update：staging→校验→原子切换→回滚（复用 dist store）。"""
        op_id, jp = self._begin(binding_id, "update")
        try:
            st = self.load(binding_id)
            if not st or st["binding"] not in ("ACTIVE", "DISABLED"):
                raise LifecycleError("CLD-UPDATE-001", "binding 不可 update（%s）"
                                     % (st["binding"] if st else "ABSENT"))
            if self.artifact_store is None:
                raise LifecycleError("CLD-UPDATE-001", "artifact_store 未注入")
            if manifest is None:
                raise LifecycleError("CLD-UPDATE-001", "缺 manifest")
            self._stage(jp, "staging")
            # 下载 + 全量校验（失败由 acquisition 清理 staging）
            from ..dist import ArtifactAcquisition
            acq = ArtifactAcquisition(
                allowed_prefixes=("file://",),  # 测试夹具；真实环境由 allowlist URL 前缀约束
                staging_root=os.path.join(self.state_root, ".staging"),
                fetcher=fetcher)
            staging = acq.stage(manifest, allowlist, url_for)
            self._stage(jp, "verified")
            # 原子切换 + 失败回滚（store.commit 自带回滚语义）
            self.artifact_store.commit(staging, manifest["revision"])
            self._stage(jp, "committed")
            return self.status(binding_id, note="UPDATED_%s" % manifest["revision"])
        except LifecycleError:
            raise
        finally:
            self._end(jp)

    def disable(self, binding_id):
        """本地立即停用：ACTIVE→DISABLED；session→OFFLINE（禁读写同步）。"""
        op_id, jp = self._begin(binding_id, "disable")
        try:
            st = self.load(binding_id)
            if not st or st["binding"] == "ABSENT":
                raise LifecycleError("CLD-DISABLE-001", "binding 不存在")
            if st["binding"] == "DISABLED":
                return self.status(binding_id, note="ALREADY_DISABLED")
            if st["binding"] not in ("ACTIVE",):
                raise LifecycleError("CLD-DISABLE-001", "当前 %s 不可 disable"
                                     % st["binding"])
            S.check_transition("ACTIVE", "DISABLED")
            st["binding"] = "DISABLED"
            st["session"] = "OFFLINE"          # INV-3：禁止读/写/同步
            st["truth"] = "UNAVAILABLE"        # DISABLED 不得保留任何 Truth 档位
            self.save(binding_id, st)
            return self.status(binding_id)
        except LifecycleError:
            raise
        finally:
            self._end(jp)

    def enable(self, binding_id):
        """启用：重新授权 + 构件检查 + Truth conformance 通过 → ACTIVE。"""
        op_id, jp = self._begin(binding_id, "enable")
        try:
            st = self.load(binding_id)
            if not st or st["binding"] != "DISABLED":
                raise LifecycleError("CLD-ENABLE-001", "仅 DISABLED 可 enable")
            if not self.auth_check(binding_id):
                raise LifecycleError("CLD-ENABLE-001", "重新授权失败")
            if not self.artifact_check(binding_id):
                raise LifecycleError("CLD-ENABLE-001", "构件校验失败")
            # Truth 能力：默认 ADVISORY；仅 conformance 通过且调用方证据齐全才可 ENFORCED
            truth = "ADVISORY"
            if self.conformance(binding_id):
                S.check_enforced_evidence("ENFORCED", conformance_passed=True)
                truth = "ENFORCED"
            S.check_transition("DISABLED", "ACTIVE")
            st["binding"] = "ACTIVE"
            st["session"] = "ONLINE"
            st["truth"] = truth
            self.save(binding_id, st)
            return self.status(binding_id)
        except LifecycleError:
            raise
        finally:
            self._end(jp)

    def uninstall(self, binding_id):
        """卸载：只解绑当前 Binding；其他 binding 状态文件不动。

        幂等：卸载后保留 UNINSTALLED 状态文件（再次卸载 → ALREADY_UNINSTALLED）；
        显式清理走 purge（→ ABSENT）。
        """
        op_id, jp = self._begin(binding_id, "uninstall")
        try:
            st = self.load(binding_id)
            if not st:
                raise LifecycleError("CLD-UNINSTALL-001", "binding 不存在")
            if st["binding"] == "UNINSTALLED":
                return {"binding": "UNINSTALLED", "note": "ALREADY_UNINSTALLED"}
            S.check_transition(st["binding"], "UNINSTALLING")
            st["binding"] = "UNINSTALLING"
            st["session"] = "OFFLINE"
            st["truth"] = "UNAVAILABLE"   # INV-6：卸载路径先撤 Truth
            self.save(binding_id, st)
            # 只解绑当前 binding：状态置 UNINSTALLED（其他 binding 零影响）
            st["binding"] = "UNINSTALLED"
            st["session"] = "OFFLINE"
            st["truth"] = "UNAVAILABLE"
            self.save(binding_id, st)
            return {"binding": "UNINSTALLED", "binding_id": binding_id,
                    "note": "UNINSTALLED"}
        except LifecycleError:
            raise
        finally:
            self._end(jp)

    def purge(self, binding_id):
        """【内部测试能力，非用户六动作语义】清理已卸载 Binding 的状态文件。

        边界（Gate 3 裁决复核④）：purge 仅用于**临时 home 测试清理**；
        不属于默认六动作（install/repair/update/disable/enable/uninstall）语义。
        默认 uninstall 只解绑当前 Agent 并保留 UNINSTALLED 状态（幂等可识别）；
        purge 删除该状态文件（→ ABSENT）。若未来作为用户可调用的真实删除操作，
        必须退出当前 R3 验收范围并另行授权（本实现不作真实环境调用）。
        本方法不触碰 canonical memory、共享 Core 或其他 Binding 状态文件。
        """
        st = self.load(binding_id)
        if not st:
            return {"binding": "ABSENT", "note": "ALREADY_ABSENT"}
        if st["binding"] != "UNINSTALLED":
            raise LifecycleError("CLD-UNINSTALL-001",
                                 "仅 UNINSTALLED 可 purge（当前 %s）" % st["binding"])
        # P0-1：清理两文件（state.json 三轴 + binding.json manifest）→ 完整 ABSENT
        for p in (self._state_path(binding_id),
                  self._manifest_path(binding_id)):
            if os.path.isfile(p):
                os.remove(p)
        return {"binding": "ABSENT", "binding_id": binding_id, "note": "PURGED"}

    # ---- 查询 ----
    def status(self, binding_id, note=None):
        st = self.load(binding_id)
        if not st:
            return {"binding": "ABSENT", "session": "OFFLINE",
                    "truth": "UNAVAILABLE", "binding_id": binding_id,
                    "note": note}
        st["note"] = note
        return st

    # ---- 操作 gate（INV-3：disable 后禁止读/写/同步） ----
    def assert_operations_allowed(self, binding_id, operation):
        """读/写/同步前调用。DISABLED 或 UNINSTALLED → 拒绝。"""
        st = self.load(binding_id)
        if not st:
            raise LifecycleError("CLD-DISABLE-001", "binding 不存在")
        if st["binding"] == "DISABLED":
            raise LifecycleError(
                "CLD-DISABLE-001",
                "%s 被拒绝：binding 已 DISABLED（禁止读/写/同步）" % operation)
        if st["binding"] == "UNINSTALLED":
            raise LifecycleError(
                "CLD-UNINSTALL-001",
                "%s 被拒绝：binding 已 UNINSTALLED" % operation)
        if st["session"] not in ("ONLINE", "DEGRADED"):
            raise LifecycleError(
                "CLD-DISABLE-001", "%s 被拒绝：session=%s" % (operation, st["session"]))
        return True
