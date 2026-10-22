import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const tool of ['measure-fighter-tactics.mjs', 'measure-fighter-routes.mjs']) {
  test(`${tool} refuses overwriting retained evidence before loading a simulation`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'fighter-output-test-'));
    try {
      const output = join(directory, 'sealed.json');
      writeFileSync(output, 'original evidence\n');
      const result = spawnSync(process.execPath, [`tools/${tool}`, '--output', output, '--sim', '/missing/never-import.js'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /refusing to overwrite evaluation evidence/);
      assert.equal(readFileSync(output, 'utf8'), 'original evidence\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
