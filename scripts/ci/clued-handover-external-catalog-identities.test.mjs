import test from 'node:test';
import assert from 'node:assert/strict';
import {identityMaps,normalizeCatalogObjects} from './clued-handover-external-catalog-identities.mjs';

function fixture({parent='registration_v1',schema='qualification_guard',oid='500',toast='501',index='502',
  tableName='pg_toast_'+oid,indexName='pg_toast_'+oid+'_index'}={}){
  const relations=[{oid,schema,name:parent,kind:'r',toast_parent_oid:null,index_table_oid:null},
    {oid:toast,schema:'pg_toast',name:tableName,kind:'t',toast_parent_oid:oid,index_table_oid:null},
    {oid:index,schema:'pg_toast',name:indexName,kind:'i',toast_parent_oid:null,index_table_oid:toast},
    {oid:'900',schema:'public',name:'normal_123',kind:'r',toast_parent_oid:null,index_table_oid:null},
    {oid:'901',schema:'public',name:'normal_123_idx',kind:'i',toast_parent_oid:null,index_table_oid:'900'}];
  const rows={relations,types:[],roles:[],functions:[],operators:[],collations:[],
    tablespaces:[{oid:'1663',name:'pg_default'}],database_tablespace:'1663',
    opclasses:[{oid:'112',schema:'pg_catalog',name:'bool_ops',method:'btree'}]};
  const relation=r=>({kind:'relation',identity:r.schema+'.'+r.name,owner:'postgres',
    detail:JSON.stringify({relation:r.oid,original_detail:r.kind+':'})});
  const indexRow=(r,table,definition)=>({kind:'index',identity:r.schema+'.'+r.name,owner:'postgres',
    detail:JSON.stringify({definition,state:{indexrelid:r.oid,indrelid:table.oid,indnatts:1,indnkeyatts:1,
      indisunique:true,indnullsnotdistinct:false,indisprimary:false,indisexclusion:false,indimmediate:true,
      indisclustered:false,indisvalid:true,indcheckxmin:false,indisready:true,indislive:true,indisreplident:false,
      indkey:'1',indcollation:'0',indclass:'112',indoption:'0',indexprs:null,indpred:null},
      expressions:null,predicate:null,relation_state:{kind:'i',persistence:'p',tablespace:0,options:null,acl:null}})});
  const quote=s=>'"'+s.replaceAll('"','""')+'"';
  const objects=[...relations.map(relation),indexRow(relations[2],relations[1],
    'CREATE UNIQUE INDEX '+quote(indexName)+' ON pg_toast.'+quote(tableName)+' USING btree (chunk_id)'),
    indexRow(relations[4],relations[3],
      "CREATE UNIQUE INDEX normal_123_idx ON public.normal_123 USING btree ((123 + length('pg_toast_500'))) ")];
  return {rows,objects,relation,indexRow};
}
const normalized=f=>normalizeCatalogObjects(f.objects,identityMaps(f.rows));

