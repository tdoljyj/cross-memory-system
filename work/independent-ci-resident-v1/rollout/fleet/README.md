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
| 接受这一版 | 在 Clued 确认页批准一次 `fleet.accept`（页上写版本、哈希与后果：全部登记节点原地升级，当班节点升级时 CI 暂停几分钟）。口头“接受”、手写的 Decision 都不起作用 | 无 |
| 每台节点升级 | 自动审批开着：什么都不做。没开：在该节点 `upgrade\status.json` 的 `confirmUrl` 页面点一次批准 | 无 |
| 当班节点 | 不另问：确认页那一下已含当班节点升级时的 CI 暂停。它最后升（其余节点都到接受的 Source、都没停在暂停时才动）。服务端不把 ci-admission 移交给 Source 与全队不同的节点（迁移 `20261114120000`），所以要移交只能在开始前、两台还是同一 Source 时做 | 无 |
| 升级回滚了（`ROLLED_BACK_PAUSED`） | 看原因；恢复该节点 | 无 |

自动审批的边界（服务端现有规则）：每节点 24 小时内自动批 6 次；同一个包第二次请求、或上一次自动批的升级没成功，归 Owner 手动批。

切换为先核验后变绿时，两台节点都升级后，全队新发出的扫描检查才都遵循新次序。旧版发出的成功检查仍可能被复用。节点一旦用新版开始发布扫描，回退必须选用支持效果账本 `created` 和 `completing` 状态的版本。旧版遇到这两种状态可能要求对账或停机。

### 0.2 发布机与协调者（一次）

1. 构建、发布：第 2、3 节，不变。
2. 接受前：`publish.mjs prepare`（第 4 节），产出给 Owner 看的接受请求。**`fleetRefs` 里进入 Source 的三项 `sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles` 沿用现装值**，由 `prepare` 从本机已装记录只读带入（与 `install.mjs fleet-refs` 同一来源），这一版才能原地升级。三项里有任何一项要换，这一版对所有节点都是重装（`prepare` 不提供改它们的入口，要换先找 Fable）。
3. 候选演练 `-Finalize` 时带上接受请求：`drill-vm.ps1 -Finalize <receipt.json> -ProductionReadback <readback.json> -Request <接受请求>`。候选回执判 PASS 就开请求（`accept.mjs open`：调 seal，等门上出现待批请求的确认链接，最多 5 分钟；超时答 `NOT_OPENED`、`code = FLEET_ACCEPTANCE_OPEN_QUEUED`，下面这条命令会接着等），返回里的 `acceptance.confirmUrl` 就是给 Owner 的确认链接；不 PASS 不开、没有链接。开请求失败不改演练结论，答 `acceptance.status = NOT_OPENED` 和原因（下面这条命令也会开请求）。
4. 然后在 DESK（本机已装节点、Owner 会话、非提权）用后台方式起**一条命令**，从等 Owner 批准一直走到本机升级、全队读回（0.2a）。Owner 点完之后到封存完成没有 agent 动作。

### 0.2a 接受之后：一条命令

```
node R/rollout/fleet/accept.mjs run --request <目录>\fleet-node-<version>.acceptance-request.json [--drill-receipt <候选演练定稿的 receipt.json>] --work <目录> [--wait <分钟>]
```

有界、可原样重跑（同一个 `--work`），退出时打印一行 JSON（`status`、停在哪、`next` 写下一条命令）。寿命不超过一条请求的有效期：以 seal 第一次答“待批”时的 `expiresAt` 为止（没有就从起跑算 24 小时），下面每一段等待都截在这里。三步：

