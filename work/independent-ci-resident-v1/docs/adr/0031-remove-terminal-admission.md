# ADR 0031：删除终态准入；PR 结束时服务端直接释放认领

- 状态：已实现（分支 `claude/remove-terminal-admission`，未发布、未安装；迁移待应用）
- 日期：2026-11-13
- Owner Decision：统领原则（`42d5bf8d`：最终系统极简、低耗、高效，错误从机制上堵死）；Owner 同意用极简自动释放取代终态准入，不再靠代理记得释放
- 代码：迁移 `apps/clued-cloud/supabase/migrations/20261113151000_work_claim_terminal_admission_removed_v1.sql`；常驻 `src/full-admission-v2.mjs`、`src/admission-facts-v2.mjs`、`src/batch-claim-v2.mjs`、`src/independent-control-checks-v2/train-maintenance.mjs`、`train-sweep-store.mjs`；`scripts/ci/clued-merge-train-native.mjs`；Worker `apps/clued-cloud/worker/work-claims.ts`；钩子 `scripts/hooks/clued_work_write_set.py`；Agent 合同 v59
- 测试：`apps/clued-cloud/tests/work-claims-pr-end-release-db.test.mjs`（四个场景，见 §3）；常驻 `test/resident-v2-admission.test.mjs`、`test/scan-start-native-port.test.mjs`、`test/batch-claim-rewrite.test.mjs`、`test/train-sweep.test.mjs` 各一条“terminal admission removed”

## 1. 背景

终态准入（迁移 `20261108204157`）包住了 verify、authorize_head、租约密钥签发、adopt、merge_slot_return：持有者先声明“就绪”（`terminal_release_ready`），CI 准入时写终态准入收据，常驻把它一路带进批次认领、车头、落地记录，PR 结束时带着证明调 adopt/return，服务端再核对就绪、CAS、运行清单后才释放。上线后一次也没释放过任何认领（整链体检列出了恢复后也放不掉的五个原因），同一天两次挡住所有 PR（头授权不一致；扫描启动的字段清单拒收 `terminalAdmission`），随后被 `20261113144500` 暂停。

## 2. 决定

整条删掉，两侧一起：

- 服务端：每个包装恢复成原函数（authorize_head、密钥签发改名回原位；verify 只保留持有者编辑核对 `verify_edit`；adopt/return 回到包装前的函数体）；删除全部 `work_claim_terminal_*`、`work_claim_pr_terminal_apply_v1`、`*_before_terminal` 和索引 `clued_audit_receipts_work_claim_terminal_idx`。迁移末尾检查没有任何函数体还引用它们。
- 客户端：准入事实、批次认领记录、车头与落地记录回到固定字段；常驻第 10 段落地收尾回到“只在 push 模式、按最近 20 个落地批次 adopt”；adopt/return 只发固定字段，不再解析 `auto_release`；Worker 与 Agent 合同不再有 `terminal_release_ready`。

取而代之的是一条极简规则，写在 adopt（合入）和 merge_slot_return（关闭）里：PR→Task 绑定结束后（`work_claim_pr_finish_v1` 这次确实改了状态），对服务过这个 PR 的认领（对该 PR 有过头授权或 CI 准入、仍 ACTIVE）判断，同时满足就释放为 `completed`：

1. 该 Task 再没有 `active`/`unknown` 的绑定 PR；
2. 该认领在这个 PR 最后一次头授权或 CI 准入之后，没有再授权过别的、未撤销的 head。

收据是持有者自己的普通释放收据（`binding_id` 为持有者 Binding，`evidence_ref` 为 PR 引用，另记 `released_by_binding_id`），所以持有者 15 分钟内再认领同一 Task 是续认领，不耗额度。判断是辅助功能：在子事务里执行，出任何错都回滚判断本身、记一条 warning、当作“不释放”，adopt/return 的回答不变。没有持有者表态、凭证、跨仓库核对或“执行空闲”证明。

## 3. 测试

`work-claims-pr-end-release-db.test.mjs`：
1. PR 经 adopt 合入，认领自动释放，收据如上，持有者随后续认领（`continued_from`）；关闭经 return 同样释放。
2. 同一认领还有另一个打开的 PR：不释放。
3. 合入后又授权了新 head：不释放。
4. 释放判断内部出错（先写后抛）：adopt 照常成功、绑定已结束、认领原样。

另一条断言 verify、authorize_head、verify_edit 的回复里不再有 `terminal_admission*`/`terminal_release_ready`，带这两个字段的请求被拒；常驻侧各一条断言带 `terminalAdmission` 的事实、记录被拒。修复前 1、4 和断言条失败；2、3 是守护条件，修复前后都通过（修复前本来就不释放）。

## 4. 后果与上线顺序

- 先上客户端（Worker、常驻包、钩子），后上迁移。恢复后的 adopt/return、authorize_head 逐字段校验输入，会拒收 `terminal_proof`、`terminal_release_ready`；新客户端不发这两个字段，对旧服务端多回的 `terminal_release_ready`、`auto_release` 也不看，所以新客户端配旧服务端可以运行，反过来不行。
- 节点上残留的旧记录：`20261108204157` 到暂停之间写下的批次认领、车头、落地批次里若带 `terminalAdmission`，落地状态里若带 `terminalScan`，新包按固定字段把它们视为无效。批次认领只影响那个已结束的批次；车头记录按 PR/head 读取时跳过无效条，`latestFrontBatch` 失败时 claim-assist 原样返回；落地状态只在 `train.landing=push` 时读取，github-merge（默认）下不读。push 模式的节点若残留带 `terminalScan` 的最新落地状态，会报 `TRAIN_LANDING_STATE_UNREADABLE`，需要按通用重装清掉 train-sweep 状态。
- 残留一处：`scripts/ci/clued-pr-task-binding.mjs` 里的终态辅助函数（`normalizeTerminalAdmission`、`terminalAdmissionFromVerification`、`normalizeTerminalProof`、`terminalProofForPull`）及其测试已无人调用，但这个文件和它的测试被已登记的 merge-reconcile Source 按字节钉住（`clued-control-workflow-source.mjs` 的 `MERGE_RECONCILE_CONTROL_SOURCE`，`clued-control-source-pins.mjs` 不许把逻辑改动写进钉子）。删掉它们要登记一个后继 Source，单独做。
- `20261113142000`、`20261113143000`、`20261113144500` 留作历史，不改。
