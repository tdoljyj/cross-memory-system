# M5 minimal hotfix independent review

Verdict: **PASS** for the exact offline core whose `CORE_SHA256SUMS.txt` SHA-256 is `a39c97b08c89ebf8560d31585f2041c97c069714b3ffc1c32ad9570e0f8b83bb`.

The corrected sealed SQL SHA-256 is `f3f58366a06411d9578a29baf226543760027d0bfef3b33261b08161d394eeb1`; the M4 version was `bf180ec5e01e93f9103db5363ecee8a14ae06a4d5d73f2e9068b96a3da4f9dac`. Replacing the corrected grouped extraction `||(sm->>'status_manifest_id')` with the prior ungrouped expression makes the SQL byte-for-byte identical to M4. Therefore the only SQL semantic change is the PostgreSQL operator-precedence correction.

The atomic request remains `eccaa84262cee349a49636a3a4aed8c85a540a8c42d9ae5d43cacab67a782c07`. Preflight, post-readback, and runtime guard bytes are unchanged. SQL verification passes 23/23, including a regression that requires the grouped expression and rejects the old one. Operational verification passes 19/19 and the default launcher makes no database connection.

Transaction boundaries, lock order, replay behavior, and the CAS write set are unchanged. Static inspection confirms no gate-attempt insert, budget reservation, refund, capacity mutation, GA dispatch, sequence 102 creation, historical rewrite, or persistent installer. The prior failed attempt was explicitly rolled back to Root8/sequence97 with zero committed writes and the unique budget untouched.

This review performed no database connection, database write, or CAS. M5 publication plus a fresh live read-only preflight remain required before the owner-authorized second CAS.
