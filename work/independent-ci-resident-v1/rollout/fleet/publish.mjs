// Archive one universal node package on a GitHub Release (Decision b5d041d2 v2) and keep the 资料中心 index.
//
//   node rollout/fleet/publish.mjs release --dir <universal.mjs build out> --repo <owner/name> [--index <index file>]
//   node rollout/fleet/publish.mjs attach-acceptance --version <v> --acceptance <fleet-node-<v>.acceptance.json> [--repo <owner/name>] [--index <index file>] [--dir <build out>]
//   node rollout/fleet/publish.mjs attach-first-install-kit --version <v> --kit <fleet-node-<v>.first-install-kit.json> [--image <role-image-<id>.tar.gz> ...] [--repo <owner/name>]
//
// release: the build output is checked first (exactly one fleet-node-<v>.release.json, its tar with the sha256 it names, SHA256SUMS naming
//   both). The index must not name this version yet (an absent index is created with its header). Then
//   gh release create fleet-node-<v> <tar> <release.json> SHA256SUMS --repo <repo> --target <commit> ..., gh release view checks the
//   three assets by name and size, and only after that one row is appended: | version | Release URL | tar sha256 | commit | | |.
//   Two more assets are the node entry of a first install (rollout/fleet/bootstrap.ps1 and prereq-manifest.json), taken from the
//   checked archive itself (never a working-tree copy: the bytes the Owner accepts) as fleet-node-<v>.bootstrap.ps1 and
//   fleet-node-<v>.prereq-manifest.json; the published SHA256SUMS is the build's two lines plus these two (written into a new temporary
//   directory; the build output is not changed). An archive without them is refused before gh is called.
// attach-first-install-kit: the coordinator's first-install kit (install.mjs first-install-kit, contract
//   clued.independent-ci.fleet-node-first-install-kit/1) and the role images it lists as local (images.local[].{id, asset}: each
//   asset role-image-<64hex>.tar.gz, a gzip of the template node's docker save; exactly those, no more, no fewer), uploaded one by one
//   without --clobber, then fleet-node-<v>.first-install.SHA256SUMS over them (the release's SHA256SUMS was published with the release
//   and is never replaced). A release that already has the kit or that sums file is refused before anything is uploaded. The index is
//   not changed: the kit is not an acceptance.
// attach-acceptance: the Owner's acceptance file (contract clued.independent-ci.fleet-node-acceptance/1) is checked against the index
//   row of that version (archive_sha256 and commit; with --dir also against the build's release.json), its whole contract as
//   install.mjs prepare reads it (validateAcceptance: repository = --repo, ciSourceManifestSha256, fleetRefs); its file name must be
//   fleet-node-<v>.acceptance.json. It is uploaded as an extra asset (gh release upload, never --clobber: the tar stays as it is) and
//   the row's accepted-at and Decision cells are filled. A row that already has them is refused before anything is uploaded.
// Credentials come only from gh's own login: GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN are removed from
// gh's environment, and nothing here reads, writes or prints a token.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import os from 'node:os';
import { RESIDENT } from './facts.mjs';
import { validateAcceptance } from './install.mjs';
import { readTar } from './tar.mjs';
import { RELEASE_CONTRACT, VERSION, tagOf } from './universal.mjs';

