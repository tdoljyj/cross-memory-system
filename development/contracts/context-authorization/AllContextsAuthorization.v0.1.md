# 上下文授权统一合同 v0.1-r4

状态：r2 已通过产品与安全独立审核；r3 仅补原 Task 引用；r4 按 Owner Decision v6 将原内容范围名称统一为“个人记录”，并按确认顺序展示个人资料、个人记录、各项目；不改变授权集合、操作或限制。原 r2 字节及审核绑定保存在 evidence/AcceptedPlanR2.v1.json；名称差异须独立核对，尚未发布本轮授权修复。

Owner 来源：Clued Decision `1b609e13-9b44-47fb-90a1-89a74bf9875e` v6；执行复用 Task `d5dee826-27d7-452b-8948-48fe8ae8a961`。工程基线 main `f890a19da620bcd60efa20d44a0a78f9099c95bf`，受查部署 `8f960b5541e29ad279d4976f5c366ea4e1297ad4`。本合同是 `PermissionSimplification.v0.1` 的限定后继，不改其历史同意，不改数据身份、命名完整性固定来源或 Canonical 资格。

## 1. 统一概念与界面

“个人记录”是内容范围的统一概念名，适用于用户／开发目录、授权、接口说明与工程术语；原“通用内容／全局视图”作为历史别名。它容纳未纳入具体项目的待办、想法、心得、灵感和计划，也可包含工作、学习与创作。个人资料独立管理身份／偏好等事实；项目内容归对应项目。八视图的“日常”是生活事务分类，与范围分开。授权资源 `scope/global/canonical` 和查询／保存的 `scope=global` 保留兼容标识，指向个人记录，不包含项目正文，也不增加权限。原工作投影接口的 `level=global` 则表达跨项目登记与优先级；其工作层级、标准工作投影和协议保持独立，不得误称为个人记录内容范围。

目录统一叫“上下文”。“用户/开发”是用途，项目和环境是所属范围；它们不形成不同的上下文概念。底层 `global` / `profile` / `project:<UUID>` / 精确 Context UUID 和 `development_history` 模式保留。

“即时权威上下文”只标识本次已授权读取且由服务证明当前权威的内容。Record 的显示条件是 `authoritative=true` 且 `record_currentness=CURRENT`；其他类型必须按其类型化 Authority／Currentness 合同判断，缺能力保持 UNKNOWN，不能套用 Record 字段代替。active Event truth carrier 保留独立来源、阻挡及对账语义，checkpoint 吸收不使它退役；历史 Log 与 active Event 不合并。这一标识只说明已验证内容的资格，不声明当前权威来源已全量收齐。缺资格、未知、失效、候选或历史内容不能因目录名称、授权扩大或标签而进入它。使用前仍核当前性和执行许可；这个名称不宣称跨 Host 实时推送已经完成。不新增第九个默认分类视图。

简单授权只分两项：

- 范围：全部上下文（含以后新建的）／指定范围。
- 操作权限：只读／可编辑／全部操作。

“全局视图”在授权页改为“个人记录”；个人资料是独立可限制的内容范围。“正式记忆”不作为每行重复后缀。简单指定范围直接展示下列选择树，不要求进入高级才能选择基本范围：

- 个人资料、个人记录各有独立复选框。
- 项目按可读名称分组。组内“项目正式记录”与每个具名上下文分别勾选；上下文同时显示测试／预览／生产环境。技术 UUID 只放详情，但提交身份仍是精确 UUID／环境／资格。
- 分组标题不授予权限；若提供“选择本组现有全部条目”，须显示明确条目数量和环境，不包含未来资源，也不暗含个人记录或个人资料。未选条目绝不隐式授予。
- 高级只用于逐资源动作、现行支持的限制或明确例外；非预设动作组合、资源例外显示“自定义”。

