import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function compile(root, cs, exe) {
  const fw = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const built = spawnSync(path.join(fw, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/reference:' + path.join(fw, 'System.Web.Extensions.dll'),
    '/reference:' + path.join(fw, 'System.dll'), '/reference:' + path.join(fw, 'System.Core.dll'), '/out:' + exe, cs],
  { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.error?.message ?? built.stdout + built.stderr);
}

async function makeSupervisor(t, instrument) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-supervisor-'));
  // CloseHandle(job) ends the child asynchronously; Windows can still hold its image at test teardown.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6 }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'companion-supervisor.lock'), '');
  const original = await fs.readFile(new URL('../windows/CompanionSupervisor.cs', import.meta.url), 'utf8');
  // 只把安装位置、诊断和权限环境换成非提权夹具。争锁仍使用真正的 Windows 文件句柄。
  const fixture = original.replace(/const string FixedRoot = @"[^"]+";/, () => 'const string FixedRoot = @"' + root + '";')
    .replace('string refusal = TokenRefusal();', 'string refusal = null;')
    .replace('if (why != null) throw new SupervisorRefusal(why);', '')
    .replace('Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)', 'SupervisorCore.FixedRoot');
  assert.ok(fixture.includes('const string FixedRoot = @"' + root + '";'));
  const cs = path.join(root, 'supervisor.cs'), exe = path.join(root, 'supervisor.exe');
  await fs.writeFile(cs, instrument(fixture));
  compile(root, cs, exe);
  function start() {
    const child = spawn(exe, [root], { cwd: root, env: { ...process.env, USERPROFILE: 'C:\\Users\\Fixture' }, windowsHide: true });
    const end = once(child, 'exit').then(([code]) => code);
    const result = () => Promise.race([end, once(child.stdout, 'data').then(([bytes]) => bytes.toString().trim())]);
    return { child, end, result };
  }
  return { root, start };
}

test('重复触发在创建 Job 前争锁，持有者退出后可接班', { skip: process.platform !== 'win32' }, async t => {
  const { start } = await makeSupervisor(t, source => source.replace('IntPtr job = NewKillOnCloseJob();',
    'Console.WriteLine("entered"); Console.Out.Flush(); Console.ReadLine(); return 0;\n    IntPtr job = NewKillOnCloseJob();'));
  const first = start();
  let second;
  try {
    assert.equal(await first.result(), 'entered');
    second = start();
    assert.equal(await second.result(), 4, '第二个进程必须退出，不能进入常驻循环');
  } finally {
    first.child.stdin.end('\n');
    if (second?.child.exitCode === null) second.child.stdin.end('\n');
    await Promise.all([first.end, second?.end]);
  }
  const next = start();
  try { assert.equal(await next.result(), 'entered'); }
  finally { next.child.stdin.end('\n'); await next.end; }
});

async function makeRunningFixture(t) {
  const { root, start } = await makeSupervisor(t, source => source
    // 用标准输入驱动等待结果和退避，运行真正的启动文件检查、派生、Job 和锁。
    .replace(/WaitForSingleObject\(pi\.process, [^)]+\)/, 'FixtureWait()')
    .replace(/Thread\.Sleep\([^;]+\);/g, 'FixtureBoundary("retry");')
    .replace('  // ---- job and child ----', `  static uint FixtureWait() { FixtureBoundary("waiting"); return 258; }
  static void FixtureBoundary(string state) {
    Console.WriteLine(state); Console.Out.Flush();
    if (Console.ReadLine() == null) Environment.Exit(91);
  }
  // ---- job and child ----`));
  const nodeExe = path.join(root, 'runtime', 'node.exe');
  const entry = path.join(root, 'resident', 'a'.repeat(64), 'src', 'companion-main.mjs');
  const launch = path.join(root, 'config', 'companion-launch.json');
  const retire = path.join(root, 'config', 'companion-supervisor-retired');
  for (const file of [nodeExe, entry, launch]) await fs.mkdir(path.dirname(file), { recursive: true });
  const childSource = path.join(root, 'waiting-child.cs');
  await fs.writeFile(childSource, 'class WaitingChild { static void Main() { new System.Threading.ManualResetEvent(false).WaitOne(); } }');
  compile(root, childSource, nodeExe);
  await fs.writeFile(entry, '// fixture\n');
  const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const profile = 'C:\\Users\\Fixture\\AppData\\Local\\CluedIndependentCI\\companion-gh';
  const spec = JSON.stringify({
    contract: 'clued.independent-ci.companion-launch/1', generation: 1,
    nodeExe, nodeExeSha256: await digest(nodeExe), entry, entrySha256: await digest(entry),
    configSha256: 'b'.repeat(64), ghConfigDir: path.join(profile, 'gh'), homeDir: path.join(profile, 'home'), pathDirs: [],
  });
  return { start, launch, retire, spec };
}

test('卸载发布退役标志后，等待子进程的监督器自行退出并释放锁', { skip: process.platform !== 'win32' }, async t => {
  const { start, launch, retire, spec } = await makeRunningFixture(t);
  await fs.writeFile(launch, spec);
  const first = start();
  try {
    assert.equal(await first.result(), 'waiting');
    await fs.writeFile(retire, '');
    const retired = first.result();
    first.child.stdin.write('tick\n');
    assert.equal(await retired, 0, '撤除后应退出，不能进入退避循环');
  } finally {
    if (first.child.exitCode === null) first.child.stdin.end();
    await first.end;
  }
  await fs.unlink(retire);
  const replacement = start();
  try {
    assert.equal(await replacement.result(), 'waiting');
    const stillWaiting = replacement.result();
    replacement.child.stdin.write('tick\n');
    assert.equal(await stillWaiting, 'waiting', '有效安装继续等待原子进程');
  }
  finally { replacement.child.stdin.end(); await replacement.end; }
});

test('启动文件暂缺时退避或保留原子进程，回滚重发后同一监督器继续工作', { skip: process.platform !== 'win32' }, async t => {
  const { start, launch, spec } = await makeRunningFixture(t);
  await fs.writeFile(launch, spec);
  const supervisor = start();
  async function tick(instance) {
    const next = instance.result();
    instance.child.stdin.write('tick\n');
    return next;
  }
  try {
    assert.equal(await supervisor.result(), 'waiting');
    await fs.unlink(launch);
    assert.equal(await tick(supervisor), 'waiting', '启动文件暂缺时应继续等待同一个子进程');
    await fs.writeFile(launch, spec);
    assert.equal(await tick(supervisor), 'waiting', '回滚重发后应继续等待同一个子进程');
  } finally {
    if (supervisor.child.exitCode === null) supervisor.child.stdin.end();
    await supervisor.end;
  }
  await fs.unlink(launch);
  const retrying = start();
  try {
    assert.equal(await retrying.result(), 'retry', '无子进程时启动文件暂缺应退避');
    await fs.writeFile(launch, spec);
    assert.equal(await tick(retrying), 'waiting');
  } finally {
    if (retrying.child.exitCode === null) retrying.child.stdin.end();
    await retrying.end;
  }
});
