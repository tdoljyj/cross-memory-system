# Cross-Memory-System vNext-2.1 Gate 2R MIV-005B 词法可行性审计报告

- 授权：产品所有者裁决（MIV-005B 词法可行性审计；不授权直接修改生产召回；两本地提交不 push）
- 基线：`ac51480`（MIV-005A 正式 PASS 收口 HEAD）
- 探针：`memory_eval/bm25_probe.py`（现有 tokenizer + BM25 k1=1.2 / b=0.75；禁 synonym / 特判 / embedding / 网络 / 第三方分词；仅评测，不接入 `memory_engine/**`）
- 纪律：本报告只含 ID 与数值，零记忆正文泄漏

## 1. 假设策略指标（纯 BM25 排名、无 >1/6 准入门、保留 hard filters 与 T0 短路）

| 指标 | 实测 | Gate 2R 门槛 | 判定 |
| --- | ---: | ---: | --- |
| precision_at5_v2（全语料 111 例） | 0.71 | ≥ 0.90 | ❌ |
| critical_memory_recall_v2（golden 76） | 0.9342 | ≥ 0.95 | ❌ |
| false_recall_rate_v2（返回 100 / 错 29） | 0.29 | ≤ 0.02 | ❌ |
| hit_rate_at5 | 0.9286 | — | — |
| NO MEMORY | 39/41（违反 2） | 41/41 | ❌ |
| scope/project/superseded 泄漏 | 0 | 0 | ✅ |
| stale_recall_rate | 0.0 | 0 | ✅ |
| **全部门槛** | **未达成** | — | ❌ |

切片：

| 切片 | 例数 | precision_at5_v2 | critical_memory_recall_v2 | false_recall_rate_v2 | hit_rate_at5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| non_paraphrase | 99 | 0.9697 | 1.0 | 0.0303 | 1.0 |
| paraphrase | 12 | 0.2059 | 0.5833 | 0.7941 | 0.5833 |

## 2. 被 MIV-005A 过滤的 6 个正确 ID（纯 BM25 下的处境）

| case | id | overlap | bm25 | rank | top5 |
| --- | --- | ---: | ---: | ---: | --- |
| ps-007 | mem_fx0c0001 | 0 | 0.0 | 3 | Y |
| ps-007 | mem_fx0c0002 | 0 | 0.0 | 2 | Y |
| ps-007 | mem_fx0c0003 | 1 | 2.824 | 1 | Y |
| ps-016 | mem_fx0c0015 | 0 | 0.0 | 1 | Y |
| cs-008 | mem_fx0f0011 | 1 | 0.2519 | 1 | Y |
| cs-012 | mem_fx0f0011 | 0 | 0.0 | 2 | Y |

4/6 零重叠（bm25=0）：零重叠 → 纯 BM25 无法产生有效分数；top5=Y 仅因无准入门时 top-k 填充与 tie-break，非语义命中。

## 3. 12 个 paraphrase case 逐例（token overlap / BM25 score / rank / top5）

| case | q_tok | 零重叠 | 正确 ID | overlap | bm25 | rank | top5 |
| --- | ---: | --- | --- | ---: | ---: | ---: | --- |
| pp-001 | 10 | Y | mem_fx0g0001 | 0 | 0.0 | 3 | Y |
| pp-002 | 6 | Y | mem_fx0g0002 | 0 | 0.0 | 4 | N |
| pp-003 | 6 | Y | mem_fx0g0003 | 0 | 0.0 | 3 | Y |
| pp-004 | 7 | N | mem_fx0g0004 | 1 | 3.0645 | 4 | N |
| pp-005 | 3 | Y | mem_fx0g0005 | 0 | 0.0 | 3 | Y |
| pp-006 | 3 | Y | mem_fx0g0006 | 0 | 0.0 | 3 | Y |
| pp-007 | 3 | Y | mem_fx0g0007 | 0 | 0.0 | 4 | N |
| pp-008 | 3 | Y | mem_fx0g0008 | 0 | 0.0 | 4 | N |
| pp-009 | 3 | Y | mem_fx0g0009 | 0 | 0.0 | 4 | N |
| pp-010 | 3 | Y | mem_fx0g0010 | 0 | 0.0 | 3 | Y |
| pp-011 | 6 | N | mem_fx0g0001 | 4 | 15.3042 | 1 | Y |
| pp-012 | 3 | Y | mem_fx0g0002 | 0 | 0.0 | 3 | Y |

