import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  FIGHTER_NAME_VERSION,
  FIGHTER_NAME_MAX_LENGTH,
  FIGHTER_NAME_SPACE,
  FIGHTER_NAME_V1_LEXICON,
  generateFighterName,
  fighterNameSeed,
  migrateFighterName,
  migrateStableFighterNames,
} from '../lib/fighter-names.mjs';

const nouns = Object.values(FIGHTER_NAME_V1_LEXICON.nouns).flat();
const nounCategory = new Map(Object.entries(FIGHTER_NAME_V1_LEXICON.nouns)
  .flatMap(([category, entries]) => entries.map((word) => [word, category])));

function assertSafeName(name) {
  assert.match(name, /^[a-z]+ [a-z]+ [a-z]+$/);
  assert.ok(name.length <= FIGHTER_NAME_MAX_LENGTH, `overlong name: ${name}`);
  const [modifier, first, second] = name.split(' ');
  assert.ok(FIGHTER_NAME_V1_LEXICON.modifiers.includes(modifier));
  assert.ok(nounCategory.has(first));
  assert.ok(nounCategory.has(second));
  assert.notEqual(nounCategory.get(first), nounCategory.get(second));
}

function withoutNameMetadata(slot) {
  const { name, fighterNameVersion, previousNames, ...rest } = slot;
  return rest;
}

test('versioned vocabulary spans everyday objects, foods, animals, ideas and more', () => {
  const { modifiers, nouns: categories } = FIGHTER_NAME_V1_LEXICON;
  assert.ok(modifiers.length >= 128);
  assert.ok(Object.keys(categories).length >= 8);
  assert.ok(nouns.length >= 350);
  assert.ok(FIGHTER_NAME_SPACE > 10_000_000);
  assert.equal(new Set(modifiers).size, modifiers.length);
  assert.equal(new Set(nouns).size, nouns.length);
  for (const [category, entries] of Object.entries(categories)) {
    assert.ok(entries.length >= 40, `small domain: ${category}`);
    assert.ok(Object.isFrozen(entries));
  }
  for (const word of [...modifiers, ...nouns]) {
    assert.match(word, /^[a-z]+$/);
    // Guarantees the bound for EVERY combination, not just sampled seeds.
    assert.ok(word.length <= 10, `overlong token: ${word}`);
  }
  assert.ok(Object.isFrozen(FIGHTER_NAME_V1_LEXICON));
  assert.ok(Object.isFrozen(categories));
  assert.ok(Object.isFrozen(modifiers));
});

test('v1 identity vectors stay deterministic across releases and runtime environments', () => {
  const vectors = [
    [0, 'elastic nothing monsoon'],
    [5, 'tapdancing krill cupcake'],
    [13, 'unlicensed pulsar manatee'],
    ['system:standby', 'cosmic mushroom rumor'],
    ['["owner","slot-0"]', 'noseless gyroscope coconut'],
    ['<script>你好\u0000', 'cheesy squire drum'],
    [-1, 'cheerful ion gremlin'],
    [4294967296, 'shiny cosine mist'],
    [0.5, 'mauve imp sprocket'],
  ];
  for (const [seed, expected] of vectors) {
    assert.equal(generateFighterName(seed), expected);
    assert.equal(generateFighterName(seed), expected);
    assertSafeName(expected);
  }
  assert.notEqual(generateFighterName(42), generateFighterName('42'));
  assert.notEqual(generateFighterName(1), generateFighterName(65537));
  assert.notEqual(generateFighterName(1), generateFighterName(4294967297));
  for (const invalid of ['', null, undefined, {}, [], NaN, Infinity, -Infinity]) {
    assert.throws(() => generateFighterName(invalid), TypeError);
  }
});

