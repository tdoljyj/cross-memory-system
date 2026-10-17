-- I9 classifies expired journals independently of an active account policy.
-- This does not infer an absent provider effect for legacy/non-job writers.
-- The existing candidate retains its I1/I2, directory-move/adopt exceptions,
-- immutable receipt, complete-scope isolation, verified-result and I12 gates.
create or replace function clued_private.storage_conflict_supported_v1(p_intent uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.resource_center_mutations_v1 m
  join clued_private.resource_center_profiles_v1 p on p.id=m.profile_id and p.user_id=m.user_id
  where m.id=p_intent and p.root_folder_id is not null and p.managed_root is not null)
$$;
revoke all on function clued_private.storage_conflict_supported_v1(uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- A same-parent rename has an immutable destination-parent identity. Recover
-- its source parent from that identity only when both exact paths have the
-- same parent; never infer a cross-parent move from current registration.
do $patch$
declare body text;anchor text;
begin
 body:=pg_get_functiondef('clued_private.storage_conflict_close_candidate_v1(uuid)'::regprocedure);
 anchor:=$a$  before:=m.authority_request->'provider_identity';$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
  raise exception 'storage_recovery_coverage_scope_source_mismatch';end if;
 execute replace(body,anchor,$r$  before:=m.authority_request->'provider_identity';
  if op='rename' and before->>'source_parent_id' is null
   and before->>'destination_parent_id' is not null
   and regexp_replace(m.exact_request->'mutation'->>'source_path','/[^/]+$','')=
       regexp_replace(m.exact_request->'mutation'->>'destination_path','/[^/]+$','') then
   before:=before||jsonb_build_object('source_parent_id',before->>'destination_parent_id');
  end if;$r$);
end $patch$;
