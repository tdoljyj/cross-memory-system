# NW-02 独立受理复核记录 —— **第二轮**

**本文覆盖第一轮记录（提交 `668888b`）。** 第一轮出具拒绝，唯一阻塞项 NW02-R1 已修，
本轮对**新主体件**重新出具。第一轮的结论一条都没有沿用：所有「已核准项」本轮自行重算。

| | |
|---|---|
| **评审方** | 第二轮独立评审会话。未参与主体件、参数件、SQL、骨架、`OwnerApprovalProposalPR164.provenance.json` 的起草；未撰写被检验的裁定；**也未撰写第一轮受理件** |
| **分支 / head** | `claude/nice-fermat-njqlmm`，复核时 head `b629625`（≥ `603037b`） |
| **主体件** | `nw02/ContinuationRegistrationSubject.canonical.json`，3633 字节，sha256 `e75176b5dcdbc909086c12ddd72d70b811e4e969c8e79eb20c80771f4fb29ee2` |
| **活库只读实测** | `2026-09-13T07:21:04Z`、`07:21:14Z`、`07:22:08Z`（project `uscrdifznmlvczcekqpw`） |
| **边界** | 全程只读。无库写、无 `append_event`、无预留、未授权 600 秒、未开 PR、未合并、未改主体件、未改 `scripts/phase2-qualification/`、未改 `work/cp02/`、`work/twentyfirst-forward/`、`status24/` |

以下命令的工作目录均为仓库根；`D` 一律指
`artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3`。

```sh
D=artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3
```

## 0. 本轮结论

| 文书 | state |
|---|---|
| `ContinuationRegistrationSubjectAcceptance.json` | **`ACCEPTED_EXACT_SUBJECT_FOR_OWNER_SIGNATURE_ONLY`** |
| `ContinuationControlStoreAcceptance.json` | `NW02_TRANSACTION_SHAPE_ACCEPTED_PREPARED_INSTANCE_REJECTED_NOT_EXECUTED` |

**主体件受理。** NW02-R1 已修且本轮独立坐实。新增两条非阻塞发现（NW02-R3、NW02-O5），
其中一条纠正的是第一轮自己的记录。

本轮出具件的摘要（供 `build-nw02-sql.mjs` 重生成时对文件复算核对，**不得直接抄用**）：

| 文书 | 字节 | sha256 |
|---|---|---|
| `ContinuationRegistrationSubject.canonical.json`（主体件，非本轮出具）| 3633 | `e75176b5dcdbc909086c12ddd72d70b811e4e969c8e79eb20c80771f4fb29ee2` |
| `ContinuationRegistrationSubjectAcceptance.json` | 26298 | `406269b83d6ce4bafd8b89d87f3b70f8b89ca207328ccf2f85d9a61cc854b808` |
| `ContinuationControlStoreAcceptance.json` | 18095 | `a6bb7c3165f405b9a003b6715fa89fb3fd58e23455f538934df88110549574e0` |
| `ContinuationSubjectSignatureEvidence.json` | —— | **尚不存在**：须在续窗合并之后捕获 |

```sh
sha256sum $D/nw02/ContinuationRegistrationSubject.canonical.json \
          $D/nw02/ContinuationRegistrationSubjectAcceptance.json \
          $D/nw02/ContinuationControlStoreAcceptance.json
```

控制库受理件 `registration_acceptance.sha256` 钉的正是主体受理件的上述值（已交叉核对一致），
故两件的出具次序（主体受理件先、控制库件后）与骨架 `__skeleton__.ordering` 的要求一致。

**已备 SQL 实例仍拒绝。** NW02-R2 原样未动（如预期 —— 它待主体件定稿后重生成）。
受理件里写清了「重生成后要满足什么才算合格」共 14 条。

---

## 1. NW02-R1 是否真的修好了 —— 本轮自己取回 API 比对

### 1.1 自取 PR 164 正文，不看旁挂件

