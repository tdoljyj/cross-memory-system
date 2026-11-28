import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { until } from '../../../scripts/ci/test-clock-guard.mjs';
import { sha256 } from '../src/canonical.mjs';
import { HEARTBEAT_TOKEN_DIR, HEARTBEAT_TOKEN_FILE } from '../src/companion-heartbeat.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { JOB_HOST_EXE, Runner } from '../src/runner.mjs';
import { HEAD, tempRoot } from './helpers.mjs';

const exec = promisify(execFile);
const mainUrl = new URL('../src/companion-main.mjs', import.meta.url);
const normal = os.constants.priority.PRIORITY_NORMAL;
const belowNormal = os.constants.priority.PRIORITY_BELOW_NORMAL;
const windows = process.platform === 'win32' && process.arch === 'x64';
const batchId = '1'.repeat(16) + '-' + '2'.repeat(12);
const pull = { number: 42, state: 'open', headSha: HEAD };
const priorityCode = 'COMPANION_PRIORITY_NOT_NORMAL';
const receivedAt = '2026-11-28T00:00:00.000Z';

async function compileHost(root) {
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const host = path.join(root, JOB_HOST_EXE);
  const source = fileURLToPath(new URL('../windows/CompanionJobHost.cs', import.meta.url));
  await exec(path.join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/target:winexe', '/platform:x64', '/optimize+',
    '/reference:' + path.join(framework, 'System.dll'), '/out:' + host, source], { windowsHide: true });
  return host;
}

async function startFixture(t, mode, host) {
  const root = await tempRoot(t, 'companion-priority-');
  const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), '--priority-fixture', root, mode, host ?? ''],
    { windowsHide: true });
  return JSON.parse(stdout);
}

