// Archive one universal node package on a GitHub Release (Decision b5d041d2 v2) and keep the 资料中心 index.
//
//   node rollout/fleet/publish.mjs prepare --version <v> --dir <build out> --out <dir> [--image <role-image-<id>.tar.gz> ...] [--repo <owner/name>] [--index <index file>]
//   node rollout/fleet/publish.mjs seal --request <fleet-node-<v>.acceptance-request.json> [--drill-receipt <receipt.json>] [--wait <minutes>]
//        [--repo <owner/name>] [--index <index file>]
//
// The acceptance has two halves, each one command that may be run again (Fable 3bc571a6 ruling section 3, Task 758989fa): prepare before the
// Owner accepts (what the Owner reviews), seal after (it asks for the Owner's acceptance and makes what it makes). Nothing else puts a package, a kit or an acceptance on a
// Release: the steps (ensureRelease, attachFirstInstallKit, attachAcceptance) have no command of their own, so no hand-written acceptance file
// has a way up, and there is no separate release step to forget (FABLE-drill-release-step-20261121.md: the release command is gone, any form of
// it is USAGE; prepare makes the Release and the index row it needs).
//
// prepare (before the Owner accepts; on a settled installed node that does not run this version yet, read-only there). Everything it can check
// locally or read is checked first; only then (step 4) is anything written outside:
//   0. the build output (exactly one fleet-node-<v>.release.json, its tar with the sha256 it names, SHA256SUMS naming both) and the node entry of
//      a first install staged from it (rollout/fleet/bootstrap.ps1 and prereq-manifest.json, taken from the checked archive itself, never a
//      working-tree copy: the bytes the Owner accepts, as fleet-node-<v>.bootstrap.ps1 and fleet-node-<v>.prereq-manifest.json, and the
//      SHA256SUMS to publish: the build's two lines plus these two, in a new temporary directory; the build output is not changed). An archive
//      without them is refused before gh is called. An index row of this version, when there is one, must name this tar and commit.
//      Accepted is what the Release holds: a Release with fleet-node-<v>.acceptance.json is refused (PREPARE_VERSION_ALREADY_ACCEPTED: run the
//      same seal again to complete an empty index row), whatever the index says; a row filled while the Release holds none is refused too.
//      No Release yet is fine, unless the index has a row of this version: that is refused here (PREPARE_INDEX_ROW_WITHOUT_RELEASE, not
//      guessed), before a kit is taken or an image fetched.
//   1. the first-install kit. The Release's, when it has one: once a kit is attached that copy is the one fact and nobody takes it from a node
//      again (a node gives new bytes on every read: template.versionFacts carries its observedAt). Else this node's (install.mjs
//      firstInstallKitOf). Either is held to what a new node reads (readKit), and the template's Source must not be this package's (the node
//      already runs this version: take the kit before upgrading it).
//   2. the request's fleetRefs, from this node's installed record (install.mjs installedFleetMaterial, read-only): the three that enter the
//      Source (sourceAcceptanceRef, hostQualificationRef, formalRoles) and the three every acceptance carries (ownerAuthorizationRef,
//      publisherQualificationRef, ownerPackageAcceptanceRef). Its Source: the build's own tar (the bytes step 0 checked, the ones that go up)
//      through the archive's source-hash, computed with the drill's stand-in Decision and receipt (DRILL_RESERVED), which do not enter it
//      (BATCH1-INTERFACES.md section 6); the template's Source must not be it; the request must make an acceptance every node reads.
//   3. every local role image the kit lists (--image, else the previous Release's same-id asset, held to that version's first-install.SHA256SUMS;
//      the previous Release is the one of the last index row before this version's, every row when this version has none yet; a failed
//      download stays a download error).
//   4. ensureRelease: the Release and the index row of this build, as they are found.
//      - neither: the commit must be on GitHub (gh api repos/<repo>/commits/<commit>: GitHub's "no such commit" is PREPARE_COMMIT_NOT_ON_REMOTE,
//        any other failure PREPARE_COMMIT_LOOKUP_FAILED, to be run again; nothing written yet);
//        gh release create fleet-node-<v> <tar> <release.json> SHA256SUMS <bootstrap.ps1> <prereq-manifest.json> --repo <repo>
//        --target <commit> ..., gh release view checks the five assets by name and size, and only after that one row is appended:
//        | version | Release URL | tar sha256 | commit | | | | (an absent index is created with its header).
//      - the Release without the row (a run that stopped before the index was written), or a Release missing assets (one that stopped half
//        way): every asset there must be this build's byte for byte (the same size is not the same build): SHA256SUMS against the one
//        staged here, release.json and the node-entry files downloaded and compared, the tar downloaded to <stage>/<tar> and held to its
//        sha256 (step 5 reuses that file). Another build of this version is refused before anything goes up (ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES
//        when its SHA256SUMS names another tar or its tar is another, else ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS). What is missing
//        is uploaded (never --clobber), the five are read back by name and size, and the row is appended when it is not there.
//      - the row without its Release: refused (PREPARE_INDEX_ROW_WITHOUT_RELEASE), not guessed (step 0 already refuses it; held here again
//        on the index and the Release as they are now).
//      Only the tag fleet-node-<v> and this one row are ever written.
//   5. --out (new or the one of an earlier run): the kit and the images in it; whatever of kit, images and fleet-node-<v>.first-install.SHA256SUMS
//      the Release lacks is uploaded (attachFirstInstallKit, resuming: what is there is kept only when it is the same bytes, another image or
//      sums file is replaced, another kit refused) and read back; the whole request is held to the Release (checkRequestOnRelease with the kit,
//      the check seal makes: SHA256SUMS and release.json naming the request's tar and commit, the tar downloaded from the Release giving the
//      request's Source), so prepare never writes a request seal would refuse;
//   6. then fleet-node-<v>.acceptance-request.json (REQUEST_CONTRACT): tar,
//      commit, repository, Source, kit hash and those fleetRefs, and the request file's sha256 (the acceptance door's resource binds it).
//      No Decision, receipt or time: the Owner reviews it. It goes up as a Release asset first (never --clobber; the same bytes there are
//      kept, other bytes refused, never replaced: the release workflow's fleet-accept mode reads it from the Release, PLAN-accept-binding-
//      20261125 section 3), then into --out. Files are written whole or not at all.
// seal (never touches a node or takes a kit; PLAN-accept-auto-seal-20261125 2.2): the Owner's acceptance is one fleet.accept Grant the Owner
//   approves on the Clued confirm page, never a sentence in a chat and never a Decision written by hand (--decision-record is gone: USAGE).
//   First everything seal refuses on its own (the request and the acceptance it becomes, fleetRefs naming the drill's stand-in among it,
//   --drill-receipt, the index row, the commit on main, checkRequestOnRelease, the request asset on the Release), so the Owner is never asked
//   for what would be refused. Then the acceptance door (accept-door.mjs; PLAN-accept-binding-20261125: no token on this machine) is read
//   anonymously for this request (the resource fleet-node:<repo>/<v>/<tar sha256>/<request sha256>); none or expired there opens the
//   request with one run of the release workflow's fleet-accept mode, and from then on seal only reads: for its link up to OPEN_WAIT_MS
//   from that run (--wait does not lengthen it), with --wait <minutes> for the Owner's answer at 30 to 120 second steps; a read that fails
//   is read again at the next step while there is time (without --wait and before anything was opened it is refused). No link by then,
//   also with the door unreadable, is FLEET_ACCEPTANCE_NOT_OPENED, nothing written, exit code 1: seal again would only dispatch again, the
//   cause is in the workflow's run (PLAN-accept-align-open-20261125 2.2). pending is FLEET_ACCEPTANCE_WAITING_OWNER with the confirm link,
//   nothing written. rejected is the Owner's final answer (the door never opens a rejected request again; 1.2 there): whenever it is read,
//   FLEET_ACCEPTANCE_REJECTED, nothing dispatched or written, exit code 1; expired after this seal saw the request open is the same answer
//   with answer expired; accepted gives the three values an acceptance makes, from the door's
//   answer only, an answer that names this request (cluedDecision =
//   ownerDecisionRef = the Grant id, installationReceiptRef = ownerReceiptRef = the use receipt id, acceptedAt = its time to the second);
//   an accepted_at up to CLOCK_SKEW_MAX_MS after this machine's clock (the door's clock is the server's) is waited out once, one further ahead
//   refused; validateAcceptance; the index row; attachAcceptance; only then fleet-node-<v>.acceptance.json is written next to the request.
//   The door replays its one row of a version, so the acceptance is a pure function of request and row and the same seal again changes
//   nothing. The drill's stand-in values are refused.
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
import { acceptResourceOf, openRequest, readAnswer, statusReader } from './accept-door.mjs';
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

