"""Generate exact UNAPPLIED protocol successor files; write only this directory."""
import difflib
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SOURCE = 'f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec'
ROOT_ID = 'ctr_414bd3c724264a83894b0c55cf2ab878'
PROJECT = 'uscrdifznmlvczcekqpw'
URI = 'urn:clued:control-trust-root-set:' + PROJECT + ':{root_set_id}'
TARGET = 'protocol/continuity/v1/schemas/core/control-trust-root-set.schema.json'
MANIFEST = 'protocol/continuity/v1/manifest.json'
VERIFIER = 'scripts/verify-generated-artifacts.mjs'
REVISION = 'phase2-control-root-nonproduction-v1-20260908'
DEFINITION = '1.0.0-phase2-control-root-nonproduction'

def sha(raw): return hashlib.sha256(raw).hexdigest()
def canonical(x): return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
def dump(x): return (canonical(x) + '\n').encode('utf-8')
def obj(properties, required=None):
    return {'type':'object','properties':properties,'required':list(properties) if required is None else required,'additionalProperties':False}
def string(**kw): return {'type':'string', **kw}
def const(x): return {'const':x}
digest = string(pattern='^[0-9a-f]{64}$')
gen = string(pattern='^ctrgen_[0-9a-f]{32}$')
safe_integer = {'type':'integer','minimum':0,'maximum':9007199254740991}
ref = obj({'uri':string(minLength=1),'sha256':digest})
date = string(format='date-time')

