# 下一窗口执行单 v2 —— 不是打补丁，是 window12 循环

**状态：`PLAN_SUPERSEDES_R29_SHEET_STEPS_3_TO_7`。R29 单的第 1-2 步（Status24 决策表与
受理件重钉工具）继续有效，其产出参数化后直接复用。**

## 为什么 v1 的「重钉受理件 + 第 21 次前推 + CP-02」不够 —— 三条系统性钉死（全部实测）

1. **`context.mjs:18` `qualificationLimits.forwards = 16`（控制器源内常量）**，且 `:214`
   在每个 series 检查点断言 `forwards.length <= 16`。第 21 次前推后为 17 → 一切操作全炸。
   改它 = 改控制器字节 = **冻结点离开 68133f2d**。
2. **`context.mjs:191` `root6Expiry = '2026-09-13T07:05:16Z'`**（同为源内常量），`:226` 的
   `FULL_600_SECOND_WINDOW_REQUIRED` 用它。新窗口下不改必炸 → 同样动冻结点。
3. **root6 注册体 `body.expires_at = 2026-09-13T07:05:16Z`**，`:62` `currentWindow` 直接
   校验注册体窗口；`GENERATION_REGISTERED` 不可重用（`generation_reuse_or_rollback`）→
   新窗口需**注册 root7**（新 ctrgen，烧授权，整套注册前置：签名绑定、Owner 批准 ref、
   独立受理 —— 与 root6 注册同构）。

推论：**冻结点必动**，则资格化件、运行时受理件、容量四件套（提案/批准×2/适用性/043）
的 `controller_digest` 全部随动重出 —— R29/R30 的受理件修复被这次重出**顺带吸收**
（late_bound 与 expected_ga 在重出时用生成器一次做对，不再打补丁）。

## v2 次序（每步工具已在本轮备齐或有直接先例）

0. G 会话交付：Status24 语义裁定（**不随冻结点变**）+ decisions.final + repin 工具
   （改为参数化到新冻结点使用）
1. **控制器 window12 版**：`qualificationLimits.forwards 16→17`、`root6Expiry→新窗口值`
   （待定钉，M3 后实化）、其余 22 文件不动 → 重建清单 → **新冻结点 F12**
   （build-linux-manifest.mjs 既有；四道闸 + 判别器全套重跑）
2. **文书全套按 F12 重出**（全部生成器化——本轮的字段规格/决策表/R26 教训内建）：
   容量四件套（`/root/project_list_auth_fix`）、资格化 + 受理件（`/root`；受理件一次做对：
   late_bound=S24、expected_ga.controller_qualification_ref=新资格化 sha、stage_receipt 去重
   裁定、authority_source_ref 裁定）
3. **M3 载体**（新 ExplicitOwnerApproval：window_rule 沿用、nw02 复用 NW-01 机制、
   **root7 generation_registration 条款（新 ctrgen 待造）**、cp02 编辑类：G3/B3 16→17、
   G2/B2/B7/B8/A4 窗口字面量→实化时间戳、G8/B9 root 对象摘要重钉至 root7 注册后实测值、
   forward_cap_extension 16→17 双侧）→ **Owner 合并 M3 开窗（T 实化）**
4. NW-02（accepted_binding 窗口前移，复用 NW-01 机制，同事务触发器恢复）
5. Status24 载荷定稿（T 已知，五项待定钉落地）→ S24 已在步 2 受理件内 —— 注意次序：
   **S24 依赖三代际与 T，受理件重出依赖 S24 → 步 2 的受理件在 M3 之前只能出到
   「除 S24/时间外全定」的版本，M3 后一条命令定稿再经 M4 上主干**（两次合并：M3 载体、
   M4 文书 —— 或文书 late_bound 之外先上 M3、S24 相关经 M4；由 G 的 repin 工具承担）
6. root7 注册（Owner 授权，step13 全套纪律：pre 14 项、exec 生成器、readback）
7. CP-02（derive 只读钉后像 → 生成 → 守卫事务 → 独立回读）
8. 第 21 次前推（生成器白名单→21、材料=F12 文书、publication=M4）
9. Status24 追加 → 步骤 16-20（预留授权、GA、600 秒授权、20 项 PQUAL、GRR）

