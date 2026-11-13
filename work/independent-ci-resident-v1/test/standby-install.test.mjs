// Primary/standby C7 (Task 088ab175, DESIGN.md section 30): a new node is installed as STANDBY.
// Design v0.4 section 7.2: the new connection is NOT marked with the ci-admission role; after the install the role probe answers
// "not held" and nothing is published. The install assumes no role (C3 makes the executor start UNCERTAIN until a probe says held).
// Offline: a company fixture node, a package built from its really assembled record, a made-up token in a temporary secrets folder,
// the real role-probe entry over a fake Native endpoint that records every request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildPackage } from '../tools/build-package.mjs';
import { nodeIdentityOf, nodeIdentitySha256 } from '../src/node-identity.mjs';
import { fingerprintCiToken } from '../tools/secret-fingerprint.mjs';
import { ROLE_PROBE_CODES } from '../src/role-probe.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';
import { tempRoot } from './helpers.mjs';
// Test-only use of Source v2 (the resident never imports it).
import { fixtureRecord, nodeProfile } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { writeRecord } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { probeRole } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/role-probe-entry.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CI = path.resolve(HERE, '..', 'actions-hosted-migration', 'independent-ci-v1');
const read = file => fs.readFile(file, 'utf8');
const codeOf = text => text.split(/\r?\n/).filter(l => !/^\s*(#|<#|\.[A-Z]|\*)/.test(l)).join('\n');

const company = nodeProfile({ nodeName: 'company', hostname: 'COMPANY-PC', mutationMutex: 'Global\\CluedControlControllerMutationV1-COMPANY-PC-1015',
  runnerService: 'actions.runner.tdoljyj-cross-memory-system.clued-ci-node-a', wslDistribution: 'Ubuntu-24.04' });

async function companyInstall(t) {
  const root = await tempRoot(t);
  const token = 'clued_bnd_' + randomBytes(24).toString('base64url');
  const fx = fixtureRecord({ node: company, ciTokenPinSha256: fingerprintCiToken(token) });
  const record = path.join(root, 'record');
  writeRecord(record, { files: fx.files, recordManifest: fx.recordManifest });
  const policyInput = JSON.parse(await read(path.join(HERE, 'config', 'policy.example.json')));
  policyInput.node = company; policyInput.nodeProfileSha256 = nodeProfileSha256(company);
  policyInput.companion.userSid = company.ownerSid; policyInput.linux.distribution = company.wslDistribution;
  const companionInput = JSON.parse(await read(path.join(HERE, 'config', 'companion.example.json')));
  Object.assign(companionInput.companion, { node: company, nodeProfileSha256: nodeProfileSha256(company), distribution: company.wslDistribution });
  const nodeExe = path.join(root, 'node.exe'); await fs.writeFile(nodeExe, 'not really node');
  const policyFile = path.join(root, 'policy.json'), companionFile = path.join(root, 'companion.json');
  await fs.writeFile(policyFile, JSON.stringify(policyInput)); await fs.writeFile(companionFile, JSON.stringify(companionInput));
  const out = path.join(root, 'pkg');
  const built = await buildPackage({ out, policyFile, companionFile, nodeExe, recordDir: record });
  // What the install's 'node-secrets' step leaves behind, in a stand-in for C:\ProgramData\CluedIndependentCI\secrets.
  const secrets = path.join(root, 'secrets'); await fs.mkdir(secrets);
  const tokenFile = path.join(secrets, 'ci-admission.token'); await fs.writeFile(tokenFile, token + '\n');
  return { root, out, built, fx, token, tokenFile };
}

test('the package pins the company node identity, derived from its own record files', async t => {
  const { out, built, fx } = await companyInstall(t);
  const identity = nodeIdentityOf(JSON.parse(fx.files['installation.json']), JSON.parse(fx.files['acceptance.json']), fx.recordManifest.acceptanceSha256);
  assert.equal(identity.nodeName, 'company');
  assert.equal(built.nodeName, 'company');
  assert.equal(built.nodeIdentitySha256, nodeIdentitySha256(identity));
  const pkg = JSON.parse(await read(path.join(out, 'package-manifest.json')));
  assert.equal(pkg.nodeIdentitySha256, nodeIdentitySha256(identity), 'the reviewed manifest carries the hash the install derives again');
  assert.equal(identity.ciTokenPinSha256, fx.inputs.ciTokenPinSha256);
});

test('a STANDBY install carries no state, no role and no publishing path; the role probe says "not held" and nothing is published', async t => {
  const { out, fx, token, tokenFile } = await companyInstall(t);
  const pkg = JSON.parse(await read(path.join(out, 'package-manifest.json')));
  // 1. The package puts programs, configuration and the install record in place. It brings no trigger, ledger, request or state.
  for (const f of pkg.files) assert.match(f.target, /^(?:resident|source|config|runtime|bin|helpers|record|upgrader)\\/, f.target);   // upgrader\: package /4 (018da927)
  assert.equal(pkg.files.some(f => /(^|\\)(state|inbox|requests|outbox|mailbox|stage|work)\\/.test(f.target)), false);
  // 2. No role anywhere in what is installed: not in the configuration, not in the node identity, not in the install's plan or receipt text.
  const forbidden = /^(nodeMode|nodeRole|activeNode|standby|active|holdsRole|holdsCiAdmission|roleHeld)$/i;
  const keys = (v, acc = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.push(k); keys(x, acc); } return acc; };
  for (const name of ['policy.json', 'companion.json']) assert.deepEqual(keys(JSON.parse(await read(path.join(out, 'config', name)))).filter(k => forbidden.test(k)), [], name);
  const installText = await read(path.join(HERE, 'windows', 'install-resident.ps1')), verifyText = await read(path.join(HERE, 'windows', 'verify-resident.ps1'));
  assert.equal(installText.match(/roleAssumption = 'NONE'/g)?.length, 1, 'the plan says: no role assumed');
  assert.match(installText, /roleAssumption = \$plan\.roleAssumption/, 'the receipt repeats it');
  assert.match(verifyText, /\(Get-Field \$receipt 'roleAssumption'\) -cne 'NONE'/, 'verify refuses a receipt that assumed one');
  // 3. The install talks to no service: nothing in its code reaches GitHub, KooYomi or any network.
  for (const text of [installText, verifyText]) {
    assert.doesNotMatch(codeOf(text), /Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|HttpClient|WebRequest|api\.github\.com|supabase|Test-NetConnection|\bcurl\b|\bwget\b/i);
    // M5 (ADR 0022 §4.4): install and verify name gh's install directory and the companion's own gh folder (the launch file's PATH,
    // GH_CONFIG_DIR and HOME), but never run gh: no gh command and no call of a gh executable.
    assert.doesNotMatch(codeOf(text), /\bgh(?:\.exe)?['"]?\s+(?:api|auth|repo|pr|run|workflow|release|issue|secret|status)\b|&\s*\$ghExe\b|Start-Process[^\n]*\bgh\b/i);
  }
  // 4. After the install the role probe reads the token from the file the install placed and sends the one read RPC.
  const record = { accepted: JSON.parse(fx.files['acceptance.json']), config: JSON.parse(fx.files['installation.json']) };
  const probe = async answer => {
    const calls = [], reads = [];
    const result = await probeRole({ record, live() {}, protect: async () => {}, tokenReader: async (file, options) => { reads.push({ file, options }); return read(tokenFile); },
      fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify(answer), { status: 200 }); } });
    return { result, calls, reads };
  };
  // The new connection is not marked with the role: the service answers admission_binding_required.
  const standby = await probe({ status: 'ok', repository: record.config.repository, reason: 'admission_binding_required', holders: [] });
  assert.deepEqual(standby.result, { status: 'BLOCKED', reason: ROLE_PROBE_CODES['not-held'], sideEffects: 0 });
  assert.equal(standby.calls.length, 1);
  assert.equal(standby.calls[0].url, `${record.config.supabaseUrl}/rest/v1/rpc/clued_work_merge_slot_holders_v1`);
  assert.equal(standby.calls[0].options.redirect, 'error');
  assert.equal(standby.reads.length, 1, 'only the token is read, never the App key');
  assert.match(standby.reads[0].file, /ci-admission\.token$/);
  assert.equal(standby.reads[0].options.controllerSid, company.controllerSid);
  assert.equal(JSON.stringify(standby.calls).includes(token), false, 'the token itself is never sent, only its hash');
  assert.equal(standby.calls.every(c => new URL(c.url).hostname === new URL(record.config.supabaseUrl).hostname && new URL(c.url).pathname === '/rest/v1/rpc/clued_work_merge_slot_holders_v1'), true, 'the one read RPC; no GitHub request, no publication');
  // The very same install, once the Owner marks the connection on the service, probes as held: the role is the service's, not the install's.
  const held = await probe({ status: 'ok', repository: record.config.repository, holders: [] });
  assert.equal(held.result.reason, ROLE_PROBE_CODES.held);
});

test('the secret targets the install writes are the paths the runtime reads', async () => {
  const installText = await read(path.join(HERE, 'windows', 'install-resident.ps1'));
  const protectedFiles = await read(path.join(CI, 'runtime', 'protected-files.mjs'));
  const entryRuntime = await read(path.join(CI, 'src', 'resident-v2', 'entry-runtime.mjs'));
  const roleProbeEntry = await read(path.join(CI, 'src', 'resident-v2', 'role-probe-entry.mjs'));
  const appKey = 'C:\\ProgramData\\CluedControl\\trusted\\controller-checks-app.pem';
  assert.ok(protectedFiles.includes(appKey.replaceAll('\\', '\\\\')), 'APP_KEY_FILE');
  assert.ok(installText.includes(`appKey = '${appKey}'`));
  assert.ok(installText.includes(`ciToken = 'C:\\ProgramData\\CluedIndependentCI\\secrets\\ci-admission.token'`));
  assert.match(entryRuntime, /path\.join\(INSTALL_ROOT, 'secrets', 'ci-admission\.token'\)/);
  assert.match(roleProbeEntry, /path\.join\(WIN_ROOT, 'secrets', 'ci-admission\.token'\)/);
  assert.match(protectedFiles, /INSTALL_ROOT = process\.platform === 'win32' \? 'C:\\\\ProgramData\\\\CluedIndependentCI'/);
});
