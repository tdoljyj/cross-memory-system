import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BACKUP_SCHEMAS = Object.freeze(['public', 'clued_private', 'clued_watchdog', 'supabase_migrations']);
const selected = "('public','clued_private','clued_watchdog','supabase_migrations')";
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const failureMetadata = new WeakMap();
const diagnosticStages = new Set(['setup','snapshot_begin','snapshot_export','catalog_query','catalog_parse',
  'inventory_validate','archive_dump','archive_list','toc_verify','holder_check','transaction_rollback',
  'rollback_cleanup','session_close','proof_write','unknown']);
const diagnosticReasons = new Set(['INTERNAL_ERROR','ASSERTION_REFUSED','JSON_INVALID','TOOL_START_FAILED',
  'TOOL_NONZERO','SNAPSHOT_START_FAILED','SNAPSHOT_HOLDER_EXIT','PSQL_SERVER_ERROR','SNAPSHOT_QUERY_TIMEOUT',
  'SNAPSHOT_IO_ERROR','SNAPSHOT_CLOSE_FAILED','SNAPSHOT_CLOSE_FORCED','SNAPSHOT_CLOSE_UNCONFIRMED',
  'TOC_LINE_INVALID','TOC_KIND_UNREVIEWED','TOC_OBJECT_OUTSIDE_SNAPSHOT','TOC_DATA_UNEXPECTED',
  'TOC_METADATA_UNBOUND','TOC_OBJECT_MISSING','TOC_DATA_MISSING',
  'TOC_DEFAULT_DEFINITION_REQUIRED','TOC_DEFAULT_MISSING','ARCHIVE_SQL_INVALID']);
const diagnosticSignals = new Set(['SIGINT','SIGTERM','SIGKILL','SIGHUP','SIGABRT','SIGPIPE','SIGQUIT','SIGSEGV']);
const sqlstateClasses = new Set(['00','01','02','03','08','09','0A','0B','0F','0L','0P','0Z','20','21','22',
  '23','24','25','26','27','28','2B','2D','2F','34','38','39','3B','3D','3F','40','42','44','53','54','55',
  '57','58','72','F0','HV','P0','XX']);
const safeSqlstate = value => typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) &&
  sqlstateClasses.has(value.slice(0,2)) ? value : null;
function failure(reason, message, details = {}) {
  const error = new Error(message);
  failureMetadata.set(error, { reason_code:reason, ...details });
  return error;
}
export function backupFailureDiagnostic(error) {
  const metadata = error && typeof error === 'object' ? failureMetadata.get(error) ?? {} : {};
  const reason = metadata.reason_code ?? (error instanceof SyntaxError ? 'JSON_INVALID' :
    error?.name === 'AssertionError' ? 'ASSERTION_REFUSED' : 'INTERNAL_ERROR');
  return {
    contract:'clued.production-backup-diagnostic.v1',
    stage:diagnosticStages.has(metadata.stage) ? metadata.stage : 'unknown',
    phase:metadata.phase === 'cleanup' ? 'cleanup' : 'primary',
    elapsed_ms:Number.isFinite(metadata.elapsed_ms) ? Math.max(0,Math.round(metadata.elapsed_ms)) : 0,
    reason_code:diagnosticReasons.has(reason) ? reason : 'INTERNAL_ERROR',
    exit_code:Number.isInteger(metadata.exit_code) && Math.abs(metadata.exit_code) <= 255 ? metadata.exit_code : null,
    signal:diagnosticSignals.has(metadata.signal) ? metadata.signal : null,
    sqlstate:safeSqlstate(metadata.sqlstate),
    observed_close:metadata.observed_close === true,
    termination_requested:metadata.termination_requested === true,
  };
}
class DiagnosticTracker {
  constructor(report = () => {}) { this.report = report; this.stage = 'unknown'; this.phase = 'primary'; this.started = performance.now(); }
  emit(record) {
    // An observer never controls backup guards or cleanup. Handle both a
    // synchronous throw and a rejected Promise without serializing either.
    try { Promise.resolve(this.report(record)).catch(() => {}); } catch {}
  }
  begin(stage, phase = 'primary') {
    this.stage = stage; this.phase = phase; this.started = performance.now();
    this.emit({ contract:'clued.production-backup-diagnostic.v1', event:'begin', stage, phase, elapsed_ms:0 });
  }
  success() { this.emit({ contract:'clued.production-backup-diagnostic.v1', event:'success', stage:this.stage,
    phase:this.phase, elapsed_ms:Math.max(0,Math.round(performance.now()-this.started)) }); }
  rejected(error) {
    const metadata = { ...backupFailureDiagnostic(error), stage:this.stage, phase:this.phase,
      elapsed_ms:Math.max(0,Math.round(performance.now()-this.started)) };
    if (error && typeof error === 'object' && !failureMetadata.get(error)?.stage) failureMetadata.set(error,metadata);
    this.emit({ ...metadata, event:'error' });
  }
}

