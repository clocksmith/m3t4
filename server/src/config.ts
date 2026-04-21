// Environment-driven settings. All production values come from env vars so
// the same image deploys to any GCP/Firebase project.

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const IS_PROD = process.env.NODE_ENV === "production";
const STORE_BACKEND = process.env.STORE_BACKEND ?? (IS_PROD ? "firestore" : "file");
if (STORE_BACKEND !== "file" && STORE_BACKEND !== "firestore") {
  throw new Error("STORE_BACKEND must be file or firestore");
}
const SERVER_ROLE = process.env.SERVER_ROLE ?? "combined";
if (!["combined", "api", "worker"].includes(SERVER_ROLE)) {
  throw new Error("SERVER_ROLE must be combined, api, or worker");
}

export const CONFIG = {
  port: parseInt(process.env.PORT ?? "7777", 10),
  apiOrigin: process.env.ARENA_API_ORIGIN ?? "http://localhost:7777",
  wsOrigin: process.env.ARENA_WS_ORIGIN ?? "ws://localhost:7777",
  firehoseWsOrigin: process.env.FIREHOSE_WS_ORIGIN ?? process.env.ARENA_WS_ORIGIN ?? "ws://localhost:7777",
  serverRole: SERVER_ROLE as "combined" | "api" | "worker",
  isProd: IS_PROD,

  // Stable rules
  maxSlots: parseInt(process.env.STABLE_MAX_SLOTS ?? "5", 10),
  minSlots: parseInt(process.env.STABLE_MIN_SLOTS ?? "3", 10),
  submitRateMs: parseInt(process.env.SUBMIT_RATE_MS ?? "86400000", 10), // 24h per slot
  submitIpRateLimitWindowMs: parseInt(process.env.SUBMIT_IP_RATE_LIMIT_WINDOW_MS ?? "600000", 10),
  submitIpRateLimitMax: parseInt(process.env.SUBMIT_IP_RATE_LIMIT_MAX ?? "20", 10),

  // Firehose pacing. The code default is intentionally fast for local
  // smoke runs; .env/prod provisioning pin this to 60000 for real traffic.
  cycleMs: parseInt(process.env.CYCLE_MS ?? "1500", 10), // between-match pause
  activePoolMs: parseInt(process.env.ACTIVE_POOL_MS ?? "1209600000", 10), // 14 days

  // Matchmaking
  eloTolerance: parseInt(process.env.ELO_TOLERANCE ?? "100", 10),
  eloToleranceMax: parseInt(process.env.ELO_TOLERANCE_MAX ?? "300", 10),

  // ELO
  eloK: parseInt(process.env.ELO_K ?? "16", 10),
  eloDecayPerWeek: parseFloat(process.env.ELO_DECAY ?? "0.02"),
  eloAnchor: parseInt(process.env.ELO_ANCHOR ?? "1000", 10),

  // Auth allowlist (used by the client SDK config too)
  authProviders: (process.env.AUTH_PROVIDERS ?? "google,github").split(","),
  authMode: process.env.AUTH_MODE ?? (IS_PROD ? "firebase" : "dev"),

  // Storage
  storeBackend: STORE_BACKEND as "file" | "firestore",
  storePath: process.env.STORE_PATH ?? "./data/m3t4.json",
  replayArchiveLimit: parseInt(process.env.REPLAY_ARCHIVE_LIMIT ?? "100", 10),
  simSourceHash: process.env.SIM_SOURCE_HASH,

  // CORS. Closed alpha can still serve the static site publicly, but the
  // production API should only answer browser requests from the canonical
  // app origin unless explicitly widened.
  corsOrigins: envList("CORS_ORIGINS", IS_PROD ? ["https://m3t4.ai"] : ["*"]),

  // Optional authority surfaces. The beta product path is centralized:
  // ranked/practice/spectate/replay-verify. Exhibition and proof surfaces
  // are present in the repo but hidden unless explicitly enabled.
  features: {
    p2pDuel: envFlag("FEATURE_P2P_DUEL", false),
    communityVerify: envFlag("FEATURE_COMMUNITY_VERIFY", false),
    proofLab: envFlag("FEATURE_PROOF_LAB", false),
    zk: envFlag("FEATURE_ZK", false),
    // Plasma-style opt-in distributed compute. Off by default. When on,
    // registers /api/compute/* routes and the spectator UI shows a
    // "donate idle cycles" panel. Task definition is the limiting
    // factor for real workloads; the transport + receipt + quorum
    // pipeline exists whether or not any task is defined.
    distributedCompute: envFlag("FEATURE_DISTRIBUTED_COMPUTE", false),
    computeTaskAdmin: envFlag("FEATURE_COMPUTE_TASK_ADMIN", false),
  },
} as const;
