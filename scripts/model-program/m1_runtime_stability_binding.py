"""Exact immutable binding values for the reviewed M1-07 orchestrator implementation.

This module is intentionally separate from m1_runtime_stability_pc.py so the
orchestrator can verify its own bytes without a cryptographic self-reference.
Do not edit these values without creating a new orchestrator implementation
identity and repeating Fresh-Context review.
"""

EXPECTED_ORCHESTRATOR_COMMIT = "7c430bf143d1f8e9b66c7c02ff7caa406190ccbb"
EXPECTED_ORCHESTRATOR_BLOB_SHA1 = "1b07232fd63cf6d0b2079919a6cc0ab0fec4e09a"
EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256 = "31c1a57eb29e49bc090af2664c4b2fbb083a97c28a081e27601cce2265b297c6"
