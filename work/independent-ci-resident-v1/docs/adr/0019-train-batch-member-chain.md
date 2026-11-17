# ADR 0019：批量真正上生产——描述符 /4 与两侧的成员链核对

- 状态：实现已合入；Owner 于 2026-11-17 决定准备启用 ADR 0018 的 push 落地，仓库侧前提正在补齐。船队统一值 `FLEET_TRAIN` 仍为 `github-merge`、1；多人批次仅在 `train.landing=push`、`train.batchMax>1` 且已装同代链核对时生效，生产安装与首批结果须另行核实。
- 日期：2026-11-08（设计与实现，合入第 28 代）
- Owner Decision：同 [ADR 0018](0018-bors-landing.md)（`9e2511fe` 第 6 项，Task `7d86cf41`）
- 来源：分支 `claude/train-bors-chain` 提交 `bf444310d`。原为常驻 DESIGN 的 §67，与冻结档案的 §67（准入往返去掉重复开销）撞号，所以合入时改为本 ADR。代码注释里的 “ADR 0019 §n” 指本文第 n 节。

## 摘要

- **背景**：ADR 0018 已经实现了组批与二分，但装好的 `build-bundle.ps1` 和 `prepare-workspaces.py` 只认父提交恰为 [T, H] 的 S（描述符 /3），所以生产里每批只能有一个 PR。
- **决定**：一批有几个 PR 时，常驻层写描述符 `/4`，内容是成员表加 S 的树，两侧工具核对整条累积合并链。`BATCH_CHAIN_INSTALLED` 不再是常量，改由常驻层判断的已装事实（`:chain`）决定。
- **理由**：/3 的检查一条没有变弱；/4 两侧逐项等价；任何判断依据失败都退回一批一个。
- **后果**：要一次原地升级，Linux 三个角色随新 Source 清单重签；装好之后才能把 `batchMax` 改大（本文第 8 节）。

## 详细设计（原 DESIGN 草稿 §67，节号改为本文节号）

**一句话。** 一批几个 PR 时，常驻层给打包和工作区准备写描述符 `/4`：`/3` 的全部字段，加上成员表（合并顺序，车头第一）和 S 的树。`build-bundle.ps1`（Windows，companion）和 `prepare-workspaces.py`（Linux root）都在对象上把整条累积合并链 T → S1=merge(T,H1) → S2=merge(S1,H2) → … → S 核对一遍。ADR 0018 的 Source 常量 `BATCH_CHAIN_INSTALLED = false` 改成一个已装事实：常驻层读到“已装 Source 的两个工具和调用器都认得 /4，并且 Linux 一侧跑的是同一代”，才在第 10 段的参数后面加 `:chain`；第 10 段只在阶段文件写了 `batchChain: true` 时才按 `batchMax` 组批。缺任何一项、读不到：仍是一批一个（失败关闭）。`/3`（一个 PR）的核对一字未变。

### 1. ADR 0018 为什么只能一批一个

ADR 0018 第 3 节已经实现了组批、累积合并、二分和推 main，但装好的两个工具只认 `/3`：`build-bundle.ps1` 要求 `rev-list --parents -n 1 S` 恰好是 `S T H`（`TEST_COMMIT_PARENTS_REQUIRED`），`prepare-workspaces.py#test_parents_ok` 同样。N>1 时 S 的父提交是 [S(N-1), HN]，两侧都会拒；而且描述符里只有车头的 H，工具无从知道其余成员。所以第 10 段在生产里把批大小截到 1（`effectiveBatchMax` 只在测试注入 `batchChain: true` 时放开）。

### 2. 描述符 /4

