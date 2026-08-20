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

    # ---- 持久化（R2：单一规范写入 bindings/<id>/binding.json；扁平仅受控迁移兼容读） ----
    def _safe_id(self, binding_id):
        import re
        return re.sub(r"[^A-Za-z0-9._-]", "_", binding_id)

    def _dir_path(self, binding_id):
        """正式生命周期布局：<state_root>/<safe_id>/binding.json"""
        return os.path.join(self.state_root, self._safe_id(binding_id))

    def _flat_path(self, binding_id):
        """旧扁平布局（仅受控迁移兼容读，不写入）：<state_root>/<safe_id>.json"""
        return os.path.join(self.state_root, "%s.json" % self._safe_id(binding_id))

    def _path(self, binding_id):
        """当前生效的物理路径（目录布局优先；返回 (path, layout)）。"""
        d = self._dir_path(binding_id)
        canonical = os.path.join(d, "binding.json")
        flat = self._flat_path(binding_id)
        has_dir = os.path.isfile(canonical)
        has_flat = os.path.isfile(flat)
        if has_dir and has_flat:
            raise LifecycleError(
                "CLD-LAYOUT-001",
                "双格式冲突：%s 与 %s 同时存在（fail-closed，禁止猜测/自动合并）"
                % (canonical, flat))
        if has_dir:
            return canonical, "directory"
        if has_flat:
            return flat, "flat-migration"  # 受控迁移兼容读（不写回）
        return canonical, "directory"  # 写入一律走正式布局

    def load(self, binding_id):
        try:
            p, layout = self._path(binding_id)
        except LifecycleError:
            raise
        if not os.path.isfile(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            st = json.load(f)
        st["_layout"] = layout  # 记录读取布局（directory / flat-migration）
        return st

    def save(self, binding_id, st):
        st = dict(st)
        st["binding_id"] = binding_id
        st["updated_at"] = time.time()
        p, layout = self._path(binding_id)  # 双格式冲突在此 fail-closed
        if layout == "flat-migration":
            # 扁平仅受控迁移兼容读；写入一律走正式布局。
            # 若仅存在扁平文件，必须先迁移（CLD-LAYOUT-002：禁止写扁平）。
            raise LifecycleError(
                "CLD-LAYOUT-002",
                "扁平布局需先迁移（binding_id=%s）；禁止写扁平文件" % binding_id)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
            f.flush()
        os.replace(tmp, p)
        # 写入正式布局后：若存在旧扁平文件，保留（迁移由迁移工具处理，
        # 不在常规写入路径中静默删除——但写入即产生双格式 → 下次读写 fail-closed）
        return st

    # ---- 枚举（对齐 clued list_bindings：仅目录布局） ----
    def list_bindings(self):
        """枚举正式布局 Binding（bindings/<id>/binding.json）。"""
        out = []
        if not os.path.isdir(self.state_root):
            return out
        for entry in sorted(os.listdir(self.state_root)):
            if entry.startswith(".") or entry.endswith(".json"):
                continue  # 跳过点文件（lock/journal）与扁平文件
            bpath = os.path.join(self.state_root, entry)
            if not os.path.isdir(bpath):
                continue
            mpath = os.path.join(bpath, "binding.json")
            if not os.path.isfile(mpath):
                continue
            try:
                with open(mpath, "r", encoding="utf-8") as f:
                    out.append(json.load(f))
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
    def install(self, binding_id):
        op_id, jp = self._begin(binding_id, "install")
        try:
            st = self.load(binding_id)
            if st:
                if st["binding"] in ("ACTIVE", "DISABLED"):
                    # R1 修复（裁决 2026-08-20）：幂等成功返回也必须 _end(jp)，
                    # 否则 journal 泄漏（试装暴露缺陷 controller.py:129）
                    self._end(jp)
                    return self.status(binding_id, note="ALREADY_INSTALLED")
                if st["binding"] == "BROKEN":
                    raise LifecycleError("CLD-INSTALL-001", "binding 处于 BROKEN，请先 repair/uninstall")
            S.check_transition("ABSENT", "INSTALLING")
            new_st = S.new_state(binding="INSTALLING", session="ONLINE",
                                 truth="UNAVAILABLE")
            self.save(binding_id, new_st)
            self._stage(jp, "installing")
            # 安装后默认 ADVISORY（未做 conformance，不得 ENFORCED）
            new_st = S.new_state(binding="ACTIVE", session="ONLINE", truth="ADVISORY")
            self.save(binding_id, new_st)
            self._end(jp)
            return self.status(binding_id)
        except LifecycleError:
            self._end(jp)
            raise

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
                self._end(jp)
                return self.status(binding_id)
            raise LifecycleError("CLD-REPAIR-001", "当前状态 %s 不可 repair" % cur)
        except LifecycleError:
            self._end(jp)
            raise

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
            self._end(jp)
            return self.status(binding_id, note="UPDATED_%s" % manifest["revision"])
        except LifecycleError:
            self._end(jp)
            raise

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
            self._end(jp)
            return self.status(binding_id)
        except LifecycleError:
            self._end(jp)
            raise

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
            self._end(jp)
            return self.status(binding_id)
        except LifecycleError:
            self._end(jp)
            raise

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
            self._end(jp)
            return {"binding": "UNINSTALLED", "binding_id": binding_id,
                    "note": "UNINSTALLED"}
        except LifecycleError:
            self._end(jp)
            raise

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
        p, _layout = self._path(binding_id)
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
