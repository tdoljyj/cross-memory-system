# 全部上下文授权：审核与实施证据

本页保存已完成的审核结论，不替代在线 Clued 的当前任务、授权、Event 或 Receipt。方案通过、实现通过、发布成功与八视图验收是不同的结论。

## 方案审核

受查方案 v0.1-r2，SHA256 `8f828102c87663c44cd4e9e270fde7fc72c771aaa94cef4bb8f2598f903b67b3`。其原字节保存在 [AcceptedPlanR2.v1.json](evidence/AcceptedPlanR2.v1.json) 的 `original_base64`，同时可从固定提交 `4d05eb04d64fb8655cbe522a3dfcecf0d3c74904` 的原方案路径取得；`PROPOSAL` 表示当时方案文档阶段，不抹去后续审核回执。当前 [AllContextsAuthorization.v0.1.md](AllContextsAuthorization.v0.1.md) 为仅补任务引用的 r3，内容差异另行审核，不将 r2 的 SHA 当成新文档 SHA。

| 非作者审核 | 结论 | 报告 SHA256 |
| --- | --- | --- |
| [产品方案 r2](evidence/all-contexts-product-plan-review-r2.json) | PASS，0 Blocker / 0 Major / 0 Minor | `0f97b3e74af2fb001d72ec4dfbac2b3c90d0d9ba10e1e35ce71d52afa3776d64` |
| [安全方案 r2](evidence/all-contexts-security-plan-review-r2.json) | PASS，0 Blocker / 0 Major / 0 Minor | `b2babf69437d72895d09ae4805cb18d8192ba4ff0563fb926aa8e5828977e8dd` |

首次失败的[产品审核](evidence/all-contexts-product-plan-review.json)与[安全审核](evidence/all-contexts-security-plan-review.json)保留。它们针对旧方案 SHA256 `9bcc661dccca9a4af1bf0c118168fb779138e59593027aee8fe2e2ad3df5fa0d`，不能作为 r2 的结论。

Owner 决策 `1b609e13-9b44-47fb-90a1-89a74bf9875e@4`明确授权“独立审核通过后实施”。Root 已将两份 r2 结论记入原任务 `d5dee826-27d7-452b-8948-48fe8ae8a961@45`：Receipt `08ad6472-d288-403f-9f7b-efd19c3097f9`，Event `10132`。该方案质量结论不授予 Native 扩权、受保护合并或生产权限。

## 实施验证边界

UI 初审 [all-contexts-ui-code-review.json](evidence/all-contexts-ui-code-review.json) 针对 17 文件聚合 SHA256 `b8be154d65bc82c337b437b7d1d76231cdb5716d5863e75139ba7064c0bfa9a2`，结论 FAIL（0 Blocker / 1 Major / 0 Minor）。报告 SHA256 `e30936d6d373b49ff7f28789fa7384d671c37e02c403af64eeb564da0c91553a`。具体缺陷是旧 raw Binding 按创建类型误标“全部权限、无有效期”；修复后必须绑定新的 UI 快照重新独立审核，不能借用方案 PASS。Root 已记入原任务 @48：Receipt `d9aa5ef8-7244-4447-8386-80d44651cf00`，Event `10162`。

UI [r3 非作者复审](evidence/all-contexts-ui-code-review-r3.json)通过（0 Blocker / 0 Major / 0 Minor），报告 SHA256 `1e954a547e637fb5459036852a78a4a645df8d84fc82b03faec8a2742494ef1e`。原 17 文件聚合为 `d24b1f8836d5c4b67ae9681fe339907289c9dadb2dd40c40ecf1d58b1609e141`，加上政策页目录链接文案的 18 文件审核聚合为 `3dd3e73ac3f50504cfc76ebd298dfd08c5fa5fa03528ec276f75fc5149622617`。原 UI-M01 已解决；Scope／Context 精确限制的独立 Native 确认也在此受查范围内。Root 随后对该固定 UI 运行 139 项界面回归（139 PASS / 0 FAIL / 0 SKIP）及主 Worker／PDF Worker 构建，均通过。此结论限 UI 代码，不替代后端授权终审、实际数据库接口对齐、提交 CI 或 Native 页面操作。

两份有序迁移分别承载来源／有效权限与早期并发协调。第一份迁移完成但后继未安装时，新策略保持不可激活；旧业务授权保持原合同。

