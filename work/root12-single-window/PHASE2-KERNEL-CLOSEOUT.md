# Kernel Phase 2 收尾归档（2026-09-16）

**状态：完成。生产库拿到终局 PASS 收据。此后进入 Post–Phase 2 长期工作轨（K1–K12），
不再有需要受权执行窗口的任务，因此不会有第 13 代。**

本文件的重点有两块：一是**交付了什么**，二是**哪些方案被关闭了、为什么**。
第二块比第一块重要——它存在的目的就是防止后来者（包括我自己）重新捡起已经算过账的方案。

---

## 一、交付物

生产控制库 `uscrdifznmlvczcekqpw` / schema `clued_control` / 根 `ctr_414bd3c724264a83894b0c55cf2ab878`：

```
execution_sequence      153
active_ga_id            <null>          pending_budget_sequence   <null>
charged                 12906 秒 / 2872683443 字节   （= 授权上限，未超）
gate_attempts 中 PASS    1 张            ← 该控制库历史上第一张
```

终局收据：

| 项 | 值 |
| --- | --- |
| `gate_result_receipt_id` | `grr_57c3f349fadc2078dcb97ccc4fc2396a` |
| `result` | `PASS` |
| 字节 / 摘要 | 13288 字节，sha256 `61184cc73656491f3427a761ef396ca3544c52b5446e258c878a83080282794c` |
| 对应 GA | `ga_2f8794bb73289e01b67ace6c960339ec` |
| 代次 | `ctrgen_1cf79ef9a7ccc37800e8837ac8c10287`（第 12 代） |
| 控制器 | `a959f7d18eb96e1babd81400a4dd46736b3fc11dd71ea341e5ec86d44272acb3` |
| 容器实跑 | `2026-09-16T09:57:43.502Z` → `09:58:19.459Z` |
| 收据签发 / 窗口截止 | `09:58:41.727Z` / `10:04:38.455Z` |
| 五项适用测试 | PQUAL-11 / 13 / 15 / 16 / 17 全部 PASS |
| 写入目标 / 原始证据 | 45 / 10 |

`receipt_sha256` 与 `receipt_raw` 字节逐字对上；`revoked = false`。

生产事件链：

```
138 BUDGET_OWNER_FORFEITED_UNCONSUMED     第 11 代未消耗预算按不退款放弃
139 SUCCESSOR_BINDING_REGISTERED   140 PREPARED   141 QUALIFIED
142 EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED        143 BUDGET_RESERVED
144–146 CREATE    147–149 START    150–151 STOP
152 DECISION_RESERVED   153 SIGNING   → commit_gate_result: PASS
```

Owner 授权原文要求的"不退款、不增容、不重分配，只签一个正式 GA"，逐条成立。

### 本代文档摘要

| 文档 | sha256 |
| --- | --- |
| 控制器清单 | `a959f7d1…` |
| 控制器资格 | `3ccfd021…` |
| 运行时验收 | `1843de24…` |
| 根引用（已签根的规范摘要） | `b2447bd7…` |
| 状态清单（载荷规范摘要） | `288ce2ba…` |
| 评审委托 | `8325eb07…` |
| 执行者适用性 | `c37e8d9d…` |

---

## 二、已关闭的方案（本文件的主要目的）

### 路线甲 —— 已执行

出处 `FINDING-2026-09-16-controller-edit-scope.md`。

内容：新控制器 = 改 `validateRoot10ControllerContract` 里约 11 处代次相关数值 + 重算
`ControllerSourceManifest.candidate.json` → 新 `controller_sha256`。先拿 PASS，不做结构改造。

**结论：已执行并交付。** 实际改动量比预估略大——合同里的 `reviewer_delegation.ref`
也必须随代次走（见下文缺陷 4），当初漏了。

### 路线乙 —— 关闭，且那份文档对它的判断是错的

原文主张：

> 路线乙（让 `validateRoot10ControllerContract` 只校验结构与自洽、数值从合同读）能终结这个循环

**这句话不成立。** `Root10ControllerContract.candidate.json` **本身就是控制器清单里的
35 个文件之一**。所以即便所有数值改成从合同读、`root10-single-window.mjs` 一行不动，
只要合同内容随代次变化，清单摘要就变，`controller_sha256` 就变，随之而来的仍然是：

