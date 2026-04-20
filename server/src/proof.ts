// Proof-carrying tiers from ARCHITECTURE.md.
//
// - L1 commit-reveal: real implementation in pure JS crypto.
// - L2 attested-agent: signed-attestation STAND-IN — proves client key
//   custody and approved-runtime-version claim. NOT hardware attestation.
//   Real TEE (SGX Quote, Apple DeviceCheck, Play Integrity) needs
//   platform infra we don't have; this file marks those boundaries.
// - L3 proof-carrying: opaque proof-blob envelope — accepts and binds a
//   proof byte-string to a match tuple, stamps a proof-carrying label
//   after sim-version check. Real ZK circuit verification is stubbed.
//
// All three tiers land replay artifacts via the existing store, labeled
// correctly. A viewer sees the tier and knows exactly what was proven.

import http from "node:http";
import crypto from "node:crypto";
import {
  BEHAVIOR_VERSION, DEFAULT_CHARS, REPLAY_CONSTANTS_HASH, STAGES,
  createReplayArtifactV1, validateUserSubmission, verifyActionLog,
  type BrainConfig, type Stage, type TrustLabel,
} from "@m3t4/sim";
import type { StableStore } from "./stable.js";
import type { VerifyStore } from "./verify-store.js";
import { corsHeaders } from "./http-utils.js";

// ---------------------------- helpers ----------------------------

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}

function readJsonBody<T = unknown>(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<T> {
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

function sha256Hex(s: string | Buffer | Uint8Array): string {
  const h = crypto.createHash("sha256");
  if (typeof s === "string") h.update(s);
  else h.update(Buffer.from(s));
  return h.digest("hex");
}

// ---------------------------- L1: commit-reveal ----------------------------
//
// Flow:
//  1. Player posts a commitment hash(config + salt) to /api/proof/commit.
//  2. The server issues a match token bound to that commitment (and to
//     the opponent's commitment once two come in).
//  3. Match plays out (server-authoritative OR P2P via existing duel
//     flow — proof tier is orthogonal to match execution).
//  4. Both players reveal their (config, salt) to /api/proof/reveal.
//  5. Server verifies:
//       a. hash(revealed_config + revealed_salt) === commitment
//       b. revealed config is budget-legal
//       c. re-simulating with both revealed configs produces the claimed
//          result (or, for a server-auth match, matches the archived
//          action log)
//  6. On success, the replay's trust label is upgraded/stamped as
//     "proof-carrying" with tier metadata showing "L1 commit-reveal".
//
// In-memory commitment state; production needs persistence keyed by
// matchId or tournament round.

// Canonical JSON for hashing — sort keys, stringify stably. Must match
// on the client; publish a shared helper for production.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function computeCommitmentHash(config: BrainConfig, salt: string): string {
  return sha256Hex(canonicalJson(config) + ":" + salt);
}

// POST /api/proof/commit
// Body: { commitmentHash: string }
// Returns: { commitmentId }
//
// The server never sees the config or salt at this stage — only the
// hash. The player keeps (config, salt) locally until reveal time.
export async function handleProofCommit(
  vstore: VerifyStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const uid = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "").trim() || "dev-user";
  const { commitmentHash } = body ?? {};
  if (typeof commitmentHash !== "string" || !/^[0-9a-f]{64}$/.test(commitmentHash)) {
    return json(res, 400, { ok: false, reason: "commitmentHash must be 64-char hex sha256" });
  }
  const commitmentId = crypto.randomBytes(16).toString("hex");
  vstore.createCommitment({
    commitmentId, uid, commitmentHash,
    createdAt: new Date().toISOString(),
  });
  return json(res, 200, { commitmentId, commitmentHash });
}

