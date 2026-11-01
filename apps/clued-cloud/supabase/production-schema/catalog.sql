-- Schema-only catalog fingerprint (contract clued.production-schema-catalog.v1).
--
-- Read-only. It reads system catalogs only: no table data, no role
-- passwords, no secrets. The same text runs against production (by whoever
-- refreshes catalog.json, with a read-only connection) and against the local
-- replay database in scripts/production-schema-drift.mjs, so both sides are
-- rendered by the same server functions. search_path is pinned so every
-- expression is printed schema-qualified the same way on both sides.
--
-- One row, one column "catalog": {"schemas": [...], "objects": [[kind, key, value], ...]}.
-- The applied migration list is read separately (applied.sql); it is not part
-- of the fingerprint because the local replay records no schema_migrations.
-- Function, view and policy bodies are md5 digests, taken after removing CR
-- before LF: production holds some bodies with CRLF line endings that are
-- otherwise byte-identical to their LF files. Everything else is the server's
-- own rendering. PostgreSQL 18 not-null constraints (contype 'n')
-- are skipped: attnotnull carries the same fact on 17 and 18.
-- Owners are compared for relations and functions (a SECURITY DEFINER
-- function runs as its owner); grants are compared for the anon,
-- authenticated, service_role and authenticator roles and PUBLIC only.
-- Not compared: comments, statistics, storage parameters, extension objects
-- and extension versions.
set search_path = pg_catalog;
with scope as (
  select n.oid, n.nspname
  from pg_namespace n
  where n.nspname = any (array[
    'public', 'clued_private', 'clued_storage_source', 'clued_watchdog',
    'mtpe_m0', 'mtpe_m0_test', 'mtpe_m0_work'])
),
ext as (
  select d.classid, d.objid from pg_depend d where d.deptype = 'e'
),
grantees as (
  select oid, rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
),
rel as (
  select c.oid, s.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relowner
  from pg_class c join scope s on s.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and not exists (select 1 from ext where ext.classid = 'pg_class'::regclass and ext.objid = c.oid)
),
fn as (
  select p.oid, s.nspname, p.proname, p.prokind, p.prolang, p.prosrc, p.prosecdef, p.provolatile,
         p.proisstrict, p.proconfig, p.proacl, p.proowner, p.proleakproof, p.proparallel
  from pg_proc p join scope s on s.oid = p.pronamespace
  where not exists (select 1 from ext where ext.classid = 'pg_proc'::regclass and ext.objid = p.oid)
),
acl_rows as (
  select 'acl' as kind, 'relation:' || r.nspname || '.' || r.relname as key,
         to_jsonb(array(
           select coalesce(g.rolname, 'PUBLIC') || ':' || string_agg(a.privilege_type, ',' order by a.privilege_type)
           from aclexplode(r.relacl) a left join grantees g on g.oid = a.grantee
           where a.grantee = 0 or g.oid is not null
           group by coalesce(g.rolname, 'PUBLIC') order by 1)) as value
  from rel r where r.relacl is not null
  union all
  select 'acl', 'function:' || f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         to_jsonb(array(
           select coalesce(g.rolname, 'PUBLIC') || ':' || string_agg(a.privilege_type, ',' order by a.privilege_type)
           from aclexplode(coalesce(f.proacl, acldefault('f', (select proowner from pg_proc where oid = f.oid)))) a
           left join grantees g on g.oid = a.grantee
           where a.grantee = 0 or g.oid is not null
           group by coalesce(g.rolname, 'PUBLIC') order by 1))
  from fn f
  union all
  select 'acl', 'schema:' || n.nspname,
         to_jsonb(array(
           select coalesce(g.rolname, 'PUBLIC') || ':' || string_agg(a.privilege_type, ',' order by a.privilege_type)
           from aclexplode(n.nspacl) a left join grantees g on g.oid = a.grantee
           where a.grantee = 0 or g.oid is not null
           group by coalesce(g.rolname, 'PUBLIC') order by 1))
  from pg_namespace n join scope s on s.oid = n.oid where n.nspacl is not null
  union all
  select 'acl', 'column:' || r.nspname || '.' || r.relname || '.' || a.attname,
         to_jsonb(array(
           select coalesce(g.rolname, 'PUBLIC') || ':' || string_agg(x.privilege_type, ',' order by x.privilege_type)
           from aclexplode(a.attacl) x left join grantees g on g.oid = x.grantee
           where x.grantee = 0 or g.oid is not null
           group by coalesce(g.rolname, 'PUBLIC') order by 1))
  from rel r join pg_attribute a on a.attrelid = r.oid
  where a.attnum > 0 and not a.attisdropped and a.attacl is not null
),
objects as (
  select 'relation' as kind, r.nspname || '.' || r.relname as key,
         jsonb_build_object('relkind', r.relkind, 'rls', r.relrowsecurity, 'force_rls', r.relforcerowsecurity,
           'owner', pg_get_userbyid(r.relowner),
           'view_md5', case when r.relkind in ('v', 'm') then md5(pg_get_viewdef(r.oid)) end,
           'sequence', (select jsonb_build_object('type', format_type(q.seqtypid, null), 'start', q.seqstart,
                          'increment', q.seqincrement, 'max', q.seqmax, 'min', q.seqmin, 'cache', q.seqcache, 'cycle', q.seqcycle)
                        from pg_sequence q where q.seqrelid = r.oid)) as value
  from rel r
  union all
  select 'column', r.nspname || '.' || r.relname || '.' || a.attname,
         jsonb_build_object('type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
           'default', pg_get_expr(d.adbin, d.adrelid), 'identity', nullif(a.attidentity, ''),
           'generated', nullif(a.attgenerated, ''))
  from rel r join pg_attribute a on a.attrelid = r.oid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and r.relkind in ('r', 'p', 'v', 'm', 'f')
  union all
  select 'constraint', r.nspname || '.' || r.relname || '.' || c.conname, to_jsonb(pg_get_constraintdef(c.oid))
  from rel r join pg_constraint c on c.conrelid = r.oid
  where c.contype <> 'n'
  union all
  select 'index', r.nspname || '.' || i.relname, to_jsonb(pg_get_indexdef(i.oid))
  from rel r join pg_index x on x.indrelid = r.oid join pg_class i on i.oid = x.indexrelid
  union all
  select 'trigger', r.nspname || '.' || r.relname || '.' || t.tgname, to_jsonb(pg_get_triggerdef(t.oid))
  from rel r join pg_trigger t on t.tgrelid = r.oid
  where not t.tgisinternal
  union all
  select 'policy', r.nspname || '.' || r.relname || '.' || p.polname,
         jsonb_build_object('cmd', p.polcmd, 'permissive', p.polpermissive,
           'roles', to_jsonb(array(select case when x = 0 then 'PUBLIC' else (select rolname from pg_roles where oid = x) end
                                    from unnest(p.polroles) x order by 1)),
           'qual_md5', md5(coalesce(pg_get_expr(p.polqual, p.polrelid), '')),
           'check_md5', md5(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')))
  from rel r join pg_policy p on p.polrelid = r.oid
  union all
  select 'function', f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         jsonb_build_object('kind', f.prokind, 'language', (select lanname from pg_language where oid = f.prolang),
           'returns', case when f.prokind <> 'p' then pg_get_function_result(f.oid) end,
           'arguments', pg_get_function_arguments(f.oid), 'owner', pg_get_userbyid(f.proowner),
           'body_md5', md5(regexp_replace(f.prosrc, E'\r+\n', E'\n', 'g')), 'security_definer', f.prosecdef, 'volatility', f.provolatile,
           'strict', f.proisstrict, 'leakproof', f.proleakproof, 'parallel', f.proparallel, 'config', to_jsonb(f.proconfig))
  from fn f
  union all
  select 'type', s.nspname || '.' || t.typname,
         jsonb_build_object('typtype', t.typtype,
           'labels', case when t.typtype = 'e' then to_jsonb(array(select enumlabel from pg_enum where enumtypid = t.oid order by enumsortorder)) end,
           'base', case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end)
  from pg_type t join scope s on s.oid = t.typnamespace
  where t.typtype in ('e', 'd')
    and not exists (select 1 from ext where ext.classid = 'pg_type'::regclass and ext.objid = t.oid)
  union all
  select kind, key, value from acl_rows
  union all
  select 'default_acl', pg_get_userbyid(d.defaclrole) || ':' || s.nspname || ':' || d.defaclobjtype::text,
         to_jsonb(array(
           select coalesce(g.rolname, 'PUBLIC') || ':' || string_agg(a.privilege_type, ',' order by a.privilege_type)
           from aclexplode(d.defaclacl) a left join grantees g on g.oid = a.grantee
           where a.grantee = 0 or g.oid is not null
           group by coalesce(g.rolname, 'PUBLIC') order by 1))
  from pg_default_acl d join scope s on s.oid = d.defaclnamespace
)
select jsonb_build_object(
  'schemas', (select to_jsonb(array(select nspname from scope order by 1))),
  'objects', (select jsonb_agg(jsonb_build_array(kind, key, value) order by kind, key) from objects)
) as catalog;
