# Clued Kernel Next 前公共 MCP、回归与安全基线分布式验收执行计划 v1.0

- 计划标识：`CLUED_PRE_KERNEL_PUBLIC_MCP_REGRESSION_SECURITY_DISTRIBUTED_ACCEPTANCE_PLAN_V1`
- 状态：`CANDIDATE / EXECUTION_PLAN_ONLY`
- 验收对象：Clued 现有远程 MCP、公共 OAuth 接入、MCP 行为回归及仓库安全门禁
- 生产目标：`https://clued.pixelgrav.com/mcp`
- 工具范围：MCP Inspector、Promptfoo、Gitleaks、Trivy
- 计划结论上限：`PASS / CLUED_PRE_KERNEL_PUBLIC_MCP_REGRESSION_SECURITY_BASELINE`
- 本文不是实施、生产访问、部署、合并或发布授权。

## 0. 执行边界与进入条件

### 0.1 必须满足的进入条件

1. P6 已由独立复验和 Closeout 正式关闭，并具有可取得、可复算的 Commit、Evidence 和裁决；仅有实施候选或历史 PASS 不满足本条件。
2. 执行前 fresh-fetch，固定唯一 `PRE_KERNEL_BASELINE_COMMIT`；所有任务必须在该 Commit 或其明确授权的单一候选分支上运行。
3. MCP Inspector、Promptfoo、Gitleaks、Trivy及其 GitHub Actions 必须固定版本；Action 应固定到完整 Commit SHA，不能使用 `master`、`main` 或未锁定的 `latest`。
4. PR/CI 验收只允许使用隔离 Worker/Mock、隔离数据库、合成用户和合成数据。不得读取生产 Canonical 用户数据。
5. 对生产 `https://clued.pixelgrav.com/mcp` 的验收仅限 A03 的 OAuth 与只读冒烟；任何生产写调用、数据库变更、Worker 上传、流量切换、DNS、Binding、Secret 或 Migration 操作必须另行授权。

### 0.2 本计划明确不包含

- 重建或改写 Clued MCP；
- 把私有仓库或个人 `clued-operator` Skill 公开；
- 提交 OpenAI 公共插件目录；
- 启用 Semantic Recall、Embedding、BM25、Rerank 或模型调用；
- 修改 Canonical Store、RLS、生产 Supabase、Cloudflare Worker、DNS 或 Binding；
- 实施 Kernel Next G0～G7；
- 以本计划替代 Kernel Next 最终合同、实施执行计划或分阶段授权。

## 1. 覆盖面梳理

### 1.1 核心功能点清单

| 功能点 ID | 核心功能点 | 最小验收含义 |
|---|---|---|
| CF-01 | 远程 MCP 与 Streamable HTTP 接入 | 目标可连接，MCP 协议握手成功或按合同返回 `auth_required`，不得出现 5xx 或非协议响应。 |
| CF-02 | MCP 初始化与能力协商 | `initialize` 返回受支持的协议版本、`serverInfo` 和声明能力；版本不在批准集合时失败。 |
| CF-03 | 公共工具合同冻结 | `tools/list` 的工具名、输入/输出 Schema、说明、Scope 和注解形成可机器比较的基线。 |
| CF-04 | 公共/内部能力隔离 | 公共 MCP 不暴露个人 `clued-operator`、维护工具、后台管理工具或未发布能力。 |
| CF-05 | OAuth 发现与 PKCE | 401 challenge、Protected Resource Metadata、Authorization Server Metadata、PKCE S256、回调及 Token 绑定完整。 |
| CF-06 | Scope、Owner 与租户授权 | Token 的 `aud/resource`、Scope、Owner/Context 约束被服务端再次校验，跨 Owner 默认拒绝。 |
| CF-07 | Bootstrap/Resume 连续性读取 | 已认证用户只能恢复其授权范围内的项目或上下文，来源与当前性可识别。 |
| CF-08 | 确定性词法检索 | 词法输入产生稳定结果；`semantic_recall=false`，不得暗中调用 Embedding、Rerank 或模型。 |
| CF-09 | Canonical 写入、Event 与 Receipt | 隔离环境中的授权写入只经正式写路径完成，业务对象、Event 与 Receipt 保持原子一致。 |
| CF-10 | 幂等、CAS 与重放防护 | 相同 idempotency key 不产生重复业务写；stale base/CAS 返回明确冲突且无部分写入。 |
| CF-11 | 错误、超时与 Fail Closed | 未认证、越权、Schema 错误、超时、未知工具和内部失败均返回可分类错误，不产生伪成功。 |
| CF-12 | 工具安全元数据 | 所有公共工具具有输入/输出 Schema、清晰说明、最小 Scope 及正确的只读/破坏性/开放世界注解。 |
| CF-13 | 隐私与最小披露 | 响应、日志、测试报告和 CI Artifact 不含其他用户数据、真实 Token、Secret 或未授权原文。 |
| CF-14 | CI 阻断与可复验证据 | 协议、行为、Secret、漏洞四个 Gate 可在 fresh clone 重跑，失败会阻断合并，Evidence 可复算。 |

