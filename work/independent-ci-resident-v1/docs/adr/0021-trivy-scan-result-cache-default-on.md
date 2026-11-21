# ADR 0021：trivy 扫描结果缓存默认打开

- 状态：生效（第 28 代，未安装）
- 日期：2026-11-08
- Owner Decision：M4 本身是 `9e2511fe` 第 5 项；在第 28 代打开 trivy 缓存由 Owner 批准（第 28 代任务）。
- 档案：冻结 DESIGN §68（M4，按代码树缓存扫描结果），其中 §68.4 原来写的是“字段缺失等于关”。
- 代码：`CI/worker/scan-result-cache-v1/cache.mjs#cacheSettings`、`DEFAULT_CACHE_ROOT`。
- 测试：`CI/test/scan-result-cache.test.mjs`。“policy switch off … no field at all is on (gen 28)” 一例在旧代码上失败。

## 背景

M4 的开关是 trivy 角色策略 `/etc/clued-independent-ci/roles-v3/trivy.json` 里的可选字段 `scanResultCache: {enabled, root}`。按 §68.4，字段缺失就等于关。逐处查了这个字段在哪里生成、在哪里安装：

| 环节 | 文件 | 写不写这个字段 |
|---|---|---|
| 打包时派生角色策略（原地升级） | `R/rollout/tools/roles-derived.py`：加载已装的冻结工具，调用它的 `derive_role` | 不写。`derive_role` 从**已装**策略复制，只换 `SOURCE_KEYS`，并要求 `set(new_policy) == set(policy)`（`POLICY_DIFF_OUTSIDE_SOURCE_BINDING`） |
| Linux 切代时写 roles-v3 | `R/linux/bin/clued-ci-upgrade-linux#stage`：同一个 `derive_role`，派生结果的哈希必须等于包里的 `rolesDerivedSha256` | 不写，规则同上 |
| roles 导出 | `R/src/roles-public.mjs`（companion 的 `roles-public.json`）、§57.7 的 root 导出 | 不写，只照原样复制当前生效的六个文件 |
| 首次安装、整套重装 | `R/reinstall/linux/first-install.py`、`R/reinstall/linux/tools/derive-roles.py`、`R/linux/bin/clued-ci-install-source-v2` | 不写 |
| Source 清单里的角色材料 | `CI/src/resident-v2/prepare-record.mjs#validateRoles`（`formalTrivy`） | 没有这个字段，而且开关也不从这里读 |

所以装好的 trivy 策略都没有这个字段，缓存一直是关的。原地升级通道又不允许任何一代往策略里加键：加键要改冻结的 `clued-ci-upgrade-linux`，那属于 R 类冻结通道，必须整套重装。另一种办法是 root 手工改 `trivy.json`，但这会让当前代的记录 `rec['roles'][trivy].policySha256` 对不上，`verify` 的 `checks.roles` 就会失败。

## 决定

`cacheSettings` 对 trivy 的判断改成：

| 角色策略 | 结果 |
|---|---|
| **没有 `scanResultCache` 字段** | **开**，根目录 `DEFAULT_CACHE_ROOT = /var/lib/clued-independent-ci/scan-result-cache`，就是 §68.4 建议的位置 |
| `{enabled: true, root}` | 开，用给出的 root（同以前） |
| `{enabled: false, root}` | 关。以后要关掉缓存就这样写 |
| 字段不合格、根目录与其它目录重叠 | 关（同以前）。默认根目录同样要过重叠检查 |

不变的部分：

- contract-placement 仍然关：`CACHE_HIT_ROLES = ['trivy']` 在读策略之前就把它挡掉，签名器和 Windows 签发方也拒收它的 `cacheHit`。
- gitleaks 仍然永远不缓存。
- 键、记录、签名核对、TTL、命中时照样准入、照样取扫描许可，全部按 §68 不变。

**根目录在受保护区。** 父目录是状态根 `/var/lib/clued-independent-ci`。它归 root 所有、组和其他用户不可写，每个角色的 `workspaceRoot` 都在它下面，`protectedPath` 逐级核对过。第一次写入时，缓存模块以 root 0700 创建 `scan-result-cache/` 和 `trivy/`，读写都经过三级 `protectedPath`（根目录、角色目录、0600 记录）。

缓存根不与下面这些重叠：

- `/var/lib/clued-independent-ci/workspaces`、`runs`；
- `/opt/clued-independent-ci/source-v2`；
- `/var/lib/docker`；
- trivy 漏洞库缓存 `/var/lib/clued-independent-ci-trivy-cache`；
- `/etc` 下的密钥与资格文件。

worker unit 的视图（§70.3）里，状态根是 `ReadWritePaths`，缓存根也不在 `InaccessiblePaths` 或 `TemporaryFileSystem` 里，所以 trivy worker 能读能写。归档与 §35 的回收不碰它。trivy 漏洞库缓存 `/var/lib/clued-independent-ci-trivy-cache` 不在状态根下，也不是 `ReadWritePaths` 的可选项：它由 worker unit 的 `StateDirectory=`（`StateDirectoryMode=0700`）在每次启动、`ExecStartPre` 之前以 root:root 创建并保持可写，任何安装路径都不建它；单元、常驻工具的 `TRIVY_CACHE` 与角色材料的 `cacheRoot` 三处同值由 `test/test_trivy_cache_root.py` 守住。

## 理由

- **这是新一代装好后就打开、又不动冻结通道的唯一办法。** 只改 Source：`cache.mjs` 本来就在 trivy 角色的 Source 文件里。每一代切代时，Linux 侧都会照常重新派生、重签三个角色的资格，这次没有额外的重签。
- **安全性与显式开启时相同。** 缓存只认用现有合格结果钥签过的真实成功观察，Windows 签发方再按自己的签名者表核一遍，命中时准入和扫描许可一步不省（§68.2–§68.6）。

## 后果

- **装好这一代以后 trivy 缓存是开的**，Owner 不需要额外操作。照常装这一代：打包、预检、一次 UAC 批准；Linux 三个角色在切代时自动重签，和每一代相同。装好后确认缓存生效：
  1. 第一次有 trivy 的批次结束后，root 下看 `/var/lib/clued-independent-ci/scan-result-cache/trivy/`，应该有一条 0600 记录，目录是 0700、归 root；
  2. 该批次运行目录的 `result-cache.json` 里 `enabled: true`，`result-cache-store.json` 的 `stored: true`；
  3. 同一棵树再跑一次（例如车头批次），`result-cache.json` 的 `lookup` 是 `SCAN_RESULT_CACHE_HIT`。
- **以后要关掉**：不能经原地升级加字段，原因见背景。可以选两种办法：
  - 发一代把 `DEFAULT_CACHE_ROOT` 的默认值改回关；
  - 整套重装时在 `trivy.json` 里写 `{enabled: false, root: …}`。

  无论哪种，直接删掉缓存目录都安全，之后只是未命中、照旧真跑。
- §68.4 的“新 Source 装上而策略不加这个字段时，行为与今天完全相同”从第 28 代起不再成立，以本文为准。
