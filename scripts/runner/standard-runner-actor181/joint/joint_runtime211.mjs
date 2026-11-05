import {createHash} from 'node:crypto';
import {buildCapturedOwnedPair181} from './captured_pair_launch181.mjs';
import {spawnCapturedRunner181} from './runner_spawn_transport211.mjs';
const PINS=Object.freeze({"runner_entry":"19eb2653409aa505d894ab26d4a12444eda9260ae48640de951f34af1e0e79dc","runner_wrapper":"769044544957af1c79d39e6cf30c49b6adc5900ec960e2e1846e27c43a3c9db3","provider_client":"b71d7eb8159942d94bc6ea14c0a572b3c5cea7636140c373fc3dcdebd07932d1","local_pipe":"579063ff78159c37f36cd2af12b4802e6c5da38b7138f24ef7c97d66377b7d8f","relay_server":"a605e93536b31d5018f17e991e38c11f9dccd95f982eb61ade15ae5394f35aa3","relay_wrapper":"09e211957c29aeeedca084185f0c676f6b92157880f7f1e7f3b130e79b8248b8","ba_wrapper":"eeabca53245fec8cc5b872da58c4ab0c64932cb88da05d2e29c0ac5fc73d15c2","observer_entry":"6d2ae34fc7bc390708120e1b3f653fa49c49ac1ae9f7a61f77ddf08daa27f079","actor":"c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616","observer_core":"017d894f54a7bef4fae447b7e3b04d0c0faa29011efafb5b1e603b185d2ff95c","observer_os":"c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a","identity":"31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8","definition":"0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4","registration":"642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb"});
const need=(ok,code)=>{if(!ok)throw Error(code)};
// Mechanical Source composition only; no paths, Owner permit, credentials or
// authority argument. This object grants no right to spawn or register/run.
// Root's accepted bootstrap must own and authorize every actual effect first.
export function composeJointRuntime211(captured){
 const d=Object.getOwnPropertyDescriptors(captured??{});
 need(Object.keys(d).sort().join('|')===Object.keys(PINS).sort().join('|'),'JOINT_EXACT_MEMBERS');
 const b={};for(const k of Object.keys(PINS)){need('value'in d[k]&&Buffer.isBuffer(d[k].value)&&d[k].value.length>0&&d[k].value.length<=1048576,'JOINT_BYTES');b[k]=Buffer.from(d[k].value);need(createHash('sha256').update(b[k]).digest('hex')===PINS[k],'JOINT_PIN');}
 const observer={wrapperBytes:b.ba_wrapper,captures:{observer_entry:b.observer_entry,actor:b.actor,observer_core:b.observer_core,observer_os:b.observer_os,identity_dll:b.identity,definition:b.definition,registration:b.registration}};
 const relay={wrapperBytes:b.relay_wrapper,captures:{server:b.relay_server,actor:b.actor,identity:b.identity,local_pipe:b.local_pipe,observer_os:b.observer_os}};
 const runner={wrapperBytes:b.runner_wrapper,captures:{runner_entry:b.runner_entry,actor:b.actor,identity:b.identity,definition:b.definition,registration:b.registration,observer_os:b.observer_os,local_pipe:b.local_pipe,provider_client:b.provider_client}};
 const pair=buildCapturedOwnedPair181({observer,relay});let spent=false;
 return Object.freeze({pair,
  spawnOwnedSelfOnce(){need(!spent,'JOINT_SELF_SPAWN_ONCE');spent=true;return spawnCapturedRunner181(runner);},
  source_pins:PINS,execution_authority:false,qualification:false});
}
