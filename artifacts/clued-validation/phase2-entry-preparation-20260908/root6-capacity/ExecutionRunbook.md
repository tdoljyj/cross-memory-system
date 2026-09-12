# 执行手册：从 Owner 第一次合并到 GRR

**状态：`RUNBOOK_NOTHING_EXECUTED`。**

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506，那唯一一次分配未消耗。**

本文件把散落在补遗 A/B/C 与 `work/twentieth-forward/` 里的准备工作整合成一条可执行路径。
它**不是授权**。第九轮已改判「候选 SQL 可以开始写」，但**执行**仍受第六节五项前置约束。

---

## 一、在哪台机器上做什么

| | 本会话 / 任何 Linux checkout | **那台 Windows 机器** |
| --- | --- | --- |
| 构建、重签、校验、生成候选 | ✅ | ✅ |
| 主机 manifest 复验（142 条） | ❌ | **仅此处** |
| `gh api` 取合并响应 | ❌（本会话无 gh） | ✅ |
| 跑控制器 `cli.mjs` | ❌ | **仅此处** |
| 数据库事务 | ✅（Supabase MCP） | ✅ |
| 600 秒运行、19 项观测、GRR | ❌ | **仅此处** |

控制器 7 个源文件含 Windows 绝对路径，`trusted-github.mjs:13` 每次 API 调用前校验
`C:/Program Files/GitHub CLI/gh.exe` 的 sha256，`tool-entry.functions.js` 经 PowerShell 调
`C:/Program Files/nodejs/node.exe`。**第 13 步起必须全部在那台机器上。**

## 二、脚本清单（`work/twentieth-forward/`）

| 脚本 | 作用 | 自检锚点 |
| --- | --- | --- |
| `verify-manifest-against-host.mjs` | manifest 对盘复验，两处可用 | 本环境 189/331 已过；142 条待主机 |
| `capture-owner-merge.mjs` | 合并 → 证据文件（stage 0 / 2） | PR #149 复现历史证据（我比 29 项，评估者比到 **43** 项，R9-F4） |
| `rebuild-controller-window11.mjs` | 重建控制器，`root6Expiry` 参数化 | encoder 逐字节复现前代 manifest |
| `reissue-seven-documents.mjs` | 七份文档重签 + 版本链推进 | 序列化形式对盘断言 |
| `reissue-continuation-subject.mjs` | subject 三件套换发 | 两个序列化器逐字节复现前代 |
| `selftest-reproduce-nineteenth.mjs` | 前推构造器活库锚定自检 | 复现活库 `c721b056`（107,827 字符） |
| `derive-getter-module.mjs` | 派生 `<20` 版 getter 模块 | 仅 2 字符差异，两模块输出相同 |
| `twentieth-forward-compact.mjs` | 第 20 次前推事务 | 回放逐字节复现执行过的第 19 次 |
| `build-root6-registration.mjs` | root6 注册体 | 复现 5 个历史 `prefix_digest`；**成功路径已由第九轮评估者跑通**，并借此发现 R9-F1 |
| `exact-getter-root6-window11.candidate.mjs` | 派生产物，被上面两个 import | — |

**跑任何脚本前先确认 ajv 版本**：`root-window-validation.mjs` 要 Ajv6。

```
cd apps/clued-cloud && npm ci        # ← 不要用 npm i ajv@6
```

**`npm i ajv@6` 会改动 `package.json` 与 `package-lock.json` 两个受版本控制的文件，而且没必要**
（R9-F7）：`ajv` 不是 `apps/clued-cloud` 的声明依赖，只是传递依赖提升上来的，
而 `HEAD` 版 lock 里 `packages["node_modules/ajv"].version` **已经是 `6.15.0`**——
`npm ci` 严格按 lock 安装，装出来就是对的版本，且不碰任何受版本控制的文件。
若已误用 `npm i`，用 `git checkout -- apps/clued-cloud/package.json apps/clued-cloud/package-lock.json` 还原。

装好后跑 `verify-manifest-against-host.mjs`，manifest 钉住的 41 个 ajv 文件必须 41/41 一致。
npm 默认解析会给 ajv 8，对该 schema 直接报错；**更危险的是错版本下可能看起来通过却什么都不证明。**

## 三、执行顺序

