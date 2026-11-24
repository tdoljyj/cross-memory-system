# 首装演练 kit

入口已实现，尚未在 VM 实测。A 档仅用于 CLUED-DRILL/drill 已提权的 PowerShell Direct 会话：
加载接受版 bootstrap 的函数，依原顺序验证资产、前置、first-install-check，直接运行接受版 first-install-host，
再运行 prepare 和接受版 bootstrap -Stage launcher。接受资产不改写。host 使用验过哈希的管理员专用临时树。

这是 README §5“不要绕过 bootstrap 手工运行 prepare”的**演练机内例外**，仅绕开普通令牌检查、RunAs、凭据窗口。
凭据输入目录严格使用 O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)，把 app-key.pem 映射成 app-private-key.pem，
只另放 ci-admission.token、resident-upgrade.token、companion-github.token（陪伴令牌替身，见下）、public.json，不放心跳令牌；输入与正式临时凭据目录在所有结束路径清理。
结局由接受版 Get-LauncherVerdict 判断，companion 切换未完成不会变成功。

**凭据按被演练的包来给**（Fable 裁定补“合入顺序”“心跳令牌与重启码”“凭据名单来源”）：凭据文件名单是包随归档发布的数据
`windows/credential-files.json`（`{"contract":"clued.independent-ci.credential-files/1","required":{…},"optional":{…}}`），建 kit 时从归档原样读出，
连同其字节的哈希记进 kit 的 `credentials` 与 `credentialFilesSha256`；组内键须匹配 `^[A-Za-z][A-Za-z0-9]*$`、文件名须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 且不以点结尾、不是保留设备名（与包分支同一组白名单）；没有这份文件、contract 不符、读不懂（含非 UTF-8）、不合白名单、键或名字重复（按 ASCII 不分大小写）、同名跨两组的包拒绝建 kit
（`DRILL_PACKAGE_CREDENTIALS_UNREADABLE`）。演练不再解析包的 PowerShell 源码。开机前：从已核的 tar 重新读出这份文件，字节哈希与两组名单都须与 kit 的记录相同，不一致即拒绝（`DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES`）；
必需的名字演练造不出来即拒绝（`DRILL_CREDENTIAL_REQUIRED_NOT_MADE`，detail 为名字）；可选的名字演练必须有显式决定，没有决定即拒绝
（`DRILL_CREDENTIAL_OPTIONAL_UNDECIDED`）。包没声明的名字不生成、不交付。决定写在 `drill/credential-decisions.json`（`drill-vm.ps1` 读成 `$script:DrillCredentialDecisions`，建 kit 也读它：给出且带 `perNodeStep` 的名字，不论在必需组还是可选组，都在 kit 的单节点步骤里登记一步），
回执 `credentials` 列出本次给了的与本次未给的可选凭据（含理由）。

构建器把三处绕过写进 perNodeSteps；被演练的包列出的名字（必需组或可选组均可）凡决定表给出并带 `perNodeStep` 的，各再加一条替身登记（现为陪伴令牌替身）；判定器对 prerequisiteMode=first-install-host 额外强制 A10 未通过。

替身登记（入口不再盖住任何包内函数；`Expand-Cached` 的旧替身已删，#1154 修好了包里的真函数）：

| 替身 | 替的是什么 | 为什么 | 因此没验到 | 何时可删 |
|---|---|---|---|---|
| 服务端与 CI 令牌（`kit.json` 的 `server`；kit 里的 `fleet-node-<v>.first-install-kit.json`、`fleet-node-<v>.first-install.SHA256SUMS`、`fleet-node-<v>.acceptance.json` 三份；`C:\drill\fake\ci-admission.token` = Owner 的演练绑定） | 生产服务端（Release 的首装 kit 里 `record.supabaseUrl`、`record.publishableKey` 两个公开字段）与真节点的 CI 绑定 | 演练不得接触生产；现造的令牌打生产只会被答“未授权”（第 17 代候选包的演练），真令牌又不该出现在演练里 | 生产服务端对本包的应答；带 ci-admission 角色节点的首班车 | 不可删；没验到的部分由真机首装承担 |
| `C:\drill\fake\companion-github.token`（`ghp_CLUEDDRILLFAKE…`，来宾里生成、来宾里读；仅当被演练的包在必需组或可选组列出它时生成并交付，kit 同时登记这一步） | Owner 在凭据窗口给的陪伴 GitHub 经典令牌 | 演练不得使用真凭据 | 令牌被 GitHub 接受；陪伴访问 GitHub 的各个通道 | 不可删；没验到的部分由真机首装后的运行状态承担 |

按设计不给的可选凭据：

| 名字 | 决定 | 理由 | 因此没验到 |
|---|---|---|---|
| `ci-node-heartbeat.token` | 按设计不给（不造假心跳令牌） | 假令牌会让来宾的常驻向生产心跳端点发请求，既改变来宾行为，也会让演练对生产的回读不再是零 | 心跳这条路；它的证据是真机运行后的心跳 |

gh 与 Git for Windows 本身不做替身，按包的前置清单由宿主注入来宾真装（缺一个不建 kit、不开机，来宾不下载）。
kit 的接受文件给角色钉的每个主机工具（`fleetRefs.formalRoles.<角色>.hostTools.<名>`，如 gitleaks 的 `/usr/bin/python3.12`），建 kit 时从暂存的 .deb 里取出该路径核 sha256：凡带这个路径的 .deb 都须是钉住的普通文件，且至少有一个带；否则不建 kit（`DRILL_KIT_HOST_TOOL_NOT_THE_FLEET_PIN:<路径>`、`DRILL_KIT_HOST_TOOL_NOT_IN_THE_DEBS:<路径>`；Fable 裁定 0e418483 §4.1 第 3 步）。核过的结果在 make-drill-kit.mjs 输出的 `hostTools`。
清空 perNodeSteps 也不能得到 PASS_A_FULL。即使 A1–A9 全通过，仍不能勾掉“新节点首装实测一次”或证明服务端接纳。

## 演练的服务端：测试项目，不碰生产

设计：`D:/w/tmp/FABLE-drill-role-probe-20261124.md` PR-3。演练对着测试项目 `clued-auth-test` 装，不对着生产。

