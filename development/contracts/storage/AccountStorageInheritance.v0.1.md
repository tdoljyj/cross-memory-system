# Clued 账号统一存储授权与默认继承方案 v0.1

## 0. 文档边界与实施门槛

- 类型：与实现、迁移和验收直接绑定的工程方案；不是上线证明或历史 Closeout 报告。
- 源码基线：`6c846b39a4a4aebc9bda24eabb933cea766a791d`。
- 延续 Task：`2aa57e7c-9960-45bc-a6f2-ba0c7d74ec9a`；不新建 Program。
- Owner 方向、实施顺序与两个管理入口：Decision `281c4eb6-39d7-4f73-91ea-3ae17f1f34de` v4。
- 本文件通过独立审查、阻断问题关闭、准确内容摘要及 Git 提交归档后，才允许功能实现；审查结论与版本由同一 Canonical Task/Receipt 保存，不由文件名或目录推定。
- 方案通过不等于代码通过；代码通过不等于生产启用；生产启用不等于整项 Storage hardening 完成。
- 本轮仅交付方案与审查。不得因写好本方案提前修改数据库、Google 权限、执行开关或真实资料。

## 1. 要解决的问题与目标体验

现实现将账号连接、Google OAuth、逐客户端 storage grant 分成三段。`storage_client_grants_v1` 按 connection/Binding 保存操作集合、授权版本与期限，现页面还将期限限制为一小时。单纯默认勾选或隐藏控件，仍会保留短期重授与逐客户端登记的问题。

目标：**连接时统一授权，任务内直接执行，超出范围才询问。**

1. 用户选择已有受治理目录并连接网盘。连接按钮附近简明告知：“Clued 可在所选目录内新建文件和必要分类目录，并记录任务结果；不覆盖或删除既有文件。”不增加逐动作、逐客户端确认页。
2. Google 自己要求的登录/同意仍由用户完成；这是第三方流程，不能承诺永远只出现一次。失效、撤销或提供方要求重新登录时才显示真实恢复需求。
3. 成功连接后，账号持有持续的存储使用策略。已获账号委托且通过服务端资格检查的客户端继承基础能力；设备不是权限主键。
4. 正常范围内的明确任务直接执行。权限证明、当前性验证、单次准入、回执都是服务端工作，不转化为用户日常勾选。
5. 普通页面只展示提供方、连接状态、使用范围与“断开网盘连接”。基础能力用自然语言说明，不展示 Binding、Decision UUID、技术有效期或“Agent 存储权限”勾选面板。
6. 高级故障核查放在折叠诊断/管理员入口；普通用户不填写 profile/Decision/job UUID 才能完成常规连接。系统只能解析已登记范围，不能把移除 UUID 输入变成允许任意磁盘路径。

## 2. 本次范围与不做事项

固定基础集合：`inspect`（任务状态与回执，不是读取任意文件正文）、`create_file`、`create_topic`。`create_topic` 沿用现有 topic/necessary asset_collection 规则，不允许状态目录或根级任意 track。

- 根、提供方账号、允许 tracks、已登记目录身份与 create-only 规则沿用当前可信 profile；不改变 Google `drive.file` 与 `drive.metadata.readonly`。
- 不开放覆盖、移动、改名、删除既有资料，不把另获批准的测试对象破坏性测试变成日常权限。
- 不重建身份/设备权限系统，不复制 DPAPI 或 Google 凭据到设备。
- 不修改冻结 v12 OAuth scope 语义。账号 storage 策略是独立资源授权；`context:write` 既不是它的来源，也不能替代它。
- 不改变 RDP/ACL，不声称能物理阻止拥有原始 OS 写权限的任意第三方工具。
- 不重做已验收的限定 Gate B；复用现有 admission、provider-root 围栏、job/attempt 和恢复合同。
- 未来其他 provider 复用策略/作业合同，但必须单独通过其身份、命名、条件写与恢复资格；本方案不宣称 Dropbox、本地等已实现。

## 3. 权限存放与唯一权威

权限权威为 authenticated Clued/Supabase Canonical 服务；下列对象仅在服务端私有域保存。浏览器和 Agent 获得必要的状态/回执，不获得凭据、内部 admission 或可自行改写的策略。

| 对象 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 账号/既有 v12 Binding 与 authorization | 当前用户、客户端身份、委托生命周期、撤销/降权版本 | 不凭 context scope 授予网盘操作 |
| 账号存储策略 | exact owner + connection + provider subject/root 的持续基础授权 | 不替代逐次用户任务、提供方资格与执行 admission |
| 服务端可信客户端能力登记 | 确切客户端是否具备合格存储入口 | 不授予它任何其他账号或目录 |
| 持久拒绝记录 | 保留已停用客户端/根/连接的禁止继承事实 | 不可因换连接 ID、重连或默认值而抹去 |
| Google 凭据与续签委托 | 私有加密凭据及同范围轮换 | 不生成、扩大或复活存储策略 |
| job/attempt/admission/Receipt | 原始任务身份、精确请求、单次执行和结果 | 不是可复用的账号长期权限 |

有效能力为这些条件的交集：当前账号策略、有效的同 owner Binding/authorization、当前可信客户端能力、无拒绝记录、当前 connection/profile/root/Decision、精确操作与当次准入。任何未知条件 fail closed。

