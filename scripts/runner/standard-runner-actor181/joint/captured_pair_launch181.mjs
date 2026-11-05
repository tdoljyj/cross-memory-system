import {createHash} from 'node:crypto';
import {buildCapturedBAObserverLaunch181} from './ba_observer_launcher181.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error(code)};
const relayWrapperPin='09e211957c29aeeedca084185f0c676f6b92157880f7f1e7f3b130e79b8248b8';
const relayPins=Object.freeze({server:'a605e93536b31d5018f17e991e38c11f9dccd95f982eb61ade15ae5394f35aa3',actor:'c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616',identity:'31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8',local_pipe:'579063ff78159c37f36cd2af12b4802e6c5da38b7138f24ef7c97d66377b7d8f',observer_os:'c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a'});
export function buildCapturedRelayLaunch181({wrapperBytes,captures}){
 need(Buffer.isBuffer(wrapperBytes),'RELAY_WRAPPER_BYTES');const wrapper=Buffer.from(wrapperBytes);need(hash(wrapper)===relayWrapperPin,'RELAY_WRAPPER_PIN');const entries=Object.getOwnPropertyDescriptors(captures??{});need(Object.keys(entries).sort().join('|')===Object.keys(relayPins).sort().join('|'),'RELAY_EXACT_MEMBERS');const data={};
 for(const name of Object.keys(relayPins)){const d=entries[name];need('value'in d&&Buffer.isBuffer(d.value)&&d.value.length>0&&d.value.length<=1048576,'RELAY_SOURCE_BOUND');const raw=Buffer.from(d.value);need(hash(raw)===relayPins[name],'RELAY_SOURCE_PIN');data[name]=raw.toString('base64');}
 const payload=JSON.stringify({schema:'clued.root-owned-relay-capture181/1',captures:data});need(Buffer.byteLength(payload)<=2097152,'RELAY_PAYLOAD_BOUND');
 const script="$ProgressPreference='SilentlyContinue';$script:OwnedRelayStdin181=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true);$line=$script:OwnedRelayStdin181.ReadLine();if($null-eq $line-or $line.Length-gt 30000){throw 'RELAY_WRAPPER_BOUND'};$raw=[Convert]::FromBase64String($line);$sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($actual-cne '"+relayWrapperPin+"'){throw 'RELAY_WRAPPER_PIN'};$owner=New-Module {param($bytes,$reader)$script:OwnedRelayStdin181=$reader;. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($bytes)));Export-ModuleMember -Function @()} -ArgumentList $raw,$script:OwnedRelayStdin181;$null=& $owner {InvokeCapturedRelayStdio181}";
 const bytes=Buffer.from(script,'utf16le');return Object.freeze({executable:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',arguments:Object.freeze(['-NoProfile','-NonInteractive','-EncodedCommand',bytes.toString('base64')]),encoded_bootstrap:bytes.toString('base64'),bootstrap_sha256:hash(bytes),stdin_prefix:wrapper.toString('base64')+'\n'+payload+'\n',wrapper_sha256:relayWrapperPin});
}
export function buildCapturedOwnedPair181({observer,relay}){
 // No process launch/UAC/ACL application here. The only production creator is
 // the accepted native SpawnPair factory inside the actual elevated parent.
 return Object.freeze({observer:buildCapturedBAObserverLaunch181(observer),relay:buildCapturedRelayLaunch181(relay)});
}
