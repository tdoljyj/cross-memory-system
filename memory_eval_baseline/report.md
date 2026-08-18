# Memory Eval Baseline Report

- runner: 1.0
- eval schema: v1
- corpus hash: `1bc2374405f9678bf455b6bfffb2ed6fe3b4c12054fb2fe521e8ac9db3482c0e`
- cases: 111
- adapters: codex-test, dsh-test
- fixed clock: 2026-08-18T12:00:00Z

## 指标

| 指标 | 值 |
| --- | --- |
| precision_at5 | 0.1857 |
| critical_memory_recall | 0.8553 |
| false_recall_rate | 0.3663 |
| stale_recall_rate | 0.0 |
| current_scope_leakage_count | 0 |
| project_only_capability_gap_count | 1 |
| superseded_leakage_count | 0 |
| no_memory_correctness | 0.9512 |
| no_memory_violations | 2 |
| cross_agent_consistency | 1.0 |
| estimated_prompt_tokens_p50 | 18 |
| estimated_prompt_tokens_p95 | 50 |
| recall_latency_ms_p50 | 1.074 |
| recall_latency_ms_p95 | 1.828 |

## 分类指标

| 类别 | 用例数 | Precision@5 | 越权命中 | 关键断言失败 |
| --- | ---: | ---: | ---: | ---: |
| explicit_preference | 15 | 0.2 | 0 | 0 |
| implicit_observed | 16 | 0.2 | 0 | 0 |
| project_scope | 16 | 0.2308 | 1 | 1 |
| negative_no_memory | 15 | N/A | 0 | 2 |
| temporal | 13 | 0.2 | 0 | 0 |
| conflict_superseded | 12 | 0.2727 | 0 | 0 |
| paraphrase | 12 | 0.0167 | 0 | 11 |
| security_adversarial | 12 | 0.2 | 0 | 0 |

## 失败/差距样本（14 例）

- `ps-010` [project_scope]
  - extra: mem_fx0c0006
  - forbidden hits: mem_fx0c0006
  - critical: project_only_isolation
- `nm-002` [negative_no_memory]
  - extra: mem_fx0d0002
  - no-memory violated: returned mem_fx0d0002
  - critical: no_fabrication
- `nm-006` [negative_no_memory]
  - extra: mem_fx0a0005
  - no-memory violated: returned mem_fx0a0005
  - critical: no_fabrication
- `pp-001` [paraphrase]
  - missed: mem_fx0g0001
  - extra: mem_fx0a0001, mem_fx0a0002, mem_fx0a0003
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0001=LIMIT_TRUNCATED
- `pp-002` [paraphrase]
  - missed: mem_fx0g0002
  - extra: mem_fx0a0001, mem_fx0a0005, mem_fx0a0013
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0002=LIMIT_TRUNCATED
- `pp-003` [paraphrase]
  - missed: mem_fx0g0003
  - extra: mem_fx0a0007, mem_fx0a0012, mem_fx0a0016
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0003=LIMIT_TRUNCATED
- `pp-004` [paraphrase]
  - missed: mem_fx0g0004
  - extra: mem_fx0a0006, mem_fx0a0015, mem_fx0c0015
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0004=LIMIT_TRUNCATED
- `pp-005` [paraphrase]
  - missed: mem_fx0g0005
  - extra: mem_fx0a0003, mem_fx0b0014, mem_fx0d0002
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0005=LIMIT_TRUNCATED
- `pp-006` [paraphrase]
  - missed: mem_fx0g0006
  - extra: mem_fx0a0004, mem_fx0a0008, mem_fx0a0013
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0006=LIMIT_TRUNCATED
- `pp-007` [paraphrase]
  - missed: mem_fx0g0007
  - extra: mem_fx0a0007, mem_fx0a0011, mem_fx0c0005
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0007=LIMIT_TRUNCATED
- `pp-008` [paraphrase]
  - missed: mem_fx0g0008
  - extra: mem_fx0a0001, mem_fx0a0002, mem_fx0a0016
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0008=LIMIT_TRUNCATED
- `pp-009` [paraphrase]
  - missed: mem_fx0g0009
  - extra: mem_fx0a0005, mem_fx0a0015, mem_fx0b0010
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0009=LIMIT_TRUNCATED
- `pp-010` [paraphrase]
  - missed: mem_fx0g0010
  - extra: mem_fx0a0004, mem_fx0a0006, mem_fx0a0008
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0010=LIMIT_TRUNCATED
- `pp-012` [paraphrase]
  - missed: mem_fx0g0002
  - extra: mem_fx0a0001, mem_fx0a0002, mem_fx0a0003
  - critical: paraphrase_hit_top5
  - reason codes: mem_fx0g0002=LIMIT_TRUNCATED

## 回放与秘密

- replay hash: `b7a9b25030e4b932ee158327a2908e4e0ac2fdcce5141d0288fa5649ce02e8e0`
- secret leaks: 0
