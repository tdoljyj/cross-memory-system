# Clued 校验不变量与去重矩阵 v1.1

- `document_status: static_review_passed`
- `document_version: v1.1`
- `date: 2026-08-26`
- `supersedes: Clued_校验不变量与去重矩阵_v1.0.md`
- `source_review: Clued_校验不变量与去重矩阵_v1.0_审查报告.md`
- `repository_baseline: tdoljyj/cross-memory-system@9f0e171b350b9dd462fc3ce184dd6ddb45ea4689`
- `snapshot_baseline: snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155 / Manifest 枚举全部文件（基线 710）`
- `repository_identity: NOT_ASSIGNED`（候选版尚未获准入库；正式 Gate 前必须补仓库路径、Commit 与 Git Blob SHA）
- 适用范围：个人、多用户、团队、企业、多 Agent、多设备及跨厂商 Clued 客户端

> 本文档是已通过 R0–R5 静态审查的候选修订版，不是不可变 Gate Baseline。只有获得入库授权并绑定仓库路径、Commit 与 Git Blob SHA 后，才能升级为 `gate_baseline`。

## 1. 文档身份、状态和适用范围

本文档修正 v1.0 的逻辑、Schema、分类、阶段门禁、测试追踪、现状标注、同机并发、备份保留和隐私机制缺口。v1.0 与其审查报告继续保留，不原地覆盖。

生命周期为：

```text
candidate
→ static_review_passed
→ authorized_for_repository
→ committed
→ gate_baseline
→ superseded
```

本候选版已完成文档修订与 R0–R5 静态检查。它不授权 P0 测量、P1–P6 实现、生产环境改造、Snapshot 切换或仓库写入。

## 2. 不可削弱的企业级强一致性原则

唯一总原则：

> 强一致性、授权、租户隔离、可审计性和故障安全完整保留；只消除经过等价证明的重复执行，不删除保护不变量所必需的独立检查。

“快速路径”不得成为“弱校验路径”。允许复用的是针对同一不可变输入、同一信任边界、同一授权状态、同一目录身份和有效 TTL 生成的请求内证据，而不是脱离上下文的 PASS 结论。

下列能力不得弱化：

- Clued Cloud Canonical Store 的在线唯一事实源地位。
- User、Organization、Workspace、Project、Context Key、Binding、Role、Scope 与 Purpose 隔离。
- Auth、服务端授权、RLS、最小权限和在线撤销即时生效。
- CAS、幂等、事务、Event 与 Receipt 原子性。
- 冲突显式化、不可变历史、Supersede、删除与擦除合同。
- Manifest 原子单元、源/目标独立完整性校验、Owner 校验、确定性构建和 Current Pointer CAS。
- 离线 LKG 的有界降级、重新联网后的服务端仲裁和 fail closed。
- Target、Actor、Version、Sources、Evidence、Error、Receipt 与审计链。

## 3. 当前事实基线与存量偏差

本文档的事实判断固定在 `9f0e171b350b9dd462fc3ce184dd6ddb45ea4689`，不把后续 `main` 内容倒灌为本基线事实。

| 项目 | 当前基线 | 目标态 | 归属阶段 |
|---|---|---|---|
| 读路径工作树隔离 | 未实现；当前 pull 可 merge 开发工作树 | 独立只读 Mirror | P3 |
| `live_rechecked_at` | Manifest 未提供 | 显式时间戳与策略版本 | P2/P4 |
| Request-local Verification Context | 未实现 | 请求内证据复用 | P2 |
| 跨进程证据复用 | 未实现 | 本版明确禁止 | 未来 ADR |
| T1 精确读取 | 文档要求，但当前实现可扫描全部项目 | Index/Routes 精确定位 | P4 |
| 同机 Mirror 并发 | 未定义 | 独占锁、相同 Snapshot 幂等、不同 Snapshot 确定排序 | P3 |
| Backup 保留 | 当前无界增长 | 版本化、有界、可审计，且保留已验证 LKG | P3 |
| AGENTS 隐私标识 | 私有仓库含账号提示与稳定 Owner Ref | 通用规则与私有映射分离 | 文档修订/后续授权 |

当前账号提示与稳定 Owner Ref 是私有仓库内的受控存量例外，不代表已经公开泄露，也不得被描述为目标态已满足。公开、共享或进入 Skill、Plugin、CI、构建产物、对外 Bundle 前必须整改。

## 4. 去重资格规则

一项校验只有同时满足以下七个条件，才允许复用或合并：

1. 保护的是同一个不变量。
2. 输入具有完全相同的不可变身份，例如 Commit SHA、Manifest SHA、Snapshot Version、Canonical Version。
3. 校验发生在同一信任边界；源目录和复制后的目标目录不属于同一边界。
4. 两次校验之间没有文件、指针、授权、策略、目录身份或撤销状态变化，且时间间隔未超过证据 TTL。
5. 复用证据仍有效，并绑定当前请求、规范路径解析结果、目录身份与 Mirror Generation。
6. 失败语义保持不变；旧路径应阻断的场景仍然阻断。
7. 自动化测试和故障注入证明新旧路径具有相同拒绝集合与成功后置条件。

任一条件无法证明时，必须执行完整校验。不得仅以“看起来重复”“通常不会变”“mtime 未变”或“当前只有一个用户”为理由复用。

### 4.1 重复三分类

| 分类 | 含义 | 处理方式 |
|---|---|---|
| 真重复 | 同一输入、同一边界、期间无受保护状态变化且未超 TTL | 合并为一次，后续步骤复用请求内证据 |
| 条件重复 | 仅在身份、授权、目录身份、代次与 TTL 全部相同时重复 | 通过 Request-local Verification Context 有条件复用 |
| 表面重复 | 检查对象相似，但跨越复制、事务、授权、网络或发布边界 | 两次都保留，不进入去重 |

七条资格规则只适用于真重复和条件重复；表面重复直接保留。

### 4.2 非重复热点五分类

| 分类 | 判定规则 | 处理方式 |
|---|---|---|
| 不必要工作 | 不增加保护能力，且可由确定性索引或路由避免 | 用最小读取替代，并保留歧义回退 |
| 架构热点 | 成本来自错误的权威源或执行路径选择 | 修正路由，不以缓存掩盖来源问题 |
| 非等价来源 | 两个来源权威级别不同 | 明确优先级，不合并语义 |
| 非等价冲突 | 错误名称相似但冲突域不同 | 分离状态码、证据与处理路径 |
| 禁止双写 | 第二次写入破坏唯一事实源 | 删除第二业务写并 fail closed |

