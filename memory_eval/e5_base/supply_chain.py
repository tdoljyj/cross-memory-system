# -*- coding: utf-8 -*-
"""E5-base 供应链守卫（R1A 冻结，产品所有者裁决 2026-08-22 授权；
R2A 勘误 2026-08-22 更新锁 digest pin；R3A 勘误 2026-08-22 修正
LOCK_FROZEN_COMMIT provenance，锁字节与 digest pin 零变化）。

可信根 = 修正后候选锁 ``docs/r4-gate0/locks/e5-base-candidate-lock.json``：
- 整文件 SHA-256 在代码内 pin（EXPECTED_LOCK_SHA256 = 66e1ab24…，
  R2A 勘误后锁字节；任何锁字节变化 = LOCK_DIGEST_MISMATCH）
- 守卫链 = 修正后候选锁 ↔ manifest ↔ 磁盘字节（三方逐字段一致，
  不再以模块内硬编码文件哈希为独立真值源）
- build_manifest() 的白名单直接从锁 files 生成（锁 digest 先验证），
  不产生任何 lock_discrepancy 字段
- verify_model_manifest() 读取并验证候选锁，manifest 携带任何
  lock_discrepancy 字段一律拒绝（无任何例外豁免路径）
- manifest schema v2：新增 candidate_lock_sha256 字段（manifest 显式
  锚定其所依据的锁字节；v1 manifest 一律拒绝，防止旧形态复活）

本模块零第三方依赖（不 import torch / transformers / numpy），
可独立审计与测试（tests/test_e5_base_supply_chain.py，纯标准库可重放）。
"""

import hashlib
import importlib.metadata
import json
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))

# ---- 运行合同（与 E5-small adapter 逐项相同，唯一差异 dimension 384 -> 768）----
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "
DIMENSION = 768
MAX_LENGTH = 512
QUERY_BATCH = 1
PASSAGE_BATCH = 32

MANIFEST_FILENAME = "MODEL-MANIFEST.json"
MANIFEST_SCHEMA_VERSION = 2
MODEL_ID = "intfloat/multilingual-e5-base"
IMMUTABLE_REVISION = "d128750597153bb5987e10b1c3493a34e5a4502a"

# ---- 候选锁 pin（R1A 冻结；R2A 勘误更新 digest；R3A 勘误修正 provenance）----
LOCK_RELATIVE_PATH = "docs/r4-gate0/locks/e5-base-candidate-lock.json"
# LOCK_FROZEN_COMMIT = 当前锁字节（66e1ab24…）首次实际进入仓库的提交
# （R3A 勘误 2026-08-22 修正 provenance）。
# 勘误前该常量为 baa9bb6（R1A 时代锚点），但 baa9bb6 中的锁字节是
# 勘误前旧锁（其 digest 见 tests 与 e5-base-r3a-erratum.json，
# 防残留断言禁止在本文件写出该旧 digest 字面量）；R2A 更新锁字节后
# 未同步移动该锚点，导致 R2B manifest 的 trust_root 出现
# 「baa9bb6 + 66e1ab24」组合——该组合不可重放
# （git show baa9bb6:lock 的 SHA-256 ≠ 66e1ab24…）。
# 33cfe42（R2A 提交本身）才是首次包含 66e1ab24… 锁字节的提交
# （git show 33cfe42:lock 的 SHA-256 = 66e1ab24…，由
# tests/test_e5_base_supply_chain.py::test_lock_frozen_commit_provenance
# 在每次测试运行时实测证明）。锁字节真实锚定 = EXPECTED_LOCK_SHA256
# （内容寻址）；LOCK_FROZEN_COMMIT 仅是 provenance 描述字段，两者共同
# 构成可重放的 (commit, bytes) 组合。
LOCK_FROZEN_COMMIT = "33cfe424d01727c3a16b8e5bbe9fd7d02ca16dfc"
EXPECTED_LOCK_SHA256 = (
    "66e1ab241f98a92759844cefb329688cb6a9dbb19a04fd28d4ad05dd904e2ed9")
EXPECTED_LOCK_TYPE = "e5-base-eval-candidate-lock"
EXPECTED_LOCK_VERSION = 2
EXPECTED_WHITELIST_COUNT = 6

CONTRACT_FIELDS = {
    "dimension": DIMENSION,
    "dtype": "float32",
    "normalization": "L2",
    "pooling": "attention-mask mean pooling",
    "similarity": "cosine",
    "max_length_tokens": MAX_LENGTH,
    "query_batch": QUERY_BATCH,
    "index_build_batch": PASSAGE_BATCH,
    "trust_remote_code": False,
    "offline_only": True,
    "query_prefix": QUERY_PREFIX,
    "passage_prefix": PASSAGE_PREFIX,
}

