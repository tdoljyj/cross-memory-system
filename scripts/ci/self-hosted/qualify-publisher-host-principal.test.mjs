import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const sourcePath = fileURLToPath(new URL('./qualify-publisher-host-principal.ps1', import.meta.url));
const sourceSha = createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
const windows = process.platform === 'win32';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const nativeEnvironment = () => ({ ...process.env,
  PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'),
});

function runCase(body) {
  const parent = path.resolve(path.dirname(sourcePath), '../../../../cause/trace-20261018/vm-tests');
  fs.mkdirSync(parent, { recursive: true });
  const folder = fs.mkdtempSync(path.join(parent, 'principal-'));
  const scriptPath = path.join(folder, 'test.ps1');
  const script = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourcePath = ${quote(sourcePath)}
$expectedSha = ${quote(sourceSha)}
if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedSha) { throw 'Probe source changed during test.' }
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Probe parse errors.' }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $definition.Extent.Text }
foreach ($assignment in $ast.EndBlock.Statements) {
    if ($assignment -is [Management.Automation.Language.AssignmentStatementAst] -and
        $assignment.Left.Extent.Text -cin @('$script:ExpectedSid', '$script:ExpectedHost', '$script:TaskPrefix', '$script:SchemaPrefix', '$script:WslPath', '$script:ExpectedWslVersion')) { Invoke-Expression $assignment.Extent.Text }
}
$script:QualificationRoot = ${quote(folder)}
$script:PowerShellPath = [IO.Path]::Combine($PSHOME, 'powershell.exe')
$script:SourcePath = $sourcePath
$script:Budget = [Diagnostics.Stopwatch]::StartNew()
$fixtureGitHub=[ordered]@{repository='tdoljyj/cross-memory-system';run_id='12345';run_attempt='1';job_key='host-principal-probe';provider_job_id='UNKNOWN';sha=('a'*40);workflow_ref='tdoljyj/cross-memory-system/.github/workflows/clued-production-publisher-host-qualification.yml@refs/pull/42/merge';runner_name='clued-ci-company-win-01';event_name='pull_request';ref='refs/pull/42/merge';repository_owner='tdoljyj';actor='tdoljyj';triggering_actor='tdoljyj';pull_request_author='tdoljyj';pull_request_number='42';pull_request_head_sha=('b'*40);pull_request_base_sha=('c'*40);pull_request_base_ref='main';pull_request_head_ref='qualification-fixture';provenance='workflow_environment_and_event_observation; not cryptographic admission'}
$fixtureIdentity=[ordered]@{host=$script:ExpectedHost;account='fixture-account';sid=$script:ExpectedSid;session_id=0;administrator_token_member=$false;hyper_v_token_member=$false}
function New-PhaseFixture([string]$Phase,[string]$Result,[guid]$Id) {
    return ([ordered]@{schema=$script:SchemaPrefix+'.'+$Phase+'/1';qualification_id=$Id.ToString('D');result=$Result;production_qualified=$false;source_sha256=$expectedSha;github=$fixtureGitHub;identity=$fixtureIdentity}|ConvertTo-Json -Depth 14|ConvertFrom-Json)
}
$checks = New-Object 'Collections.Generic.List[string]'
function Check([bool]$Condition, [string]$Name) { if (-not $Condition) { throw ('Assertion failed: ' + $Name) }; $checks.Add($Name) }
function Reject([scriptblock]$Code, [string]$Pattern, [string]$Name) {
    $caught = $null; try { & $Code | Out-Null } catch { $caught = $_ }
    if ($null -eq $caught -or $caught.Exception.Message -notmatch $Pattern) { throw ('Expected rejection: ' + $Name + '; actual=' + $caught) }; $checks.Add($Name)
}
function Adapt-OnlyPathLiteral([string]$Name, [string]$Original, [string]$Replacement) {
    $function = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name }, $true))
    if ($function.Count -ne 1) { throw 'Ambiguous function adapter.' }
    $literal = @($function[0].FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value -ceq $Original }, $true))
    if ($literal.Count -ne 1) { throw 'Adapter must replace exactly one declared path constant.' }
    $text = $function[0].Extent.Text
    $offset = $literal[0].Extent.StartOffset - $function[0].Extent.StartOffset
    $text = $text.Remove($offset, $literal[0].Extent.Text.Length).Insert($offset, "'" + $Replacement.Replace("'", "''") + "'")
    # Only the fixed filesystem location changes; the actual function body and
    # exception/result logic execute against isolated test files.
    return $text
}
${body}
@{ schema = 'clued.publisher-principal.boundary-test/1'; source_sha256 = $expectedSha; checks = @($checks.ToArray()); powershell = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Depth 6 -Compress
`;
  fs.writeFileSync(scriptPath, script, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    env: nativeEnvironment(), encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nFixture: ${folder}`);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).findLast(line => line.startsWith('{')));
  assert.equal(report.source_sha256, sourceSha);
  assert.match(report.powershell, /^5\.1\./u);
  assert.ok(report.checks.length > 0);
  return report;
}

