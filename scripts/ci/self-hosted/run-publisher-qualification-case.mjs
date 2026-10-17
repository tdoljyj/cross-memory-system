import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CASE_SCHEMA = 'clued.publisher-qualification-case/1';
export const PURPOSE = 'production_publisher_nonproduction_PR_qualification';
export const CLASSIFICATION = 'qualification_only';
export const PUBLIC_CANARY_ID = '90612814-c769-4d3f-bfcc-5821261016e3';
export const EXPECTED_VM_ID = 'bd7d78d0-7936-4b33-8176-ea7afd57faaf';
const REPOSITORY = 'tdoljyj/cross-memory-system';
const OWNER = 'tdoljyj';
const SHA = /^[0-9a-f]{40}$/u;
const bindingDiagnostics = new WeakMap();

export function pullRequestBindingDiagnostic(env, pr) {
  const safeSha = value => typeof value === 'string' && value.length === 40 && SHA.test(value) ? value : null;
  const merge = pr?.merge_commit_sha;
  return {
    schema: 'clued.publisher-qualification-case.pr-binding-diagnostic/1',
    event_base_is_main: pr?.base?.ref === 'main',
    environment_base_is_main: env.GITHUB_BASE_REF === 'main',
    head_is_string: typeof pr?.head?.ref === 'string',
    head_length_allowed: typeof pr?.head?.ref === 'string' && pr.head.ref.length > 0 && pr.head.ref.length <= 255,
    head_ref_matches: typeof pr?.head?.ref === 'string' && env.GITHUB_HEAD_REF === pr.head.ref,
    merge_equals_execution: typeof merge === 'string' && merge === env.GITHUB_SHA,
    merge_field_kind: !Object.hasOwn(pr ?? {}, 'merge_commit_sha') ? 'missing' : merge === null ? 'null' : safeSha(merge) ? 'valid_sha' : 'invalid',
    execution_sha: safeSha(env.GITHUB_SHA), event_head_sha: safeSha(pr?.head?.sha),
    event_base_sha: safeSha(pr?.base?.sha), event_merge_sha: safeSha(merge),
    production_qualified: false,
  };
}

