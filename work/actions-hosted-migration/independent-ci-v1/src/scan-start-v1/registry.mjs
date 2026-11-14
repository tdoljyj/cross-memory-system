// The scan-start registry: registry.json, frozen bytes. Native scan-start binds every permission to the
// sha256 of these exact bytes (entry-runtime.mjs; the policy's registry_sha256), so they never change.
// It was built for the hosted relay, which is removed (DESIGN §76, §77); its builder and specs went with it.
// What stays is the validation of the frozen document, for the offline scan-start cutover plan
// (work/independent-ci-resident-v1/qualification/scan-start-cutover-plan.mjs). Pure validation, no I/O.
import { digest } from '../proof.mjs';

const REGISTRY_CONTRACT = 'clued.independent-ci.hosted-relay-registry/1';
export const REGISTRY_CONTRACT_V2 = 'clued.independent-ci.hosted-relay-registry/2';
const SCAN_START_WORKFLOW_GATE = Object.freeze({ contract: 'clued.ci-scan-start-workflow-gate/1',
  stepName: 'Acquire one-time scan permission', scriptPath: 'scripts/ci/clued-scan-start.mjs',
  scriptSha256: '02eea1acaecc39ec179ac4201246509152dbf7bb7119687fb7cf640fb86146e1',
  endpoint: 'https://kooyumi.pixelgrav.com/v1/ci/scan-start', audience: 'clued-ci-scan-start-v1' });
const RELAY_ISSUER = 'https://token.actions.githubusercontent.com';
const RELAY_AUDIENCE = 'clued-hosted-relay-v1';
const HOSTED_APP_ID = 15368; // GitHub Actions
const PUBLISHER_APP_ID = 5368905;
export const REPOSITORY = 'tdoljyj/cross-memory-system';
export const REPOSITORY_ID = 1334673495;
// The six required checks of ruleset 24182890, all pinned to integration 5368905.
export const REQUIRED_CHECK_NAMES = Object.freeze(['gitleaks', 'trivy', 'kooyumi-work-admission',
  'kooyumi-admission-verified', 'kooyumi-merge-slot', 'contract-placement']);
// The roles the frozen registry names, each with its own required check name.
const RELAYABLE_ROLES = Object.freeze({ gitleaks: 'gitleaks', trivy: 'trivy' });
// An optional per-role input pin field of the document (trivy's checks bundle digest).
const ROLE_INPUT_PINS = Object.freeze({ trivy: Object.freeze({ field: 'checksDigest', env: 'CHECKS_DIGEST', use: 'trivy-checks@$CHECKS_DIGEST' }) });
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/;
const MODES = ['100644', '100755'];
const RUNS_ON = ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'ubuntu-slim'];
const COMMON = ['repository', 'repositoryId', 'repositoryOwner', 'repositoryOwnerId', 'baseRef', 'eventName',
  'runnerEnvironment', 'expectedSubject', 'hostedAppId', 'publisherAppId', 'issuer', 'audience', 'annotationTitle',
  'iatSkewSeconds', 'requireCheckRunIdClaim', 'forbiddenChangePrefixes', 'forbiddenChangePaths', 'roles'];
const REGISTRY_KEYS = ['contract', 'domain', 'generatedBy', 'sourceCommit', 'sourceTree', 'specSha256', ...COMMON];
// forbiddenChangePrefixes: per role, the directory prefixes the frozen document lists.
const ROLE_KEYS = ['checkName', 'hostedCheckName', 'workflowPath', 'workflowBlob', 'workflowSha256', 'hostedJobId',
  'hostedJobTimeoutMinutes', 'runsOn', 'closure', 'mustNotExist', 'forbiddenChangePrefixes', 'closureSha256'];
const rolePrefixesValid = prefixes => sortedUnique(prefixes) && prefixes.length <= 64
  && prefixes.every(prefix => typeof prefix === 'string' && prefix.endsWith('/') && safeRepoPath(prefix.slice(0, -1)));
const CLOSURE_KEYS = ['path', 'mode', 'blob', 'sha256'];

const fail = (code, detail) => { throw Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) }); };
const insist = (condition, code, detail) => { if (!condition) fail(code, detail); };

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
export const safeRepoPath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\x00-\x1f\x7f\\:]/.test(value) && !value.startsWith('/')
  && !value.split('/').some(part => part === '' || part === '.' || part === '..');
