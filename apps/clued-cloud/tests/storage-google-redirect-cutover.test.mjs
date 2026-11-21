// issuer-credentials: disposable table-only PostgreSQL with extracted storage OAuth app/attempt and issuer identity tables.
// Synthetic identity keys test deployment-config CAS only; no issuer credential
// table, credential RPC, stage/activate path or test credential grant is created.
// Synthetic accounts/envelopes never use a live service.
import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { buildCutoverSql, buildPreflightSql, validateCutover, main,
  GOOGLE_CLIENT_ID, OLD_CALLBACK, NEW_CALLBACK } from '../scripts/storage-google-redirect-cutover.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issuer = '12345678-1234-4567-89ab-123456789abc';
const owner = '12345678-1234-4567-89ab-123456789abd';
const session = '12345678-1234-4567-89ab-123456789abe';
const key = 'a'.repeat(64);
const metadata = () => ({ contract: 'kooyumi.storage-google-redirect-cutover/1',
  storage_issuer_id: issuer, direction: 'forward',
  expected_flags: { execution_enabled: false, read_enabled: true, onboard_open: true } });

test('all parameterized entry points fail closed for malformed, unknown and injection inputs', () => {
  for (const operation of [validateCutover, buildCutoverSql]) {
    assert.doesNotThrow(() => operation(metadata()));
    for (const value of [null, undefined, [], 1, 'metadata', new Date()]) assert.throws(() => operation(value));
    for (const field of Object.keys(metadata())) {
      const value = metadata(); delete value[field]; assert.throws(() => operation(value));
    }
    for (const field of ['token', 'issuer_hash', 'client_secret', 'redirect_uri', 'extra', '__proto__']) {
      const value = metadata(); Object.defineProperty(value, field, { value: 'hidden-credential-fixture', enumerable: true });
      assert.throws(() => operation(value), error => !String(error).includes('hidden-credential-fixture'));
    }
    for (const value of ['', issuer.toUpperCase(), issuer + "'; DELETE FROM auth.users; --",
      '00000000-0000-0000-0000-000000000000', ' ' + issuer, issuer.slice(1), null, 42]) {
      assert.throws(() => operation({ ...metadata(), storage_issuer_id: value }));
    }
    for (const value of ['FORWARD', 'rollback', "forward'; COMMIT; --", null, true]) {
      assert.throws(() => operation({ ...metadata(), direction: value }));
    }
    for (const field of ['execution_enabled', 'read_enabled', 'onboard_open']) {
      for (const value of ['true', 'false', 0, 1, null, undefined, 'true; DROP TABLE x']) {
        const input = metadata(); input.expected_flags[field] = value; assert.throws(() => operation(input));
      }
      const missing = metadata(); delete missing.expected_flags[field]; assert.throws(() => operation(missing));
    }
    const extra = metadata(); extra.expected_flags.secret = 'hidden'; assert.throws(() => operation(extra));
  }
});

