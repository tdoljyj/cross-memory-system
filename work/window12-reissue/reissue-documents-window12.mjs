// Re-issues the nine signed documents that pin the window12-era controller digest 68133f2d or the
// root6 Owner window 2026-09-12/13T07:05:16Z, against the F12 controller and a real root7 window.
//
// Lineage: work/twentieth-forward/reissue-seven-documents.mjs (window11, six documents against
// root6-runtime-v17 -> v18). That script's METHOD is reused -- measure the reference graph from the
// files, process in dependency order, feed each new digest to the documents downstream, advance the
// version chain by exactly one generation, refuse if any superseded value survives. Its CONSTANTS
// and several of its shape assumptions do not survive the change of pin set, and every one of the
// differences below was measured on this tree rather than carried over:
//
//  1. BASE BYTES COME FROM GIT, NOT THE WORKING TREE. The window11 script read the repository
//     working copy. On this branch two of the nine live documents exist only as STALE work copies:
//     QUAL is 6e35ff20 here but e7cfb30b on main@M2, and RTA is 775fd644 here but fb389314 on
//     main@M2 (R31-F1: 6e35ff20 is exactly the object R30 mis-measured, and the stale RTA carries
//     \u escapes that fail the admin parser). Every base is therefore read with `git cat-file` at
//     BASE_REV and byte-asserted, and the two stale digests are refused BY NAME (negative control
//     NC5) rather than merely "not matching".
//  2. NO CONTROLLER-DIRECTORY RENAME. window11 moved control-context-verifier-root6-window10 ->
//     -window11 and substituted the directory string. F12 is realized IN PLACE in
//     control-context-verifier-root6-linux-successor (work/f12/realize-f12.mjs:19 writes to that
//     same DIR), so there is no directory substitution row. Adding one would be a silent no-op.
//  3. NO RUNTIME-DIRECTORY SUBSTITUTION EITHER. `root6-runtime-v19` occurs exactly once in QUAL and
//     once in RTA, both at `superseded_draft_replaced_here.path`, whose state literal is
//     SUPERSEDED_DRAFT_AT_THIS_SAME_PATH_...: it records a draft that really did live at the v19
//     path and was overwritten there. Rewriting it to v20 would relocate a historical fact. The
//     move is expressed by the output path alone (doc.moveTo), never by string substitution.
//  4. TWO NEW SUBSTITUTION ROWS THAT window11 DID NOT HAVE.
//     - generation ctrgen_5e0440a9 (root6) -> ctrgen_26769cc7 (root7), measured in 5 of the 9.
//       window11 did not need it because the generation did not change then; window12 registers
//       root7 (plan v2 pin 4 / F12PinInventory :15).
//     - status-manifest schema sha256 510f3b90 -> 7e5df5dd, measured in 4 of the 9 (5 sites). This
//       is the fourth parameter <newStatusManifestSchemaSha256>; 7e5df5dd is the M3 Round-1 value
//       re-measured here against the F12 pre-image tree.
//  5. FOUR LINEAGE FAMILIES, NOT THREE. window11 knew pathRef / uriRef / reissue{object}. Measured
//     here, the 160-series approvals carry `reissue.supersedes` as a BARE FILENAME STRING pointing
//     at a DIFFERENT document (the 4000000 approval of the same generation), and their
//     `substance_unchanged` is a paragraph of prose, not a boolean. Running window11's reissue
//     writer over them would replace a string with an object and a paragraph with `false`. They are
//     classified 'reissueStr' and asserted to be a NO-OP under in-place rewrite instead.
//  6. PER-DOCUMENT TIMESTAMP PRECISION IS PRESERVED. window11 stamped every document with a
//     millisecond ISO string. Four of these nine carry second-precision stamps; the new stamp is
//     rendered at each document's own measured precision.
//  7. THE ORDER IS RE-MEASURED. window11's order was QUAL, PROP -> APPR -> APPL -> REPR -> RTA with
//     QUAL at the head. Measured here, QUAL REFERENCES the 160 capacity proposal, so QUAL is no
//     longer a source of the graph. The order is computed by Kahn's algorithm from digests actually
//     found in the base bytes and then checked against RECORDED_ORDER, so a change in the graph is
//     loud rather than silently absorbed.
//
// THE THREE ADJUDICATIONS THE ACCEPTANCE DOCUMENT MUST GET RIGHT IN ONE PASS (R29/R30/R31):
//   E1  late_bound_fields.status_manifest_ref.signed_payload_sha256 -> the Status24 payload digest.
//       Pending: S24 needs M3's T and the root7 registration, so a sentinel is written.
//   E2  expected_ga.authority_source_ref.sha256 -> canonicalDigest(root7 registration body).
//       R31 addendum B proved the two-sided trap by row: context.mjs:37 forces GA to deep-equal
//       expected_ga, and :322 forces GA's value to equal canonicalDigest(the live root). Under
//       root7 the live root is the root7 body, so the pending sentinel is the CP-02 one that names
//       exactly that measurement. The uri is a ctr_ root-set urn and does NOT change.
//   E3  expected_ga.issuer_ref -> the new GATE issuer qualification document. NOTE, AND READ THIS
//       BEFORE ACCEPTING E3: the task sheet for this session said "issuer_ref = the new STATUS
//       issuer document". Measured, that is wrong FOR THIS FIELD. context.mjs:320 constrains
//       `result.ga.issuer_ref` only inside `if (purpose === 'GATE_AUTHORIZATION')`, against that
//       purpose's binding; the STATUS issuer document is bound at :341 to `sm.issuer_ref`, i.e. the
//       Status24 PAYLOAD's issuer_ref, a different object in a different file. The live bytes agree:
//       expected_ga.issuer_ref is blob 3ae8bd41 / sha256 80cf8f47, and blob 3ae8bd41 declares
//       accepted_issuer_purposes GATE_AUTHORIZATION + GATE_RESULT, while the STATUS document is
//       blob c1749399 / sha256 16409958. R31's v2 map says "载荷 issuer_ref" -- payload, not
//       acceptance. This script writes the GATE sentinel and says so in the report; if a reviewer
//       still wants STATUS here, that is a decision to take against context.mjs:320, not a typo fix.
//   R31 addendum A  expected_ga.stage_receipt_refs keeps its DUPLICATE entry ([2] === [3], blob
//       31c4574a). context.mjs:81 asserts length === 6 (EXACT_STAGE_INPUTS). De-duplicating gives 5
//       and detonates. Negative control NC4 de-duplicates on purpose and requires the refusal.
//
// Every context.mjs line number cited above was checked to be the same in the M2 tree and in the
// F12 pre-image on this branch (the pre-image edits 10 lines in place, none of them shifting).
//
// Usage:
//   node reissue-documents-window12.mjs <newNotBeforeZ> <newExpiryZ> <newControllerSha256> \
//        [<newStatusManifestSchemaSha256>] [--out <dir>] [--dry-run] [--runtime-dir <repo-rel dir>]
//   node reissue-documents-window12.mjs --selftest      # runs a dry run plus six negative controls
//
// STATE: writes candidate files only. No Supabase write, no append_event, no reservation, no merge.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blobSha = b => {
  if (!Buffer.isBuffer(b)) throw Error('blobSha_REQUIRES_A_BUFFER_NOT_A_STRING');
  return crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
};

