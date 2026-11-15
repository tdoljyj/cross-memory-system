# 通用节点包：升级与重装操作说明

节点只有两条路，用的是**同一个通用包、同一份接受文件**：

1. **通用升级**（第 0 节）：已装节点原地升级，零 UAC，失败自动回滚。默认走这条。
2. **通用重装**（第 1–8 节）：节点答 `FLEET_NODE_UPGRADE_NEEDS_REINSTALL` 时才走，每台 1 次 UAC。

只构建一个通用包。包里没有任何节点值（无 record 引用、节点档案选择、SID、路径），节点身份全部在节点上从本机记录读。接口细节见 `BATCH1-INTERFACES.md`，升级的设计见 [ADR 0030](../../docs/adr/0030-fleet-generic-upgrade.md)。

`R = work/independent-ci-resident-v1`。

## 0. 通用升级（Owner 手册）

### 0.1 Owner 做什么

| 步骤 | Owner | UAC |
|---|---|---|
| 接受这一版 | 一次 Decision（全体节点适用） | 无 |
| 每台节点升级 | 自动审批开着：什么都不做。没开：在该节点 `upgrade\status.json` 的 `confirmUrl` 页面点一次批准 | 无 |
| 当班节点 | 最后升，命令加 `--allow-active-upgrade`，升级期间 CI 暂停几分钟。服务端不把 ci-admission 移交给 Source 与全队不同的节点（迁移 `20261114120000`），所以要移交只能在开始前、两台还是同一 Source 时做 | 无 |
| 升级回滚了（`ROLLED_BACK_PAUSED`） | 看原因；恢复该节点 | 无 |

自动审批的边界（服务端现有规则）：每节点 24 小时内自动批 6 次；同一个包第二次请求、或上一次自动批的升级没成功，归 Owner 手动批。

### 0.2 发布机与协调者（一次）

1. 构建、发布：第 2、3 节，不变。
2. 写接受文件：第 4 节，不变，只多一条规则。**`fleetRefs` 里进入 Source 的三项 `sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles` 沿用现装值**（任一已装节点上 `node …\install.mjs fleet-refs` 只读取出），这一版才能原地升级；`ownerDecisionRef`、`installationReceiptRef`（= `ownerReceiptRef`）写这次的 Decision 与回执。三项里有任何一项要换，这一版对所有节点都是重装。
3. `publish.mjs attach-acceptance`：不变。

### 0.3 每台节点：同一条命令

Owner 会话、非提权。一条命令（取包、核哈希、解包、组装、预检、发请求）：

```
node <任一份 upgrade.mjs> fetch --version <version> --work <新目录> [--from <本地或共享目录>] [--no-request] [--allow-active-upgrade]
```

