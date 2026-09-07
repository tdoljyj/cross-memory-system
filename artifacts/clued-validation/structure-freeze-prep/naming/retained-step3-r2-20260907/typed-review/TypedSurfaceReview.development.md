# Step 3 typed naming 开发态规则审查

本轮已完成全仓提取和全部 148 个 unresolved site 的逐项分类，并补充明确绑定源码的 RPC helper 观察。原始扫描器的 code_rpc 记录未单列 3 个 helper 目标，本次通过单独的来源补充记录交接，不篡改原始扫描统计；`semantic_completeness=NOT_PROVEN` 表示这些规则不提供整个程序的语义完备证明，不能单凭这个字段把 Step 3 永久判为不就绪。本报告提交独立规则审查，**不签发 Gate、Architecture Acceptance 或 Structure Freeze**。Auth 与 Library 两项外部缺证仍由主任务处理，不能据此进入 Step 4。

本次在提交 `5fad76df81c8a412e7768e08427841f0985a2588` 的干净工作树按新 tracked 集合重扫，确认 HEAD 及全部扫描源码在捕获前后保持一致。scanner SHA256：`9ff7dc893b865a7736d6d9ffbe6f908c15f9c418e10a0602ae6fd33eedb8f81e`。扫描 3,961 个 tracked 文件，产生 60,146 个原始观察记录。逐项分类引用的 67 份源码摘要已核对。随后与正式 CI run `34100327450` 的 Manifest 完成精确匹配：提交、tree、scanner、scope、全部规则分母、原始观察记录和 148 个 unresolved site 一致，详见 `CiReviewBindingReceipt.json`。这次匹配不授予 Gate，也不替代独立规则审查。

## 已修复的实际问题

1. 区分 `==/===` 与赋值；Python 改用 AST 识别实际赋值、字典键、调用关键字、比较及实际函数参数默认值，使用 tokenizer 保留三引号字符串/注释边界。类型标注、注释、示例文本不再伪造动态 scope。
2. `rpc(client, name, ...)`、`rpc(id, method, ...)` 根据本文件明确的参数位置提取观察值；函数声明不当调用，无法绑定的位置继续留缺口。直接成员 `.rpc(name)` 保持首参规则。
3. 补齐内联 role/scope Schema enum、scope pattern、capabilities 对象键及复合 scope 字段/数组。整个 JSON 对象不会作为一个 scope 名。混合动态对象保留固定字段，只有实际动态字段单独留 unresolved；spread/computed 等不自动当成功。
4. 本代理新增 20 项定向测试均通过；最终整组 `test_naming_inventory_*.py` 共 71 项通过。包括真实 p5/records/continuity 源码、动态路由拼接、错误 RPC 参数猜测、复合对象与 Python 假阳性负例。

## 规则分母

| 规则 | 已选择文件 | 已读取文件 | candidate sites | observations | unresolved sites |
|---|---:|---:|---:|---:|---:|
| JSON 命名字段/Registry 键 | 3247 | 3247 | 57294 | 57294 | 0 |
| package scripts/dependencies/exports | 1 | 1 | 71 | 71 | 0 |
| Route | 273 | 273 | 43 | 40 | 3 |
| RPC | 273 | 273 | 67 | 59 | 8 |
| import/export/module | 275 | 275 | 1884 | 1876 | 8 |
| role/capability/scope/namespace | 273 | 273 | 394 | 365 | 127 |
| TOML/YAML naming | 14 | 14 | 60 | 58 | 2 |
| SQL object declarations | 32 | 32 | 383 | 383 | 0 |
| 无 typed extractor 的已知源语言 | 0 | 0 | 0 | 0 | 0 |

这些是 9 个代码提取规则，**不是基线 9 类外部/仓库命名面的 9 次 PASS**。同一文件可落入多条规则；复合对象的一个 site 可展开多个字段与动态值，因此三个记录计数不能简单相加。零匹配不证明不存在相应命名面。60,146 条也不是 60,146 个独立业务身份，JSON 结构键占主要部分。

## 148 项实际分类及交接

完整逐项数据在 `UnresolvedReview.development.json`，每项保留原 path/line/column、expression SHA256、源码 SHA256、定义引用、分类理由和 Step 5/6 义务。没有靠“其余均忽略”的默认分支分类；无法命中的 site 会使分类脚本失败。

