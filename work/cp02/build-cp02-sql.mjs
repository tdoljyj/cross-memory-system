#!/usr/bin/env node
// Generates the CP-02 SQL candidates from the one pinned rule table, so that the read-only
// derivation and the real transaction can never carry different replacement text.
//
//   node work/cp02/build-cp02-sql.mjs                generate
//   node work/cp02/build-cp02-sql.mjs --discriminate run the five discriminators
//
// Writes:
//   work/cp02/cp02-derive.sql         read-only; safe to run any number of times
//   work/cp02/cp02-apply.DRAFT.sql    while anything is unresolved. NOT FOR EXECUTION.
//   work/cp02/cp02-apply.candidate.sql
//                                     only once every sentinel is materialised and every
//                                     post-image digest is pinned. Not written before then,
//                                     so the runnable filename cannot exist by accident.
//
// This generator NEVER connects to a database and NEVER executes anything. It reads one JSON
// file and writes text. Every number it asserts was measured beforehand by a read-only select
// and is restated here as an independent witness (see WITNESS), so the table and the generator
// have to agree about the live database before either is believed.
//
// Lineage: work/cp01/build-cp01-sql.mjs, and the transaction shape of
// work/cp01/cp01-apply.candidate.sql. Deviations from CP-01 are marked "DEVIATION" and are
// listed in work/cp02/CP02BuildNotes.md.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- authorised edit classes -----------------------------------------------------------
// ExplicitOwnerApprovalM3.candidate.json cp02 clause, merged f92cd46e (PR 164). A rule whose
// class is not on this list is not authorised, whatever the rule table says about it.
const PERMITTED = [
  'LIVE_ROOT_GENERATION_ROOT6_TO_ROOT7',
  'SUPERSEDED_WINDOW_LITERALS_TO_THIS_WINDOW_MATERIALIZED_TIMESTAMPS',
  'BINDING_FORWARD_CAP_SERIES_F_16_TO_17',
  'BUDGET_SCOPE_SEGMENT_BOUNDARY_89_TO_90',
  'STATUS_MANIFEST_SCHEMA_ALLOW_LIST_APPEND_F12',
  'STATUS_MANIFEST_STRICT_EQUALITY_FOR_NEW_OBJECTS_TO_F12',
  'FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_ROOT7_POST_REGISTRATION_MEASURED_VALUES',
];

// The order is the application order and is load-bearing, so it is pinned by identity here
// rather than inferred from the table's array order. See ORDERING below.
const CANONICAL_ORDER = ['C1', 'C2', 'C3', 'C4', 'C5a', 'C5b', 'C6'];

const SHORT = ['reserve_gate', 'reserve_execution_budget', 'append_status_manifest'];
const SIG = {
  reserve_gate: 'clued_control.reserve_gate(text,text)',
  reserve_execution_budget: 'clued_control.reserve_execution_budget(text,text)',
  append_status_manifest: 'clued_control.append_status_manifest(text,text)',
};
// Asserted at the head of the transaction and NOT replaced by it. CP-01 carries the same
// function for the same reason.
const UNTOUCHED_FN = 'clued_control.effective_execution_binding()';

const TABLES = ['accepted_binding', 'control_objects', 'current_head', 'events',
                'execution_binding', 'execution_current', 'execution_events', 'gate_attempts'];

const TAG = 'cp02lit';     // dollar-quote tag for every substitution literal
const DOTAG = 'cp02tx';    // outer tag for the DO block
const ABTAG = 'cp02abort'; // outer tag for the draft tripwire blocks

const SENTINEL_RE = /__[A-Z0-9_]+__/g;
const HEX64 = /^[0-9a-f]{64}$/;

// ---- independent witness ----------------------------------------------------------------
// Measured 2026-09-13 by read-only select against project uscrdifznmlvczcekqpw, counting
//   (length(prosrc) - length(replace(prosrc, <literal>, ''))) / length(<literal>)
// for each rule's `from` against each live prosrc. Restated here so that the rule table's
// expected_occurrences and this generator are two independent statements of the same measured
// fact; if they disagree, generation stops. This is NOT a substitute for the run-time
// assertion -- the emitted SQL counts again, in-transaction, against the live bodies.
// Agrees with work/cp02/CP02PreimageMeasurement.md.
const WITNESS = {
  //      reserve_gate, reserve_execution_budget, append_status_manifest
  C1:  [4, 4, 1],
  C2:  [4, 5, 1],
  C3:  [1, 1, 0],
  C4:  [3, 3, 0],
  C5a: [0, 0, 1],
  C5b: [0, 0, 1],
  C6:  [1, 1, 0],
};

// Pre-image prosrc digests re-measured at the same moment, equal to the CP-01 post-image.
// They are ALSO in the rule table; both are asserted against each other below.
const WITNESS_PREIMAGE = {
  reserve_gate: 'd5bba9ef6a3a67966b27c0450fe3f65536010778670434798fd3f936543ec17e',
  reserve_execution_budget: '054c631abd6547310b0b70773b263a570b281ad9ee757f6970af70f0e5127b9b',
  append_status_manifest: '4f9d2be6a501efe57ba8dfe33f999781720094feda2151b5fea031a4c5bc0ccc',
};

