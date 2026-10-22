# v4-host: fixed existing production release, disabled Source candidate

This contains a real executable release entry and a concrete CreateNew installation payload. It preserves the reviewed v3 Grant/currentness code and the existing fixed process manager byte for byte. It is not a general publisher, new Native endpoint or a production authorization. Nothing here has been installed or run on Linux; no Host, remote, DB or credential was read.

The actual remaining prerequisites and future credential paths are in required-metadata.json. Existing CI installation and transport/control-install success do not establish production publisher acceptance; they must not be charged or repeated as missing CI installation. Source/Role/Host acceptance and the original exact-commit Owner Grant remain required. The candidate's context hash, fixed local paths and private file names are execution bindings, not additional online approval doors. The obsolete candidate-created authorizeCurrentness callback is not called.

## Concrete command entry

The payload entry is release/existing-release-entry-v1/v3-host/release-once.mjs. No arguments returns DISABLED/NO_HOST_READ. Its only active form is:

    node /opt/clued-production-release-v3/release/existing-release-entry-v1/v3-host/release-once.mjs --execute-once --fixed-scope existing-production-release-v3-host --reviewed-context-sha256 <actual-reviewed-context-SHA> --reviewed-package-sha256 <this-reviewed-package-SHA>

There is no executable, argv, shell, workflow or target supplied by the caller. A root-owned fixed service pins this exact entry, Source, hashes and actual dedicated subject. A durable CreateNew release-intent precedes credentials/Grant/deploy and is never automatically cleared, expired, reclaimed or retried. A failing command or uncertain tree/outcome stops the chain. Private logs contain command output, never a deliberately serialized environment/credential.

The fixed sequence reuses the original workflow commands:
1. Protected exact main, runtime/Source pins and same-commit protected build inventory.
2. Fixed deployment credential presence/format, then reviewed v3's original production preflight and real exact-commit Owner Grant. Its real result is retained and Source/main rebound after await.
3. Existing storage queue info (any nonzero/error stops; no queue creation), PDF deploy, main deploy with its original DB preflight build hook; record actual main deployment completion time.
4. Reviewed v3 currentness: isolated original nineteen tests through the unchanged fixed manager, both real health endpoints, durable evidence, actual G6 all-path consumer acceptance before/after commit.
5. Original served Agent contract and PDF service check.
6. Original built Connect deploy and original Connect postflight.
7. Original fresh-heartbeat/postflight command, with the main deployment completion timestamp, at most six original read-only attempts.

The fixed manager still permits only its three Git reads and nineteen tests; it is not extended to run deployment commands. Production commands execute in the separately fixed release service with KillMode=control-group, bounded runtime, no delegation/capabilities and NoNewPrivileges. Tests execute as the distinct job subject and receive neither publisher credential files nor its credential group.

The original verification CLIs require GITHUB_SHA. That child field contains the actual reviewed commit as source metadata; GITHUB_ACTIONS/run/attempt/job identities are never fabricated. No Actions run or GitHub evidence provenance is claimed.

There is one deliberate deployment adaptation: PDF's original Wrangler config rebuilds dist. The readonly publisher consumes the already verified same-commit PDF artifact with --no-build; main's original DB preflight hook stays enabled. Main/PDF/assets must come from the original successful release build, and Connect must come from original build-release.mjs with that actual commit. This candidate does not run CI/build/dependency installation with production credentials. build-files.json only binds the complete output inventory; Root must verify the actual independent CI/release-build evidence before admitting it.

The build inventory has exact keys contract/sourceCommit/files, with files mapping actual Source-relative paths to SHA-256. It covers every regular root-protected file under apps/clued-cloud/dist/server, dist/client and dist/pdf-extractor, plus the fixed .sites-runtime/release-inputs/connect/worker.mjs. It refuses missing, added, changed or linked files and checks the actual Connect commit prefix. It does not synthesize build outputs or a CI pass.

## Fixed installation payload

Stage this directory's payload/, install-once.mjs and package-manifest.json at /root/clued-existing-release-v3-install, root-owned with protected parents. Root must separately supply the actual non-secret public existing-release.json and currentness-manager.json at that fixed staging root. The provided *.template.json contain nulls and are intentionally rejected; they are not accepted Host facts. Fill them only from actual final-main, identity, runtime and Host observations. The Node/Git values shown are previously Root-reported bytes, not fresh Host reads by this candidate.

The original reviewed v3 context schema is unchanged. sourceRoot is this install choice /srv/clued-production-release/source; sourcePins must cover v3's existing required files and the added fixed CLI/config/build-manifest files checked in host-files.mjs. Include the actual root-protected Wrangler direct entry apps/clued-cloud/node_modules/wrangler/bin/wrangler.js. The complete dependency/code tree must remain protected; no npm install runs during deployment.

The manager JSON retains the existing /2 schema and rendered unit, bound to the exact same Source/main/runtime and the copied unchanged manager at /opt/clued-production-release-v3/release/linux-process-manager.mjs. Actual manager refs/qualification refs must refer to real evidence. The two actual users must already exist, have different UIDs/credential groups and have no root/Docker membership. The installer creates no users.

