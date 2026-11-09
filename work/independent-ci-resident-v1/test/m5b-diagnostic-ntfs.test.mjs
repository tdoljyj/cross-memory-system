// Real NTFS regression for the actual generated diagnostic writer and the
// reviewed entry's directory handle. Only a fresh temporary tree is changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const registrar = fileURLToPath(new URL('../windows/CompanionTaskRegistrar.cs', import.meta.url));
const entry = fileURLToPath(new URL('../windows/start-m5b-logging-blocked-reviewed.ps1', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/m5b-diagnostic-ntfs.ps1', import.meta.url));

function run(exe, args, cwd) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)/i.test(name)) delete env[name];
  }
  const result = spawnSync(exe, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('M5-b actual diagnostic replacement works under directory pin without allowing directory rename', { skip: !windows }, async t => {
  const temp = path.resolve(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(temp, 'clued-m5b-diagnostic-ntfs-'));
  try {
    const dumpSource = path.join(scratch, 'Dump.cs'), dump = path.join(scratch, 'dump.exe');
    await fs.writeFile(dumpSource, String.raw`
using System;
public static class Dump {
  public static int Main() {
    Console.Write(RegistrarCore.ImportArguments("CluedDiagnosticFixture", @"D:\clued-fixture\ext4.vhdx", 0));
    return 0;
  }
}`);
    const refs = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${path.join(framework, name)}`);
    run(path.join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/main:Dump', ...refs, `/out:${dump}`, registrar, dumpSource], scratch);
    const action = run(dump, [], scratch);
    const actionPath = path.join(scratch, 'actual-action.txt');
    await fs.writeFile(actionPath, action);
    const registrarSha256 = createHash('sha256').update(await fs.readFile(registrar)).digest('hex');
    const output = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
      '-ActionPath', actionPath, '-EntryPath', entry, '-ScratchRoot', scratch, '-RegistrarSha256', registrarSha256], scratch);
    assert.match(output, /ASSERTIONS_PASS=16/);
    const evidence = JSON.parse(await fs.readFile(path.join(scratch, 'fixture-result.json'), 'utf8'));
    assert.equal(evidence.registrarSha256, registrarSha256);
    assert.equal(evidence.actualEntryWriteSucceeded, true);
    assert.equal(evidence.actualEntryRenameBlocked, true);
    assert.equal(evidence.actualFileWriteBlocked, true);
    assert.equal(evidence.actualFileRenameBlocked, true);
    assert.equal(evidence.taskWslActualRootEffects, 0);
    const legacy = evidence.variantResults.find(item => item.name === 'batch-only-generic-read-shareR');
    assert.equal(legacy.writeSucceeded, false);
    assert.equal(legacy.writeFailure.hresult, '0x80070497');
    const corrected = evidence.variantResults.find(item => item.name === 'batch-generic-read-shareRW');
    assert.equal(corrected.writeSucceeded, true);
    assert.equal(corrected.renameSucceededWhileHeld, false);
    assert.equal(corrected.renameHresult, '0x80070020');
    t.diagnostic('actual production writer: old shareR fails; actual entry shareRW publishes and still blocks namespace rename');
  } finally {
    // Verify the exact temporary target before recursive deletion on Windows.
    assert.equal(path.dirname(path.resolve(scratch)), temp);
    assert.match(path.basename(scratch), /^clued-m5b-diagnostic-ntfs-/);
    assert.equal((await fs.lstat(scratch)).isSymbolicLink(), false);
    assert.equal(path.resolve(await fs.realpath(scratch)), path.resolve(scratch));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
