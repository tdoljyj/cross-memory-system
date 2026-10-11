# Integration Runtime contract — errata

`IntegrationRuntime.v0.1.8.md` is immutable: its bytes are never edited, and its
SHA-256 stays `ec96275cafa2bf0b09ba5abc18e4728b1d385fb63fc6dd9d5bf76d6f570c234d`.
A defect found in the frozen text is recorded here as a numbered erratum, with an
Owner Decision as its authority. An erratum amends the contract's semantics; it
never rewrites the frozen file, and no implementation may "explain away" a gap in
place instead of raising one.

Each erratum states what the frozen text says, why it is wrong or incomplete, and
what replaces it. Implementations follow the frozen file as amended by every
erratum below.

---

## ERRATA-001 — `§7.1` facts document: `connection_store`; C4/C5 by `§7.2`

- **Authority:** Owner Decision `9d6fa6c2-65fd-405a-89c4-e81a435374ef` (2026-09-24).
- **Raised by:** the Fresh-Context review of PR #338 (S2c PR-1), findings MAJOR-1 and MINOR-1.
- **Status:** in force. Implemented by PR-1 (migration `20260926000000`).

### 1. `clued.integration-facts.v1` gains a required key `connection_store`

**What the frozen text says.** `§7.3` defines `C7_CONNECTION_STORE_INCONSISTENT`
with four conditions: more than one CURRENT connection row, a connection pointing
at another owner's Binding, a missing ownership row, and an ownership row naming a
different Integration. The `§7.1` facts document carries no field from which any
of those four can be read, and `§7.1` rule 2 makes an unknown key `C1`.

**Why that is a defect.** `§8.6` makes the derivation a pure function that reads
no table, so it cannot inspect the connection store itself. With no carrier in the
facts, `C7` is unreachable: an inconsistent connection store would derive a normal
state instead of `DERIVATION_INPUT_INVALID`. That is fail-open, against `§7.3`.

**What replaces it.** `clued.integration-facts.v1` has one more required top-level
key:

- Key: `connection_store`
- Domain: `CONSISTENT`, `MULTIPLE_CURRENT`, `FOREIGN_BINDING`,
  `OWNER_ROW_MISSING`, `OWNER_MISMATCH`

Any value other than `CONSISTENT` yields `C7`, mapping one-to-one onto the four
conditions `§7.3` already lists. The key is required, so a document that omits it
is `C1`, and it takes part in `facts_sha256` like every other key.

**Consequence for later PRs.** The PR-2 normalizer must emit `connection_store`,
derived from the connection rows and the Binding ownership rows it reads.

### 2. C4 and C5 follow `§7.2`, not the literal `§7.3` formulas

**What the frozen text says.** `§7.2` states that any `identity_claim_facts` value
other than `CONSISTENT` is `C4` or `C5`. The `§7.3` formulas for `C4` and `C5`
additionally condition on `identity_claim_state`, which makes some non-`CONSISTENT`
values valid: `CURRENT_CLAIM_HOLDER` with `UNEXPECTED_CURRENT_ROW`, and
`CLAIM_CONFLICT` with `MISSING_CURRENT_ROW`.

**Why that is a defect.** The two sections contradict each other for those cases.

**What replaces it.** `§7.2` governs. The mapping does not depend on
`identity_claim_state`:

| Claim-store value | Code |
|---|---|
| `MISSING_CURRENT_ROW` | `C4` |
| `KEY_MISMATCH` | `C4` |
| `UNEXPECTED_CURRENT_ROW` | `C5` |

This resolves the conflict on the fail-closed side.

### 3. Two schema tightenings, both `C1`

Both are fail-closed refinements of `§7.1` rule 2 and `§5.6`:

- A `revocation_state` that disagrees with its `revocation_source` is `C1`. The two
  are one truth class in `§7.2`, so an inconsistent pair is a malformed document.
- A non-null `mask` on a value that `§5.6` does not mask is `C1`. `mask` is present
  on every truth class; it is an array only for `RESTRICTED`, `CONDITIONAL` and
  `DEGRADED` values, and JSON null otherwise.