完全零重叠 10/12；pp-004 仅 1 个共享 token（仍 rank 4、不进 top5）；pp-011 4 个共享 token（rank 1）。零重叠 case 的 top5=Y 均为无准入门时的 top-k 填充/tie-break，非语义命中。

## 4. nm-002 / nm-006 与全部 41 个 NO MEMORY

| case | 类别 | q_tok | positive_bm25 | would_return | top5 |
| --- | --- | ---: | ---: | --- | --- |
| cs-009 | conflict_superseded | 7 | 0 | N |  |
| io-001 | implicit_observed | 7 | 0 | N |  |
| io-002 | implicit_observed | 9 | 0 | N |  |
| io-003 | implicit_observed | 9 | 0 | N |  |
| io-004 | implicit_observed | 11 | 0 | N |  |
| io-005 | implicit_observed | 9 | 0 | N |  |
| io-006 | implicit_observed | 9 | 0 | N |  |
| io-007 | implicit_observed | 9 | 0 | N |  |
| io-008 | implicit_observed | 7 | 0 | N |  |
| io-011 | implicit_observed | 8 | 0 | N |  |
| io-012 | implicit_observed | 9 | 0 | N |  |
| io-013 | implicit_observed | 8 | 0 | N |  |
| io-015 | implicit_observed | 6 | 0 | N |  |
| io-016 | implicit_observed | 9 | 0 | N |  |
| nm-001 | negative_no_memory | 3 | 0 | N |  |
| nm-002 | negative_no_memory | 12 | 1 | Y | mem_fx0d0002 |
| nm-003 | negative_no_memory | 7 | 0 | N |  |
| nm-004 | negative_no_memory | 9 | 0 | N |  |
| nm-005 | negative_no_memory | 6 | 0 | N |  |
| nm-006 | negative_no_memory | 7 | 1 | Y | mem_fx0a0005 |
| nm-007 | negative_no_memory | 7 | 0 | N |  |
| nm-008 | negative_no_memory | 8 | 0 | N |  |
| nm-009 | negative_no_memory | 1 | 0 | N |  |
| nm-010 | negative_no_memory | 7 | 0 | N |  |
| nm-011 | negative_no_memory | 6 | 0 | N |  |
| nm-012 | negative_no_memory | 7 | 0 | N |  |
| nm-013 | negative_no_memory | 6 | 0 | N |  |
| nm-014 | negative_no_memory | 3 | 0 | N |  |
| nm-015 | negative_no_memory | 8 | 0 | N |  |
| ps-005 | project_scope | 6 | 0 | N |  |
| ps-006 | project_scope | 9 | 0 | N |  |
| ps-015 | project_scope | 6 | 0 | N |  |
| sa-005 | security_adversarial | 6 | 0 | N |  |
| sa-012 | security_adversarial | 1 | 0 | N |  |
| tp-001 | temporal | 6 | 0 | N |  |
| tp-003 | temporal | 7 | 0 | N |  |
| tp-005 | temporal | 7 | 0 | N |  |
| tp-008 | temporal | 8 | 0 | N |  |
| tp-010 | temporal | 7 | 0 | N |  |
| tp-012 | temporal | 7 | 0 | N |  |
| tp-013 | temporal | 8 | 0 | N |  |

合计 41 例：纯 BM25 无准入门时 **39 例保持不返回**；仅 nm-002 / nm-006 两例会返回对象（各 1 个 positive_bm25 候选）→ NO MEMORY 39/41。生产上的 41/41 由 MIV-005A 的 >1/6 准入门提供，纯 BM25 排名自身没有「无关=不返回」判定。

