# Resource Center stdio pilot (read-only)

This endpoint pilot validates a separate, closed-world MCP tool surface on the
Codex Windows Host. It exposes only `clued_resource_center_mutate` and
`clued_resource_center_scan_boundary`. Every mutation returns
`TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE` before any filesystem effect.
The boundary scan is deterministic and read-only.

Build a self-contained bundle from `apps/clued-cloud`:

```text
node scripts/build-resource-center-stdio-pilot.mjs <absolute-output-path>
```

The endpoint operator places a reviewed, no-secret JSON profile outside the
repository and pins its exact SHA-256 in the MCP launch command. The profile is
a Host bootstrap input, never a tool argument. It contains the exact
`managed_root`, `allowed_root_children`, `boundary_scan_roots`, `profile_id`,
`profile_version`, and `registration_status: "registered"`. This local Host
registration is not a claim that a live Artifact/Currentness authority provider
has been installed.

Register the separate local connection without changing Remote Desktop
Commander:

```text
codex mcp add clued_resource_center_pilot -- node <absolute-bundle-path> <absolute-profile-path> <profile-sha256>
```

Verify the registered command and tool manifest, then test in a new Codex
session. A mutation request must return the resolver-unavailable denial and
leave the target unchanged. The scan may inspect only the profile's pinned
roots. Rollback is `codex mcp remove clued_resource_center_pilot`; the existing
Remote Desktop Commander connection is not modified.

This pilot does **not** close Gate B. It has no live trusted resolver, no
provider-native atomic no-replace move, and no proof that Remote Desktop
Commander is unavailable to the same Agent. The complete Agent tool set must
still be qualified; a policy instruction or approval prompt is not isolation.
