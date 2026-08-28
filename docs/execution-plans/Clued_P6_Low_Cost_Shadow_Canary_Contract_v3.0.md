# Clued P6 Low-Cost Shadow/Canary Contract v3.0

Status: candidate implementation for owner approval  
Supersedes for future production execution: the latency-measurement method in `Clued_P6_Low_Cost_Shadow_Canary_Contract_v2.0.md`  
Retains unchanged: the v2 phase schedule, qualified-read budget, semantic gates, reliability thresholds, rollback gates, and release requirements

## Objective

Remove HTTP/2 same-lane queue contention from the latency comparison without relaxing any p95 or p99 threshold. The release contract identifier is `clued.p6.shadow-canary-publish-rollback.v3`; the release profile remains `fast-15m-1000-candidate-reads.v1`.

## Required latency measurement

The latency measurement contract is `clued.p6.latency.sequential-mirrored-ab-ba.v1`.

For every mirrored pair:

1. Use two already-warm persistent HTTP/2 connection lanes.
2. On lane A, execute baseline and candidate sequentially in AB order.
3. On lane B, execute candidate and baseline sequentially in BA order.
4. The two lanes may run concurrently, but the two arms on the same lane must never overlap.
5. Preserve the same endpoint, affinity key, expected status, geographic path, and observation block for both arms.
6. Record request/completion timestamps, connection identity, HTTP version, version attribution, order, lane, and transport failures for every leg.

A window produced by concurrent baseline/candidate streams on the same lane is invalid and must return `STOP_LATENCY_MEASUREMENT_INVALID`. It cannot advance a phase or count as evidence for a latency-triggered rollback. Hard semantic, 5xx, timeout, observability, and attribution failures remain actionable independently.

## Frozen thresholds and cost

- p95 candidate/baseline ratio: `<= 1.15`.
- p99 candidate/baseline ratio: `<= 1.25`.
- Severe p95 ratio: `> 1.25`; two consecutive severe windows still trigger automatic rollback.
- All v2 time and qualified-candidate-read minima remain unchanged.
- No additional production traffic is introduced by this measurement correction.

## Worker response fast path

When the response header guard is mutable, P6 attribution and affinity headers are applied to the existing `Response` and the same response is returned. Immutable responses use a compatibility clone. This avoids an unnecessary `Headers` clone and `Response` wrapper on the normal Worker hot path while preserving streaming bodies and response semantics.
