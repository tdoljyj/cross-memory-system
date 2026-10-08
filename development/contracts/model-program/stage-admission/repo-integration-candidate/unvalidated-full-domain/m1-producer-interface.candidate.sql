-- UNINSTALLED/NOT_READY interface candidate. No source rows or Owner grant.
-- Verified existing public M1 entry:
-- public.clued_record_mutate(p_token_hash text,p_input jsonb) -> jsonb;
-- resolve_binding_action_v12(context:write,exact Project) -> currentness lock
-- -> record_mutation_with_terminal_guard -> record_mutation_core
-- -> server m1_record_content_hash -> m1_append_event_row -> m1_finish_receipt.
-- All are in the same PostgreSQL transaction. Record/Grant/Receipt IDs are
-- NOT Evidence IDs and must never be placed in source_refs.
-- The concrete create templates are in m1-bootstrap-plan.candidate.mjs.
-- They deliberately omit user_confirmed, real Native window and new server
-- hash placeholders until an authenticated SQL Native confirmation chain can
-- derive them. Do not pass these templates to M1 or replace placeholders.
create or replace function public.clued_model_dataset_split_bootstrap_candidate(
 p_token_hash text,p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b:=clued_private.resolve_binding_action_v12(p_token_hash,'context:write',
    'project:0597aa60-9b98-4da6-a4ab-63d7705b632f','write');
  -- context:write proves only M1 business-write scope. It cannot authorize a
  -- domain producer. No Canonical target read or M1 mutation is reached here.
  raise exception 'MODEL_DOMAIN_BOOTSTRAP_NOT_READY_NATIVE_ATOMIC_PRODUCER_NOT_VALIDATED'
    using errcode='42501';
end $$;
revoke all on function public.clued_model_dataset_split_bootstrap_candidate(text,jsonb)
 from public,anon,authenticated,service_role;
