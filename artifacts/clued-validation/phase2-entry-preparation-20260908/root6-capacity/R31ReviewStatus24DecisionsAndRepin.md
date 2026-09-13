# R31 —— Status24 载荷决策表独立裁决 + 受理件重钉备妥（评审 `/root`）

**状态：`DECISIONS_FINAL_AND_REPIN_TOOL_PREPARED_NOT_EXECUTED`。纯文档与只读：未写活库、未注册、未预留、未合并、未跑 600 秒、未动控制器 22 源文件。分配未烧（charged_seconds 实测 9906/10506）。**
基准分支头：491b810。活绑定实测（只读 select）：`fb389314 / e7cfb30b / 68133f2d`，代际 `ctrgen_5e0440a9…`，seq 89 —— 与 R29 终账一致。

## R31-F1（先说发现）：R30 的核心断言证伪，但不掀翻方案

R30 声称【实测】活绑定受理件（fb389314）的 `expected_ga.controller_qualification_ref.sha256 = 6e35ff20`。
本评审实测：**main@M2（88fc944b）的受理件字节 sha256 恰为 fb389314，且该字节内此字段已是
`e7cfb30b`/blob `0427b0e6`** —— 与活绑定 `qualification_sha256` 相等，R30 所述两头堵不存在于活字节。
6e35ff20 只存在于**本分支路径上的陈旧工作副本**（sha256 `775fd644…`，Status24 生成器 :17 读的正是它；
该副本还带 `\u` 转义，实测过不了 admin parser：`ADMIN_JSON_UNIQUE_CANONICAL_VALUES`）。
R30 的「实测」测错了对象。后果：
1. 受理件重钉**不需要**改 `controller_qualification_ref`（工具改为断言 no-op，同时保留对 6e35ff20 形态的修复路径）；
2. 重钉基底**必须**取 fb389314 活字节（工具对 775fd644 显式拒收，负控制 NC5）；
3. R29 死锁本身复核为**真**：`canonicalDigest(SignedStatus23 减 signature_binding)` 复算 = `f4002ae4` 精确命中，修复次序照旧。

## 六项「评审」+ 两项附带的裁定（每项：值 / 实测依据 / 可证伪检查）

### #8 root5 注册体摘要 92186d46 的取法 → 裁定取法并得 Status24 值 `a93bfdda74d9d693584c32ecb9e1ec963fa448b51595fbe245abfeefbb4081c5`
- **取法**：`canonicalDigest(完整注册体，含 signature_binding)`，即 root-window-validation.mjs:17-24 的排序紧凑序列化 **+LF**（body 自证：`canonicalization_id: SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE`）。
- **依据**：对活库 root events seq 5（root5）body 用该函数本尊复算 = `92186d46…` 精确命中；root6 body（seq 6，其 `predecessor.sha256` 即 92186d46）同法 = `a93bfdda…`。候选 `4c9fcf89…` 实测为**无 LF** 变体，否定。
- **可证伪**：三个错误取法各给出不同值且均不命中 —— 无 LF：root5=7c7ee7ac；减 signature_binding：root5=9d0c4ba0（恰是 body 自declare 的 `signed_object_sha256`，旁证域含 signature_binding）；减 sig+acceptance：56dbe7c6。root6 的减-sig 值 95973246 同样命中其声明——两代自洽。与 :322 `ga.authority_source_ref.sha256===canonicalDigest(root)` 的用法完全一致。
- 两 body 快照存 `status24/Root5RegistrationBodySnapshot20260913.json` / `Root6…​.json`（自验：canonicalDigest=92186d46/a93bfdda）。

