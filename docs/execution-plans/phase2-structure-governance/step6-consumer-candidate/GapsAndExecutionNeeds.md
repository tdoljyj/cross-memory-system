# Step 6 缺项与 Step 13/16 执行条件

**用户现在无需为本准备留在现场登录。** Step 6 矩阵、隔离测试准备和四个 Phase2 Gate 均能继续。只有之后某个被实际变更影响的验收确需新的在线账户/OAuth授权且没有可用会话时，才需要一次针对该流程的登录。

## A03 不是本系列默认新增前置

固定基线 Step13 第826—833行要求目标消费者读取正确 namespace/identity/version、关闭旧写入口、fail closed、unknown不冒充success、receipt正确、authorization scope正确；没有逐字要求每次重做生产OAuth。

Step16第923、927、931—935行要求在迁移后真实结构运行现有四个Phase2 Gate，绑定exact Candidate/Commit/Run/Artifact/Receipt。现行workflow与验证器的四个Gate是 **Identity / Manifest / Provenance / ProductIncrementInput**。它们消费候选ZIP，不是公开MCP的A03登录验收，也不是名为P6的另一组历史发布测试。

已有A03实际调用摘要位于 `artifacts/clued-validation/public-mcp/a03/c1ef7a3b-20260829T062104Z/readonly-call-summary.json`：2026-08-29一次只读 `clued_project_list({})` 调用，status=ok，无业务正文持久化。此处读取的是历史摘要，没有重取线上状态或宣称当前登录测试通过。

本次比较 `c1ef7a3b → 9bc1e7f`：Worker continuity、OAuth consent、ChatGPT辅助文件、A03 contract/session均无diff；app/page.tsx仅日志卡展示和文案改变，未涉及所见登录/注册/session/consent逻辑。因此，旧A03继续作为**未受影响认证链路的历史已执行证据**是合理的；迁移后的消费者路径/构建/引用仍需Step13针对变化核验，不允许把旧A03改标签为新的迁移PASS。

A03只在下列变化影响其证据时失效：auth路由/issuer/resource/client/callback/PKCE/scopes或consent逻辑变化；相关账户/client/Binding权限撤销变化；Inspector版本/存储桥接/代理hook变化；新故障反证；或者接受条件明确要求fresh live。只增加命名报告、无关代码展示变化，不自动触发一次生产登录。

## 实际缺项（局部处理）

| ID | 已有证据与缺项 | 最小下一动作 |
|---|---|---|
| G01 | 候选RuntimeConsumerEvidenceContract仍为0绑定/0执行；矩阵只有18条核心路径，没有穷尽所有商业域，也未正式绑定domain/program/stage/owner。 | 依据Step4/5注册结果补consumer manifest映射，保持未实现领域NOT_PERFORMED；不要造新的完整商业系统。 |
| G02 | 现有Receipt分属数据库M1事务、snapshot publication、请求BundleEvidence、CI Gate。kernel receipt.schema.json只有schema_version/object_type/receipt_id/result/evidence_digest/generation且additionalProperties=false；它不是全用途Step6封套。 | 增加工程侧typed binding/证据封套，引用原Receipt+hash+subject/run/candidate/commit/gate/authority/scope；不原地扩写不可变kernel schema、不改历史Receipt。 |
| G03 | Worker公开inputSchema与TypeScript描述不等于每入口执行同一JSON Schema校验。parseBody只拒绝非法UTF8/JSON/非object/过大数据；callRpc接收泛化args，再由DB核心裁定字段。 | 在矩阵注明真正校验层，给受迁移影响入口配最小合法/非法类型fixture；不要以schema存在作runtime PASS。 |
| G04 | `m1HttpStatus` 在continuity.ts:1138—1142对既非failed也非rejected的status默认200；MCP callTool:939只按result.error设isError。 | 对未知/缺status输出做隔离负例，明确哪些正常读取没有status；不要把所有对象强行统一或先改生产。当前是代码边界缺证，不是已观察线上故障。 |
| G05 | `clued_canonical_export`政策在continuity.ts:806—807声明context:read+audit:read；M1 migration:703—709的Binding wrapper仅检查context:read/global；795起core未见audit:read追加校验。SQL既有export正例走user wrapper。 | 给“只有context:read、无audit:read”的合成Binding写一条隔离fixture，确认接受合同应有的失败行为与实际差异；仅局部验证，禁止生产导出。 |
| G06 | 现有正负测试类型混合：源码静态断言、模拟HTTP、隔离真实SQL、历史CI、历史生产OAuth。多数行没有本候选run/raw摘要。 | 沿用已有效历史证据，选择变化相关测试执行一次后绑确切run/环境/命令/退出码/摘要；未执行保留NOT_PERFORMED。Step16四Gate按基线fresh运行。 |

