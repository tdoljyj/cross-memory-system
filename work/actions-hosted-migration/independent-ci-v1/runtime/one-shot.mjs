// One installed job/result -> one independently verified check publication.
// No scheduler, fixture fallback, worker launch, dynamic plugin or qualification issuer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitHubChecksPort } from '../src/github.mjs';
import { createFullAdmissionPort } from '../src/full-admission.mjs';
import { createStagedCheckPublisher } from '../src/staged-check-publisher.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { canonical, digest, subjectOf, verifyResult } from '../src/proof.mjs';
import { validateJob } from '../src/queue.mjs';

// Every Source file the v1 one-shot loads must be an accepted pin: the static import closure of this module (static
// imports and module-relative `new URL(...)` file references, transitively: full-admission.mjs -> queue-facts.mjs and the evaluator with its scripts/ci
// modules and source catalogues), plus the ACL verifier it runs. The evaluator's dynamic imports (the control-check
// consumers) run only under CLUED_EXECUTION_PROVIDER, never in the one-shot. pr-a-review.test.mjs recomputes this
// closure, so an import added without a pin fails offline (PR-A round-3 review).
export const V1_REQUIRED_SOURCE = Object.freeze([...['runtime/one-shot.mjs', 'runtime/verify-install-acl.ps1', 'src/github.mjs', 'src/full-admission.mjs',
  'src/staged-check-publisher.mjs', 'src/proof.mjs', 'src/effect-journal.mjs', 'src/queue.mjs', 'src/independent-control-checks-v1/queue-facts.mjs'].map(p => 'work/actions-hosted-migration/independent-ci-v1/' + p),
  ...['clued-work-admission.mjs', 'clued-pr-task-binding.mjs', 'clued-pr-write-set.mjs', 'component-version-integration-policy.mjs', 'clued-control-workflow-source.mjs', 'clued-control-workflow-sources.json', 'clued-production-publisher-source.mjs',
    'clued-production-publisher-sources.json', 'clued-publisher-qualification-source.mjs', 'clued-publisher-qualification-sources.json',
    'clued-standard-runner-actor-source.mjs', 'clued-standard-runner-actor-sources.json', 'clued-workflow-profile.mjs', 'merge-admission-measurement-history.mjs', 'merge-admission-policy.mjs', 'merge-admission-source-producer.mjs'].map(p => 'scripts/ci/' + p),
  'scripts/runner/clued-runner-job-started.mjs', 'config/clued-mechanical-files.json',
  // Fable 11-20 (单一判定): the gate imports the one failure rule from the companion's module.
  'work/independent-ci-resident-v1/src/env-failure.mjs'].sort());
export const INSTALL_ROOT = process.platform === 'win32' ? 'C:\\ProgramData\\CluedIndependentCI' : '/etc/clued-independent-ci';
export const APP_KEY_FILE = process.platform === 'win32' ? 'C:\\ProgramData\\CluedControl\\trusted\\controller-checks-app.pem' : '/etc/clued-control/trusted/controller-checks-app.pem';
const SOURCE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO = 'tdoljyj/cross-memory-system';
const REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'];
const INSTALL_REFS = [...REFS, 'ownerPackageAcceptanceRef', 'installationReceiptRef'];
const HASH = /^[a-f0-9]{64}$/;
const stop = code => { throw Object.assign(new Error(code), { code }); };
const safe = error => /^[a-z][a-z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'runtime_operation_unconfirmed';
export const ciBindingPin = token => digest('clued.independent-ci.ci-binding-pin/1\0' + token);
export const appPublicFingerprint = key => createHash('sha256').update(createPublicKey(key).export({ format: 'der', type: 'spki' })).digest('base64');
export const installationConfigPin = config => digest({ ...config, acceptanceSha256: null });
const legacyPin = value => value && typeof value === 'object' && (Object.hasOwn(value, 'ciTokenSha256') || Object.values(value).some(legacyPin));
const leaf = (root, name) => path.join(root, ...name.split('/'));
const regular = async file => { const stat = await fsp.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) stop('unsafe_installation_file'); return stat; };
async function read(file, { secret = false, secretRoot = null } = {}) {
  if (secret && process.platform === 'win32') {
    try {
      const { stdout } = await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./verify-install-acl.ps1', import.meta.url)),
          '-LiteralTarget', file, '-ReadFile', '-SecretRoot', secretRoot, '-ProtectedRoot', path.dirname(secretRoot)],
        { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      return Buffer.from(stdout.trim(), 'base64').toString('utf8');
    } catch { stop('secret_file_boundary_unconfirmed'); }
  }
  await regular(file);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) stop('unsafe_installation_file');
    if (secret && (stat.uid !== 0 || stat.mode & 0o077)) stop('secret_file_boundary_unconfirmed');
    const same = actual => actual.dev === stat.dev && actual.ino === stat.ino && actual.birthtimeMs === stat.birthtimeMs;
    if (!same(await regular(file))) stop('installation_file_replaced');
    const bytes = await handle.readFile('utf8');
    if (!same(await regular(file))) stop('installation_file_replaced');
    return bytes;
  } finally { await handle.close(); }
}
async function json(file) { try { return JSON.parse(await read(file)); } catch { stop('installation_file_unreadable'); } }

