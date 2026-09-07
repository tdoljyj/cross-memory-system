# Clued 文档导航

## 当前入口

1. [仓库当前状态](../CURRENT_STATUS.md)
2. [R5 内核架构与合同](r5-kernel/01-Architecture-and-Contract-Freeze.md)
3. [R5 K0 债务闭合](r5-kernel/02-K0-Debt-Closure.md)
4. [R3 Gate 终态资料](r3-gate3/R3-Gate3-Report.md)
5. [Phase 2 每步验收与失效规则](execution-plans/phase2-structure-governance/AcceptanceAndInvalidation.md) · [2026-09-07 Step 1 / Step 2 证据核对](execution-plans/phase2-structure-governance/Step01-Step02-EvidenceReview.md)（执行补充与证据记录，不签发接受或冻结）

## 目录含义

| 路径 | 内容 | 能否删除 |
|---|---|---|
| `docs/r5-kernel/` | R5 合同、迁移、测试和裁决证据 | 不可随意删除 |
| `docs/r3-gate*/` | R3 已封存 Gate 证据 | 不可随意删除 |
| `docs/history/` | 已退出当前入口、但仍需保留追溯的旧报告 | 可读，不作为当前状态 |
| 根目录 ADR / 基线文档 | 仍被合同、测试或其他文档按固定路径引用 | 暂时保留 |

## 版本名怎么读

- `vNext-1.3 / vNext-2.0 / vNext-2.1`：历史架构和评测阶段。
- `R3 / R4 / R5 / R5.1`：工程或 Gate 代际。
- `0.2.0`：最新冻结的候选产品版本。
- `0.3.0`：协议版本。
- `1.1.0`：内核合同版本。

旧报告只能证明历史决策和证据，不能覆盖 [CURRENT_STATUS.md](../CURRENT_STATUS.md) 中的当前状态。
