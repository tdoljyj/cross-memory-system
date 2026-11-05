import {captureInstalledSources} from './source-capture.mjs';import {composeOwnedProvider208} from './provider-core.mjs';import {resolveRootOwnedInvocation,readiness} from './installed-authority.mjs';import {refuse} from './errors.mjs';
import {captureJointRuntime211} from './joint-capture.mjs';
import {readActualNodePrimary211} from './node-runtime/read-node-primary.mjs';
import {projectNodeRuntime211} from './node-runtime/runtime-projection.mjs';
export {safeProviderCode,refuse} from './errors.mjs';export {readiness};
export async function resolveInstalledNativeStandardRunnerActorPort(){if(arguments.length!==0)refuse('PROVIDER_ARGUMENTS_REFUSED');
 // Captures clone every reviewed byte before importing a mechanical transport.
 // Without the exact private Root/Source/Owner/CI connection, the no-argument
 // factory refuses before an executable actor can be authorized.
 const captured=captureInstalledSources();const attached=await resolveRootOwnedInvocation();
 const authority=Object.freeze({...attached,readActualNodePrimaryRuntime:async()=>projectNodeRuntime211(await readActualNodePrimary211())});
 const mechanics=await captureJointRuntime211(captured);
 return composeOwnedProvider208({authority,captured,mechanics});
}
