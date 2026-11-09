import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const relayUrl = new URL('../worker/protected-job-bridge-v4/relay-public.ps1', import.meta.url);
const helperUrl = new URL('../../../independent-ci-resident-v1/windows/wsl-client.ps1', import.meta.url);

test('Source relay embeds the same reviewed machine WSL trust validator and has no inbox stub fallback', async () => {
  const [relay, helper] = await Promise.all([fs.readFile(relayUrl, 'utf8'), fs.readFile(helperUrl, 'utf8')]);
  const body = helper.slice(helper.indexOf('function Get-CluedMachineWslClient {')).trim().replaceAll('\r\n', '\n');
  const embedded = relay.slice(relay.indexOf('function Get-CluedMachineWslClient {'), relay.indexOf('# END fixed machine WSL validator.')).trim().replaceAll('\r\n', '\n');
  assert.equal(embedded, body, 'Registrar, companion and standalone relay must make the same trust decision');
  assert.equal(relay.includes('C:\\Windows\\System32\\wsl.exe'), false);
  assert.equal((relay.match(/\$WslClient=Get-CluedMachineWslClient/g) ?? []).length, 1);
  assert.equal((relay.match(/\$psi\.FileName=/g) ?? []).length, 1);
  const validated = relay.indexOf('$WslClient=Get-CluedMachineWslClient');
  assert.ok(validated > relay.indexOf("throw 'ACCEPTED_SOURCE_CHANGED'"), 'the relay checks its accepted Source before using embedded code');
  assert.ok(validated < relay.indexOf('$psi.FileName=[string]$WslClient.path'));
  assert.ok(relay.indexOf('$psi.FileName=[string]$WslClient.path') < relay.indexOf('$proc.Start()'));
  assert.equal(relay.slice(0, relay.indexOf('Set-StrictMode')).includes('WslExe'), false, 'no caller-selected executable or trust flag');
  assert.ok(relay.includes("$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'"));
});

test('Source relay machine WSL changes parse in Windows PowerShell without executing the relay', { skip: process.platform !== 'win32' }, () => {
  const file = fileURLToPath(relayUrl).replaceAll("'", "''");
  const code = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){throw 'RELAY_PARSE_FAILED'}`;
  execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: 'pipe', windowsHide: true });
});
