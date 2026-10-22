import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateRoster, parseOptions, readRoster } from '../evaluate-fighter-roster.mjs';
import { STRATEGIES } from '../../sim/dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
function fixture() {
  return {
    schema: 'm3t4.evaluation-roster.v1',
    fighters: Object.values(STRATEGIES).slice(0, 4).map((config, index) => ({
      userId: `fixture-owner-${index}`, slotId: `permanent-${index}`, handle: `owner-${index}`,
      slotName: `Fighter ${index}`, config: { ...structuredClone(config), author: 'private-test-author' },
      elo: 1500 + index * 25, wins: index, losses: 1, draws: 2,
      style: `style-${index % 2}`, isHuman: false, lastPlayedAt: 1234,
      customPrivateField: 'never-copy-to-match',
      cosmetics: { body: 'sama', weapon: 'worldcoin_orb_flail', privateConfig: 'never-copy-cosmetics' },
    })),
  };
}
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('requires explicit bounded seed, count and deadline; rejects accidental online flags', () => {
  const base = ['--roster=data/m3t4.json', '--seed=0', '--count=2', '--max-seconds=2'];
  assert.equal(parseOptions(base).seed, 0);
  for (const missing of ['seed', 'count', 'max-seconds']) {
    assert.throws(() => parseOptions(base.filter((arg) => !arg.startsWith(`--${missing}=`))), /required/);
  }
  assert.throws(() => parseOptions([...base, '--count=2']), /duplicate/);
  assert.throws(() => parseOptions([...base, '--firestore=true']), /unknown/);
  assert.throws(() => parseOptions(base.map((arg) => arg === '--count=2' ? '--count=10001' : arg)), /count/);
  assert.throws(() => parseOptions(base.map((arg) => arg === '--max-seconds=2' ? '--max-seconds=0' : arg)), /max-seconds/);
  assert.throws(() => parseOptions(base.map((arg) => arg === '--seed=0' ? '--seed=NaN' : arg)), /seed/);
  assert.throws(() => parseOptions([...base, '--stage=missing']), /stage/);
});

test('readRoster preserves IDs, stats and configs, supports checked-in stables, and rejects duplicates', () => {
  const document = fixture(), before = structuredClone(document);
  const fighters = readRoster(document);
  assert.deepEqual(fighters, before.fighters);
  assert.deepEqual(document, before);
  const stables = Object.fromEntries(document.fighters.map((fighter) => [fighter.userId, {
    userId: fighter.userId, handle: fighter.handle,
    slots: [{ ...fighter, name: fighter.slotName }, null],
  }]));
  const imported = readRoster({ stables });
  assert.deepEqual(imported.map((fighter) => fighter.config), document.fighters.map((fighter) => fighter.config));
  assert.deepEqual(imported.map((fighter) => fighter.slotId), document.fighters.map((fighter) => fighter.slotId));
  assert.deepEqual(imported.map((fighter) => fighter.wins), document.fighters.map((fighter) => fighter.wins));
  assert.throws(() => readRoster({ schema: document.schema, fighters: [fighters[0], fighters[0]] }), /duplicate/);
  const bad = fixture(); bad.fighters[0].config.configVersion = 2;
  assert.throws(() => readRoster(bad), /native-unit/);
  bad.fighters[0].config.configVersion = 1; bad.fighters[0].elo = NaN;
  assert.throws(() => readRoster(bad), /finite/);
  bad.fighters[0].elo = 1500; bad.fighters[0].slotIdx = { privateConfig: 'must-not-be-forwarded' };
  assert.throws(() => readRoster(bad), /slotIdx/);
});

