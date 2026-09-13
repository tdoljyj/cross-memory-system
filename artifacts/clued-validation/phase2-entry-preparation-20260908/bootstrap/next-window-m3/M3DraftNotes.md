# M3 载体候选件起草说明（会话 H，2026-09-13）

对象：`ExplicitOwnerApprovalM3.candidate.json`（同目录）。本说明逐条给出条款依据；
所有拿不准的点集中在最后一节，均未拍板。本会话只写文件：无任何库写、无 append_event、
无 PR、无合并，未动 `work/` 与 `context.mjs`。

模板：`bootstrap/next-window-20260912/ExplicitOwnerApproval.candidate.json`（下称 NW-01 载体）。
凡未在下文单独说明的结构与措辞，均为对该模板的同构沿用。

## 1. window_rule —— 沿用

- 逐字段沿用 NW-01 载体 :25-:35（86400 秒、非滚动、不 auto_renew、不 backdate、
  merge committed_at 为 not_before 源）。
- 新增三个 `materialized_*` 占位字段，及取值来源说明（merge commit 的
  `commit.committer.date` 而非 PR `merged_at`）：依据
  `work/cp01/cp01-substitutions.json:308-323`（window_placeholder_resolution 实测：
  merged_at 晚一秒，不是来源）。
- 载体内不得出现 T 本身：任务纪律 + validator A4 用历史时间戳允许集强制。

## 2. previous_authorization

- owner_merge_commit `cbe898d3…`、PR 158、窗口 2026-09-12T07:05:16Z → 2026-09-13T07:05:16Z：
  `cp01-substitutions.json:311-316`。
- `amended_by` 指 `OwnerOrderingAmendment.json`（该文件 :7-:13，修 must_not_precede 一条）。
- 「第三次 continuation、R29 停手未耗最后一次分配」：
  `NextWindowPlanV2Window12Cycle.md` 诚实边界节（分配剩 1，不随窗口增减）与提交
  bb193dc（R29 决策甲）。

## 3. nw02 条款

- 机制整体复用 NW-01 载体 :62-:82：同一行（accepted_binding）、同一组
  allowed_changed_fields（7 个）、allowed_replaced_checks（3 个）、同名触发器停/复
  同事务、fail_closed。
- 字段值全部 `__PENDING_*__`：七个字段的实值全部依赖 T 或 M3 后产物。
- 增补 `transaction_guards_required_beyond_nw01`：R11-F12（事务内窗口断言）与
  R11-F13（唯一非内部触发器断言，前后块）——依据
  `cp01-substitutions.json:325-376`，其中明确记载 NW-01 回读把这两项记为「欠下一个
  同形事务补上」；NW-02 正是下一个同形事务。

## 4. generation_registration（root7）条款

- 代号 `ctrgen_26769cc7109ced40bc4016b2af678198`（已造未烧）：`F12PinInventory.md:3`。
- predecessor `ctrgen_5e0440a95ac8ee257b9e4236cabd275b`、expected_sequence 6、
  generation_ordinal 7：任务钉 + 前置清单表第 2 行（root6 实样为 e5df4322/5，见
  `steps13to20/step13-exec.sql:11` 中 `"predecessor_generation_id":"ctrgen_e5df4322…",
  "expected_sequence":5,"generation_ordinal":6`），root7 顺推一位。
- `must_not_precede: NONE` + ordering 子句（注册先于 CP-02）：直接采纳
  `OwnerOrderingAmendment.json` 的裁定与理由（实测无可破坏路径、量测代替投影、
  消灭只能靠注册成功才能离开的中间态）；plan v2 次序（步 6 注册、步 7 CP-02）与之一致。
  注册本身仍需独立评审 + 单独的 Owner 执行授权（step13 纪律），写进了条款。
- registration_body_prerequisites 逐项对照 step13-exec.sql 实样与 plan v2 前置清单
  11 项表：
  - predecessor.sha256 = root6 注册体摘要，派生法 G 决策表 #8、`:322` canonicalDigest
    佐证（表第 3 行）→ 占位；
  - history prefix = canonicalDigest(events[0..6])/6（表第 4 行，`:59` 派生式）→ 占位
    （需活库读）；
  - issuer 件×2 必须新出：钉 5 实测（`NextWindowPlanV2Window12Cycle.md` 增补节：
    c1749399/3ae8bd41 绑 root5 且 2026-09-11T10:21:05Z 已过期，`:319` GRR 时双断言必炸）；
  - revocation.event_set_digest 沿用 `37517e5f…`（root6 体中的空撤销集摘要，
    step13-exec.sql:11）；
  - signature_binding / owner_approval_ref / independent_acceptance_ref /
    metadata_binding / idempotency_key 全部按 root6 体同构、占位（表第 8-11 行）。

