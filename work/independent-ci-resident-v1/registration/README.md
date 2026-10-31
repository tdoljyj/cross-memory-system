# Node registration export

Produces the public material a node needs to be registered on the BeamingFace **CI nodes** page (`/ci-nodes`, unified scheduling
stage 1, Task `98dbf336`; this tool is Task `c9673047`). It works the same way for any number of nodes (Decision `d6eef30e`): run it once
on each node, paste each node's document, and the Owner approves each node on the page.

What it writes, and nothing else:

- `clued-node-registration.json`: the document the page's registration box accepts, with exactly the keys `binding_id`, `name`,
  `profile`, `profile_sha256`, `identity_public_jwk`, `encryption_public_jwk`, `qualification_digest`, `qualification_source`,
  `publisher_requested`, `scan_signing_requested`.
- `clued-node-registration.qualification.json`: the public qualification report (host facts, key fingerprints, the CI Source commit
  and manifest hash, the profile digest). `qualification_digest` is the SHA-256 of its canonical JSON. Keep it with the node's
  install record; it lets anyone recompute the digest.

Both are public. The tool never reads, prints, writes or uploads a private key, never touches the network, and never overwrites a
file (`OUTPUT_EXISTS`). Before writing, it checks the document against the same rules as the page (`registration-core.mjs`,
`test/registration-core.test.mjs` fails if the page's lists change).

## Two modes

| Mode | What it does | When |
|---|---|---|
| `export` (default) | Read-only. Reads the node's two **public** keys, observes the host, reads the installed CI Source commit, writes the two files. A missing key is `KEY_MISSING`; nothing is created. | Any time. |
| `init-keys` | Creates the identity key (ECDSA P-256, signing) and the encryption key (ECDH P-256, key agreement). Needs an explicit confirmation flag. Refuses with `KEY_EXISTS` if either key, or any of its files, already exists; it never replaces a key. | **Only in an install wave the Owner approved.** It is a key operation. |

The two keys are always different keys; the page and the database refuse a node whose two keys are the same.

## Windows nodes

Prerequisites:

- Windows PowerShell 5.1 (built in) or PowerShell 7.
- **An elevated PowerShell** (Run as administrator). The keys are machine keys and the TPM state is admin-only; without elevation the
  script stops with `ELEVATION_REQUIRED` before doing anything.
- Node.js 20 or later on `PATH`, or pass `-Node <full path to node.exe>`.
- The resident install's `C:\ProgramData\CluedIndependentCI\resident\record\source-manifest.json` (its `sourceSha` is the CI Source
  commit the node runs). Without a resident install pass `-SourceCommit <40-hex>` or `-SourceManifest <file>`; nothing is guessed.

Keys: persisted, **non-exportable** CNG machine keys named `Clued-CI-Node-Identity-v1` and `Clued-CI-Node-Encryption-v1`, in the TPM
(Microsoft Platform Crypto Provider) when it is usable, otherwise in the Microsoft Software Key Storage Provider. The script exports
only the public blob. `identity_key_origin` in the profile says which (`tpm` or `software`).

Create the keys (approved install wave only; `-KeyProvider tpm` refuses instead of falling back to software):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\export-node-registration.ps1 -Mode init-keys -ConfirmCreateKeys [-KeyProvider auto|tpm|software]
```

Export:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\export-node-registration.ps1 -BindingId <connection id> -SlotCount <1..64> `
  [-Name <name>] [-SiteId <id>] [-EnvironmentKind E1-Windows,E4-Windows-Sandbox] [-Role scan,publish] [-Exclusion relay] `
  [-MemoryLimitMb <MiB>] [-PublisherRequested] [-ScanSigningRequested] [-Out <file>] [-ReportOut <file>]
```

`-FactsOnly` prints the observed public facts as JSON and writes nothing. `-SelfTest` creates two ephemeral (never stored) keys and
prints their public keys and one signature; the tests use it to check the key conversion.

## Linux nodes

Prerequisites:

- Node.js 20 or later.
- `root` (or `sudo`) for the default key directory `/etc/clued-ci-node/keys`; any user for a key directory it owns (`--key-dir`).
  `export` needs read access to the two `.pub.pem` files only.
