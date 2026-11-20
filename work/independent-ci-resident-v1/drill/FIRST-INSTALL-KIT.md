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
| `C:\drill\fake\companion-github.token`（`ghp_CLUEDDRILLFAKE…`，来宾里生成、来宾里读；仅当被演练的包在必需组或可选组列出它时生成并交付，kit 同时登记这一步） | Owner 在凭据窗口给的陪伴 GitHub 经典令牌 | 演练不得使用真凭据 | 令牌被 GitHub 接受；陪伴访问 GitHub 的各个通道 | 不可删；没验到的部分由真机首装后的运行状态承担 |

按设计不给的可选凭据：

| 名字 | 决定 | 理由 | 因此没验到 |
|---|---|---|---|
| `ci-node-heartbeat.token` | 按设计不给（不造假心跳令牌） | 假令牌会让来宾的常驻向生产心跳端点发请求，既改变来宾行为，也会让演练对生产的回读不再是零 | 心跳这条路；它的证据是真机运行后的心跳 |

gh 与 Git for Windows 本身不做替身，按包的前置清单由宿主注入来宾真装（缺一个不建 kit、不开机，来宾不下载）。
清空 perNodeSteps 也不能得到 PASS_A_FULL。即使 A1–A9 全通过，仍不能勾掉“新节点首装实测一次”或证明服务端接纳。

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
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Version $v -From $candFrom -Kit $candKit
```

候选演练默认跑 A8 并要求它为真；跳过 A8 只能显式带 `-SkipReinstall`（不是默认，Fable 裁定补“候选跳过 A8”）。候选回执的 A1–A7 必须逐项为真，A8 为真或被显式跳过，其他情况都是 `FAIL`。跳过了 A8 的候选，回读后最好只能得到 `PASS_A_REINSTALL_NOT_DRILLED`，A8 的 detail 写“同包重装未演练”；这个值原样写进索引的演练格，永远不会是另外两种 PASS。

演练 kit 平铺存放 `first-install-entry.ps1`、`release-pins.json`、WSL MSI、Ubuntu rootfs、全部 .deb 和 `kit.json`。
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
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Version $v -From $from -Kit $kit
```

默认整轮限时 70 分钟，包含来宾开机、A 档步骤及观测采集，可用 `-RunTimeoutMinutes` 指定。当班时须已有
`S0-clean-os`，脚本通过已安装代次的 `rearm-tool.mjs` 申请 `drill` 暂停接新，最多等 40 分钟让在跑批次结束。
保持预算为 40 分钟加整轮限时再加 10 分钟，超过 120 分钟会拒绝开机。开机前和运行中均检查宿主状态与内存。
来宾按同一截止时间自关机，重启后沿用截止时间。脚本确认关机并还原检查点后请求恢复接新，未确认时保持到期自解。

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
和 `host-result.json`、`launcher-result.json`、`stage-timings.json`。阶段文件在来宾里逐个以读写共享方式读取（写端仍开着也能读），逐个存回运行目录，
每个文件的结局记在 `stage-files.json`；不取任何凭据文件。取证失败只记录（`guest-evidence.json`、`stage-files.json`），不挡还原，也不替换本轮自己的失败码。
回执 A1 下的 `firstInstallSteps` 只从完整日志解析（阶段结果文件只取判决行）：各阶段的逐步结果行、最后完成的一步、首个被拒的一步、判决行；
阶段已运行却缺日志、空日志、只有判决行、被截断、或后续阶段已抵达而它毫无证据，记 `incomplete`；一行也解析不到记 `missing`。A1 要求两者都不是。
本轮在首装之后中断时，A1 由首装自己的结果（`entry-result.json`）单独形成。本轮没有判决就结束时（无 A1），记录在 `evidence.firstInstallSteps`。

