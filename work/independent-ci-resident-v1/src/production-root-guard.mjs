// The test boundary of the installed request tools (Clued Task fe8a2cbf; Fable ruling 2026-11-19, "补：测试碰生产", layer B).
// On 11-19 a drill test reached the INSTALLED rearm-tool.mjs request-intake-pause and held the live DESK's intake for two
// hours: tests run on the node, as the operator, so nothing told the two apart. A tool that writes a request a running
// resident acts on refuses (REFUSED_UNDER_TEST) when the process carries a test marker AND its target is the fixed
// production root or below it; a test pointed at a fixture root is not touched, and without a marker nothing changes.
//
// Markers: NODE_TEST_CONTEXT (node --test sets it in every test process; children inherit it) or CLUED_UNDER_TEST (the
// single test entry, scripts/ci/ci-required-selection.mjs --run, sets it for every suite, Python and PowerShell too).
// It is a cooperative marker: it stops a mistake, not code that clears its own environment.
//
// CLUED_UNDER_TEST_FIXED_ROOT only ADDS a root that counts as fixed (a test names its own temporary directory, so it can
// show the refusal without touching the real one); it never removes C:\ProgramData\CluedIndependentCI.
import fs from 'node:fs';
import path from 'node:path';
import { check } from './canonical.mjs';

export const FIXED_PRODUCTION_ROOT = 'C:\\ProgramData\\CluedIndependentCI';
export const TEST_MARKERS = Object.freeze(['NODE_TEST_CONTEXT', 'CLUED_UNDER_TEST']);
export const EXTRA_FIXED_ROOT_VARIABLE = 'CLUED_UNDER_TEST_FIXED_ROOT';
export const REFUSED_UNDER_TEST = 'REFUSED_UNDER_TEST';

export function underTest(env = process.env) {
  return TEST_MARKERS.some(name => typeof env[name] === 'string' && env[name] !== '');
}

// One spelling per path: resolved, no \\?\ prefix, no trailing separator, case-folded where the file system ignores case.
function normal(p, api) {
  let s = api.resolve(p);
  if (api === path.win32) s = s.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '').toLowerCase();
  return s.length > api.parse(s).root.length ? s.replace(/[\\/]+$/, '') : s;
}

// Pure: is target the root or below it (string form only; see sameOrBelowFixedRoot for links).
export function isSameOrBelow(target, root, api = path) {
  const t = normal(target, api), r = normal(root, api);
  return t === r || t.startsWith(r.endsWith(api.sep) ? r : r + api.sep);
}

// The path as the file system resolves it: the nearest existing ancestor through its links (a junction into the
// production root counts as the production root), the rest appended. Null when nothing of it can be resolved.
function realForm(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...rest); } catch { /* not there (yet): go up */ }
    const up = path.dirname(head);
    if (up === head) return null;
    rest.unshift(path.basename(head));
    head = up;
  }
}

export function fixedRoots(env = process.env) {
  const extra = env[EXTRA_FIXED_ROOT_VARIABLE];
  return typeof extra === 'string' && extra !== '' ? [FIXED_PRODUCTION_ROOT, extra] : [FIXED_PRODUCTION_ROOT];
}

export function sameOrBelowFixedRoot(target, env = process.env) {
  const targets = [target, realForm(target)].filter(Boolean);
  const roots = fixedRoots(env).flatMap(r => [r, realForm(r)]).filter(Boolean);
  return targets.some(t => roots.some(r => isSameOrBelow(t, r)));
}

// The one judgment every guarded entry calls before it writes anything.
export function refuseUnderTest(target, env = process.env) {
  if (!underTest(env)) return;
  check(!sameOrBelowFixedRoot(target, env), REFUSED_UNDER_TEST);
}
