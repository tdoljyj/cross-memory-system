// Pre-push check for a pull request that is pushed again under a claim (Clued-Work-Claim) it did not carry before.
//
//   node scripts/ci/pr-repush-preflight.mjs --repo owner/name --pr N --head <40-hex sha> --claim <uuid> [--scope global|project:<uuid>] [--body-governs]
//
// Run it BEFORE `git push`, with --head the full SHA of the branch head about to be pushed (from a main checkout, for example
// `$(git -C <branch checkout> rev-parse HEAD)`; plain `git rev-parse HEAD` there would name main's head) and --claim
// the claim that is live now (check it first with clued_work_verify, read-only). --scope defaults to global, as a missing
// Clued-Work-Scope line does. Exit 0 prints OK with the claim and scope checked; exit 1 lists every place that names another
// claim or scope and how to fix it (with --body-governs the head commit's places are NOTE lines instead, see below); exit 2
// is a usage, read or internal error (nothing was checked). It reads the PR body with `gh` and the commit message with local
// `git` (run it from any checkout whose object store holds --head), and never reads, prints or keeps a token or lease key.
//
// Why: the claim a head is judged under is whatever the PR names, read in two places with two parsers.
//   - The resident's poller (work/independent-ci-resident-v1/src/poller.mjs, TRAILER) proposes a PR only when its BODY has a
//     lower-case `Clued-Work-Claim:` line; a head commit trailer alone is never proposed.
//   - Admission (full-admission-v2.mjs, this directory's clued-work-admission.mjs#parseClaimReference) takes the body's
//     trailer, else the head commit's, and the scope line next to it (no scope line means `global`), and requires that
//     scope to be the node's.
// The parser is imported from THIS checkout's clued-work-admission.mjs, while admission runs main's copy: run the tool from a
// checkout of main (or a branch that does not change parseClaimReference) so both read the trailer alike.
// PR #992 (2026-11-04) was re-pushed under a new claim while its body still named the expired one: the resident refused
// it with CLAIM_NOT_CURRENT. Fix the body BEFORE the push. Editing it while a batch runs is worse: admission then
// refuses that batch with full_admission_claim_changed.
// The head commit's trailer is checked too when it has one, so the two never disagree (it decides whenever the body loses
// its trailer).
// --body-governs relaxes that for a head commit that cannot be amended (already reviewed, or pinned byte for byte): its
// trailer then names an older claim or scope while the body names the live one, and admission still passes because the body
// is read first. With the flag a mismatch in the head commit's trailer is printed as `NOTE (head-commit):`, also when the run
// fails on the body, and does not fail the run; every check on the body stays an error. Keep the body's trailer in place: if
// it is removed later, admission falls back to the stale head commit trailer and refuses.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseClaimReference } from './clued-work-admission.mjs';

