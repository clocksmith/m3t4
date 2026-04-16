// Stable data model + storage interface. Implementations can be swapped
// (file-backed for dev, Firestore for production) without touching callers.
//
// Privacy rule: getPublic* methods NEVER return `config.attributes`. Internal
// methods used by the matchmaker + sim runner have full access.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { compileBrain, STRATEGIES, type BrainConfig } from "@m3t4/sim";
import { CONFIG } from "./config.js";

// System user — owner of phantom seed bots (the 16 named strategies).
// Ensures the firehose has opponents before real users sign up, and
// provides a "floor" meta that new users can beat their way past.
const SYSTEM_UID = "system";

export interface Slot {
  slotId: string;
  config: BrainConfig;        // PRIVATE — never served to clients
  name: string;               // user-given nickname, public
  submittedAt: number;
  rateLockedUntil: number;
  elo: number;
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
  slotId: string;
  name: string;
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

export function stablePublic(st: Stable): StablePublic {
  const wins = st.slots.reduce((s, x) => s + x.wins, 0);
  const losses = st.slots.reduce((s, x) => s + x.losses, 0);
  return {
    userId: st.userId,
    handle: st.handle,
    eloAggregate: computeAggregate(st.slots),
    wins,
    losses,
    slots: st.slots.map((s) => ({
      slotId: s.slotId,
      name: s.name,
      elo: s.elo,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      lastPlayedAt: s.lastPlayedAt,
    })),
  };
}

// ---------- Abstract interface ----------

export interface StableStore {
  getStable(userId: string): Promise<Stable | null>;
  upsertHandle(userId: string, handle: string): Promise<Stable>;
  submitToSlot(userId: string, slotIdx: number, config: BrainConfig, name?: string): Promise<{ slotId: string }>;
  listActive(sinceMs: number): Promise<Stable[]>;
  updateAfterMatch(res: MatchUpdate): Promise<void>;
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
  version: number;
}

export class FileStableStore implements StableStore {
  private path: string;
  private data: StoreData;

  constructor(storePath: string) {
    this.path = storePath;
    if (fs.existsSync(storePath)) {
      this.data = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } else {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      this.data = { stables: {}, handles: {}, version: 1 };
    }
    this.seedSystemPhantoms();
    this.flush();
  }

  // Seed each of the 16 named strategies as its own virtual stable, so
  // each phantom is an independent participant in the matchmaking pool.
  // Idempotent: preserves ELO/W-L on existing phantoms, refreshes strategy
  // configs after rebalance patches, and adds any newly-added strategies.
  private seedSystemPhantoms(): void {
    for (const [name, cfg] of Object.entries(STRATEGIES)) {
      const uid = `system:${name}`;
      const existing = this.data.stables[uid];
      if (existing) {
        const slot = existing.slots[0];
        if (slot) {
          slot.config = cfg;
          slot.name = name;
          slot.rateLockedUntil = 0;
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
            submittedAt: now,
            rateLockedUntil: 0, // phantoms can't be rate-limited
            elo: CONFIG.eloAnchor,
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

  async submitToSlot(userId: string, slotIdx: number, config: BrainConfig, name?: string): Promise<{ slotId: string }> {
    const st = this.data.stables[userId];
    if (!st) throw new Error("no stable — pick a handle first");
    if (slotIdx < 0 || slotIdx >= CONFIG.maxSlots) throw new Error(`slot out of range 0..${CONFIG.maxSlots - 1}`);

    // Validate the config parses (throws on DSL error)
    compileBrain(config);

    const now = Date.now();
    const existing = st.slots[slotIdx];
    if (existing && existing.rateLockedUntil > now) {
      const wait = Math.ceil((existing.rateLockedUntil - now) / 1000 / 60);
      throw new Error(`rate limited — try again in ${wait} min`);
    }

    const slotId = existing?.slotId ?? crypto.randomBytes(8).toString("hex");
    const slot: Slot = {
      slotId,
      config,
      name: name ?? existing?.name ?? `slot-${slotIdx + 1}`,
      submittedAt: now,
      rateLockedUntil: now + CONFIG.submitRateMs,
      elo: existing?.elo ?? CONFIG.eloAnchor,
      wins: existing?.wins ?? 0,
      losses: existing?.losses ?? 0,
      draws: existing?.draws ?? 0,
      lastPlayedAt: existing?.lastPlayedAt ?? 0,
    };
    st.slots[slotIdx] = slot;
    st.updatedAt = now;
    this.flush();
    return { slotId };
  }

  async listActive(sinceMs: number): Promise<Stable[]> {
    const cutoff = Date.now() - sinceMs;
    return Object.values(this.data.stables).filter((st) =>
      st.slots.some((s) => s.submittedAt >= cutoff || s.lastPlayedAt >= cutoff),
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
    sa.lastPlayedAt = sb.lastPlayedAt = res.playedAt;
    if (res.winner === 0) { sa.wins++; sb.losses++; }
    else if (res.winner === 1) { sb.wins++; sa.losses++; }
    else { sa.draws++; sb.draws++; }
    a.updatedAt = b.updatedAt = res.playedAt;
    this.flush();
  }

  async applyDecay(): Promise<number> {
    let count = 0;
    const alpha = 1 - CONFIG.eloDecayPerWeek;
    for (const st of Object.values(this.data.stables)) {
      for (const s of st.slots) {
        s.elo = Math.round(s.elo * alpha + CONFIG.eloAnchor * CONFIG.eloDecayPerWeek);
        count++;
      }
    }
    this.flush();
    return count;
  }
}
