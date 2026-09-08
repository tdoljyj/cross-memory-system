# Formal Clued project-list repair — 2026-09-08

Implementation: ebacfd667d1cab72a9e97e2f425b4a910c317b12, PR19, merged as 0972627dbe7823f2d01d79fef9aaf339e4306d4b. All seven CI checks passed. Local verification: 25 transport tests, nine real PostgreSQL authorization tests, two full migration-chain tests, typecheck and independent review passed without skips.

Production applied only the new clued_project_list_authorized_scope function migration. Its readback confirms per-project filtering is installed, anon RPC execution remains allowed, and authenticated-role direct execution remains denied. No binding grants or business records were changed by the migration.

The user explicitly authorized uploading and switching the repair package to their production Worker clued-cloud at clued.pixelgrav.com. Version c09168db-1b18-4280-9ba5-c0879fbc1649 is deployed at 100%, deployment dace92ba-af18-4eee-99f6-feebae4d5f9d. Its eleven bindings and script_runtime match baseline 6b1778a1-30dc-42d1-a531-b8bcc395870c. Metadata comparison kept values in memory and emitted only names/types and equality results; no secret values were read.

The exact formal Clued connector returned status=ok with three authorized Clued projects. A request using level=project and the deliberately nonexistent project UUID 11111111-1111-4111-8111-111111111111 returned HTTP403, FORBIDDEN, binding_not_authorized, JSON-RPC -32000. It no longer requested reauthentication. Authorized State/Task/Decision reads and a scoped engineering-state write plus independent record readback also succeeded.

Actual JWT authentication errors remain 401 under the transport regression tests. Direct unauthenticated page probes received Cloudflare1010 on both the previous production version and version preview; page smoke is not claimed as passed. Browser preview was blocked by the client. These limitations were preserved, and no edge/security settings were changed.

This is an interface repair and production deployment verification, not a Phase2 Entry, Skill qualification, Slice A or whole-product acceptance. Frozen phase evidence and published memory snapshots were not modified.

The build manifest binds a complete fresh build from the reviewed Git source, using Node24.19.0, Wrangler4.125.0, vinext1.0.0-beta.8 and OAuth provider0.10.3. All96 package file hashes matched, no .env was copied, and the package contains no junctions. The compiled frontend uses only the formal Supabase host. Assets were rebuilt from the same source lineage; byte identity with every prior hosted asset is not asserted.