## 4. 账号持续策略与客户端继承

### 4.1 策略数据合同

新增私有账号策略后继对象（候选名 `storage_account_policies_v2`）：

- 不可变 `policy_id`，owner、connection、provider subject、root identity、profile identity。
- 固定基础 actions 由服务端常量产生，拒绝调用方提供 managed_root/profile/actions/删除权作为权威。
- `scope_digest`：授权范围的确定性摘要，至少涵盖 provider/account/root、允许布局/track 边界与操作集合；不是 access token、credential_version 或普通连接行 version 的摘要。
- `policy_generation`、来源 Decision ID/version、授权目的/来源、不可变 consent/activation Receipt、状态与撤销时间；期限若存在必须来自明确授权，不使用内部 token 的一小时期限作为账号策略期限。
- 明确的 `auth_mode`/cutover 代次：legacy 和 account-policy 只允许一个执行权威。
- 账号策略不因普通 OAuth refresh、同范围凭据轮换、设备登录退出或读状态而改代次；这些仍可能使当次准备失效并要求重新读取，不要求用户重授存储权限。
- 真实授权范围/决定/撤销变化必须改代次；旧任务的代次不被重写以恢复执行。

策略状态固定为 `pending → active → revoked`；放弃的 pending 也只能进入 revoked。撤销不在原行清空时间或恢复 active；明确恢复必须创建新的 policy_id/generation 和 Receipt，并显式处理同一 owner/provider subject/root 的停止记录。`auth_mode` 固定为 `legacy | account_policy | revoked`：连接的 mode 与唯一 active policy 由数据库约束一致，禁止同时存在两个执行权威。仅首次连接激活事务、准确迁移事务或明确恢复/撤销事务能改变 mode；普通 refresh、重新登录、callback 重放和 list 均不能改变 mode。凭据失效或资格待验证是独立可用性状态，不销毁持续策略，但执行判定仍拒绝。

策略范围与运行时版本分开：每个 job/preflight 仍固定和验证当时的 profile、目录描述、策略与 currentness 版本。已授权 track 内正常新建 topic，仅由原任务结算增加 Artifact 登记并更新目录描述向量；不修改账号 policy_generation/scope_digest，不增加 profile.version，不覆盖或重建既有不可变 cloud_runtime 资格。后续新任务读取新目录向量并生成自己的 admission，旧准备因向量变化失效，已消费或结果未知的原任务绝不复活。新增 root/track 或真正 profile 变化必须走独立、受审的范围/资格后继，不属于本轮自动刷新；无法证明 scope 不变则拒绝。

### 4.2 合格客户端

继承不等于任何持账号 ID 或 context token 的应用都能访问网盘。私有可信能力登记绑定**由已验证 authorization request 解析出的服务端客户端注册身份**：不可复用 registration lineage ID、registration generation、issuer/resource、exact client ID，以及 approved redirect/metadata digest；包含 capability ID/version、支持的受控协议版本与撤销状态。client ID 复用或注册元数据变更不是原资格：代次/digest 不符立即拒绝，不按名称或 client ID 单独继承；原 lineage 的拒绝记录不会因换 Binding 或重注册而被抹掉。

- 资格只由平台部署管理边界的专用 `storage_client_capability_admin_v2` 合同登记/撤销：复用现有平台管理凭据保管边界，仅授予既有受控部署角色调用，普通 native/Agent/Google issuer/客户端无此权限。登记输入须引用服务端已验证的 OAuth/DCR 注册对象和受审资格结果，CAS exact registration generation + approved metadata digest；服务端核对后同事务输出 qualification Event/Receipt，记录管理员主体和审核依据。若注册源没有可靠的不可复用 identity/generation，则先只读解析并登记审核过的注册快照，未经核验的动态注册不得入列；不依靠客户端自报 manifest、client_name、名称前缀或 Agent 参数。
- 资格标准对兼容客户端一致，不做厂商名称白名单，也不要求普通用户为每个设备设置。
- 登记一个应用的技术资格不等于给它用户委托；每个请求仍需实际用户的有效 Binding/authorization 和账号策略。
- **唯一 storage authority 就是 Owner 的账号策略 consent/transition Receipt**：其一次连接说明明确涵盖“本账号已连接且合格的应用可按账号设置使用所选网盘”。它不是逐 Binding grant，v12 只证明同账号应用身份与委托生命周期；不得要求新 per-Binding storage Receipt，不改冻结 v12 scope，也不从 `context:write` 推导 storage 权限。已有连接从未披露/同意这一用途时，不能仅靠 context token 升级；未有账号策略 consent 的普通 context-only 客户端，以及技术资格未通过的客户端仍然拒绝。用户完成该账号层一次同意之后，其合格且有效的应用自然继承，不再次弹客户端存储授权页。
- 当前 Owner 已明确批准的精确客户端/连接可以在受审过渡中引用现有 Owner Decision，不再次申请同一授权。不得外推为迁移其他用户或所有未知客户端。
- 对可信 client 的撤销/降权有独立代次；old/reduced/unknown client、过期或撤销的 Binding 一律拒绝。纯 context 能力且没有上述账号策略授权来源的负向测试必须零 job/start/effect；不能把“纯 context”误解为已有账号策略也必须新增 OAuth scope。

