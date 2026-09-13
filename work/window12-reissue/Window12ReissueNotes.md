# window12 重出生成器说明（会话 I2）

**状态：`GENERATOR_AND_DRY_RUN_ONLY_NO_REISSUE_NO_AUTHORITY`。**
未做正式重出、未写库、未 `append_event`、未预留、未跑 600 秒、未开 PR、未合并。
未动 `scripts/phase2-qualification/`、`bootstrap/next-window-m3/`、`root6-capacity/status24/`。
Supabase 一次都没查（本轮全部结论都能从 git 字节复算，见下表「可复现命令」一列）。

产出：
- `work/window12-reissue/reissue-documents-window12.mjs` —— 参数化重出生成器 + 内建自验与七判别器
- 本文件

模板与世系：`work/twentieth-forward/reissue-seven-documents.mjs`（window11，六件，
root6-runtime-v17 → v18）。**方法**沿用，**常量与若干形态假设全部作废**，逐条见第 2 节。

---

## 0. 基准与两个必须拒收的陈旧副本

`BASE_REV = 88fc944b1a2b8530478763224dc0209fa1732785`（main@M2，PR #163 的合并）。

本分支工作树上有两件与 M2 **不同**的陈旧工作副本，生成器按 sha256 **具名拒收**（判别器 NC5）：

| 件 | M2 活字节 | 本分支工作副本 | 依据 |
|---|---|---|---|
| QUAL | `e7cfb30b…` | `6e35ff20…` | R31-F1：6e35ff20 正是 R30 测错的那个对象 |
| RTA | `fb389314…` | `775fd644…` | R31-F1：该副本带 `\u` 转义，过不了 admin parser |

```
git cat-file -p 88fc944b:artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json | sha256sum   # fb389314…
sha256sum artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json                              # 775fd644…
```

**因此生成器的基底一律 `git cat-file` 取自 BASE_REV，不读工作树。** 模板读工作树 —— 在本
分支上照做会拿两件陈旧件当活件用，且 QUAL 一件就足以让 `controller_qualification_ref`
整条链错掉。

---

## 1. DOCS 表（逐行依据 + 可复现命令）

活钉集的判据：**钉了控制器摘要 `68133f2d…` 或本窗时间 `2026-09-12/13T07:05:16Z`**。
全量枚举命令（在 M2 树上对 `bootstrap/root6-runtime-v19/` 与 `root6-capacity/` 的 16 个
JSON 逐件数）：

```sh
A=artifacts/clued-validation/phase2-entry-preparation-20260908
for f in $(git ls-tree -r 88fc944b --name-only | grep -E "^$A/(bootstrap/root6-runtime-v19|root6-capacity)/.*\.json$"); do
  git cat-file -p 88fc944b:"$f" > /tmp/t.json
  c=$(grep -c 68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a /tmp/t.json)
  n=$(grep -c 2026-09-12T07:05:16Z /tmp/t.json); e=$(grep -c 2026-09-13T07:05:16Z /tmp/t.json)
  [ "$c$n$e" != "000" ] && echo "$(sha256sum /tmp/t.json | cut -c1-12) ctrl=$c nb=$n exp=$e $(basename $f)"
done
```

命中 **10 件**。其中 9 件入重出集，第 10 件（`Root6RegistrationAcceptance.json`）出局，理由见 §1.2。

### 1.1 入集的九件

