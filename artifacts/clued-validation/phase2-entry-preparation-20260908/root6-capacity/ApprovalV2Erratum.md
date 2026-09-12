# 勘误：①v2 内部两个字段互相矛盾（R3-F1）

**状态：`ERRATUM_RECORDED_SOURCE_DOCUMENT_DELIBERATELY_UNCHANGED`。**

由实施方记录，回应继任独立评估者（会话 `session_018nf6mQ5CQuMFadoJ9WRZCN`）第三轮 R3-F1。

## 矛盾在哪

`Root6OriginalInput4000000CapacityApproval20260912.v2.json` 同时含有：

- `what_changed_from_predecessor.conflicts_with` —— **仍主张**抬高 `source_refs_maximum` 与 `BoundedSeriesApplicability20260910.excluded` 的 "cap extension" 条款冲突
- `governing_exclusion_analysis` —— **已撤回**该读法，并说明撤回理由

同一份文档既主张又撤回。这是实施方的疏漏：撤回该定性时改了后者，忘了前者。

**以 `governing_exclusion_analysis` 为准。** 撤回的理由是继任评估者的归谬：`excluded` 管的是 root3 appendix 自己那套 scope 上限，而 `source_refs_maximum` 在 `capacity_delta` 里，属既有补充层，已走过 128 → 130 → 131 三次正路。按逐字读法那三次也违规，整条容量补充链连同本轮依赖的 4,000,000 字节上限一并作废。

## 为什么不直接改掉

评审者的原话是「控制器不读这两个字段，建议下次触动时一并改」。**该建议在它出具 ② 与 ④ 之后已不再适用**，因为两份文档都逐字节钉住了 ①v2：

| 文档 | 字段 | 钉住的值 |
| --- | --- | --- |
| ② 容量适用性 | `approval_ref.sha256` | `80d0566a8a6dd899d7d53648cd0f0fccac45fd81878ee909630aac71186a4ffc` |
| ④ 043 修复接受 | `capacity_approval_ref.sha256` | 同上 |

而 ①v2 当前 sha256 正是该值。**改动其中一个字节即改变 sha256，② 与 ④ 同时失效，继任评估者须重新出具两份文档。**

代价与收益不成比例：这两个字段控制器从不读取，矛盾只影响人类读者；而修复它要作废两份已独立出具的验收。故 ①v2 **逐字节保留**，矛盾以本勘误消解。

## 若将来确需修改

必须整批重做：新的 ①v3 → 继任者重出 ② 与 ④ → 三份一并合并。不得单独改 ①。

## 记录

- 发现者：继任独立评估者，第三轮 R3-F1，非阻塞项
- 实施方独立复核：已确认矛盾存在，且已确认修改会使 ②④ 失效（重算三份 sha256 比对）
- ①v2 未改动，`80d0566a…`，由 Owner 合并 `01ea76755526c2d20b93dc56b06ed6f24be801c1` 发布
