# -*- coding: utf-8 -*-
"""E5-base 离线 embedding adapter（评测侧独立实现）。

运行合同与 E5-small adapter 逐项相同（唯一差异 dimension 384 -> 768）：
- 前缀 query: / passage: ；attention-mask mean pooling；L2 归一化；
  float32；max 512 token；batch query=1 / passage=32；
  trust_remote_code=False；完全离线（local_files_only）。
- 加载前对 MODEL-MANIFEST.json 做完整 fail-closed 校验；可信根 =
  docs/r4-gate0/locks/e5-base-candidate-lock.json（M0-R2/R3 冻结）。

与 memory_engine/embedding_adapter.py（E5-small 专用，DIM=384 硬编码）
互不影响：本模块不修改 memory_engine 任何文件。

已知发现（非静默披露）：候选锁 files[tokenizer_config.json].sha256 的
第 49 位 hex 与固定 revision 权威字节不符（锁值 …996cd3f…，实测
…997cd3f…）。供应链字节权威性由 git blob SHA-1 内容寻址验证
（= HF 仓库 oid 6de1940d…）、双次下载字节稳定、tree API 其余文件
Xet/LFS 元数据全一致共同证明；差异定性为锁记录抄写笔误，本模块按实测
权威值构建 manifest 并在 manifest 中逐字段记录该差异（锁文件本身不动）。
"""

import hashlib
import importlib.metadata
import json
import math
import os
import re

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "
DIMENSION = 768
MAX_LENGTH = 512
QUERY_BATCH = 1
PASSAGE_BATCH = 32
MANIFEST_FILENAME = "MODEL-MANIFEST.json"
MANIFEST_SCHEMA_VERSION = 1
MODEL_ID = "intfloat/multilingual-e5-base"
IMMUTABLE_REVISION = "d128750597153bb5987e10b1c3493a34e5a4502a"

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

# 实测权威哈希（下载字节 + git blob SHA-1 内容寻址验证）。
# tokenizer_config.json 与候选锁记录存在 1 个 hex 字符差异，见模块 docstring
# 与 manifest 的 lock_discrepancy 字段（非静默披露）。
AUTHORITATIVE_FILES = {
    "config.json": {
        "size": 694,
        "sha256": "9dab198f24c8c0879e481cf7822005d5ecbceedbacb390ffafa594e28d31bac4",
        "git_blob_sha1": None,
    },
    "tokenizer.json": {
        "size": 17082660,
        "sha256": "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
        "git_blob_sha1": None,
    },
    "tokenizer_config.json": {
        "size": 418,
        "sha256": "efb5c0d09722e5fe59a462cd2a9976ee216d55b037597d997cd3fe833216da15",
        "git_blob_sha1": "6de1940d16d38be9877bf7cc228c9377841b311f",
    },
    "special_tokens_map.json": {
        "size": 280,
        "sha256": "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
        "git_blob_sha1": None,
    },
    "sentencepiece.bpe.model": {
        "size": 5069051,
        "sha256": "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
        "git_blob_sha1": None,
    },
    "model.safetensors": {
        "size": 1112201288,
        "sha256": "a18a44fad1d0b46ded15928144138cff1135d5cc8233bdd90be5f18822de09a7",
        "git_blob_sha1": None,
    },
}

LOCK_DISCREPANCY = [{
    "path": "tokenizer_config.json",
    "lock_sha256": "efb5c0d09722e5fe59a462cd2a9976ee216d55b037597d996cd3fe833216da15",
    "authoritative_sha256": AUTHORITATIVE_FILES["tokenizer_config.json"]["sha256"],
    "size_match": True,
    "note": "候选锁第 49 位 hex 与固定 revision 权威字节不符（6 vs 7）。"
            "权威性证据：git blob SHA-1 = HF 仓库 oid 6de1940d16d38be9877"
            "bf7cc228c9377841b311f（内容寻址）；双次下载字节一致；"
            "其余 5 文件锁值精确一致。定性：锁记录抄写笔误。锁文件未改动。",
}]


class EmbedderError(RuntimeError):
    pass


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


