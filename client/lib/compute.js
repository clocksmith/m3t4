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
    this.maybeReportConnectivity();
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
        determinismClass: "bit-exact",
        validationMode: "expected-hash",
        executionMode: "cpu",
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
  };
}

function computeLabOrigin() {
  return String(window.__M3T4_COMPUTE_LAB_ORIGIN__ || "").replace(/\/+$/, "");
}

function computeFlagEnabled() {
  return window.__M3T4_COMPUTE_SLACK_WORKER__ === true;
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
  const adapterInfo = {
    ...adapterInfoBucket(),
    ...webgpu,
    ...deviceWitness,
    ...runtimeInfo,
  };
  const capability = {
    kernels: ["m3t4.public_artifact_verify.v0", "prime-search.v0"],
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
  const common = {
    mode: client.mode,
    browserFamily: adapterInfoBucket().userAgentBucket,
    deviceClass: client.capability?.deviceClass || deviceClass(),
    visibilityBucket: document.visibilityState === "visible" ? "visible" : "hidden",
    batteryBucket: batteryBucket(client.battery),
    ...networkInfoBucket(),
  };
  const [http, webrtc] = await Promise.all([
    httpRttProbe(),
    localWebRtcProbe(1800),
  ]);
  return [
    { ...common, transport: "http", ...http },
    { ...common, transport: "webrtc-local", ...webrtc },
  ];
}

async function httpRttProbe() {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 1500) : null;
  const t0 = performance.now();
  try {
    const res = await fetch(computeLabOrigin() + `/healthz?witness=${Date.now()}`, {
      cache: "no-store",
      signal: controller?.signal,
    });
    const ms = performance.now() - t0;
    return { status: res.ok ? "ok" : "failed", httpRttBucket: bucketMs(ms) };
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
