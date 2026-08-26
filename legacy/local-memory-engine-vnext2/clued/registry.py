# -*- coding: utf-8 -*-
"""Agent Registry（协议 §4.1 / §5.3）。

- 管理逐 Agent Binding，不存放明文凭据；
- 同节点不同智能体必须不同 binding（不可共享逻辑身份，§1.2）；
- 幂等安装：同 Agent 已有健康 Binding → ALREADY_INSTALLED；
  可修复 → 事务性 repair；同 Agent 多 Binding → BINDING_CONFLICT（§6.5）。
"""

import glob
import json
import os

from . import errors
from . import manifests
from .auth.policy import UPGRADE_POLICY
from .locking import CrossProcessLock
from .paths import RuntimePaths


class AgentRegistry(object):
    def __init__(self, paths, audit=None):
        self.paths = paths  # RuntimePaths
        self.audit = audit

    # ---- ADR-CLD-003：clued-v0.1.0 遗留 Binding 保守迁移 ----
    def _migrate_auth_policy(self, binding):
        """Binding manifest 无 auth_policy 字段（clued-v0.1.0 遗留）→ 保守迁移
        strict（1h），绝不静默放宽到 6h。幂等：迁移后字段存在，不再重复写/审计。
        """
        if "auth_policy" in binding:
            return binding
        binding["auth_policy"] = UPGRADE_POLICY
        self.save_binding(binding)
        if self.audit is not None:
            self.audit.append(
                "policy_migrated", binding_id=binding.get("binding_id"),
                result_code=UPGRADE_POLICY.upper(),
                metadata={"from": "legacy-clued-v0.1.0", "to": "strict",
                          "reason": "conservative-upgrade-no-permission-expand"})
        return binding

    # ---- node manifest ----
    def load_node(self):
        if not os.path.isfile(self.paths.node_manifest):
            return None
        node = manifests.read_json(self.paths.node_manifest)
        ok, err = manifests.validate_node_manifest(node)
        if not ok:
            raise errors.CluedError("CLD-SEC-001",
                                    "node manifest 损坏: %s" % err)
        return node

    def save_node(self, node):
        manifests.atomic_write_json(self.paths.node_manifest, node)

    def create_or_load_node(self, node_id):
        node = self.load_node()
        if node is None:
            node = manifests.build_node_manifest(node_id)
            self.save_node(node)
            return node, True
        return node, False

    # ---- bindings ----
    def list_bindings(self, include_revoked=False):
        out = []
        bindings_root = self.paths._p("bindings")
        if not os.path.isdir(bindings_root):
            return out
        for entry in os.listdir(bindings_root):
            bpath = os.path.join(bindings_root, entry)
            if not os.path.isdir(bpath) or entry.startswith("."):
                continue
            mpath = os.path.join(bpath, "binding.json")
            if not os.path.isfile(mpath):
                continue
            try:
                binding = manifests.read_json(mpath)
                ok, err = manifests.validate_binding_manifest(binding)
                if not ok:
                    binding = {"binding_id": entry, "corrupt": err}
            except Exception as exc:  # 损坏清单不得静默
                binding = {"binding_id": entry, "corrupt": str(exc)}
            if binding.get("corrupt"):
                binding["status"] = "CORRUPT"
                out.append(binding)
                continue
            if not include_revoked and binding.get("status") != "ACTIVE":
                continue
            self._migrate_auth_policy(binding)
            out.append(binding)
        out.sort(key=lambda b: b.get("installed_at") or "")
        return out

    def load_binding(self, binding_id):
        mpath = self.paths.binding_manifest(binding_id)
        if not os.path.isfile(mpath):
            return None
        binding = manifests.read_json(mpath)
        ok, err = manifests.validate_binding_manifest(binding)
        if not ok:
            raise errors.CluedError("CLD-AUTH-004",
                                    "binding 清单完整性失败: %s" % err)
        if binding.get("binding_id") != binding_id:
            raise errors.CluedError("CLD-AUTH-004",
                                    "binding_id 与清单不符")
        self._migrate_auth_policy(binding)
        return binding

    def load_binding_loose(self, binding_id):
        """卸载路径用：损坏清单也要能读到原始内容做精确清理。"""
        mpath = self.paths.binding_manifest(binding_id)
        if not os.path.isfile(mpath):
            return None
        try:
            return manifests.read_json(mpath)
        except Exception:
            return {"binding_id": binding_id, "corrupt": True}

    def find_by_agent(self, agent_type, agent_instance_label):
        """按 (agent_type, agent_instance_label) 查找 ACTIVE Binding 列表。"""
        found = []
        for b in self.list_bindings():
            if b.get("agent_type") == agent_type and \
                    b.get("agent_instance_label") == agent_instance_label:
                found.append(b)
        return found

    def save_binding(self, binding):
        d = self.paths.binding_dir(binding["binding_id"])
        if not os.path.isdir(d):
            os.makedirs(d)
        manifests.atomic_write_json(
            self.paths.binding_manifest(binding["binding_id"]), binding)

    # P0-1 裁决（2026-08-20）：安装事务必须原子创建
    # bindings/<id>/binding.json（Clued manifest）+ bindings/<id>/state.json（三轴）。
    def save_binding_with_state(self, binding, state):
        """安装事务原子双写：manifest 与三轴 state 一起创建，任一失败回滚到 ABSENT。"""
        d = self.paths.binding_dir(binding["binding_id"])
        mpath = self.paths.binding_manifest(binding["binding_id"])
        spath = os.path.join(d, "state.json")
        if os.path.isfile(mpath) or os.path.isfile(spath):
            raise errors.CluedError(
                "CLD-INSTALL-001",
                "目标文件已存在（binding_id=%s），禁止覆盖创建（幂等由上层处理）"
                % binding["binding_id"])
        os.makedirs(d, exist_ok=True)
        m_tmp = mpath + ".tmp"
        s_tmp = spath + ".tmp"
        try:
            with open(m_tmp, "w", encoding="utf-8") as f:
                json.dump(binding, f, ensure_ascii=False, indent=1)
                f.flush()
            with open(s_tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=1)
                f.flush()
            os.replace(m_tmp, mpath)
            try:
                os.replace(s_tmp, spath)
            except BaseException:
                if os.path.isfile(mpath):
                    os.remove(mpath)  # 回滚 manifest，保持 ABSENT（无半创建）
                raise
        finally:
            for p in (m_tmp, s_tmp):
                if os.path.isfile(p):
                    os.remove(p)
        return binding

    def artifact_checks(self, binding):
        """校验 installed_artifacts 的 sha256 与路径（协议 §12.2.8 / §15.3）。

        返回 (匹配列表, 不匹配列表)。路径必须位于 binding 目录内、且不是符号链接。
        """
        bdir = self.paths.binding_dir(binding["binding_id"])
        matched, mismatched = [], []
        for art in binding.get("installed_artifacts") or []:
            p = os.path.abspath(art["path"])
            real_bdir = os.path.realpath(bdir)
            real_p = os.path.realpath(p)
            if not (real_p == real_bdir or
                    real_p.startswith(real_bdir + os.sep)):
                mismatched.append({**art, "reason": "path_outside_binding"})
                continue
            if os.path.islink(p):
                mismatched.append({**art, "reason": "symlink_refused"})
                continue
            if not os.path.isfile(p):
                mismatched.append({**art, "reason": "missing"})
                continue
            if manifests.sha256_file(p) != art.get("sha256"):
                mismatched.append({**art, "reason": "sha256_mismatch"})
                continue
            matched.append(art)
        return matched, mismatched

    def artifact_paths(self, binding):
        return [a["path"] for a in binding.get("installed_artifacts") or []]

    def binding_count(self):
        return len([b for b in self.list_bindings()
                    if b.get("status") == "ACTIVE"])

    def update_node_binding_count(self):
        node = self.load_node()
        if node is None:
            return
        count = self.binding_count()
        if node.get("binding_count") != count:
            node["binding_count"] = count
            self.save_node(node)
