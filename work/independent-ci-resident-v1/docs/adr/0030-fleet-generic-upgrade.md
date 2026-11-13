# ADR 0030：通用升级：同一个通用包、同一份接受文件，已装节点原地升级，零 UAC

- 状态：已实现（分支 `claude/fleet-generic-upgrade`，未发布、未安装）
- 日期：2026-11-13
- Owner Decision：统领原则（`42d5bf8d`）；节点只有两条路：通用升级，升不了就删干净用通用安装包重装，操作单位是“对全部登记节点发同一个通用包”（`b5d041d2`）
- 代码：`rollout/fleet/upgrade.mjs`（新，取代 `rollout/fleet/assemble.mjs`）、`rollout/precheck.mjs`（已装包目录改为可选）、`rollout/fleet/install.mjs`（`recordInputsFor` 带出 `validUntil`）、`rollout/fleet/universal.mjs`（包内文件清单）
- 测试（修复前不可能）：`rollout/test/fleet-upgrade.test.mjs`

## 1. 现状与缺口

2026-11-13 把一个修复上到 DESK、TURING 走的是整机重装：约十次 UAC，撞出三层安装器缺陷（ADR 0029）。已装节点本该由 `CluedCIUpgrader` 原地升级（`windows/request-upgrade.ps1`，零 UAC，失败自动回滚），但通用包只接了重装这一条路：

| 环节 | main 上有什么 | 缺什么 |
|---|---|---|
| 通用包、发布、接受文件 | `universal.mjs`、`publish.mjs`、接受文件合同 `fleet-node-acceptance/1` | 无 |
| 节点把通用包组装成升级包 | `assemble.mjs`：要服务端的 accepted-Source 记录（`--target`，那个迁移从未进 main）和“已装包目录”（`--installed-package`） | 两个输入今天的节点都给不出：服务端没有那张表；通用重装装出来的第 1 代，已装包只在当时 `prepare` 的临时目录里，节点自己不知道在哪 |
| 发起升级 | `request-upgrade.ps1`（已装） | 没有人把组装结果交给它；预检 `precheck.mjs` 也强制要已装包目录 |
| 批准 | Grant 门 + Owner 自动审批规则（迁移 `20261107090000`，每节点 24 小时 6 次） | 无 |
| 执行、回滚 | 冻结的升级代理与 `upgrade-apply.ps1`、Linux 升级工具 | 无（不改） |

所以“e011a6b1 → 下一个包”在今天的两台上没有任何一条命令能走原地升级。

与半成品分支 `claude/fleet-generic-upgrade-p1`（`858628d9`）逐项对照：

| p1 里的东西 | 结论 |
|---|---|
| 通用包、组装器、发布（`universal.mjs`、`assemble.mjs`、`publish.mjs`、ports、tar、pyjson） | 已在 main（第一批），其中组装器由本 ADR 换成 `upgrade.mjs` |
| accepted-Source 服务端迁移（`20261112150000_fleet_accepted_source_v1.sql`） | 不在 main，**不需要**：接受文件已经是“Owner 接受一次、全体适用”的载体，Grant 走现有自动审批。不新增服务端对象 |
| fleet 驱动（`src/fleet-driver.mjs`：companion 自己拉包、自己投递请求） | 不在 main，本次不做（第 5 节）：它要 companion 账户对 `upgrade\inbox` 的投递权限和服务端的目标记录，两者都不是“零 UAC 升级两台”所必需 |
| 宿主先决条件收敛（`host-prerequisites.ps1`） | 不在 main；main 已有等价的最小实现（`verify-resident.ps1` 的 `Invoke-CompanionRelayParentsEnsure` + 预检），不再引入 |
| 重装保留清单（`node-preserve.json`、`preserve-check.mjs`） | 不在 main；通用重装的启动器已自己带入令牌与记录（ADR 0029），不再引入 |
| `next-channel/`（冻结通道下一版草稿） | 不在 main；与本项无关，等下一次本来就要做的重装 |
| `claude/linux-identity-no-stdev`（`ee68029c`） | 冻结文件（`clued-ci-upgrade-linux`、`upgrade-mailbox.mjs`、`machine.mjs`）与 main 逐字节相同：已随第一批进 main，并已随 e011a6b1 装到两台。无需再并 |

