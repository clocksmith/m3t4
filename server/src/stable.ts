// Stable data model + storage interface. Implementations can be swapped
// (file-backed for dev, Firestore for production) without touching callers.
//
// Privacy rule: getPublic* methods NEVER return `config.attributes`. Internal
// methods used by the matchmaker + sim runner have full access.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compileBrain, STRATEGIES, type BrainConfig, type Character, type ReplayArtifactV1 } from "@m3t4/sim";
import { CONFIG } from "./config.js";
import rosterCatalog from "./generated/roster-catalog.js";
import { publicReplayArtifactFromReplay, type PublicReplayArtifactV1 } from "./public-artifacts.js";

// System user — owner of phantom seed bots (the 16 named strategies).
// Ensures the firehose has opponents before real users sign up, and
// provides a "floor" meta that new users can beat their way past.
const SYSTEM_UID = "system";

export const ROSTER_BODY_IDS = rosterCatalog.bodies;
export type RosterBodyId = typeof ROSTER_BODY_IDS[number];
type RosterWeaponEntry = (typeof rosterCatalog.weapons)[RosterBodyId][number];
export type RosterWeaponId = RosterWeaponEntry["id"];

export const ROSTER_WEAPON_IDS_BY_BODY = Object.fromEntries(
  ROSTER_BODY_IDS.map((body) => [
    body,
    rosterCatalog.weapons[body].filter((weapon) => weapon.available).map((weapon) => weapon.id),
  ]),
) as unknown as Record<RosterBodyId, readonly RosterWeaponId[]>;

const ROSTER_DEFAULT_NAMES = [
  "wingus",
  "dingus",
  "hambone",
  "zapper",
  "bonk",
  "dialup",
  "floppy",
  "shareware",
  "lanparty",
  "hotseat",
  "modem",
  "megabyte",
  "joystick",
  "gamepad",
  "turbo",
  "pog",
  "slammer",
  "radmax",
  "dozer",
  "widget",
  "sprocket",
  "kludge",
  "glitch",
  "zipdrive",
  "winamp",
  "geocities",
  "tripod",
  "angelfire",
  "boombox",
  "vhs",
  "jolt",
  "neon",
] as const;

export interface SlotCosmetics {
  body: RosterBodyId;
  weapon: RosterWeaponId;
}

export type SlotCosmeticsInput = Partial<Record<keyof SlotCosmetics, unknown>>;

const ROSTER_BODY_CHARACTERS: Record<RosterBodyId, Omit<Character, "body" | "weapon">> = {
  sama: { name: "Sama", label: "Capacity Mystic", col: "#6ee7b7", trim: "#d1fae5", shadow: "#047857" },
  darrius: { name: "Darrius", label: "Policy Undertaker", col: "#fb923c", trim: "#fed7aa", shadow: "#9a3412" },
  demis: { name: "Demis", label: "Quiet Solver", col: "#60a5fa", trim: "#dbeafe", shadow: "#1e3a8a" },
  mark: { name: "Mark", label: "Sunlit Operator", col: "#c084fc", trim: "#ede9fe", shadow: "#5b21b6" },
};

export interface Slot {
  slotId: string;
  config: BrainConfig;        // PRIVATE — never served to clients
  name: string;               // user-given nickname, public
  cosmetics?: SlotCosmetics;
  submittedAt: number;
  rateLockedUntil: number;
  elo: number;
  peakElo?: number;
  wins: number;
  losses: number;
  draws: number;
  lastPlayedAt: number;
}

export interface Stable {
  userId: string;             // Firebase UID
  handle: string;             // chosen username, unique, public
  slots: Slot[];
  createdAt: number;
  updatedAt: number;
}

/** Public view of a stable. No configs. */
export interface StablePublic {
  userId: string;
  handle: string;
  eloAggregate: number;
  slots: SlotPublic[];
  wins: number;
  losses: number;
}

export interface SlotPublic {
  slotIdx: number;
  slotId: string;
  name: string;
  cosmetics: SlotCosmetics;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  lastPlayedAt: number;
}

export function computeAggregate(slots: Slot[]): number {
  if (slots.length === 0) return CONFIG.eloAnchor;
  return Math.round(slots.reduce((s, x) => s + x.elo, 0) / slots.length);
}

