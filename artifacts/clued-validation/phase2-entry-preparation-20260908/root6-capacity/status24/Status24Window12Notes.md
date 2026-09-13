# Status24 载荷生成器 → window12（root7 / F12）参数化说明

**状态：`GENERATOR_PARAMETERIZED_AND_PENDING_PAYLOAD_ONLY_NO_SIGNING`。**
只生成，不执行：未写库、未 `append_event`、未预留、未跑 600 秒、未注册 root7、未开 PR、未合并。
**Supabase 一次未查** —— 本轮全部结论都能从工作树字节与 `git` 对象复算，只读 select 虽被允许但没用上。
未动 `scripts/phase2-qualification/`（只读）、`bootstrap/next-window-m3/nw02/`、`work/cp02/`、
`work/twentyfirst-forward/`。

改动仅三件 + 一件新产物：

| 件 | 变化 |
|---|---|
| `build-status24.mjs` | 窗口参数化（`WINDOWS` 参数面 + `--window`），待定钉花名册显式枚举并断言长度，新增 `--selftest`（12 条判别器） |
| `decisions.final.json` | 按 R31「v2 兼容映射」实化到 window12；新增 `root_registration_predecessor`、`source_provenance`、`@pin` 间接引用 |
| `Status24PayloadDecisionTable.md` | 追加 window12 增补节（原 root6 表原样保留） |
| `Status24Payload.window12.pending.json` | 新产物。原 `Status24Payload.pending.json`（root6/R31 记录）**未动** |

---

## 1. R31 v2 映射五条，逐条落实

### 钉 1 — `:24` GEN 常量与 `observations.root_generation` 参数化

原来 `const GEN='ctrgen_5e0440a9…'` 一处硬编码，喂 `control_trust_root_generation` 与
`observations.root_generation` 两处。现在代际来自窗口参数面
`WINDOWS['window12-root7'].root_generation = ctrgen_26769cc7109ced40bc4016b2af678198`，
并且**与受理件交叉核对**（`ROOT_GENERATION_DISAGREES_WITH_ACCEPTANCE`）：

```
jq -r .accepted_subject.expected_ga.control_trust_root_generation \
   ../../bootstrap/root7-runtime-v20/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json
# ctrgen_26769cc7109ced40bc4016b2af678198
```

同批参数化的还有 schema 摘要（`510f3b90` → `7e5df5dd`，实测本树已实化 F12 预像）、控制器摘要
（`68133f2d` → F12 冻结点 `73c05cad`）、profile / gate / scope 三个绑定摘要、`root_set_id`、
受理件路径。每个都对受理件做了一条独立可失败的断言（判别器 NC1/NC2）。

**root7 已造未烧**：该代际写进参数面不等于它已生效，注册后才生效 —— 这正是钉 2 存在的原因。

### 钉 2 — 决策表 #8 升为第六个待定钉

window12 下 #8 的值 = `canonicalDigest(root7 注册体)`，root7 注册后才可算。花名册：

| # | 钉名 | pending 占位符 | 落点 |
|---|---|---|---|
| 1 | `as_of` | `__PENDING_AS_OF__` | `payload.as_of`（:349） |
| 2 | `expires_at` | `__PENDING_EXPIRES_AT__` | `payload.expires_at`（:349 + append A4 恰等） |
| 3 | `runner_generation` | `__PENDING_RUNNER_GENERATION__` | `observations`（:351 深等） |
| 4 | `credential_generation` | `__PENDING_CREDENTIAL_GENERATION__` | `observations`（:351 深等） |
| 5 | `session_generation` | `__PENDING_SESSION_GENERATION__` | `observations`（:351 深等） |
| **6** | **`root_registration_body_digest`** | **`__PENDING_ROOT7_REGISTRATION_BODY_CANONICAL_SHA256__`** | **`source_digests[#8]` / `source_refs[#8]` / `expected_ga.authority_source_ref`（:322 + :353）** |

清单是代码里的 `PIN_ROSTER` 常量（每项带适用窗口与落点说明），生成器启动即断言
`ROSTER.length === W.pending_pin_count`（window12 = 6，window11 = 5；判别器 NC4）。

第六项的占位符**不是新造的**：它与 `root7-runtime-v20` 受理件 `expected_ga.authority_source_ref.sha256`
里已有的占位符逐字相同。生成器断言这一点（`PENDING_TOKEN_DISAGREES_WITH_ACCEPTANCE`，判别器 NC5）
—— 否则 pending 版的 `:353` 子集检查会「假过」。

