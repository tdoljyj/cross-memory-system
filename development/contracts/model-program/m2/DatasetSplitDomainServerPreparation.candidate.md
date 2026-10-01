# DatasetSplit v0.1 non-production server preparation candidate

Owner is the final recognizer for this definition. Decision
`46b0ff1c-f608-4ff9-89b9-dc90a61ce70f` v1 / Receipt
`4c9b9066-5146-4bd5-9e5d-8660624fdecb` records the 2026-10-01 13:04
confirmation and permission to prepare this candidate. The earlier adopted
definition/schema and engineering permission keep their existing identities.
This designation does not install a producer, grant domain permission or issue
recognition.

## Current connection qualification

Authenticated Clued context reads and writes succeeded. The current MCP response
sanitizer in `apps/clued-cloud/worker/continuity.ts` removes user and Binding actor
fields; `clued_audit_receipts` also does not expose the authenticated Owner
principal or a domain admission. Specific Owner subject/Binding and current
domain qualification are therefore **UNKNOWN**, not inferred from an account
name, historical UUID, audit success, public key or this Decision. Real identity
references in the machine candidate remain null.

## Executable preparation

`validate_m2_domain_service.py` is an unregistered read-only server facade over
the existing adapter and normalized M1 Record/Event/Receipt reads. It supports
only a Host-injected synthetic backend. There is no HTTP listener, MCP tool,
database function/migration, transport, token parsing, credential creation or
permission installation. Absent and live backends fail before authentication.

The Host backend independently returns an authenticated principal, verified
Owner subject, scoped non-production read admission, session expiry/revocation
and current observation. JSON callers cannot select these fields. Each read
rechecks authentication; the final clock sample also rejects session expiry or
clock regression. The facade requires the exact current Owner designation
Decision/Receipt at both authorization observations. The original adapter still
requires a separate current domain grant, producer registration, exact adopted
definition/schema and same-transaction actor/version/Receipt/Event binding.
Owner designation and generic `context:write` cannot replace those guards.

All fixtures, principals and currentness observations are synthetic. Successful
results say `PASS_DOMAIN_SERVER_PREPARATION_SYNTHETIC_ONLY`, authority `NONE`,
DomainAuthorityReceipt/M2 verdict `NOT_ISSUED`; no Canonical mutation is called.
Existing M1 transaction semantics remain the proposed future issuance path;
this facade adds no authority or Gate engine.

## Smallest remaining live gate

Provide an authorized service-side qualification that identifies the current
Owner subject and client Binding, plus an exact reviewed scoped producer/domain
permission and currentness read interface. Review and authorize that concrete
installation separately before adding a live transport, registering a route or
issuing anything. This is a technical qualification gate, not a request to repeat
the already confirmed design decision. Production migrations, permissions,
credentials, real data/training, actual issuance, merge and deployment remain
outside this preparation.

Supabase verification reference: [JWT identity and expiry](https://supabase.com/docs/guides/auth/jwts)
and [API authorization](https://supabase.com/docs/guides/api/securing-your-api).
No new Supabase API/library or database schema is installed by this candidate.
