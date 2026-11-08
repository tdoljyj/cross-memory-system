// Offline/maintenance entry. No elevation, service changes, ACL changes or automatic authorization.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { check } from '../src/canonical.mjs';
import { SETTINGS_FILE, readRetentionSettings } from '../src/retention-settings.mjs';
import { pruneArchivedGenerations } from '../src/generation-retention.mjs';
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' }, apply: { type: 'boolean' } } });
  check(typeof values.root === 'string' && path.isAbsolute(values.root), 'RETENTION_ROOT_REQUIRED');
  const file = path.join(values.root, 'owner', SETTINGS_FILE), initial = await readRetentionSettings(file);
  if (!initial.ok) return { code: initial.code, candidates: [], deleted: [] };
  return pruneArchivedGenerations({ root: values.root, settings: initial.settings, allowDelete: values.apply === true,
    authorizeDelete: async () => {
      const current = await readRetentionSettings(file);
      return current.ok && JSON.stringify(current.settings) === JSON.stringify(initial.settings);
    } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(r => { console.log(JSON.stringify(r)); if (process.argv.includes('--apply') && r.code) process.exitCode = 1; },
    () => { console.error('RETENTION_GENERATIONS_UNCONFIRMED'); process.exitCode = 1; });
}
