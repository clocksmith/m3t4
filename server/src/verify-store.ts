// Persistent state for optional verification surfaces.
//
// Single JSON file, sync read/write on mutations (mirrors the pattern
// in stable.ts — good enough for dev/small deployments; production
// swaps for Firestore or equivalent). Runtime wiring should instantiate
// separate stores per authority surface (duel/community/proof) even though
// this dev implementation can back each with the same schema.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------- schemas ----------------------------

export interface DuelChallengeRec {
  challengeId: string;
  fromUid: string;
  toUid: string;
  stageId: string;
  createdAt: string;
  expiresAt: string;
  token?: SignedMatchTokenRec;
  submitted?: boolean;
}

export interface SignedMatchTokenRec {
  matchId: string;
  playerIds: [string, string];
  stageId: string;
  seed: number;
  simConstantsHash: string;
  issuedAt: string;
  expiresAt: string;
  stateHashCadenceTicks: number;
  maxTicks?: number;
  signature: string;
}

export interface SignalSlotRec {
  matchId: string;
  offer?: { sdp: string; fromPlayerId: string; postedAt: string };
  answer?: { sdp: string; fromPlayerId: string; postedAt: string };
  iceCandidates: Array<{ fromPlayerId: string; candidate: unknown; postedAt: string }>;
  createdAt: string;
}

export interface CommunityWorkerRec {
  workerId: string;
  label?: string;
  sharedSecret: string;
  registeredAt: string;
  delisted?: boolean;
  disagreementCount: number;
}

export interface CommunityAttestationRec {
  matchId: string;
  workerId: string;
  computedLogHash?: string;
  computedActionSha256?: string;
  agreed: boolean;
  postedAt: string;
}

export interface CommitmentRec {
  commitmentId: string;
  uid: string;
  commitmentHash: string;
  createdAt: string;
  revealedAt?: string;  // present once revealed
  // Intentionally not persisting the revealed config/salt — those are
  // passed through to replay archives and don't need to live here.
}

export interface AttestedAgentKeyRec {
  uid: string;
  publicKeyPem: string;
  runtimeVersionsAllowed: string[];
  registeredAt: string;
}

interface VerifyStoreData {
  duelChallenges: Record<string, DuelChallengeRec>;
  signalSlots: Record<string, SignalSlotRec>;
  communityWorkers: Record<string, CommunityWorkerRec>;
  communityAttestations: Record<string, CommunityAttestationRec[]>; // keyed by matchId
  commitments: Record<string, CommitmentRec>;
  attestedKeys: Record<string, AttestedAgentKeyRec>;                 // keyed by uid
}

const EMPTY: VerifyStoreData = {
  duelChallenges: {},
  signalSlots: {},
  communityWorkers: {},
  communityAttestations: {},
  commitments: {},
  attestedKeys: {},
};

// ---------------------------- store ----------------------------