| # | id | 路径（相对 `artifacts/clued-validation/phase2-entry-preparation-20260908/`） | lineage 家族 | issuedAt 现值（字段） | 序列化 | 是否移目录 |
|---|----|------|------|------|------|------|
| 1 | `PROP160` | `root6-capacity/Root6LinuxController160SourceRefCapacityProposal20260913.json` | `none` | `2026-09-12T23:37:12Z`（`created_at`） | indent 2 + LF | 否，原地 |
| 2 | `PROP4M` | `root6-capacity/Root6OriginalInput4000000CapacityProposal20260912.json` | `none` | `2026-09-12T07:09:18.112Z`（`created_at`） | indent 2 + LF | 否，原地 |
| 3 | `APPR4M` | `root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.v2.json` | `reissueObj` | `2026-09-12T07:09:18.112Z`（`approved_at`） | indent 2 + LF | 否，原地 |
| 4 | `APPR160v1` | `root6-capacity/Root6LinuxController160SourceRefApproval20260913.json` | `reissueStr` | `2026-09-12T23:41:49Z`（`approved_at`） | indent 2 + LF | 否，原地 |
| 5 | `APPR160v2` | `root6-capacity/Root6LinuxController160SourceRefApproval20260913.v2.json` | `reissueStr` | `2026-09-12T23:41:49Z`（`approved_at`） | indent 2 + LF | 否，原地 |
| 6 | `APPL` | `root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json` | `uriRef` | `2026-09-13T02:15:38.154Z`（`accepted_at`） | indent 2 + LF | 否，原地 |
| 7 | `REPR043` | `root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json` | `uriRef` | `2026-09-13T02:15:38.154Z`（`accepted_at`） | indent 2 + LF | 否，原地 |
| 8 | `QUAL` | `bootstrap/root6-runtime-v19/ScopedRoot5FinalControllerQualification.json` | `pathRef` | `2026-09-13T00:47:00.000Z`（`accepted_at`） | **indent 1，无尾随 LF** | **是 → v20** |
| 9 | `RTA` | `bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json` | `pathRef` | `2026-09-13T02:38:53.099Z`（`accepted_at`） | **indent 1 + LF** | **是 → v20** |

基底 sha256（前 12 位，`git cat-file -p 88fc944b:<path> | sha256sum`）：
`e224c379718a` / `40317abfd8f1` / `b69b793fbe0c` / `d3a90e311d4a` / `bc541370c238` /
`e7ec06c28bc9` / `d3f643b4a9d7` / `e7cfb30b1d62` / `fb3893147d48`。

**lineage 家族逐条依据**

- `pathRef`（QUAL / RTA）：`supersedes` = `{path, sha256, bytes, blob_sha}` + `supersedes_chain`。
  `jq -c '.supersedes' …` 实测。
- `uriRef`（APPL / REPR043）：`supersedes` = `{uri, sha256}` + `supersedes_chain`（链深 3）。
- `reissueObj`（APPR4M）：`reissue.supersedes` = `{path, sha256, bytes, blob_sha, owner_merge}`，
  即模板认识的那一种。
- `reissueStr`（APPR160v1 / v2）：**模板没有的第四家族**。`reissue.supersedes` 是一个
  **裸文件名字符串**，且指向的是**另一份文书**而不是自己的前身：
  ```
  jq -r '.reissue.supersedes|type' → string
  v1 → Root6OriginalInput4000000CapacityApproval20260912.json      （4M v1，不在重出集）
  v2 → Root6OriginalInput4000000CapacityApproval20260912.v2.json   （4M v2，在集内，原地重写）
  ```
  两者都是**原地同名重写 → 指针不变量 → 无可前移**。生成器对这一族断言
  「形态仍是 string」「字节未被改动」「所指文件在 BASE_REV 上存在」，并把它记为**已断言的
  no-op**，而不是套模板去写对象。模板的 `reissue` 分支若照跑，会把 string 换成 object、
  把这两件的 `substance_unchanged`（实测是一整段散文）覆盖成布尔 `false`。

**是否移目录的依据**：QUAL 与 RTA 的 `supersedes` + `supersedes_chain` 路径序列实测为
`v15 → v16 → v17 → v17 → v18`（现 `supersedes` 指 v18，自身在 v19）—— **史上每次重出都换目录**，
故 → v20。容量七件的世系用 blob uri 或裸文件名记，从未移动，原地重写。命令：
```sh
git cat-file -p 88fc944b:$A/bootstrap/root6-runtime-v19/ScopedRoot5FinalControllerQualification.json \
  | jq -r '.supersedes.path, (.supersedes_chain[].path)'
```
（注：链中 v17 出现两次，是前次重出留下的重复项，非本轮引入。）

