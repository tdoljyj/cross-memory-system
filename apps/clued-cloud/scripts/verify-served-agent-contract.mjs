// Run after the exact source commit has been deployed and attested. Checks that
// production serves the repository's Agent contract at /clued-agent.md and
// that the bootstrap names the same contract version, so a release proves the
// contract is live without a manual readback.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const PRODUCTION_ORIGIN = 'https://kooyumi.pixelgrav.com';
const contractSource = new URL('../../../protocol/agent/agent-contract.md', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function contractVersionOf(markdown) {
  const match = /^Contract version: (\d+)$/m.exec(markdown ?? '');
  return match ? Number(match[1]) : null;
}

export function verifyServedAgentContract({ contract, served, bootstrap }) {
  const errors = [];
  contract = typeof contract === 'string' ? contract.replace(/\r\n/g, '\n') : contract;
  const version = contractVersionOf(contract);
  if (version === null) errors.push('repository_contract_version_missing');
  if (typeof served !== 'string' || !served.startsWith(contract)) {
    errors.push('served_agent_contract_differs_from_repository');
  }
  const live = bootstrap?.lifecycle?.contract;
  if (live?.version !== version) errors.push('bootstrap_contract_version_mismatch');
  if (typeof live?.url !== 'string' || !live.url.endsWith('/clued-agent.md')) {
    errors.push('bootstrap_contract_url_invalid');
  }
  if (bootstrap?.agent_contract?.version !== version) errors.push('bootstrap_agent_contract_version_mismatch');
  if (typeof contract !== 'string' || bootstrap?.agent_contract?.sha256 !== sha256(contract)) {
    errors.push('bootstrap_agent_contract_sha256_mismatch');
  }
  return errors;
}

async function fetchLive(url, accept) {
  const response = await fetch(url, {
    method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(10_000), headers: { accept },
  });
  if (response.status !== 200) throw new Error(`served_agent_contract_http_${response.status}`);
  return response;
}

async function main() {
  const commit = process.env.GITHUB_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('source_commit_missing');
  const contract = (await readFile(contractSource, 'utf8')).replace(/\r\n/g, '\n');
  // The query only bypasses caches between the runner and the Worker; the
  // Worker routes on the path alone.
  const served = await (await fetchLive(
    `${PRODUCTION_ORIGIN}/clued-agent.md?release=${commit}`, 'text/markdown')).text();
  const bootstrap = await (await fetchLive(
    `${PRODUCTION_ORIGIN}/v1/continuity/bootstrap?release=${commit}`, 'application/json')).json();
  const errors = verifyServedAgentContract({ contract, served, bootstrap });
  if (errors.length) throw new Error(`served_agent_contract_blocked:${errors.join(',')}`);
  const result = {
    status: 'passed', source_commit: commit,
    contract_version: contractVersionOf(contract),
    repository_contract_sha256: sha256(contract),
    served_sha256: sha256(served),
    checked_at: new Date().toISOString(),
  };
  const evidenceIndex = process.argv.indexOf('--evidence-out');
  if (evidenceIndex >= 0) {
    const path = process.argv[evidenceIndex + 1];
    if (!path) throw new Error('evidence_path_required');
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'served_agent_contract_unexpected_error'}\n`);
    process.exitCode = 1;
  });
}
