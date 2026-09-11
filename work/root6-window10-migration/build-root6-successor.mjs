// Builds the root6 successor controller source from the bound root5 one.
//
// Every predecessor directory is left byte-for-byte intact: 26 frozen artifacts pin
// commitment-signing-next-window/signing.mjs by hash, so that file is copied to a new successor
// directory rather than edited in place. The manifest convention in this repo is additive --
// it already carries both commitment-signing/signing.mjs and commitment-signing-next-window/
// signing.mjs -- so predecessor entries are kept and the new files are appended.
//
// Nothing here is signed, accepted, registered or installed. This produces candidate source only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Repo root derived from this file's location (work/root6-window10-migration/), so the build is
// reproducible from any checkout rather than only the machine it was written on.
// fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/Users/...' with a leading
// slash and path.resolve then computes the wrong repository root.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_REL = 'scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor';
const DST_REL = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';
const SIGN_SRC_REL = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-next-window';
const SIGN_DST_REL = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window';
const TG_SRC_REL = 'scripts/phase2-qualification/control-context-verifier-next-window-successor/trusted-github.mjs';

const SRC = path.join(REPO, SRC_REL), DST = path.join(REPO, DST_REL);
const SIGN_SRC = path.join(REPO, SIGN_SRC_REL), SIGN_DST = path.join(REPO, SIGN_DST_REL);
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

// Owner-approved window for root6. context.mjs requires the runtime acceptance expiry to equal
// the registered generation expiry exactly, so this is fixed before anything is written.
const ROOT6_NOT_BEFORE = '2026-09-12T00:00:00Z';
const ROOT6_EXPIRY = '2026-09-13T00:00:00Z';
const ROOT5_GENERATION = 'ctrgen_e5df432221344996afc04b5638121d96';
const OLD_CUTOFF = '2026-09-11T10:21:05Z';

// Derived, not random, so re-running reproduces byte-identical output and a reviewer can confirm
// the id was not chosen to suit anything.
const ROOT6_GENERATION = 'ctrgen_' + sha(
  'clued/root6-generation/v1\n' + ROOT5_GENERATION + '\n' + ROOT6_NOT_BEFORE + '\n' + ROOT6_EXPIRY + '\n'
).slice(0, 32);

// Threshold in the execution-event sequence space from which root6 is the current generation.
// The highest existing sequence is 88 (the nineteenth forward), so >=89 reclassifies nothing and
// every historical budget and attempt keeps resolving to root5Generation/root4Expiry.
// Note this is NOT "the sequence of the first root6 budget": sequence 89 will be the twentieth
// binding forward, and the first root6 budget lands at 90 or later. The constant is only ever
// compared with >=, so it is a lower bound, not an identity.
const ROOT6_BUDGET_SEQUENCE = 89;

// The forward cap. Forwards are counted only at execution sequence >= 45 (after the frozen
// 44-event baseline), and forwards #5..#19 are exactly 15 -- the existing cap. The twentieth
// forward is unavoidable, because root6 produces a new controller_sha256 and new qualification
// and runtime-acceptance hashes that the binding must be forwarded to. Raising this is an
// Owner decision and was authorized; it is recorded here because the cap is a declared
// qualification limit, not an incidental constant.
const OLD_FORWARD_CAP = 15;
const NEW_FORWARD_CAP = 16;

const edits = [];
const editor = (label, text) => {
  let cur = text;
  const apply = (id, from, to) => {
    const n = cur.split(from).length - 1;
    if (n !== 1) throw Error('EXPECTED_EXACTLY_ONE_OCCURRENCE:' + label + ':' + id + ':found=' + n);
    cur = cur.replace(from, to);
    edits.push({ file: label, id });
  };
  const applyAll = (id, from, to, expected) => {
    const n = cur.split(from).length - 1;
    if (n !== expected) throw Error('EXPECTED_' + expected + '_OCCURRENCES:' + label + ':' + id + ':found=' + n);
    cur = cur.split(from).join(to);
    edits.push({ file: label, id, occurrences: n });
  };
  return { apply, applyAll, get: () => cur };
};