### 1.2 命中但出局的一件

`root6-capacity/Root6RegistrationAcceptance.json`（`5996ab3e…`，`not_before`/`expires_at` 命中，
控制器摘要 0 次）：这是 **root6 注册体的独立受理件**。window12 不「重出」它 —— 按
`Window12RegistrationPortNotes.md` 第 10 行与 plan v2 步 6，root7 需要**新出**一份独立受理件
（`__PENDING_ROOT7_INDEPENDENT_ACCEPTANCE_REF_*__`）。把 root6 的这份做字符串替换会造出一份
「声称受理了 root7 注册体、但内容通篇是 root6 注册体检查记录」的文书。**不在本生成器范围内，
留给注册线。**

### 1.3 明确不重出的一件（沿用 window11 立场）

`root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.json`（4M v1，`d0649465…`）：
控制器摘要 0 次、窗口时间 0 次 —— **本轮判据下根本不命中**，无需援引 window11 的
`old_signed_objects_rewritten:false` 论证即出局。它仍被 `APPR160v1.reissue.supersedes` 按文件名
指向，而该指针是不变量（见上）。

---

## 2. 依赖序：实测重排，不沿用 v17 的顺序假设

生成器**不接受**写死的顺序。它对九件的基底字节两两扫描「A 的字节里是否出现 B 的 sha256 或
git blob sha1」，建图后 Kahn 拓扑排序，**再**与 `RECORDED_ORDER` 比对（不等即中止并要求人工
重测），所以顺序是实测的、而漂移是响的。

实测边（`X → Y` 读作 X 引用 Y，Y 必须先处理）：

```
PROP160   → （无）
PROP4M    → （无）
APPR4M    → PROP4M
APPR160v1 → PROP160
APPR160v2 → PROP160
APPL      → PROP160, APPR160v2
REPR043   → APPR160v2, APPL
QUAL      → PROP160
RTA       → PROP160, APPR160v2, APPL, REPR043, QUAL
```

得序：
```
PROP160 → PROP4M → APPR4M → APPR160v1 → APPR160v2 → APPL → REPR043 → QUAL → RTA
```

**与 v17 的实质差异**：v17 的序是 `QUAL, PROP → APPR → APPL → REPR → RTA`，**QUAL 在队首**。
本窗实测 **QUAL 引用 160 容量提案**（`PROP160 sha256 x1 + blob x1`），QUAL 不再是图的源点，
被推到 REPR043 之后。若沿用 v17 的顺序假设，QUAL 会在 PROP160 之前处理，从而钉住一个
即将作废的提案摘要 —— 判别器 NC2 复现的正是这条路。

---

## 3. 参数面

```
node work/window12-reissue/reissue-documents-window12.mjs \
     <newNotBeforeZ> <newExpiryZ> <newControllerSha256> [<newStatusManifestSchemaSha256>] \
     [--out <dir>] [--dry-run] [--runtime-dir <repo-rel dir>]
node work/window12-reissue/reissue-documents-window12.mjs --selftest
```

前三个参数与模板同名同义（F12，M3 后实化）。第四个是**本轮新增**：

`<newStatusManifestSchemaSha256>`，默认 `7e5df5dd2b23…`。依据：

```sh
D=scripts/phase2-qualification/control-context-verifier-root6-linux-successor
git cat-file -p 88fc944b:$D/status-manifest.root5.schema.json | sha256sum   # 510f3b90…（现值）
sha256sum $D/status-manifest.root5.schema.json                              # 7e5df5dd…（F12 预像）
```
并实测**确有文书引它**：RTA ×2、QUAL ×1、REPR043 ×1、APPL ×1，共 5 处。
（与 `M3AdjudicationsRound1.md` 的 `F12_STATUS_MANIFEST_SCHEMA_DIGEST_DECISION` 一致，本轮独立复测。）

**替换表全貌**（每行的出现次数逐件断言，计数漂移即中止）：

