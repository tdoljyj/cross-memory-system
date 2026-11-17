# ADR 0018：bors 式落地——列车自己把测过的提交快进推上 main

- 状态：实现已合入；Owner 于 2026-11-17 13:55 决定按预授权 `9e2511fe` 第 6 项准备启用。仓库侧补齐 §8 的工作流、runner 钩子、守队程序与合同前提，不代表生产已启用；`FLEET_TRAIN` 仍为 `github-merge`、批大小 1。App 权限与规则集就绪后，另行 PR 修改船队统一策略并发通用包；节点安装状态须独立核实。
- 日期：2026-11-07（设计与实现）；2026-11-08 合入第 28 代
- Owner Decision：`9e2511fe` 第 6 项；预授权 Task `7d86cf41`（ADR 0010）
- 来源：分支 `claude/train-bors-chain` 提交 `d1c5174a6`。该分支把本文写成常驻 DESIGN 的 §66，与 main 上冻结档案的 §66（状态里的分段耗时）撞号，而 DESIGN 已在 §70 冻结，所以合入时改为本 ADR。代码注释里的 “ADR 0018 §n” 指本文第 n 节；正文里的 §41、§62、§65 等仍指冻结的 DESIGN。
- 后续一步：[ADR 0019](0019-train-batch-member-chain.md)（批量真正上生产）。

## 摘要

- **背景**：strict 永久开以后（ADR 0007），落地要靠第三方在 PR 页面点合并，H 落后 main 时还要先 update-branch 再整批重跑，而且一次只能合一个 PR。
- **决定**：新增策略开关 `train.landing: 'github-merge' | 'push'`。`push` 下，第 8 段在原有的全部实时准入通过之后，用 `PATCH refs/heads/main {sha: S, force: false}` 把测过的 S 快进推上 main，不再写 `kooyumi-merge-slot`。第 10 段负责组批、累积合并、二分，并 adopt 每个已落地的成员。
- **理由**：main 只会前进到测过的提交上（L1，本文第 2 节）；推之前逐项实时准入（L2）；任何读不到或对不上的情况都失败关闭。
- **后果**：上线要先满足第 8 节列出的 App 权限、规则集和工作流前提（由 Owner/DESK 执行，代码不做）；残余见第 11 节。

## 详细设计（原 DESIGN 草稿 §66，节号改为本文节号）

**一句话。** 新策略开关 `train.landing: 'github-merge' | 'push'`。`push` 下第 8 段不再写 `kooyumi-merge-slot` 等别人去点合并，而是在原有的全部实时准入都通过之后，用 `PATCH /git/refs/heads/main {sha: S, force: false}` 把它测过的提交 S 直接快进推上 main。GitHub 发现 PR 的 head 已经能从 main 到达，就把 PR 标成已合并；第 10 段核实后照旧 adopt、释放认领。main 只会前进到测过的那个提交上（bors 的 Not Rocket Science Rule）。默认仍是 `github-merge`，即 §65 的 strict 永久开模式，一字不变；回退通过修改 `FLEET_TRAIN` 并发布新的通用包完成。

### 1. 现状与为什么要改

- §65：strict 永久开、只留 merge。第 8 段在车头 H 上写 `kooyumi-merge-slot` 绿，之后要有人（Agent 的 auto-merge、守队程序或 Owner）在 PR 页面合并；第 10 段再核对落地的合并提交是 [T, H] 且树等于 S 的树，不等就 `TRAIN_LANDED_TREE_MISMATCH` 停车。正确性靠 strict 在结构上保证（§65.1），但有三处不足：
  1. 落地要靠第三方点合并（§41.10 第 8 条至今未定），中间可能空等，车头位子按 running 时钟白占；
  2. H 落后于 main（`BEHIND`）时 strict 不让合，要有人先 update-branch（§65.6 仍是待决方案），之后整批重跑；
  3. 一次只能合一个 PR，吞吐上限约 4 个/小时（《CI 对比报告》）。
- bors 的做法：测“main + 要合的改动”的那个提交，测过了就把 main 原子地移到它上面；Mergify/bors 再加上批量（一次测 N 个的累积合并）和失败二分。

### 2. 不变量与安全论证

