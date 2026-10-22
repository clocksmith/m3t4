/**
 * Public display-name generation only. This module contains no fighter AI,
 * attributes, account handles or replay logic and works in browsers and Node.
 *
 * V1 is a persisted identity contract: do not reorder/change its words or
 * algorithm in place. Introduce a new version for a future naming campaign.
 * Names are labels, not unique IDs. Keep using slotId for saves and references.
 */
export const FIGHTER_NAME_VERSION = 1;
export const FIGHTER_NAME_MAX_LENGTH = 32;

const words = (text) => Object.freeze(text.trim().split(/\s+/));

export const FIGHTER_NAME_V1_LEXICON = Object.freeze({
  modifiers: words(`
    wobbly wonky bouncy soggy crunchy crispy fizzy fuzzy fluffy squishy gooey
    sticky slippery dusty rusty shiny sparkly velvety lumpy chunky tiny giant
    hefty chonky nifty sneaky sleepy drowsy frantic puzzled baffled curious
    dizzy woozy grumpy cheerful cranky zesty spicy salty tangy tart sweet sour
    buttery cheesy toasty frosty misty stormy breezy smoky sunny lunar cosmic
    astral orbital quantum atomic electric static magnetic digital analog
    pixelated noisy silent squeaky honking wheezy clanky jazzy funky groovy
    waltzing tapdancing juggling tumbling sneezing yawning giggling wriggly
    wiggly drifting floating flying rolling spinning twirling baffling dubious
    unlikely improbable unlicensed undercover incognito accidental defiant
    dramatic theatrical heroic legendary mythic cryptic cursed enchanted
    haunted feral civilized polite awkward bashful proud humble nosy noseless
    confused erratic chaotic lawful neutral elastic inflatable foldable portable
    wireless cordless clockwork ceramic cardboard rubber plastic wooden velcro
    beaded striped polkadot checkered paisley lavender mauve neon
  `),
  nouns: Object.freeze({
    objects: words(`
      toaster spatula teapot kettle colander doorknob sock mitten umbrella
      shoelace paperclip stapler staplegun suitcase backpack lunchbox doormat
      mailbox lamp lantern bookmark envelope crayon eraser pencil anvil hammer
      wrench plunger sponge bucket mop broom zipper thimble button bottle
      compass camera yoyo magnet blender frisbee pinwheel sprocket waffleiron
      keyring lawnchair
    `),
    foods: words(`
      waffle pancake noodle dumpling pickle turnip potato avocado broccoli radish
      cabbage parsnip garlic onion carrot celery olive mango kiwi banana coconut
      apricot peach plum raisin donut pretzel bagel muffin cupcake pudding custard
      jellybean gumdrop cherry tomato biscuit crumpet scone fondue lasagna ravioli
      nacho taco burrito tamale tofu porridge hummus
    `),
    animals: words(`
      axolotl wombat capybara platypus narwhal pangolin armadillo aardvark echidna
      quokka quoll possum otter badger raccoon ferret meerkat tapir walrus manatee
      beluga jellyfish cuttlefish octopus squid shrimp lobster crayfish krill
      penguin puffin pelican flamingo toucan parrot pigeon sparrow goose duck
      turkey emu ostrich cassowary gecko iguana newt frog toad
    `),
    ideas: words(`
      paradox entropy gravity chaos logic courage patience nonsense whimsy justice
      doubt joy boredom panic daydream nostalgia destiny fortune mystery silence
      rumor theory idea syntax metaphor irony context nuance hunch wisdom karma
      fiasco kerfuffle hullabaloo malarkey tomfoolery brouhaha hindsight tomorrow
      yesterday tuesday deadline loophole hiccup perhaps nothing quandary riddle
    `),
    nature: words(`
      pebble boulder gravel moss lichen fern cactus kelp seaweed acorn pinecone
      twig stump leaf thistle nettle clover daisy tulip orchid fungus mushroom
      spore pollen dew drizzle puddle ripple snowflake blizzard hail sleet fog
      mist thunder lightning tornado monsoon avalanche glacier iceberg geyser
      volcano canyon meadow swamp dune waterfall
    `),
    science: words(`
      comet meteor asteroid nebula quasar pulsar galaxy moonbeam sunspot stardust
      eclipse orbit solstice equinox proton neutron electron photon quark boson
      neutrino molecule atom isotope ion plasma laser hologram prism fractal
      vector matrix theorem cosine tangent abacus beaker pipette testtube petri
      gyroscope pendulum oscillator capacitor transistor microscope telescope rocket
    `),
    music: words(`
      kazoo banjo tuba trombone trumpet piccolo oboe bassoon clarinet saxophone
      bagpipe mandolin accordion tambourine xylophone castanet maraca cymbal gong
      bongo drum snare timpani triangle cowbell harmonica theremin melodica keyboard
      guitar cello viola violin harp lute sitar ukulele didgeridoo ocarina whistle
      siren metronome sonata fugue polka disco jingle riff yodel
    `),
    characters: words(`
      wizard goblin gremlin yeti sasquatch basilisk gargoyle dragon wyvern phoenix
      unicorn griffin chimera kraken troll gnome elf imp sprite pixie ogre cyclops
      golem djinn mimic squire knight duchess countess baron duke captain admiral
      mayor deputy sheriff marshal ranger courier plumber tailor dentist baker
      pilot sailor acrobat jester mime
    `),
  }),
});

