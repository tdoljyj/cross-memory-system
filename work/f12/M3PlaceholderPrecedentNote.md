# M3 载体占位符合并的先例考证（供 Round 32 裁定，父会话 2026-09-13）

问题：M3 候选带 28 个 `__PENDING_*__` 字面占位符。带占位符的授权文书能否交 Owner 合并？

实测两个先例（可复现命令附后）：

1. **NW-01 载体（M1 = 7c9f612b 树内版）没有任何字面占位符。**
   `git show 7c9f612b:artifacts/.../next-window-20260912/ExplicitOwnerApproval.candidate.json | grep -n PENDING`
   → 仅 `:4 "state": "PENDING_VERIFIED_OWNER_MERGE"`（状态字，指等待 Owner 合并动作本身）。
   NW-01 对「合并时不可知的值」的解法是写**取值规则**（如 merge committed_at + 86400s），
   不写占位符字面量。
2. **CP-01 一侧存在占位符先例**：`work/cp01/cp01-substitutions.json` 曾含
   `__MEASURED_ROOT6_ROOT_DIGEST_PENDING__`（4 处），模式是「载体批**编辑类**，
   实化值执行时量测并留档」。但注意其占位符载于 substitutions 工作件，
   **载体条款本体批的是类，不是带占位符的值**。

## 待裁定（不预支结论）

M3 的 28 个占位符分三种性质，或许应分别处理：
- **取值规则已在旁注字段写死**的（M3_NOT_BEFORE/EXPIRES_AT/OWNER_MERGE_COMMIT 等 T 族）：
  可效 NW-01 改为纯规则句，删字面占位符；或保留占位符 + A3/A4 校验器护栏（比 NW-01 更严）。
- **依赖后续产物**的（ROOT7_*、NW02_*、CP02_* 族）：本质是 registration/cp02 条款在批「形状+
  生成器世系」，效 CP-01 模式即可，占位符在不在载体里是表述选择。
- **载体自己声明「未出不得合并」**的（FORWARD_CAP_EXTENSION_OPINION 两个）：这两个**必须**
  在合并前实化 —— 载体条款已自缚，无争议。

倾向（仅倾向）：保留占位符 + 校验器护栏是**更强**的机制（NW-01 的规则句无人机器校验，
M3 的 A3 三方集合相等 + A4 无新时间戳是机器闸），先例差异应记录为「有意升级」而非违例。
但这是评审的裁定权。