后端 [r1 非作者代码审核](evidence/all-contexts-security-code-review-r1.json)针对 Source SQL SHA256 `95c81c1a61cf0b8fc43d8bb487dcb55c3d9e8973e3063baba0f9e49c46ebe61b`，结论 FAIL（0 Blocker / 2 Major / 1 Minor），报告 SHA256 `50c0de9d2e389690e9f5ace061697d3298cc00421fd0b41075aa8cb7d0cc8679`。该版本已修共享资格撤销后的实时名称泄露，但仍有旧内部 grant 动作上限未保留、已有只读策略扩权回报成功却仍不可写，以及旧诊断资格动作未交集的问题。随后修订还须验证过期全权限来源只被重新确认只读时不会恢复旧写权限。原 58 项本地通过仅属于受查历史版本，不能作为修订代码的批准。

后端最终候选 Source SQL 为 `ad2dd45c9e778f1365e3994ca2e065d4127309eedf11c366c220eec6020a778a`，并发后继 SQL 为 `ea3abed2a505cd32142db13ab9212cd58887d31c728d0cde264bc36f0badb0ad`。该固定 Source 的六组受影响数据库测试 42 PASS / 0 FAIL / 0 SKIP；同一 Source 的独立并发测试日志记录 15 PASS / 0 FAIL / 0 SKIP（日志 SHA256 `3c81f2562e49594962e3fee77e37fca28555677897a3ffa0949d68a60aefb8a1`，完整 reporter footer，原执行绝对时间及直接退出码未保留，详见限定 manifest）。这些局部测试不是全量 Linux CI。

原 `connection-authorization-db.test.mjs` 旧有界迁移链经独立隔离重验，未改测试，按现有数据库命令使用 `--test-force-exit`：20 PASS / 0 FAIL / 0 SKIP，实际 exit 0，Node v24.19.0，2026-10-14T07:00:22.7819322Z 至 07:00:30.0255685Z。日志 SHA256 `d84414e522f12987394f089f8f003f91994218ab9dd1f5966e5054cbec06613c`，manifest SHA256 `edaeab80c485e9209cbd1a95384023984133546432729b7b03f960ec845120c7`。先前父测试失败后挂起未复现，具体原因仍 UNKNOWN；保留失败，不以本次通过替换历史。Root 将上述局部资格记入原 Task @52，Receipt `c4d84f57-0ddc-4ecb-9144-115dd09cead9`、Event `10283`。离线迁移账本验证通过：258 production rows、11 repository-only、2 pending；两份新迁移尚未应用。

最终提交清理 Source 文件末尾一个空行，保留必要的末尾 LF，SQL 语义未变。最终 Source SHA256 `55ba0daa5b4e303c3a954f7eec7a7f82621f6dc432693f5456cf5026684d104b`；序列化后继仍为上述 `ea3abed2…`。普通提交 `b8a5596b` 后正常合并远端 main `af22e8c5d8c70f86d17abb32996a63414a1d5c94`，本地固定候选为 `1c1b5f36996ac662cbcbfc9bbb3bae3c3e3c0a78`。main 继承只涉及四个模型桥接／运行时测试文件，不改本次授权界面或数据库。

Root 对最终字节直接执行七组组合数据库回归：57 PASS / 0 FAIL / 0 SKIP、exit 0，Node v24.19.0 on Windows，2026-10-14T07:08:43.8510047Z 至 07:09:47.4227329Z。完整日志原 SHA256 `e50f74de88a84fe4d5de6ce756671649f142d247efce4afcab586eefe667a74d`、原 manifest SHA256 `daf7c4446130184d13cf141a49aa43606ae3a83f6c0cd17c3838734fe6757fba`。该组合包含来源及并发测试，具有直接执行证明；上述 ad2 字节及无直接退出证明的旧锁报告保留为历史。

PowerShell 原测试日志／manifest 的 CRLF 字节通过 [ExactOriginalEvidence.v1.json](evidence/ExactOriginalEvidence.v1.json) 的 `original_base64` 精确保全。相邻可读文本遵守仓库 LF 规则；每个条目同时绑定原 SHA256、规范化文本 SHA256 与变换，不能混用两种哈希。

