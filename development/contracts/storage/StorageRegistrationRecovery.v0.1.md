# Storage 登记版本自动恢复 v0.1

## 1. 边界与来源

这是 Task `9a263b02` 的实现合同候选；候选、测试通过和独立审核均不等于生产已接受或上线。基线为 `f24a2118cd8baa69294024b76b4ec6ce06949f7d`。原 Task `e91a8ebc`、归档 Task `37434e62` 的历史、拒绝回执、成本和状态继续保留。

Owner 要求日常可判定的问题由程序检测、修复和验真；Agent 的工作是维护程序，用户不承担重复核对工作。这个要求不允许程序猜测未知外部效果、扩大授权或改写已有业务权威。

现行 Decision `1ddd9acb-d038-4a94-b400-058c8d17213f` **version 3** 的完整文本已核对，其边界为：“登记目录不再钉版本，改查分享/权限；文件覆盖/移动/删除仍严格核对版本。”本实现保留文件操作的严格 expected-version 条件，并在同一条件下修复已登记文件的技术元数据漂移。

## 2. 可自动处理的唯一情况

正常的、已获授权的 account-policy cloud 新作业在首次 authority 解析中得到精确原因 `destination_version_mismatch`，且同时满足：

- 操作为 `replace`，目标为已有 `file`；作业尚无 intent、dispatch outcome 和 provider attempt。
- 作业原有 `mutation.destination_file_version` 等于 Worker 当前直接从 Google 读取的版本。程序不改变 mutation，也不代填用户或 Agent 未观察的新版本。
- 原登记的 Artifact、Google ID、路径、父目录、根、Owner、Project、治理分类、删除权威及 source Decision 保持同一身份；区别仅在登记的 `provider_file_version` 落后。
- 原正常 cloud authority 的完整 app、issuer、Binding、Policy、授权、凭据、执行资格、Work Claim 和 Currentness 检查全部有效。缺少条件时保持原拒绝。
- 所有已登记祖先仍通过现有 identity/access/sharing matcher；身份、分享、权限或 Currentness 漂移不归类为可修登记落后。
- 受影响对象不在 isolation 中；原根无在途未知写入，且 Artifact、Profile、凭据和请求摘要的 CAS 仍相符。

旧 denied 作业保持终态。存在 intent、未知效果、在途 attempt、隔离或人工权威选择的对象不进入本路径。其他根和对象不因本路径失败被加上新的持久阻塞。

## 3. 程序流程（Task `9a263b02`）

1. Worker 收到正常 authority 的精确版本漂移拒绝后，调用现有受控 cloud router 的内部 `registration_load` 动作。数据库通过保留的正常 authority 实现重新验证完整资格并派生目标，不接受调用者指定 Owner、Artifact ID、source Decision、治理属性或注册根。
2. Worker 使用该作业现有受限凭据，对服务端派生的同一 Google ID 作两次独立只读 metadata GET。ID、版本、父目录、名称、MIME、未删除状态、大小与 SHA-256 必须稳定；版本必须等于原 mutation 的 expected version。该流程不读取文件正文，也不发 Google 写入。
3. `registration_commit` 在既有锁顺序下重验完整正常资格、对象 isolation、在途状态、祖先及 CAS，并验证两次观察的边界与短有效期。仅通过既有 `artifact_update` 更新原 Artifact 的 `provider_file_version`；其余身份、权限、source Decision 原样保留。
4. 独立的 `storage_registration_recovery` M1 Receipt 和 Event 与原 `artifact_update` Receipt 同事务提交，绑定原作业、请求摘要、前后版本、原 source Decision、观察摘要和登记回执。稳定原 key 唯一去重，不建立第二套业务真相。
5. 更新成功后重新执行完整正常 authority，得到新版本向量并重新产生正常 admission；不复用旧 permit。原 `storage_cloud_job_current_v2` 必须仍原样通过，不修改 authority snapshot。
6. commit 响应丢失后只以原作业和原 key 调用 `registration_inspect`。检查回执与登记结果后才能继续重新解析 authority；不以超时推断失败，不自动重发 commit，不触发第二个外部效果。跨 Worker 的技术状态由数据库持久保存；即使普通 authority 已 resolved，新 Worker 仍先按原登记 CAS、原 key 核对恢复回执。

