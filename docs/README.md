# Clued 文档导航

## 当前入口

1. [正式冻结 / 接受基线归档](frozen-baselines/README.md)
2. [R5 内核架构与合同](r5-kernel/01-Architecture-and-Contract-Freeze.md)
3. [R5 K0 债务闭合](r5-kernel/02-K0-Debt-Closure.md)
4. [R3 Gate 终态资料](EXTERNAL_DOCUMENT_ARCHIVE.md)
5. [Phase 2 每步验收与失效规则](execution-plans/phase2-structure-governance/AcceptanceAndInvalidation.md) · [2026-09-07 Step 1 / Step 2 证据核对](execution-plans/phase2-structure-governance/Step01-Step02-EvidenceReview.md)（执行补充与证据记录，不签发接受或冻结）

## 状态语义

- 仓库 Markdown 是开发、发布、合同与证据控制面，不是普通用户运行时 Canonical Store。
- 生产 / 当前运行状态必须由对应 Canonical / Runtime / Receipt / Evidence 来源证明，不从过期的 `CURRENT_STATUS.md` 文案推断。
- `docs/frozen-baselines/` 保存已经明确固定、冻结或正式接受的精确文件副本及完整性清单；它是归档副本，不因“存在于仓库”自行创造新的 Authority。
- 没有精确原始字节的已固定决定只登记缺失，不根据聊天摘要伪造“正式文件”。

## 目录含义

| 路径 | 内容 | 处理原则 |
|---|---|---|
| `docs/frozen-baselines/` | 已明确固定 / 冻结 / 正式接受的文件副本、审查材料与完整性信息 | 保留；变更需新增后继版本，不回改冻结字节 |
| `docs/r5-kernel/` | R5 合同、迁移、测试和裁决证据 | 不可随意删除 |
| `docs/r3-gate*/` | R3 已封存 Gate 证据 | 不可随意删除 |
| `docs/history/` | 已退出当前入口、但仍需保留追溯的旧报告 | 保留为历史，不作为当前事实 |
| 根目录 ADR / 基线文档 | 仍被合同、测试或其他文档按固定路径引用 | 未证明无引用前保留 |

## 清理原则

只删除能够明确证明为过期迁移投影、已被正式后继替代且不再承担证据角色，或已经明确废止且无固定路径依赖的文档。

“旧”本身不是删除理由。FAIL 候选、历史 Gate、审查报告、Receipt、Migration Evidence 和被后继版本引用的前任，仍可能具有审计价值，因此默认保留。

## External Document Archive

历史研究、战略、汇报、评审/验收与 Closeout 叙事文档统一迁移至 Google Drive；仓库只保留工程必需文档。迁移目录、索引与校验信息见 [`EXTERNAL_DOCUMENT_ARCHIVE.md`](./EXTERNAL_DOCUMENT_ARCHIVE.md)。