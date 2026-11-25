// What the real-clock guard (test-clock-guard.mjs) and the scan (test-clock-scan.mjs) both read: which files are JavaScript,
// and whether a test reaches a listed file through its relative imports (Clued Task 11092b8b). Its own module, so that the
// guard, which every suite command preloads, never loads the scan: a scan evaluated during the preload is not the entry
// point when the entry runs it (--check), and would exit 0 without reading anything.
import path from 'node:path';

export const JS = /\.(?:[cm]?js|jsx|tsx?)$/;

// Whether `file` imports, directly or through other modules of the checkout (relative specifiers only), a listed file that
// has a real-clock use of its own.
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*(['"])(\.\.?\/[^'"\n]+)\1/g;
export function importsDebt(file, { read, listed, hitsOf }) {
  const seen = new Set([file]);
  const pending = [file];
  while (pending.length > 0) {
    const current = pending.pop();
    const text = read(current);
    if (text === null) continue;
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(current), match[2]));
      if (seen.has(target) || !JS.test(target)) continue;
      seen.add(target);
      if (listed.has(target) && hitsOf(target) > 0) return true;
      pending.push(target);
    }
  }
  return false;
}
