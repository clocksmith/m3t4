// Hidden spectator slack worker for plasma-lab.
//
// This is intentionally dormant by default. It only runs when:
//   1. deploy-time config sets window.__M3T4_COMPUTE_SLACK_WORKER__ = true
//   2. deploy-time config sets window.__M3T4_COMPUTE_LAB_ORIGIN__
//   3. the user has explicitly opted in via the console helper:
//      window.m3t4Compute.start()
//
// Live rendering owns the device. This client only borrows slack and refuses
// work whenever the tab is hidden, battery is low, frames are struggling, or
// the current mode says work should wait until intermission.

const OPT_IN_KEY = "m3t4.compute.optIn";
const CLIENT_VERSION = "compute-slack-http-v0";
const SESSION_TOKEN_HEADER = "x-worker-session-token";
const PUBLIC_ARTIFACT_KERNEL = "m3t4.public_artifact_verify.v0";
const REPLAY_VERIFY_KERNEL = "m3t4.replay_verify.v1";

const MODE_PROFILE = {
  quiet: { pollMs: 5000, cooldownMs: 2000, maxRenderMs: 10 },
  standard: { pollMs: 2000, cooldownMs: 1000, maxRenderMs: 14 },
  "after-match": { pollMs: 1500, cooldownMs: 750, maxRenderMs: 14 },
};

class ComputeClient {
  constructor() {
    this.enabled = false;
    this.mode = "quiet";
    this.worker = null;
    this.workerId = null;
    this.workerSessionId = null;
    this.workerSessionToken = null;
    this.state = "idle";
    this.current = null;
    this.totals = { accepted: 0, rejected: 0, pending: 0 };
    this.listeners = new Set();
    this.pollTimer = null;
    this.battery = null;
    this.capability = null;
    this.health = {
      droppedFrameBursts: 0,
      hiddenPauses: 0,
      lowBatteryPauses: 0,
      renderStrugglePauses: 0,
      notNowPauses: 0,
      assignmentsStarted: 0,
      receiptsSubmitted: 0,
    };
    this.lastGate = null;
    this.lastCapabilityUpdateAt = 0;
    this.lastConnectivityReportAt = 0;
    this.connectivityProbeInFlight = false;
    this.matchPhase = "intermission";
    this.frameSamples = [];
    this.lastFrameAt = 0;
    this.renderPauseUntil = 0;
    this.onVisibility = () => {
      this.health.hiddenPauses++;
      this.reevaluate();
    };
    this.onInput = () => {
      this.renderPauseUntil = performance.now() + 1200;
      this.reevaluate();
    };
    this.onBattery = () => this.reevaluate();
    this.available = typeof Worker !== "undefined" && !!globalThis.crypto?.subtle;
  }

  isAvailable() {
    return this.available;
  }

