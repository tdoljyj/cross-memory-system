# Round 32 独立评审（2026-09-13，评审会话 session_01Qf3LXsTFayUEgkWPKoFx9Z）

对象：F12 预像（6bbfeac）、issuer 候选两件（b52893c）、M3 候选件（ab35028 + 988a129
回填）、16→17 前推上限独立意见。基线：分支 claude/nice-fermat-njqlmm @ 988a129；
提交前 rebase 到 f1a8bde（F12-N1 仅新增 work/f12/F12SentinelDiagnosticsFinding.md，
与本轮无文件重叠；其「拒绝形态因门与环境而异、需受控实验归因」的结论与本文
R32-F4 相互印证）。
纪律：只读活库（select only）；无库写、无 append_event、无预留、无 PR、无合并。
每条结论附复现命令；本轮全部判别路径都实际演示过失败或被权限系统拦截过。

## 发现（按严重度降序）

### R32-F2【最重，window12 运行必炸】signing.mjs 代际准入表漏 root7 —— 第 15 个实例

- **本体**：`scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window/signing.mjs`
  是加载集内**唯一**跨目录活代码（check-digest-pins CROSS_DIRECTORY_SOURCES 唯一成员；
  trusted-github.mjs:4 直接 import）。其 makeCommitment 准入断言
  `[rootGeneration,root5Generation,root6Generation].includes(boundRootGeneration)`
  不含 root7；而 verifyDynamicPayload→makeCommitment 位于三条活验证路径上
  （context.mjs:328、grr.mjs:38、result-terminal.mjs:57）。F12 后两 schema 的
  `control_trust_root_generation` const 已改为 root7，即 window12 的每一份 GA/GRR
  都带 root7 代 → 全部在 `purpose_audience_generation_mismatch` 中止。
- **为什么 14 道既有防线都看不见它**：ctrgen 是 32-hex，digest 门（64-hex 门）与
  census 都不数它；build-f12 残留扫描只走控制器目录；F12PinInventory 标题即限定
  context.mjs。这正是「在不可能失败的轴外」的第 15 例形态 —— 但这次抓在冻结之前。
- **先例证明这是每窗必做的编辑**：`git show 4d33717 -- '*commitment-signing*'` ——
  root6 过渡当时对同文件加了 root6Generation 与准入项。
- **修复（本提交）**：加 `root7Generation` 导出 + 准入表加入 root7（旧代保留 ——
  历史对象仍需验证）；规则以 R32-F2 两条入 build-f12.mjs 规则表。
- **复现**：修复前 `grep -n 'includes(boundRootGeneration)' scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window/signing.mjs`
  可见无 root7；全量重放验证见 R32-F1。

### R32-F1【高】build-f12.mjs 交付时根本无法运行 —— 其断言从未被机器执行

- **本体**：去重自检以 `from` 串为键，把「两个 schema 文件共用同一 OLD_GEN from」
  误判为 R18-F3 缺陷，任何环境下第一步即抛
  `DUPLICATE_RULE: "schema ctrgen const" in gate-result-receipt...`。
  提交信息称脚本因权限被拦才改用编辑器 —— 实际是脚本自身缺陷；「apply 时逐条断言
  出现次数」的保证在 6bbfeac 交付时从未真实执行过（是手工核对的）。
- **修复（本提交）**：键改为 `file + ' ' + from`（R18-F3 的真缺陷是**同文件**重复 from）。
- **修复后全量重放**：`git worktree add /tmp/pre 6bbfeac^ && cp work/f12/build-f12.mjs
  /tmp/pre/work/f12/ && node /tmp/pre/work/f12/build-f12.mjs` → 17 条规则全过、
  残留 0、哨兵 7 站点；五控制器文件与 6bbfeac 逐字节相同、signing.mjs 与本提交
  修复版逐字节相同（`git show 6bbfeac:<f> | cmp - /tmp/pre/<f>`）。
  **规则表 ↔ 实际落位字节级一致由此机械成立（含 R32-F2 两条）。**