`<任一份 upgrade.mjs>` 用上一版已解包的包里的（或任何一份 `upgrade.mjs` 加 `fetch.mjs`）；真正执行升级的是新包解出来的那份 `upgrade.mjs`。取包由 `fetch.mjs` 做：按 release 资产分段续传（Range，连接被断就从已收到的字节接着要，退避重试，总时限 30 分钟），令牌只在进程内取自 `gh auth token`，不打印不落盘；也可以把 `fleet-node-<version>.tar`、`.acceptance.json`、`SHA256SUMS` 放进 `--from` 目录（Google Drive、共享盘都行，release 取不下来时用）。两个来源一视同仁，只认哈希：tar 的 sha256 必须等于接受文件的 `archive_sha256` 且等于 `SHA256SUMS` 那行，不符就删掉、不解包、不组装。断了就原样再跑同一条命令（同一个 `--work`），续传。产物：`<新目录>\dl\`（下载）、`<新目录>\unpacked\`（解包）、`<新目录>\upgrade\`（升级的工作目录）。输出是新包 `upgrade.mjs` 的那一行 JSON，多一个 `fetched`（来源、尝试次数、续传次数）。

分步手动做仍可以：`gh release download` + `Get-FileHash` + 解包，再用 `--artifact` 形式（输出相同）：

```
node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\upgrade.mjs --artifact <tar> --artifact-sha <hex> --acceptance <acceptance.json> --work <新目录>
```

没有节点参数。`--work` 目录不要放在会被清理的临时目录里：升级代理要从 `<新目录>\package` 读包。加 `--no-request` 只组装和预检，不发请求（演练）。

输出一行 JSON，`status` 是下面之一：

| status | 意思 | 下一步 |
|---|---|---|
| `FLEET_NODE_UPGRADE_REQUESTED` | 已组装、预检通过、请求已投 | 等；再跑同一条命令看进度 |
| `FLEET_NODE_UPGRADE_IN_PROGRESS` | 升级代理有操作在途（`op.state`、`op.confirmUrl`） | 等；`WAITING_GRANT` 且没开自动审批时 Owner 批一次 |
| `FLEET_NODE_ALREADY_AT_THIS_PACKAGE` | 两侧都已是这个包 | 这台做完了 |
| `FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED` | `--no-request` | 无 |
| `FLEET_NODE_UPGRADE_NEEDS_REINSTALL` | 这台不能原地升（`code` 写明：通道变了、Source 引用变了、两侧不是同一个包、Linux 现场与记录不符） | 用同样三个文件走第 5 节 `install.mjs prepare` |
| `FLEET_NODE_UPGRADE_HAND_OVER_FIRST` | 这台现在当班，没有发请求 | 其他节点都升好后加 `--allow-active-upgrade` 再跑（CI 暂停几分钟）；不能移交给已升级的节点（Source 不同，服务端拒绝） |
| `FLEET_NODE_UPGRADE_PRECHECK_REFUSED` | 预检拒绝但不用重装（例如 `FLEET_SOURCE_MISMATCH`：先升另一台） | 按 `precheck.advice` |
| `FLEET_NODE_UPGRADE_REFUSED` | 输入不对（包、接受文件、节点记录） | 按 `code` 改正 |

命令可以重复运行：在途时不发第二个请求，做完后只报告做完。

### 0.4 顺序

与滚动升级相同（`rollout/README.md` 第 4 节）：待命节点先升 → 核对 `FLEET_NODE_ALREADY_AT_THIS_PACKAGE` → 当班节点加 `--allow-active-upgrade` 原地升（升级代理排空、暂停、切换、核验、恢复）。不跨 Source 移交：服务端拒绝把 ci-admission 交给 Source 与全队不同的节点（迁移 `20261114120000`）。两台 Source 不同的窗口里列车以 `TRAIN_SOURCE_MISMATCH` 停车，所以前后接着做。

### 0.5 失败

- 请求之前的任何失败：节点没动，改正后换新 `--work` 重跑。
- 升级代理拒绝（Grant 被拒或过期、排空超时、暂存或 Linux stage 拒绝）：节点没动。
- 切换之后核验不过：升级代理把 Windows 与 Linux 两侧一起换回上一代，节点保持暂停，`status.json` 的 `recent` 写着 `ROLLED_BACK_PAUSED` 和原因。生产节点失败一次就停手，先在一次性环境复现。
- `ROLLBACK_FAILED`：走通用重装（它不要求两侧先一致）。

## 目录（通用重装）

1. 总览与顺序
2. 发布机：构建一次
3. 发布机：发布到 GitHub Release
4. Owner 接受一次（接受文件）
5. 每台节点：取包、组装、一次 UAC
6. 顺序与列车窗口（先 DESK，后 TURING）
7. 凭据在哪里
8. 失败时怎么办

## 1. 总览与顺序

```
发布机   build（一次） -> publish release -> Owner 接受 -> publish attach-acceptance
节点     gh release download -> install.mjs prepare（非提权） -> Owner 点 1 次 UAC 运行 runCommand
```

节点顺序：先待命节点 -> 核验 -> 再当班节点（重装期间 CI 停）。要换当班，在开始前、两台还是同一 Source 时移交；装好一台之后不能再移交给它（Source 与全队不同，服务端拒绝，迁移 `20261114120000`）。两台装同一个提交的同一个包，前后接着装。

## 2. 发布机：构建一次

```
node R/rollout/fleet/universal.mjs build --repo <git 目录> --commit <40 位 hex> --version <YYYY.MM.DD-c8> --out <新目录>
```

`--out` 必须是新目录。产出（即 Release 资产，内容不可变）：

- `fleet-node-<version>.tar`：确定性 ustar，含 `tree/`、`bundle/accepted.bundle`、`universal-manifest.json`
- `fleet-node-<version>.release.json`：合同 `clued.independent-ci.fleet-node-release/1`
- `SHA256SUMS`

每个版本只构建一次；节点不构建、不检出仓库。

## 3. 发布机：发布到 GitHub Release

```
node R/rollout/fleet/publish.mjs release --dir <构建输出目录> --repo tdoljyj/cross-memory-system [--index <索引文件>]
```

做的事：先核构建输出（唯一的 release.json、tar 的 sha256、SHA256SUMS），再 `gh release create fleet-node-<version> <tar> <release.json> SHA256SUMS --target <commit>`，用 `gh release view` 核三个资产的名称与大小，最后在索引文件追加一行（Release 链接、tar sha256、commit；接受时间与 Decision 先空）。索引里已有该版本则在调用 gh 之前拒绝；索引文件不存在时新建（带表头）。

索引文件默认：`G:\我的云端硬盘\Clued_资料中心\10_E_工程与平台\CI基础设施\通用节点包_归档索引.md`，表头：版本 | Release | tar sha256 | commit | 接受时间 | Decision。

## 4. Owner 接受一次（接受文件）

接受只做一次，对全体节点适用。**由协调者在 Owner 的 Decision 之后写出**，文件名必须是 `fleet-node-<version>.acceptance.json`：

```json
{ "contract": "clued.independent-ci.fleet-node-acceptance/1",
  "version": "<version>",
  "archive_sha256": "<tar 的 sha256，与 release.json 一致>",
  "commit": "<40 位 hex>",
  "repository": "tdoljyj/cross-memory-system",
  "ciSourceManifestSha256": "<install.mjs source-hash 算出的值>",
  "cluedDecision": "<8 位 hex 或 uuid>",
  "acceptedAt": "<ISO，以 Z 结尾>",
  "fleetRefs": { "<凡进入 record 的、各节点相同的接受引用与 formalRoles>": "…" } }
