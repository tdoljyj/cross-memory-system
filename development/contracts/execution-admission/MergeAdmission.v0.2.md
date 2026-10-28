# Merge Admission v0.2：合并列车开着时的合并准入（v0.1 的后继）

状态：**候选（Candidate），未接受。** 本文是 [MergeAdmission.v0.1.md](MergeAdmission.v0.1.md) 的后继，只写与 v0.1 不同的地方，其余全部沿用 v0.1。

**本文只在合并列车开着时适用。** 下面三条全部成立时，本文才取代 v0.1 的对应小节：

1. Owner 接受本文（写一条 Decision）。
2. 常驻执行器的列车开着（`train.enabled=on`，额度第二期设计 v0.5 §6 第 5 步），并且已在列车模式下做完全量清扫（第 6 步，§3.3）。
3. Owner 已在 GitHub 设置里把规则集 `24182890` 的 `strict` 改为 false，合并方式只留 merge（第 7 步）。

在此之前，以及列车关着（`train.enabled` 为 `off` 或 `shadow`）或 `strict` 开着的任何时候，一律以 v0.1 为准。接受本文和 v0.1 一样，不授予任何实施、规则集改动、合同发布、生产迁移或 Worker 发布的权限；关 `strict`、改合并方式只由 Owner 在 GitHub 设置里做。

日期：2026-10-28

来源：

- 设计：《常驻执行器额度第二期（含合并列车）设计说明 v0.5（定稿）》，资料中心 `10_E_工程与平台/CI基础设施/常驻执行器额度第二期_含合并列车_设计说明_v0.5_20261022.md`，sha256 `bd20941b0cf89b0819790a00357a1b2e79965718cee44d5d24c86123fc6d64cb`。本文的“设计 §x”都指这份文件。
- Owner 决定：`4b7d289f`（合并列车并进第二期）；`e1e19e2e`（取代 `573a9599`）：清扫之后关 `strict`、只留 merge，先做深度 1，只在当车头时测，非列车模式下第 8 段停靠等候；`72ed7fb4`（新版 Agent 合同发布要 Owner 另行接受并发 Grant）。
- 实现 Task：`6451a55d`；本文的 Task：`a1d93067`（第 6 步的仓库合同）。

对照基线（2026-10-28）：

- main `f0a401d4`。
- 规则集 `24182890`（`main write policy (#292)`）现读：
  - 作用于默认分支，`active`，绕过名单为空；
  - 禁止删除，禁止非快进推送，要求经 PR 合入（0 个批准）；
  - 允许 merge、squash、rebase；
  - 六项必需检查 `gitleaks`、`trivy`、`contract-placement`、`kooyumi-work-admission`、`kooyumi-admission-verified`、`kooyumi-merge-slot`，都钉 integration `5368905`；
  - `strict_required_status_checks_policy: true`。
- 仓库：个人账号名下的私有仓库（用不了 GitHub 原生合并队列），`allow_auto_merge: true`，`allow_update_branch: false`。
- 常驻执行器：代码做到第 3c-1 步（#920，第 10 段只读、影子模式）。开车所需的撤销、全量清扫和车头批次（第 3c-2 步）还没合入，所以本文现在还不可能生效。

---

## 0. 一句话结论

列车开着时，合并仍然一次只放行一个 PR：KooYomi 合并队列的队首，也就是车头。车头不再需要作者把 main 合进分支：执行器直接测 GitHub 为它算好的试合并提交 S（父提交是 [main 尖端 T, 车头 head H]），测完立即把六项发在 H 上。

v0.1 靠 GitHub 的 `strict` 保证“合并结果就是测过的”，列车模式下改由一个按提交的不变量保证：不在 main 里、又带着 App `5368905` 成功 `kooyumi-merge-slot` 的提交，任何时刻至多一个；它就是车头的当前 head，并且 main 尖端正好是它测过的 T（§3）。

所以 Owner 在列车开好、清扫干净之后关掉 `strict`，合并方式只留 merge。分层、三个全局状态、受保护层的基线（v0.1 §3–§6 的 I1–I4）都不变。

