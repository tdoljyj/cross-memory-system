import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { contractVersionOf, verifyServedAgentContract }
  from '../scripts/verify-served-agent-contract.mjs';

const contract = await readFile(new URL(
  '../../../skills/clued/references/agent-contract.md', import.meta.url), 'utf8');
const productionWorkflow = await readFile(new URL(
  '../../../.github/workflows/clued-cloud-production-release.yml', import.meta.url), 'utf8');
const version = contractVersionOf(contract);
const served = `${contract}\n---\n\nKernel: 0.4.0\nMCP endpoint: https://clued.pixelgrav.com/mcp\n`;
const bootstrap = { lifecycle: { contract: { version,
  url: 'https://clued.pixelgrav.com/clued-agent.md' } } };

test('the repository contract declares an integer version', () => {
  assert.equal(Number.isInteger(version), true);
  assert.equal(contractVersionOf('# no version here'), null);
});

test('served contract passes when it starts with the repository text and bootstrap agrees', () => {
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap }), []);
});

test('a stale or edited served contract, or a drifted bootstrap version, blocks', () => {
  const stale = served.replace(`Contract version: ${version}`, `Contract version: ${version - 1}`);
  assert.deepEqual(verifyServedAgentContract({ contract, served: stale, bootstrap }),
    ['served_agent_contract_differs_from_repository']);
  assert.deepEqual(verifyServedAgentContract({ contract, served: undefined, bootstrap }),
    ['served_agent_contract_differs_from_repository']);
  const drifted = { lifecycle: { contract: { ...bootstrap.lifecycle.contract, version: version + 1 } } };
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap: drifted }),
    ['bootstrap_contract_version_mismatch']);
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap: {} }),
    ['bootstrap_contract_version_mismatch', 'bootstrap_contract_url_invalid']);
  assert.deepEqual(verifyServedAgentContract({ contract: '# none', served: '# none', bootstrap }),
    ['repository_contract_version_missing', 'bootstrap_contract_version_mismatch']);
});

test('the production release checks the served contract after deploy and keeps its evidence', () => {
  const deploy = productionWorkflow.indexOf('name: Deploy Clued production Worker');
  const check = productionWorkflow.indexOf('node scripts/verify-served-agent-contract.mjs');
  assert.ok(deploy > 0 && check > deploy);
  assert.match(productionWorkflow, /release-evidence\/served-agent-contract\.json\n/);
});
