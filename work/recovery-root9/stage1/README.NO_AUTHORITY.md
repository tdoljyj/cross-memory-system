# Root9 Stage 1 — NO AUTHORITY / NOT ACCEPTED

This payload contains only:

- three Root9 issuer-purpose metadata candidates;
- the exact 22-file Root9 controller bundle and manifest;
- offline manifest rebuild and payload validation scripts.

The controller is published only under the immutable sibling directory `scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/`; it does not overwrite the active Root8 controller path. The manifest digest is verified by the bundled script and recorded in the outer Stage 1 report.

The issuer metadata does not bind the controller digest, so it can be hashed before the controller embeds those hashes. This makes Stage 1 acyclic.

Nothing here is signed, accepted, bound, installed, or authorized. The payload contains no RuntimeAcceptance, Status26, CAS operation, database migration, or live SQL file. The controller source retains its fixed read-only observation query as part of the exact controller; this package supplies no executable live-database invocation.

Offline verification after applying these paths to a repository checkout:

```bash
node work/recovery-root9/stage1/rebuild-controller-manifest.mjs
node work/recovery-root9/stage1/verify-stage1-payload.mjs
```

Both commands are local-only and grant no authority.
