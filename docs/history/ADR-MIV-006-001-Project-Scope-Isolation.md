# ADR-MIV-006-001 · Project-only Scope 硬隔离（Gate 2R 第一阶段）

> 状态：ACCEPTED（2026-08-19 产品所有者最终裁决：MIV-006 = PASS、含 D7 冻结语料对齐；初版实施前询问答复为选项选择，经 HOLD / BASELINE_DRIFT 复核后正式裁决，见 §9）
> 依据：《Cross-Memory-System_vNext-2.1_Memory-Intelligence_下一阶段执行计划.md》§MIV-006（第 551–569 行）+ §4.3（Gate 2/3 条件解冻：若必须改动既有模块，先提交 ADR，说明不变量、迁移、回滚与兼容性，然后停止等待确认）
> 执行基线：`725df3d9d49cf7e58e34549c9af49e71b783f94b`（HEAD == origin/main，经 ls-remote 与 GitHub API 双重核验；`ffba74bf` 为其直接父提交；2026-08-19 产品所有者**事后裁决**接受为 Gate 2R 执行基线，Gate 1 封板基线保持 `ffba74bf`；725df3d 未经可证实授权的 push 登记为一次已解决的治理事件，不 revert / 不 reset / 不重写历史）
> 审计日期：2026-08-19

## 1. 背景与问题

MIV-006 目标（计划原文）：在不破坏现有对象兼容性的前提下产品化：

- `global`：按既有授权跨项目可见；
- `project_only`：项目内可见，项目外不可见；
- `session_only`：仅当前会话，默认不持久化；
- `temporary`：不读长期记忆、不产生长期记忆。

计划强制测试：A 项目不可读 B 项目；B 项目内容不可影响 global recall；project-only 切换不静默复制对象；temporary/session-only 不产生长期写入；管理员/Adapter 不能绕过硬过滤；Trace 对越界候选仅显示安全元数据。

## 2. 审计事实（实现前证据）

1. **对象 schema v1**（`memory_engine/schema.py`）：`scope ∈ {global, project, session, agent, machine}` 单桶，**无 project_id 字段**；session 无会话身份匹配；`schema_version = 1`。
2. **召回引擎**（`recall_engine.py::_category_scope_ok`）：`scope="project"` 查询返回全部 project 对象（同桶全量），无项目分区 → Gate 1 基线 ps-010 泄漏根因（"project-only capability gap = 1"）。
3. **真实记忆**：230 个对象**全部 `scope="global"`**、零 project/session 对象、零 project_id、零 session_id → 本 ADR 对真实记忆语义影响为零。
4. **Eval 合同**：`memory_eval/schema.py` `SCOPE_MODES = [current, project_only, global]`；`scope_to_engine()` 把 `project_only` 降级为 `"project"`（**丢弃 project_id**）。
5. **冻结语料缺口**：ps-010 的夹具 `mem_fx0c0001`（"游戏原型使用 UE 5.6 引擎"）与 `mem_fx0c0006`（"另一个项目使用 Unity 引擎"）均为 `scope="project"` 且**无 project_id**——语料编写时对象 schema 尚无此字段，case 的 `scope.project_id` 已声明 p-alpha 语义。
6. **写路径**（`write_engine.py`）：`candidate_lookup` 只按 `scope` 粗筛（跨项目同内容会互相 UPDATE/SUPERSEDE）；`SUPERSEDE_MEMORY`/`cli_adapter.supersede` 新建对象不继承旧对象任何分区标记（当前无该字段，故无丢失风险）。
7. **Trace**（`recall_trace.py`）：`TraceRecorder.scope` 固定为 `{"mode": scope, "project_id": null}`；excluded 仅含 `memory_id + reason_codes`（内容安全已合规，需新测试固化到新 mode）。
8. **约束附带**（`_attach_constraints`）：遍历全部对象按实体匹配附着约束，**无 scope/project 分区** → 跨项目约束泄漏通道，必须一并封堵。
9. 冻结夹具现状哈希：`tests/fixtures/memory_eval/fixtures.json` SHA-256 = `BB51EF71665B35B6344A3F5978F7973EE2BE7EFACE63F1511D08A80CFF5317CA`；`memory_eval/corpus.py` SHA-256 = `4836F10836262098AD91633FBAF4164523AFE7E82C2755BB1F04B94191BF22A5`（corpus hash 仅覆盖 CASES，不覆盖 fixtures.json）。

## 3. 决策

### D1：复用等价字段，最小新增

- **对象侧新增唯一字段 `project_id`**（可选，`null` 或非空字符串）：仅当 `scope=="project"` 时参与过滤。`schema_version` **保持 1**（加法兼容；升级版本号会使既有 230 个对象全部校验失败，违反兼容性要求）。
- **session 身份复用既有 `source.session_id`**，不新增同义字段。
- **不新增对象 scope 枚举值**；project_only / session_only / temporary 是**查询侧 recall mode**（引擎参数层），不进对象 schema——避免同义字段与同义枚举。

### D2：硬过滤位置与可见性矩阵

