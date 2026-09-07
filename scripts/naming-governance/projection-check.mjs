import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// Adapter only: the existing Step 7 renderer remains the sole projection implementation.
try {
  const [generator, bindingPath, sourceRoot, outputRoot] = process.argv.slice(2);
  const {buildModel, renderOutputs, compareOutputs} = await import(pathToFileURL(generator));
  const bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
  const model = buildModel(bindings, sourceRoot);
  const outputs = renderOutputs(model, readFileSync(resolve(sourceRoot, model.sources['historical-status'].path)));
  const mismatches = compareOutputs(outputs, outputRoot);
  const upstream_mismatches = model.lineage_checks.filter(row => row.status !== 'MATCH');
  process.stdout.write(JSON.stringify({mismatches, upstream_mismatches, expected_facts:model.facts,
    outputs_checked:Object.keys(outputs), formal_step7_gate:false})+'\n');
  process.exitCode = mismatches.length || upstream_mismatches.length ? 1 : 0;
} catch (error) {
  process.stdout.write(JSON.stringify({error:error.message})+'\n');
  process.exitCode = 1;
}