test('generation is deterministic, read-only by default, and only changes the fixed callback', () => {
  const input = metadata(); const before = JSON.stringify(input);
  assert.equal(buildCutoverSql(input), buildCutoverSql(input));
  assert.equal(JSON.stringify(input), before);
  const sql = buildCutoverSql(input);
  assert.match(sql, /SET LOCAL search_path=pg_catalog;/);
  assert.match(sql, /SET LOCAL lock_timeout='5s';/);
  assert.match(sql, /SET LOCAL statement_timeout='15s';/);
  assert.match(sql, /SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /FOR UPDATE OF a/);
  assert.match(sql, /GET DIAGNOSTICS v_rows=ROW_COUNT/);
  assert.equal((sql.match(/\bUPDATE clued_private\./g) || []).length, 1);
  assert.doesNotMatch(sql, /\b(?:CREATE|DELETE|INSERT|TRUNCATE|GRANT|RETURNING)\b/i);
  assert.doesNotMatch(buildPreflightSql(), /\b(?:UPDATE|DELETE|INSERT|CREATE|FOR UPDATE)\b/i);
  assert.doesNotMatch(buildPreflightSql().split('FROM clued_private.storage_oauth_apps_v1 a')[0],
    /SELECT\s+(?:\*|a\.issuer_hash|i\.legacy_key)/i);
});

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
function table(source, marker) {
  const begin = source.indexOf(marker); assert.ok(begin >= 0, marker);
  const end = source.indexOf('\n);', begin); assert.ok(end >= 0, marker);
  return source.slice(begin, end + 4);
}
async function realSchema() {
  const migration = async name => fs.readFile(path.join(app, 'supabase/migrations', name), 'utf8');
  const oauth = await migration('20260927075249_resource_center_oauth_connector_v1.sql');
  const identity = await migration('20261009070001_issuer_identity_credentials_v1.sql');
  const onboard = await migration('20261001040000_storage_onboard_n0.sql');
  return `CREATE SCHEMA clued_private; CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE clued_private.storage_connections_v1 (id uuid PRIMARY KEY);
    CREATE TABLE public.clued_audit_receipts (id uuid PRIMARY KEY);
    ${table(identity, 'create table if not exists clued_private.issuer_identities_v1 (')}
    ${table(oauth, 'create table clued_private.storage_oauth_apps_v1 (')}
    ALTER TABLE clued_private.storage_oauth_apps_v1
      ADD COLUMN execution_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN read_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN onboard_open boolean NOT NULL DEFAULT false;
    ${table(oauth, 'create table clued_private.storage_oauth_attempts_v1 (')}
    ${table(onboard, 'create table clued_private.storage_onboard_attempts_v1 (')}
    ALTER TABLE clued_private.storage_oauth_attempts_v1
      ALTER COLUMN connection_id DROP NOT NULL,
      ADD COLUMN purpose text NOT NULL DEFAULT 'connection' CHECK (purpose IN ('connection','credential_recovery','onboard')),
      ADD COLUMN onboard_attempt_id uuid REFERENCES clued_private.storage_onboard_attempts_v1(id);`;
}
const rows = result => (Array.isArray(result) ? result : [result]).flatMap(part => part.rows || []);
async function snapshot(client) {
  return (await client.query(`SELECT jsonb_build_object(
    'apps',(SELECT jsonb_agg(to_jsonb(a) ORDER BY issuer_hash) FROM clued_private.storage_oauth_apps_v1 a),
    'identities',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM clued_private.issuer_identities_v1 i),
    'oauth',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM clued_private.storage_oauth_attempts_v1 x),
    'onboard',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM clued_private.storage_onboard_attempts_v1 o)
  ) AS state`)).rows[0].state;
}

