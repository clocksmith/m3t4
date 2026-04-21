// Spectator-side compute controller. Orchestrates the Plasma worker
// lifecycle: opt-in, register with the coordinator, poll for work,
// run chunks off-thread, submit receipts. Designed so the spectator
// render loop never blocks on compute.
//
// Gates that auto-pause compute (restart transparently when cleared):
//   - user explicitly paused
//   - tab hidden (document.visibilityState !== "visible")
//   - Battery API reports charging === false AND level < 0.35
//   - intensity = "low" throttles poll interval

import { API_ORIGIN } from "./api.js";

const INTENSITY_PROFILE = {
  low:    { pollMs: 3000, cooldownMs: 1500 },
  medium: { pollMs: 1000, cooldownMs:  500 },
  spicy:  { pollMs:  250, cooldownMs:    0 },
};

class ComputeClient {
  constructor() {
    this.enabled = false;
    this.intensity = "medium";
    this.worker = null;
    this.workerId = null;
    this.state = "idle";
    this.current = null; // { assignmentId, chunkId, taskId, kind, deadlineAt, t0 }
    this.totals = { accepted: 0, rejected: 0, pending: 0 };
    this.listeners = new Set();
    this.pollTimer = null;
    this.battery = null;
    this.onVisibility = () => this.reevaluate();
    this.onBlur = () => this.reevaluate();
    this.onFocus = () => this.reevaluate();
    this.available = typeof Worker !== "undefined" && typeof crypto?.subtle !== "undefined";
  }

  isAvailable() { return this.available; }

  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }

  snapshot() {
    return {
      available: this.available,
      enabled: this.enabled,
      intensity: this.intensity,
      state: this.state,
      workerId: this.workerId,
      current: this.current ? { ...this.current } : null,
      totals: { ...this.totals },
      gate: this.currentGate(),
    };
  }

  emit() { for (const fn of this.listeners) fn(this.snapshot()); }

  async start(opts = {}) {
    if (!this.available) return;
    if (this.enabled) return;
    this.enabled = true;
    this.intensity = opts.intensity ?? this.intensity;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    if (navigator.getBattery && !this.battery) {
      try {
        this.battery = await navigator.getBattery();
        this.battery.addEventListener("levelchange", this.onVisibility);
        this.battery.addEventListener("chargingchange", this.onVisibility);
      } catch { this.battery = null; }
    }
    await this.ensureWorkerRegistered();
    this.reevaluate();
    this.emit();
  }

  async stop() {
    this.enabled = false;
    this.state = "idle";
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.current = null;
    this.emit();
  }

  setIntensity(level) {
    if (!INTENSITY_PROFILE[level]) return;
    this.intensity = level;
    this.emit();
  }

  currentGate() {
    if (!this.enabled) return "user-paused";
    if (document.visibilityState !== "visible") return "tab-hidden";
    if (this.battery && !this.battery.charging && this.battery.level < 0.35) return "on-battery";
    return null;
  }

  async ensureWorkerRegistered() {
    if (this.workerId) return;
    try {
      const res = await fetch(API_ORIGIN + "/api/compute/workers/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: {
            kernels: ["prime-search.v0"],
            cores: navigator.hardwareConcurrency || 2,
            ua: navigator.userAgent.slice(0, 120),
          },
        }),
      });
      if (!res.ok) throw new Error(`register failed: ${res.status}`);
      const body = await res.json();
      this.workerId = body.workerId;
    } catch (e) {
      this.state = `register-failed: ${e.message}`;
      this.enabled = false;
    }
  }

  reevaluate() {
    if (!this.enabled) { this.schedule(null); this.emit(); return; }
    const gate = this.currentGate();
    if (gate) { this.state = `paused (${gate})`; this.schedule(null); this.emit(); return; }
    if (this.current) return; // still crunching
    this.state = "idle";
    this.schedule(INTENSITY_PROFILE[this.intensity].pollMs);
    this.emit();
  }

  schedule(ms) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (ms == null) return;
    this.pollTimer = setTimeout(() => this.poll(), ms);
  }

  async poll() {
    if (!this.enabled) return;
    if (!this.workerId) { await this.ensureWorkerRegistered(); if (!this.workerId) return; }
    if (this.currentGate()) { this.reevaluate(); return; }
    try {
      const res = await fetch(API_ORIGIN + `/api/compute/tasks/next?workerId=${encodeURIComponent(this.workerId)}`);
      if (!res.ok) throw new Error(`next failed: ${res.status}`);
      const body = await res.json();
      if (body.idle) { this.state = "no work"; this.schedule(INTENSITY_PROFILE[this.intensity].pollMs); this.emit(); return; }
      this.runAssignment(body);
    } catch (e) {
      this.state = `poll error: ${e.message}`;
      this.schedule(Math.max(2000, INTENSITY_PROFILE[this.intensity].pollMs));
      this.emit();
    }
  }

  runAssignment({ assignment, chunk, deadlineAt }) {
    this.current = {
      assignmentId: assignment.assignmentId,
      chunkId: chunk.chunkId,
      taskId: chunk.taskId,
      kind: chunk.kind,
      deadlineAt,
      t0: performance.now(),
    };
    this.state = `running ${chunk.kind}`;
    this.emit();
    if (!this.worker) this.worker = this.spawnWorker();
    this.worker.postMessage({ type: "run", assignmentId: assignment.assignmentId, chunk });
  }

  spawnWorker() {
    const w = new Worker(new URL("../workers/plasma-worker.js", import.meta.url), { type: "module" });
    w.onmessage = (ev) => this.onWorkerMessage(ev.data);
    w.onerror = (err) => {
      this.state = `worker error: ${err.message}`;
      this.current = null;
      this.emit();
      this.schedule(2000);
    };
    return w;
  }

  async onWorkerMessage(msg) {
    if (!this.current || msg.assignmentId !== this.current.assignmentId) return;
    const { chunkId } = this.current;
    this.current = null;
    if (msg.type === "error") {
      this.totals.rejected++;
      this.state = `kernel error: ${msg.message}`;
      this.schedule(INTENSITY_PROFILE[this.intensity].cooldownMs);
      this.emit();
      return;
    }
    try {
      const res = await fetch(API_ORIGIN + "/api/compute/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workerId: this.workerId,
          chunkId,
          assignmentId: msg.assignmentId,
          outputHash: msg.outputHash,
          computeMs: msg.computeMs,
        }),
      });
      const body = await res.json();
      if (body.status === "accepted") this.totals.accepted++;
      else if (body.status === "rejected") this.totals.rejected++;
      else this.totals.pending++;
      this.state = `receipt: ${body.status}`;
    } catch (e) {
      this.state = `receipt error: ${e.message}`;
      this.totals.rejected++;
    }
    this.schedule(INTENSITY_PROFILE[this.intensity].cooldownMs);
    this.emit();
  }
}

let singleton = null;
export function getComputeClient() {
  if (!singleton) singleton = new ComputeClient();
  return singleton;
}
