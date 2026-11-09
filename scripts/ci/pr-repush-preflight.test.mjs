import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRepush, createDefaultPorts, main, parseArgs, readPrMetadata } from './pr-repush-preflight.mjs';

const CURRENT = 'd6a771bf-400d-498f-a043-e9e3ac605f8b';
const OLD = '796078d6-6785-43b4-ac48-45c4d1ed14b0';
const TASK = '257d262e-7afc-4055-85b7-299e0b2129b4';
const AUTH = ['232821de', '6886', '47ae', 'a27d', 'bef315823fef'].join('-');
const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const HEAD = '378da6e1bfba2a46cb62203766d1827b4b86974f';
const REMOTE_HEAD = '2'.repeat(40), BASE = 'b'.repeat(40);
const ARGV = ['--repo', 'o/r', '--pr', '992', '--head', HEAD];
const env = { CLUED_CONTEXT_READ_TOKEN: 'synthetic-read-binding-token', CLUED_SUPABASE_URL: 'https://native.fixture.invalid',
  CLUED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', GITHUB_REPOSITORY: 'unrelated/environment' };
const metadata = () => ({ number: 992, state: 'open', head: { sha: REMOTE_HEAD },
  base: { sha: BASE, ref: 'main', repo: { full_name: 'o/r' } } });
const binding = (extra = {}) => ({
  status: 'ok', binding_status: 'bound', reason: null, repository: 'o/r', pr_number: 992, pr_ref: 'o/r#992',
  head_sha: HEAD, base_sha: BASE, target_branch: 'main', scope: SCOPE, task_id: TASK,
  claim: { claim_id: CURRENT, task_id: TASK, context_key: SCOPE, fence: 4, execution_epoch: 3,
    lease_version: 2, expires_at: '2099-01-01T00:00:00Z', status: 'ACTIVE', execution_handover_pending: false },
  head_authorization_id: AUTH, auto_bound: false, receipt_id: null, ...extra,
});
const capture = () => ({ text: '', write(t) { this.text += t; } });
function fixture({ pr = metadata(), reply = binding(), fetchError, metadataError, transportEnv = env } = {}) {
  const calls = [];
  return { calls, ports: { env: transportEnv, workspace: 'not-read-fixture',
    async readPrMetadata(repo, number) { calls.push({ kind: 'github', repo, number }); if (metadataError) throw metadataError; return pr; },
    async fetchImpl(url, init) { calls.push({ kind: 'native', url, input: JSON.parse(init.body).p_input });
      if (fetchError) throw fetchError;
      return { status: 200, text: async () => JSON.stringify(reply), headers: { get() { return null; } } }; },
    readPrBody() { throw new Error('retired body authority was read'); },
    readCommitMessage() { throw new Error('retired commit authority was read'); },
  } };
}
async function run(argv = ARGV, options) {
  const f = fixture(options), out = capture(), err = capture();
  return { code: await main(argv, f.ports, out, err), out: out.text, err: err.text, calls: f.calls };
}

test('write-set mode derives the complete real PR union with only read calls', async () => {
  const f=fixture({pr:{...metadata(),base:{...metadata().base,repo:{full_name:'O/R'}},changed_files:2}}), out=capture(),err=capture();
  const current={...binding().claim,write_set:['src/**','other/pr.py','execution/active.py']};
  f.ports.readPrFilesPage=async (repo,number,page)=>{
    f.calls.push({kind:'github-files',repo,number,page});
    return [{filename:'src/new.py',previous_filename:'src/old.py',status:'renamed'},
      {filename:'config/clued-components.json',status:'modified'}];
  };
  const fetch=f.ports.fetchImpl;
  f.ports.fetchImpl=async (url,init)=>{
    const input=JSON.parse(init.body).p_input;
    if(input.action)return fetch(url,init);
    f.calls.push({kind:'native-read',input});
    return {status:200,text:async()=>JSON.stringify({status:'ok',verdict:'ADMITTED',claim:current}),headers:{get(){return null;}}};
  };
  const code=await main([...ARGV,'--write-set'],f.ports,out,err);
  assert.equal(code,0,err.text);
  const plan=JSON.parse(out.text.split('\n').find(line=>line.startsWith('WRITE_SET_PLAN: ')).slice('WRITE_SET_PLAN: '.length));
  assert.deepEqual(plan.write_set,['config/clued-components.json','execution/active.py','other/pr.py','src/**']);
  assert.deepEqual(plan.changed_paths,['config/clued-components.json','src/new.py','src/old.py']);
  assert.equal(plan.head_sha,REMOTE_HEAD);assert.equal(plan.planned_head_sha,HEAD);
  assert.equal(plan.read_only,true);assert.equal(plan.requires_renewal,true);
  assert.equal(Object.hasOwn(plan,'lease_key'),false);
  assert.ok(f.calls.every(c=>!c.input?.lease_key&&!c.input?.progress_ref));
  assert.equal(f.calls.filter(c=>c.kind==='native-read').length,1);
});

test('write-set mode rejects a stale current Native generation and never guesses resources',async()=>{
  const f=fixture({pr:{...metadata(),changed_files:1}}),out=capture(),err=capture();
  f.ports.readPrFilesPage=async()=>[{filename:'source/file.py',status:'modified'}];
  const fetch=f.ports.fetchImpl;
  f.ports.fetchImpl=async(url,init)=>JSON.parse(init.body).p_input.action?fetch(url,init):
    {status:200,text:async()=>JSON.stringify({status:'ok',verdict:'ADMITTED',claim:{...binding().claim,fence:99,write_set:['**']}}),headers:{get(){return null;}}};
  assert.equal(await main([...ARGV,'--write-set'],f.ports,out,err),2);
  assert.doesNotMatch(out.text,/WRITE_SET_PLAN:/);
});

test('Native binding passes without prose, reads exact metadata and planned head through the shared readonly resolver', async () => {
  const r = await run();
  assert.equal(r.code, 0); assert.equal(r.err, '');
  assert.match(r.out, /BOUND: 绑定检查通过/); assert.match(r.out, /not execution admission/);
  assert.deepEqual(r.calls[0], { kind: 'github', repo: 'o/r', number: 992 });
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[1].url, /\/rest\/v1\/rpc\/clued_work_verify_v1$/);
  assert.deepEqual(r.calls[1].input, { action: 'resolve_pr_claim', pr_ref: 'o/r#992', head_sha: HEAD,
    base_sha: BASE, target_branch: 'main', read_only: true });
  assert.notEqual(HEAD, REMOTE_HEAD, 'planned push head intentionally differs from the current remote PR head');
  assert.doesNotMatch(r.out + r.err, /synthetic-read-binding-token|sb_publishable_fixture/);
});

