// scripts/existing-release-v3-host/ is the fixed existing-release publisher
// package. Revision 6 is what the WSL Host runs from
// /opt/clued-production-release-v3; it released main fbb4a8d9 on 2026-10-22
// (Note fdfbe464, Task 3bcd214f). Both of its fixes were first made on the Host:
//   v5, Decision cdd6eeb8: systemd 255 leaves seven empty list properties out
//       of `systemctl show`, and the v4 manager refused every fixed operation
//       with MANAGER_SYSTEMD_BOUNDARY_UNPROVEN.
//   v6, Decision a796d9e2: wrangler 4 has no --no-build, and the v5 PDF deploy
//       stopped before any upload.
// Revision 7 (Task b8d7f4cb) is committed, not installed. On the Host a process
// in the job's sandbox started a Windows process through a world-connectable
// /run/WSL/*_interop socket, and PrivateDevices=yes still shares the Host's
// /dev/shm (Note 0b5eb8ca). v7 makes both inaccessible in the two fixed units
// and stops wherever either is reachable.
// These tests keep the committed bytes equal to revision 7, rebuild the
// installed revision 6 from the committed v6-to-v7 patch and, from it, the v4
// manager and the v5 release entry, and reproduce each fixed failure against
// those rebuilt bytes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const PACKAGE = path.join(APP, 'scripts/existing-release-v3-host');
const MANAGER = 'payload/release/linux-process-manager.mjs';
const RELEASE = 'payload/release/existing-release-entry-v1/v3-host/release-once.mjs';
const HOST_FILES = 'payload/release/existing-release-entry-v1/v3-host/host-files.mjs';
const STAGES = 'payload/release/existing-release-entry-v1/v3/existing-stages.mjs';
const PDF_CONFIG = 'apps/clued-cloud/wrangler.pdf-extractor.jsonc';

// The source freeze of revision 7, which pins every other file of the package.
const SOURCE_FREEZE = 'f6d8fdb91e3d50bf1a0ce05fed3b0d19412eaf2a22123b0f05366cf5f1ef6d5e';
// Revision 6 as installed on the Host (Note fdfbe464@7): its package manifest,
// its source freeze (the handover copy's) and the bytes of its seven files.
const INSTALLED_MANIFEST = '71ee46c6c0d5bb0bafa5a85a5445b11c4f0b534141eb25010b06b51da04b8bf4';
const INSTALLED_SOURCE_FREEZE = 'e28ed179837a91ff88e3a3b979d93c23abed8c73ec01e552fa5bf407ba9f4534';
const INSTALLED_FILES = Object.freeze({
  'install-once.mjs': '1a5e18e1258d89fb0c8b631b1688615c09936391e7904c2cb40d642e36fd5e7d',
  'payload/release/existing-release-entry-v1/fixed-currentness-ports.mjs': '93f95698f359c94585053d4331ae855bc07004245b4429ecaf6470aa40c25f3f',
  [STAGES]: 'ec611508e7a219cd9dbd791058d5fbf1b2e6d4ad6295c43aaefab75d65ace935',
  [HOST_FILES]: 'cbf96b66f2e0d816f3c19219a812b438088351ab8c27f696989ddce1831b53cd',
  [RELEASE]: '70e5f69311b65c31b050a58475fe8c7517eb86d25bb9aa2a2161ba70148a7b6d',
  [MANAGER]: 'b961dfc06794336f38f47d4f8f5d7c6a2724aee6ba5bac4ff69090ef30842f70',
  'payload/release/verify-currentness-external.mjs': '4bb88785021b73783bfe2b37972be11806f2c3b564ced8785dfbda25405106cd',
});
const V7_CHANGED = [MANAGER, STAGES, HOST_FILES, RELEASE];
// Predecessor bytes the committed patches must rebuild exactly: the v4 manager
// is the pin that v4-to-v5 replaces; the v5 release entry is the one in v5
// package manifest 590f00f3.
const V4_MANAGER = '9cfec2d4cf62afc368fb484783d7e15c56cfe9e0872ee9e2a9c1d4fc5e3dff20';
const V5_RELEASE = '3435ed2b6f5b3ed93e43cb21ef3e56e6689f84f50bbc5b587cdb434c0c6c1b34';
// The PDF config of the 2026-10-22 release and the derived config that the
// publisher's wrangler dry-run proved and then deployed.
const RELEASED_PDF_CONFIG = '92c7d0c75e808c726aab7b948498744aa3b5f3c70f4421c1daf2f5d61a59c1e8';
const DERIVED_PDF_CONFIG = 'a2659ea88a6e02468fa34a19a3bbb0b9a3bc8830eb39da6b16c21e0af2bfcb49';
const OMITTED = ['ExecStartPre', 'ExecStartPost', 'ExecCondition', 'ExecStop', 'ExecStopPost', 'ExecReload',
  'EnvironmentFiles'];
