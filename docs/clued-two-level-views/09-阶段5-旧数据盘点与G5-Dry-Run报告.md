# 阶段 5：旧数据盘点与 G5 Dry-Run 报告

> 状态：G5 REVIEW CANDIDATE（待用户批准，不等于 G5 PASS）
>
> 日期：2026-08-24
>
> 分支：`feat/clued-two-level-views-v1`；源快照 commit：`a11d73c139561d61cb3a2caaf3e3280771ac5562`
>
> 边界：只读盘点与本地派生文件；未写生产数据库、未应用 migration、未启用 `PROJECT_VIEWS_V2`、未部署 Worker。

## 1. 结论

阶段 5 的只读盘点、稳定 ID/来源映射、重复引用化和 Dry-Run 已完成。当前结果可进入 G5 人工评审，但未获用户批准前不得进入阶段 6。

- 5 个 Markdown 旧数据源全部纳入 SHA-256 清单。
- 生产 Supabase 仅执行 SELECT 元数据查询，没有读取用户 ID、token hash、原始日志正文或原始事件 payload。
- 共解析 820 条候选；稳定 ID 820/820 唯一，引用完整性 15/15，断链 0。
- 207 条为后续迁移候选；572 条项目日志事件仅保留为 legacy evidence；15 条精确重复只建立 `duplicate_of` 引用；26 条暂停自动分类并进入人工复核。
- 来源、日期线索、理由、失败、阻塞、撤回和证据均以来源引用、内容哈希与语义指示器保留；本阶段不复制正文到数据库。

## 2. 可重复执行

在仓库根的 `apps/clued-cloud` 下运行：

```bash
npm run stage5:dry-run
node --test tests/stage5-legacy-dry-run.test.mjs
```

脚本通过 `git show <source-commit>:<path>` 只读固定 commit 中的 5 个 Markdown 源，并读取脱敏生产快照后输出本地 JSON。`--as-of` 为必填固定时间，避免同一输入产生时间漂移。脚本不包含网络调用、数据库客户端、migration、功能开关或部署逻辑。

产物：

- `apps/clued-cloud/scripts/stage5-legacy-dry-run.mjs`
- `docs/clued-two-level-views/stage5-production-readonly-snapshot.json`
- `docs/clued-two-level-views/stage5-legacy-dry-run.json`

## 3. 只读生产快照

生产目标：Supabase `clued-prod`（ref `ccxsikzwxlolxqlosril`，PostgreSQL 17.6.1）。实际 production migration 只有：

1. `20260823154017_mandatory_continuity_002`
2. `20260823182409_clued_memory_crud`
3. `20260823182517_harden_clued_memory_grants`

因此，项目生命周期 003 和 Unified Record V2 均未进入生产，`PROJECT_VIEWS_V2` 仍关闭。

安全元数据结果：

| 对象 | 只读结果 |
|---|---:|
| `project:clued` stream/head version | 3 / 3 |
| Events / Checkpoints / Log Versions | 2 / 1 / 1 |
| Log Version 1 SHA-256 | `49c50ed4d11844c0d8cf6108cb261dc324b8a30c7d8f333596677d44c1820869` |
| Audit Receipts / Agent Bindings | 5 / 2 |
| Continuity Sessions | 2（active 0、ended 1、expired-unended 1） |
| Legacy `clued_memories` / audit | 0 / 0 |
| 生产写入 | 0 |

旧 CRUD 当前为 0 行，因此不存在需要合并的生产 Memory 正文。Continuity 的 Event、Checkpoint 与 Log Version 继续原位只读保留，不提升为 V2 current truth。

## 4. Markdown 快照清单

| 来源 | 字节 | 行数 | SHA-256 | 权威性 |
|---|---:|---:|---|---|
| `memory/状态.md` | 12,536 | 57 | `1da0e21ffeabc3199008911aa00051b2cccc8bd4c5856a122afd4b14ac714e91` | current |
| `memory/待办.md` | 11,059 | 76 | `d8ba4d010a383ca9bde4988a952bebd3eab13ebea68eeccc3b6d5a561da3ed38` | current |
| `memory/决策.md` | 8,307 | 43 | `5b2c69be547741205ec5ae2af75fc3b90eaebb5f3ee5f4134a868c654fbeee1a` | current |
| `memory/归档.md` | 31,068 | 180 | `992e88b3b0d4ddefbfe26dc73126ab843760ed61cb09808fcbce4a3f06bbca78` | history |
| `memory/contexts/projects/clued/日志.md` | 68,432 | 1,097 | `f97ca342797b2040336092dea902beeb03b415ae9c59b3ace50927dbbcd7ff8c` | legacy evidence only |