1. **封存**：调 `seal`。门答“待批”（含请求已排队、还没有链接）就每 30、60、120 秒再问一次，上限 `--wait`（默认到请求过期）；“已批”即封存（接受文件的 Decision、回执、时间都取自门批准的那条 Grant）；“拒绝”或过期即停，候选留在未接受状态，原样重跑重开请求。seal 抛错（门或 gh 网络抖动）算这一轮没问到，按同样间隔再问；输入错误（件 B `publish.mjs` 导出的 `SEAL_INPUT_ERRORS`，如请求文件名不对、这个版本已以另一份请求被接受）立即停；连续出错满 30 分钟就停，带最后一次的 `code`。
2. **本机**：`upgrade.mjs fetch --version <version> --work <work>\node`（0.3 同一条），先**不带** `--allow-active-upgrade`。本命令对本机发过什么记在 `<work>\requested-fleet-node-<version>.json`；找到记录的重跑只读、不再问 `upgrade.mjs`，所以回滚之后重跑不会再投。每次可能发请求之前先写一份“将要请求”的记录：进程在发出请求和写记录之间丢了，重跑先等最多 5 分钟看升级代理是否已接手，接手了就跟着读，看不到才再问。
   - 待命（`FLEET_NODE_UPGRADE_REQUESTED`）：记下请求（请求号就是升级代理的 opId），读 `upgrade\status.json` 到这次操作的终态，再核 `upgrade\current.json` 两侧 Source 等于接受的 Source。
     - 请求被升级代理归档为 `rejected` 或 `ignored`（`upgrade\inbox-archive`：空文件、读不了、当天新开操作已到上限）：答 `ROLLOUT_STOPPED`、`code = ROLLOUT_REQUEST_NOT_TAKEN`、`disposition`；它没有变成操作，记录删掉，原样重跑会再请求一次。
     - 请求还在 `upgrade\inbox`、`status.json` 15 分钟没刷新（升级代理每一轮都重写它，间隔不超过 60 秒）：答 `ROLLOUT_STOPPED`、`code = ROLLOUT_UPGRADER_NOT_RUNNING`；记录保留，CluedCIUpgrader 起来后原样重跑，跟的还是这一个请求。
   - 在途（`FLEET_NODE_UPGRADE_IN_PROGRESS`）：同样记下（按它的 opId）再照读，它回滚了重跑也不再投。它若以成功结束而本机不在接受的 Source（那是别的包的操作），记录删掉，再请求本机一次。
   - 当班（`FLEET_NODE_UPGRADE_HAND_OVER_FIRST`）：读全队；其余节点都报告接受的 Source、都没停在暂停时，才带 `--allow-active-upgrade` 再发；否则不发请求。
   - 已到位：照读；其他回答（要重装、预检拒绝、拒绝）即停。
3. **读回**：全部登记节点报告的 Source 等于接受的 Source、都没停在暂停时，才答 `ROLLOUT_DONE`。只差本机时（门上本机的 Source 还没跟上 `current.json`），有界地再读，最多 10 分钟。

| status | 意思 | 退出码 | 下一步 |
|---|---|---|---|
| `ROLLOUT_DONE` | 已封存，全部节点到接受的 Source | 0 | 无 |
| `ROLLOUT_WAITING_OWNER` | 到 `--wait` 时门仍待批（`confirmUrl`） | 2 | Owner 批一次后原样重跑 |
| `ROLLOUT_WAITING_OTHER_NODES` | 本机已到位（或本机当班、在等其余节点），`pending` 列出还没到的节点 | 2 | 在 `pending` 的节点上跑 0.3 那条命令（当班的最后，加 `--allow-active-upgrade`），然后原样重跑 |
| `ROLLOUT_IN_PROGRESS` | 本机升级到时限还在途 | 2 | 原样重跑 |
| `ROLLOUT_STOPPED` | `stage = accept`：Owner 拒绝、请求过期、seal 输入错误或连续出错满 30 分钟；`stage = node`：本机回滚或被拒（`node`、`outcome`、`code`），请求没被接手（`ROLLOUT_REQUEST_NOT_TAKEN`），升级代理没在跑（`ROLLOUT_UPGRADER_NOT_RUNNING`） | 1 | 见 0.5；不碰下一台。重跑不会再投同一个请求（记录在 `--work` 里），同一个包第二次请求归 Owner（服务端规则） |
| `ROLLOUT_REFUSED` | 输入不对（`code`，如 `USAGE`；`--decision-record` 也是 `USAGE`） | 1 | 按 `code` 改正 |

