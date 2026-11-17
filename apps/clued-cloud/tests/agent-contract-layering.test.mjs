import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const map = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v46-v47-map.json', import.meta.url), 'utf8'));
const successor = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v47-v48-map.json', import.meta.url), 'utf8'));
const review = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v48-v49-map.json', import.meta.url), 'utf8'));
const autonomy = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v49-v50-map.json', import.meta.url), 'utf8'));
const claimRenewal = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v50-v51-map.json', import.meta.url), 'utf8'));
const sessionTitle = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v51-v52-map.json', import.meta.url), 'utf8'));
const branding = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v52-v53-map.json', import.meta.url), 'utf8'));
const ciQueueAssist = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v53-v54-map.json', import.meta.url), 'utf8'));
const ciQueueParticipation = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v54-v55-map.json', import.meta.url), 'utf8'));
const prTaskBinding = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v55-v56-map.json', import.meta.url), 'utf8'));
const terminalRelease = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v56-v57-map.json', import.meta.url), 'utf8'));
const leasePin = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v57-v58-map.json', import.meta.url), 'utf8'));
const prEndRelease = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v58-v59-map.json', import.meta.url), 'utf8'));
const holderPreflight = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v59-v60-map.json', import.meta.url), 'utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Keep the v46→v47 movement proof unchanged. The v48 successor declares its
// three scoped replacements separately, followed by exact v49 review and v50
// runtime additions, the v51 claim-renewal clarification, the v52 title
// metadata correction, the v53 display-name changes, the v54 resident CI queue assist,
// the v55 queue participation and explicit holder removal, and the v56 Native
// PR/Task identity successor, the v57 holder-edit/terminal successor, then the v58 lease pin by authorize_head, and the v59 PR-end release that
// replaces holder readiness and terminal admission. The v60 successor corrects
// only the existing A.4 holder preflight and its retired readiness wording.
// Undo only these declared
// successors before checking all 24 original normative blocks against the unchanged frozen proof.
function v59Source() {
  assert.equal(holderPreflight.schema,'clued.agent-contract-holder-preflight-successor/1');
  assert.equal(holderPreflight.source_version,59);assert.equal(holderPreflight.target_version,60);
  assert.deepEqual(holderPreflight.edits.map(row=>row.id),['version','holder-preflight']);
  assert.deepEqual(holderPreflight.edits[0],{id:'version',before:'Contract version: 59',after:'Contract version: 60'});
  assert.equal(sha256(source),holderPreflight.target_document_normalized_sha256);
  const edit=holderPreflight.edits[1];
  for(const text of [edit.before,edit.after]) {
    assert.ok(text.startsWith('  Before a repository edit, derive its concrete literal targets'));
    assert.equal(/(?:^|\n)(?:### |<a id=)/.test(text),false,'the edit cannot consume another section');
  }
  assert.equal(edit.after.split('For widening,')[0],edit.before.split('For widening,')[0],
    'the original scope, holder, key, CAS and coverage rules remain exact');
  const suffix='Preserve other PRs, planned paths and trigger resources; do not invent progress or replace the Task/claim after a refusal.';
  assert.ok(edit.before.endsWith(suffix));assert.ok(edit.after.endsWith(suffix));
  assert.ok(edit.after.includes('An empty list is only a holder preflight: it grants no file-path authority.'));
  assert.ok(edit.after.includes('nonempty concrete changed-path list and require `holder_edit_authorized: true` before writing.'));
  assert.equal(/fresh readiness false|Covered targets with false readiness|Unknown readiness/.test(source),false,
    'retired readiness cannot remain a live editing requirement');
  let restored=source;
  for(const {id,before,after} of [...holderPreflight.edits].reverse()) {
    assert.equal(restored.split(after).length-1,1,`${id}: exact holder-preflight successor text`);
    restored=restored.replace(after,before);
  }
  assert.equal(sha256(restored),holderPreflight.source_document_normalized_sha256);
  return restored;
}
function v58Source() {
  const source=v59Source();
  assert.equal(prEndRelease.schema,'clued.agent-contract-pr-end-release-successor/1');
  assert.equal(prEndRelease.source_version,58);assert.equal(prEndRelease.target_version,59);
  assert.deepEqual(prEndRelease.edits.map(row=>row.id),['version','no-holder-readiness','pr-end-release']);
  assert.deepEqual(prEndRelease.edits[0],{id:'version',before:'Contract version: 58',after:'Contract version: 59'});
  assert.equal(sha256(source),prEndRelease.target_document_normalized_sha256);
  assert.equal(/terminal_release_ready|terminal_admission/.test(source),false,'no terminal admission or holder readiness is left');
  let restored=source;
  for(const {id,before,after} of [...prEndRelease.edits].reverse()){
    assert.equal(restored.split(after).length-1,1,`${id}: exact PR-end release successor text`);
    restored=restored.replace(after,before);
  }
  assert.equal(sha256(restored),prEndRelease.source_document_normalized_sha256);
  return restored;
}
function v57Source() {
  const source=v58Source();
  assert.equal(leasePin.schema,'clued.agent-contract-lease-pin-successor/1');
  assert.equal(leasePin.source_version,57);assert.equal(leasePin.target_version,58);
  assert.deepEqual(leasePin.edits.map(row=>row.id),['version','authorize-pins-lease','ci-extension-pinned','renew-at-deadline']);
  assert.deepEqual(leasePin.edits[0],{id:'version',before:'Contract version: 57',after:'Contract version: 58'});
  assert.equal(sha256(source),leasePin.target_document_normalized_sha256);
  let restored=source;
  for(const {id,before,after} of [...leasePin.edits].reverse()){
    assert.equal(restored.split(after).length-1,1,`${id}: exact lease-pin successor text`);
    restored=restored.replace(after,before);
  }
  assert.equal(sha256(restored),leasePin.source_document_normalized_sha256);
  return restored;
}
function v56Source() {
  const source=v57Source();
  assert.equal(terminalRelease.schema,'clued.agent-contract-terminal-release-successor/1');
  assert.equal(terminalRelease.source_version,56);assert.equal(terminalRelease.target_version,57);
  assert.deepEqual(terminalRelease.edits.map(row=>row.id),['version','holder-readiness','holder-edit-verification','trusted-pr-terminal']);
  assert.equal(terminalRelease.source_document_normalized_sha256,'767b47354d7dbf56079f265780b4c83b61a054bc2ed51dd59f52d290b37d5864');
  assert.equal(sha256(source),terminalRelease.target_document_normalized_sha256);
  assert.deepEqual(terminalRelease.edits[0],{id:'version',before:'Contract version: 56',after:'Contract version: 57'});
  const prefixes=['- A guarded holder authorizes each exact full head SHA','- Before the lease expires, call `clued_work_renew`',
    '- The `clued-work-admission` check then fully verifies'];
  let restored=source;
  for(const [index,edit] of terminalRelease.edits.entries()){
    if(index){
      assert.ok(edit.before.startsWith(prefixes[index-1]));
      assert.ok(edit.after.startsWith(edit.before+'\n\n'),'append only within the three existing appendix blocks');
      assert.equal(/(?:^|\n)(?:### |<a id=)/.test(edit.after),false,'no edit may consume another appendix');
    }
  }
  for(const {id,before,after} of [...terminalRelease.edits].reverse()){
    assert.equal(restored.split(after).length-1,1,`${id}: exact terminal successor text`);
    restored=restored.replace(after,before);
  }
  assert.equal(sha256(restored),terminalRelease.source_document_normalized_sha256);
  return restored;
}
function v55Source() {
  const source=v56Source();
  assert.equal(prTaskBinding.schema, 'clued.agent-contract-pr-task-binding-successor/1');
  assert.equal(prTaskBinding.source_version, 55);
  assert.equal(prTaskBinding.target_version, 56);
  assert.deepEqual(prTaskBinding.edits.map(row => row.id), ['version', 'pr-task-core', 'pr-task-admission']);
  assert.equal(prTaskBinding.source_document_normalized_sha256, 'b675b6fd89423b08d71e36b010b960af9636bfd6ecf3870847a3025eb5b9a94a');
  assert.equal(sha256(source), prTaskBinding.target_document_normalized_sha256);
  const [version, core, admission] = prTaskBinding.edits;
  assert.deepEqual(version, { id: 'version', before: 'Contract version: 55', after: 'Contract version: 56' });
  assert.ok(core.before.startsWith('   Put `Clued-Work-Claim:'));
  assert.ok(core.after.startsWith('   Native binds each PR to one Task;'));
  assert.equal(core.before.trim().split('\n').length, 1);
  assert.equal(core.after.trim().split('\n').length, 1);
  assert.ok(core.after.endsWith(core.before.slice(core.before.indexOf('Follow admission state and layer'))),
    'existing core admission/Owner/freshness/rerun/frozen rules remain exact');
  assert.ok(admission.before.startsWith('- Put `Clued-Work-Claim:'));
  assert.ok(admission.after.startsWith('- Native is the single source of PR-to-Task identity:'));
  for (const text of [admission.before, admission.after]) {
    assert.equal(text.includes('- Each pull request has a layer,'), false, 'A.5 layer and Owner rules are outside the edit');
    assert.equal(/(?:^|\n)(?:### |<a id=)/.test(text), false, 'the admission edit cannot consume another section');
  }
  let restored = source;
  for (const { id, before, after } of [...prTaskBinding.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact PR Task successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), prTaskBinding.source_document_normalized_sha256);
  return restored;
}

function v54Source() {
  const source = v55Source();
  assert.equal(ciQueueParticipation.schema, 'clued.agent-contract-ci-queue-participation-successor/1');
  assert.equal(ciQueueParticipation.source_version, 54);
  assert.equal(ciQueueParticipation.target_version, 55);
  assert.deepEqual(ciQueueParticipation.edits.map(row => row.id), ['version', 'ci-queue-participation', 'ci-queue-leave']);
  assert.equal(sha256(source), ciQueueParticipation.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...ciQueueParticipation.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact queue participation successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), ciQueueParticipation.source_document_normalized_sha256);
  return restored;
}

function v53Source() {
  const source = v54Source();
  assert.equal(ciQueueAssist.schema, 'clued.agent-contract-ci-queue-assist-successor/1');
  assert.equal(ciQueueAssist.source_version, 53);
  assert.equal(ciQueueAssist.target_version, 54);
  assert.deepEqual(ciQueueAssist.edits.map(row => row.id), ['version', 'ci-queue-assist', 'ci-queue-leave']);
  assert.equal(sha256(source), ciQueueAssist.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...ciQueueAssist.edits].reverse()) {
    // Only additions: each successor text keeps its predecessor text whole.
    if (id !== 'version') assert.ok(after.includes(before.trimEnd()), `${id}: additive successor text`);
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact queue assist successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), ciQueueAssist.source_document_normalized_sha256);
  return restored;
}

function v52Source() {
  const source = v53Source();
  assert.equal(branding.schema, 'clued.agent-contract-branding-successor/1');
  assert.equal(branding.source_version, 52);
  assert.equal(branding.target_version, 53);
  assert.equal(sha256(source), branding.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...branding.edits].reverse()) {
    // The mapping can change only the visible name and the contract version.
    // In particular it cannot silently change authority, tools or identifiers.
    const expected = id === 'version' ? 'Contract version: 53'
      : before.split('`').map((part, i) => i % 2 ? part : part.replace(/\bClued\b(?![-_])/g, 'BeamingFace')).join('`');
    assert.equal(after, expected, `${id}: branding-only replacement`);
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact branding successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), branding.source_document_normalized_sha256);
  return restored;
}

function v51Source() {
  const source = v52Source();
  assert.equal(sessionTitle.schema, 'clued.agent-contract-session-title-successor/1');
  assert.equal(sessionTitle.source_version, 51);
  assert.equal(sessionTitle.target_version, 52);
  assert.deepEqual(sessionTitle.edits.map(row => row.id), ['version', 'session-title-metadata']);
  assert.equal(sha256(source), sessionTitle.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...sessionTitle.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact session title successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), sessionTitle.source_document_normalized_sha256);
  return restored;
}