### 1.2 关键接口清单

| 接口 ID | 接口/表面 | 重点检查 |
|---|---|---|
| IF-01 | `https://clued.pixelgrav.com/mcp` | HTTPS、Streamable HTTP、MCP 响应、401/403 与 5xx 分类。 |
| IF-02 | Protected Resource Metadata | `resource`、授权服务器地址、Scope 声明与 MCP 资源一致。 |
| IF-03 | Authorization Server Metadata / Authorization / Token | PKCE S256、客户端/回调、Token 有效期、`aud/resource`、Scope。 |
| IF-04 | MCP `initialize` / `ping` | 协议版本、服务身份、Capabilities、可达性。 |
| IF-05 | MCP `tools/list` | 工具集合、唯一性、Schema、说明、注解和漂移。 |
| IF-06 | MCP `tools/call` 只读类 | Bootstrap、Resume、Search 等当前实际公开只读工具。 |
| IF-07 | MCP `tools/call` 写入类 | Append/Checkpoint/其他当前实际公开写工具；仅隔离环境执行。 |
| IF-08 | Git 仓库历史与当前树 | Gitleaks 完整历史、当前树、PR 增量扫描。 |
| IF-09 | 依赖、锁文件与基础设施配置 | Trivy 的 Vulnerability、Misconfiguration、Secret 扫描。 |
| IF-10 | GitHub Actions / Evidence | Required Checks、SARIF/JUnit/JSON、Manifest、SHA-256 和复验入口。 |

### 1.3 主要业务与安全场景清单

| 场景 ID | 业务/安全场景 | 预期结果 |
|---|---|---|
| SC-01 | 未登录客户端连接受保护 MCP | 明确 `auth_required`/401；不返回用户数据；不进入写路径。 |
| SC-02 | 合法测试用户通过 OAuth + PKCE 连接 | 授权成功，Token 仅绑定 Clued MCP 和批准 Scope。 |
| SC-03 | 用户恢复自己的项目/上下文 | 成功且只返回授权 Scope 内数据。 |
| SC-04 | 用户执行确定性词法搜索 | 固定 Fixture 重跑结果一致；未启用语义召回。 |
| SC-05 | 用户在隔离环境追加 Event/Checkpoint | 成功写入一次并产生正确 Receipt；对象、Event、Receipt 可对账。 |
| SC-06 | 同一请求重复提交 | 业务结果幂等，不重复创建对象，不无故递增版本。 |
| SC-07 | 使用 stale base version/CAS | 返回明确 Conflict；Canonical 计数和版本保持不变。 |
| SC-08 | Owner A 请求 Owner B 的对象 | 拒绝；响应和日志均不泄露 Owner B 内容。 |
| SC-09 | 客户端枚举内部/未发布工具 | 工具不存在或不可见；不得暴露内部说明和 Schema。 |
| SC-10 | 工具 Schema、Scope 或注解发生未批准漂移 | `public-mcp-protocol` Gate 失败。 |
| SC-11 | 新 Secret 或 Token 进入 Commit/工作树 | Gitleaks Gate 非零退出并阻断。 |
| SC-12 | 新 HIGH/CRITICAL 漏洞或严重配置错误进入候选 | Trivy Gate 非零退出并阻断，除非存在有效且未过期的精确例外。 |
| SC-13 | 正常 PR/候选通过全部四个 Gate | 四个 Required Checks 全绿，Evidence 完整且已脱敏。 |
| SC-14 | 独立执行者从 fresh clone 复验 | 使用相同 Commit 与锁定工具得到相同裁决，所有摘要匹配。 |

### 1.4 覆盖逆向映射

| 清单项 | 主要 P0 验收步骤 |
|---|---|
| CF-01～CF-02 | A01、A03 |
| CF-03～CF-04、CF-12 | A02、A11 |
| CF-05～CF-06 | A03、A05 |
| CF-07～CF-08 | A04 |
| CF-09～CF-10 | A04、A06 |
| CF-11 | A01、A05、A06 |
| CF-13 | A03、A05、A12 |
| CF-14 | A07、A09、A11、A12、A13 |
| IF-01～IF-04 | A01、A03 |
| IF-05 | A02 |
| IF-06 | A04、A05 |
| IF-07 | A04、A06 |
| IF-08 | A07 |
| IF-09 | A09 |
| IF-10 | A11～A13 |
| SC-01～SC-02 | A01、A03 |
| SC-03～SC-04 | A04 |
| SC-05～SC-07 | A04、A06 |
| SC-08～SC-09 | A02、A05 |
| SC-10 | A02、A11 |
| SC-11 | A07、A11 |
| SC-12 | A09、A11 |
| SC-13～SC-14 | A11～A13 |

