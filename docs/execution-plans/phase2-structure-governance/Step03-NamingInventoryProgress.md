# Step 3：Naming Surface 盘点与外部补证

日期：2026-09-07。固定顺序依据 [21 步基线](FixedExecutionBaseline_20260907.md)，验收依据 [统一验收与证据失效表](AcceptanceAndInvalidation.md)。进入依据为 [Step 1/2 核对报告](Step01-Step02-EvidenceReview.md)。本记录不签发 Acceptance、Freeze 或 Naming Integrity Closeout。

## 已落实的工作

外部来源已从实际连接接口取回，保存于 `artifacts/clued-validation/structure-freeze-prep/naming/external-20260907/`。`SourceIndex.json` 绑定每份来源的大小和 SHA256；它们是有来源说明的元数据快照，内容摘要不代替签发者授权。

| 来源 | 实际取回内容 | 边界 |
|---|---|---|
| Supabase 项目 | `clued-prod` / `ccxsikzwxlolxqlosril` 在线；`clued-restore-8b1` / `gfnfxbphsdtayoaxitly` 停用 | 停用不等于删除或退役 |
| Supabase 生产目录 | 1,562 条名称记录，16 页，逐页总数一致、身份无重复；包括 schema、relation、column、function、policy、index、trigger、role、constraint | 目录查询不读取业务表正文；逐页采集不是跨请求原子快照 |
| Supabase 其他列表 | 生产项目 Edge Functions、开发分支、Storage bucket 查询均返回空列表 | 仅证明这些指定列表在本次查询中为空；不推断 Auth 配置为空 |
| Cloudflare Workers | `clued-cloud` 与 `clued-cloud-canary`；绑定名称、设置标识、启用状态、当前可取回部署列表 | 生产与 canary 分开，未做部署或配置写入 |
| Worker Versions | 生产 26 个版本（3 页），canary 2 个版本（1 页）；总数及唯一 ID 核对 | 部署历史接口返回的窗口与完整可枚举版本列表分别保存 |
| Pages | `clued-prototype-pwa`、1 次部署、production/preview 配置中的绑定名称集合 | 不把原型 PWA 当作生产 Worker |
| DNS / Domain / Routes | `pixelgrav.com` 区域、`clued.pixelgrav.com` Worker custom domain、6 条 DNS 名称；Worker routes 列表为空 | custom domain 与 routes 是不同入口，routes 空不能推出没有对外域名 |
| 旧 Sites | 当前连接的 owner/editor 列表均为空 | 不能据此认定历史 `clued-cloud.tdoljyj.chatgpt.site` 已退役 |

用户本轮已明确：Clued 现有账号均为用户自有测试账号、没有其他用户。本轮按这一说明推进，不因假设存在其他用户增加审批；仍不把账号所有权自动解释成 Namespace Delegation，也不把盘点授权当迁移或成本变更授权。

## 本轮修复与统一输出

1. 原扫描器只保留同一 token 的前 50 个出现位置，现在完整保留，防止后续解析与消费者追踪漏掉第 51 个以后的引用。
2. 对超长结构化字段保留预览时，显式记录截断标记、原值长度和原值摘要，防止同前缀值被误当同一身份；未解析清楚前不拿预览作完整名称。
3. 根据实际 PNG 文件头识别图片，保留其路径/内容身份，避免仅因文件位于 `apps/` 就误判为遗漏的文本输入。
4. 新汇总器把仓库、GitHub 与外部来源合并为统一记录。每条记录包含固定基线要求的 16 项字段；canonical name、owner、consumer、alias、迁移/退役等未核实关系明确为 UNKNOWN，交由对应后续步骤闭合，不编造完成值。
5. CI 增加回归、来源摘要/分页核对及汇总输出。绿色仅证明扫描与校验程序执行成功；`step3_gate` 单独表达盘点是否满足晋级条件。

输出包括原始仓库/GitHub manifest 与 findings、`NamingSurfaceInventoryRecords.jsonl`、`NamingSurfaceInventoryConsolidated.json`、`Step3Summary.md`。每轮结果绑定其精确源提交、工具内容及外部 SourceIndex；不把上一轮结果冒充新增文件后的完整当前库存。

## 尚不能关闭的来源缺口

| ID | 缺口及已尝试方法 | 下一动作与负责角色 |
|---|---|---|
| NSI-GAP-LIBRARY | Library 浏览器入口多次连接超时/Debugger unattached，未取得完整目录或等价导出 | 由具备可读 Library 入口的操作端取回元数据清单，或使用已有元数据导出；不得改写为空或 N/A |
| NSI-GAP-RESTORE | 停用恢复项目只有项目级名称，本轮只读 schema 查询实际返回连接超时 | 由账号操作端提供其既有 schema 元数据；若必须恢复实例，先明确该项操作及成本，不自动恢复 |
| NSI-GAP-AUTH | 生产 Auth redirect 配置未从管理端取回 | 用已有可用的管理读取通道确认实际 redirect 标识，源码默认值不冒充部署配置 |
| NSI-GAP-SITES | 当前 Sites 列表为空，但历史站点的身份/退役证据未定位 | 核对历史站点所处账号/项目及迁移或退役记录；不能凭当前列表为空免除来源 |

原盘点发现的裸 Stage 名、历史生命周期词、传输改名、相同字节的多路径等观察均保留，汇总器给出后续处置步骤与责任角色。观察不自动升级为架构缺陷、逻辑对象冲突或改名授权。保护配置的最终不可绕过证明仍按 Step 18 执行。

用户要求加速后，本轮并行进行来源独立核验、汇总器审查及 Library 入口复测。13 份来源的摘要及分页核验通过，7 项回归通过；错误项目、失败响应与 DNS 缺页的额外检查均被拒绝。Library 使用重新枚举的正确标签页 ID 后仍无法读取页面，故保持真实不可达状态。核验材料保存于同一命名目录的 `verification-20260907/`。

**目前 Step 3 不满足全量收口条件，不能进入 Step 4。** 这来自上述实际来源缺口，不是提前要求 Step 4 的 owner/delegation 已完成。具体运行计数、其他解析缺口与最终晋级状态以对应源提交的汇总 JSON 为准。

## 失效与续接

本轮改变 Naming 扫描规则，适用 I2，必须用新工具重新生成盘点；新增外部快照/脚本/报告也改变仓库命名表面，适用 I1。历史 Step 1 validation 外包及其验证器未改，既有限定收口事实保留。

外部状态按采集窗口保存，不宣称永久新鲜；来源变动时按 I4 重采受影响部分并重新汇总。补齐一个来源不需无理由重跑其他已匹配的历史证据，但用于新的晋级结论前仍要核查适用性。版本核对保持触发式、禁自动化。
