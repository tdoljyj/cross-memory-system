# ADR 0020：备用节点跑非车头 PR 的预检——评估结论是不实现

- 状态：决定不实现（只做了分析，没有改运行代码）
- 日期：2026-11-07
- Owner Decision：无；属于优化方案 Task `bf57ff10` 的 L3 评估。独立审查第一稿 FAIL，修订稿 PASS（0 BLOCKER、0 MAJOR）。
- 来源：分支 `claude/standby-prechecks` 提交 `a82e51c24`。原为常驻 DESIGN 的 §67，与冻结档案的 §67 撞号，所以合入时改为本 ADR。正文中的 §41、§62、§64、§65、§66（状态里的分段耗时）指冻结的 DESIGN。“M4 §65.x” 是写作时 M4 在分支上的编号，M4 在冻结档案里是 §68。

## 摘要

- **背景**：L3 提议让备用节点（TURING）用闲置算力给非车头 PR 先跑一遍预检，只发 info-only 状态，或者只产出能复用的缓存。
- **决定**：不实现。
- **理由**：
  - 实测当班节点从来没有让一个 head 排在别的 PR 后面（0/49），预检能提前的只有约 1 分钟的轮询延迟，而预检自己也省不掉这一步；
  - M4 缓存跨节点不命中；
  - 走受保护路径就要让未准入的代码进 root 工作区，还会多出一类不进账本的执行。
- **后果**：第 4 节列出什么时候值得重新评估，以及到时候任何实现都必须满足的不变量。第 3 节 A.2 后面的附注记了一个与预检无关的冲突：`NATIVE_SCAN_START_REQUIRED` 切换以后，全局 K 的键与车头批次冲突。需要另行登记。

## 详细分析（原 DESIGN 草稿 §67，节号改为本文节号）

**提议**：今天只有当班节点（DESK）跑 CI，备用节点（TURING）只发心跳、等接班（§41.6、§41.6a）。L3 想让 TURING 用闲置算力给“非车头”的开放 PR 先跑一遍，类似 Mergify 的 two-step CI：PR 上先预检，进队列成为车头以后再做正式检查。预检只能是以下两种之一：(A) 只发 info-only 的提示状态，不发六项必需检查、不烧 head、不影响当班节点的正式批次；(B) 只产出能被正式批次复用的缓存结果（接 M4）。

**结论**：**不实现。**
- 按实测，当班节点从来没有让一个 head 排在别的 PR 后面，所以 (A) 能让作者提前的时间约等于轮询延迟，中位数约 1 分钟。
- (B) 在现在的信任结构下跨节点命中不了；要让它命中，当班节点就得根据另一台机器算出来的结果发布必需检查。
- 两种形态里，凡是走受保护路径的，都要让未准入的 PR 代码进 TURING 的 root 工作区，还要另开一条不进 (head, role) 账本的执行路径，接班时也让不干净；不走受保护路径的那种（本文第 3 节 C），价值同样接近 0。

价值近乎为零，风险是真的。下面给数据和逐条理由，最后列出什么情况下值得重新评估，以及到那时任何实现都必须满足的不变量。顺带记下一个和预检无关、在 Native 扫描许可切换以后才会出现的冲突（本文第 3 节 A.2 之后的附注）。

### 1. 实测：当班节点从不让 head 排在别的 PR 后面（只读 GitHub，2026-11-07；独立审查复测）

数据来源：`tdoljyj/cross-memory-system` 上 #996–#1035 各 PR 的提交状态 `resident-queue/desk-w-591 (info only)`（§23.2，每个节点在自己排队或运行的提交上写），以及检查 `admission-gate`（GitHub Actions，推送即触发，它的 `started_at` 当作推送时刻）。

| 指标 | 数值 |
|---|---|
| 每天新建 PR（10-22 至 11-07） | 0–20 个；11-04 至 11-07 依次为 4、12、19、11 |
| 推送 → 当班节点第一次写“运行中：第 0 段”（最终 head，去掉 `admission-gate` 被重跑、推送时刻不可用的 6 个，n=33） | 中位数 1.0 分钟，p75 2.2，p90 5.7，最大 38.6 |
| 上面的长尾，逐条原因 | #1035 38.6 分钟：§65.9 的缺陷，排在**自己**旧 head 的停车批次后面；#1029 11.4、#1031 6.3：执行器重启后在回填已执行记录（§16.1）；#1032 10.3：“合并列车的 Source 不一致，等 Owner 处理”（§41.6）。**没有一条是排在别的 PR 后面** |
| 推送时当班节点正在跑别的 PR 的 head（11-05 至 11-07，按提交去重后 49 个推送过的 head） | **0 / 49** |
| 被取代的 head（13 个）里，排了队、还没运行就被取代的 | 0 个（另有 2 个因落后 main 被拒：#1002 `c60cce88`、#1028 `267991ba`，属于正常行为） |
| 单个 head 从第一次到最后一次“运行中”（含同一 head 的普通批次和车头批次） | 中位数约 18 分钟，p90 约 29–35（作者与审查两种取法：未去重 51 个、按提交去重 49 个） |
| 当班节点忙的时间（上面区间的并集） | 11-05 约 6–6.6 小时（25–28%），11-06 约 6.6–7.0 小时（28–29%），11-07 截至 13:30 UTC 约 4.2–4.3 小时（约 31%）。两个数分别是不加和加 1 分钟收尾余量的算法 |

