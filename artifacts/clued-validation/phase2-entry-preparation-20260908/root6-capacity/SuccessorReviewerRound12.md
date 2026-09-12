# 继任独立评估者 · 第十二轮复核与受理

**评估者身份：`/root/project_list_auth_fix`（与第八、九、十、十一轮同一身份）。**
**议题：NW-01 落库复核，以及 root6 注册评审主体的独立受理。实施方分支 `claude/nice-fermat-njqlmm`，HEAD `023b363`。**

**结论前置：七项全部通过，我签发受理。**
`artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/Root6RegistrationAcceptance.json`，
`review_subject_sha256` = **`293da3c512f63a9b1f7b3d07fa3282975917cac3bb94ccf831f03707bb3b572b`**，
`authority_effect` = `NONE`，`root_registered` = `false`。

**但受理之后仍有两条必须先闭合，实施方不能直接构建最终注册体 —— 见第八节 R12-F19 与 R12-F21。**
最重要的新发现是 **R12-F9**：占位符缺席的证明写在了分支的错误一侧 —— 真正会提交的那条路径（非 `--acceptance-pending`）不做这项检查，我实测让它输出了一份 `independent_acceptance_ref` 全为 0 的、形态完整的可提交请求。
次重要的是 **R12-F21**：CP-01 并不需要排在注册之前，而当前的 9d→9f 次序制造了一段「守卫指向一个尚不存在的 root」的区间。

---

## 零、取证方式与边界

复核时刻：**2026-09-12 08:43Z – 09:06Z**（各条给出各自的测量时刻）。

1. **数据库**：全部经 `execute_sql` 的只读 `select`，共 6 次。**没有 `insert`/`update`/`delete`/任何 DDL、没有 `apply_migration`、没有执行任何 `do $$ ... $$` 块。** 只读 `STABLE` 函数中我只调了 `read_execution()` 与 `read_root()`。
2. **未调用**：`append_event`、`reserve_gate`、`reserve_execution_budget`、`append_status_manifest`、`rotate_execution_generation`、`commit_gate_result`、`execution_transition`、`record_effect_intent`、`dispatch_recorded_intent` —— 一次都没有。
3. **【沿用第十一轮已声明的取证面】** 我在会话临时目录的一份独立仓库副本（`git archive impl | tar -x`）里运行了实施方的 `build-root6-registration.mjs`，并在该副本的 `apps/clued-cloud` 下 `npm install ajv@6.15.0`。**实施方检出的任何文件未被修改**；我的测试产物全部落在临时目录，测试中产生的一个杂散文件已删除。该脚本不连数据库。
4. **快照**：我**自己**从库里导出了 `read_root` 快照（见 R12-F4），没有采信实施方的文件。
5. **GitHub**：blob 身份与 `main` 归属用本会话自己的 `git` 对象计算。

复核结束时实测（09:00:22Z）：`charged_seconds` = **9906 / 10506**、`charged_evidence_bytes` = 2201594803、`active_ga_id` = null、`pending_budget_sequence` = null、`execution_current.sequence` = **88**、`clued_control.events` = **5** 行、`execution_events` = **88** 行、head 仍 **root5**、`accepted_binding` 窗口 = **`2026-09-12 07:05:16+00 .. 2026-09-13 07:05:16+00`**。
**未注册任何代际、未消耗那唯一一次 600 秒分配、未写库。**

本文件与受理文件只写到我自己的分支 `claude/trusting-keller-mm2s0v`，不改实施方任何对象，不批准、不合并任何 PR。

**标注约定**：每条标 **【实测】**（我自己跑出来的）或 **【读文本】**（只从文本推断）。

---

## 一、第（1）问：NW-01 落库的是不是我放行的那一份

### R12-F1 ──【实测】逐项比对，全部相符。没有一项偏离。

我先从库里读出整行，再与回执、与 `NW01Parameters.json` 的 `preimage`/`postimage` 三方对账：

| 项 | 【实测】库内 | 回执自陈 | 判定 |
| --- | --- | --- | --- |
| `not_before` | `2026-09-12T07:05:16+00` | 前 `2026-09-11T13:14:51Z` → 后同左 | ✅ |
| `expires_at` | `2026-09-13T07:05:16+00` | 前 `2026-09-12T13:14:51Z` → 后同左 | ✅ |
| `owner_approval_commit` | `cbe898d3f5b6…` | 前 `4498102661f6…` → 后同左 | ✅ |
| `subject_sha256` | `64ae7adc3c6e…` | 前 `46867dca9fcd…` → 后同左 | ✅ |
| `registration_acceptance_sha256` | `5eb9c845bc98…` | 前 `40508697dd07…` → 后同左 | ✅ |
| `store_acceptance_sha256` | `89e4a85149d7…` | 前 `66f6d8082e0a…` → 后同左 | ✅ |
| `signature_evidence_sha256` | `954faff130549…` | 前 `ae269c08d02d…` → 后同左 | ✅ |

**七个可变字段的后像与库内逐字相符，且七个前像与 `preimage` 逐字相符，七个全都真的变了。**

**九个冻结列**（`root_id`、`project_ref`、`purpose`、`environment`、`issuer`、`audience`、`algorithm_config`、`schema_sha256`、`protocol_mapping_sha256`）：**`preimage` == `postimage` == 库内，九项全部逐字相同。** 7 + 9 = 16 = 【实测】该表活列数，**没有任何列能靠「漏写」被改**。

| 其余项 | 【实测】 | 回执自陈 | 判定 |
| --- | --- | --- | --- |
| 约束条数 | **16** | 16 | ✅ |
| conname 摘要 | **`12b67839ac1caad7d61979d3a19a39c66c39fa537236dae2231ae2608fd0b031`** | 同 | ✅ 且与 `preimage.conname_digest` 相同 —— **事务前后未变** |
| 三条被替换的 CHECK | `expires_at <= '2026-09-13 07:05:16+00' and expires_at > not_before`；`owner_approval_commit = 'cbe898d3…'`；`subject_sha256 = '64ae7adc…'` | 3 | ✅ 三条都带新值 |
| 非内部触发器 | **1**，`accepted_binding_immutable`，`tgenabled = 'O'` | 1，`accepted_binding_immutable:O` | ✅ **已恢复启用** |
| 触发器定义 | `BEFORE DELETE OR UPDATE OR TRUNCATE … EXECUTE FUNCTION clued_control.deny_mutation()` | — | ✅ 与 preflight 比对用的字面量一致 |
| `charged_seconds` | **9906** | 9906 | ✅ **未动** |
| head | root5 `ctrgen_e5df4322…`，`sequence` 5，`events` 5 | 同 | ✅ **未动** |
| `effective_execution_binding` prosrc sha256 | **`c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16`** | 同 | ✅ **函数逐字未变**，且与 `preimage.getter_prosrc_sha256` 相同 |
| 窗口长度 | **86400.0 秒** | — | ✅ |
| `read_root` 整体摘要 | **`da8c633d6b44d3acf367e06bf3997684744166e966509f0a12d3ef158ba6420f`** | 同（前像 `e7624fda…`） | ✅ 与我第十一轮实测的前像 `e7624fda…` 接得上 |

