// Entry point of the companion (scheduled task "\Clued\CluedCIResidentCompanion", principal = the
// Owner, RunLevel LeastPrivilege, trigger AtLogOn). Code and config live in the admin-only resident
// directory: the Owner can read and run them but not change them.
//
//   node companion-main.mjs --root C:\ProgramData\CluedIndependentCI\resident --config-sha256 <sha>
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { HEX64, check, parseBoundedJson, sha256 } from './canonical.mjs';
import { pathToFileURL } from 'node:url';
import { Companion, argv as companionArgv, readPullArgv, validateCompanionConfig, validateHintConfig } from './companion.mjs';
import { HostedHints, sourceHintObserver } from './hosted-hints.mjs';
import { createGhReadPort } from './gh-read-port.mjs';
import { Mailbox } from './mailbox.mjs';
import { Runner, JOB_HOST_EXE } from './runner.mjs';
import { Poller } from './poller.mjs';
import { Inbox } from './inbox.mjs';
import { canonicalJson } from './canonical.mjs';
import os from 'node:os';
import { readStatus } from './status.mjs';
import { LocalStore, PrStatusReporter, validateStatusConfig } from './pr-status.mjs';
import { companionBackstop } from './ruleset-backstop.mjs';

// The PR page status and the notifications look at the executor's status once a minute (resident quota redesign
// phase 1, item 7); the poller still proposes every five minutes.
export const REPORT_EVERY_MS = 60_000;
export const POLL_EVERY_MS = 5 * 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One lane of the companion: its own Runner, its own loop. The companion's actions (the mailbox: bundles, workspaces,
// Linux archives and quiescence proofs, the relay pump) and the advisory work (poller, PR page status, notifications)
// run in two lanes (independent review of the quota redesign phase 1, M1). A child keeps only its own lane busy, and a
// slow GitHub can never make a mailbox request expire: the service's proofs (for example the 2-minute linux-quiescence)
// are answered while the advisory lane waits. A child that outlives its limit is ended by the job host with its whole job
// (DESIGN §24), so the lane is busy again only while a job host itself has not ended.
export async function lane({ runner, work, sleep: wait = sleep, everyMs = 2_000, stop = () => false }) {
  while (!stop()) {
    if (!runner.busy) { try { await work(); } catch { /* each lane's work handles its own failures; never retry here */ } }
    await wait(everyMs);
  }
}
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };
// A record the companion reads for itself (a challenge's deadline, DESIGN §25.4), bounded like a bridge record.
const readText = async p => { const b = await fs.readFile(p); check(b.length <= 1_400_000, 'COMPANION_READ_BOUND'); return b.toString('utf8'); };

// The local relay log (DESIGN §25.5): one JSON line per relay attempt in <dir>\relay-YYYYMMDD.jsonl (UTC day), append-only,
// at most 2 MB a file (then one LOG_TRUNCATED line and nothing more that day), files older than 14 days removed once a day.
// It lives in the Owner's own profile like the PR status memory: the companion is not elevated, and the resident's
// directories are written only by the installer and the service.
export const RELAY_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const RELAY_LOG_KEEP_DAYS = 14;
export function createRelayLog({ dir, clock = Date.now, fsImpl = fs }) {
  const state = { day: null, truncated: false };
  const dayOf = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  return async entry => {
    const now = clock(), day = dayOf(now), file = path.join(dir, `relay-${day}.jsonl`);
    if (state.day !== day) {
      state.day = day; state.truncated = false;
      await fsImpl.mkdir(dir, { recursive: true });
      const oldest = dayOf(now - RELAY_LOG_KEEP_DAYS * 86_400_000);
      for (const name of await fsImpl.readdir(dir)) {
        const m = /^relay-(\d{8})\.jsonl$/.exec(name);
        if (m && m[1] < oldest) await fsImpl.rm(path.join(dir, name), { force: true });
      }
    }
    if (state.truncated) return;
    const line = `${JSON.stringify(entry)}\n`;
    let size = 0;
    try { size = (await fsImpl.stat(file)).size; } catch { size = 0; }
    if (size >= RELAY_LOG_MAX_BYTES) { state.truncated = true; return; } // truncated before a restart
    if (size + Buffer.byteLength(line) > RELAY_LOG_MAX_BYTES) {
      state.truncated = true;
      await fsImpl.appendFile(file, `${JSON.stringify({ at: new Date(now).toISOString(), LOG_TRUNCATED: true })}\n`);
      return;
    }
    await fsImpl.appendFile(file, line);
  };
}

