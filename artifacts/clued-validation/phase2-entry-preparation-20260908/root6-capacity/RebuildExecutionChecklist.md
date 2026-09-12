# 重建执行清单

宿主丢失后把这件事做完，需要做什么、谁做、按什么顺序。

**前提（实测）**：一次性资源全部完好 —— `ctrgen_5e0440a9…` 未注册、600 秒分配未消耗（`charged_seconds` 9906/10506）、head 仍 root5、十五个函数零改动。**重建不需要花掉任何一次性资源。**

---

## 零、第一件事：找那两个文件 —— 这决定重建是小还是大

控制器启动时读两个文件，它们**从未进入版本控制**，随机器消失：

| 文件名 | 必须匹配的 sha256 |
| --- | --- |
| `Phase2BoundedRemainingQualificationApprovalProposal20260910.md` | `ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b` |
| `ActualTerminalFullObservation.json` | `022c01e16cb0a20e410e4c6d09fc41285c9713fa6524a820360941507c686829` |

原路径：
```
C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/Phase2Bounded…Proposal20260910.md
C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/c504-root3-schema-recovery/ActualTerminalFullObservation.json
```

**去哪找**：任何备份、OneDrive / 云同步、另一台机器上的 Codex 工作目录、旧的会话归档、回收站。
**找到就用上面的摘要验**（`Get-FileHash -Algorithm SHA256` 或 `sha256sum`）。摘要对上就是原件。

**为什么这一条排第一**：它们的**内容**被传进 `checkBoundedSeries`，不只是校验摘要，所以必须是原字节，不能重造。

| 结果 | 后果 |
| --- | --- |
| **找得回** | 走**路径 A（小重建）** —— 控制器源码只改宿主路径 |
| **找不回** | 走**路径 B（大重建）** —— 必须改掉 `context.mjs:246-247` 的读取，那就是一个新控制器，整条资格链重走 |

---

## 一、宿主要求（两条路径都要）

| 要求 | 为什么 | 本会话容器 |
| --- | --- | --- |
| **Docker 守护进程可用** | 600 秒运行是 Docker 容器（`parent600.py:fixed_argv` 每次以 `[DOCKER, --host=…]` 开头） | ❌ **守护进程连不上** |
| **持久** | manifest 钉宿主本地文件；宿主消失则资格作废 | ❌ 容器会被回收 |
| Node | 控制器 | ✅ v22.22.2 |
| Python | `bridge.py` / `fixed_host.py` | ⚠️ 3.11.15（控制器钉 3.12，新 manifest 可改钉 3.11） |
| `gh` 或等价 | `trusted-github.mjs` | ❌ 不存在 |

**结论：本会话容器当不了宿主。** 缺 Docker 守护进程 + 不持久，这两条都是硬伤。

**你需要一台**：能跑 Docker、装了 Node 与 Python、能装 `gh`、且**会一直在**的机器。Windows / Linux / mac 都行 —— 新 manifest 按新宿主重新采集，不必是 Windows。

---

## 二、路径 A（那两份文件找回来了）

| # | 做什么 | 谁 |
| --- | --- | --- |
| A1 | 把那两份文件放进新宿主，并**提交进仓库**（这次别再让它们只存在于本地） | 你 + 我 |
| A2 | 改 `context.mjs:246-247` 为仓库相对路径；改 `host-effect.mjs`、`trusted-github.mjs`、`fixed_host.py`、`parent600.py`、`tool-entry.functions.js` 里的宿主路径 | 我 |
| A3 | 在新宿主上重新采集 331 条 manifest（187 条运行时依赖按新宿主实测） | 你跑一条命令，我出命令 |
| A4 | **新控制器资格化**：`ScopedControllerQualification` + 运行时受理 | **独立评估者**（我不能写） |
| A5 | 据新控制器摘要重签下游七份文档 + CP-01 的 A1/A2 两处 schema 钉 | 我 |
| A6 | Owner 合并（资格 + 重签件） | 你 |
| A7 | 新 Owner 窗口 → 重跑 NW-01 | 你合并 + 我执行 |
| A8 | 回到第 13 步 | 见第四节 |

---

## 三、路径 B（找不回）

同上，但 A2 变成：**删掉 `context.mjs` 对这两个文件的读取，并重新定义 `checkBoundedSeries` 在缺少它们时的行为。**

这不是改路径，是**改判定逻辑**。后果：

- 它成为一个**语义上的新控制器**，不是同一个控制器换宿主；
- A4 的资格化要重新论证「去掉这两份输入之后，边界系列检查还成立吗」——**这需要独立评估者从头审，不是走过场**；
- 可能需要 Owner 重新批准范围（原批准是针对含那两份输入的控制器给的）。

**量级：路径 A 是几天，路径 B 是重走大部分论证。**

---

## 四、第 13 步之后（两条路径共用，已按你的裁定与第十三轮结论更新）

```
13   append_event 注册 root6                     ← 不可回退
13b  measure-root6-root-digest.sql 量实测 root 摘要
13c  CP-01 定稿（钉实测值）→ 独立评审 → 应用 → 回读
13d  【评估者】CP-01 应用后的独立受理（含 observed_postimage）
13e  【我】Status24 签署主体
13f  【评估者】Status24 受理，钉 13d
13g  【你】Owner 合并（13d + 13f）
14   第二十次前推：--replay → --dry-run → 真跑    ← 不可回退
15   Status24 追加
16   预算预留                                     ← 不可回退，最后再做
17   GA 签发
18   600 秒运行
19   PQUAL 观测 **20 项**（不是 19）
20   GRR
```

**第 16 步永远排在能确认 17–20 走得通之后。** 预留了跑不了，那一次分配就没了。

**第 19 步的正式执行命令目前仓库里标为「待确认」**（`QualificationCases.json` 的 `formal_command`），要等 GA 真签发拿到受权通道才能定。

---

## 五、我现在就做、不等任何人的

| # | 状态 |
| --- | --- |
| **修 R13-F3** | ✅ **已完成** —— `signature_evidence_ref` 改指 `OwnerApprovalVerification.json`（blob `cad73582…` / sha256 `69e84e74…`）。四个维度我自己量过：合并 sha、窗口两端、批准件 blob、批准件 sha256，全部与注册体对齐。三条不变量保持：`reviewSubjectDigest` 仍 `293da3c5…`（**第十二轮受理不失效**）、`signed_object_sha256` 仍 `95973246…`、`validateRootShape` 仍 `SHAPE_VALID_ONLY` |
| CP-01 钉实测值改造 | ✅ 已完成 |
| R11-F13 触发器守卫 | ✅ 已完成（并修掉它自身的 42725 解析缺陷） |
| 第二十次前推 `--replay` | ✅ 已在 Linux 跑通，逐字节复现 |
| Status24 签署主体 | 进行中 |
| CP-01 窗口字面量参数化 | 待做（新窗口只需改一个值） |
| 第 20 次前推 `input.json` 预备 | 待做（除 CP-01 后摘要外可全备齐） |

---

## 六、现在最该做的一件事

**去找那两个文件。** 它决定路径 A 还是 B，而 A 和 B 的差距是「几天」和「重走大部分论证」。

在你找的同时，我把第五节剩下三项做完。

---

**边界**：本文件不注册代际、不消耗预算、不构成授权。
