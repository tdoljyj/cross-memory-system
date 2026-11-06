// Offline SQL generator. Cloudflare and Supabase operations belong to the
// authenticated operator connectors; this module has no network or DB transport.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const FIXED = Object.freeze({
  contract: 'kooyumi.authorization-issuer-provision/1',
  resource: 'https://kooyumi.pixelgrav.com/mcp',
  worker_name: 'clued-cloud',
  secret_name: 'KOOYUMI_AUTHORIZATION_ISSUER_TOKEN',
  old_kv_id: 'd7e56a5789854d42b191333d8b545a97',
  new_kv_id: '84dba66392314bbf82856574f85122fc',
  cloudflare_secret_confirmed: true,
});
const KEYS = [...Object.keys(FIXED), 'identity_key', 'verifier'];
const verifierOf = proof => 'cv1:' + createHash('sha256')
  .update('clued.credential-verifier.v1:' + proof, 'utf8').digest('hex');
class OperatorInputError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = () => { throw new OperatorInputError('kooyumi_issuer_metadata_invalid'); };

export function validateMetadata(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(input, key)) ||
      Object.entries(FIXED).some(([key, value]) => input[key] !== value)) fail();
  if (typeof input.identity_key !== 'string' || input.identity_key.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(input.identity_key) || typeof input.verifier !== 'string' ||
      input.verifier.length !== 68 || !/^cv1:[0-9a-f]{64}$/.test(input.verifier) ||
      input.verifier === verifierOf(input.identity_key)) fail();
  return Object.freeze(Object.fromEntries(KEYS.map(key => [key, input[key]])));
}

export function safeSummary(input) {
  validateMetadata(input);
  return { ...FIXED, database_status: 'not_verified', credential_material_in_output: false };
}

export function buildProvisionSql(input) {
  const m = validateMetadata(input);
  // Only exact constants and fixed-length hex values can enter this SQL.
  return `-- Technical issuer configuration only. No business data or old issuer is changed.
-- The matching new Cloudflare secret must already be confirmed; keep the new origin inactive.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $kooyumi_issuer$
DECLARE
  identity_key constant text := '${m.identity_key}';
  expected_verifier constant text := '${m.verifier}';
  target_resource constant text := '${m.resource}';
  v_issuer_id uuid;
  credential_generation bigint;
  registered clued_private.authorization_issuers_v12;
BEGIN
  IF current_user IN ('anon','authenticated','service_role','authenticator') OR
    (SELECT count(*) FROM pg_proc p WHERE p.oid IN (
      to_regprocedure('clued_private.issuer_credential_stage_v1(uuid,text)'),
      to_regprocedure('clued_private.issuer_credential_activate_v1(uuid,bigint)'))
      AND pg_get_userbyid(p.proowner) = current_user AND NOT p.prosecdef) <> 2 THEN
    RAISE EXCEPTION 'kooyumi_issuer_database_operator_required' USING ERRCODE='42501';
  END IF;
  IF strpos(pg_get_functiondef(to_regprocedure('public.clued_authorization_prepare_v12(text,jsonb)')),
       'issuer_resolve_identity_compatible_v1') IS NOT DISTINCT FROM 0 OR
     to_regprocedure('public.clued_authorization_prepare_v12(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'kooyumi_issuer_successor_required' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid='clued_private.authorization_issuers_v12'::regclass
        AND t.tgname='issuer_identity_provision_v1' AND t.tgenabled IN ('O','A')
        AND t.tgfoid=to_regprocedure('clued_private.issuer_identity_provision_v1()')) THEN
    RAISE EXCEPTION 'kooyumi_issuer_identity_trigger_required' USING ERRCODE='55000';
  END IF;
  IF expected_verifier='cv1:'||encode(extensions.digest(
       'clued.credential-verifier.v1:'||identity_key,'sha256'),'hex') THEN
    RAISE EXCEPTION 'kooyumi_issuer_identity_is_not_a_credential' USING ERRCODE='22023';
  END IF;

  -- The resource has no UNIQUE constraint. Briefly serialize registration and
  -- rotation writes; existing issuer reads and ordinary business calls continue.
  LOCK TABLE clued_private.authorization_issuers_v12 IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM clued_private.authorization_issuers_v12
      WHERE resource=target_resource AND token_hash<>identity_key) THEN
    RAISE EXCEPTION 'kooyumi_issuer_resource_already_registered' USING ERRCODE='40001';
  END IF;
  SELECT * INTO registered FROM clued_private.authorization_issuers_v12
    WHERE token_hash=identity_key FOR UPDATE;
  IF FOUND THEN
    -- Recover an unknown COMMIT only when this exact first generation is active.
    -- Never replace a changed, expired, revoked, staged or retired generation.
    IF registered.resource<>target_resource OR registered.name<>'Kooyumi OAuth issuer'
      OR registered.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'kooyumi_issuer_existing_identity_conflict' USING ERRCODE='40001';
    END IF;
    SELECT id INTO STRICT v_issuer_id FROM clued_private.issuer_identities_v1
      WHERE kind='authorization' AND legacy_key=identity_key;
    SELECT generation INTO credential_generation FROM clued_private.issuer_credentials_v1 c
      WHERE c.issuer_id=v_issuer_id AND c.verifier=expected_verifier AND c.state='active'
        AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp());
    IF credential_generation IS NULL OR
      (SELECT count(*) FROM clued_private.issuer_credentials_v1 c WHERE c.issuer_id=v_issuer_id)<>1 THEN
      RAISE EXCEPTION 'kooyumi_issuer_existing_credential_conflict' USING ERRCODE='40001';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM clued_private.issuer_identities_v1
        WHERE kind='authorization' AND legacy_key=identity_key) THEN
      RAISE EXCEPTION 'kooyumi_issuer_orphan_identity_conflict' USING ERRCODE='40001';
    END IF;
    INSERT INTO clued_private.authorization_issuers_v12(token_hash,resource,name)
      VALUES(identity_key,target_resource,'Kooyumi OAuth issuer');
    SELECT id INTO STRICT v_issuer_id FROM clued_private.issuer_identities_v1
      WHERE kind='authorization' AND legacy_key=identity_key;
    IF EXISTS (SELECT 1 FROM clued_private.issuer_credentials_v1 c WHERE c.issuer_id=v_issuer_id) THEN
      RAISE EXCEPTION 'kooyumi_issuer_implicit_credential_forbidden' USING ERRCODE='55000';
    END IF;
    credential_generation := clued_private.issuer_credential_stage_v1(v_issuer_id,expected_verifier);
    PERFORM clued_private.issuer_credential_activate_v1(v_issuer_id,credential_generation);
  END IF;
END
$kooyumi_issuer$;
COMMIT;
`;
}

