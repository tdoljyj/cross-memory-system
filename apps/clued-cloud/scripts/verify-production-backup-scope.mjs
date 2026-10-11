import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_SCHEMAS = Object.freeze(['public', 'clued_private', 'clued_watchdog', 'supabase_migrations']);
const selected = "('public','clued_private','clued_watchdog','supabase_migrations')";
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// This inventory and pg_dump use one exported READ ONLY snapshot. Definitions
// stay in process memory; only digests/counts are published. OIDs, rather than
// names parsed from human-readable TOC tags, bind catalog objects to the dump.
const objectQueries = [
  `select 'pg_namespace'::regclass::oid catalog,n.oid,n.nspname schema,'SCHEMA' kind,n.nspname name,
    0::oid parent_oid,true required,null::text definition,null::text relation_kind,0::oid row_type_oid
    from pg_namespace n where n.nspname in ${selected}`,
  `select 'pg_class'::regclass::oid,c.oid,n.nspname,
    case c.relkind when 'r' then 'TABLE' when 'p' then 'TABLE' when 'v' then 'VIEW'
      when 'm' then 'MATERIALIZED VIEW' when 'f' then 'FOREIGN TABLE' when 'S' then 'SEQUENCE'
      when 'i' then 'INDEX' when 'I' then 'INDEX' else 'IMPLICIT RELATION' end,c.relname,
    coalesce(i.indrelid,0),c.relkind in ('r','p','v','m','f','S') or
      (c.relkind in ('i','I') and not exists(select 1 from pg_constraint k where k.conindid=c.oid)),
    null,c.relkind::text,c.reltype from pg_class c join pg_namespace n on n.oid=c.relnamespace
    left join pg_index i on i.indexrelid=c.oid where n.nspname in ${selected}`,
  `select 'pg_proc'::regclass::oid,p.oid,n.nspname,
    case p.prokind when 'p' then 'PROCEDURE' when 'a' then 'AGGREGATE' else 'FUNCTION' end,
    p.proname,0,true,case when p.prokind in ('f','p') then pg_get_functiondef(p.oid)
      else p.oid::regprocedure::text end,null,0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ${selected}`,
  `select 'pg_type'::regclass::oid,t.oid,n.nspname,case when t.typtype='d' then 'DOMAIN' else 'TYPE' end,
    t.typname,coalesce(nullif(t.typrelid,0),t.typelem),
    (t.typrelid=0 and t.typelem=0 and t.typtype<>'p') or
      exists(select 1 from pg_class c where c.oid=t.typrelid and c.relkind='c'),null,null,t.typarray
    from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in ${selected}`,
  `select 'pg_constraint'::regclass::oid,k.oid,n.nspname,
    case when k.contype='f' then 'FK CONSTRAINT' else 'CONSTRAINT' end,k.conname,k.conrelid,
    k.contype in ('p','u','f','x') or (k.contype='c' and not k.convalidated),null,null,0
    from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname in ${selected}`,
  `select 'pg_attrdef'::regclass::oid,d.oid,n.nspname,'DEFAULT',a.attname,c.oid,
    a.attgenerated='',null,null,0 from pg_attrdef d join pg_class c on c.oid=d.adrelid
    join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum=d.adnum
    where n.nspname in ${selected}`,
  `select 'pg_trigger'::regclass::oid,t.oid,n.nspname,'TRIGGER',t.tgname,c.oid,not t.tgisinternal,null,null,0
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ${selected} and not t.tgisinternal`,
  `select 'pg_rewrite'::regclass::oid,r.oid,n.nspname,'RULE',r.rulename,c.oid,r.rulename<>'_RETURN',null,null,0
    from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ${selected} and r.rulename<>'_RETURN'`,
  `select 'pg_policy'::regclass::oid,p.oid,n.nspname,'POLICY',p.polname,c.oid,true,null,null,0
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ${selected}`,
  ...[
    ['pg_collation','collnamespace','collname','COLLATION'],
    ['pg_conversion','connamespace','conname','CONVERSION'],
    ['pg_operator','oprnamespace','oprname','OPERATOR'],
    ['pg_opclass','opcnamespace','opcname','OPERATOR CLASS'],
    ['pg_opfamily','opfnamespace','opfname','OPERATOR FAMILY'],
    ['pg_ts_config','cfgnamespace','cfgname','TEXT SEARCH CONFIGURATION'],
    ['pg_ts_dict','dictnamespace','dictname','TEXT SEARCH DICTIONARY'],
    ['pg_ts_parser','prsnamespace','prsname','TEXT SEARCH PARSER'],
    ['pg_ts_template','tmplnamespace','tmplname','TEXT SEARCH TEMPLATE'],
    ['pg_statistic_ext','stxnamespace','stxname','STATISTICS'],
  ].map(([catalog, namespace, name, kind]) => `select '${catalog}'::regclass::oid,o.oid,n.nspname,'${kind}',
    o.${name},0,true,null,null,0 from ${catalog} o join pg_namespace n on n.oid=o.${namespace}
    where n.nspname in ${selected}`),
];
export const BACKUP_INVENTORY_SQL = `with objects as (${objectQueries.join('\nunion all\n')})
  select jsonb_build_object('objects',(select jsonb_agg(to_jsonb(o) || jsonb_build_object('extension_member',
    exists(select 1 from pg_depend d where d.classid=o.catalog and d.objid=o.oid and d.deptype='e'))
    order by o.catalog,o.oid) from objects o),
    'data',(select coalesce(jsonb_agg(jsonb_build_object('oid',c.oid,'schema',n.nspname,'kind',
      case when c.relkind='m' then 'MATERIALIZED VIEW DATA' else 'TABLE DATA' end) order by c.oid),'[]'::jsonb)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ${selected}
      and (c.relkind='r' or (c.relkind='m' and c.relispopulated))))::text`;

