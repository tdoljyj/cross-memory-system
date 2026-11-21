// One rule for every child a package PowerShell script starts, and the evidence a refusal carries (Fable ruling 11-19 renew-key,
// "补：陪伴账户与证据保留" sections 1(a) and 2). Under Windows PowerShell 5.1 a native child's stderr line, merged into the output
// stream (2>&1) under $ErrorActionPreference = 'Stop', becomes a terminating error: prepare-companion-account.ps1 ended so on its first
// token child (drill of 4c6834dc, A1 COMPANION_ACCOUNT_NOT_PREPARED), as first-install-host.ps1's own children had before H1. So:
//   1. no package .ps1 merges a stream into the output (the parser's MergingRedirectionAst, never a text search: comments and strings
//      do not count); a child runs through Invoke-NativeChild, and every copy of that function is the same text (each script runs alone
//      and cannot load another);
//   2. the token children of prepare-companion-account.ps1 run through it: a child that threw ends the run with the code it threw (kept),
//      a child that only wrote to stderr does not end it;
//   3. the evidence goes with the verdict: the script's stdout carries its log's error and steps, and first-install-host.ps1's refusal
//      detail inlines them; it names no file in P1's stage (removed when P1 ends), no credential directory and nothing token-shaped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TREE_FILES, TREE_PREFIXES, isExcludedFromTree } from '../rollout/fleet/universal.mjs';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(RES, '..', '..');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const tail = (s, n = 6000) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''));
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function ps(command, env = {}) {
  const e = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${command}`, 'utf16le').toString('base64')],
    { cwd: RES, env: e, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: 600_000 });
  assert.ifError(r.error);
  return { status: r.status, stdout: String(r.stdout ?? ''), lines: String(r.stdout ?? '').split(/\r?\n/).filter(l => l.trim()), out: `${tail(r.stdout)}\n${tail(r.stderr, 3000)}` };
}

// The package's .ps1 files: what selectTree (universal.mjs) takes from the working tree.
function packagePs1() {
  const out = new Set();
  const walk = (rel) => {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return;
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}${d.name}`;
      if (d.isDirectory()) walk(`${r}/`);
      else if (d.name.endsWith('.ps1') && !isExcludedFromTree(r)) out.add(r);
    }
  };
  for (const p of TREE_PREFIXES) if (!isExcludedFromTree(p)) walk(p);
  for (const f of TREE_FILES) if (f.endsWith('.ps1')) out.add(f);
  return [...out].sort();
}

test('package .ps1: no stream merged into the output; every Invoke-NativeChild is the same text', { skip, timeout: 600_000 }, (t) => {
  const files = packagePs1();
  assert.ok(files.includes('work/independent-ci-resident-v1/windows/first-install-host.ps1') && files.includes('work/independent-ci-resident-v1/windows/prepare-companion-account.ps1'), files.join('\n'));
  const list = path.join(tempDir(t, 'native-child-'), 'files.txt');
  fs.writeFileSync(list, files.map(f => path.join(REPO, f)).join('\n'), 'utf8');
  const r = ps(`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$merges = New-Object Collections.Generic.List[string]; $defs = [ordered]@{}; $bad = New-Object Collections.Generic.List[string]
foreach ($f in [IO.File]::ReadAllLines(${psLiteral(list)})) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { $bad.Add($f); continue }
  foreach ($m in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.MergingRedirectionAst] }, $true)) { $merges.Add($f + ':' + $m.Extent.StartLineNumber + ': ' + $m.Parent.Extent.Text.Split([char]10)[0]) }
  foreach ($d in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq 'Invoke-NativeChild' }, $true)) { $defs[$f + ':' + $d.Extent.StartLineNumber] = $d.Extent.Text }
}
(New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ merges = @($merges); unparsable = @($bad); defs = $defs })`);
  assert.equal(r.status, 0, r.out);
  const v = JSON.parse(r.lines.at(-1));
  const rel = s => path.relative(REPO, s).replaceAll('\\', '/');
  assert.deepEqual(v.unparsable.map(rel), [], 'every package .ps1 parses');
  assert.deepEqual(v.merges.map(rel), [], 'a stream merged into the output (2>&1, *>&1, ...): run the child through Invoke-NativeChild');
  const where = Object.keys(v.defs).map(k => rel(k.replace(/:\d+$/, '')));
  for (const f of ['windows/first-install-host.ps1', 'windows/prepare-companion-account.ps1']) assert.ok(where.includes(`work/independent-ci-resident-v1/${f}`), `${f} defines Invoke-NativeChild (${where.join(', ')})`);
  const texts = Object.values(v.defs).map(x => x.replace(/\r\n/g, '\n'));
  for (const [k, x] of Object.entries(v.defs)) assert.equal(x.replace(/\r\n/g, '\n'), texts[0], `${rel(k)}: Invoke-NativeChild differs from the first copy`);
});

