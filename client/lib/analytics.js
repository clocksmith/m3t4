// Firebase Analytics wrapper. Lazy-loads the SDK from the gstatic CDN
// (same pattern as lib/auth.js) and exposes a single `track()` function
// the rest of the client can call without importing Firebase directly.
//
// Usage:
//   import { initAnalytics, track } from "./analytics.js";
//   await initAnalytics();            // called once from app.js on boot
//   track("build_slot_mode_change", { slot: 0, mode: "preset" });
//
// Safety:
//   - No-op in local/dev (measurementId missing, or hostname is localhost).
//   - All calls wrapped in try/catch; analytics failures never block UI.
//   - Never log PII: no emails, no handles, no raw JSON configs. Event
//     params must be short enums / numbers / booleans.

const SDK_VERSION = typeof window !== "undefined"
  ? (window.__M3T4_FIREBASE_SDK_VERSION__ || "10.13.2")
  : "10.13.2";

const IS_LOCAL = typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");

let _analytics = null;
let _sdk = null;
let _initPromise = null;
let _queue = [];

function readConfig() {
  const cfg = (typeof window !== "undefined" && window.__M3T4_FIREBASE_CONFIG__) || null;
  if (!cfg || !cfg.measurementId) return null;
  return cfg;
}

export async function initAnalytics() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const cfg = readConfig();
    if (!cfg) return null;
    if (IS_LOCAL) return null; // don't pollute analytics from dev machines
    try {
      const [appSdk, analyticsSdk] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-analytics.js`),
      ]);
      const app = appSdk.getApps().length ? appSdk.getApps()[0] : appSdk.initializeApp(cfg);
      _analytics = analyticsSdk.getAnalytics(app);
      _sdk = analyticsSdk;
      // Flush anything that queued up before init finished.
      const pending = _queue.splice(0);
      for (const [name, params] of pending) safeLog(name, params);
      return _analytics;
    } catch (e) {
      console.warn("analytics init failed", e);
      return null;
    }
  })();
  return _initPromise;
}

function safeLog(name, params) {
  try {
    if (!_analytics || !_sdk) { _queue.push([name, params]); return; }
    _sdk.logEvent(_analytics, name, params || {});
  } catch (e) {
    // swallow; never block the UI
  }
}

export function track(name, params) {
  if (!name || typeof name !== "string") return;
  if (!_analytics) { _queue.push([name, params]); return; }
  safeLog(name, params);
}

// Convenience helpers for the most common events. Keeping these as
// named exports so the call sites read as intent, and so we can enforce
// a schema (no PII, bounded param values) in one place.
export function trackPageView(route) {
  track("page_view_custom", { route: String(route || "unknown").slice(0, 32) });
}
export function trackBuildSlotModeChange(slot, mode) {
  track("build_slot_mode_change", { slot: Number(slot) || 0, mode: String(mode).slice(0, 16) });
}
export function trackBuildPresetChange(slot, preset) {
  track("build_preset_change", { slot: Number(slot) || 0, preset: String(preset).slice(0, 32) });
}
export function trackBuildStageChange(stage) {
  track("build_stage_change", { stage: String(stage).slice(0, 32) });
}
export function trackBuildAction(action) {
  // action ∈ { reset_match, resim, reset, randomize, copy_json, submit, knob_edit }
  track("build_action", { action: String(action).slice(0, 32) });
}
export function trackProfileSignIn(provider, ok) {
  track("profile_sign_in", { provider: String(provider).slice(0, 16), ok: !!ok });
}
export function trackProfileHandleClaim(ok) {
  track("profile_handle_claim", { ok: !!ok });
}
export function trackProfileSubmitConfig(ok) {
  track("profile_submit_config", { ok: !!ok });
}
