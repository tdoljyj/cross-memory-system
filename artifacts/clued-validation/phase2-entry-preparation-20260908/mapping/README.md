# R07–R10 工程映射准备包

状态：**ENGINEERING_PREPARATION_ONLY**。源码固定为 `f3d0066197c06220d34f825dd59c74bcf968cdfd`。本包未签发 PASS、接受、Freeze、资格或 Entry，不修改 Frozen Registry、Canon、pins 或授权。

复用此前已核定的 12 项来源，补齐 18 个实际消费者到 27 个授权契约、18 个回执契约的路径与 JSON pointer。每个源文件均记录精确提交、字节数和 SHA256；共核对 47 个仓库来源。源摘要使用提交内原始字节；工作树仅换行不同的文件另记 `LINE_ENDINGS_ONLY`，不把规范化摘要冒充原始摘要。

| 文件 | 可复核内容 |
| --- | --- |
| [ConsumerMapping.json](ConsumerMapping.json) | C01–C18 的声明责任、操作、当前源路径、历史符号、授权/回执指针、失败和未知行为引用。 |
| [SkillLineage.json](SkillLineage.json) | 统一 Clued 的 3 个源/安装文件摘要，工程与记忆路由，三个明确旧入口的后继链，以及未证明的旧身份。 |
| [ReadinessMapping.json](ReadinessMapping.json) | R07–R10 的精确阶段来源、依赖、历史证据适用范围、缺口与下一动作。 |
| [ControllerSourceBoundary.json](ControllerSourceBoundary.json) | S06 两跳原文、实际资格绑定文件摘要和未绑定字段；不创造控制信任根。 |
| [SourceBindings.json](SourceBindings.json) | 全部精确来源，及本机候选输入、ZIP 成员的路径/摘要。 |
| [Verification.json](Verification.json) | 引用、摘要、契约指针与安装字节核对结果及本包文件摘要。 |

当前 `worker/continuity.ts`、`app/page.tsx`、`app/oauth/consent/page.tsx` 与历史验收对应源有变化，涉及 C01–C10、C14 共 11 行；文件变化不代表每项操作均失效或存在缺陷。应按实际差异补适用性复核，复用已完成的正式项目列表/权限错误修复证据，保留其不覆盖 OAuth 页面验收等限制。C15 的工作流则精确命中 Step17 已接受的后继摘要，无须重开原验收。未重跑已通过的完整测试或 21 步治理。

| 阶段 | 依赖 | 最小后续验收动作 |
| --- | --- | --- |
| R07 | R06 | 审阅变化行及历史 18 消费者以外的实际责任范围；把有效 Authority、Pointer、Rollback 执行者绑定到受查对象。27 个契约引用不等于 27 项已签发运行授权。 |
| R08 | R07 | 将 R07 变化与 Canonical 语义约束逐项对应，仅补受影响且缺证的比较；Step17 证明原迁移，不能直接证明后续业务改动等价。 |
| R09 | R08 | 用当前规则、消费者、发布/读取边界形成精确机制受查对象，补有效授权、停止/撤回、回滚及不可变身份后取得适用范围内接受。Naming Freeze 不自动成为机制 Freeze。 |
| R10 | R09 | 将统一 Skill 的精确字节与已接受机制对象绑定，复核工程/记忆投影，再进入获得实际授权的隔离资格流程。旧薄适配器接受不自动成为统一 Skill 的资格。 |

统一 Skill 最近源变更为 `a1c7e8607d5ed9a6ae78fae302e565ed748d4f66`，3 个安装文件均与固定源码相同。`clued-developer`、`clued-user`、`clued-continuity` 有明确历史文件和更新器具名退出实现；`clued-kernel-developer` 没有已证明的别名/退出链，不能因本机缺目录判为弃用或不适用。

S06 引用链只证明设计约束。`V022_ACTUAL_PREENTRY_QUALIFICATION_BINDINGS` 仍为 `NOT_REQUESTED_NOT_ISSUED_NOT_EXECUTED`，实际执行结果为空，不能由候选计划推导已有合格控制器。还需要现有可核验控制证据存储/信任根、精确 runner/配置/宿主、独立资格、有效 profile 及限时限域授权；本机可准备输入摘要、隔离候选、反例、停止/撤回及 UNKNOWN 恢复设计。此结论限于已核定引用链，不断言其他授权环境不存在控制器。

`build_mapping.py` 可在本机已保留对应来源的环境重建本包；只读取源并写入本目录，不联网、不执行资格测试、不签发决定。候选文件中的历史 NOT_ISSUED/NOT_AUTHORIZED 状态仅作为来源保留，不能覆盖后续真实授权或限定范围的既有接受。