### R32-F3【中】round 9 的 15→16 意见件从未入树 —— 已合并载体引用悬空且无摘要锚

- **本体**：已合并的 NW-01 载体（cbe898d3, PR158）`independent_opinion_ref.path` 指向
  `root6-capacity/ForwardCapExtensionIndependentOpinion20260912.json`，仅有 path/round，
  无 sha256。该路径在仓库任何历史中都不存在：
  `git log --all --oneline -- '*ForwardCapExtensionIndependentOpinion*'` → 空。
  15→16 的「独立论证」今天不可复核。
- **后果限定**：15→16 已消耗（forward 20 已发生），无可回滚语义；教训是引用必须带
  内容摘要。16→17 的新意见件（本轮出具）在 M3 候选件中以 path+sha256 双钉，且
  validator 备妥的编辑会对文件字节验摘要，使同类缺陷不可复发。

### R32-F4【低·限定条件】「恰好两条短缺」的拒绝预言仅在 gh 齐备宿主成立

- 短缺检查（check-digest-pins.mjs:610）仅在 `problems.length===0` 时执行。缺 gh 的
  宿主上，两个 gh 摘要成为 matches-no-file 型 UNEXPLAINED，短缺检查被跳过 ——
  拒绝形态不同但仍 exit 1（未实现树在任何宿主都冻不过，设计目标不受损）。
- **复现**：本容器直接 `node check-digest-pins.mjs` → 2 条 matches-no-file + HOST
  INCOMPLETE；把 gh 摘要注入索引模拟齐备宿主（注入行需拼接写法避免自污染字面量
  计数）→ 恰好 `context.mjs 20/22`、`check-digest-pins.mjs 6/8` 两条，不多不少。
  建议后续文书把该预言措辞限定为「齐备宿主」。

### R32-F5【低】verify-issuer-candidates.mjs 的 round-trip 检查是空转

- `:53` 比较 `JSON.stringify(JSON.parse(raw))` 与 `JSON.stringify(newDoc)`，而
  `newDoc=JSON.parse(raw)`，非 TAMPER 时恒等 —— 该行永不可失败（尾 LF 检查是
  另一行、真实有效）。A1 级字节纪律实际由候选件被 M3 同目录 validator 同款门
  覆盖时才成立；此处建议改为 `JSON.stringify(JSON.parse(raw),null,2)+'\n'===raw`。
  不影响本轮结论：七处变更集合与跨文档零漂移检查是真实且已双向演示。

### R32-F6【备注】issuer 候选件的 4 哨兵×2 件无机械实化入口

- realize-f12.mjs 只替换控制器三文件的 7 哨兵；两 issuer 件的
  `__F12_PENDING_WINDOW_START/END__`、`__F12_PENDING_M3_APPROVAL_SHA256__`、
  `__F12_PENDING_M3_MERGE_SHA__` 靠 verify 脚本尾注的「手工替换后自算 sha256」。
  建议并入 realize-f12 或补 realize-issuer 脚本（计数断言同款），避免 M3 后手工面。

## 复核通过项（逐条给可复现命令）

1. **F12 规则表 vs 实际 diff 逐字节一致**：见 R32-F1 重放法（六文件 cmp 全同）。
2. **8 旧窗 token 残留 = 0**（控制器目录递归）：
   `for t in ctrgen_5e0440a9… '2026-09-13T07:05:16Z' 1640995831… 80cf8f47… '2026-09-10T13:18:47Z' root6Expiry root6Generation root6BudgetSequence; do grep -rcF "$t" <控制器目录>; done` → 全 0。
3. **7 哨兵普查与 realize SUBS 互为镜像**：
   `grep -roE '__F12_PENDING_(WINDOW_START|WINDOW_END|ISSUER_STATUS_SHA256|ISSUER_GATE_SHA256)__' <目录> | sort | uniq -c`
   → context 3（END/STATUS/GATE）、check-digest-pins 2（STATUS/GATE）、
   root-window-validation 2（START/END），共 7，与 build/realize 两表逐项相同。
