# Clued P3 隔离 Mirror、同机串行与 Backup 策略验收报告 v1.0

## 1. 裁决

`PASS / P3_ISOLATED_MIRROR_LOCK_RETENTION_ACCEPTED_FOR_INDEPENDENT_REVIEW`

本报告只验收 P3：隔离只读 Mirror、同机跨进程串行、确定性 Generation、失败恢复与本地 Backup 保留策略。未合并 `main`，未创建 PR、Tag、Release，未部署，也未触及 P4–P6、生产或 Canonical Store。

## 2. Git 基线与实现提交

- 仓库：`tdoljyj/cross-memory-system`
- 功能分支：`codex/p3-isolated-mirror-lock-retention`
- 开始时远端 `main`：`a9e12d8581c914dcbd5041324f20189c943261b8`（与授权基线精确一致）
- 固定基线唯一父提交：`1fc9c5faa4ba9e09f1bc69e1bdea69732111e214`
- P3 实现 Commit：`5062abc0ef19947ee2c3175480d97763cd57360a`
- P3 实现 Commit 唯一父提交：`a9e12d8581c914dcbd5041324f20189c943261b8`
- P3 实现 Tree：`cf3a99248b7242bbd429d5ced3f306d6301823f0`
- 提交方式：普通 Commit；未执行 merge、rebase、squash、amend、force push 或历史重写。

## 3. 实际变更文件

实现提交修改或新增 9 个文件：

1. `AGENTS.md`
2. `config/clued-local-mirror-backup-policy.json`
3. `isolated_mirror.py`
4. `memory.py`
5. `sync-memory.py`
6. `tests/test_p1_align_and_verify.py`
7. `tests/test_p2_verification_context.py`
8. `tests/test_p3_isolated_mirror.py`
9. `verification_context.py`

证据/报告提交新增指定 P3 证据目录下的 `p3_raw_results.jsonl`、`SHA256SUMS`、锁并发顺序、Mirror Generation/切换、Backup 保留审计、Conflict Packet Fixture 证据，以及本报告；并仅强化同一个 P3 测试文件中的独立 ACL 指纹失效断言。

未修改 `memory/`、任何已发布 Snapshot、Manifest、正式 `current.json`、根 `VERSION` 或 Cloud/数据库实现。

## 4. Backup Policy 冻结值

本轮权威配置为 `config/clued-local-mirror-backup-policy.json`，合同 `clued.local-mirror-backup-policy.v1`：

| 参数 | 冻结值 |
| --- | --- |
| `policy_version` | `1.0.0` |
| `max_retained_backups` | `3` |
| `max_retention_seconds` | `604800`（7 天） |
| `minimum_verified_lkg` | `1` |
| `legal_hold_blocks_deletion` | `true` |
| `erasure_mode` | `delete-if-eligible` |
| `audit_contract` | `clued.local-mirror-audit.v1` |

数量和时间是显式、版本化的本地默认值与测试 Fixture，不声明为既有生产事实。本轮未扫描、迁移或清理用户真实历史 Backup。

删除前会重新验证 Backup，并确认其不是当前 Mirror、Candidate 或最低保留的唯一已验证 LKG。Legal Hold 阻止删除；Erasure 仅在合格时删除。保留、跳过、删除、删除失败及原因均写入 JSONL 审计。

## 5. P3 行为

### 5.1 隔离读取

每个非 `NONE` 请求只执行一次真实 `git ls-remote origin refs/heads/main`，将该 SHA 传入 Git 对象获取和 `git archive`。读取的 `memory/`、正式指针、`VERSION` 与 endpoint trust 配置来自该不可变 Commit 的隔离临时 Capsule；开发工作树只用于 Git 历史分类，不复制其文件，也不移动其 HEAD、Index 或文件字节。

因此 Remote Ahead 且开发工作树 dirty 时，读请求可以更新独立 Mirror，但脏文件不会进入 Mirror。实现、提交、推送和写路径的 dirty-worktree 门禁仍保留。

### 5.2 串行、Generation 与 no-op

