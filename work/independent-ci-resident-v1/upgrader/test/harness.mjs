// Drives one upgrade operation over the fixtures: builds packages, installs generation 1, opens the operation and runs the
// machine to its end on a fake clock (time moves only by the waits the machine asks for). A crash is injected by throwing
// right after the k-th durable write (journal record, rename or create-new of a generation file); the run then goes on
// with a NEW Machine on the same root, as a restarted service would.
import path from 'node:path';
import fs from 'node:fs/promises';
import { Machine } from '../src/machine.mjs';
import { Journal } from '../src/journal.mjs';
import { Generations, fsOps } from '../src/generations.mjs';
import { FakeDoor, FakeLinux, FakeResident, FakeWindows, T0, buildTestPackage, fakeClock, installGeneration1, tempDir, testConfig, upgradeRequestBytes } from './fixtures.mjs';

export class Crash extends Error { constructor() { super('INJECTED_CRASH'); this.injected = true; } }

export function crashPlan(at = 0) {
  return { at, n: 0, hit: false, log: [], tick(label = '') { this.n += 1; this.log.push(label); if (this.at > 0 && this.n === this.at) { this.hit = true; throw new Crash(); } } };
}

// The packages, built once per test file when shared (they are only read).
export async function makePackages(t, { packages = ['n2'], packageOptions = {}, base = 'n1' } = {}) {
  const pkgRoot = await tempDir(t, 'clued-upg-pkg-');
  const pkgs = { [base]: await buildTestPackage(path.join(pkgRoot, base), { tag: base }) };
  for (const tag of packages) pkgs[tag] = await buildTestPackage(path.join(pkgRoot, tag), { tag, ...(packageOptions[tag] ?? {}) });
  return pkgs;
}

export async function makeEnv(t, { packages = ['n2'], residentOptions = {}, windowsOptions = {}, linuxOptions = {}, doorOptions = {}, configOver = {}, packageOptions = {}, base = 'n1', shared = null } = {}) {
  const root = await tempDir(t, 'clued-upg-root-');
  const clock = fakeClock(T0);
  const pkgs = shared ?? await makePackages(t, { packages, packageOptions, base });
  await installGeneration1(root, pkgs[base]);
  const resident = new FakeResident(clock, residentOptions);
  const env = {
    root, clock, pkgs, resident,
    windows: new FakeWindows(root, resident, windowsOptions),
    linux: new FakeLinux(root, clock, linuxOptions),
    door: new FakeDoor(clock, doorOptions),
    config: testConfig(root, configOver),
  };
  env.ports = { door: env.door, resident: env.resident, windows: env.windows, linux: env.linux };
  return env;
}

export async function openOp(env, tag, { opId, ...req } = {}) {
  const id = opId ?? '5e1f0000-0000-4000-8000-' + String(Object.keys(env.pkgs).indexOf(tag)).padStart(12, '0');
  await Journal.create(path.join(env.root, 'upgrade', 'ops'), id, upgradeRequestBytes(env.pkgs[tag], { requestId: id, at: env.clock.now, ...req }), { clock: env.clock.fn });
  return id;
}

export function machineFor(env, opId, crash = crashPlan(0)) {
  const ops = {
    rename: async (a, b) => { await fsOps.rename(a, b); crash.tick('rename'); },
    writeNew: async (f, b) => { const r = await fsOps.writeNew(f, b); crash.tick('writeNew'); return r; },
  };
  const m = new Machine({ root: env.root, opId, config: env.config, clock: env.clock.fn, pid: 4242, ports: env.ports, generations: new Generations(env.root, { ops }) });
  for (const name of ['intent', 'result', 'terminal', 'writePlan']) {
    const real = m.journal[name].bind(m.journal);
    m.journal[name] = async (...a) => { const r = await real(...a); crash.tick(`${name}:${r?.seq ?? ''}`); return r; };
  }
  return m;
}

// Runs to the terminal record. Returns { terminal, crashes, steps }.
export async function runOp(env, opId, { crash = crashPlan(0), maxMoves = 5000, onMove = null, onCrash = null } = {}) {
  let m = machineFor(env, opId, crash);
  let crashes = 0;
  for (let i = 0; i < maxMoves; i += 1) {
    let r;
    try { r = await m.step(); } catch (error) {
      if (!error?.injected) throw error;
      crashes += 1;
      if (onCrash) await onCrash();
      m = machineFor(env, opId, crash); // the service starts again
      continue;
    }
    if (onMove) await onMove(m, r);
    if (r.done) return { terminal: r.terminal, crashes, machine: m };
    if (r.wait > 0) env.clock.advance(r.wait);
  }
  throw new Error('machine did not end');
}

export async function loadJournal(env, opId) { return Journal.open(path.join(env.root, 'upgrade', 'ops'), opId).load(); }
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