**落地不变量 L1（测什么落什么）。** `push` 下 main 只会被列车移到某个 S 上，而 S 正是本批第 2–7 段扫过、第 8 段实时复核过的那个提交（按 SHA，提交不可变）。理由：
- 写 main 只有一处：第 8 段的落地，请求是 `PATCH refs/heads/main {sha: S, force: false}`。GitHub 对 `force: false` 只做快进：main 当前尖端必须是 S 的祖先，否则 422，main 不动。成功后 main == S，树就是测过的树，没有“GitHub 另生成一个合并提交”这一步。
- 推之后读回 main，必须等于 S；读不到或不等时按本文第 5 节的歧义处理，绝不再推别的提交。
- 落地端口只认两类 ref：`refs/heads/main`（只能 `force:false`）和列车自己的暂存 ref `refs/heads/clued-train/staging`、`refs/heads/clued-train/staging.tmp`（可以强制移动，只用于触发 CI 和生成累积合并）。别的 ref、删除、合并 PR 的 API，端口一律拒绝（`LANDING_REF_REFUSED`），它的令牌也只有 `contents: write`（本文第 4 节）。

**准入不变量 L2（推之前实时准入）。** 推 main 之前，同一次第 8 段运行里、在写 journal 意图之后、PATCH 之前，重新确认（任一条不满足：不推，零副作用）：
1. §62/§65 已有的全部实时检查原样保留：Native 完整准入（claim 代次、`frozen` 显式拒绝、受保护层的 Owner Grant 绑精确 head、ticket/current/settlement）、strict 实时为真、六项钉在 App 5368905、holder 只有一个且绑这个 PR、Source 一致、strict-front 证明（`strictFrontHeadDecision`）、batch claim 粘性；
2. 批的每个成员（本文第 3 节）的 PR 仍然 open、base 是 main、同仓库、head 等于记录的 H_k；**每个骑乘成员各自过一次 Native 完整准入**（同一个 admission 端口、同样的 `factsValid`，`frozen` 显式拒绝），并且它的认领在合并队列里（`mergeQueue.entered`）；
3. S 的形状：N=1 时 S 的父提交恰好是 [T, H]，树等于 GitHub 试合并的树（与今天相同）；N>1 时 S 沿第一父链正好 N 步回到 T，第 k 步的第二父是 H_k（`batchChainOk`）；
4. main 当前尖端 == T（读一次；PATCH 的 `force:false` 是最终的原子保证）；
5. ruleset 里不由 App 5368905 产生的必需检查（今天是 Actions App 15368 的 `ci-suites`、`clued-cloud-tests`、`migration-verify`）在 **S 本身**上最新一次成功；或者 N=1 且 S 的树等于 H 的树（H 已含 T）时，在 H 上成功（同一棵树，结果相同）。还在跑或还没有：`TRAIN_LANDING_CHECKS_PENDING`（停靠，稍后再查）；失败：`TRAIN_LANDING_CHECK_FAILED`（终局，属于 PR，进入二分）；
6. `push` 下第 8 段**不写任何检查**：不写 `kooyumi-merge-slot`，也不写 `kooyumi-admission-verified`（审查后改：先发一半再因“没就绪”停靠，会让一次停靠变成“写了一半”的 UNCERTAIN）。推 main 是这一段唯一的副作用；没就绪的回答都是零副作用的干净停靠。PR 页面因此凑不齐必需检查（本文第 8 节第 3 条再加一道谁都不发布的必需检查）；
7. main 的实时规则里有“禁止强推”“禁止删除”两条规则，并且必需检查里有钉在 App 5368905 的 `kooyumi-train-landed`（`landingRulesDecision`）；缺任何一条：`TRAIN_LANDING_RULES_MISSING`（停靠，等 Owner 配好）。这个接口只列出生效的规则，看不到谁能 bypass，所以 bypass 名单仍是 Owner 的上线步骤。

**失败关闭。** 任何读不到、对不上、形状不符：不推，按已有的停靠码或新码零副作用结束；第 10 段读不到批记录、读不到 main：不 adopt、不开新批。阶段文件 `train-landing.json` 存在但读不出：第 8 段对车头作业停靠（`TRAIN_MODE_UNREADABLE`，与 train-mode.json 坏了一样），第 10 段按 `github-merge` 只读不推；没有这个文件：`github-merge`（今天的行为）。`github-merge` 下遇到带骑乘成员的批记录：拒绝发绿（`TRAIN_BATCH_WITHOUT_PUSH`，终局），绝不给单个 H 发一个其实没测过的树的绿。

**与 strict 的关系。** `push` 要求 `train.sweep` 是 `audit` 或 `off`（strict 永久开）。strict 继续开着：万一有人绕过本文第 8 节在 PR 页面合并，也只能按 §65.1 合入“测什么落什么”的树。列车推 main 用规则集 bypass，不受 strict 影响。

### 3. 批量与二分

