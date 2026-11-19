// Archive one universal node package on a GitHub Release (Decision b5d041d2 v2) and keep the 资料中心 index.
//
//   node rollout/fleet/publish.mjs release --dir <universal.mjs build out> --repo <owner/name> [--index <index file>]
//   node rollout/fleet/publish.mjs prepare --version <v> --dir <build out> --out <dir> [--image <role-image-<id>.tar.gz> ...] [--repo <owner/name>] [--index <index file>]
//   node rollout/fleet/publish.mjs seal --request <fleet-node-<v>.acceptance-request.json> --decision-record <the clued_record_mutate return, as saved>
//        [--drill-receipt <receipt.json>] [--repo <owner/name>] [--index <index file>]
//
// The acceptance has two halves, each one command that may be run again (Fable 3bc571a6 ruling section 3, Task 758989fa): prepare before the
// Owner accepts (what the Owner reviews), seal after (what the acceptance makes). Nothing else puts a kit or an acceptance on a Release: the
// steps (attachFirstInstallKit, attachAcceptance) have no command of their own, so no hand-written acceptance file has a way up.
//
// release: the build output is checked first (exactly one fleet-node-<v>.release.json, its tar with the sha256 it names, SHA256SUMS naming
//   both). The index must not name this version yet (an absent index is created with its header). Then
//   gh release create fleet-node-<v> <tar> <release.json> SHA256SUMS --repo <repo> --target <commit> ..., gh release view checks the
//   three assets by name and size, and only after that one row is appended: | version | Release URL | tar sha256 | commit | | | |.
//   Two more assets are the node entry of a first install (rollout/fleet/bootstrap.ps1 and prereq-manifest.json), taken from the
//   checked archive itself (never a working-tree copy: the bytes the Owner accepts) as fleet-node-<v>.bootstrap.ps1 and
//   fleet-node-<v>.prereq-manifest.json; the published SHA256SUMS is the build's two lines plus these two (written into a new temporary
//   directory; the build output is not changed). An archive without them is refused before gh is called.
// prepare (after release, before the Owner accepts; on a settled installed node that does not run this version yet, read-only there):
//   0. accepted is what the Release holds: a Release with fleet-node-<v>.acceptance.json is refused (PREPARE_VERSION_ALREADY_ACCEPTED: run the
//      same seal again to complete an empty index row), whatever the index says; a row filled while the Release holds none is refused too.
//   1. the first-install kit. The Release's, when it has one: once a kit is attached that copy is the one fact and nobody takes it from a node
//      again (a node gives new bytes on every read: template.versionFacts carries its observedAt). Else this node's (install.mjs
//      firstInstallKitOf). Either is held to what a new node reads (readKit), and the template's Source must not be this package's (the node
//      already runs this version: take the kit before upgrading it).
//   2. the request's fleetRefs, from this node's installed record (install.mjs installedFleetMaterial, read-only): the three that enter the
//      Source (sourceAcceptanceRef, hostQualificationRef, formalRoles) and the three every acceptance carries (ownerAuthorizationRef,
//      publisherQualificationRef, ownerPackageAcceptanceRef). Its Source comes from checkRequestOnRelease, the check seal makes: the Release's
//      own tar (SHA256SUMS and release.json naming it, its commit the request's) through the archive's source-hash, computed with the drill's
//      stand-in Decision and receipt (DRILL_RESERVED), which do not enter it (BATCH1-INTERFACES.md section 6).
//   3. every local role image the kit lists (--image, else the previous Release's same-id asset, held to that version's first-install.SHA256SUMS;
//      a failed download stays a download error).
//   4. --out (new or the one of an earlier run): the kit and the images in it; whatever of kit, images and fleet-node-<v>.first-install.SHA256SUMS
//      the Release lacks is uploaded (attachFirstInstallKit, resuming: what is there is kept only when it is the same bytes, another image or
//      sums file is replaced, another kit refused) and read back; the whole request is held to the Release once more (checkRequestOnRelease
//      with the kit), so prepare never writes a request seal would refuse; then fleet-node-<v>.acceptance-request.json (REQUEST_CONTRACT): tar,
//      commit, repository, Source, kit hash and those fleetRefs, and the line for the Decision's text (requestLineOf: the request file's sha256).
//      No Decision, receipt or time: the Owner reviews it. Files are written whole or not at all.
// seal (after the Owner accepted; never touches a node or takes a kit): the request and the Decision record, the return of the one
//   clued_record_mutate that wrote the Decision, kept as it was (readDecisionRecord: a committed write, one target, the receipt; a Decision
//   whose text carries this request's line). Decision, receipt and acceptedAt come from that file only and fill the five fields an
//   acceptance makes (cluedDecision = ownerDecisionRef, installationReceiptRef = ownerReceiptRef, acceptedAt); validateAcceptance; the index row;
//   checkRequestOnRelease; then attachAcceptance. Only after it succeeded are fleet-node-<v>.acceptance.json and fleet-node-<v>.decision-record.json
//   written next to the request (the record is never uploaded). The drill's stand-in values are refused. The record proves no Owner
//   acceptance (the release operator is the trust boundary): it keeps a Decision written for one candidate from sealing another.
//   --drill-receipt: a candidate drill's receipt (drill/drill-vm.ps1, DRILL_RECEIPT_CONTRACT): candidate true, its conclusion one of
//   DRILL_PASS_CONCLUSIONS, and tarSha256, ciSourceManifestSha256 and firstInstallKitSha256 those of this acceptance, else refused; the index
//   row names it, and a sealed row's drill cell is never replaced. Without it the row says 首装未演练 (the first-install drill is not a gate of
//   an in-place upgrade: FABLE-drill-3bc571a6 ruling section 1).
// attachFirstInstallKit (prepare's step): the kit (contract clued.independent-ci.fleet-node-first-install-kit/1) and the role images it lists as
//   local (images.local[].{id, asset}: each asset role-image-<64hex>.tar.gz, a gzip of the template node's docker save; exactly those, no more,
//   no fewer), uploaded one by one without --clobber, then fleet-node-<v>.first-install.SHA256SUMS over them (the release's SHA256SUMS was
//   published with the release and is never replaced). The index is not changed: the kit is not an acceptance.
// attachAcceptance (seal's step): the acceptance file (contract clued.independent-ci.fleet-node-acceptance/1) is checked against the index
//   row of that version (archive_sha256 and commit), its whole contract as install.mjs prepare reads it (validateAcceptance: repository =
//   --repo, ciSourceManifestSha256, fleetRefs); its file name must be fleet-node-<v>.acceptance.json; the drill's stand-in values are refused.
//   The Release must hold what it accepts: SHA256SUMS naming archive_sha256 for the tar, and the kit (the kit asset, first-install.SHA256SUMS
//   naming that same hash, every local role image the kit lists). It is uploaded as an extra asset (gh release upload, never --clobber: the
//   tar stays as it is) and the row's accepted-at, Decision and drill cells are filled. The same acceptance again (a run that stopped after
//   the upload, or one that finished) completes what is missing and changes nothing else; another acceptance of an accepted version is refused
//   before anything is uploaded.
// Credentials come only from gh's own login: GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN are removed from
// gh's environment, and nothing here reads, writes or prints a token.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import os from 'node:os';
import { RESIDENT } from './facts.mjs';
import { DEFAULT_ROOT, firstInstallKitOf, installedFleetMaterial, readKit, sourceHashOf, validateAcceptance } from './install.mjs';
import { readTar } from './tar.mjs';
import { RELEASE_CONTRACT, VERSION, tagOf } from './universal.mjs';

