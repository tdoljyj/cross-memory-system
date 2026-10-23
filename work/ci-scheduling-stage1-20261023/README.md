# CI scheduling Stage 1

Task `98dbf336-6831-416e-8a94-b36236f72726`; Owner decisions
`da3dd87b-b2c4-4526-9503-dfcc69282416@1` and
`b4cd00c5-32cd-4eec-a4fa-1c14416d4b98@1`.

This change prepares the service scheduling center. It does not activate node
transport, pool execution, stage 4, a machine installation or production schema.
Existing resident execution, its publisher and the frozen GW80/CI8 caller sets
remain independently governed.

## Design and compatibility

The exact v0.9 source archive has SHA256
`d87a58114b45dca119b3f6ccf48269a2df3ff3bb69ffdf6f66d238c598fd39be`;
the Markdown member has SHA256
`543d2660bc09322d7aaad7410b5a0db765468f47fd59cebd0d38a4c75559b3f4`.
The detailed v4 data/RPC design was independently reviewed with zero blocker,
major or minor findings; its SHA256 is
`cd2e7750d25c3c9ecaf65c069a98f0d05938b5984d201ed06e98a09ccbdf6286`.
The original design is retained in the authorized project library; this directory
contains the implementation contract, without duplicating that archive.

- A repository is permanently registered to exactly one Project pool per Owner.
  Moving a connection or creating another Project cannot reset keys or quotas.
- Execution/publish keys are permanent. UNKNOWN cannot be refunded, released
  into an ordinary retry, or converted to proven external absence.
- Rolling usage preserves each lease generation's original classification and
  time. Combination limits count distinct combinations in the window, rather
  than either a lifetime key or a sum of all executions.
- New admission checks all applicable limits atomically. Trusted settlement
  facts still commit after a limit is reached; the limit stops later admission.
  `waiting-retry` has no evaluation hold and retains its existing separate budget.
- Existing authentication locks precede Native confirmation and new business
  locks. Late revalidation cannot acquire an earlier Binding/Authorization lock.
- Native mutations require a live direct account session and a separate
  confirmation request bound to the complete view, session and base version.
  Registering/approving a node does not manufacture verified runtime eligibility.
- A signature observation is mathematical evidence only. It does not consume a
  nonce, create a trusted database request context or permit a business effect.
- A DRAINING work claim admits no enqueue, lease or start. Only the exact current
  generation and holder of an already started lease may renew or submit a result;
  historical settlement and release facts remain recoverable.
- A train keeps the exact maintenance request selected at acquisition. Every
  continuation checks that request's claim, head, Source and live Binding; front
  advancement rechecks train expiry after all business locks have been acquired.
- Result registration locks its exact nonce before the final fresh claim, node,
  lease and parent checks. Waiting for that lock cannot preserve expired authority.

The public profile has a fixed allowlist: `schema`, `site_id`,
`environment_kinds`, `slot_count`, `memory_limit_mb`, `identity_key_origin`,
`capabilities`, `exclusions`. It has no free-form diagnostic/extension object.
`slot_count` is required (1..64); optional memory is 0..1048576 MiB. Optional
schema is `clued.ci-node-profile/1`, site is a bounded public identifier, and
environment/capability values are enumerated by both the Native validator and
database. Submitted capabilities remain unverified declarations. Registration
never turns them into attestation or permission. Recognizable credential material
is refused without echoing it in an error.

Prepared quotas are either a complete six-integer set (each 0..1000000) or
`null` (UNCONFIGURED); a partial form cannot silently set a missing limit to an
unlimited value. This input bound is not an accepted production quota.

## Signature candidate protocol

`worker/ci-scheduling-v1.ts` is deliberately unreferenced by the active router.
Its transport entry always refuses with `SIGNATURE_GATEWAY_NOT_ACTIVATED`.
A future transport requires separate review and an atomic database context/nonce
contract before importing this candidate into any service route.
The current signature candidate reads existing trusted node rows; it is not a
self-service bootstrap path for a new node or an unapproved public key.

