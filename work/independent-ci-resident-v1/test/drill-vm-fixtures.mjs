// drill/drill-vm.ps1, offline: the decisions that do not need Hyper-V (answer file, answer ISO, memory gate, baseline action,
// ISO hash, package triple, first-install kit, the A1-A10 verdict, the production read-back, -Finalize) and the guest-side fake
// credentials, whose fingerprints are cross-checked against the package's own formulas (tools/secret-fingerprint.mjs).
// No VM is created or touched; only temp directories are written.
//
// The fixtures of drill-vm-part1..4.test.mjs (ps(), the fixed time T0, the worlds and stubs), shared by the four parts. They were one
// file, drill-vm.test.mjs, split by run time so no part holds a hosted shard past about 210 s (task 3435f8bf, block 2); each part runs
// in a process of its own, so each loads this module, and gets its own temp directory and mutex names, once.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acceptanceOf, prepare, requestLineOf, seal } from '../rollout/fleet/publish.mjs';
import { FAKE_GH } from '../rollout/fleet/test/fleet-fixtures.mjs';
import { writeTar } from '../rollout/fleet/tar.mjs';

export const windows = process.platform === 'win32';
export const script = fileURLToPath(new URL('../drill/drill-vm.ps1', import.meta.url));
export const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-vm-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
// The drilled package's two credential groups (Fable renew-key ruling, supplement "where the credential list comes from"): data the package
// ships in its archive (windows/credential-files.json), the companion token required, the heartbeat token the only optional one.
export const PACKAGE_CREDENTIALS = { required: { appKey: 'app-private-key.pem', ciToken: 'ci-admission.token', upgradeToken: 'resident-upgrade.token', public: 'public.json', companionToken: 'companion-github.token' },
  optional: { heartbeatToken: 'ci-node-heartbeat.token' } };
export const CREDENTIAL_FILES_CONTRACT = 'clued.independent-ci.credential-files/1';
export const credentialFilesJson = (c = PACKAGE_CREDENTIALS) => JSON.stringify({ contract: CREDENTIAL_FILES_CONTRACT, ...c }, null, 2) + '\n';

// The drill's server stand-in (drill/drill-server.json in a real run) and the fixtures' "production": what a Release kit names, what the
// drill kit names instead, and the Owner's drill binding as drill-vm.ps1 reads it (a PSCredential: connection id, token). Fixture values,
// registered nowhere.
export const PRODUCTION_SERVER = { supabaseUrl: 'https://prodfixture0000000000.supabase.co', publishableKey: 'sb_publishable_prodfix' };
// The production gateway a package's own code names (windows/SwapBroker.cs Route: the renew probe every service start sends), here a fixture.
export const PRODUCTION_GATEWAY = 'gateway.prodfixture.example';
// What the Release record names besides its server, sent with the role probe (scope, repository): the drill kit keeps them as they are.
export const RECORD_NAMES = { scope: 'project:fixture-scope', repository: 'fixture-owner/fixture-repo' };
export const DRILL_SERVER = { contract: 'clued.drill.server/1', project: 'fixture-drill-project', supabaseUrl: 'https://drillfixture000000000.supabase.co', publishableKey: 'sb_publishable_drilltest',
  // every https host the package's archive names is one or the other, or no kit (review M1): the service's own beyond the record's
  // database (cut off in the guest), and the others (not Clued's)
  blackholeHosts: [PRODUCTION_GATEWAY], allowedHosts: ['api.github.com'],
  // the session pooler the host's sync connects through (never in the kit: the guest does not use it)
  poolerHost: 'aws-0-fixture-region-1.pooler.supabase.com' };
export const BINDING_ID = '11111111-2222-4333-8444-555555555555';
export const BINDING_TOKEN = 'clued_bnd_DRILLFIXTUREdrillfixture';
export const bindingPs = `(New-Object System.Management.Automation.PSCredential ${"'" + BINDING_ID + "'"}, (ConvertTo-SecureString ${"'" + BINDING_TOKEN + "'"} -AsPlainText -Force))`;

// The drill's named mutexes are machine-wide (Global\): a fixture holding them would refuse a real drill on this host and fail while one
// runs. Every fixture that loads drill-vm.ps1 swaps in names of this test run's own right after loading it; the PowerShell processes one
// test starts (a host and the watchdog it launches) load the same fixture, so they still share them.
// (The same for the host's cache of the drill server's public key, drill-vm.ps1 -ServerKey: no fixture writes the host's own.)
// The Owner's drill binding is read from the host (D:\\clued-drill, Get-DrillCredential -Binding): a fixture never reads that one. Every
// fixture that loads drill-vm.ps1 points the script at this test run's own, a fixture binding written on first use.
// Before any boot the host asks the drill's server itself (Assert-DrillServerReady: the sync receipt, the role probe). No fixture reaches
// a server: every fixture's call is the offline half of that tool (the kit against its Release), unless a test gives its own answer.
const offlineServer = `function Invoke-DrillServerReadyNode([string]$Node, [string]$KitDir, [string]$From, [string]$Version, $Binding) {
    Invoke-DrillNode $Node @((Join-Path (Split-Path -Parent $script:DrillScriptPath) 'make-drill-kit.mjs'), '--server-of', $KitDir, '--from', $From, '--version', $Version) 60 }`;
// Before the probe the host brings the test project to production's applied list (Sync-DrillServer: the release run's list, the sync
// script with the database password on its standard input). No fixture reaches GitHub or a database: every fixture's sync answers "in
// sync" (SYNCED) from here, and never reads the host's own password; a test that needs the real one takes $script:RealSyncDrillServer.
export const SYNCED = { state: 'in-sync', releaseRun: 9001, productionLast: '20261124140000_context_archive_structure_v1', productionRows: 329, applied: 0, projectAccount: 'q***@qq.com' };
const offlineSync = `$script:Drill.ServerDatabaseCredential = ${q(path.join(tmp, 'fixture-no-server-database.clixml'))}; $script:Drill.ProductionListCache = ${q(path.join(tmp, 'fixture-production-applied'))}
  $script:RealSyncDrillServer = \${function:Sync-DrillServer}
  function Sync-DrillServer([string]$From, [string]$Version, [switch]$Rebuild) { ${q(JSON.stringify(SYNCED))} | ConvertFrom-Json }`;
