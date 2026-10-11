// Disposable test databases only. Production's permanent issuer insert trigger provisions identity, never
// credentials. Legacy tests seed random issuer proofs directly; this explicit fixture grants those synthetic
// proofs so they can continue testing the unrelated storage/authorization contracts after step 2b.
export async function allowTestIssuerCredentials(client) {
  if (!(await client.query(`select to_regclass('clued_private.issuer_credentials_v1') is not null ready`)).rows[0].ready) return;
  await client.query(`
    create or replace function clued_private.test_issuer_credential_v1() returns trigger
    language plpgsql security definer set search_path='' as $$
    declare proof text; identity_id uuid;
    begin
      proof:=to_jsonb(new)->>case when tg_table_name='authorization_issuers_v12' then 'token_hash' else 'issuer_hash' end;
      select id into identity_id from clued_private.issuer_identities_v1 where kind=tg_argv[0] and legacy_key=proof;
      insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at)
        values(identity_id,1,'cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||proof,'sha256'),'hex'),
          'active',clock_timestamp()) on conflict(issuer_id,generation) do nothing;
      return null;
    end $$;
    revoke all on function clued_private.test_issuer_credential_v1() from public,anon,authenticated,service_role;
    drop trigger if exists test_issuer_credential_v1 on clued_private.authorization_issuers_v12;
    create trigger test_issuer_credential_v1 after insert on clued_private.authorization_issuers_v12
      for each row execute function clued_private.test_issuer_credential_v1('authorization');
    drop trigger if exists test_issuer_credential_v1 on clued_private.storage_oauth_apps_v1;
    create trigger test_issuer_credential_v1 after insert on clued_private.storage_oauth_apps_v1
      for each row execute function clued_private.test_issuer_credential_v1('storage');
    insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at)
      select i.id,1,'cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||i.legacy_key,'sha256'),'hex'),
        'active',clock_timestamp() from clued_private.issuer_identities_v1 i
      where not exists(select 1 from clued_private.issuer_credentials_v1 c where c.issuer_id=i.id)
      on conflict(issuer_id,generation) do nothing;
  `);
}

// Source checks follow the exact manifested wrapper to its business implementation. They never skip the
// assertion simply because a function acquired an authentication wrapper, and also work before step 2b.
export async function issuerBusinessDefinition(client,signature) {
  let selected=signature;
  if((await client.query(`select to_regclass('clued_private.issuer_function_sources_v1') is not null ready`)).rows[0].ready){
    const source=(await client.query(`select signature,identity_name from clued_private.issuer_function_sources_v1
      where signature::regprocedure=$1::regprocedure`,[signature])).rows[0];
    if(source?.identity_name)selected=`clued_private.${source.identity_name}${source.signature.slice(source.signature.indexOf('('))}`;
  }
  return (await client.query(`select pg_get_functiondef($1::regprocedure) body`,[selected])).rows[0].body;
}
