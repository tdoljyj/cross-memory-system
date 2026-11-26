// issuer-credentials: disposable embedded PostgreSQL with extracted issuer tables/functions only.
// Synthetic verifiers use real stage/activate paths; expired/staged/retired cases test refusal.
// This fixture never enables test credential grants or accesses a live service.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import {
  validateMetadata, buildProvisionSql, buildVerificationSql, safeSummary,
} from '../scripts/kooyumi-issuer-provision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resource = 'https://kooyumi.pixelgrav.com/mcp';
const oldResource = 'https://clued.pixelgrav.com/mcp';
const credentialVerifier = proof => 'cv1:' + crypto.createHash('sha256')
  .update('clued.credential-verifier.v1:' + proof).digest('hex');
const metadata = () => Object.freeze({
  contract: 'kooyumi.authorization-issuer-provision/1',
  resource,
  worker_name: 'clued-cloud',
  secret_name: 'KOOYUMI_AUTHORIZATION_ISSUER_TOKEN',
  old_kv_id: 'd7e56a5789854d42b191333d8b545a97',
  new_kv_id: '84dba66392314bbf82856574f85122fc',
  identity_key: 'a'.repeat(64),
  verifier: credentialVerifier('b'.repeat(64)),
  cloudflare_secret_confirmed: true,
});
const operations = [validateMetadata, buildProvisionSql, buildVerificationSql, safeSummary];

test('provision metadata accepts only the exact confirmed deployment contract', () => {
  const input = metadata();
  const before = JSON.stringify(input);
  assert.doesNotThrow(() => validateMetadata(input));
  for (const build of [buildProvisionSql, buildVerificationSql]) {
    assert.equal(typeof build(input), 'string');
    assert.ok(build(input).trim());
    assert.equal(build(input), build(input));
  }
  assert.equal(JSON.stringify(input), before);
});

test('all entry points reject missing, unknown and credential-bearing metadata', () => {
  for (const operation of operations) {
    for (const input of [undefined, null, [], 'metadata', 42]) {
      assert.throws(() => operation(input));
    }
    for (const key of Object.keys(metadata())) {
      const input = { ...metadata() };
      delete input[key];
      assert.throws(() => operation(input), `${operation.name} must require ${key}`);
    }
    for (const key of ['unknown', 'S', 'secret', 'secret_value', 'proof', 'token']) {
      const hidden = 'never-disclose-raw-credential-' + key;
      assert.throws(() => operation({ ...metadata(), [key]: hidden }), error => {
        assert.ok(!(String(error) + error.stack).includes(hidden));
        return true;
      });
    }
  }
});

test('deployment identity and independent KV identifiers cannot be substituted', () => {
  const replacements = {
    contract: ['kooyumi.authorization-issuer-provision/2', ''],
    resource: [oldResource, resource + '/', "https://x.test/mcp'; select 1; --"],
    worker_name: ['another-worker', ''],
    secret_name: ['CLUED_AUTHORIZATION_ISSUER_TOKEN', ''],
    old_kv_id: ['0'.repeat(32), metadata().new_kv_id],
    new_kv_id: ['0'.repeat(32), metadata().old_kv_id],
    cloudflare_secret_confirmed: [false, 'true', 1, null],
  };
  for (const operation of operations) {
    for (const [key, values] of Object.entries(replacements)) {
      for (const value of values) assert.throws(() => operation({ ...metadata(), [key]: value }));
    }
  }
});

test('identity and verifier require lowercase exact encodings and separate proof material', () => {
  const invalid = [
    { identity_key: '' }, { identity_key: 'a'.repeat(63) },
    { identity_key: 'A'.repeat(64) }, { identity_key: 'g'.repeat(64) },
    { identity_key: ' ' + metadata().identity_key },
    { verifier: '' }, { verifier: 'b'.repeat(64) },
    { verifier: 'cv1:' + 'b'.repeat(63) }, { verifier: 'cv1:' + 'B'.repeat(64) },
    { verifier: credentialVerifier(metadata().identity_key) },
  ];
  for (const operation of operations) {
    for (const value of invalid) assert.throws(() => operation({ ...metadata(), ...value }));
  }
});

test('the safe summary excludes identity, verifier and unexpected credential values', () => {
  const input = metadata();
  const summary = JSON.stringify(safeSummary(input));
  assert.ok(summary && summary !== 'null');
  assert.ok(!summary.includes(input.identity_key));
  assert.ok(!summary.includes(input.verifier));
  assert.ok(!summary.includes(input.verifier.slice(4)));
  assert.ok(!summary.includes('identity_key'));
  assert.ok(!summary.includes('verifier'));
});


