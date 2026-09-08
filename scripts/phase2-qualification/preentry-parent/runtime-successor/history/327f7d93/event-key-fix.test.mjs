import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveEventKey} from './supervisor.mjs';
test('maximum original GA key derives bounded deterministic SQL keys',()=>{
 const raw=JSON.stringify({gate_authorization_id:'ga_synthetic',idempotency_key:'a'.repeat(128)});
 const key=deriveEventKey(raw,'CREATE','sent');
 assert.equal(key.length,70);assert.match(key,/^[A-Za-z0-9_-]{1,128}$/);assert.equal(deriveEventKey(raw,'CREATE','sent'),key);
});
test('event keys bind complete GA bytes, fixed operation and phase independently',()=>{
 const values=[deriveEventKey('{}','CREATE','sent'),deriveEventKey('{}','START','sent'),deriveEventKey('{}','CREATE','observed'),deriveEventKey('{"x":1}','CREATE','sent')];
 assert.equal(new Set(values).size,4);assert.throws(()=>deriveEventKey('{}','DELETE','sent'));assert.throws(()=>deriveEventKey('{}','CREATE','other'));
});