test('same parent is independent of real physical OID and generated TOAST names',()=>{
  assert.deepEqual(normalized(fixture()),normalized(fixture({oid:'700',toast:'701',index:'702'})));
});
test('different parent and quoted identifiers remain distinct',()=>{
  const a=normalized(fixture()),b=normalized(fixture({parent:'other'}));assert.notDeepEqual(a,b);
  const c=normalized(fixture({parent:'part."one',schema:'q."guard'}));
  const d=normalized(fixture({parent:'one',schema:'q."guard.part'}));assert.notDeepEqual(c,d);
});
test('ordinary relation and index SQL including numeric and string tokens are unchanged',()=>{
  const f=fixture(),out=normalized(f);
  assert.deepEqual(out[3],{kind:'relation',identity:'public.normal_123',owner:'postgres',detail:'r:'});
  assert.equal(JSON.parse(out[6].detail).definition,JSON.parse(f.objects[6].detail).definition);
  assert.deepEqual(out[0],{kind:'relation',identity:'qualification_guard.registration_v1',owner:'postgres',detail:'r:'});
});
test('only the two mapped TOAST identifiers change; tail and every state field remain',()=>{
  const f=fixture({tableName:'toast."500',indexName:'toast."500.idx'});
  const raw=JSON.parse(f.objects[5].detail);
  raw.definition+=" /* literal 'pg_toast_500', 500 */";f.objects[5].detail=JSON.stringify(raw);
  const value=JSON.parse(normalized(f)[5].detail);
  assert.ok(value.definition.endsWith("USING btree (chunk_id) /* literal 'pg_toast_500', 500 */"));
  assert.deepEqual(Object.keys(value.state),Object.keys(raw.state));
  for(const [key,v] of Object.entries(raw.state))if(!['indexrelid','indrelid','indclass','indcollation','indexprs','indpred'].includes(key))assert.deepEqual(value.state[key],v);
  assert.deepEqual(value.relation_state,{...raw.relation_state,tablespace:'DATABASE_DEFAULT:"pg_default"'});
});
test('unknown, duplicate and missing catalog bindings still refuse',()=>{
  const a=fixture();a.rows.relations[1].toast_parent_oid='99999';assert.throws(()=>identityMaps(a.rows),/UNRESOLVED_CATALOG_REFERENCE/);
  const b=fixture();b.rows.relations.push({...b.rows.relations[1]});assert.throws(()=>identityMaps(b.rows),/DUPLICATE_RELATION_REFERENCE/);
  const c=fixture();c.rows.relations.push({...c.rows.relations[2],oid:'503',name:'extra'});assert.throws(()=>identityMaps(c.rows),/DUPLICATE_TOAST_INDEX/);
  const d=fixture();d.rows.relations.splice(2,1);assert.throws(()=>identityMaps(d.rows),/TOAST_INDEX_REFERENCE_REQUIRED/);
  const e=fixture();e.rows.relations.push({...e.rows.relations[1],oid:'504',name:'second'});assert.throws(()=>identityMaps(e.rows),/DUPLICATE_TOAST_PARENT/);
  const f=fixture();f.rows.relations[1].toast_parent_oid=null;assert.throws(()=>identityMaps(f.rows),/TOAST_PARENT_REFERENCE_REQUIRED/);
  const g=fixture();g.rows.relations[2].index_table_oid=null;assert.throws(()=>identityMaps(g.rows),/TOAST_INDEX_REFERENCE_REQUIRED/);
  const h=fixture();h.rows.relations[2].index_table_oid='900';assert.throws(()=>identityMaps(h.rows),/UNRESOLVED_TOAST_INDEX_REFERENCE/);
});
test('cross-parent state and unresolved state references refuse before normalization',()=>{
  const f=fixture(),detail=JSON.parse(f.objects[5].detail);detail.state.indrelid='900';f.objects[5].detail=JSON.stringify(detail);
  assert.throws(()=>normalized(f),/TOAST_INDEX_TABLE_REFERENCE_MISMATCH/);
  const g=fixture(),ordinary=JSON.parse(g.objects[6].detail);ordinary.state.indrelid='99999';g.objects[6].detail=JSON.stringify(ordinary);
  assert.throws(()=>normalized(g),/UNRESOLVED_CATALOG_REFERENCE/);
  const h=fixture(),unknown=JSON.parse(h.objects[5].detail);unknown.state.future_column=0;h.objects[5].detail=JSON.stringify(unknown);
  assert.throws(()=>normalized(h),/UNSUPPORTED_CATALOG_COLUMN/);
});
test('physical identifier mismatches, unsupported prefixes and incomplete tails refuse',()=>{
  for(const definition of ['CREATE UNIQUE INDEX pg_toast_500_index_suffix ON pg_toast.pg_toast_500 USING btree (chunk_id)',
    'CREATE UNIQUE INDEX pg_toast_500_index ON pg_toast.pg_toast_500_suffix USING btree (chunk_id)',
    'CREATE UNIQUE INDEX CONCURRENTLY pg_toast_500_index ON pg_toast.pg_toast_500 USING btree (chunk_id)',
    'CREATE UNIQUE INDEX pg_toast_500_index ON pg_toast.pg_toast_500 USING',
    'CREATE UNIQUE INDEX pg_toast_500_index ON pg_toast.pg_toast_500 USING    ']){
    const f=fixture(),detail=JSON.parse(f.objects[5].detail);detail.definition=definition;f.objects[5].detail=JSON.stringify(detail);
    assert.throws(()=>normalized(f));
  }
});
test('native number/string zero use the same default tablespace; unknown nonzero refuses',()=>{
  const a=fixture(),b=fixture();
  for(const row of b.objects.filter(r=>r.kind==='index')){const detail=JSON.parse(row.detail);
    detail.relation_state.tablespace='0';row.detail=JSON.stringify(detail);}
  assert.deepEqual(normalized(a),normalized(b));
  const c=fixture(),detail=JSON.parse(c.objects[5].detail);detail.relation_state.tablespace='99999';
  c.objects[5].detail=JSON.stringify(detail);assert.throws(()=>normalized(c),/UNRESOLVED_CATALOG_REFERENCE/);
});
test('relation wrapper must bind exact real catalog reference and original identity',()=>{
  const f=fixture(),row=f.objects[1];row.identity='pg_toast.pg_toast_500_suffix';assert.throws(()=>normalized(f),/RELATION_REFERENCE_IDENTITY_MISMATCH/);
  const g=fixture();g.objects[1].detail=JSON.stringify({relation:'99999',original_detail:'t:'});assert.throws(()=>normalized(g),/UNRESOLVED_CATALOG_REFERENCE/);
});

