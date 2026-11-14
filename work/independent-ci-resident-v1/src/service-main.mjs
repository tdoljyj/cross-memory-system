// Entry point of the CluedCIResident service (started by ResidentServiceHost.exe as
// NT SERVICE\CluedCIResident in Session 0). Every path and pin comes from the command line that the
// Owner's elevated install wrote into the service configuration; nothing is read from a user profile.
//
//   node service-main.mjs --root C:\ProgramData\CluedIndependentCI\resident --policy-sha256 <sha>
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HEX64, UUID, check, parseBoundedJson, sha256 } from './canonical.mjs';
import { validatePolicy, installedTrainLanding } from './policy.mjs';
import { Ledger } from './ledger.mjs';
import { ReceiptChain } from './receipts.mjs';
import { Inbox, OwnerInbox } from './inbox.mjs';
import { Mailbox } from './mailbox.mjs';
import { ResidentExecutor, lockHeldInEarlierBoot } from './executor.mjs';
import { Runner, serviceEnv } from './runner.mjs';
import { installedIntegrity, mailboxCompanion } from './service-ports.mjs';
import { WindowsEngine, installedTrainMode } from './engine-windows.mjs';
import { acquireResidentLock } from './resident-lock.mjs';
import { stopRequestCheck } from './stop-request.mjs';
import { readBounded } from './store.mjs';
import { KEEP_FILE, RetentionWatch, measureWindows, pruneSpool, readKeepList } from './retention.mjs';
import { SETTINGS_FILE, readRetentionSettings } from './retention-settings.mjs';
import { NODE_STATUS_FILE, readNodeStatus } from './host-capacity.mjs';
import { ExecutedHeads } from './executed-heads.mjs';
import { STATUS_FILE, STATUS_MAX_BYTES, StatusBoard, StatusFile, readVersionState, readVersionInputs, startStatusTimer } from './status.mjs';
import { RunQueue } from './queue.mjs';
import { CompanionPresence, PRESENCE_EVERY_MS } from './companion-presence.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The service-start receipt (in-place upgrade channel, Task 018da927, DESIGN §34; frozen observation surface A11: the upgrader reads
// its body): { policySha256, pid, generation }, generation from upgrade\current.json (null when there is none or it cannot be read).
// When the previous service-start named a different generation (both known), one 'resident-upgraded' receipt follows:
// { fromGeneration, toGeneration, opId, packageManifestSha256, policySha256 } (opId and the package from the same current.json; a
// rollback is a generation change too, toGeneration < fromGeneration). Returns { generation, upgraded }.
export async function recordServiceStart({ receipts, root, policySha256, pid = process.pid }) {
  const { current } = await readVersionInputs(root);
  const generation = Number.isSafeInteger(current?.generation) && current.generation >= 1 ? current.generation : null;
  let previous = null;
  try { previous = (await receipts.latest(['service-start'], 1))[0]?.value?.body ?? null; } catch { previous = null; }
  await receipts.append('service-start', { policySha256, pid, generation });
  const before = Number.isSafeInteger(previous?.generation) ? previous.generation : null;
  if (generation === null || before === null || before === generation) return { generation, upgraded: false };
  await receipts.append('resident-upgraded', { fromGeneration: before, toGeneration: generation,
    opId: typeof current.opId === 'string' && UUID.test(current.opId) ? current.opId : null,
    packageManifestSha256: HEX64.test(current.packageManifestSha256 ?? '') ? current.packageManifestSha256 : null, policySha256 });
  return { generation, upgraded: true };
}

