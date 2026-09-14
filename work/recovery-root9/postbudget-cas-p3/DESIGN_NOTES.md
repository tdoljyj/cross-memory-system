# Post-budget Root9 one-time CAS design

Status: `P3 OFFLINE PASS / NOT SEALED / NOT APPLIED`

| Item | Before | Exact postimage |
|---|---:|---:|
| Root generation/sequence | Root9 / 9 | unchanged |
| Execution sequence | 102 | 104 |
| Pending budget | 102 | 102 |
| Charged seconds / bytes | 11106 / 2470030259 | unchanged |
| Attempts / allocations / forwards | 14 / 10 / 17 | unchanged |
| Status | through 26 | append exactly Status27 |
| Execution events | through 102 | append exactly 103 and 104 |
| reserve_gate | SHA `61e700…` | one exact sealed replacement |

Seq103 records the closed 12-key correction evidence and its PostgreSQL `jsonb::text` SHA. Seq104
repoints RuntimeAcceptance and carries the exact event-102 inheritance. Status/GA references use the
same exact two-key object. No history row is updated or deleted; only
`execution_current.sequence` changes.

The authorized Gate replacement is the first mutation in the same transaction. Its exact live source
is included as base64 bytes. The builder proves the full definition is only the controlled declaration
and allocation-comparison splice. The wrapper pins preimage source SHA, a late-bound exact full
`pg_proc`-minus-`prosrc` canonical digest, SECURITY DEFINER, volatility, kind, configuration and
ACL (PUBLIC/anon/authenticated denied; service_role allowed), then verifies the exact postimage and
unchanged catalog. The Gate is not invoked during installation.

P3 publication evidence and independent review are postmerge external evidence blobs. The CAS pins
their exact URI and raw SHA after external readback. They are not merged back to main and do not
create a P4. The review template included here is explicitly non-authoritative.

Every unclear response is classified by read-only exact postimage. No automatic retry, refund,
capacity change, new allocation, second allocation or history repair is permitted.