**判定：库里的就是我第十一轮放行的那一份，一项不多、一项不少。**

顺带一条与 CP-01 相关的确认【实测】：整体 root 摘要现在是 `da8c633d…`，**仍不等于** `reserve_gate:35` / `reserve_execution_budget:40` 钉的 `4ddd23b5…`。**那两个函数今天依然不成立** —— 与第十、十一轮结论一致，这正是 CP-01 要修的东西。回执第 89 行对此的自陈属实。

### R12-F2 ──【实测】归档的字节就是被评审的字节，这一条是 blob 同一性，不是摘要巧合。

| 对象 | 【实测】sha256 |
| --- | --- |
| `a7335a5:work/nw01/nw01-apply.candidate.sql`（我第十一轮评审的那一份） | `4d42130aa11efa7b6b678ea7c9fd02e9fe812585b846f87a75f227a62b8e0b57` |
| `impl:…/nw01-execution/NW01Applied.sql`（归档件） | **同** |
| `a7335a5:work/nw01/nw01-preflight.sql` / 归档 `NW01Preflight.sql` | `26dc278fca8d0326971ab63a9c8677f9f041afcfb6c4b7bbe0f6517857b4ad57` / **同** |

更强的一条：**`NW01Applied.sql` 与 `work/nw01/nw01-apply.candidate.sql` 在 `impl` 树里是同一个 blob 对象（`6be9aa4e…`）**，不是两份内容相同的文件。归档没有「重新誊写一遍」。
`4d42130a…` 正是我第十一轮 R11-F10 里**自己用生成器复现出来**的值。✅

### R12-F3 ── 回执自陈的那条边界：**说法成立，但它的成立依据比回执写的窄；我记为一条缺陷，等级「证据完备性」，不影响本轮任何判定。**

回执第 33–34 行的原文是：SQL 是**誊写**进 MCP 客户端的，不是从文件管道送入的，因此**数据库收到的字节与归档文件并非构造上哈希同一**；其安全性依赖 26 道 fail-closed 断言（15 前置 + 11 后置）与回读。

**先说结论：这个说法成立，而且披露方式是对的 —— 它没有把「我抄对了」说成「哈希一致」。** 但论证有一处需要收紧：

**成立的部分【实测】。** 誊写错误分三类，三类都有归宿：
1. **错在被钉死的字面量上**（前像值、约束名、触发器定义、摘要）→ 15 条前置或 11 条后置抛异常 → 整事务回滚。这一类我在第十一轮逐条读过断言面。
2. **错在写入值上** → 后置块比对写入值，且我现在**独立地**从库里读出七个后像，与 `postimage` 逐字相符（R12-F1）。
3. **错成语法不合法** → 直接失败。

**不成立的部分 —— 回执把 26 道断言当成了完整覆盖，实际上它们不是。**
26 道断言覆盖的是**前像、形状与写入值**。存在一类誊写偏差它们抓不到：**在不改变任何被断言对象的前提下，增删语句**。例如漏抄一条 `alter table … add constraint`（少加回一条 CHECK）—— 后置块验的是行内容与那三条被替换 CHECK 的定义，而**约束总数与 conname 摘要只在 preflight 里验，不在事务内**（这正是我第十一轮 R11-F12 指出的前后不对称的同一根源）。

**但这一类在本次执行里被关住了，关住它的不是那 26 道，而是我现在这次事后回读**：我实测 `constraint_count = 16`、conname 摘要 = `12b67839…` **与前像相同**，非内部触发器恰为 1 且已启用，`effective_execution_binding` prosrc 未变。**即：语句集合层面的誊写偏差，被一次独立的事后测量排除了。**

**因此我的判定是：**
- **不记为阻断性缺陷。** 实际结果已由我独立验证，本次执行没有发生任何偏差。
- **记为一条证据完备性缺陷（R12-F3）**：回执把保障归给「26 道断言」，而**那 26 道并不覆盖语句集合的完整性**；真正关住这一类的是事后的独立回读。**回执应当把这句话改成「26 道断言 + 一次独立事后回读」，并明确点出前者不覆盖哪一类。**
- **给 CP-01 的要求（比 NW-01 严）**：CP-01 动的是 `SECURITY DEFINER` 函数，语句集合层面的漏抄后果远重于 NW-01。**CP-01 不应当用誊写路径提交。** 若环境确实只有誊写一条路，则必须在事务**内**补上「约束/触发器/函数摘要」这一层的前后对称断言（这正是我第十一轮列的第 1、2 条），使语句集合的完整性也变成 fail-closed，而不是依赖执行者事后想起来去量。

---

## 二、第（2）问：独立复算注册评审主体

### R12-F4 ──【实测】我自己导出了快照。它与实施方那份**逐字节相同**，而这一点是用我自己在库内算出的摘要证明的。

我没有采信实施方的文件，做法是：在库内一次 `select` 同时取 `read_root(...)::text` 的 **base64** 与**它的 sha256**，自己解码落盘，再自己量。

| 【实测】项 | 值 |
| --- | --- |
| 库内 `length(read_root::text)` | **23266** |
| 库内 `encode(sha256(convert_to(read_root::text,'UTF8')),'hex')` | **`da8c633d6b44d3acf367e06bf3997684744166e966509f0a12d3ef158ba6420f`** |
| base64 长度 | 31024 |
| 我解码落盘后的字节数 | **23266** ✅ |
| 我解码落盘后的 sha256 | **`da8c633d…`** ✅ |
| 实施方 `ReadRootSnapshotAfterNW01.json` 字节数 / sha256 | **23266** / **`da8c633d…`** ✅ |
| `cmp` 我的快照 vs 实施方快照 | **BYTE-IDENTICAL** |

**所以实施方所称的「23,266 字节、`da8c633d…`、与库内逐字节相同」三项全部属实，而且这不是我信了它 —— 那个摘要是我在数据库里自己算的。**

### R12-F5 ──【实测】我用**我自己的快照**跑生成器，复现了同一个摘要，且产出逐字节相同。

在独立副本里执行（`CONTROLLER_DIR` 取默认值，即重建后的 window11 控制器）：

