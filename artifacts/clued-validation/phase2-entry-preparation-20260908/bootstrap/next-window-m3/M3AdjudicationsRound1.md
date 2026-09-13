# M3 候选件裁定记录 · 第 1 轮（plan 作者 = 父会话，2026-09-13）

对象：H 会话交付 ab35028 的 `ExplicitOwnerApprovalM3.candidate.json` 及其
`M3DraftNotes.md` 第 10 节七个不确定点。本记录做出的每条裁定都标注依据；
**plan 作者裁定不替代独立评审** —— Round 32 评审会话须复核本记录全部内容。

## 不确定点 #1（cp02 三族增补类）→ 裁定：三族全部必需，plan v2 步 3 属遗漏

cp01-substitutions.json 字节证据（本会话实读）：

- `LIVE_ROOT_GENERATION` 族：G1/B1 的 from 串就是
  `series_view->'root'->>'generation_id' is distinct from 'ctrgen_e5df4322…'`
  （root5→root6 时钉过一轮）。root7 注册后 `root.generation_id` 变 → CP-01 后像里的
  root6 等值断言必 raise。**CP-02 必含此族。**
- 预算段族：G4/B4 的 from 串是 `sequence >= 64 → root_generation/expires_at` 双钉段。
  CP-01 后像同构地带 `>=89 → root6+本窗到期` 段；第 9 次预算落 sequence≥90、带 root7
  代与新窗到期 → 必被拒。**CP-02 必含此族**（阈值 90 已于 2026-09-13 对活库实测：
  全部 BUDGET_RESERVED ≤85，max(sequence)=89）。
- status schema 族：A1（三成员允许表加 root6 schema 摘要）/A2（新对象严格等值移到
  root6 schema）/A3（`control_trust_root_generation` distinct 钉）。F12 已改 schema
  的 ctrgen const → 摘要变为 7e5df5dd（对 6bbfeac 树实测）→ **CP-02 必含 A1/A2/A3
  同构三编辑。**

候选件中 `AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED` 状态**本轮不翻**：D6c 判别器
护着它，翻转动作留给 Round 32 独立评审在复核本节证据后执行（届时同步改 validator）。

## #2 charged_seconds → 已回填 9906

只读 select `clued_control.read_execution()`，测量时刻 **2026-09-13T04:52Z**（时间戳
记在本文件，载体内不写 —— A4 的无新时间戳规则在回填时真实拦截过一次带时间戳的注记，
判别器在实战中证明了可失败）。generation_id 测量时仍为 root6（未注册）。

## #3 algorithm_config ref → 已回填：沿用 root6 体的 b25abb05/988cdf82

依据 R31 #9-11 的沿用裁定与其条件钉。若后续任何轮次把该受理件纳入 F12 重出集，
此值必须重裁（已写进候选件 rule 字段）。

## #4 idempotency_key 日期段 → 约定：M3 合并日（与 root6 的 register-root6-window11-20260912 一致）

整值仍占位（依赖 T）；生成器实现时以此约定为准。

## #5 NW-02 先于注册的次序钉 → 裁定：加进载体

与 AWAITING 翻转同批（Round 32 一次编辑 + validator 同步），避免本轮多开一次
候选件结构改动。次序依据 plan v2 步 4/6 的既定顺序。

## #6 冻结前缀扩到 ≤6 → 留 Round 32 裁定（同构推演需独立确认，H 的判断本会话无异议）

## #7 路径 → 维持 next-window-m3/，owner_approval_ref 以最终路径解析（无动作）

## 本轮回填汇总（候选件 + validator 三方同步，validator 过且 10 判别器全火）

| 占位符 | 回填值 | 依据 |
| --- | --- | --- |
| LIVE_CHARGED_SECONDS | "9906" | 本文件 #2 |
| ROOT6_REGISTRATION_BODY_SHA256 | a93bfdda… | R31 #8（快照自验在案）|
| ROOT7_ALGORITHM_CONFIG_REF_DECISION | 沿用 b25abb05 | 本文件 #3 |
| F12_STATUS_MANIFEST_SCHEMA_DIGEST_DECISION | 7e5df5dd… | 对 6bbfeac 树 sha256sum 实测 |

占位符 32 → 28。`__PENDING_ROOT7_HISTORY_PREFIX_DIGEST__` 虽标「现在可测」，
本轮**不回填**：安全解析线是注册生成器世系（step13 同构）临 append 时实测 +
`:59` 活校验，父会话手工重构 events 数组的出错面不值得省这一步。
