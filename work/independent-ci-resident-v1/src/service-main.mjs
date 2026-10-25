// Entry point of the CluedCIResident service (started by ResidentServiceHost.exe as
// NT SERVICE\CluedCIResident in Session 0). Every path and pin comes from the command line that the
// Owner's elevated install wrote into the service configuration; nothing is read from a user profile.
//
//   node service-main.mjs --root C:\ProgramData\CluedIndependentCI\resident --policy-sha256 <sha>
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HEX64, check, parseBoundedJson, sha256 } from './canonical.mjs';
import { validatePolicy } from './policy.mjs';
import { Ledger } from './ledger.mjs';
import { ReceiptChain } from './receipts.mjs';
import { Inbox, OwnerInbox } from './inbox.mjs';
import { Mailbox } from './mailbox.mjs';
import { ResidentExecutor } from './executor.mjs';
import { Runner, serviceEnv } from './runner.mjs';
import { installedIntegrity, mailboxCompanion } from './service-ports.mjs';
import { WindowsEngine } from './engine-windows.mjs';
import { acquireInstanceLock, processAlive } from './instance-lock.mjs';
import { stopRequestCheck } from './stop-request.mjs';
import { readBounded } from './store.mjs';
import { RetentionWatch, measureWindows } from './retention.mjs';
import { ExecutedHeads } from './executed-heads.mjs';
import { STATUS_FILE, StatusBoard, StatusFile, startStatusTimer } from './status.mjs';
import { RunQueue } from './queue.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, 'policy-sha256': { type: 'string' }, once: { type: 'boolean' } } });
  check(typeof values.root === 'string' && path.isAbsolute(values.root), 'SERVICE_ROOT_REQUIRED');
  check(HEX64.test(values['policy-sha256'] ?? ''), 'SERVICE_POLICY_PIN_REQUIRED');
  const root = values.root;
  const policyBytes = await readBounded(path.join(root, 'config', 'policy.json'), 65536, 'SERVICE_POLICY_REFUSED');
  check(sha256(policyBytes) === values['policy-sha256'], 'SERVICE_POLICY_CHANGED');
  const policy = validatePolicy(parseBoundedJson(policyBytes, 65536, 'SERVICE_POLICY_REFUSED'));
  const clock = Date.now;
  const state = path.join(root, 'state');
  const lock = await acquireInstanceLock(state, { alive: processAlive, clock });
  const ledger = await Ledger.open(state, clock);
  const receipts = await ReceiptChain.open(path.join(state, 'receipts'), clock);
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
  const engine = new WindowsEngine({
    node: policy.node, nodeProfileSha256: policy.nodeProfileSha256,
    run: (a, o) => runner.run(a, o), busy: () => runner.busy, companionMailbox: mailbox, sleep, clock,
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
  const companion = mailboxCompanion(mailbox, sleep);
  // Executed heads independent of the Source (resident quota redesign phase 1): the install carries every earlier
  // install's ledger into state\backfill\ and lists it in the admin-only install\backfill-manifest.json.
  const executedHeads = await ExecutedHeads.open(state, clock, { manifestFile: path.join(root, 'install', 'backfill-manifest.json'), carriedRoot: path.join(state, 'backfill') });
  // The status snapshot (state\status.json, read by the companion): rewritten whole on a timer, so writtenAt moves
  // even while one stage runs for 45 minutes.
  const status = new StatusBoard({ clock });
  const statusTimer = startStatusTimer({ board: status, file: new StatusFile(path.join(state, STATUS_FILE)) });
  await statusTimer.flush();
  // The executor's own run queue (phase 2, step 1; DESIGN §17): state\queue\queue.json, a view the ledger overrules.
  const queue = await RunQueue.open(path.join(state, 'queue'), clock);
  const exec = new ResidentExecutor({
    policy, ledger, receipts, inbox, requests, owner, engine, clock, companion, sleep, executedHeads, status, queue,
    sourceIntegrity: installedIntegrity({
      sourceRoot, sourceManifest: path.join(root, 'config', 'source-installed-manifest.json'),
      residentRoot: path.join(root, 'resident', policy.residentManifestSha256), residentManifest: path.join(root, 'config', 'resident-installed-manifest.json'),
    }),
  });
  const retention = new RetentionWatch({ policy, receipts, clock,
    measureWindows: () => measureWindows({ spool: path.join(path.dirname(root), 'formal-spool'), work: path.join(root, 'work'), bundles: path.join(root, 'bundles') }),
    measureLinux: () => companion.archiveUsage() });
  await receipts.append('service-start', { policySha256: values['policy-sha256'], pid: process.pid });
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
    betweenBatches: () => retention.maybeCheck() });
}

// The service loop. Every iteration refreshes the instance-lock liveness and honours an SCM stop before it
// runs one tick, and a tick never blocks on the hosted wait (it returns WAITING), so neither the liveness
// record nor a stop, a pause or an Owner request ever waits for hosted signals.
export const RESTING_STATES = Object.freeze(['IDLE', 'DEFERRED', 'HALTED', 'PAUSED', 'WAITING', 'BACKFILL_PENDING']);
export async function serviceLoop({ exec, lock, sleep, once = false, stopRequested, acknowledgeStop, onLoopException, betweenBatches }) {
  for (;;) {
    await lock.touch();
    // SCM stop is honoured only here, before every tick, the first included (ResidentServiceHost never kills us).
    if (await stopRequested()) {
      await acknowledgeStop();
      return 0;
    }
    let result;
    try {
      result = await exec.tick();
    } catch (error) {
      // The loop itself failed. Latch HALT if we still can and exit; the next start runs recovery
      // first, which terminalises any entry this tick left open, so re-arm is never wedged.
      try { await onLoopException(error); } catch { /* keep exiting */ }
      return 3;
    }
    // Between batches only (a tick runs at most one batch step): the 50 GB archive reminder, at most hourly.
    if (['IDLE', 'DEFERRED', 'PAUSED', 'WAITING'].includes(result.state)) { try { await betweenBatches(); } catch { /* a reminder is advisory */ } }
    if (once) return 0;
    await sleep(RESTING_STATES.includes(result.state) ? 15_000 : 2_000);
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().then(code => { process.exitCode = code; }, () => { process.exitCode = 4; });
}
