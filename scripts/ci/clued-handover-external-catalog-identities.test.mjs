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