function statement(source, start) {
  const begin = source.indexOf(start);
  assert.ok(begin >= 0, `missing fixture source: ${start}`);
  const end = source.indexOf('\n);', begin);
  assert.ok(end >= 0, `unterminated fixture table: ${start}`);
  return source.slice(begin, end + 4);
}

function functionSource(source, name) {
  const begin = source.indexOf(`create or replace function clued_private.${name}(`);
  assert.ok(begin >= 0, `missing real function: ${name}`);
  const end = source.indexOf('end $$;', begin);
  assert.ok(end >= 0, `unterminated real function: ${name}`);
  return source.slice(begin, end + 7);
}

async function minimalSchema() {
  const issuerMigration = await fs.readFile(path.join(root, 'supabase/migrations/20261009070001_issuer_identity_credentials_v1.sql'), 'utf8');
  const oldMigration = await fs.readFile(path.join(root, 'supabase/migrations/20260907173031_clued_connection_authorization_v12.sql'), 'utf8');
  return [
    `create schema clued_private; create schema extensions; create extension pgcrypto with schema extensions;
    create function public.clued_authorization_prepare_v12(text,jsonb) returns jsonb language sql as
      $$select jsonb_build_object('synthetic_wrapper_marker','issuer_resolve_identity_compatible_v1')$$;`,
    statement(oldMigration, 'create table clued_private.authorization_issuers_v12 ('),
    statement(issuerMigration, 'create table if not exists clued_private.issuer_identities_v1 ('),
    statement(issuerMigration, 'create table if not exists clued_private.issuer_credentials_v1 ('),
    ...['issuer_identity_provision_v1', 'issuer_identity_guard_v1', 'issuer_credential_guard_v1',
      'issuer_credential_stage_v1', 'issuer_credential_activate_v1', 'issuer_credential_retire_v1']
      .map(name => functionSource(issuerMigration, name)),
    `create trigger issuer_identity_provision_v1 after insert on clued_private.authorization_issuers_v12
      for each row execute function clued_private.issuer_identity_provision_v1('authorization');
    create trigger issuer_identity_immutable_v1 before update or delete on clued_private.issuer_identities_v1
      for each row execute function clued_private.issuer_identity_guard_v1();
    create trigger issuer_credential_history_immutable_v1 before update or delete on clued_private.issuer_credentials_v1
      for each row execute function clued_private.issuer_credential_guard_v1();`,
  ].join('\n');
}

async function seedIssuer(client, identity, issuerResource, verifier) {
  await client.query('insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,$3)',
    [identity, issuerResource, identity === metadata().identity_key ? 'Kooyumi OAuth issuer' : 'Synthetic issuer fixture']);
  const { id } = (await client.query("select id from clued_private.issuer_identities_v1 where kind='authorization' and legacy_key=$1", [identity])).rows[0];
  if (verifier) {
    const { generation } = (await client.query('select clued_private.issuer_credential_stage_v1($1,$2) generation', [id, verifier])).rows[0];
    await client.query('select clued_private.issuer_credential_activate_v1($1,$2)', [id, generation]);
  }
  return id;
}

async function snapshot(client) {
  return (await client.query(`select jsonb_build_object(
    'issuers', (select jsonb_agg(to_jsonb(a)||jsonb_build_object('__xmin',a.xmin::text) order by token_hash) from clued_private.authorization_issuers_v12 a),
    'identities', (select jsonb_agg(to_jsonb(i)||jsonb_build_object('__xmin',i.xmin::text) order by id) from clued_private.issuer_identities_v1 i),
    'credentials', (select jsonb_agg(to_jsonb(c)||jsonb_build_object('__xmin',c.xmin::text) order by issuer_id,generation) from clued_private.issuer_credentials_v1 c)
  ) state`)).rows[0].state;
}

