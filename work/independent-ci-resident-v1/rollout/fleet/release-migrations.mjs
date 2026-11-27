import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { insist } from './release-admission.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const manifest = 'work/independent-ci-resident-v1/rollout/fleet/release-migrations.json';
const sqlDir = 'apps/clued-cloud/supabase/migrations';
const version = /^[0-9]{14}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const procedure = name => `to_regprocedure('${name}') is not null`;
const relation = name => `to_regclass('${name}') is not null`;
const probes = {
  train: `${relation('clued_private.ci_train_batches_v2')} and ${procedure('clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)')}`,
  landing: `${relation('clued_private.ci_train_landing_receipts_v2')} and ${relation('clued_private.ci_train_member_receipts_v2')}
    and ${procedure('clued_private.ci_train_record_landing_v2(public.clued_agent_bindings,text,text,jsonb,jsonb)')}`,
  delivery: `${procedure('clued_private.fleet_delivery_registry_v1(jsonb)')} and ${procedure('clued_private.fleet_delivery_seal_v1(jsonb)')}
    and (select count(*) = 2 from pg_attribute where attrelid = to_regclass('clued_private.fleet_accepted_v1')
      and attname in ('sealed_at', 'acceptance_sha256') and not attisdropped)`,
};

export function releaseRequirements(commit, read = file => execFileSync('git', ['show', `${commit}:${file}`], {
  cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 << 20,
})) {
  insist(/^[0-9a-f]{40}$/.test(commit), 'FLEET_RELEASE_SUBJECT_REFUSED');
  const entries = JSON.parse(read(manifest).toString('utf8'));
  insist(Array.isArray(entries) && entries.length > 0 && entries.length <= 64, 'FLEET_MIGRATION_REQUIREMENTS_REFUSED');
  const files = new Set(), names = new Set(), versions = new Set(), seenProbes = new Set();
  const requirements = entries.map(({ file, requires, probe }) => {
    const match = /^([0-9]{14})_([a-z0-9_]+)\.sql$/.exec(file);
    insist(match && !files.has(file) && !names.has(match[2]) && !versions.has(match[1]) && Object.hasOwn(probes, probe) && !seenProbes.has(probe) &&
      Array.isArray(requires) && new Set(requires).size === requires.length && requires.every(dep => files.has(dep)),
    'FLEET_MIGRATION_REQUIREMENTS_REFUSED', file);
    const bytes = read(`${sqlDir}/${file}`);
    const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    insist(sql.endsWith('\n') && !/[\x00-\x02\r]|^\\\.$/m.test(sql), 'FLEET_MIGRATION_FILE_REFUSED', file);
    files.add(file);
    names.add(match[2]);
    versions.add(match[1]);
    seenProbes.add(probe);
    return { file, version: match[1], name: match[2], digest: sha256(bytes), requires, probe };
  });
  insist(Object.keys(probes).every(probe => seenProbes.has(probe)), 'FLEET_MIGRATION_REQUIREMENTS_REFUSED');
  return requirements;
}

export function missingMigrations(requirements, snapshot) {
  insist(snapshot?.base === true && Array.isArray(snapshot.applied) && snapshot.interfaces &&
    snapshot.applied.length <= requirements.length, 'FLEET_MIGRATION_SNAPSHOT_REFUSED');
  const byName = new Map(requirements.map(row => [row.name, row]));
  const applied = new Map(), seenVersions = new Set();
  for (const row of snapshot.applied) {
    const expected = byName.get(row?.name);
    insist(expected && !applied.has(row.name) && typeof row.version === 'string' && version.test(row.version) && !seenVersions.has(row.version) &&
      row.digest === expected.digest, 'FLEET_MIGRATION_LEDGER_CONFLICT', row?.name);
    applied.set(row.name, row.version);
    seenVersions.add(row.version);
  }
  const installed = new Map();
  return requirements.flatMap(row => {
    const observed = applied.get(row.name);
    insist(snapshot.interfaces[row.probe] === Boolean(observed), 'FLEET_MIGRATION_INTERFACE_MISMATCH', row.file);
    if (observed) insist(row.requires.every(dep => installed.get(dep) && installed.get(dep) < observed), 'FLEET_MIGRATION_DEPENDENCY_MISMATCH', row.file);
    installed.set(row.file, observed);
    return observed ? [] : [row.file];
  });
}