  isConfigured() {
    return !!computeLabOrigin() && computeFlagEnabled();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot() {
    return {
      available: this.available,
      configured: this.isConfigured(),
      enabled: this.enabled,
      mode: this.mode,
      state: this.state,
      workerId: this.workerId,
      workerSessionId: this.workerSessionId,
      current: this.current ? { ...this.current } : null,
      totals: { ...this.totals },
      gate: this.currentGate(),
      frameP95Ms: p95(this.frameSamples),
      origin: computeLabOrigin(),
      optIn: persistedOptIn(),
      webrtcArtifacts: artifactWebRtcEnabled(),
    };
  }

  emit() {
    for (const fn of this.listeners) fn(this.snapshot());
  }

  async maybeAutoStart() {
    if (this.isConfigured() && persistedOptIn()) await this.start({ persist: false });
  }

  async start(opts = {}) {
    if (!this.available) return;
    if (!this.isConfigured()) {
      this.state = "unconfigured";
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
    if (navigator.getBattery && !this.battery) {
      try {
        this.battery = await navigator.getBattery();
        this.battery.addEventListener("levelchange", this.onBattery);
        this.battery.addEventListener("chargingchange", this.onBattery);
      } catch {
        this.battery = null;
      }
    }
    await this.ensureWorkerRegistered();
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
    this.pollTimer = null;
    this.current = null;
    this.emit();
  }

  destroy() {
    this.stop({ persist: false });
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
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
    if (this.lastFrameAt && now - this.lastFrameAt > 45) {
      this.renderPauseUntil = now + 8000;
      this.health.droppedFrameBursts++;
    }
    this.lastFrameAt = now;
    if (Number.isFinite(renderMs)) {
      this.frameSamples.push(Math.max(0, renderMs));
      if (this.frameSamples.length > 180) this.frameSamples.splice(0, this.frameSamples.length - 180);
    }
  }

  currentGate() {
    if (!this.enabled) return "user-disabled";
    if (!this.isConfigured()) return "unconfigured";
    if (document.visibilityState !== "visible") return "tab-hidden";
    if (this.battery && !this.battery.charging && this.battery.level < 0.35) return "low-battery";
    if (this.mode === "after-match" && this.matchPhase === "active") return "not-now";
    if (performance.now() < this.renderPauseUntil) return "render-struggling";
    const renderP95 = p95(this.frameSamples);
    if (renderP95 > MODE_PROFILE[this.mode].maxRenderMs) return "render-struggling";
    return null;
  }

  async ensureWorkerRegistered() {
    if (this.workerId && this.workerSessionId && this.workerSessionToken) return;
    try {
      this.capability = await buildCapability(runtimeInfoBucket(this), { benchmark: true });
      const res = await fetch(computeLabOrigin() + "/compute/workers/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "browser-spectator",
          capability: this.capability,
        }),
      });
      if (!res.ok) throw new Error(`register failed: ${res.status}`);
      const body = await res.json();
      this.workerId = body.workerId;
      this.workerSessionId = body.workerSessionId;
      this.workerSessionToken = body.workerSessionToken;
      this.lastCapabilityUpdateAt = performance.now();
    } catch (e) {
      this.state = `register-failed: ${message(e)}`;
      this.enabled = false;
      persistOptIn(false);
    }
  }

  reevaluate() {
    if (!this.enabled) {
      this.schedule(null);
      this.emit();
      return;
    }
    const gate = this.currentGate();
    if (gate) {
      this.noteGate(gate);
      this.state = `paused (${gate})`;
      this.schedule(gate === "render-struggling" ? 5000 : null);
      this.emit();
      return;
    }
    this.lastGate = null;
    if (this.current) return;
    this.state = "idle";
    this.schedule(MODE_PROFILE[this.mode].pollMs);
    this.emit();
  }

  schedule(ms) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (ms == null || !this.enabled) return;
    this.pollTimer = setTimeout(() => this.poll(), ms);
  }

  async poll() {
    if (!this.enabled) return;
    if (this.current) return;
    if (!this.workerId) {
      await this.ensureWorkerRegistered();
      if (!this.workerId) return;
    }
    const gate = this.currentGate();
    if (gate) {
      if (gate === "render-struggling") this.schedule(5000);
      this.reevaluate();
      return;
    }
    try {
      await this.heartbeat();
      const params = new URLSearchParams({
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
      });
      const res = await fetch(computeLabOrigin() + `/compute/tasks/next?${params}`, {
        headers: { [SESSION_TOKEN_HEADER]: this.workerSessionToken },
      });
      if (!res.ok) throw new Error(`next failed: ${res.status}`);
      const body = await res.json();
      if (body.idle) {
        this.state = body.reason ?? "no-work";
        this.maybeReportConnectivity();
        this.schedule(MODE_PROFILE[this.mode].pollMs);
        this.emit();
        return;
      }
      await this.acceptAssignment(body.assignment);
      this.runAssignment(body);
    } catch (e) {
      this.state = `poll error: ${message(e)}`;
      this.schedule(Math.max(5000, MODE_PROFILE[this.mode].pollMs));
      this.emit();
    }
  }

  async heartbeat() {
    await fetch(computeLabOrigin() + "/compute/workers/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        workerSessionToken: this.workerSessionToken,
        governorMode: this.mode,
      }),
    });
    await this.maybeUpdateCapability();
  }

  async maybeUpdateCapability() {
    const now = performance.now();
    if (!this.workerId || now - this.lastCapabilityUpdateAt < 120000) return;
    this.lastCapabilityUpdateAt = now;
    try {
      this.capability = await buildCapability(runtimeInfoBucket(this), { benchmark: false });
      await fetch(computeLabOrigin() + "/compute/capabilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workerId: this.workerId,
          workerSessionId: this.workerSessionId,
          workerSessionToken: this.workerSessionToken,
          capability: this.capability,
        }),
      });
    } catch {
      // Capability updates are advisory; assignment receipts carry validation.
    }
  }

  async maybeReportConnectivity() {
    const now = performance.now();
    if (!this.workerId || this.connectivityProbeInFlight) return;
    if (now - this.lastConnectivityReportAt < 300000) return;
    this.lastConnectivityReportAt = now;
    this.connectivityProbeInFlight = true;
    try {
      const observations = await buildConnectivityObservations(this);
      for (const observation of observations) {
        await fetch(computeLabOrigin() + "/compute/connectivity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workerId: this.workerId,
            workerSessionId: this.workerSessionId,
            workerSessionToken: this.workerSessionToken,
            ...observation,
          }),
        });
      }
    } catch {
      // Connectivity witness data is advisory; failed probes should not affect work.
    } finally {
      this.connectivityProbeInFlight = false;
    }
  }

  async witnessWebRtc() {
    if (!this.isConfigured()) throw new Error("compute lab unconfigured");
    await this.ensureWorkerRegistered();
    if (!this.workerId) throw new Error("worker registration failed");
    const observation = {
      ...connectivityCommonFields(this),
      transport: "webrtc-signaling",
      ...(await signaledWebRtcProbe(this, 8000)),
    };
    await fetch(computeLabOrigin() + "/compute/connectivity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        workerSessionToken: this.workerSessionToken,
        ...observation,
      }),
    });
    return observation;
  }

  async acceptAssignment(assignment) {
    const gate = this.currentGate();
    await fetch(computeLabOrigin() + "/compute/assignments/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        workerSessionToken: this.workerSessionToken,
        assignmentId: assignment.assignmentId,
        assignmentToken: assignment.assignmentToken,
        refusalReason: gate || undefined,
      }),
    });
    if (gate) throw new Error(gate);
  }

  runAssignment({ assignment, chunk, task }) {
    this.schedule(null);
    if (chunk.kind === "device_witness.webrtc.v0") {
      this.runWebRtcAssignment({ assignment, chunk, task });
      return;
    }
    if (webRtcDataKernel(chunk.kind) && artifactWebRtcEnabled()) {
      this.runWebRtcArtifactAssignment({ assignment, chunk, task });
      return;
    }
    this.runWorkerAssignment({ assignment, chunk, task });
  }

  runWorkerAssignment({ assignment, chunk, task }) {
    this.current = {
      assignmentId: assignment.assignmentId,
      assignmentToken: assignment.assignmentToken,
      chunkId: chunk.chunkId,
      taskId: task.taskId,
      kind: chunk.kind,
      startedAt: performance.now(),
    };
    this.health.assignmentsStarted++;
    this.state = `running ${chunk.kind}`;
    this.emit();
    if (!this.worker) this.worker = this.spawnWorker();
    this.worker.postMessage({ type: "run", assignmentId: assignment.assignmentId, chunk });
  }

  async runWebRtcAssignment({ assignment, chunk, task }) {
    this.current = {
      assignmentId: assignment.assignmentId,
      assignmentToken: assignment.assignmentToken,
      chunkId: chunk.chunkId,
      taskId: task.taskId,
      kind: chunk.kind,
      startedAt: performance.now(),
    };
    this.health.assignmentsStarted++;
    this.state = `running ${chunk.kind}`;
    this.emit();
    try {
      const t0 = performance.now();
      const timeoutMs = Number(chunk.params?.timeoutMs) || 1800;
      const status = await computeLabStatus();
      const probe = status?.webrtcSignalingEnabled
        ? await signaledWebRtcProbe(this, Math.max(timeoutMs, 4500))
        : await localWebRtcProbe(timeoutMs);
      const transcript = webRtcTranscript(this, probe);
      const outputHash = await hashText(stableJson({
        kind: chunk.kind,
        params: chunk.params,
        transcript,
      }));
      const receipt = {
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        workerSessionToken: this.workerSessionToken,
        assignmentId: assignment.assignmentId,
        assignmentToken: assignment.assignmentToken,
        taskId: task.taskId,
        chunkId: chunk.chunkId,
        kernelId: chunk.kernelId,
        kernelHash: chunk.kernelHash,
        inputHash: chunk.inputHash,
        outputHash: { algorithm: "sha256", value: outputHash },
        determinismClass: "replicated-quorum",
        validationMode: "measurement",
        executionMode: "cpu",
        transport: "webrtc",
        governorMode: this.mode,
        deviceClass: this.capability?.deviceClass || deviceClass(),
        adapterInfo: transcript,
        computeMs: performance.now() - t0,
        clientVersion: CLIENT_VERSION,
      };
      const res = await fetch(computeLabOrigin() + "/compute/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
      });
      if (!res.ok) throw new Error(`receipt failed: ${res.status}`);
      const body = await res.json();
      this.health.receiptsSubmitted++;
      const decision = body.receipt?.decision ?? "pending";
      if (decision === "accepted") this.totals.accepted++;
      else if (decision === "pending") this.totals.pending++;
      else this.totals.rejected++;
      this.state = `receipt: ${decision}`;
    } catch (e) {
      this.state = `receipt error: ${message(e)}`;
      this.totals.rejected++;
    } finally {
      this.current = null;
      this.schedule(MODE_PROFILE[this.mode].cooldownMs);
      this.emit();
    }
  }

  async runWebRtcArtifactAssignment({ assignment, chunk, task }) {
    this.current = {
      assignmentId: assignment.assignmentId,
      assignmentToken: assignment.assignmentToken,
      chunkId: chunk.chunkId,
      taskId: task.taskId,
      kind: chunk.kind,
      startedAt: performance.now(),
    };
    this.health.assignmentsStarted++;
    this.state = `running ${chunk.kind} over webrtc`;
    this.emit();
    try {
      const status = await computeLabStatus();
      if (!status?.webrtcSignalingEnabled || !status?.webrtcDataEnabled) {
        throw new Error("webrtc artifact transport disabled");
      }
      const transfer = await runWebRtcArtifactTransfer(this, { assignment, chunk, task }, 6500);
      const receipt = {
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        workerSessionToken: this.workerSessionToken,
        assignmentId: assignment.assignmentId,
        assignmentToken: assignment.assignmentToken,
        taskId: task.taskId,
        chunkId: chunk.chunkId,
        kernelId: chunk.kernelId,
        kernelHash: chunk.kernelHash,
        inputHash: chunk.inputHash,
        artifactHash: chunk.artifactHash,
        outputHash: { algorithm: "sha256", value: transfer.outputHash },
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        executionMode: transfer.executionMode || "cpu",
        transport: "webrtc",
        governorMode: this.mode,
        deviceClass: this.capability?.deviceClass || deviceClass(),
        adapterInfo: {
          ...(this.capability?.adapterInfo || adapterInfoBucket()),
          ...transfer.transcript,
        },
        computeMs: transfer.computeMs,
        clientVersion: CLIENT_VERSION,
      };
      const res = await fetch(computeLabOrigin() + "/compute/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
      });
      if (!res.ok) throw new Error(`receipt failed: ${res.status}`);
      const body = await res.json();
      this.health.receiptsSubmitted++;
      const decision = body.receipt?.decision ?? "pending";
      if (decision === "accepted") this.totals.accepted++;
      else if (decision === "pending") this.totals.pending++;
      else this.totals.rejected++;
      this.state = `receipt: ${decision}`;
      this.current = null;
      this.schedule(MODE_PROFILE[this.mode].cooldownMs);
      this.emit();
    } catch (e) {
      this.current = null;
      if (artifactWebRtcStrict()) {
        this.state = `webrtc artifact failed: ${message(e)}`;
        this.totals.rejected++;
        this.schedule(MODE_PROFILE[this.mode].cooldownMs);
        this.emit();
        return;
      }
      this.state = `webrtc artifact fallback: ${message(e)}`;
      this.emit();
      this.runWorkerAssignment({ assignment, chunk, task });
    }
  }

  spawnWorker() {
    const worker = new Worker(new URL("../workers/plasma-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => this.onWorkerMessage(ev.data);
    worker.onerror = (err) => {
      this.state = `worker error: ${err.message}`;
      this.current = null;
      this.emit();
      this.schedule(5000);
    };
    return worker;
  }

  async onWorkerMessage(msg) {
    if (!this.current || msg.assignmentId !== this.current.assignmentId) return;
    const current = this.current;
    this.current = null;
    if (msg.type === "error") {
      this.totals.rejected++;
      this.state = `kernel error: ${msg.message}`;
      this.schedule(MODE_PROFILE[this.mode].cooldownMs);
      this.emit();
      return;
    }
    try {
      const receipt = {
        workerId: this.workerId,
        workerSessionId: this.workerSessionId,
        workerSessionToken: this.workerSessionToken,
        assignmentId: current.assignmentId,
        assignmentToken: current.assignmentToken,
        taskId: current.taskId,
        chunkId: current.chunkId,
        kernelId: msg.kernelId,
        kernelHash: msg.kernelHash,
        inputHash: msg.inputHash,
        artifactHash: msg.artifactHash,
        outputHash: { algorithm: "sha256", value: msg.outputHash },
        derived: msg.derived,
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        executionMode: msg.executionMode || "cpu",
        transport: "http",
        governorMode: this.mode,
        deviceClass: this.capability?.deviceClass || deviceClass(),
        adapterInfo: this.capability?.adapterInfo || adapterInfoBucket(),
        computeMs: msg.computeMs,
        clientVersion: CLIENT_VERSION,
      };
      const res = await fetch(computeLabOrigin() + "/compute/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
      });
      if (!res.ok) throw new Error(`receipt failed: ${res.status}`);
      const body = await res.json();
      this.health.receiptsSubmitted++;
      const decision = body.receipt?.decision ?? "pending";
      if (decision === "accepted") this.totals.accepted++;
      else if (decision === "pending") this.totals.pending++;
      else this.totals.rejected++;
      this.state = `receipt: ${decision}`;
    } catch (e) {
      this.state = `receipt error: ${message(e)}`;
      this.totals.rejected++;
    }
    this.schedule(MODE_PROFILE[this.mode].cooldownMs);
    this.emit();
  }

  noteGate(gate) {
    if (this.lastGate === gate) return;
    this.lastGate = gate;
    if (gate === "tab-hidden") this.health.hiddenPauses++;
    else if (gate === "low-battery") this.health.lowBatteryPauses++;
    else if (gate === "render-struggling") this.health.renderStrugglePauses++;
    else if (gate === "not-now") this.health.notNowPauses++;
  }
}

