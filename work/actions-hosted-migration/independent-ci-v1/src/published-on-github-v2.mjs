// Cross-node "already published" read-back (resident primary/standby design v0.4 §6.1-§6.4, §9 C4; Task c2af8d17).
// The required checks are published only by App 5368905. Whether a head already carries one of them is a fact every
// node can read on GitHub, and a final one, so the nodes keep no shared ledger: GitHub is the shared record. The read is
// the head's complete check-run inventory with filter=all (the default filter=latest keeps only the newest run of each
// name), narrowed to this App. A read that is not complete fails closed: github.mjs#inventory refuses with
// checks_pagination_changed, incomplete_checks, checks_page_limit or invalid_check_set (and the port's transport codes,
// github_transport_unconfirmed and github_http_<status>, stay as they are); a reply that is not exactly this App's list
// refuses here with published_checks_unconfirmed. GitHub lists the runs of at most the 1000 newest check suites of a head;
// a head with more is beyond this read (accepted, like the page limit). Only the protected control principal reads it (the
// App token inside a trusted stage entry), never the companion, so an Owner session cannot make a published head look
// unpublished.
//
// Two places use it (design §6.2):
//   - stage 1, before Native admission and before kooyumi-work-admission is published: a head that already carries a role
//     or control check of this App, whatever its conclusion (one revoked to failure counts too), ends at once with
//     HEAD_PUBLISHED_ON_GITHUB, so it never reaches the Task's CI meter. kooyumi-work-admission of another attempt or
//     Source does not count: it is proven again per attempt (DESIGN §7.2). The same job's own (same job id and attempt,
//     so the same external id under the same claim generation), published by another node or install, stops the attempt:
//     posting it again would make two checks of one identity, which the read-back refuses (UNCERTAIN, HALT). Alone (no role or
//     control check beside it) it ends with HEAD_INTERRUPTED_ON_GITHUB: the run that wrote it was interrupted (a failover) before
//     any check ran, so the head is not executed and the resident's attempt 2 runs it (resident DESIGN §78);
//   - before a check's first publication, and only when this node's own records know nothing of it (no effect key, no
//     K(head, role)): a check of the same name of this App ends that publication cleanly with ROLE_ALREADY_ON_GITHUB
//     (nothing published for it, nothing revoked, no HALT). What this node knows keeps its existing path.
// For a train front batch both count only the checks of that front batch's own jobs (ofJobIds), never a non-front run of H.
// Pure apart from the one port read.
export const PUBLISHER_APP_ID = 5368905;
export const HEAD_PUBLISHED_ON_GITHUB = 'HEAD_PUBLISHED_ON_GITHUB';
export const ROLE_ALREADY_ON_GITHUB = 'ROLE_ALREADY_ON_GITHUB';
export const HEAD_INTERRUPTED_ON_GITHUB = 'HEAD_INTERRUPTED_ON_GITHUB';
// The scanner publisher's reason for it (its reasons are lower case; stage-fact.mjs maps both spellings).
export const ROLE_ALREADY_ON_GITHUB_REASON = 'role_already_on_github';
// Every required check but kooyumi-work-admission: the role checks and the control pair (design J2).
export const PUBLISHED_ROLE_CHECK_NAMES = Object.freeze(['gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot']);

const SHA = /^[a-f0-9]{40}$/;
const positive = v => Number.isSafeInteger(v) && v > 0;
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// This App's check runs on the head, all of them, from one complete read. readAppChecks (github.mjs) asks GitHub for
// this App's runs only (app_id); a port without it reads the head's complete inventory and keeps this App's runs, the
// same set from a longer read. A reply that is not exactly that refuses.
export async function readPublishedChecks(github, headSha, appId = PUBLISHER_APP_ID) {
  if (!SHA.test(headSha ?? '') || !positive(appId)) fail('published_checks_unconfirmed');
  const narrowed = typeof github?.readAppChecks === 'function';
  if (!narrowed && typeof github?.readChecks !== 'function') fail('published_checks_unconfirmed');
  const list = narrowed ? await github.readAppChecks(headSha) : await github.readChecks(headSha);
  if (list?.complete !== true || !Array.isArray(list.checks) || list.checks.length > 10000
    || list.checks.some(c => !plain(c) || !positive(c.id) || c.head_sha !== headSha || typeof c.name !== 'string' || !plain(c.app) || !positive(c.app.id)
      || (narrowed && c.app.id !== appId))
    || new Set(list.checks.map(c => c.id)).size !== list.checks.length) fail('published_checks_unconfirmed');
  return list.checks.filter(c => c.app.id === appId);
}

// Merge train (DESIGN §41.4): a train front batch (S != H) is its own identity (H, S), apart from any non-front run of H.
// Its checks on H are told apart by their external ids (the scanner's, the work admission's and the control pair's all
// carry the job id, job-v2.mjs: `<prefix>:v2:<job id>:a<attempt>`, the admission ones then the claim). jobIds: the front
// subject's job ids (job-v2.mjs#frontJobIdsV2); a check counts only when its external id names one of them.
const JOB_EXTERNAL_ID = /^independent-ci:(?:staged|native-work-admission|control:[a-z-]{1,40}):v2:([a-f0-9]{64}):a[1-9](?::|$)/;
export const ofJobIds = (c, jobIds) => typeof c?.external_id === 'string' && jobIds.has(JOB_EXTERNAL_ID.exec(c.external_id)?.[1]);

// Which of `names` this App already published on the head: sorted, each once. jobIds (a train front batch only): only
// the checks of those jobs count.
export async function publishedNames(github, headSha, names, appId = PUBLISHER_APP_ID, jobIds = null) {
  if (!Array.isArray(names) || names.length === 0 || names.some(n => typeof n !== 'string' || !n) || !(jobIds === null || jobIds instanceof Set)) fail('published_checks_unconfirmed');
  const checks = await readPublishedChecks(github, headSha, appId);
  return [...new Set(checks.filter(c => jobIds === null || ofJobIds(c, jobIds)).map(c => c.name).filter(n => names.includes(n)))].sort();
}
