# 通用节点包：升级与重装操作说明

节点只有两条路，用的是**同一个通用包、同一份接受文件**：

1. **通用升级**（第 0 节）：已装节点原地升级，零 UAC，失败自动回滚。默认走这条。
2. **通用重装与首装**（第 1–8 节）：已装节点答 `FLEET_NODE_UPGRADE_NEEDS_REINSTALL` 时、以及新节点（没有安装回执）时走。**唯一入口是 `fleet-node-<v>.bootstrap.ps1 -From <目录>`**（第 5 节），重装与首装是同一条命令。

只构建一个通用包。包里没有任何节点值（无 record 引用、节点档案选择、SID、路径），节点身份全部在节点上从本机记录读。接口细节见 `BATCH1-INTERFACES.md`，升级的设计见 [ADR 0030](../../docs/adr/0030-fleet-generic-upgrade.md)。

`R = work/independent-ci-resident-v1`。

## 更换节点的 CI 连接

含自续功能的代次由 LocalSystem Broker 处理 CI 与升级连接。常驻每天向 Broker 投递一次两类连接的续期请求；是否进入窗口、是否当班由 Broker 的新鲜签名探询判断，到达窗口开启时刻后申请同权限续期。CI 节点在本机排空后由服务端核对当班与排空状态。当班先让班；旧连接到期造成角色探测不确定时，仍可走签名探询并续期。升级连接独立处理。查看 `state/status.json` 的 `versions.renewal`，确认新连接编号、到期时刻、签名权限自检和后续心跳。

已部署签名探询与计划内让班入口的环境中，旧安装可凭机器签名和旧令牌证明定位项目。当班节点在服务端续期窗口内自动请求让班，收到接班回执后停止开新批，由角色探针和本地账本确认待命、排空，再续期。让班被拒时保留原连接与当班能力，状态显示拒绝码；无合格接班者与网关未确认类失败一小时后重试，其余拒绝次日重试。换载体请求照常处理。

[节点当前连接合同](../../docs/ci-connection.md)

## 0. 通用升级（Owner 手册）

### 0.1 Owner 做什么

| 步骤 | Owner | UAC |
|---|---|---|
| 接受这一版 | 一次 Decision（全体节点适用） | 无 |
| 每台节点升级 | 自动审批开着：什么都不做。没开：在该节点 `upgrade\status.json` 的 `confirmUrl` 页面点一次批准 | 无 |
| 当班节点 | 最后升，命令加 `--allow-active-upgrade`，升级期间 CI 暂停几分钟。服务端不把 ci-admission 移交给 Source 与全队不同的节点（迁移 `20261114120000`），所以要移交只能在开始前、两台还是同一 Source 时做 | 无 |
| 升级回滚了（`ROLLED_BACK_PAUSED`） | 看原因；恢复该节点 | 无 |

自动审批的边界（服务端现有规则）：每节点 24 小时内自动批 6 次；同一个包第二次请求、或上一次自动批的升级没成功，归 Owner 手动批。

切换为先核验后变绿时，两台节点都升级后，全队新发出的扫描检查才都遵循新次序。旧版发出的成功检查仍可能被复用。节点一旦用新版开始发布扫描，回退必须选用支持效果账本 `created` 和 `completing` 状态的版本。旧版遇到这两种状态可能要求对账或停机。

### 0.2 发布机与协调者（一次）

1. 构建、发布：第 2、3 节，不变。
2. 接受前：`publish.mjs prepare`（第 4 节），产出给 Owner 看的接受请求。**`fleetRefs` 里进入 Source 的三项 `sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles` 沿用现装值**，由 `prepare` 从本机已装记录只读带入（与 `install.mjs fleet-refs` 同一来源），这一版才能原地升级。三项里有任何一项要换，这一版对所有节点都是重装（`prepare` 不提供改它们的入口，要换先找 Fable）。
3. Owner 接受、写完 Decision（正文带 prepare 给的那一行，并原样保存那次写入的返回）后：`publish.mjs seal --decision-record`（第 4 节），Decision、回执与时间都从那份返回里读。

### 0.3 每台节点：同一条命令

Owner 会话、非提权。一条命令（取包、核哈希、解包、组装、预检、发请求）：

```
node <任一份 upgrade.mjs> fetch --version <version> --work <新目录> [--from <本地或共享目录>] [--no-request] [--allow-active-upgrade]
```