// ---------------------------------------------------------------- measured constants
// BASE_REV is main at M2. `git rev-parse 88fc944b` -> the full sha below; it is the merge of PR #163
// and the revision on which the live bindings were measured (R31 header: fb389314 / e7cfb30b /
// 68133f2d).
const BASE_REV = '88fc944b1a2b8530478763224dc0209fa1732785';
const A = 'artifacts/clued-validation/phase2-entry-preparation-20260908';
const CTRL_DIR = 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor';
const RUNTIME_V19 = `${A}/bootstrap/root6-runtime-v19`;
const DEFAULT_RUNTIME_NEXT = `${A}/bootstrap/root7-runtime-v20`;

const OLD = {
  // sha256 / git blob of CTRL_DIR/ControllerSourceManifest.candidate.json at BASE_REV.
  ctrlSha:    '68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a',
  ctrlBlob:   '6844a6ed82d5577dd79e374e6280acc51f06a26a',
  notBefore:  '2026-09-12T07:05:16Z',
  expiry:     '2026-09-13T07:05:16Z',
  generation: 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b',
  // sha256 of CTRL_DIR/status-manifest.root5.schema.json at BASE_REV (the F12 pre-image raises it
  // to 7e5df5dd because the schema pins the generation).
  schemaSha:  '510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef',
};
const ROOT7_GENERATION = 'ctrgen_26769cc7109ced40bc4016b2af678198';   // F12PinInventory, already minted, burnt at registration
const DEFAULT_NEW_SCHEMA_SHA = '7e5df5dd2b2341fe38c7b2a86ef68542700ee878bec0c947b13d7c8311fecd2d';

// Sentinels. Names are taken from the sets already in use in work/f12/ and next-window-m3/; only
// PENDING_STATUS24_PAYLOAD_SHA256 is new, because no existing sentinel names that value (flagged in
// Window12ReissueNotes.md section "拿不准").
const PENDING = {
  status24:      '__PENDING_STATUS24_PAYLOAD_SHA256__',
  // NOT the CP02 sentinel: context.mjs:322 needs canonicalDigest(registration body) -- the
  // a93bfdda class -- while CP02's G8/B9 pin sha256(r::text) over the whole root row (the
  // 72355efd class). Same moment of measurement, different value; distinct names so neither
  // can be realized with the other's number.
  rootDigest:    '__PENDING_ROOT7_REGISTRATION_BODY_CANONICAL_SHA256__',
  issuerGateUri: '__PENDING_ROOT7_ISSUER_GATE_QUALIFICATION_URI__',
  issuerGateSha: '__PENDING_ROOT7_ISSUER_GATE_QUALIFICATION_SHA256__',
};

// Working copies on this branch that must never be used as a base (R31-F1).
const STALE_REFUSED = {
  '6e35ff20996e3c622e8915cdbc80a39ef78b222bcc99a5e09e73ea680f844df3':
    'QUAL stale work copy: the object R30 mis-measured as the live controller_qualification_ref',
  '775fd6446a4594f0d61258c968bd3a6cba8dfc0adc1df342f3bf143aa60597db':
    'RTA stale work copy: carries \\u escapes that fail ADMIN_JSON_UNIQUE_CANONICAL_VALUES',
};

