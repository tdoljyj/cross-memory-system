# 通用节点包第一批：三块之间的接口（定稿）

目标：只构建一个通用包；两台节点（先 DESK，后 TURING）各用它重装，每台 1 次 UAC；Linux root 步骤在 companion 账户的发行版里执行。第二批（自动升级驱动、服务端已接受 Source、6 项补充）不在本批。

分支 `claude/fleet-node-package-b1`（main 94d7e034 + 合入 `claude/linux-identity-no-stdev` ee68029c）。根目录简称 `R = work/independent-ci-resident-v1`。

## 1. 通用包（块 1 产出，块 3 归档）

- 构建：`node R/rollout/fleet/universal.mjs build --repo <git dir> --commit <40hex> --version <YYYY.MM.DD-c8> --out <新目录>`，只在发布机跑一次。
- 产出（即 Release 资产，内容不可变）：
  - `fleet-node-<version>.tar`：确定性 ustar，含 `tree/<提交子集>`、`bundle/accepted.bundle`、`universal-manifest.json`；
  - `fleet-node-<version>.release.json`（合同 `clued.independent-ci.fleet-node-release/1`）：版本、commit、tar 的 sha256、各通用哈希、文件清单；
  - `SHA256SUMS`。
- tree 子集必须覆盖重装需要的一切：`R/src`、`R/tools`、`R/windows`（含 `install-resident.ps1`、`verify-resident.ps1`、`uninstall-resident.ps1`、`CompanionTaskRegistrar.cs`）、`R/linux`、`R/upgrader/src`、`R/config`、`R/reinstall/**`（launcher、linux、tools，不含 test）、`R/rollout/precheck.mjs`、`R/rollout/fleet/**`（不含 test）、CI Source 闭包与 `prepare-record.mjs`。
- 包里没有任何节点值：不含 record 引用、节点档案选择、SID、路径。

## 2. 接受文件（Owner 接受一次，全体适用）

`fleet-node-<version>.acceptance.json`，合同 `clued.independent-ci.fleet-node-acceptance/1`：

```
{ "contract", "version", "archive_sha256", "commit", "repository": "<owner/name，等于 record 的仓库>",
  "ciSourceManifestSha256": "<install.mjs source-hash 算出>", "cluedDecision": "<8hex 或 uuid>",
  "acceptedAt": "<ISO Z>",
  "fleetRefs": { <进入 ciSourceManifestSha256 或 record 的、各节点必须相同的接受引用> } }
```

- `ciSourceManifestSha256` 只由包与 `fleetRefs`（及 `repository`、`commit`）决定：写接受文件的人先写不含它的草稿，用只读子命令 `node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\install.mjs source-hash --artifact <tar> --artifact-sha <hex> --acceptance <草稿>` 算出后填入。每台节点的 `prepare` 重算，不等即拒绝 `FLEET_SOURCE_NOT_THE_ACCEPTED_ONE`；`repository` 不等于节点 record 的仓库即拒绝 `FLEET_ACCEPTANCE_NOT_THIS_REPOSITORY`。`publish.mjs attach-acceptance` 用同一份校验（`install.mjs validateAcceptance`），并要求 `repository` 等于 `--repo`。

- 规则：凡进入 `record\source-manifest.json`（从而进入 `ciSourceManifestSha256`）的引用必须在 `fleetRefs` 里，各节点相同，这样同一个包在两台上得到同一个 Source（列车 `TRAIN_SOURCE_MISMATCH` 只比这个哈希）。按节点不同的（CI 连接资格 `ciPrincipalQualificationRef`、App 指纹、binding 等）从本机记录读。块 1 列出确切字段并写进本文件第 6 节。
- 由协调者在 Owner Decision 之后写出；块 3 的 `publish.mjs attach-acceptance` 把它作为追加资产上传（tar 不变）。

## 3. 节点组装（块 1）

在节点上、Owner 会话、非提权：

```
node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\install.mjs prepare
     --artifact <tar> --artifact-sha <hex> --acceptance <acceptance.json> --work <新目录>
```