- **唯一来源** `drill/drill-server.json`：项目名、地址、公开 key（`sb_publishable_…`，客户端公开值）。key 还没填时不出 kit
  （`DRILL_SERVER_PUBLISHABLE_KEY_NOT_SET`），任何一步都不回落到 Release 里的生产地址。
- **kit 里换什么**：构建器把 Release 的首装 kit 复制一份，只换 `record.supabaseUrl`、`record.publishableKey` 两个字段，逐叶比较多差一个即不出 kit
  （`DRILL_SERVER_STAND_IN_DIFFERS`），地址与 Release 相同也不出（`DRILL_SERVER_IS_PRODUCTION`）。来宾里钉住这份 kit 字节的三处随之换成演练版，都放进 kit 并钉进 `kit.json`：
  首装 SHA256SUMS（只换 kit 那一行）、接受文件（`acceptanceOf(…, DRILL_RESERVED)`，`firstInstallKitSha256` 是演练版的；已接受的版本也用这份保留值文件，上不了 Release）、`release-pins.json`。
  `-From` 目录不改；tar 与 Source 是包自己的（服务端地址不进 Source 哈希）。回执的 `firstInstallKitSha256` 仍是 Release 的（seal 拿它对 Owner 的接受文件），演练版哈希记在回执 `server` 里。
- **开机前**（`Assert-DrillServerReady`）：kit 没有 `server` 即拒（`DRILL_KIT_SERVER_STAND_IN_MISSING`，旧 kit 重做）；`make-drill-kit.mjs --server-of` 再核一遍 kit 与 `-From`
  （`DRILL_KIT_SERVER_NOT_THIS_RELEASE` 等）；演练绑定不在即拒（`DRILL_BINDING_CREDENTIAL_MISSING`），形状不对即拒（`DRILL_BINDING_CREDENTIAL_REFUSED`）。
- **演练绑定**：Owner 在测试项目建一条不带 ci-admission 角色的绑定，交一次：`pwsh -NoProfile -File drill-vm.ps1 -BindingCredential` 弹出 Windows 凭据窗口，
  用户名填连接 id，密码贴 `clued_bnd_` 令牌；存到 `D:\clued-drill\drill-binding.clixml`（DPAPI，仅本 Windows 用户），与来宾管理员凭据同一处、同一个读取函数（`Get-DrillCredential`）。
  每轮经 PowerShell Direct 会话交给来宾写成 `ci-admission.token`，随检查点恢复消失；`public.json` 的绑定 id 与令牌指纹就是这条绑定的。升级令牌与 App 私钥仍在来宾里现造。
- **来宾里断开生产**：入口在装之前核 `-From` 里的首装 kit 指的就是演练服务端（否则 `DRILL_ENTRY_SERVER_IS_PRODUCTION`），把 kit 列出的生产域名写进 hosts
  （`0.0.0.0` 与 `::`），再解析一遍，解析到别的地址即停（`DRILL_ENTRY_PRODUCTION_NOT_CUT_OFF`）。hosts 管到 Windows 进程与按默认设置生成 hosts 的 WSL；容器内的解析不经它，
  那里靠的是来宾里没有任何一份配置写着生产地址。
- **A6**：绑定没有角色，launcher 的角色探测答 `not-held`、首班车 `first-train-not-applicable`、节点 STANDBY；UNCERTAIN（探测被拒或没答上）不算过。

## 两种 kit

- `fleet-node-<v>.first-install-kit.json`：正式 Release 资产，Owner 的 acceptance 以 `firstInstallKitSha256` 接受它。
- `kit/kit.json`：本目录构建器生成的演练封装，合同 `clued.drill.first-install-kit/1`；不能替代前者或产生接受。

## `-From` 布局

一个平铺目录，只有一版资产，不放日志、报告或其他文件：

```text
from/
  fleet-node-<v>.tar
  fleet-node-<v>.release.json
  SHA256SUMS
  fleet-node-<v>.bootstrap.ps1
  fleet-node-<v>.prereq-manifest.json
  fleet-node-<v>.acceptance.json
  fleet-node-<v>.first-install-kit.json
  fleet-node-<v>.first-install.SHA256SUMS
  role-image-<64hex>.tar.gz              # 正式 kit.images.local 中列出的全部本地镜像
```

`SHA256SUMS` 覆盖 tar、release.json、bootstrap 和 prereq-manifest；第二份 sums 覆盖正式 kit 与本地镜像。
`prepareFrom` 从接受的 tar 提取 bootstrap/prereq-manifest，按 publish 的规则生成本地两份 sums；不调用 GitHub，不改 build/final。
bootstrap/prereq-manifest 必须与 tar 内字节一致；tar、正式 kit 必须分别匹配 acceptance 的接受哈希。
`releasePins` 额外绑定整个目录的实际字节；宿主机复制前及 entry 复制后再次校验。

## 构建接口

从仓库根运行，只创建新目录（已有目标会拒绝）。下例是**已接受版本**（`final/` 里有接受文件）：

```powershell
$v = '2026.11.17-bdf52173'
$builder = 'work/independent-ci-resident-v1/drill/make-drill-kit.mjs'
$from = Join-Path $env:TEMP 'drill-from-20261117-review'
$kit = Join-Path $env:TEMP 'drill-kit-20261117-review'
node $builder --version $v --build D:/w/tmp/fleet-node-2026.11.17-bdf52173/build --final D:/w/tmp/fleet-node-2026.11.17-bdf52173/final --images D:/w/tmp/role-image-export-20261117b --out $from
if ($LASTEXITCODE) { throw 'Release 目录组装失败' }
node $builder --version $v --from $from --prereq D:/clued-drill/prereq/prereq.json --out $kit
if ($LASTEXITCODE) { throw '演练 kit 构建失败' }
```

**候选**（接受之前）：`final/` 就是 `publish.mjs prepare` 的 `--out`（里面没有接受文件），构建 kit 时多给接受请求：

