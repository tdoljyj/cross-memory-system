import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
const app = 'apps/clued-cloud';
const migrations = `${app}/supabase/migrations`;
const acceptDoorTest = `${app}/tests/owner-grants-fleet-accept-door-db.test.mjs`;
const tests = [acceptDoorTest, `${app}/tests/fleet-delivery-release-db.test.mjs`];
const sha = /^[0-9a-f]{40}$/;
export const PREVIOUS_INTERFACE_TIMEOUT_MS = 12 * 60_000;

// 同时散列路径、模式与实际 blob 字节，Windows 和 Linux 对同一提交得出同一摘要。
export function migrationTreeDigest(commit, root = checkout) {
  if (!sha.test(commit)) throw new Error('FLEET_PREVIOUS_TEST_SUBJECT_REFUSED');
  const raw = execFileSync('git', ['ls-tree', '-rz', commit, '--', migrations], { cwd: root, maxBuffer: 4 << 20 });
  if (!raw.length) throw new Error('FLEET_PREVIOUS_MIGRATIONS_MISSING');
  const objects = raw.toString('utf8').slice(0, -1).split('\0').map(record => {
    const match = /^\d{6} blob ([0-9a-f]{40})\t/.exec(record);
    if (!match) throw new Error('FLEET_PREVIOUS_MIGRATIONS_INVALID');
    return match[1];
  });
  const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: objects.join('\n') + '\n', maxBuffer: 64 << 20 });
  return createHash('sha256').update(raw).update(blobs).digest('hex');
}

// Run the prior commit's assertions and helpers unchanged, against an isolated
// PostgreSQL initialized with the candidate commit's committed migrations.
export async function previousInterfaceCheck({ commit, previous, timeoutMs, root = checkout, testReader }) {
  if (!sha.test(commit) || !sha.test(previous.commit) || commit === previous.commit) throw new Error('FLEET_PREVIOUS_TEST_SUBJECT_REFUSED');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-previous-interfaces-'));
  const tree = path.join(stage, 'tree');
  const archive = path.join(stage, 'tree.tar');
  const signal = AbortSignal.timeout(Math.min(timeoutMs, PREVIOUS_INTERFACE_TIMEOUT_MS));
  // The isolated cluster and old test code receive no publisher credentials or
  // database configuration. The selector prepares locked dependencies in the staged checkout.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|LOCALAPPDATA|PROGRAMDATA|PUBLIC|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
  const options = { cwd: root, env, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  const tar = process.platform === 'win32' ? path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const extract = async (revision, files = []) => {
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, revision, '--', ...files], options);
    await exec(tar, ['-xf', archive, '-C', tree], options);
  };
  try {
    await exec('git', ['merge-base', '--is-ancestor', previous.commit, commit], options);
    await exec('git', ['clone', '--shared', '--no-checkout', '--no-tags', '--template=', '--', root, tree], options);
    const stagedOptions = { ...options, cwd: tree };
    await exec('git', ['update-ref', '--no-deref', 'HEAD', previous.commit], stagedOptions);
    await exec('git', ['update-ref', 'refs/remotes/origin/main', commit], stagedOptions);
    // 上一代的封存包演练通过 git ls-files 取源文件清单及模式。
    await exec('git', ['read-tree', previous.commit], stagedOptions);
    // 列车演练把 Worker 及其 app 依赖一起打包，封存包演练还会读取源闭包里的工作流和扫描配置。
    await extract(previous.commit, [`${app}/tests`, `${app}/scripts`, `${app}/worker`, `${app}/app`,
      `${app}/package.json`, `${app}/package-lock.json`, `${app}/.npmrc`, 'scripts',
      'work/independent-ci-resident-v1', 'work/actions-hosted-migration', 'config', '.github/workflows', '.gitleaks.toml']);
    await extract(commit, [migrations]);
    const files = [];
    for (const file of tests) {
      try { if ((await fs.lstat(path.join(tree, file))).isFile()) files.push(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!files.length) throw new Error('FLEET_PREVIOUS_TESTS_MISSING');
    if (files.includes(acceptDoorTest)) {
      // 历史夹具在创建后不足 1 毫秒读回时仍可能处于待确认。只修正临时回放树中这条已知的夹具 SQL。
      const fixture = path.join(tree, acceptDoorTest);
      const source = await fs.readFile(fixture, 'utf8');
      const fixtureEnd = '\n      where id=$1`, [lapsed.request_id]);';
      const legacy = "update clued_private.owner_requests_v1 set expires_at=greatest(created_at+interval '1 millisecond',clock_timestamp())";
      const stable = `update clued_private.owner_requests_v1 set
      created_at=statement_timestamp()-interval '2 seconds',
      expires_at=statement_timestamp()-interval '1 second'`;
      const fixed = source.replace(legacy + fixtureEnd, stable + fixtureEnd);
      if (fixed !== source) await fs.writeFile(fixture, fixed);
    }
    const { stdout } = await exec(process.execPath, [path.join(root, 'scripts/ci/ci-required-selection.mjs'),
      '--root', tree, '--run-files', 'production-schema', ...files, '--only-named',
      ...(testReader === undefined ? [] : ['--runtime-reader', testReader])], options);
    // A command that selected nothing (or skipped its test) is never a pass.
    if (!/^ℹ pass [1-9][0-9]*$/m.test(stdout) || !/^ℹ skipped 0$/m.test(stdout) || /^ℹ (?:skipped|cancelled) [1-9]/m.test(stdout)) {
      throw new Error('FLEET_PREVIOUS_TESTS_NOT_EXECUTED');
    }
    return { status: 'PASS', commit, previousCommit: previous.commit, migrationsSha256: migrationTreeDigest(commit, root), files };
  } finally {
    await fs.rm(stage, { recursive: true, force: true, maxRetries: 3 });
  }
}
