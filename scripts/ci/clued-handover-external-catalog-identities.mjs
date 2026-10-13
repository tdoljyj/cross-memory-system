// Real catalog rows supply these maps. OIDs never become acceptance identity.
import assert from 'node:assert/strict';
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
export const qualified=(schema,name)=>quoted(schema)+'.'+quoted(name);
const vector=value=>Array.isArray(value)?value:String(value).trim().replace(/^\{|\}$/g,'').split(/[\s,]+/).filter(Boolean);
const lookup=(map,oid,{zero}={})=>{
  if(String(oid)==='0'&&zero!==undefined)return zero;
  const identity=map.get(String(oid));assert.ok(identity,'UNRESOLVED_CATALOG_REFERENCE');return identity;
};
export const catalogReference=(maps,kind,oid,zero)=>lookup(maps[kind],oid,{zero});
const columns=(state,known)=>{
  for(const key of Object.keys(state))assert.ok(known.includes(key),'UNSUPPORTED_CATALOG_COLUMN:'+key);
};
const INDEX_COLUMNS=['indexrelid','indrelid','indnatts','indnkeyatts','indisunique','indnullsnotdistinct',
  'indisprimary','indisexclusion','indimmediate','indisclustered','indisvalid','indcheckxmin','indisready',
  'indislive','indisreplident','indkey','indcollation','indclass','indoption','indexprs','indpred'];
const POLICY_COLUMNS=['oid','polname','polrelid','polcmd','polpermissive','polroles','polqual','polwithcheck'];
const AGG_FN=['aggfnoid','aggtransfn','aggfinalfn','aggcombinefn','aggserialfn','aggdeserialfn',
  'aggmtransfn','aggminvtransfn','aggmfinalfn'];
const AGG_TYPE=['aggtranstype','aggmtranstype'];
const AGG_COLUMNS=[...AGG_FN,...AGG_TYPE,'aggkind','aggnumdirectargs','aggfinalextra','aggmfinalextra',
  'aggfinalmodify','aggmfinalmodify','aggsortop','aggtransspace','aggmtransspace','agginitval','aggminitval'];

