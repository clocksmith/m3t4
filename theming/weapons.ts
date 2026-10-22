// Static weapon-atlas contract. Runtime inventory/unlocks are authoritative in
// content/roster-catalog.v1.json; calibrated grip/tip transforms are in
// client/render/fighter-art.js. No independent weapon animation sheets exist.
// All four authored tiers are playable after their existing Elo unlocks.
// Rarity is cosmetic: every item uses the same simulation segment and timing.
import type { Rarity, AssetStatus } from "./assets.js";

export interface WeaponKit {
  id: string;
  characterId: string;
  rarity: Rarity;
  status: AssetStatus;
  minElo: number;
  sprite: { url: string; frameW: 48; frameH: 48; cols: 2; cell: number };
}
const families: Record<string,string[]> = {
  sama: ["worldcoin_orb_flail","backpack_maul","gpu_server_blade","heat_sink_greatsword"],
  darrius: ["rolled_constitution_bat","alignment_baton","red_team_pike","guardrail_greatsword"],
  demis: ["nobel_medal_flail","folded_chess_axe","go_board_maul","alphafold_blade"],
  mark: ["sunscreen_bottle_club","controller_nunchucks","shareholder_sauce_club","quest_flail"],
  jensen: ["compute_bat","heatsink_hammer","silicon_cleaver","rack_greatsword"],
  elon: ["coil_bat","orbit_lance","satellite_axe","angular_greatsword"],
};
const rarities: Rarity[] = ["common","rare","epic","legendary"];
export const WEAPON_KITS: WeaponKit[] = Object.entries(families).flatMap(([characterId,ids]) => ids.map((id,cell) => ({
  id, characterId, rarity: rarities[cell], status: "playable",
  minElo: [0,1024,1152,1280][cell],
  sprite: { url: `assets/weapons/${characterId}/sheet.png`, frameW: 48, frameH: 48, cols: 2, cell },
})));
export const WEAPONS_BY_ID = Object.fromEntries(WEAPON_KITS.map(w => [w.id,w]));
export const weaponsForCharacter = (id: string) => WEAPON_KITS.filter(w => w.characterId === id);
export const playableWeapons = () => WEAPON_KITS.filter(w => w.status === "playable");
