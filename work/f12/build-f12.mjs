// build-f12.mjs -- window12 controller edit, root6 -> root7 (F12 pre-image).
//
// Applies the complete pin-edit set from F12PinInventory.md to the five controller files
// that carry window-bound bytes. Values not decidable before M3 become NON-HEX sentinels:
//   __F12_PENDING_WINDOW_START__   root-window-validation.mjs lower bound (M3 committed_at)
//   __F12_PENDING_WINDOW_END__     root7Expiry + root-window-validation.mjs upper bound (T+86400s)
//   __F12_PENDING_ISSUER_STATUS_SHA256__ / __F12_PENDING_ISSUER_GATE_SHA256__
//     new issuer qualification doc digests (docs carry realized windows, so digests are M3-late)
// Sentinels are deliberately not 64-hex: check-digest-pins' per-file literal counts then REFUSE
// (context.mjs 20/22, check-digest-pins.mjs 6/8) until realize-f12.mjs substitutes real values.
// A forgotten realization is mechanically loud, not a process promise. (R29 lesson.)
//
// R18/R19 lessons built in: every rule asserts its exact occurrence count at apply time; a rule
// whose `from` equals another rule's `from` (the duplicate-rule defect) is refused up front;
// residual scans assert the old ctrgen / expiry / issuer digests are gone from the whole
// controller directory when the rule tables say they should be.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor');

const OLD_GEN = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b';
const NEW_GEN = 'ctrgen_26769cc7109ced40bc4016b2af678198'; // minted 2026-09-13, burned only at registration
const OLD_END = '2026-09-13T07:05:16Z';
const OLD_START = '2026-09-10T13:18:47Z';
const OLD_ISSUER_STATUS = '1640995831b0c1f8ae616810e12eb7b97ee191e9f20b5c38eee32eb8bfac9d23';
const OLD_ISSUER_GATE = '80cf8f471248ae76e5a637b5f94f20f4863a243c7011e5728de86cb5fc7cf5d2';
const S_END = '__F12_PENDING_WINDOW_END__';
const S_START = '__F12_PENDING_WINDOW_START__';
const S_ISSUER_STATUS = '__F12_PENDING_ISSUER_STATUS_SHA256__';
const S_ISSUER_GATE = '__F12_PENDING_ISSUER_GATE_SHA256__';

const L191_OLD = "const root4Generation='ctrgen_9cf53fa5cd0a4a38bd68613493f95b06',root5Generation='ctrgen_e5df432221344996afc04b5638121d96',root6Generation='ctrgen_5e0440a95ac8ee257b9e4236cabd275b',root4Expiry='2026-09-11T10:21:05Z',root6Expiry='2026-09-13T07:05:16Z',root5BudgetSequence=64,root6BudgetSequence=89;";
const L191_NEW = "const root4Generation='ctrgen_9cf53fa5cd0a4a38bd68613493f95b06',root5Generation='ctrgen_e5df432221344996afc04b5638121d96',root7Generation='" + NEW_GEN + "',root4Expiry='2026-09-11T10:21:05Z',root7Expiry='" + S_END + "',root5BudgetSequence=64,root7BudgetSequence=90;";
// root7BudgetSequence=90: measured 2026-09-13 against the live store -- every BUDGET_RESERVED
// sequence is <= 85 and max(sequence)=89, so the 9th allocation is necessarily >= 90 and no
// historical budget can cross the threshold. root6 had no budgets at all (root6BudgetSequence=89
// was a dead branch); root6Generation/root6Expiry therefore disappear rather than remain as
// unused constants.
const L194_OLD = 'const generationForBudget=sequence=>sequence>=root6BudgetSequence?root6Generation:sequence>=root5BudgetSequence?root5Generation:sequence>=59?root4Generation:scope.root_generation;';
const L194_NEW = 'const generationForBudget=sequence=>sequence>=root7BudgetSequence?root7Generation:sequence>=root5BudgetSequence?root5Generation:sequence>=59?root4Generation:scope.root_generation;';
const L195_OLD = 'const expiryForBudget=sequence=>sequence>=root6BudgetSequence?root6Expiry:sequence>=59?root4Expiry:scope.expires_at;';
const L195_NEW = 'const expiryForBudget=sequence=>sequence>=root7BudgetSequence?root7Expiry:sequence>=59?root4Expiry:scope.expires_at;';

