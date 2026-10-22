import { generateFighterName } from "../../client/lib/fighter-names.mjs";

// Bound uniqueness retries; the generator itself has a much larger name space.
export const BOT_NAME_SPACE = 65_536;
export function generatedBotName(seed: number): string {
  return generateFighterName(seed >>> 0);
}
