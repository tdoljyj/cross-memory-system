import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const yaml = createRequire(path.join(root, 'apps/clued-cloud/package.json'))('yaml');
const workflow = (name) => yaml.parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const linux = workflow('clued-required-tests.yml');
const prepare = linux.jobs.trivy.steps.find((step) => step.name === 'Prepare the vulnerability DB and the pinned checks bundle');
const digest = prepare.env.CHECKS_DIGEST;
const ghcr = 'ghcr.io/aquasecurity/trivy-db:2';
const mirror = 'mirror.gcr.io/aquasec/trivy-db:2';
const now = '2026-11-25T12:00:00Z';
const stamp = (hour) => new Date(Date.parse(now) + hour * 3_600_000).toISOString();
const generation = (hour) => `db-${stamp(hour).replaceAll(':', '-')}`;
const forward = (value) => value.split(path.sep).join('/');
// Use Git for Windows bash, even when the machine also has WSL.
const bash = process.platform === 'win32'
  ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : 'bash';

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clued-trivy-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}

const fakeDocker = String.raw`
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
const log = (line) => appendFileSync(process.env.FAKE_LOG, line + '\n');
const opt = (name) => args[args.indexOf(name) + 1];
const advance = (seconds) => {
  const elapsed = process.env.FAKE_ELAPSED;
  writeFileSync(elapsed, String(Number(readFileSync(elapsed, 'utf8')) + seconds * 1000));
};
const stage = args.find((arg) => arg.startsWith('type=bind,src=') && arg.includes(',dst=/cache'))?.split(',')[1].slice(4);
const put = (name, value) => {
  const file = path.join(stage, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
if (args[0] === 'image') { log('inspect'); process.exit(process.env.FAKE_SOURCES === 'budget' ? 1 : 0); }
if (args[0] === 'pull') {
  log('pull');
  if (process.env.FAKE_SOURCES === 'budget') {
    const limit = Number(process.env.FAKE_DOCKER_TIMEOUT);
    advance(Math.min(125_000, limit) / 1000);
    if (limit < 125_000) process.exit(23);
  }
  process.exit(0);
}
if (args.includes('--download-db-only')) {
  const source = opt('--db-repository');
  log('db ' + source + ' ' + opt('--timeout'));
  if (process.env.FAKE_BARRIER) {
    writeFileSync(path.join(process.env.FAKE_BARRIER, String(process.pid)), 'ready');
    for (let i = 0; readdirSync(process.env.FAKE_BARRIER).length < 2; i++) {
      if (i === 300) throw new Error('the second downloader did not reach the barrier');
      await delay(20);
    }
  }
  // The old 5m attempts exhaust the step before getting to a reachable mirror.
  if (process.env.FAKE_SOURCES === 'down' || (process.env.FAKE_SOURCES === 'mirror' &&
      (!source.startsWith('mirror.') || opt('--timeout') === '5m'))) process.exit(23);
  if (['slow', 'budget'].includes(process.env.FAKE_SOURCES)) {
    const timeout = opt('--timeout');
    const trivySeconds = Number.parseInt(timeout, 10) * (timeout.endsWith('m') ? 60 : 1);
    const allowed = Math.min(trivySeconds, Number(process.env.FAKE_DOCKER_TIMEOUT) / 1000);
    if (process.env.FAKE_SOURCES === 'budget') {
      advance(allowed);
      process.exit(23);
    }
    advance(Math.min(120, allowed));
    if (allowed < 120) process.exit(23);
  }
  put('db/metadata.json', { Version: 2, UpdatedAt: process.env.FAKE_UPDATED, NextUpdate: process.env.FAKE_NEXT });
  put('db/trivy.db', 'complete db');
} else if (args.includes('--checks-bundle-repository')) {
  log('checks download');
  if (process.env.FAKE_FAIL_CHECKS) process.exit(23);
  put('policy/metadata.json', { Digest: opt('--checks-bundle-repository').split('@')[1], MajorVersion: 2 });
  put('policy/content/check.rego', 'package check');
} else if (opt('--entrypoint') === '/bin/cat') {
  log('read ' + args.at(-1));
  process.stdout.write(readFileSync(path.join(stage, args.at(-1).slice('/cache/'.length))));
} else if (['/bin/ls', 'find'].includes(opt('--entrypoint'))) {
  log('read policies');
  const policy = path.join(stage, 'policy/content/check.rego');
  if (existsSync(policy)) console.log(policy);
} else {
  throw new Error('unexpected fake Docker call: ' + JSON.stringify(args));
}
`;

