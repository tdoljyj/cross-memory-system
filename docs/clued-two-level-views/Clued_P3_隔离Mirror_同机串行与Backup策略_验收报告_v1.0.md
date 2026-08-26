# Clued P3 隔离 Mirror、同机串行与 Backup 策略验收报告 v1.0

## 1. 第五轮复审候选裁决

`PASS / P3_SYNC_EXCEPTION_LKG_LOSS_FIXED_FOR_FIFTH_INDEPENDENT_REVIEW`

该裁决只表示第四轮阻断修复与本地验收门禁通过，不表示 P3 已获得第五轮独立复审通过，也不授权合并 `main`。

第四轮独立复审裁决为：

`FAIL / P3_FOURTH_INDEPENDENT_REVIEW_BLOCKED_BY_SYNC_EXCEPTION_LKG_LOSS`

固定被阻断候选为 `6acab22515d56b75c021d6921ade883855763b87`。本轮只在 `codex/p3-isolated-mirror-lock-retention` 追加一个普通线性修复 Commit，唯一父提交必须为该固定候选。最终 Commit、Tree、Blob 与 SHA-256 在提交后回执中记录；报告不预写自身 Commit。

## 2. 阻断复现与根因

第四轮候选已经修复真实进程崩溃恢复，但 `apply()` 的同步异常 `except` 仍维护第二套假设性回滚：先删除 target，再直接移动 Backup，最后删除 Candidate 和 journal。

当 `prepared` journal 已持久化，而第一次 `os.replace(target, backup)` 在移动发生前抛出 `PermissionError`/`OSError` 时，磁盘状态仍是：

- target：完整、已验证的唯一旧 LKG；
- Candidate：完整但未提交；
- Backup：不存在；
- journal：`prepared`。

旧 `except` 会删除仍有效的 target；Backup 不存在，无法恢复，随后又删除 Candidate 和 journal。同步异常矩阵已精确复现该路径，并冻结为 F32 回归。

## 3. 本轮实际变更范围

运行时与测试：

1. `isolated_mirror.py`
2. `tests/test_p3_isolated_mirror.py`

重生成或新增证据与报告：

3. `artifacts/clued-validation/p3/a9e12d85/p3_raw_results.jsonl`
4. `artifacts/clued-validation/p3/a9e12d85/lock_concurrency_ordering.json`
5. `artifacts/clued-validation/p3/a9e12d85/journal_crash_recovery_evidence.jsonl`
6. `artifacts/clued-validation/p3/a9e12d85/journal_sync_exception_recovery_evidence.jsonl`
7. `artifacts/clued-validation/p3/a9e12d85/SHA256SUMS`
8. 本报告

未修改 `memory/`、已发布 Snapshot、Manifest、正式 Current Pointer、根 `VERSION`、Cloud 应用源文件、数据库或 P1/P2 实现。

## 4. 单一 journal 恢复状态机

`apply()` 同步异常处理不再删除 target、Candidate、Backup 或 journal，也不再直接执行 `Backup→target`。异常处理只记录 `switch_transaction_failed`，然后调用与进程崩溃恢复完全相同的 `_recover_interrupted_switch()`。

journal phase 白名单继续只有：

- `prepared`
- `old-moved`
- `candidate-promoted`

路径、对象类型、旧 LKG 冻结证据和 phase/文件系统组合继续严格校验。关键确定状态为：

| journal phase | target | Candidate | Backup | 恢复动作 |
| --- | --- | --- | --- | --- |
| `prepared` | 有 | 有 | 无 | 原位置全量验证 target；保留旧 LKG；清理 Candidate/journal |
| `prepared`/`old-moved` | 无 | 有 | 有 | 原位置全量验证 Backup；恢复旧 LKG；清理 Candidate/journal |
| `old-moved`/`candidate-promoted` | 有 | 无 | 有 | 原位置全量验证 Backup；通过后才删除未提交 target 并恢复旧 LKG |
| `prepared`（首次安装） | 无 | 有 | 无 | 清理未提交 Candidate/journal，不产生成功状态 |
| `prepared`/`candidate-promoted`（首次安装） | 有 | 无 | 无 | 清理未提交 target/journal，不产生成功状态 |