// 只在夹具子进程替换外部依赖。启动、实例锁、邮箱和心跳仍走原入口。
function loadIsolatedMain(profileDir) {
  const companionUrl = JSON.stringify(new URL('../src/companion.mjs', import.meta.url).href);
  const replacements = {
    './companion.mjs': `export * from ${companionUrl};
      import { validateCompanionConfig as validate } from ${companionUrl};
      export function validateCompanionConfig(raw, source) {
        const cfg = validate(raw, source);
        return { ...cfg, node: { ...cfg.node, ownerProfileDirectory: ${JSON.stringify(profileDir)} } };
      }`,
    './companion-session.mjs': `export const assertNotElevated = async run => { await run(['fixture-token-check']); };
      export const assertGhIsolation = async () => {};
      export const sessionFacts = async () => ({});
      export const writeSessionFacts = async () => {};`,
    './wsl-client.mjs': 'export const resolveCompanionWslClient = async () => ({ path: "C:\\\\fixture\\\\wsl.exe" });',
    'node:child_process': 'export const spawn = () => ({ on() {} });',
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === mainUrl.href && Object.hasOwn(replacements, specifier)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  return import(mainUrl);
}

async function put(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function runFixture(root, mode, host) {
  const { setPriority, getPriority } = os;
  setPriority(0, belowNormal);
  assert.equal(getPriority(0), belowNormal, '夹具从 BelowNormal 启动');
  const calls = [];
  os.setPriority = (pid, priority) => {
    calls.push(['set', pid, priority]);
    if (mode === 'denied') throw new Error('夹具模拟系统拒绝');
    if (mode !== 'mismatch') setPriority(pid, priority);
  };
  os.getPriority = pid => {
    calls.push(['get', pid]);
    return getPriority(pid);
  };
  // Windows 路径和原生环境保持真实，仅模拟入口的平台分支。
  if (mode === 'non-windows') Object.defineProperty(process, 'platform', { value: 'linux' });
  const profileDir = path.join(root, 'profile');
  const { main, JOB_HOST_PROBE } = await loadIsolatedMain(profileDir);
  if (mode === 'import') return { calls, priority: getPriority(0) };
  process.env.USERPROFILE = profileDir;

  const cfg = JSON.parse(await fs.readFile(new URL('../config/companion.example.json', import.meta.url), 'utf8'));
  // 固定夹具主机名，避免开发机名称影响配置校验。
  os.hostname = () => cfg.companion.node.hostname;
  const source = '{}';
  const sourceDir = path.join(root, 'source', sha256(source));
  cfg.repo = 'fixture/priority';
  cfg.ghExe = path.join(root, 'gh.exe');
  Object.assign(cfg.companion, {
    relayScript: path.join(sourceDir, 'relay.ps1'), bundleScript: path.join(sourceDir, 'bundle.ps1'),
    windowsSpool: path.join(root, 'spool'),
  });
  const bytes = JSON.stringify(cfg);
  await put(path.join(root, 'config', 'companion.json'), bytes);
  await put(path.join(root, 'record', 'source-manifest.json'), source);
  const residentHost = path.join(root, 'bin', JOB_HOST_EXE);
  await put(residentHost, host ? await fs.readFile(host) : '');
  const requestArgs = ['--root', root, '--config-sha256', sha256(bytes)];
  const originalRun = Runner.prototype.run;
  const startup = {};
  const stop = new Error('夹具已观察启动探针');
  Runner.prototype.run = async function (argv, options) {
    if (argv[0] === JOB_HOST_PROBE[0]) {
      assert.deepEqual(argv, JOB_HOST_PROBE);
      startup.node = getPriority(0);
      if (!host) return { code: 0 };
      this.spawnImpl = (...args) => {
        const child = spawn(...args);
        startup.host = getPriority(child.pid);
        return child;
      };
      const probe = "process.stdout.write(String(require('node:os').getPriority(0)))";
      const result = await originalRun.call(this, [process.execPath, '-e', probe], options);
      startup.child = Number(result.stdout);
      assert.equal(result.code, 0, JSON.stringify(result));
      return result;
    }
    if (mode === 'live' || mode === 'non-windows') throw stop;
    if (argv[0] === cfg.ghExe && argv[4] === `repos/${cfg.repo}/pulls/${pull.number}`) {
      return { code: 0, stdout: JSON.stringify({ number: pull.number, state: pull.state, merged: false, head: pull.headSha }) };
    }
    if (argv[0].endsWith('\\sc.exe')) return { code: 0, stdout: 'STATE : 4 RUNNING' };
    return { code: 1, stdout: '', stderr: '' };
  };
  if (mode === 'live' || mode === 'non-windows') {
    // 在第二次真实子进程调用前结束，早期初始化均使用隔离夹具。
    await assert.rejects(main(requestArgs), error => error === stop);
    return { ...startup, calls };
  }

  globalThis.fetch = async url => {
    assert.match(url, /^https:\/\/priorityfixture\.supabase\.co\/rest\/v1\/rpc\//);
    return new Response(JSON.stringify({ status: 'ok', received_at: receivedAt }));
  };
  await put(path.join(root, 'record', 'installation.json'), JSON.stringify({
    supabaseUrl: 'https://priorityfixture.supabase.co', publishableKey: 'sb_publishable_fixture',
  }));
  await put(path.join(root, HEARTBEAT_TOKEN_DIR, HEARTBEAT_TOKEN_FILE), 'clued_hbt_' + 'x'.repeat(43));
  const mailbox = await Mailbox.open(path.join(root, 'mailbox'));
  const request = await mailbox.send('pr-head', { batchId, pr: pull.number }, 90_000);
  const local = path.join(profileDir, 'AppData', 'Local', 'CluedIndependentCI');
  const result = await Promise.race([main(requestArgs), (async () => {
    const reply = await until(() => mailbox.poll(request), 'pr-head 应答');
    const beat = await until(() => mailbox.heartbeat(), '本机邮箱心跳');
    const ack = await until(async () => {
      const text = await fs.readFile(path.join(local, 'companion-heartbeat.json'), 'utf8').catch(() => '{}');
      return JSON.parse(text).diagnostics?.lastServerAckAt;
    }, '模拟云端心跳回执');
    const logDir = path.join(local, 'companion-log');
    const names = await fs.readdir(logDir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const logs = await Promise.all(names.map(name => fs.readFile(path.join(logDir, name), 'utf8')));
    return { calls, reply: reply.pull, replyCode: reply.code, beat, ack, receivedAt,
      diagnostics: logs.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  })()]);
  return result;
}

if (process.argv[2] === '--priority-fixture') {
  const result = await runFixture(...process.argv.slice(3));
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
} else {
  test('导入入口无优先级副作用', { skip: !windows }, async t => {
    assert.deepEqual(await startFixture(t, 'import'), { calls: [], priority: belowNormal });
  });

  test('非 Windows 启动分支不读写进程优先级', { skip: !windows }, async t => {
    assert.deepEqual(await startFixture(t, 'non-windows'), { calls: [], node: belowNormal });
  });

  test('原生 Windows 启动与真实 JobHost 继承', { skip: !windows }, async t => {
    const host = await compileHost(await tempRoot(t));
    const result = await startFixture(t, 'live', host);
    await t.test('首个 Runner 启动宿主前，入口已设置并读回 Normal', () => {
      assert.equal(result.node, normal, '首个宿主启动前的 Node 优先级');
      assert.deepEqual(result.calls, [['set', 0, normal], ['get', 0]]);
    });
    await t.test('真实宿主和无网探针继承 Normal', () => {
      assert.deepEqual([result.host, result.child], [normal, normal], '[JobHost, 探针] 优先级');
    });
  });

  for (const [mode, label] of [['denied', '设置被拒绝'], ['mismatch', '读回不符']]) {
    test(`${label}时只写一条固定诊断，邮箱及两类心跳继续`, { skip: !windows }, async t => {
      const result = await startFixture(t, mode);
      assert.equal(result.replyCode, null);
      assert.deepEqual(result.reply, pull);
      assert.ok(Number.isSafeInteger(result.beat.at));
      assert.equal(result.ack, result.receivedAt);
      const entry = result.diagnostics.find(record => record.code === priorityCode);
      assert.ok(Number.isFinite(Date.parse(entry?.at)));
      assert.deepEqual(result.diagnostics, [{ at: entry.at, kind: 'companion-priority', code: priorityCode }]);
      assert.deepEqual(result.calls, mode === 'denied' ? [['set', 0, normal]] : [['set', 0, normal], ['get', 0]]);
    });
  }

  test('真实 JobHost 超时后清场，Runner 还能接下一单', { skip: !windows }, async t => {
    const runner = new Runner({ jobHost: await compileHost(await tempRoot(t)), env: { ...process.env } });
    const wait = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)';
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(wait)}],{stdio:'ignore'});
      process.stdout.write(process.pid+' '+c.pid);${wait}`;
    const result = await runner.run([process.execPath, '-e', script], { timeoutMs: 3_000 });
    assert.deepEqual([result.timedOut, result.tree], [true, 'zero']);
    const pids = result.stdout.trim().split(' ').map(Number);
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    assert.equal(runner.busy, false);
    assert.equal((await runner.run([process.execPath, '-e', '0'], { timeoutMs: 10_000 })).code, 0);
  });

  test('pr-head 迟到的有效应答仍被拒绝', async t => {
    let now = Date.parse(receivedAt);
    const mailbox = await Mailbox.open(await tempRoot(t), () => now, () => now);
    const request = await mailbox.send('pr-head', { batchId, pr: pull.number }, 1_000);
    const result = await mailbox.await(request, async () => {
      now += 1_001;
      await mailbox.respond(request, { ok: true, pull });
    });
    assert.equal(result, null);
    assert.deepEqual((await mailbox.poll(request)).pull, pull);
  });
}