// The job host must be able to start a child in this very environment (the scheduled task and its own job objects): one
// fixed, harmless child at start-up (DESIGN §24). Otherwise every request would fail quietly while the heartbeat looked
// healthy; this way the companion does not start, sends no heartbeat, and the executor starts no batch.
export const JOB_HOST_PROBE = Object.freeze(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'exit 0']);
export async function probeJobHost(runner) {
  const r = await runner.run([...JOB_HOST_PROBE], { timeoutMs: 30_000 });
  check(r.code === 0 && !('tree' in r) && !r.refused && !r.timedOut, 'COMPANION_JOB_HOST_UNAVAILABLE');
}

// The heartbeat's own timer (DESIGN §26, signal D): every 10 s, apart from the lanes, so that a slow but healthy relay call
// (120 s plus the job host's 60 s, plus 15 s checks) never makes the heartbeat look stale; the service gives a running stage
// up only after PUMP_HEARTBEAT_STALE_MS (120 s) without one. A beat that fails is only that beat: it never throws into a lane
// or the pump. It proves only that the companion process lives; each child of the pump is time-limited by the job host.
export const HEARTBEAT_EVERY_MS = 10_000;
export function startHeartbeat(mailbox, { everyMs = HEARTBEAT_EVERY_MS, schedule = setInterval } = {}) {
  const beat = async () => { try { await mailbox.beat(); } catch { /* the next beat */ } };
  beat();
  return schedule(beat, everyMs);
}

