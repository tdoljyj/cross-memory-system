-- S2c ERRATA-004 (Owner Decision 82e4534a; S2c PR-2 review MINOR-7): in a ceiling-shaped value a
-- {resource_kind:'scope', resource_id:'project:*', environment:E, actions:X} entry also grants X on
-- every {resource_kind:'scope', resource_id:'project:<uuid>', environment:E} entry. Migration
-- 20261004210000 materializes project:* as one project:<uuid> entry per project, and adds one when
-- the Owner creates a project; without this rule that new entry reads as a scope expansion and the
-- Integration's own connection is refused (reauthorization_scope_expansion_forbidden).
--
-- Replaces only the two S2c PR-2 functions that compare ceiling-shaped values, with unchanged
-- signatures and privileges, and adds one helper. No object older than S2c is changed. A ceiling
-- without project:* is unaffected: a new project's entry is still an expansion.

-- The actions p_entries grants on one (kind, id, environment): the exact entry's actions, plus a
-- scope project:* entry's actions when the target is a scope project:<uuid> entry.
create function clued_private.integration_entry_actions_v1(p_entries jsonb, p_kind text, p_id text, p_environment text)
returns text[] language sql immutable security invoker set search_path='' as $$
  select coalesce(array_agg(distinct (x.a collate "C") order by (x.a collate "C")), '{}')
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(p_entries) = 'array' then p_entries
                                               else '[]'::jsonb end) c
    cross join lateral pg_catalog.jsonb_array_elements_text(c->'actions') as x(a)
   where c->>'resource_kind' = p_kind and c->>'environment' = p_environment
     and (c->>'resource_id' = p_id
          or (p_kind = 'scope' and c->>'resource_id' = 'project:*'
              and p_id ~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;

-- §10.3 covers(C, A) as amended by ERRATA-004.
create or replace function clued_private.integration_covers_v1(p_ceiling jsonb, p_authority jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_entry jsonb;
begin
  if p_ceiling is null or p_authority is null then return false; end if;
  if not ((p_authority->'scopes') <@ (p_ceiling->'scopes')) then return false; end if;
  if p_ceiling->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then return true; end if;
  if p_authority->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then return false; end if;
  for v_entry in select e from pg_catalog.jsonb_array_elements(p_authority->'entries') e loop
    if not (array(select pg_catalog.jsonb_array_elements_text(v_entry->'actions'))
            <@ clued_private.integration_entry_actions_v1(p_ceiling->'entries', v_entry->>'resource_kind',
                 v_entry->>'resource_id', v_entry->>'environment')) then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- C ∩ A as amended by ERRATA-004: for every (kind, id, environment) named on either side, the
-- actions both sides grant, each side counting its project:* entry for a project:<uuid> target.
create or replace function clued_private.integration_ceiling_intersect_v1(p_left jsonb, p_right jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_scopes jsonb; v_entries jsonb;
begin
  v_scopes := (select coalesce(pg_catalog.jsonb_agg(s order by s collate "C"), '[]'::jsonb)
                 from (select pg_catalog.jsonb_array_elements_text(p_left->'scopes') s
                       intersect select pg_catalog.jsonb_array_elements_text(p_right->'scopes')) t);
  if p_left->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then
    v_entries := p_right->'entries';
  elsif p_right->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then
    v_entries := p_left->'entries';
  else
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('resource_kind', k, 'resource_id', r,
             'environment', env, 'actions', pg_catalog.to_jsonb(acts))
             order by k collate "C", r collate "C", env collate "C"), '[]'::jsonb)
      into v_entries
      from (select keys.k, keys.r, keys.env,
                   array(select s.z from (
                           select x as z from pg_catalog.unnest(
                             clued_private.integration_entry_actions_v1(p_left->'entries', keys.k, keys.r, keys.env)) x
                           intersect
                           select y from pg_catalog.unnest(
                             clued_private.integration_entry_actions_v1(p_right->'entries', keys.k, keys.r, keys.env)) y) s
                         order by s.z collate "C") acts
              from (select e->>'resource_kind' k, e->>'resource_id' r, e->>'environment' env
                      from pg_catalog.jsonb_array_elements(p_left->'entries') e
                    union
                    select e->>'resource_kind', e->>'resource_id', e->>'environment'
                      from pg_catalog.jsonb_array_elements(p_right->'entries') e) keys) t
     where pg_catalog.cardinality(acts) > 0;
  end if;
  return pg_catalog.jsonb_build_object('scopes', v_scopes, 'entries', v_entries);
end $$;

revoke all on function clued_private.integration_entry_actions_v1(jsonb, text, text, text)
  from public, anon, authenticated, service_role;
