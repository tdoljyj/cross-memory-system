#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 E5 embedding adapter（离线、确定性、trust_remote_code=False）。

冻结运行合同（ADR-MIV-005B-002 R1.2 + R4-G0-PLAN §3.5）：
- 输入前缀：query 加 "query: "，passage 加 "passage: "
- pooling：attention-mask mean pooling（非 CLS / 非 max）
- 归一化：L2 normalization
- 相似度：cosine（归一化后即内积）
- 精度：float32；维度 384；最大长度 512 token（超出截断）
- batch：query=1；index build=32（固定，禁止调用方覆盖）
- remote code：trust_remote_code=False
- runtime：完全离线（local_files_only 等价语义）

供应链不变量（R4-G0-B R1）：加载 tokenizer/model **之前**必须通过
`manifest_guard.verify_model_manifest` 的完整校验（schema / self-hash /
白名单文件大小与 SHA-256 / 模型 ID / 固定 revision / 冻结合同字段 / 额外文件
拒绝），任何不符 fail-closed（抛异常）。backend 包版本须与 manifest 记录一致。
"""
import importlib.metadata

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

from memory_engine.manifest_guard import (
    DIM, MAX_LENGTH, QUERY_BATCH, PASSAGE_BATCH,
    verify_model_manifest, verify_hidden_size,
)

QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "


def verify_backend_versions(manifest):
    """验证当前环境包版本与 manifest backend.packages 记录一致。"""
    expected = (manifest.get("backend") or {}).get("packages") or {}
    for pkg, ver in expected.items():
        try:
            cur = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            raise RuntimeError("backend package not installed: %s" % pkg)
        if cur != ver:
            raise RuntimeError(
                "backend version mismatch: %s expected=%s got=%s"
                % (pkg, ver, cur))


def verify_embedding_output(vec):
    """核验 embedding 输出：ndim==2 → 维度 / float32 / finite / L2 归一化。

    注意：必须先判 ndim==2 再查维度。仅用 `vec.shape[-1]` 会让 [1,1,384]
    这类 3-D 张量「最后一维是 384」而误通过；显式抛异常（非裸 assert，
    assert 会被 python -O 移除）。
    """
    if vec.ndim != 2:
        raise RuntimeError("embedding must be 2-D [N, %d], got ndim=%d"
                           % (DIM, vec.ndim))
    if vec.shape[-1] != DIM:
        raise RuntimeError("embedding dim=%s != %d" % (vec.shape[-1], DIM))
    if vec.dtype != torch.float32:
        raise RuntimeError("embedding dtype=%s != float32" % vec.dtype)
    if not torch.isfinite(vec).all():
        raise RuntimeError("embedding contains non-finite value")
    norms = vec.norm(p=2, dim=1)
    if (norms - 1.0).abs().max() > 1e-4:
        raise RuntimeError("embedding L2 norm != 1")
    return vec


class E5Embedder:
    """加载 multilingual-e5-small 并做 mean-pooling + L2 的离线 embedder。"""

    def __init__(self, model_dir, device="cpu"):
        self.model_dir = model_dir
        self.device = device
        # 1) 加载前：manifest 完整校验 + backend 版本校验（fail-closed）
        self.manifest = verify_model_manifest(model_dir)
        verify_backend_versions(self.manifest)
        # 2) 完全离线 + 禁 remote code
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_dir, trust_remote_code=False, local_files_only=True)
        self.model = AutoModel.from_pretrained(
            model_dir, trust_remote_code=False, local_files_only=True)
        self.model.to(device)
        self.model.eval()
        # 3) hidden_size 严格核验：缺失（getattr->None）或 != 384 均拒绝
        hidden = getattr(self.model.config, "hidden_size", None)
        verify_hidden_size(hidden)

    @staticmethod
    def _mean_pooling(model_output, attention_mask):
        token_emb = model_output.last_hidden_state  # [B, L, H]
        mask = attention_mask.unsqueeze(-1).expand(token_emb.size()).float()
        summed = torch.sum(token_emb * mask, dim=1)
        counts = torch.clamp(mask.sum(dim=1), min=1e-9)
        return summed / counts

    def _encode(self, texts, prefix, batch_size):
        """texts -> L2 归一化后的 float32 向量 [N, 384]，并做输出核验。"""
        full = [prefix + t for t in texts]
        vecs = []
        for i in range(0, len(full), batch_size):
            chunk = full[i:i + batch_size]
            tok = self.tokenizer(
                chunk, padding=True, truncation=True,
                max_length=MAX_LENGTH, return_tensors="pt")
            tok = {k: v.to(self.device) for k, v in tok.items()}
            with torch.no_grad():
                out = self.model(**tok)
            pooled = self._mean_pooling(out, tok["attention_mask"])
            normed = F.normalize(pooled, p=2, dim=1)
            vecs.append(normed)
        if not vecs:
            return torch.zeros((0, DIM), dtype=torch.float32)
        vec = torch.cat(vecs, dim=0)
        # 输出核验：shape / dtype / finite / L2（fail-closed）
        return verify_embedding_output(vec)

    def embed_query(self, text):
        """单条 query embedding（batch 固定 = 1）。返回 [1, 384]。"""
        return self._encode([text], QUERY_PREFIX, QUERY_BATCH)

    def embed_passages(self, texts):
        """批量 passage embedding（batch 固定 = 32）。返回 [N, 384]。"""
        if not texts:
            return torch.zeros((0, DIM), dtype=torch.float32)
        return self._encode(texts, PASSAGE_PREFIX, PASSAGE_BATCH)

    @staticmethod
    def cosine(q_vec, p_vec):
        """归一化后的 cosine = 内积。输入为归一化向量。"""
        return float((q_vec * p_vec).sum())

    @property
    def dim(self):
        return DIM
