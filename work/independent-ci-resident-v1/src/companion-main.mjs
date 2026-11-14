// Entry point of the companion. M5 (ADR 0022): the scheduled task "\Clued\CluedCIResidentCompanion" (principal = the Owner,
// RunLevel LeastPrivilege; a password logon at boot and every 15 minutes, or, before the switch and after a fall-back, the Owner's
// interactive token at log-on) runs bin\CluedCompanionSupervisor.exe, which starts this entry with a whitelisted environment and
// restarts it. Code and config live in the admin-only resident directory: the Owner can read and run them but not change them.
//
//   node companion-main.mjs --root C:\ProgramData\CluedIndependentCI\resident --config-sha256 <sha>
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { HEX64, check, parseBoundedJson, sha256 } from './canonical.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Companion, UpgradeLane, argv as companionArgv, readPullArgv, validateCompanionConfig, validateHintConfig } from './companion.mjs';
import { UpgradeMailbox } from './upgrade-mailbox.mjs';
import { HostedHints, sourceHintObserver } from './hosted-hints.mjs';
import { createGhReadPort } from './gh-read-port.mjs';
import { Mailbox } from './mailbox.mjs';
import { Runner, JOB_HOST_EXE } from './runner.mjs';
import { Poller } from './poller.mjs';
import { Inbox } from './inbox.mjs';
import os from 'node:os';
import { readStatus } from './status.mjs';
import { LocalStore, PrStatusReporter, REPORT_MIN_GAP_MS, reportDue, statusSignature, toastArgv, validateStatusConfig } from './pr-status.mjs'; // toastArgv: the tests' fallback in companionHeartbeat only
import { companionBackstop } from './ruleset-backstop.mjs';
import { NODE_STATUS_FILE, readCapacityAlert } from './host-capacity.mjs';
import { acquireInstanceLock, processAlive } from './instance-lock.mjs';
import { readWin32Process } from './resident-lock.mjs';
import { PANEL_REPO, PanelDispatchState, PanelDispatcher, validatePanelDispatchConfig } from './panel-dispatch.mjs';
import {MergeReconcileState,MergeReconciler} from './merge-reconcile.mjs';
import {MERGE_RECONCILE_REPO,MERGE_RECONCILE_WORKFLOW_SHA256,validateMergeReconcileConfig} from './merge-reconcile-config.mjs';
import { AdmissionRerunState, AdmissionRerunner, RERUN_LANE_EVERY_MS, ghPort } from './admission-rerun.mjs';
import { CompanionHeartbeat, ghHandoverPort, readHeartbeatToken, scQueryArgv, serviceRunningFrom, supabaseHeartbeatTransport } from './companion-heartbeat.mjs';
import { NotifyQueue, notifyQueueDir, queueNotify } from './notify-queue.mjs';
import { ReceiptChain } from './receipts.mjs';
import { RetentionNotifier } from './retention-notify.mjs';
import { pruneArchivedGenerations } from './generation-retention.mjs';
import { SETTINGS_FILE, readRetentionSettings } from './retention-settings.mjs';
import { assertGhIsolation, assertNotElevated, sessionFacts, writeSessionFacts } from './companion-session.mjs';
import { resolveCompanionWslClient } from './wsl-client.mjs';

// The PR page status and the notifications look at the executor's status once a minute (resident quota redesign
// phase 1, item 7). The poller looks for new PR heads once a minute too (Decision 1b99e7e4; it was five minutes): its two
// reads are conditional (poller.mjs), so an unchanged minute costs two 304s. The ruleset backstop stays at five minutes.
export const REPORT_EVERY_MS = 60_000;
export const POLL_EVERY_MS = 60_000;
export const BACKSTOP_EVERY_MS = 5 * 60_000;
// The upgrade mailbox lane looks for requests this often (the upgrader polls its answers once a second; the shortest deadline is 60 s).
export const UPGRADE_LANE_EVERY_MS = 5_000;
// The node heartbeat's own lane (DESIGN §41.6a, companion-heartbeat.mjs) looks this often whether what it reports changed; it
// sends every minute (ADR 0026) and at once on a change. Its own Runner: a slow GitHub or a long mailbox request never delays it.
export const HEARTBEAT_LANE_EVERY_MS = 30_000;
// The companion's instance lock is refreshed this often (instance-lock.mjs: a holder older than ten minutes is not fresh).
export const COMPANION_LOCK_TOUCH_MS = 60_000;
// The compute panel's five-minute trigger (DESIGN §43, panel-dispatch.mjs) looks this often whether it is due; it dispatches at most every
// five minutes. Its own Runner: a slow GitHub never delays the heartbeat or the mailbox.
export const PANEL_DISPATCH_LANE_EVERY_MS = 30_000;
export const MERGE_RECONCILE_LANE_EVERY_MS = 30_000;
// M5 (review MINOR 6): how often the companion checks again that its gh login is its own.
export const GH_RECHECK_EVERY_MS = 2 * 60_000;
const SC_EXE = 'C:\\Windows\\System32\\sc.exe';

