-- Run once after restoring the production database from a backup or PITR
-- point, before any Agent works again (WorkClaimAdmission.v0.1 §4.4, Owner
-- Decision 2b23eb0c, Task 27b4f5e8 item 4).
--
-- A claim's fence is max(fence)+1 over this table, so a restored table hands
-- out again fences that were issued after the restore point. This script
-- 1. abandons every claim the restore brought back as live: its holder may
--    have moved on, and the claims issued after the restore point are gone;
-- 2. raises every fence by one million, so a new claim or takeover gets a
--    fence above any fence issued before the restore (fewer than a million
--    claims per Task between the backup and the restore).
-- It changes no other table and is safe to run once; running it twice only
-- raises the fences again.
begin;
update clued_private.work_claims_v1
   set status = 'RELEASED', released_outcome = 'abandoned',
       updated_at = pg_catalog.clock_timestamp()
 where status in ('ACTIVE', 'DRAINING');
update clued_private.work_claims_v1 set fence = fence + 1000000;
commit;
