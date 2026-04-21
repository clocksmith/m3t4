// Server routes implementing ARCHITECTURE.md's verify/spectate/duel
// surface. Kept in a single file so the handler set is easy to audit.

import http from "node:http";
import crypto from "node:crypto";
import {
  BEHAVIOR_VERSION,
  ROUND_TIMER_MAX_TICKS,
  REPLAY_CONSTANTS_HASH,
  ROUNDS_TO_WIN_MATCH,
  STAGES,
  replaySha256BytesSync,
  type Stage,
  type TrustLabel,
  verifyActionLog,
} from "@m3t4/sim";
import type { StableStore } from "./stable.js";
import type { VerifyStore } from "./verify-store.js";
import { corsHeaders } from "./http-utils.js";
import { publicReplayTupleFromReplay } from "./public-artifacts.js";

// ---------------------------- helpers ----------------------------

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    ...corsHeaders(),
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

const DEFAULT_MAX_TICKS = ROUND_TIMER_MAX_TICKS * ROUNDS_TO_WIN_MATCH * 2;
const IS_PROD = process.env.NODE_ENV === "production";

// Match tokens are HMAC-signed by the server so peers cannot forge them.
// The secret is derived from env (rotate on deploy). For dev/test, a
// stable but non-production default is used — never ship this default.
const TOKEN_SECRET: string =
  process.env.M3T4_MATCH_TOKEN_SECRET ??
  (IS_PROD ? "" : "dev-only-m3t4-match-token-secret-replace-in-prod");

if (!TOKEN_SECRET) {
  throw new Error("M3T4_MATCH_TOKEN_SECRET is required in production");
}

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

  const { seed, stageId, actionLogB64, expectedLogHash, expectedResult, maxTicks } = body ?? {};
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
    maxTicks: typeof maxTicks === "number" && Number.isFinite(maxTicks)
      ? Math.max(0, Math.floor(maxTicks))
      : DEFAULT_MAX_TICKS,
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

  return json(res, 200, publicReplayTupleFromReplay(replay));
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
  maxTicks: number;
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

function tokenFromHeader(req: http.IncomingMessage): SignedMatchToken | null {
  const raw = req.headers["x-m3t4-match-token"];
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as SignedMatchToken;
  } catch {
    return null;
  }
}

function signalAuthorized(
  req: http.IncomingMessage, matchId: string, fromPlayerId?: string,
): boolean {
  if (!IS_PROD) return true;
  const token = tokenFromHeader(req);
  if (!token || token.matchId !== matchId || !verifyMatchToken(token)) return false;
  if (new Date(token.expiresAt) < new Date()) return false;
  return fromPlayerId === undefined || token.playerIds.includes(fromPlayerId);
}

// POST /api/duel/challenge  { toUid, stageId? }
export async function handleDuelChallenge(
  vstore: VerifyStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
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
  vstore.createChallenge({
    challengeId, fromUid, toUid, stageId,
    createdAt: now.toISOString(),
    expiresAt: exp.toISOString(),
  });
  return json(res, 200, { challengeId, expiresAt: exp.toISOString() });
}

