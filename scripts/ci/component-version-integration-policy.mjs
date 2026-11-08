#!/usr/bin/env node
// The committed JSON is the source; this check binds Native's installed policy
// literal to it. It never deploys SQL or turns a candidate policy into authority.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const POLICY = 'config/clued-mechanical-files.json';
const BEGIN = '-- BEGIN GENERATED MECHANICAL POLICY';
const END = '-- END GENERATED MECHANICAL POLICY';
const fail = message => { throw new Error(message); };

export function readMechanicalPolicy(root) {
  return parseMechanicalPolicy(fs.readFileSync(path.join(root, POLICY), 'utf8'));
}

export function parseMechanicalPolicy(text) {
  const policy = JSON.parse(text);
  if (!policy || Array.isArray(policy) || Object.keys(policy).sort().join(',') !== 'context_keys,mechanical_paths,repository,schema'
    || policy.schema !== 1 || typeof policy.repository !== 'string'
    || !/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(policy.repository)
    || !Array.isArray(policy.context_keys) || policy.context_keys.length === 0
    || new Set(policy.context_keys).size !== policy.context_keys.length
    || policy.context_keys.some(c => typeof c !== 'string' || !/^project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c))
    || !Array.isArray(policy.mechanical_paths) || policy.mechanical_paths.length === 0 || policy.mechanical_paths.length > 64
    || new Set(policy.mechanical_paths).size !== policy.mechanical_paths.length
    || policy.mechanical_paths.some(p => typeof p !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\/\*\*)?$/.test(p)
      || p.split('/').some(part => part === '.' || part === '..' || part === '.git'))) fail('invalid scoped mechanical-file policy');
  return policy;
}

const sameJson = (a, b) => {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

export function mechanicalFieldDiff(file, before, after) {
  if (typeof before !== 'string' || typeof after !== 'string' || before.length > 2 ** 21 || after.length > 2 ** 21) return false;
  if (file === 'config/clued-components.json') {
    try {
      const normalize = text => {
        const p = JSON.parse(text);
        if (!p || !Array.isArray(p.components) || new Set(p.components.map(c => c.id)).size !== p.components.length) fail('invalid components');
        return { ...p, components: p.components.map(c => Object.fromEntries(Object.entries(c).filter(([k]) => !['version', 'content_sha256'].includes(k)))) };
      };
      return sameJson(normalize(before), normalize(after));
    } catch { return false; }
  }
  if (file.endsWith('.mjs')) {
    const marker = /^export const COMPONENT_VERSION[ \t]*=[ \t]*(['"])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\1[ \t]*;[ \t]*$/gm;
    const normalize = text => {
      const matches = [...text.matchAll(marker)];
      if (matches.length !== 1) return null;
      const m = matches[0], index = m.index + m[0].indexOf(m[2]);
      return text.slice(0, index) + '<component-version>' + text.slice(index + m[2].length);
    };
    const a = normalize(before), b = normalize(after);
    return a !== null && b !== null && a === b;
  }
  return false;
}

// Called only by accepted CI source, using a policy read from the trusted base.
// Native separately authenticates this proof's CI Binding and exact PR/head/base.
export async function computeMechanicalPathsProven({ policy, changedPaths, baseSha, headSha, readFileAt, readFileEntryAt }) {
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? '') || !/^[0-9a-f]{40}$/.test(headSha ?? '') || !Array.isArray(changedPaths)) return [];
  const literal = p => typeof p === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(p) && !p.split('/').some(s => s === '.' || s === '..');
  const declared = p => policy.mechanical_paths.some(pattern => p === pattern || (pattern.endsWith('/**') && p.startsWith(pattern.slice(0, -2))));
  const paths = [...new Set(changedPaths)].filter(p => literal(p) && declared(p));
  return (await Promise.all(paths.map(async file => {
    try {
      if (typeof readFileEntryAt !== 'function') return null;
      const [a, b] = await Promise.all([readFileEntryAt(file, baseSha), readFileEntryAt(file, headSha)]);
      if (!a || !b || a.type !== 'blob' || b.type !== 'blob' || !['100644', '100755'].includes(a.mode) || a.mode !== b.mode) return null;
    } catch { return null; }
    if (file === 'config/clued-components.json' || file.endsWith('.mjs')) {
      try {
        const [before, after] = await Promise.all([readFileAt(file, baseSha), readFileAt(file, headSha)]);
        return mechanicalFieldDiff(file, before, after) ? file : null;
      } catch { return null; }
    }
    // Entirely generated modules and the generated reconciliation registry are
    // still required to pass their deterministic pinned-registry generators.
    return file;
  }))).filter(Boolean).sort();
}

function projection(root) {
  const policy = readMechanicalPolicy(root);
  const dir = path.join(root, 'apps/clued-cloud/supabase/migrations');
  const names = fs.readdirSync(dir).filter(n => /^\d+_work_claim_mechanical_files_v\d+\.sql$/.test(n)).sort();
  if (!names.length) fail('mechanical-file Native migration is missing');
  const file = path.join(dir, names.at(-1));
  const sql = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (sql.split(BEGIN).length !== 2 || sql.split(END).length !== 2) fail('mechanical-policy markers must occur exactly once');
  const start = sql.indexOf(BEGIN) + BEGIN.length, end = sql.indexOf(END);
  if (end <= start) fail('mechanical-policy marker order is invalid');
  const expected = `\n  select $mechanical_policy$${JSON.stringify(policy, null, 2)}$mechanical_policy$::jsonb\n`;
  return { file, sql, start, end, expected, changed: sql.slice(start, end) !== expected };
}

export function checkMechanicalPolicy(root) {
  const fix = 'node scripts/ci/component-version-integration-policy.mjs --write';
  try {
    const p = projection(root);
    return { id: 'mechanical-policy', status: p.changed ? 'stale' : 'ok', registry: POLICY,
      ...(p.changed ? { details: ['Native policy literal differs from the single manifest'] } : {}), fix };
  } catch (error) {
    return { id: 'mechanical-policy', status: 'stale', registry: POLICY, details: [error.message], fix };
  }
}

export function writeMechanicalPolicy(root) {
  const p = projection(root);
  if (p.changed) fs.writeFileSync(p.file, p.sql.slice(0, p.start) + p.expected + p.sql.slice(p.end));
  return { changed: p.changed, file: path.relative(root, p.file).split(path.sep).join('/') };
}

if (import.meta.main) {
  try {
    let root = ROOT, write = false;
    for (let i = 2; i < process.argv.length; i += 1) {
      if (process.argv[i] === '--root' && process.argv[i + 1]) root = path.resolve(process.argv[++i]);
      else if (process.argv[i] === '--write') write = true;
      else fail(`unknown argument ${process.argv[i]}`);
    }
    if (write) console.log(JSON.stringify(writeMechanicalPolicy(root)));
    else { const result = checkMechanicalPolicy(root); console.log(JSON.stringify(result)); process.exitCode = result.status === 'ok' ? 0 : 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
