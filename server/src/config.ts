// Environment-driven settings. All production values come from env vars so
// the same image deploys to any GCP/Firebase project.

export const CONFIG = {
  port: parseInt(process.env.PORT ?? "7777", 10),
  publicDomain: process.env.ARENA_PUBLIC_DOMAIN ?? "localhost",
  apiOrigin: process.env.ARENA_API_ORIGIN ?? "http://localhost:7777",
  wsOrigin: process.env.ARENA_WS_ORIGIN ?? "ws://localhost:7777",

  // Stable rules
  maxSlots: parseInt(process.env.STABLE_MAX_SLOTS ?? "5", 10),
  minSlots: parseInt(process.env.STABLE_MIN_SLOTS ?? "3", 10),
  submitRateMs: parseInt(process.env.SUBMIT_RATE_MS ?? "86400000", 10), // 24h per slot

  // Firehose pacing
  cycleMs: parseInt(process.env.CYCLE_MS ?? "1500", 10), // between-match pause
  activePoolMs: parseInt(process.env.ACTIVE_POOL_MS ?? "1209600000", 10), // 14 days

  // Matchmaking
  eloTolerance: parseInt(process.env.ELO_TOLERANCE ?? "100", 10),
  eloToleranceMax: parseInt(process.env.ELO_TOLERANCE_MAX ?? "300", 10),
  wildcardRatio: parseFloat(process.env.WILDCARD_RATIO ?? "0"),

  // ELO
  eloK: parseInt(process.env.ELO_K ?? "16", 10),
  eloDecayPerWeek: parseFloat(process.env.ELO_DECAY ?? "0.02"),
  eloAnchor: parseInt(process.env.ELO_ANCHOR ?? "1000", 10),

  // Auth allowlist (used by the client SDK config too)
  authProviders: (process.env.AUTH_PROVIDERS ?? "google,github").split(","),

  // Storage
  storePath: process.env.STORE_PATH ?? "./data/m3t4.json",
} as const;
