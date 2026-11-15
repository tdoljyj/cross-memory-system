import { stopCluster, waitForPidExit } from './cluster-cleanup.mjs';
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

// Invariants of who holds ci-admission, on the database every migration builds (the required migration-verify check runs
// this file on every migration change):
// 1. Whether a Binding's role is in force is read in one place, clued_private.binding_role_in_force_v1 (migration
//    20261113100000). A role row that has not started yet (a hand change's delay) is not in force anywhere.
//    ci-admission-handover-db.test.mjs holds the list of functions that may read binding_roles_v1 and checks that only
//    that reader compares a start with the clock.
// 2. A handover of ci-admission lands only on a node fit to take it over (migration 20261114120000): heard lately, its
//    latest report NORMAL, running the Source the fleet runs. Every handover (the Owner's one-click handover, the failover
//    watchdog) goes through the handover core's check, and so does marking it by hand; the watchdog alerts instead of
//    handing over to an unfit node.
// 3. A planned handover leaves automatic takeover working (migration 20261115100000): after the Owner hands the role
//    from B to A, B takes over when A falls silent; only an automatic handover keeps its node out (no hand-back).
// 4. ... and only until it has proven itself steady again (migration 20261115120000): a node handed out automatically
//    that is then heard without a silence and healthy for rejoin_steady_minutes takes the role back when the holder falls
//    silent; one that keeps dropping out or reporting its service down stays out (no ping-pong).
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const jwk = () => ({ kty: 'EC', crv: 'P-256', x: crypto.randomBytes(32).toString('base64url'), y: crypto.randomBytes(32).toString('base64url') });

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

// One embedded PostgreSQL with every migration, in file-name order, as production's chain applies them.
async function withDatabase(prefix, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  const connect = async (role) => {
    const c = server.getPgClient(); clients.push(c); await c.connect();
    if (role) await c.query(`set role ${role}`);
    return c;
  };
  try {
    await server.initialise(); await server.start();
    const admin = await connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (e) { throw new Error(`Migration ${name}: ${e.message}`, { cause: e }); }
    }
    await allowRawTestBindings(admin);
    await body({ admin, connect });
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    const ownPid = server.process?.pid;
    await stopCluster(server);
    assert.equal(await waitForPidExit(ownPid), true, 'this fixture must stop its own PostgreSQL child');
  }
}