## 5. 一次连接流程

### 5.1 新连接

1. native Owner 会话解析其可用的已登记范围，以目录名称供选择，内部使用准确 ID；没有合格范围则明确显示不可用，不默认为全盘。
2. 用户在清楚说明基础用途/范围的“连接 Google Drive”流程中发起操作。三项基础能力为该产品流程固定默认，不呈现技术复选框。
3. 服务器将 Owner 会话、exact connection/profile/root、policy contract/version、用途与披露版本、幂等键绑定到 OAuth attempt。客户端不能在 callback 临时增加 consent 或替换范围。
4. Google 授权码只按现有一次兑换/未知结果合同处理。账户主体必须与期望 provider subject 一致，scope 不扩大。
5. OAuth 完成的数据库事务中：核对 native 会话仍有效、attempt 原始意图、当前范围和撤销历史；保存凭据/连接事实并创建相应账号策略事实。各有独立 Receipt，但一同提交或回滚，不能在已完成 OAuth Receipt 后拼接未记录的权限效果。
6. callback 重放只返回原回执，不重复创建策略、续签委托或新代次；OAuth claim/complete 超时通过下述正常 attempt 状态接口核对，不能重兑同一授权码。
7. “已连接”与“可使用”仍有真实区分。执行器/目录资格未通过时显示“连接成功，正在完成可用性验证”或具体阻断，不让用户补内部权限勾选，也不假报可用。

正常 OAuth attempt 必须补独立只读 `attempt_status` 和有审计的终态处置，不复用只面向 recovery 的接口冒充：

- `prepared` 尚未 claim 时，可在原有效期内继续原 Google 流程；唯一 CAS claim 取得一次兑换权。`claimed/exchange_in_flight` 已取得兑换权，即使进程在发 HTTP 前退出，也不再交给另一进程重兑。
- `completed` 仅返回原连接/策略/续签结果的 Receipt IDs 与安全状态；不返回 code、state secret、PKCE、token 或 envelope。读回不创建策略。
- `failed_no_effect` 只用于可信服务端取得明确的兑换失败/未激活证明；timeout、丢回复和 claimed 后进程死亡一律 `exchange_unconfirmed`，不是“没发生”。保留原 attempt/claim/日志，不复用其授权码。
- 若兑换结果已拿到但 complete 回复未知，先读原 Receipt；只有服务端仍安全持有**同一份**兑换结果且期望 attempt/connection 版本未变时，才可幂等重交同一 complete 请求，绝不重兑 code 或取得另一 token 冒充原结果。若原加密结果不在既有持久安全域，不新增本机 token 缓存来“恢复”。
- 原 attempt 不能完成时，native Owner 在正常连接页使用“重新连接”发起**全新 Google 流程**；这是故障后的提供方操作，不重复 Clued 权限勾选。创建新 attempt 前，在 root/connection 锁下将旧 attempt 置为不可再 complete 的终态 `superseded_unconfirmed`（保留未知性质和历史），新 attempt 固定新的 activation generation；旧迟到 callback/complete 永远不能覆盖新结果。不得自动重启；存在原未知文件 job/fence 时仍不能借重连放开写入口。
- 状态接口要求当前 native Owner，服务端连接器调用另验固定 issuer；可跨已失效浏览器会话查询 Owner 自己的安全历史，但不向新会话下发旧 verifier/兑换权。终态处置/新 prepare 重新验证 native 会话、exact connection 和拒绝历史、CAS 及 Receipt。此状态合同是本轮需实现的新功能，不宣称现有 claim/complete 已具备。

### 5.2 已有连接的过渡

旧连接不会凭 migration 默认值自动取得新策略；UI 派生迁移状态显示为 `legacy_policy_pending`，不是 `auth_mode` 的第四个枚举，数据库执行模式仍为 `legacy`。这不是要求当前 Owner 再点旧面板。

- 当前已明确获准的迁移：新增专用 `storage_policy_transition_v2`，不是声称现有 API 已支持。外层复用 native Owner 当前会话 + 固定服务端连接器双鉴权，拒绝普通 Agent/仅 issuer/裸 service_role 调用；私有核心不授予 API 角色直接 EXECUTE。请求引用已受审登记的 exact-target transition manifest ID、幂等键、expected connection/profile/policy versions、expected auth_mode、legacy grant inventory digest、deny inventory digest、source Decision/version；owner 由会话确定，root/actions/capabilities 由服务端派生，不接受调用方任意补齐。manifest 由受控部署管理流程只登记当前已批准目标和授权依据，不包含凭据、不产生权限；调用时再次验证 Decision 的主体/范围/版本与当前 owner 一致。现有 Owner Decision 可作为同一权限的来源，不再索要旧 grant 授权。普通其他账号只能经自身正常连接 consent 进入同一内核，不使用该一次性 manifest。不以 ad-hoc SQL/backfill 代替有回执合同。
- 尚未有这种授权的其他账号：保持 legacy 模式；在下次正常连接管理流程清楚确认账号使用范围后转入新策略，不能借本 Owner 的决定代授。不得要求重新 Google 同意来掩盖纯 Clued 策略变更；只有 Google 凭据/范围确有需要时才重连。
- 过渡前读取源 grant/历史停用/授权版本/所有原 jobs，建立来源清单。旧 revoked/reduced 的明确选择映射持久 deny/限制事实，不因当前行缺失忽略。旧短期 grant 自然到期不是新策略的永久禁用，但不能作为新授权来源或复活旧任务；只有本轮明确账号 consent/transition Receipt 才建立持续策略。Binding/authorization 真正到期仍需有效新委托，不可借策略续命。
- 在 provider-root 锁内验证 quiet、准确 scope 和原模式，CAS 创建 policy + 迁移拒绝记录 + 切换 auth_mode，同一事务出 Receipt。任一失败整体回滚；回执未知按同幂等键读回。
- 禁止 `legacy grant OR account policy` 双执行入口。切换后旧 grant 仅用于历史审计/旧任务核对，不作为执行兜底。
- 原 queued/prepared 工作不可被新策略复活：queued 显式取消或按原合同拒绝；prepared 按现围栏规则处理；任何 started/uncertain 原效果未知则阻止 cutover，先走原恢复流程。不删除旧 job/attempt 或围栏来获得 quiet。