最终后端 [r2 非作者代码审核](evidence/all-contexts-security-code-review-r2.json) **PASS，0 Blocker / 0 Major / 0 Minor**，报告 SHA256 `d223d30902ead65ac193a2166cc081a2a2b326d71af3e8a898994427e72e1d21`，受查候选 `1c1b5f36996ac662cbcbfc9bbb3bae3c3e3c0a78`，绑定 Source55ba／序列化ea3。原 r1 问题及过期全权限来源只重新确认只读时可能恢复旧操作的问题均已关闭；Reviewer 实际核读最终代码与 Root 57 项直接执行证据，未自行跑 CI、改源码或执行 Native 扩权。Root 已记入原 Task @55：Receipt `6fb743db-8517-4f26-8a81-58332fd4dfdc`，Event `10322`。

最终提交的 CI、生产备份／两份迁移／发布／上线核验尚须分别绑定实际提交证据。代码审核和阶段性本地测试不能替代这些结论。对既有连接的“全部上下文”升级仍由同一 Binding 的 Native Owner 确认完成。

授权修复完成后按受查方案 §6.1 回到八视图验收。原验收仅为 `CORE_FLOWS_PASSED_FULL_ACCEPTANCE_INCOMPLETE`；实际上下文旧版本正文、来源全文正样本和受影响授权／当前性用例仍须补证。原任务的第三阶段增强也不能因本次授权修复而标记完成。

## PR818 首次正式检查与修复候选

实际失败 head `4d05eb04d64fb8655cbe522a3dfcecf0d3c74904` 已保留。方案两处延期说明缺原 Task ID，r3 只补 `Task d5dee826` 与版本／状态元数据，范围和语义保留。密钥扫描 pinned v8.30.1 在分支及完整祖先历史均只找到两条：上述最终 r2 代码报告第 150／152 行的文件校验摘要。非作者[诊断](evidence/pr818-gitleaks-diagnosis.json) SHA256 `218b919af0b1f94058c22769775d98dd4de8f4613c76f293ed562412b15daf25` 核对每个值等于其实际代码文件 SHA256，属于 `ARTIFACT_DIGEST`；没有将失败称为通过或把真实密钥隐藏。Root 实际撤销自动合并、退出 FIFO，并将失败及定位记入原 Task @57，Receipt `5b06446e-2a26-4a8b-aa3d-ad8141123f0f`、Event `10364`。

修复候选只增加两条完整 commit／path／rule／line 历史例外，原 482 条、默认扫描规则和全局例外数量 0 均保留。Helper 针对这个报告路径还验证精确提交、两个行号、原因、固定报告 SHA、原行键值，以及同一不可变提交中对应源码的 SHA；新提交、新路径或修改报告不能借用此例外。8 项局部验证通过；原文档编号检查 53 个文档通过；实际历史核证为 484 fingerprints／69 commits／124 files／130 Git objects。该候选仍须非作者差异复审、新提交的保护门和实际完整扫描，不沿用首次 head 的许可或失败结果。

[CI 元数据差异复审](evidence/all-contexts-ci-delta-review-r1.json) PASS（0／0／0），报告 SHA256 `643a67f30267783c1148251e513a0592231694f043444ebe5510dd4c4b8f6462`。复审逐条确认默认 TOML／原 482 记录不变，仅增加已证明的两个不可变摘要位置；r3 仅版本／状态及两处原 Task 引用，r2 解码后与原固定 Git blob 完全一致。

另三项集成检查的[独立诊断](evidence/pr818-stack-failures.json)，SHA256 `159974afd86365a2730d7f44a0f0e3d44ad6fb8819bf06ba43b8453b28e6ccc9`：G4 实际 251 migrations、db lint、72 pgTAP 通过，失败发生在旧阶段测试提前装入后继；隔离组 175／184 通过，剩余涉及旧 CLOSEOUT 重放阶段、未持真实锁的测试插入；HTTP E2E-05 则使用旧缩减协议。没有这些日志中的磁盘耗尽证据。

11 个受影响测试／E2E 文件已修复：旧 sealed CLOSEOUT 及原断言完整保留、在后继前真实重放；后继实际 OID／Owner／SD／search_path／ACL、GW80／CI8、真实早期锁与私有调用拒绝另行验证。两组本地 PostgreSQL 日志为 9／9 与 30／30 PASS，均 0 SKIP。实际 PG 已复现旧 flat 请求 `22023 authorization_source_selection_required_sources_v1`，验证新来源缩减只撤 B、A 全 DTO 保留、双层 CAS 及最终撤销。Source55ba、序列化ea3、旧 CLOSEOUT 原文均未改变。