// The nine. base = sha256 of the bytes at BASE_REV; stampCount / root6WindowCount are the measured
// occurrence counts each substitution must reproduce exactly.
//   lineage: 'pathRef'    supersedes/supersedes_chain of {path, sha256, bytes, blob_sha}
//            'uriRef'     supersedes/supersedes_chain of {uri, sha256}
//            'reissueObj' reissue.supersedes {path, sha256, bytes, blob_sha, owner_merge}
//            'reissueStr' reissue.supersedes is a bare filename naming ANOTHER document
//            'none'       no lineage node
const DOCS = [
  {id: 'PROP160', p: `${A}/root6-capacity/Root6LinuxController160SourceRefCapacityProposal20260913.json`,
   stamp: '2026-09-12T23:37:12Z', stampCount: 1, root6WindowCount: 0, lineage: 'none'},
  {id: 'PROP4M', p: `${A}/root6-capacity/Root6OriginalInput4000000CapacityProposal20260912.json`,
   stamp: '2026-09-12T07:09:18.112Z', stampCount: 1, root6WindowCount: 0, lineage: 'none'},
  {id: 'APPR4M', p: `${A}/root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.v2.json`,
   stamp: '2026-09-12T07:09:18.112Z', stampCount: 1, root6WindowCount: 1, lineage: 'reissueObj'},
  {id: 'APPR160v1', p: `${A}/root6-capacity/Root6LinuxController160SourceRefApproval20260913.json`,
   stamp: '2026-09-12T23:41:49Z', stampCount: 1, root6WindowCount: 2, lineage: 'reissueStr'},
  {id: 'APPR160v2', p: `${A}/root6-capacity/Root6LinuxController160SourceRefApproval20260913.v2.json`,
   stamp: '2026-09-12T23:41:49Z', stampCount: 1, root6WindowCount: 2, lineage: 'reissueStr'},
  {id: 'APPL', p: `${A}/root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json`,
   stamp: '2026-09-13T02:15:38.154Z', stampCount: 1, root6WindowCount: 0, lineage: 'uriRef'},
  {id: 'REPR043', p: `${A}/root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json`,
   stamp: '2026-09-13T02:15:38.154Z', stampCount: 1, root6WindowCount: 0, lineage: 'uriRef'},
  {id: 'QUAL', p: `${RUNTIME_V19}/ScopedRoot5FinalControllerQualification.json`,
   stamp: '2026-09-13T00:47:00.000Z', stampCount: 2, root6WindowCount: 0, lineage: 'pathRef', move: true},
  {id: 'RTA', p: `${RUNTIME_V19}/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`,
   stamp: '2026-09-13T02:38:53.099Z', stampCount: 3, root6WindowCount: 1, lineage: 'pathRef', move: true},
];
// Measured base digests, kept apart from the table so the table stays readable.
// The authoritative base digests, measured with
//   git cat-file -p 88fc944b:<path> | sha256sum
const BASE_SHA = {
  PROP160:   'e224c379718a',
  PROP4M:    '40317abfd8f1',
  APPR4M:    'b69b793fbe0c',
  APPR160v1: 'd3a90e311d4a',
  APPR160v2: 'bc541370c238',
  APPL:      'e7ec06c28bc9',
  REPR043:   'd3f643b4a9d7',
  QUAL:      'e7cfb30b1d62',
  RTA:       'fb3893147d48',
};
// Order measured from the reference graph, then pinned. Any drift must be explained, not absorbed.
const RECORDED_ORDER = ['PROP160', 'PROP4M', 'APPR4M', 'APPR160v1', 'APPR160v2', 'APPL', 'REPR043', 'QUAL', 'RTA'];

// Per-document declared rule sets. Every rule listed here MUST fire, and no changed path may be
// left unexplained by one of them. This is the "declare the change set per document" discipline of
// work/f12/verify-issuer-candidates.mjs, applied to a nine-document cascade.
const DECLARED = {
  PROP160:   ['subst', 'stamp'],
  PROP4M:    ['subst', 'stamp'],
  APPR4M:    ['subst', 'stamp', 'lineage'],
  APPR160v1: ['subst', 'stamp'],
  APPR160v2: ['subst', 'stamp'],
  APPL:      ['subst', 'stamp', 'lineage'],
  REPR043:   ['subst', 'stamp', 'lineage'],
  QUAL:      ['subst', 'stamp', 'lineage'],
  RTA:       ['subst', 'stamp', 'lineage', 'atomic'],
};
// RTA-only atomic edits, by exact JSON path.
const ATOMIC_RTA = {
  'accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256': PENDING.status24,
  'accepted_subject.expected_ga.authority_source_ref.sha256':                     PENDING.rootDigest,
  'accepted_subject.expected_ga.issuer_ref.uri':                                  PENDING.issuerGateUri,
  'accepted_subject.expected_ga.issuer_ref.sha256':                               PENDING.issuerGateSha,
};
// The value E4 must already hold. R31-F1 turned this from an edit into an assertion: the live bytes
// already point at the live QUAL, so the cascade alone must carry it. Kept as a named check so a
// regression to the 6e35ff20 shape is caught rather than silently repaired.
const E4_QUAL_SHA_BEFORE = 'e7cfb30b1d6241ad8b0a9976ae8a44d2b6fadd429f2f95bcf523c20fbe912888';

// ---------------------------------------------------------------- helpers
const gitBytes = (rev, p) => execFileSync('git', ['-C', REPO, 'cat-file', '-p', rev + ':' + p], {maxBuffer: 1 << 28});
// Measured, never assumed: these nine are NOT uniformly formatted. RTA is indent-1 with a trailing
// LF; QUAL is indent-1 with NO trailing LF; the seven capacity documents are indent-2 with a
// trailing LF. The window11 script asserted indent-2-plus-LF for all six of its documents and would
// refuse eight of these nine outright. Re-serialising at the wrong shape would rewrite every byte
// of a signed object for no reason, so both dimensions are captured and reproduced.
const shapeOf = buf => {
  const t = buf.toString('utf8');
  for (const n of [1, 2, 3, 4]) for (const lf of [true, false])
    if (JSON.stringify(JSON.parse(t), null, n) + (lf ? '\n' : '') === t) return {indent: n, lf};
  return null;
};
const diffPaths = (a, b, prefix = '', out = []) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const p = prefix ? prefix + '.' + k : k;
    const va = a?.[k], vb = b?.[k];
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va) && !Array.isArray(vb)) diffPaths(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push([p, va, vb]);
  }
  return out;
};
const countOf = (hay, needle) => hay.split(needle).length - 1;
const stampAt = (oldStamp, when) => {
  const iso = when.toISOString();
  return /\.\d{3}Z$/.test(oldStamp) ? iso : iso.replace(/\.\d{3}Z$/, 'Z');
};

