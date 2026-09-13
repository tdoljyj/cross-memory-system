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
