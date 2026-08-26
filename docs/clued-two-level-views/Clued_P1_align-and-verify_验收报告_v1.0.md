# Clued P1 `align-and-verify` 验收报告 v1.0

- 验收日期：2026-08-26
- 授权范围：P1-ENFORCED，仅统一 `align-and-verify` 与消除同一请求内重复 Remote Head 查询
- 基线仓库：`tdoljyj/cross-memory-system`
- 基线分支：`main`
- P0 Closeout Commit：`d96de2de7dbe8d49379e8aa4199b647b52214b2b`
- P0 裁决：`PASS / P0_CLOSEOUT_ACCEPTED`
- P1 功能分支：`codex/p1-align-and-verify`
- 最终裁决：`PASS / P1_ALIGN_AND_VERIFY_ACCEPTED_FOR_INDEPENDENT_REVIEW`

## 1. 基线与范围门禁

实施前，远端 `refs/heads/main` 精确解析为 `d96de2de7dbe8d49379e8aa4199b647b52214b2b`；固定 P0 Closeout Commit 是远端 `main` 的祖先，且当时与远端 Head 相等。实现建立在独立功能分支与独立工作树中，没有覆盖或丢弃其他变更。

本轮只修改 Git 读前对齐调用链、统一入口、测试和 P1 证据。未修改 `memory.py`、`memory/`、Manifest 内容、正式 Snapshot、M2 Current Pointer、Canonical Store、Worker、MCP、OAuth、数据库、RLS 或生产配置。

## 2. 修改前调用链与重复原因

修改前，同一个 T1–T4/current/audit/implementation 请求按仓库合同执行：

```text
AGENTS 读前预检
  → git ls-remote origin main                 # 第 1 次 Remote Head
  → 必要时 fetch/merge
  → sync-memory.ps1 -Pull
      → sync-memory.py pull
          → git status
          → git ls-remote origin main         # 第 2 次 Remote Head
          → rev-parse / fetch / ancestor / merge
          → 源 Manifest 全哈希
          → copy
          → 目标 Manifest 全哈希
          → 原子切换 / Backup
```

两次查询均解析同一请求、同一仓库、同一 Ref 的具体 Commit SHA，保护同一个 G01“不在一次操作中以 tracking ref、mtime 或旧 SHA 代替远端 Ref”不变量。第二次查询没有跨越新的信任边界，也没有保护额外不变量，因此属于 D01 真重复。

活动实现另有一处 `cmd_commit_repo()` 的 post-push `ls-remote`。它发生在 push 之后，保护“已推送提交是远端真实 Head 的祖先”这一独立后置边界，不属于 D01，P1 完整保留。

## 3. 修改后调用链

```text
sync-memory.ps1 -AlignAndVerify -Access <scope>
  → sync-memory.py align-and-verify
      → git status --porcelain
      → resolve_remote_head()
          → git ls-remote origin refs/heads/main    # 本请求唯一一次
          → 严格解析 40 位具体 Commit SHA
      → align_to_remote(remote_sha)                 # 显式参数，无全局缓存
          → git rev-parse HEAD
          → 若不同：git fetch origin <remote_sha>
          → 校验 FETCH_HEAD == remote_sha
          → 双向 merge-base --is-ancestor
          → 仅 fast-forward/正常 merge 该 remote_sha；真分叉阻断
      → 源 Manifest 全哈希
      → copy
      → 目标 Manifest 全哈希
      → 原子切换 / Backup
      → 输出本请求 remote_head
```

`pull` CLI 与 PowerShell `-Pull` 继续作为兼容入口，但都只转发至同一 `align-and-verify` 请求入口，不再形成第二条对齐路径。每个新请求、独立重试和新进程都会重新执行 `resolve_remote_head()`；没有 TTL Cache、持久缓存、Session 缓存或跨 Agent PASS 复用。

## 4. 保留的完整性与失败检查

| 检查/错误域 | P1 结果 |
|---|---|
| Remote `UNAVAILABLE` | 保留，查询失败显式分类并阻断；无旧 SHA 降级 |
| Remote Ref 具体 SHA | 新增严格 40 位 Commit SHA 解析；空值/畸形值阻断 |
| dirty worktree | 保留，且仍在远端查询前阻断 |
| fetch 绑定 | fetch 只消费本请求 `remote_sha`；`FETCH_HEAD` 不一致时阻断重试 |
| Git ancestor/divergence | 双向 ancestor 判断保留；真分叉继续以 Git divergence 单独阻断 |
| Canonical CAS Conflict | 未触碰，未与 Git divergence 合并 |
| 源 Manifest/枚举文件哈希 | 保留，在复制前完整校验 |
| 复制后目标独立哈希 | 保留，不复用源 PASS |
| 原子切换与异常恢复 | 保留原语义；P1 未实现 P3 改造 |
| Current Pointer / 已验证 LKG | 故障注入中保持不变且继续可验证 |
| post-push Remote 验证 | 保留 `ls-remote` 与 `merge-base --is-ancestor` |

不存在以 mtime、本地 tracking ref、旧 SHA 或跨请求状态替代远端查询的路径。

## 5. F01、F05、F06

| Gate | 结果 | 证据 |
|---|---|---|
| F01：同请求 Remote Head 未变 | PASS | 20 cold + 20 warm 均为 `ls-remote = 1`；两个独立单元请求共查询 2 次；第二请求未复用第一请求；查询失败无旧结果回退；真实 Remote Ahead 只查询一次并对齐同一 SHA |
| F05：源 Manifest 枚举哈希错误 | PASS | 一次性 Fixture 修改源枚举文件；`canonical snapshot invalid` 在 copy 前阻断；无成功输出、切换或 Backup；旧目标字节树不变 |
| F06：复制后目标损坏 | PASS | 源校验通过后由测试替身损坏临时目标文件；`local candidate invalid` 阻断；临时目标清理；Current Pointer 不变；原已验证 LKG 字节树不变并重新校验通过 |