### #9-11 运行时代际配置三件（bac3ff3d 提案 / bf3dcbcf 受理 / 9a88b7cf 源观测）→ **沿用**
- **依据**：三件是三代际的**定义供源史料**——自述 `NOT_LIVE_RUNTIME_STATE`、`authority_effect: NONE`、`registered: false`；GRR 不读其字节（:349-353 只约束四绑定摘要与 statusSources）。判据落在活值：`execution_current` 三代际实测 = `runnergen_a256855f… / credgen_bac92a11… / sessiongen_ffb02a90…`，与 bac3ff3d 定义值**逐字相等**。文内虽钉 ctrgen_dd30fbc7（第 2 代）与旧窗口，但 Status23 在 root5 期即以史料引用之（root5 控制器 ac7bdd53 同样 ≠ #11 所钉 0ff3e4be），先例一致。
- **可证伪**：若活三代际漂移，此裁定即错——实测就是那个检查。**条件钉**：预留前复测仍相等才沿用；漂移则由实施方重出三件（新提案+独立受理+源观测），且 decisions 三项待定钉同时按新值钉。

### #15 容量宿主范围受理 512aae74 → **沿用**（带 caveat）
- **依据**：其受理对象（FIXED_HOST_RUNTIME_CONFIG，sha256 `9e5edb91…`）**仍是活受理件的现行钉**——`expected_ga.host_runtime_config_digest` 与 `artifact_refs[2]` 实测均为 9e5edb91，无任何后继受理换过钉。GA schema required 含 `host_runtime_config_digest` 且不在 :36 varying 集 → GA 将携带 9e5edb91。Status24 引用 512aae74 才与 GA 一致；单独为 Status24 重出宿主受理反而制造 GA↔Status 供源不一致。
- **caveat（记录在案）**：9e5edb91 内 `host_platform: Windows`、`endpoint: Codex@DESK-W-591`、`docker_endpoint: npipe://…` 已随宿主丢失成为死条目，但无谓词消费（grep 全库：仅 PQUAL-12 故障注入用它）；其规范性内容（image `285a7132…`、profile `d1c060b8…`、600s 资源限制）已在 Linux 窗口复验（R29 前置 1-4）。宿主定义换钉是需要 Owner 载体的另一桩操作，不在 R29 修复单内，本裁定不预支。
- **可证伪**：若 expected_ga 已被换钉到新宿主定义，此裁定即错——实测字段就是那个检查。

### #16 profile/stage 适用性受理 d5b261ce → **沿用**
- **依据**：活受理件 `profile_window_applicability_ref` 现钉**即 d5b261ce 本件**（实测）；其担保的 profile `d1c060b8` = 活绑定 profile_sha256（未变），R05-R10 = :81 现行要求（未变）。其 3000000 容量语句已被 capacity_materials 链显式接续（bc541370 v2 批准 / e7ec06c2 适用件，:122-:133 专门谓词族逐项对钉现控制器/scope），容量事项不由本件担保。
- **可证伪**：profile_window_applicability_ref 或 profile_sha256 任一变动即推翻——两者都实测了。

### #18 修复 SQL 1a89e43f 的继任 → **重出为 CP-01 apply**（`work/cp01/cp01-apply.candidate.sql`，sha256 `2e2653d2…`，git blob `91772be1…`）
- **依据**：1a89e43f 读回确认是 window9 把控制面函数/约束修到当时现状的 SQL（前像钉 seq 87 / charged 9906 / reserve_* 函数源哈希）。本轮的同角色物即 CP-01：**活库三函数源哈希实测 = CP-01 三后像**（reserve_gate `d5bba9ef`、reserve_execution_budget `054c631a`、append_status_manifest `4f9d2be6`）。且 Status24 自身的 schema 准入（A1/A2 容许 510f3b90）正出自 CP-01——是真实供源，不是装饰。
- **排他**：「043 修复 SQL」不存在——全库无 043 SQL 文件；043 修复是源文件+解析器改动，其受理即 #19 的 d3f643b4（`changed_source_refs` 23 项均为文件 blob）。**删除**在 schema 上合法（`source_digests` 实测 `minItems:1, uniqueItems:true`，:349 只要 length>0，:351-353 不涉 #18），但会丢弃真实供源，不取。
- **可证伪**：若活函数哈希不等于 CP-01 后像，此裁定即错——实测就是那个检查。**待办钉**：blob 91772be1 目前只在本分支，M3 合并后方可经 API 取到；重钉工具 formal run 时以本地 git 实取实哈希再验。

