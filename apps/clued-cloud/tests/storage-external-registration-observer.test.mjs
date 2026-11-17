import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleDriveExternalRegistrationObserver } from '../../../kernel/host/resource-center-google-drive-external-registration.mjs';
import { googleDriveSharingDigest } from '../../../kernel/host/resource-center-google-drive-sharing.mjs';

const folder = 'application/vnd.google-apps.folder';
function fixture() {
  const make = (id, name, parent, mimeType = folder) => ({ id, name, parents: [parent], mimeType, version: '1', trashed: false,
    ownedByMe: true, shared: false, permissionIds: ['owner'], permissions: [{ id: 'owner', type: 'user', role: 'owner' }],
    capabilities: { canListChildren: true }, ...(mimeType === folder ? {} : { size: '5', headRevisionId: 'revision1', md5Checksum: 'a'.repeat(32) }) });
  const files = new Map([
    make('root', '资料中心', 'drive'), make('track', '20_产品', 'root'), make('focus', '20_探索产出', 'track'),
    make('nested', '候选', 'focus'), make('file', 'logo.txt', 'nested', 'text/plain'), make('other', '其他', 'track')
  ].map(f => [f.id, f]));
  const paths = { root: 'G:/资料中心', track: 'G:/资料中心/20_产品', focus: 'G:/资料中心/20_产品/20_探索产出',
    nested: 'G:/资料中心/20_产品/20_探索产出/候选', file: 'G:/资料中心/20_产品/20_探索产出/候选/logo.txt', other: 'G:/资料中心/20_产品/其他' };
  const plan = { contract: 'clued.storage-external-registration-plan/1', root_folder_id: 'root', root_parent_id: 'drive',
    managed_root: 'G:/资料中心', focus_file_id: 'focus', registry: [...files.values()].map(f => ({ provider_file_id: f.id,
      provider_file_version: '1', path: paths[f.id], target_kind: f.mimeType === folder ? 'directory' : 'file',
      state: 'active', governance_class: f.id === 'root' ? 'governance' : 'ordinary',
      provider_sharing_digest: f.mimeType === folder ? googleDriveSharingDigest(f) : null })) };
  const reads = [];
  const metadata = {
    async getFile(id) { reads.push(id); return structuredClone(files.get(id)); },
    async listChildren({ parent_id, name }) { return [...files.values()].filter(f => f.parents[0] === parent_id && f.name === name && !f.trashed).map(f => structuredClone(f)); },
    async listFolder(parent) { return [...files.values()].filter(f => f.parents[0] === parent && !f.trashed).map(f => structuredClone(f)); }
  };
  return { files, make, plan, metadata, reads, observe: () => createGoogleDriveExternalRegistrationObserver({ metadata }).observe(plan) };
}

test('external directory rename keeps provider identities and observes every registered descendant', async () => {
  const f = fixture(); f.files.get('focus').name = '探索产出'; f.files.get('focus').version = '4';
  const result = await f.observe();
  assert.equal(result.first_observation.nodes.find(n => n.provider_file_id === 'file').path, 'G:/资料中心/20_产品/探索产出/候选/logo.txt');
  assert.equal(result.first_observation.nodes.find(n => n.provider_file_id === 'focus').provider_file_version, '4');
  assert.deepEqual(result.first_observation.selected_ids, ['file', 'focus', 'nested']);
  assert.deepEqual(result.first_observation, result.second_observation);
  assert.ok(f.reads.filter(id => id === 'file').length === 2);
});
test('external create is discovered, including a nonempty new folder, without reading bodies', async () => {
  const f = fixture(); f.files.set('new', f.make('new', '新内容.txt', 'focus', 'text/plain'));
  f.files.set('album', f.make('album', '新集合', 'focus')); f.files.set('inside', f.make('inside', '图片.png', 'album', 'image/png'));
  const result = await f.observe(); assert.deepEqual(result.first_observation.new_ids, ['album', 'new']);
  assert.ok(!f.reads.includes('inside'), 'its children wait until their parent is registered');
});
test('external content edit and move resolve through the registered parent identity', async () => {
  const f = fixture(); f.plan.focus_file_id = 'nested'; Object.assign(f.files.get('file'), { parents: ['other'], name: '新名称.txt', version: '9', headRevisionId: 'revision9' });
  const row = (await f.observe()).first_observation.nodes.find(n => n.provider_file_id === 'file');
  assert.equal(row.path, 'G:/资料中心/20_产品/其他/新名称.txt'); assert.equal(row.content_identity.head_revision_id, 'revision9');
});
test('a registered file moved into new nested parents adopts its parent chain in the same observation', async () => {
  const f = fixture(); f.plan.focus_file_id = 'nested';
  f.files.set('new-parent', f.make('new-parent', '新文件夹', 'nested'));
  f.files.set('new-child', f.make('new-child', '新子文件夹', 'new-parent'));
  f.files.get('file').parents = ['new-child'];
  const observed = (await f.observe()).first_observation;
  assert.deepEqual(observed.new_ids, ['new-child', 'new-parent']);
  assert.equal(observed.nodes.find(n => n.provider_file_id === 'file').path,
    'G:/资料中心/20_产品/20_探索产出/候选/新文件夹/新子文件夹/logo.txt');
  f.files.get('new-parent').shared = true;
  await assert.rejects(f.observe(), /ACCESS_CHANGED/);
});
test('new parent adoption cannot escape through an unrelated registered directory', async () => {
  const f = fixture(); f.plan.focus_file_id = 'nested';
  f.files.set('new-parent', f.make('new-parent', '新文件夹', 'other'));
  f.files.get('file').parents = ['new-parent'];
  await assert.rejects(f.observe(), /ADOPTION_DENIED/);
});