保留意见：Agent 推一个 PR 后通常会等 CI 结果，推送节奏本身就是串行的，所以低排队里有一部分是被压住的需求。即使把这部分考虑进去，当班节点的利用率也只有三成左右。

### 2. 价值估算

- **作者更早看到失败**：
  - 预检要跑的扫描器和正式批次一样（gitleaks 约 5.4 分钟、trivy 4.6–5.3、contract-placement 2.4–3.1，§45.4），TURING 跑得不会比 DESK 快。所以预检最多提前“排在别人后面的时间”，按本文第 1 节是 0。
  - 剩下能省的只有第 0 段之前的轮询延迟（60 秒，§39），而预检同样要先读 PR 才能开始，这一项它省不了。长尾的那几种（重启回填、Source 不一致、§65.9 那类缺陷）是当班节点不可用，预检同样帮不上：Source 不一致时按题目要求它本来就不跑。
  - 托管 CI（`ci-suites`、`clued-cloud-tests`、`migration-verify`）在当班节点第 1 段准入之后紧接着开始（#1024：准入 21:08:33，`ci-suites` 21:09:02），作者看到测试失败的时刻同样由“当班节点什么时候开始”决定，而它几乎立即开始。
  - `train.enabled=on`、`nonFrontRuns=true` 时，非车头 PR 本来就在当班节点上跑普通批次，“停在 B”（§65.2；§62.6 的“不让位的情形”）。失败照样提前发在 PR 上，预检和它重复。
- **正式批次命中缓存而缩短**：
  - M4 的缓存是**每个节点自己的**：记录放在本机 Linux root 私有目录，键里有 `runtimeIdentity`、`hostAcceptanceRef`、`sourceAcceptanceRef`（M4 §65.1 的表）。两台机器的这些值不同，TURING 写的记录在 DESK 上按设计**永远不命中**。
  - M4 在同一节点内“普通批次 → 车头批次”可能命中，前提是 placement 的 base 树和被测树都没变，也就是这期间 main 没动过；队首 PR 的普通批次在第 1 段就让位（§62.6），不填缓存。命中时省下的是三个 trivy 扫描器容器和一个 placement 容器，快照、漏洞库准备、准入和签名照做（M4 §65.5、§65.7），上限约为 trivy 加 placement 的 7–8 分钟，**未实测**。
  - 如果把非车头 PR 的工作挪到 TURING、让 DESK 少跑普通批次（`nonFrontRuns=false`），DESK 的缓存就没人填了，车头批次最多失去这几分钟的命中。
  - 让记录跨节点可用，就是让 DESK 根据 TURING 跑出来的扫描结论发布 trivy、contract-placement 这两项必需检查。M4 的记录只有完整性摘要（`recordSha256`），没有签名，也没有跨节点通道。要做就得给 DESK 加一个信任 TURING 签名钥的新信任根、一条传输通道、一次 Owner 接受和两个角色的重签资格。改完以后，“当班节点只发布自己执行过的结果”这条就不成立了（本文第 3 节 B）。
- **TURING 的算力其实并不闲**：这台机器同时跑 Agent 的重活（含 local-verify）。有免费分钟时，gitleaks 和 trivy 还可以经托管转发跑在 GitHub 托管 runner 上（§7.5），这本来就是把算力挪出常驻节点的现成办法。
- **估算合计**：
  - 作者提前看到失败：按本文第 1 节为 0，最多是轮询延迟那一分钟，而预检也省不掉它；
  - 正式批次：跨节点不命中，节省为 0；如果配合 `nonFrontRuns=false`，每个本来能命中的车头批次还可能多花几分钟（上限约 7–8 分钟，未实测）。

### 3. 安全核对：几种形态各卡在哪里