test('installed Host and registered Guest Source retain exact gates and isolated routes', () => {
  const require = createRequire(new URL('../../../apps/clued-cloud/package.json', import.meta.url));
  const yaml = require('yaml');
  const workflows = ['host', 'guest'].map(kind => {
    const file = `.github/workflows/clued-production-publisher-${kind}-qualification.yml`;
    const location = new URL(`../../../${file}`, import.meta.url);
    if (fs.existsSync(location)) return yaml.parse(fs.readFileSync(location, 'utf8'));
    assert.equal(kind, 'guest');
    const registry = JSON.parse(fs.readFileSync(new URL('../clued-publisher-qualification-sources.json', import.meta.url), 'utf8'));
    const entry = registry.workflows[file];
    assert.equal(entry.registration_status, 'registered');
    const accepted = entry.sources.find(row => row.source_sha256 === '2c96918d9a14bbadca4a5e247bafcf741290a3ee2c75d13e2acacc800b04ad44');
    assert.equal(accepted.registration_status, 'registered');
    assert.equal(accepted.proof_classification, 'qualification_only');
    assert.equal(createHash('sha256').update(accepted.source_yaml).digest('hex'), accepted.source_sha256);
    return yaml.parse(accepted.source_yaml);
  });
  assert.deepEqual(workflows[0].jobs['admission-gate'], workflows[1].jobs['admission-gate']);
  assert.equal(fs.existsSync(new URL('../../../.github/workflows/clued-production-publisher-qualification.yml', import.meta.url)), false);
  for (const workflow of workflows) {
  assert.deepEqual(Object.keys(workflow.on), ['pull_request']);
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(Object.keys(workflow.jobs).length, 2);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(Array.isArray(job['runs-on']) && job['runs-on'].includes('self-hosted'), name);
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 12, name);
    assert.equal(job.environment, undefined, name);
    if (name !== 'admission-gate') {
      assert.match(job.if, /github\.event_name == 'pull_request'/u, name);
      assert.match(job.if, /pull_request\.base\.ref == 'main'/u, name);
      assert.match(job.if, /pull_request\.head\.repo\.full_name == github\.repository/u, name);
      assert.match(job.if, /pull_request\.base\.repo\.full_name == github\.repository/u, name);
      assert.match(job.if, /pull_request\.user\.login == github\.repository_owner/u, name);
      assert.match(job.if, /github\.actor == github\.repository_owner/u, name);
      assert.match(job.if, /github\.triggering_actor == github\.repository_owner/u, name);
      assert.equal(job.needs, 'admission-gate');
      assert.match(job.if, /outputs\.admitted == 'true'/u);
    }
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/')) assert.match(step.uses, /@[0-9a-f]{40}$/u);
      assert.ok(!step.uses?.includes('upload-artifact') && !step.uses?.includes('cache'), name);
      assert.doesNotMatch(JSON.stringify(step), /secrets\.|SUPABASE_SERVICE_ROLE|CLOUDFLARE_API_TOKEN/u);
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      if (name !== 'admission-gate' && step.uses?.startsWith('actions/checkout@')) assert.equal(step.with.ref, '${{ github.event.pull_request.head.sha }}');
    }
  }
  const gateCheckout = workflow.jobs['admission-gate'].steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(gateCheckout.with.ref, '${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}');
  }
  assert.equal(workflows[0].name, 'Clued production publisher Host qualification');
  assert.equal(workflows[1].name, 'Clued production publisher Guest qualification');
  assert.ok(workflows[0].jobs['host-principal-probe']['runs-on'].includes('site-company'));
  assert.ok(workflows[1].jobs.qualify['runs-on'].some(label => label.includes('github.run_id') && label.includes('github.run_attempt')));
});

test('actual interactive principal is refused at the complete entrypoint before CI or scheduler work', { skip: !windows }, context => {
  // Never execute a complete probe under its real accepted CI identity. These
  // entrypoint cases are permitted only when an independent SID read proves
  // that the actual identity must fail before workflow or lifecycle handling.
  const identity = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], {
    env: nativeEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  assert.equal(identity.error, undefined);
  assert.equal(identity.status, 0, identity.stderr);
  const sid = identity.stdout.trim();
  assert.match(sid, /^S-1-[0-9-]+$/u);
  const expectedSid = fs.readFileSync(sourcePath, 'utf8').match(/\$script:ExpectedSid = '([^']+)'/u)?.[1];
  assert.ok(expectedSid);
  if (sid === expectedSid) {
    context.skip('Full entrypoint wrong-SID test cannot run under the actual accepted CI principal.');
    return;
  }
  for (const mode of ['Inventory', 'S4UCanary']) {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sourcePath,
      '-Mode', mode, '-QualificationId', '8dac5958-7f08-4ae7-a7b1-dc841b86be97'], {
      env: nativeEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 20, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.result, 'REFUSED_OR_UNKNOWN');
    assert.equal(report.production_qualified, false);
    assert.equal(report.mode, mode);
    assert.equal(report.error.error_id, 'WRONG_WINDOWS_PRINCIPAL');
  }
});

