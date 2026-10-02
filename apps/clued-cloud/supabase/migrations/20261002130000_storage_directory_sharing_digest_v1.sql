-- StorageFullCapability.v0.1 P6.2 (Owner Decision 06b54716): directories
-- Clued creates or moves around stop depending on their Drive version.
--
-- The P6.1 production acceptance (Note b21280a6) found that a directory Clued
-- created had no sharing digest, so the registry matched it by its Drive
-- version only. A directory move into or out of it advanced that version and
-- every later write that used it as a parent was refused
-- (ARTIFACT_AUTHORITY_RESOLUTION_FAILED) until the Owner approved a registry
-- update. A directory with a digest is matched by its sharing instead
-- (resource_center_directory_match_v1, migration 20260929200000).
--
-- * Create: the verifier may carry provider_sharing_digest in a
--   clued.storage-create-verified/2 proof for a directory, only when the new
--   folder's sharing equals its destination folder's. The verified record
--   accepts it only for a directory and only as exactly the destination
--   folder's digest the provider identity recorded; the registration then
--   stores it. A proof without it registers the directory as before.
-- * Directory move: the settlement records, on the source and destination
--   folders that have no digest yet, the digest the provider identity
--   recorded for each (the move requires the two to be equal, and the
--   destination's was checked against the registry by the authority). A
--   folder that already has a digest is not changed.
-- * Each existing function is changed by an anchored patch with an exact hit
--   count. The proof field is optional, so the old executor keeps working
--   between this migration and the release.

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- The verified record: the digest only for a directory, only as the
    -- destination folder's recorded digest.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true));
    end if;$a$,
     $r$      'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true))
      ||case when proof ? 'provider_sharing_digest' then jsonb_build_object('provider_sharing_digest',
        case when j.mutation->>'target_kind'='directory'
          and m.authority_request->'provider_identity'->>'destination_parent_sharing_digest' ~ '^[0-9a-f]{64}$'
          then m.authority_request->'provider_identity'->'destination_parent_sharing_digest' else '"invalid"'::jsonb end)
        else '{}'::jsonb end;
    end if;$r$,1),
    -- The registration input carries it.
    ('clued_private.storage_settle_input_v1(uuid,clued_private.resource_center_mutations_v1,jsonb)',
     $a$      'target_kind',m.authority_request->'mutation'->>'target_kind','governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false)
  end$a$,
     $r$      'target_kind',m.authority_request->'mutation'->>'target_kind','governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false)
    ||case when p_proof ? 'provider_sharing_digest'
      then jsonb_build_object('provider_sharing_digest',p_proof->'provider_sharing_digest') else '{}'::jsonb end
  end$r$,1),
    -- artifact_register stores it (the column allows a digest only on a directory).
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$        governance_class,delete_authority,source_decision_id,receipt_id)
      values(p_user_id,v_profile.id,v_path,p_input->>'provider_file_id',
        p_input->>'provider_file_version',p_input->>'target_kind',
        p_input->>'governance_class',(p_input->>'delete_authority')::boolean,
        v_decision_id,v_receipt.id) returning * into v_artifact;$a$,
     $r$        governance_class,delete_authority,source_decision_id,receipt_id,provider_sharing_digest)
      values(p_user_id,v_profile.id,v_path,p_input->>'provider_file_id',
        p_input->>'provider_file_version',p_input->>'target_kind',
        p_input->>'governance_class',(p_input->>'delete_authority')::boolean,
        v_decision_id,v_receipt.id,
        case when jsonb_typeof(p_input->'provider_sharing_digest')='string' then p_input->>'provider_sharing_digest' end)
        returning * into v_artifact;$r$,1),
    -- The directory move's settlement: both folders that still match by
    -- version get the digest the provider identity recorded for them.
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$    where id=a.id returning * into moved;
  return moved;$a$,
     $r$    where id=a.id returning * into moved;
  -- P6.2: the source and destination folders that have no sharing digest get
  -- the one the provider identity recorded (equal on both sides), so the
  -- Drive version this move advanced no longer stops later writes.
  update clued_private.resource_center_artifacts_v1 x
    set provider_sharing_digest=g.digest,version=x.version+1,updated_at=now(),receipt_id=p_receipt
    from (select m.authority_request->'provider_identity' i from clued_private.resource_center_mutations_v1 m
        where m.id=substr(p_input->>'idempotency_key',26)::uuid) s,
      lateral (values (s.i->>'destination_parent_id',parent,s.i->>'destination_parent_sharing_digest'),
        (s.i->>'source_parent_id',regexp_replace(old,'/[^/]*$',''),s.i->>'source_parent_sharing_digest')) g(fid,folder,digest)
    where x.profile_id=p.id and x.user_id=p.user_id and x.state='active' and x.target_kind='directory'
      and x.provider_sharing_digest is null and x.provider_file_id=g.fid and x.path=g.folder
      and g.digest ~ '^[0-9a-f]{64}$';
  return moved;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_directory_sharing_digest_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
