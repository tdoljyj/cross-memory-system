# Clued Cloud continuity rules

These rules apply to every task under `apps/clued-cloud/`.

1. Use `clued-developer` for Clued engineering and `clued-user` for authorized personal context operations. Their maintained sources are `skills/clued-developer/SKILL.md` and `skills/clued-user/SKILL.md` at the repository root. The former continuity router was intentionally removed; do not restore it.
2. The authenticated Clued service backed by Supabase is the only online Canonical Store. Repository `memory/` is a read-only export of the formal M2 pointer, never a business-write target.
3. Before using the export as current truth, validate `memory/manifest.json`: `baseline_claim=current`, `source_verification=live_rechecked`, `views_complete=true`, `status=ready`, and all file hashes valid.
4. For current work read Global State/Task/Decision, then the exact confirmed Project State/Task/Decision. Read Log/Archive only for history or evidence, and always report `sources_read`.
5. Preserve canonical IDs across API, MCP, UI, Objects and Markdown references. Markdown and `index.json` are derived views; do not copy Canonical bodies into another authority surface.
6. Write once through M1 contracts: Record mutation, Decision supersede, Project mutation, Evidence ingest or extension Event append. The service transaction emits Event and immutable Receipt. Never dual-write Markdown.
7. A mention may create only an unconfirmed Project candidate. Never invent a Project ID or confirm a Project without explicit intent or material-work evidence.
8. Identify the exact execution target. Keep ChatGPT Sites separate from production Worker `clued-cloud` at `https://clued.pixelgrav.com`.
9. Preserve decisions with reasons, actions with evidence, failures, retractions, blockers and one next action in Canonical context—not in a local log file.
10. Use scoped maturity language. A kernel or migration milestone does not imply that the whole cloud product is mature.

Deployment, DNS, Binding, Secret, Schema, purge, merge, tag and release actions require their own authorization unless already included in the user-approved gate.