（第 8 节：没有任何节点参数，根目录固定为 `C:\ProgramData\CluedIndependentCI\resident`。解包前先 `Get-FileHash` 核 tar，解包用 Python `tarfile`，见 `README.md` 第 5 节。W1 暂停由 `prepare` 在 rehearse、prep 之后、generate 之前完成，结果写进 plan 的 `w1Paused: {sha256, reason}`。）

- 先核 tar 的 sha256 与接受文件的 `archive_sha256`，再安全解包、逐文件核 `universal-manifest.json`。
- 节点身份只从本机读：`install\install-receipt.json`、`record\*`、`config\policy.json`、`config\companion.json`、`install\companion-account.json`、`upgrade\mailbox\responses\version-facts.json`、`roles-public.json`、runner 服务的现场 binPath 与 SDDL（只读）。不需要按节点的配置文件。
- 本批允许在 Owner 会话里调用包内的 python 工具（`python -I`）；不许依赖仓库检出。
- 产出（`<work>` 下，create-only）：
  - `package\`：本节点的 `/4` 首装包（`build-package.mjs --fresh-install`，构建两次 sha 相同）；
  - `linux-in\`：Linux A/B 的输入（`reinstall/linux/assemble.py` 的产物），companion 账户可读；
  - `linux\A.sh`、`linux\B.sh`、`linux\B-resume.sh`：由包内 `reinstall/linux/prep.py` 生成；
  - `launcher.ps1`：由包内 `reinstall/launcher/generate.py --fleet-plan <install-plan.json>` 生成；
  - `install-plan.json`（见下）。
- 结束时打印一行 JSON：`{status, node, version, workDir, installPlan, launcher:{path, sha256}, runCommand}`。`runCommand` 是 Owner 点 UAC 用的那一条命令。

### install-plan.json（合同 `clued.independent-ci.fleet-node-install-plan/1`）

```
{ "contract", "node", "version", "archive_sha256", "commit",
  "packageDir", "packageManifestSha256", "ciSourceManifestSha256", "linuxManifestSha256",
  "companionAccount": true|false,
  "linux": { "distribution", "inDir", "wslInDir",
             "scripts": { "A": {"path","sha256"}, "B": {"path","sha256"}, "BResume": {"path","sha256"} },
             "timeoutSeconds": { "A": <int>, "B": <int> } },
  "expectedLinux": { "generation": 1, "ciSourceManifestSha256", "manifestSha256", "packageManifestSha256" },
  "launcher": { "path", "sha256" } }
