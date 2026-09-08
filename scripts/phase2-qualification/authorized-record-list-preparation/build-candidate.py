"""Build a local forward-SQL candidate from the existing exact core; no database call."""
import pathlib,hashlib,json
here=pathlib.Path(__file__).resolve().parent
repo=here.parents[2]
source=repo/'apps/clued-cloud/supabase/migrations/20260829100000_clued_legacy_log_alias_bridge.sql'
raw=source.read_bytes();text=raw.decode().replace('\r\n','\n')
start=text.index('create or replace function clued_private.record_list_core(')
end=text.index('end $$;',start)+len('end $$;')
core=text[start:end]
assert core.count('p_user_id uuid,p_input jsonb)')==1
core=core.replace('p_user_id uuid,p_input jsonb)','p_user_id uuid,p_input jsonb,p_authorized_scopes text[])',1)
old='where e.user_id=p_user_id\n        and ('
assert core.count(old)==1
core=core.replace(old,"where e.user_id=p_user_id\n        and (p_authorized_scopes is null or coalesce(e.event_scope,e.context_key)=any(p_authorized_scopes))\n        and (",1)
old='where r.user_id=p_user_id\n           and ('
assert core.count(old)==1
core=core.replace(old,"where r.user_id=p_user_id\n           and (p_authorized_scopes is null or exists (\n             select 1 from public.clued_memories authorized_source\n              where authorized_source.id=r.id and authorized_source.user_id=p_user_id\n                and coalesce(authorized_source.canonical_scope,case when authorized_source.project_id is not null then 'project:'||authorized_source.project_id::text else authorized_source.scope end)=any(p_authorized_scopes)\n           ))\n           and (",1)
tail="""

-- Existing owner-only direct call preserves its two-argument signature and semantics.
create or replace function clued_private.record_list_core(p_user_id uuid,p_input jsonb)
returns jsonb language sql security definer set search_path='' as $$
 select clued_private.record_list_core(p_user_id,p_input,null::text[])
$$;

-- Explicitly private overload: clients cannot supply or widen its trusted scopes.
revoke all on function clued_private.record_list_core(uuid,jsonb,text[]) from public,anon,authenticated,service_role;

create or replace function public.clued_record_list(p_token_hash text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; delegated boolean; authorized_scopes text[];
begin
 b:=clued_private.resolve_binding(p_token_hash,'context:read',case when p_input->>'level'='project' then 'project:'||(p_input->>'project_id') else 'global' end);
 select exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id) into delegated;
 if delegated then
  select coalesce(array_agg(distinct e.resource_id),'{}'::text[]) into authorized_scopes
  from clued_private.authorization_entries_v12 e
  where e.binding_id=b.id and e.resource_kind='scope' and e.environment='canonical' and 'read'=any(e.actions)
   and (e.resource_id in ('global','profile') or exists(select 1 from public.clued_projects p where 'project:'||p.id=e.resource_id and p.user_id=b.user_id));
 end if;
 -- NULL only for the already supported nondelegated path; an empty delegated set denies every source.
 return clued_private.record_list_core(b.user_id,p_input,authorized_scopes);
end $$;
-- CREATE OR REPLACE retains both existing function privilege sets; no public wire or table changes.
"""
sql='-- LOCAL FORWARD CANDIDATE: not deployed; no Canonical writes.\n'+core+tail
(here/'authorized-record-list.candidate.sql').write_bytes(sql.encode())
sources=[source,repo/'apps/clued-cloud/supabase/migrations/20260907173031_clued_connection_authorization_v12.sql']
binding={'state':'LOCAL_CANDIDATE_NOT_DEPLOYED','sources':[{'path':str(p.relative_to(repo)).replace('\\','/'),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sources], 'core_changes':['Private explicit trusted scopes argument','Event source-scope WHERE predicate before JSON projection/LIMIT','Record source-scope EXISTS predicate before JSON projection/LIMIT'],'public_changes':'Derive same existing permitted source scopes before invoking core; remove post-LIMIT JSON filtering','authority_semantics_changed':False,'sql_sha256':hashlib.sha256(sql.encode()).hexdigest()}
(here/'SourceBindings.json').write_bytes((json.dumps(binding,indent=2)+'\n').encode())
print(json.dumps({'sql_sha256':binding['sql_sha256'],'source_count':2}))