### Boundary

This erratum changes contract semantics only. It grants no production migration,
Worker release, flag enablement, public RPC EXECUTE, public visibility, budget or
procurement.

---

## ERRATA-002 — spellings the validator refuses: integers, `actions`, instants

- **Authority:** items 1 and 2, Owner Decision
  `793ea908-3281-430d-8bfd-8e0b83bfd226`; item 3, Owner Decision
  `25edd152-0d95-4cf7-b3eb-0ff32aed74d0` (both 2026-09-24), and Owner Decision
  `37e0f626-f9f7-43c1-b899-4d7584b952ab` (2026-09-25) for the wording of item 3,
  which corrects what item 3 says without changing what the validator does, and
  Owner Decision `c79a6278-4cfa-478a-aa04-e98ff379c17a` (2026-09-25) for item 3's
  Evidence paragraph and its note on residual instant non-canonicality, likewise
  wording only.
- **Raised by:** the Fresh-Context delta reviews of PR #338 — items 1 and 2 by
  the first review's MAJOR-1, item 3 by the second review's MINOR-1; item 3's
  wording by the Fresh-Context review of PR #340, MAJOR-2, and by its second
  delta review, MINOR-1, MINOR-2 and NIT-1.
- **Status:** in force. Items 1 and 2 implemented by PR-1
  (migration `20260926000000`); item 3 by its follow-up.

Items 1 and 2 exist for the same reason: the frozen contract requires a canonical
byte representation in places where it specifies only a value, and JSON admits
several spellings of one value. Rather than rewrite a document before hashing or
comparing it, the validator refuses the ambiguous spellings. Item 3 is not a
canonicality rule and does not claim to make an instant's spelling unique. It
refuses two spellings for a different reason: they do not denote the instant they
appear to spell.

### 1. Integer-valued fields accept only the integer spelling

**What the frozen text says.** `§7.2` gives `reauth_marks_open` the domain
"整数 ≥ 0", and `§5.12` gives `policy.policy_version` an integer version. JSON
does not distinguish `0` from `0.0`, so both documents satisfy those domains.

**Why that is a defect.** `§7.1` rule 1 requires that the same truth always
yields the same `facts_sha256`. `jsonb` preserves the submitted spelling, so
`{"reauth_marks_open": 0}` and `{"reauth_marks_open": 0.0}` are the same truth
with two different hashes. Canonicalising the document before hashing would make
`facts_sha256` a hash of something the caller did not submit.

**What replaces it.** `reauth_marks_open` and `policy.policy_version` are `C1`
unless their `jsonb` text form matches `^[0-9]+$`. `0.0` and `1.0` are therefore
`C1_SCHEMA_INVALID`. (`1e2` needs no rule: `jsonb` already stores it as `100`.)

### 2. Ceiling entry `actions` is de-duplicated and sorted

**What the frozen text says.** `§5.2` states the rule asymmetrically: `scopes`
must be a subset of the three v12 scopes, de-duplicated and sorted, while an
entry's `actions` must only take v12 values and be non-empty.

**Why that is a defect.** `§10.12` has restore record `ceiling_before` and
`ceiling_after` in its Receipt, which requires one ceiling to have one `jsonb`
representation. Without a canonical order, `["read","write"]` and
`["write","read"]` are the same ceiling with different bytes, and a Receipt
cannot show whether authority changed.

**What replaces it.** An entry's `actions` must be de-duplicated and sorted in
`C` collation, exactly as `scopes` already is. This does not change containment:
`§10.11` compares `actions ⊆ C.actions` as sets, which is order-insensitive.

### 3. An instant may not be spelled a way PostgreSQL re-points

**What the frozen text says.** `§7.1` gives no lexical grammar for an instant at
all — only the example `"2026-09-24T12:00:00Z"` — and `§7.2` sources `as_of` and
`canonical_runtime_verification_facts.valid_until` from `timestamptz` columns.