题目要求论证“不会出现两个节点争用、重复发布、伪造检查”。下面逐条看要做到这些需要什么，以及为什么现在做不到或者代价过高。

**A. 走受保护路径真跑扫描器，只发 info-only 状态**

1. **能不能签发**：
   - gitleaks、trivy、contract-placement 在受保护的路径上跑：Windows 签发方 → 桥 → Linux root worker，在角色锁和单 unit 守卫之下（§45.1）。
   - 今天卡住签发的，是签发方自己按批次认领代做的准入：`worker/protected-job-bridge-v4/windows-issuer.mjs` 的文件头、`issuerEvaluate`（:85），以及 `readBatchClaim`（`src/batch-claim-v2.mjs`）。这些都要第 1 段 Native 准入已经绑定的批次认领。这个认领只有持 ci-admission 角色的节点拿得到，备用节点得到的是 `admission_binding_required`（`formal-work-admission-check-v2/publisher.mjs:84`，§29 `NODE_ROLE_NOT_HELD`）。
   - Native 扫描许可切换以后还要再加一道：`scan-start-v1/native-port.mjs` 先 `validateFormalAdmissionV2(job, facts)`，服务端（迁移 `20261102151506_ci_scan_start_keys_v1.sql`:254-257）再要求认领是 `ACTIVE`、已绑定这个 PR、fence 和 epoch 都对得上。没有认领的备用节点根本拿不到许可。
   - 要让 TURING 跑，只能另开一条“不准入的扫描作业”。这样未准入（Native 拒绝、Owner 没批、受保护路径没有 Grant）的 PR 内容就会进 Linux root 工作区。§62.7 拒绝把 wsprep 提到准入之前（只为省 14.5 秒），四条理由里的第 2 条就是这个。contract-placement 还会在容器里**执行**被测树里的代码（M4 §65.1 第 4 条），暴露面比 wsprep 更大。
2. **烧 head 与“只真跑一次”**：
   - 今天 `NATIVE_SCAN_START_REQUIRED = false`（`scan-start-v1/grant.mjs:53`）。切换以后，每次真启动扫描器都先消耗 Native 全局唯一的一次 (repository, head, role) 启动许可：迁移主键 `primary key(repository_id,head_sha,role)`（:30，注释写明“deliberately global”），已经消耗过就答 `scan_start_already_consumed`（:263）。预检如果走同一条路，就在全局烧掉这个 head，当班节点的正式批次就跑不了它，违反“不烧 head”。
   - 预检如果不拿这个许可，就多出一类不进账本的真执行。§50 不变量 ①“同一提交的同一检查只真跑一次”（第 3907 行）和 K(head, role) 管的是发布与重跑；§54 已经在严格证明之下放宽过同批次重跑，普通批次和车头批次今天也会在同一棵树上各跑一次。所以准确地说，预检不违反“只发布一次 / K(head, role)”，但会多出一类完全不受账本约束的执行。
   - 本机层面，TURING 的预检要是写了本机的 executed-heads 或 Linux 侧的执行记录，接班以后 TURING 自己就会以 `HEAD_ALREADY_PUBLISHED_NO_RETRY` 拒跑这个 head；要是不写，就要为预检另建一套运行目录、归档和静止证明（§24.4、§27、§54.3）。

   > **附注：与预检无关、切换以后会出现的冲突（建议另行登记）。** 全局 K 的键里只有 `head_sha`，而车头批次的 `headSha` 也是 H（`job-v2.mjs:66`，`isTrainFrontJobV2` 是 `testSha !== headSha`），`native-port.mjs` 发送的就是 `head_sha: job.headSha`。所以 `NATIVE_SCAN_START_REQUIRED` 一旦切到 true，下面几种 DESK 自己的流程都会拿不到许可（`scan_start_already_consumed`）：
   > - 非车头 PR 的普通批次已在 H 上真跑过扫描，之后的车头批次 (H, S)；
   > - 第 2 段的 attempt 2；
   > - §54 的同批次原地重跑；
   > - M4 车头批次命中缓存时照样要取的许可（M4 §65.5）。
   >
   > DESIGN 里还没有记下这个冲突，§54 只写了“`NATIVE_SCAN_START_REQUIRED = false`，所以不需要许可”。切换之前要先改 K 的键（例如加上 `test_sha`），或者给重跑定义同一 `execution_id` 的续用规则。这也是本文第 4 节第 2 条的前提。