覆盖口径：14 个功能点、10 个接口、14 个场景，共 38 个清单项。A12 必须机器校验 38/38 均至少映射到一个 P0 步骤。

## 2. 分布式资源与并行隔离

### 2.1 固定资源分配

| 资源 ID | 用途 | 环境/数据 | 独占与隔离规则 |
|---|---|---|---|
| RES-COV | 覆盖冻结 | `PRE_KERNEL_BASELINE_COMMIT` 的只读 fresh clone | A00 独占；完成后所有任务只消费其输出。 |
| RES-MCP-A | 协议握手 | 独立 Worker/Mock A，独立端口或独立 CI Runner，无业务数据 | 仅 A01 使用；不与行为测试共用进程或 Token。 |
| RES-MCP-B | 工具合同 | 独立 Worker/Mock B，空白合成租户 | 仅 A02 使用；只读枚举。 |
| RES-AUTH-P | 生产 OAuth 只读冒烟 | `https://clued.pixelgrav.com/mcp`、专用审核账号、专用 Binding、最小只读 Scope | 仅 A03 使用；账号和 Binding 不与其他步骤共享；禁止生产写。 |
| RES-PF-POS | 正向行为 | 独立 Worker/Mock C + 临时数据库 C + Owner `accept-pos` + 项目 `accept-pos-project` | 仅 A04 使用；幂等键前缀 `APOS-`。 |
| RES-PF-NEG | 负向授权 | 独立 Worker/Mock D + 临时数据库 D + Owners `accept-neg-a/b` | 仅 A05 使用；幂等键前缀 `ANEG-`。 |
| RES-CAS | 原子性/CAS | 独立 Worker/Mock E + 临时数据库 E + Owner `accept-cas` | 仅 A06 使用；故障注入不得影响其他任务。 |
| RES-GITLEAKS | Secret 扫描 | 独立完整历史 clone，`fetch-depth: 0`，独立扫描缓存 | A07/A08 串行共享；与其他资源无冲突。 |
| RES-TRIVY | 漏洞扫描 | 独立 fresh clone，独立 Trivy DB/cache key | A09/A10 串行共享；不得复用 Gitleaks checkout。 |
| RES-CI | CI 门禁 | 专用候选分支/PR、四个唯一 Check 名称 | 仅 A11 写候选 CI 状态；不得与功能开发分支共用。 |
| RES-EVIDENCE | Evidence 汇总 | 新建只读汇总目录，不含 Secret/Token/用户原文 | A12 独占写；其他步骤只向各自输出目录写。 |
| RES-REVIEW | 独立复验 | 另一执行者、另一 fresh clone、全新临时目录与缓存 | A13 独占；不得复用实现者工作区或未上传文件。 |

### 2.2 并行波次

| 波次 | 可执行步骤 | 并行说明 |
|---|---|---|
| W0 | A00 | 唯一前置动作，先冻结覆盖与 Commit。 |
| W1 | A01、A02、A03、A04、A05、A06、A07、A09、A11、A14 | 资源、数据库、Owner、Token、checkout 均已拆分，可真实并行；A11 可先做静态和本地检查，最终 Required Check 验证在各任务结果到齐后补齐。 |
| W1-可选 | A08、A10 | 分别与 A07、A09 共用资源，因此只能在各自资源内串行；不影响其他工作线。 |
| W2 | A12 | 汇总全部 P0 输出，机器校验覆盖与摘要。 |
| W3 | A13 | 独立执行者复验；不得与 A12 同一人员、同一工作区或同一未清缓存。 |

## 3. 分布式验收任务表

> 命令中的包版本必须替换为执行前已批准并锁定的精确版本。任何 Token 只能通过短期环境变量或本机 Inspector 安全存储提供，禁止写入命令行记录、配置文件或 Artifact。

