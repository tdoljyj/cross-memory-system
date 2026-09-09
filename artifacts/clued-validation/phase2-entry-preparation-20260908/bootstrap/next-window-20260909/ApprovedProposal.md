# Phase 2 下一窗口与单次资格执行：合并授权提案
状态：待用户批准；批准不是验收 PASS。此提案只覆盖下面明确的一轮，不授权自动重试或未来 Surgical 权限。

## 本次请确认的内容

建议从本任务收到明确批准的实际时刻 T 起，建立新的 **24 小时**有限委托窗口；T 和 T+24h 在批准后记录为明确 UTC 时间，不能按每次运行滚动续期。仍用当前 GitHub 身份 tdoljyj、现有私有仓库与原 Root set；无新增本地密钥、付费模型、生产业务权限或第二套 Authorization。

| 事项 | 本次精确范围 |
|---|---|
| 有限授权绑定维护例外 NW-01 | 仅在现有非生产控制命名空间，对同一个 Root 的单行 accepted_binding 做一次受审维护，更新新批准及窗口所必需的登记字段与精确约束。**这会替换旧在线绑定行，属于对原不可变承诺的一次明确例外**；不是原接口已有的自动续期。具体限制见下一节。 |
| 证据额度 | 总上限从 1,073,741,824 B 增至 **1,127,852,979 B**，只增加 **54,111,155 B**。原已计 993,635,251 B 不退款。 |
| 下一次运行 | 只允许一个新 GA，最长 **600 秒**，固定分配 **134,217,728 B（128 MiB）**，最多一个活动实例。累计秒数从 4506 到 5106，原 **7200 秒**总限额不变。结束为 PASS/FAIL/BLOCKED/STALE 均不自动再起一次。 |
| 正式接线与登记 | 只为这一个用途接受已审环境/宿主后继、形成新窗口真实签名及元数据、按原规则追加新 Root 代际、追加准确 Status 与第四次 controller 绑定事件，执行本提案列明的私有数据库差额并独立回读。 |
| 单次动作及失败收口 | 原固定 CREATE/START/STOP/inspect/wait、真实观察、19 项独评、决策、签名和 GRR CAS；发生失败按原撤销/停止/真实非 PASS 对账收口。不得补造观察、扩大宿主命令或对未知动作盲重发。 |
| 限定发布与回读 | 下述同私有仓库中的必要源/元数据 PR，以及本次新 GA 和对应 GRR 的签名承诺、实际停止后的完整原始输入及有关验收证据。旧一轮已完成发布不重做。 |

目标数据库是 **uscrdifznmlvczcekqpw** 中现有私有 **clued_control** 命名空间；Root set 固定 **ctr_414bd3c724264a83894b0c55cf2ab878**。同数据库中的其他业务表和生产业务权限不在本次范围。

## 必须明确同意的一处维护偏差：NW-01

实际旧窗口已于 2026-09-09T09:28:59Z 到期。accepted_binding 的截止、批准 commit、subject 受固定 CHECK 限制；Root id 固定且为主键，原 immutable 触发器禁止 UPDATE/DELETE/TRUNCATE。同 Root 插入第二行及直接换 Root 均不被现结构允许。只延长 Root JSON 或恢复自动化不能续期。

本次建议采用较小的一次性受审维护，不新建常驻续期接口或追加一套窗口存储机制：

1. 实际修改前，完整保存旧绑定行原文、摘要、旧批准及签名来源；保存当前全部相关表行、Root 历史、39 条执行事件、5 次终态回执、函数/ACL/索引/约束及触发器目录。不能只保存一个旧摘要而丢掉旧值。
2. 单事务核对准确旧像、同 Root/项目/用途/环境、真实空活动槽及无待分配；仅更新 accepted_binding 的新批准 commit、有限起止时间、必要新受查 subject 和对应接受/签名来源字段。旧行转为完整历史证据保全，不能宣称旧在线行没有变化。
3. 仅对必要 CHECK 设准确新值；如需维护 immutable 触发器，**仅这一表、这一触发器、这一行、同一事务内临时停用并恢复原定义与启用状态**。禁止关闭所有触发器或留下可重复调用的后门。失败整笔回滚。
4. 原 Root1/Root2、撤销历史、旧 Status、全部旧 GA/GRR、执行事件和预算历史不改。新 Root 仍走原前向代际规则；Root 当前序号2与执行序号39分开处理，不能发明“终态40”。
5. 新旧绑定摘要在历史校验中保持各自当时含义，不能重写旧事件来适配新当前绑定。若现有消费者不能保持这个边界，先报告明确差额，不以本提案批准任意改写。

