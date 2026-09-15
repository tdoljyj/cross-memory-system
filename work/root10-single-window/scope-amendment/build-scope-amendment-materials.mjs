// Build the scope-amendment stage-2 materials: ControllerQualification and
// RuntimeAcceptance for the narrowed applicable test set. Candidate only: it
// publishes nothing, signs nothing, writes no control store, and issues no
// qualification. Every digest it emits is computed from bytes on disk.
//
//   node build-scope-amendment-materials.mjs [--write]
//
// Publication-dependent fields the Owner merge has not produced yet are left as
// explicit placeholder tokens, in the same style as the runtime-clock activation
// kit. The script refuses to pretend it knows them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const need = (ok, why) => {if (!ok) throw Error(why);};
const blob = p => execFileSync('git', ['hash-object', p], {cwd: REPO, encoding: 'utf8'}).trim();
const ref = (uri, sha256) => ({uri, sha256});
const url = s => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + s;

const CONTROLLER = 'scripts/phase2-qualification/control-context-verifier-root10-scope-amendment';
const SUITE = 'scripts/phase2-qualification/RuntimeMaterialPreparation/scope-amendment-successor/preentry-skill-qualification.scope.json';
const AMENDMENT = 'work/root10-single-window/scope-amendment/Root10ScopeAmendment.json';

// The predecessors this amendment supersedes. Written literally: they are the
// live pins, and a build script must not silently re-derive them.
const PRIOR_CONTROLLER = '5c72dd8923436f6e9ab5b51160cd8751944158d3919d3ef09f6f3ec5006e40b6';

const read = rel => {const abs = path.join(REPO, rel); return {raw: fs.readFileSync(abs, 'utf8'), sha256: sha(fs.readFileSync(abs)), blob: blob(rel)};};

const manifest = read(CONTROLLER + '/ControllerSourceManifest.candidate.json');
const contract = read(CONTROLLER + '/Root10ControllerContract.candidate.json');
const suite = read(SUITE);
const amendment = read(AMENDMENT);

need(manifest.sha256 !== PRIOR_CONTROLLER, 'NEW_CONTROLLER_DIGEST_MUST_DIFFER');
const suiteValue = JSON.parse(suite.raw);
const applicable = Object.keys(suiteValue.tests).sort();
need(applicable.length === 5, 'EXACT_NARROWED_APPLICABLE_SET');

// Carry the prior stage-2 documents forward field by field; only the pins that
// this amendment actually moves are replaced.
const priorQualification = JSON.parse(fs.readFileSync(path.join(REPO, 'work/root10-single-window/runtime-clock/stage2/ControllerQualification.root10.runtime-clock.json'), 'utf8'));
const priorAcceptance = JSON.parse(fs.readFileSync(path.join(REPO, 'work/root10-single-window/runtime-clock/stage2/RuntimeAcceptance.root10.runtime-clock.json'), 'utf8'));

need(priorQualification.controller_digest === PRIOR_CONTROLLER && priorAcceptance.controller_digest === PRIOR_CONTROLLER, 'EXACT_PRIOR_STAGE2_PINS');

const qualification = {
  ...priorQualification,
  controller_digest: manifest.sha256,
  controller_source_manifest_ref: ref(url(manifest.blob), manifest.sha256),
  root10_contract_ref: ref(url(contract.blob), contract.sha256),
  amendment_ref: ref(url(amendment.blob), amendment.sha256),
  amendment_object_type: 'Root10ScopeAmendment',
  predecessor_controller_digest: PRIOR_CONTROLLER,
  source_publication: {
    owner_merge_commit: '__OWNER_MERGE_COMMIT__',
    source_tree: '__SOURCE_TREE__',
    controller_manifest_entries: JSON.parse(manifest.raw).files.length,
  },
};

const acceptance = {
  ...priorAcceptance,
  controller_digest: manifest.sha256,
  accepted_subject: {
    ...priorAcceptance.accepted_subject,
    gate_suite_ref: ref(url(suite.blob), suite.sha256),
  },
};

// The acceptance already carries historical component evidence for exactly the
// tests this amendment keeps in scope. That correspondence is the whole reason
// the narrowed set is 5 and not some other number, so it is asserted, not assumed.
const historical = acceptance.accepted_subject.historical_component_evidence.map(e => e.test_id).sort();
need(JSON.stringify(historical) === JSON.stringify(applicable), 'APPLICABLE_SET_MUST_MATCH_HISTORICAL_EVIDENCE');

const emit = (name, value) => {
  const raw = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(HERE, name), raw);
  return {name, sha256: sha(raw), bytes: Buffer.byteLength(raw)};
};

const out = {
  state: 'ROOT10_SCOPE_AMENDMENT_MATERIALS_BUILT',
  authority_effect: 'NONE',
  live_database_write: false,
  new_controller_sha256: manifest.sha256,
  new_controller_manifest_blob: manifest.blob,
  new_gate_suite_sha256: suite.sha256,
  new_gate_suite_blob: suite.blob,
  amendment_sha256: amendment.sha256,
  amendment_blob: amendment.blob,
  applicable_test_ids: applicable,
  artifacts: [
    emit('ControllerQualification.root10.scope.json', qualification),
    emit('RuntimeAcceptance.root10.scope.json', acceptance),
  ],
  unresolved_placeholders: ['__OWNER_MERGE_COMMIT__', '__SOURCE_TREE__'],
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
