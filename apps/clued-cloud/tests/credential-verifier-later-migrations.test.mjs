import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Since 20261008210000_credential_verifier_v1, stored credentials are verifiers: a function must compare
// clued_private.credential_verifier_v1(<proof>) with them, never the proof itself. credential-verifier-db.test.mjs
// checks the functions as that migration leaves them; a function a later migration writes is checked here, by its
// source, so the unit suite catches it (20261031080000 created storage_route_destination_v1 with a raw comparison,
// so no file was ever placed in 90_待归类: Clued Task e21ff6fd, fixed by 20261106010000).

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const VERIFIER_MIGRATION = '20261008210000_credential_verifier_v1.sql';
// The same expression credential-verifier-db.test.mjs uses.
const RAW_COMPARISON = /(?<![\w.])(?<!set )(?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash|authority_token_hash)\s*(?:=|<>|is distinct from|is not distinct from)\s*(?:p_\w+|h|reader_hash|writer_hash)(?!\w)/;
// Each entry names the file and why its raw comparison is not a live one.
const KNOWN = new Map([
  ['20261031080000_storage_drive_alignment_v1.sql', 'storage_route_destination_v1, rewritten to the verifier by 20261106010000'],
  ['20261106010000_storage_route_destination_verifier_v1.sql', 'the raw comparison is the anchor it replaces'],
]);

const code = (sql) => sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');

test('migrations after the credential verifier compare stored credentials with the verifier of a proof', () => {
  const later = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql') && name > VERIFIER_MIGRATION).sort();
  assert.ok(later.includes('20261106010000_storage_route_destination_verifier_v1.sql'), 'the fix is among the files checked');
  const raw = later.filter((name) => RAW_COMPARISON.test(code(fs.readFileSync(path.join(migrations, name), 'utf8'))));
  assert.deepEqual(raw.filter((name) => !KNOWN.has(name)), [], 'compare with clued_private.credential_verifier_v1(<proof>)');
  assert.deepEqual([...KNOWN.keys()].filter((name) => !raw.includes(name)), [], 'a known entry that no longer matches is removed');
});

test('the fix rewrites exactly the one comparison of storage_route_destination_v1', () => {
  const fix = fs.readFileSync(path.join(migrations, '20261106010000_storage_route_destination_verifier_v1.sql'), 'utf8');
  const created = fs.readFileSync(path.join(migrations, '20261031080000_storage_drive_alignment_v1.sql'), 'utf8');
  const anchor = 'where b.token_hash=p_hash and b.revoked_at is null;';
  assert.equal(created.split(anchor).length - 1, 1, 'the definition 20261031080000 created holds the anchor once');
  assert.ok(fix.includes(`anchor constant text := '${anchor}'`));
  assert.ok(fix.includes("rewritten constant text := 'where b.token_hash=clued_private.credential_verifier_v1(p_hash) and b.revoked_at is null;'"));
  assert.match(fix, /if strpos\(body, anchor\) = 0 and strpos\(body, rewritten\) > 0 then return; end if;/, 'a second run changes nothing');
  assert.match(fix, /if hits <> 1 then\s+raise exception 'storage_route_verifier_definition_mismatch'/);
  assert.match(fix, /execute replace\(body, anchor, rewritten\);/);
});
