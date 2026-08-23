# Clued 仓库当前状态

最后核对：2026-08-23  
权威仓库：`tdoljyj/cross-memory-system`

## 分支

| 分支 | 作用 | 当前状态 |
|---|---|---|
| `main` | 唯一产品主线与 Canonical Memory Store | 当前远端基线；整理前 HEAD `995b4cbd46c2c52196743112322f606f4996d266` |
| `r5.1-fast-close` | R5.1 Beta Candidate 证据与候选实现 | HEAD `021ca5c3a20ba49711cae3b97bdab2096359687d`；未合并、未删除 |

两条分支已经分叉：候选分支相对 `main` 为 ahead 27 / behind 11；`main` 的 11 个独有提交仅涉及 `memory/**`。本次整理不借机合并功能代码，也不改记忆数据。

## 版本矩阵

| 名称 | 值 | 含义 |
|---|---|---|
| 仓库基线 | `vNext-2.0` | 当前根 `VERSION`，历史 Memory Engine 基线 |
| 内核工程代际 | `R5.1` | 最新候选工程线 |
| 产品版本 | `0.2.0` | R5.1 冻结合同中的候选产品版本 |
| Runtime | `0.2.x` | 兼容版本线 |
| Protocol | `0.3.0` | 跨端协议版本 |
| Kernel Contract | `1.1.0` | 冻结合同版本 |
| Cloud Preview | `v0.1` | 云端最小产品阶段名，不是内核版本 |

## 验证状态

- R5.1 verdict：`CLUED KERNEL BETA CANDIDATE`
- 经验证产品候选提交：`3aa1cad752933bde624274e2c4ec0fb8be556fd2`
- 完整矩阵：47 个测试文件，`678 PASS / 0 FAIL / 0 ERROR / 0 SKIP`
- K4–K7：PASS
- 语义召回：仍禁用；R4 为 terminal `NO-GO`
- Stable / Release / 生产 Binding 切换：均未发生

## 受保护区域

以下内容不能因“整理仓库”删除或改写语义：

- `memory/**`、`.clued/**`
- 冻结 corpus、fixtures、golden、baseline
- Gate receipts、adjudication、raw logs 和 evidence tags
- 真实 Binding 与迁移状态
- 已封存提交历史

## 下一项仓库治理动作

以后如要把 R5.1 进入 `main`，必须作为单独的产品集成任务：先保留 `main` 最新 `memory/**`，再完成合并、全量测试和版本源归一。不能把功能合并伪装成文档清理。
