# Merge Admission v0.1：合并到 main 的准入、合并队列与模式切换

状态：**Draft（草案，未被 Owner 接受）。** 本文件不授予任何实施、准入脚本改动、规则集改动、合同版本、生产迁移或 Worker 发布的权限；接受后每一步实施仍由 Owner 单独授权，每步一个 PR。与 [WorkClaimAdmission.v0.1.md](WorkClaimAdmission.v0.1.md)（认领、准入检查、Owner 复核、合并位的现行实现）并列：本文规定「合并到 main 要保证什么」以及如何按路径分层和全局状态执行；v0.1 现行实现中与本文不同的部分，在本文接受并实施后由对应小节取代，接受前以现行实现为准。
日期：2026-10-08
来源：Owner Decision `8e767ed8`（先研究写方案再实施；模式切换形态「路径分级 × 全局状态」）、Decision `f303f861`（P0-1 治理精简四项）、Task `ada1334c`（审计度量与摩擦排序）；研究报告与数据见 Google Drive 资料中心 `10_E_工程与平台/CI基础设施/`（文件 ID 记在 Clued Note 中）；选择理由见 [ADR-EA-001-MergeAdmissionPolicy.md](ADR-EA-001-MergeAdmissionPolicy.md)。
对照基线：main `0b11b095`（2026-10-08），`main write policy (#292)` 规则集 `24182890`（五个必需检查，`strict_required_status_checks_policy=true`，0 审批，bypass 为空），仓库变量 `CLUED_WORK_ADMISSION_ENFORCE=true`、`CLUED_OWNER_REVIEW_ENFORCE=true`，仓库设置 `allow_auto_merge=false`。

---

## 0. 一句话结论

合并到 main 只保证五件事（§2），其中只有两件要求「按最终合并状态测过并由 Owner 看过」，它们只对受保护路径成立；其余路径的保证是「归属可追、不撞车、main 自己的 push CI 会发现问题」。执行方式从「常量 + 分支」改为一张声明式策略表（§5）：三层路径 × 三个全局状态，受保护层是写死在代码里的基线、任何状态都不能放松（§6）。合并的串行化不再靠 Agent 每 10 分钟轮询续期合并位，而是 Clued 侧的 FIFO 合并队列 + GitHub 原生 auto-merge，位的时效绑 CI 运行状态（§7）。GitHub 规则集的 `strict`（必须包含 main 最新提交）保持开启：它是 GitHub 侧唯一能保证「合并结果就是测过、批过的那个 head」的开关，放松它换不来并行合并，只换来受保护层的漏洞（§7.5）。第三方合并队列不采用（ADR）。

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
| G4 共享资源只为被认领的工作花费 | 自托管重任务只跑被认领覆盖、准入通过的 head；每 Task 24 小时 40 个 head | 全部 | `admission-gate` job（读 App check）+ runner 开工前检查 + Clued 计量 | 已有 |
| G5 合并串行化不浪费 CI | strict 开启意味着每次合并都让其他「已跟上 main」的 PR 过期；同一时间只有一个 PR 在做最后一轮（并入 main → CI → 合并） | 受保护层与普通代码层必须；文档层可免 | Clued 合并位 / 合并队列 + `clued-merge-slot` 必需检查 | 已有合并位（Agent 手动取、45 分钟定时器）；本文改为队列（§7） |

**哪些路径要「按最终合并状态测过」**：只有受保护层**必须**（G3 是 G2 的组成部分：Owner 批的是 head，合并进去的必须就是那个 head）。普通代码层与文档层**接受**「合并后由 main 的 push CI 发现」：`clued-cloud-quality` 与各路径过滤的重任务都在 push 到 main 时运行；两个并发 PR 之间的文本冲突已被 G1 排除（活认领的 `write_set` 不相交），剩下的语义冲突由 main 的 push CI 暴露、以修复或回滚处理。但因为 GitHub 的 `strict` 是整个规则集一个开关、不能按路径设置，普通层与文档层在 v0.1 里**事实上也**按最终合并状态测过；本文不把这当作它们的保证，只当作 `strict` 的副作用（§7.5 说明为什么不关 `strict`）。