// The real functions of prepare-companion-account.ps1 (taken by AST), around a stand-in companion-gh-login.ps1 that plays each child.
const PREP = path.join(RES, 'windows', 'prepare-companion-account.ps1');
const STANDIN = `param([switch]$Login, [switch]$Check, [switch]$CopyFromOwner, [string]$ProfileDirectory, [string]$AccountSid, [string]$GhExe)
$ErrorActionPreference = 'Stop'
$mode = if ($CopyFromOwner) { 'CopyFromOwner' } elseif ($Login) { 'Login' } else { 'Check' }
Add-Content -LiteralPath $env:CLUED_TEST_CALLS -Value $(if ($GhExe -ceq 'C:\\Program Files\\GitHub CLI\\gh.exe') { $mode } else { $mode + ':no-gh-exe' })
$plan = @{}
foreach ($pair in ($env:CLUED_TEST_PLAN -split ';')) { $kv = $pair -split '=', 2; $plan[$kv[0]] = $kv[1] }
$what = [string]$plan[$mode]
if ($what -like 'throw:*') { throw $what.Substring(6) }
if ($what -ceq 'start-missing') { [void][Diagnostics.Process]::Start('C:\\clued-test-no-such\\gh.exe') }
if ($what -like 'warn+*') { [Console]::Error.WriteLine('a warning on stderr only'); $what = $what.Substring(5) }
$status, $exit = $what -split ',', 2
'{"status":"' + $status + '"}'
exit ([int]$exit)`;

function tokenStep(t, plan) {
  const dir = tempDir(t, 'token-step-');
  const gl = path.join(dir, 'companion-gh-login.ps1'); fs.writeFileSync(gl, STANDIN, 'utf8');
  const calls = path.join(dir, 'calls.txt'); fs.writeFileSync(calls, '', 'utf8');
  const r = ps(`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.Web.Extensions
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(PREP)}, [ref]$tokens, [ref]$errors)
foreach ($name in @('Invoke-NativeChild', 'Get-ChildErrorId', 'Invoke-CompanionTokenChild', 'Invoke-CompanionTokenStep')) {
  $f = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq $name }, $true))
  if ($f.Count -ne 1) { throw ('FUNCTION_MISSING:' + $name) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}
$steps = [ordered]@{}; $thrown = $null
try { Invoke-CompanionTokenStep 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' ${psLiteral(gl)} 'C:\\Users\\clued-companion' 'S-1-5-21-1-2-3-1008' $steps 'C:\\Program Files\\GitHub CLI\\gh.exe' } catch { $thrown = [string]$_.Exception.Message }
(New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ thrown = $thrown; steps = $steps })`,
  { CLUED_TEST_PLAN: Object.entries(plan).map(([k, v]) => `${k}=${v}`).join(';'), CLUED_TEST_CALLS: calls });
  assert.equal(r.status, 0, r.out);
  return { ...JSON.parse(r.lines.at(-1)), calls: fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean), out: r.out };
}

