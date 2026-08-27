# Clued P4 独立复验与合并 Closeout 报告 v1.0

## 1. Closeout 裁决与固定边界

`PASS / P4_CLOSEOUT_ACCEPTED`

本报告只对 P4 Canonical-first、Freshness、确定性 T1 的两轮独立复验、定点修复与 fast-forward-only 合并进行不可变封存。P4 仓库实现与验证已经完成，但生产功能启用、生产访问与发布均未获授权；Canonical-first、Freshness、确定性 T1 和语义召回在生产路径继续保持禁用。

固定事实：

- P4 固定基线：`4d433be2093afaaa74a6d1291d9f92a65c705aa2`
- P4 第一候选：`ba0824c6687d2f33a769fe0f559c6d060aa3bc6f`
- P4 最终候选及 fast-forward 合并后远端 `main`：`ee5ce82f7e00b44136735734c4d1aa601680f2e4`
- 最终候选唯一父提交：`ba0824c6687d2f33a769fe0f559c6d060aa3bc6f`
- 最终候选 Tree：`6575036b9358ed4335fbf6652e76278f143b5897`
- 合并裁决：`PASS / P4_FF_MERGE_COMPLETED`

本报告的普通线性 Closeout Commit 必须以 `ee5ce82f7e00b44136735734c4d1aa601680f2e4` 为唯一父提交，且 Commit diff 只能新增本报告。最终 Closeout Commit、报告 Blob 与报告 SHA-256 由提交后回执记录，避免在报告自身内容中形成自引用。

## 2. 完整线性提交链与变更范围

完整 P4 线性链：

`4d433be2093afaaa74a6d1291d9f92a65c705aa2`

→ `ba0824c6687d2f33a769fe0f559c6d060aa3bc6f`
`P4 canonical-first deterministic T1 [Codex@TURING]`

→ `ee5ce82f7e00b44136735734c4d1aa601680f2e4`
`P4 object-first deterministic T1 review fix [Codex@TURING]`

两条 P4 Commit 均为单父普通 Commit；第一候选的唯一父提交为固定基线，最终候选的唯一父提交为第一候选。相对固定基线，最终候选 ahead 2、behind 0，merge-base 精确为固定基线，P4 范围内 merge commit 数为 0。

P4 相对固定基线累计修改 10 个文件：

1. `canonical_read.py`
2. `memory.py`
3. `tests/test_p4_canonical_first.py`
4. `tests/test_p2_verification_context.py`
5. `artifacts/clued-validation/p4/4d433be2/p4_raw_results.jsonl`
6. `artifacts/clued-validation/p4/4d433be2/canonical_first_freshness_evidence.jsonl`
7. `artifacts/clued-validation/p4/4d433be2/deterministic_t1_routing_evidence.jsonl`
8. `artifacts/clued-validation/p4/4d433be2/recall_golden_set_evidence.json`
9. `artifacts/clued-validation/p4/4d433be2/SHA256SUMS`
10. `docs/clued-two-level-views/Clued_P4_Canonical-first与确定性T1_验收报告_v1.0.md`

第二轮定点修复相对第一候选精确修改 6 个文件：

1. `canonical_read.py`
2. `tests/test_p4_canonical_first.py`
3. `artifacts/clued-validation/p4/4d433be2/p4_raw_results.jsonl`
4. `artifacts/clued-validation/p4/4d433be2/deterministic_t1_routing_evidence.jsonl`
5. `artifacts/clued-validation/p4/4d433be2/SHA256SUMS`
6. `docs/clued-two-level-views/Clued_P4_Canonical-first与确定性T1_验收报告_v1.0.md`

## 3. P4 正式范围与禁用边界

P4 严格覆盖 F10–F14、F20、F21、U02、U03、U05：

- F10：在线 current 只接受实时 Canonical，路径不依赖 Git 或 Snapshot。
- F11：仅明确分类为 `UNAVAILABLE` 时，允许使用有效期内已验证 LKG，并返回完整 degraded envelope。
- F12：鉴权、Scope、Binding、Owner 失败直接拒绝，且不得读取 LKG。
- F13：`strict=3600s`、`balanced=21600s`、`degraded=1800s`；未知、自定义或错误模式 fail-closed。
- F14：有效期统一为 session、live recheck TTL 和 degraded expiry 的最小值。
- F20：精确 Project Object 必须先于 Derived Index；Index 只作为可重建投影，Record Ref 必须逐项验证。
- F21：T1 只接受显式 canonical project ID、查询中的唯一 canonical project ID 或明确 profile 触发；零命中降为 T3 Global STD，不扫描全部项目。
- U02/U03/U05：State、Task、Decision、Archive、Log 权威分离；Log 只作为 event evidence；权威输出必须携带完整来源、来源版本和字段版本。

