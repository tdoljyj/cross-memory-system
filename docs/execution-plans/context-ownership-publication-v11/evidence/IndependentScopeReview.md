# Clued Context v1.1 独立实施范围审查

日期：2026-09-07。审查角色：独立范围与合同审查员；与实现作者分开。结论：**同意下述最小后继设计进入实现与验证；尚未作运行验收，不能据此发布或判定 A–F 全部完成。**

## 1. 受审对象与证据边界

- 方案：`Clued_Context_Ownership_Publication_Architecture_v1.1_完整方案.md`，SHA256 `fdacfe9e2f40545a4c90cef68a6f9ecf691f07f752676f13148240f126007c70`。
- 代码核对对象：`C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/phase2-governance-check`，核对时 HEAD `3064d77c1390b4b4dbb9db903df9f2fee75bf27c`。
- 本审查读取方案、根及 app AGENTS、安装的 clued-developer Skill、现有 SQL 与冻结合同引用。主执行者负责本请求的远端／受信读取证据；本审查不重复签发 TM19 实时 qualification，不将历史或本地源码核对表述为生产状态实测。
- 用户采用的执行规则允许独立审核与常规代审，不允许扩大权限、降低 P0 或把未知判 PASS。本次仅保存审查文档，未修改生产、冻结文件、Skill 或 pins。

## 2. 独立 findings

| ID | 级别 | 发现及依据 | 必须处置 |
|---|---|---|---|
| IR01 | P0 | 旧 `record_list_core` 只按 `user_id` 读取 `clued_records_v2`。同账号新增只读 Grant 不会约束该旧入口。见 `apps/clued-cloud/supabase/migrations/20260824014005_unified_record_v2.sql` 的列表函数。 | 新开发私密正文不得直接写进旧 memories。采用同一 Canonical 数据库的 private 扩展记录存储，是必要且低改动的隔离方式；每事实仍只有一个 canonical ID 与权威写入口。 |
| IR02 | P0 | 旧 log 分支返回 `clued_context_events.payload`；M1 Evidence 对同账号 authenticated 开放 select。仅隔离正文表仍可能通过日志、回执、附件路径泄漏。 | 私密正文、标题、附件、来源路径及受限资源元数据不能进入旧可见审计表。复用 M1 事务、CAS、幂等思想与安全的元数据；需要的私密 Event/Receipt/Evidence 细节留在等价 private 扩展。针对实际旧查询、log、audit、export 与 Evidence 路径使用哨兵实测。 |
| IR03 | P0 | `resolve_oauth_binding` 默认创建 context read/write/audit 与 `*`；同一 user/client 对应一个 Binding，不能靠 Skill 名字判定开发／普通用户。见 `202608250005_oauth_mcp_binding.sql`。 | 新入口必须解析真实 Binding，并检查单独、显式的 scope/action 授权。测试用两个真实不同 Binding；不能把同 OAuth client 的同账号登录包装成两个隔离委托。未获新 Grant 的旧全范围 Binding不得自动获得新区权限。 |
| IR04 | P0 | M1 幂等所有者作用域不等于新 Binding 读取许可；授权撤销后的重放可能返回旧敏感结果。 | 每次重放前重核当前授权；同键不同请求拒绝，同键跨主体不泄漏。建议新 operation family 清晰分区，并将 Binding／上下文纳入请求绑定。 |
| IR05 | P0 | `EXISTING_ONLY` 若只冻结创建时间而读取 latest，会读到授权后的修订；`observed_at` 可补写。 | 用服务端提交游标及稳定版本读点，分别表达记录集合与版本策略。未实现的策略显式拒绝，不能静默退化成全部历史。 |
| IR06 | P0 | 事实接受、对受众发布与交付是三种效果。M1 commit 或 TM19 工程发布证据不能代替业务交付。 | 新接受绑定精确 source version/hash；发布另外绑定 audience/environment/channel/payload hash/CAS；运行状态明确 pending/delivered/verified。源、批准或 Grant 撤销时拒绝后续消费与交付。 |
| IR07 | P0 | 原记录已经处于旧同账号可读范围时，复制进 private 并不能撤回旧副本，也不能证明全部历史已受控。 | 存量保持原语义；导入只在明确来源、授权集合和 provenance 下进行。不得自动复制全部旧记录、改写回执或声明完成历史隔离。 |
| IR08 | P0 | 新 Grant、发布和消费者属于后继业务语义，旧冻结及绿色 CI 不覆盖新增功能。 | 保存精确 successor subject、命名与权限映射及影响表；不改旧冻结字节或安装 pins，不宣称 semantic no-change。 |

