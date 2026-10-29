# 独立 CI

本文记录 `main` 六项必需检查由谁发布、在哪里执行，以及独立 CI（`work/actions-hosted-migration/independent-ci-v1`）的运行约束、归档和灾备。文档不是实时在线状态或操作授权；规则集的实际来源以 GitHub 设置为准。

依据：Owner Decision `325717a6`（这些检查的工作可以用免费 Actions 分钟）、`22b0e0ed`（持久、自动的双执行路径，不每月靠人工，不弱化门禁，不开付费，规则集和账单只由 Owner 改）、`36a3efe9`、`1b5d3687`、`bc6fdad1`（同名检查），以及 `89945332`、`4fedfc84`（六项钉 App `5368905`，只由它签发）。

## 发布者与执行者

- **发布者只有一个。** 规则集 `24182890` 的六项必需检查 `gitleaks`、`trivy`、`kooyumi-work-admission`、`kooyumi-admission-verified`、`kooyumi-merge-slot`、`contract-placement` 都钉在 App `5368905`，始终由 TURING 上的独立 CI 发布。有没有免费分钟都一样：规则集不按月切换，也不为此改代码。
- **托管 job 只是执行者，自己不发布必需检查。**
  - `gitleaks.yml`、`trivy.yml`、`contract-placement.yml` 的 `admission-gate` 和重型 job 跑在 `ubuntu-latest` 上，用免费分钟。Actions 预算是 $0 硬上限，分钟用完时 GitHub 拒绝启动，不计费。
  - 重型 job 名为 `gitleaks-hosted-executor`、`trivy-hosted-executor`、`contract-placement-hosted-executor`；动态名的另一个分支是对应的 `*-hosted-executor-skipped`。按 `bc6fdad1`，GitHub 把任何同名 check run 都算作必需检查，不看 integration，同名的托管 job 一旦失败就会挡住合并。所以托管 job 的名字（包括动态名的每个分支）绝不能是六个必需检查名之一。
  - 每个重型 job 有 job 级 `permissions: {contents: read, id-token: write}`。最后一步 “Emit relay identity” 只在前面所有步骤都成功后执行：用 runner 自带的 curl 和 python3 铸一个 audience 为 `clued-hosted-relay-v1` 的 GitHub OIDC 令牌，写成 check run 注解（`::notice title=clued-hosted-relay-v1::…`）。这个 audience 没有任何依赖方接受，公开它不能换取别的权限。
  - 重型 job 持有 `id-token: write`，所以其中每一次 Python 调用都用隔离模式 `python3 -I -B`（不把脚本目录或当前目录放进 `sys.path`，不读 `PYTHON*` 环境变量），PR 加的同名模块不能顶替标准库。只有 gitleaks 和 trivy 会被转发；contract-placement 的托管运行要执行 PR 代码，永远不转发，`5368905` 只从本地正式角色发布它。
  - 托管 gitleaks 扫描的输入和本地正式角色（`worker/formal-gitleaks-v4/required-history/prepare.mjs`）完全一样：checkout 的是 trusted base；在 `RUNNER_TEMP` 里新建一个没有工作树的 Git 目录，只放远端最新的 heads、tags、分离的当前 head 和钉住的 reviewed commits（只是对象，不建 ref），旁边只有钉住的 `.gitleaks.toml`；扫描的 head 必须是本次运行所属合并提交的第二个父提交；reviewed ignore 由 trusted base 上钉住的 `reviewed_gitleaks.py` 生成并核对哈希；容器参数和本地角色相同。PR 的 `.gitattributes`（例如 `*.png binary`）和 `.gitleaksignore` 都影响不到扫描。
  - 托管 trivy 的三项扫描和本地正式角色（`required-trivy-v3/plans.mjs` 的 `requiredTrivyPlans`，容器参数同 `verify-worker.mjs`）完全一样：
    - 先拒绝本地也拒绝的输入：符号链接、submodule 或其他非普通文件条目（`tree_modes_regular`），含反斜杠、冒号或控制字符的路径，超过 100000 个路径，以及任何 Java 归档（`.jar/.war/.ear/.par`，本地没有准备 Java DB）。
    - 扫描的是去掉 `.git` 的已检出文件副本，只读挂到 `/repo`。
    - 只有准备缓存的容器联网，而且只挂一个新的缓存目录：漏洞库按本地的顺序从同样的两个仓库下载（各两次），必须是当前的（Version 2，NextUpdate 在未来）；misconfiguration 检查包按本地已安装那一代的 digest 下载（`trivy-checks@sha256:b0e12d00…`），核对 Digest、主版本和非自定义构建，不一致就失败。本地那一代换了以后，这个 digest 要跟着改。
    - 三个扫描容器都断网、只读根文件系统、uid 65532、工作目录 `/scratch`、所有挂载只读、`--skip-db-update`/`--skip-check-update`，参数和本地一字不差，每项最多 5 分钟。可变的 `trivy-checks:2` 标签从不下载。
  - `scripts/ci/validate_runner_budget_policy.py` 只按精确字节放行这六个托管 job（`OWNER_DECISION_HOSTED_JOBS`），并拒绝带必需检查名的托管执行者。其他新增托管 job 仍会被拒绝。
  - `kooyumi-work-admission`、`kooyumi-admission-verified`、`kooyumi-merge-slot` 一律在本地执行，几秒钟就能完成，不转发。`clued-work-admission.yml` 保持停用（disabled_manually）：它的托管 job 名就是 `kooyumi-work-admission`。
