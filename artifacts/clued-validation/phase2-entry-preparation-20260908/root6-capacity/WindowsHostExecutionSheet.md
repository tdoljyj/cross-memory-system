# 那台 Windows 机器要跑的全部

**给 Owner（`tdoljyj`）。一份汇总，不再分批。**

本文件列出**从现在到全流程结束、那台机器上要执行的每一件事**：跑什么、怎么跑、要什么结果、哪些输入还没有以及由谁产出。凡我还给不出确切命令的，**在第六节逐条列明原因**，不藏在正文里让你到时候才发现。

写作时刻实测：`charged_seconds` 9906 / 10506、`sequence` 88、head 仍 root5、窗口 `2026-09-12T07:05:16Z .. 2026-09-13T07:05:16Z`。

---

## 零、为什么非那台机器不可

硬约束，不是习惯：

| 约束 | 出处 |
| --- | --- |
| 控制器 7 个源文件写死 Windows 绝对路径 | `context.mjs` / `trusted-github.mjs` / `host-effect.mjs` 等 |
| 每次 GitHub API 调用前重新哈希 `C:/Program Files/GitHub CLI/gh.exe` | `trusted-github.mjs:13` |
| 经 PowerShell 调 `C:/Program Files/nodejs/node.exe` | `tool-entry.functions.js` |
| 效果端经 `C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe` 调 `bridge.py` | `host-effect.mjs:6` |
| `cli.mjs` 只接受那个固定可信入口启动，自带 **600 秒**看门狗 | `cli.mjs:9`（`setTimeout(…,600000)`） |

**第 13 步起全部在那台机器上。** 数据库事务本身我这边也能发，但发完要控制器验，控制器只在那里。

---

## 一、全部清单（一张表看完）

| # | 在那台机器上做什么 | 你要敲的东西 | 现在能做？ | 可逆？ |
| --- | --- | --- | --- | --- |
| A | 拉新代码 | `git pull` | ✅ **现在** | 是 |
| B | 装依赖（ajv 必须 6.15.0） | `npm ci` | ✅ **现在** | 是 |
| C | 宿主 manifest 复验 331/331 | 一条 node 命令 | ✅ **现在** | 只读 |
| D | `gh api` 取合并响应（每次 Owner 合并后） | 5 条 `gh api` | ✅ 已有合并可先跑 | 只读 |
| E | 第二十次前推 `--replay` 自检 | 一条 node 命令 | ✅ **现在** | 只读 |
| 13 | `append_event` 注册 root6 | 一条 SQL | ❌ 等评审 | **否** |
| 13b | 量注册后的真实 root 摘要 | 一条只读 SQL | ❌ 等 13 | 只读 |
| 13c | CP-01 定稿 → 评审 → 应用 → 回读 | 一个 SQL 事务 | ❌ 等 13b | 函数可改回 |
| 14 | 第二十次前推：dry-run → 真跑 | 两条 node + 一个事务 | ❌ 等 13c | **否** |
| 15 | Status24 追加 | 一个事务 | ❌ 五项钉未填 | 否 |
| 16 | 预算预留（唯一一次） | 一个事务 | ❌ 等 14/15 | **否** |
| 17 | GA 签发 | 控制器 dispatch | ❌ 等 16 | 否 |
| 18 | **600 秒运行** | 控制器 dispatch | ❌ 等 17 | 否 |
| 19 | **PQUAL 观测（20 项，不是 19）** | **命令未定，见第六节** | ❌ | — |
| 20 | GRR 收口 | 控制器 result-terminal | ❌ 等 19 | — |

**A–E 五项现在就能全做完，互不依赖，做完了就一直有效。**

---

## 二、A / B / C —— 现在就做

### A. 拉新代码

```
cd <那台机器上的仓库检出>
git checkout main
git pull
```

拉到 `2c3a6f9`（Owner 合并 3）或更新。

> **上一次宿主验证报 `DRIFT_DETECTED` 就是这一步没做。** 那 19 条不符全部是 `REPOSITORY_SOURCE`，是检出过期，不是真漂移。

### B. 装依赖 —— 必须 `npm ci`

```
cd apps\clued-cloud
npm ci
```

**不要用 `npm i ajv@6`：**

1. 它会改动 `package.json` 与 `package-lock.json` 两个受版本控制的文件；
2. 没必要 —— `ajv` 不是声明依赖，是提升上来的传递依赖，`HEAD` 版 lock 里 `packages["node_modules/ajv"].version` **已经是 `6.15.0`**。`npm ci` 严格按 lock 装。

误用了就还原：`git checkout -- apps/clued-cloud/package.json apps/clued-cloud/package-lock.json`

**为什么盯 ajv 版本**：`root-window-validation.mjs` 要 Ajv 6。npm 默认解析给 ajv 8，对该 schema 直接报错；**更危险的是错版本下可能看起来通过却什么都不证明。**

