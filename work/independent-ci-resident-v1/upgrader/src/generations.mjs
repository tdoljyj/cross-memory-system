// Windows generations (spec A6): the live files of generation N stay where the services read them; an upgrade moves them
// into generations\g<N>\ and the staged files of N+1 into their place, a rollback the other way round. Only two primitives
// are used: a rename that never replaces anything, and a create-new write. Nothing is deleted: generations beyond the
// newest `keep` are renamed into archive\.
//
// Every operation is idempotent per item, so a resumed step simply runs again: each item is in exactly one of three states
// (old in place / moved into generations / new in place) because each move is one atomic rename.
//   live:      <root>\<slot>                                    (config\policy.json, bin\SwapBroker.exe, ...)
//   kept:      <root>\generations\g<N>\<slot>
//   staged:    <root>\upgrade\staged\<pkgSha>\<package path>      package files, as the package lays them out
//              <root>\upgrade\staged\<pkgSha>\compiled\<slot>     what upgrade-apply.ps1 Compile wrote
//   current:   <root>\upgrade\current.json, kept as generations\g<N>\current.json when N is replaced
//   record:    <root>\generations\g<N>\generation.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { check, sha256 } from '../../src/canonical.mjs';
import { exists } from '../../src/store.mjs';
import { writeBytesNew } from './journal.mjs';
import { U } from './codes.mjs';

export const GENERATION_RECORD_CONTRACT = 'clued.independent-ci.resident-generation-record/1';
const G = /^g([1-9][0-9]{0,8})$/;

// The default primitives; tests wrap them to cut a step short between two renames.
export const fsOps = Object.freeze({
  async rename(from, to) {
    check(!(await exists(to)), 'GENERATION_TARGET_EXISTS', path.basename(to));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  },
  writeNew: (file, bytes) => fs.mkdir(path.dirname(file), { recursive: true }).then(() => writeBytesNew(file, bytes)),
});