| 步骤 | 验收目标 | 覆盖功能点/接口/场景 | 优先级 | 前置条件（环境/数据/权限） | 执行动作 | 通过标准 | 结果留存方式 | 预计耗时 | 所需资源 | 并行冲突说明 |
|---|---|---|---|---|---|---|---|---|---|---|
| A00 覆盖冻结与基线身份核验 | 冻结验收对象、覆盖清单、工具版本和唯一 Git Commit。 | CF-01～CF-14；IF-01～IF-10；SC-01～SC-14 | P0 | P6 已正式 Closeout；只读仓库权限；RES-COV。 | 1. fresh-fetch。<br>2. 解析 `origin/main` 为唯一 Commit。<br>3. 核对根 `AGENTS.md`、公共 MCP 合同、当前工具实现和已有测试入口。<br>4. 生成 `coverage-matrix.json`、`baseline-manifest.json`。<br>5. 运行 `node evals/public-mcp/verify-coverage.mjs coverage-matrix.json`。 | Commit 为 40 位 SHA 且对象可读取；38/38 清单项存在；后续 A01～A13 每步均有有效映射；无重复 ID、悬空映射或未分配 P0 项；工具版本均为精确版本。 | `baseline-manifest.json`、`coverage-matrix.json`、命令日志、SHA-256。 | 60～90 分钟 | 合同审查者 1 人；RES-COV；Git。 | 唯一前置步骤，不能与依赖其 Commit/映射的任务同时开始。 |
| A01 MCP 传输、初始化与未认证行为 | 验证远程/隔离 MCP 的 Streamable HTTP、初始化、能力协商和 Fail Closed。 | CF-01、CF-02、CF-11；IF-01、IF-04；SC-01 | P0 | RES-MCP-A；Node 24；锁定 Inspector；无生产写权限。 | 1. `npx @modelcontextprotocol/inspector@<PIN> --cli "$MCP_ISOLATED_URL" --transport http --method initialize --format json > initialize.json`。<br>2. 运行 `ping` 或等价连接检查。<br>3. 无 Token 调用受保护入口并记录 Inspector 退出码与错误 Envelope。<br>4. 用隔离短期 Token 重试。 | 受保护入口无 Token 时退出码为 Inspector `3`/`auth_required` 或合同规定的等价 401；不得返回用户数据；有效隔离 Token 下 `initialize` 成功；协议版本属于批准集合；0 个 5xx、0 个非 JSON-RPC 伪成功。 | `initialize.json`、`unauth-error.json`、HTTP 头、Inspector 版本、完整退出码日志。 | 20～30 分钟 | MCP 测试者 1 人；RES-MCP-A；Inspector。 | 无；独立环境，不与 A02/A04/A05/A06 共用进程、端口或 Token。 |
| A02 工具合同、Schema、注解及公共/内部隔离 | 冻结并验证公共工具清单，防止未批准漂移和内部工具泄露。 | CF-03、CF-04、CF-12；IF-05；SC-09、SC-10 | P0 | RES-MCP-B；批准的工具基线；只读 Token（如 `tools/list` 受保护）。 | 1. `npx @modelcontextprotocol/inspector@<PIN> --cli "$MCP_CONTRACT_URL" --transport http --method tools/list --format json > tools-list.actual.json`。<br>2. `jq -S '.result.tools' tools-list.actual.json > tools-list.normalized.json`。<br>3. 运行 Schema/注解检查脚本。<br>4. 与 `tools-list.baseline.json` 做精确 diff。<br>5. 扫描内部工具名和内部说明黑名单。 | 工具名 100% 唯一；输入/输出 Schema 100% 可解析；公共工具说明、Scope、`readOnlyHint`、`destructiveHint`、`openWorldHint` 覆盖率 100%；未批准 diff 为 0；内部/维护/个人工具命中数为 0。 | 实际与规范化工具表、Schema 校验日志、diff、黑名单扫描结果。 | 30～45 分钟 | 协议审查者 1 人；RES-MCP-B；Inspector、jq、Node。 | 无；只读且使用独立实例。 |
| A03 生产 OAuth + PKCE 只读验收 | 验证真实公共入口的 OAuth 发现、PKCE、Token 资源绑定和最小只读 Scope。 | CF-01、CF-05、CF-06、CF-13；IF-01～IF-03；SC-01、SC-02 | P0 | 单独生产访问授权；RES-AUTH-P；预先创建的专用审核账号/Binding；浏览器；不得拥有写 Scope。 | 1. 运行 `npx @modelcontextprotocol/inspector@<PIN> --server-url https://clued.pixelgrav.com/mcp --transport http`。<br>2. 从 401 `WWW-Authenticate` 提供的 metadata URL 获取发现文档，禁止猜测地址。<br>3. 完成真实 OAuth + PKCE S256。<br>4. 核对 Token 的 `aud/resource`、Scope、过期时间和回调。<br>5. 只调用批准的只读工具一次，导出脱敏证据后退出 Inspector 并清除本地会话；不得创建、修改或撤销生产 Binding。 | PKCE 方法为 S256；回调与注册值一致；Token `aud/resource` 指向 Clued MCP；Scope 不超过只读批准集合；只读调用成功；生产业务写、Event、Receipt 新增数均为 0；响应不含其他 Owner 数据；本地 Token 明文落盘数为 0；生产 Binding 变更数为 0。 | 浏览器关键步骤截图（遮蔽 Token/用户数据）、发现文档摘要、脱敏 Token claims、只读返回摘要、本地会话清理日志、生产变更为 0 的核对记录。 | 30～45 分钟 | OAuth/MCP 测试者 1 人；RES-AUTH-P；Inspector Web。 | 与其他步骤无环境冲突；专用账号和 Binding 必须独占。不得与任何生产写验收并行。 |
| A04 Promptfoo 5 项正向行为回归 | 验证 Bootstrap/Resume、词法搜索、隔离写入与 Checkpoint 的核心成功路径。 | CF-07～CF-10；IF-06、IF-07；SC-03～SC-06 | P0 | RES-PF-POS；固定 Seed；合成 Owner/Project；锁定 Promptfoo；允许隔离写。 | 1. 配置 Promptfoo `mcp` Provider 指向 RES-PF-POS。<br>2. 运行 `npx promptfoo@<PIN> eval -c evals/public-mcp/promptfoo/positive.yaml -o positive.json -o positive.junit.xml`。<br>3. 固定正好 5 个审核级正向 Case：Bootstrap、Resume、确定性 Search、授权 Append+Receipt、Checkpoint/幂等重试。<br>4. 使用 `is-json`、JSON Schema、`equals`、`contains/not-contains`、JavaScript 不变量；不得使用 LLM Judge。 | 5/5 Case 通过；Assertion 通过率 100%；错误/超时数为 0；固定 Search Fixture 重跑输出摘要一致；`semantic_recall=false`；写入 Case 恰好产生 1 个业务变更及合同规定的 Event/Receipt；幂等重试不产生第二个业务对象。 | Promptfoo JSON/JUnit、隔离数据库前后计数、响应摘要、Receipt/Event 对账表。 | 45～60 分钟 | 行为测试者 1 人；RES-PF-POS；Promptfoo、隔离 DB。 | 无；独立数据库、Owner 和幂等键，不与 A05/A06 冲突。 |
| A05 Promptfoo 3 项负向与租户隔离回归 | 验证未认证、跨 Owner/Scope、非法/未发布工具调用全部 Fail Closed。 | CF-06、CF-11、CF-13；IF-06、IF-07；SC-01、SC-08、SC-09 | P0 | RES-PF-NEG；两个合成 Owner；错误 Scope Token；无生产权限。 | 1. 运行 `npx promptfoo@<PIN> eval -c evals/public-mcp/promptfoo/negative.yaml -o negative.json -o negative.junit.xml`。<br>2. 固定正好 3 个审核级负向 Case：无 Token、Owner A 访问 Owner B、无 Scope/不存在的内部工具。<br>3. 每次调用前后对账两个 Owner 的对象/Event/Receipt 计数。 | 3/3 Case 按预期被拒绝；负向 Assertion 通过率 100%；成功业务写数为 0；Owner B 内容泄露字段/片段命中数为 0；未知/内部工具不得返回内部 Schema；错误码与合同一致。 | Promptfoo JSON/JUnit、两 Owner 前后计数、脱敏错误 Envelope、泄露扫描日志。 | 30～45 分钟 | 安全行为测试者 1 人；RES-PF-NEG；Promptfoo、隔离 DB。 | 无；独立双 Owner 数据库，不与其他行为任务共享。 |
| A06 原子性、幂等、CAS 与故障注入 | 验证写路径在重放、stale CAS 和中途故障下不会部分提交或伪造成功。 | CF-09～CF-11；IF-07；SC-05～SC-07 | P0 | RES-CAS；可注入事务失败的隔离实现；固定基线计数；不得接触生产。 | 1. 使用唯一 `ACAS-` idempotency key 执行一次成功写。<br>2. 原样重放同一请求。<br>3. 使用 stale base version 执行。<br>4. 在 Event/Receipt 提交边界注入一次失败。<br>5. 查询业务对象、Event、Receipt、Canonical version 并对账。 | 首次成功符合合同；重放后业务对象数不增加；stale CAS 返回明确 Conflict 且对象/Event/Receipt/版本增量均为 0；故障注入不留下半条业务对象、伪成功 Event 或 Receipt；所有失败结果 `success=false`/`isError=true`。 | 请求/响应、故障注入点、前后计数、事务日志、对账表。 | 45～60 分钟 | 后端测试者 1 人；RES-CAS；隔离 DB、故障注入 Harness。 | 无；独立数据库和幂等键前缀。 |
| A07 Gitleaks 完整历史与当前树扫描 | 证明候选历史和当前树不存在未处理 Secret，并保证报告不泄密。 | CF-13、CF-14；IF-08、IF-10；SC-11 | P0 | RES-GITLEAKS；完整 Git 历史；锁定 Gitleaks；扫描报告目录不可公开。 | 1. `gitleaks git . --redact --report-format sarif --report-path gitleaks-results.sarif`。<br>2. 另运行当前目录扫描（如版本支持：`gitleaks dir . --redact ...`）。<br>3. 每个命中分类为真实 Secret、已撤销历史 Secret 或误报；不得自动生成宽泛豁免。<br>4. 检查 `.gitleaks.toml/.gitleaksignore`。 | 主扫描退出码 0；未处理命中数为 0；新 Secret 命中数为 0；报告中明文 Secret 数为 0；每个精确豁免均有规则、fingerprint、原因、撤销/误报证据和复审日期；不得存在 `memory/**`、`tests/**` 等宽泛全局排除。 | 脱敏 SARIF、版本、命令日志、例外登记表、报告 SHA-256。 | 30～120 分钟（取决于历史命中） | 安全审查者 1 人；RES-GITLEAKS；Gitleaks。 | 与其他步骤无冲突；A08 使用同一资源，二者串行。 |
| A08 Gitleaks 探测能力自检 | 证明 Gate 确实能发现 Secret，而不是配置错误导致“零命中”。 | CF-14；IF-08、IF-10；SC-11 | P1 | A07 工具配置可用；RES-GITLEAKS；一次性临时目录，不进入 Commit。 | 1. 在 disposable 临时目录生成仅匹配测试规则的假 Secret Sentinel。<br>2. 运行 Gitleaks 目录扫描。<br>3. 记录非零退出码。<br>4. 删除临时目录并验证仓库工作树不含 Sentinel。 | Sentinel 扫描退出码非 0；精确命中测试规则 1 次；真实仓库文件变化数为 0；最终 `git status --porcelain` 与执行前一致。 | 脱敏退出码与规则 ID、临时目录创建/删除日志、前后 Git 状态。 | 15～20 分钟 | 安全测试者 1 人；RES-GITLEAKS。 | 与 A07 冲突：必须在 A07 后串行；与其他步骤无冲突。 |
| A09 Trivy 漏洞、配置和 Secret 扫描 | 验证依赖、锁文件和基础设施配置没有未接受的 HIGH/CRITICAL 风险。 | CF-13、CF-14；IF-09、IF-10；SC-12 | P0 | RES-TRIVY；锁定 Trivy；独立 DB/cache；不需要生产凭据。 | 1. `trivy fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --exit-code 1 --format sarif --output trivy-results.sarif .`。<br>2. 记录 Trivy 与漏洞数据库版本/时间。<br>3. 校验 `.trivyignore`：每个例外必须精确到 ID，并具有原因、Owner、到期日。 | 退出码 0；未接受的 HIGH/CRITICAL 数为 0；Secret 命中数为 0；已过期例外数为 0；无 ID/原因/Owner/到期日的例外数为 0；报告可解析且已脱敏。 | SARIF、Trivy/DB 版本、例外清单、命令日志、SHA-256。 | 30～60 分钟 | 供应链安全审查者 1 人；RES-TRIVY；Trivy。 | 无；独立 checkout/cache。A10 与其共享资源，需串行。 |
| A10 License/SBOM 降级验收 | 形成依赖清单和 License 观察基线，不阻断首轮技术基线。 | CF-14；IF-09、IF-10 | P2 | A09 完成；RES-TRIVY。 | 1. `trivy fs --scanners license --exit-code 0 --format json --output trivy-license.json .`。<br>2. 生成 CycloneDX SBOM（按锁定版本支持的命令）。<br>3. 统计未知/禁止 License。 | 报告和 SBOM 均可解析；依赖条目有名称、版本和来源；未知/禁止 License 数量已记录并形成后续项；本步骤不以报告存在为 Kernel Next 阻断依据。 | License JSON、CycloneDX SBOM、统计表、SHA-256。 | 20～30 分钟 | 供应链审查者 1 人；RES-TRIVY；Trivy。 | 与 A09 冲突：必须串行；可与其他工作线并行。 |
| A11 CI Required Checks 与阻断语义 | 验证四个 Gate 在 PR 中被执行且失败能阻断合并。 | CF-03、CF-12、CF-14；IF-05、IF-08～IF-10；SC-10～SC-13 | P0 | RES-CI；候选分支/PR；只允许修改验收配置范围；有只读分支保护查询权限。 | 1. 校验 Workflow YAML 和依赖锁。<br>2. 触发干净候选：`public-mcp-protocol`、`public-mcp-behavior`、`gitleaks`、`trivy`。<br>3. 使用一次性受控失败输入分别验证每个 Job 非零退出；不得把失败 Fixture 合并到目标分支。<br>4. 只读核对目标分支保护/Ruleset 要求四个 Check。 | 干净候选四个 Check 4/4 成功；四类受控失败均能使对应 Check 失败；`continue-on-error`、无条件成功和吞掉退出码的命中数为 0；目标分支 Required Check 名称与四个固定名称 4/4 一致。 | Workflow 文件、运行 URL/ID、Job 日志、分支保护只读输出、失败矩阵。 | 45～75 分钟 | CI 审查者 1 人；RES-CI；GitHub Actions。 | 静态部分可与 W1 并行；最终 4/4 结果确认需等待 A01/A02/A04/A05/A06/A07/A09 对应 Gate 可运行。专用分支避免与功能 PR 冲突。 |
| A12 Evidence 脱敏、覆盖闭环与摘要封存 | 把各分支结果收敛成可复核、无敏感数据、可复算的验收包。 | CF-13、CF-14；IF-10；SC-13 | P0 | 所有 P0 执行结果到齐；RES-EVIDENCE；只读输入。 | 1. 收集 A00～A11 的 P0 结果。<br>2. 运行 Token/Secret/用户原文扫描。<br>3. 运行覆盖检查：`node evals/public-mcp/verify-coverage.mjs coverage-matrix.json results/`。<br>4. 生成 `acceptance-manifest.json` 和 `SHA256SUMS`。<br>5. 固定未完成 P1/P2 项和有效例外。 | 38/38 清单项至少有一个 P0 结果；P0 步骤结果齐全率 100%；Artifact Secret/Token/非合成用户原文命中数为 0；Manifest 中每个文件的 SHA-256 复算一致；失败/跳过项不得被标记 PASS。 | Evidence 目录、Coverage 报告、Manifest、SHA256SUMS、脱敏扫描日志。 | 30～45 分钟 | Evidence 维护者 1 人；RES-EVIDENCE；Node、SHA-256 工具。 | 依赖全部 P0 输出，不能提前；独占汇总目录，避免并发改写。 |
| A13 Fresh clone 独立复验与最终裁决 | 证明候选对象、测试和 Evidence 可由另一执行者独立取得并复现。 | CF-14；IF-10；SC-14，以及全部清单项的最终追溯 | P0 | RES-REVIEW；另一执行者；固定 Commit；完整验收包；不使用实现者缓存/工作区。 | 1. fresh clone 固定 Commit。<br>2. 从锁文件安装工具。<br>3. 复跑四个 Gate 和覆盖检查。<br>4. 复算全部 SHA-256。<br>5. 检查生产写入记录为 0（A03 仅只读）。<br>6. 输出独立裁决报告。 | 固定 Commit 可取得且类型为 commit；四个 Gate 4/4 通过；38/38 覆盖一致；Evidence 摘要 100% 匹配；无生产写、部署或配置变更；独立报告只能在全部 P0 通过时给出 `PASS / CLUED_PRE_KERNEL_PUBLIC_MCP_REGRESSION_SECURITY_BASELINE`。 | 独立复验报告、fresh-clone 命令日志、Gate 结果、摘要复算表、最终裁决。 | 60～90 分钟 | 独立复验者 1 人；RES-REVIEW；全新 Runner。 | 必须在 A12 后执行；人员、工作区和缓存必须与实施/汇总方隔离。 |
| A14 低成本性能观察 | 记录公共 MCP 基础延迟和超时情况，为后续 k6 基线提供观察值；不替代容量测试。 | CF-01、CF-11；IF-01、IF-04～IF-06 | P2 | 独立只读测试账号或隔离环境；固定一个只读请求；不得产生生产写。 | 对同一只读 `initialize`/工具调用执行 30 次，记录状态码、总耗时、p50、p95、最大值和超时；并发固定为 1。 | 30/30 返回合同预期结果；超时数为 0；单次均小于 Inspector 60 秒默认超时；p50/p95/最大值完整记录。性能数值仅形成观察基线，不直接声明容量通过。 | 原始 CSV/JSON、统计表、环境与时间说明。 | 20～30 分钟 | 性能观察者 1 人；独立只读环境；Inspector/脚本。 | 无；只读且并发 1。若使用生产账号，必须与 A03 使用不同专用账号/Binding。 |