重复执行、进程重启和两个合法新作业的竞争均受唯一恢复 key、行 CAS 和现有根/对象锁保护。另一个作业已完成相同刷新时，后到作业只重新解析完整 authority，不重复登记。

## 4. 权限和实现边界

所有新增数据库 helper 均为 `clued_private` 内部函数，固定 `search_path=''`，撤销 PUBLIC、anon、authenticated、service_role、clued_worker_gateway 的直接 EXECUTE。不新增公有 RPC、MCP 工具、Gateway allowlist 项、管理会话、凭据或服务端密钥。

现有公开 router 继续经过原 issuer proof → 私有 identity router → account-policy execution router。新增动作复用保留的正常 authority 资格源，不能用简化的资格副本替代。`clued_resource_center_admin_v1` 的 service-role ACL 不改变；程序仅在受限 private 合成点内部构造唯一的 metadata-only `artifact_update`。

所有动作使用精确 payload allowlist；不接受 owner、client、origin、resource、alias 或 issuer identity 自报。身份由原 router proof 派生，恢复 descriptor、原请求 digest、原 Artifact CAS 和稳定 key 由服务端生成并逐字比较。恢复 Event 是绑定原 `artifact_update` 业务 Receipt 的 `audit_only` 技术扩展，不建立新的业务权威。

在此技术操作中，provider metadata 是观察事实，不是业务 Authority。文件正文不会成为 Decision、Record、Evidence 或 Current Truth；既有 source Decision 不被替换。分享/权限、目录、路径、Google ID、治理级别、删除权限、授权 generation、续签和 connection 状态不被恢复路径修改。

## 5. Snapshot、字节证明和交付

基线的 `storage_policy_evaluate_v2` 快照绑定 Policy、Capability、Lineage、Binding、授权、Profile、auth generation 和 actions；`storage_policy_scope_digest_v3` 的登记部分仅包含获准 track 目录的路径和 ID，不含文件版本。实现仍在恢复前后调用原 current 检查；若现行合同后来加入文件版本导致旧 snapshot 失效，恢复路径不得修补 snapshot 或降低检查。

旧写入的 verified proof、字节 hash、Provider version、Receipt 和 delivery 引用全部保持原值。现有 delivery resolver 同时检查 proof 的 Google 版本和原登记 Receipt；新的 metadata 登记 Receipt 会使不再匹配的旧交付成为 stale。新登记观察的 SHA-256 仅证明本次只读观察，不能伪装成旧作业写入或成功交付的证明。

现有 writer 已产生 persisted-verification `/3`，而旧 delivery resolver 仅接受 `/2`。兼容修复只替换该标签判断，保留其余原 proof/digest、双 Receipt、Owner、作业及 registry 判断。`/2` 保留原语义；`/3` 需要精确 storage kind、UUID issuer、数值正整数 generation 和有限记录时刻，并沿 connection.oauth_client → storage app → storage issuer identity → 同 issuer/generation 历史 credential 链核对。credential 必须在证明时已创建且已激活，并在证明时尚未到 valid_until/retired_at；之后正常轮换退休不抹去有效历史。缺失、NULL、错误类型、越界或凭据字段混入均返回 false，原内容 `saved.proof` 保留。这只是历史证明识别，不授执行资格，不把 legacy issuer key 作为凭据后门。

## 6. 自动恢复结果与失败

正常运行由程序触发；不引入“请用户确认当前文件”或“请 Agent 手工修版本”的常规步骤。读取瞬态失败可以有界重试只读 GET；提交不确定只能 inspect。失败不给其他对象增加隔离，不清理任何既有隔离，也不重活旧作业。

每个原 queued 作业只有一个 private 技术检查，绑定不可变的原 registration descriptor 和 key。`checking` 是短租约核验，瞬态读取失败转 `retry_wait`，提交响应不明转 `commit_unknown`；已落地但尚需新 Worker 核对的 Receipt 用 `confirming`。成功回执核对后为 `resolved`；另一路已正常刷新同一 expected head 时为 `superseded`，不伪造自己的恢复 Receipt；确定拒绝或期限耗尽为 `failed`。每次转换留独立 audit-only Event/Receipt。一个文件最多一个活跃 metadata 核验，其技术状态不充当全根持久锁。