export function validateInventory(inventory) {
  assert.ok(Array.isArray(inventory.objects) && Array.isArray(inventory.data), 'Missing snapshot inventory');
  for (const object of inventory.objects) {
    for (const key of ['catalog','oid','parent_oid','row_type_oid']) {
      object[key] = Number(object[key]);
      assert.ok(Number.isSafeInteger(object[key]) && object[key] >= 0, 'Invalid catalog identity');
    }
    assert.ok(BACKUP_SCHEMAS.includes(object.schema), 'Catalog inventory exceeds selected scope');
  }
  for (const object of inventory.data) object.oid = Number(object.oid);
  const schemas = inventory.objects.filter(o => o.kind === 'SCHEMA').map(o => o.schema).sort();
  assert.deepEqual(schemas, [...BACKUP_SCHEMAS].sort(), 'Missing required schema');
  assert.ok(!inventory.objects.some(o => o.extension_member), 'Extension-owned scope needs a separately reviewed backup contract');
  const migration = inventory.objects.filter(o => o.schema === 'supabase_migrations');
  const tables = migration.filter(o => o.kind === 'TABLE');
  assert.equal(tables.length, 1, 'Migration scope must contain exactly the history table');
  const table = tables[0];
  assert.ok(table.name === 'schema_migrations' && table.relation_kind === 'r', 'Unexpected migration history relation');
  const rowType = migration.find(o => o.kind === 'TYPE' && o.oid === table.row_type_oid);
  assert.ok(rowType, 'Missing migration history row type');
  const allowed = o => o.kind === 'SCHEMA' || o === table ||
    (o.kind === 'INDEX' && o.relation_kind === 'i' && o.parent_oid === table.oid) ||
    (['CONSTRAINT','FK CONSTRAINT','DEFAULT'].includes(o.kind) && o.parent_oid === table.oid) ||
    (o.kind === 'TYPE' && (o.oid === rowType.oid || o.oid === rowType.row_type_oid));
  assert.ok(migration.every(allowed), 'Unapproved object in migration schema');
  assert.deepEqual(inventory.data.filter(o => o.schema === 'supabase_migrations'),
    [{ oid: table.oid, schema: 'supabase_migrations', kind: 'TABLE DATA' }], 'Unexpected migration table data scope');
  return inventory;
}