## 4. 结果目录与证据最小格式

每个任务只写自己的目录，禁止多个任务并发修改同一结果文件：

```text
evidence/pre-kernel-public-mcp/<PRE_KERNEL_BASELINE_COMMIT>/
├── A00-coverage/
├── A01-protocol/
├── A02-tools-contract/
├── A03-oauth-readonly/
├── A04-promptfoo-positive/
├── A05-promptfoo-negative/
├── A06-atomicity-cas/
├── A07-gitleaks/
├── A08-gitleaks-selftest/
├── A09-trivy/
├── A10-license-sbom/
├── A11-ci-gates/
├── A12-consolidated/
└── A13-independent-review/
```

每个任务目录至少包含：

| 字段/文件 | 要求 |
|---|---|
| `result.json` | `task_id`、Commit、工具版本、环境 ID、开始/结束时间、执行者角色、PASS/FAIL/SKIPPED、错误码。 |
| `commands.log` | 实际命令与退出码；Token、Secret、Cookie、用户原文必须脱敏。 |
| `coverage.json` | 本步骤实际覆盖的 CF/IF/SC ID 及每项结果。 |
| 原始报告 | Inspector JSON、Promptfoo JSON/JUnit、Gitleaks/Trivy SARIF、数据库对账等；只保存复验需要的最小内容。 |
| `SHA256SUMS` | 本目录所有交付文件的摘要，不含临时 Token 或未脱敏文件。 |

