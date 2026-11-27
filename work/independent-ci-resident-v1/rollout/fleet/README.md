# 通用节点包：升级与重装操作说明

节点只有两条路，用的是**同一个通用包、同一份接受文件**：

1. **通用升级**（第 0 节）：已装节点原地升级，零 UAC，失败自动回滚。默认走这条。
2. **Windows 节点入口**（第 5 节）：`fleet-node-<v>.bootstrap.ps1 -From <目录>` 盘点本机，继续已知步骤、使用现有升级通道，或准备首装。维护接口未接通时，重装、退役与回滚在清理前停住。

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
| 当班节点 | 可用包当班可继续落地，有健康空闲的当前包备班时排空交班。旧方留作后备，服务端放行清理后才升级。 | 单机删旧重装须明确确认 |
| 升级回滚了（`ROLLED_BACK_PAUSED`） | 看原因；恢复该节点 | 无 |

自动审批的边界（服务端现有规则）：每节点 24 小时内自动批 6 次；同一个包第二次请求、或上一次自动批的升级没成功，归 Owner 手动批。

装有自拉功能的节点探询服务端封存目标。查看 `state/status.json` 的 `versions.fleetPull` 可区分等交班、后备、摘牌待修和待 UAC 重装。

需要回到旧内容时，用旧 commit 出一个新版本号，再走同一条接受流程。

切换为先核验后变绿时，两台节点都升级后，全队新发出的扫描检查才都遵循新次序。旧版发出的成功检查仍可能被复用。节点一旦用新版开始发布扫描，回退必须选用支持效果账本 `created` 和 `completing` 状态的版本。旧版遇到这两种状态可能要求对账或停机。

### 0.2 发布机与协调者（一次）

1. 构建、发布：第 2、3 节，不变。
2. 接受前：`publish.mjs prepare`（第 4 节），产出给 Owner 看的接受请求。**`fleetRefs` 里进入 Source 的三项 `sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles` 沿用现装值**，由 `prepare` 从本机已装记录只读带入（与 `install.mjs fleet-refs` 同一来源），这一版才能原地升级。三项里有任何一项要换，这一版对所有节点都是重装（`prepare` 不提供改它们的入口，要换先找 Fable）。
3. 候选演练定稿时带上接受请求：`drill-vm.ps1 -Finalize <receipt.json> -ProductionReadback <readback.json> -Request <接受请求>`。候选回执判为 PASS 后，`accept.mjs open` 在 20 分钟总时限内处理开单。核验和派发共限 4 分钟，随后留出 15 分钟读门，最后 1 分钟用于封存、输出和清理。`acceptance.confirmUrl` 可交给 Owner。拒绝和过期各自返回原因及下一步，读不到结论时返回未判。开单结果独立于演练结论。
4. 然后在 DESK（本机已装节点、Owner 会话、非提权）用后台方式起**一条命令**，从等 Owner 批准一直走到本机升级、全队读回（0.2a）。Owner 点完之后到封存完成没有 agent 动作。

### 0.2a 接受之后：一条命令

```
node R/rollout/fleet/accept.mjs run --request <目录>\fleet-node-<version>.acceptance-request.json [--drill-receipt <候选演练定稿的 receipt.json>] --work <目录> [--wait <分钟>]
```

有界、可原样重跑（同一个 `--work`），首次读到有效确认链接时，在 stderr 输出一行待批 JSON。退出时在 stdout 打印一行结果 JSON（`status`、停在哪、`next` 写下一条命令）。寿命不超过一条请求的有效期：从起跑算 24 小时（seal 自己也不等过请求的 `expiresAt`），下面每一段等待都截在这里。三步：