BACKEND_PACKAGES = {
    "torch": "2.13.0+cpu",
    "transformers": "5.15.1",
    "tokenizers": "0.22.2",
    "safetensors": "0.8.0",
    "huggingface_hub": "1.28.0",
    "numpy": "2.5.2",
}


class EmbedderError(RuntimeError):
    pass


def default_lock_path():
    return os.path.join(REPO_ROOT, *LOCK_RELATIVE_PATH.split("/"))


def _canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_self_hash(manifest):
    value = {k: v for k, v in manifest.items() if k != "self_hash"}
    return hashlib.sha256(
        _canonical_json(value).encode("utf-8")).hexdigest()


def load_verified_lock(lock_path=None):
    """读取候选锁并做整文件 SHA-256 pin 校验。返回 (lock_dict, lock_sha256)。

    pin 不匹配（任何锁字节被篡改）= fail-closed。
    锁内模型 ID / revision 与代码冻结常量交叉验证。
    """
    path = lock_path or default_lock_path()
    if not os.path.isfile(path):
        raise EmbedderError("CANDIDATE_LOCK_NOT_FOUND: %s" % path)
    lock_sha = _sha256_file(path)
    if lock_sha != EXPECTED_LOCK_SHA256:
        raise EmbedderError(
            "LOCK_DIGEST_MISMATCH: expected=%s measured=%s"
            % (EXPECTED_LOCK_SHA256, lock_sha))
    with open(path, "r", encoding="utf-8") as fh:
        lock = json.load(fh)
    if lock.get("lock_type") != EXPECTED_LOCK_TYPE:
        raise EmbedderError(
            "LOCK_TYPE_MISMATCH: %s" % lock.get("lock_type"))
    if lock.get("lock_version") != EXPECTED_LOCK_VERSION:
        raise EmbedderError(
            "LOCK_VERSION_MISMATCH: %s" % lock.get("lock_version"))
    model = lock.get("model") or {}
    if model.get("id") != MODEL_ID:
        raise EmbedderError(
            "LOCK_MODEL_ID_MISMATCH: %s" % model.get("id"))
    if model.get("immutable_revision") != IMMUTABLE_REVISION:
        raise EmbedderError(
            "LOCK_REVISION_MISMATCH: %s"
            % model.get("immutable_revision"))
    files = lock.get("files") or []
    if len(files) != EXPECTED_WHITELIST_COUNT:
        raise EmbedderError(
            "LOCK_FILES_COUNT_MISMATCH: %d" % len(files))
    for entry in files:
        if not entry.get("path") or \
                not isinstance(entry.get("size"), int) or \
                not entry.get("sha256"):
            raise EmbedderError(
                "LOCK_FILE_ENTRY_MALFORMED: %s" % entry)
    return lock, lock_sha


def verify_backend_versions():
    for pkg, ver in BACKEND_PACKAGES.items():
        try:
            cur = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            raise EmbedderError("backend package missing: %s" % pkg)
        if cur != ver:
            raise EmbedderError(
                "backend version mismatch: %s expected=%s got=%s"
                % (pkg, ver, cur))


def build_manifest(model_dir, python_version, lock_path=None):
    """从修正后候选锁生成 MODEL-MANIFEST.json（锁 digest 先验证）。

    白名单逐字段取自锁 files（size + SHA-256）；不产生任何
    lock_discrepancy 字段；trust_root = 锁路径 + 冻结提交 + 锁完整
    SHA-256；candidate_lock_sha256 显式锚定锁字节。
    """
    lock, lock_sha = load_verified_lock(lock_path)
    whitelist = []
    for entry in sorted(lock["files"], key=lambda e: e["path"]):
        whitelist.append({
            "filename": entry["path"],
            "size": entry["size"],
            "sha256": entry["sha256"],
        })
    manifest = {
        "manifest_schema_version": MANIFEST_SCHEMA_VERSION,
        "model": {
            "id": MODEL_ID,
            "immutable_revision": IMMUTABLE_REVISION,
        },
        "contract": dict(CONTRACT_FIELDS),
        "backend": {
            "name": "transformers",
            "runtime": "torch-cpu",
            "python": python_version,
            "os": "Windows",
            "arch": "AMD64",
            "packages": dict(BACKEND_PACKAGES),
        },
        "whitelist_files": whitelist,
        "trust_root": "%s @ %s（SHA-256 = %s）" % (
            LOCK_RELATIVE_PATH, LOCK_FROZEN_COMMIT, lock_sha),
        "candidate_lock_sha256": lock_sha,
        "generated_by": "memory_eval/e5_base/supply_chain.py"
                        "（R1A 供应链冻结：候选锁驱动生成，零例外）",
    }
    manifest["self_hash"] = _manifest_self_hash(manifest)
    return manifest