## 5. 全部 111 例逐例（token overlap / 正确 ID 的 BM25 score / rank / top5 / 零重叠）

| case | 类别 | q_tok | 候选数 | 正确 ID | overlap | bm25 | rank | top5 | 零重叠 |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| cs-001 | conflict_superseded | 7 | 1 | mem_fx0f0002 | 3 | 7.0937 | 1 | Y | N |
| cs-002 | conflict_superseded | 9 | 2 | mem_fx0f0002 | 3 | 7.0937 | 2 | Y | N |
| cs-002 | conflict_superseded | 9 | 2 | mem_fx0f0001 | 3 | 7.3798 | 1 | Y | N |
| cs-003 | conflict_superseded | 8 | 1 | mem_fx0f0004 | 5 | 16.2272 | 1 | Y | N |
| cs-004 | conflict_superseded | 6 | 1 | mem_fx0f0005 | 3 | 12.8331 | 1 | Y | N |
| cs-005 | conflict_superseded | 7 | 1 | mem_fx0f0008 | 3 | 10.9148 | 1 | Y | N |
| cs-006 | conflict_superseded | 8 | 2 | mem_fx0f0008 | 3 | 10.9148 | 2 | Y | N |
| cs-006 | conflict_superseded | 8 | 2 | mem_fx0f0007 | 3 | 11.3735 | 1 | Y | N |
| cs-007 | conflict_superseded | 9 | 1 | mem_fx0f0011 | 2 | 3.4124 | 1 | Y | N |
| cs-008 | conflict_superseded | 11 | 1 | mem_fx0f0011 | 1 | 0.2519 | 1 | Y | N |
| cs-009 | conflict_superseded | 7 | 0 | - | - | - | - | - | - |
| cs-010 | conflict_superseded | 5 | 1 | mem_fx0f0002 | 1 | 0.2519 | 1 | Y | N |
| cs-011 | conflict_superseded | 9 | 2 | mem_fx0a0002 | 1 | 4.1385 | 1 | Y | N |
| cs-011 | conflict_superseded | 9 | 2 | mem_fx0a0013 | 1 | 3.8511 | 2 | Y | N |
| cs-012 | conflict_superseded | 8 | 2 | mem_fx0f0009 | 1 | 3.9216 | 1 | Y | N |
| cs-012 | conflict_superseded | 8 | 2 | mem_fx0f0011 | 0 | 0.0 | 2 | Y | N |
| ep-001 | explicit_preference | 9 | 1 | mem_fx0a0001 | 4 | 10.3313 | 1 | Y | N |
| ep-002 | explicit_preference | 11 | 1 | mem_fx0a0002 | 4 | 7.5994 | 1 | Y | N |
| ep-003 | explicit_preference | 10 | 1 | mem_fx0a0003 | 2 | 4.0215 | 1 | Y | N |
| ep-004 | explicit_preference | 10 | 1 | mem_fx0a0004 | 4 | 7.5792 | 1 | Y | N |
| ep-005 | explicit_preference | 9 | 1 | mem_fx0a0005 | 6 | 18.8022 | 1 | Y | N |
| ep-006 | explicit_preference | 11 | 1 | mem_fx0a0006 | 4 | 12.1485 | 1 | Y | N |
| ep-007 | explicit_preference | 11 | 1 | mem_fx0a0007 | 2 | 3.6025 | 1 | Y | N |
| ep-008 | explicit_preference | 9 | 1 | mem_fx0a0008 | 6 | 20.0899 | 1 | Y | N |
| ep-009 | explicit_preference | 10 | 1 | mem_fx0a0010 | 3 | 5.9779 | 1 | Y | N |
| ep-010 | explicit_preference | 6 | 1 | mem_fx0a0011 | 3 | 10.0144 | 1 | Y | N |
| ep-011 | explicit_preference | 9 | 1 | mem_fx0a0012 | 1 | 2.6449 | 1 | Y | N |
| ep-012 | explicit_preference | 7 | 1 | mem_fx0a0013 | 1 | 3.8511 | 1 | Y | N |
| ep-013 | explicit_preference | 7 | 1 | mem_fx0a0014 | 1 | 4.299 | 1 | Y | N |
| ep-014 | explicit_preference | 10 | 1 | mem_fx0a0015 | 4 | 12.2027 | 1 | Y | N |
| ep-015 | explicit_preference | 9 | 1 | mem_fx0a0016 | 3 | 12.4156 | 1 | Y | N |
| io-001 | implicit_observed | 7 | 0 | - | - | - | - | - | - |
| io-002 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| io-003 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| io-004 | implicit_observed | 11 | 0 | - | - | - | - | - | - |
| io-005 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| io-006 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| io-007 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| io-008 | implicit_observed | 7 | 0 | - | - | - | - | - | - |
| io-009 | implicit_observed | 8 | 1 | mem_fx0b0009 | 4 | 9.6517 | 1 | Y | N |
| io-010 | implicit_observed | 8 | 1 | mem_fx0b0010 | 4 | 11.7114 | 1 | Y | N |
| io-011 | implicit_observed | 8 | 0 | - | - | - | - | - | - |
| io-012 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| io-013 | implicit_observed | 8 | 0 | - | - | - | - | - | - |
| io-014 | implicit_observed | 9 | 1 | mem_fx0b0014 | 6 | 22.073 | 1 | Y | N |
| io-015 | implicit_observed | 6 | 0 | - | - | - | - | - | - |
| io-016 | implicit_observed | 9 | 0 | - | - | - | - | - | - |
| nm-001 | negative_no_memory | 3 | 0 | - | - | - | - | - | - |
| nm-002 | negative_no_memory | 12 | 1 | - | - | - | - | - | - |
| nm-003 | negative_no_memory | 7 | 0 | - | - | - | - | - | - |
| nm-004 | negative_no_memory | 9 | 0 | - | - | - | - | - | - |
| nm-005 | negative_no_memory | 6 | 0 | - | - | - | - | - | - |
| nm-006 | negative_no_memory | 7 | 1 | - | - | - | - | - | - |
| nm-007 | negative_no_memory | 7 | 0 | - | - | - | - | - | - |
| nm-008 | negative_no_memory | 8 | 0 | - | - | - | - | - | - |
| nm-009 | negative_no_memory | 1 | 0 | - | - | - | - | - | - |
| nm-010 | negative_no_memory | 7 | 0 | - | - | - | - | - | - |
| nm-011 | negative_no_memory | 6 | 0 | - | - | - | - | - | - |
| nm-012 | negative_no_memory | 7 | 0 | - | - | - | - | - | - |
| nm-013 | negative_no_memory | 6 | 0 | - | - | - | - | - | - |
| nm-014 | negative_no_memory | 3 | 0 | - | - | - | - | - | - |
| nm-015 | negative_no_memory | 8 | 0 | - | - | - | - | - | - |
| pp-001 | paraphrase | 10 | 5 | mem_fx0g0001 | 0 | 0.0 | 3 | Y | Y |
| pp-002 | paraphrase | 6 | 4 | mem_fx0g0002 | 0 | 0.0 | 4 | N | Y |
| pp-003 | paraphrase | 6 | 4 | mem_fx0g0003 | 0 | 0.0 | 3 | Y | Y |
| pp-004 | paraphrase | 7 | 4 | mem_fx0g0004 | 1 | 3.0645 | 4 | N | N |
| pp-005 | paraphrase | 3 | 4 | mem_fx0g0005 | 0 | 0.0 | 3 | Y | Y |
| pp-006 | paraphrase | 3 | 4 | mem_fx0g0006 | 0 | 0.0 | 3 | Y | Y |
| pp-007 | paraphrase | 3 | 4 | mem_fx0g0007 | 0 | 0.0 | 4 | N | Y |
| pp-008 | paraphrase | 3 | 4 | mem_fx0g0008 | 0 | 0.0 | 4 | N | Y |
| pp-009 | paraphrase | 3 | 4 | mem_fx0g0009 | 0 | 0.0 | 4 | N | Y |
| pp-010 | paraphrase | 3 | 4 | mem_fx0g0010 | 0 | 0.0 | 3 | Y | Y |
| pp-011 | paraphrase | 6 | 1 | mem_fx0g0001 | 4 | 15.3042 | 1 | Y | N |
| pp-012 | paraphrase | 3 | 4 | mem_fx0g0002 | 0 | 0.0 | 3 | Y | Y |
| ps-001 | project_scope | 6 | 1 | mem_fx0c0001 | 1 | 3.0716 | 1 | Y | N |
| ps-002 | project_scope | 6 | 1 | mem_fx0c0002 | 3 | 13.4069 | 1 | Y | N |
| ps-003 | project_scope | 6 | 1 | mem_fx0c0003 | 3 | 12.3733 | 1 | Y | N |
| ps-004 | project_scope | 6 | 1 | mem_fx0c0004 | 2 | 4.7344 | 1 | Y | N |
| ps-005 | project_scope | 6 | 0 | - | - | - | - | - | - |
| ps-006 | project_scope | 9 | 0 | - | - | - | - | - | - |
| ps-007 | project_scope | 8 | 3 | mem_fx0c0001 | 0 | 0.0 | 3 | Y | N |
| ps-007 | project_scope | 8 | 3 | mem_fx0c0002 | 0 | 0.0 | 2 | Y | N |
| ps-007 | project_scope | 8 | 3 | mem_fx0c0003 | 1 | 2.824 | 1 | Y | N |
| ps-008 | project_scope | 8 | 1 | mem_fx0c0008 | 4 | 13.7291 | 1 | Y | N |
| ps-009 | project_scope | 8 | 1 | mem_fx0c0009 | 5 | 21.2278 | 1 | Y | N |
| ps-010 | project_scope | 8 | 1 | mem_fx0c0001 | 1 | 3.0716 | 1 | Y | N |
| ps-011 | project_scope | 8 | 1 | mem_fx0c0010 | 5 | 20.6539 | 1 | Y | N |
| ps-012 | project_scope | 9 | 1 | mem_fx0c0011 | 5 | 15.7011 | 1 | Y | N |
| ps-013 | project_scope | 9 | 1 | mem_fx0c0012 | 7 | 27.8522 | 1 | Y | N |
| ps-014 | project_scope | 9 | 1 | mem_fx0c0013 | 2 | 5.9887 | 1 | Y | N |
| ps-015 | project_scope | 6 | 0 | - | - | - | - | - | - |
| ps-016 | project_scope | 8 | 1 | mem_fx0c0015 | 0 | 0.0 | 1 | Y | Y |
| sa-001 | security_adversarial | 7 | 1 | mem_fx0h0001 | 4 | 8.9742 | 1 | Y | N |
| sa-002 | security_adversarial | 7 | 1 | mem_fx0a0001 | 2 | 7.1644 | 1 | Y | N |
| sa-003 | security_adversarial | 10 | 1 | mem_fx0h0002 | 6 | 16.5207 | 1 | Y | N |
| sa-004 | security_adversarial | 6 | 1 | mem_fx0h0003 | 3 | 12.4156 | 1 | Y | N |
| sa-005 | security_adversarial | 6 | 0 | - | - | - | - | - | - |
| sa-006 | security_adversarial | 8 | 1 | mem_fx0h0005 | 4 | 13.4755 | 1 | Y | N |
| sa-007 | security_adversarial | 6 | 1 | mem_fx0h0006 | 2 | 6.3464 | 1 | Y | N |
| sa-008 | security_adversarial | 9 | 1 | mem_fx0h0007 | 3 | 9.2941 | 1 | Y | N |
| sa-009 | security_adversarial | 11 | 1 | mem_fx0h0008 | 6 | 19.6881 | 1 | Y | N |
| sa-010 | security_adversarial | 9 | 1 | mem_fx0h0009 | 3 | 9.1807 | 1 | Y | N |
| sa-011 | security_adversarial | 10 | 1 | mem_fx0h0010 | 2 | 6.5627 | 1 | Y | N |
| sa-012 | security_adversarial | 1 | 0 | - | - | - | - | - | - |
| tp-001 | temporal | 6 | 0 | - | - | - | - | - | - |
| tp-002 | temporal | 6 | 1 | mem_fx0e0001 | 4 | 14.2539 | 1 | Y | N |
| tp-003 | temporal | 7 | 0 | - | - | - | - | - | - |
| tp-004 | temporal | 6 | 1 | mem_fx0e0003 | 2 | 4.9333 | 1 | Y | N |
| tp-005 | temporal | 7 | 0 | - | - | - | - | - | - |
| tp-006 | temporal | 7 | 1 | mem_fx0e0004 | 1 | 3.4984 | 1 | Y | N |
| tp-007 | temporal | 8 | 1 | mem_fx0e0005 | 3 | 11.5533 | 1 | Y | N |
| tp-008 | temporal | 8 | 0 | - | - | - | - | - | - |
| tp-009 | temporal | 7 | 1 | mem_fx0e0008 | 4 | 14.8874 | 1 | Y | N |
| tp-010 | temporal | 7 | 0 | - | - | - | - | - | - |
| tp-011 | temporal | 7 | 1 | mem_fx0e0007 | 2 | 7.2578 | 1 | Y | N |
| tp-012 | temporal | 7 | 0 | - | - | - | - | - | - |
| tp-013 | temporal | 8 | 0 | - | - | - | - | - | - |

