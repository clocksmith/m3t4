// Server routes implementing ARCHITECTURE.md's verify/spectate/duel
// surface. Kept in a single file so the handler set is easy to audit.

import http from "node:http";
import crypto from "node:crypto";
import {
  BEHAVIOR_VERSION,
  REPLAY_CONSTANTS_HASH,
  STAGES,
  type Stage,
  type TrustLabel,
  verifyActionLog,
} from "@m3t4/sim";
import type { StableStore } from "./stable.js";

// ---------------------------- helpers ----------------------------

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody<T = unknown>(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : ({} as T)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Match tokens are HMAC-signed by the server so peers cannot forge them.
// The secret is derived from env (rotate on deploy). For dev/test, a
// stable but non-production default is used — never ship this default.
const TOKEN_SECRET: string =
  process.env.M3T4_MATCH_TOKEN_SECRET
  ?? "dev-only-m3t4-match-token-secret-replace-in-prod";

function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
}

function hmacVerify(payload: string, signature: string): boolean {
  const want = Buffer.from(hmacSign(payload), "hex");
  const got = Buffer.from(signature, "hex");
  if (want.length !== got.length) return false;
  return crypto.timingSafeEqual(want, got);
}

// ---------------------------- verify/replay ----------------------------

// POST /api/verify/replay
//
// Body: {
//   seed: number,
//   stageId: string,
//   actionLogB64: string,            // base64 of packed action bytes
//   expectedLogHash?: string,        // optional — enforces exact match
//   expectedResult?: { winner, finalScore, finalRounds, ticks, logHash }
// }
//
// Response (200): { ok, result, simConstantsHash, behaviorVersion }
// Response (4xx): { ok:false, reason }
//
// This is the canonical "replay an action log and tell me what happened"
// endpoint. Used by the P2P duel finalization flow, by community
// verification workers checking their results match, and by anyone who
// wants to independently audit a claimed outcome.
export async function handleVerifyReplay(
  req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const { seed, stageId, actionLogB64, expectedLogHash, expectedResult } = body ?? {};
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    return json(res, 400, { ok: false, reason: "seed must be a number" });
  }
  if (typeof stageId !== "string" || !(stageId in STAGES)) {
    return json(res, 400, { ok: false, reason: "unknown stageId" });
  }
  if (typeof actionLogB64 !== "string") {
    return json(res, 400, { ok: false, reason: "actionLogB64 required" });
  }
  let actionLog: Uint8Array;
  try { actionLog = base64ToBytes(actionLogB64); }
  catch { return json(res, 400, { ok: false, reason: "actionLogB64 malformed" }); }
  if (actionLog.length % 2 !== 0) {
    return json(res, 400, { ok: false, reason: "actionLog must be paired bytes" });
  }

  const stage: Stage = STAGES[stageId as keyof typeof STAGES];
  const out = verifyActionLog({
    seed: seed >>> 0,
    stage,
    chars: (await import("@m3t4/sim")).DEFAULT_CHARS,
    actionLog,
    expectedLogHash: typeof expectedLogHash === "string" ? expectedLogHash : undefined,
    expectedResult,
  });
  return json(res, 200, out);
}

// ---------------------------- spectate/tuple ----------------------------

// GET /api/spectate/tuple/:matchId
//
// Returns the minimum data needed for a client to re-simulate the match
// locally: seed, stageId, public player refs, expected logHash, trust
// label. Only public ref fields are echoed — private configs never
// leave the server this way. For the "tuple" model to be useful, both
// players must be reproducible from public refs (e.g. named presets).
// Ranked matches with private player configs will include configs only
// if the caller is authorized (same uid as player) — not implemented at
// this scaffold.
export async function handleSpectateTuple(
  store: StableStore, matchId: string, _req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  const replay = await store.getReplay(matchId);
  if (!replay) return json(res, 404, { error: "replay not found" });

  const publicPlayers = replay.players.map((p) => ({
    side: p.side,
    kind: p.kind,
    label: p.label,
    tier: p.tier,
    slotName: p.slotName,
    configHash: p.configHash,
    // NOTE: p.config intentionally omitted. Public tuple spectating only
    // works when the viewer has an independent source for the config
    // (e.g. named preset). Private ranked configs stay on the server.
  }));

  return json(res, 200, {
    matchId,
    seed: replay.match.seed,
    stageId: replay.match.stageId,
    players: publicPlayers,
    expectedLogHash: replay.result.logHash,
    expectedResult: replay.result,
    trust: replay.trust,
    simConstantsHash: replay.sim.constantsHash ?? REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
  });
}

