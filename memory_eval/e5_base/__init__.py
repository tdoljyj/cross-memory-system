# -*- coding: utf-8 -*-
"""E5-base 评测侧实现包（R4 Gate 0 E5-base 实施轮 + R1A 供应链冻结）。

- oracle_v3：canonical oracle（独立实现，零 memory_engine 依赖）
- supply_chain：候选锁驱动的 manifest 生成与 fail-closed 守卫
  （R1A 冻结；零第三方依赖；锁 digest pin = 50ab5689…）
- embedder：E5-base 离线 adapter（768 维；守卫经 supply_chain，
  可信根 = 修正后候选锁）
- calibration：35-grid sealed calibration runner
"""
