// Trigger intake. A trigger is untrusted data that only *names* a pull request head; it carries no
// path, command, claim, grant or package. Anyone who can write the inbox can at most ask the executor
// to look at a real PR head, which the executor then admits or refuses from live facts.
import { HEX40, REPO, check, exactKeys, parseBoundedJson } from './canonical.mjs';

export const TRIGGER_CONTRACT = 'clued.independent-ci.resident-trigger/1';
// Contract /2 (resident quota redesign phase 2, step 1: design v0.5 §4.2): an optional prUpdatedAt, the PR's update
// time as the poller read it. The run queue (queue.mjs#offer) counts a trigger of a commit it already has as a NEW
// trigger only when prUpdatedAt is newer than the row's, or absent (an Agent's own trigger). /1 is still read: it is
// a /2 trigger without prUpdatedAt.
export const TRIGGER_CONTRACT_V2 = 'clued.independent-ci.resident-trigger/2';
export const TRIGGER_MAX_BYTES = 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// baseSha is the producer's belief about the PR base. It is part of the batch identity and stage 1
// re-reads the PR live and refuses when GitHub disagrees, so a wrong value only wastes one evaluation.
export function parseTrigger(bytes, policy) {
  const value = parseBoundedJson(bytes, TRIGGER_MAX_BYTES, 'TRIGGER_REFUSED');
  check(value.contract === TRIGGER_CONTRACT || value.contract === TRIGGER_CONTRACT_V2, 'TRIGGER_CONTRACT_REFUSED');
  const v2 = value.contract === TRIGGER_CONTRACT_V2;
  exactKeys(value, ['contract', 'repo', 'pr', 'headSha', 'baseSha', ...(v2 && Object.hasOwn(value, 'prUpdatedAt') ? ['prUpdatedAt'] : [])], 'TRIGGER_KEYS_REFUSED');
  check(typeof value.repo === 'string' && REPO.test(value.repo), 'TRIGGER_REPO_REFUSED');
  check(value.repo === policy.repo, 'TRIGGER_REPO_NOT_POLICY_REPO');
  check(Number.isSafeInteger(value.pr) && value.pr > 0 && value.pr < 1e9, 'TRIGGER_PR_REFUSED');
  check(typeof value.headSha === 'string' && HEX40.test(value.headSha), 'TRIGGER_HEAD_REFUSED');
  check(typeof value.baseSha === 'string' && HEX40.test(value.baseSha), 'TRIGGER_BASE_REFUSED');
  const prUpdatedAt = v2 && Object.hasOwn(value, 'prUpdatedAt') ? value.prUpdatedAt : null;
  check(prUpdatedAt === null || (typeof prUpdatedAt === 'string' && ISO.test(prUpdatedAt) && Number.isFinite(Date.parse(prUpdatedAt))), 'TRIGGER_UPDATED_AT_REFUSED');
  return { repo: value.repo, pr: value.pr, headSha: value.headSha, baseSha: value.baseSha, prUpdatedAt };
}
