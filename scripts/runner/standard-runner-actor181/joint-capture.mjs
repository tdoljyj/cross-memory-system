// The reviewed mechanical modules are evaluated from the same held bytes as
// their captured tools. Relative imports are replaced only at four fixed edges.
import {createHash} from 'node:crypto';
const MODULE_PINS=Object.freeze({'ba_observer_launcher181.mjs':'2275ba693f84d6a79783bd29771afedf7996a0c94f4ab11d10a15f09c6dc22c4','captured_pair_launch181.mjs':'08ec2e011495b0960fb380fa08ec141199b968c31ec4814249e4aa2240a50a70','runner_spawn_transport211.mjs':'05306130b91a56d3958c4ae4d2ffc5380f5278a7b9e8d114bc62fc34734d95e7','joint_runtime211.mjs':'37248bb933bb38e35c834b8c3f38a1d97b808e66144c9afe5e93de12a431d99e'});
const url=raw=>'data:text/javascript;base64,'+raw.toString('base64');
const fail=()=>{throw Error('JOINT_CAPTURE_IMPORT_REFUSED');};
export async function captureJointRuntime211(captured){
 const raw=name=>{const descriptor=Object.getOwnPropertyDescriptor(captured,'joint/'+name),v=descriptor?.value;if(!Buffer.isBuffer(v)||v.length<1||v.length>65536)fail();const b=Buffer.from(v);if(createHash('sha256').update(b).digest('hex')!==MODULE_PINS[name])fail();return b;};
 const rewrite=(name,edges)=>{let text=raw(name).toString('utf8');for(const [from,to]of edges){if(text.split(from).length!==2)fail();text=text.replace(from,to);}return Buffer.from(text);};
 const ba=url(raw('ba_observer_launcher181.mjs'));
 const pair=url(rewrite('captured_pair_launch181.mjs',[["'./ba_observer_launcher181.mjs'",JSON.stringify(ba)]]));
 const runner=url(raw('runner_spawn_transport211.mjs'));
 const joint=url(rewrite('joint_runtime211.mjs',[["'./captured_pair_launch181.mjs'",JSON.stringify(pair)],["'./runner_spawn_transport211.mjs'",JSON.stringify(runner)]]));
 const module=await import(joint);
 const mapping={runner_entry:'joint/runner_entry_runtime181.ps1',runner_wrapper:'joint/runner_pipe_wrapper_runtime181.ps1',provider_client:'joint/provider_client_runtime181.ps1',local_pipe:'joint/LocalPipeTransportRuntime181.dll',relay_server:'joint/authority_server_with_reader181.ps1',relay_wrapper:'joint/relay_stdio_wrapper181.ps1',ba_wrapper:'joint/ba_observer_wrapper181.ps1',observer_entry:'capture/observer_entry.ps1',actor:'capture/actor.ps1',observer_core:'capture/observer_core.ps1',observer_os:'capture/observer_os.ps1',identity:'capture/identity.dll',definition:'capture/definition.ps1',registration:'capture/registration.ps1'};
 const buffers={};for(const [name,key]of Object.entries(mapping)){if(!Buffer.isBuffer(captured[key]))fail();buffers[name]=Buffer.from(captured[key]);}
 return module.composeJointRuntime211(buffers);
}
