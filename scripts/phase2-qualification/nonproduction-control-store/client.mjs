// Internal storage primitive, never a signature verifier or registration issuer.
export const projectRef='uscrdifznmlvczcekqpw';
export const rootId='ctr_414bd3c724264a83894b0c55cf2ab878';
export function createControlStore({project,query}){
 if(project!==projectRef || typeof query!=='function') throw Error('Wrong explicit nonproduction transport');
 return Object.freeze({
  async read(){return (await query('select clued_control.read_root($1) value',[rootId])).rows[0].value;},
  async append(request){
   if(request?.root_set_id!==rootId) throw Error('Wrong limited root');
   return (await query('select clued_control.append_event($1::jsonb) value',[JSON.stringify(request)])).rows[0].value;
  }
 });
}
// No connection constructor, secret loading, generic Supabase RPC or target override.
// The privileged server transport and actual cryptographic acceptance are external prerequisites.
