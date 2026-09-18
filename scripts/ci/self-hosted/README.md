# Clued Self-hosted Windows Runner Onboarding

This directory contains the reusable bootstrap path for trusted Windows nodes joining the Clued CI Compute Pool.

## Current Windows capability contract

A Windows node must already provide:

- Windows x64 or arm64
- Python 3.12 available as `python`
- outbound HTTPS access to GitHub
- enough local disk for the runner workspace

The bootstrap script deliberately **does not install Python** and does not call `actions/setup-python` on the self-hosted Windows path. This avoids machine-wide installer/UAC behavior on owner-managed PCs.

## Add the home Windows node

From a trusted checkout of this repository on the home computer:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ci\self-hosted\bootstrap-windows-runner.ps1 `
  -Site home `
  -RunnerName clued-ci-home-win-01
```

The script will:

1. verify local Python 3.12;
2. fetch the latest official GitHub Actions Windows runner;
3. verify the published SHA-256 digest before extraction;
4. prompt for the short-lived GitHub runner registration token without echoing it;
5. register capability labels;
6. create a current-user login startup launcher;
7. start the runner and verify `Runner.Listener` locally.

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

The default onboarding path does not require administrator elevation. It starts the runner after the current Windows user signs in.

If a future dedicated machine should run as a Windows Service, launch an elevated PowerShell intentionally and add:

```powershell
-RunAsService
```

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