test('generation and migration do not depend on wall time or ambient randomness', async () => {
  const originalRandom = Math.random;
  const originalNow = Date.now;
  let independent;
  try {
    Math.random = () => { throw new Error('ambient randomness must not rename fighters'); };
    Date.now = () => { throw new Error('wall time must not rename fighters'); };
    const seed = fighterNameSeed('owner', 'saved-slot');
    const first = migrateFighterName({ slotId: 'saved-slot', name: 'old' }, seed);
    assert.equal(first.name, generateFighterName(seed));
    assert.equal(migrateFighterName(first, seed), first);
    // Load the same public ES module independently, with no package/server imports.
    const source = readFileSync(new URL('../lib/fighter-names.mjs', import.meta.url), 'utf8');
    independent = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal(independent.generateFighterName(seed), first.name);
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
  }
  assert.equal(independent.generateFighterName(5), generateFighterName(5));
});

test('100,000 sequential and 20,000 owned seeds are diverse, safe and domain-balanced', (t) => {
  const frequencies = new Map();
  const modifiers = new Set();
  const seenNouns = new Set();
  const categoryPairs = new Set();
  let maxLength = 0;
  for (let seed = 0; seed < 100_000; seed++) {
    const name = generateFighterName(seed);
    assertSafeName(name);
    frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
    const [modifier, first, second] = name.split(' ');
    modifiers.add(modifier);
    seenNouns.add(first);
    seenNouns.add(second);
    categoryPairs.add(`${nounCategory.get(first)}:${nounCategory.get(second)}`);
    maxLength = Math.max(maxLength, name.length);
  }
  assert.ok(frequencies.size >= 99_500, `${frequencies.size} / 100,000 unique names`);
  assert.ok(Math.max(...frequencies.values()) <= 4, 'a name repeats disproportionately');
  assert.equal(modifiers.size, FIGHTER_NAME_V1_LEXICON.modifiers.length);
  assert.equal(seenNouns.size, nouns.length);
  const categories = Object.keys(FIGHTER_NAME_V1_LEXICON.nouns).length;
  assert.equal(categoryPairs.size, categories * (categories - 1));

  const ownedNames = new Set();
  for (let i = 0; i < 20_000; i++) {
    const seed = fighterNameSeed(`owner:${i >> 2}`, `saved-seat:${i % 4}`);
    const name = generateFighterName(seed);
    assertSafeName(name);
    ownedNames.add(name);
  }
  assert.ok(ownedNames.size >= 19_900);
  t.diagnostic(JSON.stringify({
    numericSeeds: 100_000,
    uniqueNumericNames: frequencies.size,
    ownedSeeds: 20_000,
    uniqueOwnedNames: ownedNames.size,
    seenModifiers: modifiers.size,
    seenNouns: seenNouns.size,
    categoryPairs: categoryPairs.size,
    maxLength,
  }));
});

test('stable identity seed does not confuse separators or use mutable handles', () => {
  assert.notEqual(fighterNameSeed('a:b', 'c'), fighterNameSeed('a', 'b:c'));
  assert.notEqual(fighterNameSeed('a', 'bc'), fighterNameSeed('ab', 'c'));
  assert.notEqual(fighterNameSeed('owner-a', 'slot'), fighterNameSeed('owner-b', 'slot'));
  assert.equal(fighterNameSeed('owner', 'saved-slot'), '["owner","saved-slot"]');
  for (const [owner, slot] of [[null, 'slot'], ['owner', null], ['', 'slot'], ['owner', '']]) {
    assert.throws(() => fighterNameSeed(owner, slot), TypeError);
  }
});

