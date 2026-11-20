// The companion's GitHub token in the first install (Fable ruling 11-19 renew-key, "包分支两处" B): the login script is the one writer of the
// companion's isolated gh configuration and needs gh's path from its caller (the companion configuration's ghExe, no default); it reads a
// token from standard input for the host preparation and checks the configuration offline (the shape the companion holds it to when it
// starts). Real functions under Windows PowerShell 5.1, taken by AST; no account, no dialog, no network, never a real token.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TREE_PREFIXES, isExcludedFromTree } from '../rollout/fleet/universal.mjs';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GL = path.join(RES, 'windows', 'companion-gh-login.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const FAKE = `ghp_${'Fake0'.repeat(7)}F`;   // the classic shape, 36 characters after ghp_; made up
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';

function ps(command, { input, args = [], env: extra = {} } = {}) {
  const env = { ...process.env, ...extra }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...(command === null ? args : ['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')])],
    { cwd: RES, env, input, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), out: `${r.stdout}\n${r.stderr}` };
}
const functionsOf = (file, names) => `$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(file)}, [ref]$tokens, [ref]$errors)
foreach ($name in @(${names.map(psLiteral).join(', ')})) {
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($f.Count -lt 1) { throw ('FUNCTION_MISSING:' + $name) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -ceq '$GithubTokenRx') { . ([scriptblock]::Create($a.Extent.Text)) }
}`;

test('the login script without -GhExe is a usage error (no default path)', { skip, timeout: 120_000 }, () => {
  const r = ps(null, { args: ['-File', GL, '-Check'] });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.stderr, /FullyQualifiedErrorId\s*:\s*GH_EXE_REQUIRED/, r.out);
  const src = fs.readFileSync(GL, 'utf8');
  assert.doesNotMatch(src, /\[string\]\$GhExe\s*=/, 'no default value for -GhExe');
});

test('a token from standard input: the classic shape only, never the clipboard', { skip, timeout: 120_000 }, () => {
  const read = ps(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2\n${functionsOf(GL, ['Read-LoginToken'])}
function Get-Clipboard { throw 'CLIPBOARD_READ' }
$t = Read-LoginToken $true; 'length ' + $t.Length + ' prefix ' + $t.Substring(0, 4)`, { input: `  ${FAKE}\r\n` });
  assert.equal(read.status, 0, read.out);
  assert.match(read.stdout, /length 40 prefix ghp_/, read.out);
  const bad = ps(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2\n${functionsOf(GL, ['Read-LoginToken'])}
try { $null = Read-LoginToken $true; 'read' } catch { $_.Exception.Message }`, { input: 'github_pat_not_classic' });
  assert.match(bad.stdout, /^STDIN_IS_NOT_A_CLASSIC_TOKEN/m, bad.out);
});