let singleton = null;

export function getComputeClient() {
  if (!singleton) singleton = new ComputeClient();
  installConsoleHelper(singleton);
  return singleton;
}

function installConsoleHelper(client) {
  if (typeof window === "undefined" || window.m3t4Compute) return;
  window.m3t4Compute = {
    start: (mode = "quiet") => client.start({ mode, persist: true }),
    stop: () => client.stop({ persist: true }),
    status: () => client.snapshot(),
    mode: (mode) => client.setMode(mode),
    webrtcWitness: () => client.witnessWebRtc(),
  };
}

function computeLabOrigin() {
  return String(window.__M3T4_COMPUTE_LAB_ORIGIN__ || "").replace(/\/+$/, "");
}

function computeFlagEnabled() {
  return window.__M3T4_COMPUTE_SLACK_WORKER__ === true;
}

function artifactWebRtcEnabled() {
  return window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS__ === true;
}

function artifactWebRtcStrict() {
  return window.__M3T4_COMPUTE_WEBRTC_ARTIFACTS_STRICT__ === true;
}

function persistedOptIn() {
  try {
    return localStorage.getItem(OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}

function persistOptIn(value) {
  try {
    if (value) localStorage.setItem(OPT_IN_KEY, "1");
    else localStorage.removeItem(OPT_IN_KEY);
  } catch {
    // localStorage can be unavailable in private contexts.
  }
}

function p95(samples) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function deviceClass() {
  const cores = navigator.hardwareConcurrency || 0;
  const ua = navigator.userAgent || "";
  const mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  if (mobile) return "mobile-browser";
  if (cores >= 8) return "desktop-high";
  if (cores >= 4) return "desktop-mid";
  return "desktop-low";
}

function adapterInfoBucket() {
  return {
    coreBucket: bucketCores(navigator.hardwareConcurrency || 0),
    userAgentBucket: /Firefox/i.test(navigator.userAgent) ? "firefox"
      : /Chrome|Chromium|Edg/i.test(navigator.userAgent) ? "chromium"
      : /Safari/i.test(navigator.userAgent) ? "safari"
      : "other",
  };
}

async function buildCapability(runtimeInfo = {}, opts = {}) {
  const webgpu = await webgpuInfoBucket(opts.benchmark === true);
  const deviceWitness = await workerDeviceWitnessBucket(opts.benchmark === true);
  const runtimeSurfaces = ["browser-js"];
  if (webgpu.webgpu === "available") runtimeSurfaces.push("browser-webgpu");
  const kernels = ["m3t4.public_artifact_verify.v0", "prime-search.v0"];
  kernels.push("m3t4.replay_verify.v1");
  if (deviceWitness.canvas2dFixture === "ok" || deviceWitness.canvas2dFixture === "mismatch") {
    kernels.push("device_witness.render_fixture.v0");
    kernels.push("device_witness.derived_buffer.v0");
  }
  if (webgpu.webgpu === "available") kernels.push("device_witness.webgpu.v0");
  if (typeof RTCPeerConnection !== "undefined") kernels.push("device_witness.webrtc.v0");
  const adapterInfo = {
    ...adapterInfoBucket(),
    ...webgpu,
    ...deviceWitness,
    ...runtimeInfo,
  };
  const capability = {
    kernels,
    runtimeSurfaces,
    maxChunkBytes: 64 * 1024,
    maxConcurrentChunks: 1,
    deviceClass: deviceClass(),
    adapterInfo,
    clientVersion: CLIENT_VERSION,
  };
  const capabilityHash = await hashCapability(capability);
  if (capabilityHash) capability.capabilityHash = capabilityHash;
  return capability;
}

async function webgpuInfoBucket(runBenchmark) {
  if (!navigator.gpu?.requestAdapter) return { webgpu: "unavailable" };
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), 900);
    if (!adapter) return { webgpu: "no-adapter" };
    const info = adapter.info || {};
    const base = {
      webgpu: "available",
      gpuVendorBucket: vendorBucket(info.vendor),
      featuresBucket: bucketCount(adapter.features?.size || 0),
      maxBufferBucket: bucketBytes(adapter.limits?.maxBufferSize),
      maxStorageBufferBucket: bucketBytes(adapter.limits?.maxStorageBufferBindingSize),
    };
    return runBenchmark ? { ...base, ...(await webgpuBenchmarkBucket(adapter)) } : base;
  } catch {
    return { webgpu: "probe-failed" };
  }
}

