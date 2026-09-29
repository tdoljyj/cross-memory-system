-- READ ONLY. Project Lifecycle Successor v2 production preflight inventory.
-- Run against the exact production migration target before schema apply and
-- retain the result as private review evidence. This statement performs no
-- writes and returns one deterministic proposed disposition per Project row.
select p.id as project_id,p.user_id,p.name,p.progress_status,
  p.certainty_status as legacy_certainty_status,p.confirmed_at as legacy_confirmed_at,
  case when facts.recognized then 'recognized_project' else 'evidence_only' end as proposed_disposition,
  facts.source as proposed_recognition_source,
  case when facts.recognized then greatest(p.confidence,facts.minimum_confidence)
       else p.confidence end as proposed_recognition_confidence,
  facts.source_refs as proposed_source_refs,
  facts.reason as proposed_disposition_reason,
  facts.basis
from public.clued_projects p
cross join lateral (
  select
    (p.certainty_status='confirmed' or p.confirmed_at is not null or
      exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type in ('project_created','project_updated','project_completed','project_archived','project_restored')
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)) or
      exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null) or
      exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed')) as recognized,
    case
      when p.certainty_status='confirmed' then 'Legacy v1 explicitly classified this row as a Project.'
      when p.confirmed_at is not null then 'Legacy confirmation timestamp proves an explicit Project decision.'
      when exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type in ('project_created','project_updated','project_completed','project_archived','project_restored')
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text))
        then 'A canonical Project mutation Event proves explicit Project creation or work.'
      when exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null)
        then 'Canonical Project-scoped work proves that the row is a Project.'
      when exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed')
        then 'A legacy confirmed mention proves an explicit Project decision.'
      else 'No Project-recognition decision or durable Project work exists; retain provenance as evidence/history only.'
    end as reason,
    case
      when p.certainty_status='confirmed' then 'v1_confirmed'
      when p.confirmed_at is not null then 'confirmed_timestamp'
      when exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type in ('project_created','project_updated','project_completed','project_archived','project_restored')
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)) then 'explicit_project_event'
      when exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null) then 'durable_project_work'
      when exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed') then 'confirmed_mention'
      else 'legacy_mention_only'
    end as source,
    case
      when p.certainty_status='confirmed' or p.confirmed_at is not null then 1.000
      when exists(select 1 from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and e.canonical_event_type='project_created'
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)) then 1.000
      when exists(select 1 from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null) then 0.900
      when exists(select 1 from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed') then 0.900
      else 0.000
    end as minimum_confidence,
    coalesce((select array_agg(distinct evidence_id order by evidence_id)
      from (
        select unnest(coalesce(m.source_refs,'{}'::uuid[])) evidence_id
          from public.clued_memories m where m.user_id=p.user_id and m.project_id=p.id
        union all
        select unnest(coalesce(e.evidence_refs,'{}'::uuid[])) evidence_id
          from public.clued_context_events e
         where e.user_id=p.user_id and e.event_schema_version is not null
           and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
             where ref->>'kind'='project' and ref->>'id'=p.id::text)
      ) refs),
      '{}'::uuid[]) as source_refs,
    jsonb_build_object(
      'legacy_certainty_status',p.certainty_status,
      'legacy_confirmed_at',p.confirmed_at,
      'canonical_project_event_count',(select count(*) from public.clued_context_events e
        where e.user_id=p.user_id and e.event_schema_version is not null
          and exists(select 1 from jsonb_array_elements(coalesce(e.target_refs,'[]'::jsonb)) ref
            where ref->>'kind'='project' and ref->>'id'=p.id::text)),
      'canonical_record_count',(select count(*) from public.clued_memories m
        where m.user_id=p.user_id and m.project_id=p.id and m.record_schema_version is not null),
      'confirmed_mention_count',(select count(*) from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id and pm.intent='confirmed'),
      'mention_count',(select count(*) from public.clued_project_mentions pm
        where pm.user_id=p.user_id and pm.project_id=p.id)) as basis
) facts
order by p.user_id,p.id;
