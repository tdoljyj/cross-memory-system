-- Native correction currentness scope repair. Task 1502fd80.
-- The signed-in Native Owner owns both Global and this fixed Project. A
-- Project Task may reference its registered Global execution intent; the
-- shared CURRENT fence must validate that source as well. This is not an
-- expansion of an Agent Binding, a grant, its six resources or any write.
-- Keep the applied predecessor and the existing Owner/token/receipt gates.

do $PATCH$
declare
  src text := pg_get_functiondef(
    'clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)'::regprocedure);
  expected constant text := 'd616d9fc3ad3009c7f84179b074c3ec61434f0f3277b68993a73c6210ad85966';
  marker constant text := 'clued_private.record_currentness_fence(p_owner,m.id,array[s])';
begin
  if encode(extensions.digest(convert_to(src,'UTF8'),'sha256'),'hex')
      is distinct from expected then
    raise exception 'dataset_split_correction_context_source_changed';
  end if;
  if (length(src)-length(replace(src,marker,'')))/length(marker) <> 1 then
    raise exception 'dataset_split_correction_currentness_marker_changed';
  end if;
  execute replace(src,marker,
    'clued_private.record_currentness_fence(p_owner,m.id,array[''global'',s])');
end $PATCH$;

notify pgrst,'reload schema';