export function activeRosterSlots<T>(slots: readonly (T | null | undefined)[] = []): T[] {
  return slots.slice(0, CONFIG.maxSlots).filter((slot): slot is T => !!slot);
}

export function activeRosterSlotEntries<T>(
  slots: readonly (T | null | undefined)[] = [],
): Array<{ slot: T; slotIdx: number }> {
  return slots
    .slice(0, CONFIG.maxSlots)
    .map((slot, slotIdx) => ({ slot, slotIdx }))
    .filter((entry): entry is { slot: T; slotIdx: number } => !!entry.slot);
}

export function defaultSlotCosmetics(slotIdx: number): SlotCosmetics {
  const body = ROSTER_BODY_IDS[((slotIdx % ROSTER_BODY_IDS.length) + ROSTER_BODY_IDS.length) % ROSTER_BODY_IDS.length];
  return { body, weapon: firstAvailableWeapon(body) };
}

export function normalizeSlotCosmetics(
  input: unknown,
  slotIdx: number,
  fallback: SlotCosmetics = defaultSlotCosmetics(slotIdx),
  unlockElo = CONFIG.eloAnchor,
): SlotCosmetics {
  const source = input && typeof input === "object" ? input as SlotCosmeticsInput : {};
  const body = isRosterBodyId(source.body) ? source.body : fallback.body;
  const fallbackWeapon = weaponBelongsToBody(body, fallback.weapon, unlockElo)
    ? fallback.weapon
    : firstAvailableWeapon(body);
  const weapon = weaponBelongsToBody(body, source.weapon, unlockElo)
    ? source.weapon
    : fallbackWeapon;
  return { body, weapon };
}

export function slotUnlockElo(slot: Pick<Slot, "elo" | "peakElo"> | null | undefined): number {
  const peak = Number(slot?.peakElo);
  const elo = Number(slot?.elo);
  return Math.max(
    Number.isFinite(peak) ? peak : CONFIG.eloAnchor,
    Number.isFinite(elo) ? elo : CONFIG.eloAnchor,
    CONFIG.eloAnchor,
  );
}

export function slotCosmetics(
  slot: Pick<Slot, "cosmetics" | "elo" | "peakElo"> | null | undefined,
  slotIdx: number,
): SlotCosmetics {
  return normalizeSlotCosmetics(slot?.cosmetics, slotIdx, defaultSlotCosmetics(slotIdx), slotUnlockElo(slot));
}

export function characterForCosmetics(cosmetics: SlotCosmetics): Character {
  return {
    ...ROSTER_BODY_CHARACTERS[cosmetics.body],
    body: cosmetics.body,
    weapon: cosmetics.weapon,
  };
}

export function charsForSlots(a: Slot, b: Slot): [Character, Character] {
  return [
    characterForCosmetics(slotCosmetics(a, 0)),
    characterForCosmetics(slotCosmetics(b, 1)),
  ];
}

export function assertUniqueBodyInStable(st: Stable, slotIdx: number, cosmetics: SlotCosmetics): void {
  for (let i = 0; i < Math.min(CONFIG.maxSlots, st.slots.length); i++) {
    if (i === slotIdx) continue;
    const slot = st.slots[i];
    if (!slot) continue;
    const other = slotCosmetics(slot, i);
    if (other.body === cosmetics.body) {
      throw new Error(`${cosmetics.body} body already used by seat ${i}`);
    }
  }
}

export function normalizeStableSlotCosmetics(st: Stable): void {
  for (let i = 0; i < Math.min(CONFIG.maxSlots, st.slots.length); i++) {
    const slot = st.slots[i];
    if (!slot) continue;
    slot.cosmetics = slotCosmetics(slot, i);
  }
}

export function stablePublic(st: Stable): StablePublic {
  const entries = activeRosterSlotEntries(st.slots);
  const slots = entries.map((entry) => entry.slot);
  const wins = slots.reduce((s, x) => s + x.wins, 0);
  const losses = slots.reduce((s, x) => s + x.losses, 0);
  return {
    userId: st.userId,
    handle: st.handle,
    eloAggregate: computeAggregate(slots),
    wins,
    losses,
    slots: entries.map(({ slot: s, slotIdx }) => ({
      slotIdx,
      slotId: s.slotId,
      name: s.name,
      cosmetics: slotCosmetics(s, slotIdx),
      elo: s.elo,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      lastPlayedAt: s.lastPlayedAt,
    })),
  };
}

