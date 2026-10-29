// The Linux half, reached only through the upgrade mailbox (src/upgrade-mailbox.mjs, spec A7): the companion in the Owner's
// session carries each request to the frozen root tool (clued-ci-upgrade-linux) and hands its JSON back. The upgrader never
// runs anything in WSL itself.
//
// Request ids are derived from (opId, step number, try): a resumed step finds the request it already sent and waits for
// that answer instead of sending a second one; a request that ran out without an answer is followed by the next try. The
// root tool re-observes before it acts (spec B3), so a repeated request is safe as well.
import { CHANNEL_CODE, UPGRADE_RETAIN_KEEP, UpgradeMailbox, derivedRequestId } from '../../src/upgrade-mailbox.mjs';
import { U } from './codes.mjs';

// A safety bound only, above any wait the machine runs: a rollback waits up to 24 h for the companion (ROLLBACK_WAIT_MAX_MS) and
// every re-run of its step uses one more try of the same key, so even the shortest request (60 s) needs no more than 1440.
// Each call sends one new request at most. (Round 2 of the PR-1 review: 50 ended the rollback wait after about 5 hours.)
export const MAX_TRIES_PER_CALL = 2000;

export class LinuxPort {
  constructor(mailbox, { clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 1000 } = {}) {
    this.mailbox = mailbox;
    this.clock = clock;
    this.sleep = sleep;
    this.pollMs = pollMs;
  }

  static async open(dir, options = {}) { return new LinuxPort(await UpgradeMailbox.open(dir, options.clock), options); }

  // { ok, code, result }: code is the tool's own code on a refusal, UPGRADE_COMPANION_UNAVAILABLE when no answer came.
  async call(kind, opId, args, key) {
    for (let n = 0; n < MAX_TRIES_PER_CALL; n += 1) {
      const requestId = derivedRequestId(opId ?? 'none', kind, key, n);
      let request = await this.mailbox.request(requestId);
      if (request === null) request = await this.mailbox.send({ kind, opId, args, requestId });
      else {
        const done = await this.mailbox.poll(request);
        if (done === null && this.clock() >= Date.parse(request.deadline)) continue; // ran out unanswered: the next try
      }
      const answer = await this.mailbox.await(request, this.sleep, this.pollMs);
      if (answer === null) return { ok: false, code: U.COMPANION_UNAVAILABLE, result: null, requestId };
      // The class code the upgrader acts on: the answer's (responseFromTool takes the tool's upgradeCode), or, from a companion
      // that put the tool's detailed code there, the tool's own upgradeCode in the result. Only this channel's codes.
      let code = answer.code;
      if (!answer.ok && !CHANNEL_CODE.test(code ?? '') && CHANNEL_CODE.test(answer.result?.upgradeCode ?? '')) code = answer.result.upgradeCode;
      return { ok: answer.ok, code, result: answer.result, requestId };
    }
    return { ok: false, code: U.COMPANION_UNAVAILABLE, result: null, requestId: null };
  }

  versionFacts(opId, key) { return this.call('linux-version-facts', opId, {}, key); }
  stage({ opId, packageManifestSha256, generation, linuxManifestSha256 }, key) { return this.call('linux-upgrade-stage', opId, { packageManifestSha256, generation, linuxManifestSha256 }, key); }
  switch({ opId, fromGeneration, toGeneration, linuxManifestSha256 }, key) { return this.call('linux-upgrade-switch', opId, { fromGeneration, toGeneration, linuxManifestSha256 }, key); }
  rollback({ opId, fromGeneration, toGeneration }, key) { return this.call('linux-upgrade-rollback', opId, { fromGeneration, toGeneration }, key); }
  verify({ opId, generation }, key) { return this.call('linux-upgrade-verify', opId, { generation }, key); }
  retain({ opId, generation }, key) { return this.call('linux-upgrade-retain', opId, { generation, keep: UPGRADE_RETAIN_KEEP }, key); }
  // The facts the companion keeps in responses\version-facts.json (null: none or invalid).
  readFacts() { return this.mailbox.readVersionFacts(); }
}