test('token children: a thrown code ends the step with that code, kept; the evidence is in the steps', { skip, timeout: 600_000 }, (t) => {
  // a refusal (account SID refused): the code the child threw, never lost, and nothing after it runs
  const sid = tokenStep(t, { CopyFromOwner: 'throw:ACCOUNT_SID_REFUSED' });
  assert.equal(sid.thrown, 'ACCOUNT_SID_REFUSED', sid.out);
  assert.deepEqual(sid.calls, ['CopyFromOwner']);
  assert.deepEqual([sid.steps.tokenLogin.source, sid.steps.tokenLogin.exit, sid.steps.tokenLogin.errorId], ['owner-existing-token', 1, 'ACCOUNT_SID_REFUSED'], sid.out);
  // gh missing on the machine: the same (a refusal with its code)
  const gh = tokenStep(t, { CopyFromOwner: 'throw:GH_EXE_MISSING' });
  assert.equal(gh.thrown, 'GH_EXE_MISSING', gh.out);
  // the Owner has no token (an answer, not an error): the clipboard is tried; its refusal keeps its code
  const clip = tokenStep(t, { CopyFromOwner: 'COMPANION_GH_OWNER_TOKEN_MISSING,1', Login: 'throw:CLIPBOARD_IS_NOT_A_CLASSIC_TOKEN' });
  assert.equal(clip.thrown, 'CLIPBOARD_IS_NOT_A_CLASSIC_TOKEN', clip.out);
  assert.deepEqual(clip.calls, ['CopyFromOwner', 'Login']);
  assert.deepEqual([clip.steps.tokenLogin.source, clip.steps.tokenLogin.ownerTokenCopy, clip.steps.tokenLogin.errorId], ['clipboard', 'COMPANION_GH_OWNER_TOKEN_MISSING', 'CLIPBOARD_IS_NOT_A_CLASSIC_TOKEN'], clip.out);
  // an exception that is not a code (gh not startable in -Check): the step's own code, the error id kept in the steps
  const start = tokenStep(t, { CopyFromOwner: 'COMPANION_GH_LOGIN_COPIED,0', Check: 'start-missing' });
  assert.equal(start.thrown, 'TOKEN_CHILD_FAILED:CHECK', start.out);
  const checkStep = start.steps.tokenCheck;
  assert.equal(checkStep.errorId, 'Win32Exception', start.out);
});

test('token children: a line on stderr alone ends nothing (H1); the answers are read as before', { skip, timeout: 600_000 }, (t) => {
  const warn = tokenStep(t, { CopyFromOwner: 'warn+COMPANION_GH_LOGIN_COPIED,0', Check: 'warn+COMPANION_GH_LOGIN_READY,0' });
  assert.equal(warn.thrown, null, warn.out);
  assert.deepEqual(warn.calls, ['CopyFromOwner', 'Check']);
  assert.deepEqual([warn.steps.tokenLogin.source, warn.steps.tokenLogin.status, warn.steps.tokenCheck.status], ['owner-existing-token', 'COMPANION_GH_LOGIN_COPIED', 'COMPANION_GH_LOGIN_READY'], warn.out);
  const notReady = tokenStep(t, { CopyFromOwner: 'COMPANION_GH_LOGIN_COPIED,0', Check: 'COMPANION_GH_LOGIN_NOT_READY:token,1' });
  assert.equal(notReady.thrown, null, notReady.out);
  assert.deepEqual([notReady.steps.tokenCheck.exit, notReady.steps.tokenCheck.status], [1, 'COMPANION_GH_LOGIN_NOT_READY:token'], notReady.out);
});

// What a verdict line may carry: nothing in P1's stage, no credential directory, nothing token- or key-shaped.
const STAGE_RE = /clued-p1-[0-9a-f]{8,}/i;
const leaks = text => [
  ...(STAGE_RE.test(text) ? ['stage path'] : []),
  ...(/first-install\\\\credentials|first-install\\credentials|clued-drill-credentials|CredentialDirectory/i.test(text) ? ['credential directory'] : []),
  ...(/ghp_[A-Za-z0-9]{36}|github_pat_|clued_(?:bnd|hbt)_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(text) ? ['token- or key-shaped'] : []),
];

test('the leak check itself: a stage path, a credential directory, a token are each found', () => {
  assert.deepEqual(leaks('{"detail":"C:\\\\Windows\\\\Temp\\\\clued-p1-0123456789abcdef\\\\companion-log\\\\x.json"}'), ['stage path']);
  assert.deepEqual(leaks('{"detail":"C:\\\\ProgramData\\\\CluedIndependentCI\\\\first-install\\\\credentials\\\\resident-upgrade.token"}'), ['credential directory']);
  assert.deepEqual(leaks(`{"detail":"ghp_${'a'.repeat(36)}"}`), ['token- or key-shaped']);
  assert.deepEqual(leaks('{"detail":"clued_bnd_abcdefghijkl"}'), ['token- or key-shaped']);
  assert.deepEqual(leaks('{"status":"FIRST_INSTALL_HOST_REFUSED","code":"COMPANION_ACCOUNT_NOT_PREPARED"}'), []);
});

