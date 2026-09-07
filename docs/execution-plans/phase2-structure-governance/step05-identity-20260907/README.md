# Step 5 六类身份候选

这组文件是本任务内的 Step 5 准备候选。它复用原包身份政策、13 类身份交叉表、原 23 行结构 Map 和已经绑定到真实 CI 的盘点审查结果。没有签发 Step 5 Gate、Step 9 Acceptance 或 Freeze，没有改名、迁移、创建运行权限或改变历史字节。

管理责任人及代办范围引用既有 `ExecutionDelegation_20260907.json`；用户授权是任务管理和代审来源，不被转换成程序 Domain 的 issuer、消费者权限或业务对象 ID。Step 4 的最终同字节候选已由独立的 `Step04-ScopedAcceptance_20260907.json` 限定接受；本组文件通过 `Sources.json` 和 `step4_prerequisite` 引用该精确决定，仅继承其管理范围，不把本候选当作新的接受或 Freeze。

| 身份 | 候选文件 | 复用与最小闭合方式 |
|---|---|---|
| Version | `VersionAxisRegistry.candidate.json` | 区分 10 个版本轴；直接引用原 CurrentArtifactIdentityPolicy、Registry 和 ReviewSubject。实际 Runtime 实例与尚未执行的 Migration 不编造版本。 |
| Vocabulary | `CanonicalVocabularyRegistry.candidate.json` | 保留现有 16 项协议字段词表，补足基线 22 个核心词的本轮作用域释义；这是候选解释视图，不覆盖原 Schema，也不声称全局语义已接受。 |
| Alias | `AliasRegistry.candidate.json` | 不发行猜测的别名；明确真实兼容映射需要的字段及 4 项保留/不等同处置。没有新别名不代表扫描器已经证明历史和外部别名为零。 |
| Logical | `LogicalObjectIdentityContract.candidate.json` | 引用原 13 类身份定义和全部 23 行 Map；稳定对象 ID、制品 revision、Registry 条目与路径分别解释，不重造一份运行 Schema。 |
| Representation | `RepresentationContract.candidate.json` | 区分在线 Canonical、只读快照、可读投影、传输包、设计候选和兼容投影；明确写入来源、冲突判定与新字节身份。 |
| Copy | `CopyIdentityContract.candidate.json` | 保留来源、出现位置及摘要；现有 727 组同 SHA256 副本和 727 组同 Git blob 副本只证明字节相同，不据此合并逻辑对象或授予写权限。 |

当前目标与迁移范围仍由原 `CANDIDATE_TARGET_MAP_V0_1_1` 的 23 行和用户当前目录范围修订决定。结构文档版本 `v0.1.4`、架构候选 `v0.2.5`、交付包 `v0.2.7.1`、Map 行版本 `v0.1.1` 与仓库 `Clued-v1.6` 各有自己的对象，不互相替代。架构直接前序仅引用原 ReviewSubject 中精确绑定的 `v0.2.4`，不把上游 Mapping `v0.4.3` 当作架构前序。

历史来源、归档、旧 Skill 及已退役本地 Memory Engine 的身份保留。`TM-13` 明确禁止把 `clued-continuity` 猜成 `clued-kernel-developer`；需要迁移那条具体投影时，再绑定真实 host、role、制品和消费者。模型、商务、权益类型仅保留原候选合同引用，本轮不生成商业或模型实例，也不激活这些域。

`ConflictsAndStep6Handoff.candidate.json` 给出 5 项有来源的身份风险及逐类交接。148 个已审查来源点继续使用原 `review_site_key` 和源码摘要：60 项有限静态映射、85 项运行时或 Step 6 绑定、3 项非名称同名符号。这里不复制或重新签发它们的审查决定。85 项中包含历史代码与测试；Step 6 只按实际活跃消费者判断所需证据，已退役代码保持审计用途，不为枚举动态值重新执行。

Step 6 真正需要补的是实际 Domain/program/stage/run、主体、能力与 scope、issuer、消费者合同及 Schema 版本、目标 revision/digest、有效期/撤销/漂移等绑定。有限映射直接引用已审查来源值；RPC helper 的既有补充记录单独保留，不悄悄改动原 CI 的主记录分母。当前路径若确实依赖外部 Auth 配置或已安装 Skill，须核实那项具体依赖；这不要求恢复整个历史 Library，也不把无关未知扩大成全局阻断。

来源目录见 `Sources.json`。本次仅重新读取选定合同和现有证据，核对它们的摘要、23 行唯一覆盖、六类视图、10 个版本轴、22 个术语、13 类原身份引用及 64 个 JSON Pointer。既有 CI manifest 和逐项审查摘要与原绑定 receipt 一致，结果在 `CandidateChecks.json`。这些是一致性检查，不是新的 CI 认证、运行测试或正式接受决定。

独立补正仅把 Step 4 来源改指已保全的相同字节，并追加既有接受决定。`base_repository_commit` 是原库存锚点，不声称后续范围修订和接受决定已存在于该提交；逐项来源摘要控制实际输入。
