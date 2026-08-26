# Clued P0 外部只读 Benchmark Harness 汇总

- 固定 Commit：`a0ef54ae006451f0d7dedfeef65c79e0f89b4c37`
- 目标每桶次数：`20`
- cold：新进程；涉及状态的场景使用新 Fixture/空 Mirror。无法清空操作系统页缓存。
- warm：同一 Fixture 上先预热，但每次测量仍启动新进程，未复用跨请求 PASS 证据。

## 场景结果

| 场景 | 桶 | 实际次数 | 路径 | PASS | 预期阻断 | UNOBSERVABLE | p50 ms | p95 ms | 观测 Git 调用/次 |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|
| `dirty_worktree` | cold | 20 | expected_failure | 0 | 20 | 0 | 163.611 | 185.307 | status=1.00 |
| `dirty_worktree` | warm | 20 | expected_failure | 0 | 20 | 0 | 99.482 | 110.361 | status=1.00 |
| `latest_current` | cold | 0 | unobservable | 0 | 0 | 1 | — | — | — |
| `latest_current` | warm | 0 | unobservable | 0 | 0 | 1 | — | — | — |
| `manifest_corrupted` | cold | 20 | expected_failure | 0 | 20 | 0 | 43.538 | 58.812 |  |
| `manifest_corrupted` | warm | 20 | expected_failure | 0 | 20 | 0 | 41.253 | 48.229 |  |
| `memory_unrelated_implementation` | cold | 20 | success | 20 | 0 | 0 | 36.070 | 42.337 |  |
| `memory_unrelated_implementation` | warm | 20 | success | 20 | 0 | 0 | 35.013 | 39.697 |  |
| `network_unavailable` | cold | 20 | expected_failure | 0 | 20 | 0 | 3346.889 | 4182.915 | git-other=2.00, ls-remote=1.00, status=1.00 |
| `network_unavailable` | warm | 20 | expected_failure | 0 | 20 | 0 | 3374.684 | 4029.423 | git-other=2.00, ls-remote=1.00, status=1.00 |
| `post_copy_target_corrupted` | cold | 20 | expected_failure | 0 | 20 | 0 | 77.224 | 106.344 |  |
| `post_copy_target_corrupted` | warm | 20 | expected_failure | 0 | 20 | 0 | 76.419 | 81.375 |  |
| `process_startup_calibration` | cold | 20 | success | 20 | 0 | 0 | 23.636 | 26.455 |  |
| `process_startup_calibration` | warm | 20 | success | 20 | 0 | 0 | 25.672 | 27.646 |  |
| `remote_ahead` | cold | 20 | success | 20 | 0 | 0 | 1142.036 | 1360.381 | fetch=1.00, git-other=8.00, ls-remote=2.00, merge=1.00, merge-base=1.00, rev-parse=1.00, status=1.00 |
| `remote_ahead` | warm | 20 | success | 20 | 0 | 0 | 1107.775 | 1188.494 | fetch=1.00, git-other=8.00, ls-remote=2.00, merge=1.00, merge-base=1.00, rev-parse=1.00, status=1.00 |
| `remote_unchanged` | cold | 20 | success | 20 | 0 | 0 | 3472.837 | 3771.176 | git-other=4.00, ls-remote=2.00, rev-parse=1.00, status=1.00 |
| `remote_unchanged` | warm | 20 | success | 20 | 0 | 0 | 3342.997 | 4025.170 | git-other=4.00, ls-remote=2.00, rev-parse=1.00, status=1.00 |
| `snapshot_audit` | cold | 20 | success | 20 | 0 | 0 | 98.669 | 109.152 |  |
| `snapshot_audit` | warm | 20 | success | 20 | 0 | 0 | 80.706 | 104.919 |  |
| `snapshot_status_control` | cold | 20 | success | 20 | 0 | 0 | 101.209 | 108.500 |  |
| `snapshot_status_control` | warm | 20 | success | 20 | 0 | 0 | 102.864 | 107.879 |  |
| `t0_zero_read` | cold | 20 | success | 20 | 0 | 0 | 37.880 | 49.816 |  |
| `t0_zero_read` | warm | 20 | success | 20 | 0 | 0 | 42.965 | 51.860 |  |
| `t1_exact_read` | cold | 20 | success | 20 | 0 | 0 | 79.301 | 83.860 |  |
| `t1_exact_read` | warm | 20 | success | 20 | 0 | 0 | 80.863 | 112.350 |  |
| `t2_current_project_read` | cold | 20 | success | 20 | 0 | 0 | 79.270 | 99.712 |  |
| `t2_current_project_read` | warm | 20 | success | 20 | 0 | 0 | 80.886 | 92.255 |  |
| `t3_light_read` | cold | 20 | success | 20 | 0 | 0 | 77.631 | 85.289 |  |
| `t3_light_read` | warm | 20 | success | 20 | 0 | 0 | 78.536 | 81.506 |  |

