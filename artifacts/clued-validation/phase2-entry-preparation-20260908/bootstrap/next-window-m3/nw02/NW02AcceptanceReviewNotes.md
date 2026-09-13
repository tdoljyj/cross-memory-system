# NW-02 独立受理复核记录

**评审方**：独立评审会话（未参与主体件、参数件、SQL、骨架的起草，未撰写被检验的裁定）。
**分支**：`claude/nice-fermat-njqlmm`，复核时 head `177dc32`。以下命令的工作目录均为仓库根。
**时刻**：活库只读实测 `2026-09-13T06:40:34Z` 与 `2026-09-13T06:49:54Z`（后者为定稿基线）。
**边界**：全程只读。无任何库写、无 `append_event`、无预留、未授权 600 秒、未开 PR、
未合并、未改主体件、未改 `scripts/phase2-qualification/`。

## 0. 结论

| 文书 | state |
|---|---|
| `ContinuationRegistrationSubjectAcceptance.json` | `REJECTED_EXACT_SUBJECT_NOT_ACCEPTED_FOR_OWNER_SIGNATURE` |
| `ContinuationControlStoreAcceptance.json` | `NW02_TRANSACTION_SHAPE_ACCEPTED_INSTANCE_REJECTED_NOT_EXECUTED` |

**出具拒绝。** 唯一阻塞项是 NW02-R1：`approval.proposal_path` / `proposal_sha256`
指错了文书，而这对字段在被 Owner 签名的字节之内。主体件其余部分逐项复核后全部成立，
质量上乘；拒绝范围很窄，修复成本是一次重生成。

控制库件把两件事分开判：**事务形态受理**（逐行核过，与 M3 条款一致），
**本次实例拒绝**（既无已受理的主体件，且已备 SQL 自身钉的是骨架摘要）。

## 1. 对 NW02-R1 的独立判断（父会话裁定不成立）

父会话裁定 `NextWindowPlanV2Window12Cycle.md` 为提案对应物，理由两条：
**(a) 与载体同一次合并；(b) 含「需要 Owner 的动作」节。** 两条都检验过。

### (a) 同次合并 —— 不具区分度

```sh
git diff --name-status f92cd46e^1 f92cd46e | wc -l     # 48 个文件
```

同一次合并里同样「有理据」的至少还有 `R29OwnerDecisionAndNextWindowPlan.md`、
`Round32Review.md`、`M3AdjudicationsRound1.md`、`M3DraftNotes.md`。同次合并选不出唯一解。

### (b)「需要 Owner 的动作」节 —— 被本目录自己的实测推翻

这是裁定唯一的文书特异性理由，而它**恰恰是该文书写错的那一节**。
本目录的 `NW02FindingExtraOwnerMerge.md`（NW02-F1）已据 `NW01Parameters.json` 实测证明：
该节漏列了续窗合并，Owner 剩余动作应为 **4 次而非它列的 3 次**。

即：被举为提案的文书，在它被举证的那一节上，误述了它所声称提出的 Owner 义务。

再者 M3 载体自述该计划在实质上不足以描述被批准的范围：

```sh
python3 -c "import json;print(json.load(open('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ExplicitOwnerApprovalM3.candidate.json'))['cp02']['additional_classes_this_draft_believes_required_but_plan_v2_step_3_does_not_name']['rule'])"
# ... "Plan v2 step 3 was an omission, not an exclusion."
```

### 该字段的既定含义

本文书族里这个词的含义由唯一先例固定：NW-01 主体件指向
`bootstrap/next-window-20260912/OwnerApprovalProposal.md`（19938 字节），其小节为
Approval action / Fixed window rule / Exact scope / accepted_binding maintenance boundary /
Control plane maintenance boundary / Generation registration boundary —— 是载体的散文对应物。
**M3 载体自己也这样用这个词**：`previous_authorization.proposal` 指的正是该件。

```sh
grep -n "^#" artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-20260912/OwnerApprovalProposal.md
grep -n '"proposal"' artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ExplicitOwnerApprovalM3.candidate.json
```

而 `NextWindowPlanV2Window12Cycle.md` 是 7315 字节的循环工单，自述状态
`PLAN_SUPERSEDES_R29_SHEET_STEPS_3_TO_7`，上述小节一个没有。

### 真正的提案是 PR 164 正文

只读取回 PR 164 正文后可见，它逐节对应 NW-01 提案的结构：
「What this carrier is for」给出批准动作与固定窗口规则（*Merging this document is the Owner
authorization that opens window12. Its `committed_at` becomes T; the window is T + 86400
seconds, non-rolling.*）、「What is in the package」给出确切范围含 NW-02 条款、
「Self-approval boundary」写明 *The Owner merge is the approval gate*、
「Capacity and authority — unchanged」给出预算效果、
「Still gated on the Owner after this merge」**正确**列出 Owner 后续义务
（M4、root7 `append_event`、预算预留、600 秒）—— 正是计划 v2 写错的那一项。