`<任一份 upgrade.mjs>` 用上一版已解包的包里的（或任何一份 `upgrade.mjs` 加 `fetch.mjs`）；真正执行升级的是新包解出来的那份 `upgrade.mjs`。取包由 `fetch.mjs` 做：按 release 资产分段续传（Range，连接被断就从已收到的字节接着要，退避重试，总时限 30 分钟），令牌只在进程内取自 `gh auth token`，不打印不落盘；也可以把 `fleet-node-<version>.tar`、`.acceptance.json`、`SHA256SUMS` 放进 `--from` 目录（Google Drive、共享盘都行，release 取不下来时用）。两个来源一视同仁，只认哈希：tar 的 sha256 必须等于接受文件的 `archive_sha256` 且等于 `SHA256SUMS` 那行，不符就删掉、不解包、不组装。断了就原样再跑同一条命令（同一个 `--work`），续传。产物：`<新目录>\dl\`（下载）、`<新目录>\unpacked\`（解包）、`<新目录>\upgrade\`（升级的工作目录）。输出是新包 `upgrade.mjs` 的那一行 JSON，多一个 `fetched`（来源、尝试次数、续传次数）。

分步手动做仍可以：`gh release download` + `Get-FileHash` + 解包，再用 `--artifact` 形式（输出相同）：

```
node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\upgrade.mjs --artifact <tar> --artifact-sha <hex> --acceptance <acceptance.json> --work <目录>
```

没有节点参数。`--work` 目录不要放在会被清理的临时目录里：每次需要组装时在它下面新建一个 `run-*`，升级代理从 `<目录>\run-*\package` 读包；同一个 `--work` 可以原样再用（看进度、改正后重跑），以前的 `run-*` 不动。加 `--no-request` 只组装和预检，不发请求（演练）。

输出一行 JSON，`status` 是下面之一：

| status | 意思 | 下一步 |
|---|---|---|
| `FLEET_NODE_UPGRADE_REQUESTED` | 已组装、预检通过、请求已投 | 等；再跑同一条命令看进度 |
| `FLEET_NODE_UPGRADE_IN_PROGRESS` | 升级代理有操作在途（`op.state`、`op.confirmUrl`） | 等；`WAITING_GRANT` 且没开自动审批时 Owner 批一次 |
| `FLEET_NODE_ALREADY_AT_THIS_PACKAGE` | 两侧都已是这个包 | 这台做完了 |
| `FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED` | `--no-request` | 无 |
| `FLEET_NODE_UPGRADE_NEEDS_REINSTALL` | 这台不能原地升（`code` 写明：通道变了、Source 引用变了、两侧不是同一个包、Linux 现场与记录不符） | 把该版资产放进一个目录，走第 5 节唯一入口 `fleet-node-<v>.bootstrap.ps1 -From <目录>` |
| `FLEET_NODE_UPGRADE_HAND_OVER_FIRST` | 这台现在当班，没有发请求 | 其他节点都升好后加 `--allow-active-upgrade` 再跑（CI 暂停几分钟）；不能移交给已升级的节点（Source 不同，服务端拒绝） |
| `FLEET_NODE_UPGRADE_PRECHECK_REFUSED` | 预检拒绝但不用重装（例如 `FLEET_SOURCE_MISMATCH`：先升另一台） | 按 `precheck.advice` |
| `FLEET_NODE_UPGRADE_REFUSED` | 输入不对（包、接受文件、节点记录） | 按 `code` 改正 |

命令可以重复运行：在途时不发第二个请求，做完后只报告做完。

### 0.4 顺序

与滚动升级相同（`rollout/README.md` 第 4 节）：待命节点先升 → 核对 `FLEET_NODE_ALREADY_AT_THIS_PACKAGE` → 当班节点加 `--allow-active-upgrade` 原地升（升级代理排空、暂停、切换、核验、恢复）。不跨 Source 移交：服务端拒绝把 ci-admission 交给 Source 与全队不同的节点（迁移 `20261114120000`）。两台 Source 不同的窗口里列车以 `TRAIN_SOURCE_MISMATCH` 停车，所以前后接着做。

### 0.5 失败

- 请求之前的任何失败：节点没动，改正后原样重跑同一条命令。
- 升级代理拒绝（Grant 被拒或过期、排空超时、暂存或 Linux stage 拒绝）：节点没动。
- 切换之后核验不过：升级代理把 Windows 与 Linux 两侧一起换回上一代，节点保持暂停，`status.json` 的 `recent` 写着 `ROLLED_BACK_PAUSED` 和原因。生产节点失败一次就停手，先在一次性环境复现。
- `ROLLBACK_FAILED`：走通用重装（它不要求两侧先一致）。

## 目录（通用重装与首装）

1. 总览与顺序
2. 发布机：构建一次
3. 发布机：发布到 GitHub Release
4. 接受：接受前 prepare、接受后 seal（Owner 只说一次“接受”）
5. 每台节点：唯一入口 bootstrap.ps1（重装与首装）
6. 顺序与列车窗口（先 DESK，后 TURING）
7. 凭据在哪里
8. 失败时怎么办

## 1. 总览与顺序

```
发布机   build（一次） -> publish release -> publish prepare（取 kit、备镜像、上传、写接受请求；Owner 面前的唯一产物） -> 候选演练（drill/，PASS 才往下） -> Owner 接受（一次；写 Decision 并保存返回） -> publish seal（读 Decision 记录、挂接受文件、写索引）
节点     该版资产放进一个目录 -> fleet-node-<v>.bootstrap.ps1 -From <目录>（非提权；它取前置、解包、prepare，在要提权处自己请求 UAC）
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

