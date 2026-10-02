-- Owner Decision b18eff80 (2026-10-01): a folder that is another registered
-- root of the same owner is not a NO SIBLING ISLAND finding.
--
-- N0 self-service onboarding creates managed roots directly in "My Drive",
-- next to the original Clued_资料中心 and under the same Drive parent. The
-- boundary scan of one root listed the other (a Clued-named, app-created
-- folder outside its managed root) as resource_center_parent_or_sibling_island,
-- so every write on the original connection was denied (P5 acceptance job
-- ea6ef175, Note c7fbc52d).
--
-- * clued_private.storage_registered_sibling_roots_v1(owner, profile) lists the
--   Drive folder IDs of the owner's OTHER active profiles whose root has the
--   same Drive parent. Revoked profiles and other owners never appear.
-- * The cloud executor job descriptors (account-policy storage_cloud_worker_v2
--   and legacy-mode clued_storage_cloud_worker_v1) and the directory probe
--   descriptor (storage_directory_descriptor_v1) carry it as
--   registered_sibling_roots. The scanner skips exactly those folder IDs when
--   they are listed directly in the managed root's parent; a folder with the
--   same name and another ID is still a finding. Every other island rule
--   (Decision 89b998d7, fd94bd2f) is unchanged.
-- * The list is read when the job or probe is loaded; a sibling revoked
--   while one job is in flight stays exempt for that job only. The scanner
--   accepts at most 64 sibling roots; more fails closed
--   (DRIVE_BOUNDARY_PROFILE_UNQUALIFIED).
-- * Each function is changed by an anchored patch with an exact hit count.

create or replace function clued_private.storage_registered_sibling_roots_v1(p_owner uuid, p_profile uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(o.root_folder_id order by o.root_folder_id collate "C"),'[]'::jsonb)
  from clued_private.resource_center_profiles_v1 s
  join clued_private.resource_center_profiles_v1 o
    on o.user_id=s.user_id and o.id<>s.id and o.state='active'
   and o.root_parent_id=s.root_parent_id
   and o.root_folder_id ~ '^[A-Za-z0-9_-]{1,160}$'
   and o.root_folder_id<>s.root_folder_id and o.root_folder_id<>s.root_parent_id
  where s.id=p_profile and s.user_id=p_owner
$$;

revoke all on function clued_private.storage_registered_sibling_roots_v1(uuid,uuid)
  from public,anon,authenticated,service_role;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$      'scan_roots',jsonb_build_array(jsonb_build_object('folder_id',p.root_parent_id,'path',regexp_replace(p.managed_root,'/[^/]+$',''))));$a$,
     $r$      'scan_roots',jsonb_build_array(jsonb_build_object('folder_id',p.root_parent_id,'path',regexp_replace(p.managed_root,'/[^/]+$',''))),
      'registered_sibling_roots',clued_private.storage_registered_sibling_roots_v1(c.owner_id,p.id));$r$,1),
    ('public.clued_storage_cloud_worker_v1(text,jsonb)',
     $a$      'scan_roots',jsonb_build_array(jsonb_build_object('folder_id',p.root_parent_id,'path',regexp_replace(p.managed_root,'/[^/]+$',''))));$a$,
     $r$      'scan_roots',jsonb_build_array(jsonb_build_object('folder_id',p.root_parent_id,'path',regexp_replace(p.managed_root,'/[^/]+$',''))),
      'registered_sibling_roots',clued_private.storage_registered_sibling_roots_v1(c.owner_id,p.id));$r$,1),
    ('clued_private.storage_directory_descriptor_v1(uuid,uuid)',
     $a$      'root_parent_id',p.root_parent_id,'allowed_root_children',tracks,'directories',dirs));$a$,
     $r$      'root_parent_id',p.root_parent_id,'allowed_root_children',tracks,'directories',dirs),
    'registered_sibling_roots',clued_private.storage_registered_sibling_roots_v1(p_owner,p.id));$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_registered_sibling_roots_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