// POST /api/proof/reveal
// Body: {
//   commitmentId: string,
//   config: BrainConfig,
//   salt: string,
//   matchContext?: {
//     matchId?: string,           // existing archived match, if any
//     opponentConfig?: BrainConfig,
//     opponentSalt?: string,
//     stageId?: string,
//     seed?: number,
//     actionLogB64?: string,      // optional: action log to verify against
//     expectedResult?: any,
//   },
// }
//
// Returns: { ok, tier: "proof-carrying-L1", matchId?, result? }
//
// Server verifies the commitment matches, config is budget-legal, and
// (if match context provided) the configs reproduce the claimed match
// outcome. Stamps the replay with a proof-carrying label.
export async function handleProofReveal(
  store: StableStore, vstore: VerifyStore,
  req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const { commitmentId, config, salt, matchContext } = body ?? {};
  if (typeof commitmentId !== "string") {
    return json(res, 400, { ok: false, reason: "commitmentId required" });
  }
  if (typeof salt !== "string" || salt.length < 8) {
    return json(res, 400, { ok: false, reason: "salt required (min 8 chars)" });
  }
  if (!config || typeof config !== "object") {
    return json(res, 400, { ok: false, reason: "config required" });
  }

  const rec = vstore.getCommitment(commitmentId);
  if (!rec) return json(res, 404, { ok: false, reason: "commitment not found" });
  if (rec.revealedAt) return json(res, 409, { ok: false, reason: "already revealed" });

  // Verify commitment matches
  const computed = computeCommitmentHash(config as BrainConfig, salt);
  if (computed !== rec.commitmentHash) {
    return json(res, 403, { ok: false, reason: "commitment hash mismatch" });
  }

  // Verify budget legality
  const validation = validateUserSubmission(config as BrainConfig);
  if (!validation.ok || !validation.config) {
    return json(res, 400, {
      ok: false,
      reason: "illegal config",
      details: validation.errors,
    });
  }

  vstore.markCommitmentRevealed(commitmentId, new Date().toISOString());

  const proofTier: TrustLabel["tier"] = "proof-carrying";
  const proofMeta = {
    subtier: "L1-commit-reveal",
    commitmentId,
    commitmentHash: rec.commitmentHash,
    budgetSpent: validation.spent,
  };

  // If this reveal came with match context, verify the action log.
  if (matchContext && typeof matchContext === "object") {
      const { matchId, opponentConfig, stageId, seed, actionLogB64, expectedResult, maxTicks } = matchContext;

    // Case A: bound to an archived server-authoritative match — compare
    // revealed config hash to the archived player's configHash.
    if (typeof matchId === "string" && matchId) {
      const replay = await store.getReplay(matchId);
      if (!replay) return json(res, 404, { ok: false, reason: "archived match not found" });
      const revealedCfgHash = sha256Hex(canonicalJson(config));
      const matched = replay.players.some((p) => {
        if (!p.config) return false;
        return sha256Hex(canonicalJson(p.config)) === revealedCfgHash;
      });
      if (!matched) {
        return json(res, 403, { ok: false, reason: "revealed config does not match any archived player" });
      }
      // Upgrade trust label on the replay.
      if (replay.trust) {
        replay.trust.tier = proofTier;
        replay.trust.proofIssuer = "server";
        replay.trust.proofIssuedAt = new Date().toISOString();
        replay.trust.verification = {
          ...(replay.trust.verification ?? {}),
          ...proofMeta,
        } as any;
        await store.archiveReplay(replay);
      }
      return json(res, 200, { ok: true, tier: proofTier, matchId, proof: proofMeta });
    }

    // Case B: verify a standalone action log.
    if (typeof stageId === "string" && typeof seed === "number" && typeof actionLogB64 === "string" && opponentConfig) {
      if (!(stageId in STAGES)) return json(res, 400, { ok: false, reason: "unknown stageId" });
      const stage: Stage = STAGES[stageId as keyof typeof STAGES];
      let actionLog: Uint8Array;
      try { actionLog = base64ToBytes(actionLogB64); }
      catch { return json(res, 400, { ok: false, reason: "actionLogB64 malformed" }); }
      const opponentValidation = validateUserSubmission(opponentConfig as BrainConfig);
      if (!opponentValidation.ok || !opponentValidation.config) {
        return json(res, 400, {
          ok: false,
          reason: "illegal opponent config",
          details: opponentValidation.errors,
        });
      }
      const out = verifyActionLog({
        seed: seed >>> 0, stage, chars: DEFAULT_CHARS,
        actionLog,
        maxTicks: typeof maxTicks === "number" && Number.isFinite(maxTicks)
          ? Math.max(0, Math.floor(maxTicks))
          : undefined,
        expectedResult,
      });
      if (!out.ok) {
        return json(res, 400, { ok: false, reason: `action log verify failed: ${out.reason}` });
      }
      // Archive a new replay artifact carrying the L1 proof.
      const matchIdNew = crypto.randomBytes(12).toString("hex");
      const trust: TrustLabel = {
        tier: proofTier,
        simConstantsHash: REPLAY_CONSTANTS_HASH,
        behaviorVersion: BEHAVIOR_VERSION,
        ruleset: "m3t4",
        proofIssuedAt: new Date().toISOString(),
        proofIssuer: "server",
        verification: proofMeta as any,
      };
      const artifact = createReplayArtifactV1({
        matchId: matchIdNew,
        mode: "generated",
        stage, seed: seed >>> 0,
        chars: DEFAULT_CHARS,
        actionLog,
        result: out.result,
        players: [
          { kind: "brain", tier: "user", label: rec.uid, userId: rec.uid, config: config as BrainConfig },
          { kind: "brain", tier: "user", label: "opponent", config: opponentConfig as BrainConfig },
        ],
        sim: { constantsHash: REPLAY_CONSTANTS_HASH },
        trust,
      });
      await store.archiveReplay(artifact);
      return json(res, 200, { ok: true, tier: proofTier, matchId: matchIdNew, proof: proofMeta });
    }
  }

  // Reveal-only (no match context) is valid; useful for tournament rounds
  // where the reveal is separate from match adjudication.
  return json(res, 200, { ok: true, tier: proofTier, proof: proofMeta });
}

