// derive-n20.mjs -- extracts the twentieth forward's literals from its ARCHIVED SQL, so the
// twenty-first forward's generator never carries a hand-typed constant.
//
//   node derive-n20.mjs            print the derived N20 block
//   node derive-n20.mjs --write    also write n20.derived.json beside this file
//
// Why: twentieth-forward-compact.mjs is not a general tool. Its substitution table's from-side
// reads from a const N19 block of fifteen literals lifted from the NINETEENTH forward's SQL. The
// twenty-first needs the same fifteen taken from the TWENTIETH's. Typing them is precisely the
// action this run keeps being hurt by, so each one is extracted under a uniqueness assertion and
// the source file's digest is checked before anything is read out of it.
//
// Every pattern below is anchored on syntax that gives the literal its meaning, not on "a 64-hex
// string somewhere nearby" -- R21-F5's lesson that counting or proximity is the wrong instrument.
//
// STATUS: INCOMPLETE AND REFUSING, DELIBERATELY. First run resolves 8 of 13 fields and refuses on
// five, because the twentieth forward's SQL does not carry them in the nineteenth's shapes. What
// was measured about each, rather than guessed:
//
//   guard_exception   N19's was 'accepted_root5_window9_capacity_repair_required'. The twentieth
//                     carries 'accepted_root6_linux_capacity_160' -- no _required suffix, so the
//                     old anchor cannot match. Which of the two 'accepted_*' strings is the guard
//                     this rule rewrites has to be read from the rule's use site, not pattern-guessed.
//   rows_sha256       not present as a named literal at all: the twentieth computes it into
//   catalog_sha256    catalog_now / catalog_before locals. The N19 fields named these because the
//   getter_definition nineteenth embedded them; the twentieth's equivalents must be located by role.
//   key               present, but double-quoted by the dollar-quoting nesting:
//                     ''root6-linux-controller-forward-68133f2d617718c8''. It is also NOT the
//                     date-suffixed shape N19 used ('root5-window9-corrected-binding-20260911'),
//                     so the date pattern was wrong about the naming convention, not just the quoting.
//
// The file carries 57 occurrences of 64-hex over 20 distinct values, which is exactly why the
// remaining five must be anchored by role and asserted unique -- picking by proximity would land
// on a plausible wrong one, and nothing downstream would notice until the forward was rejected.
//
// Do not "fix" this by loosening the patterns. Finish it by reading each field's use site in the
// twentieth forward's SQL and anchoring on that.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/step14-execution/forward20.real.sql');
const EXPECTED_SRC_SHA = 'a66b104e7543d478cc23e807e4c8d38b7411bb5d11e305806bf5753a70658bb5';
const WRITE = process.argv.includes('--write');

if (!fs.existsSync(SRC)) throw new Error('MISSING_ARCHIVE: ' + path.relative(REPO, SRC));
const bytes = fs.readFileSync(SRC);
const srcSha = crypto.createHash('sha256').update(bytes).digest('hex');
if (srcSha !== EXPECTED_SRC_SHA) {
  throw new Error('ARCHIVE_DIGEST_MISMATCH: forward20.real.sql is ' + srcSha.slice(0, 12) +
    ', the step14 record says ' + EXPECTED_SRC_SHA.slice(0, 12) + '. Do not derive from an unverified template.');
}
const sql = bytes.toString('utf8');