## 5. 不变量注册表及执行状态

状态枚举：`ENFORCED_CANONICAL`、`ENFORCED_SCRIPT`、`PARTIAL`、`TARGET`、`DEFERRED_ADR`。状态仅描述固定基线，不表示本文档已授权实现。

### 5.1 权威源、租户与授权

| ID | 不变量 | 必须验证的证据 | 失败行为 | 执行位置 | 当前状态 | 归属阶段 |
|---|---|---|---|---|---|---|
| A01 | Clued Cloud Canonical Store 是唯一在线事实源 | 服务目标、Canonical Version、响应来源 | 阻断在线权威结论 | Clued Service | ENFORCED_CANONICAL | 已有合同/P4 路由 |
| A02 | Git、Markdown、Bundle、索引只能是只读投影或离线副本 | `read_only`、Export Receipt、Snapshot Version | 禁止反向业务写入 | Service + snapshot scripts | PARTIAL | P4/P5 |
| A03 | 每次访问绑定准确的 User、Organization、Workspace、Context Key | 认证主体、租户键、上下文键 | fail closed | Auth/Service | ENFORCED_CANONICAL | P5 验收 |
| A04 | 每个 Agent 使用独立且可撤销的 Binding | Binding ID、状态、Revocation Epoch | 已撤销 Binding 立即拒绝 | Auth/Service | ENFORCED_CANONICAL | P5 验收 |
| A05 | Role、Scope、Purpose 与敏感度满足最小权限 | Policy Version、Scope Hash、Role、Purpose | 拒绝或缩小返回集 | Service | ENFORCED_CANONICAL | P5 验收 |
| A06 | 跨租户、Workspace、用户数据永不混读混写 | RLS 结果、服务端租户检查 | 拒绝并审计 | Service + RLS | ENFORCED_CANONICAL | P5 验收 |
| A07 | Auth、服务层授权与 RLS 是纵深防御 | Token、服务层检查、RLS | 任一失败即拒绝 | Service + DB | ENFORCED_CANONICAL | P5 验收 |
| A08 | 撤销、删除、擦除后不得从缓存、快照或其他 Agent 恢复 | Revocation/Erasure Version、Tombstone、缓存代次 | 缓存失效并拒绝 | Service + clients | PARTIAL | P2/P5 |
| A09 | 用户可见输出不得暴露 Token、完整账号映射或稳定跨范围标识 | 输出检查、Bundle 脱敏策略 | 阻断发布或输出 | Export/clients | PARTIAL | 文档修订/后续授权 |

### 5.2 写入、并发与事务

| ID | 不变量 | 必须验证的证据 | 失败行为 | 执行位置 | 当前状态 | 归属阶段 |
|---|---|---|---|---|---|---|
| C01 | 所有权威写入携带精确 Base Version | CAS Base Version | 返回冲突，不覆盖 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C02 | CAS 在事务提交点生效 | 受影响行、事务版本 | 冲突回滚 | DB | ENFORCED_CANONICAL | P5 验收 |
| C03 | 可重试写入复用稳定 Idempotency Key | Key、请求指纹 | 返回原结果或冲突 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C04 | 同一幂等键不得对应不同正文 | Key、Payload Hash | 拒绝并审计 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C05 | Mutation、Event 与 immutable Receipt 同合同成功 | Transaction、Event、Receipt ID | 全部回滚 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C06 | 失败写入不生成成功状态、Event 或 Receipt | 错误状态、回滚证据 | 保持原版本 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C07 | 修正通过 Supersede/Close/Restore 表达 | 前后 Record、关系、版本 | 拒绝非法覆盖 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C08 | 跨对象约束保持事务一致 | 对象版本、引用完整性 | 回滚或阻断 | Service/DB | ENFORCED_CANONICAL | P5 验收 |
| C09 | Resume 与 Checkpoint 使用精确版本和一个下一动作 | Resume/Checkpoint Version | stale conflict | Service | ENFORCED_CANONICAL | P5 验收 |
| C10 | Outbox 联网后由服务端按 CAS、幂等与策略仲裁 | Pending、服务端 Receipt | 不得本地判成功 | Service/clients | PARTIAL | P5 |
| C11 | 语义冲突不得由 Agent 静默选边 | Conflict Packet、Blocked State | `BLOCKED_SEMANTIC_MERGE` | Clients/orchestrator | PARTIAL | P1/P5 |

### 5.3 快照、Manifest 与发布

| ID | 不变量 | 必须验证的证据 | 失败行为 | 执行位置 | 当前状态 | 归属阶段 |
|---|---|---|---|---|---|---|
| S01 | `memory/` 永远是只读快照 | 写路径拒绝测试 | 拒绝 Markdown/Git 业务写 | Snapshot scripts | ENFORCED_SCRIPT | P5 负测 |
| S02 | Manifest 与其哈希文件构成原子发布单元 | Manifest SHA、文件清单 | 任一缺失即整体无效 | Validator | ENFORCED_SCRIPT | 保持 |
| S03 | 路径安全、无重复、无绝对路径与 `..` | 清单结构校验 | 阻断 | Validator | ENFORCED_SCRIPT | 保持 |
| S04 | 发布源对 Manifest 枚举全部文件做流式全量哈希 | 文件数、每文件 SHA-256 | 阻断 | Validator | PARTIAL | P3/P6 |
| S05 | 复制后的目标独立完成流式全量哈希 | 目标路径、文件数、SHA-256 | 回滚，不切换 | Mirror validator | ENFORCED_SCRIPT | P3 |
| S06 | 源校验不能替代目标校验 | 不同 Trust Boundary | 两者均保留 | Validator | ENFORCED_SCRIPT | 保持 |
| S07 | 四个 current 声明字段同时成立 | Manifest 字段 | 不得称为 current | Validator | ENFORCED_SCRIPT | 保持 |
| S08 | Current 具有 `live_rechecked_at` 与 Freshness Policy | 时间戳、策略版本、有效期 | 降级或阻断 | Export/validator | TARGET | P2/P4 |
| S09 | Snapshot 发布使用 Expected-Current CAS | 旧指针、期望值、新值 | 冲突阻断 | Publisher/DB | ENFORCED_CANONICAL | P6 验收 |
| S10 | `published/{snapshot_version}` 不可修改 | 内容地址、只读策略 | 拒绝覆盖 | Publisher/storage | ENFORCED_SCRIPT | P6 验收 |
| S11 | `current.json` 只指向完整发布快照 | Pointer Hash、目标存在性 | 保持旧指针 | Publisher | ENFORCED_SCRIPT | P6 验收 |
| S12 | 根 `memory/` 与 Current Bundle 在切换提交处 byte-match | Commit、Bundle Hash | 阻断切换 | Cutover pipeline | ENFORCED_SCRIPT | P6 验收 |
| S13 | 同输入和 Generator Version 产生确定性结果 | Build Hash、重复构建 | 阻断发布 | Export/build | ENFORCED_SCRIPT | P6 验收 |
| S14 | Owner/Tenant Ref 与当前授权下发的 Scoped Ref 匹配 | Scoped Ref、Bundle Scope | 拒绝读取 | Service + reader | PARTIAL | P4/P5 |
| S15 | Index 是可重建投影，不能覆盖 Canonical Object | Index Version、Source Hash | 回退权威对象 | Reader | ENFORCED_SCRIPT | P4 验收 |
| S16 | 快照只通过 Receipt-backed canonical export 生成 | Export Receipt、Canonical Version | 拒绝无来源产物 | Export pipeline | ENFORCED_CANONICAL | P6 验收 |

