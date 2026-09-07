# vNext-2.0 实施冲突记录（执行计划 §29 强制要求）

> 依据《Cross-Memory-System_vNext-2.0_执行计划.md》§29：若发现现有实现与本方案冲突，
> 先记录问题、给出影响分析，再采用最小兼容方案解决。本文件为本次实施的逐项记录，
> 每条 = 冲突点 / 影响分析 / 采用方案。未列出的既有机制一律维持 vNext-1.3 状态不变。

## C1. 执行计划 §4 示例与 §5 语义冲突（type 双义）

- 冲突：§4 最小 Schema 示例 `"type": "preference"`，而 §5 定义 Memory Function Type
  为 FOUNDATIONAL/SEMANTIC/EPISODIC/PROCEDURAL/STATE/TEMPORARY；§4 示例 `"scope": "user"`
  与 §14 scope 枚举（global/project/session/agent/machine）也不一致。
- 影响：若按示例实现，type 语义将与 §5「L1-L6 = Recall Routing、Function Type = Cognitive
  Memory」双维度原则冲突。
- 方案：以 §5/§14 为准——`type` = Memory Function Type（小写），内容类别归入
  `classification.category`（preference/identity/project/…），scope 枚举为
  global/project/session/agent/machine；§4 示例中的 "user" 视为占位值，不接受为合法 scope。
  §4 示例的 "preference" 映射为 type=semantic + category=preference。

## C2. object-index.json 与同步护栏 files 清单的冲突

- 冲突：同步层（py/ps1）把 memory/index.json 的 files 清单同时当作「必需文件集 /
  删除传播 / 复制 / 提交边界」的唯一事实源，且 GAP-3-10 规定 files 项只允许 .md 基名
  （含目录分隔符即 fail-closed）。若把 object-index.json 或 objects 加进 files 会判
  索引非法、拒绝一切同步。
- 影响：新数据（objects/、object-index.json、audit/）不能走 files 清单护栏。
- 方案：memory/index.json 保持 vNext-1.3 原样（files 仍为 5 个 .md，recall 仍为 L1-L6
  段级映射）。对象层文件由 Memory Engine 自管（doctor 17 项检查覆盖），提交走
  git add memory/ + 既有 push 通道；同步层 staged/unpushed 密钥扫描天然覆盖对象文件
  （不修改同步脚本）。

## C3. sync-memory.py / sync-memory.ps1 是否修改

- 冲突：计划 Phase 10「Doctor 升级」若落在同步脚本内，会改变 v1.3 doctor 的输出契约，
  破坏 tests/test_acceptance.py 70 项断言（sandbox 克隆无对象层，新检查会红）。
- 影响：同步层是封版稳定基线；引擎检查混入会破坏旧验收测试。
- 方案：同步脚本零改动（Sync Layer = vNext-1.3 稳定基线）。17 项新检查落在
  `memory.py doctor`（memory_engine/doctor_v2.py，PASS/WARN/FAIL，任一 FAIL → exit 1）；
  同步层 doctor（git/护栏/refs/远端/阻断态）与引擎 doctor 分层互补。
  执行计划 §20「并保持当前真分叉/远端不可达/conform 缺失 → blocking FAIL」由同步层
  doctor 继续承担，引擎 doctor 不重复实现同步层检查。

## C4. protocol-manifest.json 契约字段

- 冲突：manifest 的 modes 被测试断言为四模式集合 {pull,push,doctor,bootstrap}，
  conformance_matrix 每行必须有对应测试函数。
- 方案：保留全部既有契约字段（modes/guards/side_effects/exit_codes/remote_verification/
  conformance_matrix）一字不改；新增顶层 `memory_engine` 描述段（只文档化，不参与
  同步契约断言）。引擎模式（recall/add/update/supersede/…）不注册进 modes。

## C5. 架构基线文档命名

- 冲突：tests/test_acceptance.py 的 test_doc_conform_probe_not_stale 硬引用仓库根
  `架构基线文档-vNext-1.3.md` 路径；改名/删除会破坏旧套件。
- 方案：v1.3 文档保留为历史基线（一字不改）；新增《架构基线文档-vNext-2.0.md》作为
  v2.0 规范，README/AGENTS 的「规范依据」指向 v2.0 文档并注明 v1.3 文档为历史基线。

## C6. 召回打分 vs 基线「展望项」纪律

- 冲突：基线附录 A 将 Recall Score（Intent+Similarity+Recency+Confidence+Explicitness）
  与语义检索列为「展望/不引入」；执行计划 §10 要求 relevance ranking。
- 方案：v2.0 实现的是确定性排序（priority + evidence + recency + keyword/tag/entity
  匹配），不引入向量/语义检索/embedding；基线 v2.0 文档明确区分「确定性混合召回
  （v2.0 落地）」与「语义检索打分（仍展望）」。

## C7. 计划 Phase 编号与实施顺序措辞

- 冲突：计划正文把 Adapter Interface 记为「二十四」，实施顺序记为「Phase 13」。
- 方案：以实施顺序（Phase 0–17）为准，文档中两处编号并存说明。

## C8. 迁移行粒度

- 冲突：§22 要求识别 identity/preference/project/decision/constraint/history，
  同时要求「不要把所有 Markdown 行都转换成 memory」。
- 方案：迁移只取 §22 六类对应段；已完成待办（[x]）、<8 字短行、纯命令/链接行跳过；
  状态/归档/待办的 AI 记录一律 candidate + manual-review 标签，画像/决策（用户明述）
  为 explicit → active。执行计划要求「先 dry-run，再写入」——本次实施 dry-run 已先
  执行并审查，再执行 --migrate。

## C9. 对象文件与 test_repo_files_do_not_self_match_secret_patterns

- 冲突：旧套件全仓扫描（含 memory/objects/*.json 与新测试/文档）禁自命中 guards.json
  密钥模式。
- 方案：全部新代码/文档/测试不含字面令牌样值（运行时拼接）；引擎写路径 + doctor 对
  对象做 guards.json 模式扫描（forbidden secrets），写入拒绝、doctor FAIL。
