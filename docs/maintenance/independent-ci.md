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
  - 托管 gitleaks 扫描的输入和本地正式角色（`worker/formal-gitleaks-v4/required-history/prepare.mjs`）完全一样：checkout 的是 trusted base；在 `RUNNER_TEMP` 里新建一个没有工作树的 Git 目录，只放远端最新的 heads、tags、分离的当前 head 和钉住的 reviewed commits（只是对象，不建 ref），旁边只有钉住的 `.gitleaks.toml`；reviewed ignore 由 trusted base 上钉住的 `reviewed_gitleaks.py` 生成并核对哈希；容器参数和本地角色相同。PR 的 `.gitattributes`（例如 `*.png binary`）和 `.gitleaksignore` 都影响不到扫描。
  - 托管 trivy 在扫描前拒绝含符号链接、submodule 或其他非普通文件条目的树（同本地 `prepare-workspaces.py` 的 `tree_modes_regular`）。misconfiguration 检查包按本地已安装的那一代的 digest 下载（`trivy-checks@sha256:b0e12d00…`，同 `required-trivy-v3/plans.mjs` 的 `checksPreparationPlan`），核对 metadata 的 Digest 和主版本，不一致就失败；扫描时断网、`--skip-check-update`，只读这份检查包，可变的 `trivy-checks:2` 标签从不下载。本地那一代换了以后，这个 digest 要跟着改。
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

## 灾备：Owner 临时切换规则集

只在 TURING 长时间不可用、同时又有免费分钟时使用。这是只有 Owner 才能决定和操作的应急动作，不是每月的例行操作，默认不用。

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

   每一项都必须钉 integration，绝不能留空成“任意来源”：那样任何工作流都能发一个同名的通过检查，门禁被悄悄关掉。其余规则（strict、空的 bypass 列表）不变。
4. **Owner 重新启用 `clued-work-admission.yml`**。它发布 `kooyumi-work-admission`，以及 App `5164952` 的 `kooyumi-admission-verified` 和 `kooyumi-merge-slot`；TURING 不在线时，三个 `admission-gate` 靠它的 `kooyumi-admission-verified` 放行托管重型 job。
5. 切换的那一刻，在另一个来源下已经变绿的 PR 会失去绿灯，要在新事件上重新出检查（检查挂在 head 上）。规则集回读确认后再继续合并。
6. **恢复**：TURING 恢复后，Owner 把六项改回原来的六个名字并钉回 App `5368905`，再停用 `clued-work-admission.yml`（按 `bc6fdad1`，它的托管 job 名就是 `kooyumi-work-admission`），回读规则集确认。同样，切换前后的绿灯不能互相继承。