```powershell
$v = '2026.11.20-0123abcd'                                   # 候选的版本
$builder = 'work/independent-ci-resident-v1/drill/make-drill-kit.mjs'
$build = 'D:/w/tmp/fleet-node-2026.11.20-0123abcd/build'     # 构建输出
$prepared = 'D:/w/tmp/fleet-node-2026.11.20-0123abcd/accept' # publish.mjs prepare 的 --out：kit、镜像、接受请求，没有接受文件
$images = 'D:/w/tmp/role-image-export-20261120'              # 镜像目录（prepare 的 --out 已含镜像时可直接用它）
$candFrom = Join-Path $env:TEMP 'drill-from-20261120-candidate'  # 新目录，不能已存在
$candKit = Join-Path $env:TEMP 'drill-kit-20261120-candidate'    # 新目录，不能已存在
$request = Join-Path $prepared "fleet-node-$v.acceptance-request.json"
node $builder --version $v --build $build --final $prepared --images $images --out $candFrom
if ($LASTEXITCODE) { throw '候选 Release 目录组装失败' }
node $builder --version $v --from $candFrom --prereq D:/clued-drill/prereq/prereq.json --request $request --out $candKit
if ($LASTEXITCODE) { throw '候选演练 kit 构建失败' }
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Version $v -From $candFrom -Kit $candKit -Ladder
```

候选演练默认跑 A8 并要求它为真；跳过 A8 只能显式带 `-SkipReinstall`（不是默认，Fable 裁定补“候选跳过 A8”）。候选回执的 A1–A7 必须逐项为真，A8 为真或被显式跳过，其他情况都是 `FAIL`。跳过了 A8 的候选，回读后最好只能得到 `PASS_A_REINSTALL_NOT_DRILLED`，A8 的 detail 写“同包重装未演练”；这个值原样写进索引的演练格，永远不会是另外两种 PASS。

演练 kit 平铺存放 `first-install-entry.ps1`、`guest-failure-files.json`（入口失败快照可读的来宾文件清单）、`release-pins.json`、WSL MSI、Ubuntu rootfs、全部 .deb 和 `kit.json`。
除 `kit.json` 自身外，每个文件都在 `files` 中钉 sha256。prereq.json 按原始字节绑定；其 WSL/rootfs/debs 与正式
prereq-manifest 的文件名、sha256、字节数相符才拷入。Node/Python/Git/runner/Linux Node 的正式前置仍由 bootstrap 的
已钉清单取得；本构建器不联网。

`prerequisiteMode=first-install-host` 让完整演练从 S0 把发行版、Docker 和账户交给正式主机准备，不提前导入同名发行版。
旧 kit 仍支持预注入来宾前置条件。`perNodeSteps` 明确列出三处绕过。

guest 路径固定映射为 `C:\drill\{from,kit,fake,work}`。fake 是 VM 内现生成的凭据文件，不是假服务；没有生产授权，
不提供心跳令牌。entry 的最后一行只输出 `{status,stopCode,tree,node}`；只有 `FIRST_INSTALL_DONE`、exit 0、无 stopCode
才可通过 A1。tree 应指向包含 `work/independent-ci-resident-v1` 的 `tree`，node 应是该正式运行时的 node.exe，供 A8 使用。

Owner 批准后，DESK 在可用 Hyper-V 与 pwsh 的宿主机运行 A 档：

```powershell
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Version $v -From $from -Kit $kit -Ladder
```

**梯度模式是演练的默认跑法**（`-Ladder`，协调方 Owner 11-23：“先把每段结论传回来，再慢慢梯度测试，把黑盒逐步切成明盒”）。整轮限时由代码推出，不靠人记：脚本在 `D:\clued-drill\runs` 下按目录名（`<UTC 开始>-<version>-<id>`）只看本 version 的运行目录，取同一 kit sha256 最近一次的回执，读它的 `evidence.stageTimeline` 定本轮限时（`Get-DrillLadderStep`）。没有 `receipt.json` 的目录跳过；本 version 的 `receipt.json` 读不出或缺 `version`/`kitSha256` 时拒绝开跑（`DRILL_LADDER_PREVIOUS_RECEIPT_UNREADABLE`，带路径），不越过它去用更早的回执：

| 上一轮 | 本轮 |
| --- | --- |
| 没有 | 10 分钟（`LadderFirstMinutes`） |
| 通过（无 failure，结论不是 FAIL） | 与上轮相同，不加长（不超过整轮上限） |
| 停在无进展门槛（`DRILL_GUEST_NO_PROGRESS`） | 拒绝开跑：`DRILL_LADDER_PREVIOUS_NO_PROGRESS`，带卡住的阶段与原因 |
| 时间线里有阶段失败 | 拒绝开跑：`DRILL_LADDER_PREVIOUS_STAGE_FAILED`，带阶段名与码，先修再跑 |
| 整轮超时（`DRILL_RUN_TIMEOUT`，前台自停或宿主看门狗报出都算），且上轮限时已到整轮上限（70 分钟） | 拒绝开跑：`DRILL_LADDER_CEILING_EXHAUSTED`，带上轮停在哪一段（`stage`，取时间线的 `abortedIn`，没有则取最后一段）、`reached`、`previousMinutes`、`ceiling` 与回执路径。上限档再跑一轮结果一样（第 16 代 2026.11.24-74bc5ef0：70 分钟在 launcher 段超时，旧规则下一档仍是 70 分钟）；先修，换包后梯度从头算 |
| 整轮超时（`DRILL_RUN_TIMEOUT`，前台自停或宿主看门狗报出都算），上轮限时未到上限，时间线无失败段、各段结论都是已知值 | 翻倍（10→20→40→70），封顶为整轮上限 70 分钟（保持预算 120 − 等待 40 − 余量 10）；超时落在段内、段间、首装完成后的 A7/A8，或旧 kit 只有阶段日志，都翻倍 |
| 其他结局（守护因内存等中止、某步自身超时等） | 与上轮相同，不加长（不超过整轮上限） |

拒绝发生在申请暂停接新和开机之前。本轮回执写 `runTimeoutMinutes`，以及 `ladder`：`minutes`、`rule`、`basis`（依据的那份回执路径）、`previousMinutes`、`reached`（上一轮走到的那段及其结论）、`ceiling`。显式给 `-RunTimeoutMinutes` 时不推导，`ladder` 为空。

