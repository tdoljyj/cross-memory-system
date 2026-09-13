# R29 裁定：甲 —— 本窗口到此为止；下一 Owner 窗口的修复执行单

**Owner 裁定原话：`甲`（2026-09-13T03:4xZ）。**
分配未烧：`charged_seconds` 9906/10506。本窗口（至 2026-09-13T07:05:16Z）不再对活库做任何写入。

## 本窗口终账（全部保留，下一窗口直接继承）

| 项 | 状态 | 凭证 |
| --- | --- | --- |
| root6 注册（步骤 13，Owner 授权） | 完成 | 事件序列 6，head 代际 `ctrgen_5e0440a9…`，回读 9 项字段级全真 |
| root digest 实测（13a） | 完成 | `pin_this_value 72355efd…`，`safe_to_pin true` |
| CP-01（载体 PR #158） | 完成 | 21 编辑单事务，三后像 `d5bba9ef`/`054c631a`/`4f9d2be6` 独立回读命中，`effective_execution_binding` 未动 |
| 第 20 次前推（步骤 14） | 完成 | 执行序列 89，活绑定 = `68133f2d`/`e7cfb30b`/`fb389314`，排练→无痕→真品→回读 |
| `verifySourcePublication` 端到端 | **史上首过** | 142 blob 全量经活 GitHub，153 路径双树比对，64.3s |
| 步骤 16 前置 1–4 | 全真留档 | 含以 `v.IMAGE`（`285a7132…`）真建容器 |
| M1 / M2 Owner 合并 | 完成 | `7c9f612b` / `88fc944b` |
| 死锁 R29 | 抓在烧钱前 | `R29LateBoundStatusPayloadDeadlock.md` |

## 下一 Owner 窗口的修复执行单（次序不可换）

窗口机制：下一次 Owner 合并（M3）按 NW 规则开新的 86400 秒窗口（T = M3 提交时刻）。
以下每一步的时间字段以那个 T 为准，本单只标待定钉，不发明值。

1. **定稿 Status24 载荷**（交付件 F 的继任）：
   - `schema_digest = 510f3b90…`（新 schema，CP-01 A1/A2 已容许）
   - `control_trust_root_generation = ctrgen_5e0440a9…`
   - `as_of` / `expires_at`：待定钉，= 新窗口
   - `observations`：`controller_digest 68133f2d…`、`profile/gate/scope` 沿绑定现值、
     `runner/credential/session_generation` = `execution_current` 现值（未变则沿用）、
     `stage_receipt_refs` = 受理件 `expected_ga.stage_receipt_refs`
   - `source_digests` 含四绑定摘要；`source_refs` 含 `stage_receipt_refs`+`scope_ref`+
     `controller_qualification_ref`+`authority_source_ref`（`:352-353`）
   - 算 `canonicalDigest(载荷)`（sorted+compact+LF）→ 记为 `S24`
2. **受理件重钉**（评审 `/root` 身份）：`late_bound_fields.status_manifest_ref.signed_payload_sha256 → S24`；
   同一编辑内复核 `control_schema_refs` 与 `expected_ga` 无随动错位；admin parser 往返；新 sha 记为 `ACC21`
3. **M3 Owner 合并**（开新窗口，发布重钉受理件 + Status24 载荷文件 + 本单）
4. **第 21 次前推**：生成器白名单 →21、guard exception 新名、材料 `runtime_acceptance → ACC21`；
   生成物先评审再执行（排练→无痕→真品）
5. **CP-02（需 Owner 新授权载体）**：`reserve_gate`/`reserve_execution_budget` 的
   G3/B3 `series_f>16 → >17`；比照 CP-01 全套纪律（derive 只读钉后像→生成→守卫事务→独立回读）。
   注意 G2/B2/B7/B8 的窗口字面量也要随新窗口改 —— CP-02 的替换表不止两条。
6. **Status24 追加**（`append_status_manifest`，其 `expires_at` 恰为新窗口值）
7. **步骤 16–20**：预留（Owner 授权）→ GA → 600 秒（Owner 授权）→ 20 项 PQUAL → GRR

## 下一窗口需要 Owner 的动作清单

1. M3 合并（开窗）
2. CP-02 授权载体（新的 ExplicitOwnerApproval 条款，覆盖 G3/B3 上限与窗口字面量类编辑）
3. 预算预留授权
4. 600 秒运行授权

## 遗留观察（不阻断，下一窗口顺带）

- `accepted_binding.expires_at` 与 root6 注册体 `expires_at` 均为本窗口值：新窗口下
  `NW-02` 类操作是否需要（比照 NW-01 的窗口前移机制）——步骤 4 之前必须核
  `fixed_nonproduction_window_required` 一族守卫对新窗口的要求；本单第 5 步的窗口字面量
  替换正是为此。
- `apps/clued-cloud` 的 `npm ci` 清单/锁不同步（`gcp-metadata`/`google-logging-utils`）仍未修。
