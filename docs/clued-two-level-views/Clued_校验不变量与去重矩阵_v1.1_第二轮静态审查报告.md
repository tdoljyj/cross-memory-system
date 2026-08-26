# 《Clued 校验不变量与去重矩阵 v1.1》第二轮静态审查报告

- 审查日期：2026-08-26
- 审查对象：`Clued_校验不变量与去重矩阵_v1.1.md`
- 对象状态：`static_review_passed`
- 对象 SHA-256：`2e2205aeb73c1f36fc65816b2bc7243c05ce3645661b0854590fd05190879b1c`
- 固定事实基线：`tdoljyj/cross-memory-system@9f0e171b350b9dd462fc3ce184dd6ddb45ea4689`
- 审查结论：**R0–R5 全部通过；未发现高或中严重度遗留问题。候选版可作为 P0 的设计输入，但 P0 仍须另行授权。**

## 1. 边界与证据

本轮只审查候选文档，不修改仓库、脚本、Canonical Store 或生产环境，不执行 P0，不 Commit、Push、Tag、PR、Release 或部署。

审查输入：

- `Clued_校验不变量与去重矩阵_v1.0.md`
- `Clued_校验不变量与去重矩阵_v1.0_审查报告.md`
- `Clued_校验不变量与去重矩阵_v1.1_调整修改方案.md`
- 固定 Commit `9f0e171b350b9dd462fc3ce184dd6ddb45ea4689` 的仓库工程规范与固定链接身份

未把当前无效的本地 Memory Mirror 或未完成的 canon pull 当作本审查事实来源。

## 2. R0–R5 结果

| 门禁 | 结果 | 证据 |
|---|---|---|
| R0 纯文本关键修正 | PASS | 规则 4 改为“无受保护状态变化且未超 TTL”；七种 Context mode 与 `NONE` 零 Context 对齐；Schema 含 `live_rechecked_at`；分类拆成 3+5；P1/P3 门禁分离 |
| R1 追踪与测试补齐 | PASS | D01–D24 共 24 项；F01–F32 共 32 项；每个允许优化或路由调整的 D 项均有正向与负向证据；P0 使用可审计产物门禁 |
| R2 安全、并发与失效合同 | PASS | 复用限制为请求内；跨请求/进程/设备/Agent 禁止；G09/G10、F27/F32、实时撤销、Scoped Ref、时钟前跳/回拨、路径替换均已覆盖 |
| R3 现状、隐私与身份 | PASS（candidate） | 61 个不变量均含执行位置、当前状态和阶段；私有存量例外明确；仓库链接固定 Commit；候选版明确 `repository_identity: NOT_ASSIGNED`，未冒充 Gate |
| R4 性能与扩展路线 | PASS | P0 分解网络、进程、哈希、复制、切换；cold/warm 与成功/失败分开；不预设收益阈值；流式哈希为要求，增量校验留在受门禁未来项 |
| R5 第二轮静态审查 | PASS | Markdown 结构、围栏、表格、ID、Mode、D→F、阶段依赖、固定链接、当前态/目标态检查全部通过 |

## 3. 机械检查结果

| 检查 | 结果 |
|---|---|
| 文档行数 | 525 |
| 文档字节数 | 43,036 |
| Markdown 围栏 | 10 个，成对闭合 |
| 表格列数 | 所有连续表格行与表头一致 |
| 不变量定义 | 61 个；ID 无重复 |
| D 定义 | D01–D24 完整且无重复 |
| F 定义 | F01–F32 完整且无重复 |
| P 闭环记录 | P01–P20 完整且无重复 |
| D→F 引用 | 全部解析到已定义 F ID |
| 证据极性 | 所有 `ELIGIBLE_WITH_EVIDENCE` / `TARGET_ROUTING_CHANGE` 行均有正向和负向证据 |
| Mode | 7 个 Context mode 齐全；`NONE` 明确不生成 Context |
| 阶段依赖 | P1 不含 F02–F04；P3 明确包含 F02–F04 |
| 链接 | 无 `blob/main` 漂移链接 |
| 基线文件数口径 | “710”仅出现一次，且只作固定基线说明 |

## 4. P01–P20 复核结论

P01–P11、P13–P16、P20 已在候选正文中完全关闭。P12 与 P17 已完成文档级裁决，实际性能数据和增量实现继续受 P0/后续阶段门禁约束。P18 与 P19 已按候选生命周期正确处理：所有可解析的仓库引用固定到 Commit；候选版未取得入库路径、Commit 和 Blob SHA，因此明确禁止升级为 Gate Baseline。

两份仅以名称出现的外部合同（`Clued Product Continuity Contract`、`Clued Vendor-Neutral Agent Contract`）没有在输入或固定仓库中提供版本与获取位置。候选正文已将其标记为 `NOT_PROVIDED`，并规定在取得不可变身份前不得作为 Gate 证据。这是后续身份升级门禁，不构成本候选版逻辑缺陷。

## 5. 语义审查要点

- `NONE` 与 Verification Context 不再存在枚举冲突：它是路由模式，但不产生 Context。
- “请求内证据复用”不允许延伸为 Session、跨请求或跨进程持久 PASS。
- mtime、size、file watcher 与 USN Journal 只能用于提前失效，不能证明内容完整。
- 在线撤销没有模糊延迟窗口；`DENIED → LOCKED`，LKG 不可绕过。
- D10 no-op 绑定规范路径、卷/目录身份与 Mirror Generation，目录替换会触发完整验证。
- G09/G10 将同机并发切换和 Backup 保留纳入 fail-closed 合同；P0 明确不执行删除。
- P1 只验证统一入口和校验等价；隔离 Mirror 的 F02–F04 留在 P3，阶段依赖可达。
- P0 是外部只读 Harness；无法观测的指标标记 `UNOBSERVABLE`，不为取数改旧核心。

## 6. 裁决

`Clued_校验不变量与去重矩阵_v1.1.md` 满足本次调整方案的候选版完成条件：独立生成、保留 v1.0、R0–R5 通过、第二轮审查无高严重度问题、无中严重度遗留问题。

本裁决不授予仓库写入或 P0–P6 执行权限。后续只能在用户另行授权后执行以下二者之一：

1. 为候选版分配仓库路径并取得 Commit/Blob SHA，使其具备 Gate 身份；或
2. 以本候选版为输入启动 P0 外部只读测量。

## 7. 环境备注（不属于候选文档缺陷）

执行前的 T2 读前同步返回 `canonical snapshot invalid: legacy-root-entry:session`。因此本轮没有使用本地 Memory Mirror 作为当前事实来源，也没有擅自修复同步脚本或快照。该问题独立于本方案授权边界，应在单独的记忆同步修复任务中处理。
