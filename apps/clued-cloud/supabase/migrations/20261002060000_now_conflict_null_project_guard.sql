-- BUG-20261002-001. record_mutation_core checks for another active "now" task
-- before it writes a project-scope task with execution_bucket=now. That count
-- calls m1_effective_project(p_user_id,m.project_id) on every active "now" task
-- of the user, including Global and profile tasks whose project_id is null, and
-- m1_effective_project raises project_redirect_cycle on a null id. So while the
-- user had any active Global "now" task, every create or update of a project
-- "now" task failed with project_redirect_cycle; notes never ran the check.
--
-- Both the create and the update branch now skip rows without a project_id
-- before resolving the effective project. CASE, not AND, because Postgres does
-- not promise to evaluate AND operands left to right. A null-project row can
-- never be in the writer's effective project, so the count is unchanged for
-- every row that did not raise before. Global-scope writes keep comparing
-- canonical_scope, as before.

do $migration$
declare body text;
  anchor text:='clued_private.m1_effective_project(p_user_id,m.project_id)=v_effective_project';
  replacement text:='case when m.project_id is null then false else clued_private.m1_effective_project(p_user_id,m.project_id)=v_effective_project end';
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>2
    or strpos(body,replacement)>0
    then raise exception 'now_conflict_null_project_definition_mismatch'; end if;
  execute replace(body,anchor,replacement);
end $migration$;
