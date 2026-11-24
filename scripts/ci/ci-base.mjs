// The one rule for CI_BASE_SHA: the main commit the tested tree is built on, always an ancestor of it.
//
// Every required job (clued-required-tests.yml, clued-required-tests-windows.yml, hosted-required.yml) runs this in its
// "Resolve push baseline before loading trusted commands" step (id train-base), before the trusted checkout and before any
// candidate code. The step loads this file from origin/main (git show, then a data: URL import), so it imports nothing
// but Node's built-ins; the staging walk is the runner hook's, read from main the same way.
//
//   pull_request       GITHUB_SHA is GitHub's merge of the head into main: its first parent, the main commit the
//                      candidate contains. Not the event's pull_request.base.sha: that is the head's old merge base once
//                      main has moved on since the head last merged it, older than main commits the candidate holds
//                      (#1292: R9_REREGISTER_BASE_BEHIND, every suite comparing with a base measured main's newer
//                      commits as this change).
//   push main          the event's before, main's previous tip (S^1 for a pull request's merge commit, T for a train
//                      fast-forward to S); it must be an ancestor of GITHUB_SHA.
//   push staging       T, the root of S's member chain (ADR 0019); also the trusted checkout's ref (output sha).
//   workflow_dispatch  a lost-run recovery tests the PR head itself, unmerged: git merge-base origin/main <head>, the
//                      newest main commit it contains (FABLE-dispatch-base-20261122 §2.2).
//   anything else      fails: no event gets an empty base by being forgotten here.
//
// Writes ci_base=<sha> (and sha=<T> on staging) to GITHUB_OUTPUT and CI_BASE_SHA=<sha> to GITHUB_ENV, so every later
// step of the job reads the same value; no step sets CI_BASE_SHA itself (ci-base.test.mjs checks the three workflows).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const SHA = /^[0-9a-f]{40}$/;
const STAGING_REF = 'refs/heads/clued-train/staging';
const MAIN_REF = 'refs/heads/main';

function gitIn(cwd) {
  const run = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const rev = (spec, what) => {
    const r = run('rev-parse', '--verify', '--quiet', `${spec}^{commit}`);
    const sha = r.status === 0 ? r.stdout.trim() : '';
    if (!SHA.test(sha)) throw new Error(`${what}: ${spec} is not a commit in this checkout`);
    return sha;
  };
  const isAncestor = (a, b) => {
    const r = run('merge-base', '--is-ancestor', a, b);
    if (r.status === 0 || r.status === 1) return r.status === 0;
    throw new Error(`cannot compare ${a} with ${b}: ${r.stderr.trim()}`);
  };
  return { run, rev, isAncestor };
}

async function stagingRoot(sha, cwd) {
  const hook = execFileSync('git', ['show', 'origin/main:scripts/runner/clued-runner-job-started.mjs'], { cwd });
  const { stagingBaseFromCheckout } = await import(`data:text/javascript;base64,${hook.toString('base64')}`);
  return stagingBaseFromCheckout(sha, { cwd });
}

// { ci_base, sha? }; throws, naming the event, when no base can be given.
export async function resolveCiBase({ eventName, ref, sha, event = {}, cwd = process.cwd() }) {
  if (!SHA.test(String(sha ?? ''))) throw new Error(`GITHUB_SHA is not a commit id: '${sha ?? ''}'`);
  const git = gitIn(cwd);
  if (eventName === 'pull_request') {
    const head = event.pull_request?.head?.sha;
    const second = git.run('rev-parse', '--verify', '--quiet', `${sha}^2`).stdout.trim();
    if (!SHA.test(String(head ?? '')) || second !== head) {
      throw new Error(`pull_request: ${sha} is not GitHub's merge of the head ${head ?? '(none in the event)'} into main`);
    }
    return { ci_base: git.rev(`${sha}^1`, 'pull_request') };
  }
  if (eventName === 'workflow_dispatch') {
    const r = git.run('merge-base', 'origin/main', sha);
    const base = r.stdout.trim();
    if (r.status !== 0 || !SHA.test(base)) throw new Error(`workflow_dispatch: ${sha} has no history in common with origin/main`);
    return { ci_base: base };
  }
  if (eventName === 'push' && ref === STAGING_REF) {
    const root = await stagingRoot(sha, cwd);
    if (!SHA.test(String(root ?? ''))) throw new Error(`push ${ref}: no chain root for ${sha}`);
    return { sha: root, ci_base: root };
  }
  if (eventName === 'push' && ref === MAIN_REF) {
    const before = event.before;
    if (!SHA.test(String(before ?? '')) || /^0+$/.test(before)) throw new Error(`push ${ref}: the event has no previous tip (before: '${before ?? ''}')`);
    const base = git.rev(before, `push ${ref}`);
    if (base === sha || !git.isAncestor(base, sha)) throw new Error(`push ${ref}: the previous tip ${base} is not an ancestor of ${sha}`);
    return { ci_base: base };
  }
  throw new Error(`No CI base is defined for the ${eventName || '(unnamed)'} event${eventName === 'push' ? ` to ${ref}` : ''}.`);
}

// The step's entry: reads GitHub's own variables, writes the outputs and CI_BASE_SHA, exits non-zero with a reason.
export async function writeCiBase(env = process.env, { cwd = process.cwd(), log = console.log } = {}) {
  try {
    const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const result = await resolveCiBase({ eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA, event, cwd });
    if (!env.GITHUB_OUTPUT || !env.GITHUB_ENV) throw new Error('GITHUB_OUTPUT and GITHUB_ENV are required');
    appendFileSync(env.GITHUB_OUTPUT, `${result.sha ? `sha=${result.sha}\n` : ''}ci_base=${result.ci_base}\n`);
    appendFileSync(env.GITHUB_ENV, `CI_BASE_SHA=${result.ci_base}\n`);
    log(`CI_BASE_SHA=${result.ci_base} (${env.GITHUB_EVENT_NAME} ${env.GITHUB_REF})`);
    return 0;
  } catch (error) {
    log(`::error title=CI base::${error.message}`);
    process.exitCode = 1;
    return 1;
  }
}