**Why that is a defect.** Two spellings PostgreSQL accepts do not denote the
instant they appear to spell: it re-points `24:00:00Z` to `00:00:00Z` on the next
day and `12:00:60Z` to `12:01:00Z`. `valid_until` is inside `facts_sha256`, so a
document spelled either way is hashed, compared and acted on as a statement about
an instant it does not name. Nothing legitimate is lost: a normalizer formatting a
`timestamptz` cannot produce either spelling.

A third spelling class behaves the same way and needs no change, only a note that
it is load-bearing: a fractional second of seven or more digits is not rejected by
the cast either, it is *rounded* to the microsecond resolution `timestamptz`
actually has. The document keeps the digits it was written with, so
`12:00:00.1234567Z` is hashed as spelled but *read* as `12:00:00.123457`: the hash
covers a statement about an instant the document does not name.
The previous lexical rule already bounded the fraction at `(\.[0-9]{1,6})?`, and
that bound is retained here for exactly the reason above and not as an
afterthought. It is not part of the count below, because it is not new.

**What replaces it.** An instant keeps the previous lexical rule minus those two
spellings: hour `24` and second `60` are `C1`. That is all it is. It is not a
canonicality rule — the accepted grammar still spells one instant several ways,
each hashing differently (`2026-09-24T12:00:00Z`, `…T12:00:00+00:00`,
`…T12:00:00.0Z`, `…T12:00:00.000000Z`, `2026-09-24T07:00:00-05:00` and
`2026-09-24T13:00:00+01:00` are all the same instant and all accepted) — and it is
not the spelling a round trip produces either: at `TimeZone UTC`,
`'2026-09-24T12:00:00Z'::timestamptz::text` is `2026-09-24 12:00:00+00`, a space
separator and a two-digit offset, which the rule rejects. The new grammar is a
strict subset of the old one, so nothing is newly accepted; exactly 25 classes
are newly rejected, `h=0…23` with `s=60` and `h=24` with `m=00, s=00`, every
other out-of-range field already being a hard error in the cast rather than a
re-pointing.

That residual non-canonicality inside `facts_sha256` is knowingly retained, and
is not the inconsistency with items 1 and 2 that it can look like. The difference
is who the producers are. `0.0` and an unsorted ceiling are cheap for any producer
to avoid — item 1 costs a writer nothing, and item 2's own justification, stated
above, is symmetry with `scopes` plus `§10.12` needing one `jsonb`
representation per ceiling. An instant is not like that: a facts document is
also authored by hand, by the committed `§13.2` P5 golden vectors, whose `Z`
spelling is not the form a `timestamptz` round trip produces, and whose ISO-8601
spelling may legitimately vary between `Z` and `+00:00`, with or without a
fractional part. A canonicality rule would reject those well-formed documents, and
not only ill-formed ones. `§7.1` puts the problem where it belongs: it defines the
facts document as the output of `integration_normalize_v1`, so one spelling is
that function's to guarantee. Item 3 therefore refuses only the spellings that do
not denote the instant they name, and leaves single-spelling canonicality to the
PR-2 normalizer contract.

**Evidence.** The two regexes settle only half of the count. They differ in the
hour and second alternations alone, so the new grammar is a strict subset and
nothing is newly accepted; but by regex inspection the newly refused set is every
hour `24…99` and every second `60…99`, which is hundreds of classes, not 25. It
collapses to 25 only together with PostgreSQL's cast acceptance set, which
rejects outright, rather than re-points, every hour `25…99`, every second
`61…99`, every minute outside `00…59`, and hour `24` at any minute or second
other than `00`.

