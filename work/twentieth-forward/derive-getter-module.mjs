// Derives the twentieth-forward getter module from the nineteenth's, by exactly one substitution.
//
// Every forward in this run raised the builder's own upper bound by one: window8 asserts
// existing_forwards<18, window9 asserts <19. The twentieth needs <20. That is the established
// convention, not an exception being made here.
//
// The module is 5,295 bytes of load-bearing assertions. Retyping it is how a byte-exact generator
// silently stops being byte-exact, so this script copies it and proves the copy differs in exactly
// one place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO, 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/root5-window9-corrected-binding/exact-getter-root5-window9.candidate.mjs');
const OUT = path.join(REPO, 'work/twentieth-forward/exact-getter-root6-window11.candidate.mjs');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

const before = fs.readFileSync(SRC, 'utf8');
// Pin the source so this script refuses to run against a drifted predecessor.
assert.equal(sha(before), 'b2c58a272971cf73bde3a6bf8f4dfa73837092c309449de435b787718684155b', 'SOURCE_GETTER_MODULE_DRIFTED');

const OLD = 'existing_forwards>=4&&existing_forwards<19';
const NEW = 'existing_forwards>=4&&existing_forwards<20';
assert.equal(before.split(OLD).length, 2, 'UPPER_BOUND_NOT_UNIQUE_IN_SOURCE');

const after = before.replace(OLD, NEW);

// Prove exactly one substitution, and that nothing else moved.
assert.equal(after.length, before.length, 'LENGTH_CHANGED');
const diffs = [];
for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diffs.push(i);
// "19" -> "20" changes two adjacent characters, both inside the bound literal.
const at = before.indexOf(OLD) + OLD.length - 2;
assert.deepEqual(diffs, [at, at + 1], 'CHANGE_IS_NOT_THE_TWO_BOUND_DIGITS');
assert.equal(before.slice(at, at + 2), '19');
assert.equal(after.slice(at, at + 2), '20');
assert.equal(after.split(NEW).length, 2);
assert.equal(after.split(OLD).length, 1, 'OLD_BOUND_STILL_PRESENT');

// Everything outside those two characters must be identical.
assert.equal(before.slice(0, at), after.slice(0, at));
assert.equal(before.slice(at + 2), after.slice(at + 2));

fs.writeFileSync(OUT, after);
console.log(JSON.stringify({
  state: 'GETTER_MODULE_DERIVED',
  source: path.relative(REPO, SRC),
  source_sha256: sha(before),
  source_bytes: Buffer.byteLength(before),
  output: path.relative(REPO, OUT),
  output_sha256: sha(after),
  output_bytes: Buffer.byteLength(after),
  changed_character_offsets: diffs,
  change: {from: OLD, to: NEW},
  precedent: {window8: 'existing_forwards<18', window9: 'existing_forwards<19', window11: 'existing_forwards<20'},
}, null, 2));
