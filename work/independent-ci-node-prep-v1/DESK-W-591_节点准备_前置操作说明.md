# DESK-W-591 节点准备：前置操作说明（主备安装操作说明第 1 步之前）

适用：DESK-W-591 现场（Owner 本人 + 现场 Agent）。本说明放在《DESK-W-591_主备安装操作说明.md》第 1 步之前，作为“第 0 步”。第 0 步全部通过后，再从原说明第 1 步重跑。

来源：Task `25ac6c5f`（新节点准备工具）、Task `b7d84de2` v3/v4（第 1 步因缺基础层停止）、Decision `76c5ac24`、`3efb35c7`。工具说明见同目录 `README.md`。

## 先读：授权与红线

- 本工具合入 main 只代表“工具可以用”。**在 DESK-W-591 上执行 `-Apply`、输入 runner 注册令牌、选定 WSL 发行版，每一项都要 Owner 在现场用弹窗明确选定**（推荐项放第一位并标“(推荐)”）。Agent 不代 Owner 决定。
- runner 注册令牌由 Owner 本人在 DESK-W-591 上从 GitHub 页面取得、在提权窗口里输入。令牌、App 私钥和任何 token **不经过 Agent、聊天、KooYomi、仓库或网盘**；不要截图、不要粘贴到对话里。
- **绝不动** `C:\clued-ci` 下的现有 runner `actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-01`（`.\clued-runner`，会跑 PR 代码）：不停、不改、不重注册。工具也不会碰它，并在执行后核对它没变。
- 新建的 controller runner 服务**不启动**：装好后是 Stopped/Manual。不要手动启动它。
- 任何一步得到 `REFUSED` 或 `NODE_PREP_POSTCONDITION_FAILED`：停下，把完整输出回传（写入 KooYomi Task `b7d84de2`），不要手工补装或改 ACL。

## 0.1 取得工具并核对

1. 从协调方告知的 main 提交取以下文件，放到 Owner 的一个新文件夹（例如 `C:\Users\Windows\Documents\nodeprep\`），保持相对路径：
   - `work/independent-ci-node-prep-v1/windows/prepare-node.ps1`
   - `work/independent-ci-node-prep-v1/linux/prepare-node-linux.sh`
   - `work/independent-ci-node-prep-v1/config/node-prep.desk-w-591.json`
2. 核对三个文件的 sha256 与 KooYomi Task `25ac6c5f` 里记录的值一致（`Get-FileHash -Algorithm SHA256 <文件>`）。不一致就停。

## 0.2 下载 runner 包（公开文件，可由 Agent 或 Owner 下载）

```powershell
Invoke-WebRequest -UseBasicParsing -Uri https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip -OutFile C:\Users\Windows\Documents\nodeprep\actions-runner-win-x64-2.337.0.zip
(Get-FileHash C:\Users\Windows\Documents\nodeprep\actions-runner-win-x64-2.337.0.zip -Algorithm SHA256).Hash
```

结果必须是 `1150692AFA94E71F872017E254EA55B6EECE1EECE3FE7E3A6D4C93D0A1B85CFC`（与 TURING 的原二进制同一个包，也是 GitHub 发布页公布的值）。不一致就停。

## 0.3 只读干跑（普通权限，不提权）

在 Owner 的**普通**（非管理员）PowerShell 里：

```powershell
cd C:\Users\Windows\Documents\nodeprep
powershell -NoProfile -ExecutionPolicy Bypass -File .\prepare-node.ps1 -ProfilePath .\node-prep.desk-w-591.json -RunnerPackageZip .\actions-runner-win-x64-2.337.0.zip | Tee-Object -FilePath .\DESK-W-591_nodeprep_dryrun.txt
```

预期：`"status": "DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN"`，最后一行 `PLAN_SHA256=<64 位十六进制>`。核对：

- `plan.steps` 里全部 `skip` 为 false（新节点什么都没有）；顺序为 account → 6 个 CluedControl 目录 → runner-extract → runner-package-copy → runner-register → runner-service-file → service → 6 个 CluedIndependentCI 目录。
- `plan.untouchedServices` 只有 `...clued-ci-company-win-01`，账户 `.\clued-runner`。
- `runner-register` 的 `name` 是 `clued-ci-company-win-02`，`labels` 是 `self-hosted, Windows, X64, clued-controller-windows-v1`。
- `wsl.distributions`：每个**运行中**的发行版有 `probe` 和 `hostsRunners`。已停止的（如 `docker-desktop`）不会被启动，只标“not probed”。

若得到 `ELEVATED_DRY_RUN_REQUIRED`：说明机器上已有读不了的目标（与 b7d84de2 v3 不符），停下回传。

把干跑输出（不含任何秘密）写入 KooYomi Task `b7d84de2`。

## 0.4 WSL 发行版：Owner 用弹窗决定

依据 0.3 的 `wsl.distributions`。常驻的 Linux 侧**不能**放在会跑 PR 代码的发行版里（Linux 侧脚本遇到装有 GitHub runner 的发行版会直接拒绝）。

- 若 `CluedCI-Linux` 的 `hostsRunners` 为 true（GitHub 上 company-linux-01..04 很可能就在这里）：弹窗选项建议
  1. 新建一个专用发行版（例如 `CluedResident-Linux`，Ubuntu 24.04），只给常驻用 (推荐)。新建发行版和其 systemd/docker/Python 等准备是另一项工作，需协调方另出步骤；本说明的 Windows 部分不等它，可以先做。
  2. 暂缓 Linux 侧，先只做 Windows 部分。
- 若 `CluedCI-Linux` 的 `hostsRunners` 为 false：仍需 Owner 确认它不跑 PR 代码、不是 docker-desktop 的数据发行版，再决定是否用它。
- 决定后把发行版名写进本机那份 `node-prep.desk-w-591.json` 的 `wslDistribution`（字符串）。**改了档案，计划哈希会变**：回到 0.3 重新干跑，用新的 `PLAN_SHA256`。也可以先保持 `null` 做 Windows 部分，Linux 侧在发行版定了以后单独做（0.7）。

把 Owner 的选择写入 KooYomi（Decision，Owner 原话/弹窗选项）。

## 0.5 Owner 决定是否执行 Windows 准备（弹窗）

弹窗内容：将按 0.3 的计划（写明 `PLAN_SHA256`）在 DESK-W-591 上建 clued-control 账户、`C:\ProgramData\CluedControl`（含独立的 controller runner，注册后不启动）和 `C:\ProgramData\CluedIndependentCI` 基础；需要 Owner 点一次 UAC 并输入 GitHub runner 注册令牌。选项：

1. 执行 (推荐)
2. 暂不执行

Owner 选“执行”后才继续。把决定写入 KooYomi。

## 0.6 Owner 取得注册令牌（只在 DESK-W-591 本机）

Owner 在 DESK-W-591 的浏览器打开 `https://github.com/tdoljyj/cross-memory-system/settings/actions/runners/new?arch=x64&os=win`，页面“Configure”一段的命令里 `--token` 后面那串就是注册令牌（约 1 小时有效）。**只在下一步的提权窗口里输入，不要复制到别处。**

