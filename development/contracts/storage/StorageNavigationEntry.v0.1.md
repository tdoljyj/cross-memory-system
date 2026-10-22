# Existing Resource Center navigation entry maintenance v0.1

Engineering successor for the missing live-navigation policy branch. Source
review, merge and deployment remain separate evidence; this document is not a
Canonical decision, a grant or proof that a production update completed.

## Reserved target

`00_从这里开始/Clued_资料中心使用前必读.md`, relative to the authenticated
connection's managed root, is the single existing live navigation projection.
Its stable filename is a layout rule, not an account or provider identifier.
It points to authoritative material and cannot itself replace Canonical truth.

The shared mutation policy permits only `target_kind=file` with `adopt` or
`replace` at that exact two-segment path. It does not create an entry, initialize
a directory, register a root or turn `00_从这里开始` into a track. Existing profile,
onboarding, directory qualification and allowed track lists stay unchanged.

Every other operation involving that directory is refused with
`RESOURCE_CENTER_NAVIGATION_ENTRY_PROTECTED`, including sibling files, historical
copies, descendants, directory operations, create/write, move/rename and
trash/untrash. This protection runs before ordinary track membership and applies
even to a profile that includes the reserved directory in its track list.

## Existing authority and registration boundaries

The layout branch is not admission. The online Host must resolve authority
before policy preflight, revalidate it before durable preparation and again
before the provider effect; exact single-use binding and commit-time policy
checks remain required. Caller-supplied authority fields remain forbidden.

P7 adoption retains its existing scope and ordinary-only registration semantics:
full provider scope, the Owner's existing-file management/modify grant, a current
registered ordinary parent, exact path and provider ID, ownership, uniqueness,
stable identity and verified settlement. This change neither reclassifies an
existing object nor authorizes adopting a governance object. Governance objects
still require their existing Owner-authorized administrative registration path.

P4 replacement retains its overwrite grant, registered target identity, observed
version, current authority, type/size checks, revision retention, provider
postcondition and CAS settlement. No account, file ID, parent ID or version is
hardcoded in the policy. No raw filesystem or alternate-binding fallback is
introduced.

## Regression and actual completion

Tests must exercise allowed maintenance through the real shared Host, reserved
namespace refusals on both source and destination, an incorrectly broad profile,
authority/identity/version failures with zero provider effects, and unchanged
ordinary track behavior. Existing provider and database tests retain their
respective scope; synthetic callbacks do not prove live SQL or Drive success.

For a concrete repair, retain the original failed jobs and receipts, verify the
reviewed source was actually deployed, inspect current registration and provider
state, and use the normal authorized maintenance operation. A lost reply is
inspected under its original job ID. Only verified settlement plus a full
readback of the same file ID, parent, native MIME and intended bytes establishes
the completed navigation update. Concurrent changes require a fresh read and
reconciliation; a source fix alone does not establish completion.