test('contradictory PR/body/commit trailers and deprecated body flag cannot change Native identity', async () => {
  const pr = { ...metadata(), body: 'Clued-Work-Claim: ' + OLD + '\nClued-Work-Scope: global',
    commitMessage: 'Clued-Work-Claim: ' + OLD };
  const r = await run([...ARGV, '--body-governs'], { pr });
  assert.equal(r.code, 0); assert.match(r.out, /DEPRECATED/);
  assert.match(r.out, new RegExp(CURRENT)); assert.doesNotMatch(r.out, new RegExp(OLD));
});

test('--claim is optional diagnostic; a changed current claim passes and never requests prose edits', async () => {
  const r = await run([...ARGV, '--claim', OLD]);
  assert.equal(r.code, 0); assert.match(r.out, /CLAIM_CHANGED/); assert.match(r.out, /PR prose needs no change/);
  assert.match(r.out, new RegExp(CURRENT));
});

test('omitted scope is Native-derived while an explicit scope is checked exactly', async () => {
  assert.equal((await run([...ARGV, '--scope', SCOPE])).code, 0);
  const explicit = await run([...ARGV, '--scope', 'global']);
  assert.equal(explicit.code, 2); assert.match(explicit.err, /UNCONFIRMED/);
  assert.equal(explicit.calls[1].input.scope, 'global');
  const nativeScopeConflict = await run([...ARGV, '--scope', 'global'], { reply: binding({
    binding_status: 'conflict', reason: 'scope_not_served', scope: 'global', task_id: null, claim: null, head_authorization_id: null }) });
  assert.equal(nativeScopeConflict.code, 1);
});