const sortedUnique = list => Array.isArray(list) && list.every((value, index) => index === 0 || list[index - 1] < value);

function common(value, code) {
  insist(value.repository === REPOSITORY && value.repositoryId === REPOSITORY_ID, code, 'repository');
  insist(value.repositoryOwner === REPOSITORY.split('/')[0], code, 'repositoryOwner');
  insist(value.repositoryOwnerId === null || positive(value.repositoryOwnerId), code, 'repositoryOwnerId');
  insist(value.baseRef === 'main' && value.eventName === 'pull_request' && value.runnerEnvironment === 'github-hosted', code, 'event');
  insist(value.expectedSubject === null || value.expectedSubject === `repo:${REPOSITORY}:pull_request`, code, 'expectedSubject');
  insist(value.hostedAppId === HOSTED_APP_ID && value.publisherAppId === PUBLISHER_APP_ID, code, 'apps');
  insist(value.issuer === RELAY_ISSUER && value.audience === RELAY_AUDIENCE && value.annotationTitle === RELAY_AUDIENCE, code, 'oidc');
  insist(Number.isSafeInteger(value.iatSkewSeconds) && value.iatSkewSeconds >= 0 && value.iatSkewSeconds <= 300, code, 'iatSkewSeconds');
  insist(typeof value.requireCheckRunIdClaim === 'boolean', code, 'requireCheckRunIdClaim');
  // The two forbidden sets are fixed minimums: every .github change and .gitattributes (E3).
  insist(sortedUnique(value.forbiddenChangePrefixes) && value.forbiddenChangePrefixes.includes('.github/')
    && value.forbiddenChangePrefixes.every(prefix => typeof prefix === 'string' && prefix.endsWith('/') && safeRepoPath(prefix.slice(0, -1))), code, 'forbiddenChangePrefixes');
  insist(sortedUnique(value.forbiddenChangePaths) && value.forbiddenChangePaths.includes('.gitattributes')
    && value.forbiddenChangePaths.every(safeRepoPath), code, 'forbiddenChangePaths');
  insist(plain(value.roles) && Object.keys(value.roles).length > 0, code, 'roles');
  for (const role of Object.keys(value.roles)) insist(Object.hasOwn(RELAYABLE_ROLES, role), 'RELAY_REGISTRY_ROLE_NOT_RELAYABLE', role);
}

function names(roles, code) {
  const hosted = new Set(), workflows = new Set();
  for (const [role, entry] of Object.entries(roles)) {
    insist(entry.checkName === RELAYABLE_ROLES[role], code, `${role}.checkName`);
    insist(typeof entry.hostedCheckName === 'string' && NAME.test(entry.hostedCheckName), code, `${role}.hostedCheckName`);
    // Owner Decision bc6fdad1: a hosted job carrying a required check name blocks
    // merges when it fails, whatever integration the ruleset pins. The hosted job
    // name must differ from its own required name and from every required name.
    if (entry.hostedCheckName === entry.checkName) fail('RELAY_REGISTRY_CHECK_NAMES_EQUAL', role);
    insist(!REQUIRED_CHECK_NAMES.includes(entry.hostedCheckName), 'RELAY_REGISTRY_HOSTED_NAME_IS_REQUIRED', role);
    insist(!hosted.has(entry.hostedCheckName), code, `${role}.hostedCheckName.duplicate`);
    hosted.add(entry.hostedCheckName);
    insist(typeof entry.workflowPath === 'string' && WORKFLOW.test(entry.workflowPath) && !workflows.has(entry.workflowPath), code, `${role}.workflowPath`);
    workflows.add(entry.workflowPath);
    insist(RUNS_ON.includes(entry.runsOn), code, `${role}.runsOn`);
  }
}

function scanStartV2(value, code) {
  insist(exact(value.scanStart, Object.keys(SCAN_START_WORKFLOW_GATE))
    && Object.keys(SCAN_START_WORKFLOW_GATE).every(k => value.scanStart[k] === SCAN_START_WORKFLOW_GATE[k]), code, 'scanStart');
  insist(value.requireCheckRunIdClaim === true, code, 'requireCheckRunIdClaim.v2');
  insist(Object.keys(value.roles).sort().join('|') === 'gitleaks|trivy', code, 'scanStart.roles');
  for (const [role, entry] of Object.entries(value.roles)) {
    insist(entry.forbiddenChangePrefixes.includes('scripts/ci/'), code, `${role}.scanStart.prefix`);
    insist(entry.closure.some(item => item.path === value.scanStart.scriptPath
      && item.sha256 === value.scanStart.scriptSha256), code, `${role}.scanStart.closure`);
  }
}

