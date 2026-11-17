# 整套重装工具链（reinstall/）

把常驻执行器整套重装到一个节点：打包、生成提权启动器、生成 Linux 第 A/B 步 root 脚本，以及安装前对已装现场做全量只读预演。

这套工具来自 TURING 上 r4–r7 几次重装时用过、也审过的脚本（原先放在 `s34-reinstall\r4-work`，每一版都是从上一版打补丁派生出来的）。现在改为按参数生成：节点、提交、Owner 的 Decision 和回执、已装状态，都从文件读，不再写在代码里。

决定：KooYomi Decision `19baf5ec`。设计说明见 DESIGN §40。

## 1. 边界

- 所有工具都**不提权、不进 WSL root、不写主机**，只在配置的 `workDir` 下新建文件，绝不覆盖已有文件。真正改动主机的只有两样：Owner 点 UAC 运行的启动器，和 Owner 以 root 运行的 Linux 脚本。
- **秘密不进仓库，也不进任何生成物。**
  - 配置文件里只能写路径和公开值。`tools/rconfig.py` 会拒绝像秘密的键名和值，例如私钥头、`ghp_`、`github_pat_`、`sb_secret_`、JWT。
  - resident-upgrade token 只给出路径，工具只查它存不存在，从不打开内容。
  - 签名私钥只在 Linux 第 B 步由已审核的签名工具在 root 下读取。
- Linux 第 A/B/resume 三个脚本都是 root 脚本。改动生成器或 `linux/tools/` 之后，必须重新做一次完整的独立审核。

## 2. 构建配置（`config/*.json`，合同 `clued.independent-ci.reinstall-config/1`）

| 键 | 含义 |
|---|---|
| （无节点名、无档案路径） | 配置不点名任何节点：节点档案一律取 `basePackage`（本机已装包）record 的 `acceptance.json` `node`（`rconfig.node_profile`），仓库里没有任何节点的档案或配置 |
| `workDir` | 输出目录（仓库外） |
| `repo` | 用来 `git archive` 提交的本地仓库 |
| `basePackage` | 一个审过的包，从它的 record 读取共用的公开值：仓库、App/installation id、KooYomi 公开地址和 publishable key、角色描述、公开签名者表 |
| `nodeRecord` | 节点自己的公开指纹，会覆盖 base 的值：`appKeyId`（数字）、`appPublicKeySha256Base64`、`ciPrincipalBindingId`、`ciTokenPinSha256`、`ciPrincipalRoleRef`、`controllerNodeSha256`。与 base 包不同的节点必须六项都给，不继承 base 的值。示例里的 `REPLACE_` 占位值无法通过加载 |
| `nodeExe`、`policyInput`、`companionInput` | 打包输入 |
| `upgradeTokenFile` | resident-upgrade token 的路径（只用路径） |
| `heartbeat`（可选） | 节点心跳令牌（DESIGN §41.6a）：`tokenFile` 是心跳连接令牌的路径（只用路径，不能与 `upgradeTokenFile` 相同）；`bindingId` 可选，是这条连接的 binding id（公开值，只作记录；Owner 在 `/bindings/failover` 上关联），只能和 `tokenFile` 一起给。不写这一项，启动器的行为与以前相同 |
| `runner` | controller runner 服务的原始 binPath 和 DACL（服务名取自节点档案） |
| `launcher` | 安装后暂停、rearm、W1 暂停各自使用的 reason |
| `linux` | WSL 发行版（必须等于节点档案的 `wslDistribution`）；已装 Linux 常驻 manifest 的副本；已装 `roles-v3` 的副本（含 `formal-source-manifest-v2.json`），这两份副本由 root 复制出来；`host`：root 脚本钉住的节点自身事实，即 toolchain node 的 sha256、verify-result 公钥的 sha256、已装 Source v1 的 HEAD（没有 Source v1 的节点，即 Z1 首装的节点，填 `null`，见第 6 节） |
| `secretTargetsExist` | App 私钥和 ci-admission token 的目标位置是否已存在（启动器在提权后会核对） |

路径只许 ASCII 字母、数字、空格和 `._-\`，runner 的 binPath 和 SDDL 各有严格形状：这些值会进 root shell 和提权 PowerShell。

仓库里没有任何节点的配置：配置由节点自己从已装状态生成（`rollout/fleet/install.mjs` 的 `reinstallConfigFor`）。`config/new-node.example.json` 只是字段模板。

## 3. 打包：`build.ps1`

```
powershell -NoProfile -File build.ps1 -Config <本机生成的配置> -Commit <40hex>                       # DRAFT（占位 ref）
powershell -NoProfile -File build.ps1 -Config ... -Commit ... -Final -DecisionRef <uuid> -ReceiptRef <uuid> -AcceptedAt <ISO Z> -Tag t
          [-Rehearsal <预演报告> -LinuxEvidence <file> -LinuxVersionFacts <file>]