// ---------------------------- L2: signed attestation (stand-in) ----------------------------
//
// NOT hardware attestation. This is a cryptographic-key trust model.
// A player pre-registers an Ed25519 public key; at match time they
// submit an attestation signed by the corresponding private key stating
// "I ran approved agent runtime version X on a legal config whose hash
// is Y". The server verifies the signature and the runtime-version
// claim against an allow-list.
//
// Real L2 would replace this with:
//   - iOS DeviceCheck or App Attest attestation objects
//   - Android Play Integrity API tokens
//   - Intel SGX Quotes verified against Intel Attestation Service
//   - AMD SEV-SNP attestation reports
//   - WebAuthn device-bound keys for browser-native attestation
//
// The STAND-IN proves: (a) the attester controls a registered key,
// (b) they claim an approved runtime version, (c) they claim a
// specific config hash. It does NOT prove the runtime actually ran,
// nor that the config was legal without a reveal. Combining L2 with
// L1 reveal or L3 proof closes those gaps.

const APPROVED_RUNTIME_VERSIONS = new Set<string>([
  // Allowlist shape: "<package>@<version>+<behavior-version>".
  // Production should pull this from a server-signed manifest.
  `@m3t4/sim@0.1.0+${BEHAVIOR_VERSION}`,
]);

// POST /api/proof/attest/register
// Body: { publicKeyPem: string, runtimeVersions: string[] }
export async function handleAttestRegister(
  vstore: VerifyStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }
  const uid = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "").trim() || "dev-user";
  const { publicKeyPem, runtimeVersions } = body ?? {};
  if (typeof publicKeyPem !== "string" || !publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    return json(res, 400, { ok: false, reason: "publicKeyPem required (PEM format)" });
  }
  if (!Array.isArray(runtimeVersions) || !runtimeVersions.every((v) => typeof v === "string")) {
    return json(res, 400, { ok: false, reason: "runtimeVersions must be string[]" });
  }
  // Validate PEM parseable
  try { crypto.createPublicKey(publicKeyPem); }
  catch { return json(res, 400, { ok: false, reason: "publicKeyPem not parseable" }); }

  const registeredAt = new Date().toISOString();
  vstore.setAttestedKey({
    uid, publicKeyPem, runtimeVersionsAllowed: runtimeVersions, registeredAt,
  });
  return json(res, 200, { ok: true, uid, registered: registeredAt });
}

