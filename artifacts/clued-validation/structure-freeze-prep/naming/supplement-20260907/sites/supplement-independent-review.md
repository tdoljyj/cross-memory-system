# Supplement independent verification — 2026-09-07

Result: **41 tests PASS** in the final observed run (1.188 seconds, exit 0). Independent testing found two classes of defects; the parent agent corrected both. No consolidator or source evidence was edited by this reviewer. The earlier 25-case Sites-only result is superseded by this Sites + restore supplement run.

Test file: `work/phase2-governance-check/tests/test_naming_inventory_supplements.py`.
Run evidence: `work/step3-gap-library-sites/supplement-test-run.txt`.
Invocation: bundled Python, `-m unittest discover -s tests -p test_naming_inventory_supplements.py -v`.

## Verified behavior

- The real retained supplement resolves exactly `NSI-GAP-SITES` and `NSI-GAP-RESTORE`. Sites is `REMOVED` only for project `appgprj_6a8a7bff59548191b5250e5c28b8c80c` and hostname `clued-cloud.tdoljyj.chatgpt.site`. Its two resulting Sites records are historical and non-writable.
- Restore is `SCANNED` only for project `gfnfxbphsdtayoaxitly`: 1,156 naming records, eight pages, active observations during collection, successful restore/re-pause responses, and final project status `INACTIVE`.
- Seven historical Library references are retained with `live_rechecked=false`; they do not resolve `NSI-GAP-LIBRARY` or `NSI-GAP-AUTH`.
- Wrong scope, wrong project or hostname, wrong preserved hosting project, wrong 404/error code, global absence claims, and claims of a new deletion are rejected even when the applicable two digest layers are refreshed.
- Byte tampering, inner digest/length mismatch, missing evidence or retirement contract, duplicate index entries, and an unexpected source file are rejected.
- Relative and absolute evidence paths escaping the retained Sites directory are rejected despite matching external-file digests. An outer index entry escaping the supplement directory also cannot authorize an external file.
- Missing supplement grants no resolution.
- Restore tests reject wrong catalog/page/final project identities, a still-active final project, a missing active observation, a failed pause, missing or duplicate pages, incorrect page windows, altered catalog identities, and mismatching final MD5 evidence. Raw final-response bytes are bound by the outer index.
- A tool failure cannot confirm the final database digest. A correct digest placed in unrelated outer metadata cannot substitute for the actual query result.

## Two defect classes found and corrected

Initially, either authorization flag set to the JSON string `"false"` was accepted because the implementation checked truthiness. Both regression cases failed in the initial 23-case run. The parent changed positive confirmation checks to `is True` and negative scope-boundary checks to `is False`. Both tests passed on rerun; two additional digest-layer checks brought the final run to 25 passing tests.

After restore integration, the raw final database response was initially checked by searching the entire file for a digest string. The 40-case run demonstrated that `tool_response.isError=true` still allowed RESTORE resolution after a valid outer rehash. A second targeted regression changed the actual query-result MD5 while retaining the correct MD5 in unrelated outer metadata. The parent replaced whole-file substring matching with successful-tool decoding, extraction of the actual tagged JSON result, and validation of a unique row's total count, distinct count, and MD5 against the enumerated set. The final 41-case run passes both regressions.

## Scope of this verification

This tests retained observations, paths, file-set integrity, digests, semantic subject binding, and narrowly scoped inventory disposition. It does not issue Structure Freeze, acceptance, migration authority, or a Library completeness finding. The exact-object 404 evidence corroborates the preserved deletion record; it is not generalized to all Sites or all accounts.

The parent separately verified the deletion excerpt byte-for-byte against its recorded Git blob. This helper does not itself authenticate an external signature or re-query Git history. Delegation-content hash and source-commit ancestry binding were added by the parent to the calling `consolidate` path; the direct-helper tests here do not execute that caller integration. Those checks need the parent's real scan/CI verification. This result should not be described as an authorization-signature verifier.

## Observed input digests

- `NamingSurfaceInventoryScope.json`: `e8209cd50d6e066bf0b64b93c7c634816cf381a289c3dcd7cc8dda9cbac43af0` (read from actual bytes at test setup).
- `supplement-20260907/SourceIndex.json`: `3bbbb4a968282d35ebf8ee0b7e310cc3aefc57d3a384243ddfe044e0d5eeab24`.
- `scripts/clued-naming-inventory-consolidate.py`: `f6beb8c238dfc62422a917079fbfa38cdd6ab36e0f5babb19864f76f85e6870b`.
- `tests/test_naming_inventory_supplements.py`: `7269d1d6a244996347f6131c9ef6f38808eaca4a49b605f38279114adf9e0519`.

These are a test-time observation of a concurrently edited working tree, not a claim that the files are committed or that later edits are covered.