### 5.4 Git、Mirror 与端点

| ID | 不变量 | 必须验证的证据 | 失败行为 | 执行位置 | 当前状态 | 归属阶段 |
|---|---|---|---|---|---|---|
| G01 | 远端 Ref 在一次操作中解析为具体 Commit SHA | Remote Head、Checked At | 无法解析即降级/阻断 | Git aligner | ENFORCED_SCRIPT | P1 |
| G02 | 禁止 force push、reset、rebase 与 local-over-remote | Git 审计 | 阻断 | Endpoint rules | ENFORCED_SCRIPT | 保持 |
| G03 | 读路径不得为对齐隐式修改开发工作树 | 独立只读 Mirror | 转入隔离 Mirror | Reader | TARGET | P3 |
| G04 | 脏开发工作树不得污染已验证 Mirror | Worktree/Mirror 隔离 | 不从脏目录镜像 | Reader | TARGET | P3 |
| G05 | Fast-forward 与真实 Divergence 必须区分 | 双向 ancestor | Divergence 阻断 | Git aligner | ENFORCED_SCRIPT | P1/P3 |
| G06 | 分叉保留 Base、Local、Remote 和冲突文件 | Conflict Packet | 等待语义合并 | Git aligner | PARTIAL | P1/P3 |
| G07 | Mirror 用临时目录验证、原子替换并可回滚 | Candidate、Backup、Rename | 恢复 LKG | Mirror | ENFORCED_SCRIPT | P3 |
| G08 | 各端只管理自己的消费者配置 | Endpoint ID、配置作用域 | 拒绝跨端覆盖 | Endpoint rules | ENFORCED_SCRIPT | 保持 |
| G09 | 同一目标 Mirror 的构建、验证和切换串行化；同 Snapshot 幂等，不同 Snapshot 确定排序 | Lock、Snapshot、Generation、切换记录 | 锁失败或顺序不明时不切换 | Mirror | TARGET | P3 |
| G10 | Backup 保留由版本化策略控制，并保留至少一个已验证 LKG、遵守 Hold/Erasure、生成审计 | Policy Version、LKG、Hold、Deletion Audit | 无策略、无 LKG 或有 Hold 时不删除 | Mirror/retention | TARGET | P3 |

### 5.5 Freshness、离线与降级

| ID | 不变量 | 必须验证的证据 | 失败行为 | 执行位置 | 当前状态 | 归属阶段 |
|---|---|---|---|---|---|---|
| O01 | `latest/current` 优先查询在线 Canonical Store | 在线版本与服务时间 | 不用 Git 冒充在线当前值 | Router/service | PARTIAL | P4 |
| O02 | Snapshot Freshness 是策略输入而非永久布尔值 | `live_rechecked_at`、Policy Version | 超期重检 | Reader | TARGET | P2/P4 |
| O03 | 保留 strict `1h`、balanced `6h`、degraded `30min` | Policy ID、TTL | 未知、自定义或 `>6h` fail closed | Policy engine | ENFORCED_CANONICAL | P4 验收 |
| O04 | 有效截止是 Session、策略和降级截止的最小值 | `effective_expires_at` | 超期拒绝 current | Reader/service | TARGET | P2/P4 |
| O05 | 只有明确 `UNAVAILABLE` 可离线降级 | Error Class | Auth/Scope/Owner 错误不降级 | Router | PARTIAL | P4 |
| O06 | 降级结果含 Verified At、Stale Age、Reason 与来源版本 | Degraded Envelope | 不得省略限定语 | Response layer | TARGET | P4 |
| O07 | 离线写入只能是 Pending Intent/Outbox | Pending ID、Payload Hash | 等待在线提交 | Client/service | PARTIAL | P5 |
| O08 | 回拨、异常前跳、未来 `verified_at` 或无可信时间源时安全降级或 fail closed | 服务端时间、单调钟、异常证据 | 重认证或重检 | Reader/service | TARGET | P2/P4 |

### 5.6 连续性、审计与可解释性

| ID | 不变量 | 必须验证的证据 | 失败行为 | 执行位置 | 当前状态 | 归属阶段 |
|---|---|---|---|---|---|---|
| U01 | 授权 Session 先 Resume，再执行，再 Checkpoint | Session/Checkpoint Receipt | 写入拒绝 | Service | ENFORCED_CANONICAL | P5 验收 |
| U02 | State、Task、Decision、Archive、Log 按字段权威分工 | Sources Read、Field Authority | 冲突显式返回 | Service/reader | ENFORCED_CANONICAL | P4/P5 |
| U03 | Log 只作事件证据，不能覆盖当前状态 | Event/Projection 关系 | 不采纳旧日志 | Service/reader | ENFORCED_CANONICAL | P4 验收 |
| U04 | 重要操作记录 Target、Actor、Version、Result、Evidence、Error | Audit Event | 操作不算完整 | Service | ENFORCED_CANONICAL | P5 验收 |
| U05 | 权威回答返回 `sources_read` 和来源版本 | Source Envelope | 不得标 authoritative | Response layer | PARTIAL | P2/P4 |
| U06 | 撤回与矛盾保留，不静默覆写 | Retraction/Supersede Event | 阻断无历史覆盖 | Service | ENFORCED_CANONICAL | P5 验收 |
| U07 | Agent、用户、服务账号与自动化 Actor 可区分 | Actor Type、Binding、Workspace | 审计失败 | Service | ENFORCED_CANONICAL | P5 验收 |