1. **封存**：只调**一次**带等待的 `seal`（`--wait` 分钟，不给就用 `publish.mjs` 的 `WAIT_MAX_MINUTES`，不超过本命令寿命），由 seal 自己读门、等 Owner（第 4 节）；本命令不轮询 seal，所以一条命令正常只发一次工作流运行、只下载一次整包。答“待批”（一定带链接）即 `ROLLOUT_WAITING_OWNER`；“已批”即封存（接受文件的 Decision、回执、时间都取自门批准的那条 Grant）；“拒绝”即停：`answer = rejected` 是 Owner 的终局，门不再问，要接受须出新版本；`answer = expired`（请求过期）原样重跑重开请求。`FLEET_ACCEPTANCE_NOT_OPENED`（seal 发出的工作流运行 15 分钟内没开出请求）即停、不再发：先看发布工作流 `fleet-accept` 模式最近一次运行为什么没开出来，修好后原样重跑。到期读不到结论时返回 `FLEET_ACCEPTANCE_UNREADABLE`，原样重跑会先读门。派发前的暂态错误按 30、60、120 秒间隔有界重试，并复用本次已校验的 tar。派发成功或结果不明后只读门，明确拒绝立即判停。
2. **本机**：`upgrade.mjs fetch --version <version> --work <work>\node`（0.3 同一条），先**不带** `--allow-active-upgrade`。本机从本次封存的暂存目录取包并复验 SHA-256。本命令对本机发过什么记在 `<work>\requested-fleet-node-<version>.json`；找到记录的重跑只读、不再问 `upgrade.mjs`，所以回滚之后重跑不会再投。每次可能发请求之前先写一份“将要请求”的记录：进程在发出请求和写记录之间丢了，重跑先等最多 5 分钟看升级代理是否已接手，接手了就跟着读，看不到才再问。
   - 待命（`FLEET_NODE_UPGRADE_REQUESTED`）：记下请求（请求号就是升级代理的 opId），读 `upgrade\status.json` 到这次操作的终态，再核 `upgrade\current.json` 两侧 Source 等于接受的 Source。
     - 请求被升级代理归档为 `rejected` 或 `ignored`（`upgrade\inbox-archive`：空文件、读不了、当天新开操作已到上限）：答 `ROLLOUT_STOPPED`、`code = ROLLOUT_REQUEST_NOT_TAKEN`、`disposition`；它没有变成操作，记录删掉，原样重跑会再请求一次。
     - 请求还在 `upgrade\inbox`、`status.json` 15 分钟没刷新（升级代理每一轮都重写它，间隔不超过 60 秒）：答 `ROLLOUT_STOPPED`、`code = ROLLOUT_UPGRADER_NOT_RUNNING`；记录保留，CluedCIUpgrader 起来后原样重跑，跟的还是这一个请求。
   - 在途（`FLEET_NODE_UPGRADE_IN_PROGRESS`）：同样记下（按它的 opId）再照读，它回滚了重跑也不再投。它若以成功结束而本机不在接受的 Source（那是别的包的操作），记录删掉，再请求本机一次。
   - 当班（`FLEET_NODE_UPGRADE_HAND_OVER_FIRST`）等当前包健康备班接手，再按服务端维护回读处理旧装。
   - 已到位：照读；其他回答（要重装、预检拒绝、拒绝）即停。
3. **读回**：全部登记节点报告的 Source 等于接受的 Source、都没停在暂停时，才答 `ROLLOUT_DONE`。只差本机时（门上本机的 Source 还没跟上 `current.json`），有界地再读，最多 10 分钟。

| status | 意思 | 退出码 | 下一步 |
|---|---|---|---|
| `ROLLOUT_DONE` | 已封存，全部节点到接受的 Source | 0 | 无 |
| `ROLLOUT_WAITING_OWNER` | 到 `--wait` 时门仍待批（`confirmUrl`） | 2 | Owner 批一次后原样重跑 |
| `ROLLOUT_WAITING_OTHER_NODES` | 本机已到位（或本机当班、在等其余节点），`pending` 列出还没到的节点 | 2 | 在 `pending` 的节点上跑 0.3 那条命令（当班的最后，加 `--allow-active-upgrade`），然后原样重跑 |
| `ROLLOUT_IN_PROGRESS` | 本机升级到时限还在途 | 2 | 原样重跑 |
| `ROLLOUT_STOPPED` | `stage = accept`：Owner 拒绝（终局）、请求过期、工作流没开出请求（`FLEET_ACCEPTANCE_NOT_OPENED`）、seal 输入错误或连续出错满 30 分钟；`stage = node`：本机回滚或被拒（`node`、`outcome`、`code`），请求没被接手（`ROLLOUT_REQUEST_NOT_TAKEN`），升级代理没在跑（`ROLLOUT_UPGRADER_NOT_RUNNING`） | 1 | 见 0.5；不碰下一台。重跑不会再投同一个请求（记录在 `--work` 里），同一个包第二次请求归 Owner（服务端规则） |
| `ROLLOUT_REFUSED` | 输入不对（`code`，如 `USAGE`；`--decision-record` 也是 `USAGE`） | 1 | 按 `code` 改正 |

全队各节点最近报告的 Source 由门读出（件 B `accept-door.mjs` 的 `readFleet({ resource })`，资源由接受请求文件算出，匿名读 `public.clued_fleet_accept_status_v1`，已批时带各登记节点的名字、Source、是否暂停）；读不到、读回为空、缺本机或节点名重复，都算读不到：当班节点不发请求，第 3 步答 `ROLLOUT_WAITING_OTHER_NODES`、`code = ROLLOUT_FLEET_UNREADABLE`，不会答 `ROLLOUT_DONE`。TURING 的 `upgrade\inbox` 只有该节点的操作员会话能写，所以这一阶段 TURING 那一步仍由 DESK 经 Desktop Commander 跑 0.3 那条命令；节点自己读目标升级（G9）落地后这一步和本命令的等待一起删掉。

### 0.3 每台节点：同一条命令

Owner 会话、非提权。一条命令（取包、核哈希、解包、组装、预检、发请求）：