test('forward/reverse SQL enforce callback drainage, exact CAS, operator and history preservation in PostgreSQL',
  { timeout: 120000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kooyumi-storage-redirect-test-'));
    const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres',
      password: crypto.randomBytes(32).toString('hex'), port: await freePort(), persistent: false,
      initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--locale=C'], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError() {} });
    const clients = []; let index = 0;
    try {
      await server.initialise(); await server.start();
      const control = server.getPgClient(); clients.push(control); await control.connect();
      await control.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator NOLOGIN;
        CREATE ROLE fixture_operator NOLOGIN;`);
      const schema = await realSchema();
      async function fixture() {
        const db = 'redirect_case_' + (++index); await control.query('CREATE DATABASE ' + db);
        const client = server.getPgClient(db); clients.push(client); await client.connect(); await client.query(schema);
        await client.query('INSERT INTO auth.users VALUES ($1)', [owner]);
        await client.query("INSERT INTO clued_private.issuer_identities_v1(id,kind,legacy_key) VALUES($1,'storage',$2)", [issuer, key]);
        await client.query(`INSERT INTO clued_private.storage_oauth_apps_v1
          (issuer_hash,oauth_client_id,redirect_uri,execution_enabled,read_enabled,onboard_open)
          VALUES($1,$2,$3,false,true,true)`, [key, GOOGLE_CLIENT_ID, OLD_CALLBACK]);
        return { client, db };
      }
      async function attempt(client, { status = 'prepared', purpose = 'connection', seconds = 300,
        onboardState = 'begun', onboardSeconds = 300, credential = false } = {}) {
        const id = crypto.randomUUID(); const connection = crypto.randomUUID(); const onboardId = crypto.randomUUID();
        await client.query('INSERT INTO clued_private.storage_connections_v1 VALUES($1)', [connection]);
        if (purpose === 'onboard') await client.query(`INSERT INTO clued_private.storage_onboard_attempts_v1
          (id,owner_id,session_id,issuer_hash,oauth_attempt_id,connection_id,root_mode,root_name,tracks,
          normal_use_requested,default_refresh_requested,disclosure_version,disclosure_text,disclosure_sha256,
          state,provider_subject,granted_scope_profile,credential_envelope,run_token,run_lease_until,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'new','Synthetic fixture','["tasks"]',false,false,
          'clued.storage-onboard-disclosure/1','Synthetic disclosure',$7,$8,$9,$10,$11,$12,$13,
          clock_timestamp()+make_interval(secs=>$14))`,
        [onboardId, owner, session, key, id, connection, 'b'.repeat(64), onboardState,
          onboardState === 'credential_staged' ? 'fixture-subject' : null,
          onboardState === 'credential_staged' ? 'normal' : null,
          credential ? { fixture: true } : null,
          onboardState === 'credential_staged' ? crypto.randomUUID() : null,
          onboardState === 'credential_staged' ? new Date(Date.now() - 1000) : null, onboardSeconds]);
        await client.query(`INSERT INTO clued_private.storage_oauth_attempts_v1
          (id,connection_id,owner_id,session_id,issuer_hash,connection_version,state_hash,verifier_envelope,
          expires_at,status,purpose,onboard_attempt_id)
          VALUES($1,$2,$3,$4,$5,1,$6,'{"fixture":true}',clock_timestamp()+make_interval(secs=>$7),$8,$9,$10)`,
        [id, purpose === 'onboard' ? null : connection, owner, session, key,
          crypto.randomBytes(32).toString('hex'), seconds, status, purpose, purpose === 'onboard' ? onboardId : null]);
      }
      async function refused(client, expected, input = metadata()) {
        const before = await snapshot(client);
        await assert.rejects(client.query(buildCutoverSql(input)), error => !expected || error.message === expected);
        await client.query('ROLLBACK'); assert.deepEqual(await snapshot(client), before);
      }
      await t.test('preflight exposes only minimal metadata and exact live/history counts', async () => {
        const { client } = await fixture();
        await attempt(client); await attempt(client, { status: 'claimed', purpose: 'credential_recovery' });
        await attempt(client, { purpose: 'onboard' });
        await attempt(client, { purpose: 'onboard', onboardSeconds: -60 });
        await attempt(client, { purpose: 'onboard', status: 'claimed', onboardState: 'credential_staged', credential: true });
        await attempt(client, { purpose: 'onboard', status: 'claimed', onboardState: 'failed', credential: true });
        await attempt(client, { status: 'claimed', seconds: -60 });
        const before = await snapshot(client); const result = rows(await client.query(buildPreflightSql()));
        assert.deepEqual(Object.keys(result[0]).sort(), ['storage_issuer_id','oauth_client_id','redirect_uri',
          'execution_enabled','read_enabled','onboard_open','active_app_count','callback_live',
          'postexchange_resumable_live','expired_claimed_history'].sort());
        assert.equal(result[0].callback_live, '3'); assert.equal(result[0].postexchange_resumable_live, '2');
        assert.equal(result[0].expired_claimed_history, '1'); assert.deepEqual(await snapshot(client), before);
      });
      await t.test('only redirect changes; claimed history and postexchange resumes survive both directions', async () => {
        const { client } = await fixture();
        await attempt(client, { status: 'claimed', seconds: -60 });
        await attempt(client, { purpose: 'onboard', status: 'claimed', onboardState: 'failed', credential: true });
        await attempt(client, { purpose: 'onboard', onboardSeconds: -60 });
        const before = await snapshot(client); await client.query(buildCutoverSql(metadata()));
        const after = await snapshot(client); const expected = structuredClone(before); expected.apps[0].redirect_uri = NEW_CALLBACK;
        assert.deepEqual(after, expected);
        await refused(client, 'storage_google_redirect_compare_failed');
        await client.query(buildCutoverSql({ ...metadata(), direction: 'reverse' }));
        assert.deepEqual(await snapshot(client), before);
      });
      for (const details of [{}, { status: 'claimed' }, { purpose: 'credential_recovery', status: 'claimed' },
        { purpose: 'onboard' }, { purpose: 'onboard', status: 'claimed' }]) {
        await t.test('live callback refuses with all rows unchanged: ' + JSON.stringify(details), async () => {
          const { client } = await fixture(); await attempt(client, details);
          await refused(client, 'storage_google_redirect_callbacks_live');
        });
      }
      await t.test('reverse also waits for new-domain callbacks to drain', async () => {
        const { client } = await fixture(); await client.query(buildCutoverSql(metadata())); await attempt(client);
        await refused(client, 'storage_google_redirect_callbacks_live', { ...metadata(), direction: 'reverse' });
      });
      for (const field of ['execution_enabled','read_enabled','onboard_open']) await t.test('flag CAS rejects a changed ' + field, async () => {
        const { client } = await fixture(); await client.query(`UPDATE clued_private.storage_oauth_apps_v1 SET ${field}=NOT ${field}`);
        await refused(client, 'storage_google_redirect_compare_failed');
      });
      for (const [label, setup] of [
        ['client', "UPDATE clued_private.storage_oauth_apps_v1 SET oauth_client_id='different-client'"],
        ['callback', "UPDATE clued_private.storage_oauth_apps_v1 SET redirect_uri='https://unexpected.test/storage/google/callback'"],
        ['revoked app', 'UPDATE clued_private.storage_oauth_apps_v1 SET revoked_at=clock_timestamp()'],
        ['authorization issuer', "UPDATE clued_private.issuer_identities_v1 SET kind='authorization'"],
        ['missing issuer', 'DELETE FROM clued_private.issuer_identities_v1'],
        ['multiple active apps', `INSERT INTO clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri)
          SELECT repeat('c',64),oauth_client_id,redirect_uri FROM clued_private.storage_oauth_apps_v1`],
      ]) await t.test('scope/CAS mismatch refuses: ' + label, async () => {
        const { client } = await fixture(); await client.query(setup); await refused(client);
      });
      for (const role of ['anon','authenticated','service_role','authenticator','fixture_operator']) await t.test('non-operator role rejected: ' + role, async () => {
        const { client } = await fixture();
        await client.query(`GRANT USAGE ON SCHEMA clued_private TO ${role}; SET ROLE ${role}`);
        await assert.rejects(client.query(buildCutoverSql(metadata())), { message: 'storage_google_redirect_operator_required' });
        await client.query('ROLLBACK'); await client.query('RESET ROLE');
        assert.equal(rows(await client.query(buildPreflightSql()))[0].redirect_uri, OLD_CALLBACK);
      });
      await t.test('even a banned application role that owns the table is rejected', async () => {
        const { client } = await fixture(); await client.query('GRANT USAGE ON SCHEMA clued_private TO anon; ALTER TABLE clued_private.storage_oauth_apps_v1 OWNER TO anon; SET ROLE anon');
        await assert.rejects(client.query(buildCutoverSql(metadata())), { message: 'storage_google_redirect_operator_required' });
        await client.query('ROLLBACK'); await client.query('RESET ROLE');
      });
      await t.test('a trigger suppressing the update rolls the entire transaction back', async () => {
        const { client } = await fixture(); await client.query(`CREATE FUNCTION public.fixture_no_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$;
          CREATE TRIGGER fixture_no_update BEFORE UPDATE ON clued_private.storage_oauth_apps_v1 FOR EACH ROW EXECUTE FUNCTION public.fixture_no_update()`);
        await refused(client, 'storage_google_redirect_update_conflict');
      });
      await t.test('concurrent app writer causes bounded lock timeout and zero cutover effects', async () => {
        const { client, db } = await fixture(); const writer = server.getPgClient(db); clients.push(writer); await writer.connect();
        await writer.query('BEGIN; LOCK TABLE clued_private.storage_oauth_apps_v1 IN ROW EXCLUSIVE MODE');
        try { await refused(client, 'canceling statement due to lock timeout'); } finally { await writer.query('ROLLBACK'); }
      });
    } finally {
      await Promise.allSettled(clients.map(client => client.end())); await stopCluster(server);
    }
  });

test('CLI only returns SQL; no arbitrary URL, implicit operation or oversized metadata', async () => {
  assert.equal(await main(['--preflight-sql']), buildPreflightSql());
  for (const args of [[], ['--execute'], ['--preflight-sql','extra'], ['--sql']]) await assert.rejects(main(args));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kooyumi-redirect-input-test-'));
  const input = path.join(directory, 'input.json');
  await fs.writeFile(input, JSON.stringify(metadata()), { flag: 'wx' });
  assert.equal(await main(['--sql', input]), buildCutoverSql(metadata()));
  await fs.writeFile(input, ' '.repeat(4097)); await assert.rejects(main(['--sql', input]));
  await fs.writeFile(input, '{hidden-credential-fixture');
  await assert.rejects(main(['--sql', input]), error => !String(error).includes('hidden-credential-fixture'));
});