```
node work/twentieth-forward/build-root6-registration.mjs --acceptance-pending \
  <我的快照> 2026-09-12T07:05:16Z 2026-09-13T07:05:16Z \
  3887b9e0a2c4e667823031a5294b8d2921fc8d46 \
  71bf538405614db6f01d28e4692df05ae2d115a0 457e32b0ca9c319f… \
  fcddb0acee7056435117fdefdccce55ed5ad1bdc 954faff130549ceb… <我的输出路径>
```

| 【实测】项 | 值 |
| --- | --- |
| `review_subject_sha256` | **`293da3c512f63a9b1f7b3d07fa3282975917cac3bb94ccf831f03707bb3b572b`** ✅ 与实施方所称一致 |
| `prefix_sequence` / `prefix_digest` | **5** / **`bcc3742e3834776b62f6b4ffff94d93bcad46334afaf63d5b1ae1635ef3ed796`** ✅ |
| `predecessor` | `ctrgen_e5df4322…` / **`92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5`** ✅ |
| `self_test.historical_registrations_reproduced` | **5**，`all_prefix_digests_match: true`，`predecessor_method_reproduces_history: true` |
| `validate_root_shape` | `SHAPE_VALID_ONLY` / `authority_effect: NONE` / `signature_verified: false` |
| `cmp` 我的产出 vs `work/twentieth-forward/…json` | **BYTE-IDENTICAL** |
| `cmp` 我的产出 vs `artifacts/…/root6-registration/…json` | **BYTE-IDENTICAL** |

【实测】两份提交的副本互为同一 blob（`81199ee9…`），3764 字节，文件 sha256 `06b5135aa93288afb087db7814ef0b23012b77af4c1978d687d414a13d3bd4e4`。
**注意不要混淆**：`06b5135a…` 是**文件字节**的摘要；`293da3c5…` 是**规范化对象 + LF** 的摘要。受理里两者分列两个字段，不可互换。

### R12-F6 ──【实测】我另写了一份 canonical 摘要实现，不经实施方的脚本，三个值全部复现。

只跑一遍它自己的脚本，证明的是「脚本自洽」，不是「值正确」。我因此用 Python 独立实现了控制器 `canonical()`/`canonicalDigest()`（键排序、`JSON.stringify` 语义、拒绝浮点与不安全整数、末尾补 `\n`），再算一遍：

| 项 | 【实测】我自己算的 | 期望 | |
| --- | --- | --- | --- |
| `prefix_sequence` | **5** | 5 | ✅ |
| `prefix_digest` | **`bcc3742e3834776b62f6b4ffff94d93bcad46334afaf63d5b1ae1635ef3ed796`** | 同 | ✅ |
| `predecessor.sha256` | **`92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5`** | 同 | ✅ |
| `reviewSubjectDigest(主体)` | **`293da3c512f63a9b1f7b3d07fa3282975917cac3bb94ccf831f03707bb3b572b`** | 同 | ✅ |
| 五条历史 `prefix_digest` | seq1–5 **5/5 全部复现** | 同 | ✅ |
| `revocation.event_set_digest`（空集） | **`37517e5f3dc66819…`** | 同 | ✅ |

**这一条是本轮最有分量的独立性证据：三个将写进不可回退事件的值，由两套互不相关的实现算出同一结果。**
（顺带：我用同样的实现算 root5 的 `reviewSubjectDigest` 得 `56dbe7c68f39ce16…`，与 `Root5Acceptance.json` 记的 `review_subject_sha256` **逐字相同** —— 这证明我对该字段语义的理解与历史一致，不是我自创的。）

### R12-F7 ── 判定：分四段 base64 抄回**没有引入不可接受的风险**，但「双闸门」这个说法要修一处。

**风险判定：不可接受的风险不存在。** 理由不是「抄写可靠」，而是：**传输信道的完整性由一个在信源侧（数据库内）计算的摘要闭合。** 只要落盘字节的 sha256 等于库内算出的 `da8c633d…`，信道里发生过什么就都不重要 —— 我自己走了一遍这条路（R12-F4），得到同一摘要。**这是能拿到的最强答案。**

**但实施方所说的「双闸门 = 分段摘要 + 构建器自检」，第二道闸门是虚的，须更正：**

- **第一道（分段摘要 / 总摘要）是真的**，而且它单独就够。**它是唯一承重的那道。**
- **第二道（构建器自检）关不住快照被替换。** 构建器的 `EXPECTED_CHAIN` 钉的是五条历史 `prefix_digest`，确实能抓住截断、重排、替换 —— **但这五个期望值是硬编码在脚本里的，而脚本和快照来自同一方。** 一个同时改了快照与 `EXPECTED_CHAIN` 的版本会自洽通过。这与我第十一轮 R11-F11 第 10 项是同一个结构：自检证明的是「方法自洽」，不是「输入正确」。
- **真正让构建器自检有价值的，是它的期望值被第三方独立复算过** —— 本轮由我做到了（R12-F6，5/5）。**在我复算之前，那五个值只是实施方的自陈。**

**所以准确表述是**：闸门只有一道（信源侧摘要），构建器自检是**在被独立复算之后**才成为第二道。实施方把尚未被复算的自检记成一道闸门，**高估了执行前的保障强度**。不阻断 —— 因为我现在把那道闸门补齐了。

---

## 三、第（3）问：`--acceptance-pending` 是修正还是放宽

### R12-F8 ──【实测】**是修正，不是放宽。** 它确实只输出 `reviewSubjectDigest` 所哈希的那个对象。

【实测】控制器 `root-window-validation.mjs:25`：

```js
export function reviewSubjectDigest(root){const value=structuredClone(root);
  delete value.signature_binding; delete value.independent_acceptance_ref;
  return canonicalDigest(value);}
```

脚本 `:244–246` 删的**恰好**是这两个键，`:251` 再断言 `reviewSubjectDigest(body) === reviewSubjectDigest(reviewSubject)`。
该断言本身是重言式（两边都会再删一次），**但它有真实作用**：它把「脚本认为哪两个字段不进摘要」与「验证器认为哪两个字段不进摘要」钉在一起。**若将来验证器改了排除集而脚本没跟，这一行会抛。** 方向正确。

【实测】我核了这带来的一个重要后果：**在该模式下，评审主体不依赖 `ownerMerge`、`seBlob`、`seSha` 中的任何一个** —— 三者只进 `signature_binding`，而 `signature_binding` 整个被删。**因此我受理的那个摘要，与签名证据的取值无关。** 这是对的（签名尚不存在），但受理文件必须写明这一点，我已写进 `checks` 的最后一条。

### R12-F9 ──【实测】**占位符缺席的「证明」写在了分支的错误一侧。这是本轮的主要发现。**

`:248–250` 的做法是：`JSON.stringify(reviewSubject)` 后检索 40 个 0 与 64 个 0，命中即抛。

