# Fixed Linux formal configuration installer

Source candidate; default invocation is disabled. This is a create-only adapter
to the existing qualification, fixed-role, readiness and protected-file code.
It never creates or signs a qualification, reads the result private key, starts
a container/service, changes GitHub, fetches an image or downloads caches.

Root must first review and accept this exact installer, commit it in the same
complete independent Git Source checkout as the existing runtime, provide the
actual externally accepted and signed qualifications, and prepare the actual
protected cache generations. Source fixture tests do not establish any of this.

## Fixed public input directory

Root-only regular single-link files under the protected directory:
`/etc/clued-independent-ci/formal-install-input-v1/`.

- `install-plan.json` (raw SHA-256 passed separately to the CLI)
- `source-manifest.json` (the same raw manifest used by Windows and all roles)
- `<role>.policy.json`, `<role>.qualification.json`, `<role>.job.json` for
  `gitleaks`, `trivy`, `contract-placement`.

Inputs are read-only. Their bytes are not normalized or repaired. The plan must
have exactly these fields; `null`, absent pins and disabled values are refused:

```text
contract: clued.independent-ci.linux-formal-install/1
enabled: true                 # only in Root's actually accepted runtime input
accepted: true
exclusiveHostWriter: true      # cooperative Owner boundary, not an OS root lock
ownerAcceptanceRef: actual existing acceptance reference
acceptedAt / expiresAt: actual bounded acceptance times
sourceRoot: actual protected independent clean Git checkout root
sourceCommit: actual 40-character commit, equal to source-manifest.sourceSha
sourceManifestSha256: SHA-256 of the raw shared manifest
installerSourceFiles: exactly [{path, sha256}, ...] for INSTALLER_SOURCES
roles: exactly gitleaks, trivy, contract-placement, each containing
  policySha256, qualificationSha256, jobSha256 (raw bytes)
cache: {root, dbPointerSha256, checksPointerSha256} (raw pointer bytes)
```

`INSTALLER_SOURCES` contains the repository-relative installer path and reused
`host/linux-verify-config-v2/public-files.mjs`. All role Source pins plus these
two installer pins must match committed Git blobs and actual files. The whole
independent checkout must be clean, full, and without alternate object stores.
The installer must execute from that same checkout; a copied WORK script fails.

Every policy uses the unchanged `independent-ci.linux-policy.v1` schema, real
current claim, role-specific accepted image and qualification, and these paths:

```text
nodeExecutable = /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
gitExecutable = /usr/bin/git
dockerExecutable = /usr/bin/docker
entryFile = <sourceRoot>/work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v3/linux-worker.mjs
sourceManifestFile = /etc/clued-independent-ci/formal-source-manifest-v1.json
qualificationFile = /etc/clued-independent-ci/roles/<role>.qualification.json
publicKeyFile = /etc/clued-independent-ci/verify-result-public.pem
signingKeyFile = /etc/clued-independent-ci/verify-result-key.pem
```

Node/Git/Docker/public-key pins are fixed to Root's supplied actual observations
in the Source. Qualifications must carry the exact `role` as well as every
binding required by the original loader, and verify against the existing public
key. This tool cannot determine Canonical acceptance merely from text refs;
Root must supply actual accepted refs and signed results, not invent them.

Workspace/runs roots and all key files must already exist with the original
protections. No private key bytes are opened. Three real jobs must bind the same
PR/head/base/current claim/manifest and their respective roles.

## Install and validation

Invoke only the accepted pinned Node with no Node loader/options and the CLI:

```text
<pinned-node> <accepted-source-root>/work/actions-hosted-migration/independent-ci-v1/worker/linux-formal-install-v1/install.mjs --install <accepted-plan-raw-sha256>
```

The explicit flag and digest do not grant authority; the package and inputs must
already be accepted. Root must be the only Host writer during this finite call.

Preflight verifies original policy shapes, signatures and role facts, actual
executables, full clean Git Source, existing immutable cache/pointer pins and
fresh DB/checks, metadata-only private key protection and the actual public key.
It refuses an existing serial role lock, installer lock, manifest, policy,
qualification or receipt target. An existing protected `roles/` directory is
reused; otherwise it is created once under the existing protected parent.

Writes use existing `atomicNew`: complete/fsynced temporary bytes are linked
to a new final name, never replacing a target. Intent lock is retained even on
success. Manifest and qualifications are written first, policies last. Every
file is read back. Then the original `linuxReadiness(policyPath)` and
`loadFixedRolePolicy(actualJob)` run for each role. Docker is only queried for
engine/image readiness, with no container creation, pull or execution.

The success receipt is
`/etc/clued-independent-ci/linux-formal-install-v1.receipt.json`, status
`INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED`. It reports no formal execution,
qualification issuance or Check publication. It does not prove a real PR passed.

Any partial/unknown install preserves created files and intent lock, returns a
failure, and has no automatic retry, deletion, replacement or rollback. Three
policy writes are not a multi-file atomic transaction; other root administrators
must not run roles or mutate these paths concurrently. Investigate retained
intent and actual file hashes before any separately accepted recovery.

## Local validation only

`node worker/linux-formal-install-v1/selftest.mjs` exercises disabled, stale,
missing-input, traversal and unsigned-envelope refusal. It never supplies a
real signature or claims actual installation/qualification. Run actual readiness
only on Root's accepted Host with actual inputs as above.
