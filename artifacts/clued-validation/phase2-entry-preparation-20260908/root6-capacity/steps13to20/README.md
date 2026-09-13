# `steps13to20/` — 第 13–20 步的可执行件

**状态：`PREPARATION_ONLY_NO_WRITE_PERFORMED`。** 本目录不签发受理、不构成授权。
配套说明在上一级的 `Steps13To20ExecutionSheet.md`；**先读那份的第零节**（三条阻断项），
再用本目录任何文件。

## 运行次序

次序以 `bootstrap/next-window-20260912/OwnerOrderingAmendment.json` 为准，
不以 `ExecutionRunbook.md` 的散文为准。CP-01 在第 13 步之后、第 14 步之前。

| # | 前置（只读） | 执行 | 回读（只读） |
| --- | --- | --- | --- |
| — | `00-boundary-check.sql` | — | 会话首尾各一次，两次须一致 |
| 13 | `step13-pre.sql` | `step13-exec.sql`（由 `build-step13-sql.mjs` 生成） | `step13-readback.sql` |
| 13a | 自带断言 | — | `work/cp01/measure-root6-root-digest.sql`（只读，既有文件） |
| CP-01 | `cp01-pre.sql` | `work/cp01/cp01-apply.candidate.sql`（**仍是草案**，4 处占位符未解） | `cp01-readback.sql` |
| 14 | `step14-pre.sql`，输入取自 `step14-preimage-capture.sql` 与 `step14-control-plane-digests.sql` | `twentieth-forward-compact.mjs` 生成的 `real.sql`（先 `--dry-run`） | `step14-readback.sql` |
| 15 | `step15-pre.sql` | `append_status_manifest(<raw>,<sha>)` —— **`<raw>` 不存在，见执行单 §6** | `step15-readback.sql` |
| 16 | `step16-pre.sql` | `reserve_execution_budget(<raw>,<sha>)` | `step16-readback.sql` |
| 17 | `step17-pre.sql` | `reserve_gate(<ga_raw>,<sha>)` | `step17-readback.sql` |
| 18 | `step18-pre.sql` + 宿主四项字节检查 | 固定可信入口（**不是** `node cli.mjs`） | `step18-readback.sql` |
| 19 | `step19-pre.sql`（**每项之前都跑**）；GA id 取自 `step19-ga-id.sql`；material 逐键来源见 `step19-material-shape.md` | 同一入口 × **20** 次 `CURRENT_DISPATCH` | `step19-readback.sql`（每项之后） |
| 20 | `step20-pre.sql` | 同一入口，`operation='GRR'` → `commit_gate_result` | `step20-readback.sql` |

## 三条通用规则

1. **每次写后立即只读回读**，包括写失败或被切断的时候 —— 尤其是那时。这条规则先于本会话存在。
2. **被切断的写不得盲目重试。** 先回读，读清落没落，再决定。每份 `*-readback.sql` 的文件头写着
   该步三种结果各自的判定。
3. **前置任一列为假则该步不得执行。** 前置文件里的期望值写在文件头。

## 已验证的事

- 每一份 `.sql` 都**已在活库上通过解析与规划**（`prepare` / `deallocate`，或直接只读执行），
  所以不会在凌晨因语法或列名错误而失败。
- `step13-pre.sql` 的 13 列【实测】2026-09-12T23:58:04Z **全为 `t`**。
- `step13-readback.sql` 已只读实跑一次，返回 `landed=false` —— 即注册尚未发生，符合预期；
  同时证明那段 4 KB dollar-quoted jsonb 字面量能正确解析与转型。
- `cp01-pre.sql` 的三处锚点行号【实测】与 `cp01-substitutions.json` 所载
  （G3 第 48 行、B3 第 53 行、A4 第 29 行）逐一对上。

## 边界

未写库、未注册代际、未预留预算、未跑 600 秒、未签发 GA。对活库只发 `select`
（含 `prepare`/`deallocate` 的解析校验）。本目录不含任何猜测的摘要、时间戳或 id：
真正尚不可知的值只有 CP-01 的三个后像 prosrc 摘要与 GA id，两者的取法分别写在
`step14-control-plane-digests.sql` 与 `step19-ga-id.sql` 里。