- 合同 `clued.independent-ci.resident-batch-descriptor/4`。字段 = `/3` 的全部字段 + `testTree`（S 的树，第 10 段经 GitHub 读回链时得到）+ `members: [{pr, headSha}]`（2..4 个，第一个就是描述符自己的 `pr`/`headSha`，PR 号与 head 各不相同，没有一个等于 T 或 S）。
- 作业 id 的公式不变（`/3`，含 testSha）：S 的 SHA 已经钉住整条链（提交不可变，父提交是提交的一部分），所以 C# 边界、作业、签名结果、Linux 归档的 id 都不用改。
- 只在第 10 段给了成员的车头批次写 `/4`；其余批次照旧写 `/3`。`/3` 不许带 `members` 或 `testTree`（三处读者都拒，`DESCRIPTOR_REFUSED`），免得一个 `/3` 被当成链。
- 成员从哪来：第 10 段 `openFront` 在 `composeBatch` 得到 N>1 个成员时，把 `members` 放进 `openFrontBatch`（train facts 的 `validBatch` 核对形状）；常驻层 `train.mjs#openFrontBatchOf` 再核一遍形状，`enqueueFront` 把它写进回执 `train-front-enqueued`（重启后 `trainFrontRecover` 从回执恢复绑定；自动第二次尝试的回执也带成员），`executor.mjs#drive` 用 `train.mjs#chainOfFront` 对上主体（pr、H、T、S 都相同）后交给 `engine.derive(subject, key, chain)`。
- 形状不合时（审查第 6 条更正）：`openFrontBatchOf` 返回 null，整份 train 摘要就是 null；第 10 段这时已 touch running、推过暂存 ref（有副作用），所以这次第 10 段按“有副作用而事实不成立”处理，即 HALT（`TRAIN_STAGE_OUTCOME_UNCONFIRMED`），不是悄悄忽略。只有新旧组件混装才会走到这里（同一代的 Source 与常驻层对形状的规则相同）。`drive` 里成员与主体对不上（按 PR 与 S 取绑定，不应发生）：写回执 `train-front-chain-unbound`，按 `/3` 继续，两侧工具会拒掉这个链式的 S（失败关闭，原因有记录）。
- **组批时每一步都必须是列车自己合出来的提交**（审查第 3 条）：`composeBatch` 记下每次 `POST /merges` 返回的提交，`readBatchChain` 要求链上第 k 步恰好是第 k 次合并返回的那个。这样，两次合并之间有人强推 `clued-train/staging.tmp`（换成一个父提交形状正确、内容任意的提交）时，组批失败（`FRONT_TEST_MERGE_NOT_READY`），不会把没人准入的内容带进 S。之后两侧工具和第 8 段核对的都是这个 S（它的 SHA 钉住了整条链）。ADR 0018 第 8 节第 2 条的“列车暂存”规则集仍是第二道防线。

### 3. 两侧的核对

两侧做同一组核对，代码互为孪生（`Chain-Of`/`Chain-Ok` 与 `chain_members_ok`/`chain_ok`）：

| 核对 | build-bundle.ps1（Build-Store，每次尝试、第二代 gen-2 也做） | prepare-workspaces.py（镜像库和两个候选库各做一次） | 拒绝码 |
|---|---|---|---|
| 描述符形状 | `Read-Descriptor` → `Chain-Of` | `validate_descriptor` → `chain_members_ok` | `BATCH_CHAIN_DESCRIPTOR_REFUSED` |
| 每一步的父提交：从 S 沿第一父恰好 N 步到 T，每步恰好两个父提交，第 k 步的第二父是成员 k 的 head（顺序、个数、章鱼合并、换了的父提交都不行） | `Chain-Ok` 读 `rev-list --parents -n 1`（N 次） | `chain_ok` 同上 | `BATCH_CHAIN_REQUIRED` |
| 最终 S 的树等于描述符的 `testTree` | `rev-parse S^{tree}` | 同上 | `BATCH_TEST_TREE_CHANGED` |
| 每个成员 head 是库里的提交 | `cat-file -t` | 同上 | `BATCH_MEMBER_COMMIT_MISSING` |
| 每个成员 head 是一个分支的当前尖端（在 ls-remote 的精确 ref 表里） | `$local` 的 `refs/heads/*` | 封存 bundle 头里的 `refs/heads/*`（等于回执的 ls-remote 表） | `BATCH_MEMBER_NOT_BRANCH_TIP` |
| 每个成员 head 就是 GitHub 上 PR #n 现在的 head | 再一次 `ls-remote <url> refs/pull/<n>/head…`（网络步骤 `ls-remote-members`，按网络失败重试） | 回执的 `chainMembers`、`testTree` 必须与描述符相同（证明打包时做过这一步） | `BATCH_MEMBER_NOT_PR_HEAD` / `BUNDLE_RECEIPT_REFUSED` |

