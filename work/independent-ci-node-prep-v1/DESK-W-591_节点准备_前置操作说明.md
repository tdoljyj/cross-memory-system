# DESK-W-591 节点准备：前置操作说明（主备安装操作说明第 1 步之前）

适用：DESK-W-591 现场（Owner 本人 + 现场 Agent）。本说明是《DESK-W-591_主备安装操作说明.md》第 1 步之前的“第 0 步”；第 0 步全部通过后，从原说明第 1 步重跑。

来源：Task `25ac6c5f`（新节点准备工具）、Task `b7d84de2` v3/v4（第 1 步因缺基础层停止）、Decision `76c5ac24`、`3efb35c7`。工具说明见同目录 `README.md`。

## 先读：授权与红线

- 工具合入 main 只表示“工具可以用”。**在 DESK-W-591 上执行 `-Apply`、输入 runner 注册令牌、选定 WSL 发行版，每一项都要 Owner 在现场用弹窗明确选定**（推荐项放第一位，标“(推荐)”）。Agent 不代 Owner 决定。
- runner 注册令牌由 Owner 本人在 DESK-W-591 上从 GitHub 页面取得，只在提权窗口里输入。令牌、App 私钥和任何 token **不经过 Agent、聊天、KooYomi、仓库或网盘**；不截图，不粘贴到对话里。
- **绝不动** `C:\clued-ci` 下的现有 runner `actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-01`（`.\clued-runner`，会跑 PR 代码）：不停、不改、不重注册。工具也不会碰它，执行后会核对它没变。
- 新建的 controller runner 服务**不启动**，装好后是 Stopped/Manual。不要手动启动。
- **提权运行的脚本必须先复制到只有管理员能改的目录、核对 sha256 后再运行**（0.6）。工具在提权时会检查自己所在的位置，位置不对就拒绝（`TOOL_LOCATION_NOT_ADMIN_ONLY`）。原因：这台机器上会跑 PR 代码的 WSL 发行版，通过 `/mnt/c` 可以改写 Owner 文件夹里的文件。
- **停下的条件**：输出的 `status` 不是 `DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN`、`NODE_PREPARED`、`NODE_PREPARED_LINUX` 时，按下文对应条目处理；没有对应条目的，停下并把完整输出写入 KooYomi Task `b7d84de2`。不要手工补装，不要手工改 ACL。

## 0.1 取得工具并核对