// Actual f43 public first-failure envelope, not an invented OID/name.
// Pure regression checks the producer's TEXT anchor and strict normalizer.
// A future authorized full readonly capture must verify native TEXT/complete identities.
import {CATALOG_OBJECTS_SQL} from './clued-handover-external-catalog.mjs';
const capturedLongIdentity={"schema":"clued.source-normalization-replay-input/1","authority":"none","metadata_only":true,"object":{"kind":"relation","identity":"realtime.subscription_subscription_id_entity_filters_action_fil","owner":"supabase_realtime_admin","detail":"{\"relation\": \"17581\", \"original_detail\": \"i:\"}"},"default_tablespace":"\"pg_default\"","maps":{"relations":[["17581","\"realtime\".\"subscription_subscription_id_entity_filters_action_filter_selec\""]],"physicalRelations":[["17581",{"oid":"17581","schema":"realtime","name":"subscription_subscription_id_entity_filters_action_filter_selec","kind":"i","toast_parent_oid":null,"index_table_oid":"17561"}]],"toastTables":[],"toastIndexes":[],"types":[],"roles":[],"tablespaces":[],"opclasses":[],"collations":[],"functions":[],"operators":[]}};
test('captured long catalog identity requires a TEXT producer column; truncated and wrong identities still refuse',()=>{
  const envelope=capturedLongIdentity;
  const maps=Object.fromEntries(Object.entries(envelope.maps).map(([key,entries])=>[key,new Map(entries)]));
  maps.defaultTablespace=envelope.default_tablespace;
  const captured=envelope.object,physical=maps.physicalRelations.get(JSON.parse(captured.detail).relation);
  const full=physical.schema+'.'+physical.name;
  assert.equal(Buffer.byteLength(captured.identity,'utf8'),63);
  assert.equal(Buffer.byteLength(full,'utf8'),72);
  assert.equal(captured.identity,Buffer.from(full,'utf8').subarray(0,63).toString('utf8'));
  assert.throws(()=>normalizeCatalogObjects([structuredClone(captured)],maps),/RELATION_REFERENCE_IDENTITY_MISMATCH/);
  // The exact first UNION branch forces the output column to TEXT before parsing;
  // do not cast the already truncated outer result or weaken the normalizer.
  assert.ok(CATALOG_OBJECTS_SQL.startsWith("select 'namespace' kind,n.nspname::text identity,"));
  const complete={...captured,identity:full};
  assert.deepEqual(normalizeCatalogObjects([complete],maps),[{...complete,detail:'i:'}]);
  assert.throws(()=>normalizeCatalogObjects([{...complete,identity:full+'_wrong'}],maps),/RELATION_REFERENCE_IDENTITY_MISMATCH/);
});

