"""Exact immutable binding values for the reviewed M1-07 orchestrator implementation.

This module is intentionally separate from m1_runtime_stability_pc.py so the
orchestrator can verify its own bytes without a cryptographic self-reference.
Do not edit these values without creating a new orchestrator implementation
identity and repeating Fresh-Context review.
"""

EXPECTED_ORCHESTRATOR_COMMIT = "52c99f179a4046430fbafc1ea610303dbfcbc5ce"
EXPECTED_ORCHESTRATOR_BLOB_SHA1 = "60310021d161eeb0aace2dd670241523845a60f0"
EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256 = "1998a53330bcc0485412132906274e85b725e1d13c1d6c68d2e004037d6daddb"
