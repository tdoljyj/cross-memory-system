# 终局记录：资格宿主永久丢失，本轮运行无法完成

**状态：`TERMINAL_NO_WRITE_PERFORMED`。**

Owner 于 `2026-09-12` 告知：承载控制器的那台 Windows 机器**彻底不可用**，非暂时性。

**未注册任何代际。未消耗那唯一一次 600 秒分配。`charged_seconds` 仍 9906 / 10506。head 仍 root5。**

---

## 一、结论

**第 17–20 步（GA 签发 → 600 秒运行 → 20 项 PQUAL 观测 → GRR）无法执行，且在当前材料下没有替代路径。因此本轮资格运行不能完成。**

这不是「困难」，是**结构性不可能**。下面是实测依据，不是推断。

---

## 二、为什么不可能 —— 九处硬绑定

【实测】`grep "C:/"` 控制器七个源文件：

| 位置 | 绑定的东西 |
| --- | --- |
| `context.mjs:246` | `C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/Phase2BoundedRemainingQualificationApprovalProposal20260910.md` |
| `context.mjs:247` | `C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/c504-root3-schema-recovery/ActualTerminalFullObservation.json` |
| `host-effect.mjs:6` | `C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe` |
| `host-effect.mjs:11` | 固定环境：`C:/Windows`、`C:/Users/Windows/AppData/Local/Temp` |
| `trusted-github.mjs:5` | `C:/Program Files/GitHub CLI/gh.exe` |
| `tool-entry.functions.js:39` | 工作目录 `C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo`；并哈希 `C:/Program Files/nodejs/node.exe` |
| `fixed_host.py:40` | 同一个 `python.exe` |
| `fixed_host.py:70` | `C:/Users/Windows/.codex/skills/clued` |
| `parent600.py:39` | `C:/Program Files/Docker/Docker/resources/bin/docker.exe` |

### 致命的是前两行

`context.mjs` 启动时要读那两个文件。【实测】：

- 二者**都不在本仓库**；
- 二者**都不在 manifest 的 331 条里**；
- 【实测】`git log --all --name-only` 全历史检索，**两个文件名各 0 次命中** —— 它们从未进入过版本控制。

**推论：它们只存在于那台机器的 `Documents/Codex/` 下，随机器一同消失。**

**所以即便找到一台配置完全相同的 Windows、并逐字节复制控制器，控制器也起不来** —— 缺的不是环境，是两份从未备份过的输入。

### 而控制器改不得

控制器的摘要**就是** manifest 摘要。改一个字节，下列全部失效：

- `ScopedRoot5FinalControllerQualification`（钉 `controller_digest`）
- `ExactRoot5FinalPreentryControllerRuntimeAcceptance`（钉 `controller_digest`）
- 据此重签的七份文档
- CP-01 的 A1 / A2 两处编辑（钉的正是本控制器携带的 schema 摘要 `510f3b90…`）

**把它改成能在别处跑，等于把十二轮独立评审建立起来的整条信任链作废。** 那不是修复，是把这件事本身取消掉。

---

## 三、停在这里是对的 —— 而且有两条独立理由

### 理由一：宿主丢失（本文件）

### 理由二：第十三轮独立评审**驳回了注册体**

【实测】评估者分支 `claude/trusting-keller-mm2s0v` `1e8543f7`，`SuccessorReviewerRound13.md`：

> **阻断项一条，R13-F3：`signature_binding.signature_evidence_ref` 指向了一份不证明本代签名的文件。**

它指向 `ContinuationSubjectSignatureEvidence.json`，而那份文件：

- 证明的是 **Owner 合并 2**（`3887b9e0…`），同一个 `signature_binding` 里的 `owner_merge_commit` 却是**合并 1**（`cbe898d3…`）；
- 自述 `kind = EXACT_NW01_CONTINUATION_SUBJECT_SIGNATURE_EVIDENCE` —— NW-01 续延主体的签名证据，**不是代际注册的**；
- 自述 `approved_window` 不是 root6 的窗口；
- 自述 `authority_effect = NONE_UNTIL_EXACT_NW01_TRANSACTION`，效力已随 NW-01 用尽。

评估者的定性我接受，且它比我自己的说法更准确：

