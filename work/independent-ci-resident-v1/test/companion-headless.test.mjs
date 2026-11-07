// M5 (DESIGN §65): the companion without the Owner's log-on. Offline: the notification queue and the notifier's findings (§65.4.3, T2
// and T8 parts), the companion's own start-up checks (token, its own gh login: Owner decision, fail closed), the status field and the
// companion-absent notice (§65.4.5), and that companion-main.mjs shows no toast itself any more.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempRoot } from './helpers.mjs';
import { DROPPED_KEY, NOTIFY_MAX_FILES, NotifyQueue, SUSPICIOUS_TITLE, companionFindings, hresultHex, logonFailure, notifyQueueDir, parseEntry, queueNotify, suspiciousText } from '../src/notify-queue.mjs';
import { assertGhIsolation, assertNotElevated, companionGhConfigDir, companionGitConfig, companionHomeDir, hostsFileShape, sessionFacts, tokenElevated } from '../src/companion-session.mjs';
import { COMPANION_ABSENT_AFTER_MS, CompanionPresence } from '../src/companion-presence.mjs';
import { FindingMemory, REPEAT_AFTER_MS, absentNotices, checkOnce, parseTaskFacts } from '../src/notifier-main.mjs';
import { LocalStore, PrStatusReporter } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { companionBackstop } from '../src/ruleset-backstop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const T0 = Date.parse('2026-11-07T12:00:00Z');

