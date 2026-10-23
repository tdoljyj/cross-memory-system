// scripts/existing-release-v3-host/ is the fixed existing-release publisher
// package, revision 6, that the WSL Host runs from
// /opt/clued-production-release-v3. It released main fbb4a8d9 on 2026-10-22
// (Note fdfbe464, Task 3bcd214f). Both of its fixes were first made on the
// Host:
//   v5, Decision cdd6eeb8: systemd 255 leaves seven empty list properties out
//       of `systemctl show`, and the v4 manager refused every fixed operation
//       with MANAGER_SYSTEMD_BOUNDARY_UNPROVEN.
//   v6, Decision a796d9e2: wrangler 4 has no --no-build, and the v5 PDF deploy
//       stopped before any upload.
// These tests keep the committed bytes equal to that package. They rebuild the
// v4 manager and the v5 release entry from the committed patches and reproduce
// both failures against those rebuilt bytes.
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

// The package manifest installed on the Host (Note fdfbe464@7), and the source
// freeze that pins every other file of the package (the handover copy's).
const INSTALLED_MANIFEST = '71ee46c6c0d5bb0bafa5a85a5445b11c4f0b534141eb25010b06b51da04b8bf4';
const SOURCE_FREEZE = 'e28ed179837a91ff88e3a3b979d93c23abed8c73ec01e552fa5bf407ba9f4534';
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
// back when the hunk's context lines have it.
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

const managerSource = read(MANAGER).toString('utf8');
const UNIT_PROPERTIES = JSON.parse(managerSource.match(/const UNIT_PROPERTIES=(\[[^\]]*\])/)[1].replaceAll("'", '"'));
const config = {
  job_uid: 994,
  job_gid: 987,
  source_root: '/srv/clued-production-release/source',
  output_dir: '/var/lib/clued-production-release/manager-output',
  node: { path: '/opt/clued-production-release-runtime/node' },
  manager: { path: '/opt/clued-production-release-v3/release/linux-process-manager.mjs' },
  environment: { HOME: '/var/lib/clued-production-release/job-home', TMPDIR: '/var/lib/clued-production-release/job-tmp' },
};

// `systemctl show clued-currentness@head.service` for the fixed template unit, as
// systemd 255 prints it: the seven empty list properties are missing, even with --all.
function systemd255Reply(c = config) {
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
    RootDirectory: '', RootImage: '', BindPaths: '', BindReadOnlyPaths: '', TemporaryFileSystem: '',
  };
  assert.deepEqual(Object.keys(values).sort(), UNIT_PROPERTIES.filter((key) => !OMITTED.includes(key)).sort());
  return UNIT_PROPERTIES.filter((key) => key in values).map((key) => `${key}=${values[key]}`).join('\n') + '\n';
}

const managerV6 = await import(pathToFileURL(path.join(PACKAGE, MANAGER)).href);
const managerV4 = await importBytes('v4/linux-process-manager.mjs', reverseApply('v4-to-v5-executable.patch', MANAGER, read(MANAGER)));
const releaseV5 = reverseApply('v5-to-v6-executable.patch', RELEASE, read(RELEASE)).toString('utf8');

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
const { pdfReleaseConfig } = await import(pathToFileURL(path.join(payload, RELEASE.slice('payload/'.length))).href);
const mainPdfConfig = fs.readFileSync(path.join(REPO, PDF_CONFIG));

function deriveFrom(bytes, pin = sha256(bytes)) {
  fs.writeFileSync(path.join(source, PDF_CONFIG), bytes);
  return pdfReleaseConfig({ sourcePins: { [PDF_CONFIG]: pin } });
}

test('the committed package is the revision 6 installed on the Host, byte for byte', () => {
  const freeze = JSON.parse(read('source-freeze.json'));
  const manifest = JSON.parse(read('package-manifest.json'));
  assert.equal(freeze.revision, 6);
  assert.equal(manifest.revision, 6);
  assert.equal(sha256(read('package-manifest.json')), INSTALLED_MANIFEST);
  assert.equal(sha256(read('source-freeze.json')), SOURCE_FREEZE);
  assert.equal(freeze.packageManifestSha256, INSTALLED_MANIFEST);
  assert.deepEqual(listFiles(PACKAGE).sort(), [...Object.keys(freeze.sourceFiles), 'source-freeze.json'].sort());
  for (const [file, { bytes, sha256: expected }] of Object.entries(freeze.sourceFiles)) {
    assert.equal(sha256(read(file)), expected, file);
    assert.equal(read(file).length, bytes, file);
  }
  for (const [file, { bytes, sha256: expected }] of Object.entries(manifest.files)) {
    assert.equal(sha256(read(file)), expected, file);
    assert.equal(read(file).length, bytes, file);
  }
  for (const [name, file] of [['EXTERNAL', 'payload/release/verify-currentness-external.mjs'], ['MANAGER', MANAGER],
    ['PORTS', 'payload/release/existing-release-entry-v1/fixed-currentness-ports.mjs']]) {
    assert.ok(read(STAGES).toString('utf8').includes(`[${name},'${sha256(read(file))}']`), `${STAGES} pins ${file}`);
  }
});