| 行 | from | to |
|---|---|---|
| controller sha256 | `68133f2d…` | `<newControllerSha256>` |
| controller blob | `6844a6ed…` | 新清单的 git blob sha1 |
| window not_before | `2026-09-12T07:05:16Z` | `<newNotBeforeZ>` |
| window expires_at | `2026-09-13T07:05:16Z` | `<newExpiryZ>` |
| **root 代际** | `ctrgen_5e0440a9…`（root6） | `ctrgen_26769cc7…`（root7） |
| **status schema sha256** | `510f3b90…` | `<newStatusManifestSchemaSha256>` |
| **散文「root6 window」** | `root6 window` | `root7 window` |
| 级联 | 每件处理完的旧 sha256 / blob | 其新 sha256 / blob |

后三行是本轮新增，前两行的依据：代际实测出现在 5 件共 9 处（window11 不需要这一行，因为那次
代际没变）；散文行实测只出现在 5 件共 7 处（`APPR4M` 的 `limitations[1]` 是
"only within the root6 window ending 2026-09-13T07:05:16Z" —— 只换时间戳会留下一句
「root6 窗口，截止 window12 的时间」的自相矛盾语句）。

---

## 4. 受理件的 R29/R30/R31 三项裁定（一次做对）

| 编号 | 字段 | 现值 | 重出后 |
|---|---|---|---|
| E1 | `accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256` | `f4002ae4…` | `__PENDING_STATUS24_PAYLOAD_SHA256__` |
| E2 | `accepted_subject.expected_ga.authority_source_ref.sha256` | `92186d46…` | `__PENDING_CP02_MEASURED_ROOT_DIGEST_POST_ROOT7_REGISTRATION__`（`uri` 不变） |
| E3 | `accepted_subject.expected_ga.issuer_ref.{uri,sha256}` | blob `3ae8bd41` / `80cf8f47…` | `__PENDING_ROOT7_ISSUER_GATE_QUALIFICATION_{URI,SHA256}__` |
| E4 | `accepted_subject.expected_ga.controller_qualification_ref` | `e7cfb30b…` | 由级联喂入新 QUAL 摘要，**并断言现值就是 e7cfb30b**（R31-F1：no-op） |
| 附带 A | `accepted_subject.expected_ga.stage_receipt_refs` | 6 条 / 5 唯一，`[2]===[3]`（blob `31c4574a`） | **原样保留，不去重** |

- **E2 的依据**：R31 附带 B 的两头堵按行号平移 —— `context.mjs:37` 强制 GA 深等 `expected_ga`，
  `:322` `ACTUAL_CURRENT_ROOT_REF` 强制 `ga.authority_source_ref.sha256 === canonicalDigest(root)`。
  root7 期「现任注册体」就是 root7 体，故钉 CP-02 那个**指名同一次测量**的占位符，避免两处各测一遍。
- **附带 A 的独立复核**：`grep -n EXACT_STAGE_INPUTS $D/context.mjs` → `:81`
  `ga.stage_receipt_refs.length===6`，硬谓词。去重得 5 → 必炸。判别器 NC4 就是故意去重一次。

### ⚠ E3：与本会话任务书**不一致**，按实测落地

任务书写的是「`issuer_ref` = 新 **STATUS** issuer 件」。实测**对这个字段而言是错的**：

```sh
D=scripts/phase2-qualification/control-context-verifier-root6-linux-successor
grep -n 'ACTUAL_GA_ISSUER_QUALIFICATION_REF\|EXACT_STATUS_ISSUER_REF' $D/context.mjs
#  :320  if(purpose==='GATE_AUTHORIZATION') check(same(result.ga.issuer_ref, issuers[0].qualification_ref), …)
#  :341  check(same(sm.issuer_ref, root.issuer_bindings.find(i=>i.purpose==='STATUS').qualification_ref), …)
git cat-file -p 3ae8bd4196f80266e2c2fda04a323a7b9d084840 | jq -c '.accepted_issuer_purposes'
#  [{"purpose":"GATE_AUTHORIZATION",…},{"purpose":"GATE_RESULT",…}]      sha256 = 80cf8f47…
git cat-file -p c1749399c047a5b88461ef8df54ea80b1b59938a | jq -c '.accepted_issuer_purposes'
#  [{"purpose":"STATUS",…}]                                              sha256 = 16409958…
```

