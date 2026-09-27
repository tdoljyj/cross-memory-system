import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');

// Seed through the pre-upgrade API, then verify against the actual migration.
export async function seedRefreshUpgrade(admin,server) {
  const user=randomUUID(),project=randomUUID(),decision=randomUUID(),session=randomUUID(),issuer=hash(randomUUID());
  await admin.query("insert into auth.users(id,email) values($1,'upgrade@example.invalid')",[user]);
  await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Upgrade','upgrade',$3,'confirmed',now())",[project,user,'project:'+project]);
  await admin.query("insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Fixture','Fixture only','project',$3,'decision','active',1,'active',$4,'{\"rationale\":\"Fixture\"}','{}','{}','user_explicit','Fixture')",[decision,user,project,'project:'+project]);
  await admin.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,user]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,'upgrade-fixture','https://clued.invalid/storage/google/callback')",[issuer]);
  const envelope={contract:'clued.storage-credential/1',key_id:'fixture',nonce:'A'.repeat(16),ciphertext:'B'.repeat(24)};
  const native=await client(server,user,session),connections=[];
  try {
    for(const disabled of [false,true]) {
      const suffix=randomUUID();
      const profile=(await admin.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) value',[user,JSON.stringify({action:'profile_register',project_id:project,profile_version:suffix,
        managed_root:'/upgrade/'+suffix+'/Clued_资料中心',root_folder_id:suffix,root_parent_id:'fixture-parent',root_folder_version:'1',source_decision_id:decision,idempotency_key:randomUUID()})])).rows[0].value;
      assert.equal(profile.status,'committed');
      const registration=await rpc(native,'clued_storage_account_v1',{action:'register',profile_id:profile.target_refs[0].id,source_decision_id:decision,idempotency_key:randomUUID()});
      const id=registration.target_refs[0].id,state_hash=hash(randomUUID());
      await native.query('select public.clued_storage_oauth_v1($1,$2::jsonb)',[issuer,JSON.stringify({action:'prepare',connection_id:id,connection_version:1,attempt_id:randomUUID(),state_hash,verifier_envelope:envelope})]);
      if(disabled) await rpc(native,'clued_storage_refresh_manage_v1',{action:'disable',connection_id:id,base_version:1,delegation_version:0,idempotency_key:randomUUID()});
      connections.push({id,state_hash});
    }
  } finally {await native.end();}
  return {user,session,issuer,envelope,connections};
}
async function client(server,user,session) {
  const native=server.getPgClient();await native.connect();await native.query('set role authenticated');
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify({sub:user,session_id:session})]);
  return native;
}
async function rpc(db,fn,input){return (await db.query('select public.'+fn+'($1::jsonb) value',[JSON.stringify(input)])).rows[0].value;}
export async function verifyRefreshUpgrade(admin,server,f) {
  const native=await client(server,f.user,f.session);
  const oauth=async input=>(await native.query('select public.clued_storage_oauth_v1($1,$2::jsonb) value',[f.issuer,JSON.stringify(input)])).rows[0].value;
  try {
    for(const c of f.connections) {
      const before=(await admin.query('select refresh_default_blocked,credential_version from clued_private.storage_connections_v1 where id=$1',[c.id])).rows[0];
      assert.equal(before.refresh_default_blocked,true);assert.equal(before.credential_version,'0');
      assert.equal((await admin.query('select default_refresh_consent from clued_private.storage_oauth_attempts_v1 where state_hash=$1',[c.state_hash])).rows[0].default_refresh_consent,false);
      assert.equal((await oauth({action:'describe',connection_id:c.id})).default_refresh_eligible,false);
      await assert.rejects(oauth({action:'prepare',connection_id:c.id,connection_version:1,attempt_id:randomUUID(),state_hash:hash(randomUUID()),verifier_envelope:f.envelope,default_refresh_consent:true}),/storage_default_refresh_unavailable/);
      await oauth({action:'claim',state_hash:c.state_hash});
      const completed=await oauth({action:'complete',state_hash:c.state_hash,provider_subject:'fixture-upgrade-subject',credential_envelope:f.envelope});
      assert.equal(completed.refresh_enabled,false); assert.equal(completed.refresh_receipt_id,undefined);
      assert.equal((await rpc(native,'clued_storage_refresh_manage_v1',{action:'status',connection_id:c.id})).enabled,false);
      assert.equal((await admin.query('select count(*) n from clued_private.storage_refresh_delegations_v1 where connection_id=$1',[c.id])).rows[0].n,'0');
    }
  } finally {await native.end();}
}
