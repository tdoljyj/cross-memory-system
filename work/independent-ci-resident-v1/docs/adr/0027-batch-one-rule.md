# ADR 0027：批次只在三者同时成立时存在（一条规则，取代取代类特例）

- 状态：已实现（分支 `claude/batch-one-rule`，未安装）
- 日期：2026-11-13
- Owner Decision：统领原则（最终系统极简、低耗、高效；Decision `42d5bf8d`：约束最终形态，不限制工程投入）；“节点只有通用升级或通用包重装两条路，无任何按台、手工步骤”。
- 代码：`src/executor.mjs`（`standing`、`liveReadDue`、`endIfNotStanding`、`endParkedIfNotStanding`、`endNotStanding`、`supersededEnd`、`runAttempt2`、`endSupersededForFront`）；`reinstall/rehearse.py`；`reinstall/launcher/template.ps1`（与 `generate.py` 的钉值）；`windows/uninstall-resident.ps1`
- 测试：`test/batch-one-rule.test.mjs`；随之更新 `test/node-mode.test.mjs`、`test/scheduler.test.mjs`、`reinstall/test/test_rehearse.py`
- 档案：DESIGN §72

## 背景

2026-11-13：备班节点上 PR #1080 的批次自 11-12 18:03Z 停在 B（`RESIDENT_QUEUE_HEAD_NOT_REACHED`），试了 20 次；#1080 早已关闭（被 #1081 取代）。旧设计里停靠批次只在两种情况下结束：

- 同一 PR 有新提交（`supersededParked`：排队表里出现更新的提交，再一次实时读确认）；
- 停满 `park.maxMs` = 24 小时（`endParkedB`）。

PR 关闭、节点失去当班都不在其中。结果这个节点的通用包重装被拒三次：预演 `UNINSTALL_PLAN_OPEN_BATCHES`，启动器 `OPEN_BATCH_REARM_FIRST`，卸载 `UNINSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST`。只能 Owner 手动 rearm Abort，这是按台手工补丁。

病根不是少了“PR 关闭”这一条特例，而是批次的去留靠一组并列特例，每条各有各的触发：

| 特例 | 触发 | 漏掉的 |
|---|---|---|
| `supersededAfterStart`（在途安全点） | 排队表有更新的提交 | PR 关闭、失去当班 |
| `supersededParked`（B，`resumeParked` 里两处） | 同上 | 同上 |
| `endSupersededForFront`（#1035；DESIGN §84 起为 `endRestingForFront` 的别的 head 一类） | 第 10 段的车头是别的 head | 同上 |
| `runAttempt2` 的“有更新提交就读一次” | 同上 | 与其后的“PR 关闭就作废”是两次判断 |
| `park.maxMs` | 24 小时 | —（兜底） |
| 节点 STANDBY | 无：“在途批次照常续跑，去留由实时准入决定”（§29.2 第 3 条） | 停在 B 的批次要等下一次第 8 段尝试，最长退避 2 小时；准入读到的若是队列状况，就一直不结束 |

## 决定

**一个批次只在三者同时成立时存在：PR 仍开着、PR 的 head 仍是批次的 head、本节点当班（持有 ci-admission）。** 任一不成立，下一拍经唯一一条终结路径结束并写回执。

1. **判定只有一个函数**（`executor.mjs#standing`），输入都是常驻已有的：
   - 当班：节点模式 `STANDBY`（第 11 段探测或第 1 段说没有角色）。`UNCERTAIN` 不是答案，不结束。没有探测能力的引擎没有模式（单节点），视为当班。结束要经 companion 证明两端静止，所以只在 companion 心跳新鲜时动手，否则下一拍再判。
   - PR 开着、head 相同：companion 的 `pr-head` 实时读（DESIGN §17.5，已有通道），每个批次每 10 分钟一次（`SUPERSEDE_LIVE_READ_MS`，原有常量），排队表里出现更新的提交或第 10 段的车头指向别的 head 时立即读（提示，同一 head 也是 10 分钟最多一次）。第 1 段的准入本身读过 PR，所以 `markStarted` 记作该批次的第一次读。
   - 读不到：不结束（保守）。理由：读不到不是事实；结束会烧掉 head（B 上第 3、5、7 段已发布，要推新提交才能再跑），误结束的代价远大于多停一会儿；而停留本身有 `park.maxMs` 兜底。
