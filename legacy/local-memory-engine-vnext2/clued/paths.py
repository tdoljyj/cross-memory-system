# -*- coding: utf-8 -*-
"""路径解析（协议 §5.5）。

<clued_runtime_root> 解析优先级：
    1. 环境变量 CROSS_MEMORY_CLUED_ROOT（测试/特殊场景显式覆盖）
    2. <仓库根>/sync.config.json 的 clued_runtime_root 字段（经既有
       bootstrap/config 解析，满足协议 §5.5 的 MUST）
    3. <仓库根>/.clued（缺省，不硬编码用户目录）

仓库根（Canonical Store 克隆）经 memory_engine.paths.resolve_repo() 解析
（与 Memory Engine 一致：env CROSS_MEMORY_REPO > sync.config.json repo >
包所在克隆 > cwd 含 memory/index.json）。
运行时根不得被默认推送到 Canonical Store（.gitignore 含 .clued/）。
"""

import json
import os

from memory_engine import paths as engine_paths

RUNTIME_ROOT_NAME = ".clued"


def resolve_repo(explicit=None):
    """既有 bootstrap/config 解析仓库根（复用 Memory Engine 的解析器）。"""
    return engine_paths.resolve_repo(explicit)


def _load_runtime_from_config(repo):
    cfg_path = os.path.join(repo, "sync.config.json")
    if not os.path.isfile(cfg_path):
        return None
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        root = cfg.get("clued_runtime_root")
        if isinstance(root, str) and root:
            return os.path.abspath(os.path.expanduser(root))
    except Exception:
        pass
    return None


def resolve_runtime_root(repo=None, explicit=None):
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    env = os.environ.get("CROSS_MEMORY_CLUED_ROOT")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    repo = repo or resolve_repo()
    cfg_root = _load_runtime_from_config(repo)
    if cfg_root:
        return cfg_root
    return os.path.join(repo, RUNTIME_ROOT_NAME)


class RuntimePaths(object):
    """运行时根内的逻辑布局（§5.5 + 实现扩展）。"""

    def __init__(self, root):
        self.root = os.path.abspath(os.path.expanduser(root))

    def _p(self, *parts):
        return os.path.join(self.root, *parts)

    @property
    def node_manifest(self):
        return self._p("node.json")

    def binding_dir(self, binding_id):
        return self._p("bindings", binding_id)

    def binding_manifest(self, binding_id):
        return self._p("bindings", binding_id, "binding.json")

    def revoked_dir(self):
        return self._p("bindings", ".revoked")

    def auth_cache(self, binding_id):
        return self._p("auth", "%s.json" % binding_id)

    def pending_file(self, operation_id):
        return self._p("pending", "%s.json" % operation_id)

    def pending_dir(self):
        return self._p("pending")

    def payload_ref_file(self, operation_id):
        return self._p("pending-refs", "%s.json" % operation_id)

    def payload_refs_dir(self):
        return self._p("pending-refs")

    def orphan_payload_dir(self):
        return self._p("pending-refs", "orphans")

    def conflict_dir(self, conflict_id):
        return self._p("conflicts", conflict_id)

    def runtime_state(self):
        return self._p("state", "runtime.json")

    def sessions_dir(self):
        return self._p("state", "sessions")

    def session_file(self, session_id):
        return self._p("state", "sessions", "%s.json" % session_id)

    def revoke_queue_dir(self):
        return self._p("state", "revoke-queue")

    def revoke_task(self, task_id):
        return self._p("state", "revoke-queue", "%s.json" % task_id)

    def exports_dir(self):
        return self._p("exports")

    def audit_log(self):
        return self._p("audit", "events.jsonl")

    def locks_dir(self):
        return self._p("locks")

    def staging_dir(self):
        return self._p("staging")

    def staging_txn(self, txn_id):
        return self._p("staging", txn_id)

    def ensure_dirs(self):
        for d in (self.root, self._p("bindings"), self._p("auth"),
                  self._p("pending"), self._p("pending-refs"),
                  self._p("conflicts"),
                  self._p("state", "sessions"), self._p("state", "revoke-queue"),
                  self._p("audit"), self._p("locks"), self._p("staging"),
                  self._p("exports")):
            if not os.path.isdir(d):
                os.makedirs(d)
