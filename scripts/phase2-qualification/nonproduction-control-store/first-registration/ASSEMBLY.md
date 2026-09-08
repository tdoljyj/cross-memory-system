# First-root assembly helpers

Both commands only read local, independently pinned evidence and write a new output directory. They do not call GitHub/Supabase, publish, register a root or issue a GA. Existing first-registration inputs and their historical acceptance remain unchanged. The purpose successor and actual acceptance v2 are the current inputs.

Run from the repository root:

```powershell
node scripts/phase2-qualification/nonproduction-control-store/first-registration/prepare-signing.mjs artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/FirstControlRootRegistrationIndependentAcceptance.v2.json b3d4422ba8d4150bd2988fc713217b3f310b7bf1c34c058e17a221f435afc49b <new-output-directory>
```

The actual invocation already produced `signing-v2/RootSigningPayload.json` and `SigningPreparation.json`. Publish these exact payload bytes in the new Owner PR. The canonical signature payload includes the actual independent acceptance reference and excludes only `signature_binding`; its file-byte SHA-256 is separately recorded. The accepted issuer purpose metadata is already referenced by all three issuer bindings. No placeholder signatures are present.

After root/assessor verifies the new actual merge signature, tree, payload blob and acceptance bytes, persist its real `ROOT_SIGNING_PAYLOAD_SIGNATURE_BINDING` observation in the approved private Evidence branch at the fixed `root-registration-20260908/result.json` prefix and read back its exact commit/blob. Place those same report bytes in a repository-local artifact path for assembly, without treating that local copy as publication proof.

```powershell
node scripts/phase2-qualification/nonproduction-control-store/first-registration/assemble-signed-root.mjs scripts/phase2-qualification/nonproduction-control-store/first-registration/signing-v2/RootSigningPayload.json artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/FirstControlRootRegistrationIndependentAcceptance.v2.json b3d4422ba8d4150bd2988fc713217b3f310b7bf1c34c058e17a221f435afc49b <actual-report-repo-path> <independently-verified-report-sha256> <new-output-directory>
```

The report contract is root's fixed structure: `kind`, `status`, exact private `repository`, merged Owner `pr`, verified web-flow `merge` with two parents/tree, `payload` with artifact path/blob/file SHA/canonical SHA/review-subject SHA, and exact `acceptance` path/SHA. The helper rejects PR25 as a new Root signature. It checks bindings against the supplied independently verified report; it does not itself verify GitHub signatures or prove remote persistence.

Existing schema mapping: `signature_binding.owner_merge_commit = report.merge.sha`; `signed_object_sha256 = report.payload.payload_sha256`; `signature_evidence_ref = report's exact Git blob API URI and SHA-256`. The report can live on the approved private observation branch; it is not a second Root Canon. The completed Root exists in the private deployed Store only after registration. Two SQL configuration fields become the actual v2 acceptance SHA and actual report SHA; the deployed original limited-scope `subject_sha256=e4ab…` remains unchanged.

Before database effects, independently confirm the report is durably readable, Owner/window still current, and actual Store prefix still empty. Execute the already reviewed accepted-binding insertion and first append in one transaction, then read back. These helpers cannot perform those effects or assert them completed. Complete Root shape validation remains separate from signature-source verification and formal controller/Profile/GA qualification.

The focused tests use the real accepted v2 and historical PR25 observation. Negative mutations remain in memory and are never written as accepted reports. No positive signature case is claimed before the actual new report exists.
