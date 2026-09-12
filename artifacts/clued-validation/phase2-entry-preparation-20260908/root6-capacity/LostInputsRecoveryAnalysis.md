# 两份丢失输入：能不能绕过去 —— 逐项实测的答案

**状态：`ANALYSIS_NO_WRITE_PERFORMED`。**

Owner 告知那两份文件与机器一同永久丢失。本文件回答：**不用它们，控制器还能不能成立。**
答案不是「能」或「不能」，是**两份文件的性质完全不同，要分开处理**。

---

## 一、`Phase2Bounded…Proposal20260910.md` —— **可以直接去掉，零损失**

【实测】`context.mjs` 里它的全部用途：

```js
:161  need(sha(proposal_raw)===proposalSHA,'EXACT_APPROVAL_PROPOSAL_BYTES');
```

**只此一处。它的内容此后从未被读过。** 真正参与判定的是常量：

```js
:149  const proposalSHA='ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b';
:163  need(approved.proposal_sha256===proposalSHA, …)
:164  need(appendix.proposal_sha256===proposalSHA, …)
```

即：这份文件是一道**持有证明** —— 「跑控制器的人手上有那份提案原件」。而它要证明的那个绑定（提案摘要 = 批准件与适用性声明各自记载的摘要），**已经由常量加两份已合并的物料闭合**。

【实测】`ea96914e…` 在仓库中的独立见证：`BoundedSeriesExplicitUserApproval20260910.json`、`BoundedSeriesApplicability20260910.json`、`ApprovedOriginalInputCapacityChangeIndex20260910.json`、`EnvOriginalInputCapacityApplicability20260910.json`，以及四代早期控制器的 `context.mjs`。

**删掉 `:247` 的读取与 `:161` 的第一个 `need`，判定强度不变。** 这一条我认为可以直接主张，不需要降级。

---

## 二、`ActualTerminalFullObservation.json` —— **不能无损去掉**

【实测】它的内容被真正使用：

```js
:162  const base=JSON.parse(baseline_raw).row.metadata.execution;
:171  need(x.events.length>=base.events.length,'COMPLETE_EXECUTION_HISTORY_REQUIRED');
      need(same(x.events.slice(0,base.events.length),base.events),'ORIGINAL_44_EVENTS_UNCHANGED');
:172  for(const a of base.attempts) need(same(x.attempts.filter(t=>t.ga_id===a.ga_id),[a]),
                                         'ALL_SIX_ORIGINAL_ATTEMPTS_AND_RECEIPTS_UNCHANGED');
```

**它是「最初 44 条 `execution_events` + 6 次 attempt」的冻结快照，唯一作用是证明只追加的历史没有被改写。**

### 为什么不能从活库重建

**循环。** 这份基线存在的目的就是检测活库被改写；用活库去重建它，检查就退化成「库和自己一致」，什么都不证明。

### 仓库里也没有

【实测】遍历 `artifacts/` 与 `scripts/` 下全部 JSON，寻找任何具有 `row.metadata.execution.events` 结构的文件：**0 个命中。** 内容在本仓库任何形态下都不存在。

### 库里也没有替代的链式见证

【实测】`clued_control.execution_events` 的列：
`root_id, sequence, idempotency_key, request, recorded_at, recording_transaction_id`
**没有任何逐条哈希链字段。** 根事件那条 `history.prefix_digest` 链只覆盖 5 条根事件，不覆盖这 88 条执行事件。

**结论：那 44 条的独立见证只有这一份，它没了。**

---

## 三、所以路径 B 到底是什么 —— 说清楚代价

一个不读这两份文件的新控制器**可以造**，但第二条必须换成：

**从当前库状态冻结一份新基线**，并且新的资格声明里必须写明：

> 该检查证明的是「自 2026-09-12 起未被改写」，**不再是**「自 root3 schema 恢复以来未被改写」。

**这是一次真实的判定降级，不是等价替换。** 降级幅度可以精确表述：

| | 原基线 | 新基线 |
| --- | --- | --- |
| 覆盖区间 | root3 恢复 → 今 | 今 → 以后 |
| 能否发现「前 44 条曾被改写」 | 能 | **不能** |
| 能否发现「今以后被改写」 | 能 | 能 |

**我不能替你或替评估者决定这个降级可不可接受。** 但我可以说清楚它的边界：这是一次非生产资格运行（`ISOLATED_TEST`、`paid_budget: 0`、`model_budget: 0`），而那 44 条事件的完整性在过去若干轮里被反复读取和交叉核对过 —— 独立评估者手上有判断这件事所需的材料。**这是一个应当由评估者出意见、由 Owner 裁定的问题，不是一个可以由我在代码里悄悄换掉的问题。**

---

## 四、但这不是当前的主要障碍

**就算上面两条全部解决，仍然缺一台机器。**

【实测】本会话容器：

| | |
| --- | --- |
| Docker 守护进程 | **连不上** —— 而 600 秒运行就是一个 Docker 容器（`parent600.py:124` 每次操作都以 `[DOCKER, '--host='+ENDPOINT, …]` 开头） |
| 持久性 | **无** —— 容器会被回收，钉在它上面的 manifest 随之作废 |
| `gh` | 不存在 |

**这一条没有任何技术手段可以绕过。** 600 秒运行必须在一台真实存在、跑得起 Docker、并且之后还在的机器上。我造不出这台机器，也没有替代路径。

---

## 五、一句话结论

| 障碍 | 我能解决吗 |
| --- | --- |
| 提案文件丢失 | **能** —— 直接删除该读取，零损失 |
| 基线文件丢失 | **能造出替代方案**，但代价是一次明确的判定降级，需评估者出意见、Owner 裁定 |
| **宿主机器** | **不能。这是硬件，不是代码。** |

**前两条我可以现在就做完，做完之后仍然跑不了 —— 卡在第三条。**

所以真正要你回答的只有一个问题：**你还能不能找到／搭起一台跑得动 Docker、并且会一直在的机器？** 任何系统都行，不必是 Windows。

- **能** → 我现在就开始造路径 B 的控制器，你机器到位就接上。
- **不能** → 这件事到此为止，`HostLossTerminalRecord.md` 就是终局记录。一次性资源全部未动用，随时可以在有宿主之后重新开始。

---

**边界**：未写库、未注册代际、未消耗预算、未改动控制器任何字节。本文件不签发受理、不构成授权。