```

`launcher` 由块 1 在 generate.py 返回后填入。其余字段在调用 prep.py / generate.py 之前写好。

## 4. Linux root 以 companion 账户执行（块 2）

- `windows/CompanionTaskRegistrar.cs` 新模式：
  `root-run <FixedRoot> <scriptPath> <sha256hex> <outDir> <timeoutSeconds>`
  - 先核脚本 sha256，再 `CreateProcessWithLogonW`（`LOGON_WITH_PROFILE`、`CREATE_NO_WINDOW`）运行
    `cmd.exe /d /c ""wsl.exe" --distribution <档案发行版> --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc <WSL 路径> > out\stdout.txt 2> out\stderr.txt"`；
  - 输出唯一一行：`ROOT_RUN_EXITED <code>`、`ROOT_RUN_TIMEOUT` 或 `ROOT_RUN_REFUSED <CODE>`；超时只报告，不杀进程。
  - 复用 root-shell 路径的全部前置：切换未完成拒绝、任务须为密码定义、`NetUserSetInfo 1003` 换随机口令并重注册任务。
- 目录：`<FixedRoot>\install\linux-run-<32hex>\`，由提权的 launcher 建；`script.sh` 先复制进这个仅管理员可写的目录再核哈希；只有 `out\` 给 companion 账户 Modify。
- registrar 必须从**新包**里钉住的 `CompanionTaskRegistrar.cs` 编译（staged 包的变体，`New-CompanionBuild` 加一个从包字节编译的入口）。
- `reinstall/launcher/generate.py --fleet-plan <install-plan.json> --out <launcher.ps1>`：只钉 A/B 脚本的路径与哈希、包、install-plan 本身的哈希；不再钉 B 的输出。
- `reinstall/launcher/template.ps1`，一次 UAC 内的顺序：W1 暂停（已非提权完成）→ 暂存 → A → B（失败时 B-resume 一次）→ 按规则核 B 的输出（`generate.py` 现有 290–335 行的规则：evidence 恰一行 `sha256:` 等于包的 `ciSourceManifestSha256` 且 `exit: 0`、`package:` 是本包；facts 第 1 代、`staged` 为 null、Source 与 Linux manifest 等于包、`pinsOk` 为 true，即 install-plan 的 `expectedLinux`）→ 卸载 → 安装 → verify → rearm。
- 非 companion 节点（`companionAccount=false`）：同一脚本，由提权 Owner 直接 `wsl.exe -d <发行版> -u root ...` 运行，其余相同。
- `reinstall/linux/prep.py`：加 `--in-dir <Windows 路径> --out-dir <Windows 路径>`，脚本读写这两个目录（账户可读可写），不再用 `/mnt/d/w/...` 的 Owner 工作目录。
- rehearse：并入半成品 `claude/rehearse-companion-node`（fae633b2）的 `reinstall/rehearse.py` 与测试，补完审核意见。
- 文件锁：在 UAC 内以提权身份跑 `file-locks.ps1`，不再要求非提权读 companion 进程身份。

## 5. 归档与并入（块 3）

- `node R/rollout/fleet/publish.mjs release --dir <build out> --repo tdoljyj/cross-memory-system --index <索引文件>`：
  - `gh release create fleet-node-<version> <tar> <release.json> <SHA256SUMS> --target <commit>`；
  - 凭据只用 gh 自己的登录，不读、不写、不打印令牌，子进程环境去掉 `GH_TOKEN`/`GITHUB_TOKEN`；
  - 在索引文件追加一行。
- `publish.mjs attach-acceptance --version <v> --acceptance <file>`：上传接受文件，补全索引行的接受时间与 Decision。
- 节点取包：`gh release download fleet-node-<version> --repo tdoljyj/cross-memory-system --pattern "fleet-node-<version>.*" --dir <新目录>`，然后由 `install.mjs prepare` 核哈希。
- 索引文件：`G:\我的云端硬盘\Clued_资料中心\10_E_工程与平台\CI基础设施\通用节点包_归档索引.md`。表头：版本 | Release | tar sha256 | commit | 接受时间 | Decision。
- 已并入 Linux 工具修复 ee68029c（合并提交 af02e893）；组件版本在最后统一用 `scripts/ci/component-version-integration.py --base 94d7e0346 --write` 重算。
- 文档：`R/rollout/fleet/README.md`（通用包重装操作说明），`R/reinstall/README.md` §7 指向它。另写一份 CluedDev-Linux 上验证真实 `statvfs` / `FS_IOC_GETVERSION` 与逐条目挂载检查的命令，只写不跑，交协调者。

## 6. fleetRefs 字段清单（块 1 填写）

核实依据：`prepare-record.mjs#assembleRecord`（source-manifest = `{schema, repo, sourceSha, roles}`，每个角色 = `formalRoles[role]` + 闭包钉值 `sourceFiles` + `controllerRelay`，relay 里只有 `sourceAcceptanceRef`、`hostQualificationRef` 两个可变值，其余是常量）。所以 `ciSourceManifestSha256` 只取决于：提交（接受文件 `commit`）、闭包文件（树）、`formalRoles`、上面两个引用。`fleetRefs` 字段（`install.mjs` `FLEET_REF_KEYS` + `formalRoles`，键必须恰好这些）：

