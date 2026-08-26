# Clued P1 独立复验与合并 Closeout 报告 v1.0

- 日期：2026-08-26
- 固定复验 Commit：`3bf9b8f9382b6e2f3fb38f15aecdf12e7fb5d218`
- 固定父提交：`d96de2de7dbe8d49379e8aa4199b647b52214b2b`
- 合并方式：`fast-forward-only`
- 最终裁决：`PASS / P1_INDEPENDENT_REVERIFY_AND_FF_MERGE_CLOSED`

## 独立复验

在全新 detached 隔离工作树 `C:\Users\Windows\Documents\Codex\p1verify` 中检出固定 Commit。功能分支工作树未被修改。

| 门禁 | 结果 |
|---|---|
| Python 全量测试 | PASS，18/18 |
| P1 F01/F05/F06 专项 | PASS，7/7 |
| Clued Cloud 构建 | PASS |
| Clued Cloud 旧回归 | PASS，63/63 |
| `memory.py doctor` | PASS，710 个 Manifest 文件 |
| `sync-memory.py doctor` | PASS |
| PowerShell `-AlignAndVerify` 实际入口 | PASS |

PowerShell 入口在一次性本地 bare remote/clone 中执行两个独立成功请求和一个 Remote `UNAVAILABLE` 请求；三个请求的真实 `ls-remote` 次数均为 1。失败请求退出码为 1，未复用旧 SHA，已验证目标字节树保持不变。

F05 源哈希错误继续在复制前阻断；F06 复制后目标损坏继续在切换前阻断，Current Pointer 与旧 LKG 保持不变。dirty worktree、Remote 不可用和真实 Git divergence 均继续 fail-closed，Git divergence 未与 Canonical CAS Conflict 合并。

P1 原始性能证据独立重算为 40/40 PASS：cold 20、warm 20，每条记录均为一次 `ls-remote`，`SHA256SUMS` 校验通过。

## 合并与远端核验

合并前再次确认远端 `main` 精确为 `d96de2de7dbe8d49379e8aa4199b647b52214b2b`，功能分支精确为已审查 Commit。随后在 `main` 执行 `git merge --ff-only 3bf9b8f...` 并推送；没有 squash、rebase、merge commit 或历史重写。

推送后：

- 远端 `main == 3bf9b8f9382b6e2f3fb38f15aecdf12e7fb5d218`
- 本地 `main == 3bf9b8f9382b6e2f3fb38f15aecdf12e7fb5d218`
- 唯一父提交为 `d96de2de7dbe8d49379e8aa4199b647b52214b2b`
- 功能分支仍精确为原审查 Commit
- 真实 `main`、功能分支及 detached 复验工作树均干净

三个证据 Blob 未变：

| 证据 | Git Blob SHA |
|---|---|
| `docs/clued-two-level-views/Clued_P1_align-and-verify_验收报告_v1.0.md` | `68209899fb76ad7fd9163ad8d56d8be38cb5128a` |
| `artifacts/clued-validation/p1/d96de2de/p1_raw_results.jsonl` | `cd6cb39edc03213bc3cd6d156a3e96d45aa50b27` |
| `artifacts/clued-validation/p1/d96de2de/SHA256SUMS` | `62b371df1c514b7b60162abd7a914ef9b27b611f` |

本轮未执行 P2–P6、部署、Release、Tag、生产访问、Snapshot/Manifest/Current Pointer 修改或任何 Canonical/数据库变更。

**P1 独立复验与 fast-forward 合并 Closeout 完成；到此停止。**