3. **争用与接班让出**：
   - TURING 上只有一套单例：交换槽、Linux 角色锁、单 unit 守卫、formal-spool、companion 邮箱 lane（§45.1），预检要占全部五个。接班可以是 §41.6a 的自动接班（DESK 失联时），也可以是 Owner 的一键移交。接班以后 TURING 最先要做的是接班清扫和第 1 段准入（§41.6），预检得“立即”让出。
   - 但正在跑的 Linux 扫描 unit 不能直接杀：要么等它跑完（典型约 5 分钟，段上限 gitleaks 45、trivy 30、placement 10 分钟，§45.4），要么走 §27 的 `provenCleanEnd` 证明没有发布再归档。后者在 companion 不在或忙的时候，正是 §24.4 拿掉的那类 HALT 来源。对预检来说，“接班时立即让出”不是免费的，每一条退出路径都要像正式批次一样逐条证明。
4. **双活判断**：node-duty 把 `resident-queue/<node>` 下的“当班”当成接班核对和双活锁的输入（`node-duty.mjs` 文件头，§23.4、§23.5）。备用节点已经有自己的 context `resident-standby/<node> (info only)`（§23.2、`node-duty.mjs` 的 `standbyContext`），现场也能看到 TURING 写的“备用节点 turing，不参与本 PR”。预检的状态写在这里或另一个 context 下即可，这一条不是阻碍。
5. **重复发布和伪造**：
   - 如果状态用 Owner 的 gh 登录写成提交状态（像 `resident-queue` 那样），它满足不了规则集里钉了 `integration_id: 5368905` 的六项，本身伪造不了必需检查。
   - 可是要让预检在 GitHub 上看起来像检查，就得用 App 5368905。每个节点都有这个 App 的一把私钥（§30.5、§30.8），今天挡住备用节点发布必需检查的，是“只有 ACTIVE 开批次”加上签发方和各发布者里的准入。在准入流程之外再给持有私钥的代码一条发布路径，正是本设计一直避免的。

**B. 只产出可复用的缓存**

- 命中不了的理由见本文第 2 节。要命中，就得让 DESK 发布的 trivy、contract-placement 必需检查依据 TURING 的执行结果，而这些结果是在没有 DESK 准入、也没有 DESK 烧号的情况下产生的。这就是“当班节点发布了不是自己执行的检查”。不管签名链做得多严，这都改变了“六项必需检查只由当班节点、按自己准入并执行过的结果发布”这条约束的含义，属于 Owner 层面的信任结构变更，不是 L3 这种优化能顺手带进去的。
- 不跨节点的那一半（TURING 用自己的缓存）只在 TURING 接班以后才有用。接班本来就不常发生：自动接班只在失联时触发，另外只有 Owner 的手动移交。

**C. 不走受保护路径：非 root、无凭据、断网的一次性容器只跑 gitleaks 和 trivy**

- 这是风险最低的形态。gitleaks 和 trivy 是静态扫描，不执行 PR 代码，只有 contract-placement 执行。在 TURING 上用非 root 用户、不挂任何凭据、`network none` 的一次性容器只跑这两个，发 info-only 状态：不进受保护路径，不碰 root 工作区、全局 K、五处单例和 App 私钥。（本文第 3 节 A.1 说的“暴露面”主要来自执行代码的 placement。）
- 剩下的问题：
  - 结果和正式结果是否一致没有保证：漏洞库版本、gitleaks 的审核例外证明、受信规则文件都要另行钉住。不一致时作者看到一红一绿，反而添乱。
  - 共享额度：两个节点的 companion 用同一个 Owner gh 登录，REST 额度是共享的。
  - 接班时同样要能让出。
  - 镜像、漏洞库和规则要单独维护一份。
- 价值：按本文第 1 节、本文第 2 节仍然很低。正式批次是串行的（打包加第 1 段 2.4–8 分钟，gitleaks 约 5.4 分钟加发布 0.5 分钟，之后才轮到 trivy，§45.4），并行的容器能让 gitleaks 的结论早 2–8 分钟、trivy 最多早约 10 分钟。但托管测试本来就在第 1 段之后立即开始，作者最关心的测试结果不会提前，而且预检和正式结果是否一致没有保证。所以这种形态也不做。

### 4. 什么时候值得重新评估

满足下面任一条再重新评估，到时候另开设计：