| 字段 | 形状 | 进入 | 说明 |
|---|---|---|---|
| `sourceAcceptanceRef` | UUID | source-manifest（每个角色 relay）、acceptance、signers | 进 Source |
| `hostQualificationRef` | UUID | source-manifest（relay）、acceptance、signers 的 `qualificationRef` | 进 Source；全体一个值。重装时 Linux A 的 derive-roles.py 允许它变（角色策略 `hostAcceptanceRef` 随之更新）；之后原地升级要求不变 |
| `formalRoles` | 对象，恰 `gitleaks`/`trivy`/`contract-placement` | source-manifest | 进 Source；角色材料（镜像 digest、工具路径与 sha）。现值可用 `install.mjs fleet-refs` 从已装 record 读出 |
| `ownerAuthorizationRef`、`publisherQualificationRef`、`ownerPackageAcceptanceRef` | UUID | acceptance.json | 不进 Source；全体相同（今天都等于 Decision） |
| `ownerDecisionRef` | UUID | acceptance.json、policy `ownerAcceptance.decisionRef`、包 `acceptance.decisionRef`（Grant 资源） | 必须与 `cluedDecision` 相同（8hex 时为其前缀） |
| `installationReceiptRef`、`ownerReceiptRef` | UUID，两者必须相等，且不等于 `ownerDecisionRef` | acceptance.json、policy `ownerAcceptance.installReceiptRef` | prep.py 要求两者相等 |

`owner.acceptedAt` 取接受文件的 `acceptedAt`，`validUntil` 恒为 null。

按节点、从本机读（不进 Source）：`ciPrincipalQualificationRef`（installation/acceptance，两处须相同）、节点档案（acceptance.node，哈希须等于 record-manifest 与回执的 `nodeProfileSha256`）、`appKeyId`、`appPublicKeySha256Base64`、`ciPrincipalBindingId`、`ciPrincipalRoleRef`、`ciTokenPinSha256`、`controllerNodeSha256`（须等于 `runtime\node.exe` 的 sha）、signers（本节点结果钥，引用改写为上面两个）；全体相同但从本机 record 读：repository、scope、appId、installationId、repositoryId、supabaseUrl、publishableKey、controllerAccount。

record 各文件：`source-manifest.json` 全体逐字节相同；`installation.json`、`acceptance.json`、`signers.json`、`record-manifest.json` 按节点（含节点值）。测试 `test/install.test.mjs` 证明：两台已装引用与角色材料都不同的节点，用同一个包和接受文件得到同一个 `ciSourceManifestSha256`、不同的包 sha。

## 7. 第一轮合并后的裁定（协调者，2026-11-12）

