# -*- coding: utf-8 -*-
"""Agent Registry（协议 §4.1 / §5.3）。

- 管理逐 Agent Binding，不存放明文凭据；
- 同节点不同智能体必须不同 binding（不可共享逻辑身份，§1.2）；
- 幂等安装：同 Agent 已有健康 Binding → ALREADY_INSTALLED；
  可修复 → 事务性 repair；同 Agent 多 Binding → BINDING_CONFLICT（§6.5）。
"""

import glob
import os

from . import errors
from . import manifests
from .locking import CrossProcessLock
from .paths import RuntimePaths


class AgentRegistry(object):
    def __init__(self, paths, audit=None):
        self.paths = paths  # RuntimePaths
        self.audit = audit

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