// ---- the three Round-11 guards CP-01 already carries --------------------------------------
// cp02-substitutions.json.required_transaction_form demands all three. The rule table does not
// carry their constants (it is a table of substitutions), so they live here, each with its
// provenance and each either measured or explicitly pending.
//
// Two of them CANNOT be pinned today and carry sentinels on purpose:
//
//   untouched_functions_assertion.digest  measured today as 07e8fda5fd1473b5ac72c93760866a0c
//                                         8918ee92c7d65a3bb537531b062ea67d, which already
//                                         DIFFERS from the value CP-01 pinned
//                                         (c7af467630e8...). effective_execution_binding() is
//                                         inside this set and is replaced by every
//                                         EXECUTION_BINDING_FORWARD_ACCEPTED transaction, so
//                                         the 21st forward will move it again before CP-02
//                                         runs. Pinning today's value would guarantee a false
//                                         abort; pinning a projected one is exactly what the
//                                         M3 carrier's ordering clause exists to forbid.
//
//   preimage of effective_execution_binding()
//                                         measured today as 633269f15c362b06e19b6c23a9fddefd
//                                         dc5c4567f78ac8820d70579c697f4df2, likewise already
//                                         moved from the value CP-01 pinned (c721b056a771...).
//                                         Same reason, same remedy: measure immediately before
//                                         apply.
//
// The trigger assertion is structural, not a digest, and is stable; it is pinned, and if it
// drifts the transaction aborts, which is the point of asserting it.
const PENDING = '__PENDING_MEASURED_IMMEDIATELY_BEFORE_APPLY__';
const GUARDS = {
  window_assertion: {
    finding: 'R11-F12',
    // Derived from C2, not invented here: cp02-substitutions.json C2.why states
    // "T is the M3 merge committer.date 2026-09-13T05:45:14Z; the window expiry is T+86400s",
    // and C2.to IS that expiry. validate() re-checks expires_at - not_before = 86400s and
    // expires_at === C2.to, so a change to C2 cannot leave the window guard behind.
    not_before: '2026-09-13T05:45:14Z',
    expires_at: '2026-09-14T05:45:14Z',
    placement: 'both the pre-block and the post-block',
  },
  untouched_functions_assertion: {
    finding: 'R11-F13',
    total_functions_in_schema: 15,     // measured 2026-09-13, read-only
    untouched_count: 12,               // measured 2026-09-13, read-only
    digest: PENDING,
    measured_2026_09_13_for_reference: '07e8fda5fd1473b5ac72c93760866a0c8918ee92c7d65a3bb537531b062ea67d',
    digest_definition: "sha256 of the newline-joined 'signature=prosrc_sha256' lines for every " +
      'clued_control function except the three CP-02 replaces, in signature order',
    signatures: [
      'clued_control.append_event(jsonb)',
      'clued_control.commit_gate_result(text,text,text)',
      'clued_control.deny_mutation()',
      'clued_control.dispatch_recorded_intent(text,text,text,bigint,text)',
      'clued_control.effective_execution_binding()',
      'clued_control.execution_transition(jsonb)',
      'clued_control.guard_gate_bytes()',
      'clued_control.read_execution_event(bigint)',
      'clued_control.read_execution()',
      'clued_control.read_root(text)',
      'clued_control.record_effect_intent(text,text,jsonb)',
      'clued_control.rotate_execution_generation(jsonb)',
    ],
  },
  accepted_binding_trigger_assertion: {
    finding: 'R11-F13, the half the NW-01 receipt recorded as still owed',
    measured: '2026-09-13, read-only',
    expected_non_internal_triggers: 1,
    expected_trigger_name: 'accepted_binding_immutable',
    expected_tgenabled: 'O',
  },
  untouched_preimage: {
    [UNTOUCHED_FN]: PENDING,
    measured_2026_09_13_for_reference: '633269f15c362b06e19b6c23a9fddefddc5c4567f78ac8820d70579c697f4df2',
  },
};

// Post-image prosrc digests. Cannot exist until every sentinel is materialised and
// cp02-derive.sql has been run read-only against the live bodies. Filling these in by hand
// without that run is the one thing this whole file exists to prevent.
const POSTIMAGE = {
  reserve_gate: null,
  reserve_execution_budget: null,
  append_status_manifest: null,
};

// ---- open findings that block a runnable candidate -------------------------------------------
// A measured problem with the rule table itself. It is NOT a sentinel (nothing is merely waiting
// to be filled in) and NOT a post-image gap, so it gets its own gate: while this list is
// non-empty the generator emits a draft and refuses to write a runnable candidate file.
//
// Clearing an entry is a deliberate, reviewable act -- delete it here and say in
// CP02BuildNotes.md what adjudication cleared it. Do not clear one by widening a rule on your
// own: every entry below is outside the seven classes the M3 carrier authorises, so clearing it
// is an approval question, not an editing question.
const OPEN_FINDINGS = [
  {
    id: 'CP02-OF1',
    title: 'C6 moves one literal of a three-literal guard; the other two stay root6-shaped',
    measured: 'Read-only, 2026-09-13. reserve_gate and reserve_execution_budget each carry ONE ' +
      'copy of a coupled three-assertion block that CP-01 G8/B9 installed:\n' +
      "      (i)   sha256 over root events with (e->>'sequence')::bigint<=5  is distinct from 45c6a2cb...\n" +
      "      (ii)  jsonb_array_length(series_view->'root'->'events')         is distinct from 6\n" +
      "      (iii) sha256 over (root - events) || {registration_event: the event at " +
      "(e->>'sequence')::bigint=6}  is distinct from 72355efd...\n" +
      '    C6 replaces the digest in (iii) and nothing else. After the root7 registration the ' +
      'root carries seven events, so (ii) raises series_full_original_root_changed on every ' +
      'call, and (iii) would still select the ROOT6 registration event by sequence=6 whatever ' +
      'digest is pinned into it. Measured occurrences of each literal: 1 in reserve_gate, 1 in ' +
      'reserve_execution_budget, 0 in append_status_manifest.',
    clears_when: 'Either the M3 carrier is read as already covering (ii) and (iii) inside ' +
      'FULL_ROOT_OBJECT_DIGEST_REPINNED_TO_ROOT7_POST_REGISTRATION_MEASURED_VALUES and C6 is ' +
      'rewritten to span the whole coupled block as one anchor, or a further class is ' +
      'adjudicated for them. Whether (i) also moves (<=5 -> <=6, and a new prefix digest) is a ' +
      'separate question: the first five root events do not change, so <=5 may well be correct ' +
      'as it stands. Not decided here.',
  },
];

// ---- the rule-table byte pin --------------------------------------------------------------
// sha256 over the seven load-bearing tuples of cp02-substitutions.json, canonicalised as
//   id US class US operation US from US to US "rg|reb|asm"
// joined by newline, where US is U+0001 and C6's `to` is replaced by the fixed string
// 'C6_TO_CHECKED_SEPARATELY'. C6's `to` is excluded ON PURPOSE and ONLY C6's: materialising the
// root7 root-object digest is the one change to the table that is expected, and it is checked
// by its own rule below (sentinel, or a 64-hex value different from `from`). Everything else --
// every literal, every class, every operation, every expected count -- is frozen: one changed
// byte anywhere else and this digest stops the run.
//
// Prose fields (why / adjudicated / measured_context / correction_log) are deliberately outside
// the digest, so a reviewer can improve the commentary without breaking the pin.
const RULES_DIGEST = '2264024a5c57558449fbad460888136b0bc341f8e211a923b711cb4266b81b25';

// ------------------------------------------------------------------------------------------

