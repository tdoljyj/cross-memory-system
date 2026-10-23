# Security policy

## Reporting a vulnerability

This repository is private, so GitHub's private vulnerability reporting form is not available here. Report a vulnerability directly to the repository owner, GitHub user `tdoljyj`, through a private channel; do not describe it in an issue, a pull request, a commit or a BeamingFace record, and never include tokens or secrets. If the repository becomes public, the Owner should enable private vulnerability reporting under Settings → Security.

## Scope

- the production Worker serving the public site at `kooyomi.com` and the compatible MCP/OAuth origins at `kooyumi.pixelgrav.com` and `clued.pixelgrav.com` (source: [apps/clued-cloud/app](./apps/clued-cloud/app) and [apps/clued-cloud/worker](./apps/clued-cloud/worker), built into `dist/server/index.js`);
- the Supabase schema and RPCs ([apps/clued-cloud/supabase](./apps/clued-cloud/supabase));
- the CI admission and release scripts ([scripts/ci](./scripts/ci), [scripts/runner](./scripts/runner), [.github/workflows](./.github/workflows)).

## Supported versions

The current `main` and the production deployment.

## Automated scanning already in place

The [gitleaks](./.github/workflows/gitleaks.yml) and [trivy](./.github/workflows/trivy.yml) workflows scan the full history for secrets, and the tree for vulnerabilities, secrets and misconfiguration, on every pull request and every push to `main`; both are required status checks of the `main` ruleset.
