# R09 当前机制审查候选

**PREPARED_CANDIDATE_ONLY；未接受、未冻结、未签 GA。** 本文与 [R09MechanismCandidate.json](R09MechanismCandidate.json) 只整理已经存在的机制、安装投影和核查边界，不新增算法、controller 或 Authority。

## 原始要求与前置

原 `ReadinessAndGateCandidate.json`（SHA256 `6d8adc8e29c3be0cd18e25925851559494f94384f79f8a2e530a68f3802d4ceb`）的 `/source_record/stage_nodes/9` 定义 R09 为“厂商无关 Clued Development Mechanism 冻结”，依赖 R08；所需对象是 `DevelopmentMechanismFreezeReceipt`，后继才是 R10 的新 Development Skill / Vendor Projection。原文的历史状态保留，不由本候选覆盖。

独立评估者提供的 [CurrentReadinessReview.json](CurrentReadinessReview.json)（SHA256 `4c3b83f125dfe621a4f3a6d13012faaae5056d6f4fbea758eb190f0a1cd0b0dc`）是当前责任、Pointer、条件恢复及 Canonical 不变量的**工程适用性接受**。它不是正式 R07/R08 stage receipt，因此候选中的这两个正式引用仍为 null。R09 定义不以未来 R11 PASS 或 controller 自证为前置。

## 已固定的当前对象

此次独立对齐源为 `260b085f4af94305c9bbc846dc3629dabb46a33b`。JSON 共绑定 37 个现有文件的 Git blob SHA、字节数、最近变更提交与当前工作树 SHA；全部字节一致。复用 SkillLineage、ConsumerMapping、SourceBindings 的既有定位，按 18 个消费者保留原 typed contract 指针，没有复制合同正文或另建权威注册表。

当前本机唯一统一入口 `clued` 的三份安装文件均与仓库完全一致。入口与工程 reference 最近变更提交为 `3dbda2396f1a8fdc78336950a8caa0b6bd81c15d`；记忆 reference 为 `a1c7e8607d5ed9a6ae78fae302e565ed748d4f66`：

| 文件 | SHA256 |
| --- | --- |
| `skills/clued/SKILL.md` | `8a5e6d9548731874b94ebe3edc046f7393c96fd75531f22231228e055206096f` |
| `skills/clued/references/engineering.md` | `ffff299ea0a1793f9b0b4963fc5bf099762fabce96ed96086cfc5494acbb8d29` |
| `skills/clued/references/memory-operations.md` | `a05feabc8ad4ccac535bb059fbf35179f79884dfb1113abdd18b21281bfda538` |

安装观察仅涵盖 `C:/Users/Windows/.codex/skills`：三个旧入口 `clued-developer`、`clued-user`、`clued-continuity` 均不在该目录。现有更新器只做显式离线整包比对/切换，备份置于发现目录之外；不保证断电或进程终止时的跨目录原子性。本次没有更新安装、重测客户端发现，也不推断其他主机状态。`clued-kernel-developer` 的历史身份仍须按原要求处置，不能由本机未安装推出退役或 N/A。

## 机制与投影边界

1. **Authority 与存储**：Clued 认证服务承担业务 Canonical；仓库 `memory/` 为只读投影。Skill、角色、mode、公开 bootstrap 或 tool discovery 都不授予 Binding、数据范围或发布权。
2. **工程读前核验**：现有统一 alignment/doctor 与 RequestVerificationContext 按独立请求执行；绑定实际边界与 Source Envelope，变化即失效。NONE 不读记忆、不联网核对；不建立定时版本检查。
3. **工具与回执**：现有服务消费者遵守实际 schema、认证能力、精确 ID、CAS 与幂等契约。业务实体、Event、Receipt 属于原事务；checkpoint 不能替代业务写入。无 session token 的 scoped development projection 不能伪装成 M1 checkpoint。代码绑定不证明对应数据库迁移已部署。
4. **受治理发布**：沿用实际配置的 trusted reader/publisher、原 pins、有效资格、真实签名选择器和适用 Gate。候选、本地 PASS 或仓库 wrapper 不能替代这些实际前置。
5. **投影与安装**：统一三文件按操作选择工程或记忆流程，共用连接的能力不会随 Skill 分支变化。文件安装成功只证明磁盘一致，不证明 R09 Freeze、R10 接受或 R11 行为。
6. **变更、停止与恢复**：保持实际权限、原操作身份、不确定结果和历史证据；受影响源/规则/授权/环境变化须重新核查。回滚核对真实前态与当前态，不恢复已撤销权限。现有文字规则不被称为已接受的通用进程树停止或撤回控制器。

旧 Step20/21 回执明确只接受当时精确字节的薄 Developer/User adapter。它们的源码、历史接受和退役记录仍有原含义，不能把这份接受转移到当前统一 Clued 三文件，更不能当作 R09 当前机制冻结。

## 失效与最小缺口

现有 AGENTS、工程 Skill 和 `AcceptanceAndInvalidation.md` 的规则继续适用：机制/投影/消费者/工具 schema/文件集合变更；路径/ACL/Manifest/Pointer/VERSION/tags/owner/scope/授权/TTL/验证器变化；发布者、宿主、运行时、策略或适用外部状态变化；证据缺失或损坏，都会要求重新核查相应范围。历史发生事实保留，当前准入不从旧记录自动继承。

仍需主控与指定独立评估者补齐：

- 正式 R07/R08 的精确回执，绑定工程适用性审查与有意后继。
- 原 `DevelopmentMechanismFreezeReceipt` 所需 schema、合法签发用途、精确机制对象与当前独立接受；本候选不创造替代控制类型。
- 实际依赖、运行环境、Authority、停止/撤回、证据、恢复范围的接受闭合；源文件或本地路径不能补造受信宿主资格、凭据或 generation。
- R09 真正接受后，针对这三份当前字节的 R10 投影接受和隔离测试主体绑定。
- 后续 Skill/PQUAL 执行另外具备实际 Profile、OS allowlist/网络拒绝、远端持久证据、预算、GA 与新鲜撤回核验。候选整理不执行这些动作。

本次只进行了只读定位、摘要/安装字节核对和候选结构核查：没有运行 Skill/PQUAL、写 Canon、更新 Skill、修改冻结 runtime 或信任文件。