全队各节点最近报告的 Source 由门读出（件 B `accept-door.mjs` 的 `readFleet({ resource })`，资源由接受请求文件算出，匿名读 `public.clued_fleet_accept_status_v1`，已批时带各登记节点的名字、Source、是否暂停）；读不到、读回为空、缺本机或节点名重复，都算读不到：当班节点不发请求，第 3 步答 `ROLLOUT_WAITING_OTHER_NODES`、`code = ROLLOUT_FLEET_UNREADABLE`，不会答 `ROLLOUT_DONE`。TURING 的 `upgrade\inbox` 只有该节点的操作员会话能写，所以这一阶段 TURING 那一步仍由 DESK 经 Desktop Commander 跑 0.3 那条命令；节点自己读目标升级（G9）落地后这一步和本命令的等待一起删掉。

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
| `FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED` | `--no-request` | 无（演练：也不写 `.wslconfig`，`wslCapacity` 为 `skipped NOT_REQUESTED`） |
| `FLEET_NODE_UPGRADE_NEEDS_REINSTALL` | 这台不能原地升（`code` 写明：通道变了、Source 引用变了、两侧不是同一个包、Linux 现场与记录不符） | 把该版资产放进一个目录，走第 5 节唯一入口 `fleet-node-<v>.bootstrap.ps1 -From <目录>` |
| `FLEET_NODE_UPGRADE_HAND_OVER_FIRST` | 这台现在当班，没有发请求 | 其他节点都升好后加 `--allow-active-upgrade` 再跑（CI 暂停几分钟）；不能移交给已升级的节点（Source 不同，服务端拒绝） |
| `FLEET_NODE_UPGRADE_PRECHECK_REFUSED` | 预检拒绝但不用重装 | 按 `precheck.advice` |
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
3. 发布机：Release 与索引行（由 prepare 建）
4. 接受：接受前 prepare、接受后 seal（Owner 只说一次“接受”）
5. 每台节点：唯一入口 bootstrap.ps1（重装与首装）
6. 顺序与列车窗口（先 DESK，后 TURING）
7. 凭据在哪里
8. 失败时怎么办

## 1. 总览与顺序

