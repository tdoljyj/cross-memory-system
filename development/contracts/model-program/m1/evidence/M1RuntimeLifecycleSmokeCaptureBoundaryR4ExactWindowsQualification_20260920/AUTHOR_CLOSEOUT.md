# M1-08 capture-boundary r4 Windows qualification

Author-side targeted remediation qualification passed. Fresh-Context independent implementation re-review remains required.

Source Freeze: 5a691080fedd38e069f1bbb0ba335a34750e4682

Repair base / previously blocked head: d09b6365f9d93941cd59c3c2ee89e0f6fc0ab2c4

Source manifest: 40eaa69913ade714d2e717a94a317d1b2ecce9b73b9ef0824b9aeeff345dc801

Both exact Windows runs: 68 top-level + 22 subtests; 12 Windows-native top-level; 0 FAIL / 0 SKIP. Python 10/10 and go vet passed in each run. A separate focused Windows test-binary run passed 4/4 R4 tests. Counts overlap and must not be summed.

The remediation is limited to the prior MAJOR-07 / MAJOR-08 capture boundary: signed/exact capture-output authorization and expiry/deadline/finalization persistence revocation. No Contract/Profile bytes changed.

No Owner/model/lifecycle execution, private-key access, issuer/root decision, Guard Parent provisioning, Profile issuance, merge, M1-09 entry, training, distillation, promotion, activation, release or production deployment was performed.
