# Clued P4 Canonical-first 与确定性 T1 验收报告 v1.0

## 1. 裁决

`PASS / P4_CANONICAL_FIRST_DETERMINISTIC_T1_ACCEPTED_FOR_INDEPENDENT_REVIEW`

本报告只覆盖 P4 功能分支实施与证据生成，不构成合并 `main`、P5/P6、生产访问或发布授权。

## 2. 固定基线与分支

- 仓库：`tdoljyj/cross-memory-system`
- 固定远端 `main`：`4d433be2093afaaa74a6d1291d9f92a65c705aa2`
- P3 Closeout 唯一父提交：`0ff389d928f288e11cc980100274ffea1838ad3c`
- P3 Closeout 裁决：`PASS / P3_CLOSEOUT_RECORDED`
- P4 分支：`codex/p4-canonical-first-deterministic-t1`
- P4 分支起点：`4d433be2093afaaa74a6d1291d9f92a65c705aa2`
- 第一轮候选：`ba0824c6687d2f33a769fe0f559c6d060aa3bc6f`
- 第二轮线性修复的唯一父提交：`ba0824c6687d2f33a769fe0f559c6d060aa3bc6f`

开始前及证据生成前均以 `git ls-remote origin refs/heads/main` 复核，远端 `main` 保持固定基线。功能分支在第一轮候选上追加且只追加一个普通线性修复 Commit；最终 Commit、唯一父提交与 Tree 由提交后回执记录。

### 2.1 第一轮独立复审阻断与关闭

第一轮独立复审裁决为 `FAIL / P4_INDEPENDENT_REVIEW_BLOCKED_BY_DERIVED_INDEX_OVERRIDING_PROJECT_OBJECT`。阻断根因是旧 `deterministic_t1_plan()` 在 Index 命中时只检查 `by_scope.projects[project_id]` 为 truthy 字符串/列表，没有先验证精确 Project Object，也没有解析 Record Ref 的真实 Index Schema；派生 Index 或残留目录可能冒充项目身份。

第二轮修复将权威顺序固定为：先完成显式/查询 UUID 的语法、冲突和歧义检查，再加载并全量验证 `memory/objects/projects/{project_id}.json`，最后才读取并验证 Index。Project Object 缺失、损坏、字段/类型不完整、身份冲突、版本不一致或生命周期不允许时立即 fail-closed，且测试证明 Index、目标项目五视图和其他项目均未读取。Index 仅作为可重建投影；路由异常时，在精确 Object 已通过的前提下拒绝 Index 并使用精确 Object 回退，不由 Index 决定身份。

## 3. 范围权威

完整读取 `docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1.md` 中 P4、F10–F14、F20、F21、U02、U03、U05 的正式定义，并按该定义实施；未扩大到 P5/P6、语义召回或发布链路。

实现范围：

- F10：在线 current 只取实时 Canonical，路径不依赖 Git 或 Snapshot。
- F11：仅明确分类为 `UNAVAILABLE` 时，允许使用仍在有效期内的已验证 LKG，并返回完整 degraded envelope。
- F12：鉴权、Scope、Binding、Owner 失败直接拒绝，不读取 LKG。
- F13：`strict=3600s`、`balanced=21600s`、`degraded=1800s`；未知、自定义或错误模式 fail-closed。
- F14：有效期统一为 `min(session_expires_at, live_rechecked_at + policy TTL, degraded_expires_at when degraded)`。
- F20：精确 Project Object 先于 Index 验证；有效 Index 的每个 Record Ref 必须由 `by_id` 解析为正确 kind、effective scope、生命周期和规范对象路径，且目标存在；坏 Index 仅在 Object 已验证后允许精确回退，否则阻断。
- F21：T1 只接受显式 canonical project ID、查询中的唯一 canonical project ID 或明确 profile 触发；零命中降为 T3 Global STD，不扫描全部项目。
- U02/U03/U05：字段权威分离、Log 仅事件证据、所有权威输出必须包含 `sources_read`、`source_versions` 与字段版本。

## 4. 实现与行为变化

新增 `canonical_read.py`，提供不绑定生产传输的 Canonical-first 核心。调用者必须注入已认证 Canonical loader；仓库不保存凭据，也不会把 Snapshot、Mirror、旧缓存或历史日志包装成在线 current。

Canonical response 必须显式且一致地提供 source boundary、authority claim、完整性、Freshness 输入、State/Task/Decision、各字段版本、`sources_read` 与 `source_versions`。来源缺失、冲突、过期、未来时间、未知策略或错误权威声明均拒绝；除 `UNAVAILABLE` 外，不存在 LKG fallback。

`memory.py recall --tier T1` 的旧行为会读取 profile、Global STD 及所有项目 STD，共 16 个视图来源，并保留零分结果。P4 后行为为：