// ---------------------------------------------------------------- the generator
export function reissue(opts) {
  const {
    newNotBefore, newExpiry, newCtrlSha, newSchemaSha = DEFAULT_NEW_SCHEMA_SHA,
    outRoot, dryRun = false, runtimeNext = DEFAULT_RUNTIME_NEXT,
    // Deterministic by default: the acceptance stamp is T, the window's not_before, so two runs
    // with the same inputs produce byte-identical documents and the reviewed bytes are pinnable.
    // Wall-clock stamping (the original default) made every rerun cascade new digests through the
    // whole dependency chain via accepted_at -- measured: two consecutive runs differed only in
    // accepted_at milliseconds and everything downstream of it. --stamp overrides deliberately.
    now = new Date(Date.parse(opts.newNotBefore)),
    // fault injection, used only by --selftest
    fault = {},
  } = opts;

  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  assert.match(newNotBefore ?? '', ISO, 'USAGE: <newNotBeforeZ> <newExpiryZ> <newControllerSha256> [<newStatusManifestSchemaSha256>]');
  assert.match(newExpiry ?? '', ISO, 'USAGE: <newNotBeforeZ> <newExpiryZ> <newControllerSha256> [<newStatusManifestSchemaSha256>]');
  assert.match(newCtrlSha ?? '', /^[a-f0-9]{64}$/, 'NEW_CONTROLLER_SHA256_REQUIRED');
  assert.match(newSchemaSha ?? '', /^[a-f0-9]{64}$/, 'NEW_STATUS_MANIFEST_SCHEMA_SHA256_REQUIRED');
  assert.equal(Date.parse(newExpiry) - Date.parse(newNotBefore), 86400000, 'OWNER_WINDOW_MUST_BE_EXACTLY_86400_SECONDS');
  assert.notEqual(newCtrlSha, OLD.ctrlSha, 'CONTROLLER_DIGEST_DID_NOT_CHANGE');
  assert.notEqual(newSchemaSha, OLD.schemaSha, 'STATUS_MANIFEST_SCHEMA_DIGEST_DID_NOT_CHANGE');
  if (!dryRun) {
    assert.ok(Date.parse(newNotBefore) <= now.getTime() && now.getTime() < Date.parse(newExpiry),
      'DOCUMENTS_MUST_BE_ISSUED_INSIDE_THE_WINDOW_THEY_DECLARE');
  }

  // The F12 controller manifest must already be realized and must hash to what was passed in.
  // In a dry run there is no F12 tree yet, so the digest is taken on trust and marked as fake.
  let newCtrlBlob;
  if (dryRun) {
    newCtrlBlob = crypto.createHash('sha1').update('DRY_RUN_FAKE_CONTROLLER_BLOB:' + newCtrlSha).digest('hex');
  } else {
    const mp = path.join(REPO, CTRL_DIR, 'ControllerSourceManifest.candidate.json');
    assert.ok(fs.existsSync(mp), 'REALIZE_AND_REBUILD_THE_F12_CONTROLLER_FIRST: ' + CTRL_DIR);
    const raw = fs.readFileSync(mp);
    assert.equal(sha(raw), newCtrlSha, 'REBUILT_MANIFEST_DOES_NOT_MATCH_THE_DIGEST_SUPPLIED');
    newCtrlBlob = blobSha(raw);
  }
  assert.notEqual(newCtrlBlob, OLD.ctrlBlob, 'CONTROLLER_BLOB_DID_NOT_CHANGE');

  // ---- load every base from git, byte-assert, and refuse the known stale copies by name
  const base = new Map();
  for (const d of DOCS) {
    const buf = fault.tamper === d.id ? Buffer.concat([gitBytes(BASE_REV, d.p).subarray(0, 20), Buffer.from('X'), gitBytes(BASE_REV, d.p).subarray(21)])
      : fault.staleBase === d.id ? fs.readFileSync(path.join(REPO, d.p))
      : gitBytes(BASE_REV, d.p);
    const s = sha(buf);
    if (STALE_REFUSED[s]) throw Error('STALE_WORKING_COPY_REFUSED[NC5]:' + d.id + ':' + s.slice(0, 12) + ': ' + STALE_REFUSED[s]);
    assert.equal(s.slice(0, 12), BASE_SHA[d.id], 'BASE_BYTES_MISMATCH[NC1]:' + d.id + ': got ' + s.slice(0, 12) + ', pinned ' + BASE_SHA[d.id]);
    const shape = shapeOf(buf);
    assert.ok(shape !== null, 'PREDECESSOR_NOT_PLAIN_INDENT_SERIALISED_REFUSING_TO_REWRITE:' + d.id);
    base.set(d.id, {buf, sha: s, blob: blobSha(buf), bytes: buf.length, indent: shape.indent, lf: shape.lf});
  }

  // ---- measure the reference graph from the bytes, topologically sort, compare to RECORDED_ORDER
  const deps = new Map(DOCS.map(d => [d.id, new Set()]));
  for (const d of DOCS) {
    const t = base.get(d.id).buf.toString('utf8');
    for (const o of DOCS) {
      if (o.id === d.id) continue;
      const b = base.get(o.id);
      if (t.includes(b.sha) || t.includes(b.blob)) deps.get(d.id).add(o.id);
    }
  }
  const order = [];
  {
    const left = DOCS.map(d => d.id);
    while (left.length) {
      const ready = left.filter(id => [...deps.get(id)].every(x => order.includes(x)));
      assert.ok(ready.length, 'REFERENCE_GRAPH_HAS_A_CYCLE: ' + left.join(','));
      order.push(ready[0]);
      left.splice(left.indexOf(ready[0]), 1);
    }
  }
  assert.deepEqual(order, RECORDED_ORDER,
    'DEPENDENCY_ORDER_DRIFTED_FROM_THE_RECORDED_MEASUREMENT: measured ' + order.join(',') +
    ' vs recorded ' + RECORDED_ORDER.join(',') + ' -- re-measure and update RECORDED_ORDER deliberately');
  const runOrder = fault.order ?? order;
  if (fault.omit) runOrder.splice(runOrder.indexOf(fault.omit), 1);

  // ---- substitution table, extended as each document is re-issued
  const table = [
    {what: 'controller sha256',    from: OLD.ctrlSha,    to: newCtrlSha},
    {what: 'controller blob',      from: OLD.ctrlBlob,   to: newCtrlBlob},
    {what: 'window not_before',    from: OLD.notBefore,  to: newNotBefore},
    {what: 'window expires_at',    from: OLD.expiry,     to: newExpiry},
    {what: 'root generation',      from: OLD.generation, to: ROOT7_GENERATION},
    {what: 'status schema sha256', from: OLD.schemaSha,  to: newSchemaSha},
    {what: 'root window prose',    from: 'root6 window', to: 'root7 window'},
  ];
  const applySubs = s => { for (const t of table) s = s.split(t.from).join(t.to); return s; };

  const byId = Object.fromEntries(DOCS.map(d => [d.id, d]));
  const out = new Map();
  const report = [];

  for (const id of runOrder) {
    const doc = byId[id], b = base.get(id);
    // Order guard, first thing and by name: every measured dependency must already carry a NEW
    // digest, or this document would cite a digest that is about to be superseded. A shuffled or
    // truncated order has to fail here, as a stated refusal rather than as a stray TypeError.
    for (const depId of deps.get(id))
      assert.ok(out.has(depId), 'DEPENDENCY_NOT_YET_PROCESSED[NC2/NC3]:' + id + ' depends on ' + depId + ', which has not been re-issued yet');
    const beforeText = b.buf.toString('utf8');
    const stamp = stampAt(doc.stamp, now);

    // --- pass 1: declared string substitutions, each with its measured occurrence count
    let text = beforeText;
    const applied = {};
    for (const t of table) {
      const n = countOf(text, t.from);
      if (n === 0) continue;
      text = text.split(t.from).join(t.to);
      applied[t.what] = n;
    }
    assert.equal(applied['root window prose'] ?? 0, doc.root6WindowCount,
      'ROOT6_WINDOW_PROSE_COUNT_DRIFT:' + id + ': got ' + (applied['root window prose'] ?? 0) + ', measured ' + doc.root6WindowCount);
    {
      const n = countOf(text, doc.stamp);
      assert.equal(n, doc.stampCount, 'ISSUED_AT_COUNT_DRIFT:' + id + ': got ' + n + ', measured ' + doc.stampCount);
      text = text.split(doc.stamp).join(stamp);
      applied['issued_at'] = n;
    }

    // --- pass 2: lineage advances by exactly one generation
    const parsed = JSON.parse(text);
    const pathRef = {path: doc.p, sha256: b.sha, bytes: b.bytes, blob_sha: b.blob};
    const uriRef  = {uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + b.blob, sha256: b.sha};
    if (doc.lineage === 'pathRef' || doc.lineage === 'uriRef') {
      assert.ok(parsed.supersedes && Array.isArray(parsed.supersedes_chain), 'LINEAGE_NODE_ABSENT:' + id);
      const wasPointingAt = JSON.parse(JSON.stringify(parsed.supersedes));
      parsed.supersedes_chain = [parsed.supersedes, ...parsed.supersedes_chain];
      parsed.supersedes = doc.lineage === 'pathRef' ? pathRef : uriRef;
      // The window11 trap, asserted rather than commented: the new supersedes must name THIS
      // document's own base bytes, not the bytes its predecessor named.
      assert.equal(parsed.supersedes.sha256, b.sha, 'LINEAGE_DID_NOT_ADVANCE_TO_THE_CURRENT_DOCUMENT:' + id);
      assert.notEqual(parsed.supersedes.sha256, wasPointingAt.sha256, 'LINEAGE_STILL_POINTS_AT_THE_GRANDPARENT:' + id);
      assert.equal(parsed.supersedes_chain[0].sha256, wasPointingAt.sha256, 'PREDECESSOR_WAS_NOT_PUSHED_ONTO_THE_CHAIN:' + id);
      applied.version_chain = 'supersedes -> ' + b.sha.slice(0, 12) + ', chain depth ' + parsed.supersedes_chain.length;
    } else if (doc.lineage === 'reissueObj') {
      assert.ok(parsed.reissue?.supersedes && typeof parsed.reissue.supersedes === 'object',
        'REISSUE_OBJECT_NODE_ABSENT:' + id);
      const owner = parsed.reissue.supersedes.owner_merge;
      assert.match(owner ?? '', /^[a-f0-9]{40}$/, 'REISSUE_OWNER_MERGE_ABSENT:' + id);
      const wasAt = parsed.reissue.supersedes.sha256;
      // Only the pointer advances. reason / substance_unchanged / what_changed are the Owner's own
      // words about THIS supplement and are left byte-identical -- window11 rewrote them, which is
      // exactly what must not happen when the substance of the decision has not changed.
      parsed.reissue.supersedes = {...pathRef, owner_merge: owner};
      assert.notEqual(parsed.reissue.supersedes.sha256, wasAt, 'REISSUE_LINEAGE_STILL_POINTS_AT_THE_GRANDPARENT:' + id);
      applied.version_chain = 'reissue.supersedes -> ' + b.sha.slice(0, 12);
    } else if (doc.lineage === 'reissueStr') {
      // Measured no-op. The pointer is a bare filename naming ANOTHER document, and that document
      // is rewritten in place under the same name, so there is nothing to advance. Asserting the
      // shape keeps a future schema change from slipping through as silence.
      assert.equal(typeof parsed.reissue?.supersedes, 'string', 'REISSUE_STRING_NODE_SHAPE_CHANGED:' + id);
      assert.equal(parsed.reissue.supersedes, JSON.parse(beforeText).reissue.supersedes, 'REISSUE_STRING_NODE_WAS_MODIFIED:' + id);
      // The name must resolve to a real sibling at BASE_REV. Measured, the two 160-series
      // supplements point at DIFFERENT generations of the 4000000 approval: v1 -> the pre-v2
      // approval, which is NOT in the re-issue set (window11 left it byte-identical and this window
      // does the same -- it pins neither the controller digest nor the window); v2 -> APPR4M, which
      // IS re-issued, in place, under the same name. Both pointers are therefore invariant, and
      // which of the two cases holds is recorded rather than assumed.
      const named = path.posix.join(path.posix.dirname(doc.p), parsed.reissue.supersedes);
      try { gitBytes(BASE_REV, named); }
      catch { throw Error('REISSUE_STRING_NAMES_A_FILE_ABSENT_AT_BASE_REV:' + id + ':' + named); }
      const inSet = DOCS.some(o => o.p === named);
      applied.version_chain = 'reissue.supersedes is a cross-document filename (' + parsed.reissue.supersedes +
        ', ' + (inSet ? 'in the re-issue set, rewritten in place' : 'outside the re-issue set, untouched') +
        ') -- invariant either way, asserted no-op';
    }

    // --- pass 3: the acceptance document's three adjudications, applied atomically
    if (id === 'RTA') {
      const ga = parsed.accepted_subject.expected_ga;
      // E4 first: R31-F1 says this must ALREADY be the live QUAL, carried here by the cascade.
      assert.equal(base.get('QUAL').sha, E4_QUAL_SHA_BEFORE, 'E4_BASE_QUAL_IS_NOT_THE_LIVE_ONE');
      assert.equal(ga.controller_qualification_ref.sha256, out.get('QUAL').sha,
        'E4_CONTROLLER_QUALIFICATION_REF_WAS_NOT_CARRIED_BY_THE_CASCADE');
      for (const [p, v] of Object.entries(ATOMIC_RTA)) {
        const keys = p.split('.');
        let node = parsed;
        for (const k of keys.slice(0, -1)) node = node[k];
        assert.ok(node && Object.hasOwn(node, keys.at(-1)), 'ATOMIC_EDIT_PATH_ABSENT:' + p);
        node[keys.at(-1)] = v;
      }
      // R31 addendum A. Never de-duplicate: context.mjs:81 wants exactly six.
      const sr = fault.dedupeStageReceipts ? [...new Map(ga.stage_receipt_refs.map(r => [JSON.stringify(r), r])).values()] : ga.stage_receipt_refs;
      parsed.accepted_subject.expected_ga.stage_receipt_refs = sr;
      assert.equal(sr.length, 6, 'EXACT_STAGE_INPUTS_WOULD_FAIL[NC4]: stage_receipt_refs must stay 6 (context.mjs:81), got ' + sr.length);
      assert.equal(JSON.stringify(sr[2]), JSON.stringify(sr[3]), 'STAGE_RECEIPT_DUPLICATE_WAS_NOT_PRESERVED[NC4]');
      applied.adjudications = 'E1 late_bound->S24 sentinel, E2 authority_source_ref->root7 sentinel, E3 issuer_ref->GATE sentinel, E4 asserted no-op, stage_receipt_refs 6 kept (dup [2]==[3])';
    }

    // Fault injection for NC7: a change that no declared rule can account for. It is applied here,
    // after every legitimate edit, so it exercises the declaration check in pass 5 and nothing else.
    if (fault.smuggle === id) parsed.schema_version = 999;

    // --- serialise at the document's own measured indent
    text = JSON.stringify(parsed, null, b.indent) + (b.lf ? '\n' : '');
    JSON.parse(text);
    // Round-trip proof that the shape really is this document's own: re-serialising the UNCHANGED
    // base at the same shape must reproduce the base bytes exactly.
    assert.equal(JSON.stringify(JSON.parse(beforeText), null, b.indent) + (b.lf ? '\n' : ''), beforeText,
      'SHAPE_ROUND_TRIP_FAILED_REFUSING_TO_REWRITE:' + id);

    // --- pass 4: nothing superseded may survive, outside the one narration exemption
    {
      const probe = JSON.parse(text);
      const narrations = [];
      if (probe.reissue?.reason) { narrations.push('reissue.reason'); probe.reissue.reason = ''; }
      if (probe.reissue?.what_changed) { narrations.push('reissue.what_changed'); probe.reissue.what_changed = ''; }
      if (probe.reissue?.substance_unchanged && typeof probe.reissue.substance_unchanged === 'string') { narrations.push('reissue.substance_unchanged'); probe.reissue.substance_unchanged = ''; }
      // The lineage nodes legitimately name the superseded bytes; that is their whole job.
      delete probe.supersedes; delete probe.supersedes_chain;
      if (probe.reissue) delete probe.reissue.supersedes;
      delete probe.superseded_draft_replaced_here;
      const probeText = JSON.stringify(probe);
      for (const t of table) assert.equal(countOf(probeText, t.from), 0, 'SUPERSEDED_VALUE_SURVIVED:' + id + ':' + t.what);
      assert.equal(countOf(probeText, doc.stamp), 0, 'OLD_ISSUED_AT_SURVIVED:' + id);
      // Every digest of an already re-issued document must be gone too: this is the cascade check,
      // and it is what a shuffled order (NC2) or a missing document (NC3) trips.
      for (const doneId of out.keys()) {
        const o = base.get(doneId);
        assert.equal(countOf(probeText, o.sha), 0, 'SUPERSEDED_UPSTREAM_SHA256_SURVIVED[NC2/NC3]:' + id + ' still cites ' + doneId);
        assert.equal(countOf(probeText, o.blob), 0, 'SUPERSEDED_UPSTREAM_BLOB_SURVIVED[NC2/NC3]:' + id + ' still cites ' + doneId);
      }
      // And every measured dependency must have been fed in: its NEW digest has to be present.
      for (const depId of deps.get(id)) {
        assert.ok(countOf(probeText, out.get(depId).sha) > 0 || countOf(probeText, out.get(depId).blob) > 0,
          'DEPENDENCY_DIGEST_NOT_FED_IN[NC2]:' + id + ' <- ' + depId);
      }
      if (narrations.length) applied.narration_exempt = narrations.join(', ');
    }

    // --- pass 5: every changed JSON path must be explained by a declared rule, and every declared
    //     rule must have fired. Nothing else may differ from the base document.
    {
      const oldDoc = JSON.parse(beforeText), newDoc = JSON.parse(text);
      const fired = new Set();
      const unexplained = [];
      for (const [p, oldV, newV] of diffPaths(oldDoc, newDoc)) {
        const top = p.split('.')[0];
        if (top === 'supersedes' || top === 'supersedes_chain' || p.startsWith('reissue.supersedes')) { fired.add('lineage'); continue; }
        if (id === 'RTA' && Object.hasOwn(ATOMIC_RTA, p)) {
          assert.equal(newV, ATOMIC_RTA[p], 'ATOMIC_EDIT_WROTE_THE_WRONG_VALUE:' + p);
          fired.add('atomic'); continue;
        }
        const os_ = JSON.stringify(oldV), ns_ = JSON.stringify(newV);
        if (os_ !== undefined && applySubs(os_) === ns_ && os_ !== ns_) { fired.add('subst'); continue; }
        if (os_ !== undefined && applySubs(os_).split(doc.stamp).join(stamp) === ns_) { fired.add('stamp'); continue; }
        unexplained.push(p + ': ' + (os_ ?? '').slice(0, 80) + ' -> ' + (ns_ ?? '').slice(0, 80));
      }
      assert.equal(unexplained.length, 0, 'UNDECLARED_CHANGE[NC7]:' + id + ':\n  ' + unexplained.join('\n  '));
      for (const rule of DECLARED[id]) assert.ok(fired.has(rule), 'DECLARED_RULE_DID_NOT_FIRE:' + id + ':' + rule);
      for (const rule of fired) assert.ok(DECLARED[id].includes(rule), 'UNDECLARED_RULE_FIRED:' + id + ':' + rule);
      applied.declared_rules = [...fired].sort().join(', ');
    }

    const after = Buffer.from(text, 'utf8');
    assert.notEqual(sha(after), b.sha, 'DOCUMENT_DID_NOT_CHANGE:' + id);
    const relOut = doc.move ? path.posix.join(runtimeNext, path.posix.basename(doc.p)) : doc.p;
    const abs = path.join(outRoot, relOut);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs, after);

    const rec = {sha: sha(after), blob: blobSha(after), bytes: after.length, relOut};
    out.set(id, rec);
    // Downstream documents cite this one by both digests.
    table.push({what: id + ' sha256', from: b.sha,  to: rec.sha});
    table.push({what: id + ' blob',   from: b.blob, to: rec.blob});

    report.push({
      id, from: doc.p, to: relOut, moved: Boolean(doc.move), lineage: doc.lineage,
      serialisation: {indent: b.indent, trailing_lf: b.lf},
      depends_on: [...deps.get(id)],
      bytes: {before: b.bytes, after: after.length},
      sha256: {before: b.sha, after: rec.sha},
      blob_sha1: {before: b.blob, after: rec.blob},
      changes: applied,
    });
  }

  return {
    state: dryRun ? 'DRY_RUN_CANDIDATES_ONLY_NO_AUTHORITY' : 'DOCUMENTS_REISSUED_NOT_MERGED_NO_AUTHORITY',
    base_revision: BASE_REV,
    output_root: outRoot,
    window: {not_before: newNotBefore, expires_at: newExpiry, duration_seconds: 86400},
    issued_at_utc: now.toISOString(),
    controller: {sha256: {before: OLD.ctrlSha, after: newCtrlSha}, blob_sha1: {before: OLD.ctrlBlob, after: newCtrlBlob}, dir: CTRL_DIR, dir_renamed: false},
    generation: {before: OLD.generation, after: ROOT7_GENERATION},
    status_manifest_schema: {before: OLD.schemaSha, after: newSchemaSha},
    dependency_order: order,
    documents: report,
    pending_sentinels: PENDING,
    byte_budget_note: {
      // The only measured byte cap nearby is context.mjs:39 BOUNDED_STATUS_JSON, and it bounds the
      // STATUS MANIFEST json at 131072, not this acceptance document. R31 recorded its repin
      // candidate at 129006 bytes "against the :39 cap"; that pairing is not reproduced here, so
      // the acceptance size is reported rather than asserted against a limit this script cannot
      // find. Anyone adding known_open entries should establish the real cap first.
      acceptance_bytes: (report.find(r => r.id === 'RTA') ?? {}).bytes,
      measured_cap_found_for_acceptance: null,
      status_manifest_cap_bytes: 131072,
    },
    authority_effect: 'NONE_UNTIL_VERIFIED_OWNER_MERGE',
  };
}