const tocKinds = ['MATERIALIZED VIEW DATA','TEXT SEARCH CONFIGURATION','TEXT SEARCH DICTIONARY','TEXT SEARCH TEMPLATE',
  'TEXT SEARCH PARSER','DATABASE PROPERTIES','SEQUENCE OWNED BY','OPERATOR FAMILY','OPERATOR CLASS','MATERIALIZED VIEW',
  'FK CONSTRAINT','FOREIGN TABLE','TABLE ATTACH','INDEX ATTACH','TABLE DATA','SEQUENCE SET','ROW SECURITY',
  'CHECK CONSTRAINT','SEARCHPATH','STDSTRINGS','ENCODING','CONSTRAINT','PROCEDURE','FUNCTION','AGGREGATE','COLLATION',
  'CONVERSION','STATISTICS','DEFAULT','TRIGGER','POLICY','COMMENT','DOMAIN','SCHEMA','SEQUENCE','TABLE','VIEW','TYPE','INDEX','RULE','OPERATOR'];
function ancillaryIsBound(entry, inventory) {
  if (['ENCODING','STDSTRINGS','SEARCHPATH'].includes(entry.kind)) return entry.oid === 0;
  if (entry.kind === 'COMMENT') {
    if (/^- SCHEMA (public|clued_private|clued_watchdog|supabase_migrations) /.test(entry.tag)) return true;
    const schema = BACKUP_SCHEMAS.find(s => entry.tag.startsWith(s + ' '));
    if (!schema) return false;
    if (schema !== 'supabase_migrations') return true;
    return entry.tag.startsWith(schema + ' TABLE schema_migrations ') ||
      entry.tag.startsWith(schema + ' COLUMN schema_migrations.') ||
      inventory.objects.filter(o => o.schema === schema && ['INDEX','CONSTRAINT','FK CONSTRAINT'].includes(o.kind))
        .some(o => entry.tag.startsWith(schema + ' ' + o.kind + ' ' + o.name + ' '));
  }
  const objectKind = { 'SEQUENCE SET':'SEQUENCE','SEQUENCE OWNED BY':'SEQUENCE',
    'TABLE ATTACH':'TABLE','INDEX ATTACH':'INDEX','ROW SECURITY':'TABLE' }[entry.kind];
  return objectKind && inventory.objects.some(o => o.kind === objectKind &&
    (entry.oid === o.oid || (entry.oid === 0 && entry.tag.startsWith(o.schema + ' ' + o.name + ' '))) &&
    (o.schema !== 'supabase_migrations' || entry.kind === 'ROW SECURITY'));
}
export function verifyArchiveScope(inventory, toc) {
  validateInventory(inventory);
  const entries = toc.split(/\r?\n/).filter(line => line && !line.startsWith(';')).map(line => {
    const m = /^(\d+); (\d+) (\d+) (.*)$/.exec(line);
    assert.ok(m, 'Unrecognized archive TOC line');
    const kind = tocKinds.find(k => m[4].startsWith(k + ' '));
    assert.ok(kind, 'Unreviewed archive entry kind');
    return { catalog: Number(m[2]), oid: Number(m[3]), kind, tag: m[4].slice(kind.length + 1) };
  });
  const known = new Map(inventory.objects.map(o => [`${o.catalog}:${o.oid}`, o]));
  for (const entry of entries) {
    if (entry.catalog !== 0) assert.ok(known.has(`${entry.catalog}:${entry.oid}`), 'Archive contains an object outside snapshot scope');
    else if (['TABLE DATA','MATERIALIZED VIEW DATA'].includes(entry.kind)) {
      assert.ok(inventory.data.some(o => o.oid === entry.oid && o.kind === entry.kind), 'Archive contains unexpected table data');
    } else assert.ok(ancillaryIsBound(entry, inventory), 'Archive contains unbound metadata');
  }
  for (const object of inventory.objects.filter(o => o.required)) {
    assert.ok(entries.some(e => e.catalog === object.catalog && e.oid === object.oid &&
      (e.kind === object.kind || (object.kind === 'CONSTRAINT' && e.kind === 'CHECK CONSTRAINT'))),
    'Archive is missing a snapshot catalog object');
  }
  for (const object of inventory.data) assert.ok(entries.some(e => e.catalog === 0 && e.oid === object.oid && e.kind === object.kind),
    'Archive is missing snapshot table data');
  return {
    contract: 'clued.production-backup-scope.v1', verified: true,
    scope: ['public','clued_private','clued_watchdog','supabase_migrations.schema_migrations'],
    inventory_sha256: digest(JSON.stringify(inventory)), toc_sha256: digest(toc),
    catalog_objects: inventory.objects.length, required_objects: inventory.objects.filter(o => o.required).length,
    table_data_entries: inventory.data.length,
    routines: inventory.objects.filter(o => ['FUNCTION','PROCEDURE','AGGREGATE'].includes(o.kind)).length,
  };
}