// `ports` is for the tests only (readProcess: what Windows says about a pid); the service passes none.
export async function main(argv = process.argv.slice(2), ports = {}) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, 'policy-sha256': { type: 'string' }, once: { type: 'boolean' } } });
  check(typeof values.root === 'string' && path.isAbsolute(values.root), 'SERVICE_ROOT_REQUIRED');
  check(HEX64.test(values['policy-sha256'] ?? ''), 'SERVICE_POLICY_PIN_REQUIRED');
  const root = values.root;
  const policyBytes = await readBounded(path.join(root, 'config', 'policy.json'), 65536, 'SERVICE_POLICY_REFUSED');
  check(sha256(policyBytes) === values['policy-sha256'], 'SERVICE_POLICY_CHANGED');
  const policy = validatePolicy(parseBoundedJson(policyBytes, 65536, 'SERVICE_POLICY_REFUSED'));
  const clock = Date.now;
  const state = path.join(root, 'state');
  // DESIGN §71: read before the lock is taken over (the takeover renames it away).
  const lockFromEarlierBoot = await lockHeldInEarlierBoot(state);
  // The holder counts only while its pid is still this root's service-main, started no later than its lock (resident-lock.mjs).
  const lock = await acquireResidentLock(state, root, { clock, readProcess: ports.readProcess });
  await fs.rm(path.join(state, START_REFUSED_FILE), { force: true }).catch(() => {}); // an earlier refusal no longer holds
  const ledger = await Ledger.open(state, clock);
  // DESIGN §41.7: the start closes the months before the current one (receipts.mjs); it then reads only the seals and this month.
  const receipts = await ReceiptChain.open(path.join(state, 'receipts'), clock, { seal: true });
  const inbox = await Inbox.open(path.join(root, 'inbox'), path.join(state, 'inbox-archive'));
  const requests = await Inbox.open(path.join(root, 'requests'), path.join(state, 'requests-archive'));
  const owner = await OwnerInbox.open(path.join(root, 'owner'), path.join(state, 'owner-seen'));
  const mailbox = await Mailbox.open(path.join(root, 'mailbox'), clock);
  // The children's temp directory is the service's own (state\ is resident-only modify): Add-Type in the
  // Windows archive tool compiles there, never in C:\Windows (first real batch, 2026-10-21).
  const tempDir = path.join(state, 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const runner = new Runner({ env: serviceEnv(tempDir, policy.node, policy.nodeProfileSha256) });
  // Source v2: the installed CI Source lives under the CI Source manifest hash of the install record (the
  // directory the generic helper loads code from); its installed-files manifest (A) pins every byte.
  const sourceRoot = path.join(root, 'source', policy.ciSourceManifestSha256);
  // DESIGN §34: the versions of both sides, read fresh by the executor every tick and by the engine before the first Linux stage.
  const versions = () => readVersionState({ root, policy, policySha256: values['policy-sha256'], clock });
  const engine = new WindowsEngine({
    node: policy.node, nodeProfileSha256: policy.nodeProfileSha256, versions: async () => (await versions()).view,
    run: (a, o) => runner.run(a, o), busy: () => runner.busy, companionMailbox: mailbox, sleep, clock,
    // DESIGN §41.2: stages 1 and 8 learn the installed train.enabled through the stage directory (train-mode.json).
    trainMode: installedTrainMode(policy),
    // ADR 0018: stages 8 and 10 learn train.landing and train.batchMax through the stage directory (train-landing.json).
    trainLanding: installedTrainLanding(policy),
    paths: {
      sourceRoot,
      workRoot: path.join(root, 'work'),
      outboxRoot: path.join(root, 'outbox'),
      nodeExe: path.join(root, 'runtime', 'node.exe'),
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      scExe: 'C:\\Windows\\System32\\sc.exe',
      // Owner abort: the stop request is written next to the in-flight broker request (DESIGN §6.5).
      brokerRoot: path.join(root, 'broker'),
    },
  });
  // Defect 8f8240ff: a stop gives up the retention requests the between-batches step still waits for (serviceLoop).
  const leaving = new AbortController();
  const companion = mailboxCompanion(mailbox, sleep, { abandon: leaving.signal });
  // Executed heads independent of the Source (resident quota redesign phase 1): the install carries every earlier
  // install's ledger into state\backfill\ and lists it in the admin-only install\backfill-manifest.json.
  const executedHeads = await ExecutedHeads.open(state, clock, { manifestFile: path.join(root, 'install', 'backfill-manifest.json'), carriedRoot: path.join(state, 'backfill') });
  // The status snapshot (state\status.json, read by the companion): rewritten whole on a timer, so writtenAt moves
  // even while one stage runs for 45 minutes.
  const status = new StatusBoard({ clock });
  // Stage timings survive a restart (status /8): the previous snapshot's finished and resting batches and stage-10 rounds are read back, each re-checked.
  try { status.restoreTiming(JSON.parse((await readBounded(path.join(state, STATUS_FILE), STATUS_MAX_BYTES, 'STATUS_REFUSED')).toString('utf8')).timing); } catch { /* none, or unreadable: start empty */ }
  const statusTimer = startStatusTimer({ board: status, file: new StatusFile(path.join(state, STATUS_FILE)) });
  await statusTimer.flush();
  // The executor's own run queue (phase 2, step 1; DESIGN §17): state\queue\queue.json, a view the ledger overrules.
  const queue = await RunQueue.open(path.join(state, 'queue'), clock);
  // M5 (ADR 0022 §4.5): when the companion first beat after this start, and a companion-absent notice after 10 minutes without one.
  const companionPresence = new CompanionPresence({ startedAt: clock() });
  const presenceTimer = setInterval(async () => {
    try { companionPresence.observe(await companion.heartbeat()); status.setCompanion(companionPresence.view()); } catch { /* a view only */ }
  }, PRESENCE_EVERY_MS);
  presenceTimer.unref?.();
  const exec = new ResidentExecutor({
    policy, ledger, receipts, inbox, requests, owner, engine, clock, companion, sleep, executedHeads, status, queue, versions, companionPresence,
    // DESIGN §71: a batch an earlier boot left open may be closed clean (and run again) only when this start knows it took over from that boot.
    lockFromEarlierBoot,
    // Generation 10 (DESIGN 53.5): the executor writes status.json at once when a batch is claimed and when a breaker trial starts.
    statusFlush: () => statusTimer.flush(),
    // Node governance v1: the node's status file is the only disk rule (red on the resident WSL disk's drive holds new batches).
    nodeStatus: () => readNodeStatus(NODE_STATUS_FILE),
    sourceIntegrity: installedIntegrity({
      sourceRoot, sourceManifest: path.join(root, 'config', 'source-installed-manifest.json'),
      residentRoot: path.join(root, 'resident', policy.residentManifestSha256), residentManifest: path.join(root, 'config', 'resident-installed-manifest.json'),
    }),
  });
  const spool = path.join(path.dirname(root), 'formal-spool');
  const retention = new RetentionWatch({ policy, receipts, clock,
    readSettings: () => readRetentionSettings(path.join(root, 'owner', SETTINGS_FILE)),
    measureWindows: () => measureWindows({ spool, work: path.join(root, 'work'), bundles: path.join(root, 'bundles') }),
    measureLinux: () => companion.archiveUsage(),
    // Task 018da927 (c): nothing is asked of the companion without a fresh heartbeat (the same age the executor requires).
    companionReady: async () => { const beat = await companion.heartbeat(); return !!beat && typeof beat.at === 'number' && clock() - beat.at <= policy.companion.heartbeatMaxAgeMs; },
    // DESIGN §35: archives are deleted only with no open batch (running, waiting or parked), no HALT, no unarchived scene and no child running.
    idle: async () => {
      if (runner.busy) return { ok: false, reason: 'CHILD_RUNNING' };
      if (await ledger.halted()) return { ok: false, reason: 'HALTED' };
      if ((await ledger.open()).length > 0) return { ok: false, reason: 'BATCH_OPEN' };
      if ((await ledger.unarchivedScenes()) > 0) return { ok: false, reason: 'SCENE_UNARCHIVED' };
      return { ok: true };
    },
    pruneWindows: async settings => {
      const original = await readKeepList(path.join(root, 'owner', KEEP_FILE), 'windows');
      return pruneSpool({ spool, keep: original, now: clock(),
        authorizeDelete: async () => {
          const current = await readRetentionSettings(path.join(root, 'owner', SETTINGS_FILE));
          const keep = await readKeepList(path.join(root, 'owner', KEEP_FILE), 'windows');
          return current.ok && JSON.stringify(current.settings) === JSON.stringify(settings) && keep.ok
            && keep.entries === original.entries && [...keep.names].sort().join('\n') === [...original.names].sort().join('\n');
        } });
    },
    pruneLinux: () => companion.archivePrune() });
  await recordServiceStart({ receipts, root, policySha256: values['policy-sha256'], pid: process.pid });
  const stopFile = path.join(state, 'STOP-REQUESTED');
  return serviceLoop({ exec, lock, sleep, once: values.once === true,
    // A request left from an earlier boot is renamed with a receipt and does not stop us (src/stop-request.mjs).
    stopRequested: stopRequestCheck({ stopFile, locksDir: path.join(state, 'locks'), receipts, clock }),
    acknowledgeStop: async () => {
      await receipts.append('service-stop', { pid: process.pid });
      await fs.rename(stopFile, path.join(state, 'locks', `stop-${Date.now()}-${process.pid}`));
      status.setState('STOPPED');
      statusTimer.stop();
      await statusTimer.flush();
    },
    onLoopException: async error => { await ledger.halt('RESIDENT_LOOP_EXCEPTION', { message: String(error?.code ?? 'unknown') }); },
    betweenBatches: () => retention.maybeCheck(),
    // A stop: the companion waits end (service-ports.mjs) and the rest of a running pass measures nothing more on Windows (review MINOR 5).
    abandonBetweenBatches: () => { leaving.abort(); retention.measureWindows = async () => ({ bytes: 0, directories: 0, complete: false }); } });
}

