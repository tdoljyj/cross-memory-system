# Resource Center Gate B: online authority boundary (candidate)

`kernel/host/resource-center-online-tool-host.mjs` is an asynchronous bridge
between a Host-owned online resolver and the existing exact, single-use
filesystem admission. It is **not** a live resolver, a production registration,
or a Gate B qualification by itself. `createResourceCenterOnlineToolHostFromService`
adds a fixed HTTPS `/v1/resource-center/authority` client with a Host-held
dedicated Binding token. Every request includes an unpredictable nonce and the
exact operation, paths, role, profile/policy versions and Host-resolved provider
IDs; the response must echo the identical request and digest. A mismatch or
missing provider identity denies before any filesystem effect. A deterministic
Drive identity resolver maps the pinned root and each path component to unique
live Drive IDs/versions; duplicate names or a moved root deny. A read-only
Drive metadata transport is included, but the Host must still supply an
authenticated, revocable metadata-only credential and keep it in secret storage.
The Host also combines the Canonical workspace version with the pinned Drive
IDs/versions in its in-process admission binding. If provider identity changes
between the two online checks, admission is consumed and the side effect is
denied even when the Canonical authority response itself is unchanged.
The production Clued service endpoint and live credential are **not** included.
`createResourceCenterGoogleDriveOnlineToolHost` composes both Host-held read
channels; its positive temporary-directory test uses simulated metadata and
authority responses, not production credentials or real Drive files.

The Host must supply `resolve_artifact_online` from a separately authenticated,
revocable, least-privilege Clued Binding. For each exact mutation it must obtain
the registered Artifact identity, role, governance/deletion authority,
authority version, Currentness identity and workspace version from the online
Canonical source. The bridge calls it before preflight and again immediately
before consuming admission. A lookup failure, malformed result, changed version
or denied policy leaves the filesystem untouched. It never accepts these fields
from the mutation caller and never exports admission over MCP.

Before connecting this bridge to a real writer, all of the following are
required and independently evidenced:

1. A reviewed Clued service contract that resolves one exact path/operation
   against a Canonical Artifact registration. Repository snapshots, names,
   byte hashes, local JSON and generic record search are not substitutes.
2. A dedicated read-only Binding scoped to that resolver and exact Resource
   Center registration. Its credential lives in Host secret storage, not Git,
   MCP arguments, prompts or receipts. Revocation and a denied-scope probe are
   tested.
3. The complete Agent-visible tool manifest excludes Remote Desktop Commander,
   open-world process/shell/computer-use tools and any generic writer reaching
   the managed root, parent/sibling boundary or scan roots. Qualifying only the
   two tools returned by this factory is insufficient. Ordinary RDP use in
   another workflow remains unchanged.
4. The concrete filesystem provider passes object-identity and atomic
   no-replace requirements for every enabled operation. The current Node
   provider deliberately denies move/rename when native no-replace is absent.
5. Temporary-file negative tests prove an unavailable/revoked resolver,
   Currentness drift, caller authority claims, status folders, sibling/root
   drops and duplicate-bytes delete have zero side effects. A permitted
   track-to-topic operation must produce a verified result/Receipt.

The Owner has authorized a reviewed production resolver, dedicated restricted
environment and temporary-directory acceptance. That authorization does not
turn this candidate client into a live authority source. Until every item
passes on the real endpoint, retain the installed read-only stdio pilot and
`TRUSTED_ARTIFACT_CURRENTNESS_RESOLVER_UNAVAILABLE` for all mutation requests.
Do not edit the real Resource Center or globally change RDP/Windows ACLs.
Rollback of a later isolated connection must leave ordinary RDP intact.