**有待定钉时只出 pending 版**：`S24` 恒为 `null`，输出文件名恒为 `*.pending.json`，
并有一条 `PENDING_MUST_NOT_EMIT_FINAL` 断言兜底。定稿路径只在六钉全齐时才走
（selftest 用合成钉走过一次，产出的 `5a51b3be…` 是合成值，**不是**正式 S24）。

### 钉 3 — `a93bfdda` 转岗，三处随钉 2 实化

`a93bfdda`（R31 所算 root6 注册体摘要）在 window12 下不再是 #8 的值，转岗为 **root7 注册体的
`predecessor` 钉**，记在 `decisions.final.json` 的 `root_registration_predecessor`。
生成器不抄这个常量，而是对 `Root6RegistrationBodySnapshot20260913.json` 现算
`canonicalDigest`（sorted+compact+LF）复核（判别器 NC10），并按现任体自证 `predecessor` 的形状：

```
jq -c .predecessor Root6RegistrationBodySnapshot20260913.json
# {"sha256":"92186d46…","generation_id":"ctrgen_e5df4322…"}   ← root6 体指 root5 体，同构
```

原先三处用 `a93bfdda` 的地方（`source_digest_map` / `source_ref_map` / `expected_ga_overrides.
authority_source_ref`）改为 `"@pin:root_registration_body_digest"` 间接引用 —— **一次实化，三处同源**，
消除「同一个测量值被写三遍、实化时漏一处」的风险（这正是 `Window12ReissueNotes.md` §7 第 4 条
担心的事）。

`expected_ga_overrides.controller_qualification_ref` **已删除**：它当初存在只因生成器 `:17` 读的是
v19 陈旧工作副本（`6e35ff20`）。v20 重出件直接携带正确值（`15f2ee74`），override 的理由消失。

### 钉 4 — 决策表 #17 与载荷 `issuer_ref` 换新 STATUS 件

`context.mjs:317` 实测把 STATUS issuer 资格件摘要钉死：

```
grep -n "purpose==='STATUS'?" $D/context.mjs
# :317 …(purpose==='STATUS'?'3cb175ca0d37…':'209712fb1bd8…')…  'EXACT_ACCEPTED_PURPOSE_ALGORITHM_METADATA'
```

`:341 EXACT_STATUS_ISSUER_REF` 要求 `sm.issuer_ref === root.issuer_bindings[STATUS].qualification_ref`。
故 #17 与载荷 `issuer_ref` 一起换为
`root6-capacity/f12-issuer/Root7StatusIssuerPurposeMetadata.candidate.json`
（sha256 `3cb175ca…`，git blob `28ec4cca…`，实测）。生成器**从 `context.mjs` 正则量出 `:317` 的钉**
再与窗口参数比对（`ISSUER_PIN_AT_CONTEXT_317_MISMATCH`），不抄常量；并断言映射后的 issuer 与
窗口参数逐字相等（判别器 NC3）。

**与受理件的 `expected_ga.issuer_ref` 不冲突**（`Window12ReissueNotes.md` §4 E3 曾标为「与任务书
相反」）：那是**另一个对象的另一个字段**。`:320` 只在 `GATE_AUTHORIZATION` 分支约束
`result.ga.issuer_ref`，应为 GATE 件 `209712fb…`；`:341` 约束的 `sm.issuer_ref` 才是本载荷的字段，
必须是 STATUS 件 `3cb175ca…`。两者并存且各自正确 —— 本轮按实测各归各位，见下方不确定点 4。

### 钉 5 — 受理件相关引用改指 `root7-runtime-v20/`

`acceptance_path` 由 `bootstrap/root6-runtime-v19/…` 改为 `bootstrap/root7-runtime-v20/…`。
连带三条源摘要随之改钉（都由 `source_provenance` 对实物字节复算证实）：

| # | 语义 | root6 值 | window12 值 | 实物 |
|---|---|---|---|---|
| 7 | 控制器资格化 | `e7cfb30b` | `15f2ee74` | `root7-runtime-v20/ScopedRoot5FinalControllerQualification.json`（blob `e4ad4d34`） |
| 13 | 控制器清单 | `68133f2d` | `73c05cad` | `…-root6-linux-successor/ControllerSourceManifest.candidate.json`（blob `f11632b7`） |
| 19 | 043 修复受理 | `d3f643b4` | `82e9e2f0` | `root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json`（blob `012294f3`，重出线原地重写） |