- 回执（合同仍是 `/1`）对 `/4` 多两个字段 `chainMembers`、`testTree`；`/3` 的回执不变（测试钉住 `/3` 回执没有这两个字段）。
- `-CheckRefs`（第一个扫描段前“bundle 之后没人推送”的闸）不用改：成员分支本来就在 ls-remote 表里，任何成员推了新提交都会让 ref 表变化，`REMOTE_REFS_CHANGED_SINCE_BUNDLE`。
- `ls-remote` 的模式按尾部匹配，名字恰好像 `refs/heads/refs/pull/<n>/head` 的分支也会列出来：这种行跳过，只认要的名字（审查第 7 条；否则任何能建分支的人都能让链批次被拒）。PR head 读失败按网络步骤在脚本内重试；它不在 companion 的 `BUNDLE_NETWORK_STEPS` 里，持续失败算作普通的 `BUNDLE_UNAVAILABLE`（与 `fetch-test` 相同）。
- PowerShell 读顶层字段名不区分大小写（`"Members"` 它也认），Python 区分；更严的一侧把关，不构成绕过（审查第 8 条）。
- **“每个 H 都是队列里经过准入的 head”在各层的含义。** 两个工具按设计只读 git（companion 只有 Owner 的只读 git 凭据，root 不联网），看不到认领、合并队列和 Native。所以准入本身由有这些信息的两段负责，工具负责“链上的每个 H 正是那份准入名单里的、此刻的那个 head”：
  1. 第 10 段组批时只挑当前 head 上有 App 5368905 最新一次 `kooyumi-work-admission` 成功（第 1 段准入、Native 绑定认领）的 PR（ADR 0018 第 3 节），名单进 `openFrontBatch.members`；
  2. 两个工具核对链上的第二父恰好是这份名单、按这个顺序，每个 H 是活着的分支尖端、是 GitHub 上该 PR 号此刻的 head（换了 head、关了分支、名单写错 PR 号，都拒）；
  3. 第 8 段推 main 前对每个成员实时过 Native 完整准入、要求 `mergeQueue.entered`、head 仍是记录的 H（ADR 0018 第 2 节 L2 第 2 条，不变）。
  常驻层没有再按自己的账本核一遍“成员准入过”：成员可能是另一个节点的第 1 段准入的（换班），本节点账本里没有，那样会把正常批次挡死；它只核形状与主体一致。

### 4. `BATCH_CHAIN_INSTALLED` 换成可靠的已装事实