def build():
    manifest_raw=(ROOT/MANIFEST).read_bytes()
    if sha(manifest_raw) != '05ca5bb70c642dba9c3f58c0b943020d6188636e60cc569b3802c90a9afd36b5':
        raise ValueError('Predecessor manifest changed; re-review exact successor')
    if (ROOT/TARGET).exists(): raise ValueError('Schema target already exists; successor rebase requires review')
    vector_raw=(ROOT/'scripts/phase2-qualification/contract-candidates/revocation-epoch-vector.candidate.schema.json').read_bytes()
    if sha(vector_raw) != 'c3c3c2ae05cd1f4f844f2f9898f1d29b2bfad2940975104847df41e1610831fe': raise ValueError('Reviewed epoch schema changed')
    vector=json.loads(vector_raw);vector.pop('$schema',None);vector.pop('title',None)
    schema=obj({
      'schema_version':const('1.0'), 'object_type':const('ControlTrustRootSet'),
      'root_set_id':const(ROOT_ID), 'control_trust_root_generation':gen,
      'generation_ordinal':{**safe_integer,'minimum':1},
      'predecessor':{'anyOf':[{'type':'null'},obj({'generation_id':gen,'sha256':digest})]},
      'purpose':const('SKILL_COEXISTENCE_QUALIFICATION'),
      'scope':obj({'project_ref':const(PROJECT),'repository':const('tdoljyj/cross-memory-system'),
          'profile_id':const('DP-PREENTRY-SKILL-QUALIFICATION'),'environment':const('ISOLATED_TEST'),
          'model_budget':const(0),'paid_budget':const(0)}),
      'issuer_bindings':{'type':'array','minItems':1,'uniqueItems':True,'items':obj({
          'subject_id':const('tdoljyj'),'signing_service':const('web-flow'),
          'purpose':{'enum':['STATUS','GATE_AUTHORIZATION','GATE_RESULT']},
          'audience':string(minLength=1),'qualification_ref':ref})},
      'audience':const('urn:clued:audience:skill-coexistence-qualification:'+PROJECT),
      'schema_digest':digest,
      'algorithm_config':obj({'canonicalization_id':const('SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE'),'digest_algorithm':const('SHA-256'),
          'signed_payload_excluded_fields':const(['signature_binding']),
          'signature_verification':const('GITHUB_API_VERIFIED_OWNER_MERGE'),
          'accepted_config_ref':ref}),
      'not_before':date,'expires_at':date,
      'history':obj({'index_uri':const(URI.replace('{root_set_id}',ROOT_ID)+'#history'),
          'prefix_digest':digest,'prefix_sequence':safe_integer,'minimum_accepted_generation':gen}),
      'revocation':obj({'events_uri':const(URI.replace('{root_set_id}',ROOT_ID)+'#revocations'),
          'event_set_digest':digest,'as_of':date,'expires_at':date}),
      'owner_approval_ref':ref,'independent_acceptance_ref':ref,
      'signature_binding':obj({'owner_merge_commit':string(pattern='^[0-9a-f]{40}$'),
          'signed_object_sha256':digest,'signature_evidence_ref':ref}),
      'status':{'enum':['REGISTERED','REVOKED']}
    })
    schema.update({'$schema':'https://json-schema.org/draft/2020-12/schema',
      '$id':'urn:clued:schema:control-trust-root-set:v1','title':'ControlTrustRootSet',
      '$comment':'New limited successor concretization, not a historical URI or issued root. Common draft-07/2020-12 assertion subset only. Shape validation grants no authority. S06 L3012 business Vector applies to its enumerated credentials/Profile, not this ControlTrustRootSet; no NA or epoch is invented here. History binds the complete pre-append prefix. Independent review subject excludes independent_acceptance_ref and signature_binding; signature payload excludes only signature_binding. Safe integer bound is the JS implementation limit.',
      'x-clued-definition-version':DEFINITION,'x-clued-generated-from':'sha256:'+SOURCE,
      'x-clued-compatibility':'limited-nonproduction-successor-candidate',
      'x-clued-source-lines':[200,237,868,925,2388,3010,3012,3885,4334,4336,4346]})
    schema['allOf']=[{'if':{'properties':{'generation_ordinal':{'const':1}}},
      'then':{'properties':{'predecessor':{'type':'null'},'control_trust_root_generation':{'const':'ctrgen_352785779b64458a889d571360e2d2d5'}}},
      'else':{'properties':{'predecessor':{'type':'object'}}}}]
    schema_raw=dump(schema)
    (HERE/'control-trust-root-set.schema.json').write_bytes(schema_raw)
    mapping={'object_type':'ControlTrustRootSet','uri_template':URI,'allowed_root_set_ids':[ROOT_ID],
      'project_ref':PROJECT,'adapter_kind':'PRIVATE_SQL_IN_EXISTING_NONPRODUCTION_CLUED',
      'query':'select clued_control.read_root($1) value','parameter':'root_set_id',
      'fragments':{'history':'events','revocations':'events filtered to ROOT_REVOKED or GENERATION_REVOKED'},
      'schema_path':TARGET,'schema_sha256':sha(schema_raw),'public_rest_exposure':False,
      'new_concretization_not_historical_template':True,'authority_effect':'NONE'}
    (HERE/'ControlUriMapping.json').write_bytes(dump(mapping))
    successor_meta={'revision_id':REVISION,'root_set_id':ROOT_ID,'source_contract':'sha256:'+SOURCE,
       'predecessor_manifest_sha256':sha(manifest_raw),'schema_sha256':sha(schema_raw),
       'authority_effect':'NONE','scope':'NEW_SCHEMA_AND_TYPED_URI_ONLY_NOT_ROOT_REGISTRATION'}
    old_verifier_raw=(ROOT/VERIFIER).read_bytes()
    old_verifier_entry=next(e for e in json.loads(manifest_raw)['entries'] if e['path']==VERIFIER)
    if old_verifier_entry['sha256']!='sha256:'+sha(old_verifier_raw) or old_verifier_entry['size']!=len(old_verifier_raw):
        raise ValueError('Existing verifier differs from exact predecessor manifest binding')
    old_verifier=old_verifier_raw.decode('utf-8')
    new_verifier=old_verifier.replace(
      "  if (!Array.isArray(manifest.entries) || manifest.entries.length !== 91) throw new Error('manifest entry set must contain exact 91 non-manifest artifacts');",
      "  const controlSuccessor = manifest.control_root_successor;\n"
      "  const limitedControlSuccessor = controlSuccessor?.revision_id === '"+REVISION+"';\n"
      "  if (controlSuccessor && !limitedControlSuccessor) throw new Error('unknown control root successor');\n"
      "  if (!limitedControlSuccessor && manifest.control_uri_templates) throw new Error('control mapping without accepted successor identity');\n"
      "  if (limitedControlSuccessor && (!same(controlSuccessor, "+canonical(successor_meta)+") || !same(manifest.control_uri_templates, "+canonical({'ControlTrustRootSet':mapping})+"))) throw new Error('control successor scope mismatch');\n"
      "  if (!Array.isArray(manifest.entries) || manifest.entries.length !== (limitedControlSuccessor ? 92 : 91)) throw new Error('exact manifest entry count mismatch');\n"
      "  if (limitedControlSuccessor && !manifest.entries.some(e => e.path === '"+TARGET+"' && e.sha256 === 'sha256:' + controlSuccessor.schema_sha256)) throw new Error('control successor schema binding mismatch');")
    new_verifier=new_verifier.replace("  if (schemaPaths.length !== 65) throw new Error('schema count must be 65, got ' + schemaPaths.length);",
      "  const hasControlRoot = paths.has('"+TARGET+"');\n  if (schemaPaths.length !== (hasControlRoot ? 66 : 65)) throw new Error('exact schema count mismatch');")
    new_verifier=new_verifier.replace("    const expectedDefinition = modelPaths.has(path) ? MODEL_SCHEMA_V2_DEFINITION : '1.0.0-local-rc-v15';",
      "    const expectedDefinition = path === '"+TARGET+"' ? '"+DEFINITION+"' : (modelPaths.has(path) ? MODEL_SCHEMA_V2_DEFINITION : '1.0.0-local-rc-v15');")
    if new_verifier==old_verifier: raise ValueError('Expected validator anchors missing')
    new_verifier_raw=new_verifier.encode('utf-8')
    (HERE/'verify-generated-artifacts.candidate.mjs').write_bytes(new_verifier_raw)
    m=json.loads(manifest_raw)
    if 'control_uri_templates' in m or 'control_root_successor' in m: raise ValueError('Existing successor mapping requires semantic merge')
    m['control_uri_templates']={'ControlTrustRootSet':mapping}
    m['control_root_successor']=successor_meta
    for e in m['entries']:
        if e['path']==VERIFIER: e.update(sha256='sha256:'+sha(new_verifier_raw),size=len(new_verifier_raw))
    m['entries'].append({'path':TARGET,'sha256':'sha256:'+sha(schema_raw),'size':len(schema_raw)})
    m['entries'].sort(key=lambda e:e['path'])
    m['content_tree_digest']='sha256:'+sha(canonical(m['entries']).encode('utf-8'))
    successor_raw=dump(m);(HERE/'manifest.candidate.json').write_bytes(successor_raw)
    diff=''.join(difflib.unified_diff([],schema_raw.decode().splitlines(True),fromfile='/dev/null',tofile='b/'+TARGET))
    diff+=''.join(difflib.unified_diff(manifest_raw.decode().splitlines(True),successor_raw.decode().splitlines(True),fromfile='a/'+MANIFEST,tofile='b/'+MANIFEST))
    diff+=''.join(difflib.unified_diff(old_verifier.splitlines(True),new_verifier.splitlines(True),fromfile='a/'+VERIFIER,tofile='b/'+VERIFIER))
    (HERE/'ProtocolSuccessor.patch').write_bytes(diff.encode('utf-8'))
    print(json.dumps({'schema_sha256':sha(schema_raw),'manifest_sha256':sha(successor_raw),
      'patch_sha256':sha(diff.encode()),'verifier_sha256':sha(new_verifier_raw),'downstream_mapping_digest_unchanged':m['downstream_mapping_digest']}))

if __name__=='__main__': build()
