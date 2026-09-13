// scan-superseded-abbreviations.mjs -- Round 33 finding R33-F1.
//
// reissue-documents-window12.mjs pass 4 ("nothing superseded may survive") compares against the
// FULL 64-hex / full-ISO strings in its substitution table. Measured on the formal output: zero
// full-length superseded values survive anywhere -- pass 4 is sound for that class and cannot
// fail for any other. Abbreviated references (the 8-hex prefix this project writes everywhere:
// "68133f2d", "5e0440a9") are invisible to it, and 26 of them survive in the nine documents,
// 21 outside the narration/lineage fields pass 4 exempts.
//
// Most are historical prose and are fine. At least two are not, and both were INTRODUCED by the
// re-issue -- the digest field moved to F12 while the sentence describing that same field did not:
//   window10_continuation_evidence.controller_digest = 73c05cad...
//   window10_continuation_evidence.correction        = "... The digest is now 68133f2d ..."
// and required_before_actual_ga[1,2,4] are forward-looking obligations for THIS window that still
// name the superseded controller.
//
// This script does not adjudicate which occurrences are history and which are stale -- that is the
// reviewer's call. It pins the inventory so the class stops being invisible: a new abbreviated
// residual, or one that disappears without the inventory being updated, refuses.
//
// It also asserts, independently of pass 4, that no FULL superseded value survives outside the
// exempt fields, and cross-checks each `... is now <abbrev>` sentence against the sibling field.
//
// Discriminator: --tamper injects one abbreviation into a non-exempt field in memory.
// READ-ONLY. No write, no Supabase, no network.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'artifacts/clued-validation/phase2-entry-preparation-20260908';
const TAMPER = process.argv.includes('--tamper');
const SHOW = process.argv.includes('--inventory');

// The window-level values the re-issue supersedes. Provenance: reissue-documents-window12.mjs
// OLD.{ctrlSha,notBefore,expiry,schemaSha} and build-f12.mjs OLD_GEN.
const SUPERSEDED = {
  controller_sha256: '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a',
  root6_generation:  'ctrgen_5e0440a95ac8ee257b9e4236cabd275b',
  window_not_before: '2026-09-12T07:05:16Z',
  window_expires_at: '2026-09-13T07:05:16Z',
  schema_sha256:     '510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef',
};
const abbrev = v => v.startsWith('ctrgen_') ? v.slice(7, 15) : /^[a-f0-9]{64}$/.test(v) ? v.slice(0, 8) : v;

// Fields whose job is to name superseded bytes. Same list pass 4 exempts, plus known_open, whose
// entries are findings ABOUT the superseded state and must keep naming it.
const EXEMPT = p => /^(supersedes|supersedes_chain|superseded_draft_replaced_here|known_open)(\.|$)/.test(p)
                 || /^reissue\.(reason|what_changed|substance_unchanged|supersedes)(\.|$)/.test(p);

const DOCS = [
  `${A}/bootstrap/root7-runtime-v20/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`,
  `${A}/bootstrap/root7-runtime-v20/ScopedRoot5FinalControllerQualification.json`,
  `${A}/root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json`,
  `${A}/root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json`,
  `${A}/root6-capacity/Root6LinuxController160SourceRefApproval20260913.json`,
  `${A}/root6-capacity/Root6LinuxController160SourceRefApproval20260913.v2.json`,
  `${A}/root6-capacity/Root6LinuxController160SourceRefCapacityProposal20260913.json`,
  `${A}/root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.v2.json`,
  `${A}/root6-capacity/Root6OriginalInput4000000CapacityProposal20260912.json`,
];

// Pinned inventory, measured 2026-09-13 on commit b634cc3. "<file basename> :: <path> :: <which>".
const PINNED = new Set([
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: accepted_subject.capacity_materials_intent.ordering_note :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: required_before_actual_ga.1 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: required_before_actual_ga.2 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: required_before_actual_ga.4 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: window10_continuation_evidence.correction :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: acceptance_record.independent_review.what_the_reviewer_did_not_endorse.0 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: acceptance_record.m2_flip.verified_before_flip.4 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: verified_on_host.checks.3.observed :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: verified_on_host.checks.4.observed :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: verified_on_host.checks.6.check :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: verified_on_host.checks.7.check :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: formerly_not_accepted_because.summary :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: formerly_not_accepted_because.to_accept.1 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: formerly_not_accepted_because.to_accept.2 :: controller_sha256',
  'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: formerly_not_accepted_because.resolution.0 :: controller_sha256',
  'ScopedRoot5FinalControllerQualification.json :: successor_delta :: controller_sha256',
  'ScopedRoot5FinalControllerQualification.json :: capacity_repair.note :: controller_sha256',
  'ScopedRoot5FinalControllerQualification.json :: verified_on_host.checks.3.observed :: controller_sha256',
  'ScopedRoot5FinalControllerQualification.json :: verified_on_host.checks.4.observed :: controller_sha256',
  'ScopedRoot5FinalControllerQualification.json :: verified_on_host.checks.6.check :: controller_sha256',
  'ScopedRoot5FinalControllerQualification.json :: verified_on_host.checks.7.check :: controller_sha256',
  'Root6Current043CapacityRepairAcceptance20260912.json :: root6_note :: controller_sha256',
  'Root6CurrentController4000000CapacityApplicability20260912.json :: source_set_semantics :: controller_sha256',
  'Root6LinuxController160SourceRefApproval20260913.json :: what_changed_from_predecessor.why :: controller_sha256',
  'Root6LinuxController160SourceRefApproval20260913.v2.json :: what_changed_from_predecessor.why :: controller_sha256',
  'Root6LinuxController160SourceRefCapacityProposal20260913.json :: supersedes_note :: controller_sha256',
]);

