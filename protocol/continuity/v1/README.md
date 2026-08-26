# Clued Continuity 跨厂商导入导出协议 v1

- 协议标识：`clued.continuity-import-export@1.0.0`
- 状态：`FUTURE_CAPABILITY_CONTRACT`
- 实现状态：`UNIMPLEMENTED`（仅冻结边界，不声明功能已上线）
- 适用范围：Clued 原生导出、可移植导出、厂商适配导出、审计导出，以及所有外部来源导入
- 基线：Clued v1.6 单一 Canonical Store、两级五视图、Event + Receipt、认证与 RLS

本文使用 **MUST / MUST NOT / SHOULD / MAY** 表示强制、禁止、建议与可选要求。

## 0. 与现有能力的关系

1. 生产 Supabase（经认证 Clued API/MCP）仍是唯一在线 Canonical Store。
2. 现有 `clued.user-memory-bundle@1.0.0` 是 Clued 原生单用户结构化 Bundle 的已实现基础；其现有 Schema、导入证据和兼容性不由本文原地改写。
3. 仓库 `memory/` 是 Manifest 管理的只读单用户快照/golden sample，不是导入暂存区、运行时多租户数据面或业务写入口。
4. 本协议冻结的是未来通用能力。除非另有版本化实现与验收证据，不得声称厂商 Adapter、通用两阶段导入、四级导出或补偿回滚已经可用。
5. 本协议不假设存在行业统一的厂商记忆格式。厂商格式只在 Adapter 边界内出现，Clued 的内部合同保持厂商中立。

## 1. 术语

- **Canonical Store**：唯一在线生产事实源。
- **Native Bundle**：Clued 版本化的原生结构化可携带快照；现有基础为 `clued.user-memory-bundle@1.0.0`。
- **Source Package**：上传或接收的原始输入，如 ZIP、JSON、Markdown 或厂商导出目录。
- **Adapter**：只负责识别和解析某一来源格式的边界组件。
- **Candidate**：尚未获得 Canonical 权威的厂商中立候选项。
- **Import Plan**：prepare 阶段生成的、带摘要且可审查的确定性写入计划。
- **Commit Unit**：一次数据库事务内全成或全败的最小导入单元。
- **Import Receipt**：描述导入结果、来源、授权、版本和逐项处置的不可变回执。
- **Compatibility View**：为人或特定厂商生成的派生视图，不是 Canonical Store。
- **Subject Binding**：将可携带数据绑定到导出主体或目标所有者的隐私保护声明；不得等同于在 Bundle 中暴露原始账号、令牌或 service-role 凭据。

## 2. 九条冻结规则

### R1. Canonical Store 是唯一生产真相；Native Bundle 是原生可携带格式

1. 任何导出文件、仓库快照、Markdown、厂商包、缓存和索引都 MUST NOT 成为第二个在线事实源。
2. Native Bundle MUST 是版本化、可校验、在声明范围内可重放的结构化快照；它不是生产权威，也不是 Clued 唯一访问路径。
3. 导入成功后产生的新事实只以 Canonical Store 中已提交的 Canonical 对象、Event 和 Receipt 为准。
4. 对“无损”的声明只能相对于明确的导出范围和合同字段成立；不得把敏感字段、审计数据或未授权范围的有意省略描述为绝对无损。
5. `memory/` MUST 保持只读派生物；禁止从 Markdown 或仓库快照反向直写 Canonical Store。

### R2. 导出分四级，并显式声明完整性

实现 MUST 区分以下导出模式：

| 模式 | 主要用途 | 默认可回导性 | 权威性 |
|---|---|---:|---|
| Native Bundle | Clued 备份、迁移、确定性重放 | 是，受版本与范围约束 | 非生产权威 |
| Portable Markdown | 人工阅读、跨工具提示/粘贴 | 否；必须视为有损 | 派生视图 |
| Vendor Export | 面向指定厂商的兼容包 | 仅在对应 Adapter 合同内 | 派生视图 |
| Audit Export | 审计、合规、问题复盘 | 默认不得作为当前业务事实回导 | 历史证据 |

