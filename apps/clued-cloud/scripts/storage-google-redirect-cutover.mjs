// Offline SQL generation only. No database, provider, or credential access.
import { readFile, stat } from 'node:fs/promises';

export const VERSION = '1.0.1';
const CONTRACT = 'kooyumi.storage-google-redirect-cutover/1';
export const GOOGLE_CLIENT_ID = '980987540427-hu235tq06q94cak7hsm9a6ds88kvpdig.apps.googleusercontent.com';
export const OLD_CALLBACK = 'https://clued.pixelgrav.com/storage/google/callback';
export const NEW_CALLBACK = 'https://kooyumi.pixelgrav.com/storage/google/callback';
const FLAGS = ['execution_enabled', 'read_enabled', 'onboard_open'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => { throw new Error('storage_google_redirect_input_invalid'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

export function validateCutover(input) {
  if (!exactKeys(input, ['contract', 'storage_issuer_id', 'direction', 'expected_flags'])
      || input.contract !== CONTRACT || typeof input.storage_issuer_id !== 'string'
      || !UUID.test(input.storage_issuer_id) || input.storage_issuer_id === '00000000-0000-0000-0000-000000000000'
      || !['forward', 'reverse'].includes(input.direction)
      || !exactKeys(input.expected_flags, FLAGS)
      || FLAGS.some(key => typeof input.expected_flags[key] !== 'boolean')) fail();
  return {
    contract: CONTRACT, storage_issuer_id: input.storage_issuer_id, direction: input.direction,
    expected_flags: Object.fromEntries(FLAGS.map(key => [key, input.expected_flags[key]])),
  };
}

// Match the actual callback eligibility, not every historical claimed row.
// Onboarding's staged/failed credentials resume without another Google callback.
function callbackPredicate(instant) {
  return `x.status IN ('prepared','claimed') AND x.expires_at>${instant}
      AND (x.purpose IN ('connection','credential_recovery') OR
        (x.purpose='onboard' AND EXISTS (
          SELECT 1 FROM clued_private.storage_onboard_attempts_v1 o
          WHERE o.id=x.onboard_attempt_id AND o.oauth_attempt_id=x.id
            AND o.issuer_hash=x.issuer_hash AND o.owner_id=x.owner_id AND o.session_id=x.session_id
            AND o.state='begun' AND o.expires_at>${instant})))`;
}

// Minimal deployment metadata: no issuer legacy keys, envelopes, tokens, subjects,
// account records, or Canonical data leave the database in this read-only result.
// Run again after an uncertain outcome before deciding whether any action remains.
export function buildPreflightSql() {
  return `BEGIN READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='15s';
WITH observed AS (SELECT clock_timestamp() AS checked_at)
SELECT i.id AS storage_issuer_id, a.oauth_client_id, a.redirect_uri,
  a.execution_enabled, a.read_enabled, a.onboard_open,
  (SELECT count(*) FROM clued_private.storage_oauth_apps_v1 a0
    WHERE a0.oauth_client_id='${GOOGLE_CLIENT_ID}' AND a0.revoked_at IS NULL) AS active_app_count,
  (SELECT count(*) FROM clued_private.storage_oauth_attempts_v1 x
    WHERE x.issuer_hash=a.issuer_hash AND ${callbackPredicate('observed.checked_at')}) AS callback_live,
  (SELECT count(*) FROM clued_private.storage_onboard_attempts_v1 o
    WHERE o.issuer_hash=a.issuer_hash AND o.state IN ('credential_staged','failed')
      AND o.expires_at>observed.checked_at AND o.credential_envelope IS NOT NULL) AS postexchange_resumable_live,
  (SELECT count(*) FROM clued_private.storage_oauth_attempts_v1 x
    WHERE x.issuer_hash=a.issuer_hash AND x.status='claimed'
      AND (x.expires_at<=observed.checked_at OR (x.purpose='onboard' AND EXISTS (
        SELECT 1 FROM clued_private.storage_onboard_attempts_v1 o
        WHERE o.id=x.onboard_attempt_id AND o.expires_at<=observed.checked_at)))) AS expired_claimed_history
FROM clued_private.storage_oauth_apps_v1 a
LEFT JOIN clued_private.issuer_identities_v1 i ON i.kind='storage' AND i.legacy_key=a.issuer_hash
CROSS JOIN observed
WHERE a.oauth_client_id='${GOOGLE_CLIENT_ID}' AND a.revoked_at IS NULL
ORDER BY i.id;
COMMIT;
`;
}

export function buildCutoverSql(input) {
  const m = validateCutover(input);
  const [from, to] = m.direction === 'forward' ? [OLD_CALLBACK, NEW_CALLBACK] : [NEW_CALLBACK, OLD_CALLBACK];
  const flags = alias => FLAGS.map(key => `${alias}.${key} IS NOT DISTINCT FROM ${m.expected_flags[key]}`).join('\n      AND ');
  return `-- Reviewed deployment configuration only; not a schema migration or RPC.
-- Quiesce new consent starts externally first. Zero live callbacks is not global
-- quiescence: a Worker may be between describe, seal and prepare. A brief mismatch
-- fails closed; an unfinished consent may require a fresh authorization.
-- Never retry or roll back an unknown outcome without reading preflight metadata.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $storage_google_redirect$
DECLARE
  v_owner name;
  v_issuer_key text;
  v_checked_at timestamptz;
  v_callback_live bigint;
  v_rows bigint;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_class c WHERE c.oid='clued_private.storage_oauth_apps_v1'::regclass;
  IF current_user IN ('anon','authenticated','service_role','authenticator')
      OR current_user IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'storage_google_redirect_operator_required' USING ERRCODE='42501';
  END IF;
  LOCK TABLE clued_private.storage_oauth_apps_v1 IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) FROM clued_private.storage_oauth_apps_v1 a
      WHERE a.oauth_client_id='${GOOGLE_CLIENT_ID}' AND a.revoked_at IS NULL)<>1 THEN
    RAISE EXCEPTION 'storage_google_redirect_active_app_conflict' USING ERRCODE='40001';
  END IF;
  BEGIN
    SELECT a.issuer_hash INTO STRICT v_issuer_key
      FROM clued_private.storage_oauth_apps_v1 a
      JOIN clued_private.issuer_identities_v1 i ON i.legacy_key=a.issuer_hash AND i.kind='storage'
      WHERE i.id='${m.storage_issuer_id}'::uuid
        AND a.oauth_client_id='${GOOGLE_CLIENT_ID}' AND a.redirect_uri='${from}'
        AND a.revoked_at IS NULL AND ${flags('a')}
      FOR UPDATE OF a;
  EXCEPTION WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'storage_google_redirect_compare_failed' USING ERRCODE='40001';
  END;
  v_checked_at:=clock_timestamp();
  SELECT count(*) INTO v_callback_live FROM clued_private.storage_oauth_attempts_v1 x
    WHERE x.issuer_hash=v_issuer_key AND ${callbackPredicate('v_checked_at')};
  IF v_callback_live<>0 THEN
    RAISE EXCEPTION 'storage_google_redirect_callbacks_live' USING ERRCODE='40001';
  END IF;
  UPDATE clued_private.storage_oauth_apps_v1 a SET redirect_uri='${to}'
    WHERE a.issuer_hash=v_issuer_key AND a.oauth_client_id='${GOOGLE_CLIENT_ID}'
      AND a.redirect_uri='${from}' AND a.revoked_at IS NULL AND ${flags('a')}
      AND EXISTS (SELECT 1 FROM clued_private.issuer_identities_v1 i
        WHERE i.id='${m.storage_issuer_id}'::uuid AND i.kind='storage' AND i.legacy_key=a.issuer_hash);
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'storage_google_redirect_update_conflict' USING ERRCODE='40001';
  END IF;
END
$storage_google_redirect$;
COMMIT;
`;
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--preflight-sql') return buildPreflightSql();
  if (args.length !== 2 || args[0] !== '--sql') throw new Error(
    'usage: storage-google-redirect-cutover.mjs --preflight-sql | --sql <reviewed-metadata.json>');
  if ((await stat(args[1])).size > 4096) fail();
  const source = await readFile(args[1], 'utf8');
  if (Buffer.byteLength(source, 'utf8') > 4096) fail();
  let input;
  try { input = JSON.parse(source); } catch { fail(); }
  return buildCutoverSql(input);
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main(process.argv.slice(2)).then(sql => process.stdout.write(sql)).catch(error => {
    // Never echo untrusted metadata or file contents, including parse errors.
    process.stderr.write(error.message.startsWith('usage:') ? error.message + '\n'
      : 'storage_google_redirect_generation_failed\n');
    process.exitCode = 1;
  });
}
