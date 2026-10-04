import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-permission-guidance-'));
await build({ entryPoints: ['worker/permission-guidance.ts'], outdir: directory, bundle: true,
  platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { permissionDenial } = await import(pathToFileURL(path.join(directory, 'permission-guidance.mjs')));
const project = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const resources = (...args) => permissionDenial('insufficient_scope', ...args).error.suggested_request?.resources;

test('the missing context follows the arguments the database checks', () => {
  assert.deepEqual(resources('clued_record_mutate', { scope: `project:${project}` }, ['context:write']), [`permission:project:${project}/write`]);
  assert.deepEqual(resources('clued_session_resume', { context_key: 'profile' }, ['context:read']), ['permission:profile/read']);
  assert.deepEqual(resources('clued_append_event', { event_scope: `project:${project}` }, ['context:write']), [`permission:project:${project}/write`]);
  assert.deepEqual(resources('clued_decision_supersede', { replacement: { scope: `project:${project}` } }, ['context:write']), [`permission:project:${project}/write`]);
  assert.deepEqual(resources('clued_record_list', { level: 'project', project_id: project }, ['context:read']), [`permission:project:${project}/read`]);
  assert.deepEqual(resources('clued_search_context', {}, ['context:read']), ['permission:global/read']);
  assert.deepEqual(resources('clued_audit_receipts', {}, ['audit:read']), ['permission:global/audit']);
});

test('close and restore are their own actions', () => {
  assert.deepEqual(resources('clued_record_mutate', { operation: 'close', scope: 'global' }, ['context:write']), ['permission:global/close']);
  assert.deepEqual(resources('clued_record_mutate', { operation: 'restore', scope: 'global' }, ['context:write']), ['permission:global/restore']);
});

test('no suggestion is guessed when the context or action cannot be told', () => {
  for (const [name, args, scopes] of [
    ['clued_project_mutate', {}, ['context:write']],
    ['clued_context', { op: 'record_put' }, ['context:write']],
    ['clued_record_list', { project_id: project }, ['context:read']],
    ['clued_record_mutate', { scope: 'project:not-a-uuid' }, ['context:write']],
    ['clued_unknown', {}, null],
  ]) {
    const { error } = permissionDenial('insufficient_scope', name, args, scopes);
    assert.equal(error.category, 'permission');
    assert.equal('suggested_request' in error, false, name);
    assert.equal('missing' in error, false, name);
    assert.match(error.message, /reconnect/);
  }
});

test('the suggestion is a valid connection.permission request and grants nothing by itself', () => {
  const { error } = permissionDenial('binding_not_authorized', 'clued_record_mutate', { scope: 'global' }, ['context:write']);
  assert.deepEqual(Object.keys(error.suggested_request).sort(), ['action', 'idempotency_key', 'resources']);
  assert.match(error.suggested_request.resources[0], /^permission:(global|profile|project:[0-9a-f-]{36})\/(read|write|close|restore|audit)$/);
  assert.ok(error.suggested_request.idempotency_key.length <= 160);
  assert.match(error.message, /confirm_url/);
  assert.match(error.message, /same connection/);
});
