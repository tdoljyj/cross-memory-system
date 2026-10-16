import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/imprints/imprint-suggestions.ts');
const exports = {};
// No request/storage/model module or fetch is available to this pure module.
vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports, require: name => { throw Error('Unexpected dependency: ' + name); } }, { filename: file });
const suggest = (text, options = {}) => JSON.parse(JSON.stringify(exports.suggestImprintOrganization(text, options)));
const owner = { sourceKind: 'owner_text' };
const types = text => suggest(text, owner).fragments.map(item => item.kind);
const domains = text => suggest(text).domains.map(item => item.domain);

test('explicit saved uses can suggest multiple domains from one unchanged body', () => {
  const text = '保存用途：工作汇报、课程学习、创作游戏剧情。';
  const result = suggest(text);
  assert.deepEqual(result.domains.map(item => item.domain), ['work', 'learning', 'creation']);
  for (const item of result.domains) {
    assert.equal(text.slice(item.source.start, item.source.end), item.source.text);
    assert.equal(item.source.text, '保存用途：工作汇报、课程学习、创作游戏剧情');
  }
  assert.equal(result.fragments.length, 0);
});

test('concrete natural activities classify without asking the user to write purpose labels', () => {
  for (const [text, expected] of [
    ['客户Logo方案。', ['work', 'creation']], ['客户 Logo 设计方案。', ['work', 'creation']],
    ['我正在给客户设计Logo。', ['work', 'creation']], ['给客户设计Logo。', ['work', 'creation']],
    ['给客户设计 Logo。', ['work', 'creation']], ['给客户设计一个Logo。', ['work', 'creation']],
    ['我今天正在给客户设计一套 Logo。', ['work', 'creation']],
    ['我正在复习线性代数。', ['learning']], ['复习考试重点。', ['learning']],
    ['我正在复习线性代数，用这本教材。', ['learning']], ['我在学习Rust。', ['learning']],
    ['我今天整理家庭预算。', ['daily']], ['明天预约体检。', ['daily']],
    ['继续写小说第二章。', ['creation']], ['我整理本周工作周报。', ['work']],
    ['安排周末徒步路线。', ['interest']], ['Client logo design.', ['work', 'creation']],
    ['I am studying linear algebra.', ['learning']], ['I am planning a weekend hike.', ['interest']],
  ]) {
    assert.deepEqual(domains(text), expected, text);
    assert.deepEqual(suggest(text).fragments, [], 'domain classification never invents a formal commitment');
    for (const item of suggest(text).domains) assert.equal(text.slice(item.source.start, item.source.end), item.source.text);
  }
});

test('natural activity rules abstain from material topics, conditions, negation, quotation and reported requests', () => {
  for (const text of ['客户Logo设计教程。', '客户Logo方案只是一个案例。', '写小说的教材。',
    '我给客户设计Logo，但不是工作用途。', '如果给客户设计Logo。', '客户要求我设计Logo。',
    '“给客户设计Logo。”', '> 给客户设计Logo。', '```\n客户Logo方案。\n```',
    '我想要给客户设计Logo。', '我在看客户Logo教程。', '学习用品采购。', 'Client logo design tutorial.', 'I am not writing a novel.']) {
    assert.deepEqual(domains(text), [], text);
  }
  assert.deepEqual(suggest('客户Logo方案。', { sourceKind: 'external_material' }).domains, []);
});

test('daily life and interests need explicit purposes rather than a personal-topic fallback', () => {
  assert.deepEqual(domains('我保存这份资料用于家庭预算。'), ['daily']);
  assert.deepEqual(domains('我收藏这篇文章用于兴趣探索。'), ['interest']);
  for (const text of ['我是设计师。', '我喜欢简洁回复。', '今天与家人通了电话。', '猫的照片。', '未分类资料。']) {
    assert.deepEqual(domains(text), [], text);
  }
});

test('movie language, manual work, tutorials and keywords do not invent a purpose', () => {
  for (const text of ['我看了英语电影。', '我亲手做了一张表格。', '引擎教程，客户说有兴趣。',
    'An English movie.', 'I made a spreadsheet myself.', 'Interest rates at work.']) {
    assert.deepEqual(domains(text), [], text);
    assert.deepEqual(types(text), [], text);
  }
  assert.deepEqual(domains('我保存这个视频用于学习英语。'), ['learning']);
  assert.deepEqual(domains('Purpose: personal budget, creative writing and hobbies.'), ['daily', 'creation', 'interest']);
});

test('only concrete first-person commitments yield possible task fragments', () => {
  for (const text of ['我将明天提交报价。', '我承诺周五完成采购。', '我会明天报名课程。',
    '我计划下周预约门诊。', 'I will submit the report tomorrow.', 'I promise to send the draft.']) {
    assert.deepEqual(types(text), ['task'], text);
  }
});

test('wishes, abilities, client requests and advice are not personal commitments', () => {
  for (const text of ['我想学钢琴。', '我会画画。', '我计划学习英语。', '客户要求我周五提交报告。',
    '建议我将明天提交报价。', 'I wish to learn piano.', 'The client requests that I will send a report.',
    'I would submit the report.', 'I will study English.']) assert.deepEqual(types(text), [], text);
});

