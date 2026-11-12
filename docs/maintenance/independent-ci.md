# 独立 CI

本文记录 `main` 六项必需检查由谁发布、在哪里执行，以及独立 CI（`work/actions-hosted-migration/independent-ci-v1`）的运行约束、归档、灾备、常驻执行器的主备切换和推送前的本地验证。文档不是实时在线状态或操作授权；规则集的实际来源以 GitHub 设置为准。

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

## 推送前的本地验证

推送前用 `--affected` 验证，不要手选 `--suite`（#1015 当时手选漏了 `offline-drill`，在常驻 CI 失败，run 42177591049）：

```bash
node scripts/ci/local-verify.mjs --affected
```

- **选择与 CI 一致。** 它取分支相对 GitHub `main`（先 fetch；也可用 `--base` 指定）的改动路径（含工作区未提交的改动，`--committed` 则不含），用 `main`（或 `--base`）上 `scripts/ci/ci-required-selection.mjs` 的 `selectSuites` 选套件。这和 `clued-required-tests.yml` 里 `ci-suites` 的 “Select suites” 步骤调用的是同一个函数，不另抄一份；区别只是文件清单来自 git（合并基点到分支），不来自 GitHub API。
- **只跑选中的套件，两侧都跑。** 对 `clued-required-tests.yml` 的三项检查 `ci-suites`、`clued-cloud-tests`、`migration-verify` 各选一次。有任何改动文件时都会选中 `clued-cloud`。Windows 和 CluedDev-Linux 两侧同时跑；Linux 一侧需要先用 `setup-clued-dev-linux.ps1` 装好，没装好时摘要里 Linux 一侧显示 `COULD NOT COMPARE`，Windows 一侧照常跑，但只要选中了套件，退出码就是 1；要干净的退出码，用不加 `--affected` 的默认运行（它只跑 Windows 一侧，选择相同）；只跑 Linux 一侧用 `--affected --linux-only`。
- **先说明选了什么、为什么。** 每项检查打印一行，文字同 CI 日志（`ci-suites: selected by changed paths; suites: ...`），每个选中的套件下面列出选中它的改动文件，最多三个（每个顶层目录的第一个优先），其余写 `... (N more)`。不加 `--affected`、也不加 `--suite` 的默认运行打印的选择说明相同。
- **不能手选。** `--suite` 和 `--candidate` 不能与 `--affected` 同用。
- DESK 上常驻执行器正在跑批次时，每个套件开始前先让路、等它跑完；每一侧合计最多等 90 分钟，用完照常继续（`--no-yield` 可跳过）。

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