**在 `--acceptance-pending` 模式内，这条是充分的**，理由甚至比它自己写的强：占位符只经 `iaBlob`/`iaSha` 进入 `independent_acceptance_ref`，而该键已被删除，**结构上就到不了产物**。（附带一条：`NON_VALUE_SHA` 的 64 个 0 包含 `NON_VALUE_BLOB` 的 40 个 0 作为子串，所以真正起作用的是 40 个 0 那一条；两条并列无害。）

**但这条检查只在 `if (PENDING) { … }` 块内。** 而**真正会产出可提交请求的，是不带 `--acceptance-pending` 的那条路径 —— 那条路径不做这项检查。**

【实测】T5：我不带该旗标，把 `iaBlob` 传 40 个 0、`iaSha` 传 64 个 0：

| 【实测】 | 结果 |
| --- | --- |
| 参数校验 `/^[a-f0-9]{40}$/` 与 `/^[a-f0-9]{64}$/` | **全 0 串合法，照过** |
| 输出 | **`ROOT6_REGISTRATION_CANDIDATE_BUILT_NOT_SUBMITTED`，文件正常写出** |
| 产出的 `independent_acceptance_ref` | `{"uri": "https://api.github.com/…/git/blobs/0000000000000000000000000000000000000000", "sha256": "0000…0000"}` |
| `signature_binding.signed_object_sha256` | `74afe2dda8de450c…`（照常算出，形态完整） |

**即：那个专为「不要用占位符冒充真受理」而存在的检查，恰好不在会用到它的那条路径上。** 产出的是一份形态完整、可直接提交给 `append_event` 的请求，而 `append_event:13` 不校验 body —— **写进去就是永久烧掉 `ctrgen_5e0440a9…`。**

**判定：这是一条真缺陷，等级「高」，但不阻断本轮受理**（我受理的是评审主体，不是最终注册体；该缺陷影响的是我受理**之后**那一步）。
**必须在构建最终注册体之前闭合**，改法成本为零：把 `:248–250` 那三行移出 `if (PENDING)` 块，对 `body`（而不是 `reviewSubject`）做，并同时禁止全 0 的 `oaBlob`/`oaSha`/`seBlob`/`seSha`。**我把这一条列为「拿到受理之后仍不能直接构建注册体」的第一个理由。**

### R12-F10 ──【实测】该模式**确实拒绝**输出可提交的请求。我试过了，拿不到。

`:277` 的 `process.exit()` 在写 `Root6GenerationRegistration.candidate.json` 的 `:280–285` **之前**。
【实测】我在带旗标的全部四次运行后，遍历独立副本与临时目录，**没有任何 `Root6GenerationRegistration.candidate.json` 被产出**。产物只有评审主体一个文件。✅

### R12-F11 ──【实测】位置参数移位那处修正**基本正确，但有一个洞**：恰好多传 3 个参数时不拦。

| # | 【实测】我传了什么（带 `--acceptance-pending`） | 结果 |
| --- | --- | --- |
| T1 | 完整的 ia 对 **和** se 对（4 个多余参数）—— 最典型的误用 | **REFUSED** `WITH_--acceptance-pending_PASS_ONLY_THE_SIGNATURE_EVIDENCE_PAIR_AFTER_THE_APPROVAL_PAIR` ✅ |
| T3 | 只传 `seBlob`、漏 `seSha`（1 个） | **REFUSED** `AssertionError: seSha` ✅ |
| T4 | se 对**顺序颠倒**（先 sha256 后 sha1） | **REFUSED** `AssertionError: seBlob` ✅ |
| **T2** | `iaBlob, iaSha, seBlob`（**恰好 3 个**） | **ACCEPTED，正常输出** ⚠️ |

T2 的机理：`rest.length > 3` 才抛，3 个不抛；于是 `seBlob := iaBlob`、`seSha := iaSha`、**`outArg := seBlob`**。
【实测】后果：脚本把产物写到了仓库根目录下一个**以 sha1 命名的文件** `fcddb0acee7056435117fdefdccce55ed5ad1bdc`。

**严重性：低。** 因为在该模式下 se 对不进评审主体（R12-F8），**内容是对的** —— 我实测该杂散文件的 sha256 = `06b5135a…`，与正确产物相同。损害仅限于「产物落在一个没人会去找的路径上」。
**但它说明 `rest.length > 3` 这个判据选错了维度**：该拦的是「参数个数不等于预期」，不是「多于 3」。**应改为 `rest.length !== 2 && rest.length !== 3`**（2 = se 对，3 = se 对 + 输出路径），并对 `outArg` 加一条「不得形如 40 位十六进制」的形状检查。列为建议，不阻断。

---

## 四、第（4）问：只改了该改的

### R12-F12 ──【实测】十个字段逐字未变；但**实际变了九个字段，派工说明列了八个 —— 漏了 `owner_approval_ref`。**

我拿**我自己算出的**主体与 root5 的注册 body 逐字段比对（主体少了 `signature_binding`、`independent_acceptance_ref` 两键，其余 18 键一一对应，**没有新增键、没有丢键**）：

**逐字未变（10 项）**【实测】：
`scope`、`status`、`object_type`、`purpose`、`audience`、`root_set_id`、`schema_digest`、`schema_version`、`issuer_bindings`、`algorithm_config`
**要求「其余字段必须逐字未变」—— 成立。** ✅

**发生变化（9 项）**【实测】：

| 字段 | 变化 | 在派工说明的清单里？ |
| --- | --- | --- |
| `control_trust_root_generation` | `ctrgen_e5df4322…` → `ctrgen_5e0440a9…` | ✅ |
| `generation_ordinal` | **5 → 6** | ✅ |
| `not_before` | `2026-09-10T13:18:47Z` → `2026-09-12T07:05:16Z` | ✅ |
| `expires_at` | `2026-09-11T10:21:05Z` → `2026-09-13T07:05:16Z` | ✅ |
| `history` | 3 个子字段变（见下） | ✅ |
| `revocation` | 2 个子字段变（见 R12-F13） | ✅（说明写「三项」） |
| `predecessor` | `generation_id` + `sha256` 均变 | ✅ |
| `status` | `REGISTERED` → `REGISTERED`，**值未变** | ✅（说明列了，实际是原地赋同值） |
| **`owner_approval_ref`** | **`uri` 与 `sha256` 均变** | ❌ **不在清单里** |

**这一条我必须写清楚，因为它是本项唯一的偏差。**

`owner_approval_ref` 的变化是**正确且必须的**，不是越权改动：root6 的 Owner 批准件是本窗口的 `ExplicitOwnerApproval.candidate.json`，而 root5 指向的是上一窗口的批准件。**一份指着 root5 批准件的 root6 注册体才是错的。** 脚本 `:203` 由 CLI 的 `oaBlob`/`oaSha` 显式赋值。