原作业通过任何现有合法路径成为 pre-intent 终态时，同事务关闭活跃技术检查并释放对象唯一索引。覆盖 Worker report、native 权限级别切换、原 queue timeout 等入口；不能只在某个调用包装器里清理，也不能使技术检查阻止之后重新获权的新作业。该清理仅跟随已经发生的原作业终态，不改变其 outcome、权限、历史或 Receipt。

短租约、尝试数、next_at 和期限均由服务端派生。checking/commit_unknown/confirming 在租时另一个 Worker 返回 busy，不增加尝试数。失败的只读核验保留同一个 queued 作业，由既有每分钟 queued sweep 按有限退避再次派发，不新建后台队列，不重活 denied 作业。最多六次核验且不晚于原作业两小时期限；到期通过原 dispatch outcome key 明确结案，正式 inspect 保留 `REGISTRATION_RETRY_EXHAUSTED` 等固定技术原因，不能永远 queued。原 job mutation、expected、request digest 和 authority snapshot 均不改变。

只有同一数据库事务取得完整原资格/原 job-root 锁和 sidecar 行锁后，查不到精确原 key 的任何 Receipt，才可原子旋转 lease、作废迟到旧 commit 并转 retry_wait。若旧 commit 已持锁，inspect 等待其提交或回滚后再判断；超时、断网、序列化失败一律不视为不存在。查到 pending/损坏/不匹配 Receipt 不按不存在处理。旧 lease 的 commit 不可改变登记或创建 Receipt。这个证明未提交的路径只适用于本技术 metadata 事务，不适用于未知 Google 文件写入。

若同锁 inspect 已证明原 key 没有提交，且当前完整 registration CAS 确定不同于原 descriptor，则立即以 `REGISTRATION_CAS_CHANGED` 结清该作业的技术待办，不耗尽六次重试，也不把旧 descriptor 换成新 CAS。对象检查释放后，新获权、携带当前 observed expected version 的正常新作业可以独立推进；旧作业保持终态。未知 Receipt、锁超时或断网不满足这个结清前提。

pending、busy、unknown、检查不可达均向原 kernel 明确拒绝 authority，不能在 resolved 外层结果里仅附警告后继续 begin。服务端 begin 在同一事务取得原资格和锁后再次拒绝未闭环技术状态。只有恢复回执核对完成后重新获取的完整普通 authority 可进入原不可变 admission/intent/attempt 流程。

私有诊断仅使用固定阶段/原因码、已授权的原标识和 Receipt；不保存原始异常、Provider 响应正文、令牌、credential envelope 或秘密。恢复失败时仍保留原始 authority 拒绝和原作业回执，不能把未完成报告成成功。

## 7. 验收（Task `9a263b02`）

优先使用一次性 PostgreSQL 跑真实迁移、真实 router 和现有权限夹具。合格成功路径应仅改变一个 Artifact 的 provider 版本、行版本、updated_at 和 Receipt，并产生唯一的独立恢复 Receipt/Event；旧 mutation、snapshot、Decision 和证明保持原值。

数据库负例覆盖：跨 Owner/Project/根/文件 ID、旧 expected version、终态作业、已有 intent/attempt、未知在途效果、隔离、祖先访问变化、source Decision 不当前、授权/凭据撤销或代次变化、Artifact/Profile CAS 竞争、重放冲突、commit 响应丢失、直接角色调用。竞争测试证明相同刷新只登记一次，其他对象正常资格不受影响。旧交付证明必须因新登记回执不匹配而 stale，不能冒充新 head。

Worker 测试证明两次真实形状的只读 metadata GET、稳定性校验、有界读取重试、lost commit 只 inspect、无 Google 写入、无静默 expected-version 或 snapshot 修改；集成测试覆盖正常 authority 拒绝 → metadata 恢复 → 新 authority → 原有受控 prepare。数据库验收通过后才进行页面正常操作验收。候选实现、独立复审、合并、生产迁移、发布和两类验收各由实际结果分别证明。

并发验收使用两个独立 PostgreSQL clients，实际观察锁等待：commit 先锁定时 inspect 只能读回提交后的唯一原 Receipt；inspect 先锁定并证明不存在时，迟到旧 lease commit 必拒。另测同一 expected head 两个合法作业最多登记一次、unknown 租约并发不烧尽尝试、其他文件正常执行、元数据暂时断网后原 scheduled sweep 再派成功、commit 丢回包且 inspect 暂不可达后全新 Worker 只 inspect 原 key 并继续。interleaved 单连接测试不得宣称已证明真实并发。