## 2. 决定

**一个通用包、一份接受文件、两条路共用。** 节点上多一条命令 `upgrade.mjs`，参数与重装的 `install.mjs prepare` 完全相同，每台节点相同，没有节点参数：

```
node <解包目录>\tree\work\independent-ci-resident-v1\rollout\fleet\upgrade.mjs
     --artifact <tar> --artifact-sha <hex> --acceptance <acceptance.json> --work <新目录>
```

它只读本机（非提权、Owner 会话），只在 `--work` 下写，最后调用**已装的** `request-upgrade.ps1` 往 `upgrade\inbox` 投一个请求文件。之后全部由已装的升级代理完成。

### 2.1 链路

| 环 | 谁做 | 输入 | 批准 | UAC |
|---|---|---|---|---|
| 1 构建、发布 | 发布机，一次 | 提交 | 无 | 0 |
| 2 接受 | Owner 一次 Decision；协调者写接受文件并 `attach-acceptance` | 包的 sha、`ciSourceManifestSha256`、`fleetRefs` | **Owner 的唯一一次决定，全体节点适用** | 0 |
| 3 节点组装 + 预检 + 请求 | 每台节点同一条命令 | tar、接受文件、本机记录 | 无（只读 + 一个 create-only 的请求文件） | 0 |
| 4 Grant | 已装升级代理问 Grant 门 | `ci-resident:<节点>/<包 sha>` | 自动审批开着：自动（每节点 24 小时 6 次，同一个包第二次请求归 Owner）；否则 Owner 在 `status.json` 的 `confirmUrl` 点一次 | 0 |
| 5 排空、暂停、暂存、切换两侧、核验、恢复 | 已装升级代理（LocalSystem）+ companion 的 Linux 升级工具 | 请求里的包目录 | 无 | 0 |

### 2.2 节点命令做什么（`upgrade.mjs`）

1. 核接受文件、tar 的 sha256、逐文件核 `universal-manifest.json`；正在运行的模块必须是包里的字节（与重装同一套，`install.mjs#readArchive`）。
2. 幂等的三个出口，都在读节点细节之前：
   - 升级代理有操作在途（`upgrade\status.json` 的 `op`）：`FLEET_NODE_UPGRADE_IN_PROGRESS`，带状态与 `confirmUrl`，不投第二个请求；
   - 两侧都已是这个包（Windows 的 Source 与常驻清单、Linux 的 Source）：`FLEET_NODE_ALREADY_AT_THIS_PACKAGE`；
   - 否则往下。**同一条命令既是“做”也是“核对做完没有”。**
3. 读节点（`install.mjs#readNode`，与重装同一个函数）：回执、`current.json`、record、配置、运行时、Linux 版本事实与公开角色副本。升级另外要求两侧是同一个 Source（不是就走重装）。
4. 通道没变才能升级，三处在组装之前就判，任何一处不过都是 `FLEET_NODE_UPGRADE_NEEDS_REINSTALL`，detail 写明哪一处，并给出同一批文件的重装命令：
   - 包的升级代理清单 ≠ 回执里的（`UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`）；
   - 包的 Linux 升级工具 ≠ 版本事实里的 `upgradeToolSha256`；
   - 按本机现装引用算出的 Source ≠ 接受文件的 `ciSourceManifestSha256`（见 2.3）。