// POST /api/duel/accept  { challengeId }
export async function handleDuelAccept(
  vstore: VerifyStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }
  const { challengeId } = body ?? {};
  const ch = typeof challengeId === "string" ? vstore.getChallenge(challengeId) : undefined;
  if (!ch) return json(res, 404, { ok: false, reason: "challenge not found" });
  if (new Date(ch.expiresAt) < new Date()) {
    vstore.deleteChallenge(challengeId);
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
    maxTicks: DEFAULT_MAX_TICKS,
  });
  vstore.updateChallenge(challengeId, { token });
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
    maxTicks: t.maxTicks ?? DEFAULT_MAX_TICKS,
    expectedLogHash: typeof result?.logHash === "string" ? result.logHash : undefined,
    expectedResult: result,
  });

  if (!out.ok) {
    return json(res, 400, { ok: false, reason: out.reason, serverResult: out.result });
  }

  // Build + archive the replay artifact with p2p-action-verified label.
  // Player refs carry only public identifiers (uid) — configs stay private.
  const actionLogSha256 = replaySha256BytesSync(actionLog);
  const trust: TrustLabel = {
    tier: "p2p-action-verified",
    simConstantsHash: REPLAY_CONSTANTS_HASH,
    behaviorVersion: BEHAVIOR_VERSION,
    ruleset: "m3t4",
    proofIssuedAt: new Date().toISOString(),
    proofIssuer: "server",
    verification: {
      actionLogHash: result.logHash,
      actionLogSha256,
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

// ---------------------------- WebRTC rendezvous ----------------------------
//
// Peers use the server as a minimal signaling relay: each peer posts its
// SDP offer/answer and ICE candidates keyed by matchId + role. The other
// peer polls for the counterpart. Once the WebRTC data channel is open,
// the server is out of the match. If WebRTC setup fails, peers can fall
// back to posting action bytes via the same signal channel, but that's
// slower and not the primary path.
//
// State is in-memory for this scaffold. Production should use a short-
// TTL KV (Redis) since signaling exchanges are small and ephemeral.

type SdpRole = "offer" | "answer";

const SIGNAL_TTL_MS = 10 * 60 * 1000; // 10 min, matches token expiry

// POST /api/duel/signal/:matchId
// Body: { role: "offer" | "answer", sdp: string, fromPlayerId: string }
//       OR { ice: RTCIceCandidate, fromPlayerId: string }
//
// A peer posts its SDP offer, its SDP answer, or an ICE candidate. The
// other peer polls the GET variant to retrieve. No auth in this
// scaffold — production should require a valid MatchToken header.
export async function handleDuelSignalPost(
  vstore: VerifyStore, matchId: string, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  if (!matchId) return json(res, 400, { ok: false, reason: "matchId required" });
  vstore.sweepSignalSlots(SIGNAL_TTL_MS);

  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const { role, sdp, ice, fromPlayerId } = body ?? {};
  if (typeof fromPlayerId !== "string" || !fromPlayerId) {
    return json(res, 400, { ok: false, reason: "fromPlayerId required" });
  }
  if (!signalAuthorized(req, matchId, fromPlayerId)) {
    return json(res, 403, { ok: false, reason: "valid match token required" });
  }
  const slot = vstore.ensureSignalSlot(matchId);

  // ICE candidate deposit
  if (ice !== undefined) {
    vstore.addIceCandidate(matchId, {
      fromPlayerId, candidate: ice,
      postedAt: new Date().toISOString(),
    });
    return json(res, 200, { ok: true, count: slot.iceCandidates.length + 1 });
  }

  // SDP deposit
  if (typeof sdp !== "string" || !sdp) {
    return json(res, 400, { ok: false, reason: "sdp or ice required" });
  }
  if (role !== "offer" && role !== "answer") {
    return json(res, 400, { ok: false, reason: "role must be offer|answer" });
  }
  vstore.updateSignalSlot(matchId, {
    [role]: { sdp, fromPlayerId, postedAt: new Date().toISOString() },
  } as any);
  return json(res, 200, { ok: true, role });
}

// GET /api/duel/signal/:matchId?role=offer|answer&sinceIce=<ISO>
export async function handleDuelSignalGet(
  vstore: VerifyStore, matchId: string, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  if (!matchId) return json(res, 400, { ok: false, reason: "matchId required" });
  vstore.sweepSignalSlots(SIGNAL_TTL_MS);
  const slot = vstore.getSignalSlot(matchId);
  if (!slot) return json(res, 404, { ok: false, reason: "signal slot not found" });
  if (!signalAuthorized(req, matchId)) {
    return json(res, 403, { ok: false, reason: "valid match token required" });
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const wantRole = url.searchParams.get("role") as SdpRole | null;
  const sinceIce = url.searchParams.get("sinceIce");

  const ice = sinceIce
    ? slot.iceCandidates.filter((c) => c.postedAt > sinceIce)
    : slot.iceCandidates;

  const sdp = wantRole ? (slot as any)[wantRole] : undefined;

  return json(res, 200, { matchId, sdp, ice });
}

// ---------------------------- community verification pool ----------------------------
//
// Real implementation of the quorum-based exhibition-match verification
// pool described in ARCHITECTURE.md.
//
// Flow:
//   1. Worker registers (gets workerId + sharedSecret).
//   2. Worker picks up a match (matchId known via client-side discovery).
//   3. Worker replays the action log locally using the shipped sim.
//   4. Worker signs (matchId + computed logHash) with its sharedSecret.
//   5. Worker POSTs attestation to /api/community/attest.
//   6. Server verifies signature, compares hash to the server's
//      authoritative replay result, records agree/disagree.
//   7. When N agreeing attestations arrive from distinct workers, the
//      replay's trust label is upgraded to "community-verified" with
//      the quorum fields populated.
//
// In-memory state for the scaffold. Production should persist worker
// registry and attestation records.

const COMMUNITY_QUORUM_TOTAL = 3; // M — minimum pool required
const COMMUNITY_QUORUM_REQUIRED = 2; // N — agreeing workers required

// POST /api/community/workers/register
// Body: { label?: string }
// Returns: { workerId, sharedSecret }
//
// The secret is returned ONCE at registration. Workers store it and
// sign attestations with it. Losing the secret requires re-registration.
export async function handleCommunityRegister(
  vstore: VerifyStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); } catch { body = {}; }
  const workerId = crypto.randomBytes(12).toString("hex");
  const sharedSecret = crypto.randomBytes(32).toString("hex");
  vstore.registerWorker({
    workerId,
    label: typeof body?.label === "string" ? body.label : undefined,
    sharedSecret,
    registeredAt: new Date().toISOString(),
    disagreementCount: 0,
  });
  return json(res, 200, { workerId, sharedSecret, quorum: {
    total: COMMUNITY_QUORUM_TOTAL, required: COMMUNITY_QUORUM_REQUIRED,
  } });
}

// POST /api/community/attest
// Body: {
//   matchId: string,
//   workerId: string,
//   computedActionSha256: string, // preferred
//   computedLogHash?: string,     // legacy FNV logHash compatibility
//   signature: string,            // HMAC-SHA256 over `${matchId}:${hash}`
// }
//
// Server flow:
//  - Look up worker; reject if missing or delisted.
//  - Verify HMAC signature.
//  - Load replay; compare computedLogHash to replay.result.logHash.
//  - Record attestation.
//  - If agreeing attestations from >= N distinct workers exist, upgrade
//    replay.trust.tier to "community-verified".
//  - On disagreement, increment worker.disagreementCount; delist at 3.
export async function handleCommunityAttest(
  store: StableStore, vstore: VerifyStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const { matchId, workerId, computedLogHash, computedActionSha256, signature } = body ?? {};
  if (typeof matchId !== "string" || !matchId) {
    return json(res, 400, { ok: false, reason: "matchId required" });
  }
  if (typeof workerId !== "string" || !workerId) {
    return json(res, 400, { ok: false, reason: "workerId required" });
  }
  const hasSha = typeof computedActionSha256 === "string" && /^[0-9a-f]{64}$/i.test(computedActionSha256);
  const hasLegacyHash = typeof computedLogHash === "string" && !!computedLogHash;
  if (!hasSha && !hasLegacyHash) {
    return json(res, 400, { ok: false, reason: "computedActionSha256 required" });
  }
  if (typeof signature !== "string" || !signature) {
    return json(res, 400, { ok: false, reason: "signature required" });
  }

  const worker = vstore.getWorker(workerId);
  if (!worker) {
    return json(res, 403, { ok: false, reason: "worker not registered" });
  }
  if (worker.delisted) {
    return json(res, 403, { ok: false, reason: "worker delisted due to repeated disagreements" });
  }

  const attestedHash = hasSha ? computedActionSha256 as string : computedLogHash as string;
  const payload = `${matchId}:${attestedHash}`;
  const expectedSig = crypto.createHmac("sha256", worker.sharedSecret).update(payload).digest("hex");
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return json(res, 403, { ok: false, reason: "signature mismatch" });
    }
  } catch {
    return json(res, 400, { ok: false, reason: "signature malformed" });
  }

  const replay = await store.getReplay(matchId);
  if (!replay) return json(res, 404, { ok: false, reason: "replay not found" });

  const agreed = hasSha
    ? replay.actions.sha256 === computedActionSha256
    : replay.result.logHash === computedLogHash;
  const list = vstore.upsertAttestation({
    matchId, workerId,
    computedLogHash: hasLegacyHash ? computedLogHash : undefined,
    computedActionSha256: hasSha ? computedActionSha256 : undefined,
    agreed,
    postedAt: new Date().toISOString(),
  });

  if (!agreed) {
    const newCount = worker.disagreementCount + 1;
    vstore.updateWorker(workerId, {
      disagreementCount: newCount,
      delisted: newCount >= 3 ? true : worker.delisted,
    });
  }

  // Quorum evaluation
  const agreeingWorkers = new Set(list.filter((a) => a.agreed).map((a) => a.workerId));
  const totalDistinctWorkers = new Set(list.map((a) => a.workerId)).size;
  const quorumMet =
    agreeingWorkers.size >= COMMUNITY_QUORUM_REQUIRED &&
    totalDistinctWorkers >= Math.min(COMMUNITY_QUORUM_TOTAL, agreeingWorkers.size + 1);

  if (quorumMet && replay.trust && replay.trust.tier !== "community-verified") {
    // Upgrade the replay's trust label. Production should atomically
    // replace the stored artifact; this scaffold mutates in memory and
    // writes back via the same archive API.
    replay.trust.tier = "community-verified";
    replay.trust.proofIssuer = "community-quorum";
    replay.trust.proofIssuedAt = new Date().toISOString();
    replay.trust.verification = {
      ...(replay.trust.verification ?? {}),
      quorum: {
        required: COMMUNITY_QUORUM_REQUIRED,
        total: totalDistinctWorkers,
        agreed: agreeingWorkers.size,
      },
      verifierIds: Array.from(agreeingWorkers),
      actionLogHash: replay.result.logHash,
      actionLogSha256: replay.actions.sha256,
    };
    await store.archiveReplay(replay);
  }

  return json(res, 200, {
    ok: true,
    agreed,
    quorum: {
      required: COMMUNITY_QUORUM_REQUIRED,
      total: totalDistinctWorkers,
      agreed: agreeingWorkers.size,
      reached: quorumMet,
    },
    workerStatus: {
      disagreementCount: worker.disagreementCount,
      delisted: !!worker.delisted,
    },
  });
}

// GET /api/community/status/:matchId
// Returns current quorum state for the match (public, no auth).
export async function handleCommunityStatus(
  store: StableStore, vstore: VerifyStore, matchId: string,
  _req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  const replay = await store.getReplay(matchId);
  if (!replay) return json(res, 404, { error: "replay not found" });
  const list = vstore.getAttestations(matchId);
  const agreeing = list.filter((a) => a.agreed);
  return json(res, 200, {
    matchId,
    currentTier: replay.trust?.tier,
    quorum: {
      required: COMMUNITY_QUORUM_REQUIRED,
      total: list.length,
      agreed: agreeing.length,
      reached: replay.trust?.tier === "community-verified",
    },
    verifierIds: replay.trust?.verification?.verifierIds,
  });
}