export function identityMaps(rows){
  const plain=(name,identify)=>new Map(rows[name].map(r=>[String(r.oid),identify(r)]));
  const maps={relations:plain('relations',r=>qualified(r.schema,r.name)),types:plain('types',r=>qualified(r.schema,r.name)),
    roles:plain('roles',r=>quoted(r.name)),tablespaces:plain('tablespaces',r=>quoted(r.name)),
    opclasses:plain('opclasses',r=>qualified(r.schema,r.name)+'@'+quoted(r.method)),
    collations:plain('collations',r=>qualified(r.schema,r.name)+'@encoding='+r.encoding)};
  maps.functions=new Map(rows.functions.map(r=>[String(r.oid),qualified(r.schema,r.name)+'('+
    vector(r.arguments).map(oid=>lookup(maps.types,oid)).join(',')+')']));
  maps.operators=new Map(rows.operators.map(r=>[String(r.oid),qualified(r.schema,r.name)+'('+
    lookup(maps.types,r.left,{zero:'NONE'})+','+lookup(maps.types,r.right,{zero:'NONE'})+')']));
  maps.defaultTablespace=lookup(maps.tablespaces,rows.database_tablespace);
  return maps;
}
export async function catalogIdentityMaps(client){
  const read=async sql=>(await client.query(sql)).rows;
  const rows={};
  for(const [name,sql] of Object.entries({
    relations:"select c.oid::text oid,n.nspname schema,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace",
    types:"select t.oid::text oid,n.nspname schema,t.typname name from pg_type t join pg_namespace n on n.oid=t.typnamespace",
    roles:"select oid::text oid,rolname name from pg_roles",
    tablespaces:"select oid::text oid,spcname name from pg_tablespace",
    opclasses:"select o.oid::text oid,n.nspname schema,o.opcname name,a.amname method from pg_opclass o join pg_namespace n on n.oid=o.opcnamespace join pg_am a on a.oid=o.opcmethod",
    collations:"select c.oid::text oid,n.nspname schema,c.collname name,c.collencoding encoding from pg_collation c join pg_namespace n on n.oid=c.collnamespace",
    functions:"select p.oid::text oid,n.nspname schema,p.proname name,p.proargtypes::oid[] arguments from pg_proc p join pg_namespace n on n.oid=p.pronamespace",
    operators:"select o.oid::text oid,n.nspname schema,o.oprname name,o.oprleft::text \"left\",o.oprright::text \"right\" from pg_operator o join pg_namespace n on n.oid=o.oprnamespace",
  }))rows[name]=await read(sql);
  rows.database_tablespace=(await read('select dattablespace::text oid from pg_database where datname=current_database()'))[0].oid;
  return identityMaps(rows);
}
export function normalizeCatalogObjects(objects,maps){
  return objects.map(row=>{
    if(row.kind==='operator'||row.kind==='conversion'){
      const refs=JSON.parse(row.detail);
      assert.deepEqual(Object.keys(refs).sort(),(row.kind==='operator'?['operator','function']:['function']).sort(),
        'UNSUPPORTED_OBJECT_REFERENCE');
      return {...row,identity:row.kind==='operator'?lookup(maps.operators,refs.operator):row.identity,
        detail:lookup(maps.functions,refs.function,{zero:'NONE'})};
    }
    if(!['index','policy','aggregate'].includes(row.kind))return row;
    const detail=JSON.parse(row.detail),state=detail.state;
    assert.ok(state&&typeof state==='object');
    if(row.kind==='index'){
      columns(state,INDEX_COLUMNS);
      state.indexrelid=lookup(maps.relations,state.indexrelid);
      state.indrelid=lookup(maps.relations,state.indrelid);
      state.indclass=vector(state.indclass).map(oid=>lookup(maps.opclasses,oid));
      state.indcollation=vector(state.indcollation).map(oid=>lookup(maps.collations,oid,{zero:'NO_COLLATION'}));
      // Native deparse binds complete expression SQL instead of physical IDs
      // and parser source-location numbers inside pg_node_tree.
      assert.ok(Object.hasOwn(detail,'expressions')&&Object.hasOwn(detail,'predicate'));
      state.indexprs=detail.expressions;state.indpred=detail.predicate;
      detail.relation_state.tablespace=detail.relation_state.tablespace===0
        ?'DATABASE_DEFAULT:'+maps.defaultTablespace:lookup(maps.tablespaces,detail.relation_state.tablespace);
    }else if(row.kind==='policy'){
      columns(state,POLICY_COLUMNS);
      state.polrelid=lookup(maps.relations,state.polrelid);
      state.oid=state.polrelid+'.'+quoted(state.polname);
      state.polroles=vector(state.polroles).map(oid=>lookup(maps.roles,oid,{zero:'PUBLIC'})).sort();
      assert.ok(Object.hasOwn(detail,'qual')&&Object.hasOwn(detail,'withcheck'));
      state.polqual=detail.qual;state.polwithcheck=detail.withcheck;
    }else{
      columns(state,AGG_COLUMNS);
      assert.deepEqual(Object.keys(detail.references).sort(),[...AGG_FN,...AGG_TYPE,'aggsortop'].sort(),
        'UNSUPPORTED_AGGREGATE_REFERENCE');
      for(const key of AGG_FN)state[key]=lookup(maps.functions,detail.references[key],{zero:'NONE'});
      for(const key of AGG_TYPE)state[key]=lookup(maps.types,detail.references[key],{zero:'NONE'});
      state.aggsortop=lookup(maps.operators,detail.references.aggsortop,{zero:'NONE'});
      delete detail.references; // every reference explicitly mapped above
    }
    return {...row,identity:row.kind==='index'?state.indexrelid:row.kind==='policy'?state.oid:state.aggfnoid,
      detail:JSON.stringify(detail)};
  });
}
