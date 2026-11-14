# 原地升级与滚动升级工具（rollout/）

换常驻或 CI Source 时，不再整套卸载重装：用节点上**已装的**升级代理（`CluedCIUpgrader`）原地升级，失败自动回滚到上一代；多个节点按“先待命、后当班（原地，CI 暂停几分钟）”的顺序滚动；要移交就在开始前、两台还是同一 Source 时做。设计见 DESIGN §42，Task `018da927`。

## 1. 边界

- 所有工具**不提权、不进 WSL root、不写主机**，只在构建配置的 `workDir` 下新建文件，绝不覆盖。改动主机的只有节点上的升级代理，而它只认 Owner 在 KooYomi 页面上对精确包哈希的批准（Grant）。
- 秘密不进仓库、不进任何生成物。升级通道本身也不碰 `secrets\`。
- 不放宽任何检查：签名 Source、包哈希、policy 的 manifest 钉值、SCM binPath 钉值、节点身份、`stateCompat` 双向可读，全部由节点上冻结的升级代理照旧强制。这里的预检只是提前用同一段代码跑一遍。

## 2. 打包：`build-upgrade.ps1`

```
powershell -NoProfile -File rollout\build-upgrade.ps1 -Config reinstall\config\<node>.json -Commit <40hex> -InstalledPackage <现装包目录>           # DRAFT
powershell -NoProfile -File rollout\build-upgrade.ps1 -Config ... -Commit ... -InstalledPackage ... -Final -DecisionRef <uuid> -ReceiptRef <uuid> -Tag t
```

- 构建配置与 `reinstall/` 相同（`reinstall/README.md` 第 2 节）。`linux.installedManifest`、`linux.installedRoles` 必须是**现装**的副本：角色副本按节点自己的 version facts 逐个核对哈希。
- 角色副本（DESIGN §63）：优先读 companion 写在 version facts 旁边的 `upgrade\mailbox\responses\roles-public.json`，不再需要以 UAC 运行 root 导出。它缺失（companion 早于这次修复）或代次与 facts 不同（刚切代、companion 还没刷新）时，才回退到 `linux.installedRoles`，并打印 `ROLES_PUBLIC_COPY_MISSING` / `ROLES_PUBLIC_COPY_OTHER_GENERATION` 警告；输出 JSON 的 `rolesCopySource` 写明用的是哪一份。两种来源都按 facts 逐字节核对。
- `-InstalledPackage`：节点现在跑的那个包（它的 `package-manifest.json` 哈希必须等于 `upgrade\current.json` 的 `packageManifestSha256`）。record 的 9 个接受 ref 和 `acceptedAt` 原样沿用它的（Decision `b1dd8a84`）；这次升级的 Owner 接受是 `-DecisionRef`/`-ReceiptRef`，写进 policy 的 `ownerAcceptance`、包的 `acceptance.decisionRef`，再进 request 和 Grant。
- 不带 `--fresh-install`；带 `--source-v2`（只含 `refs/heads/accepted` 的 bundle，和用冻结 Linux 工具自己的 `derive_role` 算出的角色哈希，`tools/roles-derived.py`）。
- 同样的输入构建两次，包 sha 必须相同；节点身份、节点档案必须与现装包相同。
- 最后自动跑预检。输出一行 JSON：包目录、包 sha、`grantResource`、预检结论，final 且预检通过时给出 request 命令（用**已装**常驻目录里的 `request-upgrade.ps1`）。
- `-StateCompat <file>`：Source 改了 state 格式时由作者显式给出；只能“先扩后缩”（DESIGN §42.4.4）。

## 3. 预检：`precheck.mjs`

```
node rollout\precheck.mjs --root C:\ProgramData\CluedIndependentCI\resident --package <包目录> --package-sha <hex> --acceptance <uuid> --installed-package <现装包目录> [--allow-fleet-source-mismatch]
```

- 包里带的升级代理副本与已装的不同：`PRECHECK_REFUSED` / `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`，与现装包逐文件比较，列出变化（`changedFrozenFiles`）。冻结的 Linux 升级工具、签名器和工具清单与现装包不同，或工具不是 version facts 里的 `upgradeToolSha256`，同样是通道变更。
- 都相同：先逐文件核对副本，再用**本检出**的 `canonical.mjs` 算出副本清单的哈希，必须等于已装的；之后才从包里的副本（与节点上冻结的那份逐字节相同）import `readPackageOnce`、`buildPlan`，对节点现场跑一遍 ACCEPT。非提权读不到的槽列在 `unreadableSlots`，结论为 `PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS`。
- `warnings`：进行中的 op、HALT、两侧不一致、Linux 有暂存代、本节点当班（要先移交）。这些会变，只提醒。
- 跨节点 Source（缺陷 15894c2a）：目标包的策略（取自完整性已核验的候选包，不取已装策略）`train.enabled` 为 `on` 时，预检按第 10 段的 §41.6 规则拿**目标** Source 去比其余节点：数据是本节点 `state\status.json` 的 `train.nodes`，即第 10 段（当班、on 模式）上一次从 Native `ci_nodes_status` 读到并比对过的节点表（`train.mjs#trainNodesView`；预检非提权，拿不到 ci-admission 令牌，不能自己调 Native）。结果写在 `fleetSourceReadiness`：
  - 24 小时内有心跳的其他节点都已是目标 Source（或没报 Source）：`PASS`，结论照本机检查；
  - 有一台不是：`PRECHECK_REFUSED` / `FLEET_SOURCE_MISMATCH`，`detail.upgradeFirst` 和 `advice` 写明先升哪台（待命节点先升、当班节点最后升）；否则本机升级后列车以 `TRAIN_SOURCE_MISMATCH` 停车，直到它们也装上同一个 Source；
  - 只有**此刻当班**的节点（`status.json` 的 `node.mode` 为 `ACTIVE`）按节点表拒绝。交接班后 1 小时内两台的表都还新鲜，但只有当班那台的表代表第 10 段此刻比对的内容；不当班的一台一律 `UNVERIFIED`（`reason: NOT_ON_DUTY`），`mismatchedNodes` 只列出它上次看到的，作提醒，不拒绝；
  - 紧急放行：对端 24 小时内有过心跳但已永久离线（拒绝无法靠先升它解决）时，Owner 可给 `build-upgrade.ps1 -AllowFleetSourceMismatch`（预检参数 `--allow-fleet-source-mismatch`）。结论为 `PRECHECK_PASS_FLEET_SOURCE_MISMATCH_ALLOWED`，警告 `FLEET_SOURCE_MISMATCH_ALLOWED`，`fleetSourceReadiness.allowed: true`，构建汇总记下 `fleetSourceMismatchAllowed: true`。**后果**：放行只跳过预检，不改运行时检查；本机升级后合并列车照样以 `TRAIN_SOURCE_MISMATCH` 停车，直到那台的最后心跳满 24 小时（之后不再比较）或它装上目标 Source。不要用它跳过“先升另一台”；
  - 不一致但那台 24 小时内没有心跳：不比（与第 10 段相同），照常通过，列在 `staleNodesIgnored`，警告 `FLEET_STALE_NODES_IGNORED`；
  - 没有可用的节点表（待命节点没有：只有当班节点的第 10 段读 Native；表超过 1 小时；表里找不到本节点；本节点不当班；目标模式缺失或不可识别）：`PRECHECK_PASS_LOCAL_ONLY` + `FLEET_SOURCE_UNVERIFIED`，`localChecks` 保留本机结论，`advice` 按原因写明该怎么核对，`ownerStatusUrl` 指向 `/bindings/failover` 供 Owner 只读核对。这不表示各节点一致。
  - 目标为 `shadow`/`off`：`NOT_REQUIRED`，不比（shadow 回退不会被挡）。
  - **首代空窗**：`train.nodes` 由本修复写进 `status.json`，要等节点装上含本修复的一代、且当班节点跑过一次 on 模式第 10 段（默认 10 分钟内）才出现。在此之前（包括装这一代本身的那次升级）预检一律 `PRECHECK_PASS_LOCAL_ONLY`（`reason: NODES_VIEW_ABSENT`），跨节点一致仍要 Owner 在 `/bindings/failover` 手动核对。执行器重启后表也要等下一次 on 模式第 10 段。预检不能保证核对之后各节点状态不变，运行时的 24 小时 Source 检查保持不变。