### C. 宿主 manifest 复验（第 13 步的前置闸门）

```
cd <仓库根>

node work\twentieth-forward\verify-manifest-against-host.mjs ^
  scripts\phase2-qualification\control-context-verifier-root6-window11-successor\ControllerSourceManifest.candidate.json ^
  --out HostVerification2.json --map C:/=C:/
```

**是 `--map C:/=C:/`，不是 `/=/`。** 187 条运行时依赖**全部**是 `C:/` 开头的盘符绝对路径；`from` 写 `/` 一条都匹配不上，会被判成「无法核验」而不是「通过」，看着像少了一半。（我脚本头部原注释写错成 `/=/`，已修正。）

**要拿到：**

| 项 | 期望值 |
| --- | --- |
| 总计 | **331 / 331** |
| `verdict` | **`VERIFIED`** |
| `REPOSITORY_SOURCE` | 144 |
| `RUNTIME_DEPENDENCY` | 187 |
| `gh.exe` 单独一行 | 一致 |

**把 `HostVerification2.json` 发我。**

想先 5 秒看最要命的那个：

```powershell
Get-FileHash "C:\Program Files\GitHub CLI\gh.exe" -Algorithm SHA256
```

| 文件 | 字节数 | sha256 |
| --- | --- | --- |
| `gh.exe` | 41775416 | `e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3` |
| `node.exe` | 92825416 | `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237` |
| `docker.exe` | 43247024 | `00ffff945b67c65aae98dd980621a80ee135ed4e0931b33ca03687caee019713` |

`gh.exe` 对不上，**控制器一次 API 调用都发不出去**（`GITHUB_CLI_BYTES_DRIFT`）。上次测量是 09-08，GitHub CLI 自动更新 —— 这就是必须再验一次的全部理由。

---

## 三、D —— `gh api` 取证（本会话拿不到）

我这个环境没有 `gh`，而 `capture-owner-merge.mjs` 的输入必须是真实 API 响应。每次 Owner 合并之后，在那台机器上：

```
gh api repos/tdoljyj/cross-memory-system                                > repo.json
gh api repos/tdoljyj/cross-memory-system/commits/<SHA>                  > commit.json
gh api repos/tdoljyj/cross-memory-system/commits/<SHA>/pulls            > pulls.json
gh api repos/tdoljyj/cross-memory-system/pulls/<N>                      > pr.json
gh api "repos/tdoljyj/cross-memory-system/git/trees/<TREE>?recursive=1" > tree.json
```

合成一个 `{repo, commit, pulls, pr, tree}` 的文件发我。

**合并 3（`2c3a6f9d2c654614b0e5198658c8f03e32f36790`，PR #161）现在就可以取。** 我用 MCP 查过它的 `committer.login=web-flow`、2 个父、`merged_by=tdoljyj`，**但那个工具不返回 `verification` 字段** —— 控制器要求 `verification.verified===true` 且 `reason==='valid'`，**这一条我没看到，只能靠 `gh api` 补。**

---

## 四、E —— 第二十次前推的自检（只读，现在就能跑）

```
node work\twentieth-forward\twentieth-forward-compact.mjs <第19次的输入.json> --replay
```

喂它第十九次前推自己的输入，输出必须与实际执行过的 `ActualNineteenthForward.executed-compact.sql` **逐字节相同**。这一步不写库，现在跑掉，等到第 14 步就不用在不可回退区里第一次发现问题。

---

## 五、13–20：不可回退区

### 三处真正不可回退

| 步骤 | 为什么 |
| --- | --- |
| **13 注册 root6** | `events` 只追加；`append_event` **不校验 body**（`:13` 只查是不是 JSON 对象）；`:36` 禁止重复注册同一代际。**写错则库收下、控制器拒绝、`ctrgen_5e0440a95ac8ee257b9e4236cabd275b` 永久报废，没有第二个。** |
| **14 第二十次前推** | 追加 `execution_events`、CAS 改 sequence、替换 `SECURITY DEFINER` 函数 |
| **16 预算预留** | 一次性。`charged_seconds` 上界 10506 **恰好等于**用完后的值，**没有余量** |

### 顺序（已按你的裁定：CP-01 在注册之后）

**13** `append_event` 注册 root6 —— 注册体已建好并已推送：
`artifacts/.../bootstrap/next-window-20260912/root6-registration/Root6GenerationRegistration.candidate.json`
其评审主体摘要 `293da3c5…` 与第十二轮受理一致。**等第十三轮放行。**

**13b** 一条只读 SQL 量出注册后的真实 root 摘要（我给）。

**13c** CP-01 定稿 —— 把 13b 量到的**实测**值钉进 G8/B9，独立评审，应用，回读。
这是你裁定次序调换换来的：CP-01 钉实测值而非投影值，「投影 ≠ 实测」那一整类失效消失。