test('the evidence goes with the verdict: error and steps inline, no stage path, the stage removed', { skip, timeout: 600_000 }, (t) => {
  const stage = path.join(tempDir(t, 'evidence-'), 'clued-p1-0123456789abcdef0123456789abcdef');
  fs.mkdirSync(path.join(stage, 'companion-log'), { recursive: true });
  const r = ps(`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(PREP)}, [ref]$tokens, [ref]$errors)
$f = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq 'Get-PrepareOutput' }, $true))
if ($f.Count -ne 1) { throw 'FUNCTION_MISSING:Get-PrepareOutput' }
. ([scriptblock]::Create($f[0].Extent.Text))
$stage = ${psLiteral(stage)}
$logFile = Join-Path (Join-Path $stage 'companion-log') 'companion-account-prepare.CLUED-DRILL.20261119T181025Z.json'
[IO.File]::WriteAllText($logFile, '{}')
# the log as the script keeps it when the token step refused (a registrar answer read by ConvertFrom-Json, as the script reads it)
$log = [ordered]@{ contract = 'clued.independent-ci.companion-account-prepare/1'; status = 'COMPANION_ACCOUNT_NOT_PREPARED'; steps = [ordered]@{}; nodeProfile = $null; facts = [ordered]@{ tasks = @('not inlined') } }
$log.steps.registrar = [ordered]@{ sourceSha256 = ('a' * 64); pinned = ('a' * 64) }
$log.steps.account = '{"code":"ACCOUNT_PREPARED","sid":"S-1-5-21-1-2-3-1008","profileDirectory":"C:\\\\Users\\\\clued-companion"}' | ConvertFrom-Json
$log.steps.tokenLogin = [ordered]@{ source = 'owner-existing-token'; exit = 1; status = $null; errorId = 'GH_EXE_MISSING' }
$log.error = 'GH_EXE_MISSING'
$prepStdout = (Get-PrepareOutput $log $logFile) | ConvertTo-Json -Depth 8
. ${psLiteral(path.join(RES, 'windows', 'first-install-host.ps1'))}
try { $null = Assert-CompanionPrepared ([ordered]@{ exit = 1; stdout = $prepStdout; stderr = ''; timedOut = $false }) }
finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }`);
  assert.equal(r.status, 1, r.out);
  assert.ok(!fs.existsSync(stage), 'the stage is removed on the refusal path');
  const verdictLine = r.lines.at(-1);
  const v = JSON.parse(verdictLine);
  assert.deepEqual([v.status, v.code], ['FIRST_INSTALL_HOST_REFUSED', 'COMPANION_ACCOUNT_NOT_PREPARED'], r.out);
  assert.equal(v.detail.error, 'GH_EXE_MISSING', verdictLine);
  assert.equal(v.detail.exit, 1, verdictLine);
  assert.deepEqual(v.detail.steps.tokenLogin, { source: 'owner-existing-token', exit: 1, status: null, errorId: 'GH_EXE_MISSING' }, verdictLine);
  assert.equal(v.detail.steps.account.code, 'ACCOUNT_PREPARED', verdictLine);
  assert.ok(!('facts' in v.detail), 'only the declared fields are inlined');
  assert.deepEqual(r.lines.flatMap(leaks), [], r.out);
});

// ---- A child's stdin carries our bytes and nothing before them (run 44705707829). Windows PowerShell 5.1 (.NET Framework) opens a
// redirected stdin as a StreamWriter in Console.InputEncoding and writes that encoding's preamble at Process.Start: on a UTF-8 console
// (code page 65001) a BOM. Every start with a redirected stdin carries the same guard, the one text below: while the child starts,
// Console's cached input encoding is a UTF-8 without a preamble, put back after.
const NO_BOM_GUARD = [
  "$cie = if ($psi.RedirectStandardInput) { [Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static') } else { $null }",
  '$was = if ($null -ne $cie) { $cie.GetValue($null) } else { $null }',
  'if ($null -ne $cie) { $cie.SetValue($null, (New-Object Text.UTF8Encoding($false))) }',
];
const NO_BOM_START = /^try \{ \$[A-Za-z]+ = \[Diagnostics\.Process\]::Start\(\$psi\) \} finally \{ if \(\$null -ne \$cie\) \{ \$cie\.SetValue\(\$null, \$was\) \} \}$/;

