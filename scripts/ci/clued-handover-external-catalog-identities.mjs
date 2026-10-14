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

// Only catalog JOINs establish TOAST ownership. Physical names never do.
function relationMaps(rows){
  const physical=new Map(),relations=new Map(),toastTables=new Map(),toastIndexes=new Map();
  for(const row of rows){
    const oid=String(row.oid);assert.ok(!physical.has(oid),'DUPLICATE_RELATION_REFERENCE');
    if(row.kind==='t')assert.ok(row.toast_parent_oid!==null&&row.toast_parent_oid!==undefined,'TOAST_PARENT_REFERENCE_REQUIRED');
    if(row.kind==='i'&&/^pg_toast(?:_temp_[0-9]+)?$/.test(row.schema))
      assert.ok(row.index_table_oid!==null&&row.index_table_oid!==undefined,'TOAST_INDEX_REFERENCE_REQUIRED');
    physical.set(oid,row);relations.set(oid,qualified(row.schema,row.name));
  }
  const parents=new Set();
  for(const row of rows){
    if(row.toast_parent_oid===null||row.toast_parent_oid===undefined)continue;
    const parent=lookup(physical,row.toast_parent_oid);
    assert.ok(row.kind==='t'&&/^pg_toast(?:_temp_[0-9]+)?$/.test(row.schema)&&
      ['r','m'].includes(parent.kind),'UNSUPPORTED_TOAST_PARENT');
    assert.ok(!parents.has(String(parent.oid)),'DUPLICATE_TOAST_PARENT');parents.add(String(parent.oid));
    const binding={parent:qualified(parent.schema,parent.name),table_oid:String(row.oid),table:row};
    binding.table_name='TOAST_OF:'+binding.parent;
    binding.table_identity=qualified(row.schema,binding.table_name);
    toastTables.set(String(row.oid),binding);relations.set(String(row.oid),binding.table_identity);
  }
  const indexed=new Set();
  for(const row of rows){
    if(row.index_table_oid===null||row.index_table_oid===undefined)continue;
    const table=lookup(physical,row.index_table_oid),binding=toastTables.get(String(table.oid));
    if(!binding){assert.ok(!/^pg_toast(?:_temp_[0-9]+)?$/.test(row.schema),'UNRESOLVED_TOAST_INDEX_REFERENCE');continue;}
    assert.ok(row.kind==='i'&&row.schema===table.schema,'UNSUPPORTED_TOAST_INDEX');
    assert.ok(!indexed.has(String(table.oid)),'DUPLICATE_TOAST_INDEX');indexed.add(String(table.oid));
    const index_name='TOAST_INDEX_OF:'+binding.parent;
    const index={...binding,index_oid:String(row.oid),index:row,index_name,
      index_identity:qualified(row.schema,index_name)};
    toastIndexes.set(String(row.oid),index);relations.set(String(row.oid),index.index_identity);
  }
  assert.equal(indexed.size,toastTables.size,'TOAST_INDEX_REFERENCE_REQUIRED');
  assert.equal(new Set(relations.values()).size,relations.size,'DUPLICATE_RELATION_IDENTITY');
  return {relations,physicalRelations:physical,toastTables,toastIndexes};
}

