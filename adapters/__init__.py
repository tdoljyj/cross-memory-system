# -*- coding: utf-8 -*-
"""Adapters 包：统一 AI 端接口（Phase 13）。

现有适配器：CLIAdapter（memory.py）。
未来：ChatGPT / Claude / Cursor 等新端接入时，在实现 MemoryAdapter
接口的前提下，经 Memory Engine 访问 Canonical Store。
"""

from .interface import MemoryAdapter
from .cli_adapter import CLIAdapter

__all__ = ["MemoryAdapter", "CLIAdapter"]