不带 `-Ladder` 时整轮限时默认 70 分钟，包含来宾开机、A 档步骤及观测采集，可用 `-RunTimeoutMinutes` 指定。当班时须已有
`S0-clean-os`，脚本通过已安装代次的 `rearm-tool.mjs` 申请 `drill` 暂停接新，最多等 40 分钟让在跑批次结束。
保持预算为 40 分钟加整轮限时再加 10 分钟，超过 120 分钟会拒绝开机。开机前和运行中均检查宿主状态与内存。
来宾按同一截止时间自关机，重启后沿用截止时间。脚本确认关机并还原检查点后请求恢复接新，未确认时保持到期自解。

**早停与取证（Fable 规划 87d330d0 甲，`D:/w/tmp/PLAN-drill-loop-root-20261123.md` §2.2、§2.4）**：

- 前台期限：前台在守护期限之前留出取证窗口就停（`DRILL_RUN_TIMEOUT`，`detail.by = foreground`，带 `deadline` 与 `evidenceWindowMinutes`）。窗口为整轮限时的 30%，最多 5 分钟，最少 1 分钟（`Get-DrillEvidenceWindowMinutes`）；10 分钟一轮的窗口是 3 分钟，前台在开机后第 7 分钟停。停下后照常先取证，再由本轮自己的收尾还原，守护不会抢先还原。
- 分拍等待：客机长步骤每 30 秒一拍（`GuestTickSeconds`），每拍先问守护、再判期限。首装每拍把 `first-install.stdout.log`（存为 `first-install.log`）、`stage-progress.jsonl`、`host.stdout.log`、`prepare.stdout.log`、`launcher.stdout.log` 拉回运行目录，只在长度变化时写入；单次拉取限时 20 秒，拉不到只计数（`failedPulls`、`consecutiveFailedPulls`、`pullFailingSince`），不算“无增长”：门槛只在拉取有回应的那一拍判；拉取超时的作业不同步等待，异步停止后再移除。这样守护在任何时刻中止，运行目录里都留着最后一拍的副本。每拍的阶段与门槛状态写在 `guest-progress.json`，回执带在 `evidence.guestProgress`。
- 无进展门槛（`ProgressGates`）：当前阶段取最新一个已出现日志的阶段，顺序为入口、host、prepare、launcher。入口段 15 分钟内未出现 `host.stdout.log` 就停（`host-log-not-started`）；host 段日志 10 分钟不增长（`stalled`）或在该段满 30 分钟（`stage-over-limit`）就停；prepare 段满 6 分钟就停；launcher 段日志 10 分钟不增长或在该段满 25 分钟就停（任务 87d330d0 PR-2：两个值在 launcher 不写步骤开始行时也成立——已见最长的无输出步骤是 linux-B 约 222 秒，换账户一步最长 8 分钟，修好后整段约 17 分钟；第 16 代 first-train 无输出 1505 秒，原来只靠整轮期限才停）。门槛触发统一报 `DRILL_GUEST_NO_PROGRESS`，`detail` 带 `stage`、`reason`、`limitMinutes`、`stageSeconds`、`sinceGrowthSeconds`、`lastGrowthAt`。前台期限先于门槛判定，所以短时限一轮不会被门槛误判。
- 首装之后的上限：读状态、A7 重启与 A8 共用一个上限，取“首装结束后 20 分钟”（`AfterEntryMaxMinutes`）与前台期限中较早的一个，超出报 `DRILL_AFTER_ENTRY_TIMEOUT`。取证、晚探针与 M5 不受此上限约束。
- A1 阻断：首装没有以 `FIRST_INSTALL_DONE` 结束（退出码非 0、带停止码、或结果读不出）时，不重启、不跑 A8、不读 M5。三者分别记为 `DRILL_A7_BLOCKED_BY_A1`（若什么都没装上，仍记 `DRILL_A7_BLOCKED_NOTHING_INSTALLED`）、`upgradeStatus = DRILL_A8_BLOCKED_BY_A1`、`DRILL_M5_BLOCKED_BY_A1`。装后读取与两次探针照跑。
- 明盒：入口每进入、每结束一个阶段，就当场往来宾工作目录的 `stage-progress.jsonl` 追加一行（`stage`、`event`、`startedAt`、`endedAt`、`result`、`code`、`tail`，其中 `tail` 为该段日志最后 5 行）。阶段依次为 assets、prereq、unpack、check、host-inputs（check 判定后到 host 之前的本地拷贝、凭据目录与第二次解包）、host、prepare、wsl-cold-start、launcher；每段在自己的判定之后才记结束，停止码记在停下的那一段，万一没有打开的段则单记一行 `between-stages`。prereq 段内每个 item/deb 的每一步（`sha`、`copy`、`get`、`expand`，最后 `tools:find`）各记开始、结束两行（`event` 为 `step-start`/`step-end`，带 `item`、`step`、`bytes`），时间线在该段下列 `steps`，段被中止时 `inProgressStep` 指出卡在哪个 item 的哪一步。写不进就跳过，不影响首装。host 段：包里的 `first-install-host.ps1` 带 `-StepProgress` 参数时（入口探测到才传，bootstrap.ps1 不传），每个 `Enter-Step` 开始、每步结束也往同一个 `stage-progress.jsonl` 各写一行，时间线 host 段列 `steps`，被中止时 `inProgressStep` 给出进行中的子步骤名和开始时刻；旧包的 host 没有这个参数，被中止的 host/prepare/launcher 段给 `lastStepLine`（运行目录里该段日志最后一条步骤行的名字、结论和时刻）。宿主自己的步骤（入口前的 copy-in，入口后的 read-after-install、A7-reboot、A8-reinstall）开始、结束写在运行目录的 `host-steps.jsonl`，开始了没写出结果的记为进行中被中止。宿主每拍拉回这个文件，取证时再取一次。无论结局如何，回执的 `evidence.stageTimeline` 都列出走到第几段和每段结论：`ok`、`failed` 带码，或 `aborted-in-progress`（进行中被中止）。之后接 A1 结果、装后读取、A7、A8 各自的记录。kit 的入口若不写这个文件，就按运行目录里已有的阶段日志列出，此时 `source` 为 `stage-logs`。

