# Component version integration v0.3 candidate

Task 342c implementation successor to v0.2 section 3. Publication and activation
still require review of the exact candidate and the existing release gates.
Contract/Skill separation, placement rules, semantic version ordering, source
identity, qualified execution and version reporting from v0.2 remain in force.

## Generate versions before the tested integration head

Source PRs declare their real source changes; they do not hand-edit overlapping
component versions. The existing integration builder runs
`scripts/ci/component-version-integration.py` after trial merge and before it
commits/publishes the candidate that will be tested. The caller supplies exact
base and candidate SHAs. The tool requires a clean candidate, verifies ancestry
and input content CAS, and writes no Git ref, commit or push.

For every component with declared source coverage, content changes since the
base require at least the next patch version (or next integer for an integer
version). An explicitly higher semantic version is preserved; versions never
decrease. Version markers alone and generated output changes do not cascade
into unrelated releases. Real executable changes outside a marker still count.
Removed components, missing markers, unsafe paths and stale input plans fail.

Every service must declare explicit, nonempty `root/files` that match real
source. Missing service coverage is an error, not permission to skip its version.
The current `mcp.server` needs initial coverage in the integration manifest;
the tool does not guess it or replace a service release with a manual exception.

The builder runs the fixed existing generators, component digest update and
strict pinned-registry checks to a bounded fixed point. `UNCHECKED` is failure
even in GitHub Actions. A failure leaves an unqualified candidate for diagnosis;
it does not commit, publish, reset or clean another checkout. The builder then
commits the generated result and tests/authorizes that final head using all
existing Source, Role, Native and merge gates. Post-merge mutation of main is
not the integration route.

## Shared mechanical resources

`config/clued-mechanical-files.json` is the only path policy. Its Native literal
is deterministically generated and checked by `pinned-registries`. It is scoped
to the declared repository and canonical project; no storage resource, other
repository, broad source glob, Task/trigger conflict or authorization gate is
waived. The local hook only projects the nonexclusive paths out of reminders;
it keeps requiring a live claim and does not rewrite claim records.

PR coverage exemptions additionally require the existing trusted CI Binding's
`mechanical_paths_proven`, bound to the exact PR/head/base and changed paths.
The accepted gate verifies normal Git blob modes on both sides and reads exact
Git blob bytes. For executable scripts only the declared version constant may
change; component source definitions cannot change under a version/hash waiver.
Without proof, the original complete write-set coverage requirement applies.
Pure generated artifacts retain deterministic generator/pin validation.

There is no automatic production activation, Source acceptance, permission
expansion, frozen-upgrader change or exemption from all-main-through-PR rules.