class Refused extends Error {}
const fail = m => { throw new Refused(m); };

const rulesDigest = rules => {
  const US = String.fromCharCode(1);
  const lines = rules.map(r => [
    r.id, r.class, r.operation || 'REPLACE', r.from,
    r.id === 'C6' ? 'C6_TO_CHECKED_SEPARATELY' : r.to,
    SHORT.map(s => occ(r, s)).join('|'),
  ].join(US));
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
};

// A rule that does not name a function expects ZERO occurrences there, and that zero is
// asserted like any other count. DEVIATION from CP-01, which only emitted the edits it
// expected to match. CP02PreimageMeasurement.md records why: the dangerous direction is a
// rule written in the wrong form and therefore expected to match nothing, so "must not appear
// here" is asserted rather than assumed.
const occ = (r, s) => {
  const v = (r.expected_occurrences || {})[s];
  if (v === undefined) return 0;
  if (!Number.isInteger(v) || v < 0) fail(`${r.id}.expected_occurrences.${s} is not a non-negative integer`);
  return v;
};

const hexLiterals = s => (s.match(/[0-9a-f]{64}/g) || []);
const secondsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;

// ---- validation ---------------------------------------------------------------------------
// Order matters. Structural and semantic checks run FIRST and report what is actually wrong;
// the byte pin runs LAST and catches everything that slipped past a rule with a name.
function validate(table) {
  const rules = table.edit_classes;
  if (!Array.isArray(rules)) fail('cp02-substitutions.json carries no edit_classes array');

  // (a) shape
  if (rules.length !== 7)
    fail(`expected 7 rules (C1 C2 C3 C4 C5a C5b C6); found ${rules.length}. ` +
         `Change this number deliberately, not incidentally.`);
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) fail(`duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (!PERMITTED.includes(r.class))
      fail(`${r.id} carries class ${r.class}, which is not one of cp02.permitted_edit_classes`);
    if (typeof r.from !== 'string' || !r.from.length) fail(`${r.id} has no from`);
    if (typeof r.to !== 'string' || !r.to.length) fail(`${r.id} has no to`);
    if (r.from === r.to) fail(`${r.id} is a no-op`);
    for (const [k, v] of [['from', r.from], ['to', r.to]]) {
      if (v.includes('$' + TAG + '$')) fail(`${r.id}.${k} contains the dollar-quote tag`);
      // The boundary for this work forbids touching the 600-second clause, and cp02.prohibited
      // forbids any capacity/refund/reset/automatic-retry effect. No rule may carry that text.
      for (const bad of ['600 seconds', 'refund', 'capacity'])
        if (v.includes(bad)) fail(`${r.id}.${k} contains the prohibited text ${JSON.stringify(bad)}`);
    }
    if (SHORT.every(s => occ(r, s) === 0))
      fail(`${r.id} expects zero occurrences in all three functions, so it does nothing`);
  }

  // (b) ordering. cp02-substitutions.json.ordering_constraints states both of these.
  const order = rules.map(r => r.id);
  if (order.join(',') !== CANONICAL_ORDER.join(','))
    fail(`rule order is ${order.join(',')}, expected ${CANONICAL_ORDER.join(',')}. ` +
         `C5a MUST precede C5b (C5b's anchor sits inside the text C5a rewrites, and CP-01 A1/A2 ` +
         `record the same constraint), and C6 MUST be last (its value only exists after the ` +
         `root7 registration).`);
  if (order.indexOf('C5a') >= order.indexOf('C5b')) fail('C5a must be applied before C5b');
  if (order[order.length - 1] !== 'C6') fail('C6 must be the last rule applied');

  const by = Object.fromEntries(rules.map(r => [r.id, r]));

  // (c) per-rule pins. Each of these was measured; none of them is generalised from another.

  // C1: root6 -> root7 generation id, both sides well-formed.
  for (const k of ['from', 'to'])
    if (!/^ctrgen_[0-9a-f]{32}$/.test(by.C1[k])) fail(`C1.${k} is not a ctrgen_<32 hex> id`);

  // C2: the window literal. The expiry the rule installs and the window the transaction
  // asserts must be the same instant, and the window must be exactly 86400 seconds.
  if (by.C2.to !== GUARDS.window_assertion.expires_at)
    fail(`C2.to (${by.C2.to}) and the in-transaction window expiry ` +
         `(${GUARDS.window_assertion.expires_at}) disagree. The transaction would install one ` +
         `expiry while asserting a different one.`);
  const span = secondsBetween(GUARDS.window_assertion.not_before, GUARDS.window_assertion.expires_at);
  if (span !== 86400)
    fail(`the Owner window is ${span}s, expected 86400s (T .. T+86400s, T = the M3 merge ` +
         `committer.date). A window that is not 86400 seconds is a different window.`);
  if (Date.parse(by.C2.from) >= Date.parse(by.C2.to))
    fail('C2 moves the window backwards');

  // C3: MEASURED FORM HAS NO SPACES. The spaced form matches nothing, and a rule that matches
  // nothing is the failure mode CP02PreimageMeasurement.md was written about.
  if (by.C3.from !== 'series_f>16' || by.C3.to !== 'series_f>17')
    fail(`C3 must be exactly 'series_f>16' -> 'series_f>17' with NO spaces, as measured. ` +
         `Found ${JSON.stringify(by.C3.from)} -> ${JSON.stringify(by.C3.to)}.`);
  // cp02.prohibited: "raising the forward cap past 17, or on one side only".
  if (occ(by.C3, 'reserve_gate') !== occ(by.C3, 'reserve_execution_budget'))
    fail('C3 raises the forward cap on one side only; the gate and the budget must move together');

  // C4: MEASURED FORM HAS SPACES -- the opposite convention to C3, in the same prosrc. Do not
  // generalise either one to the other.
  if (by.C4.from !== '>= 89' || by.C4.to !== '>= 90')
    fail(`C4 must be exactly '>= 89' -> '>= 90' WITH the space, as measured (the unspaced ` +
         `'>=89' matches nothing). Found ${JSON.stringify(by.C4.from)} -> ${JSON.stringify(by.C4.to)}.`);
  if (occ(by.C4, 'reserve_gate') !== occ(by.C4, 'reserve_execution_budget'))
    fail('C4 moves the segment boundary on one side only');

  // C5a: APPEND, NOT REPLACE. Every historical allow-list member must survive, because CP-01 A1
  // states the rationale verbatim: an existing manifest must still resubmit as an exact
  // duplicate. A blanket substitution here silently drops 510f3b90 and breaks that.
  if ((by.C5a.operation || '') !== 'APPEND, NOT REPLACE')
    fail(`C5a.operation is ${JSON.stringify(by.C5a.operation)}, expected "APPEND, NOT REPLACE"`);
  const aFrom = hexLiterals(by.C5a.from), aTo = hexLiterals(by.C5a.to);
  for (const h of aFrom)
    if (!aTo.includes(h))
      fail(`C5a drops the historical allow-list member ${h.slice(0, 8)}... . C5a is an APPEND: ` +
           `every digest already in the allow list must still be in it afterwards, or every ` +
           `existing status manifest stops resubmitting as an exact duplicate (CP-01 A1).`);
  if (aTo.length !== aFrom.length + 1)
    fail(`C5a must add exactly one allow-list member; it goes from ${aFrom.length} to ${aTo.length}`);

  // C5b: REPLACE. The strict-equality pin for NEW objects moves wholesale; the old digest must
  // NOT survive on this side.
  if ((by.C5b.operation || 'REPLACE') !== 'REPLACE')
    fail(`C5b.operation is ${JSON.stringify(by.C5b.operation)}, expected "REPLACE"`);
  const bFrom = hexLiterals(by.C5b.from), bTo = hexLiterals(by.C5b.to);
  if (bFrom.length !== 1 || bTo.length !== 1)
    fail('C5b must carry exactly one digest on each side');
  if (bTo[0] === bFrom[0]) fail('C5b replaces the strict-equality pin with itself');
  if (by.C5b.from.includes(bTo[0]))
    fail('C5b.from already contains the new digest; the anchor is not the pre-image text');
  // The new digest must be the same one C5a appends. Two different F12 digests is the defect
  // class the correction_log records.
  const appended = aTo.filter(h => !aFrom.includes(h));
  if (appended.length !== 1 || appended[0] !== bTo[0])
    fail(`C5a appends ${appended.join(',') || '<nothing>'} but C5b pins ${bTo[0]}; ` +
         `the allow-list member and the strict-equality pin must be the same F12 digest`);

  // C6: the root-object digest. sha256(r::text) over the whole root row exists only after the
  // root7 registration event is written, and it is NOT the canonicalDigest of the registration
  // body (the a93bfdda class) -- same moment, different value class. Conflating them is the
  // defect the reissue found. So: sentinel, or a 64-hex value that is not the pre-image.
  if (!HEX64.test(by.C6.from)) fail('C6.from is not a 64-hex digest');
  const c6Sentinel = by.C6.to === '__PENDING_MEASURED_AFTER_ROOT7_REGISTRATION__';
  if (!c6Sentinel) {
    if (!HEX64.test(by.C6.to))
      fail(`C6.to is neither the sentinel __PENDING_MEASURED_AFTER_ROOT7_REGISTRATION__ nor a ` +
           `64-hex digest. Found ${JSON.stringify(by.C6.to)}. It must be MEASURED after the ` +
           `root7 registration -- never projected, and never the registration body's ` +
           `canonicalDigest, which is a different value class.`);
    if (by.C6.to === by.C6.from) fail('C6 repins the root-object digest to itself');
  }

  // (d) pre-image agreement between the table and this generator.
  for (const s of SHORT) {
    const t = (table.preimage || {})[s];
    if (!HEX64.test(t || '')) fail(`cp02-substitutions.json.preimage.${s} is not a 64-hex digest`);
    if (t !== WITNESS_PREIMAGE[s])
      fail(`pre-image disagreement for ${s}: the rule table says ${t}, this generator measured ` +
           `${WITNESS_PREIMAGE[s]}. One of them is stale. Re-measure; do not pick a side.`);
  }
  if ((table.preimage || {}).MUST_REMEASURE_BEFORE_APPLY !== true)
    fail('cp02-substitutions.json.preimage.MUST_REMEASURE_BEFORE_APPLY must be true');

  // (e) expected_occurrences, rule by rule, against the independent witness.
  for (const r of rules) {
    const w = WITNESS[r.id];
    if (!w) fail(`no measured witness for rule ${r.id}`);
    const got = SHORT.map(s => occ(r, s));
    for (let i = 0; i < SHORT.length; i++)
      if (got[i] !== w[i])
        fail(`${r.id} expects ${got[i]} occurrence(s) in ${SHORT[i]}, but the read-only ` +
             `measurement of 2026-09-13 found ${w[i]}. Counts do not match -- stopping. ` +
             `Re-measure against the live prosrc and fix whichever of the two is wrong.`);
  }

  // (f) the byte pin, last.
  const d = rulesDigest(rules);
  if (d !== RULES_DIGEST)
    fail(`the rule table's load-bearing bytes digest to ${d}, expected ${RULES_DIGEST}. ` +
         `Something in a literal, a class, an operation or an expected count changed. If the ` +
         `change is intended, re-derive this pin deliberately and say why in CP02BuildNotes.md. ` +
         `(Materialising C6.to is the one change this pin deliberately does not see.)`);

  return {rules, by};
}