M5 对每个包都收集、都判定（Fable 11-19 裁定 §2.2：没有“不评估也算数”的出口）。完成 A 档步骤后，`m5/` 保存来宾已生成的公开观测，宿主的 `test/renewal-drill.mjs` 核验齐备的七份文件（六份公开观测，加来宾管理员对连接记录在不在的实读 `record.json`）。
回执记录 `m5.result`：核验通过为 `PASS`，观测缺失（包里没有续期组件也是这一种）、核验器缺失或核验失败为 `FAIL`；`NOT_EVALUATED` 只出现在中途已失败的回执里。
回执 `conclusion` 只有在 `m5.result` 为 `PASS` 时才可能不是 `FAIL`；`-Finalize` 同样按回执里的 `m5` 判，旧回执没有 `m5` 即 `FAIL`。
回读（`-Finalize`）之前结论为 `PENDING_PRODUCTION_READBACK`；回读之后只有 `PASS_A_FULL`、`PASS_A_PER_NODE_STEPS_REMAIN`、`PASS_A_REINSTALL_NOT_DRILLED`（仅候选跳过 A8）三种 PASS，
正是 `publish.mjs seal --drill-receipt` 收的集合（定义在 `publish.mjs`，测试核两边一致）。

**候选的顺序：演练 → `-Finalize` → Owner 接受 → seal**（Fable 11-19 续期密钥裁定 §4.3）。候选回执在接受之前就定稿：
- A5 在来宾侧一次判完（本机 Source 等于请求里的 Source），没有生产半边；`-Finalize` 对候选回执只判 A9（演练有没有碰生产库）。
  原来的生产半边防的是“演练的包不是生产在跑的包”，已由 seal 核回执三项哈希、节点只装已接受的 Release 并自己重算 Source 保证。
- 演练一结束就回读 A9。从开机到回读这一段不与任何节点的升级、续期窗口重叠（否则 A9 非零；非零照旧要看，不许忽略）。
- 接受之后不开机，也不再跑 `-Finalize`；seal 用的就是回读后的终稿。
- 已接受版本的重新演练（非候选）不变：A5 等 `-Finalize` 的生产半边。
## 候选形态：先演练、再接受

Fable 11-19 裁定 §2.3：候选 → 演练 PASS → Owner 接受一次。`-From` 里**没有** `fleet-node-<v>.acceptance.json` 即为候选
（`prepareFrom` 在 `final/` 没有接受文件时照样组装；`final/` 就是 `publish.mjs prepare` 的 `--out`）。构建 kit 时多给一个
`--request <prepare 的 --out>\fleet-node-<v>.acceptance-request.json`（候选必需，已接受的版本给了即拒绝）：

- 来宾用的接受文件 = 接受请求经 `publish.mjs` 的 `acceptanceOf(request, DRILL_RESERVED)` 生成；保留值与生成函数只在 `publish.mjs` 定义。
  三项哈希（tar、`first-install-kit.json`、Source）与 fleetRefs 都是请求里的，即 Owner 要接受的那几项；请求的 tar 与 kit 必须就是 `-From` 里的字节
  （`DRILL_CANDIDATE_REQUEST_NOT_THIS_PACKAGE`）。Source 由 prepare 用 `sourceHashOf` 算，来宾的 `install.mjs prepare` 重算，不同即拒。
- 这份文件放进 kit，钉进 `kit.json` 与 `release-pins.json`。`seal` 与挂接受文件的入口见到保留值即拒绝，所以它上不了 Release；
  `-From` 里出现指名保留值的接受文件，构建器也拒绝（`DRILL_ACCEPTANCE_IS_A_CANDIDATES`）。
- `kit.json` 的 `candidate` 记下这份文件名与三项哈希；`drill-vm.ps1` 用它代替 `-From` 的接受文件，核三项哈希一致，`-From` 里另有接受文件则拒绝
  （`DRILL_CANDIDATE_KIT_BUT_FROM_HAS_AN_ACCEPTANCE`）。
- 来宾里跑的仍是包内原样的安装代码，没有任何“演练模式”分支。回执写 `candidate: true` 与 `tarSha256`、`ciSourceManifestSha256`、`firstInstallKitSha256`，正是 `seal --drill-receipt` 核的三项；回读后的终稿才摆给 Owner。

来宾关机计时器就绪前，由不在任何 Windows 作业里的看门进程负责兜底：它经 WMI（`Win32_Process.Create`）拉起，不继承拉起方（例如代理会话）的作业。拉起后确认它仍在某个作业里时，脚本拒绝开机。
来宾取证在首装的正常结束、失败、超时三种结局之后、对来宾做任何别的事之前执行（首装调用的 finally），所以这三种结局下都在还原检查点之前：
取回入口打印的每一行（入口运行时同步写到来宾 `C:\drill\work\first-install.stdout.log`，超时也留得下），以及阶段文件——
三份完整阶段日志 `host.stdout.log`、`prepare.stdout.log`、`launcher.stdout.log`（由入口逐行写出；启动器的阶段输出文件就是 `launcher.stdout.log`）
和 `host-result.json`、`launcher-result.json`、`wsl-cold-start.json`、`stage-timings.json`。阶段文件在来宾里逐个以读写共享方式读取（写端仍开着也能读），逐个存回运行目录，
每个文件的结局记在 `stage-files.json`；不取任何凭据文件。
`wsl-cold-start.json`：入口在 launcher 段之前对来宾 `wsl --shutdown`（失败即以 `DRILL_WSL_SHUTDOWN_FAILED` 停），再读 `wsl --list --running`，两次的原始应答（exit、stdout、stderr）原样记下、不判；与两份阶段结果一起存进 `stage-evidence.json`（Fable 裁定 0e418483 §4.2：每轮固定走冷启动）。取证失败只记录（`guest-evidence.json`、`stage-files.json`），不挡还原，也不替换本轮自己的失败码。
只读来宾探针（Fable 裁定 0e418483 §4.3）：所有必需证据（阶段文件、首装日志的来宾副本、启动器结果回读）取完并写下 `guest-evidence.json` 之后、还原检查点之前，在来宾里（外层超时 5 分钟）对 `CluedResident-Linux` 以 root 逐条跑只读命令一次；取必需证据时来宾不可达，就不再跑探针（记 `DRILL_PROBE_SKIPPED_COLLECTION_FAILED`）。单条命令最长 30 秒，有两条命令超时后不再起新命令（记 `PROBE_STOPPED_AFTER_TIMEOUTS`，来宾内不读时钟）；docker 命令排最后，docker 卡在 activating 也不拖走文件与 systemd 读数；每条结果完成即追加到来宾 `C:\drill\work\guest-probe-<main|late>.jsonl`，外层超时切断时宿主把已落盘的部分读回（`partial: true`，`probe.code` 记 `DRILL_GUEST_STEP_TIMEOUT`）。读数——`docker info` 的 `Driver` 与 `DriverStatus`、`docker image ls --no-trunc --digests`、kit 里每个本地镜像（`images.local[].id`，按 `sha256:<id>` 引用）的 `docker image inspect` 的 `.Id` 与 `RepoDigests`、清单里每个文件的 `sha256sum` 与所属包版本（`dpkg-query`）、`systemctl --failed`；原始应答（exit、stdout、stderr，或无法作答的原因）原样存进 `stage-evidence.json` 的 `guest-probe`（没有任何阶段结果时不凭空建该文件，单独存为 `guest-probe.json`，`probe.state` 为 `saved-apart`），不判。文件清单只有一处：`drill/guest-probe-files.json`（`/usr/bin/python3.12` 必在；其余照离线清点里记为“要来宾读数”的文件逐行加）。探针失败、清单读不出、来宾无应答，都只记入 `stage-files.json` 的 `probe`（`state: not-run` 与 `code`），不挡取证、不挡还原、不替换本轮自己的失败码。
回执 A1 下的 `firstInstallSteps` 只从完整日志解析（阶段结果文件只取判决行）：各阶段的逐步结果行、最后完成的一步、首个被拒的一步、判决行；
阶段已运行却缺日志、空日志、只有判决行、被截断、或后续阶段已抵达而它毫无证据，记 `incomplete`；一行也解析不到记 `missing`。A1 要求两者都不是。
本轮在首装之后中断时，A1 由首装自己的结果（`entry-result.json`）单独形成。本轮没有判决就结束时（无 A1），记录在 `evidence.firstInstallSteps`。