```sh
S=$(mktemp -d)
curl -sS -w "HTTP:%{http_code}\n" \
  -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  -o $S/pr164.json https://api.github.com/repos/tdoljyj/cross-memory-system/pulls/164
# HTTP:200

node -e '
const fs=require("fs"),c=require("crypto");
const j=JSON.parse(fs.readFileSync(process.argv[1]+"/pr164.json","utf8"));
fs.writeFileSync(process.argv[1]+"/body.md", j.body, "utf8");
const b=fs.readFileSync(process.argv[1]+"/body.md");
console.log("bytes", b.length, "sha256", c.createHash("sha256").update(b).digest("hex"));
console.log("has CRLF:", j.body.includes("\r\n"));
console.log("created/merged/updated:", j.created_at, j.merged_at, j.updated_at);
' $S
```

实测：

```
bytes 6461 sha256 b340f46d1aeb64b338651504cf42b67ef643c56508517a6fca0efd49a40b2827
has CRLF: false
created/merged/updated: 2026-09-13T05:24:12Z 2026-09-13T05:45:14Z 2026-09-13T05:45:14Z
```

### 1.2 与归档件逐字节比对（不是比摘要，是 `cmp`）

```sh
cmp $D/OwnerApprovalProposalPR164.md $S/body.md && echo "byte-identical"
sha256sum $D/OwnerApprovalProposalPR164.md
od -c $D/OwnerApprovalProposalPR164.md | tail -2
```

- `cmp` 无差异 → 归档件就是 API 响应 `body` 字段的原样。
- 摘要 `b340f46d…` = 主体件 `approval.proposal_sha256` ✓，也 = 旁挂件 `captured_sha256` ✓。
- `od` 显示文件止于 PR 正文最末的 `)` / `_`，**没有补尾换行** —— 这正是原样捕获的样子，
  而人手写出或编辑过的 Markdown 几乎必然带尾换行。

### 1.3 「是否混入事后撰写的文字」—— 坐实，非证伪

字节与 API 响应逐位相同，则插入字符集合按构造为空。旁挂件的
`state: "CAPTURED_NOT_AUTHORED"` **成立**。

### 1.4 正文是否在批准之后被改过

`updated_at == merged_at == 2026-09-13T05:45:14Z`。PR 正文任何编辑都会推高 `updated_at`，
故合并之后无改动。（GraphQL `userContentEdits` 在本环境被网关拒绝 ——
`GitHub GraphQL is not available from Claude Code sessions` —— 这是 REST 能给的最强证据，
已在受理件里如实标明。）

### 1.5 为什么这个文书就是「提案」

```sh
grep -n '"approval_action"' $D/ExplicitOwnerApprovalM3.candidate.json
# "approval_action": "OWNER_MERGES_CONTAINING_PULL_REQUEST_VIA_GITHUB_WEB_FLOW"
git ls-tree -r f92cd46e --name-only | grep "next-window-m3/"
# 6 个：批准候选件、16→17 独立意见、两份笔记、两个脚本 —— 没有散文提案
```

载体自述批准动作就是「Owner 合并载有本件的 PR」。被呈给 Owner 的即该 PR，其散文即正文。
且 M3 世系**在树内根本没有**对应 NW-01 `OwnerApprovalProposal.md` 的散文提案可指 ——
指 PR 正文是唯一指向「真正扮演了这个角色的东西」的选择。

**与 NW-01 的差别（记录，不归咎）**：NW-01 提案在批准合并 `cbe898d3` 的树内；
本件首次提交于 `6816597`，在批准之后。但路径钉要在**签名那次合并**的树里成立，
届时它在树内，故钉可解析。

```sh
git log --oneline --diff-filter=A -- $D/OwnerApprovalProposalPR164.md   # 6816597
```

---

## 2. NW02-R3（**本轮新增，非阻塞**）—— 旁挂件的第二条理由不成立

旁挂件 `why_not_the_plan_document` 末句：*"This PR body states those obligations correctly."*
第一轮记录同样写了「**正确**列出 Owner 后续义务 …… 正是计划 v2 写错的那一项」。**实测不成立。**