```

规则：凡进入 `record\source-manifest.json`（从而进入 `ciSourceManifestSha256`）的引用必须放在 `fleetRefs`，各节点相同，这样同一个包在两台上得到同一个 Source。按节点不同的（CI 连接资格 `ciPrincipalQualificationRef`、App 指纹、binding 等）不放这里，从本机记录读。确切字段清单见 `BATCH1-INTERFACES.md` 第 6 节；`formalRoles` 的现值可在任一已装节点上用 `node …\install.mjs fleet-refs` 只读取出。

`ciSourceManifestSha256` 就是 Owner 接受的 Source（列车只比较它）。它只由包和 `fleetRefs` 决定，写接受文件的人先写出不含这一项的草稿，再在任一台机器上只读算出：

```
node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\install.mjs source-hash --artifact <tar> --artifact-sha <hex> --acceptance <草稿>
```

把输出的 `ciSourceManifestSha256` 填进接受文件。每台节点的 `prepare` 都重算一遍，不等即拒绝（`FLEET_SOURCE_NOT_THE_ACCEPTED_ONE`）；`repository` 必须等于节点 record 的仓库。

上传：

```
node R/rollout/fleet/publish.mjs attach-acceptance --version <version> --acceptance <接受文件> [--repo tdoljyj/cross-memory-system] [--index <索引文件>] [--dir <构建输出目录>]
```

先核接受文件：合同、`version`、`archive_sha256` 与 `commit` 必须等于索引行里的值（给了 `--dir` 还要等于 release.json）、`repository` 等于 `--repo`，并按节点 `prepare` 的同一份规则核整份合同（`ciSourceManifestSha256` 的形状、`fleetRefs` 的确切字段、Decision 与时间）；通过后作为追加资产上传（不加 `--clobber`，tar 不变），再把索引行的接受时间与 Decision 补全。该行已有接受则拒绝，且在上传之前。

## 5. 每台节点：取包、组装、一次 UAC

在节点上、Owner 会话、非提权。取包用同一个 `fetch.mjs`（断流续传、只认哈希，见 0.3）：

```
node <任一份 upgrade.mjs> fetch --version <version> --work <新目录> [--from <目录>] --no-request
node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\install.mjs prepare --artifact <tar> --artifact-sha <hex> --acceptance <acceptance.json> --work <新目录2>
```

第一条取包、核哈希、解包（得到 `<新目录>\dl` 与 `<新目录>\unpacked`），并顺带用新包 `upgrade.mjs` 对本机做一次 `--no-request` 演练；需要重装的节点它会答 `FLEET_NODE_UPGRADE_NEEDS_REINSTALL`，正是要走本节的信号。手动 `gh release download` + `Get-FileHash` + 解包同样可以。

1. 先用 `Get-FileHash` 核 tar：输出必须等于接受文件的 `archive_sha256`（也等于索引行与 SHA256SUMS），不等就停，不解包。
2. 解包用 Python 的 `tarfile`（`filter='data'` 拒绝链接、绝对路径和越界路径），不用 Windows 的 `tar.exe`（它解不了非 ASCII 文件名）。`<解包目录>` 必须是新目录。
3. 运行 `prepare`。**这条命令在每台节点上完全相同，没有任何节点参数**：根目录固定为 `C:\ProgramData\CluedIndependentCI\resident`，令牌、已装包、配置都不从命令行给。`--artifact-sha` 就是第 1 步核过的值。

`prepare` 再核一遍 tar 的 sha256 与接受文件，严格读包、逐文件核 `universal-manifest.json`，并要求正在运行的 `install.mjs` 及其模块就是包里的字节；节点身份只从本机读（`install\install-receipt.json`、`record\*`、`config\policy.json`、`config\companion.json`、`install\companion-account.json`、`install\companion-wsl.json`、`upgrade\current.json`、`upgrade\mailbox\responses\version-facts.json` 与 `roles-public.json`、runner 服务的 SDDL，只读）。没有 `install-receipt.json` 的节点走首装分支，见 5.1。不需要按节点的配置文件，也不依赖仓库检出。

依次：构建本节点的首装包（两次，sha 相同）、`linux-in\`、合成的 `inputs\reinstall-config.json`、包内 `rehearse.py --fleet`（必须 `REHEARSAL_PASS`）、包内 `prep.py`（`linux\A.sh`、`B.sh`、`B-resume.sh`）、包内 `generate.py --fleet-plan <plan> --check`（生成启动器前的全部检查，不要求已暂停，不写启动器；不过则停，旧常驻不会被暂停），**然后做 W1 暂停**：包内 `reinstall/tools/pause-old-resident.py`，非提权，reason 为 `fleet-node-reinstall-<version>-w1-before-linux-switch`，必须得到 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`（最多等 90 分钟），所确认的 `PAUSED.json` 的 sha 与 reason 写进 `install-plan.json` 的 `w1Paused`，由启动器钉住；最后包内 `generate.py` 生成 `launcher.ps1`。同一版本再跑一次 `prepare`（换新 `--work`）时，W1 找到自己的暂停并立即确认，不重复请求。

