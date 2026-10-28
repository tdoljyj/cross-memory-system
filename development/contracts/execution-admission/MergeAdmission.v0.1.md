# Merge Admission v0.1：合并到 main 的准入、合并队列与模式切换

状态：**Accepted（Owner 2026-10-08 接受，Decision `d130195e`；接受的规范内容为 commit `33d858b1`，此后的接受提交只改状态行、来源与 Task ID）。** 接受只认可方案，本文件不授予任何实施、准入脚本改动、规则集改动、合同版本、生产迁移或 Worker 发布的权限；每一步实施仍由 Owner 单独授权，每步一个 PR。与 [WorkClaimAdmission.v0.1.md](WorkClaimAdmission.v0.1.md)（认领、准入检查、Owner 复核、合并位的现行实现）并列：本文规定「合并到 main 要保证什么」以及如何按路径分层和全局状态执行；v0.1 现行实现中与本文不同的部分，在 §13 对应步骤实施后由对应小节取代，实施前以现行实现为准。
后继：[MergeAdmission.v0.2.md](MergeAdmission.v0.2.md)（候选，未接受）只写常驻执行器的合并列车开着时与本文不同的地方（G3、G5、`strict`、`strict_only`、auto-merge、§7.5、`efficiency` 的合并位）。它被 Owner 接受之前，以及列车关着或 `strict` 开着的任何时候，本文的对应小节照旧适用；它分两层生效，见它的开头。
日期：2026-10-08
来源：Owner Decision `8e767ed8`（先研究写方案再实施；模式切换形态「路径分级 × 全局状态」）、Decision `f303f861`（P0-1 治理精简四项；按本文修订后由 `610eeaaa` 替换）、Task `ada1334c`（审计度量与摩擦排序）、Decision `d130195e`（Owner 接受本文）；研究报告与数据见 Google Drive 资料中心 `10_E_工程与平台/CI基础设施/`（报告 v0.1 候选 r2，文件 ID `1ETCsBd1ol9f_lIMNbxn1z7ph7H8JYUxJ`，SHA-256 `63a2b6d1bb9980e9ca07fc78ebd996a4c7ddad77a4ef0fa50e44a476aa2d8903`；三轮独立复审记录文件 ID `14TuVeFBnzebmJR7ErXYuj5lxxcQYIpi0`，SHA-256 `a1e575ed126dd36aaedb71ca6182033bf11fa1397daa447569ae1922a48c7228`；Clued Note `7bea039d`）；选择理由见 [ADR-EA-001-MergeAdmissionPolicy.md](ADR-EA-001-MergeAdmissionPolicy.md)。
对照基线：main `0b11b095`（2026-10-08），`main write policy (#292)` 规则集 `24182890`（五个必需检查，`strict_required_status_checks_policy=true`，0 审批，bypass 为空），仓库变量 `CLUED_WORK_ADMISSION_ENFORCE=true`、`CLUED_OWNER_REVIEW_ENFORCE=true`，仓库设置 `allow_auto_merge=false`。

---

## 0. 一句话结论

合并到 main 只保证五件事（§2），其中只有两件要求「按最终合并状态测过并由 Owner 看过」，它们只对受保护路径成立；其余路径的保证是「归属可追、不撞车、main 自己的 push CI 会发现问题」。执行方式从「常量 + 分支」改为一张声明式策略表（§5）：三层路径 × 三个全局状态，受保护层是写死在代码里的基线、任何状态都不能放松（§6）。合并的串行化不再靠 Agent 每 10 分钟轮询续期合并位，而是 Clued 侧的 FIFO 合并队列 + GitHub 原生 auto-merge，位的时效绑 CI 运行状态（§7）。GitHub 规则集的 `strict`（必须包含 main 最新提交）保持开启：它是 GitHub 侧唯一能保证「合并结果就是测过、批过的那个 head」的开关，放松它能换来非受保护层的并行合并，但受保护层会失去「合并结果就是批过的 head」，而 GitHub 的 strict 不能按路径开（§7.5）。第三方合并队列不采用（ADR）。

---

## 1. 范围与非目标

**范围**

- 发往默认分支 `main` 的 pull request 的准入判定、合并串行化（合并位 / 合并队列）、重跑、auto-merge，以及这些判定如何按路径分层和全局状态变化。
- 策略表的 schema、推荐默认值、三个全局状态的定义、切换边界与可见性。
- 不变量及其在代码和测试里的保证方式。
- CI 用量的测量项与削减项（§12）。
- 从现行两个 ENFORCE 变量到策略表的迁移路径（§13）。

**非目标**

- 不改认领本身的语义（租约、fence、续期进展、幂等、令牌桶、续接），见 WorkClaimAdmission v0.1 §4.1–4.5 与 GenericWorkClaim §10。
- 不改 Owner Grant 的信任根（Clued 数据库里的门口函数与授权表，OwnerCredential §6.3）。
- 不改发布门口（`CLUED_RELEASE_GRANT_ENFORCE`、`release.production`、`migration.production`）。
- 不做批量测试与失败二分（speculative batching / bisection）：Owner 已定放后期评估（Decision `8e767ed8`），v0.2 评估项见 §7.6。
- 不接入第三方合并队列（Mergify、Trunk、Aviator 等）：理由在 ADR。

---

## 2. 合并到 main 到底要保证什么

| 编号 | 保证 | 对哪些路径 | 谁强制 | 现行实现 |
| --- | --- | --- | --- | --- |
| G1 归属与不撞车 | 每个进入 main 的改动对应一个活 Task 的认领，认领的 `write_set` 覆盖全部改动路径；同一时刻没有两个活认领覆盖同一路径 | 全部（文档层在 `normal` 下仍强制，见 §5） | Clued 数据库（冲突判定）+ `clued-work-admission` 必需检查（判定时）+ 每小时复核 | 已有 |
| G2 受保护改动经 Owner 看过 | 改动受保护路径的 PR，只有 Owner 对其**精确 head 提交**的 `repo.protected_change` 授权才准入；并入 main 不改受保护文件时授权延续 | 受保护层 | Clued 门口函数（ci-admission Binding 专用）+ 必需检查 | 已有（`ownerReview`、`carriedApprovalSource`） |
| G3 合并结果 = 批过、测过的 head | 受保护 PR 合并时，main 没有在它最后一次判定之后前进，所以合并结果就是 Owner 批过、CI 测过的那个 head | 受保护层（必须）；其他层顺带得到 | **GitHub 规则集 `strict`**（合并时实时判断，不是检查时） | 已有：strict 开启 + `protected_change_not_up_to_date` |
| G4 共享资源只为被认领的工作花费 | 自托管重任务只跑被认领覆盖、准入通过的 head；每 Task 24 小时 40 个 head | `normal` / `frozen` 下全部；`efficiency` 下只有受保护层：普通层与文档层缺认领的 PR 也准入，其加闸重任务照跑、不计量（§5.3） | `admission-gate` job（读 App check）+ runner 开工前检查 + Clued 计量 | 已有 |
| G5 合并串行化不浪费 CI | strict 开启意味着每次合并都让其他「已跟上 main」的 PR 过期；同一时间只有一个 PR 在做最后一轮（并入 main → CI → 合并） | `normal` / `frozen` 下全部三层；`efficiency` 下只有受保护层 | Clued 合并位 / 合并队列 + `clued-merge-slot` 必需检查 | 已有合并位（Agent 手动取、45 分钟定时器）；本文改为队列（§7） |

**哪些路径要「按最终合并状态测过」**：只有受保护层**必须**（G3 是 G2 的组成部分：Owner 批的是 head，合并进去的必须就是那个 head）。普通代码层与文档层**接受**「合并后由 main 的 push CI 发现」：`clued-cloud-quality` 与各路径过滤的重任务都在 push 到 main 时运行；两个并发 PR 之间的文本冲突已被 G1 排除（活认领的 `write_set` 不相交），剩下的语义冲突由 main 的 push CI 暴露、以修复或回滚处理。但因为 GitHub 的 `strict` 是整个规则集一个开关、不能按路径设置，普通层与文档层在 v0.1 里**事实上也**按最终合并状态测过；本文不把这当作它们的保证，只当作 `strict` 的副作用（§7.5 说明为什么不关 `strict`）。

**不在保证之内**（原样沿用 WorkClaimAdmission §4.7 并补充）：main 上非受保护路径的代码没有人审；Agent 用 Owner 的 GitHub 身份（仓库管理员）能改规则集与变量；PR 正文可写别人的认领；准入读 head 与读文件列表之间的秒级 ABA；Host 本地的开销。

---

## 3. 路径分层

### 3.1 三层

| 层 | `id` | 含义 | 路径（匹配规则见 §3.2） |
| --- | --- | --- | --- |
| 受保护层 | `protected` | 守护生产与准入本身的代码与配置：改动合并后就是之后所有运行的判定代码 | **代码常量** `CORE_PROTECTED_PATHS`（= 现行 `PROTECTED_PATHS`：`.github/**`、`scripts/ci/**`、`scripts/runner/**`、`apps/clued-cloud/scripts/**`、`apps/clued-cloud/package.json`、`apps/clued-cloud/package-lock.json`、`apps/clued-cloud/wrangler*.jsonc`、`apps/clued-cloud/app/supabase-public-config.ts`、`.gitattributes`、`**/.gitattributes`、`.gitmodules`、`.npmrc`、`**/.npmrc`）**加上**策略文件自己 `config/merge-admission-policy.json`，再加上策略文件 `layers.protected.paths` 列出的追加路径。策略文件只能追加，不能移除常量里的任何一项 |
| 普通代码层 | `code` | 其余会被构建、部署或被带凭据的脚本加载的代码：`apps/clued-cloud/**`（除受保护项）、`kernel/**`、`scripts/**`（除 `ci`、`runner`）、`protocol/**`、`skills/**` 的脚本、`tests/**`、迁移 `apps/clued-cloud/supabase/migrations/**` 等 | 策略文件 `layers.code.paths`，默认 `**`（兜底层） |
| 文档 / 合同草案层 | `docs` | 不被执行的叙述文本（`design-refs`、`active-doc-links` 两个检查只读取、不执行它们）：`docs/**`、`development/contracts/**/*.md`、`development/authority-index/**/*.md`、根目录 `*.md`、`skills/**/*.md`（合同 `agent-contract.md` 例外，归 `code`：它随 Worker 下发并被钩子比对版本） | 策略文件 `layers.docs.paths` |

### 3.2 匹配规则

