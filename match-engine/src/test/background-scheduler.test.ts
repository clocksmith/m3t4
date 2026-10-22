import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND_HISTORY_LIMIT, evaluationFighterKey, evaluationSeed,
  selectBackgroundPair, type EvaluationFighter, type EvaluationHistoryEntry,
} from '../background-scheduler.js';

function roster(size: number, gamesPlayed = 0): EvaluationFighter[] {
  return Array.from({ length: size }, (_, i) => ({
    userId: `owner-${i}`, slotId: `slot-${i}`, elo: 1000 + i * 80,
    gamesPlayed, evaluations: 0, style: `style-${i % 3}`,
  }));
}
function run(fighters: EvaluationFighter[], seed = 123, count = 40) {
  const current = structuredClone(fighters), history: EvaluationHistoryEntry[] = [], selections = [];
  for (let sequence = 0; sequence < count; sequence++) {
    const selection = selectBackgroundPair({ fighters: current, seed, sequence, history });
    assert.ok(selection);
    selections.push(selection);
    history.push({ sequence, a: selection.a, b: selection.b });
    for (const fighter of current) {
      if (selection.a === evaluationFighterKey(fighter) || selection.b === evaluationFighterKey(fighter)) {
        fighter.gamesPlayed++;
        fighter.evaluations++;
      }
    }
  }
  return { current, history, selections };
}

test('seeded schedule is reproducible, order independent, and does not mutate inputs', () => {
  const fighters = roster(12), original = structuredClone(fighters);
  assert.deepEqual(run(fighters), run(fighters));
  assert.deepEqual(run(fighters).selections, run([...fighters].reverse()).selections);
  assert.notDeepEqual(run(fighters, 123).selections, run(fighters, 124).selections);
  assert.deepEqual(fighters, original);
  assert.equal(evaluationSeed(0, 0), evaluationSeed(0, 0));
  assert.notEqual(evaluationSeed(0, 0), evaluationSeed(0, 1));
});

test('never schedules self-play or slots from the same owner', () => {
  const fighters = roster(4);
  fighters[1].userId = fighters[0].userId;
  for (const pair of run(fighters).selections) {
    assert.notEqual(pair.a, pair.b);
    assert.notEqual(JSON.parse(pair.a)[0], JSON.parse(pair.b)[0]);
  }
  assert.equal(selectBackgroundPair({ fighters: fighters.slice(0, 2), seed: 1, sequence: 0, history: [] }), null);
  assert.equal(selectBackgroundPair({ fighters: [], seed: 1, sequence: 0, history: [] }), null);
});

test('placement reaches varied opponents and skill bands while giving the whole roster turns', () => {
  const fighters = roster(16);
  const result = run(fighters, 20261022, 64);
  assert.ok(result.current.every((fighter) => fighter.evaluations >= 6));
  assert.ok(Math.max(...result.current.map((fighter) => fighter.evaluations)) - Math.min(...result.current.map((fighter) => fighter.evaluations)) <= 2);
  assert.deepEqual(new Set(result.selections.map((selection) => selection.placementBand).filter(Boolean)), new Set(['lower', 'middle', 'upper']));
  for (const fighter of fighters) {
    const key = evaluationFighterKey(fighter);
    const first = result.selections.filter((selection) => selection.a === key || selection.b === key).slice(0, 6);
    assert.ok(new Set(first.map((selection) => selection.a === key ? selection.b : selection.a)).size >= 5);
  }
});

test('newcomer gets placement priority among equally served established fighters', () => {
  const fighters = roster(8, 100);
  fighters[5].gamesPlayed = 0;
  const selection = selectBackgroundPair({ fighters, seed: 2, sequence: 0, history: [] })!;
  assert.equal(selection.pivot, evaluationFighterKey(fighters[5]));
  assert.equal(selection.reason, 'placement');
});

test('first pass covers an even distinct-owner roster without recycling opponents', () => {
  assert.ok(run(roster(16), 20261022, 8).current.every((fighter) => fighter.evaluations === 1));
});