`NW02DraftNotes.md` 开放点 3 排除它的理由是「不是仓库对象，取不到稳定摘要」。
**这条理由在本世系里不成立**：主体件自己钉的 `OwnerApprovalVerification.json` 就是对取回的
API 响应做的，并记着 `api_bundle_sha256 = 2a6f178272f556625d6300c94265f4e59df039d648398bdafe38cd2384cbb61f`，
其 bundle 含 pull-request 响应。对提案取稳定摘要，本链条已有现成办法。

### 为什么这构成拒绝而非「附条件受理」

- 该对字段是主体件里**唯一**记录「Owner 被告知自己在批准什么」的地方；
- 实测证实**没有任何闸门读它**（控制器源码里 `subject_sha256` 零命中；活库唯一消费方
  `accepted_binding_subject_sha256_check` 只钉摘要值不校验形态）—— 所以评审是唯一的控制点；
- 修复极廉价：主体件仍是 `CANDIDATE_FOR_OWNER_SIGNATURE_NOT_LIVE`，本文书之前无任何受理件，
  库里没有它的摘要，SQL 带 NOT FOR EXECUTION 横幅。重出一次即可。
- 而同一字段在 NW-01 指「提案文书」、在 NW-02 指「上游工单」，且无从分辨，是永久的。

在「改一次」与「永久签下一条不成立的出处」之间，前者显然。

## 2. 实测通过项（每条可复现）

### 2.1 主体件本体

```sh
D=artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/nw02
sha256sum $D/ContinuationRegistrationSubject.canonical.json
# fa4b9ea33d47a7509be4c7a687375bdee74f649e35b2bf579366f9d8ff7c4624   （3626 字节）

python3 -c "
import json,hashlib
raw=open('$D/ContinuationRegistrationSubject.canonical.json','rb').read(); d=json.loads(raw)
canon=json.dumps(d,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()+b'\n'
print('21 keys        :',len(d)==21)
print('byte-identical :',raw==canon)
print('trailing LF    :',raw.endswith(b'\n'),'| CR present:',b'\r' in raw)
"
# canonical 形式（sorted keys + compact + LF）逐字节复现成功；NO_FLOATS 亦成立
```

### 2.2 活库只读实测（`uscrdifznmlvczcekqpw`）

```sql
select to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') as measured_at_utc,
 (select sequence from clued_control.current_head)             as head_seq,
 (select generation_id from clued_control.current_head)        as head_gen,
 (select revoked from clued_control.current_head)              as head_revoked,
 (select max(sequence) from clued_control.events)              as max_gen_event,
 (select sequence from clued_control.execution_current)        as exec_seq,
 (select charged_seconds from clued_control.execution_current) as charged_seconds,
 (select charged_evidence_bytes from clued_control.execution_current) as charged_bytes,
 (select active_ga_id from clued_control.execution_current)    as active_ga_id,
 (select pending_budget_sequence from clued_control.execution_current) as pending_budget_seq,
 (select count(*) from pg_trigger
   where tgrelid='clued_control.accepted_binding'::regclass and not tgisinternal) as non_internal_triggers;
```

实测 `2026-09-13T06:49:54Z`：

| 项 | 实测 | 主体件 | |
|---|---|---|---|
| `current_head.sequence` | 6 | `current_head_sequence: 6` | ✓ |
| `current_head.generation_id` | `ctrgen_5e0440a9…` | 同 | ✓ |
| `current_head.revoked` | false | false | ✓ |
| `events` 最大 sequence | **6** | `append_new_generation: false` | ✓ **root7 不存在** |
| `execution_current.sequence` | **89** | `execution_baseline.sequence: 89` | ✓ |
| `charged_seconds` | **9906** | 9906 | ✓ |
| `charged_evidence_bytes` | 2201594803 | 同 | ✓ |
| `active_ga_id` / `pending_budget_sequence` | null / null | null / null | ✓ |
| 非内部触发器数 | **1**（`accepted_binding_immutable`，`tgenabled=O`）| —— | ✓ 满足 R11-F13 |

**关键点：主体件记的是活头 root6 seq6，不是待注册的 root7。** 这是对的 ——
`events` 最多到 6，root7 尚未注册；写 root7 会写下当时不成立的事实。

`signed_object_sha256` 亦来自活库而非文档抄录：

```sql
select request->'body'->'signature_binding'->>'signed_object_sha256'
from clued_control.events where sequence=6;
-- 95973246e3ae8d33fe407960d41e47039399575c59b4f78f83882835e73d9f80   ✓
```

