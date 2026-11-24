// The drill host keeps the test project in step with production (FABLE-drill-test-project-sync-20261124.md, the ruling "PR-A
// implementation report", sections 1 and 5): before any boot it takes the production applied list the latest successful release run on
// main exported (clued-production-applied-<run>), and runs the sync script (apps/clued-cloud/scripts/drill-test-sync.mjs) with the test
// database's password, which the Owner handed over once in the Windows credential dialog (-ServerDatabaseCredential). A list that is
// not there, a password that is not there or not taken, a test project that is not a prefix of production, a checkout without the
// sync's tools: each stops the drill before any boot with its own code. -SyncServer [-Rebuild] is the same sync on its own.
// No test here reaches GitHub, a database or the host's own files: gh is a stand-in, the sync script is a stand-in that records what
// it was given (one test runs the real one up to the point it refuses, offline), every path is this run's own.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kitModule from '../drill/make-drill-kit.mjs';
const checkModule = await import('../drill/drill-server-check.mjs').catch(() => ({}));
import { DRILL_SERVER, SYNCED, firstInstallAssets, ps, psCode, q, tmp } from './drill-vm-fixtures.mjs';

const windows = process.platform === 'win32';
const RESULT = 'clued.drill-test-sync.result/1';
const DB_USER = 'postgres.uscrdifznmlvczcekqpw';
// made for each run: a fixture, never a stored value (printable ASCII, as the host accepts)
const DB_PASSWORD = `fixture-${crypto.randomBytes(12).toString('hex')}`;
const dbPs = (user = DB_USER, password = DB_PASSWORD) => `(New-Object System.Management.Automation.PSCredential ${q(user)}, (ConvertTo-SecureString ${q(password)} -AsPlainText -Force))`;
const appliedText = (run, over = {}) => JSON.stringify({ contract: 'clued.production-applied.v1', source_commit: 'c'.repeat(40), run_id: String(run),
  applied: [{ version: '20260101000000', name: 'first', statements_md5: '0'.repeat(32) }, { version: '20261124140000', name: 'context_archive_structure_v1', statements_md5: '1'.repeat(32) }], ...over }) + '\n';

// ---------------------------------------------------------------- the production list (drill-server-check.mjs --production-list)
// gh stand-in: runs (the successful release runs on main, newest first), artifacts (per run: [{ name, expired }]), files (per run: the
// downloaded file's text), fail (per verb: how many calls fail before one answers). Records every call.
function gh({ runs = [{ databaseId: 9001, headSha: 'a'.repeat(40) }], artifacts = null, files = {}, fail = {}, missing = false } = {}) {
  const calls = [], failed = {};
  const run = async args => {
    calls.push(args);
    if (missing) { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; }
    const verb = args[0] === 'api' ? 'api' : `${args[0]} ${args[1]}`;
    failed[verb] = (failed[verb] ?? 0) + 1;
    if (failed[verb] <= (fail[verb] ?? 0)) return { exit: 1, stdout: '', stderr: 'error connecting to api.github.com' };
    if (verb === 'run list') return { exit: 0, stdout: JSON.stringify(runs), stderr: '' };
    if (verb === 'api') {
      const id = Number(/runs\/(\d+)\/artifacts/.exec(args[1])[1]);
      const list = (artifacts ?? {})[id] ?? [{ name: `clued-production-applied-${id}`, expired: false }];
      return { exit: 0, stdout: JSON.stringify({ total_count: list.length, artifacts: list }), stderr: '' };
    }
    if (verb === 'run download') {
      const id = Number(args[2]), dir = args[args.indexOf('--dir') + 1];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'production-applied.json'), files[id] ?? appliedText(id));
      return { exit: 0, stdout: '', stderr: '' };
    }
    return { exit: 1, stdout: '', stderr: `unknown ${args.join(' ')}` };
  };
  return { calls, run, verbs: () => calls.map(a => (a[0] === 'api' ? 'api' : `${a[0]} ${a[1]}`)) };
}
const listIn = (cacheDir, g) => checkModule.productionList({ cacheDir, gh: g.run, pause: async () => {} });
const codeOfList = async (cacheDir, g) => { try { await listIn(cacheDir, g); return null; } catch (e) { return e.message; } };