// ---- expansion into per-function edits -----------------------------------------------------

const expand = rules => SHORT.map(s => ({
  short: s,
  function: SIG[s],
  edits: rules.map((r, i) => ({
    i: i + 1, id: `${r.id}@${s}`, rule: r.id,
    expected_count: occ(r, s), from: r.from, to: r.to,
  })),
}));

// ---- emission -------------------------------------------------------------------------------

const lit = s => '$' + TAG + '$' + s + '$' + TAG + '$';
const q = s => "'" + String(s).replaceAll("'", () => "''") + "'";

const subsValues = fn => fn.edits.map(e =>
  `    (${e.i}, ${q(e.id)}, ${e.expected_count}, ${lit(e.from)},\n        ${lit(e.to)})`
).join(',\n');

const banner = title => `-- ${'='.repeat(88)}
-- ${title}
-- generated by work/cp02/build-cp02-sql.mjs from work/cp02/cp02-substitutions.json
-- DO NOT EDIT THIS FILE. Edit the rule table and regenerate.
-- ${'='.repeat(88)}
`;

function build(table) {
  const {rules, by} = validate(table);
  const fns = expand(rules);

  // What is still unresolved. Each of these independently makes the transaction a draft.
  const sentinels = [];
  for (const r of rules)
    for (const m of (r.to.match(SENTINEL_RE) || [])) sentinels.push(`rule ${r.id}.to: ${m}`);
  for (const m of (GUARDS.untouched_functions_assertion.digest.match(SENTINEL_RE) || []))
    sentinels.push(`R11-F13 untouched-functions digest: ${m}`);
  for (const m of (GUARDS.untouched_preimage[UNTOUCHED_FN].match(SENTINEL_RE) || []))
    sentinels.push(`pre-image of ${UNTOUCHED_FN}: ${m}`);
  const missing = SHORT.filter(s => !HEX64.test(POSTIMAGE[s] || ''));
  const draft = sentinels.length > 0 || missing.length > 0 || OPEN_FINDINGS.length > 0;

  // ---- cp02-derive.sql ---------------------------------------------------------------------

  let derive = banner('CP-02 read-only derivation. Performs no write of any kind.') +
`--
-- Runs only SELECT. It reads pg_proc.prosrc and pg_get_functiondef(), folds the seven pinned
-- rules over both IN ORDER, and reports per function:
--   pre_matches         the pre-image digest still equals the pinned one (drift check)
--   steps               per rule: occurrences found just before it was applied, and whether the
--                       same count holds over the full CREATE statement
--   all_counts_ok       every rule matched its expected occurrence count EXACTLY, including the
--                       rules expected to match zero times in that function
--   post_prosrc_sha     the value to pin into POSTIMAGE in build-cp02-sql.mjs
--   pre/post_prosrc_len length delta is a second, independent witness
--
-- MUST_REMEASURE: the pre-image digests below were measured on 2026-09-13 and equal the CP-01
-- post-image. They are a PRECONDITION of the transaction, not a record of it. NW-02, the root7
-- registration and the 21st binding forward all land between that measurement and CP-02, so
-- THIS FILE MUST BE RE-RUN IMMEDIATELY BEFORE APPLY and its output archived. A CP-02
-- transaction built on a stale pre-image must fail closed, never proceed.
--
-- Two whitespace conventions coexist in these bodies and neither is generalised from the other:
--   C3 matches 'series_f>16'  with NO spaces  (the spaced form returns zero hits)
--   C4 matches '>= 89'        WITH the space  (the unspaced form returns zero hits)
--
-- C5a is an APPEND and C5b is a REPLACE, and C5a runs first. C5a keeps every historical member
-- of the status-manifest allow list so that existing manifests still resubmit as exact
-- duplicates; C5b moves the strict-equality pin for NEW objects only.
`;

  if (sentinels.length) derive += `--
-- CAUTION: the inputs still carry unresolved sentinels
${sentinels.map(x => `--   ${x}`).join('\n')}
-- so the post_prosrc_sha this query returns describes text that still contains them.
-- It is NOT the value to pin. Resolve them first (C6 is measurable only AFTER the root7
-- registration event is written: sha256(r::text) over the whole root row, which is a
-- DIFFERENT value class from the registration body's canonicalDigest -- do not substitute one
-- for the other), then re-run this.
`;

  const foldBlock = (fn, k) => {
    const p = 'f' + k;
    return `${p}_subs(i, id, want, f, t) as (values
${subsValues(fn)}
),
${p}_base as (
  select p.prosrc as s, pg_get_functiondef(p.oid) as d
  from pg_proc p
  where p.oid = ${q(fn.function)}::regprocedure
),
${p}_fold(i, id, want, cnt, dcnt, s, d) as (
  select 0, null::text, null::int, null::bigint, null::bigint, s, d from ${p}_base
  union all
  select ${p}_subs.i, ${p}_subs.id, ${p}_subs.want,
         (length(${p}_fold.s) - length(replace(${p}_fold.s, ${p}_subs.f, ''))) / length(${p}_subs.f),
         (length(${p}_fold.d) - length(replace(${p}_fold.d, ${p}_subs.f, ''))) / length(${p}_subs.f),
         replace(${p}_fold.s, ${p}_subs.f, ${p}_subs.t),
         replace(${p}_fold.d, ${p}_subs.f, ${p}_subs.t)
  from ${p}_fold join ${p}_subs on ${p}_subs.i = ${p}_fold.i + 1
)`;
  };

  const reportBlock = (fn, k) => {
    const p = 'f' + k;
    return `select
  ${k + 1} as ord,
  ${q(fn.function)} as function,
  (select encode(sha256(convert_to(s, 'UTF8')), 'hex') from ${p}_base) = ${q(table.preimage[fn.short])} as pre_matches,
  (select bool_and(cnt = want and cnt = dcnt) from ${p}_fold where i > 0) as all_counts_ok,
  (select count(*) from ${p}_fold where i > 0) = ${fn.edits.length} as all_steps_ran,
  (select jsonb_agg(jsonb_build_object('id', id, 'found', cnt, 'expected', want,
                                       'def_agrees', cnt = dcnt) order by i)
     from ${p}_fold where i > 0) as steps,
  (select length(s) from ${p}_base) as pre_len,
  length(s) as post_len,
  encode(sha256(convert_to(s, 'UTF8')), 'hex') as post_prosrc_sha
from ${p}_fold where i = ${fn.edits.length}`;
  };

  derive += `
with recursive ${fns.map(foldBlock).join(',\n')}
${fns.map(reportBlock).join('\nunion all\n')}
order by ord;
`;

  // ---- the transaction ---------------------------------------------------------------------

  const G = GUARDS;
  const UNTOUCHED_DIGEST_EXPR = `(select encode(sha256(convert_to(string_agg(sig||'='||sha, E'\\n' order by sig),'UTF8')),'hex')
     from (select p.oid::regprocedure::text as sig,
                  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as sha
             from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
            where n2.nspname = 'clued_control'
              and p.oid::regprocedure::text not in (${SHORT.map(s => q(SIG[s])).join(', ')})) u)`;

  const roundElevenGuards = tag => `
  -- R11-F12: inside the Owner window. The one condition that changes on its own, so it belongs
  -- here and not only in a preflight taken minutes earlier.
  if not (clock_timestamp() >= ${q(G.window_assertion.not_before)}::timestamptz
          and clock_timestamp() < ${q(G.window_assertion.expires_at)}::timestamptz) then
    raise exception 'CP02_${tag}OUTSIDE_THE_OWNER_WINDOW: % is not within [% , %)',
      clock_timestamp(), ${q(G.window_assertion.not_before)}, ${q(G.window_assertion.expires_at)};
  end if;

  -- R11-F13: every clued_control function this transaction does not replace, pinned as one
  -- digest. Re-measure this immediately before apply: effective_execution_binding() is inside
  -- this set and every binding forward replaces it.
  select count(*) into c from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'clued_control';
  if c <> ${G.untouched_functions_assertion.total_functions_in_schema} then
    raise exception 'CP02_${tag}FUNCTION_COUNT_DRIFT: %', c;
  end if;
  got := ${UNTOUCHED_DIGEST_EXPR};
  if got is distinct from ${q(G.untouched_functions_assertion.digest)} then
    raise exception 'CP02_${tag}UNTOUCHED_FUNCTIONS_DRIFT: %', got;
  end if;

  -- R11-F13, the accepted_binding half: exactly one non-internal trigger, it is the
  -- immutability trigger, and it is enabled. CP-02's window guard trusts a row that trigger is
  -- what protects.
  select count(*) into c from pg_trigger t
   where t.tgrelid = 'clued_control.accepted_binding'::regclass and not t.tgisinternal;
  if c <> ${G.accepted_binding_trigger_assertion.expected_non_internal_triggers} then
    raise exception 'CP02_${tag}ACCEPTED_BINDING_TRIGGER_COUNT: %', c;
  end if;
  -- tgenabled is "char", and text || "char" is ambiguous (42725). The cast is not cosmetic:
  -- without it this statement fails to parse and the guard aborts the transaction it is
  -- supposed to be protecting.
  select t.tgname || ':' || t.tgenabled::text into got from pg_trigger t
   where t.tgrelid = 'clued_control.accepted_binding'::regclass and not t.tgisinternal;
  if got is distinct from ${q(G.accepted_binding_trigger_assertion.expected_trigger_name + ':' +
                              G.accepted_binding_trigger_assertion.expected_tgenabled)} then
    raise exception 'CP02_${tag}ACCEPTED_BINDING_TRIGGER_DRIFT: %', got;
  end if;`;

  const tripwire = where => `
-- ${'!'.repeat(86)}
do $${ABTAG}$ begin
  raise exception 'CP02_DRAFT_NOT_FOR_EXECUTION (${where}): this file is a draft. %',
    'unresolved: ${sentinels.concat(missing.map(s => 'post-image digest unpinned ' + s))
                            .concat(OPEN_FINDINGS.map(f => 'open finding ' + f.id))
                            .join('; ').replaceAll("'", '')}';
end $${ABTAG}$;
-- ${'!'.repeat(86)}
`;

  let apply = banner(draft
    ? 'CP-02 DRAFT. NOT FOR EXECUTION. See the blocking list immediately below.'
    : 'CP-02 candidate transaction. NOT YET AUTHORISED TO RUN.') +
(draft ? `--
-- ${'!'.repeat(91)}
-- !!  N O T   F O R   E X E C U T I O N${' '.repeat(52)}!!
-- !!  This file is a DRAFT. It must not be run, in whole or in part, against any database. !!
-- ${'!'.repeat(91)}
--
-- Blocking:
${sentinels.map(x => `--   unresolved sentinel          ${x}`).join('\n') || '--   (no unresolved sentinels)'}
${missing.map(s => `--   post-image digest unpinned   ${SIG[s]}`).join('\n') || '--   (all post-image digests pinned)'}
${OPEN_FINDINGS.map(f => `--   open finding                ${f.id}  ${f.title}\n--     measured:    ` +
    f.measured.replaceAll('\n', '\n--     ') + `\n--     clears when: ${f.clears_when}`).join('\n') ||
  '--   (no open findings)'}
--
-- Two tripwires below (one before BEGIN, one as the first statement inside the transaction)
-- raise immediately if this file is fed to a client anyway. The second one is inside the
-- transaction on purpose: once it fires, every later statement in the block fails too, so a
-- client that ignores the first error still cannot reach a CREATE OR REPLACE.
--
` : '') +
`--
-- Preconditions, none of which this file can check for you:
--   1. Owner has merged ExplicitOwnerApprovalM3, including the cp02 clause (f92cd46e, PR 164).
--   2. NW-02 has run, root7 is REGISTERED, and the 21st binding forward has been accepted.
--      CP-02 comes AFTER the registration precisely so C6 can be MEASURED rather than
--      projected, and so the window literals are materialised rather than guessed.
--   3. cp02-derive.sql has been re-run read-only against the live bodies IMMEDIATELY BEFORE
--      this file is run, its output archived, and the post-image digests pinned from that run.
--      The pre-image recorded in the rule table is a precondition with an expiry, not a fact.
--   4. This file has been read by the independent reviewer.
--
-- Shape follows CP-01 (work/cp01/cp01-apply.candidate.sql): one transaction, ACCESS EXCLUSIVE
-- on all eight clued_control tables, opening prosrc digest assertions for all four functions
-- including the one that must NOT change, abort on any drift, read-only readback after, and
-- the three Round-11 guards in both the pre-block and the post-block.
--
-- No function body appears in this file. Each body is read from pg_proc inside the transaction,
-- folded through the pinned rules, checked against a digest computed by the read-only run of
-- cp02-derive.sql, and only then executed. Any drift between that run and this one aborts
-- before a single CREATE OR REPLACE is issued.
--
-- Rollback: every statement here is a CREATE OR REPLACE inside one transaction. Until COMMIT
-- nothing is visible; after COMMIT the previous bodies are recoverable only from the archived
-- pre-image, so archive the output of cp02-derive.sql BEFORE running this.
--
-- Interruption: if this transaction is cut off, do NOT re-run it blindly. Read the four prosrc
-- digests first. All four at their pre-image values means nothing committed and it may be run
-- again; anything else is a partial state that needs its own decision. cp02.prohibited lists
-- "blind retry after an interruption" explicitly.
` + (draft ? tripwire('before BEGIN') : '') + `
begin;
` + (draft ? tripwire('inside the transaction') : '') + `
set local statement_timeout = '120s';
set local lock_timeout = '30s';

lock table ${TABLES.map(t => 'clued_control.' + t).join(',\n     ')}
  in access exclusive mode;

do $${DOTAG}$
declare
  src text; def text; c bigint; want text; got text; rec record; n int;
begin
`;

  const preimages = [...SHORT.map(s => [SIG[s], table.preimage[s]]),
                     [UNTOUCHED_FN, GUARDS.untouched_preimage[UNTOUCHED_FN]]];
  for (const [sig, sha] of preimages) {
    apply += `
  select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') into got
  from pg_proc p where p.oid = ${q(sig)}::regprocedure;
  if got is distinct from ${q(sha)} then
    raise exception 'CP02_PREIMAGE_DRIFT % expected % got %', ${q(sig)}, ${q(sha)}, coalesce(got, '<absent>');
  end if;`;
  }

  apply += roundElevenGuards('');

  apply += `

  -- ${UNTOUCHED_FN} is asserted above and MUST NOT be replaced here. It may
  -- change only via APPEND_ONLY_BINDING_FORWARD_TRANSACTION_RECORDING_EXECUTION_BINDING_
  -- FORWARD_ACCEPTED, never by CREATE OR REPLACE.
`;

  for (const fn of fns) {
    const post = POSTIMAGE[fn.short];
    apply += `
  -- ${'-'.repeat(84)}
  -- ${fn.function} — ${fn.edits.length} rules, applied in order
  --   ${fn.edits.map(e => `${e.rule}:${e.expected_count}`).join('  ')}
  -- A rule expecting 0 here is still asserted: "must not appear in this body" is a check, not
  -- an omission.
  -- ${'-'.repeat(84)}
  select p.prosrc, pg_get_functiondef(p.oid) into src, def
  from pg_proc p where p.oid = ${q(fn.function)}::regprocedure;

  n := 0;
  for rec in select * from (values
${subsValues(fn)}
  ) as v(i, id, want, f, t) order by i loop
    n := n + 1;
    if n <> rec.i then raise exception 'CP02_STEP_OUT_OF_ORDER % %', n, rec.i; end if;
    c := (length(src) - length(replace(src, rec.f, ''))) / length(rec.f);
    if c <> rec.want then
      raise exception 'CP02_COUNT_% expected % occurrences, found %', rec.id, rec.want, c;
    end if;
    if c <> (length(def) - length(replace(def, rec.f, ''))) / length(rec.f) then
      raise exception 'CP02_COUNT_DISAGREES_BODY_VS_DEFINITION_%', rec.id;
    end if;
    src := replace(src, rec.f, rec.t);
    def := replace(def, rec.f, rec.t);
  end loop;
  if n <> ${fn.edits.length} then
    raise exception 'CP02_EXPECTED_%_RULES_APPLIED_%', ${fn.edits.length}, n;
  end if;

  want := ${post ? q(post) : `'__PIN_FROM_cp02-derive.sql__'`};
  got  := encode(sha256(convert_to(src, 'UTF8')), 'hex');
  if got is distinct from want then
    raise exception 'CP02_POSTIMAGE_DRIFT % expected % got %', ${q(fn.function)}, want, got;
  end if;

  execute def;

  select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') into got
  from pg_proc p where p.oid = ${q(fn.function)}::regprocedure;
  if got is distinct from want then
    raise exception 'CP02_READBACK_MISMATCH % expected % got %', ${q(fn.function)}, want, got;
  end if;
`;
  }

  apply += roundElevenGuards('POST_');

  apply += `
  -- The one function that must be byte-identical to how it started.
  select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') into got
  from pg_proc p where p.oid = ${q(UNTOUCHED_FN)}::regprocedure;
  if got is distinct from ${q(GUARDS.untouched_preimage[UNTOUCHED_FN])} then
    raise exception 'CP02_UNTOUCHED_FUNCTION_CHANGED %', got;
  end if;
end
$${DOTAG}$;

-- In-transaction readback. Archive this alongside the exact input above.
select p.proname,
       encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as prosrc_sha256,
       length(p.prosrc) as prosrc_len
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'clued_control'
  and p.proname in ('append_status_manifest','effective_execution_binding',
                    'reserve_execution_budget','reserve_gate')
order by p.proname;

commit;

-- After COMMIT, run the SAME select again in a separate read-only session and archive that too.
-- That second read is the "immediate read-only read-back" the standing constraints require;
-- the one above is inside the writing transaction and does not satisfy it on its own.
`;

  // ---- output hygiene ------------------------------------------------------------------------

  const opens = apply.split('$' + DOTAG + '$').length - 1;
  if (opens !== 2) fail(`the DO block tag $${DOTAG}$ appears ${opens} times in the generated ` +
                        `transaction; expected exactly 2 (open and close)`);
  const aborts = apply.split('$' + ABTAG + '$').length - 1;
  if (aborts !== (draft ? 4 : 0))
    fail(`the tripwire tag $${ABTAG}$ appears ${aborts} times; expected ${draft ? 4 : 0}`);
  if (derive.includes('$' + DOTAG + '$') || derive.includes('$' + ABTAG + '$'))
    fail('the read-only derivation must not contain a DO block');
  if (!/^\s*(--|with recursive)/m.test(derive) || /\b(insert|update|delete|create|drop|alter|execute|commit|begin)\b/i.test(
        derive.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').replace(/\$cp02lit\$[\s\S]*?\$cp02lit\$/g, '')))
    fail('cp02-derive.sql contains something other than a read-only SELECT outside its literals');

  // A missing key interpolates as the string "undefined" and lands in the SQL.
  const reEscape = t => t.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
  for (const [name, text] of [['cp02-derive.sql', derive], ['cp02-apply', apply]])
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      const at = text.search(new RegExp('(^|[^A-Za-z_.])' + reEscape(bad) + '($|[^A-Za-z_])'));
      if (at >= 0)
        fail(`${name} contains the literal ${JSON.stringify(bad)} at offset ${at} -- a template ` +
             `read a key that does not exist. Fix the reference, not the output.\n  context: ...` +
             text.slice(Math.max(0, at - 100), at + 90).replace(/\n/g, ' ') + '...');
    }

  return {derive, apply, draft, sentinels, missing, findings: OPEN_FINDINGS, fns};
}

// ---- discriminators --------------------------------------------------------------------------
// Each mutation below MUST make the generator refuse. A discriminator that cannot fail proves
// nothing, so this mode asserts the refusal and asserts that the message names the right thing.
const DISCRIMINATORS = [
  {
    name: 'one byte changed in a rule literal',
    why: 'the last hex digit of C1.to. Structurally still a well-formed ctrgen id, so no named ' +
         'rule catches it; the byte pin must.',
    mutate: t => { const r = t.edit_classes.find(x => x.id === 'C1'); r.to = r.to.slice(0, -1) + '9'; },
    expect: /load-bearing bytes digest to/,
  },
  {
    name: 'C5a done as a REPLACE instead of an APPEND',
    why: 'drops 510f3b90 from the three-member allow list, so every existing status manifest ' +
         'stops resubmitting as an exact duplicate (CP-01 A1).',
    mutate: t => {
      const r = t.edit_classes.find(x => x.id === 'C5a');
      r.to = r.from.replace('510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef',
                            '7e5df5dd2b2341fe38c7b2a86ef68542700ee878bec0c947b13d7c8311fecd2d');
    },
    expect: /drops the historical allow-list member 510f3b90/,
  },
  {
    name: 'C5a and C5b applied in the wrong order',
    why: 'the adjudicated shape (CP-01 A1 then A2) fixes the order. Measured 2026-09-13: with ' +
         'the FULL anchors this table carries, the two orders happen to commute -- both give ' +
         'post-image 275cb628 and both counts stay 1, because C5a\'s anchor ends in ")" and ' +
         'C5b\'s site does not. So the order is enforced HERE, structurally, and not by any ' +
         'digest divergence. It stays enforced because the commuting is a property of these ' +
         'exact literals, not of the rules: the moment C5a is written any less precisely -- an ' +
         '8-char prefix, a bare digest -- order decides whether the allow list survives.',
    mutate: t => {
      const c = t.edit_classes, a = c.findIndex(x => x.id === 'C5a'), b = c.findIndex(x => x.id === 'C5b');
      [c[a], c[b]] = [c[b], c[a]];
    },
    expect: /C5a MUST precede C5b/,
  },
  {
    name: 'an expected occurrence count edited away from the measurement',
    why: 'C4 says 3 in each of the two functions because 3 was measured in each. Lowered to 2 on ' +
         'BOTH sides it still passes the symmetry rule, so only the independent measurement can ' +
         'catch it -- and it must, or one segment boundary stays at 89 and the rule half-applies.',
    mutate: t => {
      const e = t.edit_classes.find(x => x.id === 'C4').expected_occurrences;
      e.reserve_gate = 2; e.reserve_execution_budget = 2;
    },
    expect: /C4 expects 2 occurrence\(s\) in reserve_gate, but the read-only measurement/,
  },
  {
    name: 'C6 materialised to something that is not a measured 64-hex digest',
    why: 'the root-object digest must be MEASURED after the root7 registration, and must not be ' +
         'confused with the registration body canonicalDigest.',
    mutate: t => { t.edit_classes.find(x => x.id === 'C6').to = 'a93bfdda'; },
    expect: /C6\.to is neither the sentinel/,
  },
];

function discriminate(table) {
  let bad = 0;
  console.log('discriminators — each must make the generator refuse\n');
  for (const d of DISCRIMINATORS) {
    const t = JSON.parse(JSON.stringify(table));
    d.mutate(t);
    let msg = null;
    try { build(t); } catch (e) { if (!(e instanceof Refused)) throw e; msg = e.message; }
    const ok = msg !== null && d.expect.test(msg);
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${d.name}`);
    console.log(`        ${d.why}`);
    console.log(`        ${msg === null ? 'GENERATOR ACCEPTED IT — the discriminator cannot fail, so it proves nothing'
                                        : (ok ? 'refused: ' : 'refused for the WRONG reason: ') + msg.split('\n')[0]}`);
    console.log('');
  }
  // The unmutated table must still build, or every PASS above is meaningless.
  try { build(table); } catch (e) { bad++; console.log(`  FAIL  the unmutated table no longer builds: ${e.message}`); }
  console.log(bad === 0
    ? `all ${DISCRIMINATORS.length} discriminators failed as required, and the unmutated table still builds`
    : `${bad} discriminator(s) did not behave as required`);
  return bad;
}

// ---- main -------------------------------------------------------------------------------------

const table = JSON.parse(fs.readFileSync(path.join(HERE, 'cp02-substitutions.json'), 'utf8'));

if (process.argv.includes('--discriminate')) {
  process.exit(discriminate(table) === 0 ? 0 : 1);
}

let out;
try {
  out = build(table);
} catch (e) {
  if (!(e instanceof Refused)) throw e;
  console.error('REFUSED: ' + e.message);
  process.exit(1);
}

const applyName = out.draft ? 'cp02-apply.DRAFT.sql' : 'cp02-apply.candidate.sql';
// The runnable filename must never exist while the file is a draft, and a stale one from an
// earlier state must not survive a regeneration that went back to draft.
const other = out.draft ? 'cp02-apply.candidate.sql' : 'cp02-apply.DRAFT.sql';
if (fs.existsSync(path.join(HERE, other))) fs.rmSync(path.join(HERE, other));

fs.writeFileSync(path.join(HERE, 'cp02-derive.sql'), out.derive);
fs.writeFileSync(path.join(HERE, applyName), out.apply);

console.log(`7 rules validated across ${out.fns.length} functions ` +
            `(${out.fns[0].edits.length} rule-steps each, zero-expectation steps included):`);
for (const fn of out.fns)
  console.log(`  ${fn.function.padEnd(52)} ${fn.edits.filter(e => e.expected_count > 0).length} matching, ` +
              `${fn.edits.reduce((a, e) => a + e.expected_count, 0)} occurrences`);
console.log(`\nwrote cp02-derive.sql   ${fs.statSync(path.join(HERE, 'cp02-derive.sql')).size} bytes`);
console.log(`wrote ${applyName.padEnd(17)} ${fs.statSync(path.join(HERE, applyName)).size} bytes`);

if (out.draft) {
  console.log(`\nEMITTED AS A DRAFT — NOT FOR EXECUTION. No runnable candidate file was written.`);
  console.log(`Blocking:`);
  for (const x of out.sentinels) console.log(`  unresolved sentinel          ${x}`);
  for (const s of out.missing)   console.log(`  post-image digest unpinned   ${SIG[s]}`);
  for (const f of out.findings)  console.log(`  open finding                 ${f.id}  ${f.title}`);
  console.log(`\nOrder, per the M3 carrier: NW-02 -> root7 REGISTERED -> 21st binding forward ->`);
  console.log(`measure C6 (sha256(r::text) over the whole root row, NOT the registration body's`);
  console.log(`canonicalDigest) and re-measure both R11 guard values -> re-run cp02-derive.sql`);
  console.log(`read-only -> pin POSTIMAGE from that run -> regenerate -> independent review.`);
}
