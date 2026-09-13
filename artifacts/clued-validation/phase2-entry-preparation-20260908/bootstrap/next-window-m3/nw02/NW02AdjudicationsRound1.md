# NW-02 草案裁定 · 第 1 轮（plan 作者 = 父会话）

对象：会话 J 的 NW-02 草案（提交 2a4d81e）与其 `NW02DraftNotes.md` 第 6 节开放点。
**本记录是 plan 作者裁定，不替代独立评审**；NW-02 执行前须经评审复核。

## 开放点 2（硬阻塞）→ 已解除：M3 取证件已产出

J 量不到合并签名的 verified 状态，因此留了三个哨兵而**没有写下未经量测的断言** ——
这个处置是对的，记一功。父会话此前已用另一路径量到该值，现按 NW-01 世系补出取证件：

- 取五份 API 响应（repo / commit / pulls / pr / tree），**PR 号修正为 164**
  （首次误取 165，那是尚未合并的 M4；`commits/<sha>/pulls` 实测只含 164，交叉证实）
- 跑 `work/twentieth-forward/capture-owner-merge.mjs --as approval`（**沿用世系脚本，
  不手写 JSON**），十项条件全过：私有库、恰两亲、committer=web-flow、
  verification verified+valid、恰一个合并进 main 的 PR、merged_by 是 Owner、
  树完整未截断、件唯一且 blob mode 100644、本地字节与合并树 blob id 相同、
  merged_at 存在且窗口取自 committed_at
- 产出 `next-window-m3/OwnerApprovalVerification.json`

主体件那三个哨兵可据此实化。**注意本件自述 `is_the_controller_verification: false`** ——
它是同条件的第二实现，不替代控制器运行时经 gh 的自证。

## 开放点 1（主体件形态）→ 裁定：我的派工写错了；采 A 案，但理由与 J 的不同

**先认错**：派工里写「代际相关处指向 root7、控制器摘要用 F12」。J 比对 NW-01 实样发现，
`current_control_root` 记的是**执行当时的活头**（NW-01 时是 root5，尽管那一窗随后注册 root6），
不是待注册代际。同构地 NW-02 的活头是 root6。**J 是对的，派工是错的。**
C 案（把 root7 塞进 `current_control_root`）会写下当时并不成立的事实且与 preflight 的
`root_head_ok` 守卫自相矛盾 —— **确认否决**。

**A vs B 的关键事实（实测，J 未测到这一层）**：
- 控制器源码里 `subject_sha256` **零命中** —— 控制器根本不读它。
- 活库唯一消费方是 `accepted_binding_subject_sha256_check`，实测定义为
  `CHECK (subject_sha256 = '64ae7adc…')` —— **只钉摘要值，不校验形态**，
  且该检查正是 M3 载体 `allowed_replaced_checks` 授权替换的三个之一。

**推论：主体件的形态不被任何闸门校验。** 于是「两窗形态稳定」从来不是被强制的不变量，
只是碰巧如此；A 案不存在「打破被评审背书的形态」这一风险，J 的顾虑可以降级。
既然形态是纯记录选择，取**能让日后读者自证的那个**：A 案的
`window_generation_and_controller` 键连同 `generation_registered_by_this_subject: false`、
`nw02_precedes_generation_registration: true` 两个显式标志，使主体件在被哈希的那一刻
就自述了本窗身份与次序，优于让窗口的控制器身份缺席。

**裁定：采 A 案（22 顶层键），`current_control_root` 保持活头 root6 不动。**

## 开放点 3（proposal_path）→ 留待评审

M3 没有 `OwnerApprovalProposal.md` 同名件。父会话不在本轮拍板 —— 它不阻塞
subject_sha256 的形态决定，且候选三份各有理据，宜由评审一并裁。

## 后续必须的次序

主体件定稿（A 案 + 三哨兵实化）→ 其 sha256 = `subject_sha256` → 三份受理/证据件重出
（链上摘要随动）→ `build-nw02-sql.mjs` 重生成 → **独立评审** → 执行。
