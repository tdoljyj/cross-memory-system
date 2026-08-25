# K1 Evidence Rebaseline — Portable Freeze

- Date: 2026-08-23
- Decision: `K1_REBASELINE_FROZEN`
- Historical decision preserved: K0 `NO_GO`
- Legacy evidence object: `951078fc173809547ed377bfe326c68b9e476ac9`
- Legacy evidence status: `UNAVAILABLE_ORPHAN_NOT_PORTABLE`

## Reason

The original K0 evidence SHA named an object that was never placed on a durable
remote ref and was omitted from the handover Bundle. A SHA without a reachable
object is not portable evidence. Requiring that object made later gates depend
on one workstation.

This rebaseline does not recreate, replace, or claim verification of the
missing bytes. It records the gap explicitly, anchors the historical K0 claim
to the reachable K1 freeze commit, and anchors the later K0 debt closure to its
reachable canonical commit.

The frozen `kernel-contract-v1.json` remains byte-for-byte unchanged. The
portable evidence disposition is issued as additive contract v1.1.

## Durable anchors

- Original K1 claim anchor: `9dbf5c50272fa987db8da2070eb7b56fe7a0f906`
- K0 debt-closure evidence: `e946408accac278c93d3e7dc3780daf59f91a23e`
- Tested K3 product commit: `567222dccd8f51b2314b460876a4de9812aa0c74`
- Aligned pre-rebaseline head: `138ce2295f17e67347f55f7cb47a2bad0e1f38a5`

## Portability invariant

Every gate completion must create all of the following in one operation:

1. committed receipt, report, transcripts, and secret-scan result;
2. an annotated durable Git tag;
3. a verified `git bundle --all` artifact and SHA-256 manifest;
4. a push followed by remote ancestry verification.

A later gate may depend only on commits listed under
`portable_evidence.required_commit_objects`; unavailable legacy identifiers
remain audit metadata and are never executable prerequisites.

The PostgreSQL permission-denial assertion uses stable SQLSTATE `42501` with
verbose diagnostics, so localized server messages cannot produce a false gate
failure.
