# BeamingFace

> **好的发现，会写在脸上。**

BeamingFace 是一个让人发现有趣内容、好用应用和新玩法的数字平台。

在 BeamingFace，顺着兴趣逛下去。看看大家做出了什么，遇见喜欢的，就点开试一试。可能是一件刚好用得上的小工具，也可能是一个让你忍不住分享的新发现。从“这是什么”，到“原来还能这样”，让好奇，变成脸上的笑意。

本仓库 `cross-memory-system` 是 BeamingFace 的研发与发布控制面之一，承载 Kernel、协议、运行时、Skills/MCP、治理合同、测试、验证和发布证据。**它不是普通用户产品运行链的必经组件，也不是用户在线 Canonical Store。**

当前产品版本以根目录 [`VERSION`](./VERSION) 为准。

当前品牌名称为 **BeamingFace**，正式域名为 [beamingface.com](https://beamingface.com)，开发域名为 [dev.beamingface.com](https://dev.beamingface.com)；现行品牌材料见[品牌展示与更名规范 v0.4（固定，Google Drive）](https://drive.google.com/file/d/1g7G1OPK_CLT4f39whfWyIcQzVm0ygeP5/view)。本次代码更名不代表新域名已经绑定或上线。

`Kooyumi` / `KooYomi` / `Clued` / `clued` 仍保留在技术兼容标识中，包括目录和包名、Skill/MCP 工具名、RPC/Schema、协议字串、存储键、旧接口与域名、正式工作流、版本标签及历史原件。品牌展示名称变化不表示这些技术标识已经迁移，也不改写固定版本的披露或确认摘要；GitHub 仓库标识仍为 `cross-memory-system`。范围及发布状态见[品牌更名说明](./docs/maintenance/beamingface-branding.md)。

## Use BeamingFace / 使用 BeamingFace

普通用户不需要 clone、浏览或直接依赖本仓库。

- 正式域名：<https://beamingface.com>；开发域名：<https://dev.beamingface.com>（待完成绑定与上线核验）。
- 切换前的现有网站与 Connect 入口：<https://kooyomi.com> · <https://kooyomi.com/connect>。
- BeamingFace Skill：[Skill 入口](./skills/clued/SKILL.md) · [安装与更新说明](./skills/README.md)。供支持 Skill 的 Agent 读取和维护经授权的个人与项目上下文，也用于 BeamingFace 的开发与维护；技术兼容名称仍为 `clued`。
- 使用 Skill 前，先在客户端连接 BeamingFace MCP 并完成授权，再启用 Skill。Skill 提供操作指引；安装 Skill 本身不会建立 MCP 连接、创建账户或增加访问权限。
- MCP/OAuth 继续使用已注册的 `https://kooyumi.pixelgrav.com/mcp`；既有 `clued.pixelgrav.com` 连接保留各自的 resource、issuer 和 Binding。主站更名不迁移这些技术身份，不复制旧 token。
- 产品运行时通过正式的 App / Web / Agent / MCP 入口访问 BeamingFace 服务。
- Git/GitHub 仅参与开发、验证、构建、发布与治理，不作为普通用户请求中转层或产品可用性的前提。

## Current Architecture / 当前架构

经认证的 BeamingFace Production Service 是在线 Canonical Authority。结构化 Canonical 数据由 Supabase/PostgreSQL 承载；受治理的对象数据可由 R2 等对象存储承载。所有业务读取与写入都必须经过认证、授权和正式合同边界。

正式生产运行链的逻辑架构边界为：

```text
BeamingFace App / Web / Agent / MCP
        ↓
Identity
        ↓
Authorization
        ↓
API
        ↓
Workers
        ↓
Canonical Store
(Supabase/PostgreSQL + governed object storage)
        ↓
Information / Knowledge Processing
        ↓
Context Policy
        ↓
Context Compiler
        ↓
Minimal Sufficient Context Package
        ↓
Agent / Model
```

Repository 不作为普通用户请求的必经跳、运行时状态数据库、用户数据写入中转层或第二套 Canonical Store。发布物通过正式 Distribution / Registry / CDN / Service Runtime 进入运行环境。

## Currentness & Projection / 当前性与派生投影

Canonical commit 与派生读取必须严格分离：

```text
Canonical commit
      ↓
invalidate affected projections
      ↓
post-commit projection refresh / reconciliation
      ↓
CURRENT
```

- Canonical Record / Project / Event / Evidence / Receipt 是业务事实及其审计载体；Markdown、Snapshot、Checkpoint、索引和 Repository Projection 都是派生读取或连续性载体。
- 派生视图只有在其来源、版本和 Currentness 条件重新核对完成后才能宣称 `CURRENT`。
- 如果刷新、重建或 reconciliation 失败，必须 fail closed，标记为 `STALE` / `PROJECTION_REQUIRED` 等非当前状态；不得继续冒充 CURRENT。
- 读取“现在是什么状态 / 下一步做什么”时，不能仅凭历史 Markdown、旧 Snapshot、旧 Checkpoint 或 source-bound Repository Projection 作答。
- Repository 中的治理投影位于 `development/projections/`，用于研发、审查、CI 和恢复；它不是在线权威，也不得从 Git 反向写入业务 Canon。

## Data Generations / 数据世代

BeamingFace 的用户数据生命周期按三个独立世代管理：

```text
Generation 0 — Development / Internal Test
        ↓
Generation 1 — Wipe Beta
        ↓
Generation 2 — Formal Production
```

核心边界：

- Development / Internal Test、Wipe Beta、Formal Production 是独立数据世代，不默认相互继承用户业务数据。
- Beta Data Genesis 与 Production Data Genesis 是两个独立、可审计的数据起点；Wipe Beta 用户数据默认不进入 Formal Production。
- Formal Production 从受控、隔离、干净的 Production Genesis 开始；Development/Beta → Production 仅允许明确批准的白名单迁移。
- Production 开始接纳正式用户数据后，不再以“整体清库重来”作为普通维护手段。

## Repository Map / 仓库地图

| 路径 | 主要职责 |
|---|---|
| `apps/clued-cloud/` | BeamingFace Cloud、账户与生产 Runtime 实现 |
| `kernel/` | BeamingFace Kernel 与核心执行/资格/发布能力 |
| `protocol/` | Vendor-neutral 协议、Schema、FSM 与合同 |
| `skills/` | BeamingFace Skill 与 Agent 使用/维护入口 |
| `development/` | 当前工程合同、治理、Schema、设计与只读投影 |
| `tests/` / `evals/` | 自动化测试、Qualification 与回归 |
| `memory/` | 单用户、版本化、只读 Repository Snapshot；不是在线 Canon |
| `artifacts/` | 构建、验证、迁移与发布 Evidence / Snapshot；不是在线 Current Truth |
| `work/` | 有边界的工程暂存；非权威，Closeout 后应归位或不保留 |
| `docs/` | 仓库仍需保留的工程文档与导航 |
| `legacy/` | 历史兼容材料；不得作为当前入口或 Current Truth |

`memory/` 的正式 Repository Snapshot 指针是 [`artifacts/clued-two-level-snapshots/current.json`](./artifacts/clued-two-level-snapshots/current.json)。它只表示**仓库当前发布的只读 Snapshot**，不代表在线 Canonical Current Truth。

## Where to Start / 从哪里开始

按角色进入，不要把根 README 当作完整操作手册：

- **Agent / Coding Agent / 仓库维护** → [`AGENTS.md`](./AGENTS.md)
- **Cloud / Runtime 开发** → [`apps/clued-cloud/README.md`](./apps/clued-cloud/README.md)
- **跨厂商导入/导出协议（Future Capability）** → [`protocol/continuity/v1/README.md`](./protocol/continuity/v1/README.md)
- **BeamingFace Skill** → [`skills/README.md`](./skills/README.md)
- **工程文档导航** → [`docs/README.md`](./docs/README.md)
- **Repository Governance Projection** → [`development/projections/multitrack/CurrentGovernanceInventory.projection.md`](./development/projections/multitrack/CurrentGovernanceInventory.projection.md)

对 `memory/` 的读取必须遵守 [`AGENTS.md`](./AGENTS.md) 中的 Memory Router 与最小必要读取规则。不要把 `memory/profile.md`、Global/Project 五视图或历史 Log 当作进入仓库后的默认全量读取入口。

## Documentation & Release Boundary / 文档与发布边界

仓库与资料中心职责分离：

| 内容 | 存放位置 |
|---|---|
| 代码、协议/合同、ADR、Schema/Migration、测试/Fixture、Runbook、Skill、构建/部署配置、当前执行控制、机器可验证 Evidence | 本 Git 仓库 |
| 产品研究、战略、商业、品牌、视觉、汇报、会议/对话整理、历史评审、验收/Closeout 长报告、图片及办公文档 | Google Drive |
| 用户与项目的在线 Canonical 状态、任务、决定和运行记录 | BeamingFace Production Canonical Store |

资料入口：

- [当前计划与确定基线（Google Drive）](https://drive.google.com/drive/folders/1Owx0Ow4RQY0CbYB5aDQ8RMXLNTA6EyT0)
- [当前计划与确定基线总索引](https://drive.google.com/file/d/13TE41MmUMnMZ19imQlR5UtrIVEEaGDps/view?usp=drivesdk)
- [历史外迁资料归档（Google Drive）](https://drive.google.com/drive/folders/1sKZEVQOsEGDMs2b18H3kHp7t0jGq0rGJ)
- [外迁清单与校验说明](./docs/EXTERNAL_DOCUMENT_ARCHIVE.md)

Google Drive 中“存在某个文件”不自动使其成为当前权威；Repository 中“存在某个历史文件或投影”也不自动使其成为 CURRENT。状态必须由对应 Canonical Decision / Event / Receipt、Currentness 与 Owner/Authority 边界共同证明。

Repository 写入与存储治理：

- [Git Connector Write Contract v0.1](./development/contracts/repository/GitConnectorWriteContract.v0.1.md)
- [Repository Artifact Retention Contract v0.1](./development/contracts/repository/ArtifactRetention.v0.1.md)
- [Project Lifecycle Successor v0.1](./development/contracts/project-lifecycle/ProjectLifecycleSuccessor.v0.1.md)

Repository Snapshot 发布遵循：

```text
canonical_export
      ↓
build
      ↓
validate
      ↓
expected-current CAS publish
```

`published/{snapshot_version}` 不可原地修改。回滚只切换 Snapshot 指针和只读镜像，不删除、倒退或改写已经提交的 Canonical 历史。
