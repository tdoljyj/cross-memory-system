-- UNINSTALLED trusted deployment constant. Intentionally UNBOUND.
-- Formal integration must copy actual immutable Git plan artifact UTF8 bytes
-- and SHA256, plus its exact 40hex resource, after independent source review.
-- Never load this from a caller body, ordinary Canonical metadata or a flag.
create or replace function clued_private.model_domain_bootstrap_exact_plan_candidate()
returns jsonb language sql immutable set search_path='' as $$
 select '{"source_resource":null,"source_sha256":null,"raw_utf8":null}'::jsonb
$$;
revoke all on function clued_private.model_domain_bootstrap_exact_plan_candidate()
 from public,anon,authenticated,service_role;