test('established fighters prefer close skill; uncertainty widens useful opposition', () => {
  const fighters = roster(3, 100);
  fighters[0].elo = 1500;
  fighters[0].uncertainty = 0;
  fighters[1] = { ...fighters[1], elo: 1550, uncertainty: 0, evaluations: 1 };
  fighters[2] = { ...fighters[2], elo: 1600, uncertainty: 0, evaluations: 1 };
  let pair = selectBackgroundPair({ fighters, seed: 2, sequence: 0, history: [] })!;
  assert.ok([pair.a, pair.b].includes(evaluationFighterKey(fighters[1])));
  assert.equal(pair.reason, 'skill');
  fighters[2].uncertainty = 350;
  pair = selectBackgroundPair({ fighters, seed: 2, sequence: 0, history: [] })!;
  assert.ok([pair.a, pair.b].includes(evaluationFighterKey(fighters[2])));
});

test('cooldowns are honored globally, not just for the chosen pivot', () => {
  const result = run(roster(9), 7, 100);
  for (let i = 0; i < result.selections.length; i++) {
    const selected = result.selections[i];
    const recent = result.selections.slice(Math.max(0, i - 8), i);
    assert.ok(!recent.some((other) => [other.a, other.b].sort().join() === [selected.a, selected.b].sort().join()));
    assert.equal(selected.fallback, 'none');
    if (i > 0) {
      const last = result.selections[i - 1];
      assert.ok(![last.a, last.b].includes(selected.a) && ![last.a, last.b].includes(selected.b));
    }
  }
});

test('tiny pools disclose unavoidable rest and repeat fallbacks and still progress', () => {
  const two = run(roster(2), 1, 8).selections;
  assert.equal(two[0].fallback, 'none');
  assert.ok(two.slice(1).every((selection) => selection.fallback === 'pair-repeat-unavoidable' && selection.relaxedPairCooldown));
  const three = run(roster(3), 1, 9).selections;
  assert.equal(three[1].fallback, 'fighter-cooldown-unavoidable');
  assert.equal(three[2].fallback, 'fighter-cooldown-unavoidable');
  assert.equal(three[3].fallback, 'pair-repeat-unavoidable');
  assert.equal(new Set(three.slice(0, 3).map((selection) => [selection.a, selection.b].sort().join())).size, 3);
});

test('history expires by sequence and cooldowns can be disabled explicitly', () => {
  const fighters = roster(2), keys = fighters.map(evaluationFighterKey);
  const history = [{ sequence: 0, a: keys[0], b: keys[1] }];
  assert.equal(selectBackgroundPair({ fighters, seed: 1, sequence: 9, history })!.fallback, 'none');
  assert.equal(selectBackgroundPair({ fighters, seed: 1, sequence: 1, history, pairCooldown: 0, fighterCooldown: 0 })!.fallback, 'none');
});

test('malformed, unbounded or future input is rejected rather than silently randomized', () => {
  const options = { fighters: roster(3), seed: 0, sequence: 0, history: [] };
  assert.throws(() => selectBackgroundPair({ ...options, seed: -1 }), /seed/);
  assert.throws(() => selectBackgroundPair({ ...options, seed: 0x1_0000_0000 }), /seed/);
  assert.throws(() => selectBackgroundPair({ ...options, pairCooldown: 257 }), /pairCooldown/);
  assert.throws(() => selectBackgroundPair({ ...options, fighters: roster(257) }), /large/);
  assert.throws(() => selectBackgroundPair({ ...options, fighters: [options.fighters[0], options.fighters[0]] }), /duplicate/);
  assert.throws(() => selectBackgroundPair({ ...options, history: [{ sequence: 0, a: 'a', b: 'b' }] }), /history.sequence/);
  assert.throws(() => selectBackgroundPair({ ...options, history: Array(BACKGROUND_HISTORY_LIMIT + 1).fill({ sequence: 0, a: 'a', b: 'b' }) }), /bounded/);
  assert.throws(() => selectBackgroundPair({ ...options, fighters: [{ ...options.fighters[0], elo: NaN }] }), /finite/);
});

test('identity keys cannot collide through newlines or delimiters', () => {
  assert.notEqual(evaluationFighterKey({ userId: 'a\nb', slotId: 'c' }), evaluationFighterKey({ userId: 'a', slotId: 'b\nc' }));
});
