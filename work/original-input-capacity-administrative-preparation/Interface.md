# Offline capacity administration candidate

No file here is a real user approval, administrative acceptance, source publication, runtime admission or permission to allocate. The exact proposed limit is **3,000,000 bytes**, not 3 MiB. A genuine supplementary user approval and independently reviewed Owner publication remain required.

The unchanged base scope is exported by `series-core.successor.candidate.mjs`. Its original proposal hash remains ea96914e218460339508bc51eff0d10de41e1a94cfa3a0a544a85a132219791b. Current budget authority comes from that scope and the existing full-history checks, not the older nested `evidence_limit_successor.aggregate_evidence_bytes_max` historical field.

The new consumer's authenticated runtime `accepted_subject` must gain exactly two capacity fields. Its loader rejects absence; the old no-capacity compatibility branch exists only in the pure core:

- `capacity_delta`: deep-equal to exported `capacityDelta` (all original bounds explicitly retained).
- `capacity_materials`: exactly `{approval, applicability}`. Each is exactly `{ref:{uri,sha256}, publication:{commitSha,artifactPath}}`, using immutable private repository blobs and real Owner merge provenance.

The candidate loader reads descriptors only from this already authenticated runtime. It reads exact blob bytes, checks SHA256, and calls the existing real `verifyOwnerMergeArtifact` for each. It does not accept an authentication boolean. Dependency injection in the standalone fragment is an integration seam for the existing trusted context, never a GA/child input API. A forged runtime state string alone cannot authenticate this loader: retain the original caller's complete runtime verification before calling it.

The capacity approval JSON must contain `state=APPROVED_EXACT_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT`, `base_proposal_sha256`, `base_approval_ref`, `bounded_series_constraints`, `capacity_delta`, `baseline` (exact exported capacityBaseline), `capacity_proposal_ref`, and genuine `approved_at`. The future supplementary proposal reference is supplied through the genuine approval; it is never hardcoded into the source manifest. Baseline means one allocation already spent and at most two remaining from the original three, not a newly granted pair of allocations. Later calls continue counting every original event and charge.

The independent capacity applicability JSON must contain `state=ACCEPTED_EXACT_ROOT3_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT`, original reviewer identity, `approval_ref`, `base_approval_ref`, `base_proposal_sha256`, `capacity_proposal_ref`, exact `bounded_series_constraints`, `capacity_delta`, `baseline`, `scope_unchanged_except_original_input_limit=true`, `new_action_authorized=false`, genuine `accepted_at`, exact current `controller_digest` and `scope_digest`, `previous_evidence_sink_ref`, `evidence_sink_ref`, and nonempty exact `changed_source_refs`. The previous Evidence sink SHA is fixed to the real accepted v3 source 33feb26ab01ec1cb45834c4b97d5d94f620507452f67146ce1ab7748a8500d96. The new Evidence ref must be an actual current expected-GA artifact. `scope_unchanged` is forbidden: this is a declared capacity exception, not the old same-scope assertion.

The repair for 043 must use `state=ACCEPTED_EXACT_QUALIFICATION_REPAIR_WITH_APPROVED_CAPACITY_DELTA`, original reviewer identity, exact failed GA/receipt, `identified_error_ref`, exact same `changed_source_refs` as the capacity applicability, `scope_unchanged_except_original_input_limit=true`, `new_action_authorized=false`, `capacity_approval_ref`, `capacity_applicability_ref`, and exact current controller/scope digests. It cannot use the legacy same-scope branch while capacity materials exist. Other repair cases retain the original predicates. Real administrative review must verify the declared complete source/Scope delta and exact Evidence semantics before publishing these statements; this pure consistency checker cannot establish those facts by itself.

## Existing context integration

1. Import `loadAuthenticatedCapacityMaterials` into the new context successor with its existing trusted `readBlobRef` and `verifyOwnerMergeArtifact`. The new series module imports only its capacity core; it does not import network or runtime helpers.
2. In `loadAuthenticatedBoundedSeries(runtime)`, after existing runtime authentication, call the loader once with those fixed dependencies and retain the result as `capacity_materials` in the trusted closure. This new loader unconditionally requires the supplement and cannot return null; do not conditionally skip it for missing subject fields.
3. Keep `bounded_series_materials`' original exact keys `{approval,applicability,repairs}`. It is separate from the two new subject fields. Keep all original base approval/applicability and repair Owner/hash checks.
4. Replace only `appendix=parseExact(applicability.raw)` with `appendix=parseAuthenticatedAdministrativeJSON(applicability.raw)` after `actual(d.applicability)` has checked original SHA and Owner bytes. The helper removes only JSON whitespace outside strings and compares with JSON.stringify(parsed), rejecting duplicate keys and unsafe numeric/escape normalization. The original pretty administrative document remains byte-identical. GA, GRR and all other signed object parsing remain unchanged.
5. Pass closure `capacity_materials` into the successor `checkBoundedSeries` call, along with every original argument. Do not pass child/caller capacity fields.
6. Runtime construction, loadMaterial reconstruction, source-manifest hashing and accepted-subject equality must include both new fields. Missing or partial capacity bindings fail closed. Integrate all immutable approval/applicability/repair refs into the existing authenticated source/ref loading policy and preserve the 128-ref ceiling.

## Prewarm boundary

Prewarm may load and verify exact immutable runtime/admin/source blobs into the same ESM verification cache before READY. It cannot cache SQL observations, bypass a later signature/hash/Owner check, assert currentness, or expand 15 seconds. Actual input must still match the verified runtime bytes. A different prewarm document gives a miss or rejection, not acceptance. New prewarm file paths must be fixed to the exact GA/operation run directory, no symlink/reparse traversal, no caller-chosen code/module paths. No prewarm execution/network behavior was tested here; the final pipe integration requires independent review.

## Limits of the numerical model

The five-field original limit does not imply a 4 MiB frame bound. JSON escaping, duplicate histories in the second frame, growing runtime/Q/admin strings, and publisher wrappers must each be calculated from final exact accepted static bytes before spending a budget. Changing only N cannot ensure either remaining attempt fits. Original Root strict JSON 2 MiB, historical decoders, 128 KiB control/index, 32 MiB batch and all fee limits remain unchanged.
