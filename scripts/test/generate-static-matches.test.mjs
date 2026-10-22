import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STRATEGIES } from '../../sim/dist/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (args) => spawnSync(process.execPath, ['scripts/generate-static-matches.cjs', ...args], { cwd: root, encoding: 'utf8' });
test('featured archive preserves old files/index, reproduces current recordings, refuses conflicts and omits configs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fighter-featured-'));
  try {
    const input = join(dir, 'roster.json'), output = join(dir, 'matches');
    const stables = Object.fromEntries(Object.values(STRATEGIES).slice(0, 2).map((config, i) => [`owner-${i}`, { userId: `owner-${i}`, handle: `person${i}`, slots: [{ slotId: `permanent-${i}`, name: 'old label', config: { ...config, author: 'private-configuration-author' }, elo: 1000, wins: 0, losses: 0, draws: 0 }] }]));
    const source = JSON.stringify({ stables }); writeFileSync(input, source); mkdirSync(output);
    writeFileSync(join(output, 'index.json'), 'original-index'); writeFileSync(join(output, 'old.json'), 'original-match');
    const args = [`--roster=${input}`, `--output=${output}`, '--count=1', '--seed=987', '--start=1000'];
    const first = run(args); assert.equal(first.status, 0, first.stderr);
    const files = readdirSync(output), current = files.find(name => name.startsWith('static-v'));
    assert.equal(readFileSync(join(output, files.find(name => name.startsWith('archive-index-'))), 'utf8'), 'original-index');
    assert.equal(readFileSync(join(output, 'old.json'), 'utf8'), 'original-match');
    assert.equal(readFileSync(input, 'utf8'), source);
    const bytes = readFileSync(join(output, current), 'utf8');
    assert.ok(!bytes.includes('private-configuration-author')); assert.ok(!bytes.includes('"config"'));
    const doc = JSON.parse(bytes); assert.equal(doc.featured, true); assert.equal(doc.sim.rulesVersion, 2);
    assert.deepEqual(new Set([doc.a.slotId, doc.b.slotId]), new Set(['permanent-0', 'permanent-1']));
    const index = readFileSync(join(output, 'index.json'), 'utf8');
    assert.equal(run(args).status, 0); assert.equal(readFileSync(join(output, current), 'utf8'), bytes);
    assert.equal(readFileSync(join(output, 'index.json'), 'utf8'), index);
    writeFileSync(join(output, current), 'sealed-conflict');
    const conflict = run(args); assert.equal(conflict.status, 1); assert.match(conflict.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(join(output, current), 'utf8'), 'sealed-conflict');
    assert.equal(readFileSync(join(output, 'index.json'), 'utf8'), index);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('featured generator rejects unbounded counts before reading or writing data', () => {
  for (const count of ['0', '1001', 'NaN']) {
    const result = run([`--count=${count}`, '--roster=/missing/no-input.json']);
    assert.equal(result.status, 1); assert.match(result.stderr, /count must be an integer/);
  }
});