test('a folder with 112 files uses bounded parallel metadata reads and includes every item', async () => {
  const f = fixture(); let active = 0, peak = 0;
  for (let i = 0; i < 112; i++) f.files.set('new'+i, f.make('new'+i, '图'+i+'.png', 'focus', 'image/png'));
  const get = f.metadata.getFile;
  f.metadata.getFile = async id => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await get(id); } finally { active--; }
  };
  const result = await f.observe();
  assert.equal(result.first_observation.new_ids.length, 112);
  assert.ok(peak > 1 && peak <= 6); assert.equal(active, 0);
});
for (const [name, mutate, reason] of [
  ['duplicate name', f => f.files.set('duplicate', f.make('duplicate', '20_探索产出', 'track')), 'NAME_AMBIGUOUS'],
  ['move outside root', f => f.files.get('focus').parents = ['outside'], 'IDENTITY_INVALID'],
  ['sharing change', f => f.files.get('focus').shared = true, 'ACCESS_CHANGED'],
  ['ownership change', f => f.files.get('focus').ownedByMe = false, 'ACCESS_CHANGED'],
  ['shortcut', f => { f.plan.focus_file_id = 'nested'; f.files.get('file').mimeType = 'application/vnd.google-apps.shortcut'; }, 'IDENTITY_INVALID'],
  ['root rename', f => f.files.get('root').name = '另一个根', 'ROOT_CHANGED'],
  ['track rename', f => f.files.get('track').name = '其他轨道', 'GOVERNANCE_CHANGED'],
  ['cycle', f => f.files.get('focus').parents = ['nested'], 'PARENT_CYCLE'],
  ['trashed descendant', f => { f.plan.focus_file_id = 'nested'; f.files.get('file').trashed = true; }, 'IDENTITY_INVALID'],
]) test(name + ' cannot silently change registration', async () => {
  const f = fixture(); mutate(f); await assert.rejects(f.observe(), new RegExp(reason));
});
test('changed observation is rejected instead of mixing two file versions', async () => {
  const f = fixture(), get = f.metadata.getFile; let visits = 0;
  f.metadata.getFile = async id => { if (id === 'focus' && ++visits === 2) f.files.get('focus').version = '2'; return get(id); };
  await assert.rejects(f.observe(), /CHANGED_DURING_SCAN/);
});
test('an incomplete namespace never yields an adoption observation', async () => {
  const f = fixture(); f.metadata.listFolder = async () => { throw Error('DRIVE_LIST_INVALID'); };
  await assert.rejects(f.observe(), /DRIVE_LIST_INVALID/);
});
test('revoked provider ID is never automatically adopted under a new name', async () => {
  const f = fixture(); f.plan.registry.push({ provider_file_id: 'revoked', path: 'G:/资料中心/20_产品/旧文件',
    target_kind: 'file', state: 'revoked', governance_class: 'ordinary' });
  f.files.set('revoked', f.make('revoked', '新名字', 'focus', 'text/plain'));
  assert.deepEqual((await f.observe()).first_observation.new_ids, []); assert.ok(!f.reads.includes('revoked'));
});
test('bounded observations abort rather than claim a partial subtree is complete', async () => {
  const f = fixture(); await assert.rejects(createGoogleDriveExternalRegistrationObserver({ metadata: f.metadata, maxObjects: 2 }).observe(f.plan), /OBJECT_LIMIT/);
});
