#!/usr/bin/env node
// One command that says whether a change forgot to re-register a pinned file.
//
// Several registries pin the exact bytes of source files. Changing a pinned file
// without regenerating its registry fails clued-cloud-tests, about 16 minutes
// after the push. This runs the same checks in seconds, lists every registry
// that is out of date and prints the exact command that regenerates it.
//
//   node scripts/ci/check-pinned-registries.mjs [--base <main commit>] [--root <checkout>] [--only <id>]...
//
// Registries covered (id: registry -> regeneration):
//   r9         scripts/ci/merge-admission-r9-source.json      merge-admission-r9-reregister.mjs --write
//   reconcile  scripts/ci/clued-merge-reconcile-source.json   fixed workflow and Role (manual review)
//   control-source-pins  pure component-version changes in the initial control Source; all other historical pins stay fixed
//   components config/clued-components.json                   scripts/clued_components.py (bump; no stored digest)
//   agent-contract worker/generated/{agent-contract,components}.ts  generate-agent-contract.mjs
//   plugin     integrations/claude-code/clued/ (copies of skills/hooks)  build_claude_code_plugin.py
//   pdf-cmaps  worker/generated/pdf-cmaps.ts                    generate-pdf-cmaps.mjs (needs npm ci in apps/clued-cloud)
//   imprint-rules the imprint-rules block of a supabase migration   generate-imprint-domain-rules.mjs (needs npm ci)
// The last four are generated files, not pinned hashes: each generator has a --check mode and a test in CI that fails
// when the committed output is out of date, so they fail the same way and are listed here for the same reason.
// Looked at and deliberately not covered (no regeneration command, or not changed by editing a file): the
// clued-*-sources.json / source-pins / gated-proof registries (hand-reviewed pins of historical blobs, except the narrowly
// checked component-version derivation above), the
// handover-external acceptance (Owner-signed), existing-release-v3-host/source-freeze.json (a frozen, versioned package),
// .github/actions/ci-temporary-storage/check-workflows.mjs (hashes written by hand after review).
//
// --base is the main commit the change is measured against (r9 rotates its history
// from it, components compares versions with it). Default: CI_BASE_SHA, then
// CLUED_R9_BASE, then the newest main ref HEAD contains.
//
// Exit 0: every registry is up to date. Exit 1: at least one is stale (all are
// listed with remediation). Exit 2: a registry could not be checked
// (reported, never silent); under GitHub Actions that is a warning and exit 0,
// because clued-cloud-tests remains the authoritative check there.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POLICY, readMechanicalPolicy } from './component-version-integration-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export const R9_FIX = 'node scripts/ci/merge-admission-r9-reregister.mjs --write --base <main commit>';
export const COMPONENTS_FIX = `${PYTHON} scripts/ci/component-version-integration.py --root <clean-candidate> --base <main commit> --expect-head <candidate commit> --write`;

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const gitOk = (root, args) => { try { execFileSync('git', args, { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };

// Explicit value, CI_BASE_SHA, CLUED_R9_BASE, else the newest main commit HEAD contains.
export function resolveBase(root, explicit, env = process.env, knownMainRefs = () => []) {
  for (const value of [explicit, env.CI_BASE_SHA, env.CLUED_R9_BASE]) if (value && !/^0+$/.test(value)) return value;
  const bases = new Set();
  for (const ref of knownMainRefs(root)) { try { bases.add(git(root, ['merge-base', 'HEAD', ref])); } catch { /* no shared history */ } }
  const list = [...bases];
  return list.find((a) => list.every((b) => gitOk(root, ['merge-base', '--is-ancestor', b, a]))) ?? null;
}

async function checkR9(root, base) {
  const fix = R9_FIX.replace('<main commit>', base ?? '<main commit>');
  const reregister = await import(pathToFileURL(path.join(root, 'scripts/ci/merge-admission-r9-reregister.mjs')).href);
  if (!base) return { id: 'r9', status: 'unchecked', reason: 'no base: pass --base <main commit> (fetch main first)', fix };
  let p;
  try { p = reregister.plan(root, { base }); } catch (error) { return { id: 'r9', status: 'unchecked', reason: error.message, fix }; }
  if (p.upToDate) return { id: 'r9', status: 'ok' };
  return { id: 'r9', status: 'stale', registry: reregister.R9_REGISTRY_PATH, details: p.result.changes, fix };
}

// The generator may be checking its uncommitted outputs. Only the controller
// authenticates a complete checkout against HEAD before loading credentials.
async function checkReconcile(root) {
  const mod = await import(pathToFileURL(path.join(root, 'scripts/ci/clued-merge-reconcile-source.mjs')).href);
  try {
    mod.verifyReconcileRegistration(root);
    return { id: 'reconcile', status: 'ok' };
  } catch (error) {
    return { id: 'reconcile', status: 'stale', registry: mod.SOURCE_FILE, details: [error.message],
      fix: 'review the registered workflow, Role and authority fields against their fixed pins' };
  }
}

function checkComponents(root, base) {
  if (!base) return { id: 'components', status: 'unchecked', reason: 'no base: pass --base <main commit>', fix: COMPONENTS_FIX };
  if (!gitOk(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) return { id: 'components', status: 'unchecked', reason: `base ${base} is not a commit here; fetch main first`, fix: COMPONENTS_FIX };
  const result = spawnSync(PYTHON, ['scripts/clued_components.py', 'check', '--base', base], { cwd: root, encoding: 'utf8' });
  if (result.error) return { id: 'components', status: 'unchecked', reason: `${PYTHON} did not run: ${result.error.message}`, fix: COMPONENTS_FIX };
  if (result.status === 0) return { id: 'components', status: 'ok' };
  const lines = (result.stderr + result.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  return { id: 'components', status: 'stale', registry: 'config/clued-components.json', details: lines, fix: COMPONENTS_FIX };
}

const CLOUD_DEPS_HINT = '   (needs the dependencies: first run  cd apps/clued-cloud && npm ci)';
// Generated files: the generator's own --check says whether the committed output is current.
export const GENERATED = [
  { id: 'agent-contract', registry: 'apps/clued-cloud/worker/generated/agent-contract.ts, components.ts', needs: [],
    cmd: ['node', 'apps/clued-cloud/scripts/generate-agent-contract.mjs', '--check'], fix: 'node apps/clued-cloud/scripts/generate-agent-contract.mjs' },
  { id: 'plugin', registry: 'integrations/claude-code/clued/', needs: [],
    cmd: [PYTHON, 'scripts/build_claude_code_plugin.py', '--check'], fix: `${PYTHON} scripts/build_claude_code_plugin.py` },
  { id: 'pdf-cmaps', registry: 'apps/clued-cloud/worker/generated/pdf-cmaps.ts', needs: ['apps/clued-cloud/node_modules/pdfjs-dist/package.json'],
    cmd: ['node', 'apps/clued-cloud/scripts/generate-pdf-cmaps.mjs', '--check'], fix: 'node apps/clued-cloud/scripts/generate-pdf-cmaps.mjs' + CLOUD_DEPS_HINT },
  { id: 'imprint-rules', registry: 'apps/clued-cloud/supabase/migrations/*_imprint_auto_domains_v1.sql', needs: ['apps/clued-cloud/node_modules/typescript/package.json'],
    cmd: ['node', 'apps/clued-cloud/scripts/generate-imprint-domain-rules.mjs', '--check'], fix: 'node apps/clued-cloud/scripts/generate-imprint-domain-rules.mjs' + CLOUD_DEPS_HINT },
];

function checkGenerated(root, g) {
  const missing = g.needs.find((file) => !fs.existsSync(path.join(root, file)));
  if (missing) return { id: g.id, status: 'unchecked', reason: `${missing} is missing; run npm ci in apps/clued-cloud`, fix: g.fix };
  const result = spawnSync(g.cmd[0], g.cmd.slice(1), { cwd: root, encoding: 'utf8' });
  if (result.error) return { id: g.id, status: 'unchecked', reason: `${g.cmd[0]} did not run: ${result.error.message}`, fix: g.fix };
  if (result.status === 0) return { id: g.id, status: 'ok' };
  const lines = (result.stderr + result.stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
  return { id: g.id, status: 'stale', registry: g.registry, details: lines, fix: g.fix };
}

// The one generated-file list must parse; Native reads the same bytes (published by CI admission).
function checkMechanicalPolicy(root) {
  try { readMechanicalPolicy(root); return { id: 'mechanical-policy', status: 'ok' }; } catch (error) {
    return { id: 'mechanical-policy', status: 'stale', registry: POLICY, details: [error.message], fix: `edit ${POLICY}` };
  }
}

const CONTROL_SOURCE_FIX = 'node scripts/ci/clued-control-source-pins.mjs --base <main commit> --write';
async function checkControlPins(root, base) {
  try {
    const mod = await import(pathToFileURL(path.join(root, 'scripts/ci/clued-control-source-pins.mjs')).href);
    const result = await mod.checkControlSourcePins(root, { base });
    // Once merged, this commit is the trusted base of every later candidate.
    // A committed checkout (as in CI) must therefore also pass as its own base;
    // checking only against the old base let main 4b1cc800 break every PR.
    let head = null;
    try { head = git(root, ['rev-parse', 'HEAD']); } catch { /* not a Git checkout */ }
    if (result.status !== 'ok' || !head || head === base || git(root, ['status', '--porcelain', '--untracked-files=no']) !== '') return result;
    const self = await mod.checkControlSourcePins(root, { base: head });
    return self.status === 'ok' ? result
      : { ...self, details: (self.details ?? []).map((d) => `with this commit ${head.slice(0, 12)} as the trusted base: ${d}`) };
  } catch (error) {
    return { id: 'control-source-pins', status: 'unchecked', reason: error.message,
      fix: CONTROL_SOURCE_FIX.replace('<main commit>', base ?? '<main commit>') };
  }
}

export const CHECK_IDS = ['r9', 'reconcile', 'components', ...GENERATED.map((g) => g.id), 'mechanical-policy', 'control-source-pins'];

export async function checkAll({ root = DEFAULT_ROOT, base = null, only = [], env = process.env, knownMainRefs } = {}) {
  let refs = knownMainRefs;
  if (!refs) refs = (await import(pathToFileURL(path.join(root, 'scripts/ci/merge-admission-r9-reregister.mjs')).href)).knownMainRefs;
  const resolved = resolveBase(root, base, env, refs);
  const want = (id) => only.length === 0 || only.includes(id);
  const results = [];
  if (want('r9')) results.push(await checkR9(root, resolved));
  if (want('reconcile')) results.push(await checkReconcile(root));
  if (want('components')) results.push(checkComponents(root, resolved));
  for (const g of GENERATED) if (want(g.id)) results.push(checkGenerated(root, g));
  if (want('mechanical-policy')) results.push(checkMechanicalPolicy(root));
  if (want('control-source-pins')) results.push(await checkControlPins(root, resolved));
  return { base: resolved, results };
}

export function render({ base, results }) {
  const out = [`pinned registries (base ${base ? base.slice(0, 12) : 'none'}):`];
  for (const r of results) {
    if (r.status === 'ok') { out.push(`  ok         ${r.id}`); continue; }
    out.push(`  ${r.status === 'stale' ? 'STALE     ' : 'UNCHECKED '} ${r.id}${r.registry ? `  (${r.registry})` : ''}`);
    if (r.reason) out.push(`      ${r.reason}`);
    for (const d of r.details ?? []) out.push(`      - ${d}`);
    out.push(`      regenerate: ${r.fix}`);
  }
  const stale = results.filter((r) => r.status === 'stale'), unchecked = results.filter((r) => r.status === 'unchecked');
  if (stale.length > 0) {
    out.push('fix sequence:');
    let n = 1;
    if (stale.some((r) => r.id === 'r9')) out.push(`  ${n++}. ${R9_FIX.replace('<main commit>', base ?? '<main commit>')}`);
    if (stale.some((r) => r.id === 'control-source-pins')) out.push(`  ${n++}. ${CONTROL_SOURCE_FIX.replace('<main commit>', base ?? '<main commit>')}`);
    if (stale.some((r) => r.id === 'components')) out.push(`  ${n++}. ${COMPONENTS_FIX.replace('<main commit>', base ?? '<main commit>')}   (commit generated outputs before testing the final candidate)`);
    for (const g of GENERATED) if (stale.some((r) => r.id === g.id)) out.push(`  ${n++}. ${g.fix.replace(CLOUD_DEPS_HINT, '')}`);
    out.push(`  ${n}. node scripts/ci/check-pinned-registries.mjs --base ${base ?? '<main commit>'}`);
  }
  if (stale.length) out.push(`${stale.length} registr${stale.length === 1 ? 'y is' : 'ies are'} stale; review the findings before committing.`);
  if (unchecked.length) out.push(`${unchecked.length} could not be checked.`);
  if (!stale.length && !unchecked.length) out.push('all pinned registries are up to date.');
  return out.join('\n');
}

export function exitCode(results, env = process.env) {
  // This check closes a real integration blind spot. An unavailable trusted
  // baseline or validator must fail early in CI, never become a warning-only skip.
  if (results.some((r) => r.id === 'control-source-pins' && r.status !== 'ok')) return 1;
  if (results.some((r) => r.status === 'stale')) return 1;
  if (results.some((r) => r.status === 'unchecked')) return env.GITHUB_ACTIONS === 'true' ? 0 : 2;
  return 0;
}

export async function main(argv, { env = process.env, log = console.log } = {}) {
  const o = { base: null, root: DEFAULT_ROOT, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--base') o.base = value();
    else if (a === '--root') o.root = path.resolve(value());
    else if (a === '--only') { const id = value(); if (!CHECK_IDS.includes(id)) throw new Error(`--only takes one of ${CHECK_IDS.join(', ')}`); o.only.push(id); }
    else throw new Error(`unknown argument ${a}`);
  }
  const report = await checkAll({ ...o, env });
  log(render(report));
  if (report.results.some((r) => r.status === 'unchecked') && !report.results.some((r) => r.status === 'stale') && env.GITHUB_ACTIONS === 'true') {
    log('::warning title=pinned registries::some registries could not be checked here; clued-cloud-tests still checks them');
  }
  return exitCode(report.results, env);
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