test('principal and workflow context guards reject privilege, identity, session, and binding mismatches', { skip: !windows }, () => {
  const report = runCase(String.raw`
$identity = [pscustomobject]@{host=$script:ExpectedHost;sid=$script:ExpectedSid;session_id=0;administrator_token_member=$false;hyper_v_token_member=$false}
Assert-ProbeIdentity $identity
Check $true 'exact nonprivileged session-zero identity accepted by pure guard'
foreach ($field in @('host','sid','session_id','administrator_token_member','hyper_v_token_member')) {
    $copy = $identity | ConvertTo-Json | ConvertFrom-Json
    if ($field -in @('administrator_token_member','hyper_v_token_member')) { $copy.$field = $true }
    elseif ($field -eq 'session_id') { $copy.$field = 1 } else { $copy.$field = 'wrong' }
    Reject { Assert-ProbeIdentity $copy } 'WRONG_|PRIVILEGED_|SESSION_ZERO' ('identity mismatch refused: ' + $field)
}
$valid = @{
    GITHUB_ACTIONS='true';GITHUB_REPOSITORY='tdoljyj/cross-memory-system';RUNNER_NAME='clued-ci-company-win-01';RUNNER_OS='Windows';RUNNER_ARCH='X64'
    GITHUB_EVENT_NAME='pull_request';GITHUB_REF='refs/pull/42/merge';GITHUB_RUN_ID='12345';GITHUB_RUN_ATTEMPT='1';GITHUB_JOB='host-principal-probe'
    GITHUB_REPOSITORY_OWNER='tdoljyj';GITHUB_ACTOR='tdoljyj';GITHUB_TRIGGERING_ACTOR='tdoljyj';GITHUB_BASE_REF='main';GITHUB_HEAD_REF='qualification-fixture'
    GITHUB_SHA=('a'*40);GITHUB_WORKFLOW_REF='tdoljyj/cross-memory-system/.github/workflows/clued-production-publisher-host-qualification.yml@refs/pull/42/merge'
    GITHUB_EVENT_PATH=[IO.Path]::Combine($script:QualificationRoot,'event.json')
}
$repository=[ordered]@{id=123;full_name='tdoljyj/cross-memory-system';owner=@{login='tdoljyj'};fork=$false}
$validEvent=[ordered]@{action='synchronize';number=42;repository=$repository;sender=@{login='tdoljyj'};pull_request=@{number=42;user=@{login='tdoljyj'};merge_commit_sha=('a'*40);head=@{sha=('b'*40);ref='qualification-fixture';repo=$repository};base=@{sha=('c'*40);ref='main';repo=$repository}}}
[IO.File]::WriteAllText($valid.GITHUB_EVENT_PATH,($validEvent|ConvertTo-Json -Depth 10))
foreach ($key in $valid.Keys) { [Environment]::SetEnvironmentVariable($key,$valid[$key],'Process') }
$context = Get-ProbeGitHubContext
Check ($context.sha -ceq ('a'*40) -and $context.pull_request_head_sha -ceq ('b'*40) -and $context.pull_request_base_sha -ceq ('c'*40) -and $context.provider_job_id -ceq 'UNKNOWN' -and $context.provenance -match 'not cryptographic admission') 'actual merge, head and base remain separate observations without authentication claim'
foreach ($key in $valid.Keys) {
    [Environment]::SetEnvironmentVariable($key,'invalid value','Process')
    Reject { Get-ProbeGitHubContext } '.' ('workflow context mismatch refused: ' + $key)
    [Environment]::SetEnvironmentVariable($key,$valid[$key],'Process')
}
foreach($mode in @('fork','repository-id','author','sender','pr-number','base-ref','head-ref','head-source','merge-source','action','missing-pr','string-fork')) {
    $copy=$validEvent|ConvertTo-Json -Depth 10|ConvertFrom-Json
    switch($mode) {
        fork {$copy.pull_request.head.repo.fork=$true}
        repository-id {$copy.pull_request.head.repo.id=456}
        author {$copy.pull_request.user.login='another-user'}
        sender {$copy.sender.login='another-user'}
        pr-number {$copy.pull_request.number=43}
        base-ref {$copy.pull_request.base.ref='other'}
        head-ref {$copy.pull_request.head.ref='other'}
        head-source {$copy.pull_request.head.sha='wrong'}
        merge-source {$copy.pull_request.merge_commit_sha='b'*40}
        action {$copy.action='closed'}
        missing-pr {$copy.PSObject.Properties.Remove('pull_request')}
        string-fork {$copy.pull_request.head.repo.fork='false'}
    }
    [IO.File]::WriteAllText($valid.GITHUB_EVENT_PATH,($copy|ConvertTo-Json -Depth 10))
    Reject { Get-ProbeGitHubContext } '.' ('actual PR event mismatch refused: '+$mode)
}
[IO.File]::WriteAllText($valid.GITHUB_EVENT_PATH,('x'*1048577))
Reject { Get-ProbeGitHubContext } 'EVENT_SIZE_INVALID' 'oversized actual event refused before parsing'
[IO.File]::WriteAllText($valid.GITHUB_EVENT_PATH,'not-json')
Reject { Get-ProbeGitHubContext } '.' 'malformed actual event refused'
`);
  assert.equal(report.checks.length, 39);
});