test('the production list is the latest successful release run\'s on main, downloaded once and kept on the host for that run', async () => {
  const cacheDir = path.join(tmp, 'list-cache');
  const g = gh();
  const first = await listIn(cacheDir, g);
  assert.deepEqual(first, { run: 9001, file: path.join(cacheDir, '9001', 'production-applied.json'), cached: false });
  assert.equal(fs.readFileSync(first.file, 'utf8'), appliedText(9001));
  // which run: the release workflow, on main, successful, the newest one
  const list = g.calls[0];
  for (const [flag, value] of [['--repo', 'tdoljyj/cross-memory-system'], ['--workflow', 'clued-cloud-production-release.yml'], ['--branch', 'main'], ['--status', 'success'], ['--limit', '1']]) {
    assert.equal(list[list.indexOf(flag) + 1], value, flag);
  }
  assert.ok(g.calls.some(a => a[0] === 'run' && a[1] === 'download' && a.includes('clued-production-applied-9001')), JSON.stringify(g.calls));
  // the same run again: the host's copy, nothing downloaded
  const again = gh();
  assert.deepEqual(await listIn(cacheDir, again), { ...first, cached: true });
  assert.deepEqual(again.verbs(), ['run list']);
  // a newer run: its list, and the older copy goes
  const newer = gh({ runs: [{ databaseId: 9002, headSha: 'b'.repeat(40) }] });
  assert.equal((await listIn(cacheDir, newer)).run, 9002);
  assert.deepEqual(fs.readdirSync(cacheDir), ['9002']);
  // a copy on the host that is not this run's list is not used: downloaded again
  fs.writeFileSync(path.join(cacheDir, '9002', 'production-applied.json'), appliedText(9001));
  const fixed = gh({ runs: [{ databaseId: 9002, headSha: 'b'.repeat(40) }] });
  assert.equal((await listIn(cacheDir, fixed)).cached, false);
  assert.equal(fs.readFileSync(path.join(cacheDir, '9002', 'production-applied.json'), 'utf8'), appliedText(9002));
});

test('DRILL_SERVER_PRODUCTION_LIST_MISSING: no successful release run, no list exported, an expired one, or a file that is not the run\'s list', async () => {
  const cacheDir = path.join(tmp, 'list-missing');
  const missing = async g => (await codeOfList(cacheDir, g))?.split(':')[0];
  assert.equal(await missing(gh({ runs: [] })), 'DRILL_SERVER_PRODUCTION_LIST_MISSING');
  assert.equal(await missing(gh({ artifacts: { 9001: [] } })), 'DRILL_SERVER_PRODUCTION_LIST_MISSING');
  assert.equal(await missing(gh({ artifacts: { 9001: [{ name: 'clued-production-applied-9001', expired: true }] } })), 'DRILL_SERVER_PRODUCTION_LIST_MISSING');
  for (const text of ['not json', appliedText(9001, { contract: 'other' }), appliedText(9001, { run_id: '1' }), appliedText(9001, { applied: [] })]) {
    assert.equal(await missing(gh({ files: { 9001: text } })), 'DRILL_SERVER_PRODUCTION_LIST_MISSING', text);
  }
  assert.equal(fs.existsSync(path.join(cacheDir, '9001', 'production-applied.json')), false, 'nothing kept that is not a list');
});

