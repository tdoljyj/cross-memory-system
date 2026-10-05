-- S2c Integration Runtime stage C-1 (IntegrationRuntime v0.1.8 §5.13, OQ-21; Owner Decision 85616c43):
-- the target EXECUTE grants that the S2c migrations deliberately left out, so that the Integration public
-- RPCs become callable once CLUED_INTEGRATION_RUNTIME_V1 is on. Exactly §5.13, nothing else:
--   - Binding path (authenticated inside the function by the token hash): anon, authenticated.
--   - Native path clued_user_integration_v1 (first line authorization_owner_v12()): authenticated only.
--   - Operator path clued_admin_integration_v1 (authorization_owner_v12() + platform_admin_v13): authenticated only.
-- No clued_private function, table, sequence or view gains any privilege; public and service_role gain nothing.
-- Rollback is the same list as `revoke execute ... from anon, authenticated` (anon only on the Binding path).

grant execute on function public.clued_integration_request_open_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_create_or_bind_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_identity_update_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_reconcile_request_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_status_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_declare_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_report_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_verify_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_integration_revoke_self_v1(text, jsonb) to anon, authenticated;
grant execute on function public.clued_user_integration_v1(jsonb) to authenticated;
grant execute on function public.clued_admin_integration_v1(jsonb) to authenticated;
