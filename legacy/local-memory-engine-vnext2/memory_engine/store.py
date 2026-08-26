# -*- coding: utf-8 -*-
"""Object Store：memory/objects/*.json 的读写基础能力（Phase 2）。

职责边界：
- 只做文件级读写与路径安全（id → 文件名的严格净化，防 ../ 逃逸）
- 不做语义决策（去重/冲突/生命周期在 write_engine）
- 不做 git 操作（提交/推送仍走 Git Sync Layer）
- 写路径做凭据样值扫描（guards.json 模式），拒绝令牌进入记忆对象
"""

import json
import os
import re
import secrets

from . import paths
from . import schema as S

# ---- 路径安全 ----
_ID_RE = re.compile(r"^mem_[0-9a-z]{8,16}$")


def safe_id(oid):
    """校验 id 并返回纯基名；非法返回 None（防路径逃逸）。"""
    if not isinstance(oid, str) or not _ID_RE.match(oid):
        return None
    return oid


def object_path(oid):
    name = safe_id(oid)
    if not name:
        raise ValueError("非法 memory id: %r" % (oid,))
    return os.path.join(paths.OBJECTS_DIR, name + ".json")


def ensure_dirs():
    os.makedirs(paths.OBJECTS_DIR, exist_ok=True)
    os.makedirs(paths.AUDIT_DIR, exist_ok=True)
    os.makedirs(paths.SESSION_DIR, exist_ok=True)


def new_id():
    """生成全局唯一 id（mem_ + 8 位 hex，存在性冲突时重试）。"""
    for _ in range(100):
        oid = "mem_" + secrets.token_hex(4)
        if not os.path.exists(object_path(oid)):
            return oid
    raise RuntimeError("无法分配唯一 memory id")


# ---- 原子写 ----
def _atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def dumps(obj, indent=2):
    return json.dumps(obj, ensure_ascii=False, indent=indent) + "\n"


def save_object(obj):
    """写入对象文件（原子替换）。调用方须先 validate_object。"""
    ensure_dirs()
    oid = safe_id(obj.get("id"))
    if not oid:
        raise ValueError("非法 memory id: %r" % (obj.get("id"),))
    _atomic_write(object_path(oid), dumps(obj))
    return object_path(oid)


def load_object(oid):
    path = object_path(oid)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def list_object_ids():
    ensure_dirs()
    ids = []
    for name in sorted(os.listdir(paths.OBJECTS_DIR)):
        if name.endswith(".json") and _ID_RE.match(name[:-5]):
            ids.append(name[:-5])
    return ids


def load_all_objects(include_invalid=False):
    """加载全部对象。默认跳过无法解析/校验失败的文件（doctor 单独报告）。"""
    objs = []
    for oid in list_object_ids():
        obj = load_object(oid)
        if obj is None:
            continue
        ok, _ = S.validate_object(obj)
        if ok or include_invalid:
            objs.append(obj)
    return objs


# ---- 凭据样值扫描（引擎写路径 + doctor #11 forbidden secrets）----
def load_secret_patterns():
    """guards.json 单一事实源；缺失回落内置默认（与 sync-memory.py 同源）。"""
    guards_path = os.path.join(paths.REPO, "guards.json")
    try:
        with open(guards_path, "r", encoding="utf-8") as fh:
            guards = json.load(fh)
        pats = guards.get("secret_patterns")
        if isinstance(pats, list) and pats:
            return pats
    except Exception:
        pass
    return [
        r"gh[op]_[A-Za-z0-9]{20,}",
        r"github_pat_[A-Za-z0-9_]{20,}",
        r"AKIA[0-9A-Z]{16}",
        r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        r"(?i)bearer\s+[A-Za-z0-9._-]{20,}",
    ]


def find_secret_in_object(obj):
    """扫描对象全部文本值；命中返回 (字段名)，否则 None。"""
    text = json.dumps(obj, ensure_ascii=False)
    for pat in load_secret_patterns():
        if re.search(pat, text):
            return True
    return False


def scan_objects_for_secrets():
    """扫描 memory/objects/ 全部对象；返回命中文件列表。"""
    hits = []
    for oid in list_object_ids():
        obj = load_object(oid)
        if obj is not None and find_secret_in_object(obj):
            hits.append(os.path.join("memory", "objects", oid + ".json"))
    return hits
