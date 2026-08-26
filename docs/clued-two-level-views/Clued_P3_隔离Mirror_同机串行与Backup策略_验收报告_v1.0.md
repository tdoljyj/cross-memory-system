# Clued P3 隔离 Mirror、同机串行与 Backup 策略验收报告 v1.0

## 1. 第四轮复审候选裁决

`PASS / P3_PREPARED_JOURNAL_LKG_LOSS_FIXED_FOR_FOURTH_INDEPENDENT_REVIEW`

本裁决只表示阻断修复及本地门禁通过，不表示 P3 已获独立复审通过，也不授权合并 `main`。P3 必须等待第四轮独立复审。

第三轮独立复审裁决已记录为：

`FAIL / P3_INDEPENDENT_REVIEW_BLOCKED_BY_PREPARED_JOURNAL_LKG_LOSS`

固定被阻断候选为 `ce33299b280f98e67c6c0121c78d8fbf594ac2d3`。本轮仅在 `codex/p3-isolated-mirror-lock-retention` 上追加一个普通线性修复 Commit；该 Commit 的唯一父提交必须是上述固定候选。最终 Commit、Tree 与修复文件 Blob 由提交后回执记录，报告不预写自身 Commit。

## 2. 原阻断复现

原实现先持久化 `phase=prepared`，随后才执行 `os.replace(target, backup)`。如果进程在两步之间崩溃，磁盘状态为：

- journal：`prepared`
- target：存在且是已验证旧 LKG
- Candidate：存在
- Backup：不存在

旧恢复代码只检查 Backup 是否存在；Backup 不存在时会删除 target，再删除 Candidate 和 journal。测试已用真实子进程 `os._exit(86)` 复现该窗口。该行为违反 F32、最低一个已验证 LKG 与 fail-closed，第三轮报告中“任一中断均恢复旧 LKG”的无条件表述已撤销。

## 3. 修复范围

运行时代码与合同：

1. `isolated_mirror.py`
2. `memory.py`
3. `sync-memory.py`
4. `verification_context.py`

测试：

5. `tests/test_p2_verification_context.py`
6. `tests/test_p3_isolated_mirror.py`

重生成证据与报告：

7. `artifacts/clued-validation/p3/a9e12d85/p3_raw_results.jsonl`
8. `artifacts/clued-validation/p3/a9e12d85/lock_concurrency_ordering.json`
9. `artifacts/clued-validation/p3/a9e12d85/journal_crash_recovery_evidence.jsonl`
10. `artifacts/clued-validation/p3/a9e12d85/SHA256SUMS`
11. 本报告

未修改 `memory/`、已发布 Snapshot、Manifest、正式 Current Pointer、根 `VERSION`、Cloud 应用或数据库文件。

## 4. 明确 journal 状态机

journal phase 白名单只有：

- `prepared`
- `old-moved`
- `candidate-promoted`

journal 必须满足：

- `contract` 精确匹配；
- `target` 字符串与规范目标精确匹配；
- Candidate 是 target parent 的直接子目录，且名称匹配 `.{target}.candidate-*`；
- Backup 如存在，必须是 `backup_root` 的直接子目录并匹配 `backup-*`；
- target、Candidate、Backup 不得是 Junction、Symlink 或非目录对象；
- 替换已有 LKG 时，journal 冻结旧 LKG 的 Generation ID、Snapshot Version、Manifest SHA-256、Remote Head、目标身份 SHA-256 和只读身份 SHA-256；
- phase、是否存在旧 LKG以及 target/Candidate/Backup 实际存在状态必须属于下表的确定性组合。

### 4.1 替换已有 LKG

| journal phase | target | Candidate | Backup | 恢复动作 |
| --- | --- | --- | --- | --- |
| `prepared` | 有 | 有 | 无 | 在原 target 位置全量验证并确认身份；保留旧 LKG，仅删除 Candidate 和 journal |
| `prepared` | 无 | 有 | 有 | 在 Backup 原位置全量验证；验证通过后恢复至 target，再次全量验证，清理 Candidate/journal |
| `old-moved` | 无 | 有 | 有 | 同上，恢复已验证 Backup |
| `old-moved` | 有 | 无 | 有 | 先在 Backup 原位置全量验证；通过后才删除未提交 target 并恢复旧 LKG |
| `candidate-promoted` | 有 | 无 | 有 | 先在 Backup 原位置全量验证；通过后回滚未完成 Candidate 并恢复旧 LKG |

### 4.2 首次安装、没有旧 LKG

| journal phase | target | Candidate | Backup | 恢复动作 |
| --- | --- | --- | --- | --- |
| `prepared` | 无 | 有 | 无 | 删除未提交 Candidate 和 journal，不产生成功状态 |
| `prepared` | 有 | 无 | 无 | 删除已提升但未提交的 target 和 journal，不产生成功状态 |
| `candidate-promoted` | 有 | 无 | 无 | 删除最终验证前的 target 和 journal，不产生成功状态 |

`old-moved` 不允许描述首次安装。

任何未列出的组合、非法 phase、路径越界、冻结证据异常或对象类型异常都抛出 `manual-recovery-required`。该路径只追加阻断审计，保留 target、Candidate、Backup 和 journal，不执行猜测性删除。

## 5. Backup 原位置校验与 P2 Context

恢复 Backup 前，代码先在 Backup 当前原位置完成全量验证，并对照 journal 冻结的旧 LKG 证据。只有通过后才允许删除当前未提交 target 或执行 `Backup→target` rename。恢复至 target 后还会重新全量验证并确认原 target 路径身份；失败时保留现存对象和 journal，要求人工恢复。

恢复验证使用新的 request-local `AUDIT_FULL` Context：

