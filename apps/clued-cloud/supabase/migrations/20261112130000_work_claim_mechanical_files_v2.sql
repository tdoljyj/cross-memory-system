-- Forward-only refresh of the Work Claim mechanical-file policy literal
-- (v1: 20261108144312_work_claim_mechanical_files_v1.sql). Production apply
-- needs the Owner's approval like every Native migration.
--
-- Defect: generated outputs the integrator writes on every candidate
-- (control Source descriptor/registry, R9 registry, plugin copies, Source v2
-- closure) were missing from config/clued-mechanical-files.json, so every two
-- PR claims overlapped on them and could only be pushed one after another.
--
-- The block below is generated from config/clued-mechanical-files.json, the
-- only list. checkMechanicalPolicy (node scripts/ci/check-pinned-registries.mjs,
-- component-version-integration-policy.mjs) fails while the newest
-- *_work_claim_mechanical_files_v*.sql differs from it; regenerate with
-- node scripts/ci/component-version-integration-policy.mjs --write.
-- Only the policy literal changes; matching, conflict filtering, proof and
-- coverage functions of v1 read it through this function unchanged.

create or replace function clued_private.work_claim_mechanical_policy_v1() returns jsonb
language sql immutable set search_path='' as $policy_function$
-- BEGIN GENERATED MECHANICAL POLICY
  select $mechanical_policy${
  "schema": 1,
  "repository": "tdoljyj/cross-memory-system",
  "context_keys": [
    "project:0597aa60-9b98-4da6-a4ab-63d7705b632f"
  ],
  "mechanical_paths": [
    "config/clued-components.json",
    "apps/clued-cloud/worker/generated/**",
    "scripts/ci/clued-merge-reconcile.mjs",
    "scripts/ci/clued-merge-reconcile-source.json",
    "scripts/ci/clued-independent-publication-port.mjs",
    "scripts/ci/clued-control-workflow-source.mjs",
    "scripts/ci/clued-control-workflow-sources.json",
    "scripts/ci/merge-admission-r9-source.json",
    "integrations/claude-code/clued/skills/clued/**",
    "integrations/claude-code/clued/hooks/run_python.sh",
    "integrations/claude-code/clued/hooks/clued_capture_guard.py",
    "work/actions-hosted-migration/independent-ci-v1/src/resident-v2/source-closure.json"
  ]
}$mechanical_policy$::jsonb
-- END GENERATED MECHANICAL POLICY
$policy_function$;

revoke all on function clued_private.work_claim_mechanical_policy_v1()
  from public,anon,authenticated,service_role,clued_worker_gateway;