```sh
awk '/需要 Owner 的动作/{f=1} f{print} f&&/^## /&&++n>1{exit}' \
  artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/NextWindowPlanV2Window12Cycle.md
# M3 合并（含 root7 注册与 cp02 授权条款）、M4 合并（定稿文书）、root7 注册执行授权、
# 预算预留授权、600 秒授权。

sed -n '/Still gated on the Owner after this merge/,/^## CI/p' $D/OwnerApprovalProposalPR164.md
# M4 (finalized documents), the root7 append_event ..., the budget reservation,
# and the 600-second run.
```

扣掉已完成的 M3 合并，**两份是同一张单子**。NW02-F1 的发现是「还欠一次发布本主体件与
两份受理件的续窗合并，且它不是 M4」—— PR 164 与计划 v2 一样漏了它。

**为何不阻塞**：提案之为提案，取决于它是被呈给 Owner 的那份东西，不取决于它写得对不对。
NW-01 的提案同样不以「正确」为成立条件。且该错句在 `authority_effect: NONE`
且主体件不钉的旁挂件里，**不在被签名的字节之内**；§1.5 的主理由不依赖它。

**欠的事**：续窗合并之前应订正或删除该句，免得仓库合入一条被实测推翻的记录。
本会话**未代为修改** —— 替起草方修补其理据不是独立评审该做的事。

---

## 3. 本轮自行重算的已核准项（每条附可复现命令）

### 3.1 主体件本体

```sh
python3 -c "
import json,hashlib,re
p='$D/nw02/ContinuationRegistrationSubject.canonical.json'
raw=open(p,'rb').read(); d=json.loads(raw)
canon=json.dumps(d,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()+b'\n'
print('bytes',len(raw),'sha256',hashlib.sha256(raw).hexdigest())
print('21 keys       :',len(d)==21)
print('canonical 复现 :',raw==canon)
print('尾 LF/无 CR/纯 ASCII:',raw.endswith(b'\n'), b'\r' not in raw, all(b<128 for b in raw))
print('哨兵          :',sorted(set(re.findall(r'__[A-Z0-9_]+__',raw.decode()))))
"
```

实测：3633 字节 / `e75176b5…` / 21 键 / canonical 逐字节复现 True / 尾 LF 有、无 CR、纯 ASCII /
**哨兵 0**。递归扫描无任何 float（NO_FLOATS 成立）。

### 3.2 B 案 = 严格沿用 NW-01 键集

```sh
python3 -c "
import json
a=json.load(open('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-20260912/ContinuationRegistrationSubject.canonical.json'))
b=json.load(open('$D/nw02/ContinuationRegistrationSubject.canonical.json'))
print('键集相同:',set(a)==set(b),'| 各',len(a),len(b))
print('取值不同的键:',sorted(k for k in a if a[k]!=b[k]))
"
```

键集完全相同（各 21）；取值不同的恰为 7 块：`approval`、`current_control_root`、
`execution_baseline`、`expires_at`、`not_before`、`storage_candidate`、`window_maintenance` ✓

### 3.3 活库只读实测（`2026-09-13T07:21:04Z`）

```sql
select to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') as measured_at_utc,
 (select sequence from clued_control.current_head) as head_seq,
 (select generation_id from clued_control.current_head) as head_gen,
 (select revoked from clued_control.current_head) as head_revoked,
 (select max(sequence) from clued_control.events) as max_event_seq,
 (select count(*) from clued_control.events) as event_count,
 (select sequence from clued_control.execution_current) as exec_seq,
 (select charged_seconds from clued_control.execution_current) as charged_seconds,
 (select charged_evidence_bytes from clued_control.execution_current) as charged_bytes,
 (select active_ga_id from clued_control.execution_current) as active_ga_id,
 (select pending_budget_sequence from clued_control.execution_current) as pending_budget_seq,
 (select count(*) from pg_trigger where tgrelid='clued_control.accepted_binding'::regclass
    and not tgisinternal) as non_internal_triggers,
 (select string_agg(tgname||':'||tgenabled::text,',') from pg_trigger
    where tgrelid='clued_control.accepted_binding'::regclass and not tgisinternal) as trigger_names,
 (select request->'body'->'signature_binding'->>'signed_object_sha256'
    from clued_control.events where sequence=6) as sob_sha256;
```

