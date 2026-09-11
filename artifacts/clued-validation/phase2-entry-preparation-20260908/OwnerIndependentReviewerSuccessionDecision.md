# Owner 决定：独立评估者继任

**状态：`PROPOSED_PENDING_OWNER_MERGE`。** 本文件由实施方起草，记述 Owner 在会话中给出的两项指示。它在 Owner 通过 owner-merge 签名链合并之后才成为 Owner 背书；在那之前，它是实施方对指示的记述，应当据此阅读。

本决定**只**指派一项评估者身份。它不接受任何对象、不签发任何资格、不创建 GA/GRR/Entry，也不视为任何 Gate 已通过。

核查版本：`3c8d2fa`（分支 `claude/nice-fermat-njqlmm`）。

## 为什么需要这个决定

[原 bootstrap 授权](AuthorityUnblockProposal.md)把独立验收绑定在「当前真实任务 `/root/project_list_auth_fix`」上，并明确要求：**审阅者参与实现或无法保持独立性则停止，不自行换人**。

该身份是一个任务/会话工作目录，不是服务、工具或人。本次核查确认它在当前执行环境中不存在，且仓库内没有任何可重新调起它的入口。这不是「找不到工具」，而是**被指派的评估主体已经消失**。原规则禁止实施方自行更换评估者，因此只有 Owner 能决定继任。

## 为什么现在必须解决

此前判断「评审者继任不阻塞合并」。**该判断已不成立。** 对抗性复核确认了两项只有新的 Owner 签署容量材料才能解除的阻塞：

| 阻塞 | 机制 |
| --- | --- |
| 容量适用性钉住旧控制器摘要 | `context.mjs:130` 直接比较 `d.controller_digest === s.expected_ga.controller_digest`。被钉住的适用性（sha256 `cc3db45b…`）载明 `ac7bdd53…`（root5），而 root6 需要 `72d9eb92…` |
| `source_refs_maximum: 131` | 冻结在 Owner 签署的容量批准（`f3afb108…`）与独立适用性中，经 `same(capacity_delta)` 逐字节比对。root6 声明 133 条有序源引用 |

而 `context.mjs` 有 **4 处**硬校验要求 `independent_reviewer === '/root/project_list_auth_fix'`，容量适用性正是其中之一。改这 4 处等于实施方重写约束自身的检查（自我认证，原规则禁止），且**照样躲不开**重签 Owner 的容量批准。

因此：**在本决定生效前，本轮运行无法推进到最后 600 秒。**

## 决定一：继任主体

继任独立评估者为**另行启动的、独立的 Claude Code 会话**，须同时满足：

| 要求 | 具体约束 |
| --- | --- |
| 非实施方 | 不得是本次实施会话 `session_012ki2dPxTiJbPmgZu7AD3Nz`，也不得是其派生的任何 subagent。该会话构建了 root6 控制器并起草了全部待审文档 |
| 未参与实现 | 未参与 root6 控制器源码的产生、窗口选择、前推额度 override 的决定，或本决定文本的起草 |
| 只读 | 只读实施方产出与源码，独立提出发现；不代写、不修补、不替实施方决定 |
| 发现优先 | 发现未解决即不得出具接受 |
| 如实自述 | 其出具的每份接受须记录自身真实会话标识、本决定的 Owner 合并提交、以及「本接受不追认原 `/root/project_list_auth_fix` 会话的任何历史结论」 |
| 不得再自行换人 | 若继任者被卷入实现或无法保持独立，停止并回到 Owner |

## 决定二：身份标识

控制器源码硬校验 `independent_reviewer` 字符串。Owner **授权**继任者以 `/root/project_list_auth_fix` 出具证词，并在此写明：

> 该标识自本决定起**代表由 Owner 指派的独立评估者角色**，不代表任何已结束的会话。

选择此路而非修改控制器源码的理由：修改那 4 处硬校验会再次改变 controller digest，触发整条资格链重做并多一次 Owner 合并，且由实施方改写约束自身的检查本身即违反原规则。

继任者**不得**声称自己是原 `/root/project_list_auth_fix` 会话，也不得冒用历史 `evidence_review` 身份。

## 评估范围

**仅限**下列材料，且仅在本用途内：

1. **root6 控制器源码** `scripts/phase2-qualification/control-context-verifier-root6-window10-successor/`，摘要 `72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145`
2. **容量适用性继任文档** —— 须钉住上述摘要与 `source_refs_maximum: 133`
3. **有界序列适用性**（若重签需要）
4. **资格与运行时验收继任文档**
5. **StatusManifest generation 24 主体**
6. **第二十次绑定前推材料**

**不含**：任何 GA、GRR、Entry、性能资格、生产权限，或任何范围扩大。

## 继任者必须独立判断的既有缺口

下列事项已由实施方记录，但**未经独立评审**。继任者应当独立判断它们是否可接受，而非默认沿用实施方的结论：

- **前推额度 15 → 16**（[OwnerForwardCapExtensionOverride.json](OwnerForwardCapExtensionOverride.json)）。与 `BoundedSeriesApplicability20260910` 的 `excluded` 条款逐字冲突（该字段含 "cap extension"），经 Owner 单方批准，未经独立评审。
- **`source_refs_maximum` 131 → 133**。同一性质：需要新的 Owner 签署批准，而 133 = 131 + 为避免原地修改被 64 份产物钉住的共享 signing 模块而新增的两个文件。
- **窗口从 24 小时延长至一周**（至 `2026-09-19T00:00:00Z`）。理由是迁移需要 3–4 次 Owner 合并，窗口中途失效会导致整轮重做。
- **实施方已犯过并被复核抓到的错误**：曾把窗口下界前推至窗口起点，导致 `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME` 在窗口内任何时刻均无解（已回退）；曾在 `acceptance_issued: false` 的文档上预盖受理时间戳（已修）；曾覆盖 `supersedes` 丢失溯源（已改为链式扩展）。继任者应当假定仍有未被发现的同类错误。

## 边界（不变）

不重复应用 SQL9、不新增容量、不退款、不复用旧预算；不创建新 trust root、新签名身份、付费/模型预算或生产权限；不把 CI 未启动记为通过；不把准备性审查当成 19 项真实 observation。

原 `/root/project_list_auth_fix` 已出具的历史接受按原字节保留，**不被本决定追认、撤销或重写**。第十九次绑定前推（sequence 88）与已入库的 Status23（generation 23）均已发生，不因本决定改变。

## Owner 批准方式

合并携带本文件的 PR，使用**创建合并提交**（非 squash、非 rebase），base `main`，由 `tdoljyj` 本人在 GitHub 上点击合并。该合并提交的 SHA 即本决定的权威依据，继任者须在其出具的每份接受中引用它。

## 若本决定不被合并

本轮资格运行在当前证据下无法继续：容量适用性签不出，资格链无法重建，最后 600 秒预算不得分配。已完成的部分（root6 控制器、第十九次前推、Status23、全部复核结论）按原字节封存，不作废也不追加。这不是可以靠工程手段绕开的缺口——缺的是一个合格的、非实施方的评估主体。