2. **结束只有一条路**（`supersededEnd`，原有）：先只新建 `81-self-abort`（记 `basis`：`pr-closed`、`head-moved` 或 `not-on-duty`），两端静止证明，烧号，两端只改名归档（固定原因 `superseded`），`FAILED_CLEAN SUPERSEDED_AT_SAFE_POINT`（对熔断中性，从不 attempt 2）。证明不成立 → UNKNOWN 加 HALT，与 Owner 中止相同。不新增失败码，失败表不变。
3. **在哪里判**：
   - 停在 A、B 的批次：每个 tick 一次（`endNotStanding`），在恢复、Owner 请求、HALT 检查、回填之后；不暂停时在读完本拍触发之后、任何停靠批次被尝试之前；**PAUSE 期间也判**（暂停挡住一切尝试和开批次，不挡这条规则：结束不跑任何段、不发布任何东西）。一拍结束一个，下一拍接着下一个。
   - 在途批次：原来的两个安全点 `before-relay-plan`、`before-workspace`（先读一次收件箱）。独占区内照旧不判。
   - 第 1 段之前：照旧按到达顺序释放（`supersededBeforeStart`，不烧号，什么都没跑，判错了可以恢复）。这不是批次的结束，是预留的撤回。
   - attempt 2（还不是批次）：预检之后一次实时读；PR 已关闭 → `ATTEMPT2_PR_CLOSED`，head 已变 → `ATTEMPT2_SUPERSEDED`；读到 head 未变时把排队表里的“更新提交”退回被替换。原来“有更新提交先读一次、预检后再读一次”合成这一次。
4. **删掉的特例**：`supersededParked`（及 `resumeParked` 里调用它的两段循环）、`supersededAfterStart`、`runAttempt2` 预检前那一次读与分支、`endSupersededForFront` 自己的实时读和判定（它只剩“把车头的 head 作为提示交给规则”）。§29.2 第 3 条“STANDBY 时在途批次照常续跑、去留由实时准入决定”作废。
5. **保留的兜底**：`park.maxMs`（24 小时，`endParkedB`）。它不能被规则覆盖：规则只管“还该不该存在”，而一个仍然成立的批次（PR 开着、head 没变、本节点当班，只是作者一直不入队）或一个一直读不到 PR 的批次，不能无限占着停靠名额（`park.maxParked` 满了就不开新批次）。它是资源上限，不是存在条件。`endParkedB` 另一个用途 `TRAIN_FRONT_TAKES_OVER`（同 head 的车头批次接手）也不在规则内（三者都成立），不动。
6. **重装前置**：
   - 不当班的节点按规则不留任何批次（下一拍结束；PAUSE 下也一样）。重装本来就只对不当班的节点做（`rollout/fleet/README.md`：先待命、再移交、后原当班），所以“必须无未结批次”由规则保证，不再要 Owner 先 rearm 或排空。
   - `rehearse.py`：删掉对卸载计划 `openBatches` 的比较（`UNINSTALL_PLAN_OPEN_BATCHES`）。它是预演那一刻的瞬时状态，不是包或配置的性质；预演之后、启动之前，规则会把它清掉。
   - W1（`pause-old-resident.py`）不改：它请求暂停后等到“无当前批次、无未终结条目”，规则在暂停下照样结束残留，所以这一步就是重装的收尾阶段。
   - `template.ps1`、已装的 `uninstall-resident.ps1` 的检查保留，作为规则保证的断言（错的路仍然走不通），码改成不再指示手工动作：`OLD_RESIDENT_OPEN_BATCH`、`UNINSTALL_REQUIRES_NO_OPEN_BATCH`。真触发时说明规则没能运行（节点当班、HALT、companion 不在），按那个原因处理，不是复位。
   - Owner 排空（`request-drain`）保留为 Owner 的工具（当班节点上主动放弃仍成立的批次），不再是重装的步骤。

## 理由

- 一条规则覆盖三种情况，以后不会因为漏一种情况再加特例；判定和结束各只有一处。
- 读 PR 只用已有的 `pr-head`，不开新通道；poller 的 open pulls 列表只在 companion 里，传给执行器要新通道，而且每页 50 条，PR 不在列表里不能证明它已关闭。
- 成本：每个停靠批次每 10 分钟一次 GitHub 读（名额上限 12 个，最多每小时 72 次，平时 0–2 个批次），同时省掉备班节点上无意义的第 8 段尝试（每次一次交换代理换跑加一次 Native 准入；本例 20 次）和 24 小时的空占。

## 后果

- 节点失去当班后，停在 A、B 的批次在下一拍（约 15 秒，companion 心跳新鲜时）结束；以前要等下一次第 8 段尝试（最长 2 小时）或 24 小时。它们的 head 在本节点烧掉；接班节点照 §41.6 清扫撤掉旧节点已发布的绿后重跑。
- PR 关闭或换 head 的停靠批次最迟 10 分钟内结束（有触发时下一拍）。
- PAUSE 的含义改为“不尝试、不开批次”，不再是“停靠批次一概不动”。升级代理先排空（暂停接新，等无未结批次）再暂停，所以它的暂停期间没有批次，不受影响。
- 失效模式不变：结束途中崩溃 → `SUPERSEDE_INTERRUPTED` HALT；两端不静止 → `SUPERSEDE_QUIESCENCE_UNPROVEN` HALT；字节漂移 → `RESIDENT_SOURCE_DRIFT` HALT，不归档。
- 残余：重启后在 PAUSE 下一直 `UNCERTAIN` 的节点（暂停期间不探测，升级代理的暂停除外），只能按 PR 事实结束批次；它的未结批次要等暂停解除后的第一次探测。重装的 W1 在节点运行时发出暂停，这种情形不会出现在正常流程里。