- 构建汇总带出 `precheckWarnings`、`precheckLocalChecks`、`fleetSourceReadiness`、`precheckAdvice` 和 `fleetSourceMismatchAllowed`。

## 4. 滚动升级：`rollout.mjs`

```
node rollout\rollout.mjs plan    --out rollout.json --decision <uuid> --package <node>=<dir> [--package <node>=<dir> ...]
node rollout\rollout.mjs observe --root C:\ProgramData\CluedIndependentCI\resident --out observation.<node>.json      # 每个节点上各跑一次
node rollout\rollout.mjs next    --plan rollout.json --observation observation.<node>.json [...]
```

`next` 只给出一个下一步：

| 结果 | 谁来做 |
|---|---|
| `UPGRADE <node>` | 该节点的 Agent 在 Owner 会话里非提权运行 build-upgrade 给出的 request 命令；Owner 在 `upgrade\status.json` 的 `confirmUrl` 页面批准一次 |
| `WAIT` | 过一会儿重新 observe（升级在进行、节点 UNCERTAIN、observation 过期或缺；Owner 刚移交过时带 `--handover-issued-at <ISO>`，15 分钟内两个 ACTIVE 是 `WAIT ROLLOUT_HANDOVER_PENDING`） |
| `BLOCKED` | 协调者报告 Owner：回滚了（`ROLLOUT_NODE_ROLLED_BACK`，节点保持暂停）、本次升级被拒或 Grant 过期（`ROLLOUT_NODE_UPGRADE_REFUSED`）、HALT、两个当班、没有待命节点等。plan 记了 `createdAt`：它之前的结局属于上一次 rollout，不算。Owner 看过之后（ROLLBACK_FAILED 先提权 `-Recover`），协调者用 `--ack-op <opId>` 确认那一个 op，它就不再阻塞 |
| `DONE` | 全部节点到了目标包、两侧一致、没有暂停，当班节点也在 plan 里 |

