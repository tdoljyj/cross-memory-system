// Source v2 controller read lease (port of protected-job-bridge-v3/held-source.mjs): one fixed PS5
// process (hold-record.ps1) holds the checked handles of the install record and of every accepted Source
// file for the whole entry run. Public data only; no caller can inject a child, reader or lease.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RECORD_FILES, STATE_V2 } from './layout.mjs';

const leases = new WeakSet();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (v, c) => { if (!v) fail(c); };
const MAX = 16 * 1024 * 1024, SID = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/;
const hash = b => createHash('sha256').update(b).digest('hex');
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function bytes(v) { check(typeof v === 'string' && v.length <= 5592408, 'HELD_RECORD_DOCUMENT_BOUND'); const b = Buffer.from(v, 'base64'); check(b.toString('base64') === v && b.length <= 4194304, 'HELD_RECORD_DOCUMENT_BOUND'); return b; }

export function decodeHeldRecord(raw, now = Date.now()) {
  check(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX, 'HELD_RECORD_OUTPUT_BOUND');
  let v; try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail('HELD_RECORD_JSON_REFUSED'); }
  check(exact(v, ['contract', 'controllerSid', 'sourceRoot', 'expiresAt', 'documents', 'sourceHashes', 'policyBase64']) && v.contract === 'clued.independent-ci.held-record-bytes/1'
    && SID.test(v.controllerSid ?? '') && /^C:\\ProgramData\\CluedIndependentCI\\resident\\source\\[0-9a-f]{64}$/.test(v.sourceRoot) && Date.parse(v.expiresAt) > now, 'HELD_RECORD_REFUSED');
  check(exact(v.documents, RECORD_FILES), 'HELD_RECORD_DOCUMENTS_REFUSED');
  const documents = Object.fromEntries(Object.entries(v.documents).map(([k, x]) => [k, bytes(x)]));
  // The lease process ran as the controller of the record's own node profile (acceptance `node`, design §9 C1);
  // the whole record, profile included, is validated by every reader (record.mjs#validateRecordV2).
  let accepted = null; try { accepted = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(documents['acceptance.json'])); } catch { fail('HELD_RECORD_REFUSED'); }
  check(accepted?.node?.controllerSid === v.controllerSid, 'HELD_RECORD_CONTROLLER_REFUSED');
  check(v.sourceHashes && Object.getPrototypeOf(v.sourceHashes) === Object.prototype && Object.keys(v.sourceHashes).length > 0 && Object.keys(v.sourceHashes).length <= 10000, 'HELD_RECORD_PINS_REFUSED');
  for (const [p, s] of Object.entries(v.sourceHashes)) check(typeof p === 'string' && !p.startsWith('/') && !/[\\:\x00-\x1f]/.test(p) && p.split('/').every(x => x && x !== '.' && x !== '..') && /^[a-f0-9]{64}$/.test(s), 'HELD_RECORD_PINS_REFUSED');
  const policy = bytes(v.policyBase64);
  check(v.sourceHashes['config/merge-admission-policy.json'] === hash(policy), 'HELD_POLICY_BYTES_CHANGED');
  return { documents, sourceHashes: new Map(Object.entries(v.sourceHashes)), policyText: new TextDecoder('utf-8', { fatal: true }).decode(policy), expiresAt: v.expiresAt, sourceRoot: v.sourceRoot };
}

export async function openHeldRecord() {
  check(process.platform === 'win32', 'ACTUAL_WINDOWS_HELD_RECORD_REQUIRED');
  const helper = fileURLToPath(new URL('./hold-record.ps1', import.meta.url));
  const temp = STATE_V2.temp;
  const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper],
    { windowsHide: true, shell: false, env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
  let invalid = false, closing = false, settled = false; const parts = []; let count = 0;
  return new Promise((resolve, reject) => {
    const bad = () => { invalid = true; if (!settled) { settled = true; clearTimeout(timer); child.stdin.end(); reject(Object.assign(new Error('HELD_RECORD_PROCESS_UNCONFIRMED'), { code: 'HELD_RECORD_PROCESS_UNCONFIRMED' })); } };
    const timer = setTimeout(bad, 30000);
    child.once('error', bad); child.once('exit', () => { if (!closing) bad(); }); child.stderr.on('data', bad); child.stdin.on('error', bad);
    child.stdout.on('data', b => {
      if (settled) { bad(); return; }
      count += b.length; if (count > MAX) { bad(); return; } parts.push(b);
      const all = Buffer.concat(parts); if (!all.includes(10)) return;
      try {
        const end = all.indexOf(10); check(end === all.length - 1 || (end === all.length - 2 && all[all.length - 1] === 10), 'HELD_RECORD_EXTRA_OUTPUT_REFUSED');
        const data = decodeHeldRecord(all.subarray(0, end).toString().endsWith('\r') ? all.subarray(0, end - 1) : all.subarray(0, end)); settled = true; clearTimeout(timer);
        const lease = Object.freeze({
          get data() { check(!invalid && !closing && child.exitCode === null && Date.now() < Date.parse(data.expiresAt), 'HELD_RECORD_LEASE_LOST'); return data; },
          assertLive() { check(!invalid && !closing && child.exitCode === null && Date.now() < Date.parse(data.expiresAt), 'HELD_RECORD_LEASE_LOST'); },
          async close() { if (closing) return; closing = true; child.stdin.end('RELEASE\n'); await new Promise(r => { if (child.exitCode !== null) { r(); return; } child.once('exit', r); }); },
        });
        leases.add(lease); resolve(lease);
      } catch { bad(); }
    });
  });
}
export function takeHeldRecord(lease) { check(leases.has(lease), 'ACTUAL_HELD_RECORD_LEASE_REQUIRED'); lease.assertLive(); return lease; }
// The Source root this entry runs from must be the held one (code only from source\<sha>, S12).
// The Source root of a module of this Source: the directory that holds work/actions-hosted-migration/independent-ci-v1/.
// Entries sit at different depths (runtime/one-shot-v2.mjs is one level shallower than src/<dir>/<entry>.mjs), so
// a fixed number of '..' put the check-publisher's root one level too high: every publication stage refused
// itself with ENTRY_OUTSIDE_HELD_SOURCE_REFUSED (PR #889 stage 3, 2026-10-21). No trailing separator.
const CI_DIR = ['work', 'actions-hosted-migration', 'independent-ci-v1'];
export function sourceRootOfModule(moduleUrl) {
  const file = path.resolve(fileURLToPath(moduleUrl));
  const marker = path.sep + CI_DIR.join(path.sep) + path.sep;
  const at = file.toLowerCase().lastIndexOf(marker.toLowerCase());
  check(at > 0, 'ENTRY_OUTSIDE_HELD_SOURCE_REFUSED');
  return file.slice(0, at);
}
export function assertOwnSourceRoot(lease, moduleUrl) {
  const own = sourceRootOfModule(moduleUrl);
  check(own.toLowerCase() === takeHeldRecord(lease).data.sourceRoot.toLowerCase(), 'ENTRY_OUTSIDE_HELD_SOURCE_REFUSED');
}
