# 全部上下文授权：审核与实施证据

本页保存已完成的审核结论，不替代在线 Clued 的当前任务、授权、Event 或 Receipt。方案通过、实现通过、发布成功与八视图验收是不同的结论。

## 方案审核

受查方案：[AllContextsAuthorization.v0.1.md](AllContextsAuthorization.v0.1.md)，v0.1-r2，SHA256 `8f828102c87663c44cd4e9e270fde7fc72c771aaa94cef4bb8f2598f903b67b3`。保留该受查文件原字节；其 `PROPOSAL` 表示方案文档阶段，不抹去后续审核回执。

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