test('negations, conditions, questions and commentary suppress otherwise matching sentences', () => {
  for (const text of ['如果客户同意，我将明天提交报价。', '我将明天提交报价，但不保证。',
    '我将明天提交报价？', '我决定采用A，这只是讨论。', '假设：我决定采用A。',
    '我没有决定采用A。', 'I will not send the report.', 'If approved; I will submit the report.',
    'I have decided to adopt A as a hypothetical example.', '否则，我将明天提交报价。',
    'I will send the report; otherwise I will buy option A.', 'When approved, I will send the report.']) assert.deepEqual(types(text), [], text);
  assert.deepEqual(domains('保存用途：不用来学习英语。'), []);
  assert.deepEqual(domains('Purpose: not for learning English.'), []);
});

test('completed actions and historical facts never become a new commitment', () => {
  for (const text of ['我已经完成采购。', '我昨天提交了报价。', '我承诺过提交报告。',
    '我将报告提交了。', '我会明天阅读已经完成的报告。', 'I finished the report.',
    'I will have submitted the report.', 'I already promised to send the draft.']) assert.deepEqual(types(text), [], text);
});

test('an explicit choice can suggest adoption or rejection, not an external recommendation', () => {
  for (const text of ['我决定采用A。', '我已决定不采用B。', '我选择方案C。',
    'I have decided to adopt option A.', 'I have decided not to use option B.', 'I choose option C.']) {
    assert.deepEqual(types(text), ['decision'], text);
  }
  for (const text of ['文章推荐采用A。', '我考虑采用A。', '我想选择方案B。',
    'I may choose option A.', 'The article recommends A.']) assert.deepEqual(types(text), [], text);
});

test('unknown and external authorship cannot produce an owner task or decision', () => {
  const text = '我将明天提交稿件。我决定采用A。';
  assert.deepEqual(suggest(text).fragments, []);
  assert.deepEqual(suggest(text, { sourceKind: 'unknown' }).fragments, []);
  assert.deepEqual(suggest('保存用途：工作汇报。' + text, { sourceKind: 'external_material' }).domains, []);
  assert.deepEqual(suggest(text, { sourceKind: 'external_material' }).fragments, []);
});

test('quoted text, code and explicitly introduced external blocks cannot claim owner intent', () => {
  for (const text of ['“我将明天提交报价。”', '客户说：“我决定采用A。”',
    '> 我将明天提交报价。', '```\n我将明天提交报价。\n```', '`I will submit the report.`',
    '客户请求：\n我将明天提交报价。', 'Quoted text:\nI have decided to adopt A.',
    '“保存用途：工作汇报。”', '“我决定采用A。\n我将明天提交稿件。”',
    "'My words. I will submit the report.'", '客户请求：我将明天提交稿件。我决定采用A。',
    '他今天说，我将明天提交报价。', 'He said, I will submit the report.',
    '他说：\n我将明天提交报价。', '我不采纳他说的“我决定采用A。我将明天提交报价”。']) {
    const result = suggest(text, owner);
    assert.deepEqual(result.fragments, [], text);
    assert.deepEqual(result.domains, [], text);
  }
});

test('unknown authorship always suppresses possible commitments, including ambiguous quotation', () => {
  for (const text of ['我将明天提交报告。', '我决定采用A。', 'I will submit the report.',
    'I choose option A.', '否则，我将明天提交报价。', '客户请求：我将明天提交稿件。',
    '他今天说，我将明天提交报价。', "'I choose A. I will submit a report.'"]) {
    assert.deepEqual(suggest(text).fragments, [], text);
    assert.deepEqual(suggest(text, { sourceKind: 'unknown' }).fragments, [], text);
  }
});

test('quoted object names do not prevent an actual first-person action', () => {
  const text = '我将明天提交“预算表”。';
  assert.deepEqual(types(text), ['task']);
  assert.equal(suggest(text, owner).fragments[0].source.text, '我将明天提交“预算表”');
});

test('mixed choices and actions remain separate source spans, never duplicated records', () => {
  const text = '我决定采用方案A，我将周五购买许可证。';
  const fragments = suggest(text, owner).fragments;
  assert.deepEqual(fragments.map(item => [item.kind, item.source.text]), [
    ['decision', '我决定采用方案A'], ['task', '我将周五购买许可证'],
  ]);
  for (const item of fragments) assert.equal(text.slice(item.source.start, item.source.end), item.source.text);
});

test('source offsets preserve Unicode, repeated lines, whitespace and bullets', () => {
  const text = '🎮 收藏说明\n  - 我将明天提交稿件。\n我决定采用A。\n我将明天提交稿件。';
  const result = suggest(text, owner);
  assert.equal(result.fragments.length, 3);
  assert.deepEqual(result.fragments.map(item => item.source.start), [
    text.indexOf('我将'), text.indexOf('我决定'), text.lastIndexOf('我将'),
  ]);
  for (const item of result.fragments) assert.equal(text.slice(item.source.start, item.source.end), item.source.text);
});

test('every result is candidate-only, transparent, deterministic and side-effect-free', () => {
  const text = '保存用途：工作汇报。\n我决定采用A。\n我将明天提交报告。';
  const options = Object.freeze({ sourceKind: 'owner_text', locale: 'en' });
  const first = suggest(text, options), second = suggest(text, options);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'candidate');
  assert.equal(first.authoritative, false);
  assert.equal(first.execution_authorization, 'NOT_GRANTED');
  for (const item of [...first.domains, ...first.fragments]) {
    assert.equal(item.status, 'candidate'); assert.equal(item.authoritative, false);
    assert.ok(item.rule_id); assert.ok(item.reason);
  }
  assert.deepEqual(suggest('   ').domains, []);
  assert.deepEqual(suggest('   ').fragments, []);
});