## 6. 重复与热点矩阵

状态枚举：`BASELINE_KEEP`、`ELIGIBLE_WITH_EVIDENCE`、`TARGET_ROUTING_CHANGE`、`BLOCKED_NO_EVIDENCE`。每个允许优化的 D 项必须同时列出正向和负向证据，否则为 `BLOCKED_NO_EVIDENCE`。

| ID | 当前重复或热点 | 分类 | 允许的优化 | 必须保留 | 失效条件 | 保护不变量 | 正向证据 | 负向证据 | 当前状态 | 目标阶段 |
|---|---|---|---|---|---|---|---|---|---|---|
| D01 | AGENTS 与 pull 各查一次 Remote Head | 真重复 | 统一 `align-and-verify` 查询一次 | 每个需远端新鲜度的请求至少一次查询 | 新请求 current、TTL 到期、重试 | G01 | F01 | F02、F04 | ELIGIBLE_WITH_EVIDENCE | P1 |
| D02 | AGENTS 与脚本都可能 fetch/merge | 真重复 | 统一入口负责 fetch；读取走隔离 Mirror | Commit、ancestor、divergence | Ref、Repo 身份、fetch 结果变化 | G03、G05、G06 | F02 | F03、F04 | ELIGIBLE_WITH_EVIDENCE | P1/P3 |
| D03 | 源与目标都哈希 Manifest 全部文件 | 表面重复 | 不合并 | 两个信任边界的独立完整性 | 不适用 | S02、S04、S05、S06 | F05 | F06 | BASELINE_KEEP | 保持 |
| D04 | Mirror 验证后 doctor 再哈希 | 条件重复 | doctor 验证请求内 Context | 首次目标完整校验 | 路径、目录、代次、权限、时间、内容变化 | S05、G07 | F07 | F27 | ELIGIBLE_WITH_EVIDENCE | P2 |
| D05 | doctor 后 recall/status 再验证 Bundle | 条件重复 | 显式传入请求内 Context | 无有效 Context 时完整校验 | Snapshot、Manifest、Validator、目录身份变化 | S02、U05 | F07 | F27、F31 | ELIGIBLE_WITH_EVIDENCE | P2 |
| D06 | Recall 扫描所有项目三视图 | 不必要工作 | Index/Routes 解析项目后精确读取 | Index 来源、目标存在、歧义回退 | Index 错误、歧义、历史请求 | S15、U02 | F20 | F20、F21 | TARGET_ROUTING_CHANGE | P4 |
| D07 | T1 零匹配文件仍进入结果 | 不必要工作 | 只读命中区段；无匹配转 T3 | 最小化、来源记录、歧义升级 | 权限、索引或意图变化 | A05、U05 | F21 | F20、F21 | TARGET_ROUTING_CHANGE | P4 |
| D08 | 每次只读都同步 Git | 架构热点 | 在线 current 直读 Canonical；Git 仅离线/审计 | Auth、Scope、Canonical Version | Online→Unavailable 或显式 Snapshot Audit | A01、O01、O05 | F10 | F11、F12 | TARGET_ROUTING_CHANGE | P4 |
| D09 | 请求内重复核对 VERSION、Tag、Manifest、Pointer | 条件重复 | 一次生成 Version Envelope | 四方一致性检查 | 任一组成变化 | G01、S07、S11 | F30 | F08、F30 | ELIGIBLE_WITH_EVIDENCE | P2 |
| D10 | Snapshot 未变仍复制并生成 Backup | 条件重复 | 同身份与有效目标证据时 no-op | 目标身份与完整性 | 路径/卷/目录/代次/权限/Manifest 变化 | G07、G09、G10 | F27 | F27、F32 | ELIGIBLE_WITH_EVIDENCE | P3 |
| D11 | Resume 授权与每次写授权 | 表面重复 | 不合并 | 请求时 Scope 与撤销校验 | 不适用 | A04、A05 | F22 | F22 | BASELINE_KEEP | 保持 |
| D12 | 服务层租户检查与 RLS | 表面重复 | 不合并 | 两层纵深防御 | 不适用 | A06、A07 | F24 | F24 | BASELINE_KEEP | 保持 |
| D13 | CAS 预检与提交点 CAS | 表面重复 | 预检仅早失败 | 事务提交点 CAS | 不适用 | C01、C02 | F15 | F28 | BASELINE_KEEP | 保持 |
| D14 | 应用幂等查询与 DB 唯一约束 | 表面重复 | 应用层可优化体验 | DB 唯一约束与 Payload Hash | 不适用 | C03、C04 | F16 | F17 | BASELINE_KEEP | 保持 |
| D15 | Mutation 后 Event 与 Receipt | 表面重复 | 不合并 | Event 表示变化，Receipt 证明结果 | 不适用 | C05、C06 | F16 | F18 | BASELINE_KEEP | 保持 |
| D16 | 发布前与发布后读回校验 | 表面重复 | 不合并 | 输入防错与传输/切换防错 | 不适用 | S09、S11、S12 | F19 | F19 | BASELINE_KEEP | 保持 |
| D17 | Session 内重复解析 Token Claim | 条件重复 | 缓存已验证的解析结果 | 每次在线请求校验 Binding、Scope、Policy、Expiry、Revocation | 任一授权字段或 Epoch 变化 | A04、A05、A08 | F22 | F12、F22 | ELIGIBLE_WITH_EVIDENCE | P2/P5 |
| D18 | 同一不可变 Mirror 多次完整验证 | 条件重复 | 请求内复用内容与目录身份绑定的证据 | 首次进入边界完整验证 | 可写、路径重解析、目录/ACL/内容/版本变化 | S04、S05、G07 | F07 | F27 | ELIGIBLE_WITH_EVIDENCE | P2/P3 |
| D19 | Git 对齐与在线 Canonical 查询同时进行 | 非等价来源 | current 以 Canonical 为准；按需使用 Git | 在线权限与版本 | Online→Unavailable 或 Snapshot Audit | A01、O01、O05 | F10 | F11、F12 | TARGET_ROUTING_CHANGE | P4 |
| D20 | Git Divergence 与 Canonical CAS 都称“冲突” | 非等价冲突 | 分离错误类型和证据 | 两类冲突均保留 | 不适用 | C02、C11、G06 | F28 | F28 | TARGET_ROUTING_CHANGE | P5 |
| D21 | Log 与 State/Task/Decision 投影 | 表面重复 | 不合并为日志控制面 | Event 证据和字段权威投影 | 不适用 | U02、U03 | F26 | F26 | BASELINE_KEEP | 保持 |
| D22 | Canonical 后再写 Markdown/Git | 禁止双写 | 删除第二业务写 | Mutation、Event、Receipt | 不适用 | A02、C05、S01 | F29 | F29 | TARGET_ROUTING_CHANGE | P5 |
| D23 | 各命令重复计算 Freshness | 条件重复 | 请求内统一计算截止时间 | 所有 TTL 输入 | 时间、Session、Policy、Recheck 变化 | O02、O03、O04、O08 | F13、F14 | F25 | ELIGIBLE_WITH_EVIDENCE | P2 |
| D24 | 各响应重复组装来源与审计字段 | 条件重复 | 从 Context 生成统一 Source Envelope | 最终响应字段完整 | Context 或来源变化 | U04、U05 | F31 | F31 | ELIGIBLE_WITH_EVIDENCE | P2 |

