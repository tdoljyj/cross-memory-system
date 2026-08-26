# -*- coding: utf-8 -*-
"""Memory Engine v2.0（vNext-2.0 核心包）。

分层（对齐《架构基线文档-vNext-2.0.md》）：

    AI Adapter
        ↓
    Memory Router（T0–T4，AI 行为）
        ↓
    Recall Engine / Write Engine（本包）
        ↓
    Memory Object Layer（memory/objects/*.json）
        ↓
    Canonical Store（git 私有仓库）
        ↓
    Git Sync Layer（sync-memory.py / sync-memory.ps1，vNext-1.3 稳定基线，本包不修改、不绕过）

本包只做记忆机制（对象 / 生命周期 / 写引擎 / 召回引擎 / 合并 / 冲突 / 审计 / 索引），
不直接执行 git commit/push——一切持久化仍经 Git Sync Layer。
"""

__version__ = "2.0.0"
ENGINE_VERSION = "vNext-2.0"