async function webgpuBenchmarkBucket(adapter) {
  let device = null;
  try {
    device = await withTimeout(adapter.requestDevice(), 1200);
    if (!device) return { webgpuBenchmark: "timeout" };
    const items = 4096;
    const input = new Uint32Array(items);
    for (let i = 0; i < items; i++) input[i] = i;
    const buffer = device.createBuffer({
      size: items * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const readBuffer = device.createBuffer({
      size: items * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, input);
    const module = device.createShaderModule({
      code: `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&data)) { return; }
  let x = data[id.x];
  data[id.x] = x * 1664525u + 1013904223u;
}`,
    });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(items / 64));
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, items * 4);
    const t0 = performance.now();
    device.queue.submit([encoder.finish()]);
    const done = await withTimeout(device.queue.onSubmittedWorkDone(), 1500);
    const ms = performance.now() - t0;
    let correctness = "timeout";
    let mismatchCount = 0;
    if (done !== null) {
      const mapped = await withTimeout(readBuffer.mapAsync(GPUMapMode.READ), 800);
      if (mapped !== null) {
        const out = new Uint32Array(readBuffer.getMappedRange().slice(0));
        for (let i = 0; i < out.length; i++) {
          const expected = (Math.imul(i, 1664525) + 1013904223) >>> 0;
          if (out[i] !== expected) mismatchCount++;
        }
        readBuffer.unmap();
        correctness = mismatchCount === 0 ? "ok" : "mismatch";
      }
    }
    buffer.destroy();
    readBuffer.destroy();
    if (done === null) return { webgpuBenchmark: "timeout" };
    return {
      webgpuBenchmark: "ok",
      webgpuCorrectness: correctness,
      webgpuMismatchBucket: bucketCount(mismatchCount),
      webgpuKernelMsBucket: bucketMs(ms),
      webgpuThroughputBucket: bucketRate(items / Math.max(0.001, ms / 1000)),
    };
  } catch {
    return { webgpuBenchmark: "failed" };
  } finally {
    try { device?.destroy?.(); } catch {}
  }
}

function workerDeviceWitnessBucket(runProbe) {
  if (!runProbe) return Promise.resolve({});
  if (typeof Worker === "undefined") return Promise.resolve({ workerFixture: "unavailable" });
  return new Promise((resolve) => {
    const probeId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let worker = null;
    const finish = (value) => {
      clearTimeout(timer);
      try { worker?.terminate(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ workerFixture: "timeout" }), 1500);
    try {
      worker = new Worker(new URL("../workers/plasma-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg?.type === "probe" && msg.probeId === probeId) finish(msg.result || { workerFixture: "failed" });
      };
      worker.onerror = () => finish({ workerFixture: "failed" });
      worker.postMessage({ type: "probe", probeId });
    } catch {
      finish({ workerFixture: "failed" });
    }
  });
}

async function buildConnectivityObservations(client) {
  const common = connectivityCommonFields(client);
  const [status, http, webrtc] = await Promise.all([
    computeLabStatus(),
    httpRttProbe(),
    localWebRtcProbe(1800),
  ]);
  const observations = [
    { ...common, transport: "http", ...http },
    { ...common, transport: "webrtc-local", ...webrtc },
  ];
  if (status?.webrtcSignalingEnabled && client.currentGate() === null) {
    const signaled = await signaledWebRtcProbe(client, 4500).catch((e) => ({
      status: "failed",
      webrtcOpenMsBucket: "failed",
      iceGatherMsBucket: "failed",
      iceHostBucket: "unknown",
      iceSrflxBucket: "unknown",
      iceRelayBucket: "unknown",
      stunSuccessBucket: "unknown",
      turnNeedBucket: "unknown",
      notes: message(e),
    }));
    observations.push({ ...common, transport: "webrtc-signaling", ...signaled });
  }
  return observations;
}

function connectivityCommonFields(client) {
  return {
    mode: client.mode,
    browserFamily: adapterInfoBucket().userAgentBucket,
    deviceClass: client.capability?.deviceClass || deviceClass(),
    visibilityBucket: document.visibilityState === "visible" ? "visible" : "hidden",
    batteryBucket: batteryBucket(client.battery),
    ...networkInfoBucket(),
  };
}

function webRtcTranscript(client, probe) {
  return cleanTranscript({
    mode: client.mode,
    browserFamily: adapterInfoBucket().userAgentBucket,
    deviceClass: client.capability?.deviceClass || deviceClass(),
    visibilityBucket: document.visibilityState === "visible" ? "visible" : "hidden",
    batteryBucket: batteryBucket(client.battery),
    ...networkInfoBucket(),
    ...probe,
  });
}

function cleanTranscript(input) {
  const out = {};
  for (const key of [
    "status",
    "mode",
    "browserFamily",
    "deviceClass",
    "networkTypeBucket",
    "downlinkBucket",
    "rttBucket",
    "webrtcOpenMsBucket",
    "iceGatherMsBucket",
    "iceHostBucket",
    "iceSrflxBucket",
    "iceRelayBucket",
    "stunSuccessBucket",
    "turnNeedBucket",
    "dataChannelBucket",
    "dataWorkBucket",
    "dataReceiptBucket",
    "visibilityBucket",
    "batteryBucket",
  ]) {
    const value = transcriptBucket(input[key]);
    if (value) out[key] = value;
  }
  return out;
}

let labStatusCache = null;
let labStatusAt = 0;

async function computeLabStatus() {
  const now = performance.now();
  if (labStatusCache && now - labStatusAt < 60000) return labStatusCache;
  try {
    const res = await fetch(computeLabOrigin() + "/compute/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body.iceServers)) window.__M3T4_COMPUTE_ICE_SERVERS__ = body.iceServers;
    labStatusCache = body;
    labStatusAt = now;
    return body;
  } catch {
    labStatusCache = null;
    labStatusAt = now;
    return null;
  }
}

async function signaledWebRtcProbe(client, timeoutMs) {
  if (typeof RTCPeerConnection === "undefined") return { status: "unsupported", webrtcOpenMsBucket: "unsupported" };
  const join = await fetch(computeLabOrigin() + "/compute/webrtc/pairs/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: client.workerId,
      workerSessionId: client.workerSessionId,
      workerSessionToken: client.workerSessionToken,
    }),
  });
  if (!join.ok) return { status: join.status === 404 ? "unsupported" : "failed", webrtcOpenMsBucket: "failed" };
  const joined = await join.json();
  const pairId = joined.pairId;
  const pairToken = joined.pairToken;
  const role = joined.role;
  const dataEnabled = joined.dataEnabled === true && Array.isArray(joined.channels) && joined.channels.includes("plasma-data");
  const peerId = client.workerId;
  const candidateTypes = { host: false, srflx: false, relay: false };
  const seenRemoteCandidates = new Set();
  const channels = new Map();
  const served = { attempted: false, completed: false, ok: false };
  let pc = null;
  let iceGatherMs = null;
  let pumpTimer = null;
  const t0 = performance.now();
  const iceStart = performance.now();

  const pairFetch = async (path = "") => {
    const res = await fetch(computeLabOrigin() + `/compute/webrtc/pairs/${pairId}${path}`, {
      headers: { "x-webrtc-pair-token": pairToken },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`pair fetch ${res.status}`);
    return res.json();
  };
  const pairPost = async (path, body) => {
    const res = await fetch(computeLabOrigin() + `/compute/webrtc/pairs/${pairId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webrtc-pair-token": pairToken },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`pair post ${path} ${res.status}`);
    return res.json();
  };
  const markCandidate = (candidate) => {
    const raw = String(candidate?.candidate || "");
    if (raw.includes(" typ host")) candidateTypes.host = true;
    if (raw.includes(" typ srflx")) candidateTypes.srflx = true;
    if (raw.includes(" typ relay")) candidateTypes.relay = true;
  };
  const maybeGathered = () => {
    if (iceGatherMs !== null) return;
    if (pc?.iceGatheringState === "complete") iceGatherMs = performance.now() - iceStart;
  };
  const addRemoteCandidates = async () => {
    const latest = await pairFetch();
    for (const candidate of latest.candidates || []) {
      if (!candidate || candidate.peerId === peerId || seenRemoteCandidates.has(candidate.candidateId)) continue;
      try {
        await pc?.addIceCandidate(candidate.payload);
        seenRemoteCandidates.add(candidate.candidateId);
      } catch {
        // Remote candidates may arrive before the remote description in some browsers.
      }
    }
    return latest;
  };
  const attachChannel = (ch) => {
    channels.set(ch.label || "unknown", ch);
    if (ch.label === "plasma-data") {
      ch.onmessage = (ev) => {
        handlePeerWorkMessage(ev.data, channels, served).catch(() => {
          served.attempted = true;
          served.completed = true;
          served.ok = false;
        });
      };
    }
  };
  const requiredLabels = dataEnabled
    ? ["plasma-control", "plasma-data", "plasma-receipts"]
    : ["plasma-control"];

  try {
    pc = new RTCPeerConnection({ iceServers: configuredIceServers() });
    pc.onicegatheringstatechange = maybeGathered;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        markCandidate(ev.candidate);
        pairPost("/candidates", {
          peerId,
          candidates: [typeof ev.candidate.toJSON === "function" ? ev.candidate.toJSON() : ev.candidate],
        }).catch(() => {});
      }
      maybeGathered();
    };
    if (role === "offerer") {
      for (const label of requiredLabels) attachChannel(pc.createDataChannel(label, { ordered: true }));
    } else {
      pc.ondatachannel = (ev) => attachChannel(ev.channel);
    }
    pumpTimer = setInterval(() => { addRemoteCandidates().catch(() => {}); }, 250);

    if (role === "offerer") {
      await pc.setLocalDescription(await pc.createOffer());
      await pairPost("/offer", { offer: pc.localDescription });
      const answered = await waitFor(async () => {
        const latest = await addRemoteCandidates();
        return latest.answer ? latest : null;
      }, timeoutMs);
      if (!answered?.answer) throw new Error("answer timeout");
      await pc.setRemoteDescription(answered.answer);
    } else {
      const offered = await waitFor(async () => {
        const latest = await addRemoteCandidates();
        return latest.offer ? latest : null;
      }, timeoutMs);
      if (!offered?.offer) throw new Error("offer timeout");
      await pc.setRemoteDescription(offered.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await pairPost("/answer", { answer: pc.localDescription });
    }

    const ok = !!(await waitFor(() => (
      requiredLabels.every((label) => channels.get(label)?.readyState === "open") ? true : null
    ), timeoutMs));
    maybeGathered();
    let dataWorkBucket = dataEnabled ? "not-run" : "disabled";
    let dataReceiptBucket = dataEnabled ? "not-run" : "disabled";
    if (ok) {
      if (dataEnabled && role === "offerer") {
        const peerResult = await runPeerWorkRequest(channels, Math.min(3000, timeoutMs));
        dataWorkBucket = peerResult.ok ? "request-ok" : peerResult.status;
        dataReceiptBucket = peerResult.receiptBucket;
      } else if (dataEnabled) {
        const didComplete = await waitFor(() => (served.completed ? true : null), Math.min(3500, timeoutMs));
        dataWorkBucket = served.attempted
          ? didComplete
            ? (served.ok ? "served-ok" : "served-failed")
            : "served-timeout"
          : "served-none";
        dataReceiptBucket = served.attempted
          ? didComplete
            ? (served.ok ? "sent" : "failed")
            : "timeout"
          : "none";
      } else {
        try { channels.get("plasma-control")?.send?.("witness"); } catch {}
        await delay(40);
      }
    }
    return {
      status: ok ? "ok" : "timeout",
      webrtcOpenMsBucket: ok ? bucketMs(performance.now() - t0) : "timeout",
      iceGatherMsBucket: iceGatherMs === null ? "incomplete" : bucketMs(iceGatherMs),
      iceHostBucket: yesNo(candidateTypes.host),
      iceSrflxBucket: yesNo(candidateTypes.srflx),
      iceRelayBucket: yesNo(candidateTypes.relay),
      stunSuccessBucket: configuredIceServers().length ? yesNo(candidateTypes.srflx) : "unconfigured",
      turnNeedBucket: candidateTypes.relay ? "relay-available" : ok ? "unknown" : "maybe-required",
      signalingRttBucket: bucketMs(performance.now() - t0),
      dataChannelBucket: dataEnabled ? (ok ? "open" : "timeout") : "disabled",
      dataWorkBucket,
      dataReceiptBucket,
    };
  } catch {
    return {
      status: "failed",
      webrtcOpenMsBucket: "failed",
      iceGatherMsBucket: iceGatherMs === null ? "failed" : bucketMs(iceGatherMs),
      iceHostBucket: yesNo(candidateTypes.host),
      iceSrflxBucket: yesNo(candidateTypes.srflx),
      iceRelayBucket: yesNo(candidateTypes.relay),
      stunSuccessBucket: configuredIceServers().length ? yesNo(candidateTypes.srflx) : "unconfigured",
      turnNeedBucket: candidateTypes.relay ? "relay-available" : "maybe-required",
      signalingRttBucket: bucketMs(performance.now() - t0),
      dataChannelBucket: dataEnabled ? "failed" : "disabled",
      dataWorkBucket: dataEnabled ? "failed" : "disabled",
      dataReceiptBucket: dataEnabled ? "failed" : "disabled",
    };
  } finally {
    if (pumpTimer) clearInterval(pumpTimer);
    for (const ch of channels.values()) {
      try { ch.close?.(); } catch {}
    }
    try { pc?.close?.(); } catch {}
    if (pairId && pairToken) pairPost("/close", {}).catch(() => {});
  }
}

async function runWebRtcArtifactTransfer(client, work, timeoutMs) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runWebRtcArtifactTransferOnce(client, work, timeoutMs);
    } catch (e) {
      lastError = e;
      await delay(150 + Math.floor(Math.random() * 350) + attempt * 250);
    }
  }
  throw lastError || new Error("webrtc artifact transfer failed");
}

async function runWebRtcArtifactTransferOnce(client, work, timeoutMs) {
  if (typeof RTCPeerConnection === "undefined") throw new Error("RTCPeerConnection unavailable");
  const join = await fetch(computeLabOrigin() + "/compute/webrtc/pairs/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: client.workerId,
      workerSessionId: client.workerSessionId,
      workerSessionToken: client.workerSessionToken,
    }),
  });
  if (!join.ok) throw new Error(`pair join failed: ${join.status}`);
  const joined = await join.json();
  if (joined.dataEnabled !== true) throw new Error("webrtc data disabled");
  const pairId = joined.pairId;
  const pairToken = joined.pairToken;
  const role = joined.role;
  const peerId = client.workerId;
  const candidateTypes = { host: false, srflx: false, relay: false };
  const seenRemoteCandidates = new Set();
  const channels = new Map();
  const requestId = `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let pc = null;
  let pumpTimer = null;
  let remoteResult = null;
  let servedResult = null;
  const t0 = performance.now();

  const pairFetch = async (path = "") => {
    const res = await fetch(computeLabOrigin() + `/compute/webrtc/pairs/${pairId}${path}`, {
      headers: { "x-webrtc-pair-token": pairToken },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`pair fetch ${res.status}`);
    return res.json();
  };
  const pairPost = async (path, body) => {
    const res = await fetch(computeLabOrigin() + `/compute/webrtc/pairs/${pairId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webrtc-pair-token": pairToken },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`pair post ${path} ${res.status}`);
    return res.json();
  };
  const markCandidate = (candidate) => {
    const raw = String(candidate?.candidate || "");
    if (raw.includes(" typ host")) candidateTypes.host = true;
    if (raw.includes(" typ srflx")) candidateTypes.srflx = true;
    if (raw.includes(" typ relay")) candidateTypes.relay = true;
  };
  const addRemoteCandidates = async () => {
    const latest = await pairFetch();
    for (const candidate of latest.candidates || []) {
      if (!candidate || candidate.peerId === peerId || seenRemoteCandidates.has(candidate.candidateId)) continue;
      try {
        await pc?.addIceCandidate(candidate.payload);
        seenRemoteCandidates.add(candidate.candidateId);
      } catch {
        // Candidate may arrive before the remote description.
      }
    }
    return latest;
  };
  const attachChannel = (ch) => {
    channels.set(ch.label || "unknown", ch);
    if (ch.label === "plasma-data") {
      ch.onmessage = (ev) => {
        handleArtifactWorkMessage(ev.data, channels, timeoutMs).then((ack) => {
          if (ack) servedResult = ack;
        }).catch((e) => {
          servedResult = { ok: false, error: message(e) };
        });
      };
    }
    if (ch.label === "plasma-receipts") {
      ch.onmessage = (ev) => {
        const msg = parseJsonMessage(ev.data);
        if (
          msg?.protocol === "plasma-receipts.v0" &&
          msg?.type === "artifact-result" &&
          msg?.requestId === requestId
        ) {
          remoteResult = msg;
        }
      };
    }
  };

  try {
    pc = new RTCPeerConnection({ iceServers: configuredIceServers() });
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      markCandidate(ev.candidate);
      pairPost("/candidates", {
        peerId,
        candidates: [typeof ev.candidate.toJSON === "function" ? ev.candidate.toJSON() : ev.candidate],
      }).catch(() => {});
    };
    if (role === "offerer") {
      for (const label of ["plasma-control", "plasma-data", "plasma-receipts"]) {
        attachChannel(pc.createDataChannel(label, { ordered: true }));
      }
    } else {
      pc.ondatachannel = (ev) => attachChannel(ev.channel);
    }
    pumpTimer = setInterval(() => { addRemoteCandidates().catch(() => {}); }, 250);

    if (role === "offerer") {
      await pc.setLocalDescription(await pc.createOffer());
      await pairPost("/offer", { offer: pc.localDescription });
      const answered = await waitFor(async () => {
        const latest = await addRemoteCandidates();
        return latest.answer ? latest : null;
      }, timeoutMs);
      if (!answered?.answer) throw new Error("answer timeout");
      await pc.setRemoteDescription(answered.answer);
    } else {
      const offered = await waitFor(async () => {
        const latest = await addRemoteCandidates();
        return latest.offer ? latest : null;
      }, timeoutMs);
      if (!offered?.offer) throw new Error("offer timeout");
      await pc.setRemoteDescription(offered.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await pairPost("/answer", { answer: pc.localDescription });
    }

    const open = await waitFor(() => (
      ["plasma-data", "plasma-receipts"].every((label) => channels.get(label)?.readyState === "open") ? true : null
    ), timeoutMs);
    if (!open) throw new Error("data channel timeout");
    const request = JSON.stringify({
      protocol: "plasma-data.v0",
      type: "artifact-work",
      requestId,
      assignmentId: work.assignment.assignmentId,
      taskId: work.task.taskId,
      chunk: work.chunk,
    });
    let nextSendAt = 0;
    const sendRequest = () => {
      if (channels.get("plasma-data")?.readyState !== "open") return;
      channels.get("plasma-data")?.send(request);
      nextSendAt = performance.now() + 500;
    };
    sendRequest();
    const gotResult = await waitFor(() => {
      if (remoteResult) return true;
      if (performance.now() >= nextSendAt) sendRequest();
      return null;
    }, timeoutMs);
    if (!gotResult) throw new Error("artifact result timeout");
    if (!remoteResult.ok || typeof remoteResult.outputHash !== "string") {
      throw new Error(`artifact peer failed: ${remoteResult.error || "unknown"}`);
    }
    if (work.chunk.expectedOutputHash?.value && remoteResult.outputHash !== work.chunk.expectedOutputHash.value) {
      throw new Error("artifact peer output mismatch");
    }
    // Keep the pair alive briefly so the peer can finish its reciprocal request.
    if (!servedResult) {
      await waitFor(() => (servedResult ? true : null), Math.min(2500, timeoutMs));
    }
    return {
      outputHash: remoteResult.outputHash,
      computeMs: Number(remoteResult.computeMs) || 0,
      executionMode: remoteResult.executionMode || "cpu",
      transcript: {
        status: "ok",
        transfer: "plasma-data",
        role,
        dataChannelBucket: "open",
        dataWorkBucket: "artifact-request-ok",
        dataReceiptBucket: "ok",
        servedArtifactBucket: servedResult?.ok ? "served-ok" : servedResult ? "served-failed" : "none",
        webrtcOpenMsBucket: bucketMs(performance.now() - t0),
        iceHostBucket: yesNo(candidateTypes.host),
        iceSrflxBucket: yesNo(candidateTypes.srflx),
        iceRelayBucket: yesNo(candidateTypes.relay),
      },
    };
  } finally {
    if (pumpTimer) clearInterval(pumpTimer);
    for (const ch of channels.values()) {
      try { ch.close?.(); } catch {}
    }
    try { pc?.close?.(); } catch {}
    if (pairId && pairToken) pairPost("/close", {}).catch(() => {});
  }
}

async function handleArtifactWorkMessage(raw, channels, timeoutMs) {
  const msg = parseJsonMessage(raw);
  if (msg?.protocol !== "plasma-data.v0" || msg?.type !== "artifact-work" || typeof msg.requestId !== "string") {
    return null;
  }
  let receiptChannel = null;
  try {
    receiptChannel = await waitFor(() => (
      channels.get("plasma-receipts")?.readyState === "open" ? channels.get("plasma-receipts") : null
    ), 1000);
    if (!receiptChannel) throw new Error("receipt channel unavailable");
    const chunk = safeArtifactChunk(msg.chunk);
    const result = await executeWorkerChunk(chunk, msg.requestId, Math.min(3500, timeoutMs));
    const ack = {
      protocol: "plasma-receipts.v0",
      type: "artifact-result",
      requestId: msg.requestId,
      ok: true,
      kernelId: result.kernelId,
      outputHash: result.outputHash,
      computeMs: Math.round(result.computeMs),
      executionMode: result.executionMode || "cpu",
    };
    receiptChannel.send(JSON.stringify(ack));
    return ack;
  } catch (e) {
    const ack = {
      protocol: "plasma-receipts.v0",
      type: "artifact-result",
      requestId: msg.requestId,
      ok: false,
      error: message(e),
    };
    try { receiptChannel?.send(JSON.stringify(ack)); } catch {}
    return ack;
  }
}

function safeArtifactChunk(chunk) {
  if (!chunk || !webRtcDataKernel(chunk.kind)) throw new Error("unsupported artifact chunk");
  if (chunk.kind === PUBLIC_ARTIFACT_KERNEL) {
    if (typeof chunk.params?.artifactJson !== "string" || chunk.params.artifactJson.length === 0) {
      throw new Error("artifactJson required");
    }
    if (chunk.params.artifactJson.length > 1024 * 1024) throw new Error("artifactJson too large");
  }
  if (chunk.kind === REPLAY_VERIFY_KERNEL) {
    if (typeof chunk.params?.replayArtifactJson !== "string" || chunk.params.replayArtifactJson.length === 0) {
      throw new Error("replayArtifactJson required");
    }
    if (chunk.params.replayArtifactJson.length > 1024 * 1024) throw new Error("replayArtifactJson too large");
  }
  return {
    chunkId: String(chunk.chunkId || "artifact-chunk"),
    kind: chunk.kind,
    params: { ...chunk.params },
    kernelId: chunk.kernelId,
    kernelHash: chunk.kernelHash,
    inputHash: chunk.inputHash,
    artifactHash: chunk.artifactHash,
    expectedOutputHash: chunk.expectedOutputHash,
  };
}

function webRtcDataKernel(kind) {
  return kind === PUBLIC_ARTIFACT_KERNEL || kind === REPLAY_VERIFY_KERNEL;
}

const PEER_WORK_PARAMS = Object.freeze({ start: 1009, endExclusive: 1033 });
const PEER_WORK_EXPECTED_HASH = "359233299256766ca1b01116330f3a542d7a9e148a694f33af0f67eb8f0de6ef";

async function runPeerWorkRequest(channels, timeoutMs) {
  const data = channels.get("plasma-data");
  const receipts = channels.get("plasma-receipts");
  if (!data || !receipts) return { ok: false, status: "missing-channel", receiptBucket: "missing" };
  const requestId = `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunk = {
    chunkId: `${requestId}-chunk`,
    kind: "prime-search.v0",
    params: PEER_WORK_PARAMS,
    kernelId: "prime-search.v0",
    kernelHash: { algorithm: "sha256", value: await hashText("peer-prime-search.v0") },
    inputHash: { algorithm: "sha256", value: await hashText(stableJson({ kind: "prime-search.v0", params: PEER_WORK_PARAMS })) },
  };
  const receipt = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    receipts.onmessage = (ev) => {
      const msg = parseJsonMessage(ev.data);
      if (msg?.protocol !== "plasma-receipts.v0" || msg?.type !== "work-result" || msg?.requestId !== requestId) return;
      clearTimeout(timer);
      resolve(msg);
    };
  });
  data.send(JSON.stringify({
    protocol: "plasma-data.v0",
    type: "work",
    requestId,
    chunk,
  }));
  const msg = await receipt;
  if (!msg) return { ok: false, status: "timeout", receiptBucket: "timeout" };
  if (!msg.ok) return { ok: false, status: "peer-failed", receiptBucket: "failed" };
  if (msg.outputHash !== PEER_WORK_EXPECTED_HASH) return { ok: false, status: "mismatch", receiptBucket: "mismatch" };
  return { ok: true, status: "request-ok", receiptBucket: "ok" };
}

async function handlePeerWorkMessage(raw, channels, served) {
  const msg = parseJsonMessage(raw);
  if (msg?.protocol !== "plasma-data.v0" || msg?.type !== "work" || typeof msg.requestId !== "string") return;
  served.attempted = true;
  let receiptChannel = null;
  try {
    receiptChannel = await waitFor(() => (
      channels.get("plasma-receipts")?.readyState === "open" ? channels.get("plasma-receipts") : null
    ), 1000);
    if (!receiptChannel) throw new Error("receipt channel unavailable");
    const chunk = safePeerChunk(msg.chunk);
    const result = await executeWorkerChunk(chunk, msg.requestId, 2500);
    served.ok = result.outputHash === PEER_WORK_EXPECTED_HASH;
    receiptChannel.send(JSON.stringify({
      protocol: "plasma-receipts.v0",
      type: "work-result",
      requestId: msg.requestId,
      ok: served.ok,
      kernelId: result.kernelId,
      outputHash: result.outputHash,
      computeMs: Math.round(result.computeMs),
      executionMode: result.executionMode || "cpu",
    }));
  } catch (e) {
    served.ok = false;
    try {
      receiptChannel?.send(JSON.stringify({
        protocol: "plasma-receipts.v0",
        type: "work-result",
        requestId: msg.requestId,
        ok: false,
        error: message(e),
      }));
    } catch {
      // The answerer still records completion below; the requester will time out.
    }
  } finally {
    served.completed = true;
  }
}

function safePeerChunk(chunk) {
  if (!chunk || chunk.kind !== "prime-search.v0") throw new Error("unsupported peer chunk");
  const start = Number(chunk.params?.start);
  const endExclusive = Number(chunk.params?.endExclusive);
  if (start !== PEER_WORK_PARAMS.start || endExclusive !== PEER_WORK_PARAMS.endExclusive) {
    throw new Error("unexpected peer chunk params");
  }
  return {
    chunkId: String(chunk.chunkId || "peer-chunk"),
    kind: "prime-search.v0",
    params: PEER_WORK_PARAMS,
    kernelId: "prime-search.v0",
    kernelHash: chunk.kernelHash,
    inputHash: chunk.inputHash,
  };
}

function executeWorkerChunk(chunk, assignmentId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let worker = null;
    const timer = setTimeout(() => {
      try { worker?.terminate(); } catch {}
      reject(new Error("peer worker timeout"));
    }, timeoutMs);
    try {
      worker = new Worker(new URL("../workers/plasma-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg?.assignmentId !== assignmentId) return;
        clearTimeout(timer);
        try { worker?.terminate(); } catch {}
        if (msg.type === "done") resolve(msg);
        else reject(new Error(msg?.message || "peer worker failed"));
      };
      worker.onerror = (err) => {
        clearTimeout(timer);
        try { worker?.terminate(); } catch {}
        reject(new Error(err.message || "peer worker error"));
      };
      worker.postMessage({ type: "run", assignmentId, chunk });
    } catch (e) {
      clearTimeout(timer);
      try { worker?.terminate(); } catch {}
      reject(e);
    }
  });
}

function parseJsonMessage(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(200);
  }
  return null;
}

function transcriptBucket(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return undefined;
  return /^[a-z0-9<>=][a-z0-9_.:+/<>=-]{0,63}$/.test(raw) ? raw : "other";
}

async function httpRttProbe() {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 1500) : null;
  const t0 = performance.now();
  const paths = [
    `/healthz?witness=${Date.now()}`,
    `/compute/healthz?witness=${Date.now()}`,
    `/compute/status?witness=${Date.now()}`,
  ];
  try {
    for (const path of paths) {
      const res = await fetch(computeLabOrigin() + path, {
        cache: "no-store",
        signal: controller?.signal,
      });
      if (res.ok) return { status: "ok", httpRttBucket: bucketMs(performance.now() - t0) };
    }
    return { status: "failed", httpRttBucket: bucketMs(performance.now() - t0) };
  } catch (e) {
    return { status: e?.name === "AbortError" ? "timeout" : "failed", httpRttBucket: "timeout" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function localWebRtcProbe(timeoutMs) {
  if (typeof RTCPeerConnection === "undefined") return { status: "unsupported", webrtcOpenMsBucket: "unsupported" };
  const iceServers = configuredIceServers();
  const candidateTypes = { host: false, srflx: false, relay: false };
  let pc1 = null;
  let pc2 = null;
  let channel = null;
  let iceGatherMs = null;
  const t0 = performance.now();
  const iceStart = performance.now();
  try {
    pc1 = new RTCPeerConnection({ iceServers });
    pc2 = new RTCPeerConnection({ iceServers });
    const markCandidate = (candidate) => {
      const raw = String(candidate?.candidate || "");
      if (raw.includes(" typ host")) candidateTypes.host = true;
      if (raw.includes(" typ srflx")) candidateTypes.srflx = true;
      if (raw.includes(" typ relay")) candidateTypes.relay = true;
    };
    const maybeGathered = () => {
      if (iceGatherMs !== null) return;
      if (pc1?.iceGatheringState === "complete" && pc2?.iceGatheringState === "complete") {
        iceGatherMs = performance.now() - iceStart;
      }
    };
    pc1.onicecandidate = (ev) => {
      if (ev.candidate) {
        markCandidate(ev.candidate);
        pc2?.addIceCandidate(ev.candidate).catch(() => {});
      }
      maybeGathered();
    };
    pc2.onicecandidate = (ev) => {
      if (ev.candidate) {
        markCandidate(ev.candidate);
        pc1?.addIceCandidate(ev.candidate).catch(() => {});
      }
      maybeGathered();
    };
    pc1.onicegatheringstatechange = maybeGathered;
    pc2.onicegatheringstatechange = maybeGathered;
    channel = pc1.createDataChannel("plasma-device-witness", { ordered: true });
    const opened = new Promise((resolve) => {
      channel.onopen = () => resolve(true);
      pc2.ondatachannel = (ev) => {
        ev.channel.onmessage = () => {};
      };
    });
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    const ok = await Promise.race([opened, delay(timeoutMs).then(() => false)]);
    maybeGathered();
    if (ok) await delay(40);
    const openMs = performance.now() - t0;
    return {
      status: ok ? "ok" : "timeout",
      webrtcOpenMsBucket: ok ? bucketMs(openMs) : "timeout",
      iceGatherMsBucket: iceGatherMs === null ? "incomplete" : bucketMs(iceGatherMs),
      iceHostBucket: yesNo(candidateTypes.host),
      iceSrflxBucket: yesNo(candidateTypes.srflx),
      iceRelayBucket: yesNo(candidateTypes.relay),
      stunSuccessBucket: iceServers.length ? yesNo(candidateTypes.srflx) : "unconfigured",
      turnNeedBucket: candidateTypes.relay ? "relay-available" : "unknown",
    };
  } catch {
    return {
      status: "failed",
      webrtcOpenMsBucket: "failed",
      iceGatherMsBucket: iceGatherMs === null ? "failed" : bucketMs(iceGatherMs),
      iceHostBucket: yesNo(candidateTypes.host),
      iceSrflxBucket: yesNo(candidateTypes.srflx),
      iceRelayBucket: yesNo(candidateTypes.relay),
      stunSuccessBucket: iceServers.length ? yesNo(candidateTypes.srflx) : "unconfigured",
      turnNeedBucket: "unknown",
    };
  } finally {
    try { channel?.close?.(); } catch {}
    try { pc1?.close?.(); } catch {}
    try { pc2?.close?.(); } catch {}
  }
}

function networkInfoBucket() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) {
    return { networkTypeBucket: "unknown", downlinkBucket: "unknown", rttBucket: "unknown" };
  }
  return {
    networkTypeBucket: String(conn.effectiveType || conn.type || "unknown").toLowerCase(),
    downlinkBucket: bucketMbps(Number(conn.downlink)),
    rttBucket: bucketMs(Number(conn.rtt)),
  };
}

function configuredIceServers() {
  if (Array.isArray(window.__M3T4_COMPUTE_ICE_SERVERS__) && window.__M3T4_COMPUTE_ICE_SERVERS__.length > 0) {
    return window.__M3T4_COMPUTE_ICE_SERVERS__
      .filter((server) => server && typeof server === "object")
      .map((server) => ({
        urls: Array.isArray(server.urls)
          ? server.urls.filter((url) => typeof url === "string" && /^(stuns?|turns?):/i.test(url)).slice(0, 4)
          : typeof server.urls === "string" && /^(stuns?|turns?):/i.test(server.urls)
            ? server.urls
            : [],
        ...(typeof server.username === "string" ? { username: server.username } : {}),
        ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
      }))
      .filter((server) => Array.isArray(server.urls) ? server.urls.length > 0 : !!server.urls)
      .slice(0, 4);
  }
  const urls = Array.isArray(window.__M3T4_COMPUTE_STUN_URLS__)
    ? window.__M3T4_COMPUTE_STUN_URLS__.filter((url) => typeof url === "string" && /^stuns?:/i.test(url)).slice(0, 4)
    : [];
  return urls.length ? [{ urls }] : [];
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function vendorBucket(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("apple")) return "apple";
  if (s.includes("intel")) return "intel";
  if (s.includes("nvidia")) return "nvidia";
  if (s.includes("amd") || s.includes("ati")) return "amd";
  if (s.includes("qualcomm") || s.includes("adreno")) return "qualcomm";
  if (s.includes("arm") || s.includes("mali")) return "arm";
  return "other";
}

function bucketCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n <= 8) return "1-8";
  if (n <= 16) return "9-16";
  if (n <= 32) return "17-32";
  return "33+";
}

