'use strict';
// Called only by the fixed Host that owns the local child's private stdio pipes.
// Captures the already issued Profile binding and real protected Clued reader.
// No process launch, Profile issuance, permission or generic command is exposed.
const SCHEMA = 'clued.development-currentness-channel/1';
const MAX_FRAME_BYTES = 32768;
const PHASES = new Set(['preflight','before_observation_open','observation_opened','consume',
  'before_start','before_resume','running','before_result']);
const stable = value => {
  if(Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if(value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',') + '}';
  if(typeof value==='number' && !Number.isFinite(value)) throw new Error('NONFINITE_BINDING');
  const encoded=JSON.stringify(value);
  if(encoded===undefined) throw new Error('INVALID_BINDING');
  return encoded;
};
const need=(ok,code)=>{if(!ok)throw new Error('DEVELOPMENT_HOST_BRIDGE_'+code);};

function makeDevelopmentHostBridge({reader,bound}) {
  need(typeof reader?.read==='function' && bound && typeof bound==='object', 'CAPTURED_READER_REQUIRED');
  const captured=JSON.parse(stable(bound));
  const seal=stable(captured);
  const read=reader.read.bind(reader);
  let sequence=0, busy=false, sealed=false;
  async function handle(request) {
    need(!busy && !sealed, 'SEALED_OR_CONCURRENT');
    busy=true;
    try {
      need(request && Object.keys(request).sort().join(',')==='binding,id,phase,schema,sequence', 'FRAME_FIELDS');
      need(request.schema===SCHEMA && typeof request.id==='string' && /^[0-9a-f]{32}$/.test(request.id)
        && request.sequence===sequence+1 && request.sequence<=4096 && PHASES.has(request.phase), 'FRAME_IDENTITY_OR_REPLAY');
      need(stable(request.binding)===seal, 'CAPTURED_BINDING_DRIFT');
      sequence=request.sequence;
      const base={schema:SCHEMA,id:request.id,sequence,phase:request.phase};
      try {
        // The real reader revalidates its own exact issued pins. Child-supplied
        // content never changes the captured binding passed to that reader.
        const observation=await read(request.phase,JSON.parse(seal));
        need(stable(captured)===seal, 'CAPTURED_BINDING_MUTATED');
        return {...base,admitted:true,observation};
      } catch {
        sealed=true;
        // Do not relay raw tool errors, private records, tokens or credentials.
        return {...base,admitted:false,observation:null};
      }
    } catch(error) {
      sealed=true;
      throw error;
    } finally {busy=false;}
  }
  return Object.freeze({handle});
}

function makeCluedDevelopmentHostBridge({tools,ownerCapture,issued,sessionRef,bound}) {
  // Production composition uses the real protected-tool reader, not a child-
  // supplied callback or a serialized observation. Issuance stays external.
  const {makeDevelopmentCurrentnessReader}=require('./development_clued_currentness.cjs');
  const reader=makeDevelopmentCurrentnessReader({tools,ownerCapture,issued,sessionRef});
  return makeDevelopmentHostBridge({reader,bound});
}

module.exports=Object.freeze({makeCluedDevelopmentHostBridge,makeDevelopmentHostBridge,SCHEMA,MAX_FRAME_BYTES});