## 5. 裁剪、合并与完整性底线

### 5.1 可合并执行的步骤

| 可合并组合 | 降本方式 | 约束 |
|---|---|---|
| A01 + A02 | 同一名执行者、同一批 Inspector 工具；若资源不足可串行复用一个隔离 MCP。 | 复用前必须重启实例并清空 OAuth/会话状态；结果目录仍分开。 |
| A04 + A05 + A06 | 同一 Promptfoo/Node 工具链；资源不足时可在一个隔离环境串行运行。 | 每组必须恢复独立数据库快照、Owner、Project、Token 和幂等键前缀；不得并行共享同一数据库。 |
| A07 + A08 | 同一 Gitleaks clone 串行运行。 | A08 Sentinel 只能在一次性临时目录，不得进入仓库历史。 |
| A09 + A10 | 同一 Trivy checkout/cache 串行运行。 | A09 P0 结果必须先固定；A10 不得改变 A09 的配置或裁决。 |
| A12 的覆盖校验 + 摘要生成 | 由同一 Evidence 维护者一次完成。 | A13 必须仍由另一执行者完成，不能为了省人取消独立性。 |

### 5.2 可裁剪或降级的步骤

| 步骤 | 允许的裁剪/降级 | 不允许的降级 |
|---|---|---|
| A08（P1） | 时间紧张可不做 Sentinel 自检，但必须保留 A07 完整扫描。 | 不得用 A08 代替 A07。 |
| A10（P2） | 可只生成依赖清单，暂不做 License 裁决；也可整体后移。 | 不得因此跳过 A09 HIGH/CRITICAL 与 Secret 扫描。 |
| A14（P2） | 可降为 10 次只读抽样或完全后移到 k6 阶段。 | 不得把低样本结果宣称为容量、稳定性或 SLA 通过。 |
| A02 工具说明人工复核 | P1/P2 说明文字质量可抽样，但 Schema、Scope、注解和公共/内部隔离必须全量。 | 不得抽样工具名、Schema、Scope 或安全注解。 |
| A07 历史扫描 | 历史极大时可先 PR 增量扫描并把完整历史扫描移到独立 Runner。 | 最终封存前必须完成一次完整历史扫描，不能永久只扫当前树。 |