资格 → 批准 → 判词 → 送审件 → 根签名载荷 → 根签名证据 → 状态清单 → 状态签名证据 → 运行时验收，
外加**至少三次串行的 Owner 合并**（因为后一份文档必须引用前一份的发布合并 sha，顺序不可压缩）。

本轮的 #233 / #234 / #235 就是这个级联，乙一个都躲不掉。

**乙真正省掉的只有"手工编辑那 11 处源码常量"这一个动作，省不掉重签控制器。**

要真正断掉循环，需要把每代参数移出控制器**自身摘要之外**——做成一个由根签名背书的独立对象，
让控制器读它而不是把它算进自己的身份。那是比乙大得多的改动，也是唯一有效的改法。
**此项留给 K6，不作为 Kernel Phase 2 的遗留工作。**

### 路线 A / 路线 B（数据库侧参数化）—— 关闭

出处 `NEXT-GENERATION-CHECKLIST.md` B 节与 E 节。内容：把
`reserve_execution_budget` / `reserve_gate` 的一次性函数改为查 `clued_control.generation_pins`，
两条逐代枚举的 CHECK 约束改成触发器（CHECK 不支持子查询）。换代只插一行。

**关闭，两条理由：**

1. **实测它不是瓶颈。** 本轮 `build-gen12-activation-inputs.py` +
   `build-root12-activation.mjs` 一次重出全套 SQL，耗时以秒计，生产库一次应用成功。
   路线 B 想省的正是这一段。真正的成本在"发现拦路点"和"文档级联"，不在 SQL 生成。
2. **它是授权姿态变更。** 文档自己就写了：改成按表匹配，会把授权依据从
   "代码里写死、经人工审阅的唯一一次转换"变成"匹配某行数据即授权"，
   应当单独立项并做安全评审，不宜与代次签发混做。这个判断至今有效。

**此项归入 K2（Authority / Authorization），且必须带安全评审，不得作为工程便利顺手做掉。**

### 彩排工具 / 文档链自动化 —— 关闭

曾考虑：做一个构建器吃进「代次 ID + 窗口 + 基线快照」吐出全部文档并断言所有交叉引用；
再把复制品彩排（重置 → 活化 → 签 GA → 容器 → GRR）固化成一条命令作为生产前强制闸门。

**关闭。** 它的全部价值都摊在"下一代"上，而已确认不会有第 13 代：
第 12 代合同写死 `max_ga: 1` / `max_budgets: 1`，那一个 GA 已用尽；
此后任何一次受权执行都必须开新代次；而 K1–K12 全是设计轨，没有一条需要执行窗口。

本轮为拿 PASS 临时拼的脚本停在原地，不整理成资产，不进仓库。

---

## 三、本轮实际付出：七个拦路点

这是留给 K6 / K7 最有价值的一手材料——**其中四个离线预检看不出来，非得真跑一遍容器才现形。**

| # | 问题 | 会在哪一步炸 | 怎么发现的 |
| --- | --- | --- | --- |
| 1 | 验收 `control_schema_refs.GateResultReceipt` 仍指第 10 代收据 schema | GRR | 离线预检 |
| 2 | 评审委托 `control_trust_root_generation` 写着第 10 代 | GRR | 离线预检 |
| 3 | 执行者适用性：代次 + `current_controller_sha256` 都是第 10 代 | GRR | 离线预检 |
| 4 | **控制器合同里 `reviewer_delegation.ref` 没随代次走** | CREATE | 复制品实跑 |
| 5 | 验收**正文**以 base64 嵌在活化载荷里，只替换摘要不够 | `reserve_gate` 前像断言 | 复制品实跑 |
| 6 | `umask 022` → `allowed/` 是 755，容器内 10001 用户写不进 `fixture.json` | 收据构建 | 复制品实跑 |
| 7 | Docker 给纳秒时间戳，控制器 `time()` 只认 3 位小数 | GRR 最后一步 | 复制品实跑 |

第 4 条是路线甲执行时的遗漏：合同把评审委托的引用钉死，而 GRR 又要求委托写当前代次，
两个要求不可能同时满足 → 控制器必须重出 → 触发完整级联，`14614efd…` → `a959f7d1…`。