P4 未启用生产 Canonical-first、Freshness 或确定性 T1，未接入生产传输，也未发布相应功能。语义召回继续由独立门禁控制并保持 `disabled`；P4 不实现、不启用语义召回。

## 4. 第一轮独立复验阻断

第一轮独立复验裁决：

`FAIL / P4_INDEPENDENT_REVIEW_BLOCKED_BY_DERIVED_INDEX_OVERRIDING_PROJECT_OBJECT`

阻断根因是 Derived Index 在 Project Object 缺失、损坏或身份冲突时仍可放行项目读取。旧路由在 Index 命中时没有先验证精确 Project Object，也没有完整解析与验证真实 Record Ref Schema，使派生 Index 或残留项目视图能够越过 canonical identity 边界。

第一轮故障注入确认三个核心场景均可触发阻断：

1. Project Object 缺失，但 Index 与旧五视图仍存在；
2. Project Object 的 `canonical_id` 指向其他项目；
3. Index 包含非 Canonical Record ID。

上述任一场景都不允许由 Index 或项目视图补足、覆盖或猜测 Project Object 身份。

## 5. 第二轮定点修复与独立复验

第二轮修复将 Object-first 与 fail-closed 顺序固化为：

1. UUID 语法、冲突和歧义检查先于路径推导和 Index 读取；
2. 所有项目读取先加载并验证精确 Project Object；
3. Project Object 必须校验 `kind`、对象键与正文中的双 canonical ID、Snapshot/Canonical Version、字段类型和 lifecycle；
4. Object 缺失、损坏、身份冲突或版本冲突时，在 Index 和项目视图读取前 fail-closed；
5. Index 只作为可重建投影，不得决定或覆盖 canonical identity；
6. 每个 Record Ref 必须由 `by_id` 验证 `kind`、`effective_scope`、lifecycle、规范对象路径和目标对象存在；
7. Index 异常只能在 Project Object 已验证后拒绝 Index，并进入精确 Object 回退；
8. 有效项目 T1 的来源准确固定为 Project Object、Index、State、Task、Decision，共 5 个来源。

第二轮独立复验中，第一轮的三个核心阻断场景全部反向通过：每个场景都在 Index 和项目视图读取前精确 fail-closed。真实 Snapshot Project Object 与 17 条实际 Index Record Ref 的控制场景通过，证明修复既阻断伪身份，又保留合法 canonical 项目读取。

第二轮独立复验裁决：

`PASS / P4_SECOND_INDEPENDENT_REVIEW_ACCEPTED_FOR_FF_MERGE`

## 6. 完整复验结果

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项与文档契约 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 F10–F14/F20/F21/U02/U03/U05 | PASS，33/33 |
| Python 全量 | PASS，104/104 |
| Cloud verified build | PASS，243/183/235/189/182 modules |
| Cloud 离线回归 | PASS，63/63 |
| `memory.py doctor` | PASS |
| `sync-memory.py doctor` | PASS |
| PowerShell NONE | PASS，零 Context、零 Git、零 Memory 读取 |
| Python `compileall` | PASS |
| `git diff --check` | PASS |
| 召回黄金集合同 | PASS，19/19 |
| 召回黄金集回放 | PASS，111 cases，无回归 |

Cloud build 仅保留既有 Vite native config 前瞻警告和环境 proxy 提示，退出码为 0。黄金集关键指标保持封存值，未出现 stale、scope leakage、no-memory violation 或 secret leak 回归。

## 7. 六份固定证据复核

以下六份证据在最终候选、fast-forward 合并后 `main` 与 Closeout 前复核中，Git Blob 和逐字节 SHA-256 完全一致：