test('PR binding diagnostic is bounded, fixed-field and never echoes malformed values', { skip: !windows }, () => {
  const report = runCase(String.raw`
$valid=@{GITHUB_ACTIONS='true';GITHUB_REPOSITORY='tdoljyj/cross-memory-system';GITHUB_REPOSITORY_OWNER='tdoljyj';GITHUB_ACTOR='tdoljyj';GITHUB_TRIGGERING_ACTOR='tdoljyj';RUNNER_NAME='clued-ci-company-win-01';RUNNER_OS='Windows';RUNNER_ARCH='X64';GITHUB_EVENT_NAME='pull_request';GITHUB_JOB='host-principal-probe';GITHUB_SHA=('a'*40);GITHUB_BASE_REF='main';GITHUB_HEAD_REF='qualification-fixture';GITHUB_REF='refs/pull/42/merge';GITHUB_WORKFLOW_REF='tdoljyj/cross-memory-system/.github/workflows/clued-production-publisher-host-qualification.yml@refs/pull/42/merge';GITHUB_RUN_ID='12345';GITHUB_RUN_ATTEMPT='1'}
foreach($key in $valid.Keys){[Environment]::SetEnvironmentVariable($key,$valid[$key],'Process')}
$repository=[ordered]@{id=123;full_name='tdoljyj/cross-memory-system';owner=@{login='tdoljyj'};fork=$false}
$validEvent=[ordered]@{action='synchronize';number=42;repository=$repository;sender=@{login='tdoljyj'};pull_request=@{number=42;user=@{login='tdoljyj'};merge_commit_sha=('a'*40);head=@{sha=('b'*40);ref='qualification-fixture';repo=$repository};base=@{sha=('c'*40);ref='main';repo=$repository}}}
function Read-ProbePullRequestEvent { return $script:FixtureEvent }
$expectedKeys=@('schema','event_base_is_main','environment_base_is_main','head_is_string','head_length_allowed','head_ref_matches','merge_equals_execution','merge_field_kind','execution_sha','event_head_sha','event_base_sha','event_merge_sha','production_qualified')
foreach($mode in @('base-ref','environment-base','head-int','head-empty','head-long','head-object','head-ref','merge-null','merge-missing','merge-other')) {
    $script:FixtureEvent=$validEvent|ConvertTo-Json -Depth 10|ConvertFrom-Json
    $field='merge_equals_execution'
    switch($mode) {
        base-ref {$script:FixtureEvent.pull_request.base.ref='private-base-ref';$field='event_base_is_main'}
        environment-base {$env:GITHUB_BASE_REF='private-environment-ref';$field='environment_base_is_main'}
        head-int {$script:FixtureEvent.pull_request.head.ref=42;$field='head_is_string'}
        head-empty {$script:FixtureEvent.pull_request.head.ref='';$field='head_length_allowed'}
        head-long {$script:FixtureEvent.pull_request.head.ref='private-head-ref'*500;$field='head_length_allowed'}
        head-object {$script:FixtureEvent.pull_request.head.ref=[pscustomobject]@{private='private-event-body'};$field='head_is_string'}
        head-ref {$script:FixtureEvent.pull_request.head.ref='private-head-ref';$field='head_ref_matches'}
        merge-null {$script:FixtureEvent.pull_request.merge_commit_sha=$null}
        merge-missing {$script:FixtureEvent.pull_request.PSObject.Properties.Remove('merge_commit_sha')}
        merge-other {$script:FixtureEvent.pull_request.merge_commit_sha='d'*40}
    }
    $caught=$null;try{Get-ProbeGitHubContext|Out-Null}catch{$caught=$_}
    Check ($null -ne $caught -and $caught.Exception -is [InvalidOperationException] -and $caught.Exception.Message -ceq 'PULL_REQUEST_HEAD_BASE_MERGE_BINDING_REQUIRED') ('binding mismatch still refused: '+$mode)
    $diagnostic=$caught.Exception.Data['clued.pr_binding_diagnostic']
    Check ($diagnostic[$field] -is [bool] -and -not $diagnostic[$field]) ('separate false predicate: '+$mode)
    Check (($diagnostic.Keys -join ',') -ceq ($expectedKeys -join ',')) ('exact diagnostic allowlist: '+$mode)
    $json=$diagnostic|ConvertTo-Json -Depth 4 -Compress
    Check ([Text.Encoding]::UTF8.GetByteCount($json) -le 1024 -and $json -cnotmatch 'private-' -and $diagnostic.production_qualified -eq $false) ('bounded and private values omitted: '+$mode)
    $env:GITHUB_BASE_REF='main'
}
foreach($mode in @('null','upper','newline','crlf','private','integer','array','object','valid')) {
    $pr=($validEvent|ConvertTo-Json -Depth 10|ConvertFrom-Json).pull_request
    switch($mode) {
        null {$pr.merge_commit_sha=$null}
        upper {$pr.merge_commit_sha='A'*40}
        newline {$pr.merge_commit_sha=('a'*40)+[char]10}
        crlf {$pr.merge_commit_sha=('a'*40)+[char]13+[char]10}
        private {$pr.merge_commit_sha='private-token-body'}
        integer {$pr.merge_commit_sha=42}
        array {$pr.merge_commit_sha=@('a'*40)}
        object {$pr.merge_commit_sha=[pscustomobject]@{private='private-body'}}
        valid {$pr.merge_commit_sha='d'*40}
    }
    $diagnostic=Get-ProbePullRequestBindingDiagnostic $pr
    $kind=$(if($mode -ceq 'valid'){'valid_sha'}elseif($mode -ceq 'null'){'null'}else{'invalid'})
    Check ($diagnostic.merge_field_kind -ceq $kind) ('merge field kind: '+$mode)
    Check (($mode -ceq 'valid' -and $diagnostic.event_merge_sha -ceq ('d'*40)) -or ($mode -cne 'valid' -and $null -eq $diagnostic.event_merge_sha)) ('only lowercase SHA value included: '+$mode)
    $json=$diagnostic|ConvertTo-Json -Depth 4 -Compress
    Check ([Text.Encoding]::UTF8.GetByteCount($json) -le 1024 -and $json -cnotmatch 'private-|A{40}') ('invalid values absent: '+$mode)
}
foreach($value in @(('A'*40),'private-value',42,@(('a'*40)),[pscustomobject]@{private='private-body'})) {
    Check ($null -eq (ConvertTo-ProbeDiagnosticSha $value)) 'SHA projection never coerces or enumerates arbitrary values'
}
`);
  assert.equal(report.checks.length, 72);
});

test('loaded profile guard requires exact own metadata and actual Boolean values', { skip: !windows }, () => {
  const report = runCase(String.raw`
$profile=[pscustomobject]@{profile_api_path='C:\Users\clued-runner';row_count=1;row_sid=$script:ExpectedSid;loaded=$true;special=$false;local_path='C:\Users\clued-runner';profilelist_path='C:\Users\clued-runner';hku_present=$true;profile_owner_sid=$script:ExpectedSid;no_reparse_chain=$true;ancestor_owner_acl_safe=$true;profile_acl_safe=$true}
Check (Test-ProbeLoadedProfile $profile) 'complete synthetic profile matches; no target positive implied'
foreach($field in @('profile_api_path','row_sid','local_path','profilelist_path','profile_owner_sid')) {
    $bad=$profile|ConvertTo-Json|ConvertFrom-Json;$bad.$field='wrong'
    Check (-not (Test-ProbeLoadedProfile $bad)) ('profile identity mismatch refused: '+$field)
    $bad.$field=@($profile.$field,'unexpected-extra-value')
    Check (-not (Test-ProbeLoadedProfile $bad)) ('matching member of a multi-value array refused: '+$field)
    $bad.$field=@($profile.$field)
    Check (-not (Test-ProbeLoadedProfile $bad)) ('single-element array refused: '+$field)
    $bad.$field=42
    Check (-not (Test-ProbeLoadedProfile $bad)) ('non-string identity refused: '+$field)
    $bad.$field=$null
    Check (-not (Test-ProbeLoadedProfile $bad)) ('missing string identity refused: '+$field)
}
foreach($value in @(0,2,'1',[long]1)) {
    $bad=$profile|ConvertTo-Json|ConvertFrom-Json;$bad.row_count=$value
    Check (-not (Test-ProbeLoadedProfile $bad)) 'row count must be exactly one Int32'
}
foreach($field in @('loaded','hku_present','no_reparse_chain','ancestor_owner_acl_safe','profile_acl_safe')) {
    foreach($value in @($false,'true',$null)) {
        $bad=$profile|ConvertTo-Json|ConvertFrom-Json;$bad.$field=$value
        Check (-not (Test-ProbeLoadedProfile $bad)) ('missing, false or coerced profile fact refused: '+$field)
    }
}
foreach($value in @($true,'false',$null)) {
    $bad=$profile|ConvertTo-Json|ConvertFrom-Json;$bad.special=$value
    Check (-not (Test-ProbeLoadedProfile $bad)) 'special profile flag must be Boolean false'
}
`);
  assert.equal(report.checks.length, 48);
});

