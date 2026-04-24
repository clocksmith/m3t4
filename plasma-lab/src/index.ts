import http from "node:http";
import { CONFIG } from "./config.js";
import { json } from "./http.js";
import { handleComputeLabRequest } from "./routes.js";
import { ComputeLabStore } from "./store.js";
import { PersistentComputeLabStore } from "./persistent-store.js";
import { FirestoreComputeLabPersistence } from "./firestore-persistence.js";

const storeOptions = {
  acceptAssignments: CONFIG.acceptAssignments,
  assignmentTimeoutMs: CONFIG.assignmentTimeoutMs,
  workerSessionTtlMs: CONFIG.workerSessionTtlMs,
  webrtcSessionTtlMs: CONFIG.webrtcSessionTtlMs,
  requireReceiptSignatures: CONFIG.requireReceiptSignatures,
  maxWorkersPerIp: CONFIG.maxWorkersPerIp,
  maxSessionsPerClient: CONFIG.maxSessionsPerClient,
  maxActiveAssignmentsPerIdentity: CONFIG.maxActiveAssignmentsPerIdentity,
};

const store = CONFIG.storeBackend === "firestore"
  ? await PersistentComputeLabStore.create(storeOptions, new FirestoreComputeLabPersistence())
  : new ComputeLabStore(storeOptions);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (await handleComputeLabRequest(req, res, url, { store, config: CONFIG })) return;
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(CONFIG.port, () => {
  console.log(JSON.stringify({
    service: "plasma-lab",
    port: CONFIG.port,
    storeBackend: CONFIG.storeBackend,
    routesEnabled: CONFIG.routesEnabled,
    taskAdminEnabled: CONFIG.taskAdminEnabled,
    acceptAssignments: CONFIG.acceptAssignments,
    webrtcSignalingEnabled: CONFIG.webrtcSignalingEnabled,
    webrtcDataEnabled: CONFIG.webrtcDataEnabled,
    webrtcTurnEnabled: CONFIG.webrtcTurnEnabled,
    requireReceiptSignatures: CONFIG.requireReceiptSignatures,
  }));
});
