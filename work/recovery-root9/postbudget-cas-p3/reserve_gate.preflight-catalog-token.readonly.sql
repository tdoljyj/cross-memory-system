-- READ ONLY. Run immediately before sealing P3, then pass catalog_jsonb_sha256
-- to build-full-reserve-gate.mjs as --pre-catalog-sha256.
with target as (
  select p.*, to_jsonb(p)-'prosrc' as catalog_without_source
    from pg_proc p
   where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
)
select p.oid,
       pg_get_userbyid(p.proowner) as owner_name,
       encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') as pg_get_functiondef_sha256,
       encode(sha256(convert_to(p.catalog_without_source::text,'UTF8')),'hex') as catalog_jsonb_sha256,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.prokind as kind,
       p.proconfig,
       p.proacl,
       exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
               where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,
       p.catalog_without_source
  from target p;
