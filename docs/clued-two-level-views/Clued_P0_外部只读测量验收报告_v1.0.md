# Clued P0 外部只读测量验收报告 v1.0

- 验收日期：2026-08-26
- 验收范围：Clued《校验不变量与去重矩阵 v1.1》P0 Closeout
- 最终裁决：`PASS / P0_CLOSEOUT_ACCEPTED`
- 后续门禁：`P1–P6 LOCKED`；须另行明确授权

## 1. 固定基线身份

| 项目 | 固定身份 | 验收结果 |
|---|---|---|
| 仓库 | `tdoljyj/cross-memory-system` | PASS |
| 分支 | `main` | PASS |
| 固定 Commit | `a0ef54ae006451f0d7dedfeef65c79e0f89b4c37` | PASS；验收开始时为远端 `main`，且为远端祖先 |
| v1.1 矩阵 Blob | `fbc8493625a94f6f8cc4cea031d44d19756c4519` | PASS |
| 第二轮静态审查报告 Blob | `6a259f70ab3bc3286683f22cb9093f0d95f1c668` | PASS |
| P0 执行 Manifest SHA-256 | `696ca3115af7fdc5233d35657228dd96b27351900f375488c5185b6b67dff8c4` | PASS |

远端 `main`、固定 Commit 和两个 Git Blob 在 Closeout 动手前重新核验，未自行选择或替换版本。

## 2. 独立重算结果

验收端直接解析 `p0_raw_results.jsonl`，未采用汇总报告中的预计算数字作为事实源。

| 指标 | 独立重算 | 结果 |
|---|---:|---|
| 原始记录总数 | 562 | PASS |
| 成功路径 `PASS` | 400 | PASS |
| 预期阻断 `EXPECTED_BLOCK` | 160 | PASS |
| `UNOBSERVABLE` | 2 | PASS |

各 cold/warm 桶次数：

| 场景 | cold | warm | 结果 |
|---|---:|---:|---|
| `process_startup_calibration` | 20 | 20 | PASS |
| `t0_zero_read` | 20 | 20 | PASS |
| `t1_exact_read` | 20 | 20 | PASS |
| `t2_current_project_read` | 20 | 20 | PASS |
| `t3_light_read` | 20 | 20 | PASS |
| `snapshot_status_control` | 20 | 20 | PASS |
| `snapshot_audit` | 20 | 20 | PASS |
| `memory_unrelated_implementation` | 20 | 20 | PASS |
| `remote_unchanged` | 20 | 20 | PASS |
| `remote_ahead` | 20 | 20 | PASS |
| `dirty_worktree` | 20 | 20 | PASS（预期阻断） |
| `network_unavailable` | 20 | 20 | PASS（预期阻断） |
| `manifest_corrupted` | 20 | 20 | PASS（预期阻断） |
| `post_copy_target_corrupted` | 20 | 20 | PASS（预期阻断） |
| `latest_current` | 1 | 1 | PASS（均为 `UNOBSERVABLE`） |

Remote 场景独立重算：

| 场景 | 桶 | p50 ms | p95 ms | `ls-remote`/次 | Remote Head 成本占比 |
|---|---|---:|---:|---:|---:|
| Remote 未变化 | cold | 3472.837 | 3771.176 | 2.00 | 85.41% |
| Remote 未变化 | warm | 3342.997 | 4025.170 | 2.00 | 87.01% |
| Remote Ahead | cold | 1142.036 | 1360.381 | 2.00 | 14.89% |
| Remote Ahead | warm | 1107.775 | 1188.494 | 2.00 | 15.71% |

实测证实：当前一次请求路径存在两次 Remote Head 查询。该事实只形成 P1 建议，不在 Closeout 中删除或改写任何调用。