**14** 第二十次前推：

```
node work\twentieth-forward\twentieth-forward-compact.mjs input.json --dry-run --out-sql dry.sql
node work\twentieth-forward\twentieth-forward-compact.mjs input.json --out-sql real.sql
```

先 dry-run 走完全流程再 rollback，不留痕；确认后才跑真的。
**`input.json` 里 `control_plane` 的三个摘要是 CP-01 之后的值，13c 之前不存在。**

**15** Status24 追加 —— **受理还有五项待定钉未填。**

**16** 预算预留 —— 真实截止 = `T+24h` 减 600 秒，即 **`2026-09-13T06:55:16Z`**。

**17–20** GA 签发 → 600 秒运行 → PQUAL 观测 → GRR。
这四步**不是命令行子命令**：`cli.mjs` 是 stdin 驱动的 JSON 协议，只接受 `tool-entry.functions.js` 那个固定可信入口启动，效果端再经 `bridge.py` → `fixed_host.py` → Docker，且有独立看门狗进程。**具体投喂内容见第六节 —— 有一条现在还是未定状态。**

---

## 六、还没有确切命令的，全在这里

**这一节是本文件的重点。** 我不想到时候再冒出来一条「还得跑这个」。

| # | 缺什么 | 为什么现在给不了 | 谁产出 |
| --- | --- | --- | --- |
| 1 | **第 19 步 PQUAL 的正式执行命令** | `QualificationCases.json` 的 `formal_command` 字段**原文是**：「待确认：实际受权 controller 尚未存在；禁止把本地候选 CLI 换 mode 当正式执行。」**仓库里就没有这条命令。** 它要等 GA 真正签发、拿到受权运行通道之后才能确定 | 需要在 17 之后确定，我会给 |
| 2 | 第 13 步的 SQL | 等第十三轮独立评审放行 | 我，评审通过即给 |
| 3 | 13b / 13c 的 SQL | 13b 要等 13 完成；13c 要等 13b 的实测值 | 我 |
| 4 | 第 14 步 `input.json` 的 `control_plane` 三摘要 | 是 CP-01 **之后**的函数摘要，CP-01 没应用就不存在 | 我，13c 之后 |
| 5 | Status24 的五项待定钉 | 交付件 F 已签发，五项待填并逐项复核 | 我 |
| 6 | v3 继承否定钉（「不得绑定 `d0649465…`」） | 待重签时写入 | 我 |
| 7 | 第 17 步 GA 的 `target_revision` | = 运行时受理的那次合并，届时才确定 | 我 |

### 另外两条我要更正的

**（一）观测是 20 项，不是 19 项。**
运行手册写「19 项 PQUAL 观测」—— 那是把**步骤号 19** 抄成了项数。
`QualificationCases.json` 是 **PQUAL-01 至 PQUAL-20，20 项**，其 README 明写「**P0 20 项不可删减**」，且「部分本地探针同时覆盖多个源场景的局部边界，不代表对应正式场景已经通过；无凭证、无调用或纯静态推导均不得计为实际资格 Evidence」。
**按 20 项准备。** 我会去更正运行手册。

**（二）已有的 28/28 本地验证不能顶替正式观测。**
`IndependentVerification.json` 那 28/28 PASS 是 `LOCAL_ENGINEERING_ONLY`，README 明写它不签发资格。正式 20 项当前是 `NOT_EXECUTED`。**准备阶段的复核不得计入那 20 项。**

---

## 七、现在的闸门状态

| 闸门 | 状态 |
| --- | --- |
| 第十三轮独立评审（最终注册体） | **进行中** `session_01LtnrmHumthYz7ig86LpJv7` |
| 宿主 331/331 复验 | **等你跑（第二节 C）** |
| 合并 3 的 `verification` 字段 | **等你 `gh api`（第三节）** |
| CP-01 | DRAFT，占位符要等注册后才能填 |
| Status24 五项待定钉 | 未填 |
| v3 继承否定钉 | 未写入 |
| PQUAL 正式命令 | **仓库里标为「待确认」** |

窗口 `2026-09-13T07:05:16Z` 关闭。窗口内做不完，你可以再开一个窗口（那是可逆的）；**`SECURITY DEFINER` 函数改坏了不能回退，代际 id 烧掉了没有第二个。**

---

## 八、你现在做这四条，一次做完

1. `git pull`
2. `cd apps\clued-cloud && npm ci`
3. 宿主复验 → `HostVerification2.json` 发我
4. 合并 3 的 5 条 `gh api` → 合成一个 JSON 发我

**这四条互不依赖，做完就一直有效，不会再让你重跑。**

---

**边界**：本文件不注册代际、不授权任何执行、不构成对第 13 步的放行。它只描述那台机器上要做什么。