每个版本只构建一次；节点不构建、不检出仓库。包内路径只许可打印 ASCII（`UNIVERSAL_TREE_PATH_NOT_ASCII`）：节点入口用 Windows 自带的 `tar.exe` 解包，它写不了非 ASCII 文件名。

## 3. 发布机：发布到 GitHub Release

```
node R/rollout/fleet/publish.mjs release --dir <构建输出目录> --repo tdoljyj/cross-memory-system [--index <索引文件>]
```

做的事：先核构建输出（唯一的 release.json、tar 的 sha256、SHA256SUMS），再 `gh release create fleet-node-<version> <tar> <release.json> SHA256SUMS --target <commit>`，用 `gh release view` 核三个资产的名称与大小，最后在索引文件追加一行（Release 链接、tar sha256、commit；接受时间与 Decision 先空）。索引里已有该版本则在调用 gh 之前拒绝；索引文件不存在时新建（带表头）。

索引文件默认：`G:\我的云端硬盘\Clued_资料中心\10_E_工程与平台\CI基础设施\通用节点包_归档索引.md`，表头：版本 | Release | tar sha256 | commit | 接受时间 | Decision。

## 4. 接受：接受前 prepare、接受后 seal（Owner 只说一次“接受”）

接受分两段，各是一条命令、都可以原样重跑；**首装 kit 的检查在 `prepare` 里**（缺 kit 的包造不出可接受的东西）。把 kit 或接受文件挂上 Release 只有这两条命令：挂 kit、挂接受文件的步骤没有单独的命令，手写的接受文件没有入口。两条命令对“请求与 Release 是否对应”用同一个核对（`checkRequestOnRelease`）：Release 的 `SHA256SUMS` 与 `release.json` 指名请求里的 tar，`release.json` 的 commit 等于请求的，用从 Release 下载的 tar 由包自带的 `source-hash` 重算 Source 并与请求比，再核 kit。`prepare` 写出的请求，`seal` 不会因这一核对而拒。

**“已接受”只看 Release**：Release 上有 `fleet-node-<version>.acceptance.json` 就是已接受，索引行只是它的派生记录。

### 4.1 接受前：prepare（产出 Owner 要看的接受请求）

```
node R/rollout/fleet/publish.mjs prepare --version <version> --dir <构建输出目录> --out <目录> [--image <role-image-<id>.tar.gz> ...] [--repo tdoljyj/cross-memory-system] [--index <索引文件>]
```

在 `release` 之后、Owner 接受之前，在**装着更早版本、Linux 与 Windows 同一包的本机已装节点**上运行（非提权，对节点只读），且**在本机升到该版之前**。不要 Decision、回执或时间，也不读任何手写的字段文件。它依次做，任何一步不过就不写接受请求：

