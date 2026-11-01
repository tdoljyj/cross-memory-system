// Bounded read-only collection of the GitHub facts attest.mjs needs (design
// S16). Every read goes through the installed checks port (src/github.mjs):
// the fixed https://api.github.com origin and the unchanged checks:write /
// contents:read / pull_requests:read token. Nothing from the PR is executed;
// file contents are never fetched, only tree entries (mode, type, blob id).
//
// observe({ repo, pr, headSha, baseSha, roles }) -> facts (FACTS_CONTRACT)
// Throws RELAY_OBSERVATION_UNCONFIRMED (detail: the port code) when a read
// that every verdict depends on fails. Optional reads (PR files when E1
// already fails, billing annotations, the identity annotation, the merge
// commit) record null plus an error code and let attest decide.
import { FACTS_CONTRACT, isBillingRefusal } from './attest.mjs';
import { decodeJwtUnverified, tokenFromAnnotation } from './oidc.mjs';
import { HOSTED_APP_ID, isValidatedRegistry, relayFail } from './registry.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const METHODS = ['readPullRequest', 'readBranchHead', 'readCompare', 'readChangedPaths', 'readGitCommit', 'readGitTree',
  'readCheckRunsByName', 'readChecks', 'readCheckRunAnnotations'];
const code = error => (typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.code) ? error.code : 'unconfirmed');