test('each gh call is tried three times; GitHub not answering is DRILL_SERVER_UNREACHABLE, gh not installed is DRILL_SERVER_SYNC_TOOL_MISSING', async () => {
  const cacheDir = path.join(tmp, 'list-retry');
  const flaky = gh({ fail: { 'run list': 2, api: 2, 'run download': 2 } });
  assert.equal((await listIn(cacheDir, flaky)).run, 9001);
  assert.deepEqual(flaky.verbs(), ['run list', 'run list', 'run list', 'api', 'api', 'api', 'run download', 'run download', 'run download']);
  const down = gh({ fail: { 'run list': 3 } });
  assert.equal(await codeOfList(path.join(tmp, 'list-down'), down), 'DRILL_SERVER_UNREACHABLE:github');
  assert.equal(down.calls.length, 3);
  assert.equal(await codeOfList(path.join(tmp, 'list-no-gh'), gh({ missing: true })), 'DRILL_SERVER_SYNC_TOOL_MISSING:gh');
});

// ---------------------------------------------------------------- drill-server.json poolerHost
test('drill-server.json names the session pooler the host\'s sync connects through; it never goes into the kit', async () => {
  const committed = JSON.parse(fs.readFileSync(new URL('../drill/drill-server.json', import.meta.url), 'utf8'));
  assert.ok(Object.hasOwn(committed, 'poolerHost'), 'the one place the pooler host is named (DESK fills it)');
  assert.ok(committed.poolerHost === null || typeof committed.poolerHost === 'string');
  const { publishableKey, ...named } = DRILL_SERVER;
  const file = path.join(tmp, 'pooler-server.json'), keyFile = path.join(tmp, 'pooler-no-key.json');
  fs.writeFileSync(file, JSON.stringify(named));
  assert.equal(kitModule.readDrillServer({ file, keyFile, allowUnset: true }).poolerHost, DRILL_SERVER.poolerHost);
  fs.writeFileSync(file, JSON.stringify({ ...named, poolerHost: null }));
  assert.equal(kitModule.readDrillServer({ file, keyFile, allowUnset: true }).poolerHost, null, 'not filled in yet: the sync refuses (DRILL_SERVER_POOLER_HOST_NOT_SET), not the kit');
  for (const bad of [42, ['x'], { host: 'x' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...named, poolerHost: bad }));
    assert.throws(() => kitModule.readDrillServer({ file, keyFile, allowUnset: true }), e => e.message === 'DRILL_SERVER_REFUSED', JSON.stringify(bad));
  }
  const { poolerHost, ...without } = named;
  fs.writeFileSync(file, JSON.stringify(without));
  assert.throws(() => kitModule.readDrillServer({ file, keyFile, allowUnset: true }), e => e.message === 'DRILL_SERVER_REFUSED', 'the key is part of the file\'s shape');
  // the kit: the guest does not use it
  const f = firstInstallAssets('pooler-kit');
  kitModule.prepareFrom({ ...f, out: f.from });
  await kitModule.makeDrillKit({ ...f });
  assert.doesNotMatch(fs.readFileSync(path.join(f.out, 'kit.json'), 'utf8'), /pooler/);
});

// ---------------------------------------------------------------- the host (drill-vm.ps1)
// The sync script stand-in: records its arguments, standard input and environment beside itself, and answers what answer.json says
// (stdout lines, a stderr text, an exit; '<stdin>' prints what it was given, to prove the host never shows it).
function fakeSyncTool(name, answer) {
  const dir = path.join(tmp, `sync-tool-${name}`); fs.mkdirSync(dir, { recursive: true });
  const tool = path.join(dir, 'drill-test-sync.mjs');
  fs.writeFileSync(tool, `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const input = fs.readFileSync(0, 'utf8');
const answer = JSON.parse(fs.readFileSync(path.join(here, 'answer.json'), 'utf8'));
fs.writeFileSync(path.join(here, 'seen.json'), JSON.stringify({ argv: process.argv.slice(2), stdin: input, env: process.env }));
for (const line of answer.stdout ?? []) console.log(line === '<stdin>' ? input : line);
if (answer.stderr) console.error(answer.stderr === '<stdin>' ? input : answer.stderr);
process.exitCode = answer.exit ?? 0;
`);
  fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(answer));
  return { dir, tool, seen: () => JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8')), wasRun: () => fs.existsSync(path.join(dir, 'seen.json')) };
}
const inSync = (over = {}) => ({ stdout: ['drill-test-sync: applying 3 rows', JSON.stringify({ contract: RESULT, state: 'in-sync', production_last: { version: '20261124140000', name: 'context_archive_structure_v1' },
  production_rows: 329, applied: 3, fixtures: { users: 2, seeded: 0, project: '0597aa60-9b98-4da6-a4ab-63d7705b632f', project_account: 'q***@qq.com' }, ...over })] });
