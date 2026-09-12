# Clued

> **发现美好，让美好继续。**

Clued 是一个围绕「发现与继续」建立的数字平台。

它让值得发现的内容、应用、作品与能力更容易被找到，也让重要的上下文、状态、决定和正在进行的事情能够跨会话、模型、Agent、设备与时间继续下去。Clued 不以“AI Memory”或单一记忆工具定义自己；模型和工具可以变化，连续性不应随之丢失。

本仓库 `cross-memory-system` 是 Clued 的研发与发布控制面之一，承载协议、Kernel、适配器、Skills/MCP、治理合同、验证与发布证据。它不是普通用户产品运行链的必经组件，也不是用户 Canonical Store；具体运行时权威边界见下文。

## 当前多轨治理（Bootstrap Projection）

Clued 当前采用四条长期治理轨道：

- **Engineering & Platform / 工程与平台**
- **Product & Experience / 产品与体验**
- **Foundational Research / 基础研究**
- **Business & Growth / 商业与增长**

当前严格工程 Frontier 是 `E-001 Kernel Phase 2 Real Closeout`。`E-008 Multi-Track Bootstrap Governance / Current Governance Inventory` 只允许作为**不阻塞 E-001 的并行治理工作**继续推进。

当前多轨状态入口：

- `docs/governance/priorities/README.md`：多轨投影说明、fresh-Agent 读取顺序与边界；
- `docs/governance/priorities/current-frontier.md`：四轨 Current Priority Frontier；
- `docs/governance/priorities/tracks.md`：当前 Program / Priority Item 与 `✅ / ◐ / 🔎 / ⛔ / ○ / ⏳ / ↘ / ☐` 状态；
- `docs/governance/priorities/source-registry.md`：49/49 Priority Item 的 exact source / derivation registry；
- `docs/governance/priorities/cross-track-map.md`：跨轨依赖与影响；
- `docs/governance/priorities/currentness.md`：Currentness / Authority 对账；
- `docs/governance/priorities/authority-currentness-contract.md`：Principal / Binding / Membership / Development Grant / Resource×Action / Currentness 的运行解析合同；
- `docs/governance/priorities/runtime-capability-status.md`：Multi-Track Runtime 当前真实实现/缺失状态；
- `docs/governance/priorities/runtime-test-identity-discovery.md`：最终 Runtime Gate 自动测试身份 Discovery；
- `docs/governance/priorities/fresh-agent-recovery-contract.md`：fresh Agent 恢复合同；
- `docs/governance/priorities/zero-memory-preflight.md`：fresh-context / zero-memory 结构预演；
- `artifacts/priorities/current.json`：机器可读 Bootstrap Priority Snapshot；
- `artifacts/priorities/source-registry.json`：机器可读 exact source registry；
- `artifacts/priorities/bootstrap-context.json`：Track Goal、typed impact、并行/资源冲突与 Bootstrap 边界；
- `artifacts/priorities/runtime-capability-status.json`：Reconciliation / Replan Runtime discovery state；
- `artifacts/priorities/runtime-test-identity-discovery.json`：聚合只读的自动测试身份 Discovery；
- `artifacts/priorities/authority-currentness-contract.json`：机器可读 Authority / Currentness resolver contract；
- `artifacts/priorities/projection-watermark.json`：Repository Projection 自身 drift watermark；
- `artifacts/priorities/bootstrap-currentness-assessment.json`：Priority Snapshot 的 fail-closed currentness assessment；
- `artifacts/priorities/bootstrap-next-action-assessment.json`：未认证状态下的 fail-closed next-action assessment。

当前状态：

```text
ZERO_MEMORY_STRUCTURAL_SAFE_ANSWER_COVERAGE = 25 / 25 PASS
ZERO_MEMORY_MULTI_AGENT_RUNTIME_GATE = BLOCKED_BY_AUTOMATED_TEST_IDENTITY_NOT_AVAILABLE
```

这里的 `25/25` 只表示：标准恢复问题都有机器可读、不会越权的真实回答路径，包括 `UNKNOWN / NOT_IMPLEMENTED / FAIL_CLOSED`。它**不表示** Multi-Track Runtime、PriorityReconciliation Runtime、CurrentnessReceipt 或最终 ≥3 Agent Runtime Gate 已经通过。

当前只读 Discovery 已确认：系统里存在 legacy Agent Binding / Authorization 数据，但没有可直接复用的完整 `test/non-production` 运行身份链。当前聚合事实为：`public.bindings=0`、`project_memberships_v13=0`、`development_spaces_v14=0`、`development_grants_v14=0`；现存 11 个 active Authorization 全部绑定 legacy `clued_agent_bindings`，Authorization Entry 聚合环境为 `canonical`。因此不能把旧 canonical 授权复用成最终 Multi-Agent Gate 的测试身份，也不会要求用户手工创建测试账号/Grant。

`✅ COMPLETED` 表示**该 Priority Item 自身的完成合同成立**，不代表相关 Runtime、产品或生产能力已经全部实现。完成项不会从治理历史中消失。

这一整套多轨内容目前仍是：

`BOOTSTRAP SOURCE-BOUND CANDIDATE / NOT AUTHORITY / NOT FROZEN`

它用于帮助 Human / Agent 在不依赖私人聊天记忆的情况下恢复 Clued 当前轨道、优先级、完成态、依赖和阻塞；**Repository Projection 本身不创建 Authority，也不能反向改写 Canonical。** 本地手工修改治理投影应视为 `PRIORITY_PROJECTION_DRIFT`，不得自动吸收为正式现实。

特别注意：Repository 中出现 `READY`、Assignment、Priority 或可见 Item，都**不等于当前 Agent 获得执行 Authority**。真实执行必须在 Clued Runtime 中解析 Binding、Project Membership、Development Grant / Scope、Effective Resource×Action、Environment 与 Currentness；未解析时 side-effect action 必须 fail closed。

当前 read-only discovery 还确认：authoritative Multi-Track PriorityReconciliation / Replan Runtime 尚未实现或不可发现。因此 fresh Agent 的正确答案是 `NOT_IMPLEMENTED / NOT AVAILABLE`，而不是伪造一个 Receipt 或把 Bootstrap `open_proposals=[]` 当作正式空 Registry。

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