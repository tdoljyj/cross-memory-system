# A07 existing projection reconstruction evidence

The existing `apps/clued-cloud/scripts/two-level-snapshot.mjs` builder and validator already support the bounded reconstruction behavior; no production implementation change or replacement mechanism is needed for this local check.

One actual filesystem test created a dedicated temporary directory and a separately stored, explicitly synthetic `bundle_only` source. It built and validated the original offline snapshot, removed exactly `memory/global/task.md` from that temporary snapshot, and observed actual inventory validation failure. All surviving object/view/manifest files and the independent source remained byte-identical. The existing builder also rejected writing into the already existing damaged snapshot directory.

The test then read the fixed independent source again and called the real builder into a new directory, with the original build epoch and run identity. Validation succeeded; all 11 generated files, including the deleted view and Manifest, matched their original SHA-256 values. The two synthetic record identities, versions and active state were retained. The original directory still lacked its view afterward: no backup/UI cache was copied into it. Only hashes of original outputs were retained for comparison; the reconstruction used the separate source file. Actual six-event UTC observations are in `Observation.json`.

The unchanged original test suite already covers repeated deterministic builds, corruption, publication/CAS and failure injection. This single added check covers the missing actual deletion-to-rebuild chain without rerunning those old tests. It passed 1/1 with no skips. The dedicated temporary directory was validated to be an immediate OS temp child with the assigned prefix, then cleaned.

This establishes the current builder's offline deterministic reconstruction capability. It does not prove a live authorized Canonical export, runtime delegation, a real rebuild Receipt, formal pointer activation, third-AI continuation, Entry or Slice A acceptance. The synthetic source has no Receipt references, and the test never calls a publisher, rollback, model, production service, repository memory reader or private Gold. No online or repository Canonical data was changed.

Run the independent bounded check without rewriting the original observation:

```powershell
node --test scripts/phase2-qualification/projection-rebuild-preparation/rebuild.test.mjs
```

The original observed run used `CLUED_REBUILD_WRITE_OBSERVATION=1` once; observation writing uses exclusive create and will not overwrite a previous run. Further observations require a separate explicit artifact rather than replacing historical evidence.