function cacheFixture(t, { db, next = 12, checks = true, sources = 'down', concurrent = false, failChecks = false } = {}) {
  const dir = scratch(t);
  const home = path.join(dir, 'home');
  const cache = path.join(home, '.cache', 'clued-trivy');
  mkdirSync(cache, { recursive: true });
  if (db !== undefined) {
    put(path.join(cache, generation(db), 'db/metadata.json'), { Version: 2, UpdatedAt: stamp(db), NextUpdate: stamp(next) });
    put(path.join(cache, generation(db), 'db/trivy.db'), 'cached db');
  }
  const policy = path.join(cache, `checks-${digest.slice('sha256:'.length)}`, 'policy');
  if (checks) {
    put(path.join(policy, 'metadata.json'), { Digest: digest, MajorVersion: 2 });
    put(path.join(policy, 'content/check.rego'), 'package check');
  }
  const fake = path.join(dir, 'docker.mjs');
  const bin = path.join(dir, 'bin');
  put(fake, fakeDocker);
  put(path.join(bin, 'docker'), `#!/usr/bin/env bash\nexec "${forward(process.execPath)}" "${forward(fake)}" "$@"\n`);
  chmodSync(path.join(bin, 'docker'), 0o755);
  if (process.platform === 'win32') {
    const python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    put(path.join(bin, 'python3'), `#!/usr/bin/env bash\nexec "${forward(python)}" "$@"\n`);
    chmodSync(path.join(bin, 'python3'), 0o755);
  }
  const loader = path.join(dir, 'fake-commands.mjs');
  put(loader, `import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
if (process.argv[1]?.endsWith('trivy-cache.mjs')) {
  const execFile = childProcess.execFile;
  const redirect = (run) => (file, args, options, ...rest) => file === 'docker'
    ? run(process.execPath, [${JSON.stringify(fake)}, ...args], {
      ...options, env: { ...process.env, FAKE_DOCKER_TIMEOUT: String(options.timeout) },
    }, ...rest) : run(file, args, options, ...rest);
  childProcess.execFile = redirect(execFile);
  childProcess.execFile[promisify.custom] = redirect(promisify(execFile));
  syncBuiltinESMExports();
  process.getuid ??= () => 1976;
  process.getgid ??= () => 1976;
  Date.now = () => Date.parse(process.env.FAKE_NOW);
  Object.defineProperty(performance, 'now', {
    value: () => Number(readFileSync(process.env.FAKE_ELAPSED, 'utf8')),
  });
}
`);
  const barrier = concurrent ? path.join(dir, 'barrier') : '';
  if (barrier) mkdirSync(barrier);
  const run = (id, clock = now) => {
    const cwd = path.join(dir, id);
    const temp = path.join(cwd, 'temp');
    const log = path.join(cwd, 'calls.log');
    const output = path.join(cwd, 'github.env');
    const elapsed = path.join(cwd, 'elapsed');
    const helper = path.join(root, 'scripts/ci/trivy-cache.mjs');
    mkdirSync(temp, { recursive: true });
    writeFileSync(elapsed, '0');
    if (existsSync(helper)) {
      const trusted = path.join(cwd, 'trusted/scripts/ci');
      mkdirSync(trusted, { recursive: true });
      copyFileSync(helper, path.join(trusted, 'trivy-cache.mjs'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c',
        `bin="$FAKE_BIN"\nif command -v cygpath >/dev/null; then bin="$(cygpath -u "$bin")"; fi\nexport PATH="$bin:$PATH"\n${prepare.run}`], {
        cwd, env: { ...process.env, ...prepare.env, HOME: forward(home), USERPROFILE: forward(home), MSYS2_ARG_CONV_EXCL: '*',
          RUNNER_TEMP: forward(temp), GITHUB_ENV: forward(output), GITHUB_RUN_ID: id,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(loader).href}`,
          FAKE_BIN: forward(bin), FAKE_LOG: log, FAKE_SOURCES: sources, FAKE_BARRIER: barrier,
          FAKE_ELAPSED: elapsed, FAKE_FAIL_CHECKS: failChecks ? '1' : '', FAKE_NOW: clock,
          FAKE_UPDATED: !existsSync(helper) ? '2020-01-01T00:00:00Z' : stamp(-1),
          FAKE_NEXT: !existsSync(helper) ? '2999-01-01T00:00:00Z' : stamp(12) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, text, env: existsSync(output) ? readFileSync(output, 'utf8') : '',
        calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] }));
    });
  };
  return { cache, policy, run };
}

test('T1 fresh DB with both sources down: no downloads', async (t) => {
  const f = cacheFixture(t, { db: -1 });
  put(path.join(f.cache, generation(0), 'db/metadata.json'), 'null');
  const r = await f.run('fresh');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.match(r.env, /db-2026-11-25T11-00-00\.000Z/);
  assert.deepEqual(r.calls, ['inspect', 'read /cache/policy/metadata.json', 'read policies']);
});

test('T2 7h old but valid DB: one warning, reuse after both refresh attempts fail', async (t) => {
  const f = cacheFixture(t, { db: -7 });
  const r = await f.run('refresh');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(r.text.match(/::warning/g)?.length, 1);
  assert.match(r.env, /db-2026-11-25T05-00-00\.000Z/);
  assert.deepEqual(r.calls.filter((call) => call.startsWith('db ')), [`db ${ghcr} 3m`, `db ${mirror} 3m`]);
});

test('W1/W2 DB generations get one hour from replacement before reclamation', async (t) => {
  const f = cacheFixture(t);
  for (const [updated, published] of [[-4, -3], [-3, -1], [-1, -1 / 6]]) {
    const directory = path.join(f.cache, generation(updated));
    put(path.join(directory, 'db/metadata.json'), { Version: 2, UpdatedAt: stamp(updated), NextUpdate: stamp(12) });
    put(path.join(directory, 'db/trivy.db'), 'cached db');
    put(path.join(directory, 'published-at'), `${stamp(published)}\n`);
  }
  const r = await f.run('replacement-grace');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.match(r.env, /db-2026-11-25T11-00-00\.000Z/);
  assert.deepEqual(readdirSync(f.cache).filter((entry) => entry.startsWith('db-')).sort(), [generation(-3), generation(-1)]);
  const settled = await f.run('replacement-grace-elapsed', stamp(1));
  assert.equal(settled.code, 0, JSON.stringify(settled));
  assert.deepEqual(readdirSync(f.cache).filter((entry) => entry.startsWith('db-')), [generation(-1)]);
});

test('T3 expired DB with both sources down: fails with expiry and both sources', async (t) => {
  const f = cacheFixture(t, { db: -20, next: -2 });
  const r = await f.run('expired');
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.match(r.text, /vulnerability DB expired/);
  for (const value of ['NextUpdate', stamp(-2), ghcr, mirror]) assert.ok(r.text.includes(value), r.text);
  assert.deepEqual(r.calls.filter((call) => call.startsWith('db ')).map((call) => call.split(' ')[1]), [ghcr, mirror, ghcr, mirror]);
  assert.equal(r.env, '');
  assert.ok(existsSync(path.join(f.cache, generation(-20), 'db/trivy.db')), 'the latest DB stays even if expired');
});

test('T4 expired DB: ghcr times out, mirror publishes a new generation', async (t) => {
  const f = cacheFixture(t, { db: -20, next: -2, sources: 'mirror' });
  const r = await f.run('mirror');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(r.calls.filter((call) => call.startsWith('db ')).map((call) => call.split(' ')[1]), [ghcr, mirror]);
  assert.deepEqual(readdirSync(f.cache).filter((entry) => entry.startsWith('db-')).sort(), [generation(-20), generation(-1)].sort());
  assert.equal(readFileSync(path.join(f.cache, generation(-1), 'published-at'), 'utf8'), `${stamp(0)}\n`);
  assert.equal(readFileSync(path.join(f.cache, generation(-1), 'db/trivy.db'), 'utf8'), 'complete db');
});

test('T4 cold DB: a source that needs 120s can publish a current generation', async (t) => {
  const f = cacheFixture(t, { checks: false, sources: 'slow' });
  const r = await f.run('cold-120s');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(r.calls.filter((call) => call.startsWith('db ')), [`db ${ghcr} 240s`]);
  assert.match(r.env, /db-2026-11-25T11-00-00\.000Z/);
});

test('T4 cold DB: an image pull and DB attempts share the deadline and reserve time for checks', async (t) => {
  const f = cacheFixture(t, { checks: false, sources: 'budget' });
  const r = await f.run('cold-budget');
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.match(r.text, /vulnerability DB expired/);
  assert.deepEqual(r.calls, ['inspect', 'pull', `db ${ghcr} 240s`, `db ${mirror} 120s`]);
  assert.equal(r.env, '');
});

test('T4 abandoned staging entries older than one hour are reclaimed', async (t) => {
  const f = cacheFixture(t, { db: -1 });
  const abandoned = path.join(f.cache, '.stage-x-abc');
  const oldCid = `${abandoned}.cid`;
  const recent = path.join(f.cache, '.stage-x-recent');
  for (const entry of [abandoned, recent]) put(path.join(entry, 'partial'), 'partial download');
  put(oldCid, 'container id');
  for (const entry of [abandoned, oldCid]) utimesSync(entry, new Date(stamp(-2)), new Date(stamp(-2)));
  utimesSync(recent, new Date(stamp(0)), new Date(stamp(0)));
  const r = await f.run('abandoned-stage');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.ok(!existsSync(abandoned), 'two-hour-old .stage-x-abc directory should be removed');
  assert.ok(!existsSync(oldCid), 'two-hour-old .cid should be removed');
  assert.ok(existsSync(recent), 'a recent stage may still be active');
});

test('T5 two processes publish the same DB and checks generations atomically', async (t) => {
  const f = cacheFixture(t, { checks: false, sources: 'up', concurrent: true });
  const runs = await Promise.all([f.run('first'), f.run('second')]);
  for (const r of runs) assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(runs[0].env, runs[1].env);
  assert.deepEqual(readdirSync(f.cache).sort(), [path.basename(path.dirname(f.policy)), generation(-1)].sort());
  assert.equal(readFileSync(path.join(f.cache, generation(-1), 'db/trivy.db'), 'utf8'), 'complete db');
  assert.equal(readFileSync(path.join(f.policy, 'content/check.rego'), 'utf8'), 'package check');
  assert.equal(readFileSync(path.join(path.dirname(f.policy), 'published-at'), 'utf8'), `${stamp(0)}\n`);
});

test('W checks keep the pinned digest and reclaim other digests published at least an hour ago', async (t) => {
  const f = cacheFixture(t, { db: -1 });
  const old = `checks-${'1'.repeat(64)}`;
  const recent = `checks-${'2'.repeat(64)}`;
  const selected = path.basename(path.dirname(f.policy));
  for (const [name, published] of [[old, -1], [recent, -1 / 6], [selected, -2]]) {
    put(path.join(f.cache, name, 'published-at'), `${stamp(published)}\n`);
  }
  const r = await f.run('checks-grace');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(readdirSync(f.cache).filter((entry) => entry.startsWith('checks-')).sort(), [recent, selected].sort());
});

test('T6 cached checks: no download, validate digest, major version, custom flag and Rego', async (t) => {
  const f = cacheFixture(t, { db: -1, sources: 'up', failChecks: true });
  const r = await f.run('cached-checks');
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.ok(!r.calls.includes('checks download'), JSON.stringify(r));
  assert.ok(r.calls.includes('read /cache/policy/metadata.json') && r.calls.includes('read policies'), JSON.stringify(r));
  const meta = path.join(f.policy, 'metadata.json');
  const rego = path.join(f.policy, 'content/check.rego');
  for (const change of [{ Digest: 'wrong' }, { MajorVersion: 1 }, { CustomBuild: true }]) {
    put(meta, { Digest: digest, MajorVersion: 2, ...change });
    put(rego, 'package check');
    const bad = await f.run(`invalid-checks-${Object.keys(change)[0]}`);
    assert.equal(bad.code, 1, JSON.stringify(bad));
    assert.match(bad.text, /expected pinned digest, major version 2 and no custom build/);
    assert.equal(bad.calls.filter((call) => call === 'checks download').length, 1);
    assert.equal(bad.env, '');
  }
  put(meta, { Digest: digest, MajorVersion: 2 });
  rmSync(rego, { force: true });
  const noRego = await f.run('no-rego');
  assert.equal(noRego.code, 1, JSON.stringify(noRego));
  assert.match(noRego.text, /checks bundle read-back found no Rego policy/);
  assert.equal(noRego.calls.filter((call) => call === 'checks download').length, 1);
  assert.equal(noRego.env, '');
});

test('T6 damaged checks: quarantine the directory, reinstall once and reuse the repair', async (t) => {
  const f = cacheFixture(t, { db: -1 });
  put(path.join(f.policy, 'metadata.json'), { Digest: 'wrong', MajorVersion: 2 });
  const repaired = await f.run('repair-checks');
  assert.equal(repaired.code, 0, JSON.stringify(repaired));
  assert.equal(repaired.calls.filter((call) => call === 'checks download').length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(f.policy, 'metadata.json'), 'utf8')).Digest, digest);
  const reused = await f.run('reuse-repaired-checks');
  assert.equal(reused.code, 0, JSON.stringify(reused));
  assert.ok(!reused.calls.includes('checks download'), JSON.stringify(reused));
});

function exportFixture(t) {
  const dir = scratch(t);
  const candidate = path.join(dir, 'candidate');
  mkdirSync(candidate);
  const config = path.join(dir, 'gitconfig');
  put(config, '[user]\nname = CI fixture\nemail = fixture@invalid\n[commit]\ngpgSign = false\n[core]\nhooksPath =\nautocrlf = false\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync('git', ['-C', candidate, ...args], { env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const files = ['scripts/ci/test.txt', 'config/test.txt', '.github/test.txt', 'outside.txt'];
  for (const file of files) put(path.join(candidate, file), `base: ${file}\n`);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', path.join(dir, 'nonexistent-remote'));
  git('update-ref', 'refs/remotes/origin/main', sha);
  put(path.join(candidate, files[0]), 'untrusted worktree edit');
  const run = (step, ref, trusted = path.join(dir, 'trusted')) => {
    put(path.join(trusted, 'leftover.txt'), 'old output');
    // actions/checkout starts by fetching the ref from its origin even if another checkout has the object.
    const result = step.uses
      ? spawnSync('git', ['-C', candidate, 'fetch', 'origin', ref], { env, encoding: 'utf8' })
      : spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        cwd: dir, env: { ...env, ...step.env, GITHUB_WORKSPACE: forward(dir), TRUSTED_REF: ref }, encoding: 'utf8',
      });
    return { code: result.status, text: (result.stdout ?? '') + (result.stderr ?? '') };
  };
  return { dir, candidate, files, sha, git, run };
}

const archiveStep = (job) => job.steps.find((step) => /(?:Check out|Export) the trusted base/.test(step.name ?? ''));
const windows = workflow('clued-required-tests-windows.yml');

test('T7 offline trusted base export uses only the three folders at the local commit', (t) => {
  const f = exportFixture(t);
  for (const [step, ref] of [[archiveStep(linux.jobs['ci-suites']), 'main'], [archiveStep(windows.jobs['ci-suites-windows']), f.sha]]) {
    const r = f.run(step, ref);
    assert.equal(r.code, 0, JSON.stringify(r));
    const trusted = path.join(f.dir, 'trusted');
    assert.deepEqual(readdirSync(trusted).sort(), ['.github', 'config', 'scripts']);
    for (const file of f.files.slice(0, 3)) assert.equal(readFileSync(path.join(trusted, file), 'utf8'), `base: ${file}\n`);
  }
});

test('T8 missing trusted base commit fails with a local candidate diagnostic', (t) => {
  const f = exportFixture(t);
  const missing = 'a'.repeat(40);
  const r = f.run(archiveStep(linux.jobs['ci-suites']), missing);
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.ok(r.text.includes(missing), r.text);
  assert.match(r.text, /trusted baseline commit is missing from the candidate checkout/);
});

test('Trivy can start on the introduction PR only with the exact helper pinned by the workflow', (t) => {
  const f = exportFixture(t);
  const step = archiveStep(linux.jobs.trivy);
  const helper = 'scripts/ci/trivy-cache.mjs';
  put(path.join(f.candidate, helper), 'untrusted worktree helper');
  assert.notEqual(f.run(step, f.sha).code, 0, 'missing pinned object must fail even with a candidate file');
  f.git('hash-object', '-w', '--', path.join(root, helper));
  const result = f.run(step, f.sha);
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(readFileSync(path.join(f.dir, 'trusted', helper)), readFileSync(path.join(root, helper)));
});