- **自动选路。** 独立 CI 的转发阶段对每个可转发角色核验托管运行：跑的是登记过的工作流和脚本字节，是这个 PR 的这个 head，在 GitHub 托管机上，结论是 success，OIDC 声明一致。全部成立，才以 `5368905` 发布同名必需检查。任何一项不成立，或者托管 job 被账单拒绝、超时、没成功，或者 PR 改了 CI 文件，就自动在本地执行原有的正式角色，再由 `5368905` 发布。
  - 不按日期判断月初。每个 head 上托管 job 都会照常排队；分钟恢复后，第一个新 head 上的真实托管运行就会被用上；分钟用完时，几秒钟内就会被拒绝，随即回到本地。
  - 托管运行的结论只决定“转发还是本地执行”，不会让检查变弱。
- **合并位。** merge slot 报告器和合并执行器每次都读取规则集实际要求的检查名和 integration 来计数，不写死 `5368905`。托管执行者（App `15368`）的失败不退还合并位；只有规则集来源（今天是 `5368905`）的最终失败才退还。托管运行还在进行时，报告器照样报 running，合并位照常保活。
- **托管 `admission-gate` 认独立 CI 自己的准入。** 三个 gate 跑 trusted base 上的 `clued-work-admission.mjs --mode gate`，带 `CLUED_ADMISSION_GATE_SOURCE: independent-ci-native-work-admission`，只读权限（含 `checks: read`）：
  - 每约 30 秒查一次这个 PR head 上 App `5368905` 的 `kooyumi-work-admission`，最多等 10 分钟（job 上限 15 分钟）。常驻执行器看到触发后先跑第 1 段发布这项检查，再等托管结果。
  - 只认 App `5368905`、`head_sha` 等于 PR head、conclusion success、`external_id` 是独立 CI 的 native-work-admission 格式的那一条（同 App 里 id 最大的一条）；摘要里写的是别的 PR 也不认。其他 App 的同名检查一律不认。认可后照常核对 claim 的执行 epoch。
  - 等不到、被拒或不绑定这个 PR，gate 就不放行，托管重型 job 跳过，检查走本地。重跑（attempt > 1）一律不放行，要推新 commit。
  - 灾备时 TURING 不在线，`5368905` 的准入不会出现；同一个 gate 也认 Owner 重新启用的 `clued-work-admission.yml` 在本事件里发布的 App `5164952` `kooyumi-admission-verified`（原有规则，绑定 PR 和本事件的准入 run）。哪一个先落定就按哪一个判。
- **当前限制。** 转发阶段属于 Source v2（PR-A）。装好并由 Owner 打开之前，六项都由本地正式角色产出。
- **后备的字节绑定。** 独立 CI 的正式角色固定的是已安装副本里的工作流字节（自托管版本：`gitleaks.yml` `168aebaf…`、`trivy.yml` `cea2fd77…`、`contract-placement.yml` `762f1b13…`）。已安装的包继续使用安装时的副本。从包含托管执行者版本的 `main` 重新构建包之前，必须先重新固定这些字节，否则会以 `ORIGINAL_*_WORKFLOW_DRIFT` 拒绝。

## 失败、重试与归档