- **谁判断。** 常驻层的 `engine-windows.mjs#batchChainSupported()`，因为它既是写描述符的一方，又能读到已装 Source 和两侧的版本事实：
  1. 已装 Source v2（`<root>\source\<ciSourceManifestSha256>\…\resident-v2\`，批次开始前 `sourceIntegrity` 按清单逐字节核过）里，`build-bundle.ps1`、`prepare-workspaces.py`、`invoke-stage.mjs` 各含一个固定字面量（`BATCH_CHAIN_SOURCE_MARKERS`：`$ChainContract='…/4'`、`DESCRIPTOR_CHAIN_CONTRACT = '…/4'`、`export const TRAIN_LANDING_CHAIN_ARG = 'chain';`）。与 §56.2 的 `queueWatchSupported` 同一做法：明确的答案（都读到，或文件不存在）在引擎生命期内保留；别的读失败（杀毒、备份占用）当“否”，5 分钟后再读。
  2. 两侧是同一代：版本视图（`status.mjs#versionsView` → `upgrade-mailbox.mjs#consistent`，即 Linux 版本事实的代次、Source 清单、Linux 清单与 `current.json` 相同、`pinsOk`、事实不超过 15 分钟）`consistent === true`，并且 Linux 一侧的 Source 清单就是本节点 policy 的那个。Linux root 跑的 `prepare-workspaces.py` 来自 `/opt/clued-independent-ci/source-v2`，它运行时还会核对 `HEAD == sourceCommit`；同一代的 Linux 归档工具 `clued-ci-resident-linux` 认得 `/4`。这一半每次都现读。
  没有版本端口、视图读不到或为 null/false、Source 不同：否。
  前提（审查第 10 条）：它读的是 `paths.sourceRoot` 下的 `build-bundle.ps1`，companion 配置的 `bundleScript` 按 §33 指向同一个 `source\<ciSourceManifestSha256>\`；万一 companion 留在旧 Source，旧脚本对 `/4` 是 `DESCRIPTOR_REFUSED`，只会拒不会放。
- **怎么传。** 只在第 10 段、`push`、`batchMax > 1` 时，常驻层把 `--train-landing push:<n>` 改成 `push:<n>:chain`（`stageArgs`）。Source 的调用器 `invoke-stage.mjs#parseLandingArg` 认得 `:chain`，写进阶段文件 `train-landing.json` 一个只在为真时才出现的键 `batchChain: true`（不为真时字节与 ADR 0018 完全相同）。第 8 段永远拿不到 `:chain`（它不组批）。旧的调用器不认 `:chain`，但常驻层只在读到新调用器的字面量后才发，所以不会出现新常驻层配旧 Source 时第 10 段整段被拒。
- **谁用。** 第 10 段 `effectiveBatchMax(trainLanding)`：`push` 且 `batchChain === true` 且文件读得出，才是 `batchMax`；否则 1。`runTrain` 不再有 `batchChain` 注入参数，测试和生产走同一条路（阶段文件）。
- 失败关闭的组合：新常驻层 + 旧 Source → 没有字面量 → 一批一个；旧常驻层 + 新 Source → 不发 `:chain` → 一批一个；新新但 Linux 未升级或版本事实过期 → 一批一个；阶段文件坏 → 不推（ADR 0018 不变）也不组批。

### 4b. 常驻层跟上：多人批不占车头的次数，成员走了不算车头的失败（审查第 1、2 条）

- **车头次数**（审查阻断 1）：ADR 0018 第 3 节让第 10 段只数“车头单独”的批（多人批失败不计次数，否则二分途中就把两次用完），但常驻层的 `FRONT_BATCHES_PER_HEAD = 2` 原先数所有车头批次：[F,A,B,C] 失败、[F,A] 失败之后，第 10 段开 [F]，常驻层却回 `TRAIN_FRONT_ATTEMPTS_USED`，车头一直空转到它推新提交。现在 `frontBatches` 每条带 `solo`（没有成员即单独），上限只数单独的批；多人批（每个都是不同的 S）不计数、不受这个上限（组批与它的节奏由第 10 段决定）。自动第二次尝试同理：多人批的第二次尝试不占车头次数，仍是同一组成员和 S（`/4`）。重启后 `trainFrontRecover` 按回执里有没有 `members` 恢复 `solo`。
- **成员走了**（审查第 2 条）：骑乘成员在组批后推了新提交（或关了分支），打包会以 `BATCH_MEMBER_NOT_BRANCH_TIP` / `BATCH_MEMBER_NOT_PR_HEAD` 拒。companion 把这两个原因回成 `TRAIN_BATCH_MEMBER_MOVED`（`companion.mjs#BUNDLE_MEMBER_MOVED_REASONS`）；执行器按“被取代”释放（`SUPERSEDED`：不计车头 head 的释放上限、不进断路器、不算一次评估），并把这个 S 从运行队列里拿掉（它不可能再过）；第 10 段按成员此刻的 head 重新组批。其余的链拒绝（形状、父提交、树、提交缺失）仍是 `BUNDLE_UNAVAILABLE`（计数），因为它们说明的是描述符或 S 本身有问题。

### 5. 安全论证：没有哪项检查变弱