| 证据路径 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `artifacts/clued-validation/p4/4d433be2/p4_raw_results.jsonl` | `b613151aace0f6fffbcc347af9f7943839285f5a` | `20c55489ce5f16f62dba9b29eabc2c39174d87b962359774f4b5796685b4e8d1` |
| `artifacts/clued-validation/p4/4d433be2/canonical_first_freshness_evidence.jsonl` | `9af7dbab39536a9fc8cbbcb47515a66c2fadf3c7` | `c939f57a1e0c042fa90220f447a8562ac6972bfa1b5ff2b88a5bcd8151da35dd` |
| `artifacts/clued-validation/p4/4d433be2/deterministic_t1_routing_evidence.jsonl` | `b9050f06386604a260ce9bb13d457dc0a8693881` | `fa1fe2fc19d203086b7f36fff542c26f264e3f38bb724b7733b4eab6f05d819f` |
| `artifacts/clued-validation/p4/4d433be2/recall_golden_set_evidence.json` | `1dc4a37bb240b1a480c0f4ccf6365da817c3eeef` | `13954850c28bab7cad96a6ec64877a453091a6c3240ba7640e682b758b06809d` |
| `artifacts/clued-validation/p4/4d433be2/SHA256SUMS` | `fedeadf49a5a8de55f33ba7a9c92d48bff0b7336` | `f94dcd62d742d57ce82387e5d0c101c89294d0f34395ae50eabcf0fc997e6f1d` |
| `docs/clued-two-level-views/Clued_P4_Canonical-first与确定性T1_验收报告_v1.0.md` | `aeea6e47188172e534dd5b7ee32467d7fa1218a8` | `1dfdf9ae6c289c8d54bd79b3dd5d217624195ac60d03c932873bf03ebccff295` |

仓库中的 `SHA256SUMS` 继续固定四份原始/派生证据和 P4 验收报告；其自身 Blob 与 SHA-256 也已独立复核。Closeout 未修改上述任一文件。

## 8. Fast-forward-only 合并事实

合并前重新确认：

- 远端 `main` 精确为 `4d433be2093afaaa74a6d1291d9f92a65c705aa2`；
- 远端功能分支精确为 `ee5ce82f7e00b44136735734c4d1aa601680f2e4`；
- merge-base 精确为固定基线；
- 功能分支 ahead 2、behind 0；
- P4 相关工作树干净。

实际唯一合并命令：

`git merge --ff-only ee5ce82f7e00b44136735734c4d1aa601680f2e4`

随后使用普通 push 将远端 `main` 从固定基线更新为最终候选。P4 合并本身未产生 merge commit、额外 Commit、squash、rebase、amend、force push 或任何历史重写，功能分支未被修改。

合并裁决：

`PASS / P4_FF_MERGE_COMPLETED`

本轮 Closeout 只允许在已合并候选之上新增一条普通线性报告 Commit；这条审计 Commit 不属于 P4 功能实现或合并历史。

## 9. 封存不变量

- Canonical current 必须来自实时、已认证、来源/版本/字段版本完整的 Canonical response；Git、Snapshot、Mirror、旧缓存和历史日志不得冒充在线 current。
- 仅 `UNAVAILABLE` 可进入仍在有效期内的已验证 LKG；AUTH、SCOPE、BINDING、OWNER 等失败不得读取 LKG。
- 所有 Freshness 模式、TTL 和 effective expiry 必须使用固定合同；未知或矛盾输入 fail-closed。
- Project Object 是项目身份的权威事实；Derived Index 只作为可重建投影，不得覆盖 Object。
- Object 缺失、损坏、身份/版本冲突或生命周期不允许时，必须在 Index 和项目视图前 fail-closed。
- Index Record Ref 必须由 `by_id` 解析并验证 kind、scope、lifecycle、规范路径与目标存在。
- 只有 Project Object 已验证后，坏 Index 才能被拒绝并进入精确 Object 回退。
- 确定性 T1 不扫描全部项目；有效项目来源固定为 Object、Index、State、Task、Decision，零命中降为 T3。
- 语义召回继续保持禁用；NONE 继续保持零 Context、零 Git、零 Memory 读取。
- P1/P2/P3 的 ancestor/divergence、Request-local Evidence、隔离 Mirror、journal/LKG、锁与 retention 不变量均未修改。

## 10. 本轮唯一变更与未执行范围

本轮 Closeout：

- 只新增 `docs/clued-two-level-views/Clued_P4_独立复验与合并_Closeout_报告_v1.0.md`；
- 未修改 P4 实现、测试、原始证据、P4 验收报告、`AGENTS.md`、Snapshot、Manifest、正式 Current Pointer 或根 `VERSION`；
- Closeout Commit 为普通单父线性 Commit，唯一父提交必须为最终候选；
- 未 amend、rebase、squash、force push，未创建 merge commit或历史重写。

明确未执行且仍未授权：

- P5、P6；
- 生产访问或部署；
- 数据库、RLS、Worker、MCP、OAuth；
- Tag、Release；
- Snapshot、Manifest、正式 Current Pointer 或 `VERSION` 的生成、修改、切换、发布；
- 任何 P4 功能分支修改。

P4 至此完成独立复验、fast-forward-only 合并与不可变 Closeout。完成 Closeout Commit 和普通 push 后立即停止；P5 继续保持未授权。