export const requirementsDigest = requirements => sha256(JSON.stringify(requirements));
export const SNAPSHOT_LABEL = 'CLUED_FLEET_MIGRATIONS_V1';

export function readbackSql(requirements) {
  const quote = values => values.map(value => `'${value}'`).join(',');
  const names = quote(requirements.map(row => row.name));
  const versions = quote(requirements.map(row => row.version));
  const interfaces = Object.entries(probes).map(([key, probe]) => `'${key}', (${probe})`).join(',\n');
  return `begin isolation level repeatable read read only;
select jsonb_build_object('base', ${procedure('clued_private.release_door_v1(jsonb)')}
    and ${procedure('clued_private.fleet_accept_door_v1(jsonb)')},
  'applied', coalesce((select jsonb_agg(jsonb_build_object('version', version, 'name', name,
    'digest', encode(sha256(convert_to(array_to_string(statements, ''), 'UTF8')), 'hex')) order by version)
    from supabase_migrations.schema_migrations where name in (${names}) or version in (${versions})), '[]'::jsonb),
  'interfaces', jsonb_build_object(${interfaces}));
commit;\n`;
}

function readProduction(requirements, rawUrl) {
  const ref = 'ccxsikzwxlolxqlosril';
  let url;
  try { url = new URL(rawUrl); } catch { insist(false, 'FLEET_MIGRATION_DATABASE_REFUSED'); }
  const direct = url.hostname === `db.${ref}.supabase.co` && (!url.port || url.port === '5432');
  const pool = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && ['5432', '6543'].includes(url.port) &&
    decodeURIComponent(url.username).split('.').at(-1) === ref;
  insist(['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/postgres' && (direct || pool) &&
    ![...url.searchParams.keys()].some(k => ['host', 'hostaddr', 'port', 'dbname', 'database', 'user', 'service', 'servicefile'].includes(k.toLowerCase())),
  'FLEET_MIGRATION_DATABASE_REFUSED');
  url.searchParams.delete('uselibpqcompat');
  url.searchParams.set('sslmode', 'verify-full');
  if (!url.searchParams.has('sslrootcert')) url.searchParams.set('sslrootcert', 'system');
  try {
    const reply = execFileSync('docker', ['run', '--rm', '-i', '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'DATABASE_URL',
      'postgres@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929',
      'sh', '-c', 'exec psql "$DATABASE_URL" -X -q -tA -v ON_ERROR_STOP=1'], {
      env: { ...process.env, DATABASE_URL: url.href }, input: readbackSql(requirements), stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 90_000, maxBuffer: 64 << 10,
    });
    return JSON.parse(reply.toString('utf8'));
  } catch { insist(false, 'FLEET_MIGRATION_SNAPSHOT_UNREADABLE'); }
}

if (import.meta.main) {
  try {
    const env = process.env;
    const phase = process.argv[2];
    insist(['read', 'before-migrate', 'after-migrate'].includes(phase) && env.GITHUB_SHA === env.EXPECTED_RELEASE_SHA &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) && env.GITHUB_RUN_ATTEMPT === '1', 'FLEET_MIGRATION_RUN_REFUSED');
    const requirements = releaseRequirements(env.GITHUB_SHA);
    const snapshot = readProduction(requirements, env.CLUED_ATTESTATION_DATABASE_URL);
    const missing = missingMigrations(requirements, snapshot);
    if (phase === 'before-migrate') insist(missing.length > 0 && missing.join(',') === env.MIGRATIONS, 'FLEET_MIGRATION_PLAN_CHANGED', { missing });
    if (phase !== 'before-migrate') console.log(SNAPSHOT_LABEL, JSON.stringify({ commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
      requirementsSha256: requirementsDigest(requirements), snapshot }));
    if (phase === 'after-migrate') insist(missing.length === 0, 'FLEET_MIGRATION_INCOMPLETE', { missing });
  } catch (error) {
    console.error(error.code ?? 'FLEET_MIGRATION_READBACK_REFUSED', JSON.stringify(error.detail ?? null));
    process.exitCode = 1;
  }
}
