-- MTPE read-set coverage authorization (mtpe-read-set-coverage.v1).
--
-- clued_mtpe_snapshot / clued_mtpe_validate previously required the literal
-- '*' context key. OAuth consent never issues '*', so every consent-created
-- Binding was refused even when it explicitly covered every source the
-- operation reads. The rule is now: the Binding's effective read scopes must
-- cover the exact Canonical source-scope set this operation reads.
--
-- * '*' Bindings keep their meaning and are not widened or narrowed here.
-- * Coverage is exact string membership against binding_read_scopes_v2, which
--   already honours per-entry OAuth actions, revocation and expiry. A scope
--   kind the rule does not know is never special-cased, so it fails closed.
-- * A source row without a canonical scope can only be covered by '*'.
-- * The read set and the result are computed in one statement. Both are STABLE
--   SQL functions, so they share that statement's snapshot: a Project created
--   concurrently is either in both or in neither.
-- * The returned candidate scopes are rechecked against the grant as a second,
--   per-record layer, so a future divergence between the read-set description
--   and the snapshot body denies instead of disclosing.
-- * Denial is a structured tool result (status=denied, error.code
--   INSUFFICIENT_CONTEXT_COVERAGE), not an HTTP-level authorization failure, so
--   MCP hosts do not ask the user to reconnect for a coverage gap. Missing keys
--   are the caller's own scopes; the snapshot never reads another user's rows.
-- * Inputs are never filtered to the grant: a partial universe would yield a
--   different ranking than the Global Frontier, so an uncovered source denies.
--
-- Unchanged: clued_mtpe_owner_pin (per-record write scope), write scopes,
-- projection builders, and the semantics of '*'.

create or replace function clued_private.mtpe_read_set_v1(p_user_id uuid,p_operation text)
returns jsonb language sql stable security definer set search_path='' as $$
  with projection_rows as (
    select p.record_id,p.canonical_scope from clued_private.mtpe_intake_projection p
    where p.user_id=p_user_id
  ), terminal_rows as (
    select a.id,a.lifecycle_status,a.merged_into_record_id from public.clued_memories a
    where p_operation='validate' and a.user_id=p_user_id and a.record_schema_version=1
      and a.lifecycle_status in ('superseded','merged')
  ), sources as (
    -- Both operations scan every projection row of the user.
    select canonical_scope scope from projection_rows
    union all
    -- The snapshot joins each projection row to its Canonical Record.
    select m.canonical_scope from projection_rows p
      join public.clued_memories m on m.id=p.record_id and m.user_id=p_user_id
    union all
    -- The Owner focus row names one record.
    select m.canonical_scope from clued_private.mtpe_owner_focus f
      join public.clued_memories m on m.id=f.record_id and m.user_id=f.user_id
    where f.user_id=p_user_id
    union all
    -- Validation scans every schema-v1 Canonical Record of the user.
    select m.canonical_scope from public.clued_memories m
    where p_operation='validate' and m.user_id=p_user_id and m.record_schema_version=1
    union all
    -- Validation's successor checks read matched successors of any schema.
    select s.canonical_scope from terminal_rows a
      join public.clued_memories s on s.user_id=p_user_id and s.id<>a.id
    where (a.lifecycle_status='superseded' and (s.supersedes_id=a.id or exists(
        select 1 from jsonb_array_elements_text(case
          when jsonb_typeof(s.relations->'supersedes')='array'
            then s.relations->'supersedes' else '[]'::jsonb end) source(id)
        where source.id=a.id::text)))
      or (a.lifecycle_status='merged' and s.id=a.merged_into_record_id)
  )
  select jsonb_build_object(
    'scopes',coalesce((select jsonb_agg(distinct scope order by scope)
      from sources where scope is not null),'[]'::jsonb),
    'unscoped_sources',(select count(*) from sources where scope is null))
$$;

-- Returns null when p_granted covers every required scope, else the denial
-- envelope. p_granted null means an unrestricted ('*') Binding.
create or replace function clued_private.mtpe_read_coverage_denial_v1(
  p_granted text[],p_read_set jsonb,p_returned_scopes jsonb
) returns jsonb language sql immutable set search_path='' as $$
  with required as (
    select value #>> '{}' scope from jsonb_array_elements(coalesce(p_read_set->'scopes','[]'::jsonb))
    union all
    select value #>> '{}' from jsonb_array_elements(coalesce(p_returned_scopes,'[]'::jsonb))
  ), missing as (
    select scope from required where scope is null or not (scope=any(p_granted))
  ), counts as (
    select coalesce((select jsonb_agg(distinct scope order by scope) from missing
        where scope is not null),'[]'::jsonb) missing_keys,
      coalesce((p_read_set->>'unscoped_sources')::bigint,0)
        +(select count(*) from missing where scope is null) unscoped
  )
  select case
    when p_granted is null then null
    when jsonb_array_length(missing_keys)=0 and unscoped=0 then null
    else jsonb_build_object('status','denied','rule','mtpe-read-set-coverage.v1',
      'error',jsonb_build_object('code','INSUFFICIENT_CONTEXT_COVERAGE',
        'message','This connection is not authorized to read every Canonical source scope this operation reads. Grant read access to the missing scopes.',
        'missing_context_keys',missing_keys,'unscoped_sources',unscoped))
  end from counts
$$;

create or replace function public.clued_mcp_mtpe_snapshot(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype; v_granted text[];
  v_result jsonb; v_read_set jsonb; v_denial jsonb;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  v_granted:=clued_private.binding_read_scopes_v2(b.user_id,b.id);
  -- One statement: the read set and the snapshot share one database snapshot.
  select clued_private.mtpe_snapshot(b.user_id),clued_private.mtpe_read_set_v1(b.user_id,'snapshot')
    into v_result,v_read_set;
  v_denial:=clued_private.mtpe_read_coverage_denial_v1(v_granted,v_read_set,
    (select coalesce(jsonb_agg(c->'scope'),'[]'::jsonb)
      from jsonb_array_elements(coalesce(v_result->'candidate_universe','[]'::jsonb)) c));
  if v_denial is not null then return v_denial; end if;
  return v_result;
end $$;

create or replace function public.clued_mcp_mtpe_validate(
  p_token_hash text,p_input jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings%rowtype; v_granted text[];
  v_result jsonb; v_read_set jsonb; v_denial jsonb;
begin
  b:=clued_private.resolve_binding(p_token_hash,'context:read','global');
  v_granted:=clued_private.binding_read_scopes_v2(b.user_id,b.id);
  select clued_private.mtpe_validation(b.user_id),clued_private.mtpe_read_set_v1(b.user_id,'validate')
    into v_result,v_read_set;
  v_denial:=clued_private.mtpe_read_coverage_denial_v1(v_granted,v_read_set,'[]'::jsonb);
  if v_denial is not null then return v_denial; end if;
  return v_result;
end $$;

revoke all on function clued_private.mtpe_read_set_v1(uuid,text),
  clued_private.mtpe_read_coverage_denial_v1(text[],jsonb,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_mcp_mtpe_snapshot(text,jsonb),
  public.clued_mcp_mtpe_validate(text,jsonb) from public,authenticated;
grant execute on function public.clued_mcp_mtpe_snapshot(text,jsonb),
  public.clued_mcp_mtpe_validate(text,jsonb) to anon;