// Only psql's explicitly selected SQLSTATE-only severity line is accepted.
// No stderr text, object name, query, connection detail or stack is retained.
export function sqlstateCollector() {
  let line = '', discarded = false, value = null;
  return {
    get value() { return value; },
    reset() { line = ''; discarded = false; value = null; },
    accept(chunk) {
      for (const character of chunk) {
        if (character === '\n') {
          if (!discarded) {
            const match = /^(?:psql:<stdin>:\d+: )?(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5})\r?$/.exec(line);
            if (match && safeSqlstate(match[1])) value = match[1];
          }
          line = ''; discarded = false;
        } else if (!discarded) {
          if (line.length >= 128) { line = ''; discarded = true; }
          else line += character;
        }
      }
    },
  };
}

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
      (c.relkind in ('i','I') and not exists(select 1 from pg_constraint k where k.conindid=c.oid
        and k.conrelid=i.indrelid and k.contype in ('p','u','x'))),
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
    a.attgenerated='',pg_get_expr(d.adbin,d.adrelid),c.relkind::text,0 from pg_attrdef d join pg_class c on c.oid=d.adrelid
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
// Publish only the fixed predicate code. Keep the original assertion and
// never serialize TOC tags, object names, catalog definitions or raw errors.
function archiveAssert(reason, condition, message) {
  try { assert.ok(condition, message); }
  catch (error) { failureMetadata.set(error, { reason_code:reason }); throw error; }
}
// pg_restore's table-only schema output is read, never executed. Compare
// canonical default-expression tokens within the exact parent table/column.
// Quoted values and identifiers stay opaque; comments cannot supply evidence.
function schemaTokens(sql) {
  const tokens=[];
  for(let i=0;i<sql.length;){
    if(/\s/.test(sql[i])){i++;continue;}
    if(sql.startsWith('--',i)){i=sql.indexOf('\n',i);if(i<0)break;continue;}
    if(sql.startsWith('/*',i)){let depth=1;i+=2;while(i<sql.length&&depth){
      if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;
    }archiveAssert('ARCHIVE_SQL_INVALID',depth===0,'Unterminated archive comment');continue;}
    if(sql[i]==='\\'){i=sql.indexOf('\n',i);if(i<0)break;continue;}
    const dollar=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if(dollar){const end=sql.indexOf(dollar[0],i+dollar[0].length);
      archiveAssert('ARCHIVE_SQL_INVALID',end>=0,'Unterminated archive dollar quote');
      tokens.push({kind:'literal',value:sql.slice(i,end+dollar[0].length)});i=end+dollar[0].length;continue;}
    if(sql[i]==="'"||sql[i]==='"'){
      const quote=sql[i],start=i++;let value='',closed=false;
      const escaped=quote==="'"&&start>0&&/[eE]/.test(sql[start-1])&&(start<2||!/[A-Za-z0-9_$]/.test(sql[start-2]));
      while(i<sql.length){if(sql[i]===quote){if(sql[i+1]===quote){value+=quote;i+=2;continue;}i++;closed=true;break;}
        if(escaped&&sql[i]==='\\'){value+=sql.slice(i,i+2);i+=2;}else value+=sql[i++];}
      archiveAssert('ARCHIVE_SQL_INVALID',closed,'Unterminated archive quoted token');
      tokens.push({kind:quote==='"'?'quoted':'literal',value:quote==='"'?value:sql.slice(start,i)});continue;
    }
    const word=/^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(sql.slice(i));
    if(word){tokens.push({kind:'word',value:word[0].toLowerCase()});i+=word[0].length;continue;}
    const number=/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(sql.slice(i));
    if(number){tokens.push({kind:'number',value:number[0]});i+=number[0].length;continue;}
    const operator=/^[+*/<>=~!@#%^&|?:-]+/.exec(sql.slice(i));
    if(operator){tokens.push({kind:'symbol',value:operator[0]});i+=operator[0].length;continue;}
    tokens.push({kind:'symbol',value:sql[i++]});
  }
  return tokens;
}
function inlineDefaultIsBound(object,parent,tokens) {
  const expected=schemaTokens(object.definition);
  const keyword=(token,value)=>token?.kind==='word'&&token.value===value;
  const identifier=(token,value)=>['word','quoted'].includes(token?.kind)&&token.value===value;
  const symbol=(token,value)=>token?.kind==='symbol'&&token.value===value;
  const same=(a,b)=>a?.value===b?.value&&(a?.kind===b?.kind||
    (['word','quoted'].includes(a?.kind)&&['word','quoted'].includes(b?.kind)));
  for(let i=0;i<tokens.length;i++){
    const tableAt=keyword(tokens[i+1],'unlogged')?i+2:i+1;
    if((i>0&&!symbol(tokens[i-1],';'))||!keyword(tokens[i],'create')||!keyword(tokens[tableAt],'table')||
      !identifier(tokens[tableAt+1],parent.schema)||!symbol(tokens[tableAt+2],'.')||
      !identifier(tokens[tableAt+3],parent.name)||!symbol(tokens[tableAt+4],'('))continue;
    let depth=1,brackets=0,start=tableAt+5,matched=false;
    for(let j=start;j<tokens.length&&depth;j++){
      if(symbol(tokens[j],'['))brackets++;if(symbol(tokens[j],']'))brackets--;
      if(symbol(tokens[j],'('))depth++;if(symbol(tokens[j],')'))depth--;
      if((symbol(tokens[j],',')&&depth===1&&brackets===0)||(symbol(tokens[j],')')&&depth===0)){
        const column=tokens.slice(start,j);start=j+1;
        if(identifier(column[0],object.name)){
          const at=column.findIndex(token=>keyword(token,'default'));
          if(at>=0&&expected.length&&expected.every((token,k)=>same(token,column[at+1+k]))){
            const next=column[at+1+expected.length];
            // pg_dump appends only the column's NOT NULL flag after DEFAULT.
            // NOT IN or COLLATE still belongs to the expression.
            if(!next||(keyword(next,'not')&&keyword(column[at+2+expected.length],'null')&&
              column.length===at+3+expected.length))matched=true;
          }
        }
      }
      if(depth===0&&brackets===0&&matched){
        for(let end=j+1;end<tokens.length;end++){
          if(symbol(tokens[end],';'))return true;
          if(keyword(tokens[end],'create'))break;
        }
      }
    }
  }
  return false;
}
export function verifyArchiveScope(inventory, toc, tableDefinitions) {
  validateInventory(inventory);
  const tableTokens=typeof tableDefinitions==='string'?schemaTokens(tableDefinitions):null;
  const entries = toc.split(/\r?\n/).filter(line => line && !line.startsWith(';')).map(line => {
    const m = /^(\d+); (\d+) (\d+) (.*)$/.exec(line);
    archiveAssert('TOC_LINE_INVALID', m, 'Unrecognized archive TOC line');
    const kind = tocKinds.find(k => m[4].startsWith(k + ' '));
    archiveAssert('TOC_KIND_UNREVIEWED', kind, 'Unreviewed archive entry kind');
    return { catalog: Number(m[2]), oid: Number(m[3]), kind, tag: m[4].slice(kind.length + 1) };
  });
  const known = new Map(inventory.objects.map(o => [`${o.catalog}:${o.oid}`, o]));
  for (const entry of entries) {
    if (entry.catalog !== 0) archiveAssert('TOC_OBJECT_OUTSIDE_SNAPSHOT', known.has(`${entry.catalog}:${entry.oid}`), 'Archive contains an object outside snapshot scope');
    else if (['TABLE DATA','MATERIALIZED VIEW DATA'].includes(entry.kind)) {
      archiveAssert('TOC_DATA_UNEXPECTED', inventory.data.some(o => o.oid === entry.oid && o.kind === entry.kind), 'Archive contains unexpected table data');
    } else archiveAssert('TOC_METADATA_UNBOUND', ancillaryIsBound(entry, inventory), 'Archive contains unbound metadata');
  }
  for (const object of inventory.objects.filter(o => o.required)) {
    const separate=entries.some(e=>e.catalog===object.catalog&&e.oid===object.oid&&e.kind===object.kind);
    if(object.kind==='DEFAULT'&&!separate){
      const parent=inventory.objects.find(o=>o.catalog===1259&&o.oid===object.parent_oid&&
        o.kind==='TABLE'&&['r','p'].includes(o.relation_kind)&&o.schema===object.schema);
      if(parent){
        archiveAssert('TOC_DEFAULT_DEFINITION_REQUIRED',typeof tableDefinitions==='string','Inline default definitions need archive evidence');
        archiveAssert('TOC_DEFAULT_MISSING',entries.some(e=>e.catalog===parent.catalog&&e.oid===parent.oid&&e.kind==='TABLE')&&
          typeof object.definition==='string'&&inlineDefaultIsBound(object,parent,tableTokens),'Archive is missing a snapshot column default');
        continue;
      }
    }
    archiveAssert('TOC_OBJECT_MISSING', entries.some(e => e.catalog === object.catalog && e.oid === object.oid &&
      (e.kind === object.kind || (object.kind === 'CONSTRAINT' && e.kind === 'CHECK CONSTRAINT'))),
    'Archive is missing a snapshot catalog object');
  }
  for (const object of inventory.data) archiveAssert('TOC_DATA_MISSING', entries.some(e => e.catalog === 0 && e.oid === object.oid && e.kind === object.kind),
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
export async function createVerifiedBackup({ session, runPg, dumpPath, onDiagnostic }) {
  let begun = false, primaryError, cleanupError, result, hasPrimary = false, hasCleanup = false;
  const tracker = new DiagnosticTracker(onDiagnostic);
  try {
    tracker.begin('snapshot_begin');
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    tracker.success(); tracker.begin('snapshot_export');
    const snapshot = await session.query('SELECT pg_export_snapshot()');
    assert.match(snapshot, /^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/, 'Invalid exported snapshot');
    tracker.success(); tracker.begin('catalog_query');
    // Match pg_dump's deparser path so custom default functions/types qualify
    // identically. This remains local to the existing READ ONLY transaction.
    await session.query("SET LOCAL search_path = ''");
    const catalog = await session.query(BACKUP_INVENTORY_SQL);
    tracker.success(); tracker.begin('catalog_parse');
    const inventory = JSON.parse(catalog);
    tracker.success(); tracker.begin('inventory_validate');
    validateInventory(inventory);
    tracker.success(); tracker.begin('archive_dump');
    await runPg('pg_dump', backupDumpArguments(snapshot, dumpPath));
    tracker.success(); tracker.begin('archive_list');
    const toc = await runPg('pg_restore', ['--list', dumpPath]);
    tracker.success(); tracker.begin('toc_verify');
    let proof;
    try { proof = verifyArchiveScope(inventory, toc); }
    catch(error){
      if(backupFailureDiagnostic(error).reason_code!=='TOC_DEFAULT_DEFINITION_REQUIRED')throw error;
      const tables=inventory.objects.filter(o=>o.kind==='TABLE'&&['r','p'].includes(o.relation_kind));
      const definitions=await runPg('pg_restore',['--schema-only','--section=pre-data','--no-owner','--no-privileges',
        '--file=-',...BACKUP_SCHEMAS.map(schema=>'--schema='+schema),
        ...[...new Set(tables.map(o=>o.name))].map(name=>'--table='+name),dumpPath]);
      proof=verifyArchiveScope(inventory,toc,definitions);
    }
    tracker.success(); tracker.begin('holder_check');
    await session.query('SELECT 1'); // A lost snapshot holder is a refusal, too.
    tracker.success(); tracker.begin('transaction_rollback');
    await session.query('ROLLBACK'); begun = false;
    tracker.success(); result = { ...proof, snapshot_sha256: digest(snapshot) };
  } catch (error) {
    hasPrimary = true; primaryError = error; tracker.rejected(error);
  } finally {
    if (begun) {
      tracker.begin('rollback_cleanup','cleanup');
      try { await session.query('ROLLBACK'); tracker.success(); }
      catch (error) { if (!hasCleanup) cleanupError = error; hasCleanup = true; tracker.rejected(error); }
    }
    tracker.begin('session_close','cleanup');
    try { await session.close(); tracker.success(); }
    catch (error) { if (!hasCleanup) cleanupError = error; hasCleanup = true; tracker.rejected(error); }
  }
  if (hasPrimary) throw primaryError;
  if (hasCleanup) throw cleanupError;
  return result;
}

export function runBackupTool(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume(); // Do not echo connection strings or server details.
    child.once('error', () => reject(failure('TOOL_START_FAILED','PostgreSQL backup tool could not start')));
    // exit can arrive before the last stdout chunk. A complete TOC is evidence
    // only after the pipes have closed and the producer has succeeded.
    child.once('close', (code,signal) => code === 0 && !signal ? resolve(output) : reject(failure('TOOL_NONZERO',
      'PostgreSQL backup tool failed', { exit_code:code,signal,observed_close:true })));
  });
}

export class SnapshotSession {
  constructor(container, { graceMs = 5000, termMs = 2000, killMs = 2000 } = {}) {
    assert.ok([graceMs,termMs,killMs].every(v => Number.isInteger(v) && v > 0 && v <= 5000), 'Invalid bounded close window');
    this.child = spawn('docker', ['exec','-i',container,'sh','-ceu',
      'exec psql "$DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -v SHOW_CONTEXT=never'], { stdio: ['pipe','pipe','pipe'] });
    this.output = ''; this.failed = false; this.closed = false;
    this.closeWindows = { graceMs,termMs,killMs }; this.state = sqlstateCollector();
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => this.state.accept(chunk));
    this.child.stdin.on('error', () => { this.failed = true;
      this.failure = failure('SNAPSHOT_IO_ERROR','Backup snapshot input failed'); this.deliver?.(); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => { this.output += chunk; this.deliver?.(); });
    this.child.on('error', () => { this.failed = true;
      this.failure = failure('SNAPSHOT_START_FAILED','Backup snapshot holder could not start'); this.deliver?.(); });
    this.child.on('close', (code,signal) => {
      this.closed = true; this.closeVerdict = { exit_code:code,signal,observed_close:true,sqlstate:this.state.value };
      this.failed = true; this.failure = failure(this.state.value ? 'PSQL_SERVER_ERROR' : 'SNAPSHOT_HOLDER_EXIT',
        'Backup snapshot holder failed',this.closeVerdict); this.deliver?.();
    });
  }
  query(sql) {
    return new Promise((resolve, reject) => {
      const marker = 'clued_backup_' + crypto.randomBytes(12).toString('hex');
      const timer = setTimeout(() => { this.failed = true;
        const timeoutError = failure('SNAPSHOT_QUERY_TIMEOUT','Backup snapshot query timed out', { termination_requested:true });
        this.terminationRequested = true; finish(timeoutError);
        try { this.child.kill('SIGTERM'); } catch {}
      }, 60000);
      const finish = error => { clearTimeout(timer); this.deliver = undefined;
        if (error) reject(error); else { const end = this.output.indexOf(marker); const result = this.output.slice(0,end).trim();
          this.output = this.output.slice(end + marker.length).replace(/^\r?\n/, ''); resolve(result); } };
      this.deliver = () => { if (this.failed) finish(this.failure ?? failure('SNAPSHOT_HOLDER_EXIT','Backup snapshot holder failed'));
        else if (this.output.includes(marker)) finish(); };
      if (!this.failed) this.state.reset();
      this.child.stdin.write(sql + ';\n\\echo ' + marker + '\n'); this.deliver();
    });
  }
  waitForClose(milliseconds) {
    if (this.closed) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = closed => { clearTimeout(timer); this.child.off('close',closedListener); resolve(closed); };
      const closedListener = () => finish(true);
      const timer = setTimeout(() => finish(false),milliseconds);
      this.child.once('close',closedListener);
    });
  }
  close() {
    this.closeResult ??= this.closeBounded();
    return this.closeResult;
  }
  releaseClientHandles() {
    // These are this Node process's owned docker-exec client handles only.
    // Releasing them lets a refused CLI exit; it does not prove that psql or
    // the container stopped. The workflow must still stop its owned producer.
    for (const stream of [this.child.stdin,this.child.stdout,this.child.stderr]) {
      try { stream.destroy(); } catch {}
    }
    try { this.child.unref(); } catch {}
  }
  async closeBounded() {
    let forced = this.terminationRequested === true, inputFailed = false;
    const grace = this.waitForClose(this.closeWindows.graceMs);
    if (!this.closed) try { this.child.stdin.end('\\q\n'); } catch { inputFailed = true; }
    if (!await grace) {
      forced = true;
      const term = this.waitForClose(this.closeWindows.termMs);
      try { this.child.kill('SIGTERM'); } catch {}
      if (!await term) {
        const killed = this.waitForClose(this.closeWindows.killMs);
        try { this.child.kill('SIGKILL'); } catch {}
        if (!await killed) {
          this.releaseClientHandles();
          throw failure('SNAPSHOT_CLOSE_UNCONFIRMED','Backup snapshot close was not observed',
            { termination_requested:true,observed_close:false });
        }
      }
    }
    if (forced) throw failure('SNAPSHOT_CLOSE_FORCED','Backup snapshot needed forced termination',
      { ...this.closeVerdict,termination_requested:true });
    if (inputFailed || this.closeVerdict?.exit_code !== 0 || this.closeVerdict?.signal) {
      throw failure('SNAPSHOT_CLOSE_FAILED','Backup snapshot did not close gracefully',this.closeVerdict);
    }
  }
}