export function effectiveRateLockedUntil(slot: Pick<Slot, "rateLockedUntil" | "submittedAt">): number {
  const stored = Number(slot.rateLockedUntil ?? 0);
  const submittedAt = Number(slot.submittedAt ?? 0);
  const configured = Number.isFinite(submittedAt) && submittedAt > 0
    ? submittedAt + CONFIG.submitRateMs
    : stored;
  if (!Number.isFinite(stored) || stored <= 0) return Math.max(0, configured);
  if (!Number.isFinite(configured) || configured <= 0) return Math.max(0, stored);
  return Math.max(0, Math.min(stored, configured));
}

function normalizeSlotNameInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const clean = input.trim().toLowerCase();
  if (!clean) return null;
  if (/^(slot|seat)[\s_-]*\d+$/i.test(clean)) return null;
  return clean.slice(0, 32);
}

function randomRosterName(): string {
  return ROSTER_DEFAULT_NAMES[crypto.randomInt(ROSTER_DEFAULT_NAMES.length)];
}

export function nextSlotName(input: unknown, existing: string | undefined): string {
  return normalizeSlotNameInput(input)
    ?? normalizeSlotNameInput(existing)
    ?? randomRosterName();
}

// ---------- Abstract interface ----------

export interface StableStore {
  getStable(userId: string): Promise<Stable | null>;
  upsertHandle(userId: string, handle: string): Promise<Stable>;
  submitToSlot(
    userId: string,
    slotIdx: number,
    config: BrainConfig,
    name?: string,
    cosmetics?: SlotCosmeticsInput,
  ): Promise<{ slotId: string }>;
  listActive(sinceMs: number): Promise<Stable[]>;
  updateAfterMatch(res: MatchUpdate): Promise<void>;
  archiveReplay(artifact: ReplayArtifactV1): Promise<void>;
  getReplay(matchId: string): Promise<ReplayArtifactV1 | null>;
  getPublicReplayArtifact(matchId: string): Promise<PublicReplayArtifactV1 | null>;
  applyDecay(): Promise<number>; // returns number of slots decayed
  handleTaken(handle: string, excludeUid?: string): Promise<boolean>;
}

export interface MatchUpdate {
  aUserId: string;
  aSlotId: string;
  aEloBefore: number;
  aEloAfter: number;
  bUserId: string;
  bSlotId: string;
  bEloBefore: number;
  bEloAfter: number;
  winner: 0 | 1 | -1;
  playedAt: number;
}

// ---------- File-backed impl (local dev; no auth required) ----------

interface StoreData {
  stables: Record<string, Stable>; // keyed by userId
  handles: Record<string, string>; // handle → userId
  replays: Record<string, ReplayArtifactV1>; // PRIVATE — includes configs
  publicReplayArtifacts: Record<string, PublicReplayArtifactV1>; // PUBLIC — no configs
  version: number;
}

export interface FileStableStoreOptions {
  // When true: skip phantom seeding and suppress all disk writes. Used by
  // inspect tooling so `new FileStableStore(path, { readOnly: true })` is
  // a pure read of the on-disk archive.
  readOnly?: boolean;
}

export class FileStableStore implements StableStore {
  private path: string;
  private data: StoreData;
  private readOnly: boolean;

  constructor(storePath: string, options: FileStableStoreOptions = {}) {
    this.path = storePath;
    this.readOnly = !!options.readOnly;
    if (fs.existsSync(storePath)) {
      this.data = JSON.parse(fs.readFileSync(storePath, "utf8"));
      this.data.replays ??= {};
      this.data.publicReplayArtifacts ??= {};
    } else if (this.readOnly) {
      throw new Error(`readOnly FileStableStore requires existing file: ${storePath}`);
    } else {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      this.data = { stables: {}, handles: {}, replays: {}, publicReplayArtifacts: {}, version: 1 };
    }
    if (!this.readOnly) {
      this.seedSystemPhantoms();
      this.flush();
    }
  }