- 干净的瞬时失败（白名单失败码，两端证明齐全）自动重试一次。第二次仍失败，或者任何未知失败，仍然 HALT，等 Owner 处理。重试同样遵守下面的 2026-10-20 经验，绝不重跑已落定的 job id。
- 归档只改名、不删除，归档目录一律保留。归档总量达到 50 GB 时提醒 Owner，由 Owner 决定是否清理。
- 归档绝不移动 `state\effects` 或 outgoing journal 记录。

## 2026-10-20 独立 CI 运行经验

- 从构建 bundle 到 stage 2 之间，不得 push，也不得 merge。
- 发布已落定的 job id 绝不能重跑，重跑会撤销已发布的绿色检查。需要重跑时，先取得新的 claim，再生成新的 job id。
- merge slot 的有效期为距最后一次续期 45 分钟，stage 8 要求 `merge_slot_until > now`。本地批次可以在 stage 6 期间续期，绝不能在 stage 3、5、7 或 8 期间续期。只做转发的批次中途不续期：开始前离过期不足 20 分钟就推迟开始，由持有方按现有机制续期。
- 归档时绝不移动 `state\effects` 或 outgoing journal 记录。

## 应急与灾备的前置步骤（含合并列车）

依据：额度第二期设计 v0.5 §5.10（资料中心 `10_E_工程与平台/CI基础设施/常驻执行器额度第二期_含合并列车_设计说明_v0.5_20261022.md`，sha256 `bd20941b…6d64cb`）、[MergeAdmission v0.2](../../development/contracts/execution-admission/MergeAdmission.v0.2.md)（候选，未接受）、[GitConnectorWriteContract](../../development/contracts/repository/GitConnectorWriteContract.v0.1.md) 的 “Emergency or recovery”。

**什么时候适用。**

- 下面的“暂停执行器”和“关掉 auto-merge”两步，从 2026-10-28 起每次应急停用规则集、灾备切换都要做，不论列车开没开（GitConnectorWriteContract 同日写明）。
- “第 10 段撤销”和“先把 `strict` 改回 true”两步，只在常驻执行器的列车开着（`train.enabled=on`）时适用。第 5、6 步（列车开着、`strict` 仍开着）时，第 10 段照做，`strict` 本来就开着。
- 现在（2026-10-28）列车还没开：代码做到第 3c-1 步，只有影子模式；`strict` 仍是 true，合并方式仍允许 merge、squash、rebase。

**为什么要先做这些。**

- 规则集停用期间没有任何必需检查，开着 auto-merge 的 PR 会立即合入。切换来源的那一刻，开着 auto-merge、在新来源下恰好全绿的 PR 也会立即合入。
- `strict` 关着时，钉住合并基础靠的是列车的不变量：不在 main 里、又带着 `5368905` 成功 `kooyumi-merge-slot` 的提交至多一个，就是车头。灾备流程重新启用的 `clued-work-admission.yml` 不维持这条不变量：它的 `mergeSlotCheck` 把 head 不含 main 尖端（`not_needed`）、`not_required`、`not_reported` 都判成功。`strict` 关着时照旧切换，任何不含 main 尖端的 PR 都会拿到绿。

**应急停用规则集**（Owner 修 main）：

