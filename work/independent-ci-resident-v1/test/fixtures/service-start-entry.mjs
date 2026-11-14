// Test entry (test/resident-start-lock.test.mjs): the service entry exactly as src/service-main.mjs runs it, except that what
// Windows says about a pid is read from the file named by --processes (pid -> { name, executablePath, commandLine, creationMs },
// 'unreadable', or absent for a pid that is gone), so the start can be exercised on a host without Win32_Process.
import fs from 'node:fs/promises';
import { run } from '../../src/service-main.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--processes');
const file = argv[at + 1];
argv.splice(at, 2);
const readProcess = async pid => {
  const seen = JSON.parse(await fs.readFile(file, 'utf8'))[pid];
  return seen === 'unreadable' ? null : seen ?? { name: null, executablePath: null, commandLine: null, creationMs: null };
};
process.exit(await run(argv, { readProcess }));