export const ACCEPTANCE_CONTRACT = 'clued.independent-ci.fleet-node-acceptance/1';
export const DEFAULT_REPO = 'tdoljyj/cross-memory-system';
export const DEFAULT_INDEX = 'G:\\我的云端硬盘\\Clued_资料中心\\10_E_工程与平台\\CI基础设施\\通用节点包_归档索引.md';
export const INDEX_HEADER = ['版本', 'Release', 'tar sha256', 'commit', '接受时间', 'Decision'];
export const KIT_CONTRACT = 'clued.independent-ci.fleet-node-first-install-kit/1';
// the node entry of a first install, in the archive's tree: published asset name suffix -> archive path
export const NODE_ENTRY = Object.freeze({ 'bootstrap.ps1': `tree/${RESIDENT}/rollout/fleet/bootstrap.ps1`, 'prereq-manifest.json': `tree/${RESIDENT}/rollout/fleet/prereq-manifest.json` });
const ROLE_IMAGE = /^role-image-([0-9a-f]{64})\.tar\.gz$/;
const sumsText = pairs => [...pairs].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([n, h]) => `${h}  ${n}\n`).join('');
const sha = b => createHash('sha256').update(b).digest('hex');
const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`), { code, detail }); };
const check = (ok, code, detail) => { if (!ok) fail(code, detail); };
const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function readBuild(dir) {
  const names = await fs.readdir(dir);
  const releases = names.filter(n => /^fleet-node-.+\.release\.json$/.test(n));
  check(releases.length === 1, 'PUBLISH_BUILD_DIR_REFUSED', { releases });
  const releaseBytes = await fs.readFile(path.join(dir, releases[0]));
  const release = JSON.parse(releaseBytes.toString('utf8'));
  const s = release?.source;
  check(release?.contract === RELEASE_CONTRACT && VERSION.test(s?.version ?? '') && s.release_tag === tagOf(s.version) && /^[0-9a-f]{40}$/.test(s.commit ?? '')
    && releases[0] === `${tagOf(s.version)}.release.json` && release.archive?.name === `${tagOf(s.version)}.tar`, 'PUBLISH_RELEASE_REFUSED');
  const tarBytes = await fs.readFile(path.join(dir, release.archive.name));
  check(sha(tarBytes) === s.archive_sha256 && release.archive.sha256 === s.archive_sha256 && tarBytes.length === release.archive.bytes, 'PUBLISH_ARCHIVE_SHA_MISMATCH');
  const sums = (await fs.readFile(path.join(dir, 'SHA256SUMS'))).toString('utf8');
  const want = [[release.archive.name, s.archive_sha256], [releases[0], sha(releaseBytes)]].map(([n, h]) => `${h}  ${n}`).sort();
  check(sums.split('\n').filter(Boolean).sort().join('\n') === want.join('\n'), 'PUBLISH_SHA256SUMS_MISMATCH');
  return { release, tarBytes, sums, assets: [release.archive.name, releases[0], 'SHA256SUMS'].map(n => ({ name: n, file: path.join(dir, n) })) };
}

// The node entry assets from the checked archive, and the SHA256SUMS that lists them with the build's two files, in a new directory.
export async function stageNodeEntry({ release, tarBytes, sums }, stage) {
  const tag = tagOf(release.source.version);
  const byPath = new Map(readTar(tarBytes).map(e => [e.path, e.data]));
  const out = [];
  const lines = sums.split('\n').filter(Boolean).map(l => { const i = l.indexOf('  '); return [l.slice(i + 2), l.slice(0, i)]; });
  for (const [suffix, at] of Object.entries(NODE_ENTRY)) {
    const data = byPath.get(at);
    check(data !== undefined, 'PUBLISH_ARCHIVE_LACKS_NODE_ENTRY', at);
    const name = `${tag}.${suffix}`;
    await fs.writeFile(path.join(stage, name), data, { flag: 'wx' });
    out.push({ name, file: path.join(stage, name) });
    lines.push([name, sha(data)]);
  }
  await fs.writeFile(path.join(stage, 'SHA256SUMS'), sumsText(lines), { flag: 'wx' });
  return { sums: { name: 'SHA256SUMS', file: path.join(stage, 'SHA256SUMS') }, entry: out };
}

function gh(ghCommand, args) {
  const env = { ...process.env };
  for (const k of TOKEN_ENV) delete env[k];
  const [cmd, ...pre] = ghCommand;
  const r = spawnSync(cmd, [...pre, ...args], { env, maxBuffer: 1 << 24, windowsHide: true });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error ?? '').trim().slice(-300) };
}

// ---- the index: a markdown table of six columns; its own line ending is kept; an older five-column table is completed ----
const isRow = l => l.startsWith('|');
const cells = line => line.split('|').slice(1, -1).map(c => c.trim());
const row = c => `| ${c.join(' | ')} |`;
async function readIndex(index) {
  let text = null;
  try { text = (await fs.readFile(index)).toString('utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === null ? [row(INDEX_HEADER), `|${INDEX_HEADER.map(() => '---').join('|')}|`] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const first = lines.findIndex(isRow);
  return { eol, lines: lines.map((l, i) => {
    if (!isRow(l)) return l;
    const c = cells(l);
    if (c.length >= INDEX_HEADER.length) return l;
    if (c.every(x => /^:?-+:?$/.test(x))) return `|${INDEX_HEADER.map(() => '---').join('|')}|`;
    while (c.length < INDEX_HEADER.length) c.push(i === first ? INDEX_HEADER[c.length] : '');
    return row(c);
  }) };
}
const findRow = (lines, version) => lines.findIndex(l => isRow(l) && cells(l)[0] === version);
async function writeIndex(index, lines, eol) {
  await fs.mkdir(path.dirname(index), { recursive: true });
  await fs.writeFile(index, lines.join(eol) + eol);
}

function viewRelease(ghCommand, repo, tag) {
  const viewed = gh(ghCommand, ['release', 'view', tag, '--repo', repo, '--json', 'url,tagName,assets']);
  check(viewed.status === 0, 'PUBLISH_GH_RELEASE_VIEW_FAILED', viewed.stderr);
  const v = JSON.parse(viewed.stdout);
  check(v.tagName === tag && typeof v.url === 'string' && /^https:\/\//.test(v.url), 'PUBLISH_RELEASE_NOT_AS_CREATED', { tagName: v.tagName });
  return { url: v.url, assets: Array.isArray(v.assets) ? v.assets : [] };
}

export async function publish({ dir, repo = DEFAULT_REPO, index = DEFAULT_INDEX, ghCommand = ['gh'] }) {
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  const build = await readBuild(dir);
  const s = build.release.source;
  const idx = await readIndex(index);
  check(findRow(idx.lines, s.version) < 0, 'PUBLISH_INDEX_ALREADY_HAS_VERSION', s.version);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-publish-'));
  try {
    const { sums, entry } = await stageNodeEntry(build, stage);
    return await publishAssets({ ghCommand, repo, index, idx, s, assets: [build.assets[0], build.assets[1], sums, ...entry] });
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function publishAssets({ ghCommand, repo, index, idx, s, assets }) {
  for (const a of assets) await fs.access(a.file);
  const notes = [`Universal node package ${s.version} (commit ${s.commit}).`, `archive_sha256 ${s.archive_sha256}`,
    `resident_manifest_sha256 ${s.resident_manifest_sha256}`,
    `source_manifest_sha256 ${s.source_manifest_sha256}`, `upgrader_manifest_sha256 ${s.upgrader_manifest_sha256}`,
    `bundle_sha256 ${s.bundle_sha256}`, `universal_files_sha256 ${s.universal_files_sha256}`].join('\n');
  const created = gh(ghCommand, ['release', 'create', s.release_tag, ...assets.map(a => a.file), '--repo', repo, '--target', s.commit, '--title', s.release_tag, '--notes', notes]);
  check(created.status === 0, 'PUBLISH_GH_RELEASE_CREATE_FAILED', created.stderr);
  const v = viewRelease(ghCommand, repo, s.release_tag);
  for (const a of assets) {
    const size = (await fs.stat(a.file)).size;
    check(v.assets.some(x => x.name === a.name && x.size === size), 'PUBLISH_RELEASE_ASSET_MISSING', a.name);
  }
  const line = row([s.version, v.url, s.archive_sha256, s.commit, '', '']);
  await writeIndex(index, [...idx.lines, line], idx.eol);
  return { status: 'FLEET_RELEASE_PUBLISHED', tag: s.release_tag, url: v.url, archiveSha256: s.archive_sha256, commit: s.commit, indexLine: line };
}

export async function readAcceptance(file, version) {
  check(path.basename(file) === `${tagOf(version)}.acceptance.json`, 'ACCEPTANCE_FILE_NAME_REFUSED', path.basename(file));
  let a;
  try { a = JSON.parse((await fs.readFile(file)).toString('utf8')); } catch { fail('ACCEPTANCE_NOT_JSON'); }
  check(a?.contract === ACCEPTANCE_CONTRACT, 'ACCEPTANCE_CONTRACT_REFUSED');
  check(a.version === version, 'ACCEPTANCE_VERSION_MISMATCH', a.version);
  check(/^[0-9a-f]{64}$/.test(a.archive_sha256 ?? '') && /^[0-9a-f]{40}$/.test(a.commit ?? ''), 'ACCEPTANCE_SHAPE_REFUSED');
  check(/^([0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(a.cluedDecision ?? ''), 'ACCEPTANCE_DECISION_REFUSED');
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(a.acceptedAt ?? '') && !Number.isNaN(Date.parse(a.acceptedAt)), 'ACCEPTANCE_TIME_REFUSED');
  check(a.fleetRefs && typeof a.fleetRefs === 'object' && !Array.isArray(a.fleetRefs), 'ACCEPTANCE_FLEETREFS_REFUSED');
  // the whole contract as every node's install.mjs prepare reads it (repository, ciSourceManifestSha256 from install.mjs source-hash, fleetRefs)
  try { validateAcceptance(a); } catch (e) { fail('ACCEPTANCE_REFUSED', e?.detail ?? e?.code ?? String(e)); }
  return a;
}

export async function attachAcceptance({ version, acceptance, repo = DEFAULT_REPO, index = DEFAULT_INDEX, dir = null, ghCommand = ['gh'] }) {
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  check(VERSION.test(version ?? ''), 'PUBLISH_VERSION_REFUSED');
  const a = await readAcceptance(acceptance, version);
  check(a.repository === repo, 'ACCEPTANCE_NOT_THIS_REPOSITORY', a.repository);
  const idx = await readIndex(index);
  const at = findRow(idx.lines, version);
  check(at >= 0, 'PUBLISH_INDEX_LACKS_VERSION', version);
  const c = cells(idx.lines[at]);
  check(c[4] === '' && c[5] === '', 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED', { acceptedAt: c[4], decision: c[5] });
  check(a.archive_sha256 === c[2] && a.commit === c[3], 'ACCEPTANCE_NOT_THIS_RELEASE');
  if (dir) {
    const { release } = await readBuild(dir);
    check(release.source.version === version && release.source.archive_sha256 === a.archive_sha256 && release.source.commit === a.commit, 'ACCEPTANCE_NOT_THIS_RELEASE');
  }
  const tag = tagOf(version);
  const size = (await fs.stat(acceptance)).size;
  const up = gh(ghCommand, ['release', 'upload', tag, acceptance, '--repo', repo]);
  check(up.status === 0, 'PUBLISH_GH_RELEASE_UPLOAD_FAILED', up.stderr);
  const v = viewRelease(ghCommand, repo, tag);
  check(v.assets.some(x => x.name === path.basename(acceptance) && x.size === size), 'PUBLISH_RELEASE_ASSET_MISSING', path.basename(acceptance));
  c[4] = a.acceptedAt;
  c[5] = a.cluedDecision;
  idx.lines[at] = row(c);
  await writeIndex(index, idx.lines, idx.eol);
  return { status: 'FLEET_ACCEPTANCE_ATTACHED', tag, url: v.url, version, acceptedAt: a.acceptedAt, cluedDecision: a.cluedDecision, indexLine: idx.lines[at] };
}

// The first-install kit and the local role images it names, then one sums file over them (see the head of this file).
export async function attachFirstInstallKit({ version, kit, images = [], repo = DEFAULT_REPO, ghCommand = ['gh'] }) {
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  check(VERSION.test(version ?? ''), 'PUBLISH_VERSION_REFUSED');
  const tag = tagOf(version);
  check(path.basename(kit) === `${tag}.first-install-kit.json`, 'FIRST_INSTALL_KIT_FILE_NAME_REFUSED', path.basename(kit));
  const kitBytes = await fs.readFile(kit);
  let k;
  try { k = JSON.parse(kitBytes.toString('utf8')); } catch { fail('FIRST_INSTALL_KIT_NOT_JSON'); }
  check(k?.contract === KIT_CONTRACT, 'FIRST_INSTALL_KIT_CONTRACT_REFUSED');
  const local = Array.isArray(k.images?.local) ? k.images.local : null;
  check(local && local.every(i => /^[0-9a-f]{64}$/.test(i?.id ?? '') && i.asset === `role-image-${i.id}.tar.gz`), 'FIRST_INSTALL_KIT_IMAGES_REFUSED');
  const given = [];
  for (const f of images) {
    const m = ROLE_IMAGE.exec(path.basename(f));
    check(m, 'FIRST_INSTALL_IMAGE_FILE_NAME_REFUSED', path.basename(f));
    given.push({ id: m[1], file: f, bytes: await fs.readFile(f) });
  }
  const want = [...new Set(local.map(i => i.id))].sort(), have = given.map(g => g.id).sort();
  check(want.length === have.length && want.every((x, i) => x === have[i]), 'FIRST_INSTALL_KIT_IMAGES_NOT_THE_KITS', { kit: want, given: have });
  const sumsName = `${tag}.first-install.SHA256SUMS`;
  const before = viewRelease(ghCommand, repo, tag);
  check(!before.assets.some(a => a.name === sumsName || a.name === path.basename(kit)), 'PUBLISH_FIRST_INSTALL_KIT_ALREADY_ATTACHED', tag);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-kit-'));
  try {
    const sumsFile = path.join(stage, sumsName);
    await fs.writeFile(sumsFile, sumsText([[path.basename(kit), sha(kitBytes)], ...given.map(g => [path.basename(g.file), sha(g.bytes)])]), { flag: 'wx' });
    const uploads = [{ file: kit, size: kitBytes.length }, ...given.map(g => ({ file: g.file, size: g.bytes.length })), { file: sumsFile, size: (await fs.stat(sumsFile)).size }];
    for (const u of uploads) {
      const up = gh(ghCommand, ['release', 'upload', tag, u.file, '--repo', repo]);
      check(up.status === 0, 'PUBLISH_GH_RELEASE_UPLOAD_FAILED', { asset: path.basename(u.file), stderr: up.stderr });
    }
    const v = viewRelease(ghCommand, repo, tag);
    for (const u of uploads) check(v.assets.some(x => x.name === path.basename(u.file) && x.size === u.size), 'PUBLISH_RELEASE_ASSET_MISSING', path.basename(u.file));
    return { status: 'FLEET_FIRST_INSTALL_KIT_ATTACHED', tag, url: v.url, version, kitSha256: sha(kitBytes), images: have, sums: sumsName };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { dir: { type: 'string' }, repo: { type: 'string' }, index: { type: 'string' },
    version: { type: 'string' }, acceptance: { type: 'string' }, kit: { type: 'string' }, image: { type: 'string', multiple: true } } });
  check(positionals.length === 0, 'USAGE');
  const only = (...allowed) => check(Object.keys(values).every(k => allowed.includes(k)), 'USAGE');
  if (sub === 'release') {
    only('dir', 'repo', 'index'); check(values.dir && values.repo, 'USAGE');
    return publish({ dir: values.dir, repo: values.repo, index: values.index });
  }
  if (sub === 'attach-acceptance') {
    only('version', 'acceptance', 'repo', 'index', 'dir'); check(values.version && values.acceptance, 'USAGE');
    return attachAcceptance({ version: values.version, acceptance: values.acceptance, repo: values.repo, index: values.index, dir: values.dir });
  }
  if (sub === 'attach-first-install-kit') {
    only('version', 'kit', 'image', 'repo'); check(values.version && values.kit, 'USAGE');
    return attachFirstInstallKit({ version: values.version, kit: values.kit, images: values.image ?? [], repo: values.repo });
  }
  return fail('USAGE');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r)), e => {
    console.log(JSON.stringify({ status: 'FLEET_RELEASE_REFUSED', code: e?.code ?? 'FLEET_RELEASE_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  });
}
