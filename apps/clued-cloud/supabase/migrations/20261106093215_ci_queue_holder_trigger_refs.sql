-- Explicit holder trigger_refs replace the whole list, including CI-added
-- merge refs. Omitting trigger_refs still retains the current list. Preserve
-- the existing renewal checks, lease extension and queue/journal triggers.
create or replace function clued_private.work_claim_ci_keep_merge_ref_v1(
  c clued_private.work_claims_v1,p_triggers text[])
returns text[] language plpgsql volatile security definer set search_path='' as $$
begin
  delete from clued_private.work_claim_ci_merge_refs_v1 k
    where k.claim_id=c.claim_id
      and not exists(select 1 from unnest(c.trigger_refs) t where lower(t)=k.merge_ref);
  return p_triggers;
end $$;

-- Cleanup follows an accepted holder renewal, so a rejected renewal cannot
-- discard the marker. CI rejoins temporarily drop refs without advancing the
-- lease version and must preserve their marker through that transaction.
create function clued_private.work_claim_ci_refs_cleanup_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  delete from clued_private.work_claim_ci_merge_refs_v1 k
    where k.claim_id=new.claim_id
      and not exists(select 1 from unnest(new.trigger_refs) t where lower(t)=k.merge_ref);
  return new;
end $$;
revoke all on function clued_private.work_claim_ci_refs_cleanup_v1() from public,anon,authenticated;
create trigger work_claim_ci_refs_cleanup_v1 after update of trigger_refs,lease_version
  on clued_private.work_claims_v1 for each row
  when (old.lease_version is distinct from new.lease_version)
  execute function clued_private.work_claim_ci_refs_cleanup_v1();