同一规范目标 Mirror 使用一个 OS 跨进程独占文件锁。Source、Candidate、Local Mirror 在同一请求 Context 内分别独立全量校验。Candidate 位于目标同卷临时目录；通过独立目标校验后，在锁内使用同卷 rename、持久化 switch journal 和最终目标重验完成协议原子切换。只有最终目标重验成功后才返回成功；任一中断均恢复旧 LKG，并清除 Candidate、journal 和错误成功状态。

Generation 顺序固定为：`build_epoch`、数值化 `canonical_version`、`snapshot_version`。相同 Snapshot 仅在 Generation、规范路径、目录/卷身份、Owner/Group/DACL 或 POSIX security identity、只读属性、Manifest、Snapshot Version 与内容证据仍有效时 no-op。不同 Snapshot 以该内在顺序决定最终版本，不以线程或进程取得锁的顺序决定。

真实替换才创建 Backup；首建与 no-op 都不创建 Backup。

### 5.3 Git 真分叉

Remote Ahead/Local Ahead/相等与 true divergence 保持 P1 ancestor 分类。true divergence 输出 `clued.git-conflict-packet.v1`，包含 Base、Local、Remote、双方变更路径、重叠路径与证据 SHA-256，并明确区别于 Canonical CAS Conflict；不自动 merge、rebase、覆盖或切换 Mirror。

## 6. P1/P2 不变量

- P1：一次 Remote Head 解析、显式 SHA 传播、ancestor/divergence 分类、Malformed Ref/Remote unavailable/Git divergence fail-closed 均保留。
- P2：每次请求创建新的 `RequestVerificationContext`；仅同一请求、同一进程、同一 Context、同一信任边界内复用。
- 真实替换验证计数保持 `full=3/reuse=1`；相同 Snapshot no-op 为 Source + 当前 Mirror 两次全量校验，即 `full=2/reuse=1`。
- 新请求产生新 Context；standalone doctor 创建新的 doctor-only Context。
- Repository Source、Candidate、Local Mirror 不共享 PASS Evidence。
- 不实现跨请求、跨进程、跨设备、跨 Agent 的 PASS Evidence 复用。
- `NONE` 继续为零 Context、零 Git、零 Memory 读取。
- F05/F06、Remote unavailable、Malformed Ref、真实 Git divergence 继续 fail-closed。

## 7. P3 明确改变的旧行为

唯一获准的旧行为变化是：脏开发工作树下的非 `NONE` 读路径不再因读取需要而拒绝或改写开发工作树，而是从固定 Remote Commit 的隔离 Git 对象源构建/验证 Mirror。测试同时证明开发 HEAD、Index、已暂存文件、未暂存文件和文件字节均不变，且脏内容没有被读取或复制进 Mirror。

旧的实现/提交/写路径 dirty gate 未移除。未出现其他未解释的“旧路径拒绝、新路径接受”。

## 8. 验收结果

### 正向、负向与并发

- F01：PASS；每个非 `NONE` 请求一次 `ls-remote`，请求内复用具体 SHA。
- F02：PASS；Remote Ahead/clean 更新隔离 Mirror，开发 HEAD、Index、文件字节不变，Candidate 校验后切换。
- F03：PASS；Remote Ahead/dirty 独立更新，dirty/staged 文件不进入 Mirror，开发状态完全不变。
- F04：PASS；真实 divergence 生成 Git Conflict Packet，旧 LKG Tree digest 不变。
- F05/F06：PASS；源损坏在复制前拒绝，复制后目标损坏拒绝并保留旧 LKG。
- F27：PASS；控制场景 no-op；Junction/Symlink 目标、相同字节目录替换、卷身份、ACL 安全描述符、只读属性、Mirror Generation 变化全部使 Evidence 失效。
- F32 同 Snapshot：PASS；两个进程结果为一次 `mirrored` 和一次 `noop`，最终一个 Generation、零重复 Backup。
- F32 不同 Snapshot：PASS；new-first 与 old-first 两种竞争顺序最终均为确定性较新 Snapshot，无交叉污染。
- 锁竞争/异常持锁进程：PASS；OS 释放异常进程锁，旧 LKG 不变。
- Candidate 损坏/切换中断：PASS；Candidate 被拒绝，switch journal 回滚，旧 LKG 全量验证通过。
- Backup：PASS；数量有界、至少一个已验证 LKG、Hold 不删除、Erasure 合格删除/唯一 LKG 跳过、删除失败原因审计。