## 3. 最小可实施数据合同

以下是逻辑合同，可合并表和函数；不是一概念强制一表。不新增组织平台、图数据库、消息系统或信任根。

| 合同 | 最低字段／不变量 | 复用与范围 |
|---|---|---|
| Context 与 Record | 可信 owner/project/context ID；record ID/version；type、classification、source authority；正文；observed/recorded time；服务器提交游标；actor Binding；效力和来源引用 | private 扩展可承载新 Context Record，仍是同一个在线 Canon。旧 personal Global/Project 不变。修订需保存历史或有等价固定版本表示。 |
| Access Grant | owner、真实 grantee Binding、context、actions、environment、历史策略与游标／显式集合、版本策略、字段范围、expiry、revoked version、CAS version | 仅所有者已认证管理入口签发；不允许新 Agent 自签 Grant。读、写、接受、发布分别授权；禁跨所有者和转授可降低首发范围。 |
| Project Link | 目标自有 project、source context、grant ID、version、用途 | Link 只引用，不含正文或权限。无 Grant／错 Binding／已撤销均不可读；删 Link 不冒充撤销 Grant。 |
| Acceptance | 精确 source ID/version/hash、命题及 scope、evidence refs/hash、actor Binding/authority、结果、适用环境、CAS 与前任 | candidate 可以持久化，但只有该操作产生接受效果。修改来源使旧接受不能覆盖新版本。 |
| Publication | acceptance ref、精确 source 与 payload hash、受众／环境／渠道、publisher Binding、policy/projection version、expected-current、delivery state | 首次只支持一个服务端受控渠道。可在同数据库完成该渠道的原子指针更新；不必为尚未启用的外部渠道先建 outbox 平台。外部交付若实际启用，必须有 pending 与可重试交付任务，不能把数据库提交称作外部交付。 |
| Feedback | 所选观察版本、用户允许的字段／附件集合、接收上下文、用途、原观察归属、状态及限定回告 | 提交不等于接受；冻结的共享证据包是派生表示。撤回共享不销毁已独立验证的新产品命题，但移除不再可用的原始私密材料并重核依赖。 |
| Mutation/Event/Receipt | actor/Binding、operation family、idempotency key/request hash、target/version、CAS base、提交结果、关联 ID | 同事务提交，真实失败不报成功；公共旧审计不能承载新私密数据。回执重放不绕过当前授权。 |

Binding 没有现成 expiry/role 字段时，可把新能力约束放入受控 Grant 扩展，不需要立即重写旧 Binding 全表及旧 OAuth 语义。首发只向明确选定 Binding 授权；Owner 管理入口是主动管理动作，不能供普通 User Binding 自动升级。

## 4. 冻结影响与文件边界

冻结路径来自 `Phase2StructureFreezeDecision_20260907.json` 所绑定的 `step12-migration-20260907/ExecutionInputs.candidate.json`。这些旧 subject 的字节不应为了新功能直接重生成：

| TM | 直接冻结路径 | 后继影响 |
|---|---|---|
| TM17 | `development/contracts/phase2/SourceIndex.json` 及其引用的 namespace、版本、词汇、身份、typed authorization/consumer/receipt 原文 | 新 action、scope、Grant、接受及发布字段须进入明确后继合同；不能在旧索引中原地增加权限并沿用旧接受。 |
| TM18 | `development/projections/phase2/ConsumerBindings.projection.json`、`GovernanceDocs.projection.md`、`GovernanceManifest.projection.json`、`GovernanceRegistry.projection.json`、`IdentityFiles.projection.json` | 新消费能力若需要投影到 Skill/文档，按新受审事实生成；不把旧投影手改为“已上线”。 |
| TM19 | `development/authority-index/phase2/SourceIndex.json`，及当前受信 Activation、Policy、Statement、安装和发布指针关联边界 | 业务 Publication 与 TM19 工程发布是不同消费者。新代码或 SQL 测试通过不更新 TM19 pins，不继承其生产授权。 |