test('loaded profile observer refuses a wrong-actor fixture before any metadata read', { skip: !windows }, () => {
  const report = runCase(String.raw`
$script:metadataCalls=0
function Get-ProbeIdentity { return [ordered]@{host=$script:ExpectedHost;sid='S-1-0-0';session_id=0;administrator_token_member=$false;hyper_v_token_member=$false} }
function Get-CimInstance { $script:metadataCalls++; throw 'UNEXPECTED_PROFILE_METADATA_QUERY' }
$result=Get-ProbeLoadedProfileEvidence
Check ($result.result -ceq 'UNKNOWN') 'wrong actor remains UNKNOWN'
Check ($result.error.error_id -ceq 'WRONG_WINDOWS_PRINCIPAL') 'original identity refusal retained'
Check ($script:metadataCalls -eq 0) 'no target CIM query follows wrong-actor fixture'
Check (-not $result.production_qualified -and -not $result.target_operations_authorized) 'observation grants no execution authority'
`);
  assert.equal(report.checks.length, 4);
});

test('loaded profile observation is an Inventory prerequisite without adding mutating or callback paths', { skip: !windows }, () => {
  const report = runCase(String.raw`
$observer=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-ProbeLoadedProfileEvidence'},$true))
Check ($observer.Count -eq 1) 'one profile observer definition'
$calls=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Get-ProbeLoadedProfileEvidence'},$true))
Check ($calls.Count -eq 1) 'one main Inventory call, no callback/S4U call'
$text=[IO.File]::ReadAllText($sourcePath)
Check ($text.Contains('$observed = ($profile.result -ceq ''OBSERVED''') -and $text.Contains('loaded_profile = $profile;')) 'Inventory verdict depends on and returns profile evidence'
Check ($observer[0].Extent.Text.Contains('timeout_is_hard_deadline = $false') -and -not ($observer[0].Extent.Text -match 'CreateSubKey|Set-Acl|WriteAllText|LoadUserProfile')) 'read-only metadata with honest CIM timeout boundary'
`);
  assert.equal(report.checks.length, 4);
});

test('qualification files are bounded, write-once, source-bound, and phase reports cannot claim production', { skip: !windows }, () => {
  const report = runCase(String.raw`
$id=[guid]::NewGuid();$folder=Get-QualificationFolder $id
[IO.Directory]::CreateDirectory($folder)|Out-Null
$request=[pscustomobject]@{schema=$script:SchemaPrefix+'.request/1';qualification_id=$id.ToString('D');expected_sid=$script:ExpectedSid;production_qualified=$false;source_sha256=(Get-ProbeSha256 $script:SourcePath);created_utc=[DateTime]::UtcNow.ToString('o');github=$fixtureGitHub}
Write-NewQualificationJson $folder 'request.json' $request
Check ((Read-QualificationRequest $id).qualification_id -ceq $id.ToString('D')) 'exact current source-bound request accepted'
Reject { Write-NewQualificationJson $folder 'request.json' $request } '.' 'write-once request cannot be overwritten'
Reject { Assert-QualificationPath ($script:QualificationRoot+'-sibling\file') } 'PATH_ESCAPE' 'sibling root prefix refused'
Reject { Assert-QualificationPath ([IO.Path]::Combine($folder,'..\..\escape')) } 'PATH_ESCAPE' 'normalized traversal refused'
Reject { Get-QualificationFolder ([guid]::Empty) } 'GUID_REQUIRED' 'empty qualification ID refused'
$large=[IO.Path]::Combine($folder,'callback.json');[IO.File]::WriteAllText($large,('x'*32769))
Reject { Read-QualificationJson $folder 'callback.json' } 'TOO_LARGE' 'oversized phase file refused before JSON parse'
$value=New-PhaseFixture 'cleanup' 'UNKNOWN' $id
Assert-PhaseReport $value 'cleanup' $id $expectedSha $fixtureGitHub $fixtureIdentity
Check $true 'explicit unknown cleanup remains a schema-valid non-success observation'
$value.production_qualified=$true
Reject { Assert-PhaseReport $value 'cleanup' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'BINDING_MISMATCH' 'phase report cannot self-qualify production'
$value.production_qualified=$false;$value.qualification_id=[guid]::NewGuid().ToString('D')
Reject { Assert-PhaseReport $value 'cleanup' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'BINDING_MISMATCH' 'wrong qualification phase report refused'
$callback=New-PhaseFixture 'callback' 'OBSERVED' $id
Reject { Assert-PhaseReport $callback 'callback' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'CALLBACK_WSL_EVIDENCE_MISSING' 'observed callback without WSL evidence refused'
`);
  assert.equal(report.checks.length, 10);
});