Both halves are asserted against a live PostgreSQL by the committed test
`apps/clued-cloud/tests/integration-runtime-derivation-db.test.mjs`, subtest
"`§7.1` lexical validation", over the ranges the count quantifies over rather
than at sampled points. It sweeps hour `00…99` × minute `{00,01,30,59,60,99}` ×
second `{00,01,30,59,60,61,99}`, plus hour `24` across all 60 minutes, and
asserts that the shipped rule accepts nothing the old one refused, that the set
of newly refused `(hour, second)` classes is exactly the 25 named above, and that
the cast accepts hour `24` at minute `00` only. The same subtest asserts the two
re-pointings, and that every accepted `Z` spelling in a 384-value sweep of hour
`00…23` × minute `{00,01,30,59}` × second `{00,01,30,59}` round-trips to the
instant it spells. That sweep is whole-second `Z` spellings only: its assertion
compares the round trip against the literal minus its `Z`, which a fractional
spelling cannot satisfy, so the accepted fractional spellings listed above are not
covered by it. The fractional bound is asserted separately, by the same subtest's
`…T12:00:00.1234567Z` and `…T12:00:00.123456789Z` rejection cases together with a
live cast showing the first of them rounding to `12:00:00.123457`.

### Boundary

As ERRATA-001: semantics only, no production, release, flag, grant, visibility,
budget or procurement authority.

---

## ERRATA-003 — `§6.2` headless Bindings are one provider connection each

