# Gate 0-E Calibration Receipt

- Result: **NO-GO**
- Calibration cases loaded: **53**
- Holdout detail reads: **0**
- Grid combinations: **60**
- Qualifying combinations: **0**
- Model manifest SHA-256: `0de629f4b6db1d74812cd9581f6a8d305d3a88d9abee998498571c86197d080c`
- Calibration vector table SHA-256: `6e07576f82df21f9ef5e3bed250a3f9067e95cea7c0c633d9fb0f8feb552c372`
- Calibration code commit: `236de42f7af8065d4a5a5db378bc05f084fb2a97`
- Calibration code SHA-256: `0dd8e8b3f39f2209cca75410e9b5e712bde8de8c0a6abf8f3e7fad677a61c1ed`
- Canonical index evidence SHA-256: `8f49f4045d51ee31b25514b6007d5a4fec7fb2a11e6fde5a6a1e87097eaa8f67`
- Protocol deviations: **none**

## Best observed non-qualifying point

- alpha: **1.00**
- tau: **0.60**
- elimination reasons: `FALSE_RECALL_GT_0_02, NO_MEMORY_NOT_ALL_CORRECT, LEXICAL_BASELINE_EXPECTED_LOST`
- discrepant cases: **nm-006, sa-004**

原始计数：precision `29/30`、critical `29/30`、false recall `1/30`、
NO MEMORY `25/26`、词法正确 expected 保留 `29/30`、prompt token P95 `45`。

- `nm-006`：`mem_fx0a0005` 被 `VECTOR_ADMIT` 错误召回，破坏 NO MEMORY。
- `sa-004`：`mem_fx0h0003` 含合成 secret，按固定硬过滤得到
  `SECRET_DETECTED`，因此不能进入模型或 hybrid 结果；这同时暴露冻结质量目标与
  secret-first 安全合同在该 case 上不可同时满足。

## Independent deterministic replay

相同代码、模型、锁定输入和离线环境独立复跑一次：60 组网格原始结果、逐 case
ID/顺序/reason code、向量表 digest 与 NO-GO 结论均完全一致。延迟与运行时长未纳入
确定性比较。

## Stop condition

No grid combination met every calibration hard gate. The E5 candidate is **NO-GO** and Gate 0-F must not run.
