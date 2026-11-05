import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function buildRelease(source, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('source_commit_missing');
  const revision = /\bREV='([^']+)'/.exec(source)?.[1];
  if (!revision) throw new Error('connect_revision_missing');
  // No bundler or dependency code: the deployed module is this exact source plus its commit marker.
  const artifact = `const KOOYUMI_RELEASE_COMMIT=${JSON.stringify(commit)};\n${source}`;
  return { artifact, manifest: { contract: 'kooyumi.connect-release-build/1', source_commit: commit,
    revision, source_sha256: sha256(source), artifact_sha256: sha256(artifact) } };
}

async function main() {
  const args = process.argv.slice(2), outIndex = args.indexOf('--out-dir'), evidenceIndex = args.indexOf('--evidence-out');
  const out = args[outIndex + 1], evidence = args[evidenceIndex + 1];
  if (outIndex < 0 || !out || evidenceIndex < 0 || !evidence) throw new Error('build_output_paths_required');
  const source = await readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
  const { artifact, manifest } = buildRelease(source, process.env.GITHUB_SHA);
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'worker.mjs'), artifact, { flag: 'wx' });
  await writeFile(evidence, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(manifest) + '\n');
}
if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