- `/3` 的全部核对原样：`[T, H]` 父提交、单一测试 ref、main == base、ref 表、审阅提交、新鲜度、回执绑定。新增的只有拒绝（`/3` 不许带链字段）。
- `/4` 比 `/3` 多核：每一步父提交、成员名单、S 的树、成员尖端、PR head、回执里的链。`/4` 仍有 `/3` 的每一项（S 由测试 ref 按 SHA 取来、main == T、ref 表等于 ls-remote……）。
- 链式的 S 要通过任一侧，必须同时满足“描述符是 /4、名单与链完全一致”；名单只来自第 10 段（Source，clued-control 进程），常驻层只搬运、核形状；第 8 段推 main 前仍逐个实时准入（L2 不变），推的仍只是这个 S（L1 不变）。
- 判断依据失败一律回到一批一个，从不放大批次。

### 6. 改了什么（代码）

- **Source v2**：`resident-v2/build-bundle.ps1`（`Chain-Of`、`Chain-Ok`、`Split-Pull-Heads`，Build-Store 的链核对，回执两字段）、`resident-v2/prepare-workspaces.py`（`chain_members_ok`、`chain_ok`、`member_tips_ok`、`check_chain`，回执绑定）、`resident-v2/invoke-stage.mjs`（`:chain`）、`independent-control-checks-v2/train-landing.mjs`（去掉常量，阶段文件的 `batchChain`，`effectiveBatchMax` 只看阶段文件）、`train-maintenance.mjs`（`openFrontBatch.members`，去掉注入参数）、`train-facts.mjs`（`members` 的形状）。C# 边界不动（作业 id 不变）。
- **常驻层**：`engine-windows.mjs`（`DESCRIPTOR_CHAIN_CONTRACT`、`batchChainSupported`、`stageArgs`、`derive` 写 `/4`）、`train.mjs`（`openFrontBatchOf` 带成员、`chainOfFront`）、`executor.mjs`（回执带成员、`drive` 传链、车头次数只数单独的批、成员走了按被取代释放并拿掉 S）、`companion.mjs`（`TRAIN_BATCH_MEMBER_MOVED`）、`linux/bin/clued-ci-resident-linux`（归档认 `/4`，id 公式不变）。
- **Source v2 组批**：`train-landing.mjs#readBatchChain` 可带 `steps`，`train-maintenance.mjs#composeBatch` 传入每次合并返回的提交（审查第 3 条）。
- `upgrader/src/` 与三个冻结 Linux 文件（`linux/upgrade-v1/…`）一字未动；升级代理的传递导入（canonical、store、inbox、intake-pause、upgrade-mailbox、instance-lock）也没动。

### 7. 测试

