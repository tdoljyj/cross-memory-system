-- Query selection restricts returned rows; it does not remove the Native
-- Owner's lawful access to a Task's registered governance source.
-- Only this Native reader changes. Shared fences, output scopes and gates stay.
do $migration$
declare
  target regprocedure := to_regprocedure('public.clued_imprint_read_v1(jsonb)');
  source_body text;
  definition text;
  expected_definition text;
  source_hash text;
  before_metadata jsonb;
  after_metadata jsonb;
  marker text;
  declaration_marker constant text := 'v_id uuid; v_scopes text[]; v_domains text[];';
  scopes_marker constant text := '  v_scopes:=clued_private.imprint_owner_scopes_v1(v_owner);';
  fence_marker constant text := 'clued_private.imprint_record_currentness_v1(v_owner,m,v_scopes) fence';
begin
  if target is null then raise exception 'imprint_query_owner_scope_reader_missing'; end if;
  select p.prosrc,pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'
    into source_body,definition,before_metadata from pg_proc p where p.oid=target;
  -- Normalize only CRLF for the source fingerprint; execute preserves every
  -- existing byte outside the three replacements, including existing endings.
  source_hash:=encode(sha256(convert_to(replace(source_body,E'\r\n',E'\n'),'UTF8')),'hex');
  if source_hash='ad5f12483f8d0fba1dab6f28703526c99c6343bfa06d954d4b0824addb703ff7' then
    return; -- Exact applied-body replay only; unfamiliar successors fail closed.
  end if;
  if source_hash<>'7982c7c2f571bb7af61646c753886d2d77513c951c87a7fa5fcbfd97e4660376' then
    raise exception 'imprint_query_owner_scope_source_changed';
  end if;
  foreach marker in array array[declaration_marker,scopes_marker,fence_marker] loop
    if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
      raise exception 'imprint_query_owner_scope_anchor_changed';
    end if;
  end loop;
  expected_definition:=replace(definition,declaration_marker,
    'v_id uuid; v_scopes text[]; v_owner_scopes text[]; v_domains text[];');
  expected_definition:=replace(expected_definition,scopes_marker,
    E'  v_owner_scopes:=clued_private.imprint_owner_scopes_v1(v_owner);\n  v_scopes:=v_owner_scopes;');
  expected_definition:=replace(expected_definition,fence_marker,
    'clued_private.imprint_record_currentness_v1(v_owner,m,v_owner_scopes) fence');
  execute expected_definition;
  select to_jsonb(p)-'prosrc' into after_metadata from pg_proc p where p.oid=target;
  if after_metadata is distinct from before_metadata
    or pg_get_functiondef(target) is distinct from expected_definition then
    raise exception 'imprint_query_owner_scope_metadata_or_definition_changed';
  end if;
end
$migration$;

notify pgrst,'reload schema';