5. 组装升级包：record 沿用现装的全部接受引用（Decision `b1dd8a84`：节点身份钉住 7 个资格引用与 Owner 决定、回执，升级代理拒绝身份变了的包）；policy/companion 取现装的，`ownerAcceptance` 写接受文件的 `ownerDecisionRef` / `installationReceiptRef`；Linux 外部钉值按包内 unit 推出（与重装同一个函数）；三个角色哈希按冻结 Linux 工具的 `derive_role` 推出（`ports.rolesDerived`）；用包内 `build-package.mjs` 构建两次，sha 相同；通用值等于 `universal-manifest.json`，节点身份、档案不变。
6. 预检：包内 `precheck.mjs` 用包里那份（与已装逐字节相同的）升级代理跑一遍 ACCEPT。**不再需要已装包目录**：升级代理清单与回执比，Linux 工具与版本事实比；节点自己有上一个升级包（`upgrade\staged\<当前包 sha>`，第 2 代起都有）时照旧逐文件比。
7. 预检通过才投请求（已装的 `request-upgrade.ps1`）。输出一行 JSON：包 sha、`grantResource`、请求 id、`statusFile`。`--no-request` 停在第 6 步之后，用于演练。

没有 Python、没有 git、不进 WSL、不改任何 ACL。

### 2.3 接受文件：两条路同一份

升级不换 record 的引用，所以本机算出的 Source 取决于**现装**的三项：`sourceAcceptanceRef`、`hostQualificationRef`、`formalRoles`。接受文件的 `ciSourceManifestSha256` 由 `fleetRefs` 里的同三项决定（`install.mjs source-hash`）。因此：

- 写接受文件时，这三项**沿用现装值**（任一已装节点 `install.mjs fleet-refs` 只读取出；两台自 e011a6b1 起相同），这一版就能通用升级；`ownerDecisionRef`、`installationReceiptRef`（= `ownerReceiptRef`）写这次的 Decision 与回执。
- 三项里任何一项要换，这一版对所有节点都只能重装。节点在组装前就拒绝，detail 列出不同的项。
- 同一份接受文件拿去 `install.mjs prepare` 重装，得到同一个 Source。所以一台升不了改走重装，不会和已升级的节点分叉（列车只比 `ciSourceManifestSha256`）。

### 2.4 失败怎么回到一致状态

| 停在 | 节点状态 | 下一步 |
|---|---|---|
| 第 1–6 步（组装、预检） | 没动（只写了 `--work`） | 改正后同一条命令，换新 `--work` |
| Grant 被拒、过期、取消，排空超时 | 没动；hold 与暂停由升级代理撤回 | 同一条命令（同一个包再请求归 Owner 审批） |
| 暂存、Linux stage 拒绝（含通道变更在 Grant 之后才发现） | 没动；暂存移到 `staged-withdrawn` | 走重装 |
| 切换之后 VERIFY 不过 | 升级代理把 **Windows 与 Linux 两侧一起** 换回上一代，节点保持暂停（`ROLLED_BACK_PAUSED`） | Owner 看过后恢复；修包再发 |
| 回滚失败（`ROLLBACK_FAILED`） | 可能两侧不同，节点保持暂停、不接活 | 走重装：通用重装不要求两侧先一致（ADR 0029） |

与重装的区别：两侧的切换是同一个带日志的操作，由升级代理续跑或回滚，不存在“启动器一次性、停在中间等人续”的状态。唯一留给第二条路的是 `ROLLBACK_FAILED`。

舰队层面：一台已升、另一台没升时列车以 `TRAIN_SOURCE_MISMATCH` 停车（原有规则），直到另一台也到同一个 Source（升级或重装）。预检照旧要求待命节点先升、当班节点最后升。

### 2.5 按 1000 台

- 批准：一份接受文件对全体适用；Grant 由自动审批规则逐台放行，不逐台问人。
- 命令：每台完全相同，没有节点参数；重复运行安全（2.2 第 2 步）。
- 节点自己做：组装、预检、请求、执行、回滚、核验都在节点上，协调者只需要把同一条命令发给每台。

## 3. 改了什么（删多于加）

