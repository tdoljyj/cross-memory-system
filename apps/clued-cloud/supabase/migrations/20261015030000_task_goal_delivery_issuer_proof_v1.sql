-- Consume both formal persisted-proof envelopes. The producer changed only the
-- outer issuer representation in 20261009070001; ordinary text still uses the
-- create-verified/2 inner proof. Archival credentials may already be retired.
-- Keep the existing function identity, ACL, proof digests, receipts and current
-- registry/Scope/Storage qualification unchanged.
do $migration$
declare
  body text;
  anchor text:=$a$if saved is null or saved->>'contract' is distinct from 'clued.storage-persisted-verification/2'$a$;
  replacement text:=$r$if saved is null or coalesce(saved->>'contract','') not in
    ('clued.storage-persisted-verification/2','clued.storage-persisted-verification/3')
    or (saved->>'contract'='clued.storage-persisted-verification/3' and not exists (
      select 1 from clued_private.issuer_identities_v1 issuer
        join clued_private.storage_oauth_apps_v1 app on app.issuer_hash=issuer.legacy_key
        join clued_private.issuer_credentials_v1 credential on credential.issuer_id=issuer.id
          and credential.generation::text=saved->>'credential_generation'
          and credential.activated_at is not null
      where issuer.kind='storage' and issuer.id::text=saved->>'issuer_id'
        and app.oauth_client_id=c.oauth_client_id
        and clued_private.issuer_verified_identity_matches_v1(saved,issuer.legacy_key)))$r$;
begin
  body:=pg_get_functiondef('clued_private.task_goal_delivery_file_v1(uuid,text,uuid,jsonb,jsonb,text,boolean)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'task_goal_delivery_issuer_proof_definition_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $migration$;
