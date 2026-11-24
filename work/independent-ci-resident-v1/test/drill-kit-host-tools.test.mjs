// Fable ruling 0e418483 (r7 phase B, D:/w/tmp/FABLE-r7-phase-b-image-id-20261121.md) 4.1 step 3: before any boot, the kit's staged .debs
// carry every host tool the kit's acceptance pins (fleetRefs.formalRoles.<role>.hostTools.<name>) as a regular file with the pinned
// sha256, or make-drill-kit.mjs builds no kit. r7's kit staged the docker closure only: the node's /usr/bin/python3.12 was the rootfs's
// (3.12.3-1ubuntu0.16), not the fleet's pin (0.17), and nothing before the boot looked. Each case below went through makeDrillKit itself:
// the .debs are real ar archives with a zstd data.tar (as Ubuntu's), the tar entries in the shapes dpkg writes (./ paths, GNU long
// names, pax paths, a symlink).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { makeDrillKit, prepareFrom } from '../drill/make-drill-kit.mjs';
import { writeTar } from '../rollout/fleet/tar.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-kit-host-tools-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PYTHON = Buffer.from('the fleet pinned python3.12, 3.12.3-1ubuntu0.17\n');
const OLD_PYTHON = Buffer.from('the rootfs python3.12, 3.12.3-1ubuntu0.16\n');
const JQ = Buffer.from('jq\n');