// ---------------------------- duel/* (scaffold) ----------------------------
//
// Match tokens are the cryptographic coupon that lets two peers run an
// exhibition duel and later submit a signed action log for server
// verification. The server issues the token on /api/duel/accept and
// checks the HMAC on /api/duel/submit. WebRTC rendezvous is out of scope
// for this scaffold — a minimal polling endpoint is stubbed instead.

export interface MatchTokenPayload {
  matchId: string;
  playerIds: [string, string];
  stageId: string;
  seed: number;
  simConstantsHash: string;
  issuedAt: string;
  expiresAt: string;
  stateHashCadenceTicks: number;
}

export interface SignedMatchToken extends MatchTokenPayload {
  signature: string;
}

function issueMatchToken(payload: MatchTokenPayload): SignedMatchToken {
  const signature = hmacSign(JSON.stringify(payload));
  return { ...payload, signature };
}

function verifyMatchToken(token: SignedMatchToken): boolean {
  const { signature, ...payload } = token;
  return hmacVerify(JSON.stringify(payload), signature);
}

// In-memory challenge state — scaffold only; replace with store-backed
// queue for production. Duel lifetime: pending → accepted → submitted.
interface DuelChallenge {
  challengeId: string;
  fromUid: string;
  toUid: string;
  stageId: string;
  createdAt: string;
  expiresAt: string;
  token?: SignedMatchToken;
  submitted?: boolean;
}
const duelChallenges = new Map<string, DuelChallenge>();

// POST /api/duel/challenge  { toUid, stageId? }
export async function handleDuelChallenge(
  req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  // TODO auth: extract fromUid from bearer token; for scaffold, accept any.
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const fromUid = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "").trim() || "dev-user";
  const { toUid, stageId = "datacenter" } = body ?? {};
  if (typeof toUid !== "string" || !toUid) {
    return json(res, 400, { ok: false, reason: "toUid required" });
  }
  if (!(stageId in STAGES)) {
    return json(res, 400, { ok: false, reason: "unknown stageId" });
  }

  const challengeId = crypto.randomBytes(12).toString("hex");
  const now = new Date();
  const exp = new Date(now.getTime() + 5 * 60 * 1000); // 5 min
  const ch: DuelChallenge = {
    challengeId, fromUid, toUid, stageId,
    createdAt: now.toISOString(),
    expiresAt: exp.toISOString(),
  };
  duelChallenges.set(challengeId, ch);
  return json(res, 200, { challengeId, expiresAt: ch.expiresAt });
}

// POST /api/duel/accept  { challengeId }
export async function handleDuelAccept(
  req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }
  const { challengeId } = body ?? {};
  const ch = typeof challengeId === "string" ? duelChallenges.get(challengeId) : null;
  if (!ch) return json(res, 404, { ok: false, reason: "challenge not found" });
  if (new Date(ch.expiresAt) < new Date()) {
    duelChallenges.delete(challengeId);
    return json(res, 410, { ok: false, reason: "challenge expired" });
  }
  if (ch.token) {
    return json(res, 200, { token: ch.token }); // idempotent
  }

  const matchId = crypto.randomBytes(12).toString("hex");
  const seed = crypto.randomBytes(4).readUInt32BE(0); // fresh server-issued seed
  const now = new Date();
  const exp = new Date(now.getTime() + 10 * 60 * 1000); // 10 min validity

  const token = issueMatchToken({
    matchId,
    playerIds: [ch.fromUid, ch.toUid],
    stageId: ch.stageId,
    seed,
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    issuedAt: now.toISOString(),
    expiresAt: exp.toISOString(),
    stateHashCadenceTicks: 120,
  });
  ch.token = token;
  return json(res, 200, { token });
}

