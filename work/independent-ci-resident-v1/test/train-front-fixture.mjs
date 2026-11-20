// The #1192 front on Source v2's offline train ports (train-strict-fixtures.mjs), shared by the train-front tests. No production access.
// Each GitHub Actions check run carries the workflow run it belongs to, as GitHub's own details_url does (.../actions/runs/<run>/job/<job>):
// the Linux required tests are run LINUX_RUN (ci-suites, clued-cloud-tests, migration-verify), the Windows one WINDOWS_RUN.
import { setup, sha, iso, H, NOW, CLAIM, REPO, APP, SOURCE } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';

export const ACTIONS_APP = 15368;
export const ACTIONS = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
export const NATIVE = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
export const MIN = 60_000;
export const LINUX_RUN = 44633481108, WINDOWS_RUN = 44633481239;
export const runOfContext = c => (c === 'ci-suites-windows' ? WINDOWS_RUN : LINUX_RUN);
// The four job names GitHub gave the skipped jobs of #1192 (the unevaluated `name:` expression), shortened.
export const SKIPPED_NAME = c => `needs.admission-gate.outputs.admitted == 'true' && (...) && '${c}' || '${c}-skipped'`;
const contextOf = name => ACTIONS.find(c => name === c || name === `${c}-skipped` || name.includes(`'${c}' || '${c}-skipped'`)) ?? null;
export const detailsUrl = (run, id) => `https://github.com/${REPO}/actions/runs/${run}/job/${id}`;

// slotAt: the merge slot's green; admittedAt: the newest kooyumi-work-admission (default 3 minutes before the slot); skippedAt: when the
// first attempt's gates and skipped jobs ended; takenAt: when the claim became the front (default 15 minutes before the slot).
export async function front(t, { extraRequired = [], slotAt = NOW - 4 * MIN, others = true, takenAt = undefined, rulesReply = null,
  admittedAt = undefined, skippedAt = NOW - 60 * MIN } = {}) {
  const taken = takenAt !== undefined ? takenAt : slotAt === null ? undefined : iso(slotAt - 15 * MIN);
  const e = await setup(t, { strict: true, tick: 1,
    native: { nodes: [{ node: { name: 'fixture', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }], ...(taken !== undefined ? { holder: { takenAt: taken } } : {}) } });
  const read = e.gh.readPullRequest;
  e.gh.readPullRequest = async n => ({ ...(await read(n)), auto_merge: { merge_method: 'merge' } });
  const rules = e.gh.readBranchRules;
  e.gh.readBranchRules = async () => {
    const reply = await rules();
    if (rulesReply) return rulesReply(reply);
    for (const context of [...ACTIONS, ...extraRequired]) reply.rules[1].parameters.required_status_checks.push({ context, integration_id: ACTIONS_APP });
    return reply;
  };
  const otherHead = sha(0x9999);
  e.gh.pull(911, { head: otherHead });
  const queue = [{ pr: 910, headSha: H, claimId: CLAIM }, { pr: 911, headSha: otherHead, claimId: '99999999-8888-4777-8666-555555555555' }];
  e.native.port.yieldSlot = async input => {
    e.native.calls.push(['yield', input]);
    queue.push(queue.shift());
    e.native.holder = { ...e.native.holder, ...queue[0], boundPr: `${REPO}#${queue[0].pr}` };
    return { onDuty: true, yielded: true };
  };
  let id = 600;
  // run: the workflow run of a GitHub Actions check (by default the one of its required context; a gate names its run).
  const check = (name, { app = ACTIONS_APP, status = 'completed', conclusion = 'success', at = NOW - 30 * MIN, head = H, run = undefined } = {}) => {
    const c = { id: ++id, app: { id: app }, name, head_sha: head, status, conclusion: status === 'completed' ? conclusion : null,
      started_at: at === null || status === 'queued' ? null : iso(at), completed_at: status === 'completed' && at !== null ? iso(at) : null };
    const wf = run !== undefined ? run : app === ACTIONS_APP && contextOf(name) ? runOfContext(contextOf(name)) : null;
    if (wf) Object.assign(c, { details_url: detailsUrl(wf, c.id), check_suite: { id: wf * 10 } });
    if (name === 'kooyumi-merge-slot') c.output = { title: 'Complete Native control', summary: `front PR #910, head ${H}, main@${e.gh.world.main}` };
    e.gh.world.checks.set(c.id, c);
    return c;
  };
  // the six native checks of App 5368905, the merge slot last
  const admitted = admittedAt !== undefined ? admittedAt : slotAt === null ? null : slotAt - 3 * MIN;
  for (const name of NATIVE) check(name, { app: APP, at: name === 'kooyumi-merge-slot' ? slotAt : name === 'kooyumi-work-admission' ? admitted : slotAt === null ? null : slotAt - 3 * MIN });
  // the gate of both workflows ran and admitted nothing: its own check run succeeded, the heavy jobs are skipped under their expression names
  if (others) {
    check('admission-gate', { at: skippedAt, run: LINUX_RUN });
    check('admission-gate', { at: skippedAt, run: WINDOWS_RUN });
    for (const c of ACTIONS) check(SKIPPED_NAME(c), { conclusion: 'skipped', at: skippedAt });
  }
  const yields = () => e.native.calls.filter(c => c[0] === 'yield').length;
  return { e, queue, check, yields };
}
