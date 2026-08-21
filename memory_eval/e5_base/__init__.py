# -*- coding: utf-8 -*-
"""E5-base 评测侧实现包（R4 Gate 0 E5-base 实施轮）。

- oracle_v3：canonical oracle（独立实现，零 memory_engine 依赖）
- embedder：E5-base 离线 adapter（768 维，以候选锁为可信根）
- calibration：35-grid sealed calibration runner
"""