// POST /api/duel/submit
// Body: {
//   token: SignedMatchToken,
//   actionLogB64: string,
//   result: { winner, finalScore, finalRounds, ticks, logHash },
//   peerSignatures: [string, string],  // session-key signatures over actionLogHash
// }
//
// Server verifies the token, re-simulates the action log under the
// pinned seed/stage, and accepts iff the result matches. Archives a
// ReplayArtifactV1 with tier=p2p-action-verified on success.
export async function handleDuelSubmit(
  store: StableStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }
  const { token, actionLogB64, result, peerSignatures } = body ?? {};
  if (!token || typeof token !== "object") {
    return json(res, 400, { ok: false, reason: "token required" });
  }
  if (!verifyMatchToken(token as SignedMatchToken)) {
    return json(res, 400, { ok: false, reason: "token signature invalid" });
  }
  const t = token as SignedMatchToken;
  if (new Date(t.expiresAt) < new Date()) {
    return json(res, 410, { ok: false, reason: "token expired" });
  }
  if (t.simConstantsHash !== REPLAY_CONSTANTS_HASH) {
    return json(res, 409, { ok: false, reason: "token sim version mismatch" });
  }
  if (typeof actionLogB64 !== "string") {
    return json(res, 400, { ok: false, reason: "actionLogB64 required" });
  }
  let actionLog: Uint8Array;
  try { actionLog = base64ToBytes(actionLogB64); }
  catch { return json(res, 400, { ok: false, reason: "actionLogB64 malformed" }); }

  const sim = await import("@m3t4/sim");
  const stage = STAGES[t.stageId as keyof typeof STAGES];
  if (!stage) return json(res, 400, { ok: false, reason: "unknown stageId" });

  const out = verifyActionLog({
    seed: t.seed,
    stage,
    chars: sim.DEFAULT_CHARS,
    actionLog,
    expectedLogHash: typeof result?.logHash === "string" ? result.logHash : undefined,
    expectedResult: result,
  });

  if (!out.ok) {
    return json(res, 400, { ok: false, reason: out.reason, serverResult: out.result });
  }

  // Build + archive the replay artifact with p2p-action-verified label.
  // Player refs carry only public identifiers (uid) — configs stay private.
  const trust: TrustLabel = {
    tier: "p2p-action-verified",
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
    ruleset: "m3t4",
    proofIssuedAt: new Date().toISOString(),
    proofIssuer: "server",
    verification: {
      actionLogHash: result.logHash,
      stateHashCadenceTicks: t.stateHashCadenceTicks,
      verifierIds: Array.isArray(peerSignatures) ? (peerSignatures as string[]).slice(0, 2) : undefined,
    },
  };

  const artifact = sim.createReplayArtifactV1({
    matchId: t.matchId,
    mode: "generated",
    stage,
    seed: t.seed,
    chars: sim.DEFAULT_CHARS,
    actionLog,
    result: out.result,
    players: [
      { kind: "brain", tier: "user", label: t.playerIds[0], userId: t.playerIds[0] },
      { kind: "brain", tier: "user", label: t.playerIds[1], userId: t.playerIds[1] },
    ],
    sim: { constantsHash: REPLAY_CONSTANTS_HASH },
    trust,
  });
  await store.archiveReplay(artifact);
  return json(res, 200, { ok: true, matchId: t.matchId, trust });
}

// GET /api/duel/rendezvous/:challengeId
//
// Scaffold: poll-based rendezvous. Real implementation should use WebRTC
// SDP exchange — peers POST SDP offers/answers to the server, the other
// peer polls this endpoint. Full implementation deferred.
export async function handleDuelRendezvous(
  _challengeId: string, _req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  return json(res, 501, {
    ok: false,
    reason: "WebRTC rendezvous not implemented in this scaffold. See ARCHITECTURE.md.",
  });
}

// ---------------------------- community verification stub ----------------------------
//
// Community workers post attestations: "I replayed action log X and got
// logHash Y". Server aggregates per (matchId, actionLogHash) and
// upgrades replay label to community-verified on quorum. Full worker
// registry + dispute escalation deferred.

// POST /api/community/attest
// Body: { matchId, actionLogHash, workerIdentity, signature }
export async function handleCommunityAttest(
  _store: StableStore, _req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  return json(res, 501, {
    ok: false,
    reason: "Community verification pool not implemented in this scaffold. See ARCHITECTURE.md.",
  });
}
