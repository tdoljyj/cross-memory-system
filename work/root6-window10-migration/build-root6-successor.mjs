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

// Repo root derived from this file's location (work/root6-window10-migration/), so the build is
// reproducible from any checkout rather than only the machine it was written on.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
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

// First execution_current sequence at which root6-era budgets may appear. Current sequence is 88
// after the nineteenth forward, so the next event is 89.
const ROOT6_BUDGET_SEQUENCE = 89;

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

  fs.writeFileSync(ctxPath, e.get());
}

// ---- 5. root-window-validation.mjs: the Owner window upper bound ----
// readControlUri calls validateRootShape on the CURRENT generation body, so a root6 registration
// ending after the old cutoff throws 'Owner window'. Only the upper bound moves; raising an upper
// bound is monotone, so every previously-valid root still validates.
{
  const p = path.join(DST, 'root-window-validation.mjs');
  const e = editor('root-window-validation.mjs', fs.readFileSync(p, 'utf8'));
  e.apply('OWNER_WINDOW_UPPER_BOUND',
    "end<=Date.parse('" + OLD_CUTOFF + "')",
    "end<=Date.parse('" + ROOT6_EXPIRY + "')");
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
const oldManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'ControllerSourceManifest.candidate.json'), 'utf8'));
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
newFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const seen = new Set();
for (const f of newFiles) {
  if (seen.has(f.path)) throw Error('DUPLICATE_MANIFEST_PATH:' + f.path);
  seen.add(f.path);
}
const manifestRaw = JSON.stringify({ ...oldManifest, files: newFiles }, null, 2) + '\n';
fs.writeFileSync(path.join(DST, 'ControllerSourceManifest.candidate.json'), manifestRaw);

console.log(JSON.stringify({
  root6_generation: ROOT6_GENERATION,
  root6_window: { not_before: ROOT6_NOT_BEFORE, expires_at: ROOT6_EXPIRY },
  root6_budget_sequence: ROOT6_BUDGET_SEQUENCE,
  edits: edits,
  edit_count: edits.length,
  trusted_github_imports_repointed: repointedImports,
  new_directories: [DST_REL, SIGN_DST_REL],
  manifest: {
    entries: newFiles.length,
    predecessor_entries: oldManifest.files.length,
    repointed_into_new_dir: repointed,
    of_which_content_changed: rehashed,
    newly_added: added.length,
    carried_repo_sources_reverified: carriedVerified,
    runtime_dependencies_carried_unverified: carriedWindows,
    new_controller_digest: sha(manifestRaw),
    predecessor_controller_digest: sha(fs.readFileSync(path.join(SRC, 'ControllerSourceManifest.candidate.json'))),
  },
}, null, 2));