1. Release 上已有该版接受文件：拒绝（`PREPARE_VERSION_ALREADY_ACCEPTED`），不再挂 kit、不再写请求，Release 缺 kit 也一样；索引行还空着，说明上次 `seal` 在写索引之前断了，用原参数重跑 `seal` 补上。索引行有值而 Release 上没有接受文件：拒绝，不猜。
2. 首装 kit：**Release 上已有该版 kit 就用 Release 上那一份**（下载），不再去节点取。kit 的 `template.versionFacts` 带 `observedAt`，每次从节点取都是不同的字节；挂上之后，Release 上那一份就是唯一事实。Release 上还没有，才从本机取。两种来源都按新节点的读法核（`readKit`），并核模板 Source 不等于本包 Source：相等即拒绝，说明本机已经升到这一版，须在升级之前执行。
3. 接受请求的 `fleetRefs`：从本机已装记录只读带入，来源与 `install.mjs fleet-refs` 相同：`sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles` 三项进 Source；`ownerAuthorizationRef`、`publisherQualificationRef`、`ownerPackageAcceptanceRef` 三项不进 Source，每次接受都沿用（来源见 `BATCH1-INTERFACES.md` 第 6 节）。Source 用上面的同一核对，从 Release 的 tar 算出（Decision、回执与时间不进 Source，算时用演练保留值占位）。
4. 备齐 kit 列的每个本地角色镜像：用 `--image` 给；没给就用索引里上一版 Release 的同 id `role-image-<id>.tar.gz`，并按该版 `first-install.SHA256SUMS` 核哈希。缺一个即拒绝；下载失败按下载失败报，不当作缺镜像。
5. 把 kit 与镜像放进 `--out`，Release 上缺的 kit、镜像与 `fleet-node-<version>.first-install.SHA256SUMS` 补传。Release 上已有的按**内容**比，不按大小：相同不重传，不同的镜像或 sums 替换；Release 上是另一份 kit 则拒绝。sums 读回整份比对，整个请求再按同一核对比一遍 Release，最后写 `fleet-node-<version>.acceptance-request.json`（文件整份写成或不写）。

接受请求（合同 `clued.independent-ci.fleet-node-acceptance-request/1`）只有这些字段：`version`、`archive_sha256`、`commit`、`repository`、`ciSourceManifestSha256`、`firstInstallKitSha256`，以及上面六项 `fleetRefs`。**没有 Decision 字段**：这就是摆给 Owner 的那一份。输出里还有 `requestSha256` 和一行 `decisionLine`（`acceptance-request fleet-node-<version> sha256:<请求文件的 sha256>`），写 Decision 时把这一行原样放进正文。上传中途断了，原样重跑同一条命令（同一个 `--out`）即可。

### 4.2 候选演练（接受之前）

Owner 接受的，应当是已经在干净机器上装通过的东西：候选演练（`drill/`，见 `drill/FIRST-INSTALL-KIT.md`）用接受请求和该版的 kit、镜像组装自己的来宾目录。演练给来宾用的接受文件由接受请求加**演练保留值**生成（`publish.mjs` 的 `DRILL_RESERVED` 与 `acceptanceOf`，仓库里只此一处）。`seal` 与挂接受文件的步骤见到保留值即拒绝（`namesDrillReserved`），所以这份文件上不了 Release，真实节点拿不到。演练结束立刻 `-Finalize`（只回读 A9），回执定稿。`seal --drill-receipt` 只收 `candidate` 为 `true`、结论是 `PASS_A_FULL`、`PASS_A_PER_NODE_STEPS_REMAIN` 或 `PASS_A_REINSTALL_NOT_DRILLED`（候选显式带 `-SkipReinstall` 跳过 A8 时只能是它，同包重装未演练；`DRILL_PASS_CONCLUSIONS`）的回执，`PASS_A_PENDING_PRODUCTION_READBACK` 等一律拒绝。顺序是**演练 → `-Finalize` → 把请求与终稿回执摆给 Owner → 接受 → seal**，接受之后不开机、不再回读。演练失败不找 Owner：修、出新候选、重跑。首装演练不是原地升级的门，只走升级路径的紧急包可以不带演练回执。

### 4.3 接受后：seal（填 Decision、挂上 Release、写索引）

Owner 说“接受”之后，协调者写 Decision，正文放 4.1 的那一行。写的那一次 `clued_record_mutate` 的**完整返回当场原样存成文件**（Decision 记录），之后补不回来，没存下就只能再写一条 Decision。然后：

```
node R/rollout/fleet/publish.mjs seal --request <目录>\fleet-node-<version>.acceptance-request.json --decision-record <那次 clued_record_mutate 的返回文件> [--drill-receipt <候选演练定稿的 receipt.json>] [--repo tdoljyj/cross-memory-system] [--index <索引文件>]
```

只读接受请求和 Decision 记录，**不碰节点、不取 kit**。Decision、回执与接受时间都只从 Decision 记录里读：