| 项 | 实测 | 主体件 | |
|---|---|---|---|
| `current_head.sequence` / `generation_id` / `revoked` | 6 / `ctrgen_5e0440a9…` / false | 同 | ✓ |
| `events` max / count | **6 / 6** | `append_new_generation: false` | ✓ **root7 不存在** |
| `execution_current.sequence` | 89 | 89 | ✓ |
| `charged_seconds` / `charged_evidence_bytes` | 9906 / 2201594803 | 同 | ✓ |
| `active_ga_id` / `pending_budget_sequence` | null / null | null / null | ✓ |
| 非内部触发器 | **1**：`accepted_binding_immutable:O` | —— | ✓ 满足 R11-F13 |
| `signed_object_sha256`（**从 events 行 6 读，非抄文档**）| `95973246…` | 同 | ✓ |

上限算术自行复算：`9906 + 600 = 10506` ✓；`2201594803 + 134217728 = 2335812531` ✓。

**关键点仍成立**：主体件记的是活头 root6 seq 6，不是待注册的 root7 —— 写 root7 会写下当时不成立的事实。

### 3.4 `approval.*` 对合并事实（本轮 API 自取，且补上第一轮的诚实边界）

```sh
sha256sum $D/ExplicitOwnerApprovalM3.candidate.json $D/OwnerApprovalVerification.json \
          $D/OwnerApprovalProposalPR164.md
# e1fcd30a…  a15169bc…  b340f46d…   三者均 = 主体件所钉 ✓

curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/tdoljyj/cross-memory-system/commits/f92cd46e42e20e1fa305c573964e0597230c0b65 \
| node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
  console.log(j.commit.committer.date, j.committer.login, j.author.login,
              j.commit.tree.sha, j.parents.length,
              j.commit.verification.verified, j.commit.verification.reason);});'
# 2026-09-13T05:45:14Z web-flow tdoljyj 20ae3f15… 2 true valid
```

`committer.login = web-flow` ✓、`author.login = tdoljyj` ✓、PR 164 `merged_by = tdoljyj` ✓、
`committer.date = 2026-09-13T05:45:14Z` ✓ = 主体件 `not_before`；`+86400s` = `expires_at` ✓；
恰两个父提交 ✓；树 `20ae3f15…` 与 `OwnerApprovalVerification.json` 所记一致 ✓。

**补上第一轮的诚实边界**：第一轮记「本次 API 读取未返回签名 verification 块」。
本轮返回了：`verified: true, reason: valid` —— 与主体件
`verification: "verified:true;reason:valid"` 一致，该串现已获独立佐证。

`protocol_mapping_sha256` 本轮另行落地到文件（第一轮未做）：

```sh
git ls-files -z | xargs -0 sha256sum | grep -i abbc8e7eae03f2a183fd739fa49b16a97db6e1c0fb62a9353a30db81553db416
# scripts/phase2-qualification/nonproduction-control-store/protocol-successor/ControlUriMapping.json
```

### 3.5 `window_maintenance` 对 M3 `nw02` 条款

```sh
node -e 'const c=require("./'"$D"'/ExplicitOwnerApprovalM3.candidate.json"),
 s=require("./'"$D"'/nw02/ContinuationRegistrationSubject.canonical.json");
 const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 console.log("七字段同序:",eq(c.nw02.allowed_changed_fields,s.window_maintenance.changed_fields));
 console.log("三检查同序:",eq(c.nw02.allowed_replaced_checks,s.window_maintenance.changed_checks));'
```

七字段、三检查**逐元素同序一致** ✓。`temporarily_disabled_trigger = accepted_binding_immutable` ✓、
`trigger_restored_same_transaction: true` ✓。`fail_closed_on_mismatch` 未单列，
由 `storage_candidate.currentness` 的 `FAIL_ON_DRIFT_OR_UNKNOWN` 承载 ✓。
`guards_added_beyond_nw01` 两处来源本轮重新打开核实存在（R11-F12 / R11-F13）✓。

```sh
grep -rhn '"application_ordinal"' artifacts/ | grep -o 'application_ordinal": [0-9]*' | sort | uniq -c
# 2 / 3 / 4 / 5  → application_ordinal: 5 承接世系 ✓
```

