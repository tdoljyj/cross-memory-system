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
// Fable renew-key ruling, supplements "merge order" and "heartbeat token and restart code": the drill is held to the package it drills.
// Its credential file names are data the package ships (supplement "where the credential list comes from"): windows/credential-files.json
// in the archive, read as it is and recorded in the kit with its bytes' hash; a package without it is refused (no kit). drill-vm.ps1
// Get-DrillCredentialPlan then refuses before any boot a required name the drill cannot make, and an optional name it has no decision for.
export const CREDENTIAL_FILES = 'tree/work/independent-ci-resident-v1/windows/credential-files.json';
export const CREDENTIAL_FILES_CONTRACT = 'clued.independent-ci.credential-files/1';
// The prerequisite items (by name in the package's prereq-manifest.json) the drill injects and the guest never downloads.
export const INJECTED_TOOLS = Object.freeze(['gh', 'git-for-windows']);
// The first key written twice in one object of a JSON text -- by case too, as for file names -- or null. Scanned as JSON (strings with their
// escapes, objects and arrays nested), never counted by a pattern: JSON.parse keeps the last of a key given twice and cannot show it
// (8th review round, medium 2 and low 1). Called on a text JSON.parse has taken.
function duplicateJsonKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') stack.push(new Set());
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top) {
        const key = JSON.parse(text.slice(i, j + 1)).toLowerCase();
        if (top.has(key)) return key;
        top.add(key);
      }
      i = j;
    }
  }
  return null;
}

// The package's credential list from its archive, the one reader the build and the run's gate both use: exactly
// { contract, required, optional }, each group an object of plain file names, a non-empty required group, no key twice, no name twice
// (in a group, across the two, or by case). Anything else, or no list, is refused. Returns the list and the hash of its bytes.
export function credentialsOfTar(tarBytes) {
  const entries = readTar(tarBytes).filter(e => e.path === CREDENTIAL_FILES);
  check(entries.length === 1, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'no credential-files.json in the archive');
  const text = entries[0].data.toString('utf8');
  let c = null;
  try { c = JSON.parse(text); } catch { c = null; }
  const group = g => g !== null && typeof g === 'object' && !Array.isArray(g) && Object.values(g).every(v => typeof v === 'string' && nameOK(v));
  check(c !== null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).sort().join() === 'contract,optional,required' &&
    c.contract === CREDENTIAL_FILES_CONTRACT && group(c.required) && group(c.optional) && Object.keys(c.required).length > 0,
    'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'credential-files.json');
  // a key written twice in one object, by case too (JSON.parse keeps the last; Windows PowerShell refuses such an object)
  check(duplicateJsonKey(text) === null, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'a key twice');
  const names = [...Object.values(c.required), ...Object.values(c.optional)];
  check(new Set(names.map(n => n.toLowerCase())).size === names.length, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'a name twice');
  return { sha256: sha256(entries[0].data), credentials: { contract: c.contract, required: c.required, optional: c.optional } };
}

// The drill's decision for each credential name (give, with the fake file; or withhold, with the reason), the one table drill-vm.ps1 reads
// as well. A name given with a perNodeStep is a stand-in the run makes and hands over: the kit registers that step (Codex review of
// f33fc33e5, medium 4). Looked up by the name's own key, ordinal and case-sensitive, as drill-vm.ps1 does (6th review round, low 1).
export const CREDENTIAL_DECISIONS = Object.freeze(JSON.parse(fs.readFileSync(new URL('./credential-decisions.json', import.meta.url), 'utf8')).decisions);
const standInSteps = credentials => [...Object.values(credentials?.required ?? {}), ...Object.values(credentials?.optional ?? {})]
  .filter(n => Object.hasOwn(CREDENTIAL_DECISIONS, n) && CREDENTIAL_DECISIONS[n].give === true && typeof CREDENTIAL_DECISIONS[n].perNodeStep === 'string')
  .map(n => CREDENTIAL_DECISIONS[n].perNodeStep);

export function drillKitManifest({ payloads, prereqBytes, timeoutMinutes = 240, candidate = null, credentials = null, credentialFilesSha256 = null }) {
  check(Number.isInteger(timeoutMinutes) && timeoutMinutes >= 5 && timeoutMinutes <= 240, 'DRILL_KIT_TIMEOUT_REFUSED');
  const prereq = JSON.parse(prereqBytes.toString('utf8'));
  check(prereq.contract === 'clued.drill.prereq/1', 'DRILL_PREREQ_CONTRACT_REFUSED');
  const names = Object.keys(payloads).sort();
  check(names.includes('first-install-entry.ps1') && names.every(nameOK), 'DRILL_KIT_PAYLOAD_REFUSED');
  return { contract: 'clued.drill.first-install-kit/1',
    files: names.map(name => ({ path: name, sha256: sha256(payloads[name]) })),
    entry: { file: 'first-install-entry.ps1', arguments: ['-From', '{from}', '-Kit', '{kit}', '-Fake', '{fake}', '-Work', '{work}', '-Version', '{version}'] },
    // a stand-in step for every name the package names and the drill makes and hands over (the decision table), required or optional
    timeoutMinutes, perNodeSteps: ['未验证原入口的非提权检查', '绕过 RunAs 提权', '绕过凭据窗口', ...standInSteps(credentials)], prereqSha256: sha256(prereqBytes),
    // The real first-install host owns WSL import, Docker and accounts, from S0.
    prerequisiteMode: 'first-install-host', ...(candidate ? { candidate } : {}), ...(credentials ? { credentials } : {}), ...(credentialFilesSha256 ? { credentialFilesSha256 } : {}) };
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
  const { sha256: credentialFilesSha256, credentials } = credentialsOfTar(read(from, `fleet-node-${version}.tar`));
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
  // the package's gh and Git for Windows installers are injected, both and with the package's hashes, or no kit (Codex review of
  // e0a3cded5, high 3): the guest never fetches them. Each is a prerequisite the package's bootstrap requires, so its manifest must
  // declare each exactly once: one missing (or twice) is refused, never taken as nothing to check (Codex review of f33fc33e5, medium 3).
  for (const tool of INJECTED_TOOLS) {
    const declared = (pm.items ?? []).filter(i => i?.name === tool);
    check(declared.length === 1, `DRILL_PREREQ_TOOL_NOT_DECLARED:${tool}`);
    const need = declared[0];
    check(Object.hasOwn(payloads, need.fileName) && sha256(payloads[need.fileName]) === need.sha256, `DRILL_PREREQ_TOOLS_INCOMPLETE:${tool}`);
  }
  const manifest = drillKitManifest({ payloads, prereqBytes, timeoutMinutes, candidate, credentials, credentialFilesSha256 });
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
    const { values } = parseArgs({ options: Object.fromEntries(['from', 'version', 'prereq', 'out', 'request', 'build', 'final', 'images', 'credentials-of'].map(n => [n, { type: 'string' }])) });
    // --credentials-of <tar>: the package's credential list and its bytes' hash, for drill-vm.ps1's gate (Assert-DrillKitCredentialsBound)
    if (values['credentials-of']) console.log(JSON.stringify(credentialsOfTar(fs.readFileSync(values['credentials-of']))));
    else {
      check(values.version && values.out, 'USAGE: --version <v> --out <new-dir> (--from <release-dir> --prereq <prereq.json> [--request <fleet-node-<v>.acceptance-request.json>: a candidate] | --build <dir> --final <dir> --images <dir>) | --credentials-of <tar>');
      console.log(JSON.stringify(values.build ? prepareFrom(values) : await makeDrillKit(values)));
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
