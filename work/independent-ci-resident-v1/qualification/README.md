# Relay qualification controller candidate

Task `169fd456-ef50-4795-b273-df8acfb16076`. This directory contains an
**offline controller core**, its durable fixture journal and regression tests.
The resident does not import it. There is no production factory, command line,
dispatch implementation, live adapter or qualification publication path.
Every successful result is `OFFLINE_COMPLETE_NO_QUALIFICATION` with
`liveQualified: false`. Passing fixtures cannot grant a production capability.

The existing controller-contract.json remains the reviewed design candidate.
Its `currentEffects.implementedController: false` is the historical design-time
observation, not a claim that the later offline source in this directory is a
qualified controller. The production adapter remains unimplemented.

The separate Source v2 Stage13 candidate is a short protected read-only
observation entry. Its installed window binds the twelve static subject fields;
the actual Stage1 nonce and outcome hash are bound later in the full twenty-field
job and verified against protected native receipts. Requiring those post-run
hashes in the install acceptance would create a circular hash dependency.
Stage13 output remains observation only. The separate resident head-hold candidate
persists a restriction before Stage1 and prevents ordinary Resume, expiration or
Source changes from falling back to local scans; it does not enable or dispatch
hosted work. Neither building block makes this fixture controller production-ready.

The state machine implements exact repository/PR/head/base/Source/claim/fence/
epoch/run binding; a per-journal exclusive session; permanent per-HEAD reservation;
create-only intent before stage 1, each of the two hosted dispatches and every
subsequent effect; effect-boundary admission rechecks; no local scanner fallback
or repeated uncertain POST; allowlisted primitive evidence snapshots; ref/old-merge
relation checks; fresh-principal JWKS, terminal and cleanup proofs; and independent
attestation. Recovery only observes the original journal. An uncertain cleanup or
revoked admission retains the exclusive lock. There is no ordinary Resume route.

`offlineFixturePorts` identifies callbacks as fixtures with an in-process WeakSet,
not a JSON authority flag. The callbacks simulate evidence; this core does not
perform or prove actual OIDC verification, annotation capture, ref movement,
network JWKS retrieval, remote terminal reconciliation or independent production
attestation. The PR merge-ref relation in the fixture model is not authorization
to push a commit, change a ref or restart any previously used head.

## Outstanding production requirements

- The full current `c32676f4-4528-408c-b5e6-88cb27fca13a@1` was read from
  Canonical project `clued` on 2026-11-02. The observed-read Receipt is
  `bed195fd-3675-47e2-8410-f68e851c8044`; the UI did not expose its original
  decision Receipt. This read does not authorize activation.
- Build and independently qualify a protected adapter under the actual installed
  Resident principal, immutable accepted Source, native reservation ledger and
  current claim/fence/epoch. A caller-supplied object cannot qualify that adapter.
- Derive stage 1 and role profiles from accepted immutable manifests; never use
  ad hoc shell commands or an Agent-created workflow dispatch script.
- Obtain a fresh authoritative free-quota observation before dispatch. Unknown
  quota stops; no paid fallback is authorized. The configured 80-minute workflow
  timeout is not an estimate or a spending permission.
- Verify the complete OIDC and annotation set inside the protected principal,
  including actual `check_run_id` presence. After L1, c326 requires
  `requireCheckRunIdClaim: true`, a rebuilt/reviewed bound registry and acceptance
  of that new Source before enabling relay. Missing claims cannot weaken this gate.
- Review the actual L3 ref-move mechanism and its admission semantics, then prove
  reading the old merge after that movement. A fixture's booleans are not evidence.
- Prove actual fresh JWKS network from clued-control, trusted local/hosted terminal
  state, cleanup and independent attestation. Cleanup-only revocation authority
  is not implemented here; ordinary admission failure leaves HOLD.
- Accept and install the exact new Source and adapter before a dedicated new-head
  live window. Keep original failures, head burns and costs. Never rescan an old
  head, create an empty commit to reset its meter or enable both hosted/local scans.

Only after those gates may relay or its temporary hosted qualification window be
enabled. Shadow observation remains at least one hour AND three queue-head PRs,
plus the complete sweep, duplicate-execution and anomaly checks, then the Owner's
automatic-handover decision. All switches remain unchanged by this directory.

## Local verification

Run `node --test work/independent-ci-resident-v1/qualification/controller.test.mjs`
with TEMP/TMP pointing to an explicit disposable directory under the claimed local
work area. Tests create only `relay-controller-fixture-*` child roots and remove
only those newly created fixtures. They do not run a scanner or contact GitHub.

The production adapter must supply protected filesystem/OS exclusivity and
durability qualifications; `OfflineJournal` is not a production storage adapter.
