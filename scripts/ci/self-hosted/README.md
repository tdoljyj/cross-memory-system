# Clued Self-hosted Windows Runner Onboarding

This directory contains the reusable bootstrap path for trusted Windows nodes joining the Clued CI Compute Pool.

## Current Windows capability contract

A Windows node must already provide:

- Windows x64
- Git for Windows available as `git`
- Python 3.12 available as `python`
- Node.js 24 is optional; when verified, the runner receives `cap-node24`
- outbound HTTPS access to GitHub
- enough local disk for the runner workspace

The bootstrap script deliberately **does not install Python** and does not call `actions/setup-python` on the self-hosted Windows path. This avoids machine-wide installer/UAC behavior on owner-managed PCs.

The bootstrap also enables Git for Windows long-path support before runner registration. Default login-start mode uses the current user's Git config (`git config --global core.longpaths true`) and does not require elevation. Explicit service mode uses system Git config because the eventual service account may not share the interactive user's global Git config. This is required because the repository contains reviewed historical evidence paths that can exceed the legacy Windows path limit during `actions/checkout`.

During bootstrap, the script resolves the exact verified Python 3.12 executable with `sys.executable`, writes local `python.cmd` / `python3.cmd` shims under `C:\clued-ci\tools`, and prepends that tools directory to the login-started runner PATH. This prevents later runner sessions from falling back to WindowsApps/Python Launcher aliases and re-triggering installer/UAC prompts.

If Node.js 24 is already available, the script resolves its exact executable, writes a local `node.cmd` shim, and adds `cap-node24`. If Node.js 24 is absent or a different major version is found, the runner still joins the pool with its verified Python capability but does **not** advertise `cap-node24`.

## Bootstrap artifact policy

The script currently downloads the exact reviewed Windows x64 runner package:

```text
GitHub Actions Runner: 2.337.0
SHA-256: 1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc
```

The package hash is verified before extraction. This avoids depending on anonymous GitHub API rate limits during first-time setup. GitHub runner automatic updates remain enabled after registration.

When GitHub eventually requires a newer bootstrap version, update the pinned version and digest through a reviewed repository change.

## Add the home Windows node

From a trusted checkout of this repository on the home computer:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ci\self-hosted\bootstrap-windows-runner.ps1 `
  -Site home `
  -RunnerName clued-ci-home-win-01
```

The script will:

1. verify Git for Windows and enable long-path checkout support;
2. verify local Python 3.12;
3. resolve and pin the exact verified Python executable for future runner sessions;
4. detect Node.js 24 and pin it only when the capability is actually present;
5. download the pinned official GitHub Actions Windows x64 runner;
6. verify the pinned SHA-256 digest before extraction;
7. prompt for the short-lived GitHub runner registration token without echoing it;
8. register only the capabilities actually verified on the node;
9. create a current-user login startup launcher;
10. start the runner and verify `Runner.Listener` locally.

Baseline custom labels for the home node:

```text
clued
pool-general
trust-internal
site-home
cap-python312
```

When Node.js 24 is verified, the script additionally registers:

```text
cap-node24
```

GitHub default labels such as `self-hosted`, `Windows`, and `X64` remain attached automatically. Capability labels must describe what the node actually provides; they are not decorative tags.

## Registration token

Create a new repository-level self-hosted runner token from:

`Repository Settings -> Actions -> Runners -> New self-hosted runner`

Paste only the one-time token into the script prompt. Do not commit, save, screenshot, or send the token in chat.

## Service mode

The default onboarding path does not require administrator elevation. It starts the runner after the current Windows user signs in and pins the verified Python executable through the local tools shim.

If a future dedicated machine should run as a Windows Service, launch an elevated PowerShell intentionally and add:

```powershell
-RunAsService
```

Service mode does not modify machine PATH. The service account must therefore already have the verified Python 3.12 executable and every advertised optional runtime capability available on its persistent PATH.

Because service accounts do not necessarily share the interactive user's Git config, service mode configures `core.longpaths=true` at Git system scope. This is an intentional machine-level Git configuration change and requires elevation.

Do not use service mode on company-managed devices unless permitted.

## Adding more Windows nodes

Reuse the same script with a unique runner name and site. Workflows target capabilities rather than machine names, so adding nodes should expand the pool without changing normal CI routing.

Examples:

```text
clued-ci-home-win-01
clued-ci-company-win-01
clued-ci-home-win-02
```

Do not add Linux/Docker capability labels to Windows nodes. Linux container/service-container workloads belong on a separate Linux runner pool.
