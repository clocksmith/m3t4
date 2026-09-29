import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshController } from '../mesh.mjs';

test('an unavailable selected policy fails before preparing compute', async () => {
  const previous = globalThis.fetch;
  const url = 'https://fixture.invalid/candidate/policy.json';
  globalThis.fetch = async actual => {
    assert.equal(actual, url);
    return { ok: false, status: 404 };
  };
  try {
    const mesh = new MeshController({ policyUrl: url });
    await assert.rejects(mesh.initialize(), /Cannot load the selected mesh policy/);
    assert.equal(mesh.resident, null);
    assert.equal(mesh.runtime, undefined);
  } finally { globalThis.fetch = previous; }
});

test('a selected model cannot inherit the previous model artifact URLs', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, url: 'https://fixture.invalid/policy.json',
    json: async () => ({ model: { id: 'different-model' } }) });
  try {
    const mesh = new MeshController();
    await assert.rejects(mesh.initialize(), /explicit model and piece-index URLs/);
    assert.equal(mesh.resident, null);
    assert.equal(mesh.runtime, undefined);
  } finally { globalThis.fetch = previous; }
});