- `:320` 只在 `GATE_AUTHORIZATION` 分支里约束 **`result.ga.issuer_ref`** → 受理件的
  `expected_ga.issuer_ref` 必须是 **GATE** 件。活字节佐证：现值正是 `3ae8bd41`/`80cf8f47`（GATE）。
- STATUS 件（`c1749399`/`16409958`）在 `:341` 绑的是 **`sm.issuer_ref`** —— 那是 **Status24 载荷**
  里的字段，另一份文件里的另一个对象。R31 v2 兼容映射写的也是「**载荷** `issuer_ref`」。

生成器按 `:320` 写 **GATE** 占位符，并在报告里注明。**若评审仍要在此处放 STATUS，那是一个要
对着 `context.mjs:320` 做的决定，不是改错别字 —— 我不替评审拍这个板。**

---

## 5. 与 v17 版的方法差异（逐条，全部实测）

| # | v17 的做法 | 本轮实测 | 后果 |
|---|---|---|---|
| 1 | 基底读工作树 | 本分支 QUAL/RTA 工作副本陈旧 | 改为 `git cat-file` 取 BASE_REV，两个陈旧 sha256 **具名拒收**（NC5） |
| 2 | 有「控制器目录」替换行（window10→11） | F12 由 `realize-f12.mjs:19` **原地**实化于 `…-root6-linux-successor` | **删除**该行；报告里 `dir_renamed: false` |
| 3 | （无） | `root6-runtime-v19` 在 QUAL/RTA 各出现 1 次，且都在 `superseded_draft_replaced_here.path`，其 `state` 字面量为 `SUPERSEDED_DRAFT_AT_THIS_SAME_PATH_…` | **不做**运行时目录字符串替换 —— 那会把一条历史事实搬去 v20。移目录只由输出路径表达 |
| 4 | 三个 lineage 家族 | 实测四个，多出 `reissueStr` | 见 §1.1；套模板会把 string 写成 object、把散文覆盖成 `false` |
| 5 | 断言全部 indent-2 + LF | 实测：7 件 indent-2+LF、RTA indent-1+LF、**QUAL indent-1 无尾随 LF** | 逐件实测 `{indent, trailing_lf}` 并做「原件往返复现」证明；照模板断言会当场拒掉九件里的八件 |
| 6 | 统一打毫秒时间戳 | 4 件是秒精度 | 按各件自身精度渲染新时间戳 |
| 7 | 顺序写死，QUAL 在队首 | QUAL 引用 PROP160 | 实测建图 + 拓扑排序 + 与 `RECORDED_ORDER` 比对 |
| 8 | 无代际替换行 | 代际实测出现 9 处 / 5 件 | 新增 `ctrgen_5e0440a9 → ctrgen_26769cc7` |
| 9 | 无 schema 摘要参数 | schema 摘要实测 5 处 / 4 件 | 新增第四参数 |
| 10 | `reissue.reason` 单字段豁免 | 本轮还有 `what_changed`、散文型 `substance_unchanged` | 豁免集扩到三个叙述字段，且**逐件记录**在报告 `narration_exempt` 里；世系节点与 `superseded_draft_replaced_here` 另行排除（它们指名旧字节是本职） |
| 11 | 变更审查靠「旧值不得残留」 | —— | 追加**逐件声明的变更规则集**（`subst`/`stamp`/`lineage`/`atomic`）：每条变更路径必须被某条已声明规则**精确解释**（`applySubs(旧值) === 新值`），每条已声明规则必须**真的触发**，否则 `UNDECLARED_CHANGE` / `DECLARED_RULE_DID_NOT_FIRE`。模式取自 `work/f12/verify-issuer-candidates.mjs` |

---