## 7. Request-local Verification Context

Verification Context 是一次请求内已执行校验的结构化证据，不是持久 PASS，也不能替代 Canonical 提交点校验。

### 7.1 模式与 Schema

Context 的 `mode` 只允许以下七值：

```text
READ_ONLINE_CURRENT
READ_SNAPSHOT_LKG
READ_SNAPSHOT_HISTORICAL
WRITE_CANONICAL
SNAPSHOT_PUBLISH
REPO_IMPLEMENT
AUDIT_FULL
```

`NONE` 是第八种路由模式，但不生成 Verification Context，只输出可审计的零读取证明。

```json
{
  "verification_id": "opaque-request-local-id",
  "mode": "one-of-seven-context-modes",
  "verified_at": "RFC3339",
  "effective_expires_at": "RFC3339",
  "repository": {
    "remote_head": "commit-sha-or-not-applicable",
    "local_head": "commit-sha-or-not-applicable",
    "repository_identity": "opaque-repository-id",
    "worktree_clean": true
  },
  "snapshot": {
    "snapshot_version": "opaque-version",
    "canonical_version": "opaque-version",
    "manifest_sha256": "sha256",
    "manifest_file_count": "from-manifest",
    "current_pointer_hash": "sha256",
    "integrity": "full_pass",
    "views_complete": true,
    "source_verification": "live_rechecked",
    "live_rechecked_at": "RFC3339",
    "target_canonical_path": "normalized-path",
    "target_path_identity": "opaque-volume-and-directory-id",
    "mirror_generation": "opaque-generation"
  },
  "authorization": {
    "subject_ref": "scoped-opaque-ref",
    "organization_ref": "scoped-opaque-ref",
    "workspace_ref": "scoped-opaque-ref",
    "binding_id": "opaque-id",
    "scope_hash": "sha256",
    "policy_version": "opaque-version",
    "revocation_epoch": "opaque-version",
    "session_expires_at": "RFC3339"
  },
  "validator": {
    "contract_version": "opaque-version",
    "doctor_version": "opaque-version",
    "result": "pass"
  },
  "sources": {
    "sources_read": ["opaque-source-id"],
    "source_versions": ["opaque-version"],
    "freshness": "current-or-degraded-or-historical",
    "degraded_reason": "nullable-error-class"
  }
}
```

不得把邮箱、Token、Client Secret、原始 Supabase User ID 或可直接识别用户的映射写入 Context。

### 7.2 复用边界

| 范围 | 决策 | 条件 |
|---|---|---|
| 同一函数调用 | 允许 | 输入对象不可变 |
| 同一请求 | 有条件允许 | 七条资格规则全部满足 |
| 同一 Agent Session | 禁止 | 新请求重新建立 Context |
| 跨请求 | 禁止 | 不持久化 PASS |
| 跨进程 | 禁止 | 未来 ADR 前不实现 |
| 跨设备/跨 Agent | 禁止 | 各自认证并取得独立证据 |
| Canonical 写入提交点 | 禁止用缓存替代 | 服务端重新执行授权、CAS、幂等与事务校验 |

### 7.3 失效检测合同

请求内复用必须绑定相同的规范路径解析结果、目标目录/卷身份、Mirror Generation、Manifest SHA 与 Snapshot Version。以下任一事件立即失效：

- Remote/Local Head、Manifest、Current Pointer、Snapshot Version 或 Version Envelope 任一组成改变。
- 目标可写、ACL/只读属性变化、路径重解析、Junction/Symlink 目标变化、换卷或目录替换。
- User、Organization、Workspace、Context Key、Binding、Role、Scope、Purpose、Policy Version 或 Revocation Epoch 变化。
- Session、策略 TTL 或降级 TTL 到期；时钟不可信。
- Validator、Doctor、Schema、Generator Version 改变。
- 上游返回 Auth、Scope、Owner、Hash、CAS、Divergence 或 Partial Publish 错误。
- 任一组件无法证明输入身份相同。

不得只使用 mtime、size 或文件系统事件作为完整性证据。文件事件、NTFS USN Journal 等只能提前使证据失效，不能证明内容未变。无法可靠取得目录身份时，重新运行完整 `validate_bundle()`。哈希必须流式处理；内容寻址增量校验在未来阶段满足完整等价证明前不得替代当前完整校验。

## 8. Freshness、撤销和离线降级合同

### 8.1 Freshness

至少使用以下输入：

```text
effective_expires_at = min(
  session_expires_at,
  live_rechecked_at + selected_policy_ttl,
  degraded_expires_at when degraded
)
```

任何输入未知、策略不受支持或时间源不可信时 fail closed。可信服务端时间可用时优先使用。时间计算为：

```text
stale_age = max(0, trusted_now - verified_at)
```

时钟回拨、异常前跳、`verified_at` 晚于可信服务端时间或无法取得可靠时间源，都必须 fail closed 或进入明确的安全降级；不得输出负的 Stale Age。

### 8.2 在线撤销

