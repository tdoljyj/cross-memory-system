# 继任独立评估者：第二轮

**给继任会话 `session_018nf6mQ5CQuMFadoJ9WRZCN` 的第二轮指令。** 由实施方起草。与第一轮同样的规矩：本文件的每一条都是**待证伪的断言**，不是事实；实施方无权替你判断任何事。

## 第一轮的处置

你的九项发现**全部经实施方独立复核确认属实**，无一驳回。处置见提交 `2b910a5` 与 `5882798`。

| 发现 | 处置 |
| --- | --- |
| F1 三处 `capacity_delta` 仍为 131 | **未解决** —— 本轮的主题，见下 |
| F2 守卫只覆盖 `SOURCE_TREE` | 已补 `SOURCE_COMMIT` 树一致性、`OWNER_MERGE` 双亲、祖先关系三项；常量已更新到 `a573ca9`；负向测试通过。你指出 `OWNER_MERGE` 运行时不被读取，已在 README 写明，避免下轮把力气花错 |
| F3 签署时序无处记录 | 已写入 README |
| F4 下界回退三点 | 全部采纳。**第 2 点推翻了实施方写在构建脚本里的一条辩护**（`approved_at` 的约束只在容量材料被绑定时成立），已在 README 更正；第 3 点「派生 id 保证只对构建时成立」已写成明示边界 |
| F5 容量绑定早退 | 已写成 [`CapacityBindingBypassProhibition.md`](CapacityBindingBypassProhibition.md)，实施方以文件承诺不采取该路径 |
| F6 README 注册值 `09-13` | 已修为 `09-19`，并写明「注册不可回退」。**这是本轮最险的一条** |
| F7 四份钉死摘要文档 | 已加 [`SUPERSEDED-BY-ROOT6.md`](bootstrap/root5-final-runtime-v16/SUPERSEDED-BY-ROOT6.md)，文件本身按原字节保留 |
| F8 11 处同义反复守卫 | 全部改为转录的前代真值。**你的计数 19/11 是对的，实施方第一次数成 17/9**（单行正则漏掉两处跨行调用） |
| F9 双 signing 白名单 | 已记录为结构性风险。实施方独立追出的引入链与你的不同，说明**不止一条路径** |

## 本轮请你做什么

F1 是唯一剩下的阻塞。解除它需要三份文档，**有严格依赖顺序**：

```
① Owner 重签容量批准        （Owner 做）
      ↓  适用性要引用①的 blob 与 sha256
② 容量适用性继任文档        ← 只有你能出具
      ↓  运行时验收要引用①②
③ 重签运行时验收            （实施方做）
```

你负责 ②。**在 ① 存在之前 ② 无法出具**，因为控制器要求 `same(d.approval_ref, s.capacity_materials.approval.ref)`。

## 控制器对 ② 的硬性要求

以下由 `context.mjs:129-135` 逐字节强制。这些是**代码事实**，请自行复核而非采信本表：

| 字段 | 必须为 |
| --- | --- |
| `state` | `ACCEPTED_EXACT_ROOT3_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT` |
| `independent_reviewer` | `/root/project_list_auth_fix`（Owner 决定授权你使用该标识） |
| `controller_digest` | `72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145` |
| `scope_digest` | `115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5` |
| `capacity_delta` | 与控制器 `capacityDelta` 逐字节相同 —— **关键差异：`source_refs_maximum: 133`**，其余 19 项与前代一致 |
| `bounded_series_constraints` | 与 `scope` 相同（root3，不可变） |
| `baseline` | 与控制器 `capacityBaseline` 逐字节相同（`ga_04377008…` / `sequence: 49` / `charged_seconds: 5706` …） |
| `base_proposal_sha256` | `ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b` |
| `approval_ref` | 指向 ① 的新批准 |
| `base_approval_ref` | `pins.approval_ref`（不变） |
| `capacity_proposal_ref` | 与 ① 的 `capacity_proposal_ref` 相同 |
| `previous_evidence_sink_ref.sha256` | `33feb26ab01ec1cb45834c4b97d5d94f620507452f67146ce1ab7748a8500d96`（控制器硬编码） |
| `evidence_sink_ref` | 须等于 `expected_ga.evidence_sink_ref`，且出现在 `expected_ga.artifact_refs` 中，且 ≠ `previous_evidence_sink_ref` |
| `scope_unchanged_except_original_input_limit` | `true`，且**不得存在** `scope_unchanged` 键 |
| `new_action_authorized` | `false` |
| `changed_source_refs` | 非空、全为合法 ref、URI 不重复 |
| `accepted_at` | `≥ ①.approved_at` 且 `≤ 运行时刻` |

前代那份（`cc3db45b…`，9479 字节）在
`bootstrap/root5-final-runtime-v16-source-completeness/Root5CurrentController4000000CapacityApplicability20260911.json`，可作结构参照。**实施方不提供草稿**——由实施方写好、你签字，等于借你的手自我认证。

## 时序（你自己第一轮推出来的，此处复述以免重推）

```
2026-09-12T00:00:00Z ≤ ①.approved_at ≤ ②.accepted_at ≤ 运行时刻 < 2026-09-19T00:00:00Z
```

三者须**依次递增**。不得为省事盖同一时间戳再倒排。

## 请你在出具前独立判断的事

出具 ② 等于对下列各项背书。实施方的立场已如实记录，但**不构成你的结论**：

1. **`source_refs_maximum` 131 → 133 是否可接受。** 133 = 131 + 为避免原地修改被 64 份产物钉住的共享 signing 模块而新增的两个文件。这是一次 cap extension，而 `BoundedSeriesApplicability20260910` 的 `excluded` 字段逐字包含 "cap extension"。
2. **前推额度 15 → 16。** 同一性质，已由 Owner 单方 override（[记录](OwnerForwardCapExtensionOverride.json)），未经独立评审。
3. **窗口延长到一周。**
4. **实施方在第一轮之后的六处改动本身是否引入了新问题。** 你上一轮的每一条采纳都产生了新的字节。

## 出具的形式要求

每份接受须记录：你的真实会话标识、Owner 决定合并提交 `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4`、以及「本接受不追认原 `/root/project_list_auth_fix` 会话的任何历史结论」。

**发现未解决即不得出具接受。** 结论若是「仍不该签」，那就写「仍不该签」——第一轮你正是这么做的，那份产出是有价值的。

## 你可能会先问的问题

**「① 还不存在，我现在能做什么？」** 可以先做只读复核：核对上表每一条是否与控制器源码一致（实施方可能又抄错了），复核第一轮六处改动，以及独立判断上面四项。这些不依赖 ①。若你认为在 ① 落地前不宜出具任何东西，那也是合理结论，说明理由即可。

**「实施方要求我背书它自己的改动，这合适吗？」** 这正是本轮的实质。你没有义务背书。

---

预算现实不变：`charged_seconds` 为 10506 上限中的 9906，**恰好只剩一次分配，没有重试**。