async function protectedPaths(root, files, state = false) {
  const checked = new Set();
  for (const file of [root, ...files]) {
    for (let cursor = file; ; cursor = path.dirname(cursor)) {
      if ((await fsp.lstat(cursor)).isSymbolicLink()) stop('installation_link_refused');
      checked.add(cursor);
      if (cursor === path.dirname(cursor)) break;
    }
  }
  if (process.platform === 'win32') {
    const script = fileURLToPath(new URL('./verify-install-acl.ps1', import.meta.url));
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    // The helper checks and holds every ancestor, including intermediate dirs.
    for (const target of [root, ...files]) {
      const boundary = target === APP_KEY_FILE ? path.dirname(path.dirname(APP_KEY_FILE)) : root;
      try { await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', script, '-LiteralTarget', target, '-ProtectedRoot', boundary,
        ...(state ? ['-AllowControllerWrite'] : [])], { windowsHide: true, timeout: 10000, maxBuffer: 4096 }); }
      catch { stop('installation_acl_unqualified'); }
    }
  } else {
    for (const target of checked) {
      const stat = await fsp.lstat(target);
      if (stat.uid !== 0 && !(state && stat.uid === process.getuid()) || stat.mode & 0o022) stop('installation_acl_unqualified');
    }
  }
}

async function acceptedInstallation(root, config, now) {
  const required = ['acceptance.json', 'source-manifest.json', 'signers.json', 'inbox/job.json', 'inbox/result.json'];
  await protectedPaths(root, [leaf(root, 'installation.json'), ...required.map(name => leaf(root, name))]);
  if (digest(await json(leaf(root, 'installation.json'))) !== digest(config)) stop('installation_configuration_changed');
  const acceptanceBytes = await read(leaf(root, 'acceptance.json'));
  const accepted = JSON.parse(acceptanceBytes);
  if (legacyPin(config) || legacyPin(accepted)) stop('replayable_credential_pin_refused');
  if (digest(acceptanceBytes) !== config.acceptanceSha256) stop('accepted_installation_changed');
  if (accepted.contract !== 'clued.independent-ci.accepted-installation/1' || accepted.domain !== 'production'
    || accepted.accepted !== true || accepted.configSha256 !== installationConfigPin(config) || accepted.repository !== REPO
    // Windows reports the DNS host name (e.g. "Turing") while the accepted record
    // carries the NetBIOS form ("TURING"); compare like bridge boundary.mjs:90.
    || !/^[A-Za-z0-9-]+$/.test(accepted.hostname ?? '') || accepted.hostname.toLowerCase() !== os.hostname().toLowerCase() || accepted.platform !== process.platform || accepted.arch !== process.arch
    || accepted.controllerAccount !== os.userInfo().username || accepted.workerCannotReadController !== true
    || !(Date.parse(accepted.expiresAt) > now) || !(Date.parse(accepted.acceptedAt) <= now)
    || !INSTALL_REFS.every(ref => typeof accepted[ref] === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(accepted[ref]))
    || accepted.ciPrincipalBindingId !== config.ciPrincipalBindingId || accepted.ciPrincipalQualificationRef !== config.ciPrincipalQualificationRef
    || !HASH.test(accepted.ciTokenPinSha256 ?? '') || accepted.ciTokenPinSha256 !== config.ciTokenPinSha256
    || !/^[A-Za-z0-9+/]{43}=$/.test(accepted.appPublicKeySha256Base64 ?? '')
    || accepted.appPublicKeySha256Base64 !== config.appPublicKeySha256Base64
    || !Array.isArray(accepted.sourceFiles) || accepted.sourceFiles.length < 8 || accepted.sourceFiles.length > 10000) stop('accepted_installation_missing');
  const pins = new Map();
  for (const pin of accepted.sourceFiles) {
    if (!pin || !HASH.test(pin.sha256 ?? '') || typeof pin.path !== 'string' || pin.path.startsWith('/')
      || /[\\:\x00-\x1f]/.test(pin.path) || pin.path.split('/').some(part => !part || part === '.' || part === '..')
      || pins.has(pin.path)) stop('accepted_source_invalid');
    pins.set(pin.path, pin.sha256);
    const filename = leaf(SOURCE_ROOT, pin.path); await protectedPaths(SOURCE_ROOT, [filename]);
    if (digest(await read(filename)) !== pin.sha256) stop('accepted_source_changed');
  }
  for (const name of V1_REQUIRED_SOURCE) {
    if (!pins.has(name)) stop('accepted_source_incomplete');
  }
  for (const filename of ['scripts/ci/clued-work-admission.mjs', 'config/merge-admission-policy.json']) if (!pins.has(filename)) stop('accepted_source_incomplete');
  if (pins.get('scripts/ci/clued-work-admission.mjs') !== config.evaluatorSha256
    || pins.get('config/merge-admission-policy.json') !== config.policySha256) stop('accepted_source_changed');
  const manifestBytes = await read(leaf(root, 'source-manifest.json'));
  if (digest(manifestBytes) !== config.sourceManifestSha256) stop('source_manifest_changed');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.repo !== REPO || !manifest.roles || Object.keys(config.checks).some(role => !Object.hasOwn(manifest.roles, role))) stop('source_manifest_changed');
  const signerFile = await json(leaf(root, 'signers.json'));
  if (digest(signerFile) !== accepted.signerRegistrySha256 || !Array.isArray(signerFile.signers)) stop('accepted_signers_missing');
  const signers = new Map();
  for (const signer of signerFile.signers) {
    if (signer.domain !== 'production' || signers.has(signer.keyId) || signer.sourceAcceptanceRef !== accepted.sourceAcceptanceRef
      || signer.qualificationRef !== accepted.hostQualificationRef) stop('accepted_signers_missing');
    signers.set(signer.keyId, signer);
  }
  if (!signers.size) stop('accepted_signers_missing');
  return { accepted, signers };
}

