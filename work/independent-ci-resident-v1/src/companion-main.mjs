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
import { Companion, argv as companionArgv, validateCompanionConfig, validateHintConfig } from './companion.mjs';
import { HostedHints, sourceHintObserver } from './hosted-hints.mjs';
import { createGhReadPort } from './gh-read-port.mjs';
import { Mailbox } from './mailbox.mjs';
import { Runner } from './runner.mjs';
import { Poller } from './poller.mjs';
import { Inbox } from './inbox.mjs';
import { canonicalJson } from './canonical.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const mailbox = await Mailbox.open(path.join(values.root, 'mailbox'), Date.now);
  const companion = new Companion({ cfg, mailbox, run: (a, o) => runner.run(a, o), fileExists: exists, sleep, clock: Date.now });
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
    const github = createGhReadPort({ ghExe: raw.ghExe, repo: raw.repo, run: (a, o) => runner.run(a, o) });
    hints = new HostedHints({ repo: raw.repo, mailbox, clock: Date.now,
      observeHead: sourceHintObserver({ registry, createObserver: createHostedRelayObserver, hostedHint, github, repo: raw.repo }) });
  }
  const poller = new Poller({
    repo: raw.repo, ghExe: raw.ghExe, run: (a, o) => runner.run(a, o), clock: Date.now, hints,
    writeTrigger: async v => { await fs.writeFile(path.join(inboxDir, Inbox.fileName(Date.now())), canonicalJson(v), { flag: 'wx' }); },
  });
  keepalive(companionArgv(cfg).keepalive());
  let lastPoll = 0;
  for (;;) {
    if (!runner.busy) {
      try { await companion.step(); } catch { /* the service times out and classifies; never retry here */ }
      if (Date.now() - lastPoll > 5 * 60_000) { lastPoll = Date.now(); try { await poller.pass(); } catch { /* next pass */ } }
    }
    await sleep(2_000);
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch(() => { process.exitCode = 4; });
}
