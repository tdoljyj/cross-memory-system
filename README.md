# Clued

> **发现美好，让美好继续。**

Clued 是一个围绕「发现与继续」建立的数字平台。

它让值得发现的内容、应用、作品与能力更容易被找到，也让重要的上下文、状态、决定和正在进行的事情能够跨会话、模型、Agent、设备与时间继续下去。Clued 不以“AI Memory”或单一记忆工具定义自己；模型和工具可以变化，连续性不应随之丢失。

本仓库 `cross-memory-system` 是 Clued 的研发与发布控制面之一，承载协议、Kernel、适配器、Skills/MCP、治理合同、验证与发布证据。它不是普通用户产品运行链的必经组件，也不是用户 Canonical Store；具体运行时权威边界见下文。

## 当前权威边界

- 生产 Supabase（经认证 Clued API/MCP）是唯一在线 Canonical Store。
- `memory/` 是 `artifacts/clued-two-level-snapshots/current.json` 所指版本的只读物化，不接受业务写入。
- 当前根快照：`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155`，`live_rechecked`、`views_complete=true`。
- Git `main`、根 `VERSION`、git tag、M2 指针和 `memory/manifest.json` 共同提供版本真值；不要从历史文档文件名猜版本。

## 先看这些

- `memory/manifest.json`：快照版本、Canonical 版本、完整性计数和所有文件哈希。
- `memory/profile.md`：个人级只读视图。
- `memory/global/{state,task,decision,archive,log}.md`：全局五视图。
- `memory/projects/{canonical_project_id}/...`：项目级五视图。
- `docs/clued-two-level-views/20-Memory-v16-Root-Cutover-Report.md`：真实目录迁移与可恢复证据。

## 目录合同

```text
memory/
├── profile.md
├── global/{state,task,decision,archive,log}.md
├── projects/{canonical_project_id}/{state,task,decision,archive,log}.md
├── objects/{records,projects,legacy}/
├── events/raw/
├── evidence/migration/
├── index.json
└── manifest.json
```

Canonical Record/Project/Event/Evidence 只在其对应导出目录保留一次正文；Markdown 和 `index.json` 均为派生读取。`objects/legacy/` 与 legacy Event 信封是兼容历史，不是当前事实。

## 入口

```powershell
python memory.py doctor
python memory.py status
python memory.py recall "Clued 当前状态" --tier T2 --project-id 0597aa60-9b98-4da6-a4ab-63d7705b632f
powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Pull -Access PROJECT
```

`memory.py` 的旧本地写命令以及同步脚本的业务-memory push 路径会 fail closed。Canonical 写入只使用认证的 `clued_record_mutate`、`clued_decision_supersede`、`clued_project_mutate`、`clued_evidence_ingest` 或 `clued_event_append`；成功事务已经生成 Event 与 Receipt，禁止再写一份 Markdown。

## Current Governance Inventory / 多轨治理 Repository Projection

Current Governance Inventory 现在有正式的 **Repository-side read-only projection**，用于研发、审查、CI、Agent 路由与零记忆恢复；它不是第二套 Canonical Store，也不会从 Git 反向写入业务 Canon。

- Manifest：`development/projections/multitrack/CurrentGovernanceInventory.projection.json`
- 人类可读投影：`development/projections/multitrack/CurrentGovernanceInventory.projection.md`
- 四轨机器投影：`development/projections/multitrack/tracks/{E,P,R,B}.items.json`
- 投影合同：`development/contracts/multitrack/RepositoryProjection.contract.json`
- Fail-closed Validator：`scripts/governance/validate_multitrack_projection.py`
- CI：`.github/workflows/multitrack-governance-projection.yml`

当前落库来源绑定：

```text
Snapshot  CLUED-CURRENT-PRIORITY-SNAPSHOT-v0.1.3-SOURCE-BOUND-20260912
Inventory CLUED-CURRENT-GOVERNANCE-INVENTORY-v0.1.3-SOURCE-BOUND-20260912
Source SHA bca8fd9244657beabe09a3f815295e09d5207b4709f11ab8722d9a8d58491f5f
Status    REPOSITORY_PROJECTION_CANDIDATE_NOT_AUTHORITY_NOT_FROZEN
```