// What v7 makes inaccessible, as the unit files say it and systemd shows it.
const INACCESSIBLE = '-/run/WSL /dev/shm';
const { R_OK, X_OK } = fs.constants;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Git's object id of a file once it is committed as text (CRLF normalized to
// LF): the git-format patches name these ids in their `index` lines.
const gitBlob = (bytes) => {
  const text = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
  return createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex');
};
const read = (file) => fs.readFileSync(path.join(PACKAGE, file));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-release-v3-host-'));
// On exit rather than in after(): this also runs when the module fails to load.
process.once('exit', () => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A leftover scratch directory must not turn a passing run into a failure.
  }
});

function code(run) {
  try {
    run();
    return 'PASS';
  } catch (error) {
    return error.code ?? error.message;
  }
}

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);
}

// Undo one file's hunks of a committed patch, starting from the newer bytes.
// The patches were written without carriage returns, while the manager keeps
// the CRLF lines it had before v5 (only the five lines v5 added end in LF).
// Lines therefore compare without a trailing CR, and a removed line gets one
// back when the hunk's context lines have it. v6-to-v7 has one line of context,
// so each of its manager hunks lies within CRLF lines.
function patchSection(patchFile, file) {
  const section = read(patchFile).toString('utf8').split(/^diff --git /m)
    .find((part) => part.startsWith(`a/${file} b/${file}\n`));
  assert.ok(section, `${patchFile} has no hunk for ${file}`);
  return section;
}

function reverseApply(patchFile, file, newer) {
  const section = patchSection(patchFile, file);
  const lines = newer.toString('utf8').split('\n');
  const older = [];
  let at = 0;
  for (const hunk of section.split(/^(?=@@ )/m).slice(1)) {
    const start = Number(hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)[1]) - 1;
    const body = hunk.split('\n').slice(1).filter((text) => text.length > 0);
    older.push(...lines.slice(at, start));
    at = start;
    // The newer file holds the hunk's context and added lines in order from start.
    const context = body.filter((line) => line[0] !== '-')
      .flatMap((line, index) => line[0] === ' ' ? [lines[start + index] ?? ''] : []);
    const cr = context.length > 0 && context.every((line) => line.endsWith('\r')) ? '\r' : '';
    for (const line of body) {
      assert.ok(' +-'.includes(line[0]), `${patchFile}: unexpected line ${JSON.stringify(line)}`);
      if (line[0] === '-') {
        older.push(line.slice(1) + cr);
        continue;
      }
      assert.equal(lines[at]?.replace(/\r$/, ''), line.slice(1), `${patchFile} does not match ${file} at line ${at + 1}`);
      if (line[0] === ' ') older.push(lines[at]);
      at += 1;
    }
  }
  return Buffer.from([...older, ...lines.slice(at)].join('\n'));
}

async function importBytes(name, bytes) {
  const file = path.join(scratch, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return import(pathToFileURL(file).href);
}

// Revision 6 as installed, rebuilt from revision 7.
const v6 = Object.fromEntries(V7_CHANGED.map((file) => [file, reverseApply('v6-to-v7-executable.patch', file, read(file))]));
const unitProperties = (source) => JSON.parse(source.toString('utf8').match(/const UNIT_PROPERTIES=(\[[^\]]*\])/)[1].replaceAll("'", '"'));
const UNIT_PROPERTIES = unitProperties(read(MANAGER));
const UNIT_PROPERTIES_V6 = unitProperties(v6[MANAGER]);
const config = {
  job_uid: 994,
  job_gid: 987,
  source_root: '/srv/clued-production-release/source',
  state_dir: '/var/lib/clued-production-release/manager-state',
  output_dir: '/var/lib/clued-production-release/manager-output',
  node: { path: '/opt/clued-production-release-runtime/node' },
  manager: { path: '/opt/clued-production-release-v3/release/linux-process-manager.mjs' },
  environment: { HOME: '/var/lib/clued-production-release/job-home', TMPDIR: '/var/lib/clued-production-release/job-tmp' },
};