回执 `evidence.hostExecutorStates` 记录开机门和运行中守护采样的执行器状态、原因、阶段编号和相位，每种组合只保留首次观测的 UTC 时刻。
开机前门两侧都看 `Runner.Worker`，**开机门只看内存，作业只记录**（Fable 规划 0e418483“演练开机门只看内存”，2026-11-23；此前“补：演练开机门与列车争 DESK”的有作业加 10.4 GB 一档已删）：开机门＝15 GB（生产余量 6＋来宾 8＋余量 1）＋ runner 发行版 `/proc/meminfo` 的 MemFree（生产 WSL 开机后还能再拿走的内存，按已占用记账：Fable 规划 87d330d0）；登记了但没在跑的 runner 发行版改记 Owner 的 `%USERPROFILE%\.wslconfig` 里 `[wsl2]` 节 `memory=` 的值（只认 `<数字>GB`/`<数字>MB`，向上取整；没有文件、没有这个键或解析不了都算读不到），本机没登记 runner 发行版记 0；几个发行版取最大（共用一台 VM，不相加）；读不到就拒绝开机，`DRILL_HOST_RESOURCE_UNREADABLE`。`requiredBasis.wslHeadroomSource` 记来源：`memfree`、`wslconfig-cap` 或 `none`，两侧有无作业、作业查询失败与否都一样，作业只写进记录（`busyWith`、`runnerJob`、`wslJobs`），不拒绝开机、不抬门槛；开机之后才来的作业由运行中的门兜底，运行中的 6 GB 门不变。**开机前等内存**（`Wait-DrillBootMemory`，完整演练与 `-PrereqOnly`；`-BaselineOnly` 不等）：拿到演练互斥锁后、读执勤状态和申请任何保持之前（不请求 intake、不起看门狗、不动 VM），按单调时钟每 `BootWaitPollSeconds`（120 秒）读一次宿主可用内存和 runner 发行版的内存（`Get-DrillWslMemory`），够开机门就往下走；最多等 `BootWaitMinutes`（60 分钟），超时 `DRILL_HOST_MEMORY_SHORT`、不开机；宿主内存读不出来就不再等，交给开机门自己读、自己判；runner 发行版的内存读失败（独立审查 29ed7255c 中级 A）只算这一拍不够、继续等，记次数与最后一次的原因码，到期时最后一拍仍读不到就 `DRILL_HOST_RESOURCE_UNREADABLE`、不开机。每次读数计入回执 `evidence.hostPreBoot.wait`（`samples` 次数、`firstAt`/`lastAt` 首末时刻、`firstFreeGB`/`lastFreeGB` 首末可用内存、`requiredFreeGB`（最后一次读全的那一拍）、`ok`、`unreadable`（宿主内存）、`wslUnreadSamples`、`wslUnreadable`），超时拒绝的输出在 `detail.wait` 带同一份。等到之后，开机门照旧在开机前再判一次。**运行期释放**（Decision f572ac5b）：演练机开着、宿主可用内存低于 10 GB（且不低于 6 GB 中止线）时，运行期守护对 runner 发行版释放文件缓存，**有作业也放**；命令是写死的单引号字面量 `DrillWslReleaseCommand`，只有 `sync` 与 `echo 1 > /proc/sys/vm/drop_caches`（失败以 5 退出），不问作业、不读 Windows 进程表；只由 `drill-vm.ps1` 的运行期守护执行，按单调时钟至少隔 120 秒（失败也算一次），一次释放的全部 WSL 调用共用 20 秒预算；未武装（还没开机）不放，正好 10.0 GB 不放；失败、超时只记录，不中止、不重试，中止只看 6 GB 线。超时只结束 Windows 侧的 wsl.exe，发行版里的 `sync` 和写入可能仍会做完，所以记为失败不等于没放。每次释放记一行 `cacheReleases`（`at`、`freeBeforeGB`、`exit`、`freeAfterGB` 即下一拍读数、`failed`），写在本轮目录的 `host-guard.json`（正常跑完的一轮也写，中止记录同样带）；`receipt.json` 不带这一项。10 GB 与 6 GB 两个数的出处是 `docs/maintenance/runner-configuration-and-operations.md:60-61`（workstation 档的恢复线与暂停线），不另抄别的数。门的数只由脚本算：开机门记录（回执与拒绝输出的 `hostPreBoot.bootGate`）带 `requiredFreeGB` 与 `requiredBasis`（来宾、开机余量、生产余量、`wslHeadroomGB` 与其来源 `wslHeadroomSource`），派活不另写内存数字，开机前置就是脚本的开机门放行；“演练开机时本机套件不超过 1”仍是独立的操作规则，不并进内存门。两侧是：Windows 的进程表，以及本机 Linux runner 所在的 WSL 发行版（`scripts/ci/self-hosted/node-profiles.json` 按主机名取 `linux_runner`/`additional_linux_runners` 的 `distro`；主机不在其中、或 runner 发行版不是本账户已注册的发行版，都算查询失败，只记录）。WSL 一侧只认退出码（Fable 裁定“补：分支一第四轮”；这说的是作业判定；下面 `wslMemory` 的 MemFree 只进开机门的内存账，不参与作业判定）。**运行列表**是唯一还读输出的地方：`wsl --list --running --quiet` 须零退出、stderr 为空；按行切（CRLF 或 LF），只丢长度为零的行，其余每一行须整行、不修剪地等于本账户已注册的某个发行版名（HKCU Lxss 下各 DistributionName，只读），有一行不符即整次算查询失败（只记录）。发行版不在其中就判无作业，不对它发任何命令。**查进程**：在运行的发行版里执行 `pgrep -ix Runner[.]Worker`（模式常量 `WslJobPattern`，点是字面点；开机前的空闲释放命令逐字带同一模式），标准输出不读；封闭表：退出 0 且 stderr 为空＝有作业（`busyWith` = `WSL_ACTIONS_RUNNER_JOB`）；退出 1 且 stderr 为空＝无作业；其他任何退出码、stderr 非空、超时（只结束本次拉起的客户端进程）＝查询失败（`busyWith` = `WSL_UNREADABLE`，原因记在 `wslUnreadable`）。每次开机前三段，各自采样（Fable 裁定“补：WSL 门竞态”，顺序不变）：**早拒**（保持生效、常驻空闲；两侧作业只采样不拒绝；不读内存）→ **释放**（只在早拒采样两侧都无作业时做，否则记 `skipped.where = early` 跳过；对每个 runner 发行版，先重读运行列表，再在调用前一刻重读 Windows 进程表；不在运行就不发命令；在运行则以 root 用 `sh -c` 执行写死的单引号命令 `DrillWslIdleReleaseCommand`（运行时按本文件语法树核对两条释放命令都未被改动、无双引号与反斜杠，且这一条去掉开头的作业查询后与运行期那条逐字相同）：同一个 `pgrep -ix 'Runner[.]Worker'`，退出 0 即有作业，以 3 退出跳过；查找出错以 4 退出；只有“没找到”才 `sync` 并只丢页缓存 `echo 1 > /proc/sys/vm/drop_caches`，失败以 5 退出，成功以 0 退出。宿主只看退出码：0＝已释放，3＝已跳过，其余＝释放失败；跳过与失败都不算演练失败。开机前只在空闲时放：演练机还没开，不在 Decision f572ac5b 的“有作业也放”之内，按其原文“空闲时的原有许可照旧”）→ **开机门**（两侧再查一次、只记录，然后内存门，只判这一次，然后开机）。**`wslMemory`**（Fable 裁定 0e418483 及其“补：实现后三问”§1）：runner 发行版的 `memTotalGB`、`memFreeGB`、`cachedGB`、`anonPagesGB`（读 `/proc/meminfo`）与 `runnerWorkers`（`pgrep -cix` 数 `Runner.Worker`；只作证据，数不出来记 null、不算读失败，不挡开机，独立审查 29ed7255c 中级 C），同一个读取函数 `Get-DrillWslMemory`、同形，两份：开机门样本一份（`hostPreBoot.bootGate.wslMemory`，在开机门判定之前、锁外读），因内存中止时一份（`host-guard.json` 的 `wslMemory`，关机之后读，不推后关机）；两份直接相减就是 WSL 从开机到中止涨了多少、涨在缓存还是匿名内存。只读，只问已在运行的发行版；meminfo 读不全或超时就不带这个键：开机门那份读不到即拒绝开机（`wslHeadroomGB` 为 null，原因码记在 `hostPreBoot.bootGate.wslMemoryUnreadable`），中止那份读不到则中止与还原照旧。运行期样本不读作业，也不再写没读过的作业字段（`runnerJob`、`busyWith`、`wslJobs`、`wslRunnerDistributions` 等）。开机前的守护、入口处与还原后的宿主检查只看执勤与保持，三段之外不另取样。基线建成或失败时三段数据都写进 `baseline.json`（`hostPreBoot`）。开机前等内存的记录与三段各自的时间与结果记在回执 `evidence.hostPreBoot`（`wait`、`early`、`release`、`bootGate`，后者含 `runnerJob` 与 `requiredFreeGB`；没等过时 `wait` 为 null）。回执另有 `evidence.hostMemory`，只记原始事实：开机前可用（`beforeBootFreeGB`）与所需档位（`requiredFreeGB`）；开机时两侧 runner 作业（`runnerJobAtBoot`，按此优先：`yes` 任一侧确认有作业——另一侧没读出来也是 `yes`；`unknown` 没有确认的作业、但至少一侧没读出来——不算有作业；`no` 两侧都读到且都没有；`null` 没采过作业样本，例如状态门在读作业之前就拒绝了；`runnerJobBefore` 是开机门看到的那一项）；来宾起来后守护第一次读数（`afterBootFreeGB`）、运行中最低值（`minRunningFreeGB`）与整轮最低值（`lowestFreeGB`，含开机门读数）。各步骤的原始结果与原始拒绝码照旧各记各的（A1 的首装逐步记录、`failure`、各项 detail），互不遮挡；A8 的通用升级单独一步，它的原始结果（退出码、status、code、输出原文）在下一条命令开始之前就由宿主写进 `reinstall-upgrade.json`，回执带在 `evidence.reinstallUpgrade`，后面的准备即便失败或超时也不丢；工具不对超时做任何归类。这些读数只作证据，开机门不用它们。

