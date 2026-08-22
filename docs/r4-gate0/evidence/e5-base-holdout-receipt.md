# E5-base Holdout Receipt（one-shot）

- Result: **HOLDOUT_FAIL_NO_GO**
- Parameters (frozen): **alpha=1.00 / tau=0.90**
- Holdout cases executed: **58**
- Holdout detail reads: **58**
- Consumption marker: `C:\Users\17531\.workbuddy\vector-cache\cross-memory-system\holdout\e5-base-one-shot-consumption-marker.json`
- Marker SHA-256: `c72c399c8a7b79a2b3916c970fdc32ee71fedf09d79ba3b65786c3141f810cbb`
- Git HEAD: `47a51ea6c0f03e5a5449eee91cbe6d5a1ecca869`
- Model manifest SHA-256: `f4d7c895a2900bd06cc8761043fbc94c3190dd521e931b7d603d79c928eb842e`
- Calibration receipt SHA-256: `f84f3f4c09a8fb15f696e7c861d65e327b443a2a0daacdccdda2c158734461c5`

## Gate verdicts

- precision_at5_v2 = 0.48333333333333334 (rule >=0.90): **FAIL**
- critical_memory_recall_v2 = 0.6304347826086957 (rule >=0.95): **FAIL**
- false_recall_rate_v2 = 0.5166666666666667 (rule <=0.02): **FAIL**
- paraphrase_correct = 1/12 (rule >=11/12): **FAIL**
- no_memory_final_contract = 41/41 (rule 41/41 all correct): **PASS**
- lexical_expected_preservation = 1.0 (rule ==1.0): **PASS**
- prompt_token_p95 = 50 (rule <=650): **PASS**
- scope_leakage = 0 (rule ==0): **PASS**
- superseded_leakage = 0 (rule ==0): **PASS**
- conflict_loser_revival = 0 (rule ==0): **PASS**
- secret_leakage = 0 (rule ==0): **PASS**
- forbidden_leakage_total = 0 (rule ==0): **PASS**
- trace_mismatch = 0 (rule ==0): **PASS**
- error_count = 0 (rule ==0): **PASS**

- All gates passed: **False**

## Raw metrics (unrounded)

- precision_at5_v2: 0.483333333333 (29/60)
- critical_memory_recall_v2: 0.630434782609 (29/46)
- false_recall_rate_v2: 0.516666666667 (31/60)
- lexical_expected_preservation: 1.0 (29/29)
- prompt_token_p95: 50
- NO MEMORY final contract: 41/41 (cal 26/26 + holdout 15/15)
- paraphrase: 1/12
- trace mismatch: 0
- CONFLICT_LOSER revivals: 0
- Protocol deviations: **none**

## NO-GO

- failed gates: precision_at5_v2, critical_memory_recall_v2, false_recall_rate_v2, paraphrase_correct
- 唯一一次运行已消费；E5-base 本合同口径 **HOLDOUT FAIL / NO-GO**，禁止第二次运行。
