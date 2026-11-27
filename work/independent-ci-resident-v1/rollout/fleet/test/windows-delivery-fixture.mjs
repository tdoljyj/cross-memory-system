import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceBytes } from '../../../src/fleet-acceptance.mjs';
import { PLAN_CONTRACT, prepareInstall } from '../install.mjs';
import { fixtureId } from './delivery-release-fixture.mjs';
import { nodeSite, sha, tempDir } from './fleet-fixtures.mjs';

const generatorHost = fileURLToPath(new URL('./launcher-check-host.py', import.meta.url));
const runnerSddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)';
const readJson = file => JSON.parse(fsSync.readFileSync(file, 'utf8'));
const nonInteractive = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

export async function checkWindowsBoundary(t, w, acceptance, checked, now) {
  const scope = `project:${fixtureId(2)}`;
  const dir = await tempDir(t, 'fleet-win-');
  const from = path.join(dir, 'release'), script = path.join(dir, 'check.ps1');
  await fs.mkdir(from);
  // 按发布文档的下载模式筛选 bootstrap 的安装资产。
  const deliveryNames = new Set(['SHA256SUMS', w.acceptanceName,
    ...['tar', 'release.json', 'bootstrap.ps1', 'prereq-manifest.json'].map(suffix => `${w.tag}.${suffix}`)]);
  for (const { name } of w.assets()) {
    if (deliveryNames.has(name) || name.startsWith(`${w.tag}.first-install`) || /^role-image-.*\.tar\.gz$/.test(name)) {
      await fs.writeFile(path.join(from, name), w.asset(name));
    }
  }
  if (!w.assets().some(({ name }) => name === w.acceptanceName)) {
    await fs.writeFile(path.join(from, w.acceptanceName), acceptanceBytes(acceptance));
  }
  const pins = path.join(dir, 'pins.json');
  await fs.writeFile(pins, JSON.stringify(checked));
  await fs.writeFile(script, String.raw`
param([string]$AssetsDir, [string]$Pins, [string]$Runtime, [string]$Scratch)
$ErrorActionPreference = 'Stop'
$names = @(Get-ChildItem -LiteralPath $AssetsDir -File | ForEach-Object Name)
$boot = Join-Path $AssetsDir @($names -like '*.bootstrap.ps1')[0]
. $boot
$version = Get-ReleaseVersion $names
$tag = 'fleet-node-' + $version
$sums = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $AssetsDir 'SHA256SUMS')))
$first = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $AssetsDir "$tag.first-install.SHA256SUMS")))
foreach ($mode in @($true, $false)) {
  $codes = Test-AssetSet $names $sums $first $version $mode @()
  if ($codes.Count) { throw ($codes -join ',') }
}
foreach ($set in @($sums, $first)) {
  foreach ($name in $set.Keys) {
    if ((Sha256File (Join-Path $AssetsDir $name)) -cne $set[$name]) { throw "asset hash: $name" }
  }
}
$js = New-Object Web.Script.Serialization.JavaScriptSerializer
$check = $js.DeserializeObject([IO.File]::ReadAllText($Pins))
$tar = "$tag.tar"
$kit = "$tag.first-install-kit.json"
$prereq = "$tag.prereq-manifest.json"
$codes = Test-FirstInstallCheck $check $sums[$tar] $first[$kit] (Sha256File $Runtime)
if ($codes.Count) { throw ($codes -join ',') }
$bad = Test-FirstInstallCheck $check $sums[$tar] $first[$kit] ('0' * 64)
if ($bad -cnotcontains 'CONTROLLER_NODE_NOT_THE_FLEETS') { throw 'controller digest accepted' }
$localTar = Copy-ToWork (Join-Path $AssetsDir $tar) $Scratch $sums[$tar]
$localKit = Copy-ToWork (Join-Path $AssetsDir $kit) $Scratch $first[$kit]
$localPrereq = Copy-ToWork (Join-Path $AssetsDir $prereq) $Scratch $sums[$prereq]
$operatorSid = 'S-1-5-21-1-2-3-1001'
$hostArgs = Get-ElevatedArguments $boot @('-Stage', 'install', '-Tar', $localTar, '-ArchiveSha256', $sums[$tar],
  '-PrereqManifest', $localPrereq, '-PrereqManifestSha256', $sums[$prereq], '-Kit', $localKit,
  '-KitSha256', $first[$kit], '-ToolchainNodeSha256', $check['toolchainNodeSha256'],
  '-RegistrarSha256', $check['registrarSha256'], '-ExpectedOperatorSid', $operatorSid)
if ($hostArgs -cnotcontains $localKit -or $hostArgs -cnotcontains $check['registrarSha256']) { throw 'host argument pins' }
$sidFlag = [Array]::IndexOf($hostArgs, '-ExpectedOperatorSid')
if ($sidFlag -lt 0) { throw 'operator argument missing' }
$expectedSid = $hostArgs[$sidFlag + 1]
if ($expectedSid -cne $operatorSid -or $null -ne (Test-StageOperator $operatorSid $expectedSid)) { throw 'same operator refused' }
if ((Test-StageOperator 'S-1-5-21-1-2-3-1002' $expectedSid) -cne 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR') { throw 'switched operator accepted' }
if ((Test-StageOperator $operatorSid '') -cne 'EXPECTED_OPERATOR_SID_REQUIRED') { throw 'missing operator accepted' }
foreach ($local in @($localTar, $localKit, $localPrereq)) {
  if (-not (Test-UnderDirectory $local $Scratch)) { throw 'non-local host input' }
}
`);
  const ps = spawnSync('powershell.exe', [...nonInteractive,
    '-File', script, from, pins, path.join(w.template.root, 'runtime', 'node.exe'), path.join(dir, 'host-inputs')], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.error?.message ?? ps.stderr);

  // 真正编制重装计划、生成 Linux 脚本并运行 --check，W1 调用记录后立即终止。
  // 已装节点的记录校验器要求固定的公开 App 编号，首装 kit 则保留独立的假编号。
  const installed = await nodeSite(t, 'b', w.fleet, { now,
    recordOverrides: { scope, appKeyId: 104, ciPrincipalBindingId: fixtureId(12), ciPrincipalRoleRef: fixtureId(15) } });
  const receiptFile = path.join(installed.root, 'install', 'install-receipt.json');
  const currentFile = path.join(installed.root, 'upgrade', 'current.json');
  const current = readJson(currentFile);
  const receipt = JSON.stringify({ ...readJson(receiptFile), residentManifestSha256: current.residentManifestSha256 });
  await fs.writeFile(receiptFile, receipt);
  await fs.writeFile(currentFile, JSON.stringify({ ...current, installReceiptSha256: sha(receipt) }));
  await fs.mkdir(path.join(installed.root, 'state', 'ledger'), { recursive: true });
  await fs.writeFile(path.join(installed.root, 'state', 'status.json'), JSON.stringify({ current: null, executor: { state: 'idle' } }));
  const workDir = path.join(dir, 'reinstall');
  const planFile = path.join(workDir, 'install-plan.json');
  const observedAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const planBoundary = new Error('测试已到达 W1 调用边界');
  const calls = [];
  let launcherCheck;
  const runPython = argv => spawnSync('python', ['-I', '-B', ...argv], { encoding: 'utf8' });
  const checkedRun = argv => {
    const result = runPython(argv);
    assert.equal(result.status, 0, result.error?.message ?? (result.stderr || result.stdout));
    return result;
  };
  const python = (file, args) => {
    const name = path.basename(file);
    calls.push(name);
    if (name === 'rehearse.py') {
      const verify = path.join(installed.root, 'resident', current.residentManifestSha256, 'windows', 'verify-resident.ps1');
      const report = path.join(workDir, 'rehearsal', 'fixture.json');
      fsSync.writeFileSync(report, JSON.stringify({ contract: 'clued.independent-ci.reinstall-rehearsal/1',
        status: 'REHEARSAL_PASS', findings: [], commit: acceptance.commit, node: installed.profile.nodeName,
        configSha256: sha(fsSync.readFileSync(args[0])),
        packageManifestSha256: sha(fsSync.readFileSync(path.join(args[args.indexOf('--package') + 1], 'package-manifest.json'))),
        observedAt, checks: { verify: { sha256: sha(fsSync.readFileSync(verify)) } } }));
      return { status: 0, stdout: JSON.stringify({ status: 'REHEARSAL_PASS', report }) };
    }
    if (name === 'pause-old-resident.py') {
      assert.equal(launcherCheck?.status, 'FLEET_PLAN_CHECK_PASSED');
      throw planBoundary;
    }
    if (name === 'prep.py') return checkedRun([generatorHost, '--prep', observedAt, file, ...args]);
    assert.deepEqual([name, ...args], ['generate.py', '--fleet-plan', planFile, '--check']);
    const argv = [generatorHost, installed.root, runnerSddl, file, ...args];
    const result = checkedRun(argv);
    launcherCheck = JSON.parse(result.stdout);
    const linuxA = readJson(planFile).linux.scripts.A.path;
    const original = fsSync.readFileSync(linuxA);
    try {
      fsSync.appendFileSync(linuxA, '\n# fixture change\n');
      const refusal = runPython(argv);
      assert.equal(refusal.status, 1, refusal.error?.message ?? refusal.stderr);
      assert.match(refusal.stderr, /AssertionError: \('FLEET_SCRIPT_NOT_AS_PLANNED', 'A'\)/);
    } finally { fsSync.writeFileSync(linuxA, original); }
    return result;
  };
  await assert.rejects(prepareInstall({
    artifactPath: w.build.tar, artifactSha256: acceptance.archive_sha256, acceptance, root: installed.root,
    workDir, now, python, scm: () => ({ sddl: runnerSddl }),
    wslConfigPath: path.join(dir, '.wslconfig'),
  }), error => {
    if (error !== planBoundary) throw new Error(`重装计划编制失败：${error.message} ${JSON.stringify(error.detail ?? null)}`, { cause: error });
    return true;
  });
  assert.deepEqual(calls, ['rehearse.py', 'prep.py', 'generate.py', 'pause-old-resident.py']);
  const planBytes = await fs.readFile(planFile);
  const plan = JSON.parse(planBytes);
  assert.deepEqual([plan.contract, plan.node, plan.commit, plan.archive_sha256, plan.ciSourceManifestSha256],
    [PLAN_CONTRACT, installed.profile.nodeName, acceptance.commit, acceptance.archive_sha256, acceptance.ciSourceManifestSha256]);
  assert.equal(plan.installedPackage.packageGeneration, 25);
  assert.equal(plan.w1Paused, null);
  assert.equal(plan.launcher, null);
  assert.equal(launcherCheck.installPlanSha256, sha(planBytes));
  assert.equal(launcherCheck.packageManifestSha256, plan.packageManifestSha256);
  assert.equal(launcherCheck.operatorSid, installed.profile.ownerSid);
  assert.equal(launcherCheck.pausedNow, false);
  assert.equal(sha(await fs.readFile(path.join(plan.packageDir, 'package-manifest.json'))), plan.packageManifestSha256);
}
