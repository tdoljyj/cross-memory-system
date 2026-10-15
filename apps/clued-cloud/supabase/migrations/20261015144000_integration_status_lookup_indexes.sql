-- Integration status reads the newest committed Receipt and the newest resume
-- after the connection was linked. These lookups must not scan every other
-- Binding's history. Query predicates, timestamps and tie behavior stay intact.
-- The session index includes ended sessions: a completed resume is still evidence.
--
-- The production publisher runs this file and its ledger row in one transaction,
-- so CREATE INDEX CONCURRENTLY is unavailable. Ordinary index creation can block
-- writes while building. Bound lock acquisition locally; build duration remains
-- subject to the publisher's existing caller timeout (setting statement_timeout
-- inside its already-running DO would not time this DDL). No Worker timeout or
-- ACL changes are made.
set local lock_timeout = '5s';

create index clued_audit_receipts_binding_committed_recent_idx
  on public.clued_audit_receipts (binding_id, created_at desc)
  where status = 'committed';

create index clued_continuity_sessions_binding_started_idx
  on public.clued_continuity_sessions (binding_id, started_at desc);