[非作者测试差异复审](evidence/pr818-fixture-repair-independent-review-r1.json) PASS（0／0／0），报告 SHA256 `668161a50ac8ea19ab75aac990ff14f37c114967751c83a32e5082411b568bdd`，Root 记入原 Task @61、Receipt `ec7291f0-4d5e-41f6-9693-720ab67e0c1c`、Event `10421`。完整 HTTP E2E、新 head Linux CI、生产和页面验收仍待实际执行；这些修复不替代后续门禁。

## 第二轮检查与实际项目创建入口补修

`3a4dbd2374fb955ac6d910ca327a37c26bd3d751` 的实际数据库迁移／RLS／pgTAP、代码质量、HTTP E2E、MCP 与安全检查通过；隔离测试前两套 86／86、190／190 通过，第三套 76／82 通过。六个失败包括五次旧封存源码重放和一处旧阶段尚未关闭便安装新序列化的顺序错误，不能称整轮通过。

[独立调用盘点](evidence/authorization-writer-callgraph-review.json)另发现真实 Native 资料中心 `activate` 新建 Project 漏接早期协调。Source55ba／旧序列化ea3的实际 PostgreSQL 复现报 `42501 authorization_early_writer_guard_required`，事务完整回滚；它是功能缺陷，与历史测试安装顺序分别记录。[第二轮盘点](evidence/pr818-isolation-second-diagnosis-and-inventory.json)与[修正结论](evidence/pr818-isolation-second-production-reassessment.json)保留，不用静态清单推断所有未运行业务均通过。

当前序列化为 SHA256 `ce8ee42d89240a338cbd229846c397f9626f1445e2dfa832b60c19fecb994e58`；Source55ba未变。真实最外 Native 入口在账户／会话、issuer、attempt 和存储锁之前取得 Owner 协调和有序 Binding fanout，再执行原会话及完整业务验证。退役 alias 保全原 `64503257…` 正文和 owner-only ACL，实际 Native／Gateway 入口与私有 core require 均保留。当前[实际锁测试](evidence/all-contexts-storage-final-manifest.json)20／20 PASS，0 FAIL／SKIP，包含真实新建 Project／未来 Context／MCP消费、双序并发等待、非法身份及等待期间会话过期拒绝；前态、首次 fixture 错误与初轮断言失败日志完整保留。

[后端 r3 非作者复审](evidence/all-contexts-security-code-review-r3.json)PASS（0／0／0），原报告 SHA256 `1add2627c0a80963da32f667d2fa6ca6f6c28f02c82047abeba99050815ecdae`，绑定55ba／ce8及实际20日志，关闭调用盘点的两个问题。旧ea3的r2结论保留为历史限定对象，不能替代当前版本。

六个有意延后封存的[历史 fixture](evidence/delayed-closeout-fixture-repair.json)仍运行所有原业务和真实封存重放，再按序安装两后继并另验全 public OID／Owner／SD／配置／ACL与GW80／CI8。实际771 PASS、0 FAIL／SKIP、exit0；六文件未另捕运行前哈希，此限制明确保留，closing哈希与SQL／helper的真实前后哈希已保存。另七个授权 fixture 的Root实际执行10 PASS、0 FAIL／SKIP；admission case直接与被导入各运行一次，不称十个独特用例。

[13文件非作者复审 r2](evidence/pr818-fixture-repair-independent-review-r2.json)PASS（0／0／0），原报告 SHA256 `60259fb2ec3b7a34847560b6767b3e022b5b41d8a30ce826df20795ff9a49461`，独立核对上述实际日志、所有 closing 字节和限定说明。Root授权原始日志有PowerShell5混合编码；[解码记录](evidence/pr818-auth-fixtures-r2-root-decoding.json)及UTF8派生日志只转换编码，原始字节在[ExactRepairEvidenceR3.v1.json](evidence/ExactRepairEvidenceR3.v1.json)完整保全，未重跑或修改输出内容。该封套同时保存本轮所有原报告／失败／成功日志及Git LF文本的不同摘要。

此批修复尚待新提交完整CI、受保护合并、备份／两SQL／生产发布、同Binding Native升级及八视图完整页面验收。线上仍为8f960b；不关闭原Task或第三阶段增强。