新增 `apps/clued-cloud/supabase/migrations/`、`apps/clued-cloud/worker/`、`apps/clued-cloud/tests/` 下的功能实现与测试，不因目录名而直接等于编辑上述冻结文件，但仍改变真实 API/schema/consumer 语义，须被后继 subject 的 changed-path 和影响表覆盖。修改 `worker/index.ts` 中路由／工具 schema 需要真实调用路径回归；修改全局授权 helper 或旧 OAuth resolver 会扩大受影响回归，优先添加窄的新入口。

后继记录与证据可放现有 `docs/execution-plans/` 的新业务执行目录，明确 candidate/accepted/tested/deployed 各自状态。不得为了“接入治理”先改旧 SourceIndex 或安装 pins。

## 5. 不可省略的最小验收

| ID | 覆盖方案原项 | 必须提供的最小证据 |
|---|---|---|
| V01 | G01/G02 | exact successor subject/hash、changed paths、权限及 frozen impact；旧冻结文件无改动；新业务证据不冒用旧 TM19 PASS。 |
| V02 | H01–H03/H08/H09 | 没有 Dogfood 会话时 Developer Binding 保存得到稳定 ID/Receipt；随后真实不同 User Binding 登录并获只读 Grant/Link 找回相同 ID；User 写入、接受、发布拒绝。 |
| V03 | H06/H07/S01–S04 | 同账号旧 Binding、另一用户、伪造 owner/scope、错环境与无 Grant 都不能读；旧列表/log/audit/export/Evidence 用唯一私密哨兵检查无泄漏。不能只测新详情接口。 |
| V04 | H04/H05/H11 | 创建记录→签发历史 Grant→新增及修订→读取；验证可信游标和固定版本。客户端伪造 observed_at 不影响可读集合；个人批注不被源更新覆盖。 |
| V05 | H12/R02 | 同键同请求仅一次业务变更；同键不同正文拒绝；两并发 CAS 只有一成功；撤销后旧 token 和旧幂等键不能重新读私密结果。 |
| V06 | A01/A02/P01/P02/P06/P07 | 未接受/未发布不可见；精确接受与独立发布授权；修改源、投影、受众或环境后旧批准失败；预览不冒称生产。 |
| V07 | P03–P05/R03 | current CAS 冲突、中断恢复、重复交付；只有 required consumer 验证后报 verified；撤销 source/acceptance/publication 后当前读取拒绝，审计保留。 |
| V08 | F01–F04/R01 | 最小反馈包不含整项目；反馈恶意指令无权限效果；候选不自动接受；提交者可以查询限定处置；撤回材料与独立证据区分。 |
| V09 | H10/R04–R06 | 普通自测使用新的隔离模型上下文；切换账号/模式不复用开发包；明确未启用离线缓存/外部渠道，真实启用者必须验失效。TTL 到期降级新鲜度，不改写历史。 |
| V10 | H02/S02 + E/F | 最终真实 API/MCP 与最小用户入口实测；普通调用保留实际身份，无管理员模拟；新进程读独立结果。有限范围部署与实际版本/环境/受众证据；未完成部署或外部边界不能报全案 PASS。 |

完整方案 37 场景可按上表合并为 10 组证据采集，合并不删除反例。接口验证可以代替重复全页面回归；两个 Binding、旧入口泄漏负例、撤销重放、内容绑定与真实消费者独立核验不能裁剪。

## 6. 审查决定与最低成本执行建议

本审查接受 IR01 所述 private 扩展作为进入实现的最小架构选择，条件是 IR02 的日志／回执／附件旁路一并处理。该选择是在单一 Canonical 数据库内扩展受控范围，不是恢复本地双写，也不是再建一个事实库。

建议顺序：一次性锁定后继合同及范围 → 完成 Binding+Grant+Record+Link 与撤销原子基础 → 两个真实 Binding 验独立保存和晚登录恢复 → 在同一受控渠道完成接受/发布/反馈 → 独立验旧入口与撤销负例 → 具备现成发布授权和目标证据后限定启用。并行仅用于独立合同审查、测试材料准备；共享数据库迁移、授权变化和发布指针操作串行。

安全、权限或真实生产边界若阻断，封存该边界并继续本地实现与验证，最后报告具体未完成项。不得将“仅 B 阶段本地通过”表述为用户要求的完整方案全部执行完成。外部渠道、跨所有者组织共享和全聊天捕获默认关闭可节约成本，但不能以此省略已启用渠道的撤回或消费者验证。
