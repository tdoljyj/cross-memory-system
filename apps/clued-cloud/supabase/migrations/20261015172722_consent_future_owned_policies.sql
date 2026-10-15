-- Task d5dee826-27d7-452b-8948-48fe8ae8a961. Future-policy plan SHA256
-- 7f54fb5f952c8a0f886d362adb5f1be6753c995e4d6067b57cd45fe4e6ab8f86.
-- Future-only consent sources do not backfill current resources. The existing
-- contexts:* / project:* meanings, issuer proof wrappers, public OIDs and ACLs
-- remain intact. Only INSERT hooks may add future-source contributions.

alter table clued_private.authorization_sources_v2
  drop constraint authorization_sources_v2_kind_check;
alter table clued_private.authorization_sources_v2
  add constraint authorization_sources_v2_kind_check check(kind in (
    'legacy_effective_baseline','direct','legacy_project_policy','contexts_policy',
    'future_owned_project_policy','future_owned_context_policy'));

create function clued_private.authorization_future_owned_policy_v1(p_kind text,p_id text,p_env text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_kind='scope' and p_env='canonical'
    and p_id in ('owned-project-records:future','owned-project-contexts:future'),false)
$$;

create or replace function clued_private.authorization_eligible_v12(p_owner uuid,p_scopes text[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select clued_private.authorization_resources_v2(p_owner,p_scopes)
 || coalesce((select jsonb_agg(x||jsonb_build_object('ownership','membership','project_id',c.project_id,
       'project_name',p.name,'context_name',c.name))
   from jsonb_array_elements(clued_private.authorization_eligible_before_contexts_v2(p_owner,p_scopes)) x
   join clued_private.development_spaces_v14 c on c.id::text=x->>'resource_id'
   join public.clued_projects p on p.id=c.project_id where x->>'qualification_id' is not null),'[]')
 || case when clued_private.authorization_serialization_ready_v2() then jsonb_build_array(jsonb_build_object(
      'resource_kind','scope','resource_id','contexts:*','environment','canonical','name','全部上下文（含以后新建的）',
      'ownership','self','actions',to_jsonb(clued_private.authorization_actions_v2(
        array['read','write','close','restore','audit','feedback_submit'],p_scopes,'policy')))) else '[]'::jsonb end
 || coalesce((select jsonb_agg(x) from jsonb_array_elements(
      clued_private.authorization_eligible_before_contexts_v2(p_owner,p_scopes)) x where x->>'resource_id'='project:*'),'[]')
 -- Both structural capability rows are advertised even if one has no requested
 -- actions (for example, Contexts in an audit-only request). Empty selections
 -- remain forbidden by the existing approval validator.
 || case when clued_private.authorization_serialization_ready_v2() then jsonb_build_array(
   jsonb_build_object('resource_kind','scope','resource_id','owned-project-records:future','environment','canonical',
     'name','未来自有项目的正式记录','ownership','self',
     'actions',to_jsonb(clued_private.authorization_actions_v2(
       array['read','write','close','restore','audit'],p_scopes,'scope'))),
   jsonb_build_object('resource_kind','scope','resource_id','owned-project-contexts:future','environment','canonical',
     'name','未来新建的自有项目上下文','ownership','self',
     'actions',to_jsonb(clued_private.authorization_actions_v2(
       array['read','write','close','feedback_submit'],p_scopes,'context')))) else '[]'::jsonb end
$$;

-- Exact anchor/count assertions fail closed against an unexpected predecessor.
-- CREATE OR REPLACE preserves the existing function identity and caller ACLs.
create function clued_private.authorization_consent_patch_v1(p_signature text,p_anchor text,p_replacement text,p_count integer default 1)
returns void language plpgsql set search_path='' as $$
declare definition text:=pg_get_functiondef(p_signature::regprocedure);
begin
 if p_anchor='' or (length(definition)-length(replace(definition,p_anchor,'')))/length(p_anchor)<>p_count then
   raise exception 'consent_future_patch_anchor_changed: %',p_signature; end if;
 execute replace(definition,p_anchor,p_replacement);
end $$;

select clued_private.authorization_consent_patch_v1('clued_private.authorization_owner_resource_v12(uuid,text,text,text)',
 $a$if p_kind='scope' and p_id='contexts:*' and p_environment='canonical' then$a$,
 $a$if clued_private.authorization_future_owned_policy_v1(p_kind,p_id,p_environment) then
    if not clued_private.authorization_serialization_ready_v2() then raise exception 'all_contexts_serialization_not_ready' using errcode='42501'; end if;
    return;
  end if;
  if p_kind='scope' and p_id='contexts:*' and p_environment='canonical' then$a$);

select clued_private.authorization_consent_patch_v1('clued_private.authorization_add_selection_v2(uuid,jsonb,uuid,text)',
 $a$if item->>'resource_id'='contexts:*' then$a$,
 $a$if clued_private.authorization_future_owned_policy_v1(item->>'resource_kind',item->>'resource_id',item->>'environment') then
      if not clued_private.authorization_serialization_ready_v2() then raise exception 'all_contexts_serialization_not_ready' using errcode='42501'; end if;
      update clued_private.authorization_source_bindings_v2 set source_protocol=true where binding_id=p_binding;
      -- Always a fresh consent identity. No in-place widening/renewal and no
      -- connection.permission parser extension can refill old exact omissions.
      insert into clued_private.authorization_sources_v2(binding_id,owner_id,kind,actions,scope_ceiling,expires_at,receipt_id,consent_ref)
        values(p_binding,b.user_id,case item->>'resource_id' when 'owned-project-records:future'
          then 'future_owned_project_policy' else 'future_owned_context_policy' end,
          acts,b.scopes,a.expires_at,p_receipt,p_ref) returning id into sid;
      insert into clued_private.authorization_contributions_v2
        values(sid,'scope',item->>'resource_id','canonical',null,acts);
      -- Intentionally no authorization_resources_v2 scan here.
    elsif item->>'resource_id'='contexts:*' then$a$);

-- Treat both new markers exactly as policies for observation and projection,
-- never as directly executable resource scopes or precise-limit targets.
do $policies$
declare signature text;
begin
 foreach signature in array array[
   'clued_private.authorization_effective_no_lock_v2(uuid,text,text,text)',
   'clued_private.authorization_project_resource_v2(uuid,text,text,text)',
   'clued_private.authorization_assert_entry_v12(uuid,text,text,text,text)',
   'clued_private.authorization_live_selection_v2(uuid)',
   'clued_private.authorization_precise_view_v2(uuid,jsonb)'] loop
   perform clued_private.authorization_consent_patch_v1(signature,
     $a$('contexts:*','project:*')$a$,
     $a$('contexts:*','project:*','owned-project-records:future','owned-project-contexts:future')$a$);
 end loop;
 foreach signature in array array[
   'clued_private.authorization_current_projection_v2(uuid)',
   'clued_private.authorization_precise_capability_v2(uuid,text,text,text)',
   'clued_private.authorization_reduce_sources_v2(uuid,uuid,jsonb,uuid)'] loop
   perform clued_private.authorization_consent_patch_v1(signature,
     $a$('project:*','contexts:*')$a$,
     $a$('project:*','contexts:*','owned-project-records:future','owned-project-contexts:future')$a$);
 end loop;
end $policies$;

select clued_private.authorization_consent_patch_v1('clued_private.authorization_resource_metadata_v2(uuid,text,text,text,uuid)',
 $a$('global','profile','project:*','contexts:*')$a$,
 $a$('global','profile','project:*','contexts:*','owned-project-records:future','owned-project-contexts:future')$a$);
select clued_private.authorization_consent_patch_v1('clued_private.authorization_resource_metadata_v2(uuid,text,text,text,uuid)',
 $a$else '全部上下文（含以后新建的）' end$a$,
 $a$when 'owned-project-records:future' then '未来自有项目的正式记录'
        when 'owned-project-contexts:future' then '未来新建的自有项目上下文'
        else '全部上下文（含以后新建的）' end$a$);

do $coarse_keys$
declare signature text;
begin
 foreach signature in array array[
   'clued_private.authorization_project_resource_v2(uuid,text,text,text)',
   'clued_private.authorization_rebuild_projection_v2(uuid)'] loop
   perform clued_private.authorization_consent_patch_v1(signature,
     $a$source_row.kind='contexts_policy'$a$,
     $a$source_row.kind in ('contexts_policy','future_owned_project_policy','future_owned_context_policy')$a$);
 end loop;
end $coarse_keys$;

select clued_private.authorization_consent_patch_v1('clued_private.authorization_writer_lock_fanout_v2(uuid,uuid[])',
 $a$('project:*','contexts:*')$a$,
 $a$('project:*','contexts:*','owned-project-records:future','owned-project-contexts:future')$a$);
select clued_private.authorization_consent_patch_v1('clued_private.authorization_writer_lock_fanout_v2(uuid,uuid[])',
 $a$('legacy_project_policy','contexts_policy')$a$,
 $a$('legacy_project_policy','contexts_policy','future_owned_project_policy','future_owned_context_policy')$a$);

-- Only called by the two real INSERT triggers below. General materialization
-- intentionally remains unaware of future source kinds; it cannot backfill or
-- expand their historical per-resource contribution membership/action masks.
create function clued_private.authorization_future_owned_insert_v1(p_binding uuid,p_kind text,p_id text,p_env text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; source_row record; c clued_private.development_spaces_v14;
begin
 select * into b from public.clued_agent_bindings where id=p_binding;
 perform clued_private.authorization_writer_require_v2(b.user_id);
 select * into b from public.clued_agent_bindings where id=p_binding for update;
 select * into a from clued_private.authorizations_v12 where binding_id=p_binding for update;
 if not found or b.revoked_at is not null or a.revoked_at is not null or a.expires_at<=clock_timestamp()
   or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp() then return; end if;
 if p_kind='context' then
   select * into c from clued_private.development_spaces_v14 where id::text=p_id and environment=p_env and owner_id=b.user_id;
   if not found or not exists(select 1 from public.clued_projects p where p.id=c.project_id and p.user_id=b.user_id) then return; end if;
 elsif p_kind<>'scope' or p_env<>'canonical' or not exists(select 1 from public.clued_projects p
   where 'project:'||p.id=p_id and p.user_id=b.user_id) then return; end if;
 for source_row in select s.id,clued_private.authorization_actions_v2(s.actions,s.scope_ceiling,p_kind) acts
   from clued_private.authorization_sources_v2 s where s.binding_id=p_binding and s.owner_id=b.user_id
     and s.kind=case p_kind when 'context' then 'future_owned_context_policy' else 'future_owned_project_policy' end
     and s.revoked_at is null and s.expires_at>clock_timestamp() order by s.id loop
   if cardinality(source_row.acts)>0 then
     insert into clued_private.authorization_contributions_v2
       values(source_row.id,p_kind,p_id,p_env,null,source_row.acts) on conflict do nothing;
   end if;
 end loop;
end $$;

select clued_private.authorization_consent_patch_v1('clued_private.authorization_future_project_v2()',
 $a$('project:*','contexts:*')$a$,
 $a$('project:*','contexts:*','owned-project-records:future')$a$);
select clued_private.authorization_consent_patch_v1('clued_private.authorization_future_project_v2()',
 $a$perform clued_private.authorization_project_resource_v2(bid,'scope','project:'||new.id,'canonical');$a$,
 $a$perform clued_private.authorization_future_owned_insert_v1(bid,'scope','project:'||new.id,'canonical');
    perform clued_private.authorization_project_resource_v2(bid,'scope','project:'||new.id,'canonical');$a$);
select clued_private.authorization_consent_patch_v1('clued_private.authorization_future_context_v2()',
 $a$s.kind='contexts_policy'$a$,
 $a$s.kind in ('contexts_policy','future_owned_context_policy')$a$);
select clued_private.authorization_consent_patch_v1('clued_private.authorization_future_context_v2()',
 $a$for bid in select s.binding_id from clued_private.authorization_sources_v2 s$a$,
 $a$for bid in select distinct s.binding_id from clued_private.authorization_sources_v2 s$a$);
select clued_private.authorization_consent_patch_v1('clued_private.authorization_future_context_v2()',
 $a$perform clued_private.authorization_project_resource_v2(bid,'context',new.id::text,new.environment);$a$,
 $a$perform clued_private.authorization_future_owned_insert_v1(bid,'context',new.id::text,new.environment);
    perform clued_private.authorization_project_resource_v2(bid,'context',new.id::text,new.environment);$a$);

-- Refresh pending snapshots under the same Owner mutex as resource INSERTs.
-- The public proof wrapper is unchanged; only its existing identity body changes.
select clued_private.authorization_consent_patch_v1('clued_private.ii_pub_clued_authorization_prepare_v12(text,jsonb)',
 $a$eligible:=clued_private.authorization_eligible_v12(u,scopes);$a$,
 $a$perform clued_private.authorization_writer_guard_v2(u);
  eligible:=clued_private.authorization_eligible_v12(u,scopes);$a$);
select clued_private.authorization_consent_patch_v1('clued_private.ii_pub_clued_authorization_prepare_v12(text,jsonb)',
 $a$and request_digest=p_request->>'request_digest' for share;$a$,
 $a$and request_digest=p_request->>'request_digest' for update;$a$);
select clued_private.authorization_consent_patch_v1('clued_private.ii_pub_clued_authorization_prepare_v12(text,jsonb)',
 $a$return jsonb_build_object('request_id',r.id,'version',r.version,'eligible',r.eligible);$a$,
 $a$if r.eligible is distinct from eligible then
    update clued_private.authorization_requests_v12 set eligible=clued_private.authorization_eligible_v12(u,scopes),
      version=version+1 where id=r.id returning * into r;
  end if;
  return jsonb_build_object('request_id',r.id,'version',r.version,'eligible',r.eligible);$a$);

-- New future-tree consent requires the complete displayed topology/action
-- snapshot. Legacy macros retain their existing live expansion compatibility.
-- Approved replay returns through its existing branch before this pending check.
select clued_private.authorization_consent_patch_v1('clued_private.ii_pub_clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)',
 $a$perform clued_private.authorization_validate_selection_v12(p_selected,r.eligible);$a$,
 $a$if exists(select 1 from jsonb_array_elements(p_selected) as submitted_future(value) where
      clued_private.authorization_future_owned_policy_v1(submitted_future.value->>'resource_kind',submitted_future.value->>'resource_id',submitted_future.value->>'environment'))
    and r.eligible is distinct from clued_private.authorization_eligible_v12(u,r.requested_scopes) then
    raise exception 'authorization_request_resources_changed' using errcode='40001';
  end if;
  perform clued_private.authorization_validate_selection_v12(p_selected,r.eligible);$a$);

drop function clued_private.authorization_consent_patch_v1(text,text,text,integer);
revoke all on function clued_private.authorization_future_owned_policy_v1(text,text,text),
  clued_private.authorization_future_owned_insert_v1(uuid,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;
notify pgrst,'reload schema';