OAuth 与 Headless 共用范围／动作计算模块和同一选择规则：首次读取且提供 `contexts:*` 时显示“全部上下文＋全部操作（本次可用）”，只预选、不提交；没有策略能力则进入空的指定范围，至少选择一项才能继续。全部切为指定时清空所选精确资源并提示重新勾选，保留操作预设；指定切为全部时只选策略宏，预览重新列出实际覆盖与未来规则，取消精确例外须在提交前清楚显示。更换操作预设只改变已选资源的动作，不能加入未选资源；高级改动使操作显示自定义，重新套用预设会明确替换已选资源的自定义动作，例外仍须显示。账号切换、资源快照或版本变化使旧选择／预览失效，沿现行竞态防护重新读取。

三个可直接执行的例子：

| 简单选择 | 提交预览及精确结果 |
|---|---|
| 指定范围 → 只勾个人资料 → 只读 | `scope/profile/canonical/read`；个人记录、项目、上下文均无授权 |
| 指定范围 → Clued 项目只勾“项目正式记录” → 可编辑 | `scope/project:<Clued UUID>/canonical/{read,write}`；该项目用途上下文及以后新建资源均无授权 |
| 指定范围 → Clued 项目只勾“验收上下文 · 测试环境” → 可编辑 | `context/<精确 Context UUID>/test/{read,write}`；项目正式记录、预览和生产环境均无授权，未来新建同名测试上下文也无授权 |

上述动作仍受实际客户端 scope 约束。没有请求 read/write 时不得选择可编辑；缺写入请求时简单模式只提供只读，高级只显示真实可申请的剩余动作。空选择禁止预览／批准。

## 2. 全部上下文的集合

对实际授权主体 U，全部上下文包含：

1. U 的个人资料（现有 `profile`）。
2. U 的个人记录（现有 `global`）。
3. U 本人拥有的每个项目的正式记录范围。
4. U 本人拥有、且所属项目也由 U 本人拥有的每个项目用途上下文，按其实际环境授权。

集合同时覆盖授权时已有资源和授权存续期间未来新建的自有项目／上下文。别人共享或邀请 U 参与的项目及上下文不自动加入；高级界面中仍可按现行资格单独明确选择它们。项目所有权、Context 所有权或环境变化必须重新判断，不使用名称、旧副本或旧 membership 代替。

“全部上下文”是权限范围；八视图“全部”是内容浏览方式。授权不保证外部聊天已入库，也不把各接口的不同内容集合、开发候选和当前权威内容合并为同一语义。

## 3. 操作含义

| 内容范围 | 只读 | 可编辑 | 全部操作的最大可选动作 |
|---|---|---|---|
| 个人资料、个人记录、自有项目正式记录 | read | read, write | read, write, close, restore, audit |
| 项目用途上下文 | read | read, write | read, write, close, feedback_submit |

每一项只取本次客户端实际请求且该资源现行 API 支持的动作；不自动追加未申请的 OAuth scope。未请求或不支持的动作不会被虚构为已授予。页上显示实际动作和缺项：缺少写入请求时只提供只读预设；不可表示为可编辑或全部操作已具备所有动作。

现有 reader / developer / full 标识可保持内部兼容，新的“可编辑”预设只打包 read/write。旧开发者角色含 close/restore 的授权保持原内容；不按新名称悄悄缩减或扩大。全部操作仍是资源支持动作的打包选择，不包含成员管理、生产发布、Secret、采购、预算、运行模型或大规模导出许可；账号网盘访问保持现行独立规则。

## 4. 显式覆盖策略与继承

新增可授予的普通授权条目：`resource_kind=scope, resource_id=contexts:*, environment=canonical`。它表达“U 的全部上述自有上下文，已有和未来”，动作按第 3 节限制。该条目本身不能放行业务调用。

服务按该策略物化精确条目：global/profile/project:UUID 的 canonical 条目，以及 Context UUID／实际环境条目和对应内部上下文 grant。业务仍逐次走现行精确条目、Owner、Binding、scope、环境、资格、到期、撤销和当前性检查。新增策略的账号上下文粗筛可以为 `*`，但不能替代这些检查。