F02–F04 仅作旧行为回归：真实 Remote Ahead 仍在当前工作树 fast-forward；dirty worktree、网络不可用和真实 divergence 均继续阻断。P1 没有实现隔离 Mirror、新锁或新分叉处理机制。

负向集合检查覆盖 Remote 不可用、畸形 Ref、dirty、真实 divergence、源哈希失败和目标哈希失败；没有发现“旧路径拒绝、新路径接受”。成功后置条件仍为 Remote SHA 对齐、源完整性通过、复制后目标独立完整性通过，再执行原有切换。

## 6. 旧回归与 doctor

| 命令/套件 | 结果 |
|---|---|
| `python -B -m unittest discover -s tests -v` | PASS，18/18（P1 13 + 既有 root cutover 5） |
| `python -B memory.py doctor` | PASS，Snapshot `snap_f6134235591bfcbfe4ba3a674383c3e0` / Canonical `cv_155`，710 个 Manifest 文件 |
| `python -B sync-memory.py doctor`（隔离的空 local mirror 路径） | PASS |
| `vinext build` | PASS |
| `node --test tests/*.test.mjs` | PASS，63/63 |
| `python -m py_compile sync-memory.py` | PASS |

Cloud 构建和测试只验证旧回归；没有修改 Cloud 源码、数据库或生产环境。

## 7. P1 性能复测

测量口径与 P0 Remote 未变化场景一致：cold 使用新 endpoint 与空目标，warm 复用 endpoint/目标但每次仍启动新进程；每桶 20 次；单调时钟计时；Git Trace2 只统计外部可观测调用。所有 40 次业务结果均为 `mirrored / snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155`，Remote Head 均为固定基线 SHA。

| 桶 | P0 p50 ms | P1 p50 ms | P0 p95 ms | P1 p95 ms | P0 `ls-remote`/请求 | P1 `ls-remote`/请求 | P0 Remote Head 占比 | P1 Remote Head 占比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cold | 3472.837 | 1951.432 | 3771.176 | 2225.881 | 2.00 | 1.00 | 85.41% | 76.84% |
| warm | 3342.997 | 1874.053 | 4025.170 | 2491.683 | 2.00 | 1.00 | 87.01% | 78.08% |

p50/p95 使用 P0 相同的线性插值算法；Remote Head 占比为桶内 Trace2 `ls-remote` 总耗时除以桶内进程总耗时。完成门槛不要求固定延迟降幅；本轮关键门槛 `ls-remote = 1.00` 与校验等价均满足。

业务结果等价：P0 与 P1 的 Remote 未变化样本均全部成功并输出相同 Snapshot/Canonical 身份。错误结果等价：P0 已记录的 dirty、UNAVAILABLE、源 Manifest 损坏和复制后目标损坏拒绝语义，在 P1 自动化负向测试中继续拒绝；真实 divergence 仍为独立 Git 错误域。

## 8. 变更文件与 SHA-256

| 路径 | 用途 | SHA-256 |
|---|---|---|
| `AGENTS.md` | 将外部预检与 pull 合并为统一请求入口 | `45aa9289660330efe10907dc5ca427f015066600df51b00d46ea6bdb37f73940` |
| `sync-memory.py` | `resolve_remote_head`、显式 SHA 对齐和统一入口 | `6fc9aa697821bc16637fd89017111f2e1f183052d63d2a170614b3dccbea76d0` |
| `sync-memory.ps1` | PowerShell 显式 `-AlignAndVerify` 入口与 `-Pull` 兼容转发 | `48ffc824dee7ee66632299677c5f770de605d8ae2a413746b7a6b737528082ab` |
| `tests/test_p1_align_and_verify.py` | F01/F05/F06 与负向回归 | `e77cb8cd1226e6fe2bb7238a68689c25397026c25242a5c655194373e6bd68c1` |
| `artifacts/clued-validation/p1/d96de2de/p1_raw_results.jsonl` | 40 次逐次原始性能结果 | `a3234b78858fc7c339f513dd8f838c5772fc63bfc1badb1bda48f2455d546f93` |
| `artifacts/clued-validation/p1/d96de2de/SHA256SUMS` | 原始结果不可变哈希清单 | `a11cc132c1774e4050d9bbfc423a6d0c6fa70a29a037d1109421579d0c05f2d9` |

本报告自身的 Git Blob SHA 与文件 SHA-256 在提交后由 Git 和最终验收输出绑定，避免正文形成自引用哈希。

## 9. 阶段边界与最终裁决

本轮没有实现 P2 Verification Context、TTL/持久缓存、P3 隔离 Mirror/锁/Backup/no-op/原子切换改造、P4 T1/T3 或 Canonical-first 路由、P5 租户/Binding/Scope/RLS/CAS/幂等/并发写，亦未执行 P6 Shadow、Canary、Release、Tag、部署或生产访问。

未修改任何正式 Snapshot、Manifest 内容或 Current Pointer；未合并或推送到 `main`。

**裁决：`PASS / P1_ALIGN_AND_VERIFY_ACCEPTED_FOR_INDEPENDENT_REVIEW`。P1 到此停止；等待独立审查与用户另行授权合并。**