// Parse just the native CREATE INDEX identifier prefix. Preserve its entire
// tail verbatim, including numeric constants and quoted/string expressions.
function toastIndexDefinition(sql,binding,unique){
  assert.equal(typeof sql,'string','NATIVE_INDEX_DEFINITION_REQUIRED');let at=0;
  const space=()=>{while(at<sql.length&&/\s/.test(sql[at]))at++;};
  const keyword=word=>{space();assert.equal(sql.slice(at,at+word.length),word,'UNSUPPORTED_NATIVE_INDEX_PREFIX');
    at+=word.length;assert.ok(!/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[at]??''),'INDEX_TOKEN_BOUNDARY_REQUIRED');};
  const identifier=()=>{
    space();const start=at;let value='';
    if(sql[at]==='"'){
      at++;let closed=false;
      while(at<sql.length){if(sql[at]==='"'){if(sql[at+1]==='"'){value+='"';at+=2;}else{at++;closed=true;break;}}
        else value+=sql[at++];}
      assert.ok(closed&&value.length,'INDEX_IDENTIFIER_REQUIRED');
    }else{
      const m=/^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(sql.slice(at));
      assert.ok(m,'INDEX_IDENTIFIER_REQUIRED');value=m[0];at+=m[0].length;
    }
    return {start,end:at,value};
  };
  const name=()=>{const first=identifier();space();if(sql[at]!=='.')return {...first,parts:[first.value]};
    at++;const second=identifier();return {start:first.start,end:second.end,parts:[first.value,second.value]};};
  keyword('CREATE');if(unique)keyword('UNIQUE');keyword('INDEX');
  const index=name();assert.deepEqual(index.parts.length===1?[binding.index.schema,...index.parts]:index.parts,
    [binding.index.schema,binding.index.name],'NATIVE_TOAST_INDEX_NAME_MISMATCH');
  keyword('ON');const table=name();assert.deepEqual(table.parts,
    [binding.table.schema,binding.table.name],'NATIVE_TOAST_TABLE_NAME_MISMATCH');
  keyword('USING');assert.ok(at<sql.length&&/\s/.test(sql[at]),'NATIVE_INDEX_TAIL_REQUIRED');
  identifier(); // Native access-method identifier is required; tail bytes stay unchanged.
  return sql.slice(0,index.start)+quoted(binding.index_name)+sql.slice(index.end,table.start)+
    binding.table_identity+sql.slice(table.end);
}

export function identityMaps(rows){
  const plain=(name,identify)=>new Map(rows[name].map(r=>[String(r.oid),identify(r)]));
  const maps={...relationMaps(rows.relations),types:plain('types',r=>qualified(r.schema,r.name)),
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
    relations:"select c.oid::text oid,n.nspname schema,c.relname name,c.relkind kind,"+
      "p.oid::text toast_parent_oid,i.indrelid::text index_table_oid from pg_class c "+
      "join pg_namespace n on n.oid=c.relnamespace left join pg_class p on p.reltoastrelid=c.oid "+
      "left join pg_index i on i.indexrelid=c.oid",
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
    if(row.kind==='relation'){
      const reference=JSON.parse(row.detail);
      assert.deepEqual(Object.keys(reference).sort(),['original_detail','relation'],'UNSUPPORTED_RELATION_REFERENCE');
      const physical=lookup(maps.physicalRelations,reference.relation);
      assert.equal(row.identity,physical.schema+'.'+physical.name,'RELATION_REFERENCE_IDENTITY_MISMATCH');
      assert.equal(typeof reference.original_detail,'string','RELATION_DETAIL_REQUIRED');
      const toast=maps.toastTables.get(String(reference.relation))||maps.toastIndexes.get(String(reference.relation));
      return {...row,identity:toast?lookup(maps.relations,reference.relation):row.identity,detail:reference.original_detail};
    }
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
      const toast=maps.toastIndexes.get(String(state.indexrelid));
      if(toast){
        assert.equal(String(state.indrelid),toast.table_oid,'TOAST_INDEX_TABLE_REFERENCE_MISMATCH');
        assert.equal(row.identity,toast.index.schema+'.'+toast.index.name,'TOAST_INDEX_REFERENCE_IDENTITY_MISMATCH');
        detail.definition=toastIndexDefinition(detail.definition,toast,state.indisunique);
      }else assert.ok(!maps.toastTables.has(String(state.indrelid)),'UNRESOLVED_TOAST_INDEX_REFERENCE');
      state.indexrelid=lookup(maps.relations,state.indexrelid);
      state.indrelid=lookup(maps.relations,state.indrelid);
      state.indclass=vector(state.indclass).map(oid=>lookup(maps.opclasses,oid));
      state.indcollation=vector(state.indcollation).map(oid=>lookup(maps.collations,oid,{zero:'NO_COLLATION'}));
      // Native deparse binds complete expression SQL instead of physical IDs
      // and parser source-location numbers inside pg_node_tree.
      assert.ok(Object.hasOwn(detail,'expressions')&&Object.hasOwn(detail,'predicate'));
      state.indexprs=detail.expressions;state.indpred=detail.predicate;
      detail.relation_state.tablespace=lookup(maps.tablespaces,detail.relation_state.tablespace,
        {zero:'DATABASE_DEFAULT:'+maps.defaultTablespace});
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
