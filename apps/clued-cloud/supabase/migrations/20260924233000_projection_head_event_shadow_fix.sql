-- BUG-20260924-003: a successfully rebuilt projection record must not be
-- shadowed a second time by an active Event that is already part of the
-- projection source/currentness snapshot.
--
-- The projection branch below is fail-closed: the record must be a private
-- projection binding, the exact current head, at the resolved invalidation
-- revision, with matching binding/head/live source-vector digests. Only after
-- all of those checks pass do we return CURRENT. Ordinary State/Task/Decision
-- records still fall through to the active Event shadow rule unchanged.
create or replace function clued_private.record_currentness_fence_before_intent_v2(
  p_user_id uuid,p_record_id uuid,p_authorized_scopes text[]
) returns text language plpgsql stable security definer set search_path='' as $$
declare v_record public.clued_memories%rowtype; v_scope text; v_projection_key text;
  v_binding clued_private.projection_record_bindings%rowtype;
  v_invalidation clued_private.projection_invalidation_heads%rowtype;
  v_head clued_private.projection_heads%rowtype;
begin
  select * into v_record from public.clued_memories
    where user_id=p_user_id and id=p_record_id;
  if not found then return 'UNKNOWN'; end if;
  if v_record.record_type not in ('state','task','decision') then return 'CURRENT'; end if;
  if v_record.archived_at is not null or v_record.merged_into_record_id is not null or
     coalesce(v_record.lifecycle_status,'active')<>'active' or
     v_record.status in ('archived','superseded','revoked','cancelled','done') or
     exists(select 1 from public.clued_memories successor
       where successor.user_id=p_user_id and successor.supersedes_id=v_record.id) then
    return 'HISTORY';
  end if;
  v_scope:=coalesce(v_record.canonical_scope,
    case when v_record.project_id is null then 'global'
      else 'project:'||v_record.project_id::text end);
  if p_authorized_scopes is not null and not v_scope=any(p_authorized_scopes) then
    return 'NOT_AUTHORIZED';
  end if;
  if exists(select 1 from clued_private.legacy_event_project_impacts i
    join clued_private.event_truth_carriers c on c.event_id=i.event_id
    where i.user_id=p_user_id and i.project_scope=v_scope
      and c.carrier_state='LEGACY_UNBOUND' and c.visibility='work_log'
      and v_record.record_type=any(c.dimensions)) then
    return 'UNKNOWN';
  end if;
  select * into v_binding from clued_private.projection_record_bindings b
    where b.record_id=p_record_id and b.user_id=p_user_id;
  v_projection_key:=coalesce(nullif(v_record.type_fields->>'projection_key',''),
    v_binding.projection_key);
  if v_projection_key is not null then
    -- User-authored metadata cannot grant projection authority.
    if v_binding.record_id is null or v_binding.projection_key<>v_projection_key
      or v_binding.target_scope<>v_scope then return 'UNKNOWN'; end if;
    select * into v_invalidation from clued_private.projection_invalidation_heads h
      where h.user_id=p_user_id and h.target_scope=v_scope
        and h.projection_key=v_projection_key;
    if not found then return 'UNKNOWN'; end if;
    if v_invalidation.invalidation_revision>v_invalidation.resolved_through_revision
      then return 'STALE'; end if;
    select * into v_head from clued_private.projection_heads h
      where h.user_id=p_user_id and h.target_scope=v_scope
        and h.projection_key=v_projection_key;
    if not found or v_head.record_id is distinct from v_record.id or
      v_head.projection_generation is distinct from v_binding.projection_generation or
      v_head.source_vector_digest is distinct from v_binding.source_vector_digest or
      v_head.resolved_through_invalidation_revision is distinct from
        v_invalidation.invalidation_revision or
      v_binding.resolved_through_invalidation_revision is distinct from
        v_invalidation.invalidation_revision or
      v_head.source_vector_digest is distinct from
        clued_private.currentness_hash(clued_private.projection_source_snapshot(p_user_id))
    then return 'UNKNOWN'; end if;

    -- The exact current projection head already incorporates the live source
    -- vector, including active Event carriers. Reapplying the generic Event
    -- shadow below would make a successful rebuild unreadable forever.
    return 'CURRENT';
  end if;
  if exists(
    select 1 from clued_private.event_truth_carriers c
    where c.user_id=p_user_id and c.canonical_scope=v_scope
      and c.visibility='work_log'
      and (p_authorized_scopes is null or c.canonical_scope=any(p_authorized_scopes))
      and v_record.record_type=any(c.dimensions)
      and c.carrier_state in ('LEGACY_UNBOUND','ACTIVE_UNSTRUCTURED','ACTIVE_TYPED')
  ) then return 'SHADOWED_BY_ACTIVE_EVENT'; end if;
  return 'CURRENT';
end $$;

revoke all on function clued_private.record_currentness_fence_before_intent_v2(uuid,uuid,text[])
  from public,anon,authenticated,service_role;