// This function reads fixed public installation inputs only. It never reads
// private-key/Binding contents and never contacts GitHub or Native.
export async function inspectReadiness({ root = INSTALL_ROOT, now = Date.now() } = {}) {
  const missing = [], configurationFile = leaf(root, 'installation.json');
  let config;
  try { config = await json(configurationFile); } catch { return { status: 'BLOCKED', missing: ['fixed_installation_config'] }; }
  if (config.contract !== 'clued.independent-ci.one-shot/1' || config.enabled !== true) missing.push('installation_enabled');
  if (legacyPin(config)) missing.push('replayable_credential_pin_refused');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(config.appPublicKeySha256Base64 ?? '')) missing.push('github_der_spki_fingerprint');
  if (config.repository !== REPO || config.appId !== 5368905 || config.installationId !== 172706661 || config.repositoryId !== 1334673495) missing.push('fixed_repository_app_identity');
  for (const key of ['acceptanceSha256', 'ciTokenPinSha256', 'sourceManifestSha256', 'evaluatorSha256', 'policySha256']) if (!HASH.test(config[key] ?? '')) missing.push(key);
  if (!(config.scope === 'global' || /^project:[a-f0-9-]{36}$/.test(config.scope)) || !config.ciPrincipalBindingId || !config.ciPrincipalQualificationRef) missing.push('designated_ci_admission_binding');
  if (!config.supabaseUrl || !config.publishableKey) missing.push('native_public_configuration');
  const requiredCheckRoles={'gitleaks':'gitleaks','trivy':'trivy','work-admission':'kooyumi-work-admission','contract-placement':'contract-placement','control-admission':'kooyumi-admission-verified','control-merge-slot':'kooyumi-merge-slot'};
  if(!config.checks||Object.keys(config.checks).sort().join('|')!==Object.keys(requiredCheckRoles).sort().join('|')||Object.entries(requiredCheckRoles).some(([role,name])=>config.checks[role]?.name!==name||config.checks[role]?.appId!==5368905))missing.push('six_exact_accepted_check_roles');
  for (const name of ['acceptance.json', 'source-manifest.json', 'signers.json', 'inbox/job.json', 'inbox/result.json', 'secrets/ci-admission.token']) {
    try { await regular(leaf(root, name)); } catch { missing.push(name); }
  }
  try { await regular(APP_KEY_FILE); } catch { missing.push('fixed_controller_checks_app_key'); }
  if (missing.length) return { status: 'BLOCKED', missing };
  try {
    // Inspect the real installed module surface before any private read. This
    // inert constructor never invokes its credential provider or transport.
    const capabilities = createGitHubChecksPort({ repository: REPO, repositoryId: config.repositoryId,
      appId: config.appId, installationId: config.installationId, includeModeRead: true,
      privateKeyProvider: async () => { stop('readiness_never_reads_credentials'); } });
    if (typeof capabilities.getInstallationToken !== 'function' || typeof capabilities.readAdmissionMode !== 'function') stop('github_mode_adapter_unavailable');
    const { accepted, signers } = await acceptedInstallation(root, config, now);
    const job = await json(leaf(root, 'inbox/job.json')), envelope = await json(leaf(root, 'inbox/result.json'));
    validateJob(job);
    if (job.repo !== REPO || job.sourceManifestSha256 !== config.sourceManifestSha256 || !Object.hasOwn(config.checks, job.role)) stop('job_not_installed');
    verifyResult({ job, envelope, signers, domain: 'production', now });
    return { status: 'READY', root, config, accepted, signers, job, envelope };
  } catch (error) { return { status: 'BLOCKED', missing: [safe(error)] }; }
}