## 6. 断开网盘、撤销客户端与续签

| 用户操作/事件 | 影响 | 不影响/不承诺 |
| --- | --- | --- |
| 断开网盘连接 | 位于“存储连接”；立即最终 revoke 本账号这条连接；停止所有客户端的新提交/start、后台续签及新的 provider recovery 读取授权，策略停止并保留根级禁止默认恢复事实 | 不删除云盘文件，不停用整个 Google 账号，不影响直接使用 Google Drive 及其他独立连接；已开始的在途操作无法追回 |
| 撤销某个客户端访问 | 位于“已连接应用／客户端管理”；写入本账号 + stable client registration lineage 的持久 storage-only deny，停止该客户端使用本账号所有当前及未来网盘连接，所有设备一致；不枚举或撤销各网盘 | 其他客户端和网盘连接/续签继续正常；不删除该客户端无关的记忆授权，不调用 v12 全应用 revoke；重建 Binding/连接 ID 不绕过拒绝 |
| 停止自动续签 | 仅停止同范围后台轮换；现有凭据可在其真实有效期内依既有策略使用 | 不声称已撤销文件权限或关闭整个网盘；不得界面上混用“断开” |
| 普通同范围 refresh/再次登录 | 只修复凭据或会话有效性，按实际合同重新取当前上下文 | 不改变策略授权范围、不复活 stopped/revoked/denied 记录、不延长已消费 admission |

停用效果从服务端串行裁决的提交点起阻止新 start；已越过 start 点的外部请求属于 in-flight。不能承诺撤销能追回已发送的 provider HTTP。

普通页面“断开网盘连接”不偷偷保留新的提供方读取权，不采用先停止、稍后自动 revoke 的两阶段用户语义。断开前若存在原未决任务，明确提示“将停止后续访问，已经开始的操作仍可能完成；未确认结果会保留待核对记录”，仍允许用户立即断开。与此不同，部署/故障运维的“暂停新执行”只关闭执行入口，不撤销现有连接；其有效的原任务 GET-only 恢复可以继续，不作为普通用户新增按钮。

结算分为三个严格分离的路径：

1. **Canonical 历史查询**：native Owner 可读取原 job/Receipt，包括断开后；Agent 仍须有有效的同 owner 委托及原任务查询资格。查询不读凭据、不调用 provider、不清围栏、不创建 admission。
2. **提供方恢复读取**：沿用 `storage_connection_recovery_v1` 的 revoked-deny。成功且已提交的 `recovery_load` 是一次范围/期限固定的有限读取尝试授权点，必须绑定原 attempt 的精确对象和固定验证请求集合，不是可泛化 token。revoke 先提交时不得再 load 凭据、创建/延长/扩大读取尝试；先前已获准的有限读取属于 in-flight，即使 GET 尚未物理发出。执行器一旦得知撤销即停止尚未发送的请求，但不能声称无锁跨 HTTP 时绝对零迟到发送；迟到结果不自动恢复权限或成为可结算验证。不因允许结算而整体放宽该 helper。
3. **已有验证的纯 Canonical 结算**：只消费原 intent/provider attempt 在断开前已由受信执行器验证并 CAS 存入原 journal 的完整后置验证结果，必须含合同要求的内容、身份、父级、版本等证明；同 root 锁裁决下记录该结果，不能用客户端传入时间证明“撤销前”。结算核对原 request/attempt/版本、原验证记录和回执，零 provider I/O、零新 admission，不要求当前写策略 active，不重写旧授权快照。原 journal 可增加固定的 verified-result 字段，但不另建重派队列或 attempt。只有 POST 200/对象 ID、未持久化或不完整验证时不能使用该路径；保持 unknown 与原围栏，显示“已断开，原任务结果待核对”。

如果后续确需恢复 provider 核验，必须经过明确恢复该精确连接的授权与资格验证；重新登录或默认继承本身不够。恢复只核对原任务，不授权重发原写操作。不承诺断开后所有未知任务自动结算。

重新启用已停用网盘/客户端是明确权限变化，不能由默认继承、Google 重连、token 刷新、页面 list 或重新注册同根自动触发。历史审计保留，重新启用产生新代次但不复活旧任务。

