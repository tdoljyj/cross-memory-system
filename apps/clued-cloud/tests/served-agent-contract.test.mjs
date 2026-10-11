import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { contractVersionOf, verifyServedAgentContract }
  from '../scripts/verify-served-agent-contract.mjs';

const contract = (await readFile(new URL(
  '../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const productionWorkflow = await readFile(new URL(
  '../../../.github/workflows/clued-cloud-production-release.yml', import.meta.url), 'utf8');
const version = contractVersionOf(contract);
const served = `${contract}\n---\n\nKernel: 0.4.0\nMCP endpoint: https://clued.pixelgrav.com/mcp\n`;
const sha256 = createHash('sha256').update(contract).digest('hex');
const bootstrap = { lifecycle: { contract: { version,
  url: 'https://clued.pixelgrav.com/clued-agent.md' } }, agent_contract: { version, sha256 } };

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
  const drifted = { ...bootstrap, lifecycle: { contract: { ...bootstrap.lifecycle.contract, version: version + 1 } } };
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap: drifted }),
    ['bootstrap_contract_version_mismatch']);
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap: {} }),
    ['bootstrap_contract_version_mismatch', 'bootstrap_contract_url_invalid',
      'bootstrap_agent_contract_version_mismatch', 'bootstrap_agent_contract_sha256_mismatch']);
  assert.deepEqual(verifyServedAgentContract({ contract: '# none', served: '# none', bootstrap }),
    ['repository_contract_version_missing', 'bootstrap_contract_version_mismatch',
      'bootstrap_agent_contract_version_mismatch', 'bootstrap_agent_contract_sha256_mismatch']);
});

test('source hash is LF-normalized and absent, stale or mismatched delivery metadata blocks', () => {
  assert.deepEqual(verifyServedAgentContract({ contract: contract.replace(/\n/g, '\r\n'), served, bootstrap }), []);
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap: { ...bootstrap, agent_contract: undefined } }),
    ['bootstrap_agent_contract_version_mismatch', 'bootstrap_agent_contract_sha256_mismatch']);
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap: { ...bootstrap,
    agent_contract: { version: version + 1, sha256: '0'.repeat(64) } } }),
    ['bootstrap_agent_contract_version_mismatch', 'bootstrap_agent_contract_sha256_mismatch']);
});

test('the production release checks the served contract after deploy and keeps its evidence', () => {
  const deploy = productionWorkflow.indexOf('name: Deploy Clued production Worker');
  const check = productionWorkflow.indexOf('node scripts/verify-served-agent-contract.mjs');
  assert.ok(deploy > 0 && check > deploy);
  assert.match(productionWorkflow, /release-evidence\/served-agent-contract\.json\n/);
});