- **组批（第 10 段，`push`，开车头批次时）**：车头 = 唯一的位子持有者（绑定的 PR，§41.4 不变）。骑乘成员从同一次运行读到的打开 PR 里挑：同仓库、合到 main、非草稿、PR 正文的认领 trailer 存在、当前 head 上有 App 5368905 的 `kooyumi-work-admission` 成功（第 1 段已准入并由 Native 绑定认领）、不在“坏 head”名单里；按 PR 号升序取，最多 `batchMax − 1` 个。第 8 段再按 L2 第 2 条逐个实时准入。
- **累积合并**：N=1 用 GitHub 的试合并 S（父提交 [T, H]，今天就有）。N>1 由第 10 段用落地端口生成：把 `clued-train/staging.tmp` 强制指到 T，依次 `POST /merges {base: clued-train/staging.tmp, head: H_k}`；某个成员冲突（409）或已在 T 里（204）就从这批拿掉；得到 S 后逐个读回提交核对 `batchChainOk`。
- **触发项目 CI**：开批时把 `clued-train/staging` 强制指到 S，Actions 的 push 触发在 S 上跑三项必需检查（工作流改动是上线前提，本文第 8 节第 4 条）。在那之前，只有 N=1 且 H 已含 T 的批能凭 H 上的检查落地；其余停在 `TRAIN_LANDING_CHECKS_PENDING`，直到位子按 running 时钟到期，与今天“没绿”的结局相同（失败关闭）。
- **批记录**：`state\v2\train-sweep\landing-batch-*.json`（`clued.independent-ci.train-landing-batch/1`，只新建，写法同其它记录）：T、S、S 的树、成员表 [{pr, headSha, claimId}]、二分状态。第 8 段按 (车头 PR, H, S) 读它；第 10 段按 S 读它来 adopt 与二分。车头批次记录（`front-*.json`）照写，计尝试次数的规则不变。坏 head 名单与二分状态写在同一类记录里（`landing-state-*.json`，最新一条有效）。
- **二分（Mergify 式“找第一个坏的前缀”）**：第 10 段收到常驻层的 `frontOutcome`（车头批次终局失败、属于 PR 本身），按 `frontTestSha` 找到批记录：
  - 批只有 1 个成员：它就是坏的。是车头：照旧 `touch failed`（服务端让位并通知）；是骑乘成员：记进坏 head 名单（按 (pr, headSha)，换了 head 自动失效），不再参与组批。
  - 批有 n > 1 个成员：记 `suspect = 成员表`，下一批只取 suspect 的前 ⌈n/2⌉ 个（车头总在第一位）。前半通过并落地：suspect 去掉已落地的，若还剩 r 个，下一批取其前 ⌈r/2⌉ 个；前半失败：suspect 缩成前半，继续减半；减到 1 个就按上一条处理。任何一次组批时 suspect 的前缀与当时可用的成员顺序对不上（有人换 head、关 PR、位子换人）：清掉二分状态，回到正常组批（宁可多测一次，不推断）。
  - 不靠推断判定“坏”：只有单独测过并失败的成员才进坏名单。
  - 车头尝试的两次上限（§41.4）只数**车头单独**的批（审查后改）：多人批失败不算车头的次数，否则 [F, A, B, C] 里 A 坏时，F 在二分途中就把两次用完、被冤枉 touch failed。单独的批照旧计数，用完要推新提交。批记录的 attempt 按这个计数填（作业身份里的 attempt 仍只有 1、2）。
  - 骑乘名单（bad）只是“暂不搭车”：它当上车头时照样单独测一次；只有车头单独测过并失败才 touch failed。
- **骑乘成员冲突、已在 T 里**：从这批拿掉；车头本身冲突：不开批（`FRONT_NEEDS_MAIN_MERGE`）。
- **车头落后 main**：`push` 下不是 `FRONT_NEEDS_MAIN_MERGE`（列车自己落地 merge(T, H)，strict 只管 PR 页面的合并），strict-front 观察也不再要求 H 含 T；受保护层的车头仍要求 H 含 T（MergeAdmission v0.2 §2.4 不变）。
- **吞吐**：一批的时间约等于一个车头批次（§41.4 约 20 分钟），N 个都好时一次合 N 个。
- **N>1 的生产开关**：今天装好的打包与工作区准备（`build-bundle.ps1` 的 `TEST_COMMIT_PARENTS_REQUIRED`、`prepare-workspaces.py#test_parents_ok`）只接受父提交恰好 [T, H] 的 S，并要求 main == base。所以 Source 常量 `BATCH_CHAIN_INSTALLED = false`：第 10 段在生产里把批大小截到 1，即使策略写了 `batchMax > 1`。改这两个装机组件（描述符 /4 带成员链，Windows 与 Linux root 两侧同改、同装）是本文第 9 节的后续一步，做完把常量翻成 true。批量与二分的逻辑本身这次全部实现并有端到端测试（测试注入 `batchChain: true`）。**已由 ADR 0019 完成**：常量换成常驻层判断的已装事实（阶段文件的 `batchChain`），两侧工具按描述符 `/4` 核对整条链。

