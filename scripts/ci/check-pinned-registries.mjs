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
//   reconcile  scripts/ci/clued-merge-reconcile-source.json   clued-merge-reconcile-source-build.mjs (needs yaml)
//   components config/clued-components.json                   scripts/clued_components.py (bump, update)
// Nothing here needs the yaml package; only the reconcile regeneration does. The registries pin each other:
// a component bump edits a scripts/ci file (reconcile) and the reconcile registry is itself a component file, so after
// regenerating one, run this again until it prints no stale registry.
//
// --base is the main commit the change is measured against (r9 rotates its history
// from it, components compares versions with it). Default: CI_BASE_SHA, then
// CLUED_R9_BASE, then the newest main ref HEAD contains.
//
// Exit 0: every registry is up to date. Exit 1: at least one is stale (all are
// listed, regenerate them in the order printed: r9 first, because the reconcile
// registry pins the r9 registry file). Exit 2: a registry could not be checked
// (reported, never silent); under GitHub Actions that is a warning and exit 0,
// because clued-cloud-tests remains the authoritative check there.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export const R9_FIX = 'node scripts/ci/merge-admission-r9-reregister.mjs --write --base <main commit>';
export const RECONCILE_FIX = 'node scripts/ci/clued-merge-reconcile-source-build.mjs';
export const COMPONENTS_FIX = `${PYTHON} scripts/clued_components.py bump <component id> <new version>   (then: ${PYTHON} scripts/clued_components.py update; if it says components.ts is stale: node apps/clued-cloud/scripts/generate-agent-contract.mjs)`;

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

// The registry's own verifier answers "valid or not"; the file lists say which files moved.
async function checkReconcile(root) {
  const mod = await import(pathToFileURL(path.join(root, 'scripts/ci/clued-merge-reconcile-source.mjs')).href);
  let yaml = false;
  try { createRequire(path.join(root, 'apps/clued-cloud/package.json'))('yaml'); yaml = true; } catch { /* only the regeneration needs it */ }
  const fix = RECONCILE_FIX + (yaml ? '' : '   (needs the yaml package: first run  cd apps/clued-cloud && npm ci)');
  const details = [];
  let registered;
  try { registered = JSON.parse(fs.readFileSync(path.join(root, mod.SOURCE_FILE), 'utf8')).files ?? {}; } catch (error) {
    return { id: 'reconcile', status: 'stale', registry: mod.SOURCE_FILE, details: [`registry unreadable: ${error.message}`], fix };
  }
  let closure;
  try { closure = mod.sourceClosure(root); } catch (error) { return { id: 'reconcile', status: 'unchecked', reason: `source closure: ${error.message}`, fix }; }
  for (const name of closure) {
    if (!Object.hasOwn(registered, name)) { details.push(`not registered (new file): ${name}`); continue; }
    let actual = null;
    try { actual = mod.hash(fs.readFileSync(path.join(root, name))); } catch { /* reported as changed */ }
    if (actual !== registered[name]) details.push(`bytes differ from the registry: ${name}`);
  }
  for (const name of Object.keys(registered)) if (!closure.includes(name)) details.push(`registered but gone: ${name}`);
  if (details.length === 0) {
    try { mod.verifyReconcileSource(root); } catch (error) {
      return { id: 'reconcile', status: 'stale', registry: mod.SOURCE_FILE, details: [`verifyReconcileSource refuses the registry (${error.message}) though every file hash matches; review by hand`], fix };
    }
    return { id: 'reconcile', status: 'ok' };
  }
  return { id: 'reconcile', status: 'stale', registry: mod.SOURCE_FILE, details, fix };
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

export const CHECK_IDS = ['r9', 'reconcile', 'components'];

export async function checkAll({ root = DEFAULT_ROOT, base = null, only = [], env = process.env, knownMainRefs } = {}) {
  let refs = knownMainRefs;
  if (!refs) refs = (await import(pathToFileURL(path.join(root, 'scripts/ci/merge-admission-r9-reregister.mjs')).href)).knownMainRefs;
  const resolved = resolveBase(root, base, env, refs);
  const want = (id) => only.length === 0 || only.includes(id);
  const results = [];
  if (want('r9')) results.push(await checkR9(root, resolved));
  if (want('reconcile')) results.push(await checkReconcile(root));
  if (want('components')) results.push(checkComponents(root, resolved));
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
  if (stale.some((r) => r.id !== 'r9')) {
    // The registries pin each other (see the header), so the order matters and the run must be repeated.
    out.push('fix sequence (repeat the check until nothing changes):');
    let n = 1;
    if (stale.some((r) => r.id === 'r9')) out.push(`  ${n++}. ${R9_FIX.replace('<main commit>', base ?? '<main commit>')}`);
    if (stale.some((r) => r.id === 'components' && r.details?.some((d) => /\bbump\b/.test(d)))) out.push(`  ${n++}. ${PYTHON} scripts/clued_components.py bump <component id> <new version>   (the id and a higher version are in the message above)`);
    out.push(`  ${n++}. ${RECONCILE_FIX}`, `  ${n++}. ${PYTHON} scripts/clued_components.py update`,
      `  ${n++}. node apps/clued-cloud/scripts/generate-agent-contract.mjs`,
      `  ${n++}. node scripts/ci/check-pinned-registries.mjs --base ${base ?? '<main commit>'}   (a component bump edits a locked file, so steps 2-3 may need a second pass)`);
  }
  if (stale.length) out.push(`${stale.length} registr${stale.length === 1 ? 'y is' : 'ies are'} stale; regenerate in the order listed (r9 before reconcile), then review the diff and commit.`);
  if (unchecked.length) out.push(`${unchecked.length} could not be checked.`);
  if (!stale.length && !unchecked.length) out.push('all pinned registries are up to date.');
  return out.join('\n');
}

export function exitCode(results, env = process.env) {
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
