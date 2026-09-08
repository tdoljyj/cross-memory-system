# A04 actual source-byte preparation candidate

This isolated candidate implements the byte verification gap identified by `slice-a-capability-map/CapabilityMap.json` under SOURCE_INGEST. It does not connect to service ingestion or run Slice A before Entry. There is no network, filesystem reader, model, extraction, service mutation, candidate approval, Canonical store, Event or Receipt implementation here.

`prepareSourceBytes` accepts an explicit Buffer, source reference, independently supplied expected SHA-256 and size, and optional byte chunk bound. It verifies actual bytes, rejects malformed UTF-8, keeps BOM/newlines/Unicode unchanged, and returns contiguous half-open byte offsets with source and chunk hashes. Every returned chunk can reconstruct its exact source slice. Byte-identical sources retain distinct provenance; their identical content hashes support a later authorized dedup lookup but do not establish persistent deduplication.

The existing service contract at `apps/clued-cloud/worker/records.ts` exposes `clued_evidence_ingest` with `content_hash` and `size_bytes`; these exact metadata names are reused under `source`. The local chunk descriptors are preparation output, not a new protocol schema, signed object, Evidence ID or service wire format. A storage adapter must still bind the verified bytes to a legitimate `storage_ref` and existing authenticated ownership/ingest transaction after the original Gate requirements are satisfied. A caller-provided source reference is not an access grant. An expected digest supplied by the same untrusted content does not prove authenticity.

The 1 MiB input, 4–65,536 byte chunk and 4,096 chunk limits are conservative local implementation bounds only. They do not alter accepted Slice A limits, a Provider budget or the 2,048-token Context Pack requirement. `token_count` stays null. Nontext source formats need their own accepted decoder; this candidate rejects invalid UTF-8 rather than guessing.

Validation uses only synthetic in-memory bytes and checks exact reconstruction, multibyte boundaries, provenance, tamper/size/encoding rejection, resource bounds, deterministic duplicate content and empty input. No Gold answers are read, no session is ingested, and none of the 24 cases or 72 formal slots is executed. The remaining A04 acceptance/extraction/confirmation/storage chain remains gated.

Run the bounded local checks from the repository root:

```powershell
node --test scripts/phase2-qualification/source-byte-preparation/prepare-source.test.mjs
```
