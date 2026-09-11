# 继任独立评估者：交接简报

**给继任会话的第一条指令。** 由实施方起草，供 Owner 转交。你不必信任本文件的任何结论——它们都是**待证伪的断言**，不是事实。

## 你是谁，不是谁

你是 [Owner 决定](OwnerIndependentReviewerSuccessionDecision.md) 指派的继任独立评估者。原指派主体 `/root/project_list_auth_fix` 是一个已不存在的任务会话。

Owner 已授权你以 `/root/project_list_auth_fix` 这个字符串出具证词——**该标识代表由 Owner 指派的角色，不代表那个已结束的会话**。你不得声称自己是它，不得追认它的任何历史结论。你出具的每份接受必须记录：你自己的真实会话标识、Owner 决定的合并提交 SHA、以及「本接受不追认原会话任何历史结论」。

你**不是**实施方。实施会话是 `session_012ki2dPxTiJbPmgZu7AD3Nz`，它构建了 root6 控制器、选定了窗口、决定了额度 override、并起草了你将要审的全部文档。**不要把它的结论当作前提。**

## 背景（全部待证伪）

一次 non-production 资格运行（Clued Kernel Phase 2，Root5）的窗口在 `2026-09-11T10:21:05Z` 过期，而到期时刻硬编码在已评审的控制器源码里。实施方因此构建了 root6 后继控制器，绑定新窗口 `2026-09-12T00:00:00Z .. 2026-09-19T00:00:00Z`。

- 控制器：`scripts/phase2-qualification/control-context-verifier-root6-window10-successor/`
- 摘要：`72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145`
- 代际：`ctrgen_5e0440a95ac8ee257b9e4236cabd275b`
- 构建脚本：`work/root6-window10-migration/build-root6-successor.mjs`
- 实施方自己的验证器：`scripts/phase2-qualification/root6-readiness.test.mjs`（21/21 通过——**这是实施方写的，不要当作独立证据**）

## 预算现实

`charged_seconds` 为 10506 上限中的 9906（`5106 + 600×8`），每次预留固定 600 秒，`reserve_execution_budget` 另有 `series_n>=9` 拒绝第十次。**恰好只剩一次分配，没有重试。** 一个被漏掉的缺陷就是这一次分配。

这是你严格的理由。

## 你要审什么

1. **root6 控制器源码** —— 特别是相对前代 `control-context-verifier-root5-window5-forward11-successor/`（摘要 `ac7bdd53…`）的全部差异。逐字节 diff，自己判断每一处改动是否必要、是否正确、**是否完整**。同样重要：**本该改而没改的**。
2. **容量适用性继任文档** —— 须钉住 `72d9eb92…` 与 `source_refs_maximum: 133`。这是解除当前阻塞的关键件。
3. 资格与运行时验收继任文档、StatusManifest generation 24 主体、第二十次绑定前推材料。

## 三件实施方已知有问题、但未经独立评审的事

**不要默认接受实施方对这些的辩解。**

1. **前推额度 15 → 16**（[记录](OwnerForwardCapExtensionOverride.json)）。与 `BoundedSeriesApplicability20260910.json` 的 `excluded` 字段**逐字冲突**——该字段原文含 "cap extension"。经 Owner 单方批准，未经独立评审。代码不拦它（`context.mjs:165` 只执行三个布尔值，`excluded` 是散文），但冲突不因此消失。
2. **`source_refs_maximum` 131 → 133**。133 = 131 + 实施方为避免原地修改共享 signing 模块而新增的两个文件。同样需要新的 Owner 签署批准。
3. **窗口从 24 小时延长到一周**。理由是迁移需要多次 Owner 合并。

## 实施方已经犯过的错（假定还有同类）

它在本任务中已被抓到多次，**每次都是它自己没发现的**：

- 首轮只识别出 5 处阻塞点，实际 8 处跨 7 个文件。漏掉的两处各自足以毁掉最后一次分配，其中一处（`source-publication.mjs` 的死写 manifest 路径）会导致**运行成功但认证了错误的源闭包**。
- 把窗口下界前推到窗口起点，使 `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME` 在窗口内任何时刻均无解。它当时把这个改动当作**安全性改进**主张的。（已回退）
- 在 `acceptance_issued: false` 的文档上预盖受理时间戳。（已修）
- 覆盖 `supersedes` 导致溯源哈希消失。（已改为链式扩展）
- 编造了一条因果链（声称某检查经 `readControlUri` 到达，而该函数在该控制器中根本没有调用方），并把它写进了已推送的提交信息和 README。（已更正）
- 其重签生成器的「守卫」在 19 个字段中有 11 个是同义反复（把当前值当作期望值传入），因而其变更清单在**恰恰被整体替换的那些字段上**是自我实现的。（已补真实守卫）

## 具体建议的检查方向

- 逐字节 diff 控制器与前代，逐处判断
- 追踪每一个钉住控制器摘要、代际或状态载荷的产物——root6 重绑定是一次**扇出**，实施方第一次只碰了扇出的起点
- 冻结常量：`capacityDelta`、`qualificationLimits`、各处硬上限，以及它们在 Owner 已签署文档里的对应值
- 时序：`not_before ≤ approved_at`、`runtime.expires_at === registered.expires_at`（零余量）、`FULL_600_SECOND_WINDOW_REQUIRED` 的截止时刻
- 是否存在「能跑成功但产出无效结果」的路径——这类比直接失败危险得多

## 你的产出

一份编号发现清单，最严重的在前。明确区分：会导致**运行失败**的、会导致**静默产出无效结果**的、以及仅为瑕疵的。明确写出你**无法**从仓库文件独立验证的部分。

**发现未解决即不得出具接受。** 如果结论是「不该签」，就写「不该签」——那和签发一样是有价值的产出。

不要迎合。实施方已经两次错判问题规模，并且已经交付过一次有缺陷的同名文档。