```
发布机   build（一次） -> publish prepare（建 Release 与索引行、取 kit、备镜像、上传、写接受请求；Owner 面前的唯一产物） -> 候选演练（drill/，PASS 才往下） -> Owner 接受（一次；写 Decision 并保存返回） -> publish seal（读 Decision 记录、挂接受文件、写索引）
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

## 3. 发布机：Release 与索引行（由 prepare 建）

没有单独的发布命令：`publish.mjs release` 已撤掉（输入它得到 `USAGE`）。该版的 Release 和索引行由 4.1 的 `prepare` 在本地检查全部通过之后建出：先核构建输出（唯一的 release.json、tar 的 sha256、SHA256SUMS、包内的节点入口），再 `gh release create fleet-node-<version> <tar> <release.json> SHA256SUMS <bootstrap.ps1> <prereq-manifest.json> --target <commit>`，用 `gh release view` 核资产的名称与大小，最后在索引文件追加一行（Release 链接、tar sha256、commit；接受时间、Decision 与首装演练先空）。索引文件不存在时新建（带表头）。

**候选 commit 必须已在远端**：Release 以该 commit 为 target 建 tag，`prepare` 建 Release 之前用 `gh api repos/<repo>/commits/<commit>` 核它在远端，GitHub 答“没有这个 commit”即拒绝（`PREPARE_COMMIT_NOT_ON_REMOTE`），不建 Release、不动索引；查询本身失败（断网、5xx）报 `PREPARE_COMMIT_LOOKUP_FAILED`，不当作没推送，原样重跑即可。

索引文件默认：`G:\我的云端硬盘\Clued_资料中心\10_E_工程与平台\CI基础设施\通用节点包_归档索引.md`，表头：版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练。

## 4. 接受：接受前 prepare、接受后 seal（Owner 在确认页点一次批准）

接受分两段，各是一条命令、都可以原样重跑；**首装 kit 的检查在 `prepare` 里**（缺 kit 的包造不出可接受的东西）。把 kit 或接受文件挂上 Release 只有这两条命令：挂 kit、挂接受文件的步骤没有单独的命令，手写的接受文件没有入口。两条命令对“请求与 Release 是否对应”用同一个核对（`checkRequestOnRelease`）：Release 的 `SHA256SUMS` 与 `release.json` 指名请求里的 tar，`release.json` 的 commit 等于请求的，用从 Release 下载的 tar 由包自带的 `source-hash` 重算 Source 并与请求比，再核 kit。`prepare` 在往 GitHub 写任何东西之前，先用构建输出里的同一个 tar 算出 Source。`prepare` 写出的请求，`seal` 不会因这一核对而拒。

**“已接受”只看 Release**：Release 上有 `fleet-node-<version>.acceptance.json` 就是已接受，索引行只是它的派生记录。

### 4.1 接受前：prepare（产出 Owner 要看的接受请求）

```
node R/rollout/fleet/publish.mjs prepare --version <version> --dir <构建输出目录> --out <目录> [--image <role-image-<id>.tar.gz> ...] [--repo tdoljyj/cross-memory-system] [--index <索引文件>]
```

构建之后、Owner 接受之前，在**装着更早版本、Linux 与 Windows 同一包的本机已装节点**上运行（非提权，对节点只读），且**在本机升到该版之前**。不要 Decision、回执或时间，也不读任何手写的字段文件。能在本地做的检查（构建输出、节点入口、kit、Source、镜像）都在往 GitHub 或索引写任何东西之前做完；任何一步不过就不写接受请求，前 4 步不过则 Release 与索引都不动。它依次做：

1. Release 上已有该版接受文件：拒绝（`PREPARE_VERSION_ALREADY_ACCEPTED`），不再挂 kit、不再写请求，Release 缺 kit 也一样；索引行还空着，说明上次 `seal` 在写索引之前断了，用原参数重跑 `seal` 补上。索引行有值而 Release 上没有接受文件：拒绝，不猜。索引有该版的行而没有 Release：当场拒绝（`PREPARE_INDEX_ROW_WITHOUT_RELEASE`），不取 kit、不取镜像。
2. 首装 kit：**Release 上已有该版 kit 就用 Release 上那一份**（下载），不再去节点取。kit 的 `template.versionFacts` 带 `observedAt`，每次从节点取都是不同的字节；挂上之后，Release 上那一份就是唯一事实。Release 上还没有，才从本机取。两种来源都按新节点的读法核（`readKit`），并核模板 Source 不等于本包 Source：相等即拒绝，说明本机已经升到这一版，须在升级之前执行。
3. 接受请求的 `fleetRefs`：从本机已装记录只读带入，来源与 `install.mjs fleet-refs` 相同：`sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles` 三项进 Source；`ownerAuthorizationRef`、`publisherQualificationRef`、`ownerPackageAcceptanceRef` 三项不进 Source，每次接受都沿用（来源见 `BATCH1-INTERFACES.md` 第 6 节）。Source 先从构建输出的 tar 算出（Decision、回执与时间不进 Source，算时用演练保留值占位），第 6 步再用同一核对从 Release 的 tar 重算比对。
4. 备齐 kit 列的每个本地角色镜像：用 `--image` 给；没给就用索引里上一版 Release 的同 id `role-image-<id>.tar.gz`，并按该版 `first-install.SHA256SUMS` 核哈希。缺一个即拒绝；下载失败按下载失败报，不当作缺镜像。
5. 建 Release 与索引行（`ensureRelease`，第 3 节）：
   - 没有 Release、索引也没有该版的行：核候选 commit 在远端（`PREPARE_COMMIT_NOT_ON_REMOTE`），再建 Release、核资产、追加索引行。
   - 没有 Release，索引却已有该版的行：拒绝（`PREPARE_INDEX_ROW_WITHOUT_RELEASE`），不猜（第 1 步已拒，这里按当时的索引与 Release 再核一次）。
   - 已有 Release（上次中途停下，或停在写索引之前）：Release 上已有的每个资产都与构建输出**按字节**核（大小相同不等于同一次构建：tar 按 512 字节对齐）：`SHA256SUMS` 与暂存的那份比，`release.json` 和两个节点入口文件下载后比，tar 下载后核 sha256 并留给第 6 步复用，不再下载第二次；任何一个不同即在补传之前拒绝（`ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES` / `ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS`），说明那是另一次构建的 Release，不覆盖；相同则只补传缺的资产（不覆盖已有的）、补上缺的索引行。
6. 把 kit 与镜像放进 `--out`，Release 上缺的 kit、镜像与 `fleet-node-<version>.first-install.SHA256SUMS` 补传。Release 上已有的按**内容**比，不按大小：相同不重传，不同的镜像或 sums 替换；Release 上是另一份 kit 则拒绝。sums 读回整份比对，整个请求再按同一核对比一遍 Release。接受请求先作为 Release 资产 `fleet-node-<version>.acceptance-request.json` 上传（不加 `--clobber`，读回整份比对；Release 上已有同字节的不重传，是另一份即拒绝 `PREPARE_REQUEST_ON_RELEASE_DIFFERENT`，不替换：发布工作流从 Release 读它），最后写进 `--out`（文件整份写成或不写）。

接受请求（合同 `clued.independent-ci.fleet-node-acceptance-request/1`）只有这些字段：`version`、`archive_sha256`、`commit`、`repository`、`ciSourceManifestSha256`、`firstInstallKitSha256`，以及上面六项 `fleetRefs`。**没有 Decision 字段**：这就是摆给 Owner 的那一份。输出里还有 `requestSha256`（请求文件的 sha256）：`seal` 向接受门开的那条请求就绑在它上面（4.3）。上传中途断了，原样重跑同一条命令（同一个 `--out`）即可。

### 4.2 候选演练（接受之前）

Owner 接受的，应当是已经在干净机器上装通过的东西：候选演练（`drill/`，见 `drill/FIRST-INSTALL-KIT.md`）用接受请求和该版的 kit、镜像组装自己的来宾目录。演练给来宾用的接受文件由接受请求加**演练保留值**生成（`publish.mjs` 的 `DRILL_RESERVED` 与 `acceptanceOf`，仓库里只此一处）。`seal` 与挂接受文件的步骤见到保留值即拒绝（`namesDrillReserved`），所以这份文件上不了 Release，真实节点拿不到。演练结束立刻 `-Finalize`（只回读 A9），回执定稿。`seal --drill-receipt` 只收 `candidate` 为 `true`、结论是 `PASS_A_FULL` 或 `PASS_A_PER_NODE_STEPS_REMAIN`（`DRILL_PASS_CONCLUSIONS`）的回执（A8 只验同一个包对已装节点两条入口都不动它：升级答“已到位”、prepare 以 `NEW_SOURCE_IS_THE_INSTALLED_ONE` 拒绝；旧包到新包的重装不在首装演练内，A8 的 detail 如实写着），`PASS_A_PENDING_PRODUCTION_READBACK` 等一律拒绝。顺序是**演练 → `-Finalize` → `seal`（开请求，把请求与终稿回执摆给 Owner）→ Owner 在确认页批准 → `seal` 封存**，接受之后不开机、不再回读。演练失败不找 Owner：修、出新候选、重跑。首装演练不是原地升级的门，只走升级路径的紧急包可以不带演练回执。

### 4.3 接受：seal 开请求、Owner 在确认页批准、seal 封存

“接受”不是聊天里的一句话，是 Owner 在 Clued 确认页批准一条 `fleet.accept` Grant（不可自动批准，只认页面上的确认；Binding 与委托 OAuth 批不了）。`seal` 自己向接受门开这条请求、自己等，批了就封存。口头“接受”和手写的 Decision 记录在代码里没有入口：`--decision-record` 已撤，给了就是 `USAGE`。

```
node R/rollout/fleet/publish.mjs seal --request <目录>\fleet-node-<version>.acceptance-request.json [--drill-receipt <候选演练定稿的 receipt.json>] [--wait <分钟>] [--repo tdoljyj/cross-memory-system] [--index <索引文件>]
```

`seal` 不带任何令牌：读门是匿名的，开请求走发布工作流。门的地址与公开 key 只从仓库的 `apps/clued-cloud/app/supabase-public-config.ts` 读（与 `scripts/ci/clued-work-admission.mjs` 同一来源），不读环境；读不到即 `ACCEPT_DOOR_NOT_CONFIGURED`，什么都不读、不调。

只读接受请求，**不碰节点、不取 kit**。先做它自己能拒的全部核对：请求的合同与文件名、`fleetRefs` 不是演练保留值、请求变成接受文件后的整份合同、`--drill-receipt`、索引行（tar 与 commit）、候选 commit 已在 main 上、同一个“请求对 Release”的核对，以及 Release 上的接受请求资产与本地文件同字节（`SEAL_REQUEST_NOT_ON_RELEASE`）。都过了才问门，所以 Owner 不会被请去批一个 `seal` 会拒的东西。门（`rollout/fleet/accept-door.mjs`）两个出口：

- 读：匿名 RPC `clued_fleet_accept_status_v1`，入参 `{ "p_resource": "fleet-node:<owner>/<repo>/<version>/<tar sha256>/<接受请求文件的 sha256>" }`；
- 开：门答没有开着的请求（`none`、`expired`）时，`seal` 只调一次 `gh workflow run clued-cloud-production-release.yml --ref main -f mode=fleet-accept -f fleet_version=<version> -f fleet_request_sha256=<接受请求文件的 sha256>`，此后只读不再开；工作流从 Release 读接受请求、向门开 `fleet.accept` 请求。

请求文件的 sha256 已经绑住 tar、commit、Source、kit 与 `fleetRefs`。门的回答与 `seal` 的回答：

门的每个回答都须回显 `request_sha256` 且等于本地请求文件的 sha256（带 `resources` 的，须正是这一个资源），否则 `ACCEPT_DOOR_ANSWER_REFUSED`。

| 门答 | `seal` 答 | 做了什么 |
|---|---|---|
| `none` | 开请求（上面那一次 `gh workflow run`），再读 | 每 15 秒读一次，从发出起最多 15 分钟（工作流该模式 job 超时 10 分钟加排队余量；`--wait` 不延长它），读失败也照样等到点 |
| `none` / `expired`：发出请求 15 分钟后仍是 | `FLEET_ACCEPTANCE_NOT_OPENED`，带 `dispatchedAt`；退出码 1 | 什么都不写，不再发。原样重跑只会再发一次，所以先看发布工作流 `fleet-accept` 模式最近一次运行为什么没开出来，修好后再跑同一条命令 |
| `pending`（`confirm_path`、`expires_at`，与 `request_id` 同在顶层） | `FLEET_ACCEPTANCE_WAITING_OWNER`，带 `confirmUrl`（`https://kooyumi.pixelgrav.com` + `confirm_path`）、`expiresAt`；退出码 0 | 什么都不写。Owner 打开链接批准后，原样重跑同一条命令 |
| `accepted`（`grant_id`、`receipt_id`、`accepted_at`） | `FLEET_ACCEPTANCE_SEALED` | 封存，见下 |
| `rejected`：任何时候读到（一开始就是也算） | `FLEET_ACCEPTANCE_REJECTED`，`answer: rejected`；退出码 1 | 不开请求、什么都不写。拒绝是终局：门对被拒的资源只回放 `rejected`、不再开请求，要接受须出新版本 |
| `expired`：本次见过待批之后 | `FLEET_ACCEPTANCE_REJECTED`，`answer: expired`；退出码 1 | 什么都不写，候选留在未接受；原样重跑同一条命令重开 |
| `expired`：一开始就是 | 同 `none`：开一次新请求 | 同 `none` |
| `none` 带 `conflict`（这个版本已以另一份请求或另一个包被接受） | 报错 `ACCEPT_DOOR_VERSION_ALREADY_ACCEPTED`，不开请求 | 什么都不写；换版本号重新发布 |

