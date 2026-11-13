import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncMuzilRuntime } from '../../tools/sync-muzil-runtime.mjs';

const put = async (root, file, content = 'export const ready = true;') => {
  const target = resolve(root, file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
};
async function fixture(run) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'm3t4-runtime-sync-'));
  const root = resolve(workspace, 'm3t4'), doppler = resolve(workspace, 'doppler'), reploid = resolve(workspace, 'reploid');
  try {
    await mkdir(root);
    for (const file of ['transport/assignment.js', 'mesh/partitions/partition-link.js', 'mesh/partitions/partition-entry.js',
      'mesh/partitions/partition-chat.js', 'mesh/partitions/partition-peer.js', 'mesh/partitions/resident-partition.js',
      'mesh/partitions/partition-grants.js', 'artifacts/custody/piece-acquisition.js']) await put(reploid, 'packages/reploid/src/' + file);
    await put(doppler, 'src/index.js'); await put(doppler, 'src/gpu/test.wgsl', 'shader bytes');
    await put(doppler, 'models/local/create-gemma-3-1b-qualification/manifest.json', '{"modelId":"fixture"}');
    await put(doppler, 'models/partition-pieces/gemma-3-1b.json', '{}');
    for (const source of [doppler, reploid]) {
      await put(source, 'LICENSE', 'MIT');
      execFileSync('git', ['init', '-q'], { cwd: source });
      execFileSync('git', ['add', '.'], { cwd: source });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: source });
    }
    await run({ root, doppler, sync: options => syncMuzilRuntime({ root, log: () => {}, ...options }) });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

test('unchanged sync writes nothing; revision metadata remains current without rewriting copied bytes', () => fixture(async ({ root, doppler, sync }) => {
  const first = await sync(); assert.ok(first.written > 0);
  const second = await sync(); assert.equal(second.written, 0); assert.equal(second.removed, 0);
  assert.equal((await sync({ check: true })).written, 0);
  assert.equal(await readFile(resolve(root, 'client/vendor/doppler/src/gpu/test.wgsl'), 'utf8'), 'shader bytes');
  await put(doppler, 'README.md', 'unrelated documentation');
  execFileSync('git', ['add', 'README.md'], { cwd: doppler });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'docs'], { cwd: doppler });
  const updated = await sync();
  assert.equal(updated.written, 2, 'only the two identity manifests change');
  assert.notEqual(updated.report.libraries.doppler.revision, first.report.libraries.doppler.revision);
  assert.deepEqual(updated.report.libraries.doppler.files, first.report.libraries.doppler.files);
}));

test('repairs changed/corrupt files, prunes stale copies and preserves the model alias', () => fixture(async ({ root, doppler, sync }) => {
  await sync();
  await put(root, 'client/vendor/doppler/stale.js', 'stale');
  await assert.rejects(sync({ check: true }), /Stale runtime file/);
  await put(doppler, 'src/index.js', 'export const changed = true;');
  await put(root, 'client/vendor/reploid/LICENSE', 'corrupt');
  const result = await sync(); assert.equal(result.removed, 1);
  assert.equal(await readFile(resolve(root, 'client/vendor/doppler/src/index.js'), 'utf8'), 'export const changed = true;');
  assert.equal(await readFile(resolve(root, 'client/vendor/reploid/LICENSE'), 'utf8'), 'MIT');
  assert.equal(await readFile(resolve(root, 'client/vendor/doppler/models/muzil-gemma-1b/manifest.json'), 'utf8'), '{"modelId":"fixture"}');
  assert.equal(result.report.libraries.doppler.sourceDirty, true);
  await sync({ check: true });
}));

test('rejects output symlinks without modifying their targets', () => fixture(async ({ root, sync }) => {
  await sync();
  const target = resolve(root, 'outside.txt'), copied = resolve(root, 'client/vendor/reploid/LICENSE');
  await writeFile(target, 'outside'); await rm(copied); await symlink(target, copied);
  await assert.rejects(sync(), /Not a regular output file/);
  assert.equal(await readFile(target, 'utf8'), 'outside');
  await rm(resolve(root, 'client/vendor/reploid'), { recursive: true });
  await symlink(resolve(root, '..'), resolve(root, 'client/vendor/reploid'));
  await assert.rejects(sync(), /Not a regular output directory/);
  assert.equal(await readFile(target, 'utf8'), 'outside');
}));