export const ACCEPTANCE_CONTRACT = 'clued.independent-ci.fleet-node-acceptance/1';
export const DEFAULT_REPO = 'tdoljyj/cross-memory-system';
export const DEFAULT_INDEX = 'G:\\我的云端硬盘\\Clued_资料中心\\10_E_工程与平台\\CI基础设施\\通用节点包_归档索引.md';
// the drill column (seal): the candidate drill's conclusion and receipt sha256, or 首装未演练; an older table is completed with an empty cell
export const INDEX_HEADER = ['版本', 'Release', 'tar sha256', 'commit', '接受时间', 'Decision', '首装演练'];
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
const HEX64 = /^[0-9a-f]{64}$/;

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
  return { status: r.status, stdout: String(r.stdout ?? ''), stdoutBytes: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? r.error ?? '').trim().slice(-300) };
}

// ---- the index: a markdown table of seven columns; its own line ending is kept; an older (five- or six-column) table is completed ----
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
  await writeAtomic(index, Buffer.from(lines.join(eol) + eol));
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
  const line = row([s.version, v.url, s.archive_sha256, s.commit, '', '', '']);
  await writeIndex(index, [...idx.lines, line], idx.eol);
  return { status: 'FLEET_RELEASE_PUBLISHED', tag: s.release_tag, url: v.url, archiveSha256: s.archive_sha256, commit: s.commit, indexLine: line };
}

