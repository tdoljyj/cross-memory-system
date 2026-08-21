#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""供应链 manifest 守卫（无 torch/transformers 依赖，纯标准库）。

职责：在加载任何模型权重/tokenizer **之前**，对 MODEL-MANIFEST.json 做完整
校验（schema / canonical self-hash / 模型 ID / 固定 revision / 冻结合同字段
（含 query_prefix / passage_prefix 精确值）/ backend.packages 非空 / 白名单
文件集合与代码内冻结的精确 6 文件集合完全相等 / 逐文件存在+大小+SHA-256 /
额外文件拒绝），任何不符 fail-closed（抛异常）。

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

# 代码内冻结的精确 6 文件集合：manifest 白名单文件名集合必须与此完全相等
# （额外 / 缺失 / 重复均拒绝）。这六者是 transformers 后端 E5-small 的唯一
# 合法文件；官方全树里的 pytorch_model.bin / onnx/* / 1_Pooling/* 等一律不在
# 白名单内（见 docs/r4-gate0/01 §2.2）。
FROZEN_FILES = frozenset({
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "sentencepiece.bpe.model",
    "model.safetensors",
})

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
    """验证 MODEL-MANIFEST，任何不符抛异常（fail-closed）。

    校验顺序：schema → self-hash（canonical）→ 模型 ID / revision →
    冻结合同字段 → 白名单文件（存在/大小/SHA-256）→ 额外文件拒绝。
    通过则返回 manifest dict。
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

    # 4b. backend.packages 必须为非空 dict（{} 明确拒绝）
    backend = manifest.get("backend") or {}
    packages = backend.get("packages")
    if not isinstance(packages, dict) or not packages:
        raise RuntimeError("backend.packages empty or invalid (must be non-empty)")

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
    # 5b. 逐文件存在 / 大小 / SHA-256
    allowed = set()
    for wf in whitelist:
        fn = wf.get("filename")
        allowed.add(fn)
        p = os.path.join(model_dir, fn)
        if not os.path.isfile(p):
            raise RuntimeError("missing whitelist file: %s" % fn)
        if os.path.getsize(p) != wf.get("size"):
            raise RuntimeError("size mismatch: %s" % fn)
        if sha256_file(p) != wf.get("sha256"):
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