每次导出 MUST 在 Manifest 或不可分离的 Export Receipt 中声明：

- `export_mode`、`contract`、`contract_version`、`created_at`；
- `scope`、隐私保护的 `subject_binding`、来源 Canonical 版本；
- `lossless`：仅表示声明范围内的可回导业务字段与关系是否完整；
- `views_complete`：仅表示声明范围内的派生视图是否完整；
- `omissions[]`：每项省略的类别、原因和影响；
- Manifest、文件摘要、计数与生成器版本。

Portable Markdown 和未经逐字段证明的 Vendor Export MUST 设置 `lossless=false`。  
现有 Bundle v1 Schema 没有上述全部字段；实现时 MUST 通过新的版本化 Schema 或不可分离的版本化 Receipt 增加，禁止静默改变 `1.0.0` 的含义。

### R3. 厂商 Adapter 只能生成候选项，不能写 Canonical Store

1. Adapter MUST 只执行格式识别、解包、解析、规范化和诊断，输出厂商中立的 Candidates。
2. Adapter MUST NOT 持有 Canonical 写权限、生产 service-role 凭据或直接数据库访问能力。
3. 厂商字段 MUST 在 Adapter 边界终止；Canonical Schema 不得出现依赖某一厂商的必填业务字段。
4. 每个 Candidate SHOULD 包含来源项 ID/路径、内容摘要、候选类型、时间信息、置信度、敏感度、建议作用域和 Evidence 引用。
5. 无法可靠映射的内容 MUST 进入 `manual_review`、`evidence_only` 或 `rejected`，不得猜测后自动写入。
6. Adapter 升级 MUST 版本化；同一 Source Package 使用不同 Adapter 版本所得差异必须可比较和可审计。

### R4. 所有导入必须经过 prepare → commit 两阶段

#### Prepare

Prepare MUST 是无业务写入的 dry-run，并完成：

- 安全解包、文件类型/大小/数量限制、恶意内容与路径穿越检查；
- Schema/合同版本、Manifest、摘要、计数和可选签名验证；
- 来源识别、Adapter 选择、owner/subject binding、目标 scope 与授权预检查；
- 规范化、去重、冲突分类、敏感数据分类和保留策略判定；
- 生成带 `plan_digest` 的 Import Plan、逐项 disposition、预期计数和风险提示。

Prepare 的成功 MUST NOT 被表述为“已导入”。

#### Commit

Commit MUST 要求：

- 已认证 actor、明确 target owner、最小授权 scope；
- 未过期且摘要一致的 Import Plan；
- 稳定 `import_id` 与 `idempotency_key`；
- `base_canonical_version` 或等价 CAS 条件；
- 再次检查授权、主体绑定、计划摘要和当前版本；
- 仅通过正式 Canonical 写路径提交，并产生 Event、Receipt 与 Audit 证据。

上传文件后直接写数据库、绕过 prepare、由 Adapter 直写、或从 Markdown 反向同步，全部禁止。

### R5. 导入必须原子、幂等、可追踪，但原子边界要真实

1. 每个 Commit Unit MUST 在一个事务内全成或全败；失败不得留下伪成功 Event、Receipt 或半条 Canonical 对象。
2. 对规模受控的 Bundle，实现在资源允许时 SHOULD 提供全包 all-or-nothing 模式。
3. 大批量导入 MAY 分成确定性的 Commit Units。此时 Import Receipt MUST 准确记录 `committed/rejected/pending/failed`，支持幂等续跑；全部完成前不得把整包标为成功。
4. 同一 `import_id + idempotency_key + plan_digest` 的重试 MUST 保持业务结果稳定。审计 Event/Receipt 可以逐请求新增，但不得重复创建业务对象或无故递增版本。
5. CAS 冲突 MUST 与 Git divergence、解析错误、权限错误分开报告；冲突时不得偷偷覆盖当前 Canonical 状态。
6. Import Receipt MUST 至少记录：
   - `import_id`、`idempotency_key`、`plan_digest`；
   - source vendor/product、Source Package 摘要、Adapter ID/版本、协议/Schema 版本；
   - actor、target owner、scope、授权依据、base/result Canonical 版本；
   - 每项来源引用、目标 Canonical ID、处置结果与错误码；
   - 时间戳、计数、保留/删除期限和关联 Event/Receipt ID。