### #19 e34850ab → d3f643b4 复核 → **确认**
- **依据**：d3f643b4 字节实取（blob 4ca39447）sha256 命中；state = `ACCEPTED_EXACT_QUALIFICATION_REPAIR_WITH_APPROVED_CAPACITY_DELTA`（context.mjs:115 常量精确匹配），`failed_ga_id = ga_04377008…` = capacityBaseline.failed_ga_id，reviewer `/root/project_list_auth_fix`；且在活受理件 `bounded_series_materials.repairs` 8 件钉集内。角色接续成立（window9「容量修复已应用」→ 本轮 043 容量修复受理）。
- **可证伪**：state 常量或 failed_ga_id 任一不匹配即推翻——逐字段验了。

### 附带 A stage_receipt_refs[2]===[3]（eb25e993 重复）→ **保留，不去重**
- **依据**：context.mjs:81 `ga.stage_receipt_refs.length===6` 为硬谓词（EXACT_STAGE_INPUTS）；:36-37 该字段不在 varying 集 → GA 必须深等 expected_ga；:350 statusExpected 又把同一数组带进 Status24 observations。去重 → 5 项 → :81 直接炸。source_digests 侧本就按唯一值收敛为 5（uniqueItems）。
- **可证伪**：负控制 NC2（去重后断言 length===6）实测按预期失败。

### 附带 B expected_ga.authority_source_ref = 92186d46 → **随 #8 换钉为 a93bfdda**（uri 不变）
- **两头堵证明**（沿用即死）：`authority_source_ref` 在 GA schema required（51 项之一，实测）且不在 :36 varying 集 → :37 强制 GA 深等 expected_ga；而 :322 `ACTUAL_CURRENT_ROOT_REF` 强制 `ga.authority_source_ref.sha256===canonicalDigest(root)`（root = 活 root6 注册体 = a93bfdda）。GA 带 92186d46 → :322 炸；GA 带 a93bfdda → :37 `EXACT_ACCEPTED_GA_FIELD:authority_source_ref` 炸。
- **换钉后波及谓词逐条**：:37 过（GA=expected=a93bfdda）；:322 过（=活值）；:353 过（Status24 source_refs #8 同步 = {urn, a93bfdda}，:353 要求 GA 的 authority_source_ref ∈ sm.source_refs）；:351 不涉（authority 摘要不在四绑定摘要集）；:36 varying 集不动；capacity 族（:122-:133）不涉此字段。
- **可证伪**：负控制 NC3 实测按预期失败。

## 交付物

| 件 | 说明 |
| --- | --- |
| `status24/decisions.final.json` | pending 版之上补齐全部「评审」项 + 钉定 `status_manifest_id`（使 S24 生成确定化）；五项待定钉（as_of/expires_at/三代际）保留，等 M3 的 T 与预留前实测 |
| `status24/Status24Payload.pending.json` | 以 final decisions 重生成：`node build-status24.mjs --decisions decisions.final.json --pending` → `PENDING_PINS_LISTED`，恰余那五项，5 处替换，生成器 :352/:353 自验+去重+往返全过 |
| `status24/repin-acceptance.mjs` | 受理件重钉工具（执行单第 2 步备妥件）。输入五钉 → 跑 build-status24 本尊得 S24 → 对 fb389314 活字节做白名单原子编辑（E1 late_bound→S24；E2 authority→a93bfdda；E3 qualification 断言 e7cfb30b（no-op，兼容修复 6e35ff20 形态）；E4 known_open += R29/R30/R31）→ 自验：真 `parseStoredStatus` admin 往返、diff 白名单、:81/:122/:129/:132/:322/:348-353/:357 抠行谓词、7 个负控制判别器。**只产候选与报告，不执行重钉。** |
| `status24/Root5RegistrationBodySnapshot20260913.json` `Root6…​.json` | 活库 event seq5/seq6 注册体快照（自验：canonicalDigest = 92186d46 / a93bfdda） |