def build_manifest(model_dir, python_version):
    """生成 MODEL-MANIFEST.json（canonical self-hash 口径与 Gate 0-B 一致）。"""
    whitelist = []
    for name in sorted(AUTHORITATIVE_FILES):
        meta = AUTHORITATIVE_FILES[name]
        whitelist.append({
            "filename": name,
            "size": meta["size"],
            "sha256": meta["sha256"],
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
        "trust_root": "docs/r4-gate0/locks/e5-base-candidate-lock.json "
                      "@ 4e6cca1（M0-R3 提交）",
        "lock_discrepancy": LOCK_DISCREPANCY,
        "generated_by": "memory_eval/e5_base/embedder.py（E5-base 实施轮）",
    }
    manifest["self_hash"] = _manifest_self_hash(manifest)
    return manifest


def verify_model_manifest(model_dir):
    """加载前完整校验（fail-closed）。返回 manifest dict。"""
    manifest_path = os.path.join(model_dir, MANIFEST_FILENAME)
    if not os.path.isfile(manifest_path):
        raise EmbedderError("MODEL_MANIFEST_NOT_FOUND: %s" % manifest_path)
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("manifest_schema_version") != MANIFEST_SCHEMA_VERSION:
        raise EmbedderError("MANIFEST_SCHEMA_VERSION_MISMATCH")
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
    if len(names) != len(AUTHORITATIVE_FILES) or \
            set(names) != set(AUTHORITATIVE_FILES):
        raise EmbedderError("WHITELIST_FILE_SET_MISMATCH")
    allowed = {MANIFEST_FILENAME}
    for entry in whitelist:
        name = entry.get("filename")
        trusted = AUTHORITATIVE_FILES[name]
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


class E5BaseEmbedder(object):
    """multilingual-e5-base（768 维）离线 embedder。"""

    def __init__(self, model_dir, device="cpu"):
        self.model_dir = model_dir
        self.device = device
        self.manifest = verify_model_manifest(model_dir)
        with open(os.path.join(model_dir, MANIFEST_FILENAME), "rb") as fh:
            self.manifest_digest = hashlib.sha256(fh.read()).hexdigest()
        verify_backend_versions()
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_dir, trust_remote_code=False, local_files_only=True)
        self.model = AutoModel.from_pretrained(
            model_dir, trust_remote_code=False, local_files_only=True)
        self.model.to(device)
        self.model.eval()
        hidden = getattr(self.model.config, "hidden_size", None)
        if hidden != DIMENSION:
            raise EmbedderError(
                "hidden_size=%r != contract dimension=%d" % (hidden,
                                                              DIMENSION))

    @staticmethod
    def _mean_pooling(model_output, attention_mask):
        token_emb = model_output.last_hidden_state
        mask = attention_mask.unsqueeze(-1).expand(token_emb.size()).float()
        summed = torch.sum(token_emb * mask, dim=1)
        counts = torch.clamp(mask.sum(dim=1), min=1e-9)
        return summed / counts

    def _encode(self, texts, prefix, batch_size):
        full = [prefix + t for t in texts]
        vecs = []
        for start in range(0, len(full), batch_size):
            chunk = full[start:start + batch_size]
            tok = self.tokenizer(
                chunk, padding=True, truncation=True,
                max_length=MAX_LENGTH, return_tensors="pt")
            tok = {k: v.to(self.device) for k, v in tok.items()}
            with torch.no_grad():
                out = self.model(**tok)
            pooled = self._mean_pooling(out, tok["attention_mask"])
            vecs.append(F.normalize(pooled, p=2, dim=1))
        if not vecs:
            return torch.zeros((0, DIMENSION), dtype=torch.float32)
        vec = torch.cat(vecs, dim=0)
        # 输出核验（fail-closed）：shape / dtype / finite / L2
        if vec.ndim != 2 or vec.shape[-1] != DIMENSION:
            raise EmbedderError("EMBEDDING_SHAPE_MISMATCH")
        if vec.dtype != torch.float32:
            raise EmbedderError("EMBEDDING_DTYPE_MISMATCH")
        if not torch.isfinite(vec).all():
            raise EmbedderError("EMBEDDING_NON_FINITE")
        if (vec.norm(p=2, dim=1) - 1.0).abs().max() > 1e-4:
            raise EmbedderError("EMBEDDING_NOT_L2_NORMALIZED")
        return vec

    def embed_query(self, text):
        return self._encode([text], QUERY_PREFIX, QUERY_BATCH)

    def embed_passages(self, texts):
        if not texts:
            return torch.zeros((0, DIMENSION), dtype=torch.float32)
        return self._encode(texts, PASSAGE_PREFIX, PASSAGE_BATCH)

    @property
    def dim(self):
        return DIMENSION
