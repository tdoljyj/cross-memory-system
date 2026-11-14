// Read-only object access to one repository: no checkout, no worktree file, no user or system git configuration.
// Used by the offline scan-start cutover plan to read a frozen commit.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SHA1 = /^[a-f0-9]{40}$/;
const fail = (code, detail) => { throw Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) }); };
const insist = (condition, code, detail) => { if (!condition) fail(code, detail); };

export const gitBlobSha1 = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function gitObjectReader(repoDir, { git = 'git' } = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const run = (args, { binary = false } = {}) => {
    const result = spawnSync(git, ['-C', repoDir, '-c', 'core.quotepath=off', ...args], { env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0) fail('GIT_OBJECT_READ_FAILED', args[0]);
    return binary ? result.stdout : result.stdout.toString('utf8');
  };
  const entries = new Map(), blobs = new Map();
  return Object.freeze({
    resolve(rev) {
      insist(typeof rev === 'string' && /^[A-Za-z0-9_./^{}~-]{1,200}$/.test(rev) && !rev.startsWith('-'), 'GIT_OBJECT_COMMIT_INVALID');
      const commit = run(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
      const tree = run(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]).trim();
      insist(SHA1.test(commit) && SHA1.test(tree), 'GIT_OBJECT_COMMIT_INVALID');
      return { commit, tree };
    },
    // One path, never a pathspec glob: `:(literal)` disables magic.
    entry(commit, file) {
      insist(SHA1.test(commit), 'GIT_OBJECT_COMMIT_INVALID');
      const cacheKey = `${commit}\0${file}`;
      if (entries.has(cacheKey)) return entries.get(cacheKey);
      const out = run(['ls-tree', '-z', '--full-tree', commit, '--', `:(literal)${file}`]);
      let found = null;
      if (out !== '') {
        const records = out.split('\0').filter(Boolean);
        insist(records.length === 1, 'GIT_OBJECT_TREE_AMBIGUOUS', file);
        const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/s.exec(records[0]);
        insist(match && match[4] === file, 'GIT_OBJECT_TREE_AMBIGUOUS', file);
        found = { mode: match[1], type: match[2], sha: match[3] };
      }
      entries.set(cacheKey, found);
      return found;
    },
    blob(sha) {
      insist(SHA1.test(sha), 'GIT_OBJECT_BLOB_INVALID');
      if (!blobs.has(sha)) blobs.set(sha, run(['cat-file', 'blob', sha], { binary: true }));
      return blobs.get(sha);
    },
  });
}