`--wait <分钟>`（1–1440）：门答待批时按 30、60、120、120… 秒再读，直到批、拒、过期或等满；等满仍待批，答 `FLEET_ACCEPTANCE_WAITING_OWNER`。读失败（`ACCEPT_DOOR_UNAVAILABLE`：连不上、超时、5xx）在还有时间时每 30 秒重读，时间用完仍失败才报错（`seal` 已发出请求、还没见到链接的，到 15 分钟答 `FLEET_ACCEPTANCE_NOT_OPENED`，不报错）。门给的 `accepted_at` 比本机钟快 2 分钟以内的，等过去再封一次；更快的拒绝。不给 `--wait` 只读一次（`seal` 刚开了请求的，等它开出来，见上表）。

接受才有的三个值只从门的回答取：

- `cluedDecision` = `fleetRefs.ownerDecisionRef` = Grant id（`grant_id`）；
- `installationReceiptRef` = `ownerReceiptRef` = 使用回执 id（`receipt_id`）；
- `acceptedAt` = 接受时间（`accepted_at`），截到秒，以 Z 结尾。

两个 id 须是不同的 UUID，时间不在未来，演练保留值即拒绝；命令行上没有这三个值的参数。Owner 的原话不进任何记录：权威来自 Owner 登录会话在页面上的批准，由服务端写 Grant 与审计回执。索引的“Decision”列填 Grant id。

