-- Surface the existing M1 event envelope through the authenticated log view.
-- This changes projection only: ownership filters, mutation paths and grants stay
-- unchanged from unified_record_v2.
create or replace function clued_private.record_list_core(p_user_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_level text:=coalesce(p_input->>'level','global');
  v_type text:=coalesce(p_input->>'record_type','state');
  v_project_id uuid;
  v_effective_project_id uuid;
  v_limit integer:=least(greatest(coalesce((p_input->>'limit')::integer,100),1),200);
  v_rows jsonb;
begin
  if p_user_id is null then raise exception 'account_required' using errcode='28000'; end if;
  if v_level not in ('global','project') then raise exception 'invalid_record_level' using errcode='22023'; end if;
  if v_type not in ('note','state','task','decision','archive','log') then raise exception 'invalid_record_type' using errcode='22023'; end if;
  if v_level='project' then
    v_project_id:=(p_input->>'project_id')::uuid;
    select r.effective_project_id into v_effective_project_id
      from public.clued_project_resolution_v2 r
     where r.user_id=p_user_id and r.source_project_id=v_project_id;
    if v_effective_project_id is null then raise exception 'project_not_found' using errcode='P0002'; end if;
  end if;
  if v_type='log' then
    select coalesce(jsonb_agg(row_data order by event_id desc),'[]'::jsonb) into v_rows from (
      select e.id as event_id,jsonb_build_object(
        'id',e.id::text,'record_type','log','project_id',e.project_id,'record_id',e.record_id,
        'record_version',e.record_version,'event_type',e.event_type,'payload',e.payload,
        'event_schema_version',e.event_schema_version,
        'committed_canonical_version',e.committed_canonical_version,
        'canonical_event_type',e.canonical_event_type,
        'target_refs',e.target_refs,'event_scope',e.event_scope,'origin_scope',e.origin_scope,
        'change_summary',e.change_summary,'result',e.result,'receipt_id',e.receipt_id,
        'audit_visibility',e.audit_visibility,'evidence_refs',e.evidence_refs,
        'artifact_refs',e.artifact_refs,'error_code',e.error_code,
        'created_at',e.occurred_at,'updated_at',e.occurred_at
      ) as row_data
      from public.clued_context_events e
      left join public.clued_project_resolution_v2 r
        on r.user_id=e.user_id and r.source_project_id=e.project_id
      where e.user_id=p_user_id
        and (v_level='global' or coalesce(r.effective_project_id,e.project_id)=v_effective_project_id)
      order by e.id desc limit v_limit
    ) events;
  else
    select coalesce(jsonb_agg(to_jsonb(record_row) order by record_row.priority desc,record_row.updated_at desc,record_row.id),'[]'::jsonb)
      into v_rows from (
        select r.* from public.clued_records_v2 r
         where r.user_id=p_user_id
           and (v_level='global' or r.effective_project_id=v_effective_project_id)
           and (case when v_type='archive' then r.status='archived' else r.record_type=v_type and r.status<>'archived' end)
         order by r.priority desc,r.updated_at desc,r.id limit v_limit
      ) record_row;
  end if;
  return jsonb_build_object('status','ok','level',v_level,'record_type',v_type,'project_id',v_effective_project_id,'records',v_rows);
end $$;

revoke all on function clued_private.record_list_core(uuid,jsonb) from public,anon,authenticated;

notify pgrst,'reload schema';