#7 与受理件 `expected_ga.controller_qualification_ref` 逐字相同（uri 也相同），故 `:353` 过。

---

## 2. 保留的自检（原样在，未削）

- `:351` 四绑定摘要（profile/gate/controller/scope）必须都在 `source_digests` 内 —— 改任一即炸。
- `:353` `statusSources`（6 条 stage receipts + scope + controller_qualification + authority）
  必须逐条 `{uri, sha256}` 命中 `source_refs`（判别器 NC7）。
- R26-F1：禁数组索引形键（判别器 NC11）+ `stringify` 往返断言。
- `DUP_SOURCE_DIGESTS`、`REF_MAP_MISSING_FOR_REPLACED_DIGEST`、`SOURCE_ARITY`（19 项不增不减）。

新增的自检：
- `EXACT_STAGE_INPUTS_ARITY`（附带 A：`stage_receipt_refs` 必须仍是 6 条，`context.mjs:81`；判别器 NC12）。
- `source_provenance`：每条声明的摘要都对**实物字节**复算（判别器 NC6），并顺带算出 git blob sha1
  与 `source_refs` 里的 uri 比对（`SOURCE_REF_BLOB_SHA1_MISMATCH`）—— 纯 JS 算 `sha1("blob "+len+"\0"+bytes)`，不调 git。
- `ACCEPTED_STATUS_SCHEMA_DIGEST`：受理件 `control_schema_refs.StatusManifest.sha256` 必须 = 本窗
  schema 摘要（`:348` 要求 `sm.schema_digest === acceptedStatus.sha256`）。

一次 pending 跑通共 48 条具名检查（`checks_passed: 48`）。

## 3. 判别器（`node build-status24.mjs --selftest`，12 条，全部实测按预期失败）

| # | 坏变体 | 实测拒绝 |
|---|---|---|
| NC1 | 代际未参数化（仍 root6） | `ROOT_GENERATION_DISAGREES_WITH_ACCEPTANCE: acceptance ctrgen_26769cc7… vs window ctrgen_5e0440a9…` |
| NC2 | 控制器摘要仍 `68133f2d` | `CONTROLLER_DIGEST_DISAGREES_WITH_ACCEPTANCE: acceptance 73c05cada90b vs window 68133f2d6177` |
| NC3 | issuer 沿用旧 STATUS 件 | `STATUS_ISSUER_REF_NOT_THE_WINDOW_STATUS_QUALIFICATION: mapped 1640995831b0 vs window 3cb175ca0d37` |
| NC4 | 待定钉清单仍按五项 | `PENDING_PIN_ROSTER_LENGTH:window12-root7 declared 5 got 6` |
| NC5 | 第六钉占位符与受理件不一致 | `PENDING_TOKEN_DISAGREES_WITH_ACCEPTANCE: …` |
| NC6 | 供源摘要与实物字节不符 | `PROVENANCE_DIGEST_MISMATCH:…` |
| NC7 | `:353` 断链 | `STATUS_MISSING_SOURCE_REF:__PENDING_RO…` |
| NC8 | 拿 window11(root6) 档跑已实化 F12 的树 | `LOCAL_SCHEMA_DIGEST_MISMATCH:window11-root6 wants 510f3b90cdb0 tree has 7e5df5dd2b23` |
| NC9 | 缺钉且未给 `--pending` | `MISSING_DECISION:root_registration_body_digest` |
| NC10 | `a93bfdda` 的 predecessor 岗位写错 | `REGISTRATION_PREDECESSOR_DIGEST_MISMATCH: snapshot a93bfdda74d9 vs decisions 92186d46e92e` |
| NC11 | R26-F1：混入数组下标形键 | `ARRAY_INDEX_LIKE_KEY:0` |
| NC12 | 附带 A 去重（6→5） | `EXACT_STAGE_INPUTS_WOULD_FAIL: … must stay 6 (context.mjs:81), got 5` |

坏变体若不失败，`--selftest` 自身以非零退出（`DISCRIMINATOR_DID_NOT_FIRE`）；
「以错误理由失败」也算失败（`DISCRIMINATOR_FIRED_FOR_THE_WRONG_REASON`，每条都钉了预期错误串正则）。
selftest 的临时产物一律写 `mktemp -d` 并在结束时删除，仓库内无残留。

## 4. 我拿不准的点（**不拍板**，单列给评审）