test('provision SQL enforces ownership, isolated registration and immutable replay in local PostgreSQL', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kooyumi-provision-test-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: crypto.randomBytes(32).toString('hex'),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--locale=C'], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError() {},
  });
  const clients = [];
  let databaseIndex = 0;
  try {
    await startCluster(server);
    const control = server.getPgClient(); clients.push(control); await control.connect();
    await control.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;`);
    const schema = await minimalSchema();
    async function fixture() {
      const name = 'provision_case_' + (++databaseIndex);
      await control.query('create database ' + name);
      const client = server.getPgClient(name); clients.push(client); await client.connect();
      await client.query(schema);
      await seedIssuer(client, '1'.repeat(64), oldResource, credentialVerifier('2'.repeat(64)));
      return client;
    }
    async function rejectedWithoutChange(client, input = metadata()) {
      const before = await snapshot(client);
      await assert.rejects(client.query(buildProvisionSql(input)));
      await client.query('rollback');
      assert.deepEqual(await snapshot(client), before);
    }

    await t.test('first provision creates one active generation; exact replay and verification do not write', async () => {
      const client = await fixture();
      const oldBefore = await snapshot(client);
      await client.query(buildProvisionSql(metadata()));
      const issuer = (await client.query(`select a.*, i.id from clued_private.authorization_issuers_v12 a
        join clued_private.issuer_identities_v1 i on i.legacy_key=a.token_hash and i.kind='authorization'
        where a.resource=$1`, [resource])).rows;
      assert.equal(issuer.length, 1);
      assert.equal(issuer[0].token_hash, metadata().identity_key);
      assert.equal(issuer[0].revoked_at, null);
      const credentials = (await client.query('select * from clued_private.issuer_credentials_v1 where issuer_id=$1', [issuer[0].id])).rows;
      assert.equal(credentials.length, 1);
      assert.equal(credentials[0].generation, '1');
      assert.equal(credentials[0].state, 'active');
      assert.equal(credentials[0].verifier, metadata().verifier);
      assert.ok(credentials[0].activated_at);
      const after = await snapshot(client);
      for (const key of ['issuers', 'identities', 'credentials']) {
        const oldRows = oldBefore[key];
        assert.deepEqual(after[key].filter(row => oldRows.some(old => JSON.stringify(old) === JSON.stringify(row))), oldRows);
      }
      await client.query(buildProvisionSql(metadata()));
      assert.deepEqual(await snapshot(client), after);
      const verified = await client.query(buildVerificationSql(metadata()));
      const verifiedRows = (Array.isArray(verified) ? verified : [verified]).flatMap(result => result.rows);
      assert.equal(verifiedRows.length, 1);
      assert.equal(verifiedRows[0].credential_generation, '1');
      assert.equal(verifiedRows[0].expected_credential_active, true);
      assert.equal(verifiedRows[0].identity_is_not_active_proof, true);
      assert.deepEqual(await snapshot(client), after);
    });

    await t.test('a different issuer already registered for the new resource is rejected', async () => {
      const client = await fixture();
      await seedIssuer(client, '3'.repeat(64), resource, credentialVerifier('4'.repeat(64)));
      await rejectedWithoutChange(client);
    });

    await t.test('the same identity cannot be reused for another resource', async () => {
      const client = await fixture();
      await seedIssuer(client, metadata().identity_key, 'https://different.test/mcp', metadata().verifier);
      await rejectedWithoutChange(client);
    });

    await t.test('an existing identity with a different active verifier cannot be overwritten', async () => {
      const client = await fixture();
      await seedIssuer(client, metadata().identity_key, resource, credentialVerifier('5'.repeat(64)));
      await rejectedWithoutChange(client);
    });

    await t.test('retired, expired and merely staged generations cannot be restored by replay', async () => {
      for (const state of ['retired', 'expired', 'staged']) {
        const client = await fixture();
        if (state === 'retired') {
          await client.query(buildProvisionSql(metadata()));
          const id = (await client.query("select id from clued_private.issuer_identities_v1 where kind='authorization' and legacy_key=$1", [metadata().identity_key])).rows[0].id;
          await client.query('select clued_private.issuer_credential_retire_v1($1,1)', [id]);
        } else if (state === 'expired') {
          const id = await seedIssuer(client, metadata().identity_key, resource);
          await client.query(`insert into clued_private.issuer_credentials_v1
            (issuer_id,generation,verifier,state,created_at,activated_at,valid_until)
            values($1,1,$2,'active',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`,
          [id, metadata().verifier]);
        } else {
          const id = await seedIssuer(client, metadata().identity_key, resource);
          await client.query('select clued_private.issuer_credential_stage_v1($1,$2)', [id, metadata().verifier]);
        }
        await rejectedWithoutChange(client);
      }
    });

    await t.test('activation failure rolls back the newly inserted issuer, identity and staged credential', async () => {
      const client = await fixture();
      await client.query(`create or replace function clued_private.issuer_credential_activate_v1(p_issuer uuid,p_generation bigint)
        returns void language plpgsql set search_path='' as $$begin
          raise exception 'synthetic_activation_failure' using errcode='40001'; end $$;`);
      await rejectedWithoutChange(client);
    });

    await t.test('ordinary API roles are denied even if execution and table privileges were accidentally granted', async () => {
      for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
        const client = await fixture();
        const before = await snapshot(client);
        await client.query(`grant usage on schema clued_private to ${role};
          grant all on all tables in schema clued_private to ${role};
          grant execute on all functions in schema clued_private to ${role};
          set role ${role};`);
        await assert.rejects(client.query(buildProvisionSql(metadata())), error => error.code === '42501');
        await client.query('rollback');
        await client.query('reset role');
        assert.deepEqual(await snapshot(client), before);
      }
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    const resolved = path.resolve(directory);
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('kooyumi-provision-test-'));
    await removeTestDirectory(resolved);
  }
});
