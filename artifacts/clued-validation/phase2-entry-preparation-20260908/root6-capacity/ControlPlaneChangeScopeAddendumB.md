# 补遗 B：取代范围文件的第七节「数据变更」与第十节「执行顺序」

**状态：`ADDENDUM_SUPERSEDES_TWO_SECTIONS_NO_WRITE_PERFORMED`。**

答复第八轮 R8-F1 与 R8-F3。**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

`ControlPlaneChangeScope.md` 第七节把 `accepted_binding` 的变更写成「数据变更（1）」一行一列，
第十节把它和三个函数塞进同一个事务、守卫只守四个 `prosrc` sha256。**那样写候选 SQL，第一句必被拒。**
本补遗取代那两节。第七节的**三个函数 19 处编辑清单不受影响**（评审 C3 逐行确认无一错位），
被取代的只是「数据变更（1）」那一项和整个第十节。

---

## 一、NW-01 的真实形状（取代第七节「数据变更（1）」）

依既有先例 `next-window-20260911/NW01ApplyCandidate.sql`。它不是一条 `UPDATE`，是
**前置守卫 → 停触发器 → 落三条 CHECK → 改七个字段 → 以新值建回三条 CHECK → 恢复触发器 → 回读**，
全部在一个事务内。

### 1.1 前置守卫必须守的东西（本轮取值，`2026-09-12` 读取）

范围文件只守四个 `prosrc` sha256。**必须扩展**，因为本次要动的恰好是它没守的两类对象：

| 对象 | 守卫方式 | 当前值 |
| --- | --- | --- |
| `accepted_binding_check` | `pg_get_constraintdef` | `CHECK (expires_at <= '2026-09-12 13:14:51+00'::timestamp with time zone AND expires_at > not_before)` |
| `accepted_binding_owner_approval_commit_check` | `pg_get_constraintdef` | `CHECK (owner_approval_commit = '4498102661f626c8e0c489c7d27551acbc8436ea'::text)` |
| `accepted_binding_subject_sha256_check` | `pg_get_constraintdef` | `CHECK (subject_sha256 = '46867dca9fcdda12580fafe429e07f2e1c71d5ae9d8338a03c1f57221debe1b8'::text)` |
| `accepted_binding_immutable` 启用状态 | `pg_trigger.tgenabled` | `O` |
| `accepted_binding_immutable` 定义 | `pg_get_triggerdef` | `CREATE TRIGGER accepted_binding_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON clued_control.accepted_binding FOR EACH STATEMENT EXECUTE FUNCTION clued_control.deny_mutation()` |
| 表 owner | `pg_get_userbyid(relowner)` | `postgres` |
| 表 ACL | `relacl::text` | `{postgres=arwdDxtm/postgres}` |

另沿用先例的其余守卫：八张表存在、`current_database()`、`project_ref`、全表 rows/catalog 摘要 CAS、
`current_head` 的代际与 `revoked=false`。

**R9-F6 追加两条**（上面七项守的是「这三条 CHECK 与这个触发器长什么样」，
守不住「有没有多出来别的东西」；§1.1 末尾「全表 rows/catalog 摘要 CAS」是否覆盖
`pg_constraint` 措辞含糊，写明比推测好）：

| 对象 | 守卫方式 | 当前值（`2026-09-12` 实测） |
| --- | --- | --- |
| `accepted_binding` 上的约束条数 | `count(*) from pg_constraint where conrelid=…` | **16** |
| 全部 `conname` 的排序摘要 | `sha256(string_agg(conname,',' order by conname))` | `12b67839ac1caad7d61979d3a19a39c66c39fa537236dae2231ae2608fd0b031` |

**事后回读时同样断言这两项**，并断言 `tgenabled` 已回到 `'O'`。

### 1.2 变更本体

```sql
alter table clued_control.accepted_binding disable trigger accepted_binding_immutable;

alter table clued_control.accepted_binding
  drop constraint accepted_binding_check,
  drop constraint accepted_binding_owner_approval_commit_check,
  drop constraint accepted_binding_subject_sha256_check;

update clued_control.accepted_binding
set not_before=<T>, expires_at=<T+24h>,
    owner_approval_commit=<第一次 Owner 合并 commit>,
    subject_sha256=<新 subject>,
    registration_acceptance_sha256=<新 registration acceptance>,
    store_acceptance_sha256=<新 store acceptance>,
    signature_evidence_sha256=<新 signature evidence>
where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';

alter table clued_control.accepted_binding
  add constraint accepted_binding_check
    check (expires_at <= <T+24h>::timestamptz and expires_at > not_before),
  add constraint accepted_binding_owner_approval_commit_check
    check (owner_approval_commit=<新 commit>::text),
  add constraint accepted_binding_subject_sha256_check
    check (subject_sha256=<新 subject>::text);

alter table clued_control.accepted_binding enable trigger accepted_binding_immutable;
```