// [file, [rule name, from, to, expected occurrences]...]; rules apply strictly in order.
const PLAN = [
  ['context.mjs', [
    ["generation export", "generation='" + OLD_GEN + "'", "generation='" + NEW_GEN + "'", 1],
    ['forward cap', 'forwards:16', 'forwards:17', 1],
    ['line191 constants', L191_OLD, L191_NEW, 1],
    ['line194 generationForBudget', L194_OLD, L194_NEW, 1],
    ['line195 expiryForBudget', L195_OLD, L195_NEW, 1],
    ['remaining root6Expiry uses (:43,:207,:226)', 'root6Expiry', 'root7Expiry', 3],
    ['remaining root6Generation use (:208)', 'root6Generation', 'root7Generation', 1],
    ['issuer STATUS digest (:317)', OLD_ISSUER_STATUS, S_ISSUER_STATUS, 1],
    ['issuer GATE digest (:317)', OLD_ISSUER_GATE, S_ISSUER_GATE, 1],
  ]],
  ['status-manifest.root5.schema.json', [
    ['schema ctrgen consts', OLD_GEN, NEW_GEN, 2],
  ]],
  ['gate-result-receipt.root5.schema.json', [
    ['schema ctrgen const', OLD_GEN, NEW_GEN, 1],
  ]],
  ['check-digest-pins.mjs', [
    ['DECLARED_NON_FILE issuer STATUS', OLD_ISSUER_STATUS, S_ISSUER_STATUS, 1],
    ['DECLARED_NON_FILE issuer GATE', OLD_ISSUER_GATE, S_ISSUER_GATE, 1],
  ]],
  ['root-window-validation.mjs', [
    ['window lower bound', OLD_START, S_START, 1],
    ['window upper bound', OLD_END, S_END, 1],
  ]],
];

// Duplicate-rule detection (R18-F3's actual defect): no two rules anywhere may share a `from`.
{
  const seen = new Map();
  for (const [file, rules] of PLAN) for (const [name, from] of rules) {
    const key = from;
    if (seen.has(key)) throw new Error('DUPLICATE_RULE: "' + name + '" in ' + file + ' repeats the from-string of "' + seen.get(key) + '"');
    seen.set(key, name + ' @ ' + file);
  }
}

const count = (hay, needle) => hay.split(needle).length - 1;
let applied = 0;
for (const [file, rules] of PLAN) {
  const p = path.join(DIR, file);
  let text = fs.readFileSync(p, 'utf8');
  for (const [name, from, to, expected] of rules) {
    const n = count(text, from);
    if (n !== expected) throw new Error('OCCURRENCE_COUNT:' + file + ':' + name + ': expected ' + expected + ', found ' + n);
    text = text.split(from).join(to);
    applied++;
  }
  fs.writeFileSync(p, text);
  console.log('edited ' + file + ' (' + rules.length + ' rule(s))');
}

// Residual scans over the whole controller directory: the old window's bytes must be GONE.
const residualBudget = {}; // token -> allowed residual occurrences across the dir
for (const tok of [OLD_GEN, OLD_END, OLD_ISSUER_STATUS, OLD_ISSUER_GATE, OLD_START, 'root6Expiry', 'root6Generation', 'root6BudgetSequence']) residualBudget[tok] = 0;
const problems = [];
for (const f of fs.readdirSync(DIR)) {
  const p = path.join(DIR, f);
  if (!fs.statSync(p).isFile()) continue;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
  for (const tok of Object.keys(residualBudget)) {
    const n = count(text, tok);
    if (n > 0) problems.push(f + ': ' + n + ' residual occurrence(s) of ' + tok.slice(0, 40));
  }
}
if (problems.length) { for (const q of problems) console.error('  RESIDUAL  ' + q); throw new Error('RESIDUAL_OLD_WINDOW_BYTES'); }

// Sentinel census: exactly these, exactly here, so realize-f12.mjs can assert the same table.
const SENTINELS = [
  ['context.mjs', S_END, 1], ['context.mjs', S_ISSUER_STATUS, 1], ['context.mjs', S_ISSUER_GATE, 1],
  ['check-digest-pins.mjs', S_ISSUER_STATUS, 1], ['check-digest-pins.mjs', S_ISSUER_GATE, 1],
  ['root-window-validation.mjs', S_START, 1], ['root-window-validation.mjs', S_END, 1],
];
for (const [file, s, expected] of SENTINELS) {
  const n = count(fs.readFileSync(path.join(DIR, file), 'utf8'), s);
  if (n !== expected) throw new Error('SENTINEL_CENSUS:' + file + ':' + s + ': expected ' + expected + ', found ' + n);
}
console.log(applied + ' rule(s) applied; residuals zero; sentinel census exact (7 sites, 4 distinct values).');
console.log('PRE-REALIZE STATE: check-digest-pins must now refuse with exactly two per-file');
console.log('literal shortfalls (context.mjs 20/22, check-digest-pins.mjs 6/8) -- that refusal is');
console.log('the designed proof that this tree cannot pass a freeze before realization.');
