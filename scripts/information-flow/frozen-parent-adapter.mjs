// Read-only adapter for the accepted, directory-independent M0 parent packages.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARENT_ROOTS = Object.freeze({
  'IF-MVP0-A': 'd238cc438301a93ba5cf922b59d53efbe177f22d1c4918ea92218942b423d12b',
  'IF-MVP0-B': 'de080cb8b82a0e8e126d70be202aca5c32c942894a5f01ea3c555b57061f81a3',
  'IF-MVP0-C': 'd46ae622dc19d2355a92af4b0eacdd15756a8eeeb775c0a6bff0e9c5537fb7c1',
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, reason) => { if (!condition) throw new Error(reason); };

export function bindFrozenParent(stage, directory) {
  check(Object.hasOwn(PARENT_ROOTS, stage), 'Unknown parent identity');
  check(typeof directory === 'string' && directory.length > 0, 'Parent directory required');
  const root = realpathSync(directory);
  check(lstatSync(root).isDirectory(), 'Parent is not a directory');
  const sealPath = join(root, 'SHA256SUMS');
  check(lstatSync(sealPath).isFile() && !lstatSync(sealPath).isSymbolicLink(), 'Unsafe seal');
  const seal = readFileSync(sealPath);
  check(sha(seal) === PARENT_ROOTS[stage], 'Frozen root mismatch');
  const files = new Map();
  for (const line of seal.toString('utf8').split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    check(match, 'Invalid frozen checksum line');
    const [, digest, relative] = match;
    check(!isAbsolute(relative) && !relative.includes('\\') && !relative.includes(':') &&
      relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe frozen path');
    check(!files.has(relative), 'Duplicate frozen path');
    files.set(relative, digest);
  }
  const actual = [];
  function visit(directory, prefix = '') {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix + item.name;
      const path = join(directory, item.name);
      check(!lstatSync(path).isSymbolicLink(), 'Frozen tree contains a link');
      check(realpathSync(path).startsWith(root + sep), 'Frozen path escaped root');
      if (item.isDirectory()) visit(path, rel + '/');
      else {
        check(item.isFile(), 'Unsupported frozen entry');
        if (rel === 'SHA256SUMS') continue;
        check(files.has(rel), 'Undeclared frozen file: ' + rel);
        check(sha(readFileSync(path)) === files.get(rel), 'Frozen file mismatch: ' + rel);
        actual.push(rel);
      }
    }
  }
  visit(root);
  check(actual.length === files.size, 'Missing frozen files');
  return { stage, delivery_root_sha256: PARENT_ROOTS[stage], verified_files: actual.length };
}

export function bindFrozenParents(directories) {
  const parents = Object.keys(PARENT_ROOTS).map(stage => bindFrozenParent(stage, directories[stage]));
  return {
    adapter: 'clued.information-flow.frozen-parent-adapter/1',
    status: 'PASS_SOURCE_BINDING_ONLY', parents,
    original_bytes_modified: false,
    canonical_write: false,
    runtime_or_model_acceptance: false,
    scope: 'Original parent identity retained across repository layout changes; no schema migration or Entry qualification is implied.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = bindFrozenParents({
      'IF-MVP0-A': process.env.M0A_ROOT,
      'IF-MVP0-B': process.env.M0B_ROOT,
      'IF-MVP0-C': process.env.M0C_ROOT,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'FAIL_SOURCE_BINDING', reason: error.message }) + '\n');
    process.exitCode = 1;
  }
}