export async function fileSha(file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return st.isDirectory() ? 'directory' : 'other';
    return sha256(await fs.readFile(file));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const slotPath = (base, slot) => path.join(base, ...slot.split('\\'));

export class Generations {
  constructor(root, { ops = fsOps } = {}) {
    this.root = root;
    this.ops = ops;
    this.genRoot = path.join(root, 'generations');
    this.archiveRoot = path.join(root, 'archive');
    this.upgradeRoot = path.join(root, 'upgrade');
    this.currentFile = path.join(this.upgradeRoot, 'current.json');
  }

  gen(n) { return path.join(this.genRoot, `g${n}`); }
  live(slot) { return slotPath(this.root, slot); }
  kept(n, slot) { return slotPath(this.gen(n), slot); }
  staged(pkgSha) { return path.join(this.upgradeRoot, 'staged', pkgSha); }
  stagedSource(plan, s) { return s.kind === 'package' ? path.join(this.staged(plan.packageManifestSha256), ...s.from.split('/')) : slotPath(path.join(this.staged(plan.packageManifestSha256), 'compiled'), s.target); }
  keptCurrent(n) { return path.join(this.gen(n), 'current.json'); }
  recordFile(n) { return path.join(this.gen(n), 'generation.json'); }

  // The live inventory for the plan: the sha of each slot (null: missing) and the content-addressed directories present.
  async inventory(slots) {
    const live = {};
    for (const slot of slots) { const s = await fileSha(this.live(slot)); live[slot] = typeof s === 'string' && s.length === 64 ? s : null; }
    const list = async d => { try { return (await fs.readdir(path.join(this.root, d))).filter(n => /^[0-9a-f]{64}$/.test(n)).sort(); } catch { return []; } };
    return { live, dirs: { resident: await list('resident'), source: await list('source') } };
  }

  // ---- forward: N -> N+1 ----

  // One slot: the live file of N moves to g<N> unless it is already there or the new one is already in place.
  async snapshotItem(n, s) {
    const kept = await fileSha(this.kept(n, s.target));
    // Already kept: the live file (if any) is the new one, which may have the very same bytes as the old.
    if (kept === s.oldSha256) return;
    check(kept === null, U.JOURNAL_INCONSISTENT, `snapshot:${s.target}`);
    const live = await fileSha(this.live(s.target));
    if (live === s.oldSha256) await this.ops.rename(this.live(s.target), this.kept(n, s.target));
  }

  // A new file under its final name, whole: the bytes go to a fixed temporary name next to it (create-new), then one rename
  // that replaces nothing. A complete temporary file left by an interrupted run is the same write and is used; an
  // incomplete one is moved aside into upgrade\partial\ (never deleted).
  async putNew(file, bytes) {
    const tmp = path.join(path.dirname(file), `.upgrade-next-${path.basename(file)}`);
    const have = await fileSha(tmp);
    if (have !== null && have !== sha256(bytes)) {
      let aside = path.join(this.upgradeRoot, 'partial', path.basename(file));
      for (let i = 1; await exists(aside); i += 1) aside = path.join(this.upgradeRoot, 'partial', `${path.basename(file)}-${i}`);
      await this.ops.rename(tmp, aside);
    }
    if (have !== sha256(bytes)) await this.ops.writeNew(tmp, bytes);
    await this.ops.rename(tmp, file);
  }

  // One slot: a copy of the staged file of N+1 is put into the empty live place (the staged package stays whole: the Linux
  // tool reads it, and one package file can feed two targets). The caller gives the expected sha (newSha).
  async placeItem(plan, s, newSha) {
    const live = await fileSha(this.live(s.target));
    if (live === newSha) return;
    check(live === null, U.JOURNAL_INCONSISTENT, `place:${s.target}`);
    const bytes = await fs.readFile(this.stagedSource(plan, s)).catch(() => null);
    check(bytes !== null && sha256(bytes) === newSha, U.JOURNAL_INCONSISTENT, `staged:${s.target}`);
    await this.putNew(this.live(s.target), bytes);
  }

  async snapshot(n, plan, slots = plan.slots) { for (const s of slots) await this.snapshotItem(n, s); }

  // The content-addressed directories: moved in whole when absent; never moved out (generations share them).
  async placeDirs(plan) {
    for (const d of plan.dirs) {
      const target = path.join(this.root, d.kind, d.sha256);
      if (await exists(target)) continue;
      check(!d.present, U.JOURNAL_INCONSISTENT, `dir:${d.kind}`);
      await this.ops.rename(path.join(this.staged(plan.packageManifestSha256), d.kind), target);
    }
  }

  // Files first, then the directories (a slot may be fed from a file inside a staged directory).
  async place(n1, plan, newShaOf) {
    for (const s of plan.slots.filter(x => x.kind !== 'receipt')) await this.placeItem(plan, s, newShaOf(s));
    await this.placeDirs(plan);
  }

  // Create-new writes of one generation's own files (record, receipt, current): an existing file with the same bytes is the
  // same write; with other bytes it is refused.
  async writeOnce(file, bytes) {
    const have = await fileSha(file);
    if (have === sha256(bytes)) return;
    check(have === null, U.JOURNAL_INCONSISTENT, path.basename(file));
    await this.putNew(file, bytes);
  }

  // upgrade\current.json of N is kept in g<N>, then the one of N+1 is created.
  async switchCurrent(n, bytes) {
    const live = await fileSha(this.currentFile);
    if (live === sha256(bytes)) return;
    if (live !== null) await this.ops.rename(this.currentFile, this.keptCurrent(n));
    await this.putNew(this.currentFile, bytes);
  }

  // ---- back: N+1 -> N ----

  // One slot: whatever of N+1 is live goes to g<N+1>, then N's file comes back from g<N>.
  async restoreItem(n, n1, s) {
    let live = await fileSha(this.live(s.target));
    if (live === s.oldSha256) {
      // N's bytes are live. When N+1 brought the very same bytes, N's own copy is still kept in g<N> (snapshot moved it there
      // and place put an identical copy back): it goes with N+1's files into g<N+1> (archived by retire), so that g<N> holds
      // no leftover a later upgrade from N would take for "already kept".
      const kept = await fileSha(this.kept(n, s.target));
      if (kept === null) return;
      check(kept === s.oldSha256 && (await fileSha(this.kept(n1, s.target))) === null, U.ROLLBACK_FAILED, `restore-kept:${s.target}`);
      await this.ops.rename(this.kept(n, s.target), this.kept(n1, s.target));
      return;
    }
    if (live !== null) {
      check(await fileSha(this.kept(n1, s.target)) === null, U.ROLLBACK_FAILED, `restore:${s.target}`);
      await this.ops.rename(this.live(s.target), this.kept(n1, s.target));
      live = null;
    }
    check(await fileSha(this.kept(n, s.target)) === s.oldSha256, U.ROLLBACK_FAILED, `kept:${s.target}`);
    await this.ops.rename(this.kept(n, s.target), this.live(s.target));
  }

  async restore(n, plan) {
    for (const s of plan.slots) await this.restoreItem(n, plan.toGeneration, s);
  }

  async restoreCurrent(n, n1, currentSha) {
    const live = await fileSha(this.currentFile);
    if (live === currentSha) return;
    if (live !== null) await this.ops.rename(this.currentFile, this.keptCurrent(n1));
    check(await fileSha(this.keptCurrent(n)) === currentSha, U.ROLLBACK_FAILED, 'current');
    await this.ops.rename(this.keptCurrent(n), this.currentFile);
  }

  // A generation that was rolled back keeps its files (for the Owner to look at) but gives its number back: generations\g<n>
  // moves to archive\g<n>-rolled-back-<label>, so the next upgrade can be generation n again. Idempotent.
  async retire(n, label) {
    const from = this.gen(n);
    if (!(await exists(from))) return false;
    const to = path.join(this.archiveRoot, `g${n}-rolled-back-${label}`);
    check(!(await exists(to)), U.ROLLBACK_FAILED, 'retire');
    await this.ops.rename(from, to);
    return true;
  }

  // ---- retention ----

  async list() {
    let names = [];
    try { names = await fs.readdir(this.genRoot); } catch { return []; }
    return names.map(n => G.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
  }

  // Keeps the newest `keep` generations up to and including the current one; older ones are renamed into archive\g<k>
  // (archive\g<k>-<i> if a g<k> was archived before). Returns the archived numbers.
  async retain(keep, currentGeneration) {
    check(Number.isSafeInteger(keep) && keep >= 2, 'GENERATIONS_KEEP_INVALID');
    const archived = [];
    for (const k of await this.list()) {
      if (k > currentGeneration - keep) continue;
      let to = path.join(this.archiveRoot, `g${k}`);
      for (let i = 1; await exists(to); i += 1) to = path.join(this.archiveRoot, `g${k}-${i}`);
      await this.ops.rename(this.gen(k), to);
      archived.push(k);
    }
    return archived;
  }

  async listArchived() {
    try { return (await fs.readdir(this.archiveRoot)).filter(n => /^g[0-9]+(?:-[0-9a-z-]+)?$/.test(n)).sort(); } catch { return []; }
  }
}