### 第 0 阶段：前置（无时限，全部可在合并前完成）

```
0a  在 Windows 上：node verify-manifest-against-host.mjs <manifest> --map C:/=C:/ --out HostVerification.json
    → 331/331 必须全过。任何漂移都停下，见补遗《ControllerDigestDependsOnUnverifiedHost》第五节。
    → gh.exe 若漂移，控制器一个 API 调用都发不出去，必须先解决。
0b  第九轮独立评审 —— 已通过（`96dd5e5`）
0c  Status24 签署主体受理 —— 已签发（交付件 F），五项待定钉需填齐并逐项复核
```

### 第 1 阶段：Owner 第一次合并 —— 定窗口

```
1   Owner 经 web-flow 合并 bootstrap/next-window-20260912/
      {OwnerApprovalProposal.md, ExplicitOwnerApproval.candidate.json}
    → commit C₁，其 committed_at 即窗口 not_before = T
2   在 Windows 上 gh api 取五份响应，合成 bundle：
      node capture-owner-merge.mjs bundle.json --as approval \
        --artifacts "<proposal>,<approval>" --out <NEXT>/OwnerApprovalVerification.json
```

**T+24h 从此刻起算。以下全部要在这 24 小时内完成。**

### 第 2 阶段：重建与换发（不写库）

```
3   node rebuild-controller-window11.mjs <T+24h>
    → control-context-verifier-root6-window11-successor/，报告 new_controller_sha256
4   node reissue-seven-documents.mjs <T> <T+24h> <new_controller_sha256>
    → 七份重签，QUAL/RTA 移入 bootstrap/root6-runtime-v18/
5   构造 baseline.json（实测值）后：
      node reissue-continuation-subject.mjs baseline.json
    → subject 三件套
```

### 第 3 阶段：Owner 第二次合并 —— 签 subject 与控制器

```
6   Owner 合并第 3–5 步的十件 → commit C₂
7   node capture-owner-merge.mjs bundle2.json --as signature \
      --artifacts "<subject>,<regAcc>,<storeAcc>" --out <NEXT>/ContinuationSubjectSignatureEvidence.json
```

### 第 4 阶段：两个数据库事务

```
8   NW-01：停触发器 → 落三条 CHECK → 改七字段 → 以新值建回 → 恢复触发器 → 回读
      前置守卫按补遗 B §1.1（三条 CHECK 定义 + 触发器 tgenabled 与定义 + owner/ACL
      + R9-F6 追加的约束条数 16 与 conname 排序摘要），回读时同样断言
9   CP-01：三个函数 19 处编辑，前置守卫四个 prosrc，回读
      ※ 候选 SQL 可以开写（第九轮放行）；窗口时刻留具名占位符；写成后必须再经独立评审
```

**顺序不可颠倒**：`append_event` 受 `accepted_binding` 窗口管辖，让旧窗口过期就等于失去注册所需的调用。

### 第 5 阶段：Owner 第三次合并 —— 注册体

```
10  重新导出 read_root（metadata_binding_sha256 已被 NW-01 改变）
11  node build-root6-registration.mjs snapshot.json <T> <T+24h> <C₂> <6 个 blob/sha 参数>
    → 自检复现 5 个历史 prefix_digest，离线跑通 validateRootShape
12  Owner 合并注册体（+ Status24 受理，同批）→ commit C₃
```

### 第 6 阶段：不可回退区

```
13  append_event 注册 root6                      ← 不可回退
14  第 20 次前推：
      node twentieth-forward-compact.mjs input.json --dry-run --out-sql dry.sql   ← 先跑，rollback，不留痕
      node twentieth-forward-compact.mjs input.json --out-sql real.sql            ← 确认后
15  Status24 追加
16  预算预留（唯一一次，不得重试）               ← 真实截止 T+24h 减 600 秒
17  GA 签发（target_revision = 运行时受理的合并）
18  600 秒运行
19  19 项 PQUAL 观测
20  GRR
```

## 四、不可回退的三处