---

## 1. 与 v0.1 的关系

- 本文按 v0.1 的小节编号写改动（§2）。没提到的小节，以及 v0.1 §14“不保护什么”的全部条目，原样沿用。本文另外加的条目见 §5。
- v0.1 正文里的检查名和来源（`clued-*`、GitHub Actions `15368`、App `5164952`）是 2026-10-08 的写法。之后按 Owner 决定 `89945332`、`4fedfc84`，六项改为钉 App `5368905`，只由常驻执行器发布（[docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md)）。列车的全部保证都以“六项钉 `5368905`”为前提（§3）。
- 本文不改任何技术标识：策略列名和取值（`up_to_date`、`strict_only`、`check_and_strict`、`merge_slot` 等）、检查名、配置文件路径都沿用。§2.4 只改 `strict_only` 在列车模式下的含义。
- 列车关掉（回退，§4.2）以后，v0.1 重新完整适用。

---

## 2. 改动对照（列车模式下）

### 2.1 §2 G3：合并结果 = 测过的结果

| | v0.1 | v0.2（列车模式） |
| --- | --- | --- |
| 保证 | 受保护 PR 合并时，main 没有在它最后一次判定之后前进，所以合并结果就是 Owner 批过、CI 测过的那个 head | 车头 H 带着绿的期间，main 一直停在 T。H 合入时，合并提交就是 GitHub 对 [T, H] 的合并，和 CI 测过的试合并提交 S 出自同一个合并引擎、同一对输入，所以落地的树就是测过的树。受保护层另外要求 H 含 T（`check_and_strict` 照旧，§2.4），这时 S 的树就是 H 的树，合入的就是 Owner 批过的那个 head |
| 对哪些路径 | 受保护层必须；其他层顺带得到 | 受保护层必须；普通层和文档层在列车模式下也得到“合入的树 = 测过的树” |
| 谁强制 | GitHub 规则集 `strict`（合并时实时判断） | GitHub 规则集（§3.1 的 G-a、G-b、G-c）、常驻执行器维持的按提交不变量 R-b（§3.2），以及第 8 段在发绿之前、之后各核对一次 main 尖端仍是 T、GitHub 的试合并仍是 [T, H] 且树等于 S 的树（设计 §5.3）。`strict` 不再参与 |

合并提交有两个输入。head 由 GitHub 钉住：合并 API 的 `sha` 和 auto-merge 都钉 PR head。base 是合入那一刻的 main 尖端：v0.1 由 `strict` 钉住，列车模式下由 R-b 加第 8 段的“基础没动”核对钉住。关 `strict`，就是把“钉 base”从 GitHub 的原子检查移到 `kooyumi-merge-slot` 这项必需检查和维持它的机制上（设计 §5.9）。

### 2.2 §2 G5：合并串行化不浪费 CI

| | v0.1 | v0.2（列车模式） |
| --- | --- | --- |
| 保证 | `strict` 开着，每次合并都让其他“已跟上 main”的 PR 过期；同一时间只有一个 PR 做最后一轮（并入 main → CI → 合并） | 合并许可仍然只放一个（队首）。只有车头做最后一轮，测的是 GitHub 的试合并提交，作者不用并入 main、不用推新提交、不用整批重跑；main 也不会在车头批次中途移动（设计 §5.2）。车头以外的 PR 测不测，看策略 `train.nonFrontRuns`：Owner 选的是只在当车头时测（`false`，Decision `e1e19e2e` 第 3 条），所以 main 移动不再让排队中的 PR 白跑 |
| 对哪些路径 | `normal`、`frozen` 下三层都适用；`efficiency` 下只有受保护层 | 三个状态下三层都适用（§2.8） |
| 谁强制 | Clued 合并位或合并队列，加 `clued-merge-slot` 必需检查 | KooYomi 合并队列（FIFO，队首持位），加 `kooyumi-merge-slot` 必需检查：第 8 段只给车头发绿（设计 §5.3） |