G05是明确可定位的授权声明/执行差异候选，尚未执行fixture，不声称已证实线上越权。G03/G04同样不得凭源码审阅夸大为全面运行缺陷。

## 账号、token和环境清单

完整字段见 `ExecutionNeeds.json`，只记录名称与能力，不保存密钥本体。

| 验收路径 | 具体需要 | 当前授权接口可提供什么 | 是否需要用户现场 |
|---|---|---|---|
| Worker/REST/MCP路由单测 | Node>=22.13、项目依赖；mock用户JWT/Binding fixture | 现有测试自行提供合成标记；无需外部服务 | 否 |
| M1 SQL/P5/P6真实隔离DB负例 | embedded-postgres/pg/esbuild或固定本地Supabase；owner/editor/reader/tenantB/denied及revoked Binding fixture；可选CLD_P5_EVIDENCE_DIR/CLD_P6_EVIDENCE_DIR | 现有测试构造本地角色和身份；不依赖生产用户；环境就绪未在本轮重新搭建或验证 | 否 |
| isolated public MCP行为 | Supabase CLI2.115.0及本地stack，SUPABASE_DB_URL只指隔离库；local SUPABASE_PUBLISHABLE_KEY；MCP_ISOLATED_PORT/URL与feature flags | fixtures.mjs生成OwnerA/OwnerB、BindingA/B、session；现有helper读本地status，不需要用户发真实token | 否 |
| Step16四Phase2 Gate | Python3.12、冻结后exact候选/identity/source；CI自带GITHUB_TOKEN(contents:read)、GITHUB_SHA/RUN_ID/RUN_ATTEMPT | 已有私库/Actions授权与本地保留包 | 否 |
| 受影响的真实账户登录/Binding管理 | 被明确选择的测试Clued账户与有效GoTrue用户JWT；最小scope测试Binding | Supabase管理端可读配置/schema，不能被当作用户JWT或用户同意；当前工具面没有Clued登录/Binding token交付接口 | 只有确需fresh live且无有效已授权会话时 |
| 受影响的A03 OAuth+PKCE | 固定subject `e9dc13e7-41b0-421b-bfa3-07890675e92d`；client `87924be5-cec9-415f-b1a2-8a4d9ae9d1a8`；Inspector2.4.0；callback `http://localhost:6400/oauth/callback`；openid/email/profile | Runbook要求Owner在Connect阶段输入密码/验证码及同意，管理连接不能替代；令牌仅隔离session内使用，单次只读tools/call | 条件触发；不是当前默认前置 |
| 新鲜required-check Receipt | GH_TOKEN/GITHUB_TOKEN来自既有授权上下文；GATE_REPOSITORY、CANDIDATE_SHA、GATE_PR_NUMBER | GitHub Actions/已授权read API可以完成 | 否 |

A03精确本地配置：`HOST=localhost`、`CLIENT_PORT=6400`、`MCP_SANDBOX_PORT=6401`、`MCP_APP_ORIGIN_PORT=6402`、新的隔离`MCP_STORAGE_DIR`、对应`MCP_INSPECTOR_OAUTH_STATE_PATH`。这只是条件触发后的可执行准备清单，本轮没有启动Inspector或检查浏览器。

生产负例不得靠撤销现有正常Binding、改现有用户密码、重置共享DB来制造。无token/畸形token负例不需要真实账户；scope/跨tenant/撤销/过期等优先用隔离fixture。若某项将来必须在线，需要一个专用已授权测试身份及安全token交付方式，不能从凭据缓存里寻找用户token代替。

## 本轮证据纪律

本轮没有执行测试、登录、数据库查询或发布；只读取源码、测试定义、既有小型回执和候选合同。没有重复生产Auth管理读取或浏览器操作。第一次新请求对齐发生GitHub TLS EOF，单次同入口重试PASS后未再对齐；随后遵从root要求复用任务上下文。所有源码结论绑定9bc1e7f对象，完整源摘要见ConsumerMatrix.json，报告不会冒充当前Canon状态。
