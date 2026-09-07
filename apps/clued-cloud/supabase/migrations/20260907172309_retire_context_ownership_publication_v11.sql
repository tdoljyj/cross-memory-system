set lock_timeout = '5s';
set statement_timeout = '30s';

-- Retire the superseded standalone Context Ownership / Publication v1.1 surface.
-- No CASCADE: every dependency is removed explicitly so unrelated objects cannot be deleted.

drop policy if exists clued_v11_oauth_binding_delete on public.clued_agent_bindings;
drop policy if exists clued_v11_oauth_binding_update on public.clued_agent_bindings;
drop policy if exists clued_v11_oauth_binding_insert on public.clued_agent_bindings;
drop policy if exists clued_v11_oauth_binding_select on public.clued_agent_bindings;

drop function if exists public.clued_context_oauth_call(jsonb);
drop function if exists public.clued_context_owner(jsonb);
drop function if exists public.clued_context_call(text,jsonb);

drop view if exists clued_private.context_receipts_v11;
drop view if exists clued_private.context_events_v11;

drop function if exists clued_private.context_execute_v11(uuid,uuid,boolean,jsonb);
drop function if exists clued_private.context_visible_record_v11(uuid,clued_private.context_grants_v11);
drop function if exists clued_private.context_reference_status_v11(jsonb,uuid);
drop function if exists clued_private.context_publication_valid_v11(uuid);
drop function if exists clued_private.context_active_grant_v11(uuid,uuid,text);
drop function if exists clued_private.context_hash_v11(jsonb);

drop table if exists clued_private.context_publication_heads_v11;
drop table if exists clued_private.context_publications_v11;
drop table if exists clued_private.context_acceptances_v11;
drop table if exists clued_private.context_links_v11;
drop table if exists clued_private.context_feedback_v11;
drop table if exists clued_private.context_record_versions_v11;
drop table if exists clued_private.context_grants_v11;
drop table if exists clued_private.context_records_v11;
drop table if exists clued_private.context_operations_v11;
drop table if exists clued_private.context_spaces_v11;