1. 从协调方告知的 main 提交取以下三个文件，放进 Owner 的一个新文件夹 `C:\Users\Windows\Documents\nodeprep\`（这里只是中转，提权时不从这里运行）：
   - `work/independent-ci-node-prep-v1/windows/prepare-node.ps1`
   - `work/independent-ci-node-prep-v1/linux/prepare-node-linux.sh`
   - `work/independent-ci-node-prep-v1/config/node-prep.desk-w-591.json`
2. 用 `Get-FileHash -Algorithm SHA256 <文件>` 核对三个文件，sha256 必须与 KooYomi Task `25ac6c5f` 里记录的值一致。不一致就停。

## 0.2 下载 runner 包（公开文件，Agent 或 Owner 下载均可）

```powershell
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing -Uri https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip -OutFile C:\Users\Windows\Documents\nodeprep\actions-runner-win-x64-2.337.0.zip
(Get-FileHash C:\Users\Windows\Documents\nodeprep\actions-runner-win-x64-2.337.0.zip -Algorithm SHA256).Hash
```

结果必须是 `1150692AFA94E71F872017E254EA55B6EECE1EECE3FE7E3A6D4C93D0A1B85CFC`（与 TURING 原二进制同一个包，也是 GitHub 发布页公布的值）。工具执行时还会再核一次。

## 0.3 只读干跑（普通权限，不提权）

在 Owner 的**普通**（非管理员）PowerShell 里运行：

```powershell
cd C:\Users\Windows\Documents\nodeprep
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File .\prepare-node.ps1 -ProfilePath .\node-prep.desk-w-591.json -RunnerPackageZip .\actions-runner-win-x64-2.337.0.zip | Tee-Object -FilePath .\DESK-W-591_nodeprep_dryrun.txt
```

预期 `"status": "DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN"`，最后一行是 `PLAN_SHA256=<64 位十六进制>`。逐项核对：

- `toolSha256` 等于 0.1 核对过的 `prepare-node.ps1` 的值。
- `plan.steps` 的 `skip` 全部为 false（新节点什么都还没有）。顺序：account → 6 个 CluedControl 目录 → runner-extract → runner-package-copy → runner-register → runner-service-file → service → 6 个 CluedIndependentCI 目录。
- `plan.untouchedServices` 只有 `...clued-ci-company-win-01`，账户是 `.\clued-runner`。
- `runner-register` 的 `name` 是 `clued-ci-company-win-02`，`labels` 是 `self-hosted, Windows, X64, clued-controller-windows-v1`。
- `wsl.distributions` 里，每个**运行中**的发行版都有 `probe` 和 `hostsRunners`。已停止的不会被启动，标为 “not probed”。这些结果是发行版自己报的（`selfReported: true`），0.4 还要和 GitHub 交叉核对。

出现 `ELEVATED_DRY_RUN_REQUIRED`：在**全新机器**上说明已有读不了的目标，与 b7d84de2 v3 不符，停下回传。若本工具**之前执行过一部分**，这是预期结果，改用 0.7 的提权干跑。

把干跑输出（不含任何秘密）写入 KooYomi Task `b7d84de2`。

## 0.4 WSL 发行版：Owner 用弹窗决定

依据：0.3 的 `wsl.distributions`；另外在 GitHub 仓库 Settings → Actions → Runners 页面核对，company-linux-01..04 带 `runtime-wsl2` 标签，是这台机器上 WSL 里的 runner；再请 Owner 本人确认它们在哪个发行版里。常驻的 Linux 侧**不能**放在会跑 PR 代码的发行版里，Linux 脚本遇到装有 GitHub runner 的发行版会直接拒绝。

- 若 `CluedCI-Linux` 跑着这些 runner（`hostsRunners` 为 true，或 Owner 确认在其中），弹窗选项建议：
  1. 新建一个专用发行版，例如 Ubuntu 24.04 的 `CluedResident-Linux`，只给常驻用 (推荐)。新建发行版及其 systemd、docker、Python 等准备是另一项工作，需协调方另出步骤。Windows 部分不等它，可以先做。
  2. 暂缓 Linux 侧，先只做 Windows 部分。
- 若 `CluedCI-Linux` 没有 runner：仍需 Owner 确认它不跑 PR 代码、也不是 docker-desktop 的数据发行版，再决定是否用它。

档案里的 `wslDistribution` 保持 `null` 即可：Windows 部分不需要它，档案也就不必改（改了档案，sha256 就和 KooYomi 记录的不一样了）。发行版名只在 0.8 作为参数使用；常驻用的 node profile 在后续打包时再填。

把 Owner 的选择写入 KooYomi（Decision，记录 Owner 原话或弹窗选项）。

## 0.5 Owner 决定是否执行 Windows 准备（弹窗）

弹窗写明：将按 0.3 的计划（附上 `PLAN_SHA256`）在 DESK-W-591 上建 clued-control 账户、`C:\ProgramData\CluedControl`（含独立的 controller runner，注册后不启动）和 `C:\ProgramData\CluedIndependentCI` 基础；需要 Owner 点一次 UAC，并输入 GitHub runner 注册令牌。选项：

1. 执行，完成后核对 GitHub runner 列表 (推荐)
2. 执行，并在输入令牌期间暂停跑 PR 代码的发行版（`wsl --terminate CluedCI-Linux`。会中断 company-linux-01..04 正在跑的作业；该发行版之后怎么拉起，按这台机器现有的启动方式，由协调方确认）
3. 暂不执行

Owner 选了执行之后才继续。把决定写入 KooYomi。

## 0.6 Owner 取得注册令牌（只在 DESK-W-591 本机）

Owner 在 DESK-W-591 的浏览器打开 `https://github.com/tdoljyj/cross-memory-system/settings/actions/runners/new?arch=x64&os=win`。页面 “Configure” 一段命令里 `--token` 后面那串就是注册令牌，约 1 小时有效。

- 最好照着页面手工输入到下一步的提权窗口里。如果复制粘贴，粘贴后立刻清空剪贴板（`Set-Clipboard -Value ''`），并确认系统的剪贴板历史和云剪贴板已关闭。
- 不要复制到别处。

## 0.7 提权执行（Owner 点 UAC，输入令牌）

现场 Agent 在普通 PowerShell 里拼好下面这段命令，再以提权方式拉起，由 Owner 点 UAC。拼之前先把三处 `<...>` 换掉：两个 sha256 用 KooYomi 里记录的值；`<MODE>` 执行时填 `-Apply -ExpectedPlanSha256 <0.3 的 PLAN_SHA256>`，只做提权干跑时留空。

命令做的事：

1. 在 `C:\ProgramData` 下直接新建一个随机名的目录 `CluedNodePrep-<GUID>`。名字不可预测，目录已存在就拒绝。建完立即读回：不是链接，属主是 Administrators，DACL 受保护，只有 SYSTEM 和 Administrators。
2. 每个文件先读进内存。脚本和档案在内存里先核 sha256，通过后才逐字节写进去，属主是 Administrators；工具会再核一次，属主是用户账户的文件一律拒绝。
3. 从这个目录执行。
4. 回执写到 Owner 文件夹里一个随机名的新文件（`CreateNew`，不跟随已有的文件或链接），同时显示在窗口里。

