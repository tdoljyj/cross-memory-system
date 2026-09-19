"""Exact immutable binding values for the reviewed M1-07 orchestrator implementation.

This module is intentionally separate from m1_runtime_stability_pc.py so the
orchestrator can verify its own bytes without a cryptographic self-reference.
Do not edit these values without creating a new orchestrator implementation
identity and repeating Fresh-Context review.
"""

EXPECTED_ORCHESTRATOR_COMMIT = "b807b9986e314d3adfedb05b69728fbe879ffabb"
EXPECTED_ORCHESTRATOR_BLOB_SHA1 = "461f093f15780f91d4d55aa316bfe23cff761681"
EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256 = "d3984c39a0c4ac3a77a3f87c26603a86cdb360f4e7349448501eaab092699dc9"