test('package .ps1: every process start whose function redirects stdin carries the no-BOM guard, the same text', { skip, timeout: 600_000 }, (t) => {
  const files = packagePs1();
  const list = path.join(tempDir(t, 'no-bom-'), 'files.txt');
  fs.writeFileSync(list, files.map(f => path.join(REPO, f)).join('\n'), 'utf8');
  const r = ps(`$ErrorActionPreference = 'Stop'
$sites = New-Object Collections.Generic.List[object]
foreach ($f in [IO.File]::ReadAllLines(${psLiteral(list)})) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
  $scopes = [ordered]@{}
  foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left -is [Management.Automation.Language.MemberExpressionAst] -and $x.Left.Member.Extent.Text -ceq 'RedirectStandardInput' }, $true)) {
    $s = $a.Parent; while ($null -ne $s -and $s -isnot [Management.Automation.Language.FunctionDefinitionAst]) { $s = $s.Parent }
    if ($null -eq $s) { $s = $ast }
    $scopes[[string]$s.Extent.StartOffset] = $s
  }
  foreach ($s in $scopes.Values) {
    $starts = @($s.FindAll({ param($x) $x -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $x.Static -and $x.Member.Extent.Text -ceq 'Start' -and $x.Expression.Extent.Text -match '^\\[(System\\.)?Diagnostics\\.Process\\]$' }, $true))
    if (-not $starts.Count) { $sites.Add([ordered]@{ file = [string]$f; line = [int]$s.Extent.StartLineNumber; start = $null; prev = [string[]]@() }); continue }
    foreach ($x in $starts) {
      $try = $x.Parent.Parent.Parent.Parent; $prev = @()
      if ($try -is [Management.Automation.Language.TryStatementAst] -and ($try.Parent -is [Management.Automation.Language.StatementBlockAst] -or $try.Parent -is [Management.Automation.Language.NamedBlockAst])) {
        $all = @($try.Parent.Statements); $i = [array]::IndexOf($all, $try)
        if ($i -ge 3) { $prev = @($all[($i - 3)..($i - 1)] | ForEach-Object { $_.Extent.Text }) }
        $text = $try.Extent.Text
      } else { $text = $x.Parent.Parent.Extent.Text }
      $sites.Add([ordered]@{ file = [string]$f; line = [int]$x.Extent.StartLineNumber; start = [string]$text; prev = [string[]]$prev })
    }
  }
}
ConvertTo-Json -InputObject $sites.ToArray() -Depth 4 -Compress`);
  assert.equal(r.status, 0, r.out);
  const sites = [JSON.parse(r.lines.at(-1))].flat().map(s => ({ ...s, file: path.relative(REPO, s.file).replaceAll('\\', '/') }));
  for (const f of ['windows/first-install-host.ps1', 'windows/install-resident.ps1', 'reinstall/tools/place-app-key.ps1', 'windows/prepare-companion-account.ps1']) {
    assert.ok(sites.some(s => s.file === `work/independent-ci-resident-v1/${f}`), `${f}: a start with a redirected stdin is seen (${sites.map(s => s.file).join(', ')})`);
  }
  for (const s of sites) {
    const at = `${s.file}:${s.line}`;
    assert.ok(s.start !== null, `${at}: redirects stdin but no [Diagnostics.Process]::Start($psi) is found`);
    assert.match(s.start, NO_BOM_START, `${at}: the start is not the guarded one (try { $p = [Diagnostics.Process]::Start($psi) } finally { ...SetValue($null, $was)... })`);
    assert.deepEqual(s.prev, NO_BOM_GUARD, `${at}: the three guard lines are not right before the start`);
  }
});