// The node heartbeat, or null when no heartbeat token is installed (then nothing about the companion changes). The server's
// address, publishable key and scope are the installed record's (record\installation.json), never a configuration of their own.
// notify(key, title, body): the notification queue (M5, ADR 0022 §4.3); without it (tests) a toast through powershellExe as before.
export async function companionHeartbeat({ root, nodeName, ghExe, repo, powershellExe, run, store, clock = Date.now, readJson = async p => JSON.parse(await fs.readFile(p, 'utf8')), notify = null }) {
  if (!(await readHeartbeatToken(root))) return null;
  let transport, scope = null;
  try {
    const record = await readJson(path.join(root, 'record', 'installation.json'));
    scope = record.scope;
    transport = supabaseHeartbeatTransport({ supabaseUrl: record.supabaseUrl, publishableKey: record.publishableKey });
  } catch { transport = async () => ({ ok: false, tokenRefused: false, notRegistered: false, autoHandovers: [], watchdogTickAt: null, watchdogStale: null }); }
  return new CompanionHeartbeat({ nodeName, scope, transport, clock, readToken: () => readHeartbeatToken(root), readStatus: () => readStatus(root),
    serviceRunning: async () => serviceRunningFrom(await run(scQueryArgv(SC_EXE), { timeoutMs: 15_000 })),
    notify: notify ?? (async (key, title, body) => { await run(toastArgv(powershellExe, title, body), { timeoutMs: 15_000 }); }),
    memory: { get: key => Date.parse(store.data.notified[key]?.at) || 0, set: async (key, at) => { store.data.notified[key] = { at: new Date(at).toISOString() }; await store.save(); } },
    handover: ghHandoverPort({ ghExe, repo, run }) });
}

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

// ---- One companion per node (Task 42fe5ae4) ----
// The executor's lock (instance-lock.mjs, frozen) with a companion's own liveness test: its holder counts as live only while its
// pid is still this root's companion node. A companion ends without cleanup (a stop, a logoff, a crash) and Windows reuses pids,
// so the executor's rule (any live pid) could refuse every later start until the reused pid's process ended. A process that
// cannot be read keeps the frozen rule (a refused start, never two companions). A refusal is written next to the lock for the
// Owner (companion-lock\refused.json); at most COMPANION_STALE_LOCKS_KEPT set-aside locks are kept.
export const COMPANION_STALE_LOCKS_KEPT = 10;

// readWin32Process (resident-lock.mjs): { executablePath, commandLine } of one pid, both null when it is gone; null when unreadable.
export async function companionProcessAlive(pid, root, { alive = processAlive, readProcess = readWin32Process } = {}) {
  if (!(await alive(pid))) return false;
  const p = await readProcess(pid);
  if (p === null) return true;
  // An existing process whose path reads as null (protected, another user's) is not ours: a companion runs under the Owner's own
  // unelevated token, which the Owner's next start can always read.
  const node = path.join(root, 'runtime', 'node.exe').toLowerCase();
  return typeof p.executablePath === 'string' && p.executablePath.toLowerCase() === node
    && typeof p.commandLine === 'string' && p.commandLine.includes('companion-main.mjs') && p.commandLine.includes('--root');
}

