# Clued P6 Low-Cost Shadow/Canary Contract v2.0

Status: approved for implementation by the owner on 2026-08-28  
Supersedes for future production execution: the observation-time and sample-count schedule in `Clued_P6_Shadow_Canary_Publish_Rollback_Runbook_v1.0.md`  
Does not rewrite: sealed P6/G6-3A evidence or any earlier production observation

## Objective

Reduce production release cost and elapsed time while retaining fail-closed semantic, reliability, attribution, observability, and rollback gates.

The contract identifier is `clued.p6.shadow-canary-publish-rollback.v2`. The release profile is `fast-15m-1000-candidate-reads.v1`.

## Qualified-read accounting

`minimum_requests` means qualified requests attributed to the candidate Worker version. Baseline requests, redirects, probe setup calls, retries caused by the probe itself, and interrupted partial runs do not count. The 0% phase uses Cloudflare version override to target the candidate without exposing organic traffic.

## Phase schedule

| Phase | Minimum time | Qualified candidate reads | Purpose |
|---:|---:|---:|---|
| 0% | 2 min | 100 | Targeted production Shadow |
| 1% | 2 min | 50 | Canary |
| 5% | 2 min | 100 | Canary |
| 25% | 2 min | 150 | Canary |
| 50% | 2 min | 200 | Canary |
| 100% | 5 min | 400 | Stability observation |
| **Total** | **15 min** | **1,000** | Minimum complete run |

Both the time and qualified-read minimum must be met for each phase. A phase may take longer when traffic or observability is insufficient.

## Gates that remain unchanged

- Any hard violation, including cross-tenant leakage, causes immediate automatic rollback.
- More than 120 seconds without required observability causes immediate automatic rollback.
- Two consecutive severe windows cause immediate automatic rollback.
- Candidate 5xx rate, timeout rate, p95/p99 ratios, version attribution, receipt observability, and rollback readiness retain the thresholds implemented by `evaluateCanaryWindow`.
- Any hard semantic difference or unclassified semantic difference is fail-closed and cannot be waived by this profile.
- A phase cannot advance when its minimum duration or qualified candidate reads are incomplete.

## Cost and interruption controls

- The probe must stop immediately after the current phase reaches both minima and passes all gates.
- Evidence is written incrementally per phase; an interrupted partial file is not a PASS and cannot be included in the qualified total.
- No fixed 5,000-per-endpoint loop is permitted under this profile.
- Only the five frozen read surfaces are probed during Shadow/Canary unless a gate failure requires a diagnostic request.

## Rollback and release

The prior 100% Worker version remains the rollback target until the 100% stability phase passes. The rollback drill, formal readback, Tag/Release, old-path retirement, production Evidence aggregation, and Closeout remain required and are not reduced by this contract.