## 7. 作业、单次执行与原子性

现有 `connection_id + stable job_id + exact mutation` 请求形状不新增客户端可控 policy/permission 字段。完整请求摘要继续由服务器计算。

新策略下的 job 必须原子固定：

- account policy ID/generation/Receipt + scope_digest；
- trusted client capability ID/version；
- 原 Binding ID + authorization version + 同一账号策略 consent/transition Receipt（不是新 per-Binding grant）；
- exact owner/connection/provider subject/root、当次 profile/currentness 版本；
- 原 mutation/request digest/intent ID，原始提交 Receipt 与 attempt 链。

`submit`、cloud execution descriptor/prepare、`begin/start` 的实际副作用前必须用同一服务器判定器复核这些身份与代次、所有撤销/拒绝/过期及运行资格。`submit` 完成只是排队，不返回通用 permission；execution wrapper 内部消费 exact/短期/单次 admission。

并发与锁合同（不是留到实现时再选择）：

- unlocked lookup 只允许解析将要锁的 key，不作为授权；实际 evaluator 仅按下列顺序取行锁，不在取得下游行锁后反向取得 advisory lock。固定服务端 app/issuer SHARE（适用时）与 native session/account 身份 precheck 可在开头发生，之后不得反向升级它们。
- 客户端 guard key 为域分离、固定编码的 `storage-client:{owner}:{registration_lineage}`，从 token → 当前 Binding → authorization request → 服务端不可复用注册身份派生，禁止 caller 指定。它是事务级 SHARED/EXCLUSIVE advisory lock，不是授权或缓存许可。哈希碰撞只可保守串行，锁后仍按真实身份完全重检。
- owner/job 锁沿用 `storage-job:{owner}:{job}`；provider-root 锁沿用现 `{owner}:{root_folder_id}`，不得换命名导致旧围栏失联。一个事务涉及多个同类 key/行时均按固定编码/UUID 升序取锁。

| 路径 | 锁顺序（S=SHARE，X=UPDATE/排他；到事务结束释放） | 禁止事项/裁决 |
| --- | --- | --- |
| submit、cloud load/authority/begin/start | lineage guard S → owner/job advisory → provider-root advisory → Binding S → v12 authorization S → account S → connection/auth_mode S → account policy S → trusted capability S → global/root deny 读验 → profile/runtime与Decision按ID排序 S → job/journal X → exact prepare/start | 所有新执行路径一致；先拿锁并提交 start 者为在途，否则锁后重检拒绝；不把 submit 当执行凭证 |
| 断开网盘／root策略撤销 | native身份检查 → root advisory → 会话/时钟重检 → connection/auth_mode X → policy X → 根停止记录 → refresh delegation按ID排序 X → Event/Receipt | 不等待 job advisory，不枚举/锁每个 job；一次事务终止连接、策略、续签，不删除 journal/凭据/围栏 |
| 撤销某个客户端的存储访问 | native身份检查 → exact lineage guard X → `(owner,lineage)` deny X/UPSERT → Event/Receipt → 会话/时钟重检 | 不取 root/job/Binding/capability；不调用v12 revoke；与所有该客户端根上的执行共享guard裁决 |
| legacy→account-policy切换 | source manifest全部lineage guards按key排序 S → root advisory → quiet复核 → 源Binding按ID排序 S → 源authorization按Binding排序 S → account S → connection/auth_mode X → legacy grant按Binding排序 X冻结 → policy insert → capability按ID排序 S → global deny读验／root deny按key排序UPSERT → profile/Decision按ID排序 S → Receipt | root内绝不反取lineage/job advisory或逐job X。先各自按job→root终结queued；仍有prepared/started/uncertain则拒绝切换。Receipt记录源grant/deny摘要、终结job摘要、旧mode、新policy/gen |
| 平台capability／注册资格撤销 | 受控平台管理鉴权 → exact capability X → 新代次/revoked事实与Event/Receipt | 不取任何账号root/Binding/connection，不枚举账号；执行路径持其S直到start提交 |
| legacy grant写RPC兼容期 | native身份检查 → root advisory → Binding S → authorization S → connection X → 验证auth_mode=legacy → grant X → profile/Decision按ID排序 S → Receipt | 必须先升级旧DB RPC wrapper；切换后旧UI/旧二进制的grant/regrant/revoke不能写回执行权威或清deny |
| 既有v12 revoke/reduce | Binding X → authorization X/version bump → 既有context资源 | 不新增storage root/policy/capability锁；执行持Binding/auth S到start，保持原串行裁决，不改v12 scope |
| 原任务recovery_load/完整验证入journal/纯Canonical结算 | 固定server issuer与必要Owner检查 → owner/job advisory → root advisory → account/connection/profile/Decision按上述顺序 → job/journal X | 无新admission，不能误入新写路径；读取授权及verified-result持久化均与最终revoke争同root锁；最终revoke后只许合格纯Canonical结算或历史查询 |

全局 storage-only deny 主键至少为 `(owner, immutable registration_lineage)`，有独立 generation/Receipt，保留终止历史；新 Binding、connection、root 或同 lineage metadata 更新都命中。其行不存在也必须持 lineage guard 读验，不能靠锁不存在的行防 phantom。root-specific deny 的插入/撤销必须持同 root advisory；root 内禁止反取 lineage guard。真正新 lineage 不迁用原资格，须重新经过受审客户端资格登记，仍由同一账号策略决定资源授权。