export async function acquireCompanionLock(dir, root, { alive = pid => companionProcessAlive(pid, root), clock = Date.now, acquire = acquireInstanceLock } = {}) {
  let lock;
  try {
    lock = await acquire(dir, { alive, clock });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code.replace(/^EXECUTOR_/, 'COMPANION_') : 'COMPANION_LOCK_REFUSED';
    try { await fs.writeFile(path.join(dir, 'refused.json'), JSON.stringify({ code, holderPid: Number.isSafeInteger(error?.detail) ? error.detail : null, at: new Date(clock()).toISOString(), pid: process.pid })); } catch { /* the refusal stands */ }
    throw Object.assign(new Error(code), { code });
  }
  await fs.rm(path.join(dir, 'refused.json'), { force: true }).catch(() => {}); // an earlier refusal no longer holds
  try {
    const stale = (await fs.readdir(path.join(dir, 'locks'))).filter(n => n.startsWith('stale-')).sort();
    for (const name of stale.slice(0, Math.max(0, stale.length - COMPANION_STALE_LOCKS_KEPT))) await fs.rm(path.join(dir, 'locks', name), { recursive: true, force: true });
  } catch { /* housekeeping only */ }
  return lock;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { root: { type: 'string' }, 'config-sha256': { type: 'string' } } });
  check(typeof values.root === 'string' && path.isAbsolute(values.root) && HEX64.test(values['config-sha256'] ?? ''), 'COMPANION_ARGS_REQUIRED');
  const bytes = await fs.readFile(path.join(values.root, 'config', 'companion.json'));
  check(sha256(bytes) === values['config-sha256'], 'COMPANION_CONFIG_CHANGED');
  const raw = parseBoundedJson(bytes, 65536, 'COMPANION_CONFIG_REFUSED');
  // DESIGN §33: the Source directory is named by the hash of the installed record's source-manifest.json (the install put the Source
  // there); the config's script paths must lie under it, or the companion does not start with a stale Source in its hands.
  const ciSourceManifestSha256 = sha256(await fs.readFile(path.join(values.root, 'record', 'source-manifest.json')));
  let cfg = validateCompanionConfig(raw.companion, { root: values.root, ciSourceManifestSha256 });
  check(os.hostname().toUpperCase() === cfg.node.hostname && process.env.USERPROFILE === cfg.node.ownerProfileDirectory, 'COMPANION_NODE_IDENTITY_CHANGED');
  // One companion per node (Task 42fe5ae4): op 8e3b3e1b's rollback started one more every minute and all of them served the
  // same mailboxes. Refreshed every minute while the lanes run.
  const instanceLock = await acquireCompanionLock(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local', 'CluedIndependentCI', 'companion-lock'),
    values.root);
  // Every child of both lanes runs under the installed job host (DESIGN §24): a child that outlives its limit is ended with
  // exactly the job it was started in, and the lane goes on. Without the host the companion does not start.
  const jobHost = path.join(values.root, 'bin', JOB_HOST_EXE);
  check(await exists(jobHost), 'COMPANION_JOB_HOST_REQUIRED');
  const runner = new Runner({ env: { ...process.env }, jobHost }); // the Owner's own environment: gh/git credential helpers live here
  const advisory = new Runner({ env: { ...process.env }, jobHost }); // the advisory lane's own (see lane)
  // DESIGN §34: the upgrade mailbox lane's own (a 20-minute Linux stage never holds up the resident's mailbox or the advisory work).
  const upgradeRunner = new Runner({ env: { ...process.env }, jobHost });
  await probeJobHost(runner);
  // M5 (ADR 0022 §4.2): never with an elevated token (a task set to "highest privileges" refuses here as in the supervisor), and only
  // with the companion's own gh login (Owner decision: a classic token in a gh configuration of its own). Either refusal ends the
  // companion before its first heartbeat, so the service only defers.
  await assertNotElevated((a, o) => runner.run(a, o));
  await assertGhIsolation({ env: process.env, profileDir: cfg.node.ownerProfileDirectory, ghExe: raw.ghExe });
  const wslClient = await resolveCompanionWslClient({ root: values.root, declaredWslExe: cfg.wslExe, run: (a, o) => runner.run(a, o) });
  // A legacy config may still declare the inbox stub. It is inert: every pump,
  // upgrade, session-facts and keepalive command below receives this verified
  // machine-wide path, or start-up ends before the first heartbeat.
  cfg = Object.freeze({ ...cfg, wslExe: wslClient.path });
  // The six notification sites write into the Owner's notification queue; the notifier task shows it at log-on (ADR 0022 §4.3).
  const notify = queueNotify(new NotifyQueue({ dir: notifyQueueDir(cfg.node.ownerProfileDirectory) }));
  const mailbox = await Mailbox.open(path.join(values.root, 'mailbox'), Date.now);
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
    writeTrigger: v => Inbox.drop(inboxDir, v), // a create-only drop box: the reader waits for a file still being written (DESIGN §31.3)
  });
  // PR page status and Windows notifications (pr-status.mjs). Their memory lives in the Owner's own profile, never in the
  // resident's directories.
  const statusCfg = validateStatusConfig(raw.status);
  // The node's name is the pinned node profile's; a status.node that names another node refuses (never a default node).
  check(statusCfg.node === cfg.node.nodeName || statusCfg.node === null, 'COMPANION_NODE_IDENTITY_CHANGED');
  const store = await LocalStore.open(path.join(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local'), 'CluedIndependentCI', 'companion-pr-status.json'));
  // Read receipts only: never open/seal/append the service's chain from the companion.
  const retentionNotifier = new RetentionNotifier({ receipts: new ReceiptChain(path.join(values.root, 'state', 'receipts'), Date.now), store, notify,
    reviewGenerations: async () => {
      const settings = await readRetentionSettings(path.join(values.root, 'owner', SETTINGS_FILE));
      return settings.ok ? pruneArchivedGenerations({ root: values.root, settings: settings.settings }) : { code: settings.code };
    } });
  // The node's duty (primary/standby C5, node-duty.mjs): its name while status.json names none, and the one write it may
  // make into the resident, the dual-active hold (an intake pause request in the user-writable requests\, like a pause).
  const requestsDir = path.join(values.root, 'requests');
  const reporter = new PrStatusReporter({ repo: raw.repo, ghExe: raw.ghExe, powershellExe: cfg.powershellExe, run: (a, o) => advisory.run(a, o), clock: Date.now, store,
    prStatus: statusCfg.prStatus, notifications: statusCfg.notifications, node: cfg.node.nodeName,
    writeRequest: v => Inbox.drop(requestsDir, v), notify });
  // The upgrade mailbox lane (DESIGN §34): upgrade\mailbox\ is opened once it exists (an install before the channel has none; the
  // lane then tries again each pass and the companion runs as before). The companion never creates it.
  const upgradeLane = new UpgradeLane({ cfg, run: (a, o) => upgradeRunner.run(a, o), clock: Date.now,
    openMailbox: async () => {
      const dir = path.join(values.root, 'upgrade', 'mailbox');
      check(await exists(path.join(dir, 'requests')) && await exists(path.join(dir, 'responses')), 'UPGRADE_MAILBOX_ABSENT');
      return UpgradeMailbox.open(dir, Date.now);
    } });
  // The node heartbeat (DESIGN §41.6a): only with a heartbeat token installed; its own lane and Runner.
  // Its once-per-key memory is a store of its own (two lanes never write one file).
  const heartbeatRunner = new Runner({ env: { ...process.env }, jobHost });
  const heartbeatStore = await LocalStore.open(path.join(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local'), 'CluedIndependentCI', 'companion-heartbeat.json'));
  const heartbeat = await companionHeartbeat({ root: values.root, nodeName: cfg.node.nodeName, ghExe: raw.ghExe, repo: raw.repo, powershellExe: cfg.powershellExe,
    run: (a, o) => heartbeatRunner.run(a, o), store: heartbeatStore, notify });
  // §41.6a: while the heartbeat's answer shows the failover watchdog stale, the PR page status says so too.
  reporter.watchdogStale = () => heartbeat?.watchdogStale === true;
  // ADR 0026: the last automatic take-over to this node, for the take-over check (node-duty.mjs).
  reporter.autoHandoverSince = () => heartbeat?.autoHandoverSince ?? null;
  // Node governance v1: while the node status names a red line (new batches held, or the Linux runners held back), the PR page says so too
  // (the companion writes that status itself: no channel to the service is involved).
  reporter.hostCapacity = () => readCapacityAlert(NODE_STATUS_FILE);
  // The panel trigger (DESIGN §43, Decision 7eb98011): on unless companion.json says panelDispatch.enabled false; dispatches only while
  // this node's status says ACTIVE. Its own Runner and its own memory file (two lanes never write one file).
  const panelRunner = new Runner({ env: { ...process.env }, jobHost });
  // Only for the repository the panel workflow is in (panel-dispatch.mjs#PANEL_REPO); tools/build-package.mjs refuses a configuration that names another one.
  const panelDispatch = validatePanelDispatchConfig(raw.panelDispatch).enabled && raw.repo === PANEL_REPO
    ? new PanelDispatcher({ nodeName: cfg.node.nodeName, repo: raw.repo, ghExe: raw.ghExe, clock: Date.now, run: (a, o) => panelRunner.run(a, o), readStatus: () => readStatus(values.root),
      notify,
      state: await PanelDispatchState.open(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local', 'CluedIndependentCI', 'companion-panel-dispatch.json')) })
    : null;
  // Off in existing packages. Enabling belongs to a separately accepted
  // package and dedicated-controller rollout, never to this local candidate.
  const mergeConfig=validateMergeReconcileConfig(raw.mergeReconcile);
  check(!mergeConfig.enabled||raw.repo===MERGE_RECONCILE_REPO,'COMPANION_MERGE_RECONCILE_REPO_INVALID');
  const mergeRunner=new Runner({env:{...process.env},jobHost});
  const mergeIdentity={nodeName:cfg.node.nodeName,repo:raw.repo,pinnedSource:MERGE_RECONCILE_WORKFLOW_SHA256};
  const mergeReconcile=mergeConfig.enabled?new MergeReconciler({...mergeIdentity,ghExe:raw.ghExe,clock:Date.now,
    run:(a,o)=>mergeRunner.run(a,o),readStatus:()=>readStatus(values.root),
    notify,
    state:await MergeReconcileState.open(path.join(cfg.node.ownerProfileDirectory,'AppData','Local','CluedIndependentCI','companion-merge-reconcile.json'),mergeIdentity)}):null;
  // Generation 12 (DESIGN §56.5, Decision 207c0cd0 v2): the one repair re-run of the required tests the admission gate allows, clicked
  // with the Owner's gh login when the gate timed out before stage 1's admission. Its own Runner and its own memory file.
  const rerunRunner = new Runner({ env: { ...process.env }, jobHost });
  const rerunner = new AdmissionRerunner({ gh: ghPort({ ghExe: raw.ghExe, repo: raw.repo, run: (a, o) => rerunRunner.run(a, o) }),
    state: await AdmissionRerunState.open(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local', 'CluedIndependentCI', 'companion-admission-rerun.json')),
    clock: Date.now, readStatus: () => readStatus(values.root), pulls: () => (poller.lastPass ? poller.lastPass.pulls : null),
    notify });
  // The PR page says when this lane re-ran a head's required tests (pr-status.mjs#PrStatusReporter, rerunDone).
  reporter.rerunDone = headSha => rerunner.done(headSha);
  keepalive(companionArgv(cfg).keepalive());
  // M5 (ADR 0022 §6 Q1, Q2): the WSL instance this session sees, for the Owner's read-only probe. In the background; never blocks.
  sessionFacts({ wsl: (...l) => [cfg.wslExe, '--distribution', cfg.distribution, '--user', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'LC_ALL=C', ...l],
    run: (a, o) => upgradeRunner.run(a, o) })
    .then(f => writeSessionFacts(path.join(cfg.node.ownerProfileDirectory, 'AppData', 'Local', 'CluedIndependentCI'), { ...f, wslClient })).catch(() => {});
  let lastPoll = 0, lastReport = 0, lastBackstop = 0, lastSignature = null, lastStatusRead = 0;
  // Only now, with a usable job host and every part of the companion set up: a companion whose job host cannot start a
  // child, or whose set-up failed, sends no heartbeat, so the service starts no batch (DESIGN §24; design r3 review MINOR 1;
  // r3 implementation review MAJOR 2). The beat stops with the lanes; the entry below exits outright, so no timer keeps a
  // companion alive that answers nothing.
  const beating = startHeartbeat(mailbox);
  const lockAlive = setInterval(() => { instanceLock.touch().catch(() => {}); }, COMPANION_LOCK_TOUCH_MS);
  // Review MINOR 6: the companion's own gh login is checked again every few minutes, not only at start: a hosts.yml that lost its token
  // would make gh fall back to the Owner's shared credential-store entry. A failed check ends the companion (the supervisor restarts it,
  // and the start-up check then refuses: fail closed).
  const ghRecheck = setInterval(() => {
    assertGhIsolation({ env: process.env, profileDir: cfg.node.ownerProfileDirectory, ghExe: raw.ghExe }).catch(() => { process.exit(5); });
  }, GH_RECHECK_EVERY_MS);
  try {
    await Promise.all([
      // the service times out and classifies a request the companion did not answer; never retried here
      lane({ runner, work: () => companion.step() }),
      lane({ runner: upgradeRunner, work: () => upgradeLane.step(), everyMs: UPGRADE_LANE_EVERY_MS }),
      ...(heartbeat ? [lane({ runner: heartbeatRunner, work: () => heartbeat.step(), everyMs: HEARTBEAT_LANE_EVERY_MS })] : []),
      ...(panelDispatch ? [lane({ runner: panelRunner, work: () => panelDispatch.step(), everyMs: PANEL_DISPATCH_LANE_EVERY_MS })] : []),
      ...(mergeReconcile?[lane({runner:mergeRunner,work:()=>mergeReconcile.step(),everyMs:MERGE_RECONCILE_LANE_EVERY_MS})]:[]),
      lane({ runner: rerunRunner, work: () => rerunner.step(), everyMs: RERUN_LANE_EVERY_MS }),
      lane({ runner: advisory, work: async () => {
        try { await retentionNotifier.step(); } catch { /* advisory; retry without marking an undelivered notice */ }
        if (Date.now() - lastPoll > POLL_EVERY_MS) {
          lastPoll = Date.now();
          // The run queue's generation (phase 2): a queue that started over gets every open PR proposed again.
          let generation = null;
          try { generation = (await readStatus(values.root)).queue?.generation ?? null; } catch { generation = null; }
          try { await poller.pass({ generation }); } catch { /* next pass */ }
        }
        // The ruleset backstop (phase 2 step 3c-1, DESIGN §22.3): main's rules every five minutes, as before the 60-second poll.
        if (Date.now() - lastBackstop > BACKSTOP_EVERY_MS) {
          lastBackstop = Date.now();
          try { await companionBackstop({ root: values.root, ghExe: raw.ghExe, repo: raw.repo, powershellExe: cfg.powershellExe, run: (a, o) => advisory.run(a, o), store, notify }); } catch { /* next time */ }
        }
        // Generation 10 (DESIGN 53.5): status.json is read at most every REPORT_MIN_GAP_MS; the PR page is posted every minute as before,
        // and also at once when the batch, its stage, the breaker, the intake pause or HALT/PAUSE changed (a claimed batch or a started
        // trial is on the page within seconds, not after the next minute or the batch's end). reporter.pass still writes only what
        // changed, within its own bounds.
        if (Date.now() - lastReport > REPORT_MIN_GAP_MS && Date.now() - lastStatusRead > REPORT_MIN_GAP_MS) {
          lastStatusRead = Date.now();
          let status = null, statusError = false;
          try { status = await readStatus(values.root); } catch { statusError = true; }
          const signature = statusSignature(status);
          if (reportDue({ now: Date.now(), lastReport, lastSignature, signature, everyMs: REPORT_EVERY_MS })) {
            lastReport = Date.now();
            lastSignature = signature;
            try { await reporter.pass({ pulls: poller.lastPass?.pulls ?? [], status, statusError }); } catch { /* advisory: the next minute tries again */ }
          }
        }
      } }),
    ]);
  } finally {
    clearInterval(beating);
    clearInterval(lockAlive);
    clearInterval(ghRecheck);
  }
}

// The entry point on any platform, also behind a junction or a symlink (scripts/ci/main-entry-realpath.test.mjs): links resolved
// on both sides. (The earlier test built a file:/// URL by hand, which no POSIX path ever equals: on Linux the program did nothing
// and exited 0.) Not import.meta.main, which the installed runtime\node.exe may be too old for.
const isEntryPoint = () => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntryPoint()) {
  main().catch(() => { process.exit(4); });
}
