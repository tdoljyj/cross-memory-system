# 原地升级与滚动升级工具（rollout/）

节点可用已装的 `CluedCIUpgrader` 原地升级，失败自动回退。正式封存舰队按服务端的当班、后备与摘牌状态轮换，步骤见[运维手册 §5.1](../docs/runbook.md#51-当班包不合格或无法核实)。

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
node rollout\precheck.mjs --root C:\ProgramData\CluedIndependentCI\resident --package <包目录> --package-sha <hex> --acceptance <uuid> --installed-package <现装包目录>
```

- 包里带的升级代理副本与已装的不同：`PRECHECK_REFUSED` / `UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL`，与现装包逐文件比较，列出变化（`changedFrozenFiles`）。冻结的 Linux 升级工具、签名器和工具清单与现装包不同，或工具不是 version facts 里的 `upgradeToolSha256`，同样是通道变更。
- 都相同：先逐文件核对副本，再用**本检出**的 `canonical.mjs` 算出副本清单的哈希，必须等于已装的；之后才从包里的副本（与节点上冻结的那份逐字节相同）import `readPackageOnce`、`buildPlan`，对节点现场跑一遍 ACCEPT。非提权读不到的槽列在 `unreadableSlots`，结论为 `PRECHECK_PASS_EXCEPT_UNREADABLE_SLOTS`。
- `warnings`：进行中的 op、HALT、两侧不一致、Linux 有暂存代、本节点当班（要先移交）。这些会变，只提醒。
- 本机预检核对 Windows 与 Linux 的安装身份。跨节点轮换由服务端依据封存记录、实时心跳及维护状态判定。本机缓存的 `train.nodes` 可供排障。
- 构建汇总带出 `precheckWarnings` 和 `precheckAdvice`。

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

- 封存舰队等服务端轮换，`ROLLOUT_SEALED_ROTATION` 携带尚待完成的节点。没有封存历史的舰队沿用先待命、后当班的升级顺序。
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