function v50Source() {
  const source = v51Source();
  assert.equal(claimRenewal.schema, 'clued.agent-contract-claim-renewal-successor/1');
  assert.equal(claimRenewal.source_version, 50);
  assert.equal(claimRenewal.target_version, 51);
  assert.deepEqual(claimRenewal.edits.map(row => row.id), ['version', 'claim-renewal-boundaries', 'ordinary-new-claim']);
  assert.equal(sha256(source), claimRenewal.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...claimRenewal.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact claim renewal successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), claimRenewal.source_document_normalized_sha256);
  return restored;
}

function v49Source() {
  const source = v50Source();
  assert.equal(autonomy.schema, 'clued.agent-contract-runtime-autonomy-successor/1');
  assert.equal(autonomy.source_version, 49);
  assert.equal(autonomy.target_version, 50);
  assert.deepEqual(autonomy.edits.map(row => row.id), ['version', 'runtime-boundaries']);
  assert.equal(sha256(source), autonomy.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...autonomy.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact runtime successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), autonomy.source_document_normalized_sha256);
  return restored;
}

function v48Source() {
  const source = v49Source();
  assert.equal(review.schema, 'clued.agent-contract-independent-review-successor/1');
  assert.equal(review.source_version, 48);
  assert.equal(review.target_version, 49);
  assert.deepEqual(review.edits.map(row => row.id), ['version', 'independent-review']);
  assert.equal(sha256(source), review.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...review.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact review successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), review.source_document_normalized_sha256);
  return restored;
}