硬过滤在核心 `memory_engine/recall_engine.py` 内、**打分之前**执行（现有循环已是"先过滤后打分"，新增判定并入同一道）。Adapter/CLI/管理员一律经引擎，无法绕过。

| 查询 mode | 可见对象 | 说明 |
| --- | --- | --- |
| `global`（legacy） | 仅 `scope=="global"` | 与 v2.0 完全一致 |
| `project`（legacy） | `global` ∪ `project` | 与 v2.0 完全一致 |
| `session`（legacy） | `global` ∪ `session` | 与 v2.0 完全一致 |
| **`project_only` + project_id=P（新）** | `global` ∪ (`project` 且 `project_id == P`) | project_id=null 的 project 对象**不进入**分区视图（未声明分区=不参与；legacy `project` 模式仍可见） |
| **`session_only` + session_id=S（新）** | `global` ∪ (`session` 且 `source.session_id == S`) | 无 session_id 的 session 对象不进入（严格） |
| **`temporary`（新）** | 无（零长期读取） | 不 load objects、不读 index.json，返回 NO MEMORY + `RC_TEMPORARY_MODE` |

fail-closed：`project_only` 缺 project_id、`session_only` 缺 session_id → `ValueError`（不静默降级）。

### D3：写路径

1. `perform_write` 对 scope ∈ {`session_only`, `temporary`} 的候选 **fail-closed 拒绝持久化**（`ValueError("EPHEMERAL_SCOPE_NOT_PERSISTED: ...")`，零对象文件、零审计、零索引变更）。会话运行期 store 属后续 Gate（需另行 ADR），本阶段只满足"不产生长期写入"。
2. `candidate_lookup`：project 分区下按 `(scope, project_id)` 匹配（project_id 缺失按 null 处理），杜绝跨项目 UPDATE/SUPERSEDE 串扰。
3. `SUPERSEDE_MEMORY` 与 `cli_adapter.supersede`：新对象**继承**旧对象的 `project_id`（"切换不静默复制/不丢失分区标记"）。
4. 任一写入不改动除目标对象外的任何对象文件（测试断言对象文件数不变）。

### D4：Trace 合同（加法扩展，不破坏 v1.0）

- `TraceRecorder` 新增可选 `project_id` / `session_id`，`trace.scope` 输出真实 mode + project_id；`session_id` **仅在非空时**输出（保持 legacy trace JSON 字节不变，Gate 1 基线 replay 不受影响）。
- 新增 reason codes（集中枚举）：`PROJECT_MISMATCH` / `SESSION_MISMATCH` / `PROJECT_OK` / `SESSION_OK` / `TEMPORARY_MODE`（excluded 候选继续只含 `memory_id + reason_codes`，零内容、零秘密）。
- explain=False / True 结果等价性覆盖全部新 mode。

### D5：约束附带防泄漏

`_attach_constraints` 同样应用 D2 硬过滤（B 项目约束不得附着 A 项目召回结果；session/temporary 同理）。

### D6：CLI / Adapter / Eval 合同透传

- `memory.py recall`：新增 `--project-id` / `--session-id`；`--scope` 接受 `project_only` / `session_only` / `temporary`。
- `adapters/cli_adapter.py`：`read/recall` 透传新参数（本就 `**kwargs` 透传，无需改签名语义）。
- `memory_eval/schema.py::scope_to_engine` 返回 `(scope, project_id)`；`memory_eval/runner.py` 把 case 声明的 `project_id` 原样传入引擎（**转发合同，不 mock scope 决策**，符合计划 §10.3 测试真实性）。

### D7：冻结语料对齐（单独提交 + 解释，随本 ADR 一并请求批准）

`tests/fixtures/memory_eval/fixtures.json` 为 Gate 1 冻结语料；补齐对象侧 `project_id` 是"补齐当年 schema 缺失的字段"，**不修改任何 golden label**（expected/forbidden 零改动；corpus hash 只覆盖 CASES，保持不变）：

| fixture | 内容 | 补 `project_id` |
| --- | --- | --- |
| mem_fx0c0001 / 0002 / 0003 | 游戏原型 UE5.6 / 主角长枪 / 代号逐日 | `p-alpha` |
| mem_fx0c0006 | 另一个项目使用 Unity | `p-beta` |
| mem_fx0c0009 / 0010 / 0012 / 0013 / 0016 | 项目预算 / 平台 PC / 水墨风 / 禁付费插件 / 东方幻想 | `p-alpha` |

其余 85 个夹具零改动。变更后 fixtures.json 新哈希将记入实施提交信息。预期效果：ps-010 转 PASS，`project_only_capability_gap_count` 1→0。

## 4. 不变量（实施必须证明）

1. 既有 249 项永久基线测试（十套）零修改、全部 PASS、0 skip；
   Gate 1 新增 32 项（19 trace + 13 eval）中 trace 19 项零修改全部 PASS；
   `test_memory_eval.py` 两处断言随本 ADR 演进（见 §10 D8），其余零修改；