function bucketCores(n) {
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n <= 2) return "1-2";
  if (n <= 4) return "3-4";
  if (n <= 8) return "5-8";
  return "9+";
}

function bucketMs(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 2) return "<2ms";
  if (ms < 5) return "2-5ms";
  if (ms < 10) return "5-10ms";
  if (ms < 20) return "10-20ms";
  if (ms < 50) return "20-50ms";
  return "50ms+";
}

function bucketRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "unknown";
  if (rate < 50000) return "<50k/s";
  if (rate < 200000) return "50k-199k/s";
  if (rate < 1000000) return "200k-999k/s";
  return "1m+/s";
}

function bucketMbps(mbps) {
  if (!Number.isFinite(mbps) || mbps <= 0) return "unknown";
  if (mbps < 1) return "<1mbps";
  if (mbps < 5) return "1-4mbps";
  if (mbps < 20) return "5-19mbps";
  if (mbps < 100) return "20-99mbps";
  return "100mbps+";
}

function bucketBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n < 64 * 1024 * 1024) return "<64m";
  if (n < 256 * 1024 * 1024) return "64-255m";
  if (n < 1024 * 1024 * 1024) return "256-1023m";
  return "1g+";
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hashCapability(capability) {
  try {
    const json = stableJson({
      kernels: capability.kernels,
      runtimeSurfaces: capability.runtimeSurfaces,
      maxChunkBytes: capability.maxChunkBytes,
      maxConcurrentChunks: capability.maxConcurrentChunks,
      deviceClass: capability.deviceClass,
      adapterInfo: capability.adapterInfo,
      clientVersion: capability.clientVersion,
    });
    return { algorithm: "sha256", value: await hashText(json) };
  } catch {
    return null;
  }
}

function runtimeInfoBucket(client) {
  return {
    frameP95Bucket: bucketMs(p95(client.frameSamples)),
    droppedFrameBurstBucket: bucketCount(client.health.droppedFrameBursts),
    hiddenPauseBucket: bucketCount(client.health.hiddenPauses),
    lowBatteryPauseBucket: bucketCount(client.health.lowBatteryPauses),
    renderStrugglePauseBucket: bucketCount(client.health.renderStrugglePauses),
    notNowPauseBucket: bucketCount(client.health.notNowPauses),
    assignmentBucket: bucketCount(client.health.assignmentsStarted),
    receiptBucket: bucketCount(client.health.receiptsSubmitted),
    batteryBucket: batteryBucket(client.battery),
    visibilityBucket: document.visibilityState === "visible" ? "visible" : "hidden",
  };
}

function batteryBucket(battery) {
  if (!battery) return "unknown";
  if (battery.charging) return "charging";
  if (battery.level < 0.2) return "<20";
  if (battery.level < 0.35) return "20-34";
  if (battery.level < 0.7) return "35-69";
  return "70+";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashText(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function message(e) {
  return e instanceof Error ? e.message : String(e);
}