第 5、6 步期间 `train.nonFrontRuns` 固定为 `true`（照旧一推就测），因为新版 Agent 合同到第 6 步才发布，旧合同下 Agent 要等 CI 变绿才入队。第 7 步关 `strict` 的同时，由 Owner 改成 `false`（设计 §6）。

### 2.3 §4.1 第 5 条：切换与 `strict`

v0.1：“切换不改 `strict`、不改必需检查、不改 environment 与 secret。规则集改动期本身就是 `frozen` 的用途之一。”

v0.2：

- 切换三个全局状态仍然不改 `strict`、不改必需检查、不改 environment 与 secret。状态和 `strict` 互不相干。
- `strict` 的取值改为跟着列车走：列车开着、全量清扫完成之后，由 Owner 在 GitHub 设置里关 `strict`、合并方式只留 merge；列车之所以能代替 `strict`，靠的是 §3 的不变量。关列车（回退）之前，Owner 先把 `strict` 开回 true（§4.2）。
- Agent 不改 `strict`、不改合并方式、不改必需检查，也不请求 Owner 为了自己的 PR 改这些（与 v0.1 第 1 条和 GitConnectorWriteContract 同一精神）。

### 2.4 §5.1 `up_to_date` 列：`strict_only` 的含义

| 取值 | v0.1 | v0.2（列车模式） |
| --- | --- | --- |
| `check_and_strict` | head 不含 base 尖端时，检查本身判 REJECTED（`protected_change_not_up_to_date`） | 不变。车头遇到这种情况时保持队首、不移出队列：PR 页面请持有者在到期时刻之前把 main 合进分支并推送，新 head 在原位置当车头（设计 §5.2） |
| `strict_only` | 检查不管，交给 GitHub `strict` 在合并时拦 | 检查不要求 head 含 base 尖端，base 交给列车钉：车头在 [T, head] 的试合并提交上测，第 8 段只在 main 尖端仍是 T 时发绿，R-b 保证合入那一刻 main 仍是 T |

取值的名字沿用，只是含义从“交给 GitHub `strict`”变成“交给列车”。严格序不变：`check_and_strict` > `strict_only`。

### 2.5 §6 I5：`strict` 不由策略控制（I4 的现状、新增 I6）

v0.1 I5：“策略表没有任何一列能把 GitHub 的 `strict` 关掉或绕过；`up_to_date: strict_only` 只是‘检查不提前拦’。”

v0.2：

- **I4 的现状**：必需检查是六项，都钉 integration `5368905`（§1）。列车模式下，第 8 段写之前现读 main 的规则；读到六项不再都钉 `5368905`、规则集被停用或读不到时，零副作用退出、不发绿（`RULESET_UNREADABLE`，设计 §5.3 第 5 条）。
- **I5′ `strict` 和列车的不变量都不由策略表控制。** 策略表没有任何一列能关掉或绕过 `strict`，也没有任何一列能关掉 §3 的不变量。`strict` 只由 Owner 在规则集里改，并且只在列车开着、全量清扫完成之后才关；关着的时候，钉 base 由 R-b 代替。第 8 段写之前现读规则集，以下情况一律不发绿：
  - 读到 `strict=false`，而本节点不在列车模式（`STRICT_OFF_WITHOUT_TRAIN`，通知 Owner）；
  - 读到 `strict=false`、在列车模式，但合并方式不是只有 merge（`MERGE_METHODS_NOT_MERGE_ONLY`，通知 Owner）。
- **I6 只有一个绿（R-b，新增）。** 见 §3.2。它由常驻执行器维持，不由策略表或状态变量控制；`frozen` 只能加严。

### 2.6 §7.2、§7.4：队列头的工作与 auto-merge

v0.1 §7.2 的“队列头的工作：并入 main（如果 head 还不含 tip）→ CI → 合并”，和 §7.4 的“GitHub 在全部必需检查通过且 head 含 tip 时合并”，列车模式下改为：

