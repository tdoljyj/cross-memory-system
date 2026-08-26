# P0 调用 → 不变量 → 证据矩阵

| 调用 | 场景 | 不变量 ID | 外部证据 |
|---|---|---|---|
| `sync-memory.py pull NONE` | t0_zero_read; memory_unrelated_implementation | A02, G01, U05 | 退出码、零 Git 子进程、零 Fixture 写入；syscall 级读取 UNOBSERVABLE |
| `memory.py recall --tier T1` | t1_exact_read | A05, S02, S15, U02, U05 | 完整性通过、sources_read 数量与分类、p50/p95 |
| `memory.py recall --tier T2 --project-id …` | t2_current_project_read | A05, S02, S15, U02, U05 | 项目选择已脱敏；sources_read 分类和耗时 |
| `memory.py recall --tier T3` | t3_light_read | A05, S02, S15, U02, U05 | 轻读取实际 sources_read 分类和耗时 |
| `memory.py status` | snapshot_status_control | A01, A02, S02, S07, O01 | 只证明只读 Snapshot 状态；不冒充在线 current |
| `memory.py doctor` | snapshot_audit | S02, S03, S04, S07 | Manifest 全枚举验证总耗时、文件数、退出码 |
| 外部 `git ls-remote` + 现有 `pull` | remote_unchanged | G01, G03, G05, G07 | Trace2 调用次数与 Remote Head 时间；Mirror/Backup 结果 |
| 本地 Fixture Remote Ahead + 现有 `pull` | remote_ahead | G01, G03, G05, G07 | 两次 Remote Head、fetch/merge 调用、最终祖先/HEAD 对齐 |
| 脏 Fixture + 现有 `pull` | dirty_worktree | G03, G04 | 在 git status 阶段明确阻断；未读取 Remote |
| 不可达 loopback origin + 现有 `pull` | network_unavailable | G01, O05 | UNAVAILABLE 错误、退出码、remote_head 阻断位置 |
| 损坏 Fixture Manifest + `doctor` | manifest_corrupted | S02, S03, S04 | 源完整性失败，未复制/切换 |
| 复制后损坏 Fixture 文件 + `doctor` | post_copy_target_corrupted | S05, S06, G07 | 目标哈希失败；旧真实目标未触碰 |
| 无生产调用 | latest_current | A01, A03–A08, O01–O08 | 缺少已授权 Canonical 测量接口，明确 UNOBSERVABLE |

所有拒绝结果均保留原命令退出码与脱敏 stderr；原始记录见 `p0_raw_results.jsonl`。