test('migration retains exact old names, save identity, combat configuration and all stats', () => {
  const config = Object.freeze({ id: 'custom-build', attributes: Object.freeze({ chase: 0.4, parry: 0.8 }) });
  const original = Object.freeze({
    slotId: 'immutable-slot-id',
    name: 'My Déjà Vu <name>',
    previousNames: Object.freeze(['Alpha', 'Beta', 'Alpha']),
    handle: 'never_rename_author',
    author: { userId: 'owner-1', displayName: 'Author Name' },
    config,
    elo: 1751, peakElo: 1801, wins: 27, losses: 12, draws: 3,
    lastPlayedAt: 110, submittedAt: 95, rateLockedUntil: 120,
    cosmetics: { body: 'sama', weapon: 'worldcoin_orb_flail' },
    unknownFutureField: { keep: true },
  });
  const identity = fighterNameSeed('owner-1', original.slotId);
  const migrated = migrateFighterName(original, identity);
  assert.notEqual(migrated, original);
  assert.equal(migrated.name, generateFighterName(identity));
  assert.equal(migrated.fighterNameVersion, FIGHTER_NAME_VERSION);
  assert.deepEqual(migrated.previousNames, ['Alpha', 'Beta', 'My Déjà Vu <name>']);
  assert.equal(original.name, 'My Déjà Vu <name>');
  assert.deepEqual(withoutNameMetadata(migrated), withoutNameMetadata(original));
  assert.equal(migrated.config, config);
  assert.equal(migrated.cosmetics, original.cosmetics);
  assert.equal(migrated.author, original.author);
  assert.equal(migrated.unknownFutureField, original.unknownFutureField);
});

test('migration is reference-idempotent, survives save/reload and preserves later user edits', () => {
  const original = { slotId: 'seat', name: 'legacy', previousNames: ['legacy'] };
  const migrated = migrateFighterName(original, 'persistent-identity');
  assert.equal(migrateFighterName(migrated, 'persistent-identity'), migrated);
  // The version marker, not comparison to the generated label, is authoritative.
  const edited = { ...migrated, name: 'User chosen after upgrade' };
  assert.equal(migrateFighterName(edited, 'different-input-must-not-replace-name'), edited);
  const restored = JSON.parse(JSON.stringify(edited));
  assert.equal(migrateFighterName(restored, 'persistent-identity'), restored);
  assert.deepEqual(restored.previousNames, ['legacy']);
  const future = { ...edited, fighterNameVersion: FIGHTER_NAME_VERSION + 5 };
  assert.equal(migrateFighterName(future, 'identity'), future);
  const older = { ...original, fighterNameVersion: 0 };
  assert.equal(migrateFighterName(older, 'identity').fighterNameVersion, FIGHTER_NAME_VERSION);
});

test('migration can fill missing legacy names but refuses malformed identity/history', () => {
  assert.deepEqual(migrateFighterName({ slotId: 'seat' }, 'identity').previousNames, []);
  assert.deepEqual(migrateFighterName({ name: '' }, 'identity').previousNames, []);
  for (const fighter of [null, undefined, [], 'not-a-slot']) {
    assert.throws(() => migrateFighterName(fighter, 'identity'), TypeError);
  }
  for (const previousNames of ['legacy', [null], [42], new Array(2)]) {
    assert.throws(() => migrateFighterName({ name: 'old', previousNames }, 'identity'), TypeError);
  }
  assert.throws(() => migrateFighterName({ name: 'legacy' }, ''), TypeError);
});

test('every stored seat migrates beyond the active cap, preserving sparse/null seats and archived snapshots', () => {
  const slots = new Array(10);
  slots[0] = { slotId: 'seat-0', name: 'old-first' };
  slots[1] = null;
  slots[5] = { slotId: 'seat-5', name: 'old-fifth' };
  slots[9] = { slotId: 'seat-9', name: 'old-ninth' };
  const replay = { a: { slotId: 'seat-0', name: 'historic', slotName: 'historic', handle: 'author' }, actionLog: 'ABC' };
  const stable = Object.freeze({
    userId: 'owner', handle: 'original_handle', slots: Object.freeze(slots),
    createdAt: 1, updatedAt: 2, replays: [replay], matches: [replay],
  });
  const migrated = migrateStableFighterNames(stable);
  assert.notEqual(migrated, stable);
  assert.equal(migrated.handle, stable.handle);
  assert.equal(migrated.createdAt, 1);
  assert.equal(migrated.updatedAt, 2);
  assert.equal(migrated.slots.length, 10);
  assert.equal(migrated.slots[1], null);
  assert.equal(2 in migrated.slots, false);
  for (const index of [0, 5, 9]) {
    assert.equal(migrated.slots[index].fighterNameVersion, FIGHTER_NAME_VERSION);
    assert.equal(migrated.slots[index].slotId, slots[index].slotId);
    assert.deepEqual(migrated.slots[index].previousNames, [slots[index].name]);
  }
  assert.equal(migrated.replays, stable.replays);
  assert.equal(migrated.matches, stable.matches);
  assert.equal(replay.a.name, 'historic');
  assert.equal(replay.a.slotName, 'historic');
  assert.equal(migrateStableFighterNames(migrated), migrated);
  assert.equal(migrateStableFighterNames({ ...migrated, handle: 'renamed_author' }).slots, migrated.slots);
});