export function qualificationFailure(error) {
  const failure = { schema: 'clued.publisher-qualification-case.failure/1', result: 'REFUSED_OR_UNKNOWN',
    reason: /^[A-Z0-9_]+$/u.test(error.message ?? '') ? error.message : 'QUALIFICATION_OBSERVATION_FAILED', production_qualified: false };
  // Only a diagnostic constructed at the exact binding refusal is eligible.
  // Never serialize an arbitrary error property, event, environment or ref.
  if (bindingDiagnostics.has(error)) failure.pr_binding_diagnostic = bindingDiagnostics.get(error);
  return failure;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CASE_PATH = fileURLToPath(new URL('./publisher-qualification-case.json', import.meta.url));
const PROBE_PATH = fileURLToPath(new URL('./qualify-publisher-host-principal.ps1', import.meta.url));
const LAUNCH_PATH = '/opt/clued-production-publisher/launch.json';
const MARKER_PATH = '/home/clued-release-runner/.clued-qualification-marker';

function requireFact(condition, reason) { if (!condition) throw new Error(reason); }
function exactKeys(value, keys, reason) {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), reason);
  requireFact(Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), reason);
}
export function parseArguments(args) {
  requireFact(args.length === 2 && args[0] === '--kind' && ['host', 'guest'].includes(args[1]), 'FIXED_KIND_ARGUMENT_REQUIRED');
  return args[1];
}
export function validateCase(value) {
  exactKeys(value, ['schema', 'purpose', 'classification', 'qualification_id', 'host', 'guest'], 'CASE_FIELDS_INVALID');
  requireFact(value.schema === CASE_SCHEMA && value.purpose === PURPOSE && value.classification === CLASSIFICATION, 'CASE_SCOPE_INVALID');
  requireFact(typeof value.qualification_id === 'string' && UUID.test(value.qualification_id)
    && ![PUBLIC_CANARY_ID, EXPECTED_VM_ID].includes(value.qualification_id), 'QUALIFICATION_UUID_INVALID');
  exactKeys(value.host, ['mode', 'isolation_canary_id', 'expected_qualification_vm'], 'HOST_CASE_FIELDS_INVALID');
  requireFact(['Inventory', 'S4UCanary'].includes(value.host.mode), 'HOST_MODE_INVALID');
  requireFact(value.host.isolation_canary_id === PUBLIC_CANARY_ID && value.host.expected_qualification_vm === EXPECTED_VM_ID, 'FIXED_PUBLIC_TARGETS_REQUIRED');
  exactKeys(value.guest, ['case'], 'GUEST_CASE_FIELDS_INVALID');
  requireFact(['success', 'failure', 'cancel'].includes(value.guest.case), 'GUEST_CASE_INVALID');
  return value;
}
function readBoundedFile(filename, limit) {
  const before = fs.lstatSync(filename);
  requireFact(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= limit, 'BOUNDED_REGULAR_JSON_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    requireFact(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'JSON_FILE_CHANGED');
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fs.fstatSync(fd);
    requireFact(count === before.size && count <= limit && after.dev === opened.dev && after.ino === opened.ino
      && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs, 'JSON_SIZE_OR_IDENTITY_CHANGED');
    const bytes = buffer.subarray(0, count);
    return { bytes, metadata: opened };
  } finally { fs.closeSync(fd); }
}
export function readBoundedJson(filename, limit) {
  const result = readBoundedFile(filename, limit);
  return { ...result, value: JSON.parse(result.bytes.toString('utf8')) };
}
export function validatePullRequestContext(env, event, kind) {
  requireFact(['host', 'guest'].includes(kind), 'FIXED_KIND_REQUIRED');
  requireFact(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'pull_request'
    && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_OWNER === OWNER
    && env.GITHUB_ACTOR === OWNER && env.GITHUB_TRIGGERING_ACTOR === OWNER, 'OWNER_PULL_REQUEST_REQUIRED');
  requireFact(/^[1-9][0-9]{0,19}$/u.test(env.GITHUB_RUN_ID ?? '')
    && /^[1-9][0-9]{0,5}$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') && SHA.test(env.GITHUB_SHA ?? ''), 'RUN_SOURCE_FORMAT_INVALID');
  const pr = event?.pull_request;
  requireFact(Number.isSafeInteger(event?.number) && event.number > 0 && event.number === pr?.number
    && ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event?.action), 'ACTUAL_PULL_REQUEST_EVENT_REQUIRED');
  requireFact(event.repository?.full_name === REPOSITORY && event.repository?.owner?.login === OWNER
    && event.repository?.fork === false && Number.isSafeInteger(event.repository?.id) && event.repository.id > 0
    && pr?.user?.login === OWNER && event.sender?.login === OWNER, 'OWNER_EVENT_REPOSITORY_REQUIRED');
  for (const side of ['head', 'base']) {
    requireFact(pr[side]?.repo?.full_name === REPOSITORY && pr[side].repo.id === event.repository.id
      && pr[side].repo.owner?.login === OWNER && pr[side].repo.fork === false && SHA.test(pr[side]?.sha ?? ''), 'SAME_REPOSITORY_SOURCE_REQUIRED');
  }
  if (!(pr.base.ref === 'main' && env.GITHUB_BASE_REF === 'main'
    && typeof pr.head.ref === 'string' && pr.head.ref.length > 0 && pr.head.ref.length <= 255
    && env.GITHUB_HEAD_REF === pr.head.ref && pr.merge_commit_sha === env.GITHUB_SHA)) {
    const error = new Error('PR_HEAD_BASE_MERGE_BINDING_INVALID');
    bindingDiagnostics.set(error, pullRequestBindingDiagnostic(env, pr));
    throw error;
  }
  const ref = `refs/pull/${event.number}/merge`;
  const workflow = `clued-production-publisher-${kind}-qualification.yml`;
  requireFact(env.GITHUB_REF === ref && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/${workflow}@${ref}`, 'PR_WORKFLOW_REF_INVALID');
  requireFact(env.GITHUB_JOB === (kind === 'host' ? 'host-principal-probe' : 'qualify')
    && env.RUNNER_ARCH === 'X64' && env.RUNNER_OS === (kind === 'host' ? 'Windows' : 'Linux')
    && typeof env.RUNNER_NAME === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(env.RUNNER_NAME)
    && (kind !== 'host' || env.RUNNER_NAME === 'clued-ci-company-win-01'), 'QUALIFICATION_RUNNER_CONTEXT_INVALID');
  return {
    repository: REPOSITORY, run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT,
    job_name: env.GITHUB_JOB, sha: env.GITHUB_SHA, ref, workflow_ref: env.GITHUB_WORKFLOW_REF,
    runner_name: env.RUNNER_NAME, pull_request_number: String(event.number),
    pull_request_head_sha: pr.head.sha, pull_request_base_sha: pr.base.sha,
    event_name: env.GITHUB_EVENT_NAME, pull_request_base_ref: pr.base.ref, pull_request_head_ref: pr.head.ref,
    repository_owner: OWNER, actor: env.GITHUB_ACTOR, triggering_actor: env.GITHUB_TRIGGERING_ACTOR,
    pull_request_author: pr.user.login,
  };
}
export function buildHostInvocation(caseValue) {
  const selected = validateCase(caseValue);
  return {
    executable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE_PATH,
      '-Mode', selected.host.mode, '-QualificationId', selected.qualification_id,
      '-IsolationCanaryId', PUBLIC_CANARY_ID, '-ExpectedQualificationVm', EXPECTED_VM_ID],
  };
}
export function validateHostResult(value, selected, context) {
  requireFact(value?.production_qualified === false && value.qualification_id === selected.qualification_id
    && value.schema === `clued.publisher-host-principal.${selected.host.mode === 'Inventory' ? 'inventory' : 's4u'}/1`
    && value.result === (selected.host.mode === 'Inventory' ? 'INVENTORY_OBSERVED' : 'S4U_AND_WSL_VERSION_OBSERVED'), 'HOST_SUCCESS_NOT_OBSERVED');
  requireFact(value.identity?.host === 'DESK-W-591'
    && value.identity.sid === 'S-1-5-21-858977881-4031698862-3006450925-1005'
    && value.identity.session_id === 0 && value.identity.administrator_token_member === false
    && value.identity.hyper_v_token_member === false, 'HOST_ACTUAL_PRINCIPAL_MISMATCH');
  for (const [key, expected] of Object.entries(context)) {
    const hostKey = key === 'job_name' ? 'job_key' : key;
    requireFact(value.github?.[hostKey] === expected, 'HOST_GITHUB_OBSERVATION_MISMATCH');
  }
  return value;
}
export function validateGuestLaunch(launch, metadata, selected, context, runnerGid) {
  requireFact(metadata.regular === true && metadata.symlink === false && metadata.uid === 0
    && Number.isSafeInteger(runnerGid) && runnerGid > 0 && metadata.gid === runnerGid
    && metadata.mode === 0o640, 'TRUSTED_LAUNCH_FILE_METADATA_REQUIRED');
  requireFact(launch?.schema === 'clued.production-vm-launch/1' && launch.purpose === 'qualification'
    && launch.qualification_id === selected.qualification_id && launch.qualification_case === selected.guest.case
    && launch.production_qualified === false, 'QUALIFICATION_LAUNCH_SCOPE_MISMATCH');
  for (const key of ['repository', 'run_id', 'run_attempt', 'job_name', 'sha', 'ref', 'workflow_ref', 'runner_name',
    'pull_request_number', 'pull_request_head_sha', 'pull_request_base_sha']) {
    requireFact(typeof launch[key] === 'string' && launch[key] === context[key], 'QUALIFICATION_LAUNCH_BINDING_MISMATCH');
  }
  return launch;
}
export function guestCaseOutcome(caseName) {
  requireFact(['success', 'failure', 'cancel'].includes(caseName), 'GUEST_CASE_INVALID');
  return caseName === 'success' ? { exit_code: 0, wait_milliseconds: 0, expected: 'success' }
    : caseName === 'failure' ? { exit_code: 23, wait_milliseconds: 0, expected: 'failure' }
      : { exit_code: 24, wait_milliseconds: 600_000, expected: 'Host cancellation required; timeout is a failed cancellation test' };
}
function observeGuest(selected, context) {
  requireFact(process.platform === 'linux' && process.getuid() !== 0, 'ACTUAL_NONROOT_LINUX_RUNNER_REQUIRED');
  const groupBytes = readBoundedFile('/etc/group', 65_536).bytes;
  const passwdBytes = readBoundedFile('/etc/passwd', 65_536).bytes;
  const groups = groupBytes.toString('utf8').split('\n').filter(line => line.startsWith('clued-release-runner:'));
  const accounts = passwdBytes.toString('utf8').split('\n').filter(line => line.startsWith('clued-release-runner:'));
  requireFact(groups.length === 1 && accounts.length === 1, 'EXACT_GUEST_ACCOUNT_REQUIRED');
  const gid = Number(groups[0].split(':')[2]);
  const account = accounts[0].split(':');
  requireFact(Number(account[2]) === process.getuid() && Number(account[3]) === gid && process.getgid() === gid
    && account[5] === '/home/clued-release-runner', 'ACTUAL_GUEST_IDENTITY_MISMATCH');
  const launchFile = readBoundedJson(LAUNCH_PATH, 16_384);
  validateGuestLaunch(launchFile.value, { regular: launchFile.metadata.isFile(), symlink: false,
    uid: launchFile.metadata.uid, gid: launchFile.metadata.gid, mode: launchFile.metadata.mode & 0o7777 }, selected, context, gid);
  const home = fs.lstatSync('/home/clued-release-runner');
  requireFact(home.isDirectory() && !home.isSymbolicLink() && home.uid === process.getuid()
    && (home.mode & 0o022) === 0, 'GUEST_HOME_OWNERSHIP_REQUIRED');
  const fd = fs.openSync(MARKER_PATH, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, `${selected.qualification_id}\n`, 'utf8'); }
  finally { fs.closeSync(fd); }
  return { launch_sha256: createHash('sha256').update(launchFile.bytes).digest('hex'), marker_created: true };
}
export async function main(args = process.argv.slice(2)) {
  const kind = parseArguments(args);
  const caseFile = readBoundedJson(CASE_PATH, 4096);
  const selected = validateCase(caseFile.value);
  requireFact(path.isAbsolute(process.env.GITHUB_EVENT_PATH ?? ''), 'ACTUAL_GITHUB_EVENT_PATH_REQUIRED');
  const event = readBoundedJson(process.env.GITHUB_EVENT_PATH, 1_048_576).value;
  const context = validatePullRequestContext(process.env, event, kind);
  const observation = { schema: 'clued.publisher-qualification-case.observation/1', kind, purpose: PURPOSE,
    classification: CLASSIFICATION, qualification_id: selected.qualification_id,
    case_sha256: createHash('sha256').update(caseFile.bytes).digest('hex'), observed: context,
    production_qualified: false, scope: 'job-side observation; external admission, trusted pre-job launch and Host lifecycle evidence remain required' };
  if (kind === 'host') {
    requireFact(process.platform === 'win32', 'WINDOWS_HOST_REQUIRED');
    const invocation = buildHostInvocation(selected);
    const child = spawnSync(invocation.executable, invocation.args, { shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 90_000, maxBuffer: 262_144, env: process.env });
    let report = null;
    try { report = JSON.parse(child.stdout?.trim() ?? ''); } catch { /* Unknown stays unknown. */ }
    observation.host_report = report;
    observation.child_exit_code = child.status;
    observation.result = 'UNKNOWN';
    if (!child.error && child.status === 0) {
      validateHostResult(report, selected, context);
      observation.result = 'HOST_PROBE_OBSERVED';
    }
    console.log(JSON.stringify(observation));
    return observation.result === 'HOST_PROBE_OBSERVED' ? 0 : 2;
  }
  observation.guest_case = selected.guest.case;
  observation.guest = observeGuest(selected, context);
  observation.result = 'GUEST_JOB_OBSERVED';
  console.log(JSON.stringify(observation));
  const outcome = guestCaseOutcome(selected.guest.case);
  if (outcome.wait_milliseconds) await new Promise(resolve => setTimeout(resolve, outcome.wait_milliseconds));
  return outcome.exit_code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify(qualificationFailure(error)));
    process.exitCode = 20;
  });
}