**我独立验了这个新值的出处【实测】**：

| 项 | 值 |
| --- | --- |
| `owner_approval_ref.uri` 末段 blob | `71bf538405614db6f01d28e4692df05ae2d115a0` |
| 该 blob 对应文件 | `…/next-window-20260912/ExplicitOwnerApproval.candidate.json` |
| 该 blob 的 sha256 | **`457e32b0ca9c319f23c70b5493a7f649d84bf6f2e2d09a34fd5cbf4d30121fe2`** = 主体所记 ✅ |
| 该 blob 在 Owner 合并 1 `cbe898d3…` 的树内？ | **是** ✅ |
| 该 blob 在 `main`？ | **是** ✅ |

**判定：九项变化全部正当，其余十项逐字未变。派工说明的清单不完整（漏 `owner_approval_ref`），我按实测记为九项。**

### R12-F13 ──【实测】`revocation` 是「三处赋值、两处变值」，说「三项」会让人以为有三个新值。

【实测】`as_of` 变（→ `2026-09-12T07:05:16Z`）、`expires_at` 变（→ `2026-09-13T07:05:16Z`）、**`event_set_digest` 被脚本 `:200` 重新计算，但算出的是同一个值** `37517e5f3dc66819…`。
原因【实测】：快照里 `ROOT_REVOKED`/`GENERATION_REVOKED` 事件数为 **0**，空数组的规范化摘要是常量。我用自己的实现独立算出同一常量（R12-F6）。
**这是正确行为**（重算而不是照抄），但记述应为「三处赋值，其中两处的值改变」。不阻断。

### R12-F14 ──【实测】`minimum_accepted_generation` 同步推进到 root6，这是链条语义的必然。

【实测】`history.minimum_accepted_generation`：`ctrgen_e5df4322…`（root5）→ `ctrgen_5e0440a9…`（root6）。
即 root6 注册之后 root5 不再被接受 —— 与前五代的做法一致（我逐代查了快照，五代都把它指向自己）。✅

### R12-F15 ──【读文本 + 实测】评审主体文件本身**比 root5 的前例少了自述层**，是一处证据可读性退步。

【实测】`Root5ReviewSubject.json`（4845 字节）是一个**带包装**的对象，五个键：
`state: "PREPARED_NOT_REGISTERED_FORWARD_ROOT_REVIEW_SUBJECT"`、`review_subject_sha256`（自述摘要）、`subject`（真正的主体）、`source`（当时的 sequence / generation / root 摘要）、`admission_boundary`（五条「尚未发生什么」）。
【实测】我验证了 `digest(Root5ReviewSubject.subject)` = `56dbe7c68f39ce16…` = 它自述的 `review_subject_sha256`，**自述属实**。

而 `Root6RegistrationReviewSubject.json`（3764 字节）是**裸对象**：没有 `state`、没有自述摘要、没有 `source`、没有 `admission_boundary`。**单看这个文件，读者无从知道它是什么、对应哪个 sequence、也无从自校验。**

**不阻断**：摘要与边界由我的受理文件补齐（`review_subject_sha256`、`root_registered: false`、`authority_effect: NONE` 都在我的受理里）。
**但建议第三次合并时补成 root5 那种带包装的形状** —— 它在第九轮 R9-F1 之后被证明是有用的形状，不应在这一代退掉。

---

## 五、第（5）问：`validateRootShape` 跑的是不是对的验证器

### R12-F16 ──【实测】本环境装的确实是 ajv **6.15.0**，且 manifest 钉的 41 个 ajv 文件与检出**逐字节相同**。

【实测】`root-window-validation.mjs:4–6` 的解析基点是 `apps/clued-cloud/package.json` 的 `createRequire`：

| 【实测】项 | 值 |
| --- | --- |
| `require.resolve('ajv')` | `…/apps/clued-cloud/node_modules/ajv/lib/ajv.js` |
| `ajv/package.json` 的 `version` | **6.15.0** |
| 该副本外是否还有别的 ajv 可能遮蔽 | **没有**（`find` 全仓只有这一处 `node_modules/ajv`） |
| `new Ajv({allErrors,strictKeywords,format:'full'})` | 构造成功（ajv6 选项面） |

manifest（`control-context-verifier-root6-window11-successor/ControllerSourceManifest.candidate.json`，331 项）中前缀为
`C:/Users/Windows/.codex/projects/codex-memory-system/apps/clued-cloud/node_modules/ajv/` 的条目：

| 【实测】项 | 值 |
| --- | --- |
| manifest 中 ajv 条目数 | **41** ✅ 与所称一致 |
| 其 `role` | 全部 `RUNTIME_DEPENDENCY`（41/41） |
| 与本地检出 **sha256 与 bytes 双双相同** | **41 / 41** |
| 不同 | **0** |
| 缺失 | **0** |

**判定：验证器是对的那一个。离线验证不是空跑。** ✅
这也把实施方在脚本头部 `:34–39` 的自陈（「npm 先装了 ajv 8，format 处理不同、报错；改用 6.15.0 后 41 个文件逐字节相同」）中**承重的那一半**独立坐实了。我没有去复现 ajv 8 的报错行为 —— 那是它解释**为什么**要钉 6，不是本条的判据；判据是「跑的是不是 manifest 钉的那份」，而这一点我逐字节验了。

### R12-F17 ──【实测】重建后的控制器把硬上限降到了本窗口，且我们的 `expires_at` 恰好取到等号。

【实测】`root-window-validation.mjs:31`：

```js
assert.ok(start>=Date.parse('2026-09-10T13:18:47Z') && start<end
          && end<=Date.parse('2026-09-13T07:05:16Z'), 'Owner window');
```

我们的 `expires_at` = `2026-09-13T07:05:16Z`，**`<=` 取等号成立**。✅
这确认了第八轮 R8-F3e 指出的旧上限（`2026-09-19T00:00:00Z`）已被重建降到本窗口，也确认了脚本 `:220–223` 那句「重建后的控制器会降低上限，所以要对实际导入的模块重测」的处理是对的。
**一条提醒**：由于是等号成立，**这个验证器对本窗口没有任何余量**。若最终注册体的 `expires_at` 被改动哪怕 1 秒（向后），`validateRootShape` 立刻拒绝。这是好事（它在替我们守着），写在这里供构建最终注册体时参考。

---

## 六、第（6）问：实施方停下来对不对

### R12-F18 ──【实测】**缺件是真的。我用比实施方更强的办法证明了它。**

实施方的理由是「`ContinuationRegistrationSubjectAcceptance.json` 受理的是 NW-01 续延主体、不是代际注册」。这个理由**成立**，但它是文本层面的。我改用一条可测的不变式：

