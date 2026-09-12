# CP-01 候选 SQL 已写成，送独立评审

**状态：`CANDIDATE_SQL_WRITTEN_NO_WRITE_PERFORMED`。**

**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**
本次对数据库只跑了 `select`（`pg_proc` 与三个 `STABLE` 只读函数）。

第九轮放行「候选 SQL 可以开写」。写成三个文件，在 `work/cp01/`：

| 文件 | 作用 |
| --- | --- |
| `cp01-substitutions.json` | **唯一真相**：19 处替换，逐条钉 `from` / `to` / 期望出现次数 / 所属授权类 |
| `build-cp01-sql.mjs` | 由上表生成下面两份 SQL；任何一条不属于 `cp01.permitted_edit_classes` 就拒绝生成 |
| `cp01-derive.sql` | **只读**推导，一条 `select`，可反复跑 |
| `cp01-apply.candidate.sql` | 正式事务，**尚未获授权执行** |

---

## 一、为什么是「两份 SQL」而不是一份写死函数体的脚本

三个函数体共 31,740 字符，**只存在于库里**。把它们经我手抄进仓库，正是
`end $$;` → `end $;` 那一类错误的产地——一个字节，所有计数钉都看不见，只有逐字节重放能抓到。

所以**两份文件里都不含任何函数体**。做法：

1. `cp01-derive.sql` 只读地在库内读 `prosrc` 与 `pg_get_functiondef()`，
   按替换表逐条折叠，输出后像摘要；
2. 我把那三个摘要**离线钉进** `cp01-substitutions.json`；
3. `cp01-apply.candidate.sql`（**由 JSON 生成，不是由我抄的东西生成**）在事务里重算一遍，
   与钉住的值不符就在发出任何一条 `CREATE OR REPLACE` 之前中止。

**因此抄写错误不可能静默通过**，而评估者可以自己只读跑一遍第 1 步复现同样三个值。

## 二、只读推导的实测结果（`2026-09-12T06:2xZ`）

19 处替换**每一处都恰好命中 1 次**，且在 `prosrc` 与完整 `CREATE` 语句两侧计数一致；
三个前像摘要与 `ControlPlanePreChangeRecord.md` 逐字相同（零漂移）。

| 函数 | 编辑数 | 前像 sha256 | 后像 sha256 | 字符数 |
| --- | --- | --- | --- | --- |
| `reserve_gate` | 7 | `a0112924…` | **`001dd6a6f29c42e96c7d3762699599cc0239dae2e57452076eafdfc555f032cd`** | 14,966 → 15,757 |
| `reserve_execution_budget` | 8 | `df6087f9…` | **`8ca141de9d006a353d176d739b8bbb21c7f7a4249f7f59af90a77888bc1b11c6`** | 13,404 → 14,195 |
| `append_status_manifest` | 4 | `94a444b9…` | **`84dee7d4c7470d7a077c6b360289a71702b9ef24473107eeeec2bfddc31321c4`** | 3,370 → 3,437 |

**离线交叉验证**：仅由替换表本身算出的长度增量为 `+791 / +791 / +67`，与库内实测逐一相同。
两个 `reserve_*` 增量相等，因为 G1–G7 与 B1–B7 逐字相同、B8 长度中性——这一点是独立佐证，
说明跑进库里的确实就是表里那 19 条。

## 三、本次侦察更正范围文档的两处

1. **`reserve_gate` 第 7 处编辑改的是死代码。**
   `reserve_gate:110` 是 `if 'GATE'='BUDGET' then`——恒假；111–113 行在该函数里永远执行不到。
   同一行在 `reserve_execution_budget:115` 写作 `'BUDGET'='BUDGET'`，那边才是活的
   （没有 B7，`2026-09-12T13:04:51Z` 之后一次预算都预留不了）。
   `ControlPlaneChangeScope.md` 第七节把两处并列为同等编辑，**不成立**。
   仍然改它，理由只有一条：保持两个实例可逐字比对。已在替换表里标 `unreachable_in_this_function`。

2. **`>= 89` 这个新分段边界是安全的，但理由与我原先想的不同。**
   注册 root6 的事件将占 sequence 89，我原先担心它会被新分段捕获而被要求声明 root6 预算体。
   实测 `reserve_gate:52` 的循环**只遍历 `BUDGET_RESERVED` 事件**，`:70` 的循环只遍历 attempts，
   注册事件两个都不是。另实测：当前 88 条事件、最大预算 sequence 85，
   所以收窄后的 `>=64 and <89` 仍覆盖全部既有 root5 期预算，`>=89` 之上此刻为空。

## 四、没有动的东西

- **那条已经坏了的 root 摘要守卫**（`reserve_gate:35` / `reserve_execution_budget:40`），
  一个字节都没动，在替换表里留成显式空槽 `R10_PENDING`。第十轮裁决之前不能动，
  它也不属于 `cp01.permitted_edit_classes` 任何一类。
  **若裁决把它放进 CP-01，它成为第 20 条，上表三个后像摘要全部作废重算**；
  生成器在编辑数不等于 19 时会拒绝出文件，正是为了不让这件事悄悄发生。
- `effective_execution_binding()`：事务开头一并断言其 `prosrc` 摘要，结尾再断言一次未变。
  它只能走追加式前推，不能 `CREATE OR REPLACE`。
- `append_status_manifest` 第 26 行那句已经过时的注释、第 30 行 `ordinary_root5_status_schema_required`
  这个已经名不副实的异常名：**都不改**。改注释和改异常名同样是字节变更，同样不属于五类之一。
  记在 `deliberately_not_edited` 里，不顺手动。

## 五、请评估者复核的四点

1. 只读跑一遍 `cp01-derive.sql`，独立复现第二节那三个后像摘要。
2. 第三节第 1 条：`'GATE'='BUDGET'` 恒假、G7 为死代码，这个判断对不对。
3. `cp01-apply.candidate.sql` 的守卫是否足够：四道前像断言（含不该变的那个）、
   每条替换的出现次数断言、`prosrc` 与 `CREATE` 语句两侧计数一致断言、
   后像摘要断言（`execute` 之前）、回读断言（`execute` 之后）、结尾未变函数断言。
   **有没有哪一道是可以被绕过的，或者哪一种失败模式六道全过？**
4. 第四节：把已坏守卫留在 CP-01 之外，与第十轮四条路中的 (c) 是一致的；
   若裁决选了 (a)/(b)/(d)，请一并说明第 20 条应当写成什么形状。

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
`cp01-apply.candidate.sql` **未执行**，且在 Owner 合并批准件、第十轮裁决、NW-01 完成之前不得执行。
本文件不签发资格、不构成授权。