### 4. 身份与凭据

- **不新增任何秘密。** 落地端口（Source v2 `train-landing-port.mjs`）与检查端口用同一个私钥提供者：clued-control 进程里 `controllerPrincipal` 读到的 App 5368905 私钥（现有的签发器；Agent、worker、PR、日志都拿不到）。它向 `POST /app/installations/{id}/access_tokens` 申请**只含** `{contents: 'write', workflows: 'write'}` 的仓库级安装令牌（回答的权限集必须恰好是这两项加 metadata read，仓库恰好是本仓库，否则 `unexpected_installation_token_scope`）。要 `workflows: write` 是审查指出的：没有它，GitHub 拒绝任何带 `.github/workflows/**` 改动的提交被推上任何分支，这类 PR 在 `push` 下就永远落不了地（PR 页面又被本文第 8 节第 3 条封住）。这类改动本来就是受保护层，要 Owner 对精确 head 的 Grant，第 8 段的实时准入照旧核对。检查端口照旧申请 checks write/contents read/pull_requests read，所以检查令牌推不了 main，落地令牌写不了检查、合不了 PR、关不了 PR。
- 只有 `push` 下的第 8 段（推 main）和第 10 段（暂存 ref、累积合并）构造它；`github-merge` 下不构造、不铸令牌。
- 为什么是 App 5368905 而不是 clued-admission（5164952）：5164952 的私钥在 GitHub Actions 的秘密里，工作流够得着，检查端口也明确禁用它；5368905 的私钥只在 clued-control。代价：5368905 的私钥一旦泄露，攻击者能直接推 main（今天只能把 PR 的六项检查刷绿，还要有人点合并）。本文第 8 节第 2 条用一个 bypass 为空的“main 只许快进”规则集兜底：即使私钥泄露也只能让 main 前进，不能改写历史或删除 main。

### 5. 落地的状态机（第 8 段）

1. 车头作业的 `waitForQueueHead` 照旧（位子、队首、必需检查失败就退位……）；`trainFacts` 在 `push` 下读批记录，N>1 时用链核对代替 [T, H] 和 GitHub 试合并的树核对；`trainHead`（strict-front 路径）照旧。
2. `kooyumi-admission-verified` 照旧发布并读回。
3. journal 意图（effect key 由 merge-slot 作业 + 动作 `train-land-main/1` 派生，带 T、S、成员表）→ L2 全部实时检查 → `sent` → `PATCH` → 读回 main。
4. 结果：
   - 200 且读回 main == S：`settled`，回答 `SETTLED`，`landed: {mainSha: S, members}`；绿色台账记 `landed`（没有检查 id）。
   - 422/403/404/409：读 main。等于 S（别的运行刚推过同一个 S）：同上算落地。等于 T（审查后改：被规则、bypass 或权限拒绝，main 没动）：journal 记 `revoked`（没生效），回答停靠码 `TRAIN_LANDING_REFUSED`，不算 main 移动、不烧尝试次数，Owner 修好配置后下次第 8 段整套重来。别的提交：main 被别人抢先推进，journal `revoked`，回答 `RESIDENT_BASE_MOVED`（干净结束这批）；下一次第 10 段在新 main 上重开车头批次。
   - 5xx、断线、读回失败：在有界窗口（4 秒）内反复读 main：== S 算落地；否则 journal 记 `uncertain`、回答 `UNCERTAIN`（`TRAIN_LANDING_UNCONFIRMED`，副作用 1；审查后改：即使读到 main 仍是 T 也不记 `not_sent`，网关可能先回答、写后到）。之后第 8 段见到这个未结束的意图只回答 `RECONCILIATION_REQUIRED`，绝不盲目再推；第 10 段凭“main 含 S”照样 adopt。唯一可能写进去的就是 S，不可能“推错”。
5. 推之后、回答之前崩溃：journal 停在 `sent`；下一次第 8 段见到未结束的意图按已有规则 `RECONCILIATION_REQUIRED`；第 10 段仍会凭“main 含 S 且 S 是本节点批记录的 S”adopt（本文第 6 节），不会卡死。

### 6. 落地之后（第 10 段，`push`）