每条候选的稳定 ID 为 `legacy-` 加来源路径、行号、标题和规范化内容的 SHA-256 前 24 位。内容哈希独立保存；源快照固定到 commit `a11d73c139561d61cb3a2caaf3e3280771ac5562`，后续连续性记录不会改变本次盘点依据。

## 5. Dry-Run 数量与差异解释

### 5.1 记录类型

| 类型 | 数量 |
|---|---:|
| State | 37 |
| Task | 58 |
| Decision | 33 |
| Archive Snapshot | 105 |
| Event / Legacy Log Evidence | 587 |
| 合计 | 820 |

### 5.2 迁移处置

| 处置 | 数量 | 解释 |
|---|---:|---|
| `candidate` | 207 | 可进入下一轮语义审核的非日志、非重复候选 |
| `manual_review` | 26 | 不猜测项目 ID 或冲突语义，暂停自动导入 |
| `reference_only` | 15 | 精确重复；只指向首个稳定 ID，不复制正文 |
| `retain_legacy_only` | 572 | 旧项目日志只保留证据，不作为 current truth |
| 合计 | 820 | 与解析总数一致 |

`587 个 Event = 572 个 legacy-only + 15 个重复引用`。因此不丢日志记录，也不会把 587 条历史事件复制成当前 State/Task/Decision。

若 G5 按本报告批准，下一阶段的自动迁移上限是 207 条，而不是 820 条；26 条人工复核项在明确裁决前保持只读旧源，不计入自动导入。该数量差异完全由日志排除、重复引用化和风险暂停三类规则解释。

## 6. 高风险人工复核

| 风险 | 数量 | Dry-Run 处置 | G5 建议裁决 |
|---|---:|---|---|
| 无稳定项目 ID | 23 | `manual_review` | 暂保留 Global/旧源，不为游戏原型、剧情或工作室猜造项目 ID；等 Registry 有稳定 ID 后再映射 |
| 疑似相互矛盾的 current State | 2 | `manual_review` | 两项均含历史“冲突”叙述，不自动作为 current；后续人工决定转 Archive/Note 或保留 Global State |
| 跨项目标题/正文语义 | 1 | `manual_review` | Clued 部署事实落在“工作室”标题下；正文已识别 `project_id=clued`，但不在 G5 前自动导入 |
| 项目别名冲突 | 0 | 无 | 当前快照未发现需自动合并的别名 |

26 条明细均在 `stage5-legacy-dry-run.json` 中保留稳定 ID、来源行、预览、哈希和 `review_reasons`。建议 G5 批准以上“保守不导入”处置，不把人工复核项强行降级为自动候选。

## 7. 语义保全与完整性

Dry-Run 识别并保留以下线索计数：

| 语义线索 | 数量 |
|---|---:|
| 理由/依据 | 17 |
| 失败/故障 | 59 |
| 阻塞/等待 | 23 |
| 撤回/否决/替代 | 19 |
| 测试/验收/哈希/提交证据 | 151 |

这些计数不是最终业务类型判断，而是防止后续转换静默丢掉关键语义的审计标记。所有条目均可经 `source_ref + source_line + content_sha256` 回到原文。

完整性检查：

- 稳定 ID：820 个候选，820 个唯一 ID。
- 精确重复：15 个，全部有 `duplicate_of`；断链 0。
- 来源文件：5/5 有字节数、行数和 SHA-256。
- Dry-Run JSON SHA-256：`13953d3b63bd11ade2b929a162cab47b8b8a21a39174bb15135c28e87fafbbc0`；写入阶段 5 连续性记录后从固定 source commit 重跑，哈希保持不变。
- 生产快照：SELECT-only，原始正文和凭据未进入报告。
- 旧 `日志.md`：保留原文件，权威性固定为 `legacy_evidence_only`。

## 8. 回滚与停止线

本阶段没有生产数据变更，因此回滚只需丢弃本地派生 JSON/报告；旧 Markdown、生产 Continuity 与旧 CRUD schema/data 均未改变。用户已授权阶段 5，但尚未授权：

- 应用 003 或 Unified Record V2 migration；
- 向生产导入任何候选；
- 启用 `PROJECT_VIEWS_V2`；
- 部署 Worker；
- 进入阶段 6。

## 9. G5 审批项

建议 G5 批准以下四点：

1. 接受 `207 candidate + 26 manual review + 15 reference only + 572 legacy only = 820` 的差异解释。
2. 接受 26 条高风险项全部保持“不自动导入”的保守处置。
3. 接受项目日志只作为 legacy evidence，永不直接提升为 current truth。
4. 接受阶段 5 只形成 Dry-Run 证据，不执行生产迁移或发布。

在用户明确“确认 G5”之前，状态保持 `G5 REVIEW CANDIDATE`，停止在阶段 5。