export const backupDumpArguments = (snapshot, destination) => ['--format=custom','--no-owner','--no-privileges',
  ...BACKUP_SCHEMAS.map(schema => '--schema=' + schema), '--snapshot=' + snapshot, '--file=' + destination];

// session.query returns the single text result (or '' for transaction commands).
// An adapter keeps the production CLI dependency-free and lets regression tests
// use the same publisher with real local PostgreSQL client programs.
export async function createVerifiedBackup({ session, runPg, dumpPath }) {
  let begun = false;
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    const snapshot = await session.query('SELECT pg_export_snapshot()');
    assert.match(snapshot, /^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/, 'Invalid exported snapshot');
    const inventory = validateInventory(JSON.parse(await session.query(BACKUP_INVENTORY_SQL)));
    await runPg('pg_dump', backupDumpArguments(snapshot, dumpPath));
    const toc = await runPg('pg_restore', ['--list', dumpPath]);
    const proof = verifyArchiveScope(inventory, toc);
    await session.query('SELECT 1'); // A lost snapshot holder is a refusal, too.
    await session.query('ROLLBACK'); begun = false;
    return { ...proof, snapshot_sha256: digest(snapshot) };
  } finally {
    if (begun) await session.query('ROLLBACK').catch(() => {});
    await session.close();
  }
}

export function runBackupTool(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume(); // Do not echo connection strings or server details.
    child.once('error', () => reject(new Error('PostgreSQL backup tool could not start')));
    // exit can arrive before the last stdout chunk. A complete TOC is evidence
    // only after the pipes have closed and the producer has succeeded.
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error('PostgreSQL backup tool failed')));
  });
}

export class SnapshotSession {
  constructor(container) {
    this.child = spawn('docker', ['exec','-i',container,'sh','-ceu',
      'exec psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1'], { stdio: ['pipe','pipe','pipe'] });
    this.output = ''; this.failed = false;
    this.child.stderr.resume();
    this.child.stdin.on('error', () => { this.failed = true; this.deliver?.(); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => { this.output += chunk; this.deliver?.(); });
    this.child.on('error', () => { this.failed = true; this.deliver?.(); });
    this.child.on('close', () => { this.failed = true; this.deliver?.(); });
  }
  query(sql) {
    return new Promise((resolve, reject) => {
      const marker = 'clued_backup_' + crypto.randomBytes(12).toString('hex');
      const timer = setTimeout(() => { this.failed = true; this.child.kill('SIGTERM');
        finish(new Error('Backup snapshot query timed out')); }, 60000);
      const finish = error => { clearTimeout(timer); this.deliver = undefined;
        if (error) reject(error); else { const end = this.output.indexOf(marker); const result = this.output.slice(0,end).trim();
          this.output = this.output.slice(end + marker.length).replace(/^\r?\n/, ''); resolve(result); } };
      this.deliver = () => { if (this.failed) finish(new Error('Backup snapshot holder failed'));
        else if (this.output.includes(marker)) finish(); };
      this.child.stdin.write(sql + ';\n\\echo ' + marker + '\n'); this.deliver();
    });
  }
  async close() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 5000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end('\\q\n');
    });
  }
}

async function main() {
  const [container, scratch] = process.argv.slice(2);
  assert.match(container ?? '', /^clued-production-backup-[a-zA-Z0-9-]+$/, 'Unexpected backup container');
  assert.ok(scratch && path.isAbsolute(scratch), 'Backup needs allocated absolute scratch');
  assert.equal(await fs.realpath(scratch), path.resolve(scratch), 'Backup scratch must not be a symlink');
  const session = new SnapshotSession(container);
  const runPg = (tool, args) => runBackupTool('docker', ['exec',container,'sh','-ceu',
    tool === 'pg_dump' ? 'exec pg_dump --dbname="$DATABASE_URL" "$@"' : 'exec pg_restore "$@"', 'sh', ...args]);
  const proof = await createVerifiedBackup({ session, runPg, dumpPath: '/backup/clued-production-pre-migration.dump' });
  await fs.writeFile(path.join(scratch, 'scope-proof.json'), JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('::error::Production backup scope verification refused; no verified backup evidence'); process.exitCode = 1; });
}
