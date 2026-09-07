WITH ns AS (SELECT oid,nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'), surfaces AS (
SELECT 'schema'::text kind,n.nspname::text schema_name,''::text parent,n.nspname::text name,''::text detail FROM ns n
UNION ALL SELECT 'relation',n.nspname,'',c.relname,c.relkind::text FROM pg_class c JOIN ns n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f')
UNION ALL SELECT 'column',n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN ns n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
UNION ALL SELECT 'function',n.nspname,'',p.proname,pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN ns n ON n.oid=p.pronamespace
UNION ALL SELECT 'constraint',n.nspname,c.relname,k.conname,k.contype::text FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN ns n ON n.oid=c.relnamespace
UNION ALL SELECT 'index',n.nspname,c.relname,i.relname,'' FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class c ON c.oid=x.indrelid JOIN ns n ON n.oid=c.relnamespace
UNION ALL SELECT 'policy',n.nspname,c.relname,p.polname,p.polcmd::text FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN ns n ON n.oid=c.relnamespace
UNION ALL SELECT 'trigger',n.nspname,c.relname,t.tgname,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN ns n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal
UNION ALL SELECT 'role','','',r.rolname,'' FROM pg_roles r
) SELECT kind,schema_name,parent,name,detail,count(*) OVER() AS total_count FROM surfaces ORDER BY kind,schema_name,parent,name,detail LIMIT 150 OFFSET 0;
