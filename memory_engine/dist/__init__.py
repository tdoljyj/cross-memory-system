# -*- coding: utf-8 -*-
"""Artifact Distribution 模块（R3-D01~D03，ADR-R3-003）。

子模块：
- manifest   ：R3-D01 Artifact Manifest & Trust（分类/固定 revision/allowlist/hash/大小/兼容）
- acquisition：R3-D02 Artifact Acquisition（受限下载/staging/单飞锁/续传/重试/全量校验/清理）
- store      ：R3-D03 Atomic Artifact Store（verified staging 提交/原子切换/回滚/residue）

边界（Gate 1 裁决）：
- 不下载任何真实产品 artifact；测试一律走受控夹具（file:// 或注入 fetcher）；
- 不触碰 Embedding 模型（model 条目入 product manifest 即拒绝）；
- 不执行真实安装/停用/卸载（本模块只负责 artifact 获取与存储）。
"""

from .manifest import (
    Allowlist, ManifestValidator, ManifestError, sha256_file, build_manifest,
    ARTIFACT_CLASSES, MANIFEST_SCHEMA_VERSION, ALLOWLIST_SCHEMA_VERSION,
)
from .acquisition import ArtifactAcquisition, AcquisitionError
from .store import AtomicArtifactStore, StoreError

__all__ = [
    "Allowlist", "ManifestValidator", "ManifestError", "sha256_file",
    "build_manifest", "ARTIFACT_CLASSES", "MANIFEST_SCHEMA_VERSION",
    "ALLOWLIST_SCHEMA_VERSION",
    "ArtifactAcquisition", "AcquisitionError",
    "AtomicArtifactStore", "StoreError",
]
