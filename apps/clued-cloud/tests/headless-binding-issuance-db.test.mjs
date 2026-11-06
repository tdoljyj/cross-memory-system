import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
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

// Headless Binding issuance (migration 20261004120000, Task 364212a1, Owner
// Decision 6e0371e3): the Owner issues a least-privilege, expiring Binding
// token for a client that cannot do OAuth, in two Native steps on the signed-in
// page. No Binding can issue one; the token is shown once and only its hash is
// stored; rotation moves roles and lets the old token expire an hour later.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hex = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const nowEpoch = () => Math.floor(Date.now() / 1000);
const fresh = (sub, session = 'sess-main') =>
  ({ sub, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: nowEpoch() }] });

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('headless Binding issuance: Native two steps, least privilege, expiry, rotation', { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-headless-binding-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hex(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);

    const userId = uuid();
    const otherUser = uuid();
    const projectId = uuid();
    const otherProject = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'headless@example.invalid',now()),($2,'headless-other@example.invalid',now())`, [userId, otherUser]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,'Alpha','alpha',$3,'confirmed',now()),($4,$5,'Other','other',$6,'confirmed',now())`,
    [projectId, userId, `project:${projectId}`, otherProject, otherUser, `project:${otherProject}`]);
    // A pre-v12 CI Binding (no authorization row), as created out of band today.
    const legacyToken = hex();
    const legacyId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'GitHub Actions','ci legacy',$2,array['context:read'],array['*']) returning id`,
    [userId, legacyToken])).rows[0].id;

    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const human = server.getPgClient();
    clients.push(human);
    await human.connect();
    await human.query('set role authenticated');
    const native = async (name, input, claims = fresh(userId)) => {
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [claims.sub ?? '', JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) v`, [input])).rows[0].v;
    };
    const resolve = (tokenHash, scope, key) =>
      admin.query('select (clued_private.resolve_binding($1,$2,$3)).id', [tokenHash, scope, key]);
    const readGlobal = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }];
    const issue = async (input, claims) => {
      const confirmation = await native('clued_headless_binding_confirmation_issue_v1', input, claims);
      assert.equal(confirmation.status, 'issued', JSON.stringify(confirmation));
      return { confirmation, result: await native('clued_headless_binding_issue_v1',
        { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest }, claims) };
    };

    // --- Only the Owner's Native account session can issue. ---
    for (const name of ['clued_headless_binding_list_v1', 'clued_headless_binding_confirmation_issue_v1',
      'clued_headless_binding_issue_v1', 'clued_headless_binding_revoke_v1']) {
      await assert.rejects(() => anon.query(`select public.${name}($1)`, [{}]), /permission denied/, name);
    }
    for (const name of ['headless_binding_eligible_v1', 'binding_expiry_sweep_v1']) {
      await assert.rejects(() => human.query(`select clued_private.${name}(${name === 'headless_binding_eligible_v1' ? `'${userId}'` : ''})`),
        /permission denied/, name);
    }
    // An OAuth-delegated JWT (client_id claim) is not a direct human session.
    await assert.rejects(() => native('clued_headless_binding_confirmation_issue_v1',
      { label: 'x', days: 7, selected: readGlobal }, { ...fresh(userId), client_id: 'some-oauth-client' }),
    /direct_human_session_required/);
    assert.equal((await native('clued_headless_binding_confirmation_issue_v1',
      { label: 'x', days: 7, selected: readGlobal }, { ...fresh(userId), session_id: undefined })).error_code,
    'confirmation_token_session_id_required');
    // Every public RPC that makes the Native owner check is VOLATILE (PostgREST
    // runs STABLE RPCs read-only, and the check locks the account row).
    assert.deepEqual((await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.provolatile<>'v' and p.prosrc like '%authorization_owner_v12%' order by 1`)).rows, []);

    // --- Step 1 validates the choice. ---
    const step1Error = async (input) => (await native('clued_headless_binding_confirmation_issue_v1', input)).error_code;
    assert.equal(await step1Error({ label: 'ci', days: 7, selected: [] }), 'explicit_nonempty_selection_required');
    assert.equal(await step1Error({ label: 'ci', days: 0, selected: readGlobal }), 'headless_binding_expiry_invalid');
    assert.equal(await step1Error({ label: 'ci', days: 91, selected: readGlobal }), 'headless_binding_expiry_invalid');
    assert.equal(await step1Error({ label: 'ci', days: 7.5, selected: readGlobal }), 'headless_binding_expiry_invalid');
    assert.equal(await step1Error({ label: 'ci', selected: readGlobal }), 'headless_binding_expiry_invalid');
    assert.equal(await step1Error({ label: '', days: 7, selected: readGlobal }), 'headless_binding_label_invalid');
    assert.equal(await step1Error({ label: 'a\nb', days: 7, selected: readGlobal }), 'headless_binding_label_invalid');
    assert.equal(await step1Error({ label: 'x'.repeat(81), days: 7, selected: readGlobal }), 'headless_binding_label_invalid');
    assert.equal(await step1Error({ label: 'ci', days: 7, selected: readGlobal, extra: 1 }), 'headless_binding_input_invalid');
    assert.equal(await step1Error({ label: 'ci', days: 7, selected: [{ resource_kind: 'scope',
      resource_id: `project:${otherProject}`, environment: 'canonical', actions: ['read'] }] }),
    'selection_exceeds_requested_or_owned_permissions');
    assert.equal(await step1Error({ label: 'ci', days: 7, selected: [{ resource_kind: 'scope',
      resource_id: 'global', environment: 'canonical', actions: ['read', 'admin'] }] }),
    'selection_exceeds_requested_or_owned_permissions');
    assert.equal(await step1Error({ label: 'ci', days: 7, selected: readGlobal, replaces_binding_id: uuid() }),
      'headless_binding_replace_target_invalid');

    // --- Issue a read-only Global Binding. ---
    const selected = [
      { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] },
      { resource_kind: 'scope', resource_id: `project:${projectId}`, environment: 'canonical', actions: ['read', 'write'] },
    ];
    const { confirmation, result } = await issue({ label: 'CI reader', days: 30, selected });
    assert.equal(confirmation.confirmation_view.label, 'CI reader');
    assert.equal(confirmation.confirmation_view.days, 30);
    assert.deepEqual(confirmation.confirmation_view.scopes, ['context:read', 'context:write']);
    assert.equal(confirmation.confirmation_view.selected[1].name, 'Alpha');
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.match(result.token, /^clued_bnd_[A-Za-z0-9_-]{43}$/);
    const binding = (await admin.query(`select b.*,a.issuance,a.request_id,a.expires_at auth_expires,a.client_id
      from public.clued_agent_bindings b join clued_private.authorizations_v12 a on a.binding_id=b.id where b.id=$1`,
    [result.binding_id])).rows[0];
    assert.equal(binding.token_hash, (await admin.query('select clued_private.credential_verifier_v1($1) v', [sha256(result.token)])).rows[0].v,
      'the Binding stores the verifier of sha256(token)');
    assert.equal(binding.vendor, 'Headless');
    assert.equal(binding.issuance, 'headless');
    assert.equal(binding.request_id, null);
    assert.equal(binding.client_id, 'clued-headless');
    assert.deepEqual(binding.scopes, ['context:read', 'context:write']);
    assert.deepEqual(binding.context_keys, ['global', `project:${projectId}`]);
    const days = (binding.auth_expires.getTime() - Date.now()) / 86400000;
    assert.ok(days > 29.9 && days <= 30, String(days));
    // The raw token is nowhere in the database.
    const dump = JSON.stringify((await admin.query(`select (select jsonb_agg(r) from public.clued_audit_receipts r) a,
      (select jsonb_agg(t) from clued_private.native_confirmation_tokens t) b,
      (select jsonb_agg(x) from clued_private.authorization_audit_v12 x) c`)).rows);
    assert.ok(!dump.includes(result.token));
    const receipt = (await admin.query('select * from public.clued_audit_receipts where id=$1', [result.receipt_id])).rows[0];
    assert.equal(receipt.metadata.receipt_kind, 'HEADLESS_BINDING_ISSUED');
    assert.equal(receipt.metadata.binding_id, result.binding_id);

    // Least privilege: exactly what was chosen.
    const tokenHash = sha256(result.token);
    assert.equal((await resolve(tokenHash, 'context:read', 'global')).rows[0].id, result.binding_id);
    assert.equal((await resolve(tokenHash, 'context:read', `project:${projectId}`)).rows[0].id, result.binding_id);
    await assert.rejects(() => resolve(tokenHash, 'context:write', 'global'), /binding_not_authorized|resource_action_not_authorized/);
    await assert.rejects(() => resolve(tokenHash, 'context:read', 'profile'), /binding_not_authorized|resource_action_not_authorized/);
    await assert.rejects(() => resolve(tokenHash, 'audit:read', 'global'), /binding_not_authorized|resource_action_not_authorized/);

    // The confirmation token is single use; a replay never shows the token again.
    const replay = await native('clued_headless_binding_issue_v1',
      { confirmation_token: confirmation.confirmation_token, view_digest: confirmation.view_digest });
    assert.deepEqual([replay.status, replay.replayed, replay.token], ['committed', true, null]);
    assert.equal((await admin.query("select count(*)::int n from public.clued_agent_bindings where vendor='Headless'")).rows[0].n, 1);

    // --- Step 2 binds to the session and the exact view. ---
    let pending = await native('clued_headless_binding_confirmation_issue_v1', { label: 'other session', days: 7, selected: readGlobal });
    let refused = await native('clued_headless_binding_issue_v1',
      { confirmation_token: pending.confirmation_token, view_digest: pending.view_digest }, fresh(userId, 'sess-other'));
    assert.equal(refused.error_code, 'confirmation_token_binding_mismatch');
    refused = await native('clued_headless_binding_issue_v1',
      { confirmation_token: pending.confirmation_token, view_digest: pending.view_digest });
    assert.equal(refused.error_code, 'confirmation_token_reused');
    pending = await native('clued_headless_binding_confirmation_issue_v1', { label: 'digest', days: 7, selected: readGlobal });
    refused = await native('clued_headless_binding_issue_v1',
      { confirmation_token: pending.confirmation_token, view_digest: '0'.repeat(64) });
    assert.equal(refused.error_code, 'confirmation_token_binding_mismatch');
    // Another user cannot use this user's confirmation token.
    pending = await native('clued_headless_binding_confirmation_issue_v1', { label: 'theft', days: 7, selected: readGlobal });
    refused = await native('clued_headless_binding_issue_v1',
      { confirmation_token: pending.confirmation_token, view_digest: pending.view_digest }, fresh(otherUser));
    assert.equal(refused.error_code, 'confirmation_token_invalid');

    // --- Listed, reduced and revoked by the existing OAuth connection management. ---
    const managed = await native('clued_authorization_manage_v12', { op: 'list' });
    const entry = managed.bindings.find((b) => b.binding_id === result.binding_id);
    assert.equal(entry.client_id, 'clued-headless');
    assert.equal(entry.active, true);
    const reduced = await native('clued_authorization_manage_v12', { op: 'reduce', binding_id: result.binding_id,
      base_version: 1, selection_format: 'sources_v1', exceptions: [],
      sources: entry.sources.map((source) => ({ source_id: source.source_id, base_version: source.version,
        action_cap: source.contributions.some((row) => row.resource_id === 'global') ? ['read'] : [] })) });
    assert.equal(reduced.version, 2);
    await assert.rejects(() => resolve(tokenHash, 'context:read', `project:${projectId}`), /resource_action_not_authorized/);

    // --- The headless list shows headless and legacy Bindings, with roles. ---
    let listed = await native('clued_headless_binding_list_v1', {});
    assert.deepEqual(listed.bindings.map((b) => [b.binding_id, b.kind]).sort(),
      [[result.binding_id, 'headless'], [legacyId, 'legacy']].sort());
    assert.ok(listed.eligible.some((e) => e.resource_id === `project:${projectId}`));
    assert.ok(!listed.eligible.some((e) => e.resource_id === `project:${otherProject}`));

    // --- Rotation of the legacy CI Binding, which holds the ci-admission role. ---
    // Marked as a resident node, the role starts 5 minutes later (C10, Task bb13efb5).
    const role = await native('clued_binding_role_confirmation_issue_v1',
      { binding_id: legacyId, role: 'ci-admission', enabled: true, purpose: 'resident-node' });
    assert.equal((await native('clued_binding_role_set_v1',
      { confirmation_token: role.confirmation_token, view_digest: role.view_digest })).status, 'committed');
    const markedRow = (await admin.query(`select effective_at,purpose from clued_private.binding_roles_v1
      where binding_id=$1 and role='ci-admission' and revoked_at is null`, [legacyId])).rows[0];
    assert.ok(markedRow.effective_at.getTime() > Date.now(), 'the marked row has not started yet');
    // The new Binding must hold each moving role's scope.
    assert.equal(await step1Error({ label: 'CI admission', days: 90, replaces_binding_id: legacyId,
      selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['audit'] }] }),
    'headless_binding_role_scope_missing');
    const rotated = await issue({ label: 'CI admission', days: 90, selected: readGlobal, replaces_binding_id: legacyId });
    assert.deepEqual(rotated.confirmation.confirmation_view.replaces.roles, ['ci-admission']);
    assert.equal(rotated.result.status, 'committed', JSON.stringify(rotated.result));
    assert.deepEqual(rotated.result.replaced.roles_moved, ['ci-admission']);
    const roles = (await admin.query(`select binding_id,effective_at,purpose from clued_private.binding_roles_v1
      where role='ci-admission' and revoked_at is null`)).rows;
    assert.deepEqual(roles.map((r) => r.binding_id), [rotated.result.binding_id]);
    // The moved row keeps its start and purpose: a rotation never shortens the wait.
    assert.equal(roles[0].effective_at.getTime(), markedRow.effective_at.getTime());
    assert.equal(roles[0].purpose, 'resident-node');
    assert.equal((await admin.query(`select clued_private.binding_role_admits_v1(b,'ci-admission') ok
      from public.clued_agent_bindings b where b.id=$1`, [rotated.result.binding_id])).rows[0].ok, false);
    // The old token keeps working for the one-hour grace period; then the sweep revokes it.
    const retirement = (await admin.query(`select r.retire_at,r.replaced_by,b.revoked_at from clued_private.binding_retirements_v1 r
      join public.clued_agent_bindings b on b.id=r.binding_id where r.binding_id=$1`, [legacyId])).rows[0];
    const grace = (retirement.retire_at.getTime() - Date.now()) / 60000;
    assert.ok(grace > 59 && grace <= 60, String(grace));
    assert.equal(retirement.replaced_by, rotated.result.binding_id);
    assert.equal(retirement.revoked_at, null);
    assert.equal((await resolve(legacyToken, 'context:read', 'global')).rows[0].id, legacyId);
    assert.equal((await admin.query('select clued_private.binding_expiry_sweep_v1() n')).rows[0].n, 0, 'not due yet');
    await admin.query("update clued_private.binding_retirements_v1 set retire_at=now()-interval '1 second' where binding_id=$1", [legacyId]);
    assert.equal((await admin.query('select clued_private.binding_expiry_sweep_v1() n')).rows[0].n, 1);
    await assert.rejects(() => resolve(legacyToken, 'context:read', 'global'), /binding_not_authorized/);
    // A replaced or expired Binding cannot be replaced again.
    assert.equal(await step1Error({ label: 'again', days: 7, selected: readGlobal, replaces_binding_id: legacyId }),
      'headless_binding_replace_target_invalid');

    // A rotation confirmed against a Binding that changed in between is stale.
    const sourceState = (await native('clued_authorization_manage_v12', { op: 'list' })).bindings.find((row) => row.binding_id === result.binding_id);
    pending = await native('clued_headless_binding_confirmation_issue_v1',
      { label: 'stale', days: 7, selected: [], replaces_binding_id: result.binding_id, selection_format: 'sources_v1',
        sources: sourceState.sources.map((s) => ({ source_id: s.source_id, base_version: s.version, action_cap: s.actions })),
        exceptions: sourceState.overrides.map((o) => ({ override_id: o.override_id, base_version: o.version })) });
    await native('clued_authorization_manage_v12', { op: 'revoke', binding_id: result.binding_id, base_version: 2 });
    refused = await native('clued_headless_binding_issue_v1',
      { confirmation_token: pending.confirmation_token, view_digest: pending.view_digest });
    assert.equal(refused.error_code, 'headless_binding_replace_target_invalid');
    assert.equal((await admin.query('select consume_outcome from clued_private.native_confirmation_tokens where id=$1',
      [pending.token_id])).rows[0].consume_outcome, 'rejected');
    await assert.rejects(() => resolve(tokenHash, 'context:read', 'global'), /binding_not_authorized/);

    // --- Expiry: the resolvers refuse at once; the sweep revokes for every other path. ---
    const rotatedHash = sha256(rotated.result.token);
    await admin.query("update clued_private.authorizations_v12 set expires_at=now()-interval '1 second' where binding_id=$1",
      [rotated.result.binding_id]);
    await assert.rejects(() => resolve(rotatedHash, 'context:read', 'global'), /authorization_revoked_or_expired/);
    const swept = (await admin.query('select clued_private.binding_expiry_sweep_v1() n')).rows[0].n;
    assert.equal(swept, 1);
    const revoked = (await admin.query(`select b.id,b.revoked_at is not null b_revoked,a.revoked_at is not null a_revoked
      from public.clued_agent_bindings b left join clued_private.authorizations_v12 a on a.binding_id=b.id
      where b.id = any($1) order by b.id`, [[legacyId, rotated.result.binding_id]])).rows;
    assert.deepEqual(revoked.map((r) => r.b_revoked), [true, true]);
    assert.equal(revoked.find((r) => r.id === rotated.result.binding_id).a_revoked, true);
    assert.equal((await admin.query('select clued_private.binding_expiry_sweep_v1() n')).rows[0].n, 0);
    // OAuth Bindings and legacy Bindings never replaced are not swept.
    const untouchedHash = hex();
    const untouched = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'Other','untouched',$2,array['context:read'],array['*']) returning id`, [userId, untouchedHash])).rows[0].id;
    const oauthLike = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'OAuth','expired oauth',$2,array['context:read'],array['global']) returning id`, [userId, hex()])).rows[0].id;
    const issuer = hex();
    await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,'https://clued.test/mcp','t')", [issuer]);
    const requestId = (await admin.query(`insert into clued_private.authorization_requests_v12(owner_id,issuer_hash,request_digest,client_id,client_name,
      redirect_uri,resource,requested_scopes,eligible,status) values($1,$2,$3,'c','c','https://x','https://clued.test/mcp',array['context:read'],'[]','approved')
      returning id`, [userId, issuer, hex()])).rows[0].id;
    await admin.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
      values($1,$2,$3,'c','c','https://clued.test/mcp',now()-interval '1 day')`, [oauthLike, requestId, userId]);
    assert.equal((await admin.query('select clued_private.binding_expiry_sweep_v1() n')).rows[0].n, 0);
    assert.deepEqual((await admin.query('select revoked_at from public.clued_agent_bindings where id = any($1)',
      [[untouched, oauthLike]])).rows.map((r) => r.revoked_at), [null, null]);
    listed = await native('clued_headless_binding_list_v1', {});
    assert.deepEqual(listed.bindings.map((b) => b.binding_id), [untouched]);

    // --- A legacy Binding is revoked from the connections page; its roles stay locked (re-review 4, M1). ---
    const revokeLegacy = (input, claims) => native('clued_headless_binding_revoke_v1', input, claims);
    await assert.rejects(() => revokeLegacy({ binding_id: untouched }, { ...fresh(userId), client_id: 'some-oauth-client' }),
      /direct_human_session_required/);
    for (const input of [{}, { binding_id: 'nope' }, { binding_id: untouched, extra: 1 }, { binding_id: 7 }]) {
      await assert.rejects(() => revokeLegacy(input), /headless_binding_input_invalid/, JSON.stringify(input));
    }
    // Only the Owner's own, live, legacy Bindings: OAuth and headless ones go through manage_v12.
    await assert.rejects(() => revokeLegacy({ binding_id: untouched }, fresh(otherUser)), /headless_binding_revoke_target_invalid/);
    await assert.rejects(() => revokeLegacy({ binding_id: oauthLike }), /headless_binding_revoke_target_invalid/);
    await assert.rejects(() => revokeLegacy({ binding_id: rotated.result.binding_id }), /headless_binding_revoke_target_invalid/);
    await assert.rejects(() => revokeLegacy({ binding_id: legacyId }), /headless_binding_revoke_target_invalid/);
    const untouchedRole = await native('clued_binding_role_confirmation_issue_v1',
      { binding_id: untouched, role: 'ci-admission', enabled: true, purpose: 'other' });
    assert.equal((await native('clued_binding_role_set_v1',
      { confirmation_token: untouchedRole.confirmation_token, view_digest: untouchedRole.view_digest })).status, 'committed');
    assert.equal((await resolve(untouchedHash, 'context:read', 'global')).rows[0].id, untouched);
    const legacyRevoked = await revokeLegacy({ binding_id: untouched });
    assert.equal(legacyRevoked.status, 'committed', JSON.stringify(legacyRevoked));
    assert.deepEqual(legacyRevoked.roles_kept, ['ci-admission']);
    assert.equal(legacyRevoked.roles_ended, undefined);
    await assert.rejects(() => resolve(untouchedHash, 'context:read', 'global'), /binding_not_authorized/);
    // The role row stays, so the role stays locked: no other Binding of the
    // Owner is admitted for it until the Owner marks a live one or ends it.
    assert.equal((await admin.query(`select count(*)::int n from clued_private.binding_roles_v1
      where binding_id=$1 and revoked_at is null`, [untouched])).rows[0].n, 1);
    assert.equal((await admin.query(`select clued_private.binding_role_admits_v1(b,'ci-admission') ok
      from public.clued_agent_bindings b where b.id=$1`, [oauthLike])).rows[0].ok, false);
    const legacyReceipt = (await admin.query('select * from public.clued_audit_receipts where id=$1', [legacyRevoked.receipt_id])).rows[0];
    assert.equal(legacyReceipt.metadata.receipt_kind, 'LEGACY_BINDING_REVOKED');
    assert.equal(legacyReceipt.metadata.binding_id, untouched);
    assert.deepEqual(legacyReceipt.metadata.roles_kept, ['ci-admission']);
    assert.equal(legacyReceipt.metadata.principal, 'native_account_session');
    assert.equal((await admin.query(`select count(*)::int n from clued_private.authorization_audit_v12
      where binding_id=$1 and operation='legacy_revoke'`, [untouched])).rows[0].n, 1);
    await assert.rejects(() => revokeLegacy({ binding_id: untouched }), /headless_binding_revoke_target_invalid/);
    assert.deepEqual((await native('clued_headless_binding_list_v1', {})).bindings, []);

    // --- Limit: at most 50 live headless Bindings per Owner. ---
    for (let i = 0; i < 50; i++) {
      const id = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'Headless',$2,$3,array['context:read'],array['global']) returning id`, [userId, `bulk ${i}`, hex()])).rows[0].id;
      await admin.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
        values($1,null,$2,'clued-headless','bulk','clued:headless',now()+interval '1 day','headless')`, [id, userId]);
    }
    assert.equal(await step1Error({ label: 'one too many', days: 7, selected: readGlobal }), 'headless_binding_limit_reached');

    // --- The table keeps OAuth authorizations tied to their request. ---
    await assert.rejects(() => admin.query(`insert into clued_private.authorizations_v12
      (binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
      values($1,null,$2,'c','c','https://x',now()+interval '1 day')`, [untouched, userId]), /authorizations_v12_issuance_request/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