### 回归门禁

| 门禁 | 结果 |
| --- | --- |
| P1 专项 | PASS，15/15 |
| P2 专项与文档契约 | PASS，28/28 |
| P3 专项 F02/F03/F04/F27/F32 | PASS，15/15 |
| Python 全量 | PASS，63/63，89.610s |
| PowerShell `NONE` | PASS，零 Context/Git/Memory 读取 |
| PowerShell 非 `NONE` | PASS，请求内同 Context；新请求新 Context |
| `memory.py doctor` | PASS，710 个 Manifest 文件 |
| `sync-memory.py doctor` | PASS |
| Cloud verified build | PASS |
| Cloud 离线回归 | PASS，63/63 |
| Python 编译 | PASS，8 个 Python 文件 |
| `git diff --check` | PASS |

Cloud build 输出两条 Vite `configLoader: native` 前瞻性兼容警告，构建退出码为 0；该警告与 P3 无关，没有测试失败或运行时错误。

## 9. Commit、Blob 与 SHA-256 证据

实现 Commit `5062abc0ef19947ee2c3175480d97763cd57360a` 的文件证据：

| 文件 | Git Blob | SHA-256 |
| --- | --- | --- |
| `AGENTS.md` | `7007225f55236d6132ae6ecb73f171102156d8a7` | `75d0788ff62a20d2d211115a66ab20fc38519a14fad890ab9a3d6f821e821793` |
| `config/clued-local-mirror-backup-policy.json` | `fc23b49406e64d568cfb4c637ef351c7f71d29c5` | `6c43db25ee9bb6f2e00b6a9754fa270b9b0458754e8bc518d25ce0a692157f66` |
| `isolated_mirror.py` | `07c42cecaa937975c937b4a37cb73e831c2ee8f6` | `4d591896417512766830b4aa07561a7f0df9dfa58cdd35ffacabb583c46d8627` |
| `memory.py` | `78ba99a8661a6bf427167cc491abde4299560367` | `53aa29022916e71273b2dfa98e941ccfd8fec9a8d253fb1c7b8c3db3e6873d5c` |
| `sync-memory.py` | `fae1ce01251736c3f5e9f8f828bb32dae9022e4c` | `336f183998e026718ab70b7737fedd4103974006158469518486942458665fb2` |
| `tests/test_p1_align_and_verify.py` | `7debd3fafd9018d1471d12d39ffb0be059892dbb` | `81ceed67c950abe6382397b8565bf69cbef629e13575589d4693186c6bbace8d` |
| `tests/test_p2_verification_context.py` | `77bd96bc893566b5db1b2c7885904e1ce9a04b6c` | `2d8952ff29a8f9cd300636892b0d1f97ca552a0ca50e7e78efd52733b0467548` |
| `tests/test_p3_isolated_mirror.py`（实现提交） | `c116cae13f60757717a67d5facf9680f7e8395f9` | `d6a415cf145ac7d9a7b4089427090605323bf5ce49a882a439c2f1e47e1e4a14` |
| `verification_context.py` | `1c4387c69d02ee7a954a26f93f022c7548ce9d4d` | `36e08c2590eccd786d5306229b44d2b832dc1f0b4ace860b0523f6ace91e8517` |

指定证据目录为 `artifacts/clued-validation/p3/a9e12d85/`。其中 `SHA256SUMS` 覆盖本报告以外的证据文件和本报告本身；最终证据提交与各文件 Blob 由提交后回执记录，不在文件内部预写自身 Commit。

## 10. 未执行事项

- 未合并 `main`，未创建 PR、Tag、Release，未部署。
- 未执行生产访问、Canonical Store、Worker、MCP、OAuth、数据库或 RLS 变更。
- 未实现 P4 Canonical-first、T1/T3 路由、Index/Routes、Freshness 语义、P5 写并发或 P6 发布/CAS。
- 未生成、切换或发布 Snapshot、Manifest 或正式 Current Pointer。
- 未清理任何用户真实历史 Backup；所有删除与 Hold/Erasure 均为隔离临时 Fixture。
- 未授权或实现跨请求、跨进程、跨设备、跨 Agent 的 PASS Evidence 复用。

P3 到此停止，等待独立审查与后续合并授权。