export function createHostedRelayObserver({ github, registry, clock = Date.now, maxBillingReads = 6 } = {}) {
  if (!isValidatedRegistry(registry) || METHODS.some(name => typeof github?.[name] !== 'function') || typeof clock !== 'function'
    || !Number.isSafeInteger(maxBillingReads) || maxBillingReads < 0 || maxBillingReads > 20) relayFail('RELAY_OBSERVER_NOT_CONFIGURED');
  const mandatory = async (step, read) => { try { return await read(); } catch (error) { relayFail('RELAY_OBSERVATION_UNCONFIRMED', `${step}:${code(error)}`); } };

  return Object.freeze({
    fixture: github.fixture === true,
    async observe({ repo, pr, headSha, baseSha, roles } = {}) {
      if (repo !== registry.repository || !Number.isSafeInteger(pr) || pr < 1 || !SHA1.test(headSha ?? '') || !SHA1.test(baseSha ?? '')
        || !Array.isArray(roles) || roles.length === 0 || new Set(roles).size !== roles.length
        || roles.some(role => !Object.hasOwn(registry.roles, role))) relayFail('RELAY_OBSERVATION_SUBJECT_INVALID');
      const errors = [];
      const raw = await mandatory('pull_request', () => github.readPullRequest(pr));
      const pullRequest = { number: raw?.number ?? null, state: raw?.state ?? null, draft: raw?.draft === true ? true : raw?.draft === false ? false : null,
        headSha: raw?.head?.sha ?? null, headRef: typeof raw?.head?.ref === 'string' ? raw.head.ref : null,
        headRepo: raw?.head?.repo?.full_name ?? null, headRepoId: Number.isSafeInteger(raw?.head?.repo?.id) ? raw.head.repo.id : null,
        baseRef: raw?.base?.ref ?? null, baseSha: raw?.base?.sha ?? null, baseRepo: raw?.base?.repo?.full_name ?? null,
        baseRepoId: Number.isSafeInteger(raw?.base?.repo?.id) ? raw.base.repo.id : null,
        changedFiles: Number.isSafeInteger(raw?.changed_files) ? raw.changed_files : null };
      const mainTip = (await mandatory('main', () => github.readBranchHead(registry.baseRef))).sha;
      const compare = await mandatory('compare', () => github.readCompare(mainTip, headSha));
      // readChangedPaths re-checks the PR subject itself; skip it when E1 already fails.
      let changedPaths = null;
      if (pullRequest.state === 'open' && pullRequest.headSha === headSha && pullRequest.baseSha === baseSha && pullRequest.baseRef === registry.baseRef
        && pullRequest.headRepo === repo && pullRequest.baseRepo === repo) {
        try {
          const packet = await github.readChangedPaths({ repo, pr, headSha, baseSha });
          changedPaths = { complete: packet?.complete === true, paths: Array.isArray(packet?.paths) ? [...packet.paths] : [] };
        } catch (error) { errors.push(`files:${code(error)}`); }
      }
      const headCommit = await mandatory('head_commit', () => github.readGitCommit(headSha));
      // E4: walk H's tree one directory at a time for every closure and forbidden path.
      const trees = new Map();
      const listing = treeSha => {
        if (!trees.has(treeSha)) trees.set(treeSha, mandatory('tree', () => github.readGitTree(treeSha)));
        return trees.get(treeSha);
      };
      const closure = {};
      const paths = new Set(roles.flatMap(role => [...registry.roles[role].closure.map(item => item.path), ...registry.roles[role].mustNotExist]));
      for (const file of [...paths].sort()) {
        const parts = file.split('/');
        let tree = headCommit.tree, found = null;
        for (const [index, part] of parts.entries()) {
          const entry = (await listing(tree)).entries.find(item => item.name === part) ?? null;
          if (entry === null) { found = null; break; }
          if (index === parts.length - 1) { found = { type: entry.type, mode: entry.mode, sha: entry.sha }; break; }
          // A non-directory on the way: report it at this path so that a closure
          // file does not match and a forbidden path counts as present.
          if (entry.type !== 'tree') { found = { type: entry.type, mode: entry.mode, sha: entry.sha, blockedAt: parts.slice(0, index + 1).join('/') }; break; }
          tree = entry.sha;
        }
        closure[file] = found;
      }
      // E5: the registered hosted job name, never the required check name.
      const hostedRuns = {};
      for (const role of roles) {
        const listed = await mandatory('hosted_runs', () => github.readCheckRunsByName(headSha, registry.roles[role].hostedCheckName));
        hostedRuns[role] = { complete: listed.complete === true, checks: listed.checks.map(check => ({ id: check.id, name: check.name,
          appId: check.app?.id ?? null, headSha: check.head_sha, status: check.status ?? null, conclusion: check.conclusion ?? null,
          startedAt: check.started_at ?? null, completedAt: check.completed_at ?? null, detailsUrl: check.details_url ?? null,
          annotationsCount: Number.isSafeInteger(check.output?.annotations_count) ? check.output.annotations_count : null })) };
      }
      const latest = role => hostedRuns[role].checks.filter(run => run.appId === HOSTED_APP_ID).reduce((a, b) => (!a || b.id > a.id ? b : a), null);
      // Billing refusal only classifies a fallback (receipt type); it is read
      // only when some role has no successful newest run, and is bounded.
      let billing = { observed: false, refused: false, refusedRunIds: [] };
      if (roles.some(role => !(latest(role)?.status === 'completed' && latest(role).conclusion === 'success'))) {
        try {
          const inventory = await github.readChecks(headSha);
          const failed = inventory.checks.filter(check => check.app?.id === HOSTED_APP_ID && check.status === 'completed' && check.conclusion === 'failure'
            && Number.isSafeInteger(check.output?.annotations_count) && check.output.annotations_count > 0 && check.output.annotations_count <= 50)
            .sort((a, b) => b.id - a.id).slice(0, maxBillingReads);
          const refusedRunIds = [];
          for (const check of failed) {
            const read = await github.readCheckRunAnnotations(check.id, check.output.annotations_count);
            if (read.annotations.some(isBillingRefusal)) refusedRunIds.push(check.id);
          }
          billing = { observed: true, refused: refusedRunIds.length > 0, refusedRunIds };
        } catch (error) { errors.push(`billing:${code(error)}`); }
      }
      // E6/E8: the identity annotation of the newest successful run (decoded from hex), and the
      // merge commit its (still unverified) token names.
      const tokenAnnotations = {}, merge = {};
      const commits = new Map(), compares = new Map();
      for (const role of roles) {
        tokenAnnotations[role] = null; merge[role] = null;
        const run = latest(role);
        if (!(run?.status === 'completed' && run.conclusion === 'success' && Number.isSafeInteger(run.annotationsCount))) continue;
        let matches;
        try {
          const read = await github.readCheckRunAnnotations(run.id, run.annotationsCount);
          matches = read.annotations.filter(item => item.title === registry.annotationTitle).map(item => tokenFromAnnotation(item.message));
          tokenAnnotations[role] = { checkRunId: run.id, complete: read.complete === true, matches };
        } catch (error) { errors.push(`annotations:${role}:${code(error)}`); continue; }
        if (matches.length !== 1) continue;
        let mergeSha;
        try { mergeSha = decodeJwtUnverified(matches[0]).claims.sha; } catch { continue; }
        if (!SHA1.test(mergeSha ?? '')) continue;
        try {
          if (!commits.has(mergeSha)) commits.set(mergeSha, github.readGitCommit(mergeSha));
          const commit = await commits.get(mergeSha);
          let baseCompare = null;
          if (commit.parents.length === 2) {
            const key = `${commit.parents[0]}...${mainTip}`;
            if (!compares.has(key)) compares.set(key, github.readCompare(commit.parents[0], mainTip));
            const c = await compares.get(key);
            baseCompare = { baseSha: c.baseSha, headSha: c.headSha, status: c.status, behindBy: c.behindBy };
          }
          merge[role] = { sha: commit.sha, tree: commit.tree, parents: [...commit.parents], baseCompare };
        } catch (error) { errors.push(`merge:${role}:${code(error)}`); }
      }
      return Object.freeze({ contract: FACTS_CONTRACT, repository: repo, pr, headSha, baseSha, roles: [...roles],
        observedAt: new Date(clock()).toISOString(), pullRequest, mainTip, compare,
        changedPaths, headCommit: { sha: headCommit.sha, tree: headCommit.tree }, closure, hostedRuns, billing,
        tokenAnnotations, merge, errors });
    },
  });
}

