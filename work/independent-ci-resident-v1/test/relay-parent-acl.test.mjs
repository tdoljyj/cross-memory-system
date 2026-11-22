// The CI root's and formal-spool's ACL steps on real NTFS, in CI: windows/test-companion-relay-parent-acl.ps1 (the first install's two
// steps, parent-acl then companion-relay-parent-acl, on folders made as first-install-host.ps1 makes them; the DACL is compared by shape)
// and windows/test-verify-relay-parents-ensure.ps1 (verify-resident.ps1's ensure with install-resident.ps1's own rule). Until r8 no suite
// ran either of them (Fable ruling 0e418483 section 2): they run here, in resident-node, as test/fleet-node.test.mjs runs the first-install
// scripts. Windows PowerShell 5.1 only, not elevated, a new scratch under the temporary directory; on Linux this file is skipped by name.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows = process.platform === 'win32';
const skip = windows ? false : 'the NTFS ACL steps run on the Windows host only';
const tail = (s, n = 6000) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''));
// a child of `node --test` must not think it reports to this runner, and carries the test marker itself (as test/fleet-node.test.mjs)
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; e.CLUED_UNDER_TEST = '1'; return e; };

// The ensure script refuses an elevated administrator (NON_ELEVATED_TEST_REQUIRED, its line 8): it tests the ACL a standard
// user gets, so its name says so and a host that cannot give it (CLUED_CI_HOST_LACKS) does not run it (task 04f9b91b).
for (const [file, status, needs = ''] of [['test-companion-relay-parent-acl.ps1', 'COMPANION_RELAY_PARENT_TEMP_PASS'],
  ['test-verify-relay-parents-ensure.ps1', 'VERIFY_RELAY_PARENTS_ENSURE_TEMP_PASS', ' [needs:non-elevated]']]) {
  test(`windows/${file}: passes on real NTFS in a new temporary scratch${needs}`, { skip, timeout: 900_000 }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-relay-parent-'));
    t.after(() => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* the scratch is the temporary directory's */ } });
    const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(RES, 'windows', file), '-Scratch', path.join(parent, 'scratch')],
      { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: 850_000 });
    assert.ifError(r.error);
    const out = `${tail(r.stdout)}\n${tail(r.stderr, 3000)}`;
    assert.equal(r.status, 0, out);
    const last = String(r.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
    let verdict = null;
    try { verdict = JSON.parse(last); } catch { verdict = null; }
    assert.equal(verdict?.status, status, out);
    assert.ok(Number.isInteger(verdict?.assertions) && verdict.assertions > 0, out);
    t.diagnostic(last);
  });
}
