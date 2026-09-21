-- Evidence has no independent work scope. A co-mentioned Record grants no
-- access unless its canonical source_refs actually contain that Evidence ID.
create or replace function clued_private.k_cont_visible_target_refs_v1(
  p_user_id uuid,p_binding_id uuid,p_context_key text,p_refs jsonb
) returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('kind',ref->>'kind','id',ref->>'id') ||
      case when ref ? 'role' then jsonb_build_object('role',ref->>'role') else '{}'::jsonb end
    order by ord),'[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_refs)='array'
    then p_refs else '[]'::jsonb end) with ordinality as refs(ref,ord)
  where jsonb_typeof(ref)='object'
    and jsonb_typeof(ref->'kind')='string'
    and jsonb_typeof(ref->'id')='string'
    and char_length(btrim(ref->>'id')) between 1 and 160
    and (not (ref ? 'role') or
      (jsonb_typeof(ref->'role')='string' and ref->>'role' in ('primary','source','target','evidence')))
    and case ref->>'kind'
      when 'record' then exists(
        select 1 from public.clued_memories m
        where m.user_id=p_user_id and m.id::text=lower(ref->>'id')
          and m.canonical_scope is not null
          and (m.canonical_scope=p_context_key or
            (p_binding_id is not null and exists(
              select 1 from public.clued_agent_bindings b
              where b.id=p_binding_id and b.user_id=p_user_id
                and ('*'=any(b.context_keys) or m.canonical_scope=any(b.context_keys))
                and (not exists(select 1 from clued_private.authorizations_v12 a
                     where a.binding_id=b.id)
                  or 'read'=any(clued_private.authorization_effective_actions_v13(
                    b.id,'scope',m.canonical_scope,'canonical'))))))
      )
      when 'project' then exists(
        select 1 from public.clued_projects p
        where p.user_id=p_user_id
          and (p.id::text=lower(ref->>'id') or p.context_key=lower(ref->>'id'))
          and (p.context_key=p_context_key or
            (p_binding_id is not null and exists(
              select 1 from public.clued_agent_bindings b
              where b.id=p_binding_id and b.user_id=p_user_id
                and ('*'=any(b.context_keys) or p.context_key=any(b.context_keys))
                and (not exists(select 1 from clued_private.authorizations_v12 a
                     where a.binding_id=b.id)
                  or 'read'=any(clued_private.authorization_effective_actions_v13(
                    b.id,'scope',p.context_key,'canonical'))))))
      )
      when 'evidence' then exists(
        select 1 from public.clued_evidence e
        join public.clued_memories m on m.user_id=e.user_id
          and m.record_schema_version is not null
          and m.canonical_scope=p_context_key
          and e.id=any(m.source_refs)
        join jsonb_array_elements(p_refs) r on jsonb_typeof(r)='object'
          and r->>'kind'='record' and jsonb_typeof(r->'id')='string'
          and m.id::text=lower(r->>'id')
        where e.user_id=p_user_id and e.id::text=lower(ref->>'id')
      )
      else false
    end;
$$;
revoke all on function clued_private.k_cont_visible_target_refs_v1(uuid,uuid,text,jsonb)
  from public,anon,authenticated;

notify pgrst,'reload schema';
