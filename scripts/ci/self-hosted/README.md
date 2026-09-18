# Clued Self-hosted Windows Runner Onboarding

This directory contains the reusable bootstrap path for trusted Windows nodes joining the Clued CI Compute Pool.

## Current Windows capability contract

A Windows node must already provide:

- Windows x64
- Python 3.12 available as `python`
- outbound HTTPS access to GitHub
- enough local disk for the runner workspace

The bootstrap script deliberately **does not install Python** and does not call `actions/setup-python` on the self-hosted Windows path. This avoids machine-wide installer/UAC behavior on owner-managed PCs.

During bootstrap, the script resolves the exact verified Python 3.12 executable with `sys.executable`, writes local `python.cmd` / `python3.cmd` shims under `C:\clued-ci\tools`, and prepends that tools directory to the login-started runner PATH. This prevents later runner sessions from falling back to WindowsApps/Python Launcher aliases and re-triggering installer/UAC prompts.

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

1. verify local Python 3.12;
2. resolve and pin the exact verified Python executable for future runner sessions;
3. download the pinned official GitHub Actions Windows x64 runner;
4. verify the pinned SHA-256 digest before extraction;
5. prompt for the short-lived GitHub runner registration token without echoing it;
6. register capability labels;
7. create a current-user login startup launcher;
8. start the runner and verify `Runner.Listener` locally.

Default custom labels for the home node:

```text
clued
pool-general
trust-internal
site-home
cap-python312
```

GitHub default labels such as `self-hosted`, `Windows`, and `X64` remain attached automatically.

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

Service mode does not modify machine PATH. The service account must therefore already have the verified Python 3.12 executable available on its persistent PATH.

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
