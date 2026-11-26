// Run the process-launch function from the actual task's decoded action. The
// receiver checks the raw Windows command line as well as CRT argv: a normal
// .NET fake accepts quoted options, while the real WSL leading-option parser
// treats a quoted "--version" as a Linux command (NODE-B R3 reproduction).
// No task, account, registry key, distribution or real WSL process is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const source = fileURLToPath(new URL('../windows/CompanionTaskRegistrar.cs', import.meta.url));

function run(exe, args, spawn = spawnSync) {
  // The suite runner bounds the test and owns cleanup of its process tree.
  const r = spawn(exe, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

test('M5-b harness accepts a PowerShell child that is slow to start', () => {
  const startupMs = 20_000;
  const result = run(powershell, ['-NoProfile', '-File', 'run.ps1'], (exe, args, { timeout }) => {
    assert.equal(exe, powershell);
    assert.deepEqual(args, ['-NoProfile', '-File', 'run.ps1']);
    if (timeout > 0 && timeout <= startupMs) {
      return { error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    }
    assert.equal(timeout ?? 0, 0, 'the suite runner owns the fixture deadline');
    return { status: 0, stdout: '{"commands":[]}' };
  });
  assert.deepEqual(JSON.parse(result), { commands: [] });
});

test('M5-b decoded task action sends every WSL token with unquoted leading options', { skip: !windows }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-m5b-argv-'));
  try {
    const csc = path.join(framework, 'csc.exe');
    const dumpSource = path.join(scratch, 'Dump.cs'), dump = path.join(scratch, 'dump.exe');
    await fs.writeFile(dumpSource, String.raw`
using System;
using System.Web.Script.Serialization;
public static class Dump {
  public static int Main() {
    string vhdx = @"D:\clued-resident\wsl\M5TestDistro\ext4.vhdx";
    string action = RegistrarCore.ImportArguments("M5TestDistro", vhdx, 1000);
    string max = @"D:\"; for (int i=0; i<15; i++) max += new string('a',64) + @"\"; max += "ext4.vhdx";
    string[] refused = { @"D:\has space\ext4.vhdx", @"D:\has'quote\ext4.vhdx", @"D:\has\""quote\ext4.vhdx", @"D:\x&y\ext4.vhdx" };
    foreach (string p in refused) {
      try { RegistrarCore.ImportScript("M5TestDistro",p,1000); return 3; } catch (ArgumentException) { }
    }
    Console.Write(new JavaScriptSerializer().Serialize(new {
      action = action, program = RegistrarCore.ImportScript("M5TestDistro",vhdx,1000), vhdx = vhdx,
      maxCommandLength = RegistrarCore.ImportArguments(new string('a',64),max,4294967295L).Length + RegistrarCore.PowerShellExe.Length + 3
    }));
    return 0;
  }
}`);
    const refs = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map(n => `/reference:${path.join(framework, n)}`);
    run(csc, ['/nologo', '/noconfig', '/target:exe', '/main:Dump', ...refs, `/out:${dump}`, source, dumpSource]);
    const generated = JSON.parse(run(dump, []));
    assert.ok(generated.maxCommandLength < 32767);
    t.diagnostic(`maximum validated task command length: ${generated.maxCommandLength} / 32767`);
    const encoded = generated.action.split(' -EncodedCommand ')[1];
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), generated.program);

    // A path with spaces/non-ASCII exercises ProcessStartInfo.FileName handling;
    // the production VHDX grammar intentionally continues to reject such input.
    const receiverDir = path.join(scratch, 'receiver with space \u6d4b\u8bd5');
    await fs.mkdir(receiverDir);
    const receiverSource = path.join(scratch, 'Receiver.cs'), receiver = path.join(receiverDir, 'argv-receiver.exe');
    await fs.writeFile(receiverSource, String.raw`
using System;
using System.Text;
using System.Web.Script.Serialization;
public static class Receiver {
  public static int Main(string[] a) {
    string raw = Environment.CommandLine;
    string tail = raw.Substring(raw[0]=='"' ? raw.IndexOf('"',1)+1 : raw.IndexOf(' ')).TrimStart();
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Write(new JavaScriptSerializer().Serialize(new { argv = a, rawTail = tail }));
    Console.Error.Write("\u7248\u672c\u6d4b\u8bd5");
    if (tail.StartsWith("\"")) return 91;
    if (a.Length==1 && a[0]=="--version") return 31;
    if (a.Length==1 && a[0]=="--status") return 32;
    if (a.Length==3 && a[0]=="--import-in-place" && a[1]=="M5TestDistro" && a[2]==@"D:\clued-resident\wsl\M5TestDistro\ext4.vhdx") return 33;
    if (a.Length==4 && a[0]=="--distribution" && a[1]=="M5TestDistro" && a[2]=="--exec" && a[3]=="/bin/true") return 34;
    return 93;
  }
}`);
    run(csc, ['/nologo', '/noconfig', '/target:exe', `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`, `/out:${receiver}`, receiverSource]);
    const programPath = path.join(scratch, 'task-action.ps1'), input = path.join(scratch, 'input.json');
    await fs.writeFile(programPath, generated.program);
    await fs.writeFile(input, JSON.stringify({ programPath, receiver, scratch }));
    const harness = path.join(scratch, 'run.ps1');
    // Windows PowerShell writes its stdout in the console code page (936 on a
    // Chinese-locale host, 437 on an English one), which mangles the non-ASCII
    // stderr this test checks; the result is read as UTF-8, so write UTF-8.
    await fs.writeFile(harness, String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = [IO.File]::ReadAllText($args[0]) | ConvertFrom-Json
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($c.programPath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'GENERATED_TASK_PARSE_FAILED' }
$functions = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Convert-IO','Invoke-IW')},$false))
if ($functions.Count -ne 2) { throw 'GENERATED_TASK_FUNCTIONS_MISSING' }
function New-FixtureStopwatch {
  $clock = [pscustomobject]@{ ElapsedMilliseconds = 0L }
  Add-Member -InputObject $clock -MemberType ScriptMethod -Name Stop -Value {}
  $clock
}
foreach ($f in $functions) {
  $definition = $f.Extent.Text
  if ($f.Name -ceq 'Invoke-IW') {
    # Exercise the real ProcessStartInfo and pipes with a fixed clock for the fake receiver.
    $clockCall = '[Diagnostics.Stopwatch]::StartNew()'
    if (-not $definition.Contains($clockCall)) { throw 'GENERATED_TASK_STOPWATCH_MISSING' }
    $definition = $definition.Replace($clockCall, '(New-FixtureStopwatch)')
  }
  . ([scriptblock]::Create($definition))
}
function Write-Diag { }
$script:r = [ordered]@{phase='starting';commands=@()}
$wsl = [string]$c.receiver; $dir = [string]$c.scratch
$distro = 'M5TestDistro'; $vhdx = 'D:\clued-resident\wsl\M5TestDistro\ext4.vhdx'
$calls = @($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Extent.Text -cmatch '^\$(?:null|import|probe) = Invoke-IW '},$true))
if ($calls.Count -ne 4) { throw 'GENERATED_TASK_CALLS_MISSING' }
foreach ($call in $calls) { . ([scriptblock]::Create($call.Extent.Text)) }
$r | ConvertTo-Json -Depth 6 -Compress
`);
    const result = JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, input]));
    assert.deepEqual(result.commands.map(c => c.phase), ['version', 'status', 'import', 'probe']);
    assert.deepEqual(result.commands.map(c => c.exitCode), [31, 32, 33, 34]);
    const argv = result.commands.map(c => JSON.parse(c.stdout));
    assert.deepEqual(argv.map(c => c.argv), [
      ['--version'], ['--status'], ['--import-in-place', 'M5TestDistro', generated.vhdx],
      ['--distribution', 'M5TestDistro', '--exec', '/bin/true'],
    ]);
    for (let i = 0; i < argv.length; i++) {
      assert.equal(argv[i].rawTail, argv[i].argv.join(' '), 'raw command line must not quote WSL leading options');
      assert.equal(result.commands[i].stderr, '\u7248\u672c\u6d4b\u8bd5');
      assert.equal(result.commands[i].timedOut, false);
      assert.equal(result.commands[i].error, null);
    }
  } finally {
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(scratch).startsWith('clued-m5b-argv-'));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
