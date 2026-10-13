import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { workerGatewayRpc, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

// Real isolated PostgreSQL with both current migration shapes. No live API,
// credentials, production writes, reviewer dispatch or model calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const human = (sub, extra = {}) => ({ sub, role: 'authenticated', session_id: 'sess-review-owner',
  aal: 'aal1', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }], ...extra });
async function freePort() {
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
for (const profile of ['complete-repository', 'production-installed-shape']) test(profile + ': independent review is default on and Owner-only; resume and renewal read live policy',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-independent-review-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hash(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter(n => n.endsWith('.sql') && (profile === 'complete-repository' || !n.includes('p5_'))).sort();
    for (const name of names) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const owner = uuid(), other = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'review-owner@example.invalid',now()),($2,'review-other@example.invalid',now())`, [owner, other]);
    const tokens = {}, ids = {};
    for (const [name, user] of [['owner',owner], ['reader',owner], ['other',other]]) {
      tokens[name] = hash();
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,$5) returning id`, [user,name,tokens[name],name==='reader'?['context:read']:['context:read','context:write'],['*']])).rows[0].id;
    }
    const anon = server.getPgClient(), page = server.getPgClient(), page2 = server.getPgClient(), worker = server.getPgClient();
    for (const client of [anon,page,page2,worker]) { clients.push(client); await client.connect(); }
    await anon.query('set role anon');
    for (const client of [page,page2]) await client.query('set role authenticated');
    async function native(name, input, claims = human(owner), client = page) {
      await client.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [claims.sub ?? '',JSON.stringify(claims)]);
      return (await client.query(`select public.${name}($1) v`, [input])).rows[0].v;
    }
    const read = claims => native('clued_independent_review_setting_v1',{},claims);
    const turn = (enabled,base_version,claims,client) => native('clued_independent_review_setting_set_v1',{enabled,base_version},claims,client);
    const resume = (who = 'owner',extra = {}) => workerGatewayRpc(worker,'clued_mcp_restore',tokens[who],{event_limit:1,...extra});
    const receipts = () => admin.query("select version,metadata from public.clued_audit_receipts where user_id=$1 and operation='independent_review_setting_set' order by version",[owner]).then(r=>r.rows);
    const initial = await read();
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual([initial.enabled,initial.version,initial.default,initial.execution_authority], [true,0,true,false]);
    const first = await resume();
    assert.equal(first.independent_review.enabled,true);
    assert.equal((await resume('reader',{response_view:'work_log'})).independent_review.enabled,true);
    assert.ok(!('user_id' in first.independent_review));
    for (const client of [anon,page]) {
      await assert.rejects(() => client.query('select * from clued_private.independent_review_settings_v1'), /permission denied/);
      await assert.rejects(() => client.query('select clued_private.independent_review_setting_view_v1($1)',[owner]), /permission denied/);
    }
    await assert.rejects(() => anon.query('select public.clued_independent_review_setting_set_v1($1)',[{enabled:false,base_version:0}]), /permission denied/);
    await assert.rejects(() => turn(false,0,human(owner,{client_id:'delegated-oauth'})), /direct_human_session_required/);
    await assert.rejects(() => read(human(owner,{client_id:'delegated-oauth'})), /direct_human_session_required/);
    await assert.rejects(() => turn(false,0,{role:'authenticated'}), /direct_human_session_required/);
    await assert.rejects(() => turn(false,0,human(uuid())), /direct_human_session_required/);
    const missingSession = human(owner); delete missingSession.session_id;
    await assert.rejects(() => turn(false,0,missingSession), /independent_review_setting_session_required/);
    for (const bad of [[],{}, {enabled:'true',base_version:0}, {enabled:false,base_version:-1},
      {enabled:false,base_version:0.5}, {enabled:false,base_version:0,user_id:other}, {enabled:false,base_version:null}]) {
      await assert.rejects(() => native('clued_independent_review_setting_set_v1',bad), /independent_review_setting_input_invalid/);
    }
    await assert.rejects(() => native('clued_independent_review_setting_v1',{user_id:other}), /independent_review_setting_input_invalid/);
    assert.equal((await receipts()).length,0);
    // Two genuine database connections race from the same displayed version.
    const races = await Promise.all([turn(false,0,human(owner),page),turn(false,0,human(owner),page2)]);
    assert.deepEqual(races.map(r=>r.status).sort(),['committed','rejected']);
    assert.equal(races.find(r=>r.status==='rejected').error_code,'independent_review_setting_version_conflict');
    assert.equal((await receipts()).length,1);
    const off = await resume();
    assert.deepEqual([off.independent_review.enabled,off.independent_review.version,off.independent_review.execution_authority],[false,1,false]);
    assert.equal((await resume('other')).independent_review.enabled,true);
    assert.equal((await read(human(other))).enabled,true);
    assert.equal((await turn(false,1)).changed,false);
    assert.equal((await receipts()).length,1,'no-op creates no duplicate receipt');
    const stale = await turn(true,0);
    assert.equal(stale.error_code,'independent_review_setting_version_conflict');
    assert.equal(stale.current.enabled,false);
    const renewal = (await admin.query(`select clued_private.renew_checkpoint_session(b,s,s.restored_version,extensions.gen_random_uuid()) v
      from public.clued_agent_bindings b join public.clued_continuity_sessions s on s.binding_id=b.id
      where b.id=$1 order by s.started_at desc limit 1`,[ids.owner])).rows[0].v;
    assert.equal(renewal.session_renewal.independent_review.enabled,false,'renewal re-reads policy even when prior session saw on');
    const on = await turn(true,1);
    assert.deepEqual([on.status,on.changed,on.enabled,on.version],['committed',true,true,2]);
    assert.equal((await resume()).independent_review.enabled,true);
    assert.deepEqual((await receipts()).map(r=>[Number(r.version),r.metadata.receipt_kind,r.metadata.execution_authority]),
      [[1,'INDEPENDENT_REVIEW_DISABLED',false],[2,'INDEPENDENT_REVIEW_ENABLED',false]]);
    await assertGatewayCloseoutBoundary(admin);
    await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1',[ids.owner]);
    await assert.rejects(()=>resume(), /binding|revoked|authorized|token/i);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(()=>{});
    await server.stop().catch(()=>{});
    await fs.rm(directory,{recursive:true,force:true});
  }
});