**操作规则：某一步超时、且开机时宿主有 runner 作业（`runnerJobAtBoot = yes`）**——先换个时段复跑一次，再判断是不是包的问题；复跑仍在同一步超时，就按包的缺陷处理（Fable 裁定“补：争用标签止损”）。这条由读回执的人执行，不在代码里。

“取证在还原之前”对正常结束、失败、超时（含前台期限）与无进展停都成立。运行中守护触发的紧急还原（`host-guard.json` 为 `DRILL_ABORTED`，例如内存中止）仍可能先于取证，此时运行目录里留有最后一拍拉回的日志，`evidence` 记为部分已取。
这时回执 `evidence.guardEmergencyRestore` 如实写结局：已还原、还原失败或结局未记下；证据未取、已取或部分已取（按运行目录里实有的文件），
例如“由守护紧急还原，证据未取”。开机看门进程在拉起方消失后还原时没有回执，它把同样的结局记在运行目录的 `guest-shutdown.outcome.json`
（它只在来宾计时器就绪前、首装第一步之前动手，所以证据总是未取）；拉起方仍在时，回执的 `evidence.watchdogRestore` 原样带上这份记录。

本次未启动/修改 Hyper-V；A1–A10 实机结果、重启、再装、A5/A9 生产只读核验均由 DESK 另做。