```
node <任一份 upgrade.mjs> fetch --version <version> --work <新目录> [--from <本地或共享目录>] [--no-request] [--allow-active-upgrade]
```

`<任一份 upgrade.mjs>` 用上一版已解包的包里的（或任何一份 `upgrade.mjs` 加 `fetch.mjs`）；真正执行升级的是新包解出来的那份 `upgrade.mjs`。取包由 `fetch.mjs` 做：按 release 资产分段续传（Range，连接被断就从已收到的字节接着要，退避重试，总时限 30 分钟），令牌只在进程内取自 `gh auth token`，不打印不落盘；也可以把 `fleet-node-<version>.tar`、`.acceptance.json`、`SHA256SUMS` 放进 `--from` 目录（Google Drive、共享盘都行，release 取不下来时用）。两个来源一视同仁，只认哈希：tar 的 sha256 必须等于接受文件的 `archive_sha256` 且等于 `SHA256SUMS` 那行，不符就删掉、不解包、不组装。断了就原样再跑同一条命令（同一个 `--work`），续传。产物：`<新目录>\dl\`（下载）、`<新目录>\unpacked\`（解包）、`<新目录>\upgrade\`（升级的工作目录）。输出是新包 `upgrade.mjs` 的那一行 JSON，多一个 `fetched`（来源、尝试次数、续传次数）。

支持运输附件的取包入口在正式 tar 未命中时，可从 Release 或 `--from` 读取相应运输描述和附件。手动取包时，可把紧邻上一代的正式 tar 放在 `<work>\dl\` 或 `--from`。常驻 companion 优先查上一次通过验包的自拉缓存，也能在既有自拉目录中有界查找。命中旧代的大小和 SHA-256 后尝试增量，缺失、跳代或校验失败时尝试完整 gzip，再按原路径取正式 tar。运输解码限时、限字节，得到同一个正式 tar 的大小和 SHA-256 才解包。

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
| `FLEET_NODE_UPGRADE_HAND_OVER_FIRST` | 本机仍当班 | 封存模式等服务端排空交班，单机按第 6 节核实维护资格 |
| `FLEET_NODE_UPGRADE_PRECHECK_REFUSED` | 预检拒绝但不用重装 | 按 `precheck.advice` |
| `FLEET_NODE_UPGRADE_REFUSED` | 输入不对（包、接受文件、节点记录） | 按 `code` 改正 |

命令可以重复运行：在途时不发第二个请求，做完后只报告做完。

### 0.4 顺序

封存舰队的轮换顺序见第 6 节。没有封存记录时沿用旧工具的先待命、后当班顺序。

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
发布机   publish prepare（分配代号、构建一次、建 Release、取 kit、备镜像、写接受请求） -> publish seal（开接受请求，等 Owner 批准，封存接受文件并补全索引）
节点     该版资产放进一个目录 -> fleet-node-<v>.bootstrap.ps1 -From <目录>（非提权；它取前置、解包、prepare，在要提权处自己请求 UAC）
```

已登记节点重装前读服务端的其它健康节点数及本次摘牌许可。交班、保留后备和单机确认见第 6 节。

## 2. 发布机：构建一次

```
node R/rollout/fleet/universal.mjs build --repo <git 目录> --commit <40 位 hex> --version drill-<演练标识> --out <新目录>
```

此命令用于独立演练。正式包由 4.1 的 `publish.mjs prepare` 分配代号并构建，输入为选定的 main 提交。构建产出包括：

- `fleet-node-<version>.tar`：确定性 ustar，含 `tree/`、`bundle/accepted.bundle`、`universal-manifest.json`
- `fleet-node-<version>.release.json`：合同 `clued.independent-ci.fleet-node-release/1`
- `SHA256SUMS`

每个版本只构建一次；节点不构建、不检出仓库。包内路径只许可打印 ASCII（`UNIVERSAL_TREE_PATH_NOT_ASCII`）：节点入口用 Windows 自带的 `tar.exe` 解包，它写不了非 ASCII 文件名。

## 3. 发布机：Release 与索引行（由 prepare 建）

正式代号以 `fleet-node-2026.11.26-5444c2ac` 为第 22 代迁移基准，从正式 tag 序列接续。构建并核对 tar 后，`prepare` 仅创建一次带注解的 `fleet-node-g000023` 等 tag，其中包含完整提交和 tar SHA-256。之后用 `gh release create --verify-tag` 建 Release，标题为「第 23 代通用节点包 · 构建日期-短 SHA」。回读资产后追加索引行。

**候选 commit 必须已在远端 main 历史中**。发布入口核对远端后才构建。同一提交与 tar 可用原构建目录续跑。并发争到同一代号且未成功创建的发布者会收到拒绝。已经占用的代号保留，撤回包也继续占号。

索引文件默认：`G:\我的云端硬盘\Clued_资料中心\10_E_工程与平台\CI基础设施\通用节点包_归档索引.md`，表头：版本 | Release | tar sha256 | commit | 接受时间 | Decision | 首装演练。

