// Derive registry.json deterministically from one commit (design S15).
//
//   node build-registry.mjs --repo <git dir> --commit <rev> [--spec <spec.json>] [--domain production|fixture] [--out <file> [--replace]]
//
// Production rebuild from the newest frozen PR-B commit (one command):
//   node work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/build-registry.mjs --repo . \
//     --commit <PR-B commit> --out work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json --replace
//
// Every pin (workflow blob, closure blobs, hosted job id, job timeout) is read
// from the commit with `git ls-tree` / `git cat-file`; nothing is hand-written.
// The production registry must be built from the frozen PR-B commit. The
// workflow scan below is a refusal heuristic for a wrong commit, not a YAML
// parser: the real pins are the blob hashes, reviewed with PR-B's exact bytes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest } from '../proof.mjs';
import { REGISTRY_CONTRACT, RELAY_AUDIENCE, REQUIRED_CHECK_NAMES, closureDigest, relayFail, validateRegistry, validateSpec } from './registry.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const GENERATED_BY = 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/build-registry.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const insist = (condition, code, detail) => { if (!condition) relayFail(code, detail); };

// Read-only object access to one repository. No checkout, no worktree file.
export function gitObjectReader(repoDir, { git = 'git' } = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const run = (args, { binary = false } = {}) => {
    const result = spawnSync(git, ['-C', repoDir, '-c', 'core.quotepath=off', ...args], { env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0) relayFail('RELAY_REGISTRY_GIT_FAILED', args[0]);
    return binary ? result.stdout : result.stdout.toString('utf8');
  };
  const entries = new Map(), blobs = new Map();
  return Object.freeze({
    resolve(rev) {
      insist(typeof rev === 'string' && /^[A-Za-z0-9_./^{}~-]{1,200}$/.test(rev) && !rev.startsWith('-'), 'RELAY_REGISTRY_COMMIT_INVALID');
      const commit = run(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
      const tree = run(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]).trim();
      insist(SHA1.test(commit) && SHA1.test(tree), 'RELAY_REGISTRY_COMMIT_INVALID');
      return { commit, tree };
    },
    // One path, never a pathspec glob: `:(literal)` disables magic.
    entry(commit, file) {
      insist(SHA1.test(commit), 'RELAY_REGISTRY_COMMIT_INVALID');
      const cacheKey = `${commit}\0${file}`;
      if (entries.has(cacheKey)) return entries.get(cacheKey);
      const out = run(['ls-tree', '-z', '--full-tree', commit, '--', `:(literal)${file}`]);
      let found = null;
      if (out !== '') {
        const records = out.split('\0').filter(Boolean);
        insist(records.length === 1, 'RELAY_REGISTRY_TREE_AMBIGUOUS', file);
        const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/s.exec(records[0]);
        insist(match && match[4] === file, 'RELAY_REGISTRY_TREE_AMBIGUOUS', file);
        found = { mode: match[1], type: match[2], sha: match[3] };
      }
      entries.set(cacheKey, found);
      return found;
    },
    blob(sha) {
      insist(SHA1.test(sha), 'RELAY_REGISTRY_BLOB_INVALID');
      if (!blobs.has(sha)) blobs.set(sha, run(['cat-file', 'blob', sha], { binary: true }));
      return blobs.get(sha);
    },
  });
}

export const gitBlobSha1 = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The check-run names a job can carry: a literal name, or the two literals of
// `${{ (<condition>) && '<A>' || '<B>' }}`. The outer parentheses must enclose
// the whole condition (quoted literals skipped), so `(c) && 'A'` is 'A' or a
// falsy value and the expression is always A or B. Anything else is null.
export function possibleNames(raw) {
  const unquoted = /^'([^']*)'$/.exec(raw) ?? /^"([^"\\]*)"$/.exec(raw);
  if (!raw.includes('${{')) return unquoted ? [unquoted[1]] : /^[A-Za-z0-9][A-Za-z0-9 _.()-]*$/.test(raw) ? [raw] : null;
  const form = /^\$\{\{\s*(\(.*\))\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\s*\}\}$/.exec(raw);
  if (!form) return null;
  const condition = form[1];
  let depth = 0;
  for (let index = 0; index < condition.length; index++) {
    const char = condition[index];
    if (char === "'") { const close = condition.indexOf("'", index + 1); if (close < 0) return null; index = close; continue; }
    if (char === '{' || char === '}') return null;
    if (char === '(') depth++;
    if (char === ')') { depth--; if (depth < 0 || (depth === 0 && index !== condition.length - 1)) return null; }
  }
  return depth === 0 ? [form[2], form[3]] : null;
}

