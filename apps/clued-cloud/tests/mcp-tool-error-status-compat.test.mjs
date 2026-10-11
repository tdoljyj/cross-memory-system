import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-mcp-error-envelope-'));
await build({ entryPoints: ['worker/mcp-error-envelope.ts'], outdir: directory, bundle: true,
  platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { withCanonicalMcpError } = await import(pathToFileURL(path.join(directory, 'mcp-error-envelope.mjs')));

const paired = (body, isError = true) => ({
  isError, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }],
});

for (const [status, code] of [['rejected', 'CONTEXT_POLICY_REQUIRED'], ['failed', 'P0001']]) {
  test(`${status}: canonical code survives the observed connector root-field overwrite`, () => {
    const original = paired({ status, error_code: code, receipt_id: 'fixture-receipt' });
    Object.freeze(original.structuredContent);
    const result = withCanonicalMcpError(original);
    const forwarded = { ...result.structuredContent, error_code: 'INVALID_ARGUMENT' };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error_code, code);
    assert.equal(forwarded.error.code, code);
    assert.equal(forwarded.error.status, status);
    assert.equal(forwarded.error.category, 'canonical_result');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(Object.hasOwn(original.structuredContent, 'error'), false);
  });
}

test('other content blocks, text annotations and tool metadata retain their identity', () => {
  const original = paired({ status: 'rejected', error_code: 'CAPABILITY_DENIED' });
  original.content[0].annotations = { audience: ['assistant'] };
  const image = { type: 'image', data: 'fixture', mimeType: 'image/png' };
  original.content.push(image);
  original._meta = { fixture: 'component-only' };
  const result = withCanonicalMcpError(original);
  assert.strictEqual(result.content[1], image);
  assert.strictEqual(result.content[0].annotations, original.content[0].annotations);
  assert.strictEqual(result._meta, original._meta);
});

test('structured-result refusals that are not tool errors remain unchanged', () => {
  const original = paired({ status: 'rejected', error_code: 'work_claim_conflict' }, false);
  assert.strictEqual(withCanonicalMcpError(original), original);
});

for (const status of ['committed', 'Rejected', 'fail', 'ok']) {
  test(`${status} is not decorated from a nested status or an error_code alone`, () => {
    const original = paired({ status, error_code: 'fixture', records: [{ status: 'rejected' }] });
    assert.strictEqual(withCanonicalMcpError(original), original);
  });
}

for (const error of [{ code: 'existing', hint: 'keep' }, 'existing', null]) {
  test(`existing error envelope (${error === null ? 'null' : typeof error}) is preserved`, () => {
    const original = paired({ status: 'rejected', error_code: 'fixture', error });
    assert.strictEqual(withCanonicalMcpError(original), original);
  });
}

test('independent readable text is not replaced by serialized structured data', () => {
  const original = paired({ status: 'rejected', error_code: 'fixture' });
  original.content[0].text = 'A separate explanation.';
  assert.strictEqual(withCanonicalMcpError(original), original);
});

test('no code is invented for missing, null or malformed error_code', () => {
  for (const code of [undefined, null, '', 1, {}]) {
    const original = paired({ status: 'failed', error_code: code });
    assert.strictEqual(withCanonicalMcpError(original), original);
  }
});

test('non-object and incomplete results pass through', () => {
  for (const result of [undefined, null, 1, [], {}, { isError: true },
    { isError: true, structuredContent: [] },
    { isError: true, structuredContent: { status: 'failed', error_code: 'P0001' }, content: [] }]) {
    assert.strictEqual(withCanonicalMcpError(result), result);
  }
});