// Keep the WSL VM alive (an idle VM is shut down by WSL; a cold boot mid-batch broke b19/b20).
function keepalive(cmd) {
  let child = null;
  const start = () => {
    child = spawn(cmd[0], cmd.slice(1), { shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('exit', () => setTimeout(start, 10_000));
    child.on('error', () => setTimeout(start, 30_000));
  };
  start();
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { root: { type: 'string' }, 'config-sha256': { type: 'string' } } });
  check(typeof values.root === 'string' && path.isAbsolute(values.root) && HEX64.test(values['config-sha256'] ?? ''), 'COMPANION_ARGS_REQUIRED');
  const bytes = await fs.readFile(path.join(values.root, 'config', 'companion.json'));
  check(sha256(bytes) === values['config-sha256'], 'COMPANION_CONFIG_CHANGED');
  const raw = parseBoundedJson(bytes, 65536, 'COMPANION_CONFIG_REFUSED');
  const cfg = validateCompanionConfig(raw.companion);
  check(os.hostname().toUpperCase() === cfg.node.hostname && process.env.USERPROFILE === cfg.node.ownerProfileDirectory, 'COMPANION_NODE_IDENTITY_CHANGED');
  // Every child of both lanes runs under the installed job host (DESIGN §24): a child that outlives its limit is ended with
  // exactly the job it was started in, and the lane goes on. Without the host the companion does not start.
  const jobHost = path.join(values.root, 'bin', JOB_HOST_EXE);
  check(await exists(jobHost), 'COMPANION_JOB_HOST_REQUIRED');
  const runner = new Runner({ env: { ...process.env }, jobHost }); // the Owner's own environment: gh/git credential helpers live here
  const advisory = new Runner({ env: { ...process.env }, jobHost }); // the advisory lane's own (see lane)
  await probeJobHost(runner);
  const mailbox = await Mailbox.open(path.join(values.root, 'mailbox'), Date.now);
  // Only now, with a usable job host: a companion whose job host cannot start a child sends no heartbeat, so the service
  // starts no batch (DESIGN §24; independent review r3, MINOR 1).
  startHeartbeat(mailbox);
  // pr-head (phase 2): the run queue's live PR read runs in the mailbox lane, like every other service request.
  const relayLog = createRelayLog({ dir: path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local', 'CluedIndependentCI', 'companion-log') });
  const companion = new Companion({ cfg, mailbox, run: (a, o) => runner.run(a, o), fileExists: exists, sleep, clock: Date.now, readPull: pr => readPullArgv(raw.ghExe, raw.repo, pr),
    readText, log: relayLog });
  const inboxDir = path.join(values.root, 'inbox');
  // Hint mode: the installed (admin-only, read by the Owner) CI Source's relay observer and pure hint
  // attestation over the Owner's own read-only gh login. Off unless companion.json enables it.
  const hintCfg = validateHintConfig(raw.hints);
  let hints = null;
  if (hintCfg.enabled) {
    const dir = path.join(values.root, 'source', hintCfg.ciSourceManifestSha256, 'work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'hosted-relay-v1');
    const load = name => import(pathToFileURL(path.join(dir, name)).href);
    const [{ validateRegistry }, { createHostedRelayObserver }, { hostedHint }] = await Promise.all([load('registry.mjs'), load('observe.mjs'), load('stage.mjs')]);
    const registry = validateRegistry(JSON.parse(await fs.readFile(path.join(dir, 'registry.json'), 'utf8')), { domain: 'production' });
    const github = createGhReadPort({ ghExe: raw.ghExe, repo: raw.repo, run: (a, o) => advisory.run(a, o) });
    hints = new HostedHints({ repo: raw.repo, mailbox, clock: Date.now,
      observeHead: sourceHintObserver({ registry, createObserver: createHostedRelayObserver, hostedHint, github, repo: raw.repo }) });
  }
  const poller = new Poller({
    repo: raw.repo, ghExe: raw.ghExe, run: (a, o) => advisory.run(a, o), clock: Date.now, hints,
    writeTrigger: async v => { await fs.writeFile(path.join(inboxDir, Inbox.fileName(Date.now())), canonicalJson(v), { flag: 'wx' }); },
  });
  // PR page status and Windows notifications (pr-status.mjs). Their memory lives in the Owner's own profile, never in the
  // resident's directories.
  const statusCfg = validateStatusConfig(raw.status);
  check(statusCfg.node === cfg.node.nodeName, 'COMPANION_NODE_IDENTITY_CHANGED');
  const store = await LocalStore.open(path.join(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local'), 'CluedIndependentCI', 'companion-pr-status.json'));
  // The node's duty (primary/standby C5, node-duty.mjs): its name while status.json names none, and the one write it may
  // make into the resident, the dual-active hold (an intake pause request in the user-writable requests\, like a pause).
  const requestsDir = path.join(values.root, 'requests');
  const reporter = new PrStatusReporter({ repo: raw.repo, ghExe: raw.ghExe, powershellExe: cfg.powershellExe, run: (a, o) => advisory.run(a, o), clock: Date.now, store,
    prStatus: statusCfg.prStatus, notifications: statusCfg.notifications, node: statusCfg.node,
    writeRequest: async v => { await fs.writeFile(path.join(requestsDir, Inbox.fileName(Date.now())), canonicalJson(v), { flag: 'wx' }); } });
  keepalive(companionArgv(cfg).keepalive());
  let lastPoll = 0, lastReport = 0;
  await Promise.all([
    // the service times out and classifies a request the companion did not answer; never retried here
    lane({ runner, work: () => companion.step() }),
    lane({ runner: advisory, work: async () => {
      if (Date.now() - lastPoll > POLL_EVERY_MS) {
        lastPoll = Date.now();
        // The run queue's generation (phase 2): a queue that started over gets every open PR proposed again.
        let generation = null;
        try { generation = (await readStatus(values.root)).queue?.generation ?? null; } catch { generation = null; }
        try { await poller.pass({ generation }); } catch { /* next pass */ }
        // The ruleset backstop (phase 2 step 3c-1, DESIGN §22.3): main's rules on every poll.
        try { await companionBackstop({ root: values.root, ghExe: raw.ghExe, repo: raw.repo, powershellExe: cfg.powershellExe, run: (a, o) => advisory.run(a, o), store }); } catch { /* next poll */ }
      }
      if (Date.now() - lastReport > REPORT_EVERY_MS) {
        lastReport = Date.now();
        let status = null, statusError = false;
        try { status = await readStatus(values.root); } catch { statusError = true; }
        try { await reporter.pass({ pulls: poller.lastPass?.pulls ?? [], status, statusError }); } catch { /* advisory: the next minute tries again */ }
      }
    } }),
  ]);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch(() => { process.exitCode = 4; });
}