这是显式的登记维护偏差，**不属于 Health/Surgical Lane**，不创建生产 SurgicalGrant、Break-glass、通用续期 RPC 或隐藏写入口。用户若不批准这一例外，则该路径不执行；更大 append-only 设计也没有因此被批准。

[独立偏差审查 NW-01](C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/NextWindowSingleRunIndependentReview.md)，SHA256：46e1a94ef66c3ea42dbbd0e839d3e2a4e4827a5cbc1be34e55a739f5255f9db6。

本轮正式数据库只读观察（2026-09-09T10:01:19.084071Z）确认：准确触发器名为 **accepted_binding_immutable**，原启用态 **O**，其调用 **deny_mutation()** 拒绝 UPDATE/DELETE/TRUNCATE；另一张 execution_binding 的不可变触发器不在本次临时维护范围。当前头表的准确名字为 **current_head**，执行仍seq39、active/pending空、已计4506秒/993,635,251B。查询未修改任何数据；[完整工具原回包](C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/next-window-binding-readonly-20260909/ActualToolResult.json) SHA256 **565a672538ae3f7e5194c8d31acf06d5a70a4f83c5212b4a670f8a4f0fa5a101**。实际维护前仍按已备准确前像守卫执行，不能把此观察当作永久新鲜许可。

## 已备的具体修改与执行前门槛

| 部分 | 已有结果 | 正式执行前必须补齐 |
|---|---|---|
| 环境与宿主源码 | 显式七项公开环境及安全拒绝诊断；宿主后继 manifest **82fbf9a1d2cb0bac1f4fa9b98e34983e312629946dbd18e3fa609a6761c33a1c**，280 项声明文件实际匹配，7 项真实 Job 检查通过，独立87f/3b1d接受。旧冻结文件保留。 | 原完整用途接受/源码 PR、真实窗口/Scope/Profile/qualification/runtime/Status及当前有效绑定；七项环境的正式容器验证尚未发生。 |
| 最小预算 SQL | install.candidate.sql **6dcd95cfe0d76dabaad91fe64f991a47998bdb59b635a429da6673f91fada5c7**（7063 B）；rollback.candidate.sql **8949ff8a461dfc585a019cbcef95538f6aa13a8cd4e11113b34d5194b3a4a4e2**（7254 B）。只改 reserve_execution_budget 的累计上限和 execution_current 单 CHECK 上界。已有9纯检查及d7b3静态独评，另已完成本机 PostgreSQL 11项实际守卫、原子性、限额和回滚验证，结果1445286f，独立实际证据核对0440f4bd通过。 | 如果新窗口维护改变安装前像，明确组合事务顺序和准确前后像，不能静默放宽固定seq39检查。本地使用公开标注的合成过期绑定及历史原函数字节作为测试夹具，未续期、未调用分配函数，不构成正式准入。 |
| 窗口维护、代际/Status/第四forward | NW-01具体作用边界、旧实际来源和最小方案已独立审查。 | 真实批准时刻、Owner commit及新签名只能在批准后产生。完整迁移必须据真实材料生成，先完成局部数据库验证、精确差分和独立完整旧像/新像检查，再执行；当前没有可冒用的已签续期材料。 |
| 普通pipe与STOP预载 | 82fb后继接线及4个观察/发布适配器已完成，13项本地检查通过，最终清单1191d426、独立接线核对e492a0bb通过；复用真实seq39完整历史，尺寸投影未超现有限额。STOP在READY前仍拒绝过期窗口。 | 真实新材料后的最终helper/接收链和停止入口实际就绪；投影长度不是最终真实消息验收，未来完整19项GRR尚无尺寸通过证据。 |

本提案不把未形成的 SQL、签名、Root ID 或 GA 结果填成已完成。用户批准的是上述明确例外、数据种类和限定操作范围；批准后所有实际字节仍须独立审查和原有 Gate。实现不得超出这份清单，也不能以“批过概念”为由略过任何门槛。

涉及的原控制接口保持既有用途：reserve_execution_budget、reserve_gate、record_effect_intent、dispatch_recorded_intent、execution_transition、commit_gate_result，以及原 Root 事件/Status 追加。effective_execution_binding 只增加对应准确第四 forward 的识别，保留前三完整事件，不改为任意 forward 放行。