export function buildVerificationSql(input) {
  const m = validateMetadata(input);
  return `BEGIN READ ONLY;
SELECT i.id AS issuer_id, a.resource,
  a.revoked_at IS NULL AS issuer_active,
  min(c.generation) FILTER (WHERE c.verifier='${m.verifier}' AND c.state='active'
    AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())) AS credential_generation,
  count(c.generation) AS total_generations,
  count(c.generation) FILTER (WHERE c.state='active'
    AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())) AS usable_credentials,
  coalesce(bool_or(c.verifier='${m.verifier}' AND c.state='active'
    AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())),false) AS expected_credential_active,
  count(c.generation) FILTER (WHERE c.state='active' AND c.verifier='cv1:'||encode(
    extensions.digest('clued.credential-verifier.v1:'||i.legacy_key,'sha256'),'hex'))=0
    AS identity_is_not_active_proof
FROM clued_private.issuer_identities_v1 i
JOIN clued_private.authorization_issuers_v12 a ON a.token_hash=i.legacy_key
LEFT JOIN clued_private.issuer_credentials_v1 c ON c.issuer_id=i.id
WHERE i.kind='authorization' AND i.legacy_key='${m.identity_key}'
  AND a.resource='${m.resource}'
GROUP BY i.id,a.resource,a.revoked_at;
COMMIT;
`;
}

async function main(args) {
  if (args.length !== 2 || !['--summary', '--sql', '--verify-sql'].includes(args[0])) {
    throw new OperatorInputError('usage: kooyumi-issuer-provision.mjs --summary|--sql|--verify-sql <metadata.json>');
  }
  const path = resolve(args[1]);
  if ((await stat(path)).size > 8192) fail();
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > 8192) fail();
  const metadata = validateMetadata(JSON.parse(text));
  if (args[0] === '--sql') process.stdout.write(buildProvisionSql(metadata));
  else if (args[0] === '--verify-sql') process.stdout.write(buildVerificationSql(metadata));
  else process.stdout.write(JSON.stringify(safeSummary(metadata), null, 2) + '\n');
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write((error instanceof OperatorInputError ? error.code : 'kooyumi_issuer_input_unreadable') + '\n');
    process.exitCode = 1;
  });
}
