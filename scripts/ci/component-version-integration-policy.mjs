#!/usr/bin/env node
// config/clued-mechanical-files.json is the only list of generated files.
//   mechanical_paths: wholly generated outputs (claim conflicts ignore them).
//   marker_paths:     hand-written files whose generated lines only may change:
//                     declared component version markers and 40/64-hex digests.
// Native reads the same bytes, published by CI admission; nothing here deploys SQL.
import fs from 'node:fs';
import path from 'node:path';

export const POLICY = 'config/clued-mechanical-files.json';
const fail = message => { throw new Error(message); };
const LITERAL = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const badParts = p => p.split('/').some(part => part === '.' || part === '..' || part === '.git');

export function readMechanicalPolicy(root) {
  return parseMechanicalPolicy(fs.readFileSync(path.join(root, POLICY), 'utf8'));
}

export function parseMechanicalPolicy(text) {
  const policy = JSON.parse(text);
  const keys = policy && !Array.isArray(policy) ? Object.keys(policy).sort().join(',') : '';
  // marker_paths is optional so a policy from before it existed still parses.
  if (!['context_keys,mechanical_paths,repository,schema', 'context_keys,marker_paths,mechanical_paths,repository,schema'].includes(keys)
    || policy.schema !== 1 || typeof policy.repository !== 'string'
    || !/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(policy.repository)
    || !Array.isArray(policy.context_keys) || policy.context_keys.length === 0
    || new Set(policy.context_keys).size !== policy.context_keys.length
    || policy.context_keys.some(c => typeof c !== 'string' || !/^project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c))
    || !Array.isArray(policy.mechanical_paths) || policy.mechanical_paths.length === 0 || policy.mechanical_paths.length > 64
    || new Set(policy.mechanical_paths).size !== policy.mechanical_paths.length
    || policy.mechanical_paths.some(p => typeof p !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\/\*\*)?$/.test(p)
      || badParts(p))) fail('invalid scoped mechanical-file policy');
  const markers = policy.marker_paths ?? [];
  if (!Array.isArray(markers) || markers.length > 128 || new Set(markers).size !== markers.length
    || markers.some(p => typeof p !== 'string' || !LITERAL.test(p) || badParts(p) || isMechanicalPath(policy, p))) fail('invalid scoped mechanical-file policy');
  return policy;
}

export const isMechanicalPath = (policy, p) => policy.mechanical_paths.some(pattern => p === pattern
  || (pattern.endsWith('/**') && p.startsWith(pattern.slice(0, -2))));
export const isMarkerPath = (policy, p) => (policy.marker_paths ?? []).includes(p);

// The version-marker lines components declare for one file (config/clued-components.json).
export function markerPatterns(manifestText, file) {
  const manifest = JSON.parse(manifestText), result = [];
  for (const c of manifest?.components ?? []) {
    const m = c?.version_marker;
    if (!m || typeof m.file !== 'string' || typeof m.pattern !== 'string') continue;
    const root = c.root ?? '.';
    if ((root === '.' ? m.file : `${root}/${m.file}`) !== file) continue;
    const [head, tail, extra] = m.pattern.split('{version}');
    if (tail === undefined || extra !== undefined) fail('component marker must have one {version}');
    const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result.push({ re: new RegExp('^' + esc(head) + '[0-9][0-9.]*' + esc(tail) + '[ \\t]*$'), line: head + '<version>' + tail });
  }
  return result;
}

// True when two texts differ only in declared version-marker lines and digests.
// A version-bearing module's marker line, the same convention mechanicalFieldDiff uses.
const MODULE_VERSION = /^export const COMPONENT_VERSION[ \t]*=[ \t]*(['"])[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\1[ \t]*;[ \t]*$/;
export function markerOnlyDiff(before, after, patterns, file = '') {
  if (typeof before !== 'string' || typeof after !== 'string' || before.length > 2 ** 21 || after.length > 2 ** 21) return false;
  // The manifest's component entries are hand-written; only version/content_sha256 are generated.
  if (file === 'config/clued-components.json') return mechanicalFieldDiff(file, before, after);
  const mask = text => text.replace(/\r\n/g, '\n').split('\n').map(line => {
    for (const p of patterns) if (p.re.test(line)) return p.line;
    if (file.endsWith('.mjs') && MODULE_VERSION.test(line)) return '<component-version>';
    return line.replace(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g, '<digest>');
  }).join('\n');
  return mask(before) === mask(after);
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
  const declared = p => isMechanicalPath(policy, p) || isMarkerPath(policy, p);
  const paths = [...new Set(changedPaths)].filter(p => literal(p) && declared(p));
  let manifest = null;
  const manifestAtBase = () => (manifest ??= readFileAt('config/clued-components.json', baseSha));
  return (await Promise.all(paths.map(async file => {
    try {
      if (typeof readFileEntryAt !== 'function') return null;
      const [a, b] = await Promise.all([readFileEntryAt(file, baseSha), readFileEntryAt(file, headSha)]);
      if (!a || !b || a.type !== 'blob' || b.type !== 'blob' || !['100644', '100755'].includes(a.mode) || a.mode !== b.mode) return null;
    } catch { return null; }
    if (isMarkerPath(policy, file)) {
      try {
        const [before, after, text] = await Promise.all([readFileAt(file, baseSha), readFileAt(file, headSha), manifestAtBase()]);
        return markerOnlyDiff(before, after, text ? markerPatterns(text, file) : [], file) ? file : null;
      } catch { return null; }
    }
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
