# Mechanical resource exemptions v0.1 candidate

The single scoped policy is `config/clued-mechanical-files.json`; its generated
SQL block is in migration `20261108144312_work_claim_mechanical_files_v1.sql`.
`node scripts/ci/component-version-integration-policy.mjs` checks exact equality;
`--write` regenerates that marked literal without deployment or other SQL edits.

Conflict checks filter a mechanical-only path from both proposed and existing
claims only in the same qualified project. Typed `repo:` resources must name the
policy repository. A broader source glob, other resource kind, other context,
same-Task conflict and shared trigger remain governed by the existing rules.

`clued_work_verify` adds optional `mechanical_paths_proven: string[]`. Only an
explicit, live `ci-admission` Binding may supply it. Native validates the policy
scope, exact repository/PR, 40-hex head/base, literal paths, policy membership and
subset of `changed_paths` before any first PR binding, head metering or execution
admission. A non-CI proof returns `ci_binding_required`; an invalid proof returns
`mechanical_paths_proof_invalid`. Missing proof is an empty set, never SQL NULL
permission. A proved path may skip coverage, not other authorization checks.

The accepted CI gate obtains the policy from its own qualified source closure.
For every proof candidate it resolves exact base/head Git trees, requires normal
blob entries of equal mode and refuses missing, truncated, symlink, submodule or
mode-changing entries. Runtime/configuration comparisons read immutable blobs
with strict base64 and UTF-8 validation. Runtime bodies and component definitions
require original write-set ownership; version/hash-only differences can be proved.
Ordinary Agents cannot assert this CI proof through the public tool schema.

Existing currentness, role, holder key, head authorization, epoch, queue, claim
binding, release/revocation, publication and all merge-policy conditions remain.
