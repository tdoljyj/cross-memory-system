-- StorageNormalUse.v0.1 N0a scope foundation (§2.2 items 6-7, §8.1.9 item 1,
-- §8.2 data). No behavior change for existing connections: every existing row
-- is legacy / text/1, and nothing in this migration can create normal/1.
--
-- * storage_connections_v1.provider_scope_profile: the Google scope profile the
--   sealed credential actually carries ('legacy' = drive.file +
--   drive.metadata.readonly, 'normal' = legacy + drive.readonly). The Worker
--   computes it from the granted scope; connection-consent `complete` writes it
--   in the same UPDATE that advances credential_version (CAS with it). Refresh
--   never changes it (the Worker refuses a refresh whose scope changes profile).
--   A `complete` without the key (a Worker released before this migration, which
--   accepts only the legacy set) records 'legacy'.
-- * Credential recovery (legacy v1 and account-policy v2) describes the sealed
--   profile, and its `complete` fails unless the granted profile equals it;
--   the credential is left unchanged.
-- * storage_read_access_v1.content_profile ('text/1' | 'normal/1'), immutable
--   like the rest of the row. Only 'text/1' is written here. The read evaluator
--   returns it; read admission returns it together with provider_scope_profile.
--   Moving read access to a new write policy copies it.

alter table clued_private.storage_connections_v1
  add column provider_scope_profile text not null default 'legacy'
    constraint storage_connections_scope_profile_v1 check (provider_scope_profile in ('legacy','normal'));

alter table clued_private.storage_read_access_v1
  add column content_profile text not null default 'text/1'
    constraint storage_read_access_content_profile_v1 check (content_profile in ('text/1','normal/1'));

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Connection consent (075249 original, below the 083521/145426/211632 wrappers).
    ('clued_private.clued_storage_oauth_v1(text,jsonb)',
     $a$'oauth_client_id',a.oauth_client_id,'redirect_uri',a.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id);$a$,
     $r$'oauth_client_id',a.oauth_client_id,'redirect_uri',a.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
    'provider_scope_profile',c.provider_scope_profile);$r$,1),
    ('clued_private.clued_storage_oauth_v1(text,jsonb)',
     $a$        if x.status<>'claimed' or (p_input-array['action','state_hash','credential_envelope','provider_subject'])<>'{}'::jsonb$a$,
     $r$        if x.status<>'claimed' or (p_input-array['action','state_hash','credential_envelope','provider_subject','provider_scope_profile'])<>'{}'::jsonb
          or (p_input ? 'provider_scope_profile' and (jsonb_typeof(p_input->'provider_scope_profile') is distinct from 'string'
            or p_input->>'provider_scope_profile' not in ('legacy','normal')))$r$,1),
    ('clued_private.clued_storage_oauth_v1(text,jsonb)',
     $a$          oauth_client_id=a.oauth_client_id,credential_version=credential_version+1,$a$,
     $r$          oauth_client_id=a.oauth_client_id,credential_version=credential_version+1,
          provider_scope_profile=coalesce(p_input->>'provider_scope_profile','legacy'),$r$,1),
    -- Legacy-mode credential recovery.
    ('clued_private.storage_credential_recovery_oauth_v1(text,jsonb)',
     $a$    (op='complete' and (p_input-array['action','state_hash','provider_subject','credential_envelope'])<>'{}'::jsonb) then$a$,
     $r$    (op='complete' and (p_input-array['action','state_hash','provider_subject','credential_envelope','provider_scope_profile'])<>'{}'::jsonb) then$r$,1),
    ('clued_private.storage_credential_recovery_oauth_v1(text,jsonb)',
     $a$'redirect_uri',app.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'recovery_binding',bound);$a$,
     $r$'redirect_uri',app.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'recovery_binding',bound,
    'provider_scope_profile',c.provider_scope_profile);$r$,1),
    ('clued_private.storage_credential_recovery_oauth_v1(text,jsonb)',
     $a$      if x.status<>'claimed' or p_input->>'provider_subject' is distinct from c.provider_subject or$a$,
     $r$      if x.status<>'claimed' or p_input->>'provider_subject' is distinct from c.provider_subject or
        (p_input ? 'provider_scope_profile' and jsonb_typeof(p_input->'provider_scope_profile') is distinct from 'string') or
        coalesce(p_input->>'provider_scope_profile','legacy') is distinct from c.provider_scope_profile or$r$,1),
    -- Account-policy credential recovery.
    ('clued_private.storage_credential_recovery_oauth_v2(text,jsonb)',
     $a$    (op='complete' and (p_input-array['action','state_hash','provider_subject','credential_envelope'])<>'{}'::jsonb) then$a$,
     $r$    (op='complete' and (p_input-array['action','state_hash','provider_subject','credential_envelope','provider_scope_profile'])<>'{}'::jsonb) then$r$,1),
    ('clued_private.storage_credential_recovery_oauth_v2(text,jsonb)',
     $a$'redirect_uri',app.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'recovery_binding',bound);$a$,
     $r$'redirect_uri',app.redirect_uri,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'recovery_binding',bound,
    'provider_scope_profile',c.provider_scope_profile);$r$,1),
    ('clued_private.storage_credential_recovery_oauth_v2(text,jsonb)',
     $a$      if x.status<>'claimed' or p_input->>'provider_subject' is distinct from c.provider_subject or$a$,
     $r$      if x.status<>'claimed' or p_input->>'provider_subject' is distinct from c.provider_subject or
        (p_input ? 'provider_scope_profile' and jsonb_typeof(p_input->'provider_scope_profile') is distinct from 'string') or
        coalesce(p_input->>'provider_scope_profile','legacy') is distinct from c.provider_scope_profile or$r$,1),
    -- Read evaluator and admission.
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)',
     $a$    'profile_id',p.id,'root_folder_id',root_key,'managed_root',p.managed_root);$a$,
     $r$    'profile_id',p.id,'root_folder_id',root_key,'managed_root',p.managed_root,'content_profile',ra.content_profile);$r$,1),
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$      'root_folder_id',evaluated->>'root_folder_id','read_generation',rr.read_generation);$a$,
     $r$      'root_folder_id',evaluated->>'root_folder_id','read_generation',rr.read_generation,
      'content_profile',evaluated->>'content_profile','provider_scope_profile',c.provider_scope_profile);$r$,1),
    -- Moving read access to a fresh write policy keeps its content profile.
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$    insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id)
    values(u,c.id,fresh.id,ra.classes,(select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id)+1,
      ra.disclosure_version,ra.consent_receipt_id)$a$,
     $r$    insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id,content_profile)
    values(u,c.id,fresh.id,ra.classes,(select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id)+1,
      ra.disclosure_version,ra.consent_receipt_id,ra.content_profile)$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_scope_profile_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
