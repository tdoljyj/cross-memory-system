# R29 —— 受理件 late_bound 状态载荷死锁：在预留之前抓到

**状态：`FINDING_ONLY_RESERVATION_NOT_MADE`。分配未烧：`charged_seconds` 9906/10506 原封。**
发现时刻：2026-09-13T03:3xZ，步骤 16 前置清点（执行单「1–6 全真才预留」）过程中。
发现人：实施方（本次不是评审拒签 —— 是预留前置纪律直接命中）。

## 死锁本体（每一环都已实测）

活绑定的运行时受理件（`fb389314…`，第 20 次前推钉入）内部自相矛盾：

1. `accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256 =
   f4002ae44595739b4ae230eb97ab50e54a3774fd68b7943fef26e5c1d6b43cd8`。
   【实测】它恰是 **SignedStatus23 载荷**（减 signature_binding，sorted+compact+LF）的摘要：
   该载荷 `schema_digest 76bb79f7…`、`observations.controller_digest ac7bdd53…`、root5 代际。
2. `accepted_subject.control_schema_refs.StatusManifest.sha256 = 510f3b90…`，
   且 `context.mjs:348` 将其钉死于控制器本地 `status-manifest.root5.schema.json`
   —— 该文件冻结在 68133f2d 内，【实测】sha256 = `510f3b90…`。

GRR 终态验收（`context.mjs:349` 与 `:357`）同时要求：
`sm.schema_digest === 510f3b90` **且** `canonicalDigest(sm 减 signature_binding) === f4002ae4`。
后者钉的是一个 `schema_digest=76bb79f7` 的载荷。**互斥，无解。**

`:357` 对 FAIL/BLOCKED 终态无豁免（`:351` 的 nonPass 豁免只覆盖 expires 检查）——
预留后跑 600 秒，连失败收据都写不进，attempt 永远非 terminal，
`NO_UNKNOWN_ACTIVE_OR_PENDING_BEFORE_NEXT` 会堵死一切后续。

修复也被堵：改受理件字节 → `EXACT_METADATA_BYTES_REQUIRED` 失配活绑定 →
需要第 21 次前推 → 【实测】`series_f` 现值 16，活库 `reserve_gate` G3 为 `series_f>16` 拒 →
第 21 次前推后 GA 签不出。CP-02（16→17）需要新的 Owner 授权载体。

## 根因

`f4002ae4` 自 v16 模板经 v17 带入 v19。受理件的原子翻转（R28）与 R24–R27 的每一张
to_accept 清单都不含 `late_bound_fields` —— 它不在 capacity 链上，从未被任何一轮重算。
**第十三个「验证在不可能失败的轴外完成」实例；与前十二个不同，这次抓在分配烧掉之前。**

## 抓到它的机制

执行单第 16 步的作业规则：「1–6 逐项留下可核的输出再预留」。清点条件 5（GA 离线构造）
时追 `status_manifest_ref` 的验证链到 `:357`，随手重算了 `f4002ae4` 的原像 —— 命中 Status23。

## 已完成且不受影响的（本窗口成果，全部保留）

- root6 已注册（事件序列 6，head 已是 root6 代际）
- CP-01 已应用并独立回读（21 编辑，三后像命中，`effective_execution_binding` 未动）
- 第 20 次前推已提交（执行序列 89，活绑定 = 68133f2d / e7cfb30b / fb389314）
- `verifySourcePublication` 端到端首次跑通（142 blob 全量、153 路径双树比对、Owner 合并链）
- 前置 1（宿主二进制）、2（dockerd + 以 v.IMAGE 真建容器）、3（清单 314/314）、4 已留档

## 修复路径（下一 Owner 窗口）

1. 定稿 Status24 载荷（schema 510f3b90、root6 代际、新窗口、observations 含 68133f2d 与
   GA 三代际、source_digests/source_refs 按 :350-353），算其规范摘要
2. 受理件 late_bound 换为该摘要（及其它随动字段），M3 合并
3. 第 21 次前推（白名单 →21，生成器再走一轮评审）
4. CP-02：G3/B3 16→17（需 Owner 新授权载体）
5. Status24 经 append_status_manifest 追加（A1/A2 已容许 510f3b90）
6. 再走 16–20

## 边界

未预留、未签 GA、未跑 600 秒。本文件只登记，不修复。