const fixtureBinding = `$script:Drill.BindingCredential = ${q(path.join(tmp, 'fixture-drill-binding.clixml'))}; if (-not (Test-Path -LiteralPath $script:Drill.BindingCredential)) { ${bindingPs} | Export-Clixml -LiteralPath $script:Drill.BindingCredential }; $script:Drill.ServerKeyFile = ${q(path.join(tmp, 'fixture-drill-server.local.json'))}; ${offlineServer}; ${offlineSync}`;
export const ownMutexes = `$script:Drill.HostMutex = ${q(`Local\\CluedDrillTest-${path.basename(tmp)}-host`)}; $script:Drill.BootMutex = ${q(`Local\\CluedDrillTest-${path.basename(tmp)}-boot`)}; ${fixtureBinding}`;
// The fixtures' one time (task ce2e5c1a step 2): a host status is written at T0, and Get-DrillTime answers T0 in every ps() snippet
// that does not define its own, so what a fixture writes reads the same whenever the snippet runs. A snippet that needs time to pass
// defines Get-DrillTime itself.
export const T0 = '2026-11-19T02:00:00Z';
export const frozenClock = `function Get-DrillTime { [DateTimeOffset]${q(T0)} }`;
// Dot-source the script (definitions only), fix its clock at T0, and print the expression's value as JSON.
export function ps(expr) {
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; . ${q(script)}; ${ownMutexes}; ${frozenClock}; ConvertTo-Json -Depth 12 -Compress -InputObject $(${expr})`], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}
// The drill code a call stops with (New-DrillError), or null.
export function psCode(expr) {
  return ps(`try { ${expr} | Out-Null; $null } catch { (Get-DrillCode $_).code }`);
}
export const opts = { skip: !windows };
export const idleHostStatus = (writtenAt = T0) =>
  JSON.stringify({ node: { mode: 'STANDBY' }, executor: { state: 'IDLE' }, current: null, writtenAt });
export const activeHostStatus = (hold, { writtenAt = T0, executor = 'IDLE', reason = null, current = null } = {}) =>
  JSON.stringify({ node: { mode: 'ACTIVE' }, executor: { state: executor, reason }, current, writtenAt,
    intakePause: hold && { until: '2026-11-19T04:00:00Z', holders: [hold] } });
export const entryScript = fileURLToPath(new URL('../drill/first-install-entry.ps1', import.meta.url));
export const entryPs = expr => ps(`. ${q(entryScript)}; ${expr}`);

// dropManifest: prerequisite item names left out of the package's prereq-manifest.json (Codex review of f33fc33e5, medium 3)
// credentialFiles: the archive's windows/credential-files.json as text, or null for a package without one
// tarExtra: more entries of the archive ({ path, data })
export function firstInstallAssets(label, { candidate = false, credentialFiles = credentialFilesJson(), dropManifest = [], tarExtra = [] } = {}) {
  const root = path.join(tmp, label); fs.mkdirSync(root);
  for (const d of ['build', 'final', 'images']) fs.mkdirSync(path.join(root, d));
  const version = '1.2.3', tag = `fleet-node-${version}`, id = 'b'.repeat(64);
  const image = `role-image-${id}.tar.gz`;
  // record: the two public server fields a real kit carries (prepare-record.mjs), here the stand-in for production (PRODUCTION_SERVER)
  const kit = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', images: { local: [{ id, asset: image }] },
    record: { ...PRODUCTION_SERVER, node: 'fixture', ...RECORD_NAMES } }));
  const archive = writeTar([...['bootstrap.ps1', 'prereq-manifest.json'].map(n => ({
    path: `tree/work/independent-ci-resident-v1/rollout/fleet/${n}`,
    data: Buffer.from(n.endsWith('.ps1') ? '# accepted bootstrap\r\n' : JSON.stringify({ items: [
      { fileName: 'wsl.msi', sha256: sha('wsl'), bytes: 3 }, { fileName: 'ubuntu.wsl', sha256: sha('rootfs'), bytes: 6 },
      { name: 'gh', fileName: 'gh.msi', sha256: sha('gh'), bytes: 2 }, { name: 'git-for-windows', fileName: 'git.exe', sha256: sha('git'), bytes: 3 }
    ].filter(i => !dropManifest.includes(i.name)), debs: [{ fileName: 'docker.deb', sha256: sha('deb'), bytes: 3 }] })) })),
    ...(credentialFiles === null ? [] : [{ path: 'tree/work/independent-ci-resident-v1/windows/credential-files.json', data: Buffer.isBuffer(credentialFiles) ? credentialFiles : Buffer.from(credentialFiles) }]),
    // the package's own code names the production gateway and a host that is not Clued's (SwapBroker.cs Route; any case)
    { path: 'tree/work/independent-ci-resident-v1/windows/SwapBroker.cs', data: Buffer.from(`const string Route = "https://${PRODUCTION_GATEWAY}/v1/ci/node/renew"; // HTTPS://API.GitHub.com/x\n`) },
    ...tarExtra,
    { path: 'universal-manifest.json', data: Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-universal/1', version, commit: 'c'.repeat(40), files: [] })) }]);
  fs.writeFileSync(path.join(root, 'build', `${tag}.tar`), archive);
  fs.writeFileSync(path.join(root, 'build', `${tag}.release.json`), '{}');
  fs.writeFileSync(path.join(root, 'build', 'SHA256SUMS'), `${sha(archive)}  ${tag}.tar\n${sha('{}')}  ${tag}.release.json\n`);
  fs.writeFileSync(path.join(root, 'final', `${tag}.first-install-kit.json`), kit);
  // an Owner's acceptance in full (publish.mjs acceptanceOf): the drill kit's stand-in acceptance is made from its fields
  const U = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  if (!candidate) fs.writeFileSync(path.join(root, 'final', `${tag}.acceptance.json`), JSON.stringify(acceptanceOf({
    version, archive_sha256: sha(archive), commit: 'c'.repeat(40), repository: 'tdoljyj/cross-memory-system', firstInstallKitSha256: sha(kit), ciSourceManifestSha256: 'a'.repeat(64),
    fleetRefs: { sourceAcceptanceRef: U(5), hostQualificationRef: U(6), ownerAuthorizationRef: U(5), publisherQualificationRef: U(5), ownerPackageAcceptanceRef: U(5),
      formalRoles: { gitleaks: { image: 'g' }, trivy: { image: 't' }, 'contract-placement': { image: 'c' } } } },
  { decision: U(7), receipt: U(8), acceptedAt: '2026-01-01T00:00:00Z' })));
  fs.writeFileSync(path.join(root, 'images', image), 'fake image fixture');
  const prereq = path.join(root, 'prereq.json');
  fs.writeFileSync(prereq, JSON.stringify({ contract: 'clued.drill.prereq/1',
    wsl: { path: 'wsl.msi', sha256: sha('wsl') }, rootfs: { path: 'ubuntu.wsl', sha256: sha('rootfs') },
    debs: [{ path: 'docker.deb', sha256: sha('deb') }], tools: [{ path: 'gh.msi', sha256: sha('gh') }, { path: 'git.exe', sha256: sha('git') }] }));
  for (const [name, bytes] of [['wsl.msi', 'wsl'], ['ubuntu.wsl', 'rootfs'], ['docker.deb', 'deb'], ['gh.msi', 'gh'], ['git.exe', 'git']]) fs.writeFileSync(path.join(root, name), bytes);
  return { root, build: path.join(root, 'build'), final: path.join(root, 'final'), images: path.join(root, 'images'), version, prereq,
    from: path.join(root, 'from'), out: path.join(root, 'kit'), server: DRILL_SERVER };
}

export const gateNow = '2026-11-19T02:00:00Z';
export const gateUntil = '2026-11-19T03:20:00Z';
export const gateHold = { holder: 'drill', since: gateNow, until: gateUntil };

export function gateActions(statuses, { running = true, memory = '64GB' } = {}) {
  const verdicts = ps(`$now = [DateTimeOffset]${q(gateNow)}; $until = [DateTimeOffset]${q(gateUntil)}; @(
    ${statuses.map(status => `(Test-DrillHostSafety ${q(status)} ${memory} -Running:$${running} -Now $now -HoldUntil $until)`).join(',\n')}
  )`);
  return [verdicts].flat().map(x => x.action);
}

// What the injected sender is handed for one request, the executable first: forward slashes, so the JS template carries the paths intact.
export const intakeArgv = (verb, minutes) => ['C:/clued-drill-test-nowhere/node.exe', 'C:/clued-drill-test-nowhere/rearm-tool.mjs', `request-intake-${verb}`,
  '--root', 'C:/clued-drill-test-nowhere', '--holder', 'drill', '--reason', 'first-install drill', ...(minutes === undefined ? [] : ['--minutes', String(minutes)])].join('|');

// Fable ruling 0e418483 "drill memory root" 2.3 (G1): the armed guard releases the runner distribution's file cache while the host is
// below production's resume line (10 GiB) and above its pause line (6 GiB, the abort, unchanged), at most once every 120 seconds, each
// release bounded by 20 seconds (less than one 30-second tick); a release that fails or times out is only recorded. Every release goes
// into host-guard.json's cacheReleases with the next tick's reading. The guard is driven tick by tick here: free memory in GB per tick,
// one tick every 30 seconds of the drill's clock (Get-DrillTime) and of the monotonic clock the throttle reads (Get-DrillMonotonicSeconds),
// the guest fully assigned (the running gate is 6 GB). wall: the drill's clock in seconds from T0 for a tick, when it is to jump.
// armed: false is the guard before the boot; its sample still passes the running gate, so only "armed" keeps the release away.
export function releaseLoop(name, frees, { release = null, armed = true, wall = '30 * [Math]::Max(0, $script:tick)' } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `release-loop-${name}-`));
  const r = ps(`
    $script:Drill.HostGuardSeconds = 0
    $script:tick = -1; $script:frees = @(${frees.join(', ')}); $script:events = [Collections.Generic.List[string]]::new()
    function Get-DrillTime { ([DateTimeOffset]${q(T0)}).AddSeconds(${wall}) }
    function Get-DrillMonotonicSeconds { [double](30 * [Math]::Max(0, $script:tick)) }
    $state = [hashtable]::Synchronized(@{ stop = $false; ready = $false; armed = $${armed}; failure = $null; cleanup = $null; executorStates = [ordered]@{} })
    function Get-DrillHostSafety { param([switch]$Running, $HoldUntil)
      $script:tick++; $free = $script:frees[$script:tick]; $script:events.Add("tick $free")
      if ($script:tick -ge $script:frees.Count - 1) { $state.stop = $true }
      Test-DrillHostSafety ${q(idleHostStatus())} ([long]($free * 1GB)) -Running -MemoryAssigned 8GB -Now (Get-DrillTime) }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $script:events.Add('stop'); $true }
    ${release ?? `function Invoke-DrillWslCacheRelease { param($HostName, $WithinSeconds, [switch]$WhileRunning) $script:events.Add("release $WithinSeconds$(if ($WhileRunning) { ' while-running' })")
      [ordered]@{ at = (Get-DrillTime).ToString('o'); distributions = @('Fixture-CI'); results = @([ordered]@{ distribution = 'Fixture-CI'; running = $true; exit = 0 }); released = @('Fixture-CI'); failed = $null } }`}
    Invoke-DrillHostGuardLoop $state ${q(dir)} -RestoreCheckpoint
    $file = Join-Path ${q(dir)} 'host-guard.json'
    @{ events = @($script:events); failure = $state.failure; guard = $(if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } else { $null }) }`);
  return r;
}
export const at = s => new Date(Date.parse(T0) + s * 1000).toISOString();
export const releaseRow = x => ({ at: new Date(x.at).toISOString(), freeBeforeGB: x.freeBeforeGB, exit: x.exit, freeAfterGB: x.freeAfterGB });

// Fable ruling 0e418483 "drill memory root" 2.4 (G2): the running gate reads no runner job, so its sample carries no job reading (r11's
// host-guard.json said runnerJob null, wslJobs [] -- "not read" written as "none"); and an abort for memory reads the runner
// distribution's /proc/meminfo (MemTotal, MemFree, Cached, AnonPages) and its Runner.Worker count into wslMemory, read-only, only from
// a distribution already running. Not read whole: no wslMemory, and the abort and its restore as before. The real Get-DrillHostSafety
// under the real guard loop: 5 GB free with the guest fully assigned.
export const MEMINFO = ['MemTotal:       29360128 kB', 'MemFree:         6815744 kB', 'MemAvailable:   22020096 kB', 'Buffers:          131072 kB',
  'Cached:         16777216 kB', 'SwapCached:            0 kB', 'Active:          9437184 kB', 'AnonPages:       5242880 kB', 'Shmem:             65536 kB', ''].join('\n');
// The fixture's /proc/meminfo with another MemFree (GB): the runner distribution's headroom the boot gate counts as taken.
export const meminfoWithFree = (gb) => MEMINFO.replace(/^MemFree:\s+\d+ kB$/m, `MemFree:       ${Math.round(gb * 1024 * 1024)} kB`);
export function memoryAbort(name, answers) {
  const dir = fs.mkdtempSync(path.join(tmp, `g2-${name}-`));
  return ps(`
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) @{ FreePhysicalMemory = 5GB / 1KB } }
    function Get-VM { param($ErrorAction) [pscustomobject]@{ Name = $script:Drill.VmName; Notes = $script:Drill.Marker; MemoryStartup = 8GB; MemoryAssigned = 8GB } }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $script:calls.Add('stop'); $true }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'Fixture-CI' }
    $meminfo = ${q(MEMINFO)}
    $script:calls = [Collections.Generic.List[string]]::new()
    $script:DrillWslRunner = { param($a, $t)
      $j = $a -join ' '; $script:calls.Add($j)
      $answer = @{ list = @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' }; meminfo = @{ exit = 0; stdout = $meminfo; stderr = '' }; workers = @{ exit = 0; stdout = "3\`n"; stderr = '' } }
      ${answers}
      if ($j -ceq '--list --running --quiet') { return $answer.list }
      if ($j -ceq '--distribution Fixture-CI --exec cat /proc/meminfo') { return $answer.meminfo }
      if ($j -ceq '--distribution Fixture-CI --exec pgrep -cix Runner[.]Worker') { return $answer.workers }
      @{ exit = 1; stdout = ''; stderr = 'unexpected' } }
    $state = [hashtable]::Synchronized(@{ stop = $false; ready = $false; armed = $true; failure = $null; cleanup = $null; executorStates = [ordered]@{} })
    Invoke-DrillHostGuardLoop $state ${q(dir)} -RestoreCheckpoint
    @{ calls = @($script:calls); guard = (Get-Content -LiteralPath (Join-Path ${q(dir)} 'host-guard.json') -Raw | ConvertFrom-Json) }`);
}

