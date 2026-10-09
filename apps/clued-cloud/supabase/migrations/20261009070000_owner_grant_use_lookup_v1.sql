-- Owner Grant admission door: find the prior use by its receipt, through an
-- index (Task 2b2359da; Owner Decision 661f8c36).
--
-- clued_owner_grant_admission_door_v1 runs under the anon role's 3 s
-- statement timeout. Its first step, owner_grant_admission_use_v1
-- (20261005120000), looks for a live grant that already admitted the same
-- resources at this door: owner_grants_v1 joined to public.clued_audit_receipts
-- on the receipt's metadata. No index serves that join (the receipts' only
-- user index is (user_id, context_key, created_at), and nearly every receipt
-- is the one Owner's), so each call read the whole table, about 27,000 rows,
-- once per live repo.protected_change grant. Repeated in one backend it took
-- 10-30 ms, but a fresh PostgREST backend took 0.6-3.6 s, and the door
-- returned 500 code 57014 three times on 2026-10-08/09 (the admission check
-- then failed as transient). Receipts and grants only grow.
--
-- The receipts of a grant use carry door and resources in their metadata; a
-- partial expression index over just those receipts (a few hundred rows)
-- finds them directly, and the lookup now starts from the receipt and joins
-- the grant by id. Everything else in the function is as before.

create index clued_audit_receipts_owner_grant_use_idx
  on public.clued_audit_receipts (user_id, (metadata->>'door'), (metadata->'resources'))
  where operation='owner_grant_use' and object_type='owner_grant';

create or replace function clued_private.owner_grant_admission_use_v1(
  p_user_id uuid,p_binding_id uuid,p_action text,p_resources text[]
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g clued_private.owner_grants_v1%rowtype; v_receipt uuid; v_prior uuid; v_prior_grant uuid;
begin
  perform clued_private.owner_grant_lock_v1(p_user_id);
  -- A live grant that already admitted these exact resources at this door,
  -- found from its use receipt (clued_audit_receipts_owner_grant_use_idx).
  select x.id, r.id into v_prior_grant, v_prior
    from public.clued_audit_receipts r
    join clued_private.owner_grants_v1 x on x.id::text=r.object_id
    where r.user_id=p_user_id and r.operation='owner_grant_use' and r.object_type='owner_grant'
      and r.metadata->>'door'='ci-admission' and r.metadata->'resources'=to_jsonb(p_resources)
      and x.user_id=p_user_id and x.action=p_action and x.revoked_at is null
    order by x.granted_at desc limit 1;
  if v_prior_grant is not null then
    select * into g from clued_private.owner_grants_v1 where id=v_prior_grant;
    return jsonb_build_object('grant_id',g.id,'receipt_id',v_prior,'use',g.uses,'max_uses',g.max_uses,
      'expires_at',g.expires_at,'replayed',true);
  end if;
  select * into g from clued_private.owner_grants_v1 x
    where x.user_id=p_user_id and x.action=p_action and x.revoked_at is null
      and x.expires_at>clock_timestamp() and (x.max_uses is null or x.uses<x.max_uses)
      and cardinality(p_resources)>0 and x.resources @> p_resources
    order by x.expires_at,x.granted_at limit 1 for update;
  if not found then return null; end if;
  update clued_private.owner_grants_v1 set uses=uses+1 where id=g.id;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(p_user_id,p_binding_id,'global','owner_grant_use','owner_grant',g.id::text,g.uses+1,
    jsonb_build_object('receipt_kind','OWNER_GRANT_USED','grant_id',g.id,'action',p_action,
      'resources',to_jsonb(p_resources),'door','ci-admission','use',g.uses+1,'max_uses',g.max_uses))
  returning id into v_receipt;
  return jsonb_build_object('grant_id',g.id,'receipt_id',v_receipt,'use',g.uses+1,'max_uses',g.max_uses,
    'expires_at',g.expires_at,'replayed',false);
end $$;