### 5.3 完整性不可妥协的底线

以下项目缺一项，验收即失去意义，最终裁决只能是 FAIL 或 INCOMPLETE：

1. P6 未正式 Closeout，或未固定可取得的 `PRE_KERNEL_BASELINE_COMMIT`。
2. A00 未完成 38/38 覆盖冻结，或存在未映射的核心功能、接口、场景。
3. A01/A02 未证明 MCP 协议、工具 Schema、Scope、注解和公共/内部隔离。
4. A03 未完成真实公共入口 OAuth + PKCE 的只读验收。
5. A04 的 5 个正向 Case 或 A05 的 3 个负向 Case 有任一缺失、跳过或失败。
6. A06 未证明 Canonical 写入、Event、Receipt、幂等与 CAS 的原子边界。
7. A07 未完成 Gitleaks 完整历史/当前树扫描，或存在未处理 Secret。
8. A09 存在未接受的 HIGH/CRITICAL 漏洞、严重配置错误、Secret 或无效例外。
9. A11 四个 Required Checks 未真正阻断失败，或存在 `continue-on-error`/吞退出码。
10. A12 Evidence 含 Secret、真实 Token、非合成用户原文，或摘要/覆盖无法复算。
11. A13 未由另一执行者从 fresh clone 独立复验，或固定候选对象/Evidence 无法取得。
12. 验收过程发生任何未授权的生产写入、部署、数据库、DNS、Binding、Secret、流量或 Migration 变更。

只有上述 P0 底线全部满足，才允许给出：

`PASS / CLUED_PRE_KERNEL_PUBLIC_MCP_REGRESSION_SECURITY_BASELINE`

该 PASS 只表示 Kernel Next 开始前的公共 MCP、回归与安全基线通过；不代表 OpenAI 公共目录已发布，不代表 Kernel Next 合同/Gate 已通过，也不构成后续仓库或生产执行授权。