## 4. 接受：接受前 prepare、接受后 seal（Owner 在确认页点一次批准）

接受分两段，各是一条命令、都可以原样重跑；**首装 kit 的检查在 `prepare` 里**（缺 kit 的包造不出可接受的东西）。把 kit 或接受文件挂上 Release 只有这两条命令：挂 kit、挂接受文件的步骤没有单独的命令，手写的接受文件没有入口。两条命令对“请求与 Release 是否对应”用同一个核对（`checkRequestOnRelease`）：Release 的 `SHA256SUMS` 与 `release.json` 指名请求里的 tar，`release.json` 的 commit 等于请求的，用从 Release 下载的 tar 由包自带的 `source-hash` 重算 Source 并与请求比，再核 kit。`prepare` 在往 GitHub 写任何东西之前，先用构建输出里的同一个 tar 算出 Source。`prepare` 写出的请求，`seal` 不会因这一核对而拒。

**“已接受”只看 Release**：Release 上有 `fleet-node-<version>.acceptance.json` 就是已接受，索引行只是它的派生记录。

### 4.1 接受前：prepare（产出 Owner 要看的接受请求）

```
node R/rollout/fleet/publish.mjs prepare --commit <main 的 40 位 SHA> --dir <构建输出目录> --out <目录> [--image <role-image-<id>.tar.gz> ...] [--repo tdoljyj/cross-memory-system] [--index <索引文件>]
```

构建之后、Owner 接受之前，在发布机运行。暂存候选与已发布请求提供原样续跑的字节。构建输出、节点入口、kit、Source、镜像和收件登记核对通过后，才占号及写 Release。

1. Release 上已有该版接受文件：拒绝（`PREPARE_VERSION_ALREADY_ACCEPTED`），不再挂 kit、不再写请求，Release 缺 kit 也一样；索引行还空着，说明上次 `seal` 在写索引之前断了，用原参数重跑 `seal` 补上。索引行有值而 Release 上没有接受文件：拒绝，不猜。索引有该版的行而没有 Release：当场拒绝（`PREPARE_INDEX_ROW_WITHOUT_RELEASE`），不取 kit、不取镜像。
2. 首装 kit：新候选以索引中最新的合格前版 Release 为模板。回读精确请求、Owner Grant、Receipt 和接受文件，核对 kit 的已接受摘要，再用 `readKit` 解析。已暂存的候选沿用原字节。
3. 接受请求沿用该发布的 `fleetRefs`，用当前候选 tar 重算 Source，封存时再用 Release 的 tar 重算。待定、在役及排空节点按登记和有效 Binding 确认收件资格。失效 Binding、待确认的 Binding 和待重绑节点列入 `excludedNodes`，空收件集仍可制包。两次读取和写入前的快照校验仍覆盖完整登记。
4. 备齐 kit 列的本地角色镜像。上一 Release 的接受请求钉住镜像摘要时可以按摘要取用，也可用 `--image` 提供镜像。
5. 建 Release 与索引行（`ensureRelease`，第 3 节）：
   - 没有 Release、索引也没有该版的行：核对并占用正式 tag，再建 Release、核资产、追加索引行。
   - 没有 Release，索引却已有该版的行：拒绝（`PREPARE_INDEX_ROW_WITHOUT_RELEASE`），不猜（第 1 步已拒，这里按当时的索引与 Release 再核一次）。
   - 已有 Release（上次中途停下，或停在写索引之前）：Release 上已有的每个资产都与构建输出**按字节**核（大小相同不等于同一次构建：tar 按 512 字节对齐）：`SHA256SUMS` 与暂存的那份比，`release.json` 和两个节点入口文件下载后比，tar 下载后核 sha256 并留给第 6 步复用，不再下载第二次；任何一个不同即在补传之前拒绝（`ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES` / `ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS`），说明那是另一次构建的 Release，不覆盖；相同则只补传缺的资产（不覆盖已有的）、补上缺的索引行。
6. 把 kit 与镜像放进 `--out`，Release 上缺的 kit、镜像与 `fleet-node-<version>.first-install.SHA256SUMS` 补传。Release 上已有的按**内容**比，不按大小：相同不重传，不同的镜像或 sums 替换；Release 上是另一份 kit 则拒绝。sums 读回整份比对，整个请求再按同一核对比一遍 Release。接受请求先作为 Release 资产 `fleet-node-<version>.acceptance-request.json` 上传（不加 `--clobber`，读回整份比对；Release 上已有同字节的不重传，是另一份即拒绝 `PREPARE_REQUEST_ON_RELEASE_DIFFERENT`，不替换：发布工作流从 Release 读它），最后写进 `--out`（文件整份写成或不写）。