root quiet 复核读取精确非终态 job/intent 集合，不在 root 内取 job 锁；任何可能创建非终态 job 的旧/新路径都先取得同 root 锁。切换期间新 submit 若已拿 job 锁等待 root，切换提交后必须按新 auth_mode 重新判定，不能接着旧模式授权。此规则与兼容期 RPC 闸门先部署，再允许真实 cutover。

Binding/authorization 的既有行锁和版本仍为必检；每次锁等待后及产生结果前再次检查 `clock_timestamp()`、当前会话/代次/撤销/deny，不使用事务开始时旧时钟掩盖到期。DB 锁不能跨 provider HTTP；原子 start 一经提交即按 in-flight 处理，即便应用尚未发送 HTTP。

credential refresh 不使账号授权每小时过期，但 stale prepare/descriptor 按现行 guard 拒绝并读取新上下文；未知 start 不能以此理由重派。inspect 不调度、不清围栏，超时不得换 job_id 或改内容重试。所有写与对应 Event/Receipt 同事务，以准确回执读回为准。

## 8. 接口与隔离

- 继续现有 submit/inspect 受控工具，升级服务端判定器，不增加公开 `grant`、raw provider effect、admission 或 credential 工具。
- 增加 Binding 鉴权的只读 Canonical 范围发现工具（合同名 `storage_scope_discover_v2`）：按同 owner 身份、存储委托、可信客户端能力、账号策略与拒绝记录过滤，只返回可发现的连接显示名、内部执行定位所需 connection ID、已登记根/track/topic 的 ID 与登记路径、允许基础动作及可用性/阻断码。不返回凭据、内部 admission、其他账号对象或完整权限历史；不枚举任意 Drive 文件，不读取正文，也不接受 caller root/owner/profile 扩大查询。后台资格暂停时可显示获准范围的不可用原因，不以发现结果作为可执行凭证。
- 全新 Agent 会话先发现当前账号范围，再把用户自然语言目标解析为确切登记目录。唯一匹配时直接使用；多连接/同名目录有实质歧义时，仅向用户询问人类可读范围，不要求 UUID/本机路径、不猜测目的地。发现的旧结果在 submit/start 时重新验证；发现调用不建 job、不产生权限或 provider effect。
- native 连接列表返回安全概要：scope 显示名、连接状态、策略状态、可用性/阻断原因；不返回 token_hash、issuer secret、refresh/access token、内部 capability。
- native Owner 另有首次连接所需的只读合格范围列表：从现有 Canonical profile、当前授权 Decision 与可信目录登记交集生成，只显示该 Owner 可连接范围的名称/安全ID/可用性；不要求先有 connection，也不暴露其他账号。登记/连接 POST 只能引用列表中的稳定ID并实时重验，服务端解析决定来源，不接受手填任意path/Decision来扩权。
- 新策略的 native owner 建立/停止、受控过渡与平台 client 资格运维分别使用现有对应授权边界，不能用一个普通 Agent 接口通吃。每个 mutation 使用幂等键、CAS、真实身份与期限复核、Event/Receipt。
- 数据表位于私有域，最小 SQL EXECUTE/SELECT 授权，固定 search_path；review RLS 和 SECURITY DEFINER 的完整调用链。新增表/函数不得继承 PUBLIC 执行或 Data API 可见性。
- 新连接 prepare 请求绑定 consent/policy 版本；callback 不接受新的授权选项。未知字段、caller owner/root/actions、伪造资格、旧 schema 请求错配必须 fail closed。
- 缓存只可保存可重建状态；权限判定不用设备缓存当真值。遵循已有缓存治理规范，不新增本地凭据副本、权威名单或新的后台设备续签服务。

## 9. UI 详细交付

普通“存储连接”卡片：提供方名称、所选根/范围、状态、连接/需要时重新登录、**断开网盘连接**；仅在问题出现时显示可操作的恢复说明。

必须移除正常流程中的：手填 profile/Decision ID、三项 storage checkboxes、逐 Binding 授予、一小时过期输入、重复“确认授予所选存储权限”。必要的受治理目录登记由现有可信登记流程/管理员完成，用户从返回的合格目录中选取。

两个主要管理入口名称固定：**“断开网盘连接”放“存储连接”**；**“撤销某个客户端访问”放“已连接应用／客户端管理”**，其存储区说明“仅停止此应用通过 Clued 使用网盘，其他应用和网盘连接不变”。后者不是设备列表，也不连带撤销记忆权限；若已有全应用断开功能，须另外标明其更大影响，不借用该按钮。后台续签状态/仅停止续签放高级设置，不与这两个入口混用“停用连接”，不恢复逐客户端 grant 面板。

成功文案来自服务器最终状态；不得因为 OAuth 成功就显示“文件执行已可用”。切换期间旧缓存页面提交 old grant 请求被拒绝并指示刷新，不自动转成新授权。未知结果展示“正在核对原请求”，隐藏重复提交控件；重新加载先读回，不伪造成功。

## 10. 验收矩阵（全部必须有可复现证据）

