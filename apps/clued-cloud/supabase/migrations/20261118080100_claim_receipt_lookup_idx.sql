-- The publisher wraps each file in a transaction. Build one index per
-- transaction so that writers on this table wait for this build only.
set local lock_timeout = '5s';

create index clued_audit_receipts_claim_activity_idx
  on public.clued_audit_receipts (user_id, object_id, operation, created_at desc)
  where operation in ('work_claim_lease_extend_by_ci', 'work_claim_queue_keepalive', 'work_claim_release');