- The CI Source commit: `--source-manifest <record/source-manifest.json>` of the resident install, or `--source-commit <40-hex>`.
  There is no default on Linux; without one the tool stops with `SOURCE_UNAVAILABLE`.

Keys: software keys (`identity_key_origin: software`). `init-keys` writes `identity.key.pem` and `encryption.key.pem` (PKCS#8, mode
0600, directory 0700) and `identity.pub.pem` and `encryption.pub.pem` (SPKI) beside them. `export` opens only the two `.pub.pem`
files; it checks that the private files exist and are not readable by group or others, without opening them.

Create the keys (approved install wave only):

```sh
sudo node export-node-registration.mjs init-keys --confirm-create-keys [--key-dir /etc/clued-ci-node/keys]
```

Export:

```sh
sudo node export-node-registration.mjs --binding-id <connection id> --slot-count <1..64> \
  --source-manifest /path/to/record/source-manifest.json \
  [--name <name>] [--site-id <id>] [--environment-kind E1-Linux] [--role scan] [--exclusion relay] \
  [--memory-limit-mb <MiB>] [--publisher-requested] [--scan-signing-requested] [--key-dir <dir>] [--out <file>] [--report-out <file>]
```

## The profile

| Field | Source |
|---|---|
| `schema` | always `clued.ci-node-profile/1` |
| `slot_count` | `-SlotCount` / `--slot-count` (required, 1..64) |
| `identity_key_origin` | where the identity key lives (`tpm` / `software`) |
| `capabilities` | detected: the OS (`windows` / `linux`), `docker` (a Docker server answered), `hyper-v` and `windows-sandbox` (Windows optional features enabled); declared: the roles `scan`, `publish`, `control`, `relay`, `f-pr`, only when passed with `-Role` / `--role` |
| `exclusions` | `-Exclusion` / `--exclusion` (may not repeat a capability) |
| `memory_limit_mb` | `-MemoryLimitMb` / `--memory-limit-mb`, default the machine's physical memory (at most 1048576) |
| `site_id`, `environment_kinds` | only when passed |

Everything in the profile is a declaration. Registration does not turn it into attestation or permission (stage 1 README); the
Owner's approval and the later qualification decide what a node may do.

## Registering on `/ci-nodes`

1. Get the **connection id** (`binding_id`, a UUID) of the node's BeamingFace connection and pass it as `-BindingId` /
   `--binding-id`. The page accepts only a live connection of this account that has `context:read` and is listed when you read the
   state; it refuses any other id. Today neither `/ci-nodes` nor `/bindings` displays connection ids, and the resident install record
   does not hold one: take it from where the connection was issued (the person or Agent who created it). A connection picker on the
   page is a separate change.
2. Run the export on the node (above). It prints the paths and the two key fingerprints.
3. Open `clued-node-registration.json`, copy its whole contents, paste them into the page's registration box and submit. The page
   checks the document again; any change by hand makes the digests stop matching.
4. The node appears as **待批准** (pending). The Owner checks the name and the two fingerprints against the ones the export printed
   on the node, then approves it on the page (two-step confirmation).
5. Keep the qualification report with the node's install record.

Registration grants nothing at runtime: the node cannot run work until stage 2 enables the node signature gateway
(`SIGNATURE_GATEWAY_NOT_ACTIVATED` until then).

## Errors

Every refusal prints one `CODE: detail` line and exits with 2: `USAGE`, `ELEVATION_REQUIRED`, `CONFIRMATION_REQUIRED`, `KEY_MISSING`,
`KEY_EXISTS`, `KEY_ACCESS_DENIED`, `KEY_PERMISSIONS`, `KEY_CREATE_FAILED`, `PUBLIC_KEY_INVALID`, `SOURCE_UNAVAILABLE`, `FACTS_INVALID`,
`OPTION_INVALID`, `PROFILE_INVALID`, `REGISTRATION_INVALID`, `OUTPUT_EXISTS`, `NODE_MISSING`.

## Tests

```sh
node --test test/registration-core.test.mjs test/export-cli.test.mjs
```

The Windows conversion test runs only on Windows (it uses ephemeral CNG keys; no key store is touched). The Linux file-mode checks run
only on Linux.