Selftest 实录（合成窗口 + 定义值三代际，对 origin/main 提取的 fb389314 真基底）：
`SELFTEST_PASSED_NOT_A_REPIN`，12 项检查全过、7 个负控制全部按设计失败、改动路径恰 5 条白名单、候选 129006 字节（:39 上限 131072，**余量仅约 2KB —— formal run 若还要加 known_open 条目须先量**）。selftest 的 S24（74770bb2…）系合成窗口产物，**不是**正式值；正式 S24 待 M3 的 T。

## 正式重钉（M3 前一刻，执行单第 2 步）操作序

1. 复测 `execution_current` 三代际（漂移 → 停，#9-11 转重出）；定 T（as_of/expires_at = 新窗口）
2. `node repin-acceptance.mjs --as-of … --expires-at … --runner … --credential … --session … --base <fb389314字节>`
3. 产出 `AcceptanceRepinCandidate.json`（其 sha256 即 ACC21）+ `Status24Payload.candidate.json`（canonicalDigest 即 S24）交 Owner 经 M3 合并；随后按 R29 修复单 3-7 步走

## 边界

只读 select 五次（绑定摘要、注册事件表、两 body、三代际、函数哈希）；无任何写库/注册/预留/合并/600 秒；控制器 22 源文件未动（本工作全部在 artifacts/status24 目录内）。

## v2 兼容映射（追记：本次推送前远端进 5ab9333/c0d8b8f/65e0616，计划改为 window12 循环、root7 已造号 ctrgen_26769cc7…）

v2 第 0 步明言本会话交付「继续有效、参数化复用」。逐项划界：

**不随冻结点变（v2 直接复用）**：#8 取法（v2 root7 前置表第 3 行已引用 —— root7 注册体
`predecessor.sha256` 应钉 **a93bfdda**，即本评审所算 root6 注册体摘要，快照在案）；
#9-11/#15/#16 的沿用裁定及各自条件钉；#18 = CP-01（publication 从 M3 变 M4，继任关系不动）；
#19 = d3f643b4；附带 A 保留重复（F12 清单不含 :81，去重即炸的依据原样成立）；附带 B 的裁定
**原则**（authority_source_ref 必须 = canonicalDigest(现任注册体)，两头堵论证按行号平移）；
R31-F1（活字节事实，与窗口无关）；repin 工具的 S24 管线、:349-357 抠行谓词、七负控制、
diff 白名单机制。

**root6-scoped → 升格为窗口参数（root7 注册后实化）**：
1. 决策表 #8 的 **Status24 值**：window12 下 = canonicalDigest(root7 注册体)，注册后才可算
   → 第六个待定钉；a93bfdda 转岗为 root7 注册体的 predecessor 钉（价值不失）。
2. `build-status24.mjs:24` GEN 常量与 observations.root_generation（root6 硬编码）→ 参数化。
3. `decisions.final.json` 中 a93bfdda 两处与 `expected_ga_overrides.authority_source_ref`
   → 随 1 实化替换。
4. `repin-acceptance.mjs` 基底断言 fb389314 与 E1-E3：v2 下受理件按 F12 **重出**而非重钉
   —— 工具转岗为重出生成器的谓词自验/判别器库；若 v2 途中仍需对 fb389314 打过渡补丁，
   工具原样可用。
5. **「定」项翻案一处（v2 钉 5 的必然推论，此前无人点名）**：决策表 #17（1640995831
   STATUS issuer 资格件）与载荷 `issuer_ref` 在 root7 下**必换**新 issuer 件 ——
   :341 `same(sm.issuer_ref, root.issuer_bindings[STATUS].qualification_ref)` 与 :317 摘要钉
   都指向将被重出的件。本评审的 pending 载荷把 issuer_ref/#17 从 Status23 沿用，
   window12 下它们同样升格待定钉。

**分配算术旁证 v2**：`:215` `charged_seconds===5106+600*budgets.length`，实测 9906=5106+600×8
→ 第 9 次分配恰达 10506 上限，剩 1 次，与 v2「不申请新容量」一致。
