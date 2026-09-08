# 控制合同候选机器表达

**CANDIDATE_NOT_ACTIVATED / NO_AUTHORITY_EFFECT**。这三份 Draft-07 JSON Schema 仅把已定位原规则转成可审阅、可执行的候选格式；未写入正式 protocol/schema 责任域，未激活生产 wire，未签发 GA、Profile 接受或 controller 资格。当前真实控制根代际仍未绑定，不能为了填表伪造 `1`、mergeSHA 或 publication sequence。

精确来源、成员路径、摘要和争议边界见仓库 `artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/ControlContractConcretizationReview.md`（SHA256 `09398c3f75c582bd769fbfb0ab3d5b135d4f063c59344166df3f3b920d07346a`）。本次不更改原固定源。

| 候选文件 | 原文固定的部分 | 仍是候选表示选择 |
|---|---|---|
| `gate-authorization.candidate.schema.json` | S06 L3879/3885 的精确输入、权限/用途/时间边界和动态控制绑定；QualificationPhasePolicy L138–166 独立输入 | 原文未规定拼写的字段名、`{uri,sha256}`引用结构、签名载体、独立generation的字符串编码。`control_trust_root_generation`字符串参考S06 L200示例，不能宣称这是已接受正式Schema的类型 |
| `preentry-profile.candidate.schema.json` | 原政策 L9–71 的前Entry目的/隔离环境/候选状态/R05–R10/真假条件，L121的600秒；S06 L3435精确gate引用 | N/A层权限表达、引用字段的机器布局。集合校验不要求无意义的原数组顺序 |
| `revocation-epoch-vector.candidate.schema.json` | S06 L3010明确唯一载荷名及九个内部字段；L3012要求四层完整、N/A原因、独立其他代际和当前Canonical逐层比较 | epoch非负整数、schema version字符串、成对`not_applicable`字面量和按层`not_applicable_evidence`是待接受表示。NA证据要求reason及accepted_schema_ref+摘要，无任何默认NA。真实观察到的epoch零与拿零替代不适用层不同 |

S06 SHA256：`f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec`；政策 SHA256：`154a5ca0e3d6786877662b68a173176ecd54712744400805ef4b2a93f5946f22`。没有把P5的org/workspace/member/greatest标量改名为四层向量；实际隔离来源缺口保持原映射。

运行验证：在本目录运行 `node --test validate-candidates.test.mjs`。仅复用 `apps/clued-cloud` 已安装的 Ajv 6，不下载依赖。样例全部只在测试进程内存里构造：过去时间、`synthetic`未解析引用、非签名字符串，不保存任何可误认为真实发行的GA实例。没有真实actor、root generation或accepted reference。正例表示**语法通过**，不表示这些伪引用被接受。

必须另外核验的实际合同条件：引用确实存在且摘要匹配；Profile/Schema已被有权独立评估者接受；原子Gate ID及阶段适用；root的当前代际/历史顺序、issuer用途、Audience和真实签名；Owner当前授权/剩余窗口/预算；每GA期限、时间先后；Vector当前值及NA许可与对应层的一致性；受查产物和实际读写/停止/撤回边界。JSON Schema不能把这些远端事实变成真。三个Schema均不接线任何执行器，测试故意展示过期且未签对象可通过格式检查以防混淆。

原政策明确列出的 `scope_digest`、`profile_digest`、`plan_digest`、`fixtures_digest`、`candidate_skill_digest`、`mechanism_digest`、`host_runtime_config_digest`、`controller_digest`、`stop_policy_digest` 与 `dominant_role` 保留原名；`gate_authorization_ref` 是消费运行记录对GA的引用，不强造为GA自引用。引用/摘要的一致性仍需外部验证。

2026-09-08 原候选实际运行：**10/10 格式检查通过，0失败/跳过**（102.549ms），对应当时 Vector SHA `40cc625e225a8544042a7e1bfff68bf30f4874081db77920d2034884b8cfd166`、test SHA `222102166dd854b07d65b564f84822d7350f13f98275210e3cace1b73491b719`。这条历史结果不回写为修订后源的完整重跑。覆盖九字段缺失、错误epoch、缺N/A原因/接受引用、全部NA无引用、独立generation混入Vector、缺GA输入、root错误类型、前Entry范围/600秒和日期/摘要格式。

独立评审实证发现：默认 JavaScript Number 会把 `9007199254740992` / `9007199254740993` 舍入成同值；Ajv fast日期格式会接受不存在的日历日期。当前候选四层epoch均限制到安全整数 `9007199254740991`，这是本实现限制，**不是给S06新增epoch上限**；超出时拒绝，不用舍入值继续核对。验证器启用 Ajv `format: 'full'`，附加不存在的日期/闰年正例。未引入新库、新epoch类型、Authority或运行时接线。

修订定点命令：`node --test --test-name-pattern="review fix:" validate-candidates.test.mjs`，仅执行两项新增检查；实际 **2/2通过，0失败/跳过，101.3867ms**。旧10项未重跑；不将这两项结果宣称完整12项重跑。没有运行PQUAL、真实隔离动作、生产操作或模型调用。

独立评审由既定 `project_list_auth_fix` 执行；本目录实现者不接受自己的候选Schema，也不自行签发资格。