1. 一个 PR 的改动路径 = GitHub `pulls/{n}/files` 的 `filename` 与 `previous_filename` 的并集，**再并上**「base 分支当前 tip 对 head」的比较（`baseTipCompare`）列出的路径；比较被截断（≥300 个文件）时按受保护层处理（`protected_path_unknown`，现行行为）。
2. 每条路径按 `protected → docs → code` 的顺序匹配第一个命中的层（受保护优先；文档层的 glob 比兜底的 `**` 先匹配）。glob 语义与 `globToRegExp` 相同（`**` 跨段、`*` 段内、`**/` 匹配零层目录）。
3. **PR 的层 = 其所有改动路径中最严的层**（严格序 `protected > code > docs`）。一个只改 `docs/**` 和一个 `.md` 以外文件的 PR 是 `code`；任何一条受保护路径就是 `protected`。
4. 层不看 PR 标题、标签或作者。Dependabot 与 Owner 网页改动与其他 PR 同规则（CONTRIBUTING「Dependabot pull requests」沿用）。

### 3.3 策略文件

`config/merge-admission-policy.json`（本身是受保护路径）：

```json
{
  "schema": "clued.merge-admission-policy/1",
  "version": 1,
  "state_variable": "CLUED_MERGE_ADMISSION_STATE",
  "merge_slot_hard_cap_minutes": 120,
  "layers": {
    "protected": { "paths": [] },
    "docs": { "paths": ["docs/**", "development/contracts/**/*.md", "development/authority-index/**/*.md", "*.md", "skills/**/*.md", "!skills/clued/references/agent-contract.md"] },
    "code": { "paths": ["**"] }
  },
  "rules": {
    "normal":     { "protected": "<baseline>", "code": { "work_claim": "enforce", "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "required", "reruns_per_head": 1, "auto_merge": "allowed" },
                                              "docs": { "work_claim": "enforce", "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "required", "reruns_per_head": 2, "auto_merge": "allowed" } },
    "efficiency": { "protected": "<baseline>", "code": { "work_claim": "advise",  "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "advise",   "reruns_per_head": 2, "auto_merge": "allowed" },
                                              "docs": { "work_claim": "advise",  "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "advise",   "reruns_per_head": 2, "auto_merge": "allowed" } },
    "frozen":     { "all_layers_as": "protected", "merge_actor": "owner_only", "auto_merge": "forbidden" }
  }
}
```

- `"<baseline>"` 是字面占位：受保护层的规则**不从文件读**，由代码常量 `PROTECTED_BASELINE` 给出（§6）。文件里写别的值是 schema 错误。
- `merge_slot_hard_cap_minutes`（顶层，§7.3 的硬上限）：缺键按 120；取值范围 60–180 的整数，范围外是 schema 错误。
- 前缀 `!` 是排除项，只在该层内生效（把文件从本层让给下一层）。
- 文件从**默认分支**读取（准入运行本来就检出默认分支，`pull_request_target`），PR 改动的策略文件不影响对它自己的判定。
- 解析失败、schema 不符、缺文件：按 `frozen` 处理（fail closed），摘要写明原因。

---

## 4. 全局状态

三个，不多于三个。由仓库变量 `CLUED_MERGE_ADMISSION_STATE` 给出，取值 `normal` | `frozen` | `efficiency`；未设置视为 `normal`；任何其他值视为 `frozen`（fail closed，摘要写明）。

| 状态 | 含义 | 用途 | 对策略表的作用 |
| --- | --- | --- | --- |
| `normal` | 按表执行 | 日常 | 无 |
| `frozen` | 所有层按受保护层处理；只有 Owner 合并 | 事故、发布窗口、规则集改动期、复核进行中 | 每层的有效行 = `PROTECTED_BASELINE`，再叠加 `merge_actor: owner_only`、`auto_merge: forbidden`；每个 PR 都需要 Owner 对其精确 head 的 `repo.protected_change` 授权 |
| `efficiency` | 普通层认领降为提示、允许 auto-merge、放宽重跑 | 大量低风险并行改动、Owner 不在线而又需要吞吐时 | 用 `rules.efficiency` 的 `code` / `docs` 行；受保护层不变 |

### 4.1 切换边界