1. **当班节点开始真排队**：连续 7 天，“推送时当班节点正在跑别的 PR”的 head 超过 20%，或者这些 head 从推送到“第 0 段”的 p90 超过 15 分钟。口径同本文第 1 节：推送时刻取该 head 上 `admission-gate` 最早的 `started_at`，被重跑的不计；“第 0 段”取 `resident-queue/<当班节点>` 第一条“运行中：第 0 段”；当班节点不可用（重启回填、PAUSE、HALT、Source 不一致、暂停接新）造成的等待单独统计，不计入排队。§66 的分段耗时状态可以作为第二个数据源。另一种情况是 Owner 决定 `nonFrontRuns=false`，非车头 PR 不再在当班节点上跑。
2. **Native 扫描许可切换已完成，并且本文第 3 节 A.2 附注里的 K 键冲突已解决**：那时有了跨节点的全局 (head, role) 账本。在此基础上值得考虑的不是“预检”，而是**按 PR 分片的第二个当班节点**：服务端给每个 PR 指定唯一一个执行节点，两个节点都走正式批次、都计入全局账本。这要改“只有一个常驻节点持有 ci-admission”（§41.6a 的“任何时候至多一个常驻节点持有者”），必须由 Owner 决定。

到时候任何实现都必须满足的不变量（也就是本节没能满足的那些）：

- 只有持 ci-admission 角色、并通过第 1 段 Native 准入的作业，才能让 PR 代码进入 root 工作区；
- 每次真启动扫描器都计入同一本 (head, role) 账本，账本里没有不计数的执行类别；
- 必需检查只按发布节点自己准入并执行过的结果发布；
- 接班时，所有非正式工作都能在一个固定的短上限内以“证明没有发布”的方式让出，不新增 HALT 来源；
- 备用节点不写任何会被 node-duty 当成“当班”的状态；
- 双节点 Source 一致才跑：按 §41.6 holders 回答的 `nodes`，24 小时内有心跳的节点里只要有一个 Source 不同就不跑；
- 不挤占共享额度：Owner gh 登录的 REST 额度（两个 companion 共用）、App 5368905 安装的限额（两个节点共用）、Native 的评估额度，都要给正式工作留出余量，额度紧张时先停非正式工作。

### 5. 现在怎样更好地用上 TURING

不需要新机制：

- 托管转发（§7.5）在有免费分钟时把 gitleaks、trivy 挪到 GitHub 托管 runner；
- 瓶颈是每个批次的串行长度（中位数约 18 分钟），缩短它比预检有用得多：M4（同节点命中，最多省约 7–8 分钟，未实测）、§64 去掉往返、§45.3 的多角色扫描段（最多省约 8 分钟）；
- TURING 继续承担 Agent 的重活。

### 6. 测试与验证

本节没有改运行代码，所以没有新增测试，题目里的四条测试也无从对照“修复前失败”。四条性质在今天的代码里的状况：

| 题目里的性质 | 今天的保证 | 已有测试 |
|---|---|---|
| 备用节点不发必需检查 | 不是 ACTIVE 就不开批次（`executor.mjs:223` 的 `NODE_DEFERRALS`），签发方与发布者都要准入 | `test/node-mode.test.mjs` |
| 不烧 head | 第 1 段答“不持有角色”时释放、不计数 | `test/node-mode.test.mjs:233` |
| 接班时立即让出 | 不适用：备用节点今天什么都不跑，没有要让出的工作 | 无 |
| 源码不一致时不跑 | §41.6 的 Source 一致性核对 | Source v2 `test/train-sweep.test.mjs:609` |

验证（2026-11-07，Windows 上逐个串行跑，node 一律 `--test-concurrency=1`，没有在 WSL 里跑任何套件）：`selectSuites` 对本次改动选出 ci-suites 的 resident-node、resident-python、offline-drill、source-v2-node、source-v2-python、admission-self-tests，以及 clued-cloud-tests 的 clued-cloud（它的路径是 `**`）。结果：resident-node 1100 个测试，1094 通过、0 失败、6 跳过；resident-python 142 个通过（跳过 2）；offline-drill 70 步通过；source-v2-node 807 个全部通过；source-v2-python 8 个通过；admission-self-tests 227 个通过。clued-cloud 没跑：本次没有改动 clued-cloud 的文件，协调会话也要求本机先不跑它的全量单测。R9 注册表、`clued-merge-reconcile-source.json`、组件注册表都没有变化。准入模拟：路径层为 code，不需要 Owner Grant。

source-v2-node 第一次跑出 1 个失败：`linux-worker-final-admission.test.mjs` 的“an observation that does not name the last admission answer…”。原因在测试夹具：两次准入答复如果落在同一毫秒，`observedAt` 相同，观察摘要也就相同，“指向第一次答复”就等于“指向最后一次答复”。用冻结时钟可以稳定复现。修法是让夹具每次答复的 `observedAt` 都不同（单独提交，只改测试，不在 Source 闭包里）。修完后冻结时钟和真实时钟下都是 4/4 通过，全套 807/807。
