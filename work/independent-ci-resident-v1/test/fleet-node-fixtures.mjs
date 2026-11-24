// The universal node package's node side in CI, shared by fleet-node-children.test.mjs (rollout/fleet/test: prepare, the first install,
// publish, the tar reader, each in a child node) and fleet-node-powershell.test.mjs (the offline checks of the first-install PowerShell
// scripts). They were one file, fleet-node.test.mjs, split so the two halves run side by side (task 3435f8bf, block 2).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLEET_TESTS = path.join(RES, 'rollout', 'fleet', 'test');
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const windows = process.platform === 'win32';
export const skip = windows ? false : 'the node side of the universal package runs on the Windows host only';
export const tail = (s, n = 6000) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''));
// a child of `node --test` must not think it reports to this runner
// and carries the test marker itself (Fable ruling 11-20 "补：止血 PR 第四轮" §4)
export const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; e.CLUED_UNDER_TEST = '1'; return e; };
