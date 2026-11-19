// Local, create-only assembly. No network, Git, credentials or machine preparation. A CANDIDATE (a From directory with no acceptance:
// the Owner has not accepted the version yet) also reads the acceptance request publish.mjs prepare wrote for it (--request).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateAcceptance } from '../rollout/fleet/install.mjs';
import { DRILL_RESERVED, acceptanceOf, namesDrillReserved, readRequest } from '../rollout/fleet/publish.mjs';
import { readTar } from '../rollout/fleet/tar.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, code) => { if (!ok) throw new Error(code); };
const nameOK = name => /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$/.test(name);
const read = (dir, name) => {
  check(nameOK(name), 'DRILL_ASSET_NAME_REFUSED');
  const file = path.join(dir, name);
  check(fs.lstatSync(file).isFile(), `DRILL_ASSET_NOT_REGULAR:${name}`);
  return fs.readFileSync(file);
};
export function readSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const m = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+~-]{0,200})$/.exec(line);
    check(m && !sums.has(m[2].toLowerCase()), 'DRILL_SUMS_REFUSED');
    sums.set(m[2].toLowerCase(), { name: m[2], sha256: m[1] });
  }
  return [...sums.values()];
}
const sumsText = files => [...files].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  .map(f => `${sha256(f.bytes)}  ${f.name}\n`).join('');

// A candidate's acceptance, for the drill guest only (Fable ruling 11-19 section 2.3: candidate -> drill PASS -> the Owner accepts once; a
// failed candidate never reaches the Owner). It is the acceptance request publish.mjs prepare wrote (the archive, the first-install kit and
// the Source the Owner will accept, and the fleet references) made an acceptance with the drill's stand-ins (publish.mjs acceptanceOf and
// DRILL_RESERVED, the one place they are defined; seal and attaching an acceptance refuse them, so this file never reaches a Release).
// The request must be this candidate's: its archive and first-install kit are the From directory's bytes. Its Source is prepare's
// (sourceHashOf); the guest's install.mjs recomputes it and refuses another. The guest runs the package's install code as it is: no drill mode.
export function candidateAcceptance({ from, version, request, now = Date.now() }) {
  check(request, 'DRILL_CANDIDATE_REQUEST_REQUIRED');
  const tag = `fleet-node-${version}`;
  check(path.basename(request) === `${tag}.acceptance-request.json`, 'DRILL_CANDIDATE_REQUEST_NOT_THIS_VERSION');
  let r;
  try { r = readRequest(JSON.parse(fs.readFileSync(request, 'utf8').replace(/^\uFEFF/, ''))); }
  catch (e) { throw new Error(`DRILL_CANDIDATE_REQUEST_REFUSED:${e?.code ?? e?.message}`); }
  check(r.version === version, 'DRILL_CANDIDATE_REQUEST_NOT_THIS_VERSION');
  check(r.archive_sha256 === sha256(read(from, `${tag}.tar`)) && r.firstInstallKitSha256 === sha256(read(from, `${tag}.first-install-kit.json`)),
    'DRILL_CANDIDATE_REQUEST_NOT_THIS_PACKAGE');
  const acceptance = acceptanceOf(r, DRILL_RESERVED);
  try { validateAcceptance(acceptance, now); } catch (e) { throw new Error(`DRILL_CANDIDATE_ACCEPTANCE_REFUSED:${e?.detail ?? e?.code ?? e?.message}`); }
  return acceptance;
}