第17代候选的strict当前front路径见[常驻设计§62](../../work/independent-ci-resident-v1/DESIGN.md#62-第17代候选当前front的strict路径与独立历史清扫)。其轻量就绪不表示历史full已完成；本节的关闭strict、main改写冻结和灾备恢复要求仍须执行。Stage8与companion只控制后续发布或异步停止，不能代替关闭strict前先完成full的操作前提。候选未安装或未取得实际首绿计时前，不报告30分钟验收通过。

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
   - 第 15 代起（`work/independent-ci-resident-v1/DESIGN.md` §60.2）：第 10 段自己能发现 main 被改写，发现后作废开车后的全量清扫，自动开一轮扫全部 PR 和全部提交的清扫，完成之前不发新绿，状态页和 PR 页面会写明原因。但被改写时 strict 若是关的，companion 会立即暂停执行器，而暂停期间这一轮不会进行：先把 strict 开回 true，再恢复执行器，等这一轮完成后才关 strict。
   - `fullAllPending` 挂着 `TRAIN_MAIN_REWRITTEN` 时，不要把常驻执行器回退到第 14 代（见 §60.2）。

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

## 主备与切换

常驻执行器现在有两个节点：公司一台专用机当班，家里的 TURING 待命（Decision `1c5d34fd`）。本节写给 Owner 和以后的 Agent：怎样保证任何时候只有一个节点在发布检查，怎样切换、升级和演练。

- 依据：Owner 接受的《常驻执行器主备部署·设计说明 v0.4》（Decision `bd86149e`），存在资料中心 `10_E_工程与平台/CI基础设施/常驻执行器主备部署_设计说明_v0.4_20261022.md`，sha256 `eeac3429…419a`。下文的 §编号指这份设计。
- 本节是第一版（Task `d70fccc8`）。汇总各实现 PR 的设计修订版另做，做好后本节再对一遍。
- 本节只写做法，不授权任何动作。安装、建停车位、移交角色、新建或轮换连接、生成私钥、授予公司节点正式资格，每一件都要 Owner 另行决定（Decision `bd86149e`）。
- BeamingFace 页面上的操作（`/oauth/connections`、`/bindings`）只有 Owner 本人登录后能做。Agent 只提醒、核对、记 Note，不碰 token 和私钥，也不代点 UAC。

### 现在到哪一步

**2026-10-30 起有两个节点**：TURING 和公司的 DESK-W-591，都装了 Source v2 常驻执行器。下表只写 2026-10-30 实际用过、看到的；没用到的部分仍以各 Task 为准。

| 部分 | 2026-10-30 实测 |
| --- | --- |
| 一键移交、用途、5 分钟后生效（C10） | 生产可用：TURING→DESK 15:26Z（回执 `f85731c5`），DESK→TURING 15:49Z（回执 `488169c7`），都按确认页写的时间生效 |
| 节点档案、每节点安装与校验（C1、C7） | DESK 按自己的档案装好，`verify-resident` 45 项 43 项通过（另两项见下面“已知问题”） |
| 角色探测、当班/待命（C2、C3） | DESK 14:47Z（拿到角色之前）探测到“没有角色”转待命（`ROLE_PROBE_NOT_HELD`）；TURING 交班后仍显示当班，下一次实时准入才会被挡 |
| 停车位 | 还没有。`/bindings` 页顶会提示“还没有停车位”，一键移交不受影响 |
| 其余（C4、C5、C6、C9） | 本次没用到，以各 Task 为准 |

已知问题（2026-10-30）：
- DESK 的 `broker-failure-actions` 显示失败，是旧版 verify 读 `sc qfailure` 的中文输出造成的误报；main 上已改读注册表（`10b89790`），DESK 下次装包后再核。`upgrader-service` 失败是因为升级服务有意停着。
- DESK 拿到角色后公司网络升级断网，还没有在 DESK 当班时跑完一个真实 PR。网络恢复后补做（见“演练”）。

### 几个名词

- **当班节点**：此刻唯一能发布检查的节点。另一个是**待命节点**，不取触发，只探测自己有没有角色。
- **`ci-admission` 角色**：Owner 在 BeamingFace `/bindings` 页面给某个连接打的标记，决定谁当班。标过以后，只有持有它的连接能通过 CI 准入；常驻执行器每段签发、每次第一次发布检查之前都会实时重新准入。所以角色被收走后，旧节点在下一次实时准入时就被挡住。
- **停车位**：一个专门占住这个角色、但永远不放行任何连接的持有者，见下一小节。
- **移交**：把角色从一个节点的连接换到另一个节点的连接。

### 停车位

角色一旦标过，就只认持有者。可如果这个角色一个持有者都没有了，它就回到“从没标过”，对所有连接开放。停车位让角色永远处于“已标过”：即使两个节点都没有角色，也没有任何连接能通过准入。

**C10 已于 2026-10-30 在生产可用（见上表），现在可以建，仍须 Owner 另行决定。** C10 上线前的页面没有“停车位”用途，只能标出一个立即生效的普通持有者，所以当时不建。

**怎么建**（只建一次，由 Owner 做）：

1. 在 `/oauth/connections` 新建一个无头连接，名字例如“ci-admission 停车位”。权限不要用默认的“全部上下文”加“全部操作”：范围选“指定范围”，只勾一项资源（例如“个人资料”），操作权限选“只读”（读取所选内容，对应 `context:read`，标 CI 准入要求有它）；确认视图里的动作应只有“读取”。有效期选最短的一档。token 只显示一次：不复制、不保存，谁也不给。
2. 在 `/bindings` 给它点“设为 CI 准入：停车位”，两步确认。确认视图应写着“永不放行，只占住这个用途”。
3. 回到 `/oauth/connections` 吊销这个连接。吊销后角色标记保留（吊销、过期和清扫都不会结束角色），所以停车位一直有效。
4. 核对：`/bindings` 上这个连接显示“已失效”，专用一栏是停车位、“永不放行”；“CI 准入还没有停车位”的提示不再出现。Agent 记一条 Note。

**规矩**：

- **永远不要结束停车位的角色。** C10 上线后，页面不允许取消唯一的停车位，也不允许从停车位移交。要换停车位，先建一个新的，再取消旧的。
- **误结束了，立即新建一个**（同上 1–3 步）：已吊销的连接不能再标，只能新建。新停车位建好之前，只要这个角色一个持有者都没有（例如切换的中间那几分钟），它就对所有连接开放，所以要马上做。Agent 看到 `/bindings` 上出现“CI 准入还没有停车位”时，立即提醒 Owner。
- **GitHub 环境 `clued-admission` 的连接**（灾备时 `clued-work-admission.yml` 用）如果也持有角色，用途要是“其他”。C10 迁移后，迁移前就有的记录一律是“用途未标明”，按常驻节点算：这样的记录挂在一个有效连接上，会挡住移交和手工标常驻节点（`binding_role_resident_holder_exists`）。页面上不能直接改用途，要先取消它的 CI 准入，再点“设为 CI 准入：其他”，5 分钟后生效；取消时要有别的持有者在（当班节点或停车位），否则这几分钟角色对所有连接开放。它是活的连接，不能代替停车位。按 Task `bb13efb5` 2026-10-22 的核对，生产里只有当班节点那一条记录，所以它当时不持有这个角色。

### 切换顺序

原则只有一条：**先收旧，等至少 5 分钟，再给新**，绝不先给新、再收旧。中间几分钟谁也不当班，PR 只是晚一点开始；顺序做反，两个节点会同时当班。等 5 分钟的原因是：旧节点刚通过的准入还能在约 150 秒内落地一条检查（§5.1）。

**一键移交**（C10，生产可用，2026-10-30 两个方向都实测成功；推荐）：

1. 在 `/bindings` 当班节点的连接旁点“移交 CI 准入…”，选待命节点的连接。
2. 确认视图应写着：从旧连接“确认后立即结束”；新连接“用途为常驻节点，确认 5 分钟后才生效”；“这 5 分钟里两者都不能做 CI 准入”；停车位和其他持有者不变。点确认。
3. 服务端在同一个事务里收旧、给新，5 分钟的等待也由服务端保证。

条件：

- 旧连接必须持有角色、不是停车位（旧连接已失效也能移交）；
- 新连接必须有效、有 `context:read`、还没有 CI 准入；
- 除了这两个连接，不能再有别的有效连接以“常驻节点”或“用途未标明”持有角色，否则被拒（`binding_role_resident_holder_exists`，见上面停车位一节的最后一条）。

**没有一键移交时**，手工三步（前提是已有停车位）。现在两个节点都在，生产也有一键移交；手工三步只在一键移交用不了、并且已有停车位时才用：

1. 在 `/bindings` 取消旧节点连接的 CI 准入。
2. 等至少 5 分钟。能看到的话，顺便看一眼旧节点的 PR 页面状态是不是“已交班”或“停摆”；这只是辅助，安全靠的是服务端角色加这 5 分钟。
3. 给新节点的连接标 CI 准入（C10 上线后选“常驻节点”，确认 5 分钟后生效）。

- 没有停车位时不要做手工三步：第 1 步之后角色会对所有连接开放。
- C10 上线后，已有有效的常驻节点持有者时，再给另一个连接标“常驻节点”会被页面拒绝（`binding_role_resident_holder_exists`），所以手工路径上的“做反”也会被挡住。不要为了绕过它而把常驻节点标成“其他”：用途是 Owner 的声明，服务端不核实。

**接班要多久**（DESK 已实测角色探测；下面的时序数字仍以 C3 `17b703a0`、C5 `ade5df89` 的实现为准）：从新节点的角色生效算起（一键移交是确认后 5 分钟），新节点在下一次角色探测时接班。待命节点每 15 分钟探测一次。

- **旧节点空闲**（没有排队或在跑的提交），或已经停摆：通常 15 分钟内。
- **旧节点还活着、正在跑批**：新节点看到旧节点还在写“当班”，先不接班（会弹“另一节点还在当班”的通知，这时不用操作，见“计划外切换”最后一段）。旧节点要等当前这一段跑完、下一次实时准入被挡，才转待命并写“已交班”，新节点再等下一次探测。上限是“当前段剩余时间 + 15 分钟”。最长的段是第 2 段（gitleaks 执行），预算 45 分钟，超时再加 6 分钟，所以最坏约 66 分钟。第 8 段（控制检查）的预算也是 45 分钟，但额度第二期起按停靠方式跑，每次尝试只查约 90 秒（`work/independent-ci-resident-v1/DESIGN.md` §18.4），两次尝试之间停在停靠点 B，见本列表最后一条。托管转发现在关着；打开后等托管结果的时间怎么算，以 C3 的实现为准。
- **旧节点跑批时整机断电或断网**：它的“当班”状态超过 30 分钟不刷新就不再算数，新节点在那之后的下一次探测接班，也就是最后一次刷新后最长约 45 分钟（刷新间隔按第 4 轮审核 NIT 4 的建议不超过 15 分钟，以 C5 为准）。
- 上面的上限**不含停在停靠点 B 的批次**（额度第二期第 2 步；按 Task `6451a55d`，2026-10-23 起已装在 TURING 上）：这种批次第 3、5、7 段已发布，在等第 8 段，两次尝试之间什么都不跑，最长可停 24 小时。移交后它在下一次尝试时被挡，那个提交要推新提交。它在这期间会不会让旧节点继续写“当班”，以 C3、C5、C9（`c52d56cd`）的实现为准。

计划内切换先暂停接新、等批次跑完再移交，就属于第一种情况。

### 计划内切换（升级、维护、演练、切回）

1. **暂停接新**（C6，待上线）：在当班机器上写一个“暂停接新”请求。它只让执行器不取新触发，不打断在跑或停靠的批次，最长 2 小时自动失效。它不是额度第二期的“排空”（`work/independent-ci-resident-v1/tools/rearm-tool.mjs request-drain`，那是重装前结束停靠批次用的）。
   - C6 上线之前：在 PR 页面或 status.json 上等到当班节点没有在跑的批次，再做下一步。万一这几分钟里开始了新批次，它会在下一次实时准入时被挡，那个提交可能要推新提交。
2. 等在跑的批次跑完。停在停靠点 B 的批次（已发布、在等第 8 段）也算：尽量等它们合入或结束，选一个 B 上没有批次的时候切。等不了的话，移交后它们在下一次尝试时被挡，那几个提交要推新提交（具体怎样结束，以 C3、C9 的实现为准）。
3. 移交：一键移交，或手工三步（见“切换顺序”）。
4. 新节点从角色生效算起，通常 15 分钟内转为当班，开始取触发。旧节点探测到没有角色后转待命，写“已交班”（C2、C3、C5，待上线）。
5. Agent 在 BeamingFace 记一条 Note：谁、何时、从哪个节点到哪个节点、原因，引用两边回执链头的哈希。

### 计划外切换（当班节点停机、断网、WSL 坏）

1. **待命节点提醒 Owner**（C5，待上线）：弹 Windows 通知，并在相关 PR 的当前提交上写 `resident-standby (info only)`：“当班节点 <名字> 已 N 分钟没接手……”。Owner 在手机 GitHub 上也能看到。触发条件是下面任一条：
   - 某个打开的 PR 的当前提交出现 30 分钟后，既没有 App `5368905` 的 `kooyumi-work-admission`，也没有当班节点 30 分钟内写的“当班”状态；
   - 当班节点的状态是“停摆”，已持续 10 分钟。
2. Owner 在 BeamingFace 页面移交（一键移交，或手工三步）。不用到任何一台机器前，手机就能做。
3. 新节点接班，开始处理排队的 PR。旧节点的状态如果是“停摆”，或者超过 30 分钟不刷新，都不会挡住接班。GitHub 回读（C4，待上线）保证新节点不重跑旧节点已经发布过检查的提交（这些提交要推新提交）；旧节点停在第 1、2 段的提交会正常重跑。
4. 旧节点之后的几种情况：
   - 还活着：下一次实时准入被挡，在跑的批次干净结束，随后探测到没有角色，转待命；
   - 已经 HALT：一直显示“停摆”，不挡接班。Owner 方便时在那台机器上复位（一次 UAC）；复位后它先按待命处理，探测确认没有角色就留在待命；
   - 断电后重新上线：中途断掉的批次记为未知并 HALT，同上；断电时它正空闲的话，启动后先按待命处理，不会和新节点同时当班。
5. 怀疑那台机器被动过、要更快更硬地挡住它：移交之后，Owner 再在 BeamingFace 吊销旧节点的连接（它的角色记录已随移交结束，吊销是让 token 作废），并在 GitHub App 设置里删掉那个节点的私钥（已签出的安装令牌最多 1 小时后失效）。以后重新启用要新连接、新私钥，并在那台机器上重装（UAC）。
6. Agent 记 Note，同计划内切换。

**看到“另一节点还在当班”或“双活”通知时**（C5，待上线），先在 `/bindings` 看谁持有角色：

- **只有新节点持有**：这是正常的过渡。旧节点还在跑完当前这一段，新节点看到它的“当班”状态，先不接班。不用操作，等旧节点写“已交班”，最长“当前段剩余时间 + 15 分钟”（见“接班要多久”）。不要去收回新节点的角色。
- **两个节点都持有**（例如有一个被标成了“其他”）：Owner 收回不该当班的那个节点的角色。已经当班的节点看到对方也在当班时会停止取新触发（双活停机）；还没转当班的节点只是继续待命。双活停机怎样解除，按第 4 轮审核 N1 的修正方向（本节点探测到已没有角色、对方写了“已交班”或 Owner 复位才解除），以 C5 的实现为准。

### 切回

- 不自动切回，避免来回抖动。旧当班节点修好、复位、`verify-resident` 通过之后，Owner 选一个空闲时间，按计划内切换切回。
- 也可以不切回：两个节点对等，谁当班都行。方案 A 下建议切回公司，公司硬件更好，TURING 平时空闲更稳。

### 升级顺序（不停 CI）

两个节点跑同一个 Owner 接受的 Source，只有节点档案不同。

1. Owner 接受新 Source：一个 Decision，点名同一个 Source 提交和两个节点各自的包哈希。
2. **先升级待命节点**：UAC + Linux root 步骤；`verify-resident` 只读核对。
3. 计划内切换到它，它用新 Source 当班。
4. **再升级原当班节点**（现在是待命）：UAC + root；核对。它上面如果还有停靠的批次（停靠点 A 或 B），卸载脚本会拒绝，要先由 Owner 本人用已安装副本里的 rearm 工具发排空请求（`request-drain`，经 `windows\rearm-resident.ps1`；命令见 `work/independent-ci-resident-v1/DESIGN.md` §18.6），不要从开发工作区运行。停在 B 的提交排空后要推新提交。
5. 需要时再切回。

- 中间一段时间两个节点的 Source 不同，没关系：只有一个当班。
- 不要两个节点同时升级，也不要在当班节点上原地升级：有备节点时不需要停 CI。两次 UAC 可以错开在不同的日子做。
- DESK 已于 2026-10-30 装好，两个节点都在：升级按上面“先待命节点、后当班节点”的顺序做。只在其中一个节点不可用时，才退回暂停 CI。

### 连接与私钥

每个节点有自己的 BeamingFace 连接（`ci-admission.token`，只在本机 `secrets\` 下，只有 clued-control 能读）和自己的一把 App `5368905` 私钥（Decision `1c5d34fd` 第 4 项）。安装回执和 Note 只记连接 id 和指纹，不记 token 和私钥。

- **连接最长 90 天有效。** 到期后会被清扫吊销，而角色只能标在有效的连接上，所以待命节点的连接一过期就接不了班。
  - 每个节点的连接有效期都选 90 天，到期前 2–3 周续期。
  - 续期换的是新连接（新 id、新 token），安装时钉住了连接 id 和 token 指纹，所以每次续期 Owner 要做三件事：新建连接；接受这个节点的新包（一个 Decision）；在那台机器上点 UAC 重装。需要时更新 `ciPrincipalQualificationRef`。
  - 顺序同升级：先续待命节点，再切换，再续原当班节点。不停 CI。
  - 连接要续期或更换时：先续待命节点的连接，再把角色移交给它，再续原当班节点的连接（新连接要接受新包、UAC 重装）。只在另一个节点不可用时才暂停 CI 来做。没有停车位时，不要先取消旧连接的角色，否则这期间角色对所有连接开放。具体步骤按 Owner 的决定执行。
  - 角色探测遇到“连接已吊销或过期”时会单独弹通知，PR 页面的“停摆”状态带上这个码（C2、C3；吊销、过期这条通知本次没有实测）。
- **不要轮换当班节点的连接。** 轮换会把角色立即搬到新连接上（C10 上线后带着生效时间搬，已生效的在新连接上立即生效），而新 token 还没装到机器上，当班节点会立即无法准入；如果把新 token 装到另一台节点上，旧节点在途的发布又可能和它重叠。要换，先切到另一个节点再处理。给待命节点换连接不影响角色，但同样要重装。
- **App 私钥**：Owner 在 GitHub App 设置页为每个节点生成一把，直接在那台机器上下载，由安装脚本（UAC）放到只有 clued-control 能读的位置，然后彻底删除下载的副本（不要留在回收站）。私钥不在机器之间拷贝，不经过 Agent、聊天、BeamingFace、仓库或网盘。一个节点出事，只删它那把。

### 连接要绑对项目

节点的 CI 连接（无头令牌）必须建在 **clued 项目**（`project:0597aa60-9b98-4da6-a4ab-63d7705b632f`）下面。2026-10-30 DESK 的连接建时选成了 cross-memory-system（`c59e4de8`），角色探测一直报 `ROLE_PROBE_CONNECTION_UNAUTHORIZED`（服务端 401 / `42501`，`authorization_assert_entry_before_sources_v2` 拒绝），排查了一个多小时。

- 症状：探测结果 `uncertain`、码 `ROLE_PROBE_CONNECTION_UNAUTHORIZED`，节点停在 `UNCERTAIN`，没有 HALT。换 token 或标角色都解决不了。
- 建连接时：页面上选项目选 **clued**，不是名字像仓库的 cross-memory-system。
- 装节点之前，Agent 用只读 SQL 核对（不读 token 和 hash 列）：

  ```sql
  select context_keys from public.clued_agent_bindings where id = '<连接 id>';
  select resource_id, actions from clued_private.authorization_entries_v12 where binding_id = '<连接 id>';
  select c.resource_id, c.actions from clued_private.authorization_contributions_v2 c
    join clued_private.authorization_sources_v2 s on s.id = c.source_id where s.binding_id = '<连接 id>';
  ```

  三处都应包含 `project:0597aa60-9b98-4da6-a4ab-63d7705b632f`，并且 actions 为 `{read}`；与 TURING 的连接（`aa4969fb`）形状一致。
- 已经建错时：重建连接会换 token，包里的 `ciTokenPinSha256` 跟着变，要重新打包、重装。2026-10-30 的做法是 Owner 批准后只改这三行：`clued_agent_bindings.context_keys`、`authorization_contributions_v2`（该连接授权来源那一行）和 `authorization_entries_v12` 的 `resource_id`，动作仍只读（Decision `8db7ef5e`、`5cb5c23e`）。只改 `context_keys` 不够，授权条目不跟着变。改库只在 Owner 批准后做，Agent 不自行改。

### 演练

- **每月一次计划内切换**：切到待命节点，至少跑一个真实 PR，再按需切回。这同时证明待命节点能用、交换代理的载体服务还在。演练前后各记一条 Note。频率见下面第三条：主机实测之前要更密。
- 演练时顺便核对两个连接的到期日。演练前可以由 Owner 重启一次 TURING 的 WSL（它有已知的 WSL 退化和内存碎片）。
- **载体 runner 的注册 14 天会被移除。** 交换代理用的载体服务（TURING 上是 `clued-ci-home-win-02`）平时就是停的，而 GitHub 会移除离线超过 14 天的 runner 注册（Decision `0d3ab1a6`）。所以在主机实测（§10 P4）证明注册被移除后交换代理仍然能用之前，演练间隔要短于 14 天；证明之后，再按每月一次。

- **2026-10-30 第一次演练（Z1）**：TURING→DESK 15:26Z 移交；DESK 15:31Z 生效后不久公司网络升级断网，当时没有节点当班；Owner 15:49Z 在 `/bindings` 移交回 TURING（相当于一次计划外切换，不碰任何机器），15:54Z 生效。还差：DESK 当班跑一个真实 PR，以及 DESK 联网后确认它探测到“没有角色”回到待命（Note `e34fb95e`、`e2e56148`）。
- 移交前先看当班节点手上有没有批次（PR 页面 `resident-queue/<节点>`），有就等它合入或结束；PR 的认领要带合并位（`merge:tdoljyj/cross-memory-system:main`），否则批次会一直停在第 8 段前排队。
- **无人登录演练（2026-11-12 起的做法）**：被验证的节点重启时本机会话会断，所以验证用的 PR 先开成**草稿**（常驻跳过草稿，`poller.mjs` 里 `isDraft` 即跳过），重启前不会有批次开跑；节点重启、不登录后，在手机上把 PR 点 Ready for review，看 `resident-queue/<节点>` 是否无人值守跑完八段。2026-11-12 TURING 用 #1074 做过一次：14:06 重启未登录，14:32–14:51 八段跑完并合入。
- **两台 Windows runner 的启动钩子**：2026-11-12 起 DESK、TURING 都是 `work-handover-native-admission-retry-v1`（组件 1.0.2，sha256 `c86615e8…`，Owner Decision `cb682403`）；在此之前 DESK 一直是旧版 `e0cec3d4`，旧准入 workflow 停用后会拒绝改了 workflow 的 PR 的 Windows 任务。改了钩子就两台都装，并在两台的任务启动日志里各确认一次 `[hook …]`。

### 机器设置

两个节点都要做到：

- **关掉自动睡眠**，也不要休眠，虚拟机不要暂停。原因：进程如果在“新鲜度检查”和“发布”之间被挂起，恢复后会晚到发布一条检查（GitHub 不核对角色）；随后它自己的读回又把这条撤成 failure。结果是那个提交变红、要推新提交，也违反了“同一提交上的五项角色与控制检查，跨节点最多首次发布一次”（§2 J2、§6.5）。
- **Windows 更新的自动重启**放在 Owner 能接受的时间。重启后要有人登录 companion 所在的 Windows 账户（锁屏可以）；没登录时这个节点只推迟、不出错，但等于不干活，由另一个节点按“计划外切换”第 1 步发现。
- **账户**：运行常驻执行器的 Windows 账户保持登录，账户里有 Owner 自己的 GitHub 登录（companion 用），Owner 能到场或远程桌面点 UAC。公司账户如果是域账户，要确认能登录 Owner 的 GitHub、不会被定时强制注销。
- **公司主节点用专用机**：运行常驻执行器的 Windows 账户及其 WSL 虚拟机里，不能有任何通用 runner，也不能有能碰 Docker socket 的通用作业（Decision `1c5d34fd` 第 2 项，§1.3）。

**网络与代理**：两个节点都要能出站访问下面这些地址。待命节点也要探测角色、读 PR；它随时可能接班，所以当班节点要用的地址，待命节点也要通。

- `api.github.com`、`github.com`（API、git https 拉 bundle）；
- BeamingFace 后端的 Supabase 项目域名 `ccxsikzwxlolxqlosril.supabase.co`。常驻执行器连的是它，不是 Owner 确认页面所在的域名；
- Docker 镜像源与 trivy 漏洞库下载源（准备 trivy 缓存时）；
- 托管转发打开以后：`token.actions.githubusercontent.com`（OIDC）。

安装前要确认公司网络能否直连这些地址、要不要代理、有没有 TLS 解密。有 TLS 解密时，这些域名必须放行、不解密：钉住的 node 和 git 不认公司的根证书。常驻服务本身仍然封出站，联网的只有 clued-control 和 companion，与 TURING 一样。