> **这正是第十二轮 R12-F18 里实施方自己拒绝犯的那个错误，只是换了一个字段。**

第十二轮我拒绝把 `independent_acceptance_ref` 指向 `ContinuationRegistrationSubjectAcceptance.json`，理由是「那份文件受理的是续延主体、不是代际注册」——**判断正确，却没有把同一条判据用到旁边那个字段上。** 我检查了自己刚想到的那一个，没有回头检查同族的另一个。

**其余六问全部通过**，包括被受理主体的完整性、Owner 合并 3 的合格性（含我看不到的 `verification` 那一条）、`append_event` 的全部前置。

**如果那台机器还在，这一条会拦下一次错误的注册。闸门是有效的。**

---

## 四、什么完好无损

| 项 | 状态 |
| --- | --- |
| `ctrgen_5e0440a95ac8ee257b9e4236cabd275b` | **未注册，未烧毁** |
| 那唯一一次 600 秒分配 | **未消耗**，`charged_seconds` 9906 / 10506 |
| `current_head` | root5 / sequence 5，未动 |
| 十五个控制平面函数 | 未改动一个字节 |
| `clued_control.events` | 5 行 |
| 十二轮独立评审、全部发现与文档 | 完整在仓库里 |

**一次性资源一个都没花掉。** 这是十二轮「不可回退区之前一律停下」的直接结果。

---

## 五、现在不该做什么

**不要注册 root6。** 理由三条，任一条即足够：

1. 第十三轮已驳回该注册体（R13-F3）。
2. 即便修好，注册之后的路（17–20）走不通，代际 id 会烧在一条完不成的链上。
3. 注册会把 head 推到 root6，而三个 root5 钉的函数要靠 CP-01 修 —— CP-01 又只在能跑 600 秒时才有意义。**注册只会把一个干净的停止状态变成一个半截状态。**

**不要预留预算。** 预留了而跑不了那 600 秒，分配就随窗口消失，`charged_seconds` 上界 10506 恰好等于用完后的值，没有第二次。

**窗口 `2026-09-13T07:05:16Z` 让它过期即可。** 窗口过期不破坏任何东西：`read_root` 会返回 `EXPIRED_OR_NOT_YET_VALID`，库处于休眠但完整。Owner 随时可以再开一个。

---

## 六、如果要重来，需要什么 —— 据实列，不打折

这是一条**新链**，不是接着走：

1. **一台新宿主**，并重新采集 331 条 manifest（其中 187 条是宿主本地文件）。
2. **两份丢失输入的替代**。它们从未进版本控制，只能重造或改掉 `context.mjs:246-247` 对它们的读取。**改了就是新控制器。**
3. **新控制器的资格化**：`ScopedControllerQualification` + 运行时受理，由独立评估者签发。
4. **据新控制器摘要重签**下游文档（含 CP-01 的 A1 / A2 两处 schema 摘要钉）。
5. **新的 Owner 窗口**与新的 NW-01。
6. 然后才回到第 13 步。

**量级：不是几小时，是重新走一遍大部分准备工作。** 好处是十二轮的发现全部有效、可直接复用，且一次性资源仍未动用。

---

## 七、我在本轮的错误，一并记下

1. **把「注册体不需要自己的合并」这个局部结论，用成了「总共只还需要一次合并」的全局断言**，没查第 20 次前推的入参。（见 `Status24ChainDependencyFinding.md`）
2. **把运行手册「第 13 步起必须全部在那台机器上」当事实**，没核它与自己上一行表格矛盾，结果把六个数据库事务错派给宿主。若 Owner 照那份清单派工，会让人白做一半。
3. **R13-F3**：同族文件里检查了一个字段，没回头检查另一个。

三条都是同一个毛病：**在一处做对了判断，没有把同一条判据推到它该覆盖的全部位置。**

---

## 边界

未写库。未注册代际。未消耗那唯一一次分配。未调用任何会写库或消耗预算的函数。
本文件不签发受理、不构成授权、不批准也不合并任何 PR。最终裁量权在 Owner（`tdoljyj`）。
CI 五项长期全红、日志 404，已确认非瞬时；本文件不把它记作通过，也未尝试修复。
