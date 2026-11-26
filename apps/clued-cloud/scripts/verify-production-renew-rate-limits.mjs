import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const configFile = new URL('../wrangler.production.jsonc', import.meta.url);
const required = ['CI_RENEW_SOURCE_LIMIT', 'CI_RENEW_IDENTITY_LIMIT'];

export function verifyProductionRenewRateLimits(text) {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.production.jsonc', text);
  if (error) throw new Error('production_release_blocked:wrangler_config_invalid');
  const ratelimits = Array.isArray(config?.ratelimits) ? config.ratelimits : [];
  const missing = required.filter(name => !ratelimits.some(binding => binding?.name === name));
  if (missing.length) {
    throw new Error(`production_release_blocked:renew_rate_limit_binding_missing:${missing.join(',')}`);
  }
  return config;
}

if (import.meta.main) {
  verifyProductionRenewRateLimits(await readFile(configFile, 'utf8'));
}