### 3.6 已备事务形态（本轮从 SQL 原文重新推导）

```sh
grep -n -iE "disable trigger|enable trigger|^update |drop constraint|add constraint|^begin|^commit" \
  $D/nw02/NW02Applied.sql
grep -n "clock_timestamp" $D/nw02/NW02Applied.sql       # 49,50（前）/ 205,206（后）
grep -n "tgisinternal"   $D/nw02/NW02Applied.sql       # 120,127,132（前）/ 251,258,263（后）
```

写语句仅：一次 `disable trigger`(172)、一次三约束 `drop`(175-177)、一次**单行**七列
`update`(179-188，带 `where root_id=…`)、一次三约束 `add`(190-195)、一次 `enable trigger`(197)。
前块 fail-closed 钉：R11-F12 窗口断言、八表 `rows_sha256`、catalog 与 getter 两摘要、
行数 =1、旧行十六列字面量、`execution_current`/`current_head`、R11-F13 触发器普查与定义、
属主与 ACL、约束数 16 与排序名摘要、三条旧 CHECK 定义。
后块逐条对称断言新态（窗口断言、行数、十六列新值、`execution_current`/`current_head`、
触发器普查与已恢复的 `tgenabled=O`、属主与 ACL、约束数与名摘要、三条新 CHECK 定义），
末尾另有一条事务内 readback `select`。形态成立 ✓

注：后块的 `accepted_binding_subject_sha256_check` 新定义同样钉着过时的 `338a3487…`，
与 NW02-R2 一致 —— 该实例四处错值是成组出现的，不是单点笔误。

**十六列前像本轮对活库逐列核过**：

```sql
select root_id, not_before, expires_at, owner_approval_commit, subject_sha256,
       registration_acceptance_sha256, store_acceptance_sha256, signature_evidence_sha256,
       schema_sha256, audience, algorithm_config, (now() >= expires_at) as currently_expired
from clued_control.accepted_binding;
```

十六列全部与 SQL 前块字面量一致 ✓。其中四份 NW-01 文书摘要各自由对应文件复算得出：

```sh
N=artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-20260912
sha256sum $N/ContinuationRegistrationSubject.canonical.json \
          $N/ContinuationRegistrationSubjectAcceptance.json \
          $N/ContinuationControlStoreAcceptance.json \
          $N/ContinuationSubjectSignatureEvidence.json
# 64ae7adc… 5eb9c845… 89e4a851… 954faff1…  ←→ 活库行同值 ✓
```

**前像至今零漂移**（本轮新做的一条）：

```sql
select encode(sha256(convert_to((select jsonb_build_object(
  'accepted_binding',…,'gate_attempts',…))::text,'UTF8')),'hex') as rows_sha256, …;
-- 07:22:08Z → rows_sha256 795f2159…、getter def 9b6518b9…、prosrc 633269f1…
```

三者与 SQL 所钉（实测于 `06:04:42Z`）**完全相同** —— 控制库在该区间内一字节未动，
反向佐证期间无人（含本会话）执行过写入。

---

## 4. 反向找茬（本轮重算 + 新增）

### NW02-R2 —— 已备 SQL 会写入两份骨架自身摘要与已过时的主体件摘要（**仍未修，如预期**）

```sh
sha256sum $D/nw02/*.json $D/nw02/NW02Applied.sql
grep -n "subject_sha256=\|registration_acceptance_sha256=\|store_acceptance_sha256=\|signature_evidence_sha256=" \
  $D/nw02/NW02Applied.sql
```

七个写入值中三对四错：

| 字段 | SQL 写入 | 实为 |
|---|---|---|
| `not_before` / `expires_at` / `owner_approval_commit` | —— | ✓ 正确 |
| `subject_sha256` | `338a3487…` | 应为 `e75176b5…`（该草稿已被取代两次）|
| `registration_acceptance_sha256` | `b422667081…` | = **受理件骨架自身**摘要（骨架自写 `…is_NOT_…: true`）|
| `store_acceptance_sha256` | `645f886e…` | = **控制库骨架自身**摘要（同上）|
| `signature_evidence_sha256` | `0a3dfa95…` | **目录中任何文件都对不上**；取证骨架现摘要为 `4133e06a…`（NW02-F1 的 22 处哨兵改名发生在 SQL 生成之后）|