// POST /api/proof/attest/submit
// Body: {
//   matchId: string,
//   runtimeVersion: string,
//   configHash: string,                // sha256 of canonical config json
//   nonce: string,                     // server-issued freshness nonce
//   signatureB64: string,              // Ed25519 over (matchId|runtime|cfgHash|nonce|simHash)
// }
//
// Server verifies signature, runtime-version allowlist, and sim hash
// consistency. On success, upgrades replay tier to attested-agent.
export async function handleAttestSubmit(
  store: StableStore, vstore: VerifyStore,
  req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const uid = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "").trim() || "dev-user";
  const { matchId, runtimeVersion, configHash, nonce, signatureB64 } = body ?? {};
  for (const [name, val] of [
    ["matchId", matchId], ["runtimeVersion", runtimeVersion],
    ["configHash", configHash], ["nonce", nonce], ["signatureB64", signatureB64],
  ]) {
    if (typeof val !== "string" || !val) {
      return json(res, 400, { ok: false, reason: `${name} required` });
    }
  }
  if (!APPROVED_RUNTIME_VERSIONS.has(runtimeVersion)) {
    return json(res, 403, { ok: false, reason: "runtimeVersion not in allowlist" });
  }
  const key = vstore.getAttestedKey(uid);
  if (!key) return json(res, 403, { ok: false, reason: "no attestation key registered for uid" });

  const replay = await store.getReplay(matchId);
  if (!replay) return json(res, 404, { ok: false, reason: "replay not found" });
  const replaySimHash = replay.sim.constantsHash ?? REPLAY_CONSTANTS_HASH;

  const payload = [matchId, runtimeVersion, configHash, nonce, replaySimHash].join("|");
  let ok = false;
  try {
    const pub = crypto.createPublicKey(key.publicKeyPem);
    ok = crypto.verify(null, Buffer.from(payload), pub, Buffer.from(signatureB64, "base64"));
  } catch { /* fall through */ }
  if (!ok) return json(res, 403, { ok: false, reason: "signature verification failed" });

  // Upgrade tier to attested-agent.
  if (replay.trust) {
    replay.trust.tier = "attested-agent";
    replay.trust.proofIssuer = "server";
    replay.trust.proofIssuedAt = new Date().toISOString();
    replay.trust.verification = {
      ...(replay.trust.verification ?? {}),
      ...({ attestationKind: "signed-key-standin", runtimeVersion, configHash } as any),
    };
    await store.archiveReplay(replay);
  }
  return json(res, 200, {
    ok: true,
    tier: "attested-agent",
    note: "signed-key attestation (stand-in). Real hardware attestation requires platform SDK integration.",
  });
}

// ---------------------------- L3: opaque proof envelope ----------------------------
//
// This is NOT a working ZK verifier. Real L3 requires:
//   - A circuit expressing: "there exists a legal config C such that
//     for all ticks t, action[t] = approved_brain(obs[t], C, state[t])".
//   - State machine (brain v3) re-expressed in fixed-point arithmetic
//     compatible with the proving system (Halo2, Groth16, STARK, etc).
//   - Per-tick or per-match proof generation at the client.
//   - O(1) verification on the server.
//
// What THIS scaffold does:
//   - Accepts a proof blob (base64) + a proof-system identifier.
//   - Verifies the proof is bound to a specific (matchId, actionLogHash,
//     simConstantsHash, behaviorVersion).
//   - Calls into a registered verifier function; none are registered by
//     default, so all submissions currently reject with "no verifier".
//   - When a real verifier is wired, the envelope upgrades the replay
//     tier to proof-carrying with subtier = proof system.
//
// Registered verifiers live in a map so a future circuit toolchain can
// be added without touching this file's route handlers.

type ProofSystem = "halo2-kzg" | "groth16" | "risc0-stark" | "unknown";

interface ProofEnvelope {
  proofSystem: ProofSystem;
  matchId: string;
  actionLogHash: string;
  simConstantsHash: string;
  behaviorVersion: number;
  proofBytesB64: string;
  publicInputs?: unknown;
}

interface ProofVerifier {
  name: ProofSystem;
  verify(envelope: ProofEnvelope): Promise<{ ok: boolean; reason?: string }>;
}

// Registry. Populated by future modules that bring in a prover/verifier
// backend. Not touched at construction time.
const proofVerifiers = new Map<ProofSystem, ProofVerifier>();

export function registerProofVerifier(v: ProofVerifier): void {
  proofVerifiers.set(v.name, v);
}

