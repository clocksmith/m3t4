import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type DocumentData, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import crypto from "node:crypto";
import { compileBrain, STRATEGIES, type BrainConfig, type ReplayArtifactV1 } from "@m3t4/sim";
import { CONFIG } from "./config.js";
import {
  activeRosterSlots,
  assertUniqueBodyInStable,
  computeAggregate,
  defaultSlotCosmetics,
  effectiveRateLockedUntil,
  nextSlotName,
  normalizeSlotCosmetics,
  normalizeStableSlotCosmetics,
  slotCosmetics,
  slotUnlockElo,
  stablePublic,
  summarizePublicReplayArtifact,
  type MatchUpdate,
  type PublicReplayArtifactSummary,
  type Slot,
  type SlotCosmeticsInput,
  type Stable,
  type StablePublic,
  type StableStore,
} from "./stable.js";
import { publicReplayArtifactFromReplay, type PublicReplayArtifactV1 } from "./public-artifacts.js";

interface HandleDoc {
  handle: string;
  userId: string;
  updatedAt: number;
}

const FIRESTORE_COLLECTIONS = {
  stables: "stables",
  handles: "handles",
  publicStables: "publicStables",
  replays: "replays",
  publicReplayArtifacts: "publicReplayArtifacts",
} as const;

let configuredDb: Firestore | null = null;

function db(): Firestore {
  if (configuredDb) return configuredDb;
  if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
  configuredDb = getFirestore();
  configuredDb.settings({ ignoreUndefinedProperties: true });
  return configuredDb;
}

export class FirestoreStableStore implements StableStore {
  private readonly db: Firestore;
  private readonly ready: Promise<void>;

  constructor(database: Firestore = db()) {
    this.db = database;
    this.ready = this.seedSystemPhantoms();
  }

  async getStable(userId: string): Promise<Stable | null> {
    await this.ready;
    const snap = await this.stableRef(userId).get();
    return snap.exists ? (snap.data() as Stable) : null;
  }

  async handleTaken(handle: string, excludeUid?: string): Promise<boolean> {
    await this.ready;
    const clean = normalizeHandle(handle);
    const snap = await this.handleRef(clean).get();
    if (!snap.exists) return false;
    const data = snap.data() as HandleDoc;
    return data.userId !== excludeUid;
  }

  async upsertHandle(userId: string, handle: string): Promise<Stable> {
    await this.ready;
    const clean = normalizeHandle(handle);
    return this.db.runTransaction(async (tx) => {
      const stableRef = this.stableRef(userId);
      const newHandleRef = this.handleRef(clean);
      const stableSnap = await tx.get(stableRef);
      const handleSnap = await tx.get(newHandleRef);

      const owner = handleSnap.exists ? (handleSnap.data() as HandleDoc).userId : null;
      if (owner && owner !== userId) throw new Error("handle taken");

      let st: Stable;
      if (stableSnap.exists) {
        st = stableSnap.data() as Stable;
        if (st.handle !== clean) tx.delete(this.handleRef(st.handle));
        st.handle = clean;
        st.updatedAt = Date.now();
      } else {
        const now = Date.now();
        st = {
          userId,
          handle: clean,
          slots: [],
          createdAt: now,
          updatedAt: now,
        };
      }

      tx.set(newHandleRef, { handle: clean, userId, updatedAt: Date.now() } satisfies HandleDoc);
      this.writeStable(tx, st);
      return st;
    });
  }