async function main() {
  const onDiagnostic = record => console.log(JSON.stringify(record));
  const tracker = new DiagnosticTracker(onDiagnostic);
  tracker.begin('setup');
  try {
  const [container, scratch] = process.argv.slice(2);
  assert.match(container ?? '', /^clued-production-backup-[a-zA-Z0-9-]+$/, 'Unexpected backup container');
  assert.ok(scratch && path.isAbsolute(scratch), 'Backup needs allocated absolute scratch');
  assert.equal(await fs.realpath(scratch), path.resolve(scratch), 'Backup scratch must not be a symlink');
  tracker.success();
  const session = new SnapshotSession(container);
  const runPg = (tool, args) => runBackupTool('docker', ['exec',container,'sh','-ceu',
    tool === 'pg_dump' ? 'exec pg_dump --dbname="$DATABASE_URL" "$@"' : 'exec pg_restore "$@"', 'sh', ...args]);
  const proof = await createVerifiedBackup({ session, runPg, dumpPath: '/backup/clued-production-pre-migration.dump', onDiagnostic });
  tracker.begin('proof_write');
  await fs.writeFile(path.join(scratch, 'scope-proof.json'), JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
  tracker.success();
  } catch (error) {
    if (!failureMetadata.get(error)?.stage) tracker.rejected(error);
    throw error;
  }
}
if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main().catch(error => { console.error('::error::Production backup scope verification refused; no verified backup evidence');
    console.error(JSON.stringify({ ...backupFailureDiagnostic(error),event:'refused' })); process.exitCode = 1; });
}