**七个字段一起改，不是只改 `expires_at`。** 只改窗口会让该行声称一个 Owner 从未批准过的窗口，
同时继续指向旧的批准 commit 与旧 subject。

### 1.3 事后回读

沿用先例：重新读三条 CHECK 定义、触发器 `tgenabled` 与定义、owner/ACL、行内容，
并断言除那七个字段外全表其余部分未变。

### 1.4 NW-01 与 CP-01 是**两个**事务

范围文件把它们写成一个。应当分开：

- NW-01 是已评审过的 DDL 序列，形状固定，不应混入别的变更
- CP-01 是三个函数的 `CREATE OR REPLACE`，守的是 `prosrc` 摘要
- 分开则任一失败不牵连另一个，各自回读独立

---

## 二、执行顺序（取代第十节）

### 2.1 需要**三次** Owner 合并，不是两次

这是本补遗最重要的一条，范围文件与补遗 A 都只算到两次。

| # | 合并内容 | 为什么不能与别的合并合并 |
| --- | --- | --- |
| 1 | `next-window-20260912/` 的 proposal + approval | **它的 `committed_at` 就是窗口的 `not_before`。** 在它之前，窗口时刻不存在，后面所有以窗口为参数的东西都写不出来 |
| 2 | 重建后的控制器 + 七份重签文档 + subject 三件套（共十件） | 全部以 `T+24h` 为参数，故必须晚于第 1 次；且 subject 需被签署后才能产出 signature evidence |
| 3 | root6 注册体 | **`metadata_binding_sha256` 是整行 `accepted_binding` 的摘要，NW-01 一改就变**，而 NW-01 需要第 2 次合并产出的 signature evidence。循环无法拆解，只能再来一次合并 |

第 2 次能把控制器重建、七份重签与 subject 三件套合在一起，是因为它们都只依赖 `T`，
第 1 次合并后即可全部产出。**这一步把原本可能的四次合并压到三次。**

### 2.2 完整顺序

```
 1. Owner 合并 next-window-20260912 的 proposal + approval        → commit C₁，时刻 T
 2. 从 GitHub API 捕获该合并 → OwnerApprovalVerification.json      （stage 0）
 3. 重建控制器：root6Expiry = T+24h                                 rebuild-controller-window11.mjs
 4. 重签七份文档（拓扑序）                                          reissue-seven-documents.mjs
 5. 换发 subject 三件套                                             reissue-continuation-subject.mjs
 6. Owner 合并第 3–5 步的十件                                      → commit C₂
 7. 从 GitHub API 捕获该合并 → ContinuationSubjectSignatureEvidence （stage 2）
 8. NW-01：七字段 + 三 CHECK + 触发器，前置守卫按 §1.1，事后回读
 9. CP-01：三个函数 19 处编辑，前置守卫四个 prosrc，事后回读
10. 重新导出 read_root（metadata_binding_sha256 此时已变）
11. 构造 root6 注册体并离线跑通 validateRootShape                  build-root6-registration.mjs
12. Owner 合并注册体                                              → commit C₃
13. append_event 注册 root6                                        ← 不可回退，见 §2.4
14. 第 20 次绑定前推
15. Status24（引用重签后的运行时受理）
16. 预算预留（唯一一次，不得重试）
17. GA 签发
18. 600 秒运行
19. 19 项 PQUAL 观测
20. GRR
```

### 2.3 为什么 NW-01（第 8 步）必须早于 CP-01（第 9 步）

`append_event:16/22` 要求 `clock_timestamp()` 落在 `accepted_binding` 窗口内。
当前窗口 `2026-09-12T13:14:51Z` 到期后，**注册 root6 所需的 `append_event` 就不可用了**。
NW-01 是解除这个时钟压力的那一步，且它本身不走 `append_event`、不受窗口管辖。