// The secret-fingerprint children, each the real function (taken by AST, or first-install-host.ps1 dot-sourced), with the real node and a
// stand-in tool that answers the bytes it got on stdin as hex; the console's input encoding put in the code page 65001 state on any machine.
const FP_STANDIN = `const chunks = []; for await (const c of process.stdin) chunks.push(c);
process.stdout.write(JSON.stringify({ kind: process.argv[2], fingerprint: Buffer.concat(chunks).toString('hex') }) + '\\n');\n`;
const SECRET = 'clued-test-secret-on-stdin\n';
const UTF8_CONSOLE = `[Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static').SetValue($null, [Text.Encoding]::UTF8)
if ([Console]::InputEncoding.GetPreamble().Length -ne 3) { throw 'NOT_A_UTF8_CONSOLE_ENCODING_WITH_A_BOM' }`;
const functionsFrom = (file, names) => `$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(file)}, [ref]$tokens, [ref]$errors)
foreach ($name in @(${names.map(psLiteral).join(', ')})) {
  $f = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq $name }, $true))
  if ($f.Count -ne 1) { throw ('FUNCTION_MISSING:' + $name) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}`;
function fingerprintStdin(t, body) {
  const dir = tempDir(t, 'stdin-bytes-');
  const tool = path.join(dir, 'secret-fingerprint.mjs'); fs.writeFileSync(tool, FP_STANDIN, 'utf8');
  const r = ps(`$ErrorActionPreference = 'Stop'
$tNode = ${psLiteral(process.execPath)}; $tTool = ${psLiteral(tool)}; $tDir = ${psLiteral(dir)}; $secret = [Text.Encoding]::ASCII.GetBytes(${psLiteral(SECRET)})
${UTF8_CONSOLE}
${body}`);
  assert.equal(r.status, 0, r.out);
  const line = r.lines.find(l => l.startsWith('FP=')) ?? '';
  assert.equal(line.slice(3), Buffer.from(SECRET, 'ascii').toString('hex'), `the tool's stdin holds the secret's bytes and nothing before them\n${r.out}`);
}

test('first-install-host.ps1 Get-SecretFingerprint on a UTF-8 console: the secret reaches the tool byte for byte, no BOM', { skip, timeout: 300_000 }, (t) => {
  fingerprintStdin(t, `. ${psLiteral(path.join(RES, 'windows', 'first-install-host.ps1'))}
$script:NodeExe = $tNode; $script:FingerprintTool = $tTool
'FP=' + (Get-SecretFingerprint $secret 'ci-token')`);
});

test('install-resident.ps1 Get-SecretFingerprint on a UTF-8 console: the secret reaches the tool byte for byte, no BOM', { skip, timeout: 300_000 }, (t) => {
  fingerprintStdin(t, `${functionsFrom(path.join(RES, 'windows', 'install-resident.ps1'), ['Get-SecretFingerprint'])}
$pkgBytes = [Text.Encoding]::UTF8.GetBytes('{"files":[{"target":"resident\\\\${'a'.repeat(64)}\\\\tools\\\\secret-fingerprint.mjs"}]}')
function Read-PackageRecordFile([string]$target) { if ($target -ceq 'runtime\\node.exe') { , [IO.File]::ReadAllBytes($tNode) } else { , [IO.File]::ReadAllBytes($tTool) } }
function New-SecretWorkDirectory([string]$parent, [string]$sddl) { $d = Join-Path $tDir ('w' + [guid]::NewGuid().ToString('N')); [void][IO.Directory]::CreateDirectory($d); $d }
function Write-New([string]$path, [byte[]]$bytes) { [IO.File]::WriteAllBytes($path, $bytes) }
$SecretWorkParent = $tDir; $SecretWorkSddl = ''
'FP=' + (Get-SecretFingerprint 'ci-token' $secret)`);
});

test('place-app-key.ps1 Get-AppKeyFingerprint on a UTF-8 console: the key reaches the tool byte for byte, no BOM', { skip, timeout: 300_000 }, (t) => {
  fingerprintStdin(t, `${functionsFrom(path.join(RES, 'reinstall', 'tools', 'place-app-key.ps1'), ['Get-AppKeyFingerprint'])}
$nodeBytes = [IO.File]::ReadAllBytes($tNode); $toolBytes = [IO.File]::ReadAllBytes($tTool)
function New-WorkDirectory { $d = Join-Path $tDir ('w' + [guid]::NewGuid().ToString('N')); [void][IO.Directory]::CreateDirectory($d); $d }
'FP=' + (Get-AppKeyFingerprint $secret)`);
});
