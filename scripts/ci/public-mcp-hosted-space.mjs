import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// This suite uses Docker/Node/Postgres, not the image's preinstalled Android SDK.
// Never clean a persistent runner, Docker objects, caches, or workspace data.
export const SDK = '/usr/local/lib/android/sdk';
export const MIN_BYTES = 18n * 1024n ** 3n;
export const MIN_INODES = 250000n;
const capacity = (io, target) => {
  const s = io.statfsSync(target, {bigint: true});
  return {bytes: s.bavail * s.bsize, inodes: s.ffree};
};
const enough = s => s.bytes >= MIN_BYTES && s.inodes >= MIN_INODES;
const printable = s => ({free_bytes: String(s.bytes), free_inodes: String(s.inodes)});

export function prepareHostedSpace({env = process.env, platform = process.platform,
  io = fs, execute = execFileSync} = {}) {
  if (platform !== 'linux' || env.GITHUB_ACTIONS !== 'true' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux' ||
      !/^ubuntu\d+$/.test(env.ImageOS ?? '') || !env.ImageVersion)
    throw new Error('space preparation requires an ephemeral GitHub-hosted Ubuntu job');
  const dockerRoot = String(execute('docker', ['info', '--format', '{{.DockerRootDir}}'],
    {encoding: 'utf8', timeout: 30000})).trim();
  if (!dockerRoot.startsWith('/') || !io.existsSync(dockerRoot))
    throw new Error('Docker storage root unavailable');
  const before = capacity(io, dockerRoot);
  if (enough(before)) return {removed_sdk: false, before: printable(before), after: printable(before)};
  if (env.ANDROID_HOME !== SDK || env.ANDROID_SDK_ROOT !== SDK ||
      !io.existsSync(SDK) || io.lstatSync(SDK).isSymbolicLink() ||
      io.realpathSync(SDK) !== SDK)
    throw new Error('insufficient space; expected preinstalled SDK identity is missing');
  // Literal, canonical target only. --one-file-system preserves nested mounts.
  execute('sudo', ['--', 'rm', '--one-file-system', '-rf', '--', SDK],
    {stdio: 'inherit', timeout: 180000});
  const after = capacity(io, dockerRoot);
  const result = {removed_sdk: true, before: printable(before), after: printable(after)};
  if (!enough(after)) throw new Error('insufficient Docker capacity after SDK removal: ' + JSON.stringify(result));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]))
  console.log(JSON.stringify(prepareHostedSpace()));