Source-bound Frontier：

| Track | Frontier |
|---|---|
| E · 工程与平台 | `E-001`, `E-008` |
| P · 产品与体验 | `P-006`, `P-004` |
| R · 基础研究 | `R-002`, `R-004`, `R-005`, `R-006` |
| B · 商业与增长 | `B-002`, `B-003` |

验证命令：

```bash
python scripts/governance/validate_multitrack_projection.py
```

Validator PASS 只证明 Repository 投影内部完整；**不等于 Canonical Currentness 已重新裁决、不等于 Inventory 已冻结，也不授予生产/Kernel/数据库/Provider 执行 Authority。**

## 发布与回滚

新快照走 `canonical_export → build → validate → expected-current CAS publish`。`published/{snapshot_version}` 不可原地修改。回滚只切换快照指针和只读根/镜像，不删除或倒退已经提交的 Canonical 历史。
<!-- BEGIN CLUED PHASE2 GOVERNANCE PROJECTION -->

本区块由已绑定的治理来源生成；候选、未定和历史状态保持原含义。它不授予权限，不写入业务 Canon，不宣告接受、冻结或实现。

来源集合摘要：`c7b4bf64ed6a802d3d1461eefcfddca327e494fa23d2e04c7fd2905674d40c02`；事实模型摘要：`cb0accfb9446a91d9fcddd289e1d39334e35081ca95292eda1df5686a259be73`。

| 治理事实 | 来源值 |
|---|---|
| 投影性质 | PREPARATION_ONLY_NOT_STEP7_GATE |
| Step 4 原状态 | PREPARATION_ONLY_NOT_STEP4_ACCEPTANCE |
| 管理 Owner（仅任务管理） | current Clued project owner in the authenticated user conversation |
| Namespace 候选组数 | 10 |
| Step 5 原状态 | PREPARATION_ONLY_NOT_STEP5_ACCEPTANCE |
| 稳定 Map | CANDIDATE_TARGET_MAP_V0_1_1 |
| 本候选新增 Alias 数 | 0 |
| 架构直接前序（原引用对象） | {"axis":"architecture","bytes":168491377,"filename":"Clued_Phase2_三项设计候选_完整审查包_v0.2.4_20260905.zip","members":440,"sha256":"4aae92c37813772e983a14537be52ca8b428af666e644b72d40084ccd592d68b","version":"v0.2.4"} |
| 历史命名空间不得签发当前状态 | true |
| Step 6 原状态 | SOURCE_BINDING_CANDIDATE_NOT_ACCEPTANCE |
| 聚合 ID 不另行发行，见逐消费者绑定 | [null,null,null] |
| 来源绑定行数（不等于新运行验收数） | 18 |
| Step 4 / 5 / 6 Decision 来源状态 | ["ACCEPTED_FOR_STEP4_ADMINISTRATIVE_SCOPE","ACCEPTED_FOR_CURRENT_SCOPED_IDENTITY_CONTRACTS","ACCEPTED_FOR_SOURCE_PRESERVING_TYPED_BINDINGS"] |
| 已选上游引用一致性 | SELECTED_LINEAGE_MATCHES |

| 版本轴 | 来源身份 |
|---|---|
| product | Clued-v1.6 |
| architecture | v0.2.5 |
| mapping | v0.1.1 |
| schema | {"core_definition":"1.0.0-local-rc-v15","model_schema_definition":"2.0.0-local-rc-v15-model"} |
| artifact | per-entry path/bytes/sha256 |
| skill | v0.1.5 |
| runtime | null |
| candidate_revision | v0.2.7.1 |
| migration_revision | null |
| protocol | {"definition_version":"1.0.0-local-rc-v15","path_namespace":"protocol/continuity/v1","schema_version":"clued.protocol-manifest/1"} |

未绑定 Decision 不被解释为接受；无实际消费者证据的准备行不被解释为运行接线完成。新增 Alias 为零不证明历史或外部别名已经全量枚举。

<!-- END CLUED PHASE2 GOVERNANCE PROJECTION -->
