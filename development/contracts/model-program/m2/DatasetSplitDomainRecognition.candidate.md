# DatasetSplit domain recognition v0.1 candidate

Status: **NON_PRODUCTION CANDIDATE**. This contract and read-only adapter implement
the engineering permission recorded in Decision
`3b5aa945-8177-4a05-944d-f797a90b41b6` v1, Receipt
`c6999e04-51e6-4fe9-b021-1a704d5c89ec`, following the Owner's 2026-10-01 09:24
approval. That permission authorizes a candidate and synthetic tests; it does not
register a real domain producer, grant domain permission, adopt this candidate for
production or issue a DomainAuthorityReceipt.

## Existing authority and exact subject

The only Canonical service remains `clued-cloud/supabase`. The proposed producer
is an authenticated subject **and client Binding** of that service, with a
separately approved, current registration as an existing model-domain authority
delegate. `EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE` is this candidate's required
role predicate, not an installed role or a grant made by this PR. The machine
contract keeps `registered_producer_ref` and `domain_permission_record_ref` null,
and `live_backend=NOT_CONFIGURED`.

The existing M1 `clued_record_mutate` / `record_mutation` transaction owns Record,
Event and immutable Receipt creation. No second Canonical store, Gate engine,
receipt database, signing key, permission issuer, Worker route or migration is
introduced. The adapter reads normalized existing service fields through a
Host-injected `CanonicalReader` interface; it never calls a write operation.
Exact source bytes for the M0 authority registry, M1 tool contract and M1 receipt
implementation are pinned in the machine contract. File digests prove source
identity, not deployed authority or permission.

The recognized subject is only `clued.model-program.DatasetSplit / v0.1`, definition
SHA-256 `f51cefe8eccd0faa75b45e78380e5b389ed266ca4034b511a85f51771f2d4f77`, schema
SHA-256 `062860afd3dc16fa9ee1de27582439701a67b7c5976ad45981a7cca3e515468f`.
The original source pair and adopted artifacts remain unchanged. The existing
Owner adoption Decision `b8c1d482-9eb4-4bc5-8dd1-372b0d55174e` v1 and Receipt
`45a657d9-ba34-437e-b17c-2d792ce5c692` are exact prerequisites, not permission to
perform a domain action. The maximum effect proposed here is
`NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY`, never data clearance or M2 PASS.

## Admission and binding

The closed request schema accepts only the contract digest, exact subject and
recognition Record/Receipt references. Principal, role, grant, environment,
currentness and authorization cannot be supplied as request fields. The Host's
authenticated service dependency must independently resolve domain admission,
producer registration and permission at the actual operation. Generic
`context:write`, a caller-set role/boolean, an Owner baseline adoption, an ordinary
successful write and this engineering approval are all insufficient.

The adapter checks a separate CURRENT, active, user-explicit permission Decision,
binding the principal, producer registration version/hash, exact subject,
project scope, non-production environment, action and effect. Revocation must be
explicitly known; the permission must be inside its validity window. The candidate
limits that window to one hour and service observations to five minutes, rejects
future observations, and rechecks admission after the read chain. These are
candidate validation limits, not changes to any deployed permission policy.

The producer registration and permission retain existing Canonical identities.
Their normalized references contain service content hashes and exact versions.
The recognition State has `authority=observed`,
`state_kind=model_dataset_split_domain_recognition` and a closed
`domain_recognition` payload binding contract, subject, Owner adoption, producer
registration, permission and producer identity. Its Receipt must be the Record's
latest committed `record_mutation` Receipt for that exact ID/version and producer.
The same-transaction successful Event must bind that Receipt, target, actor,
project scope and canonical version. A Receipt alone has no domain effect.

## Runnable candidate and synthetic boundary

```sh
python scripts/model-program/validate_m2_domain_recognition.py
python -m unittest tests.test_model_program_m2_domain_recognition -v
python scripts/model-program/validate_m2_domain_recognition.py --require-domain-authority
```

The first command verifies pinned contracts only. The last command must exit 1
with `DOMAIN_AUTHORITY_NOT_CONFIGURED`. No live reader is implemented: absence of
a backend fails closed, and even an injected live reader is rejected with
`DOMAIN_LIVE_CAPABILITY_NOT_IMPLEMENTED`. This is deliberate candidate isolation,
not proof that the entire service lacks an existing domain issuer.

The test service is an in-memory **synthetic double**, not a Canonical mirror or
permission store. Its fixture hashes are stand-ins, not the M1 server hash
algorithm, signatures or actual currentness proofs. The valid test chain produces
`PASS_DOMAIN_RECOGNITION_ADAPTER_SYNTHETIC_ONLY`, `authority_effect=NONE`,
`domain_authority_receipt=NOT_ISSUED`, no data/training permission and no M2 verdict.
Tests cover wrong object/version/schema, ordinary write substitution, absent
admission, identity/role/scope mismatch, revoked/expired/future/overlong grants,
unknown or stale sources, receipt/event substitution, revocation during reads and
sanitized service failures. Every path invokes zero Canonical writes.

## Remaining real boundary

Actual use first needs an identified existing domain authority and an approved
producer registration/domain permission contract with a service-enforced
authorization check. A live authenticated reader and coherent currentness/read
snapshot must be qualified against that implementation; changing the adapter's
mode string or trusting a Record's labels is not an activation path. Real issuance,
new persistent access or permission installation, and production enablement need
separate authorization. This PR performs none of them.

M2-00 still requires the original M0-A/B/C source locks and applicable formal
domain/Kernel acceptance. The earlier 35/12/159-file checks prove source binding
only. This definition-recognition candidate does not close M2-00, approve real
data, prove privacy/deduplication/holdout secrecy, accept the candidate contract,
reopen M1 or replace the remaining Data Gate and M2 acceptance requirements.
