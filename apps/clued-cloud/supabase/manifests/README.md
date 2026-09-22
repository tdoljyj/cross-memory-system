# One-time migration manifests

Files in this directory are immutable deployment inputs and audit artifacts. They are not Canonical Records, Current State, Tasks, Decisions, or permission grants.

`20260923_owner_approved_legacy_continuity.json` freezes the exact legacy Event/Carrier and active Record release set accepted by `20260923193000_context_v2_approved_legacy_continuity_once.sql`. Production execution additionally requires a user-explicit Canonical Decision whose Event and Receipt bind the database-computed manifest digest. The authenticated Clued service remains the only online Canonical Store.