powershell -NoProfile -File build.ps1 -Config <本机生成的配置> -Commit ... -PackageOnly           # 只出包
```

依次执行：
1. `tools/record-inputs.py`
2. 提交自己的 `prepare-record.mjs`
3. `tools/check-record.mjs`（`validateRecordV2`）
4. `tools/upgrader-config.py`（用树里的 `validateUpgraderConfig` 校验）
5. `tools/linux-pins.py pins`：外部钉值的路径和顺序沿用已装 manifest，`source-v2` 下的钉值取**新提交**的文件
6. `build-package.mjs --fresh-install`
7. `linux-pins.py check`
8. `launcher/generate.py`：在新目录里重建一次，要求包 sha 相同

`workDir\tree-<c8>` 每次使用前都由 `tools/tree.py` 核对：必须与提交逐个 blob 相同，且没有多余文件（`build.ps1`、`generate.py`、`prep.py`）。

带 `-PackageOnly` 时不生成启动器：启动器要读的是本机的已装常驻，给别的节点打包时没有意义。

## 4. 启动器：`launcher/generate.py` + `launcher/template.ps1`

### 完整 Source V2 输入

`build.ps1 -SourceV2 <json>` 将已有 builder 的 `--source-v2` 输入同时传入首包和启动器的重建。JSON 使用原有合同：`commit`、`bundle`、`rolesDerivedSha256`。提交必须是已接受的运行 Source；辅助工具的提交不替换它。`linux/assemble.py` 将包内 bundle 一并复制，`linux/prep.py` 在 root 暂存时按固定路径复制并校验 bundle，派生后三个 role 的摘要必须等于包中值。

主机环境未变时，用 `-HostQualificationRef <已接受的现行 Host 引用>`；Source 接受不能替代 Host 资格。Linux 脚本使用 record 中的独立 Host 引用。正式接受引用替换占位引用后，必须重算并交回最终 S 和包摘要，不能沿用 DRAFT 摘要。

### 升级链的历史离线 replay

精确 BEFORE/AFTER 模块的隔离正向与回滚复放，见本文末尾“显式历史 replay”。该入口不属于普通 CI，不替代当前 Source 或物理空升级 Gate；不要沿用旧测试路径或仅设置 BEFORE 的旧命令。

首次重装后的“同 Source 空升级”可先用原 `rollout/build-upgrade.ps1` 构建：原地包移除本次重装包主清单里24个只供首次安装的 upgrader 写入项，所有共同文件字节、C/S、策略、身份、冻结升级器和 bundle 保持相同，包摘要自然不同。须按 `target` 逐项对比，不能按 `path` 去重漏掉复制到多个目标的文件；交付逐文件 diff，并在目标重装后的实际现场重新预检与取得精确 Grant。不要改功能、有效期或制造空提交来绕过 `UPGRADE_SAME_AS_CURRENT`。

- **模板**：`template.ps1` 就是 r7 f4 在 TURING 上实际跑过的文本（6d32f2ba），把补丁历史合了进来，只多了一处：主机名改为参数 `$NodeHostname`。生成器钉住模板的 sha，不再打补丁；模板要改，就作为文本改动走审核。
- **数据来源**：启动器钉住的每一个值都来自文件，包括包、配置、包里 record 的节点档案（必须等于配置所指的档案），以及本机已装状态（只读）。
- **final 的前提**：Linux 第 B 步产出的 evidence 和 version facts，加上一份对**同一个包、同一提交、同一配置**的 `REHEARSAL_PASS` 预演报告，缺一不可（`FINAL_NEEDS_A_PASSING_REHEARSAL_OF_THIS_PACKAGE`）。24 小时时限由 `prep.py` 在节点变动之前检查；这里不再查，因为 W1 和 Linux B 之后节点处于半重装状态，无法重新预演。
- **步骤**：Q1–Q5、r4.1 C1–C3、r5 S1–S3、r5c 的升级通道、r7 的卸载计划 /3 和"经 SCM 停升级代理"。每一步都在模板注释里写了用途。
- **首次列车等待**：只有新鲜、与包中节点名及 Source 相符的 `status/6..8` 视图明确报告 `STANDBY`、角色探测 `not-held`（无失败）、执行器 `IDLE`、`current=null`、`queue.live=0` 且 `pending` 无活动行时，才记录 `first-train-not-applicable`，不空等列车。`pending` 必须是至多100行的数组，只允许空数组或每行身份完整（正整数 PR、40位 head/base SHA）的 `DONE`/`STOPPED` 终态历史；任何活动、未知或畸形行都继续等待。状态必须在本阶段开始后刷新，且最多旧五分钟；角色探测最多旧十五分钟，沿用 standby 的探测节奏；两者都必须是带时区的完整 ISO 日期时间，最多超前三十秒。旧安装遗留但仍新鲜的视图也不会立即跳过。缺失、过期、不合形状、角色不确定或存在工作都保留原来的等待，每次轮询重新判断，不凭节点主机名或 `train.enabled`/`fullPending` 推断角色。报告保留该次观察值；它仅用于避免第一阶段空等，不授予角色或开工权限。无论观察到列车、此等待不适用或超时，原第二阶段仍要求 runner 使用原二进制、已停止且 PID 为零、executor 非 RUNNING，两次检查间隔五秒；未安静仍不运行 verify。完整 verify、暂停及 companion 后续安全门不变，已生成和授权的旧启动器不就地修改。
- **心跳令牌**（2026-10-31，模板 sha `5ff3a1c1`）：配置了 `heartbeat` 时，带令牌的 dry run 和 `-Apply` 再加 `-HeartbeatTokenFile`，配置了 `bindingId` 时再加 `-HeartbeatBindingId`。审过的计划（非提权、不带令牌）不变，卸载之前的 carry-forward 预览也不带心跳令牌。提权比对时把 `plan.heartbeatToken` 也剥出来逐项核对：目标是本包安装器的 `secrets\heartbeat\ci-node-heartbeat.token`、supplied、目标不存在、目录和两个 SDDL 与审过的计划相同、64 位 hex 指纹、verified、`bindingId` 恰好是配置的值；不对就报 `HEARTBEAT_TOKEN_PLAN_FIELDS_NOT_AS_EXPECTED`。没配置时这一项留在其余字段里，必须与审过的相同，和以前一样。生成器核对包的安装器支持心跳令牌（不支持时报 `PACKAGE_INSTALLER_HAS_NO_HEARTBEAT_TOKEN`），final 缺令牌文件时报 `HEARTBEAT_TOKEN_FILE_MISSING`。`HeartbeatBindingId` 在计划里的位置按 `plan.heartbeatToken.bindingId` 核对。
- **心跳令牌补装或换新（90 天到期）**：今天没有不重装的办法。`install-resident.ps1` 只做全新安装，目标已存在时拒绝（`HEARTBEAT_TOKEN_TARGET_EXISTS_NOT_OVERWRITTEN`）；升级通道不碰 `secrets`。所以补装或换新都要整套重装一次。要免重装，需要一个新的提权小工具（放在 `windows/`，要审核）：按安装器同样的规则核对目录和文件的 ACL，拒绝 CI 令牌和升级令牌，在同一目录里按文件 SDDL 写新内容再原子替换，写一份回执。服务端关联新连接（`/bindings/failover`）会替换旧的关联。这个工具这里没有做。

### 通用节点包：Linux A/B 在同一次 UAC 内执行（`--fleet-plan`）

接口见 `rollout/fleet/BATCH1-INTERFACES.md` 第 3、4 节。节点上由 `rollout/fleet/install.mjs prepare` 调用，不需要按节点的配置文件：

```
python -I launcher\generate.py --fleet-plan <install-plan.json> --out <launcher.ps1>
```

- 只出 final。钉住：包、三个 Linux 脚本的路径与哈希、脚本自己写明的入/出目录（`W=`、`O=`，三个脚本必须一致并与 plan 的 `inDir`/`wslInDir` 相符）、生成时 install-plan 的哈希、已装现场。**不钉** B 的输出。plan 的 `launcher` 字段由调用方在本工具返回后才填，所以启动器运行时不再读 plan；所需的值都在启动器自身（由运行命令核哈希）。
- 节点自己的值从节点读：包的 record（节点档案）；`companionAccount=true` 时读 `install\companion-account.json` 与 `install\companion-wsl.json`（operator、VHDX 目录；plan 与记录是否存在必须一致）；runner 的原始 binPath 取自包内安装器的常量，DACL 取现场 `sc sdshow`。
- 其余全部来自 plan，缺了即拒绝：`linux.outDir`（必须等于脚本的 `O=`，`FLEET_PLAN_OUT_DIR_NOT_THE_SCRIPTS`）；`secrets`（`source` 必须是 `installed`；`upgradeToken` 为 `{target, fingerprint}`，`heartbeatToken` 为 null 或 `{target, fingerprint, bindingId}`，取自已装回执；target 必须是本包安装器的令牌位置。不指名也不读取任何令牌文件）；`expectedInstalledLinux`（`generation`、`manifestSha256`、`ciSourceManifestSha256`，必须等于 A 脚本里的 `OLD_*` 值，否则 `FLEET_SCRIPTS_NOT_FOR_THE_PLANS_INSTALLED_LINUX`；A 以 root 在暂存任何东西之前核对现场）；`reasons`（恰 `pause`、`rearm`、`w1Pause`）；`launcher` 此时必须为 null。本工具没有令牌相关的命令行参数。
- 此路径不重建包、不读仓库、不要求预演报告（预演由 prepare 先跑并把关，`prep.py` 仍要求 24 小时内的 PASS 报告）；生成时不要求 W1 已暂停，但已有 `PAUSED.json` 时其 reason 必须是 plan 的 `reasons.w1Pause`（运行时 `Test-OldRootQuiet` 仍要求 `PAUSED.json`）。原有按配置生成的路径不变。
- 输出一行 JSON：`{status: FLEET_LAUNCHER_GENERATED, launcher: {path, sha256}, elevatedCommand, installPlanSha256, ...}`。

模板在 `$FleetPlanSha256` 非空时多出以下步骤，位置在暂存之后、卸载预检之前（`$Fleet*` 钉值在原有路径下全为 `$null`，这些步骤不运行）：

| 步骤 | 内容 | 停止码 |
|---|---|---|
| `Step-WindowsPreflightBeforeLinux` | Linux B 不可逆，所以卸载预检里不依赖 Linux 的只读检查先跑一遍：已装回执/卸载脚本/HALT/终态证据/runner/CI 根 DACL 等于钉值，已装卸载器 dry run 接受现状，新安装器 `-PreviewAfterUninstall` dry run 通过且卸载改不了的计划字段等于审过的，controller 服务登录权，两处秘密文件，旧根已暂停且无开放批次，可结转形状。报告文件另起名字；B 之后 `Step-UninstallPreflight` 照常完整再跑 | 与卸载预检相同的码，另有 `PARENT_ACL_NOT_AS_REVIEWED` |
| `Step-CarryTokens` | 把现装的升级令牌（和心跳令牌，若有）复制到新建的 `C:\ProgramData\CluedIndependentCI\reinstall-carry-<32hex>\`（仅 SYSTEM 与 Administrators），原件和副本都按 `tools/secret-fingerprint.mjs` 的公式算指纹，必须等于回执里钉住的值；副本路径交给安装器的 `-UpgradeTokenFile` / `-HeartbeatTokenFile`（`-HeartbeatBindingId` 取 plan）。副本不会留到本次运行之后：安装器跑完即删；任何停止（`Stop-Launch`）、任何异常（主 `catch`）和主 `finally` 都先删再写结局，`terminal.json` 的 `carriedTokens` 与 `carried-tokens-report.json` 记录目录、是否已删、删除失败时的异常类型。删掉不丢东西：卸载前现装令牌还在原位，卸载后在改名保留的 `resident-uninstalled-*` 里。断电等 `finally` 没跑的情况由下一次任何 launcher 运行的第一步 `Step-SweepCarry` 处理：逐个检查遗留的 `reinstall-carry-<32hex>`（ACL 是否仍只有 SYSTEM/Administrators、文件是否都是令牌形状），无论结果一律删除，并写 `carry-sweep-report.json`（目录名、条目数、两项判断、是否删除；不含内容）。卸载后安装器自己算出的指纹也必须等于钉值。令牌内容不进任何报告或输出 | `CARRIED_TOKEN_FINGERPRINT_MISMATCH`、`INSTALLED_TOKEN_NOT_A_PLAIN_FILE`、`CARRIED_TOKEN_COPY_FAILED` |
| `Step-FileLocks` | 把钉住的 `tools\file-locks.ps1` 复制进仅管理员的暂存目录，以提权身份只读观察；有 external 占用即停 | `EXTERNAL_RESIDENT_BINARY_LOCK`、`RESIDENT_FILE_LOCK_OBSERVATION_INVALID` |
| 目录 | 出目录必须为空，改为 Administrators 所有、受保护 DACL（SYSTEM/Administrators 全权，Owner 只读，companion 账户可写）；入目录给 companion 账户读权 | `LINUX_OUT_DIRECTORY_NOT_EMPTY` 等 |
| registrar | 仅 companion 节点：从本包的 `CompanionTaskRegistrar.cs` 编译（`New-CompanionBuildFromPackage`，两份文件都核包清单与钉值），结束时删除 | `LINUX_REGISTRAR_BUILD_FAILED` |
| A | `install\linux-run-<32hex>\script.sh`（仅管理员可写，复制后回读核哈希）、`out\`；companion 节点经 registrar `root-run`，其余节点由提权 Owner 直接 `wsl.exe --user root`，命令行相同 | `LINUX_PHASE_A_NOT_COMPLETED` |
| B | 同上；失败（非超时）时 B-resume 一次 | `LINUX_PHASE_B_NOT_COMPLETED` |
| 超时 | 任一步超时：只报告并停止，不杀进程，也不再跑后续脚本 | `LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED` |
| 核 B 输出 | B 最后一行给出的 evidence / versionFacts 必须是出目录下的规定文件名；evidence 恰一行 `sha256:` 等于包的 `ciSourceManifestSha256` 且有 `exit: 0`，恰一行 `package:` 等于本包；facts 合同为 `linux-version-facts/1`、`generation` 为整数 1、有 `staged` 且为 null、Source 与 Linux manifest 等于包、`pinsOk` 为 true | `LINUX_EVIDENCE_UNPARSABLE`、`LIVE_LINUX_SOURCE_NOT_THIS_RECORD`、`LINUX_ADOPTED_ANOTHER_PACKAGE`、`LINUX_VERSION_FACTS_NOT_THIS_PACKAGE` 等 |

通过规则的 facts 字节复制进暂存目录，之后的 verify `-LinuxVersionFactsFile` 用的就是这份。出目录是 launcher 自己在提权下新建的 `C:\ProgramData\CluedIndependentCI\reinstall-linux-out-<32hex>`（plan 的 `linux.outDir` 必须是这个形状且尚不存在，`prep.py` 不创建它）：路径上没有 Owner 的目录，Owner 会话无法替换它或其中的文件。每次运行的 `linux-run-<hex>\` 里有 `out\` 和 `captured\`：`out\` 下的 `stdout.txt`、`stderr.txt` 由 launcher 预建并各自带受保护 ACL（companion 只有写入/追加，不能删除、替换或改 ACL），`out\` 对 companion 只读；`captured\` 只有 SYSTEM 与 Administrators。进程结束后由 registrar 把两个文件抓进 `captured\`：以不跟随链接的方式打开（`FILE_FLAG_OPEN_REPARSE_POINT`），按句柄核对不是重解析点、不是目录、链接数为 1、不超过 4 MiB，否则拒绝且不读内容。抓取被拒时 registrar 仍输出 `ROOT_RUN_EXITED <code>`，另附一行 `CAPTURE_REFUSED <CODE>`：B 的输出抓不到不算"B 未完成"（不会跑 B-resume），launcher 以 `LINUX_PHASE_B_OUTPUT_NOT_CAPTURED` 停，由续行用 `capture-file`（来源可为运行目录自己的 `out\stdout.txt`/`stderr.txt`，目标为提权新建的 `captured-<32hex>\`）去抓取和核对；A 同理为 `LINUX_PHASE_A_OUTPUT_NOT_CAPTURED`。`Get-FleetRunProcesses <运行目录>`（CIM，只读）列出命令行仍含该运行目录的进程及其是否属于 companion，供续行区分"还没写完"和"进程已不在"。companion 节点上 launcher 只读 `captured\`，不再按路径读 companion 可写的位置；B 的 evidence 与 facts 同样先经 registrar 的 `capture-file` 抓进 `captured\` 再读。非 companion 节点上这些位置本来就只有 SYSTEM 与 Administrators 可写，直接受检读取。

**写入探针（仅 companion 节点，`Step-LinuxOutAclProbe`）**：在 A 之前、任何改动之前，launcher 用与真实运行同一个函数建一个 `install\linux-run-<32hex>-probe\`（目录、预建文件、`captured\`、ACL 逐字相同），由 registrar 的 `write-probe` 以真实的 companion 身份（沿用 root-run 的全部前置）执行 `cmd.exe /d /c "echo x> out\stdout.txt 2> out\stderr.txt"` 并照样抓取。通过条件：退出码 0、抓到的 stdout 恰为 `x`、stderr 为空、`out\` 与两个文件的属主和 DACL 未变。不过即停 `LINUX_OUT_ACL_PROBE_FAILED`，`linux-out-acl-probe-report.json` 写明哪一项；探针目录无论结果都删除。

**停在"节点尚未改动"时自动解除 W1 暂停（`Restore-W1Pause`）**：从进入通用包步骤到 A 启动之前（Windows 预检、令牌带入、文件锁、registrar 构建、写入探针），以及 registrar 在运行任何东西之前就拒绝了 A 的情况，停止时 launcher 通过已装常驻自己的恢复入口（`rearm-resident.ps1 -Request Resume -ExpectedPausedSha256`，服务端自己核对）解除暂停。只在 `state\PAUSED.json` 的 sha 等于钉住的本次 W1 暂停、且 reason 等于 plan 的 `reasons.w1Pause` 时才动，别的暂停绝不碰。结局的 `w1Pause` 写明 `restored` 或原因（`PAUSE_NOT_THIS_LAUNCHS_LEFT_AS_IT_IS`、`INSTALLED_RESUME_DOOR_NOT_AS_REVIEWED`、`RESUME_REQUEST_REFUSED`、`RESUME_REQUESTED_NOT_CONFIRMED_IN_TIME`）。A 启动之后的停止不解除暂停，走续行。两点限制：
- 只有 registrar 在**改口令之前**的拒绝才算"节点未改动"（`Test-FleetRefusedBeforeAnyChange` 白名单：参数、提权、节点档案、账户、WSL 客户端、`ROOT_RUN_SCRIPT_*`、`ROOT_RUN_DIRECTORY_*`、`ROOT_RUN_PATH_REPARSE_REFUSED`、`TASK_FOLDER_MISSING`、`COMPANION_SWITCH_IN_PROGRESS`、`COMPANION_TASK_*`、`ROOT_RUN_TASK_DEFINITION_DIFFERS`）。任务被停放（`*_PARKED`）、退出码读不到、口令没设上、回读不符等一律不解除，结局写 `w1Pause.reason = NOT_LIFTED:<原因>`；写入探针同样按码区分（探针进程确实跑了、只是写入或 ACL 不过的，属于可解除）。
- `Step-Package`、`Step-Stage` 在通用包步骤之前，它们失败时（包被改动、暂存目录 ACL 不符）暂停**不会**自动解除：重跑 prepare 即可（`pause-old-resident.py` 认得自己的暂停）。

**`--check`**：`generate.py --fleet-plan <plan> --check` 在 W1 之前做生成前的全部检查（此时 plan 的 `w1Paused` 必须为 null），不要求已暂停、不写启动器，输出 `FLEET_PLAN_CHECK_PASSED` 或拒绝原因。不带 `--check` 时要求节点已被 plan 的 W1 暂停所暂停：`PAUSED.json` 存在、sha 等于 `w1Paused.sha256`、reason 相同（否则 `OLD_RESIDENT_NOT_PAUSED`、`OLD_RESIDENT_PAUSE_NOT_THE_PLANS`、`OLD_RESIDENT_PAUSE_NOT_THE_W1_ONE`）。

**每次运行的第一步清扫**：除遗留的令牌带入目录外，也清掉更早运行留下的 `reinstall-linux-out-<32hex>`（只有公开数据；记录目录名与条目数），但不动本 launcher 自己钉住的那个（B 超时后的续行要从里面读 B 的输出）；以及更早运行的进度记录 `reinstall-progress-<32hex>`（已完成的，或被本次运行取代的；记录是否完成），但不动本 launcher 所续行的那次运行的记录，也不动自己 launch 目录对应的那份（同一个 launcher 被误启动第二次时，第一次的记录必须留着）。

**如实写明的残余**：companion 账户（即发行版里的 root）能写 `stdout.txt` 的内容，也能写出目录里的 evidence 与 facts，所以它能伪造"B 已完成"的状态行和通过规则的输出。这与已经给予该发行版的信任等同（它就是执行 B 的身份），规则核对和最后 verify 的两侧一致性检查之外不再设防。此类启动器不支持 `resume.py`（`FLEET_LAUNCH_RESUME_NOT_SUPPORTED`），续行见下。

**运行器先等再判（`Wait-RunnerState`，DESIGN §73）**：暂停只停批次；当班节点在暂停下仍为角色探测、队列观察、第 10 段只撤销临时把运行器换成 controller，结束后换回原样。`Step-WindowsPreflightBeforeLinux` 与 `Step-UninstallPreflight` 在 `$RunnerSettleSeconds`（600 秒）内每 2 秒读一次，按最后一次读数判 `RUNNER_SERVICE_NOT_AS_REVIEWED`（2026-11-13 desk-w-591：一次读在交换中间的读数让启动器停在 Linux B 之后）。

#### 中途停止或断电后的续行（`--fleet-continue`）

**W1 暂停**：旧常驻还在的模式（`before-uninstall`、`b-timeout`、`a-timeout`）里，现场 `state\PAUSED.json` 不是启动器钉住的那份时（停下之后被人解除），生成器用启动器自己的 W1 reason 重新请求（`tools/pause-old-resident.py`，与 `prepare` 相同，等到 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`），并把续行启动器的 `$InstalledPausedSha256` 钉成现在这份；输出里 `w1PausedAgainSha256` 非空。别的请求的暂停照旧拒绝（`W1_PAUSE_NOT_CONFIRMED`，detail 是该工具自己的报告）。

