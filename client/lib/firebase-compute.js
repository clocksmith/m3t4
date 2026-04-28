import { firebase, httpsCallable, signInAnonymously } from "./firebase-client.js";

const OPT_IN_KEY = "m3t4.compute.optIn";
const CLIENT_ID_KEY = "m3t4.compute.clientId";
const POLICY_KEY = "m3t4.compute.policy";
const RECEIPTS_CACHE_KEY = "m3t4.compute.receipts";
const RECEIPTS_CACHE_LIMIT = 50;
const CLIENT_VERSION = "compute-firebase-p2p-v2";
const WORKER_KERNEL_IDS = Object.freeze([
  "prime-search.v0",
  "m3t4.public_artifact_verify.v0",
  "m3t4.replay_verify.v1",
  "m3t4.seed_sweep.v0",
  "asset.tile_audit.v0",
  "ml.image_tile_infer.v0",
  "science.contact_map_tile.v0",
  "science.mandelbrot_tile.v0",
  "science.heat_diffusion_tile.v0",
  "science.genome_kmer.v0",
  "science.microscopy_tile_score.v0",
  "m3t4.exploit_search.v0",
  "plasma.tensor_tile.v0",
  "device_witness.webgpu.v0",
  "device_witness.render_fixture.v0",
  "device_witness.derived_buffer.v0",
]);
const PEER_HEARTBEAT_MS = 30_000;
const POLL_MS = 4_000;
const PEER_TIMEOUT_MS = 6_500;
const JOIN_TIMEOUT_MS = 3_500;

const DEFAULT_POLICY = Object.freeze({
  pauseWhenHidden: false,
  pauseOnLowBattery: false,
  pauseOnRenderStruggle: false,
});

const MODE_PROFILE = {
  quiet: { pollMs: 5000, maxRenderMs: 10 },
  standard: { pollMs: 2500, maxRenderMs: 14 },
  "after-match": { pollMs: 2500, maxRenderMs: 14 },
};

class FirebaseComputeClient {
  constructor() {
    this.enabled = false;
    this.mode = "quiet";
    this.workerId = null;
    this.workerSessionId = null;
    this.workerSessionToken = null;
    this.clientId = null;
    this.accountUid = null;
    this.state = "idle";
    this.current = null;
    this.totals = { accepted: 0, rejected: 0, pending: 0 };
    this.listeners = new Set();
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.presenceUnsub = null;
    this.offerUnsub = null;
    this.handledSessions = new Set();
    this.frameSamples = [];
    this.lastFrameAt = 0;
    this.renderPauseUntil = 0;
    this.matchPhase = "intermission";
    this.policy = loadPolicy();
    this.debug = { lastPeerError: null, lastReceipt: null };
    this.peerAvailable = typeof RTCPeerConnection !== "undefined";
    this.available = typeof Worker !== "undefined" && !!globalThis.crypto?.subtle;
    this.onVisibility = () => this.reevaluate();
    this.onInput = () => {
      if (!this.policy.pauseOnRenderStruggle) return;
      this.renderPauseUntil = performance.now() + 1200;
      this.reevaluate();
    };
  }

  isAvailable() { return this.available; }
  hasOrigin() { return !!firebaseConfig(); }
  isConfigured() { return this.hasOrigin() && firebaseComputeFlagEnabled(); }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot() {
    return {
      available: this.available,
      configured: this.isConfigured(),
      originConfigured: this.hasOrigin(),
      workerFeatureEnabled: firebaseComputeFlagEnabled(),
      enabled: this.enabled,
      mode: this.mode,
      state: this.state,
      workerId: this.workerId,
      workerSessionId: this.workerSessionId,
      clientId: this.clientId ?? null,
      accountUid: this.accountUid ?? null,
      current: this.current ? { ...this.current } : null,
      totals: { ...this.totals },
      gate: this.currentGate(),
      frameP95Ms: p95(this.frameSamples),
      origin: "firebase-functions",
      optIn: persistedOptIn(),
      policy: { ...this.policy },
      webrtcArtifacts: this.peerAvailable,
      firebaseCompute: true,
    };
  }

