// The release door is the database login (migration 20261119130000_release_door_db_identity_v1). A test
// database applies every migration at once, so that migration's install meets no live release-door role and
// registers no release identity; the door then fails its probe. This does what the install did in
// production: mark the given Binding release-door and run the migration's own install function, which
// registers that Binding's account as the release identity and revokes the Binding. Call it with the owner
// connection after the migrations (and after allowRawTestBindings).

export const RELEASE_REPOSITORY = 'tdoljyj/cross-memory-system';

export async function installReleaseIdentityFixture(admin, bindingId, repository = RELEASE_REPOSITORY) {
  await admin.query(`with b as (select id,user_id from public.clued_agent_bindings where id=$1),
    r as (insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      select b.user_id,null,'global','binding_role_set','binding_role',b.id::text||':release-door',1,
        jsonb_build_object('receipt_kind','BINDING_ROLE_GRANTED','binding_id',b.id,'role','release-door',
          'principal','database_test_fixture') from b returning id,user_id)
    insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      select r.user_id,$1,'release-door',now(),r.id from r`, [bindingId]);
  const installed = (await admin.query('select clued_private.release_door_install_v1($1) v', [repository])).rows[0].v;
  if (installed?.installed !== true) throw new Error(`release identity not installed: ${JSON.stringify(installed)}`);
  return installed;
}

// The release workflow's call: the database login, no token.
export async function releaseDoor(admin, input) {
  return (await admin.query('select clued_private.release_door_v1($1) v', [input])).rows[0].v;
}