### R6. 不承诺绝对可逆；提交后使用补偿语义

1. Commit Unit 失败 MUST 依赖事务回滚，保持 Canonical Store 不变。
2. 已提交导入不得通过删除历史、回退全库版本或篡改旧 Receipt 来“撤销”。
3. 提交后 MAY 生成 compensating removal/rollback plan：仅对仍满足来源归属、依赖关系和版本前置条件的导入对象执行关闭、归档、替代或其他正式补偿写入。
4. 补偿执行 MUST 使用 CAS、产生新的 Event/Receipt，并保留原导入历史。
5. 若对象已被后续人工修改、被其他对象依赖或无法区分导入贡献，系统 MUST 停止自动补偿并要求人工裁决。
6. UI、文档和 API MUST 使用“补偿”“移除导入影响”等准确用语，不得承诺恢复到任意历史时刻的绝对可逆。

### R7. 原始和修改后的 Bundle 都不能绕过 Import

1. Native Bundle 也必须经过 R4 的 prepare/commit；“Clued 自己导出的”不是跳过认证和校验的理由。
2. 对 Native Bundle，Prepare MUST 校验合同/Schema 版本、Bundle/Manifest 摘要、逐文件哈希、计数、来源版本、scope、subject binding、CAS 和完整性声明。
3. 对仓库 snapshot，还 MUST 验证 `memory/manifest.json.owner_ref`、`snapshot_version`、`canonical_version`、`baseline_claim`、`source_verification`、`views_complete` 与文件哈希。
4. 为避免泄露稳定账号标识，便携 Bundle MAY 不内嵌原始 `owner_ref`；此时 owner 绑定必须由认证导出/导入 Receipt 和 `subject_binding` 完成。未绑定包必须明确标记，并在 Commit 前由已认证用户选择目标 owner，禁止推断。
5. 内容一旦修改，原 Bundle 摘要、身份和可选签名即失效。系统 MAY 将其作为新的不可信 Source Package 重新 prepare，但 MUST NOT 继承原包的完整性或来源背书。
6. 未知的新版本、摘要不符、错误 owner/scope 或缺少必要文件时 MUST fail closed；兼容降级只能由明确版本规则允许。

### R8. 聊天记录首先是 Source/Evidence，不自动等于 Canonical Memory

1. 原始会话、消息、附件和厂商“memory”文本默认归类为 Source/Evidence。
2. Adapter 可以从中提出 Candidates，但不得因内容被提及就自动提升为当前事实。
3. 提升必须映射到现有 Canonical 原语：Project、Record、Evidence、Event，以及 Note/State/Task/Decision/Archive 等正式类型；Profile/Preference 只能进入其指定 Canonical 合同。
4. 提取结果 MUST 保留来源引用、时间、置信度、推断/原文区分和敏感度。
5. 冲突、低置信度、过期事实、第三方个人信息、健康/财务/身份等敏感内容 SHOULD 要求人工确认或保持 `evidence_only`。
6. Log/Event 是已发生操作的证据，不得由聊天摘要伪造为系统已执行事件。

### R9. 多租户、隐私和原始包保留必须先于便利性

1. 所有导入导出 MUST 绑定 owner、context/scope、授权、敏感度、来源和 retention policy。
2. 认证与 RLS MUST 在 Prepare 预检查并在 Commit 再验证；任何跨 owner 访问默认拒绝。
3. Source Package MUST 存放在隔离、加密、不可执行的临时区；文件名、压缩路径和内嵌链接均不得成为可信路径。
4. 原始厂商 ZIP/JSON SHOULD 只保留到配置的安全复核/补偿窗口结束；到期后必须删除原文，除非用户明确选择更长保留或存在合规要求。
5. 删除原始包后，MAY 保留最小必要的内容摘要、来源元数据、Import Plan 摘要、逐项 provenance 和 Import Receipt；不得借“审计”之名无限期保存完整私密会话。
6. 导出默认最小化数据；secret、token、service-role 凭据、内部用户 ID 和未授权第三方数据 MUST 排除或不可逆去标识化。
7. 删除与保留动作本身 SHOULD 有审计证据，但审计证据不得复原已删除的完整私密正文。

