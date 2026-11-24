// Local, create-only assembly. No network, Git, credentials or machine preparation. A CANDIDATE (a From directory with no acceptance:
// the Owner has not accepted the version yet) also reads the acceptance request publish.mjs prepare wrote for it (--request).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
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
        // ASCII's case rule only: the keys that reach here are in the allow-list (credentialsOfTar checks it first)
        const key = JSON.parse(text.slice(i, j + 1)).replace(/[A-Z]/g, ch => ch.toLowerCase());
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
  // strict UTF-8 (8th review round, low 2): a bad byte is unreadable, never patched to U+FFFD under the original bytes' hash
  let text = null, c = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(entries[0].data); } catch { text = null; }
  check(text !== null, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'credential-files.json is not UTF-8');
  try { c = JSON.parse(text); } catch { c = null; }
  // allow-lists, not case rules (9th review round, medium 1; the package branch holds the same): a group's key ^[A-Za-z][A-Za-z0-9]*$; a
  // credential file name ^[A-Za-z0-9][A-Za-z0-9._-]*$, not ending in a dot, no reserved device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9,
  // with or without an extension; 8th review round, low 3). Inside them everything is ASCII, so comparing without case is ASCII's rule.
  const keyOK = k => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k);
  const fileName = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(v) && !v.endsWith('.') && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(v);
  const group = g => g !== null && typeof g === 'object' && !Array.isArray(g) && Object.keys(g).every(keyOK) && Object.values(g).every(fileName);
  check(c !== null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).sort().join() === 'contract,optional,required' &&
    c.contract === CREDENTIAL_FILES_CONTRACT && group(c.required) && group(c.optional) && Object.keys(c.required).length > 0,
    'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'credential-files.json');
  // a key written twice in one object, by case too (JSON.parse keeps the last; Windows PowerShell refuses such an object)
  check(duplicateJsonKey(text) === null, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'a key twice');
  const names = [...Object.values(c.required), ...Object.values(c.optional)];
  check(new Set(names.map(n => n.replace(/[A-Z]/g, ch => ch.toLowerCase()))).size === names.length, 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE', 'a name twice');
  return { sha256: sha256(entries[0].data), credentials: { contract: c.contract, required: c.required, optional: c.optional } };
}

// The drill's decision for each credential name (give, with the fake file; or withhold, with the reason), the one table drill-vm.ps1 reads
// as well. A name given with a perNodeStep is a stand-in the run makes and hands over: the kit registers that step (Codex review of
// f33fc33e5, medium 4). Looked up by the name's own key, ordinal and case-sensitive, as drill-vm.ps1 does (6th review round, low 1).
export const CREDENTIAL_DECISIONS = Object.freeze(JSON.parse(fs.readFileSync(new URL('./credential-decisions.json', import.meta.url), 'utf8')).decisions);
const standInSteps = credentials => [...Object.values(credentials?.required ?? {}), ...Object.values(credentials?.optional ?? {})]
  .filter(n => Object.hasOwn(CREDENTIAL_DECISIONS, n) && CREDENTIAL_DECISIONS[n].give === true && typeof CREDENTIAL_DECISIONS[n].perNodeStep === 'string')
  .map(n => CREDENTIAL_DECISIONS[n].perNodeStep);