// Pure manifest constructor: every payload byte is pinned, including release-pins.json. `candidate`: the candidate's acceptance among
// the payloads and the three hashes it names (drill-vm.ps1 holds the run to them and writes them into the receipt).
export function drillKitManifest({ payloads, prereqBytes, timeoutMinutes = 240, candidate = null }) {
  check(Number.isInteger(timeoutMinutes) && timeoutMinutes >= 5 && timeoutMinutes <= 240, 'DRILL_KIT_TIMEOUT_REFUSED');
  const prereq = JSON.parse(prereqBytes.toString('utf8'));
  check(prereq.contract === 'clued.drill.prereq/1', 'DRILL_PREREQ_CONTRACT_REFUSED');
  const names = Object.keys(payloads).sort();
  check(names.includes('first-install-entry.ps1') && names.every(nameOK), 'DRILL_KIT_PAYLOAD_REFUSED');
  return { contract: 'clued.drill.first-install-kit/1',
    files: names.map(name => ({ path: name, sha256: sha256(payloads[name]) })),
    entry: { file: 'first-install-entry.ps1', arguments: ['-From', '{from}', '-Kit', '{kit}', '-Fake', '{fake}', '-Work', '{work}', '-Version', '{version}'] },
    timeoutMinutes, perNodeSteps: ['未验证原入口的非提权检查', '绕过 RunAs 提权', '绕过凭据窗口', '工具缓存短路径替身（包缺陷 Expand-Cached 超 MAX_PATH，修复中）'], prereqSha256: sha256(prereqBytes),
    // The real first-install host owns WSL import, Docker and accounts, from S0.
    prerequisiteMode: 'first-install-host', ...(candidate ? { candidate } : {}) };
}

// Validate a complete local Release directory, without treating a new sums file as acceptance. No acceptance file in it: a candidate
// (candidate: true; makeDrillKit adds the candidate's own acceptance to the kit). One that names the drill's stand-ins is refused.
export function releasePins(from, version) {
  check(/^[0-9A-Za-z][0-9A-Za-z.\-]{0,63}$/.test(version), 'DRILL_VERSION_REFUSED');
  const tag = `fleet-node-${version}`;
  const accName = `${tag}.acceptance.json`, kitName = `${tag}.first-install-kit.json`;
  const sumsName = `${tag}.first-install.SHA256SUMS`;
  const sums = [...readSums(read(from, 'SHA256SUMS').toString()), ...readSums(read(from, sumsName).toString())];
  check(new Set(sums.map(f => f.name.toLowerCase())).size === sums.length, 'DRILL_ASSET_IN_BOTH_SUMS');
  const pins = new Map(sums.map(f => [f.name, f.sha256]));
  for (const suffix of ['tar', 'release.json', 'bootstrap.ps1', 'prereq-manifest.json', 'first-install-kit.json']) {
    check(pins.has(`${tag}.${suffix}`), `DRILL_ASSET_NOT_LISTED:${suffix}`);
  }
  const candidate = !fs.existsSync(path.join(from, accName));
  const tarBytes = read(from, `${tag}.tar`);
  if (!candidate) {
    const acceptance = JSON.parse(read(from, accName));
    check(acceptance.contract === 'clued.independent-ci.fleet-node-acceptance/1' && acceptance.version === version &&
      acceptance.archive_sha256 === sha256(tarBytes) && /^[0-9a-f]{64}$/.test(acceptance.ciSourceManifestSha256), 'DRILL_ACCEPTANCE_REFUSED');
    check(!namesDrillReserved(acceptance), 'DRILL_ACCEPTANCE_IS_A_CANDIDATES');
    check(acceptance.firstInstallKitSha256 === sha256(read(from, kitName)), 'DRILL_FIRST_INSTALL_KIT_NOT_ACCEPTED');
  }
  const entries = readTar(tarBytes);
  for (const suffix of ['bootstrap.ps1', 'prereq-manifest.json']) {
    const archived = entries.find(e => e.path === `tree/work/independent-ci-resident-v1/rollout/fleet/${suffix}`);
    check(archived && sha256(archived.data) === pins.get(`${tag}.${suffix}`), 'DRILL_ENTRY_NOT_THE_ARCHIVES');
  }
  const firstKit = JSON.parse(read(from, kitName));
  check(firstKit.contract === 'clued.independent-ci.fleet-node-first-install-kit/1' && Array.isArray(firstKit.images?.local), 'DRILL_FIRST_INSTALL_KIT_REFUSED');
  const imageNames = firstKit.images.local.map(i => i.asset);
  check(imageNames.every(n => /^role-image-[0-9a-f]{64}\.tar\.gz$/.test(n)), 'DRILL_IMAGE_NAME_REFUSED');
  const firstNames = readSums(read(from, sumsName).toString()).map(f => f.name).sort();
  check(JSON.stringify(firstNames) === JSON.stringify([kitName, ...new Set(imageNames)].sort()), 'DRILL_FIRST_SUMS_NOT_THE_KITS');
  const pm = JSON.parse(read(from, `${tag}.prereq-manifest.json`));
  const prereqs = [...(pm.items ?? []), ...(pm.debs ?? [])];
  const files = [];
  for (const name of fs.readdirSync(from).sort()) {
    const bytes = read(from, name);
    const pin = pins.get(name) ?? prereqs.find(p => p.fileName === name)?.sha256;
    check(pin || [accName, 'SHA256SUMS', sumsName].includes(name), `DRILL_UNLISTED_ASSET:${name}`);
    if (pin) check(sha256(bytes) === pin, `DRILL_ASSET_HASH_MISMATCH:${name}`);
    files.push({ path: name, sha256: sha256(bytes) });
  }
  for (const name of pins.keys()) check(files.some(f => f.path === name), `DRILL_ASSET_MISSING:${name}`);
  return { version, files, candidate };
}