// Start clean so the build is idempotent.
fs.rmSync(DST, { recursive: true, force: true });
fs.rmSync(SIGN_DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
fs.mkdirSync(SIGN_DST, { recursive: true });

const added = [];   // brand-new manifest paths
const inDir = [];   // paths repointed from SRC_REL into DST_REL

// ---- 1. signing successor: extend the generation allowlist ----
{
  const e = editor('signing.mjs', fs.readFileSync(path.join(SIGN_SRC, 'signing.mjs'), 'utf8'));
  e.apply('SIGNING_ROOT6_CONSTANT',
    "export const root5Generation='" + ROOT5_GENERATION + "';",
    "export const root5Generation='" + ROOT5_GENERATION + "';\nexport const root6Generation='" + ROOT6_GENERATION + "';");
  // makeCommitment signs both GateAuthorization and GateResultReceipt, so root6 must be admitted
  // or the final GA and GRR cannot be constructed at all.
  e.apply('SIGNING_GENERATION_ALLOWLIST',
    "[rootGeneration,root5Generation].includes(boundRootGeneration)",
    "[rootGeneration,root5Generation,root6Generation].includes(boundRootGeneration)");
  fs.writeFileSync(path.join(SIGN_DST, 'signing.mjs'), e.get());
  added.push(SIGN_DST_REL + '/signing.mjs');
}

// ---- 2. trusted-github successor inside the root6 directory, repointed at the new signing module ----
{
  const e = editor('trusted-github.mjs', fs.readFileSync(path.join(REPO, TG_SRC_REL), 'utf8'));
  e.apply('TRUSTED_GITHUB_SIGNING_IMPORT',
    "'../nonproduction-control-store/runtime-successor/commitment-signing-next-window/signing.mjs'",
    "'../nonproduction-control-store/runtime-successor/commitment-signing-root6-window/signing.mjs'");
  fs.writeFileSync(path.join(DST, 'trusted-github.mjs'), e.get());
  added.push(DST_REL + '/trusted-github.mjs');
}

// ---- 3. copy the 16 predecessor files, repointing their trusted-github imports ----
const OLD_TG_IMPORT = "'../control-context-verifier-next-window-successor/trusted-github.mjs'";
let repointedImports = 0;
for (const f of fs.readdirSync(SRC)) {
  if (f === 'ControllerSourceManifest.candidate.json') continue;
  let buf = fs.readFileSync(path.join(SRC, f));
  if (f.endsWith('.mjs')) {
    const text = buf.toString('utf8');
    if (text.includes(OLD_TG_IMPORT)) {
      buf = Buffer.from(text.split(OLD_TG_IMPORT).join("'./trusted-github.mjs'"), 'utf8');
      repointedImports++;
      edits.push({ file: f, id: 'TRUSTED_GITHUB_IMPORT_REPOINTED' });
    }
  }
  fs.writeFileSync(path.join(DST, f), buf);
  inDir.push(DST_REL + '/' + f);
}

// ---- 4. context.mjs: extend the generation chain to root6 ----
{
  const ctxPath = path.join(DST, 'context.mjs');
  const e = editor('context.mjs', fs.readFileSync(ctxPath, 'utf8'));

  e.apply('CURRENT_GENERATION',
    "generation='" + ROOT5_GENERATION + "';",
    "generation='" + ROOT6_GENERATION + "';");

  // Bind the capacity check to the registered generation's own expiry instead of the superseded
  // literal, keeping the equality against the registration itself.
  e.apply('CAPACITY_CURRENT_ROOT5_EXPIRY',
    "check(runtime.expires_at===registered.expires_at&&time(runtime.expires_at)<=time('" + OLD_CUTOFF + "'),'CAPACITY_CURRENT_ROOT5_EXPIRY');",
    "check(runtime.expires_at===registered.expires_at&&time(runtime.expires_at)<=time(root6Expiry),'CAPACITY_CURRENT_ROOT5_EXPIRY');");

  e.apply('GENERATION_CHAIN_CONSTANTS',
    "const root4Generation='ctrgen_9cf53fa5cd0a4a38bd68613493f95b06',root5Generation='" + ROOT5_GENERATION + "',root4Expiry='" + OLD_CUTOFF + "',root5BudgetSequence=64;",
    "const root4Generation='ctrgen_9cf53fa5cd0a4a38bd68613493f95b06',root5Generation='" + ROOT5_GENERATION + "',root6Generation='" + ROOT6_GENERATION + "',root4Expiry='" + OLD_CUTOFF + "',root6Expiry='" + ROOT6_EXPIRY + "',root5BudgetSequence=64,root6BudgetSequence=" + ROOT6_BUDGET_SEQUENCE + ";");

  e.apply('GENERATION_FOR_BUDGET',
    "const generationForBudget=sequence=>sequence>=root5BudgetSequence?root5Generation:sequence>=59?root4Generation:scope.root_generation;",
    "const generationForBudget=sequence=>sequence>=root6BudgetSequence?root6Generation:sequence>=root5BudgetSequence?root5Generation:sequence>=59?root4Generation:scope.root_generation;");
  e.apply('EXPIRY_FOR_BUDGET',
    "const expiryForBudget=sequence=>sequence>=59?root4Expiry:scope.expires_at;",
    "const expiryForBudget=sequence=>sequence>=root6BudgetSequence?root6Expiry:sequence>=59?root4Expiry:scope.expires_at;");

  // The live head must be the generation this controller is bound to. Line 42 already requires
  // execution.root.generation_id===generation, so leaving this pinned at root5 makes the two
  // checks mutually unsatisfiable the moment root6 is registered. root5 repointed this same
  // check away from scope.root_generation for exactly this reason.
  e.apply('EXACT_REGISTERED_CONTINUATION',
    "x.root.generation_id===root5Generation",
    "x.root.generation_id===root6Generation");

  // The owner cutoff. This is the change the Owner approved; the rest exist to stay consistent.
  e.apply('FIXED_OWNER_CUTOFF_NO_DISPATCH',
    "need(Date.parse(now)<Date.parse(root4Expiry),'FIXED_OWNER_CUTOFF_NO_DISPATCH')",
    "need(Date.parse(now)<Date.parse(root6Expiry),'FIXED_OWNER_CUTOFF_NO_DISPATCH')");
  e.apply('FULL_600_SECOND_WINDOW_REQUIRED',
    "need(Date.parse(now)+600000<Date.parse(root4Expiry),'FULL_600_SECOND_WINDOW_REQUIRED')",
    "need(Date.parse(now)+600000<Date.parse(root6Expiry),'FULL_600_SECOND_WINDOW_REQUIRED')");

  // The forward cap is already exactly exhausted at 15 (#5..#19), so NEXT_FORWARD refuses the
  // twentieth forward with ALLOCATION_OR_FORWARD_LIMIT_REACHED. Worse, applying it out of band by
  // raw SQL -- as every previous forward was applied -- takes forwards.length to 16 and fails
  // line 176 on EVERY operation including RESULT_RECONCILIATION, which would strand a reserved
  // budget with no way to close the attempt.
  e.apply('FORWARD_CAP',
    "allocations:9,forwards:" + OLD_FORWARD_CAP + ",",
    "allocations:9,forwards:" + NEW_FORWARD_CAP + ",");
  // The reason string names the cap it enforces, and it is referenced nowhere else in the repo,
  // so it is renamed rather than left asserting FIFTEEN into a receipt.
  e.apply('FORWARD_CAP_REASON_STRING',
    "'NINE_ALLOCATIONS_AND_GAS_FIFTEEN_FORWARDS_MAXIMUM'",
    "'NINE_ALLOCATIONS_AND_GAS_SIXTEEN_FORWARDS_MAXIMUM'");

  fs.writeFileSync(ctxPath, e.get());
}

// ---- 4b. source-publication.mjs: the manifest path it verifies ----
// verifySourcePublication reads this exact path and requires sha(raw)===binding.controller_sha256.
// Left pointing at the predecessor it either dies inside the live 600-second window, or -- if the
// binding digest were left at the root5 manifest to make it pass -- lets the run SUCCEED while
// attesting a source closure that is not the one executing. That is the only silently-invalid
// outcome found, so this edit is not optional.
{
  const p = path.join(DST, 'source-publication.mjs');
  const e = editor('source-publication.mjs', fs.readFileSync(p, 'utf8'));
  e.apply('SOURCE_PUBLICATION_MANIFEST_PATH', SRC_REL + '/ControllerSourceManifest.candidate.json', DST_REL + '/ControllerSourceManifest.candidate.json');
  fs.writeFileSync(p, e.get());
}

// ---- 4c. tool-entry.functions.js: the controller it actually launches ----
// This file was copied forward three generations without its paths being updated: it verifies and
// launches control-context-verifier-root5-final-successor, not the directory it lives in. It is
// fail-closed (the hash will not match $expected) but it is still wrong, and its bytes are
// digest-bound by the manifest.
{
  const p = path.join(DST, 'tool-entry.functions.js');
  const e = editor('tool-entry.functions.js', fs.readFileSync(p, 'utf8'));
  e.applyAll('TOOL_ENTRY_CONTROLLER_PATH',
    'scripts/phase2-qualification/control-context-verifier-root5-final-successor/',
    DST_REL + '/', 2);
  fs.writeFileSync(p, e.get());
}

// ---- 5. root-window-validation.mjs: the Owner window, both ends ----
// Reached from context.mjs:58, which calls validateRootShape(body) inside checkCurrentSemantics on
// every operation. (It is NOT reached via readControlUri -- that function has no caller in this
// controller; its only callers are generation2/prepare.mjs and successor.test.mjs, against the
// separate protocol-successor copy.)
//
// Both bounds move, rather than only raising the ceiling. Raising the ceiling alone is monotone
// and therefore safe for previously-accepted material, but it leaves the approved window enforced
// at one end only: nothing else pins body.not_before, so a root6 body could otherwise claim a
// not_before as early as 2026-09-10T13:18:47Z and still pass every check -- a ~2.5 day window
// instead of the approved 24 hours. Narrowing the lower bound is deliberately NOT monotone.
// Safe because validateRootShape only ever sees the LATEST GENERATION_REGISTERED body
// (context.mjs:57 takes .at(-1)), so no historical root5 body is ever re-validated under it.
{
  const p = path.join(DST, 'root-window-validation.mjs');
  const e = editor('root-window-validation.mjs', fs.readFileSync(p, 'utf8'));
  e.apply('OWNER_WINDOW_BOUNDS',
    "start>=Date.parse('2026-09-10T13:18:47Z')&&start<end&&end<=Date.parse('" + OLD_CUTOFF + "')",
    "start>=Date.parse('" + ROOT6_NOT_BEFORE + "')&&start<end&&end<=Date.parse('" + ROOT6_EXPIRY + "')");
  fs.writeFileSync(p, e.get());
}

// ---- 6. the two schemas that const the generation ----
// Both are compiled and executed (grr.mjs:7,11 and context.mjs:309,310) while the same code paths
// require the object's generation to equal root6. Left at root5 they are unsatisfiable.
for (const [file, expected, id] of [
  ['status-manifest.root5.schema.json', 2, 'STATUS_SCHEMA_GENERATION_CONST'],
  ['gate-result-receipt.root5.schema.json', 1, 'GRR_SCHEMA_GENERATION_CONST'],
]) {
  const p = path.join(DST, file);
  const e = editor(file, fs.readFileSync(p, 'utf8'));
  e.applyAll(id, '"' + ROOT5_GENERATION + '"', '"' + ROOT6_GENERATION + '"', expected);
  fs.writeFileSync(p, e.get());
}

// ---- 7. rebuild the controller source manifest (additive) ----
//
// Canonical encoding, replicated from the project's own builder at
// control-context-verifier-evidence-blob-successor/build-controller-manifest.mjs:44-53.
// It cannot be imported directly: that module's header does `import './context.mjs'`, which
// requires ajv, which is not installed here. So it is replicated and then PROVEN below by
// re-encoding the predecessor's own entries and checking the known predecessor digest falls out.
//
// Compact (no indent), fixed key order, and sorted by localeCompare(...,'en') -- NOT by codepoint.
// The two orders genuinely differ on this path list (e.g. importlib/_bootstrap_external.py vs
// importlib/_bootstrap.py), and the digest is what the qualification, the runtime acceptance, the
// budget event and the StatusManifest all commit to.
function encodeManifest(entries) {
  const paths = new Set();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || e.path.includes('..') ||
        /ControllerSourceManifest|Acceptance|ReviewSubject|SigningPayload|CandidateEvidence|SourceBindings|build-controller-manifest|python-import-catalog/.test(e.path))
      throw Error('SOURCE_ONLY_NO_SELF_OR_ACCEPTANCE_METADATA:' + e?.path);
    const key = e.path.toLowerCase();
    if (paths.has(key)) throw Error('DUPLICATE_SOURCE_PATH:' + e.path);
    paths.add(key);
    const exactEmptyDependency = e.role === 'RUNTIME_DEPENDENCY' && e.bytes === 0 &&
      e.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    if (!Number.isSafeInteger(e.bytes) || (e.bytes <= 0 && !exactEmptyDependency) ||
        !/^[a-f0-9]{64}$/.test(e.sha256) || !['REPOSITORY_SOURCE', 'RUNTIME_DEPENDENCY'].includes(e.role))
      throw Error('ACTUAL_TYPED_SOURCE_BYTES_REQUIRED:' + e.path);
  }
  // The builder's fixedSeeds gate is not replicated: this build only ever ADDS entries to the
  // predecessor's set, never removes one, and the self-test below proves that set is intact.
  return JSON.stringify({
    object_type: 'ControllerSourceManifest',
    format: 'EXACT_SORTED_SOURCE_BYTES_V1_CANDIDATE',
    scope: 'ISOLATED_TEST/SKILL_COEXISTENCE_QUALIFICATION',
    files: [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    authority_effect: 'NONE',
    qualification_issued: false,
  }) + '\n';
}

