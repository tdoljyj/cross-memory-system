# -*- coding: utf-8 -*-
"""E5-base 离线 embedding adapter（评测侧独立实现；R1A 供应链冻结后）。

运行合同与 E5-small adapter 逐项相同（唯一差异 dimension 384 -> 768）：
- 前缀 query: / passage: ；attention-mask mean pooling；L2 归一化；
  float32；max 512 token；batch query=1 / passage=32；
  trust_remote_code=False；完全离线（local_files_only）。
- 加载前对 MODEL-MANIFEST.json 做完整 fail-closed 校验（loader 之前）；
  可信根 = 修正后候选锁 docs/r4-gate0/locks/e5-base-candidate-lock.json
  （SHA-256 = 50ab5689…，冻结提交 baa9bb6；锁 digest 在代码内 pin）。
  守卫链 = 修正后候选锁 ↔ manifest ↔ 磁盘字节；manifest 携带任何
  lock_discrepancy 字段一律拒绝（无例外豁免路径）。
  守卫实现 = memory_eval/e5_base/supply_chain.py（零第三方依赖，
  可独立审计；本模块仅为兼容层 re-export + torch embedding 本体）。

与 memory_engine/embedding_adapter.py（E5-small 专用，DIM=384 硬编码）
互不影响：本模块不修改 memory_engine 任何文件。
"""

import hashlib
import os

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

from memory_eval.e5_base.supply_chain import (  # noqa: F401  (兼容层 re-export)
    BACKEND_PACKAGES,
    CONTRACT_FIELDS,
    DIMENSION,
    EmbedderError,
    EXPECTED_LOCK_SHA256,
    IMMUTABLE_REVISION,
    LOCK_FROZEN_COMMIT,
    LOCK_RELATIVE_PATH,
    MANIFEST_FILENAME,
    MANIFEST_SCHEMA_VERSION,
    MAX_LENGTH,
    MODEL_ID,
    PASSAGE_BATCH,
    PASSAGE_PREFIX,
    QUERY_BATCH,
    QUERY_PREFIX,
    build_manifest,
    verify_backend_versions,
    verify_model_manifest,
)


class E5BaseEmbedder(object):
    """multilingual-e5-base（768 维）离线 embedder。

    加载顺序（fail-closed）：verify_model_manifest（锁↔manifest↔磁盘
    三方校验）→ verify_backend_versions → tokenizer/model 加载 →
    hidden_size 核验。任何校验失败都发生在模型加载之前。
    """

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