// `request`: a candidate's acceptance request (publish.mjs prepare's --out); required for a candidate, refused for an accepted version.
export async function makeDrillKit({ from, version, prereq, out, request, timeoutMinutes = 240, now = Date.now() }) {
  const { candidate: isCandidate, ...pins } = releasePins(from, version);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const payloads = Object.fromEntries(['first-install-entry.ps1'].map(name => [name, read(here, name)]));
  let candidate = null;
  check(isCandidate || !request, 'DRILL_REQUEST_FOR_AN_ACCEPTED_VERSION');
  if (isCandidate) {
    const acceptance = candidateAcceptance({ from, version, request, now });
    const name = `fleet-node-${version}.acceptance.json`, bytes = Buffer.from(JSON.stringify(acceptance, null, 2) + '\n');
    payloads[name] = bytes;
    pins.files = [...pins.files, { path: name, sha256: sha256(bytes) }].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    candidate = { acceptance: name, tarSha256: acceptance.archive_sha256, ciSourceManifestSha256: acceptance.ciSourceManifestSha256,
      firstInstallKitSha256: acceptance.firstInstallKitSha256 };
  }
  payloads['release-pins.json'] = Buffer.from(JSON.stringify(pins, null, 2) + '\n');
  const prereqBytes = fs.readFileSync(prereq), p = JSON.parse(prereqBytes);
  const pm = JSON.parse(read(from, `fleet-node-${version}.prereq-manifest.json`));
  const available = [...(pm.items ?? []), ...(pm.debs ?? [])];
  // tools: the host's pinned gh and Git for Windows installers, injected like WSL and the rootfs (never downloaded in the guest)
  for (const item of [p.wsl, p.rootfs, ...(p.debs ?? []), ...(p.tools ?? [])]) {
    check(item && typeof item.path === 'string' && /^[A-Za-z0-9._+~\\-]+$/.test(item.path) &&
      !item.path.split('\\').includes('..') && !path.win32.isAbsolute(item.path), 'DRILL_PREREQ_PATH_REFUSED');
    const name = path.win32.basename(item.path);
    const accepted = available.find(i => i.fileName === name && i.sha256 === item.sha256);
    check(accepted, `DRILL_PREREQ_NOT_THE_RELEASES:${name}`);
    const bytes = fs.readFileSync(path.join(path.dirname(prereq), ...item.path.split('\\')));
    check(sha256(bytes) === item.sha256 && bytes.length === accepted.bytes, `DRILL_PREREQ_CHANGED:${name}`);
    check(!Object.hasOwn(payloads, name), 'DRILL_PREREQ_DUPLICATE');
    payloads[name] = bytes;
  }
  const manifest = drillKitManifest({ payloads, prereqBytes, timeoutMinutes, candidate });
  fs.mkdirSync(out); // refuse an existing target, including a previous kit
  for (const [name, bytes] of Object.entries(payloads)) fs.writeFileSync(path.join(out, name), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'kit.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { kit: path.resolve(out), version, files: manifest.files.length, perNodeSteps: manifest.perNodeSteps, candidate };
}

// Assemble the local build/final layout exactly as publish.mjs does, never changing the originals.
export function prepareFrom({ build, final, images, version, out }) {
  check(/^[0-9A-Za-z][0-9A-Za-z.\-]{0,63}$/.test(version), 'DRILL_VERSION_REFUSED');
  const tag = `fleet-node-${version}`;
  const tarBytes = read(build, `${tag}.tar`), releaseBytes = read(build, `${tag}.release.json`);
  const buildSums = readSums(read(build, 'SHA256SUMS').toString());
  check(buildSums.length === 2 && buildSums.every(f => sha256(read(build, f.name)) === f.sha256) &&
    buildSums.some(f => f.name === `${tag}.tar`) && buildSums.some(f => f.name === `${tag}.release.json`), 'DRILL_BUILD_SUMS_REFUSED');
  const entries = readTar(tarBytes);
  const files = [{ name: `${tag}.tar`, bytes: tarBytes }, { name: `${tag}.release.json`, bytes: releaseBytes }];
  for (const suffix of ['bootstrap.ps1', 'prereq-manifest.json']) {
    const entry = entries.find(e => e.path === `tree/work/independent-ci-resident-v1/rollout/fleet/${suffix}`);
    check(entry, 'DRILL_ARCHIVE_ENTRY_MISSING');
    files.push({ name: `${tag}.${suffix}`, bytes: entry.data });
  }
  const firstKit = read(final, `${tag}.first-install-kit.json`), k = JSON.parse(firstKit);
  check(k.contract === 'clued.independent-ci.fleet-node-first-install-kit/1' && Array.isArray(k.images?.local), 'DRILL_FIRST_INSTALL_KIT_REFUSED');
  const firstFiles = [{ name: `${tag}.first-install-kit.json`, bytes: firstKit }];
  for (const name of new Set(k.images.local.map(i => i.asset))) {
    check(/^role-image-[0-9a-f]{64}\.tar\.gz$/.test(name), 'DRILL_IMAGE_NAME_REFUSED');
    firstFiles.push({ name, bytes: read(images, name) });
  }
  // the Owner's acceptance when there is one; a candidate has none (its kit carries a drill-only one)
  const acceptance = fs.existsSync(path.join(final, `${tag}.acceptance.json`)) ? [{ name: `${tag}.acceptance.json`, bytes: read(final, `${tag}.acceptance.json`) }] : [];
  fs.mkdirSync(out);
  for (const f of [...files, ...firstFiles, ...acceptance,
    { name: 'SHA256SUMS', bytes: sumsText(files) }, { name: `${tag}.first-install.SHA256SUMS`, bytes: sumsText(firstFiles) }]) {
    fs.writeFileSync(path.join(out, f.name), f.bytes, { flag: 'wx' });
  }
  releasePins(out, version);
  return { from: path.resolve(out), version };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['from', 'version', 'prereq', 'out', 'request', 'build', 'final', 'images'].map(n => [n, { type: 'string' }])) });
    check(values.version && values.out, 'USAGE: --version <v> --out <new-dir> (--from <release-dir> --prereq <prereq.json> [--request <fleet-node-<v>.acceptance-request.json>: a candidate] | --build <dir> --final <dir> --images <dir>)');
    console.log(JSON.stringify(values.build ? prepareFrom(values) : await makeDrillKit(values)));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
