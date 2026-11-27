import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempRoot } from './helpers.mjs';

test('相同账户的监督器在创建 Job 前争锁，持有者退出后可接班', { skip: process.platform !== 'win32' }, async t => {
  const root = await tempRoot(t);
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'companion-supervisor.lock'), '');
  // 只替换安装位置、临时目录无法提供的管理员 ACL，以及 Job 后的常驻循环。
  // 两个独立进程都走 Main 中的生产争锁路径，通过标准输入主动结束。
  const original = await fs.readFile(new URL('../windows/CompanionSupervisor.cs', import.meta.url), 'utf8');
  const fixture = original.replace('C:\\ProgramData\\CluedIndependentCI\\resident";', root + '";')
    .replace('string refusal = TokenRefusal();', 'string refusal = null;')
    .replace('if (why != null) throw new SupervisorRefusal(why);', '')
    .replace('IntPtr job = NewKillOnCloseJob();',
      'Console.WriteLine("entered"); Console.Out.Flush(); Console.ReadLine(); return 0;\n    IntPtr job = NewKillOnCloseJob();')
    .replace('Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)', 'SupervisorCore.FixedRoot');
  const cs = path.join(root, 'supervisor.cs'), exe = path.join(root, 'supervisor.exe');
  await fs.writeFile(cs, fixture);
  const fw = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const built = spawnSync(path.join(fw, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/reference:' + path.join(fw, 'System.Web.Extensions.dll'),
    '/reference:' + path.join(fw, 'System.dll'), '/reference:' + path.join(fw, 'System.Core.dll'), '/out:' + exe, cs], { encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stdout);
  const start = () => {
    const child = spawn(exe, [root], { windowsHide: true });
    const end = once(child, 'exit').then(([code]) => code);
    const entered = once(child.stdout, 'data').then(([bytes]) => bytes.toString().trim());
    return { child, end, result: Promise.race([end, entered]) };
  };
  const first = start();
  let second;
  try {
    assert.equal(await first.result, 'entered');
    second = start();
    assert.equal(await second.result, 4, '竞争者在派生子进程前退出');
  } finally {
    first.child.stdin.end('\n');
    if (second?.child.exitCode === null) second.child.stdin.end('\n');
    await Promise.all([first.end, second?.end]);
  }
  const next = start();
  try { assert.equal(await next.result, 'entered'); }
  finally { next.child.stdin.end('\n'); await next.end; }
});