- 每次第 10 段按时间顺序看本节点最近 20 个批记录：main 包含它的 S（`compare` 读出 S 等于 main 或是它的祖先）、还没记为“已 adopt”的，就对它的成员**先骑乘、后车头**逐个处理（审查后改：不再要求“这批的车头就是当前车头”，车头先 adopt 归还位子后崩溃也不会让骑乘成员卡住）：实时读 PR，head 仍是批里的 H_k（已合并，或还开着、GitHub 还没标）才 `adopt(pr, mergeSha: S)`；PR 已换了新 head 的不 adopt（它的认领跟着新 head 继续，审查指出的误 adopt）。每个成员都有了答复，这批才记为已 adopt（`landing-state`），二分同时据此更新一次。决定 `FRONT_ADOPTED`，facts 带 `landing {mainSha, landed, adopted, notMarkedMerged}`。
- 服务端 `clued_work_claim_adopt_v1` 只按 `bound_pr` 取最新的认领，不核对认领代次与 head（审查第 2 条）。这一步的实时 head 核对挡住了“成员推了新提交”；给 RPC 加 `expected_claim`/`head_sha` 参数要改迁移，列为后续（本文第 9 节）。
- GitHub 把 PR 标成已合并是异步的。成员 PR 在 adopt 时还没标 merged：照样 adopt（批记录与 main 的祖先关系才是事实），facts 记 `markedMerged: false`；之后读到仍 open 的已落地成员，第 10 段在 facts 的 `landing.notMarkedMerged` 里列出（PR 页面提示，等 Owner 看）。令牌没有 pull_requests write，列车不去关 PR。
- 车头 PR 已合并但 main 里没有任何本节点批的 S（有人绕过列车合并，或者换班：批记录只在原节点）：仍按 §41.4 的落地树核对（[T, H] 且树等于 S 的树才 adopt，不等就 `TRAIN_LANDED_TREE_MISMATCH` 停车）。`push` 下没有 merge-slot 绿可读，所以换班后新节点会停车等 Owner（失败关闭；审查第 7 条，落地记录跨节点同步列为后续）。
- 常驻层：车头批次以 `SETTLED` 且 `landed` 结束时立即要一次第 10 段（urgent，受每日上限约束），不必等 10 分钟一轮。

### 7. 并行预测：评估结论是这一步不做

- 一台当班节点同一时刻只能跑一个批次：交换代理全局互斥、`maxConcurrent` 只能是 1（§45 第 1 条）。车头批次还在跑时，没有第二条流水线可以“假设车头会过”去测下一批。
- 备用节点（STANDBY）按 §41.6 不开批次、不发布；让它参与是 L3（《CI 优化方案》：L1 之后，TURING 跑非车头 PR 的预检），要另行设计当班与认领。
- 能做的只有在车头批次第 8 段等 CI 时，第 10 段预先生成下一批的累积合并（按“车头会过”）；省下的只是一次第 10 段（约 1 分钟），而 main 前进后多半要重建。不值得增加的复杂度。批量本身已经把吞吐提到 N 倍。等 L3 做完再评估。

### 8. 上线前提（Owner 与 DESK 执行，代码不做）

1. **App 权限**：App 5368905（`clued-ci-checks-turing-20261018`）加 `Contents: Read and write` 和 `Workflows: Read and write`，在安装页接受新权限。其它 App 不动；clued-admission（5164952）不得出现在任何 bypass 名单里。回退到 `github-merge` 时同时撤掉这两项权限和 bypass。
2. **规则集**：
   - main 的现有规则集 `24182890`：bypass 名单只加一项 Integration = App 5368905，模式 `always`（推送也能 bypass）。strict、只留 merge、必需检查保持不变。
   - 新建规则集“main 只许快进”：目标 main，规则“禁止强推（non_fast_forward）”“禁止删除”，再加“必需检查”：Actions（App 15368）的 `ci-suites`、`clued-cloud-tests`、`migration-verify`（不开 strict）。**bypass 名单为空**。规则集的必需检查对直接推送同样生效：即使 5368905 能 bypass 主规则集、即使它的私钥泄露，也只能把 main 快进到一个 Actions 三项已在该 SHA 上通过的提交（审查第 3 条）。代价：第 4 条（项目 CI 跑在 S 上）成为 `push` 的硬前提，N=1 时“H 与 S 同树就认 H 上的检查”的放宽在服务端不再够用。
   - 新建规则集“列车暂存”：目标 `clued-train/**`，规则“限制创建、更新、删除”，bypass 只有 App 5368905（列车要强制移动这两个 ref）。