- Decision id 取 `target_refs[0].id`；
- 回执 id 取 `receipt_id`；
- 接受时间取 `supplemental.record.created_at`，截到秒，以 Z 结尾。

命令行上没有这三个值的参数。

Decision 记录要满足：已提交（`status: committed`）、恰一个目标、回执与目标是两个不同的 UUID；`supplemental.record` 是 Decision，它自带的 `id`、`receipt_id` 与上面两个相同；正文含本次请求的那一行（给别的候选写的 Decision 封不了这一个）；时间不在未来。

`seal` 用这三个值填接受才有的五处：`cluedDecision` = `fleetRefs.ownerDecisionRef` = Decision，`installationReceiptRef` = `ownerReceiptRef` = 回执，`acceptedAt`。然后按节点 `prepare` 的同一份规则核整份合同，核索引行，再做同一个“请求对 Release”的核对。演练保留值即拒绝。都过了才把 `fleet-node-<version>.acceptance.json` 作为追加资产上传（不加 `--clobber`，tar 不变），补全索引行的接受时间、Decision、首装演练三格。最后把接受文件和 Decision 记录（`fleet-node-<version>.decision-record.json`，不上传）写到接受请求旁边。

- `--drill-receipt`：要求见 4.2，且三项哈希与这份接受相同。索引“首装演练”格记它的结论与回执 sha256；没给，记“首装未演练”。已封的行，这一格不再改：换回执或去掉回执重跑都拒绝。
- 同样的参数再跑一次：已挂上、已写索引就什么都不改；上传后、写索引前断了的，补写索引。同一版本换一个 Decision 再 seal：拒绝，且在上传之前。

**交付目录**（给新节点 `bootstrap.ps1 -From`，第 5 节）就是该版 Release 的全部资产，在 `seal` 之后用 `gh release download fleet-node-<version> --pattern "fleet-node-<version>.*" --pattern "SHA256SUMS" --pattern "role-image-*.tar.gz"` 取进一个新目录（只取这一条，它取的就是 bootstrap 首装要的全部资产）。`prepare` 的 `--out`（含接受请求、Decision 记录）不是交付目录：bootstrap 会把其中没列在两份 sums 里的文件当作多出的文件拒绝。

接受文件（合同 `clued.independent-ci.fleet-node-acceptance/1`，文件名 `fleet-node-<version>.acceptance.json`）由 `seal` 写出，形如：

```json
{ "contract": "clued.independent-ci.fleet-node-acceptance/1",
  "version": "<version>",
  "archive_sha256": "<tar 的 sha256，与 release.json 一致>",
  "commit": "<40 位 hex>",
  "repository": "tdoljyj/cross-memory-system",
  "ciSourceManifestSha256": "<从 Release 的 tar 算出的 Source>",
  "cluedDecision": "<Decision 的 uuid>",
  "acceptedAt": "<ISO，以 Z 结尾>",
  "fleetRefs": { "<凡进入 record 的、各节点相同的接受引用与 formalRoles>": "…" },
  "firstInstallKitSha256": "<Release 上那份 kit 的 sha256>" }
```

规则：凡进入 `record\source-manifest.json`（从而进入 `ciSourceManifestSha256`）的引用，都必须放在 `fleetRefs`，各节点相同，这样同一个包在两台上得到同一个 Source。按节点不同的（CI 连接资格 `ciPrincipalQualificationRef`、App 指纹、binding 等）不放这里，从本机记录读。确切字段清单见 `BATCH1-INTERFACES.md` 第 6 节。`ciSourceManifestSha256` 就是 Owner 接受的 Source，列车只比较它；每台节点的 `prepare` 都重算一遍，不等即拒绝（`FLEET_SOURCE_NOT_THE_ACCEPTED_ONE`）；`repository` 必须等于节点 record 的仓库。

## 5. 每台节点：唯一入口 bootstrap.ps1（重装与首装）

在节点上、Owner 会话、**普通（非提权）窗口**，用系统自带的 Windows PowerShell 5.1。重装与首装是同一条命令，**没有任何节点参数**：

```
powershell -NoProfile -ExecutionPolicy Bypass -File <目录>\fleet-node-<v>.bootstrap.ps1 -From <目录>
```