function v47Source() {
  const source = v48Source();
  assert.equal(successor.schema, 'clued.agent-contract-handover-successor/1');
  assert.equal(successor.source_version, 47);
  assert.equal(successor.target_version, 48);
  assert.deepEqual(successor.edits.map(row => row.id), ['version', 'private-credential-errors', 'private-handover']);
  assert.equal(sha256(source), successor.target_document_normalized_sha256);
  let restored = source;
  for (const { id, before, after } of [...successor.edits].reverse()) {
    assert.equal(restored.split(after).length - 1, 1, `${id}: exact successor text`);
    restored = restored.replace(after, before);
  }
  assert.equal(sha256(restored), successor.source_document_normalized_sha256);
  return restored;
}

test('the mandatory work-claim core remains within 500 words', () => {
  const start = source.indexOf('7. When the service offers work-claim tools');
  const end = source.indexOf('8. Resume lists', start);
  assert.ok(start >= 0 && end > start);
  const words = source.slice(start, end).trim().replace(/^7\. /, '').match(/\S+/g).length;
  assert.ok(words > 0 && words <= 500, `§1.7 has ${words} words`);
});

test('all 24 v46 blocks remain in the frozen v47 base after only declared v48-v60 successor edits', () => {
  assert.equal(map.schema, 'clued.agent-contract-claim-move/1');
  assert.equal(map.blocks.length, 24);
  assert.equal(map.blocks.reduce((count, row) => count + row.reference_edits.length, 0), 9);
  const preserved = v47Source();
  const appendix = preserved.split('## Appendix A. Work claims and admission')[1];
  assert.ok(appendix);
  const sections = [...appendix.matchAll(/^### A\.([1-8]) [^\n]+\n\n[^\n]+\n\n(.*?)(?=\n<a id="appendix-a[1-8]"><\/a>|(?![\s\S]))/gms)];
  assert.equal(sections.length, 8);
  const seen = [];
  for (const [, number, body] of sections) {
    assert.equal(preserved.split(`<a id="appendix-a${number}"></a>`).length - 1, 1);
    const ids = map.groups[number];
    const blocks = body.replace(/^\n+|\n+$/g, '').split(/(?=^- )/m).filter(Boolean).map(block => block.replace(/\n+$/g, ''));
    assert.equal(blocks.length, ids.length, `A.${number}`);
    blocks.forEach((block, index) => {
      const id = ids[index];
      const proof = map.blocks.find(row => row.source_block === id);
      assert.equal(proof.appendix, `A.${number}`);
      let restored = block;
      for (const { before, after } of [...proof.reference_edits].reverse()) {
        assert.equal(restored.split(after).length - 1, 1, `block ${id}: exact pointer`);
        restored = restored.replace(after, before);
      }
      assert.equal(sha256(restored), proof.source_normalized_sha256, `block ${id}: normative text`);
      seen.push(id);
    });
  }
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i));
});
