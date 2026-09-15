# Root10 runner material assembler

This is a read-only assembler. It verifies the actual private original-source/P1/P2 Owner merges, complete trees, exact published runtime/qualification/Status29 payload bytes, all referenced original Gate/Profile/prerequisite blobs in the same original-source Owner merge, and original-source → P1 → P2 ancestry. It does not sign or issue a GA, write the database, start a container, or assert PASS.

Pre-GA verification emits a material template with `ga_raw`, Status full raw, and Status store ref left `null`:

```powershell
node work/new-window/runner-material/build-root10-runner-material.mjs CONFIG.json --emit-json
```

After the one real GA is signed, inject it and optionally the fully signed Status29 bytes:

```powershell
node work/new-window/runner-material/build-root10-runner-material.mjs CONFIG.json --emit-json --ga FINAL_GA.json --status-full Status29.full.json
```

The output is the compact runner material JSON on stdout, suitable for saving with a controlled `apply_patch`. A live observation is intentionally absent; the trusted caller must add a fresh control-store observation at dispatch time.