然后按节点 `prepare` 的同一份规则核整份合同，核索引行，都过了才把 `fleet-node-<version>.acceptance.json` 作为追加资产上传（不加 `--clobber`，tar 不变），补全索引行的接受时间、Decision、首装演练三格，最后把接受文件写到接受请求旁边。接受文件是“请求 + 门的那一行”的纯函数：谁在哪台机器上重跑都得到同样的字节。

- `--drill-receipt`：要求见 4.2，且三项哈希与这份接受相同。索引“首装演练”格记它的结论与回执 sha256；没给，记“首装未演练”。已封的行，这一格不再改：换回执或去掉回执重跑都拒绝。
- 同样的参数再跑一次：门回放同一行，接受文件字节相同；已挂上、已写索引就什么都不改（`already: true`）；上传后、写索引前断了的，补写索引。同一版本换一个接受请求：Release 上已是另一份，`prepare` 拒绝，`seal` 以 `SEAL_REQUEST_NOT_ON_RELEASE` 拒绝；目录或索引里已有另一份接受：在上传之前拒绝。
- 门连不上、没上线或答得不成形：`ACCEPT_DOOR_UNAVAILABLE`（`detail` 带 HTTP 状态或网络错误码）/ `ACCEPT_DOOR_ANSWER_REFUSED`，什么都不写，原样重跑；门拒绝读：`ACCEPT_DOOR_REFUSED`；`gh workflow run` 失败：`ACCEPT_DOOR_OPEN_FAILED`，什么都不写，原样重跑。