The sole install invocation is:

    node /root/clued-existing-release-v3-install/install-once.mjs --install-once --fixed-scope existing-release-v3-host-install --reviewed-context-sha256 <actual-reviewed-context-SHA> --reviewed-package-sha256 <this-reviewed-package-SHA>

It verifies all package bytes, actual public inputs/users/build files and exact manager bindings before creating fixed files. It installs only:
- /opt/clued-production-release-v3 protected payload/manifest;
- the two fixed /etc public contexts, existing manager unit and fixed release service;
- one publisher-user polkit rule for start/stop of exactly the four existing manager instances;
- fixed private run/evidence/home/tmp/state directories, root-owned output directory and twelve job-owned fixed output files;
- publisher-owned ignored apps/clued-cloud/.wrangler cache leaf;
- an empty root/publisher protected credential directory, without reading/provisioning any credential.

Existing files or directories with different contents/ownership or unsafe modes are refused, never overwritten or chmodded. Identical root-owned public files may retain an existing protected world-readable mode such as 0644; the exact job-output/private-directory modes remain required. Partial installation is preserved for real reconciliation, not rollback/delete/retry. The installer does not daemon-reload, enable/start any service, read a credential, qualify a Host or grant production authority. There is no WantedBy or Restart route. It does not touch transport/control-install paths, the CI unit or runner permissions.

Root must perform its real reviewed systemd/polkit/Host acceptance and daemon reload separately, then obtain/provision the four fixed protected credential files after the real production acceptance. Root starts this exact service only for the reviewed final main and original Grant. The candidate does not request the Owner Grant itself during installation.

## Acceptance and current limits

Only a command-chain result is written: COMMAND_CHAIN_COMPLETED_AWAIT_HOST_CLEANUP. It explicitly says productionAcceptanceClaimed=false and systemdTerminalAndTreeCleanupObserved=false. Root must independently observe the actual fixed service's terminal result, MainPID=0 and absent/empty populated-0 cgroup, reconcile all intents/actual outcomes and validate all original release evidence. A successful parent process exit or a completed JSON file is not cleanup or production acceptance.

The readonly gate/script bytes and seven original release evidence requirements remain; no backup or schema migration is added. No broader gateway DB role or new consumer migration is requested. Root independently reported both public health URLs currently serving the same Worker; the executable still reads both itself and never relies on that report for its future evidence.

Offline validation: syntax for all seven JS files, default-disabled/unknown-argument entry guards and byte equality for the four reviewed predecessor modules passed. No Linux installation, systemd call, real endpoint/DB/secret read, deployment, or enabled execution has been performed.

## v4 correction

The frozen v3-host predecessor remains unchanged. The only executable delta removes queue creation: the fixed queue info command must exit zero or the release stops. Authentication, network and unknown failures are not evidence that the queue is absent. Root must actually confirm the existing production clued-storage-jobs queue before this release. Runtime paths, package contract, fixed scope, installer and all other commands retain v3 bytes; v4-host denotes this package revision, not a second publisher installation namespace.

## v5 correction (2026-10-22)

The frozen v4-host predecessor (package manifest 338b5b12) stays unchanged. On the actual Host (WSL Ubuntu 24.04, systemd 255.4-1ubuntu8.18) the installed v4 manager refused every fixed operation with MANAGER_SYSTEMD_BOUNDARY_UNPROVEN before starting a unit: `systemctl show` there omits ExecStartPre, ExecStartPost, ExecCondition, ExecStop, ExecStopPost, ExecReload and EnvironmentFiles when they are empty, even with --all, while v4 required every listed property to be present. The only executable delta treats exactly those seven absent list properties as empty; every other property must still be present, a non-empty value of any of the seven is still refused, and unknown or duplicate keys are still refused. existing-stages.mjs pins the new manager bytes. install-once.mjs, host-files.mjs, release-once.mjs, fixed-currentness-ports.mjs and verify-currentness-external.mjs are byte-identical to v4. Owner approval: Decision cdd6eeb8 (Task 40954f34). offline-checks-v5.mjs exercises the parser on the Host's real `systemctl show` output and fixed mutations.

## v6 correction (2026-10-22)

The first real release run with v5 (InvocationID fa5ae5a6...) stopped at pdf-deploy before any upload: the locked wrangler 4.125.0 has no --no-build and always runs build.command, which would rebuild the root-protected dist/pdf-extractor. The only executable delta in release-once.mjs: before the Grant, the publisher derives from the pinned apps/clued-cloud/wrangler.pdf-extractor.jsonc (hash checked against the context sourcePins, shape checked: name, main, no_bundle, build.command only) a copy with build and $schema removed and main re-anchored to ../dist/pdf-extractor/index.js, writes it CreateNew 0600 into the publisher's .wrangler leaf, records its hash, re-reads and re-hashes it right before use, and deploys with --config .wrangler/pdf-extractor.release.json. A publisher-sandbox wrangler --dry-run of that derived config uploads a file byte-identical to the verified dist/pdf-extractor/index.js. Main and Connect deploys are unchanged (their dry-runs pass). All other files are byte-identical to v5. Owner approval: Decision a796d9e2 (Task 40954f34).