test('real matches reproduce schedule, seeds, replay logs and local Elo without touching the roster', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fighter-evaluation-test-'));
  try {
    const input = join(temp, 'roster.json');
    const document = fixture(), bytes = `${JSON.stringify(document, null, 2)}\n`;
    writeFileSync(input, bytes);
    const options = parseOptions([`--roster=${input}`, '--seed=901', '--count=4', '--max-seconds=20', `--out=${join(temp, 'first')}`]);
    const first = evaluateRoster(options), second = evaluateRoster({ ...options, out: join(temp, 'second') });
    assert.equal(first.completed, 4);
    assert.equal(first.stopReason, 'count-limit');
    assert.equal(first.scheduleSha256, second.scheduleSha256);
    assert.deepEqual(first.fighters, second.fighters);
    assert.equal(readFileSync(input, 'utf8'), bytes);
    assert.equal(readFileSync(join(options.out, 'roster.input.json'), 'utf8'), bytes);
    const matches = readdirSync(join(options.out, 'matches'));
    assert.equal(matches.length, first.completed);
    const wins = new Map(), losses = new Map(), draws = new Map(), lastElo = new Map();
    for (const file of matches) {
      const evidence = json(join(options.out, 'matches', file));
      assert.deepEqual(evidence, json(join(temp, 'second', 'matches', file)));
      assert.equal(evidence.featured, false);
      assert.equal(evidence.simulationSeed, evidence.match.seed);
      assert.equal(evidence.match.sim.behaviorVersion, first.engine.behaviorVersion);
      assert.ok(evidence.match.actionLog.length > 0);
      assert.ok(evidence.match.actionLogHash.length > 0);
      const matchText = JSON.stringify(evidence.match);
      assert.ok(!matchText.includes('private-test-author'));
      assert.ok(!matchText.includes('never-copy'));
      assert.ok(!matchText.includes('"attributes"'));
      assert.ok(!matchText.includes('"config"'));
      for (const [side, name] of [[0, 'a'], [1, 'b']]) {
        const id = evidence.match[name].slotId;
        const counter = evidence.match.result.winner === -1 ? draws : evidence.match.result.winner === side ? wins : losses;
        counter.set(id, (counter.get(id) ?? 0) + 1);
        lastElo.set(id, evidence.match.eloAfter[name]);
      }
    }
    for (const row of first.fighters) {
      assert.equal(row.evaluationElo, lastElo.get(row.slotId));
      assert.equal(row.wins, wins.get(row.slotId) ?? 0);
      assert.equal(row.losses, losses.get(row.slotId) ?? 0);
      assert.equal(row.draws, draws.get(row.slotId) ?? 0);
      const original = document.fighters.find((fighter) => fighter.slotId === row.slotId);
      assert.equal(row.importedElo, original.elo);
      assert.equal(row.importedGames, original.wins + original.losses + original.draws);
    }
    assert.equal(first.distribution.fightersEvaluated, 4);
    assert.equal(first.distribution.distinctPairs, 4);
    assert.equal(first.runtime.matchesPerSecond > 0, true);
    assert.throws(() => evaluateRoster(options), /already exists/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('deadline gives an honest partial result instead of pretending count was completed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fighter-evaluation-deadline-'));
  try {
    const input = join(temp, 'roster.json'); writeFileSync(input, JSON.stringify(fixture()));
    const result = evaluateRoster(parseOptions([`--roster=${input}`, '--seed=9', '--count=10', '--max-seconds=0.000000001', `--out=${join(temp, 'run')}`]));
    assert.equal(result.completed, 0);
    assert.equal(result.requested, 10);
    assert.equal(result.stopReason, 'time-limit');
    assert.equal(json(join(temp, 'run', 'summary.json')).completed, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('refuses public client outputs, including paths through a symlink', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fighter-evaluation-public-'));
  try {
    const input = join(temp, 'roster.json'); writeFileSync(input, JSON.stringify(fixture()));
    symlinkSync(join(root, 'client'), join(temp, 'linked-client'), 'dir');
    const options = parseOptions([`--roster=${input}`, '--seed=9', '--count=1', '--max-seconds=1', `--out=${join(temp, 'linked-client', 'evaluation-test-output')}`]);
    assert.throws(() => evaluateRoster(options), /public client/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI exits nonzero on invalid bounds before creating artifacts', () => {
  const result = spawnSync(process.execPath, ['scripts/evaluate-fighter-roster.mjs', '--roster=data/m3t4.json', '--seed=1', '--count=10001', '--max-seconds=5'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /count/);
});