def verify_model_manifest(model_dir, lock_path=None):
    """加载前完整校验（fail-closed）。守卫链 = 修正后候选锁 ↔ manifest ↔ 磁盘。

    - 候选锁：整文件 SHA-256 pin + 类型/版本/模型字段校验
    - manifest：schema v2；携带任何 lock_discrepancy 字段一律拒绝；
      candidate_lock_sha256 必须等于实测锁 digest；self_hash / 模型 /
      合同 / backend 逐字段校验
    - 白名单：与锁 files 逐字段一致（集合 + size + SHA-256）
    - 磁盘：白名单文件存在且 size + SHA-256 与锁一致；目录内无额外文件
    """
    lock, lock_sha = load_verified_lock(lock_path)
    lock_files = {e["path"]: e for e in lock["files"]}

    manifest_path = os.path.join(model_dir, MANIFEST_FILENAME)
    if not os.path.isfile(manifest_path):
        raise EmbedderError("MODEL_MANIFEST_NOT_FOUND: %s" % manifest_path)
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if "lock_discrepancy" in manifest:
        # 产品所有者裁决 2026-08-22 R1A：不得保留可绕过校验的例外
        raise EmbedderError(
            "LOCK_DISCREPANCY_FIELD_REJECTED: manifest 不得携带任何 "
            "lock_discrepancy 字段（含空列表）")
    if manifest.get("manifest_schema_version") != MANIFEST_SCHEMA_VERSION:
        raise EmbedderError("MANIFEST_SCHEMA_VERSION_MISMATCH")
    if manifest.get("candidate_lock_sha256") != lock_sha:
        raise EmbedderError(
            "MANIFEST_LOCK_ANCHOR_MISMATCH: expected=%s got=%s"
            % (lock_sha, manifest.get("candidate_lock_sha256")))
    if manifest.get("self_hash") != _manifest_self_hash(manifest):
        raise EmbedderError("MANIFEST_SELF_HASH_MISMATCH")
    model = manifest.get("model") or {}
    if model.get("id") != MODEL_ID:
        raise EmbedderError("MODEL_ID_MISMATCH: %s" % model.get("id"))
    if model.get("immutable_revision") != IMMUTABLE_REVISION:
        raise EmbedderError("REVISION_MISMATCH: %s"
                            % model.get("immutable_revision"))
    contract = manifest.get("contract") or {}
    for key, value in CONTRACT_FIELDS.items():
        if contract.get(key) != value:
            raise EmbedderError("CONTRACT_FIELD_MISMATCH: %s" % key)
    packages = (manifest.get("backend") or {}).get("packages") or {}
    if packages != BACKEND_PACKAGES:
        raise EmbedderError("BACKEND_PACKAGES_MISMATCH")
    whitelist = manifest.get("whitelist_files") or []
    names = [entry.get("filename") for entry in whitelist]
    if len(names) != len(lock_files) or set(names) != set(lock_files):
        raise EmbedderError("WHITELIST_FILE_SET_MISMATCH")
    allowed = {MANIFEST_FILENAME}
    for entry in whitelist:
        name = entry.get("filename")
        trusted = lock_files[name]
        if entry.get("size") != trusted["size"] or \
                entry.get("sha256") != trusted["sha256"]:
            raise EmbedderError("WHITELIST_METADATA_MISMATCH: %s" % name)
        allowed.add(name)
        path = os.path.join(model_dir, name)
        if not os.path.isfile(path):
            raise EmbedderError("MISSING_WHITELIST_FILE: %s" % name)
        if os.path.getsize(path) != trusted["size"]:
            raise EmbedderError("SIZE_MISMATCH: %s" % name)
        if _sha256_file(path) != trusted["sha256"]:
            raise EmbedderError("SHA256_MISMATCH: %s" % name)
    for entry in os.listdir(model_dir):
        if entry not in allowed:
            raise EmbedderError("UNEXPECTED_FILE_IN_MODEL_DIR: %s" % entry)
    return manifest
