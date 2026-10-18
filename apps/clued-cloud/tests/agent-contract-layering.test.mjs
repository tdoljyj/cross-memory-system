import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const map = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v46-v47-map.json', import.meta.url), 'utf8'));
const successor = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v47-v48-map.json', import.meta.url), 'utf8'));
const review = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v48-v49-map.json', import.meta.url), 'utf8'));
const autonomy = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v49-v50-map.json', import.meta.url), 'utf8'));
const sessionTitle = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v50-v51-map.json', import.meta.url), 'utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Keep the v46→v47 movement proof unchanged. The v48 successor declares its
// three scoped replacements separately, followed by exact v49 review and v50
// runtime additions and the v51 session-title metadata correction. Undo only
// these declared successors before checking all
// 24 original normative blocks against the unchanged frozen proof.
function v50Source() {
  assert.equal(sessionTitle.schema, 'clued.agent-contract-session-title-successor/1');
  assert.equal(sessionTitle.source_version, 50);
  assert.equal(sessionTitle.target_version, 51);
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

test('all 24 v46 blocks remain in the frozen v47 base after only declared v48-v51 successor edits', () => {
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