## 发布数据与目的地

- 私有仓库：**tdoljyj/cross-memory-system**。源码和治理材料使用本任务既有受审 PR 流程，证据继续使用 **codex/phase2-qualification-evidence-20260908**。
- 源码和治理材料的受审 PR 仅包含本次明确后继所必需的代码、批准、资格、运行时、Status、Root元数据及独立接受；治理证据沿既有 **artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/** 路径。此范围不授权任意外部载荷。运行证据限定为下面四类，各一次，前缀统一为该目录的 **runtime-evidence/**：
  1. 本次静态签名回读观察：**next-window-runtime-static-signature-20260909/result.json**。字段限本轮实际源码/Owner合并/公开验签、相应用途材料引用及摘要、Status摘要和审计时刻；不包含数据库快照或GA/GRR原文，旧11988字节证明不重复发布。
  2. 唯一新GA的摘要签名承诺：**dynamic-signature-commitments/GateAuthorization/<实际GA-ID>.json**。
  3. 唯一新GA实际停止后的完整五字段输入：**original-inputs-<实际GA去掉ga_前缀>/result.json**，字段为固定 `kind=ACTUAL_VERIFIER_ORIGINAL_INPUTS` 和四个原始字符串 `ga_raw`、`observation_raw`、`runtime_acceptance_raw`、`qualification_raw`。
  4. 对应该次GRR的摘要签名承诺：**dynamic-signature-commitments/GateResultReceipt/<实际GRR-ID>.json**。
- 完整原始输入会嵌入此前 **五次尝试的完整GA/GRR及控制事件原文**、相关Root/Status、配置与预算，以及本次必要新增观察；不是只上传引用或摘要。不包含其他历史快照，不能删减旧事件以通过限额。输入在实际PENDING时保存，只在该次真实STOPPED后上传同一份字节。
- 两类摘要签名承诺仅使用既有 `HISTORICAL_SIGNATURE_COMMITMENT` 的固定字段：kind、algorithm、repository、branch、object_type、object_id、store_uri、payload_sha256、schema_digest、audience、root_generation、issuer_purpose、issuer、executor_provenance、authority_effect；不扩成完整GRR或任意评审归档。实际对象ID与SHA在真实形成后记录，不预造。
- 保留原 **2MiB** 原始输入对象及 **4MiB** 传输限制，原DECISION/GRR控制请求和对应函数限定的 **128KiB**、**64KiB GA**、**32MiB批读取响应** 等限额不变；这里不把128KiB误称为所有行政迁移SQL的通用上限。发布前核实仓库仍为私有，最终载荷逐项核对路径、内容、大小及凭据扫描；禁止凭据、任意个人数据、Gold答案或无关业务载荷。
- 每项只追加一次并完整不可变回读，不覆盖旧证据；失败或结果未知时保留实际返回，不自动重发。
- 相同已批准范围内的常规接线修复与一次独立验收可继续，不按每份普通附件重新索取批准；新目的地、新数据种类、第二次GA、再扩额或新 Authority 则不被包含。

## 全系列边界与可独立后续项

当前仍是 A02 的1 FAIL、18未完成；A03–A07有工程基础但实际链未闭合，A08–A10正式测量0，A11未通过。R07–R10及A01原适用工程接受复用。固定21步、Stability/Health顺序、P0优先、不新增A12/A13、不提前R11/HS0 CONTRACT_READY/HS3保持。

**生产 record_list 修复另列，非本提案必需前置。** 它已有[精确生产方案](C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo/artifacts/clued-validation/phase2-entry-preparation-20260908/authorized-record-list-production/ProductionChangeProposal.md)，迁移SHA256 dcf72c18e574bf07ddcfb11a5d419df4bec47136b23331358f7e77f51d19e4f8；若用户另外明确批准，可执行该具体范围及只读回读/限定恢复。不把本次非生产批准当成生产许可。

每小时自动续接已恢复；它可继续本地准备，但不会自动续期旧 Root 或消费未批预算。本提案获准后可把明确新截止及本轮作用范围写入同一自动化，实质变化才通知。完成该唯一运行后仍可做已有授权内的其他工程工作，但不凭空获得后续用途或 Surgical 执行权限。

全系列核对详见[剩余任务与授权账](C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/Phase2RemainingSeriesAndAuthority20260909.md)。
