# -*- coding: utf-8 -*-
"""路径解析：定位 Canonical Store 克隆根目录（REPO）。

优先级（对齐 sync-memory.py 的 fail-safe 精神）：
    1. 环境变量 CROSS_MEMORY_REPO（测试/特殊场景显式覆盖）
    2. <仓库根>/sync.config.json 的 repo 字段（与同步层共用配置）
    3. 包所在克隆根（memory_engine/ 的上级目录）
    4. 当前工作目录（若其下存在 memory/index.json）

Memory Engine 只在本端克隆内读写；绝不指向他端工作区/克隆。
"""

import json
import os

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_ROOT = os.path.dirname(_PKG_DIR)  # 包上级 = 克隆根


def _load_repo_from_config(root):
    cfg_path = os.path.join(root, "sync.config.json")
    if not os.path.isfile(cfg_path):
        return None
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        repo = cfg.get("repo")
        if isinstance(repo, str) and repo:
            return os.path.expanduser(repo)
    except Exception:
        pass
    return None


def looks_like_repo(path):
    """克隆根判定：存在 memory/index.json（同步层唯一事实源）。"""
    if not path:
        return False
    return os.path.isfile(os.path.join(path, "memory", "index.json"))


def resolve_repo(explicit=None):
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    env = os.environ.get("CROSS_MEMORY_REPO")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    cfg_repo = _load_repo_from_config(_DEFAULT_ROOT)
    if cfg_repo and looks_like_repo(cfg_repo):
        return cfg_repo
    if looks_like_repo(_DEFAULT_ROOT):
        return _DEFAULT_ROOT
    cwd = os.getcwd()
    if looks_like_repo(cwd):
        return cwd
    return _DEFAULT_ROOT


REPO = resolve_repo()

MEMORY_DIR = os.path.join(REPO, "memory")
OBJECTS_DIR = os.path.join(MEMORY_DIR, "objects")
AUDIT_DIR = os.path.join(MEMORY_DIR, "audit")
SESSION_DIR = os.path.join(MEMORY_DIR, "session")
OBJECT_INDEX_PATH = os.path.join(MEMORY_DIR, "object-index.json")
RECALL_INDEX_PATH = os.path.join(MEMORY_DIR, "index.json")
AUDIT_LOG_PATH = os.path.join(AUDIT_DIR, "audit.log")


def set_repo(path):
    """运行时切换 REPO（测试用）：返回切换后的 REPO。"""
    global REPO, MEMORY_DIR, OBJECTS_DIR, AUDIT_DIR, SESSION_DIR
    global OBJECT_INDEX_PATH, RECALL_INDEX_PATH, AUDIT_LOG_PATH
    REPO = os.path.abspath(os.path.expanduser(path))
    MEMORY_DIR = os.path.join(REPO, "memory")
    OBJECTS_DIR = os.path.join(MEMORY_DIR, "objects")
    AUDIT_DIR = os.path.join(MEMORY_DIR, "audit")
    SESSION_DIR = os.path.join(MEMORY_DIR, "session")
    OBJECT_INDEX_PATH = os.path.join(MEMORY_DIR, "object-index.json")
    RECALL_INDEX_PATH = os.path.join(MEMORY_DIR, "index.json")
    AUDIT_LOG_PATH = os.path.join(AUDIT_DIR, "audit.log")
    return REPO