## 交互原入口模式

**当前拒绝启动**（`DRILL_INTERACTIVE_STEP_RECORD_NOT_CONNECTED`，开机前）。A1 的逐步记录**解析器只有一个**（`Read-DrillFirstInstallSteps`），
**来源随模式不同**：无人值守是来宾入口接到的各阶段完整标准输出；交互模式下宿主准备与启动器作为提权阶段在另一个窗口运行，逐步行不回到操作者的窗口，
只进包的两个提权阶段输出文件（`elevated-host-*.txt`、`elevated-launcher-*.txt`），以后就用这两个文件。这条接线归**演练分支三**
（在包的阶段输出逐行落盘合入之后做）；接上之前交互模式不开机。下面是接上之后的流程。

DESK 先在普通窗口执行 Fable 的弹窗预检（本轮未执行）：

```powershell
powershell -NoProfile -NonInteractive -Command "Get-Credential -UserName x -Message y"
```

若直接报错而不弹窗，停止 A/交互排期并向 Owner 报告接受版弹窗路径问题；弹窗则关闭后继续。

A 档实测全绿后，经 Owner 批准再运行（独立还原 S0）：

```powershell
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Version $v -From $from -Kit $kit -Interactive -InteractiveTimeoutMinutes 120 -RunTimeoutMinutes 180
```

该模式不经 entry，也不提前安装发行版。脚本拷入同一资产，在 VM 内生成全新假凭据，以安全输入让 Owner 设置本次 drill
登录口令（不回显、不落盘、不写日志），打开 vmconnect。Owner 用 drill 登录，在**普通 PowerShell**里运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\drill\from\fleet-node-2026.11.17-bdf52173.bootstrap.ps1 -From C:\drill\from
```

按原生 UAC/凭据窗口完成流程；若要求重启，交互登录后运行同一命令。假私钥与两个令牌从 VM 内 C:\drill\fake
取用，公开值见该目录 public.json；心跳令牌留空并点确定。不要把口令或令牌贴进聊天、命令参数、宿主日志或仓库。

关闭凭据窗口后，只截取安装结局，把 PNG 保存为 C:\drill\work\interactive-screen.png，然后在 VM 执行：

```powershell
New-Item C:\drill\work\interactive.done -ItemType File
```

脚本限时等这个完成信号（默认 120 分钟，范围 5–240），仍受整轮限时约束。上例的预算需要宿主待命。
没有信号就超时失败并还原。信号本身不构成成功证据。
A1 来自 VM 内 C:\ProgramData\CluedBootstrap\<guid>\elevated-launcher-*.txt 的最后一个 JSON，由接受版
Get-LauncherVerdict 判定，要求唯一结果文件、有效 PNG 截图、tree/node 路径。证据复制到宿主本次 runs 目录后，继续
现有验收、A7 无登录重启和 A8 再装，最后关闭 VM 并还原 S0。临时登录口令随还原失效，不改宿主 DPAPI 基线凭据文件。

这仍使用假凭据，不能证明服务端登记、心跳接纳或 STANDBY。为防把适配 kit 冒充完整首装，本封装在交互模式仍保留 A10
限制；原入口证据单独记录于 interactive-launcher.json 和 interactive-screen.png，供 DESK/Owner 审核。

## 回执和时间

A 档在 guest 的 work/stage-timings.json 记录 host、prepare、launcher 实测秒数；未运行阶段为 null。
host 之前另记 assets、prereq、unpack、check 四段（r9 后续）。

首装结局不是 `FIRST_INSTALL_DONE` 时，入口在来宾写 `work/resident-failure-snapshot.json`：按 `guest-failure-files.json` 读来宾文件（只读 .json，单个 64 KiB、合计 1 MiB，清单或通配碰到 secrets、credentials 目录即拒或跳过），加 Service Control Manager 自入口开始以来的事件（至多 50 条、每条 300 字）。它随阶段文件原样回到运行目录，A1 的 detail 带上 HALT 的 code、failureCode、engineError。

因内存不足中止时，host-guard.json 加记工作集最大的 10 个进程（topProcesses）。
宿主回执 evidence.stageTimingsSeconds 同时记录这些值，stage-evidence.json 保存 host/launcher 终态与来源。
bootstrapException 标明 README §5 例外，entryMode 区分适配和交互模式。交互模式的分段时间不作推算。
本次只实现并做离线验证，没有 VM 实测秒数。

回读由 DESK 用回执内 productionReadbackSql 取得只读结果，写到本次 runs 目录的 readback.json，随后运行下面的命令。候选回执只判 A9（演练一结束就做）；已接受版本的重新演练判 A5 生产半边与 A9：

```powershell
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Finalize <本次receipt.json> -ProductionReadback <本次readback.json>
```

离线测试只用仓库入口：

```powershell
node scripts/ci/ci-required-selection.mjs --run resident-node --root D:/w/tmp/drill-kit
```