在线请求每次由服务端校验 Binding 状态、Scope、Role、Policy Version、Expiry 与 Revocation Epoch。任何 `DENIED` 立即进入 `LOCKED`，不得使用 Session 缓存或 LKG 绕过。离线快照只证明导出时授权，不证明当前授权仍然有效。

### 8.3 离线降级

只有明确 `UNAVAILABLE` 可进入 LKG 只读降级。Auth、Forbidden、Scope、Owner、Hash、CAS、Divergence 与 Partial Publish 错误均不得降级绕过。降级输出必须包含 Verified At、Stale Age、Reason、Snapshot Version、Canonical Version 与 `sources_read`；离线写入只能创建 Pending Intent/Outbox，不得标记为成功。

## 9. T0–T4 确定性路由

| 模式 | 触发 | 必做校验/读取 | 禁止行为 |
|---|---|---|---|
| `NONE` | T0 通用非个人请求 | Router 判定与零读取证明 | 网络、Git、Memory 读取；不生成 Context |
| `READ_ONLINE_CURRENT` | T1/T2 current、最新待办、在线 Recall | Auth、Binding、Scope、Tenant、Canonical Version、Source Envelope | 为 current 强制同步 Git |
| `READ_SNAPSHOT_LKG` | 服务明确不可用后的只读降级 | Integrity、Scoped Owner Ref、Policy、TTL、Session、Degraded Envelope | 权威写入、无限定语 current |
| `READ_SNAPSHOT_HISTORICAL` | 历史审阅、离线旧资料 | Integrity、Owner、Snapshot Version、Historical 标记 | 报告为 current |
| `WRITE_CANONICAL` | T4 或权威 Mutation | Resume、Auth、Scope、CAS、幂等、事务、Event、Receipt、Checkpoint | Markdown/Git 双写 |
| `SNAPSHOT_PUBLISH` | Export、M2 Cutover | Export Receipt、确定性构建、源/目标哈希、Expected-Current CAS、Pointer、Byte-match | 用普通读取证据替代发布门禁 |
| `REPO_IMPLEMENT` | 修改代码或文档 | Remote Ref、ancestor、工作树边界、相关测试 | 与 Memory 无关时强制 Mirror/Doctor |
| `AUDIT_FULL` | 安全/发布/完整性审计 | 全部相关权威源、完整证据链、全量校验、负测 | 用过期或局部证据冒充完整审计 |

T1 确定性读取：身份与稳定偏好只读 Index 命中的 Profile 区段；跨会话工作先解析 Canonical Project ID，再读该项目 State/Task/Decision；历史证据才扩展 Archive/Log；无匹配转 T3，只读 Global State/Task/Decision；冲突时返回候选与来源，不自行猜测。每次权威读取保留 `access_tier`、`access_reason`、`selector`、`canonical_project_id`、`sources_read`、`source_versions` 和 `expansion_reason`。

## 10. D→F 可追踪验收矩阵

每个 F ID 是一个可自动化的测试组；含“控制”与“故障”时，两者必须同时执行。引用必须使用完整 ID，不使用含义不明的混合编号。

| ID | 覆盖项 | 场景 | 预期结果 | 保护的不变量 |
|---|---|---|---|---|
| F01 | D01 | 同请求 Remote Head 未变 | 只查询一次，结果与旧路径一致 | G01 |
| F02 | D01、D02 | Remote Ahead、开发工作树 clean | 隔离 Mirror 更新，不隐式改工作树 | G03、G05、G07 |
| F03 | D02 | Remote Ahead、开发工作树 dirty | Mirror 可更新，不混入本地修改 | G03、G04 |
| F04 | D01、D02 | Local/Remote 真分叉 | 生成 Conflict Packet，不自动合并 | C11、G06 |
| F05 | D03 | 源文件哈希错误 | 复制前阻断 | S02、S03、S04 |
| F06 | D03、D04 | 复制中单文件损坏 | 目标校验失败，旧 LKG 保持 | S05、S06、G07 |
| F07 | D04、D05、D18 | 控制：请求内未变化；故障：doctor 后篡改文件 | 控制可复用；故障使 Context 失效并重校验/阻断 | S02、S05、G07 |
| F08 | D09 | Manifest 不变但 Pointer 改变 | Version Envelope 失效并重算 | S09、S10、S11、S12 |
| F09 | S14 | Owner/Tenant Ref 不匹配 | 完全拒绝读取 | A03、S14 |
| F10 | D08、D19 | 在线 Canonical 可用 | current 不依赖 Git 快照 | A01、O01 |
| F11 | D08、D19 | `UNAVAILABLE` 且 LKG 有效 | 只读降级并返回完整 Envelope | O03、O04、O05、O06、O07 |
| F12 | D08、D17、D19 | Auth/Scope/Binding 失败 | 不用 LKG 绕过，直接拒绝 | A04、A05、A08、O05 |
| F13 | D23 | 控制：TTL 内；故障：三种 TTL 分别超时或未知策略 | 控制有效；故障拒绝 current | O02、O03、O04 |
| F14 | D23 | Session 到期早于 LKG | 截止取 Session 到期 | O04 |
| F15 | D13 | 两 Agent 同 Base 并发写 | 仅一方成功，另一方 CAS Conflict | C01、C02 |
| F16 | D14、D15 | 同 Idempotency Key、同正文重试 | 返回同一结果，不重复 Event/Receipt | C03、C05 |
| F17 | D14 | 同 Idempotency Key、不同正文 | 拒绝并审计 | C04 |
| F18 | D15 | Event 或 Receipt 写入失败 | Mutation 全部回滚 | C05、C06 |
| F19 | D16 | 发布中途失败 | Pointer 不变，旧版本可读 | S09、S10、S11、S12 |
| F20 | D06、D07 | 控制：有效 Index 命中；故障：Index 指向不存在对象 | 控制精确读；故障不接受索引并回退/阻断 | S15、U02 |
| F21 | D06、D07 | 控制：T1 唯一命中；故障：T1 无命中 | 控制最小读；无命中转 T3，不扫描全部项目 | A05、U05 |
| F22 | D11、D17 | 控制：Binding 有效；故障：已撤销但 Session 缓存仍在 | 控制通过；撤销后下一在线请求拒绝 | A04、A08 |
| F23 | A03 | Workspace A 切到 B | 原 Context 失效 | A03、A06 |
| F24 | D12 | 跨租户伪造 Project/Record ID | 服务层与 RLS 均拒绝并审计 | A06、A07 |
| F25 | D23 | 时钟回拨、异常前跳、未来 `verified_at`、无可信时间源 | Stale Age 不为负；fail closed 或安全降级 | O08 |
| F26 | D21 | 旧 Log 与 Canonical State 冲突 | 输出 Canonical 当前值并报告冲突 | U02、U03、U06 |
| F27 | D04、D05、D10、D18、P16 | 控制：同路径身份；故障：字段不变但 Junction、换卷或目录替换 | 控制可 no-op；故障证据失效并完整校验 | S05、G07 |
| F28 | D13、D20 | 同时制造 Git Divergence 与 Canonical CAS Conflict | 返回不同错误类型和证据；均不自动合并或覆盖 | C02、C11、G06 |
| F29 | D22 | 控制：Canonical Mutation；故障：调用退休 Markdown/Git 写入口 | 控制原子成功；退休入口 fail closed 且 Canonical/快照不变 | A02、C05、S01 |
| F30 | D09 | 控制：四方未变；故障：分别只改 VERSION、Tag、Manifest、Pointer | 控制可复用；任一变化使 Envelope 失效 | G01、S07、S11 |
| F31 | D05、D24 | 控制：Source Envelope 完整；故障：缺 Sources Read、版本、Freshness 或 Degraded 状态之一 | 控制可 authoritative；缺字段不得 authoritative | U04、U05 |
| F32 | D10、G09、G10 | 两 Agent 同机并发更新同一 Mirror，并触发 Backup | 串行或幂等，无交叉污染；保留受策略控制并可审计 | G09、G10 |

