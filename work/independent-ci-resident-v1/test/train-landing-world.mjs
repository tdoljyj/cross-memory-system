// The world of train-landing-e2e (work/actions-hosted-migration/independent-ci-v1/test/train-landing-e2e.test.mjs), for tests of this
// directory. That file keeps its fixture private (world, residentOver, stage 8 and 10 over the offline GitHub and Native): this module
// loads its text, registers none of its tests, and hands the fixture's own functions out. Nothing is copied: a change of the fixture
// there is the fixture here. A name it no longer defines fails the import (and every test that uses it), never silently.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const E2E = fileURLToPath(new URL('../../actions-hosted-migration/independent-ci-v1/test/train-landing-e2e.test.mjs', import.meta.url));
const NAMES = ['world', 'residentOver', 'flakyRules', 'rowsOf', 'diagOf', 'restampedOf', 'terminalCodes', 'pollerRun', 'REPO', 'NOW', 'iso'];
const TEST_IMPORT = "import test from 'node:test';";

let loaded = null;
export function trainLandingWorld() {
  loaded ??= (async () => {
    const text = await fs.readFile(E2E, 'utf8');
    if (!text.includes(TEST_IMPORT)) throw new Error('train-landing-e2e no longer imports node:test as this loader expects');
    const base = pathToFileURL(E2E);
    const body = text.replace(TEST_IMPORT, 'const test = () => {};')
      .replace(/(\bfrom\s+')(\.{1,2}\/[^']+)(')/g, (_, a, spec, c) => `${a}${new URL(spec, base).href}${c}`)
      .replaceAll('import.meta.url', JSON.stringify(base.href)); // the files it reads beside itself are found from where it lives
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-train-world-'));
    const file = path.join(dir, 'train-landing-world.generated.mjs');
    try {
      await fs.writeFile(file, `${body}\nexport { ${NAMES.join(', ')} };\n`);
      return { ...(await import(pathToFileURL(file).href)) };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  })();
  return loaded;
}
