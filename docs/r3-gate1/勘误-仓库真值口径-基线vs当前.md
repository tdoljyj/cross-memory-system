# Gate 1 勘误：仓库真值口径（基线 vs 当前状态）

- **状态**：勘误（Gate 1 裁决要求：区分 Gate 0 起始基线 与 Gate 0 完成后 当前状态）
- **依据**：Gate 1 授权裁决原文 ——"既然已有本地提交 2a024c4 → b4fcb15，当前 local HEAD 不可能仍是 9dcc31b"
- **修正对象**：Gate 0 报告与 R3-001 矩阵中一切把 `local HEAD = 9dcc31b` 当作"当前"的表述

## 1. 勘误后的真值表述

### Gate 0 起始基线（2026-08-19T13:08:39Z 现场核验）

| 项 | 值 |
|---|---|
| local HEAD | `9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb` |
| remote main | `9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb` |
| ahead/behind | 0 / 0 |
| worktree | clean（仅 `.gate-t0-workspace/`、`.gate0-workspace/` untracked） |

### Gate 0 完成后（2026-08-19T13:21:40Z Gate 1 启动现场复核）

| 项 | 值 |
|---|---|
| local HEAD | `b4fcb154a65402cb88a6adb6b0140e7ee25e454b` |
| remote main | `9dcc31be2b7f32f3199cfbd44e138d161fc0cfdb` |
| ahead/behind | **2 / 0**（新增 2 个本地提交：`2a024c4`、`b4fcb15`） |
| worktree | clean（仅 `.gate-t0-workspace/`、`.gate0-workspace/` untracked） |
| VERSION / tags | vNext-2.0；clued-v0.1.0 / clued-v0.2.0 / vNext-1.3 / vNext-2.0 |

## 2. 提交链（仅本地，未 push）

```
9dcc31b  [DSH@TURING] docs: record formal local embedding ADR PASS   ← Gate 0 起始基线（= remote main）
2a024c4  docs(r3-gate0): 双 P0 Gate 0 交付（6 文件，+837）            ← 交付提交
b4fcb15  docs(r3-gate0): backfill FINAL_REPORT_HEAD=2a024c4          ← receipt 回填提交
```

## 3. 对既有文档的修正标注

- `docs/r3-gate0/R3-Gate0-Report.md` §2 中 "local HEAD = remote main = 9dcc31b" 表述：**仅对 Gate 0 起始基线成立**；Gate 0 完成后 local HEAD 已前进至 `b4fcb15`，remote 不变，ahead/behind=2/0。报告中的 doctor/test/hash 证据均在起始基线 `9dcc31b`（干净 worktree）上取得，该绑定关系不受影响。
- `docs/r3-gate0/R3-001-implementation-status-and-gap-matrix.md` 标题引用的 evidence HEAD：仍为 `9dcc31b`（矩阵证据在基线取得），但矩阵正文未出现 local HEAD 当前值表述，无冲突。
- `docs/r3-gate0/R3-000-baseline-receipt.json`：`final_report_head` 已回填 `2a024c4`；receipt 的 `evidence_head`/`tested_head` 保持 `9dcc31b`（TESTED_HEAD=FINAL_REPORT_HEAD 的前提是各 HEAD 在各自时间点成立，已在 receipt 内自述）。

## 4. Gate 1 之后的真值（本 Gate 验收时填表）

| 项 | 值（Gate 1 完成时现场复核） |
|---|---|
| Gate 1 起始 HEAD | `b4fcb15` |
| Gate 1 结束 HEAD | 待本 Gate 提交后回填 |
| remote main | 待复核（须现场 ls-remote，不沿用快照） |
| ahead/behind | 待复核 |

**规则**：任何后续 Gate 报告引用 local/remote HEAD 必须现场复核；本勘误仅修正口径，不替代现场核验。
