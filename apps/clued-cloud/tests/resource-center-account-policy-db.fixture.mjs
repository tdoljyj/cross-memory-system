import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const ACTIONS = ["create_file", "create_topic", "inspect"];

// Called only by the ephemeral embedded-Postgres authority harness. The
// foundation intentionally has no activation API: direct seed SQL below models
// already-reviewed facts in this disposable database, never a deployment path.
export async function testAccountPolicy(t, admin, server, user, decision) {
  const session = randomUUID(), issuer = hash(randomUUID());
  const resource = "https://account-policy.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const native = server.getPgClient(), evaluator = server.getPgClient();
  await native.connect(); await evaluator.connect();
  await evaluator.query("set statement_timeout='8s'");
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session,user]);
  await native.query("set role authenticated");
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user,JSON.stringify({sub:user,session_id:session})]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'account-policy-fixture')", [issuer,resource]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value",
      [user,JSON.stringify({source_decision_id:decision,idempotency_key:randomUUID(),...input})])).rows[0].value;
    assert.equal(result.status,"committed",JSON.stringify(result)); return result;
  };
  const createRoot = async suffix => {
    const root = `/account-policy-${suffix}/Clued_资料中心`, rootId = `policy-root-${suffix}`;
    const registered = await register({action:"profile_register",project_id:project,profile_version:`account-policy/${suffix}`,
      managed_root:root,root_folder_id:rootId,root_parent_id:"policy-parent",root_folder_version:"1"});
    const profile = registered.target_refs.find(ref=>ref.role==="primary").id;
    await register({action:"artifact_register",profile_id:profile,path:root+"/20_P_产品与体验",provider_file_id:`policy-track-${suffix}`,
      provider_file_version:"1",target_kind:"directory",governance_class:"ordinary",delete_authority:false});
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user,JSON.stringify({
      profile_id:profile,base_version:1,allowed_root_children:["20_P_产品与体验"],source_decision_id:decision,idempotency_key:randomUUID()})])).rows[0].value;
    assert.equal(qualified.status,"committed");
    const connected = await account({action:"register",profile_id:profile,source_decision_id:decision,idempotency_key:randomUUID()});
    assert.equal(connected.status,"committed");
    const connection = connected.target_refs.find(ref=>ref.role==="primary").id;
    // Synthetic DB only: no real provider call, credential, or account is used.
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='policy-fixture-subject',oauth_client_id='policy-fixture-client',credential_version=1,credential_envelope='{}' where id=$1",[connection]);
    return {root,rootId,profile,connection,receipt:connected.receipt_id};
  };
  const createBinding = async client => {
    const token = hash(randomUUID());
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [issuer,JSON.stringify({
      request_digest:hash(randomUUID()),client_id:client,client_name:"fixture application",redirect_uri:"https://account-policy.invalid/callback",
      resource,requested_scopes:["context:write"]})])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [issuer,
      prepared.request_id,prepared.version,JSON.stringify([{resource_kind:"scope",resource_id:"project:"+project,environment:"canonical",actions:["write","close"]}]),
      token,new Date(Date.now()+3*3600000).toISOString()])).rows[0].value;
    return {token,binding:approved.binding_id,request:prepared.request_id,client};
  };
  const pid = (await evaluator.query("select pg_backend_pid() pid")).rows[0].pid;
  const waitForLock = async (clientPid=pid) => {
    for (let i=0;i<200;i++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[clientPid])).rows[0].waiting) return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail("account-policy request did not reach its intended lock wait");
  };
  const counters = async () => (await admin.query(`select
    (select count(*)::int from clued_private.storage_jobs_v1) jobs,
    (select count(*)::int from clued_private.resource_center_mutations_v1) intents,
    (select count(*)::int from public.clued_audit_receipts) receipts,
    (select count(*)::int from public.clued_context_events) events`)).rows[0];
  const rollbackOnly = async callback => {
    await admin.query("begin");
    try {return await callback(admin);} finally {await admin.query("rollback");}
  };
  const evaluate = async (binding, root, action="create_file", client=evaluator, job=randomUUID()) =>
    (await client.query("select clued_private.storage_policy_evaluate_v2($1,$2,$3,$4) value",
      [binding.token,root.connection,action,job])).rows[0].value;
  const qualify = async (binding, receipt, previous) => {
    const lineage=previous?.lineage??randomUUID();
    const digest=(await admin.query("select clued_private.storage_client_request_digest_v2($1) value",[binding.request])).rows[0].value;
    if(!previous) {
      await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
        [lineage,issuer,resource,binding.client,digest,receipt]);
    } else assert.equal(digest,previous.digest);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [binding.request,lineage,digest,receipt]);
    const capability=previous?.capability??(await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2) returning id",[lineage,receipt])).rows[0].id;
    return {...binding,lineage,digest,capability};
  };
  const activate = async (root,{manageTransaction=true,expiresAt=null}={}) => {
    const policy=randomUUID();
    if(manageTransaction)await admin.query("begin");
    try {
      await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
        scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,created_at,expires_at)
        select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
          c.source_decision_id,c.decision_version,'reviewed_transition','account-policy-fixture/2',c.receipt_id,clock_timestamp()-interval '2 hours',$3::timestamptz
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`,[policy,root.connection,expiresAt]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1",[policy,root.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[root.connection,policy]);
      if(manageTransaction)await admin.query("commit");
    } catch(error) {if(manageTransaction)await admin.query("rollback");throw error;}
    return {...root,policy};
  };
  const deny = async (client,binding,receipt) => {
    await client.query("select clued_private.storage_client_guard_v2($1,$2,true)",[user,binding.lineage]);
    await client.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)",[user,binding.lineage,receipt]);
  };
  try {
    await t.test("account-policy foundation is private, RLS-protected and grants no API role table or function access",async()=>{
      const tables = ["storage_account_policies_v2","storage_client_registrations_v2","storage_client_request_links_v2",
        "storage_client_capabilities_v2","storage_client_denies_v2","storage_root_denies_v2"];
      for(const table of tables) {
        const acl=(await admin.query(`select c.relrowsecurity,
          has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,
          has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated,
          has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') service,
          exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0) public
          from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_private' and c.relname=$1`,[table])).rows[0];
        assert.ok(acl,table); assert.deepEqual(acl,{relrowsecurity:true,anon:false,authenticated:false,service:false,public:false},table);
        await assert.rejects(native.query(`select * from clued_private.${table}`),/permission denied/);
      }
      for(const signature of ["storage_policy_evaluate_v2(text,uuid,text,uuid)","storage_policy_scope_digest_v2(uuid)",
        "storage_client_request_digest_v2(uuid)","storage_client_guard_v2(uuid,uuid,boolean)",
        "storage_account_legacy_core_v1(jsonb)","clued_storage_account_v1(jsonb)"]) {
        const acl=(await admin.query(`select p.proconfig,
          has_function_privilege('anon',p.oid,'EXECUTE') anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
          has_function_privilege('service_role',p.oid,'EXECUTE') service,
          exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public
          from pg_proc p where p.oid=$1::regprocedure`,["clued_private."+signature])).rows[0];
        assert.equal(acl.anon,false,signature);assert.equal(acl.authenticated,false,signature);
        assert.equal(acl.service,false,signature);assert.equal(acl.public,false,signature);
        assert.ok(acl.proconfig?.some(value=>/^search_path=(""|)$/.test(value)),signature);
      }
      await assert.rejects(native.query("select clued_private.storage_policy_evaluate_v2($1,$2,'inspect',$3)",
        [hash("fake"),randomUUID(),randomUUID()]),/permission denied/);
      const surface=(await admin.query(`select has_function_privilege('anon','public.clued_storage_account_v1(jsonb)','EXECUTE') anon,
        has_function_privilege('authenticated','public.clued_storage_account_v1(jsonb)','EXECUTE') authenticated,
        has_function_privilege('service_role','public.clued_storage_account_v1(jsonb)','EXECUTE') service,
        exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid='public.clued_storage_account_v1(jsonb)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') public`)).rows[0];
      assert.deepEqual(surface,{anon:false,authenticated:true,service:false,public:false});
      await assert.rejects(native.query("select clued_private.storage_account_legacy_core_v1('{\"action\":\"list\"}'::jsonb)"),/permission denied/);
    });
    const first=await createRoot("first"), second=await createRoot("second");
    const bindingA=await qualify(await createBinding("account-policy-client-a"),first.receipt);
    const bindingB=await qualify(await createBinding("account-policy-client-b"),second.receipt);
    const contextOnly=await createBinding("account-policy-context-only");
    await t.test("context identity and reviewed qualification alone cannot authorize a legacy connection",async()=>{
      const before=await counters();
      await assert.rejects(evaluate(bindingA,first),/storage_policy_denied/);
      await assert.rejects(evaluate(contextOnly,first),/storage_policy_denied/);
      assert.equal((await admin.query("select auth_mode,account_policy_id from clued_private.storage_connections_v1 where id=$1",[first.connection])).rows[0].auth_mode,"legacy");
      assert.deepEqual(await counters(),before);
    });
    const rootA=await activate(first), rootB=await activate(second);
    await t.test("native Owner management separates storage-only client revoke from whole-connection disconnect",async()=>{
      const owner = async input => (await native.query("select public.clued_storage_owner_manage_v2($1::jsonb) value",
        [JSON.stringify(input)])).rows[0].value;
      const acl=(await admin.query(`select has_function_privilege('anon','public.clued_storage_owner_manage_v2(jsonb)','EXECUTE') anon,
        has_function_privilege('authenticated','public.clued_storage_owner_manage_v2(jsonb)','EXECUTE') authenticated,
        has_function_privilege('service_role','public.clued_storage_owner_manage_v2(jsonb)','EXECUTE') service`)).rows[0];
      assert.deepEqual(acl,{anon:false,authenticated:true,service:false});
      const isolated=await activate(await createRoot("owner-management"));
      const client=await qualify(await createBinding("owner-management-client"),isolated.receipt);
      const summary=(await owner({action:"connections"})).connections.find(row=>row.id===isolated.connection);
      assert.equal(summary.policy_active,true);assert.equal(summary.root_name,isolated.root);
      assert.equal(summary.database_execution_enabled,false);
      const initial=(await owner({action:"clients"})).clients.find(row=>row.binding_id===client.binding);
      assert.deepEqual({denied:initial.denied,generation:initial.generation},{denied:false,generation:0});
      const authBefore=(await admin.query("select version,revoked_at from clued_private.authorizations_v12 where binding_id=$1",[client.binding])).rows[0];
      const clientRequest={action:"revoke_client",binding_id:client.binding,base_generation:0,idempotency_key:randomUUID()};
      const revoked=await owner(clientRequest);
      assert.equal(revoked.status,"committed");assert.deepEqual(await owner(clientRequest),revoked);
      assert.match(String(revoked.receipt_id),/^[0-9a-f-]{36}$/);
      const denied=(await owner({action:"clients"})).clients.find(row=>row.binding_id===client.binding);
      assert.equal(denied.denied,true);assert.equal(denied.generation,1);assert.equal(denied.receipt_id,revoked.receipt_id);
      await assert.rejects(evaluate(client,isolated),/storage_policy_denied/);
      const replacement=await qualify(await createBinding(client.client),isolated.receipt,client);
      await assert.rejects(evaluate(replacement,isolated),/storage_policy_denied/);
      assert.deepEqual((await admin.query("select version,revoked_at from clued_private.authorizations_v12 where binding_id=$1",[client.binding])).rows[0],authBefore);
      assert.equal((await evaluate(bindingB,isolated)).binding_id,bindingB.binding);
      const stopRequest={action:"disconnect",connection_id:isolated.connection,base_version:summary.version,idempotency_key:randomUUID()};
      const stopped=await owner(stopRequest);
      assert.equal(stopped.status,"committed");assert.deepEqual(await owner(stopRequest),stopped);
      const latest=(await owner({action:"connections"})).connections.find(row=>row.id===isolated.connection);
      assert.equal(latest.state,"revoked");assert.equal(latest.auth_mode,"revoked");
      assert.equal(latest.policy_active,false);assert.equal(latest.refresh_enabled,false);
      const rows=(await admin.query(`select
        (select count(*)::int from clued_private.storage_root_denies_v2 where owner_id=$1 and provider='google-drive'
          and provider_subject='policy-fixture-subject' and root_folder_id=$2 and lineage_id is null and denied) roots,
        (select count(*)::int from clued_private.storage_account_policies_v2 where id=$3 and state='revoked' and revocation_receipt_id=$4) policies`,
        [user,isolated.rootId,isolated.policy,stopped.receipt_id])).rows[0];
      assert.deepEqual(rows,{roots:1,policies:1});
      await assert.rejects(evaluate(bindingB,isolated),/storage_policy_denied/);
      assert.equal((await evaluate(bindingB,rootA)).binding_id,bindingB.binding);
      await assert.rejects(owner({...stopRequest,idempotency_key:randomUUID()}),/storage_owner_version_conflict/);
      await assert.rejects(owner({...clientRequest,idempotency_key:randomUUID()}),/storage_owner_version_conflict/);
    });
    await t.test("one account policy admits two qualified clients without per-Binding storage grants or new OAuth scopes",async()=>{
      const before=await counters();
      for(const binding of [bindingA,bindingB]) for(const action of ACTIONS) {
        const view=await evaluate(binding,rootA,action);
        assert.deepEqual(Object.keys(view).sort(),["policy_id","policy_generation","policy_receipt_id","scope_digest","capability_id","capability_version",
          "registration_lineage","registration_generation","binding_id","authorization_version","owner_id","connection_id","profile_id","profile_version","auth_generation","actions"].sort());
        assert.equal(view.policy_id,rootA.policy);assert.equal(view.policy_generation,1);assert.equal(view.auth_generation,1);
        assert.equal(view.policy_receipt_id,rootA.receipt);assert.equal(view.binding_id,binding.binding);assert.equal(view.owner_id,user);
        assert.equal(view.capability_id,binding.capability);assert.equal(view.capability_version,1);
        assert.deepEqual(view.actions.slice().sort(),ACTIONS);assert.match(view.scope_digest,/^[0-9a-f]{64}$/);
      }
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_grants_v1 where connection_id=any($1::uuid[])",[[rootA.connection,rootB.connection]])).rows[0].n,0);
      assert.deepEqual(await counters(),before);
    });
    await t.test("fixed base actions reject destructive operations, invalid shapes and unknown clients without effects",async()=>{
      const before=await counters();
      for(const action of ["delete","replace","move","rename","write","create","*","",null])
        await assert.rejects(evaluate(bindingA,rootA,action),/storage_policy_denied/);
      await assert.rejects(evaluate(contextOnly,rootA),/storage_policy_denied/);
      await assert.rejects(evaluate({...bindingA,token:hash("unknown")},rootA),/storage_policy_denied/);
      await assert.rejects(evaluate(bindingA,{...rootA,connection:randomUUID()}),/storage_policy_denied/);
      await assert.rejects(evaluate(bindingA,rootA,"inspect",evaluator,null),/storage_policy_denied/);
      await rollbackOnly(async client=>{
        await assert.rejects(client.query("update clued_private.storage_account_policies_v2 set actions=array['inspect','create_file','create_topic','delete'] where id=$1",[rootA.policy]),/storage_policy_immutable|check constraint/);
      });
      assert.deepEqual(await counters(),before);
    });
    await t.test("account policy lasts beyond one hour and is independent of credential or ordinary connection versions",async()=>{
      const before=await evaluate(bindingA,rootA), effects=await counters();
      const row=(await admin.query("select expires_at,created_at<clock_timestamp()-interval '1 hour' old from clued_private.storage_account_policies_v2 where id=$1",[rootA.policy])).rows[0];
      assert.equal(row.expires_at,null);assert.equal(row.old,true);
      await admin.query("update clued_private.storage_connections_v1 set version=version+1,credential_version=credential_version+1,credential_envelope='{\"fixture\":\"rotated\"}' where id=$1",[rootA.connection]);
      assert.deepEqual(await evaluate(bindingA,rootA),before);
      assert.deepEqual(await counters(),effects);
    });
    await t.test("new topic and metadata versions preserve scope, but track identity or root drift does not",async()=>{
      const before=await evaluate(bindingA,rootA);
      await register({action:"artifact_register",profile_id:rootA.profile,path:rootA.root+"/20_P_产品与体验/主题",provider_file_id:"policy-topic-first",
        provider_file_version:"1",target_kind:"directory",governance_class:"ordinary",delete_authority:false});
      assert.deepEqual(await evaluate(bindingA,rootA),before);
      await rollbackOnly(async client=>{
        await client.query("update clued_private.resource_center_artifacts_v1 set version=version+1,provider_file_version='2' where profile_id=$1",[rootA.profile]);
        assert.deepEqual(await evaluate(bindingA,rootA,"inspect",client),before);
      });
      for(const change of [
        ["update clued_private.resource_center_artifacts_v1 set provider_file_id='policy-replaced-track' where profile_id=$1 and path=$2",[rootA.profile,rootA.root+"/20_P_产品与体验"]],
        ["update clued_private.resource_center_profiles_v1 set root_parent_id='different-parent' where id=$1",[rootA.profile]],
        ["update clued_private.resource_center_profiles_v1 set version=version+1 where id=$1",[rootA.profile]],
      ]) await rollbackOnly(async client=>{await client.query(...change);await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);});
    });
    await t.test("wrong owner, registration metadata drift, unlinked re-registration and revoked issuer are denied",async()=>{
      const before=await counters(), other=randomUUID();
      await admin.query("insert into auth.users(id,email) values($1,'policy-other@example.invalid')",[other]);
      await rollbackOnly(async client=>{
        await client.query("update public.clued_agent_bindings set user_id=$2 where id=$1",[bindingA.binding,other]);
        await client.query("update clued_private.authorizations_v12 set owner_id=$2 where binding_id=$1",[bindingA.binding,other]);
        await client.query("update clued_private.authorization_requests_v12 set owner_id=$2 where id=$1",[bindingA.request,other]);
        await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);
      });
      for(const column of ["redirect_uri","client_name","resource"]) await rollbackOnly(async client=>{
        await client.query(`update clued_private.authorization_requests_v12 set ${column}=$2 where id=$1`,[bindingA.request,"https://changed.invalid/"]);
        await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);
      });
      await rollbackOnly(async client=>{
        await client.query("update clued_private.authorization_issuers_v12 set revoked_at=clock_timestamp() where token_hash=$1",[issuer]);
        await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);
      });
      const replacement=await createBinding(bindingA.client);
      await assert.rejects(evaluate(replacement,rootA),/storage_policy_denied/);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_jobs_v1")).rows[0].n,before.jobs);
      assert.equal((await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1")).rows[0].n,before.intents);
    });
    await t.test("registration snapshots, policy identity and policy lifecycle cannot be silently rewritten",async()=>{
      for(const change of [
        ["update clued_private.storage_client_registrations_v2 set metadata_digest=$2 where lineage_id=$1",[bindingA.lineage,hash("drift")]],
        ["update clued_private.storage_client_request_links_v2 set metadata_digest=$2 where request_id=$1",[bindingA.request,hash("drift")]],
        ["update clued_private.storage_account_policies_v2 set scope_digest=$2 where id=$1",[rootA.policy,hash("drift")]],
        ["update clued_private.storage_account_policies_v2 set state='pending' where id=$1",[rootA.policy]],
        ["delete from clued_private.storage_account_policies_v2 where id=$1",[rootA.policy]],
      ]) await rollbackOnly(async client=>{await assert.rejects(client.query(...change),/storage_registration_immutable|storage_policy_immutable|storage_policy_history_immutable/);});
      await rollbackOnly(async client=>{
        await client.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,2,$2,$3,$4,$5,$6)",
          [bindingA.lineage,issuer,resource,bindingA.client,bindingA.digest,rootA.receipt]);
        await client.query("update clued_private.storage_client_capabilities_v2 set registration_generation=2,version=version+1,receipt_id=$2 where id=$1",[bindingA.capability,rootB.receipt]);
        await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);
      });
    });
    await t.test("database constraints prevent dual authority, partial cutover and rollback to legacy",async()=>{
      await rollbackOnly(async client=>{
        await assert.rejects(client.query("update clued_private.storage_connections_v1 set auth_mode='legacy',account_policy_id=null,auth_generation=auth_generation+1 where id=$1",[rootA.connection]),/storage_auth_mode_conflict/);
      });
      await rollbackOnly(async client=>{
        await assert.rejects(client.query("update clued_private.storage_connections_v1 set auth_generation=auth_generation+1 where id=$1",[rootA.connection]),/storage_auth_mode_conflict/);
      });
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1",[rootA.policy,rootB.receipt]);
        await assert.rejects(client.query("set constraints all immediate"),/storage_auth_mode_inconsistent/);
      });
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_connections_v1 set account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[rootA.connection,rootB.policy]);
        await assert.rejects(client.query("set constraints all immediate"),/storage_auth_mode_inconsistent/);
      });
    });
    await t.test("root deny is exact while policy, capability, Decision and Binding revocation refuse new evaluation",async()=>{
      const before=await counters();
      await rollbackOnly(async client=>{
        await client.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,receipt_id) values($1,'google-drive','policy-fixture-subject',$2,$3)",
          [user,rootA.rootId,rootA.receipt]);
        await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);
      });
      await rollbackOnly(async client=>{
        await client.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','policy-fixture-subject',$2,$3,$4)",
          [user,rootA.rootId,bindingA.lineage,rootA.receipt]);
        assert.equal((await evaluate(bindingB,rootA,"inspect",client)).binding_id,bindingB.binding);
        assert.equal((await evaluate(bindingA,rootB,"inspect",client)).connection_id,rootB.connection);
      });
      for(const change of [
        ["update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1",[bindingA.binding]],
        ["update clued_private.authorizations_v12 set revoked_at=clock_timestamp(),version=version+1 where binding_id=$1",[bindingA.binding]],
        ["update public.clued_memories set version=version+1 where id=$1",[decision]],
        ["update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1",[bindingA.capability,rootB.receipt]],
      ]) await rollbackOnly(async client=>{await client.query(...change);await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);});
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1",[rootA.policy,rootB.receipt]);
        await client.query("update clued_private.storage_connections_v1 set auth_mode='revoked',auth_generation=auth_generation+1,state='revoked',revoked_at=clock_timestamp() where id=$1",[rootA.connection]);
        await client.query("set constraints all immediate");
        await assert.rejects(evaluate(bindingA,rootA,"inspect",client),/storage_policy_denied/);
      });
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1",[rootA.policy,rootB.receipt]);
        await assert.rejects(client.query("update clued_private.storage_account_policies_v2 set state='active',revoked_at=null,revocation_receipt_id=null where id=$1",[rootA.policy]),/storage_policy_immutable/);
      });
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1",[bindingA.capability,rootB.receipt]);
        // Even a fresh receipt and incremented version cannot reactivate the
        // original revoked qualification row or make old snapshots current.
        await assert.rejects(client.query("update clued_private.storage_client_capabilities_v2 set state='active',revoked_at=null,version=version+1,receipt_id=$2 where id=$1",[bindingA.capability,rootA.receipt]),
          /storage_capability_immutable|storage_capability_revoked|storage_capability_version_conflict/);
      });
      assert.deepEqual(await counters(),before);
    });
    await t.test("requalified capability uses a fresh identity and monotonic generation without reviving its revoked predecessor",async()=>{
      const before=await counters();
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1",[bindingA.capability,rootB.receipt]);
        const successor=(await client.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,version,receipt_id) values($1,1,3,$2) returning id",[bindingA.lineage,rootA.receipt])).rows[0].id;
        const result=await evaluate(bindingA,rootA,"inspect",client);
        assert.equal(result.capability_id,successor);assert.equal(result.capability_version,3);
        assert.equal(result.policy_id,rootA.policy);assert.equal(result.policy_generation,1);
        const old=(await client.query("select state,version from clued_private.storage_client_capabilities_v2 where id=$1",[bindingA.capability])).rows[0];
        assert.deepEqual(old,{state:"revoked",version:"2"});
      });
      await rollbackOnly(async client=>{
        await client.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1",[bindingA.capability,rootB.receipt]);
        await assert.rejects(client.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,version,receipt_id) values($1,1,1,$2)",[bindingA.lineage,rootA.receipt]),
          /storage_capability_version_conflict|duplicate key value|storage_capability_generation/);
      });
      await rollbackOnly(async client=>{
        await assert.rejects(client.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,version,receipt_id) values($1,1,2,$2)",[bindingA.lineage,rootB.receipt]),
          /storage_capability_version_conflict|duplicate key value|storage_capability_generation/);
      });
      assert.deepEqual(await counters(),before);
    });
    await t.test("nonlegacy policy cannot be bypassed through old client grant, revoke or job RPCs",async()=>{
      const before=await counters();
      const base=Number((await admin.query("select version from clued_private.storage_connections_v1 where id=$1",[rootA.connection])).rows[0].version);
      for(const action of ["grant_client","revoke_client","revoke_connection"]) {
        const input={action,connection_id:rootA.connection,base_version:base,idempotency_key:randomUUID()};
        if(action!=="revoke_connection")input.binding_id=bindingA.binding;
        if(action==="grant_client")Object.assign(input,{authorization_version:1,actions:ACTIONS,expires_at:new Date(Date.now()+1800000).toISOString()});
        await assert.rejects(account(input),/storage_legacy_mode_denied/);
      }
      await assert.rejects(admin.query("select clued_private.storage_binding_v1($1,$2,'inspect')",[bindingA.token,rootA.connection]),/storage_binding_denied/);
      await assert.rejects(admin.query("select public.clued_storage_jobs_v1($1,$2::jsonb)",[bindingA.token,JSON.stringify({action:"submit",connection_id:rootA.connection,
        job_id:randomUUID(),mutation:{operation:"create",target_kind:"file",destination_path:rootA.root+"/20_P_产品与体验/not-written.txt",content:"fixture"}})]),/storage_binding_denied/);
      assert.deepEqual(await counters(),before);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_grants_v1 where connection_id=$1",[rootA.connection])).rows[0].n,0);
    });
    await t.test("all old cloud execution and provider recovery branches reject account-policy mode before disclosing credentials or mutating jobs",async()=>{
      const appIssuer=hash(randomUUID()), job=randomUUID();
      // Synthetic stale job only. The future transition contract must refuse
      // live jobs; mode fencing is defense in depth even if one remains.
      await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,'policy-fixture-client','https://account-policy.invalid/storage/google/callback',true)",[appIssuer]);
      await admin.query(`insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,receipt_id)
        values($1,$2,$3,$4,$5,1,$6,$7::jsonb,$5)`,[user,job,rootA.connection,bindingA.binding,rootA.receipt,hash("stale-policy-job"),JSON.stringify({
          operation:"create",destination_path:rootA.root+"/20_P_产品与体验/stale-not-written.txt",target_kind:"file",content:"fixture"})]);
      const before=await counters(), row=(await admin.query("select to_jsonb(j) value from clued_private.storage_jobs_v1 j where owner_id=$1 and job_id=$2",[user,job])).rows[0].value;
      for(const action of ["load","authority","begin","provider_attempt","finalize","report","recovery_load","recovery_finalize"]) {
        const request={action,connection_id:rootA.connection,job_id:job};
        if(!["load","recovery_load"].includes(action))request.credential_version=2;
        const field={authority:"request",begin:"prepare",provider_attempt:"attempt",finalize:"finish",report:"outcome",recovery_finalize:"finish"}[action];
        if(field)request[field]=action==="report"?{status:"denied"}:{};
        await assert.rejects(admin.query("select public.clued_storage_cloud_worker_v1($1,$2::jsonb)",[appIssuer,JSON.stringify(request)]),
          ["load","authority","begin"].includes(action)?/storage_binding_denied/:/storage_legacy_mode_denied/);
      }
      await assert.rejects(admin.query("select clued_private.storage_connection_recovery_v1($1,$2)",[rootA.connection,user]),/storage_connection_unavailable/);
      assert.deepEqual(await counters(),before);
      assert.deepEqual((await admin.query("select to_jsonb(j) value from clued_private.storage_jobs_v1 j where owner_id=$1 and job_id=$2",[user,job])).rows[0].value,row);
    });
    await t.test("an old native grant waiting at the root rechecks a winning account-policy cutover",async()=>{
      const root=await createRoot("cutover-race"), before=await counters();
      const nativePid=(await native.query("select pg_backend_pid() pid")).rows[0].pid;let pending;
      await admin.query("begin");
      try {
        await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[user+":"+root.rootId]);
        pending=account({action:"grant_client",connection_id:root.connection,base_version:1,binding_id:bindingA.binding,authorization_version:1,
          actions:ACTIONS,expires_at:new Date(Date.now()+1800000).toISOString(),idempotency_key:randomUUID()}).then(value=>({value}),error=>({error}));
        await waitForLock(nativePid);await activate(root,{manageTransaction:false});await admin.query("commit");
        assert.match((await pending).error?.message??"",/storage_legacy_mode_denied/);
      } finally {await admin.query("rollback");if(pending)await pending;}
      assert.deepEqual(await counters(),before);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_grants_v1 where connection_id=$1",[root.connection])).rows[0].n,0);
    });
    await t.test("explicit account-policy expiry also uses the wall clock after a root lock wait",async()=>{
      const root=await activate(await createRoot("policy-expiry"),{expiresAt:new Date(Date.now()+1200).toISOString()}), before=await counters();let pending;
      await admin.query("begin");
      try {
        await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[user+":"+root.rootId]);
        pending=evaluate(bindingA,root).then(value=>({value}),error=>({error}));await waitForLock();
        await admin.query("select pg_sleep(greatest(0,extract(epoch from (expires_at-clock_timestamp())))+0.02) from clued_private.storage_account_policies_v2 where id=$1",[root.policy]);
        await admin.query("commit");assert.match((await pending).error?.message??"",/storage_policy_denied/);
      } finally {await admin.query("rollback");if(pending)await pending;}
      assert.deepEqual(await counters(),before);
    });
    await t.test("Binding expiry is rechecked after a real provider-root lock wait",async()=>{
      const original=(await admin.query("select expires_at from clued_private.authorizations_v12 where binding_id=$1",[bindingA.binding])).rows[0].expires_at;
      const before=await counters();let pending;
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '1 second' where binding_id=$1",[bindingA.binding]);
      await admin.query("begin");
      try {
        await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[user+":"+rootA.rootId]);
        pending=evaluate(bindingA,rootA).then(value=>({value}),error=>({error}));
        await waitForLock();
        await admin.query("select pg_sleep(greatest(0,extract(epoch from (expires_at-clock_timestamp())))+0.02) from clued_private.authorizations_v12 where binding_id=$1",[bindingA.binding]);
        await admin.query("commit");assert.match((await pending).error?.message??"",/storage_policy_denied/);
      } finally {await admin.query("rollback");if(pending)await pending;await admin.query("update clued_private.authorizations_v12 set expires_at=$2 where binding_id=$1",[bindingA.binding,original]);}
      assert.deepEqual(await counters(),before);
    });
    await t.test("global deny wins an absent-row insertion race and survives new Binding and connection IDs",async()=>{
      const before=await counters();let pending;
      await admin.query("begin");
      try {
        await deny(admin,bindingA,rootA.receipt);
        pending=evaluate(bindingA,rootA).then(value=>({value}),error=>({error}));
        await waitForLock();await admin.query("commit");
        assert.match((await pending).error?.message??"",/storage_policy_denied/);
      } finally {await admin.query("rollback");if(pending)await pending;}
      const replacement=await qualify(await createBinding(bindingA.client),rootB.receipt,bindingA);
      for(const binding of [bindingA,replacement]) for(const root of [rootA,rootB])
        await assert.rejects(evaluate(binding,root),/storage_policy_denied/);
      assert.equal((await evaluate(bindingB,rootA)).binding_id,bindingB.binding);
      assert.equal((await evaluate(bindingB,rootB)).binding_id,bindingB.binding);
      const a=(await admin.query("select revoked_at,version from clued_private.authorizations_v12 where binding_id=$1",[bindingA.binding])).rows[0];
      assert.equal(a.revoked_at,null);assert.equal(a.version,"1");
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_jobs_v1")).rows[0].n,before.jobs);
      assert.equal((await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1")).rows[0].n,before.intents);
    });
    await t.test("evaluator-winning lineage guard serializes later storage-only revoke until transaction completion",async()=>{
      const revoker=server.getPgClient();await revoker.connect();await revoker.query("set statement_timeout='8s'");
      const revokerPid=(await revoker.query("select pg_backend_pid() pid")).rows[0].pid;let pending;
      try {
        await evaluator.query("begin");
        assert.equal((await evaluate(bindingB,rootA)).binding_id,bindingB.binding);
        await revoker.query("begin");pending=deny(revoker,bindingB,rootB.receipt).then(value=>({value}),error=>({error}));
        await waitForLock(revokerPid);
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_denies_v2 where owner_id=$1 and lineage_id=$2",[user,bindingB.lineage])).rows[0].n,0);
        await evaluator.query("commit");assert.equal((await pending).error,undefined);await revoker.query("commit");
        await assert.rejects(evaluate(bindingB,rootA),/storage_policy_denied/);
      } finally {await evaluator.query("rollback");await revoker.query("rollback");if(pending)await pending;await revoker.end();}
    });
    await t.test("ordinary account refresh rotates only credentials and cannot revive storage deny or change policy authority",async()=>{
      const appIssuer=(await admin.query("select issuer_hash from clued_private.storage_oauth_apps_v1 where oauth_client_id='policy-fixture-client'")).rows[0].issuer_hash;
      const owner=async input=>(await native.query("select public.clued_storage_refresh_manage_v1($1::jsonb) value",[JSON.stringify(input)])).rows[0].value;
      const worker=async input=>(await admin.query("select public.clued_storage_refresh_worker_v1($1,$2::jsonb) value",[appIssuer,JSON.stringify(input)])).rows[0].value;
      const status=await owner({action:"status",connection_id:rootB.connection});
      assert.equal((await owner({action:"enable",connection_id:rootB.connection,base_version:status.connection_version,delegation_version:status.version,
        until_revoked:true,idempotency_key:randomUUID()})).status,"committed");
      const authority=async()=>(await admin.query(`select
        (select to_jsonb(p) from clued_private.storage_account_policies_v2 p where p.id=$1) policy,
        (select jsonb_build_object('auth_mode',c.auth_mode,'auth_generation',c.auth_generation,'account_policy_id',c.account_policy_id) from clued_private.storage_connections_v1 c where c.id=$2) mode,
        (select jsonb_agg(to_jsonb(d) order by d.lineage_id) from clued_private.storage_client_denies_v2 d where d.owner_id=$3) denies`,[rootB.policy,rootB.connection,user])).rows[0];
      const before=await authority(), counts=await counters();
      const requestsBefore=(await admin.query("select count(*)::int n from clued_private.storage_refresh_attempts_v1 where connection_id=$1",[rootB.connection])).rows[0].n;
      await assert.rejects(worker({action:"claim",connection_id:rootB.connection,attempt_id:randomUUID(),recovery_job_id:randomUUID()}),/storage_refresh_denied/);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_refresh_attempts_v1 where connection_id=$1",[rootB.connection])).rows[0].n,requestsBefore);
      assert.deepEqual(await counters(),counts);
      const request={action:"claim",connection_id:rootB.connection,attempt_id:randomUUID()}, claimed=await worker(request);
      assert.equal(claimed.status,"acquired");
      const envelope={contract:"clued.storage-credential/1",key_id:"fixture",nonce:"A".repeat(16),ciphertext:"B".repeat(24)};
      const complete={action:"commit",connection_id:rootB.connection,attempt_id:request.attempt_id,credential_envelope:envelope,expires_at:new Date(Date.now()+3600000).toISOString()};
      const committed=await worker(complete);assert.equal(committed.status,"committed");
      assert.deepEqual(await worker(complete),committed);
      assert.deepEqual(await authority(),before);
      assert.equal((await admin.query("select credential_version from clued_private.storage_connections_v1 where id=$1",[rootB.connection])).rows[0].credential_version,String(Number(claimed.credential_version)+1));
      for(const binding of [bindingA,bindingB])await assert.rejects(evaluate(binding,rootB),/storage_policy_denied/);
      const after=await counters();assert.equal(after.jobs,counts.jobs);assert.equal(after.intents,counts.intents);
      assert.equal(after.receipts,counts.receipts+1);assert.equal(after.events,counts.events+1);
    });
  } finally {
    await evaluator.query("rollback");
    await evaluator.end(); await native.end();
  }
}