3. **禁止从 PR 页面直接合并**：在主规则集的必需检查里加一项 `kooyumi-train-landed`，来源钉 App 5368905；任何代码都不发布它。于是没有 bypass 的人（包括 auto-merge、守队程序、Owner 在网页上点合并）都凑不齐必需检查；列车推 main 走 bypass，不受影响。（只靠“push 下不发 merge-slot 绿”不够：旧模式发过的 merge-slot 绿还挂在一些旧 head 上。）回退到 `github-merge` 时同一次保存删掉这一项。注意：第 8 段 `waitForQueueHead` 的必需检查判定（`train-rules.mjs#requiredCheckFailure`）今天把“钉在 App 5368905、名字不认识”的必需检查当作不认识的来源，整次判定读不出（`REQUIRED_CHECKS_UNREADABLE`，车头永远停靠）。所以代码把 `kooyumi-train-landed` 列为已知、永不发布的检查：缺席不算失败，也不算读不出；它不进 `rulesetFacts` 的六项钉住要求（`github-merge` 下规则集里没有它）。必须先装包、再在规则集里加这一项，顺序反了会让第 8 段全部停靠（失败关闭，但会卡车）。
4. **项目 CI 跑在 S 上**（受保护路径 `.github/**`，要 protected-change Grant）：`clued-required-tests.yml` 的 `push` 触发加上 `clued-train/staging`；这种运行的可信基线取 S 的第一父提交 T，并核对 T 在 main 上（`git merge-base --is-ancestor`），只接受推送者是 App 5368905 的 bot；三项检查照旧以原名报告在 S 上。没做这一步时，见本文第 3 节“触发项目 CI”的失败关闭行为。
4b. 工作流改动的细节（审查第 8 条）：runner 只放行 `clued-required-tests.yml` + `clued-train/staging` + App bot 的 push；`CI_BASE_SHA` 同样取经祖先核对的 T，不能用暂存 ref 的 `before`。守队程序在 main 必需检查含 `kooyumi-train-landed@5368905` 时不再 update-branch 或合并车头。`push` 触发的运行用的是 S 里的工作流文件，可信基线只能在 job 里落实（今天写的是 `github.sha`），要改成取 S 的第一父并核对它在 main 上；核对环境的部署保护不会因规则集放行 `clued-train/**`；`push` 的并发组不能丢掉排队中的旧运行（否则二分时检查会一直停在 `TRAIN_LANDING_CHECKS_PENDING` 直到位子到期）。
5. **修订 #292 的措辞**：原文“自动化也必须经 PR、bypass 名单为空”改为：
   > 合入 main 只有两条路：一是经 PR 由 GitHub 合并（`train.landing=github-merge` 时）；二是合并列车以 App 5368905 把它测过、并在推送前逐项实时准入过的提交快进推上 main（`train.landing=push` 时）。main 主规则集的 bypass 名单只含 App 5368905；“main 只许快进”规则集的 bypass 名单为空；其它任何人或自动化都不得直接推 main。
6. **合同**：MergeAdmission 与合同草稿写明：`push` 下 PR 不再由人或 auto-merge 合并，列车测过就推；批量时位子之后的骑乘成员随车头一起合入（每个成员都过实时准入，坏的被二分剔除）。
7. **策略**：`FLEET_TRAIN` 随通用包下发，取代一次 UAC 写策略。先合入仓库侧工作流、runner 钩子和守队程序门控，配好 App 权限、列车暂存与无 bypass 的“main 只许快进”规则集；再以单独 PR 将 `FLEET_TRAIN.landing` 改为 `push`（`batchMax` 先保持 1），发通用包，先升级待命节点、再升级当班节点并核实两侧同代。之后主规则集的 App bypass 与 `kooyumi-train-landed` 同一次保存。不得以节点本地策略替代通用包，包会重写 train；未完成前保持 `github-merge`。旧代码上线前不能先加它不认识的必需检查，否则全部 `REQUIRED_CHECKS_UNREADABLE` 停靠。
8. **合并意愿**（审查第 4 条，Owner 决定点）：今天 strict 模式下 PR 要靠 auto-merge（`Clued-Auto-Merge:` 选择加入）或守队程序合并；`push` 下认领进了合并队列就等于要合并，列车测过就推（守队程序 §41.8 本来也会合任何全绿的 PR）。若 Owner 要保留“显式选择加入”，再加一条：骑乘成员和车头都要有选择加入 trailer。
9. **Native 发布票据**（审查第 4 条）：受保护层的 guarded 发布（`publicationRequired`）今天经 `prepareNativePublication` 拿票据再写 merge-slot 绿。`push` 下骑乘成员凡是 `publicationRequired` 一律不搭车（代码已拒）；车头仍要过 Native 完整准入（含 Owner Grant），但“落地”本身还没有对应的 Native 票据。在 Owner 定义落地票据之前，建议受保护层的车头在 `push` 下也只走 `github-merge`，或由 Owner 确认“完整准入 + Grant”即可落地。

