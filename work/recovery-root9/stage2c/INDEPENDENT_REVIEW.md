# Stage2C final independent adversarial review

Verdict: **PASS** for the exact offline prepublication core whose `CORE_SHA256SUMS.txt` SHA-256 is `96c945ccc91c4587e9fbb85001435f06bb24028d4310cebe2225f2733a68a5c6`.

This is not live-apply authority. M4 remains deliberately late-bound, and a fresh read-only live preflight is still mandatory before the one permitted apply attempt.

## Exact reviewed anchors

- sealed apply SQL: `bf180ec5e01e93f9103db5363ecee8a14ae06a4d5d73f2e9068b96a3da4f9dac`
- atomic request: `eccaa84262cee349a49636a3a4aed8c85a540a8c42d9ae5d43cacab67a782c07`
- M3 evidence: `7bf41dbb104586cddd67933a90cc1676f09c156e8b1689ba314af541e48fffc3`
- Root9 raw / canonical: `956975e5131aaf858dc06bc7923e0186416740d82db64363af6103e7f69f94e1` / `7483e3d240b270d7ad49d9262c63bd49ae0290db08c1dec66aa0de2f239eab60`
- Status26 full / signed object S: `8e02293caa447a5c2fe1749d89c082fe2e1e937180c937d746512d9b7e32b6a3` / `d0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8`
- successor binding: `d3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e`
- RuntimeAcceptance: `107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9`

Root9 and Status26 were independently validated against the exact SHA-pinned JSON schemas. M3 is bound to PR 173, the exact two-parent Owner/web-flow merge, `main`, one PR, valid verification, and all 13 exact artifacts. The controller count is exactly 22, and RuntimeAcceptance contains the same exact eight repair refs required by the qualified evidence.

## SQL and replay findings

The apply is one PostgreSQL transaction. It locks `current_head`, then `execution_current`, then `successor_binding` in `ACCESS EXCLUSIVE` mode before reading the constraint preimage, closing the prior constraint/count TOCTOU. DDL, Root event 9, execution events 98–101, Status26, the new successor row, sequence CAS updates, and the postimage assertion are all inside the same transaction; every raised error rolls everything back.

The exact response-loss replay branch is reached after the locks but before any DDL or data mutation. It returns only for the exact Root9/seq101 postimage and rejects partial or conflicting replay. The actual mutation order is Root9 registration, successor registration at 98, prepared at 99, Status26, qualified at 100, and RuntimeAcceptance repoint at 101. No seq102 row is created.

The SQL fail-closes on the exact old constraint and these function-definition hashes before replacement:

- `read_root(text)`: `e1f496ad7e43ba08eca97c4e2cfa13a162660ae90d6628aac16af9c2c26cc47c`
- `reserve_execution_budget(text,text)`: `7af51ecc2b98a41c72542a75ef2f87d00753cabfc98afa2bc33b58c7fd0dd8c7`
- `reserve_gate(text,text)`: `61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5`
- `append_status_manifest(text,text)`: `1a75b3b9ecfec1d2fe5c700124544d323506fa16e35a99be7c1dc5c3c1ec6280`
- `transition_successor_binding(jsonb)`: `2d398f53984e319bb1006e8e00b70c7520c427da25bddb8b43b918b9c12404cf`
- `effective_execution_binding()`: `9d8278d9845cffab99624d0ab70d592e2398d8d6a906d608ce5bdd0b14d2e7a1`
- `effective_execution_window()`: `c1531b643ae7ac19079def01664133b236e35b1ba47c10b5a14c321f7131c09f`

All three replaced `SECURITY DEFINER` functions set an empty search path, revoke execute from `public`, `anon`, and `authenticated`, and grant execute only to `service_role`. No persistent installer is created. The pre/post preservation snapshots exclude only these intentionally replaced target functions and their ACLs; post-readback separately asserts their exact narrowed ACLs. All non-target function, constraint, routine-ACL, and table-ACL snapshots remain symmetric.

## Safety boundary

`BUDGET_RESERVED` is correctly present in the persistent reserve-function source because that function must retain its ordinary future behavior. It is absent from the actual Root9 CAS invocation and event constructors. The actual CAS performs no budget reservation, no gate-attempt insertion, no GA dispatch, no refund, no capacity change, and no mutation of accepted/execution binding or historical event rows. Counters remain attempts/budget/forward `14/9/17`, charges remain `10506 / 2335812531`, and pending budget plus active GA remain null.

Offline results: sealed SQL `22/22`, operational suite `18/18`, independent adversarial suite `20/20`, integration verifier PASS, manifest `26/26`, and launcher default `PASS_DRY_RUN_NO_DATABASE_CONTACT`.

Required external gates are unchanged: verify the exact post-merge M4 evidence, run the fresh read-only preflight before `2026-09-15T03:00:00Z`, issue the single apply attempt, and perform exactly one readback. An unknown apply result must never be retried automatically.
