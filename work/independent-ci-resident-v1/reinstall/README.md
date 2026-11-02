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
| `node` / `nodeProfile` | 节点名；节点档案在提交树中的路径（`config/node-profile.<node>.json`），两者必须对应 |
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

已有配置：
- `turing.json`
- `desk-w-591.example.json`：六项指纹和 `linux.host` 三项由现场回传后填入。

## 3. 打包：`build.ps1`

```
powershell -NoProfile -File build.ps1 -Config config\turing.json -Commit <40hex>                       # DRAFT（占位 ref）
powershell -NoProfile -File build.ps1 -Config ... -Commit ... -Final -DecisionRef <uuid> -ReceiptRef <uuid> -AcceptedAt <ISO Z> -Tag t
          [-Rehearsal <预演报告> -LinuxEvidence <file> -LinuxVersionFacts <file>]
powershell -NoProfile -File build.ps1 -Config config\desk-w-591.json -Commit ... -PackageOnly           # 只出包（新节点）
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

### 升级链的离线实际模块测试

`test/real-upgrade-flow.test.mjs` 通过实际 Machine、Generations 文件原语、ResidentExecutor、ResidentPort、receipt chain 及 PowerShell 5.1 的 production reader/generation/version 谓词走正向和回滚。设置 `CLUED_UPGRADE_BEFORE_REPO` 指向精确、干净的 `019c1b77…` 修前检出，`CLUED_UPGRADE_REPORT_DIR` 指向全新报告目录，然后运行 `node --test <该测试文件>`。修后模块逐 blob 绑定已接受 `1cba7ba5…`。

报告明确 SCM/task、Linux host/companion、Native role reply 和 Grant door 是隔离边界；它不是物理服务或完整生产 verifier 的验收，不能据此解除 Owner 要求的物理空升级 Gate。

首次重装后的“同 Source 空升级”可先用原 `rollout/build-upgrade.ps1` 构建：原地包移除本次重装包主清单里24个只供首次安装的 upgrader 写入项，所有共同文件字节、C/S、策略、身份、冻结升级器和 bundle 保持相同，包摘要自然不同。须按 `target` 逐项对比，不能按 `path` 去重漏掉复制到多个目标的文件；交付逐文件 diff，并在目标重装后的实际现场重新预检与取得精确 Grant。不要改功能、有效期或制造空提交来绕过 `UPGRADE_SAME_AS_CURRENT`。

- **模板**：`template.ps1` 就是 r7 f4 在 TURING 上实际跑过的文本（6d32f2ba），把补丁历史合了进来，只多了一处：主机名改为参数 `$NodeHostname`。生成器钉住模板的 sha，不再打补丁；模板要改，就作为文本改动走审核。
- **数据来源**：启动器钉住的每一个值都来自文件，包括包、配置、包里 record 的节点档案（必须等于配置所指的档案），以及本机已装状态（只读）。
- **final 的前提**：Linux 第 B 步产出的 evidence 和 version facts，加上一份对**同一个包、同一提交、同一配置**的 `REHEARSAL_PASS` 预演报告，缺一不可（`FINAL_NEEDS_A_PASSING_REHEARSAL_OF_THIS_PACKAGE`）。24 小时时限由 `prep.py` 在节点变动之前检查；这里不再查，因为 W1 和 Linux B 之后节点处于半重装状态，无法重新预演。
- **步骤**：Q1–Q5、r4.1 C1–C3、r5 S1–S3、r5c 的升级通道、r7 的卸载计划 /3 和"经 SCM 停升级代理"。每一步都在模板注释里写了用途。
- **心跳令牌**（2026-10-31，模板 sha `5ff3a1c1`）：配置了 `heartbeat` 时，带令牌的 dry run 和 `-Apply` 再加 `-HeartbeatTokenFile`，配置了 `bindingId` 时再加 `-HeartbeatBindingId`。审过的计划（非提权、不带令牌）不变，卸载之前的 carry-forward 预览也不带心跳令牌。提权比对时把 `plan.heartbeatToken` 也剥出来逐项核对：目标是本包安装器的 `secrets\heartbeat\ci-node-heartbeat.token`、supplied、目标不存在、目录和两个 SDDL 与审过的计划相同、64 位 hex 指纹、verified、`bindingId` 恰好是配置的值；不对就报 `HEARTBEAT_TOKEN_PLAN_FIELDS_NOT_AS_EXPECTED`。没配置时这一项留在其余字段里，必须与审过的相同，和以前一样。生成器核对包的安装器支持心跳令牌（不支持时报 `PACKAGE_INSTALLER_HAS_NO_HEARTBEAT_TOKEN`），final 缺令牌文件时报 `HEARTBEAT_TOKEN_FILE_MISSING`。`HeartbeatBindingId` 在计划里的位置按 `plan.heartbeatToken.bindingId` 核对。
- **心跳令牌补装或换新（90 天到期）**：今天没有不重装的办法。`install-resident.ps1` 只做全新安装，目标已存在时拒绝（`HEARTBEAT_TOKEN_TARGET_EXISTS_NOT_OVERWRITTEN`）；升级通道不碰 `secrets`。所以补装或换新都要整套重装一次。要免重装，需要一个新的提权小工具（放在 `windows/`，要审核）：按安装器同样的规则核对目录和文件的 ACL，拒绝 CI 令牌和升级令牌，在同一目录里按文件 SDDL 写新内容再原子替换，写一份回执。服务端关联新连接（`/bindings/failover`）会替换旧的关联。这个工具这里没有做。

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

只读 API 依据：[GetProcessTimes](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)、[Win32_Process](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-process)、[CIM_DATETIME](https://learn.microsoft.com/windows/win32/wmisdk/cim-datetime)、[IRunningTask.EnginePID](https://learn.microsoft.com/windows/win32/api/taskschd/nf-taskschd-irunningtask-get_enginepid)。

此检查只覆盖已登记的公开二进制文件。Restart Manager 不接受目录资源，因此它不能证明不存在目录句柄或整个 resident 目录一定能改名；报告明确写出 `directoryHandlesCovered=false`，正式卸载仍须取得原有的精确改名与保留证据。

```
python -I rehearse.py config\turing.json --commit <40hex> --package <包目录>
```

非提权、只读。每一项都直接运行节点上的真实工具或读取真实文件，不一致的地方就记为 finding（差异清单）。唯一以 root 身份运行的是 linuxHost 探查：只读，不写任何文件，git 不取可选锁。

| 检查 | 内容 |
|---|---|
| uninstall | 运行**已装的** `uninstall-resident.ps1` 做真实 dry-run：plan 合同必须是模板 `Test-UninstallPlan` 接受的那一版，模板读到的字段都要在；不能有记录中的升级 op；`upgraderService` 必须与服务实际是否存在一致，且为 true（模板要求） |
| upgrader | 装着 CluedCIUpgrader 时，模板的停服步骤必须经 SCM 停它 |
| verify | 新包的 `verify-resident.ps1` 输出形状（`status` 和 `checks.*.ok`）必须是启动器读的那样。已装的 verify 也真跑一次：不提权时它会被管理员专属文件挡住，此时只记为"未提权不可运行"，不算 finding；能跑出结果时，必须是 VERIFIED 或 PARTIALLY |
| status | `state/status.json` 的 `writtenAt`、`executor`、`current`、`halt`；`upgrade/status.json` 里没有 op；`upgrade/current.json` 的合同 |
| linux | Windows 侧的 Linux version facts（`upgrade/mailbox/responses/version-facts.json`）与第 1 代记录一致；配置里 root 复制的 Linux manifest 和 roles-v3 就是现装的（与 facts 里各项 sha 比对） |
| pins | 包里 Linux 常驻 manifest 的外部钉值：形状与已装一致，`source-v2` 钉值等于新提交里的文件 |
| linuxHost | 以 root 只读：对已装角色策略运行第 A、B0、B4 步会用的 `linux/tools/check-host.py`，钉值取配置的 `linux.host`；Source v1 的 HEAD 等于配置值；签名工具要读的 v1 qualification 都在（只查是否存在；签名和事实由第 B1 步签名工具核对，B1 在切换 Source 之前）。配置的 v1 HEAD 为 null 时：v1 的三处（`source-first-formal-v1`、`roles`、`formal-source-manifest-v1.json`）都不存在（否则 `LINUX_NODE_HAS_A_SOURCE_V1_NOT_CONFIGURED`），`roles-v3` 的三份 qualification 都在（否则 `LINUX_INSTALLED_V2_QUALIFICATIONS_MISSING`） |
| roles | 以普通用户在节点的 WSL 发行版里，对副本运行第 A 步会用的 `linux/tools/derive-roles.py`。必须成功，被重钉的 Source 文件逐个列出。发行版默认用户是 root 时拒绝运行 |
| node | 包里的节点档案就是配置所指的那份 |

报告（`clued.independent-ci.reinstall-rehearsal/1`）只新建、不覆盖，写在 `workDir\rehearsal\`。

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
  - toolchain node、结果公钥、v1 HEAD 取自配置的 `linux.host`，不再是 TURING 的常量。
  - **没有 Source v1 的节点**（`v1SourceHead` 为 null，例如 Z1 首装的节点；按配置判断，从不按主机名）：
    - 第 A 步在 `quiet_and_installed` 之后、建 `$BASE` 之前，要求 v1 的三处都不存在（`NODE_HAS_A_SOURCE_V1_CONFIGURE_ITS_HEAD`）。
    - B1 改用 `linux/tools/sign-qualification-no-v1.mjs` 签名（sha 由 `prep.py` 钉住，和其他字节一起暂存、`sha256sum -c`、进 `phaseA.sha256`）。它和 `sign-qualification-v2.mjs` 做同样的检查，只把"已装的 v1 qualification"换成"节点已装的 roles-v3 qualification"：必须用节点公钥验签通过、是 v2、指名同一把钥，image、keyId、runtimeIdentity、隔离事实都相同；新 payload 和新 policy 与已装的相比，只许 derive-roles 改的 Source 值不同（manifest、两个 ref、五个 Source 钉值，payload 另加 qualifiedAt）。节点上有 v1 时它拒绝。
    - `verify-source-v2.sh` 的 `V1_HEAD` 为空，于是检查 `no-v1`。
    - 其余检查全部照旧：已装 Source v2 的 HEAD 和 manifest、已装常驻和升级通道、旧 version facts、check-host 的钉值、verify-signed、三份计划。
  - 有 Source v1 的节点：生成的三个脚本与改动之前逐字节相同。
- `tools/derive-roles.py`：与冻结工具 `clued-ci-upgrade-linux` 的 `derive_role` 一样，把 5 个 Source 钉值（entry、qualification、worker、proof、job）重钉为新提交的值，其余一律不许变。
- 其余工具与 r7 审过的相同：`sign-qualification-v2.mjs`（9ee06a93）、`verify-source-v2.template.sh`（r7 的 60c078e0 加一处：v1 HEAD 改为变量 `V1_HEAD`，现 05314df4）、`check-host.py`（两项钉值改为参数）、`verify-signed.mjs`。

## 7. 一次整套重装的顺序

1. `build.ps1 -Final`：得到 final 包 W0（final 启动器此时还出不来）。
2. `rehearse.py`：结果必须是 REHEARSAL_PASS。
3. `linux/assemble.py`，再用 `linux/prep.py` 加预演报告，生成 final 版 Linux 脚本。
4. **W1**：`tools/pause-old-resident.py <config>`，非提权，必须返回 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`。
5. **Linux A、B**：由 Owner 以 root 运行（`wsl -d <发行版> -u root`，`env -i`）。B 切换 Source 之后若失败，用 resume 续跑。
6. `build.ps1 -Final`：用同样的 ref，加上 `-Rehearsal`、`-LinuxEvidence`、`-LinuxVersionFacts`，得到 final 启动器。包 sha 必须不变。
7. UAC 一次。
8. rearm 恢复。