### 9. 拆除：做了什么、留什么、以后拆什么

| 部件 | 这次 | 理由 |
|---|---|---|
| 接班水位上报（`reportSweepWatermark`，§41.6） | **已拆掉调用**（facts 字段保留、恒为 false；Source A 的端口函数在受保护路径里，留着不动） | 只是信息：review R2 B1 之后没有任何接班用它（§41.6、Source A 注释都这么写）；拆掉不影响任何闸门 |
| `push` 下的 merge-slot 绿、绿色台账的 intent/posted/settled | `push` 下不再产生 | 不发绿就没有要台账和撤销的东西 |
| 全量扫描（`train-sweep.mjs`、strict lane、§60 范围） | 留；`push` 下建议 `train.sweep: off` | §65.4 的“main 被改写就冻结到 scope all 轮完成”仍依赖它；`gate` 是回到“关 strict 列车”的唯一路径（§65.5）。`push` 稳定运行 30 天、Owner 放弃关 strict 之后再拆 |
| 撤绿与台账（§41.3、pending-revocations） | 留 | `github-merge`（回退路径）下仍发 merge-slot 绿；strict-front 证明要求“没有待确认撤销” |
| 单绿证明 / strict-front 证明（§62.1） | 留 | 第 8 段的实时准入（holder、claim 代次、Source、strict、frozen）就是通过 `strictFrontHeadDecision` 做的，推 main 前照样要它 |
| §41.4 落地树核对 | 留（双保险） | 只在“车头被别人合并、main 里没有本节点的 S”时才走到 |
| 以后拆（`push` 稳定后、下面的后续一步之后） | — | `gate` 模式与接管门（§41/§60–§62.4）、strict lane（第 16 代）、全量扫描的审计轮、绿色台账与撤销（若 Owner 放弃 `github-merge` 回退）、`frontBind`/让位等只为 merge-slot 绿服务的调度 |

**后续（审查带出的）**：adopt RPC 加 `expected_claim`/`head_sha`（迁移）；落地记录同步到服务端或 KooYomi，换班后新节点能 adopt；落地的 Native 票据（上面第 9 条）；Actions 检查按工作流与 head_branch 核对来源（今天只按 App 15368 认名字，与 GitHub 自己的必需检查同样的信任）。

**后续一步（批量真正上生产）**：描述符 /4 带成员链；`build-bundle.ps1` 接受“第一父链 N 步回到 T、第二父依次是成员 head”的 S；`prepare-workspaces.py#test_parents_ok` 同样改；装好后 `BATCH_CHAIN_INSTALLED = true`。**这几项已由 ADR 0019 完成**（常量换成已装事实；C# 边界不用改：作业 id 不变，`PureTestsV2.cs` 不核对父提交）。仍未做：骑乘成员的顺序改由常驻层按第 1 段读到的合并队列位置给出（今天按 PR 号，见本文第 11 节）。

### 10. 改了什么（代码）与测试

- **Source v2**：`independent-control-checks-v2/train-landing.mjs`（纯函数：阶段文件、链核对、必需检查判定、组批、二分；落地状态机）、`train-landing-port.mjs`（落地端口）、`train-sweep-store.mjs`（`landing-batch`、`landing-state` 记录）、`publisher.mjs`（`push` 下第 8 段推 main）、`train-maintenance.mjs`（`push` 下组批、累积合并、adopt 全部成员、二分；拆掉水位上报）、`startup.mjs`、`train-facts.mjs`（可选的 `landing` 事实）、`train-rules.mjs`（认得 `kooyumi-train-landed`）、`github.mjs`（检查端口拒绝发布它）、`resident-v2/invoke-stage.mjs`（`--train-landing`，只给第 8、10 段）、`resident-v2/stage-fact.mjs`（新码）。C# 边界只读它点名的文件，不读这个新文件，不改。
- **常驻层**：`policy.mjs`（`train.landing`、`train.batchMax`，/8 起可选，没写时策略字节和摘要不变；`push` 要求 `sweep` 不是 `gate`；`batchMax > 1` 要求 `push`）、`engine-windows.mjs`/`service-main.mjs`（把它传给第 8、10 段）、`executor.mjs`（落地后立即要第 10 段）、`classify.mjs`/`failure-table.json`（新码）、`status.mjs`（`train.landing`）。
- `upgrader/src/` 不动；`scripts/ci/**`（受保护）只有注册表重新生成的部分。
- **测试**：端到端（真实 Source v2 第 10 段 `runTrain` + 真实第 8 段发布者 + 模拟 GitHub（ref、merges、compare、推送后把 PR 标成已合并、Actions 检查）与 Native）：3 个 PR 排队 → 一批 → 推 main → 3 个都标为已合并、都 adopt；中间那个坏 → 二分 → 其余两个合入、坏的进名单；main 被别人抢先推进 → 422 → 干净结束 → 在新 main 上重测 → 落地。单元：落地端口（令牌权限、只许快进、拒绝其它 ref）、纯函数（链、必需检查、组批、二分）、策略键、阶段文件。