接受请求（合同 `clued.independent-ci.fleet-node-acceptance-request/1`）只有这些字段：`version`、`archive_sha256`、`commit`、`repository`、`ciSourceManifestSha256`、`firstInstallKitSha256`，以及上面六项 `fleetRefs`。**没有 Decision 字段**：这就是摆给 Owner 的那一份。输出里还有 `requestSha256`（请求文件的 sha256）：`seal` 向接受门开的那条请求就绑在它上面（4.3）。上传中途断了，原样重跑同一条命令（同一个 `--out`）即可。

### 4.2 候选演练（接受之前）

正式发布使用规定的候选测试与发布准入结果。`seal --drill-receipt` 可附历史候选的合格演练回执，核对的是同一候选的 tar、Source 和 kit 摘要。使用演练保留值生成的接受文件不能成为正式 Release 资产。

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

`--wait <分钟>`（1–1440）：待批时按 30、60、120、120… 秒再读，每次读限于剩余等待时间和请求有效期。等待结束时仍有有效待批结论才给链接。门暂时读不到时有界重试，待批后到期仍读不到最终结论则返回 `FLEET_ACCEPTANCE_UNREADABLE`（退出码 1），原样重跑先读门。派发后在开单窗口内未观察到请求，返回 `FLEET_ACCEPTANCE_NOT_OPENED`。门给的 `accepted_at` 比本机钟快 2 分钟以内的，可在时限内等过去再封，超过 2 分钟则拒绝。不给 `--wait` 时不等 Owner 批准。

接受才有的三个值只从门的回答取：

- `cluedDecision` = `fleetRefs.ownerDecisionRef` = Grant id（`grant_id`）；
- `installationReceiptRef` = `ownerReceiptRef` = 使用回执 id（`receipt_id`）；
- `acceptedAt` = 接受时间（`accepted_at`），截到秒，以 Z 结尾。

两个 id 须是不同的 UUID，时间不在未来，演练保留值即拒绝；命令行上没有这三个值的参数。Owner 的原话不进任何记录：权威来自 Owner 登录会话在页面上的批准，由服务端写 Grant 与审计回执。索引的“Decision”列填 Grant id。

然后按节点 `prepare` 的同一份规则核整份合同，核索引行，都过了才把 `fleet-node-<version>.acceptance.json` 作为追加资产上传（不加 `--clobber`，tar 不变），补全索引行的接受时间、Decision、首装演练三格，最后把接受文件写到接受请求旁边。接受文件是“请求 + 门的那一行”的纯函数：谁在哪台机器上重跑都得到同样的字节。

- `--drill-receipt`：要求见 4.2，且三项哈希与这份接受相同。索引“首装演练”格记它的结论与回执 sha256；没给，记“首装未演练”。已封的行，这一格不再改：换回执或去掉回执重跑都拒绝。
- 同样的参数再跑一次：门回放同一行，接受文件字节相同；已挂上、已写索引就什么都不改（`already: true`）；上传后、写索引前断了的，补写索引。同一版本换一个接受请求：Release 上已是另一份，`prepare` 拒绝，`seal` 以 `SEAL_REQUEST_NOT_ON_RELEASE` 拒绝；目录或索引里已有另一份接受：在上传之前拒绝。
- 门连不上、没上线或答得不成形：`ACCEPT_DOOR_UNAVAILABLE`（`detail` 带 HTTP 状态或网络错误码）/ `ACCEPT_DOOR_ANSWER_REFUSED`，什么都不写，原样重跑；门拒绝读：`ACCEPT_DOOR_REFUSED`。派发被明确拒绝时返回 `ACCEPT_DOOR_OPEN_FAILED`。派发响应丢失时，在本次开单窗口内只读门核实。

正式编号代的 `prepare` 在能节省字节时附上完整 gzip。提供 `--transport-base <上一代正式 tar 路径>` 时，`prepare` 按紧邻上一代的远端编号 tag 和 Release 接受文件核验本地基线，再生成增量。发布小于完整传输且不超过 8,000,000 字节的增量。两种附件各有独立描述文件，绑定仓库、版次、正式 tar 大小和 SHA-256，并列出编码字节的大小和 SHA-256。增量还绑定上一代的版次、大小和 SHA-256。

**交付目录**（给新节点 `bootstrap.ps1 -From`，第 5 节）在 `seal` 之后用 `gh release download fleet-node-<version> --pattern "fleet-node-<version>.tar" --pattern "fleet-node-<version>.release.json" --pattern "fleet-node-<version>.bootstrap.ps1" --pattern "fleet-node-<version>.prereq-manifest.json" --pattern "fleet-node-<version>.acceptance.json" --pattern "fleet-node-<version>.first-install*" --pattern "SHA256SUMS" --pattern "role-image-*.tar.gz"` 取进一个新目录。该命令精确选择 bootstrap 首装资产，接受请求和运输附件留在 Release。bootstrap 继续按两份校验单检查交付目录，并拒绝多出的文件。

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