- 新 `rollout/fleet/upgrade.mjs`；删 `rollout/fleet/assemble.mjs` 及其测试（它的两个输入不存在，没有任何调用方）。通用包构建的可重复性仍由 `rollout/fleet/test/install.test.mjs` 覆盖。
- `rollout/fleet/ports.mjs`：删掉只有旧组装器用的四个移植（`recordInputs`、`readBaseRecord`、`linuxPins`、`linuxPinsCheck` 等）及其差分测试。升级与重装现在用同一份 `install.mjs#recordInputsFor`、`linuxExternalPins`，一处规则。
- `rollout/precheck.mjs`：`--installed-package` 可选。不给时：升级代理按回执比（哈希覆盖每个文件，结论相同，只是不列出逐文件差异）；Linux 签名器与工具清单没有已装字节可比，由 Linux stage 在 Grant 之后拒绝（干净拒绝，节点不动）。
- `rollout/fleet/install.mjs`：`recordInputsFor` 把 `validUntil` 原样带出（重装仍是 `null`）。
- `rollout/fleet/universal.mjs`：`TREE_FILES` 里的 `assemble.mjs` 换成 `upgrade.mjs`。
- 冻结通道（`upgrader/src`、`upgrade-apply.ps1`、Linux 升级工具、签名器）、服务端、安装器：未动。没有迁移。

## 4. 测试

`rollout/test/fleet-upgrade.test.mjs`（在 CI 的 `resident-node` 套件里；`rollout/fleet/test/` 不在）：

- 今天的形态：两台通用重装装出的第 1 代节点（各自的档案、身份、签名者，相同的舰队引用），**没有已装包目录、没有服务端记录**。同一个 tar、同一份接受文件、同一条命令 → 两台各得到自己的升级包，`ciSourceManifestSha256` 相同且等于接受文件；预检通过；请求参数正确。
- 把请求交给**冻结的升级代理**（`upgrader/src/machine.mjs`，真的包、真的计划）跑到 `SUCCEEDED`：第 2 代，Source 是接受的那个。再跑同一条命令：`FLEET_NODE_ALREADY_AT_THIS_PACKAGE`，不投请求。
- 操作在途：不投第二个请求。
- 走不了升级的三种：升级代理变了、Linux 工具变了、`fleetRefs` 的 Source 项变了 → `FLEET_NODE_UPGRADE_NEEDS_REINSTALL`，什么都没投；同一份接受文件的 `source-hash` 与升级得到的 Source 相同。
- 预检拒绝时不投请求；`--no-request` 不投请求。

## 5. 没有做的

- **节点自己拉包、自己发起**（fleet 驱动）。现在每台节点仍要有一个 Owner 会话里的进程跑那条命令。要做成完全无人值守，需要：companion 账户对 `upgrade\inbox` 的 create-only 权限（装机布局，随下一次重装）和节点读取“当前接受的版本”的来源。两台时不值得；节点数上来再做。
- 第 1 代节点上 Linux 签名器单独变更的提前发现（见第 3 节）。升级过一次之后节点自己留有上一个包，就能提前比。
- 真机：本分支未在 DESK、TURING 上运行升级；只在本机以 `--no-request` 对 DESK 现装状态做了只读演练（结果见交付说明）。
- `rollout/build-upgrade.ps1`（按台、按配置文件构建升级包的旧入口）仍在：它的 Python 工具（`node-inputs.py`、`roles-derived.py`）是 ports 差分测试的原件。它不再是上线路径；删它连同 `rollout/tools/` 是下一步的清理，本次没做。
- `rollout/fleet/test/` 不在 CI 的套件选择里（`{tests:rollout/test}` 不递归），所以其中一条断言已经在 main 上坏了（`cfg.node`，本次顺手修掉）。把它接进 CI 要先确认这些测试在 Linux 执行机上能跑（它们用 Windows 路径和 Python 工具），本次没做。