1. 停用之前：
   - **暂停执行器**：写 PAUSE 请求，也就是往常驻目录的 `requests\` 放一个合同为 `clued.independent-ci.resident-pause/1` 的请求，只有提权的 Owner 能恢复。不能用“暂停接新”（`rearm-tool.mjs request-intake-pause`）代替：它不停正在跑的批次和停在 B 点的批次，它们仍可能在第 8 段发出新绿。执行器不可达时跳过这一步。
     - 怎么写：仓库里还没有写 PAUSE 的命令（第 3c-2 步要给 `rearm-tool.mjs` 加一个，Task `6451a55d`）。在那之前，在 PowerShell 里运行下面这一行（不用提权）。文件名必须是“13 位毫秒时间-12 位十六进制.json”，内容恰好 `contract`、`reason` 两个键，不能带 BOM，否则执行器会默默拒绝；这条命令三样都满足。

       ```powershell
       $n = '{0:D13}-{1}.json' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), (-join (1..12 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })); [IO.File]::WriteAllText((Join-Path 'C:\ProgramData\CluedIndependentCI\resident\requests' $n), '{"contract":"clued.independent-ci.resident-pause/1","reason":"Owner emergency: ruleset change"}', (New-Object Text.UTF8Encoding $false))
       ```

     - 怎么确认：`C:\ProgramData\CluedIndependentCI\resident\state\PAUSED.json` 出现，并且状态显示没有批次在跑（不带 `-Request` 运行已安装的 `windows\rearm-resident.ps1` 也会显示是否已暂停和 `PAUSED.json` 的 sha256）。确认之后再做下一步。
     - 事后恢复：应急结束（列车开着时还要等全量清扫完成）后，提权运行已安装的 `windows\rearm-resident.ps1 -Request Resume -ExpectedPausedSha256 <PAUSED.json 的 sha256>`。不恢复的话，独立 CI 会一直停着；
   - **跑一次第 10 段**，撤销车头的绿（若有）并读回确认。第 3c-2 步必须让只做撤销和清扫的第 10 段在 PAUSE 期间也能运行（设计 §4.3）；第 3c-1 步的 PAUSE 期间第 10 段不跑（`work/independent-ci-resident-v1/DESIGN.md` §22.3）。做不到时，按下面“先把 `strict` 改回 true”那一条处理；
   - 按下面“关掉 auto-merge”关掉所有打开 PR 的 auto-merge，停用前一刻再列一次；
   - 执行器不可达（例如 TURING 不在线），或者车头的绿没能撤销并读回确认时，**Owner 先把 `strict` 改回 true**，规则集重新启用后保持 true，第 3 步的全量清扫完成后才再关。理由：main 向前修时（新尖端含旧尖端），`strict` 开着，没撤掉的旧绿只能合入一个已含新 main 尖端的 head，这个 head 也就含旧尖端，落地的就是它自己测过的树；`strict` 关着时，它可能落在修过的 main 上，而那棵树没测过；
   - 建议停用期间把仓库变量 `CLUED_MERGE_ADMISSION_STATE` 切到 `frozen`（按 MergeAdmission v0.1 §4.1 第 2 条写 Decision）。Agent 按合同在 `frozen` 下不合并、不开 auto-merge；脚本只能在停用前关一次 auto-merge，挡不住之后有人再打开或手动合并。
2. 停用规则集、修 main、重新启用，回读规则集确认。**修 main 只用向前的提交**（例如 revert 提交）；列车开着时，不把 main 强推回旧提交。强推回旧提交之后，以前已合入、带着六项绿的 head 不再在 main 里，从它新开一个 PR 就能在清扫之前合入。万一必须回退：停用之前先把 `strict` 改回 true、状态切到 `frozen`，两样都保持到全量清扫完成。
3. 重新启用之后、恢复列车之前，做一次**全量**清扫（不是增量）。main 已经在列车之外动过，所有旧绿都要撤销（包括停用前来不及撤的），列车从新的 main 尖端重新开始。切过 `frozen` 的，清扫完成后再切回。

**灾备切换必需检查的来源**（下一节）：

1. 切换来源之前：
   - 和上面第 1 步一样：执行器可达时，写 PAUSE 请求并跑一次第 10 段，撤销车头的绿并读回确认；不论可达与否，关掉所有打开 PR 的 auto-merge；
   - 列车开着时，**Owner 先把 `strict` 改回 true**，回读确认后，再按下一节第 3 步改必需检查的来源。灾备时 TURING 往往不在线，车头的绿撤不掉；`strict` 开回之后，它只能合入一个已含 main 尖端的 head，而且来源一改，`5368905` 的检查就不再算数。
2. 恢复时，按这个顺序（取代下一节第 6 步的顺序）：
   - 先停用灾备期间重新启用的 `clued-work-admission.yml`（它的托管 job 名就是 `kooyumi-work-admission`）；
   - 把六项改回原来的名字并钉回 `5368905`，回读规则集确认；
   - 列车开着时，做一次全量清扫。灾备期间 main 动过的话，清扫的例外自然不成立，灾备前车头的绿会被撤销；
   - 最后才关 `strict`，恢复列车。

**第 10 段和全量清扫怎么触发**：第 3c-2 步（开车所需的撤销与清扫，Task `6451a55d`）的 PR 必须把具体命令补进本节，免得应急时 Owner 手里没有命令。第 3c-2 步合入之前列车开不了，这两步也就用不上。

**关掉 auto-merge**（Owner 脚本）。这是 Owner 应急流程的一部分，不是 Agent 的日常动作。Owner 用自己的 GitHub 身份在终端里运行，每条命令一行，PowerShell 和 bash 都能用：

1. 只读：列出所有打开、开着 auto-merge 的 PR（编号、head 前 12 位、标题）。

   ```bash
   gh pr list --repo tdoljyj/cross-memory-system --state open --limit 1000 --json number,headRefOid,title,autoMergeRequest --jq '.[] | select(.autoMergeRequest != null) | [(.number | tostring), .headRefOid[0:12], .title] | @tsv'
   ```

2. Owner 看过清单后，逐个关闭（把 `<PR 编号>` 换成清单里的编号）：

   ```bash
   gh pr merge <PR 编号> --repo tdoljyj/cross-memory-system --disable-auto
   ```

3. 再运行一次第 1 条命令，没有任何输出才算完成。有输出就回到第 2 条。停用规则集或切换来源之前一刻，再运行一次第 1 条命令。

**托管工作流**：`clued-merge-executor.yml`（会把 main 合进车头分支）、`clued-merge-slot-ci.yml`、`clued-work-admission.yml`、`clued-work-admission-reverify.yml` 在列车开着期间保持停用（现在都是 `disabled_manually`），重新启用之前要先改造。灾备时临时重新启用 `clued-work-admission.yml` 是唯一的例外，而且只在 `strict` 已改回 true 之后。

## 灾备：Owner 临时切换规则集

只在 TURING 长时间不可用、同时又有免费分钟时使用。这是只有 Owner 才能决定和操作的应急动作，不是每月的例行操作，默认不用。

每次切换都先做上一节“应急与灾备的前置步骤（含合并列车）”里的“灾备切换”第 1 步（列车开着时包括把 `strict` 改回 true），再从下面第 1 步开始。恢复时按上一节“恢复时”的顺序：先停用 `clued-work-admission.yml`，再钉回 `5368905`；列车开着时还要全量清扫，最后才关 `strict`。它取代下面第 6 步原来的顺序。

1. **前提**：托管执行者版本的三个工作流已合入 `main`；merge slot 报告器和合并执行器按规则集实际来源计数。
2. **快照**：切换前先保存规则集，`gh api repos/tdoljyj/cross-memory-system/rulesets/24182890 > ruleset-before.json`。
3. **Owner 临时改规则集 `24182890` 的必需检查**。托管执行者的检查名不再是 `gitleaks`、`trivy`、`contract-placement`，所以这三项要连名字一起改：

   | 必需检查 | integration |
   | --- | --- |
   | `gitleaks-hosted-executor` | GitHub Actions，App `15368` |
   | `trivy-hosted-executor` | GitHub Actions，App `15368` |
   | `contract-placement-hosted-executor` | GitHub Actions，App `15368` |
   | `kooyumi-work-admission` | GitHub Actions，App `15368` |
   | `kooyumi-admission-verified` | `clued-admission`，App `5164952` |
   | `kooyumi-merge-slot` | `clued-admission`，App `5164952` |

   每一项都必须钉 integration，绝不能留空成“任意来源”：那样任何工作流都能发一个同名的通过检查，门禁被悄悄关掉。其余规则（空的 bypass 列表等）不变；`strict` 在切换期间必须是 true（列车开着时先按上一节改回）。
4. **Owner 重新启用 `clued-work-admission.yml`**。它发布 `kooyumi-work-admission`，以及 App `5164952` 的 `kooyumi-admission-verified` 和 `kooyumi-merge-slot`；TURING 不在线时，三个 `admission-gate` 靠它的 `kooyumi-admission-verified` 放行托管重型 job。
5. 切换的那一刻，在另一个来源下已经变绿的 PR 会失去绿灯，要在新事件上重新出检查（检查挂在 head 上）。规则集回读确认后再继续合并。
   恢复时不要照第 6 步的顺序做，按本节开头和上一节“恢复时”的顺序：先停用工作流、再钉回；列车开着时还要全量清扫，最后才关 `strict`。
6. **恢复**：TURING 恢复后，Owner 把六项改回原来的六个名字并钉回 App `5368905`，再停用 `clued-work-admission.yml`（按 `bc6fdad1`，它的托管 job 名就是 `kooyumi-work-admission`），回读规则集确认。同样，切换前后的绿灯不能互相继承。
