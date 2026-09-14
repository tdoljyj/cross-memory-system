# P3 handoff

This is the final offline publication payload for the authorized Root9 post-budget repair.

Verified on a complete P1+P2+P3 overlay:

- stage verifier: PASS
- P3 negative tests: 11/11
- reserve_gate full-definition diff/catalog wrapper: 26/26
- reserve_gate exact seq102 inheritance branch: 74/74
- Status27 portable generation: positive PASS, 8/8 negatives rejected
- SHA256SUMS: generated after this file
- live connections/writes: 0/0

The actual Status27 files are P2-signed and already present. The CAS template contains the complete
reserve_gate replacement before the append-only CAS block, in one BEGIN/COMMIT. It preserves pending
budget 102 and charged totals, appends only Status27 plus execution events 103/104, and changes only
execution_current.sequence.

Do not execute the unsealed template. After the real P3 merge, create and externally verify the P3
publication-evidence and independent-review Git blobs, run both read-only preflights, seal every
placeholder including the Gate pre/post catalog tokens, independently re-run all verification, then
submit exactly once. On an uncertain response, use readback only.