| 分类 | 数量 | 当前可做的判断 | 后续义务 |
|---|---:|---|---|
| FINITE_STATIC_MAPPING | 60 | 有确定的有限定义来源；已经记录候选值/复合结构或定义位置 | Step 5 纳入规范命名映射，Step 6 绑定具体调用/合同。RPC 候选按各自 map/union/helper 字面调用提取，带每个值的来源位置；不冒称源代码族等于运行时可达性。 |
| RUNTIME_OR_STEP6_BINDING | 85 | 命名来源/字段/模板已经识别，实值依赖请求、fixture、版本或授予对象 | 保留 UNKNOWN 与表达式证据；定义 `project:<id>` 等命名族、引用既有类型/授权合同，再用实际消费者及正负例绑定。不得要求枚举未来所有 UUID 或重新运行冻结的历史引擎。 |
| NON_NAME_SYMBOL_HOMONYM | 3 | `scope` 是盘点配置路径/对象变量，或 `capability` 是数字退出码 | 保留审查证据并标注非产品命名标识；不因同名局部变量永久阻断，也不删除原始观察。 |
| 未审查或残留已查证解析失败 | 0 | 本轮所有 unresolved 均有具体解释 | 新语言、源码/规则变更或新出现的未解析形式必须重新审查。 |

重点有限定义包括：

- `apps/clued-cloud/app/chatgpt-auth.ts:74–76` 的三条保留 Auth 路径来自同文件第 15–17 行三个常量，已得到 `/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback`。这不是云端 Auth redirect 配置证据。
- `worker/continuity.ts` 的 4 个 RPC 模板和 3 个 map spread，分别指向 projects/records/p5 的实际 map 值、helper 字面调用和 UserRecordRpc union；现不再用整文件 clued 字符串猜集合。此处是源代码定义族，不代表部署的 DB 函数已经存在、可达或授权正确。
- ALL_SCOPES、RecordLevel、规范化的 project/global 分支、历史 SCOPES 和 `_SCOPE_*` fixture 结构均有精确来源；caller 选择哪个值仍与“有哪些定义”分开。
- 新拆出的 capabilities 动态字段包含既有 P6 合同/策略对象引用，属于可有限映射的复合定义。enablement 与 `versionAttribution(env)` 则属于实时状态，不能用源文件默认值冒充实际部署状态。

8 个动态 import 都是测试 worker 构建入口及缓存破坏参数；入口来源已经定位，精确构建输出哈希须由实际测试/CI receipt 承接。运行时 scope/capability 的许多项仅是转送结构，不能因其值尚未实例化就断言漏扫定义；也不能据此证明权限合同已经满足。

历史目录的处置有原件依据：`legacy/local-memory-engine-vnext2/README.md:3–5` 明确冻结为审计用途、不是当前 consumer，并禁止为了当前访问而运行它。本次仍保留历史文件与 naming site 的分母和观察，不将其当作现行授权，亦不因历史代码中出现动态 grant 而要求恢复运行。

## 验证边界

这些证据支持的是“选定规则所遇到的命名来源都已记录并完成规则层分类”。Step 3 是否能移除 typed-rule-review gap，应由独立审查确认规则分母、这 148 项分类、主汇总完整记录与提交后 CI 一致性后决定。Step 5 的命名规范和 Step 6 的 Owner/六类身份/typed consumer 语义绑定仍按原 21 步执行，不前置成 Step 3 的无限门槛，也不在此宣称完成。

本目录交付：`DevelopmentSummary.json`（工作树边界、统计、分母）、`TypedSurfaceInventory.development.json`（观察/原 unresolved）、`ScannedSourceManifest.development.json`（扫描时源码摘要）、`UnresolvedReview.development.json`（完整逐项审查）。上述开发证据不覆盖或替代将由主任务生成的精确提交 CI 产物。


## RPC 修正与正式 CI 交接

独立审查指出原分类脚本 `[a-z_]+` 漏掉带数字的 `clued_p5_*`，且误收 `clued_bnd_`。已改为按具体 map 的 value、helper 字面参数、参数/type union 提取，并为每个值保留实际 path/line/column/source SHA256。continuity.ts 的 382/906/1071/1129 四个调用族现在分别为 8/20/2/6 个值，三个 spread 863/864/865 分别为 2/6/5 个值。没有 token 前缀充当 RPC。

`clued_p5_attempt_begin`、`clued_p5_attempt_resolve`、`clued_p5_record_commit_failure` 已由实际 p5GatewayRpc 调用位置补证。`SupplementalRpcObservations.development.json` 保存 5 个字面调用位置（4 个去重目标，包括已存在的 mutate），明确不计入主扫描器的 60,146 条统计；该补充及其来源摘要须与主清单一起保全。

正式 CI 的逐项键采用规范 JSON 的 SHA256，输入为 scanner SHA256、source SHA256、path、line、column、rule_id、reason、pointer 和 expression SHA256。匹配使用 Counter 保留重复项数量，同时核对所有定义引用的源码摘要、scope 摘要、完整规则选择/分母和原始观察记录摘要。新项、消失项、源码或规则变化均要求对应增量审查；不会把开发报告直接作为新提交的放行证据。`verify_review_against_ci.py` 是可复用的只读校验器，其期望 commit/tree/scanner/Manifest 摘要必须来自既有已核验 CI 证据流程，JSON 自述不认证来源。当前正式 CI 的 148 项全部精确匹配，分类仍为 60 有限静态映射、85 运行时或 Step 6 绑定、3 同名非命名对象。