- `test-build-bundle.ps1`（313 例，真实 git 对本地仓库）：`Chain-Of` 的 14 种拒绝、`Chain-Ok` 的父提交互换/章鱼/少成员/换 T、`Split-Pull-Heads`、`Read-Descriptor` 对 `/3`/`/4`/`/5`；Build-Store 上真实的 3 个 PR 的链通过（3 次父提交读、1 次 PR head 读）并打成 bundle；篡改：父提交互换、H 不在名单、名单顺序错、少一个成员、树不符、PR head 指到别处、PR 号不存在、成员分支被删，各有其码且不重试；PR head 读卡住按网络重试；`/3` 对同一个 S 仍是 `TEST_COMMIT_PARENTS_REQUIRED`；整个脚本跑一次 `/4` 批次，回执带 `chainMembers`/`testTree`，`/3` 回执没有；树不符时整个脚本拒、不留回执。
- `test_prepare_workspaces_v2.py`：`/4` 形状的 15 种拒绝、`/3` 带链字段被拒、作业 id 与 `/3` 相同；回执绑定的 5 种拒绝；真实 git 上 3 个 PR 的链在仓库和从 bundle 克隆的候选库上都通过 `check_chain`，篡改（父提交互换、章鱼、H 不是成员、顺序、少一个、多一个、换 T、树、成员不是分支尖端）各被拒。
- `train-landing.test.mjs`：阶段文件 `batchChain` 的字节、只在 push、坏文件即一批一个；`:chain` 的解析与拒绝；三个字面量在真实 Source 文件里。
- `train-landing-e2e.test.mjs`：**batchMax=3 按生产路径**：真实常驻层 `WindowsEngine.stageArgs`（夹具 Source 目录里放真实的三个文件、版本端口说同代）→ `push:3:chain` → 真实调用器解析与阶段文件 → 真实第 10 段组出 3 个成员的一批 → 真实第 8 段一次推 main，3 个都合并、都 adopt，第 4 个 PR 下一批单独合；常驻层的 `openFrontBatchOf`/`chainOfFront`/`derive` 写出的 `/4` 成员与树就是那个 S 的链（`batchChainOk` 对世界里的提交核过），单 PR 批是 `/3`。没有链事实（版本 null、false、Linux Source 不同）时同样的 3 个 PR 分 3 批合。train facts 与常驻层对坏成员表的拒绝。原有用例改为从阶段文件取批大小。
- 常驻层：`engine-v2.test.mjs`（`/4` 描述符、坏链被拒、`stageArgs` 的全部否定分支与读失败重试）、`train-on.test.mjs`（成员进回执、重启恢复、交给 derive，单 PR 不给；真实执行器上多人批的第二次尝试两次都是 `/4`、三个多人批之后车头单独仍能入队、车头单独两次之后多人批仍能入队、第三次单独被拒、重启按回执恢复 `solo`；成员走了按被取代释放、不计上限、断路器不动、S 被拿掉，普通打包拒绝仍计数）、`halt-timeouts.test.mjs`（companion 只把两个“成员走了”的原因回成 `TRAIN_BATCH_MEMBER_MOVED`，其余链拒绝与非 2 退出码仍是 `BUNDLE_UNAVAILABLE`；`$NetworkSteps` 含 `ls-remote-members`）、`test_linux_privilege.py`（归档认 `/4`、拒 `/5`）。
- 审查后补的 Source 用例：`readBatchChain` 带 `steps` 时换掉的一步被拒（只看形状时无法分辨）；e2e 里两次合并之间有人强推 `staging.tmp`，第 10 段不开批、main 不动；`Split-Pull-Heads` 跳过尾部同名的分支，Build-Store 上建一个 `refs/heads/refs/pull/103/head` 分支不影响结果。
- 修复前：上述新用例全部失败（导入缺失或断言失败）；e2e 的 batchMax=3 用例在修复前的代码上是 4 批各合 1 个。

### 8. 上线要求

1. **新一代通用包原地升级**（不需要整套重装：`upgrader/src` 与冻结 Linux 文件未变）。这一代同时带：新的 Source 清单（`ciSourceManifestSha256`：两个工具、调用器、第 10 段）、新的常驻清单（`residentManifestSha256`）、新的 Linux 清单（`clued-ci-resident-linux` 与 `/opt/.../source-v2`）。policy 里的两个清单哈希随这一代重签，`FLEET_TRAIN` 随通用包下发，取代一次 UAC 写策略；按通用升级流程先待命、后当班，核实两侧同代。
2. **重签的角色**：Linux 三个角色 gitleaks、trivy、contract-placement 随新 Source 清单在切代时由 Linux 侧重新派生、重签 policy 与 qualification（每一代都做；§63 装上后打包不再需要 UAC 导出角色副本，没装时仍按 §57.7 导出一次）。Windows 一侧没有新的签名角色；App 权限、规则集不变（ADR 0018 第 8 节的前提照旧）。
3. **策略**：先按 ADR 0018 §8 配齐前提并通过通用包启用 `FLEET_TRAIN.landing: push`；待单 PR 落地稳定、`status` 里版本一致之后，再以单独 PR 将 `FLEET_TRAIN.batchMax` 改成 3，随下一通用包下发，不直接写节点 policy。顺序反了也安全：常驻层读不到 `/4` 字面量或版本不一致时只发 `push:3`，第 10 段一批一个。
4. 第一批多 PR 批次跑完后核对：常驻层 outbox 里该批的 `descriptor.json` 是 `/4`，bundle 回执有 `chainMembers`，Linux ws-prep 回执 `RESIDENT_WORKSPACES_PREPARED`，main 一次前进到 S。