规则：凡进入 `record\source-manifest.json`（从而进入 `ciSourceManifestSha256`）的引用，都必须放在 `fleetRefs`，各节点相同，这样同一个包在两台上得到同一个 Source。按节点不同的（CI 连接资格 `ciPrincipalQualificationRef`、App 指纹、binding 等）不放这里，从本机记录读。确切字段清单见 `BATCH1-INTERFACES.md` 第 6 节。`ciSourceManifestSha256` 标识运行 Source；同一 Source 重新打包时，服务端还要按安装代次判定封存资格；每台节点的 `prepare` 都重算一遍，不等即拒绝（`FLEET_SOURCE_NOT_THE_ACCEPTED_ONE`）；`repository` 必须等于节点 record 的仓库。

## 5. 每台节点：唯一入口 bootstrap.ps1（重装与首装）

在节点上、Owner 会话、**普通（非提权）窗口**，用系统自带的 Windows PowerShell 5.1。重装与首装是同一条命令，**没有任何节点参数**：

```
powershell -NoProfile -ExecutionPolicy Bypass -File <目录>\fleet-node-<v>.bootstrap.ps1 -From <目录>
```

`<目录>` 放该版的 Release 资产（U 盘、共享盘、同步文件夹都可以，只认哈希；路径只许字母、数字、`.`、`_`、`-` 与 `\`）：`fleet-node-<v>.tar`、`fleet-node-<v>.release.json`、`SHA256SUMS`、`fleet-node-<v>.bootstrap.ps1`、`fleet-node-<v>.prereq-manifest.json`、`fleet-node-<v>.acceptance.json`；首装另要 `fleet-node-<v>.first-install-kit.json`、它列出的每个 `role-image-<64hex>.tar.gz` 与 `fleet-node-<v>.first-install.SHA256SUMS`。取资产用第 4.3 节“交付目录”那一条 `gh release download`（`fetch.mjs` 只取 tar、接受文件与 `SHA256SUMS`，够原地升级，组不齐首装目录）。

bootstrap 依次做（每一步看它所运行程序的最后一个 JSON 对象）：

1. 核资产集合与每个哈希（两份 sums 文件；多一个、少一个、哈希不符都拒绝）。
2. 先核并获取已钉住的 node、python、git。进入安装路径时才下载其余前置与 `.deb`，逐个核 SHA-256 与字节数。
3. 用 Windows 自带的 `tar.exe` 解出 `tree/`。`tar.exe` 写不了非 ASCII 文件名，所以构建器不许包里有这样的路径（第 2 节）；`prepare` 再逐文件核自己的字节，不信任解包工具。
4. 有产品资源时先走现有升级通道。已到位、升级在途或已投递直接返回。旧装明确无法升级时以同包进入重装分流。只有完整盘点确认空机，才进入首装。提权阶段以同一把机器锁读回与本机、操作人和包摘要绑定的进度。
5. 清洁重装使用节点现有准入凭据执行维护 RPC。服务端拒绝或无法确认清理资格时，安装器保留原装。显式退役和回滚需要各自的服务端授权。首装的 `BOOTSTRAP_DONE` 要求运行核验和 companion 切换成功。

主机准备或提权阶段拒绝时，`HOST_PREPARATION_NOT_DONE` 带原拒绝码和消息。失败时若已生成安装计划或启动器报告，从结果的 `evidenceDirectory` 进入管理员专用留存目录。留存失败时，结果带 `evidenceError` 和保留的 `stagingDirectory`。

`install.mjs prepare` 是 bootstrap 内部的一步，不是 Owner 的命令，不要绕过 bootstrap 手工运行它。**注意**：在协调者钉住 `prereq-manifest.json` 的 node、python、git 之前，bootstrap 对重装和首装都答 `PREREQ_NOT_PINNED`。

### 旧重装工具的内部合同（历史）

`prepare` 的命令行在每台节点上完全相同，没有任何节点参数：根目录固定为 `C:\ProgramData\CluedIndependentCI\resident`，令牌、已装包、配置都不从命令行给；`--artifact-sha` 是 bootstrap 第 1 步核过的值。

`prepare` 再核一遍 tar 的 sha256 与接受文件，严格读包、逐文件核 `universal-manifest.json`，并要求正在运行的 `install.mjs` 及其模块就是包里的字节；节点身份只从本机读（`install\install-receipt.json`、`record\*`、`config\policy.json`、`config\companion.json`、`install\companion-account.json`、`install\companion-wsl.json`、`upgrade\current.json`、`upgrade\mailbox\responses\version-facts.json` 与 `roles-public.json`、runner 服务的 SDDL，只读）。没有 `install-receipt.json` 的节点走首装分支，见 5.1。不需要按节点的配置文件，也不依赖仓库检出。

依次：构建本节点的首装包（两次，sha 相同）、`linux-in\`、合成的 `inputs\reinstall-config.json`、包内 `rehearse.py --fleet`（必须 `REHEARSAL_PASS`）、包内 `prep.py`（`linux\A.sh`、`B.sh`、`B-resume.sh`）、包内 `generate.py --fleet-plan <plan> --check`（生成启动器前的全部检查，不要求已暂停，不写启动器；不过则停，旧常驻不会被暂停），**然后做 W1 暂停**：包内 `reinstall/tools/pause-old-resident.py`，非提权，reason 为 `fleet-node-reinstall-<version>-w1-before-linux-switch`，必须得到 `OLD_RESIDENT_PAUSED_NO_OPEN_BATCH`（最多等 90 分钟），所确认的 `PAUSED.json` 的 sha 与 reason 写进 `install-plan.json` 的 `w1Paused`，由启动器钉住；最后包内 `generate.py` 生成 `launcher.ps1`。同一版本再跑一次（bootstrap 每次用新的工作目录）时，W1 找到自己的暂停并立即确认，不重复请求。

`<work>` 下产出（只许新建）：`package\`、`linux-in\`、`linux\A.sh`、`B.sh`、`B-resume.sh`、`launcher.ps1`、`install-plan.json`。Linux 脚本的输出目录是 `install-plan.json` 里 `linux.outDir` 指定的新目录 `C:\ProgramData\CluedIndependentCI\reinstall-linux-out-<32hex>`，由提权启动器在 Linux A 之前新建并设权限；`prepare` 不建它，也不改任何 ACL。结束时打印一行 JSON：`{status, node, version, workDir, installPlan, launcher:{path, sha256}, runCommand}`。

旧工具生成的 W1 暂停和启动器证据用于解释历史操作。现行入口的重装分流要经过 `package-lifecycle.ps1` 维护准入与本机清理。

### 5.1 首装：同一条命令，盘点确认空机

同一个入口 `fleet-node-<v>.bootstrap.ps1 -From <目录>`。先非提权检查接受文件、tar、kit、角色镜像和控制器 Node 摘要。一次 UAC 内，原操作人持本机安装锁，把已钉住的资产及工具复制到管理员专用目录并复核，再依次完成主机准备、`install.mjs prepare --from` 和启动器。主机准备将本次首装事实写到 `C:\ProgramData\CluedIndependentCI\first-install\facts.json`。

- `prepare` 的判据只有一个：有没有 `install\install-receipt.json`。没有时：本机不得有任何常驻残留（三个服务、resident 根；有就 `FIRST_INSTALL_RESIDUE_PRESENT` 并列出，不猜、不覆盖）；节点值只从 `facts.json`（`clued.independent-ci.first-install-facts/1`，名字全由机器名推导，规则写在 `readFirstInstallFacts`）和该版的首装 kit 读。CI 根对 operator 不可列目录（主机准备设的 DACL），`prepare` 看不到 `resident-uninstalled-*`：输出的 `residueUnchecked` 写明这一项没查，不当作没有（主机准备与启动器在提权下查）。
- 首装 kit：`fleet-node-<v>.first-install-kit.json`，由 `publish.mjs prepare` 从前版已接受 Release 读回并验证，再随候选上传（第 4 节；没有单独的取 kit、挂 kit 步骤）；内容是模板 roles-v3 与 version facts、模板 Source 清单与公钥、全队共用的 record 值、模板 policy/companion 配置、角色镜像。其 sha256 由 Owner 随版接受（接受文件的 `firstInstallKitSha256`）：没有它的接受文件，`seal` 不挂、`prepare` 与升级不读（`FLEET_ACCEPTANCE_HAS_NO_FIRST_INSTALL_KIT`）；Release 上缺 kit 资产、`first-install.SHA256SUMS` 里的哈希与接受文件不等、或缺 kit 列的任一镜像，`seal` 同样拒绝。本机已装的旧版记录不受影响。
- 本地构建的角色镜像（contract-placement 的 `sha256:<id>`）随版发布为 `role-image-<id>.tar.gz`（全队一次导出），B 载入后由 docker 按 id 核内容；新节点不再要任何节点为它导出东西。
- 其后与重装同一路径：建包两次、`linux-in\`、包内 `reinstall/linux/first-install.py` 的 `--in-dir/--out-dir` 形态（`A.sh` 首装检查与派生、`B.sh` 签名与安装、`B-resume.sh` 即 `B.sh`）、`install-plan.json`（`firstInstall`，无 W1，`secrets.source = first-install`）、`generate.py --fleet-plan`。结束输出 `FLEET_NODE_FIRST_INSTALL_PREPARED`。
- 启动器：首装预检（无残留、令牌目录只有 SYSTEM/Administrators）→ 从 `first-install\credentials\` 带令牌并核指纹 → Windows 侧完整预检（runner 等待、两处秘密文件、安装器的两次 dry run 与 ACL 迁移计划；不过即停，Linux 未动）→ Linux A/B（由提权 Owner `wsl -u root`，发行版此时在 operator 名下的导入位置）→ 安装 → verify → companion → rearm → 现有的 M5-b 切换（`rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory`，把发行版 move 到 companion 名下）。没有 W1、没有卸载。首装的结论按这个顺序判（`Get-LauncherVerdict`）：先看角色，first-train 等待没有确认角色（终态 `role` 不是 `held` 或 `not-held`）时 bootstrap 答 `BOOTSTRAP_FIRST_INSTALL_ROLE_NOT_CONFIRMED`，码 `FIRST_INSTALL_ROLE_UNAUTHORIZED`（服务端拒了本节点的 CI 令牌）或 `FIRST_INSTALL_ROLE_UNCONFIRMED`（其余），换账户没过也是这个结论；角色确认之后再看切换，没有通过（`companionHeadless` 不是 `COMPANION_HEADLESS_QUALIFIED`）时答 `BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE`。两种都不答 `BOOTSTRAP_DONE`；切换的状态在每种结论的 `companionSwitch` 里都保留。
- 同一提权阶段负责清理 `first-install\credentials\` 的首装暂存令牌。它在主机准备前清理上次暂存，结束时再次读回清理结果。
- 主机准备先写 `facts.json`（整份或没有），再放 App 私钥与 ci-admission 令牌：中途断掉只会留下有 facts、缺秘密的状态，下次运行按 facts 记录的指纹只问缺的那些（facts 记录了心跳令牌就必须再给），`-Reset` 能清掉；不会留下没有 facts、无法归属的秘密。
- 主机准备阶段中断可重跑同一条命令。启动器启动后，入口先读管理员工作区的终态。结果不明时返回 `FLEET_INSTALL_RESULT_UNCONFIRMED`，保留该操作的进度。

## 6. 本机维护窗口

1. 正式封存后先让备班上报当前包、Windows 和 Linux 身份、近期健康和空闲。
2. 旧当班完成在途批再交班，随后作为后备保留旧装。新当班主线推进读回成功，或无活满 12 小时且新当班自检通过后，服务端才释放后备。
3. 安装器在 UAC 前查询其它健康节点。摘牌操作匹配目标包、节点与 Binding 代次，且 `install_ready=true` 时才能清理。单机删旧重装需要明确确认。
4. 服务端根据新启动后的当前包回执、自检和备班状态自动恢复节点。节点故障导致自动推进暂停时，按[运维手册 §5.1](../../docs/runbook.md#51-当班包不合格或无法核实)处理。
5. 重试需要再次清理时，读回的 `drain_confirmed_at` 必须覆盖本次摘牌请求。换包后以新 Grant、预检回执和维护 UUID 重新摘牌，沿用同一份受保护的凭据暂存。
6. 升级器在长操作期间独立更新锁心跳。服务仍在运行而心跳无法核实时，安装入口暂停。服务已停止才可将该升级视为已弃。

## 7. 凭据在哪里

- 发布机只用 `gh` 自己的登录（`gh auth login` 存在 gh 自己的凭据库）。`publish.mjs` 调 gh 时去掉环境里的 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，不读、不写、不打印任何令牌。
- 节点取包同样用节点上 gh 自己的登录；包与接受文件里没有任何凭据，只有哈希与引用。
- 节点凭据留在 Windows 原生界面及受保护的文件载体中。生命周期清单列出要原位保留的连接和需要同卷转移的升级、心跳载体。实际清理和恢复须等到本机原生调用链接通。

## 8. 失败时怎么办

- 重跑同一条 bootstrap 命令时，安装锁保护同机器、操作人、动作和包摘要对应的进度。首装主机准备可继续。启动器的终态无法确认时，入口保留进度并停止。
- 历史重装启动器的 W1 暂停和专用续作命令见 DESIGN §73，供历史操作核对。
- `RUNNER_SERVICE_NOT_AS_REVIEWED`：当班节点在暂停下仍会为自己的维护临时交换运行器，预检会等它换回（最多 600 秒）；到时仍不对才停。
- `publish.mjs` 在 gh 失败时不动索引；`prepare` 建 Release 中途断了，原样重跑同一条 `prepare`：它认出已建的那部分，只补缺的资产和索引行，不重复创建同一 tag。
- `seal` 对已用另一个 Decision 接受的版本拒绝；接受文件写错要由协调者与 Owner 重新决定，不覆盖。`prepare` 或 `seal` 中途断了，原样重跑同一条命令。
- 第 27 代起，发布命令在封存前取上一封存提交的接口断言，用候选提交的迁移在隔离 PostgreSQL 中回放。缺前包证明、缺本地测试依赖或接口用例失败时停止封存。续传只补缺失资产，任何已发布字节不同就停。
- B 在 Source 切换之后失败：模板自动用 B-resume 续跑一次；仍失败则停手，交协调者。
- 节点装完 `verify` 不过：不继续装另一台。