// [name, regexp, capture group]. Each must match EXACTLY once; more than one means the anchor is
// too loose to identify the value, which is a failure, not something to pick the first of.
const FIELDS = [
  ['tag', /(\$nf\d+\$)/g, 1],
  ['reserve_execution_budget', /reserve_execution_budget[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['reserve_gate', /reserve_gate[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['append_status_manifest', /append_status_manifest[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['guard_exception', /'(accepted_[a-z0-9_]+_required)'/g, 1],
  ['window', /'(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ)'/g, 1],
  ['rows_sha256', /rows_sha256[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['catalog_sha256', /catalog_sha256[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['getter_definition_sha256', /getter_definition_sha256[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['v_norm_sha256', /v_norm[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['v_new_sha256', /v_new[^\n]*?'([a-f0-9]{64})'/g, 1],
  ['key', /'([a-z0-9-]+-20\d{6})'/g, 1],
  ['event_exception', /'(exact_real_[a-z]+_forward_event_required)'/g, 1],
];

const out = {};
const problems = [];
for (const [name, re, g] of FIELDS) {
  const hits = [...new Set([...sql.matchAll(re)].map(m => m[g]))];
  if (hits.length !== 1) { problems.push(name + ': matched ' + hits.length + ' distinct value(s)' + (hits.length ? ' -> ' + hits.map(h => String(h).slice(0, 16)).join(', ') : '')); continue; }
  out[name] = hits[0];
}

// The whitelist guard is the pair this generator rewrites, so it is read as a pair and the
// relationship between the two is asserted rather than assumed: the post-image must be the
// pre-image plus exactly one more ordinal.
const guards = [...new Set([...sql.matchAll(/if n not in \(([\d,]+)\)/g)].map(m => m[1]))];
if (guards.length !== 2) problems.push('guard pair: expected 2 distinct whitelists, found ' + guards.length);
else {
  const [a, b] = guards.map(s => s.split(',').map(Number));
  const pre = a.length < b.length ? a : b, post = a.length < b.length ? b : a;
  const expectPre = Array.from({length: pre.length}, (_, i) => i + 1);
  const expectPost = Array.from({length: pre.length + 1}, (_, i) => i + 1);
  if (String(pre) !== String(expectPre)) problems.push('guard pre-image is not 1..' + pre.length);
  if (String(post) !== String(expectPost)) problems.push('guard post-image is not 1..' + (pre.length + 1));
  out.existing_forwards = pre.length;
  out.guard_pre = 'if n not in (' + pre.join(',') + ')';
  out.guard_post = 'if n not in (' + post.join(',') + ')';
}

// Sequences: the CAS update names both, so they are read from that one statement rather than from
// two independent searches that could land on different statements.
const cas = [...sql.matchAll(/set sequence=(\d+) where root_id='[^']+' and sequence=(\d+)/g)];
if (cas.length !== 1) problems.push('cas update: matched ' + cas.length + ' times, expected 1');
else { out.next_seq = Number(cas[0][1]); out.prev_seq = Number(cas[0][2]); }

if (problems.length) {
  for (const p of problems) console.error('  UNRESOLVED  ' + p);
  console.error('REFUSED: ' + problems.length + ' field(s) could not be identified uniquely.');
  console.error('Loosen nothing. A pattern that matches several values does not know which one it means.');
  process.exit(1);
}

const missing = FIELDS.map(f => f[0]).filter(n => !(n in out));
if (missing.length) throw new Error('MISSING_FIELDS: ' + missing.join(', '));

// Cross-check the pieces against each other, so a plausible-but-wrong extraction still fails.
if (out.next_seq !== out.prev_seq + 1) throw new Error('SEQUENCE_NOT_CONSECUTIVE: ' + out.prev_seq + ' -> ' + out.next_seq);
if (out.existing_forwards !== 20) throw new Error('TEMPLATE_IS_NOT_THE_TWENTIETH_FORWARD: its post-image whitelist ends at ' + out.existing_forwards);
if (!out.event_exception.includes('twentieth')) throw new Error('EVENT_EXCEPTION_IS_NOT_THE_TWENTIETH: ' + out.event_exception);

console.log(JSON.stringify({
  object_type: 'N20DerivedConstants',
  state: 'DERIVED_FROM_ARCHIVE_NOT_TYPED',
  source: path.relative(REPO, SRC),
  source_sha256: srcSha,
  source_bytes: bytes.length,
  next_forward: out.existing_forwards + 1,
  fields: out,
}, null, 2));

if (WRITE) {
  const dest = path.join(HERE, 'n20.derived.json');
  fs.writeFileSync(dest, JSON.stringify({source: path.relative(REPO, SRC), source_sha256: srcSha, fields: out}, null, 2) + '\n');
  console.log('\nwrote ' + path.relative(REPO, dest));
}