| ID | 验收项 | 必须证明 |
| --- | --- | --- |
| A01 | 一次连接 | 一个 native 连接流程完成固定三项策略；无逐客户端/动作/技术 ID 输入；provider 最终同意仍由用户 |
| A02 | 多客户端/多设备 | 两个合格客户端在同账号同策略下正常使用；无 per-device grant 或凭据分发；对普通用户零新增勾选 |
| A03 | 不受一小时控制 | 模拟 token 轮换/时间推进，持续策略仍有效；真实 Binding 过期仍拒绝，新有效委托不靠旧 token 续命 |
| A04 | 不合格来源 | 错 owner、未知 client、伪造 issuer/resource、client ID复用/注册代次或metadata digest变化、caller manifest、纯 context 无账号策略授权均零 job/start/effect；已有账号策略的合格应用不需要新 per-Binding grant/scope |
| A05 | 生命周期 | account policy/Binding/authorization/capability/deny 各种撤销、降权、过期、版本变化均拒绝新执行；拒绝原因不泄密；单客户端storage-only deny覆盖其同账号多根及新Binding/connection但不改记忆权限/其他客户端/网盘续签；两个入口名称和位置准确 |
| A06 | 竞态 | revoke/cutover/expiry 与 submit/start 双胜序、deny缺行插入、同lineage多根/多个lineage切换稳定排序；锁等待后过期；同根并发/不同根无误扩散；无死锁或第二授权路径；断开后零新读取授权，recovery_load成功后暂停再revoke的在途读取不产生新授权/可结算验证；只有撤销前已持久化完整验证可迟到结算，POST-only/不完整验证保持 unknown 与原围栏 |
| A07 | 单次与未知 | 同 job 同 payload 幂等；不同 payload 冲突；丢提交/开始/回执回复只核对原 job；不重复 provider effect |
| A08 | 旧连接迁移 | exact-target CAS、重复请求回执一致、未知读回；不迁移其他用户；旧 deny/失效委托/重建 ID 不复活；legacy/v2 无 OR |
| A09 | 旧工作 | queued 明确处置；prepared/start/uncertain 围栏不清空；未决阻止 cutover；新策略不改旧 job 权限代次 |
| A10 | OAuth 回调与续签 | scope/account/state/attempt/session/版本错配拒绝；回调重放无新授权；claim/兑换/complete丢回复均有安全状态读回；原码不重兑、旧未知attempt终态保留、新attempt显式重启且旧迟到结果无法覆盖；同范围refresh不改授权代次；已停用不恢复 |
| A11 | 原门禁回归 | 2026-09-25状态目录、sibling island、root drop、duplicate-bytes删除、正常track→topic；拒绝零副作用、正常扫描零模型 |
| A12 | create-only | 覆盖/移动/改名/删除有效请求仍拒绝，不能因默认继承开放；正向测试只用明确测试对象 |
| A13 | UI安全与可用性 | 账号切换/迟到回复/断网/双击/旧页面/JS异常无静默授权；低权限客户端看不到其他账号/策略/凭据；全新 Agent 会话不需用户输入 UUID/内部路径，发现获准目录后完成任务，歧义只问可读名称 |
| A14 | 真实受控验收 | exact合格根中单一标记文件，content/identity/parent/Receipt一致；无双活；运维暂停新执行后原核对可完成；最终断开后仅历史查询或满足第6节的纯 Canonical 结算，不冒充仍有 provider 恢复权限 |
| A15 | 回退 | 阻止新提交/start，保留jobs/审计/拒绝/围栏；旧代码无法从legacy路径重新获得写权限；不复活Desktop |
| A16 | 新建分类目录 | 合格 track 内新建 topic 并在其中新建文件；Artifact/目录向量按实际结果更新，policy generation/scope digest/profile/runtime 均不变；第二任务取得新 admission，旧 admission 不可复用；root/track/profile 变化不走该自动路径 |

本地与隔离 DB、Worker、UI 测试分别记录，不以 mock PASS 替代真实 provider 验收；CI 条件跳过不计 PASS。生产单对象回收只走已授权且合格的精确回收路径，不能为清理临时借用通用 Drive/OS 工具绕过门禁；若回收能力未合格，保留标记对象并如实记录，不能宣称清理完成。

## 11. 实施分解与影响面

1. 本方案独立审查、修订、准确内容/提交绑定；Canonical Task 记录审查和实施准入。
2. 私有 schema/evaluator：策略、可信能力、拒绝记录、精确过渡、单权威模式；新增迁移，禁止回改历史 SQL。
3. job/cloud bridge：统一新执行判定器和不可变授权快照，submit/prepare/begin/start 全部消费；原任务历史查询、恢复读取和纯 Canonical 结算分别遵循第6节，不错误要求已停止的写策略 active；不另造 attempt/fence。补只读 Canonical 范围发现。
4. Google/native 管理：prepare intent、complete 原子策略、状态/断开/过渡；保留现凭据 vault 与 refresh 隔离。
5. UI：人类可读目录选择/状态、隐藏内部授权步骤、客户端管理语义；transport 描述与相关文档同步。
6. 回归、独立代码审查、适用 CI；出现失败按原因修复，不跳过安全检查。
7. 准确发布、现有 Owner 唯一连接过渡、受控真实验收、可用入口核验和归档。