const failed = code => ({ stdout: [JSON.stringify({ contract: RESULT, state: 'failed', code })], stderr: `drill-test-sync: ${code}`, exit: 1 });

// One world: a Release directory with its first-install kit, this run's database credential file, the production list stand-in.
function syncWorld(name, { credential = 'stored', list = null } = {}) {
  const root = path.join(tmp, `sync-world-${name}`), from = path.join(root, 'from'); fs.mkdirSync(from, { recursive: true });
  const kitFile = path.join(from, 'fleet-node-1.2.3.first-install-kit.json');
  fs.writeFileSync(kitFile, JSON.stringify({ record: { scope: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f', repository: 'tdoljyj/cross-memory-system' } }));
  const applied = path.join(root, 'production-applied.json'); fs.writeFileSync(applied, appliedText(9001));
  const credFile = path.join(root, 'server-database.clixml');
  const listAnswer = list ?? `@{ exit = 0; stdout = ${q(JSON.stringify({ run: 9001, file: applied, cached: false }))}; stderr = '' }`;
  const setup = `$script:Drill.ServerDatabaseCredential = ${q(credFile)}; $script:Drill.ProductionListCache = ${q(path.join(root, 'cache'))}
    Set-Item function:Sync-DrillServer $script:RealSyncDrillServer
    $script:ListAsked = 0; function Invoke-DrillProductionListNode([string]$Node) { $script:ListAsked++; ${listAnswer} }
    ${credential === 'stored' ? `if (-not (Test-Path -LiteralPath ${q(credFile)})) { ${dbPs()} | Export-Clixml -LiteralPath ${q(credFile)} }` : ''}`;
  return { root, from, kitFile, applied, credFile, setup };
}
const syncCode = (w, tool, extra = '') => ps(`${w.setup}; $script:Drill.SyncTool = ${q(tool)}
  $m = $null; try { Sync-DrillServer ${q(w.from)} '1.2.3' ${extra} | Out-Null; $c = $null; $d = $null } catch { $x = Get-DrillCode $_; $c = $x.code; $d = [string]$x.detail; $m = [string]$_.Exception.Message }
  [ordered]@{ code = $c; detail = $d; message = $m; listAsked = $script:ListAsked }`);

test('-ServerDatabaseCredential stores the test database password the dialog gave, for this Windows user only, and prints nothing of it', { skip: !windows }, () => {
  const file = path.join(tmp, 'server-database-stored.clixml');
  const stored = ps(`$script:Drill.ServerDatabaseCredential = ${q(file)}; $r = Save-DrillServerDatabaseCredential { ${dbPs()} }
    [ordered]@{ status = $r.status; user = $r.user; file = $r.file; read = (Get-DrillCredential -ServerDatabase).UserName; text = (ConvertTo-Json $r -Compress) }`);
  assert.equal(stored.status, 'DRILL_SERVER_DATABASE_CREDENTIAL_STORED'); assert.equal(stored.user, DB_USER); assert.equal(stored.read, DB_USER); assert.equal(stored.file, file);
  assert.doesNotMatch(stored.text, new RegExp(DB_PASSWORD)); assert.doesNotMatch(fs.readFileSync(file, 'latin1').replaceAll('\0', ''), new RegExp(DB_PASSWORD), 'DPAPI, not the clear text');
  // another user name (another project, production's), an empty password, a password over two lines: nothing stored
  for (const [user, password] of [['postgres.ccxsikzwxlolxqlosril', DB_PASSWORD], ['postgres', DB_PASSWORD], [DB_USER, ' '], [DB_USER, 'two\nlines']]) {
    const none = path.join(tmp, `server-database-refused-${user.length}-${password.length}.clixml`);
    assert.equal(psCode(`$script:Drill.ServerDatabaseCredential = ${q(none)}; Save-DrillServerDatabaseCredential { ${dbPs(user, password)} }`), 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED', user);
    assert.equal(fs.existsSync(none), false);
  }
  // the reader: not there, or not readable / of another shape
  assert.equal(psCode(`$script:Drill.ServerDatabaseCredential = ${q(path.join(tmp, 'no-server-database.clixml'))}; Get-DrillCredential -ServerDatabase`), 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING');
  fs.writeFileSync(path.join(tmp, 'server-database-garbage.clixml'), 'not clixml');
  assert.equal(psCode(`$script:Drill.ServerDatabaseCredential = ${q(path.join(tmp, 'server-database-garbage.clixml'))}; Get-DrillCredential -ServerDatabase`), 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED');
  // the entry: given alone; the dialog itself is the one the binding uses (credui, never the console's prompt)
  assert.equal(psCode(`$ServerDatabaseCredential = $true; $Version = '1.2.3'; function Save-DrillServerDatabaseCredential { throw 'reached the dialog' }; Invoke-DrillMain`), 'DRILL_USAGE');
  const r = ps(`$ServerDatabaseCredential = $true; function Save-DrillServerDatabaseCredential { [ordered]@{ status = 'reached' } }; Invoke-DrillMain`);
  assert.equal(r.status, 'reached');
  const source = fs.readFileSync(new URL('../drill/drill-vm.ps1', import.meta.url), 'utf8');
  const reader = source.slice(source.indexOf('function Read-DrillServerDatabaseFromDialog'), source.indexOf('function Save-DrillServerDatabaseCredential'));
  assert.match(reader, /CluedDrillCredUi/); assert.doesNotMatch(reader, /Get-Credential|Read-Host/);
});

test('DRILL_SERVER_DATABASE_CREDENTIAL_MISSING: no password handed over, and nothing is asked of GitHub or the database', { skip: !windows }, () => {
  const w = syncWorld('no-credential', { credential: 'none' });
  const t = fakeSyncTool('no-credential', inSync());
  const r = syncCode(w, t.tool);
  assert.equal(r.code, 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING'); assert.equal(r.listAsked, 0); assert.equal(t.wasRun(), false);
});

test('DRILL_SERVER_PRODUCTION_LIST_MISSING from the list tool stops the sync before the database is touched', { skip: !windows }, () => {
  const w = syncWorld('list-missing', { list: `@{ exit = 1; stdout = ''; stderr = "DRILL_SERVER_PRODUCTION_LIST_MISSING:no-artifact\`n" }` });
  const t = fakeSyncTool('list-missing', inSync());
  const r = syncCode(w, t.tool);
  assert.equal(r.code, 'DRILL_SERVER_PRODUCTION_LIST_MISSING'); assert.equal(r.detail, 'no-artifact'); assert.equal(r.listAsked, 1); assert.equal(t.wasRun(), false);
  const u = syncWorld('list-down', { list: `@{ exit = 1; stdout = ''; stderr = "DRILL_SERVER_UNREACHABLE:github\`n" }` });
  assert.equal(syncCode(u, t.tool).code, 'DRILL_SERVER_UNREACHABLE');
});

test('the sync script is given the list, the Release\'s first-install kit and the server file as arguments, and the password on its standard input only', { skip: !windows }, () => {
  const w = syncWorld('in-sync');
  const t = fakeSyncTool('in-sync', inSync());
  const r = ps(`${w.setup}; $script:Drill.SyncTool = ${q(t.tool)}; Sync-DrillServer ${q(w.from)} '1.2.3'`);
  assert.deepEqual(r, { ...SYNCED, applied: 3 });
  const seen = t.seen();
  assert.equal(seen.stdin, DB_PASSWORD, 'the password, on standard input');
  assert.deepEqual(seen.argv.slice(0, 4), ['--applied', w.applied, '--kit', w.kitFile]);
  assert.equal(seen.argv[4], '--server'); assert.equal(path.basename(seen.argv[5]), 'drill-server.json');
  assert.equal(seen.argv.includes('--rebuild'), false, 'never a rebuild unless asked for');
  assert.doesNotMatch(JSON.stringify(seen.argv) + JSON.stringify(seen.env), new RegExp(DB_PASSWORD), 'in no argument and no environment variable');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(DB_PASSWORD));
  // asked for, a rebuild
  ps(`${w.setup}; $script:Drill.SyncTool = ${q(t.tool)}; Sync-DrillServer ${q(w.from)} '1.2.3' -Rebuild`);
  assert.equal(t.seen().argv.at(-1), '--rebuild');
});

test('each refusal of the sync script is the host\'s code: the password refused, diverged (stale too), its tools missing, a row failed', { skip: !windows }, () => {
  const w = syncWorld('refusals');
  for (const code of ['DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED', 'DRILL_SERVER_DIVERGED', 'DRILL_SERVER_SYNC_TOOL_MISSING', 'DRILL_SERVER_UNREACHABLE',
    'DRILL_SERVER_POOLER_HOST_NOT_SET', 'DRILL_SERVER_PRODUCTION_LIST_MISSING', 'DRILL_SERVER_SYNC_FAILED:supabase/migrations/20261124120000_retention_sweep_v1.sql', 'DRILL_SERVER_SYNC_FAILED:fixtures']) {
    const t = fakeSyncTool(`refusal-${code.length}-${code.slice(13, 20)}`, failed(code));
    const r = syncCode(w, t.tool);
    assert.equal(`${r.code}${r.detail ? `:${r.detail}` : ''}`, code, code);
  }
  // a failed row: the database's own reason (on standard error after the code) comes along, the password masked
  const row = 'DRILL_SERVER_SYNC_FAILED:supabase/migrations/20261124120000_retention_sweep_v1.sql';
  const why = fakeSyncTool('row-reason', { ...failed(row), stderr: `drill-test-sync: ${row} permission denied for table t (as ${DB_PASSWORD})` });
  const rr = syncCode(w, why.tool);
  assert.equal(rr.code, 'DRILL_SERVER_SYNC_FAILED');
  assert.equal(rr.detail, 'supabase/migrations/20261124120000_retention_sweep_v1.sql permission denied for table t (as ***)');
  // the test project already holds more than production's newest list: someone wrote it past the sync; the drill does not run on it
  const stale = fakeSyncTool('stale', inSync({ state: 'stale', applied: 0, fixtures: null }));
  const r = syncCode(w, stale.tool);
  assert.equal(r.code, 'DRILL_SERVER_DIVERGED'); assert.equal(r.detail, 'stale');
  // no result line at all
  const silent = fakeSyncTool('silent', { stdout: ['drill-test-sync: something'], exit: 2, stderr: 'usage' });
  assert.equal(syncCode(w, silent.tool).code, 'DRILL_SERVER_SYNC_FAILED');
});

test('DRILL_SERVER_SYNC_TOOL_MISSING: a checkout without the sync script; the real script\'s own answer is read the same way', { skip: !windows }, () => {
  const w = syncWorld('tool-missing');
  const r = syncCode(w, path.join(tmp, 'no-such-dir', 'drill-test-sync.mjs'));
  assert.equal(r.code, 'DRILL_SERVER_SYNC_TOOL_MISSING'); assert.equal(r.listAsked, 0, 'refused before GitHub is asked');
  // the real script (offline: a list that is not there stops it before the password is read or any connection is made): without the
  // app's node_modules it says SYNC_TOOL_MISSING, with them PRODUCTION_LIST_MISSING; the host reads either as the script's code
  const real = fileURLToPath(new URL('../../../apps/clued-cloud/scripts/drill-test-sync.mjs', import.meta.url));
  const gone = syncWorld('real-script', { list: `@{ exit = 0; stdout = ${q(JSON.stringify({ run: 9001, file: path.join(tmp, 'no-such-list.json'), cached: false }))}; stderr = '' }` });
  const answer = ps(`${gone.setup}; try { Sync-DrillServer ${q(gone.from)} '1.2.3' | Out-Null; $null } catch { (Get-DrillCode $_).code }`);
  assert.ok(['DRILL_SERVER_SYNC_TOOL_MISSING', 'DRILL_SERVER_PRODUCTION_LIST_MISSING'].includes(answer), String(answer));
  assert.ok(fs.existsSync(real), 'the default tool is the checkout\'s own script');
});

test('the password is never in what the host prints or throws, whatever the sync script echoes', { skip: !windows }, () => {
  const w = syncWorld('echo');
  for (const answer of [{ stdout: ['<stdin>'], stderr: '<stdin>', exit: 2 }, { stdout: ['<stdin>', JSON.stringify({ contract: RESULT, state: 'failed', code: 'DRILL_SERVER_SYNC_FAILED:database' })], stderr: '<stdin>', exit: 1 }]) {
    const t = fakeSyncTool(`echo-${answer.exit}`, answer);
    const r = syncCode(w, t.tool);
    assert.equal(r.code, 'DRILL_SERVER_SYNC_FAILED');
    assert.doesNotMatch(JSON.stringify(r), new RegExp(DB_PASSWORD));
    assert.equal(t.seen().stdin, DB_PASSWORD, 'the stand-in did see it');
  }
});

test('-SyncServer [-Rebuild] runs the same sync on its own, from the Release\'s first-install kit, and starts nothing else', { skip: !windows }, () => {
  const w = syncWorld('entry');
  const t = fakeSyncTool('entry', inSync());
  const main = `${w.setup}; $script:Drill.SyncTool = ${q(t.tool)}
    function Assert-DrillHost { throw (New-DrillError 'TEST_REACHED_HOST_GATE') }; function Invoke-DrillWithHostHold { throw (New-DrillError 'TEST_REACHED_HOST_HOLD') }`;
  const r = ps(`${main}; $SyncServer = $true; $Rebuild = $true; $From = ${q(w.from)}; $Version = '1.2.3'; Invoke-DrillMain`);
  assert.equal(r.status, 'DRILL_SERVER_SYNCED'); assert.equal(r.state, 'in-sync'); assert.equal(r.releaseRun, 9001); assert.equal(r.projectAccount, 'q***@qq.com');
  assert.equal(t.seen().argv.at(-1), '--rebuild');
  const plain = ps(`${main}; $SyncServer = $true; $From = ${q(w.from)}; $Version = '1.2.3'; Invoke-DrillMain`);
  assert.equal(plain.status, 'DRILL_SERVER_SYNCED'); assert.equal(t.seen().argv.includes('--rebuild'), false);
  // its refusal is the code, as before a drill
  const d = fakeSyncTool('entry-diverged', failed('DRILL_SERVER_DIVERGED'));
  assert.equal(psCode(`${main}; $script:Drill.SyncTool = ${q(d.tool)}; $SyncServer = $true; $From = ${q(w.from)}; $Version = '1.2.3'; Invoke-DrillMain`), 'DRILL_SERVER_DIVERGED');
  // usage: -From and -Version are needed (the scope is the Release's), nothing of a run beside it, -Rebuild only with -SyncServer
  for (const expr of [`$SyncServer = $true; $Version = '1.2.3'`, `$SyncServer = $true; $From = ${q(w.from)}`, `$SyncServer = $true; $From = ${q(w.from)}; $Version = '1.2.3'; $Kit = 'x'`,
    `$SyncServer = $true; $From = ${q(w.from)}; $Version = '1.2.3'; $BindingCredential = $true`, `$Rebuild = $true; $From = ${q(w.from)}; $Version = '1.2.3'; $Kit = 'x'`,
    `$SyncServer = $true; $From = ${q(path.join(w.root, 'not-a-release'))}; $Version = '1.2.3'`]) {
    assert.equal(psCode(`${main}; ${expr}; Invoke-DrillMain`), 'DRILL_USAGE', expr);
  }
});