- 显式 `--project-id` 或查询中唯一 canonical project ID：精确 Project Object、`memory/index.json` 与精确项目 State/Task/Decision，共 5 个来源；
- profile 身份/偏好触发：`memory/index.json` 加 `memory/profile.md`，共 2 个来源；
- 零确定性命中：降为 T3，只读 Index 与 Global State/Task/Decision，共 4 个来源；
- 显式 `--history` 才扩展 Archive/Log，并返回 `expansion_reason`；
- UUID 语法、冲突和歧义均在 Index/用户派生路径前检查；Object 不可验证时 fail-closed；坏 Index 在 Object 已验证后拒绝并精确回退；
- 输出新增 requested/access tier、reason、selector、project ID、source versions、expansion reason，且明确 `semantic_recall=disabled`。

P2 的真实 PowerShell 临时仓库夹具新增复制 `canonical_read.py`，只用于维持既有隔离请求回归；P2 Request-local Verification Context 的实现与语义未修改。

## 5. P1/P2/P3 与边界不变量

- P1 一次 Remote Head 解析、ancestor/divergence 分类与 fail-closed 未修改。
- P2 Context 仍只在同一请求、同一信任边界内复用；Repository Source、Candidate、Local Mirror 独立验证。
- P3 Mirror、同机锁、journal 恢复、LKG、Backup retention 未修改。
- 默认访问仍为 NONE；T0/NONE 在 Context、Git、Pointer、Manifest 与 Memory 读取前返回。
- Repository Snapshot 的现有读输出仍标记 `historical`；不冒充 Canonical current。
- State、Task、Decision、Archive、Log 分别保留字段权威；Log 冲突显式呈现但不能覆盖 current。
- 语义召回保持独立门禁、默认关闭；P4 未启用或实现语义召回。

## 6. P4 正向、负向与冲突结果

| 门禁 | 正向结果 | 负向/冲突结果 | 裁决 |
| --- | --- | --- | --- |
| F10 | Canonical online current，LKG=0、Git=0 | 非 Canonical boundary 拒绝 | PASS |
| F11 | UNAVAILABLE + 有效 LKG 返回 readonly degraded envelope | 缺 degraded reason/version/field evidence 拒绝 | PASS |
| F12 | AUTH/SCOPE/BINDING/OWNER 分类明确 | 四类均不读取 LKG | PASS |
| F13 | 三档 TTL 控制均有效 | 三档到期、unknown/custom 均拒绝 | PASS |
| F14 | session 较早时成为 effective expiry | session 到期即拒绝 | PASS |
| F20 | Object-first + 有效 Index 精确读 5 个来源 | Object 缺失/损坏/身份/版本/生命周期错误在 Index/视图前阻断；坏 Record Ref/scope/path/target 拒绝 Index 后精确 Object 回退 | PASS |
| F21 | project/profile 唯一触发最小读 | 零命中 T3；冲突/多 ID 阻断；不扫项目 | PASS |
| U02/U03 | 五视图权威分离；Log 为 event evidence | Log 与 current 不一致时保留 current 并显式冲突 | PASS |
| U05 | sources、source versions、field versions 齐全 | 任一缺失或错误权威声明均拒绝 | PASS |

## 7. 完整门禁结果

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项与文档契约 | PASS，29/29 |
| P3 专项 | PASS，22/22 |
| P4 F10–F14/F20/F21/U02/U03/U05 | PASS，33/33 |
| Python 全量 | PASS，104/104（15+29+22+33+5 root） |
| Cloud verified build | PASS，243/183/235/189/182 modules |
| Cloud 离线回归 | PASS，63/63，2440.3687ms |
| `memory.py doctor` | PASS，710 个 Manifest 文件，`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155` |
| `sync-memory.py doctor` | PASS，Repository Snapshot 与 Local Mirror |
| PowerShell NONE | PASS，零 Context、零 Git、零 Memory 读取 |
| 召回黄金集契约 | PASS，19/19 |
| 召回黄金集回放 | PASS，111 cases；critical=0.7763、false=0.3444、stale=0、scope leakage=0、no-memory violations=0、secret leaks=0 |
| Python compileall | PASS |
| `git diff --check` | PASS |

黄金集封存的 `memory_eval_baseline/results.json` 早于当前 v2 metric envelope，因此不以旧整文件字节相等作为门禁；仓库当前 19 条冻结断言（包括精确 v2 指标）全部通过。Cloud build 只输出既有 Vite native config 前瞻警告和环境 proxy 提示，退出码为 0。

第二轮执行中有三项环境/夹具入口重试，均已分类且最终门禁通过：系统 Python 3.13 缺少标准库 `difflib`（改用 Codex 随附完整 Python）；P2 内嵌 PowerShell 用例与外层组合测试宿主交互导致回执截断（27 个快速用例和 2 个真实调用链分别运行，合计 29/29）；legacy 黄金集直接入口缺历史根目录外壳（在系统临时目录重建最小隔离 harness，未修改仓库或 Snapshot）。

## 8. 精确变更文件

实现与测试：

1. `canonical_read.py`（新增）
2. `memory.py`
3. `tests/test_p4_canonical_first.py`（新增）
4. `tests/test_p2_verification_context.py`

证据与报告：

