function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface PlasmaLabConfig {
  port: number;
  storeBackend: "memory" | "firestore";
  routesEnabled: boolean;
  taskAdminEnabled: boolean;
  publicRegistrationEnabled: boolean;
  workerInviteTokens: string[];
  maxWorkersPerIp: number;
  maxSessionsPerClient: number;
  maxActiveAssignmentsPerIdentity: number;
  strictProofTasksDefault: boolean;
  acceptAssignments: boolean;
  webrtcSignalingEnabled: boolean;
  webrtcDataEnabled: boolean;
  webrtcTurnEnabled: boolean;
  stunUrls: string[];
  turnUrls: string[];
  turnUsername?: string;
  turnCredential?: string;
  adminToken?: string;
  assignmentTimeoutMs: number;
  workerSessionTtlMs: number;
  webrtcSessionTtlMs: number;
  requireReceiptSignatures: boolean;
  maxPendingTasks: number;
}

export const CONFIG: PlasmaLabConfig = {
  port: parseInt(process.env.PORT ?? "7788", 10),
  storeBackend: storeBackend(),
  routesEnabled: envFlag("FEATURE_COMPUTE_LAB_ROUTES", false),
  taskAdminEnabled: envFlag("FEATURE_COMPUTE_TASK_ADMIN", false),
  publicRegistrationEnabled: envFlag("COMPUTE_PUBLIC_REGISTRATION", false),
  workerInviteTokens: envList("COMPUTE_WORKER_INVITE_TOKENS"),
  maxWorkersPerIp: envInt("COMPUTE_MAX_WORKERS_PER_IP", 8),
  maxSessionsPerClient: envInt("COMPUTE_MAX_SESSIONS_PER_CLIENT", 4),
  maxActiveAssignmentsPerIdentity: envInt("COMPUTE_MAX_ACTIVE_ASSIGNMENTS_PER_IDENTITY", 2),
  strictProofTasksDefault: envFlag("COMPUTE_STRICT_PROOF_TASKS_DEFAULT", true),
  acceptAssignments: envFlag("COMPUTE_ACCEPT_ASSIGNMENTS", false),
  webrtcSignalingEnabled: envFlag("FEATURE_COMPUTE_WEBRTC_SIGNALING", false),
  webrtcDataEnabled: envFlag("FEATURE_COMPUTE_WEBRTC_DATA", false),
  webrtcTurnEnabled: envFlag("FEATURE_COMPUTE_WEBRTC_TURN", false),
  stunUrls: envList("COMPUTE_STUN_URLS"),
  turnUrls: envList("COMPUTE_TURN_URLS"),
  turnUsername: process.env.COMPUTE_TURN_USERNAME,
  turnCredential: process.env.COMPUTE_TURN_CREDENTIAL,
  adminToken: process.env.PLASMA_LAB_ADMIN_TOKEN,
  assignmentTimeoutMs: parseInt(process.env.COMPUTE_ASSIGNMENT_TIMEOUT_MS ?? "60000", 10),
  workerSessionTtlMs: parseInt(process.env.COMPUTE_WORKER_SESSION_TTL_MS ?? "3600000", 10),
  webrtcSessionTtlMs: parseInt(process.env.COMPUTE_WEBRTC_SESSION_TTL_MS ?? "600000", 10),
  requireReceiptSignatures: envFlag("COMPUTE_REQUIRE_RECEIPT_SIGNATURES", true),
  maxPendingTasks: envInt("COMPUTE_MAX_PENDING_TASKS", 500),
};

function storeBackend(): "memory" | "firestore" {
  const raw = process.env.PLASMA_LAB_STORE_BACKEND ?? "memory";
  if (raw !== "memory" && raw !== "firestore") throw new Error("PLASMA_LAB_STORE_BACKEND must be memory or firestore");
  return raw;
}