The signing domain is `clued.ci-node-command/1`. Keys are public P-256 JWKs with
exactly `crv,kty,x,y`. The fingerprint is lowercase SHA256 hex of the canonical
public JWK. Signatures use SHA256 ECDSA with a fixed 64-byte P1363 encoding,
unpadded canonical base64url. Nonces contain 32 random bytes. The full command
binds the operation, payload digest, authenticated tenant/Binding generations,
node/key versions, job/execution/train generations and an absolute lifetime no
longer than 120 seconds. The signature field itself is excluded from signed bytes.

Canonical JSON is a versioned subset: Unicode scalar strings, safe integers,
booleans/null, bounded plain objects and dense arrays, sorted UTF-16 object keys,
no accessors/toJSON, depth at most 16, 4096 values and 64 KiB UTF-8. It is not a
general RFC8785 implementation. Both signing and digesting use this same subset.
Public key validity, current trust and expiry are checked around asynchronous
verification; the private core must independently revalidate them under its locks.
The command's canonical-JSON `payload_sha256` and the private database's
server-derived, operation-scoped intent digest are separate hash domains. A future
transport must bind both to the same exact business document and principals;
neither digest may be substituted for the other or supplied as a caller assertion.

The private nonce issuer returns `{nonce_id, nonce, expires_at, receipt_id}`;
`nonce` is 32 random bytes encoded as 43 unpadded base64url characters. Only
SHA256 of that UTF-8 string is stored. Every effect consumes its exact nonce in
the same transaction. A consumed nonce can return the original safe result,
never run another effect or return deleted ciphertext.

The database intent domain is
`m1_sha256({operation,user_id,project_id,node_id,job_id,generation,payload})`.
Result, publication preparation and drop sending exclude `nonce_id`/`nonce`
from their business payload; preparation also excludes its `request_digest`,
which must equal the server-derived intent. Observation binds key/external ID,
presence result, check ID and evidence; green transitions bind entry/base state,
action/evidence/ancestor; drop taking binds group, logical request digest and
recipient fingerprint. The operation/purpose domains are `result-register`,
`publish-reserve`, `publish-observe`, `green-transition`, `drop-send`, `drop-take`.
New effect APIs missing the raw nonce fail closed. Observation/green recovery
retains the ability to settle an old publication after its original work claim
ends, under a current authorized Publisher; it cannot issue a new publication.

## Validation and activation gates

Dedicated tests use synthetic keys and an isolated local PostgreSQL cluster;
neither is an external or production qualification. Local PG18 evidence does
not claim PG17 production compatibility. No credential is needed in a source file.
The final frozen candidate passed 64 dedicated tests: 23 database core, 11 effect,
20 Native page and 10 real WebCrypto tests, with no failure or skip. Full app
TypeScript, scoped ESLint and the offline migration ledger also passed. The new
migration is pending, not recorded as applied. Independent design, Native,
signature, database core and effect reviews closed with zero remaining findings;
see `independent-review-summary.md` and `implementation-subject.v2.json`.

The main merge additionally depends on second-phase 3c and the primary/standby
C series. Source delivery uses the existing CI coordinator's normal window,
admission and FIFO; no paid fallback or pre-reserved merge slot.

## Cost assessment

The evaluated scheduler model is
`N × (86400/H + 86400/P) + 86400/L + J×R + U` requests/day.
For `N=3,H=P=L=120,J=100,R=8,U=1000`, this is 6840/day.
The independent JIT account must be measured separately:
`A×C×(1+Rj)+Bj`; `100×2×2+1000` is 1400/day.
These are examples, not accepted production caps or observed account headroom.
Missing Owner caps remain UNCONFIGURED and refuse formal reservation.

At 100 groups/day, two 64-KiB ciphertext copies are 12.5 MiB/day of payload;
permanent keys and audit growth require ongoing storage accounting. Public free
quotas do not prove current account capacity or CPU. CPU, real account baseline,
remaining storage and actual request usage are UNKNOWN until the relevant stage
is qualified. No paid fallback is enabled by this change.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
[Supabase pricing](https://supabase.com/pricing).
