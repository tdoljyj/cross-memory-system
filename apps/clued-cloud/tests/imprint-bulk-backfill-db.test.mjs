import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
test('bounded Native first batch: preview, eligibility fences, durable receipts and safe undo', { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-imprint-bulk-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: uuid(), port: await port(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator nologin noinherit; create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    let previousClassifierBody, previousPreviewDefinition;
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      try {
        const successor = name === '20261017142000_imprint_classifier_scan_v1.sql';
        const identity = async () => (await admin.query(`select oid::text,pg_get_userbyid(proowner) owner,
          prosecdef,provolatile,proparallel,proconfig,proacl::text from pg_proc
          where oid='clued_private.imprint_auto_domains_v1(text)'::regprocedure`)).rows[0];
        const before = successor ? await identity() : null;
        if (successor) previousClassifierBody = (await admin.query("select prosrc from pg_proc where oid='clued_private.imprint_auto_domains_v1(text)'::regprocedure")).rows[0].prosrc;
        const previewSuccessor = name === '20261117060000_imprint_bulk_preview_scope_cache_v1.sql';
        const previewIdentity = async () => (await admin.query(`select oid::text,pg_get_userbyid(proowner) owner,
          prosecdef,provolatile,proparallel,proconfig,proacl::text from pg_proc
          where oid='clued_private.imprint_bulk_preview_v1(uuid,jsonb,integer,boolean)'::regprocedure`)).rows[0];
        const previewBefore = previewSuccessor ? await previewIdentity() : null;
        if (previewSuccessor) previousPreviewDefinition = (await admin.query(`select pg_get_functiondef(
          'clued_private.imprint_bulk_preview_v1(uuid,jsonb,integer,boolean)'::regprocedure) definition`)).rows[0].definition;
        await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
        if (successor) assert.deepEqual(await identity(), before, 'performance successor preserves function identity and privileges');
        if (previewSuccessor) assert.deepEqual(await previewIdentity(), previewBefore, 'preview cache preserves function identity and privileges');
      }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    assert.equal(typeof previousPreviewDefinition, 'string');
    await admin.query(previousPreviewDefinition.replace('clued_private.imprint_bulk_preview_v1(', 'clued_private.imprint_bulk_preview_baseline_test_v1('));
    await admin.query(`revoke all on function clued_private.imprint_bulk_preview_baseline_test_v1(uuid,jsonb,integer,boolean)
      from public,anon,authenticated,service_role`);
    async function comparePreview(user, selection = { scope: 'all' }) {
      for (const classify of [false, true]) for (const cursor of [0, 1, 2]) {
        const value = (await admin.query(`select clued_private.imprint_bulk_preview_v1($1,$2,$3,$4) actual,
          clued_private.imprint_bulk_preview_page_v1($1,$2,$3,$4,1) scheduled,
          clued_private.imprint_bulk_preview_baseline_test_v1($1,$2,$3,$4) previous`, [user, selection, cursor, classify])).rows[0];
        assert.deepEqual(value.actual, value.previous, JSON.stringify({ selection, cursor, classify }));
        assert.deepEqual(value.scheduled, value.previous, JSON.stringify({ selection, cursor, classify, scheduler: true }));
      }
    }
    const owner = uuid(), other = uuid(), project = uuid();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'bulk@example.invalid',now()),($2,'bulk-other@example.invalid',now())", [owner, other]);
    async function actor(id = owner, extras = {}) {
      const db = server.getPgClient(); clients.push(db); await db.connect(); await db.query('set role authenticated');
      await db.query("set statement_timeout='30s'; set lock_timeout='10s'");
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [id, JSON.stringify({ sub: id, role: 'authenticated', session_id: 'bulk-isolated', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }], ...extras })]); return db;
    }
    const human = await actor(), stranger = await actor(other), concurrent = await actor();
    const call = async (name, input, client = human, writing = false) => (await client.query(
      `select public.${name}(${input === undefined ? '' : writing ? '$1,$2' : '$1'}) v`, input === undefined ? [] : writing
        ? [JSON.stringify(input), hash(input)] : [JSON.stringify(input)])).rows[0].v;
    const previewPage = (input = {}, client = human) => call('clued_imprint_bulk_preview_v1', input, client);
    async function preview(input = {}, client = human) {
      let value, proof, cursor = 0, ready = 0, needs_review = 0, ready_characters = 0, review_characters = 0;
      const items = [], review_sample = [];
      do {
        value = await previewPage({ ...input, ...(proof ? { proof } : {}) }, client);
        assert.equal(value.page.cursor, cursor); cursor += value.page.scanned;
        ready += value.items.length; needs_review += value.review_sample.length;
        ready_characters += value.ready_characters; review_characters += value.review_characters;
        items.push(...value.items.slice(0, 100 - items.length)); review_sample.push(...value.review_sample.slice(0, 20 - review_sample.length));
        proof = value.proof;
      } while (!value.page.complete);
      return { ...value, complete: true, items, review_sample,
        counts: { ...value.inventory_counts, ready, needs_review, ready_characters, review_characters } };
    }
    const status = (client = human) => call('clued_imprint_bulk_status_v1', undefined, client);
    const mutate = async (input, client = human) => {
      if (input.action === 'begin' && !input.proof) {
        const proposal = await preview(input.selection, client); input = { ...input, proof: proposal.proof, items: proposal.items };
      }
      return call('clued_imprint_bulk_mutate_v1', { idempotency_key: uuid(), ...input }, client, true);
    };
    const org = (id, version, base = 0, domains = [], client = human) => call('clued_imprint_organization_set_v1',
      { record_id: id, record_version: version, base_version: base, domains, idempotency_key: uuid() }, client, true);
    const projectInput = { operation: 'create', project_schema_version: 2, canonical_project_id: project, idempotency_key: uuid(),
      mutation: { name: 'Synthetic bulk project', progress_status: 'active' } };
    assert.equal((await call('clued_user_project_mutate_v2', projectInput, human, true)).status, 'committed');
    async function legacy(content = '用途：我的学习', scope = 'global', client = human, id = uuid()) {
      const base = { id, record_type: 'note', record_schema_version: 1, lifecycle_status: 'active', scope,
        authority: 'user_explicit', user_confirmed: true, confidence_reason: 'Isolated synthetic bulk fixture' };
      const created = await call('clued_user_record_mutate', { ...base, operation: 'create', idempotency_key: uuid(),
        source_refs: [], source_unavailable_reason: 'Isolated synthetic source',
        mutation: { title: 'Synthetic old imprint', content: '未整理的旧内容', type_fields: { note_kind: 'log' } } }, client, true);
      assert.equal(created.status, 'committed', JSON.stringify(created));
      const updated = await call('clued_user_record_mutate', { ...base, operation: 'update', base_version: 1, idempotency_key: uuid(),
        mutation: { content } }, client, true);
      assert.equal(updated.status, 'committed', JSON.stringify(updated)); return id;
    }
    const eligible = await legacy(), manualEmpty = await legacy(), manual = await legacy(), uncertain = await legacy('可能以后学习？');
    const projectRecord = await legacy('用途：我的工作', 'project:' + project);
    const foreign = await legacy('用途：我的学习', 'global', stranger);
    assert.equal((await org(manualEmpty, 2)).status, 'committed');
    assert.equal((await org(manual, 2, 0, ['daily'])).status, 'committed');
    let plan;
    await t.test('preview is complete, read-only, disjoint and protects manual empty choices', async () => {
      const before = (await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n;
      plan = await preview();
      for (const scope of ['all', 'global', 'project:' + project]) await comparePreview(owner, { scope });
      assert.equal(plan.complete, true); assert.equal(plan.authoritative, false);
      assert.equal(plan.counts.total, 5); assert.equal(plan.counts.ready, 2); assert.equal(plan.counts.protected, 2);
      assert.equal(plan.counts.needs_review, 1); assert.equal(plan.items.length, 2);
      assert.ok(plan.items.every(row => row.record_id !== foreign && row.record_id !== uncertain));
      assert.equal((await admin.query('select count(*) n from public.clued_audit_receipts')).rows[0].n, before);
      assert.equal((await status()).available, false);
      await assert.rejects(human.query('select * from clued_private.imprint_bulk_batches_v1'), /permission denied/);
      const oauth = await actor(owner, { client_id: 'not-a-native-session' });
      await assert.rejects(preview({}, oauth), /direct_human_session_required/);
      await assert.rejects(preview({ scope: 'project:' + uuid() }), /bulk_selection_invalid/);
    });
    let batch;
    await t.test('begin checks digest; one shared first batch survives replay and cannot be enlarged', async () => {
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: '0'.repeat(64) })).error_code, 'bulk_preview_incomplete');
      const input = { action: 'begin', selection: {}, digest: plan.digest, proof: plan.proof, items: plan.items, idempotency_key: uuid() };
      const first = await mutate(input); assert.equal(first.status, 'committed', JSON.stringify(first));
      batch = first.supplemental.batch;
      const replay = await mutate(input); assert.equal(replay.receipt_id, first.receipt_id); assert.equal(replay.replayed, true);
      assert.equal(batch.items.length, 2); assert.ok(batch.items.every(row => row.state === 'pending'));
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: plan.digest })).error_code, 'bulk_first_batch_already_exists');
      assert.equal((await status(stranger)).available, false);
      assert.equal((await mutate({ action: 'advance', batch_id: batch.batch_id, base_version: 1 }, stranger)).error_code, 'bulk_batch_unavailable');
    });
    await t.test('each item rechecks live project qualification even without changing its record version', async () => {
      // Only the project lifecycle changes; the source Record version stays 2.
      await admin.query("update public.clued_projects set progress_status='archived' where id=$1", [project]);
      while (batch.state === 'running') {
        const key = uuid(), input = { action: 'advance', batch_id: batch.batch_id, base_version: batch.version, idempotency_key: key };
        const result = await mutate(input); assert.equal(result.status, 'committed', JSON.stringify(result));
        const replay = await mutate(input); assert.equal(replay.receipt_id, result.receipt_id);
        batch = (await status());
      }
      assert.equal(batch.items.find(row => row.record_id === projectRecord).state, 'conflict');
      assert.equal(batch.items.find(row => row.record_id === eligible).state, 'applied');
      assert.ok(uuidTest(batch.items.find(row => row.record_id === eligible).receipt_id));
      assert.equal((await admin.query('select count(*) n from clued_private.imprint_organization_v1 where record_id=$1', [projectRecord])).rows[0].n, '0');
      assert.equal((await admin.query('select version from public.clued_memories where id=$1', [eligible])).rows[0].version, '2');
      assert.equal((await mutate({ action: 'advance', batch_id: batch.batch_id, base_version: 1 })).error_code, 'bulk_version_conflict');
    });
    await t.test('Undo refuses later manual edits and cancel never resets the allowance', async () => {
      assert.equal((await org(eligible, 2, 1, ['interest'])).status, 'committed');
      const undone = await mutate({ action: 'undo', batch_id: batch.batch_id, base_version: batch.version });
      assert.equal(undone.status, 'committed'); batch = undone.supplemental.batch;
      assert.equal(batch.items.find(row => row.record_id === eligible).state, 'undo_conflict');
      assert.deepEqual((await admin.query('select domains from clued_private.imprint_organization_v1 where record_id=$1', [eligible])).rows[0].domains, ['interest']);
      const cancelled = await mutate({ action: 'cancel', batch_id: batch.batch_id, base_version: batch.version });
      assert.equal(cancelled.status, 'committed');
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: (await preview()).digest })).error_code, 'bulk_first_batch_already_exists');
    });
    await t.test('empty rehearsal is explicit and cannot begin a fabricated batch', async () => {
      // Foreign owner has one ready row; explicitly protect it first.
      await org(foreign, 2, 0, [], stranger);
      const empty = await preview({}, stranger); assert.equal(empty.items.length, 0); assert.equal(empty.counts.protected, 1);
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: empty.digest }, stranger)).error_code, 'bulk_items_invalid');
    });
    await t.test('100 distinct identities maximum and safe resumable cancellation/Undo use real receipts', async () => {
      const capOwner = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'bulk-cap@example.invalid',now())", [capOwner]);
      const cap = await actor(capOwner), capSecond = await actor(capOwner);
      for (let i = 0; i < 105; i++) await legacy('用途：我的学习', 'global', cap);
      const full = await preview({}, cap); assert.equal(full.counts.ready, 105); assert.equal(full.items.length, 100);
      let saved = (await mutate({ action: 'begin', selection: {}, digest: full.digest }, cap)).supplemental.batch;
      assert.equal(new Set(saved.items.map(row => row.record_id)).size, 100);
      const input = { action: 'advance', batch_id: saved.batch_id, base_version: saved.version };
      const race = await Promise.all([mutate(input, cap), mutate(input, capSecond)]);
      assert.equal(race.filter(r => r.status === 'committed').length, 1);
      saved = await status(cap); assert.equal(saved.items.filter(row => row.state === 'applied').length, 1);
      const stopped = await mutate({ action: 'cancel', batch_id: saved.batch_id, base_version: saved.version }, cap);
      saved = stopped.supplemental.batch;
      assert.equal((await mutate({ action: 'advance', batch_id: saved.batch_id, base_version: saved.version }, cap)).error_code, 'bulk_not_running');
      const undone = await mutate({ action: 'undo', batch_id: saved.batch_id, base_version: saved.version }, cap);
      assert.equal(undone.status, 'committed'); saved = undone.supplemental.batch;
      const item = saved.items.find(row => row.state === 'undone'); assert.ok(item); assert.ok(uuidTest(item.undo_receipt_id));
      const organization = (await admin.query('select * from clued_private.imprint_organization_v1 where record_id=$1', [item.record_id])).rows[0];
      assert.deepEqual(organization.domains, []); assert.equal(organization.version, '2');
      assert.equal((await preview({}, cap)).counts.protected, 1, 'Undo leaves an explicit protected empty choice');
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: (await preview({}, cap)).digest }, cap)).error_code, 'bulk_first_batch_already_exists');
    });
    async function isolatedOwner(label) {
      const id = uuid(); await admin.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [id, label + '@example.invalid']);
      return { id, client: await actor(id) };
    }
    async function seed(user, extra = {}) {
      const id = uuid();
      await admin.query(`insert into public.clued_memories
        (id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,canonical_scope,
          type_fields,relations,source_refs,authority,confidence,confidence_reason,content_hash)
        values($1,$2,'Isolated synthetic legacy fixture','用途：我的学习','global',null,$3,$4,$5,$6,$7,$8,'{}','{}',$9,1,'Isolated fixture',$10)`,
        [id, user, extra.kind ?? 'task', extra.status ?? 'active', extra.schema === undefined ? 1 : extra.schema,
          extra.lifecycle === undefined ? 'active' : extra.lifecycle, extra.scope ?? 'global',
          extra.fields ?? { execution_bucket: 'later' }, extra.authority ?? 'user_explicit', hash('用途：我的学习')]);
      return id;
    }
    async function blocker(user) {
      const event = (await admin.query(`insert into public.clued_context_events(user_id,context_key,event_type,payload)
        values($1,'global','blocker','{"title":"Isolated synthetic currentness blocker"}') returning id`, [user])).rows[0].id;
      await admin.query(`insert into clued_private.event_truth_carriers
        (event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state,event_version)
        values($1,$2,'global',array['task'],'work_log','direct','ACTIVE_UNSTRUCTURED',1)`, [event, user]);
      return event;
    }
    await t.test('history/Profile/imported/external/unknown are counted but never planned, and Native-only ACLs hold', async () => {
      const isolated = await isolatedOwner('bulk-qualification');
      await seed(isolated.id);
      await seed(isolated.id, { lifecycle: 'archived', status: 'archived' });
      await seed(isolated.id, { kind: 'profile_fact', scope: 'profile', fields: { fact_kind: 'preference' } });
      await seed(isolated.id, { authority: 'imported' });
      await seed(isolated.id, { fields: { execution_bucket: 'later', source_kind: 'external_material' } });
      await seed(isolated.id, { fields: { execution_bucket: 'later', projection_key: 'unbound-bulk-projection' } });
      await seed(isolated.id, { schema: null, lifecycle: null });
      const result = await preview({}, isolated.client); assert.equal(result.counts.total, 7);
      assert.equal(result.counts.ineligible, 6); assert.equal(result.counts.ready, 1);
      await comparePreview(isolated.id);
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        for (const signature of ['public.clued_imprint_bulk_preview_v1(jsonb)', 'public.clued_imprint_bulk_status_v1()', 'public.clued_imprint_bulk_mutate_v1(jsonb,text)'])
          assert.equal((await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') v", [role, signature])).rows[0].v, role === 'authenticated');
        for (const table of ['imprint_bulk_batches_v1', 'imprint_bulk_items_v1'])
          assert.equal((await admin.query("select has_table_privilege($1,$2,'select,insert,update,delete') v", [role, 'clued_private.' + table])).rows[0].v, false);
      }
    });
    await t.test('active Event alone invalidates a frozen source before execution and before Undo', async () => {
      for (const undo of [false, true]) {
        const isolated = await isolatedOwner('bulk-event-' + undo), id = await seed(isolated.id);
        const before = await preview({}, isolated.client); assert.equal(before.counts.ready, 1);
        let saved = (await mutate({ action: 'begin', selection: {}, digest: before.digest }, isolated.client)).supplemental.batch;
        if (undo) saved = (await mutate({ action: 'advance', batch_id: saved.batch_id, base_version: saved.version }, isolated.client)).supplemental.batch;
        await blocker(isolated.id);
        await comparePreview(isolated.id);
        const result = await mutate({ action: undo ? 'undo' : 'advance', batch_id: saved.batch_id, base_version: saved.version }, isolated.client);
        assert.equal(result.status, 'committed');
        const item = result.supplemental.batch.items[0]; assert.equal(item.state, undo ? 'undo_conflict' : 'conflict');
        assert.equal(item.error_code, 'bulk_source_ineligible');
        assert.equal((await admin.query('select version from public.clued_memories where id=$1', [id])).rows[0].version, '1');
        assert.equal((await preview({}, isolated.client)).counts.ineligible, 1);
      }
    });
    await t.test('manual empty or source-version changes after preview/begin refuse a later batch write', async () => {
      for (const manualChange of [false, true]) {
        const isolated = await isolatedOwner('bulk-late-' + manualChange), id = await legacy('用途：我的学习', 'global', isolated.client);
        const before = await preview({}, isolated.client);
        const saved = (await mutate({ action: 'begin', selection: {}, digest: before.digest }, isolated.client)).supplemental.batch;
        if (manualChange) assert.equal((await org(id, 2, 0, [], isolated.client)).status, 'committed');
        else await admin.query('update public.clued_memories set version=version+1 where id=$1', [id]);
        const changed = await mutate({ action: 'advance', batch_id: saved.batch_id, base_version: saved.version }, isolated.client);
        assert.equal(changed.supplemental.batch.items[0].state, 'conflict');
        assert.equal(changed.supplemental.batch.items[0].error_code, manualChange ? 'organization_version_conflict' : 'record_version_conflict');
      }
    });
    await t.test('only a complete owner-bound signed read chain admits the exact first-100 proposal', async () => {
      const isolated = await isolatedOwner('bulk-proof');
      await legacy('用途：我的学习', 'global', isolated.client); await legacy('用途：我的工作', 'global', isolated.client);
      const first = await previewPage({}, isolated.client); assert.equal(first.page.scanned, 1); assert.equal(first.page.complete, false);
      const partial = { action: 'begin', selection: {}, digest: first.digest, proof: first.proof, items: first.items };
      assert.equal((await mutate(partial, isolated.client)).error_code, 'bulk_preview_incomplete');
      await assert.rejects(previewPage({ cursor: 2 }, isolated.client), /bulk_selection_invalid/);
      const forged = JSON.parse(JSON.stringify(first.proof)); forged.payload.cursor = 2;
      await assert.rejects(previewPage({ proof: forged }, isolated.client), /bulk_proof_invalid/);
      await assert.rejects(previewPage({ proof: first.proof }, stranger), /bulk_proof_invalid/);
      const last = await previewPage({ proof: first.proof }, isolated.client); assert.equal(last.page.cursor, 1); assert.equal(last.page.complete, true);
      assert.equal(last.proof.payload.expires_at, first.proof.payload.expires_at, 'no sliding proof expiry');
      const complete = await preview({}, isolated.client), wrong = complete.items.map(row => ({ ...row, domains: ['interest'] }));
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: complete.digest, proof: complete.proof, items: wrong }, isolated.client)).error_code, 'bulk_proposal_mismatch');
      assert.equal((await status(isolated.client)).available, false);
      await org(first.items[0].record_id, first.items[0].record_version, 0, [], isolated.client);
      await assert.rejects(previewPage({ proof: first.proof }, isolated.client), /bulk_preview_changed/);
      assert.equal((await mutate({ action: 'begin', selection: {}, digest: complete.digest, proof: complete.proof, items: complete.items }, isolated.client)).error_code, 'bulk_preview_changed');
      for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway']) {
        assert.equal((await admin.query("select has_table_privilege($1,'clued_private.imprint_bulk_proof_key_v1','select,insert,update,delete') v", [role])).rows[0].v, false);
        for (const signature of ['clued_private.imprint_bulk_seal_v1(jsonb)', 'clued_private.imprint_bulk_unseal_v1(uuid,jsonb)'])
          assert.equal((await admin.query("select has_function_privilege($1,$2::regprocedure,'execute') v", [role, signature])).rows[0].v, false);
      }
    });
    await t.test('opt-in bounded pages preserve the complete signed first-100 plan and yield on a slow classifier', async () => {
      const isolated = await isolatedOwner('bulk-bounded-pages');
      for (let i = 0; i < 35; i++) await legacy(i % 3 ? '用途：我的学习' : '可能学习？', 'global', isolated.client);
      const baseline = await preview({}, isolated.client);
      for (const page_size of [0, 17, '16', null, 2.5])
        await assert.rejects(previewPage({ page_size }, isolated.client), /bulk_selection_invalid/);
      const original = (await admin.query(`select pg_get_functiondef('clued_private.imprint_bulk_domains_v1(text)'::regprocedure) definition`)).rows[0].definition;
      let first;
      try {
        // Disposable test-only delay: verify yielding before another expensive
        // classifier without changing the accepted source or request timeout.
        await admin.query(`create or replace function clued_private.imprint_bulk_domains_v1(p_content text)
          returns text[] language plpgsql immutable parallel safe set search_path='' as $slow_test$
          begin perform pg_sleep(0.25); return clued_private.imprint_auto_domains_v1(p_content); end $slow_test$`);
        await isolated.client.query("set statement_timeout='8s'");
        first = await previewPage({ page_size: 16 }, isolated.client);
        assert.ok(first.page.scanned > 0 && first.page.scanned < 16, 'slow pages yield with real progress');
      } finally { await admin.query(original); }
      const ids = new Set(), planned = [];
      let value = first, cursor = 0, ready = 0, review = 0;
      const expiry = first.proof.payload.expires_at;
      for (;;) {
        assert.equal(value.page.cursor, cursor);
        assert.ok(value.page.scanned >= 1 && value.page.scanned <= 16);
        for (const row of [...value.items, ...value.review_sample]) {
          assert.equal(ids.has(row.record_id), false); ids.add(row.record_id);
          assert.equal(Object.hasOwn(row, 'content'), false, 'private scan bodies never leave the helper');
        }
        planned.push(...value.items.map(({ title, ...row }) => row));
        cursor += value.page.scanned; ready += value.items.length; review += value.review_sample.length;
        assert.equal(value.proof.payload.cursor, cursor); assert.equal(value.proof.payload.ready, ready);
        assert.equal(value.proof.payload.needs_review, review); assert.equal(value.proof.payload.expires_at, expiry);
        assert.equal(value.digest, baseline.digest);
        if (value.page.complete) { assert.equal(value.page.next_cursor, null); break; }
        assert.equal(value.page.next_cursor, cursor);
        value = await previewPage({ proof: value.proof, page_size: 16 }, isolated.client);
      }
      assert.equal(cursor, 35); assert.equal(ids.size, 35);
      assert.equal(ready, baseline.counts.ready); assert.equal(review, baseline.counts.needs_review);
      assert.deepEqual(planned, baseline.items.map(({ title, ...row }) => row));
      assert.deepEqual(value.proof.payload.items, planned);
      assert.equal((await status(isolated.client)).available, false, 'complete preview saves no batch or labels');
      for (const name of ['imprint_bulk_preview_inventory_v1', 'imprint_bulk_preview_page_v1']) {
        const signature = 'clued_private.' + name + '(uuid,jsonb,integer,boolean,integer)';
        assert.equal((await admin.query('select provolatile from pg_proc where oid=$1::regprocedure', [signature])).rows[0].provolatile,
          name === 'imprint_bulk_preview_inventory_v1' ? 's' : 'v', 'timing must not alter the stable inventory snapshot contract');
        for (const role of ['authenticated', 'anon', 'service_role', 'clued_worker_gateway'])
          assert.equal((await admin.query('select has_function_privilege($1,$2::regprocedure,\'execute\') v', [role, signature])).rows[0].v, false);
      }
    });
    await t.test('cached classification preserves prior outputs for quotes, fences, uncertain lines and all existing rule forms', async () => {
      assert.equal(typeof previousClassifierBody, 'string');
      await admin.query(`create function clued_private.imprint_previous_classifier_test_v1(p_content text)
        returns text[] language plpgsql immutable parallel safe set search_path='' as $previous$${previousClassifierBody}$previous$`);
      const bodies = ['用途：工作交付、我的学习、家庭预算、创作、兴趣爱好。', '客户Logo方案。', '给客户设计Logo。',
        '我正在复习线性代数，用这本教材。', '我今天整理家庭预算。', '继续写小说第二章。', '安排周末徒步路线。',
        'Purpose: personal budget, creative writing and hobbies.', 'I am studying linear algebra.',
        '客户Logo设计教程。', '客户要求我设计Logo。', '如果保存用途：学习英语。', '用途：不用来学习英语。',
        '用途：我的工作\n“引文”', '客户请求：\n用途：我的工作\n\n用途：家庭预算。',
        '~~~text\n用途：我的工作\n~~~\n用途：我的学习', '````\n```\n用途：我的工作\n```\n````',
        '原文：\n用途：我的工作\n> 朋友说：\n用途：我的学习', 'a。；!?\n用途：我的学习'];
      const inputs = new Set(bodies);
      for (const text of bodies) for (const prefix of ['> ', '原文：\n', '客户说：', '```\n', '`', '可能', '如果']) inputs.add(prefix + text);
      for (const text of bodies) for (const quote of ['"', "'", '“', '”', '‘', '’', '「', '」', '『', '』']) inputs.add(text + quote);
      const ordinary = ['用途：我的学习', '用途：我的工作', '原文：', '客户请求：', '客户说：', '可能学习', '> 用途：我的学习', '用', '学'];
      for (const first of ordinary) for (const second of ordinary) {
        inputs.add([first, second, '', first, second].join('\n'));
        inputs.add([first, '```', second, '```', first, '', second].join('\n'));
      }
      const overCache = Array.from({ length: 132 }, (_, i) => `普通独立行${i}`).join('\n');
      for (const suffix of ['用途：我的学习\n用途：我的学习', '原文：\n用途：我的学习\n\n原文：\n用途：我的工作',
        '用途：我的学习\n“引用”', '```\n“引用”\n```\n用途：我的学习']) inputs.add(overCache + '\n' + suffix);
      for (const text of inputs) {
        const value = (await admin.query(`select clued_private.imprint_auto_domains_v1($1) actual,
          clued_private.imprint_previous_classifier_test_v1($1) previous`, [text])).rows[0];
        assert.deepEqual(value.actual, value.previous, text.slice(0, 100));
      }
      assert.deepEqual((await admin.query("select clued_private.imprint_auto_domains_v1($1) v", ['用途：我的学习'])).rows[0].v, ['learning']);
      console.log('CLASSIFIER_EQUIVALENCE', inputs.size, 'synthetic sources; same rule catalog and sorted domains');
    });
    await t.test('negative guard conservatively falls back for flags, backreferences, prefixes and invalid unused rules', async () => {
      const original = (await admin.query("select prosrc from pg_proc where oid='clued_private.imprint_auto_rules_v1()'::regprocedure")).rows[0].prosrc;
      const catalog = (await admin.query('select clued_private.imprint_auto_rules_v1() v')).rows[0].v;
      const install = async body => admin.query(`create or replace function clued_private.imprint_auto_rules_v1()
        returns jsonb language sql immutable parallel safe set search_path='' as $guard_test$${body}$guard_test$`);
      const setPattern = async pattern => {
        const modified = structuredClone(catalog); modified.activities = [{ domain: 'learning', patterns: [pattern] }];
        await install("select '" + JSON.stringify(modified).replaceAll("'", "''") + "'::jsonb");
      };
      try {
        for (const [pattern, text] of [['(?i)^XYZ$', 'XYZ'], ['^(ab)\\1$', 'abab'], ['***:^zebra$', 'zebra']]) {
          await setPattern(pattern);
          const value = (await admin.query(`select clued_private.imprint_auto_domains_v1($1) actual,
            clued_private.imprint_previous_classifier_test_v1($1) previous`, [text])).rows[0];
          assert.deepEqual(value.actual, ['learning']); assert.deepEqual(value.actual, value.previous);
        }
        await setPattern('[');
        // The original context guard never reaches this invalid activity rule.
        for (const name of ['imprint_auto_domains_v1', 'imprint_previous_classifier_test_v1']) {
          assert.deepEqual((await admin.query(`select clued_private.${name}($1) v`, ['不是我的承诺'])).rows[0].v, []);
          assert.deepEqual((await admin.query(`select clued_private.${name}($1) v`, ['“引文”'])).rows[0].v, []);
          await assert.rejects(admin.query(`select clued_private.${name}($1)`, ['ordinary']), error => error.code === '2201B');
        }
      } finally { await install(original); }
      assert.deepEqual((await admin.query('select clued_private.imprint_auto_rules_v1() v')).rows[0].v, catalog);
    });
    await t.test('maximum shared-classifier input and legal8000-character Native records fit the real8s budget', async () => {
      const isolated = await isolatedOwner('bulk-real-scale');
      const body = '普通存量记录。'.repeat(200);
      const target = '00000000-0000-4000-8000-000000000001';
      await legacy(body, 'global', isolated.client, target);
      await admin.query(`insert into public.clued_memories
        (id,user_id,title,content,scope,record_type,status,record_schema_version,lifecycle_status,canonical_scope,
          type_fields,relations,source_refs,authority,confidence,confidence_reason,content_hash)
        select extensions.gen_random_uuid(),$1,'Synthetic scale record',$2,'global','task','active',1,'active','global',
          '{"execution_bucket":"later"}'::jsonb,'{}'::jsonb,'{}'::uuid[],'user_explicit',1,'Isolated synthetic fixture',
          encode(extensions.digest(convert_to($2,'UTF8'),'sha256'),'hex') from generate_series(1,1799) sample`, [isolated.id, body]);
      const shapes = [
        ['quoted-long-line', 'x'.repeat(60000) + ' “用途：我的学习”', []],
        ['dense-CJK-sentences', '普通旧记录。'.repeat(9000), []],
        ['many-short-sentences', 'a。'.repeat(32000), []],
        ['ready-long-source', '用途：我的学习\n' + '普通旧记录。'.repeat(9000), ['learning']],
        ['quote-in-code-does-not-abstain', '用途：我的学习\n```\n' + '“原文”'.repeat(12000) + '\n```', ['learning']],
        ['repeated-short-lines', '用\n'.repeat(32768), []],
        ['alternating-short-lines', '用\n学\n'.repeat(16384), []],
        ['purpose-and-short-lines', '用途：我的学习\n' + '用\n学\n'.repeat(16382), ['learning']],
      ];
      await admin.query("set statement_timeout='8s'");
      for (const [label, text, expected] of shapes) {
        assert.ok([...text].length <= 65536);
        const start = performance.now();
        assert.deepEqual((await admin.query('select clued_private.imprint_auto_domains_v1($1) v', [text])).rows[0].v, expected);
        console.log('CLASSIFIER_MAX_INPUT', JSON.stringify({ label, characters: [...text].length, elapsed_ms: Math.round(performance.now() - start) }));
      }
      await admin.query("set statement_timeout='30s'");
      const nativeShapes = [
        ['quoted-long-line', 'x'.repeat(7900) + ' “用途：我的学习”', []],
        ['dense-CJK-sentences', '普通旧记录。'.repeat(1300), []],
        ['many-short-sentences', 'a。'.repeat(3950), []],
        ['ready-long-source', '用途：我的学习\n' + '普通旧记录。'.repeat(1300), ['learning']],
        ['quote-in-code-does-not-abstain', '用途：我的学习\n```\n' + '“原文”'.repeat(1900) + '\n```', ['learning']],
        ['repeated-short-lines', '用\n'.repeat(4000), []],
        ['alternating-short-lines', '用\n学\n'.repeat(2000), []],
        ['purpose-and-short-lines', '用途：我的学习\n' + '用\n学\n'.repeat(1998), ['learning']],
        ['over-cache-capacity', Array.from({ length: 132 }, (_, i) => `普通独立行${i}\n`).join('') + '用\n学\n'.repeat(1500), []],
        ['FIFO-all-misses-129', Array.from({ length: 4000 }, (_, i) => String.fromCodePoint(0x4e00 + i % 129) + '\n').join(''), []],
        ['purpose-and-FIFO-all-misses-129', '用途：我的学习\n' + Array.from({ length: 3996 }, (_, i) => String.fromCodePoint(0x4e00 + i % 129) + '\n').join(''), ['learning']],
      ];
      await isolated.client.query("set statement_timeout='8s'");
      for (const [label, text, expected] of nativeShapes) {
        assert.ok([...text].length <= 8000);
        await admin.query('update public.clued_memories set content=$2,content_hash=$3 where id=$1', [target, text, hash(text)]);
        const start = performance.now();
        const first = await previewPage({}, isolated.client);
        assert.equal(first.inventory_counts.total, 1800); assert.equal(first.inventory_counts.classifiable, 1800);
        assert.equal(first.page.scanned, 1); assert.equal(first.page.complete, false);
        assert.deepEqual(first.items[0]?.domains ?? [], expected);
        console.log('NATIVE_LARGE_INVENTORY', JSON.stringify({ label, records: 1800, characters: [...text].length,
          page_ms: Math.round(performance.now() - start), ready: first.proof.payload.ready, review: first.proof.payload.needs_review }));
        const next = await previewPage({ proof: first.proof }, isolated.client);
        assert.equal(next.page.cursor, 1); assert.equal(next.page.scanned, 1);
      }
      await admin.query(`insert into public.clued_memories
        (id,user_id,title,content,scope,record_type,status,record_schema_version,lifecycle_status,canonical_scope,
          type_fields,relations,source_refs,authority,confidence,confidence_reason,content_hash)
        select extensions.gen_random_uuid(),$1,'Synthetic scale record',$2,'global','task','active',1,'active','global',
          '{"execution_bucket":"later"}'::jsonb,'{}'::jsonb,'{}'::uuid[],'user_explicit',1,'Isolated synthetic fixture',
          encode(extensions.digest(convert_to($2,'UTF8'),'sha256'),'hex') from generate_series(1,2200)`, [isolated.id, body]);
      for (const [label, text, expected] of nativeShapes.slice(-6)) {
        assert.ok([...text].length <= 8000);
        // Target stays an actual Native-created/updated current legacy Record;
        // only its test body changes, with no organization or saved batch.
        await admin.query('update public.clued_memories set content=$2,content_hash=$3 where id=$1', [target, text, hash(text)]);
        const start = performance.now(), first = await previewPage({}, isolated.client);
        assert.equal(first.inventory_counts.total, 4000); assert.equal(first.inventory_counts.classifiable, 4000);
        assert.equal(first.page.scanned, 1); assert.deepEqual(first.items[0]?.domains ?? [], expected);
        const next = await previewPage({ proof: first.proof }, isolated.client);
        assert.equal(next.page.cursor, 1); assert.equal(next.page.scanned, 1);
        console.log('NATIVE_SHORT_LINES_4000', JSON.stringify({ label, characters: [...text].length,
          two_pages_ms: Math.round(performance.now() - start) }));
        const boundedStart = performance.now(), bounded = await previewPage({ page_size: 16 }, isolated.client);
        assert.ok(bounded.page.scanned >= 1 && bounded.page.scanned <= 16);
        assert.equal(bounded.inventory_counts.total, 4000);
        assert.deepEqual(bounded.items[0]?.domains ?? [], expected);
        assert.equal(bounded.proof.payload.cursor, bounded.page.scanned);
        console.log('NATIVE_BOUNDED_PAGE_4000', JSON.stringify({ label, scanned: bounded.page.scanned,
          page_ms: Math.round(performance.now() - boundedStart) }));
      }
      assert.equal((await status(isolated.client)).available, false, 'large rehearsal has zero saved batches or label writes');
    });
    await t.test('one-source rehearsal and metadata-only begin stay within the real Native statement budget for long bodies', async () => {
      const isolated = await isolatedOwner('bulk-performance');
      const bodies = [('普通旧记录。'.repeat(1300)).slice(0, 7928), '。；!? \n'.repeat(1100).slice(0, 7900), 'a。'.repeat(3950),
        '用途：我的学习\n' + '。'.repeat(7980)];
      for (const body of bodies) await legacy(body, 'global', isolated.client);
      await isolated.client.query("set statement_timeout='8s'");
      let proof, pages = 0;
      do {
        const value = await previewPage(proof ? { proof } : {}, isolated.client);
        assert.equal(value.page.scanned, 1); proof = value.proof; pages++;
        if (value.page.complete) break;
      } while (pages < bodies.length + 1);
      assert.equal(pages, 4); assert.equal(proof.payload.cursor, 4); assert.equal(proof.payload.ready, 1);
      assert.equal(proof.payload.needs_review, 3);
      // This is an exact algorithm-preservation check, not a second classifier:
      // removing the one empty-segment guard restores the prior shared body.
      const prior = await fs.readFile(path.join(root, 'supabase/migrations/20261016124233_imprint_auto_domains_v1.sql'), 'utf8');
      const oldBody = /create function clued_private\.imprint_auto_domains_v1[\s\S]*?as \$\$([\s\S]*?)end \$\$;/.exec(prior)[1] + 'end ';
      const currentBody = previousClassifierBody;
      const normalize = value => value.replaceAll('\r\n', '\n');
      assert.equal(normalize(currentBody).replace("      if segment='' then continue; end if;\n", ''), normalize(oldBody));
    });
    await t.test('ordinary same-child Native idempotency takes priority without reversing source lock order', async () => {
      const isolated = await isolatedOwner('bulk-lock'), a = isolated.client, b = await actor(isolated.id);
      const id = await legacy('用途：我的学习', 'global', a), proposal = await preview({}, a);
      const saved = (await mutate({ action: 'begin', selection: {}, digest: proposal.digest }, a)).supplemental.batch;
      const key = 'bulk:' + saved.batch_id + ':' + id + ':advance';
      const payload = { record_id: id, record_version: 2, base_version: 0, domains: ['learning'], idempotency_key: key };
      const pid = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
      await a.query('begin');
      try {
        await a.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [isolated.id + ':imprint_organization:' + key]);
        const pending = mutate({ action: 'advance', batch_id: saved.batch_id, base_version: saved.version }, b);
        let wait;
        for (let i = 0; i < 100; i++) {
          wait = (await admin.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1', [pid])).rows[0];
          if (wait?.wait_event_type === 'Lock' && wait.wait_event === 'advisory') break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(wait?.wait_event, 'advisory');
        const direct = await call('clued_imprint_organization_set_v1', payload, a, true);
        assert.equal(direct.status, 'committed'); await a.query('commit');
        const result = await pending; assert.equal(result.status, 'committed');
        assert.equal(result.supplemental.batch.items[0].state, 'conflict');
        assert.equal(result.supplemental.batch.items[0].error_code, 'organization_version_conflict');
      } finally { await a.query('rollback'); }
    });
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    await stopCluster(server); await removeTestDirectory(directory);
  }
});
function uuidTest(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value); }