## 0.7 执行（Owner 点 UAC、输入令牌）

现场 Agent 拉起提权窗口（Owner 点 UAC），命令里用 0.3 得到的 `PLAN_SHA256`：

```powershell
Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command','cd C:\Users\Windows\Documents\nodeprep; .\prepare-node.ps1 -ProfilePath .\node-prep.desk-w-591.json -RunnerPackageZip .\actions-runner-win-x64-2.337.0.zip -Apply -ExpectedPlanSha256 <PLAN_SHA256> | Tee-Object -FilePath .\DESK-W-591_nodeprep_apply.txt'
```

窗口会提示 `GitHub runner registration token ...`：Owner 输入令牌（不回显）后回车。之后脚本依次建账户、目录、解包、注册、建服务、建 CI 目录。

预期 `"status": "NODE_PREPARED"`，`postconditions` 全部为 true：`account`、`controlRoot`、`trusted`、`runnerServiceExe`、`ciRoot`、`formalSpool`、`state`、`service`（Stopped/Manual/原二进制/clued-control/PID 0）、`otherServicesUnchanged`。回执里的 `controllerSid` 是新账户的 SID。

- `PLAN_CHANGED_SINCE_REVIEW`：主机或文件在干跑后变了。回到 0.3 重新干跑，再请 Owner 确认新哈希。
- `RUNNER_REGISTRATION_FAILED:*` 或 `REGISTRATION_TOKEN_SHAPE_REFUSED`（令牌错或过期）：账户和前面的目录已建好。回到 0.3 重新干跑：计划会只剩没做完的步骤，并写明 `account-password-reset`（账户从未登录过，重置它的随机密码以便建服务）。请 Owner 确认新哈希、取新令牌，再执行。
- 其他拒绝码：停下回传。

执行完把 `DESK-W-591_nodeprep_apply.txt`（不含秘密：令牌从不打印）写入 KooYomi Task `b7d84de2`，并在 Task `25ac6c5f` 记 controller SID。Owner 可以删掉下载的 runner 包副本；令牌一小时后自动失效。

## 0.8 Linux 侧（发行版定了以后）

在 0.4 选定的发行版里（这里以 `<发行版>` 表示），先只读：

```powershell
wsl -d <发行版> -u root -- bash /mnt/c/Users/Windows/Documents/nodeprep/prepare-node-linux.sh --plan --distribution <发行版>
```

预期 `DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN` 和 `planSha256`；`dir` 行列出 7 个目录的现状；`fact` 行报告其余前提（systemd、docker、python3.12、toolchain node 等，本脚本不装）。得到 `DISTRIBUTION_HOSTS_GITHUB_RUNNERS` 就说明这个发行版有 runner，停下回到 0.4。

Owner 弹窗确认后执行：

```powershell
wsl -d <发行版> -u root -- bash /mnt/c/Users/Windows/Documents/nodeprep/prepare-node-linux.sh --apply --distribution <发行版> <planSha256>
```

预期 `NODE_PREPARED_LINUX`。输出写入 KooYomi Task `b7d84de2`。

## 0.9 回到原说明第 1 步

重跑《DESK-W-591_主备安装操作说明.md》第 1 步的全部只读检查。预期：`Get-LocalUser -Name clued-control` 有返回；六个 `Test-Path` 全为 True；`company-win-01` 仍为 Running/Auto/`.\clued-runner`，原路径不变；另多一个 `...clued-ci-company-win-02`（Stopped，Manual，`.\clued-control`，`"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"`）。全部满足才进入原说明第 2 步（P0），P0 仍单独过关。

## 本步不做的事

- 不放 App 私钥、不建 ci-admission token、不做正式资格、不建停车位、不装常驻（这些在原说明后续步骤，各自需 Owner 决定）。
- 不启动 controller runner；不改现有 runner；不改本地安全策略；不删除任何东西。
- 不新建 WSL 发行版、不装 Linux 侧的 toolchain/Source/systemd/docker（若 0.4 选了新发行版，由协调方另出步骤）。