### 11. 残余

- 骑乘成员按 PR 号排，不严格按合并队列的位置（生产里批大小今天是 1，不受影响；本文第 9 节后续一步改）。
- GitHub 把 PR 标成已合并是异步的，偶尔要等；列车不靠它判断落地。
- 项目 CI 的工作流改动（本文第 8 节第 4 条）之前，`push` 只比 §65 多了“自己推、不用等人点合并”，BEHIND 的车头仍要合 main。
- 5368905 私钥泄露的后果从“刷绿”变成“能推 main（只能前进）”。

### 12. 独立审查意见与处理（general-purpose 子代理，只给设计稿与代码路径）

| # | 级别 | 意见 | 处理 |
|---|---|---|---|
| 1 | 阻断 | 没有 `workflows` 权限推不了带工作流改动的提交；所有 422 都当成 main 移动会吃掉尝试、冤枉 PR | 令牌加 `workflows: write`（本文第 4 节，上线前提 1）；422 后 main 仍是 T 判 `TRAIN_LANDING_REFUSED` 停靠，不算移动（本文第 5 节） |
| 2 | 阻断 | adopt 只按 `bound_pr` 取认领，成员换 head 会被误 adopt | adopt 前实时核对 PR head 仍是批里的 H_k，换了就不 adopt（本文第 6 节，测试覆盖）；RPC 加参数列为后续 |
| 3 | 重要 | 私钥泄露能快进到任意树 | “只许快进”规则集加 Actions 三项必需检查（规则集必需检查对推送生效），回退时撤权限（本文第 8 节第 1、2 条） |
| 4 | 重要 | 绕过了 Native 发布票据与 auto-merge 选择加入 | guarded 骑乘成员不搭车（代码）；车头的落地票据、合并意愿列为 Owner 决定点（本文第 8 节第 8、9 条） |
| 5 | 重要 | 骑乘成员准入：frozen、`requireQueueHead:false`、认领代次、顺序 | 显式拒 frozen、`requireQueueHead:false`、认领 id 必须等于批记录的、必须在合并队列里（代码、测试）；代次（fence/epoch）组批时读不到，残余；顺序按 PR 号的残余见本文第 11 节 |
| 6 | 重要 | 二分会把车头的两次机会用完 | 多人批失败不计车头次数（本文第 3 节，端到端测试） |
| 7 | 重要 | 崩溃或换班后 adopt 卡住 | 先骑乘后车头、以“main 含 S”为准（本文第 6 节）；换班后失败关闭停车、落地记录同步列为后续 |
| 8 | 重要 | S 上 CI 的可信度、工作流基线、并发组 | “最新一次按 id”已实现；工作流细节写进上线前提 4b；来源核对列为后续 |
| 9 | 建议 | 第 8 段核对规则集里有只许快进、禁止删除、train-landed；检查端口拒绝发布 train-landed | 都已实现（`landingRulesDecision`、`github.mjs#createCheck`） |
| 10 | 建议 | 切换模式时撤遗留 merge-slot 绿 | 不做：strict 开着时遗留绿只能合入测过的树（§65.1），且有 `kooyumi-train-landed` 封住 PR 页面 |
| 11 | 建议 | PATCH 只能用 `job.testSha`；5xx 后不要记 `not_sent`；S 先被暂存 ref 钉住 | PATCH 用 `job.testSha`；5xx 记 `uncertain`（本文第 5 节）；开批时先把 `clued-train/staging` 指向 S |
| 12 | 建议 | `train-landing.json` 不在 C# 边界里；`batchChain` 只许夹具注入 | 与 train-mode.json 同一信任级别（常驻层写、clued-control 读）；`batchChain` 只是 `runTrain` 的参数，生产入口 `main()` 从不传，取常量 false |

审查确认与代码一致的事实：`requiredCheckFailure` 把未知名字判成读不出（所以代码认得 `kooyumi-train-landed`）、`TEST_COMMIT_PARENTS_REQUIRED`、`test_parents_ok`、令牌权限集核对。审查结论“L1 在拓扑上成立”。