// ---------------------------------------------------------------- self-test / negative controls
function selftest() {
  const FAKE_CTRL = sha(Buffer.from('DRY_RUN_FAKE_F12_CONTROLLER'));
  const FAKE_SCHEMA = sha(Buffer.from('DRY_RUN_FAKE_STATUS_MANIFEST_SCHEMA'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w12-reissue-'));
  const common = {
    newNotBefore: '2026-09-14T09:00:00Z', newExpiry: '2026-09-15T09:00:00Z',
    newCtrlSha: FAKE_CTRL, newSchemaSha: FAKE_SCHEMA, dryRun: true,
    now: new Date('2026-09-14T09:30:00.000Z'),
  };
  const run = (extra, sub) => reissue({...common, ...extra, outRoot: fs.mkdtempSync(path.join(dir, (sub ?? 'run') + '-'))});

  const ok = run({});
  assert.equal(ok.documents.length, 9, 'DRY_RUN_DID_NOT_PRODUCE_NINE_DOCUMENTS');

  const NEG = [
    ['NC1 one tampered base byte',        {fault: {tamper: 'APPL'}},                    /BASE_BYTES_MISMATCH/],
    ['NC2 shuffled dependency order',     {fault: {order: [...RECORDED_ORDER].reverse()}}, /^DEPENDENCY_NOT_YET_PROCESSED/],
    ['NC3 one document omitted',          {fault: {omit: 'APPL'}},                      /^DEPENDENCY_NOT_YET_PROCESSED/],
    ['NC4 stage_receipt_refs deduped',    {fault: {dedupeStageReceipts: true}},         /EXACT_STAGE_INPUTS_WOULD_FAIL/],
    ['NC5 stale branch work copy as base',{fault: {staleBase: 'RTA'}},                  /STALE_WORKING_COPY_REFUSED/],
    ['NC6 schema digest left unchanged',  {newSchemaSha: OLD.schemaSha},                /STATUS_MANIFEST_SCHEMA_DIGEST_DID_NOT_CHANGE/],
    ['NC7 an undeclared field change',    {fault: {smuggle: 'QUAL'}},                   /^UNDECLARED_CHANGE/],
  ];
  const results = [];
  for (const [name, extra, want] of NEG) {
    let threw = null;
    try { run(extra, 'neg'); } catch (e) { threw = e; }
    if (!threw) { console.error('DISCRIMINATOR_DID_NOT_FIRE: ' + name + ' -- the bad variant was accepted'); process.exitCode = 1; results.push([name, 'ACCEPTED_BAD_VARIANT']); continue; }
    const msg = String(threw.message ?? threw);
    if (!want.test(msg)) { console.error('DISCRIMINATOR_FIRED_FOR_THE_WRONG_REASON: ' + name + ' -> ' + msg.split('\n')[0]); process.exitCode = 1; results.push([name, 'WRONG_REASON: ' + msg.split('\n')[0]]); continue; }
    results.push([name, 'refused: ' + msg.split('\n')[0].slice(0, 110)]);
  }
  fs.rmSync(dir, {recursive: true, force: true});
  return {selftest: process.exitCode ? 'FAILED' : 'SELFTEST_PASSED_NOT_A_REISSUE', dry_run: ok, negative_controls: results};
}

// ---------------------------------------------------------------- cli
// Guarded so that `import {reissue}` from a verifier or a later step does not fire the CLI --
// exporting the generator is the point, and an unguarded top-level CLI made the module unusable
// as a library (found by importing it, not by reading it).
const IS_ENTRY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const val = n => { const i = argv.indexOf('--' + n); return i > 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['out', 'runtime-dir'].includes(argv[i - 1].slice(2))));

if (!IS_ENTRY) {
  // imported as a library: export only
} else if (flag('selftest')) {
  console.log(JSON.stringify(selftest(), null, 2));
} else {
  const [nb, ex, ctrl, schema] = positional;
  const dryRun = flag('dry-run');
  const outRoot = val('out') ? path.resolve(val('out'))
    : dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), 'window12-reissue-dryrun-')) : REPO;
  console.log(JSON.stringify(reissue({
    newNotBefore: nb, newExpiry: ex, newCtrlSha: ctrl, newSchemaSha: schema || DEFAULT_NEW_SCHEMA_SHA,
    outRoot, dryRun, runtimeNext: val('runtime-dir') ?? DEFAULT_RUNTIME_NEXT,
    ...(val('stamp') ? {now: new Date(Date.parse(val('stamp')))} : {}),
  }), null, 2));
}
