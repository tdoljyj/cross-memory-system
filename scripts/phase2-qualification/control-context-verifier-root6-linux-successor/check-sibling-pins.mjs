// Every sibling-file digest pin inside the controller directory must equal that file's current
// sha256. This exists because the same defect occurred three times in one day: a file's path or
// contents changed and the digest some OTHER file pins for it was not updated -- R14-F1, R14-F3,
// then R15-F1 and R15-F2 behind them. Every time it was found by a reviewer, not here.
//
// One pass is not enough, and that is the trap. These files pin each other in a chain
// (parent600.py <- fixed_host.py <- bridge.py), so repairing one changes its own digest and
// invalidates the pin above it. Repairing by hand the two that round 15 named would have left
// bridge.py stale a third time; the fixed point took three rounds. So this iterates.
//
//   node check-sibling-pins.mjs           report only; exits non-zero if anything is stale
//   node check-sibling-pins.mjs --write   repair to a fixed point
//
// build-linux-manifest.mjs runs the report form first and refuses to describe a controller whose
// own internal pins do not hold.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const APPLY = process.argv.includes('--write');

// Two shapes occur in this controller. Both name a sibling by BASE / '<file>' and carry its digest.
//   load(..., str(BASE / 'parent600.py'), '<digest>')
//   HOST = BASE / 'fixed_host.py'  followed by  HOST_SHA = '<digest>'
const findPins = text => {
  const out = [];
  for (const m of text.matchAll(/str\(BASE \/ '([^']+)'\)\s*,\s*\n?\s*'([a-f0-9]{64})'/g))
    out.push({target: m[1], pinned: m[2]});
  for (const m of text.matchAll(/\w+ = BASE \/ '([^']+)'\n\w+_SHA = '([a-f0-9]{64})'/g))
    out.push({target: m[1], pinned: m[2]});
  return out;
};

let round = 0, total = 0;
for (;;) {
  round++;
  let changed = 0;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    if (!fs.statSync(p).isFile() || !/\.(py|mjs|js)$/.test(f)) continue;
    let text = fs.readFileSync(p, 'utf8');
    const before = text;
    for (const pin of findPins(text)) {
      const tp = path.join(DIR, pin.target);
      if (!fs.existsSync(tp)) { console.log(`  MISSING TARGET  ${f} pins ${pin.target}`); continue; }
      const actual = sha(tp);
      if (actual !== pin.pinned) {
        console.log(`  round ${round}  ${f.padEnd(16)} pins ${pin.target.padEnd(16)} ${pin.pinned.slice(0, 12)} -> ${actual.slice(0, 12)}`);
        text = text.replace(pin.pinned, actual);
        changed++;
      }
    }
    if (text !== before && APPLY) fs.writeFileSync(p, text);
  }
  total += changed;
  if (!changed) { console.log(`sibling pins consistent (fixed point after ${round} round(s), ${total} updated)`); break; }
  if (!APPLY) { console.log(`STALE: ${changed} sibling pin(s) do not match; run with --write`); process.exit(1); }
  if (round > 10) { console.error('DID NOT CONVERGE'); process.exit(1); }
}