test('the isolated configuration offline: in place only with every part as the companion holds it', { skip, timeout: 300_000 }, (t) => {
  const prof = tempDir(t, 'gh-offline-');
  const run = (setup) => ps(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2\n${functionsOf(GL, ['Get-CompanionGhDirs', 'Get-CompanionGitConfig', 'Get-CompanionGhSddl', 'Get-CompanionGhOfflineState'])}
$profileDir = 'C:\\Users\\clued-companion'; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$dirs = Get-CompanionGhDirs ${psLiteral(prof)}
if (Test-Path -LiteralPath $dirs.base) { Remove-Item -LiteralPath $dirs.base -Recurse -Force }
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $dirs.base))
$sec = New-Object Security.AccessControl.DirectorySecurity; $sec.SetSecurityDescriptorSddlForm((Get-CompanionGhSddl $sid)); [void][IO.Directory]::CreateDirectory($dirs.base, $sec)
foreach ($d in @($dirs.gh, $dirs.home)) { [void][IO.Directory]::CreateDirectory($d) }
[IO.File]::WriteAllText((Join-Path $dirs.gh 'hosts.yml'), "github.com:\`n    oauth_token: ${FAKE}\`n    git_protocol: https\`n")
[IO.File]::WriteAllText((Join-Path $dirs.home '.gitconfig'), (Get-CompanionGitConfig $profileDir ${psLiteral(GH)}))
${setup}
$s = Get-CompanionGhOfflineState $dirs $sid $profileDir ${psLiteral(GH)}
'BAD=' + (@($s.bad) -join ',') + ' TOKEN=' + $s.token`);
  const ok = run('');
  assert.match(ok.stdout, /BAD= TOKEN=ghp_ \(classic, length 40\)/, ok.out);
  assert.doesNotMatch(ok.stdout, new RegExp(FAKE), 'the token itself is never printed');
  assert.match(run(`Remove-Item -LiteralPath (Join-Path $dirs.gh 'hosts.yml')`).stdout, /BAD=token TOKEN=missing/);
  assert.match(run(`[IO.File]::WriteAllText((Join-Path $dirs.gh 'hosts.yml'), "github.com:\`n    oauth_token: github_pat_x\`n")`).stdout, /BAD=token TOKEN=not-classic/);
  assert.match(run(`[IO.File]::WriteAllText((Join-Path $dirs.gh 'hosts.yml'), "example.com:\`n    oauth_token: ${FAKE}\`n")`).stdout, /BAD=token TOKEN=none/);
  assert.match(run(`[IO.File]::WriteAllText((Join-Path $dirs.home '.gitconfig'), 'x')`).stdout, /BAD=gitconfig /);
  assert.match(run(`Remove-Item -LiteralPath $dirs.home -Recurse -Force`).stdout, /BAD=folder,gitconfig /);
  assert.match(run(`$i = Get-Item -LiteralPath $dirs.base -Force; $a = $i.GetAccessControl('Access'); $a.SetAccessRuleProtection($false, $true); $i.SetAccessControl($a)`).stdout, /BAD=folder /);
});

// ---- the host preparation (first-install-host.ps1, dot-sourced: definitions only) around a stand-in login script that records each call
const HOST = path.join(RES, 'windows', 'first-install-host.ps1');
const STANDIN = `param([switch]$Login, [switch]$Check, [switch]$CopyFromOwner, [switch]$TokenFromStdin, [switch]$Offline, [string]$ProfileDirectory, [string]$AccountSid, [string]$GhExe)
$ErrorActionPreference = 'Stop'
$mode = if ($CopyFromOwner) { 'CopyFromOwner' } elseif ($Login) { 'Login' } else { 'Check' }
$flags = @(); if ($Offline) { $flags += 'Offline' }; if ($TokenFromStdin) { $flags += 'TokenFromStdin' }; if ($GhExe -cne 'C:\\Program Files\\GitHub CLI\\gh.exe') { $flags += 'NO-GH-EXE' }
Add-Content -LiteralPath (Join-Path $env:CLUED_TEST_DIR 'calls.txt') -Value ((@($mode) + $flags) -join ':')
Add-Content -LiteralPath (Join-Path $env:CLUED_TEST_DIR 'command-lines.txt') -Value ([Environment]::CommandLine)
if ($TokenFromStdin) { $in = [Console]::OpenStandardInput(); $ms = New-Object IO.MemoryStream; $in.CopyTo($ms); [IO.File]::WriteAllBytes((Join-Path $env:CLUED_TEST_DIR 'stdin.bin'), $ms.ToArray()) }
$state = Join-Path $env:CLUED_TEST_DIR 'in-place'
$answer = switch ($mode) {
  'Check' { if (Test-Path -LiteralPath $state) { @('COMPANION_GH_LOGIN_READY', 0) } else { @('COMPANION_GH_LOGIN_NOT_READY:token', 1) } }
  'CopyFromOwner' { $o = [string]$env:CLUED_TEST_OWNER; if ($o -ceq 'COPIED') { New-Item -ItemType File -Path $state | Out-Null; @('COMPANION_GH_LOGIN_COPIED', 0) } else { @(('COMPANION_GH_' + $o), 1) } }
  'Login' { New-Item -ItemType File -Path $state | Out-Null; @('COMPANION_GH_LOGIN_STORED', 0) }
}
'{"status":"' + $answer[0] + '"}'
exit $answer[1]`;
function hostRun(t, { inPlace = false, owner = 'OWNER_TOKEN_MISSING', tokenFile = null, body }) {
  const dir = tempDir(t, 'companion-host-');
  const gl = path.join(dir, 'companion-gh-login.ps1'); fs.writeFileSync(gl, STANDIN, 'utf8');
  if (inPlace) fs.writeFileSync(path.join(dir, 'in-place'), '');
  const cred = path.join(dir, 'credentials'); fs.mkdirSync(cred);
  if (tokenFile !== null) fs.writeFileSync(path.join(cred, 'companion-github.token'), tokenFile);
  const r = ps(`$ErrorActionPreference = 'Stop'\n. ${psLiteral(HOST)}
$script:CredentialList = Read-CredentialFiles (Join-Path ${psLiteral(path.dirname(HOST))} 'credential-files.json')
$gl = ${psLiteral(gl)}; $prof = 'C:\\Users\\clued-companion'; $sid = 'S-1-5-21-1-2-3-1008'; $GhExe = ${psLiteral(GH)}; $cred = ${psLiteral(cred)}
${body}`, { env: { CLUED_TEST_DIR: dir, CLUED_TEST_OWNER: owner } });
  const read = n => { const f = path.join(dir, n); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  return { ...r, lines: r.stdout.split(/\r?\n/).filter(Boolean), calls: (read('calls.txt') ?? '').split(/\r?\n/).filter(Boolean), commandLines: read('command-lines.txt') ?? '',
    stdin: fs.existsSync(path.join(dir, 'stdin.bin')) ? fs.readFileSync(path.join(dir, 'stdin.bin')) : null, written: fs.existsSync(path.join(dir, 'in-place')) };
}
const RESOLVE_AND_WRITE = `$src = Resolve-CompanionTokenSource $gl $prof $sid $GhExe
if ($src -ceq 'ask') { $token = Read-CompanionTokenInput $cred; Write-CompanionToken $gl $prof $sid $GhExe $token }
'SOURCE=' + $src`;

test('companion token in place in the companion profile: nothing asked, nothing written', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { inPlace: true, body: RESOLVE_AND_WRITE });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.lines.at(-1), 'SOURCE=in-place', r.out);
  assert.deepEqual(r.calls, ['Check:Offline'], 'only the offline check');
});

test('companion token: none in the companion profile, the Owner has one: copied, no dialog, then checked', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { owner: 'COPIED', body: `function Read-TokenFromDialog { throw 'DIALOG_OPENED' }\n${RESOLVE_AND_WRITE}` });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.lines.at(-1), 'SOURCE=owner-copied', r.out);
  assert.deepEqual(r.calls, ['Check:Offline', 'CopyFromOwner', 'Check:Offline']);
});

test('companion token: neither, the credential directory has companion-github.token: given on stdin, never on a command line', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { tokenFile: `${FAKE}\n`, body: RESOLVE_AND_WRITE });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.lines.at(-1), 'SOURCE=ask', r.out);
  assert.deepEqual(r.calls, ['Check:Offline', 'CopyFromOwner', 'Login:TokenFromStdin', 'Check:Offline']);
  assert.equal(r.stdin.toString('utf8'), FAKE, 'the token reaches the login script on its standard input');
  assert.ok(!r.commandLines.includes(FAKE) && !r.commandLines.includes('ghp_'), 'no command line carries the token');
});

// On a UTF-8 console (code page 65001: the CI runner's, a UTF-8 terminal's) Windows PowerShell 5.1's Console.InputEncoding is a UTF-8
// with a BOM, and Process.Start writes that BOM into a redirected stdin before any byte of ours (run 44705707829). The console's encoding
// is put in that state here on any machine, without touching the shared console: Console's cached field, what the getter returns.
test('companion token on a UTF-8 console: the token reaches the login script byte for byte, no BOM before it', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { tokenFile: `${FAKE}\n`, body: `[Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static').SetValue($null, [Text.Encoding]::UTF8)
if ([Console]::InputEncoding.GetPreamble().Length -ne 3) { throw 'NOT_A_UTF8_CONSOLE_ENCODING_WITH_A_BOM' }
${RESOLVE_AND_WRITE}` });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ['Check:Offline', 'CopyFromOwner', 'Login:TokenFromStdin', 'Check:Offline']);
  assert.deepEqual([...r.stdin], [...Buffer.from(FAKE, 'utf8')], 'the bytes on the login script\'s standard input are the token\'s, nothing before them');
});

test('companion token: none anywhere: refused in the credentials step by name, nothing written', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { body: `Enter-Step 'credentials'\n${RESOLVE_AND_WRITE}` });
  assert.equal(r.status, 1, r.out);
  const v = JSON.parse(r.lines.at(-1));
  assert.deepEqual([v.status, v.code, v.detail], ['FIRST_INSTALL_HOST_REFUSED', 'CREDENTIAL_MISSING', ['companionToken']], r.out);
  assert.deepEqual(JSON.parse(r.lines.at(-2)), { name: 'credentials', result: 'failed', rejectCode: 'CREDENTIAL_MISSING', detail: null });
  assert.deepEqual(r.calls, ['Check:Offline', 'CopyFromOwner'], 'no login: nothing written');
  assert.equal(r.written, false);
  const shape = hostRun(t, { tokenFile: 'github_pat_not_classic', body: RESOLVE_AND_WRITE });
  assert.equal(JSON.parse(shape.lines.at(-1)).code, 'CREDENTIAL_NOT_ITS_KIND', shape.out);
  assert.deepEqual(shape.calls, ['Check:Offline', 'CopyFromOwner']);
});

test('companion token: an Owner token the login script refuses to copy (a link) stops by name, never falls through', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { owner: 'OWNER_TOKEN_PATH_IS_A_LINK', tokenFile: `${FAKE}\n`, body: RESOLVE_AND_WRITE });
  assert.equal(r.status, 1, r.out);
  const v = JSON.parse(r.lines.at(-1));
  assert.deepEqual([v.code, v.detail.status], ['COMPANION_TOKEN_OWNER_COPY_REFUSED', 'COMPANION_GH_OWNER_TOKEN_PATH_IS_A_LINK'], r.out);
});

test('gh and Git for Windows: installed from the pinned installer when absent, and then at their paths, or refused by name', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { body: `foreach ($c in @(@('GH', $null, $true, @(3010)), @('GH', @{ exit = 0 }, $false, @(3010)), @('GH', @{ exit = 1603 }, $false, @(3010)), @('GH', @{ exit = 3010 }, $false, @(3010)),
    @('GIT', @{ exit = 0 }, $true, @(8)), @('GIT', @{ exit = 0 }, $false, @(8)), @('GIT', @{ exit = 8 }, $false, @(8)))) { 'CODE=' + [string](Get-ToolInstallCode $c[0] $c[1] $c[2] $c[3]) }` });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.lines.filter(l => l.startsWith('CODE=')), ['CODE=', 'CODE=GH_NOT_AT_THE_EXPECTED_PATH', 'CODE=GH_INSTALL_FAILED', 'CODE=RESTART', 'CODE=', 'CODE=GIT_NOT_AT_THE_EXPECTED_PATH', 'CODE=RESTART']);
  const text = fs.readFileSync(HOST, 'utf8');
  const main = text.slice(text.indexOf('function Invoke-HostPreparation'));
  assert.match(main, /Enter-Step 'tools'[\s\S]*msiexec\.exe' @\('\/i', \$staged\['gh'\][\s\S]*\$staged\['git-for-windows'\][\s\S]*Get-ToolInstallCode[\s\S]*Step 'tools'/, 'the tools step installs the staged pinned installers and checks the paths');
  assert.match(main, /foreach \(\$n in @\('node', 'ubuntu-rootfs', 'actions-runner', 'linux-node', 'wsl', 'gh', 'git-for-windows'\)\)/, 'both are staged and held to the manifest');
});

test('the kit\'s companion configuration is where gh\'s path comes from', { skip, timeout: 300_000 }, (t) => {
  const companion = Buffer.from(JSON.stringify({ companion: {}, ghExe: GH, repo: 'tdoljyj/cross-memory-system', status: {} })).toString('base64');
  const bad = Buffer.from(JSON.stringify({ companion: {}, ghExe: 'gh.exe' })).toString('base64');
  const r = hostRun(t, { body: `'GH=' + (Get-KitGhExe '${JSON.stringify({ config: { companion } })}')
try { $null = Get-KitGhExe '${JSON.stringify({ config: { companion: bad } })}'; 'ACCEPTED' } catch { 'REFUSED=' + $_.Exception.Message }` });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.lines.slice(-2), [`GH=${GH}`, 'REFUSED=KIT_GH_EXE_REFUSED'], r.out);
});

test('the first install accepts only COMPANION_ACCOUNT_PREPARED from the account-only script; token pending is refused', { skip, timeout: 300_000 }, (t) => {
  const r = hostRun(t, { body: `Enter-Step 'accounts'\n$null = Assert-CompanionPrepared ([ordered]@{ exit = 0; stdout = '{"status":"COMPANION_ACCOUNT_PREPARED_TOKEN_PENDING","error":null,"steps":{}}'; stderr = '' })` });
  assert.equal(r.status, 1, r.out);
  assert.equal(JSON.parse(r.lines.at(-1)).code, 'COMPANION_ACCOUNT_NOT_PREPARED', r.out);
  const text = fs.readFileSync(HOST, 'utf8');
  assert.match(text, /'-RegistrarSha256', \$RegistrarSha256, '-AccountOnly'[,)]/, 'the first install runs the account script account-only');
});

test('the drill\'s fake credential file names are all in the package\'s fixed list', { skip, timeout: 120_000 }, () => {
  // the package's list is data next to the script (windows/credential-files.json), in the archive (the tree takes windows/ whole)
  const data = JSON.parse(fs.readFileSync(path.join(RES, 'windows', 'credential-files.json'), 'utf8'));
  assert.equal(data.contract, 'clued.independent-ci.credential-files/1');
  assert.deepEqual(Object.keys(data).sort(), ['contract', 'optional', 'required']);
  assert.ok(TREE_PREFIXES.includes('work/independent-ci-resident-v1/windows/') && !isExcludedFromTree('work/independent-ci-resident-v1/windows/credential-files.json'), 'in the archive, next to the script');
  const names = [...Object.values(data.required), ...Object.values(data.optional)];
  assert.ok(names.includes('companion-github.token'), names.join(','));
  const entry = fs.readFileSync(path.join(RES, 'drill', 'first-install-entry.ps1'), 'utf8');
  // the fake inputs copied to the package's names: the list may run over several lines (drill-judgement wraps it), so the match spans them
  const pairs = /foreach \(\$pair in @\(([\s\S]*?)\)\) \{/.exec(entry)?.[1] ?? '';
  const given = [...pairs.matchAll(/@\('[^']+', '([^']+)'\)/g)].map(m => m[1]).concat([...entry.matchAll(/Join-Path \$inputCredentials '([^']+)'/g)].map(m => m[1]));
  assert.ok(given.length >= 4, given.join(','));
  for (const g of given) assert.ok(names.includes(g), `the drill writes ${g}, which the package does not read (${names.join(', ')})`);
});