test('unbound and unknown lifecycle return discovery pending without blocking the normal first-push discovery flow', async () => {
  const replies = [
    binding({ binding_status: 'unbound', reason: 'pr_task_binding_unbound', scope: null, task_id: null, claim: null, head_authorization_id: null }),
    binding({ binding_status: 'no_live_claim', reason: 'pr_task_binding_unknown', claim: null, head_authorization_id: null }),
    binding({ binding_status: 'no_live_claim', reason: 'pr_task_binding_closed', claim: null, head_authorization_id: null }),
  ];
  for (const reply of replies) {
    const r = await run(ARGV, { reply });
    assert.equal(r.code, 3); assert.match(r.out, /DISCOVERY_PENDING/); assert.match(r.out, /normal push\/create/);
    assert.match(r.out, /not activate a relation or edit PR prose/); assert.doesNotMatch(r.out, /BOUND:/);
    assert.equal(r.calls[1].input.read_only, true);
  }
});

test('head authorization and handover waits are exit 3; current Task/claim conflicts are exit 1', async () => {
  for (const reply of [
    binding({ binding_status: 'head_not_authorized', reason: 'head_authorization_required', head_authorization_id: null }),
    binding({ binding_status: 'handover_pending', reason: 'work_claim_handover_pending', head_authorization_id: null,
      claim: { ...binding().claim, execution_handover_pending: true } }),
  ]) assert.equal((await run(ARGV, { reply })).code, 3);
  for (const reply of [
    binding({ binding_status: 'conflict', reason: 'pr_task_binding_ambiguous', task_id: null, claim: null, head_authorization_id: null }),
    binding({ binding_status: 'no_live_claim', reason: 'task_not_current', claim: null, head_authorization_id: null }),
    binding({ binding_status: 'no_live_claim', reason: 'claim_not_current', claim: null, head_authorization_id: null }),
  ]) assert.equal((await run(ARGV, { reply })).code, 1);
});

test('missing authorized transport is unconfirmed exit 2, with no GitHub or Native read', async () => {
  const r = await run(ARGV, { transportEnv: {} });
  assert.equal(r.code, 2); assert.match(r.err, /UNCONFIRMED/); assert.deepEqual(r.calls, []);
  const out = capture(), err = capture();
  const ports = createDefaultPorts({ env: {}, run() { throw new Error('must not read Host credentials or GitHub'); } });
  assert.equal(await main(ARGV, ports, out, err), 2);
});

test('Native repository, PR, head, base, target, scope and generation mismatches all fail closed', async () => {
  for (const extra of [
    { repository: 'other/repo' }, { pr_number: 993 }, { pr_ref: 'o/r#993' }, { head_sha: REMOTE_HEAD },
    { base_sha: 'c'.repeat(40) }, { target_branch: 'other' }, { scope: 'global' },
    { claim: { ...binding().claim, execution_epoch: 0 } }, { claim: { ...binding().claim, context_key: 'global' } },
    { auto_bound: true, receipt_id: AUTH },
  ]) {
    const r = await run([...ARGV, '--scope', SCOPE], { reply: binding(extra) });
    assert.equal(r.code, 2, JSON.stringify(extra)); assert.match(r.err, /UNCONFIRMED/); assert.doesNotMatch(r.out, /BOUND:/);
  }
});

test('metadata is exact and actual base/target assertions are optional; closed PR does not reopen', async () => {
  assert.equal((await run([...ARGV, '--base', BASE, '--target', 'main'])).code, 0);
  assert.equal((await run([...ARGV, '--base', 'c'.repeat(40)])).code, 1);
  assert.equal((await run([...ARGV, '--target', 'release'])).code, 1);
  for (const pr of [
    { ...metadata(), number: 993 }, { ...metadata(), base: { ...metadata().base, repo: { full_name: 'other/repo' } } },
    { ...metadata(), base: { ...metadata().base, sha: 'short' } }, { ...metadata(), head: { sha: 'short' } },
    { ...metadata(), base: { ...metadata().base, ref: 'main\ninjected' } }, { ...metadata(), state: 'unknown' },
  ]) assert.equal((await run(ARGV, { pr })).code, 2);
  const closed = await run(ARGV, { pr: { ...metadata(), state: 'closed' } });
  assert.equal(closed.code, 1); assert.equal(closed.calls.length, 1);
});