## 6. dry-run 与七条判别器（每条实测按预期失败）

```sh
node work/window12-reissue/reissue-documents-window12.mjs --selftest
# → "selftest": "SELFTEST_PASSED_NOT_A_REISSUE"，九件全出，七条负控制全部具名拒绝
```

dry-run 用一个假控制器摘要跑通全链、写进临时目录（`--dry-run` 不要求 F12 树已实化，
并跳过「必须在自己声明的窗口内签发」那条，因为 M3 尚未开窗）。

| 判别器 | 坏变体 | 实测拒绝 |
|---|---|---|
| NC1 | 改基底一个字节 | `BASE_BYTES_MISMATCH[NC1]:APPL: got 94ab37ff0bb1, pinned e7ec06c28bc9` |
| NC2 | 依赖序整体倒转 | `DEPENDENCY_NOT_YET_PROCESSED[NC2/NC3]:RTA depends on PROP160…` |
| NC3 | 漏掉一件（APPL） | `DEPENDENCY_NOT_YET_PROCESSED[NC2/NC3]:REPR043 depends on APPL…` |
| NC4 | `stage_receipt_refs` 去重 | `EXACT_STAGE_INPUTS_WOULD_FAIL[NC4]: … must stay 6 (context.mjs:81), got 5` |
| NC5 | 拿本分支陈旧工作副本当基底 | `STALE_WORKING_COPY_REFUSED[NC5]:RTA:775fd6446a45…` |
| NC6 | schema 摘要传成现值（未换代） | `STATUS_MANIFEST_SCHEMA_DIGEST_DID_NOT_CHANGE` |
| NC7 | 偷偷改一个未声明字段 | `UNDECLARED_CHANGE[NC7]:QUAL: schema_version …` |

要求的「至少 3 条」已超额；**坏变体若不失败，`--selftest` 自身以非零退出**
（`DISCRIMINATOR_DID_NOT_FIRE`），并且「以错误理由失败」也算失败
（`DISCRIMINATOR_FIRED_FOR_THE_WRONG_REASON`，每条负控制都钉了预期错误串的正则）。

**世系前移一代的正向证明**（dry-run 产物实测，非断言自证）：
```
RTA.supersedes.sha256        = fb389314…   ← 现件（v19），不是祖件
RTA.supersedes_chain[0]      = 98b58d82…   ← 原 supersedes（v18），被推入链首
RTA.supersedes_chain.length  = 4 → 5
RTA.superseded_draft_replaced_here.path 仍指 root6-runtime-v19   ← 未被搬走
残留扫描：68133f2d ×0、2026-09-12T07:05:16Z ×0、ctrgen_5e0440a9 ×0、510f3b90 ×0
```
生成器内部另有两条断言把这件事钉死：`LINEAGE_DID_NOT_ADVANCE_TO_THE_CURRENT_DOCUMENT`
（新 `supersedes.sha256` 必须等于本件基底 sha256）与
`LINEAGE_STILL_POINTS_AT_THE_GRANDPARENT`（必须不等于原 `supersedes.sha256`）。

---

## 7. 我拿不准的点（**不拍板**，留给评审）

1. **新运行时目录叫 `root7-runtime-v20` 还是 `root6-runtime-v20`。** 我默认前者，可用
   `--runtime-dir` 覆盖，且它只影响输出路径、不进任何文书字节。依据是弱的：史上前缀在
   `root5-final-runtime-v16 → root6-runtime-v17` 处换过一次，而 root6 注册的 `accepted_at`
   正是 `2026-09-12T07:05:16Z`；但 v16/v17/v18 三个目录都首见于**同一个** squash 提交
   `92deaea`，**我无法从日期证明换名与注册同刻发生**。文件基名仍写 `Root5`（`ScopedRoot5…` /
   `ExactRoot5Final…`）从未随代际改过，说明这套命名本来就不严格。**请评审定。**
2. **E3 放 GATE 还是 STATUS**（§4）。我按 `context.mjs:320` 实测落 GATE 并给出全部证据，
   但这与本会话任务书字面相反。**如果评审认定任务书为准，请连带说明 `:320` 怎么过。**