任何非法 phase、路径越界、对象类型异常、冻结证据异常或无法唯一判断的组合都 fail-closed：审计 `switch_recovery_blocked`，抛出 `MirrorRecoveryRequired`/`manual-recovery-required`，不猜测性清理。

## 5. Backup 恢复与二次异常

Backup 必须先在原位置使用 recovery-only Request Context 完成全量验证。验证失败时当前 target 不被删除。

如果事务已经写入 `.clued-backup-record.json` 或 Backup control 元数据，恢复流程先完成第一次原位全量验证；随后移除不属于旧 Mirror 字节树的 Backup 元数据，再以新的验证边界完成第二次全量验证。两次均通过后才允许删除未提交 target 和移动 Backup。该合同保证 Backup record 写入后抛错时，恢复的旧 target tree digest 仍与切换前精确一致。

恢复移动或清理出现二次异常时：

- 不继续执行后续猜测性清理；
- 保留所有仍存在的 target、Candidate、Backup 和 journal；
- 审计 `switch_recovery_blocked`；
- 返回 `MirrorRecoveryRequired`/`manual-recovery-required`。

验证过的 Backup 在恢复移动前失败时保留在 `backup_root`，journal 保留，且没有 `mirror_switched`。下一独立进程会确定性恢复，或对仍歧义的状态继续明确要求人工恢复。

## 6. F32 同步异常矩阵

### 6.1 替换已有 LKG：8 个窗口

1. `after_prepared_journal` 抛 `RuntimeError`；
2. `os.replace(target, backup)` 在移动前抛 `PermissionError`；
3. 旧 target 已移动，`old-moved` journal 写入失败；
4. `os.replace(candidate, target)` 在提升前失败；
5. Candidate 已提升，`candidate-promoted` journal 写入失败；
6. Generation finalize 完成写入后抛错；
7. 最终 target 全量验证失败；
8. Backup record 完成写入后抛错。

八个窗口全部证明：

- 至少一个完整、已验证旧 LKG 始终存在于 target 或 Backup；
- `prepared` 与首次移动前失败时旧 target tree digest 精确不变；
- Backup 存在的后期窗口均先验证 Backup，再删除未提交 target；
- 自动恢复后的旧 LKG tree digest 精确一致且全量验证通过；
- Candidate、Backup、journal 清理符合明确状态合同；
- 没有新 Snapshot 的错误 `mirror_switched`；
- 锁可重新获取；
- 新的独立进程随后可完成新 Snapshot 切换。

### 6.2 首次安装：5 个窗口

覆盖 prepared 后异常、Candidate 提升前 replace 失败、candidate-promoted journal 写入失败、Generation finalize 失败和最终 target 验证失败。五个窗口均不创建 Backup、不留下成功状态；未提交 target/Candidate/journal 被确定性清理，下一独立进程可完成干净安装。

### 6.3 二次恢复异常

- 验证后的 `Backup→target` 移动失败：Backup 和 journal 保留，审计阻断，返回人工恢复要求；
- `prepared` Candidate 清理失败：旧 target digest 不变，Candidate 和 journal 保留，审计阻断。

## 7. 真实 `os._exit` 崩溃矩阵

原有真实子进程回归已重新执行，不以可捕获异常代替：

- 替换已有 LKG：5 个 `os._exit(86)` 窗口；
- 首次安装：3 个 `os._exit(86)` 窗口；
- 下一独立恢复进程验证旧 LKG、Candidate/journal/Backup 结果和锁状态；
- 无错误成功状态；
- 非法 journal、损坏 Backup 与歧义组合继续 `manual-recovery-required`。

## 8. P1/P2/P3 不变量

