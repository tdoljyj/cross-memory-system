# 第 11 代活化套件

改编自 `work/root10-single-window/stage2/activation/build-root10-activation.mjs`。
一笔事务完成 5 个执行事件：注册 132、准备 133、合格 134、运行时重指向 135、
本代唯一一次预算 136；并生成本代次专属的 `read_root`、`reserve_execution_budget`、`reserve_gate`。
计数器只增不减，从 `11706/2604247987` 走到 `12306/2738465715`，无退款、无重置、无重分配、
无容量释放、不签发 GA、不重试。

## 相对第 10 代改了什么

70 处改动，全部带出现次数断言，漏改或多改会立刻失败。

**代次序号**：`EXPECT` 从 `9/112/113/114/115/116/117/17/10` 改为 `10/131/132/133/134/135/136/18/11`。

**身份**：新增常量 `ROOT10`（本代前驱）。`ROOT9` 保留，因为预算/attempt 的历史阶梯与
第 9 代根事件仍然指向它——**历史不能改写，只能往上加一级**：

```
预算代次阶梯   >=136 第 11 代      >=117 且 <136 第 10 代（新增）    >=98 且 <117 第 9 代 …
attempt 阶梯   同上
根事件         第 9 号第 9 代（保留）  第 10 号第 10 代（由"本代注册"降为历史）  第 11 号第 11 代（新增）
```

第 10 号根事件原先按字段逐项比对且引用 `fixed_root`（即本代载荷）。它现在是历史，
改为按第 10 代的实际取值比对，并补一条"根事件 1..10 整体摘要"的钉死值
`ad34a824…`（与 ≤6、≤8 两条同法，算法已由 ≤8 复现 `48be880b…` 验证）。

**约束枚举**：`budget_sequence_floor` 与 `predecessor_generation_id` 两条 CHECK 各保留第 10 代那一级，
顶上加第 11 代。

**read_root 改写锚点**：现网的 `read_root` 已被第 10 代活化改写过，元数据分支是两代枚举、
`state` 的第一段是第 10 代，锚点相应更新为两代形态。

**第 9 代收尾常量不动**：`closure` 的 102/111/112、`slice(0,110)`、六个历史 attempt 的摘要、
≤6/≤8 的根前缀摘要，指的都是不会再变的历史。

## 离线复制品验证

复制品由 2026-09-16T05:10Z 的生产 `pg_dump` 重建，再应用迁移 01，停在执行序号 131——
与生产逐位一致（`events 1..130` 摘要 `7767991d…`、其余 attempt 摘要 `bdd3b631…` 两边相同）。

1. `root11-activation.full-rollback.sql`（与 apply-once 逐字节相同，只差最后一句 `rollback`）
   **通过**，后像：root 11 / 执行 136 / attempt 18 / 12306 秒 / 2738465715 字节 /
   `pending_budget_sequence=136` / `active_ga_id=null`；回滚后复制品准确回到 131。
2. `root11-activation.apply-once.sql` **通过**。`read_root` 对第 11 代返回
   `STORED_NO_GATE_AUTHORITY`，`effective_execution_window` 给出 7 天窗口与 floor 136，
   `effective_execution_binding` 指向新控制器 `fc6ca175…` / 资格 `cc385768…` / 验收 `171f8e32…`。

复制品上曾遇到两处**环境差异**（非套件缺陷）：生产的 `pg_dump` 用了 `--no-owner --no-privileges`，
函数属主与 ACL 需先对齐生产才能通过前检；对齐后 23 个函数的 ACL 与生产逐条相同。

## 尚未验证

`reserve_gate` 生成后还没有真正签发过 GA——需要先构造第 11 代的 51 字段 GA 载荷。
`reserve_gate.actual-negative-fixtures.json` 列出的负向探针也还没跑。
这两项在生产执行活化之前会在复制品上补齐。