```powershell
$cmd = @'
$ErrorActionPreference = 'Stop'
$src = 'C:\Users\Windows\Documents\nodeprep'
$d = 'C:\ProgramData\CluedNodePrep-' + [guid]::NewGuid().ToString('N')
if (Test-Path -LiteralPath $d) { throw 'RUN_DIRECTORY_EXISTS' }
$s = New-Object Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
[void][IO.Directory]::CreateDirectory($d, $s)
$raw = New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $d).Sddl)
$aces = @($raw.DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value + '|' + $_.AccessMask }) -join ','
if (((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or $raw.Owner.Value -ne 'S-1-5-32-544' -or
  ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or $aces -ne 'S-1-5-18|2032127,S-1-5-32-544|2032127') { throw 'RUN_DIRECTORY_REFUSED' }
$pins = @{ 'prepare-node.ps1' = '<prepare-node.ps1 的 sha256>'; 'node-prep.desk-w-591.json' = '<node-prep.desk-w-591.json 的 sha256>' }
$fsSec = New-Object Security.AccessControl.FileSecurity; $fsSec.SetSecurityDescriptorSddlForm('O:BAG:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)')
$sha = [Security.Cryptography.SHA256]::Create()
foreach ($n in 'prepare-node.ps1', 'node-prep.desk-w-591.json', 'actions-runner-win-x64-2.337.0.zip') {
  $b = [IO.File]::ReadAllBytes((Join-Path $src $n))
  if ($pins.ContainsKey($n) -and ([BitConverter]::ToString($sha.ComputeHash($b)).Replace('-', '').ToLower()) -ne $pins[$n]) { throw ('SHA256_MISMATCH:' + $n) }
  $fs = New-Object IO.FileStream((Join-Path $d $n), [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $fsSec)
  try { $fs.Write($b, 0, $b.Length) } finally { $fs.Dispose() }
}
Set-Location $d
$r = & (Join-Path $d 'prepare-node.ps1') -ProfilePath .\node-prep.desk-w-591.json -RunnerPackageZip .\actions-runner-win-x64-2.337.0.zip <MODE> | Out-String
$r
$o = Join-Path $src ('DESK-W-591_nodeprep_' + [guid]::NewGuid().ToString('N') + '.txt')
$w = New-Object IO.StreamWriter((New-Object IO.FileStream($o, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)), (New-Object Text.UTF8Encoding($false)))
try { $w.Write($r) } finally { $w.Dispose() }
'receipt: ' + $o
'@
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
Set-Location $env:SystemRoot
Start-Process -Verb RunAs -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-EncodedCommand', $enc
```

**Owner 点 UAC 之前先看弹窗**：程序必须是 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，发布者必须是 Microsoft Windows。不是的话点“否”，并报告协调方。拉起命令用的是完整路径，当前目录也先切到了 `C:\Windows`，正常情况下不会出现别的程序。

窗口提示 `GitHub runner registration token ...` 时，Owner 输入令牌（不回显）并回车。脚本随后依次建账户、目录，解包，注册（令牌只经子进程的环境变量传给 runner，不上命令行），建服务，再建 CI 目录。

**预期**：`"status": "NODE_PREPARED"`，`postconditions` 全部为 true：

- `account`、`controlRoot`、`trusted`、`runnerServiceExe`、`ciRoot`、`formalSpool`、`state`；
- `service`：Stopped、Manual、原二进制、clued-control、PID 0；
- `otherServicesUnchanged`；
- `replanNothingToDo`：按现在的主机重算一遍计划，结果是“无事可做”。这一项会复核每个目录的属主和 DACL、账户、runner 目录、包副本、`.service` 和服务配置。

回执里的 `controllerSid` 是新账户的 SID。

**执行后核对 GitHub**：在 Settings → Actions → Runners 里，带 `clued-controller-windows-v1` 标签的 runner 只能有 TURING 的 `clued-ci-home-win-02` 和新的 `clued-ci-company-win-02`（离线），不能有别的。多出来的立即报告 Owner。

**出问题时**：