test('the committed patches rebuild the exact v4 and v5 predecessors', () => {
  // The two git-format patches, v4-to-v5 and v5-to-v6, name the object ids of
  // both sides in their `index` lines; v3-to-v4 is a plain diff without them.
  for (const [patchFile, file] of [['v4-to-v5-executable.patch', MANAGER], ['v4-to-v5-executable.patch', STAGES],
    ['v5-to-v6-executable.patch', RELEASE]]) {
    const [older, newer] = patchSection(patchFile, file).match(/^index ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/m).slice(1);
    assert.ok(gitBlob(read(file)).startsWith(newer), `${patchFile}: ${file} is not the patched side`);
    assert.ok(gitBlob(reverseApply(patchFile, file, read(file))).startsWith(older), `${patchFile}: ${file} predecessor`);
  }
  assert.equal(sha256(reverseApply('v4-to-v5-executable.patch', MANAGER, read(MANAGER))), V4_MANAGER);
  assert.ok(read('v4-to-v5-executable.patch').toString('utf8').includes(`- [MANAGER,'${V4_MANAGER}'],`));
  assert.equal(sha256(Buffer.from(releaseV5)), V5_RELEASE);
});

test('systemd 255: the v4 manager refuses the show reply, the v6 manager accepts it', () => {
  const reply = systemd255Reply();
  assert.equal(code(() => managerV4.parseSystemdShow(reply, config, 'head')), 'MANAGER_SYSTEMD_BOUNDARY_UNPROVEN');
  const values = managerV6.parseSystemdShow(reply, config, 'head');
  for (const key of OMITTED) assert.equal(values[key], '', key);
  // A systemd that still prints the seven empty properties passes both.
  const explicit = reply + OMITTED.map((key) => `${key}=`).join('\n') + '\n';
  assert.equal(code(() => managerV4.parseSystemdShow(explicit, config, 'head')), 'PASS');
  assert.equal(code(() => managerV6.parseSystemdShow(explicit, config, 'head')), 'PASS');
});

test('systemd 255: the v6 manager keeps every other refusal of the v4 manager', () => {
  const reply = systemd255Reply();
  const parse = (manager, text) => code(() => manager.parseSystemdShow(text, config, 'head'));
  const command = '{ path=/bin/true ; argv[]=/bin/true ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';
  for (const key of OMITTED) {
    const value = key === 'EnvironmentFiles' ? '/etc/x (ignore_errors=no)' : command;
    const explicit = reply + OMITTED.map((name) => `${name}=${name === key ? value : ''}`).join('\n') + '\n';
    assert.equal(parse(managerV6, `${reply}${key}=${value}\n`), 'MANAGER_LOADED_UNIT_MISMATCH', `v6, ${key} set`);
    assert.equal(parse(managerV6, explicit), 'MANAGER_LOADED_UNIT_MISMATCH', `v6, ${key} set, the six empty`);
    assert.equal(parse(managerV4, explicit), 'MANAGER_LOADED_UNIT_MISMATCH', `v4, ${key} set, the six empty`);
  }
  for (const key of UNIT_PROPERTIES.filter((name) => !OMITTED.includes(name))) {
    const missing = reply.split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n');
    assert.equal(parse(managerV6, missing), 'MANAGER_SYSTEMD_BOUNDARY_UNPROVEN', `a reply without ${key}`);
  }
  for (const extra of ['Foo=bar', 'User=994']) {
    assert.equal(parse(managerV6, `${reply}${extra}\n`), 'MANAGER_SYSTEMD_REPLY_INVALID', extra);
    assert.equal(parse(managerV4, `${reply}${extra}\n`), 'MANAGER_SYSTEMD_REPLY_INVALID', extra);
  }
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
  const v6 = deploy('--outdir', path.join(scratch, 'out-v6'));
  assert.equal(v6.status, 0, v6.stdout + v6.stderr);
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