const nounGroups = Object.values(FIGHTER_NAME_V1_LEXICON.nouns);

/** Count of possible labels, not an assertion of globally unique fighter IDs. */
export const FIGHTER_NAME_SPACE = FIGHTER_NAME_V1_LEXICON.modifiers.length *
  nounGroups.reduce((total, first, i) => total + first.length *
    nounGroups.reduce((sum, second, j) => sum + (i === j ? 0 : second.length), 0), 0);

function seedText(identity) {
  if (typeof identity === 'string' && identity.length > 0) return `s:${identity}`;
  if (typeof identity === 'number' && Number.isFinite(identity)) return `n:${identity}`;
  throw new TypeError('fighter name identity must be a nonempty string or a finite number');
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Stable pseudo-random combinations drawn from unrelated everyday domains.
 * Persist the result at creation/migration, rather than renaming on renders.
 * Supplying a new seed is an explicit request for another suggestion.
 */
export function generateFighterName(identity) {
  let state = hashText(`m3t4:fighter-name:v1:${seedText(identity)}`);
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  const modifier = FIGHTER_NAME_V1_LEXICON.modifiers[next() % FIGHTER_NAME_V1_LEXICON.modifiers.length];
  const firstGroupIndex = next() % nounGroups.length;
  // Distinct domains guarantee a combination, not "toaster kettle" forever.
  const secondGroupIndex = (firstGroupIndex + 1 + next() % (nounGroups.length - 1)) % nounGroups.length;
  const firstGroup = nounGroups[firstGroupIndex];
  const secondGroup = nounGroups[secondGroupIndex];
  return `${modifier} ${firstGroup[next() % firstGroup.length]} ${secondGroup[next() % secondGroup.length]}`;
}

/** Unambiguous owner/slot identity; no delimiter collisions or mutable names. */
export function fighterNameSeed(userId, slotId) {
  if (typeof userId !== 'string' || !userId || typeof slotId !== 'string' || !slotId) {
    throw new TypeError('fighter identity requires nonempty userId and slotId strings');
  }
  return JSON.stringify([userId, slotId]);
}

/**
 * Pure, once-per-version display-name migration. Old names remain exact aliases;
 * handles, IDs, configs, statistics and all unrelated fields stay untouched.
 * Current/future markers also preserve names edited by the user after migration.
 * This deliberately does not traverse objects: never pass match/replay snapshots.
 */
export function migrateFighterName(fighter, identity) {
  if (!fighter || typeof fighter !== 'object' || Array.isArray(fighter)) {
    throw new TypeError('fighter must be an object');
  }
  if (Number.isInteger(fighter.fighterNameVersion) && fighter.fighterNameVersion >= FIGHTER_NAME_VERSION) {
    return fighter;
  }
  if (fighter.previousNames !== undefined &&
      (!Array.isArray(fighter.previousNames) || Array.from(fighter.previousNames).some((name) => typeof name !== 'string'))) {
    throw new TypeError('fighter previousNames must be an array of strings');
  }
  const previousNames = [...new Set([
    ...(fighter.previousNames ?? []),
    ...(typeof fighter.name === 'string' && fighter.name.length ? [fighter.name] : []),
  ])];
  return {
    ...fighter,
    name: generateFighterName(identity),
    fighterNameVersion: FIGHTER_NAME_VERSION,
    previousNames,
  };
}

/**
 * Migrate every saved seat, including seats outside today's active roster cap.
 * Copy-on-change preserves save identity, sparse seats and immutable snapshots.
 * Invalid stable IDs fail closed instead of inventing replacement identities.
 */
export function migrateStableFighterNames(stable) {
  if (!stable || typeof stable !== 'object' || Array.isArray(stable)) {
    throw new TypeError('stable must be an object');
  }
  if (stable.slots === undefined) return stable;
  if (!Array.isArray(stable.slots)) throw new TypeError('stable slots must be an array');
  let changed = false;
  const slots = stable.slots.map((slot) => {
    if (slot == null) return slot;
    const migrated = migrateFighterName(slot, fighterNameSeed(stable.userId, slot.slotId));
    changed ||= migrated !== slot;
    return migrated;
  });
  return changed ? { ...stable, slots } : stable;
}
