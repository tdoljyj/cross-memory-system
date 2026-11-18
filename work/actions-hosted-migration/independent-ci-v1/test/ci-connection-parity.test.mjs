import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/proof.mjs';
import { effectiveCiPrincipal } from '../src/resident-v2/ci-principal.mjs';
const resident = new URL('../../../independent-ci-resident-v1/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL('test/fixtures/' + name, resident), 'utf8'));
const { node, bindingId, bindingGeneration, rebindReceiptId, activatedAt, cases } = read('ci-connection-cases.json');
const base = read('node-identity-cases.json').nodes[node];
const record = { config: base.installation, accepted: base.accepted, hashes: { acceptanceSha256: base.acceptancePin } };
const tokenPinSha256 = 'a'.repeat(64);
const good = { contract: 'clued.independent-ci.ci-connection/1', baseNodeIdentitySha256: base.identitySha256,
  bindingId, bindingGeneration, rebindReceiptId, tokenPinSha256, previousSha256: null, activatedAt };
function bytesFor(kind) {
  const changes = { previous: { previousSha256: 'f'.repeat(64) }, extra: { ignored: true }, foreign: { baseNodeIdentitySha256: 'b'.repeat(64) },
    contract: { contract: 'other' }, 'contract-array': { contract: [good.contract] },
    'identity-array': { baseNodeIdentitySha256: [good.baseNodeIdentitySha256] }, 'date-array': { activatedAt: [activatedAt] },
    binding: { bindingId: null }, receipt: { rebindReceiptId: 'x' }, pin: { tokenPinSha256: 123 },
    'previous-format': { previousSha256: '' }, zero: { bindingGeneration: 0 }, fraction: { bindingGeneration: 1.5 },
    overflow: { bindingGeneration: 2 ** 53 }, 'string-generation': { bindingGeneration: '2' },
    date: { activatedAt: '2026-02-31T08:00:00.000Z' }, 'year-zero': { activatedAt: '0000-01-01T00:00:00.000Z' } };
  if (kind === 'absent') return null;
  const obj = { ...good, ...changes[kind] };
  if (kind === 'missing') delete obj.activatedAt;
  const text = canonical(obj);
  switch (kind) {
    case 'duplicate': return Buffer.from(text.replace('{', '{"bindingGeneration":1,'));
    case 'space': return Buffer.from(' ' + text);
    case 'newline': return Buffer.from(text + '\n');
    case 'bom': return Buffer.from('\uFEFF' + text);
    case 'bad-utf8': return Buffer.concat([Buffer.from([0xff]), Buffer.from(text)]);
    default: return Buffer.from(text);
  }
}
const rows = cases.map(([name, kind]) => {
  const bytes = bytesFor(kind);
  const expected = kind === 'absent' ? { bindingId: base.installation.ciPrincipalBindingId, tokenPinSha256: base.installation.ciTokenPinSha256, generation: null }
    : ['valid', 'previous'].includes(kind) ? { bindingId, tokenPinSha256, generation: bindingGeneration } : 'CI_CONNECTION_RECORD_REFUSED';
  return { name, base64: bytes?.toString('base64') ?? null, expected };
});
test('JS 按同一组规范字节和拒绝码解析当前连接', () => {
  for (const { name, base64, expected } of rows) {
    const parse = () => effectiveCiPrincipal(record, base64 === null ? null : Buffer.from(base64, 'base64'));
    if (typeof expected === 'string') assert.throws(parse, { code: expected }, name);
    else assert.deepEqual(parse(), expected, name);
  }
});
test('Windows PowerShell 解析相同字节，逐项对照 JS 的三项结果和拒绝码', { skip: process.platform !== 'win32' }, () => {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('test/ci-connection-parser.ps1', resident))], { encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ record: base, cases: rows.map(({ base64 }) => ({ base64 })) }) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), rows.map(row => row.expected));
});