## 阶段成本与占比

只有 Git Trace2 可从进程外可靠拆分。流式哈希、复制、原子切换和 Backup 在现有命令内部没有独立外部边界，均不猜测。

| 场景/桶 | Remote Head 占总耗时 | fetch/merge 占总耗时 | 其余总耗时 |
|---|---:|---:|---:|
| `dirty_worktree` / cold | 0.00% | 0.00% | 100.00% |
| `dirty_worktree` / warm | 0.00% | 0.00% | 100.00% |
| `manifest_corrupted` / cold | 0.00% | 0.00% | 100.00% |
| `manifest_corrupted` / warm | 0.00% | 0.00% | 100.00% |
| `memory_unrelated_implementation` / cold | 0.00% | 0.00% | 100.00% |
| `memory_unrelated_implementation` / warm | 0.00% | 0.00% | 100.00% |
| `network_unavailable` / cold | 94.35% | 0.00% | 5.65% |
| `network_unavailable` / warm | 95.99% | 0.00% | 4.01% |
| `post_copy_target_corrupted` / cold | 0.00% | 0.00% | 100.00% |
| `post_copy_target_corrupted` / warm | 0.00% | 0.00% | 100.00% |
| `process_startup_calibration` / cold | 0.00% | 0.00% | 100.00% |
| `process_startup_calibration` / warm | 0.00% | 0.00% | 100.00% |
| `remote_ahead` / cold | 14.89% | 31.21% | 53.90% |
| `remote_ahead` / warm | 15.71% | 32.15% | 52.15% |
| `remote_unchanged` / cold | 85.41% | 0.00% | 14.59% |
| `remote_unchanged` / warm | 87.01% | 0.00% | 12.99% |
| `snapshot_audit` / cold | 0.00% | 0.00% | 100.00% |
| `snapshot_audit` / warm | 0.00% | 0.00% | 100.00% |
| `snapshot_status_control` / cold | 0.00% | 0.00% | 100.00% |
| `snapshot_status_control` / warm | 0.00% | 0.00% | 100.00% |
| `t0_zero_read` / cold | 0.00% | 0.00% | 100.00% |
| `t0_zero_read` / warm | 0.00% | 0.00% | 100.00% |
| `t1_exact_read` / cold | 0.00% | 0.00% | 100.00% |
| `t1_exact_read` / warm | 0.00% | 0.00% | 100.00% |
| `t2_current_project_read` / cold | 0.00% | 0.00% | 100.00% |
| `t2_current_project_read` / warm | 0.00% | 0.00% | 100.00% |
| `t3_light_read` / cold | 0.00% | 0.00% | 100.00% |
| `t3_light_read` / warm | 0.00% | 0.00% | 100.00% |

## 关键外部观测

- `latest/current` 的在线 Canonical 路径未调用生产认证服务，标为 `UNOBSERVABLE`；只测了 Snapshot `status` 控制组。
- `remote_unchanged` 将 AGENTS 规定的外部 Remote Head 预检与现有 `pull` 放在同一请求测量，因而可直接观察重复查询。
- Manifest 与复制后目标损坏均在一次性 Fixture 上保持拒绝语义。
- `T0`/Memory 无关路径可观察到零 Git 子进程和零状态写入；文件读取 syscall 因无外部追踪器而不作猜测。
