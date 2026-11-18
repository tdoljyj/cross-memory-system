# 首装演练 kit

入口已实现，尚未在 VM 实测。A 档仅用于 CLUED-DRILL/drill 已提权的 PowerShell Direct 会话：
加载接受版 bootstrap 的函数，依原顺序验证资产、前置、first-install-check，直接运行接受版 first-install-host，
再运行 prepare 和接受版 bootstrap -Stage launcher。接受资产不改写。host 使用验过哈希的管理员专用临时树。

这是 README §5“不要绕过 bootstrap 手工运行 prepare”的**演练机内例外**，仅绕开普通令牌检查、RunAs、凭据窗口。
凭据输入目录严格使用 O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)，把 app-key.pem 映射成 app-private-key.pem，
只另放 ci-admission.token、resident-upgrade.token、public.json，不放心跳令牌；输入与正式临时凭据目录在所有结束路径清理。
结局由接受版 Get-LauncherVerdict 判断，companion 切换未完成不会变成功。

构建器把三处绕过写进 perNodeSteps；判定器对 prerequisiteMode=first-install-host 额外强制 A10 未通过。
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

从仓库根运行，只创建新目录（已有目标会拒绝）：

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

本次验收包的 `universal-manifest.json` 文件清单列有 `windows/SwapBroker.cs` 或 `windows/ci-connection-renew.contract.json` 时，适用 M5。完成 A 档步骤后，`m5/` 保存来宾已生成的公开观测，宿主的 `test/renewal-drill.mjs` 核验齐备的六份文件。
回执独立记录 `m5.result`。核验通过为 `PASS`，观测缺失、核验器缺失或核验失败为 `FAIL`。文件清单无续期组件时为 `NOT_EVALUATED`，回执说明原因。
D5 单独检查这份回执的 `m5.result`，只接受 `PASS`。A 档按回执的 `conclusion` 判定，`-Finalize` 继续只处理 A 档回读。

本次未启动/修改 Hyper-V；A1–A10 实机结果、重启、再装、A5/A9 生产只读核验均由 DESK 另做。

## 交互原入口模式

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

A5/A9 由 DESK 用回执内 productionReadbackSql 取得只读结果，写到本次 runs 目录的 readback.json，随后：

```powershell
pwsh -NoProfile -File work/independent-ci-resident-v1/drill/drill-vm.ps1 -Finalize <本次receipt.json> -ProductionReadback <本次readback.json>
```

离线测试只用仓库入口：

```powershell
node scripts/ci/ci-required-selection.mjs --run resident-node --root D:/w/tmp/drill-kit
```