- endpoint trust、Owner Ref、Bundle Scope、授权与完整性校验继续生效；
- 正式 Current Pointer 不用于旧 LKG 恢复，因为它属于新请求 Snapshot，不能错误拒绝历史 LKG；
- journal 冻结的旧 Snapshot/Manifest/Generation/Remote/身份取代“当前 Pointer”成为恢复期预期值；
- `allow_authoritative=false`，恢复 Context 不能创建 Source Envelope，也不能产生 `authoritative=true`；
- 恢复 Evidence 不进入新 Snapshot 的 Source、Candidate 或 Mirror 边界，不跨请求复用。

恢复完成后，新请求仍使用原 P2 Request Context 分别全量验证 Repository Source、Candidate 和最终 Local Mirror。真实替换继续保持 `full=3/reuse=1`；`NONE` 仍为零 Context、零 Git、零 Memory 读取。

## 6. 真实子进程崩溃 F32

所有崩溃均由独立 Python 子进程调用 `os._exit(86)`，不是抛出可捕获异常。下一独立子进程只执行恢复，并验证锁可重新获取。

### 6.1 替换已有 LKG：5 个窗口

1. `prepared` 已持久化，旧 target 尚未移动；
2. 旧 target 已移动，`old-moved` 尚未持久化；
3. `old-moved` 已持久化，Candidate 尚未提升；
4. Candidate 已提升，`candidate-promoted` 尚未持久化；
5. `candidate-promoted` 已持久化，最终验证尚未完成。

五个窗口全部证明：

- 下一独立进程恢复后旧 LKG Tree digest 精确一致；
- 旧 LKG 全量验证通过；
- 新 Snapshot 没有错误 `mirror_switched` 成功事件；
- Candidate 和 journal 清理结果确定；
- Backup 恢复后不残留伪 Backup；
- `interrupted_switch_recovered`、phase、outcome 与锁审计一致；
- OS 锁可再次独占获取。

### 6.2 首次安装：3 个窗口

覆盖 prepared 前提升、提升后未写 phase、写入 candidate-promoted 后最终验证前。三个窗口均无错误成功状态；恢复清理未提交 Candidate/target/journal，随后另一独立进程可完成干净安装并全量验证。

### 6.3 负向恢复

- Backup 在原位置被损坏：恢复拒绝；当前 target digest 不变；Backup 与 journal 均保留。
- 非法 phase、target mismatch、Candidate 越界、Backup 越界、旧 LKG 冻结证据异常、phase/文件系统歧义：全部 `manual-recovery-required`，不删除任何可恢复对象。
- 下一新 Snapshot 请求：先用 recovery-only Context 恢复旧 LKG，再用新的 P2 Context完成新 Source/Candidate/target 验证与切换。

## 7. 完整门禁结果

| 门禁 | 结果 |
| --- | --- |
| P1 专项（含 F01/F05/F06、Remote unavailable、Malformed Ref、divergence） | PASS，15/15 |
| P2 专项与文档合同 | PASS，29/29 |
| P3 专项（F02/F03/F04/F27/F32） | PASS，20/20 |
| 真实 crash recovery 窄门禁 | PASS，5/5 测试方法，8 个 `os._exit` 窗口 |
| Python 全量 | PASS，69/69，99.530s |
| PowerShell NONE/非 NONE | PASS |
| `memory.py doctor` | PASS，710 个 Manifest 文件 |
| `sync-memory.py doctor` | PASS |
| Cloud verified build | PASS |
| Cloud 离线回归 | PASS，63/63 |
| Python compile | PASS，8 个 Python 文件 |
| `git diff --check` | PASS |

Cloud build 仍仅输出与 P3 无关的 Vite `configLoader: native` 前瞻警告，退出码为 0。

## 8. 不变量与限定结论

- 对状态机列出的真实崩溃窗口，恢复会保留或恢复旧 LKG并重新全量验证。
- 对无法唯一判断的组合，不声称自动恢复；系统 fail-closed、保留现有对象并要求人工恢复。
- Backup 在原位置验证失败前，不会删除当前 target。
- 不产生错误成功状态，不跨请求复用 PASS Evidence。
- 开发工作树 HEAD、Index、tracked status、P3 实现文件字节、Snapshot Manifest 和正式 Current Pointer 哈希在 crash Fixture 前后不变。
- P1 一次 Remote Head 和 divergence fail-closed、P2 Request Context、F05/F06、F27、Backup Hold/Erasure/最低 LKG 均继续保留。

## 9. 证据

证据目录：`artifacts/clued-validation/p3/a9e12d85/`

- `p3_raw_results.jsonl`：第四轮修复门禁原始结论；
- `journal_crash_recovery_evidence.jsonl`：8 个真实崩溃窗口、损坏 Backup 和歧义矩阵；
- `lock_concurrency_ordering.json`：并发、异常进程和恢复锁证据；
- `mirror_generation_switch_records.jsonl`：Generation/no-op/切换记录；
- `backup_retention_audit.jsonl`：Backup 策略审计；
- `conflict_packet_fixture.json`：Git Conflict Packet；
- `SHA256SUMS`：本轮证据与本报告 SHA-256。

各证据文件的 Git Blob、SHA-256、最终修复 Commit、唯一父提交与 Tree 由提交后回执列出。

## 10. 未执行事项

- 未合并 `main`，未创建 PR、Tag、Release，未部署。
- 未执行 P4–P6、Canonical Store、Worker、MCP、OAuth、数据库或 RLS 变更。
- 未生成、修改、切换或发布 Snapshot、Manifest 或正式 Current Pointer。
- 未访问生产，未清理用户真实 Backup。
- 未 amend、rebase、squash、force push 或历史重写。

本轮到此停止，等待第四轮独立复审。