## 5. cp02 条款

- 三个 permitted_edit_classes 严格按任务/plan v2 步 3 的钉名写：
  1. `BINDING_FORWard…16_TO_17`（G3/B3）——现值实测：
     `R29LateBoundStatusPayloadDeadlock.md:28`（series_f 现值 16，活库 G3 为
     `series_f>16` 拒）；
  2. 窗口字面量类（G2/B2/B7/B8/A4）——类名沿用 cp01（`cp01-substitutions.json:98`），
     本窗到期值 2026-09-13T07:05:16Z 是被替换对象；G7 与 B7 保持字节可比的处理沿用
     cp01 G7 注记（:127）；
  3. `FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_ROOT7_POST_REGISTRATION_MEASURED_VALUES`
     （G8/B9）——形态完全沿用 Round10 裁定 (e) 的三断言结构
     （`cp01-substitutions.json:132-146/222-236`）：冻结前缀现在覆盖 sequence≤6
     （root6 注册事件的 recorded_at 一经写入即冻结）、事件数断言 6→7、只有
     root.events[sequence=7] 的 recorded_at 离开摘要域，carve-out 理由三条原样成立；
     量测而非投影（OwnerOrderingAmendment 的后果，`measure-root6-root-digest.sql`
     世系参数化到 root7）。
- required_transaction_form：cp01 同形（单事务、八表 ACCESS EXCLUSIVE、四函数开头
  prosrc 断言含不许动的那只、漂移即弃、只读回读、留档、独立评审、禁盲重试），加上
  cp01 事务已带的三个 Round11 守卫（窗口断言、未触及函数合摘要、accepted_binding
  触发器断言——`cp01-apply.candidate.sql:77-117` 实样）。前像表：CP-02 前像 =
  CP-01 后像（`cp01-substitutions.json:19-23`），但必须临事务由 derive 世系只读重出，
  故占位。
- prohibited：沿用 cp01 十条，另加两条本窗新语义：cap 不得越过 17 或单侧生效；
  不得重演 2026-09-11 的库外改写法（cp01 载体 :135-:141 的披露条款所禁方法）。

## 6. forward_cap_extension（16→17 双侧）

- DB 侧 `series_f > 16` → `> 17`、仓库侧 `qualificationLimits.forwards` 16→17：
  `F12PinInventory.md`（:18 行钉位）与 plan v2 步 3。
- 双侧一条款覆盖：NW-01 载体 :190-:229 的先例（并沿用其对「单侧文书授权」教训的
  记载——OwnerForwardCapExtensionOverride 那次的假前提）。
- 为什么需要第 21 次：`R29LateBoundStatusPayloadDeadlock.md:28`；第 20 次前推已作为
  execution event 89 在上窗消耗（`Steps13To20ExecutionSheet.md` step14 回读期望
  「execution_events 89 行」）。
- **独立意见占位**：15→16 的意见（round 9）论证的是「一次窗口迁移恰需一次前推」，
  不自动覆盖 16→17，新意见未出 → 占位，条款写明未出之前不得合并。

## 7. controller_realization_f12

- 五条钉死与钉位清单：`NextWindowPlanV2Window12Cycle.md`（含增补节）与
  `F12PinInventory.md` 全表；现在可定 vs M3 后实化的划分照抄该表「何时可定」列。
- `realize-f12.mjs` 为唯一 M3 后入口、替换计数逐一断言：`F12PinInventory.md` 结论段。
- 文书全套按 F12 重出、S24 相关经 M4：plan v2 步 2/5（两次合并的次序解法）。

## 8. 其余条款

- scope / budget_effect：NW-01 载体同构；ceilings 10506 / 2335812531 不动
  （cp01 prohibited 同款）；分配剩 1（plan v2 诚实边界）。charged_seconds 现值预期
  9906 但**占位**——本会话按纪律不触库，必须由有读权限的会话临发起时实测。
- execution_boundary：过期窗口清单加入 "2026-09-12/13"。
- recorded_governance_question：沿用并将 times_raised 递增到 3；本窗第二次由被资格化
  方修改执法层（CP-02 继 CP-01），条款要求最终结果里写明「两个相继窗口」。

