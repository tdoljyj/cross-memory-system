-- Revoke the two 2026-08-29 OAuth audit Bindings (P0-4 step 7, first PR; Clued Task 9a4d6d2c, Owner Decisions
-- 096df8b8, 5f60b7ba and 29bff239; development/contracts/database-access/DatabaseCallerAuthentication.v0.1.md §4.6).
--
-- clued_private.authorization_assert_entry_v12 lets a Binding without a clued_private.authorizations_v12 row
-- through. Production has three live Bindings like that: these two read-only audit Bindings ("Clued A03
-- read-only audit", context:read on system:projects, last used 2026-08-29) and the Projection Builder. The
-- audit is over and nothing uses them, so they are revoked here; the Projection Builder stays. Closing the
-- fallback itself is the second PR.
--
-- Only a row that still matches what was checked on 2026-10-09 is revoked: same id, vendor and name, live,
-- and still without a v12 authorization. Each revocation is recorded in clued_private.authorization_audit_v12.
-- A database without these rows, or a second run, changes nothing.

with revoked as (
  update public.clued_agent_bindings b
     set revoked_at = pg_catalog.clock_timestamp()
   where b.id in ('c0cc5abf-68f5-4a97-9a14-ab9379c854c0'::uuid, 'b3603c56-0649-47ca-91e3-d1e8e06588c4'::uuid)
     and b.vendor = 'OAuth'
     and b.agent_name in ('Clued A03 read-only audit', 'Clued A03 read-only audit (port 6400)')
     and b.revoked_at is null
     and not exists (select 1 from clued_private.authorizations_v12 a where a.binding_id = b.id)
  returning b.id, b.user_id, b.revoked_at
)
insert into clued_private.authorization_audit_v12(owner_id, binding_id, operation, selected)
select r.user_id, r.id, 'legacy_binding_revoke',
       jsonb_build_object('reason', 'P0-4 step 7: audit Binding without a v12 authorization, unused since 2026-08-29',
                          'decision', '29bff239-5bc1-4e4b-9429-b2f81eb0228c', 'revoked_at', r.revoked_at)
  from revoked r;
