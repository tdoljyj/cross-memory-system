import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { digest, schedulingFixture, uuid } from './ci-scheduling-stage1-fixture.mjs';
import { setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// Sign real requests and bridge only the server's two fixed PostgREST calls
// to the isolated cluster. No network, browser session or production secrets.
test('connection renewal from serving Worker through the migrated database', {timeout: 900000}, async t => {
  const f = await schedulingFixture({through:'20261118213000_work_claim_pr_merged_event_v1.sql'});
  const migration = await readFile(new URL('../supabase/migrations/20261119033000_ci_connection_renew_v1.sql', import.meta.url), 'utf8');
  const contract = async () => JSON.parse(await readFile(new URL('../worker/ci-connection-renew.contract.json', import.meta.url), 'utf8'));
  try {
    const sql = async (q, args) => (await f.admin.query(q, args)).rows[0];
    // Give the migration its own fleet node. Upgrade tests register a different
    // node on f.binding and expect that CI binding to survive role rotation.
    const fleetBinding=await binding('migration-fleet');
    f.committed(await f.native('clued_ci_node_registration_v1',{...f.registration(),binding_id:fleetBinding.binding_id}));
    async function trialMigration(prepare, expected) {
      await f.admin.query('begin');
      try {
        await prepare();
        await assert.rejects(f.admin.query(migration), expected);
      } finally { await f.admin.query('rollback'); }
    }
    await t.test('H1 refuses installation on a fleet without its standing Decision', async () => {
      await trialMigration(async () => {}, /CI_RENEW_STANDING_DECISION/);
    });
    const decision = '26490bf6' + uuid().slice(8);
    await sql(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Renew','Fixture only','project',$3,'decision','active',1,'active',$4,'{"rationale":"Fixture"}','{}','{}','user_explicit','Owner confirmed')`,
      [decision,f.user,f.project,'project:'+f.project]);
    await t.test('H1 refuses a Decision outside the registered fleet scope', async () => {
      await trialMigration(() => sql('update public.clued_memories set canonical_scope=$1 where id=$2',
        ['project:'+f.project2,decision]), /CI_RENEW_STANDING_DECISION/);
    });
    await t.test('L6 refuses to patch a Grant page with a duplicate anchor', async () => {
      await trialMigration(async () => {
        const {body} = await sql("select pg_get_functiondef('public.clued_owner_request_v1(text,jsonb)'::regprocedure) body");
        const anchor = "in ('repo.protected_change','ci.resident_upgrade')";
        assert.ok(body.includes(anchor));
        await f.admin.query(body.replace(anchor, anchor+' /* '+anchor+' */'));
      }, /CI_RENEW_GRANT_PAGE_CHANGED/);
    });
    await f.admin.query(migration);
    await t.test('replaying the migration preserves its original standing authority',async () => {
      await f.admin.query('begin');
      try {
        await f.admin.query(migration);
        assert.equal((await sql('select decision_id from clued_private.ci_renew_standing_decision_v1')).decision_id,decision);
        await sql('delete from clued_private.ci_renew_standing_decision_v1');
        await f.admin.query(migration);
        assert.equal(await sql('select decision_id from clued_private.ci_renew_standing_decision_v1'),undefined);
      } finally {await f.admin.query('rollback');}
    });
    const worker = await loadContinuityWorker();
    await setWorkerGatewayCaller(f.gateway);
    const gateway = async (q, args) => (await f.gateway.query(q, args)).rows[0].v;
    const calls = [];
    const allowed = { limit: async () => ({success:true}) };
    const env = {CLUED_DB_GATEWAY_TOKEN:'fixture-gateway', CI_RENEW_SOURCE_LIMIT:allowed, CI_RENEW_IDENTITY_LIMIT:allowed};
    let beforeCommit;
    let nextSource = 1;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const rpc = new URL(url).pathname.split('/').pop();
      const p = JSON.parse(init.body);
      calls.push(rpc);
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-gateway');
      assert.ok(new Headers(init.headers).get('apikey'));
      if (rpc === 'clued_ci_connection_renew_trust_v1')
        return Response.json(await gateway('select public.clued_ci_connection_renew_trust_v1($1,$2,$3,$4) v',
          [p.p_project_id, p.p_node_id, p.p_fingerprint, p.p_source]));
      assert.equal(rpc, 'clued_ci_connection_renew_v1');
      if (beforeCommit) await beforeCommit();
      return Response.json(await gateway('select public.clued_ci_connection_renew_v1($1) v', [p.p_input]));
    });
    async function binding(label, scope='project:'+f.project) {
      const selected = [{resource_kind:'scope',resource_id:scope,environment:'canonical',actions:['read']}];
      const preview = await f.native('clued_headless_binding_confirmation_issue_v1', {label,days:30,selected});
      return f.committed(await f.native('clued_headless_binding_issue_v1', {
        confirmation_token:preview.confirmation_token,view_digest:preview.view_digest}));
    }
    async function setup(kind='ci', rotate=false, scope='project:'+f.project) {
      const pair = generateKeyPairSync('ec', {namedCurve:'P-256'});
      const name = 'Node-' + uuid();
      let old = await binding(name.toLowerCase(),scope);
      if (rotate) {
        const {bindings} = await f.native('clued_authorization_manage_v12', {op:'list'});
        const state = bindings.find(b => b.binding_id === old.binding_id);
        const preview = await f.native('clued_headless_binding_confirmation_issue_v1', {
          label:name.toLowerCase()+' rotated', days:90, selected:[], replaces_binding_id:old.binding_id,
          selection_format:'sources_v1', sources:state.sources.map(s => ({
            source_id:s.source_id,base_version:s.version,action_cap:s.actions})), exceptions:[]
        });
        assert.equal(preview.status,'issued',JSON.stringify(preview));
        old = f.committed(await f.native('clued_headless_binding_issue_v1', {
          confirmation_token:preview.confirmation_token,view_digest:preview.view_digest}));
      }
      const jwk = pair.publicKey.export({format:'jwk'});
      const n = f.committed(await f.native('clued_ci_node_registration_v1',
        {...f.registration(), name, binding_id:kind === 'ci' ? old.binding_id : f.binding, identity_public_jwk:jwk}));
      if (kind === 'upgrade')
        await sql(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,effective_at,granted_receipt_id)
          values($1,$2,'resident-upgrade',now(),now(),$3)`, [f.user,old.binding_id,old.receipt_id]);
      const fp = (await sql('select identity_fingerprint from clued_private.ci_nodes_v1 where node_id=$1',[n.node_id])).identity_fingerprint;
      return {pair, old, ip:'198.51.100.'+nextSource++, body:{contract:'clued.ci-connection-renew/1',project_id:f.project,node_id:n.node_id,kind,
        identity_fingerprint:fp,old_binding_id:old.binding_id,old_token_hash:digest(old.token),
        generation:1,new_token_hash:digest(uuid()),issued_at:new Date().toISOString()}};
    }
    async function send(x, changes={}, key=x.pair.privateKey, transform=v=>v, ip=x.ip) {
      const unsigned = {...x.body, ...changes};
      const signature = sign('sha256', Buffer.from(JSON.stringify(unsigned,Object.keys(unsigned).sort())),
        {key,dsaEncoding:'ieee-p1363'}).toString('base64url');
      const request = new Request('https://kooyumi.pixelgrav.com/v1/ci/node/renew',{method:'POST',
        headers:{'content-type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify(transform({...unsigned,signature}))});
      const res = await worker.fetch(request,env);
      assert.ok(res, 'production handler dispatches the renewal path');
      return {http:res.status,...await res.json()};
    }
    const count = async () => (await sql('select count(*)::int n from public.clued_agent_bindings')).n;
    await t.test('L1 the contracted node URL dispatches on a configured production domain', async () => {
      const endpoint = new URL((await contract()).endpoint);
      const config = await readFile(new URL('../wrangler.production.jsonc',import.meta.url),'utf8');
      assert.ok(config.includes('"pattern": "'+endpoint.hostname+'"'));
      const r = await worker.fetch(new Request(endpoint),env);
      assert.equal((await r.json()).error_code,'RENEW_METHOD_INVALID');
    });
    await t.test('H1 normal edits preserve automatic renewal under the migration-resolved Decision', async () => {
      await sql('update public.clued_memories set version=version+1 where id=$1',[decision]);
      try {
        const x=await setup(), r=await send(x);
        assert.equal(r.status,'committed');
        const {automatic}=await sql('select automatic from clued_private.ci_connection_renewals_v1 where receipt_id=$1',[r.receipt_id]);
        assert.equal(automatic,true);
      } finally { await sql('update public.clued_memories set version=version-1 where id=$1',[decision]); }
    });
    await t.test('L2 clock skew has the same code at the Worker and database', async () => {
      const x=await setup();
      for (const offset of [-310000,310000]) {
        const r=await send(x,{issued_at:new Date(Date.now()+offset).toISOString()});
        assert.equal(r.error_code,'RENEW_TIME_INVALID');
        assert.equal(r.renewed,undefined);
      }
    });
    await t.test('L3 public identity refusals have one response', async () => {
      const x=await setup(), other=generateKeyPairSync('ec',{namedCurve:'P-256'});
      assert.deepEqual(await send(x,{},other.privateKey),await send(x,{identity_fingerprint:digest(uuid())}));
    });
    await t.test('two proofs, exact contract, time, identity, category and generation are mandatory', async () => {
      const x = await setup(), before = await count();
      const other = generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey;
      for (const [code,changes,key,transform] of [
        ['RENEW_IDENTITY_REFUSED',{},other],
        ['RENEW_INPUT_INVALID',{},undefined,v=>{delete v.signature; return v;}],
        ['RENEW_INPUT_INVALID',{},undefined,v=>{delete v.old_token_hash; return v;}],
        ['RENEW_INPUT_INVALID',{extra:true}], ['RENEW_INPUT_INVALID',{kind:'heartbeat'}],
        ['RENEW_TIME_INVALID',{issued_at:new Date(Date.now()-310000).toISOString()}],
        ['RENEW_TIME_INVALID',{issued_at:new Date(Date.now()+310000).toISOString()}],
        ['RENEW_IDENTITY_REFUSED',{identity_fingerprint:digest(uuid())}], ['CI_STALE_VERSION',{generation:2}],
        ['RENEW_IDENTITY_REFUSED',{project_id:f.project2}], ['RENEW_PROOF_REFUSED',{old_token_hash:digest(uuid())}],
        ['RENEW_PROOF_REFUSED',{old_binding_id:f.binding}], ['RENEW_INPUT_INVALID',{new_token_hash:x.body.old_token_hash}],
        ['RENEW_INPUT_INVALID',{node_id:null,old_binding_id:null,generation:null}],
      ]) assert.equal((await send(x,changes,key,transform)).error_code,code);
      assert.equal(await count(),before);
    });
    await t.test('pending CI probe and renewal preserve authority and replay one receipt', async () => {
      const x = await setup();
      const probe = await send(x,{new_token_hash:null});
      assert.equal(probe.status,'ok'); assert.equal(probe.binding_generation,1); assert.ok(Date.parse(probe.connection_expires_at));
      await f.gateway.query('begin read only');
      try { assert.equal((await gateway('select public.clued_ci_connection_renew_v1($1) v',[{...x.body,new_token_hash:null}])).status,'ok'); }
      finally { await f.gateway.query('rollback'); }
      const before = await count();
      const result = await send(x);
      assert.equal(result.status,'committed',JSON.stringify(result)); assert.equal(result.binding_generation,2);
      const receipt = await sql('select metadata from public.clued_audit_receipts where id=$1',[result.receipt_id]);
      assert.equal(receipt.metadata.principal,'node_self_renew'); assert.equal(receipt.metadata.approval.decision_id,decision);
      assert.ok(Math.abs(Date.parse(result.connection_expires_at)-Date.now()-30*86400000)<60000);
      assert.equal((await send(x)).receipt_id,result.receipt_id);
      assert.ok((await send(x,{new_token_hash:digest(uuid())})).http>=400);
      assert.equal(await count(),before+1);
      assert.ok((await sql('select revoked_at from public.clued_agent_bindings where id=$1',[x.old.binding_id])).revoked_at);
      const entries = async id => (await f.admin.query(`select resource_kind,resource_id,environment,actions,qualification_id
        from clued_private.authorization_entries_v12 where binding_id=$1 order by 1,2,3`,[id])).rows;
      assert.ok((await entries(result.binding_id)).length>0);
      assert.deepEqual(await entries(result.binding_id), await entries(x.old.binding_id));
      const scope = async id => sql('select scopes,context_keys from public.clued_agent_bindings where id=$1',[id]);
      assert.deepEqual(await scope(result.binding_id),await scope(x.old.binding_id));
      const next = {...x.body,old_binding_id:result.binding_id,old_token_hash:x.body.new_token_hash,generation:2,new_token_hash:digest(uuid())};
      const pending = await send(x,next); assert.equal(pending.status,'pending_approval');
      assert.equal((await send(x,next)).request_id,pending.request_id);
      const approved = await f.native('clued_owner_grant_confirmation_issue_v1',{request_id:pending.request_id,choice:'once'});
      assert.equal(approved.status,'issued',JSON.stringify(approved));
      f.committed(await f.native('clued_owner_grant_v1',{confirmation_token:approved.confirmation_token,view_digest:approved.view_digest}));
      assert.equal((await send(x,next)).status,'committed');
      assert.equal((await sql('select uses from clued_private.owner_grants_v1 where request_id=$1',[pending.request_id])).uses,1);
    });
    const expiry = 'select s.expires_at ceiling,a.expires_at lifetime from clued_private.authorization_sources_v2 s join clued_private.authorizations_v12 a using(binding_id) where s.binding_id=$1';
    const entries = async id => (await f.admin.query('select resource_kind,resource_id,environment,qualification_id,actions from clued_private.authorization_entries_v12 where binding_id=$1 order by 1,2,3',[id])).rows;
    await t.test('M3 a real rotation keeps its earlier independent source ceiling through renewal',async () => {
      const x=await setup('ci',true), rotated=await sql(expiry,[x.old.binding_id]);
      assert.ok(rotated.ceiling<rotated.lifetime);
      const r=await send(x);
      assert.equal(r.status,'committed');
      assert.equal((await sql(expiry,[r.binding_id])).ceiling.toISOString(),rotated.ceiling.toISOString());
      const projected=await entries(r.binding_id);
      assert.ok(projected.length>0);
      assert.deepEqual(projected,await entries(x.old.binding_id));
    });
    await t.test('swept rotated CI connection moves its live heartbeat link and retains enabled failover', async () => {
      const x = await setup('ci',true), h = await binding('heartbeat-link-fixture');
      await sql(`insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id)
        values($1,$2,$3,now(),$4)`,[f.user,h.binding_id,x.old.binding_id,h.receipt_id]);
      await sql(`insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)
        values($1,true,now(),1,now(),$2) on conflict(user_id) do update set enabled=true,enabled_at=now()`,[f.user,h.receipt_id]);
      await sql("update clued_private.authorizations_v12 set expires_at=now()-interval '1 day' where binding_id=$1",[x.old.binding_id]);
      // Model the equal source/authorization deadlines confirmed for aa4969fb.
      await sql('update clued_private.authorization_sources_v2 s set expires_at=a.expires_at from clued_private.authorizations_v12 a where a.binding_id=s.binding_id and a.binding_id=$1',[x.old.binding_id]);
      await sql('select clued_private.binding_expiry_sweep_v1()');
      const discovered = await send(x,{node_id:null,old_binding_id:null,generation:null,new_token_hash:null});
      assert.equal(discovered.node_id,x.body.node_id); assert.equal(discovered.binding_id,x.old.binding_id);
      assert.equal(discovered.binding_generation,1);
      const r = await send(x); assert.equal(r.status,'committed',JSON.stringify(r));
      assert.equal((await sql('select node_binding_id from clued_private.ci_node_heartbeat_link_v1 where heartbeat_binding_id=$1 and revoked_at is null',[h.binding_id])).node_binding_id,r.binding_id);
      const renewed=await sql(expiry,[r.binding_id]);
      assert.equal(renewed.ceiling.toISOString(),renewed.lifetime.toISOString());
      assert.ok((await sql('select count(*)::int n from clued_private.authorization_entries_v12 where binding_id=$1',[r.binding_id])).n>0);
      assert.equal((await sql('select enabled from clued_private.ci_failover_settings_v1 where user_id=$1',[f.user])).enabled,true);
    });
    const discoverGlobal = {project_id:null,node_id:null,old_binding_id:null,generation:null,new_token_hash:null};
    async function sweptGlobal() {
      const x = await setup('ci', true, 'global');
      await sql("update clued_private.authorizations_v12 set expires_at=now()-interval '1 day' where binding_id=$1",[x.old.binding_id]);
      await sql('update clued_private.authorization_sources_v2 s set expires_at=a.expires_at from clued_private.authorizations_v12 a where a.binding_id=s.binding_id and a.binding_id=$1',[x.old.binding_id]);
      await sql('select clued_private.binding_expiry_sweep_v1()');
      assert.ok((await sql('select revoked_at from public.clued_agent_bindings where id=$1',[x.old.binding_id])).revoked_at);
      return x;
    }
    await t.test('H2 swept global standby renews in the core without a yield',async () => {
      const x=await sweptGlobal();
      const result=await send(x);
      assert.equal(result.status,'committed',JSON.stringify(result));
      const scope=id=>sql('select scopes,context_keys from public.clued_agent_bindings where id=$1',[id]);
      assert.deepEqual((await scope(result.binding_id)).context_keys,['global']);
      assert.deepEqual(await scope(result.binding_id),await scope(x.old.binding_id));
      assert.ok((await entries(result.binding_id)).length);
      assert.deepEqual(await entries(result.binding_id),await entries(x.old.binding_id));
    });
    await t.test('H2 signed discovery recovers the swept global installation and supplies the replacement selectors',async () => {
      const x=await sweptGlobal(), probe=await send(x,discoverGlobal);
      assert.deepEqual([probe.http,probe.project_id,probe.node_id,probe.on_duty],[200,f.project,x.body.node_id,false]);
      const r=await send(x,{project_id:probe.project_id,node_id:probe.node_id,old_binding_id:probe.binding_id,generation:probe.binding_generation});
      assert.equal(r.status,'committed');
    });
    await t.test('M3 an expired independent ceiling cannot mint a credential with no entries',async () => {
      const x=await setup('ci',true), before=await count();
      await sql("update clued_private.authorizations_v12 set expires_at=now()-interval '1 day' where binding_id=$1",[x.old.binding_id]);
      await sql("update clued_private.authorization_sources_v2 set expires_at=now()-interval '2 days' where binding_id=$1",[x.old.binding_id]);
      await sql('select clued_private.binding_expiry_sweep_v1()');
      const r=await send(x);
      assert.equal(r.error_code,'RENEW_AUTHORITY_CHANGED');
      assert.equal(r.renewed,false);
      assert.equal(await count(),before);
    });
    await t.test('M3 authority parity requires a nonempty exact projection in both directions', async () => {
      const x=await setup(), empty=uuid();
      const same=async (a,b)=>(await sql('select clued_private.ci_renew_entries_match_v1($1,$2) ok',[a,b])).ok;
      assert.equal(await same(empty,empty),false);
      assert.equal(await same(empty,x.old.binding_id),false);
      assert.equal(await same(x.old.binding_id,empty),false);
      assert.equal(await same(x.old.binding_id,x.old.binding_id),true);
    });
    await t.test('over thirty days queues one exact Grant, explicit revocation never queues a Grant', async () => {
      const x = await setup();
      await sql("update clued_private.authorizations_v12 set expires_at=now()-interval '31 days' where binding_id=$1",[x.old.binding_id]);
      await sql('select clued_private.binding_expiry_sweep_v1()');
      const r = await send(x); assert.equal(r.status,'pending_approval');
      const row = await sql('select action,resources,status from clued_private.owner_requests_v1 where id=$1',[r.request_id]);
      assert.deepEqual(row,{action:'ci.connection_renew',resources:['ci-node:'+x.body.node_id+'/ci/2'],status:'pending'});
      await sql("insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation) values($1,$2,'revoke')",[f.user,x.old.binding_id]);
      assert.ok((await send(x)).http>=400);
    });
    await t.test('M4 pending exceptions advertise the hourly D2 retry on every poll', async () => {
      const x=await setup();
      await sql("update clued_private.authorizations_v12 set expires_at=now()-interval '31 days' where binding_id=$1",[x.old.binding_id]);
      const r=await send(x);
      assert.equal(r.retry_after_seconds,3600);
      assert.equal(r.retry_after_seconds,(await contract()).pending_retry_seconds);
      assert.deepEqual(await send(x),r);
    });
    await t.test('M5 exceptional renewals are outside the general auto-approval switch', async () => {
      assert.equal((await sql("select auto_approvable from clued_private.owner_grant_actions where action='ci.connection_renew'")).auto_approvable,false);
    });
    await t.test('upgrade binds the same-name role and proof, moves it once, and keeps CI unchanged', async () => {
      const x = await setup('upgrade');
      assert.ok((await send(x,{old_token_hash:digest(uuid())})).http>=400);
      assert.equal((await send(x,{new_token_hash:null})).status,'ok');
      const p=await send(x,discoverGlobal);
      assert.deepEqual([p.http,p.project_id,p.node_id,p.kind,p.on_duty],[200,f.project,x.body.node_id,'upgrade',false]);
      const r = await send(x); assert.equal(r.status,'committed',JSON.stringify(r));
      assert.equal((await send(x)).receipt_id,r.receipt_id);
      const role = await sql("select binding_id from clued_private.binding_roles_v1 where role='resident-upgrade' and revoked_at is null and binding_id in ($1,$2)",[x.old.binding_id,r.binding_id]);
      assert.equal(role.binding_id,r.binding_id);
      assert.equal((await sql('select binding_id from clued_private.ci_nodes_v1 where node_id=$1',[x.body.node_id])).binding_id,f.binding);
      assert.ok((await sql('select revoked_at from public.clued_agent_bindings where id=$1',[x.old.binding_id])).revoked_at);
      const superseded=await send(x,{new_token_hash:digest(uuid())});
      assert.equal(superseded.error_code,'RENEW_SUPERSEDED');
      assert.equal(superseded.renewed,false);
      const probe=await send(x,{new_token_hash:null});
      assert.equal(probe.error_code,'RENEW_REPLACEMENT_UNUSABLE');
      assert.equal(probe.renewed,undefined);
    });
    await t.test('only the Worker can execute either renewal RPC', async () => {
      for (const role of ['anon','authenticated','service_role'])
        for (const fn of ['clued_ci_connection_renew_trust_v1(uuid,uuid,text,text)','clued_ci_connection_renew_v1(jsonb)'])
          assert.equal((await sql("select has_function_privilege($1,$2,'execute') ok",[role,'public.'+fn])).ok,false);
    });
    await t.test('transport refuses insecure routes, malformed bodies, missing source and unavailable gateway', async () => {
      const x = await setup();
      const endpoint='https://kooyumi.pixelgrav.com/v1/ci/node/renew';
      for (const [url,method,body,expected] of [
        [endpoint+'?kind=ci','POST','{}',404],[endpoint.replace('https:','http:'),'POST','{}',404],
        [endpoint,'GET',undefined,405],[endpoint,'POST','x'.repeat(2049),400],[endpoint,'POST','{',400],
        [endpoint,'POST',JSON.stringify({...x.body,signature:'a'.repeat(86)}),403],
      ]) {
        const res=await worker.fetch(new Request(url,{method,body}),{CLUED_DB_GATEWAY_TOKEN:'fixture'});
        assert.equal(res.status,expected);
        assert.equal(res.headers.get('cache-control'),'no-store');
      }
      const res=await worker.fetch(new Request(endpoint,{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.1'},
        body:JSON.stringify({...x.body,signature:'a'.repeat(86)})}),{});
      assert.equal(res.status,503);
    });
    await t.test('upgrade never moves an absent, shared or mismatched role even with valid proofs', async () => {
      const x=await setup();
      assert.equal((await send(x,{kind:'upgrade'})).error_code,'RENEW_UPGRADE_ROLE_REFUSED');
      const other=await binding('other-name');
      await sql(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,effective_at,granted_receipt_id)
        values($1,$2,'resident-upgrade',now(),now(),$3)`,[f.user,other.binding_id,other.receipt_id]);
      const changes={kind:'upgrade',old_binding_id:other.binding_id,old_token_hash:digest(other.token)};
      assert.equal((await send(x,changes)).error_code,'RENEW_UPGRADE_ROLE_REFUSED');
      assert.equal((await send(x,{...changes,kind:'ci'})).error_code,'RENEW_BINDING_UNAVAILABLE');
      await sql("update clued_private.ci_nodes_v1 set name='other-name' where node_id=$1",[x.body.node_id]);
      await sql(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,effective_at,granted_receipt_id)
        values($1,$2,'release-door',now(),now(),$3)`,[f.user,other.binding_id,other.receipt_id]);
      assert.equal((await send(x,changes)).error_code,'RENEW_UPGRADE_ROLE_REFUSED');
    });
    await t.test('database fences signed time, account availability, authority parity and busy bindings', async () => {
      const x=await setup(), before=await count();
      const direct = changes=>gateway('select public.clued_ci_connection_renew_v1($1) v',[{...x.body,...changes}]);
      assert.equal((await direct({issued_at:new Date(Date.now()-310000).toISOString()})).error_code,'RENEW_TIME_INVALID');
      assert.equal((await direct({kind:'heartbeat'})).error_code,'RENEW_INPUT_INVALID');
      await sql("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[f.user]);
      try {assert.equal((await send(x,{new_token_hash:null})).error_code,'RENEW_ACCOUNT_UNAVAILABLE');}
      finally {await sql('update auth.users set banned_until=null where id=$1',[f.user]);}
      const locker=await f.connect();
      await locker.query('begin');
      try {
        await locker.query('select id from public.clued_agent_bindings where id=$1 for update',[x.old.binding_id]);
        assert.equal((await send(x)).error_code,'CI_REBIND_BUSY');
      } finally {await locker.query('rollback');}
      await locker.query('begin');
      let waiting;
      try {
        await locker.query('select clued_private.owner_grant_lock_v1($1)',[f.user]);
        waiting=send(x,{issued_at:new Date(Date.now()-298500).toISOString()});
        await locker.query('select pg_sleep(2)');
      } finally {await locker.query('rollback');}
      const delayed=await waiting;
      assert.equal(delayed.error_code,'RENEW_TIME_INVALID');
      assert.equal(delayed.renewed,false);
      await sql("update public.clued_agent_bindings set scopes=array['context:read','context:write'] where id=$1",[x.old.binding_id]);
      assert.equal((await send(x)).error_code,'RENEW_AUTHORITY_CHANGED');
      assert.equal(await count(),before);
    });
    await t.test('revocation between trust lookup and transaction refuses; spent credentials and competing replacements cannot mint again', async () => {
      const revoked=await setup();
      beforeCommit=()=>sql("update clued_private.ci_nodes_v1 set state='revoked' where node_id=$1",[revoked.body.node_id]);
      try {assert.equal((await send(revoked)).error_code,'RENEW_IDENTITY_REFUSED');} finally {beforeCommit=undefined;}
      const x=await setup(), before=await count();
      // Separate gateway sessions submit competing authenticated transactions.
      const second=await f.connect(); await setWorkerGatewayCaller(second);
      const rival={...x.body,new_token_hash:digest(uuid())};
      const answers=await Promise.all([gateway('select public.clued_ci_connection_renew_v1($1) v',[x.body]),
        second.query('select public.clued_ci_connection_renew_v1($1) v',[rival]).then(r=>r.rows[0].v)]);
      assert.deepEqual(answers.map(r=>r.status).sort(),['committed','rejected']); assert.equal(await count(),before+1);
      const current=answers.find(r=>r.status==='committed');
      await sql('update public.clued_agent_bindings set revoked_at=now() where id=$1',[current.binding_id]);
      const replay=await send(x,answers[0].status==='committed'?x.body:rival);
      assert.equal(replay.error_code,'RENEW_REPLACEMENT_UNUSABLE');
      assert.equal(replay.renewed,undefined);
    });
    await t.test('a rejected or revoked exception Grant cannot be used; age survives an expiry sweep', async () => {
      for (const action of ['reject','revoke','expire_while_waiting','use']) {
        const x=await setup();
        await sql("update clued_private.authorizations_v12 set expires_at=now()-interval '31 days' where binding_id=$1",[x.old.binding_id]);
        await sql('select clued_private.binding_expiry_sweep_v1()');
        const pending=await send(x); assert.equal(pending.status,'pending_approval');
        if (action==='reject') {
          f.committed(await f.native('clued_owner_request_reject_v1',{request_id:pending.request_id}));
          assert.equal((await send(x)).error_code,'RENEW_GRANT_REJECTED');
        } else {
          const confirmation=await f.native('clued_owner_grant_confirmation_issue_v1',{request_id:pending.request_id,choice:'once'});
          const approved=f.committed(await f.native('clued_owner_grant_v1',{
            confirmation_token:confirmation.confirmation_token,view_digest:confirmation.view_digest}));
          if (action==='revoke') {
            f.committed(await f.native('clued_owner_grant_revoke_v1',{grant_id:approved.grant.grant_id}));
            assert.equal((await send(x)).error_code,'RENEW_GRANT_REVOKED');
          } else if (action==='expire_while_waiting') {
            const locker=await f.connect();
            await locker.query('begin');
            let waiting;
            try {
              await locker.query('select clued_private.owner_grant_lock_v1($1)',[f.user]);
              await locker.query("update clued_private.owner_grants_v1 set expires_at=clock_timestamp()+interval '1 second' where id=$1",[approved.grant.grant_id]);
              waiting=send(x);
              await locker.query('select pg_sleep(1.5)');
              await locker.query('commit');
            } finally {await locker.query('rollback');}
            assert.equal((await waiting).status,'pending_approval');
            assert.equal((await sql('select uses from clued_private.owner_grants_v1 where id=$1',[approved.grant.grant_id])).uses,0);
          } else assert.equal((await send(x)).status,'committed');
        }
      }
    });
    await t.test('role, lifecycle, outstanding work and duty fences roll back the entire operation', async () => {
      for (const state of ['retired','revoked']) {
        const x = await setup();
        await sql('update clued_private.ci_nodes_v1 set state=$1 where node_id=$2',[state,x.body.node_id]);
        assert.equal((await send(x)).error_code,'RENEW_IDENTITY_REFUSED');
      }
      const x = await setup();
      const before = await count();
      await sql(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'ci-admission',now(),$3,now(),'resident-node')`,[f.user,x.old.binding_id,x.old.receipt_id]);
      assert.equal((await send(x)).error_code,'CI_REBIND_DUTY_HANDOVER_REQUIRED');
      await sql('update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2 where binding_id=$1',[x.old.binding_id,x.old.receipt_id]);
      await sql(`insert into clued_private.ci_train_lease_v1(user_id,project_id,holder_node_id,holder_binding_id,state,issued_at,expires_at)
        values($1,$2,$3,$4,'sweep_required',now()-interval '20 minutes',now()-interval '10 minutes')`,[f.user,f.project,x.body.node_id,x.old.binding_id]);
      assert.equal((await send(x)).error_code,'CI_REBIND_NOT_DRAINED');
      assert.equal(await count(),before);
    });
    await t.test('M1 internal failures are retryable and never clear the persisted intent', async () => {
      const x=await setup();
      const before=await count();
      await f.admin.query(`create function clued_private.fixture_fail_renewal() returns trigger language plpgsql as $$
        begin raise exception 'fixture storage error'; end $$;
        create trigger fixture_storage_error before insert on clued_private.ci_connection_renewals_v1
        for each row execute function clued_private.fixture_fail_renewal()`);
      try {
        const failure=await send(x);
        assert.equal(failure.error_code,'RENEW_INTERNAL_RETRY');
        assert.equal(failure.http,503);
        assert.equal(await count(),before);
      } finally { await f.admin.query('drop trigger fixture_storage_error on clued_private.ci_connection_renewals_v1; drop function clued_private.fixture_fail_renewal()'); }
      const policy=(await contract()).clear_intent;
      assert.equal(policy.requires_renewed_false,true);
      assert.ok(policy.codes.includes('RENEW_SUPERSEDED'));
      for (const code of ['RENEW_INTERNAL_RETRY','RENEW_REPLACEMENT_UNUSABLE'])
        assert.equal(policy.codes.includes(code),false);
      const refused=await send(x,{generation:2});
      assert.ok(policy.codes.includes(refused.error_code));
      assert.equal(refused.renewed,false);
    });
    await t.test('L4 the locked account writer and read-only probe share one availability predicate',async () => {
      const {body}=await sql("select prosrc body from pg_proc where oid='clued_private.authorization_account_v12(uuid)'::regprocedure");
      assert.match(body,/for share/i);
      assert.match(body,/ci_renew_account_available_v1/);
    });
    await t.test('L5 discovery requires exactly one live node for the account fingerprint',async () => {
      const x=await setup();
      const second=f.committed(await f.native('clued_ci_node_registration_v1',{
        ...f.registration(f.project2),identity_public_jwk:x.pair.publicKey.export({format:'jwk'})}));
      const discover={node_id:null,old_binding_id:null,generation:null,new_token_hash:null};
      assert.equal((await send(x,discover)).error_code,'RENEW_IDENTITY_REFUSED');
      const ambiguous=await send(x,discoverGlobal);
      assert.deepEqual(ambiguous,{http:409,status:'rejected',error_code:'RENEW_DISCOVERY_AMBIGUOUS'});
      const unrelated=await binding('unrelated');
      assert.equal((await send(x,{...discoverGlobal,old_token_hash:digest(unrelated.token)})).error_code,'RENEW_PROOF_REFUSED');
      await sql("update clued_private.ci_nodes_v1 set state='retired' where node_id=$1",[second.node_id]);
      assert.equal((await send(x,discover)).node_id,x.body.node_id);
      assert.equal((await send(x,discoverGlobal)).node_id,x.body.node_id);
    });
    await t.test('probe counts freshness for this live Native session alone', async () => {
      const probe = async claims => {
        await f.human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
          [claims.sub,JSON.stringify(claims)]);
        return (await f.human.query('select public.clued_native_session_probe_v1() v')).rows[0].v;
      };
      await f.human.query('begin read only');
      let current;
      try { current=await probe(f.claims()); } finally { await f.human.query('rollback'); }
      assert.equal(current.session_valid,true); assert.ok(current.fresh_seconds>890 && current.fresh_seconds<=900);
      assert.equal(current.reason,null);
      assert.deepEqual(await probe(f.claims(f.user,f.session,{auth_time:1})),{session_valid:true,fresh_seconds:0,reason:null});
      const expired=uuid();
      await sql("insert into auth.sessions(id,user_id,not_after) values($1,$2,now()-interval '1 second')",[expired,f.user]);
      assert.deepEqual(await probe(f.claims(f.user,expired)),{session_valid:false,fresh_seconds:0,reason:'expired'});
      for (const claims of [f.claims(f.user,uuid()),f.claims(f.other,f.session)])
        assert.deepEqual(await probe(claims),{session_valid:false,fresh_seconds:0,reason:'replaced'});
      assert.deepEqual(await probe(f.claims(f.user,f.session,{client_id:'delegated'})),{session_valid:false,fresh_seconds:0,reason:null});
    });
    await t.test('authority removed after the initial lookup, including the standing Decision, is rechecked', async () => {
      const x = await setup();
      await sql("update public.clued_memories set lifecycle_status='superseded' where id=$1",[decision]);
      try {
        const r=await send(x);
        assert.equal(r.status,'pending_approval');
        const refused=await f.native('clued_owner_grant_confirmation_issue_v1',
          {request_id:r.request_id,choice:'once',resources:['ci-node:'+uuid()+'/ci/2']});
        assert.equal(refused.status,'rejected');
        await sql("insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation) values($1,$2,'credential_leak')",
          [f.user,x.old.binding_id]);
        assert.equal((await send(x)).error_code,'CI_REBIND_OLD_REVOCATION_UNSAFE');
      } finally { await sql("update public.clued_memories set lifecycle_status='active' where id=$1",[decision]); }
    });
    await t.test('M2 the trust lookup is read-only and only verified identities spend the fingerprint budget', async () => {
      const x=await setup();
      await f.gateway.query('begin read only');
      try {
        const trust=await gateway('select public.clued_ci_connection_renew_trust_v1($1,$2,$3,$4) v',
          [f.project,x.body.node_id,x.body.identity_fingerprint,digest(x.ip)]);
        assert.equal(trust.status,'ok');
      } finally { await f.gateway.query('rollback'); }
      const steps=[];
      const limiter=(name,success)=>({limit:async ({key})=>{steps.push([name,key]);return {success};}});
      env.CI_RENEW_SOURCE_LIMIT=limiter('source',true);
      env.CI_RENEW_IDENTITY_LIMIT=limiter('identity',false);
      const probe={new_token_hash:null};
      const wrong=generateKeyPairSync('ec',{namedCurve:'P-256'});
      assert.equal((await send(x,probe,wrong.privateKey)).http,403);
      assert.deepEqual(steps.map(([name])=>name),['source']);
      assert.equal((await send(x,probe)).http,429);
      assert.deepEqual(steps.at(-1),['identity',x.body.identity_fingerprint]);
      env.CI_RENEW_SOURCE_LIMIT=limiter('source',false);
      const before=calls.length;
      assert.equal((await send(x,probe)).http,429);
      assert.equal(calls.length,before);
      Object.assign(env,{CI_RENEW_SOURCE_LIMIT:allowed,CI_RENEW_IDENTITY_LIMIT:allowed});
    });
    await t.test('N1 limiter failures warn and keep the signed probe available', async t => {
      const x = await setup();
      const probe = {new_token_hash: null};
      const failures = {
        binding_missing: undefined,
        error: {limit: async () => { throw new Error('synthetic limiter failure'); }},
        timeout: {limit: () => new Promise(() => {})},
      };
      for (const binding of ['CI_RENEW_SOURCE_LIMIT', 'CI_RENEW_IDENTITY_LIMIT']) {
        for (const [reason, limiter] of Object.entries(failures)) {
          await t.test(`${binding} ${reason}`, async t => {
            const warnings = t.mock.method(console, 'warn', () => {});
            env[binding] = limiter;
            try {
              const before = calls.length;
              const reply = await send(x, probe);
              assert.equal(reply.http, 200, JSON.stringify(reply));
              assert.equal(reply.status, 'ok');
              assert.deepEqual(calls.slice(before), [
                'clued_ci_connection_renew_trust_v1', 'clued_ci_connection_renew_v1',
              ]);
              assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [[
                {event: 'ci_renew_rate_limiter_unavailable', binding, reason},
              ]]);
            } finally { env[binding] = allowed; }
          });
        }
      }
      await t.test('an invalid signature still cannot reach the identity limiter or business RPC', async t => {
        const warnings = t.mock.method(console, 'warn', () => {});
        env.CI_RENEW_SOURCE_LIMIT = undefined;
        env.CI_RENEW_IDENTITY_LIMIT = undefined;
        try {
          const wrong = generateKeyPairSync('ec', {namedCurve: 'P-256'});
          const before = calls.length;
          const reply = await send(x, probe, wrong.privateKey);
          assert.equal(reply.http, 403, JSON.stringify(reply));
          assert.equal(reply.error_code, 'RENEW_IDENTITY_REFUSED');
          assert.deepEqual(calls.slice(before), ['clued_ci_connection_renew_trust_v1']);
          assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [[
            {event: 'ci_renew_rate_limiter_unavailable', binding: 'CI_RENEW_SOURCE_LIMIT', reason: 'binding_missing'},
          ]]);
        } finally {
          Object.assign(env, {CI_RENEW_SOURCE_LIMIT: allowed, CI_RENEW_IDENTITY_LIMIT: allowed});
        }
      });
    });
    const holder=await setup('ci',false,'global'), skipped=await setup(), standby=await setup();
    const from=holder.old.binding_id, to=standby.old.binding_id;
    const yielding={action:'yield',new_token_hash:null};
    const current=async ()=>(await sql("select binding_id from clued_private.binding_roles_v1 where user_id=$1 and role='ci-admission' and revoked_at is null",[f.user])).binding_id;
    const setExpiry=(id,duration)=>sql('update clued_private.authorizations_v12 set expires_at=clock_timestamp()+$2::interval where binding_id=$1',[id,duration]);
    const yieldRequest=(x=holder,change={})=>send(x,{...yielding,...change});
    const direct=change=>gateway('select public.clued_ci_connection_renew_v1($1) v',[{...holder.body,...yielding,...change}]);
    const rejected=async (response,code,http=409)=>{
      const r=await response;
      assert.deepEqual(r,{http,status:'rejected',error_code:code});
    };
    await sql("update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2 where user_id=$1 and role='ci-admission' and revoked_at is null",[f.user,holder.old.receipt_id]);
    await sql("insert into clued_private.binding_roles_v1(user_id,binding_id,role,purpose,granted_at,effective_at,granted_receipt_id) values($1,$2,'ci-admission','resident-node',now(),now(),$3)",[f.user,from,holder.old.receipt_id]);
    for (const [i,x] of [holder,skipped,standby].entries()) {
      await f.live(x.body.node_id);
      await sql("update clued_private.ci_node_liveness_v1 set reported_mode='STANDBY',reported_probe='not-held',reported_source_sha256=$2,steady_since=now()-interval '1 hour' where node_id=$1",[x.body.node_id,digest('source')]);
      await sql('insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id) values($1,$2,$3,now(),$4)',[f.user,x.old.binding_id,i+1,x.old.receipt_id]);
    }
    await sql("update clued_private.ci_node_liveness_v1 set reported_state='PAUSED' where node_id=$1",[skipped.body.node_id]);
    await sql('insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id) values($1,true,now(),1,now(),$2) on conflict(user_id) do update set enabled=true,enabled_at=now()',[f.user,holder.old.receipt_id]);
    await t.test('H2 Native replacement still requires project authority on a global target',async () => {
      const globalTarget=await binding('global-native-target','global');
      await assert.rejects(()=>f.native('clued_ci_node_binding_rebind_confirmation_issue_v1',{
        project_id:f.project,node_id:standby.body.node_id,old_binding_id:to,new_binding_id:globalTarget.binding_id,
        base_version:1,binding_generation:1,accepted_ref:'fixture',idempotency_key:uuid()
      }),{code:'42501',message:'CI_BINDING_UNAVAILABLE'});
    });
    await t.test('L6 shared yield signature vector verifies the exact canonical UTF-8 bytes at the gateway',async t => {
      const v=(await contract()).yield_signature_vector;
      const {signature,...unsigned}=v.request;
      assert.equal(Buffer.from(signature,'base64url').length,64);
      assert.equal(JSON.stringify(unsigned,Object.keys(unsigned).sort()),v.canonical_utf8);
      t.mock.method(Date,'now',()=>Date.parse(unsigned.issued_at));
      const seen=[];
      t.mock.method(globalThis,'fetch',async (url,init)=>{
        const name=new URL(url).pathname.split('/').pop();
        seen.push(name);
        if (name==='clued_ci_connection_renew_trust_v1') return Response.json({status:'ok',identity_public_jwk:v.public_jwk});
        assert.deepEqual(JSON.parse(init.body).p_input,unsigned);
        // Even an upstream response marked for a replacement must never settle
        // a different persisted replacement through this signed yield request.
        return Response.json({status:'rejected',error_code:'CI_STALE_VERSION',renewed:false});
      });
      const response=await worker.fetch(new Request((await contract()).endpoint,{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(v.request)}),env);
      assert.equal(response.status,409);
      assert.deepEqual(await response.json(),{status:'rejected',error_code:'CI_STALE_VERSION'});
      assert.deepEqual(seen,['clued_ci_connection_renew_trust_v1','clued_ci_connection_renew_v1']);
    });
    await t.test('L3 probe supplies the actual opening instant and CI duty',async () => {
      const p=await send(holder,discoverGlobal);
      assert.equal(p.on_duty,true);
      assert.equal(Date.parse(p.connection_expires_at)-Date.parse(p.renewal_window_opens_at),10*86400000);
    });
    await t.test('H1 yield requires the two proofs and the exact signed CI shape',async () => {
      const before=calls.filter(c=>c==='clued_ci_connection_renew_v1').length;
      await rejected(send(holder,yielding,standby.pair.privateKey),'RENEW_IDENTITY_REFUSED',403);
      for (const key of ['signature','old_token_hash']) {
        await rejected(send(holder,yielding,undefined,body=>{delete body[key];return body;}),'RENEW_INPUT_INVALID',400);
      }
      await rejected(send(holder,{new_token_hash:null},undefined,body=>({...body,action:'yield'})),'RENEW_IDENTITY_REFUSED',403);
      for (const change of [{action:null},{action:'probe'},{kind:'upgrade'},{to_binding_id:to},{new_token_hash:digest(uuid())},discoverGlobal])
        await rejected(yieldRequest(holder,change),'RENEW_INPUT_INVALID',400);
      await rejected(yieldRequest(holder,{issued_at:new Date(Date.now()-310000).toISOString()}),'RENEW_TIME_INVALID',400);
      assert.equal(calls.filter(c=>c==='clued_ci_connection_renew_v1').length,before);
      await rejected(yieldRequest(holder,{old_token_hash:digest(uuid())}),'RENEW_PROOF_REFUSED');
      await rejected(yieldRequest(holder,{generation:2}),'CI_STALE_VERSION');
    });
    await t.test('M2 discovery and yield share the source limit and the verified identity limit',async () => {
      for (const action of [discoverGlobal,yielding]) {
        const steps=[];
        const limit=(name,success)=>({limit:async()=>{steps.push(name);return {success};}});
        try {
          env.CI_RENEW_SOURCE_LIMIT=limit('source',false);
          const n=calls.length;
          await rejected(send(holder,action),'RENEW_RATE_LIMITED',429);
          assert.equal(calls.length,n);
          env.CI_RENEW_SOURCE_LIMIT=limit('source',true);
          env.CI_RENEW_IDENTITY_LIMIT=limit('identity',false);
          await rejected(send(holder,action,standby.pair.privateKey),'RENEW_IDENTITY_REFUSED',403);
          await rejected(send(holder,action),'RENEW_RATE_LIMITED',429);
          assert.deepEqual(steps,['source','source','source','identity']);
        } finally {Object.assign(env,{CI_RENEW_SOURCE_LIMIT:allowed,CI_RENEW_IDENTITY_LIMIT:allowed});}
      }
    });
    await t.test('H1 live window is required; expired holders cannot yield',async () => {
      await rejected(yieldRequest(),'RENEW_HANDOVER_OUTSIDE_WINDOW');
      await setExpiry(from,'-1 minute');
      await rejected(yieldRequest(),'RENEW_HANDOVER_CONNECTION_INACTIVE');
    });
    await setExpiry(from,'10 days'); await setExpiry(to,'9 days');
    await t.test('H1 nonholders, disabled failover and stale Decisions refuse without moving duty',async () => {
      await rejected(yieldRequest(standby),'RENEW_HANDOVER_NOT_HOLDER');
      await sql('update clued_private.ci_failover_settings_v1 set enabled=false,enabled_at=null where user_id=$1',[f.user]);
      try {await rejected(yieldRequest(),'RENEW_HANDOVER_DISABLED');}
      finally {await sql('update clued_private.ci_failover_settings_v1 set enabled=true,enabled_at=now() where user_id=$1',[f.user]);}
      await sql("update public.clued_memories set lifecycle_status='superseded' where id=$1",[decision]);
      try {await rejected(yieldRequest(),'RENEW_HANDOVER_DECISION_UNAVAILABLE');}
      finally {await sql("update public.clued_memories set lifecycle_status='active' where id=$1",[decision]);}
      assert.equal(await current(),from);
    });
    await t.test('L1 unmarked holder and L4 phase four both disable yielding',async () => {
      await sql('delete from clued_private.ci_failover_members_v1 where binding_id=$1',[from]);
      try {await rejected(yieldRequest(),'RENEW_HANDOVER_DISABLED');}
      finally {await sql('insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id) values($1,$2,1,now(),$3)',[f.user,from,holder.old.receipt_id]);}
      await sql('select clued_private.ci_policy_v1($1,$2)',[f.user,f.project]);
      const {policy}=await sql("update clued_private.ci_quota_counters_v1 set policy=jsonb_set(policy,'{phase}','4') where user_id=$1 and project_id=$2 and row_kind='pool_policy' returning policy",[f.user,f.project]);
      assert.equal(policy.phase,4);
      try {await rejected(yieldRequest(),'RENEW_HANDOVER_DISABLED');}
      finally {await sql("update clued_private.ci_quota_counters_v1 set policy=jsonb_set(policy,'{phase}','1') where user_id=$1 and project_id=$2 and row_kind='pool_policy'",[f.user,f.project]);}
    });
    await t.test('H1 gateway-only yield revalidates signed fields and explicit revocation',async () => {
      for (const role of ['anon','authenticated','service_role','clued_worker_gateway']) {
        const {safe}=await sql("select bool_and(not has_function_privilege($1,p.oid,'execute')) safe from pg_proc p where p.pronamespace='clued_private'::regnamespace and p.proname='ci_renewal_handover_v1'",[role]);
        assert.equal(safe,true);
      }
      for (const [change,code] of [[{issued_at:new Date(Date.now()-305000).toISOString()},'RENEW_TIME_INVALID'],
        [{generation:9},'CI_STALE_VERSION'],[{old_token_hash:digest(uuid())},'RENEW_PROOF_REFUSED'],
        [{...discoverGlobal},'RENEW_INPUT_INVALID'],[{new_token_hash:digest(uuid())},'RENEW_INPUT_INVALID'],[{kind:'upgrade'},'RENEW_INPUT_INVALID']]) {
        assert.deepEqual(await direct(change),{status:'rejected',error_code:code});
      }
      await sql('update public.clued_agent_bindings set revoked_at=now() where id=$1',[from]);
      try {await rejected(yieldRequest(),'CI_REBIND_OLD_REVOCATION_UNSAFE');}
      finally {await sql('update public.clued_agent_bindings set revoked_at=null where id=$1',[from]);}
      assert.equal(await current(),from);
    });
    await t.test('L4 role, candidate heartbeat and target binding contention all defer',async () => {
      const locker=await f.connect();
      for (const [query,id] of [
        ["select pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||$1||':ci-admission',0))",f.user],
        ['select 1 from clued_private.ci_node_liveness_v1 where node_id=$1 for update',standby.body.node_id],
        ['select 1 from public.clued_agent_bindings where id=$1 for update',to],
      ]) {
        await locker.query('begin');
        try {await locker.query(query,[id]); await rejected(yieldRequest(),'CI_REBIND_BUSY');}
        finally {await locker.query('rollback');}
      }
      assert.equal(await current(),from);
    });
    await t.test('L2 no eligible target keeps duty and emits one node-attributed failure alert',async () => {
      await sql("update clued_private.ci_node_liveness_v1 set reported_state='HALTED' where node_id=$1",[standby.body.node_id]);
      try {
        await rejected(yieldRequest(),'RENEW_HANDOVER_NO_CANDIDATE');
        await rejected(yieldRequest(),'RENEW_HANDOVER_NO_CANDIDATE');
        const alerts=await f.admin.query("select metadata from public.clued_audit_receipts where user_id=$1 and metadata->>'receipt_kind'='CI_ADMISSION_FAILOVER_NO_TARGET'",[f.user]);
        assert.equal(alerts.rowCount,1);
        assert.equal(alerts.rows[0].metadata.principal,'node_self_renew');
        assert.equal(await current(),from);
      } finally {await sql("update clued_private.ci_node_liveness_v1 set reported_state='NORMAL' where node_id=$1",[standby.body.node_id]);}
    });
    await t.test('M2 core target refusals preserve the cause and leave the holder in place',async () => {
      await f.admin.query("create function clued_private.fixture_refuse_target() returns trigger language plpgsql as $$ begin raise exception 'ci_admission_target_halted' using errcode='22023'; end $$; create trigger refuse_target before insert on public.clued_audit_receipts for each row when (new.metadata->>'receipt_kind'='CI_ADMISSION_RENEWAL_HANDOVER') execute function clued_private.fixture_refuse_target()");
      try {await rejected(yieldRequest(),'CI_ADMISSION_TARGET_HALTED'); assert.equal(await current(),from);}
      finally {await f.admin.query('drop trigger refuse_target on public.clued_audit_receipts');}
    });
    await t.test('M2 unexpected handover storage faults stay retryable and cannot clear an intent',async () => {
      await f.admin.query("create function clued_private.fixture_fail_yield() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$; create trigger fail_yield before insert on public.clued_audit_receipts for each row when (new.metadata->>'receipt_kind'='CI_ADMISSION_RENEWAL_HANDOVER') execute function clued_private.fixture_fail_yield()");
      try {await rejected(yieldRequest(),'RENEW_INTERNAL_RETRY',503); assert.equal(await current(),from);}
      finally {await f.admin.query('drop trigger fail_yield on public.clued_audit_receipts');}
    });
    await t.test('H1 watchdog first eligible target, replay refusal, drain, rotation and Native handback',async t => {
      await sql('update public.clued_memories set version=version+1 where id=$1',[decision]);
      const expected=await sql("select c->>'binding_id' id from jsonb_array_elements(clued_private.ci_failover_candidates_v1($1,$2,$3,null,now())) c where (c->>'eligible')::boolean order by (c->>'rank')::int limit 1",[f.user,from,digest('source')]);
      assert.equal(expected.id,to);
      const proof={...yielding,issued_at:new Date().toISOString()};
      const r=await send(holder,proof);
      assert.equal(r.status,'committed',JSON.stringify(r));
      assert.deepEqual([r.from_binding_id,r.to_binding_id,await current()],[from,expected.id,to]);
      assert.ok(Date.parse(r.effective_at)>Date.now());
      const {metadata:m}=await sql('select metadata from public.clued_audit_receipts where id=$1',[r.receipt_id]);
      assert.deepEqual([m.receipt_kind,m.principal,m.decision_id,m.node_id],['CI_ADMISSION_RENEWAL_HANDOVER','node_self_renew',decision,holder.body.node_id]);
      await rejected(send(holder,proof),'RENEW_HANDOVER_NOT_HOLDER');
      async function nativeHandover(oldId,newId) {
        const ticket=await f.native('clued_binding_role_handover_confirmation_issue_v1',{from_binding_id:oldId,to_binding_id:newId});
        assert.equal(ticket.status,'issued',JSON.stringify(ticket));
        const back=f.committed(await f.native('clued_binding_role_handover_v1',{confirmation_token:ticket.confirmation_token,view_digest:ticket.view_digest}));
        assert.equal((await sql('select metadata from public.clued_audit_receipts where id=$1',[back.receipt_id])).metadata.receipt_kind,'BINDING_ROLE_HANDED_OVER');
        await sql('update clued_private.binding_roles_v1 set effective_at=granted_at where binding_id=$1 and revoked_at is null',[newId]);
      }
      await nativeHandover(to,from);
      await rejected(yieldRequest(),'RENEW_HANDOVER_RATE_LIMITED');
      await nativeHandover(from,to);
      assert.equal((await send(holder,discoverGlobal)).on_duty,false);
      await sql("insert into clued_private.ci_train_lease_v1(user_id,project_id,holder_node_id,holder_binding_id,state,issued_at,expires_at) values($1,$2,$3,$4,'sweep_required',now()-interval '20 minutes',now()-interval '10 minutes') on conflict(user_id,project_id) do update set holder_node_id=excluded.holder_node_id,holder_binding_id=excluded.holder_binding_id,state=excluded.state,issued_at=excluded.issued_at,expires_at=excluded.expires_at",[f.user,f.project,holder.body.node_id,from]);
      assert.equal((await send(holder)).error_code,'CI_REBIND_NOT_DRAINED');
      await sql('delete from clued_private.ci_train_lease_v1 where holder_node_id=$1',[holder.body.node_id]);
      const next=await send(holder);
      assert.equal(next.status,'committed',JSON.stringify(next)); assert.equal(await current(),to);
      await f.live(holder.body.node_id);
      await sql('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$2 where node_id=$1',[holder.body.node_id,digest('source')]);
      await nativeHandover(to,next.binding_id);
      await setExpiry(next.binding_id,'8 days');
      await t.test('the same node cannot yield again within 24 hours but can after 24 hours', async () => {
        const request = () => yieldRequest(holder, {
          old_binding_id: next.binding_id, generation: 2, old_token_hash: holder.body.new_token_hash,
        });
        const ageReceipt = async age => {
          const receipt = await sql('update public.clued_audit_receipts set created_at=clock_timestamp()-$2::interval where id=$1 returning id', [r.receipt_id, age]);
          assert.equal(receipt.id, r.receipt_id);
        };
        await ageReceipt('23 hours 55 minutes');
        await rejected(request(), 'RENEW_HANDOVER_RATE_LIMITED');
        assert.equal(await current(), next.binding_id);

        await ageReceipt('24 hours 5 minutes');
        const retry = f.committed(await request());
        assert.deepEqual([retry.from_binding_id, retry.to_binding_id, await current()], [next.binding_id, to, to]);
      });
    });
  } finally { await f.close(); }
});