**不变式：`independent_acceptance_ref` 必须指向一份 `review_subject_sha256` 等于该代自身 body 的 `reviewSubjectDigest` 的文件。**

【实测】我从自己的快照里取出全部五代的 body，用自己的实现算 `reviewSubjectDigest`，再把 `independent_acceptance_ref.uri` 的 blob 在仓库里解析成文件、读出它自述的 `review_subject_sha256`：

| 代 | ordinal | 被指向的文件 | `reviewSubjectDigest(body)` | 文件自述 | 相符 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | `FirstControlRootRegistrationIndependentAcceptance.v2.json` | `e8f60f84…` | `e8f60f84…` | ✅ |
| 2 | 2 | `ForwardRootGeneration2IndependentAcceptance.json` | `9dd122f3…` | `9dd122f3…` | ✅ |
| 3 | 3 | `ForwardRootGeneration3IndependentAcceptance.json` | `0c2e983c…` | `0c2e983c…` | ✅ |
| 4 | 4 | `Root4Acceptance.json` | `c3ce2bc9…` | `c3ce2bc9…` | ✅ |
| 5 | 5 | `Root5Acceptance.json` | `56dbe7c6…` | `56dbe7c6…` | ✅ |

**五代 5/5 全部成立。这个不变式不是惯例，是这条链一以贯之的结构。**

【实测】再查 root6：**全分支 `git grep` `293da3c5…`，零命中。** 没有任何已存在的文件受理了这个评审主体。

【实测】而 `ContinuationRegistrationSubjectAcceptance.json` **根本没有 `review_subject_sha256` 这个字段**（其键集为 `authority_effect, current_root_generation, current_root_sequence, database_effect, decision, execution_baseline, kind, new_budget_capacity, new_root_generation, owner_approval, registration_subject, requires_actual_owner_signature, requires_fresh_independent_review_before_NW01, requires_fresh_preimage_CAS_before_NW01, requires_signature_evidence_readback, review_basis, review_independence, root_set_id, schema_version, state, window`），
且 `kind = CONTINUATION_REGISTRATION_SUBJECT_ACCEPTANCE`、`state = ACCEPTED_EXACT_SUBJECT_FOR_OWNER_SIGNATURE_ONLY`、`review_independence = NO_NEW_INDEPENDENT_RUNTIME_REVIEW_CLAIMED_AT_THIS_STAGE`。
**它与那五份不是同一类文件，指它会让不变式在第六代首次断裂。**

我同样查了 `ContinuationControlStoreAcceptance.json`（`kind = CONTINUATION_CONTROL_STORE_ACCEPTANCE`，受理的是控制存储），以及分支上全部 `*Acceptance*.json`：**没有任何一份是遗漏的、可以正当引用的候选。**

**判定：实施方停下来是对的。缺件真实存在，而且它是链条里一条可测不变式的缺口，不是文书洁癖。**
在 `append_event:13` 不校验 body、写错即永久烧毁代际 id 的前提下，**指一份不满足该不变式的文件，等于用唯一一次机会写下一个会被控制器事后拒绝的引用。** 它拒绝这么做，判断正确。

---

## 七、第（7）问：签发受理

**前六项全部通过，我签发。**

文件：`artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/Root6RegistrationAcceptance.json`
形状参照 `bootstrap/root5-final/Root5Acceptance.json`（同一角色的前例）—— 【实测】字段集与前例**完全一致，不多不少**（我程序化比对过两边的键集）。

**每一个 `accepted_*` 字段的来源（全部是我自己算出或读出的）：**

| 字段 | 值 | 我的来源 |
| --- | --- | --- |
| `review_subject_sha256` | `293da3c512f63a9b1f7b3d07fa3282975917cac3bb94ccf831f03707bb3b572b` | **我自己的 canonical 实现**（R12-F6），并由我用自己的快照跑生成器复核（R12-F5） |
| `accepted_history_prefix_sha256` | `bcc3742e3834776b62f6b4ffff94d93bcad46334afaf63d5b1ae1635ef3ed796` | 同上，自己算 |
| `accepted_history_prefix_sequence` | `5` | 自己数我的快照的 `events` |
| `accepted_predecessor.sha256` | `92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5` | 自己算 root5 body 的 canonical 摘要 |
| `accepted_predecessor.generation_id` | `ctrgen_e5df432221344996afc04b5638121d96` | 我自己的库内快照的 `generation_id` |
| `accepted_scope` / `accepted_audience` / `accepted_algorithm_config` / `accepted_issuer_purposes` | 见文件 | 取自**我自己产出的**评审主体（R12-F5），非实施方文件 |
| `schema_sha256` | `87f094fa079034aa886d6c568730370a3264e106529b4bfd79bc3369f30b79e5` | 与库内 `accepted_binding.schema_sha256` 【实测】相同 |
| `not_before` / `expires_at` | `2026-09-12T07:05:16Z` / `2026-09-13T07:05:16Z` | 【实测】库内 `accepted_binding`，长度 86400.0 秒 |
| `root_set_id` | `ctr_414bd3c724264a83894b0c55cf2ab878` | 【实测】库内 |
| `owner_approval_merge` | `cbe898d3f5b66f279d78a6b8d583d2c1885d9c89` | 【实测】blob `71bf5384…` 在该合并树内（R12-F12） |
| `subject_file.sha256` / `bytes` | `06b5135a…` / `3764` | 我量的**我自己产出的**那份（与两份提交副本 `cmp` 逐字节相同） |
| `authority_effect` | **`NONE`** | 按要求 |
| `root_registered` | **`false`** | 按要求 |

受理文件的 `checks` 逐条写明了我实际做了什么、结果如何，共 12 条，**包括最后一条明确的否定项**：Owner 对最终注册体的签名、`signature_binding`、`independent_acceptance_ref` 本身**都不在本次受理范围内** —— 它们尚不存在，也不属于评审主体。

**本受理不构成授权，不注册代际，不批准也不合并任何 PR。最终裁量权在 Owner（`tdoljyj`）。**

---

## 八、同时要求给出的三条

### R12-F19 ── 第十一轮那五条一条未闭合：**这个安排可以接受，但到期日已经变了，须重新说清楚。**

【实测】逐条查证当前状态：