// The service loop. Every iteration refreshes the instance-lock liveness and honours an SCM stop before it
// runs one tick, and a tick never blocks on the hosted wait (it returns WAITING), so neither the liveness
// record nor a stop, a pause or an Owner request ever waits for hosted signals.
// Nor for the between-batches step (defect 8f8240ff, TURING 2026-11-08: archive-prune waited its whole 10 minutes for a wsl.exe that
// never returned, then archive-usage 3 more, and the upgrader's pause went unanswered past its 10 minutes): the step runs beside the
// loop, one at a time; while it runs every tick is told so and opens no new batch; a stop first gives up its companion waits
// (abandonBetweenBatches) and lets it finish, at most leaveMaxMs (a Windows walk or deletion already under way is not cut; past that the
// stop is acknowledged and the process ends when it does). `once` still waits for it.
export const RESTING_STATES = Object.freeze(['IDLE', 'DEFERRED', 'HALTED', 'PAUSED', 'WAITING', 'BACKFILL_PENDING']);
export const LEAVE_MAX_MS = 120_000;
export async function serviceLoop({ exec, lock, sleep, once = false, stopRequested, acknowledgeStop, onLoopException, betweenBatches, abandonBetweenBatches = () => {},
  leaveMaxMs = LEAVE_MAX_MS }) {
  let between = null;
  const leave = async () => {
    if (!between) return;
    try { abandonBetweenBatches(); } catch { /* it finishes at its own deadlines then */ }
    let timer;
    await Promise.race([between, new Promise(r => { timer = setTimeout(r, leaveMaxMs); })]);
    clearTimeout(timer);
  };
  for (;;) {
    await lock.touch();
    // SCM stop is honoured only here, before every tick, the first included (ResidentServiceHost never kills us).
    if (await stopRequested()) {
      await leave();
      await acknowledgeStop();
      return 0;
    }
    let result;
    try {
      result = await exec.tick({ betweenBatchesRunning: between !== null });
    } catch (error) {
      // The loop itself failed. Latch HALT if we still can and exit; the next start runs recovery
      // first, which terminalises any entry this tick left open, so re-arm is never wedged.
      try { await onLoopException(error); } catch { /* keep exiting */ }
      await leave();
      return 3;
    }
    // Between batches only (a tick runs at most one batch step): archive retention, the 50 GB and the C: reminders, at most hourly
    // (DESIGN §7.3, §35). Without a companion heartbeat nothing is asked of the companion, so this never waits for its timeout.
    if (between === null && ['IDLE', 'DEFERRED', 'PAUSED', 'WAITING'].includes(result.state)) {
      const step = (async () => { try { await betweenBatches(); } catch { /* a reminder is advisory */ } })()
        .finally(() => { if (between === step) between = null; });
      between = step;
      if (once) await step;
    }
    if (once) return 0;
    // `immediate`: stage 10 just decided a batch is to open (executor.mjs tickBatchDue); the short sleep, not the resting one.
    await sleep(RESTING_STATES.includes(result.state) && result.immediate !== true ? 15_000 : 2_000);
  }
}