## 8. 新节点（例如 DESK-W-591 第 5 步）

- 节点档案 `config/node-profile.desk-w-591.json`：取自 Note `85717e8f`，已通过 `validateNodeProfile`。
- 配置：把 `config/desk-w-591.example.json` 复制为 `desk-w-591.json`，填入以下各项：
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

  base 节点的任何值如果还留在别的字段里，就拒绝（`NODE_INPUT_KEEPS_THE_BASE_NODE`）。同一节点时输出与原输入内容相同：用 TURING 配置和 r7 的 ref 重建 a0e15a91，仍得到 9d774173。
- 节点档案：提交树里有就用树里的；没有（例如 a0e15a91 早于 DESK 档案）就用本工具链检出里同一路径的副本。两种情况都由该提交自己的 `prepare-record.mjs` 校验。
- `linux.installedManifest` 在新节点上只用作外部钉值的路径和顺序模板。toolchain node 一项取 `linux.host.toolchainNodeSha256`，为 `null` 时沿用副本的值；`source-v2` 钉值总是取新提交的文件。
- 首装不走这里的启动器、Linux 脚本和预演：配置里 Linux 事实为 `null` 时，它们都拒绝（`NODE_HAS_NO_INSTALLED_LINUX_CI`）。首装按《DESK-W-591 主备安装操作说明》进行。
- record 的 `signers`：配置没有 `signer` 时沿用 base 节点的结果签名者。它只在发布签名结果时用来验签；安装、verify 和 STANDBY 都不用它。一个节点在有自己的签名者之前不能接班（DESK-W-591：Z1 之前，Decision `d339ddb2`）。配置写了 `signer`（本节点结果钥的 keyId、runtimeId、Ed25519 公钥 PEM，只有公钥）时，record 只列这一位签名者，其 `qualificationRef` 为 `hostQualificationRef`（第 8c 节）。

## 8c. 新节点的 Linux 首装（Z1，各节点通用）

装之前先核对这个节点的 CI 连接建在 clued 项目下（`docs/maintenance/independent-ci.md`“连接要绑对项目”）。建错项目时角色探测一直报 `ROLE_PROBE_CONNECTION_UNAUTHORIZED`，换 token 或标角色都没用。

新节点 = **填一份 config + 现场跑三条命令 + Windows 上跑四条命令**。不改代码，不新增审核，不跑 CI。代码里没有任何节点值：keyId、runtimeId、公钥、docker/git/node 的 sha、发行版、各个 ref，全部来自 config 和现场回传的事实文件。主机资格从一个模板节点已审、已签的 roles-v3 派生（Owner 决定：`hostQualificationRef` 指向这条 Decision）。

**1. 填 config。** 把 `config/new-node.example.json` 复制为 `<node>.json`，填入：
- `node`、`nodeProfile`（节点档案）和 `nodeRecord` 六项（见第 8 节）。
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