// A strict line scan of the registered workflow. It refuses anything it cannot
// read unambiguously: tabs, CR, flow-style jobs, a job name that is neither a
// literal nor the closed form `${{ (<condition>) && '<A>' || '<B>' }}` (whose
// value is always A or B), a required check name among any job's possible
// names, the hosted name on a second job, id-token on any other job, a missing,
// conditional or non-final identity step, and a step allowed to fail.
export function scanWorkflow(bytes, { workflowPath, checkName, hostedCheckName, runsOn }) {
  const code = 'RELAY_REGISTRY_WORKFLOW_REFUSED';
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { relayFail(code, `${workflowPath}:utf8`); }
  insist(!/[\t\r]/.test(text) && !text.startsWith('\ufeff'), code, `${workflowPath}:whitespace`);
  insist(!text.includes('pull_request_target'), code, `${workflowPath}:pull_request_target`);
  const lines = text.split('\n');
  const blockEnd = start => { const next = lines.slice(start + 1).findIndex(line => /^\S/.test(line) && !line.startsWith('#'));
    return next < 0 ? lines.length : start + 1 + next; };
  const onIndex = lines.findIndex(line => /^on:\s*$/.test(line));
  insist(onIndex >= 0 && lines.slice(onIndex + 1, blockEnd(onIndex)).some(line => /^ {2}pull_request:\s*$/.test(line)),
    code, `${workflowPath}:on.pull_request`);
  const jobsAt = lines.flatMap((line, index) => /^jobs:\s*$/.test(line) ? [index] : []);
  insist(jobsAt.length === 1, code, `${workflowPath}:jobs`);
  // Top-level permissions must not grant id-token.
  const topEnd = jobsAt[0];
  insist(!lines.slice(0, topEnd).some(line => /id-token\s*:/.test(line)), code, `${workflowPath}:top-level-id-token`);
  const end = blockEnd(topEnd);
  const jobs = [];
  for (let index = topEnd + 1; index < end; index++) {
    const line = lines[index];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const key = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (key) { jobs.push({ id: key[1], start: index, lines: [] }); continue; }
    insist(jobs.length && /^ {4,}\S/.test(line), code, `${workflowPath}:jobs.line${index + 1}`);
    jobs.at(-1).lines.push(line);
  }
  insist(jobs.length > 0 && new Set(jobs.map(job => job.id)).size === jobs.length, code, `${workflowPath}:job-ids`);
  const field = (job, name) => job.lines.filter(line => line.startsWith(`    ${name}:`)).map(line => line.slice(name.length + 5).trim());
  const unquote = value => /^'[^']*'$/.test(value) || /^"[^"\\]*"$/.test(value) ? value.slice(1, -1) : value;
  const hosted = [];
  for (const job of jobs) {
    const declared = field(job, 'name');
    insist(declared.length <= 1, code, `${workflowPath}:${job.id}.name`);
    const raw = declared.length ? declared[0] : job.id;
    const names = possibleNames(raw);
    insist(names, code, `${workflowPath}:${job.id}.name-not-closed`);
    // A job that can carry a required check name blocks merges (bc6fdad1).
    for (const required of REQUIRED_CHECK_NAMES) insist(!names.includes(required), code, `${workflowPath}:${job.id}.required-name:${required}`);
    if (names.includes(hostedCheckName)) { hosted.push(job); continue; }
    insist(!job.lines.some(line => /id-token\s*:/.test(line)), code, `${workflowPath}:${job.id}.id-token`);
  }
  // The hosted name on two jobs would make E5's newest run ambiguous.
  insist(hosted.length === 1, code, `${workflowPath}:hosted-job-count`);
  const [job] = hosted;
  insist(field(job, 'runs-on').length === 1 && unquote(field(job, 'runs-on')[0]) === runsOn, code, `${workflowPath}:runs-on`);
  const timeout = field(job, 'timeout-minutes');
  insist(timeout.length === 1 && /^[1-9][0-9]{0,2}$/.test(timeout[0]), code, `${workflowPath}:timeout-minutes`);
  // Job-level permissions: exactly contents read and id-token write (block or flow style).
  const declaredPermissions = field(job, 'permissions');
  insist(declaredPermissions.length === 1, code, `${workflowPath}:permissions`);
  let permissions;
  if (declaredPermissions[0] === '') {
    const at = job.lines.findIndex(line => /^ {4}permissions:\s*$/.test(line));
    permissions = [];
    for (const line of job.lines.slice(at + 1)) { if (!/^ {6}\S/.test(line)) break; permissions.push(line.trim()); }
  } else {
    const flow = /^\{([^{}]*)\}$/.exec(declaredPermissions[0]);
    insist(flow, code, `${workflowPath}:permissions.flow`);
    permissions = flow[1].split(',').map(item => item.trim().replace(/\s*:\s*/, ': '));
  }
  insist(permissions.slice().sort().join('|') === 'contents: read|id-token: write', code, `${workflowPath}:permissions.exact`);
  insist(job.lines.filter(line => /id-token\s*:/.test(line)).length === 1, code, `${workflowPath}:id-token.once`);
  // A step or job allowed to fail would let the identity step run after a failed scan.
  insist(!job.lines.some(line => /continue-on-error\s*:/.test(line)), code, `${workflowPath}:continue-on-error`);
  // The identity step is the last step and the only one that mints a token.
  const steps = job.lines.flatMap((line, index) => /^ {6}- /.test(line) ? [index] : []);
  insist(steps.length > 0, code, `${workflowPath}:steps`);
  const last = job.lines.slice(steps.at(-1)).join('\n');
  insist(/^ {6}- name: Emit relay identity\s*$/.test(job.lines[steps.at(-1)]), code, `${workflowPath}:identity-step-last`);
  insist(!/^\s+if:/m.test(last), code, `${workflowPath}:identity-step-condition`);
  insist(last.includes(`audience=${RELAY_AUDIENCE}`) && last.includes(`::notice title=${RELAY_AUDIENCE}::`), code, `${workflowPath}:identity-step-content`);
  const before = job.lines.slice(0, steps.at(-1)).join('\n');
  insist(!before.includes('ACTIONS_ID_TOKEN_REQUEST') && !before.includes(RELAY_AUDIENCE), code, `${workflowPath}:token-before-last-step`);
  return { hostedJobId: job.id, hostedJobTimeoutMinutes: Number(timeout[0]) };
}