  async submitToSlot(
    userId: string,
    slotIdx: number,
    config: BrainConfig,
    name?: string,
    cosmetics?: SlotCosmeticsInput,
  ): Promise<{ slotId: string }> {
    await this.ready;
    if (slotIdx < 0 || slotIdx >= CONFIG.maxSlots) throw new Error(`slot out of range 0..${CONFIG.maxSlots - 1}`);
    compileBrain(config);

    return this.db.runTransaction(async (tx) => {
      const ref = this.stableRef(userId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("no stable — pick a handle first");

      const st = snap.data() as Stable;
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
      const slotId = existing?.slotId ?? randomId();
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
      this.writeStable(tx, st);
      return { slotId };
    });
  }

  async listActive(sinceMs: number): Promise<Stable[]> {
    await this.ready;
    const cutoff = Date.now() - sinceMs;
    const snap = await this.db.collection(FIRESTORE_COLLECTIONS.stables).get();
    return snap.docs
      .map((doc) => doc.data() as Stable)
      .filter((st) => activeRosterSlots(st.slots).some((s) => s.submittedAt >= cutoff || s.lastPlayedAt >= cutoff));
  }

  async updateAfterMatch(res: MatchUpdate): Promise<void> {
    await this.ready;
    await this.db.runTransaction(async (tx) => {
      const refs = new Map<string, ReturnType<FirestoreStableStore["stableRef"]>>();
      refs.set(res.aUserId, this.stableRef(res.aUserId));
      refs.set(res.bUserId, this.stableRef(res.bUserId));

      const loaded = new Map<string, Stable>();
      for (const [uid, ref] of refs) {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        loaded.set(uid, snap.data() as Stable);
      }

      const a = loaded.get(res.aUserId);
      const b = loaded.get(res.bUserId);
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

      for (const st of loaded.values()) this.writeStable(tx, st);
    });
  }

  async archiveReplay(artifact: ReplayArtifactV1): Promise<void> {
    await this.ready;
    await this.replayRef(artifact.match.matchId).set(stripUndefined(artifact));
    try {
      await this.publicReplayArtifactRef(artifact.match.matchId).set(stripUndefined(publicReplayArtifactFromReplay(artifact)));
    } catch (e) {
      console.error("[public-artifacts] export failed:", e instanceof Error ? e.message : String(e));
    }
    await this.trimReplayArchive();
  }

  async getReplay(matchId: string): Promise<ReplayArtifactV1 | null> {
    await this.ready;
    const snap = await this.replayRef(matchId).get();
    return snap.exists ? (snap.data() as ReplayArtifactV1) : null;
  }

  async getPublicReplayArtifact(matchId: string): Promise<PublicReplayArtifactV1 | null> {
    await this.ready;
    const snap = await this.publicReplayArtifactRef(matchId).get();
    if (snap.exists) return snap.data() as PublicReplayArtifactV1;
    const replay = await this.getReplay(matchId);
    return replay ? publicReplayArtifactFromReplay(replay) : null;
  }

  async listPublicReplayArtifactSummaries(
    options: { limit?: number } = {},
  ): Promise<PublicReplayArtifactSummary[]> {
    await this.ready;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const snap = await this.db
      .collection(FIRESTORE_COLLECTIONS.publicReplayArtifacts)
      .orderBy("exportedAt", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((doc) => summarizePublicReplayArtifact(doc.data() as PublicReplayArtifactV1));
  }

  async applyDecay(): Promise<number> {
    await this.ready;
    const snap = await this.db.collection(FIRESTORE_COLLECTIONS.stables).get();
    let count = 0;
    let batch = this.db.batch();
    let ops = 0;
    const alpha = 1 - CONFIG.eloDecayPerWeek;

    for (const doc of snap.docs) {
      const st = doc.data() as Stable;
      for (const s of activeRosterSlots(st.slots)) {
        s.elo = Math.round(s.elo * alpha + CONFIG.eloAnchor * CONFIG.eloDecayPerWeek);
        count++;
      }
      this.writeStable(batch, st);
      ops += 2;
      if (ops >= 450) {
        await batch.commit();
        batch = this.db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    return count;
  }

  private async seedSystemPhantoms(): Promise<void> {
    const batch = this.db.batch();
    let ops = 0;
    const now = Date.now();
    let cosmeticIdx = 0;
    for (const [name, cfg] of Object.entries(STRATEGIES)) {
      const seededCosmetics = defaultSlotCosmetics(cosmeticIdx++);
      const uid = `system:${name}`;
      const ref = this.stableRef(uid);
      const snap = await ref.get();
      let st: Stable;
      if (snap.exists) {
        st = snap.data() as Stable;
        const slot = st.slots[0];
        if (slot) {
          slot.config = cfg;
          slot.name = name;
          slot.rateLockedUntil = 0;
          slot.peakElo = Math.max(slotUnlockElo(slot), slot.elo);
          slot.cosmetics = normalizeSlotCosmetics(slot.cosmetics, 0, seededCosmetics);
        }
        st.handle = `sys_${name}`;
        st.updatedAt = now;
      } else {
        st = {
          userId: uid,
          handle: `sys_${name}`,
          slots: [{
            slotId: `sys-${name}`,
            config: cfg,
            name,
            cosmetics: seededCosmetics,
            submittedAt: now,
            rateLockedUntil: 0,
            elo: CONFIG.eloAnchor,
            peakElo: CONFIG.eloAnchor,
            wins: 0,
            losses: 0,
            draws: 0,
            lastPlayedAt: now,
          }],
          createdAt: now,
          updatedAt: now,
        };
      }
      this.writeStable(batch, st);
      batch.set(this.handleRef(`sys_${name}`), { handle: `sys_${name}`, userId: uid, updatedAt: now } satisfies HandleDoc);
      ops += 3;
    }
    if (ops > 0) await batch.commit();
  }

  private async trimReplayArchive(): Promise<void> {
    const limit = Math.max(0, CONFIG.replayArchiveLimit);
    if (limit === 0) return;
    const old = await this.db.collection(FIRESTORE_COLLECTIONS.replays)
      .orderBy("createdAt", "desc")
      .offset(limit)
      .limit(100)
      .get();
    if (old.empty) return;
    const batch = this.db.batch();
    for (const doc of old.docs) {
      batch.delete(doc.ref);
      batch.delete(this.publicReplayArtifactRef(doc.id));
    }
    await batch.commit();
  }

  private stableRef(userId: string) {
    return this.db.collection(FIRESTORE_COLLECTIONS.stables).doc(userId);
  }

  private handleRef(handle: string) {
    return this.db.collection(FIRESTORE_COLLECTIONS.handles).doc(handle);
  }

  private publicStableRef(userId: string) {
    return this.db.collection(FIRESTORE_COLLECTIONS.publicStables).doc(userId);
  }

  private replayRef(matchId: string) {
    return this.db.collection(FIRESTORE_COLLECTIONS.replays).doc(matchId);
  }

  private publicReplayArtifactRef(matchId: string) {
    return this.db.collection(FIRESTORE_COLLECTIONS.publicReplayArtifacts).doc(matchId);
  }

  private writeStable(writer: { set: (ref: DocumentReference, data: DocumentData) => unknown }, st: Stable): void {
    normalizeStableSlotCosmetics(st);
    const activeSlots = activeRosterSlots(st.slots);
    writer.set(this.stableRef(st.userId), stripUndefined(st));
    writer.set(this.publicStableRef(st.userId), stripUndefined({
      ...stablePublic(st),
      slotCount: activeSlots.length,
      updatedAt: st.updatedAt,
      activeSlotIds: activeSlots.map((s) => s.slotId),
      eloAggregate: computeAggregate(activeSlots),
    } satisfies StablePublic & { slotCount: number; updatedAt: number; activeSlotIds: string[] }));
  }
}

function normalizeHandle(handle: string): string {
  const clean = handle.toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
    throw new Error("handle must be 3-20 chars, a-z 0-9 _");
  }
  return clean;
}

function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = stripUndefined(v);
  }
  return out as T;
}
