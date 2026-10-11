-- UNINSTALLED registration/transport permission candidate, not a migration.
-- Formal integration: obtain actual CLI migration filename, reviewed exact
-- commit, migration.production and release.production through existing doors.
-- Read-only source functions must be installed from their reviewed bytes first.
-- No Owner grants, producer rows or Canonical records are created here.
-- Plain INSERT intentionally refuses any already-registered action instead
-- of silently widening/replacing its authority or risk classification.
insert into clued_private.owner_grant_actions(action,doors,title,risk) values
 ('model.dataset_split.verify',array['model-domain'],'核验第一方模型 DatasetSplit 的固定非生产来源（精确记录，仅当前连接、≤1小时）','high'),
 ('model.dataset_split.recognize',array['model-domain'],'允许第一方模型 DatasetSplit 的固定非生产认定来源（精确权限记录，仅当前连接、≤1小时）','high'),
 ('model.dataset_split.producer',array['model-domain'],'登记第一方模型 DatasetSplit 固定非生产来源生产者（精确记录，仅当前连接、≤1小时）','high');
-- Existing Worker supabaseRequest Binding RPCs use the anon PostgREST role.
-- Grant only these two minimized functions, never the private source helper
-- or SELECT/DML over protected tables. Each RPC authenticates its own Binding.
grant execute on function public.clued_model_dataset_split_verify_candidate(text,jsonb),
  public.clued_model_dataset_split_resolve_refs_candidate(text,jsonb) to anon;
notify pgrst,'reload schema';