**不在保证之内**（原样沿用 WorkClaimAdmission §4.7 并补充）：main 上非受保护路径的代码没有人审；Agent 用 Owner 的 GitHub 身份（仓库管理员）能改规则集与变量；PR 正文可写别人的认领；准入读 head 与读文件列表之间的秒级 ABA；Host 本地的开销。

---

## 3. 路径分层

### 3.1 三层

| 层 | `id` | 含义 | 路径（匹配规则见 §3.2） |
| --- | --- | --- | --- |
| 受保护层 | `protected` | 守护生产与准入本身的代码与配置：改动合并后就是之后所有运行的判定代码 | **代码常量** `CORE_PROTECTED_PATHS`（= 现行 `PROTECTED_PATHS`：`.github/**`、`scripts/ci/**`、`scripts/runner/**`、`apps/clued-cloud/scripts/**`、`apps/clued-cloud/package.json`、`apps/clued-cloud/package-lock.json`、`apps/clued-cloud/wrangler*.jsonc`、`apps/clued-cloud/app/supabase-public-config.ts`、`.gitattributes`、`**/.gitattributes`、`.gitmodules`、`.npmrc`、`**/.npmrc`）**加上**策略文件自己 `config/merge-admission-policy.json`，再加上策略文件 `layers.protected.paths` 列出的追加路径。策略文件只能追加，不能移除常量里的任何一项 |
| 普通代码层 | `code` | 其余会被构建、部署或被带凭据的脚本加载的代码：`apps/clued-cloud/**`（除受保护项）、`kernel/**`、`scripts/**`（除 `ci`、`runner`）、`protocol/**`、`skills/**` 的脚本、`tests/**`、迁移 `apps/clued-cloud/supabase/migrations/**` 等 | 策略文件 `layers.code.paths`，默认 `**`（兜底层） |
| 文档 / 合同草案层 | `docs` | 不被任何运行时、测试或 CI 加载的叙述文本：`docs/**`、`development/contracts/**/*.md`、`development/authority-index/**/*.md`、根目录 `*.md`、`skills/**/*.md`（合同 `agent-contract.md` 例外，归 `code`：它随 Worker 下发并被钩子比对版本） | 策略文件 `layers.docs.paths` |

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
  "layers": {
    "protected": { "paths": [] },
    "docs": { "paths": ["docs/**", "development/**/*.md", "*.md", "skills/**/*.md", "!skills/clued/references/agent-contract.md"] },
    "code": { "paths": ["**"] }
  },
  "rules": {
    "normal":     { "protected": "<baseline>", "code": { "work_claim": "enforce", "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "required", "reruns_per_head": 1, "auto_merge": "allowed" },
                                              "docs": { "work_claim": "enforce", "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "advise",   "reruns_per_head": 2, "auto_merge": "allowed" } },
    "efficiency": { "protected": "<baseline>", "code": { "work_claim": "advise",  "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "advise",   "reruns_per_head": 2, "auto_merge": "allowed" },
                                              "docs": { "work_claim": "advise",  "owner_grant": "none", "up_to_date": "strict_only", "merge_slot": "advise",   "reruns_per_head": 2, "auto_merge": "allowed" } },
    "frozen":     { "all_layers_as": "protected", "merge_actor": "owner_only", "auto_merge": "forbidden" }
  }
}
```

- `"<baseline>"` 是字面占位：受保护层的规则**不从文件读**，由代码常量 `PROTECTED_BASELINE` 给出（§6）。文件里写别的值是 schema 错误。
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

1. **只由 Owner 切**，通过仓库变量（与 `CLUED_WORK_ADMISSION_ENFORCE` 同一做法：Settings → Variables）。Agent 不得改这个变量，不得请求 Owner 改它来放过自己的 PR（与 GitConnectorWriteContract「An Agent never disables the ruleset…」同一精神）。Agent 用 Owner 身份能改它，是 WorkClaimAdmission §4.7 已写明的信任前提，本文不改变。
2. **每次切换写一条 Clued Decision**（`user_explicit`）：切到什么、为什么、预计持续多久、切回的条件。切回也写。Decision 由 Owner 口述、任一在场 Agent 记录，或 Owner 自己在 Clued 页面写。
3. **切换后立即重判所有打开的 PR**：Owner（或任一 Agent，不需要认领）在默认分支 `workflow_dispatch` 复核 workflow（`clued-work-admission-reverify.yml`），输入 `reason=state_change`。复核在这个模式下对**每个**打开、非草稿、发往 main 的 PR 重新判定，并在其 head 上发一条新的 App check（成功或失败都发，与现行「只发失败」不同，见 §10）。每小时的定时复核兜底。
4. **GitHub 规则集的必需检查列表不随状态变**：始终是 `gitleaks`、`trivy`、`clued-work-admission`、`clued-admission-verified`、`clued-merge-slot`。状态只改检查内部的判定：例如 `clued-merge-slot` 在不需要合并位的层 / 状态下以 `not_required(<layer>, <state>)` 通过，与现行 `not_needed` 直接通过同一做法；`clued-admission-verified` 在认领为 `advise` 的层下，缺认领时仍成功，摘要写 `claim_advisory_missing`。
5. **切换不改 `strict`**、不改必需检查、不改 environment 与 secret。规则集改动期本身就是 `frozen` 的用途之一。

### 4.2 `frozen` 的两条说明

- 「只有 Owner 合并」在 GitHub 侧**不可强制**：Agent 与 Owner 共用同一 GitHub 身份。可强制的部分是：`auto_merge: forbidden`（准入检查读到 PR 的 `auto_merge` 非空即判 `clued-merge-slot` 失败，并在摘要里要求关闭）、每个 head 都要 Owner 授权（授权本身就是 Owner 看过这个精确提交）。「Agent 不在 frozen 下点合并」是合规规则（合同 §1.7），写进 Decision 与检查摘要。
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
| `docs` | enforce | none | strict_only | advise | 2 | allowed |

理由：

- `code` 层保留 `work_claim: enforce`：`write_set` 防撞车是 Owner 要保留的三件事之一（Decision `8e767ed8`），而撞车正发生在普通代码（2026-10-01 的 #443/#444/#445 是依赖升级，当时还不是受保护路径）。这**修正** Decision `f303f861` 第 3 项「认领只对受保护 PR 强制」（§9）。
- `code` 层保留 `merge_slot: required`：strict 开启时，一个普通代码 PR 的最后一轮是 10–30 分钟自托管 CI（报告 §4 的数据），被别的合并插队就白跑；合并位的痛点是「Agent 轮询 + 45 分钟定时器」，§7 用队列和 CI 绑定时效解决痛点，而不是取消串行化。这也**修正** `f303f861` 第 3 项的合并位部分。
- `docs` 层 `merge_slot: advise`：文档 PR 的最后一轮只有无过滤检查（admission、gitleaks、trivy、`clued-cloud-quality` 的空跑），几分钟；它插队让队列头白跑的代价由 §12 的 R2（quality gate 对非代码改动空转）削减到可忽略。`docs` 层仍 `work_claim: enforce`：认领是一次 MCP 调用，没有出现在摩擦排序里，而归属可追是 Owner 要保留的另一件事。
- `reruns_per_head`：`f303f861` 第 2 项确认为 1（§8、§9）；文档层给 2，因为它的失败几乎都是基础设施原因（runner 排队超时、npm 超时）。
- `auto_merge: allowed` 对受保护层也成立：Owner 授权在前（授权的是精确 head），strict 保证合并结果就是那个 head，auto-merge 只是替 Agent 点那一下。

### 5.3 `efficiency` 与 `frozen` 的有效表

| 状态 | 层 | `work_claim` | `owner_grant` | `up_to_date` | `merge_slot` | `reruns_per_head` | `auto_merge` | `merge_actor` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| efficiency | protected | enforce | required | check_and_strict | required | 1 | allowed | any |
| efficiency | code | advise | none | strict_only | advise | 2 | allowed | any |
| efficiency | docs | advise | none | strict_only | advise | 2 | allowed | any |
| frozen | protected / code / docs | enforce | required | check_and_strict | required | 1 | **forbidden** | **owner_only** |

`efficiency` 下 `code` 的 `merge_slot: advise` 意味着接受白跑 CI 换吞吐；它的代价在 §12 的度量里能看到（`wasted_final_rounds`），Owner 据此决定在这个状态停留多久。

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

- **入队**：Agent 在 PR 准入通过、当前 head 的 CI 绿、合并已获所需批准（受保护层即 Owner 授权已放行）后调用入队。v0.1 为了不加新工具，入队仍是 `clued_work_renew` 带合并引用；服务端不再返回 `work_claim_conflict`，而是返回 `merge_queue: {position, ahead: [...]}`。位置 1 即「持有合并位」，与今天同义。
- **队列头的工作**：并入 main（如果 head 还不含 tip）→ CI → 合并。第一步实施里仍由 Agent 做并入与推送；第二步由执行器做（§7.3）。合并由 GitHub auto-merge 做（§7.4）。
- **出队**：PR 合并（现有 `clued_work_claim_adopt_v1`）、关闭（现有 `clued_work_merge_slot_return_v1`）、队列头的 head 上任一必需检查**最终失败**（§7.3 的执行器上报 `ci_failed`，与 GitHub merge queue「CI 失败即移出」相同）、持有者主动退出（续期去掉引用 / 释放认领）、兜底时效（§7.3）。出队后下一项成为队列头；它的 PR 如果已含 tip 就可直接进 CI，否则并入 main。
- **插队**：没有。Owner 需要紧急合并时用 `frozen`（队列照常，只是人人要授权）或自己手动合并（它移动 main，队列头的最后一轮白跑一次，这是 Owner 的选择）。
- `clued-merge-slot` 检查：head 含 tip 且该层 / 状态要求合并位时，只有队列头通过；否则按 §4.1 第 4 条通过。

### 7.3 位的时效：绑 CI 运行状态，定时器只做兜底

**结论**：绑 CI 状态，保留一个兜底定时器。

- 队列头的位在以下事件间保持：head 上任一适用 workflow 运行处于 `queued` / `in_progress`；全部完成且成功、head 含 tip、等待 auto-merge（给 30 分钟）；执行器正在并入 main。
- **出队条件**：任一必需检查最终失败；或自上次 CI 活动起 45 分钟无任何运行（兜底，沿用现值）；或自取位起 3 小时（硬上限，略大于「排队 + 最长 workflow 超时 35 分钟 + 一次重跑」）。
- **谁上报 CI 状态**：不是 Agent，是运行默认分支代码、持 ci-admission Binding 的 GitHub Actions job（`clued-admission` environment）。触发：`workflow_run: completed`（任一 PR workflow 结束时，秒级托管 job）、`push` 到 main、每小时定时、`workflow_dispatch`。它调用新 RPC `clued_work_merge_slot_touch_v1(pr_ref, head_sha, ci_state)`（仅 ci-admission Binding）：`ci_state ∈ {running, green, failed}`；`running` / `green` 刷新位的时钟，`failed` 出队并留 `WORK_CLAIM_MERGE_SLOT_RETURNED(why=ci_failed)` 回执。这样 Agent 不再为了保位而续期；认领的续期回到它本来的用途（进展）。
- 复核（`reverify`）对队列头以外、却仍绿着 `clued-merge-slot` 的 head 补发失败检查（现行）。

### 7.4 用 GitHub 原生 auto-merge 替代 Agent 守 CI

**结论：可以，且推荐；前提是 Owner 在仓库设置里打开 `Allow auto-merge`（现为关闭）。** GitHub 文档：auto-merge 在公开仓库对 Free 可用，对私有仓库在 GitHub Pro、Team、Enterprise 可用。本仓库是个人账号私有仓库，账号计划从 Agent 侧 API 读不到（令牌无 `user` scope）；它已对私有仓库启用了规则集与分支保护，通常意味着 Pro 及以上，Owner 打开设置时 GitHub 界面会直接显示该选项是否可用，以此为准。

- **顺序**：Owner 合并批准（受保护层的 `repo.protected_change` 授权）在前 → PR 准入通过 → 入队 → 队列头 → Agent（或执行器）打开 auto-merge → GitHub 在全部必需检查通过且 head 含 tip 时合并。auto-merge 不绕过任何必需检查：`clued-merge-slot` 变红它就不合并，这正是把位绑到必需检查上的意义。
- **谁打开**：第一步实施里由 Agent 用 `gh pr merge --auto --merge` 打开（它用 Owner 身份，权限足够）；第二步由执行器打开（需要 App 的 `pull_requests: write` + `contents: write`）。
- **策略列** `auto_merge: forbidden`（仅 `frozen`）：检查读到 `pr.auto_merge` 非空即判 `clued-merge-slot` 失败，摘要要求 `gh pr merge --disable-auto`。
- **已知边界**：auto-merge 在「没有写权限的人推了新提交」或改了 base 分支时被 GitHub 自动关闭；Agent 有写权限，所以并入 main 的推送不会关掉它。auto-merge 不会替 PR 并入 main（`allow_update_branch=false`，且 strict 下 GitHub 不自动更新分支），所以「并入 main」仍是队列头的工作（§7.2）。

### 7.5 能否按 `write_set` 影响范围并行，取代受保护 / 非受保护二分

**结论：在合并这一步不能，只要 `strict` 开着；而 `strict` 必须开着。** 分层（§3）取代了二分，但它分的是「要什么保证」，不是「能否并行合并」。

- `strict` 是规则集的一个开关，整个 main 一个值。开着时，任何一次合并都让其他「已含 tip」的 PR 立刻不满足条件，合并天然串行；这与 PR 之间是否相交无关。
- 关掉 `strict` 换并行合并，受保护层就失去 G3：Owner 批的是 head，合并结果是 GitHub 对新 main 的三方合并；main 在授权后动过受保护文件时，合入的受保护文件内容既不是 Owner 批的也不是 CI 测的。复审 9、10、11 讨论过「检查时判定 + 几分钟后复核」关不掉这个窗口，结论就是开 `strict`。靠队列独占来替代（队列头期间不许别人合并）在 GitHub 侧同样不可强制：别的 PR 的 `clued-merge-slot` 检查是判定时的结论，不是合并时的。
- 所以 `write_set` 不相交带来的并行性用在三处：（a）最后一轮之前的 CI 全部并行（现状）；（b）文档层免合并位（§5.2）；（c）v0.2 的批量测试候选：队列里相邻、`write_set` 不相交、都不含受保护路径的项可以合成一组测一次（Bors / GitHub merge queue 的做法），失败时二分（§7.6）。GitHub merge queue、Bors、Zuul 在 strict 语义下的并行也全是靠「推测合并后测试」，没有别的办法。
- Trunk 的「impacted targets 并行队列」在本仓库的对应物就是认领的 `write_set`：两个活认领不相交已由 Clued 保证，所以队列里不需要再算影响范围；它的价值在（c）而不是在合并顺序。

### 7.6 v0.2 评估项：批量与二分

不在 v0.1 做（Decision `8e767ed8`：批量测试与失败二分放后期评估）。进入评估的条件（§12 的度量给出）：队列深度 p95 ≥ 3，或最后一轮 CI 时长中位 ≥ 20 分钟。做法候选：执行器把队列头后面 k 个不含受保护路径、`write_set` 两两不相交的项并成一个临时分支 `merge-group/<id>`（像 GitHub 的 `gh-readonly-queue/*`）跑一次 CI，通过则按序合并全部，失败则对半分。前提是执行器已有 App 写权限（§13 第 5 步）。

---

## 8. 重跑：每个当前 head 一次

确认 Decision `f303f861` 第 2 项，并加三条边界：

1. 允许的是 **「Re-run all jobs」**，对 `pull_request` / `pull_request_target` 运行，且该运行的 `head_sha` 等于 PR **当前** head，`run_attempt == 2`（`reruns_per_head: 1`）或 ≤ `1 + reruns_per_head`。gate（`rerunAttempt()`）与 runner 开工前检查据此放行；gate 在重跑里重新读 App check，所以 Owner 授权后的重跑能让此前被跳过的加闸任务运行——这取代「授权后关闭再重开 PR」。
2. **「Re-run failed jobs」仍拒绝**：它沿用 gate 上一次的输出，不重新判定（复审 3 N-R3、复审 5 n2）。
3. 旧 head（不是 PR 当前 head）的重跑仍拒绝；第 `2 + reruns_per_head` 次起拒绝。runner 开工前检查需要 Owner 在每台 runner 上更新钩子脚本（Decision `f303f861`）。
4. 准入运行（`pull_request_target`，默认分支代码）的重跑不受次数限制：它每次都重新读 PR 与 main 当前代码，没有「沿用旧输出」的问题。

---

## 9. 对 Decision `f303f861` 第 2、3 项的结论

| 项 | 原决定 | 本文 | 理由 |
| --- | --- | --- | --- |
| 2 每个当前 head 可重跑一次 | 允许一次，重跑重新读准入结果，取代关闭重开 | **确认**，边界见 §8 | 关闭重开的 19 次（Task `ada1334c`）全部可由一次重跑替代；只放「Re-run all jobs」保住 gate 重判 |
| 3 认领与合并位只对受保护 PR 强制 | 其他 PR 认领只提示、`clued-merge-slot` 直接通过 | **修正**：认领对 `protected` 与 `code` 强制、对 `docs` 也强制（`efficiency` 下 `code` / `docs` 降为提示）；合并位对 `protected` 与 `code` 要求、`docs` 提示 | 防撞车与归属是 Owner 要保留的；合并位的痛点由 §7 解决，取消串行化会在 strict 下白跑 CI。`efficiency` 状态保留了原决定的形态，由 Owner 选用 |

---

## 10. 可见性与审计

- **摘要**：`renderSummary` 第一行加 `**Mode:** \`<state>\` · layer \`<layer>\` · source \`<变量名或 default>\``，随后一张「有效规则」小表（§5.1 的六列）。gate 与复核的摘要同样打印状态。
- **每个 PR 可见它被放行时的模式**：App check 的 `output.title` 为 `ADMITTED [normal · code]` 这类形式；`external_id` 不变（`pr:<n>:run:<run id>`）。verify RPC 的 `p_input` 增加 `admission_mode: {state, layer}`，写进 `work_claim_bind_pr` / `admitted_heads` 的回执，Clued 侧可查「这个 head 是在什么模式下放行的」。
- **切换**：Owner 的 Decision（§4.1 第 2 条）；复核在 `reason=state_change` 下对每个打开 PR 发一条新 App check（成功或失败），标题带新状态。
- **度量**：§12 的报告按状态分组统计。

---

## 11. 与现有机制的关系

- WorkClaimAdmission v0.1 §4.6「Owner 复核」：不变，成为受保护层 `owner_grant: required` 的实现；`frozen` 把它扩展到所有层。
- §4.4「合并位」：由 §7 取代（接受并实施后）。合并引用 `merge:<owner>/<name>:<branch>` 作为队列项的键保留，`merge_slot_until` 语义改为「按 §7.3 计算的时效」。
- 合同 `agent-contract.md` §1.7：接受后随实施改写合并位段落（取位 = 入队；不再每 10 分钟重试；不再每 30 分钟为保位续期；拿到队列头后打开 auto-merge；重跑规则），并缩短。合同节奏与 §1.7 压缩属 Task `ada1334c` 的另一项，不在本文。
- 加闸 workflow 的 `admission-gate`：不变，只在 `rerunAttempt()` 读 `reruns_per_head`。
- runner 开工前检查（`scripts/runner/`）：同上。
- Dependabot：层按路径（多为受保护层）；Owner 流程不变。

---

## 12. CI 用量：测量与削减

### 12.1 测量（随第一步实施一起上线，托管 runner，每周一次 + `workflow_dispatch`）

`scripts/ci/ci-usage-report.mjs`（受保护路径），只读 GitHub API，输出 JSON artifact 与 step summary：

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

基线取 2026-10-01 至 10-08（研究报告 §4）；目标值由 Owner 在接受时定，建议：每个合并 PR 的自托管分钟中位 ↓30%，自托管排队 p95 < 5 分钟，`wasted_final_rounds` ≈ 0（`normal`）。

### 12.2 削减项（各一个 PR，按度量排序）

| 编号 | 项 | 依据 | 预期 |
| --- | --- | --- | --- |
| R1 | `admission-gate` job 占用自托管槽位等 App check（最多 480 秒），9 个加闸 workflow 每个 head 各一个 | gate 分钟与排队数据 | 把等待上限按准入运行的实际时长（约 1–2 分钟）下调；或把 gate 改回托管 runner（需 Owner 撤回 Decision `f86179b3`）；或合并为一个 gate workflow 由 `workflow_run` 触发重任务 |
| R2 | `clued-cloud-quality` 无路径过滤，文档 PR 也跑 `npm ci`+lint+build+test | 按层分组的自托管分钟 | job 内按改动路径判断，无 `apps/clued-cloud/**` 改动时跳过重步骤、仍以同一 check 名成功 |
| R3 | `gitleaks`、`trivy` 在自托管、25 分钟超时、每个 head 都跑 | 两者的分钟与排队 | 评估改回托管 runner 或缓存 trivy 数据库；它们是必需检查，不能加路径过滤 |
| R4 | 最后一轮被插队白跑 | `wasted_final_rounds` | §7 的队列 |
| R5 | 同 head 重复运行 | `cancel-in-progress` 覆盖情况 | 已覆盖多数 PR workflow；补齐缺的 |
| R6 | `npm ci` 8 分钟超时（#578） | 失败原因 | runner 本机 npm 缓存已在用；度量命中率后决定是否预热 |

---

## 13. 迁移路径（每步一个 PR，每步 Owner 单独批准；步骤之间可按度量调整顺序）

| 步 | 内容 | 行为变化 | 需要 Owner 做的 |
| --- | --- | --- | --- |
| 0 | 本文 Draft → Accepted；ADR 接受；Clued Decision 指向 Drive 报告文件 ID 与仓库 commit | 无 | 接受 |
| 1 | `scripts/ci/merge-admission-policy.mjs` + `config/merge-admission-policy.json` + 表驱动测试；`clued-work-admission.mjs` 改为读策略；摘要与 App check 标题打印模式；**默认表先用「兼容表」**（三层都 enforce / required、`reruns_per_head: 0`、`auto_merge: allowed` 但不启用），行为与今天完全一致 | 无（只多了可见性） | 批准受保护 PR；设 `CLUED_MERGE_ADMISSION_STATE=normal`（或不设） |
| 2 | 默认表换成 §5.2 推荐表；gate 与 runner 检查读 `reruns_per_head`；合同 §1.7 对应段落改写；`ci-usage-report.mjs` | 重跑一次放行；文档层免合并位 | 在每台 runner 更新钩子；打开仓库 `Allow auto-merge`；发布 Worker（合同） |
| 3 | 位时效绑 CI：迁移 `clued_work_merge_slot_touch_v1`（ci-admission Binding）；准入 workflow 加 `workflow_run: completed` 触发的秒级 job 上报 CI 状态；复核 `reason=state_change` 模式 | 持位不再需要续期；CI 失败自动出队 | 迁移、Worker 发布各自授权 |
| 4 | 队列：`clued_work_renew` 带合并引用改为入队返回位置；`clued-merge-slot` 只认队列头；resume 返回 `merge_queue` | 等待不再轮询（入队一次即可，位置由检查与 resume 可见） | 迁移、Worker 发布 |
| 5 | 执行器（可选）：clued-admission App 增加 `contents: write`、`pull_requests: write`；默认分支上的执行器 job 为队列头做「并入 main」与打开 auto-merge。用 App 安装令牌而不是 `GITHUB_TOKEN`：GitHub 不为 `GITHUB_TOKEN` 的推送创建新的 workflow 运行，用它并入 main 不会触发 CI | Agent 在入队后无事可做 | 批准 App 权限扩展（扩大了 `clued-admission` environment 里私钥的能力范围） |
| 6 | 删除 `CLUED_WORK_ADMISSION_ENFORCE` 与 `CLUED_OWNER_REVIEW_ENFORCE` 的读取与 advisory 分支（v0.2） | 不再有「提示模式」；回滚手段改为 `frozen` 与规则集的 Owner 紧急步骤（GitConnectorWriteContract「Emergency or recovery」） | 删除两个变量 |

**两个 ENFORCE 变量在第 1–5 步期间的处理**：继续读取，作为 kill switch：任一不为 `true` 时，脚本打印 `mode: legacy-advisory`，行为与今天的提示模式相同。它们不是三个状态之一，不受 I1 保护（提示模式本来就放松受保护层），所以只保留到第 6 步；在此之前不得用它们代替 `frozen`。`CLUED_RELEASE_GRANT_ENFORCE` 不在本文范围。

**回滚**：第 1 步是纯重构，回滚即 revert；第 2 步回滚是把策略文件换回兼容表（一个受保护 PR）或设 `frozen`；第 3–5 步的迁移只增不改，回滚 Worker 即可；执行器 App 权限可随时在 GitHub 收回。

---

## 14. 不保护什么（接受时随本文原样进入任何完成声明）

- WorkClaimAdmission §4.7 的全部条目。
- `frozen` 的「只有 Owner 合并」不可在 GitHub 侧强制（§4.2）。
- 状态变量、策略文件与规则集都在 Owner（也就是 Agent 所用身份）的管理员权限之下；本文的全部 GitHub 侧保证以 Agent 不改它们为前提。
- 队列头出队到下一项开始最后一轮之间，有一个事件传递的延迟（`workflow_run` 触发是秒级，定时兜底是小时级）。
- 文档层免合并位：文档 PR 的合并会让队列头白跑一次最后一轮（§5.2 接受了这个代价）。
- 执行器（第 5 步）之前，并入 main 仍是 Agent 的动作，Agent 不在线时队列头不会前进；兜底时效会把它出队。

---

## 15. 引用

- 现行实现：`scripts/ci/clued-work-admission.mjs`（`PROTECTED_PATHS`、`evaluate`、`ownerReview`、`carriedApprovalSource`、`baseTipCompare`、`mergeSlotState`、`mergeSlotCheck`、`reverify`、`gate`、`rerunAttempt`、`appCheck`）、`.github/workflows/clued-work-admission.yml`、`clued-work-admission-reverify.yml`、迁移 `20261006120000_work_claims_merge_slot.sql`、`20261006180000_work_claims_continuation.sql`。
- 合同：`skills/clued/references/agent-contract.md` v38 §1.7；`development/contracts/repository/GitConnectorWriteContract.v0.1.md`；`CONTRIBUTING.md`。
- GitHub 文档：Managing a merge queue（merge group、CI 失败移出、与「Require branches to be up to date」等价）；Automatically merging a pull request（可用范围、自动关闭条件）；Available rules for rulesets（`strict`）；Re-running workflows and jobs（重跑沿用原 `GITHUB_SHA` 与 workflow 文件）；Update a pull request branch（App 需要 head 仓库的 contents 写权限）。
- 他山之石：Mergify（speculative checks / batch、免费至 5 个私有仓库用户、`$21`/seat）、Trunk Merge Queue（impacted targets 并行队列、乐观合并、二分、免费至 5 committers）、Bors-ng（已停止维护，指向 GitHub merge queue）、Zuul（dependent pipeline、推测执行、失败减半窗口）。具体链接在研究报告附录。
