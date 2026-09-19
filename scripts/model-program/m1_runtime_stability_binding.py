"""Exact immutable binding values for the reviewed M1-07 orchestrator implementation.

This module is intentionally separate from m1_runtime_stability_pc.py so the
orchestrator can verify its own bytes without a cryptographic self-reference.
Do not edit these values without creating a new orchestrator implementation
identity and repeating Fresh-Context review.
"""

EXPECTED_ORCHESTRATOR_COMMIT = "c9577cd80db44d33de663bd077e26ee70de701c2"
EXPECTED_ORCHESTRATOR_BLOB_SHA1 = "0a2a06bfe08fc79b86fd41e7f040c70fb7208d9c"
EXPECTED_ORCHESTRATOR_NORMALIZED_SHA256 = "c36a627109c4bff6cec8243f4b1914008296940bff69ea65b233380d35ed1b88"

EXPECTED_OWNER_BOUNDARY_BLOB_SHA1 = "51fa9519f1f17185253e0220fdd8487b21a5d2ec"
EXPECTED_OWNER_BOUNDARY_NORMALIZED_SHA256 = "49a865b115b5c7512622315df392a5cfaebfd020dab768267a3d87e56d5325a5"
