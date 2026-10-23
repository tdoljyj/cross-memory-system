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
import { Runner } from './runner.mjs';
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
// run in two lanes (independent review of the quota redesign phase 1, M1). A child the Runner never kills keeps only
// its own lane busy, and a slow GitHub can never make a mailbox request expire: the service's proofs (for example the
// 2-minute linux-quiescence) are answered while the advisory lane waits.
export async function lane({ runner, work, sleep: wait = sleep, everyMs = 2_000, stop = () => false }) {
  while (!stop()) {
    if (!runner.busy) { try { await work(); } catch { /* each lane's work handles its own failures; never retry here */ } }
    await wait(everyMs);
  }
}
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };

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
  const runner = new Runner({ env: { ...process.env } }); // the Owner's own environment: gh/git credential helpers live here
  const advisory = new Runner({ env: { ...process.env } }); // the advisory lane's own (see lane)
  const mailbox = await Mailbox.open(path.join(values.root, 'mailbox'), Date.now);
  // pr-head (phase 2): the run queue's live PR read runs in the mailbox lane, like every other service request.
  const companion = new Companion({ cfg, mailbox, run: (a, o) => runner.run(a, o), fileExists: exists, sleep, clock: Date.now, readPull: pr => readPullArgv(raw.ghExe, raw.repo, pr) });
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
  const store = await LocalStore.open(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CluedIndependentCI', 'companion-pr-status.json'));
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