- **队列头不用并入 main。** 入队之前也不用为列车并入 main。只有两种情况要并入：受保护层（`check_and_strict`），以及 PR 页面提示“你仍是车头：请合 main”的时候（车头与 main 冲突，或者上线过渡期 `strict` 仍开着而 head 落后，设计 §5.2）。
- **执行器从不合并。** 托管的 `clued-merge-executor.yml`（会把 main 并入车头分支、打开 auto-merge 或直接合并）、`clued-merge-slot-ci.yml`、`clued-work-admission.yml`、`clued-work-admission-reverify.yml` 在列车开着期间保持停用（现在都是 `disabled_manually`），重新启用之前要先改造（设计 §5.10）。v0.1 §7.2、§7.3 第 5 步实施说明里执行器的“并入 main”“打开 auto-merge”“直接合并”，在列车模式下不适用。
- **auto-merge 什么时候开**：合并已获批，并且 PR 已是车头之后。车头的标志是执行器在 PR 上写的“仅供参考”状态 `resident-queue/<节点> (info only)`（旧安装为 `resident-queue (info only)`）显示“车头：正在测”。这时持有者用 `gh pr merge --auto --merge` 打开，不要一入队就开。理由（设计 §5.8）：
  - 只测车头时，排队中的 PR 还没跑过 CI；
  - Owner 应急停用规则集时没有任何必需检查，所有开着 auto-merge 的 PR 会立即合入；
  - 车头之后才开，暴露面只有车头一个。应急流程另外会先关掉所有 auto-merge（§4.3）。
- **只用 merge 方式。** 关 `strict` 时合并方式只留 merge（设计 §5.4 第 7 条）：merge 合入后，那个提交就在 main 里，它的绿不再有影响；squash 或 rebase 合入后，原提交不在 main 里，绿还留着。
- **不开 auto-merge 时**，持有者在六项全绿后自己按 merge 方式合入，钉住 head（合并 API 的 `sha`）。
- `frozen` 下 `auto_merge: forbidden`、`merge_actor: owner_only` 不变。
- “Owner 合并前先问”：在 PR 成为车头、打开 auto-merge 之前问完。代价是推荐做法下，PR 当车头之前没有 CI 结果，问的时候还没有 CI 结果（设计 §5.2）。

### 2.7 §7.5：重新考虑“`strict` 必须开着”

v0.1 §7.5 的结论：“在合并这一步不能，只要 `strict` 开着；而 `strict` 必须开着。”理由是“靠队列独占来替代在 GitHub 侧同样不可强制：别的 PR 的 `clued-merge-slot` 检查是判定时的结论，不是合并时的”。

**v0.2 的结论（列车模式）：合并这一步的串行化可以不靠 `strict`，改靠单一发布者维持的队列独占；但合并许可仍然只放一个，所以并没有换来并行合并。**

- v0.1 那条理由成立的前提，是当年检查由 GitHub 托管工作流按 PR 事件各自发布，没有一个能看到全局、能串行化的发布者。
- 现在这个前提变了：
  - 六项只由常驻执行器以 App `5368905` 发布；主备设计保证任一时刻只有一个当班节点能过实时准入（设计 §5.12）；
  - 发任何新绿之前，先撤销所有旧绿并读回确认；
  - 旧绿可以从 GitHub 枚举出来（全量清扫）；
  - 这正是 v0.1 说做不到的“队列独占”。推理见 §3。
- 代价：这条保证由我们自己的代码维持，不再由 GitHub 的原子检查维持。所以有测试（设计 §7）、关 `strict` 之前的全量清扫（§3.3），并且随时可以回退（§4.2）。
- 列车换来的是“车头不用并入 main、不用重推、不用整批重跑”，不是并行合并：合并许可只放一个，才有 §3 的不变量；放多个，`kooyumi-merge-slot` 就不能再担保合并时 main 没动（设计 §5.8）。
- v0.1 列的 `write_set` 并行性三处用途，列车模式下：
  - （a）最后一轮之前的 CI 全部并行：只测车头时不再提前测；`train.nonFrontRuns=true` 时照旧；
  - （b）`efficiency` 下普通层与文档层免合并位：不再成立（§2.8）；
  - （c）批量测试：由设计 §5.13 的“提前测后车”（深度 2–3）取代。它按影子数据决定做不做，还要先经 Owner 接受放宽签名结果的 10 分钟时效，不在本文范围。v0.1 §7.6 的评估项照旧挂在 Task `7f205c71`。

