# 保存输出评测编排候选

本目录只补 M2-10 的预登记槽位编排，调用已有 `run_saved`、评分器与数值统计。它不调用模型、不获取或加工真实数据、不运行设备测试、不训练、不发布、不签发 Gold、阈值、Domain Authority 或 Gate。

父任务本轮在线读回的 State `a4fb1177@1` 中，DatasetSplit 的正式非生产 owner 基线已登记，`DomainAuthorityReceipt` 仍为 `null / NOT_ISSUED`，M2、真实数据、模型、付费和训练权限均未授予。这段仅注明编写时的执行边界；后续实际工作必须重新读取在线权威状态，不能用本文件接替状态来源。

`run_harness(required_bindings, saved_runs, run_one, *, consumer)` 接受调用者预登记的本地参数投影。`run_one` 使用已有 `run_saved`。调用者必须事先核验实际 Source 字节、既有 Domain 对象、合法读取范围、原消费者与回调纯度；本地 JSON/字节摘要和回调对象身份不证明授权或纯度。

每个预登记槽位保留原 `suite_ref`、`workflow_ref`、适用子项 `requirement_refs`、固定控制、原 binding、完整 split、原 consumer 和输入样本身份。`saved_runs` 提供现有重放函数的参数，或带明确来源与原因的 `NOT_ADMITTED`。没有保存输出时保留 `EXTERNAL_INPUT_REQUIRED`，重放失败保留 `FAILED_SLOT`。它们不被删除、补测、算成通过或挑选赢家。

同一 `comparison_group` 固定 TaskSpec、WorkflowSpec、权限 scope、经权限过滤的 Context、输入样本身份、允许分支与副作用、调用/费用/token/bytes/deadline 预算，以及 split、用途、Gold、scoring、阈值、Profile、Source 和数值政策。组内仅执行器 provider/model/model_revision 身份与原输出/usage/snapshot 摘要允许不同。输入 `id` 是冻结评测样本身份，不重写提供方独立的 invocation 身份。

集合最终消费者必须与每个槽位的原消费者一致，并在对应 split 的 `allowed_consumers` 中。已知 `M3_SELECTION_PREPARATION` 不能以 `uses_for_selection=false` 重定义自身。选型集合只接受既有 development / selection_policy_validation 用途；包含 qualification、final_holdout、training 或 calibration_fit 的集合在任何重放前拒绝。因此不能先用合法独立验收消费者读取保留集，再通过混合汇总向 M3 泄露逐项、汇总或排名。

输出的 `ALL_REGISTERED_SLOTS_REPLAYED` 仅表示本次调用者预登记槽位完成了候选保存输出重放。它不证明下列计划要求完整覆盖。报告始终标记 `REGISTERED_SLOT_MANIFEST_ONLY`、`formal_suite_workflow_coverage=NOT_ESTABLISHED`、`authority_effect=NONE` 与 `qualification=NOT_ISSUED`。未取得的 Gold、Threshold、Profile 和控制引用单独保留。

采用计划 SHA-256：`a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`。以下为 §11.4 / §17.9 的要求定位，标题与逻辑键不是本候选新注册的机器枚举、Capability、Suite Authority 或 Gate。

| §11.4 Suite | 完整原要求；须由真实预登记引用与实际证据逐项证明 |
| --- | --- |
| Clued Core | 语卡；卡链；印记；Context；Information Flow；路由与升级；严格结构化输出。 |
| General Sanity | 中文；英文；中英混合；基本逻辑；指令遵循；自然表达；事实性和不确定性。 |
| Safety & Privacy | Prompt Injection；Secret 索取；Scope 扩大；跨用户/跨项目泄漏；训练数据复现；高风险动作误放行；虚构来源；伪造 Receipt；不当工具参数；删除和撤销后的影响。 |
| Device & Runtime | 包体；内存；延迟；吞吐；能耗；温度；Crash；恢复；离线；更新；回滚。 |
| Product E2E | 自然语言→语卡→用户修改→我的语卡；多 AI 结果→印记编译→来源与冲突；语卡→卡链→模型检查→Kernel 预检→执行→Receipt；手机发起→PC 处理→手机接收结果。 |

| §17.9 Workflow / §1.7 逻辑定位 | 必须独立保留的义务 |
| --- | --- |
| 语义关系建议 / decision.semantic_relation | 同一事实不同时点、明确取代、仅补充、条件生效、未批准候选、冲突未决、撤回；只输出待确认关系候选，核对伪造权威引用与反证遗漏，不改变实际权威状态。 |
| Context 相关性 / decision.context_relevance | 同一经权限过滤候选集合及 token/bytes 预算比较排序与选择；固定下游执行器检查约束遗漏、冲突保留、答案/任务正确性和总延迟。消融不证明绝对最小充分；不写语义索引或接生产 Canonical 读取链。 |
| 处理路径 / decision.processing_route | 代码给定允许路径含复杂处理、人工、unresolved；覆盖简单、歧义、缺证据、超时、提供方不可用、云回退不被许可、预算耗尽。拒绝与预算硬边界逐项核验，不被平均速度或质量抵消；不得创造工具动作。 |

三项任务都保留所有预登记分支。改动 workflow 变量须进入独立获准实验并重新绑定，不能混入仅换执行器的对照。外部模型一致性只能辅助，不替代独立 Gold 与业务损失。最终保留测试不成为 M3 的选型、调参、排名输入；修改候选不沿用旧最终资格或重命名旧集冒充未见数据。

本机必要测试仅验证这些编排语义。14 个测试使用已有数值规范例，正例实际调用既有 `run_saved` 与统计函数；覆盖缺失槽位、未准入、失败、控制漂移、消费者边界、回调突变、空引用和不完整/假重放载体。不生成 Dataset/Gold，不调用模型，不构成五 Suite、三 Workflow 的正式 Eval、M2-13 独立数据复核或任何产品资格。

仓库接入：`scripts/model-program/saved_harness.py` 复用同目录既有报告重放实现；`tests/test_model_program_m2_saved_harness.py` 使用真实仓库路径和私有依赖加载器。既有 M2 source-fixture 套件只追加本 14 项，命令为 `python -m unittest tests.test_model_program_m2_scoped_consumer -v`，完整预计 94 项（28 + 30 + 22 + 14）。工作流、Role、冻结 SourceLock 和四个注册消费者保持原定义。