物化时机：新策略真实批准或有效变更的同一事务、未来自有项目创建、未来自有上下文创建。只读读取不得创建或修复 grant。继承动作不得超过策略动作、资源允许动作、实际客户端 scope 或有效授权期限；内部 grant 的 history/version/field 限制不能被一般继承扩大。新策略首次明确批准可为其列出的自有资源建立 EXISTING_AND_FUTURE/LATEST/* 的 grant；既有明确限制需在确认页显示后由 Owner 明确覆盖，不能靠后台修复抹掉。

### 4.1 来源、精确拒绝与限制合成

新来源层与 v12 有效投影分开：新策略身份绑定 Binding／Owner／同意 Receipt／policy ID／版本／同意时的客户端 scope 上限；每项贡献绑定来源 ID／版本、精确 resource kind／ID／environment／qualification ID。派生权限不作为独立同意，v12 entries 与内部 grant 仍供现行精确业务检查。

首次为一个 Binding 启用来源层时，将当时的真实条目与内部 grant 限制保全为 `legacy_effective_baseline`。这是迁移时的合法有效权限边界，不猜测旧 union 行分别来自独立选择还是旧 project:*。新宏策略、升级后新 direct 同意、旧 project:* 今后的贡献各有可单独收窄／删除的来源。基线只在首次切换或 Owner 明确调整该来源时变更，绝不从新合成的投影倒灌；所有后续授权 writer 与旧 project:* 扩大器均接来源层的投影刷新，不再旁路 union 新策略。

精确拒绝／允许上限独立持久保存，键包含 Binding／精确资源／实际环境／原 qualification ID，并有版本、Receipt 与原因。拒绝优先于所有来源，非空精确 allow ceiling 进一步收窄。资格变化不能换一个新 membership ID 抵消旧拒绝；新 Context UUID 是新资源，同名不代替旧 UUID。

有效动作＝仍有效且资格匹配的来源贡献并集 ∩ 资源 API 动作 ∩ 同意客户端 scope 上限／当前 Binding scope ∩ 精确允许上限 − 精确 deny。每个来源先按自己的期限／撤销状态与 scope 上限过滤，再合成：较短来源到期不误伤其他仍有效的独立来源。Binding／Authorization／精确资源旧 grant ceiling 是共同硬上限；各贡献的有效期限分别取自己的来源期限与这些硬上限的最早值。业务调用每次都验证活来源，不因尚未清理的合成投影行仍存在而放行到期贡献，也不以读取写回刷新。运行时仍独立核较小 OAuth access-token scope。history/version/fields/固定 cursor/explicit record IDs 保持旧精确限制，不用并集放宽。既有内部 grant 已撤销或到期时建立／保留精确阻挡，普通继承、后台刷新、读取或重放不能清除。

新宏首次明确同意仅为没有旧阻挡／限制的新资源建立 EXISTING_AND_FUTURE／LATEST／*；有旧限制则按原限制和动作 ceiling 继续，预览清楚列差异。放宽／清除精确限制或撤销必须另走新的 Native 精确确认：view_digest 包含旧→新资源、动作、期限与每项限制，检查 Authorization／override／grant 的 ID 和 CAS 版本，成功同事务写 Receipt／审计。不能直接借旧 grant_upsert 的 revoked_at=null 行实现宏复活或声称旧 helper 已覆盖限制。

输入协议：

- approve：只把真实提交选择建 direct 来源；宏一条来源，展开预览不变 direct。精确资格来自服务 request 快照，不能信客户端伪造 qualification。
- connection.permission extend：只新增／修改明确命名的来源，旧基线不变；新宏语法是新增来源，旧项目语法不重解释。
- 升级 Binding 的 reduce 使用 `selection_format=sources_v1`：提交具名来源 ID／base_version／动作 cap，以及明确精确资源例外 ID／base_version／允许上限或 deny；有授权总版本 CAS。来源 action cap 只收窄该来源现有贡献，空动作表示移除该来源。derived rows 只携带来源说明，不提交为 direct；未显示的派生行遗漏不表示删除基线。原 flat selected reduce 仅对未升级 Binding 保持旧语义，升级后明确拒绝模糊 flat 提交，要求重读。
- 整体操作预设的收窄必须明确覆盖页上所有具名来源，预览旧→新实际能力；只改新策略不可悄悄删旧合法来源。精确例外优先于每个来源且持久；取消／放宽例外不属于 reduce。
- Headless 轮换绑定旧 Binding 版本、每个来源／例外／限制版本，保留原语义；新默认不能替代旧选择。确认页对实际差异作一次明确确认；精确拒绝和限制随对应资源迁移，不能以新 Binding 身份清零。token 仍只显示一次。

例子：legacy read＋新宏 write，删除新宏后保留 legacy read；旧 project:*＋新宏，收窄新宏不改变旧项目来源，也不使旧来源拥有 Context；精确 Context deny 后创建其他 Context、重放、刷新和轮换，旧 Context 仍拒绝。已有限定 fields/history/version 的资源不因宏变成全量可写。

服务展示返回可读项目／上下文名称和实际环境、来源身份与版本、effective actions、限制和例外、覆盖状态与差异。选择列表可增加 `project_id/project_name/context_name`。展示／预览是 diagnostic observation，不能充当执行 admission。提交来源／例外仍遵守现行体积和 100 项上限，后台派生资源数量不按 100 截断；必须验证大于 100 个真实资源仍完整覆盖。

### 4.2 完整事务屏障与锁协议

采用物化及独立 Owner materialization-writer advisory transaction mutex，不升级 auth.users SHARE 为 UPDATE。mutex key 只由服务按已验证 Owner 派生，私有早入口使用 pg_advisory_xact_lock；guard 证明精确匹配当前 backend、已 granted Exclusive advisory 锁与该 Owner key，不能使用客户端传入 key 或 GUC 自报。政策批准／变更与资源创建共同串行化，防止两个事务分别扫描时都看不到对方未提交资源。等待 mutex 后以 READ COMMITTED 的新 statement 重新读取来源和资源；非 READ COMMITTED 的相关写入口明确拒绝／要求重新发起，不能以旧 snapshot 展开。没有读时补权或无限自动重试。

屏障取在实际 Binding／Context／Project 行锁之前。Native 可先验证直接 Owner（仅账户 SHARE）；MCP 的创建入口在 resolve_binding 之前，使用当前 credential verifier 与无锁 Binding owner hint 找到 mutex，仅用于协调，等待后重新走真实 resolve_binding／Scope／撤销／版本检查。hint 与 mutex 永不授予业务权限。已闭合 Worker gateway 必须先完成其可信 caller 证明，不能另开裸 public RPC、绕过 verifier 或放宽 catalog ACL。

锁总序：Owner writer mutex → 现有 Binding UUID 升序 → Authorization → owner_grant_lock → confirmation nonce／Request／source → Context UUID 升序 → Parent Project SHARE → 内部 grant CAS。新事务自己插入、别人不可见的 Binding／资源不作为跨事务已存在锁；仍须在同事务按该协议物化或全部回滚。项目创建的原 mutation core 与终态语义不改。

| 实际入口／资源 | 本次必须采用的顺序 |
|---|---|
| Native clued_development_owner_v14 的 create／grant_upsert／grant_revoke | 先 Owner mutex。upsert 无锁定位目标 B；revoke 用已保存 grant ID 无锁定位 B，不信提交 Binding。先 B/Auth，再 C/ParentProject，再锁 grant 并重验 Context/Binding/Owner/env/ID/CAS。原 owner idempotency lock 在总序的 nonce 阶段；不能继续 C→B。owner_list 用诊断读取 |
| OAuth authorization_approve／manage reduce/revoke | 先 mutex，再已存在 B/Auth；Request/selection/CAS 与 nonce 检查继续。多 Context 按 UUID。新 B 在同事务创建并设置粗筛后精确物化，普通审批不清旧拒绝 |
| Native connection.permission 扩权 | 外层 clued_owner_grant_v1 从服务已保存 nonce/native_choices 无锁定位实际 target B；mutex 后先锁并重验 B/Auth，再进入原 owner_grant_lock／token/Request 消费与 apply。apply 也断言/遵守该前置，不能继续 GrantLock→B；其他 release/admission 消费门的 B SHARE→GrantLock 不因此形成环。Owner Request producer 保持或重排为 B→GrantLock，若采用 writer mutex 必须在 resolver 前取，不能晚取 |
| Headless confirmation／issue／rotation | 诊断预览无 B/C 执行锁；真正 issue 先 mutex，从服务保存 choices 无锁定位旧 B，先旧 B/Auth，再 token 消费与重画 digest、来源/例外/限制重验。新 B 未提交可见性边界保持；一次性令牌、角色迁移与旧令牌宽限按现行合同 |
| MCP/Native Project create，含实际仍可调用的旧入口 | Native 由验证 Owner 先取 mutex；MCP 在真实 resolver 之前取，并保留 Worker gateway 证明。实际 catalog 枚举全部可插入项目的公开/私有链，旧 project_observe/mutate 如仍可调用也覆盖。不得只改 v2 声称全入口已覆盖 |
| 旧 project:*／新 contexts:* future Project hook | 合为一次 fan-out，先 union 两类 live Binding，再 UUID 升序；只处理 new Project ID。不能两个 trigger 各自排序造成先 B2 后 B1。hook 用当前 backend 的真实 advisory lock／pg_locks 证明早入口已持有 mutex，不相信自报 GUC，不在锁后迟取；Fixture/admin 创建须明确走 guard 协议，未满足早入口的普通路径失败 |
| 新 Context hook | 只处理 new Context ID，live Bindings UUID 升序，不扫其他已有 Context；已有 Project SHARE 不取代早入口 mutex。早入口与新 statement 保证批准/创建无相互漏读 |
| 旧/new source 的更新／物化／精确 grant adapter | 同一投影刷新；adapter 先 B/Auth 后 C，不先 C 再调用旧 Native helper。多源/多资源按稳定 ID 顺序，幂等结果不清除精确阻挡；晚期 deferred 只是提交时机，不能代替早屏障 |
| Binding self／issuer revoke 与 expiry sweep | 有限 writer 在 B 前取该 Owner mutex；sweep Owner ID 和各 B 稳定排序，重验真实期限/版本。不复活 source 或 grant，清理不是新同意 |
| Native management list／diagnostic preview | 使用无 B/C 行锁的限定能力观察器，明确 diagnostic_only；不把跨 Binding 诊断读取变成全局业务 admission，不用 mutex 扼制普通查询 |
| 逐次业务检查和 Context list | 普通 Record 读写不取 Owner writer mutex。仍 B SHARE→Auth→精确资格/环境/Context 强制检查；list 先单 B/Auth，再把 own/member Context ID union 全局 UUID 排序后核权，不能一支 created_at 排序、一支 UUID 排序逆序锁 |

实现须保存实际最终 function catalog/ACL 与各入口锁图证据；Source/projection/内部 grant/审计同事务成功或全部回滚。两客户端可控屏障测试至少覆盖：宏批准与 Native grant_upsert；收窄与 grant_revoke/业务；批准与创建互相漏读的两种交错；创建与撤销/到期；两 Binding 与旧/新策略 Project/Context fan-out；Native permission 审批与 owner_request/release/admission consume；Headless rotation 与 creation；Native list 与 writer。证明无死锁、无部分提交、无旧 policy 补回。任何无法覆盖的可调用入口保持明确失败并阻止发布，不能借裸管理员补权绕过。

## 5. 旧连接与权限管理

旧 `project:*` 仍只表达其原来批准的自有项目正式记录；不得重解释成新策略。旧“全部”角色显示不再由几个 canonical 条目猜出完整上下文授权。当前旧连接的确定显示例：范围“个人资料、个人记录、自有项目正式记录（含未来项目）”，操作按 effective 动作显示“全部操作（原授权）”或“自定义”，并明示“尚不包含项目用途上下文”。不能继续只显示“全部”造成完整覆盖的错觉。缺新覆盖策略或对应能力时准确显示原范围／自定义，并提供一次明确的升级入口。

新 OAuth 同意页选择“全部上下文＋全部操作”后同时批准已有与未来集合，不能只枚举当时的 Context。授权请求的范围快照、真实请求 scope、Owner 身份、版本、到期和同意回执继续绑定。

当前 Owner 的旧连接用现行 Native Owner 确认路径升级同一 Binding，不借 Cookie/JWT、其他 Binding 或 DB 绕过。可扩展现行 `connection.permission` 对 `permission:contexts:*/reader|developer|full|<action>` 的解析。升级预览必须绑定同一客户端／Binding 和 Authorization 版本，显示原范围、当前新增的具名上下文／实际环境、未来仅继承自有资源、实际新增动作与客户端缺项、有效期，并逐项显示既有 history/version/field 限制及其是否变化。普通宏升级保持限制；需要覆盖精确限制／撤销时另作逐项明确的 Native 确认与 CAS，宏确认不得顺带清除。采用新写法的 developer 包只打包 read/write；旧 `permission:project:*/developer` 与精确旧上下文写法不改含义。若实际 token 被客户端收窄，仍受其较小 scope 限制；无法原地升级时报告准确条件，不假定重新连接一定能恢复。

新连接预览“全部上下文（含以后新建的自有项目与上下文）＋全部操作（本次可用）”。实际 scope 缺项、精确例外、资格失效或内部限制导致部分资源不同，摘要必须明确“自定义／受限”及差异，采用 effective 能力，不能只看存储宏存在就宣称覆盖完整。

不批量扩展其他用户或其他连接的旧同意。撤销／到期的 Binding、Authorization、内部 grant 或资格不被未来创建、同意重放、列表读取或后台继承复活。单个资源已有明确撤销时保持拒绝，除非 Owner 新的明确同意对精确资源及影响作确认。不能以同名新 membership 或新资源替换旧被撤资格。

收窄或移除策略时同时处理其派生条目；未来资源沿收窄后的策略，不能由旧物化行重新授回。个别资源需要不同权限时，先转指定范围或用明确高级例外，不能展示一个会被后台覆盖的假勾选。任何内部 grant 残留仍不得绕过被移除的精确授权条目。已取得的副本无法追回，历史原文和审计保留。

## 6. 必须通过的验收

1. 已有个人资料、个人记录、自有项目正式记录及自有项目用途上下文均按选择有真实 read/write 等能力，而非只有角色名。
2. 批准之后新建项目、同一旧项目下新建 Context、不同实际环境下新建 Context 均按新策略继承；无需再补权限。
3. 只读不能写；可编辑不能关闭／恢复／审计／反馈；全部操作只给真实申请且支持的动作。未请求写权限的客户端不能被预设扩大。
4. 他人项目、共享／邀请上下文、Context Owner 与项目 Owner 不一致、环境伪造均不自动纳入。
5. 旧项目通配和旧全部连接保持原权限；新策略经真实 Owner 同意升级后才增加权限；重放不能新建第二 Binding 或越过已变更版本。
6. 策略收窄、移除、连接撤销／到期、内部 grant 撤销／到期及资格撤销后，创建未来资源不能复活旧权限；既有固定版本／字段／历史限制不被一般物化扩大。
7. 并发创建与收窄／撤销、CAS 和失败重试不会部分授予、死锁或用旧策略补回；审计绑定实际事务结果。
8. 简单范围／动作与高级勾选、角色显示、Headless 预览及轮换表达同一套实际条目；不能出现“全部”却缺某类上下文。
   同时验证第 1 节三个指定范围例子及空选择、初始状态、两个方向的范围切换、预设重套、例外提示、账号／版本变化；提交集合及真实能力一致，未选环境及未来资源不授权。
9. 用户与项目用途目录统一“上下文”；已证明当下有效的内容标“即时权威上下文”。历史／候选／UNKNOWN／失效内容保持真实状态，原 ID／正文／标签关系不变。
10. 现行 Native、OAuth、MCP、会员隔离、撤销、角色、迁移链和期限相关回归通过；实际适用 GitHub 检查按精确提交通过，不能用本地检查替代线上门禁。
11. 生产按现行备份、精确 SQL 授权、迁移、发布及 postflight 执行，分别记 Receipt 和实际 Source；未运行的用例保持 NOT_VERIFIED。
12. 原八视图验收继续：合成项目用途记录 v1→v2、保留历史正文检索、同 ID 多标签及隔离、来源完整正文正样本。此前核心用例只在未变范围复用；Stage 3 原文汇聚／模型分类等仍独立，不能由本修复冒称完成。

### 6.1 原八视图 V01–V24 承接

规范来源：已接受三阶段 Decision `9e037a44-1de2-4b75-9e45-2ca0cb2a2daa` v2 与原完整方案 r2，SHA `7f061207e01d9369924b0bfca8bb8627eacde106aee4fffbfaadece647a00d66`。历史 Native 证据 E1：`work/eight_implementation/ui-acceptance/native-ui-acceptance.json`，SHA `58c0923c8b187cf738ff001502fef6d7599dbedd76165c8c34c6545a8e8002c0`，受查部署 `8f960b5541e29ad279d4976f5c366ea4e1297ad4`，结论 `CORE_FLOWS_PASSED_FULL_ACCEPTANCE_INCOMPLETE`。下表案例名精确对应 E1 observations；复用只适用于同一对象、namespace、scope 和部署中未变的逻辑，不能代替改后受影响的回归。工程测试是补充，不替代真实页面证据。

| 用例 | 适用阶段／当前证据边界 | 本次处置与完成门 |
|---|---|---|
| V01 无领域标签可找回 | 首版；E1 `labels_remove_restore`、`developer_formal_object_views` 覆盖已保存 Canonical 对象 | 两目录改后回归；项目用途自身记录无标签样本需补 |
| V02 多标签同对象 | 首版；E1 `user_multilabel_identity_body`／`developer_formal_object_views` 限同 Canonical Task 身份 | 复用历史一致性；改后两目录再跑，补 Context namespace 同 ID／正文 |
| V03 期限一致 | 首版；E1 `user_deadline_sync_and_restore`，Task v35→36→37 已恢复 | 同对象逻辑未变可复用，改后至少一条跨视图回归并恢复数据 |
| V04 电影收藏按兴趣 | 首版手动标签；自动用途理解属 Stage3；E1 无完整样本 | 手动真实样本 NOT_VERIFIED，按兴趣分类；自动能力仍 Stage3 未完成 |
| V05 同电影练听力 | 首版手动多标签；自动建议增强属 Stage3；E1 无完整样本 | 补学习＋兴趣手动样本，不以英语关键词自动入学习 |
| V06 对账表不自动创作 | 首版手动；模型分类属 Stage3；E1 无完整样本 | 补工作单标签样本；模型自动分类保持 Stage3 NOT_VERIFIED |
| V07 愿望不自动任务 | 首版身份边界；汇聚自动提炼属 Stage3；E1 仅建议有限证据 | 补 note／候选愿望样本，领域标签不建 Task；自动提炼不在本次关闭 |
| V08 请求／建议不变承诺 | 首版身份边界；入口汇聚属 Stage3；E1 `rule_suggestions` 限规则建议 | 改后请求／候选身份测试并补页面样本，未接受不建 Task／Decision |
| V09 会议原文与关联 | 首版已保存全文读取；自动提炼关联属 Stage3；E1 无完整证据 | 已保存原文部分 NOT_VERIFIED；自动拆分／关联保持 Stage3 待办 |
| V10 引用已有事项不重建 | Stage3 提炼／关联能力；E1 无完整证据 | 保持 NOT_VERIFIED，不能用手动多标签宣称通过 |
| V11 完成不隐式重开 | 首版；E1 `qualified_saved_and_strict_views` 限 Canonical 已完成 Task，未完整覆盖终态改标签 | 复用已验显示；补终态标签／打开／检索及 Context 终态回归 |
| V12 决定替代可追溯 | 首版；E1 `qualified_saved_and_strict_views` 限历史可见与严格视图排除 | 补后继／适用范围与旧正文追溯；Context v1→v2 不冒充正式 Decision 接受 |
| V13 未整理来源可读 | 首版已保存来源可读；入口汇聚属 Stage3；E1 正向全文 NOT_VERIFIED | 补完整正文正样本；外部未入库内容不计入已保存全集 |
| V14 预览可打开全文 | 首版；E1 `user_multilabel_identity_body`、`source_missing_body_semantics` 只证明正文和诚实缺失 | 正向来源全文与必要历史需补，不能用 locator-only 代替 |
| V15 保存后索引延迟 | 首版状态边界／Stage3汇聚索引增强；E1 未验证延迟 | 可控缺索引／延迟测试保持明确状态并能浏览已保存全文；增强未实现不宣称完成（Task d5dee826） |
| V16 无权内容与敏感数量隔离 | 首版，直接受授权改动影响；E1 `user_body_search_and_intersection` 限项目/通用正反过滤 | 本次重跑 Owner／foreign／共享未选／环境／来源无权及数量隔离；标签不扩权 |
| V17 改标签不改身份 | 首版；E1 `labels_remove_restore` 限活动 Task | 改后活动／终态／候选及两个 namespace 回归，保存原正文与状态 |
| V18 UNKNOWN/STALE/CONFLICT | 首版，直接受新标识影响；E1 不完整 | 本次逐态测试与页面样本，缺能力不贴即时权威、不猜当前行动 |
| V19 active Event 吸收后仍有效 | 首版服务边界，直接受标识影响；E1 未验证 | 本次服务用例验证吸收前后真值地位，并核 UI 不以 Record 字段过滤掉 Event 或虚构已收齐 |
| V20 搜索切全部可扩大 | 首版；E1 `user_body_search_and_intersection` 限 Canonical 正文 | 改后两 namespace 重跑，显示范围；单视图未命中不判全局不存在 |
| V21 工作追加任务交集 | 首版；E1 `user_body_search_and_intersection` 限工作＋Task | 改后两目录重跑；Context 记录的kind不因用途标签被提为正式 Task |
| V22 来源与条目共用出处 | 首版来源链接／Stage3自动关联；E1 缺完整样本 | 手动现有来源关联正样本需补，证明未复制可编辑正文；自动关联仍 Stage3 |
| V23 来源／历史词检索 | 首版现行检索范围；Stage3统一索引增强；E1 `developer_history_no_fabrication` PASS_LIMITED、`developer_revision_history_namespace` BLOCKED_PERMISSION、`positive_source_full_body` NOT_VERIFIED | 本次授权后补项目用途 v1→v2 与历史保留；明确来源原文未索引限制并可浏览全文；不伪造全库词检索 |
| V24 标签不级联独立事项 | 首版对象独立性；Stage3批量关联；E1 无完整样本 | 补原记录／独立Task/Decision不同ID案例，无静默级联；未实现批量传播保持未验证（Task d5dee826） |

三个完成门分别记录：授权修复完成＝本节 1–11 实际通过并部署、当前旧连接真实升级及能力核验；首版八视图验收完成＝所有首版适用部分有精确实际证据，未支持的来源／索引边界明确且满足已接受首版范围，Stage3 部分明确保留；整体原 Task 完成＝已接受三阶段及原剩余全部实现和验收。只补旧权限缺口或既有核心 GO 不能关闭整个原 Task，不另建重复执行 Task。

## 7. 执行顺序

具体合同候选内容绑定 → 非作者独立方案审核 → 修正并复审通过 → 实施及本地有效验证 → 精确提交独立代码审核和当前适用 CI → 正常 PR/FIFO 合入 → 现行精确生产门禁 → 当前 Owner 连接的真实新同意／权限核验 → 继续原八视图真实页面验收 → 按实际完整范围收口。

一个阶段的 PASS 不替代后续阶段。需要实际 Owner 点击的安全权限／生产步骤在具体输入可审查后使用现行批准流程，不重复询问已明确的产品范围。