### 2.8 §5.3、§14：`efficiency` 下“普通层免合并位”不再成立

v0.1 §5.3：`efficiency` 下 `code`、`docs` 两层 `merge_slot: advise`，检查以 `not_required` 通过，“接受白跑 CI 换吞吐”。v0.1 §14 也把“`efficiency` 下普通层与文档层免合并位”列为不保护的一项。

列车模式下：

- 第 8 段只给车头发绿（设计 §5.3 第 1 条：正好一项、位置 1、认领的 `bound_pr` 是这个 PR），不论状态和层。所以三个状态下三层都要当车头才能合入，`merge_slot: advise` 不再免除合并位。v0.1 §14 的那一条在列车模式下不适用。
- 入队要靠带合并引用的认领，所以列车模式下没有认领的 PR 当不了车头，也就合不进去。`efficiency` 下 `work_claim: advise` 只影响第 1 段准入检查本身的结论和计量（G4），不再能让缺认领的 PR 合入。
- `efficiency` 其余各列（`reruns_per_head`、`auto_merge`）照 v0.1。

---

## 3. 列车的不变量与保证方式

### 3.1 GitHub 强制的（规则集 `24182890`，列车模式下的设置）

- **G-a**：main 只能因合入一个 PR 而移动；这个 PR 当前 head 的六项必需检查都要是 App `5368905` 的成功结论；没人能绕过（绕过名单为空，禁止直推和非快进推送）。
- **G-b**：合并 API 的 `sha` 参数和 auto-merge 都钉住 PR head；新 head 上没有检查，就不会合。
- **G-c**：merge 方式下，合并提交的父提交是 [合入那一刻的 main 尖端, PR head]，树由 GitHub 在合入时用它的合并引擎算出。

### 3.2 执行器保证的

- **R-a**：`kooyumi-merge-slot` 的成功只由第 8 段发，只发给通过设计 §5.3 第 1–5 条的车头的当前 head：队首、基础没动、试合并没变、只有一个绿、规则集现读符合要求。
- **R-b（I6）**：在 `strict=false` 的任何时刻，不在 main 里、又带着 App `5368905` 成功 `kooyumi-merge-slot` 的提交至多一个；它是当前车头 PR 的当前 head（KooYomi 队列已空时，是最后一任车头的 head），并且 main 尖端等于它测过的基础 T。为什么按提交说：必需检查挂在提交上，任何一个六项全绿、不在 main 里的提交，只要重新成为某个 PR 的 head，就会被当作可以合（强推回旧提交、从旧提交新开 PR、重新打开 PR、改 base）。维持它的七条机制见设计 §5.4：
  1. 只发给车头；
  2. 开车头批次之前、发新绿之前，先撤销所有旧绿：读回，30 秒后再读回，仍是失败才算确认；
  3. 车头换 head、离开队列没合入、新车头要开批次而上一任的绿还在、main 在列车之外移动时，立即撤销；
  4. 只新建的绿色台账；
  5. 不依赖发布日志的撤销：按 check run id 核对 App 和 head 之后改成失败；撤销别的节点发的检查之前，先实时核实自己当班；
  6. 从 GitHub 枚举旧绿的全量清扫：任何一次读取不完整就判失败、停在原地；仍然有效的当前车头保留；
  7. 只允许 merge 方式合入。
- **R-c**：撤销、发失败结果都只把检查往“不能合”的方向改。撤销没确认时，不再发任何新绿，直到下一次第 10 段确认。

### 3.3 推出来的结论与上线前提