// The Release of a tag, or null when GitHub has none (gh says "release not found"); any other failure stays a failure (a dropped connection
// is not a missing Release).
function viewReleaseOrNull(ghCommand, repo, tag) {
  const viewed = gh(ghCommand, ['release', 'view', tag, '--repo', repo, '--json', 'url,tagName,assets']);
  if (viewed.status !== 0 && /release not found/i.test(viewed.stderr)) return null;
  check(viewed.status === 0, 'PUBLISH_GH_RELEASE_VIEW_FAILED', viewed.stderr);
  const v = JSON.parse(viewed.stdout);
  check(v.tagName === tag && typeof v.url === 'string' && /^https:\/\//.test(v.url), 'PUBLISH_RELEASE_NOT_AS_CREATED', { tagName: v.tagName });
  return { url: v.url, assets: Array.isArray(v.assets) ? v.assets : [] };
}
function viewRelease(ghCommand, repo, tag) {
  const v = viewReleaseOrNull(ghCommand, repo, tag);
  check(v !== null, 'PUBLISH_GH_RELEASE_VIEW_FAILED', 'release not found');
  return v;
}

// The candidate's commit on GitHub (the Release's --target), asked before anything is written: a commit never pushed is refused here.
// Only GitHub's own "no such commit" (HTTP 404, or 422 "No commit found for SHA") is a commit not on the remote; any other failure (a
// dropped connection, a 5xx, an answer that is not the API's) is a lookup that failed, to be run again, not a sign the commit was never pushed.
function checkCommitOnRemote(ghCommand, repo, commit) {
  const r = gh(ghCommand, ['api', `repos/${repo}/commits/${commit}`]);
  if (r.status !== 0 && /\(HTTP 404\)|No commit found for SHA/i.test(r.stderr ?? '')) fail('PREPARE_COMMIT_NOT_ON_REMOTE', { commit, exit: r.status, stderr: r.stderr });
  let got = null;
  try { got = r.status === 0 ? JSON.parse(r.stdout).sha : null; } catch { got = null; }
  check(got === commit, 'PREPARE_COMMIT_LOOKUP_FAILED', { commit, exit: r.status, stderr: r.stderr, note: 'GitHub did not say whether the commit is there: run the same prepare again' });
}

// prepare's step 4 (see the head of this file): the Release and the index row of this build, made or completed, never guessed. `assets`: the
// five, in the order they are published (tar, release.json, the staged SHA256SUMS, the two node-entry files).
async function ensureRelease({ ghCommand, repo, index, s, assets, stage }) {
  const tag = s.release_tag, tarName = `${tag}.tar`, relName = `${tag}.release.json`;
  const idx = await readIndex(index);
  const at = findRow(idx.lines, s.version);
  const v = viewReleaseOrNull(ghCommand, repo, tag);
  if (v === null) {
    check(at < 0, 'PREPARE_INDEX_ROW_WITHOUT_RELEASE', { version: s.version, note: 'the index names this version, GitHub has no Release of it: not this command\'s to guess' });
    checkCommitOnRemote(ghCommand, repo, s.commit);
    return publishAssets({ ghCommand, repo, index, idx, s, assets });
  }
  // a Release of this version is there: this build's (complete or not), or another build's, refused before anything goes up. Every asset it
  // holds is held to this build byte for byte (the same size is not the same build: a tar is 512-byte aligned); the tar is downloaded to
  // <stage>/<tar>, where step 5's checkRequestOnRelease finds it already held and does not download it again.
  const sizes = new Map(v.assets.map(x => [x.name, x.size]));
  const local = new Map();
  for (const a of assets) local.set(a.name, await fs.readFile(a.file));
  const dl = path.join(stage, 'ensure');
  if (sizes.has('SHA256SUMS')) {
    const there = await fs.readFile(downloadAsset(ghCommand, repo, tag, 'SHA256SUMS', dl));
    if (!there.equals(local.get('SHA256SUMS'))) {
      const named = sumsOf(there.toString('utf8')).get(tarName) ?? null;
      check(named === s.archive_sha256, 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', { build: s.archive_sha256, release: named });
      fail('ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS', { note: 'the Release\'s SHA256SUMS is not this build\'s', release: sha(there), build: sha(local.get('SHA256SUMS')) });
    }
  }
  for (const [name, bytes] of local) {
    if (sizes.has(name) && sizes.get(name) !== bytes.length) {
      fail(name === tarName ? 'ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES' : 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS', { asset: name, release: sizes.get(name), build: bytes.length });
    }
  }
  // release.json and the node-entry files first (small), the tar last
  for (const a of [...assets.filter(x => x.name !== tarName), ...assets.filter(x => x.name === tarName)]) {
    if (!sizes.has(a.name) || a.name === 'SHA256SUMS') continue;
    if (a.name === tarName) {
      const tarFile = path.join(stage, tarName);
      await fs.rm(tarFile, { force: true });
      await fs.rename(downloadAsset(ghCommand, repo, tag, tarName, dl), tarFile);
      const got = sha(await fs.readFile(tarFile));
      if (got !== s.archive_sha256) {
        await fs.rm(tarFile, { force: true });
        fail('ACCEPTANCE_ARCHIVE_NOT_THE_RELEASES', { asset: tarName, release: got, build: s.archive_sha256 });
      }
    } else {
      const there = await fs.readFile(downloadAsset(ghCommand, repo, tag, a.name, dl));
      check(there.equals(local.get(a.name)), 'ACCEPTANCE_RELEASE_METADATA_NOT_THE_REQUESTS', { asset: a.name, release: sha(there), build: sha(local.get(a.name)) });
    }
  }
  const missing = assets.filter(a => !sizes.has(a.name));
  for (const a of missing) {
    const up = gh(ghCommand, ['release', 'upload', tag, a.file, '--repo', repo]);
    check(up.status === 0, 'PUBLISH_GH_RELEASE_UPLOAD_FAILED', { asset: a.name, stderr: up.stderr });
  }
  const back = missing.length ? viewRelease(ghCommand, repo, tag) : v;
  for (const a of assets) check(back.assets.some(x => x.name === a.name && x.size === local.get(a.name).length), 'PUBLISH_RELEASE_ASSET_MISSING', a.name);
  const line = at < 0 ? row([s.version, back.url, s.archive_sha256, s.commit, '', '', '']) : idx.lines[at];
  if (at < 0) await writeIndex(index, [...idx.lines, line], idx.eol);
  return { status: 'FLEET_RELEASE_PUBLISHED', tag, url: back.url, archiveSha256: s.archive_sha256, commit: s.commit, indexLine: line, uploaded: missing.map(a => a.name) };
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
// conclusion function is held to the same two by PR-甲's test. A8 has no skip (FABLE-drill-r13-a8-m5-20261125.md section 1.2), so the
// value a skipped one ended in is gone and refused like PASS_A_PENDING_PRODUCTION_READBACK and every other value.
export const DRILL_PASS_CONCLUSIONS = Object.freeze(['PASS_A_FULL', 'PASS_A_PER_NODE_STEPS_REMAIN']);
// the request's fleetRefs: what a node carries into every acceptance; the other three (ownerDecisionRef, installationReceiptRef, ownerReceiptRef) are seal's
export const REQUEST_FLEET_REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ownerPackageAcceptanceRef', 'formalRoles']);
const REQUEST_KEYS = ['contract', 'version', 'archive_sha256', 'commit', 'repository', 'ciSourceManifestSha256', 'firstInstallKitSha256', 'fleetRefs'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const exactKeys = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

// The acceptance a request becomes: its fields and the five the acceptance makes (seal with the door's fleet.accept Grant, receipt and time; the drill with DRILL_RESERVED).
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
// (review: a dropped connection is not a missing image). The previous version is the last row before this version's; before prepare has
// appended this version's row (step 4 comes after this one), every row is before it.
async function previousImage({ ghCommand, repo, index, version, id, stage }) {
  const idx = await readIndex(index);
  const at = findRow(idx.lines, version);
  const before = idx.lines.slice(0, at < 0 ? idx.lines.length : at).filter(l => isRow(l) && VERSION.test(cells(l)[0] ?? ''));
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
// tar downloaded from the Release has that hash, and the Source the archive's own source-hash gives on it (sourceOf) is the request's; with
// `kit`, the kit as checkKitOnRelease holds it. `stage` keeps the downloaded tar for a second call. The Source it computed.
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
  const source = await sourceOf({ tarFile, request, deps, now });
  check(request.ciSourceManifestSha256 === undefined || request.ciSourceManifestSha256 === source, 'ACCEPTANCE_SOURCE_NOT_THE_RELEASES',
    { request: request.ciSourceManifestSha256, release: source });
  if (kit) await checkKitOnRelease({ ghCommand, repo, tag, kitSha256: request.firstInstallKitSha256 });
  return source;
}

// The Source a request names on a tar: the archive's own source-hash, with the drill's stand-ins (they do not enter it).
async function sourceOf({ tarFile, request, deps, now }) {
  const { ciSourceManifestSha256: _ignored, ...draft } = request;
  const sh = await (deps.sourceHash ?? sourceHashOf)({ artifactPath: tarFile, artifactSha256: request.archive_sha256, acceptance: acceptanceOf(draft, DRILL_RESERVED), now });
  check(HEX64.test(sh?.ciSourceManifestSha256 ?? ''), 'ACCEPTANCE_SOURCE_HASH_REFUSED');
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
  const build = await readBuild(dir);
  const { release } = build, s = release.source;
  check(s.version === version, 'PREPARE_BUILD_NOT_THIS_VERSION', s.version);
  const tag = tagOf(version), kitName = `${tag}.first-install-kit.json`;
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-prepare-'));
  try {
    // 0. local first: the node entry staged from the checked archive (refused here when the archive lacks it), the index row when there is one
    const entryStage = path.join(stage, 'release-assets');
    await fs.mkdir(entryStage);
    const { sums, entry } = await stageNodeEntry(build, entryStage);
    const releaseAssets = [build.assets[0], build.assets[1], sums, ...entry];
    const idx = await readIndex(index);
    const at = findRow(idx.lines, version);
    const c = at >= 0 ? cells(idx.lines[at]) : null;
    check(c === null || (c[2] === s.archive_sha256 && c[3] === s.commit), 'ACCEPTANCE_NOT_THIS_RELEASE');
    // accepted is what the Release holds (blocking 5): an accepted version is never given a kit or a request afterwards; no Release yet is fine
    const viewed = viewReleaseOrNull(ghCommand, repo, tag);
    check(viewed !== null || c === null, 'PREPARE_INDEX_ROW_WITHOUT_RELEASE', { version, note: 'the index names this version, GitHub has no Release of it: not this command\'s to guess' });
    const onRelease = new Set((viewed?.assets ?? []).map(x => x.name));
    check(!onRelease.has(`${tag}.acceptance.json`), 'PREPARE_VERSION_ALREADY_ACCEPTED',
      { version, note: 'the Release holds its acceptance; if the index row is empty, run the same seal again to complete it' });
    check(c === null || (c[4] === '' && c[5] === ''), 'PUBLISH_ACCEPTANCE_INDEX_WITHOUT_ASSET', { version, acceptedAt: c?.[4], decision: c?.[5] });
    // 1. the kit: the Release's once it has one (the one fact from then on), else this node's; held to what a new node will read
    const kitFromRelease = onRelease.has(kitName);
    const kitBytes = kitFromRelease ? await fs.readFile(downloadAsset(ghCommand, repo, tag, kitName, stage))
      : Buffer.from(JSON.stringify(await (deps.kitOf ?? firstInstallKitOf)({ root })) + '\n');
    (deps.readKit ?? readKit)(kitBytes);
    let kit;
    try { kit = JSON.parse(kitBytes.toString('utf8')); } catch { fail('FIRST_INSTALL_KIT_NOT_JSON'); }
    // 2. the request: what this node carries into every acceptance; its Source from the build's own tar (the bytes step 0 checked and step 4
    //    puts on the Release; step 5 recomputes it on the tar downloaded from the Release, the check seal makes)
    const m = await (deps.fleetMaterial ?? installedFleetMaterial)(root);
    const fleetRefs = Object.fromEntries(REQUEST_FLEET_REFS.map(k => [k, k === 'formalRoles' ? m?.formalRoles : m?.installed?.[k]]));
    const request = { contract: REQUEST_CONTRACT, version, archive_sha256: s.archive_sha256, commit: s.commit, repository: repo, ciSourceManifestSha256: undefined,
      firstInstallKitSha256: sha(kitBytes), fleetRefs };
    const source = await sourceOf({ tarFile: path.join(dir, release.archive.name), request, deps, now });
    check(kit.config?.ciSourceManifestSha256 !== source, 'PREPARE_TEMPLATE_IS_THIS_SOURCE',
      { template: kit.config?.ciSourceManifestSha256, note: 'this node already runs this version: the kit must be taken before it upgrades' });
    request.ciSourceManifestSha256 = source;
    readRequest(request);
    // the request becomes an acceptance every node reads (the five fields seal fills aside)
    try { validateAcceptance(acceptanceOf(request, DRILL_RESERVED), now); } catch (e) { fail('PREPARE_REQUEST_REFUSED', e?.detail ?? e?.code ?? String(e)); }
    // steps 3, 4 and 5 each print one line of when they started and ended, on stderr (Fable ruling 0e418483, node-install batch 3.3 B: what
    // prepare's 8-9 minutes are made of is not known yet)
    let lapAt = Date.now(); const lap = n => { const t = Date.now(); console.error(JSON.stringify({ prepareStep: n, startedAt: new Date(lapAt).toISOString(), endedAt: new Date(t).toISOString(), seconds: (t - lapAt) / 1000 })); lapAt = t; };
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
    lap(3);
    // 4. all checks passed: the Release and the index row of this build, made or completed (only the tag fleet-node-<v> and this row)
    await ensureRelease({ ghCommand, repo, index, s, assets: releaseAssets, stage });
    lap(4);
    // 5. the directory, the kit and the images in it, what the Release lacks uploaded, the whole request held to the Release (the same check
    //    as seal's); 6. only then the request
    await fs.mkdir(out, { recursive: true });
    const kitFile = path.join(out, kitName);
    await writeAtomic(kitFile, kitBytes);
    const placed = [];
    for (const [id, f] of files) { const to = path.join(out, `role-image-${id}.tar.gz`); if (path.resolve(f) !== path.resolve(to)) await fs.copyFile(f, to); placed.push(to); }
    const attached = await attachFirstInstallKit({ version, kit: kitFile, images: placed, repo, ghCommand, resume: true });
    await checkRequestOnRelease({ ghCommand, repo, request, stage, kit: true, deps, now });
    lap(5);
    const requestFile = path.join(out, `${tag}.acceptance-request.json`);
    const requestBytes = Buffer.from(JSON.stringify(request, null, 2) + '\n');
    await putRequestOnRelease({ ghCommand, repo, tag, bytes: requestBytes, stage });
    await writeAtomic(requestFile, requestBytes);
    return { status: 'FLEET_ACCEPTANCE_REQUEST_WRITTEN', version, request: requestFile, directory: out, kitFrom: kitFromRelease ? 'release' : 'node',
      firstInstallKitSha256: request.firstInstallKitSha256, ciSourceManifestSha256: request.ciSourceManifestSha256, images: attached.images,
      requestSha256: sha(requestBytes) };
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

// Only a package built from a commit already on main can be accepted (Fable renew-key ruling, supplement "one round exposes every error" (3)):
// branch candidates may be built, released, prepared and drilled to probe; seal is where they stop. Asked of GitHub, not of a local clone that
// may not have fetched: compare main...<commit> is "identical" or "behind" exactly when the commit is main's or one of its ancestors. An
// answer that cannot be read refuses as well.
function checkCommitOnMain(ghCommand, repo, commit) {
  const r = gh(ghCommand, ['api', `repos/${repo}/compare/main...${commit}`]);
  let status = null;
  try { status = r.status === 0 ? JSON.parse(r.stdout).status : null; } catch { status = null; }
  check(typeof status === 'string' && ['identical', 'behind', 'ahead', 'diverged'].includes(status), 'SEAL_MAIN_UNREADABLE', { commit, exit: r.status, stderr: r.stderr });
  check(status === 'identical' || status === 'behind', 'SEAL_COMMIT_NOT_ON_MAIN', { commit, status });
}

// The acceptance request on the Release (prepare's step 6, seal's last check before the door): its bytes there, or null when it has none.
async function requestOnRelease({ ghCommand, repo, tag, stage }) {
  const name = `${tag}.acceptance-request.json`;
  if (!viewRelease(ghCommand, repo, tag).assets.some(x => x.name === name)) return null;
  return fs.readFile(downloadAsset(ghCommand, repo, tag, name, stage));
}
// prepare's step 6: the request goes up as a Release asset (never --clobber). The same bytes there are kept; other bytes are refused and never
// replaced (the door may already have opened a request on them); read back whole.
async function putRequestOnRelease({ ghCommand, repo, tag, bytes, stage }) {
  const name = `${tag}.acceptance-request.json`;
  const there = await requestOnRelease({ ghCommand, repo, tag, stage });
  if (there !== null) {
    check(there.equals(bytes), 'PREPARE_REQUEST_ON_RELEASE_DIFFERENT', { asset: name, release: sha(there), this: sha(bytes),
      note: 'the Release holds another acceptance request of this version; it is never replaced: build a new version' });
    return;
  }
  const dir = await fs.mkdtemp(path.join(stage, 'request-'));
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  const up = gh(ghCommand, ['release', 'upload', tag, file, '--repo', repo]);
  check(up.status === 0, 'PUBLISH_GH_RELEASE_UPLOAD_FAILED', { asset: name, stderr: up.stderr });
  const back = await requestOnRelease({ ghCommand, repo, tag, stage });
  check(back !== null && back.equals(bytes), 'PUBLISH_RELEASE_ASSET_MISSING', name);
}

// How seal reads the door (PLAN-accept-auto-seal-20261125 2.3; PLAN-accept-binding-20261125 section 3). --wait <minutes>: read again after
// 30 s, 60 s, then every 120 s, never past the wait nor past the request's expiry. A request seal opened: read every OPEN_STEP_MS for its
// link, up to OPEN_WAIT_MS after the run was dispatched, whatever the wait (the wait is for the Owner, this for the workflow: its
// fleet-accept job times out after 10 minutes, plus 5 for its queue; PLAN-accept-align-open-20261125 2.2). A read that fails: again after
// READ_RETRY_MS while there is time. An accepted_at at most CLOCK_SKEW_MAX_MS after this machine's clock: waited out once.
export const WAIT_STEPS_MS = Object.freeze([30_000, 60_000, 120_000]);
export const WAIT_MAX_MINUTES = 1440;
export const OPEN_WAIT_MS = 15 * 60_000;
export const OPEN_STEP_MS = 15_000;
export const READ_RETRY_MS = 30_000;
export const CLOCK_SKEW_MAX_MS = 120_000;
// what seal opens a request on: none, or one that ran out; never rejected, the Owner's final answer (the door never opens it again)
const NOT_OPEN = ['none', 'expired'];
// seal's refusals that asking again cannot change (the request, its file name, the repository, the index row, the drill receipt, a version
// the door has accepted otherwise): accept.mjs stops on them at once and asks again on any other (the one list; Task 87d330d0 alignment).
export const SEAL_INPUT_ERRORS = Object.freeze(['USAGE', 'REQUEST_REFUSED', 'REQUEST_FILE_NAME_REFUSED', 'PUBLISH_REPO_REFUSED', 'ACCEPTANCE_NOT_THIS_REPOSITORY',
  'ACCEPTANCE_REFUSED', 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN', 'ACCEPTANCE_NOT_THIS_RELEASE', 'PUBLISH_INDEX_LACKS_VERSION', 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED',
  'SEAL_ANOTHER_ACCEPTANCE_IN_DIRECTORY', 'SEAL_REQUEST_REFUSED', 'SEAL_DRILL_RECEIPT_REFUSED', 'SEAL_DRILL_RECEIPT_NOT_A_CANDIDATE', 'SEAL_DRILL_RECEIPT_NOT_PASS',
  'SEAL_DRILL_RECEIPT_NOT_THIS_PACKAGE', 'SEAL_DRILL_RECEIPT_NOT_THE_RECORDED', 'ACCEPT_RESOURCE_REFUSED', 'ACCEPT_DOOR_NOT_CONFIGURED', 'ACCEPT_DOOR_VERSION_ALREADY_ACCEPTED']);

// The second half of an acceptance (see the head of this file). `deps` is for tests only (a stand-in for the archive's source-hash, the door's
// anonymous read, the clock and the sleep of --wait); the command line cannot reach it and reads the door with the repository's public
// configuration (accept-door.mjs statusReader); the request is opened with this file's gh.
export async function seal(options) {
  // the Decision record has no way in (PLAN 2.2): given, it is USAGE, before anything is read or asked
  check(!Object.hasOwn(options ?? {}, 'decisionRecord'), 'USAGE', { note: 'the acceptance is the Owner\'s fleet.accept Grant: seal asks the door, no Decision record goes in' });
  const { request, drillReceipt = null, repo = DEFAULT_REPO, index = DEFAULT_INDEX, ghCommand = ['gh'], now = Date.now(), wait = 0, deps = {} } = options ?? {};
  check(REPO.test(repo ?? ''), 'PUBLISH_REPO_REFUSED');
  check(wait === 0 || (Number.isInteger(wait) && wait >= 1 && wait <= WAIT_MAX_MINUTES), 'USAGE', { wait });
  const readStatus = deps.readStatus ?? statusReader();
  const clock = deps.clock ?? Date.now, sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = clock(), nowAt = () => now + (clock() - started);
  let requestBytes, r;
  try { requestBytes = await fs.readFile(request); r = JSON.parse(requestBytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('REQUEST_REFUSED', 'not a JSON file'); }
  readRequest(r);
  const tag = tagOf(r.version);
  check(path.basename(request) === `${tag}.acceptance-request.json`, 'REQUEST_FILE_NAME_REFUSED', path.basename(request));
  check(r.repository === repo, 'ACCEPTANCE_NOT_THIS_REPOSITORY', r.repository);
  // everything seal refuses on its own is refused before the Owner is asked: the acceptance the request becomes (its fleetRefs naming the
  // drill's stand-in; the contract every node reads, as prepare holds it), the drill receipt (its three hashes are the request's), the index
  // row, the commit on main, the request against the Release and the request asset the workflow reads
  check(!namesDrillReserved({ fleetRefs: r.fleetRefs }), 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN', { note: 'the request\'s fleetRefs name the drill\'s stand-in' });
  try { validateAcceptance(acceptanceOf(r, DRILL_RESERVED), now); } catch (e) { fail('SEAL_REQUEST_REFUSED', e?.detail ?? e?.code ?? String(e)); }
  const drill = drillReceipt === null ? NOT_DRILLED : await drillCellOf(drillReceipt, r);
  const final = path.join(path.dirname(request), `${tag}.acceptance.json`);
  const idx = await readIndex(index);
  const at = findRow(idx.lines, r.version);
  check(at >= 0, 'PUBLISH_INDEX_LACKS_VERSION', r.version);
  const c = cells(idx.lines[at]);
  check(r.archive_sha256 === c[2] && r.commit === c[3], 'ACCEPTANCE_NOT_THIS_RELEASE');
  checkCommitOnMain(ghCommand, repo, r.commit);
  // the file goes up from a directory of its own; it is written next to the request only after the Release and the index hold it
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-seal-'));
  try {
    await checkRequestOnRelease({ ghCommand, repo, request: r, stage, kit: true, deps, now });
    const requestSha256 = sha(requestBytes);
    const onRelease = await requestOnRelease({ ghCommand, repo, tag, stage });
    check(onRelease !== null && onRelease.equals(requestBytes), 'SEAL_REQUEST_NOT_ON_RELEASE', { asset: `${tag}.acceptance-request.json`,
      release: onRelease === null ? null : sha(onRelease), request: requestSha256, note: 'the release workflow reads the request from the Release: run the same prepare again' });
    // the Owner's acceptance: one fleet.accept Grant on this request (accept-door.mjs), read anonymously; opened once when the door has none open
    const resource = acceptResourceOf({ repository: r.repository, version: r.version, archiveSha256: r.archive_sha256, requestSha256 });
    const until = started + wait * 60_000;
    let answer = null, openedAt = null, seenOpen = false, skewWaited = false, waitStep = 0;
    const openUntil = () => openedAt + OPEN_WAIT_MS;
    for (;;) {
      let a;
      try {
        a = readAnswer(await readStatus(resource), { resource, requestSha256 });
      } catch (e) {
        // a read that failed (a 503, a dropped connection, a timeout): read again while this seal still waits for something
        if (e?.code !== 'ACCEPT_DOOR_UNAVAILABLE') throw e;
        // after this seal's run an unreadable door ends as NOT_OPENED, never as a throw its caller would answer with seal (a run) again
        const opening = openedAt !== null && !seenOpen;
        const left = (opening ? openUntil() : Math.min(until, answer?.kind === 'pending' ? Date.parse(answer.expiresAt) : Infinity)) - clock();
        if (left <= 0) { if (opening || answer?.kind === 'pending') break; throw e; }
        await sleep(Math.min(READ_RETRY_MS, left));
        continue;
      }
      answer = a;
      if (a.kind === 'accepted') {
        // the door's time is the server's: a few seconds ahead of this machine is waited out once, further ahead refused
        const ahead = a.acceptedAtMs - nowAt();
        if (ahead <= 0) break;
        check(ahead <= CLOCK_SKEW_MAX_MS && !skewWaited, 'ACCEPT_DOOR_ANSWER_REFUSED', { status: 'accepted', acceptedAt: a.acceptedAt, aheadMs: ahead,
          note: 'accepted_at is after this machine\'s clock' });
        skewWaited = true;
        await sleep(ahead + 1000);
        continue;
      }
      if (a.kind === 'pending') {
        seenOpen = true;
        const left = Math.min(until, Date.parse(a.expiresAt)) - clock();
        if (left <= 0) break;
        await sleep(Math.min(WAIT_STEPS_MS[Math.min(waitStep++, WAIT_STEPS_MS.length - 1)], left));
        continue;
      }
      // rejected: the Owner's final answer, whenever it is read; nothing is opened again
      if (a.kind === 'rejected') break;
      // none or expired: the end of a request this seal saw open; otherwise no request is open, so it is opened, once
      if (seenOpen) {
        check(a.kind !== 'none', 'ACCEPT_DOOR_ANSWER_REFUSED', { status: 'none', note: 'the door forgot a request it had open' });
        break;
      }
      if (openedAt === null) {
        openRequest({ runGh: args => gh(ghCommand, args), repository: r.repository, version: r.version, requestSha256 });
        openedAt = clock();
      }
      const left = openUntil() - clock();
      if (left <= 0) break;
      await sleep(Math.min(OPEN_STEP_MS, left));
    }
    if (answer.kind === 'pending') {
      return { status: 'FLEET_ACCEPTANCE_WAITING_OWNER', version: r.version, opened: true, confirmUrl: answer.confirmUrl, expiresAt: answer.expiresAt, resource,
        next: 'the Owner approves on confirmUrl; then the same seal again (--wait <minutes> waits for it)' };
    }
    if (NOT_OPEN.includes(answer.kind) && !seenOpen) {
      // only after this seal's one run (none or expired is always opened): the workflow did not open it within OPEN_WAIT_MS
      return { status: 'FLEET_ACCEPTANCE_NOT_OPENED', version: r.version, resource, dispatchedAt: new Date(now + (openedAt - started)).toISOString(), waitedMs: OPEN_WAIT_MS,
        next: 'the release workflow (mode fleet-accept) did not open the request: read why in its latest run, fix that, then run the same command again' };
    }
    if (answer.kind !== 'accepted') {
      return { status: 'FLEET_ACCEPTANCE_REJECTED', version: r.version, answer: answer.kind, resource,
        next: answer.kind === 'expired' ? 'the request ran out: the same seal again opens a new one'
          : 'the Owner rejected this candidate, which is final (never asked again); nothing was written: to accept, publish a new version' };
    }
    const a = acceptanceOf(r, { decision: answer.grantId, receipt: answer.receiptId, acceptedAt: answer.acceptedAt });
    check(!namesDrillReserved(a), 'ACCEPTANCE_IS_THE_DRILLS_STAND_IN', { grant: answer.grantId, receipt: answer.receiptId });
    try { validateAcceptance(a, nowAt()); } catch (e) { fail('ACCEPTANCE_REFUSED', e?.detail ?? e?.code ?? String(e)); }
    const bytes = Buffer.from(JSON.stringify(a, null, 2) + '\n');
    const readOrNull = async f => { try { return await fs.readFile(f); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
    const there = await readOrNull(final);
    check(there === null || there.equals(bytes), 'SEAL_ANOTHER_ACCEPTANCE_IN_DIRECTORY', final);
    check((c[4] === '' && c[5] === '') || (c[4] === a.acceptedAt && c[5] === a.cluedDecision), 'PUBLISH_ACCEPTANCE_ALREADY_ATTACHED', { acceptedAt: c[4], decision: c[5] });
    const staged = path.join(stage, 'up', `${tag}.acceptance.json`);
    await fs.mkdir(path.dirname(staged));
    await fs.writeFile(staged, bytes, { flag: 'wx' });
    const attached = await attachAcceptance({ version: r.version, acceptance: staged, repo, index, drill, ghCommand });
    if (there === null) await writeAtomic(final, bytes);
    return { ...attached, status: 'FLEET_ACCEPTANCE_SEALED', acceptance: final, grantId: answer.grantId, receiptId: answer.receiptId };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// The command line's exit code of a seal or prepare that answered: non-zero only for an Owner's rejection, an expired request or a request
// the workflow did not open (a refusal throws and exits 1 as well); waiting for the Owner is not a failure.
export const exitCodeOf = r => (['FLEET_ACCEPTANCE_REJECTED', 'FLEET_ACCEPTANCE_NOT_OPENED'].includes(r?.status) ? 1 : 0);

export async function main(argv) {
  const [sub, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { dir: { type: 'string' }, repo: { type: 'string' }, index: { type: 'string' },
      version: { type: 'string' }, image: { type: 'string', multiple: true }, out: { type: 'string' }, request: { type: 'string' },
      'drill-receipt': { type: 'string' }, wait: { type: 'string' } } });
  } catch { fail('USAGE'); }   // an option no command has (the old entry's --base, --kit, --acceptance; seal's old --decision, --receipt, --accepted-at
  //                              and --decision-record: the acceptance is the Owner's fleet.accept Grant, PLAN-accept-auto-seal-20261125 2.2)
  // the release command is gone (prepare makes the Release): `release`, with or without options, ends in USAGE below like any unknown command
  const { values, positionals } = parsed;
  check(positionals.length === 0, 'USAGE');
  const only = (...allowed) => check(Object.keys(values).every(k => allowed.includes(k)), 'USAGE');
  if (sub === 'prepare') {
    only('version', 'dir', 'out', 'image', 'repo', 'index'); check(values.version && values.dir && values.out, 'USAGE');
    return prepare({ version: values.version, dir: values.dir, out: path.resolve(values.out), images: values.image ?? [], repo: values.repo, index: values.index });
  }
  if (sub === 'seal') {
    only('request', 'drill-receipt', 'wait', 'repo', 'index');
    check(values.request, 'USAGE');
    // --wait <minutes>: a whole number from 1 to WAIT_MAX_MINUTES; without it the door is asked once
    check(values.wait === undefined || (/^[0-9]{1,4}$/.test(values.wait) && Number(values.wait) >= 1 && Number(values.wait) <= WAIT_MAX_MINUTES), 'USAGE', { wait: values.wait });
    return seal({ request: path.resolve(values.request), drillReceipt: values['drill-receipt'] ? path.resolve(values['drill-receipt']) : null,
      wait: values.wait === undefined ? 0 : Number(values.wait), repo: values.repo, index: values.index });
  }
  return fail('USAGE');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(r => { console.log(JSON.stringify(r)); process.exitCode = exitCodeOf(r); }, e => {
    console.log(JSON.stringify({ status: 'FLEET_RELEASE_REFUSED', code: e?.code ?? 'FLEET_RELEASE_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  });
}
