#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 E5 embedding adapter（离线、确定性、trust_remote_code=False）。

冻结运行合同（ADR-MIV-005B-002 R1.2 + R4-G0-PLAN §3.5）：
- 输入前缀：query 加 "query: "，passage 加 "passage: "
- pooling：attention-mask mean pooling（非 CLS / 非 max）
- 归一化：L2 normalization
- 相似度：cosine（归一化后即内积）
- 精度：float32；维度 384；最大长度 512 token（超出截断）
- batch：query=1；index build=32
- remote code：trust_remote_code=False
- runtime：完全离线（local_files_only 等价语义）
"""
import os
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "
DIM = 384
MAX_LENGTH = 512


class E5Embedder:
    """加载 multilingual-e5-small 并做 mean-pooling + L2 的离线 embedder。"""

    def __init__(self, model_dir, device="cpu"):
        self.model_dir = model_dir
        self.device = device
        # 完全离线 + 禁 remote code
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_dir, trust_remote_code=False, local_files_only=True)
        self.model = AutoModel.from_pretrained(
            model_dir, trust_remote_code=False, local_files_only=True)
        self.model.to(device)
        self.model.eval()
        # 运行时维度核验
        cfg = self.model.config
        hidden = getattr(cfg, "hidden_size", None)
        if hidden is not None and hidden != DIM:
            raise RuntimeError(
                "模型 hidden_size=%s 与合同 dimension=%d 不符" % (hidden, DIM))

    @staticmethod
    def _mean_pooling(model_output, attention_mask):
        token_emb = model_output.last_hidden_state  # [B, L, H]
        mask = attention_mask.unsqueeze(-1).expand(token_emb.size()).float()
        summed = torch.sum(token_emb * mask, dim=1)
        counts = torch.clamp(mask.sum(dim=1), min=1e-9)
        return summed / counts

    def _encode(self, texts, prefix, batch_size):
        """texts -> L2 归一化后的 float32 向量 [N, 384]。"""
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
        return torch.cat(vecs, dim=0)

    def embed_query(self, text, batch_size=1):
        """单条 query embedding（batch=1）。返回 [1, 384] 归一化向量。"""
        return self._encode([text], QUERY_PREFIX, batch_size)

    def embed_passages(self, texts, batch_size=32):
        """批量 passage embedding（index build batch=32）。返回 [N, 384]。"""
        if not texts:
            return torch.zeros((0, DIM), dtype=torch.float32)
        return self._encode(texts, PASSAGE_PREFIX, batch_size)

    @staticmethod
    def cosine(q_vec, p_vec):
        """归一化后的 cosine = 内积。输入为归一化向量。"""
        return float((q_vec * p_vec).sum())

    @property
    def dim(self):
        return DIM
