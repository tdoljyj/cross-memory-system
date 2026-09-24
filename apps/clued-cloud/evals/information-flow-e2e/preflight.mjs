// Preflight facts for the S6 run: environment credential scan, runtime
// versions, code binding (commit, trees, migration chain digest) and a static
// provider-host scan of the dry-run Worker bundle (plan sections 7 and 8).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sha256 } from './evidence.mjs';
import { cloudRoot, FORBIDDEN_ENV } from './stack.mjs';

const require = createRequire(import.meta.url);
export const repoRoot = path.resolve(cloudRoot, '../..');
export const CONTRACT = 'development/contracts/information-flow/M0DCloseout.v0.1.md';

// Provider and production hosts that must never appear in egress or in the
// Worker bundle as a reachable default (E2E-09, B08).
export const PROVIDER_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com',
  'openai.azure.com', 'bedrock-runtime', 'api.mistral.ai', 'api.cohere.ai', 'api.cohere.com', 'api.supabase.com',
  'api.cloudflare.com'];
export const PRODUCTION_HOST = 'ccxsikzwxlolxqlosril.supabase.co';

export function environmentScan(env = process.env) {
  const forbidden = Object.keys(env).filter((name) => FORBIDDEN_ENV.some((pattern) => pattern.test(name))).sort();
  const remoteDatabaseUrls = Object.entries(env).filter(([name, value]) => /(DATABASE_URL|SUPABASE_DB_URL)$/.test(name)
    && value && !/@(127\.0\.0\.1|localhost)(:|\/)/.test(value)).map(([name]) => name);
  return {
    forbidden: [...forbidden, ...remoteDatabaseUrls],
    checked_patterns: FORBIDDEN_ENV.map(String).concat(['*DATABASE_URL non-loopback', '*SUPABASE_DB_URL non-loopback']),
    project_ref_linked: fs.existsSync(path.join(cloudRoot, 'supabase/.temp/project-ref')),
  };
}

export function runtimeVersions() {
  const version = (name) => require(path.join(cloudRoot, 'node_modules', name, 'package.json')).version;
  return { wrangler: version('wrangler'), miniflare: version('miniflare'), workerd: version('workerd'),
    js_tiktoken: version('js-tiktoken') };
}

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  .trim();
const tree = (commit, sub) => { try { return git('rev-parse', `${commit}:${sub}`); } catch { return null; } };

export function migrationsChain() {
  const dir = path.join(cloudRoot, 'supabase/migrations');
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const text = names.map((name) => `${name}  ${sha256(fs.readFileSync(path.join(dir, name)))}\n`).join('');
  return { count: names.length, latest: names.at(-1), sha256: sha256(text) };
}

export function codeBinding() {
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'apps/clued-cloud', 'development/contracts', 'scripts/information-flow')
    .split('\n').filter(Boolean).filter((line) => !line.includes('artifacts/'));
  const contractBytes = fs.readFileSync(path.join(repoRoot, CONTRACT));
  return {
    contract: { path: CONTRACT, sha256: sha256(contractBytes) },
    code: {
      input_commit: commit,
      code_tree: tree(commit, 'apps/clued-cloud'),
      harness_tree: tree(commit, 'apps/clued-cloud/evals/information-flow-e2e'),
      worker_tree: tree(commit, 'apps/clued-cloud/worker'),
      migrations_chain: migrationsChain(),
      worktree_clean: dirty.length === 0,
    },
    code_tree: tree(commit, 'apps/clued-cloud'),
  };
}

export function scanText(text) {
  return {
    provider_hosts: PROVIDER_HOSTS.filter((host) => text.includes(host)),
    production_host: text.includes(PRODUCTION_HOST),
  };
}

export function bundleScan(bundleDir) {
  const file = path.join(bundleDir, 'worker.js');
  const text = fs.readFileSync(file, 'utf8');
  const scanned = scanText(text);
  const gzip = require('node:zlib').gzipSync(text).length;
  // The production default URL is compiled in as a fallback for an unset
  // SUPABASE_URL; the harness binds SUPABASE_URL explicitly and the egress
  // ledger proves zero requests to it (B08 point 1).
  return { worker_js_sha256: sha256(text), raw_bytes: Buffer.byteLength(text), gzip_bytes: gzip, ...scanned,
    extractor_imported: /candidate-extractor|promptfoo/.test(text) };
}
