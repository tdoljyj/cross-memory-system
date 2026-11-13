-- work_claim_lease_key_issue_v1 and work_claim_terminal_ready_receipt_v1 (20261108204157)
-- look up a claim's terminal-readiness receipt on every claim and verify; without this
-- index that is a full scan of clued_audit_receipts and times out (2026-11-13 06:11Z).
create index if not exists clued_audit_receipts_work_claim_terminal_idx
  on public.clued_audit_receipts (user_id, object_id, created_at desc, id desc)
  where operation = 'work_claim_terminal_readiness';