影响源包含现 account connection/grant readback/binding expiry、OAuth/default refresh、account jobs/cloud bridge/native recovery migrations；`worker/storage-agent-tools.ts`、Google OAuth/refresh/恢复和 cloud executor；storage connections 及客户端管理 UI；相应 DB/Worker/UI/transport fixtures。执行前用实际调用图补齐所有授权读点，不能只改 public submit。

## 12. 发布与回退

生产仍以已审核精确 diff、CI、同一 Task 中当前有效授权为准。任何本方案没有覆盖的敏感备份导出、额外主体授权、Google scope、ACL 或新不可逆操作另行精确审批；不把历史一次性备份同意复用成无限导出授权。

1. 先部署兼容且默认不开新策略的 additive migration/代码，验证发布基线与 API/函数权限。不得数据 backfill 时开写。
2. 为精确测试/当前已批准范围登记可信 client 能力；记录来源、版本和回执，不把资格扩为别的账号权限。
3. 在写入口关闭、原根 quiet 的条件下做授权过渡事务，按准确 Receipt 读回。执行模式切换持久化在 DB，不能只靠 Worker flag。
4. 读回 policy/scope/资格/拒绝/根/currentness/旧入口状态后，才开启受审必要执行入口，做 A14 与停止验证。未知结果冻结新执行，查询原任务。
5. 回退先关闭准确执行器，再关闭新提交，保留有权的原任务只读核对（不是自动恢复已 revoked 连接）；不得删迁移、日志、deny、credential envelope 或围栏。已切 account-policy 的连接不得恢复 legacy v1执行；若旧二进制不能遵守新模式，不能回滚到该二进制，改用已审核的关闭态兼容版本或修复前进。
6. 断开连接不等于删除 Google 客户端/项目或全账号 OAuth 撤销。旧 Desktop 不得恢复，不建立双活。

发布顺序、DB互锁、旧二进制拒绝能力必须在 A15 实证后才能生产切换；仅修改环境开关不足以通过。

## 13. 归档、完成定义与停办条件

- 工程方案/协议/迁移/测试/可复现证据放 Git；本文件不复制 Canonical Task/Decision 正文。
- Owner 决定、当前 Task/执行状态、Evidence/Receipt 放 Canonical Store；审查结果必须绑定方案/代码的准确摘要及版本。
- 面向人的历史验收/Closeout 长报告按既有治理入口放资料中心 Google Drive；入口未合格时不得绕过，也不得把 Git 方案冒充该长报告已归档。
- 实现完成需：计划无未决阻断项；代码及全部适用CI通过；准确迁移/发布读回；一次连接与继承的真实可用证据；单对象及停止/恢复/无双活验收；原Task更新、归档定位可查。
- 方案归档只表示可以开始实施，不暂停“做到可用”的自动续办。全部本轮实际验收与归档完成后才暂停；整体Storage其它剩余范围仍如实保留。

## 14. 审查清单

独立审查至少覆盖：账号授权的唯一来源、可信客户端资格与旧降权、scope vs token版本、三种停止语义、旧连接无需重复同意但不代授其他用户、job不可复活、锁次序/原子start、OAuth原子结果、发布/回退旧路径、权限误配爆炸半径、所有A01–A16的可测性。

P1/P2/阻断或重要未决项未关闭，不准开始功能代码/DDL。审查者不得用“将来实现时注意”替代方案中关键权限或迁移决策。新发现实质权限变化时回到方案修订及准确用户授权，不凭既有“赶快完成”扩大范围。

## 15. 依据与核对定位

- `apps/clued-cloud/app/storage/connections/page.tsx`、`apps/clued-cloud/worker/storage-agent-tools.ts`：当前连接/逐客户端页面、submit/inspect 入参和工具边界。
- `apps/clued-cloud/supabase/migrations/20260927232454_resource_center_binding_expiry_compat_v1.sql`：当前 Binding/authorization/storage grant 检查及原生授予/撤销锁。
- `apps/clued-cloud/supabase/migrations/20260927145426_resource_center_default_refresh_consent_v1.sql`：prepare 意图、complete 原子结果及既有拒绝历史。
- `apps/clued-cloud/supabase/migrations/20260927093948_resource_center_account_jobs_v1.sql`、`20260927103110_resource_center_provider_attempt_v1.sql`、`20260927104436_resource_center_cloud_bridge_v1.sql`：原 job/admission/attempt、锁次序、不可变 runtime 与 cloud bridge。
- `apps/clued-cloud/supabase/migrations/20260927201506_resource_center_native_recovery_v1.sql`：断开后历史可查，但 revoked 连接不得恢复读取或结算的现有边界；本方案新增的纯 Canonical 结算必须与其分离，不能假称现功能已支持。
- `apps/clued-cloud/supabase/migrations/20260907173031_clued_connection_authorization_v12.sql`：现有客户端身份、native/self/issuer 撤销及授权版本。
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)：API 可见性、SQL privileges 与行级策略须同时约束；私有表不能用客户端策略当唯一边界。
- [PostgreSQL 显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)：一致加锁次序、行锁冲突和事务级锁生命周期；外部 I/O 不占数据库长事务。