`<目录>` 放该版的 Release 资产（U 盘、共享盘、同步文件夹都可以，只认哈希；路径只许字母、数字、`.`、`_`、`-` 与 `\`）：`fleet-node-<v>.tar`、`fleet-node-<v>.release.json`、`SHA256SUMS`、`fleet-node-<v>.bootstrap.ps1`、`fleet-node-<v>.prereq-manifest.json`、`fleet-node-<v>.acceptance.json`；首装另要 `fleet-node-<v>.first-install-kit.json`、它列出的每个 `role-image-<64hex>.tar.gz` 与 `fleet-node-<v>.first-install.SHA256SUMS`。取资产用第 4.3 节“交付目录”那一条 `gh release download`（`fetch.mjs` 只取 tar、接受文件与 `SHA256SUMS`，够原地升级，组不齐首装目录）。

bootstrap 依次做（每一步看它所运行程序的最后一个 JSON 对象）：

1. 核资产集合与每个哈希（两份 sums 文件；多一个、少一个、哈希不符都拒绝）。
2. 前置清单：这次要用的前置必须已钉住（sha256 与字节数），否则 `PREREQ_NOT_PINNED`，什么都不取。**已装节点（重装）只用 node、python、git**；首装用全部七项与 .deb。每个文件先找 `<目录>` 里哈希相符的，没有再下载，都核 sha256 与大小。
3. 用 Windows 自带的 `tar.exe` 解出 `tree/`。`tar.exe` 写不了非 ASCII 文件名，所以构建器不许包里有这样的路径（第 2 节）；`prepare` 再逐文件核自己的字节，不信任解包工具。
4. 有 `C:\ProgramData\CluedIndependentCI\resident\install\install-receipt.json`：非提权运行包内 `install.mjs prepare`（下面），再请求 1 次 UAC 运行它生成的启动器。没有回执：首装，见 5.1。
5. 结局只有一行 JSON：`BOOTSTRAP_DONE`（核验通过、已暂停；首装还要求 companion 切换通过），否则写明停在哪一步、为什么。

`install.mjs prepare` 是 bootstrap 内部的一步，不是 Owner 的命令，不要绕过 bootstrap 手工运行它。**注意**：在协调者钉住 `prereq-manifest.json` 的 node、python、git 之前，bootstrap 对重装和首装都答 `PREREQ_NOT_PINNED`。

### prepare 做什么（bootstrap 内部）

`prepare` 的命令行在每台节点上完全相同，没有任何节点参数：根目录固定为 `C:\ProgramData\CluedIndependentCI\resident`，令牌、已装包、配置都不从命令行给；`--artifact-sha` 是 bootstrap 第 1 步核过的值。

`prepare` 再核一遍 tar 的 sha256 与接受文件，严格读包、逐文件核 `universal-manifest.json`，并要求正在运行的 `install.mjs` 及其模块就是包里的字节；节点身份只从本机读（`install\install-receipt.json`、`record\*`、`config\policy.json`、`config\companion.json`、`install\companion-account.json`、`install\companion-wsl.json`、`upgrade\current.json`、`upgrade\mailbox\responses\version-facts.json` 与 `roles-public.json`、runner 服务的 SDDL，只读）。没有 `install-receipt.json` 的节点走首装分支，见 5.1。不需要按节点的配置文件，也不依赖仓库检出。

依次：构建本节点的首装包（两次，sha 相同）、`linux-in\`、合成的 `inputs\reinstall-config.json`、包内 `rehearse.py --fleet`（必须 `REHEARSAL_PASS`）、包内 `prep.py`（`linux\A.sh`、`B.sh`、`B-resume.sh`）、包内 `generate.py --fleet-plan <plan> --check`（生成启动器前的全部检查，不要求已暂停，不写启动器；不过则停，旧常驻不会被暂停），**然后做 W1 暂停**：包内 `reinstall/tools/pause-old-resident.py`，非提权，reason 为 `fleet-node-reinstall-<version>-w1-before-linux-switch`，必须得到 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`（最多等 90 分钟），所确认的 `PAUSED.json` 的 sha 与 reason 写进 `install-plan.json` 的 `w1Paused`，由启动器钉住；最后包内 `generate.py` 生成 `launcher.ps1`。同一版本再跑一次（bootstrap 每次用新的工作目录）时，W1 找到自己的暂停并立即确认，不重复请求。