## 3. P0 完成门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| 固定 Commit 与两个 Blob 已验证 | PASS | §1 固定身份 |
| 执行 Manifest SHA 与枚举哈希全部匹配 | PASS | 7 个 Manifest 枚举文件逐项匹配；Manifest 自身 SHA 匹配 |
| 必测场景完成或明确不可观测 | PASS | 13 个必测场景；可执行桶 20 次，`latest/current` 两桶明确不可观测 |
| cold/warm、成功/失败路径分离 | PASS | 562 条逐次 JSONL 与 §2 桶计数 |
| 故障场景保留原拒绝语义 | PASS | dirty、UNAVAILABLE、Manifest 损坏、目标损坏共 160 次预期阻断 |
| 原始数据、日志与 Harness 可提交 | PASS | 8 个源文件扫描；Token、Secret、完整邮箱、Owner Ref、原始 Supabase User ID 均为 0 命中 |
| 七类报告与原始结果齐全 | PASS | 本报告 §6 路径与哈希 |
| 真实仓库核心、Snapshot、Current Pointer 与生产未改 | PASS | P0 执行 Manifest 前后树摘要一致；Closeout 仅新增证据与本报告 |
| 未实施 P1–P6 | PASS | 无核心脚本、路由、校验、Recall、发布或生产变更 |

## 4. 两项 UNOBSERVABLE

1. `latest_current / cold`：未调用生产 Clued Canonical/Auth/Binding/Scope/RLS 接口，不能以 Snapshot status 冒充在线 current。
2. `latest_current / warm`：同上；warm 不持久化或复用跨请求 PASS 证据。

此外，现有命令没有可从进程外可靠分开的流式哈希、复制、原子切换和 Backup 计时边界；这些内部阶段继续按 `UNOBSERVABLE_SEPARATELY` 处理，不猜测占比。

## 5. 分类与后续阶段边界

- T1 实测读取范围热点归属 **P4**；P0 记录 `sources_read` 现象，不修改 Recall。
- T3 轻读取范围热点归属 **P4**；不在 P1 顺手收窄。
- Snapshot 未变化仍复制并产生 Backup 的问题归属 **P3**；不在 Closeout 改动 Mirror 或 Backup 策略。
- Canonical-first / 在线 `latest/current` 路由归属 **P4**；不以 Git 或 Snapshot 代替在线 Canonical。
- P1 只允许在后续单独授权后处理统一 `align-and-verify` 和同一请求内重复 Remote Head 查询，并完整保留 G01、ancestor/divergence、故障阻断与 F01/F05/F06 门禁。

本任务没有实现 `align-and-verify`，没有删除第二次 `ls-remote`，没有执行 P1–P6。

## 6. 不可变证据路径与 SHA-256

仓库目录：`artifacts/clued-validation/p0/a0ef54ae/`

| 证据路径 | SHA-256 |
|---|---|
| `artifacts/clued-validation/p0/a0ef54ae/clued_p0_harness.py` | `b75d9453436eb2c31f446fa7b6fe748ff6e511f2771ce8a720e94d79e46070a0` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_raw_results.jsonl` | `6e29c05fb9cda250033d0cc03428ec82492edbc21fc6e1b3b20a88c6e6a67238` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_summary.md` | `4540137f19133c68e02cca9a4420572a0e3202fa5fa09492c3eb4abf7d140301` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_invariant_evidence_matrix.md` | `4de3d0f2e4723d5b5bedf766d9bbe8cc65ccbe155a356c7fbe8c0b0912a5dca8` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_classification.md` | `268bf4b2140df1ff60b22aa570788f5193c216df246bcd89f005b9afac2566db` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_limitations.md` | `fc76ae1bb733135f5e80386f36ae6982d22b0176becb65499b2145f4392a2e27` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_p1_priority_recommendations.md` | `f5c3b675c257f0b7de9c02604bb91b9fa081ab1139244baab85a96396068afd1` |
| `artifacts/clued-validation/p0/a0ef54ae/p0_execution_manifest.json` | `696ca3115af7fdc5233d35657228dd96b27351900f375488c5185b6b67dff8c4` |
| `artifacts/clued-validation/p0/a0ef54ae/SHA256SUMS` | `487998421e7e1e15d5b338a9f40d79a905f206fc8b3893724f73828f54fabf87` |

`SHA256SUMS` 枚举八个原始 P0 文件；其自身 SHA 记录在本验收报告中，避免递归自哈希。

## 7. 最终裁决

P0 固定输入、原始记录、统计、故障阻断、局限、分类与建议均通过独立验收，证据具备不可变入库条件。

**裁决：`PASS / P0_CLOSEOUT_ACCEPTED`。P0 到此关闭；P1–P6 继续锁定，等待用户另行授权。**
