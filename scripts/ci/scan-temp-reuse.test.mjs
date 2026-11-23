// Task 79a20873 (D:/w/tmp/PLAN-scan-tempdir-leftover-20261123.md): the self-hosted gitleaks and trivy jobs failed with
// "mkdir: ... File exists". A scan container that runs under another uid (65532) writes directories into a writable bind
// mount of $RUNNER_TEMP that the runner account cannot delete; the runner's own _temp cleanup (IOUtil.DeleteDirectory)
// stops at the first directory it cannot delete, so every job's fixed-name directory survives into the next job.
//
// The jobs' own steps run here with a stand-in docker on PATH that keeps the uid semantics: a container whose --user is
// not the job account's leaves its subtree mode 0555 (the job account can neither unlink in it nor remove it); one whose
// --user is the job account's writes ordinary directories. A ledger stands in for "owned by 65532", which a test cannot
// chown: a `find -user 65532` shim reads it, and the stand-in's 65532 find/chmod container makes the ledger's entries
// writable, as only their owner could.
//
// Windows: chmod 0555 does not stop NTFS from deleting (measured: node unlinks and rmdirs inside it), so the model does
// not hold there and the dynamic cases skip; as root nothing stops a delete, so they skip too. The static case runs everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'clued-required-tests.yml');
const yaml = createRequire(path.join(ROOT, 'apps', 'clued-cloud', 'package.json'))('yaml');
const workflow = () => yaml.parse(readFileSync(WORKFLOW, 'utf8'));
const fwd = (p) => p.replace(/\\/g, '/');
const NODE = fwd(process.execPath);
const SCANS = ['trivy', 'gitleaks'];
const RECLAIM = 'Reclaim the scan directories';
const CONFIGURE = 'Configure job temporary storage';

// Never the bash on PATH under Windows (it may be WSL's): Git for Windows' own bash.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
  return bash && existsSync(bash) ? bash : null;
}
const BASH = findBash();
const dynamicSkip = !BASH ? 'bash not found'
  : process.platform === 'win32' ? 'Windows: chmod 0555 does not stop NTFS from deleting, so the uid model does not hold'
  : process.getuid?.() === 0 ? 'root deletes anything, so the uid model does not hold' : false;