回执 `evidence.hostExecutorStates` 记录开机门和运行中守护采样的执行器状态、原因、阶段编号和相位，每种组合只保留首次观测的 UTC 时刻。
开机前门两侧都看 `Runner.Worker`，**有作业不再拒绝开机，而是决定内存门取哪一档**（Fable 裁定“补：演练开机门与列车争 DESK”）：两侧都无作业 15 GB（生产余量 6＋来宾 8＋余量 1），任一侧有作业或查询失败 21 GB（再加 `RunnerJobExtraBytes` 6 GB，即实测“作业把生产 WSL 撑大”的幅度）；运行中的 6 GB 门不变；“演练开机时本机套件不超过 1”仍是独立的操作规则，不并进内存门。两侧是：Windows 的进程表，以及本机 Linux runner 所在的 WSL 发行版（`scripts/ci/self-hosted/node-profiles.json` 按主机名取 `linux_runner`/`additional_linux_runners` 的 `distro`；主机不在其中、或 runner 发行版不是本账户已注册的发行版，都算查询失败，取高档）。WSL 一侧只认退出码（Fable 裁定“补：分支一第四轮”）。**运行列表**是唯一还读输出的地方：`wsl --list --running --quiet` 须零退出、stderr 为空；按行切（CRLF 或 LF），只丢长度为零的行，其余每一行须整行、不修剪地等于本账户已注册的某个发行版名（HKCU Lxss 下各 DistributionName，只读），有一行不符即整次算查询失败（高档）。发行版不在其中就判无作业，不对它发任何命令。**查进程**：在运行的发行版里执行 `pgrep -ix Runner[.]Worker`（模式常量 `WslJobPattern`，点是字面点；释放命令逐字带同一模式），标准输出不读；封闭表：退出 0 且 stderr 为空＝有作业（`busyWith` = `WSL_ACTIONS_RUNNER_JOB`，高档）；退出 1 且 stderr 为空＝无作业；其他任何退出码、stderr 非空、超时（只结束本次拉起的客户端进程）＝查询失败（`busyWith` = `WSL_UNREADABLE`，高档，原因记在 `wslUnreadable`）。每次开机前三段，各自采样（Fable 裁定“补：WSL 门竞态”，顺序不变）：**早拒**（保持生效、常驻空闲；两侧作业只采样不拒绝；不读内存）→ **释放**（只在早拒采样两侧都无作业时做，否则记 `skipped.where = early` 跳过；对每个 runner 发行版，先重读运行列表，再在调用前一刻重读 Windows 进程表；不在运行就不发命令；在运行则以 root 用 `sh -c` 执行写死的单引号命令 `DrillWslReleaseCommand`（运行时按本文件语法树核对未被改动、无双引号与反斜杠）：同一个 `pgrep -ix 'Runner[.]Worker'`，退出 0 即有作业，以 3 退出跳过；查找出错以 4 退出；只有“没找到”才 `sync` 并只丢页缓存 `echo 1 > /proc/sys/vm/drop_caches`，失败以 5 退出，成功以 0 退出。宿主只看退出码：0＝已释放，3＝已跳过，其余＝释放失败；跳过与失败都不算演练失败，Decision 21db5a9c）→ **开机门**（两侧再查一次，按结果选档，然后内存门，只判这一次，然后开机）。开机前的守护、入口处与还原后的宿主检查只看执勤与保持，三段之外不另取样。基线建成或失败时三段数据都写进 `baseline.json`（`hostPreBoot`）。三段各自的时间与结果记在回执 `evidence.hostPreBoot`（`early`、`release`、`bootGate`，含 `runnerJob` 与 `requiredFreeGB`）。回执另有 `evidence.hostMemory`，只记原始事实：开机前可用（`beforeBootFreeGB`）与所需档位（`requiredFreeGB`）；开机时两侧 runner 作业（`runnerJobAtBoot`，按此优先：`yes` 任一侧确认有作业——另一侧没读出来也是 `yes`；`unknown` 没有确认的作业、但至少一侧没读出来——取高档，但不算有作业；`no` 两侧都读到且都没有；`null` 没采过作业样本，例如状态门在读作业之前就拒绝了；`runnerJobBefore` 是开机门看到的那一项）；来宾起来后守护第一次读数（`afterBootFreeGB`）、运行中最低值（`minRunningFreeGB`）与整轮最低值（`lowestFreeGB`，含开机门读数）。各步骤的原始结果与原始拒绝码照旧各记各的（A1 的首装逐步记录、`failure`、各项 detail），互不遮挡；A8 的通用升级单独一步，它的原始结果（退出码、status、code、输出原文）在下一条命令开始之前就由宿主写进 `reinstall-upgrade.json`，回执带在 `evidence.reinstallUpgrade`，后面的准备即便失败或超时也不丢；工具不对超时做任何归类。攒几轮后按这些读数调 6 GB。

**操作规则：某一步超时、且开机时宿主有 runner 作业（`runnerJobAtBoot = yes`）**——先换个时段复跑一次，再判断是不是包的问题；复跑仍在同一步超时，就按包的缺陷处理（Fable 裁定“补：争用标签止损”）。这条由读回执的人执行，不在代码里。

“取证在还原之前”只对正常结束、失败、超时三种结局成立；运行中守护触发的紧急还原（`host-guard.json` 为 `DRILL_ABORTED`）可能先于取证，
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