**交付目录**（给新节点 `bootstrap.ps1 -From`，第 5 节）就是该版 Release 的全部资产，在 `seal` 之后用 `gh release download fleet-node-<version> --pattern "fleet-node-<version>.tar" --pattern "fleet-node-<version>.release.json" --pattern "fleet-node-<version>.bootstrap.ps1" --pattern "fleet-node-<version>.prereq-manifest.json" --pattern "fleet-node-<version>.acceptance.json" --pattern "fleet-node-<version>.first-install*" --pattern "SHA256SUMS" --pattern "role-image-*.tar.gz"` 取进一个新目录（只取这一条，它取的就是 bootstrap 首装要的全部资产；Release 上的接受请求不取，bootstrap 会把它当多出的文件拒绝）。`prepare` 的 `--out`（含接受请求）不是交付目录：bootstrap 会把其中没列在两份 sums 里的文件当作多出的文件拒绝。

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
- 启动器：首装预检（无残留、令牌目录只有 SYSTEM/Administrators）→ 从 `first-install\credentials\` 带令牌并核指纹 → Windows 侧完整预检（runner 等待、两处秘密文件、安装器的两次 dry run 与 ACL 迁移计划；不过即停，Linux 未动）→ Linux A/B（由提权 Owner `wsl -u root`，发行版此时在 operator 名下的导入位置）→ 安装 → verify → companion → rearm → 现有的 M5-b 切换（`rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory`，把发行版 move 到 companion 名下）。没有 W1、没有卸载。首装的结论按这个顺序判（`Get-LauncherVerdict`）：先看角色，first-train 等待没有确认角色（终态 `role` 不是 `held` 或 `not-held`）时 bootstrap 答 `BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED`，码 `FIRST_INSTALL_ROLE_UNAUTHORIZED`（服务端拒了本节点的 CI 令牌）或 `FIRST_INSTALL_ROLE_UNCONFIRMED`（其余），换账户没过也是这个结论；角色确认之后再看切换，没有通过（`companionHeadless` 不是 `COMPANION_HEADLESS_QUALIFIED`）时答 `BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE`。两种都不答 `BOOTSTRAP_DONE`；切换的状态在每种结论的 `companionSwitch` 里都保留。
- 令牌目录（`first-install\credentials\`）不留过本次运行：主机准备开始前先删掉以前运行留下的；主机准备只在 bootstrap 仍在等它时（进程号与启动时间）为启动器保留，bootstrap 已放弃等待或窗口已关就删；启动器在任何结局都删除（停止、异常、完成）；`prepare` 失败或启动器 UAC 被拒时 bootstrap 再请求一次 UAC 清掉。
- 主机准备先写 `facts.json`（整份或没有），再放 App 私钥与 ci-admission 令牌：中途断掉只会留下有 facts、缺秘密的状态，下次运行按 facts 记录的指纹只问缺的那些（facts 记录了心跳令牌就必须再给），`-Reset` 能清掉；不会留下没有 facts、无法归属的秘密。
- 中途停止：Linux A 之前停下，什么都没动，重跑同一条命令（P1 会再问令牌）。A 完成之后停下（B 中断、失败或 Windows 侧未完成），重跑同一条命令：Linux A 找到本提交的暂存（同一个包、自 A 起未变、新输入目录与暂存逐字节一致）即不再暂存，B 从停下处接着做；不一致按名拒绝。已安装（有回执）之后停下的，按重装处理，要用更新的包：同一个包会被 `NEW_SOURCE_IS_THE_INSTALLED_ONE` 拒绝。

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
- `publish.mjs` 在 gh 失败时不动索引；`prepare` 建 Release 中途断了，原样重跑同一条 `prepare`：它认出已建的那部分，只补缺的资产和索引行，不重复创建同一 tag。
- `seal` 对已用另一个 Decision 接受的版本拒绝；接受文件写错要由协调者与 Owner 重新决定，不覆盖。`prepare` 或 `seal` 中途断了，原样重跑同一条命令。
- B 在 Source 切换之后失败：模板自动用 B-resume 续跑一次；仍失败则停手，交协调者。
- 节点装完 `verify` 不过：不继续装另一台。
