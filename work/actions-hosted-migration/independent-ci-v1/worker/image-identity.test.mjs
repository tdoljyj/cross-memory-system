import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

// Exercise the candidate's actual inspection functions with Docker observations.
// No engine, container, network, credentials or production checkout is touched.
const source = await readFile(new URL('./linux-launcher.mjs', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function repositoryDigest('), source.indexOf('async function durableWrite('));
assert.ok(section.startsWith('function repositoryDigest('));
const { inspectEngineAndImage } = vm.runInNewContext(section + '\n({ inspectEngineAndImage });', {
  check: (ok, code) => { if (!ok) throw new Error(code); },
  parse: value => value,
});
const digest = 'sha256:' + 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
const repo = 'registry.example:5000/team/scanner';
const pin = `${repo}:v1@${digest}`;
const engine = { OSType: 'linux', DockerRootDir: '/var/lib/docker', OperatingSystem: 'Debian', SecurityOptions: ['name=seccomp'] };
const image = { Id: imageId, RepoDigests: [`${repo}@${digest}`], Os: 'linux', Config: { Env: ['PATH=/usr/bin'], Volumes: {} } };
async function inspect(reference, observed = image, info = engine) {
  const calls = [];
  const result = await inspectEngineAndImage({ image: reference, dockerRootDirectory: engine.DockerRootDir }, async args => {
    calls.push(args);
    return args[0] === 'info' ? info : [observed];
  });
  assert.equal(calls.length, 2);
  assert.deepEqual([...calls[1]], ['image', 'inspect', reference]);
  return result;
}
test('tag, untagged reference and registry port preserve exact identity', async () => {
  for (const reference of [pin, `${repo}@${digest}`]) assert.equal((await inspect(reference)).Id, imageId);
  assert.equal((await inspect(`scanner:v1@${digest}`, { ...image, RepoDigests: [`scanner@${digest}`] })).Id, imageId);
  assert.equal((await inspect(`registry.example/team/scanner:v1@${digest}`, { ...image, RepoDigests: [`registry.example/team/scanner@${digest}`] })).Id, imageId);
});
test('different registry, port, repository and digest are refused', async () => {
  for (const observed of [
    `other.example:5000/team/scanner@${digest}`,
    `registry.example:5001/team/scanner@${digest}`,
    `registry.example:5000/team/other@${digest}`,
    `${repo}@sha256:${'c'.repeat(64)}`,
  ]) await assert.rejects(inspect(pin, { ...image, RepoDigests: [observed] }), /LOCAL_IMAGE_PIN_UNKNOWN/);
});
test('exact config-image sha256 ID remains supported and differs from manifest digest', async () => {
  assert.equal((await inspect(imageId, { ...image, RepoDigests: null })).Id, imageId);
  await assert.rejects(inspect(digest), /LOCAL_IMAGE_PIN_UNKNOWN/);
  await assert.rejects(inspect(pin, { ...image, Id: digest, RepoDigests: [] }), /LOCAL_IMAGE_PIN_UNKNOWN/);
});
test('invalid pins and invalid observed digests fail closed', async () => {
  for (const reference of [null, undefined, 1, {}, '', `${repo}:v1`, `${repo}:@${digest}`, `${repo}@${digest}x`, `${repo}@@${digest}`, `https://${repo}@${digest}`, `${repo} @${digest}`, `${repo}@sha256:abc`, `${repo}@sha256:${'A'.repeat(64)}`, `../scanner@${digest}`, `${repo}:tag:extra@${digest}`, `${repo}@${digest}\n`]) {
    await assert.rejects(inspect(reference), /LOCAL_IMAGE_PIN_UNKNOWN/);
  }
  for (const reference of [`scanner:5000:tag@${digest}`, `registry.example:abc/scanner@${digest}`, `${repo}/@${digest}`, `${repo}//other@${digest}`]) await assert.rejects(inspect(reference), /LOCAL_IMAGE_PIN_UNKNOWN/);
  for (const values of [null, {}, `${repo}@${digest}`, [null], [1]]) await assert.rejects(inspect(pin, { ...image, RepoDigests: values }), /LOCAL_IMAGE_PIN_UNKNOWN/);
});
test('Linux platform, image ID, volume and environment guards stay enforced', async () => {
  for (const observed of [
    { ...image, Os: 'windows' }, { ...image, Id: 'sha256:bad' },
    { ...image, Config: { ...image.Config, Volumes: { '/data': {} } } },
  ]) await assert.rejects(inspect(pin, observed), /LOCAL_IMAGE_PIN_UNKNOWN/);
  await assert.rejects(inspect(pin, { ...image, Config: { Env: ['LD_PRELOAD=/unsafe'] } }), /IMAGE_ENV_NOT_QUALIFIED/);
});
test('native Linux engine, root directory and seccomp guards stay enforced', async () => {
  for (const info of [{ ...engine, OSType: 'windows' }, { ...engine, DockerRootDir: '/other' }, { ...engine, OperatingSystem: 'Docker Desktop' }, { ...engine, SecurityOptions: [] }]) {
    await assert.rejects(inspect(pin, image, info), /NATIVE_ENGINE_UNKNOWN/);
  }
});