| | 条目 | 【实测】状态 |
| --- | --- | --- |
| 1 | `clock_timestamp()` 窗口断言补进 apply 的**前置块** | **未闭合**。`cp01-apply.candidate.sql` 里 `clock_timestamp` 出现 4 次，我逐处看了上下文：**4 处全部在被替换的字面量内**（G7/B7 改写函数体内的窗口守卫），**CP-01 自己的事务里仍然没有** |
| 2 | 后置块补「其余七表联合摘要」+ 断言非内部触发器恰为 1 | **未闭合**（`tgisinternal`/`rows_sha` 在 CP-01 中出现 0 次） |
| 3 | 统一第六类授权子对象的 `state` 措辞 | **未闭合**（`"state": "AWAITING_OWNER_DECISION"` 仍在） |
| 4 | `--as signature` 模式省略/改名 `approved_window` | **未闭合**（`capture-owner-merge.mjs:200` 仍无条件写入） |
| 5 | 自记观测时刻记满秒 | **未闭合**（`2026-09-12T07:2xZ`、`2026-09-12T06:1xZ` 仍在） |

**判定：可以接受。** 理由与我第十一轮给的是同一条 —— 这五条我当时就写明「排在 CP-01 定稿时」，而 CP-01 尚未定稿。**在未定稿的文件上提前改，反而要重走一遍评审**，这正是 R11-F6 那条教训的另一面。

**但有一处必须更新，否则这个安排会失效：** 回执第 100–113 行自己发现了一个次序后果 —— CP-01 **不能**在手册第 9 步定稿，因为第十轮裁决 (e) 让 G8/B9 钉的是**含 root6 注册事件的投影 root 摘要**，而该事件在第 11 步才产生。于是次序被改成 9a–9f，**CP-01 定稿挪到了 9c**。

**所以这五条的到期日现在是 9c，不再是「CP-01 定稿时」这个含糊说法。** 而 9c 之前要先走 9a（构建注册体）、9b（在库内解析占位符）。**这意味着第 1、2 条（事务内断言）必须在 9c 写进候选，而第 3、4、5 条应随第三次合并（9e）处理。** 我把这个时间表明确写在这里，取代第十一轮那张表的模糊表述。

**另外请注意 R12-F3 给 CP-01 加的一条**：若 CP-01 仍走誊写路径提交，第 1、2 条就不只是「建议」，而是**必需** —— 因为誊写偏差在语句集合层面不被那 26 道断言覆盖，而 CP-01 的语句集合里是 `SECURITY DEFINER` 函数替换。

### R12-F20 ──【实测】R11-F4 在当前状态下**仍然完全如我所述**，而且现在多了一重紧迫性。

| 【实测】项 | 值 |
| --- | --- |
| `ContinuationSubjectSignatureEvidence.json` 在 `main`？ | **否**（`git rev-parse origin/main:<path>` 失败） |
| 它在 `impl` 分支？ | 是，blob `fcddb0acee7056435117fdefdccce55ed5ad1bdc` |
| 它的 sha256 | **`954faff130549cebbc6453957d3e86196f8e0c8dd551040bb20e4f9ffb6ed614`** |
| 库内 `accepted_binding.signature_evidence_sha256` | **`954faff130549cebbc6453957d3e86196f8e0c8dd551040bb20e4f9ffb6ed614`** |

**即：NW-01 已经把这个摘要写进库了，而它的来源字节此刻仍不在 `main`、仍没有任何 Owner 签名钉住。**
第十一轮我说「这是结构性必然，不据此阻断，但第三次合并应当带上它」——**这一判断在当前状态下不变**；变的是它从「将要入库」变成了**「已经入库」**。库里现在有一个指向分支外字节的摘要。

**第三次合并（9e）必须带上它**，并且证据文件应当明写：**本窗口有一个已入库的摘要，其来源文件是随本次合并才进入 `main` 的。** 这一条比第十一轮时更硬 —— 当时是预告，现在是既成事实。

### R12-F21 ──【实测】**明确判定：拿到我的受理之后，实施方还不能直接构建最终注册体。还缺三件。**

**缺件一（必须先修代码）—— R12-F9 的那个洞。**
非 `--acceptance-pending` 路径不做占位符缺席检查，我实测能让它产出 `independent_acceptance_ref` 全为 0 的完整可提交请求。**构建最终注册体走的正是这条路径。** 在修好之前构建，等于把唯一一次机会交给一条没有守卫的路。改法：把那三行移出 `if (PENDING)`，对 `body` 做，并同时禁止四对 blob/sha 取全 0。

**缺件二（必须先合并）—— 我的受理本身要进 `main` 并取得 blob。**
构建最终注册体需要 `iaBlob`（blob sha1）与 `iaSha`（sha256）两个参数。我的受理此刻在**我的分支**上，`main` 里没有。**必须先由 Owner 合并，才能拿到可引用的 blob。**
【实测】前例确认这是必需的形状：五代的 `independent_acceptance_ref.uri` 全部是 `…/git/blobs/<sha1>`，且五份被指向的文件都在仓库里可解析（R12-F18）。
**顺带一条提醒**：合并之后取到的 blob sha1 必须是**合并后 `main` 树内**那一个，且其 sha256 必须重新量一遍 —— 不要沿用我分支上的值，因为任何对文件的再编辑都会改变两者。

**缺件三（次序，见下）—— CP-01 与注册的先后应当调换。**

#### 关于次序：我建议把 9d（应用 CP-01）挪到 9f（注册 root6）之后。

回执给的修订次序是 `9a 构建注册体 → 9b 解析投影摘要 → 9c 定稿 CP-01 → 9d 应用 CP-01 → 9e Owner 合并 3 → 9f 注册 root6`。

**我先确认它没有被某个硬依赖逼成这样【实测】**：

| 【实测】问题 | 答案 |
| --- | --- |
| `append_event` 的 `prosrc` 里调用 `reserve_gate` 吗？ | **否** |
| 调用 `reserve_execution_budget` 吗？ | **否** |
| CP-01 的事务里有断言当前 head 是 root5 / events 为 5 吗？ | **没有任何这样的前置**（33 条 `raise` 我逐条看了，没有一条钉 root 状态） |

**所以注册 root6 不需要 CP-01 先修好，CP-01 也不需要在 root5 还是 head 时应用。次序不是被逼的，是选的。**

**而当前这个选法制造了一段有害区间。** CP-01 把 G8/B9 钉的摘要从 `4ddd23b5…`（旧的、已经不成立的值）换成**投影 root6 摘要**。于是：

| 时点 | G8/B9 钉的值 | 库内实际 root 摘要 | 两个函数可用？ |
| --- | --- | --- | --- |
| 现在 | `4ddd23b5…` | `da8c633d…` | **否**（本来就坏着） |
| 9d 之后、9f 之前 | 投影 root6 摘要 | `da8c633d…`（仍是 root5） | **否** |
| 9f 成功之后 | 投影 root6 摘要 | = 投影值 | **是** |

