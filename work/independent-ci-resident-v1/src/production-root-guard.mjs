// The test boundary of the request writers (Clued Task fe8a2cbf; Fable rulings 2026-11-19 "补：测试碰生产" layer B and
// "补：测试守卫判据"). On 11-19 a drill test reached the INSTALLED rearm-tool.mjs request-intake-pause and held the live DESK's
// intake for two hours: tests run on the node, as the operator, so nothing told the two apart.
//
// The rule: under a test marker a request is written only where a test plainly may write, the temporary directory; any place
// that cannot be shown to lie inside it is refused (REFUSED_UNDER_TEST). Nothing here knows a production path or any spelling of
// one: the folder about to be written is resolved by the file system (fs.realpathSync.native: links, junctions, 8.3 names,
// device prefixes and UNC names are the system's business), and "inside" means that the resolved folder or one of its ancestors
// IS the resolved os.tmpdir(), compared by identity (volume serial number and file ID: stat dev and ino, as bigint). Every
// failure on the way (no resolution, no identity, a zero identity, not inside) refuses. There is no switch that widens it.
//
// Markers: NODE_TEST_CONTEXT (node --test sets it in every test process; children inherit it) or CLUED_UNDER_TEST (the single
// test entry, scripts/ci/ci-required-selection.mjs --run, sets it for every suite). windows/request-upgrade.ps1 names the same
// two (a test keeps the lists equal); its root is fixed, so it refuses on the marker alone. Without a marker nothing is judged
// and the file system is not touched. A cooperative marker: it stops a mistake, not code that clears its own environment; the
// moment between the judgment and the write is not covered.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './canonical.mjs';

export const TEST_MARKERS = Object.freeze(['NODE_TEST_CONTEXT', 'CLUED_UNDER_TEST']);
export const REFUSED_UNDER_TEST = 'REFUSED_UNDER_TEST';

export function underTest(env = process.env) {
  return TEST_MARKERS.some(name => typeof env[name] === 'string' && env[name] !== '');
}

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const realpathNative = p => fs.realpathSync.native(p);
const statBig = p => fs.statSync(p, { bigint: true });

// The folder as the file system resolves it: its nearest existing ancestor through realpath (only "not there" moves one level
// up: names that do not exist yet cannot be links), the rest appended. Throws when that cannot be done.
function resolved(dir, realpath) {
  let head = dir;
  const rest = [];
  for (;;) {
    try { return path.join(realpath(head), ...rest); } catch (e) { if (!MISSING.has(e?.code)) throw e; }
    const up = path.dirname(head);
    if (up === head) throw new Error('NOTHING_RESOLVES');
    rest.unshift(path.basename(head));
    head = up;
  }
}
// The identity of an existing folder; a missing or zero one throws.
function identity(p, stat) {
  const s = stat(p);
  if (typeof s?.dev !== 'bigint' || typeof s?.ino !== 'bigint' || s.ino === 0n) throw new Error('NO_IDENTITY');
  return `${s.dev}:${s.ino}`;
}

// May a request be written into dir? Without a marker: yes, nothing is looked at. With one: only when dir, as resolved, lies in
// the temporary directory by identity. realpath, stat and tmpdir can be replaced for the tests of the judgment itself.
export function writableUnderTest(dir, { env = process.env, realpath = realpathNative, stat = statBig, tmpdir = os.tmpdir } = {}) {
  if (!underTest(env)) return true;
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    const allowed = identity(realpath(tmpdir()), stat);
    let at = resolved(path.resolve(dir), realpath);
    // Up from the resolved folder to the volume's root; the parts not created yet have no identity and are skipped.
    for (;;) {
      let id = null;
      try { id = identity(at, stat); } catch (e) { if (!MISSING.has(e?.code)) throw e; }
      if (id === allowed) return true;
      const up = path.dirname(at);
      if (up === at) return false;
      at = up;
    }
  } catch {
    return false;
  }
}

// The one judgment every request writer calls on the folder it is about to write into.
export function refuseUnderTest(dir, options = {}) {
  check(writableUnderTest(dir, options), REFUSED_UNDER_TEST);
}
