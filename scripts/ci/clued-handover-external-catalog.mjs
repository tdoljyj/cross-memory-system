// Source-owned complete pre-bootstrap metadata inventory. No passwords/data.
import assert from 'node:assert/strict';
import {catalogIdentityMaps,normalizeCatalogObjects,catalogReference} from './clued-handover-external-catalog-identities.mjs';
const sort=rows=>rows.map(r=>JSON.stringify(r)).sort();
const N="n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'";
const query=
  "select 'namespace' kind,n.nspname identity,pg_get_userbyid(n.nspowner) owner,coalesce(n.nspacl::text,'') detail "+
  "from pg_namespace n where "+N+" union all "+
  "select 'relation',n.nspname||'.'||c.relname,pg_get_userbyid(c.relowner),"+
  "jsonb_build_object('relation',c.oid::text,'original_detail',c.relkind::text||':'||coalesce(c.relacl::text,''))::text "+
  "from pg_class c join pg_namespace n on n.oid=c.relnamespace where "+N+" or c.oid>=16384 union all "+
  "select 'index',n.nspname||'.'||c.relname,pg_get_userbyid(c.relowner),"+
  "jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'state',to_jsonb(i),"+
  "'expressions',pg_get_expr(i.indexprs,i.indrelid),'predicate',pg_get_expr(i.indpred,i.indrelid),"+
  "'relation_state',jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'tablespace',c.reltablespace,"+
  "'options',c.reloptions,'acl',c.relacl))::text "+
  "from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace "+
  "where "+N+" or c.oid>=16384 union all "+
  "select 'function',p.oid::regprocedure::text,pg_get_userbyid(p.proowner),"+
  "md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace "+
  "where ("+N+" or p.oid>=16384) and p.prokind<>'a' union all "+
  "select 'aggregate',p.oid::regprocedure::text,pg_get_userbyid(p.proowner),"+
  "jsonb_build_object('state',to_jsonb(a),'references',jsonb_build_object("+
  "'aggfnoid',a.aggfnoid::oid,'aggtransfn',a.aggtransfn::oid,'aggfinalfn',a.aggfinalfn::oid,"+
  "'aggcombinefn',a.aggcombinefn::oid,'aggserialfn',a.aggserialfn::oid,'aggdeserialfn',a.aggdeserialfn::oid,"+
  "'aggmtransfn',a.aggmtransfn::oid,'aggminvtransfn',a.aggminvtransfn::oid,'aggmfinalfn',a.aggmfinalfn::oid,"+
  "'aggtranstype',a.aggtranstype,'aggmtranstype',a.aggmtranstype,'aggsortop',a.aggsortop))::text "+
  "from pg_aggregate a join pg_proc p on p.oid=a.aggfnoid join pg_namespace n on n.oid=p.pronamespace "+
  "where "+N+" or p.oid>=16384 union all "+
  "select 'type',n.nspname||'.'||t.typname,pg_get_userbyid(t.typowner),t.typtype::text||':'||coalesce(t.typacl::text,'') "+
  "from pg_type t join pg_namespace n on n.oid=t.typnamespace where "+N+" or t.oid>=16384 union all "+
  "select 'enum',format('%I.%I',n.nspname,t.typname),pg_get_userbyid(t.typowner),"+
  "jsonb_agg(jsonb_build_object('label',e.enumlabel,'sort_order',e.enumsortorder) order by e.enumsortorder)::text "+
  "from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace "+
  "where "+N+" group by n.nspname,t.typname,t.typowner union all "+
  "select 'constraint',n.nspname||'.'||c.conname,pg_get_userbyid(r.relowner),md5(pg_get_constraintdef(c.oid)) "+
  "from pg_constraint c join pg_namespace n on n.oid=c.connamespace left join pg_class r on r.oid=c.conrelid where "+N+" union all "+
  "select 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,pg_get_userbyid(c.relowner),md5(pg_get_triggerdef(t.oid)) "+
  "from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where "+N+" and not t.tgisinternal union all "+
  "select 'extension',e.extname,pg_get_userbyid(e.extowner),e.extversion||':'||n.nspname "+
  "from pg_extension e join pg_namespace n on n.oid=e.extnamespace union all "+
  "select 'policy',n.nspname||'.'||c.relname||'.'||p.polname,pg_get_userbyid(c.relowner),"+
  "jsonb_build_object('state',to_jsonb(p),'command',p.polcmd,'permissive',p.polpermissive,"+
  "'qual',pg_get_expr(p.polqual,p.polrelid),'withcheck',pg_get_expr(p.polwithcheck,p.polrelid))::text "+
  "from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where "+N+" union all "+
  "select 'collation',format('%I.%I',n.nspname,c.collname)||'@encoding='||c.collencoding,pg_get_userbyid(c.collowner),"+
  "jsonb_build_object('state',to_jsonb(c)-array['oid','collnamespace','collowner'],"+
  "'actual_version',pg_collation_actual_version(c.oid))::text "+
  "from pg_collation c join pg_namespace n on n.oid=c.collnamespace where "+N+" union all "+
  "select 'operator',o.oid::regoperator::text,pg_get_userbyid(o.oprowner),"+
  "jsonb_build_object('operator',o.oid,'function',o.oprcode::oid)::text "+
  "from pg_operator o join pg_namespace n on n.oid=o.oprnamespace where "+N+" union all "+
  "select 'opclass',format('%I.%I',n.nspname,o.opcname)||'@'||a.amname,pg_get_userbyid(o.opcowner),"+
  "jsonb_build_object('method',a.amname,'family',format('%I.%I',fn.nspname,f.opfname)||'@'||a.amname,"+
  "'input_type',format('%I.%I',itn.nspname,it.typname),'key_type',case when o.opckeytype=0 then 'SAME_AS_INPUT' "+
  "else format('%I.%I',ktn.nspname,kt.typname) end,'default',o.opcdefault)::text "+
  "from pg_opclass o join pg_namespace n on n.oid=o.opcnamespace join pg_am a on a.oid=o.opcmethod "+
  "join pg_opfamily f on f.oid=o.opcfamily join pg_namespace fn on fn.oid=f.opfnamespace "+
  "join pg_type it on it.oid=o.opcintype join pg_namespace itn on itn.oid=it.typnamespace "+
  "left join pg_type kt on kt.oid=o.opckeytype left join pg_namespace ktn on ktn.oid=kt.typnamespace where "+N+" union all "+
  "select 'opfamily',format('%I.%I',n.nspname,o.opfname)||'@'||a.amname,pg_get_userbyid(o.opfowner),"+
  "jsonb_build_object('method',a.amname)::text from pg_opfamily o join pg_namespace n on n.oid=o.opfnamespace "+
  "join pg_am a on a.oid=o.opfmethod where "+N+" union all "+
  "select 'amop',format('%I.%I',n.nspname,f.opfname)||'@'||a.amname||':'||m.amoplefttype::regtype::text||':'||"+
  "m.amoprighttype::regtype::text||':'||m.amopstrategy||':'||m.amoppurpose::text,pg_get_userbyid(f.opfowner),"+
  "jsonb_build_object('method',a.amname,'left_type',m.amoplefttype::regtype::text,'right_type',m.amoprighttype::regtype::text,"+
  "'strategy',m.amopstrategy,'purpose',m.amoppurpose,'operator',m.amopopr::regoperator::text,"+
  "'sort_family',case when m.amopsortfamily=0 then 'NONE' else format('%I.%I',sn.nspname,sf.opfname)||'@'||sa.amname end)::text "+
  "from pg_amop m join pg_opfamily f on f.oid=m.amopfamily join pg_namespace n on n.oid=f.opfnamespace "+
  "join pg_am a on a.oid=m.amopmethod left join pg_opfamily sf on sf.oid=m.amopsortfamily "+
  "left join pg_namespace sn on sn.oid=sf.opfnamespace left join pg_am sa on sa.oid=sf.opfmethod where "+N+" union all "+
  "select 'amproc',format('%I.%I',n.nspname,f.opfname)||'@'||a.amname||':'||m.amproclefttype::regtype::text||':'||"+
  "m.amprocrighttype::regtype::text||':'||m.amprocnum,pg_get_userbyid(f.opfowner),"+
  "jsonb_build_object('method',a.amname,'left_type',m.amproclefttype::regtype::text,'right_type',m.amprocrighttype::regtype::text,"+
  "'support_number',m.amprocnum,'function',m.amproc::oid::regprocedure::text)::text "+
  "from pg_amproc m join pg_opfamily f on f.oid=m.amprocfamily join pg_namespace n on n.oid=f.opfnamespace "+
  "join pg_am a on a.oid=f.opfmethod where "+N+" union all "+
  "select 'conversion',n.nspname||'.'||c.conname,pg_get_userbyid(c.conowner),jsonb_build_object('function',c.conproc::oid)::text "+
  "from pg_conversion c join pg_namespace n on n.oid=c.connamespace where "+N+" union all "+
  "select 'rewrite',n.nspname||'.'||c.relname||'.'||r.rulename,pg_get_userbyid(c.relowner),md5(pg_get_ruledef(r.oid)) "+
  "from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace where "+N+" union all "+
  "select 'attribute',n.nspname||'.'||c.relname||'.'||a.attname,pg_get_userbyid(c.relowner),"+
  "format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') "+
  "from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace "+
  "left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where "+N+" and a.attnum>0 and not a.attisdropped";