**问题出在中间那一行**：在 9d 到 9f 之间，守卫指向一个**尚不存在的 root**。**若 9f 失败 —— 而 9f 恰好是全流程唯一一步「失败即永久烧毁代际 id」的动作 —— 那两个函数就被永久钉死在一个再也无法实现的摘要上**，此后只能靠**在不可回退区内再做一次 `SECURITY DEFINER` 替换**来解套。

**这正是我第十轮否决选项 (c) 时列的那条代价**（R10-F5：「那次替换落在不可回退区里」）。当前次序把这条代价从 (c) 又请了回来，只是换了个位置 —— 它不再是必然发生，而是**在 9f 失败时发生**。

**把 9d 放到 9f 之后，这段区间就消失了**：注册成功后，投影值与实际值当场一致，CP-01 一应用即生效；注册若失败，CP-01 根本不必应用，两个函数维持今天的坏法，**不新增任何不可回退的债**。
**代价是零**：9b 计算投影摘要的前置（`still_root5`、`events_still_five`、`nw01_has_run`）约束的是**计算时刻**，不是**应用时刻**；CP-01 自己没有任何 root 状态前置（上表实测）。

**这一条我列为建议，不是阻断** —— 它不影响我对评审主体的受理，且最终次序由 Owner 裁量。但**若采用当前次序，9d 之前应当明确记录：此时启动的是一段只有 root6 注册成功才能退出的状态。**

---

## 九、总结判定

| 问 | 判定 |
| --- | --- |
| (1) NW-01 落库的是我放行的那一份？ | **是**，七字段前后、九列冻结、16 约束与 conname 摘要、触发器已恢复、`charged_seconds` 与 head 未动，全部实测相符（R12-F1/F2）。誊写边界的说法成立，但其论证需收紧，记一条证据完备性缺陷（R12-F3） |
| (2) 独立复算注册评审主体 | **复现**。我自己导出快照、自己跑生成器、又用自己的实现算了第三遍，`293da3c5…`、`bcc3742e…`、`92186d46…` 三值全部吻合（R12-F4/F5/F6）。分段抄回**无不可接受风险**，但「双闸门」应更正为「一道闸门 + 一道在被独立复算后才成立的自检」（R12-F7） |
| (3) `--acceptance-pending` | **是修正，不是放宽**（R12-F8/F10）。**但发现一条高等级缺陷：占位符检查不在会提交的那条路径上（R12-F9）**；移位修正另有一个 3 参数的洞（R12-F11） |
| (4) 只改了该改的？ | **是**，十项逐字未变；实际变九项，**派工说明漏列 `owner_approval_ref`**，该项变化正当且我独立验了出处（R12-F12/F13/F14）。主体文件缺自述层，建议补（R12-F15） |
| (5) 验证器对不对？ | **对**。ajv **6.15.0**，唯一安装，41/41 逐字节相同（R12-F16）。重建后上限恰为本窗口，取等号成立、无余量（R12-F17） |
| (6) 实施方停下来对不对？ | **对**。缺件真实：五代 5/5 满足「指向自身评审主体的受理」这条不变式，`293da3c5…` 全分支零命中，没有被漏掉的可用文件（R12-F18） |
| (7) 签发受理 | **已签发**，`authority_effect: NONE`，`root_registered: false`，全部 `accepted_*` 自算自读 |

### 拿到受理之后还缺什么 —— 一句话回答

**不能直接构建最终注册体。还缺三件：**
1. **先修 R12-F9**（把占位符检查移到会提交的那条路径上）；
2. **先由 Owner 合并我的受理**，才能拿到 `independent_acceptance_ref` 要用的 blob sha1 与 sha256；
3. **建议把 CP-01 的应用挪到 root6 注册之后**（R12-F21），否则 9d→9f 之间存在一段只有注册成功才能退出的状态。

### 关于时钟

窗口 `2026-09-13T07:05:16Z` 关闭，此刻（09:06Z）尚余约 **22 小时**。
**我没有因为时钟降低任何标准，也不需要更多时间** —— 七项全部做完；第 (2) 项我自己导出了快照并用两套实现各算了一遍；第 (3) 项我做了五组实际的敌意测试而不只是读代码；第 (5) 项我装了 ajv 并逐字节比对了 41 个文件；第 (6) 项我把「不变式」在五代上全查了一遍。

第七轮那句照录：**「窗口 Owner 可以重开，`SECURITY DEFINER` 函数改坏了不能。」**
**本轮要补一句：注册体比函数更甚 —— 代际 id 烧掉就没有第二个了。**
正因如此，我这份受理**只受理评审主体**，不受理最终注册体。**最终注册体在 `signature_binding` 与 `independent_acceptance_ref` 补齐之后，应当再走一次独立评审** —— 那份体里将有两个字段是我这次没有看过的，而其中一个（R12-F9）此刻还有一条无守卫的产出路径。

---

## 边界声明

本文件全部数据库结论来自只读 `select`（共 6 次）。**未写库、未注册代际、未消耗那唯一一次 600 秒分配、未调用任何会写库或消耗预算的函数、未执行任何 `do $$ ... $$` 块（包括 CP-01 候选里的 DO 块）。**
复核结束时实测（09:00:22Z）：`charged_seconds` = **9906 / 10506**、`charged_evidence_bytes` = 2201594803、`sequence` = **88**、`events` = 5、`execution_events` = 88、head 仍 **root5**、窗口 `2026-09-12T07:05:16Z .. 2026-09-13T07:05:16Z`。

**取证面沿用第十一轮已声明的那一项**：我在会话临时目录的一份独立仓库副本里运行了实施方的 `build-root6-registration.mjs`，并在该副本内 `npm install ajv@6.15.0`。该脚本不连数据库；**实施方检出的任何文件未被修改**；我的全部测试产物落在临时目录，测试中产生的一个杂散文件（R12-F11 的 T2）已删除。

本文件**不注册代际、不构成授权、不批准也不合并任何 PR**。
与之一同提交的 `Root6RegistrationAcceptance.json` **是一份受理**，其效力严格限于：**按 sha256 `293da3c5…` 受理该评审主体**。它**不**受理最终注册体，**不**授予任何 Root/Status/GA 效力（`authority_effect: NONE`），**不**注册 root6（`root_registered: false`）。最终裁量权在 Owner（`tdoljyj`）。

未实测而仅【读文本】的条目已在正文逐条标注，主要是：运行手册的步骤编号与阶段划分、回执所述那次执行本身（我看到的是它的回执与执行后的库状态，没有观察那次执行）、ajv 8 会如何表现（我只验了实际跑的是 ajv 6）、以及 MCP 工具的内部实现。

**CI 状态按派工说明不计入**：本仓库 CI 五项长期全红，日志 404，已确认非瞬时；**本文件不把它记作通过，也未尝试修复。**