// The poller's own test, character for character; pr-repush-preflight.test.mjs fails if poller.mjs changes it.
export const POLLER_TRAILER = /^Clued-Work-Claim:\s*[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*$/m;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^(global|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REPO_OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const REPO_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;   // `.github` is a valid name; `.` and `..` are refused below
const AMEND = 'then run this check again with the new SHA';

// Every mismatch between what the PR body and the head commit name and the claim and scope the push is meant for.
// scope defaults to 'global' and is always checked (a missing scope line reads as global); there is no "unchecked" value.
// With bodyGoverns the head commit's mismatches come back in `notes` (no `fix`) instead of `problems`; the body's are
// always problems.
export function checkRepush({ prBody, commitMessage, claim, scope = 'global', bodyGoverns = false }) {
  const problems = [], notes = [];
  const body = parseClaimReference(prBody);
  const pollerSees = POLLER_TRAILER.test(typeof prBody === 'string' ? prBody : '');
  if (!pollerSees) {
    problems.push({ where: 'pr-body', code: 'BODY_TRAILER_MISSING', found: body?.claim_id ?? null, expected: claim,
      fix: body
        ? `the body's Clued-Work-Claim line is not lower case, so the resident's poller skips the PR; write "Clued-Work-Claim: ${claim}"`
        : `add the line "Clued-Work-Claim: ${claim}" to the PR body: the resident never proposes a PR without it` });
  } else if (!body) {
    problems.push({ where: 'pr-body', code: 'BODY_TRAILER_UNPARSEABLE', found: null, expected: claim,
      fix: `the poller sees a claim line that admission cannot read (whitespace other than spaces and tabs, such as a line break, NBSP or vertical tab, after the colon or at the end of the line), so admission would fall back to the head commit; write "Clued-Work-Claim: ${claim}" on one line with plain spaces only` });
  } else if (body.claim_id !== claim) {
    problems.push({ where: 'pr-body', code: 'BODY_CLAIM_MISMATCH', found: body.claim_id, expected: claim,
      fix: `edit the PR body before the push: Clued-Work-Claim: ${claim}` });
  }
  if (body && body.scope !== scope) {
    problems.push({ where: 'pr-body', code: 'BODY_SCOPE_MISMATCH', found: body.scope, expected: scope,
      fix: scope === 'global' ? 'edit the PR body before the push: remove the Clued-Work-Scope line' : `edit the PR body before the push: Clued-Work-Scope: ${scope}` });
  }
  const commit = parseClaimReference(commitMessage);
  const commitIssue = (code, found, expected, fix) => {
    if (bodyGoverns) notes.push({ where: 'head-commit', code, found, expected });
    else problems.push({ where: 'head-commit', code, found, expected, fix });
  };
  if (commit && commit.claim_id !== claim) {
    commitIssue('COMMIT_CLAIM_MISMATCH', commit.claim_id, claim, `amend the head commit's trailer before the push (Clued-Work-Claim: ${claim}), ${AMEND}`);
  }
  if (commit && commit.scope !== scope) {
    commitIssue('COMMIT_SCOPE_MISMATCH', commit.scope, scope,
      scope === 'global' ? `amend the head commit to drop its Clued-Work-Scope trailer, ${AMEND}` : `amend the head commit's trailer before the push (Clued-Work-Scope: ${scope}), ${AMEND}`);
  }
  return { ok: problems.length === 0, problems, notes };
}

const USAGE = 'usage: pr-repush-preflight.mjs --repo owner/name --pr N --head <40-hex sha> --claim <lower-case uuid> [--scope global|project:<lower-case uuid>] [--body-governs]';

// { args } or { error } naming the first argument that is wrong.
export function parseArgs(argv) {
  const out = {};
  let i = 0;
  while (i < argv.length) {
    const key = argv[i], value = argv[i + 1];
    if (key === '--body-governs') {   // the only argument without a value
      if ('body-governs' in out) return { error: `${key} given twice` };
      out['body-governs'] = true;
      i += 1;
      continue;
    }
    if (!['--repo', '--pr', '--head', '--claim', '--scope'].includes(key)) return { error: `unknown argument ${JSON.stringify(key)} (use "--name value")` };
    if (value === undefined) return { error: `${key} needs a value` };
    if (key.slice(2) in out) return { error: `${key} given twice` };
    out[key.slice(2)] = value;
    i += 2;
  }
  for (const k of ['repo', 'pr', 'head', 'claim']) if (out[k] === undefined) return { error: `--${k} is required` };
  const parts = out.repo.split('/');
  if (parts.length !== 2 || !REPO_OWNER.test(parts[0]) || !REPO_NAME.test(parts[1]) || parts[1] === '.' || parts[1] === '..') return { error: '--repo must be owner/name' };
  if (!/^[1-9][0-9]{0,9}$/.test(out.pr)) return { error: '--pr must be a pull request number' };
  if (!HEX40.test(out.head)) return { error: '--head must be the full 40-hex lower-case SHA (git rev-parse HEAD)' };
  if (!UUID.test(out.claim)) return { error: '--claim must be a lower-case claim UUID' };
  if (out.scope !== undefined && !SCOPE.test(out.scope)) return { error: '--scope must be global or project:<lower-case uuid>' };
  return { args: { repo: out.repo, pr: Number(out.pr), head: out.head, claim: out.claim, scope: out.scope ?? 'global', bodyGoverns: out['body-governs'] === true } };
}

function read(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) {
    const why = String(r.stderr ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`${cmd} ${args[0]} failed (${r.status ?? r.error?.code ?? 'no status'})${why ? `: ${why}` : ''}`);
  }
  return r.stdout;
}

export const defaultPorts = {
  readPrBody: (repo, pr) => read('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'body', '--jq', '.body']),
  readCommitMessage: head => read('git', ['log', '-1', '--format=%B', head, '--']),
};

export async function main(argv = process.argv.slice(2), ports = defaultPorts, out = process.stdout, err = process.stderr) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.error) { err.write(`${parsed.error}\n${USAGE}\n`); return 2; }
    const { args } = parsed;
    let prBody, commitMessage;
    try {
      prBody = await ports.readPrBody(args.repo, args.pr);
      commitMessage = await ports.readCommitMessage(args.head);
    } catch (e) { err.write(`PREFLIGHT_READ_FAILED: ${e.message}\n`); return 2; }
    const result = checkRepush({ prBody, commitMessage, claim: args.claim, scope: args.scope, bodyGoverns: args.bodyGoverns });
    for (const n of result.notes) out.write(`NOTE (${n.where}): ${n.code}: found ${n.found ?? 'none'}, expected ${n.expected}; --body-governs: this does not fail the run\n`);
    if (result.ok) {
      const head = args.head.slice(0, 8);
      if (result.notes.length) {
        const claimStale = result.notes.some(n => n.code === 'COMMIT_CLAIM_MISMATCH'), scopeStale = result.notes.some(n => n.code === 'COMMIT_SCOPE_MISMATCH');
        const stale = claimStale && scopeStale ? 'claim and scope' : claimStale ? 'claim' : 'scope';
        out.write(`OK: PR #${args.pr} body names claim ${args.claim}, scope ${args.scope}; head ${head}'s trailer names another ${stale}, so the body governs (--body-governs)\n`);
      } else {
        out.write(parseClaimReference(commitMessage)
          ? `OK: PR #${args.pr} body and head ${head} name claim ${args.claim}, scope ${args.scope}\n`
          : `OK: PR #${args.pr} body names claim ${args.claim}, scope ${args.scope}; head ${head} has no trailer, so the body decides\n`);
      }
      return 0;
    }
    for (const p of result.problems) out.write(`${p.code} (${p.where}): found ${p.found ?? 'none'}, expected ${p.expected}. Fix: ${p.fix}\n`);
    return 1;
  } catch (e) { err.write(`PREFLIGHT_INTERNAL_ERROR: ${e?.message ?? e}\n`); return 2; }
}

// Real paths on both sides: a junction or symlink on the way to this file must not skip the check and exit 0. When the
// entry script cannot be resolved but is named like this file, run the check anyway (exit 2 at worst) rather than exit 0
// having checked nothing; an importer whose first argument is some other missing path runs nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(self); } catch { return path.basename(process.argv[1]) === path.basename(self); }
}

if (invokedDirectly()) process.exitCode = await main();
