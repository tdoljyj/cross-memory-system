#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""供应链 manifest 守卫（无 torch/transformers 依赖，纯标准库）。

职责：在加载任何模型权重/tokenizer **之前**，对 MODEL-MANIFEST.json 做完整
校验（schema / canonical self-hash / 模型 ID / 固定 revision / 冻结合同字段
（含 query_prefix / passage_prefix 精确值）/ backend 与完整依赖锁 / 白名单
文件集合与代码内冻结的精确 6 文件集合完全相等 / 仓库内可信根绑定的大小与
SHA-256 / 逐文件存在+哈希 / 额外文件拒绝），任何不符 fail-closed（抛异常）。

canonical hash 算法（明确定义）：
  self_hash = sha256(canonical_json(manifest 移除 self_hash 字段))
其中 canonical_json = json.dumps(sort_keys=True, ensure_ascii=False,
separators=(",", ":"))。即 self-hash 是「排除该字段」口径，不是置空。
"""
import hashlib
import json
import os

DIM = 384
MAX_LENGTH = 512
QUERY_BATCH = 1
PASSAGE_BATCH = 32

MANIFEST_FILENAME = "MODEL-MANIFEST.json"
MANIFEST_SCHEMA_VERSION = 1

EXPECTED_MODEL_ID = "intfloat/multilingual-e5-small"
EXPECTED_REVISION = "919cfbe11fbf4f1b9bb321007c46c14feaf84227"

# 冻结输入前缀（与 embedding_adapter 的 QUERY_PREFIX/PASSAGE_PREFIX 一致，
# 属冻结运行合同的一部分，manifest contract 必须精确等于这些值）
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "

# 仓库内可信根：固定 revision -> 精确文件 size/SHA-256 + backend 依赖锁。
# MODEL-MANIFEST.json 与模型文件位于同一可写目录，manifest 自身的 self_hash 只能
# 检测意外损坏，不能阻止攻击者同时改写 artifact、manifest 内哈希和 self_hash。
# 因此运行时必须先把 manifest 声明绑定到这里的带外可信根，再校验实际文件。
# 数据来源：官方 revision 下载授权轮的核验记录（docs/r4-gate0/01 §2.2/§2.3）。
TRUSTED_FILE_METADATA = {
    "config.json": {
        "size": 655,
        "sha256": "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959",
    },
    "tokenizer.json": {
        "size": 17082730,
        "sha256": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    "tokenizer_config.json": {
        "size": 443,
        "sha256": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    "special_tokens_map.json": {
        "size": 167,
        "sha256": "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
    },
    "sentencepiece.bpe.model": {
        "size": 5069051,
        "sha256": "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
    },
    "model.safetensors": {
        "size": 470641600,
        "sha256": "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477",
    },
}

TRUSTED_BACKEND = {
    "name": "transformers",
    "runtime": "torch-cpu",
    "packages": {
        "huggingface_hub": "1.28.0",
        "numpy": "2.5.2",
        "safetensors": "0.8.0",
        "tokenizers": "0.22.2",
        "torch": "2.13.0+cpu",
        "transformers": "5.15.1",
    },
    "wheel_sha256": {
        "huggingface_hub": "58a8bacb03072edfc38067065e9dc24bbb34805410fcd36a1632de0b329660bb",
        "numpy": "85aaccb24182c25df891ad0ec333585967e115269d5f1b17f2c9ae005bc96657",
        "safetensors": "096ec1a98435df7beb08853bb5aa9081a84f23d0adc67ed1a0a10550f608373f",
        "tokenizers": "c9ea31edff2968b44a88f97d784c2f16dc0729b8b143ed004699ebca91f05c48",
        "torch": "a17ff48608634db245e17e8bb00a9558554a49aeb1e4f5fe6cd039af2a10515b",
        "transformers": "b7cdf238ff583e3a58dbc7fa34da1aaf091ce063141f65a30538160bd5afe93f",
    },
}

MODEL_TRUST_ROOT = {
    "files": TRUSTED_FILE_METADATA,
    "backend": TRUSTED_BACKEND,
}

# manifest 白名单文件名集合必须与此完全相等（额外 / 缺失 / 重复均拒绝）。
FROZEN_FILES = frozenset(TRUSTED_FILE_METADATA)

# 冻结合同字段（值必须与 manifest 完全一致）
CONTRACT = {
    "dimension": 384,
    "dtype": "float32",
    "normalization": "L2",
    "pooling": "attention-mask mean pooling",
    "similarity": "cosine",
    "max_length_tokens": 512,
    "query_batch": 1,
    "index_build_batch": 32,
    "trust_remote_code": False,
    "offline_only": True,
    "query_prefix": QUERY_PREFIX,
    "passage_prefix": PASSAGE_PREFIX,
}


def canonical_json(obj):
    """规范 JSON 序列化：sort_keys + ensure_ascii=False + 紧凑分隔符（无空格）。

    这是 manifest canonical hash 的唯一序列化口径。
    """
    return json.dumps(obj, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_canonical_hash(manifest):
    """manifest 的 canonical hash = sha256(canonical_json(移除 self_hash 字段))。"""
    m = {k: v for k, v in manifest.items() if k != "self_hash"}
    return hashlib.sha256(canonical_json(m).encode("utf-8")).hexdigest()


def verify_model_manifest(model_dir, manifest_path=None):
    """使用仓库内冻结可信根验证生产模型 manifest。"""
    return _verify_model_manifest(model_dir, manifest_path, MODEL_TRUST_ROOT)


def _verify_model_manifest(model_dir, manifest_path, trust_root):
    """验证 MODEL-MANIFEST，任何不符抛异常（fail-closed）。

    校验顺序：schema → self-hash（canonical）→ 模型 ID / revision →
    冻结合同字段 → backend 完整依赖锁 → manifest 声明绑定可信根 →
    白名单文件（存在/大小/SHA-256）→ 额外文件拒绝。通过则返回 manifest dict。

    trust_root 参数仅供本模块生产包装器与合成 fixture 测试使用；实际加载路径
    E5Embedder 只调用 verify_model_manifest，不能由模型目录覆盖可信根。
    """
    if manifest_path is None:
        manifest_path = os.path.join(model_dir, MANIFEST_FILENAME)
    if not os.path.isfile(manifest_path):
        raise FileNotFoundError("MODEL-MANIFEST.json not found in %s" % model_dir)
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    # 1. schema
    if manifest.get("manifest_schema_version") != MANIFEST_SCHEMA_VERSION:
        raise RuntimeError("manifest schema version mismatch")

    # 2. self-hash（canonical，排除 self_hash 字段）
    stored = manifest.get("self_hash")
    if not stored:
        raise RuntimeError("manifest missing self_hash")
    if manifest_canonical_hash(manifest) != stored:
        raise RuntimeError("manifest self_hash mismatch")

    # 3. 模型 ID / 固定 revision
    model = manifest.get("model") or {}
    if model.get("id") != EXPECTED_MODEL_ID:
        raise RuntimeError("model id mismatch: %s" % model.get("id"))
    if model.get("immutable_revision") != EXPECTED_REVISION:
        raise RuntimeError("revision mismatch: %s" % model.get("immutable_revision"))

    # 4. 冻结合同字段
    contract = manifest.get("contract") or {}
    for k, v in CONTRACT.items():
        if contract.get(k) != v:
            raise RuntimeError("contract field mismatch: %s" % k)

    # 4b. backend 必须与仓库内完整依赖锁精确一致。仅判 packages 非空会允许
    # {"torch": "..."} 之类不完整声明绕过 transformers/tokenizers 等版本锁。
    backend = manifest.get("backend") or {}
    trusted_backend = trust_root["backend"]
    if backend.get("name") != trusted_backend["name"]:
        raise RuntimeError("backend name mismatch")
    if backend.get("runtime") != trusted_backend["runtime"]:
        raise RuntimeError("backend runtime mismatch")
    packages = backend.get("packages")
    if not isinstance(packages, dict) or not packages:
        raise RuntimeError("backend.packages empty or invalid (must be non-empty)")
    if packages != trusted_backend["packages"]:
        raise RuntimeError("backend.packages mismatch trusted dependency lock")
    wheel_sha256 = backend.get("wheel_sha256")
    if wheel_sha256 != trusted_backend["wheel_sha256"]:
        raise RuntimeError("backend.wheel_sha256 mismatch trusted dependency lock")

    # 5. 白名单文件（存在 / 大小 / SHA-256）+ 冻结精确 6 文件集合
    whitelist = manifest.get("whitelist_files")
    if not isinstance(whitelist, list) or not whitelist:
        raise RuntimeError("manifest whitelist_files empty or invalid")
    filenames = []
    for wf in whitelist:
        fn = wf.get("filename")
        if not fn:
            raise RuntimeError("whitelist entry missing filename")
        filenames.append(fn)
    # 5a. 文件名集合必须与 FROZEN_FILES 完全相等（额外 / 缺失 / 重复均拒绝）
    if len(filenames) != len(FROZEN_FILES) or set(filenames) != FROZEN_FILES:
        extra = sorted(set(filenames) - FROZEN_FILES)
        missing = sorted(FROZEN_FILES - set(filenames))
        raise RuntimeError(
            "whitelist file set mismatch: expected exactly %s, "
            "got extra=%s missing=%s"
            % (sorted(FROZEN_FILES), extra, missing))
    # 5b. manifest 的文件 metadata 必须先精确绑定仓库内可信根，随后实际文件
    # 直接对可信根校验；不能只对同目录 manifest 内攻击者可重写的值校验。
    trusted_files = trust_root["files"]
    allowed = set()
    for wf in whitelist:
        fn = wf.get("filename")
        allowed.add(fn)
        trusted = trusted_files[fn]
        if (wf.get("size") != trusted["size"] or
                wf.get("sha256") != trusted["sha256"]):
            raise RuntimeError("whitelist metadata mismatch trusted root: %s" % fn)
        p = os.path.join(model_dir, fn)
        if not os.path.isfile(p):
            raise RuntimeError("missing whitelist file: %s" % fn)
        if os.path.getsize(p) != trusted["size"]:
            raise RuntimeError("size mismatch: %s" % fn)
        if sha256_file(p) != trusted["sha256"]:
            raise RuntimeError("sha256 mismatch: %s" % fn)

    # 6. 额外文件拒绝（白名单 + MANIFEST 之外一律拒绝）
    allowed.add(MANIFEST_FILENAME)
    for entry in os.listdir(model_dir):
        if entry not in allowed:
            raise RuntimeError("unexpected file in model dir: %s" % entry)

    return manifest


def verify_hidden_size(hidden):
    """hidden_size 必须存在且 == 384；None（缺失）或任何非 384 值均拒绝。"""
    if hidden != DIM:
        raise RuntimeError("hidden_size=%r != contract dimension=%d"
                           % (hidden, DIM))