上限算术（主体件自述可复算）：`9906 + 600 = 10506` ✓；
`2201594803 + 134217728 = 2335812531` ✓。

### 2.3 `approval.*` 对 M3 合并事实

```sh
sha256sum artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ExplicitOwnerApprovalM3.candidate.json   # e1fcd30a…  ✓
sha256sum artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/OwnerApprovalVerification.json           # a15169bc…  ✓
sha256sum artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/NextWindowPlanV2Window12Cycle.md   # 73489f68…  ✓（摘要对，文书错，见 §1）
git log -1 --format='%cI %P' f92cd46e42e20e1fa305c573964e0597230c0b65
```

**未采信仓内取证件，另行只读取回 GitHub API 复核：**
`committer.login = web-flow` ✓、`author.login = tdoljyj` ✓、PR 164 `merged_by = tdoljyj` ✓、
`commit.committer.date = 2026-09-13T05:45:14Z` ✓ = 主体件 `not_before`；
`expires_at` = +86400s = `2026-09-14T05:45:14Z` ✓；恰两个父提交 ✓。

**诚实边界**：本次 API 读取未返回签名 verification 块，
故 `verification: "verified:true;reason:valid"` 这一串只对上了
`OwnerApprovalVerification.json`（其摘要本会话已对字节复核），未做新鲜的签名自证。

### 2.4 `window_maintenance` 对 M3 nw02 条款

七字段、三检查与 `nw02.allowed_changed_fields` / `allowed_replaced_checks`
**逐元素同序一致** ✓。`temporarily_disabled_trigger`、`trigger_restored_same_transaction` ✓。
`fail_closed_on_mismatch` 未单列，由 `storage_candidate.currentness` 的
`FAIL_ON_DRIFT_OR_UNKNOWN` 承载 ✓。
`guards_added_beyond_nw01` 的两处来源均已打开核实存在：
M3 `nw02.transaction_guards_required_beyond_nw01`（R11-F12）与
`nw01-execution/NW01ExecutionReceipt.json` 的 `read_back.non_internal_trigger_note`（R11-F13）✓。

`application_ordinal: 5` 对既有世系 2 / 3 / 4 成立：

```sh
grep -rn '"application_ordinal"' artifacts/ | grep -o 'application_ordinal": [0-9]*'
```

### 2.5 已备事务形态（控制库件受理的对象）

`NW02Applied.sql` 的写语句仅：一次 `disable trigger`、一次三约束 `drop`、
一次**单行** `update`（恰七列，`where root_id=…`）、一次三约束 `add`、一次 `enable trigger`。
前置块以字面量逐条钉旧 CHECK 定义并 fail-closed；前后两块各自断言窗口
（`clock_timestamp()` ∈ 窗口，R11-F12）与非内部触发器普查（R11-F13）。形态成立 ✓。

## 3. 反向找茬（主体件写下不成立的事实 / 该有而缺的字段）

### NW02-O1 —— `schema_sha256` 指的 schema，主体件全项不合（既存，不归 NW-02）

```sh
sha256sum protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json
# 87f094fa07…  ← 与主体件 schema_sha256 相同
python3 -c "
import json
s=json.load(open('protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json'))
d=json.load(open('$D/ContinuationRegistrationSubject.canonical.json'))
print('schema title:',s['title'],'| object_type const:',s['properties']['object_type'])
print('additionalProperties:',s['additionalProperties'])
print('主体件缺的必填键:',len(set(s['required'])-set(d)))
print('schema 不允许的多余键:',len(set(d)-set(s['properties'])))
"
```

结果：schema 是 **ControlTrustRootSet**（`$id: urn:clued:schema:control-trust-root-set:v1`，
`object_type` 为 const `ControlTrustRootSet`，`additionalProperties: false`），
而主体件 `object_type` 是 `AcceptedBindingContinuationWindow`、
**缺 15 个必填键、多 16 个被禁键**。即主体件声称遵从一个它彻底不合的 schema。

另查：`proposal_path` 在 `protocol/` 与 `scripts/` 中零命中，
`AcceptedBindingContinuationWindow` 亦无任何 schema 定义 —— 主体件形态确实无闸门。

**不作为拒绝理由**：该值自 NW-01 继承，活库行里就是它；`schema_sha256` 不在七个可改字段内，
NW-02 无权修；主体件若另写反而与它所描述的行不符。上交给该行 schema 绑定的责任方。

### NW02-O2 —— 次序条款在 B 案里落空（Owner 选择，非起草缺陷）