const oldManifestRaw = fs.readFileSync(path.join(SRC, 'ControllerSourceManifest.candidate.json'));
const oldManifest = JSON.parse(oldManifestRaw.toString('utf8'));

// Self-test: the replicated encoder must reproduce the predecessor manifest byte for byte. That
// digest is the controller_sha256 in the live binding, so a match proves the encoding is canonical
// and the new digest is reproducible by anyone using the project's own builder.
const PREDECESSOR_DIGEST = 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa';
const reencoded = encodeManifest(oldManifest.files);
if (sha(oldManifestRaw) !== PREDECESSOR_DIGEST)
  throw Error('PREDECESSOR_MANIFEST_NOT_AT_EXPECTED_DIGEST:' + sha(oldManifestRaw));
if (reencoded !== oldManifestRaw.toString('utf8'))
  throw Error('ENCODER_DOES_NOT_REPRODUCE_PREDECESSOR_MANIFEST_BYTES');
const newFiles = [];
let repointed = 0, rehashed = 0, carriedWindows = 0, carriedVerified = 0;
for (const entry of oldManifest.files) {
  if (entry.role === 'RUNTIME_DEPENDENCY') { newFiles.push({ ...entry }); carriedWindows++; continue; }
  if (entry.path.startsWith(SRC_REL + '/')) {
    const rel = entry.path.slice(SRC_REL.length + 1);
    const buf = fs.readFileSync(path.join(DST, rel));
    newFiles.push({ path: DST_REL + '/' + rel, role: entry.role, bytes: buf.length, sha256: sha(buf) });
    repointed++;
    if (sha(buf) !== entry.sha256) rehashed++;
    continue;
  }
  // Predecessor sources are kept, as the manifest convention in this repo is additive. Any drift
  // in a carried source means the world moved under us and the build must stop.
  const buf = fs.readFileSync(path.join(REPO, entry.path));
  if (sha(buf) !== entry.sha256) throw Error('UNEXPECTED_DRIFT_IN_CARRIED_SOURCE:' + entry.path);
  newFiles.push({ ...entry });
  carriedVerified++;
}
for (const rel of added) {
  const buf = fs.readFileSync(path.join(REPO, rel));
  newFiles.push({ path: rel, role: 'REPOSITORY_SOURCE', bytes: buf.length, sha256: sha(buf) });
}
const manifestRaw = encodeManifest(newFiles);
fs.writeFileSync(path.join(DST, 'ControllerSourceManifest.candidate.json'), manifestRaw);

console.log(JSON.stringify({
  root6_generation: ROOT6_GENERATION,
  root6_window: { not_before: ROOT6_NOT_BEFORE, expires_at: ROOT6_EXPIRY },
  root6_budget_sequence: ROOT6_BUDGET_SEQUENCE,
  edits: edits,
  edit_count: edits.length,
  trusted_github_imports_repointed: repointedImports,
  new_directories: [DST_REL, SIGN_DST_REL],
  forward_cap: { from: OLD_FORWARD_CAP, to: NEW_FORWARD_CAP, owner_authorized: true },
  manifest: {
    encoder_reproduces_predecessor_bytes: true,
    entries: newFiles.length,
    predecessor_entries: oldManifest.files.length,
    repointed_into_new_dir: repointed,
    of_which_content_changed: rehashed,
    newly_added: added.length,
    carried_repo_sources_reverified: carriedVerified,
    runtime_dependencies_carried_unverified: carriedWindows,
    new_controller_digest: sha(manifestRaw),
    predecessor_controller_digest: PREDECESSOR_DIGEST,
  },
}, null, 2));