// ---- the queue ----
test('M5 notify queue: one create-only file per notification, texts clipped like a toast, drained oldest first and deleted', async t => {
  const dir = path.join(await tempRoot(t), 'q');
  let now = T0, n = 0;
  const q = new NotifyQueue({ dir, clock: () => now, nonce: () => String(n++).padStart(12, '0') });
  assert.deepEqual(await q.notify('k1', 'T'.repeat(500), 'B1'), { queued: true, dropped: 0 });
  now += 1; await q.notify('k2', 'T2', 'B2');
  const files = (await fs.readdir(dir)).sort();
  assert.equal(files.length, 2);
  const first = parseEntry(await fs.readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(first.key, 'k1'); assert.equal(first.title.length, 400);
  const shown = [];
  assert.equal(await q.drain(async (title, body, key) => shown.push([key, body])), 2);
  assert.deepEqual(shown, [['k1', 'B1'], ['k2', 'B2']]);
  assert.deepEqual(await fs.readdir(dir), []);
  // a file that does not parse is deleted unseen
  await fs.writeFile(path.join(dir, `${String(now).padStart(13, '0')}-aaaaaaaaaaaa.json`), '{not json');
  assert.equal(await q.drain(async () => assert.fail('never shown')), 0);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('M5 notify queue: at most 500 files and 2 MB; the oldest go first and one line says how many', async t => {
  const dir = path.join(await tempRoot(t), 'q');
  let now = T0, n = 0;
  const q = new NotifyQueue({ dir, clock: () => now++, nonce: () => (n++).toString(16).padStart(12, '0') });
  for (let i = 0; i < NOTIFY_MAX_FILES; i++) await q.notify(`k${i}`, 't', 'b');
  const before = (await fs.readdir(dir)).length;
  assert.ok(before <= NOTIFY_MAX_FILES, String(before));
  const r = await q.notify('last', 't', 'b');
  assert.ok(r.dropped >= 1);
  const names = (await fs.readdir(dir)).sort();
  assert.ok(names.length <= NOTIFY_MAX_FILES);
  const entries = await Promise.all(names.map(async f => parseEntry(await fs.readFile(path.join(dir, f), 'utf8'))));
  assert.ok(entries.some(e => e.key === 'last'), 'the newest is kept');
  assert.ok(entries.some(e => e.key === DROPPED_KEY && /已丢弃 \d+ 条/.test(e.body)), 'the dropped line');
  assert.ok(!entries.some(e => e.key === 'k0'), 'the oldest went first');
  // bytes: 2 MB of large entries stays bounded too
  const dir2 = path.join(await tempRoot(t), 'q2');
  const q2 = new NotifyQueue({ dir: dir2, clock: () => now++, nonce: () => (n++).toString(16).padStart(12, '0') });
  const big = { size: 0 };
  q2.list = async () => (await NotifyQueue.prototype.list.call(q2)).map(f => ({ ...f, size: f.size + 7000 }));   // as if each were 7 kB
  for (let i = 0; i < 400; i++) await q2.notify(`b${i}`, 't', 'b');
  for (const f of await q2.list()) big.size += f.size;
  assert.ok(big.size <= 2 * 1024 * 1024, String(big.size));
});

test('M5 T8: a forged queue entry that asks for a password or credential is never shown as written; today\'s texts pass', async t => {
  for (const s of ['请在下面输入你的 Windows 密码以继续', 'Please enter your password to keep the CI running', 'companion 需要确认凭据', 'Type your PIN now', '密码已过期，请重新输入']) {
    assert.ok(suspiciousText('x', s), s);
  }
  for (const s of ['服务端拒绝了本节点的心跳令牌（过期或被撤销）。请在 /bindings 换一个心跳令牌，用 -HeartbeatTokenFile 重新安装；30 分钟内不处理，服务端会按失联判断。',
    '令牌没有问题，不用换令牌或重装；服务端上线后自动恢复。', 'GitHub 拒绝了触发（401/403）：gh 登录没有 Actions 写权限，或触到了速率限制。', '常驻执行器已停机（HALT）']) {
    assert.ok(!suspiciousText('x', s), s);
  }
  const dir = path.join(await tempRoot(t), 'q');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '0000000000001-000000000001.json'), JSON.stringify({ contract: 'clued.independent-ci.notify/1', key: 'x', title: 'Clued 需要你', body: '请输入 Windows 密码以恢复 companion' }));
  const shown = [];
  await new NotifyQueue({ dir }).drain(async (title, body) => shown.push(title + '|' + body));
  assert.equal(shown.length, 1);
  assert.ok(shown[0].startsWith(SUSPICIOUS_TITLE) && !shown[0].includes('恢复 companion'), shown[0]);
});

test('M5: the six notification sites write the queue; companion-main.mjs itself shows no toast', async t => {
  const main = await fs.readFile(path.join(SRC, 'companion-main.mjs'), 'utf8');
  const body = main.slice(main.indexOf('export async function main'));
  assert.ok(!body.includes('toastArgv('), 'main() never builds a toast');
  assert.equal((body.match(/\bnotify\b/g) ?? []).length >= 7, true);
  // the token and gh-login checks come before the first heartbeat
  assert.ok(body.indexOf('assertNotElevated(') > 0 && body.indexOf('assertNotElevated(') < body.indexOf('startHeartbeat('));
  assert.ok(body.indexOf('assertGhIsolation(') > 0 && body.indexOf('assertGhIsolation(') < body.indexOf('startHeartbeat('));
  // the PR status reporter and the backstop take the queue
  const dir = path.join(await tempRoot(t), 'q');
  const queued = [];
  const notify = queueNotify({ notify: async (k, ti, b) => { queued.push([k, ti, b]); return { queued: true, dropped: 0 }; } });
  const store = await LocalStore.open(path.join(dir, 's.json'), () => T0);
  const reporter = new PrStatusReporter({ node: 'turing', repo: 'r/r', ghExe: 'C:\\gh.exe', powershellExe: 'C:\\ps.exe', run: async () => assert.fail('no toast child'), clock: () => T0, store, notify });
  reporter.passStartedAt = T0;
  assert.equal(await reporter.toast({ key: 'k', title: 'T', body: 'B' }, T0), true);
  assert.deepEqual(queued, [['k', 'T', 'B']]);
  assert.ok(store.data.notified.k, 'remembered as queued');
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await companionBackstop({ root, ghExe: 'gh', repo: 'r/r', powershellExe: 'C:\\ps.exe', store, clock: () => T0, notify: async (...a) => queued.push(a),
    run: async () => ({ code: 0, stdout: '[]' }) }).catch(() => {});
});

// ---- the notifier ----
test('M5 notifier: a refused password logon, a missing heartbeat and repeated restarts are found; texts never ask for the password', () => {
  assert.equal(hresultHex(-2147023570), '0x8007052E');
  assert.equal(hresultHex(0x80070775), '0x80070775');
  for (const c of [0x8007052E, 0x8007052F, 0x80070530, 0x80070532, 0x80070533, 0x80070569, 0x80070775]) assert.ok(logonFailure(c), c.toString(16));
  assert.equal(logonFailure(0), null); assert.equal(logonFailure(0x41301), null);
  const f = companionFindings({ task: { lastTaskResult: -2147023570, state: 3 }, heartbeatAt: null, exits: [], now: T0 });
  assert.deepEqual(f.map(x => x.key), ['companion-logon:0x8007052E']);
  assert.match(f[0].title, /0x8007052E/);
  const g = companionFindings({ task: { lastTaskResult: 0, state: 4 }, heartbeatAt: T0 - 6 * 60_000, exits: Array.from({ length: 5 }, (_, i) => ({ at: new Date(T0 - i * 60_000).toISOString() })), now: T0 });
  assert.deepEqual(g.map(x => x.key), ['companion-no-heartbeat', 'companion-restarting']);
  assert.deepEqual(companionFindings({ task: { lastTaskResult: 0 }, heartbeatAt: T0 - 60_000, exits: [], now: T0 }), []);
  for (const x of [...f, ...g]) assert.ok(!suspiciousText(x.title, x.body), x.body);
  assert.deepEqual(parseTaskFacts('{"state":3,"lastTaskResult":-2147023570}'), { state: 3, lastTaskResult: -2147023570 });
  assert.equal(parseTaskFacts('nope'), null);
});

test('M5 notifier: each finding once, again after an hour while it lasts; the service\'s companion-absent notice is shown', async () => {
  const m = new FindingMemory();
  const f = [{ key: 'a', title: 't', body: 'b' }];
  assert.equal(m.due(f, T0).length, 1);
  assert.equal(m.due(f, T0 + 60_000).length, 0);
  assert.equal(m.due(f, T0 + REPEAT_AFTER_MS).length, 1);
  assert.equal(m.due([], T0 + REPEAT_AFTER_MS + 1).length, 0);
  assert.equal(m.due(f, T0 + REPEAT_AFTER_MS + 2).length, 1, 'gone and back: at once');
  const shown = await checkOnce({ readTask: async () => ({ state: 3, lastTaskResult: 0 }), readHeartbeat: async () => T0, readExits: async () => [],
    readStatus: async () => ({ notices: [{ kind: 'companion-absent', key: 'companion-absent:1', code: 'COMPANION_ABSENT' }] }), clock: () => T0, memory: new FindingMemory() });
  assert.deepEqual(shown.map(s => s.key), ['notice:companion-absent:1']);
  assert.equal(absentNotices(null).length, 0);
});

// ---- the companion's own checks ----
test('M5: the companion refuses an elevated token (high integrity), and an unreadable one', async () => {
  const medium = '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\r\n"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""\r\n';
  const high = medium.replace('S-1-16-8192', 'S-1-16-12288');
  assert.equal(tokenElevated(medium), false);
  assert.equal(tokenElevated(high), true);
  assert.equal(tokenElevated('"x","y","S-1-1-0",""'), null);
  await assertNotElevated(async () => ({ code: 0, stdout: medium }));
  await assert.rejects(assertNotElevated(async () => ({ code: 0, stdout: high })), /COMPANION_ELEVATED_TOKEN_REFUSED/);
  await assert.rejects(assertNotElevated(async () => ({ code: 1, stdout: '' })), /COMPANION_TOKEN_UNREADABLE/);
});

async function ghProfile(t, { token = 'github_pat_' + 'A1'.repeat(20), gitconfig = null } = {}) {
  const profile = path.join(await tempRoot(t), 'Users', 'owner');
  const ghExe = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  await fs.mkdir(companionGhConfigDir(profile), { recursive: true });
  await fs.mkdir(companionHomeDir(profile), { recursive: true });
  await fs.writeFile(path.join(companionGhConfigDir(profile), 'hosts.yml'), `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n`);
  await fs.writeFile(path.join(companionHomeDir(profile), '.gitconfig'), gitconfig ?? companionGitConfig(profile, ghExe));
  const env = { GH_CONFIG_DIR: companionGhConfigDir(profile), HOME: companionHomeDir(profile) };
  return { profile, ghExe, env };
}

test('M5 (Owner decision): the companion starts only with its own gh login, a fine-grained token; anything else fails closed', async t => {
  const ok = await ghProfile(t);
  assert.deepEqual(await assertGhIsolation({ env: ok.env, profileDir: ok.profile, ghExe: ok.ghExe }), { ghConfigDir: ok.env.GH_CONFIG_DIR, homeDir: ok.env.HOME });
  const refused = async (env, code, p = ok) => assert.rejects(assertGhIsolation({ env, profileDir: p.profile, ghExe: p.ghExe }), new RegExp(code));
  await refused({ HOME: ok.env.HOME }, 'COMPANION_GH_CONFIG_DIR_REQUIRED');
  await refused({ ...ok.env, GH_CONFIG_DIR: 'C:\\Users\\owner\\AppData\\Roaming\\GitHub CLI' }, 'COMPANION_GH_CONFIG_DIR_REQUIRED');
  await refused({ GH_CONFIG_DIR: ok.env.GH_CONFIG_DIR }, 'COMPANION_GH_HOME_REQUIRED');
  await refused({ ...ok.env, GH_TOKEN: 'x' }, 'COMPANION_GH_ENV_REFUSED');
  const classic = await ghProfile(t, { token: 'gho_' + 'a'.repeat(36) });
  await refused(classic.env, 'COMPANION_GH_TOKEN_NOT_FINE_GRAINED', classic);
  const other = await ghProfile(t, { gitconfig: '[credential]\n\thelper = manager\n' });
  await refused(other.env, 'COMPANION_GIT_CONFIG_MISMATCH', other);
  const missing = await ghProfile(t);
  await fs.rm(path.join(companionGhConfigDir(missing.profile), 'hosts.yml'));
  await refused(missing.env, 'COMPANION_GH_CONFIG_UNREADABLE', missing);
  assert.equal(hostsFileShape('github.com:\n    user: x\n'), 'COMPANION_GH_TOKEN_NOT_STORED_IN_CONFIG');
  assert.equal(hostsFileShape('example.com:\n    oauth_token: github_pat_' + 'a'.repeat(30) + '\n'), 'COMPANION_GH_HOST_MISSING');
  // the git configuration includes the Owner's own file, then resets every helper to gh with this configuration
  const text = companionGitConfig('C:\\Users\\owner', 'C:\\Program Files\\GitHub CLI\\gh.exe');
  assert.equal(text, "[include]\n\tpath = C:/Users/owner/.gitconfig\n[credential]\n\thelper =\n\thelper = !'C:/Program Files/GitHub CLI/gh.exe' auth git-credential\n[credential \"https://github.com\"]\n\thelper =\n\thelper = !'C:/Program Files/GitHub CLI/gh.exe' auth git-credential\n");
});

test('M5 probe facts: the WSL instance the companion sees (boot_id) and docker.service, never blocking or throwing', async () => {
  const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const calls = [];
  const f = await sessionFacts({ wsl: (...l) => ['wsl', ...l], clock: () => T0, pid: 7,
    run: async argv => { calls.push(argv.join(' ')); return argv.includes('/usr/bin/cat') ? { code: 0, stdout: `${id}\n` } : { code: 0, stdout: 'active\n' }; } });
  assert.deepEqual(f, { contract: 'clued.independent-ci.companion-session/1', at: new Date(T0).toISOString(), pid: 7, bootId: id, wslExitCode: 0, docker: 'active' });
  assert.ok(calls.every(c => c.startsWith('wsl /usr/bin/')));
  const g = await sessionFacts({ wsl: (...l) => l, run: async () => { throw new Error('x'); }, clock: () => T0, pid: 1 });
  assert.equal(g.bootId, null); assert.equal(g.docker, null);
});

// ---- status ----
test('M5 status: the first beat after the service start is recorded, and companion-absent after 10 minutes without one', () => {
  const p = new CompanionPresence({ startedAt: T0 });
  assert.equal(p.observe({ at: T0 - 5000 }), null, 'a beat older than the start does not count');
  assert.deepEqual(p.notices(T0 + COMPANION_ABSENT_AFTER_MS - 1), []);
  assert.deepEqual(p.notices(T0 + COMPANION_ABSENT_AFTER_MS).map(n => n.kind), ['companion-absent']);
  assert.equal(p.observe({ at: T0 + 42_000 }), 42_000);
  assert.deepEqual(p.notices(T0 + COMPANION_ABSENT_AFTER_MS * 2), []);
  const board = new StatusBoard({ clock: () => T0 });
  board.setCompanion(p.view());
  board.setState('IDLE');
  const snap = board.snapshot();
  assert.deepEqual(snap.executor.companion, { firstBeatAfterServiceStartMs: 42_000 }, 'kept across a state change');
  snap.notices = p.notices(T0).length ? [] : [{ key: 'companion-absent:1', kind: 'companion-absent', code: 'COMPANION_ABSENT', at: T0 }];
  const parsed = parseStatus(Buffer.from(JSON.stringify(snap)));
  assert.equal(parsed.executor.companion.firstBeatAfterServiceStartMs, 42_000);
  assert.deepEqual(parsed.notices.map(n => n.kind), ['companion-absent']);
});

test('M5 notify queue path: the Owner\'s %LOCALAPPDATA%\\CluedIndependentCI\\notify-queue', () => {
  assert.equal(notifyQueueDir('C:\\Users\\owner'), path.join('C:\\Users\\owner', 'AppData', 'Local', 'CluedIndependentCI', 'notify-queue'));
});