3. **`__PENDING_STATUS24_PAYLOAD_SHA256__` 是我新造的名字。** 既有占位符集里没有任何一个
   指 S24 载荷摘要。全表命令：
   ```sh
   grep -rhoE '__(F12|PENDING)_[A-Z0-9_]*__' work/ \
     artifacts/clued-validation/phase2-entry-preparation-20260908/ | sort -u
   ```
   我按既有构词法造了这一个。
   `status24/`（本轮禁**改**，只读允许）也核过了：其占位符是 `__PENDING_AS_OF__` /
   `__PENDING_EXPIRES_AT__` / 三代际那五个，**没有**指 S24 载荷摘要的名字 —— 因为载荷摘要是
   那套工具的**产出**而非输入。所以目前无冲突；但这个名字是我起的，**评审若另有偏好请改**
   （只在生成器的 `PENDING` 常量表里一处）。
4. **E2 复用 `__PENDING_CP02_MEASURED_ROOT_DIGEST_POST_ROOT7_REGISTRATION__` 是否合适。**
   值是同一个（root7 注册体的 canonicalDigest），复用能保证一次实化两处一致；但名字带
   `CP02_` 前缀，出现在受理件里读着怪。要么接受这个别扭，要么另立一个名字并**保证两处同源实化**。
   我选了前者。**请评审定。**
5. **`APPR160v1`（`d3a90e31…`）到底该不该重出。** 它命中判据（控制器摘要 ×2、窗口 ×3），
   我入集了。但它与 `APPR160v2` 是**平行**的两份 160 增补（v1 叠在 4M v1 上、v2 叠在 4M v2 上），
   而 RTA 只引用 v2（`APPR160v2 sha256 ×2 + blob ×2`，v1 一次都没被引）。
   **v1 是否还有活效力、还是已被 v2 整体取代**，我没有判据；不重出它则它继续钉着作废的
   控制器摘要，重出它则多出一份没人引的新件。**请评审定。**
6. **受理件字节预算。** 重出后 RTA 为 127865 字节（原 127644，+221）。R31 记过
   「候选 129006 字节，:39 上限 131072，余量约 2KB」；但我实测 `context.mjs:39`
   `BOUNDED_STATUS_JSON` 约束的是 **`parseStoredStatus(raw)` 的 status manifest JSON**，
   不是受理件。我在全库没找到约束受理件大小的谓词。生成器因此**只报告不断言**
   （`byte_budget_note.measured_cap_found_for_acceptance: null`）。
   **若正式重出还要往 `known_open` 里加条目（R31 的 E4 会加，本生成器没加），先把真实上限落实。**
7. **`known_open += R29/R30/R31` 没做。** R31 的重钉工具有这一步（E4），本会话任务书的三项
   裁定里没有它。我没自行扩范围。**若正式重出需要，是在本生成器上加一条已声明的 atomic 编辑。**
8. **`Root6RegistrationAcceptance.json` 的归属**（§1.2）。我判它属注册线、不属重出线，
   理由充分但这是个边界划分，**若评审认为它该进重出集，我的 DOCS 表要改。**

---

## 8. 纪律边界（本会话实际做过什么）

- 只读：`git cat-file` / `sha256sum` / `grep` / `jq`。**Supabase 一次未查**（只读 select 虽被允许，
  但本轮所有结论都能从 git 字节复算，就没去查；`charged_seconds`、三代际等**活库量**本文件
  一个都没引用，凡引用处都注明出处是既有文档而非本轮实测）。
- 写入：只新建 `work/window12-reissue/` 两个文件。dry-run 一律写 `mktemp -d`，**仓库内无产物**。
- 未做：正式重出、写库、`append_event`、预留、600 秒、开 PR、合并。
- 未动：`scripts/phase2-qualification/`、`artifacts/.../bootstrap/next-window-m3/`、
  `artifacts/.../root6-capacity/status24/`。