  diagnostics() {
    return { snapshot: this.snapshot(), debug: cloneJson(this.debug) };
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn(this.snapshot()); } catch {}
    }
  }

  async maybeAutoStart() {
    if (this.isConfigured() && persistedOptIn()) await this.start({ persist: false });
  }

  async start(opts = {}) {
    if (!this.available) return;
    if (!this.isConfigured()) {
      this.state = this.hasOrigin() ? "feature-disabled" : "unconfigured";
      this.emit();
      return;
    }
    if (MODE_PROFILE[opts.mode]) this.mode = opts.mode;
    if (opts.persist !== false) persistOptIn(true);
    if (this.enabled) {
      this.reevaluate();
      return;
    }
    this.enabled = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pointerdown", this.onInput, { passive: true });
    window.addEventListener("keydown", this.onInput, { passive: true });
    await this.ensureRegistered();
    await this.advertisePresence();
    this.startHeartbeat();
    await this.listenForComputeOffers();
    this.reevaluate();
    this.emit();
  }

  async stop(opts = {}) {
    this.enabled = false;
    this.state = "idle";
    if (opts.persist !== false) persistOptIn(false);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointerdown", this.onInput);
    window.removeEventListener("keydown", this.onInput);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.current = null;
    if (this.offerUnsub) { try { this.offerUnsub(); } catch {} this.offerUnsub = null; }
    await this.dropPresence().catch(() => {});
    this.emit();
  }

  destroy() {
    void this.stop({ persist: false });
    this.listeners.clear();
  }

  setMode(mode) {
    if (!MODE_PROFILE[mode]) return;
    this.mode = mode;
    this.reevaluate();
    this.emit();
  }

  setMatchPhase(phase) {
    this.matchPhase = phase === "active" ? "active" : "intermission";
    this.reevaluate();
  }

  recordFrame(renderMs) {
    const now = performance.now();
    this.lastFrameAt = now;
    if (Number.isFinite(renderMs)) {
      this.frameSamples.push(Math.max(0, renderMs));
      if (this.frameSamples.length > 180) this.frameSamples.splice(0, this.frameSamples.length - 180);
    }
  }

  setPolicy(patch) {
    if (!patch || typeof patch !== "object") return;
    const next = { ...this.policy };
    for (const key of Object.keys(DEFAULT_POLICY)) {
      if (key in patch) next[key] = !!patch[key];
    }
    this.policy = next;
    savePolicy(next);
    if (!next.pauseOnRenderStruggle) this.renderPauseUntil = 0;
    this.reevaluate();
    this.emit();
  }

  currentGate() {
    if (!this.enabled) return "user-disabled";
    if (!this.hasOrigin()) return "unconfigured";
    if (!firebaseComputeFlagEnabled()) return "feature-disabled";
    if (this.policy.pauseWhenHidden && document.visibilityState !== "visible") return "tab-hidden";
    if (this.mode === "after-match" && this.matchPhase === "active") return "not-now";
    if (this.policy.pauseOnRenderStruggle) {
      if (performance.now() < this.renderPauseUntil) return "render-struggling";
      if (p95(this.frameSamples) > MODE_PROFILE[this.mode].maxRenderMs) return "render-struggling";
    }
    return null;
  }

  reevaluate() {
    if (!this.enabled) return;
    const gate = this.currentGate();
    if (gate) {
      this.state = `paused: ${gate}`;
      this.schedule(MODE_PROFILE[this.mode].pollMs);
      this.emit();
      return;
    }
    this.schedule(0);
  }

  schedule(delayMs = POLL_MS) {
    if (!this.enabled) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  async poll() {
    if (!this.enabled) return;
    const gate = this.currentGate();
    if (gate) {
      this.state = `paused: ${gate}`;
      this.schedule(MODE_PROFILE[this.mode].pollMs);
      this.emit();
      return;
    }
    try {
      await this.ensureRegistered();
      await this.advertisePresence();
      this.state = "claiming";
      this.emit();
      const claim = await callFunction("computeClaim", { workerId: this.workerId });
      if (!claim?.assignment) {
        this.state = "waiting";
        this.schedule(Number(claim?.retryAfterMs) || MODE_PROFILE[this.mode].pollMs);
        this.emit();
        return;
      }
      await this.runAssignment(claim);
      this.schedule(MODE_PROFILE[this.mode].pollMs);
    } catch (e) {
      this.state = `compute error: ${message(e)}`;
      this.schedule(MODE_PROFILE[this.mode].pollMs * 2);
      this.emit();
    }
  }

  async ensureRegistered() {
    if (this.workerId) return;
    const fb = await ensureFirebaseAuth();
    this.clientId = getOrCreateClientId();
    this.accountUid = readAccountUid() ?? fb.auth.currentUser?.uid ?? null;
    const result = await callFunction("computeRegister", {
      label: "firebase-browser",
      clientId: this.clientId,
      accountUid: this.accountUid || undefined,
      capability: {
        kernels: WORKER_KERNEL_IDS,
        runtimeSurfaces: runtimeSurfaces(),
        gpuPreferred: webgpuAvailable(),
        clientVersion: CLIENT_VERSION,
      },
    });
    this.workerId = result.workerId;
    this.workerSessionId = result.workerSessionId;
    this.workerSessionToken = result.workerSessionToken;
  }

  async runAssignment(work) {
    const assignment = work.assignment;
    const chunk = work.chunk;
    const task = work.task;
    this.current = {
      assignmentId: assignment.assignmentId,
      assignmentToken: assignment.assignmentToken,
      taskId: task.taskId,
      chunkId: chunk.chunkId,
      kind: chunk.kind,
      startedAt: performance.now(),
      determinismClass: "deterministic",
    };
    this.totals.pending++;
    this.state = `running ${chunk.kind}`;
    this.emit();

    let result = null;
    try {
      result = await this.runViaPeer(work);
    } catch (e) {
      this.debug.lastPeerError = { message: message(e), at: Date.now() };
      result = await this.runLocal(work, "firebase-fallback");
    }

    const receipt = {
      workerId: this.workerId,
      workerSessionId: this.workerSessionId,
      assignmentId: assignment.assignmentId,
      assignmentToken: assignment.assignmentToken,
      taskId: task.taskId,
      chunkId: chunk.chunkId,
      kernelId: chunk.kernelId,
      kernelHash: chunk.kernelHash,
      inputHash: chunk.inputHash,
      outputHash: { algorithm: "sha256", value: result.outputHash },
      determinismClass: "deterministic",
      validationMode: "expected-hash",
      executionMode: result.executionMode ?? "cpu",
      transport: result.transport,
      peerSubreceipt: result.peerSubreceipt ?? null,
      derived: result.derived ?? null,
      publicOutput: result.publicOutput ?? null,
      preview: result.preview ?? null,
      computeMs: result.computeMs,
      clientVersion: CLIENT_VERSION,
    };
    const body = await callFunction("computeSubmitReceipt", { receipt });
    this.totals.pending = Math.max(0, this.totals.pending - 1);
    const decision = body.receipt?.decision ?? "pending";
    if (decision === "accepted") this.totals.accepted++;
    else if (decision === "rejected") this.totals.rejected++;
    else this.totals.pending++;
    this.debug.lastReceipt = body.receipt ?? null;
    saveReceiptCache([body.receipt, ...loadReceiptCache()].filter(Boolean));
    this.state = `receipt: ${decision}`;
    this.current = null;
    this.emit();
  }

  async runLocal(work, transport) {
    const t0 = performance.now();
    const output = await runPlasmaWorkerChunk(work.assignment.assignmentId, work.chunk);
    return {
      output: output.publicOutput ?? null,
      outputHash: output.outputHash,
      derived: output.derived ?? null,
      publicOutput: output.publicOutput ?? null,
      preview: output.preview ?? null,
      computeMs: performance.now() - t0,
      executionMode: output.executionMode ?? (webgpuKernel(work.chunk.kind) ? "webgpu" : "cpu"),
      transport,
    };
  }

  async runViaPeer(work) {
    if (!this.peerAvailable) throw new Error("WebRTC unavailable");
    const peers = await this.listPeers(work.chunk.kind);
    if (!peers.length) throw new Error("no compute peer available");
    const peer = peers[0];
    const fb = await ensureFirebaseAuth();
    const session = await callFunction("webrtcSignal", { op: "create" });
    const pc = new RTCPeerConnection({ iceServers: configuredIceServers() });
    const channel = pc.createDataChannel("compute", { ordered: true });
    channel.binaryType = "arraybuffer";
    const { doc, onSnapshot } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const sessionRef = doc(fb.firestore, "webrtc", session.sessionId);
    let done = false;
    const unsub = onSnapshot(sessionRef, async (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.answer && !pc.currentRemoteDescription) {
        try { await pc.setRemoteDescription({ type: data.answer.type, sdp: data.answer.sdp }); } catch {}
      }
      if (Array.isArray(data.candidatesB)) {
        for (const c of data.candidatesB) {
          try { await pc.addIceCandidate(c); } catch {}
        }
      }
    });
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      callFunction("webrtcSignal", {
        op: "post",
        sessionId: session.sessionId,
        role: "offerer",
        payload: { candidates: [ev.candidate.toJSON()] },
      }).catch(() => {});
    };
    try {
      const resultPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("peer compute timeout")), PEER_TIMEOUT_MS);
        channel.onopen = () => {
          channel.send(JSON.stringify({
            protocol: "m3t4.compute.firebase.v1",
            type: "work",
            requestId: `req-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            assignment: work.assignment,
            task: work.task,
            chunk: work.chunk,
          }));
        };
        channel.onmessage = (ev) => {
          const msg = parseJson(ev.data);
          if (msg?.protocol !== "m3t4.compute.firebase.v1" || msg?.type !== "result") return;
          clearTimeout(timer);
          if (!msg.ok) reject(new Error(msg.error || "peer compute failed"));
          else resolve(msg);
        };
        channel.onerror = () => {
          clearTimeout(timer);
          reject(new Error("peer channel error"));
        };
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceGathering(pc, JOIN_TIMEOUT_MS);
      await callFunction("webrtcSignal", {
        op: "post",
        sessionId: session.sessionId,
        role: "offerer",
        payload: {
          offer: pc.localDescription,
          peerId: fb.auth.currentUser.uid,
          target: peer.peerId,
          purpose: "compute",
        },
      });
      const result = await resultPromise;
      done = true;
      return {
        outputHash: result.outputHash,
        output: result.output ?? null,
        derived: result.derived ?? null,
        publicOutput: result.publicOutput ?? null,
        preview: result.preview ?? null,
        computeMs: Number(result.computeMs) || 0,
        executionMode: result.executionMode || "cpu",
        transport: "webrtc",
        peerSubreceipt: result.peerSubreceipt ?? null,
      };
    } finally {
      if (!done) this.debug.lastPeerError = { message: "peer path fell back", at: Date.now() };
      try { unsub(); } catch {}
      try { channel.close(); } catch {}
      try { pc.close(); } catch {}
    }
  }

  async listPeers(kind) {
    const fb = await ensureFirebaseAuth();
    const { collection, getDocs, limit, orderBy, query } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const snap = await getDocs(query(
      collection(fb.firestore, "compute_peer_presence"),
      orderBy("lastSeenAt", "desc"),
      limit(8),
    ));
    const now = Date.now();
    const uid = fb.auth.currentUser?.uid;
    return snap.docs
      .map((docSnap) => docSnap.data())
      .filter((peer) => {
        if (!peer?.peerId || peer.peerId === uid || Number(peer.lastSeenAt ?? 0) <= now - 90_000) return false;
        if (peer.webrtc === false) return false;
        const kernels = Array.isArray(peer.kernels) ? peer.kernels : [];
        if (kernels.length && !kernels.includes(kind)) return false;
        const surfaces = Array.isArray(peer.runtimeSurfaces) ? peer.runtimeSurfaces : [];
        if (webgpuKernel(kind) && !surfaces.includes("webgpu")) return false;
        return true;
      });
  }

  async advertisePresence() {
    const fb = await ensureFirebaseAuth();
    const uid = fb.auth.currentUser?.uid;
    if (!uid || !this.workerId) return;
    const { doc, setDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    await setDoc(doc(fb.firestore, "compute_peer_presence", uid), {
      peerId: uid,
      workerId: this.workerId,
      clientId: this.clientId,
      kernels: WORKER_KERNEL_IDS,
      runtimeSurfaces: runtimeSurfaces(),
      gpuPreferred: webgpuAvailable(),
      webrtc: this.peerAvailable,
      lastSeenAt: Date.now(),
      clientVersion: CLIENT_VERSION,
    }, { merge: true });
  }

  async dropPresence() {
    const fb = firebase();
    const uid = fb?.auth?.currentUser?.uid;
    if (!fb || !uid) return;
    const { deleteDoc, doc } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    await deleteDoc(doc(fb.firestore, "compute_peer_presence", uid));
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.enabled) this.advertisePresence().catch(() => {});
    }, PEER_HEARTBEAT_MS);
  }

  async listenForComputeOffers() {
    if (this.offerUnsub) return;
    if (!this.peerAvailable) return;
    const fb = await ensureFirebaseAuth();
    const uid = fb.auth.currentUser?.uid;
    if (!uid) return;
    const { collection, onSnapshot, query, where } = await import(
      "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
    );
    const q = query(
      collection(fb.firestore, "webrtc"),
      where("offer.target", "==", uid),
    );
    this.offerUnsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added" && change.type !== "modified") return;
        if (this.handledSessions.has(change.doc.id)) return;
        const data = change.doc.data();
        if (!data?.offer || data.offer.purpose !== "compute" || data.answer) return;
        this.handledSessions.add(change.doc.id);
        this.acceptComputeOffer(change.doc.id, data).catch((e) => {
          this.debug.lastPeerError = { message: message(e), at: Date.now() };
        });
      });
    });
  }

  async acceptComputeOffer(sessionId, sessionData) {
    const pc = new RTCPeerConnection({ iceServers: configuredIceServers() });
    let channel = null;
    pc.ondatachannel = (ev) => {
      channel = ev.channel;
      channel.onmessage = async (msgEv) => {
        const msg = parseJson(msgEv.data);
        if (msg?.protocol !== "m3t4.compute.firebase.v1" || msg?.type !== "work") return;
        try {
          const t0 = performance.now();
          const output = await runPlasmaWorkerChunk(msg.assignment?.assignmentId ?? msg.requestId, msg.chunk);
          const elapsed = performance.now() - t0;
          channel.send(JSON.stringify({
            protocol: "m3t4.compute.firebase.v1",
            type: "result",
            ok: true,
            requestId: msg.requestId,
            output: output.publicOutput ?? null,
            outputHash: output.outputHash,
            derived: output.derived ?? null,
            publicOutput: output.publicOutput ?? null,
            preview: output.preview ?? null,
            computeMs: elapsed,
            executionMode: output.executionMode ?? (webgpuKernel(msg.chunk?.kind) ? "webgpu" : "cpu"),
            peerSubreceipt: {
              protocol: "m3t4.compute.firebase.peer-subreceipt.v1",
              workerId: this.workerId,
              workerSessionId: this.workerSessionId,
              assignmentId: msg.assignment?.assignmentId ?? null,
              taskId: msg.task?.taskId ?? null,
              chunkId: msg.chunk?.chunkId ?? null,
              kernelId: msg.chunk?.kernelId ?? msg.chunk?.kind ?? null,
              outputHash: { algorithm: "sha256", value: output.outputHash },
              computeMs: elapsed,
              executionMode: output.executionMode ?? (webgpuKernel(msg.chunk?.kind) ? "webgpu" : "cpu"),
              clientVersion: CLIENT_VERSION,
            },
          }));
        } catch (e) {
          channel.send(JSON.stringify({
            protocol: "m3t4.compute.firebase.v1",
            type: "result",
            ok: false,
            requestId: msg.requestId,
            error: message(e),
          }));
        }
      };
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      callFunction("webrtcSignal", {
        op: "post",
        sessionId,
        role: "answerer",
        payload: { candidates: [ev.candidate.toJSON()] },
      }).catch(() => {});
    };
    await pc.setRemoteDescription({ type: sessionData.offer.type, sdp: sessionData.offer.sdp });
    if (Array.isArray(sessionData.candidatesA)) {
      for (const c of sessionData.candidatesA) {
        try { await pc.addIceCandidate(c); } catch {}
      }
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGathering(pc, JOIN_TIMEOUT_MS);
    await callFunction("webrtcSignal", {
      op: "post",
      sessionId,
      role: "answerer",
      payload: { answer: pc.localDescription, peerId: firebase().auth.currentUser?.uid },
    });
    setTimeout(() => {
      try { pc.close(); } catch {}
    }, PEER_TIMEOUT_MS * 2);
  }

  async submitReceipt(receipt) {
    return callFunction("computeSubmitReceipt", { receipt });
  }

  async fetchMyReceipts(limitCount = 50) {
    try {
      await ensureFirebaseAuth();
      const body = await callFunction("computeMyReceipts", { limit: limitCount });
      const receipts = Array.isArray(body.receipts) ? body.receipts : [];
      saveReceiptCache(receipts);
      return { scope: body.scope ?? "account", accountUid: body.accountUid ?? null, receipts };
    } catch {
      return { scope: "browser", clientId: this.clientId, accountUid: this.accountUid, receipts: loadReceiptCache() };
    }
  }

  async fetchPublicSummary() {
    await ensureFirebaseAuth();
    return callFunction("computePublicSummary", {});
  }
}

let singleton = null;

export function getFirebaseComputeClient() {
  if (!singleton) singleton = new FirebaseComputeClient();
  return singleton;
}

export function firebaseComputeEnabled() {
  return firebaseComputeFlagEnabled();
}

async function callFunction(name, payload) {
  const fb = await ensureFirebaseAuth();
  const fn = httpsCallable(fb.functions, name);
  const res = await fn(payload);
  return res.data;
}

async function ensureFirebaseAuth() {
  const fb = firebase();
  if (!fb) throw new Error("Firebase not configured");
  if (!fb.auth.currentUser) await signInAnonymously(fb.auth);
  return fb;
}

function firebaseConfig() {
  if (typeof window === "undefined") return null;
  return window.__M3T4_FIREBASE_CONFIG__ ?? window.__M3T4_FIREBASE__ ?? null;
}

function firebaseComputeFlagEnabled() {
  return typeof window !== "undefined" && window.__M3T4_COMPUTE_FIREBASE__ === true;
}

function persistedOptIn() {
  try { return localStorage.getItem(OPT_IN_KEY) === "true"; } catch { return false; }
}

function persistOptIn(value) {
  try { localStorage.setItem(OPT_IN_KEY, value ? "true" : "false"); } catch {}
}

function getOrCreateClientId() {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID ? crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, next);
    return next;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function readAccountUid() {
  const raw = globalThis.__M3T4_COMPUTE_ACCOUNT_UID__;
  return typeof raw === "string" && raw ? raw : null;
}

function loadPolicy() {
  try {
    const parsed = JSON.parse(localStorage.getItem(POLICY_KEY) || "null");
    return { ...DEFAULT_POLICY, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function savePolicy(policy) {
  try { localStorage.setItem(POLICY_KEY, JSON.stringify(policy)); } catch {}
}

function loadReceiptCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEIPTS_CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReceiptCache(receipts) {
  try {
    localStorage.setItem(RECEIPTS_CACHE_KEY, JSON.stringify(receipts.slice(0, RECEIPTS_CACHE_LIMIT)));
  } catch {}
}

function runtimeSurfaces() {
  const surfaces = ["cpu"];
  if (typeof RTCPeerConnection !== "undefined") surfaces.push("webrtc");
  if (webgpuAvailable()) surfaces.push("webgpu");
  return surfaces;
}

function webgpuAvailable() {
  return !!globalThis.navigator?.gpu;
}

function webgpuKernel(kind) {
  return kind === "device_witness.webgpu.v0"
    || kind === "plasma.tensor_tile.v0"
    || kind === "science.contact_map_tile.v0"
    || kind === "science.mandelbrot_tile.v0"
    || kind === "science.heat_diffusion_tile.v0";
}

function runPlasmaWorkerChunk(assignmentId, chunk) {
  if (typeof Worker === "undefined") throw new Error("Worker unavailable");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/plasma-worker.js", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch {}
      reject(new Error("plasma worker timeout"));
    }, 45_000);
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.assignmentId !== assignmentId) return;
      clearTimeout(timer);
      try { worker.terminate(); } catch {}
      if (msg.type === "done") resolve(msg);
      else reject(new Error(msg.message || "plasma worker failed"));
    };
    worker.onerror = (ev) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch {}
      reject(new Error(ev.message || "plasma worker error"));
    };
    worker.postMessage({ type: "run", assignmentId, chunk });
  });
}

function runPrimeSearch(params) {
  const start = Math.max(0, Math.trunc(Number(params?.start ?? 0)));
  const endExclusive = Math.max(start, Math.trunc(Number(params?.endExclusive ?? start)));
  let count = 0;
  let sum = 0;
  let first = null;
  let last = null;
  for (let n = start; n < endExclusive; n++) {
    if (!isPrime(n)) continue;
    count++;
    sum += n;
    if (first === null) first = n;
    last = n;
  }
  return { count, sum, first, last };
}

function isPrime(n) {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  const max = Math.floor(Math.sqrt(n));
  for (let d = 3; d <= max; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}

async function outputHash(kind, params, output) {
  return hashText(stableJson({ kind, params, output }));
}

async function hashText(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function configuredIceServers() {
  const configured = window.__M3T4_COMPUTE_ICE_SERVERS__;
  if (Array.isArray(configured) && configured.length > 0) return configured;
  const urls = Array.isArray(window.__M3T4_COMPUTE_STUN_URLS__)
    ? window.__M3T4_COMPUTE_STUN_URLS__.filter((url) => typeof url === "string" && /^stuns?:/i.test(url))
    : [];
  return urls.length ? [{ urls }] : [{ urls: "stun:stun.l.google.com:19302" }];
}

function waitIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    });
  });
}

function parseJson(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