- P1：每请求一次 Remote Head 解析、ancestor/divergence 分类、dirty 写路径门禁、Remote unavailable、Malformed Ref、F05/F06 均保持 fail-closed。
- P2：Context 仍只在同一请求和信任边界内复用；Repository Source、Candidate、Local Mirror 独立验证；真实替换保持 `full=3/reuse=1`；新请求创建新 Context；standalone doctor 创建新 Context。
- Recovery Context：request-local、`allow_authoritative=false`，只验证 journal 冻结旧 LKG，不使用正式 Current Pointer，也不跨请求复用 PASS Evidence。
- NONE：零 Context、零 Git、零 Memory 读取。
- P3：隔离 Mirror、脏开发工作树不污染读镜像、跨进程独占锁、确定性 Generation/no-op、原子切换、Backup 有界保留、Hold/Erasure 审计和 Git Conflict Packet 均保持。

## 9. Backup Policy 冻结参数

版本化 Fixture/本地默认配置为：

- `policy_version`: `1.0.0`
- 最大保留数量：`3`
- 最大保留时间：`604800` 秒（7 天）
- 最低已验证 LKG：`1`
- Legal Hold 阻止删除：`true`
- Erasure：`delete-if-eligible`，仅在重新确认非当前 Mirror、非 Candidate、非唯一已验证 LKG后删除
- 删除、保留、跳过、Hold、Erasure 与失败原因全部审计

这些参数是显式本地配置和测试 Fixture 默认值，不被表述为生产事实；本轮未清理任何用户真实历史 Backup。

## 10. 完整门禁结果

| 门禁 | 结果 |
| --- | --- |
| P1（F01/F05/F06、dirty、Remote unavailable、Malformed Ref、真实 divergence） | PASS，15/15 |
| P2 全部专项与文档合同 | PASS，29/29 |
| P3（F02/F03/F04/F27/F32） | PASS，22/22，25.293s |
| 同步异常矩阵 | PASS，8 个替换窗口、5 个首次安装窗口、2 个二次异常场景 |
| 真实 `os._exit` 崩溃矩阵 | PASS，5 个替换窗口、3 个首次安装窗口 |
| Python 全量 | PASS，71/71，95.051s |
| PowerShell NONE | PASS，零读取 |
| `memory.py doctor` | PASS，710 个 Manifest 文件 |
| `sync-memory.py doctor` | PASS |
| Cloud verified build | PASS，243/183/235/189/182 modules |
| Cloud 离线回归 | PASS，63/63，2584.0139ms |
| Python compile | PASS，8 个文件 |
| `git diff --check` | PASS |

Cloud build 仅输出既有 Vite `configLoader: native` 前瞻警告，退出码为 0。

## 11. 证据

证据目录：`artifacts/clued-validation/p3/a9e12d85/`

- `p3_raw_results.jsonl`：第五轮修复门禁结论；
- `journal_sync_exception_recovery_evidence.jsonl`：同步异常矩阵与二次恢复失败证据；
- `journal_crash_recovery_evidence.jsonl`：重新执行的 8 个真实进程崩溃窗口及负向恢复；
- `lock_concurrency_ordering.json`：跨进程锁、并发顺序、同步异常与恢复锁证据；
- `mirror_generation_switch_records.jsonl`：Generation/no-op/切换记录；
- `backup_retention_audit.jsonl`：Backup 保留/删除/Hold/Erasure 审计；
- `conflict_packet_fixture.json`：Git Conflict Packet Fixture；
- `SHA256SUMS`：以上证据与本报告的 SHA-256。

各文件 Git Blob、最终修复 Commit、唯一父提交、Tree 与 SHA-256 由提交后回执列出。

## 12. 未执行事项

- 未合并 `main`，未创建 PR、Tag、Release，未部署。
- 未执行 P4–P6、Canonical Store、Worker、MCP、OAuth、数据库或 RLS 变更。
- 未生成、修改、切换或发布 Snapshot、Manifest 或正式 Current Pointer。
- 未访问生产，未清理用户真实 Backup。
- 未 amend、rebase、squash、force push 或历史重写。

本轮到此停止，等待第五轮独立复审。