// `systemctl show clued-currentness@head.service` for the fixed template unit, as
// systemd 255 prints it: the seven empty list properties are missing, even with
// --all. `properties` is the list the manager asks for.
function systemd255Reply(properties = UNIT_PROPERTIES, c = config) {
  const argv = `${c.node.path} ${c.manager.path} --systemd-job /etc/clued/currentness-manager.json head`;
  const values = {
    Id: 'clued-currentness@head.service', LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead',
    Result: 'success', MainPID: '0', ExecMainCode: '0', ExecMainStatus: '0', InvocationID: '', ControlGroup: '',
    User: String(c.job_uid), Group: String(c.job_gid), KillMode: 'control-group', NoNewPrivileges: 'yes',
    ProtectControlGroups: 'yes', FragmentPath: '/etc/systemd/system/clued-currentness@.service', Delegate: 'no',
    Slice: 'system.slice', RemainAfterExit: 'yes', Type: 'oneshot',
    ExecStart: `{ path=${c.node.path} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    WorkingDirectory: c.source_root, DropInPaths: '', NeedDaemonReload: 'no', Environment: '', PassEnvironment: '',
    UnsetEnvironment: 'LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS NODE_PATH', CapabilityBoundingSet: '',
    AmbientCapabilities: '', SupplementaryGroups: '', ProtectSystem: 'strict', ProtectHome: 'yes',
    PrivateDevices: 'yes', PrivateTmp: 'yes', ProtectProc: 'invisible', RestrictSUIDSGID: 'yes',
    LockPersonality: 'yes', UMask: '0027', ReadWritePaths: `${c.output_dir} ${c.environment.HOME} ${c.environment.TMPDIR}`,
    InaccessiblePaths: INACCESSIBLE,
    RootDirectory: '', RootImage: '', BindPaths: '', BindReadOnlyPaths: '', TemporaryFileSystem: '',
  };
  const shown = properties.filter((key) => key in values);
  assert.deepEqual(shown.sort(), properties.filter((key) => !OMITTED.includes(key)).sort());
  return properties.filter((key) => key in values).map((key) => `${key}=${values[key]}`).join('\n') + '\n';
}

const managerV7 = await import(pathToFileURL(path.join(PACKAGE, MANAGER)).href);
const hostFilesV7 = await import(pathToFileURL(path.join(PACKAGE, HOST_FILES)).href);
const managerV6 = await importBytes('v6/linux-process-manager.mjs', v6[MANAGER]);
const hostFilesV6 = await importBytes('v6/host-files.mjs', v6[HOST_FILES]);
const managerV4 = await importBytes('v4/linux-process-manager.mjs', reverseApply('v4-to-v5-executable.patch', MANAGER, v6[MANAGER]));
const releaseV5 = reverseApply('v5-to-v6-executable.patch', RELEASE, v6[RELEASE]).toString('utf8');

// release-once reads the pinned PDF config through host-files' fixed Source
// root. Run the exact committed release-once next to a host-files that
// re-exports the committed one, with the Source root moved to a scratch
// checkout. Ownership of that root is the Host's to check, not this test's.
const source = path.join(scratch, 'source');
fs.mkdirSync(path.join(source, 'apps/clued-cloud'), { recursive: true });
const payload = path.join(scratch, 'payload');
fs.cpSync(path.join(PACKAGE, 'payload'), payload, { recursive: true });
fs.writeFileSync(path.join(payload, HOST_FILES.slice('payload/'.length)), [
  `export * from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, HOST_FILES)).href)};`,
  "import fs from 'node:fs';",
  `export const SOURCE = ${JSON.stringify(source)}, APP = SOURCE + '/apps/clued-cloud';`,
  'export function protectedBytes(file, max) {',
  '  const bytes = fs.readFileSync(file);',
  "  if (bytes.length > max) throw Object.assign(new Error('PROTECTED_FILE_REQUIRED'), { code: 'PROTECTED_FILE_REQUIRED' });",
  '  return bytes;',
  '}',
  '',
].join('\n'));
assert.equal(sha256(fs.readFileSync(path.join(payload, RELEASE.slice('payload/'.length)))), sha256(read(RELEASE)));
const { pdfReleaseConfig, main: releaseOnce } = await import(pathToFileURL(path.join(payload, RELEASE.slice('payload/'.length))).href);
const mainPdfConfig = fs.readFileSync(path.join(REPO, PDF_CONFIG));

function deriveFrom(bytes, pin = sha256(bytes)) {
  fs.writeFileSync(path.join(source, PDF_CONFIG), bytes);
  return pdfReleaseConfig({ sourcePins: { [PDF_CONFIG]: pin } });
}

test('the committed package is revision 7, after the revision 6 installed on the Host', () => {
  const freeze = JSON.parse(read('source-freeze.json'));
  const manifest = JSON.parse(read('package-manifest.json'));
  assert.equal(freeze.revision, 7);
  assert.equal(manifest.revision, 7);
  assert.equal(manifest.previousPackageManifestSha256, INSTALLED_MANIFEST);
  assert.equal(freeze.predecessorSourceFreezeSha256, INSTALLED_SOURCE_FREEZE);
  assert.equal(sha256(read('source-freeze.json')), SOURCE_FREEZE);
  assert.equal(freeze.packageManifestSha256, sha256(read('package-manifest.json')));
  assert.deepEqual(listFiles(PACKAGE).sort(), [...Object.keys(freeze.sourceFiles), 'source-freeze.json'].sort());
  for (const [file, { bytes, sha256: expected }] of Object.entries(freeze.sourceFiles)) {
    assert.equal(sha256(read(file)), expected, file);
    assert.equal(read(file).length, bytes, file);
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(INSTALLED_FILES).sort());
  for (const [file, { bytes, sha256: expected }] of Object.entries(manifest.files)) {
    assert.equal(sha256(read(file)), expected, file);
    assert.equal(read(file).length, bytes, file);
  }
  for (const [name, file] of [['EXTERNAL', 'payload/release/verify-currentness-external.mjs'], ['MANAGER', MANAGER],
    ['PORTS', 'payload/release/existing-release-entry-v1/fixed-currentness-ports.mjs']]) {
    assert.ok(read(STAGES).toString('utf8').includes(`[${name},'${sha256(read(file))}']`), `${STAGES} pins ${file}`);
  }
  // v7 changes four files; the patch gives back revision 6 of all seven.
  for (const [file, installed] of Object.entries(INSTALLED_FILES)) {
    assert.equal(sha256(v6[file] ?? read(file)), installed, file);
  }
});

test('the committed patches rebuild the exact v6, v4 and v5 predecessors', () => {
  // The git-format patches name the object ids of both sides in their `index`
  // lines; v3-to-v4 is a plain diff without them.
  for (const [patchFile, file, newer] of [
    ...V7_CHANGED.map((file) => ['v6-to-v7-executable.patch', file, read(file)]),
    ['v4-to-v5-executable.patch', MANAGER, v6[MANAGER]], ['v4-to-v5-executable.patch', STAGES, v6[STAGES]],
    ['v5-to-v6-executable.patch', RELEASE, v6[RELEASE]]]) {
    const [older, newerId] = patchSection(patchFile, file).match(/^index ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/m).slice(1);
    assert.ok(gitBlob(newer).startsWith(newerId), `${patchFile}: ${file} is not the patched side`);
    assert.ok(gitBlob(reverseApply(patchFile, file, newer)).startsWith(older), `${patchFile}: ${file} predecessor`);
  }
  assert.ok(read('v6-to-v7-executable.patch').toString('utf8').includes(`- [MANAGER,'${INSTALLED_FILES[MANAGER]}'],`));
  assert.ok(read('v6-to-v7-executable.patch').toString('utf8').includes(`+ [MANAGER,'${sha256(read(MANAGER))}'],`));
  assert.equal(sha256(reverseApply('v4-to-v5-executable.patch', MANAGER, v6[MANAGER])), V4_MANAGER);
  assert.ok(read('v4-to-v5-executable.patch').toString('utf8').includes(`- [MANAGER,'${V4_MANAGER}'],`));
  assert.equal(sha256(Buffer.from(releaseV5)), V5_RELEASE);
});

test('systemd 255: the v4 manager refuses the show reply, the v6 and v7 managers accept it', () => {
  for (const [manager, properties, accepts] of [[managerV4, UNIT_PROPERTIES_V6, false], [managerV6, UNIT_PROPERTIES_V6, true],
    [managerV7, UNIT_PROPERTIES, true]]) {
    const reply = systemd255Reply(properties);
    assert.equal(code(() => manager.parseSystemdShow(reply, config, 'head')), accepts ? 'PASS' : 'MANAGER_SYSTEMD_BOUNDARY_UNPROVEN');
    if (accepts) {
      const values = manager.parseSystemdShow(reply, config, 'head');
      for (const key of OMITTED) assert.equal(values[key], '', key);
    }
    // A systemd that still prints the seven empty properties passes all three.
    const explicit = reply + OMITTED.map((key) => `${key}=`).join('\n') + '\n';
    assert.equal(code(() => manager.parseSystemdShow(explicit, config, 'head')), 'PASS');
  }
});

test('systemd 255: the v6 and v7 managers keep every other refusal of the v4 manager', () => {
  const command = '{ path=/bin/true ; argv[]=/bin/true ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';
  for (const [name, manager, properties] of [['v4', managerV4, UNIT_PROPERTIES_V6], ['v6', managerV6, UNIT_PROPERTIES_V6],
    ['v7', managerV7, UNIT_PROPERTIES]]) {
    const reply = systemd255Reply(properties);
    const parse = (text) => code(() => manager.parseSystemdShow(text, config, 'head'));
    for (const key of OMITTED) {
      const value = key === 'EnvironmentFiles' ? '/etc/x (ignore_errors=no)' : command;
      const explicit = reply + OMITTED.map((other) => `${other}=${other === key ? value : ''}`).join('\n') + '\n';
      // v4 needs all seven printed, so only the explicit reply reaches its value check.
      if (name !== 'v4') assert.equal(parse(`${reply}${key}=${value}\n`), 'MANAGER_LOADED_UNIT_MISMATCH', `${name}, ${key} set`);
      assert.equal(parse(explicit), 'MANAGER_LOADED_UNIT_MISMATCH', `${name}, ${key} set, the six empty`);
    }
    if (name !== 'v4') {
      for (const key of properties.filter((property) => !OMITTED.includes(property))) {
        const missing = reply.split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n');
        assert.equal(parse(missing), 'MANAGER_SYSTEMD_BOUNDARY_UNPROVEN', `${name}, a reply without ${key}`);
      }
    }
    for (const extra of ['Foo=bar', 'User=994']) assert.equal(parse(`${reply}${extra}\n`), 'MANAGER_SYSTEMD_REPLY_INVALID', `${name}, ${extra}`);
  }
});

// The InaccessiblePaths= entries of a rendered unit. No other line may name
// either path: a bind or read-write path there would open it again.
function inaccessibleEntries(unit) {
  const lines = unit.split('\n');
  assert.ok(lines.every((line) => line.startsWith('InaccessiblePaths=') || !/\/run\/WSL|\/dev\/shm/.test(line)), unit);
  return lines.filter((line) => line.startsWith('InaccessiblePaths='))
    .map((line) => line.slice('InaccessiblePaths='.length).split(' ').sort());
}
const publisherContext = { publisherUid: 995, publisherGid: 988, node: config.node, git: { path: '/usr/bin/git' } };
const renderPublisherUnit = (hostFiles) => hostFiles.renderPublisherUnit(publisherContext, config, 'a'.repeat(64), 'b'.repeat(64));

test('WSL interop: both fixed units of v7 make /run/WSL and /dev/shm inaccessible, v6 left both open', () => {
  const blocked = [INACCESSIBLE.split(' ').sort()];
  assert.deepEqual(inaccessibleEntries(managerV7.renderFixedSystemdUnit(config)), blocked, 'clued-currentness@.service');
  assert.deepEqual(inaccessibleEntries(renderPublisherUnit(hostFilesV7)), blocked, 'clued-existing-release-once.service');
  assert.deepEqual(inaccessibleEntries(managerV6.renderFixedSystemdUnit(config)), []);
  assert.deepEqual(inaccessibleEntries(renderPublisherUnit(hostFilesV6)), []);
  // Both still run with PrivateDevices=yes, which on its own binds the Host's /dev/shm.
  for (const unit of [managerV7.renderFixedSystemdUnit(config), renderPublisherUnit(hostFilesV7)]) {
    assert.ok(unit.split('\n').includes('PrivateDevices=yes'));
  }
});

test('WSL interop: the v7 manager refuses a loaded currentness unit that leaves /run/WSL or /dev/shm open', () => {
  const reply = systemd255Reply();
  const parse = (text) => code(() => managerV7.parseSystemdShow(text, config, 'head'));
  const shown = (value) => reply.replace(/^InaccessiblePaths=.*$/m, `InaccessiblePaths=${value}`);
  assert.equal(parse(reply), 'PASS');
  assert.equal(parse(shown('/dev/shm -/run/WSL')), 'PASS');
  // Only the reviewed template passes, so even a stricter value is refused.
  for (const value of ['', '-/run/WSL', '/dev/shm', '-/run/WSL -/dev/shm', '/run/WSL /dev/shm', '-/run/WSL /dev/shm /tmp']) {
    assert.equal(parse(shown(value)), 'MANAGER_LOADED_UNIT_MISMATCH', JSON.stringify(value));
  }
  assert.equal(parse(reply.split('\n').filter((line) => !line.startsWith('InaccessiblePaths=')).join('\n')),
    'MANAGER_SYSTEMD_BOUNDARY_UNPROVEN');
  // v6 never asked systemd for the property, and accepted a unit that blocks neither.
  assert.ok(!UNIT_PROPERTIES_V6.includes('InaccessiblePaths'));
  assert.equal(code(() => managerV6.parseSystemdShow(systemd255Reply(UNIT_PROPERTIES_V6), config, 'head')), 'PASS');
});

test('WSL interop: the runtime checks stop where /run/WSL or /dev/shm can be listed or searched', () => {
  const failing = (errno) => () => {
    throw Object.assign(new Error(errno), { code: errno });
  };
  for (const [boundary, refused] of [[managerV7.interopBoundary, 'MANAGER_WSL_INTEROP_OR_SHM_REACHABLE'],
    [hostFilesV7.interopBoundary, 'WSL_INTEROP_OR_SHM_REACHABLE']]) {
    assert.equal(code(() => boundary(failing('EACCES'))), 'PASS');
    assert.equal(code(() => boundary(failing('ENOENT'))), 'PASS');
    const asked = [];
    boundary((dir, mode) => {
      asked.push(`${dir} ${mode}`);
      failing('EACCES')();
    });
    assert.deepEqual(asked, ['/run/WSL', '/dev/shm'].flatMap((dir) => [R_OK, X_OK].map((mode) => `${dir} ${mode}`)));
    // One way in is enough: listing the directory, or opening a name in it.
    for (const dir of ['/run/WSL', '/dev/shm']) {
      for (const mode of [R_OK, X_OK]) {
        const open = (d, m) => {
          if (d !== dir || m !== mode) failing('EACCES')();
        };
        assert.equal(code(() => boundary(open)), refused, `${dir} ${mode}`);
      }
    }
    // Any other failure is no proof that the path is closed.
    assert.equal(code(() => boundary(failing('EIO'))), 'EIO');
  }
});

test('WSL interop: here, outside the units, the checks and release-once stop exactly when either path is open', async () => {
  const open = ['/run/WSL', '/dev/shm'].some((dir) => [R_OK, X_OK].some((mode) => code(() => fs.accessSync(dir, mode)) === 'PASS'));
  assert.equal(code(() => managerV7.interopBoundary()), open ? 'MANAGER_WSL_INTEROP_OR_SHM_REACHABLE' : 'PASS');
  assert.equal(code(() => hostFilesV7.interopBoundary()), open ? 'WSL_INTEROP_OR_SHM_REACHABLE' : 'PASS');
  // Package and context hashes no Host has: release-once reads or writes nothing
  // past its first check whatever happens.
  const result = await releaseOnce(['--execute-once', '--fixed-scope', 'existing-production-release-v3-host',
    '--reviewed-context-sha256', 'a'.repeat(64), '--reviewed-package-sha256', 'b'.repeat(64)]);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code === 'WSL_INTEROP_OR_SHM_REACHABLE', open, JSON.stringify(result));
});

test('WSL interop: release-once and the manager check before they read, run or deploy anything', () => {
  const release = read(RELEASE).toString('utf8');
  const first = release.indexOf('interopBoundary();verifyPackage(packageSha);let c=readContext(contextSha);');
  assert.ok(first > 0 && first === release.indexOf('interopBoundary()'));
  for (const later of ["writeOnce('release-intent.json'", "readSecret('cloudflare-deploy-token')", "'grant-before-deploy'", "run('pdf-deploy'"]) {
    assert.ok(first < release.indexOf(later), later);
  }
  // readConfig starts the publisher's manager and every job; the job spawns its
  // command only after readConfig returns.
  const manager = read(MANAGER).toString('utf8');
  const readConfig = manager.slice(manager.indexOf('function readConfig('), manager.indexOf('export function selectOperation('));
  assert.ok(readConfig.includes('privilegeBoundary();interopBoundary();'));
  const job = manager.slice(manager.indexOf('async function systemdJob('));
  assert.ok(job.indexOf('readConfig(configPath,null,true)') < job.indexOf('childProcess.spawn('));
});

test('wrangler 4: the v5 PDF deploy passed --no-build, the v6 deploy uses the derived config', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(APP, 'package-lock.json'), 'utf8'));
  assert.match(lock.packages['node_modules/wrangler'].version, /^4\./,
    'the publisher runs the locked wrangler; recheck the PDF deploy when its major version changes');
  assert.ok(releaseV5.includes("run('pdf-deploy',[wr,'deploy','--config','wrangler.pdf-extractor.jsonc','--no-build'],{env:cf()});"));
  const release = read(RELEASE).toString('utf8');
  assert.ok(!release.includes("'--no-build'"));
  assert.ok(release.includes("run('pdf-deploy',[wr,'deploy','--config',PDF_RELEASE_CONFIG],{env:cf()});"));
  // The derived config is written and hashed before the Grant is consumed.
  const derive = release.indexOf('const pdfConfigSha=writePdfReleaseConfig(c);');
  assert.ok(derive > 0 && derive < release.indexOf("'grant-before-deploy'"));
});

test("wrangler 4: main's PDF config passes the v6 shape check and derives a config without a build", () => {
  const derived = JSON.parse(deriveFrom(mainPdfConfig).toString('utf8'));
  const original = JSON.parse(mainPdfConfig.toString('utf8'));
  assert.equal('build' in derived, false);
  assert.equal('$schema' in derived, false);
  // The derived file sits in apps/clued-cloud/.wrangler/ and names the same artifact.
  assert.equal(derived.main, '../dist/pdf-extractor/index.js');
  const rest = (value) => {
    const copy = { ...value };
    for (const key of ['build', '$schema', 'main']) delete copy[key];
    return copy;
  };
  assert.deepEqual(rest(derived), rest(original));
});

test('wrangler 4: the released PDF config derives the bytes the publisher deployed', (t) => {
  if (sha256(mainPdfConfig) !== RELEASED_PDF_CONFIG) {
    t.skip('wrangler.pdf-extractor.jsonc changed after the 2026-10-22 release');
    return;
  }
  assert.equal(sha256(deriveFrom(mainPdfConfig)), DERIVED_PDF_CONFIG);
});

test('wrangler 4: the v6 derivation refuses a changed pin or config shape', () => {
  assert.equal(code(() => deriveFrom(mainPdfConfig, '0'.repeat(64))), 'PDF_CONFIG_PIN_REQUIRED');
  assert.equal(code(() => deriveFrom(mainPdfConfig, null)), 'PDF_CONFIG_PIN_REQUIRED');
  const original = JSON.parse(mainPdfConfig.toString('utf8'));
  for (const changed of [
    { ...original, build: { ...original.build, cwd: '.' } },
    { ...original, main: './dist/other.js' },
    { ...original, no_bundle: false },
    { ...original, name: 'clued-other' },
  ]) {
    assert.equal(code(() => deriveFrom(Buffer.from(JSON.stringify(changed)))), 'PDF_CONFIG_SHAPE_CHANGED');
  }
});

const wrangler = path.join(APP, 'node_modules/wrangler/bin/wrangler.js');
test('wrangler 4: --no-build is an unknown argument, the derived config dry-runs', {
  skip: !fs.existsSync(wrangler) && 'wrangler is not installed in apps/clued-cloud/node_modules',
}, () => {
  const app = path.join(scratch, 'wrangler-app');
  fs.mkdirSync(path.join(app, '.wrangler'), { recursive: true });
  fs.mkdirSync(path.join(app, 'dist/pdf-extractor'), { recursive: true });
  const artifact = 'export default { fetch() { return new Response("ok"); } };\n';
  fs.writeFileSync(path.join(app, 'dist/pdf-extractor/index.js'), artifact);
  // The derived config has no build hook, so neither run can rebuild anything.
  fs.writeFileSync(path.join(app, '.wrangler/pdf-extractor.release.json'), deriveFrom(mainPdfConfig));
  const home = path.join(scratch, 'wrangler-home');
  fs.mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE|CF)_/.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, WRANGLER_SEND_METRICS: 'false', CI: '1' });
  const deploy = (...extra) => spawnSync(process.execPath, [wrangler, 'deploy', '--config',
    '.wrangler/pdf-extractor.release.json', '--dry-run', ...extra], { cwd: app, env, encoding: 'utf8', timeout: 120000 });
  const v5 = deploy('--no-build', '--outdir', path.join(scratch, 'out-v5'));
  assert.notEqual(v5.status, 0);
  assert.match(v5.stdout + v5.stderr, /Unknown arguments?: .*build/);
  const v6Run = deploy('--outdir', path.join(scratch, 'out-v6'));
  assert.equal(v6Run.status, 0, v6Run.stdout + v6Run.stderr);
  assert.equal(fs.readFileSync(path.join(scratch, 'out-v6/index.js'), 'utf8'), artifact);
});

test("the release entry still pins main's original verification CLIs", () => {
  // existing-stages refuses a context whose Source pins differ from these
  // (ORIGINAL_RELEASE_SOURCE_PIN_REQUIRED). Changing one of these files on
  // main needs a new reviewed publisher package revision first.
  const block = read(STAGES).toString('utf8').match(/const PINNED=Object\.freeze\(\{([^}]*)\}\);/)[1];
  const pinned = [...block.matchAll(/'([^']+)':'([a-f0-9]{64})'/g)];
  assert.equal(pinned.length, 3);
  for (const [, file, pin] of pinned) {
    assert.equal(sha256(fs.readFileSync(path.join(REPO, file))), pin, `${file} no longer matches its pin in `
      + `${path.relative(REPO, path.join(PACKAGE, STAGES)).split(path.sep).join('/')}: `
      + 'the Host publisher would refuse to release this main. '
      + 'Land a new reviewed publisher package revision that pins the new bytes first.');
  }
});

test('every entry point stays disabled or blocked without its fixed arguments', () => {
  for (const [file, expected] of [
    [RELEASE, '"status":"DISABLED"'],
    ['install-once.mjs', '"status":"DISABLED"'],
    [STAGES, '"status":"DISABLED"'],
    [MANAGER, '"code":"PROTECTED_SYSTEMD_CONFIG_AND_PUBLISHER_REQUIRED"'],
    ['payload/release/verify-currentness-external.mjs', '"code":"CURRENTNESS_PROTECTED_PUBLISHER_CONTEXT_REQUIRED"'],
  ]) {
    // Each entry runs main() only when argv[1] is its own real path.
    const entry = fs.realpathSync(path.join(PACKAGE, file));
    const run = spawnSync(process.execPath, [entry], { cwd: scratch, encoding: 'utf8', timeout: 30000 });
    assert.ok(run.stdout.includes(expected), `${file}: ${run.stdout}${run.stderr}`);
  }
});