export const CATALOG_OBJECTS_SQL=query;
export const SEMANTIC_CATALOG_COLUMNS={
  pg_enum:['oid','enumtypid','enumsortorder','enumlabel'],
  pg_collation:['oid','collname','collnamespace','collowner','collprovider','collisdeterministic','collencoding',
    'collcollate','collctype','colllocale','collicurules','collversion'],
  pg_opclass:['oid','opcmethod','opcname','opcnamespace','opcowner','opcfamily','opcintype','opcdefault','opckeytype'],
  pg_opfamily:['oid','opfmethod','opfname','opfnamespace','opfowner'],
  pg_amop:['oid','amopfamily','amoplefttype','amoprighttype','amopstrategy','amoppurpose','amopopr','amopmethod','amopsortfamily'],
  pg_amproc:['oid','amprocfamily','amproclefttype','amprocrighttype','amprocnum','amproc'],
};
export function assertSemanticCatalogColumns(rows){
  const expected=Object.entries(SEMANTIC_CATALOG_COLUMNS).flatMap(([catalog,columns])=>columns.map(column=>({catalog,column})));
  assert.deepEqual(sort(rows),sort(expected),'UNSUPPORTED_SEMANTIC_CATALOG_COLUMNS');
}
export function assertCatalogObjects(observed,expected,database='fixture'){
  assert.deepEqual(sort(observed),sort(expected),'CATALOG_OBJECTS_'+database);
}
export async function localCatalog(client){
  const prior=(await client.query("select current_setting('search_path') v")).rows[0].v;
  await client.query("select set_config('search_path','pg_catalog',false)");
  try{
  assertSemanticCatalogColumns((await client.query("select c.relname catalog,a.attname as \"column\" from pg_attribute a "+
    "join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='pg_catalog' "+
    "and c.relname in ('pg_enum','pg_collation','pg_opclass','pg_opfamily','pg_amop','pg_amproc') and a.attnum>0 and not a.attisdropped")).rows);
  const maps=await catalogIdentityMaps(client);
  return {server_version_num:(await client.query("select current_setting('server_version_num') v")).rows[0].v,
    objects:normalizeCatalogObjects((await client.query(query)).rows,maps),
    shared:{
      roles:(await client.query('select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles order by rolname')).rows,
      databases:(await client.query('select d.datname,pg_get_userbyid(d.datdba) owner,d.datistemplate,d.datallowconn,'+
        'coalesce(d.datacl::text,\'\') acl,t.spcname tablespace from pg_database d join pg_tablespace t on t.oid=d.dattablespace order by d.datname')).rows,
      tablespaces:(await client.query('select spcname,pg_get_userbyid(spcowner) owner,coalesce(spcacl::text,\'\') acl from pg_tablespace order by spcname')).rows,
      event_triggers:(await client.query('select evtname,evtevent,pg_get_userbyid(evtowner) owner,evtfoid::oid::text function from pg_event_trigger')).rows
        .map(r=>({...r,function:catalogReference(maps,'functions',r.function)})),
      foreign_wrappers:(await client.query('select fdwname,pg_get_userbyid(fdwowner) owner from pg_foreign_data_wrapper')).rows,
      foreign_servers:(await client.query('select srvname,pg_get_userbyid(srvowner) owner from pg_foreign_server')).rows,
      user_mappings:(await client.query('select m.umuser::text role,s.srvname server from pg_user_mapping m join pg_foreign_server s on s.oid=m.umserver')).rows
        .map(r=>({...r,role:catalogReference(maps,'roles',r.role,'PUBLIC')})),
      publications:(await client.query('select pubname,pg_get_userbyid(pubowner) owner,puballtables from pg_publication')).rows,
      subscriptions:(await client.query('select subname,pg_get_userbyid(subowner) owner,subenabled from pg_subscription')).rows,
      languages:(await client.query('select lanname,pg_get_userbyid(lanowner) owner,lanpltrusted from pg_language')).rows,
      access_methods:(await client.query('select amname,amtype,amhandler::oid::text handler from pg_am')).rows
        .map(r=>({...r,handler:catalogReference(maps,'functions',r.handler,'NONE')})),
      transforms:(await client.query('select t.trftype::text type,l.lanname language,t.trffromsql::oid::text fromsql,t.trftosql::oid::text tosql from pg_transform t join pg_language l on l.oid=t.trflang')).rows
        .map(r=>({...r,type:catalogReference(maps,'types',r.type),fromsql:catalogReference(maps,'functions',r.fromsql,'NONE'),
          tosql:catalogReference(maps,'functions',r.tosql,'NONE')})),
      text_search:(await client.query("select 'config' kind,n.nspname||'.'||c.cfgname identity,pg_get_userbyid(c.cfgowner) owner "+
        "from pg_ts_config c join pg_namespace n on n.oid=c.cfgnamespace where "+N+" union all "+
        "select 'dictionary',n.nspname||'.'||d.dictname,pg_get_userbyid(d.dictowner) from pg_ts_dict d "+
        "join pg_namespace n on n.oid=d.dictnamespace where "+N+" union all "+
        "select 'parser',n.nspname||'.'||p.prsname,'' from pg_ts_parser p join pg_namespace n on n.oid=p.prsnamespace where "+N+" union all "+
        "select 'template',n.nspname||'.'||t.tmplname,'' from pg_ts_template t join pg_namespace n on n.oid=t.tmplnamespace where "+N)).rows,
      statistics:(await client.query("select n.nspname||'.'||s.stxname identity,pg_get_userbyid(s.stxowner) owner "+
        "from pg_statistic_ext s join pg_namespace n on n.oid=s.stxnamespace where "+N)).rows,
    }};
  }finally{await client.query("select set_config('search_path',$1,false)",[prior]);}
}
export function assertTableCounts(observed,expected){
  assert.ok(Array.isArray(expected),'INDEPENDENT_TABLE_COUNTS_REQUIRED');
  for(const row of [...observed,...expected]){
    assert.equal(typeof row.schema,'string');assert.equal(typeof row.table,'string');
    assert.match(row.count,/^(0|[1-9][0-9]*)$/);
    assert.ok(['empty','accepted-platform-static','registration-marker'].includes(row.classification),
      'TABLE_STATE_CLASSIFICATION_REQUIRED');
    if(row.classification==='empty')assert.equal(row.count,'0','EMPTY_TABLE_COUNT_MISMATCH');
  }
  assert.deepEqual(sort(observed),sort(expected),'INDEPENDENT_TABLE_COUNTS_CHANGED');
}
export async function tableCounts(client,expected){
  assert.ok(Array.isArray(expected),'INDEPENDENT_TABLE_COUNTS_REQUIRED');
  const declared=new Map(expected.map(r=>[JSON.stringify([r.schema,r.table]),r]));
  assert.equal(declared.size,expected.length,'DUPLICATE_TABLE_STATE_DECLARATION');
  // Count only local ordinary/partitioned tables; never foreign tables or views
  // (including decrypted-secret views). All definitions are still inventoried.
  const tables=(await client.query("select n.nspname as \"schema\",c.relname as \"table\" from pg_class c "+
    "join pg_namespace n on n.oid=c.relnamespace where ("+N+") and c.relkind in ('r','p')")).rows;
  assert.deepEqual(tables.map(r=>JSON.stringify([r.schema,r.table])).sort(),[...declared.keys()].sort(),
    'UNDECLARED_PLATFORM_TABLE');
  const quote=name=>'"'+name.replaceAll('"','""')+'"';
  const observed=[];
  for(const table of tables){
    const count=(await client.query('select count(*)::text n from '+quote(table.schema)+'.'+quote(table.table))).rows[0].n;
    const known=declared.get(JSON.stringify([table.schema,table.table]));
    observed.push({...table,count,classification:known.classification});
  }
  assertTableCounts(observed,expected);return observed;
}
export async function verifyEmptyCluster({admin,connectDatabase,expected,targetDatabase}){
  assert.equal(expected.schema,'clued.disposable-cluster-catalog/1');
  const here=await localCatalog(admin);
  assert.equal(here.server_version_num,expected.server_version_num);
  const globalKinds=['roles','databases','tablespaces'];
  for(const kind of globalKinds)assert.deepEqual(sort(here.shared[kind]),sort(expected.shared[kind]),'CATALOG_SHARED_'+kind);
  const unavailable=here.shared.databases.filter(d=>!d.datallowconn).map(d=>d.datname).sort();
  assert.deepEqual(unavailable,[...expected.nonconnectable_databases].sort(),'UNDECLARED_NONCONNECTABLE_DATABASE');
  // Template1 is checked too. Only independently accepted non-connectable
  // baseline exceptions (normally template0) can omit an object inventory.
  const names=here.shared.databases.filter(d=>d.datallowconn).map(d=>d.datname).sort();
  assert.deepEqual(names,Object.keys(expected.databases).sort(),'CATALOG_DATABASE_SET');
  for(const name of names){
    const client=name===targetDatabase?admin:await connectDatabase(name);
    try{
      const observed=await localCatalog(client);
      assertCatalogObjects(observed.objects,expected.databases[name],name);
      await tableCounts(client,expected.table_counts_by_database[name]);
      for(const kind of Object.keys(observed.shared).filter(k=>!globalKinds.includes(k)))
        assert.deepEqual(sort(observed.shared[kind]),sort(expected.auxiliary_by_database[name][kind]),'CATALOG_AUX_'+name+'_'+kind);
    }finally{if(client!==admin)await client.end();}
  }
  return {status:'EXACT_EMPTY_CLUSTER_CATALOG',databases_checked:names,exceptions:'only independent accepted catalog bytes'};
}