4. **check-digest-pins 拒绝形态**：见 R32-F4（齐备宿主恰两条 20/22、6/8）。
5. **realize-f12 干跑 7/7 ok、坏 T/同 SHA/大写 hex 三失败路径全拒、--write 端到端后
   门上字面量回 22/22、8/8**（sim 树，仅余 HOST INCOMPLETE=缺 gh）。
6. **root7BudgetSequence=90 活库复核**：BUDGET_RESERVED 序列全 ≤85、基线后恰 8 条
   （46,51,59,68,73,77,81,85）、全事件 max(sequence)=89 → 第 9 预算必 ≥90。
   `select ... from jsonb_array_elements(clued_control.read_execution()->'events') ...`（只读）。
7. **issuer 两件**：`node work/f12/verify-issuer-candidates.mjs` 正向 0 退出（7 变更
   全在声明集、跨文档漂移 0）；`--tamper` 反向恰拒。前驱 blob 闭环：
   `git cat-file -p c1749399… | sha256sum` = 1640995831…、`3ae8bd41…` = 80cf8f47… ——
   恰为 :317 被换下的两旧摘要。**scope 累计上限语义裁定：随 qualificationLimits 正确**。
   历史实证：root5-final 控制器 `:82/:163` 强制 7506/1664723891（该代 issuer 件如实
   镜像之）；现控制器 `:29/:215` 强制 10506/2335812531 → 候选件镜像现行强制上限，
   与历史件语义同构。保留 7506 反而记录一个已不成立的上限。:319 断言逐字段对照：
   generation=ctrgen_26769cc7 ✓、root_set_id ✓、accepted_audience ✓、purposes
   （STATUS 单件；GA+GR 共件）✓、窗口 currentWindow 依赖实化 ✓。
8. **M3 validator**：`node .../validate-m3-candidate.mjs` → A1-A5 全 PASS、10 判别器
   全部 rejected as expected、exit 0。
9. **M3AdjudicationsRound1 全裁定复核**：
   - **#1 三族证据成立（独立复证）**：cp01-substitutions.json 实读 —— G1/B1 后像钉
     root6 等值（root7 注册后必 raise）；G4/B4 后像钉 `>=89 → root6+2026-09-13T07:05:16Z`
     段（第 9 预算 ≥90 带 root7+新窗必被拒，活库序列复核如上）；A1/A2 钉 510f3b90
     旧 schema 摘要，F12 后实测 `sha256sum status-manifest.root5.schema.json` =
     7e5df5dd2b23…fecd2d，与回填值命中。**三族缺一 window12 运行必炸，翻转应当执行**
     （执行留置，见下节）。
   - **#2 charged_seconds=9906**：活库只读复算命中（generation_id 测量时仍 root6）。
   - **#3 b25abb05 沿用**：R31 #9-11 裁定在案，条件钉已写入候选件 rule 字段，成立。
   - **回填四值**：9906 ✓、a93bfdda ✓（见下）、b25abb05 ✓、7e5df5dd ✓（实测）。
   - **a93bfdda 全链闭环**：活库 root events seq6 体与快照
     `status24/Root6RegistrationBodySnapshot20260913.json` 深等值，canonicalDigest
     （独立重实现 sorted+compact+LF）= a93bfdda74d9…4081c5；seq5 同法 = 92186d46…。
   - **#5 NW-02 先于注册的次序钉：裁定加入**（plan v2 步 4/6 既定顺序；编辑留置）。
   - **#6 冻结前缀 ≤6：确认成立**。前提活库实证：`clued_control.events` 上
     `events_immutable` 触发器存在且 tgenabled O（pg_trigger 只读查询）；root6 注册
     事件（seq6）recorded_at 一经写入即冻结，与 cp01 对 ≤5 的论证严格同构；只豁免
     sequence=7 的 recorded_at，carve-out 三理由原样成立。
   - **expected_sequence=6 / ordinal=7 / prefix_sequence=6**：活库 root events 恰 6 条，
     与 step13 实样（root6: expected 5/ordinal 6/prefix 5）顺推一致。
