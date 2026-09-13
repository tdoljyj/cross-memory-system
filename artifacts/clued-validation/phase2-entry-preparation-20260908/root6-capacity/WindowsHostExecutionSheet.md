# 那台 Windows 机器要跑的全部

**给操作那台机器的人。** 只有下面这些需要你。其余全部由实施方（Linux 会话）执行。

> **本文件的上一版把 13–16 也派给了这台机器，那是错的。** 那四步是数据库事务，经 Supabase MCP 从任何地方都能发 —— NW-01（第 9 步）就是这么跑的。运行手册里「第 13 步起必须全部在那台机器上」那句话与它自己上面那张表矛盾（表里写着「数据库事务 ✅（Supabase MCP）」），而它给的三条理由（控制器源文件含 Windows 路径、`gh.exe` 哈希、PowerShell 调 `node.exe`）**只约束「跑控制器」，不约束「发 SQL」**。已更正。

---

## 一、需要这台机器的，只有六项

| # | 做什么 | 为什么非这台机器不可 | 现在能做？ |
| --- | --- | --- | --- |
| **A** | 拉新代码 | 是 C 的前置 | ✅ **现在** |
| **B** | `npm ci` 装依赖 | 是 C 和 17–20 的前置 | ✅ **现在** |
| **C** | 宿主 manifest 复验 331/331 | 187 条运行时依赖是这台机器上的**本地文件**，别处读不到 | ✅ **现在** |
| **D** | `gh api` 取合并响应（5 条） | 实施方会话里没有 `gh` | ✅ **现在** |
| **17** | GA 签发 | `trusted-github.mjs:13` 每次 API 调用前哈希 `C:/Program Files/GitHub CLI/gh.exe` | ❌ 等前置 |
| **18–20** | 600 秒运行 → PQUAL 观测（20 项）→ GRR | `cli.mjs` 只接受 `tool-entry.functions.js` 经 PowerShell 启动，效果端经 `bridge.py` → `fixed_host.py` → Docker | ❌ 等 17 |

**A、B、C、D 四项现在就能全做完，互不依赖，做完一直有效。**
17–20 要等实施方那边把 13–16 走完，届时会另给投喂内容。

## 不需要这台机器的（实施方做，列出来是让你知道不用等）

| # | 谁做 |
| --- | --- |
| 13 `append_event` 注册 root6 | 实施方，Supabase MCP |
| 13b 量注册后的真实 root 摘要 | 实施方，只读 SQL |
| 13c CP-01 定稿 → 评审 → 应用 → 回读 | 实施方，SQL 事务 |
| 14 第二十次前推 | 实施方，SQL 事务 |
| 15 Status24 追加 | 实施方，SQL 事务 |
| 16 预算预留 | 实施方，SQL 事务 |
| 第二十次前推 `--replay` 自检 | **已完成** —— 实施方在 Linux 上跑通，`REPLAY_REPRODUCED_EXECUTED_NINETEENTH_COMPACT`，逐字节复现 `23cab111…`，exit 0 |

---

## 二、A / B / C / D —— 现在就做

### A. 拉新代码

```
cd <这台机器上的仓库检出>
git checkout main
git pull
```

拉到 `2c3a6f9` 或更新。

> **上一次宿主验证报 `DRIFT_DETECTED` 就是这一步没做。** 那 19 条不符全部是 `REPOSITORY_SOURCE`（仓库里的文件），是检出过期，不是真漂移。

### B. 装依赖 —— 必须 `npm ci`

```
cd apps\clued-cloud
npm ci
```

**不要用 `npm i ajv@6`：**它会改动 `package.json` 与 `package-lock.json` 两个受版本控制的文件，而且没必要 —— `ajv` 不是声明依赖，`HEAD` 版 lock 里 `packages["node_modules/ajv"].version` 已经是 `6.15.0`，`npm ci` 严格按 lock 装。
误用了就还原：`git checkout -- apps/clued-cloud/package.json apps/clued-cloud/package-lock.json`

**为什么盯 ajv 版本**：`root-window-validation.mjs` 要 Ajv 6。npm 默认解析给 ajv 8，对该 schema 直接报错；**更危险的是错版本下可能看起来通过却什么都不证明。**

### C. 宿主 manifest 复验