### 9. 残余

- 准入由第 10 段与第 8 段负责，两个工具只能证明“链上的 H 就是那份名单里此刻的 PR head”（本文第 3 节）。
- `refs/pull/<n>/head` 在推送后由 GitHub 异步更新，极短窗口里会让打包拒（`BATCH_MEMBER_NOT_PR_HEAD` → `TRAIN_BATCH_MEMBER_MOVED`，不计上限、不进断路器）。成员真的换了 head 时第 8 段本来也会拒。
- 成员走了的批次结束时没有 `frontOutcome`：第 10 段的车头批次记录要等位子的 running 时钟到期才算结束，之后按成员此刻的 head 重组（ADR 0018 已有的残余：没有 `frontOutcome` 的结束都这样）。这段时间车头不前进，但不占它的次数、不计它的释放上限。
- 骑乘成员仍按 PR 号排（ADR 0018 第 11 节），不按合并队列位置。
- 中间合并的内容由第 10 段“每步是自己合出来的”保证（本文第 2 节）；两侧工具只核父提交与最终的树，不重算每一步的合并（S 的 SHA 已钉住整条链，S 本身被扫描、跑 CI）。
- 两个工具本身不能核对准入，只能证明链上的 H 就是名单里此刻的 PR head（本文第 3 节）。

### 10. 独立审查意见与处理（general-purpose 子代理，只给代码与设计）

| # | 级别 | 意见 | 处理 |
|---|---|---|---|
| 1 | 阻断 | 常驻层 `FRONT_BATCHES_PER_HEAD` 把多人批也算进车头的两次，二分到车头单独时被拒，车头空转 | 改：只数单独的批，多人批与它的第二次尝试不占次数，重启按回执恢复（本文第 4b 节，真实执行器用例） |
| 2 | 重要 | 骑乘成员走了导致的打包拒绝占车头的释放上限、进断路器 | 改：companion 回 `TRAIN_BATCH_MEMBER_MOVED`，执行器按被取代释放并拿掉这个 S（本文第 4b 节，用例） |
| 3 | 重要 | 中间合并提交的内容无人核对，两次合并之间强推 `staging.tmp` 可带入任意内容 | 改：`composeBatch` 记下每次合并返回的提交，链上每一步必须恰好是它（本文第 2 节，单元与 e2e 用例）；规则集仍是第二道防线 |
| 4 | 建议 | 第二次尝试与重启后成员是否保留没有测试 | 补：多人批第二次尝试两次 derive 都是 `/4`；重启按回执恢复成员与 `solo` |
| 5 | 建议 | 成员与主体对不上时静默写 `/3` | 改：写回执 `train-front-chain-unbound`，仍按 `/3` 失败关闭 |
| 6 | 建议 | 本文第 2 节“整个批次不认”不准确：其实是 HALT | 更正本文第 2 节的措辞 |
| 7 | 建议 | `ls-remote` 尾部匹配，同名分支会让链批次被拒 | 改：只认要的名字，其余行跳过（用例）；网络分类写进本文第 3 节 |
| 8 | 建议 | PowerShell 字段名不区分大小写，两侧不是逐字节孪生 | 写进本文第 3 节；更严的一侧把关，不改 |
| 9 | 建议 | StrictMode 2 下没发现问题 | 无需处理 |
| 10 | 建议 | 只核了 `sourceRoot` 下的 `build-bundle.ps1`，没核 companion 的 `bundleScript` | 写明前提（本文第 4 节与代码注释）；不一致时只会拒 |
| 11 | 建议 | ADR 0018 第 9 节“已完成”里混着没做的项；`BATCH_CHAIN_DESCRIPTOR_CONTRACT` 没人用 | 拆开 ADR 0018 第 9 节的措辞；删掉这个导出 |

审查确认：`/3` 没有任何检查变弱（只多一条拒绝）；`/4` 两侧逐项等价；判断依据失败关闭，新旧混装都回到一批一个或在打包时被拒；不需要整套重装、只有 Linux 三个角色重签的结论正确。
