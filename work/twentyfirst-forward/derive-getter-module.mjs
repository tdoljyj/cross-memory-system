// Derives the TWENTY-FIRST forward's getter module from the TWENTIETH's, by exactly one substitution.
//
// Every forward in this run raised the builder's own upper bound by one: window8 asserts
// existing_forwards<18, window9 <19, window11 <20. The twenty-first needs <21. That is the
// established convention (work/twentieth-forward/derive-getter-module.mjs did the same step from
// the root5-window9 module), not an exception being made here.
//
// work/twentieth-forward/ is owned by another writer in this window and is READ ONLY here, so the
// derived module lands beside this script instead of being edited in place.
//
// The module is 5,295 bytes of load-bearing assertions. Retyping it is how a byte-exact generator
// silently stops being byte-exact, so this script copies it and proves the copy differs in exactly
// one place -- the single units digit of the bound literal.
//
//   node derive-getter-module.mjs            check only, print what it would write
//   node derive-getter-module.mjs --write    write exact-getter-f12-window12.candidate.mjs
//
// build-twentyfirst.mjs repeats this derivation in memory at startup and refuses to run unless the
// file on disk is byte-identical to the result, so a hand-edited module cannot be used by accident.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const SOURCE_REL = 'work/twentieth-forward/exact-getter-root6-window11.candidate.mjs';
export const SOURCE_SHA256 = '72ec96107910289d396cb90583e5d8f9c89ed6809737fa2861977d1d1d09de7b';
export const OUTPUT_REL = 'work/twentyfirst-forward/exact-getter-f12-window12.candidate.mjs';
const OLD = 'existing_forwards>=4&&existing_forwards<20';
const NEW = 'existing_forwards>=4&&existing_forwards<21';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

// Exported so the generator performs the identical derivation rather than trusting a file.
export function deriveGetterModule() {
  const src = path.join(REPO, SOURCE_REL);
  const before = fs.readFileSync(src, 'utf8');
  assert.equal(sha(before), SOURCE_SHA256, 'SOURCE_GETTER_MODULE_DRIFTED:' + SOURCE_REL);
  assert.equal(before.split(OLD).length, 2, 'UPPER_BOUND_NOT_UNIQUE_IN_SOURCE');
  const after = before.replace(OLD, NEW);
  // Prove exactly one substitution, and that nothing else moved.
  assert.equal(after.length, before.length, 'LENGTH_CHANGED');
  const diffs = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diffs.push(i);
  // "19"->"20" moved two adjacent characters; "20"->"21" moves only the units digit. Asserting two
  // (the shape inherited from the twentieth's deriver) failed here, which is the assertion working.
  const at = before.indexOf(OLD) + OLD.length - 2;
  assert.deepEqual(diffs, [at + 1], 'CHANGE_IS_NOT_THE_BOUND_UNITS_DIGIT');
  assert.equal(before.slice(at, at + 2), '20');
  assert.equal(after.slice(at, at + 2), '21');
  assert.equal(after.split(NEW).length, 2);
  assert.equal(after.split(OLD).length, 1, 'OLD_BOUND_STILL_PRESENT');
  assert.equal(before.slice(0, at), after.slice(0, at));
  assert.equal(before.slice(at + 2), after.slice(at + 2));
  return {before, after, diffs, at};
}

// The entry point on any platform, also behind a link (scripts/ci/main-entry-realpath.test.mjs). The earlier test glued
// a file: prefix to argv[1], which a Windows path never equals: there the program did nothing and exited 0.
const isEntryPoint = () => { try { return fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isEntryPoint()) {
  const {before, after, diffs} = deriveGetterModule();
  const out = path.join(REPO, OUTPUT_REL);
  if (process.argv.includes('--write')) fs.writeFileSync(out, after);
  console.log(JSON.stringify({
    state: process.argv.includes('--write') ? 'GETTER_MODULE_DERIVED' : 'GETTER_MODULE_DERIVATION_CHECKED_NOT_WRITTEN',
    source: SOURCE_REL, source_sha256: sha(before), source_bytes: Buffer.byteLength(before),
    output: OUTPUT_REL, output_sha256: sha(after), output_bytes: Buffer.byteLength(after),
    changed_character_offsets: diffs, change: {from: OLD, to: NEW},
    precedent: {window8: '<18', window9: '<19', window11: '<20', 'f12-window12': '<21'},
  }, null, 2));
}