// A start that ends before the loop runs (exit 4; the host reports 1064 and the SCM restarts the service after a minute) used to
// leave nothing behind: the host does not keep the executor's output and no receipt exists yet (DESK 2026-11-14 01:38:38). The code
// and what it names are now written to state\start-refused.json (as the companion's companion-lock\refused.json); the next start
// that gets the lock removes it. Best effort: a start refused for its arguments has no root to write to.
export const START_REFUSED_FILE = 'start-refused.json';
export async function recordStartRefusal(argv, error, clock = Date.now) {
  try {
    const at = argv.indexOf('--root');
    const root = at >= 0 ? argv[at + 1] : null;
    if (typeof root !== 'string' || !path.isAbsolute(root)) return;
    const coded = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code);
    const detail = ['string', 'number', 'boolean'].includes(typeof error?.detail) ? error.detail : null;
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', START_REFUSED_FILE), JSON.stringify({ contract: 'clued.independent-ci.start-refused/1',
      code: coded ? error.code : 'RESIDENT_START_EXCEPTION', detail, message: coded ? null : String(error?.message ?? error).slice(0, 500),
      at: new Date(clock()).toISOString(), pid: process.pid }) + '\n');
  } catch { /* the refusal stands */ }
}

export async function run(argv = process.argv.slice(2), ports = {}) {
  try { return await main(argv, ports); } catch (error) { await recordStartRefusal(argv, error); return 4; }
}

// The entry point on any platform, also behind a junction or a symlink (scripts/ci/main-entry-realpath.test.mjs): links resolved
// on both sides. (The earlier test built a file:/// URL by hand, which no POSIX path ever equals: on Linux the program did nothing
// and exited 0.) Not import.meta.main, which the installed runtime\node.exe may be too old for.
const isEntryPoint = () => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntryPoint()) {
  run().then(code => { process.exitCode = code; });
}