| 步骤 | 为什么 | 缓解 |
| --- | --- | --- |
| **13 注册 root6** | `events` 只追加；`append_event` **不校验 body**（`:13` 只查是 JSON 对象）；`:36` 禁止重复注册同一代际。写错则库收下、控制器拒绝、`ctrgen_5e0440a9…` 报废 | 第 11 步离线跑通 `validateRootShape`；独立评审 |
| **14 前推** | 追加 `execution_events`、CAS 改 sequence、替换 `SECURITY DEFINER` 函数 | `--dry-run` 全流程排练后 rollback |
| **16 预算** | 一次性，`charged_seconds` 上界 10506 恰好等于用完后的值，没有余量 | 前面全部就绪再做 |

第 8–12 步**可回退且窗口宽裕**：NW-01 之后窗口是 T+24h，函数可 `CREATE OR REPLACE` 改回。
**留在旧窗口里才是危险的**——任何一步失败一旦跨过 `13:14:51Z`，`read_root` 立即
`EXPIRED_OR_NOT_YET_VALID`，连修复所需的函数都不能用。

## 五、时钟

当前 `accepted_binding` 窗口 `2026-09-11T13:14:51Z .. 2026-09-12T13:14:51Z`。
**旧窗口过期不影响本计划**——第 1 阶段重开一个新的 24 小时窗口，
NW-01 之前不需要 `append_event`。所以**不要为了赶今天 13:04:51Z 而跳过任何前置**。

## 六、第九轮之后的状态

第九轮（`SuccessorReviewerRound9.md`，评估者分支 `claude/trusting-keller-mm2s0v` `96dd5e5`）
**改判：候选 SQL 可以开始写。** 第八轮四件缺件全部关闭。开写时两条约束：
窗口时刻一律留具名占位符，不得写入任何猜测的时间戳（五处）；
候选 SQL 写成后**必须再经独立评审才能执行**。

### 执行之前必须闭合的五项（不阻断开写，阻断执行）

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | **R9-F1**：`build-root6-registration.mjs` 的 predecessor 自检比较器 | **已修**（键序无关比较）；仍须用 NW-01 之后重新导出的快照重跑至 exit 0 |
| 2 | **R9-F2**：`forward_cap_extension` 只覆盖数据库侧 | **已补**（`repository_side` + `covers_both_sides` + `supersedes` + `independent_opinion_ref`） |
| 3 | **主机 331/331 复验** | 待那台 Windows 机器。**两次**：第二次合并前 + 第 13 步前；`gh.exe` 单独确认 |
| 4 | **Status24 受理的五项待定钉** | 交付件 F 已签发，五项待填并逐项复核 |
| 5 | **v3 继承否定钉** | 待重签时写入「不得绑定 `d0649465…`」 |

另：CP-01 候选 SQL 可以开写（本节第一段），写成后送独立评审。

## 七、治理

本次资格运行的强制层——`clued_control` 的 `SECURITY DEFINER` 函数、
`accepted_binding` 的约束与不可变触发器——在运行前由**被资格审查的一方**修改。
此前另有一次同类修改（2026-09-11）无 PR、无独立评审、且未经迁移表记录。
**GRR 必须写明这一点**，措辞见 `SuccessorReviewerRound8.md` 第五节
——该文件**不在本分支**，在继任评估者的分支 `claude/trusting-keller-mm2s0v`
（连同 `SuccessorReviewerRound8AddendumA.md`）。两份都是本轮的关键证据，
执行前应一并取到手边；实施方未将其搬入本分支，以免改变其归属。

第九轮按其所得**追加两句，同样必须写进 GRR**：

> 本次运行对「Owner 已批准」这一事实的验证，是对 GitHub API `verification.verified`
> 与 `reason: 'valid'` 的转述。`capture-owner-merge.mjs` 与控制器 `trusted-github.mjs:39`
> 都只检查 `signature` 与 `payload` **存在**，均未验证 payload 与 commit 的对应关系，
> 也未验证签名本身。整个 24 小时窗口的起点是该 API 报告的一个 `committed_at` 字段。
>
> 控制器摘要即其 manifest 摘要，其中 187 条（200,048,638 字节）是单台 Windows 主机上的本地文件。
> 若这些文件未在运行前后经过复验，本次 GRR 对控制器身份的断言只在
> 「那台机器上的那 200 MB 未变」这一未经验证的假设下成立。

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件是操作次序的整理，不接受任何对象、不签发任何资格、不构成授权，
也不解除第六节任何一项前置条件。