等价验收门槛：旧正向用例继续通过；旧负向用例继续拒绝；F01–F32 全部通过；相同输入的 Canonical Version、Snapshot Version、授权范围和业务结果一致；拒绝日志、Receipt、Sources Read 与冲突证据不减少；Shadow 期间不存在未解释的“旧拒绝、新接受”。

## 11. P0–P6 阶段、入口和完成门禁

### 11.1 文档修订门禁 R0–R5

| 阶段 | 内容 | 完成证据 |
|---|---|---|
| R0 | 修复 P01、P02、P03、P05、P08 | Mode 集合一致；Freshness 输入完整；分类定义齐全；P1/P3 无循环依赖 |
| R1 | 修复 P04、P20；增加 F27–F32 与 D→F 追踪 | 每个可优化 D 项有正/负证据；测试引用是明确 ID；P0 是产物门禁 |
| R2 | 修复 P07、P10、P11、P13、P14、P15、P16 | 请求内边界、撤销、Scoped Ref、并发/保留、时钟与路径负测明确 |
| R3 | 修复 P06、P09、P18、P19 | 不变量有现状/阶段；私有例外标明；链接固定；候选身份不冒充 Gate |
| R4 | 修复 P12、P17 | P0 拆分成本；冷/热及成功/失败分开；流式哈希与受门禁增量路线明确 |
| R5 | 第二轮静态审查 | 结构、围栏、表格、ID、Mode、D→F、阶段、链接和现状/目标态检查通过 |

P01–P20 的候选版裁决与落点：

| 问题 | 裁决 | v1.1 落点 | 状态 |
|---|---|---|---|
| P01 | 完全采纳 | §4 规则 4 | CLOSED |
| P02 | 完全采纳 | §7.1、§9；七种 Context mode + `NONE` 零 Context | CLOSED |
| P03 | 完全采纳 | §7.1、§8.1 | CLOSED |
| P04 | 完全采纳并扩展 | §6、§10，新增 F27–F32 | CLOSED |
| P05 | 完全采纳 | §11.3，P1/P3 门禁分离 | CLOSED |
| P06 | 采纳并区分现状 | §3、A09、§12 | CLOSED |
| P07 | 采纳问题并收紧范围 | §7.2、§14；跨进程复用禁止并移交未来 ADR | CLOSED |
| P08 | 完全采纳 | §4.1、§4.2 | CLOSED |
| P09 | 完全采纳 | §5 全表 | CLOSED |
| P10 | 采纳并收紧 | §7.3、D04、D18、F27 | CLOSED |
| P11 | 完全采纳 | G09、G10、F32 | CLOSED |
| P12 | 采纳为待测假设 | §11.2；不预设收益阈值 | CLOSED_FOR_DOCUMENT；P0 待另行授权 |
| P13 | 完全采纳 | §8.2、D17、F22 | CLOSED |
| P14 | 完全采纳 | S14、§12 | CLOSED |
| P15 | 完全采纳 | O08、§8.1、F25 | CLOSED |
| P16 | 完全采纳 | §7.1、§7.3、D10、F27 | CLOSED |
| P17 | 采纳为演进项 | S04、§7.3、§14 | CLOSED_FOR_DOCUMENT；实现受后续门禁约束 |
| P18 | 完全采纳 | §15 固定 Commit 链接；非仓库来源显式标记身份缺口 | CLOSED_FOR_CANDIDATE |
| P19 | 完全采纳 | §1、§12；候选版不冒充 Gate | CLOSED_FOR_CANDIDATE；入库身份是升级门禁 |
| P20 | 完全采纳 | 文首基线口径、§6、§10、§11.2 | CLOSED |

只有 R0–R5 全部通过，本候选版才可成为 P0 的输入；进入 P0 仍需用户另行授权。

### 11.2 P0：外部只读 Benchmark Harness

P0 新增独立外部 Harness，包装现有命令，不修改被测命令、环境配置、快照或工作树。采集 Remote Head 查询、fetch/merge、进程启动、流式哈希、复制、原子切换、Backup、退出码、错误类型和阻断位置。无法从外部可靠测量的指标标记 `UNOBSERVABLE`，不得为取数修改旧核心。

场景至少覆盖：T0、T1、T2、T3、latest/current、Snapshot Audit、Memory 无关实现请求、Remote 未变、Remote Ahead、脏工作树、网络 `UNAVAILABLE`、Manifest/目标损坏。每个场景执行 cold/warm 多轮，分开成功/失败路径，报告 p50、p95、调用次数和阶段占比。

P0 交付物门禁：原始结果、汇总报告、`调用 → 不变量 ID → 证据` 映射、网络/进程/哈希/复制/切换成本占比、实测分类、局限与 `UNOBSERVABLE`、P1 优先级建议。P0 不执行 P1。