1. 由 G-a 和 R-b：车头 H 带着绿的期间，别的提交都合不进去，所以 main 一直是 T，直到 H 合入或它的绿被撤销。
2. H 合入时，由 G-c，合并提交是 GitHub 对 [T, H] 的合并。第 8 段写之前、写之后都核对过，GitHub 对同一对父提交的试合并就是 S。所以落地的树就是测过的树。第 10 段在合入后再核对一次，不符就停车、通知 Owner（`TRAIN_LANDED_TREE_MISMATCH`）。
3. H 上各项检查说的分别是：`trivy`、`contract-placement`：S 的树通过了，而 S 的树就是落地的树；`gitleaks`：H 的提交历史；`kooyumi-work-admission`、`kooyumi-admission-verified`：H 的准入；`kooyumi-merge-slot`：车头、main@T、落地就是 S 的树。
4. 受保护层的 H 含 T，S 的树就是 H 的树，合入的就是 Owner 批过的 head（G2、G3 不变）。

**上线前提**（全部满足之后才可以关 `strict`）：

- 第 5 步列车开着（`strict` 仍开着）；
- 第 6 步列车模式下的全量清扫成功，确认没有别的绿；
- 第 6 步的合同都已落地：本文经 Owner 接受；GitConnectorWriteContract 与 `docs/maintenance/independent-ci.md` 的应急与灾备流程已改；新版 Agent 合同已由 KooYomi 在 Owner 接受并发 Grant 之后发布（草稿：[AgentContractMergeTrainDraft.v0.1.md](AgentContractMergeTrainDraft.v0.1.md)）。

---

## 4. 上线、回退与应急

### 4.1 上线顺序（设计 §6 第 5–7 步）

1. **第 5 步**：`strict` 仍开着时开车（`train.enabled=on`，`train.nonFrontRuns=true`），装好后先做一次安装后的全量清扫。代价：清扫会撤销非列车模式下发的、说明里没有 main@T 的绿，正在等合并的 PR 要推新提交，所以选没有 PR 在等合并的时候做。
2. **第 6 步**：列车模式下全量清扫，确认没有别的绿；合同落地（§3.3）。清扫失败就停在这一步。
3. **第 7 步**：Owner 在 GitHub 设置里关 `strict`、合并方式只留 merge，并把 `train.nonFrontRuns` 改为自己选的值（UAC）。上线后头 10 次合入，每次由第 10 段核对落地的树并汇报。

安全依赖 Owner 按这个顺序操作：第 6 步的清扫完成之前不关 `strict`。兜底：companion 的 poller（Owner 身份）每轮现读规则集。读到 `strict=false`，而执行器不在列车模式或第 6 步的清扫还没完成，就写暂停请求，并弹紧急通知请 Owner 把 `strict` 改回去或尽快完成清扫；读到必需检查不再钉 `5368905`、或规则集被停用，也弹通知（设计 §6）。

### 4.2 回退（任何时候）

1. Owner 写暂停请求，执行器停在批次之间，不再发绿。暂停期间仍允许第 10 段运行。
2. 跑一次第 10 段，确认没有不在 main 里、又不是车头的绿。
3. Owner 把规则集的 `strict` 改回 true。
4. `train.enabled` 改回 `off`（UAC）。

先停发绿，再开 `strict`，再关车，与上线顺序对称。顺序弄错（先关了车，`strict` 还关着）时，第 8 段的规则集现读会让它不发绿，R-b 仍然成立，只是列车停着。回退完成后，v0.1 重新完整适用。

### 4.3 应急停用规则集与灾备切换

列车开着（`strict` 已关）时，Owner 应急停用规则集、或灾备切换必需检查的来源，都必须先做前置步骤：暂停执行器，跑一次第 10 段撤销车头的绿并读回确认，关掉所有打开 PR 的 auto-merge；灾备切换还要先把 `strict` 开回 true，再改来源。恢复之后、列车重新开之前，做一次**全量**清扫。

