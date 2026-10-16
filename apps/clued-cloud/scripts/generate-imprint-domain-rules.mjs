import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'app/imprints/imprint-suggestions.ts');
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports, require: name => { throw Error('Unexpected dependency: ' + name); } });
// PostgreSQL ARE uses \y for the JavaScript word-boundary assertion.
const pg = regex => regex.replaceAll('\\b', '\\y');
const rules = exports.IMPRINT_DOMAIN_RULESET;
const catalog = JSON.stringify({ ...rules, purposes: rules.purposes.map(pg),
  domains: rules.domains.map(rule => ({ ...rule, patterns: rule.patterns.map(pg) })),
  activities: rules.activities.map(rule => ({ ...rule, patterns: rule.patterns.map(pg) })),
  activity_context_block: pg(rules.activity_context_block),
  uncertain: rules.uncertain.map(pg), reported: rules.reported.map(pg) });
if (catalog.includes('$imprint_rules$')) throw Error('Unsafe SQL delimiter');
const block = `-- BEGIN GENERATED IMPRINT PURPOSE RULES\ncreate function clued_private.imprint_auto_rules_v1()\nreturns jsonb language sql immutable parallel safe set search_path='' as $rules$\n  select $imprint_rules$${catalog}$imprint_rules$::jsonb\n$rules$;\n-- END GENERATED IMPRINT PURPOSE RULES`;
const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(name => name.endsWith('_imprint_auto_domains_v1.sql'));
if (files.length !== 1) throw Error('Expected one automatic-domain migration');
const target = path.join(root, 'supabase/migrations', files[0]);
const original = fs.readFileSync(target, 'utf8');
const generated = original.replace(/-- BEGIN GENERATED IMPRINT PURPOSE RULES[\s\S]*?-- END GENERATED IMPRINT PURPOSE RULES/u, block);
if (generated === original && !original.includes(block)) throw Error('Generation markers missing');
if (process.argv.includes('--check')) {
  if (generated !== original) throw Error('Imprint purpose SQL is stale; run the generator');
} else fs.writeFileSync(target, generated);
