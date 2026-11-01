-- Production migration history as the drift check needs it (contract
-- clued.production-schema-catalog.v1). Read-only; statement text is reduced to
-- its md5 and length, the same facts supabase/ledger/production-history.json
-- records, so the snapshot can be bound to ledger rows and pending files.
select jsonb_agg(jsonb_build_object(
         'version', version, 'name', name,
         'statements_md5', md5(array_to_string(statements, '')),
         'statements_length', length(array_to_string(statements, '')),
         'statement_count', coalesce(array_length(statements, 1), 0))
       order by version) as applied
from supabase_migrations.schema_migrations;