M3 `nw02.ordering.nw02_before_generation_registration: true`（载体称经 Round 32
「pins it as a hard clause so the order cannot drift silently」）在采用的 B 案主体件里无对应键。
实际只靠 `current_control_root.append_new_generation:false` + `current_head_sequence:6`
加执行时的精确前像 CAS 承载。`M3AdjudicationsRound1.md` 当初正是为此偏好 A 案。
**已在本会话出具的控制库受理件里显式写出该次序**，使其不再只靠推断。

### NW02-O3 —— 已合并的 M3 载体违反自己的占位符规则（载体级）

```sh
python3 -c "
import json,re
raw=open('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ExplicitOwnerApprovalM3.candidate.json',encoding='utf-8').read(); d=json.loads(raw)
print('state:',d['state'])
print('存活占位符:',len(set(re.findall(r'__PENDING_[A-Z0-9_]+__',raw))))
print('自述:',d['placeholders']['resolution_deadline'])
"
```

载体 `state` 仍为 `DRAFT_PENDING_VERIFIED_OWNER_MERGE`，26 个占位符全部存活，
而其 `placeholders.rule` 写着「All placeholders must be resolved (and this state field
advanced) before the pull request carrying this document is opened for the Owner」、
`resolution_deadline` 写着「none survives into the merged document」。
对照：**NW-01 载体合并时存活占位符为 0**。

机制本身仍成立（三个 `M3_*` 是载体自己在
`this_document_must_not_contain_its_own_merge_time` 里说明的先有鸡先有蛋，
其物化按 NW-01 先例记在 `OwnerApprovalVerification.json`）。不成立的是载体关于自己的那段自述。

### NW02-O4 —— 主体件未覆盖活库行的两列

`audience`（`urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw`）
与 `algorithm_config`（`SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE;SHA-256;GITHUB_API_VERIFIED_OWNER_MERGE`）
不在主体件中，故不在 Owner 签名覆盖范围内。后者意味着
**主体件没有写明计算它自己摘要所用的规范化规则**。NW-01 同样如此，B 案又定为严格沿用
NW-01 键集，故记录而不归咎 NW-02。

### NW02-R2 —— 已备 SQL 会把骨架摘要写进库（起草方已自曝）

```sh
sha256sum $D/ContinuationRegistrationSubjectAcceptance.skeleton.json   # b422667081…
sha256sum $D/ContinuationControlStoreAcceptance.skeleton.json          # 645f886e…
grep -n "registration_acceptance_sha256=\|store_acceptance_sha256=\|subject_sha256=" $D/NW02Applied.sql
```

`NW02Applied.sql` 与 `nw02-parameters.json.postimage.binding` 钉的是
`subject_sha256 = 338a3487…`（已被 `fa4b9ea3…` 取代）、
`registration_acceptance_sha256 = b422667081…` 与 `store_acceptance_sha256 = 645f886e…`
—— **正是两份骨架文件的摘要**，而骨架自己写着
`sha256_of_this_skeleton_is_NOT_..._sha256: true`；
`signature_evidence_sha256 = 0a3dfa95…` 与目录中任何文件都对不上。

**这是自曝而非隐瞒**：SQL 带 NOT FOR EXECUTION 横幅并列出四份文书，
生成器无 `--draft` 拒绝出件，参数件 `digest_sources_note` 直言
「None of these four digests may enter the database」。
记录于此，是为了使本受理件不被误读为对该文件现状的放行。

## 4. 活库时效警告

定稿基线实测时（`06:49:54Z`），活 `accepted_binding` 距失效仅 **921 秒**
（`expires_at = 2026-09-13T07:05:16Z`）。故控制库件里
`accepted_binding_currently_expired: false` **只在实测那一刻为真**，读到本记录时多半已不成立。
NW-02 自身窗口不受影响（`2026-09-13T05:45:14Z` 已开，至 `2026-09-14T05:45:14Z`）；
window11 绑定在此期间失效是活库的一段空档，不是 NW-02 的障碍。
执行前必须按 `required_before_execution` 重测前像。

## 5. 本会话做了什么 / 没做什么

**做了**：只读 select（两次）、GitHub API 只读取回（commit 与 PR 164）、
仓内字节摘要复算、canonical 形式复现、出具两份受理件与本记录。

**没做**：任何库写、`append_event`、预留、600 秒、开 PR、合并、
改主体件（O1–O4 与 R1 均只写入受理件，未自行修改）、改 `scripts/phase2-qualification/`。

## 6. 修复后需重做的次序

1. 按 NW02-R1 的补救之一重出主体件 → 新 `subject_sha256`
2. 重出本两份受理件（摘要随动）
3. `build-nw02-sql.mjs` 重生成
4. 新鲜独立评审 + 新鲜活库前像
5. 执行