const TMP = mkdtempSync(path.join(os.tmpdir(), 'scan-temp-reuse-'));
test.after(() => {
  // The 0555 subtrees are the model's own; make them deletable again before removing the scratch directory.
  const open = (dir) => { try { chmodSync(dir, 0o755); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) open(path.join(dir, e.name)); } catch { /* gone */ } };
  open(TMP);
  rmSync(TMP, { recursive: true, force: true });
});
const GLOBAL = path.join(TMP, 'gitconfig');
writeFileSync(GLOBAL, '[user]\n\tname = t\n\temail = t@invalid\n[commit]\n\tgpgSign = false\n[core]\n\thooksPath =\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GLOBAL, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
for (const key of Object.keys(ENV)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete ENV[key];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// ---- the stand-ins ----
// fake-docker.mjs: image/pull succeed; run checks the confinement flags, maps container paths through its bind mounts
// and acts as the one container the job runs at that point. A --user other than the job account's (FAKE_SELF) leaves
// what it writes mode 0555 and recorded in the ledger.
const FAKE_DOCKER = `import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const a = process.argv.slice(2);
const die = (m) => { console.error('fake docker: ' + m); process.exit(9); };
if (a[0] === 'image' || a[0] === 'pull') process.exit(0);
if (a[0] !== 'run') die('unexpected ' + a[0]);
for (const f of ['--rm', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true']) if (!a.includes(f)) die('missing ' + f);
const user = (a.find((x) => x.startsWith('--user=')) || '').slice(7);
if (!/^[0-9]+:[0-9]+$/.test(user)) die('no numeric --user: ' + user);
const foreign = user !== process.env.FAKE_SELF;
const mounts = [];
for (let i = 0; i < a.length; i++) if (a[i] === '--mount') {
  const parts = a[i + 1].split(',');
  const m = Object.fromEntries(parts.filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  m.readonly = parts.includes('readonly');
  if (m.type !== 'bind' || !existsSync(m.src)) die('bind source missing: ' + a[i + 1]);
  mounts.push(m);
}
const host = (p, writable) => {
  const m = mounts.find((m) => p === m.dst || p.startsWith(m.dst + '/'));
  if (!m) die('no mount for ' + p);
  if (writable && m.readonly) die(p + ' is mounted read-only');
  return m.src + p.slice(m.dst.length);
};
const ep = a.indexOf('--entrypoint');
const entry = a[ep + 1], args = a.slice(ep + 3);
const opt = (name) => args[args.indexOf(name) + 1];
// Writes files under a writable mount; as a foreign uid the new directories end mode 0555, ledgered.
function write(root, files) {
  const made = [];
  for (const [rel, body] of Object.entries(files)) {
    let dir = root;
    for (const part of path.posix.dirname(rel).split('/').filter((p) => p !== '.')) {
      dir = path.join(dir, part);
      if (!existsSync(dir)) { mkdirSync(dir); made.push(dir); }
    }
    writeFileSync(path.join(root, rel), body);
    made.push(path.join(root, rel));
  }
  if (!foreign) return;
  appendFileSync(process.env.FAKE_LEDGER, made.map((p) => p + '\\n').join(''));
  for (const p of made.reverse()) if (statSync(p).isDirectory()) chmodSync(p, 0o555);
}
const stamp = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19) + 'Z';
if (entry === '/usr/local/bin/trivy') {
  if (args.includes('--download-db-only')) {
    write(host(opt('--cache-dir'), true), { 'db/metadata.json': JSON.stringify({ Version: 2, UpdatedAt: stamp(-3600e3), NextUpdate: stamp(86400e3) }), 'db/trivy.db': 'db' });
  } else if (/@sha256:/.test(opt('--checks-bundle-repository') || '')) {
    const digest = opt('--checks-bundle-repository').split('@')[1];
    write(host(opt('--cache-dir'), true), { 'policy/metadata.json': JSON.stringify({ Digest: digest, MajorVersion: 2 }), 'policy/content/policies/kubernetes/k.rego': 'package k' });
  }
  process.exit(0); // the three scanners: read-only mounts, nothing written
}
if (entry === '/bin/cat') { process.stdout.write(readFileSync(host(args[0]))); process.exit(0); }
if (entry === '/bin/ls') {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => { console.log(e.name); if (e.isDirectory()) walk(path.join(d, e.name)); });
  // read_back passes ls only "-R" (its fourth argument is dropped), so ls lists its working directory, / with the mounts.
  const target = args[args.length - 1];
  for (const d of target.startsWith('-') ? mounts.map((m) => m.src) : [host(target)]) walk(d);
  process.exit(0);
}
if (entry === '/usr/bin/gitleaks') {
  const src = host('/repo');
  const opts = (args.find((x) => x.startsWith('--log-opts=')) || '--log-opts=').slice(11).split(/\\s+/).filter(Boolean);
  const r = spawnSync('git', ['-C', src, 'log', '-p', '-U0', '--no-color', ...opts], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('ERR [git] ' + r.stderr); process.exit(0); }
  console.log('INF no leaks found'); process.exit(0);
}
if (entry === 'find') {
  // The transitional reclaim: uid 65532 makes what it owns writable for everyone.
  if (user !== '65532:65532') die('the reclaim container runs as 65532');
  if (JSON.stringify(args.slice(1)) !== JSON.stringify(['-user', '65532', '-exec', 'chmod', 'a+rwX', '{}', '+'])) die('reclaim: ' + args.join(' '));
  const root = host(args[0], true);
  for (const p of readFileSync(process.env.FAKE_LEDGER, 'utf8').split('\\n').filter(Boolean)) {
    if ((p === root || p.startsWith(root + '/')) && existsSync(p)) chmodSync(p, statSync(p).isDirectory() ? 0o777 : 0o666);
  }
  process.exit(0);
}
die('unexpected entrypoint ' + entry);
`;
// find -user 65532 (the only ownership question the jobs ask): the first ledgered path under the root that still exists.
const FAKE_FIND = `import { existsSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2), root = a[0];
if (JSON.stringify(a.slice(1)) !== JSON.stringify(['-mindepth', '1', '-user', '65532', '-print', '-quit'])) { console.error('fake find: ' + a.join(' ')); process.exit(9); }
const hit = readFileSync(process.env.FAKE_LEDGER, 'utf8').split('\\n').find((p) => p && p.startsWith(root + '/') && existsSync(p));
if (hit) console.log(hit);
`;

// One self-hosted runner: its _temp, a workspace with the candidate (GitHub's merge of a pull request) and the trusted
// base, and the stand-ins on PATH.
function runner(name) {
  const ws = path.join(TMP, name);
  const temp = path.join(ws, '_temp');
  const bin = path.join(ws, '_bin');
  for (const d of [temp, bin, path.join(ws, 'trusted', 'scripts', 'ci'), path.join(ws, 'pr')]) mkdirSync(d, { recursive: true });
  const pr = path.join(ws, 'pr');
  git(pr, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(pr, 'a.txt'), 'a\n');
  mkdirSync(path.join(pr, 'src', 'deep'), { recursive: true });
  writeFileSync(path.join(pr, 'src', 'deep', 'b.txt'), 'b\n');
  git(pr, 'add', '-A'); git(pr, 'commit', '-q', '-m', 'base');
  const base = git(pr, 'rev-parse', 'HEAD');
  git(pr, 'checkout', '-q', '-b', 'work');
  writeFileSync(path.join(pr, 'c.txt'), 'c\n');
  git(pr, 'add', '-A'); git(pr, 'commit', '-q', '-m', 'change');
  const head = git(pr, 'rev-parse', 'HEAD');
  const candidate = path.join(ws, 'candidate');
  git(TMP, 'clone', '-q', '--no-local', pr, candidate);
  git(candidate, 'checkout', '-q', '--detach', base);
  git(candidate, 'merge', '-q', '--no-ff', '--no-edit', head);
  const sha = git(candidate, 'rev-parse', 'HEAD');
  copyFileSync(path.join(ROOT, '.gitleaks.toml'), path.join(ws, 'trusted', '.gitleaks.toml'));
  copyFileSync(path.join(ROOT, 'scripts', 'ci', 'gitleaks-range.sh'), path.join(ws, 'trusted', 'scripts', 'ci', 'gitleaks-range.sh'));
  writeFileSync(path.join(bin, 'fake-docker.mjs'), FAKE_DOCKER);
  writeFileSync(path.join(bin, 'fake-find.mjs'), FAKE_FIND);
  const realFind = spawnSync(BASH, ['-c', 'command -v find'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\nFAKE_SELF="$(id -u):$(id -g)" exec "${NODE}" "${fwd(path.join(bin, 'fake-docker.mjs'))}" "$@"\n`);
  writeFileSync(path.join(bin, 'find'), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = 65532 ] && exec "${NODE}" "${fwd(path.join(bin, 'fake-find.mjs'))}" "$@"; done\nexec "${realFind}" "$@"\n`);
  chmodSync(path.join(bin, 'docker'), 0o755);
  chmodSync(path.join(bin, 'find'), 0o755);
  const ledger = path.join(ws, 'ledger');
  writeFileSync(ledger, '');
  const env = { GITHUB_WORKSPACE: fwd(ws), RUNNER_TEMP: fwd(temp), GITHUB_SHA: sha, FAKE_LEDGER: fwd(ledger), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { ws, temp, ledger, env, range: { EVENT_NAME: 'pull_request', PR_BASE: base, PR_HEAD: head, PUSH_BASE: '' } };
}

// The runner's own cleanup of _temp at the start and end of every job (actions/runner TempDirectoryManager ->
// IOUtil.DeleteDirectory(_temp, contentsOnly: true, continueOnContentDeleteError: true)): files first, their errors
// ignored; then directories from the longest path to the shortest, stopping at the first that cannot be deleted.
function runnerCleanup(temp) {
  const files = [], dirs = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { dirs.push(p); walk(p); } else files.push(p); } };
  try { walk(temp); } catch (e) { return e.code; }
  for (const f of files) { try { unlinkSync(f); } catch { /* continueOnContentDeleteError */ } }
  for (const d of dirs.sort((x, y) => y.length - x.length)) { try { rmdirSync(d); } catch (e) { return e.code; } }
  return null;
}

// A job's steps after its temporary storage is configured, in order, as the runner runs them (default shell bash -e;
// shell: bash adds pipefail), stopping at the first failure. Expressions in a step's env come from the event's range and
// earlier steps' outputs; GITHUB_ENV lines reach later steps.
function runJob(r, id) {
  const steps = workflow().jobs[id].steps;
  const from = steps.findIndex((s) => s.name === CONFIGURE);
  assert.ok(from > 0, `${id}: ${CONFIGURE}`);
  const output = path.join(r.temp, '..', `${id}.output`), genv = path.join(r.temp, '..', `${id}.env`);
  writeFileSync(output, ''); writeFileSync(genv, '');
  let out = '';
  for (const s of steps.slice(from + 1)) {
    assert.ok(typeof s.run === 'string', `${id}/${s.name}: a run step`);
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const known = { ...r.range, BASE: outputs.base, HEAD: outputs.head };
    const stepEnv = Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => {
      if (!String(v).includes('${{')) return [k, String(v)];
      assert.ok(known[k] !== undefined, `${id}/${s.name}: no value for ${k}`);
      return [k, known[k]];
    }));
    const exported = Object.fromEntries(readFileSync(genv, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const cwd = path.join(r.ws, s['working-directory'] ?? '.');
    const shell = s.shell === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail', '-c'] : ['-e', '-c'];
    const p = spawnSync(BASH, [...shell, s.run], { cwd, encoding: 'utf8', timeout: 120000,
      env: { ...ENV, ...r.env, GITHUB_OUTPUT: fwd(output), GITHUB_ENV: fwd(genv), ...exported, ...stepEnv } });
    out += `--- ${id}: ${s.name}\n${p.stdout || ''}${p.stderr || ''}`;
    if (p.status !== 0) return { code: p.status, out, failed: s.name };
  }
  return { code: 0, out };
}
// One runner job: cleanup, the job's steps, cleanup.
function job(r, id) {
  runnerCleanup(r.temp);
  const result = runJob(r, id);
  result.cleanup = runnerCleanup(r.temp);
  return result;
}
const leftovers = (temp) => readdirSync(temp);

test('trivy then gitleaks on one runner, twice: the second round passes and _temp is empty after cleanup', { skip: dynamicSkip }, () => {
  const r = runner('two-rounds');
  const first = SCANS.map((id) => job(r, id));
  const second = SCANS.map((id) => job(r, id));
  const report = [...first, ...second].map((x) => `exit ${x.code}${x.failed ? ` at "${x.failed}"` : ''}, cleanup ${x.cleanup ?? 'complete'}\n${x.out}`).join('\n');
  for (const x of [...first, ...second]) assert.equal(x.code, 0, report);
  for (const x of [...first, ...second]) assert.equal(x.cleanup, null, `the runner's cleanup completes\n${report}`);
  assert.deepEqual(leftovers(r.temp), [], report);
});

test('a runner polluted by the old 65532 containers is reclaimed once, then reports none', { skip: dynamicSkip }, () => {
  const r = runner('polluted');
  // What a 65532 trivy and a later gitleaks left: a DB and checks subtree it owns, and the runner-owned directories
  // the aborted cleanup kept.
  const foreign = ['clued-trivy-db-1/db/metadata.json', 'clued-trivy-db-1/db/trivy.db', 'clued-trivy-checks/policy/metadata.json',
    'clued-trivy-checks/policy/content/policies/kubernetes/k.rego'];
  const made = [];
  for (const rel of foreign) {
    let dir = r.temp;
    for (const part of path.posix.dirname(rel).split('/')) { dir = path.join(dir, part); if (!existsSync(dir)) { mkdirSync(dir); made.push(dir); } }
    writeFileSync(path.join(r.temp, rel), 'x');
    made.push(path.join(r.temp, rel));
  }
  // The stage and checks roots are the runner's own (made by mkdir); what 65532 wrote is below them.
  const owned = made.filter((p) => !['clued-trivy-db-1', 'clued-trivy-checks'].includes(path.relative(r.temp, p)));
  appendFileSync(r.ledger, owned.map((p) => fwd(p) + '\n').join(''));
  for (const p of owned.reverse()) if (lstatSync(p).isDirectory()) chmodSync(p, 0o555);
  for (const d of ['clued-trivy-snapshot/src/deep', 'clued-gitleaks/repo', 'clued-trivy-empty']) mkdirSync(path.join(r.temp, d), { recursive: true });
  assert.ok(runnerCleanup(r.temp), 'precondition: the runner cleanup stops at the 65532 subtree');
  assert.ok(existsSync(path.join(r.temp, 'clued-trivy-snapshot')), 'precondition: the snapshot survives the cleanup');

  const results = [...SCANS, ...SCANS].map((id) => job(r, id));
  const report = results.map((x) => `exit ${x.code}${x.failed ? ` at "${x.failed}"` : ''}, cleanup ${x.cleanup ?? 'complete'}\n${x.out}`).join('\n');
  for (const x of results) assert.equal(x.code, 0, report);
  assert.match(results[0].out, /clued-scan-reclaim: reclaimed/, report);
  for (const x of results.slice(1)) assert.match(x.out, /clued-scan-reclaim: none/, report);
  for (const x of results) assert.equal(x.cleanup, null, report);
  assert.deepEqual(leftovers(r.temp), [], report);
});

// Every docker run of the two scan jobs runs as the job account, so what it writes into the job's directories is the
// runner's to delete. (cache_run takes its writable mount from its callers, so the rule is every docker run, not only
// those whose own text names a writable mount.) The one exception is the transitional reclaim, a 65532 find/chmod.
const logical = (run) => run.replace(/\\\n\s*/g, ' ').split('\n');
test('the scan containers run as the job account, without the permissions opened for uid 65532', () => {
  const { jobs } = workflow();
  const reclaim = SCANS.map((id) => jobs[id].steps.find((s) => s.name === RECLAIM));
  for (const [i, id] of SCANS.entries()) {
    const steps = jobs[id].steps;
    let runs = 0;
    for (const s of steps.filter((x) => typeof x.run === 'string')) {
      for (const line of logical(s.run).filter((l) => /\bdocker run\b/.test(l))) {
        runs++;
        if (s === reclaim[i]) {
          assert.match(line, /--user=65532:65532 /, `${id}/${s.name}`);
          assert.match(line, /--network=none /, `${id}/${s.name}`);
          assert.match(line, / find "\$TRIVY_IMAGE" \/t -user 65532 -exec chmod a\+rwX \{\} \+/, `${id}/${s.name}: only 65532's own files`);
          continue;
        }
        assert.match(line, /--user="\$\(id -u\):\$\(id -g\)" /, `${id}/${s.name}: ${line}`);
        if (/--tmpfs=/.test(line)) assert.match(line, /--tmpfs=\S*,uid="\$\(id -u\)",gid="\$\(id -g\)"( |$)/, `${id}/${s.name}: ${line}`);
      }
      if (s === reclaim[i]) continue;
      assert.doesNotMatch(s.run, /65532/, `${id}/${s.name}: no uid 65532 outside the reclaim`);
      assert.doesNotMatch(s.run, /\bchmod\b|mkdir -m|\b0777\b|a\+w|a\+rX/, `${id}/${s.name}: no permission opened for another uid`);
    }
    assert.ok(reclaim[i], `${id}: a "${RECLAIM}" step`);
    assert.equal(steps.indexOf(reclaim[i]), steps.findIndex((s) => s.name === CONFIGURE) + 1, `${id}: reclaim right after ${CONFIGURE}`);
    assert.equal(reclaim[i].run, reclaim[0].run, `${id}: the same reclaim as trivy`);
    assert.deepEqual(reclaim[i].env, reclaim[0].env, `${id}: the same reclaim env as trivy`);
    assert.ok(runs >= (id === 'trivy' ? 6 : 2), `${id}: its docker runs were found (${runs})`);
  }
});