## 9. validator 设计（validate-m3-candidate.mjs）

- A1 与库内门同构：`JSON.stringify(JSON.parse(raw), null, 2)+"\n"` 与文件逐字节相等。
  这是 `parseAuthenticatedAdministrativeJSON`（context.mjs:104-110，见
  `R26IssuanceRecordApprovalsFailAdminParser.md` §3）在「本仓库以 2 空格缩进+尾 LF
  存放」约定下的等价形式：数组下标形键（"160"）、键序、空白任一不规范都在此失败。
- A2 显名禁数字形键（递归全树）；A3 三方集合相等（硬编码 32 项清单 + 长度断言 +
  placeholders.list 声明 + 全文实际出现）；A4 历史时间戳允许集（5 个值）且无晚于
  2026-09-13T07:05:16Z 者 —— 即「载体不含 T」的机械化；A5 结构钉位。
- 判别器 10 个（D1-D6c），每条断言至少一条可失败路径，坏变体不失败则进程失败。
  实测输出：10/10 rejected as expected。这是对「连续十四例不可能失败的验证」的
  正面回应：本校验器每个轴都演示过失败。

## 10. 不确定点（未拍板，逐条待裁）

1. **cp02 类清单是否完整 —— 最重要的一条。** plan v2 步 3 只点名三类 + cap 双侧，但
   对照 cp01 的 21 处编辑，以下三族在 window12 看起来同样必需，缺了运行必炸：
   - `LIVE_ROOT_GENERATION_ROOT6_TO_ROOT7`（G1/B1/A3 类比）：root7 注册后
     `root.generation_id` 变，CP-01 钉的 root6 等值断言在三函数里全部 raise；
   - 段边界类（G4-G6/B4-B6 类比）：execution_events 已 89 行，第 9 次预算落
     sequence≥90 且带 root7 代与新窗到期，CP-01 的「≥89 钉 root6+本窗到期」段会拒它。
     边界 90 取自 F12PinInventory（其自身要求活库复核后才可用）；
   - status manifest schema 类（A1/A2 类比）：schema 钉 generation，上窗
     controller_rebuild.not_affected 的豁免理由（「generation 不变」）本窗不成立。
   处理：写入 `cp02.additional_classes_this_draft_believes_required_…`，状态钉死为
   `AWAITING_ADJUDICATION_DO_NOT_TREAT_AS_GRANTED`，validator D6c 保证该状态被改即失败。
   需要 plan 作者/独立评审裁定：plan 步 3 是省略还是有意排除（若有意排除，请给出
   运行不炸的机制说明）。
2. **charged_seconds 现值**：预期 9906，但 R29 后是否有任何计费动作本会话无法从
   仓库字节确证 → 占位 + expected 注记。
3. **algorithm_config.accepted_config_ref**：沿用 b25abb05 还是随 F12 重出，plan 前置
   清单表第 7 行明说「G #9-11 裁定后定」→ 占位。
4. **idempotency_key 的日期段**：root6 用 `register-root6-window11-20260912`（merge 当日）。
   root7 格式我按「M3 merge 日期」写，若生成器世系用别的日期约定（如注册执行日），
   以生成器为准 → 整值占位，格式仅注记。
5. **NW-02 与 root7 注册的相对次序**：plan v2 步 4（NW-02）先于步 6（注册）。载体未把
   这一次序写成硬条款（NW-01 载体也未对等钉过），只在 ordering 里钉了「注册先于
   CP-02」。若评审认为应把「NW-02 先于注册」也钉进载体，加一行即可。
6. **frozen prefix 覆盖 ≤6 的前提**：root6 注册事件的 recorded_at 已由 events_immutable
   冻结（与 cp01 对 ≤5 的论证同构），我据此把冻结前缀扩到 ≤6、只豁免 sequence=7 的
   recorded_at。这是同构推演，不是已有裁定 → 需 Round 评审确认。
7. **本载体自身文件名/路径**：放在 `bootstrap/next-window-m3/`（任务指定）。上两窗的
   载体在 `next-window-2026091x/`，命名随 T 而定；若正式发起时要改目录名，注意
   owner_approval_ref 占位符解析时以最终路径为准。

## 11. 复核入口

```
node artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/validate-m3-candidate.mjs
```

预期：A1-A5 全 PASS，D1-D6c 全部 rejected as expected，退出码 0。
