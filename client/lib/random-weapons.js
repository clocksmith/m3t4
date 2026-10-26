import { makeRng } from '../sim/rng.js';

// Use a separate stream so presentation choices never consume simulation RNG.
// Keep the selected bodies and choose only weapons that each body supports.
export function randomizeWeapons(cosmetics, weaponsForBody, seed) {
  const rng = makeRng((seed >>> 0) ^ 0x5745504e);
  return cosmetics.map(cosmetic => {
    const weapons = weaponsForBody(cosmetic.body);
    return { ...cosmetic, weapon: weapons.length ? weapons[Math.floor(rng() * weapons.length)] : cosmetic.weapon };
  });
}
