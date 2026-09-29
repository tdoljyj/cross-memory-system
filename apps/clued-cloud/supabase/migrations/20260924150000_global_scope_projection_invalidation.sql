-- Global-scope currentness changes invalidate both Global projections.
-- touch_currentness invalidated global.__aggregate__ only for non-global scopes, and
-- projection_registry_invalidate skips the global scope, so a global State/Task/
-- Decision mutation (or a global work_log Event / carrier transition) advanced the
-- global currentness head, which projection_source_snapshot hashes, without
-- enqueueing any rebuild. Both projections were then left with a source digest
-- mismatch and authoritative Global reads fell back to PROJECTION_REQUIRED.
-- The Frontier projection's own State record is global as well; its rebuild write
-- (identified by a projection_key) is excluded so a rebuild never invalidates itself.

create or replace function clued_private.touch_currentness(
  p_user_id uuid,p_scope text,p_kind text,p_source_id text,p_dimensions text[]
) returns void language plpgsql security definer set search_path='' as $$
declare v_source jsonb;
begin
  if p_user_id is null or p_scope is null or p_source_id is null then
    raise exception 'invalid_currentness_source' using errcode='22023';
  end if;
  if cardinality(p_dimensions)=0 then return; end if;
  v_source:=jsonb_build_object('kind',p_kind,'id',p_source_id,'scope',p_scope);
  insert into clued_private.scope_currentness_heads(
    user_id,canonical_scope,snapshot_revision,next_action_revision,
    authority_revision,lifecycle_revision,latest_source_ref)
  values(p_user_id,p_scope,1,
    case when p_dimensions && array['state','task','decision']::text[] then 1 else 0 end,
    case when 'decision'=any(p_dimensions) then 1 else 0 end,
    case when 'lifecycle'=any(p_dimensions) then 1 else 0 end,v_source)
  on conflict(user_id,canonical_scope) do update set
    snapshot_revision=clued_private.scope_currentness_heads.snapshot_revision+1,
    next_action_revision=clued_private.scope_currentness_heads.next_action_revision+
      case when p_dimensions && array['state','task','decision']::text[] then 1 else 0 end,
    authority_revision=clued_private.scope_currentness_heads.authority_revision+
      case when 'decision'=any(p_dimensions) then 1 else 0 end,
    lifecycle_revision=clued_private.scope_currentness_heads.lifecycle_revision+
      case when 'lifecycle'=any(p_dimensions) then 1 else 0 end,
    latest_source_ref=v_source,updated_at=now();
  if p_scope<>'global' then
    insert into clued_private.projection_invalidation_heads(
      user_id,target_scope,projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(p_user_id,'global','global.__aggregate__',1,v_source,now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=v_source,stale_since=coalesce(
        clued_private.projection_invalidation_heads.stale_since,now()),updated_at=now();
  elsif not (p_kind='record_mutation' and exists(select 1 from public.clued_memories m
      where m.user_id=p_user_id and m.id::text=p_source_id
        and m.type_fields ? 'projection_key')) then
    insert into clued_private.projection_invalidation_heads(
      user_id,target_scope,projection_key,invalidation_revision,latest_source_ref,stale_since)
    values(p_user_id,'global','global.priority_frontier',1,v_source,now()),
          (p_user_id,'global','global.__aggregate__',1,v_source,now())
    on conflict(user_id,target_scope,projection_key) do update set
      invalidation_revision=clued_private.projection_invalidation_heads.invalidation_revision+1,
      latest_source_ref=v_source,stale_since=coalesce(
        clued_private.projection_invalidation_heads.stale_since,now()),updated_at=now();
  end if;
end $$;
revoke all on function clued_private.touch_currentness(uuid,text,text,text,text[])
  from public,anon,authenticated,service_role;