1. **受理件 `control_schema_refs.StatusManifest` 的 uri 与 sha256 现在不自洽。**
   `sha256` 已换 `7e5df5dd`（F12 预像），`uri` 仍指 blob `e417d492`，而
   `git cat-file -p e417d492 | sha256sum` 实测 = **`510f3b90`**（旧 schema）。
   `:346` 走 `readBlobRef(acceptedStatus)` 取字节，M4 合并前这条取不到新 schema 的 blob。
   本轮生成器只用其 `sha256` 做交叉核对，故不受影响；但**重出线须在 M4 后把该 uri 换成新 blob**。
   同类问题还有 #18（CP-01 的 blob `91772be1`）与 #17（issuer 件的 blob `28ec4cca`）—— 都要等 owner merge
   才能经 API 取到。**是否、何时补钉，我不判。**

2. **`status_manifest_id` 沿用 `sm_672def3d43b1dc5357d5f25ec6f737c7`。** R31 为让 S24 确定化而钉了它。
   window12 是否该另造一个新 id，我没有判据；仓内有 `PR32StatusGenerationCollisionIndependentFinding.json`
   这一先例，值得评审看一眼。我选了零动作（沿用），**请评审定**。

3. **`generation` 仍为 24。** 我按「状态清单序数，与 root 代际无关」理解（Status23 → 24），
   窗口换代不重排序数。若 window12 该另起序数，这是 Owner 级决定，**不在本轮**。

4. **STATUS / GATE 两个 issuer 字段并存的说法，我给了论证但没有裁定权。**
   `Window12ReissueNotes.md` §4 E3 明说「若评审仍要在此处放 STATUS，那是一个要对着 `context.mjs:320`
   做的决定」。我的读法是两处**本就不同字段**（`:341` 的 `sm.issuer_ref` = STATUS，`:320` 的
   `result.ga.issuer_ref` = GATE），因此两份说明并不矛盾；但这需要评审确认一句，不该由我了结。

5. **`repin-acceptance.mjs` 本轮未改。** 它按五钉调用本生成器，window12 下会停在
   `MISSING_DECISION:root_registration_body_digest` —— 这是**正确的拒绝**，不是回归。
   R31 v2 映射钉 4 已判它转岗为重出生成器的谓词自验/判别器库。**由谁在哪一轮改，我没定。**

6. **`#19` 的新值 `82e9e2f0` 取自并行重出线原地重写后的工作树字节。**
   若那条线再动这七件容量族文书，`source_provenance` 会当场炸（这是设计的），需重跑生成器。
   本轮我未核对该重写是否已被独立受理。

7. **行号漂移。** R31 记的 `:350` / `:352` 现测分别为 `:349 STATUS_CURRENT_INPUTS` /
   `:351 STATUS_EXACT_CURRENT_OBSERVATION_BINDING`；`:353` / `:322` / `:81` / `:37` / `:317` / `:341` / `:357` 未动。
   代码里的注释按现测行号写，谓词名同时给出，避免下一次漂移再误导。

8. **window11 档在本树上不可复现。** F12 已原地实化于 `…-root6-linux-successor/`，
   本地 schema 已是 `7e5df5dd`，所以 R31 的 `Status24Payload.pending.json` 无法用本生成器逐字重生成
   （NC8 就是这条）。该文件作为 root6 期的历史记录**原样保留未动**。若评审要可复现的 root6 对照，
   需要一个「从 `git cat-file` 取 BASE_REV schema」的读取分支 —— 我没加，因为那会让生成器依赖 git。

9. **`f12-issuer/` 两件仍名 `.candidate.json`。** 其 sha256 已被 `context.mjs:317` 钉死，故改名不影响摘要，
   但影响 blob sha1 与 uri。**是否在 root7 注册前定稿改名，属注册线，我不判。**

10. **`root7 注册体` 真出之后**，须复核：`predecessor.sha256 === a93bfdda…`、
    `predecessor.generation_id === ctrgen_5e0440a9…`、`canonicalDigest(root7 体)` 即第六钉的值，
    且与受理件 `authority_source_ref` 同源实化（`:322` + `:37` 两头堵）。生成器已把前两条写成断言，
    第三条要等实测。

## 5. 复现命令

```sh
cd artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/status24
node build-status24.mjs --selftest                                  # 12 判别器 + 两个正控制
node build-status24.mjs --decisions decisions.final.json --pending  # → Status24Payload.window12.pending.json
```