- `SHA256_MISMATCH:*`、`RUN_DIRECTORY_EXISTS`、`RUN_DIRECTORY_REFUSED`、`TOOL_LOCATION_NOT_ADMIN_ONLY:*`：文件被改过，或者运行目录不是只有管理员能访问。停下回传。主机上什么都没改，至多留下那个随机名目录（只有管理员能访问）。
- `PLAN_CHANGED_SINCE_REVIEW`：主机或文件在干跑后变了，什么都没写。回到 0.3。
- `REGISTRATION_TOKEN_SHAPE_REFUSED`：令牌格式不对（多半输错）。这一步在**任何写入之前**，什么都没写。重新取令牌，重跑 0.7。
- `"status": "APPLY_DONE_NOT_VERIFIED"`：全部步骤都执行了，但执行后的核对本身出错。不要重跑执行。先用提权干跑核对主机现状（做法见下一条），再回传。
- `"status": "APPLY_PARTIAL"`：执行到一半停了。`completedSteps` 列出已做的步骤，`failedStep` 是停在哪一步，`controllerSid` 是已建账户的 SID。写入 KooYomi 后，**用提权干跑重算计划**：上面命令里 `<MODE>` 留空（只读），同样以提权方式拉起（提权运行不做 WSL 探测），会再建一个新的随机名运行目录和回执文件。新计划只含没做完的步骤：
  - 若停在注册（`RUNNER_REGISTRATION_FAILED:*`，常见原因是令牌过期），计划里会有 `account-password-reset`（账户从未登录过，重置它的随机密码以便建服务）。Owner 确认新的 `PLAN_SHA256`、取新令牌后，再执行 0.7。
  - 若重算得到 `RUNNER_ROOT_UNEXPECTED:missing:*`（解包到一半就停了，例如磁盘满或杀毒软件锁文件）：工具不删东西，也不允许手工补装。请 Owner 弹窗决定是否由 Owner 本人删掉 `C:\ProgramData\CluedControl\runner` 后重来。删除之前先确认 GitHub 上没有注册同名 runner。
  - 若注册报错说 runner 名已存在（GitHub 那边注册成功了，本地却没写出 `.runner`，例如网络中断）：工具不带 `--replace`。请 Owner 在 GitHub 的 Runners 页面删掉那个离线的 `clued-ci-company-win-02` 后，用新令牌重来。
- `RUNNER_LOG_CONTAINS_TOKEN:*`：runner 自己的日志里出现了令牌。停下回传；令牌一小时后失效，必要时 Owner 在 GitHub 上删掉该 runner。
- 其他码：停下回传。

执行完，把窗口最后一行 `receipt:` 指向的回执文件写入 KooYomi Task `b7d84de2`（令牌从不打印，回执里没有秘密），并在 Task `25ac6c5f` 记下 controller SID。下载的 runner 包副本 Owner 可以自行删除。`C:\ProgramData\CluedNodePrep-<GUID>` 只有管理员能访问，工具不会删它，留着作为记录。

## 0.8 Linux 侧（发行版定了以后）

先以 root 把脚本复制到该发行版里只有 root 能改的位置，并核对 sha256（`<发行版>` 是 0.4 选定的名字）：

```powershell
wsl -d <发行版> -u root -- install -D -o root -g root -m 0700 /mnt/c/Users/Windows/Documents/nodeprep/prepare-node-linux.sh /root/clued-nodeprep/prepare-node-linux.sh
wsl -d <发行版> -u root -- sha256sum /root/clued-nodeprep/prepare-node-linux.sh
```

sha256 必须等于 KooYomi 里记录的 `prepare-node-linux.sh` 的值。脚本以 root 运行时，只认这种只有 root 能改的副本，从 `/mnt` 下直接运行会拒绝（`SCRIPT_LOCATION_REFUSED`）。然后只读：

```powershell
wsl -d <发行版> -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --plan --distribution <发行版>
```

预期 `DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN` 和 `planSha256`。`dir` 行列出 7 个目录的现状；`fact` 行报告其余前提（systemd、docker、python3.12、toolchain node 等，本脚本不安装）。若得到 `DISTRIBUTION_HOSTS_GITHUB_RUNNERS`，说明这个发行版里有 runner，停下回到 0.4。

Owner 弹窗确认后执行：

```powershell
wsl -d <发行版> -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --apply --distribution <发行版> <planSha256>
```

预期 `NODE_PREPARED_LINUX`。把输出写入 KooYomi Task `b7d84de2`。

## 0.9 回到原说明第 1 步

重跑《DESK-W-591_主备安装操作说明.md》第 1 步的全部只读检查。预期：

- `Get-LocalUser -Name clued-control` 有返回；
- 六个 `Test-Path` 全为 True；
- `company-win-01` 仍为 Running、Auto、`.\clued-runner`，原路径不变；
- 另多一个 `...clued-ci-company-win-02`：Stopped、Manual、`.\clued-control`、`"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"`。

全部满足才进入原说明第 2 步（P0）。P0 仍单独过关。

## 本步不做的事

- 不放 App 私钥，不建 ci-admission token，不做正式资格，不建停车位，不装常驻。这些在原说明后续步骤里，各自需要 Owner 决定。
- 不启动 controller runner，不改现有 runner，不改本地安全策略，不删除任何东西。
- 不新建 WSL 发行版，不装 Linux 侧的 toolchain、Source、systemd、docker。若 0.4 选了新建发行版，由协调方另出步骤。
