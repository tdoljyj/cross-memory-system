# Storage client qualification: deployment control plane

This implements the reviewed-snapshot fallback in
[`AccountStorageInheritance.v0.1`](../../../development/contracts/storage/AccountStorageInheritance.v0.1.md).
It is platform maintenance, not a user-facing permission screen or a per-device grant.
Registering or qualifying a client does **not** create account storage consent, a
connection policy, a job, an admission, a Google grant, or a provider effect.

## Source capture and review

Run `scripts/storage-client-registration-source.mjs --help` from the reviewed,
clean deployment checkout. Supply an exact approved v12 request ID, its original
`authorization_requests_v12.request_digest`, the expected checkout commit, and
a **new** evidence file path. The collector derives the client ID from the
database request and the namespace from committed `wrangler.production.jsonc`.
It reads that one Cloudflare OAuth KV client key, then rechecks the request.
There is no provider list, write, retry, or automatic qualification.

The existing deployment environment supplies `CLUED_ATTESTATION_DATABASE_URL`,
`CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`; never put these values in
arguments, output, Evidence, Git, browser storage, or ordinary Agent tools.
Git subprocesses receive a minimal noncredential environment with helpers
disabled. Raw `ClientInfo.clientSecret`, including a hash, is not evidence.
Only the explicit nonsecret SDK metadata allowlist is serialized. Unknown
schema changes fail closed and need review; missing metadata is not invented.

Review the source, supported `clued.storage-agent/1` behavior, and exact target
before ingesting the JSON as private Evidence through the existing authenticated
Clued contract. Hash the **original UTF-8 bytes including the final LF** and
record byte size. The source document is valid for initial register/link for
30 minutes, with at most 60 seconds of future clock skew. This freshness check
is not a user storage permission lifetime.

## Private mutation contract

Only the existing database deployment owner can call
`clued_private.storage_client_capability_admin_v2(jsonb)`. It is SECURITY INVOKER,
denies PUBLIC/anon/authenticated/service_role, and requires the current
`platform_admin_v13` version. Missing platform designation fails closed; this
work does not bootstrap it. Events and Receipts belong to that registered
platform administrator, not an arbitrary request owner.

All four actions require `action`, `idempotency_key`, `platform_admin_version`,
`evidence_id`, and `evidence_sha256`. Additional exact fields:

- `register_snapshot`: `request_id`, `expected_request_digest`,
  `source_snapshot_json`, `expected_lineage_id` (null initially),
  `expected_registration_generation` (0 initially).
- `qualify`: `lineage_id`, `registration_generation`, `expected_metadata_digest`,
  `expected_source_digest`, `expected_capability_version` (0 initially).
- `revoke`: `capability_id`, `base_version`.
- `link_request`: `request_id`, `expected_request_digest`, `lineage_id`,
  `registration_generation`, `capability_id`, `capability_version`,
  `source_snapshot_json`.

Do not conflate three hashes: original v12 request digest, normalized request
metadata digest (`storage_client_request_digest_v2`), and full nonsecret client
metadata digest (`m1_sha256(source.client)`). The raw source file SHA-256 is a
fourth, byte-level Evidence identity. Inspect the committed M1 Receipt after
each operation; replay the exact request/key to resolve an unknown reply.
Never invent a new key to retry an uncertain operation.

Registration and request links are immutable. A source request cannot create
two lineages or be reused as a later generation. A successor preserves exact
issuer/resource/client ID, requires the prior active capability revoked, and
uses a new reviewed request. Qualification has a new capability ID and monotonic
version; it does not clear any account or root deny. Every new request requires
its own reviewed link, even if client ID/name/digests look identical.
An existing issuer/resource/client ID must use its original lineage; a new
request cannot register a parallel lineage to escape its deny history. Ambiguous
pre-existing lineages fail closed instead of selecting one by name or age.

## Evidence and execution lifecycle

Evidence is the **point-in-time audit basis** for platform qualification.
Withdrawal blocks new register/qualify/link references to that evidence.
It does not silently revoke an already committed capability or erase a link.
To withdraw technical qualification, use the explicit `revoke` action; its
capability lock serializes with execution checks. User account denies and
disconnects remain separate, independently enforced controls.

The SDK has no authenticated immutable DCR incarnation or generation. A clean
snapshot cannot prove deletion/recreation continuity or a client's runtime
behavior. This fallback must not be advertised as automatic qualification of
new DCR requests. Fully automatic account inheritance still requires a trusted
platform identity integration, account consent/cutover, and the qualified v2
execution path. This change alone enables none of them and is not production
activation or Storage hardening closeout.
