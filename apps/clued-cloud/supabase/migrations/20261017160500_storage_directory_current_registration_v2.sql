-- Current registration describes the directory itself, not its descendants.
-- Physical children do not make that independent metadata registration unsafe:
-- no child is read as an artifact, adopted, moved, granted access or rewritten.
-- Keep the original typed-proof validators, active/ordinary/no-registered-
-- descendant plans, actor/CAS/isolation permits and original journal untouched.
do $upgrade$
declare item record; oid_before oid; definition text; catalog_before jsonb;
 old_check constant text := 'p_observation->''target''->''empty'' is distinct from ''true''::jsonb';
 new_check constant text := 'jsonb_typeof(p_observation->''target''->''empty'') is distinct from ''boolean''';
begin
 for item in select * from (values
  ('clued_private.storage_current_registration_observation_v1(jsonb,jsonb)','af5fbbc89f088298a05369d2b8b33386'),
  ('clued_private.storage_legacy_create_registration_observation_v1(jsonb,jsonb)','5ea1771c9b6be4d8cfd5cc2d3628f26b')
 ) expected(signature,source_md5) loop
  oid_before:=to_regprocedure(item.signature);
  if oid_before is null or (select md5(prosrc) from pg_proc where oid=oid_before) is distinct from item.source_md5 then
   raise exception 'storage_directory_current_registration_source_changed';
  end if;
  select jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl::text),pg_get_functiondef(oid)
   into catalog_before,definition from pg_proc where oid=oid_before;
  if (length(definition)-length(replace(definition,old_check,'')))/length(old_check)<>1 then
   raise exception 'storage_directory_current_registration_anchor_changed';
  end if;
  execute replace(definition,old_check,new_check);
  if to_regprocedure(item.signature) is distinct from oid_before or
   (select jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl::text)
    from pg_proc where oid=oid_before) is distinct from catalog_before then
   raise exception 'storage_directory_current_registration_catalog_changed';
  end if;
 end loop;
end $upgrade$;
