# Clued Current Governance Inventory — Repository Projection

> **Repository-side read-only projection. NOT Canonical, NOT Authority, NOT Frozen.**

- Projection ID: `CLUED-MULTITRACK-REPOSITORY-PROJECTION-v0.1-20260916`
- Source Snapshot: `CLUED-CURRENT-PRIORITY-SNAPSHOT-v0.1.3-SOURCE-BOUND-20260912`
- Source Inventory: `CLUED-CURRENT-GOVERNANCE-INVENTORY-v0.1.3-SOURCE-BOUND-20260912`
- Source date: `2026-09-12`
- Source JSON SHA-256: `bca8fd9244657beabe09a3f815295e09d5207b4709f11ab8722d9a8d58491f5f`
- Projection manifest canonical SHA-256: `544ef822c558f47bdf13dd3f4ddca362629abbce62ef7d14b7a5386134852aea`
- Authority effect: `NONE`
- Writeback: `FORBIDDEN`
- Freshness: `HISTORICAL_SOURCE_BOUND_REQUIRES_RECONCILIATION_BEFORE_CANONICAL_CURRENT_CLAIM`

## Authority boundary

生产/在线权威仍只来自经认证的 Clued Canonical Store（Supabase-backed service）。本文件、Manifest 与四条 Track JSON 只把治理 Inventory 投影进 Repository，供研发、审查、CI、Agent 路由和零记忆恢复读取；它们不得反向写回业务 Canon，也不得仅凭 Git 状态宣布 Current / Frozen / Authority。

## Projection layout

| Track | Machine projection | Items | Canonical SHA-256 |
|---|---|---:|---|
| `E` · 工程与平台 | `development/projections/multitrack/tracks/E.items.json` | 18 | `c037de8547b747fdbf957e2f0ea3b80f8056290eecc3c435dd8c53a3a1033ab2` |
| `P` · 产品与体验 | `development/projections/multitrack/tracks/P.items.json` | 14 | `b688aa5b4428cc768db2774ca764ddf646fe4384ec5f2ab56041d4d21bd27366` |
| `R` · 基础研究 | `development/projections/multitrack/tracks/R.items.json` | 10 | `f00e9edb201be786ad8e48846065829fd397dcb28e2bf2ed00f7e3026bc9c2dc` |
| `B` · 商业与增长 | `development/projections/multitrack/tracks/B.items.json` | 7 | `6ac381acb5132111432ec7d90a432c8580c2744f028d8478a2cc58693f148805` |

## Current Priority Frontier (source-bound)

| Track | Frontier | Source-bound note |
|---|---|---|
| **E · 工程与平台** | `E-001`, `E-008` | `E-001` 是严格主链第一优先；`E-008` 仅允许非阻塞 Bootstrap/Inventory 工作。 |
| **P · 产品与体验** | `P-006`, `P-004` | 可继续评审/设计，但不得抢占 Kernel 主链资源；Product Runtime 主链仍被 `E-007` 前置阻塞。 |
| **R · 基础研究** | `R-002`, `R-004`, `R-005`, `R-006` | 长期并行；当前优先 GIKAO + Currentness + Authority + Evidence。 |
| **B · 商业与增长** | `B-002`, `B-003` | 可做低成本验证与模型维护，但不抢占 Kernel 主工程资源。 |

## Snapshot summary

| Track | 状态摘要 |
|---|---|
| E | 18 items：6 COMPLETED / 2 IN_PROGRESS / 2 WAITING / 2 DEFERRED / 6 NOT_STARTED |
| P | 14 items：5 COMPLETED / 1 VERIFYING / 1 READY / 7 BLOCKED |
| R | 10 items：1 COMPLETED / 2 IN_PROGRESS / 7 READY |
| B | 7 items：1 COMPLETED / 3 READY / 3 WAITING |

- Total items: **49**
- Strict engineering frontier: `E-001`
- Nonblocking bootstrap: `E-008`
- Hard identity conflicts: `E-010`

`E-010` 必须继续保持 fail-closed：当前 Repository 投影不凭聊天历史或候选文件猜测最新 Freeze/Current 身份，直到能绑定可重放的 Canonical Freeze Event/Receipt。

## Update protocol

1. 从 Clued Canonical Export / source-bound governance snapshot 获取新来源，不从本 Markdown 手工改业务真相。
2. 生成新的 Manifest + Track shards，并保留稳定 Priority Item ID。
3. 运行 `python scripts/governance/validate_multitrack_projection.py`。
4. 通过 PR / Review / CI 更新 Repository。
5. Validator PASS 只证明 Repository 投影完整；不等于 Inventory 被 Canonical Freeze，也不授权生产、Kernel、数据库或 Provider 动作。
