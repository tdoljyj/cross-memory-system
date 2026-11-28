set local lock_timeout = '5s';

create index clued_audit_receipts_object_lookup_idx
  on public.clued_audit_receipts (user_id, object_id, operation, created_at desc);