CP-01 早于注册（第 13 步）的理由由评审 C9 独立确认：`append_event` 不要求活动头为 root6，
只要求 `predecessor_generation_id` 等于当前头（现为 root5），
而 `generation_reuse_or_rollback` 只禁止重复注册同一代际。
所以第 9 步到第 13 步之间三个被改的函数处于「要求 root6 而头仍是 root5」的空档，
**这段时间内没有任何步骤调用它们**，顺序安全。

### 2.4 可回退性：分两段，范围文件没答

- **第 8–12 步：可回退，且窗口宽裕。** NW-01 之后窗口是 `T+24h`，
  `append_event` 有整整一天余量，可以从容重做，或把三个函数 `CREATE OR REPLACE` 改回去。
  评审指出的这一点应当照录：**留在旧窗口里，任何一步失败一旦跨过 `13:14:51Z`，
  `read_root` 立即返回 `EXPIRED_OR_NOT_YET_VALID`，连修复所需的函数都不能用了。**
- **第 13 步：不可回退。** `events` 只追加；`append_event` **不校验 body**（`:13` 只检查是 JSON 对象）；
  `:36` 禁止重复注册同一代际。一份写错的注册体会被库收下、被控制器拒绝，
  `ctrgen_5e0440a9…` 就此报废。

**所以真正「不要赶时间」的不是第 8 步，是第 13 步。**
函数改坏了还能改回来，代际注册错了不能撤。第 11 步的离线 `validateRootShape` 因此不是可选项。

> 补充一条本轮实测、影响该离线校验有效性的事实：`root-window-validation.mjs` 依赖 ajv，
> 而其注释指明 Ajv6。本环境初装得到 ajv 8，对该 schema 直接报错——
> **危险的不是报错，是在错误的 ajv 下跑会看起来像通过却什么都不证明。**
> 取得 ajv 6.15.0 后（**用 `npm ci`，不要 `npm i ajv@6`**——后者会改动 `package.json`
> 与 `package-lock.json` 两个受版本控制的文件，而 `HEAD` 版 lock 里
> `packages["node_modules/ajv"].version` 本来就是 `6.15.0`，见 R9-F7），
> 控制器 manifest 钉住的 41 个 ajv 文件与本地逐字节一致（41/41），
> 该离线校验此时才是可信的。**执行者必须先做这个比对，再相信校验结果。**

---

## 三、并入第八轮的三条小修正

- **R8-F5**：`append_status_manifest` 最后一次真正写入是 **`2026-09-10T14:49:49Z`**
  （迁移 `20260910144949`），不是范围文件写的「09-11 07:20」——那是文件 mtime，不是变更时刻。
  「双重无解」收紧为**一重**：`:29`（恰为 `2026-09-11T10:21:05Z`）与 `:34`（`> clock_timestamp()`）
  不可同时满足；`:35` 目前满足，第二重只在「改了 `:29` 却不动 `accepted_binding`」时出现。
- **R8-F6**：`2026-09-12T13:14:51Z` 是 **5 处**不是 3 处
  （`reserve_gate:33,112`；`reserve_execution_budget:38,117,125`），以第七节的表为准。
  **这 5 处在 CP-01 中一律改为 `T+24h`。**
- **R8-F7**：`reserve_gate:110` 是 `if 'GATE'='BUDGET' then`，恒假，故 `:112` 是死代码
  （由 `reserve_execution_budget:115` 套模板生成）。仍照改以保持两函数同构，但应标注：
  `reserve_gate` 真正的时钟约束在 `:33` 与经 `read_root` 的 `STORED_NO_GATE_AUTHORITY`；
  `:111` 的 `series_n>=3` 同样是死的，不必因其与 9 不一致而担心。

---

## 四、仍然缺、且不在本补遗范围内的

1. **`series_f` 的授权**（R8-F4）。数据库侧抬高从未被授权——那份 override 只写了控制器里的一个常量。
   采纳评审建议：走**换发补充适用性文件**这条正路（`context.mjs:164` 要求
   `independent_reviewer === '/root/project_list_auth_fix'`，该身份本轮已由 Owner 授权），
   不再用 override。**此事待 Owner 定夺，未做。**
2. **stage 0 与 stage 2 的 GitHub 捕获**：需要真实 PR 存在后才能产出，逻辑可预先写。
3. **`reissue-seven-documents.mjs` 的 reissue 链**：需按答复第三节处理 v1（保持不变）与 v2（重签）。

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件取代范围文件两节，不接受任何对象、不签发任何资格、不构成授权，也不是候选 SQL。
