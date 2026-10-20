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
import { Runner } from './runner.mjs';
import { installedIntegrity, mailboxCompanion } from './service-ports.mjs';
import { WindowsEngine } from './engine-windows.mjs';
import { acquireInstanceLock, processAlive } from './instance-lock.mjs';
import { readBounded } from './store.mjs';
import { RetentionWatch, measureWindows } from './retention.mjs';

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
  const runner = new Runner();
  // Source v2: the installed CI Source lives under the CI Source manifest hash of the install record (the
  // directory the generic helper loads code from); its installed-files manifest (A) pins every byte.
  const sourceRoot = path.join(root, 'source', policy.ciSourceManifestSha256);
  const engine = new WindowsEngine({
    run: (a, o) => runner.run(a, o), busy: () => runner.busy, companionMailbox: mailbox, sleep, clock,
    paths: {
      sourceRoot,
      workRoot: path.join(root, 'work'),
      outboxRoot: path.join(root, 'outbox'),
      nodeExe: path.join(root, 'runtime', 'node.exe'),
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      scExe: 'C:\\Windows\\System32\\sc.exe',
    },
  });
  const companion = mailboxCompanion(mailbox, sleep);
  const exec = new ResidentExecutor({
    policy, ledger, receipts, inbox, requests, owner, engine, clock, companion,
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
  for (;;) {
    await lock.touch();
    // SCM stop is honoured only here, between batches (ResidentServiceHost never kills us).
    if (await fs.access(stopFile).then(() => true, () => false)) {
      await receipts.append('service-stop', { pid: process.pid });
      await fs.rename(stopFile, path.join(state, 'locks', `stop-${Date.now()}-${process.pid}`));
      return 0;
    }
    let result;
    try {
      result = await exec.tick();
    } catch (error) {
      // The loop itself failed. Latch HALT if we still can and exit; the next start runs recovery
      // first, which terminalises any entry this tick left open, so re-arm is never wedged.
      try { await ledger.halt('RESIDENT_LOOP_EXCEPTION', { message: String(error?.code ?? 'unknown') }); } catch { /* keep exiting */ }
      return 3;
    }
    // Between batches only (tick is synchronous): the 50 GB archive reminder, measured at most hourly.
    if (['IDLE', 'DEFERRED', 'PAUSED'].includes(result.state)) { try { await retention.maybeCheck(); } catch { /* a reminder is advisory */ } }
    if (values.once) return 0;
    await sleep(['IDLE', 'DEFERRED', 'HALTED', 'PAUSED'].includes(result.state) ? 15_000 : 2_000);
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().then(code => { process.exitCode = code; }, () => { process.exitCode = 4; });
}
