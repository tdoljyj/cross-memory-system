# 发现：Status24 受理钉着一份必须在 CP-01 应用之后才存在的文件

**状态：`NO_WRITE_PERFORMED`。** 全部结论来自只读 `git` 与文件读取。未写库、未注册代际、未消耗预算。

由实施方在编写 Status24 签署主体时发现。**它改变第四次 Owner 合并的时点，也解释了为什么它不可能并入第三次合并。**

## 一句话

第 20 次前推要 Status24 受理；Status24 受理要钉 `runtime_function_acceptance`；**该字段在 root6 侧的对应物是「CP-01 应用之后的独立受理」，而 CP-01 还没应用。**

---

## 一、事实链（逐条实测）

### 1. 第 20 次前推的入参必须带一份已合并的 Status 受理

第 14 次前推的 `source_materials.independent_acceptance`【实测】：

```
ref.uri      …/git/blobs/bbd755a0fccfecd3aba2dc10ece139d929953a07
publication  { commitSha: "2b6320f91b08a48e091e6d6a165614cb11ca44ac",
               artifactPath: "…/root5-final-runtime-v10/Status17Acceptance.json" }
```

`2b6320f9`【实测】`parents=75aeeb1 f322786`，是 **PR #111 的合并提交**。
→ **这份受理必须经 Owner 合并进 `main` 才有 `publication.commitSha` 可填。**

### 2. Status24 受理不能由实施方编写

补遗 C 第六节原文：**「它尚未编写，且不能由实施方编写。」** 必须由继任独立评估者签发。

### 3. Status24 受理要钉三个引用

Status23 受理的实际形状【实测】—— 这就是运行手册说的「五项待定钉」：

| 钉 | Status23 指向（blob 解析到路径） |
| --- | --- |
| `status_manifest_id` | `sm_78056a94b00d4eaeadce829f07a71956` |
| `generation` / `root_generation` | 23 / `ctrgen_e5df4322…` |
| `as_of` / `expires_at` | `2026-09-11T05:40:27.015Z` / `2026-09-11T10:21:05Z` |
| `controller_qualification` | `root5-final-runtime-v16/ScopedRoot5FinalControllerQualification.json` |
| `runtime_function_acceptance` | `root5-final-runtime-v16/RuntimeFunctionsRoot5Window9Acceptance.json` |
| `capacity_approval` | `root5-final-runtime-v16-source-completeness/Root5OriginalInput4000000CapacityApproval20260911.json` |

### 4. 两个钉在 root6 侧有对应物，一个没有

| 钉 | root6 / window11 对应物 | 存在？ |
| --- | --- | --- |
| `controller_qualification` | `root6-runtime-v18/ScopedRoot5FinalControllerQualification.json` | **有** |
| `capacity_approval` | `root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.v2.json` | **有** |
| `runtime_function_acceptance` | **没有对应物** | **无** |

【实测】全仓库 `RuntimeFunctions*` 共 16 份，**全部是 root4 / root5 的，没有一份 root6。**
`root6-runtime-v17/` 与 `root6-runtime-v18/` 各只有两份：资格与运行时受理，**都不是它。**

### 5. 缺的那一份是什么——这才是关键

`RuntimeFunctionsRoot5Window9Acceptance.json`【实测】：

```
state: ACCEPTED_EXACT_ROOT5_WINDOW9_CAPACITY_REPAIR_APPLIED
keys:  source, publication, observed_postimage, installed_prosrc_sha256,
       rows_changed, applied, production, paid_budget, model_budget
```

**它不是一份计划的受理，是一份「某个 SQL 已经应用、并且实测了后像」的受理。**
`observed_postimage`、`installed_prosrc_sha256`、`rows_changed`、`applied` —— 这些字段**只有在那个 SQL 跑完之后才有值**。

**root6 / window11 侧那个「已应用的 SQL」就是 CP-01。**

---

## 二、结论

**Status24 受理钉的 `runtime_function_acceptance`，其 root6 对应物是「CP-01 应用之后、对其实测后像的独立受理」。CP-01 没应用，这份文件在结构上不可能存在。**

推论三条：

1. **第四次 Owner 合并是结构性必需的**，不是疏漏。
2. **它不可能并入第三次合并** —— 补遗 C 说「可以并入第三次」，那是在没有考虑本条依赖时写的。**该处需要更正。**
3. **第四次合并必须排在 CP-01 应用之后**，不能更早。

---

## 三、修订后的次序

```
13   注册 root6                                    ← 不可回退
13b  量实测 root 摘要（measure-root6-root-digest.sql）
13c  CP-01 定稿 → 独立评审 → 应用 → 回读
13d  【评估者】CP-01 应用后的独立受理
       = root6 侧的 RuntimeFunctions… 对应物，含 observed_postimage
13e  【实施方】Status24 签署主体
13f  【评估者】Status24 受理，钉 13d
13g  【Owner】第四次合并：13d + 13f
14   第二十次前推（入参此时才凑得齐）           ← 不可回退
15   Status24 追加
16   预算预留                                      ← 不可回退
17-20 GA → 600 秒 → 20 项观测 → GRR
```

**13d / 13f 两份都必须由独立评估者签发，实施方不能写。**

---

## 四、这对时钟意味着什么

窗口 `2026-09-13T07:05:16Z` 关闭。第 13 步之后到第 14 步之间，现在插着**两轮独立评审 + 一次 Owner 合并**。

**这一条应当在启动第 13 步之前就让 Owner 知道**，因为第 13 步一旦执行就不可回退，而它之后的路比原计划长。

---

## 五、我做错的地方

我在第三次合并的 PR 里写「注册体本身不需要合并……所以仍然只需要一次合并，不是两次」。

**前半句是对的**（`signature_binding` 指向已完成的批准合并，无循环依赖，这一条我查了先例）。
**后半句超出了我核实过的范围** —— 我核实的是「注册体要不要合并」，却据此断言了「总共还要几次合并」。第 20 次前推的入参我当时没查。

查了就会发现：Status24 受理必须合并，所以还有第四次。**这是一次把局部结论当全局结论用的错误。**

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、未调用任何会写库的函数。
本文件不签发任何受理、不构成授权、不批准也不合并任何 PR。