`<work>` 下产出（只许新建）：`package\`、`linux-in\`、`linux\A.sh`、`B.sh`、`B-resume.sh`、`launcher.ps1`、`install-plan.json`。Linux 脚本的输出目录是 `install-plan.json` 里 `linux.outDir` 指定的新目录 `C:\ProgramData\CluedIndependentCI\reinstall-linux-out-<32hex>`，由提权启动器在 Linux A 之前新建并设权限；`prepare` 不建它，也不改任何 ACL。结束时打印一行 JSON：`{status, node, version, workDir, installPlan, launcher:{path, sha256}, runCommand}`。

**Owner 只做一件事：点 1 次 UAC 运行 `runCommand`。** 一次 UAC 内的顺序：W1 暂停（已由 `prepare` 完成，启动器只核 `w1Paused`） -> 暂存 -> Linux A -> Linux B（失败时 B-resume 一次）-> 核 B 的输出（evidence 恰一行 `sha256:` 等于包的 `ciSourceManifestSha256` 且 `exit: 0`；facts 第 1 代、`staged` 为 null、Source 与 Linux manifest 等于包、`pinsOk` 为 true，即 `install-plan.json` 的 `expectedLinux`）-> 卸载 -> 安装 -> verify -> rearm。有 companion 账户的节点，Linux root 步骤由 registrar 的 `root-run` 在 companion 账户的发行版里执行；没有的节点（`companionAccount=false`）由提权 Owner 直接 `wsl.exe -d <发行版> -u root` 运行，其余相同。

### 5.1 首装：同一条命令，没有回执的节点

入口是 `fleet-node-<v>.bootstrap.ps1 -From <目录>`（`bootstrap.ps1`，目录里是该版的 Release 资产）。它先提权跑一次主机准备（`windows/first-install-host.ps1`：账户、runner、发行版、凭据，写 `C:\ProgramData\CluedIndependentCIirst-installacts.json`），再非提权跑 `install.mjs prepare ... --from <目录>`，最后提权跑它给的 `runCommand`。

- `prepare` 的判据只有一个：有没有 `install\install-receipt.json`。没有时：本机不得有任何常驻残留（三个服务、resident 根；有就 `FIRST_INSTALL_RESIDUE_PRESENT` 并列出，不猜、不覆盖）；节点值只从 `facts.json`（`clued.independent-ci.first-install-facts/1`，名字全由机器名推导，规则写在 `readFirstInstallFacts`）和该版的首装 kit 读。
- 首装 kit：`fleet-node-<v>.first-install-kit.json`，任一已装、Linux 与 Windows 同一包的节点上非提权只读运行 `install.mjs first-install-kit` 得到；内容是模板 roles-v3 与 version facts、模板 Source 清单与公钥、全队共用的 record 值、模板 policy/companion 配置、角色镜像。其 sha256 由 Owner 随版接受（接受文件的 `firstInstallKitSha256`），缺它首装即拒绝。kit 要取自装着**更早版本**的节点（模板 Source 等于新包 Source 时派生拒绝）。
- 本地构建的角色镜像（contract-placement 的 `sha256:<id>`）随版发布为 `role-image-<id>.tar.gz`（全队一次导出），B 载入后由 docker 按 id 核内容；新节点不再要任何节点为它导出东西。
- 其后与重装同一路径：建包两次、`linux-in\`、包内 `reinstall/linux/first-install.py` 的 `--in-dir/--out-dir` 形态（`A.sh` 首装检查与派生、`B.sh` 签名与安装、`B-resume.sh` 即 `B.sh`）、`install-plan.json`（`firstInstall`，无 W1，`secrets.source = first-install`）、`generate.py --fleet-plan`。结束输出 `FLEET_NODE_FIRST_INSTALL_PREPARED`。
- 启动器：首装预检（无残留、令牌目录只有 SYSTEM/Administrators）→ 从 `first-install\credentials\` 带令牌并核指纹 → Linux A/B（由提权 Owner `wsl -u root`，发行版此时在 operator 名下）→ 安装（安装完删掉令牌目录）→ verify → 其余同重装。没有 W1、没有卸载。
- 尚未接上：发行版交给 companion 账户的切换（M5-b）；Linux B 之后停下的首装没有续行（新的 `prepare` 会被 Linux A 以 `NOT_A_FIRST_INSTALL` 拒绝），见实现报告。

## 6. 顺序与列车窗口（先待命，后当班）

1. 要换当班的，先在两台还是同一 Source 时移交（`/bindings`）。
2. 发布、Owner 接受完成后，先在待命节点上做第 5 节。
3. 核验它：`verify` 通过、版本事实与 `install-plan.json` 的 `expectedLinux` 一致，`ciSourceManifestSha256` 等于包里的值。
4. 再在当班节点上做第 5 节（重装期间 CI 停）。不移交给刚装好的节点：它的 Source 与当班节点不同，服务端拒绝（迁移 `20261114120000`）。

列车只比较 `ciSourceManifestSha256`；两台装不同提交的包会出现 `TRAIN_SOURCE_MISMATCH`。所以两台装同一个提交的同一个包，DESK 核验通过后立刻接着装 TURING，缩短两台 Source 不同的窗口。

## 7. 凭据在哪里

- 发布机只用 `gh` 自己的登录（`gh auth login` 存在 gh 自己的凭据库）。`publish.mjs` 调 gh 时去掉环境里的 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，不读、不写、不打印任何令牌。
- 节点取包同样用节点上 gh 自己的登录；包与接受文件里没有任何凭据，只有哈希与引用。
- 令牌不写进命令行、环境变量、日志、索引文件或接受文件。节点的升级令牌与心跳令牌从现装节点带入：`prepare` 只读回执里的目标路径、指纹和 bindingId（`install-plan.json` 的 `secrets`，`source: installed`），从不打开令牌；启动器在 UAC 内、卸载之前把它们复制到只给 SYSTEM 与 Administrators 的 `C:\ProgramData\CluedIndependentCI\reinstall-carry-<32hex>\`，按指纹核对后交给安装器。这个目录用完一律删除，未删掉的由下次运行清扫。

## 8. 失败时怎么办

- 生产节点失败一次就停手：不重试、不改参数硬再跑。先在一次性环境复现，核实根因，做最小修复，再一次性上生产。
- `prepare` 的输出只许新建：失败后换一个新 `--work` 目录，不复用旧的。W1 之后才失败（例如 `generate.py`）时，旧常驻保持暂停；重跑 `prepare`（同一版本或更新的包）时 W1 直接认领留下的重装暂停，不需要先解除。
- 启动器是一次性的：同一个文件再跑只会得到 `EXISTING_EXECUTION_PRESERVED`。停下之后（DESIGN §73）：
  - A 开始之前停下：节点没动，W1 暂停已自动解除；重跑 `prepare`。
  - A 之后停下（Linux 已是新包、Windows 还是旧装，节点保持暂停）：`python -I <tree>\work\independent-ci-resident-v1\reinstall\launcher\generate.py --fleet-continue <那次的 launcher.ps1> --out <新 launcher.ps1>`，再提权运行输出里的 `elevatedCommand`。暂停若已被解除，这条命令会重新请求。此时对同一个包重跑 `prepare` 会得到 `LINUX_SIDE_ALREADY_THIS_PACKAGE_CONTINUE_THE_STOPPED_LAUNCH`。
  - 那个包本身续不下去、已经换了新包：直接用新包 `prepare` + 启动器，两侧各从现状装到新包。
- `RUNNER_SERVICE_NOT_AS_REVIEWED`：当班节点在暂停下仍会为自己的维护临时交换运行器，预检会等它换回（最多 600 秒）；到时仍不对才停。
- `publish.mjs` 在 gh 失败时不动索引；`release` 失败后先看 Release 是否已建出一部分，不要重复创建同一 tag。
- `attach-acceptance` 对已接受的版本拒绝；接受文件写错要由协调者与 Owner 重新决定，不覆盖。
- B 在 Source 切换之后失败：模板自动用 B-resume 续跑一次；仍失败则停手，交协调者。
- 节点装完 `verify` 不过：不继续装另一台。