设计 §5.10 之外补了一条，只会更严：执行器不可达（例如 TURING 不在线），或者车头的绿没能撤销并读回确认时，应急停用之前也先把 `strict` 开回 true，全量清扫完成后才再关。`strict` 开着时，没撤掉的旧绿只能合入一个已含 main 尖端的 head，落地的就是它自己测过的树；`strict` 关着时，它可能落在修过的 main 上，那棵树没测过。

具体步骤和关 auto-merge 的 Owner 脚本见：

- [GitConnectorWriteContract](../repository/GitConnectorWriteContract.v0.1.md) 的 “Emergency or recovery”；
- [docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md) 的“合并列车开着时：应急与灾备的前置步骤”。

为什么必须这样（设计 §5.10）：

- 规则集停用期间没有任何必需检查，开着 auto-merge 的 PR 会立即合入；
- 旧的灾备流程把 `kooyumi-merge-slot` 改钉 App `5164952`、重新启用 `clued-work-admission.yml`，而它的 `mergeSlotCheck` 把 head 不含 main 尖端（`not_needed`）、`not_required`、`not_reported` 都判成功。`strict=false` 时照旧流程走，任何不含 main 尖端的 PR 都会拿到绿。

---

## 5. 不保护什么（v0.1 §14 之外，列车模式新增）

- 钉 base 这件事由我们自己的代码维持，不再是 GitHub 的原子检查。撤销失败时不再发新绿；旧绿在 main 不动时仍然安全。
- GitHub 合入时算出的树与试合并不同：同输入、同引擎，按理不会发生。`strict` 开着时无法预先验证，所以由第 10 段在合入后核对；不符就停车、通知 Owner。上线后头 10 次合入每次都核对并汇报。
- App `5368905` 的私钥被别的程序拿来发绿：今天也是同样的风险。
- 被降级节点晚到的发布：角色收走后，旧节点在准入后约 150 秒内还可能落地一条检查；机器睡眠或被挂起时可能更晚。所以 R-b 的前提之一是两个节点都关掉自动睡眠（主备设计 v0.4 §8.6，写进安装校验）。
- Owner 自己改规则集（开回 `strict`、关掉必需检查、停用规则集）在模型之外，必须按 §4.3 的修订流程走。
- 安全依赖 Owner 按 §4.1 的顺序操作；poller 的兜底只能发现并暂停，不能阻止 Owner 提前关 `strict`。
- 只测车头时，PR 当车头之前没有 CI 结果；车头首次运行就失败时，占用执行器约 20 分钟后才移出队列。
- 别的 scope（例如 global）的认领当队首时，`clued_work_merge_slot_holders_v1` 返回空，列车只能等它让位（设计 §5.5 第 1 条的盲区，可选的服务端整表读取可以根治）。

---

## 6. 引用

- 前身：[MergeAdmission.v0.1.md](MergeAdmission.v0.1.md)（Accepted，Decision `d130195e`）；[ADR-EA-001-MergeAdmissionPolicy.md](ADR-EA-001-MergeAdmissionPolicy.md)。
- 设计：额度第二期设计 v0.5（见文首来源），§5.2–§5.5、§5.8–§5.12、§6；三轮独立审核记录在同目录 `常驻执行器额度第二期_含合并列车_独立审核记录_20261022.md`，sha256 `9dfb38072114fc2398cf428c2b120c57d91fda3927a995b3780214e83327de22`。
- 实现：`work/independent-ci-resident-v1/DESIGN.md` §17–§22；`work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/`（`train-rules.mjs`、`green-ledger.mjs`、`train-maintenance.mjs`）。
- 同时修订的合同：[GitConnectorWriteContract.v0.1.md](../repository/GitConnectorWriteContract.v0.1.md)；[docs/maintenance/independent-ci.md](../../../docs/maintenance/independent-ci.md)；新版 Agent 合同草稿 [AgentContractMergeTrainDraft.v0.1.md](AgentContractMergeTrainDraft.v0.1.md)（现行合同仍是 [protocol/agent/agent-contract.md](../../../protocol/agent/agent-contract.md)）。