## 6. 结论

单一固定词法策略（现有 tokenizer + BM25 k1=1.2/b=0.75）**不满足** Gate 2R 指标门槛（0.71 / 0.9342 / 0.29 / NO MEMORY 39-41）：词法路线在共享词面 token 的 non_paraphrase 切片可达 precision 0.9697 / recall 1.0，但 10/12 paraphrase 完全零重叠（bm25=0，纯 BM25 无法产生有效分数）、nm-002/nm-006 无准入门时必返回对象。**如实报告词法上限并停止；不修改生产代码；Reflection 仍不启动；Embedding ADR 需下一次单独裁决。**

## 7. 冻结与合规

- 探针 replay hash（两次运行一致）：`4e4562f13c6ad35f3bba604f8638bfd9973c85924c36ea9f89362008a6bad563`
- 原评测 replay hash `f4266eabd2bed94d…` 与全部冻结指标不变；既有 326 项全绿 + 新增 `tests/test_bm25_probe.py` 10 项
- `memory_engine/**`、>1/6 阈值、conflict→admission→limit 顺序、corpus、fixtures、golden、objects、index、v1 基线、同步层、Clued、协议清单零改动；doctor 三件套 ALL PASS；密钥扫描 0 命中

## 8. 正式裁决记录（2026-08-19 产品所有者裁决）

> 追加记录；第 1–7 节全部历史内容保持不变。

- **MIV-005B 词法可行性审计：PASS（正式）**。
- **本地词法 / BM25 生产接入：NO-GO**（接受本报告关键结论：零分候选进入 top-k 的 recall 非真实相关性恢复；10/12 paraphrase 零重叠当前 tokenizer + BM25 无法解决；去准入门使 NO MEMORY 39/41、false recall 0.29；不得引入 query 特判 / 手工同义词 / 降低 >1/6 门槛）。
- **Gate 2R 质量目标尚未达到；Reflection 继续阻断**。
- **后续路线 = Embedding ADR**（本轮不授权实施、不授权模型下载）；生命周期独立工作项继续排队不启动。
- 授权纯文档收口提交 `docs: record MIV-005B lexical NO-GO` 与普通 fast-forward push；未推送范围 = `a4c2250` + `da9d550` + 收口提交；push 后 local HEAD = remote main、0/0；不 tag / release。