// The drill's stand-in acceptance (Fable 3bc571a6 ruling section 2.3): a candidate drill installs a package before the Owner has accepted it,
// from an acceptance file whose Decision and receipt are these two ids. They are defined here only (the drill imports them, so does prepare
// for the Source, which they do not change); every acceptance on its way to a Release is refused when it names either (attachAcceptance), so
// such a file never reaches a Release and no real node (which reads the Release, or the operator's own --from) can read one. acceptedAt is a
// stand-in time, not reserved. Shapes a node accepts: UUIDs, not 00000000- (validateAcceptance) nor dddddddd-/eeeeeeee- (generate.py).
export const DRILL_RESERVED = Object.freeze({ decision: 'ca7d1da7-d2e1-4c1d-8000-000000000001', receipt: 'ca7d1da7-d2e1-4c1d-8000-000000000002', acceptedAt: '2026-01-01T00:00:00Z' });
export const REQUEST_CONTRACT = 'clued.independent-ci.fleet-node-acceptance-request/1';
export const DRILL_RECEIPT_CONTRACT = 'clued.independent-ci.drill-receipt/1';
export const NOT_DRILLED = '首装未演练';
// a candidate drill's conclusions seal takes (FABLE-renew-key-algorithm-ruling-20261119.md section 4.3): defined here only; drill/drill-vm.ps1's
// conclusion function is held to the same three by PR-甲's test. PASS_A_REINSTALL_NOT_DRILLED: a candidate that skipped A8 (supplement
// "candidate skips A8"), written into the index as it is. PASS_A_PENDING_PRODUCTION_READBACK and every other value are refused.
export const DRILL_PASS_CONCLUSIONS = Object.freeze(['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN', 'PASS_A_REINSTALL_NOT_DRILLED']);
// the line prepare gives for the Decision's text, and seal finds in the Decision record: the request file's sha256 binds tar, commit, Source,
// kit and fleetRefs at once
export const requestLineOf = (version, requestSha256) => `acceptance-request ${tagOf(version)} sha256:${requestSha256}`;
// the request's fleetRefs: what a node carries into every acceptance; the other three (ownerDecisionRef, installationReceiptRef, ownerReceiptRef) are seal's
export const REQUEST_FLEET_REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ownerPackageAcceptanceRef', 'formalRoles']);
const REQUEST_KEYS = ['contract', 'version', 'archive_sha256', 'commit', 'repository', 'ciSourceManifestSha256', 'firstInstallKitSha256', 'fleetRefs'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const exactKeys = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

// The acceptance a request becomes: its fields and the five the acceptance makes (seal with the Owner's Decision; the drill with DRILL_RESERVED).
export function acceptanceOf(request, { decision, receipt, acceptedAt }) {
  const f = request.fleetRefs;
  const a = { contract: ACCEPTANCE_CONTRACT, version: request.version, archive_sha256: request.archive_sha256, commit: request.commit, repository: request.repository,
    ciSourceManifestSha256: request.ciSourceManifestSha256, cluedDecision: decision, acceptedAt,
    fleetRefs: { sourceAcceptanceRef: f.sourceAcceptanceRef, hostQualificationRef: f.hostQualificationRef, ownerAuthorizationRef: f.ownerAuthorizationRef,
      publisherQualificationRef: f.publisherQualificationRef, ownerPackageAcceptanceRef: f.ownerPackageAcceptanceRef, installationReceiptRef: receipt,
      ownerDecisionRef: decision, ownerReceiptRef: receipt, formalRoles: f.formalRoles },
    firstInstallKitSha256: request.firstInstallKitSha256 };
  if (request.ciSourceManifestSha256 === undefined) delete a.ciSourceManifestSha256;
  return a;
}

export function readRequest(r) {
  check(exactKeys(r, REQUEST_KEYS) && r.contract === REQUEST_CONTRACT, 'REQUEST_REFUSED', 'shape');
  check(VERSION.test(r.version ?? '') && HEX64.test(r.archive_sha256 ?? '') && /^[0-9a-f]{40}$/.test(r.commit ?? '') && REPO.test(r.repository ?? '')
    && HEX64.test(r.ciSourceManifestSha256 ?? '') && HEX64.test(r.firstInstallKitSha256 ?? ''), 'REQUEST_REFUSED', 'hashes');
  check(exactKeys(r.fleetRefs, [...REQUEST_FLEET_REFS]) && REQUEST_FLEET_REFS.every(k => k === 'formalRoles' || UUID.test(r.fleetRefs[k] ?? '')), 'REQUEST_REFUSED', 'fleetRefs');
  return r;
}

// Whether an acceptance names the drill's stand-in Decision or receipt (an 8-hex cluedDecision by its prefix).
export const namesDrillReserved = a => {
  const f = a?.fleetRefs && typeof a.fleetRefs === 'object' ? a.fleetRefs : {};
  return [a?.cluedDecision, ...Object.values(f)].some(v => typeof v === 'string'
    && (v === DRILL_RESERVED.decision || v === DRILL_RESERVED.receipt || (/^[0-9a-f]{8}$/.test(v) && DRILL_RESERVED.decision.startsWith(v))));
};

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
  check(HEX64.test(a.firstInstallKitSha256 ?? ''), 'ACCEPTANCE_HAS_NO_FIRST_INSTALL_KIT');
  // a candidate drill's stand-in acceptance never reaches a Release (DRILL_RESERVED)
  check(!namesDrillReserved(a), 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN', { decision: a.cluedDecision });
  // the whole contract as every node's install.mjs prepare reads it (repository, ciSourceManifestSha256 from install.mjs source-hash, fleetRefs)
  try { validateAcceptance(a); } catch (e) { fail('ACCEPTANCE_REFUSED', e?.detail ?? e?.code ?? String(e)); }
  return a;
}

// seal's step (see the head of this file). `drill`: the index row's drill cell.
export async function attachAcceptance({ version, acceptance, repo = DEFAULT_REPO, index = DEFAULT_INDEX, dir = null, drill = NOT_DRILLED, ghCommand = ['gh'] }) {
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  check(VERSION.test(version ?? ''), 'PUBLISH_VERSION_REFUSED');
  const a = await readAcceptance(acceptance, version);
  check(a.repository === repo, 'ACCEPTANCE_NOT_THIS_REPOSITORY', a.repository);
  check(typeof drill === 'string' && drill !== '' && !/[|\r\n]/.test(drill), 'PUBLISH_DRILL_CELL_REFUSED');
  const idx = await readIndex(index);
  const at = findRow(idx.lines, version);
  check(at >= 0, 'PUBLISH_INDEX_LACKS_VERSION', version);
  const c = cells(idx.lines[at]);
  // the same acceptance again completes what a stopped run left; another one of an accepted version is refused
  const again = c[4] === a.acceptedAt && c[5] === a.cluedDecision;
  check((c[4] === '' && c[5] === '') || again, 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED', { acceptedAt: c[4], decision: c[5] });
  // the drill cell of a sealed row is never replaced (ruling 4.1): the same acceptance with other drill evidence, or none, is refused
  check(!again || c[6] === drill, 'SEAL_DRILL_RECEIPT_NOT_THE_RECORDED', { recorded: c[6], given: drill });
  check(a.archive_sha256 === c[2] && a.commit === c[3], 'ACCEPTANCE_NOT_THIS_RELEASE');
  if (dir) {
    const { release } = await readBuild(dir);
    check(release.source.version === version && release.source.archive_sha256 === a.archive_sha256 && release.source.commit === a.commit, 'ACCEPTANCE_NOT_THIS_RELEASE');
  }
  const tag = tagOf(version), name = path.basename(acceptance);
  const bytes = await fs.readFile(acceptance);
  const names = await checkKitOnRelease({ ghCommand, repo, tag, kitSha256: a.firstInstallKitSha256, archiveSha256: a.archive_sha256 });
  if (names.has(name)) {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-acceptance-'));
    try {
      const there = await fs.readFile(downloadAsset(ghCommand, repo, tag, name, stage));
      check(there.equals(bytes), 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED_DIFFERENT', { release: sha(there), this: sha(bytes) });
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  } else {
    check(!again, 'PUBLISH_ACCEPTANCE_INDEX_WITHOUT_ASSET', { version });   // a row filled by hand, the asset never uploaded: not this command's to guess
    const up = gh(ghCommand, ['release', 'upload', tag, acceptance, '--repo', repo]);
    check(up.status === 0, 'PUBLISH_GH_RELEASE_UPLOAD_FAILED', up.stderr);
  }
  const v = viewRelease(ghCommand, repo, tag);
  check(v.assets.some(x => x.name === name && x.size === bytes.length), 'PUBLISH_RELEASE_ASSET_MISSING', name);
  if (!again) {
    c[4] = a.acceptedAt;
    c[5] = a.cluedDecision;
    c[6] = drill;
    idx.lines[at] = row(c);
    await writeIndex(index, idx.lines, idx.eol);
  }
  return { status: 'FLEET_ACCEPTANCE_ATTACHED', tag, url: v.url, version, acceptedAt: a.acceptedAt, cluedDecision: a.cluedDecision, drill: c[6], already: again, indexLine: idx.lines[at] };
}

// One release asset, downloaded (read-only) into a new directory of its own under `stage`; its path. gh refuses a file of that name already
// in --dir (2.97.0, without --clobber): every download gets an empty directory, so reading the same asset again (prepare before and after it
// attaches the kit, two images reused from one earlier Release) never lands on an earlier copy (review r2).
function downloadAsset(ghCommand, repo, tag, name, stage) {
  mkdirSync(stage, { recursive: true });
  const dir = mkdtempSync(path.join(stage, 'dl-'));
  const r = gh(ghCommand, ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir]);
  check(r.status === 0, 'PUBLISH_GH_RELEASE_DOWNLOAD_FAILED', { asset: name, stderr: r.stderr });
  return path.join(dir, name);
}
const sumsOf = text => new Map(text.split('\n').filter(Boolean).map(l => { const i = l.indexOf('  '); return [l.slice(i + 2), l.slice(0, i)]; }));
const localImagesOf = k => {
  const local = Array.isArray(k?.images?.local) ? k.images.local : null;
  check(k?.contract === KIT_CONTRACT && local && local.every(i => HEX64.test(i?.id ?? '') && i.asset === `role-image-${i.id}.tar.gz`), 'FIRST_INSTALL_KIT_IMAGES_REFUSED');
  return [...new Set(local.map(i => i.id))].sort();
};

// What an acceptance of this version needs on the Release: the kit asset and first-install.SHA256SUMS naming the accepted hash for it, every
// local role image the kit lists, both as an asset and in that sums file, and (archiveSha256) the release's SHA256SUMS naming the tar with
// that hash. Read-only; the read-back of prepare and the gate of attachAcceptance. The Release's asset names.
async function checkKitOnRelease({ ghCommand, repo, tag, kitSha256, archiveSha256 = null }) {
  const kitName = `${tag}.first-install-kit.json`, sumsName = `${tag}.first-install.SHA256SUMS`;
  const names = new Set(viewRelease(ghCommand, repo, tag).assets.map(x => x.name));
  check(names.has(kitName) && names.has(sumsName), 'ACCEPTANCE_KIT_NOT_ON_RELEASE', { missing: [kitName, sumsName].filter(n => !names.has(n)) });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-kitcheck-'));
  try {
    if (archiveSha256 !== null) {
      const tarName = `${tag}.tar`;
      const release = names.has('SHA256SUMS') ? sumsOf((await fs.readFile(downloadAsset(ghCommand, repo, tag, 'SHA256SUMS', stage))).toString('utf8')).get(tarName) : null;
      check(names.has(tarName) && release === archiveSha256, 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', { accepted: archiveSha256, release: release ?? null });
    }
    const sums = sumsOf((await fs.readFile(downloadAsset(ghCommand, repo, tag, sumsName, stage))).toString('utf8'));
    const kitBytes = await fs.readFile(downloadAsset(ghCommand, repo, tag, kitName, stage));
    check(sums.get(kitName) === kitSha256 && sha(kitBytes) === kitSha256, 'ACCEPTANCE_KIT_NOT_THE_ATTACHED', { accepted: kitSha256, sums: sums.get(kitName) ?? null, kit: sha(kitBytes) });
    let k;
    try { k = JSON.parse(kitBytes.toString('utf8')); } catch { fail('FIRST_INSTALL_KIT_NOT_JSON'); }
    const missing = localImagesOf(k).map(id => `role-image-${id}.tar.gz`).filter(n => !names.has(n) || !sums.has(n));
    check(missing.length === 0, 'ACCEPTANCE_KIT_IMAGE_NOT_ON_RELEASE', { missing });
    return names;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// prepare's step (see the head of this file). resume: the same kit may already be there from an upload that stopped half way; what is there
// is kept only when it is the same bytes (downloaded and compared, never by its size), another image or sums file is replaced, another kit
// refused, and only what is missing is uploaded, the sums file last; the sums file is read back whole.
export async function attachFirstInstallKit({ version, kit, images = [], repo = DEFAULT_REPO, ghCommand = ['gh'], resume = false }) {
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
  const present = new Set(before.assets.map(a => a.name));
  check(resume || !(present.has(sumsName) || present.has(path.basename(kit))), 'PUBLISH_FIRST_INSTALL_KIT_ALREADY_ATTACHED', tag);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-kit-'));
  try {
    const sumsFile = path.join(stage, sumsName);
    const sumsBytes = Buffer.from(sumsText([[path.basename(kit), sha(kitBytes)], ...given.map(g => [path.basename(g.file), sha(g.bytes)])]));
    await fs.writeFile(sumsFile, sumsBytes, { flag: 'wx' });
    const uploads = [{ file: kit, bytes: kitBytes }, ...given.map(g => ({ file: g.file, bytes: g.bytes })), { file: sumsFile, bytes: sumsBytes }];
    for (const u of uploads) {
      const name = path.basename(u.file);
      if (resume && present.has(name)) {
        // what is there is kept only when it is these bytes (review: never by its size); a kit that is not this one is never replaced or completed
        const there = await fs.readFile(downloadAsset(ghCommand, repo, tag, name, path.join(stage, 'there')));
        if (there.equals(u.bytes)) continue;
        check(name !== path.basename(kit), 'PUBLISH_FIRST_INSTALL_KIT_ALREADY_ATTACHED_DIFFERENT', tag);
        const del = gh(ghCommand, ['release', 'delete-asset', tag, name, '--repo', repo, '--yes']);   // an image or sums file of an upload that stopped
        check(del.status === 0, 'PUBLISH_GH_RELEASE_DELETE_ASSET_FAILED', { asset: name, stderr: del.stderr });
      }
      const up = gh(ghCommand, ['release', 'upload', tag, u.file, '--repo', repo]);
      check(up.status === 0, 'PUBLISH_GH_RELEASE_UPLOAD_FAILED', { asset: path.basename(u.file), stderr: up.stderr });
    }
    const v = viewRelease(ghCommand, repo, tag);
    for (const u of uploads) check(v.assets.some(x => x.name === path.basename(u.file) && x.size === u.bytes.length), 'PUBLISH_RELEASE_ASSET_MISSING', path.basename(u.file));
    // the sums file read back is the one written here: every image and the kit by the hash of the bytes given
    const back = await fs.readFile(downloadAsset(ghCommand, repo, tag, sumsName, path.join(stage, 'back')));
    check(back.equals(sumsBytes), 'PUBLISH_FIRST_INSTALL_SUMS_NOT_AS_UPLOADED', { release: sha(back), this: sha(sumsBytes) });
    return { status: 'FLEET_FIRST_INSTALL_KIT_ATTACHED', tag, url: v.url, version, kitSha256: sha(kitBytes), images: have, sums: sumsName };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// The previous Release's role image of this id, if it has one: its asset, held to that version's first-install.SHA256SUMS. null only when there
// is none to use (no earlier version in the index, that Release lists no such asset or no sums file); a failed view or download stays what it is
// (review: a dropped connection is not a missing image).
async function previousImage({ ghCommand, repo, index, version, id, stage }) {
  const idx = await readIndex(index);
  const at = findRow(idx.lines, version);
  const before = idx.lines.slice(0, at < 0 ? 0 : at).filter(l => isRow(l) && VERSION.test(cells(l)[0] ?? ''));
  if (before.length === 0) return null;
  const prev = tagOf(cells(before[before.length - 1])[0]), asset = `role-image-${id}.tar.gz`, sumsName = `${prev}.first-install.SHA256SUMS`;
  const names = new Set(viewRelease(ghCommand, repo, prev).assets.map(x => x.name));
  if (!names.has(asset) || !names.has(sumsName)) return null;
  const want = sumsOf((await fs.readFile(downloadAsset(ghCommand, repo, prev, sumsName, stage))).toString('utf8')).get(asset);
  const file = downloadAsset(ghCommand, repo, prev, asset, stage);
  check(want !== undefined && sha(await fs.readFile(file)) === want, 'PREPARE_PREVIOUS_IMAGE_NOT_ITS_SUMS', { asset, from: prev });
  return file;
}

// The one check of a request against its Release as it is now (blocking 2), the same for prepare (before it writes a request) and seal (before
// anything goes up): the release's SHA256SUMS names the request's tar and release.json, release.json names its version, commit and tar, the
// tar downloaded from the Release has that hash, and the Source the archive's own source-hash gives on it (with the drill's stand-ins, which do
// not enter it) is the request's; with `kit`, the kit as checkKitOnRelease holds it. `stage` keeps the downloaded tar for a second call.
// The Source it computed.
async function checkRequestOnRelease({ ghCommand, repo, request, stage, kit = true, deps = {}, now = Date.now() }) {
  const tag = tagOf(request.version), tarName = `${tag}.tar`, relName = `${tag}.release.json`;
  const names = new Set(viewRelease(ghCommand, repo, tag).assets.map(x => x.name));
  check(names.has('SHA256SUMS') && names.has(tarName) && names.has(relName), 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', { missing: ['SHA256SUMS', tarName, relName].filter(n => !names.has(n)) });
  const dl = path.join(stage, 'release');
  await fs.mkdir(dl, { recursive: true });
  const sums = sumsOf((await fs.readFile(downloadAsset(ghCommand, repo, tag, 'SHA256SUMS', dl))).toString('utf8'));
  check(sums.get(tarName) === request.archive_sha256, 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', { request: request.archive_sha256, release: sums.get(tarName) ?? null });
  const relBytes = await fs.readFile(downloadAsset(ghCommand, repo, tag, relName, dl));
  let rel = null;
  try { rel = JSON.parse(relBytes.toString('utf8')); } catch { rel = null; }
  const s = rel?.source;
  check(sums.get(relName) === sha(relBytes) && rel?.contract === RELEASE_CONTRACT && s?.version === request.version && s?.commit === request.commit
    && s?.archive_sha256 === request.archive_sha256, 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS',
    { request: { version: request.version, commit: request.commit, archive_sha256: request.archive_sha256 }, release: s ? { version: s.version, commit: s.commit, archive_sha256: s.archive_sha256 } : null });
  const tarFile = path.join(stage, tarName);
  let have = null;
  try { have = sha(await fs.readFile(tarFile)); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (have !== request.archive_sha256) {
    await fs.rm(tarFile, { force: true });
    await fs.rename(downloadAsset(ghCommand, repo, tag, tarName, dl), tarFile);
    check(sha(await fs.readFile(tarFile)) === request.archive_sha256, 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', { downloaded: 'another tar' });
  }
  const { ciSourceManifestSha256: _ignored, ...draft } = request;
  const sh = await (deps.sourceHash ?? sourceHashOf)({ artifactPath: tarFile, artifactSha256: request.archive_sha256, acceptance: acceptanceOf(draft, DRILL_RESERVED), now });
  check(HEX64.test(sh?.ciSourceManifestSha256 ?? ''), 'ACCEPTANCE_SOURCE_HASH_REFUSED');
  check(request.ciSourceManifestSha256 === undefined || request.ciSourceManifestSha256 === sh.ciSourceManifestSha256, 'ACCEPTANCE_SOURCE_NOT_THE_RELEASES',
    { request: request.ciSourceManifestSha256, release: sh.ciSourceManifestSha256 });
  if (kit) await checkKitOnRelease({ ghCommand, repo, tag, kitSha256: request.firstInstallKitSha256 });
  return sh.ciSourceManifestSha256;
}

// Written whole or not at all: a new file next to the target, then renamed over it (review: the index and the JSON files).
async function writeAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmp, bytes, { flag: 'wx' });
  try { await fs.rename(tmp, file); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
}

// The first half of an acceptance (see the head of this file). `deps` is for tests only (the kit and the record material of a fixture node, a
// stand-in for the archive's source-hash); the command line cannot reach it.
export async function prepare({ version, dir, out, images = [], repo = DEFAULT_REPO, index = DEFAULT_INDEX, root = DEFAULT_ROOT, ghCommand = ['gh'],
  now = Date.now(), deps = {} }) {
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  check(VERSION.test(version ?? ''), 'PUBLISH_VERSION_REFUSED');
  const { release } = await readBuild(dir);
  const s = release.source;
  check(s.version === version, 'PREPARE_BUILD_NOT_THIS_VERSION', s.version);
  const tag = tagOf(version), kitName = `${tag}.first-install-kit.json`;
  const idx = await readIndex(index);
  const at = findRow(idx.lines, version);
  check(at >= 0, 'PUBLISH_INDEX_LACKS_VERSION', version);
  const c = cells(idx.lines[at]);
  check(c[2] === s.archive_sha256 && c[3] === s.commit, 'ACCEPTANCE_NOT_THIS_RELEASE');
  // accepted is what the Release holds (blocking 5): an accepted version is never given a kit or a request afterwards
  const onRelease = new Set(viewRelease(ghCommand, repo, tag).assets.map(x => x.name));
  check(!onRelease.has(`${tag}.acceptance.json`), 'PREPARE_VERSION_ALREADY_ACCEPTED',
    { version, note: 'the Release holds its acceptance; if the index row is empty, run the same seal again to complete it' });
  check(c[4] === '' && c[5] === '', 'PUBLISH_ACCEPTANCE_INDEX_WITHOUT_ASSET', { version, acceptedAt: c[4], decision: c[5] });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-prepare-'));
  try {
    // 1. the kit: the Release's once it has one (the one fact from then on), else this node's; held to what a new node will read
    const kitFromRelease = onRelease.has(kitName);
    const kitBytes = kitFromRelease ? await fs.readFile(downloadAsset(ghCommand, repo, tag, kitName, stage))
      : Buffer.from(JSON.stringify(await (deps.kitOf ?? firstInstallKitOf)({ root })) + '\n');
    (deps.readKit ?? readKit)(kitBytes);
    let kit;
    try { kit = JSON.parse(kitBytes.toString('utf8')); } catch { fail('FIRST_INSTALL_KIT_NOT_JSON'); }
    // 2. the request: what this node carries into every acceptance; its Source from the Release's own tar (the check seal makes)
    const m = await (deps.fleetMaterial ?? installedFleetMaterial)(root);
    const fleetRefs = Object.fromEntries(REQUEST_FLEET_REFS.map(k => [k, k === 'formalRoles' ? m?.formalRoles : m?.installed?.[k]]));
    const request = { contract: REQUEST_CONTRACT, version, archive_sha256: s.archive_sha256, commit: s.commit, repository: repo, ciSourceManifestSha256: undefined,
      firstInstallKitSha256: sha(kitBytes), fleetRefs };
    const source = await checkRequestOnRelease({ ghCommand, repo, request, stage, kit: false, deps, now });
    check(kit.config?.ciSourceManifestSha256 !== source, 'PREPARE_TEMPLATE_IS_THIS_SOURCE',
      { template: kit.config?.ciSourceManifestSha256, note: 'this node already runs this version: the kit must be taken before it upgrades' });
    request.ciSourceManifestSha256 = source;
    readRequest(request);
    // the request becomes an acceptance every node reads (the five fields seal fills aside)
    try { validateAcceptance(acceptanceOf(request, DRILL_RESERVED), now); } catch (e) { fail('PREPARE_REQUEST_REFUSED', e?.detail ?? e?.code ?? String(e)); }
    // 3. every local role image: given, else the previous Release's
    const given = new Map();
    for (const f of images) { const mm = ROLE_IMAGE.exec(path.basename(f)); check(mm, 'FIRST_INSTALL_IMAGE_FILE_NAME_REFUSED', path.basename(f)); given.set(mm[1], f); }
    const ids = localImagesOf(kit);
    check([...given.keys()].every(id => ids.includes(id)), 'FIRST_INSTALL_KIT_IMAGES_NOT_THE_KITS', { kit: ids, given: [...given.keys()] });
    const files = new Map();
    const prevStage = path.join(stage, 'previous');
    await fs.mkdir(prevStage);
    for (const id of ids) {
      const f = given.get(id) ?? await previousImage({ ghCommand, repo, index, version, id, stage: prevStage });
      check(f, 'PREPARE_IMAGE_MISSING', { id, asset: `role-image-${id}.tar.gz`, note: 'give it with --image; the previous Release has none of that id' });
      files.set(id, f);
    }
    // 4. all checks passed: the directory, the kit and the images in it, what the Release lacks uploaded, the whole request held to the Release
    //    again (the same check as seal's), and only then the request
    await fs.mkdir(out, { recursive: true });
    const kitFile = path.join(out, kitName);
    await writeAtomic(kitFile, kitBytes);
    const placed = [];
    for (const [id, f] of files) { const to = path.join(out, `role-image-${id}.tar.gz`); if (path.resolve(f) !== path.resolve(to)) await fs.copyFile(f, to); placed.push(to); }
    const attached = await attachFirstInstallKit({ version, kit: kitFile, images: placed, repo, ghCommand, resume: true });
    await checkRequestOnRelease({ ghCommand, repo, request, stage, kit: true, deps, now });
    const requestFile = path.join(out, `${tag}.acceptance-request.json`);
    const requestBytes = Buffer.from(JSON.stringify(request, null, 2) + '\n');
    await writeAtomic(requestFile, requestBytes);
    return { status: 'FLEET_ACCEPTANCE_REQUEST_WRITTEN', version, request: requestFile, directory: out, kitFrom: kitFromRelease ? 'release' : 'node',
      firstInstallKitSha256: request.firstInstallKitSha256, ciSourceManifestSha256: request.ciSourceManifestSha256, images: attached.images,
      requestSha256: sha(requestBytes), decisionLine: requestLineOf(version, sha(requestBytes)) };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// A candidate drill's receipt for this acceptance (blocking 4): one of DRILL_PASS_CONCLUSIONS, candidate true, and the three hashes of this
// acceptance; the index row's drill cell (its conclusion and the receipt's sha256), or refused.
async function drillCellOf(file, a) {
  let bytes, r;
  try { bytes = await fs.readFile(file); r = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('SEAL_DRILL_RECEIPT_REFUSED', 'not a JSON file'); }
  check(r?.contract === DRILL_RECEIPT_CONTRACT && r.version === a.version, 'SEAL_DRILL_RECEIPT_REFUSED', { contract: r?.contract ?? null, version: r?.version ?? null });
  check(DRILL_PASS_CONCLUSIONS.includes(r.conclusion), 'SEAL_DRILL_RECEIPT_NOT_PASS', { conclusion: r.conclusion ?? null, pass: DRILL_PASS_CONCLUSIONS });
  check(r.candidate === true, 'SEAL_DRILL_RECEIPT_NOT_A_CANDIDATE', { candidate: r.candidate ?? null });
  const mine = { tarSha256: a.archive_sha256, ciSourceManifestSha256: a.ciSourceManifestSha256, firstInstallKitSha256: a.firstInstallKitSha256 };
  const theirs = Object.fromEntries(Object.keys(mine).map(k => [k, r[k] ?? null]));
  check(Object.keys(mine).every(k => theirs[k] === mine[k]), 'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE', { receipt: theirs, acceptance: mine });
  return `${r.conclusion} receipt ${sha(bytes)}`;
}

// The Decision record (blocking 1, the ruling's supplement): the return of the one clued_record_mutate that wrote the Decision, kept as it was.
// The only source of the Decision id (target_refs[0].id), the receipt id (receipt_id) and the time (supplemental.record.created_at, to the
// second, UTC), so no two unrelated ids can be paired; its text must carry prepare's line for this very request. It proves no Owner acceptance
// (the release operator is the trust boundary, ruling section 4.2): it keeps the Decision written for one candidate from sealing another.
// content_hash is not checked: on the real 3bc571a6 return it is not the SHA-256 of content, and its algorithm is not known.
export async function readDecisionRecord(file, line, now = Date.now()) {
  let bytes, d;
  try { bytes = await fs.readFile(file); d = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('DECISION_RECORD_REFUSED', 'not a JSON file'); }
  check(d !== null && typeof d === 'object' && !Array.isArray(d) && d.status === 'committed' && (d.error_code ?? null) === null, 'DECISION_RECORD_REFUSED', 'not a committed write');
  const t = Array.isArray(d.target_refs) && d.target_refs.length === 1 ? d.target_refs[0] : null;
  check(UUID.test(t?.id ?? '') && UUID.test(d.receipt_id ?? '') && t.id !== d.receipt_id, 'DECISION_RECORD_REFUSED', 'receipt_id and exactly one target, two different UUIDs');
  const decision = t.id, receipt = d.receipt_id, rec = d.supplemental?.record;
  check(rec !== null && typeof rec === 'object' && !Array.isArray(rec) && rec.record_type === 'decision', 'DECISION_RECORD_NOT_A_DECISION', { record_type: rec?.record_type ?? null });
  check((rec.id === undefined || rec.id === decision) && rec.receipt_id === receipt, 'DECISION_RECORD_NOT_ITS_TARGET',
    { target: decision, record: rec.id ?? null, receipt, recordReceipt: rec.receipt_id ?? null });
  const at = typeof rec.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(rec.created_at) ? Date.parse(rec.created_at) : NaN;
  check(Number.isFinite(at) && at <= now, 'DECISION_RECORD_REFUSED', { created_at: rec.created_at ?? null });
  check(typeof rec.content === 'string' && rec.content.split(/\r?\n/).some(l => l.trim() === line), 'DECISION_RECORD_NOT_THIS_REQUEST', { line });
  return { decision, receipt, acceptedAt: new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z'), bytes };
}

// The second half of an acceptance (see the head of this file). `deps` is for tests only (a stand-in for the archive's source-hash).
export async function seal({ request, decisionRecord, drillReceipt = null, repo = DEFAULT_REPO, index = DEFAULT_INDEX, ghCommand = ['gh'], now = Date.now(), deps = {} }) {
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  let requestBytes, r;
  try { requestBytes = await fs.readFile(request); r = JSON.parse(requestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('REQUEST_REFUSED', 'not a JSON file'); }
  readRequest(r);
  const tag = tagOf(r.version);
  check(path.basename(request) === `${tag}.acceptance-request.json`, 'REQUEST_FILE_NAME_REFUSED', path.basename(request));
  check(r.repository === repo, 'ACCEPTANCE_NOT_THIS_REPOSITORY', r.repository);
  const rec = await readDecisionRecord(decisionRecord, requestLineOf(r.version, sha(requestBytes)), now);
  const a = acceptanceOf(r, rec);
  check(!namesDrillReserved(a), 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN', { decision: rec.decision });
  try { validateAcceptance(a, now); } catch (e) { fail('ACCEPTANCE_REFUSED', e?.detail ?? e?.code ?? String(e)); }
  const drill = drillReceipt === null ? NOT_DRILLED : await drillCellOf(drillReceipt, a);
  const bytes = Buffer.from(JSON.stringify(a, null, 2) + '\n');
  const final = path.join(path.dirname(request), `${tag}.acceptance.json`), recordCopy = path.join(path.dirname(request), `${tag}.decision-record.json`);
  const readOrNull = async f => { try { return await fs.readFile(f); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
  const there = await readOrNull(final);
  check(there === null || there.equals(bytes), 'SEAL_ANOTHER_ACCEPTANCE_IN_DIRECTORY', final);
  // the index row before the Release (both read-only): another acceptance of this version, or a row that is not this request's tar and commit
  const idx = await readIndex(index);
  const at = findRow(idx.lines, r.version);
  check(at >= 0, 'PUBLISH_INDEX_LACKS_VERSION', r.version);
  const c = cells(idx.lines[at]);
  check((c[4] === '' && c[5] === '') || (c[4] === a.acceptedAt && c[5] === a.cluedDecision), 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED', { acceptedAt: c[4], decision: c[5] });
  check(a.archive_sha256 === c[2] && a.commit === c[3], 'ACCEPTANCE_NOT_THIS_RELEASE');
  const recordThere = await readOrNull(recordCopy);
  check(recordThere === null || recordThere.equals(rec.bytes), 'SEAL_ANOTHER_DECISION_RECORD_IN_DIRECTORY', recordCopy);
  // the file goes up from a directory of its own; it and the record are written next to the request only after the Release and the index hold it
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-seal-'));
  try {
    await checkRequestOnRelease({ ghCommand, repo, request: r, stage, kit: true, deps, now });
    const staged = path.join(stage, 'up', `${tag}.acceptance.json`);
    await fs.mkdir(path.dirname(staged));
    await fs.writeFile(staged, bytes, { flag: 'wx' });
    const attached = await attachAcceptance({ version: r.version, acceptance: staged, repo, index, drill, ghCommand });
    if (there === null) await writeAtomic(final, bytes);
    if (recordThere === null) await writeAtomic(recordCopy, rec.bytes);
    return { ...attached, status: 'FLEET_ACCEPTANCE_SEALED', acceptance: final, decisionRecord: recordCopy };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { dir: { type: 'string' }, repo: { type: 'string' }, index: { type: 'string' },
      version: { type: 'string' }, image: { type: 'string', multiple: true }, out: { type: 'string' }, request: { type: 'string' },
      'decision-record': { type: 'string' }, 'drill-receipt': { type: 'string' } } });
  } catch { fail('USAGE'); }   // an option no command has (the old entry's --base, --kit, --acceptance; seal's old --decision, --receipt, --accepted-at)
  const { values, positionals } = parsed;
  check(positionals.length === 0, 'USAGE');
  const only = (...allowed) => check(Object.keys(values).every(k => allowed.includes(k)), 'USAGE');
  if (sub === 'release') {
    only('dir', 'repo', 'index'); check(values.dir && values.repo, 'USAGE');
    return publish({ dir: values.dir, repo: values.repo, index: values.index });
  }
  if (sub === 'prepare') {
    only('version', 'dir', 'out', 'image', 'repo', 'index'); check(values.version && values.dir && values.out, 'USAGE');
    return prepare({ version: values.version, dir: values.dir, out: path.resolve(values.out), images: values.image ?? [], repo: values.repo, index: values.index });
  }
  if (sub === 'seal') {
    only('request', 'decision-record', 'drill-receipt', 'repo', 'index');
    check(values.request && values['decision-record'], 'USAGE');
    return seal({ request: path.resolve(values.request), decisionRecord: path.resolve(values['decision-record']),
      drillReceipt: values['drill-receipt'] ? path.resolve(values['drill-receipt']) : null, repo: values.repo, index: values.index });
  }
  return fail('USAGE');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r)), e => {
    console.log(JSON.stringify({ status: 'FLEET_RELEASE_REFUSED', code: e?.code ?? 'FLEET_RELEASE_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  });
}