const problems = [];
const bad = m => problems.push(m);
const found = new Set();

// Defects already open on this tree, measured on b634cc3 and reported as R33-F1a. Listing them
// here does NOT make the run green -- the run still refuses while any of them stands. They are
// listed so that --tamper can require a failure set strictly LARGER than this one: that is the
// discipline work/f12/verify-issuer-candidates.mjs lost when its clean run started refusing, and
// its --tamper control silently stopped discriminating.
const KNOWN_OPEN = new Set([
  'NARRATION_CONTRADICTS_SIBLING_FIELD ExactRoot5FinalPreentryControllerRuntimeAcceptance.json :: window10_continuation_evidence.correction says "digest is now 68133f2d" but window10_continuation_evidence.controller_digest = 73c05cad',
]);

for (const rel of DOCS) {
  const base = path.basename(rel);
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  if (TAMPER && base.startsWith('Scoped')) doc.capacity_repair.injected_by_tamper = 'pins ' + abbrev(SUPERSEDED.controller_sha256);
  const walk = (o, p = '') => {
    if (o && typeof o === 'object') { for (const k of Object.keys(o)) walk(o[k], p ? p + '.' + k : k); return; }
    if (typeof o !== 'string') return;
    for (const [which, full] of Object.entries(SUPERSEDED)) {
      if (o.includes(full) && !EXEMPT(p)) bad('FULL_SUPERSEDED_VALUE_SURVIVED ' + base + ' :: ' + p + ' :: ' + which);
      if (o.includes(abbrev(full)) && !EXEMPT(p)) found.add(base + ' :: ' + p + ' :: ' + which);
    }
    const m = o.match(/digest is now ([0-9a-f]{8})/);
    if (m) {
      const parent = p.split('.').slice(0, -1).join('.');
      const sib = parent.split('.').filter(Boolean).reduce((a, k) => a?.[k], doc)?.controller_digest;
      if (typeof sib === 'string' && !sib.startsWith(m[1])) bad('NARRATION_CONTRADICTS_SIBLING_FIELD ' + base + ' :: ' + p + ' says "digest is now ' + m[1] + '" but ' + (parent || '<root>') + '.controller_digest = ' + sib.slice(0, 8));
    }
  };
  walk(doc);
}

if (SHOW) { [...found].sort().forEach(f => console.log("  '" + f + "',")); process.exit(0); }

for (const f of [...found].sort()) if (!PINNED.has(f)) bad('NEW_ABBREVIATED_RESIDUAL ' + f);
for (const f of [...PINNED].sort()) if (!found.has(f)) bad('INVENTORY_STALE (no longer present, update the pin) ' + f);

const novel = problems.filter(p => !KNOWN_OPEN.has(p));
const standing = problems.filter(p => KNOWN_OPEN.has(p));
console.log('  scanned ' + DOCS.length + ' re-issued document(s); ' + found.size + ' abbreviated residual(s) outside the exempt fields');
for (const p of standing) console.log('  KNOWN OPEN (R33-F1a)  ' + p);
for (const p of novel) console.error('  NEW  ' + p);

if (TAMPER) {
  const injected = novel.filter(p => p.includes('injected_by_tamper'));
  if (!injected.length) { console.error('DISCRIMINATOR_DID_NOT_FIRE: the injected abbreviation produced no NEW problem beyond the ' + standing.length + ' already standing'); process.exit(1); }
  console.log('discriminator fired on a NEW problem, not on the standing one(s): ' + injected[0]);
  process.exit(0);
}
if (novel.length) { console.error('REFUSED: ' + novel.length + ' new problem(s), ' + standing.length + ' standing'); process.exit(1); }
if (standing.length) { console.error('REFUSED: ' + standing.length + ' KNOWN OPEN defect(s) still unrepaired (R33-F1a); no new ones.'); process.exit(1); }
console.log('abbreviated-residual inventory unchanged; no full superseded value survives outside the exempt fields.');