**该实例明确不可执行**，已写入控制库受理件的 `prepared_instance_rejected`，
并在同件 `requirements_a_regenerated_instance_must_satisfy_to_be_acceptable` 列出
**重生成后的 14 条合格条件**（摘要必须现场对文件计算、
`signature_evidence_sha256` 必须来自续窗合并后实化的取证件而**非 M4 的 `ecd4028e`**、
参数件 `digest_sources` 必须改指最终件、生成器须不带 `--draft`、形态与前后块断言清单、
前像须临执行前重测、须在窗口内、须排在 root7 `append_event` 之前、须再经一次新鲜独立评审）。

仍是自曝而非隐瞒：SQL 带 NOT FOR EXECUTION 横幅并列出四份文书，生成器无 `--draft` 拒绝出件，
参数件 `digest_sources_note` 直言「None of these four digests may enter the database」。

### NW02-O1 —— `schema_sha256` 与主体件形态不合（既存；**本轮修正了第一轮的读法**）

```sh
sha256sum protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json   # 87f094fa…
python3 -c "
import json
s=json.load(open('protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json'))
d=json.load(open('$D/nw02/ContinuationRegistrationSubject.canonical.json'))
print(s['title'], s['properties']['object_type']['const'], s['additionalProperties'])
print('缺必填:',len(set(s['required'])-set(d)),'| 多禁键:',len(set(d)-set(s['properties'])))
"
# ControlTrustRootSet ControlTrustRootSet False ; 缺 15 / 多 16
```

第一轮读作「主体件声称遵从一个它彻底不合的 schema」。**这个读法可能过强。**
在同族的注册主体件里，同一 schema 路径是以 `storage_candidate.schema_responsibility`
出现的 —— 指**根集**所遵的 schema，由
`scripts/phase2-qualification/control-root-registration/verify.py` 如此校验 ——
而非对承载文档自身的合规声明。按这个读法，`schema_sha256` 指的是本绑定所属信任根集的 schema，
不构成矛盾。文书没说清取哪个读法，**真正该向上游修的是这个歧义**。

不作为拒绝理由：该值自 NW-01 继承，本轮从活库 `accepted_binding.schema_sha256` 直接读出，同值；
且它是九个必须保持不变的列之一，NW-02 无权改。

### NW02-O2 —— 次序条款在 B 案主体件里落空（Owner 选择，非起草缺陷）

已在本轮出具的控制库受理件里
`allowed_maintenance.ordering_stated_explicitly_here_because_the_subject_does_not_carry_it`
显式写出，并给出可校验的具体条件（执行时 `events` max(sequence) 须仍为 6）。

### NW02-O3 —— 已合并的 M3 载体违反自己的占位符规则（载体级）

```sh
python3 -c "
import json,re
raw=open('$D/ExplicitOwnerApprovalM3.candidate.json',encoding='utf-8').read(); d=json.loads(raw)
print(d['state'], len(set(re.findall(r'__PENDING_[A-Z0-9_]+__',raw))))
n1=open('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-20260912/ExplicitOwnerApproval.candidate.json',encoding='utf-8').read()
print('NW-01 载体存活占位符:',len(set(re.findall(r'__PENDING_[A-Z0-9_]+__',n1))))
"
# DRAFT_PENDING_VERIFIED_OWNER_MERGE 26 ; NW-01 载体 0
```

机制本身仍成立；不成立的是载体关于自己的那段自述。

### NW02-O4 —— 主体件未覆盖活库行的两列

`audience` 与 `algorithm_config` 不在主体件内，故不在 Owner 签名覆盖范围。本轮从活库直接读出二者。
后者意味着主体件没写明计算它自己摘要所用的规范化规则。NW-01 同样如此，B 案又定为严格沿用
NW-01 键集（§3.2 已验），故记录而不归咎 NW-02。已备事务对这两列前后各断言一次，不会无声漂移。