5. `artifacts/clued-validation/p4/4d433be2/p4_raw_results.jsonl`
6. `artifacts/clued-validation/p4/4d433be2/canonical_first_freshness_evidence.jsonl`
7. `artifacts/clued-validation/p4/4d433be2/deterministic_t1_routing_evidence.jsonl`
8. `artifacts/clued-validation/p4/4d433be2/recall_golden_set_evidence.json`
9. `artifacts/clued-validation/p4/4d433be2/SHA256SUMS`
10. `docs/clued-two-level-views/Clued_P4_Canonical-first与确定性T1_验收报告_v1.0.md`

未修改 `memory/`、Snapshot、Manifest、正式 Current Pointer、根 `VERSION`、Cloud 源码、数据库、RLS、Worker、MCP 或 OAuth。

第二轮修复 Commit 相对第一轮候选精确修改 6 个文件：

1. `canonical_read.py`
2. `tests/test_p4_canonical_first.py`
3. `artifacts/clued-validation/p4/4d433be2/p4_raw_results.jsonl`
4. `artifacts/clued-validation/p4/4d433be2/deterministic_t1_routing_evidence.jsonl`
5. `artifacts/clued-validation/p4/4d433be2/SHA256SUMS`
6. `docs/clued-two-level-views/Clued_P4_Canonical-first与确定性T1_验收报告_v1.0.md`

`canonical_first_freshness_evidence.jsonl` 与 `recall_golden_set_evidence.json` 内容未变，但均重新计算并收入新的 `SHA256SUMS`。

## 9. 证据 Blob 与 SHA-256

| 证据 | Git Blob SHA | SHA-256 |
| --- | --- | --- |
| `p4_raw_results.jsonl` | `b613151aace0f6fffbcc347af9f7943839285f5a` | `20c55489ce5f16f62dba9b29eabc2c39174d87b962359774f4b5796685b4e8d1` |
| `canonical_first_freshness_evidence.jsonl` | `9af7dbab39536a9fc8cbbcb47515a66c2fadf3c7` | `c939f57a1e0c042fa90220f447a8562ac6972bfa1b5ff2b88a5bcd8151da35dd` |
| `deterministic_t1_routing_evidence.jsonl` | `b9050f06386604a260ce9bb13d457dc0a8693881` | `fa1fe2fc19d203086b7f36fff542c26f264e3f38bb724b7733b4eab6f05d819f` |
| `recall_golden_set_evidence.json` | `1dc4a37bb240b1a480c0f4ccf6365da817c3eeef` | `13954850c28bab7cad96a6ec64877a453091a6c3240ba7640e682b758b06809d` |

`SHA256SUMS` 同时固定以上四份证据与本报告。`SHA256SUMS`、报告自身的 Blob/SHA，以及最终 Commit/父提交/Tree 由提交后回执记录，避免自引用循环。

## 10. sources_read

- `memory/manifest.json`
- `artifacts/clued-two-level-snapshots/current.json`
- `memory/global/state.md`
- `memory/global/task.md`
- `memory/global/decision.md`
- `memory/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f/state.md`
- `memory/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f/task.md`
- `memory/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f/decision.md`
- `docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1.md`
- `docs/clued-two-level-views/Clued_单一数据源与两级五视图架构方案_v1.6.md`
- `memory/index.json`
- `memory/objects/projects/0597aa60-9b98-4da6-a4ab-63d7705b632f.json`
- `canonical_read.py`
- `memory.py`
- `verification_context.py`
- `tests/test_p1_align_and_verify.py`
- `tests/test_p2_verification_context.py`
- `tests/test_p3_isolated_mirror.py`
- `tests/test_p4_canonical_first.py`
- `tests/test_v16_root_cutover.py`
- `legacy/local-memory-engine-vnext2/tests/test_memory_eval.py`
- `legacy/local-memory-engine-vnext2/memory_eval/runner.py`
- `legacy/local-memory-engine-vnext2/memory_eval_baseline/results.json`
- `apps/clued-cloud/package.json`
- `apps/clued-cloud/worker/projects.ts`
- `docs/clued-two-level-views/Clued_P3_隔离Mirror_同机串行与Backup策略_验收报告_v1.0.md`
- `artifacts/clued-validation/p3/a9e12d85/p3_raw_results.jsonl`

来源版本：Git 固定 `main` `4d433be2093afaaa74a6d1291d9f92a65c705aa2`、第一轮候选/第二轮唯一父提交 `ba0824c6687d2f33a769fe0f559c6d060aa3bc6f`；Snapshot `snap_f6134235591bfcbfe4ba3a674383c3e0`；Canonical export `cv_155`；正式 pointer `current.json` 所指 Bundle；门禁文档 v1.1。

## 11. 未执行事项与停止边界

- 未合并 `main`，未创建 PR、Tag、Release，未部署。
- 未执行 P5、P6 或连续性/多厂商集成仓库结构方案。
- 未访问生产；未执行数据库、RLS、Worker、MCP、OAuth 操作。
- 未生成、修改、切换或发布 Snapshot、Manifest 或正式 Current Pointer；未修改根 `VERSION`。
- 未启用语义召回。
- 未 amend、rebase、squash、force push、merge commit 或历史重写。

P4 功能分支提交并推送后立即停止，等待独立复审与单独的 fast-forward-only 合并授权。