```
python -I launcher\generate.py --fleet-continue <上次的 launcher.ps1> --out <新 launcher.ps1>
```

每台节点命令相同，不带节点值：一切取自上次 launcher 的钉值、它的 launch 目录（停止时的 `terminal.json`；每完成一步就落盘的进度记录）和节点现状。实现在 `launcher/continue.py`（生成，非提权，只写新 launcher；模板与注入片段各有 sha 钉值）和 `launcher/continue-install.ps1`（注入的步骤）。输出一行 JSON：`FLEET_CONTINUATION_GENERATED`（含 `mode`、`launcher.{path,sha256}`、`elevatedCommand`、`launchDir`）或 `{status: REFUSED, code, detail}`（退出码 3）。

**进度记录**：launcher 每完成一步，以 create-only 写两份 `NNN-<步骤>.json`：`<launch>\progress\` 和提权侧的 `C:\ProgramData\CluedIndependentCI\reinstall-progress-<id>\`（id 为 launch 目录路径的 SHA-256 前 32 位）。记录含步骤、序号、进程号与启动时间、钉值。断电（没有 `terminal.json`）时按它判断停在哪一步；续行运行时以提权侧那份为准，并拒绝上次进程仍在运行的情况。

按"最后完成的步骤"决定从哪里接着跑：

| 上次停在 | mode | 续行做什么 |
|---|---|---|
| B 输出已核对、卸载未开始（含断电） | `before-uninstall` | 跳过 Linux；重核上次保存的 B 输出；提权文件锁；从现装根带令牌；从 `Step-UninstallPreflight` 起是原文。此时 Linux 已是新代、Windows 仍是旧装：同一个包只能续行（`prepare` 拒绝 `LINUX_SIDE_ALREADY_THIS_PACKAGE_CONTINUE_THE_STOPPED_LAUNCH`）；更新的包可以直接 `prepare`（DESIGN §73） |
| A 超时 | `a-timeout` | 续行运行时由提权侧看上次 A 的 stdout/stderr：非 companion 节点直接读运行目录 `out\`；companion 节点先由 registrar `capture-file` 把 `out\stdout.txt|stderr.txt` 抓进本次续行在同一运行目录下新建的 `captured-<32hex>\`（仅 SY/BA）再读，抓取 create-only，每次续行一个新目录，旧的留作证据。末行已是 `PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED` → 其余全按原文重跑（Linux 前的 Windows 预检、带令牌、文件锁），`Step-LinuxRoot` 原样跑 B（B 自己按 `phaseA.sha256` 核对），只是其中 A 换成上次那次、出目录改为核对它就是上次建的。判读顺序：先按 `Get-FleetRunProcesses`（template）问该运行是否还有进程：有 → `LINUX_PHASE_STILL_RUNNING_RETRY`（稍后再跑同一条命令，什么也不读），查询失败 → `RUN_PROCESS_QUERY_FAILED`（不当作没有进程）；没有进程才抓取并读：registrar 拒绝抓取 stdout → `LINUX_PHASE_OUTPUT_NOT_CAPTURED`（报告里记 registrar 的拒绝码），读到终态照常往下，末行 REFUSED → `LINUX_PHASE_A_FAILED_AFTER_ITS_TIMEOUT`，其它（没有终态行）→ `LINUX_PHASE_ENDED_WITHOUT_STATUS`（硬失败，不无限重试）。A 已跑过，续行一开始就解除 W1 暂停的自动恢复 |
| B 超时，或 B 的输出 registrar 拒绝抓取（`LINUX_PHASE_B_OUTPUT_NOT_CAPTURED`，最后一个 run 为 EXITED 且带 `captureRefused`） | `b-timeout` | 跳过 Linux；B 的 stdout 按上一行同样的方式读与判定（B 的终态是 `LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1`，REFUSED → `LINUX_PHASE_B_FAILED_AFTER_ITS_TIMEOUT`）；evidence/facts 经模板的 `Read-FleetOutFile` 读，companion 节点抓进同一个本次的 `captured-<32hex>\`；过规则后提权文件锁、从现装根带令牌，从 `Step-UninstallPreflight` 起是原文 |
| 卸载半途：quiesce 已完成，已装卸载器 `-Apply` 失败（`UNINSTALL_NOT_COMPLETED`，且证据正是 §4.1 `resume.py` 审过的那种） | `inside-uninstall` | 跳过 Linux 与卸载；重核上次保存的 B 输出；根目录尚未改名，所以**在改名之前**从现装根带令牌（指纹不符即停，节点保持原样，可再生成同一续行）；随后由 `resume.py` 已审的 `Step-FinishUninstall`（`finish-uninstall.ps1` 原样注入、另钉 sha）重核 §4.1 的全部现场条件，只补同目录 rename 和原计划摘要的卸载回执；从 `Step-Preflight` 起是原文 |
| 卸载半途且断电（无 `terminal.json`，最后一条进度是 quiesce） | 按现场判定 | 生成时非提权只读看现场（`sc query` 三服务、根目录是否在）：三服务都在且根目录在 → `before-uninstall`（从卸载预检重来，已停的服务算已 quiesce）；根目录在、服务已删（全部或部分）→ `inside-uninstall`：由 `resume.py` 的 `Step-FinishUninstall` 在提权侧重证 §4.1 全部守卫（还有服务在就以 `RESUME_SERVICES_NOT_ABSENT` 停），上次卸载的计划取它自己的 dry run （`uninstall.dry-run.stdout.json`，`-Apply` 之前写下）代替 terminal，回执里记 `priorDryRunSha256`；三服务都已删、根目录已改名、最新保留目录晚于那条 quiesce 记录 → `after-uninstall`，回执由提权侧按同一 dry run 的计划摘要核对；其它（服务状态不明、或已改名但还有服务）→ `PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN`，detail 写明看到的状态。任何续行运行时都先确认没有 `uninstall-resident.ps1` 进程还在跑（`CONTINUE_UNINSTALL_STILL_RUNNING`） |
| 卸载已完成、安装未完成（含断电） | `after-uninstall` | 跳过 Linux 与卸载；核对保留目录；从保留目录的 `secrets\` 带令牌；从 `Step-Preflight` 起是原文 |
| 安装已完成，之后首列车等待、verify、pause、companion、rearm、CompanionHeadless 任一未过（含断电） | `after-install` | 不重装、不带令牌。按进度记录和各步报告定出第一个未过的步骤（`$ContinueAfterInstallFrom`），从它起是原文的行，每步可重复（首列车等待、verify、companion 任务（IgnoreNew）、rearm、CompanionHeadless）或先核对已完成再跳过（pause：`PAUSED.json` 已指向本启动器那条固定内容请求的 sha 则不再写请求）。它之前已过的步骤在提权侧重核：现装回执等于上次安装留的回执；首列车报告 `runnerQuiet`；上次 verify 输出 `RESIDENT_VERIFIED`；`PAUSED.json` 仍指向上次的暂停请求；companion 再启动一次（运行中即无操作）；rearm 取上次报告。从 pause 及之前接着跑而 resident 服务已停：只有上次自己停的（进度里有 `pause-not-confirmed-resident-stopped`）才重新启动，否则停止 |

**本版不续行、明确拒绝的情况**（都是告警，不是静默口子）：
- A 未完成即停（`PRIOR_LAUNCH_STOPPED_BEFORE_LINUX_PHASE_A_COMPLETED_PREPARE_AGAIN`）：节点没有任何改动，重新 prepare（新后缀）。
- A 完成、B 与 B-resume 都失败（`PRIOR_LINUX_PHASE_B_DID_NOT_COMPLETE_NODE_STAYS_PAUSED`）：节点保持暂停、Windows 侧未动，需要人按 root 脚本自己的恢复说明处理。launcher 只在 B 运行并以非零退出时才跑一次 B-resume；被拒绝或结果不可读的 B 不会被续跑。
- 卸载半途但不是 `resume.py` 的情形：断电且现场不是上表两种之一（`PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN`）；在 `-Apply` 之前或之后被检查停下（`PRIOR_LAUNCH_STOPPED_INSIDE_THE_UNINSTALL_NOT_A_FAILED_APPLY`，码在 detail）；终结证据不合 `resume-evidence.py` 的规则（`PRIOR_UNINSTALL_NOT_RESUMES_CASE`，原规则码在 detail）；续行运行时现场不合 §4.1（`RESUME_*`）。
- 安装之后：全部已过（`PRIOR_LAUNCH_COMPLETED_NOTHING_TO_CONTINUE`）；上次走的是 `-CompanionMaintenance` 路径（`PRIOR_LAUNCH_RAN_COMPANION_MAINTENANCE_NOT_CONTINUED`）；进度与报告互相矛盾（`PRIOR_POST_INSTALL_RECORDS_INCONSISTENT`）；运行时现装不是上次那次安装（`CONTINUE_INSTALL_NOT_THE_PRIOR_LAUNCHS`）、暂停已不在（`CONTINUE_PRIOR_PAUSE_NO_LONGER_IN_FORCE`）、resident 被别人停了（`CONTINUE_RESIDENT_STOPPED_NOT_BY_THE_PRIOR_LAUNCH`）。断电后不知道 companion 是否已启动时从 companion 起（可重复）。

其它拒绝：上次 launcher 不是本模板原样或不是通用包 launcher；进度记录与 `terminal.json` 不一致（`PRIOR_PROGRESS_NOT_THE_TERMINALS`）；卸载报告不是钉住的那次安装的；保留目录不在或不是最新的 `resident-uninstalled-*`（更早的保留目录是正常的）；上次保存的 B 输出不是其报告记的字节或不再过规则。

**续行可以再续行**：`--fleet-continue` 的输入也可以是上一次生成的续行启动器，与原启动器同等工作。生成器把它读回成“原启动器的钉值 + 续行钉值”，并要求用同一段代码对其重新生成得到逐字节相同的内容，否则 `PRIOR_LAUNCHER_REFUSED`（`NOT_A_CONTINUATION_OF_THIS_TEMPLATE`）；进度记录、钉值、证据都跟着上一次续行的 launch 目录走。为此每个续行步骤都把后续续行要读的证据写进自己的 launch 目录（`linux-report.json`、`uninstall-report.json`、安装后沿用的各步报告与 `install-receipt.json`），沿用的安装后步骤也记进度；续行步骤自身的进度记录（`continued-*`）代表它跳过的那些原步骤。上一次续行在它自己的步骤完成之前就停了（A 超时续行：在它的 B 之前）则它什么也没改，直接续它所续的那次（输出 `skippedContinuationLaunchDir`）。`install-plan.json` 若在旁边，核对的是链首原启动器的哈希（`$ContinueRootLauncherSha256`）。上一次续行若已做了不可撤的改名（进度里有 `uninstall-finish-only` 或 `uninstall`，或它是卸载半途续行且根目录已不在），则不跳过它，而按 `after-uninstall` 续它本身：保留目录取它的 `uninstall-report.json`；没有就取 `finish-uninstall-report.json`；都没有（改名后、记录前断电）就取晚于它最后一条记录的最新保留目录，回执按它钉的 `$ResumeUninstallPlanSha256` 在提权侧核对。

### 4.1 只完成先前卸载的目录改名

`launcher/resume.py` 仅处理同一模板生成、已经审过的 final 启动器在 `UNINSTALL_NOT_COMPLETED` 停下，且旧 resident 根目录仍存在的半卸载。原启动器、原终结记录和原预检查都保留；已有成功卸载回执或根目录已经改名的情况会拒绝。

```
python -I launcher/resume.py --launcher <原启动器> --launcher-sha <原生成回执中已审的SHA256> \
  --prior-dir <原launch目录> --launch-dir <原workDir下的新目录> --out <原workDir下的新ps1>
