
create or replace function mtpe_m0.is_material_condition2(p_criticality text,p_attributes jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select coalesce(p_criticality='CRITICAL',false)
       or (p_criticality is null and coalesce(p_attributes->>'priority','')='P0') $$;
create or replace function mtpe_m0_test.is_material_condition2(p_criticality text,p_attributes jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select coalesce(p_criticality='CRITICAL',false)
       or (p_criticality is null and coalesce(p_attributes->>'priority','')='P0') $$;
