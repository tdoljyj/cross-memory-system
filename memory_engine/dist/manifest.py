# -*- coding: utf-8 -*-
"""R3-D01 Artifact Manifest & Trust（ADR-R3-003 §2）。

- 版本化 manifest：schema_version / manifest_type / release_id / revision /
  artifacts[]（path/sha256/size_bytes/max_size_bytes/platforms/agent_types/
  protocol_min/protocol_max）/ trust；
- artifact 分类：product / adapter / binding-config / model / documentation；
- 固定 revision：禁止 latest；revision 必须匹配 allowlist；
- 每 artifact：SHA-256 格式、大小上限、平台/Agent/协议兼容矩阵；
- trust evidence：allowlist 根信任链（allowlist → manifest → artifact）；
- 模型隔离：model 条目出现在 product manifest = 校验失败（DIST_MODEL_MIX）。
"""

import hashlib
import json
import os
import re

MANIFEST_SCHEMA_VERSION = 1
ALLOWLIST_SCHEMA_VERSION = 1

ARTIFACT_CLASSES = ("product", "adapter", "binding-config", "model", "documentation")

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# 稳定错误码（ADR-R3-003 §6 草案）
ERR_MODEL_MIX = "CLD-DIST-001"
ERR_HASH_FORMAT = "CLD-DIST-001"
ERR_SIZE = "CLD-DIST-001"
ERR_COMPAT = "CLD-DIST-001"
ERR_REVISION = "CLD-DIST-001"
ERR_NOT_ALLOWLISTED = "CLD-DIST-002"


class ManifestError(Exception):
    def __init__(self, code, detail=""):
        super(ManifestError, self).__init__("%s: %s" % (code, detail))
        self.code = code
        self.detail = detail


class Allowlist(object):
    """根信任白名单：{revision: {path: sha256}}。

    校验链：allowlist → manifest(revision) → artifact(path+sha256)。
    """

    def __init__(self, entries=None):
        # entries: {revision: {path: sha256}}
        self._entries = entries or {}

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("schema_version") != ALLOWLIST_SCHEMA_VERSION:
            raise ManifestError(ERR_NOT_ALLOWLISTED, "allowlist schema 不匹配")
        entries = data.get("allowlist", {})
        return cls(entries)

    def verify(self, revision, path, sha256):
        """revision + path 必须在白名单且 hash 一致；否则抛 ERR_NOT_ALLOWLISTED。"""
        rev_entries = self._entries.get(revision)
        if not rev_entries:
            raise ManifestError(ERR_NOT_ALLOWLISTED,
                                "revision %s 不在 allowlist" % revision)
        expected = rev_entries.get(path)
        if not expected:
            raise ManifestError(ERR_NOT_ALLOWLISTED, "path %s 不在 allowlist" % path)
        if expected != sha256:
            raise ManifestError(ERR_NOT_ALLOWLISTED,
                                "sha256 不符: %s (expected %s)" % (sha256[:12], expected[:12]))
        return True


class ManifestValidator(object):

    def validate(self, manifest, allowlist=None):
        """校验 manifest。通过返回 manifest；否则抛 ManifestError。

        覆盖：schema / manifest_type / revision / 固定 revision / 分类 /
        hash 格式 / 大小 / 兼容矩阵 / 模型混入 / allowlist 根信任。
        """
        if not isinstance(manifest, dict):
            raise ManifestError(ERR_REVISION, "manifest 非对象")
        if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
            raise ManifestError(ERR_REVISION, "manifest schema_version 不匹配")
        mtype = manifest.get("manifest_type")
        if mtype not in ARTIFACT_CLASSES:
            raise ManifestError(ERR_REVISION, "manifest_type 非法: %r" % mtype)
        revision = manifest.get("revision")
        if not revision or revision == "latest":
            raise ManifestError(ERR_REVISION, "禁止 latest / 空 revision")
        release_id = manifest.get("release_id")
        if not release_id:
            raise ManifestError(ERR_REVISION, "缺 release_id")
        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            raise ManifestError(ERR_REVISION, "缺 artifacts 列表")

        # 模型隔离：product manifest 内出现 model 条目 → 拒绝
        if mtype == "product":
            for a in artifacts:
                cls = a.get("class", "product")
                if cls == "model":
                    raise ManifestError(ERR_MODEL_MIX,
                                        "product manifest 混入 model artifact: %s"
                                        % a.get("path"))

        for a in artifacts:
            self._validate_artifact(a)
            if allowlist is not None:
                allowlist.verify(revision, a["path"], a["sha256"])
        return manifest

    def _validate_artifact(self, a):
        path = a.get("path")
        if not path or path.startswith("/") or ".." in path.split("/"):
            raise ManifestError(ERR_HASH_FORMAT, "path 非法: %r" % path)
        sha = a.get("sha256")
        if not sha or not SHA256_RE.match(sha):
            raise ManifestError(ERR_HASH_FORMAT, "sha256 格式非法: %r" % sha)
        size = a.get("size_bytes")
        max_size = a.get("max_size_bytes")
        if not isinstance(size, int) or size < 0:
            raise ManifestError(ERR_SIZE, "size_bytes 非法")
        if max_size is not None and size > max_size:
            raise ManifestError(ERR_SIZE, "%s 超过大小上限 %d" % (path, max_size))
        # 平台/Agent/协议兼容（有声明才校验格式）
        for field in ("platforms", "agent_types"):
            if field in a and not isinstance(a[field], list):
                raise ManifestError(ERR_COMPAT, "%s 字段必须为列表" % field)
        pmax = a.get("protocol_max")
        if pmax is not None and a.get("protocol_min") and pmax < a["protocol_min"]:
            raise ManifestError(ERR_COMPAT, "protocol_min > protocol_max")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(release_id, revision, artifacts, manifest_type="product"):
    """构造带 trust 字段的 manifest（artifacts 已含 sha256/size）。"""
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "manifest_type": manifest_type,
        "release_id": release_id,
        "revision": revision,
        "created_at_utc": None,  # 由调用方填写
        "artifacts": artifacts,
        "trust": {"root": "local-allowlist", "signature": None},
    }
