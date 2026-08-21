# R4 Gate 0-D · Hybrid Recall Contract Report

日期：2026-08-21  
分支：`r4-gate0-r2`  
执行起点：`77636b45121a74ce0e247affb7924c50b5f01843`  
Gate 结论：**PASS（仅 Gate 0-D）**

> 本 Gate 只证明 Hybrid 合同与显式 test/shadow 接线。`semantic_mode` 默认仍为
> `off`；本报告中的参数只用于合同 smoke，不是 Gate 0-E calibration 结果。

## 1. 变更范围与默认关闭

- 新增 `memory_engine/hybrid_recall.py`：固定 OR 准入、hybrid 分数、完整
  tie-break、SafeVectorRuntime、去正文 Trace、稳定 fallback code。
- 修改 `memory_engine/recall_engine.py`：增加 `semantic_mode`、`vector_runtime`、
  `alpha`、`tau` 可选参数；T0/T4/temporary 仍在模块导入和缓存读取之前短路。
- 修改 `memory_engine/embedding_adapter.py`：暴露加载前已验证的
  `MODEL-MANIFEST.json` 文件 SHA-256，供 query runtime 与 index 三重绑定。
- 新增 `tests/test_hybrid_recall.py`。

允许模式只有 `off`、`test`、`shadow`；不存在 `production` 模式。默认 `off`
不导入 hybrid/vector 模块、不读取缓存、不调用模型，既有 `RecallResult.to_dict()`
不增加字段。

## 2. 固定执行顺序

显式 test/shadow 路径严格执行：

1. T0/T4/temporary 零读取短路；
2. category、scope/project/session、status、temporal、selector、priority 硬过滤；
3. 对手工损坏 canonical 再排除 secret、denied、temporary；
4. 计算原 MIV-005A lexical score；
5. conflict 决胜，移除 `CONFLICT_LOSER`；
6. 只把 survivors 的 ID 交给 SafeVectorRuntime 计算 cosine；
7. 执行增量 OR；
8. 按固定 tie-break 排序；
9. limit 与 constraints packing。

向量不会生成候选，也不会让 scope/status/temporal/conflict loser 复活。

## 3. 准入与排序公式

准入严格保持：

```text
lexical_admit = selector(tags/entities) OR lexical_score > 1/6
vector_admit  = cosine > τ
admit         = lexical_admit OR vector_admit
```

全部比较为严格大于；测试已证明 `cosine == τ` 被排除。lexical 已准入对象即使
cosine 为负也不会被取消。

排序使用未舍入原始 float：

```text
lex_norm = lexical_score / (lexical_score + 1)
hybrid   = α * lex_norm + (1 - α) * max(0, cosine)

hybrid DESC
priority_weight DESC
evidence_weight DESC
updated_at DESC
object_id ASC
```

只有 Trace 展示值 round 到 6 位；判定和排序不 round。

## 4. Runtime 完整性与整体回退

SafeVectorRuntime 在 query embedding 前逐项核验：

- `BUILD.lock` 不存在；
- `DIRTY.json` 不存在；
- `CURRENT.json`、index schema、serializer、manifest self-hash；
- rows/vectors size 与 SHA-256、行数、维度；
- index `model_manifest_digest`；
- live canonical source fingerprint；
- 实际 embedder 的 manifest 文件摘要；
- embedder model id / immutable revision 与 index 完全相等。

任一异常都不返回部分混合结果。本次查询整体回到原 MIV-005A。`explain=False`
时 `RecallResult.to_dict()` 与直接 MIV-005A 结果逐字节等价；运行态 reason code
保存在不序列化的 `semantic_status`，`explain=True` 时进入去正文 Trace。

稳定 fallback code：

- `HYBRID_RUNTIME_UNAVAILABLE`
- `HYBRID_INDEX_UNAVAILABLE`
- `HYBRID_INDEX_DIRTY`
- `HYBRID_INDEX_BUILDING`
- `HYBRID_SOURCE_FINGERPRINT_MISMATCH`
- `HYBRID_MODEL_INFERENCE_ERROR`
- `HYBRID_HISTORY_UNSUPPORTED`

history 模式本 Gate 不做向量检索，整体回退现有 history 语义。

## 5. Hybrid Trace

Trace version：`r4-g0-hybrid-v1`。成功选中项字段精确为：

```text
memory_id, lexical, cosine, hybrid,
admission_source, rank, reason_codes
```

顶层只含随机 `trace_id`、mode、model id/revision/manifest digest、selected、
excluded 与 fallback code。不得含原始 query、Memory Object 正文、source_ref、
文件路径、原始 project/session ID、token 或向量数组。异常文本不进入 Trace。

真实 E5 smoke 的 post-check：`HYBRID_ACTIVE`、5 个 ID、fallback=null；Trace
未出现合成 query 或 `content` 字段，selected 字段集合与上表完全相等。

## 6. 测试与回归

`tests/test_hybrid_recall.py`：**12 PASS / 0 FAIL / 0 SKIP**，覆盖：

1. 默认 off 与 MIV-005A 字节等价且 runtime 零调用；
2. T0/T4/temporary 零模型/缓存调用；
3. 增量 OR、`cosine == τ` 排除；
4. lexical 保留；
5. scope 与 conflict 在 cosine 前；
6. secret/denied/temporary 在任何评分前排除；
7. 五级确定性 tie-break；
8. 推理异常整体 fallback + 去正文 Trace；
9. SafeVectorRuntime index/cosine 集成；
10. dirty、篡改、source mismatch 整体 fallback；
11. embedder manifest identity mismatch 归因 model fallback；
12. 非法模式/参数 fail-closed。

默认路径回归：

- `tests/test_memory_eval.py`：**19 PASS / 0 FAIL**；冻结 MIV-005A 指标合同未变；
- `tests/test_memory_v2.py`：**55 PASS / 0 FAIL**；
- `tests/test_relevance_admission.py`：**15 PASS / 0 FAIL**；
- `tests/test_recall_trace.py`：**19 PASS / 0 FAIL**；
- `tests/test_project_scope.py`：**14 PASS / 0 FAIL**。

## 7. Gate 0-D 退出条件

| 条件 | 结果 |
|---|---|
| 新能力默认 off | PASS |
| 硬过滤后才计算 cosine | PASS |
| conflict 在 OR 准入前完成 | PASS |
| `MIV_005A_admit OR cosine > τ` | PASS |
| hybrid 与完整 tie-break | PASS |
| T0/T4/temporary 零模型/缓存 | PASS |
| 任一构件异常整体 fallback | PASS |
| fallback MIV-005A 字节等价 | PASS |
| Trace 零 query/正文/向量/secret | PASS |
| 默认行为回归 | PASS |

Gate 0-D = **PASS**。下一阶段 Gate 0-E 只能读取冻结 calibration 53 cases，执行
固定 60 组合网格；本 Gate smoke 参数不得继承为候选参数。