test('parameters reject duplicates, unknowns, shell fragments and invalid identifiers without defaulting scope', () => {
  assert.equal(parseArgs(ARGV).args.scope, undefined); assert.equal(parseArgs(ARGV).args.claim, undefined);
  assert.equal(parseArgs(['--repo', 'Owner/.github', '--pr', '1', '--head', HEAD]).args.repo, 'owner/.github');
  const replace = (from, to) => ARGV.map(v => v === from ? to : v);
  for (const argv of [
    [], [...ARGV, '--head', HEAD], [...ARGV, '--scope'], [...ARGV, '--claim', OLD.toUpperCase()],
    [...ARGV, '--scope', 'project:x'], [...ARGV, '--scope', SCOPE.toUpperCase()],
    [...ARGV, '--body-governs', '--body-governs'], [...ARGV, '--unknown', 'secret'],
    [...ARGV, '--target', 'main; echo private'], [...ARGV, '--target', '../main'], [...ARGV, '--target', 'main//branch'],
    replace('o/r', 'o/..'), replace('o/r', '-o/r'), replace('o/r', 'o/r/extra'),
    replace('o/r', 'o/r;whoami'), replace('992', '0'), replace('992', '1;whoami'),
    replace(HEAD, HEAD.slice(0, 12)), replace(HEAD, 'a'.repeat(40) + ';whoami'),
  ]) assert.equal(typeof parseArgs(argv).error, 'string', JSON.stringify(argv));
});

test('gh metadata uses argument arrays with shell disabled and never forwards command stderr', () => {
  let seen;
  const result = readPrMetadata('o/r', 992, (...args) => { seen = args; return { status: 0, stdout: JSON.stringify(metadata()) }; });
  assert.equal(result.number, 992);
  assert.deepEqual(seen[0], 'gh'); assert.deepEqual(seen[1], ['api', 'repos/o/r/pulls/992', '--method', 'GET']);
  assert.equal(seen[2].shell, false); assert.equal(seen[2].windowsHide, true); assert.ok(seen[2].timeout > 0);
  const secret = 'private-token-must-not-leak';
  assert.throws(() => readPrMetadata('o/r', 992, () => ({ status: 1, stderr: secret, error: new Error(secret) })),
    e => e.message === 'PR metadata unavailable' && !e.message.includes(secret));
});

test('transport exceptions, raw server refusal and gh failures are opaque and cannot leak private details', async () => {
  const secret = 'private-token-must-not-leak';
  for (const options of [
    { fetchError: new Error(secret) }, { metadataError: new Error(secret) },
    { reply: { status: 'rejected', error_code: secret } }, { reply: { ...binding(), status: secret } },
  ]) {
    const r = await run(ARGV, options);
    assert.equal(r.code, 2); assert.match(r.err, /UNCONFIRMED/); assert.doesNotMatch(r.out + r.err, new RegExp(secret));
    assert.doesNotMatch(r.out + r.err, /Error:| at /);
  }
});

test('unexpected output failures are unconfirmed exit 2 without a stack or raw exception', async () => {
  const f = fixture(), err = capture();
  assert.equal(await main(ARGV, f.ports, { write() { throw new Error('private output exception'); } }, err), 2);
  assert.equal(err.text, 'UNCONFIRMED: binding check could not complete.\n');
  assert.equal(checkRepush({ binding: binding(), claim: OLD }).exitCode, 0);
});

const TOOL = fileURLToPath(new URL('./pr-repush-preflight.mjs', import.meta.url));
const runNode = args => spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
test('direct and junction entry points run the check; importing from existing or missing importer paths runs nothing', () => {
  const direct = runNode([TOOL]);
  assert.equal(direct.status, 2, direct.stderr); assert.match(direct.stderr, /--repo is required/);
  const twice = runNode([TOOL, '--body-governs', '--body-governs']);
  assert.equal(twice.status, 2); assert.match(twice.stderr, /given twice/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repush-native-'));
  try {
    const link = path.join(dir, 'ci');
    fs.symlinkSync(path.dirname(TOOL), link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = runNode([path.join(link, 'pr-repush-preflight.mjs')]);
    assert.equal(linked.status, 2, linked.stderr); assert.match(linked.stderr, /--repo is required/);
  } finally {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const extra of [[], [path.join(os.tmpdir(), 'repush-native-no-such-file.mjs')],
    [path.join(os.tmpdir(), 'repush-native-no-such-directory', 'pr-repush-preflight.mjs')]]) {
    const imported = runNode(['--input-type=module', '-e',
      'await import(' + JSON.stringify(new URL('./pr-repush-preflight.mjs', import.meta.url).href) + '); console.log("imported")', ...extra]);
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, 'imported\n');
  }
});