```

`--launcher-sha` 必须来自已核对的原生成回执，不能对来历不明的脚本现算摘要来替代原审批。生成器核对模板主体和只含字面量的 pins，绑定原 Source、包提交与失败步骤，钉住五份原公开报告，并生成新的脚本和摘要校验命令；它不执行、不提权，也不授予包或 Source 的接受权限。输出仍需完整独立复核和适用的 Owner 执行授权。

新入口在实际改名前重新核对三服务都已删除、companion task 与旧防火墙规则已删除、runner 原样停止、无进程或批次、账本/暂停/HALT/安装回执/旧卸载器字节与原 pins 一致、无升级操作、spool 空及权限/秘密目标/携带状态预检查。只补同目录下的 rename 和原计划摘要的卸载回执，不重跑卸载、停止/删除服务或修改配置。随后继续原包的安装、verify、暂停、companion 与 rearm 流程；原流程的其余代码不变。

## 5. 对已装现场的全量只读预演：`rehearse.py`（预演不过不出 final）

Windows 预演还通过 Restart Manager 只读检查已安装公开二进制（`bin`、`runtime`、`broker/bin`、`upgrader/runtime` 的 exe/dll）。发现外部占用进程时报告 `EXTERNAL_RESIDENT_BINARY_LOCK`；观察失败时也记 finding，不把未知当作无占用。预期服务、companion host 及其当前子进程仍以 PID 和进程启动时间复核。探针不停止或重启进程，不枚举秘密、账本或工作目录。

服务身份绑定前后两次 SCM 服务名/PID 和进程创建时间，不要求普通用户能读 `ExecutablePath`。优先使用仅 `PROCESS_QUERY_LIMITED_INFORMATION` 的原生查询；加固 DACL 连此查询也拒绝时，用系统 CIM provider 的创建时间和即时重查，明确按微秒（10个 FILETIME tick）与 RM 对齐，报告 `identityPrecisionTicks`。缺创建时间、PID重用、进程已退出或重查失败仍不能豁免。companion 的根绑定固定注册任务的两次运行实例 GUID、EnginePID、状态和 action 路径，支持实际 conhost 形态；同名 conhost/JobHost 或仅凭相邻 PID 不构成身份。子进程仍须核父子创建时序及当前身份。

账户所属 companion 任务可能对非提权 Operator 拒绝读取。仅确切的 `E_ACCESSDENIED`（包括 PowerShell 的异常包装）会记录为 `companionTaskObservation` 的 `UNREADABLE` / `COMPANION_TASK_ACCESS_DENIED`；整次任务观察原子丢弃，不保留异常前得到的部分实例。它不意味着任务不存在或进程可信，也不会绕过 Restart Manager：公开文件的真实占用仍全部扫描；没有独立核实身份的锁持有者及其子进程仍为 external，从而产生原 `EXTERNAL_RESIDENT_BINARY_LOCK` finding。两次观察只要有一次不可读，就没有 companion 任务身份豁免；独立 SCM 身份检查保持。任务不存在、其他 COM 错误及非权限观察失败仍直接失败，不作为无占用。只有真实扫描未发现外部占用时，这项公开文件占用检查才可通过；它不证明 companion 运行资格。探针不提权、不改任务 ACL 或状态。

companion 专用账户节点（M5-b，见下文"companion 账户节点"）上，公开二进制被该账户的 `CluedCompanionSupervisor.exe` 和 `runtime\node.exe` 占用，它们仍记为 external，报告的 finding 另带 `companionProcessIdentity=UNREADABLE_NON_ELEVATED`。原因是非提权 Owner 在 Windows 11 上读不到另一本地账户进程的可核身份（DESK 2026-11-12 实测）：对这些进程 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` 返回 `ERROR_ACCESS_DENIED`，因此无法 `OpenProcessToken` 取 owner SID；CIM `Win32_Process.GetOwnerSid` 返回 2（拒绝访问），`ExecutablePath` 为空；`WTSEnumerateProcessesEx` 对这些进程给出空 `pUserSid`；账户的计划任务又是 `COMPANION_TASK_ACCESS_DENIED`。仅 `NtQuerySystemInformation(SystemProcessIdInformation)` 能读到映像路径，但路径或名称不是身份，不据此豁免。`tools/file-locks.ps1` 因此不变，fail-closed 规则不放宽；这项 finding 需提权观察或 companion 自己公开可核身份后才能消除。