test('phase success requires exact source, run, identity, WSL result, and actual scheduler or cleanup facts', { skip: !windows }, () => {
  const report = runCase(String.raw`
$id=[guid]::NewGuid()
$callback=New-PhaseFixture 'callback' 'OBSERVED' $id
$callback|Add-Member -NotePropertyName wsl_version -NotePropertyValue ([pscustomobject]@{result='OBSERVED';executable=$script:WslPath;file_version=$script:ExpectedWslVersion;invocation=[pscustomobject]@{result='OBSERVED';exit_code=0;stdout=('WSL version: '+$script:ExpectedWslVersion);stderr=''}})
Assert-PhaseReport $callback 'callback' $id $expectedSha $fixtureGitHub $fixtureIdentity
Check $true 'fully bound callback version observation accepted'
foreach($mode in @('source','run-attempt','pr-head','pr-base','pr-ref','pr-author','identity-session','identity-bool-type','qualified-string','wsl-unknown','wrong-executable','wrong-version','invocation-unknown','exit-string','missing-version-output')) {
    $value=$callback|ConvertTo-Json -Depth 14|ConvertFrom-Json
    switch($mode) {
        source {$value.source_sha256='b'*64}
        run-attempt {$value.github.run_attempt='2'}
        pr-head {$value.github.pull_request_head_sha='d'*40}
        pr-base {$value.github.pull_request_base_sha='d'*40}
        pr-ref {$value.github.ref='refs/pull/43/merge'}
        pr-author {$value.github.pull_request_author='another-user'}
        identity-session {$value.identity.session_id=1}
        identity-bool-type {$value.identity.administrator_token_member='False'}
        qualified-string {$value.production_qualified='False'}
        wsl-unknown {$value.wsl_version.result='UNKNOWN'}
        wrong-executable {$value.wsl_version.executable='C:\wrong.exe'}
        wrong-version {$value.wsl_version.file_version='1.0.0'}
        invocation-unknown {$value.wsl_version.invocation.result='UNKNOWN'}
        exit-string {$value.wsl_version.invocation.exit_code='0'}
        missing-version-output {$value.wsl_version.invocation.stdout='no pinned version'}
    }
    Reject { Assert-PhaseReport $value 'callback' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'MISMATCH|INVALID|NOT_OBSERVED|CONTEXT_REQUIRED' ('incomplete callback stays non-success: '+$mode)
}
$scheduler=New-PhaseFixture 'scheduler' 'OBSERVED' $id
Reject { Assert-PhaseReport $scheduler 'scheduler' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'FACT_NOT_PROVEN' 'scheduler OBSERVED without actual task facts refused'
foreach($name in @('task_was_absent_before_registration','task_registered','task_ownership_verified','task_run_requested')) {$scheduler|Add-Member -NotePropertyName $name -NotePropertyValue $true}
$scheduler|Add-Member -NotePropertyName last_task_result -NotePropertyValue 0
$scheduler|Add-Member -NotePropertyName instance_guid -NotePropertyValue ([guid]::NewGuid().ToString('D'))
Assert-PhaseReport $scheduler 'scheduler' $id $expectedSha $fixtureGitHub $fixtureIdentity
Check $true 'complete exact task creation and run observation accepted'
$scheduler.last_task_result=5
Reject { Assert-PhaseReport $scheduler 'scheduler' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'RESULT_NOT_SUCCESSFUL' 'scheduler nonzero actual result refused'
$cleanup=New-PhaseFixture 'cleanup' 'ABSENT_CONFIRMED' $id
Reject { Assert-PhaseReport $cleanup 'cleanup' $id $expectedSha $fixtureGitHub $fixtureIdentity } 'FACT_NOT_PROVEN' 'cleanup absence alone cannot claim exercised cleanup'
foreach($name in @('registration_intent_verified','task_was_present','task_ownership_verified','deleted_own_task','task_absent_confirmed')) {$cleanup|Add-Member -NotePropertyName $name -NotePropertyValue $true}
Assert-PhaseReport $cleanup 'cleanup' $id $expectedSha $fixtureGitHub $fixtureIdentity
Check $true 'complete owned task cleanup observation accepted'
`);
  assert.equal(report.checks.length, 21);
});

test('public canary read evidence distinguishes readable, absent, and actual access-denied files', { skip: !windows }, () => {
  const report = runCase(String.raw`
$adaptedRoot=[IO.Path]::Combine($script:QualificationRoot,'canaries')+'\'
. ([scriptblock]::Create((Adapt-OnlyPathLiteral 'Get-PublicCanaryReadEvidence' 'D:\CluedProductionPublisher\isolation-canaries\' $adaptedRoot)))
Check (-not (Get-Item Function:Get-PublicCanaryReadEvidence).ScriptBlock.ToString().Contains('D:\CluedProductionPublisher\')) 'canary fixture path adapter is installed before any read'
Check ((Get-PublicCanaryReadEvidence ([guid]::Empty)).result -ceq 'NOT_REQUESTED') 'empty canary ID performs no read'
$id=[guid]::NewGuid()
Check ((Get-PublicCanaryReadEvidence $id).result -ceq 'UNKNOWN') 'missing canary is unknown rather than access-denied PASS'
$folder=[IO.Path]::Combine($adaptedRoot,$id.ToString('D'));[IO.Directory]::CreateDirectory($folder)|Out-Null
$file=[IO.Path]::Combine($folder,'public-canary.json');[IO.File]::WriteAllText($file,'public test data')
$readable=Get-PublicCanaryReadEvidence $id
Check ($readable.result -ceq 'FAIL' -and $readable.bytes_read -eq 0) 'readable public file fails isolation without reading its bytes'
$original=[IO.File]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access)
$denied=New-Object Security.AccessControl.FileSecurity
$denied.SetSecurityDescriptorBinaryForm($original.GetSecurityDescriptorBinaryForm(),[Security.AccessControl.AccessControlSections]::Access)
$restore=New-Object Security.AccessControl.FileSecurity
$restore.SetSecurityDescriptorBinaryForm($original.GetSecurityDescriptorBinaryForm(),[Security.AccessControl.AccessControlSections]::Access)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadData','Deny')
$denied.AddAccessRule($rule);[IO.File]::SetAccessControl($file,$denied)
try {
    $value=Get-PublicCanaryReadEvidence $id
    Check ($value.result -ceq 'PASS' -and $value.reason -ceq 'EXPLICIT_ACCESS_DENIED') 'actual temporary-file DACL read denial produces only the narrow read check PASS'
    Check ($value.production_qualified -eq $false -and $value.trusted_host_existence_proof -ceq 'REQUIRED_SEPARATELY') 'denial does not establish existence or production qualification'
} finally { [IO.File]::SetAccessControl($file,$restore) }
`);
  assert.equal(report.checks.length, 6);
});