`<work>` 下产出（只许新建）：`package\`、`linux-in\`、`linux\A.sh`、`B.sh`、`B-resume.sh`、`launcher.ps1`、`install-plan.json`。Linux 脚本的输出目录是 `install-plan.json` 里 `linux.outDir` 指定的新目录 `C:\ProgramData\CluedIndependentCI\reinstall-linux-out-<32hex>`，由提权启动器在 Linux A 之前新建并设权限；`prepare` 不建它，也不改任何 ACL。结束时打印一行 JSON：`{status, node, version, workDir, installPlan, launcher:{path, sha256}, runCommand}`。

**重装时 Owner 只做一件事：bootstrap 请求时点 1 次 UAC**（它复制 `prepare` 写的启动器到只给管理员的目录、核 sha256，再以 `-RunApprovedInstall` 运行）。一次 UAC 内的顺序：W1 暂停（已由 `prepare` 完成，启动器只核 `w1Paused`） -> 暂存 -> Linux A -> Linux B（失败时 B-resume 一次）-> 核 B 的输出（evidence 恰一行 `sha256:` 等于包的 `ciSourceManifestSha256` 且 `exit: 0`；facts 第 1 代、`staged` 为 null、Source 与 Linux manifest 等于包、`pinsOk` 为 true，即 `install-plan.json` 的 `expectedLinux`）-> 卸载 -> 安装 -> verify -> rearm。有 companion 账户的节点，Linux root 步骤由 registrar 的 `root-run` 在 companion 账户的发行版里执行；没有的节点（`companionAccount=false`）由提权 Owner 直接 `wsl.exe -d <发行版> -u root` 运行，其余相同。

### 5.1 首装：同一条命令，没有回执的节点

同一个入口 `fleet-node-<v>.bootstrap.ps1 -From <目录>`。它先非提权运行 `install.mjs first-install-check`（接受文件、tar 与 kit 的哈希、角色镜像，并核 toolchain 的 `node.exe` 就是 kit 记录的控制器运行时：不符即 `CONTROLLER_NODE_NOT_THE_FLEETS`，在任何 UAC 之前），再提权跑一次主机准备（UAC 1，`windows/first-install-host.ps1`：账户、runner、发行版、凭据，写 `C:\ProgramData\CluedIndependentCI\first-install\facts.json`；它读的 tar 与前置清单是 bootstrap 复制到本地工作目录的副本，提权令牌看不到 Owner 映射的盘符），再非提权跑 `install.mjs prepare ... --from <目录>`，最后提权跑它给的启动器（UAC 2）。

- `prepare` 的判据只有一个：有没有 `install\install-receipt.json`。没有时：本机不得有任何常驻残留（三个服务、resident 根；有就 `FIRST_INSTALL_RESIDUE_PRESENT` 并列出，不猜、不覆盖）；节点值只从 `facts.json`（`clued.independent-ci.first-install-facts/1`，名字全由机器名推导，规则写在 `readFirstInstallFacts`）和该版的首装 kit 读。CI 根对 operator 不可列目录（主机准备设的 DACL），`prepare` 看不到 `resident-uninstalled-*`：输出的 `residueUnchecked` 写明这一项没查，不当作没有（主机准备与启动器在提权下查）。
- 首装 kit：`fleet-node-<v>.first-install-kit.json`，由 `publish.mjs prepare` 在接受前从装着更早版本的本机已装节点取得并上传，挂上之后只认 Release 上那一份（第 4 节；没有单独的取 kit、挂 kit 步骤）；内容是模板 roles-v3 与 version facts、模板 Source 清单与公钥、全队共用的 record 值、模板 policy/companion 配置、角色镜像。其 sha256 由 Owner 随版接受（接受文件的 `firstInstallKitSha256`）：没有它的接受文件，`seal` 不挂、`prepare` 与升级不读（`FLEET_ACCEPTANCE_HAS_NO_FIRST_INSTALL_KIT`）；Release 上缺 kit 资产、`first-install.SHA256SUMS` 里的哈希与接受文件不等、或缺 kit 列的任一镜像，`seal` 同样拒绝。本机已装的旧版记录不受影响。
- 本地构建的角色镜像（contract-placement 的 `sha256:<id>`）随版发布为 `role-image-<id>.tar.gz`（全队一次导出），B 载入后由 docker 按 id 核内容；新节点不再要任何节点为它导出东西。
- 其后与重装同一路径：建包两次、`linux-in\`、包内 `reinstall/linux/first-install.py` 的 `--in-dir/--out-dir` 形态（`A.sh` 首装检查与派生、`B.sh` 签名与安装、`B-resume.sh` 即 `B.sh`）、`install-plan.json`（`firstInstall`，无 W1，`secrets.source = first-install`）、`generate.py --fleet-plan`。结束输出 `FLEET_NODE_FIRST_INSTALL_PREPARED`。
- 启动器：首装预检（无残留、令牌目录只有 SYSTEM/Administrators）→ 从 `first-install\credentials\` 带令牌并核指纹 → Windows 侧完整预检（runner 等待、两处秘密文件、安装器的两次 dry run 与 ACL 迁移计划；不过即停，Linux 未动）→ Linux A/B（由提权 Owner `wsl -u root`，发行版此时在 operator 名下的导入位置）→ 安装 → verify → companion → rearm → 现有的 M5-b 切换（`rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory`，把发行版 move 到 companion 名下）。没有 W1、没有卸载。切换没有通过（`companionHeadless` 不是 `COMPANION_HEADLESS_QUALIFIED`）时 bootstrap 答 `BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE`，不答 `BOOTSTRAP_DONE`。
- 令牌目录（`first-install\credentials\`）不留过本次运行：主机准备开始前先删掉以前运行留下的；主机准备只在 bootstrap 仍在等它时（进程号与启动时间）为启动器保留，bootstrap 已放弃等待或窗口已关就删；启动器在任何结局都删除（停止、异常、完成）；`prepare` 失败或启动器 UAC 被拒时 bootstrap 再请求一次 UAC 清掉。
- 主机准备先写 `facts.json`（整份或没有），再放 App 私钥与 ci-admission 令牌：中途断掉只会留下有 facts、缺秘密的状态，下次运行按 facts 记录的指纹只问缺的那些（facts 记录了心跳令牌就必须再给），`-Reset` 能清掉；不会留下没有 facts、无法归属的秘密。
- 中途停止：Linux A 之前停下，什么都没动，重跑同一条命令（P1 会再问令牌）。A 完成之后停下（B 中断、失败或 Windows 侧未完成），重跑同一条命令：Linux A 找到本提交的暂存（同一个包、自 A 起未变、新输入目录与暂存逐字节一致）即不再暂存，B 从停下处接着做；不一致按名拒绝。已安装（有回执）之后停下的，按重装处理。

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
- bootstrap 每次运行用新的工作目录（`C:\ProgramData\CluedBootstrap\<32hex>`），`prepare` 的输出只许新建。W1 之后才失败（例如 `generate.py`）时，旧常驻保持暂停；重跑同一条 bootstrap 命令（同一版本或更新的包）时 W1 直接认领留下的重装暂停，不需要先解除。
- 启动器是一次性的：同一个文件再跑只会得到 `EXISTING_EXECUTION_PRESERVED`。重装的启动器停下之后（DESIGN §73）：
  - A 开始之前停下：节点没动，W1 暂停已自动解除；重跑同一条 bootstrap 命令。
  - A 之后停下（Linux 已是新包、Windows 还是旧装，节点保持暂停）：`python -I <tree>\work\independent-ci-resident-v1\reinstall\launcher\generate.py --fleet-continue <那次的 launcher.ps1> --out <新 launcher.ps1>`，再提权运行输出里的 `elevatedCommand`。暂停若已被解除，这条命令会重新请求。此时对同一个包重跑 bootstrap 会得到 `LINUX_SIDE_ALREADY_THIS_PACKAGE_CONTINUE_THE_STOPPED_LAUNCH`。首装的启动器不走这条（`PRIOR_LAUNCHER_IS_A_FIRST_INSTALL_NOT_CONTINUED`），见 5.1 的中途停止。
  - 那个包本身续不下去、已经换了新包：直接用新包的 bootstrap，两侧各从现状装到新包。
- `RUNNER_SERVICE_NOT_AS_REVIEWED`：当班节点在暂停下仍会为自己的维护临时交换运行器，预检会等它换回（最多 600 秒）；到时仍不对才停。
- `publish.mjs` 在 gh 失败时不动索引；`release` 失败后先看 Release 是否已建出一部分，不要重复创建同一 tag。
- `seal` 对已用另一个 Decision 接受的版本拒绝；接受文件写错要由协调者与 Owner 重新决定，不覆盖。`prepare` 或 `seal` 中途断了，原样重跑同一条命令。
- B 在 Source 切换之后失败：模板自动用 B-resume 续跑一次；仍失败则停手，交协调者。
- 节点装完 `verify` 不过：不继续装另一台。
