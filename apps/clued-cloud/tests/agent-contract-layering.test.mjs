import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const map = JSON.parse(await readFile(new URL('./fixtures/agent-contract-v46-v47-map.json', import.meta.url), 'utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');

test('the mandatory work-claim core remains within 500 words', () => {
  const start = source.indexOf('7. When the service offers work-claim tools');
  const end = source.indexOf('8. Resume lists', start);
  assert.ok(start >= 0 && end > start);
  const words = source.slice(start, end).trim().replace(/^7\. /, '').match(/\S+/g).length;
  assert.ok(words > 0 && words <= 500, `§1.7 has ${words} words`);
});

test('all 24 v46 normative blocks survive with only the nine declared reference edits', () => {
  assert.equal(map.schema, 'clued.agent-contract-claim-move/1');
  assert.equal(map.blocks.length, 24);
  assert.equal(map.blocks.reduce((count, row) => count + row.reference_edits.length, 0), 9);
  const appendix = source.split('## Appendix A. Work claims and admission')[1];
  assert.ok(appendix);
  const sections = [...appendix.matchAll(/^### A\.([1-8]) [^\n]+\n\n[^\n]+\n\n(.*?)(?=\n<a id="appendix-a[1-8]"><\/a>|(?![\s\S]))/gms)];
  assert.equal(sections.length, 8);
  const seen = [];
  for (const [, number, body] of sections) {
    assert.equal(source.split(`<a id="appendix-a${number}"></a>`).length - 1, 1);
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