// One tar header: ustar (POSIX, with a prefix) or GNU ("ustar  \0").
function header(name, size, type, { linkname = '', gnu = false, prefix = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8'); h.write('0000755\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.fill(' ', 148, 156); h.write(type, 156); h.write(linkname, 157, 100);
  if (gnu) h.write('ustar  \0', 257, 'latin1'); else { h.write('ustar\0', 257, 'latin1'); h.write('00', 263); h.write(prefix, 345, 155); }
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}
const padded = b => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
// entries: { name, data, type = '0', linkname, form: 'ustar' | 'gnu' | 'gnu-long' | 'pax' | 'prefix' }
function tar(entries) {
  const parts = [];
  for (const { name, data = Buffer.alloc(0), type = '0', linkname = '', form = 'gnu' } of entries) {
    if (form === 'gnu-long') {
      const long = Buffer.from(name + '\0');
      parts.push(header('././@LongLink', long.length, 'L', { gnu: true }), padded(long), header(name.slice(0, 99), data.length, type, { linkname, gnu: true }));
    } else if (form === 'pax') {
      const rec = body => { let n = body.length + 3; while (`${n} ${body}\n`.length !== n) n++; return `${n} ${body}\n`; };
      const pax = Buffer.from(rec(`path=${name}`));
      parts.push(header('PaxHeader/x', pax.length, 'x'), padded(pax), header('x', data.length, type, { linkname }));
    } else if (form === 'prefix') {
      const cut = name.lastIndexOf('/');
      parts.push(header(name.slice(cut + 1), data.length, type, { linkname, prefix: name.slice(0, cut) }));
    } else parts.push(header(name, data.length, type, { linkname, gnu: form === 'gnu' }));
    if (data.length) parts.push(padded(data));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function ar(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, body] of members) {
    parts.push(Buffer.from(`${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(body.length).padEnd(10)}\`\n`, 'latin1'), body);
    if (body.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}
const deb = (entries, member = 'data.tar.zst') => ar([['debian-binary', Buffer.from('2.0\n')], ['control.tar.zst', zlib.zstdCompressSync(tar([]))],
  [member, member === 'data.tar.zst' ? zlib.zstdCompressSync(tar(entries)) : tar(entries)]]);
const dir = name => ({ name, type: '5', form: 'gnu' });

const DOCKER = deb([dir('./'), dir('./usr/'), dir('./usr/bin/'), { name: './usr/bin/docker', data: Buffer.from('docker\n') }]);
const PYTHON_DEB = deb([dir('./'), dir('./usr/'), dir('./usr/bin/'), { name: './usr/bin/python3.12', data: PYTHON },
  { name: './usr/share/doc/python3.12-minimal/' + 'a-long-name-'.repeat(12), data: Buffer.from('x'), form: 'gnu-long' }]);
const PINS = { gitleaks: { image: 'g', hostTools: { python: { path: '/usr/bin/python3.12', sha256: sha(PYTHON) } } }, trivy: { image: 't' }, 'contract-placement': { image: 'c' } };

// An accepted version's From directory (prepareFrom on a build/final/images layout) and its prereq.json staging `debs`.
let n = 0;
// extra: more items of the package's prereq-manifest.json, ones prereq.json does not stage (node, python, ...: the host cache's)
function assets(debs, { formalRoles = PINS, extra = [] } = {}) {
  const root = path.join(tmp, `k${n++}`); fs.mkdirSync(root);
  for (const d of ['build', 'final', 'images']) fs.mkdirSync(path.join(root, d));
  const version = '1.2.3', tag = `fleet-node-${version}`, id = 'b'.repeat(64), image = `role-image-${id}.tar.gz`;
  const kit = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-node-first-install-kit/1', images: { local: [{ id, asset: image }] },
    record: { supabaseUrl: 'https://prodfixture0000000000.supabase.co', publishableKey: 'sb_publishable_prodfix' } }));
  const items = [{ fileName: 'wsl.msi', sha256: sha('wsl'), bytes: 3 }, { fileName: 'ubuntu.wsl', sha256: sha('rootfs'), bytes: 6 },
    { name: 'gh', fileName: 'gh.msi', sha256: sha('gh'), bytes: 2 }, { name: 'git-for-windows', fileName: 'git.exe', sha256: sha('git'), bytes: 3 }, ...extra];
  const archive = writeTar([
    { path: 'tree/work/independent-ci-resident-v1/rollout/fleet/bootstrap.ps1', data: Buffer.from('# accepted bootstrap\r\n') },
    { path: 'tree/work/independent-ci-resident-v1/rollout/fleet/prereq-manifest.json', data: Buffer.from(JSON.stringify({ items,
      debs: Object.entries(debs).map(([fileName, b]) => ({ fileName, sha256: sha(b), bytes: b.length })) })) },
    { path: 'tree/work/independent-ci-resident-v1/windows/credential-files.json', data: Buffer.from(JSON.stringify({
      contract: 'clued.independent-ci.credential-files/1', required: { appKey: 'app-private-key.pem' }, optional: {} })) },
    { path: 'universal-manifest.json', data: Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.fleet-universal/1', version, commit: 'c'.repeat(40), files: [] })) }]);
  fs.writeFileSync(path.join(root, 'build', `${tag}.tar`), archive);
  fs.writeFileSync(path.join(root, 'build', `${tag}.release.json`), '{}');
  fs.writeFileSync(path.join(root, 'build', 'SHA256SUMS'), `${sha(archive)}  ${tag}.tar\n${sha('{}')}  ${tag}.release.json\n`);
  fs.writeFileSync(path.join(root, 'final', `${tag}.first-install-kit.json`), kit);
  fs.writeFileSync(path.join(root, 'final', `${tag}.acceptance.json`), JSON.stringify({ contract: 'clued.independent-ci.fleet-node-acceptance/1',
    version, archive_sha256: sha(archive), firstInstallKitSha256: sha(kit), ciSourceManifestSha256: 'a'.repeat(64), fleetRefs: { formalRoles } }));
  fs.writeFileSync(path.join(root, 'images', image), 'fake image fixture');
  const prereq = path.join(root, 'prereq.json');
  fs.writeFileSync(prereq, JSON.stringify({ contract: 'clued.drill.prereq/1', wsl: { path: 'wsl.msi', sha256: sha('wsl') }, rootfs: { path: 'ubuntu.wsl', sha256: sha('rootfs') },
    debs: Object.entries(debs).map(([p, b]) => ({ path: `debs\\${p}`, sha256: sha(b) })), tools: [{ path: 'gh.msi', sha256: sha('gh') }, { path: 'git.exe', sha256: sha('git') }] }));
  fs.mkdirSync(path.join(root, 'debs'));
  for (const [name, b] of [['wsl.msi', 'wsl'], ['ubuntu.wsl', 'rootfs'], ['gh.msi', 'gh'], ['git.exe', 'git'], ...Object.entries(debs).map(([p, b]) => [`debs/${p}`, b])]) fs.writeFileSync(path.join(root, name), b);
  const f = { build: path.join(root, 'build'), final: path.join(root, 'final'), images: path.join(root, 'images'), version, prereq, from: path.join(root, 'from'), out: path.join(root, 'kit'),
    // the drill's server (drill-server.json in a real run): fixture values, registered nowhere
    server: { contract: 'clued.drill.server/1', project: 'fixture-drill-project', supabaseUrl: 'https://drillfixture000000000.supabase.co', poolerHost: null, publishableKey: 'sb_publishable_drilltest', blackholeHosts: [], allowedHosts: [] } };
  prepareFrom({ ...f, out: f.from });
  return f;
}
async function refused(f, code) {
  await assert.rejects(() => makeDrillKit(f), e => { assert.equal(e.message, code); return true; });
  assert.ok(!fs.existsSync(f.out), 'refused before a kit is written');
}

test('the staged python3.12 is the fleet pin: the kit is built and names the .deb that carries it', async () => {
  for (const form of ['gnu', 'ustar', 'pax', 'prefix', 'gnu-long']) {
    const py = deb([dir('./usr/bin/'), { name: form === 'prefix' || form === 'gnu-long' ? 'usr/bin/python3.12' : './usr/bin/python3.12', data: PYTHON, form }]);
    const r = await makeDrillKit(assets({ 'docker.io_1_amd64.deb': DOCKER, 'python3.12-minimal_0.17_amd64.deb': py }));
    assert.deepEqual(r.hostTools, [{ path: '/usr/bin/python3.12', sha256: sha(PYTHON), debs: ['python3.12-minimal_0.17_amd64.deb'] }], form);
  }
  const r = await makeDrillKit(assets({ 'docker.io_1_amd64.deb': DOCKER, 'python3.12-minimal_0.17_amd64.deb': PYTHON_DEB }));
  assert.equal(r.hostTools.length, 1);
});

test('a staged python3.12 that is not the fleet pin refuses the kit (r7: the rootfs 0.16 file under a 0.17 pin)', async () => {
  const old = deb([dir('./usr/bin/'), { name: './usr/bin/python3.12', data: OLD_PYTHON }]);
  await refused(assets({ 'docker.io_1_amd64.deb': DOCKER, 'python3.12-minimal_0.16_amd64.deb': old }), 'DRILL_KIT_HOST_TOOL_NOT_THE_FLEET_PIN:/usr/bin/python3.12');
  // two staged .debs with the path: both must be the pin
  await refused(assets({ 'a.deb': PYTHON_DEB, 'b.deb': old }), 'DRILL_KIT_HOST_TOOL_NOT_THE_FLEET_PIN:/usr/bin/python3.12');
  // a symlink at the path is no pinned file
  const link = deb([{ name: './usr/bin/python3.12', type: '2', linkname: 'python3' }]);
  await refused(assets({ 'python3.12-minimal_0.17_amd64.deb': link }), 'DRILL_KIT_HOST_TOOL_NOT_THE_FLEET_PIN:/usr/bin/python3.12');
});

test('no staged .deb carries the pinned path: the kit is refused (r7 staged the docker closure only)', async () => {
  await refused(assets({ 'docker.io_1_amd64.deb': DOCKER }), 'DRILL_KIT_HOST_TOOL_NOT_IN_THE_DEBS:/usr/bin/python3.12');
  await refused(assets({}), 'DRILL_KIT_HOST_TOOL_NOT_IN_THE_DEBS:/usr/bin/python3.12');
});

test('every role and every tool is held, not python alone', async () => {
  const roles = { ...PINS, trivy: { image: 't', hostTools: { jq: { path: '/usr/bin/jq', sha256: sha(JQ) } } } };
  const jq = good => deb([{ name: './usr/bin/jq', data: good ? JQ : Buffer.from('another jq\n') }]);
  await refused(assets({ 'py.deb': PYTHON_DEB, 'jq.deb': jq(false) }, { formalRoles: roles }), 'DRILL_KIT_HOST_TOOL_NOT_THE_FLEET_PIN:/usr/bin/jq');
  await refused(assets({ 'py.deb': PYTHON_DEB }, { formalRoles: roles }), 'DRILL_KIT_HOST_TOOL_NOT_IN_THE_DEBS:/usr/bin/jq');
  const r = await makeDrillKit(assets({ 'py.deb': PYTHON_DEB, 'jq.deb': jq(true) }, { formalRoles: roles }));
  assert.deepEqual(r.hostTools?.map(t => t.path), ['/usr/bin/python3.12', '/usr/bin/jq']);
});

test('a pin of the wrong shape and a .deb that cannot be read are refused, by name', async () => {
  for (const bad of [{ path: 'usr/bin/python3.12', sha256: sha(PYTHON) }, { path: '/usr/../bin/python3.12', sha256: sha(PYTHON) }, { path: '/usr/bin/python3.12', sha256: 'E'.repeat(64) }, {}]) {
    await refused(assets({ 'py.deb': PYTHON_DEB }, { formalRoles: { gitleaks: { hostTools: { python: bad } } } }), 'DRILL_KIT_HOST_TOOL_REFUSED:gitleaks.python');
  }
  await refused(assets({ 'py.deb': deb([{ name: './usr/bin/python3.12', data: PYTHON }], 'data.tar.xz') }), 'DRILL_KIT_DEB_UNREADABLE:py.deb');
  await refused(assets({ 'py.deb': Buffer.from('not an ar archive') }), 'DRILL_KIT_DEB_UNREADABLE:py.deb');
});

test('an acceptance that pins no host tool: nothing to hold here, the .debs are not read', async () => {
  const r = await makeDrillKit(assets({ 'docker.deb': Buffer.from('deb') }, { formalRoles: { gitleaks: { image: 'g' } } }));
  assert.deepEqual(r.hostTools, []);
});

// Fable ruling 0e418483 (D:/w/tmp/FABLE-node-install-batch-20261124.md section 3.3 A): every item of the package's prereq-manifest.json is in
// the kit, or no kit. One the host's prereq.json does not stage comes from the host cache (<prereq dir>\cache\<file name>); missing there,
// the builder fetches it once from the manifest's own address, holds it to the manifest's sha256 and size, and only creates the cache file.
const NODE = Buffer.from('node-v24 win-x64 zip fixture\n');
const NODE_ITEM = { name: 'node', url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip', fileName: 'node-v24.21.0-win-x64.zip', kind: 'zip',
  sha256: sha(NODE), bytes: NODE.length };
const PY_DEBS = { 'py.deb': PYTHON_DEB };
// the package names nodejs.org (its manifest's address): the drill's server registers it as not Clued's, as drill-server.json does
const withNode = () => { const f = assets(PY_DEBS, { extra: [NODE_ITEM] }); return { ...f, server: { ...f.server, allowedHosts: ['nodejs.org'] } }; };

test('P1: an item only the manifest pins (node) is fetched once from its address into the host cache and carried in the kit', async () => {
  const f = withNode();
  const asked = [];
  await makeDrillKit({ ...f, fetchPrereq: async item => { asked.push(item.url); return NODE; } });
  const kit = JSON.parse(fs.readFileSync(path.join(f.out, 'kit.json'), 'utf8'));
  assert.deepEqual(kit.files.filter(x => x.path === NODE_ITEM.fileName), [{ path: NODE_ITEM.fileName, sha256: NODE_ITEM.sha256 }]);
  assert.deepEqual(asked, [NODE_ITEM.url]);
  const cached = path.join(path.dirname(f.prereq), 'cache', NODE_ITEM.fileName);
  assert.equal(sha(fs.readFileSync(cached)), NODE_ITEM.sha256);
  // the next kit takes it from the cache: never fetched again
  await makeDrillKit({ ...f, out: `${f.out}-2`, fetchPrereq: async () => assert.fail('fetched again') });
  assert.ok(fs.existsSync(path.join(`${f.out}-2`, NODE_ITEM.fileName)));
  // the kit says the guest's own download was not drilled
  assert.ok(kit.perNodeSteps.some(x => /前置由宿主注入/.test(x)), JSON.stringify(kit.perNodeSteps));
});

test('P1: fetched bytes that are not the manifest\'s, or a cache file changed, refuse the kit; nothing is cached', async () => {
  const f = withNode();
  await refused({ ...f, fetchPrereq: async () => Buffer.from('another node\n') }, 'DRILL_PREREQ_TOOLS_INCOMPLETE:node');
  assert.ok(!fs.existsSync(path.join(path.dirname(f.prereq), 'cache', NODE_ITEM.fileName)), 'wrong bytes are never cached');
  await refused({ ...f, fetchPrereq: async () => { throw new Error('ECONNRESET'); } }, 'DRILL_PREREQ_TOOLS_INCOMPLETE:node');
  const g = withNode();
  fs.mkdirSync(path.join(path.dirname(g.prereq), 'cache'));
  fs.writeFileSync(path.join(path.dirname(g.prereq), 'cache', NODE_ITEM.fileName), 'changed');
  await refused({ ...g, fetchPrereq: async () => assert.fail('a cache file is never replaced') }, `DRILL_PREREQ_CHANGED:${NODE_ITEM.fileName}`);
});