2. 真实记忆（`memory/` 238 个文件）前后 SHA-256 字节级一致；
3. 永久冻结区（`sync-memory.py/ps1`、`guards.json`、`protocol-manifest.json`、`migrate-memory.py`、Clued v0.2.0 语义、既有基线测试断言语义）diff 为空；
4. legacy mode（global/project/session）过滤行为逐字节不变；
5. T0 零读取不破坏；无 Embedding/Vector DB/远端服务；离线可运行；
6. 秘密扫描零泄漏；NO_CHANGE → NO_WRITE 纪律不变。

## 5. 迁移预览

- **读侧**：零迁移。`project_id` 缺省 null = legacy 语义；真实 230 对象全为 global，任何 mode 下可见性不变。
- **写侧**：零既有对象改写。`object-index.json` 由既有 rebuild 幂等覆盖，无需手动迁移。
- **语料**：仅上文 9 个 fixture 增加一个字段；`migrate-memory.py` 不参与。
- **doctor**：`validate_object` 增加 `project_id` 类型校验（既有对象全 null → 零新增告警）。

## 6. 回滚方案

1. **代码/测试回滚**：本 ADR 全部实现收敛于**一个本地单一目的提交**；`git revert` 该提交即完整回滚（不改写历史）。
2. **数据回滚**：无任何数据迁移 → 无需数据回滚。
3. **语料回滚**：恢复原 fixtures.json（哈希 `BB51EF71…`）；引擎回滚后 ps-010 回到 Gate 1 基线"能力缺口"状态，与已封板报告一致。
4. **向前兼容**：回滚引擎但保留带 project_id 的对象/fixtures 不会破坏旧引擎（旧引擎忽略未知字段，`validate_object` 不拒绝额外字段）。

## 7. 测试计划（新增 `tests/test_project_scope.py`，覆盖计划 6 项强制测试）

1. `test_project_a_cannot_read_project_b`：p-alpha 查询不可见 p-beta 对象；Trace excluded 含 `PROJECT_MISMATCH`；
2. `test_project_content_does_not_affect_global_recall`：global 召回结果与 p-beta 高相关对象无关；
3. `test_project_switch_does_not_copy_objects`：写入/切换前后对象文件数与内容集合不变（零复制）；
4. `test_session_only_and_temporary_no_long_term_write`：session_only / temporary 写入被拒且零副作用；
5. `test_adapter_cannot_bypass_hard_filter`：经 CLIAdapter 调用的越界查询仍被过滤；跨项目约束不附着；
6. `test_trace_out_of_scope_only_safe_metadata`：excluded 无内容/秘密；
7. `test_legacy_scope_modes_unchanged`：global/project/session legacy 行为回归；
8. `test_session_only_visibility`：session_id 匹配/不匹配/global 可见性；
9. `test_temporary_mode_zero_reads`：炸弹探针证明零长期读取；
10. `test_fail_closed_missing_ids`：缺 project_id/session_id 即 ValueError；
11. `test_project_id_validation`：validate_object 类型校验；
12. `test_supersede_inherits_project_id` / `test_candidate_lookup_project_partitioned`：跨项目不串扰、supersede 继承分区；
13. `test_explain_equivalence_new_modes`：新 mode 下 explain=False/True 结果一致。

## 8. 实施边界

- 仅 MIV-006；不执行 MIV-005A/B 及任何其他任务；
- 真实记忆零修改；仅本地单一目的提交；不 push、不 tag、不 release、不 rebase；
- PASS 后立即停止并回报（计划 §12 模板）。

## 9. 产品所有者批准记录（2026-08-19）

1. **实施前**：产品所有者以询问选项答复「以 725df3d 为基线继续 MIV-006」
   （会话记录：问题 `baseline_hash`）——当时未展示 725df3d 完整取证内容，
   属程序性缺陷；
2. **复核**：产品所有者裁定 MIV-006 暂记 **HOLD / BASELINE_DRIFT**
   （执行基线与授权文本基线不一致），要求基线溯源；
3. **最终裁决**：接受基线修订——`ffba74bf` 保持 Gate 1 封板基线，
   `725df3d` 事后接受为 Gate 2R 执行基线；**MIV-006 技术结果 = PASS**；
   本 ADR 整体（D1–D6）与 D7 冻结语料对齐**事后接受**；725df3d 未经可证实
   授权的 push 登记为一次已解决的治理事件（不 revert / 不 reset / 不重写
   历史；执行计划本身不等于 push 授权）。

## 10. 实施增补（批准后记录，非重新裁决）

- **D8（测试断言演进）**：`tests/test_memory_eval.py`（Gate 1 自身新增的
  13 项之一，不属 249 永久基线）两处断言随本 ADR 演进：
  1. `test_scope_metric_split_contract`：`project_only_capability_gap_count == 1` → `== 0`（D7 声明效果）；
  2. `test_scope_mapping_contract`：`scope_to_engine` 返回 `("project_only", project_id)` 元组。
  其余 Gate 1 测试（含 trace 19 项）与 249 永久基线零修改。
- **D9（单提交口径）**：计划 §MIV-006 要求语料变更"单独提交"；Gate 2R 授权边界要求"只做本地单一目的提交"。二者冲突时以更保守的授权边界为准：MIV-006 全部变更（含 D7）收敛于一个本地提交，语料对齐在提交正文单独说明并给出前后哈希。
