-- K-CONT successor delta. The prior resume renderer is already registered on
-- non-production clued-auth-test and remains immutable. Keep imported history
-- reachable through clued_read_log without embedding its unbounded body in
-- every session resume response.

create or replace function clued_private.render_resume_log(
  p_user_id uuid,
  p_context_key text,
  p_events jsonb,
  p_constraints jsonb,
  p_conflicts jsonb,
  p_event_page jsonb
)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_checkpoint public.clued_context_checkpoints%rowtype;
  v_version bigint:=0;
  v_events text:='';
  v_constraints text:='';
  v_conflicts text:='';
  v_imported_markdown text;
  v_imported_version bigint;
begin
  select s.version into v_version from public.clued_context_streams s
   where s.user_id=p_user_id and s.context_key=p_context_key;
  select c.* into v_checkpoint from public.clued_context_heads h
    join public.clued_context_checkpoints c on c.id=h.checkpoint_id
   where h.user_id=p_user_id and h.context_key=p_context_key;

  select coalesce(string_agg(format('- %s · %s · %s',
    coalesce(item->>'occurred_at','unknown-time'),
    coalesce(item->>'type','unknown-type'),
    item::text),E'\n' order by ord),'') into v_events
  from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) with ordinality page(item,ord);

  select coalesce(string_agg(format('- `%s` — %s [scope=%s]',
    item->>'id',coalesce(item->>'title','Untitled constraint'),coalesce(item->>'scope',p_context_key)),
    E'\n' order by ord),'') into v_constraints
  from jsonb_array_elements(coalesce(p_constraints,'[]'::jsonb)) with ordinality page(item,ord);

  select coalesce(string_agg(format('- `%s` — %s [%s]',
    item->>'id',coalesce(item->>'title','Untitled decision'),coalesce(item->>'reason','review_required')),
    E'\n' order by ord),'') into v_conflicts
  from jsonb_array_elements(coalesce(p_conflicts,'[]'::jsonb)) with ordinality page(item,ord);

  select l.markdown,l.version into v_imported_markdown,v_imported_version
  from public.clued_log_versions l
  where l.user_id=p_user_id and l.context_key=p_context_key
  order by l.version desc limit 1;

  return '# 日志' || E'\n\n'
    || '- Context: `'||p_context_key||'`' || E'\n'
    || '- Version: `'||coalesce(v_version,0)::text||'`' || E'\n'
    || '- Canonical store: `clued-cloud/supabase`' || E'\n\n'
    || '## Latest checkpoint' || E'\n\n'
    || coalesce(v_checkpoint.summary,'No checkpoint yet.') || E'\n\n'
    || '### Next action' || E'\n\n'
    || coalesce(v_checkpoint.next_action,'Create the first checkpoint.') || E'\n\n'
    || '### Checkpoint coverage' || E'\n\n'
    || coalesce(v_checkpoint.checkpoint_coverage,'{}'::jsonb)::text || E'\n\n'
    || '## Active constraints' || E'\n\n'
    || case when v_constraints='' then 'No active constraints in this authorized view.' else v_constraints end || E'\n\n'
    || '## Authority conflicts' || E'\n\n'
    || case when v_conflicts='' then 'No newer active Decisions.' else v_conflicts end || E'\n\n'
    || '## Events not yet absorbed by a checkpoint (current page)' || E'\n\n'
    || '- Page: `'||coalesce(p_event_page,'{}'::jsonb)::text||'`' || E'\n\n'
    || case when v_events='' then 'No pending events on this page.' else v_events end
    || case when coalesce((p_event_page->>'truncated')::boolean,false)
      then E'\n\n> More pending events remain. Resume with the returned next_cursor.'
      else '' end
    || case when v_imported_markdown is null then E'\n'
      else E'\n\n---\n\n## Imported historical baseline\n\n'
        || '> Historical evidence only. The live checkpoint, constraints and authority conflicts above control current work.'
        || E'\n\n- Imported baseline version: `'||v_imported_version::text||'`'
        || E'\n- Content: available through the explicit `clued_read_log` history surface; omitted from resume to preserve the response budget.'
        || E'\n' end;
end $$;

revoke all on function clued_private.render_resume_log(uuid,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;

notify pgrst,'reload schema';