export function buildRegistry({ spec, reader, commit: rev, domain = 'production' }) {
  insist(['production', 'fixture'].includes(domain), 'RELAY_REGISTRY_DOMAIN_INVALID');
  const checked = validateSpec(spec);
  const { commit, tree } = reader.resolve(rev);
  const roles = {};
  for (const role of Object.keys(checked.roles).sort()) {
    const entry = checked.roles[role];
    const closure = [];
    for (const file of entry.closure) {
      const found = reader.entry(commit, file);
      insist(found, 'RELAY_REGISTRY_CLOSURE_MISSING', file);
      insist(found.type === 'blob' && ['100644', '100755'].includes(found.mode), 'RELAY_REGISTRY_CLOSURE_NOT_REGULAR', file);
      const bytes = reader.blob(found.sha);
      insist(gitBlobSha1(bytes) === found.sha, 'RELAY_REGISTRY_BLOB_MISMATCH', file);
      closure.push({ path: file, mode: found.mode, blob: found.sha, sha256: sha256(bytes), bytes });
    }
    for (const file of entry.mustNotExist) {
      insist(reader.entry(commit, file) === null, 'RELAY_REGISTRY_FORBIDDEN_PATH_PRESENT', file);
      // A non-directory on the way to the path would also make it reachable.
      const parts = file.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const parent = reader.entry(commit, parts.slice(0, depth).join('/'));
        insist(parent === null || parent.type === 'tree', 'RELAY_REGISTRY_FORBIDDEN_PATH_PRESENT', file);
      }
    }
    const workflow = closure.find(item => item.path === entry.workflowPath);
    const job = scanWorkflow(workflow.bytes, entry);
    const pins = closure.map(({ bytes, ...item }) => item);
    roles[role] = { checkName: entry.checkName, hostedCheckName: entry.hostedCheckName, workflowPath: entry.workflowPath,
      workflowBlob: workflow.blob, workflowSha256: workflow.sha256, ...job, runsOn: entry.runsOn,
      closure: pins, mustNotExist: [...entry.mustNotExist], closureSha256: closureDigest(pins, entry.mustNotExist) };
  }
  const { contract, roles: specRoles, ...rest } = checked;
  const registry = { contract: REGISTRY_CONTRACT, domain, generatedBy: GENERATED_BY, sourceCommit: commit, sourceTree: tree,
    specSha256: digest(checked), ...rest, roles };
  validateRegistry(registry, { domain });
  return registry;
}