1. **只由 Owner 切**，通过仓库变量（Settings → Variables）。Agent 不得改这个变量，不得请求 Owner 改它来放过自己的 PR（与 GitConnectorWriteContract「An Agent never disables the ruleset…」同一精神）。Agent 用 Owner 身份能改它，是 WorkClaimAdmission §4.7 已写明的信任前提，本文不改变。
2. **每次切换写一条 Clued Decision**（`user_explicit`）：切到什么、为什么、预计持续多久、切回的条件。切回也写。Decision 由 Owner 口述、任一在场 Agent 记录，或 Owner 自己在 Clued 页面写。
3. **切换后立即重判所有打开的 PR**：Owner 在默认分支 `workflow_dispatch` 复核 workflow（`clued-work-admission-reverify.yml`），输入 `reason=state_change`；由 Agent 代劳时按[现行合同](../../../protocol/agent/agent-contract.md#appendix-a7) §1.7 与 Appendix A.7 先认领切换所对应的 Task（dispatch 是启动 CI）。复核在这个模式下对**每个**打开、非草稿、发往 main 的 PR 重新判定，并在其 head 上发一条新的 App check（成功或失败都发，与现行「只发失败」不同，见 §10）。每小时的定时复核兜底。边界：复核发出的 check 的 `external_id` 指向复核运行，加闸 workflow 的 gate 只认本事件准入运行的 check，所以切到更宽松状态后某个 head 若因此由红转绿，它的加闸重任务在该 head 上并未运行过；对普通层与文档层这是 §2 接受的（main 的 push CI 兜底），受保护层的判定不随状态变所以不会出现。gate 绑定本事件的准入运行，复核开始发成功 check 不重开复审 3 N-R1。
4. **GitHub 规则集的必需检查列表不随状态变**：始终是 `gitleaks`、`trivy`、`clued-work-admission`、`clued-admission-verified`、`clued-merge-slot`。状态只改检查内部的判定：例如 `clued-merge-slot` 在不需要合并位的层 / 状态下以 `not_required(<layer>, <state>)` 通过，与现行 `not_needed` 直接通过同一做法；`clued-admission-verified` 在认领为 `advise` 的层下，缺认领时仍成功，摘要写 `claim_advisory_missing`。
5. **切换不改 `strict`**、不改必需检查、不改 environment 与 secret。规则集改动期本身就是 `frozen` 的用途之一。

### 4.2 `frozen` 的两条说明

- 「只有 Owner 合并」在 GitHub 侧**不可强制**：Agent 与 Owner 共用同一 GitHub 身份。可强制的部分是：`auto_merge: forbidden`（准入运行与每小时复核都读 PR 的 `auto_merge`，非空即判 `clued-merge-slot` 失败并在摘要里要求关闭；准入 workflow 的 `pull_request_target` 类型需加 `auto_merge_enabled`、`auto_merge_disabled`，否则 check 变绿后再打开 auto-merge 要到下次复核才被发现）、每个 head 都要 Owner 授权（授权本身就是 Owner 看过这个精确提交；`frozen` 下即便被自动化合并，合入的也是 Owner 授权过的精确 head，失守的是 `merge_actor` 规则而不是 G2/G3）。「Agent 不在 frozen 下点合并」是合规规则（[现行合同 Appendix A.5](../../../protocol/agent/agent-contract.md#appendix-a5)），写进 Decision 与检查摘要。
- `frozen` 下每个 PR 都要 Owner 授权，Owner 的工作量就是 `frozen` 的成本，这也是它只用于短期窗口的原因。切回 `normal` 时所有 PR 由复核重判，授权只对受保护层继续需要。

---

## 5. 策略表

### 5.1 列与取值

| 列 | 取值（从严到宽） | 含义 | 在检查里的落点 |
| --- | --- | --- | --- |
| `work_claim` | `enforce` > `advise` | 认领缺失、过期、被接管、绑到别的 PR、`write_set` 不覆盖：`enforce` 判 REJECTED；`advise` 判 ADMITTED 并在摘要写明问题 | `evaluate()` 的 `claim_trailer_missing` 与 verify 结果处理 |
| `owner_grant` | `required` > `none` | 是否需要 Owner 对精确 head 的 `repo.protected_change` 授权 | `ownerReview()`；`none` 时不调用门口 |
| `up_to_date` | `check_and_strict` > `strict_only` | `check_and_strict`：head 不含 base tip 时检查本身判 REJECTED（`protected_change_not_up_to_date`）；`strict_only`：检查不管，交给 GitHub `strict` 在合并时拦 | `baseTipCompare` 的用法 |
| `merge_slot` | `required` > `advise` | head 含 base tip 时，`required` 要求该 PR 的认领是队列头（持有合并位），否则 `clued-merge-slot` 失败；`advise` 时该检查以 `not_required` 通过并在摘要写明是否持有 | `mergeSlotState()` / `mergeSlotCheck()` |
| `reruns_per_head` | 0 > 1 > 2 > 3 | 当前 head 上允许的「Re-run all jobs」次数（§8） | gate 的 `rerunAttempt()`；runner 开工前检查 |
| `auto_merge` | `forbidden` > `allowed` | Agent 拿到队列头后可否打开 GitHub auto-merge（§7.4） | `clued-merge-slot` 检查读 PR 的 `auto_merge` |
| `merge_actor` | `owner_only` > `any` | 谁可以点合并；只有 `frozen` 用 | 合规规则 + 摘要 |

### 5.2 推荐默认表（`normal`）

| 层 | `work_claim` | `owner_grant` | `up_to_date` | `merge_slot` | `reruns_per_head` | `auto_merge` |
| --- | --- | --- | --- | --- | --- | --- |
| `protected`（基线，代码常量） | enforce | required | check_and_strict | required | 1 | allowed |
| `code` | enforce | none | strict_only | required | 1 | allowed |
| `docs` | enforce | none | strict_only | required | 2 | allowed |

理由：

- `code` 层保留 `work_claim: enforce`：`advise` 不取消 Clued 对**已认领**工作的冲突判定（`work_claim_conflicts` 照常），它取消的是「未认领或 `write_set` 过窄的 PR 不得合并」这道门，而归属可追、按 Task 的 24 小时 head 计量（G4）、以及「没人认领就不会有人在 resume 里看到这份工作」都靠这道门。2026-10-01 的 #443/#444/#445 撞在依赖文件上，当时不受保护、现在属受保护层；同类撞车在 Worker 源码、测试、迁移上随时可能发生，而那些是 `code` 层。这**修正** Decision `f303f861` 第 3 项「认领只对受保护 PR 强制」（§9）。
- `code` 层保留 `merge_slot: required`：strict 开启时，一个普通代码 PR 的最后一轮是 5–30 分钟自托管 CI（报告 §4.3：只触发 `clued-cloud-quality` 约 5–10 分钟，命中四个路径过滤重闸 10–30 分钟），被别的合并插队就白跑；合并位的痛点是「Agent 轮询 + 45 分钟定时器」，§7 用队列和 CI 绑定时效解决痛点，而不是取消串行化。这也**修正** `f303f861` 第 3 项的合并位部分。
- `docs` 层也 `merge_slot: required`：strict 开启时，文档 PR 的合并同样让队列头（受保护或普通代码 PR）的最后一轮白跑 5–30 分钟自托管 CI，被插队的是队列头不是文档 PR 自己；而取位只是一次 `clued_work_renew`，文档 PR 自己的最后一轮几分钟就过，排队代价小。`efficiency` 下才改为提示（§5.3）。`docs` 层仍 `work_claim: enforce`：认领是一次 MCP 调用，没有出现在摩擦排序里，而归属可追是 Owner 要保留的另一件事。
- `reruns_per_head`：`f303f861` 第 2 项确认为 1（§8、§9）；文档层给 2，因为它的失败几乎都是基础设施原因（runner 排队超时、npm 超时）。
- `auto_merge: allowed` 对受保护层也成立：Owner 授权在前（授权的是精确 head），strict 保证合并结果就是那个 head，auto-merge 只是替 Agent 点那一下。
- 数据边界：报告 §4 的样本里没有仅文档 PR，也没有缺认领的 PR，所以 `docs` 行与 `work_claim: enforce` 是代价不对称的推理（一次续期 / 一次 MCP 调用，对一轮 CI / 归属与计量），不是数据结论；§12.1 的 `wasted_final_rounds`、`unclaimed_admitted` 上线后再核。

### 5.3 `efficiency` 与 `frozen` 的有效表

| 状态 | 层 | `work_claim` | `owner_grant` | `up_to_date` | `merge_slot` | `reruns_per_head` | `auto_merge` | `merge_actor` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| efficiency | protected | enforce | required | check_and_strict | required | 1 | allowed | any |
| efficiency | code | advise | none | strict_only | advise | 2 | allowed | any |
| efficiency | docs | advise | none | strict_only | advise | 2 | allowed | any |
| frozen | protected / code / docs | enforce | required | check_and_strict | required | 1 | **forbidden** | **owner_only** |

`efficiency` 下 `code` / `docs` 的 `work_claim: advise` 意味着缺认领的 PR 也准入：它们的加闸重任务照跑，且不计入 Task 的 24 小时 head 计量（gate 只读 App check 的结论，缺认领时不调用 verify，计量不发生），G4 对这两层不成立；`merge_slot: advise` 意味着接受白跑 CI 换吞吐。两项代价在 §12 的度量里能看到（`unclaimed_admitted`、`wasted_final_rounds`），Owner 据此决定在这个状态停留多久。

---

## 6. 不变量与保证方式

**I1 受保护层在任何状态下不放松。** 对每个状态 s 与每一列 c：`effective(protected, s).c ≥ PROTECTED_BASELINE.c`（按 §5.1 的严格序）。`frozen` 只能加严（`forbidden`、`owner_only`），不能改其他列。

**I2 受保护路径只能增不能减。** `effectiveProtectedPaths = CORE_PROTECTED_PATHS ∪ {策略文件路径} ∪ policy.layers.protected.paths`。策略文件的 `protected.paths` 不能移除常量项；`docs` / `code` 的排除项 `!` 不能把常量项让出去。

**I3 fail closed。** 状态变量取值未知、策略文件缺失或不合 schema、`<baseline>` 占位被改写：按 `frozen` 判定，摘要写明；不会因为配置错误而变宽。

**I4 必需检查集合与来源不变。** 五个检查名与 integration id（GitHub Actions `15368`、clued-admission App `5164952`）是代码常量；每个状态、每一层，`app-check` 都发 `clued-admission-verified` 与 `clued-merge-slot` 两条。

**I5 `strict` 不由策略控制。** 策略表没有任何一列能把 GitHub 的 `strict` 关掉或绕过；`up_to_date: strict_only` 只是「检查不提前拦」。

**代码上的保证**

- 新模块 `scripts/ci/merge-admission-policy.mjs`（受保护路径）：导出 `PROTECTED_BASELINE`（`Object.freeze`）、`CORE_PROTECTED_PATHS`、`STRICTNESS`（每列的序）、`loadPolicy(text) → {policy, errors}`、`resolveState(env) → {state, source}`、`layerOf(paths, policy) → layer`、`effectiveRules(policy, state, layer) → row`。`clued-work-admission.mjs` 只调用这些函数，自己不再持有分支常量。
- `effectiveRules` 对 `protected` 层**忽略**文件内容，直接返回 `PROTECTED_BASELINE`（`frozen` 时叠加两列）；对 `frozen` 状态对所有层返回同一行。这两条是函数体的前两个 `if`，不是靠配置约定。
- 策略文件在 `CORE_PROTECTED_PATHS` 里，所以改它要 Owner 授权；而受保护层的规则根本不在文件里，所以即使 Owner 批错了文件也放松不了受保护层。

**测试上的保证（表驱动）**

- `scripts/ci/merge-admission-policy.test.mjs`（受保护路径）：
  - 不变量测试：对 `{normal, efficiency, frozen, <未知值>, <缺文件>}` × 每一列，断言 I1；对每一条 `CORE_PROTECTED_PATHS` 断言 `layerOf([path]) === "protected"`，再对一份试图把它们写进 `docs.paths` 或用 `!` 排除的策略断言仍为 `protected`（I2）；对坏策略 / 坏状态断言 `state === "frozen"`（I3）。
  - 矩阵测试：一张 fixture 表 `(state, layer, scenario) → expected`，scenario 覆盖：缺认领、认领过期、`write_set` 不覆盖、无授权、授权延续、head 不含 tip、持有 / 不持有队列头、attempt 2 / 3、PR 打开了 auto-merge。每新增一列或一个状态，只加 fixture 行，不改断言代码。
  - 守恒测试：对每个 `protected` scenario，`verdict(normal) === verdict(efficiency)`（I1 的行为版本）。
- 现有 `clued-work-admission.test.mjs` 保留对 workflow 守卫、App check、复核的测试；凡是今天硬编码 `PROTECTED_PATHS` 的用例改为读 `CORE_PROTECTED_PATHS`。
- `.github/workflows/clued-work-admission.yml` 的自检步骤加入新测试文件；自检列表不再手写加闸 workflow 清单（PR #614 已改为派生，避免 Decision `22c20e14` 的死锁根因）。

---

## 7. 合并位 → 合并队列

### 7.1 现行与问题

现行合并位（WorkClaimAdmission §4.4「合并位」）：Agent 在最后一轮前续期认领、把 `merge:<owner>/<name>:main` 加进 `trigger_refs`；冲突即等待、每 10 分钟重试；位在最后一次续期后 45 分钟失效；持位者并入 main、推送、等 CI、合并，再续期去掉引用。问题：等待靠轮询（每次重试都是一次 Clued 调用与一次 Agent 回合）；45 分钟与 CI 实际时长无关（最长的加闸 workflow 超时 35 分钟，加上排队常超过 45 分钟，持位者还得每 30 分钟续期）；守 CI 是 Agent 的工作（一个会话挂在那里）；合并要 Agent 点。

### 7.2 目标形态（分两步实施，§13）

**队列**：Clued 把合并位从「一个互斥的触发引用」改为**每个仓库默认分支一条 FIFO 队列**。队列项 = `(pr_ref, claim_id, enqueued_at, layer, state_at_enqueue)`。

- **入队**：Agent 在 PR 准入通过、当前 head 的 CI 绿、合并已获所需批准（受保护层即 Owner 授权已放行）后调用入队。v0.1 为了不加新工具，入队仍是 `clued_work_renew` 带合并引用；服务端不再返回 `work_claim_conflict`，而是返回 `merge_queue: {position, ahead: [...]}`。位置 1 即「持有合并位」，与今天同义。代价变化：今天被拒的续期不计次数、不耗令牌，入队成功的续期计一次续期（上限 12）并需要新的 `progress_ref`；只入队一次，可接受。
- **队列头的工作**：并入 main（如果 head 还不含 tip）→ CI → 合并。第一步实施里仍由 Agent 做并入与推送；第二步由执行器做（§7.3）。合并由 GitHub auto-merge 做（§7.4）；GitHub 已可合并、不再接受 auto-merge 时由执行器直接合并（§7.3 第 5 步实施说明，Task `ff476b06`）。
- **出队**：PR 合并（现有 `clued_work_claim_adopt_v1`）、关闭（现有 `clued_work_merge_slot_return_v1`）、队列头的 head 上任一必需检查**最终失败**（§7.3 的执行器上报 `ci_failed`，与 GitHub merge queue「CI 失败即移出」相同）、持有者主动退出（续期去掉引用 / 释放认领）、兜底时效（§7.3）。出队后下一项成为队列头；它的 PR 如果已含 tip 就可直接进 CI，否则并入 main。
- **插队**：没有。Owner 需要紧急合并时用 `frozen`（队列照常，只是人人要授权）或自己手动合并（它移动 main，队列头的最后一轮白跑一次，这是 Owner 的选择）。
- `clued-merge-slot` 检查：head 含 tip 且该层 / 状态要求合并位时，只有队列头通过；否则按 §4.1 第 4 条通过。

### 7.3 位的时效：绑 CI 运行状态，定时器只做兜底

**结论**：绑 CI 状态，保留兜底定时器。

- 队列头的位在以下事件间保持：head 上**默认分支定义的**加闸 workflow 的运行处于 `queued` / `in_progress`（判定见下）；`green`（四个 CI 类必需检查全部成功）且 head 含 tip、等待 auto-merge（30 分钟，自 `clued-merge-slot` 也转绿起算；四绿、含 tip 而 `clued-merge-slot` 尚未重判的 head 由 Agent 编辑 PR 触发重判，期间只受 45 分钟无活动兜底约束）；执行器正在并入 main。
- **出队条件**：四个 CI 类必需检查（`gitleaks`、`trivy`、`clued-work-admission`、`clued-admission-verified`）中任一最终失败；或自上次 CI 活动起 45 分钟无任何运行（兜底，沿用现值）；或自取位起 `merge_slot_hard_cap_minutes`（策略文件参数，默认 120 分钟：排队 p95 约 26 分钟 + 最长 workflow 超时 35 分钟 + 一次重跑 35 分钟再留余量；报告 §4.2 的排队最大值 48.6 分钟说明 90 分钟会把合法队列头在 CI 中途踢出）。`clued-merge-slot` **不在**出队条件里：它是位状态的结果而不是 CI 的结果，刚成为队列头、head 已含 tip 的 PR 在重判之前它本来就是红的，拿它出队是循环依赖。
- **谁上报 CI 状态**：不是 Agent，是运行默认分支代码、持 ci-admission Binding 的 GitHub Actions job（`clued-admission` environment）。触发：`workflow_run: completed`、`push` 到 main、每小时定时、`workflow_dispatch`。它调用新 RPC `clued_work_merge_slot_touch_v1(pr_ref, head_sha, ci_state)`（仅 ci-admission Binding）：`ci_state ∈ {running, green, failed}`；`running` / `green` 刷新位的时钟，`failed` 出队并留 `WORK_CLAIM_MERGE_SLOT_RETURNED(why=ci_failed)` 回执。这样 Agent 不再为了保位而续期；认领的续期回到它本来的用途（进展）。
- **输入不信 PR**（复审 2 N3c、复审 3 N-R1 的同类问题）：`workflow_run` 事件由 workflow 名字匹配触发，PR 自带的 workflow 也会触发它，事件负载的 `name`、`head_branch`、`conclusion`、`pull_requests` 都来自 PR 控制的运行，所以这个 job 只把事件当作「去看一眼」的信号，判定全部来自它自己的查询：
  - head → PR：`GET /repos/{o}/{r}/commits/{sha}/pulls`，只取打开、base 为默认分支的 PR；不读负载的 `pull_requests` 或 `head_branch`。
  - `failed` / `green`：只看四个 CI 类必需检查，按 (检查名, integration id) 识别（Actions 15368 的 `gitleaks`、`trivy`、`clued-work-admission`；App 5164952 的 `clued-admission-verified`），取 head 上各自最新一条 check run，与规则集同一口径；`clued-merge-slot` 不计（见出队条件）；PR 自带的同名 job 是另一来源，不算。
  - `running`：只由默认分支上存在、且在 PR head 处文件内容与默认分支相同（contents API 的 blob SHA 相等）的加闸 workflow 的运行刷新；PR 自带或改过的 workflow 不计（改过的本来就是受保护改动，要 Owner 授权）。
  - 兜底写进 §14：一个已准入的 PR 仍可能用加闸 workflow 内的长任务把位撑到硬上限（默认 120 分钟）；今天的 45 分钟无续期即失效在这一点上更紧，所以硬上限不放宽到 3 小时，并由 `wasted_final_rounds` 与误出队计数观察后调。
- 复核（`reverify`）对队列头以外、却仍绿着 `clued-merge-slot` 的 head 补发失败检查（现行）。

**实施说明（2026-10-08，第 3 步，Task `3576d10d`，Owner Decision `4f576896`、`1fb7f6b3`；已按独立复审修正）**：第 4 步（队列）之前，位仍是互斥的触发引用，第 3 步只换它的时钟。落地时与上文的差别如下，均不放松 §2 的保证：
- 上报在两处运行：独立的 `.github/workflows/clued-merge-slot-ci.yml`（Owner 选择，不放进准入 workflow，避免与 PR 事件的并发组互相取消）在 CI workflow 的 `workflow_run: completed` 与 `workflow_dispatch` 时运行，只处理 `pull_request` / `pull_request_target` 事件的运行（事件只用来跳过，不用来判定）；每小时一次的上报是 `clued-work-admission-reverify.yml` 里的一个步骤（定时、push 到 main、手动），不多占托管运行。
- 运行开始不产生事件，两次上报之间可能隔一小时，所以 `running` 保位 90 分钟（不是 45 分钟），由硬上限兜住。
- head → PR 不用 `commits/{sha}/pulls`：job 先读打开的 PR 列表，从 PR 正文（没有时从 head 提交）的认领尾注取作用域，再用新 RPC `clued_work_merge_slot_holders_v1(scope, repository)` 向 Clued 取持位者，只看持位 PR 的当前 head。事件内容一律不用：并发组只留一个待运行的上报、丢掉其余，所以每次上报都看所有持位 PR（确认复审 MINOR-A）。
- `running` 除加闸 workflow 外，也算 `gitleaks.yml`、`trivy.yml` 的运行（同样要求 head 处文件与默认分支 blob SHA 相同）；只认 `pull_request` 事件的运行。改了这些 workflow 文件的 PR 不会被报 `running`，合同要求此时照旧续期。判定顺序：四个 CI 类必需检查任一最新一条最终失败（`failure`、`timed_out`、`action_required`、`startup_failure`；`cancelled` 不算，编辑 PR 会取消同一 head 上的准入运行）→ `failed`；否则有计入的运行在排队或进行 → `running`；否则只要该 PR 的 head 上还有未计入的运行（PR 新增或改过的 workflow）→ 不上报（不算 `green`，确认复审 MINOR-C）；否则四个都通过 → `green`；其余不上报。
- `green` 的 30 分钟从该 head 第一次 `green` 上报起算，不另查 `clued-merge-slot` 是否已绿，也不查 head 是否含 tip：持位者本来就在取位后才并入 main。续期仍刷新 45 分钟时钟，位在两个时钟中较晚者失效；硬上限从取位起算（取位 = 带合并引用签发、新加合并引用、或位已失效时带合并引用续期），每次上报带上策略文件的 `merge_slot_hard_cap_minutes`，到点即失效，上报不能复活已失效的位。硬上限只为正在等位的会话腾出位：位空着时，原持有者续期就会像新取位一样再取到（复审 MINOR-2，接受）。
- `failed` 立即还位，回执 `WORK_CLAIM_MERGE_SLOT_RETURNED(why=ci_failed)`，并在该 head 上发一条失败的 `clued-merge-slot` App check，免得重跑转绿后 auto-merge 在没有位时合并（复审 MAJOR-2）；只在策略要求合并位时发（`efficiency` 与提示模式不发，确认复审 MINOR-B），之前没发成、最新一条仍绿时下次补发（确认复审 NIT-2）；`running` / `green` 在状态或 head 变化时写 `WORK_CLAIM_MERGE_SLOT_TOUCHED`。认领视图增加 `merge_slot_ci`（取位时间、硬上限、最近一次上报）。
- 合同 §1.7 随本步发 agent-contract v40（Owner 在 Decision `1fb7f6b3` 选择，再次豁免每周一版）：有上报的仓库不再为保位续期；看不到对当前 head 的上报、或 CI 仍在跑而 `merge_slot_until` 不到 10 分钟时照旧续期；任一 CI 类必需检查失败即关掉 auto-merge。
- 上线顺序：先应用迁移，再合并（迁移未应用时上报只记 notice，不报错），最后发布 Worker 对外服务 v40。

**实施说明（2026-10-09，第 4 步，Task `38e0c90d`，Owner Decision `661f8c36`、`b4a19a1f`）**：迁移 `20261009080000_work_claims_merge_queue_v1` 把合并位改成队列。落地时与上文的差别如下，均不放松 §2 的保证：
- 队列项就是带合并引用的认领本身，不另建表：入队时间记在认领的 `merge_queued_at`（带合并引用签发、新加合并引用、或位已失效 / 已出队时带合并引用续期）。`layer`、`state_at_enqueue` 不入队：准入在每个 head 上照常判定，队列只决定谁持位。队列每次读取时按入队顺序现算，没有后台任务。
- `work_claim_conflicts` 不再把合并引用算作冲突；签发与续期都成功，认领视图多一个 `merge_queue`：每条合并引用一项，含本认领的 `state`（`head`、`waiting`、`lapsed`、`out`）、`position`、队列头与排在前面的项。只有队列头持位：`merge_slot_until`、`merge_slot_ci`、`clued_work_merge_slot_holders_v1`、`clued_work_merge_slot_touch_v1` 与 `clued-merge-slot` 检查都只看队列头，所以第 3 步的上报与检查不改即按队列工作。
- 队列头的位从它成为队列头起算（入队时，或前一项离开 / 失效时），沿用第 3 步的时钟：续期 45 分钟（成为队列头之前的续期按成为队列头的时刻计，新队列头至少有 45 分钟）、`running` 90 分钟、`green` 30 分钟、硬上限从成为队列头起算、不超过认领租约；成为队列头之前的 CI 上报不计。等待中的项没有时钟，续期只保租约、不改位置。
- 出队：合并、关闭、CI 失败（三者都去掉认领的合并引用）、持有者续期去掉引用或释放认领、认领过期、位失效。合并引用的集合有任何变化（换分支、加一条；只差大小写不算）都按重新入队处理，排到队尾：入队时间每个认领只有一个，不能借旧时间插队（独立复审 MAJOR-2）。队列头或已失效的项离开时，Clued 在私有表 `work_claim_merge_queue_v1` 按账号与合并引用记下离开时刻与它的入队位置；排在它之前、仍带引用的已失效项从此为 `out`，不会因为后面的项离开而「复活」，下一项的位从离开时刻起算；已失效项离开时记的是它之后的游标（失效时刻与起算时刻中较晚者），租约在轮到它之前就已到期的项离开也不会把队列头的起算时刻往前推（独立复审 BLOCKER-1）。`lapsed` 或 `out` 的项带引用续期即重新排到队尾。
- 上报（`clued-merge-slot-ci.mjs`）不再把成为队列头之前就已失败的准入检查（`clued-work-admission`、`clued-admission-verified`；`gitleaks`、`trivy` 的失败是 head 自己的，照旧）报成 `failed`：等待期间 main 前进，旧 head 的准入检查会失败，队列头需要这个位来并入 main 并推送（2026-10-09 #650 的退位即此情形，Note `ffc74d6d`）。这样的失败让该 head 不报 `green`；新 head 的 CI 照常上报。成为队列头之后的失败照旧立即还位并出队。
- 合同 §1.7 随本步发 agent-contract v42（#653 已用 v41；Owner 在 Decision `b4a19a1f` 同意随第 4 步发版）：合并引用排队、不冲突；先并入 main 并推送再入队；等待时约每小时续期一次保租约（租约 2 小时，续期上限 12 次）、不为合并做任何事；成为队列头后如 main 已前进再并入。同时写入 runner 钩子 `merge-admission-ungated-rerun` 的重跑规则（§8 第 5 项）。
- 上线顺序：先应用迁移（v40/v41 的 Worker 与 Skill 读到 `merge_queue` 只是多一个字段；旧合同的 Agent 不会再收到合并位冲突，按旧文字会以为已持位，所以紧接着发布 Worker v42），再合并，最后发布 Worker 对外服务 v42。

**实施说明（2026-10-09，第 5 步，Task `91039d74`，Owner Decision `661f8c36`、`5aa668e3`；费用治理 Task `4d614afb`）**：`scripts/ci/clued-merge-executor.mjs` 在 `clued-merge-slot-ci.yml` 的 `report` job 最后一步执行，只有前面的 CI 状态报告成功后才运行；同一默认分支代码、clued-admission 环境与 App 凭据，不再通过 `workflow_run` 拉起第二个执行器 workflow。`clued-merge-executor.yml` 保留每次推送 main 后（下一个队列头此时落后）与手动运行，已取消每小时定时；漏掉的完成事件由后续 main 推送或显式协调恢复。报告与执行合计保留原两个五分钟 job 的十分钟预算，末尾执行器步骤另限五分钟，仍在 slim 十五分钟上限内。报告 job 与独立执行器 job 使用同一固定并发组 `clued-merge-executor`，不取消运行中的 job；两个入口不能同时执行队列变更。突发事件只保留一个待运行 job；两个入口都先运行同一 CI 状态报告，再在报告成功后执行同一执行器，因此 main-push/manual 的待运行 job 替换报告入口时也会更新失败检查与归还失败 slot，不会遗漏报告。独立入口同样使用总十分钟、末尾执行器步骤五分钟预算。与上文的差别如下，均不放松 §2 的保证：
- 只为默认分支队列的队列头做事（`clued_work_merge_slot_holders_v1` 自第 4 步起只列队列头，并按 `merge:<owner>/<name>:<default>` 过滤）；只处理同仓库、非草稿、指向默认分支的打开 PR。
- head 落后默认分支时，用 GitHub「update branch」把默认分支并入（合并提交，`expected_head_sha` 绑定读到的 head）；只并入默认分支的 head 保留 Owner 授权（Decision `a0d93cd0`），App 的推送会触发 CI（`GITHUB_TOKEN` 的推送不会）。冲突或 head 已变时 GitHub 拒绝，执行器只记 notice，由持有者处理。受保护层的 PR 不代为并入：默认分支若改了它也改的受保护文件，合并提交需要新的 Owner 授权，由持有者处理（复审 MINOR-4）。
- auto-merge 只在 PR **为这个 head 选择加入**时打开：非受保护层的认领续期 `progress_ref` 等于当前完整 40 位 head SHA（不分大小写）也算同意，原因写 `opted in by the claim renewal at <sha>`；受保护层仍只认正文行。正文有一行 `Clued-Auto-Merge: <40 位 head SHA>`（Agent 在该 head 的合并获批后写），且当前 head 就是它，或它是当前 head 的祖先、并且自它以来改过的每个文件都与默认分支上的版本逐字节相同（不在 head 对 tip 的差异里；任一差异达 300 个文件即视为不覆盖）。所以批准后只有来自默认分支的改动；手工解决冲突或改过内容的合并提交都需要新的一行（确认复审 MAJOR）。行与 head 不符而 auto-merge 已开时，执行器把它关掉（复审 MAJOR-2）。另需 head 含默认分支 tip、本 PR 的 `clued-admission-verified`（`external_id` 指向本 PR）为通过且标题带模式、策略对该状态与层允许 auto-merge（受保护层仅在 Owner 复核强制时）、head 上没有最终失败的 CI 类必需检查、auto-merge 尚未打开。auto-merge 在该 head 上每个已运行的 CI workflow 都通过、门禁通过且门禁后的 job 真正跑过之后才打开（每个 workflow 的自托管 / 托管两个变体总有一个被跳过，不算）（门禁 workflow 都不是必需检查，GitHub 的 auto-merge 只等必需检查；Task `114d43cf`，此前曾在 CI 结束前就打开），此后由 GitHub 等仍在跑的必需检查（§7.4）：GitHub 对已经可以合并的 PR 拒绝打开 auto-merge（"clean status"，复审 MAJOR-1），这种情况下，上述条件同样成立、且该 head 上每个 CI workflow（门禁 workflow 与必需检查的 workflow）最新一次 `pull_request` 运行都已完成、成功、门禁通过且门禁后的 job 真正跑过时，执行器就以 clued-admission App 直接合并（`PUT pulls/{n}/merge`，合并提交，`sha` 绑定读到的 head；规则集照样要求全部必需检查），这一行就是合并授权，不再让 Owner 或 Agent 去点合并（2026-10-09 Owner 指为机制缺陷后决定，Task `ff476b06`）。门禁 workflow 都不是必需检查，GitHub 把被跳过的 job 算作通过，所以只看「clean」会合进测试没跑过的 head（复审 MAJOR-1）；"unstable"（非必需检查失败或未完成）一律不合。不合或 GitHub 拒绝合并（405 必需检查未满足、409 head 已变）时记为 `mergeable_now` 并报出原因，其他拒绝记为 `merge_refused`。状态在执行器脚本开始时读取；两个入口的执行器步骤都至多运行五分钟，且受所在十分钟 job 的剩余预算限制。读取后切到 `frozen` 不会拦下已经决定的合并（复审 MINOR-1）。执行器的合并是实质结果，由持有者在下次 resume 时记入 Clued（复审 MINOR-3）。用 GraphQL `enablePullRequestAutoMerge`（`MERGE`，`expectedHeadOid`）。没有正文行或适用的续期同意时 Agent 照旧自己合并，执行器也不动别人打开的 auto-merge：Owner 现行的「合并前先问」不因执行器而被绕过。
- 准入后的队首 head 上，最新 `pull_request` 运行成功、`admission-gate` 成功且至少一个其它 job 存在、全部为 `skipped` 时，执行器自动调用完整运行的 `POST /repos/{repo}/actions/runs/{id}/rerun` 一次；`run_attempt` 必须为 1 且小于 `1 + reruns_per_head`（取精确 head 的准入标题），未知 attempt/模式、超限、已自动重试、未准入或 job 列表截断时不重跑。重跑前重验 PR head 与 run attempt；两个串行入口的 `actions: write` 用工作流自己的 token，不扩大 App 权限。重跑不授予合并同意。Task `58c083f5`。
- CI 失败退合并位后，以 `ci-failed:<claim>:<head>` 幂等地向持有认领的 Binding/session 写一条 Clued info 消息与 `AGENT_MESSAGE_SENT` 回执，含提交、原因及修复后用新 head 续期并带 merge 引用重新入队的步骤。通知不占普通发信额度；撤销、过期、不能读取 context 的收件者及关闭消息开关时静默跳过。续期或 resume 返回收件箱摘要，Agent 读取消息、核对 head 并先修失败再入队。超时、非队首 CI、冲突和评审通知仍在本次排除范围（Owner Decisions `6678e107`、`5d7d3913`；Task `58c083f5`）。
- 执行器只合并选择加入且 GitHub 已可合并的队列头（见上），从不推默认分支（规则集禁止，App 不在 bypass 名单）；`frozen` 时立即返回，不查询队列。只处理正文写明认领的 PR（合并提交不带尾注，复审 MINOR-3）；报告 job 已跳过、取消或失败时，不运行末尾的执行器步骤（复审 MINOR-5 的边界保留）。
- 需要 App 的 Contents: write 与 Pull requests: write。Owner 授予之前，令牌请求被拒（422），执行器只记 notice、什么都不改（Owner 选择先写代码、上线前再加权限）。
- （已由下条取代）合同 §1.7 本步不改（避开 Task `af536fcc` 正在搬动的合同文件）：Agent 自己并入 main、自己合并仍然有效；执行器只是先替它做。等合同搬出 Skill 包后再写入「入队后可交给执行器」与 `Clued-Auto-Merge: <head SHA>` 行。
- 合同 §1.7 的这部分随 agent-contract v44 写入（2026-10-10，Task `0a52ac27`，Owner Decision `298a4958`）：合同仍在 Skill 包里，Task `af536fcc` 的搬移须逐字节带上 v44；合并获批后在 PR 正文写 `Clued-Auto-Merge: <head SHA>`，认领保持有效到合并，执行器所做的合并由持有者记入 Clued。

费用治理保留 `clued-work-admission-reverify.yml` 每小时的准入撤销复核和 CI 状态上报；独立托管 `clued-ci-health.yml` 改为每六小时 `17 */6 * * *`，自托管 heartbeat 仍每十五分钟。执行器无定时、复核每天 24 次、健康监测每天 4 次，三项定时从预计 72 次/日降至 28 次/日；实际费用须在全部治理落地后观察至少 24 小时，不能把该次数预期当作节省实测。

### 7.4 用 GitHub 原生 auto-merge 替代 Agent 守 CI

**R1 执行资格守卫的实施边界（2026-10-10，原 Task f52ca0dd）**：下面的 auto-merge 推荐与旧实施记录保留历史依据。执行器的后继只在完整适用 CI、可信工作流/独立角色、真实主 job/关键 steps、当前许可/撤销/精确 head/FIFO/opt-in 均通过后，以 GitHub 原生 `clean` 状态和 match-head 的普通 merge API 合并；不再创建一个只等待 ruleset 必需检查的托管 auto-merge 请求。它保留策略 `auto_merge: allowed` 的自动执行许可语义，没有放宽保护层或引入新的合并权限。

**R1 等待策略后继（2026-10-11，原 Task f52ca0dd）**：保留自托管 gate，默认轮询等待从 480 秒改为 180 秒；`CLUED_ADMISSION_GATE_WAIT_SECONDS` 只可缩短，不能延长该轮询预算。预算不包含 checkout、启动与 API 请求耗时，workflow 的原 10 分钟 job 超时保持。到期仍无本事件可信 App check 时，输出 `admitted=false`，不运行重任务；之后到达的成功 check 不把已结束的 gate-only / skipped 运行升级为测试通过。执行器仅在当前 head 的真实准入及允许重跑次数、可信源和 gate-only 资格均满足时，沿用一次 `Re-run all jobs` 恢复；只有该新 attempt 的适用主 job 与关键 steps 真正成功，才允许后续合并。撤销、失败、新 head、超重跑次数与未知身份继续拒绝。七日 quality 命令 elapsed 的长尾包含未准入或 UNKNOWN，不作为纯 App 等待或“全部准入均在 180 秒内”的证据；本调整接受慢准入需一次受控恢复的代价，不声称已测得全池等待或账单节省，也不撤回自托管优先的 Decision f86179b3。

报告入口与执行器在任何慢资格观察、Clued 重验之前，先关闭由 executor 管理的遗留请求（App 启用，或正文有精确 `Clued-Auto-Merge` 标记）；该 PR 在本入口函数调用中只清理；同 job 的下一独立入口或后续自然事件必须重新读取 auto-off 状态，并重新核完整资格。手动且没有该标记的 Owner auto-merge 不被接管。这样不会形成每次 report 都关闭再打开请求的事件循环。清理失败或权限未知时，不继续该 PR 的资格/执行，也不冒关闭成功。

未知、未登记源、gate/helper 成功而主步骤 skipped 不算完整执行；未知不写永久失败/pending 必需检查，只不上报 green。真正失败仍还位。授权慢读结束后，最后轻量重验 Native PR/head/main、latest run/attempt、全部必需检查及未完结运行；不以旧 head/旧 attempt CI 合并。尚未登记的合法 workflow 与 fixture 可以在同一 PR 独立审阅、精确 Owner Grant、全部适用真实 CI、FIFO、没有等待请求后正常平台合入，合入后才成为 trusted main 的自动资格来源。普通 protected-change Grant 不自行变成新的 Role 语义接受；没有强制先登记的两阶段治理或让所有非 CI workflow 登记为测试。

**结论：可以，且推荐；前提是 Owner 在仓库设置里打开 `Allow auto-merge`（现为关闭）。** GitHub 文档：auto-merge 在公开仓库对 Free 可用，对私有仓库在 GitHub Pro、Team、Enterprise 可用。本仓库是个人账号私有仓库，账号计划从 Agent 侧 API 读不到（令牌无 `user` scope）；它已对私有仓库启用了规则集与分支保护，通常意味着 Pro 及以上，Owner 打开设置时 GitHub 界面会直接显示该选项是否可用，以此为准。

- **顺序**：Owner 合并批准（受保护层的 `repo.protected_change` 授权）在前 → PR 准入通过 → 入队 → 队列头 → Agent（或执行器）打开 auto-merge → GitHub 在全部必需检查通过且 head 含 tip 时合并。auto-merge 不绕过任何必需检查：`clued-merge-slot` 变红它就不合并，这正是把位绑到必需检查上的意义。
- **谁打开**：第一步实施里由 Agent 用 `gh pr merge --auto --merge` 打开（它用 Owner 身份，权限足够）；第二步由执行器打开（需要 App 的 `pull_requests: write` + `contents: write`）。PR 已可合并时 GitHub 拒绝打开 auto-merge，执行器在同样条件下、且每个 CI workflow 都已在该 head 上跑完并通过（门禁跳过的 job 不算通过）时直接合并（Task `ff476b06`）。
- **策略列** `auto_merge: forbidden`（仅 `frozen`）：检查读到 `pr.auto_merge` 非空即判 `clued-merge-slot` 失败，摘要要求 `gh pr merge --disable-auto`。
- **已知边界**：auto-merge 在「没有写权限的人推了新提交」或改了 base 分支时被 GitHub 自动关闭；Agent 有写权限，所以并入 main 的推送不会关掉它。auto-merge 不会替 PR 并入 main（`allow_update_branch=false`，且 strict 下 GitHub 不自动更新分支），所以「并入 main」仍是队列头的工作（§7.2）。

### 7.5 能否按 `write_set` 影响范围并行，取代受保护 / 非受保护二分

**结论：在合并这一步不能，只要 `strict` 开着；而 `strict` 必须开着。** 关掉 `strict` 确实能换来非受保护层的并行合并（这正是 §2 让普通层与文档层「接受 push CI 事后发现」的全部意义），代价是受保护层失去 G3，而 GitHub 的 `strict` 不能按路径开。分层（§3）取代了二分，但它分的是「要什么保证」，不是「能否并行合并」。

- `strict` 是规则集的一个开关，整个 main 一个值。开着时，任何一次合并都让其他「已含 tip」的 PR 立刻不满足条件，合并天然串行；这与 PR 之间是否相交无关。
- 关掉 `strict` 换并行合并，受保护层就失去 G3：Owner 批的是 head，合并结果是 GitHub 对新 main 的三方合并；main 在授权后动过受保护文件时，合入的受保护文件内容既不是 Owner 批的也不是 CI 测的。复审 9、10、11 讨论过「检查时判定 + 几分钟后复核」关不掉这个窗口，结论就是开 `strict`。靠队列独占来替代（队列头期间不许别人合并）在 GitHub 侧同样不可强制：别的 PR 的 `clued-merge-slot` 检查是判定时的结论，不是合并时的。
- 所以 `write_set` 不相交带来的并行性用在三处：（a）最后一轮之前的 CI 全部并行（现状）；（b）`efficiency` 下普通层与文档层免合并位（§5.3）；（c）v0.2 的批量测试候选：队列里相邻、`write_set` 不相交、都不含受保护路径的项可以合成一组测一次（Bors / GitHub merge queue 的做法），失败时二分（§7.6）。GitHub merge queue、Bors、Zuul 在 strict 语义下的并行也全是靠「推测合并后测试」，没有别的办法。
- Trunk 的「impacted targets 并行队列」在本仓库的对应物就是认领的 `write_set`：两个活认领不相交已由 Clued 保证，所以队列里不需要再算影响范围；它的价值在（c）而不是在合并顺序。

### 7.6 v0.2 评估项：批量与二分

不在 v0.1 做（Decision `8e767ed8`：批量测试与失败二分放后期评估）。进入评估的条件（§12 的度量给出）：队列深度 p95 ≥ 3，或最后一轮 CI 时长中位 ≥ 20 分钟。做法候选：执行器把队列头后面 k 个不含受保护路径、`write_set` 两两不相交的项并成一个临时分支 `merge-group/<id>`（像 GitHub 的 `gh-readonly-queue/*`）跑一次 CI，通过则按序合并全部，失败则对半分。前提是执行器已有 App 写权限（§13 第 5 步）。评估项：Task `7f205c71`。

---

## 8. 重跑：每个当前 head 一次

确认 Decision `f303f861` 第 2 项，并加三条边界：

1. 允许的是 **「Re-run all jobs」**，对 `pull_request` / `pull_request_target` 运行，且该运行的 `head_sha` 等于 PR **当前** head，`run_attempt == 2`（`reruns_per_head: 1`）或 ≤ `1 + reruns_per_head`。gate（`rerunAttempt()`）据此放行并在重跑里重新读 App check，所以 Owner 授权后的重跑能让此前被跳过的加闸任务运行——这取代「授权后关闭再重开 PR」。重跑按**每个 workflow 运行**计：一个 head 上最多 10 个加闸运行，可能要各点一次，不像关闭重开一次解决；执行器（§13 第 5 步）可代点。
2. **「Re-run failed jobs」仍拒绝**：它沿用 gate 上一次的输出，不重新判定（复审 3 N-R3、复审 5 n2）。gate 自己拦不住它（成功过的 gate job 在这种重跑里不再运行），所以 runner 开工前检查是唯一执行者，其放行条件写明为：`GITHUB_RUN_ATTEMPT ≥ 2` 时，`GET /repos/{o}/{r}/actions/runs/{run_id}/attempts/{n}/jobs` 里必须存在**同一 attempt** 的 `admission-gate` job 且 `conclusion=success`（证明 gate 在本次 attempt 重新判定过），否则拒绝；只看 `GITHUB_RUN_ATTEMPT == 2` 会把「Re-run failed jobs」一起放进来。

   **更正（2026-10-08，Owner Decision `77216370`）**：上面「同一 attempt 的 `admission-gate` job 且 `conclusion=success`」分不出「Re-run failed jobs」：GitHub 在新 attempt 的 job 列表里照样列出上一次没有重跑的 gate job，结论为 `success`（在 microsoft/vscode 运行 37727629063 上实测）。所以 runner 开工前检查还要求该 gate job 的 `started_at` 不早于运行的 `run_started_at`（每个 attempt 各自更新），观察不到（job 列表不完整、时间读不到）即拒绝。同一 Decision 允许 `gitleaks`、`trivy`（没有 gate 的必需检查）在打开的 PR 的当前 head 上重跑一次（attempt ≤ 2）。Decision `1b93760d` 取代 `610eeaaa`。

3. 旧 head（不是 PR 当前 head）的重跑仍拒绝；第 `2 + reruns_per_head` 次起拒绝。runner 开工前检查需要 Owner 在每台 runner 上更新钩子脚本（Decision `f303f861`）。
4. 准入运行（`pull_request_target`，默认分支代码）的重跑不受次数限制：它每次都重新读 PR 与 main 当前代码，没有「沿用旧输出」的问题。
5. **没有 gate 的自托管短检查**（例如 `runner-budget-policy`）可以在 PR 当前 head 上用「Re-run all jobs」重跑一次（attempt 2）。runner 钩子 `merge-admission-ungated-rerun`（Task `26cced7e`，Owner Decision `661f8c36`，2026-10-09 起七台 runner 已装）放行的条件：本 attempt 没有 `admission-gate` job、该 workflow 文件在运行提交处与 main 的 blob 相同、main 的副本里不出现 `admission-gate` 字样、每个 job 都有不超过 30 的字面 `timeout-minutes`。

---

## 9. 对 Decision `f303f861` 第 2、3 项的结论

| 项 | 原决定 | 本文 | 理由 |
| --- | --- | --- | --- |
| 2 每个当前 head 可重跑一次 | 允许一次，重跑重新读准入结果，取代关闭重开 | **确认**，边界见 §8 | 关闭重开的 19 次（Task `ada1334c`）全部可由一次重跑替代；只放「Re-run all jobs」保住 gate 重判 |
| 3 认领与合并位只对受保护 PR 强制 | 其他 PR 认领只提示、`clued-merge-slot` 直接通过 | **修正**：`normal` 下认领对三层都强制、合并位对三层都要求；`efficiency` 下 `code` / `docs` 的认领降为提示、合并位免 | 防撞车与归属是 Owner 要保留的；合并位的痛点由 §7 解决，取消串行化会在 strict 下白跑 CI。`efficiency` 状态保留了原决定的形态，由 Owner 选用 |

---

## 10. 可见性与审计

- **摘要**：`renderSummary` 第一行加 `**Mode:** \`<state>\` · layer \`<layer>\` · source \`<变量名或 default>\``，随后一张「有效规则」小表（§5.1 的六列）。复核的摘要同样打印状态。gate **不自己读策略文件**（它检出的是 PR 的 `base.sha`，那份策略可能落后于 main）：它从本事件准入运行发出的 App check 的 `output.title` 解析 `[<state> · <layer>]` 与 `reruns_per_head`，策略只在默认分支的准入运行里解析一次。
- **每个 PR 可见它被放行时的模式**：App check 的 `output.title` 为 `ADMITTED [normal · code · reruns 1]` 这类形式（gate 从中解析状态、层与 `reruns_per_head`）；`external_id` 不变（`pr:<n>:run:<run id>`）。verify RPC 的 `p_input` 增加 `admission_mode: {state, layer}`（随 §13 第 3 步的迁移写入回执；现行 RPC 对未列出的键静默忽略而不拒绝，所以第 1、2 步可以先送这个键，但只有 App check 标题与摘要能查到），写进 `work_claim_bind_pr` / `admitted_heads` 的回执，Clued 侧可查「这个 head 是在什么模式下放行的」。
- **切换**：Owner 的 Decision（§4.1 第 2 条）；复核在 `reason=state_change` 下对每个打开 PR 发一条新 App check（成功或失败），标题带新状态。
- **度量**：§12 的报告按状态分组统计。

---

## 11. 与现有机制的关系

- WorkClaimAdmission v0.1 §4.6「Owner 复核」：不变，成为受保护层 `owner_grant: required` 的实现；`frozen` 把它扩展到所有层。
- §4.4「合并位」：由 §7 取代（接受并实施后）。合并引用 `merge:<owner>/<name>:<branch>` 作为队列项的键保留，`merge_slot_until` 语义改为「按 §7.3 计算的时效」。
- 合同 `agent-contract.md` §1.7：接受后随实施改写合并位段落（取位 = 入队；不再每 10 分钟重试；不再每 30 分钟为保位续期；拿到队列头后打开 auto-merge；重跑规则），并缩短。合同节奏与 §1.7 压缩属 Task `ada1334c` 的另一项，不在本文。
- 加闸 workflow 的 `admission-gate`：不变，只在 `rerunAttempt()` 按 App check 标题里的 `reruns_per_head` 放行。
- `CONTRIBUTING.md`「Work claims」「Protected paths and Owner grants」：接受后按分层与状态改写；`.github/pull_request_template.md` 只把受保护路径的指引改为 `CORE_PROTECTED_PATHS` 加策略文件（第 2 步）。
- runner 开工前检查（`scripts/runner/`）：同上。
- Dependabot：层按路径（多为受保护层）；Owner 流程不变。

---

## 12. CI 用量：测量与削减

### 12.1 测量（随第一步实施一起上线，托管 runner，每周一次 + `workflow_dispatch`）

`scripts/ci/ci-usage-report.mjs`（受保护路径），只读 GitHub API，输出 JSON artifact 与 step summary。**硬规则**：度量只在 GitHub Actions 内运行。首选一个**度量专用**的只读 GitHub App（与 Decision `d8bc893c` 给 runner 钩子的只读 App 同类、另建一个，只装本仓库）的安装令牌：它有独立的 5,000 次/小时额度，私钥只放进 `clued-admission` environment（限 main，PR 代码拿不到）。度量脚本读的端点比钩子多，这个 App 需要 `actions`、`contents`、`pull_requests`、`issues`、`checks` 五项**只读**（`pulls/{n}`、`pulls/{n}/files`、`pulls/{n}/commits` 要 pull requests 读，`issues/{n}/events` 要 issues 读，读 App check 标题要 checks 读）；不把这五项加到钩子 App 上——钩子 App 的私钥在 PR 代码可读的 runner 上，保持它只有 Actions / Contents 读。用 `GITHUB_TOKEN` 兜底时在 workflow 的 `permissions:` 块声明同一组。`GITHUB_TOKEN` 只作兜底：它的 1,000 次/小时是**每仓库共享池**，gate 轮询（每 10 秒 2 次请求、最多 480 秒、一个 head 最多 10 个 gate）、准入运行与复核都在同一池里，用它度量时预算 ≤200、每批前读 `x-ratelimit-remaining`、低于 600 即停、只在没有 PR 活动的时段 schedule。绝不用 Owner 的个人令牌，也不用机器账号（个人账号下的私有仓库只能给协作者读写权限与 classic 令牌，Decision `d8bc893c`）。按运行 id 落盘缓存只拉增量。来历：2026-10-07 本研究的临时采集脚本用 Owner 个人令牌对 #530–#616 逐运行、逐提交拉取，约 18 分钟发出 4,600 余次请求把 5,000 次/小时的额度用到 0，而自托管 runner 的开工前检查用同一账号的令牌，PR #617 的检查在钩子阶段被 403 拒绝。Owner 随后决定（Decision `d8bc893c`，Task `4e691ab6`，PR #620）：runner 启动钩子改用新建的只读 GitHub App 的安装令牌，走 App 自己的额度；不用机器账号，也不复用 clued-admission App（它的私钥放到 job 可读的 runner 上会被 PR 代码拿去伪造准入检查）。

**实施说明（2026-10-09，Task `f70546e5`，Owner Decision `00b71629`）**：第 1 版（#650）先用 `GITHUB_TOKEN`。首份报告（运行 37894585499，7 天）只拿到 994 个运行中 187 个的 job 明细（停在 200 次上限），一周约 1,000 个运行，缓存追不上，所以按上文首选方案建度量专用只读 App。workflow 进 `clued-admission` environment，只引用 `CLUED_MEASURE_APP_ID` 与 `CLUED_MEASURE_APP_KEY` 两个 secret；脚本用 App 安装令牌（只申请上述五项只读）读取，上限 2,000 次；App 未配置、未安装或认证失败、拒发令牌、密钥无法签名或请求出错时退回 `GITHUB_TOKEN`、上限 200，并在日志与摘要里写明令牌来源和原因（不含密钥内容）；令牌在日志中屏蔽。另加 15 分钟时间预算（job 超时 20 分钟），到点即停并照常保存缓存与报告。低于 600 即停、不重试、按运行 id 缓存不变。

| 指标 | 定义 |
| --- | --- |
| `self_hosted_minutes` | 窗口内自托管 job 的 `completed_at - started_at` 之和，按 workflow、按层、按状态分组 |
| `queue_minutes_p50/p95` | 自托管 job 的 `started_at - created_at` |
| `runs_per_merged_pr`、`heads_per_merged_pr` | 运行数与不同 head 数 |
| `update_main_rounds` | PR 内两个父提交的提交数（并入 main 的次数） |
| `wasted_final_rounds` | head 含当时 tip 的运行，其 PR 后来又并入了 main（最后一轮被插队） |
| `reruns` | `run_attempt > 1` 的运行数 |
| `gate_minutes` | `admission-gate` job 占用自托管的分钟与排队 |
| `time_to_merge_p50` | 按层、按状态 |
| `admission_failures_by_reason` | App check 失败标题归类（授权、未含 tip、合并位、认领） |
| `queue_depth_p95` | 队列项数（Clued 回执） |
| `unclaimed_admitted` | `efficiency` 下缺认领仍被准入的 head 数（§5.3） |
| `api_requests_by_pool` | 每仓库 `GITHUB_TOKEN` 池的请求数，按 gate 轮询、准入、复核、度量自身分组 |

基线取 2026-10-01 至 10-08（研究报告 §4）；目标值由 Owner 在接受时定，建议：每个合并 PR 的自托管分钟中位 ↓30%，自托管排队 p95 < 5 分钟，`wasted_final_rounds` ≈ 0（`normal`）。实施：Task `f70546e5`。

### 12.2 削减项（各一个 PR；2026-10-10 按 §12.1 全量度量重排）

| 顺序 | 编号 | 项 | 7 天度量 | 预期 | Task |
| --- | --- | --- | --- | --- | --- |
| 1 | R7 | 合入 main 后的 push 事件把重测试再跑一遍：合入要求 head 含 main tip，合并提交的树与刚通过的 PR head 相同 | 5 个重测试 workflow 的运行里约 24% 是 push（`information-flow-e2e` 99/424、`public-mcp-behavior` 127/513、`clued-connection-authorization` 114/475、`clued-g4-database` 90/385、`public-mcp-protocol` 127/513），push 运行墙钟约 7,200 分钟 | G4、connection 与 Information Flow 的 main push 仅在同仓库 Owner PR 的最新实际重 job 与步骤成功、实际测试根树及明确的七端口隔离配置证明与合并树适用、平台 artifact 摘要验证并再次核对最新 attempt 后省掉重复；缺证据/错误则实跑。重 job 如实 skipped，不制造 main 精确 SHA 的成功或原生回执；原认领+dispatch 仍提供精确提交资格。public-MCP 两项保留 push，因正式 publication 按精确 SHA/job/check 验真；PR 四绿回执仅消费 PR。R7/R8 节省重叠且均待实测 | `543a79f0` |
| 2 | R8 | 四个重测试各自启动本地栈（npm ci、本地 Supabase 与迁移、Worker） | 自托管 20,012 分钟中 `information-flow-e2e` 4,237、`public-mcp-behavior` 3,395、`clued-connection-authorization` 3,339、`clued-g4-database` 2,150，合计约 66%；PR 运行平均单次约 11–15 分钟墙钟；四者都已有路径过滤与 `cancel-in-progress` | 步骤采样后，G4 两路仅在固定本地 Docker、每 run+attempt 唯一项目无旧容器/volume、未链接远端、源提交/config/迁移字节不变与完整迁移 ledger 逐版本/名字吻合时，用首次 start 的初始化替代紧接的 reset；lint/RLS/事务/pgTAP/lifecycle 全保留。未知或脏栈失败，不复用或删其他项目；cleanup 只在准备成功并重验自身目标后执行。R7 的 G4 隔离报告 profile2 绑定 attempt，IF profile1 保持。其他三路尚保原实现，样本与效果不作全窗口节省 | `ab74187a` |
| 3 | R1 | `admission-gate` job 占用自托管槽位等 App check（最多 480 秒），10 个加闸 workflow 每个触发的运行各一个 | gate 共 2,681 分钟，3,966 个 gate job 中 3,087 个在自托管、879 个在托管，所以自托管份额低于 13%；gate 排队 p50 0.5、p95 14.7 分钟 | 把等待上限按准入运行的实际时长（约 1–2 分钟）下调；或把 gate 改回托管 runner（需 Owner 撤回 Decision `f86179b3`）；或合并为一个 gate workflow 由 `workflow_run` 触发重任务 | `f52ca0dd` |
| 4 | R3 | `gitleaks`、`trivy` 在自托管、25 分钟超时、每个 head 都跑 | `trivy` 663 + `gitleaks` 565 = 1,228 分钟（约 6%） | 评估改回托管 runner 或缓存 trivy 数据库；它们是必需检查，不能加路径过滤 | `c9a8d57b` |
| 5 | R2 | `clued-cloud-quality` 无路径过滤，文档 PR 也跑 `npm ci`+lint+build+test | 1,026 分钟（约 5%）；能省的只是其中仅文档 PR 的部分，按层分组尚未测（R9） | job 内按改动路径判断，无 `apps/clued-cloud/**` 改动时跳过重步骤、仍以同一 check 名成功 | `77e4b00f` |
| 6 | R5 | 同 head 重复运行与被取消的运行 | 自托管按结论：success 15,873、cancelled 2,988（约 15%）、failure 1,151 分钟；上面的重测试都已设 `cancel-in-progress`，被取消的多是新 head 取代旧 head，原因拆分尚未测（R9） | 补齐仍缺 `cancel-in-progress` 的 PR workflow；按 R9 的原因拆分再定其余 | `c2a3853f` |
| 7 | R4 | 最后一轮被插队白跑 | `wasted_final_rounds` 尚未测（R9）；§7 的队列（第 3、4 步）与执行器（第 5 步）已上线 | 用 R9 的数核对队列的效果 | 第 3、4 步（`3576d10d`、`38e0c90d`） |
| 8 | R6 | `npm ci` 8 分钟超时（#578） | 全部失败合计 1,151 分钟（约 6%），其中 `npm ci` 超时的份额未拆 | runner 本机 npm 缓存已在用；度量命中率后决定是否预热 | `513b73ec` |
| 9 | R9 | 周报 v1 未测的指标：`by_layer`、`by_state`、`update_main_rounds`、`wasted_final_rounds`、`queue_depth_p95`、`unclaimed_admitted`、`admission_failures_by_reason`，以及取消与失败的原因 | 报告里均为 `not_measured` | 在 2,000 次请求预算内按合入 PR 读 files / commits、按 head 读 check 标题，Clued 回执另走只读接口；R2、R4、R5、R6 的量级依赖这些数 | `c20f91d3` |

**重排说明（2026-10-10，Task `c98bc357`，Owner Decision `e24c0906`）**：上表按周报运行 38032057300 重排，它覆盖 2026-10-03 至 10-10 的全部 12,583 个已完成运行（`partial=false`）：自托管 20,012 分钟、10,629 个 job，托管 2,495 分钟；窗口内合入 169 个 PR，每个 PR 的运行数中位 17、p95 60，不同 head 数中位 2；合入耗时中位 47 分钟、p95 487 分钟；自托管排队 p50 0.35、p95 13.8 分钟。R7 的 push 占比取自同一窗口（截至报告结束时刻）的运行列表，分钟是运行墙钟，含 gate 等待，不等于自托管 job 分钟；R7 中四个 workflow 的 push 运行也计在 R8 的 13,121 分钟里，两项的节省不能相加。初排时（n=3 样本）的 R1–R6 没有覆盖最大的两项（R7、R8），编号保持不变，顺序列给出新的先后；每项仍各一个 PR，改 workflow 或 `scripts/ci/**` 属受保护路径，需 Owner 单独批准。

---

## 13. 迁移路径（每步一个 PR，每步 Owner 单独批准；步骤之间可按度量调整顺序）

| 步 | 内容 | 行为变化 | 需要 Owner 做的 | Task |
| --- | --- | --- | --- | --- |
| 0 | 本文 Draft → Accepted；ADR 接受；Clued Decision 指向 Drive 报告文件 ID 与仓库 commit | 无 | 接受 | `ada1334c`（已完成：Decision `d130195e`） |
| 1 | `scripts/ci/merge-admission-policy.mjs` + `config/merge-admission-policy.json` + 表驱动测试；`clued-work-admission.mjs` 改为读策略；摘要与 App check 标题打印模式；**默认表先用「兼容表」**：三层 `work_claim: enforce`、`merge_slot: required`、`reruns_per_head: 0`、`auto_merge: allowed`（仓库设置仍关着，所以不生效）；`owner_grant: required` 与 `up_to_date: check_and_strict` 只对受保护层，`code` / `docs` 为 `none` / `strict_only`；今天的其他行为原样保留且不在表里：文件列表截断判 REJECTED（`changed_files_truncated`），服务未报 `merge_slot_until` 时 `clued-merge-slot` 以 `not_reported` 通过，fork PR 的 gate 一律按强制跟随 App check，workflow 守卫（`workflow_gate:*`）在所有状态、所有层无条件生效。行为与今天完全一致 | 无（只多了可见性） | 批准受保护 PR；设 `CLUED_MERGE_ADMISSION_STATE=normal`（或不设） | `2c7c7430` |
| 2 | 默认表换成 §5.2 推荐表；gate 按 App check 标题里的 `reruns_per_head` 放行，runner 开工前检查沿用现有路径（读准入运行的结论与同一 attempt 的 `admission-gate` job），不读 check 标题、不需要 `checks: read`；准入 workflow 的 `pull_request_target` 类型加 `auto_merge_enabled` / `auto_merge_disabled`；合同 §1.7 对应段落改写，并在本步作为 agent-contract v39 发布（Owner 对每周合同节奏的一次性豁免，Decision `77216370`）；`ci-usage-report.mjs` 移出本步，归 Task `f70546e5` | 重跑一次放行；App check 标题带模式；auto-merge 可用（Owner 打开仓库设置后） | 在每台 runner 更新钩子；打开仓库 `Allow auto-merge`；发布 Worker（合同） | `745c288f` |
| 3 | 位时效绑 CI：迁移 `clued_work_merge_slot_touch_v1`（ci-admission Binding）；准入 workflow 加 `workflow_run: completed` 触发的秒级 job 上报 CI 状态；复核 `reason=state_change` 模式。实施时（2026-10-08，Decision `4f576896`、`1fb7f6b3`）上报 job 放在独立 workflow（每小时一次在复核 job 里），加 `clued_work_merge_slot_holders_v1`，§10 的 `admission_mode` 回执随同一迁移，合同发 agent-contract v40，见 §7.3 实施说明 | 持位不再需要续期；CI 失败自动出队 | 迁移、Worker 发布各自授权 | `3576d10d` |
| 4 | 队列：`clued_work_renew` 带合并引用改为入队返回位置；`clued-merge-slot` 只认队列头；resume 返回 `merge_queue` | 等待不再轮询（入队一次即可，位置由检查与 resume 可见） | 迁移、Worker 发布 | `38e0c90d` |
| 5 | 执行器（可选）：clued-admission App 增加 `contents: write`、`pull_requests: write`；默认分支上的执行器 job 为队列头做「并入 main」与打开 auto-merge（已可合并且 CI 全部跑完通过时直接合并，Task `ff476b06`）。用 App 安装令牌而不是 `GITHUB_TOKEN`：GitHub 不为 `GITHUB_TOKEN` 的推送创建新的 workflow 运行，用它并入 main 不会触发 CI | Agent 在入队后无事可做 | 批准 App 权限扩展（扩大了 `clued-admission` environment 里私钥的能力范围） | `91039d74` |
| 6 | 删除 `CLUED_WORK_ADMISSION_ENFORCE` 与 `CLUED_OWNER_REVIEW_ENFORCE` 的读取与 advisory 分支（v0.2） | 不再有「提示模式」；回滚手段改为 `frozen` 与规则集的 Owner 紧急步骤（GitConnectorWriteContract「Emergency or recovery」） | 删除两个变量 | `958f8ed7` |

**实施说明（2026-10-09，第 6 步，Task `958f8ed7`）**：分两个 PR。6a（#665）先在门禁守卫里登记去掉 `CLUED_WORK_ADMISSION_ENFORCE` 一行后的 `admission-gate` 摘要；6b 删除两个变量的全部读取、`NOT_ENFORCED` 结论与 `legacy-advisory` 提示，十个加闸 workflow 与准入、复核、派发、合并位上报、执行器 workflow 都不再传这两个变量。认领、合并位、Owner 授权从此始终强制，只有策略本身写明「提示」的地方（`efficiency` 下的普通层与文档层）仍只提示；回滚手段是 `frozen` 与规则集的 Owner 紧急步骤。合并后 Owner 删除这两个仓库变量。

**两个 ENFORCE 变量在第 1–5 步期间的处理（历史）**：继续读取，各自保留今天的语义（`CLUED_WORK_ADMISSION_ENFORCE` 不为 `true` 时认领与合并位只提示；`CLUED_OWNER_REVIEW_ENFORCE` 不为 `true` 时不调门口、只在摘要提示），脚本打印 `mode: legacy-advisory(<哪个变量>)`。优先级：`frozen` 高于两个 kill switch——状态为 `frozen` 时忽略它们，三层仍按受保护基线判定；它们只在 `normal` / `efficiency` 下生效。它们不是三个状态之一、不受 I1 保护（提示模式本来就放松受保护层），§14 把它们列为 I1 之外的放宽开关，只保留到第 6 步；在此之前不得用它们代替 `frozen`。`CLUED_RELEASE_GRANT_ENFORCE` 不在本文范围。

**回滚**：第 1 步是纯重构，回滚即 revert；第 2 步回滚是把策略文件换回兼容表（一个受保护 PR）或设 `frozen`；第 3–5 步的迁移只增不改，回滚 Worker 即可；执行器 App 权限可随时在 GitHub 收回。

---

## 14. 不保护什么（接受时随本文原样进入任何完成声明）

- WorkClaimAdmission §4.7 的全部条目。
- `frozen` 的「只有 Owner 合并」不可在 GitHub 侧强制（§4.2）。
- 状态变量、策略文件与规则集都在 Owner（也就是 Agent 所用身份）的管理员权限之下；本文的全部 GitHub 侧保证以 Agent 不改它们为前提。
- 队列头出队到下一项开始最后一轮之间，有一个事件传递的延迟（`workflow_run` 触发是秒级，定时兜底是小时级）。
- `efficiency` 下普通层与文档层免合并位：它们的合并会让队列头白跑一次最后一轮；缺认领的 PR 也准入、重任务照跑且不计量（§5.3 接受了这些代价，并要求度量可见）。
- 两个 ENFORCE 变量在第 6 步删除之前是 I1 之外的放宽开关：在 `normal` / `efficiency` 下把它们设为非 `true`，受保护层也会回到提示模式；`frozen` 不受影响（§13）。
- 位时效绑 CI 后，一个已准入的 PR 仍可用加闸 workflow 内的长任务把队列头的位撑到硬上限（默认 120 分钟，§7.3）；PR 自带的 workflow 不计入。
- GitHub REST 额度是共享资源：只要 runner 开工前检查或任何 Agent 本地工具还在用 Owner 个人令牌，一个失控的只读脚本就能让 CI 停摆（2026-10-07 事故，§12.1）；准入与复核 workflow 用的是 `github.token`（每仓库 1,000 次/小时的共享池），受的是 gate 轮询与度量的挤占（§12.1）。本文的度量规则只约束仓库内的脚本，约束不了 Host 本地的工具；钩子换用只读 GitHub App 令牌是 Owner 另行决定的修法（Decision `d8bc893c`）。
- 执行器（第 5 步）之前，并入 main 仍是 Agent 的动作，Agent 不在线时队列头不会前进；兜底时效会把它出队。

---

## 15. 引用

- 现行实现：`scripts/ci/clued-work-admission.mjs`（`PROTECTED_PATHS`、`evaluate`、`ownerReview`、`carriedApprovalSource`、`baseTipCompare`、`mergeSlotState`、`mergeSlotCheck`、`reverify`、`gate`、`rerunAttempt`、`appCheck`）、`.github/workflows/clued-work-admission.yml`、`clued-work-admission-reverify.yml`、迁移 `20261006120000_work_claims_merge_slot.sql`（`20261006180000_work_claims_continuation.sql` 只作认领续接的背景，不在本文范围）。
- 现行合同：[Agent Contract](../../../protocol/agent/agent-contract.md) §1.7（核心）；[Appendix A.5](../../../protocol/agent/agent-contract.md#appendix-a5)（PR 分层与受保护改动）、[A.6](../../../protocol/agent/agent-contract.md#appendix-a6)（合并队列）、[A.7](../../../protocol/agent/agent-contract.md#appendix-a7)（CI 重跑与手动 workflow）；`development/contracts/repository/GitConnectorWriteContract.v0.1.md`；`CONTRIBUTING.md`。
- 历史合同基线：`skills/clued/references/agent-contract.md` §1.7（v38，第 2 步改写为 v39）。
- GitHub 文档：Managing a merge queue（merge group、CI 失败移出、与「Require branches to be up to date」等价）；Automatically merging a pull request（可用范围、自动关闭条件）；Available rules for rulesets（`strict`）；Re-running workflows and jobs（重跑沿用原 `GITHUB_SHA` 与 workflow 文件）；Update a pull request branch（App 需要 head 仓库的 contents 写权限）。
- 他山之石：Mergify（speculative checks / batch、免费至 5 个私有仓库用户、`$21`/seat）、Trunk Merge Queue（impacted targets 并行队列、乐观合并、二分、免费至 5 committers）、Bors-ng（已停止维护，指向 GitHub merge queue）、Zuul（dependent pipeline、推测执行、失败减半窗口）。具体链接在研究报告附录。