test('exact VM read classification keeps module failure and missing identity unknown while admitting only query denial', { skip: !windows }, () => {
  const report = runCase(String.raw`
$mockManifest=[IO.Path]::Combine($script:QualificationRoot,'fixture-hyperv.psd1')
[IO.File]::WriteAllText($mockManifest,'test-only manifest location; never imported')
. ([scriptblock]::Create((Adapt-OnlyPathLiteral 'Get-ExactVmReadEvidence' 'Modules\Hyper-V\2.0.0.0\Hyper-V.psd1' $mockManifest)))
Check ((Get-Item Function:Get-ExactVmReadEvidence).ScriptBlock.ToString().Contains($mockManifest)) 'VM module-path adapter is installed before any query'
$global:CluedVmFixtureMode='readable'
$fakeModule=New-Module -Name Hyper-V -ScriptBlock {
    function Get-VM {
        [CmdletBinding()]param([guid]$Id)
        switch($global:CluedVmFixtureMode) {
            readable {return [pscustomobject]@{Id=$Id}}
            denied {throw [UnauthorizedAccessException]::new('fixture VM query denied')}
            missing {Write-Error 'fixture VM missing' -Category ObjectNotFound -ErrorAction Stop}
            empty {return}
            wrong-id {return [pscustomobject]@{Id=[guid]::NewGuid()}}
            default {throw 'unexpected fixture query mode'}
        }
    }
    Export-ModuleMember -Function Get-VM
}
Microsoft.PowerShell.Core\Import-Module -ModuleInfo $fakeModule -Global
$script:importFails=$false
function Import-Module {param($Name,$Scope,$ErrorAction) if($Name -cne $mockManifest){throw 'unexpected real import attempt'};if($script:importFails){throw [UnauthorizedAccessException]::new('fixture import denied')}}
$id=[guid]::NewGuid()
Check ((Get-ExactVmReadEvidence ([guid]::Empty)).result -ceq 'NOT_REQUESTED') 'empty VM ID never queries a module'
$script:importFails=$true
$value=Get-ExactVmReadEvidence $id
Check ($value.result -ceq 'UNKNOWN' -and $value.reason -ceq 'HYPER_V_MODULE_UNAVAILABLE') 'module import access error is unknown rather than a VM-denial PASS'
$script:importFails=$false
foreach($mode in @('readable','denied','missing','empty','wrong-id')) {
    $global:CluedVmFixtureMode=$mode
    $value=Get-ExactVmReadEvidence $id
    $expected=if($mode -ceq 'readable'){'FAIL'}elseif($mode -ceq 'denied'){'PASS'}else{'UNKNOWN'}
    Check ($value.result -ceq $expected) ('exact VM classification: '+$mode)
    if($mode -ceq 'denied') {Check ($value.production_qualified -eq $false -and $value.management_mutation_denial -ceq 'NOT_TESTED') 'read denial never claims management mutation denial or production qualification'}
}
`);
  assert.equal(report.checks.length, 9);
});

test('bounded VM helper rejects incomplete, mismatched, failed, or timed-out child evidence', { skip: !windows }, () => {
  const report = runCase(String.raw`
$id=[guid]::NewGuid();$probe=[guid]::NewGuid()
$script:child=[ordered]@{result='OBSERVED';exit_code=0;stdout='{}';stderr=''}
$script:processCalls=0
function Invoke-FixedProcess {param($Executable,$Arguments,$TimeoutMilliseconds) $script:processCalls+=1;if($TimeoutMilliseconds -ne 6000 -or -not $Arguments.Contains($id.ToString('D'))){throw 'unbounded or wrong VM helper'};return $script:child}
$valid=[ordered]@{result='PASS';reason='EXPLICIT_VM_QUERY_ACCESS_DENIED';vm_id=$id.ToString('D');production_qualified=$false;management_mutation_denial='NOT_TESTED';trusted_host_existence_proof='REQUIRED_SEPARATELY'}
$script:child.stdout=$valid|ConvertTo-Json -Compress
Check ((Get-BoundedExactVmReadEvidence $id $probe).result -ceq 'PASS') 'fully bound narrow child denial accepted'
foreach($mode in @('missing-id','wrong-id','missing-qualified','qualified-true','wrong-reason','mutation-claim','timeout','failed-exit','malformed-json')) {
    $copy=$valid|ConvertTo-Json|ConvertFrom-Json
    $script:child.result='OBSERVED';$script:child.exit_code=0
    switch($mode) {
        missing-id {$copy.PSObject.Properties.Remove('vm_id')}
        wrong-id {$copy.vm_id=[guid]::NewGuid().ToString('D')}
        missing-qualified {$copy.PSObject.Properties.Remove('production_qualified')}
        qualified-true {$copy.production_qualified=$true}
        wrong-reason {$copy.reason='HYPER_V_MODULE_UNAVAILABLE'}
        mutation-claim {$copy.management_mutation_denial='PASS'}
        timeout {$script:child.result='UNKNOWN'}
        failed-exit {$script:child.exit_code=2}
    }
    $script:child.stdout=$copy|ConvertTo-Json -Compress
    if($mode -ceq 'malformed-json'){$script:child.stdout='not JSON'}
    Check ((Get-BoundedExactVmReadEvidence $id $probe).result -ceq 'UNKNOWN') ('unsafe child evidence stays unknown: '+$mode)
}
Check ($script:processCalls -eq 10) 'all child process requests use the same finite helper path'
`);
  assert.equal(report.checks.length, 11);
});

const taskFixture = String.raw`
$id=[guid]::NewGuid();$folder=Get-QualificationFolder $id
[IO.Directory]::CreateDirectory($folder)|Out-Null
$hash='a'*64
function Get-ProbeIdentity { return $fixtureIdentity }
function New-TaskFixture {
    $action=[pscustomobject]@{Path=$script:PowerShellPath;Arguments=(Get-CanaryTaskArguments $id $folder);WorkingDirectory=$folder}
    $actions=[pscustomobject]@{Count=1;Action=$action}
    $actions|Add-Member -MemberType ScriptMethod -Name Item -Value {param($index) if($index -ne 1){throw 'wrong action index'};return $this.Action}
    $task=[pscustomobject]@{Name=$script:TaskPrefix+$id.ToString('N');Sddl=('O:'+$script:ExpectedSid);State=3;LastTaskResult=0;Definition=[pscustomobject]@{
        Principal=[pscustomobject]@{UserId=$script:ExpectedSid;LogonType=2;RunLevel=0}
        RegistrationInfo=[pscustomobject]@{Description=(Get-CanaryTaskDescription $id $hash)}
        Actions=$actions;Triggers=[pscustomobject]@{Count=0};Settings=[pscustomobject]@{ExecutionTimeLimit='PT45S'}
    }}
    $task|Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptor -Value {param($flags) return $this.Sddl}
    $task|Add-Member -MemberType ScriptMethod -Name Stop -Value {param($flags) $script:stops+=1;$this.State=3}
    return $task
}
`;

