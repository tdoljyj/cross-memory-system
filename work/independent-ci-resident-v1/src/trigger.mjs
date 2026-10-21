// Trigger intake. A trigger is untrusted data that only *names* a pull request head; it carries no
// path, command, claim, grant or package. Anyone who can write the inbox can at most ask the executor
// to look at a real PR head, which the executor then admits or refuses from live facts.
import { HEX40, REPO, check, exactKeys, parseBoundedJson } from './canonical.mjs';

export const TRIGGER_CONTRACT = 'clued.independent-ci.resident-trigger/1';
export const TRIGGER_MAX_BYTES = 1024;

// baseSha is the producer's belief about the PR base. It is part of the batch identity and stage 1
// re-reads the PR live and refuses when GitHub disagrees, so a wrong value only wastes one evaluation.
export function parseTrigger(bytes, policy) {
  const value = parseBoundedJson(bytes, TRIGGER_MAX_BYTES, 'TRIGGER_REFUSED');
  exactKeys(value, ['contract', 'repo', 'pr', 'headSha', 'baseSha'], 'TRIGGER_KEYS_REFUSED');
  check(value.contract === TRIGGER_CONTRACT, 'TRIGGER_CONTRACT_REFUSED');
  check(typeof value.repo === 'string' && REPO.test(value.repo), 'TRIGGER_REPO_REFUSED');
  check(value.repo === policy.repo, 'TRIGGER_REPO_NOT_POLICY_REPO');
  check(Number.isSafeInteger(value.pr) && value.pr > 0 && value.pr < 1e9, 'TRIGGER_PR_REFUSED');
  check(typeof value.headSha === 'string' && HEX40.test(value.headSha), 'TRIGGER_HEAD_REFUSED');
  check(typeof value.baseSha === 'string' && HEX40.test(value.baseSha), 'TRIGGER_BASE_REFUSED');
  return { repo: value.repo, pr: value.pr, headSha: value.headSha, baseSha: value.baseSha };
}

// Coalesce many triggers (duplicates, floods) into one FIFO candidate per (pr, head, base),
// remembering which inbox names fed each candidate so all of them are consumed together.
export function coalesce(entries, maximum) {
  const byId = new Map();
  for (const { name, trigger } of entries) {
    const id = `${trigger.pr}:${trigger.headSha}:${trigger.baseSha}`;
    if (!byId.has(id)) {
      if (byId.size >= maximum) continue;
      byId.set(id, { trigger, names: [] });
    }
    byId.get(id).names.push(name);
  }
  return [...byId.values()];
}