// The drill's server (FABLE-drill-role-probe-20261124.md, PR-3): the drill installs against the test project, never production. A made-up
// CI token against production can only be answered "unauthorized" (the 17th candidate's drill), and a real one must not be there at all.
// drill-server.json is the one place the drill's server is named: the project, its address, the hosts the guest cuts off or lets
// through, and the session pooler the host's sync connects through (poolerHost: the host only, never in the kit; its shape is the sync
// script's to hold, apps/clued-cloud/scripts/drill-test-sync.mjs, null until DESK fills it in). The publishable key is the host's copy
// (below). No key yet: no kit (DRILL_SERVER_PUBLISHABLE_KEY_NOT_SET); nothing falls back to the Release's address.
// The first-install kit carries the server in two public fields of its record (prepare-record.mjs); the drill kit carries a copy of that
// file with those two replaced and nothing else, and with it the three files that pin its bytes in the guest: the first-install sums
// (bootstrap.ps1 kitListed), the acceptance (install.mjs firstInstallKitSha256) and the drill's own release-pins.json. The Release
// directory is never changed; the archive and its Source are the package's (the record's address is not in the Source hash).
export const SERVER_CONTRACT = 'clued.drill.server/1';
export const SERVER_STAND_IN_CONTRACT = 'clued.drill.server-stand-in/1';
export const SERVER_FIELDS = Object.freeze(['record.publishableKey', 'record.supabaseUrl']);
const SERVER_URL = /^https:\/\/[a-z0-9]+\.supabase\.co$/;
export const SERVER_KEY = /^sb_publishable_[A-Za-z0-9_-]+$/;
const hostOf = url => new URL(url).hostname;
const hostList = v => Array.isArray(v) && v.every(h => typeof h === 'string' && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)) && new Set(v).size === v.length;
function checkedServer(s, { allowUnset = false } = {}) {
  check(s !== null && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).sort().join() === 'allowedHosts,blackholeHosts,contract,poolerHost,project,publishableKey,supabaseUrl' &&
    (s.poolerHost === null || (typeof s.poolerHost === 'string' && s.poolerHost.length <= 253)) &&
    s.contract === SERVER_CONTRACT && typeof s.project === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(s.project) &&
    typeof s.supabaseUrl === 'string' && SERVER_URL.test(s.supabaseUrl) && hostList(s.blackholeHosts) && hostList(s.allowedHosts) &&
    // a host is cut off or let through, never both; the drill's own server is never cut off
    !s.blackholeHosts.some(h => s.allowedHosts.includes(h)) && !s.blackholeHosts.includes(hostOf(s.supabaseUrl)), 'DRILL_SERVER_REFUSED');
  check(s.publishableKey !== null || allowUnset, 'DRILL_SERVER_PUBLISHABLE_KEY_NOT_SET');
  check(s.publishableKey === null || (typeof s.publishableKey === 'string' && SERVER_KEY.test(s.publishableKey)), 'DRILL_SERVER_REFUSED');
  return { contract: s.contract, project: s.project, supabaseUrl: s.supabaseUrl, publishableKey: s.publishableKey,
    blackholeHosts: [...s.blackholeHosts], allowedHosts: [...s.allowedHosts], poolerHost: s.poolerHost };
}
// Every host the package's archive names after "https://", in any entry (code, lists, comments alike; lower case, a port or a path is
// not part of it). What the package's own code reaches is what it names, whatever the record says: the node's service posts its renew
// probe to a constant, windows/SwapBroker.cs Route (review M1 of PR-3). An address put together at run time is not seen here.
export function hostsOfTar(tarBytes) {
  const hosts = new Set();
  for (const e of readTar(tarBytes)) for (const m of e.data.toString('latin1').matchAll(/https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)/gi)) hosts.add(m[1].toLowerCase());
  return [...hosts].sort();
}
// Each of them is cut off in the guest (blackholeHosts) or registered as not Clued's (allowedHosts; the drill's own server is the
// drill's), or there is no kit and no boot: a host nobody decided on is taken for production.
function assertTarHostsDecided(tarBytes, { blackholeHosts, allowedHosts, supabaseUrl }) {
  const undecided = hostsOfTar(tarBytes).filter(h => !blackholeHosts.includes(h) && !allowedHosts.includes(h) && h !== hostOf(supabaseUrl));
  check(undecided.length === 0, `DRILL_SERVER_PRODUCTION_HOST_NOT_CUT_OFF:${undecided.join(',')}`);
}
// The drill server's public key is not in the repository (FABLE-drill-test-project-sync-20261124.md section 3): its one source is the
// test project, and this host keeps the copy drill-vm.ps1 -ServerKey stored once the project answered it (drill-server-check.mjs
// storeServerKey). The copy names the project it is for: one stored for another project is not this server's key.
export const HOST_KEY_FILE = 'D:\\clued-drill\\drill-server.local.json';
export const SERVER_KEY_CONTRACT = 'clued.drill.server-key/1';
export const serverKeyRecord = (server, key) => ({ contract: SERVER_KEY_CONTRACT, project: server.project, supabaseUrl: server.supabaseUrl, publishableKey: key });
function hostKey(keyFile, server) {
  if (!fs.existsSync(keyFile)) return null;
  let k = null;
  try { k = JSON.parse(fs.readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '')); } catch { k = null; }
  check(k !== null && typeof k === 'object' && typeof k.publishableKey === 'string' && SERVER_KEY.test(k.publishableKey) &&
    JSON.stringify(k) === JSON.stringify(serverKeyRecord(server, k.publishableKey)), 'DRILL_SERVER_KEY_REFUSED');
  return k.publishableKey;
}
// The drill's server: drill-server.json (which carries no key: a file with one is refused) and the host's copy of the key.
// allowUnset: read it while the host has no copy yet (a kit is never made from such a reading); keyFile null: the file alone.
export function readDrillServer({ file = fileURLToPath(new URL('./drill-server.json', import.meta.url)), keyFile = HOST_KEY_FILE, allowUnset = false } = {}) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('DRILL_SERVER_REFUSED'); }
  check(s !== null && typeof s === 'object' && !Array.isArray(s) && !Object.hasOwn(s, 'publishableKey'), 'DRILL_SERVER_REFUSED');
  const named = checkedServer({ ...s, publishableKey: null }, { allowUnset: true });
  return checkedServer({ ...named, publishableKey: keyFile === null ? null : hostKey(keyFile, named) }, { allowUnset });
}
// Every leaf of a JSON value by its path (an empty object or array is a leaf too), for a comparison that sees every difference.
const leavesOf = (v, at = '') => v !== null && typeof v === 'object' && Object.keys(v).length > 0
  ? Object.entries(v).flatMap(([k, x]) => leavesOf(x, at ? `${at}.${k}` : k)) : [[at, JSON.stringify(v)]];
