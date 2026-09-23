# work/ boundary

`work/` contains historical execution staging and recovery material that was committed during earlier engineering phases.

It is **not** a current task queue, Canonical Store, governance frontier or durable source of runtime truth.

For new work:

- Prefer ephemeral local/CI scratch space for transient execution files.
- Put reusable implementation in `apps/`, `kernel/`, `protocol/`, `development/` or `scripts/` as appropriate.
- Put durable machine-verifiable results in `artifacts/` under the artifact-retention boundary.
- Put long-form product/research/meeting/closeout material in the document center, not `work/`.
- Do not create a new root `work/<name>` tree merely to preserve an Agent session.
- If an existing `work/` path is referenced by a frozen contract, test or audit chain, preserve it until a successor migration explicitly removes that dependency.

Existing content is historical evidence and is not automatically safe to delete.
