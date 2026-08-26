# -*- coding: utf-8 -*-
"""Clued v0.2.0 —— Agent Lifecycle 核心包（Clued Agent Lifecycle Protocol v0.3.0）。

产品名：Clued v0.2.0；协议版本：Clued Agent Lifecycle Protocol v0.3.0
（v0.1.0 → v0.2.0 依据 ADR-CLD-001：LKG 最大年龄收紧为 1 小时；
 v0.2.0 → v0.3.0 依据 ADR-CLD-003：LKG 策略化 balanced=6h / strict=1h，
 新装默认 balanced，v0.1.0 升级保守迁移 strict，ADR-CLD-001 被 supersede）。

分层（协议 §4）：
    Conversation Adapter（clued/codex_adapter.md）
        ↓
    Lifecycle Controller（clued/controller.py，状态机单一控制器）
        ↓
    Auth Plane（clued/auth/**）  +  Sync Plane（clued/sync_provider.py）
        ↓
    Local Runtime（registry / journal / audit / locks / manifests）
        ↓
    既有核心（冻结区，本包不修改、不绕过）：
        Memory Engine vNext-2.0（memory_engine/**，经 memory_gate 复用）
        Git Sync Layer vNext-1.3（sync-memory.py pull/push/doctor/bootstrap）
        Canonical Store（GitHub 私有仓库 tdoljyj/cross-memory-system）
"""

__version__ = "0.2.0"
PROTOCOL_VERSION = "0.3.0"
RUNTIME_VERSION = "0.2.x"
