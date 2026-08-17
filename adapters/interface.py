# -*- coding: utf-8 -*-
"""Adapters（Phase 24 执行计划 / Phase 13 实施顺序）。

统一接口 MemoryAdapter：read / recall / write / update / supersede / status。
现有端：Codex / WorkBuddy / DSH；未来：ChatGPT / Claude / Cursor / 其他 Agent。

硬约束（§24）：
- Adapter 不得直接修改 Canonical Store（不直接写对象文件）
- 必须走 Adapter → Memory Engine → Sync Layer
- 本阶段只建立接口与 CLI 适配器，不实现 ChatGPT Adapter
"""

import abc


class MemoryAdapter(abc.ABC):
    """所有 AI 端统一接口。实现必须经 Memory Engine，不得直触 Canonical Store。"""

    name = "base"

    @abc.abstractmethod
    def read(self, query, tier="T0", **kwargs):
        """按需召回：Router 判定 tier（T0–T4）后调用。返回 RecallResult。"""

    @abc.abstractmethod
    def recall(self, query, tier="T0", **kwargs):
        """同 read（语义别名，兼容各端习惯）。"""

    @abc.abstractmethod
    def write(self, candidate, **kwargs):
        """写入候选（NEW/UPDATE/SUPERSEDE 决策由引擎裁决）。返回 WriteResult。"""

    @abc.abstractmethod
    def update(self, memory_id, content, **kwargs):
        """更新既有记忆（细化走 UPDATE；冲突走 SUPERSEDE）。"""

    @abc.abstractmethod
    def supersede(self, memory_id, content, **kwargs):
        """明确推翻：旧 → superseded，新 → active。"""

    @abc.abstractmethod
    def status(self):
        """对象库统计 + 引擎 doctor 摘要。"""