## 需要 Owner 的动作（v2 版）

M3 合并（含 root7 注册与 cp02 授权条款）、M4 合并（定稿文书）、root7 注册执行授权、
预算预留授权、600 秒授权。

## 本单的诚实边界

- root7 的 ctrgen 造号与注册前置（签名绑定链）尚未逐项核 —— 步 3 起草 M3 载体时按
  root6 注册的实样逐项对照，缺什么列什么。
- `qualificationLimits.allocations=9`、`seconds=10506`：`:215` 的
  `charged_seconds===5106+600*budgets.length` 与现值 9906=5106+600*8 一致，第 9 次分配
  （budgets.length 8→9）恰达 10506 上限 —— **分配次数还剩 1，不因窗口更换而增减**，
  v2 不申请任何新容量。

## v2 增补（同日）：第 4/5 条钉死 —— issuer 资格件是本窗口的又一必炸点（实测）

4. **`context.mjs:15` `generation='ctrgen_5e0440a9…'`（源内常量）** —— root7 注册后必改
   → 又一处强制控制器字节变更（与钉 1/2 同归 F12 吸收）。
5. **`:317` 钉死两份 issuer 资格件摘要（STATUS=1640995831…，GATE_*=80cf8f47…）**。
   实测这两份件（blob c1749399 / 3ae8bd41）声明的是
   `control_trust_root_generation=ctrgen_e5df4322`（root5）且
   `expires_at=2026-09-11T10:21:05Z`（已过期）。而 `:319` 在 GRR 运行时同时断言
   `metadata.control_trust_root_generation===generation`（root6 ≠ root5 → 必炸）与
   `currentWindow(metadata.not_before, metadata.expires_at, Date.now())`（已过期 → 必炸）。
   **即：本窗口即使没有 R29，600 秒也会在 `:319` 处 EXACT_PURPOSE_QUALIFICATION 中止 ——
   R29 的停手（甲）恰好救下唯一一次分配。**
   root7 需要：新出两份 issuer 资格件（绑 root7 ctrgen、窗口覆盖新窗），digest 重钉进 F12。

## root7 注册前置清单（对照 root6 step13 实样逐项）

依赖序：**先造 root7 ctrgen 号**（仅造号不烧，`:15` 与 issuer 件都要引它，必须在 F12 冻结前定）
→ issuer 资格件×2 新出 → F12 冻结 → M3（开窗给 T）→ 注册体成型 → Owner 授权 → append_event。

| # | 字段 | root6 实样 | root7 来源 |
|---|------|-----------|-----------|
| 1 | generation_id | ctrgen_5e0440a9… | 新造号（冻结前定，注册时烧）|
| 2 | predecessor_generation_id / expected_sequence | e5df4322 / 5 | 5e0440a9 / 6 |
| 3 | body.predecessor.sha256 | 92186d46（root5 注册体）| root6 注册体摘要 —— 派生法即 G 决策表 #8；`:322` `canonicalDigest(root)` 为佐证（sorted+compact+LF）|
| 4 | history.prefix_digest/sequence | canonicalDigest(events[0..5]) / 5 | 活链只读取 events[0..6] / 6（`:59` 派生式已知）|
| 5 | expires_at / not_before / revocation | 07:05:16Z 窗 | M3 committed_at + 86400s（window_rule 沿用）|
| 6 | issuer_bindings×3 qualification_ref | root5 代 c1749399/3ae8bd41（已过期，见钉 5）| **新出×2**（STATUS 一份、GATE 两 purpose 共一份），绑 root7、新窗 |
| 7 | algorithm_config.accepted_config_ref | b25abb05 | 若 F12 重出该受理件则随动，否则沿用（G #9-11 裁定后定）|
| 8 | signature_binding | M(root6 注册)=cbe898d3 | M3 合并 sha + signed_object_sha256（体去 signature_binding 的 canonicalDigest）+ 证据 blob |
| 9 | owner_approval_ref | 71bf5384 | M3 ExplicitOwnerApproval（root7 条款）blob |
| 10 | independent_acceptance_ref | 44a637b8 | 评审会话独立受理件（新出）blob |
| 11 | metadata_binding_sha256 / idempotency_key | build-step13-sql.mjs 派生 | 同生成器，register-root7-window12-日期 |
