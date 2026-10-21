// Read-only GitHub port for the companion's hint mode (free-minutes design S20). Same method names and
// normalized reply shapes as the installed checks port's relay reads (independent-ci-v1/src/github.mjs:
// readPullRequest, readBranchHead, readCompare, readChangedPaths, readGitCommit, readGitTree,
// readCheckRunsByName, readChecks, readCheckRunAnnotations), but over the Owner's own `gh` login with fixed
// argv (`gh api --method GET <route>`): no token is read, nothing is written, every route is built here from
// validated values. Its answers are hints only; stage R re-reads everything with the App's own token.
import { HEX40, check } from './canonical.mjs';

const MAX_PAGES = 30;
const positive = v => Number.isSafeInteger(v) && v > 0;
const safePath = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\\]/.test(v) && !v.startsWith('/')
  && !v.split('/').some(p => p === '' || p === '.' || p === '..');
const code = c => { throw Object.assign(new Error(c), { code: c }); };

export function createGhReadPort({ ghExe, repo, run, timeoutMs = 60_000 }) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') && typeof run === 'function', 'GH_READ_PORT_CONFIG_INVALID');
  async function get(route) {
    check(typeof route === 'string' && /^[A-Za-z0-9_./?&=%:-]+$/.test(route) && !route.split(/[/?]/).some(p => p === '' || p === '.' || p === '..'), 'GH_READ_ROUTE_REFUSED');
    const r = await run([ghExe, 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/${route}`], { timeoutMs });
    if (r.code !== 0) code('github_read_unavailable');
    try { return JSON.parse(r.stdout); } catch { return code('github_read_invalid'); }
  }
  async function inventory(headSha, checkName = null) {
    check(HEX40.test(headSha ?? ''), 'GH_READ_SUBJECT_INVALID');
    const named = checkName === null ? '' : `check_name=${encodeURIComponent(checkName)}&`;
    const checks = []; let expected = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const reply = await get(`commits/${headSha}/check-runs?${named}filter=all&per_page=100&page=${page}`);
      if (!Number.isSafeInteger(reply?.total_count) || !Array.isArray(reply.check_runs) || reply.check_runs.length > 100 || (expected !== null && expected !== reply.total_count)) code('checks_pagination_changed');
      expected = reply.total_count; checks.push(...reply.check_runs);
      if (checks.length === expected) {
        if (new Set(checks.map(c => c.id)).size !== checks.length || checks.some(c => !positive(c.id) || c.head_sha !== headSha || (checkName !== null && c.name !== checkName))) code('invalid_check_set');
        return { complete: true, checks };
      }
      if (checks.length > expected || reply.check_runs.length < 100) code('incomplete_checks');
    }
    return code('checks_page_limit');
  }
  return Object.freeze({
    fixture: false,
    async readPullRequest(number) { check(positive(number), 'GH_READ_SUBJECT_INVALID'); return get(`pulls/${number}`); },
    async readBranchHead(name) {
      check(typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name), 'GH_READ_SUBJECT_INVALID');
      const b = await get(`branches/${name}`);
      if (b?.name !== name || !HEX40.test(b.commit?.sha ?? '')) code('invalid_branch_reply');
      return { name, sha: b.commit.sha };
    },
    async readCompare(baseSha, headSha) {
      check(HEX40.test(baseSha ?? '') && HEX40.test(headSha ?? ''), 'GH_READ_SUBJECT_INVALID');
      const b = await get(`compare/${baseSha}...${headSha}?per_page=1`);
      if (!['ahead', 'behind', 'diverged', 'identical'].includes(b?.status) || !Number.isSafeInteger(b.ahead_by) || !Number.isSafeInteger(b.behind_by)
        || b.base_commit?.sha !== baseSha || !HEX40.test(b.merge_base_commit?.sha ?? '')) code('invalid_compare_reply');
      return { baseSha, headSha, status: b.status, aheadBy: b.ahead_by, behindBy: b.behind_by, mergeBaseSha: b.merge_base_commit.sha };
    },
    async readChangedPaths(job) {
      check(job?.repo === repo && positive(job.pr) && HEX40.test(job.headSha ?? '') && HEX40.test(job.baseSha ?? ''), 'GH_READ_SUBJECT_INVALID');
      const before = await get(`pulls/${job.pr}`);
      const exactPr = p => p?.number === job.pr && p.state === 'open' && p.head?.sha === job.headSha && p.base?.sha === job.baseSha && p.base?.ref === 'main'
        && Number.isSafeInteger(p.changed_files) && p.changed_files > 0 && p.changed_files <= 3000;
      if (!exactPr(before)) code('pr_subject_changed');
      const names = new Set(), paths = new Set();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const files = await get(`pulls/${job.pr}/files?per_page=100&page=${page}`);
        if (!Array.isArray(files) || files.length > 100) code('invalid_pr_files');
        for (const f of files) {
          if (!safePath(f?.filename) || names.has(f.filename) || (f.status === 'renamed' && !safePath(f.previous_filename))) code('invalid_pr_files');
          names.add(f.filename); paths.add(f.filename); if (f.status === 'renamed') paths.add(f.previous_filename);
        }
        if (names.size === before.changed_files) {
          const after = await get(`pulls/${job.pr}`);
          if (!exactPr(after) || after.changed_files !== before.changed_files) code('pr_subject_changed');
          return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: [...paths].sort() };
        }
        if (names.size > before.changed_files || files.length < 100) code('incomplete_pr_files');
      }
      return code('pr_files_page_limit');
    },
    async readGitCommit(sha) {
      check(HEX40.test(sha ?? ''), 'GH_READ_SUBJECT_INVALID');
      const b = await get(`git/commits/${sha}`);
      if (b?.sha !== sha || !HEX40.test(b.tree?.sha ?? '') || !Array.isArray(b.parents) || b.parents.length > 16 || b.parents.some(p => !HEX40.test(p?.sha ?? ''))) code('invalid_commit_reply');
      return { sha, tree: b.tree.sha, parents: b.parents.map(p => p.sha) };
    },
    async readGitTree(sha) {
      check(HEX40.test(sha ?? ''), 'GH_READ_SUBJECT_INVALID');
      const b = await get(`git/trees/${sha}`);
      if (b?.sha !== sha || b.truncated !== false || !Array.isArray(b.tree) || b.tree.length > 100_000) code('invalid_tree_reply');
      const names = new Set();
      return { sha, entries: b.tree.map(e => {
        if (typeof e?.path !== 'string' || !e.path || e.path.includes('/') || names.has(e.path) || !/^[0-7]{6}$/.test(e.mode ?? '') || !['blob', 'tree', 'commit'].includes(e.type) || !HEX40.test(e.sha ?? '')) code('invalid_tree_reply');
        names.add(e.path);
        return { name: e.path, mode: e.mode, type: e.type, sha: e.sha };
      }) };
    },
    async readCheckRunsByName(headSha, name) {
      check(typeof name === 'string' && name.length > 0 && name.length <= 100 && !/[\x00-\x1f]/.test(name), 'GH_READ_SUBJECT_INVALID');
      return inventory(headSha, name);
    },
    async readChecks(headSha) { return inventory(headSha); },
    async readCheckRunAnnotations(id, expectedCount) {
      check(positive(id) && Number.isSafeInteger(expectedCount) && expectedCount >= 0 && expectedCount <= 100 * MAX_PAGES, 'GH_READ_SUBJECT_INVALID');
      const annotations = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1 && annotations.length === expectedCount) break;
        const list = await get(`check-runs/${id}/annotations?per_page=100&page=${page}`);
        if (!Array.isArray(list) || list.length > 100) code('invalid_annotations_reply');
        for (const a of list) {
          if (!['notice', 'warning', 'failure'].includes(a?.annotation_level) || typeof a.message !== 'string' || a.message.length > 65_536
            || !(a.title === null || a.title === undefined || typeof a.title === 'string') || typeof a.path !== 'string') code('invalid_annotations_reply');
          annotations.push({ level: a.annotation_level, title: a.title ?? '', message: a.message, path: a.path });
        }
        if (annotations.length > expectedCount) code('annotations_changed');
        if (list.length < 100) break;
      }
      if (annotations.length !== expectedCount) code('incomplete_annotations');
      return { complete: true, checkRunId: id, annotations };
    },
  });
}