只读 API 依据：[GetProcessTimes](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)、[Win32_Process](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-process)、[CIM_DATETIME](https://learn.microsoft.com/windows/win32/wmisdk/cim-datetime)、[IRunningTask.EnginePID](https://learn.microsoft.com/windows/win32/api/taskschd/nf-taskschd-irunningtask-get_enginepid)。

此检查只覆盖已登记的公开二进制文件。Restart Manager 不接受目录资源，因此它不能证明不存在目录句柄或整个 resident 目录一定能改名；报告明确写出 `directoryHandlesCovered=false`，正式卸载仍须取得原有的精确改名与保留证据。

```
python -I rehearse.py <本机生成的配置> --commit <40hex> --package <包目录>
```

非提权、只读。每一项都直接运行节点上的真实工具或读取真实文件，不一致的地方就记为 finding（差异清单）。linuxHost 探查以 root 运行；显式快照恢复还会以 root 调用既有冻结工具的只读 `version-facts` 命令作现场复核，两者均不签名、不切代、不修改安装状态，git 不取可选锁。

当 companion 未运行、默认 `upgrade/mailbox/responses/version-facts.json` 不存在时，可使用从原冻结工具采集、未经重编码或改动的 stdout 文件：

```
python -I rehearse.py <本机生成的配置> --commit <40hex> --package <包目录> --linux-version-facts <原始版本事实快照文件>
```

默认文件和显式快照都按 32 KiB 上限读取，校验合同、固定三角色及全部摘要形状、正整数代数、`pinsOk=true`、无 staged、带时区的 `observedAt`（最多一小时旧、最多三十秒超前）。缺失、不可读、坏 JSON、过期或不合形状都成为明确 finding，不抛出文件缺失回溯。显式快照另经配置发行版的现装冻结工具 `/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux version-facts` 真实复核：以隔离环境调用 `/usr/bin/python3.12 -I`，退出非零、超时或观察无效均拒绝；除两次采集时间外，每一业务字段都必须相同。现装工具的 `pinsOk` 同时核对现装 resident 和冻结升级工具 manifest；这里比较的是快照与现装工具摘要，不要求等于新提交的工具，因为全量重装可以更换冻结工具（普通原地升级的门不同）。快照路径和文件时间本身不构成真实性证明。报告保留输入原字节 SHA-256、来源、现场复核摘要及观察时间；不把快照写回 mailbox，不改 JSON、钉值或签名。原有代记录、公开副本摘要、真实 host 探针和普通用户角色派生检查仍全部执行。超过时限应重取真实事实，不能修改时间戳。此输入只用于预演，不替代 Linux B 的事实、最终精确包验收或系统授权。

| 检查 | 内容 |
|---|---|
| uninstall | 运行**已装的** `uninstall-resident.ps1` 做真实 dry-run：plan 合同必须是模板 `Test-UninstallPlan` 接受的那一版，模板读到的字段都要在；不能有记录中的升级 op；`upgraderService` 必须与服务实际是否存在一致，且为 true（模板要求） |
| upgrader | 装着 CluedCIUpgrader 时，模板的停服步骤必须经 SCM 停它 |
| verify | 新包的 `verify-resident.ps1` 输出形状（`status` 和 `checks.*.ok`）必须是启动器读的那样。已装的 verify 也真跑一次：不提权时它会被管理员专属文件挡住，此时只记为"未提权不可运行"，不算 finding；能跑出结果时，必须是 VERIFIED 或 PARTIALLY |
| status | `state/status.json` 的 `writtenAt`、`executor`、`current`、`halt`；`upgrade/status.json` 里没有 op；`upgrade/current.json` 的合同 |
| linux | 默认 Windows 侧的 Linux version facts（`upgrade/mailbox/responses/version-facts.json`），或经现装冻结工具现场复核的显式快照，与现装代记录一致；配置里 root 复制的 Linux manifest 和 roles-v3 就是现装的（与 facts 里各项 sha 比对）。companion 账户节点上角色副本改取 companion 的公开副本（见下） |
| pins | 包里 Linux 常驻 manifest 的外部钉值：形状与已装一致，`source-v2` 钉值等于新提交里的文件 |
| linuxHost | 以 root 只读：对已装角色策略运行第 A、B0、B4 步会用的 `linux/tools/check-host.py`，钉值取配置的 `linux.host`；Source v1 的 HEAD 等于配置值；签名工具要读的 v1 qualification 都在（只查是否存在；签名和事实由第 B1 步签名工具核对，B1 在切换 Source 之前）。配置的 v1 HEAD 为 null 时：v1 的三处（`source-first-formal-v1`、`roles`、`formal-source-manifest-v1.json`）都不存在（否则 `LINUX_NODE_HAS_A_SOURCE_V1_NOT_CONFIGURED`），`roles-v3` 的三份 qualification 都在（否则 `LINUX_INSTALLED_V2_QUALIFICATIONS_MISSING`）。companion 账户节点上不运行，见下 |
| roles | 以普通用户在节点的 WSL 发行版里，对副本运行第 A 步会用的 `linux/tools/derive-roles.py`。必须成功，被重钉的 Source 文件逐个列出。默认使用发行版默认用户；可用 `linux.rehearsalUser` 显式指定已有普通用户（如 `nobody`），只影响本项，不修改发行版默认用户、账户或权限。真实 UID 或 EUID 为 0 时仍拒绝运行。companion 账户节点上改用本机 Windows Python，见下 |
| node | 包里的节点档案就是配置所指的那份 |

报告（`clued.independent-ci.reinstall-rehearsal/1`）只新建、不覆盖，写在 `workDir\rehearsal\`。

`linux.rehearsalUser` 可省略或为 null；字符串只接受普通用户名形状，拒绝 `root`、数字 UID、空白、路径和选项。角色预演仅读取公开副本与已接受 Git 内容，在随机 `/tmp` 目录写入后清理；权限不足继续拒绝，不回退 root。报告的 `checks.roles.runAsUser` 记录所选用户，配置原字节仍绑定 `configSha256`；此配置不进入运行包或 Source 闭包。`linuxHost` 的既有 root 只读探针不变。

### companion 账户节点（M5-b，ADR 0023；按记录判定，各节点通用）

节点有 `install\companion-account.json`（`clued.independent-ci.companion-account/1`）或 `install\companion-wsl.json` 任一时，即按 companion 账户节点预演。常驻发行版注册在 companion 账户下，Owner 自己的 WSL 看不到它，所以预演**完全不调用 wsl**（不调用 `wsl_python`，也不调用显式快照的现场复核）。

- 两份记录严格核对，不合即 finding（fail closed，不回退到 Owner 的 WSL）：账户记录恰为 `contract`、`companionSid`、`operatorSid` 三键，无重复键，两个 SID 为本地用户 SID 形状且不相同，`companionSid` 等于节点档案的 `ownerSid`（否则 `COMPANION_ACCOUNT_RECORD_REFUSED`，`reason` 为 `MISSING`/`SHAPE`/`COMPANION_NOT_THE_PROFILE_OWNER`/`UNREADABLE`）；WSL 记录合同为 `clued.independent-ci.companion-wsl/1`、`stage=qualified`、`distro` 等于配置的发行版、`companionSid` 等于账户记录（否则 `COMPANION_WSL_RECORD_REFUSED`，`reason` 为 `MISSING`/`SHAPE`/`NOT_QUALIFIED`/`NOT_THIS_DISTRIBUTION_AND_ACCOUNT`）。配置的 `operatorSid` 不等于记录时为 `COMPANION_ACCOUNT_NOT_THE_CONFIGURED`。
- linux：facts 仍用默认的 Windows 侧副本，原有检查全部保留。角色文件改取 companion 的公开副本 `upgrade\mailbox\responses\roles-public.json`（`clued.independent-ci.linux-roles-public/1`）：形状、无重复键、规范 base64、每个文件的 sha256 等于其条目（否则 `ROLES_PUBLIC_COPY_INVALID`），`generation` 等于 facts（否则 `ROLES_PUBLIC_COPY_OTHER_GENERATION`），每个文件等于 facts 里的 policy/qualification sha（否则 `ROLES_PUBLIC_COPY_NOT_THE_FACTS`）；缺失或不可读为 `ROLES_PUBLIC_COPY_MISSING`/`UNREADABLE`。配置 `linux.installedRoles` 里有同名文件时必须逐字节相同（否则 `INSTALLED_ROLES_COPY_NOT_THE_COMPANION_COPY`）；`formal-source-manifest-v2.json` 仍取配置目录并照旧比对 facts。报告 `checks.linux.rolesCopySource=companion-roles-public`。
- roles：同一个 `linux/tools/derive-roles.py`（字节不改）由本机 Windows Python `-I` 运行，输入是上述公开副本写入的私有临时目录，结束后连同工具的只读输出一起删除。runner 只补工具的 POSIX 专用部分：先拒绝提权令牌（`REHEARSAL_RUNNER_IS_ELEVATED`，对应 WSL 的拒绝 root），再模拟 `geteuid`；Windows 没有 `O_NOFOLLOW`，工具在新建私有目录里的 `O_CREAT|O_EXCL` 改带 `O_BINARY`；工具固定的 `/usr/bin/git` 换成 PATH 上的 Windows git（工具自己的干净环境和参数不变；找不到 git 为 `WINDOWS_GIT_NOT_FOUND`）。成功/拒绝语义和报告字段与原来相同，`checks.roles.runAsUser=windows-non-elevated-operator`。公开副本未通过时不派生，记 `ROLE_DERIVATION_NOT_REHEARSED`。
- linuxHost：不运行，报告 `{"deferredTo": "launch-phase-A", "reason": "COMPANION_ACCOUNT_DISTRIBUTION"}`，不算 finding：启动时第 A 步以 companion 账户、root 身份在任何改动之前先跑 check-host 和角色派生。
- 显式快照 `--linux-version-facts` 无法不经 wsl 现场复核，记 `LINUX_FACTS_LIVE_OBSERVATION_UNAVAILABLE`（`reason=COMPANION_ACCOUNT_DISTRIBUTION`）；此类节点用 companion 写的默认 facts。
- 其余检查不变；文件占用见上文（companion 进程仍为 external）。没有这两份记录的节点行为与之前完全相同。

`--fleet`（通用节点包的 prepare 使用）必须与 `--file-locks-in-launcher` 同时给（否则参数错误）：已装 Linux manifest 的字节在 Windows 侧不存在，配置里的 `linux.installedManifest` 指向的文件可以不存在，这项记为 `checks.linux.installedManifestCopy = {deferredTo: linux-phase-a, expectedSha256}`，不算 finding，由 Linux A 以 root 核对现场 manifest（外部钉值在这里只核"source-v2 条目等于新提交的文件、toolchain node 等于配置值"，形状与其余条目由 A 核）。

`--file-locks-in-launcher`：companion 账户节点上，非提权观察到的 external 占用不再记 finding，改记 `checks.fileLocksFinding = {deferredTo: launch-elevated-file-locks, ...}`，由启动器在 UAC 内以提权身份重查（`Step-FileLocks`，有 external 即停，早于任何改动）。观察本身无效仍是 finding；模板没有该步骤时为 `LAUNCHER_HAS_NO_ELEVATED_FILE_LOCK_STEP`；没有 companion 记录的节点不受此开关影响。

r7 那次三回被拒，都能被预演提前抓到，`test/test_rehearse.py` 里有对应的回归测试：

| r7 被拒 | 预演的 finding |
|---|---|
| Linux 常驻 manifest 沿用了已装的外部钉值，而新提交改了这些文件 | `LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE` |
| 角色派生拒绝新提交改动过的 Source 文件（`PINNED_FILE_CHANGED_IN_NEW_COMMIT_REPIN_NEEDED`） | `ROLE_DERIVATION_REFUSED`，并带出被拒的 key |
| 启动器只认卸载计划 /2，而已装工具输出 /3 | `UNINSTALL_PLAN_CONTRACT_NOT_ACCEPTED_BY_LAUNCHER` |

## 6. Linux 套件：`linux/assemble.py`、`linux/prep.py`、`linux/tools/`

- `assemble.py`：组装 `workDir\linux\<in>`。内容包括：
  - 包里的 record 和 Source v2 安装器；
  - `linux-pkg/upgrade-v1/**`、`linux-res-pkg/**`；
  - 树里的 install、verify、uninstall-resident-linux.sh；
  - `linux/tools/` 下审过的辅助工具；
  - 一个裸仓库，HEAD 和唯一的 ref 都是 `refs/heads/accepted`。
- `prep.py`：生成三个脚本 `reinstall-linux-{A-stage,B-switch,B-resume}.<suffix>.sh`。
  - 当前 BASE 为 `/root/clued-ci-reinstall-<c8>-<suffix>`；重试换后缀和新入口，旧失败目录/日志原位保留，不为重跑移动或删除它们。
  - 升级工具会保留隐藏的 `.tool.lock`，卸载计划的 `ls -1` 不显示它。历史检查只允许这一已知隐藏文件，并以只读打开、非阻塞独占锁确认空闲；占用、链接或未知隐藏文件仍拒绝。锁文件也纳入完整历史快照并随旧目录保留，不删除或重建。
  - 已做过升级的节点可以保留 `generations/gN`、archive 和 upgrade-state：A 仍要求 staging 为空、facts 当前代一致/pinsOk/staged=null，并核对当前代记录及 Windows 公开升级状态（op=null、5分钟内）。新增只读历史检查器记录各保留目录的完整 lstat 元数据（含 inode/mode/size/mtime，不扫描历史 payload 内容）；B 在任何 Source 切换前核原现场未变，卸载后核证据目录中的完整树。当前已接受的卸载器以 `mv -n` 整体保留这些目录，不修改它、不改变运行 Source；跨文件系统复制或不完整保留会拒绝后续安装。
  - "已装状态"不再写死，取自节点自己的 version facts 和第 1 代记录（两份文件的副本）。
  - 非 `draft*` 后缀（即 final）必须附上 24 小时内的 PASS 预演报告。`draft*` 脚本只供审阅，脚本自己一开头就拒绝运行（`DRAFT_SCRIPTS_ARE_FOR_REVIEW_ONLY`）。
  - `<in>` 里的 `check-host`、`verify-signed`、`derive-roles` 副本必须与 `linux/tools/` 中提交的版本相同。
  - toolchain node、结果公钥取自配置的 `linux.host`（节点自己的事实，没有任何节点的常量）。
  - Source v1 已退役，只有一条路径：
    - 第 A 步在 `quiet_and_installed` 之后、建 `$BASE` 之前，把 v1 的三处残留（`/opt/clued-independent-ci/source-first-formal-v1`、`/etc/clued-independent-ci/roles`、`/etc/clued-independent-ci/formal-source-manifest-v1.json`）各自整体 `mv -n` 进本次的保留目录 `$BASE.v1-retired`（不删除、不覆盖；已移过或不存在就跳过），第 A 步结果的 `v1Retired` 记下移走了什么。现装 Source v2 运行时不读这三处。
    - B1 用 `linux/tools/sign-qualification.mjs` 签名（sha 由 `prep.py` 钉住，和其他字节一起暂存、`sha256sum -c`、进 `phaseA.sha256`），签名的来历是节点已装、已签的 roles-v3 资格。
    - `verify-source-v2.sh` 检查 `no-v1`（三处已被第 A 步移走）。
    - 其余检查全部照旧：已装 Source v2 的 HEAD 和 manifest、已装常驻和升级通道、旧 version facts、check-host 的钉值、verify-signed、三份计划。
- `prep.py --in-dir <Windows 路径> --out-dir <Windows 路径>`（通用节点包；两项必须同时给，取代 `<in>` 名）：
  - 脚本只读入目录（`W=`）、只把 review 副本、version facts、evidence 和 out-B 写进出目录（`O=`，不存在即拒绝 `OUT_DIRECTORY_MISSING`）；不再用 `$W/..`。两个路径只许字母、数字、`.`、`_`、`-` 和 `\`，出目录不能在入目录里。
  - 脚本名为 `workDir\linux\A.sh`、`B.sh`、`B-resume.sh`，不带参数、不要求 `R4_CLEAN_ENV`（registrar 的固定环境没有它；脏环境变量检查保留）。B 和 resume 不再比对"审过的第 A 步清单哈希"（一次 UAC 内 A、B 之间没有人工环节），仍逐字节核 `phaseA.sha256`。其余文本与 Owner 手动运行的脚本相同（测试逐行比对）。
  - Linux 工具取自本文件所在的树（解包后的包），不做 `git archive` 校验，不需要仓库。
  - 通用节点包的 A 另有两项（Owner 手动运行的脚本没有）：一开头，若另有 `/root/clued-ci-reinstall-*/stg` 还没有 `phaseA.sha256`、且有别的进程在跑 `linux-run-<hex>/script.sh`，拒绝 `ANOTHER_PHASE_A_RUNNING`；暂存之后，以 root 读现场已装的 Linux manifest，核对合同与路径列表（含顺序）等于新包的，不等即停 `INSTALLED_LINUX_MANIFEST_NOT_THE_PACKAGES_SHAPE`（`rehearse.py --fleet` 看不到已装 manifest，这项由 A 核）。代价：新包若增删或调换了 Linux 常驻 manifest 里的文件条目，这条路径装不了它，A 会在暂存后、任何切换之前拒绝（节点保持暂停，Windows 侧未动）；那样的包需要先改这条规则并重新审核。
- `tools/derive-roles.py`：与冻结工具 `clued-ci-upgrade-linux` 的 `derive_role` 一样，把 5 个 Source 钉值（entry、qualification、worker、proof、job）重钉为新提交的值，其余一律不许变。
- 其余工具与 r7 审过的相同：`verify-source-v2.template.sh`（不再有 v1 分支）、`check-host.py`（两项钉值改为参数）、`verify-signed.mjs`。

## 7. 一次整套重装的顺序

多节点用同一个通用包重装（每台一次 UAC）的操作说明见 `../rollout/fleet/README.md`。

1. `build.ps1 -Final`：得到 final 包 W0（final 启动器此时还出不来）。
2. `rehearse.py`：结果必须是 REHEARSAL_PASS。
3. `linux/assemble.py`，再用 `linux/prep.py` 加预演报告，生成 final 版 Linux 脚本。
4. **W1**：`tools/pause-old-resident.py <config>`，非提权，必须返回 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`。
5. **Linux A、B**：由 Owner 以 root 运行（`wsl -d <发行版> -u root`，`env -i`）。B 切换 Source 之后若失败，用 resume 续跑。
6. `build.ps1 -Final`：用同样的 ref，加上 `-Rehearsal`、`-LinuxEvidence`、`-LinuxVersionFacts`，得到 final 启动器。包 sha 必须不变。
7. UAC 一次。
8. rearm 恢复。

## 8. 新节点

- 节点档案：仓库里没有任何节点的档案；重装和升级一律用本机已装包 record 里的档案（`rconfig.node_profile`、`rollout/fleet/install.mjs`）。全新节点（还没有已装包）的档案要由本机事实生成，这一步尚未实现，见第 8c 节说明。
- 配置：把 `config/new-node.example.json` 复制一份，填入以下各项：
  - 六项节点值。其中 `controllerNodeSha256` 就是包里 Windows `runtime\node.exe`（nodeExe）的 sha256，各节点相同；`ciPrincipalRoleRef` 是 Owner 认可该连接**可以**持有 ci-admission 的 Decision。
  - `linux.host`：首装节点还没有已装的 Linux CI，三项都填 `null`，`installedRoles` 也填 `null`，不要编造值。知道该节点 toolchain node 的 sha 后，填 `toolchainNodeSha256`。
  - 然后运行：
    ```
    build.ps1 -Config ... -Commit <40hex> -PackageOnly [-Final -DecisionRef ... -ReceiptRef ... -AcceptedAt ...] -CiPrincipalQualificationRef <uuid>
    ```
- 带 `-Final` 时，包里写真实 ref；不带时是 DRAFT，ref 为占位值。`-CiPrincipalQualificationRef` 写这个节点自己连接的资格。不给时沿用 base 的值，那只适用于同一个连接。
- 节点输入：`tools/node-inputs.py` 从配置的 policy/companion 输入生成本节点的版本，替换以下几项，其余一字不改：
  - `node`、`nodeProfileSha256`；
  - policy 的 `companion.userSid`（= ownerSid）；
  - 两处 distribution（= wslDistribution）。

  base 节点的任何值如果还留在别的字段里，就拒绝（`NODE_INPUT_KEEPS_THE_BASE_NODE`）。同一节点时输出与原输入内容相同。
- `linux.installedManifest` 在新节点上只用作外部钉值的路径和顺序模板。toolchain node 一项取 `linux.host.toolchainNodeSha256`，为 `null` 时沿用副本的值；`source-v2` 钉值总是取新提交的文件。
- 首装不走这里的启动器、Linux 脚本和预演：配置里 Linux 事实为 `null` 时，它们都拒绝（`NODE_HAS_NO_INSTALLED_LINUX_CI`）。首装见第 8c 节。
- record 的 `signers`：配置没有 `signer` 时沿用 base 节点的结果签名者。它只在发布签名结果时用来验签；安装、verify 和 STANDBY 都不用它。一个节点在有自己的签名者之前不能接班（DESK-W-591：Z1 之前，Decision `d339ddb2`）。配置写了 `signer`（本节点结果钥的 keyId、runtimeId、Ed25519 公钥 PEM，只有公钥）时，record 只列这一位签名者，其 `qualificationRef` 为 `hostQualificationRef`（第 8c 节）。

## 8c. 新节点的 Linux 首装（Z1，各节点通用）

装之前先核对这个节点的 CI 连接建在 clued 项目下（`docs/maintenance/independent-ci.md`“连接要绑对项目”）。建错项目时角色探测一直报 `ROLE_PROBE_CONNECTION_UNAUTHORIZED`，换 token 或标角色都没用。

新节点 = **填一份 config + 现场跑三条命令 + Windows 上跑四条命令**。不改代码，不新增审核，不跑 CI。代码里没有任何节点值：keyId、runtimeId、公钥、docker/git/node 的 sha、发行版、各个 ref，全部来自 config 和现场回传的事实文件。主机资格从一个模板节点已审、已签的 roles-v3 派生（Owner 决定：`hostQualificationRef` 指向这条 Decision）。

**1. 填 config。** 把 `config/new-node.example.json` 复制为 `<node>.json`，填入：
- `nodeRecord` 六项（见第 8 节）。配置不写节点名和档案路径。
- `linux.distribution`：该节点 CI 用的 WSL 发行版名。
- `signer.keyId`、`signer.runtimeId`。约定写法：keyId 为 `<node>-first-run-<yyyymmdd>`，runtimeId 为 `<NODE>-cluedresident-independent-ci-v1`。
- `basePackage`：模板节点已审的包。模板公钥就从这个包的 record `signers.json` 取。
- `linux.host` 和 `signer.publicKeyPem` 先不填，由第 3 步写入。

**2. 现场（Owner，在该节点 WSL 里以 root 运行）。** `<D>` 为发行版名。
```
wsl -d <D> -u root -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc linux/tools/make-result-key.sh
wsl -d <D> -u root -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/python3.12 -I linux/tools/first-install-facts.py > first-install-facts.<node>.json
```
- 第一条只建一次结果钥：已有就拒绝，不覆盖。它只输出公钥 PEM 和 sha256，私钥不打印、不离开 WSL。
- 第二条只读，不读私钥。它输出事实文件，内容包括：toolchain node、公钥、docker/git 的 sha 和保护状态；systemd、cgroup v2、docker 的状态；已有的 Linux CI 路径（首装必须为空）。
- 请把事实文件交回 Windows。
- 前提：toolchain node 必须已在 `/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node`（与模板节点相同的 sha）；systemd 必须是 PID 1；docker.service 必须在运行。

**3. Windows：生成构建配置。**
```
python -I tools/first-install-config.py <node>.json first-install-facts.<node>.json <node>.first-install.json
```
它把事实写进 `linux.host` 和 `signer.publicKeyPem`。事实不是一台可以首装的主机时拒绝。

**4. Windows：构建包。** 用 `<node>.first-install.json` 和 Owner 的 ref 运行 `build.ps1 ... -Final`（见第 8 节）。配置里有 `signer`，所以 record 里只列本节点这一位签名者。

**5. Windows：组装输入并生成两个 root 脚本。**
```
python -I linux/assemble.py ...
python -I linux/first-install.py <config> <commit> <package> <suffix> <in-dir> <模板 roles-v3 副本> <模板节点的 linux-version-facts> [<节点上的 in-dir 路径>]
```
- 新节点是另一台机器时，把整个 in-dir（含 `images/`）和两个脚本拷到该节点，并把它在该节点 WSL 里看到的路径作为第 8 个参数（例如 `/mnt/c/...`）。字节由脚本里的 sha 核对，路径不影响校验。
- 模板文件按模板节点 version facts 里的 sha 钉住。
- 模板公钥必须等于模板 qualification 里的 `resultPublicKeySha256`。
- 生成器自己钉住两个首装 root 工具（`sign-first-qualification.mjs`、`first-node-facts.py`）的 sha。
- **镜像。** worker 以 `--pull=never` 运行角色镜像，所以镜像必须事先在本节点的 docker 里。生成器的输出列出两类：
  - `pullImages`：按 digest 钉住的仓库镜像，B 按 digest 拉取。
  - `localImagesToLoad`：模板节点本地构建的镜像，只有镜像 id。需要在模板节点上以 root 导出到 in-dir 的 `images/<hex>.tar`：
    ```
    wsl -d <模板发行版> -u root -- docker save <hex> -o <in-dir 的 WSL 路径>/images/<hex>.tar
    ```
    也可以放 gzip 压缩的 `images/<hex>.tar.gz`。生成器在生成时钉住压缩包的 sha256；B 先核这个 sha，再用 `docker load` 载入，最后核对镜像 id 等于 `sha256:<hex>`。
    镜像 ID 以源节点 `docker image inspect --format '{{.Id}}'` 的完整值为准：旧存储通常是 config 摘要，containerd 存储是目标 index 或 manifest 摘要。`tools/export-role-image.ps1` 同时支持经典归档与 OCI 布局，核对每级 descriptor 的摘要、大小、config 和所有 layer（含 gzip 解压后的 diff_id）；存在 `manifest.json` 时还核对它与 OCI 链的一致性。B 始终核对原 ID，不把它改成 config ID 或 tag；目标后端不能保持这个 ID 时拒绝，不能据加载成功文本视为已通过。

**6. 现场（Owner，root）：先跑 A，审核其输出后再跑 B。**
- **A**：不读私钥，只写 `$BASE`。
  1. 确认这是首装：没有 Source v1/v2、roles、resident、升级工具。
  2. 暂存并核对每个钉住的字节。
  3. `derive-roles-r7.py` 把模板当作已装侧，派生本 record 的值。
  4. `first-node-facts.py` 只填本节点的 keyId、runtimeIdentity、结果公钥 sha 和 docker/git/node 钉值。docker/git 的 sha 取现场值，**Owner 要在 A 的输出里核对它们**。
  5. 检查主机钉值，检查 resident 清单钉的是本提交的文件，检查运行目录，检查 resident 安装计划。
- **B**：读本节点私钥签名，不打印。
  1. `sign-first-qualification.mjs`：每份 policy 和 payload 都必须与模板节点同角色的文件相同，只允许本节点值、本 record 值和派生重钉的 Source 钉值不同；keyId 和 runtimeId 必须等于 config 的值；与模板相同的钥被拒绝。
  2. 依次运行 `verify-signed-r4`，建立运行目录 `workspaces/` 和 `runs/`（root，0755），`clued-ci-install-source-v2` package/plan/apply，`verify-source-v2`（同时确认没有 Source v1）。
  3. 装 resident，准备角色镜像（见第 5 步），装升级工具，采用第 1 代，写 version facts，最后运行 `verify-resident-linux`。
- **目录权限**：`/etc`、`/opt`、`/var/lib` 下的 `clued-independent-ci` 父目录按设计为 root:root 0700，与模板节点相同，脚本不改。
- **续跑**：每一步做过的只核对，失败的一步可以重跑，重跑 B 即可续跑。
- **重启**：如果需要重启，**只能**在 Windows 上运行 `wsl -t <D>`，然后再跑一次 B。绝不能用 `wsl --shutdown`，也不要动其他发行版。

## 9. 历史

- **r4–r5c2**：TURING 的 Source34 重装，以及 018da927 升级通道的首次安装。
- **r7**（第 3 批）：
  - 包层的外部钉值（审核 BLOCKER-1）；
  - src.git 的 HEAD（BLOCKER-2）；
  - 切换 Source 后可续跑（MAJOR-1）；
  - 角色重钉（Linux A 在 23:47Z 被拒）；
  - 卸载计划 /3 与"经 SCM 停升级代理"（f3 启动器在 00:01Z 被拒）。
- KooYomi Note：`922efc6b`、`fb736ae8`、`598dca23`。

## 10. 测试

```
python -I -m unittest discover -s test -p "test_*.py"      # 在 reinstall/ 下运行
```

假 Host 回答节点的状态。测试覆盖：
- 上面三次被拒的回归；
- 卸载计划字段与升级代理；
- verify 的两种情况；
- 已装副本过期；
- facts 与第 1 代记录不一致；
- 包属于别的节点；
- 配置的秘密拒绝、占位值、节点档案与配置对应；
- 启动器模板的心跳令牌参数和计划比对（`test_launcher_heartbeat.py`，在 Windows PowerShell 5.1 里跑模板自己的函数，子进程是假的）；
- 没有 Source v1 的节点：签名工具、`prep.py` 生成的脚本、预演（`test_reinstall_no_v1.py`、`test_rehearse.py`）。

### 显式历史 replay（不是当前 main 的验收）

`qualification/real-upgrade-flow.mjs` 只复放固定 BEFORE `019c1b7719c2b400915d16293e6c4d6e34585efd` 与 AFTER `1cba7ba527dc4755560e05f956c3f888350d3249`，不由普通 `*.test.mjs` 自动发现。它从两个独立、精确且干净的 checkout 动态加载完整 runtime 依赖；不要为运行它把冻结 runtime 复制进当前工具分支。

在 Windows PowerShell 5.1 所在机器上，显式设置 `CLUED_UPGRADE_REPLAY=1`、`CLUED_UPGRADE_BEFORE_REPO` 和 `CLUED_UPGRADE_AFTER_REPO` 为对应 checkout 后，运行 `node --test qualification/real-upgrade-flow.mjs`。缺少 opt-in、平台不符或 checkout 不匹配时直接拒绝，不用 skip 充当通过。可将 `CLUED_UPGRADE_REPORT_DIR` 指向预先建立的独立结果目录以保留公开回执。

它只验证历史文件/状态模块及真实 PS5.1 读取器；SCM、任务、Linux、Grant 与 Native 角色仍为替身边界。成功不是当前 Source 接受、主线 portable CI、物理服务升级或自动回滚的通过证明。