  // Seed each of the 16 named strategies as its own virtual stable, so
  // each phantom is an independent participant in the matchmaking pool.
  // Idempotent: preserves ELO/W-L on existing phantoms, refreshes strategy
  // configs after rebalance patches, and adds any newly-added strategies.
  private seedSystemPhantoms(): void {
    let cosmeticIdx = 0;
    for (const [name, cfg] of Object.entries(STRATEGIES)) {
      const seededCosmetics = defaultSlotCosmetics(cosmeticIdx++);
      const uid = `system:${name}`;
      const existing = this.data.stables[uid];
      if (existing) {
        const slot = existing.slots[0];
        if (slot) {
          slot.config = cfg;
          slot.name = name;
          slot.rateLockedUntil = 0;
          slot.peakElo = Math.max(slotUnlockElo(slot), slot.elo);
          slot.cosmetics = normalizeSlotCosmetics(slot.cosmetics, 0, seededCosmetics);
        }
        existing.handle = `sys_${name}`;
        existing.updatedAt = Date.now();
        this.data.handles[`sys_${name}`] = uid;
        continue;
      }
      const now = Date.now();
      this.data.stables[uid] = {
        userId: uid,
        handle: `sys_${name}`,
        slots: [
          {
            slotId: `sys-${name}`,
            config: cfg,
            name,
            cosmetics: seededCosmetics,
            submittedAt: now,
            rateLockedUntil: 0, // phantoms can't be rate-limited
            elo: CONFIG.eloAnchor,
            peakElo: CONFIG.eloAnchor,
            wins: 0,
            losses: 0,
            draws: 0,
            lastPlayedAt: now, // always active for matchmaking
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      this.data.handles[`sys_${name}`] = uid;
    }
  }

  private flush(): void {
    if (this.readOnly) return;
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  async getStable(userId: string): Promise<Stable | null> {
    return this.data.stables[userId] ?? null;
  }

  async handleTaken(handle: string, excludeUid?: string): Promise<boolean> {
    const owner = this.data.handles[handle.toLowerCase()];
    return !!owner && owner !== excludeUid;
  }

  async upsertHandle(userId: string, handle: string): Promise<Stable> {
    const clean = handle.toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
      throw new Error("handle must be 3-20 chars, a-z 0-9 _");
    }
    const existing = this.data.handles[clean];
    if (existing && existing !== userId) throw new Error("handle taken");

    let st = this.data.stables[userId];
    if (!st) {
      st = {
        userId,
        handle: clean,
        slots: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.data.stables[userId] = st;
    } else if (st.handle !== clean) {
      // moving handle: free old one
      delete this.data.handles[st.handle];
      st.handle = clean;
    }
    this.data.handles[clean] = userId;
    st.updatedAt = Date.now();
    this.flush();
    return st;
  }

  async submitToSlot(
    userId: string,
    slotIdx: number,
    config: BrainConfig,
    name?: string,
    cosmetics?: SlotCosmeticsInput,
  ): Promise<{ slotId: string }> {
    const st = this.data.stables[userId];
    if (!st) throw new Error("no stable — pick a handle first");
    if (slotIdx < 0 || slotIdx >= CONFIG.maxSlots) throw new Error(`slot out of range 0..${CONFIG.maxSlots - 1}`);

    // Validate the config parses (throws on DSL error)
    compileBrain(config);

    const now = Date.now();
    const existing = st.slots[slotIdx];
    const lockedUntil = existing ? effectiveRateLockedUntil(existing) : 0;
    if (lockedUntil > now) {
      const wait = Math.ceil((lockedUntil - now) / 1000 / 60);
      throw new Error(`rate limited — try again in ${wait} min`);
    }

    const unlockElo = slotUnlockElo(existing);
    const slotCos = normalizeSlotCosmetics(
      cosmetics,
      slotIdx,
      existing ? slotCosmetics(existing, slotIdx) : defaultSlotCosmetics(slotIdx),
      unlockElo,
    );
    assertUniqueBodyInStable(st, slotIdx, slotCos);
    const slotId = existing?.slotId ?? crypto.randomBytes(8).toString("hex");
    const slot: Slot = {
      slotId,
      config,
      name: nextSlotName(name, existing?.name),
      cosmetics: slotCos,
      submittedAt: now,
      rateLockedUntil: now + CONFIG.submitRateMs,
      elo: existing?.elo ?? CONFIG.eloAnchor,
      peakElo: unlockElo,
      wins: existing?.wins ?? 0,
      losses: existing?.losses ?? 0,
      draws: existing?.draws ?? 0,
      lastPlayedAt: existing?.lastPlayedAt ?? 0,
    };
    st.slots[slotIdx] = slot;
    normalizeStableSlotCosmetics(st);
    st.updatedAt = now;
    this.flush();
    return { slotId };
  }

  async listActive(sinceMs: number): Promise<Stable[]> {
    const cutoff = Date.now() - sinceMs;
    return Object.values(this.data.stables).filter((st) =>
      activeRosterSlots(st.slots).some((s) => s.submittedAt >= cutoff || s.lastPlayedAt >= cutoff),
    );
  }

  async updateAfterMatch(res: MatchUpdate): Promise<void> {
    const a = this.data.stables[res.aUserId];
    const b = this.data.stables[res.bUserId];
    if (!a || !b) return;
    const sa = a.slots.find((s) => s.slotId === res.aSlotId);
    const sb = b.slots.find((s) => s.slotId === res.bSlotId);
    if (!sa || !sb) return;
    sa.elo = res.aEloAfter;
    sb.elo = res.bEloAfter;
    sa.peakElo = Math.max(slotUnlockElo(sa), res.aEloAfter);
    sb.peakElo = Math.max(slotUnlockElo(sb), res.bEloAfter);
    sa.lastPlayedAt = sb.lastPlayedAt = res.playedAt;
    if (res.winner === 0) { sa.wins++; sb.losses++; }
    else if (res.winner === 1) { sb.wins++; sa.losses++; }
    else { sa.draws++; sb.draws++; }
    a.updatedAt = b.updatedAt = res.playedAt;
    this.flush();
  }

  async archiveReplay(artifact: ReplayArtifactV1): Promise<void> {
    this.data.replays[artifact.match.matchId] = artifact;
    try {
      this.data.publicReplayArtifacts[artifact.match.matchId] = publicReplayArtifactFromReplay(artifact);
    } catch (e) {
      console.error("[public-artifacts] export failed:", e instanceof Error ? e.message : String(e));
    }
    this.trimReplayArchive();
    this.flush();
  }

  async getReplay(matchId: string): Promise<ReplayArtifactV1 | null> {
    return this.data.replays[matchId] ?? null;
  }

  async getPublicReplayArtifact(matchId: string): Promise<PublicReplayArtifactV1 | null> {
    return this.data.publicReplayArtifacts[matchId]
      ?? (this.data.replays[matchId] ? publicReplayArtifactFromReplay(this.data.replays[matchId]) : null);
  }

  async applyDecay(): Promise<number> {
    let count = 0;
    const alpha = 1 - CONFIG.eloDecayPerWeek;
    for (const st of Object.values(this.data.stables)) {
      for (const s of activeRosterSlots(st.slots)) {
        s.elo = Math.round(s.elo * alpha + CONFIG.eloAnchor * CONFIG.eloDecayPerWeek);
        count++;
      }
    }
    this.flush();
    return count;
  }

  private trimReplayArchive(): void {
    const limit = Math.max(0, CONFIG.replayArchiveLimit);
    const entries = Object.entries(this.data.replays);
    if (entries.length <= limit) return;
    entries
      .sort(([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(limit)
      .forEach(([matchId]) => {
        delete this.data.replays[matchId];
        delete this.data.publicReplayArtifacts[matchId];
      });
  }
}

function isRosterBodyId(value: unknown): value is RosterBodyId {
  return typeof value === "string" && (ROSTER_BODY_IDS as readonly string[]).includes(value);
}

function weaponEntriesForBody(body: RosterBodyId): readonly RosterWeaponEntry[] {
  return rosterCatalog.weapons[body];
}

function firstAvailableWeapon(body: RosterBodyId): RosterWeaponId {
  const weapon = weaponEntriesForBody(body).find((entry) => entry.available)?.id;
  if (!weapon) throw new Error(`no available weapons for ${body}`);
  return weapon;
}

function weaponBelongsToBody(body: RosterBodyId, value: unknown, unlockElo: number): value is RosterWeaponId {
  return typeof value === "string" && weaponEntriesForBody(body).some((entry) =>
    entry.id === value &&
    entry.available &&
    unlockElo >= Number(entry.minElo ?? 0)
  );
}
