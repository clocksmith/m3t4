/** Pure shared display-name helpers. No simulation or account mutation. */
export const FIGHTER_NAME_VERSION: 1;
export const FIGHTER_NAME_MAX_LENGTH: 32;
export const FIGHTER_NAME_SPACE: number;
export const FIGHTER_NAME_V1_LEXICON: Readonly<{
  modifiers: readonly string[];
  nouns: Readonly<Record<'objects' | 'foods' | 'animals' | 'ideas' | 'nature' | 'science' | 'music' | 'characters', readonly string[]>>;
}>;

export interface FighterNameRecord {
  name?: string;
  fighterNameVersion?: number;
  previousNames?: readonly string[];
}
export interface FighterNameMetadata {
  name: string;
  fighterNameVersion: number;
  previousNames?: readonly string[];
}
export interface FighterNameStable {
  userId: string;
  slots?: readonly ((FighterNameRecord & { slotId: string }) | null | undefined)[];
}

export function generateFighterName(identity: string | number): string;
export function fighterNameSeed(userId: string, slotId: string): string;
/** Returns the input reference unchanged for already-migrated/future versions. */
export function migrateFighterName<T extends FighterNameRecord>(fighter: T, identity: string | number): T & FighterNameMetadata;
/** Returns the input reference unchanged if no saved seat needs migration. */
export function migrateStableFighterNames<T extends FighterNameStable>(stable: T): T;