- 待命节点都已升好且有一个健康时，下一步是 `UPGRADE <当班节点>`，带 `ciPause: true`（协调者加 `--allow-active-upgrade` 运行它的升级命令）：不再给 `HANDOVER`，因为服务端只把 ci-admission 移交给与全队同一 Source 的节点（迁移 `20261114120000`，`ci_admission_target_source_not_accepted`），而且 Source 不同的窗口里列车本来就以 `TRAIN_SOURCE_MISMATCH` 停车。没有待命节点时，只有 Owner 在弹窗里选了“接受暂停 CI”、协调者加 `--allow-active-upgrade` 才给出它。
- 一次只升一个节点，任意多个节点同一规则。

## 5. 测试

```
node --test rollout/test/                                           # 在 work/independent-ci-resident-v1/ 下
python -I -m unittest discover -s rollout/test -p "test_*.py"
```

- `rollout.test.mjs`：plan 的各类拒绝；`next` 的每一行（两个、三个、一个节点）；observe 只读、读不到就列出。
- `precheck.test.mjs`：包里带着本树真实的升级代理副本，所以做决定的就是被测的代码：通过、读不到的槽、冻结模块改动（列出文件）、副本被篡改、身份/state/接受/同包、Linux 工具变更。
- `test_upgrade_tools.py`：`upgrade-config.py` 沿用现装包与拒绝；`roles-derived.py` 的结果等于冻结 Linux 工具 stage 时的 `derive_role`，以及工具不同、角色副本过期、manifest 不是包的、新提交缺钉住文件。

## 6. 第 8 代工具补充（Task 09052ffe 等）

- `build-upgrade.ps1`（和 `reinstall/build.ps1`）开头调用 `reinstall/tools/set-aside-leftovers.py`：同一 stem 上一次**失败**的尝试留下的输出（create-only 会挡住下一次）被改名到 `<workDir>\failed-attempts\<UTC>\`，不删除；已完成的尝试（`upgrade\precheck.<stem>.*.json` / `build-complete.*`）永远不动，换 `-Tag`。git archive 一律用 Python `tarfile` 解包（Windows `tar.exe` 解不了中文路径）。
- `INSTALL-BATCHES.md`：装机批次方案（只是方案）：哪些改动要整套重装（动冻结的升级代理文件）、哪些原地升级，如何排进最少的批次。
- `windows/test-upgrade-system.ps1`：以 LocalSystem 跑 Compile 的一次 UAC 测试（改升级通道或 Source v2 Windows 代码时必跑）。
- `tools/derive-public-export.py`：从上一代已审的 public-export 派生下一代的参数化生成器（原 `make_export23x.py` 一类）。装上带 DESIGN §63 的常驻代之后，打下一代包不再需要它；只在 companion 副本不可用时作为回退。