```
cd <仓库根>

node work\twentieth-forward\verify-manifest-against-host.mjs ^
  scripts\phase2-qualification\control-context-verifier-root6-window11-successor\ControllerSourceManifest.candidate.json ^
  --out HostVerification2.json --map C:/=C:/
```

**是 `--map C:/=C:/`，不是 `/=/`。** 187 条运行时依赖全部是 `C:/` 开头的盘符绝对路径；`from` 写 `/` 一条都匹配不上，会被判成「无法核验」而不是「通过」，看着像少了一半。（脚本头部原注释写错成 `/=/`，已修正。）

**要拿到：**

| 项 | 期望值 |
| --- | --- |
| 总计 | **331 / 331** |
| `verdict` | **`VERIFIED`** |
| `REPOSITORY_SOURCE` | 144 |
| `RUNTIME_DEPENDENCY` | 187 |
| `gh.exe` 单独一行 | 一致 |

**把 `HostVerification2.json` 发回。**

**为什么必须再验一次**：只有这 187 个文件会自己变，而上次测量是 09-08。`gh.exe`、`docker.exe` 自动更新，44 个 `.pyc` 在源文件 mtime 一动就重新生成。其中 `gh.exe` 最要命 —— `trusted-github.mjs:13` **每一次** API 调用前都重新哈希它，对不上就抛 `GITHUB_CLI_BYTES_DRIFT`，控制器一个调用都发不出去。

想先花 5 秒看那一个：

```powershell
Get-FileHash "C:\Program Files\GitHub CLI\gh.exe" -Algorithm SHA256
```

| 文件 | 字节数 | sha256 |
| --- | --- | --- |
| `gh.exe` | 41775416 | `e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3` |
| `node.exe` | 92825416 | `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237` |
| `docker.exe` | 43247024 | `00ffff945b67c65aae98dd980621a80ee135ed4e0931b33ca03687caee019713` |

### D. `gh api` 取合并 3 的响应

实施方会话里没有 `gh`。控制器要求 `verification.verified === true` 且 `reason === 'valid'`，**而实施方用的 MCP 客户端不返回 `verification` 字段** —— 这一条只能在这里补。

```
gh api repos/tdoljyj/cross-memory-system                                                        > repo.json
gh api repos/tdoljyj/cross-memory-system/commits/2c3a6f9d2c654614b0e5198658c8f03e32f36790       > commit.json
gh api repos/tdoljyj/cross-memory-system/commits/2c3a6f9d2c654614b0e5198658c8f03e32f36790/pulls > pulls.json
gh api repos/tdoljyj/cross-memory-system/pulls/161                                              > pr.json
gh api "repos/tdoljyj/cross-memory-system/git/trees/2c3a6f9d2c654614b0e5198658c8f03e32f36790?recursive=1" > tree.json
```

合成一个 `{repo, commit, pulls, pr, tree}` 的文件发回。

---

## 三、17–20 —— 等通知，届时另给

不是命令行子命令。`cli.mjs` 是 stdin 驱动的 JSON 协议，只接受 `tool-entry.functions.js` 那个固定可信入口启动，自带 600 秒看门狗（`setTimeout(…,600000)`）。

**第 19 步的正式执行命令目前在仓库里就是未定的。** `QualificationCases.json` 的 `formal_command` 字段原文：

> 「待确认：实际受权 controller 尚未存在；禁止把本地候选 CLI 换 mode 当正式执行。」

它要等 GA 真正签发、拿到受权运行通道之后才能确定。**不是没找到，是它本来就没有。**

另外两条要先说清楚：

- **观测是 20 项，不是 19 项。** 运行手册写「19 项」是把步骤号抄成了项数。`QualificationCases.json` 是 PQUAL-01 到 PQUAL-20，README 明写「P0 20 项不可删减」。
- **已有的 28/28 PASS 不能顶替。** 那是 `LOCAL_ENGINEERING_ONLY`，README 明写不签发资格；正式 20 项当前是 `NOT_EXECUTED`。

---

## 四、现在就做这四条

1. `git pull`
2. `cd apps\clued-cloud && npm ci`
3. 宿主复验 → `HostVerification2.json` 发回
4. 5 条 `gh api` → 合成一个 JSON 发回

**做完就一直有效，不会再让你重跑。** 17–20 会在实施方走完 13–16 之后另行通知。

---

**边界**：本文件不注册代际、不授权任何执行、不构成对第 13 步的放行。