// A job of our own that refuses breakaway (KILL_ON_JOB_CLOSE only), like the agent session job a real drill runs in.
export const drillTestJob = `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DrillTestJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public ulong Reads, Writes, Other, ReadBytes, WrittenBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr job);
  public static IntPtr Create() {
    var job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x00002000;
    if (SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) return job;
    var error = new Win32Exception();
    CloseHandle(job);
    throw error;
  }
}
'@`;

// A receipt from Invoke-DrillPreparedRun over a package whose manifest lists `paths` (full archive paths), with A1-A8 passing, the
// M5 observations `missing` and a host checker that answers `checker`.
// The complete stdout logs of a first install that went through (Read-DrillFirstInstallSteps reads them from the run directory).
export const STEP_LOGS = {
  'first-install.log': JSON.stringify({ status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe' }) + '\r\n',
  'host.stdout.log': [JSON.stringify({ name: 'stage', result: 'ok' }), JSON.stringify({ status: 'FIRST_INSTALL_HOST_READY' })].join('\r\n') + '\r\n',
  'prepare.stdout.log': JSON.stringify({ status: 'FLEET_NODE_FIRST_INSTALL_PREPARED' }) + '\r\n',
  'launcher.stdout.log': [JSON.stringify({ name: 'install', result: 'ok' }), JSON.stringify({ status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' })].join('\r\n') + '\r\n',
  'stage-evidence.json': JSON.stringify({ 'host-result.json': { exit: 0, terminal: { status: 'FIRST_INSTALL_HOST_READY' } },
    'launcher-result.json': { exit: 0, terminal: { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' } } }),
};
// What the entry of a first install that ended done returned (Save-DrillGuestEvidence's third argument): only after this result is a
// run without a failure snapshot missing nothing (planning ruling FABLE-r9-lineB-points R2).
export const DONE_ENTRY_OUT = `([ordered]@{ lines = @(${q(STEP_LOGS['first-install.log'].trim())}); stderr = ''; exit = 0 })`;
// reinstall: 'absent' leaves the run without an A8 result at all; steps: false leaves the
// run directory without the first install's logs.
export function m5DrillReceipt(name, paths, { checker = 'FAIL', missing = ['probe.json'], candidate = false, version = '1.2.3', pkg = {}, reinstall = null, steps = true, pre = '' } = {}) {
  const root = path.join(tmp, name);
  const checkerFile = path.join(root, 'test', 'renewal-drill.mjs');
  fs.mkdirSync(path.dirname(checkerFile), { recursive: true });
  fs.writeFileSync(checkerFile, checker === 'PASS' ? `console.log(JSON.stringify({ result: 'PASS' }));`
    : `console.log(JSON.stringify({ result: 'FAIL' })); process.exitCode = 1;`);
  const archive = path.join(root, 'package.tar');
  const files = ['tree/work/independent-ci-resident-v1/windows/install-resident.ps1', ...paths].map(p => ({ path: p, data: Buffer.from(p) }));
  const manifest = { contract: 'clued.independent-ci.fleet-universal/1', version,
    files: files.map(({ path, data }) => ({ path, sha256: sha(data), bytes: data.length })) };
  fs.writeFileSync(archive, writeTar([...files, { path: 'universal-manifest.json', data: Buffer.from(JSON.stringify(manifest)) }]));
  const e = JSON.parse(evidence());
  const run = { first: { ...e, readAt: e.now }, entry: e.entry, launcher: e.launcher, reboot: e.reboot, reinstall: reinstall ?? e.reinstall,
    timings: {}, m5: null };
  if (reinstall === 'absent') delete run.reinstall;
  const receipt = ps(`
    ${pre}
    $script:Drill.Runs = ${q(root)}
    $script:DrillScriptPath = ${q(path.join(root, 'drill', 'drill-vm.ps1'))}
    function Assert-DrillHost { @{ freeGB = 20 } }
    function Invoke-DrillWithHostHold { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Get-DrillIntakeTool { throw 'HOST_HOLD_MUST_NOT_RUN' }
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    $fixture = ${q(JSON.stringify(run))} | ConvertFrom-Json
    $fixture.m5 = @{ directory = 'm5'; missing = @(${missing.map(q).join(', ')}); collectionCode = $null }
    $script:stepLogs = ${q(JSON.stringify(steps ? STEP_LOGS : {}))} | ConvertFrom-Json
    function Invoke-DrillOnCheckpoint { param($Body, $RunDir, $Window)
      foreach ($p in $script:stepLogs.PSObject.Properties) { [IO.File]::WriteAllText((Join-Path $RunDir $p.Name), [string]$p.Value) }
      @{ restored = $true; failure = $null; result = $fixture; hostExecutorStates = @() } }
    $package = @{ version = ${q(version)}; tar = ${q(archive)}; tarSha256 = ${q(pkg.tarSha256 ?? sha(fs.readFileSync(archive)))}; ciSourceManifestSha256 = ${q(S)}; firstInstallKitSha256 = ${q(pkg.firstInstallKitSha256 ?? L)}; candidate = ${candidate ? '$true' : '$false'} }
    $out = Invoke-DrillPreparedRun @{ holdUntil = [DateTimeOffset]::MinValue; deadline = [DateTimeOffset]::MaxValue } $package (${q(JSON.stringify({ ...e.kit, sha256: 'fixture' }))} | ConvertFrom-Json) @{ sha256 = 'fixture' }
    Read-DrillJson $out.receipt
  `);
  return receipt;
}

// Fable ruling 11-19 section 2.2: there is no "not evaluated counts" exit. The applicability test read a hard-coded archive path
// (windows/ci-connection-renew.contract.json) that 3bc571a6 does not have (its contract is under apps/clued-cloud/worker/), so the drill
// of a package WITH the renewal skipped M5 silently. M5 is now collected for every package and the conclusion requires M5 = PASS.
export const RENEWAL_3BC571A6 = ['tree/apps/clued-cloud/worker/ci-connection-renew.contract.json', 'tree/work/independent-ci-resident-v1/src/connection-renewal.mjs',
  'tree/work/independent-ci-resident-v1/windows/SwapBroker.cs', 'tree/work/independent-ci-resident-v1/windows/BrokerPureTests.cs'];

// Fable ruling 11-19 renew-key section 4.3: a candidate's receipt is final BEFORE the Owner accepts. Its A5 is judged in the guest at
// once (the local Source is the request's; that the fleet runs it is the nodes' own concern: they install only the accepted Release and
// recompute the Source), and -Finalize, run right after the drill, judges only A9 (the drill wrote nothing to production). Order:
// drill -> -Finalize -> the Owner accepts -> seal. A re-drill of an accepted version (not a candidate) keeps A5's production half.
export const notTheDrillsSource = () => ({ ...readbackRow, live_sources: ['6'.repeat(64)] });   // a function: readbackRow is declared further down

// Fable renew-key ruling, supplements "merge order" and "heartbeat token and restart code": the drill is held to the package it drills.
// The package declares required and optional credential names; the drill gives every required one, and has an explicit decision for every
// optional one (give, or withhold by design with the reason); otherwise no boot. The heartbeat token is withheld: no fake one is made.
export const decisionsOf = () => ps(`$script:DrillCredentialDecisions`);
export const planOf = credentials => ps(`try { Get-DrillCredentialPlan (${q(JSON.stringify({ credentials }))} | ConvertFrom-Json) } catch { $c = Get-DrillCode $_; [ordered]@{ code = $c.code; detail = $c.detail } }`);

// The candidate path end to end against the real seal (cross test, ruling renew-key 4.5 item 3): receipts that drill-vm.ps1's own
// conclusion function wrote, fed to publish.mjs seal --drill-receipt. Finalized: taken. Not read back yet: refused, nothing changes.
export async function sealWorld(t) {
  const d = fs.mkdtempSync(path.join(tmp, 'seal-'));
  const version = '2026.11.12-1', tag = `fleet-node-${version}`, commit = 'a1'.repeat(20), fleet = 'tree/work/independent-ci-resident-v1/rollout/fleet/';
  const out = path.join(d, 'out'); fs.mkdirSync(out);
  const tar = writeTar([{ path: `${fleet}bootstrap.ps1`, data: Buffer.from('# bootstrap\r\n') },
    { path: `${fleet}prereq-manifest.json`, data: Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-prereq-manifest/1', items: [] }) + '\n') },
    { path: 'universal-manifest.json', data: Buffer.from('{}') }]);
  const source = { version, release_tag: tag, archive_sha256: sha(tar), commit, resident_manifest_sha256: '2'.repeat(64), source_manifest_sha256: '3'.repeat(64),
    upgrader_manifest_sha256: '4'.repeat(64), bundle_sha256: '5'.repeat(64), universal_files_sha256: '6'.repeat(64) };
  const release = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-release/1', source, archive: { name: `${tag}.tar`, bytes: tar.length, sha256: sha(tar) } }) + '\n');
  fs.writeFileSync(path.join(out, `${tag}.tar`), tar);
  fs.writeFileSync(path.join(out, `${tag}.release.json`), release);
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${sha(release)}  ${tag}.release.json\n${sha(tar)}  ${tag}.tar\n`);
  const index = path.join(d, 'index.md');
  fs.writeFileSync(index, '| 版本 | Release | tar sha256 | commit | 接受时间 |\r\n|---|---|---|---|---|\r\n');
  const fake = path.join(d, 'fake-gh.mjs'); fs.writeFileSync(fake, FAKE_GH);
  const saved = { FAKE_GH_STATE: process.env.FAKE_GH_STATE, GH_TOKEN: process.env.GH_TOKEN };
  process.env.FAKE_GH_STATE = path.join(d, 'gh-state.json'); delete process.env.GH_TOKEN;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const gh = [process.execPath, fake];   // no release step: prepare makes the Release and the index row
  const image = 'e'.repeat(64), imageFile = path.join(d, `role-image-${image}.tar.gz`); fs.writeFileSync(imageFile, 'gzip of a docker save');
  const U = n => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  const deps = { readKit: () => ({}), sourceHash: async () => ({ ciSourceManifestSha256: S }),
    kitOf: async () => ({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', template: {}, config: { ciSourceManifestSha256: L }, images: { pull: [], local: [{ id: image, asset: `role-image-${image}.tar.gz` }] } }),
    fleetMaterial: async () => ({ formalRoles: { gitleaks: {}, trivy: {}, 'contract-placement': {} },
      installed: { sourceAcceptanceRef: U(5), hostQualificationRef: U(6), ownerAuthorizationRef: U(5), publisherQualificationRef: U(5), ownerPackageAcceptanceRef: U(5), ciSourceManifestSha256: L } }) };
  const accept = path.join(d, 'accept');
  await prepare({ version, dir: out, out: accept, images: [imageFile], index, ghCommand: gh, deps });
  const requestFile = path.join(accept, `${tag}.acceptance-request.json`);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  // the Decision record as DESK exports it (the shape of the real clued_record_mutate return PR-乙's tests pin), naming this request
  const record = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../rollout/fleet/test/fixtures/clued-decision-mutate-3bc571a6.json', import.meta.url)), 'utf8'));
  record.supplemental.record.content = `TEST TEXT: the Owner accepts.\n${requestLineOf(version, sha(fs.readFileSync(requestFile)))}\n`;
  const decisionRecord = path.join(d, 'decision-record.json'); fs.writeFileSync(decisionRecord, JSON.stringify(record, null, 2));
  const sealIt = drillReceipt => seal({ request: requestFile, decisionRecord, index, ghCommand: gh, deps, drillReceipt });
  return { d, version, request, index, sealIt };
}

// Candidate run stubs. A8 has no skip any more (FABLE-drill-r13-a8-m5 1.3): a candidate runs A8 like any run and needs it true.
export const candidateStubs = `
    $Version = '1.2.3'; $From = 'unused'; $Kit = 'unused'
    function Read-DrillPrereq { @{ sha256 = 'pin' } }
    function Read-DrillKit { @{ prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' }; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) } }
    function Test-DrillPackageDir { @{ tar = 'unused'; candidate = $true } }
    function Get-DrillReleaseFiles { @('unused') }
    function Assert-DrillHost { throw (New-DrillError 'TEST_REACHED_HOST_GATE') }
    # never the real host hold, whatever the code does (Clued Task fe8a2cbf)
    function Invoke-DrillWithHostHold { throw (New-DrillError 'TEST_REACHED_HOST_HOLD') }
    function Get-DrillIntakeTool { throw (New-DrillError 'TEST_REACHED_HOST_HOLD') }
    function Assert-DrillKitCredentialsBound { }
    function Assert-DrillServerReady { }
    function Assert-DrillKitToolsBound { }`;

// One world for the WSL side: this host's runner distribution Fixture-CI (registered, running), a probe answering `probe` (exit, stderr,
// or a throw as a time out does), a running list answering `list`. Its host status is written at T0, the time ps() fixes for the
// drill's clock: the world is built once when this file loads, and its tests may run long after that (CI run 44746396297) without
// it aging, because nothing in it reads the real clock.
export const wslWorld = `
    function Read-DrillHostStatus { ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction) @{ FreePhysicalMemory = 64GB / 1KB } }
    function Get-VM { param($ErrorAction) }
    function Get-Process { param($ErrorAction) [pscustomobject]@{ ProcessName = 'Runner.Listener' } }
    function Get-DrillRunnerDistributions { param($HostName) 'Fixture-CI' }
    function Get-DrillWslRegisteredNames { 'docker-desktop'; 'Fixture-CI' }
    $script:calls = [Collections.Generic.List[string]]::new()
    $script:list = @{ exit = 0; stdout = "Fixture-CI\`r\`n"; stderr = '' }
    $script:DrillWslRunner = { param($a)
      $script:calls.Add($a -join ' ')
      if ($a[0] -ceq '--list') { return $script:list }
      if ($script:probe -eq 'timeout') { throw 'wsl.exe timed out' }
      return $script:probe
    }`;

// The release command is run for real in these tests by Git's POSIX sh (never the distribution's), with stand-ins for pgrep (its exit) and
// sync first on PATH, and its one write pointed into the stand-ins' directory.
export const gitSh = ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(f => fs.existsSync(f));
export const shOpts = { skip: !windows ? true : (gitSh ? false : 'Git sh not found') };
export const msys = p => p.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
export function shWorld(name, { pgrep = 1, sync = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, `sh-${name}-`));
  fs.writeFileSync(path.join(dir, 'pgrep'), `#!/bin/sh\nexit ${pgrep}\n`);
  fs.writeFileSync(path.join(dir, 'sync'), `#!/bin/sh\necho synced > '${msys(dir)}/synced'\nexit ${sync}\n`);
  return { prefix: `PATH=${msys(dir)}:/usr/bin:/bin; `, drop: `${msys(dir)}/drop_caches`,
    synced: () => fs.existsSync(path.join(dir, 'synced')), dropped: () => fs.existsSync(path.join(dir, 'drop_caches')) };
}
export const commandIn = (world, command) => world.prefix + command.split('/proc/sys/vm/drop_caches').join(world.drop);

// Fable renew-key ruling, supplements "WSL runner jobs" item 3 and "WSL gate race" item 3 (the order unchanged by round four): early
// refusal (hold, resident idle, no job on either side; no memory) -> the release -> the boot gate (both sides again, then memory, judged
// once, then the boot), from the real entry on, with the real host guard; the release command run by Git's sh.
// running: the runner distribution is in `wsl --list --running` (false: registered, not running); runners: this host has one at all
// (false: Get-DrillRunnerDistributions finds none); wslConfig: the text of the Owner's .wslconfig the boot gate reads for a runner
// distribution that is not running (null: no file there).
export function preBootWorld({ freeBeforeRelease = 10, freeAfterRelease = 64, meminfo = MEMINFO, running = true, runners = true, wslConfig = null } = {}) {
  const quiet = shWorld('preboot-quiet', { pgrep: 1 });
  const job = shWorld('preboot-job', { pgrep: 0 });
  const status = path.join(fs.mkdtempSync(path.join(tmp, 'preboot-status-')), 'status.json');
  // Written at T0 and read by the host guard too, in its own runspace, by the clock of the run that started it (ps(): T0).
  fs.writeFileSync(status, idleHostStatus());
  const wslConfigPath = path.join(fs.mkdtempSync(path.join(tmp, 'preboot-wslconfig-')), '.wslconfig');
  if (wslConfig !== null) fs.writeFileSync(wslConfigPath, wslConfig);
  return `
    $script:Drill.WslConfig = ${q(wslConfigPath)}
    $script:events = [Collections.Generic.List[string]]::new()
    $script:released = $false
    $script:Drill.Runs = ${q(fs.mkdtempSync(path.join(tmp, 'preboot-')))}
    $script:Drill.HostStatus = ${q(status)}
    $script:Drill.HostGuardSeconds = 3600
    function Read-DrillHostStatus { $script:events.Add('status'); ${q(idleHostStatus())} }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction)
      $script:events.Add('memory'); @{ FreePhysicalMemory = $(if ($script:released) { ${freeAfterRelease}GB } else { ${freeBeforeRelease}GB }) / 1KB } }
    function Get-VM { param($ErrorAction) }
    function Get-Process { param($ErrorAction) $script:events.Add('windows-processes'); $n = @('Runner.Listener'); if ($script:windowsJobAfter -ge 0 -and @($script:events | Where-Object { $_ -ceq 'wsl-probe' }).Count -ge $script:windowsJobAfter) { $n += 'Runner.Worker' }; $n | ForEach-Object { [pscustomobject]@{ ProcessName = $_ } } }
    function Get-DrillRunnerDistributions { param($HostName) ${runners ? "'Fixture-CI'" : ''} }
    function Get-DrillWslRegisteredNames { 'Fixture-CI' }
    $script:jobAfter = -1; $script:windowsJobAfter = -1; $script:wslMemoryFails = $false
    $script:releaseSent = [Collections.Generic.List[string]]::new()
    $script:worlds = @{ quiet = ${q(quiet.prefix)} + '|' + ${q(quiet.drop)}; job = ${q(job.prefix)} + '|' + ${q(job.drop)} }
    $script:DrillWslRunner = { param($a)
      $j = $a -join ' '
      if ($a -contains '--terminate' -or $a -contains '-t' -or $a -contains '--shutdown' -or $a -contains '--unregister') { $script:events.Add('STOP ' + $j); return @{ exit = 0; stdout = ''; stderr = '' } }
      if ($j -ceq '--list --running --quiet') { $script:events.Add('wsl-running'); return @{ exit = 0; stdout = ${running ? '"Fixture-CI\`r\`n"' : "''"}; stderr = '' } }
      $job = $script:jobAfter -ge 0 -and @($script:events | Where-Object { $_ -ceq 'wsl-probe' }).Count -ge $script:jobAfter
      if ($j -ceq '--distribution Fixture-CI --exec pgrep -ix Runner[.]Worker') { $script:events.Add('wsl-probe'); return @{ exit = $(if ($job) { 0 } else { 1 }); stdout = ''; stderr = '' } }
      if ($j -ceq '--distribution Fixture-CI --exec cat /proc/meminfo') { $script:events.Add('wsl-meminfo')
        if ($script:wslMemoryFails) { return @{ exit = 1; stdout = ''; stderr = 'cat: /proc/meminfo: Input/output error' } }; return @{ exit = 0; stdout = ${q(meminfo)}; stderr = '' } }
      if ($j -ceq '--distribution Fixture-CI --exec pgrep -cix Runner[.]Worker') { $script:events.Add('wsl-count'); return @{ exit = $(if ($job) { 0 } else { 1 }); stdout = "$(if ($job) { 1 } else { 0 })\`n"; stderr = '' } }
      if ($a.Count -eq 8 -and ($a[0..6] -join ' ') -ceq '--distribution Fixture-CI --user root --exec sh -c' -and
          ($a[7] -ceq $script:DrillWslReleaseCommand -or $a[7] -ceq (Get-Variable -Name DrillWslIdleReleaseCommand -Scope Script -ValueOnly -ErrorAction SilentlyContinue))) {
        $script:releaseSent.Add($(if ($a[7] -ceq $script:DrillWslReleaseCommand) { 'running' } else { 'idle' }))
        $prefix, $drop = $script:worlds[$(if ($job) { 'job' } else { 'quiet' })] -split '\\|'
        $r = Invoke-DrillProcess ${q(gitSh ?? 'sh.exe')} @('-c', ($prefix + $a[7].Replace('/proc/sys/vm/drop_caches', $drop))) 60
        $script:events.Add('wsl-release exit ' + $r.exit)
        if ($r.exit -eq 0) { $script:released = $true }
        return $r
      }
      $script:events.Add('unexpected: ' + $j); return @{ exit = 1; stdout = ''; stderr = '' }
    }
    function Test-DrillHyperVAdministrator { $true }
    function Get-PSDrive { param($Name) @{ Free = 1TB } }
    function Get-VMSwitch { param($Name, $ErrorAction) 'switch' }
    function Invoke-DrillBaseline { param($RunDir, [switch]$ExistingOnly) [ordered]@{ action = 'ready' } }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; notes = $script:Drill.Marker; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Restore-VMCheckpoint { param($VMName, $Name, $Confirm) $script:events.Add('restore') }
    function Start-DrillBootWatchdog { @{ signal = ${q(path.join(tmp, 'preboot-signal'))}; process = $null } }
    function Assert-DrillWatchdogAlive { param($Watchdog) }
    function Start-VM { param($Name, $ErrorAction) $script:events.Add('boot') }
    function Get-DrillCredential { }
    function Wait-DrillGuest { }
    function Invoke-DrillGuest { $true }
    function Invoke-DrillPrereqInGuest { param($RunDir, $Prereq, $Cred) 'prereq ran' }
    function Stop-DrillGuardedVm { param($Guard, [switch]$RestoreCheckpoint) $script:events.Add('restore-end'); return $true }
    $script:PrereqOnly = $true
    function Invoke-Entry {
      $script:releaseSent.Clear()
      $out = Invoke-DrillPreparedRun @{ safeToResume = $true; deadline = [DateTimeOffset]::UtcNow.AddMinutes(10); holdUntil = [DateTimeOffset]::MinValue } @{ version = 'x' } @{ sha256 = 'kit' } @{ sha256 = 'prereq' }
      @{ events = @($script:events); out = $out; releases = @($script:releaseSent) }
    }`;
}
export const early = ['status', 'windows-processes', 'wsl-running', 'wsl-probe'];
export const bootGate = ['status', 'windows-processes', 'wsl-running', 'wsl-probe', 'memory'];
// the runner distribution's memory, read for the boot gate's sample right before the gate (Get-DrillWslMemory)
export const gateMemory = ['wsl-running', 'wsl-meminfo', 'wsl-count'];
export const WSL_MEMORY = { distribution: 'Fixture-CI', memTotalGB: 28, memFreeGB: 6.5, cachedGB: 16, anonPagesGB: 5 };

// T2 and T3 (Fable plan 0e418483 "drill boot gate: memory only", section 2.2): before the host hold -- no intake requested, no watchdog,
// no VM touched -- the drill waits for memory, reading the host's free memory every BootWaitPollSeconds against the boot gate's 15 GB, for
// at most BootWaitMinutes; the boot gate in Start-DrillGuardedVm still judges once. From the real entry (Invoke-DrillMain, -PrereqOnly),
// with an injected monotonic clock and sleep; each reading of the wait is counted in the receipt's hostPreBoot.wait.
export const bootWaitWorld = (frees) => `${preBootWorld()}
    $script:frees = [Collections.Generic.Queue[double]]::new(); foreach ($g in @(${frees.join(', ')})) { $script:frees.Enqueue($g) }
    function Get-CimInstance { param($ClassName, $OperationTimeoutSec, $ErrorAction)
      $script:events.Add('memory'); $g = if ($script:frees.Count -gt 1) { $script:frees.Dequeue() } else { $script:frees.Peek() }
      @{ FreePhysicalMemory = [long]($g * 1GB / 1KB) } }
    $script:mono = 1000.0; $script:slept = [Collections.Generic.List[int]]::new()
    function Get-DrillMonotonicSeconds { $script:mono }
    function Start-Sleep { param([int]$Seconds, [int]$Milliseconds)
      if ($Seconds) { $script:slept.Add($Seconds); $script:mono += $Seconds } else { Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds $Milliseconds } }
    $script:intake = [Collections.Generic.List[string]]::new()
    $env:CLUED_UNDER_TEST = '1'
    $script:DrillIntakeSender = { param($Tool, $Verb, $Minutes, $Arguments) $script:intake.Add($Verb)
      @{ exit = 0; stdout = $(if ($Verb -ceq 'pause') { '{"status":"INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES"}' } else { '{"status":"INTAKE_RESUME_REQUESTED"}' }) } }
    function Get-DrillIntakeTool { @{ root = 'C:/clued-drill-test-nowhere'; node = 'C:/clued-drill-test-nowhere/node.exe'; tool = 'C:/clued-drill-test-nowhere/rearm-tool.mjs' } }
    function Read-DrillPrereq { param($Dir) @{ sha256 = 'prereq' } }
    $script:Drill.IntakeWaitMinutes = 0
    $script:jobAfter = 0`;

export function packageDir(name, { tarBytes = 'tar', accSha, sumsSha } = {}) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir);
  const v = '1.2.3'; const tag = `fleet-node-${v}`;
  fs.writeFileSync(path.join(dir, `${tag}.tar`), tarBytes);
  const s = sha(tarBytes);
  fs.writeFileSync(path.join(dir, `${tag}.acceptance.json`), JSON.stringify({ contract: 'clued.independent-ci.fleet-node-acceptance/1', version: v,
    archive_sha256: accSha ?? s, ciSourceManifestSha256: '5'.repeat(64) }));
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sumsSha ?? s}  ${tag}.tar\n`);
  return { dir, v, s };
}

export function kitDir(name, mutate = (k) => k) {
  const dir = path.join(tmp, name); fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'entry.ps1'), 'param() "{}"');
  fs.writeFileSync(path.join(dir, 'tools', 'a.bin'), 'a');
  const kit = mutate({ contract: 'clued.drill.first-install-kit/1',
    files: [{ path: 'entry.ps1', sha256: sha('param() "{}"') }, { path: 'tools\\a.bin', sha256: sha('a') }],
    entry: { file: 'entry.ps1', arguments: ['-From', '{from}', '-Fake', '{fake}', '-Version', '{version}'] },
    timeoutMinutes: 120, perNodeSteps: ['reinstall/README.md 8c step 2 (root, WSL)'], prereqSha256: 'e'.repeat(64) });
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(kit));
  return dir;
}

export function prereqDir(name, mutate = (p) => p) {
  const dir = path.join(tmp, name); fs.mkdirSync(path.join(dir, 'debs'), { recursive: true });
  const put = (rel, body) => { fs.writeFileSync(path.join(dir, rel), body); return sha(body); };
  const p = mutate({ contract: 'clued.drill.prereq/1', distribution: 'CluedResident-Linux',
    wsl: { path: 'wsl.2.7.13.0.x64.msi', sha256: put('wsl.2.7.13.0.x64.msi', 'msi'), url: 'https://github.com/microsoft/WSL/releases/download/2.7.13/wsl.2.7.13.0.x64.msi', version: '2.7.13.0' },
    rootfs: { path: 'ubuntu-24.04.5-wsl-amd64.wsl', sha256: put('ubuntu-24.04.5-wsl-amd64.wsl', 'rootfs'), url: 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl' },
    debs: [{ path: 'debs\\docker.io_29.1.3_amd64.deb', sha256: put('debs/docker.io_29.1.3_amd64.deb', 'deb'), url: 'http://archive.ubuntu.com/ubuntu/pool/universe/d/docker.io-app/docker.io_29.1.3_amd64.deb' }] }, dir, put);
  fs.writeFileSync(path.join(dir, 'prereq.json'), JSON.stringify(p));
  return dir;
}

export const NOW = '2026-11-16T03:00:00Z';
export const S = '5'.repeat(64), L = '7'.repeat(64);
// The pause the launcher confirmed (its terminal's pause.requestSha256) and state\PAUSED.json naming that request: a first install that
// succeeded ends paused by its own request (Fable renew-key ruling, supplement "eight on the path", item 5).
export const PAUSE_REQUEST = '9'.repeat(64);
// A stand-in for windows/verify-resident.ps1 that keeps the real rule on the pause (verify-resident.ps1, 'paused-as-expected' /
// 'not-paused'): -ExpectPausedSha256 given, state\PAUSED.json must be there with exactly that sha256; not given, any PAUSED.json is a
// failure. Its JSON is the real one's shape ({status, checks: {name: {ok, detail}}}); fake-verify-checks.json beside the root's state, if
// there, puts its checks first (where the real verify's first fifty sit, beyond the last 40 lines of its stdout). A note goes to stderr.
// Task 87d330d0 (drill r13 A2): the stand-in before this took no pause parameter and printed RESIDENT_VERIFIED, which hid that the
// drill's read never told verify the node is meant to be paused.
export const FAKE_VERIFY = String.raw`param($ExpectedInstallReceiptSha256, $LinuxVersionFactsFile, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectPausedSha256)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$checks = [ordered]@{}
$extra = Join-Path $root 'fake-verify-checks.json'
if (Test-Path -LiteralPath $extra) { foreach ($p in (Get-Content -LiteralPath $extra -Raw | ConvertFrom-Json).PSObject.Properties) { $checks[$p.Name] = [ordered]@{ ok = $p.Value.ok; detail = $p.Value.detail } } }
$checks['not-halted'] = [ordered]@{ ok = (-not (Test-Path -LiteralPath (Join-Path $root 'state\HALT.json'))); detail = $null }
$pausedFile = Join-Path $root 'state\PAUSED.json'
if ($ExpectPausedSha256) { $checks['paused-as-expected'] = [ordered]@{ ok = ((Test-Path -LiteralPath $pausedFile -PathType Leaf) -and ((Get-FileHash -LiteralPath $pausedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExpectPausedSha256)); detail = $null } }
else { $checks['not-paused'] = [ordered]@{ ok = (-not (Test-Path -LiteralPath $pausedFile)); detail = $null } }
$ok = -not ($checks.Values | Where-Object { $_.ok -ne $true })
[Console]::Error.WriteLine('verify: a note on stderr')
[ordered]@{ status = $(if ($ok) { 'RESIDENT_VERIFIED' } else { 'RESIDENT_VERIFICATION_FAILED' }); checks = $checks } | ConvertTo-Json -Depth 6
exit $(if ($ok) { 0 } else { 1 })
`;

// A guest work directory for Save-DrillGuestEvidence: the stub runs the real guest reader ($script:GuestStageFiles) over it.
export function guestWorkDir(name, files) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  for (const [n, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), text);
  return dir;
}
// What the entry writes right before the launcher stage (Invoke-EntryWslColdStart): part of every complete set of stage files.
export const WSL_COLD_START = JSON.stringify({ at: '2026-11-21T03:00:00Z', shutdown: { exit: 0, timedOut: false, stdout: '', stderr: '' },
  runningAfter: { exit: 0, timedOut: false, stdout: '', stderr: '' } });

// K3 (task 87d330d0): the companion up by itself after the reboot, nobody logged on -- all five, under the password definition
export const COMPANION_AFTER_BOOT = { boot: '2026-11-16T02:45:00Z', definition: 'password', interactiveSessions: 0,
  startTask: { lastRun: '2026-11-16T02:45:40Z', lastResult: 0 }, companionState: 4, companionInstances: [{ state: 4, enginePid: 4120 }],
  supervisors: [{ pid: 4120, owner: 'clued-companion', created: '2026-11-16T02:45:41Z' }], errors: {} };
export function evidence(over = {}) {
  const status = { writtenAt: '2026-11-16T02:59:50Z', node: { mode: 'STANDBY' }, executor: { state: 'PAUSED' }, paused: true, current: null, queue: { live: 0 }, halt: null,
    versions: { selfcheck: { result: 'PASS', observedAt: '2026-11-16T02:50:00Z' } } };
  const e = { now: NOW, entry: { exitCode: 0, status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe', parsed: true },
    verify: { status: 'RESIDENT_VERIFIED', expectPausedSha256: '4'.repeat(64), failed: [] }, status, current: { generation: 1, ciSourceManifestSha256: S, linux: { manifestSha256: L } },
    facts: { generation: 1, staged: null, pinsOk: true, ciSourceManifestSha256: S, manifestSha256: L }, acceptanceSource: S,
    launcher: { status: 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', role: 'not-held', completed: ['pause-confirmed', 'first-train-not-applicable'], pause: { confirmed: true, requestSha256: PAUSE_REQUEST, paused: { sha256: '4'.repeat(64) } } },
    firstInstallSteps: { missing: false, incomplete: false, incompleteStages: [] },
    pause: { sha256: '4'.repeat(64), requestSha256: PAUSE_REQUEST },
    reboot: { ok: true, status, readAt: NOW, boot: '2026-11-16T02:45:00Z', companionAfterBoot: COMPANION_AFTER_BOOT }, reinstall: { upgradeStatus: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', upgradeExit: 0,
      prepareStatus: 'FLEET_NODE_INSTALL_REFUSED', prepareCode: 'NEW_SOURCE_IS_THE_INSTALLED_ONE', prepareExit: 1 }, kit: { perNodeSteps: ['8c step 2'], credentials: PACKAGE_CREDENTIALS } };
  return JSON.stringify(Object.assign(e, over));
}
// Build the evidence hashtable in PowerShell from JSON (nested objects as PSCustomObject, as the guest reads give them).
export const verdictOf = (json) => ps(`$j = ${q(json)} | ConvertFrom-Json; $h = @{}; foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = $p.Value };
  $h.now = [DateTimeOffset]::Parse($j.now); $items = Get-DrillVerdict $h; [ordered]@{ items = @($items); conclusion = (Get-DrillConclusion $items @{ result = 'PASS' }) }`);
export const pass = (r) => Object.fromEntries(r.items.map((i) => [i.id, i.pass]));

// A tree whose fleet tools are stand-ins run by the real node: each writes a line on stderr (the A8 children are read with stdout and
// stderr apart: Fable renew-key ruling, supplement "eight on the path", the drill's own six merged calls). install.mjs answers with the
// JSON line and exit code the test puts in prepare-answer.json (A8 runs nothing after the prepare: FABLE-drill-r13-a8-m5 1.3).
export function mockFleetTree(name) {
  const tree = path.join(tmp, name);
  const fleet = path.join(tree, 'work', 'independent-ci-resident-v1', 'rollout', 'fleet');
  fs.mkdirSync(fleet, { recursive: true });
  fs.writeFileSync(path.join(fleet, 'upgrade.mjs'),
    "process.stderr.write('upgrade: a note on stderr\\n'); console.log(JSON.stringify({ status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE' }));\n");
  fs.writeFileSync(path.join(fleet, 'install.mjs'), [
    "import fs from 'node:fs';",
    "process.stderr.write('prepare: a note on stderr\\n');",
    "const { answer, exit } = JSON.parse(fs.readFileSync(new URL('./prepare-answer.json', import.meta.url), 'utf8'));",
    "console.log(JSON.stringify(answer)); process.exitCode = exit;", ''].join('\n'));
  return { tree, fleet };
}

// Plan 87d330d0 1.3 (PR-2): after a phase-A failure the probe's first command may be the one that wakes the instance; it reads the boot
// without systemctl, bounded at 120 seconds of its own, and takes the journal by boot, never by a wall-clock time (S0b: it jumps across a
// suspend, the monotonic clock does not).
export const PROBE_FILES = `-ImageIds @('sha256:${'a'.repeat(64)}') -Files @('/usr/bin/python3.12')`;

// Review of 28896055d (M1, M2): the wsl.exe bound (120 s) throws away everything the command printed, the compact block with it. So the
// guest's own bounds, kill grace included, end well before it (<= 90 s: room for a cold WSL start), and each one kills what ignores TERM.
export const bootBounds = () => [...ps(`(Get-DrillProbeCommands)[0].script`).matchAll(/\btimeout ([^;|]*?)journalctl/g)].map(m => m[1].trim());
export const secondsOf = (v) => Number(/^(\d+)s$/.exec(v)?.[1] ?? NaN);

export const probeNative = `$native = { param($exe, $argv, $secs, $enc)
    $s = [string]$argv[[array]::IndexOf([string[]]$argv, '-c') + 1]
    [IO.File]::AppendAllText($env:PROBE_SECS, [string]$secs + "\`n")
    if ($env:PROBE_HANG -and $s -match $env:PROBE_HANG) { throw ('COMMAND_TIMEOUT_NOTHING_KILLED: wsl.exe') }
    [pscustomobject]@{ exit = 0; stdout = 'ok'; stderr = '' } }`;

export const startedAt = '2026-11-16T02:00:00Z';
export const readbackRow = { nodes_changed: 0, failover_marked: 0, roles_changed: 0, bindings_created: 0, drill_liveness: 0, live_sources: [S] };
export const readbackFor = (row = readbackRow, start = startedAt) => ({ contract: 'clued.drill.production-readback/1', startedAt: start, row });
export function finalize(name, fields, row = readbackRow) {
  const receipt = { contract: 'clued.independent-ci.drill-receipt/1', startedAt, evidence: { localSource: S },
    failure: null, restoredToCheckpoint: true, conclusion: 'PENDING_PRODUCTION_READBACK', m5: { result: 'PASS' }, ...fields };
  const receiptFile = path.join(tmp, `${name}.json`);
  const readback = path.join(tmp, 'readback.json');
  const original = JSON.stringify(receipt);
  fs.writeFileSync(receiptFile, original);
  fs.writeFileSync(readback, JSON.stringify(readbackFor(row, receipt.startedAt)));
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Finalize', receiptFile, '-ProductionReadback', readback], { encoding: 'utf8', timeout: 120000 });
  const bytes = fs.readFileSync(receiptFile, 'utf8');
  return { receipt, receiptFile, original, bytes, status: run.status, output: JSON.parse(run.stdout.trim()) };
}

// ---- Fable plan 87d330d0 section 3, block A (host early stop and evidence; D:/w/tmp/PLAN-drill-loop-root-20261123.md 2.2 A1-A4, 2.4) ----
// The first install on a fake guest under a fake guard, on a fake clock: the run's own Invoke-DrillOnCheckpoint and Invoke-DrillRun, the
// real Invoke-DrillGuest and the real evidence collection; only Hyper-V, PowerShell Direct and the guard's runspace are stubbed. Every guest
// job but the entry's answers at once (the stage-file reader runs for real over the guest directory); the entry's never returns. Wait-Job
// moves the clock by its timeout, appends the guest's log lines that are due (grow: [seconds, file, line]) and, at fireAt seconds, fires the
// guard as the real one does at its deadline or on short memory: the failure latched, host-guard.json DRILL_ABORTED with the checkpoint
// restored, the guest gone (the entry job fails; every later guest call stops on Assert-DrillGuard). The run's limit (-RunTimeoutMinutes)
// is deadlineSeconds / 60, the guard's deadline deadlineSeconds after the boot.
export const EARLY_ENTRY_LOG = '{"name":"assets","result":"ok","rejectCode":null,"detail":null}\r\n{"name":"prereq","result":"ok","rejectCode":null,"detail":null}\r\n';
export const earlyHostLine = (n) => JSON.stringify({ name: `host-step-${n}`, result: 'ok', rejectCode: null, detail: null, at: new Date(Date.parse(T0) + n * 1000).toISOString() });
// Options past the first five (all off by default, as before):
//   pullFail      a PowerShell condition over $script:now: the progress pull at that time does not answer (its job never completes)
//   removeBlocks  Remove-Job on a job still running costs 300 s and is recorded (remove-running-job): a synchronous StopJob on a
//                 PowerShell Direct job of a busy guest
//   entryDoneAt   the entry returns at this second with FIRST_INSTALL_DONE (else it never returns)
//   read          what the read after the install returns (an object)
//   rebootNeverBack  after A7's reboot the guest does not come back: the wait takes the clock to this second and fails
//   slowReadsAfter   from this second on, the evidence reads do not answer (the guard's deadline overtakes them)
//   receipt       the run goes through the real Invoke-DrillPreparedRun into a runs directory (receipt.json), and the next run's
//                 ladder step is derived from that receipt by the real Get-DrillLadderStep
export function earlyStopRun(name, { guest, grow = [], fireAt, fireCode, deadlineSeconds, pullFail = '$false', removeBlocks = false, entryDoneAt = null,
    read = null, rebootNeverBack = null, slowReadsAfter = null, receipt = false }) {
  const runsRoot = receipt ? fs.mkdtempSync(path.join(tmp, `early-stop-${name}-runs-`)) : null;
  const runDir = receipt ? '' : fs.mkdtempSync(path.join(tmp, `early-stop-${name}-`));
  const guestDir = guestWorkDir(`early-stop-${name}-guest`, guest);
  const signal = path.join(tmp, `early-stop-${name}-signal`);
  const growPs = grow.map(([at, file, line]) => `@{ at = ${at}; file = ${q(file)}; line = ${q(line)}; done = $false }`).join(', ');
  const doneLine = JSON.stringify({ status: 'FIRST_INSTALL_DONE', stopCode: null, tree: 'C:\\t', node: 'C:\\n.exe' });
  const tail = receipt ? `
    $Version = '1.2.3'; $script:Drill.Runs = ${q(runsRoot)}
    function Invoke-DrillBaseline { @{ action = 'reuse' } }
    $done = Invoke-DrillPreparedRun $window $package $earlyKit @{ sha256 = 'pin' }
    $receipt = Read-DrillJson $done.receipt
    $ladderStep = try { Get-DrillLadderStep ${q(runsRoot)} '1.2.3' 'kit-ladder' } catch { $c = Get-DrillCode $_; [ordered]@{ code = $c.code; detail = $c.detail } }
    @{ failure = $receipt.failure; now = $script:now; events = @($script:events); timeline = $receipt.evidence.stageTimeline; ladder = $ladderStep; receipt = $done.receipt
       runDir = (Split-Path -Parent $done.receipt) }` : `
    $out = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillRun ${q(runDir)} $package $earlyKit $null $cred $window.deadline } ${q(runDir)} $window
    $sf = Join-Path ${q(runDir)} 'stage-files.json'; $ge = Join-Path ${q(runDir)} 'guest-evidence.json'
    @{ failure = $out.failure; restored = $out.restored; now = $script:now; events = @($script:events); guard = (Get-DrillGuardOutcome ${q(runDir)})
       stageFiles = $(if (Test-Path -LiteralPath $sf) { Read-DrillJson $sf } else { $null }); guestEvidence = $(if (Test-Path -LiteralPath $ge) { Read-DrillJson $ge } else { $null })
       files = @(Get-ChildItem -LiteralPath ${q(runDir)} -File | ForEach-Object { $_.Name })
       timeline = $(if (Get-Command Get-DrillStageTimeline -ErrorAction SilentlyContinue) { Get-DrillStageTimeline ${q(runDir)} } else { $null }) }`;
  const r = ps(`
    $script:now = 0.0; $script:events = [Collections.Generic.List[string]]::new()
    $RunTimeoutMinutes = ${deadlineSeconds / 60}
    function Get-DrillTime { ([DateTimeOffset]${q(T0)}).AddSeconds($script:now) }
    function Get-DrillMonotonicSeconds { [double]$script:now }
    $script:grow = @(${growPs})
    $script:fireAt = ${fireAt}; $script:fireCode = ${q(fireCode)}
    $script:pullFail = { ${pullFail} }; $script:removeBlocks = ${removeBlocks ? '$true' : '$false'}
    $script:entryDoneAt = ${entryDoneAt ?? '$null'}; $script:rebootNeverBack = ${rebootNeverBack ?? '$null'}; $script:slowReadsAfter = ${slowReadsAfter ?? '$null'}
    $script:read = ${read ? `(${q(JSON.stringify(read))} | ConvertFrom-Json)` : '$null'}
    $script:entryOut = [ordered]@{ lines = @(${q(doneLine)}); stderr = ''; exit = 0 }
    $script:fakeRunDir = ${q(runDir)}
    function Update-FakeGuest { foreach ($g in $script:grow) { if (-not $g.done -and $g.at -le $script:now) { [IO.File]::AppendAllText((Join-Path ${q(guestDir)} $g.file), $g.line + [Environment]::NewLine); $g.done = $true } } }
    function Invoke-FakeGuard {
      $script:HostGuard.state.failure = @{ code = $script:fireCode; detail = 'fixture guard' }
      Write-DrillJson (Join-Path $script:fakeRunDir 'host-guard.json') ([ordered]@{ status = 'DRILL_ABORTED'; code = $script:fireCode; restoredToCheckpoint = $true; stopped = $true; cleanupDone = $true })
      $script:events.Add('guard-restore')
    }
    function Invoke-DrillPreBootRelease { param($HoldUntil) }
    function Get-DrillVmInfo { @{ vm = @{ Id = [guid]::Empty }; notes = $script:Drill.Marker; state = 'Off'; checkpoints = @($script:Drill.Checkpoint) } }
    function Restore-VMCheckpoint { param($VMName, $Name, $Confirm) }
    function Assert-DrillHost { }
    function Get-DrillCredential { }
    function Start-DrillHostGuard { param($RunDir, [switch]$RestoreCheckpoint, $Window)
      $script:fakeRunDir = $RunDir
      $script:HostGuard = @{ state = [hashtable]::Synchronized(@{ ready = $true; armed = $true; stop = $false; failure = $null; executorStates = [ordered]@{}; deadline = $Window.deadline }); pending = @{ IsCompleted = $false } }
      return $script:HostGuard
    }
    function Stop-DrillHostGuard { param($Guard) $script:HostGuard = $null }
    function Start-DrillBootWatchdog { @{ signal = ${q(signal)}; process = $null } }
    function Start-DrillGuardedVm { param($Watchdog) }
    function Stop-DrillOwnedVm { param([switch]$RestoreCheckpoint) $script:events.Add("restore:$RestoreCheckpoint"); $true }
    function Wait-DrillGuest { param($Credential, $Minutes, $After) Assert-DrillGuard
      if ($null -ne $After -and $null -ne $script:rebootNeverBack) { $script:now = [double]$script:rebootNeverBack; $script:events.Add('reboot-not-back'); throw 'the guest did not come back (fixture)' }
      [DateTimeOffset]${q(T0)} }
    function New-PSSession { param($VMName, $Credential) 'session' }
    function Remove-PSSession { param($Session) }
    function Copy-Item { param($LiteralPath, $Path, $Destination, $ToSession, [switch]$Recurse) }
    function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, $VMName, $Credential, [switch]$AsJob, $ErrorAction)
      if ($Session) { if ($ArgumentList -is [string]) { 'ab' }; return }
      if (-not $AsJob) {
        if ([object]::ReferenceEquals($ScriptBlock, $script:GuestProbe)) { return @{ boot = ${q(T0)}; imageState = 'IMAGE_STATE_COMPLETE'; oobe = 0 } }
        $script:events.Add('vm-command'); return
      }
      $entry = [object]::ReferenceEquals($ScriptBlock, $script:GuestEntry)
      $job = [pscustomobject]@{ entry = $entry; done = (-not $entry); failed = $false; result = $null; kind = 'step' }
      $job | Add-Member -MemberType ScriptMethod -Name StopJobAsync -Value { $script:events.Add('stop-async:' + $this.kind) }
      if ([object]::ReferenceEquals($ScriptBlock, $script:GuestStageFiles)) {
        $names = @($ArgumentList[1])
        $isPull = $names.Count -eq 5 -and $names -contains 'stage-progress.jsonl'
        $job.kind = $(if ($isPull) { 'pull' } else { 'read' })
        if ($isPull -and (& $script:pullFail)) { $job.done = $false; $script:events.Add('pull-no-answer'); return $job }
        if (-not $isPull -and $null -ne $script:slowReadsAfter -and $script:now -ge $script:slowReadsAfter) { $job.done = $false; $script:events.Add('read-no-answer'); return $job }
        $script:events.Add('read:' + ($names -join ',')); $job.result = & $ScriptBlock ${q(guestDir)} $ArgumentList[1] }
      elseif ([object]::ReferenceEquals($ScriptBlock, $script:GuestShutdownTimer)) { $job.result = $true }
      elseif ([object]::ReferenceEquals($ScriptBlock, $script:GuestRead)) { $job.result = $script:read }
      elseif ($entry) { $job.kind = 'entry'; $script:events.Add('entry') }
      return $job
    }
    function Wait-Job { param($Job, $Timeout)
      if ($Job.done) { return $Job }
      $step = [double]$Timeout
      if ($null -ne $script:fireAt) { $step = [Math]::Min($step, [Math]::Max(0, $script:fireAt - $script:now)) }
      if ($Job.entry -and $null -ne $script:entryDoneAt) { $step = [Math]::Min($step, [Math]::Max(0, $script:entryDoneAt - $script:now)) }
      $script:now += $step; Update-FakeGuest
      if ($null -ne $script:fireAt -and $script:now -ge $script:fireAt -and -not $script:HostGuard.state.failure) { Invoke-FakeGuard; $Job.failed = $true; $Job.done = $true; return $Job }
      if ($Job.entry -and $null -ne $script:entryDoneAt -and $script:now -ge $script:entryDoneAt) { $Job.done = $true; $Job.result = $script:entryOut; $script:events.Add('entry-done'); return $Job }
      return $null
    }
    function Receive-Job { param($Job, $ErrorAction) if ($Job.failed) { throw 'The virtual machine is not running (fixture)' }; $Job.result }
    function Remove-Job { param($Job, [switch]$Force, $ErrorAction)
      if ($script:removeBlocks -and -not $Job.done) { $script:events.Add('remove-running-job:' + $Job.kind); $script:now += 300 } }
    $script:Interactive = $false
    $package = @{ version = '1.2.3'; files = @(); tar = 'C:/x/p.tar'; tarSha256 = 'ab'; ciSourceManifestSha256 = ('5' * 64); firstInstallKitSha256 = ('7' * 64); candidate = $false }
    $earlyKit = [pscustomobject]@{ sha256 = 'kit-ladder'; dir = 'C:/kit'; entryFile = 'first-install-entry.ps1'; arguments = @('-Work', '{work}'); timeoutMinutes = 240; prerequisiteMode = 'first-install-host'; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) }
    $window = @{ safeToResume = $true; deadline = ([DateTimeOffset]${q(T0)}).AddSeconds(${deadlineSeconds}); holdUntil = [DateTimeOffset]::MinValue }
    ${tail}`);
  return { r, runDir: runDir || r.runDir, guestDir };
}

// Ladder mode (coordinator, Owner 11-23: "先把每段结论传回来，再慢慢梯度测试，把黑盒逐步切成明盒；梯度时限要做进代码，不能靠人记").
// With -Ladder and no -RunTimeoutMinutes, the run's limit comes from the latest receipt of the same version and kit under the runs
// directory (its stage timeline), never from memory. Each case runs the real Invoke-DrillMain up to the host hold, which the stub answers
// with the minutes it was asked to hold for, the run's limit and the ladder step.
export const LADDER_VERSION = '1.2.3';
export const LADDER_KIT = 'kit-ladder';
export const ladderStubs = `${candidateStubs}
    $Ladder = $true
    function Read-DrillKit { @{ sha256 = ${q(LADDER_KIT)}; prereqSha256 = 'pin'; executionBlocker = $null; candidate = @{ acceptance = 'x' }; credentials = (${q(JSON.stringify(PACKAGE_CREDENTIALS))} | ConvertFrom-Json) } }
    function Invoke-DrillWithHostHold { param([int]$Minutes, $Body)
      [ordered]@{ holdMinutes = $Minutes; runTimeoutMinutes = $RunTimeoutMinutes; ladder = (Get-Variable DrillLadder -Scope Script -ValueOnly -ErrorAction SilentlyContinue) } }`;
// A receipt of an earlier run: its limit, how it ended and its stage timeline ([stage, result, code]).
export function ladderReceipt({ minutes = 10, failure = null, conclusion = 'FAIL', stages = [], version = LADDER_VERSION, kit = LADDER_KIT } = {}) {
  const rows = stages.map(([stage, result, code = null], i) => ({ n: i + 1, stage, result, code, label: result === 'aborted-in-progress' ? '进行中被中止' : null }));
  const cut = rows.find(r => r.result === 'aborted-in-progress');
  return { contract: 'clued.independent-ci.drill-receipt/fixture', version, kitSha256: kit, runTimeoutMinutes: minutes, failure, conclusion, restoredToCheckpoint: true,
    evidence: { stageTimeline: { source: 'stage-progress', reached: rows.length ? rows.at(-1).stage : null, abortedIn: cut ? cut.stage : null, stages: rows } } };
}
export const foregroundStop = minutes => ({ code: 'DRILL_RUN_TIMEOUT', detail: { by: 'foreground', deadline: '2026-11-23T03:00:00Z', evidenceWindowMinutes: Math.min(5, minutes * 0.3) } });
// runs: [[run directory name (UTC start first, as Invoke-DrillPreparedRun names them), receipt]]
export function ladderMain(name, runs, extra = '') {
  const root = fs.mkdtempSync(path.join(tmp, `ladder-${name}-`));
  for (const [dir, r] of runs) { fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, dir, 'receipt.json'), JSON.stringify(r)); }
  const out = ps(`${ladderStubs}
    $script:Drill.Runs = ${q(root)}
    ${extra}
    try { Invoke-DrillMain } catch { Get-DrillCode $_ }`);
  return { root, out };
}

// ---------------------------------------------------------------- fix round 1 of 87d330d0 (D:/w/tmp/REVIEW-drill-early-stop-20261123.md)
// The real Invoke-FirstInstallAccepted of first-install-entry.ps1, over a release whose bootstrap is a stand-in: the bootstrap's helpers
// answer as told (the check's exit, whether an input is local), the injected prerequisites are real files hashed for real, and the tar
// is a command that exits 0. snapAt: 'gap' (the first local copy after the check's verdict) or a tool name (its expansion) -- there the
// stage record as it stands is copied aside (what a pull at that moment brings back); snapStop: the entry stops right after.
export function entryAccepted(name, { checkExit = 0, underDir = true, snapAt = '', snapStop = false } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, `entry-accepted-${name}-`));
  const [assets, payload, fake, out, work, cred] = ['assets', 'payload', 'fake', 'out', 'work', 'cred'].map(d => { const p = path.join(root, d); fs.mkdirSync(p); return p; });
  const tar = path.join(root, 'tar.cmd'); fs.writeFileSync(tar, '@exit /b 0\r\n');
  const snap = path.join(root, 'snapshot.jsonl');
  const file = (n, text) => { fs.writeFileSync(path.join(payload, n), text); return { sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) }; };
  const items = [['wsl', 'wsl.msi', 'w'.repeat(40)], ['node', 'node.zip', 'n'.repeat(50)], ['python', 'python.zip', 'p'.repeat(60)], ['git', 'git.zip', 'g'.repeat(70)]]
    .map(([n, f, text]) => ({ name: n, fileName: f, maxEntryPathLength: 10, ...file(f, text) }));
  const debs = [{ fileName: 'a.deb', ...file('a.deb', 'd'.repeat(30)) }];
  fs.writeFileSync(path.join(assets, 'fleet-node-1.2.3.prereq-manifest.json'), JSON.stringify({ items, debs }));
  for (const n of ['SHA256SUMS', 'fleet-node-1.2.3.first-install.SHA256SUMS', 'fleet-node-1.2.3.tar']) fs.writeFileSync(path.join(assets, n), '');
  fs.writeFileSync(path.join(assets, 'fleet-node-1.2.3.bootstrap.ps1'), `param([string]$From)
$ReceiptFile = ${q(path.join(root, 'no-install-receipt.json'))}
$WorkParent = ${q(work)}
$TarExe = ${q(tar)}
$CredentialDirectory = ${q(cred)}
$PowerShellExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$HostLimitSeconds = 60; $LauncherLimitSeconds = 60
function Save-FixtureSnapshot([string]$At) {
  if ($global:SnapAt -cne $At -or $global:SnapTaken) { return }
  [IO.File]::Copy(${q(path.join(out, 'stage-progress.jsonl'))}, ${q(snap)}, $true); $global:SnapTaken = $true
  if ($global:SnapStop) { throw 'FIXTURE_STOPPED_AFTER_SNAPSHOT' }
}
function Get-ReleaseVersion($Names) { '1.2.3' }
function Read-Sha256Sums([string]$Text) { @{} }
function Test-AssetSet { @() }
function Test-PrereqManifest { @() }
function Get-NeededPrereqs { @() }
function Sha256File([string]$P) { (Get-FileHash -LiteralPath $P -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-Key($O, [string]$K) { if ($O.ContainsKey($K)) { $O[$K] } else { $null } }
function Get-Prereq($Item, [string]$Dest) { throw 'FIXTURE_NOT_INJECTED' }
function Expand-Cached([string]$Zip, [string]$Name, [string]$Sha256, $Max) {
  Save-FixtureSnapshot $Name
  $exe = @{ node = 'node.exe'; python = 'python.exe'; git = 'cmd\\git.exe' }[$Name]
  $dir = Join-Path ${q(work)} ('tools-' + $Name); $f = Join-Path $dir $exe
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $f)); [IO.File]::WriteAllText($f, 'x'); $dir
}
function Invoke-NonElevated($Exe, $Arguments, $EnvAdd) { @{ exit = $global:CheckExit; last = @{ kitSha256 = 'k'; toolchainNodeSha256 = 't'; registrarSha256 = 'r' } } }
function Test-FirstInstallCheck { ,@() }
function Copy-ToWork([string]$Source, [string]$Dir, [string]$Sha256) { Save-FixtureSnapshot 'gap'; Join-Path $Dir (Split-Path -Leaf $Source) }
function Test-UnderDirectory($P, $Root) { $global:UnderDir }
function Clear-CredentialDirectory([string]$Dir) { @{ cleared = $true } }
`);
  const thrown = entryPs(`$global:CheckExit = ${checkExit}; $global:UnderDir = ${underDir ? '$true' : '$false'}; $global:SnapAt = ${q(snapAt)}; $global:SnapStop = ${snapStop ? '$true' : '$false'}; $global:SnapTaken = $false
    try { [void](Invoke-FirstInstallAccepted ${q(assets)} ${q(payload)} ${q(fake)} ${q(out)} '1.2.3'); 'RETURNED' } catch { [string]$_.Exception.Message }`);
  const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  return { thrown, record: read(path.join(out, 'stage-progress.jsonl')), snapshot: read(snap), items, debs };
}
// The receipt's stage timeline over a run directory holding the entry's record (and its result, when it gave one).
export function timelineOf(name, record, entryResult = null) {
  const runDir = fs.mkdtempSync(path.join(tmp, `timeline-${name}-`));
  fs.writeFileSync(path.join(runDir, 'stage-progress.jsonl'), record);
  if (entryResult) fs.writeFileSync(path.join(runDir, 'entry-result.json'), JSON.stringify(entryResult));
  return ps(`Get-DrillStageTimeline ${q(runDir)}`);
}
export const stoppedResult = code => ({ exitCode: 1, status: 'FIRST_INSTALL_STOPPED', stopCode: code, tree: '', node: '', parsed: true });
export const rows = t => t.stages.map(s => `${s.stage}:${s.result}${s.code ? ':' + s.code : ''}`);

// Item 7 (coordinator; the 20-minute round 20261123T125817Z-2026.11.23-d5da6825-edb6ba9b): the host stage was cut off 5 minutes after its
// last step line (node-key-check ok), and nothing said which step it was in -- a step line is printed only as a step ends. The host
// preparation (windows/first-install-host.ps1, under Windows PowerShell 5.1 as in the guest) now also writes each step's start and end
// into the entry's stage record when it is given -StepProgress; its stdout is unchanged. The timeline's host stage says the step in progress
// and since when.
export const hostScript = fileURLToPath(new URL('../windows/first-install-host.ps1', import.meta.url));
