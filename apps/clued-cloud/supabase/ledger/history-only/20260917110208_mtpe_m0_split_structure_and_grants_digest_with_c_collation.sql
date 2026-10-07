-- Owner ruling 2026-09-17 (post capping review), item J:
-- 1) mtpe_m0_structure_digest() now covers PURE STRUCTURE ONLY (COL/CON/IDX/ENU/VIE).
--    Grants moved out because information_schema.role_table_grants is filtered by the
--    connecting role and differs by host, which made the digest unable to answer the very
--    question it existed for: whether the structure is identical across the relocation.
-- 2) Both digests now pin the sort with COLLATE "C". The previous definition used a bare
--    `order by line`; under the database default (en_US.UTF-8) the two happened to agree on
--    the current content, which was luck, not a guarantee.

create or replace function public.mtpe_m0_structure_digest()
returns text language sql stable as $function$
  select encode(sha256(convert_to(string_agg(line, e'\n' order by line collate "C"), 'UTF8')), 'hex')
  from (
    select 'COL|'||c.table_schema||'|'||c.table_name||'|'||c.ordinal_position||'|'||c.column_name||'|'||
           c.data_type||'|'||coalesce(c.udt_name,'')||'|'||c.is_nullable||'|'||coalesce(c.column_default,'') as line
    from information_schema.columns c
    where c.table_schema in ('mtpe_m0','mtpe_m0_test')
    union all
    select 'CON|'||n.nspname||'|'||rel.relname||'|'||con.conname||'|'||pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname in ('mtpe_m0','mtpe_m0_test')
    union all
    select 'IDX|'||schemaname||'|'||tablename||'|'||indexname||'|'||indexdef
    from pg_indexes where schemaname in ('mtpe_m0','mtpe_m0_test')
    union all
    select 'ENU|'||n.nspname||'|'||t.typname||'|'||e.enumsortorder||'|'||e.enumlabel
    from pg_enum e join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname in ('mtpe_m0','mtpe_m0_test')
    union all
    select 'VIE|'||schemaname||'|'||viewname||'|'||md5(definition)
    from pg_views where schemaname in ('mtpe_m0','mtpe_m0_test')
  ) x;
$function$;

comment on function public.mtpe_m0_structure_digest() is
'MTPE M0 pure-structure digest over mtpe_m0 + mtpe_m0_test: columns, constraints, indexes, enums, view definitions. Sort pinned with COLLATE "C". Grants deliberately excluded (see mtpe_m0_grants_digest) because role_table_grants is role- and host-dependent. Known blind spots, declared rather than silently accepted: triggers, rules, RLS flags and policies, functions, sequences, comments and table owners are NOT covered.';

create or replace function public.mtpe_m0_grants_digest()
returns text language sql stable as $function$
  select encode(sha256(convert_to(string_agg(line, e'\n' order by line collate "C"), 'UTF8')), 'hex')
  from (
    select 'PRV|'||table_schema||'|'||table_name||'|'||grantee||'|'||privilege_type as line
    from information_schema.role_table_grants
    where table_schema in ('mtpe_m0','mtpe_m0_test')
  ) x;
$function$;

comment on function public.mtpe_m0_grants_digest() is
'MTPE M0 grants digest over mtpe_m0 + mtpe_m0_test. Meaningful only WITHIN one host and one connecting role: information_schema.role_table_grants is filtered by the caller role, so this value changes with the connection. Never use it to compare two hosts.';