# Root9 Stage2C / M5 minimal hotfix package

This package is a minimal byte correction over the 30-path Stage2C artifact set merged in M4 at `dcc9fd1fa47ef9d04af3f53244a240e60ae390c3`. It replaces only the sealed apply bytes and the artifacts whose hashes or verification claims depend on those bytes. The corrected apply SHA-256 is `f3f58366a06411d9578a29baf226543760027d0bfef3b33261b08161d394eeb1`; it supersedes `bf180ec5e01e93f9103db5363ecee8a14ae06a4d5d73f2e9068b96a3da4f9dac`.

The incident record is derived from external post-M4 operational evidence with SHA-256 `9f1ecdcbb706f7bf3b0a34a7c8fb271e732acda7eeddeb10076fd4f5bc30f644`. It proves the first attempt failed with SQLSTATE `22P02` and the transaction explicitly rolled back to the exact Root8/sequence97 preimage with zero committed writes and the unique budget untouched. That evidence was not part of the M4 artifact set and is not evidence that the corrected SQL has been executed.

This carrier performs no database connection, CAS execution, budget reservation, capacity change, refund, attempt creation, or GA dispatch. M5 publication is not live-apply authority; fresh final-byte preflight and explicit one-shot authorization remain external gates.