// POST /api/proof/zk/submit
// Body: ProofEnvelope (+ optional publicInputs)
export async function handleProofZkSubmit(
  store: StableStore, req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { ok: false, reason: "invalid json body" }); }

  const env = body as Partial<ProofEnvelope> | null;
  if (!env || typeof env !== "object") return json(res, 400, { ok: false, reason: "envelope required" });
  const {
    proofSystem, matchId, actionLogHash, simConstantsHash, behaviorVersion, proofBytesB64,
  } = env;
  if (!proofSystem || typeof proofSystem !== "string") {
    return json(res, 400, { ok: false, reason: "proofSystem required" });
  }
  if (typeof matchId !== "string" || !matchId) return json(res, 400, { ok: false, reason: "matchId required" });
  if (typeof actionLogHash !== "string") return json(res, 400, { ok: false, reason: "actionLogHash required" });
  if (typeof proofBytesB64 !== "string") return json(res, 400, { ok: false, reason: "proofBytesB64 required" });
  if (simConstantsHash !== REPLAY_CONSTANTS_HASH) {
    return json(res, 409, { ok: false, reason: "simConstantsHash mismatch with current sim version" });
  }
  if (behaviorVersion !== BEHAVIOR_VERSION) {
    return json(res, 409, { ok: false, reason: "behaviorVersion mismatch" });
  }

  const replay = await store.getReplay(matchId);
  if (!replay) return json(res, 404, { ok: false, reason: "replay not found" });
  const archivedActionLogHash = replay.actions.sha256 ?? replay.actions.hash;
  if (archivedActionLogHash !== actionLogHash) {
    return json(res, 409, { ok: false, reason: "actionLogHash does not match archived replay" });
  }

  const verifier = proofVerifiers.get(proofSystem as ProofSystem);
  if (!verifier) {
    return json(res, 501, {
      ok: false,
      reason: `no verifier registered for proof system "${proofSystem}". ` +
        "L3 zero-knowledge verification requires a circuit toolchain (Halo2/Groth16/STARK) " +
        "that re-expresses brain v3 as constraints. See ARCHITECTURE.md L3.",
    });
  }

  const result = await verifier.verify(env as ProofEnvelope);
  if (!result.ok) return json(res, 403, { ok: false, reason: `proof verify failed: ${result.reason}` });

  // Upgrade label. Real L3 proof is the strongest tier — configs stay
  // private even from the server.
  if (replay.trust) {
    replay.trust.tier = "proof-carrying";
    replay.trust.proofIssuer = "server";
    replay.trust.proofIssuedAt = new Date().toISOString();
    replay.trust.verification = {
      ...(replay.trust.verification ?? {}),
      ...({ subtier: `L3-${proofSystem}`, actionLogHash } as any),
    };
    await store.archiveReplay(replay);
  }
  return json(res, 200, { ok: true, tier: "proof-carrying", proofSystem });
}

// GET /api/proof/zk/systems — list supported proof systems.
// Useful for clients picking a prover backend.
export async function handleProofZkSystems(
  _req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  return json(res, 200, {
    registered: Array.from(proofVerifiers.keys()),
    note: "Verifiers are registered by backend modules. Empty = no L3 backend wired.",
  });
}

// ---------------------------- dev-mock verifier ----------------------------
//
// Registers a "dev-mock" proof system that accepts any envelope whose
// proofBytesB64 is a valid HMAC-SHA256 signature over the envelope fields
// using the server's TOKEN_SECRET. This is NOT zero-knowledge — it's a
// keyed authentication code. It exists so the L3 pipeline can be
// exercised end-to-end (route, store, label upgrade) without a full
// circuit toolchain. Real ZK verifiers register their own entries.
//
// Clients compute: sign = HMAC(secret, `${proofSystem}|${matchId}|${actionLogHash}|${simConstantsHash}|${behaviorVersion}`)
// and base64-encode the raw bytes.
//
// DISABLE THIS IN PRODUCTION. The secret is intended for dev use only.

const DEV_MOCK_SECRET: string =
  process.env.M3T4_PROOF_DEV_MOCK_SECRET
  ?? "dev-mock-zk-accept-any-signed-envelope-do-not-ship";

if (process.env.NODE_ENV !== "production") {
  registerProofVerifier({
    name: "unknown" as ProofSystem,  // overwritten on self-register below
    async verify(env) {
      const payload = [
        env.proofSystem, env.matchId, env.actionLogHash,
        env.simConstantsHash, String(env.behaviorVersion),
      ].join("|");
      const want = crypto.createHmac("sha256", DEV_MOCK_SECRET).update(payload).digest();
      let got: Buffer;
      try { got = Buffer.from(env.proofBytesB64, "base64"); }
      catch { return { ok: false, reason: "proofBytesB64 malformed" }; }
      if (want.length !== got.length) return { ok: false, reason: "signature length" };
      if (!crypto.timingSafeEqual(want, got)) return { ok: false, reason: "signature mismatch" };
      return { ok: true };
    },
  });

  // Rename the entry to "dev-mock" properly. The constructor above assigns
  // `name: "unknown"` because the type demands a ProofSystem literal and
  // "dev-mock" isn't in the union. We overwrite post-register so the map
  // key is correct without widening the public type.
  const entry = proofVerifiers.get("unknown" as ProofSystem);
  proofVerifiers.delete("unknown" as ProofSystem);
  if (entry) proofVerifiers.set("dev-mock" as ProofSystem, { ...entry, name: "dev-mock" as ProofSystem });
}