test('scheduled task ownership validates exact owner, principal, action, lifetime, and no triggers', { skip: !windows }, () => {
  const report = runCase(taskFixture + String.raw`
$task=New-TaskFixture
Assert-OwnedCanaryTask $task $id $folder $hash
Check $true 'exact limited owned task fixture accepted'
foreach($field in @('name','sid','owner','logon','runlevel','description','actions','triggers','path','arguments','directory','timeout')) {
    $task=New-TaskFixture
    switch($field) {
        name {$task.Name+='-foreign'}
        sid {$task.Definition.Principal.UserId='S-1-5-18'}
        owner {$task.Sddl='O:S-1-5-18'}
        logon {$task.Definition.Principal.LogonType=3}
        runlevel {$task.Definition.Principal.RunLevel=1}
        description {$task.Definition.RegistrationInfo.Description='foreign source'}
        actions {$task.Definition.Actions.Count=2}
        triggers {$task.Definition.Triggers.Count=1}
        path {$task.Definition.Actions.Action.Path='C:\wrong.exe'}
        arguments {$task.Definition.Actions.Action.Arguments+=' -Injected'}
        directory {$task.Definition.Actions.Action.WorkingDirectory='C:\wrong'}
        timeout {$task.Definition.Settings.ExecutionTimeLimit='PT24H'}
    }
    Reject { Assert-OwnedCanaryTask $task $id $folder $hash } 'OWNERSHIP_MISMATCH' ('task mismatch refused: '+$field)
}
`);
  assert.equal(report.checks.length, 13);
});

test('cleanup touches only an intent-backed exact owned task and never treats scheduler denial as absence', { skip: !windows }, () => {
  const report = runCase(taskFixture + String.raw`
$script:comCalls=0;$script:deletes=0;$script:stops=0;$script:currentTask=$null;$script:schedulerDenied=$false
$root=[pscustomobject]@{}
$root|Add-Member -MemberType ScriptMethod -Name GetTask -Value {param($name) if($name -cne ($script:TaskPrefix+$id.ToString('N'))){throw 'wrong task query'};return $script:currentTask}
$root|Add-Member -MemberType ScriptMethod -Name DeleteTask -Value {param($name,$flags) if($name -cne ($script:TaskPrefix+$id.ToString('N')) -or $flags -ne 0){throw 'wrong task deletion'};$script:deletes+=1;$script:currentTask=$null}
$service=[pscustomobject]@{Root=$root}
$service|Add-Member -MemberType ScriptMethod -Name Connect -Value {if($script:schedulerDenied){throw [UnauthorizedAccessException]::new('scheduler denied')}}
$service|Add-Member -MemberType ScriptMethod -Name GetFolder -Value {param($name) if($name -cne '\'){throw 'wrong task folder'};return $this.Root}
function New-Object {
    [CmdletBinding(DefaultParameterSetName='Type')]
    param([Parameter(ParameterSetName='Type',Position=0)][string]$TypeName,[Parameter(ParameterSetName='Type',Position=1)][object[]]$ArgumentList,[Parameter(ParameterSetName='Com')][string]$ComObject)
    if($PSCmdlet.ParameterSetName -ceq 'Com') {if($ComObject -cne 'Schedule.Service'){throw 'unexpected COM'};$script:comCalls+=1;return $service}
    return Microsoft.PowerShell.Utility\New-Object @PSBoundParameters
}
$request=[pscustomobject]@{source_sha256=$hash;github=$fixtureGitHub}
foreach($mode in @('no-intent','foreign-intent','wrong-owner','scheduler-denied','exact-owned')) {
    $caseFolder=[IO.Path]::Combine($folder,$mode);[IO.Directory]::CreateDirectory($caseFolder)|Out-Null
    $script:comCalls=0;$script:deletes=0;$script:stops=0;$script:schedulerDenied=($mode -ceq 'scheduler-denied')
    $script:currentTask=New-TaskFixture
    $script:currentTask.Definition.Actions.Action.Arguments=Get-CanaryTaskArguments $id $caseFolder
    $script:currentTask.Definition.Actions.Action.WorkingDirectory=$caseFolder
    $script:currentTask.State=4
    if($mode -ceq 'wrong-owner'){$script:currentTask.Sddl='O:S-1-5-18'}
    if($mode -cne 'no-intent') {
        $intent=[ordered]@{schema=$script:SchemaPrefix+'.registration-intent/1';qualification_id=$id.ToString('D');task_name=$script:TaskPrefix+$id.ToString('N');source_sha256=$hash;task_was_absent=$true;production_qualified=$false}
        if($mode -ceq 'foreign-intent'){$intent.source_sha256='b'*64}
        Write-NewQualificationJson $caseFolder 'registration-intent.json' $intent
    }
    Invoke-CleanupPhase $id $caseFolder $request
    $value=Read-QualificationJson $caseFolder 'cleanup.json'
    if($mode -ceq 'exact-owned') {
        Check ($value.result -ceq 'ABSENT_CONFIRMED' -and $value.deleted_own_task -and $script:deletes -eq 1 -and $script:stops -eq 1) 'exact running owned task is stopped and deleted once, then absence rechecked'
    } else {
        Check ($value.result -ceq 'UNKNOWN' -and -not $value.deleted_own_task -and $script:deletes -eq 0 -and $script:stops -eq 0) ('unsafe or unavailable cleanup stays unknown without stop or delete: '+$mode)
        if($mode -in @('no-intent','foreign-intent')) {Check ($script:comCalls -eq 0) ('no scheduler contact without exact prior registration intent: '+$mode)}
    }
    Check ($value.production_qualified -eq $false) ('cleanup never qualifies production: '+$mode)
}
`);
  assert.equal(report.checks.length, 12);
});