// Stable bytes: sorted keys, two-space indentation, final newline.
export function serializeRegistry(registry) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return `${JSON.stringify(sort(registry), null, 2)}\n`;
}

export function main(argv = process.argv.slice(2), output = process.stdout) {
  const usage = 'usage: build-registry.mjs --repo <dir> --commit <rev> [--spec <file>] [--domain production|fixture] [--out <file> [--replace]]\n';
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--replace' && !Object.hasOwn(options, flag)) { options[flag] = true; continue; }
    const value = argv[++index];
    if (!['--repo', '--commit', '--spec', '--domain', '--out'].includes(flag) || value === undefined || Object.hasOwn(options, flag)) { output.write(usage); return 2; }
    options[flag] = value;
  }
  if (!options['--repo'] || !options['--commit'] || (options['--replace'] && !options['--out'])) { output.write(usage); return 2; }
  try {
    const spec = JSON.parse(fs.readFileSync(options['--spec'] ?? path.join(HERE, 'registry.spec.json'), 'utf8'));
    const registry = buildRegistry({ spec, reader: gitObjectReader(options['--repo']), commit: options['--commit'], domain: options['--domain'] ?? 'production' });
    const bytes = serializeRegistry(registry);
    if (!options['--out']) { output.write(bytes); return 0; }
    if (!options['--replace']) fs.writeFileSync(options['--out'], bytes, { flag: 'wx' });
    else {
      // Rebuild in place from another frozen commit: the old file is replaced only
      // by a complete, validated registry (temporary file, then rename).
      const temporary = `${options['--out']}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, options['--out']); }
      finally { fs.rmSync(temporary, { force: true }); }
    }
    output.write(`${JSON.stringify({ status: 'BUILT', sourceCommit: registry.sourceCommit, domain: registry.domain,
      registrySha256: digest(registry), roles: Object.keys(registry.roles) })}\n`);
    return 0;
  } catch (error) {
    output.write(`${JSON.stringify({ status: 'REFUSED', code: error?.code ?? 'RELAY_REGISTRY_BUILD_FAILED', detail: error?.detail ?? null })}\n`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