test('fleet target on the CI probe follows the latest approval and survives an older door replay', async () => {
  const f = await schedulingFixture();
  try {
    const repository = 'tdoljyj/cross-memory-system';
    const sql = async (q, args) => (await f.admin.query(q, args)).rows[0];
    const receipt = await sql(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,'global','binding_role_set','binding_role','fixture',1,'{}') returning id`, [f.user, f.binding]);
    await sql(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'release-door',now(),$3)`, [f.user, f.binding, receipt.id]);
    await sql('select clued_private.release_door_install_v1($1)', [repository]);

    async function node(label) {
      const selected = [{ resource_kind: 'scope', resource_id: 'project:' + f.project, environment: 'canonical', actions: ['read'] }];
      const p = await f.native('clued_headless_binding_confirmation_issue_v1', { label, days: 30, selected });
      const binding = f.committed(await f.native('clued_headless_binding_issue_v1', { confirmation_token: p.confirmation_token, view_digest: p.view_digest }));
      const n = f.committed(await f.native('clued_ci_node_registration_v1', { ...f.registration(), name: label, binding_id: binding.binding_id }));
      await f.approve(n.node_id);
      const { identity_fingerprint } = await sql('select identity_fingerprint from clued_private.ci_nodes_v1 where node_id=$1', [n.node_id]);
      return { id: n.node_id, binding, identity_fingerprint };
    }
    const caller = await node('fleet-probe');
    const peer = await node('fleet-peer');
    await setWorkerGatewayCaller(f.gateway);
    async function probe(n = caller) {
      // 用夹具数据库的时钟生成本条语句的签发时间，续期函数也用数据库时钟校验新鲜度。
      const response = (await f.gateway.query(`select public.clued_ci_connection_renew_v1(
        $1::jsonb || jsonb_build_object('issued_at', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ) v`, [{
        contract: 'clued.ci-connection-renew/1', kind: 'ci', project_id: f.project, node_id: n.id,
        identity_fingerprint: n.identity_fingerprint, old_binding_id: n.binding.binding_id, old_token_hash: digest(n.binding.token),
        generation: 1, new_token_hash: null,
      }])).rows[0].v;
      assert.equal(response.status, 'ok');
      return response.fleet_target;
    }
    assert.equal(await probe(), null);
    const resource = v => `fleet-node:${repository}/${v}/${digest(v)}/${digest('request-' + v)}`;
    const ask = async v => (await sql('select clued_private.fleet_accept_door_v1($1) v', [{ action: 'fleet.accept', resources: [resource(v)] }])).v;
    async function approve(v) {
      const pending = await ask(v);
      assert.equal(pending.status, 'pending');
      const p = await f.native('clued_owner_grant_confirmation_issue_v1', { request_id: pending.request_id, choice: 'once' });
      assert.equal(p.status, 'issued');
      f.committed(await f.native('clued_owner_grant_v1', { confirmation_token: p.confirmation_token, view_digest: p.view_digest }));
      return ask(v);
    }
    const n = await approve('18.0.0');
    assert.deepEqual([ (await probe()).version, (await probe()).grant_id ], ['18.0.0', n.grant_id]);
    const n1 = await approve('19.0.0');
    const newest = await probe();
    assert.deepEqual(newest, { repository, version: n1.version, archive_sha256: n1.archive_sha256, request_sha256: n1.request_sha256,
      grant_id: n1.grant_id, receipt_id: n1.receipt_id, accepted_at: n1.accepted_at, other_sources: [null] });
    assert.equal((await ask('18.0.0')).grant_id, n.grant_id);
    assert.deepEqual(await probe(), newest);
    await f.live(peer.id);
    const peerSource = digest('peer-source');
    await sql('update clued_private.ci_node_liveness_v1 set reported_source_sha256=$2 where node_id=$1', [peer.id, peerSource]);
    assert.deepEqual((await probe()).other_sources, [peerSource]);
    await sql("update clued_private.ci_nodes_v1 set state='pending' where node_id=any($1)", [[caller.id, peer.id]]);
    assert.deepEqual((await probe()).other_sources, [peerSource]);
    assert.equal((await probe(peer)).grant_id, n1.grant_id);
    await f.live(peer.id, '21 minutes');
    assert.deepEqual((await probe()).other_sources, [null]);
    await f.live(peer.id);
    await sql("update clued_private.ci_node_liveness_v1 set reported_state='PAUSED' where node_id=$1", [peer.id]);
    assert.deepEqual((await probe()).other_sources, [null]);
    await sql("update clued_private.ci_nodes_v1 set state='retired' where node_id=$1", [peer.id]);
    assert.deepEqual((await probe()).other_sources, []);
  } finally { await f.close(); }
});