test('a role row that has not started is in force for neither PR door', { timeout: 300000 }, async t => {
  await withDatabase('clued-role-reader-', async ({ admin, connect }) => {
    const user = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'role-reader@example.invalid',now())", [user]);
    const token = hash();
    const ci = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','ci',$2,array['context:read'],array['*']) returning id`, [user, token])).rows[0].id;
    const receipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [user, ci])).rows[0].id;
    // What a hand change leaves: the new holder's row, starting an hour from now.
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
      values($1,$2,'ci-admission',now(),$3,now()+interval '1 hour','resident-node')`, [user, ci, receipt]);
    const anon = await connect('anon');
    const resolve = async () => (await anon.query('select public.clued_work_verify_v1($1::text,$2::jsonb) v', [token,
      { action: 'resolve_pr_claim', scope: 'global', pr_ref: 'fixture/role-reader#1', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
        target_branch: 'main', read_only: false }])).rows[0].v;
    const proofError = async () => (await admin.query(`select clued_private.work_claim_mechanical_proof_error_v1(b,$2::jsonb) e
      from public.clued_agent_bindings b where b.id=$1`, [ci, { mechanical_policy: {} }])).rows[0].e;
    const judged = async () => (await admin.query(`select clued_private.binding_role_in_force_v1($1,$2,'ci-admission') in_force,
      clued_private.ci_duty_admits_v1($1,$2,'issuer_role') issuer`, [user, ci])).rows[0];

    // Runs in the required migration-verify check (scripts/ci/ci-required-selection.mjs) on every migration change:
    // a later migration whose function judges a role row's start itself fails there.
    await t.test('after every migration, only binding_role_in_force_v1 compares a role row\'s start with the clock', async () => {
      const judges = (await admin.query(`select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','clued_private') and p.prosrc ~ 'binding_roles_v1'
          and p.prosrc ~ 'effective_at\\s*<=\\s*clock_timestamp\\(\\)' order by 1`)).rows.map((r) => r.sig);
      assert.deepEqual(judges, ['clued_private.binding_role_in_force_v1(uuid,uuid,text)']);
    });

    await t.test('before the row starts: not in force, PR discovery may not write, the mechanical proof gate refuses', async () => {
      assert.deepEqual(await judged(), { in_force: false, issuer: false });
      const pending = await resolve();
      assert.equal(pending.binding_status, 'unbound', JSON.stringify(pending));
      assert.equal(pending.reason, 'pr_task_binding_unbound', 'a CI Binding that is not in force only reads');
      assert.equal(await proofError(), 'ci_binding_required');
    });

    await t.test('once the row starts: in force, PR discovery writes, the proof gate goes on to the policy', async () => {
      await admin.query("update clued_private.binding_roles_v1 set effective_at=now() where binding_id=$1 and revoked_at is null", [ci]);
      assert.deepEqual(await judged(), { in_force: true, issuer: true });
      const started = await resolve();
      assert.equal(started.reason, 'head_authorization_required', JSON.stringify(started));
      assert.notEqual(await proofError(), 'ci_binding_required');
    });
  });
});

// 2026-11-12: the Owner's one-click handover gave ci-admission to a node five Source generations behind and CI stood still.
test('a ci-admission handover lands only on a node fit to take over; the watchdog alerts instead', { timeout: 300000 }, async t => {
  await withDatabase('clued-handover-target-', async ({ admin, connect }) => {
    const anon = await connect('anon');
    const human = await connect('authenticated');
    const ACCEPTED = hash(), BEHIND = hash();
    // One isolated account: a project, one connection with a stage-1 node row per name, the first one holding ci-admission.
    const account = async (label, names) => {
      const user = uuid(), project = uuid();
      await admin.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${label}@example.invalid`]);
      await admin.query('begin');
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)
        values($1,$2,$3,$3,$4,2,true)`, [project, user, 'handover-' + project, 'project:' + project]);
      await admin.query(`insert into clued_private.project_lifecycle_v2_dispositions(project_id,user_id,disposition,disposition_reason,
        recognition_confidence,recognition_source,basis,disposition_hash)
        values($1,$2,'recognized_project','Synthetic isolated database fixture',1,'v2_explicit_create','{}',$3)`, [project, user, hash()]);
      await admin.query('commit');
      const ids = {}, tokens = {};
      for (const name of names) {
        tokens[name] = hash();
        ids[name] = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
          values($1,'synthetic',$2,$3,array['context:read'],array['*']) returning id`, [user, name, tokens[name]])).rows[0].id;
        await admin.query(`insert into clued_private.ci_nodes_v1(user_id,project_id,binding_id,name,profile,profile_sha256,
          identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,registration_digest,idempotency_key)
          values($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
        [user, project, ids[name], name.toUpperCase(), hash(), jwk(), jwk(), hash(), hash(), hash(), uuid()]);
      }
      const receipt = async () => (await admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,null,'global','fixture','fixture','fixture',1,'{}'::jsonb) returning id`, [user])).rows[0].id;
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'ci-admission',now()-interval '1 day',$3,now()-interval '1 day','resident-node')`, [user, ids[names[0]], await receipt()]);
      // The node's own heartbeat through the CI command door (what the companion sends every minute).
      const beat = async (who, over = {}) => {
        const input = { scope: 'global', action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'STANDBY', probe: 'not-held',
          ci_source_manifest_sha256: ACCEPTED, service_running: true, snapshot_age_seconds: 5, ...over };
        for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
        const v = (await anon.query('select public.clued_work_verify_v1($1,$2) v', [tokens[who], input])).rows[0].v;
        assert.equal(v.status, 'ok', who + ' ' + JSON.stringify(v));
      };
      const session = uuid();
      await admin.query("insert into auth.sessions(id,user_id,not_after) values($1,$2,clock_timestamp()+interval '1 hour')", [session, user]);
      const owner = async (name, data) => {
        await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user,
          JSON.stringify({ sub: user, role: 'authenticated', session_id: session, aal: 'aal1', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
        return (await human.query(`select public.${name}($1::jsonb) v`, [data])).rows[0].v;
      };
      // The Owner's one-click handover, both steps: the refusal of whichever step refuses, or the committed result.
      const handover = async (from, to) => {
        const issued = await owner('clued_binding_role_handover_confirmation_issue_v1', { from_binding_id: ids[from], to_binding_id: ids[to] });
        if (issued.status !== 'issued') return issued;
        return owner('clued_binding_role_handover_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest });
      };
      const holders = async () => (await admin.query(`select b.agent_name from clued_private.binding_roles_v1 r
        join public.clued_agent_bindings b on b.id=r.binding_id where r.user_id=$1 and r.role='ci-admission' and r.revoked_at is null
        order by 1`, [user])).rows.map(r => r.agent_name);
      // Time passes for this node: every time on its liveness row moves back, as if those heartbeats had arrived earlier.
      const ago = async (who, minutes) => {
        const times = (await admin.query(`select column_name c from information_schema.columns where table_schema='clued_private'
          and table_name='ci_node_liveness_v1' and data_type='timestamp with time zone' order by ordinal_position`)).rows.map(r => r.c);
        await admin.query(`update clued_private.ci_node_liveness_v1 l set ${times.map(c => `${c}=l.${c}-make_interval(mins=>$2)`).join(',')}
          from clued_private.ci_nodes_v1 n where n.node_id=l.node_id and n.binding_id=$1`, [ids[who], minutes]);
      };
      // Marking ci-admission by hand (binding_role_set, both Native steps): the refusal of whichever step refuses, or the result.
      const mark = async (who, purpose) => {
        const issued = await owner('clued_binding_role_confirmation_issue_v1', { binding_id: ids[who], role: 'ci-admission', enabled: true, purpose });
        if (issued.status !== 'issued') return issued;
        return owner('clued_binding_role_set_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest });
      };
      return { user, ids, beat, handover, mark, holders, ago, receipt };
    };

    const fleet = await account('fit-fleet', ['turing', 'desk', 'spare', 'blank', 'silent']);
    await fleet.beat('turing', { mode: 'ACTIVE', probe: 'held' });
    await fleet.beat('desk', { ci_source_manifest_sha256: BEHIND });
    await fleet.beat('spare');

    await t.test('a node behind the Source the fleet runs is refused, with its reason; nothing moves', async () => {
      const refused = await fleet.handover('turing', 'desk');
      assert.deepEqual([refused.status, refused.error_code], ['rejected', 'ci_admission_target_source_not_accepted'], JSON.stringify(refused));
      assert.deepEqual(await fleet.holders(), ['turing']);
    });

    await t.test('halted, paused, intake-paused (also a node whose two sides disagree), unknown, sourceless and unheard nodes are refused', async () => {
      const cases = [
        [{ state: 'HALTED', halt: { code: 'FIXTURE_HALT', at: new Date().toISOString(), pr: null, headSha: null } }, 'ci_admission_target_halted'],
        [{ state: 'PAUSED' }, 'ci_admission_target_paused'],
        [{ state: 'INTAKE_PAUSED', intake_paused_until: new Date(Date.now() + 3_600_000).toISOString() }, 'ci_admission_target_intake_paused'],
        [{ state: 'UNKNOWN', mode: undefined, probe: undefined }, 'ci_admission_target_state_unknown'],
      ];
      for (const [report, code] of cases) {
        await fleet.beat('spare', report);
        const refused = await fleet.handover('turing', 'spare');
        assert.deepEqual([refused.status, refused.error_code], ['rejected', code], JSON.stringify({ report, refused }));
      }
      // A node keeps the last Source it reported (ci_node_heartbeat_v1); one that never reported any is refused.
      await fleet.beat('blank', { ci_source_manifest_sha256: null });
      assert.equal((await fleet.handover('turing', 'blank')).error_code, 'ci_admission_target_source_unknown');
      assert.equal((await fleet.handover('turing', 'silent')).error_code, 'ci_admission_target_not_heard', 'a node that never reported');
      await fleet.beat('spare');
      await fleet.ago('spare', 6);
      assert.equal((await fleet.handover('turing', 'spare')).error_code, 'ci_admission_target_not_heard', 'a node not heard for 6 minutes');
      assert.deepEqual(await fleet.holders(), ['turing']);
    });

    await t.test('a fit node takes over as before, once every node heard within 24 hours runs its Source', async () => {
      await fleet.beat('spare');
      // While another node heard within 24 hours runs another Source the train would not run on the new holder either.
      assert.equal((await fleet.handover('turing', 'spare')).error_code, 'ci_admission_target_source_not_accepted');
      await fleet.beat('desk'); // desk upgraded to the Source the fleet runs
      await fleet.beat('blank');
      const moved = await fleet.handover('turing', 'spare');
      assert.equal(moved.status, 'committed', JSON.stringify(moved));
      assert.deepEqual(await fleet.holders(), ['spare']);
    });

    await t.test('no way around it: with the holder role ended, marking a node behind by hand is refused the same way', async () => {
      const m = await account('fit-mark', ['former', 'behind', 'fit']);
      await m.beat('former', { mode: 'ACTIVE', probe: 'held' });
      await m.beat('behind', { ci_source_manifest_sha256: BEHIND });
      await m.beat('fit');
      await admin.query(`update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2
        where binding_id=$1 and revoked_at is null`, [m.ids.former, await m.receipt()]);
      for (const purpose of ['resident-node', 'other']) {
        const refused = await m.mark('behind', purpose);
        assert.deepEqual([refused.status, refused.error_code], ['rejected', 'ci_admission_target_source_not_accepted'], JSON.stringify({ purpose, refused }));
      }
      await m.beat('behind', { state: 'PAUSED' }); // upgraded since, but paused
      assert.equal((await m.mark('behind', 'resident-node')).error_code, 'ci_admission_target_paused');
      assert.deepEqual(await m.holders(), []);
      const marked = await m.mark('fit', 'resident-node');
      assert.equal(marked.status, 'committed', JSON.stringify(marked));
      assert.deepEqual(await m.holders(), ['fit']);
    });

    await t.test('the watchdog: no fit node, no handover and an alert; the core refuses an unfit node whoever asks', async () => {
      const wd = await account('fit-watchdog', ['holder', 'behind']);
      await wd.beat('holder', { mode: 'ACTIVE', probe: 'held' });
      const anchor = await wd.receipt();
      await admin.query(`insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)
        values($1,true,now()-interval '1 hour',1,now()-interval '1 hour',$2)`, [wd.user, anchor]);
      await admin.query(`insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id)
        values($1,$2,1,now()-interval '1 hour',$4),($1,$3,2,now()-interval '1 hour',$4)`, [wd.user, wd.ids.holder, wd.ids.behind, anchor]);
      await wd.ago('holder', 10); // the holder fell silent 10 minutes ago
      await wd.beat('behind', { ci_source_manifest_sha256: BEHIND });
      await wd.beat('behind', { ci_source_manifest_sha256: BEHIND });
      const outcome = (await admin.query('select clued_private.ci_admission_failover_owner_v1($1) v', [wd.user])).rows[0].v;
      assert.equal(outcome.outcome, 'no_target', JSON.stringify(outcome));
      assert.ok(outcome.alert_receipt_id, 'the Owner is alerted');
      assert.ok(outcome.candidates[0].reasons.includes('source_differs_from_holder'), JSON.stringify(outcome.candidates));
      assert.deepEqual(await wd.holders(), ['holder']);
      // The watchdog's own call of the handover core, for an unfit node: refused there too.
      await assert.rejects(() => admin.query(`select clued_private.binding_role_handover_core_v1($1,$2,$3,null,
        '{"receipt_kind":"CI_ADMISSION_AUTO_HANDOVER","principal":"server_watchdog","start":"quiet_holder"}'::jsonb)`,
      [wd.user, wd.ids.holder, wd.ids.behind]), /ci_admission_target_source_not_accepted/);
      assert.deepEqual(await wd.holders(), ['holder']);
    });

    // 2026-11-15: after two planned handovers TURING -> DESK -> TURING both nodes were in a 6-hour cooldown, so nobody
    // would have taken over from a silent holder.
    await t.test('after a planned handover B -> A, B takes over when A falls silent; an automatic handover is not handed back', async () => {
      const p = await account('planned-then-silent', ['b', 'a']); // b holds
      const anchor = await p.receipt();
      await admin.query(`insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)
        values($1,true,now()-interval '1 hour',1,now()-interval '1 hour',$2)`, [p.user, anchor]);
      await admin.query(`insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id)
        values($1,$2,1,now()-interval '1 hour',$4),($1,$3,2,now()-interval '1 hour',$4)`, [p.user, p.ids.a, p.ids.b, anchor]);
      const tick = async () => (await admin.query('select clued_private.ci_admission_failover_owner_v1($1) v', [p.user])).rows[0].v;
      const reasonsOf = (o, who) => o.candidates.find((c) => c.binding_id === p.ids[who]).reasons;
      await p.beat('b', { mode: 'ACTIVE', probe: 'held' });
      await p.beat('a');
      const planned = await p.handover('b', 'a');
      assert.equal(planned.status, 'committed', JSON.stringify(planned));
      assert.deepEqual(await p.holders(), ['a']);
      // A holds and falls silent past silence_minutes; B, healthy on the same Source, is heard twice meanwhile.
      await p.beat('a', { mode: 'ACTIVE', probe: 'held' });
      await p.beat('b');
      await p.ago('a', 10);
      await p.beat('b'); await p.beat('b');
      let o = await tick();
      assert.deepEqual([o.outcome, reasonsOf(o, 'b')], ['handed_over', []], JSON.stringify(o));
      assert.deepEqual(await p.holders(), ['b']);
      // B falls silent in turn: A, handed out automatically, is not taken back; nothing but an alert.
      await p.beat('b', { mode: 'ACTIVE', probe: 'held' });
      await p.beat('a');
      await p.ago('b', 10);
      await p.beat('a'); await p.beat('a');
      o = await tick();
      assert.deepEqual([o.outcome, reasonsOf(o, 'a')], ['no_target', ['auto_handed_out']], JSON.stringify(o));
      assert.deepEqual(await p.holders(), ['b']);
    });

    // 2026-11-15 (production): TURING lost its network, the watchdog handed the role to DESK, TURING was back and fit
    // 8 minutes later, and stayed 'auto_handed_out' with no time bound: had DESK gone silent, nobody would have taken over.
    const handedOut = async (label) => {
      const f = await account(label, ['a', 'b']); // a holds, b stands by
      const anchor = await f.receipt();
      await admin.query(`insert into clued_private.ci_failover_settings_v1(user_id,enabled,enabled_at,version,updated_at,receipt_id)
        values($1,true,now()-interval '1 day',1,now()-interval '1 day',$2)`, [f.user, anchor]);
      await admin.query(`insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id)
        values($1,$2,1,now()-interval '1 day',$4),($1,$3,2,now()-interval '1 day',$4)`, [f.user, f.ids.a, f.ids.b, anchor]);
      const tick = async () => (await admin.query('select clued_private.ci_admission_failover_owner_v1($1) v', [f.user])).rows[0].v;
      const reasonsOf = (o, who) => o.candidates.find((c) => c.binding_id === f.ids[who]).reasons;
      // A falls silent past silence_minutes; B, heard twice meanwhile, takes over.
      await f.beat('a', { mode: 'ACTIVE', probe: 'held' });
      await f.beat('b');
      await f.ago('a', 10);
      await f.beat('b'); await f.beat('b');
      const o = await tick();
      assert.deepEqual([o.outcome, reasonsOf(o, 'b')], ['handed_over', []], JSON.stringify(o));
      assert.deepEqual(await f.holders(), ['b']);
      // Later B, the holder, falls silent; A is heard twice meanwhile; the watchdog decides.
      const holderSilent = async () => {
        await f.beat('b', { mode: 'ACTIVE', probe: 'held' });
        await f.ago('b', 10);
        await f.beat('a'); await f.beat('a');
        return tick();
      };
      return { ...f, tick, reasonsOf, holderSilent };
    };

    await t.test('a node handed out automatically, back and steadily healthy for 30 minutes, takes the role back when the holder falls silent', async () => {
      const f = await handedOut('rejoin-steady');
      // A is back: heard every 4 minutes (under silence_minutes) for 32 minutes, service running, snapshot fresh.
      for (let i = 0; i < 8; i++) { await f.beat('a'); await f.ago('a', 4); }
      const o = await f.holderSilent();
      assert.deepEqual([o.outcome, f.reasonsOf(o, 'a')], ['handed_over', []], JSON.stringify(o));
      assert.deepEqual(await f.holders(), ['a']);
    });

    await t.test('a node handed out automatically that keeps dropping out or reporting its service down stays out (no ping-pong)', async () => {
      const f = await handedOut('rejoin-flapping');
      // A flaps: back for a moment, then silent for 6 minutes (over silence_minutes), for 36 minutes.
      for (let i = 0; i < 6; i++) { await f.beat('a'); await f.ago('a', 6); }
      let o = await f.holderSilent();
      assert.deepEqual([o.outcome, f.reasonsOf(o, 'a')], ['no_target', ['auto_handed_out']], JSON.stringify(o));
      assert.deepEqual(await f.holders(), ['b']);
      // A heard every 4 minutes for 32 minutes, but once in the middle reporting its service not running.
      for (let i = 0; i < 8; i++) { await f.beat('a', i === 3 ? { service_running: false } : {}); await f.ago('a', 4); }
      o = await f.holderSilent();
      assert.deepEqual([o.outcome, f.reasonsOf(o, 'a')], ['no_target', ['auto_handed_out']], JSON.stringify(o));
      assert.deepEqual(await f.holders(), ['b']);
    });
  });
});