test('empty stables are no-ops; malformed stable IDs never trigger invented save identity', () => {
  for (const stable of [{ userId: 'owner' }, { userId: 'owner', slots: [] }, { userId: 'owner', slots: [null] }]) {
    assert.equal(migrateStableFighterNames(stable), stable);
  }
  for (const stable of [null, [], { slots: {} }, { slots: [{ name: 'old', slotId: 'seat' }] },
    { userId: 'owner', slots: [{ name: 'old' }] }]) {
    assert.throws(() => migrateStableFighterNames(stable), TypeError);
  }
});

test('all checked-in current fighters migrate once without changing the save or historic identities', (t) => {
  const fixture = JSON.parse(readFileSync(new URL('../../data/m3t4.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(fixture);
  const migrated = {
    ...fixture,
    stables: Object.fromEntries(Object.entries(fixture.stables)
      .map(([id, stable]) => [id, migrateStableFighterNames(stable)])),
  };
  const names = new Set();
  let slots = 0;
  for (const [id, stable] of Object.entries(migrated.stables)) {
    const original = fixture.stables[id];
    assert.equal(stable.userId, original.userId);
    assert.equal(stable.handle, original.handle);
    assert.equal(stable.createdAt, original.createdAt);
    assert.equal(stable.updatedAt, original.updatedAt);
    assert.equal(stable.slots.length, original.slots.length);
    assert.equal(migrateStableFighterNames(stable), stable);
    for (let i = 0; i < stable.slots.length; i++) {
      const slot = stable.slots[i];
      if (!slot) continue;
      slots++;
      assertSafeName(slot.name);
      names.add(slot.name);
      assert.deepEqual(withoutNameMetadata(slot), withoutNameMetadata(original.slots[i]));
      if ((original.slots[i].fighterNameVersion ?? 0) < FIGHTER_NAME_VERSION) {
        assert.ok(slot.previousNames.includes(original.slots[i].name));
      } else {
        assert.equal(slot, original.slots[i]);
      }
    }
  }
  assert.equal(names.size, slots, 'current fixture has no repeated generated names');
  assert.equal(migrated.handles, fixture.handles);
  assert.equal(migrated.replays, fixture.replays);
  assert.equal(JSON.stringify(fixture), before, 'the original save stays unmodified');

  // Existing archived matches are evidence for real IDs, never migration targets.
  const archiveDir = new URL('../matches/', import.meta.url);
  const archiveNames = new Set();
  const identities = new Set();
  let matches = 0;
  for (const filename of readdirSync(archiveDir).filter((name) => name.endsWith('.json'))) {
    const match = JSON.parse(readFileSync(new URL(filename, archiveDir), 'utf8'));
    if (match.schema !== 'm3t4.match.v1') continue;
    matches++;
    const originalMatch = JSON.stringify(match);
    for (const side of [match.a, match.b]) {
      if (!side) continue;
      const identity = fighterNameSeed(side.userId, side.slotId);
      identities.add(identity);
      archiveNames.add(generateFighterName(identity));
    }
    assert.equal(JSON.stringify(match), originalMatch, 'historical labels/replay payloads stay exact');
  }
  assert.equal(archiveNames.size, identities.size, 'all archived identity references also map distinctly');
  t.diagnostic(JSON.stringify({ currentSlots: slots, currentUniqueNames: names.size,
    archivedMatchesInspected: matches, archivedIdentityReferences: identities.size }));
});