## 3. 最小状态机

```text
RECEIVED
  -> PREPARED
  -> AUTHORIZED
  -> COMMITTING
  -> COMMITTED | PARTIALLY_COMMITTED | REJECTED | FAILED

COMMITTED | PARTIALLY_COMMITTED
  -> COMPENSATION_PLANNED
  -> COMPENSATED | COMPENSATION_BLOCKED
```

约束：

- `RECEIVED -> COMMITTED` 的直接跳转禁止。
- `PREPARED` 只证明计划可审查，不证明授权或写入成功。
- `PARTIALLY_COMMITTED` 只允许用于明确采用分块 Commit Units 的导入；必须列出未完成项并可幂等续跑。
- `FAILED` 不得携带成功业务变更；若已有已提交 Unit，整体状态必须是 `PARTIALLY_COMMITTED`。
- 补偿不得改写原状态历史，只追加新状态与证据。

## 4. 互操作边界

1. Clued SHOULD 以 Native Bundle 作为保真度最高的可携带格式，以 Portable Markdown 作为最低共同阅读格式。
2. Vendor Adapter 是可替换模块；导入、授权、冲突处理、Canonical 写入和审计内核不得按厂商分叉。
3. Vendor Export 必须发布支持矩阵：可映射字段、丢失字段、长度/数量限制、附件处理、时间语义和回导限制。
4. “支持某厂商导入/导出”只表示某个已版本化 Adapter 通过验收；不得推导为完整双向、无损或实时同步。
5. 循环 `Clued -> Vendor -> Clued` 不要求字节相等，但必须满足已声明的语义保真度；所有已知损失都要可见。

## 5. 最小验收门禁

未来实现至少必须覆盖以下测试，未通过不得标记为可用：

1. 上传后不执行 Commit，Canonical 计数与版本不变。
2. ZIP 路径穿越、超限、摘要不符、未知 Schema、错误 owner/scope 全部 fail closed。
3. Prepare dry-run 重复执行产生相同 `plan_digest` 或给出可解释差异。
4. Commit 遇到 stale base version 返回明确 CAS Conflict，且无部分业务写入。
5. 同一计划并发/重试不重复创建 Canonical 对象。
6. 分块导入中断后能从 Receipt 状态幂等续跑，不能冒充全包成功。
7. Adapter 无 Canonical 写权限，静态配置和运行时权限均能证明。
8. 修改后的 Bundle 不继承原摘要、签名或来源身份。
9. 原始聊天只进入 Evidence；未经提升规则/人工确认不会成为当前 State/Decision/Preference。
10. 补偿遇到后续人工修改或依赖时停止并要求裁决。
11. 保留期结束后原始包不可恢复，但最小审计链仍可验证。
12. 每种 Vendor Export 都有机器可读或文档化的损失声明。
13. 现有 `clued.user-memory-bundle@1.0.0` 兼容性有独立回归测试；新字段通过新版本或 Receipt 引入，不静默破坏旧包。
14. 匿名、跨 owner、越权 scope 和重放攻击均被拒绝或按幂等合同安全处理。

## 6. 当前非目标

本次合同冻结不授权也不包含：

- 新建或部署任何 Vendor Adapter；
- 修改 `clued.user-memory-bundle@1.0.0` Schema；
- 修改 `memory/`、Manifest、Current Pointer 或发布快照；
- 修改数据库、RLS、生产 Worker、API、MCP、Secrets、DNS、Bindings 或路由；
- 启动 P2–P6、发布、Release、Tag 或生产数据导入；
- 声称任一未来能力已经上线。

后续实现必须另开版本化工作单元，并以本协议、现有 Canonical 合同和当时最新的仓库/生产证据共同验收。