// Offline native-query replies only: actual F46 metadata supplies state/tags
// and real function references. No database connection or hook body execution.
import {localCatalog,verifyEmptyCluster,assertSemanticCatalogColumns,SEMANTIC_CATALOG_COLUMNS} from './clued-handover-external-catalog.mjs';
// Exact metadata-only slice of F46 f21fd4f7; inline so repository CI needs no local artifact.
const actualHooks=[{"evtname":"issue_graphql_placeholder","evtevent":"sql_drop","event_owner":"supabase_admin","function_oid":"16570","function_identity":"extensions.set_graphql_placeholder()","function_reference":"\"extensions\".\"set_graphql_placeholder\"()","evtenabled":"O","evttags":["DROP EXTENSION"]},{"evtname":"pgrst_ddl_watch","evtevent":"ddl_command_end","event_owner":"supabase_admin","function_oid":"16559","function_identity":"extensions.pgrst_ddl_watch()","function_reference":"\"extensions\".\"pgrst_ddl_watch\"()","evtenabled":"O","evttags":null},{"evtname":"pgrst_drop_watch","evtevent":"sql_drop","event_owner":"supabase_admin","function_oid":"16560","function_identity":"extensions.pgrst_drop_watch()","function_reference":"\"extensions\".\"pgrst_drop_watch\"()","evtenabled":"O","evttags":null},{"evtname":"issue_pg_cron_access","evtevent":"ddl_command_end","event_owner":"supabase_admin","function_oid":"16547","function_identity":"extensions.grant_pg_cron_access()","function_reference":"\"extensions\".\"grant_pg_cron_access\"()","evtenabled":"O","evttags":["CREATE EXTENSION"]},{"evtname":"issue_pg_net_access","evtevent":"ddl_command_end","event_owner":"supabase_admin","function_oid":"16549","function_identity":"extensions.grant_pg_net_access()","function_reference":"\"extensions\".\"grant_pg_net_access\"()","evtenabled":"O","evttags":["CREATE EXTENSION"]},{"evtname":"issue_pg_graphql_access","evtevent":"ddl_command_end","event_owner":"supabase_admin","function_oid":"16568","function_identity":"extensions.grant_pg_graphql_access()","function_reference":"\"extensions\".\"grant_pg_graphql_access\"()","evtenabled":"O","evttags":["CREATE EXTENSION"]}];
function eventCatalogClient(database='postgres',{change,shift=0,unknownReference=false}={}){
  const hooks=database==='postgres'?structuredClone(actualHooks):[],calls=[];
  if(change)Object.assign(hooks.find(h=>h.evtname==='pgrst_ddl_watch'),change);
  return {calls,async end(){},async query(sql){
    calls.push(sql);
    if(sql==="select current_setting('search_path') v")return {rows:[{v:'pg_catalog'}]};
    if(sql.startsWith('select set_config('))return {rows:[]};
    if(sql.startsWith('select c.relname catalog,a.attname'))return {rows:Object.entries(SEMANTIC_CATALOG_COLUMNS).flatMap(([catalog,columns])=>columns.map(column=>({catalog,column})))};
    if(sql.startsWith('select current_setting(\'server_version_num\')'))return {rows:[{v:'170011'}]};
    if(sql.startsWith('select p.oid::text oid,n.nspname schema,p.proname name'))return {rows:hooks.map(h=>({oid:String(BigInt(h.function_oid)+BigInt(shift)),schema:'extensions',name:/^extensions\.([a-z_]+)\(\)$/.exec(h.function_identity)[1],arguments:[]}))};
    if(sql.startsWith('select oid::text oid,spcname name'))return {rows:[{oid:'1663',name:'pg_default'}]};
    if(sql.startsWith('select dattablespace::text oid'))return {rows:[{oid:'1663'}]};
    if(sql.startsWith('select d.datname,'))return {rows:[{datname:'postgres',datallowconn:true},{datname:'template1',datallowconn:true},{datname:'template0',datallowconn:false}]};
    if(sql.startsWith('select evtname,evtevent,')){
      const fields=sql.slice(7,sql.indexOf(' from pg_event_trigger')).split(',');
      return {rows:hooks.map(h=>({evtname:h.evtname,evtevent:h.evtevent,owner:h.event_owner,
        function:unknownReference?'99999999':String(BigInt(h.function_oid)+BigInt(shift)),
        ...Object.fromEntries(['evtenabled','evttags'].filter(field=>fields.includes(field)).map(field=>[field,h[field]]))}))};
    }
    return {rows:[]};
  }};
}
async function expectedEventCatalog(){
  const postgres=await localCatalog(eventCatalogClient()),template=await localCatalog(eventCatalogClient('template1'));
  const global=['roles','databases','tablespaces'];
  return {schema:'clued.disposable-cluster-catalog/1',server_version_num:'170011',
    shared:Object.fromEntries(global.map(key=>[key,postgres.shared[key]])),nonconnectable_databases:['template0'],
    databases:{postgres:postgres.objects,template1:template.objects},table_counts_by_database:{postgres:[],template1:[]},
    auxiliary_by_database:Object.fromEntries([['postgres',postgres],['template1',template]].map(([db,value])=>[db,Object.fromEntries(Object.entries(value.shared).filter(([key])=>!global.includes(key)))]))};
}
test('event trigger actual enable/tag drift rejects full exact auxiliary comparison, including unrestricted-null versus empty tags',async()=>{
  const expected=await expectedEventCatalog(),rows=expected.auxiliary_by_database.postgres.event_triggers;
  assert.deepEqual(rows.map(row=>({name:row.evtname,enabled:row.evtenabled,tags:row.evttags})),actualHooks.map(h=>({name:h.evtname,enabled:h.evtenabled,tags:h.evttags})));
  const verify=options=>verifyEmptyCluster({admin:eventCatalogClient('postgres',options),connectDatabase:async db=>eventCatalogClient(db),expected,targetDatabase:'postgres'});
  assert.equal((await verify()).status,'EXACT_EMPTY_CLUSTER_CATALOG');
  for(const change of [{evtenabled:'D'},{evtenabled:'R'},{evttags:['CREATE EXTENSION']},{evttags:[]}])await assert.rejects(verify({change}),/CATALOG_AUX_postgres_event_triggers/);
});
test('event trigger real function references remain stable across physical OID changes and unknown references still reject',async()=>{
  const first=await localCatalog(eventCatalogClient()),other=await localCatalog(eventCatalogClient('postgres',{shift:500000}));
  assert.deepEqual(other.shared.event_triggers,first.shared.event_triggers);
  assert.deepEqual(first.shared.event_triggers.map(row=>row.function),actualHooks.map(h=>h.function_reference));
  await assert.rejects(localCatalog(eventCatalogClient('postgres',{unknownReference:true})),/UNRESOLVED_CATALOG_REFERENCE/);
});
test('event trigger PG17 semantic seven-column contract refuses missing or future extra columns before source normalization',()=>{
  const official=['oid','evtname','evtevent','evtowner','evtfoid','evtenabled','evttags'];
  assert.deepEqual(SEMANTIC_CATALOG_COLUMNS.pg_event_trigger,official);
  const known=Object.entries(SEMANTIC_CATALOG_COLUMNS).flatMap(([catalog,columns])=>columns.map(column=>({catalog,column})));
  assert.doesNotThrow(()=>assertSemanticCatalogColumns(known));
  assert.throws(()=>assertSemanticCatalogColumns(known.filter(row=>!(row.catalog==='pg_event_trigger'&&row.column==='evttags'))),/UNSUPPORTED_SEMANTIC_CATALOG_COLUMNS/);
  assert.throws(()=>assertSemanticCatalogColumns([...known,{catalog:'pg_event_trigger',column:'unknown_future_state'}]),/UNSUPPORTED_SEMANTIC_CATALOG_COLUMNS/);
});