### NW02-O5（**本轮新增**）—— 第一轮「`proposal_path` 零命中」的记载是错的

```sh
grep -rn "proposal_path\|proposal_sha256" scripts/ protocol/ kernel/ apps/
# scripts/phase2-qualification/control-root-registration/verify.py:100  subject['approval']['proposal_sha256'] == PROPOSAL_SHA
# scripts/phase2-qualification/control-root-registration/verify.py:102  subject['approval']['proposal_path'] == BASE + 'ControlRootGenerationBindingProposal.md'
```

对结论**无不利影响，反而加强修复的正当性**：该校验器管的是另一份文书
（`ControlRootRegistrationCandidate.json`，`generation_ordinal 1`、`predecessor None`、
钉死在 2026-09-09 窗口的字面量），确实没有任何闸门读**本**主体件的 proposal 字段，
故「评审是唯一控制点」的结论不变；但同族显示该字段是**真有闸门在读**的出处钉，
其既定形态就是「一份具名 `*Proposal.md` + 路径 + 摘要」—— 修好后的 NW-02 钉正是这个形态。

### NW02-O6（**本轮新增**）—— 笔记文件里的过时主体件摘要

主体件已四次重出，目录内并存四个不同摘要被当作现值引用：
`NW02FindingExtraOwnerMerge.md` 写 `80c2bbeb…`；第一轮记录与第一轮受理件写 `fa4b9ea3…`（3626 字节）；
SQL 与参数件写 `338a3487…`。**唯一现值是 `e75176b5…`（3633 字节）**。
散文里是无害的历史陈述，被抄进重生成的 SQL 就是事故 —— 故受理件第 1 条合格条件写死
「每个摘要必须现场对文件计算，不得从任何笔记、旧 SQL 或参数件抄」。

### NW02-O7（**本轮新增/更新**）—— 活库绑定现已失效

```sql
select to_char(expires_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'), now() >= expires_at
from clued_control.accepted_binding;
-- 2026-09-13T07:05:16Z | true   （实测于 07:21:14Z）
```

第一轮预告的事已发生：骨架里 `accepted_binding_currently_expired: false`（测于 `06:04:42Z`）
不再成立，本轮控制库受理件记 **true**。

**不构成障碍**：NW-02 自身窗口开着（`05:45:14Z` .. 次日 `05:45:14Z`），
事务内断言针对的是该窗口；被丢弃的旧 `accepted_binding_check` 钉的是
`expires_at <= 2026-09-13T07:05:16Z`，与活行仍然相符，前像断言不受影响。
window11 绑定的这段空档是活库的事实，不是 NW-02 的障碍。

---

## 5. 本会话做了什么 / 没做什么

**做了**：只读 `select` 三次（`07:21:04Z`、`07:21:14Z`、`07:22:08Z`）；
GitHub REST 只读取回两次（commit `f92cd46e`、PR 164）并把正文落盘后 `cmp` 比对；
仓内字节摘要复算；canonical 形式复现；SQL 原文逐块推导；
出具两份受理件（覆盖第一轮已出具件）与本记录。

**没做**：任何库写、`append_event`、预留、600 秒授权、开 PR、合并、
改主体件、改旁挂件、改 `scripts/phase2-qualification/`、改 `work/cp02/`、
改 `work/twentyfirst-forward/`、改 `status24/`。
NW02-R3 与 NW02-O5 均只写入受理件与本记录，未自行修改被指出的文件。

## 6. 下一步次序

1. 订正或删除旁挂件里那句话（NW02-R3）—— 不阻塞，但不宜合入错记录
2. **续窗合并**：发布主体件 + 本两份受理件（Owner 动作 1/4，见 NW02-F1）
3. 按世系脚本 `--as signature` 捕获签名取证件 → 得 `signature_evidence_sha256`
4. 更新 `nw02-parameters.json`（四个 `digest_sources` 改指最终件）→ `build-nw02-sql.mjs`
   **不带 `--draft`** 重生成
5. 新鲜独立评审（对照受理件的 14 条合格条件）+ 临执行前重测前像
6. 在窗口内、在 root7 `append_event` 之前执行
