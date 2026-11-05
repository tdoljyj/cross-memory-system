import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileVersion, migrationsDirectory } from '../scripts/migration-ledger.mjs';

// Since 20261008210000_credential_verifier_v1, stored credentials are verifiers: a function must compare
// clued_private.credential_verifier_v1(<proof>) with them, never the proof itself. credential-verifier-db.test.mjs
// checks the functions as that migration leaves them, and 20261106010000 repeats its pg_proc guard; a function a
// later migration writes is also checked here, by its source, so the unit suite catches it (20261031080000 created
// storage_route_destination_v1 with a raw comparison, so no file was ever placed in 90_待归类: Clued Task e21ff6fd,
// fixed by 20261106010000).

const VERIFIER_VERSION = fileVersion('20261008210000_credential_verifier_v1.sql');
const FIX = '20261106010000_storage_route_destination_verifier_v1.sql';
const STORED = String.raw`(?:(?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash|authority_token_hash)|\w+\s*->>?\s*'(?:token_hash|reader_hash|writer_hash|renewal_hash)')`;
const PROOF = String.raw`(?:p_\w+|v_\w+|h|reader_hash|writer_hash|\$\d+)`;
const OPERATOR = String.raw`\s*(?:=|<>|!=|is\s+(?:not\s+)?distinct\s+from)\s*`;
// Wider than the expression credential-verifier-db.test.mjs uses: either order, = any(...) and in (...), positional
// and v_ parameters, JSON fields, any case. `set token_hash=...` is an assignment (the trigger converts it).
const RAW_COMPARISON = new RegExp(
  String.raw`(?<![\w.$])(?<!set )${STORED}(?:${OPERATOR}(?:(?:any|all)\s*\(\s*)?|\s+in\s*\(\s*)${PROOF}(?![\w(])` +
    String.raw`|(?<![\w.$:])${PROOF}${OPERATOR}${STORED}(?!\w)`,
  'gi',
);
// Each file's raw comparisons, exactly as written, that are not live ones.
// clued_private.native_confirmation_tokens keeps the sha256 of a confirmation token: it is not one of the
// credential tables 20261008210000 turned into verifiers, so comparing it with v_hash (that sha256) is right.
const KNOWN = {
  '20261023010000_ci_admission_handover_v1.sql': ['t.token_hash=v_hash', 'x.token_hash=v_hash'],
  // storage_route_destination_v1, rewritten to the verifier by 20261106010000.
  '20261031080000_storage_drive_alignment_v1.sql': ['b.token_hash=p_hash'],
  '20261031085000_ci_heartbeat_scope_v1.sql': ['t.token_hash=v_hash'],
  '20261031090000_merge_train_failover_v1.sql': ['x.token_hash=v_hash', 'x.token_hash=v_hash'],
};

// Comments and string literals go; a JSON key (->>'reader_hash') stays, and dollar-quoted bodies are read as code.
function code(sql) {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else if (sql[i] === "'") {
      let end = i + 1;
      while (end < sql.length && !(sql[end] === "'" && sql[end + 1] !== "'")) end += sql[end] === "'" ? 2 : 1;
      out += /->>?\s*$/.test(out) ? sql.slice(i, end + 1) : "''";
      i = end + 1;
    } else {
      out += sql[i++];
    }
  }
  return out;
}

const rawComparisons = (sql) => [...code(sql).matchAll(RAW_COMPARISON)].map((m) => m[0]);

test('the scanner finds raw comparisons in either order and ignores comments, literals and assignments', () => {
  const found = (sql) => rawComparisons(`create function f() returns void language sql as $$ ${sql} $$;`);
  for (const sql of [
    'select 1 where b.token_hash=p_hash', 'where p_hash = b.token_hash', 'WHERE B.TOKEN_HASH = P_HASH',
    'where token_hash = any($1)', 'where token_hash in (v_hash)', 'where token_hash=$1', 'where token_hash is not distinct from h',
    "where request->>'reader_hash'=h", "where h = request->>'writer_hash'",
  ]) assert.equal(found(sql).length, 1, sql);
  for (const sql of [
    'where b.token_hash=clued_private.credential_verifier_v1(p_hash)', 'update t set token_hash=p_hash',
    '-- where token_hash=p_hash', '/* where token_hash=p_hash */', "select 'where token_hash=p_hash'",
    'v_hash := token_hash', 'where token_hash = any(clued_private.credential_verifier_v1(p_hash))',
  ]) assert.deepEqual(found(sql), [], sql);
});

test('migrations after the credential verifier compare stored credentials with the verifier of a proof', () => {
  const later = fs.readdirSync(migrationsDirectory)
    .filter((name) => (fileVersion(name) ?? '') > VERIFIER_VERSION).sort();
  assert.ok(later.includes(FIX), 'the fix is among the files checked');
  const raw = Object.fromEntries(later
    .map((name) => [name, rawComparisons(fs.readFileSync(path.join(migrationsDirectory, name), 'utf8'))])
    .filter(([, hits]) => hits.length));
  assert.deepEqual(raw, KNOWN, 'compare with clued_private.credential_verifier_v1(<proof>); remove known entries that no longer match');
});

test('the fix rewrites the one comparison of storage_route_destination_v1 to the verifier', () => {
  const created = fs.readFileSync(path.join(migrationsDirectory, '20261031080000_storage_drive_alignment_v1.sql'), 'utf8');
  const fix = fs.readFileSync(path.join(migrationsDirectory, FIX), 'utf8');
  const anchor = 'where b.token_hash=p_hash and b.revoked_at is null;';
  assert.equal(created.split(anchor).length - 1, 1, 'the definition 20261031080000 created holds the anchor once');
  assert.ok(fix.includes(`anchor constant text := '${anchor}'`));
  assert.ok(fix.includes(`rewritten constant text := '${anchor.replace('=p_hash', '=clued_private.credential_verifier_v1(p_hash)')}'`));
});