### 11.3 P1–P6

| 阶段 | 目标 | 完成门禁 |
|---|---|---|
| P1 | 统一 `align-and-verify`，消除重复远端查询，不减少校验 | F01、F05、F06 + 旧回归全绿 |
| P2 | 请求内 Verification Context | F07、F08、F09、F25、F27、F30、F31；不存在旧拒绝/新接受 |
| P3 | 隔离 Mirror、同机串行、Backup 策略 | F02、F03、F04、F27、F32 |
| P4 | Canonical-first 与确定性 T1 | F10–F14、F20、F21；召回黄金集无回归 |
| P5 | 多用户、团队、企业隔离与并发写 | F15–F18、F22–F24、F28、F29 |
| P6 | Shadow、Canary、发布与回滚 | F19、F26；全部等价验收门槛通过 |

各阶段必须分别授权。v1.1 通过不等于自动授权 P0–P6。

## 12. 隐私、Scoped Owner Ref 和文档身份

Scoped Owner Ref 合同：

1. Canonical Store 保存全局 Owner 身份，但不向 Bundle 暴露原始身份。
2. 服务端依据当前 Binding、Scope 与导出范围产生 Scoped Opaque Ref。
3. Export Receipt 与 Manifest 使用同一个 Scoped Ref。
4. 读取方从当前授权上下文取得期望 Scoped Ref，再与 Manifest 比对。
5. 本地不保存 `Scoped Ref → 邮箱/全局 User ID` 映射。
6. 不同组织、Scope 或导出范围的 Ref 不得直接关联。

具体密码学派生方式由未来协议 ADR 决定，本版不写死。当前私有 `AGENTS.md` 中的账号提示与稳定 Owner Ref 是受控存量例外；公开/共享前必须移入私有配置或替换为服务端下发的 Scoped Ref。本候选版不授权立即修改 `AGENTS.md`。

正式 Gate Baseline 必须位于授权仓库路径并绑定 Commit 与 Git Blob SHA。正文不嵌入自身递归 SHA；候选版的外部文件哈希仅用于交付校验，不替代 Git 身份。

## 13. 禁止优化清单

- 因当前只有一个用户快照而移除租户、Workspace、Binding 或 Scope 校验。
- 只校验 Manifest JSON，不校验其枚举文件内容。
- 用源校验替代复制后目标校验。
- 仅凭 mtime、size、file watcher 或 USN Journal 证明内容完整。
- 用 Resume 时的授权结果替代下一在线请求的撤销、Scope 与 Policy 检查。
- 删除数据库 CAS 或唯一约束，只相信 Agent 不并发或重试。
- 将 Event、Receipt 与 Audit 合并为不可区分日志。
- 在线服务不可用时把过期 Snapshot 称为 current。
- Auth、Forbidden、Owner Mismatch 时用 LKG 绕过。
- 自动选择 Git Local/Remote 或混淆 Git Divergence 与 Canonical CAS Conflict。
- Canonical 成功后执行 Markdown/Git 第二业务写。
- 跨请求、跨进程、跨设备或跨 Agent 持久复用 Verification Context。
- 在无 Shadow、负向和故障注入证据时替换生产路径。

## 14. 非目标与未来 ADR

本版不授权：修改仓库或 `main`；修改 `AGENTS.md`、`memory.py`、`sync-memory.py`、`sync-memory.ps1`；修改 Canonical Store、Worker、MCP、OAuth、数据库或 RLS；重建、发布或切换 Snapshot；Commit、Push、Tag、PR、Release 或部署；删除完整校验；执行 P0；实现跨请求/进程/设备/Agent 的证据复用。

未来 ADR 至少覆盖：跨进程 Context 的 Issuer、Signature、Key Ref、Trust Boundary、签名范围、撤销、时钟、密钥轮换和 Mirror 不可变性；Backup 的 N/T、Legal Hold、Erasure 与审计策略；内容寻址增量校验的完整等价证明；Scoped Ref 的密码学派生协议。

## 15. 固定版本参考基线

- [`AGENTS.md@9f0e171`](https://github.com/tdoljyj/cross-memory-system/blob/9f0e171b350b9dd462fc3ce184dd6ddb45ea4689/AGENTS.md)
- [`memory.py@9f0e171`](https://github.com/tdoljyj/cross-memory-system/blob/9f0e171b350b9dd462fc3ce184dd6ddb45ea4689/memory.py)
- [`sync-memory.py@9f0e171`](https://github.com/tdoljyj/cross-memory-system/blob/9f0e171b350b9dd462fc3ce184dd6ddb45ea4689/sync-memory.py)
- [`sync-memory.ps1@9f0e171`](https://github.com/tdoljyj/cross-memory-system/blob/9f0e171b350b9dd462fc3ce184dd6ddb45ea4689/sync-memory.ps1)
- [`memory/manifest.json@9f0e171`](https://github.com/tdoljyj/cross-memory-system/blob/9f0e171b350b9dd462fc3ce184dd6ddb45ea4689/memory/manifest.json)
- `Clued_校验不变量与去重矩阵_v1.0.md`（2026-08-26，本地审查输入）
- `Clued_校验不变量与去重矩阵_v1.0_审查报告.md`（2026-08-26，本地审查输入）
- [`Clued_单一数据源与两级五视图架构方案_v1.6@9f0e171`](https://github.com/tdoljyj/cross-memory-system/blob/9f0e171b350b9dd462fc3ce184dd6ddb45ea4689/docs/clued-two-level-views/Clued_%E5%8D%95%E4%B8%80%E6%95%B0%E6%8D%AE%E6%BA%90%E4%B8%8E%E4%B8%A4%E7%BA%A7%E4%BA%94%E8%A7%86%E5%9B%BE%E6%9E%B6%E6%9E%84%E6%96%B9%E6%A1%88_v1.6.md)
- `Clued Product Continuity Contract`（`version: NOT_PROVIDED`；`location: NOT_PROVIDED`；源输入仅提供名称，取得不可变身份前不得作为 Gate 证据）
- `Clued Vendor-Neutral Agent Contract`（`version: NOT_PROVIDED`；`location: NOT_PROVIDED`；源输入仅提供名称，取得不可变身份前不得作为 Gate 证据）

## 16. 当前唯一下一步

> R0–R5 第二轮静态审查已通过。现在等待用户另行授权其入库身份或 P0 外部只读测量；在此之前不进入实现路径。
