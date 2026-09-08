# 具体 Profile 与固定父接线候选

状态是工程候选，不是已接受 Profile、GA 或控制器资格。全部新文件在此目录，既有已审 runtime/Skill/probe 原字节不变。

ProfileApplicabilityCandidate.json 逐项给出业务 account、integration_installation、context、binding 不存在的具体调用面理由。固定child只读取R10三文本与固定合成文件，没有业务API、Token或实体发行；拟按既有 Schema 编码保留四组成对 not_applicable，并保留逐层 reason/accepted_schema_ref。真实Schema接受引用及现行gate_refs仍未交到本路，明确保留 unresolved/null，不伪装完整可执行wire。文件不是“ISOLATED_TEST便全N/A”的通用许可。

父控制身份真实存在：GitHub Owner、Root当前存储、issuer/Audience/签名、controller qualification、当前GA、runner/credential/session独立代际、预算/容量和Scope精确绑定全部保留。PQUAL13依然需要在下一动作前拒绝独立代际变化、撤回和被篡改的N/A/Scope；PQUAL08/09仍需真实凭据/数据边界观察。纯三文件读取不代表Skill行为通过。

parent.py 已实现三项可复用接线：

- `reject_constraints/admission` 在正式验签前拒绝错误阶段、主体自证、过期/超过Profile较窄90秒或原600秒上限/Owner窗口、缺独立代际、未成对或无逐层权限的N/A。它们不是完整Schema或签名验证器；任何caller accepted/qualified布尔无效。实际 Root/Profile/GA 验签、当前代际和可信预算 adapter 尚未连接，所以 admission 始终 BLOCKED，而不是把形状成功当准入。
- `fixed_argv/prestart` 直接复用已独评精确镜像与旧固定Docker资源/停止校验，生成唯一Windows CLI与本机npipe、独立空config、两固定挂载、无pull/网络/特权的计划；动作限create/inspect/start/stop/wait，拒exec/run/rm/prune。固定 `python -c` 字面量只调用准确已审child的library primitive，Skill字节永不作为Python或命令。计划尚未执行；真实父transport与watchdog必须在正式启用前接到这些准确参数。
- `intent_before_action` 把已有准确远端commit/blob回读放在两次准入核验之间；当前闭锁在第一次检查就返回，所以本次没有网络访问。不能把Git历史字节当current Root源。真实准入接通后仍要以每次新鲜current读取、绝对期限、精确ID停止/UNKNOWN持久账本配合，并非一张永久可复用准入票。

目录内没有 subprocess、SQL连接、秘密加载或执行函数。当前是父准入拒绝层+固定driver参数/inspect+远端回读接线候选，**完整生命周期executor、实际current verifier与可信预算/撤回/终态GRR尚未完成**。不以这份小增量声称整个controller已完成；实际输入交接后沿既有Store与签名模块补接，不新建控制根或Canon。

本次新增6/6纯逻辑检查PASS，0 FAIL/SKIP，0.011秒。未API/DB/Docker/部署/Skillrun，不重跑已成功的OS/正常STOP观察。无真实父崩溃或PQUAL结果。