- **Authority:** Owner Decision `591a0fc6-9d93-47a6-802b-480448b45212` (2026-10-05).
- **Raised by:** the Fresh-Context review of S2c PR-2 (tdoljyj/cross-memory-system#551),
  finding MAJOR-4.
- **Status:** in force. Implemented by PR-2 (migration `20261005090000`).

**What the frozen text says.** `§6.2` derives the connection identity of an OAuth
Binding from `OAUTH_V12_CLIENT_ID` evidence: the server reads
`authorizations_v12.client_id`, and `provider_connection_id = sha256(client_id)`.
Every Binding that has an `authorizations_v12` row is therefore provider
`clued.oauth.v12`, connection kind `OAUTH_V12`.

**Why that is incomplete.** Headless issuance (`authorizations_v12.issuance =
'headless'`) was added after the freeze, by migration `20261004120000`. Every
headless authorization carries the same `client_id`, `clued-headless`: it names
the issuance path, not an OAuth client. Read literally, `§6.2` would make all of
one owner's headless Bindings a single provider connection, so that any of them
could take over another's Integration as a `SAME_PROVIDER_CONNECTION` rebind
(`§10.3`), and `§5.5` O5 / O7 would revoke or block all of them together. That is
a fail-open reading: the shared `client_id` is not evidence that two headless
Bindings are the same connection.

**What replaces it.** For a Binding whose `authorizations_v12.issuance` is
`headless`, `§6.2` derives:

- provider `clued.binding.v1`, with `provider_connection_id = binding_id`, exactly
  as for a raw Binding: one provider connection per Binding;
- connection kind `OAUTH_V12`: authority (scopes and entries), liveness and expiry
  still come from `authorizations_v12` and `authorization_entries_v12`, as for any
  OAuth Binding.

Two consequences follow, and both are part of this erratum:

- `fresh_consent` (`§10.3`) applies to `issuance = 'oauth'` only; a headless grant
  is never fresh consent for a ceiling expansion.
- `§5.5` O7's revocation-boundary check reads only providers whose
  `connection_source` is `OAUTH_V12_CLIENT_ID_SHA256`, so it does not apply to a
  headless Binding.

The provider-and-kind pair `clued.binding.v1` / `OAUTH_V12` is new; no other
provider or kind changes.

**Rejected alternative.** Refusing headless Bindings as connection callers and
adoption targets (`binding_not_adoptable`) until an erratum existed. It is safe,
but it leaves headless users unable to use Integrations at all.

### Boundary

As ERRATA-001: semantics only, no production, release, flag, grant, visibility,
budget or procurement authority.

---

## ERRATA-004 — `§10.3` a ceiling's `project:*` covers the `project:<id>` entries it materializes

- **Authority:** Owner Decision `82e4534a-feb9-418a-b1c9-b817f3183901` (2026-10-05).
- **Raised by:** the Fresh-Context review of S2c PR-2 (tdoljyj/cross-memory-system#551),
  finding MINOR-7.
- **Status:** in force. Implemented by migration `20261005100000`, which replaces the PR-2
  functions `integration_covers_v1` and `integration_ceiling_intersect_v1` with unchanged
  signatures. No object older than S2c is changed.

**What the frozen text says.** `§10.3` compares a ceiling `C` with an authority `A`
entry by entry: `covers(C, A)` holds when every entry of `A` has an entry in `C` with
the same `resource_kind`, `resource_id` and `environment` whose `actions` contain its
own. `C_eff` lowers the ceiling with the same per-entry intersection.

**Why that is incomplete.** Migration `20261004210000` (after the freeze) lets the
Owner grant "我的全部项目（含以后新建的）" as one `scope` entry `project:*`. It then
materializes that grant as one `scope` entry `project:<id>` per project, and adds one
more whenever the Owner creates a project. That new entry is not in an Integration's
stored ceiling, so `covers` reads it as a scope expansion. The Integration's own
connection is then refused as `reauthorization_scope_expansion_forbidden`, including
a `SELF` verification repair, although the Owner consented to future projects when
granting `project:*`.

**What replaces it.** In a ceiling-shaped value, an entry
`{resource_kind: 'scope', resource_id: 'project:*', environment: E, actions: X}` also
grants `X` on every `{resource_kind: 'scope', resource_id: 'project:<uuid>',
environment: E}` entry. For any `(kind, id, environment)`, the actions a value grants
are the union of two sets:

- the exact entry's actions;
- for a `project:<uuid>` target only, the same environment's `project:*` actions.

Both operations use these granted actions:

- `covers(C, A)` holds when, for every entry of `A`, its actions are a subset of what
  `C` grants on that key.
- `C ∩ A` contains, for every key named on either side, the actions both sides grant,
  and omits a key whose intersection is empty.

Everything else is unchanged:

- A ceiling without `project:*` does not cover a new project. That is still an
  expansion and still needs `fresh_consent`.
- `project:*` covers only `scope` entries whose id is the canonical lowercase
  `project:<uuid>` form, in the same environment. It never covers `global`,
  `profile`, an uppercase or otherwise non-canonical id, or another resource kind.
- Actions beyond `project:*`'s are still an expansion.

**Rejected alternatives.**

- Excluding materialized entries from the comparison. That would require marking
  entries as materialized, a larger change.
- Keeping the refusal and requiring a new OAuth consent after every project the Owner
  creates.

### Boundary

As ERRATA-001: semantics only, no production, release, flag, grant, visibility,
budget or procurement authority.

---

## Note — `§13.2` P2 (c) sample counts are two obligations

Not an erratum: the frozen text is correct and is restated here because PR-1
briefly under-ran it. `§13.2` P2 (c) requires **250,000** fixed-seed random facts
in CI **and** 2,000,000 nightly. They are separate obligations. Neither may be
reduced to meet a self-imposed runtime budget; the contract sets no CI runtime
budget. Owner Decision `793ea908-3281-430d-8bfd-8e0b83bfd226` restores the CI
count to 250,000 and has PR-1 wire the nightly run rather than defer it.

---

## ERRATA-005 — 凭据校验值、发行方代际与 Worker 数据库运输边界

- **Authority:** Owner Decision `0cd38218-f627-4557-a2dc-23892ada6412`; approval must name the exact reviewed proposal hashes. This is the only field filled from the actual acceptance receipt when appending.
- **Raised by:** P0-4 DatabaseCallerAuthentication 第2a/2b、C1与G6阶段2，及冻结文本的运输/凭据表达差异。
- **Status:** in force upon that Owner Decision. Implementation evidence is separate from semantic acceptance.

**What the frozen text says.** `§5.13`、`§10.1`及`§12.3`记载了历史 `anon, authenticated` Binding 数据库通道及按 `token_hash` 查找/锁定；其文字未区分客户端证明、库内校验值和 Worker 运输角色，也未描述发行方稳定身份与凭据代际。

**Why that is incomplete.** 按这些历史表达直接使用存储列值或把 Binding 证明视为任意 public RPC 的运输授权，会绕过已接受的凭据与调用方隔离边界。此勘误使冻结合同按已接受并实施的 P0-4 分层认证机制解释，保留原事务、CAS、Receipt、身份派生及业务守卫。

### Replacement

| 冻结条款／现行后继依据 | 原文不足与拟澄清 |
|---|---|
| IntegrationRuntime §5.13（712–720行）、§10.1通道表（1203–1216）、§12.3（1832–1838）；DatabaseCallerAuthentication §§4.7、6.2–6.3、8第5/6步 | 冻结 Binding 通道目标 grant 的 `anon, authenticated` 是历史阶段目标，不是永久可绕过 Worker 的授权。C1完整阶段2生效后，当前精确 Worker manifest 的 Binding/后台RPC通过 `clued_worker_gateway` 运输，仍须原 Binding/issuer认证及业务守卫；Native/Operator的真实用户JWT与P5各自通道保持原权限和语义。阶段1只加授并保旧权限，不能提前称匿名面已关闭；GW授权也不等于开启Integration flag、采纳Integration或宣称READY。 |
| IntegrationRuntime §10.1认证/L1（1292–1300）、§12.3证明值；DatabaseCallerAuthentication §§4.1、4.7–4.8 | 客户端证明约定仍为 `p_token_hash=sha256(token)`；库内 Binding/RC认证列是带域的 `cv1:` verifier。原“按token_hash查找/锁定/复核”须读为按受控 verifier解析并锁定该 Binding，而非把已存列值直接当 proof。保原一次L1锁、排序、事务前授权拒绝、CAS/Receipt规则；不因哈希转换恢复旧raw-Binding fallback或放宽身份/权限。事务内部映射只解决嵌套Binding校验，不授予Worker运输身份。 |
| DatabaseCallerAuthentication §4.8及§8第2/6步；对冻结 §10.1/§12.3的认证说明作限定，不修改§6.2/§7.4身份／摘要合同 | 2b将非秘密稳定 `issuer_id` 与credential generation/verifier分开；入口仍接proof或原secret，由私有resolver先验证有效代再映射固定历史身份。历史64hex issuer列、PK/FK及不可改登记/Receipt/verification JSON原字节保留，不一概改成cv1或当认证后门。初始旧代只可在首次迁移后的受限≤24h窗口内认证；新代实际正测后立即退旧，retired/expired代不得恢复。两issuer分别切换，身份/代ID/stored verifier都不能代替proof，普通换钥匙不撤销整个issuer或扩大既有授权。 |
| 同上，2b具体域由70001固定 | 旧registration digest `/2`按原不可变输入核验；新 `clued.storage-client-registration/3`绑定稳定UUID，由服务端不可变request-version sidecar选版。旧persisted verification `/2`保原值；新 `clued.storage-persisted-verification/3`记录`issuer_kind`/`issuer_id`/`credential_generation`，无secret/proof/verifier字段。新旧受控身份匹配保历史link/replay；不能由调用者选择旧版绕认证。该`/3`是存储注册/持久核验域，**不是**重写Integration `facts_sha256`、§7.4 `subject_digest`或§6.2 `provider_connection_id`；ERRATA-003/004的身份与ceiling规则不变。 |
| IntegrationRuntime §10.1已退役声明（1216）、§12.3；DatabaseCallerAuthentication §5、§6.2 | 当前v12 OAuth provider校验实时Binding/scopes后以加密props里的`bindingToken`转入Binding路径，再由Worker使用GW JWT。旧SupabaseOAuth JWT→`clued_oauth_call`不被恢复；合法直接Native用户JWT不等于合法authenticated G6嵌套路径。G6阶段2只信任真实请求role及PostgREST已验证JWT顶层role同时等于GW，坏/空/非object claims统一拒绝42501；不能信任SD中的`current_user=postgres`、公开build SHA、请求headers或Binding内部proof/GUC作运输授权。保原业务body和attestation；DB `transport_precheck_ready`与Worker提升的`closed`明确不同。 |
| IntegrationRuntime §11分类/传输（1724–1752）；DatabaseCallerAuthentication §5与§6.3 | G6运输角色拒绝为授权拒绝，不归入Integration request-rule成功envelope；GW JWT缺失/无效是服务配置/运输失败，不冒充用户同意成功。Binding业务拒绝、Native/P5 JWT错误与既有规则/CAS/Receipt语义按各自现行实现保留，最终以真实HTTP矩阵为证。**G6不在CI8**；anon8只是Clued应用公开门口集合，不撤Supabase平台`auth.uid()/auth.jwt()`权限，不暗示全部平台函数只有8个。 |

当前CI精确8项均为`public.<name>(text,jsonb)`：`clued_owner_grant_admission_door_v1`、`clued_owner_grant_door_consume_v1`、`clued_work_verify_v1`、`clued_work_claim_adopt_v1`、`clued_work_merge_slot_return_v1`、`clued_work_claims_active_v1`、`clued_work_merge_slot_touch_v1`、`clued_work_merge_slot_holders_v1`。与GW80交集仅`work_verify`及`work_claims_active`两项。最终接受须从当时实际CI/hooks源重新提取并pin精确签名；未来新增不凭文档旧名单或不明ACL自动放行。两旧alias `clued_project_mutate(text,jsonb)`/`clued_storage_jobs_v2(text,jsonb)`在候选中仅显式撤匿名直达，不扩GW82，不改业务定义、Native/P5或内部SD路由；未知对象/ACL漂移须拒绝。

域边界补充：`storage_client_redirect_identity_v3`并非持久化旧digest；70001在每次比较两侧统一使用稳定UUID，域标签仍为`clued.storage-client-redirect-identity/2`。不能把函数名v3误报成该域已换`/3`，也不能把“原位保留历史registration/verification字节”泛化为所有派生比较都继续使用旧proof输入。

### Implementation and evidence boundary

2a、2b及C1过渡分别由 `20261008210000_credential_verifier_v1.sql`、`20261009070001_issuer_identity_credentials_v1.sql`、`20261009070002_worker_gateway_transition_v1.sql` 实施。阶段2为 `20261010161848_worker_gateway_closeout_v1.sql`，SHA256 `e3d6f9066eb09d27d58393d5e5c756d0632c64e1124692a489faec2357f67e38`。PR713合并来源 `d225ba56f16b0263d67b620c46bf56163c69e1e4`，官方单迁移工作流 `38101290453` 成功，生产历史版本 `20261011011706`；实施结果记录于Task `9a4d6d2c-517d-4c9c-b798-9921b86b8d5b` 及Receipt `016203c8-4f87-4034-886b-ea21a2e2e810`。

阶段2前后17项目录检查、四项非目标指纹与实际匿名EXECUTE拒绝、合法GW运输证据各按其范围有效。业务 `not_ready` 仍须真实来源满足，不因HTTP200或此勘误变为 `closed`。P5角色当时不存在，不能声称新的生产P5正例。Native原定义与权限完整保留；安装后的原目录页面/取消操作、安装前实际created-root V2预览分层记录，不把前者冒称后者的新RPC测试。历史失败、抽样和未现场执行范围保留在原Task及接受证据中。

`23d196f2-a6d5-4116-9d18-8c4091ddf925`仅将本次生产观察下限改为6小时，其余验收条件保持；不改变2b初始旧代最大24小时有效窗或逐把新代实测后立即退旧的要求。后续Native范围修复与账本登记不属于本次G6迁移内容。

### Boundary

冻结 `IntegrationRuntime.v0.1.8.md` 的319146字节和SHA256 `ec96275cafa2bf0b09ba5abc18e4728b1d385fb63fc6dd9d5bf76d6f570c234d`保持不变，ERRATA-001–004原字节保持不变。本条只修正所列语义，并同步HeadlessBindingIssuance、WorkClaimAdmission §4.6、OwnerCredential §9及StorageNormalUse §6.2的对应说明。它不授予新的生产迁移、部署、机密操作、公开可见性、权限、预算、采购、Bootstrap、模型或Integration flag，也不代表整个产品业务READY。