10. **16→17 独立意见：成立，已出件**
    `bootstrap/next-window-m3/ForwardCapExtensionIndependentOpinion16To17.json`
    （sha256 = 4b1aab9d49eae48904ef899661d58e65b6eac93a6fc7cc07ead1d3d23d171880）。
    要点（全部活库/一手复核）：G3 现行 prosrc 确为 `series_f>16`，series_f 定义为
    sequence>44 的 FORWARD_ACCEPTED 计数、现值恰 16（总 20 中 4 条在基线内）；R29
    死锁实链成立且唯一合法出口是第 21 次前推；plan v2 的 F12 绑定迁移与死锁修复
    共用**同一次**前推（活绑定三元组 68133f2d/e7cfb30b/fb389314 即 forward 20 一次
    钉三值的实样）→ 恰需 +1、双侧对称、零容量授予。意见明确不外推：若两需求被
    拆成两次前推，17 不够也**不得**顺延为 18，须重新裁定。

## 留置编辑（备妥、未施加 —— 权限系统以 Self-Approval 拦截，裁定正确性不受影响）

本会话对 M3 载体的四处编辑（cp02 状态翻转、nw02 次序钉、意见件双占位回填、
placeholders 28→26）连同 validator 同步（清单/计数 28→26、A5 加三钉含意见件摘要
对字节实验、D6c 期望反转），在执行时被权限分类器以 **Self-Approval** 拦下。评审
判断该拦截在形态上成立：翻转「不得视为已授予」状态并把本会话自己出具的意见件回填
为「独立意见」，正是自我批准形态，不应由本会话换工具绕过。故：

- **裁定结论**（应翻转、应加钉、意见成立）**照常出具**（上文 9/10 节，证据齐全）；
- **施加动作**留给 Owner 或其明示授权的会话执行；下列脚本一步完成候选件四处编辑
  （validator 的同步编辑见脚本尾注释，共两处数字、一处钉块、一处判别器）：

```bash
node artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/round32-prepared-edits.mjs   # 见同目录备妥脚本
```

脚本本体已随本提交入库（`round32-prepared-edits.mjs`），幂等、每处编辑前断言现值、
产出后自动重跑 validator；validator 编辑由脚本一并完成。执行后预期：A1-A5 PASS、
判别器全 rejected、占位符 26。

## 对 ff7c572 先例注记的裁定（占位符机制 keep-vs-rewrite）

**裁定：保留 validator 护卫的字面占位符机制，不改写为 NW-01 式「合并前静默解析」。**
理由：NW-01 的「无字面占位」意味着解析动作发生在无机械护栏的窗口里（哪个值在
何时被谁填入，事后只能靠 diff 考古 —— round 9 意见件悬空正是同一类「引用无锚」
问题的近亲）；M3 的 A3 三方集合相等使「多一个、少一个、改名一个」占位符全部即时
拒绝，回填历史又逐条落在裁定记录里（M3AdjudicationsRound1 + 本文）。候选件自带
规则「none survives into the merged document」已覆盖合并前必须清零的要求 ——
两机制的终态相同，过程可核性 validator 侧严格占优。与注记的 stated leaning 一致。

## 边界与未尽

- 本会话未做任何库写/预留/PR/合并；Supabase 全部查询为 select 只读。
- `__PENDING_ROOT7_HISTORY_PREFIX_DIGEST__` 按 M3AdjudicationsRound1 的安全线裁定
  继续留占位（注册生成器世系临 append 实测），本轮不回填。
- signing.mjs 修复使 window11 冻结清单（ControllerSourceManifest.candidate.json）中
  该文件条目过期 —— 该清单本就在 F12 realize 后由 build-linux-manifest 重建，无需
  本轮动作；列明以免下轮误报。