export class VerifyStore {
  private data: VerifyStoreData;
  constructor(private readonly filePath: string) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        this.data = { ...EMPTY, ...raw };
        // Defensive: ensure sub-objects exist.
        for (const k of Object.keys(EMPTY) as (keyof VerifyStoreData)[]) {
          if (!this.data[k]) (this.data as any)[k] = (EMPTY as any)[k];
        }
      } catch {
        this.data = structuredClone(EMPTY);
      }
    } else {
      this.data = structuredClone(EMPTY);
      this.flush();
    }
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // ---- duel challenges ----

  createChallenge(rec: DuelChallengeRec): void {
    this.data.duelChallenges[rec.challengeId] = rec;
    this.flush();
  }
  getChallenge(id: string): DuelChallengeRec | undefined {
    return this.data.duelChallenges[id];
  }
  updateChallenge(id: string, patch: Partial<DuelChallengeRec>): void {
    const existing = this.data.duelChallenges[id];
    if (!existing) return;
    this.data.duelChallenges[id] = { ...existing, ...patch };
    this.flush();
  }
  deleteChallenge(id: string): void {
    delete this.data.duelChallenges[id];
    this.flush();
  }

  // ---- signal slots ----

  ensureSignalSlot(matchId: string): SignalSlotRec {
    if (!this.data.signalSlots[matchId]) {
      this.data.signalSlots[matchId] = {
        matchId,
        iceCandidates: [],
        createdAt: new Date().toISOString(),
      };
      this.flush();
    }
    return this.data.signalSlots[matchId];
  }
  getSignalSlot(matchId: string): SignalSlotRec | undefined {
    return this.data.signalSlots[matchId];
  }
  updateSignalSlot(matchId: string, patch: Partial<SignalSlotRec>): void {
    const existing = this.data.signalSlots[matchId];
    if (!existing) return;
    this.data.signalSlots[matchId] = { ...existing, ...patch };
    this.flush();
  }
  addIceCandidate(matchId: string, entry: SignalSlotRec["iceCandidates"][number]): void {
    const slot = this.ensureSignalSlot(matchId);
    slot.iceCandidates.push(entry);
    this.flush();
  }
  sweepSignalSlots(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    let changed = false;
    for (const id of Object.keys(this.data.signalSlots)) {
      if (new Date(this.data.signalSlots[id].createdAt).getTime() < cutoff) {
        delete this.data.signalSlots[id];
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  // ---- community workers ----

  registerWorker(rec: CommunityWorkerRec): void {
    this.data.communityWorkers[rec.workerId] = rec;
    this.flush();
  }
  getWorker(id: string): CommunityWorkerRec | undefined {
    return this.data.communityWorkers[id];
  }
  updateWorker(id: string, patch: Partial<CommunityWorkerRec>): void {
    const existing = this.data.communityWorkers[id];
    if (!existing) return;
    this.data.communityWorkers[id] = { ...existing, ...patch };
    this.flush();
  }

  // ---- community attestations ----

  upsertAttestation(rec: CommunityAttestationRec): CommunityAttestationRec[] {
    const list = this.data.communityAttestations[rec.matchId] ?? [];
    const idx = list.findIndex((a) => a.workerId === rec.workerId);
    if (idx >= 0) list[idx] = rec;
    else list.push(rec);
    this.data.communityAttestations[rec.matchId] = list;
    this.flush();
    return list;
  }
  getAttestations(matchId: string): CommunityAttestationRec[] {
    return this.data.communityAttestations[matchId] ?? [];
  }

  // ---- commitments (L1) ----

  createCommitment(rec: CommitmentRec): void {
    this.data.commitments[rec.commitmentId] = rec;
    this.flush();
  }
  getCommitment(id: string): CommitmentRec | undefined {
    return this.data.commitments[id];
  }
  markCommitmentRevealed(id: string, revealedAt: string): void {
    const existing = this.data.commitments[id];
    if (!existing) return;
    this.data.commitments[id] = { ...existing, revealedAt };
    this.flush();
  }

  // ---- attested keys (L2) ----

  setAttestedKey(rec: AttestedAgentKeyRec): void {
    this.data.attestedKeys[rec.uid] = rec;
    this.flush();
  }
  getAttestedKey(uid: string): AttestedAgentKeyRec | undefined {
    return this.data.attestedKeys[uid];
  }
}

export type VerifyStoreSurface = "verify" | "duel" | "community" | "proof";

const SURFACE_ENV: Record<VerifyStoreSurface, string> = {
  verify: "VERIFY_STORE_PATH",
  duel: "DUEL_STORE_PATH",
  community: "COMMUNITY_VERIFY_STORE_PATH",
  proof: "PROOF_STORE_PATH",
};

// Default store path. Tests can construct their own with a temp file.
export function defaultVerifyStorePath(surface: VerifyStoreSurface = "verify"): string {
  const specific = process.env[SURFACE_ENV[surface]];
  if (specific) return specific;
  if (surface !== "verify" && process.env.VERIFY_STORE_PATH) return process.env.VERIFY_STORE_PATH;
  const filename = surface === "verify" ? "verify.json" : `${surface}.json`;
  return path.join(__dirname, "..", "data", filename);
}