另有一次复制品运行（`ga_3f789b03…`）CREATE/START 被拒但**原因未定位**——脚本当时把输出
截断了，等加上阶段断言重跑时问题未再出现。如实记录，不编理由。

复制品上签发的 GA 及其收获：

| GA | 结果 |
| --- | --- |
| `ga_fa51a1c8…` | `reserve_gate` 拒绝 `root10_exact_single_ga_preimage_required` → 发现缺陷 5 |
| `ga_92b4c31e…` | CREATE 拒绝 `EXACT_SIGNED_ROOT10_REVIEWER_REF` → 发现缺陷 4 |
| `ga_d4848353…` | 跑到 STOPPED，收据构建失败 `ACTUAL_FIXED_FIXTURE_WRITE_REQUIRED` → 发现缺陷 6 |
| `ga_3f789b03…` | 被拒，原因未定位；诊断期间窗口过期 |
| `ga_46b9210d…` | 全链跑通至 GRR，被 `UTC_TIME_REQUIRED` 拒 → 发现缺陷 7 |
| `ga_1cbbeb45…` | **复制品全链 PASS** |
| `ga_2f8794bb…` | **生产 PASS**（正式窗口一次通过） |

正式生产窗口只签一个 GA、一次通过。窗口内唯一插曲是生产脚本里的引号 bug（续行被写成字面
`\n`），在 CREATE 之前就失败，未触及额度，修好后立即重跑。

---

## 四、给 K2 / K6 / K7 的三条结论

### K6（Temporal / Generation / Expiry）

**合同文件在控制器自身的清单里 ⇒ 每一代都必须重签控制器。**
这不是实现瑕疵，是身份定义的后果：控制器把"我是谁"和"这一代的参数是什么"算进了同一个摘要。
代次参数必须移出控制器身份之外，由根签名单独背书——否则"换一代"永远等于"造一个新控制器"，
而造控制器要走 Owner 合并 + 独立验收，一轮就是一天。

### K7（Qualification / Gate / Execution Lifecycle）

**准入检查在建容器之前跑，结果检查在容器跑完之后跑。这个不对称决定了生命周期该怎么切。**

- 准入失败：`capacity_released=false`、`automatic_retry=false`，attempt 停在 `PENDING`，
  **零额度代价**，可以反复试。
- 结果失败：容器已经跑完，600 秒窗口已经花掉，而 `max_ga=1` 意味着整代报废。

本轮七个缺陷里有五个落在结果侧。**要么把结果侧的检查前移到准入侧，要么让彩排成为强制前置**——
二选一，不能都不做。这是 K7 最直接的输入。

### K2（Authority / Authorization）

**"Owner 合并即签名"在令牌可被代理使用时，检查器无法分辨。**

`verifyOwnerMergeArtifact` 核验 `merged_by=tdoljyj` / `committer=web-flow` / `verified=valid`。
用 Owner 令牌代按合并键时，这三项**全部成立**，因为令牌就是 Owner 的账号。
它想证明的"有个人独立看过这些字节"，在这种情况下并不成立，而**没有任何检查能发现**。

本代的实际情况已如实记入 [OWNER-MERGE-DELEGATION.md](OWNER-MERGE-DELEGATION.md)：
#227 / #228 / #229 / #231 由 Owner 本人合并，#232 / #233 / #234 / #235 / #236 由代理代按（经 Owner 明确授权）。

若要恢复"合并即人工审阅"的强度，需要 Owner 亲自按键，或引入第二个审阅账号。

---

## 五、边界与未尽事项

**这张收据证明了什么**：在第 12 代授权下，针对 Gate `G-PREENTRY-SKILL-QUALIFICATION`，
五项适用测试（PQUAL-11/13/15/16/17）在原始观测证据上被独立判定为 PASS，
且整个执行、证据、签名链通过了控制器的全部校验。

**没有证明什么**：PQUAL-18 按合同是**否定性准入守卫**，不是正式结果项（`pqual18_disposition`）。
五项判词基于历史原始拒绝观测的只读重验证，本次 GA **没有**重新注入那些故障
（`pg_started=false` / `complete_case_pass=false`），这一点写在每份判词里。

**未尽事项（一条）**：`root10.env` 中的数据库口令与 GitHub 令牌应当轮换——
它们在两次会话的转录中出现过。轮换后工具侧零改动，脚本均从文件现读。
