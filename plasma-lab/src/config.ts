function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export interface PlasmaLabConfig {
  port: number;
  storeBackend: "memory" | "firestore";
  routesEnabled: boolean;
  taskAdminEnabled: boolean;
  acceptAssignments: boolean;
  webrtcSignalingEnabled: boolean;
  webrtcDataEnabled: boolean;
  adminToken?: string;
  assignmentTimeoutMs: number;
  workerSessionTtlMs: number;
  webrtcSessionTtlMs: number;
}

export const CONFIG: PlasmaLabConfig = {
  port: parseInt(process.env.PORT ?? "7788", 10),
  storeBackend: storeBackend(),
  routesEnabled: envFlag("FEATURE_COMPUTE_LAB_ROUTES", false),
  taskAdminEnabled: envFlag("FEATURE_COMPUTE_TASK_ADMIN", false),
  acceptAssignments: envFlag("COMPUTE_ACCEPT_ASSIGNMENTS", false),
  webrtcSignalingEnabled: envFlag("FEATURE_COMPUTE_WEBRTC_SIGNALING", false),
  webrtcDataEnabled: envFlag("FEATURE_COMPUTE_WEBRTC_DATA", false),
  adminToken: process.env.PLASMA_LAB_ADMIN_TOKEN,
  assignmentTimeoutMs: parseInt(process.env.COMPUTE_ASSIGNMENT_TIMEOUT_MS ?? "60000", 10),
  workerSessionTtlMs: parseInt(process.env.COMPUTE_WORKER_SESSION_TTL_MS ?? "3600000", 10),
  webrtcSessionTtlMs: parseInt(process.env.COMPUTE_WEBRTC_SESSION_TTL_MS ?? "600000", 10),
};

function storeBackend(): "memory" | "firestore" {
  const raw = process.env.PLASMA_LAB_STORE_BACKEND ?? "memory";
  if (raw !== "memory" && raw !== "firestore") throw new Error("PLASMA_LAB_STORE_BACKEND must be memory or firestore");
  return raw;
}