const validated = new WeakMap();

// Returns a frozen copy; registryDigestOf() then gives its structural digest.
export function validateRegistry(registry, { domain } = {}) {
  const code = 'RELAY_REGISTRY_INVALID';
  const v2 = registry?.contract === REGISTRY_CONTRACT_V2;
  insist(exact(registry, v2 ? [...REGISTRY_KEYS, 'scanStart'] : REGISTRY_KEYS) && (v2 || registry.contract === REGISTRY_CONTRACT), code, 'shape');
  insist(['production', 'fixture'].includes(registry.domain), code, 'domain');
  if (domain !== undefined) insist(registry.domain === domain, 'RELAY_REGISTRY_DOMAIN_MISMATCH', registry.domain);
  // The frozen document names the builder that made it (since removed).
  insist(registry.generatedBy === 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/build-registry.mjs', code, 'generatedBy');
  insist(SHA1.test(registry.sourceCommit) && SHA1.test(registry.sourceTree) && SHA256.test(registry.specSha256), code, 'source');
  common(registry, code);
  for (const [role, entry] of Object.entries(registry.roles)) {
    const inputPin = Object.hasOwn(ROLE_INPUT_PINS, role) && Object.hasOwn(entry, ROLE_INPUT_PINS[role].field) ? ROLE_INPUT_PINS[role] : null;
    insist(exact(entry, inputPin ? [...ROLE_KEYS, inputPin.field] : ROLE_KEYS), code, `${role}.shape`);
    if (inputPin) insist(OCI_DIGEST.test(entry[inputPin.field] ?? ''), code, `${role}.${inputPin.field}`);
    insist(SHA1.test(entry.workflowBlob) && SHA256.test(entry.workflowSha256) && JOB_ID.test(entry.hostedJobId)
      && positive(entry.hostedJobTimeoutMinutes) && entry.hostedJobTimeoutMinutes <= 360, code, `${role}.workflow`);
    insist(Array.isArray(entry.closure) && entry.closure.length > 0 && entry.closure.length <= 64, code, `${role}.closure`);
    for (const [index, item] of entry.closure.entries()) {
      insist(exact(item, CLOSURE_KEYS) && safeRepoPath(item.path) && MODES.includes(item.mode)
        && SHA1.test(item.blob) && SHA256.test(item.sha256), code, `${role}.closure.${index}`);
      insist(index === 0 || entry.closure[index - 1].path < item.path, code, `${role}.closure.order`);
    }
    const workflow = entry.closure.find(item => item.path === entry.workflowPath);
    insist(workflow?.blob === entry.workflowBlob && workflow.sha256 === entry.workflowSha256, code, `${role}.closure.workflow`);
    insist(sortedUnique(entry.mustNotExist) && entry.mustNotExist.length <= 64 && entry.mustNotExist.every(safeRepoPath)
      && !entry.mustNotExist.some(path => entry.closure.some(item => item.path === path)), code, `${role}.mustNotExist`);
    insist(rolePrefixesValid(entry.forbiddenChangePrefixes), code, `${role}.forbiddenChangePrefixes`);
    insist(entry.closureSha256 === closureDigest(entry.closure, entry.mustNotExist, entry.forbiddenChangePrefixes), code, `${role}.closureSha256`);
  }
  names(registry.roles, code);
  if (v2) scanStartV2(registry, code);
  const frozen = deepFreeze(structuredClone(registry));
  validated.set(frozen, digest(frozen));
  return frozen;
}

// The role's executed-input pins: closure blobs, paths that must not exist and the forbidden change prefixes.
const closureDigest = (closure, mustNotExist, forbiddenChangePrefixes) => digest({ closure, mustNotExist, forbiddenChangePrefixes });
export function registryDigestOf(registry) {
  insist(validated.has(registry), 'RELAY_REGISTRY_NOT_VALIDATED');
  return validated.get(registry);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