1. **prep.py 用块 2 的格式。** `install.mjs prepare` 在 `<work>\inputs\reinstall-config.json` 合成一份 `clued.independent-ci.reinstall-config/1`（全部值来自本机记录，第 6 节与块 1 的对应表），然后：
   - 先跑包内 `reinstall/rehearse.py <config> --commit <c> --package <work\package> --file-locks-in-launcher`（rehearsal 需要的 `workDir\rehearsal\src-<c8>.git` 由 install.mjs 从包内 bundle 建好，不 fetch）；结论必须是 `REHEARSAL_PASS`，否则 prepare 失败并打印 findings；
   - 再按块 2 的格式调 `prep.py <config> <rehearsal 报告> --in-dir <work\linux-in> --out-dir <work\linux-out>`，脚本写到 `<work>\linux\`；
   - 再调 `generate.py --fleet-plan <install-plan.json> --out <work\launcher.ps1>`。
   块 1 的 `--fleet-plan/--installed-*/--node-linux` 形式作废。
2. **install-plan.json 增加字段**（generate.py 必须读、缺了拒绝）：
   - `linux.outDir`（Windows 路径）；
   - （已被第 8.1 节取代：令牌从现装节点带入，不再有令牌文件参数。）`secrets`：`{ "upgradeTokenFile": <路径>, "heartbeatTokenFile": <路径或 null>, "heartbeatBindingId": <uuid 或 null> }`。install.mjs 读已装 `install\install-receipt.json` 的 `upgradeToken`、`heartbeatToken`（placed、bindingId）；令牌源文件由 `--upgrade-token-file`、`--heartbeat-token-file` 给出，缺省 `%USERPROFILE%\clued-secrets\resident-upgrade.token`、`...\ci-node-heartbeat.token`。回执写着已装心跳令牌而文件不存在 → prepare 拒绝 `HEARTBEAT_TOKEN_FILE_MISSING`（不再静默不带心跳）；升级令牌同理 `UPGRADE_TOKEN_FILE_MISSING`。install.mjs 只查文件是否存在，从不读内容。
   - `reasons`：`{ "pause", "rearm", "w1Pause" }`，固定为 `fleet-node-reinstall-<version>` 系列。
3. **launcher 字段**：generate.py 生成时 `launcher` 为 null；launcher 只钉“生成时的 plan 哈希”，运行时不读 plan。prepare 结束后写回最终 plan（带 launcher），这是给人看的记录，不参与运行。
4. **超时**：A=1800 秒、B=7200 秒，写在 plan 里。
5. **Source v1 已退役**：配置不再有 `v1SourceHead`，只有一条签名路径（`sign-qualification.mjs`，来历是已装 roles-v3）；节点上若有 v1 残留，A 步把它整体 `mv -n` 进本次的保留目录并在结果里记下，不再拒绝。
## 8. 裁定二：命令不带任何节点专属参数（Decision b5d041d2 v2）

每台节点上运行的命令完全相同：`install.mjs prepare --artifact <tar> --artifact-sha <hex> --acceptance <acceptance.json> --work <新目录>`（`--root` 只有缺省值）。删除 `--installed-package`、`--upgrade-token-file`、`--heartbeat-token-file`。合并审核把“命令无节点专属参数”作为检查项。

1. **令牌不从 Owner 目录取，从现装节点带入。** `install-plan.json` 的 `secrets` 改为：
   ```
   { "source": "installed",
     "upgradeToken":   { "target": <回执 upgradeToken.target>, "fingerprint": <回执值> },
     "heartbeatToken": null | { "target": <回执 heartbeatToken.target>, "fingerprint": <回执值>, "bindingId": <回执值或 null> } }
   ```
   prepare（非提权）只读回执；回执里令牌未 placed、字段缺失或有歧义 → 拒绝并写明缺什么（`INSTALLED_UPGRADE_TOKEN_UNKNOWN`、`INSTALLED_HEARTBEAT_TOKEN_UNKNOWN`）。launcher 在 UAC 内、卸载之前，把这两个现装令牌复制到只给 SYSTEM 和 Administrators 的 `C:\ProgramData\CluedIndependentCI\reinstall-carry-<32hex>\`，按回执的 fingerprint 规则核对（不符即停：`CARRIED_TOKEN_FINGERPRINT_MISMATCH`），把副本路径交给 `install-resident.ps1 -UpgradeTokenFile / -HeartbeatTokenFile / -HeartbeatBindingId`；该目录用完一律删除（成功、失败都删），未能删掉的由下次运行清扫。令牌内容从不进日志、计划或输出。
2. **不依赖已装包目录。** prepare 不再要求任何开发工作区路径。已装 Linux manifest 的字节在 Windows 侧不存在（只有 `version-facts.json` 里的哈希），所以：
   - 外部钉值的路径与顺序从包内 unit 文件推出（块 1 最初的做法）；
   - rehearse 在 fleet 模式下把“已装 Linux manifest 与副本一致”这项延后到 Linux A（与 companion 节点 linuxHost 延后同理），记 `deferredTo: linux-phase-a`，不算 finding；
   - plan 增加 `expectedInstalledLinux: { generation, manifestSha256, ciSourceManifestSha256 }`（取自 `version-facts.json`：Linux 侧按它自己的记录描述，不要求等于 `current.json` 的 `linux` 块，DESIGN §73；停在 B 之后的节点两者本来就不同），A 在 root 下核对现场 manifest 的 sha 等于它，不等即停。
3. **没有旧装的节点**：`install\install-receipt.json` 不存在 → prepare 拒绝 `NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH`（首次安装走 README §8c，不在本批）。