async function runOnce(ready) {
  const { root, config, accepted, signers, job, envelope } = ready;
  const state = leaf(root, 'state'); await protectedPaths(state, [], true);
  const lock = leaf(state, 'one-shot.lock'); let lockHandle;
  try { lockHandle = await fsp.open(lock, 'wx', 0o600); } catch { stop('one_shot_lock_requires_reconciliation'); }
  let log;
  try {
    await lockHandle.writeFile(canonical({ pid: process.pid, jobId: job.id, startedAt: new Date().toISOString() })); await lockHandle.sync();
    const keyFile = APP_KEY_FILE, nativeFile = leaf(root, 'secrets/ci-admission.token');
    await protectedPaths(root, [keyFile, nativeFile]);
    // The only private reads are here, after readiness and explicit --run.
    const appKey = await read(keyFile, { secret: true, secretRoot: path.dirname(APP_KEY_FILE) });
    const nativeToken = (await read(nativeFile, { secret: true, secretRoot: leaf(root, 'secrets') })).trim();
    if (!/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(nativeToken) || ciBindingPin(nativeToken) !== accepted.ciTokenPinSha256
      || appPublicFingerprint(appKey) !== accepted.appPublicKeySha256Base64) stop('installed_principal_fingerprint_changed');
    const github = createGitHubChecksPort({ repository: REPO, repositoryId: config.repositoryId, appId: config.appId,
      installationId: config.installationId, includeModeRead: true, privateKeyProvider: async () => appKey });
    if (typeof github.getInstallationToken !== 'function' || typeof github.readAdmissionMode !== 'function') stop('github_mode_adapter_unavailable');
    const journal = await EffectJournal.open(leaf(state, 'effects'));
    const logPath = leaf(state, 'source-observations.jsonl');
    try { await regular(logPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    log = fs.openSync(logPath, 'a', 0o600);
    const record = (kind, data) => {
      const bytes = Buffer.from(canonical({ contract: 'clued.independent-ci.source-observation/1', id: randomUUID(), kind,
        observedAt: new Date().toISOString(), jobId: job.id, dataSha256: digest(data) }) + '\n');
      if (fs.writeSync(log, bytes) !== bytes.length) stop('source_log_append_unconfirmed'); fs.fsyncSync(log);
    };
    const full = createFullAdmissionPort({ protectedConfig: { ...config, domain: 'production', workspace: SOURCE_ROOT,
      policyText: await read(leaf(SOURCE_ROOT, 'config/merge-admission-policy.json')) },
      tokenProvider: async () => ({ githubToken: await github.getInstallationToken(), ciAdmissionToken: nativeToken,
        ciPrincipalBindingId: config.ciPrincipalBindingId, ciPrincipalQualificationRef: config.ciPrincipalQualificationRef }),
      modeProvider: () => github.readAdmissionMode(), recorderProvider: async () => ({ domain: 'production', kind: 'independent-controller',
        observedAt: new Date().toISOString(), observationRef: randomUUID(), recorder: { newId: randomUUID, record } }) });
    const authority = { async observe(subject) {
      // Re-check installed acceptance, then read the actual claim without PR
      // binding/metering. Only the full evaluator may perform the PR door.
      await acceptedInstallation(root, config, Date.now());
      const packet = await github.readChangedPaths(subject);
      let response, body;
      try {
        response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/clued_work_verify_v1`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { apikey: config.publishableKey,
            authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { scope: config.scope, claim_id: subject.claimId, changed_paths: packet.paths } }) });
        body = await response.json();
      } catch { stop('native_claim_observation_unconfirmed'); }
      const claim = body?.claim;
      if (response.status !== 200 || body.status !== 'ok' || body.verdict !== 'ADMITTED' || body.execution_policy !== 'staged'
        || claim?.lease_key_required !== false || claim.execution_handover_pending !== false || claim.status !== 'ACTIVE'
        || claim.claim_id !== subject.claimId || claim.context_key !== config.scope || claim.fence !== subject.fence
        || body.current_fence !== subject.fence || claim.execution_epoch !== subject.epoch || body.execution_epoch !== subject.epoch
        || !Array.isArray(body.paths_outside_write_set) || body.paths_outside_write_set.length
        || !(Date.parse(claim.expires_at) > Date.now()) || !(Date.parse(body.verified_at) <= Date.now())
        || Date.now() - Date.parse(body.verified_at) > 30000) stop('native_claim_observation_refused');
      record('native_claim_observation', body);
      return { ...subjectOf(subject), ...Object.fromEntries(REFS.map(ref => [ref, accepted[ref]])),
        ciPrincipalBindingId: config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
        publisherQualified: true, ciPrincipalQualified: true, observedAt: body.verified_at, claimExpiresAt: claim.expires_at };
    } };
    const publisher = createStagedCheckPublisher({ nativeAdmission: full, authority, github, journal, signers,
      configuredChecks: config.checks, readChangedPaths: subject => github.readChangedPaths(subject),
      protectedDeployment: { enabled: true, domain: 'production', repository: REPO, ciPrincipalBindingId: config.ciPrincipalBindingId,
        ...Object.fromEntries(REFS.map(ref => [ref, accepted[ref]])) }, domain: 'production' });
    return await publisher.publish({ job, envelope });
  } finally { if (log !== undefined) fs.closeSync(log); await lockHandle.close(); await fsp.unlink(lock); }
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length > 1 || argv.length === 1 && !['--readiness', '--run'].includes(argv[0])) {
    output.write(JSON.stringify({ status: 'BLOCKED', missing: ['expected_readiness_or_run_only'] }) + '\n'); return 2;
  }
  const ready = await inspectReadiness();
  if (ready.status !== 'READY') { output.write(JSON.stringify(ready) + '\n'); return 2; }
  if (argv[0] !== '--run') { output.write(JSON.stringify({ status: 'READY', action: 'one-shot-not-started', repository: REPO, jobId: ready.job.id }) + '\n'); return 0; }
  try {
    const result = await runOnce(ready); output.write(JSON.stringify(result) + '\n'); return result.status === 'SETTLED' ? 0 : 2;
  } catch (error) { output.write(JSON.stringify({ status: 'BLOCKED', missing: [safe(error)] }) + '\n'); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