const recordOf = (bytes, code) => {
  let k;
  try { k = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(code); }
  const r = k?.record;
  check(r !== null && typeof r === 'object' && typeof r.supabaseUrl === 'string' && SERVER_URL.test(r.supabaseUrl) &&
    typeof r.publishableKey === 'string' && SERVER_KEY.test(r.publishableKey), code);
  return { kit: k, supabaseUrl: r.supabaseUrl, publishableKey: r.publishableKey };
};
// The drill's first-install kit against the Release's: another server address, and no difference but the two server fields. Returns them.
export function assertServerStandIn(releaseBytes, drillBytes) {
  const release = recordOf(releaseBytes, 'DRILL_SERVER_RELEASE_KIT_NAMES_NO_SERVER'), drill = recordOf(drillBytes, 'DRILL_SERVER_STAND_IN_REFUSED');
  check(hostOf(release.supabaseUrl) !== hostOf(drill.supabaseUrl), 'DRILL_SERVER_IS_PRODUCTION');
  const a = new Map(leavesOf(release.kit)), b = new Map(leavesOf(drill.kit));
  const differs = [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
  check(JSON.stringify(differs) === JSON.stringify(SERVER_FIELDS), `DRILL_SERVER_STAND_IN_DIFFERS:${differs.join(',')}`);
  return differs;
}
// The Release's first-install kit with the drill's server in place of its own.
export function drillFirstInstallKit(releaseBytes, server) {
  const { kit } = recordOf(releaseBytes, 'DRILL_SERVER_RELEASE_KIT_NAMES_NO_SERVER');
  kit.record.supabaseUrl = server.supabaseUrl; kit.record.publishableKey = server.publishableKey;
  const bytes = Buffer.from(JSON.stringify(kit, null, 2) + '\n');
  assertServerStandIn(releaseBytes, bytes);
  return bytes;
}
// The three stand-in files and the kit's record of them. `accepted`: the acceptance on the Release's own first-install kit (a candidate's
// drill-only one, candidateAcceptance; or the Owner's, of an accepted version). The stand-in acceptance is that one naming the drill's
// kit and the drill's reserved Decision and receipt (publish.mjs DRILL_RESERVED: for a candidate's they are there already), so it is
// refused wherever an Owner's acceptance is read (namesDrillReserved); every other field is the accepted one's, read by the guest as it is.
function serverStandIn({ from, version, server, accepted }) {
  const tag = `fleet-node-${version}`;
  const names = { firstInstallKit: `${tag}.first-install-kit.json`, firstInstallSums: `${tag}.first-install.SHA256SUMS`, acceptance: `${tag}.acceptance.json` };
  const releaseKit = read(from, names.firstInstallKit), drillKit = drillFirstInstallKit(releaseKit, server);
  const releaseSha = sha256(releaseKit), drillSha = sha256(drillKit);
  const releaseSums = read(from, names.firstInstallSums).toString();
  check(readSums(releaseSums).filter(f => f.name === names.firstInstallKit && f.sha256 === releaseSha).length === 1, 'DRILL_FIRST_SUMS_NOT_THE_KITS');
  const sumsBytes = Buffer.from(releaseSums.split(/(?<=\n)/)
    .map(line => (line.replace(/\r?\n$/, '') === `${releaseSha}  ${names.firstInstallKit}` ? line.replace(releaseSha, drillSha) : line)).join(''));
  check(accepted.firstInstallKitSha256 === releaseSha, 'DRILL_FIRST_INSTALL_KIT_NOT_ACCEPTED');
  const acceptance = { ...accepted, cluedDecision: DRILL_RESERVED.decision, acceptedAt: DRILL_RESERVED.acceptedAt,
    fleetRefs: { ...accepted.fleetRefs, installationReceiptRef: DRILL_RESERVED.receipt, ownerDecisionRef: DRILL_RESERVED.decision, ownerReceiptRef: DRILL_RESERVED.receipt },
    firstInstallKitSha256: drillSha };
  check(namesDrillReserved(acceptance), 'DRILL_ACCEPTANCE_STAND_IN_REFUSED');
  const release = recordOf(releaseKit, 'DRILL_SERVER_RELEASE_KIT_NAMES_NO_SERVER');
  // cut off in the guest: the Release record's database, and the service's other hosts (drill-server.json blackholeHosts)
  const blackholeHosts = [...new Set([hostOf(release.supabaseUrl), ...server.blackholeHosts])].sort(), allowedHosts = [...server.allowedHosts].sort();
  check(!allowedHosts.includes(hostOf(release.supabaseUrl)), 'DRILL_SERVER_REFUSED');
  assertTarHostsDecided(read(from, `${tag}.tar`), { blackholeHosts, allowedHosts, supabaseUrl: server.supabaseUrl });
  return { acceptance,
    payloads: { [names.firstInstallKit]: drillKit, [names.firstInstallSums]: sumsBytes, [names.acceptance]: Buffer.from(JSON.stringify(acceptance, null, 2) + '\n') },
    record: { contract: SERVER_STAND_IN_CONTRACT, project: server.project, supabaseUrl: server.supabaseUrl, replaced: [...SERVER_FIELDS],
      releaseFirstInstallKitSha256: releaseSha, firstInstallKitSha256: drillSha, files: names, blackholeHosts, allowedHosts } };
}
// A made kit's server stand-in against the Release directory it is run with, for drill-vm.ps1's gate before any boot
// (Assert-DrillServerReady; the kit's own files are already held to kit.json's hashes by Read-DrillKit): the Release's first-install kit
// is the one the stand-in was made from, the drill's differs from it in the two server fields only and names the kit's server, the
// production host is in the list the guest cuts off, every host the archive names is in that list or the registered one, the sums differ in the kit's line only, the acceptance names the drill's kit.
export function verifyKitServer({ kit, from, version }) {
  const s = JSON.parse(fs.readFileSync(path.join(kit, 'kit.json'), 'utf8')).server;
  check(s !== null && typeof s === 'object' && s.contract === SERVER_STAND_IN_CONTRACT, 'DRILL_KIT_SERVER_STAND_IN_MISSING');
  const tag = `fleet-node-${version}`;
  check(JSON.stringify(s.files) === JSON.stringify({ firstInstallKit: `${tag}.first-install-kit.json`, firstInstallSums: `${tag}.first-install.SHA256SUMS`, acceptance: `${tag}.acceptance.json` }) &&
    JSON.stringify(s.replaced) === JSON.stringify(SERVER_FIELDS) && hostList(s.blackholeHosts) && hostList(s.allowedHosts) &&
    !s.blackholeHosts.some(h => s.allowedHosts.includes(h)), 'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  const releaseKit = read(from, s.files.firstInstallKit), drillKit = read(kit, s.files.firstInstallKit);
  check(sha256(releaseKit) === s.releaseFirstInstallKitSha256, 'DRILL_KIT_SERVER_NOT_THIS_RELEASE');
  check(sha256(drillKit) === s.firstInstallKitSha256, 'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  assertServerStandIn(releaseKit, drillKit);
  const release = recordOf(releaseKit, 'DRILL_SERVER_RELEASE_KIT_NAMES_NO_SERVER'), drill = recordOf(drillKit, 'DRILL_SERVER_STAND_IN_REFUSED');
  check(drill.supabaseUrl === s.supabaseUrl && s.blackholeHosts.includes(hostOf(release.supabaseUrl)) && !s.blackholeHosts.includes(hostOf(drill.supabaseUrl)),
    'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  // the archive this run installs names no host but the kit's cut-off and registered ones (the rule the kit was made under, held again)
  assertTarHostsDecided(read(from, `${tag}.tar`), s);
  const others = text => readSums(text).map(f => (f.name === s.files.firstInstallKit ? { ...f, sha256: '' } : f));
  const releaseSums = read(from, s.files.firstInstallSums).toString(), drillSums = read(kit, s.files.firstInstallSums).toString();
  check(JSON.stringify(others(releaseSums)) === JSON.stringify(others(drillSums)) &&
    readSums(drillSums).some(f => f.name === s.files.firstInstallKit && f.sha256 === s.firstInstallKitSha256), 'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  const acceptance = JSON.parse(read(kit, s.files.acceptance).toString('utf8'));
  check(acceptance.firstInstallKitSha256 === s.firstInstallKitSha256 && namesDrillReserved(acceptance), 'DRILL_KIT_SERVER_STAND_IN_REFUSED');
  return { project: s.project, supabaseUrl: s.supabaseUrl, releaseFirstInstallKitSha256: s.releaseFirstInstallKitSha256, firstInstallKitSha256: s.firstInstallKitSha256,
    blackholeHosts: s.blackholeHosts };
}
// Registered as a stand-in (FIRST-INSTALL-KIT.md): the kit's per-node steps name it, so A10 never passes on a server that is not production's.
export const SERVER_STAND_IN_STEP = '服务端与 CI 令牌替身（kit 的两个公开字段换成测试项目，CI 令牌是 Owner 在测试项目签发的不带 ci-admission 角色的演练绑定，最长 90 天，到期重签；测试项目的库在每次开机前由宿主向生产已应用清单收敛（同步脚本，清单取自 main 上最近一次成功的发布运行），账户里的 parking 角色也由这次同步种，没有它服务端会放行任何绑定；替的是生产服务端与真节点的 CI 绑定；因为演练不得接触生产；因此没验到生产服务端对本包的应答与带角色节点的首班车；不可删，没验到的部分由真机首装承担）';

export function drillKitManifest({ payloads, prereqBytes, timeoutMinutes = 240, candidate = null, credentials = null, credentialFilesSha256 = null, server = null }) {
  check(Number.isInteger(timeoutMinutes) && timeoutMinutes >= 5 && timeoutMinutes <= 240, 'DRILL_KIT_TIMEOUT_REFUSED');
  const prereq = JSON.parse(prereqBytes.toString('utf8'));
  check(prereq.contract === 'clued.drill.prereq/1', 'DRILL_PREREQ_CONTRACT_REFUSED');
  const names = Object.keys(payloads).sort();
  check(names.includes('first-install-entry.ps1') && names.every(nameOK), 'DRILL_KIT_PAYLOAD_REFUSED');
  return { contract: 'clued.drill.first-install-kit/1',
    files: names.map(name => ({ path: name, sha256: sha256(payloads[name]) })),
    entry: { file: 'first-install-entry.ps1', arguments: ['-From', '{from}', '-Kit', '{kit}', '-Fake', '{fake}', '-Work', '{work}', '-Version', '{version}'] },
    // a stand-in step for every name the package names and the drill makes and hands over (the decision table), required or optional
    timeoutMinutes, perNodeSteps: ['未验证原入口的非提权检查', '绕过 RunAs 提权', '绕过凭据窗口', ...standInSteps(credentials), ...(server ? [SERVER_STAND_IN_STEP] : [])], prereqSha256: sha256(prereqBytes),
    // The real first-install host owns WSL import, Docker and accounts, from S0.
    prerequisiteMode: 'first-install-host', ...(candidate ? { candidate } : {}), ...(server ? { server } : {}), ...(credentials ? { credentials } : {}), ...(credentialFilesSha256 ? { credentialFilesSha256 } : {}) };
}

// The host tools the kit's acceptance pins for its roles (fleetRefs.formalRoles.<role>.hostTools.<name>: path and sha256, the source
// manifest's, which the worker holds per job and phase A of the first install holds the node to: HOST_TOOL_NOT_THE_FLEET_PIN), held
// before any boot to the .debs the kit stages (Fable ruling 0e418483, r7 phase B, 4.1 step 3): every staged .deb that carries the path
// carries it as a regular file with the pinned sha256, and at least one does; otherwise no kit. A walk of every role and tool, not python
// alone. An acceptance that pins no host tool has nothing here (phase A on the node is the check that counts).
const debUnreadable = name => new Error(`DRILL_KIT_DEB_UNREADABLE:${name}`);
// A .deb's data.tar, decompressed: an ar archive ("!<arch>\n", 60-byte member headers, members padded to even); Ubuntu's are zstd.
function debData(name, bytes) {
  if (bytes.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw debUnreadable(name);
  for (let i = 8; i + 60 <= bytes.length;) {
    const h = bytes.subarray(i, i + 60).toString('latin1'), member = h.slice(0, 16).trim().replace(/\/$/, ''), size = h.slice(48, 58).trim();
    if (h.slice(58, 60) !== '`\n' || !/^\d+$/.test(size) || i + 60 + Number(size) > bytes.length) throw debUnreadable(name);
    const n = Number(size), body = bytes.subarray(i + 60, i + 60 + n);
    if (member.startsWith('data.tar')) {
      if (member !== 'data.tar.zst') throw debUnreadable(name);
      try { return zlib.zstdDecompressSync(body); } catch { throw debUnreadable(name); }
    }
    i += 60 + n + (n & 1);
  }
  throw debUnreadable(name);
}
// The entries of a data.tar whose path (without "./" or "/") is in `wanted`: { path, regular, data }. dpkg's tars are GNU or POSIX: a
// GNU long name (L) or a pax path names the next entry (a long link name, K, and global pax records are skipped); a POSIX ustar header
// joins its prefix.
function tarEntries(name, tar, wanted) {
  const out = []; let next = null;
  const text = (h, o, n) => { const s = h.subarray(o, o + n), z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('utf8'); };
  for (let i = 0; i + 512 <= tar.length;) {
    const h = tar.subarray(i, i + 512);
    if (h.every(b => b === 0)) break;
    let size = 0;
    if (h[124] & 0x80) for (let k = 125; k < 136; k++) size = size * 256 + h[k];
    else { const s = text(h, 124, 12).trim(); if (!/^[0-7]*$/.test(s)) throw debUnreadable(name); size = s ? parseInt(s, 8) : 0; }
    const start = i + 512, type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    if (!Number.isSafeInteger(size) || start + size > tar.length) throw debUnreadable(name);
    const data = tar.subarray(start, start + size);
    if (type === 'L') next = text(data, 0, data.length);
    else if (type === 'x') {
      for (const rec of data.toString('utf8').split('\n')) { const m = /^\d+ path=(.*)$/.exec(rec); if (m) next = m[1]; }
    } else if (type !== 'g' && type !== 'K') {
      const ustar = h.subarray(257, 263).toString('latin1') === 'ustar\0' ? text(h, 345, 155) : '';
      const p = (next ?? (ustar ? `${ustar}/${text(h, 0, 100)}` : text(h, 0, 100))).replace(/^\.?\//, '');
      next = null;
      if (wanted.has(p)) out.push({ path: p, regular: type === '0' || type === '7', data });
    }
    i = start + Math.ceil(size / 512) * 512;
  }
  return out;
}
export function kitHostTools(acceptance, debs) {
  const tools = [];
  for (const [role, r] of Object.entries(acceptance?.fleetRefs?.formalRoles ?? {})) {
    for (const [tool, t] of Object.entries(r?.hostTools ?? {})) {
      check(typeof t?.path === 'string' && /^(\/[A-Za-z0-9._+-]+)+$/.test(t.path) && !t.path.split('/').some(s => s === '.' || s === '..') &&
        typeof t?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(t.sha256), `DRILL_KIT_HOST_TOOL_REFUSED:${role}.${tool}`);
      tools.push(t);
    }
  }
  if (tools.length === 0) return [];
  const wanted = new Set(tools.map(t => t.path.slice(1))), hits = [];
  for (const d of debs) for (const e of tarEntries(d.name, debData(d.name, d.bytes), wanted)) hits.push({ deb: d.name, ...e });
  return tools.map(t => {
    const of = hits.filter(h => h.path === t.path.slice(1));
    check(of.length > 0, `DRILL_KIT_HOST_TOOL_NOT_IN_THE_DEBS:${t.path}`);
    check(of.every(h => h.regular && sha256(h.data) === t.sha256), `DRILL_KIT_HOST_TOOL_NOT_THE_FLEET_PIN:${t.path}`);
    return { path: t.path, sha256: t.sha256, debs: [...new Set(of.map(h => h.deb))] };
  });
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

// What the kit carries from this directory: the entry, and the list of guest files its failure snapshot may read.
export const KIT_DRILL_FILES = ['first-install-entry.ps1', 'guest-failure-files.json'];

// `request`: a candidate's acceptance request (publish.mjs prepare's --out); required for a candidate, refused for an accepted version.
// `server`: the drill's server (default: drill-server.json, the one source; tests give their own).
export async function makeDrillKit({ from, version, prereq, out, request, timeoutMinutes = 240, now = Date.now(), server }) {
  const { candidate: isCandidate, ...pins } = releasePins(from, version);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const payloads = Object.fromEntries(KIT_DRILL_FILES.map(name => [name, read(here, name)]));
  let candidate = null;
  check(isCandidate || !request, 'DRILL_REQUEST_FOR_AN_ACCEPTED_VERSION');
  // What was accepted (a candidate: what the Owner is asked to accept, with the drill's stand-ins), on the Release's own first-install kit;
  // the kit's acceptance is that with the drill's first-install kit in its place (serverStandIn), for the guest only.
  const accepted = isCandidate ? candidateAcceptance({ from, version, request, now }) : JSON.parse(read(from, `fleet-node-${version}.acceptance.json`).toString('utf8'));
  server = server === undefined ? readDrillServer() : checkedServer(server);
  const standIn = serverStandIn({ from, version, server, accepted });
  const acceptance = standIn.acceptance;
  Object.assign(payloads, standIn.payloads);
  const replaced = new Set(Object.keys(standIn.payloads));
  pins.files = [...pins.files.filter(f => !replaced.has(f.path)), ...Object.entries(standIn.payloads).map(([name, bytes]) => ({ path: name, sha256: sha256(bytes) }))]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // a candidate's three hashes are the Release's (what the Owner accepts and seal compares): its first-install kit is the Release's own
  if (isCandidate) candidate = { acceptance: standIn.record.files.acceptance, tarSha256: accepted.archive_sha256, ciSourceManifestSha256: accepted.ciSourceManifestSha256,
    firstInstallKitSha256: accepted.firstInstallKitSha256 };
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
  const hostTools = kitHostTools(acceptance, (p.debs ?? []).map(item => { const name = path.win32.basename(item.path); return { name, bytes: payloads[name] }; }));
  const manifest = drillKitManifest({ payloads, prereqBytes, timeoutMinutes, candidate, credentials, credentialFilesSha256, server: standIn.record });
  fs.mkdirSync(out); // refuse an existing target, including a previous kit
  for (const [name, bytes] of Object.entries(payloads)) fs.writeFileSync(path.join(out, name), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'kit.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { kit: path.resolve(out), version, files: manifest.files.length, perNodeSteps: manifest.perNodeSteps, candidate, hostTools, server: standIn.record };
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
    const { values } = parseArgs({ options: Object.fromEntries(['from', 'version', 'prereq', 'out', 'request', 'build', 'final', 'images', 'credentials-of', 'server-of'].map(n => [n, { type: 'string' }])) });
    // --credentials-of <tar>: the package's credential list and its bytes' hash, for drill-vm.ps1's gate (Assert-DrillKitCredentialsBound)
    if (values['credentials-of']) console.log(JSON.stringify(credentialsOfTar(fs.readFileSync(values['credentials-of']))));
    // --server-of <kit> --from <release-dir> --version <v>: the kit's server stand-in against that Release (Assert-DrillServerReady)
    else if (values['server-of']) console.log(JSON.stringify(verifyKitServer({ kit: values['server-of'], from: values.from, version: values.version })));
    else {
      check(values.version && values.out, 'USAGE: --version <v> --out <new-dir> (--from <release-dir> --prereq <prereq.json> [--request <fleet-node-<v>.acceptance-request.json>: a candidate] | --build <dir> --final <dir> --images <dir>) | --credentials-of <tar>');
      console.log(JSON.stringify(values.build ? prepareFrom(values) : await makeDrillKit(values)));
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
